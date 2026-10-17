import { MODULE_ID, TEMPLATE_PATH } from '../constants.js';
import { getAbcIndex, heritagesFor, loadDocument } from '../data/abcIndex.js';
import {
  ATTRIBUTES,
  DEITY_CLASSES,
  ancestryBoostSlots,
  ancestryFlaws,
  applyBuild,
  backgroundBoostSlots,
  backgroundSkillChoice,
  boostProblems,
  buildPreview,
  buildSources,
  canPick,
  createBuildState,
  featSlotsFor,
  languageChoices,
  openSlotCount,
  skillChoices
} from '../data/builder.js';
import { getFeatIndex } from '../data/featIndex.js';
import { getSpellIndex } from '../data/spellIndex.js';
import {
  TRADITIONS,
  classRules,
  extraEntryName,
  extraEntrySlotsAt,
  loadSpellcastingData,
  slotsAt,
  spellPicks
} from '../data/spellcasting.js';
import {
  bindSpellSearch,
  captureSpellScroll,
  restoreSpellScroll,
  spellPickerView,
  toggleSpell,
  trimSpellSelection
} from './spellPickerView.js';
import {
  buildIndexLookups,
  getCandidatesForSlot,
  getDedications,
  getOwnedFeatKeys,
  loadGrantedArchetypeFeats
} from '../data/featSlots.js';
import { getLanguageOptions } from '../data/plan.js';
import {
  applyPendingChoices,
  buildPrereqContext,
  evaluatePrerequisites
} from '../helpers/prerequisites.js';
import { attributeLabel, enrichHTML, localize, signedNumber, sluggify } from '../helpers/utility.js';
import { FeatSelector } from './FeatSelector.js';
import { withTraitRequirements } from './wizardView.js';
import { LightThemeMixin } from './lightTheme.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export const BUILDER_STEPS = [
  'ancestry',
  'heritage',
  'background',
  'class',
  'boosts',
  'skills',
  'feats',
  'spells',
  'languages',
  'review'
];

const RARITIES = ['common', 'uncommon', 'rare', 'unique'];

const hiddenRarities = () => {
  const setting = game.settings.get(MODULE_ID, 'hidden-rarities');
  if (setting === 'uncommon') return ['uncommon', 'rare', 'unique'];
  if (setting === 'rare') return ['rare', 'unique'];
  return [];
};

/**
 * Step-by-step creation of a level-1 character. The character is previewed in memory after every
 * choice (the system prepares it like the real actor), and nothing is written until "Create".
 */
