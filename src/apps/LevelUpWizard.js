import { MODULE_ID, TEMPLATE_PATH } from '../constants.js';
import {
  buildIndexLookups,
  createPreviewActor,
  getCandidatesForSlot,
  getDedicationProgress,
  getDedications,
  getFeatSlots,
  getOwnedFeatKeys,
  loadGrantedArchetypeFeats
} from '../data/featSlots.js';
import { getFeatIndex } from '../data/featIndex.js';
import { getSpellIndex } from '../data/spellIndex.js';
import {
  TRADITIONS,
  classRules,
  currentSignatures,
  detectTradition,
  findClassEntry,
  loadSpellcastingData,
  signatureAt,
  slotChanges,
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
  SPELL_HINT_PATTERN,
  describeBoosts,
  describeSkillOption,
  getBoostSets,
  getClassFeatures,
  getClassJournals,
  getLanguageOptions,
  getOpenLanguageSlots,
  getSkillIncreaseCount,
  getSkillOptions,
  getSkillPotency,
  getSpellcastingReminders,
  maxSkillRankForLevel,
  xpInfo
} from '../data/plan.js';
import { applyLevelUp, canUndo, getHistory, undoLastLevelUp } from '../data/apply.js';
import {
  applyPendingChoices,
  buildPrereqContext,
  evaluatePrerequisites
} from '../helpers/prerequisites.js';
import {
  attributeLabel,
  escapeHTML,
  localize,
  rankLabel,
  signedNumber,
  sluggify
} from '../helpers/utility.js';
import { FeatSelector, hiddenRarities } from './FeatSelector.js';
import { LevelUpHistory } from './LevelUpHistory.js';
import {
  chooseLayout,
  formatNumber,
  glyphView,
  groupType,
  joinList,
  languageChips,
  mergeSkillChanges,
  prereqPill,
  prereqTooltip,
  rankDots,
  withTraitRequirements
} from './wizardView.js';
import { LightThemeMixin } from './lightTheme.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const PARTIALS = ['rail', 'review', 'skill-grid'].map(
  (name) => `${TEMPLATE_PATH}/partials/wizard-${name}.hbs`
);

const POTENCY_KEYS = ['newBoost', 'upgradeTo2', 'upgradeTo3'];
const POTENCY_VALUES = { newBoost: 1, upgradeTo2: 2, upgradeTo3: 3 };

export class LevelUpWizard extends LightThemeMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  /**
   * @param {object} options
   * @param {Actor} options.actor
   * @param {boolean} [options.levelAlreadyApplied] the actor's level was already raised (manual edit)
   * @param {number} [options.previousLevel] level before a manual edit
   */
  constructor(options = {}) {
    const { actor } = options;
    super({
      ...options,
      id: `${MODULE_ID}-${actor.uuid.replace(/\./g, '-')}`
    });
    this.actor = actor;
    this.levelAlreadyApplied = !!options.levelAlreadyApplied;
    this.targetLevel = this.levelAlreadyApplied ? actor.level : actor.level + 1;
    this.previousLevel = this.levelAlreadyApplied
      ? Math.min(options.previousLevel ?? actor.level - 1, actor.level - 1)
      : actor.level;
    this.plan = null;
    this.selection = {
      feats: {},
      skillIncreases: [],
      intSkills: [],
      languages: [],
      boosts: {},
      potency: {},
      spells: {},
      spellTradition: null,
      spellSetup: false,
      signature: null
    };
    this.spellSearch = {};
    this.showMissed = false;
    this.showAllLanguages = false;
    this.submitting = false;
    /** Current step: 'choices' (single page), a step key (stepped layout) or 'review' */
    this.step = null;
    this.stepKeys = [];
    this.lastChoiceStep = null;
    this.reviewBlocked = false;
    this.#cache = { fit: new Map(), fitQueued: new Set(), hp: null, spellHints: new Map() };
  }

  /** Derived values that are expensive to compute and only change with the selection */
  #cache;
  #pendingFit = new Set();
  #stepChanged = false;

  static DEFAULT_OPTIONS = {
    classes: [MODULE_ID, 'lvlup-wizard'],
    tag: 'form',
    window: {
      icon: 'fa-solid fa-hat-wizard',
      resizable: true
    },
    position: { width: 960, height: 780 },
    form: {
      handler: LevelUpWizard.#onSubmit,
      submitOnChange: false,
      closeOnSubmit: false
    },
    actions: {
      openFeatSelector: LevelUpWizard.#onOpenFeatSelector,
      clearFeat: LevelUpWizard.#onClearFeat,
      toggleBoost: LevelUpWizard.#onToggleBoost,
      toggleMissed: LevelUpWizard.#onToggleMissed,
      pickSkill: LevelUpWizard.#onPickSkill,
      toggleLanguage: LevelUpWizard.#onToggleLanguage,
      clearLanguages: LevelUpWizard.#onClearLanguages,
      toggleAllLanguages: LevelUpWizard.#onToggleAllLanguages,
      toggleSpell: LevelUpWizard.#onToggleSpell,
      toggleSpellSetup: LevelUpWizard.#onToggleSpellSetup,
      goStep: LevelUpWizard.#onGoStep,
      nextStep: LevelUpWizard.#onNextStep,
      prevStep: LevelUpWizard.#onPrevStep,
      review: LevelUpWizard.#onReview,
      backToChoices: LevelUpWizard.#onBackToChoices,
      openHistory: LevelUpWizard.#onOpenHistory,
      undo: LevelUpWizard.#onUndo
    }
  };

  static PARTS = {
    body: {
      template: `${TEMPLATE_PATH}/level-up-wizard.hbs`,
      templates: PARTIALS,
      scrollable: ['.wizard-main', '.wizard-rail']
    },
    footer: {
      template: `${TEMPLATE_PATH}/level-up-wizard-footer.hbs`
    }
  };

  get title() {
    return localize('menu.windowTitle', {
      actorName: this.actor.name,
      targetLevel: this.targetLevel
    });
  }

  /** The history button sits in the title bar (the controls menu is only for rarely used entries) */
  _getFrameButtons() {
    if (!getHistory(this.actor).length) return [];
    return [
      {
        icon: 'fa-solid fa-clock-rotate-left',
        label: 'DUMB_LEVEL_UP_WIZARD.history.title',
        action: 'openHistory'
      }
    ];
  }

  /* -------------------------------------------- */
  /*  Plan                                        */
  /* -------------------------------------------- */

  /** Everything that depends only on the actor, computed once when the wizard opens */
  async #buildPlan() {
    const actor = this.actor;
    const { previousLevel, targetLevel } = this;
    const preview = createPreviewActor(actor, targetLevel);

    const [index] = await Promise.all([
      getFeatIndex(),
      loadGrantedArchetypeFeats(),
      loadSpellcastingData()
    ]);
    const slots = getFeatSlots(preview, targetLevel, previousLevel);

    const skillOptions = getSkillOptions(actor);
    const { manual: manualAttributes, sets: boostSets } = getBoostSets(actor, preview);

    const [classFeatures, classJournals] = await Promise.all([
      getClassFeatures(preview, previousLevel, targetLevel),
      getClassJournals(actor)
    ]);

    let prereqBase = null;
    try {
      prereqBase = buildPrereqContext(preview);
      // Lets a missing feat or class feature count as unmet rather than unknown
      prereqBase.knownNames = [
        ...new Set(
          index.flatMap((e) =>
            [e.name, e.originalName, e.slug].filter(Boolean).map((n) => n.toLowerCase())
          )
        )
      ];
    } catch (error) {
      console.warn(`${MODULE_ID} | Prerequisite context failed`, error);
    }

    const plan = {
      actor,
      preview,
      previousLevel,
      targetLevel,
      levelAlreadyApplied: this.levelAlreadyApplied,
      index,
      lookups: buildIndexLookups(index),
      ownedKeys: getOwnedFeatKeys(actor),
      slots,
      skillOptions,
      skillIncreaseCount: getSkillIncreaseCount(preview, previousLevel, targetLevel),
      maxSkillRank: maxSkillRankForLevel(targetLevel),
      manualAttributes,
      boostSets,
      languageOptions: getLanguageOptions(actor),
      potency: getSkillPotency(actor, skillOptions, previousLevel, targetLevel),
      spellcasting: getSpellcastingReminders(preview, previousLevel, targetLevel),
      classFeatures,
      classJournals,
      prereqBase,
      xpEnforcement: game.settings.get(MODULE_ID, 'xp-enforcement'),
      languageSlots: 0,
      spells: this.#planSpells(actor, previousLevel, targetLevel)
    };
    if (plan.spells) plan.spellIndex = await getSpellIndex();

    // The layout is decided once from what the level asks for, so it doesn't jump while choosing
    const maxRank = plan.maxSkillRank;
    const potencyLists = plan.potency ? POTENCY_KEYS.map((k) => plan.potency[k]).filter(Boolean) : [];
    plan.layout = chooseLayout({
      feats: slots.current.length,
      optionalFeats: slots.missed.length > 0,
      skillIncreases: plan.skillIncreaseCount,
      skillOptions: skillOptions.filter((s) => s.rank < maxRank).length,
      boostSets: boostSets.length,
      languages: getOpenLanguageSlots(actor, 0),
      potency: potencyLists.length,
      potencyOptions: Math.max(0, ...potencyLists.map((l) => l.length))
    }).layout;
    // Spell lists are long: a level-up with spells to pick always uses steps
    if (plan.spells?.picks.length) plan.layout = 'steps';

    this.selection.skillIncreases = new Array(plan.skillIncreaseCount).fill('');
    for (const { set } of boostSets) this.selection.boosts[set] = [];
    return plan;
  }

  /**
   * Class spellcasting this module can automate: the entry it manages (or an existing one of the class's
   * kind), the slot changes for the new level and the spells to pick. Null for non-casters.
   */
  #planSpells(actor, previousLevel, targetLevel) {
    const cls = actor.class;
    if (!cls) return null;
    const slug = cls.slug ?? sluggify(cls.name);
    const rules = classRules(slug);
    if (!rules) return null;
    const found = findClassEntry(actor, rules, slug);
    const entry = found?.entry ?? null;
    const known = new Set(
      entry ? [...(entry.spells ?? [])].flatMap((s) => [s.sourceId, s.slug].filter(Boolean)) : []
    );
    return {
      rules,
      slug,
      entry,
      adopted: !!found?.adopted,
      tradition: entry?.system?.tradition?.value || detectTradition(actor, rules, slug),
      picks: spellPicks(rules, entry, entry ? previousLevel : 0, targetLevel),
      slotChanges: slotChanges(rules, entry, targetLevel),
      known,
      signature: signatureAt(rules, targetLevel),
      className: cls.name,
      attribute: cls.system?.keyAbility?.selected ?? null
    };
  }

  /** Spells are handled when the class entry exists, or when the player chose to set it up now */
  #spellsActive() {
    const sp = this.plan?.spells;
    return !!sp && (!!sp.entry || this.selection.spellSetup);
  }

  #spellTradition() {
    const sp = this.plan?.spells;
    return sp?.tradition || this.selection.spellTradition || null;
  }

  /** View data for the Spells section */
  #spells() {
    const sp = this.plan.spells;
    if (!sp) return null;
    const active = this.#spellsActive();
    const tradition = this.#spellTradition();
    if (active) this.selection.spells = trimSpellSelection(this.selection.spells, sp.picks);
    const chosen = sp.picks.reduce((n, p) => n + (this.selection.spells[p.key]?.length ?? 0), 0);
    const total = sp.picks.reduce((n, p) => n + p.count, 0);
    return {
      active,
      setup: !sp.entry,
      adopted: sp.adopted,
      entryName: sp.entry?.name ?? null,
      className: sp.className,
      needTradition: active && !tradition,
      traditionOptions: TRADITIONS.map((t) => ({
        value: t,
        label: game.i18n.localize(CONFIG.PF2E.magicTraditions?.[t] ?? t),
        selected: t === tradition
      })),
      slotChanges: sp.slotChanges.map((c) => ({ ...c, gained: c.to > c.from })),
      groups:
        active && tradition
          ? spellPickerView({
              picks: sp.picks,
              index: this.plan.spellIndex ?? [],
              selection: this.selection.spells,
              tradition,
              known: sp.known,
              hiddenRarities: hiddenRarities(),
              search: this.spellSearch
            })
          : [],
      chosen,
      total,
      signature: active ? this.#signatureView() : null,
      complete: !active || (!!tradition && chosen === total && this.#signatureComplete()),
      noPicks: sp.picks.length === 0
    };
  }

  /** Repertoire spells by rank (held and newly picked), keyed `item:<id>` / `new:<uuid>` */
  #repertoireByRank() {
    const sp = this.plan.spells;
    const byRank = {};
    const add = (rank, key, name) => (byRank[rank] ??= []).push({ key, name });
    for (const spell of sp.entry?.spells ?? []) {
      if (!spell.isCantrip) add(spell.baseRank, `item:${spell.id}`, spell.name);
    }
    const index = new Map((this.plan.spellIndex ?? []).map((s) => [s.uuid, s]));
    for (const uuid of Object.values(this.selection.spells).flat()) {
      const s = index.get(uuid);
      if (s && !s.cantrip) add(s.rank, `new:${uuid}`, s.name);
    }
    for (const list of Object.values(byRank)) list.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    return byRank;
  }

  /** Signature choices, rank → key; starts from the entry's current signature spells */
  #signatureChoice() {
    const sig = this.plan.spells?.signature;
    if (!sig || sig.mode !== 'onePerRank') return {};
    this.selection.signature ??= currentSignatures(this.plan.spells.entry);
    const byRank = this.#repertoireByRank();
    // Drop choices whose spell is no longer available (an unpicked new spell)
    for (const [rank, key] of Object.entries(this.selection.signature)) {
      if (!byRank[rank]?.some((s) => s.key === key)) delete this.selection.signature[rank];
    }
    return this.selection.signature;
  }

  #signatureView() {
    const sig = this.plan.spells?.signature;
    if (!sig) return null;
    if (sig.mode === 'all') return { all: true };
    const byRank = this.#repertoireByRank();
    const choice = this.#signatureChoice();
    const rows = sig.ranks
      .filter((rank) => byRank[rank]?.length)
      .map((rank) => ({
        rank,
        label: localize('spells.rank', { rank }),
        options: byRank[rank].map((s) => ({ ...s, selected: choice[rank] === s.key })),
        missing: !choice[rank]
      }));
    return rows.length ? { rows } : null;
  }

  #signatureComplete() {
    const view = this.#signatureView();
    return !view?.rows || view.rows.every((r) => !r.missing);
  }

  /**
   * Prerequisite context including the choices made so far in this level-up. PF2e lets a character use
   * a skill increase or boost gained at the same level to qualify for a feat.
   * @param {string} [excludeSlot] slot whose own pick should not count (a feat can't qualify itself)
   */
  prereqContext(excludeSlot) {
    const base = this.plan?.prereqBase;
    if (!base) return null;
    const feats = Object.entries(this.selection.feats)
      .filter(([key, pick]) => pick && key !== excludeSlot)
      .flatMap(([, f]) => [f.name, f.originalName, f.slug].filter(Boolean));
    try {
      return applyPendingChoices(base, {
        skillIncrease: [...this.selection.skillIncreases, ...this.selection.intSkills].filter(Boolean),
        feats,
        attributeBoosts: this.#nonPartialBoosts()
      });
    } catch {
      return base;
    }
  }

  /**
   * Prerequisite verdict for a feat: its own prerequisite lines, plus the archetype rule that a new
   * dedication needs two other feats from each archetype the character already has.
   * @param {string} [excludeSlot] slot whose own pick should not count
   */
  evaluateFeat(entry, ctx, excludeSlot) {
    const result = withTraitRequirements(evaluatePrerequisites(entry.prerequisites, ctx), entry.traits, ctx);
    if (!entry.traits?.includes('dedication')) return result;
    const pending = Object.entries(this.selection.feats)
      .filter(([key, pick]) => pick && key !== excludeSlot)
      .map(([, pick]) => pick);
    const incomplete = getDedicationProgress(this.actor, pending).filter((d) => d.count < 2);
    if (!incomplete.length) return result;
    const lines = incomplete.map((d) => ({
      text: localize('prerequisites.dedicationRule', { dedication: d.name, count: d.count }),
      status: 'unmet'
    }));
    return { status: 'unmet', results: [...(result.results ?? []), ...lines] };
  }

  /** Attributes whose modifier rises from the chosen boosts (partial boosts don't count) */
  #nonPartialBoosts() {
    const plan = this.plan;
    if (!plan?.boostSets.length) return [];
    const { gains } = describeBoosts(this.actor, plan.boostSets, this.selection.boosts);
    return Object.entries(gains).flatMap(([attr, n]) => Array(n).fill(attr));
  }

  candidatesFor(slot) {
    const plan = this.plan;
    const pending = Object.entries(this.selection.feats)
      .filter(([key, pick]) => pick && key !== slot.key)
      .map(([, pick]) => pick);
    const ownedKeys = new Map(plan.ownedKeys);
    for (const pick of pending) {
      for (const id of [pick.uuid, pick.slug]) ownedKeys.set(id, (ownedKeys.get(id) ?? 0) + 1);
    }
    // PF2e opens dedication-only slots to archetype feats once a dedication is on the sheet; a
    // dedication picked elsewhere in this level-up counts too
    const pendingDedication = pending.some((pick) => pick.traits?.includes('dedication'));
    const traits = slot.filter?.traits;
    const opened =
      pendingDedication && Array.isArray(traits) && traits.includes('dedication')
        ? { ...slot, filter: { ...slot.filter, traits: traits.map((t) => (t === 'dedication' ? 'archetype' : t)) } }
        : slot;
    return getCandidatesForSlot(opened, plan.index, {
      ownedKeys,
      dedications: getDedications(this.actor, pending),
      ...plan.lookups
    });
  }

  /* -------------------------------------------- */
  /*  "N of M feats fit" (computed after render)  */
  /* -------------------------------------------- */

  /** Changes whenever a choice that feeds prerequisites or availability changes */
  #choiceKey(slotKey) {
    const sel = this.selection;
    return JSON.stringify([
      Object.entries(sel.feats)
        .filter(([key, pick]) => pick && key !== slotKey)
        .map(([key, pick]) => [key, pick.uuid]),
      sel.skillIncreases,
      sel.intSkills,
      sel.boosts
    ]);
  }

  /** The cached count for a slot; `stale` once a choice changed and a new count is on its way */
  #fitFor(slot) {
    const entry = this.#cache.fit.get(slot.key);
    if (!entry) return null;
    return { ...entry, stale: entry.key !== this.#choiceKey(slot.key) };
  }

  #fitText(fit) {
    if (!fit) return localize('menu.feats.fitPending');
    if (!fit.checked) return localize('menu.feats.available', { total: fit.total });
    return localize('menu.feats.fitCount', {
      fit: fit.fit,
      total: fit.total,
      actorName: this.actor.name
    });
  }

  #computeFit(slot) {
    const hidden = hiddenRarities();
    let candidates = this.candidatesFor(slot).filter((c) => !hidden.includes(c.rarity));
    // The picker hides archetype feats in class slots by default, so they don't count here either
    if (candidates.some((c) => !c.isArchetype)) candidates = candidates.filter((c) => !c.isArchetype);
    const ctx = this.prereqContext(slot.key);
    const checked = !!ctx && game.settings.get(MODULE_ID, 'prerequisite-mode') !== 'off';
    const fit = checked
      ? candidates.filter((c) => this.evaluateFeat(c, ctx, slot.key).status !== 'unmet').length
      : candidates.length;
    return { key: this.#choiceKey(slot.key), fit, total: candidates.length, checked };
  }

  /** Computes the count off the render path so opening the wizard stays quick */
  #queueFit(slot) {
    const { fitQueued, fit } = this.#cache;
    if (fitQueued.has(slot.key)) return;
    fitQueued.add(slot.key);
    setTimeout(() => {
      fitQueued.delete(slot.key);
      if (!this.rendered || !this.plan) return;
      let entry;
      try {
        entry = this.#computeFit(slot);
      } catch (error) {
        console.warn(`${MODULE_ID} | Could not count the feats that fit`, error);
        entry = { key: this.#choiceKey(slot.key), fit: 0, total: 0, checked: false };
      }
      fit.set(slot.key, entry);
      for (const el of this.element.querySelectorAll('[data-fit-slot]')) {
        if (el.dataset.fitSlot === slot.key) el.textContent = this.#fitText(entry);
      }
    }, 0);
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    if (!this.plan) this.plan = await this.#buildPlan();
    const plan = this.plan;
    const sel = this.selection;
    const requireAll = game.settings.get(MODULE_ID, 'require-all-choices');
    const prereqCtx = this.prereqContext();
    const prereqMode = game.settings.get(MODULE_ID, 'prerequisite-mode');
    const lang = game.i18n.lang;

    // Feats
    const featSlots = plan.slots.current.map((s) => this.#featRow(s, true, prereqCtx, prereqMode));
    const missedSlots = plan.slots.missed.map((s) => this.#featRow(s, false, prereqCtx, prereqMode));

    // Attribute boosts, and the Intelligence skills and languages they open up
    const boosts = plan.boostSets.length
      ? describeBoosts(this.actor, plan.boostSets, sel.boosts)
      : null;
    const intGain = boosts?.intGain ?? 0;
    this.#syncArray('intSkills', intGain);
    plan.languageSlots = getOpenLanguageSlots(this.actor, intGain);
    this.#syncArray('languages', plan.languageSlots);
    const boostSets = boosts ? this.#boostSets(boosts) : [];

    // Skills
    const skillIncreases = sel.skillIncreases.map((value, index) => ({
      index,
      number: index + 1,
      title:
        sel.skillIncreases.length > 1
          ? localize('menu.skillIncreases.numbered', {
              number: index + 1,
              total: sel.skillIncreases.length
            })
          : localize('menu.skillIncreases.header'),
      value,
      grid: this.#skillGrid('skillIncrease', index, value, localize('menu.skillIncreases.label'))
    }));
    const intSkills = sel.intSkills.map((value, index) => ({
      index,
      value,
      grid: this.#skillGrid('intSkill', index, value, localize('menu.intBonus.skill'), true)
    }));

    const languages = this.#languages();
    const potency = this.#potency();
    const spells = this.#spells();

    // What is still open
    const missing = [];
    for (const slot of featSlots) if (!slot.pick) missing.push(`${slot.groupLabel} (${slot.label})`);
    if (sel.skillIncreases.some((s) => !s)) missing.push(localize('menu.skillIncreases.header'));
    for (const set of boosts?.sets ?? []) {
      if (!set.complete) missing.push(localize('menu.attributeBoosts.header'));
    }
    if (potency?.selects.some((s) => !s.value)) missing.push(localize('menu.skillPotency.header'));
    if (sel.intSkills.some((s) => !s)) missing.push(localize('menu.intBonus.skill'));
    if (spells && !spells.complete) missing.push(localize('menu.steps.spells'));

    const missingGroups = [
      ...new Set([
        ...featSlots.filter((s) => !s.pick).map((s) => s.groupLabel),
        ...(sel.skillIncreases.some((s) => !s) ? [localize('menu.steps.skills')] : []),
        ...((boosts?.sets ?? []).some((s) => !s.complete) ? [localize('menu.steps.boosts')] : []),
        ...(sel.intSkills.some((s) => !s) ? [localize('menu.intBonus.skill')] : []),
        ...(potency?.selects.some((s) => !s.value) ? [localize('menu.steps.potency')] : []),
        ...(spells && !spells.complete ? [localize('menu.steps.spells')] : [])
      ])
    ];
    const choicesLeft =
      featSlots.filter((s) => !s.pick).length +
      sel.skillIncreases.filter((s) => !s).length +
      (boosts?.sets ?? []).reduce((n, s) => n + (s.remaining - s.chosen), 0) +
      sel.intSkills.filter((s) => !s).length +
      (potency?.selects.filter((s) => !s.value).length ?? 0) +
      (spells?.active ? spells.total - spells.chosen + (spells.needTradition ? 1 : 0) : 0) +
      (spells?.signature?.rows?.filter((r) => r.missing).length ?? 0);

    // Steps
    const sections = this.#sections({ featSlots, missedSlots, boosts, intSkills, languages, potency, spells });
    const stepped = plan.layout === 'steps';
    const choiceKeys = stepped ? sections.map((s) => s.key) : ['choices'];
    this.stepKeys = [...choiceKeys, 'review'];
    if (!this.stepKeys.includes(this.step)) this.step = this.stepKeys[0];
    if (this.step !== 'review') this.lastChoiceStep = this.step;
    const reviewing = this.step === 'review';
    this.reviewBlocked = requireAll && missing.length > 0;
    const show = Object.fromEntries(
      ['feats', 'skills', 'boosts', 'extras', 'spells'].map((key) => [
        key,
        sections.some((s) => s.key === key) && (!stepped || this.step === key)
      ])
    );
    const steps = stepped
      ? [
          ...sections.map((s) => ({
            key: s.key,
            label: s.label,
            current: this.step === s.key,
            done: s.total > 0 && s.done >= s.total,
            count: s.total ? `${s.done}/${s.total}` : null,
            optional: !s.total
          })),
          {
            key: 'review',
            label: localize('menu.steps.review'),
            current: reviewing,
            done: false,
            count: null,
            optional: false,
            blocked: this.reviewBlocked
          }
        ]
      : [];

    const hp = this.#hp();
    const stepIndex = this.stepKeys.indexOf(this.step);
    const nextKey = this.stepKeys[stepIndex + 1] ?? null;
    const hasNothingToChoose = !sections.length;
    const manualStatic = this.#manualUpdates();

    const review = reviewing
      ? await this.#review({ boosts, featSlots, missedSlots, missing, hp })
      : null;

    const featsOnly =
      featSlots.length > 0 && !skillIncreases.length && !boostSets.length && !potency && !languages && !intSkills.length;
    const title = hasNothingToChoose
      ? localize('menu.single.titleNone', { level: plan.targetLevel })
      : featsOnly
        ? localize('menu.single.titleFeats', { level: plan.targetLevel })
        : localize('menu.single.title', { level: plan.targetLevel });
    const gains = [
      ...new Set(featSlots.map((s) => s.groupLabel.toLocaleLowerCase(lang))),
      ...(skillIncreases.length ? [localize('menu.steps.skills').toLocaleLowerCase(lang)] : []),
      ...(boostSets.length ? [localize('menu.steps.boosts').toLocaleLowerCase(lang)] : []),
      ...(intSkills.length ? [localize('menu.intBonus.skill').toLocaleLowerCase(lang)] : []),
      ...(potency ? [localize('menu.steps.potency').toLocaleLowerCase(lang)] : []),
      ...(languages ? [localize('menu.languages.header').toLocaleLowerCase(lang)] : [])
    ];
    const subtitle = hasNothingToChoose
      ? localize('menu.nothingToChoose')
      : localize('menu.single.subtitle', { list: joinList(gains, lang) });

    const xp = xpInfo(this.actor);
    return Object.assign(context, {
      actor: this.actor,
      actorName: this.actor.name,
      targetLevel: plan.targetLevel,
      previousLevel: plan.previousLevel,
      levelJump: plan.levelAlreadyApplied && plan.targetLevel - plan.previousLevel > 1,
      classJournals: plan.classJournals,
      layout: plan.layout,
      stepped,
      reviewing,
      step: this.step,
      steps,
      show,
      title,
      subtitle,
      showRail: !stepped && !reviewing,
      rail: this.#rail({ featSlots, skillIncreases, boostSets, intSkills, languages, potency, hp, xp }),
      featSlots,
      missedSlots,
      missedCount: missedSlots.length,
      missedList: missedSlots.map((s) => s.slotTitle).join(', '),
      showMissed: this.showMissed,
      skillIncreases,
      maxSkillRankLabel: rankLabel(plan.maxSkillRank),
      boostSets,
      manualAttributes: plan.manualAttributes,
      gradualBoosts: !!game.pf2e?.settings?.variants?.gab,
      intSkills,
      languages,
      potency,
      spells,
      classFeatures: plan.classFeatures,
      manual: { items: manualStatic, empty: !manualStatic.length },
      hasNothingToChoose,
      review,
      missing: [...new Set(missing)],
      requireAll,
      reviewBlocked: this.reviewBlocked,
      canSubmit: !this.submitting && !this.reviewBlocked,
      canUndo: canUndo(this.actor),
      submitting: this.submitting,
      footer: {
        choicesLeft,
        left:
          choicesLeft === 0
            ? null
            : localize(choicesLeft === 1 ? 'menu.footer.choiceLeft' : 'menu.footer.choicesLeft', {
                count: choicesLeft
              }),
        leftDetail: missingGroups.join(', '),
        allChosen: choicesLeft === 0,
        levels: `${plan.previousLevel} → ${plan.targetLevel}`,
        canGoBack: stepped && !reviewing && stepIndex > 0,
        nextIsReview: nextKey === 'review',
        nextLabel:
          nextKey === 'review'
            ? localize('menu.footer.review', { targetLevel: plan.targetLevel })
            : localize('menu.footer.next'),
        reviewLabel: localize('menu.footer.review', { targetLevel: plan.targetLevel })
      }
    });
  }

  /** The choice groups that have content, in step order */
  #sections({ featSlots, missedSlots, boosts, intSkills, languages, potency, spells }) {
    const sel = this.selection;
    const sections = [];
    if (featSlots.length || missedSlots.length) {
      sections.push({
        key: 'feats',
        label: localize('menu.steps.feats'),
        done: featSlots.filter((s) => s.pick).length,
        total: featSlots.length
      });
    }
    if (sel.skillIncreases.length) {
      sections.push({
        key: 'skills',
        label: localize('menu.steps.skills'),
        done: sel.skillIncreases.filter(Boolean).length,
        total: sel.skillIncreases.length
      });
    }
    if (boosts?.sets.length) {
      sections.push({
        key: 'boosts',
        label: localize('menu.steps.boosts'),
        done: boosts.sets.reduce((n, s) => n + s.chosen, 0),
        total: boosts.sets.reduce((n, s) => n + s.remaining, 0)
      });
    }
    if (intSkills.length || languages || potency) {
      const required = intSkills.length + (potency?.selects.length ?? 0);
      const done =
        sel.intSkills.filter(Boolean).length +
        (potency?.selects.filter((s) => s.value).length ?? 0);
      sections.push({
        key: 'extras',
        label: localize('menu.steps.extras'),
        done,
        total: required
      });
    }
    if (spells && (spells.setup || spells.total || spells.slotChanges.length || spells.signature)) {
      sections.push({
        key: 'spells',
        label: localize('menu.steps.spells'),
        done: spells.active ? spells.chosen : 0,
        total: spells.active ? spells.total : 0
      });
    }
    return sections;
  }

  /** One feat slot card */
  #featRow(slot, required, prereqCtx, prereqMode) {
    const pick = this.selection.feats[slot.key] ?? null;
    let prereq = null;
    if (pick && prereqCtx && prereqMode !== 'off') {
      const verdict = this.evaluateFeat(pick, prereqCtx, slot.key);
      const pill = prereqPill(verdict, pick.prerequisites ?? []);
      prereq = { ...pill, tooltip: prereqTooltip(verdict, escapeHTML) };
    }
    const type = groupType(slot.groupId);
    const numeric = /^\d+$/.test(String(slot.label));
    const slotTitle = numeric
      ? localize('menu.feats.chip', { group: slot.groupLabel, level: slot.level })
      : `${slot.groupLabel} · ${slot.label}`;
    const row = {
      ...slot,
      required,
      pick,
      prereq,
      type,
      slotTitle,
      placeholder: slot.placeholder ?? null,
      browse: localize('menu.feats.browse', { group: slot.groupLabel })
    };
    if (pick) {
      row.glyph = glyphView(pick.actionType, pick.actions);
      row.traits = (pick.traits ?? []).slice(0, 3).map((t) =>
        game.i18n.localize(CONFIG.PF2E.featTraits?.[t] ?? t)
      );
    } else {
      const fit = this.#fitFor(slot);
      row.fitText = this.#fitText(fit);
      // Slots tucked away in the collapsed "Optional" row are counted once they are opened
      if ((!fit || fit.stale) && (required || this.showMissed)) this.#pendingFit.add(slot);
    }
    return row;
  }

  /* -------------------------------------------- */

  /** Grid of skill buttons for one skill increase, Intelligence training or potency choice */
  #skillGrid(choice, index, value, label, forTraining = false) {
    const plan = this.plan;
    const sel = this.selection;
    const mode = game.settings.get(MODULE_ID, 'skill-increase-info');
    const showMod = mode.includes('MOD');
    const showRank = mode.includes('RANK');
    const taken = new Set([...sel.skillIncreases, ...sel.intSkills].filter((s) => s && s !== value));
    const items = plan.skillOptions
      .filter((s) => (forTraining ? s.rank === 0 && !s.isLore : true))
      .map((s) => {
        const capped = !forTraining && s.rank >= plan.maxSkillRank;
        const isTaken = taken.has(s.slug);
        const selected = s.slug === value;
        const next = Math.min(s.rank + 1, 4);
        const shown = selected || !capped ? next : s.rank;
        const rankText = `${rankLabel(s.rank)} → ${rankLabel(next)}`;
        return {
          slug: s.slug,
          label: s.label,
          selected,
          disabled: capped || isTaken,
          state: capped ? 'capped' : isTaken ? 'taken' : null,
          stateLabel: capped
            ? localize('menu.skillIncreases.maxed', { rank: rankLabel(s.rank) })
            : isTaken
              ? localize('menu.skillIncreases.taken')
              : null,
          mod: showMod ? signedNumber(s.modifier) : null,
          sub: showRank ? (capped ? rankLabel(s.rank) : rankText) : null,
          srText: capped ? rankLabel(s.rank) : rankText,
          dots: rankDots(s.rank, selected ? next : s.rank),
          rank: shown
        };
      });
    return { choice, index, label, items };
  }

  #potency() {
    const plan = this.plan;
    if (!plan.potency) return null;
    const sel = this.selection;
    const mode = game.settings.get(MODULE_ID, 'skill-increase-info');
    const selects = POTENCY_KEYS.map((key) => {
      const list = plan.potency[key];
      if (!list) return null;
      const value = sel.potency[key] ?? '';
      const label = localize(`menu.skillPotency.${key}`);
      const takenElsewhere = new Set(
        Object.entries(sel.potency)
          .filter(([k, v]) => k !== key && v)
          .map(([, v]) => v)
      );
      return {
        key,
        label,
        value,
        grid: {
          choice: 'potency',
          index: key,
          label,
          items: list.map((s) => {
            const selected = s.slug === value;
            const isTaken = takenElsewhere.has(s.slug);
            return {
              slug: s.slug,
              label: s.label,
              selected,
              disabled: isTaken,
              state: isTaken ? 'taken' : null,
              stateLabel: isTaken ? localize('menu.skillIncreases.taken') : null,
              mod: mode.includes('MOD') ? signedNumber(s.modifier) : null,
              sub: `+${s.potency} → +${POTENCY_VALUES[key]}`,
              srText: describeSkillOption(s, 0)
            };
          })
        }
      };
    }).filter(Boolean);
    return { current: plan.potency.current, selects };
  }

  #languages() {
    const sel = this.selection;
    const plan = this.plan;
    if (!sel.languages.length) return null;
    const chosen = sel.languages.filter(Boolean);
    const { chips, hasMore } = languageChips(plan.languageOptions, chosen, this.showAllLanguages);
    const full = chosen.length >= sel.languages.length;
    const canToggle = this.showAllLanguages || hasMore;
    return {
      count: sel.languages.length,
      chosenCount: chosen.length,
      title:
        sel.languages.length === 1
          ? localize('menu.languages.one')
          : localize('menu.languages.many', { count: sel.languages.length }),
      showCounter: sel.languages.length > 1,
      chips: chips.map((l) => {
        const selected = chosen.includes(l.slug);
        return {
          slug: l.slug,
          selected,
          // With one slot a new pick replaces the old one; with several a full set has to be trimmed first
          disabled: !selected && full && sel.languages.length > 1,
          label: l.label,
          rarity:
            l.rarity === 'common'
              ? null
              : game.i18n.localize(CONFIG.PF2E.rarityTraits?.[l.rarity] ?? l.rarity)
        };
      }),
      canToggle,
      complete: chosen.length >= sel.languages.length,
      expanded: this.showAllLanguages,
      later: chosen.length === 0
    };
  }

  /** Attribute boost sets as tiles */
  #boostSets(boosts) {
    const gradual = !!game.pf2e?.settings?.variants?.gab;
    return boosts.sets.map((set) => ({
      set: set.set,
      remaining: set.remaining,
      chosen: set.chosen,
      complete: set.complete,
      title: gradual
        ? localize('menu.attributeBoosts.gradualLabel', { count: set.remaining, set: set.set })
        : localize('menu.attributeBoosts.label', { count: set.remaining }),
      tiles: set.attributes.map((a) => {
        const mod = boosts.modifiers.find((m) => m.key === a.key);
        const picked = a.selected && !a.locked;
        let status = 'idle';
        let line;
        if (a.locked) {
          status = 'locked';
          line = localize('menu.attributeBoosts.locked');
        } else if (picked && a.partial) {
          status = 'half';
          line = localize('menu.attributeBoosts.halfBoost');
        } else if (picked && mod.current >= 4) {
          // A full boost on a modifier that is already +4 can only be the second half of a split boost
          status = 'completes';
          line = localize('menu.attributeBoosts.completesHalf');
        } else if (picked) {
          status = 'selected';
          line = localize('menu.attributeBoosts.was', { mod: signedNumber(mod.current) });
        } else if (a.disabled) {
          status = 'full';
          line = localize('menu.attributeBoosts.setFull', { count: set.remaining });
        } else if (a.partial) {
          status = 'idle-half';
          line = localize('menu.attributeBoosts.halfBoost');
        } else {
          line = localize('menu.attributeBoosts.boost');
        }
        return {
          key: a.key,
          label: a.label,
          display: mod.display,
          status,
          line,
          picked,
          locked: a.locked,
          disabled: a.disabled,
          half: status === 'half' || status === 'idle-half',
          pressed: a.selected
        };
      })
    }));
  }

  /* -------------------------------------------- */
  /*  Rail, review                                */
  /* -------------------------------------------- */

  #hpOf(actor) {
    const max = actor?.system?.attributes?.hp?.max;
    return typeof max === 'number' ? max : null;
  }

  /** Hit points before and after, with the chosen boosts applied to a preview of the new level */
  #hp() {
    const plan = this.plan;
    try {
      const cache = this.#cache;
      if (cache.hpBefore === undefined) {
        cache.hpBefore = this.levelAlreadyApplied
          ? this.#hpOf(createPreviewActor(this.actor, plan.previousLevel))
          : this.#hpOf(this.actor);
      }
      const changes = {};
      for (const { set, existing } of plan.boostSets) {
        const chosen = this.selection.boosts[set] ?? [];
        if (chosen.length) {
          foundry.utils.setProperty(changes, `system.build.attributes.boosts.${set}`, [
            ...existing,
            ...chosen
          ]);
        }
      }
      const key = JSON.stringify(changes);
      if (cache.hp?.key !== key) {
        const preview = key === '{}' ? plan.preview : createPreviewActor(this.actor, plan.targetLevel, changes);
        cache.hp = { key, value: this.#hpOf(preview) };
      }
      const before = cache.hpBefore;
      const after = cache.hp.value;
      if (before === null || after === null) return null;
      return { before, after, changed: before !== after };
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not preview hit points`, error);
      return null;
    }
  }

  #rail({ featSlots, skillIncreases, boostSets, intSkills, languages, potency, hp, xp }) {
    const plan = this.plan;
    const sel = this.selection;
    const actor = this.actor;
    const lang = game.i18n.lang;
    const pending = localize('menu.rail.toChoose');
    const checklist = [];
    for (const slot of featSlots) {
      checklist.push({
        label: slot.groupLabel,
        detail: slot.pick?.name ?? pending,
        done: !!slot.pick
      });
    }
    for (const increase of skillIncreases) {
      const option = plan.skillOptions.find((s) => s.slug === increase.value);
      checklist.push({
        label: localize('menu.skillIncreases.header'),
        detail: option?.label ?? pending,
        done: !!increase.value
      });
    }
    for (const set of boostSets) {
      checklist.push({
        label: localize('menu.attributeBoosts.header'),
        detail: set.complete
          ? (sel.boosts[set.set] ?? []).map(attributeLabel).join(', ')
          : `${set.chosen}/${set.remaining}`,
        done: set.complete
      });
    }
    for (const skill of intSkills) {
      const option = plan.skillOptions.find((s) => s.slug === skill.value);
      checklist.push({
        label: localize('menu.intBonus.skill'),
        detail: option?.label ?? pending,
        done: !!skill.value
      });
    }
    for (const select of potency?.selects ?? []) {
      const option = plan.skillOptions.find((s) => s.slug === select.value);
      checklist.push({ label: select.label, detail: option?.label ?? pending, done: !!select.value });
    }
    if (languages) {
      checklist.push({
        label: localize('menu.languages.header'),
        detail: languages.chosenCount
          ? sel.languages
              .filter(Boolean)
              .map((slug) => this.#languageLabel(slug))
              .join(', ')
          : localize('menu.rail.optional'),
        done: languages.chosenCount >= languages.count,
        optional: true
      });
    }

    const gainsProficiency = !game.pf2e?.settings?.variants?.pwol?.enabled;
    const features = plan.classFeatures.length
      ? localize('menu.rail.featuresCount', { count: plan.classFeatures.length })
      : localize('menu.rail.featuresNone', { level: plan.targetLevel });
    return {
      img: actor.img,
      name: actor.name,
      subtitle: [actor.ancestry?.name, actor.class?.name].filter(Boolean).join(' · '),
      from: plan.previousLevel,
      to: plan.targetLevel,
      hp,
      proficiency: gainsProficiency,
      features,
      hasFeatures: plan.classFeatures.length > 0,
      checklist,
      hasChecklist: checklist.length > 0,
      xp:
        plan.xpEnforcement && !plan.levelAlreadyApplied
          ? localize('menu.rail.xp', {
              xp: formatNumber(xp.value, lang),
              level: plan.targetLevel,
              cost: formatNumber(xp.max, lang)
            })
          : null
    };
  }

  #languageLabel(slug) {
    const label = CONFIG.PF2E.languages?.[slug];
    return label ? game.i18n.localize(label) : slug;
  }

  /** Reminders for what the system doesn't automate and that the plan already knows */
  #manualUpdates() {
    const plan = this.plan;
    const items = [];
    if (plan.manualAttributes) items.push(localize('menu.attributeBoosts.manual'));
    const managed = this.#spellsActive() ? plan.spells.entry?.id ?? 'new' : null;
    const spellcasting = managed
      ? {
          newRank: null,
          entries: (plan.spellcasting?.entries ?? []).filter((e) => e.id !== managed)
        }
      : plan.spellcasting;
    if (spellcasting?.newRank) {
      items.push(localize('messages.personal.spellRank', { rank: spellcasting.newRank }));
    }
    if (spellcasting?.entries?.length) {
      items.push(
        localize('messages.personal.spellSlots', {
          entries: spellcasting.entries.map((e) => e.name).join(', ')
        })
      );
    }
    return items;
  }

  async #spellHints() {
    const cache = this.#cache.spellHints;
    const names = [];
    for (const pick of Object.values(this.selection.feats)) {
      if (!pick) continue;
      if (!cache.has(pick.uuid)) {
        const doc = await fromUuid(pick.uuid).catch(() => null);
        cache.set(pick.uuid, SPELL_HINT_PATTERN.test(doc?.system?.description?.value ?? ''));
      }
      if (cache.get(pick.uuid)) names.push(pick.name);
    }
    return names;
  }

  /** Everything that will change, as before and after rows, plus what the table will see */
  async #review({ boosts, featSlots, missedSlots, missing, hp }) {
    const plan = this.plan;
    const sel = this.selection;
    const lang = game.i18n.lang;
    const rows = [];
    const row = (key, lines) => {
      if (lines.length) rows.push({ key, label: localize(`review.${key}`), lines });
    };

    row('level', [{ from: plan.previousLevel, to: plan.targetLevel }]);
    if (hp) row('hp', [{ from: hp.before, to: hp.after }]);

    if (boosts) {
      const lines = boosts.modifiers
        .filter((m) => m.changed)
        .map((m) => ({
          label: m.label,
          from: signedNumber(m.current),
          to: signedNumber(m.next)
        }));
      for (const set of this.#boostSets(boosts)) {
        for (const tile of set.tiles.filter((t) => t.status === 'half')) {
          lines.push({
            note: localize('review.halfBoost', { attribute: tile.label, mod: tile.display }),
            muted: true
          });
        }
      }
      row('attributes', lines);
    }

    row(
      'classFeatures',
      plan.classFeatures.map((f) => ({ label: f.name, uuid: f.uuid }))
    );

    const picked = [...featSlots, ...missedSlots].filter((s) => s.pick);
    row(
      'feats',
      picked.map((s) => ({
        chip: localize('menu.feats.chipShort', { group: s.groupLabel, level: s.level }),
        chipType: s.type,
        label: s.pick.name,
        uuid: s.pick.uuid
      }))
    );

    row(
      'skills',
      mergeSkillChanges(plan.skillOptions, [...sel.skillIncreases, ...sel.intSkills]).map((c) => ({
        label: c.label,
        from: rankLabel(c.from),
        to: rankLabel(c.to)
      }))
    );

    row(
      'languages',
      sel.languages.filter(Boolean).map((slug) => ({ plus: true, label: this.#languageLabel(slug) }))
    );

    row(
      'potency',
      POTENCY_KEYS.filter((k) => sel.potency[k]).map((k) => ({
        label: plan.skillOptions.find((s) => s.slug === sel.potency[k])?.label ?? sel.potency[k],
        from: `+${POTENCY_VALUES[k] - 1}`,
        to: `+${POTENCY_VALUES[k]}`
      }))
    );

    if (this.#spellsActive()) {
      const sp = plan.spells;
      const names = new Map((plan.spellIndex ?? []).map((s) => [s.uuid, s.name]));
      row('spells', [
        ...(sp.entry ? [] : [{ plus: true, label: localize('menu.spells.newEntry', { className: sp.className }) }]),
        ...sp.slotChanges.map((c) => ({ label: c.label, from: c.from, to: c.to })),
        ...Object.values(sel.spells)
          .flat()
          .map((uuid) => ({ plus: true, label: names.get(uuid) ?? uuid }))
      ]);
      const signature = this.#signatureView();
      if (signature?.all) row('signature', [{ label: localize('menu.spells.signatureAll') }]);
      else if (signature?.rows) {
        row(
          'signature',
          signature.rows.map((r) => ({
            label: `${r.label}: ${r.options.find((o) => o.selected)?.name ?? '—'}`
          }))
        );
      }
    }

    if (plan.xpEnforcement && !plan.levelAlreadyApplied) {
      const { value, max } = xpInfo(this.actor);
      const after = Math.max(0, value - max * (plan.targetLevel - plan.previousLevel));
      row('xp', [{ from: formatNumber(value, lang), to: `${formatNumber(after, lang)} XP` }]);
    }

    // What the whisper after applying will list
    const manual = this.#manualUpdates();
    const hints = await this.#spellHints();
    if (hints.length) manual.push(localize('messages.personal.featSpells', { feats: hints.join(', ') }));
    const openLanguages = plan.languageSlots - sel.languages.filter(Boolean).length;
    if (openLanguages > 0) manual.push(localize('messages.personal.languages', { count: openLanguages }));
    const missingSkills = sel.intSkills.filter((s) => !s).length;
    if (missingSkills > 0) manual.push(localize('messages.personal.intSkill', { count: missingSkills }));
    const emptySlots = featSlots.filter((s) => !s.pick);
    if (emptySlots.length) {
      manual.push(
        localize('messages.personal.emptySlots', {
          slots: emptySlots.map((s) => s.groupLabel).join(', ')
        })
      );
    }

    // A condensed copy of the public chat message
    const chatLines = [];
    if (picked.length) chatLines.push(picked.map((s) => s.pick.name).join(' · '));
    const other = [
      ...mergeSkillChanges(plan.skillOptions, [...sel.skillIncreases, ...sel.intSkills]).map(
        (c) => `${c.label}: ${rankLabel(c.to)}`
      ),
      ...(boosts
        ? Object.entries(boosts.gains)
            .filter(([, n]) => n > 0)
            .map(([attr]) => attributeLabel(attr))
        : []),
      ...sel.languages.filter(Boolean).map((slug) => this.#languageLabel(slug)),
      ...POTENCY_KEYS.filter((k) => sel.potency[k]).map(
        (k) =>
          `${plan.skillOptions.find((s) => s.slug === sel.potency[k])?.label ?? sel.potency[k]} +${POTENCY_VALUES[k]}`
      )
    ];
    if (other.length) chatLines.push(other.join(' · '));
    if (this.#spellsActive()) {
      const spellNames = new Map((plan.spellIndex ?? []).map((s) => [s.uuid, s.name]));
      const newSpells = Object.values(sel.spells)
        .flat()
        .map((uuid) => spellNames.get(uuid) ?? uuid);
      if (newSpells.length) chatLines.push(newSpells.join(' · '));
    }
    if (!chatLines.length) chatLines.push(localize('messages.global.noChoices'));

    return {
      rows,
      manual: { items: manual, empty: !manual.length },
      skipped: [...new Set(missing)],
      chat: {
        header: localize('messages.global.header', {
          actorName: this.actor.name,
          targetLevel: plan.targetLevel
        }),
        lines: chatLines
      }
    };
  }

  /** Resize a selection array to `length`, keeping existing choices */
  #syncArray(key, length) {
    const current = this.selection[key];
    if (current.length === length) return;
    this.selection[key] = Array.from({ length }, (_, i) => current[i] ?? '');
  }

  async _preRender(context, options) {
    await super._preRender(context, options);
    this.spellScroll = captureSpellScroll(this.element);
  }

  _attachPartListeners(partId, htmlElement, options) {
    super._attachPartListeners(partId, htmlElement, options);
    if (partId !== 'body') return;
    restoreSpellScroll(htmlElement, this.spellScroll);
    bindSpellSearch(htmlElement, this.spellSearch);
    htmlElement.querySelector('[data-spell-tradition]')?.addEventListener('change', (event) => {
      this.selection.spellTradition = event.currentTarget.value || null;
      this.selection.spells = {};
      this.render();
    });
    htmlElement.querySelectorAll('[data-signature-rank]').forEach((select) => {
      select.addEventListener('change', (event) => {
        const { signatureRank } = event.currentTarget.dataset;
        this.#signatureChoice();
        if (event.currentTarget.value) this.selection.signature[signatureRank] = event.currentTarget.value;
        else delete this.selection.signature[signatureRank];
        this.render();
      });
    });
  }

  _onRender(context, options) {
    super._onRender(context, options);
    if (!options.parts || options.parts.includes('body')) {
      const main = this.element.querySelector('.wizard-main');
      if (this.#stepChanged && main) {
        this.#stepChanged = false;
        main.scrollTop = 0;
        main.focus({ preventScroll: true });
      }
      for (const slot of this.#pendingFit) this.#queueFit(slot);
    }
    this.#pendingFit.clear();
  }

  /** Called by the feat selector */
  selectFeat(slotKey, candidate) {
    this.selection.feats[slotKey] = candidate;
    this.render();
  }

  findSlot(key) {
    return [...this.plan.slots.current, ...this.plan.slots.missed].find((s) => s.key === key);
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static async #onOpenFeatSelector(event, target) {
    const slot = this.findSlot(target.dataset.slotKey);
    if (!slot) return;
    // One picker per wizard: close a picker left open for another slot
    const openId = `${this.id}-feats`;
    await foundry.applications.instances.get(openId)?.close();
    const selector = new FeatSelector({
      wizard: this,
      slot,
      candidates: this.candidatesFor(slot),
      prereqContext: this.prereqContext(slot.key),
      currentPick: this.selection.feats[slot.key] ?? null
    });
    if (typeof this.renderChild === 'function') await this.renderChild(selector);
    else await selector.render({ force: true });
  }

  static #onToggleSpell(event, target) {
    const picks = this.plan?.spells?.picks ?? [];
    this.selection.spells = toggleSpell(this.selection.spells, picks, target.dataset.pick, target.dataset.uuid);
    this.render();
  }

  static #onToggleSpellSetup() {
    this.selection.spellSetup = !this.selection.spellSetup;
    if (!this.selection.spellSetup) this.selection.spells = {};
    this.render();
  }

  static #onClearFeat(event, target) {
    delete this.selection.feats[target.dataset.slotKey];
    this.render();
  }

  static #onToggleBoost(event, target) {
    const set = Number(target.dataset.set);
    const attr = target.dataset.attribute;
    const chosen = this.selection.boosts[set] ?? [];
    const plan = this.plan.boostSets.find((s) => s.set === set);
    if (!plan) return;
    if (chosen.includes(attr)) {
      this.selection.boosts[set] = chosen.filter((a) => a !== attr);
    } else if (chosen.length < plan.remaining && !plan.existing.includes(attr)) {
      this.selection.boosts[set] = [...chosen, attr];
    }
    this.render();
  }

  static #onToggleMissed() {
    this.showMissed = !this.showMissed;
    this.render();
  }

  /** A skill button: picking the chosen skill again clears the choice */
  static #onPickSkill(event, target) {
    const { choice, index, value } = target.dataset;
    const sel = this.selection;
    const toggle = (list, i) => {
      list[i] = list[i] === value ? '' : value;
    };
    switch (choice) {
      case 'skillIncrease':
        toggle(sel.skillIncreases, Number(index));
        break;
      case 'intSkill':
        toggle(sel.intSkills, Number(index));
        break;
      case 'potency':
        sel.potency[index] = sel.potency[index] === value ? '' : value;
        break;
    }
    this.render();
  }

  static #onToggleLanguage(event, target) {
    const slug = target.dataset.value;
    const languages = this.selection.languages;
    const at = languages.indexOf(slug);
    if (at >= 0) languages[at] = '';
    else {
      const free = languages.indexOf('');
      if (free >= 0) languages[free] = slug;
      else if (languages.length === 1) languages[0] = slug;
    }
    this.render();
  }

  static #onClearLanguages() {
    this.selection.languages = this.selection.languages.map(() => '');
    this.render();
  }

  static #onToggleAllLanguages() {
    this.showAllLanguages = !this.showAllLanguages;
    this.render();
  }

  #goTo(key) {
    if (!this.stepKeys.includes(key)) return;
    if (key === 'review' && this.reviewBlocked) {
      ui.notifications.warn(localize('notifications.incomplete'));
      return;
    }
    if (key === this.step) return;
    if (this.step !== 'review') this.lastChoiceStep = this.step;
    this.step = key;
    this.#stepChanged = true;
    this.render();
  }

  static #onGoStep(event, target) {
    this.#goTo(target.dataset.step);
  }

  static #onNextStep() {
    const next = this.stepKeys[this.stepKeys.indexOf(this.step) + 1];
    if (next) this.#goTo(next);
  }

  static #onPrevStep() {
    const prev = this.stepKeys[this.stepKeys.indexOf(this.step) - 1];
    if (prev && prev !== 'review') this.#goTo(prev);
  }

  static #onReview() {
    this.#goTo('review');
  }

  static #onBackToChoices() {
    this.#goTo(this.lastChoiceStep ?? this.stepKeys[0]);
  }

  static #onOpenHistory() {
    const app = new LevelUpHistory({ actor: this.actor });
    if (typeof this.renderChild === 'function') this.renderChild(app);
    else app.render({ force: true });
  }

  static async #onUndo() {
    if (await undoLastLevelUp(this.actor, { windowId: this.window.windowId })) this.close();
  }

  /* -------------------------------------------- */
  /*  Submit                                      */
  /* -------------------------------------------- */

  static async #onSubmit() {
    // Only the review step applies; a stray Enter key on another step must not
    if (this.step !== 'review') return;
    // Guard the whole submit against double clicks
    if (this.busy) return;
    this.busy = true;
    try {
      await this.#submit();
    } finally {
      this.busy = false;
      this.submitting = false;
      if (this.rendered) await this.render();
    }
  }

  async #submit() {
    const context = await this._prepareContext({});
    if (context.requireAll && context.missing.length) {
      ui.notifications.warn(localize('notifications.incomplete'));
      return;
    }

    if (!this.levelAlreadyApplied && this.actor.level !== this.previousLevel) {
      ui.notifications.error(localize('notifications.levelChanged'));
      return this.close();
    }

    this.submitting = true;
    await this.render({ parts: ['footer'] });
    const sp = this.plan.spells;
    if (this.#spellsActive()) {
      // The managed entry is updated for the player; only other entries still need a reminder
      const managed = sp.entry?.id ?? null;
      this.plan.spellcasting = {
        newRank: null,
        entries: (this.plan.spellcasting?.entries ?? []).filter((e) => e.id !== managed)
      };
    }
    const selection = {
      ...this.selection,
      spellPlan: this.#spellsActive()
        ? {
            rules: sp.rules,
            slug: sp.slug,
            entry: sp.entry,
            tradition: this.#spellTradition(),
            className: sp.className,
            attribute: sp.attribute,
            selection: this.selection.spells,
            signature: sp.signature ? { at: sp.signature, choice: this.#signatureChoice() } : null
          }
        : null,
      feats: Object.fromEntries(
        Object.entries(this.selection.feats)
          .filter(([, pick]) => pick)
          .map(([key, pick]) => [key, { ...pick, slot: this.findSlot(key) }])
      )
    };
    const applied = await applyLevelUp(this.actor, this.plan, selection);
    if (applied) await this.close();
  }
}

/** Wizards still loading their first render (they are not in the instances registry yet) */
const opening = new Map();

/** Open (or focus) the wizard for an actor */
export const openLevelUpWizard = (actor, options = {}) => {
  const id = `${MODULE_ID}-${actor.uuid.replace(/\./g, '-')}`;
  const existing = foundry.applications.instances.get(id) ?? opening.get(id);
  if (existing) {
    if (existing.rendered) existing.bringToFront();
    return existing;
  }
  const app = new LevelUpWizard({ actor, ...options });
  opening.set(id, app);
  app
    .render({ force: true })
    .catch((error) => {
      console.error(`${MODULE_ID} | Failed to open the wizard`, error);
      ui.notifications.error(localize('notifications.openFailed'));
    })
    .finally(() => opening.delete(id));
  return app;
};