export class CharacterBuilder extends LightThemeMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  constructor(options = {}) {
    const { actor, ...rest } = options;
    super({ ...rest, id: `${MODULE_ID}-builder-${actor.uuid.replace(/\./g, '-')}` });
    this.actor = actor;
    this.build = createBuildState(actor);
    this.step = this.build.class ? 'boosts' : 'ancestry';
    this.filters = { search: {}, rarities: ['common'], spellSearch: {} };
    this.descriptions = new Map();
    this.view = null;
    this.busy = false;
  }

  static DEFAULT_OPTIONS = {
    classes: [MODULE_ID, 'lvlup-builder'],
    window: { icon: 'fa-solid fa-star', resizable: true },
    position: { width: 1180, height: 820 },
    actions: {
      goto: CharacterBuilder.#onGoto,
      next: CharacterBuilder.#onNext,
      back: CharacterBuilder.#onBack,
      pick: CharacterBuilder.#onPick,
      toggleRarity: CharacterBuilder.#onToggleRarity,
      ancestryMode: CharacterBuilder.#onAncestryMode,
      boost: CharacterBuilder.#onBoost,
      skill: CharacterBuilder.#onSkill,
      backgroundSkill: CharacterBuilder.#onBackgroundSkill,
      language: CharacterBuilder.#onLanguage,
      openFeatSelector: CharacterBuilder.#onOpenFeatSelector,
      toggleSpell: CharacterBuilder.#onToggleSpell,
      clearFeat: CharacterBuilder.#onClearFeat,
      apply: CharacterBuilder.#onApply,
      cancel: CharacterBuilder.#onCancel
    }
  };

  static PARTS = {
    nav: { template: `${TEMPLATE_PATH}/builder-nav.hbs` },
    body: { template: `${TEMPLATE_PATH}/builder-body.hbs`, scrollable: ['.lvlb-main'] },
    footer: { template: `${TEMPLATE_PATH}/builder-footer.hbs` }
  };

  get title() {
    return localize('builder.windowTitle', { actorName: this.build.name || this.actor.name });
  }

  /* -------------------------------------------- */
  /*  Data                                        */
  /* -------------------------------------------- */

  async #load() {
    if (this.data) return this.data;
    const [abc, feats, , , spells] = await Promise.all([
      getAbcIndex(),
      getFeatIndex(),
      loadGrantedArchetypeFeats(),
      loadSpellcastingData(),
      getSpellIndex()
    ]);
    this.data = {
      abc,
      feats,
      spells,
      lookups: buildIndexLookups(feats),
      languages: getLanguageOptions(this.actor),
      knownNames: [
        ...new Set(
          feats.flatMap((e) =>
            [e.name, e.originalName, e.slug].filter(Boolean).map((n) => n.toLowerCase())
          )
        )
      ]
    };
    return this.data;
  }

  /** Rebuild the preview after every choice; trims choices that no longer fit */
  async #refresh() {
    const sources = await buildSources(this.build);
    const preview = buildPreview(this.actor, this.build, sources);

    const skills = skillChoices(preview, sources, this.build);
    if (this.build.skills.length > skills.count) {
      this.build.skills = this.build.skills.slice(0, skills.count);
    }
    const languages = languageChoices(preview, sources, this.build, this.data.languages);
    if (this.build.languages.length > languages.total) {
      this.build.languages = this.build.languages.slice(0, languages.total);
    }

    const slots = featSlotsFor(preview, sources);
    for (const key of Object.keys(this.build.feats)) {
      if (!slots.some((s) => s.key === key)) delete this.build.feats[key];
    }

    let prereq = null;
    try {
      prereq = buildPrereqContext(preview);
      prereq.knownNames = this.data.knownNames;
    } catch (error) {
      console.warn(`${MODULE_ID} | Prerequisite context failed`, error);
    }

    // Spellcasting for caster classes the module can automate
    const classSlug = sources.class
      ? (sources.class.system.slug || sluggify(sources.class.name))
      : null;
    const rules = classSlug ? classRules(classSlug) : null;
    let spells = null;
    if (rules) {
      const tradition = rules.tradition ?? this.build.spellTradition;
      const picks = spellPicks(rules, null, 0, 1);
      this.build.spells = trimSpellSelection(this.build.spells, picks);
      spells = { rules, slug: classSlug, tradition, picks };
    } else {
      this.build.spells = {};
    }

    this.view = { sources, preview, skills, languages, slots, prereq, spells };
    return this.view;
  }

  /* FeatSelector host interface: id, actor, selection.feats, selectFeat, evaluateFeat */

  get selection() {
    return { feats: this.build.feats };
  }

  selectFeat(slotKey, pick) {
    const slot = this.view?.slots.find((s) => s.key === slotKey);
    if (!slot) return;
    this.build.feats[slotKey] = { ...pick, slot };
    this.render();
  }

  evaluateFeat(entry, ctx) {
    return withTraitRequirements(evaluatePrerequisites(entry.prerequisites, ctx), entry, ctx);
  }

  #prereqContext(excludeSlot) {
    const base = this.view?.prereq;
    if (!base) return null;
    const feats = Object.entries(this.build.feats)
      .filter(([key, pick]) => pick && key !== excludeSlot)
      .flatMap(([, f]) => [f.name, f.originalName, f.slug].filter(Boolean));
    try {
      return applyPendingChoices(base, { feats });
    } catch {
      return base;
    }
  }

  /* -------------------------------------------- */
  /*  Steps                                       */
  /* -------------------------------------------- */

  /** Steps for this build: Spells only for caster classes the module automates */
  #steps() {
    return BUILDER_STEPS.filter((st) => st !== 'spells' || !!this.view?.spells);
  }

  #isComplete(step) {
    const s = this.build;
    const v = this.view;
    switch (step) {
      case 'ancestry':
        return !!s.ancestry;
      case 'heritage':
        return !!s.heritage;
      case 'background':
        return !!s.background;
      case 'class':
        return !!s.class;
      case 'boosts':
        return !!v && !!s.ancestry && !!s.background && !!s.class && boostProblems(s, v.sources).length === 0;
      case 'skills': {
        const needsBackgroundSkill = !!backgroundSkillChoice(v?.sources.background);
        return (
          !!v &&
          !!s.class &&
          s.skills.length === v.skills.count &&
          (!needsBackgroundSkill || !!s.backgroundSkill)
        );
      }
      // Nothing to choose yet is not the same as done: these depend on earlier picks
      case 'feats':
        return !!v && !!s.ancestry && !!s.class && v.slots.every((slot) => s.feats[slot.key]);
      case 'languages': {
        const deityOk = !DEITY_CLASSES.includes(v?.sources.class?.system.slug) || !!s.deity;
        return !!v && !!s.ancestry && !!s.class && deityOk;
      }
      case 'spells': {
        const sp = v?.spells;
        if (!sp) return true;
        return !!sp.tradition && sp.picks.every((p) => (s.spells[p.key]?.length ?? 0) === p.count);
      }
      case 'review':
        return this.#steps().slice(0, -1).every((st) => this.#isComplete(st));
    }
    return false;
  }

  #missing() {
    return this.#steps()
      .slice(0, -1)
      .filter((st) => !this.#isComplete(st))
      .map((st) => localize(`builder.steps.${st}`));
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    await this.#load();
    await this.#refresh();
    const { preview, sources } = this.view;
    const index = this.step;

    const steps = this.#steps();
    if (!steps.includes(this.step)) this.step = steps[steps.indexOf('feats') + 1] ?? 'review';
    const nav = steps.map((id, i) => ({
      id,
      number: i + 1,
      label: localize(`builder.steps.${id}`),
      current: id === this.step,
      complete: id !== 'review' && this.#isComplete(id)
    }));

    const size = preview.size ?? preview.system.traits?.size?.value;
    const summary = {
      img: this.actor.img,
      name: this.build.name,
      picks: ['ancestry', 'heritage', 'background', 'class'].map((type) => ({
        label: localize(`builder.steps.${type}`),
        value: sources[type]?.name ?? null
      })),
      attributes: ATTRIBUTES.map((a) => {
        const mod = preview.system.abilities?.[a]?.mod ?? 0;
        return { key: a, short: a.toUpperCase(), mod: signedNumber(mod), raised: mod > 0, lowered: mod < 0 };
      }),
      hp: preview.hitPoints?.max ?? preview.system.attributes?.hp?.max ?? 0,
      size: size ? game.i18n.localize(CONFIG.PF2E.actorSizes?.[size] ?? size) : '—',
      speed: preview.system.movement?.speeds?.land?.value ?? preview.system.attributes?.speed?.value ?? null,
      languages: (preview.system.details?.languages?.value ?? [])
        .map((l) => game.i18n.localize(CONFIG.PF2E.languages?.[l] ?? l))
        .join(', ')
    };

    return Object.assign(context, {
      appId: this.id,
      step: index,
      stepNumber: steps.indexOf(index) + 1,
      stepCount: steps.length,
      nav,
      summary,
      isFirst: index === steps[0],
      isReview: index === 'review',
      canApply: this.#isComplete('review') && !this.busy,
      busy: this.busy,
      missing: this.#missing(),
      nextLabel:
        index === 'review'
          ? null
          : localize('builder.next', {
              step: localize(`builder.steps.${steps[steps.indexOf(index) + 1]}`)
            }),
      ...(await this.#stepContext(index))
    });
  }

  #cards(type, list, selectedUuid, describe) {
    const hidden = hiddenRarities();
    const search = (this.filters.search[type] ?? '').toLocaleLowerCase();
    return list
      .filter((e) => !hidden.includes(e.rarity))
      .filter((e) => e.uuid === selectedUuid || this.filters.rarities.includes(e.rarity))
      .map((e) => ({
        uuid: e.uuid,
        kind: type,
        name: e.name,
        img: e.img,
        rarity: e.rarity,
        rarityLabel:
          e.rarity === 'common'
            ? null
            : game.i18n.localize(CONFIG.PF2E.rarityTraits?.[e.rarity] ?? e.rarity),
        selected: e.uuid === selectedUuid,
        hidden: !!search && !e.searchText.includes(search),
        search: e.searchText,
        ...describe(e)
      }));
  }

  async #selectedDetail(uuid) {
    if (!uuid) return null;
    if (!this.descriptions.has(uuid)) {
      const doc = await loadDocument(uuid);
      const html = doc
        ? await enrichHTML(foundry.utils.cleanHTML(doc.system?.description?.value ?? ''), {
            relativeTo: doc
          })
        : '';
      this.descriptions.set(uuid, { name: doc?.name ?? '', img: doc?.img, html });
    }
    return this.descriptions.get(uuid);
  }

  #rarityChips() {
    const hidden = hiddenRarities();
    return RARITIES.filter((r) => !hidden.includes(r)).map((r) => ({
      key: r,
      label: game.i18n.localize(CONFIG.PF2E.rarityTraits?.[r] ?? r),
      on: this.filters.rarities.includes(r)
    }));
  }

  async #stepContext(step) {
    const { abc } = this.data;
    const { sources, preview, skills, languages, slots } = this.view;
    const s = this.build;
    const sizeLabel = (size) => game.i18n.localize(CONFIG.PF2E.actorSizes?.[size] ?? size);
    const boostText = (boosts) => {
      const fixed = Object.values(boosts ?? {})
        .filter((b) => b.value?.length === 1)
        .map((b) => attributeLabel(b.value[0]));
      const limited = Object.values(boosts ?? {})
        .filter((b) => b.value?.length > 1 && b.value.length < ATTRIBUTES.length)
        .map((b) => b.value.map(attributeLabel).join(localize('builder.or')));
      const free = Object.values(boosts ?? {}).filter((b) => b.value?.length === ATTRIBUTES.length).length;
      return [...fixed, ...limited, ...(free ? [localize('builder.freeBoosts', { count: free })] : [])].join(', ');
    };

    switch (step) {
      case 'ancestry':
        return {
          heading: localize('builder.ancestry.heading'),
          hint: localize('builder.ancestry.hint'),
          rarities: this.#rarityChips(),
          cardStep: true,
          searchKind: 'ancestry',
          search: this.filters.search.ancestry ?? '',
          detail: await this.#selectedDetail(s.ancestry),
          cards: this.#cards('ancestry', abc.ancestry, s.ancestry, (e) => {
            const flaws = Object.values(e.system.flaws ?? {})
              .filter((f) => f.value?.length === 1)
              .map((f) => attributeLabel(f.value[0]));
            return {
              line: localize('builder.ancestry.stats', {
                hp: e.system.hp ?? 0,
                size: sizeLabel(e.system.size),
                speed: e.system.speed ?? 0
              }),
              sub: [
                boostText(e.system.boosts),
                flaws.length ? localize('builder.ancestry.flaw', { flaws: flaws.join(', ') }) : null
              ]
                .filter(Boolean)
                .join(' · ')
            };
          })
        };

      case 'heritage': {
        const ancestry = abc.ancestry.find((a) => a.uuid === s.ancestry);
        return {
          heading: localize('builder.heritage.heading'),
          hint: ancestry
            ? localize('builder.heritage.hint', { ancestry: ancestry.name })
            : localize('builder.needAncestry'),
          rarities: this.#rarityChips(),
          cardStep: true,
          searchKind: 'heritage',
          search: this.filters.search.heritage ?? '',
          detail: await this.#selectedDetail(s.heritage),
          cards: this.#cards('heritage', heritagesFor(abc, ancestry), s.heritage, (e) => ({
            line: e.system.ancestry ? e.system.ancestry.name : localize('builder.heritage.versatile'),
            sub: null,
            versatile: !e.system.ancestry
          }))
        };
      }

      case 'background':
        return {
          heading: localize('builder.background.heading'),
          hint: localize('builder.background.hint'),
          rarities: this.#rarityChips(),
          cardStep: true,
          searchKind: 'background',
          search: this.filters.search.background ?? '',
          detail: await this.#selectedDetail(s.background),
          cards: this.#cards('background', abc.background, s.background, (e) => {
            const trained = [
              ...(e.system.trainedSkills?.value ?? []).map((sk) =>
                game.i18n.localize(CONFIG.PF2E.skills?.[sk]?.label ?? sk)
              ),
              ...(e.system.trainedSkills?.lore ?? [])
            ];
            return {
              line: boostText(e.system.boosts),
              sub: trained.length ? localize('builder.background.trains', { skills: trained.join(', ') }) : null
            };
          })
        };

      case 'class':
        return {
          heading: localize('builder.class.heading'),
          hint: localize('builder.class.hint'),
          rarities: this.#rarityChips(),
          cardStep: true,
          searchKind: 'class',
          search: this.filters.search.class ?? '',
          detail: await this.#selectedDetail(s.class),
          cards: this.#cards('class', abc.class, s.class, (e) => ({
            line: localize('builder.class.stats', {
              hp: e.system.hp ?? 0,
              key: (e.system.keyAbility?.value ?? []).map(attributeLabel).join(localize('builder.or'))
            }),
            sub: (e.system.spellcasting ?? 0) > 0 ? localize('builder.class.caster') : null
          }))
        };

      case 'boosts':
        return this.#boostContext(sources, preview);

      case 'skills': {
        const choice = backgroundSkillChoice(sources.background);
        return {
          backgroundChoice: choice
            ? {
                name: sources.background.name,
                chosen: !!s.backgroundSkill,
                options: choice.options.map((slug) => ({
                  slug,
                  label: game.i18n.localize(CONFIG.PF2E.skills?.[slug]?.label ?? slug),
                  selected: slug === s.backgroundSkill
                }))
              }
            : null,
          heading: localize('builder.skills.heading'),
          hint: localize('builder.skills.hint', {
            count: skills.count,
            cls: skills.additional,
            int: skills.intBonus
          }),
          overlapNote: skills.overlap ? localize('builder.skills.overlap', { count: skills.overlap }) : null,
          skillCount: skills.count,
          skillChosen: s.skills.length,
          skillGrid: skills.skills.map((sk) => ({
            ...sk,
            rankClass: `rank-${sk.rank}`,
            fromLabel: sk.from ? localize(`builder.skills.from.${sk.from}`) : null,
            disabled: sk.locked || (!sk.chosen && s.skills.length >= skills.count)
          })),
          backgroundNote: choice ? null : localize('builder.skills.backgroundNote')
        };
      }

      case 'feats':
        return {
          heading: localize('builder.feats.heading'),
          hint: localize('builder.feats.hint'),
          featSlots: slots.map((slot) => ({
            ...slot,
            pick: s.feats[slot.key] ?? null,
            groupClass: `group-${['ancestry', 'class', 'archetype', 'skill', 'general', 'mythic'].includes(slot.groupId) ? slot.groupId : 'other'}`
          })),
          noFeatSlots: slots.length === 0
        };

      case 'spells':
        return this.#spellContext();

      case 'languages': {
        const classSlug = sources.class?.system.slug;
        const deities = abc.deity
          .filter((d) => !hiddenRarities().includes(d.rarity))
          .map((d) => ({ uuid: d.uuid, name: d.name, selected: d.uuid === s.deity }));
        return {
          languageStep: true,
          heading: localize('builder.languages.heading'),
          hint: localize('builder.languages.hint', { count: languages.total }),
          granted: languages.granted,
          languageTotal: languages.total,
          languageChosen: s.languages.length,
          languageOptions: languages.options.map((l) => ({
            ...l,
            disabled: !l.chosen && s.languages.length >= languages.total,
            rarityLabel:
              l.rarity === 'common' ? null : game.i18n.localize(CONFIG.PF2E.rarityTraits?.[l.rarity] ?? l.rarity)
          })),
          deityRequired: DEITY_CLASSES.includes(classSlug),
          deities,
          deityNone: !s.deity
        };
      }

      case 'review':
        return this.#reviewContext(sources, preview);
    }
    return {};
  }

  #boostContext(sources, preview) {
    const s = this.build;
    const rows = [];
    const cell = (attr, kind, extra = {}) => ({ attr, kind, label: attributeLabel(attr), ...extra });

    if (sources.ancestry) {
      const flaws = ancestryFlaws(sources.ancestry);
      const alternate = s.ancestryMode === 'alternate';
      const slots = ancestryBoostSlots(sources.ancestry, s);
      const fixed = alternate ? [] : slots.filter((x) => x.fixed).map((x) => x.selected);
      const open = alternate ? 2 : openSlotCount(sources.ancestry.system.boosts);
      const picks = alternate ? s.alternateBoosts : s.ancestryPicks;
      rows.push({
        id: 'ancestry',
        label: localize('builder.boosts.rows.ancestry', { name: sources.ancestry.name }),
        rule: alternate
          ? localize('builder.boosts.alternateRule')
          : localize('builder.boosts.ancestryRule', {
              fixed: fixed.map(attributeLabel).join(', ') || '—',
              count: open
            }),
        modeToggle: alternate ? localize('builder.boosts.useStandard') : localize('builder.boosts.useAlternate'),
        left: open - picks.length,
        cells: ATTRIBUTES.map((a) => {
          const flaw = !alternate && flaws.includes(a);
          if (fixed.includes(a)) return cell(a, 'fixed', { flaw });
          if (picks.includes(a)) return cell(a, 'picked', { flaw });
          const allowed = alternate
            ? picks.length < 2
            : canPick(sources.ancestry.system.boosts, picks, a);
          return cell(a, allowed ? 'open' : 'blocked', { flaw });
        })
      });
    }

    if (sources.background) {
      const boosts = sources.background.system.boosts;
      const slots = backgroundBoostSlots(sources.background, s);
      const fixed = slots.filter((x) => x.fixed).map((x) => x.selected);
      const open = openSlotCount(boosts);
      rows.push({
        id: 'background',
        label: localize('builder.boosts.rows.background', { name: sources.background.name }),
        rule: slots
          .filter((x) => !x.fixed)
          .map((x) => (x.free ? localize('builder.freeBoosts', { count: 1 }) : x.options.map(attributeLabel).join(localize('builder.or'))))
          .join(', '),
        left: open - s.backgroundPicks.length,
        cells: ATTRIBUTES.map((a) => {
          if (fixed.includes(a)) return cell(a, 'fixed');
          if (s.backgroundPicks.includes(a)) return cell(a, 'picked');
          return cell(a, canPick(boosts, s.backgroundPicks, a) ? 'open' : 'blocked');
        })
      });
    }

    if (sources.class) {
      const options = sources.class.system.keyAbility?.value ?? [];
      const selected = sources.class.system.keyAbility?.selected;
      rows.push({
        id: 'class',
        label: localize('builder.boosts.rows.class', { name: sources.class.name }),
        rule: localize('builder.boosts.keyRule', { options: options.map(attributeLabel).join(localize('builder.or')) }),
        left: selected ? 0 : 1,
        cells: ATTRIBUTES.map((a) => {
          if (!options.includes(a)) return cell(a, 'none');
          if (options.length === 1) return cell(a, 'key');
          return cell(a, a === selected ? 'keyPicked' : 'open');
        })
      });
    }

    rows.push({
      id: 'level1',
      label: localize('builder.boosts.rows.level1'),
      rule: localize('builder.boosts.level1Rule'),
      left: 4 - s.level1.length,
      cells: ATTRIBUTES.map((a) =>
        cell(a, s.level1.includes(a) ? 'picked' : s.level1.length < 4 ? 'open' : 'blocked')
      )
    });

    const mods = ATTRIBUTES.map((a) => ({
      attr: a,
      value: signedNumber(preview.system.abilities?.[a]?.mod ?? 0)
    }));
    const keyAttr = sources.class?.system.keyAbility?.selected;
    return {
      heading: localize('builder.boosts.heading'),
      hint: localize('builder.boosts.hint'),
      attributeHeaders: ATTRIBUTES.map((a) => ({ attr: a, short: a.toUpperCase() })),
      boostRows: rows.map((r) => ({
        ...r,
        done: r.left === 0,
        cells: r.cells.map((c) => ({
          ...c,
          button: ['open', 'picked', 'keyPicked', 'blocked'].includes(c.kind),
          pressed: ['picked', 'keyPicked'].includes(c.kind),
          disabled: c.kind === 'blocked'
        }))
      })),
      totals: mods,
      boostsDone: boostProblems(s, sources).length === 0 && !!sources.ancestry && !!sources.background && !!sources.class,
      keyNote: keyAttr
        ? localize('builder.boosts.keyNote', {
            attribute: attributeLabel(keyAttr),
            mod: signedNumber(preview.system.abilities?.[keyAttr]?.mod ?? 0)
          })
        : null
    };
  }

  #spellContext() {
    const sp = this.view.spells;
    if (!sp) return { spellStep: true, heading: localize('builder.spells.heading') };
    const chips = (slots, prefix = '') =>
      Object.entries(slots ?? {})
        .filter(([, n]) => n > 0)
        .map(([rank, n]) => ({
          label: prefix + (Number(rank) === 0 ? localize('spells.cantrips') : localize('spells.rank', { rank })),
          count: n
        }));
    // Divine font slots live in their own entry, so they get chips of their own
    const slotChips = [
      ...chips(slotsAt(sp.rules, 1)),
      ...chips(extraEntrySlotsAt(sp.rules, 1), `${extraEntryName(sp.rules)} · `)
    ];
    const known = new Set();
    return {
      spellStep: true,
      heading: localize('builder.spells.heading'),
      hint: localize(`builder.spells.hint.${sp.picks.length ? sp.rules.preparation : 'fullList'}`, {
        className: this.view.sources.class.name
      }),
      traditionChoice: sp.rules.tradition
        ? null
        : {
            source: sp.rules.traditionSource ?? 'other',
            hint: localize('builder.spells.traditionHint', { className: this.view.sources.class.name }),
            options: TRADITIONS.map((t) => ({
              value: t,
              label: game.i18n.localize(CONFIG.PF2E.magicTraditions?.[t] ?? t),
              selected: t === sp.tradition
            }))
          },
      slotChips,
      slotNote: localize('builder.spells.slotNote'),
      preparedNote: sp.picks.length === 0 ? localize('builder.spells.preparedNote') : null,
      needTradition: !sp.tradition,
      spellGroups: sp.tradition
        ? spellPickerView({
            picks: sp.picks,
            index: this.data.spells,
            selection: this.build.spells,
            tradition: sp.tradition,
            known,
            hiddenRarities: hiddenRarities(),
            search: this.filters.spellSearch
          })
        : []
    };
  }

  #reviewContext(sources, preview) {
    const s = this.build;
    const rows = [
      { label: localize('builder.review.name'), value: s.name || this.actor.name },
      ...['ancestry', 'heritage', 'background', 'class', 'deity']
        .filter((t) => sources[t])
        .map((t) => ({ label: localize(`builder.steps.${t === 'deity' ? 'deity' : t}`), value: sources[t].name })),
      {
        label: localize('builder.review.attributes'),
        value: ATTRIBUTES.map(
          (a) => `${attributeLabel(a)} ${signedNumber(preview.system.abilities?.[a]?.mod ?? 0)}`
        ).join(' · ')
      },
      { label: localize('builder.review.hp'), value: String(preview.hitPoints?.max ?? 0) },
      {
        label: localize('builder.review.skills'),
        value: Object.entries(preview.skills ?? {})
          .filter(([, st]) => (st.rank ?? 0) > 0)
          .map(([, st]) => st.label)
          .join(', ')
      },
      {
        label: localize('builder.review.feats'),
        value: Object.values(s.feats).map((f) => f.name).join(', ') || '—'
      },
      ...(this.view.spells?.tradition
        ? [
            {
              label: localize('builder.review.spells'),
              value:
                Object.values(this.build.spells)
                  .flat()
                  .map((uuid) => this.data.spells.find((x) => x.uuid === uuid)?.name)
                  .filter(Boolean)
                  .join(', ') || localize('builder.review.spellsPrepared')
            }
          ]
        : []),
      {
        label: localize('builder.review.languages'),
        value: (preview.system.details?.languages?.value ?? [])
          .map((l) => game.i18n.localize(CONFIG.PF2E.languages?.[l] ?? l))
          .join(', ')
      }
    ];
    return {
      heading: localize('builder.review.heading'),
      hint: localize('builder.review.hint'),
      reviewRows: rows,
      replaces: ['ancestry', 'heritage', 'background', 'class', 'deity']
        .filter((t) => sources[t] && this.actor.itemTypes?.[t]?.length && this.actor.itemTypes[t][0].sourceId !== s[t])
        .map((t) => this.actor.itemTypes[t][0].name),
      levelNote: this.actor.level > 1 ? localize('builder.review.levelNote', { level: this.actor.level }) : null
    };
  }

  async _preRender(context, options) {
    await super._preRender(context, options);
    this.spellScroll = captureSpellScroll(this.element);
  }

  _attachPartListeners(partId, htmlElement, options) {
    super._attachPartListeners(partId, htmlElement, options);
    if (partId !== 'body') return;
    restoreSpellScroll(htmlElement, this.spellScroll);
    const search = htmlElement.querySelector('[data-builder-search]');
    search?.addEventListener('input', (event) => {
      const kind = event.currentTarget.dataset.builderSearch;
      const term = event.currentTarget.value;
      this.filters.search[kind] = term;
      const needle = term.trim().toLocaleLowerCase();
      htmlElement.querySelectorAll('.lvlb-card[data-search]').forEach((card) => {
        card.hidden = !!needle && !card.dataset.search.includes(needle);
      });
    });
    htmlElement.querySelector('[data-builder-name]')?.addEventListener('change', (event) => {
      this.build.name = event.currentTarget.value.trim();
      this.render({ parts: ['body'] });
    });
    bindSpellSearch(htmlElement, this.filters.spellSearch);
    htmlElement.querySelector('[data-spell-tradition]')?.addEventListener('change', (event) => {
      this.build.spellTradition = event.currentTarget.value || null;
      this.build.spells = {};
      this.render();
    });
    htmlElement.querySelector('[data-builder-deity]')?.addEventListener('change', (event) => {
      this.build.deity = event.currentTarget.value || null;
      this.render();
    });
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  #go(step) {
    if (!this.#steps().includes(step)) return;
    this.step = step;
    this.render();
  }

  static #onGoto(event, target) {
    this.#go(target.dataset.step);
  }

  static #onNext() {
    const steps = this.#steps();
    this.#go(steps[steps.indexOf(this.step) + 1]);
  }

  static #onBack() {
    const steps = this.#steps();
    this.#go(steps[steps.indexOf(this.step) - 1]);
  }

  static #onPick(event, target) {
    const { kind, uuid } = target.dataset;
    const s = this.build;
    if (s[kind] === uuid) return;
    s[kind] = uuid;
    // Later choices that depended on this one start over
    if (kind === 'ancestry') {
      s.heritage = null;
      s.ancestryMode = 'standard';
      s.ancestryPicks = [];
      s.alternateBoosts = [];
      s.languages = [];
      s.feats = {};
    } else if (kind === 'background') {
      s.backgroundPicks = [];
      s.backgroundSkill = null;
      s.skills = [];
    } else if (kind === 'class') {
      s.keyAttribute = null;
      s.skills = [];
      s.feats = {};
      s.spells = {};
      s.spellTradition = null;
    }
    this.render();
  }

  static #onToggleRarity(event, target) {
    const r = target.dataset.rarity;
    const list = this.filters.rarities;
    this.filters.rarities = list.includes(r) ? list.filter((x) => x !== r) : [...list, r];
    this.render({ parts: ['body'] });
  }

  static #onAncestryMode() {
    const s = this.build;
    s.ancestryMode = s.ancestryMode === 'alternate' ? 'standard' : 'alternate';
    s.ancestryPicks = [];
    s.alternateBoosts = [];
    this.render();
  }

  static #onBoost(event, target) {
    const { row, attr } = target.dataset;
    const s = this.build;
    const toggle = (list, max, allowed = true) => {
      if (list.includes(attr)) return list.filter((a) => a !== attr);
      if (list.length >= max || !allowed) return list;
      return [...list, attr];
    };
    const sources = this.view.sources;
    if (row === 'ancestry') {
      if (s.ancestryMode === 'alternate') s.alternateBoosts = toggle(s.alternateBoosts, 2);
      else {
        const boosts = sources.ancestry?.system.boosts;
        s.ancestryPicks = toggle(
          s.ancestryPicks,
          openSlotCount(boosts),
          canPick(boosts, s.ancestryPicks, attr)
        );
      }
    } else if (row === 'background') {
      const boosts = sources.background?.system.boosts;
      s.backgroundPicks = toggle(
        s.backgroundPicks,
        openSlotCount(boosts),
        canPick(boosts, s.backgroundPicks, attr)
      );
    } else if (row === 'class') {
      s.keyAttribute = s.keyAttribute === attr ? null : attr;
    } else if (row === 'level1') {
      s.level1 = toggle(s.level1, 4);
    }
    this.render();
  }

  static #onBackgroundSkill(event, target) {
    const slug = target.dataset.skill;
    const s = this.build;
    s.backgroundSkill = s.backgroundSkill === slug ? null : slug;
    // The background now trains it, so it can't also be one of the extra picks
    s.skills = s.skills.filter((x) => x !== s.backgroundSkill);
    this.render();
  }

  static #onSkill(event, target) {
    const slug = target.dataset.skill;
    const s = this.build;
    if (s.skills.includes(slug)) s.skills = s.skills.filter((x) => x !== slug);
    else if (s.skills.length < (this.view?.skills.count ?? 0)) s.skills = [...s.skills, slug];
    this.render();
  }

  static #onLanguage(event, target) {
    const slug = target.dataset.language;
    const s = this.build;
    if (s.languages.includes(slug)) s.languages = s.languages.filter((x) => x !== slug);
    else if (s.languages.length < (this.view?.languages.total ?? 0)) s.languages = [...s.languages, slug];
    this.render();
  }

  static async #onOpenFeatSelector(event, target) {
    const slot = this.view?.slots.find((x) => x.key === target.dataset.slotKey);
    if (!slot) return;
    const { feats, lookups } = this.data;
    const preview = this.view.preview;
    const pending = Object.entries(this.build.feats)
      .filter(([key, pick]) => pick && key !== slot.key)
      .map(([, pick]) => pick);
    const ownedKeys = getOwnedFeatKeys(preview);
    for (const pick of pending) {
      for (const id of [pick.uuid, pick.slug]) ownedKeys.set(id, (ownedKeys.get(id) ?? 0) + 1);
    }
    const candidates = getCandidatesForSlot(slot, feats, {
      ownedKeys,
      dedications: getDedications(preview),
      ...lookups
    });
    await foundry.applications.instances.get(`${this.id}-feats`)?.close();
    const selector = new FeatSelector({
      wizard: this,
      slot,
      candidates,
      prereqContext: this.#prereqContext(slot.key),
      currentPick: this.build.feats[slot.key] ?? null,
      featIndex: this.data.feats
    });
    if (typeof this.renderChild === 'function') await this.renderChild(selector);
    else await selector.render({ force: true });
  }

  static #onToggleSpell(event, target) {
    const picks = this.view?.spells?.picks ?? [];
    this.build.spells = toggleSpell(this.build.spells, picks, target.dataset.pick, target.dataset.uuid);
    this.render({ parts: ['body', 'nav', 'footer'] });
  }

  static #onClearFeat(event, target) {
    delete this.build.feats[target.dataset.slotKey];
    this.render();
  }

  static async #onApply() {
    if (this.busy || !this.#isComplete('review')) return;
    this.busy = true;
    await this.render({ parts: ['footer'] });
    try {
      const picks = Object.fromEntries(
        Object.entries(this.build.feats).filter(([, pick]) => pick)
      );
      const sp = this.view?.spells;
      const spellPlan = sp
        ? {
            rules: sp.rules,
            slug: sp.slug,
            tradition: sp.tradition,
            className: this.view.sources.class?.name,
            attribute: this.view.sources.class?.system.keyAbility?.selected,
            selection: this.build.spells,
            spellIndex: this.data?.spells ?? []
          }
        : null;
      const done = await applyBuild(this.actor, this.build, picks, spellPlan);
      if (done) {
        await this.close();
        this.actor.sheet?.render(true);
        return;
      }
    } finally {
      this.busy = false;
      if (this.rendered) await this.render();
    }
  }

  static #onCancel() {
    this.close();
  }
}

const opening = new Map();

/** Open (or focus) the builder for an actor */
export const openCharacterBuilder = (actor) => {
  const id = `${MODULE_ID}-builder-${actor.uuid.replace(/\./g, '-')}`;
  const existing = foundry.applications.instances.get(id) ?? opening.get(id);
  if (existing) {
    if (existing.rendered) existing.bringToFront();
    return existing;
  }
  const app = new CharacterBuilder({ actor });
  opening.set(id, app);
  app
    .render({ force: true })
    .catch((error) => {
      console.error(`${MODULE_ID} | Failed to open the builder`, error);
      ui.notifications.error(localize('notifications.openFailed'));
    })
    .finally(() => opening.delete(id));
  return app;
};
