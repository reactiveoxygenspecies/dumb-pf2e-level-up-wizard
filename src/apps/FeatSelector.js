import { MODULE_ID, TEMPLATE_PATH } from '../constants.js';
import { sendFeatToChat } from '../helpers/chat.js';
import { enrichHTML, escapeHTML, localize } from '../helpers/utility.js';
import { glyphView, prereqPill, prereqTooltip } from './wizardView.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const RARITIES = ['common', 'uncommon', 'rare', 'unique'];

/** Skills listed before "All N skills" is pressed */
const VISIBLE_SKILLS = 5;

/** Filters are remembered per feat group for the rest of the session */
const rememberedFilters = new Map();

/** Rarities the GM hides from players in the feat picker */
export const hiddenRarities = () => {
  const setting = game.settings.get(MODULE_ID, 'hidden-rarities');
  if (setting === 'uncommon') return ['uncommon', 'rare', 'unique'];
  if (setting === 'rare') return ['rare', 'unique'];
  return [];
};

const skillMatchers = () =>
  Object.entries(CONFIG.PF2E.skills ?? {}).map(([slug, data]) => {
    const label = game.i18n.localize(data.label ?? data).toLocaleLowerCase();
    return { slug, label, terms: [slug, label] };
  });

const skillLabel = (slug) =>
  game.i18n.localize(CONFIG.PF2E.skills?.[slug]?.label ?? slug);

const SORTS = {
  'level-desc': { sortBy: 'level', sortOrder: 'desc', name: 'levelDesc' },
  'level-asc': { sortBy: 'level', sortOrder: 'asc', name: 'levelAsc' },
  'name-asc': { sortBy: 'name', sortOrder: 'asc', name: 'nameAsc' },
  'name-desc': { sortBy: 'name', sortOrder: 'desc', name: 'nameDesc' }
};

/**
 * Feat picker for one slot. The host (`wizard`) only needs `id`, `actor`, `selection.feats`,
 * `selectFeat(slotKey, pick)` and `evaluateFeat(entry, ctx, slotKey)`.
 */
export class FeatSelector extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * @param {object} options
   * @param {LevelUpWizard} options.wizard
   * @param {object} options.slot
   * @param {object[]} options.candidates
   * @param {object|null} options.prereqContext
   * @param {object|null} options.currentPick
   */
  constructor(options = {}) {
    // Keep the large data out of the application options, which core deep-clones
    const { wizard, slot, candidates, prereqContext, currentPick, ...rest } =
      options;
    super({ ...rest, id: `${wizard.id}-feats` });
    this.wizard = wizard;
    this.slot = slot;
    this.prereqContext = prereqContext;
    this.highlighted = currentPick?.uuid ?? null;
    this.descriptions = new Map();
    this.showAllSkills = false;
    this.#focusSearch = true;

    const prereqMode = game.settings.get(MODULE_ID, 'prerequisite-mode');
    const matchers = skillMatchers();
    this.candidates = candidates.map((c) => {
      const text = c.prerequisites.join(' ').toLocaleLowerCase();
      const prereq =
        prereqMode !== 'off' && this.prereqContext
          ? wizard.evaluateFeat(c, this.prereqContext, slot.key)
          : null;
      return {
        ...c,
        prereq,
        skills: matchers
          .filter((m) => m.terms.some((t) => t && text.includes(t)))
          .map((m) => m.slug)
      };
    });

    this.hasClassFeats = this.candidates.some((c) => !c.isArchetype);
    this.hasArchetypeFeats = this.candidates.some((c) => c.isArchetype);
    this.filters =
      rememberedFilters.get(this.slot.groupId) ?? this.#defaultFilters();

    // Quick filters count over every candidate, so the numbers don't jump while filtering
    this.skillCounts = new Map();
    for (const c of this.candidates) {
      for (const s of c.skills) {
        this.skillCounts.set(s, (this.skillCounts.get(s) ?? 0) + 1);
      }
    }
    this.levels = [...new Set(this.candidates.map((c) => c.effectiveLevel))].sort(
      (a, b) => b - a
    );
  }

  #focusSearch;

  #defaultFilters() {
    const sort = game.settings
      .get(MODULE_ID, 'feat-sort-method')
      .toLowerCase()
      .split('_');
    return {
      search: '',
      minLevel: null,
      maxLevel: null,
      sortBy: sort[0] === 'alpha' ? 'name' : 'level',
      sortOrder: sort[1] ?? 'desc',
      rarities: RARITIES.filter((r) => !hiddenRarities().includes(r)),
      showArchetype: !this.hasClassFeats,
      dedicationSearch: '',
      hideSkillFeats: false,
      skills: [],
      hideUnmet: game.settings.get(MODULE_ID, 'hide-unmet-prerequisites')
    };
  }

  static DEFAULT_OPTIONS = {
    classes: [MODULE_ID, 'lvlup-feat-selector'],
    window: { icon: 'fa-solid fa-medal', resizable: true },
    position: { width: 1120, height: 780 },
    actions: {
      highlight: FeatSelector.#onHighlight,
      select: FeatSelector.#onSelect,
      sendToChat: FeatSelector.#onSendToChat,
      toggleFilter: FeatSelector.#onToggleFilter,
      setLevel: FeatSelector.#onSetLevel,
      toggleAllSkills: FeatSelector.#onToggleAllSkills,
      resetFilters: FeatSelector.#onResetFilters
    }
  };

  static PARTS = {
    toolbar: { template: `${TEMPLATE_PATH}/feat-selector-toolbar.hbs` },
    filters: {
      template: `${TEMPLATE_PATH}/feat-selector-filters.hbs`,
      scrollable: ['']
    },
    list: {
      template: `${TEMPLATE_PATH}/feat-selector-list.hbs`,
      scrollable: ['.lvlup-feat-list']
    },
    details: {
      template: `${TEMPLATE_PATH}/feat-selector-details.hbs`,
      scrollable: ['.details-scroll']
    }
  };

  get title() {
    return localize('selector.title', {
      group: this.slot.groupLabel,
      level: this.slot.level,
      actorName: this.wizard.actor?.name ?? ''
    });
  }

  /* -------------------------------------------- */

  #filtered() {
    const f = this.filters;
    const hidden = hiddenRarities();
    const search = f.search.trim().toLocaleLowerCase();
    const dedication = f.dedicationSearch.trim().toLocaleLowerCase();
    const isGeneral = this.slot.groupId === 'general';

    const list = this.candidates.filter((c) => {
      if (hidden.includes(c.rarity)) return false;
      if (!f.rarities.includes(c.rarity)) return false;
      if (search && !c.searchText.includes(search)) return false;
      if (f.minLevel !== null && c.effectiveLevel < f.minLevel) return false;
      if (f.maxLevel !== null && c.effectiveLevel > f.maxLevel) return false;
      if (this.hasClassFeats && c.isArchetype && !f.showArchetype) return false;
      if (isGeneral && f.hideSkillFeats && c.traits.includes('skill'))
        return false;
      if (f.skills.length && !f.skills.some((s) => c.skills.includes(s)))
        return false;
      if (f.hideUnmet && c.prereq?.status === 'unmet') return false;
      if (dedication) {
        const name = c.searchText;
        const prereqs = c.prerequisites.join(' ').toLocaleLowerCase();
        const granted = (c.grantedByName ?? '').toLocaleLowerCase();
        if (
          !name.includes(dedication) &&
          !prereqs.includes(dedication) &&
          !granted.includes(dedication)
        )
          return false;
      }
      return true;
    });

    const dir = f.sortOrder === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (f.sortBy === 'name')
        return dir * a.name.localeCompare(b.name, game.i18n.lang);
      return (
        dir * (a.effectiveLevel - b.effectiveLevel) ||
        a.name.localeCompare(b.name, game.i18n.lang)
      );
    });
    return list;
  }

  /** Only the base context is shared; each part adds what it renders */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const f = this.filters;
    const takenElsewhere = new Set(
      Object.entries(this.wizard.selection.feats)
        .filter(([key, pick]) => pick && key !== this.slot.key)
        .map(([, pick]) => pick.uuid)
    );
    return Object.assign(context, {
      slot: this.slot,
      filters: f,
      prereqEnabled:
        !!this.prereqContext &&
        game.settings.get(MODULE_ID, 'prerequisite-mode') !== 'off',
      takenElsewhere
    });
  }

  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);
    const f = this.filters;
    const hidden = hiddenRarities();

    if (partId === 'toolbar') {
      const commonOnly = f.rarities.length === 1 && f.rarities[0] === 'common';
      const chips = [
        context.prereqEnabled && {
          key: 'hideUnmet',
          label: localize('menu.filters.onlyFit'),
          pressed: f.hideUnmet,
          icon: 'fa-check'
        },
        {
          key: 'commonOnly',
          label: localize('menu.filters.commonOnly'),
          pressed: commonOnly
        },
        this.hasClassFeats &&
          this.hasArchetypeFeats && {
            key: 'showArchetype',
            label: localize('menu.filters.archetypeFeats'),
            pressed: f.showArchetype
          },
        this.slot.groupId === 'general' && {
          key: 'hideSkillFeats',
          label: localize('menu.filters.hideSkillFeats'),
          pressed: f.hideSkillFeats
        }
      ].filter(Boolean);
      const sortKey =
        Object.entries(SORTS).find(
          ([, s]) => s.sortBy === f.sortBy && s.sortOrder === f.sortOrder
        )?.[0] ?? 'level-desc';
      context.chips = chips;
      context.sorts = Object.entries(SORTS).map(([value, s]) => ({
        value,
        label: localize(`selector.sort.${s.name}`),
        selected: value === sortKey
      }));
    }

    if (partId === 'filters') {
      const quick = (value) => f.minLevel === value && f.maxLevel === value;
      context.levelButtons = this.levels.map((level) => ({
        level,
        pressed: quick(level)
      }));
      context.allLevelsPressed = f.minLevel === null && f.maxLevel === null;
      context.rangeActive =
        (f.minLevel !== null || f.maxLevel !== null) &&
        !(f.minLevel === f.maxLevel && this.levels.includes(f.minLevel));
      context.rarities = RARITIES.filter((r) => !hidden.includes(r)).map((r) => ({
        key: r,
        label: game.i18n.localize(CONFIG.PF2E.rarityTraits?.[r] ?? r),
        checked: f.rarities.includes(r)
      }));
      const ranked = [...this.skillCounts.entries()]
        .sort((a, b) => b[1] - a[1] || skillLabel(a[0]).localeCompare(skillLabel(b[0])))
        .map(([slug, count]) => ({
          slug,
          label: skillLabel(slug),
          count,
          checked: f.skills.includes(slug)
        }));
      const shown = this.showAllSkills
        ? ranked
        : ranked.filter((s, i) => i < VISIBLE_SKILLS || s.checked);
      context.skills = shown;
      context.skillTotal = ranked.length;
      context.canToggleSkills = ranked.length > VISIBLE_SKILLS;
      context.allSkills = this.showAllSkills;
      context.showSkillFilter = ranked.length > 0;
      context.showDedicationSearch = this.hasArchetypeFeats;
      context.hiddenNote = hidden.length > 0;
    }

    if (partId === 'list') {
      const list = this.#filtered();
      context.total = this.candidates.length;
      context.count = list.length;
      context.unmetShown = context.prereqEnabled && !f.hideUnmet;
      const rows = list.map((c) => {
        const pill = context.prereqEnabled
          ? prereqPill(c.prereq, c.prerequisites, true)
          : null;
        return {
          ...c,
          highlighted: c.uuid === this.highlighted,
          takenElsewhere:
            context.takenElsewhere.has(c.uuid) && (c.maxTakable ?? 1) <= 1,
          rarityLabel:
            c.rarity !== 'common'
              ? game.i18n.localize(CONFIG.PF2E.rarityTraits?.[c.rarity] ?? c.rarity)
              : null,
          subtitle: this.#subtitle(c),
          glyph: glyphView(c.actionType, c.actions),
          pill,
          unmet: c.prereq?.status === 'unmet',
          pillTooltip: pill ? prereqTooltip(c.prereq, escapeHTML) : ''
        };
      });
      // Level headers only make sense when the list is sorted by level
      if (f.sortBy === 'level') {
        const groups = [];
        for (const row of rows) {
          const last = groups.at(-1);
          if (last?.level === row.effectiveLevel) last.feats.push(row);
          else groups.push({ level: row.effectiveLevel, feats: [row] });
        }
        context.groups = groups;
      } else {
        context.groups = rows.length ? [{ level: null, feats: rows }] : [];
      }
    }

    if (partId === 'details') {
      const feat = this.candidates.find((c) => c.uuid === this.highlighted) ?? null;
      context.feat = feat;
      if (feat) {
        context.description = await this.#description(feat.uuid);
        const pill = context.prereqEnabled
          ? prereqPill(feat.prereq, feat.prerequisites)
          : null;
        context.prereqStatus = pill?.status ?? null;
        context.prereqLines = (feat.prereq?.results ?? []).map((r) => ({
          ...r,
          icon: this.#statusIcon(r.status)
        }));
        context.rarityLabel =
          feat.rarity !== 'common'
            ? game.i18n.localize(CONFIG.PF2E.rarityTraits?.[feat.rarity] ?? feat.rarity)
            : null;
        context.traitLabels = feat.traits.map((t) =>
          game.i18n.localize(CONFIG.PF2E.featTraits?.[t] ?? t)
        );
        context.glyph = glyphView(feat.actionType, feat.actions);
        context.featTakenElsewhere =
          context.takenElsewhere.has(feat.uuid) && (feat.maxTakable ?? 1) <= 1;
      }
    }
    return context;
  }

  #statusIcon(status) {
    return (
      {
        met: 'fa-circle-check',
        unmet: 'fa-circle-xmark',
        unknown: 'fa-circle-question'
      }[status] ?? 'fa-circle-question'
    );
  }

  /** The skill a feat is about, or failing that its first meaningful trait */
  #subtitle(c) {
    if (c.skills.length) return skillLabel(c.skills[0]);
    const trait =
      c.traits.find((t) => !['skill', 'general'].includes(t)) ?? c.traits[0];
    return trait
      ? game.i18n.localize(CONFIG.PF2E.featTraits?.[trait] ?? trait)
      : '';
  }

  async #description(uuid) {
    if (this.descriptions.has(uuid)) return this.descriptions.get(uuid);
    const doc = await fromUuid(uuid).catch(() => null);
    // Third-party compendiums are not trusted: sanitize before enriching
    const raw = foundry.utils.cleanHTML(doc?.system?.description?.value ?? '');
    const html = doc
      ? await enrichHTML(raw, {
          relativeTo: doc,
          rollData: this.wizard.actor.getRollData?.()
        })
      : '';
    this.descriptions.set(uuid, html);
    return html;
  }

  _attachPartListeners(partId, htmlElement, options) {
    super._attachPartListeners(partId, htmlElement, options);
    if (partId !== 'toolbar' && partId !== 'filters') return;
    const root = htmlElement;
    const on = (selector, event, fn) =>
      root.querySelectorAll(selector).forEach((el) => el.addEventListener(event, fn));
    const refresh = foundry.utils.debounce(() => this.#refreshList(), 150);

    on('[data-filter="search"]', 'input', (e) => {
      this.filters.search = e.currentTarget.value;
      refresh();
    });
    on('[data-filter="dedicationSearch"]', 'input', (e) => {
      this.filters.dedicationSearch = e.currentTarget.value;
      refresh();
    });
    on('[data-filter="minLevel"], [data-filter="maxLevel"]', 'input', (e) => {
      const value = parseInt(e.currentTarget.value, 10);
      this.filters[e.currentTarget.dataset.filter] = Number.isFinite(value)
        ? value
        : null;
      refresh();
    });
    on('[data-filter="sort"]', 'change', (e) => {
      const sort = SORTS[e.currentTarget.value];
      if (!sort) return;
      this.filters.sortBy = sort.sortBy;
      this.filters.sortOrder = sort.sortOrder;
      this.#refreshList();
    });
    on('[data-filter="rarity"]', 'change', (e) => {
      const r = e.currentTarget.value;
      this.filters.rarities = e.currentTarget.checked
        ? [...new Set([...this.filters.rarities, r])]
        : this.filters.rarities.filter((x) => x !== r);
      this.#refreshList(['toolbar', 'list']);
    });
    on('[data-filter="skill"]', 'change', (e) => {
      const s = e.currentTarget.value;
      this.filters.skills = e.currentTarget.checked
        ? [...new Set([...this.filters.skills, s])]
        : this.filters.skills.filter((x) => x !== s);
      this.#refreshList();
    });
    // Focus the search box when the picker opens, not on every re-render
    if (partId === 'toolbar' && this.#focusSearch) {
      this.#focusSearch = false;
      root.querySelector('[data-filter="search"]')?.focus();
    }
  }

  #refreshList(parts = ['list']) {
    rememberedFilters.set(this.slot.groupId, this.filters);
    this.render({ parts });
  }

  /* -------------------------------------------- */

  static async #onHighlight(event, target) {
    const uuid = target.closest('[data-uuid]')?.dataset.uuid;
    if (!uuid) return;
    if (event.detail > 1) return FeatSelector.#onSelect.call(this, event, target);
    this.highlighted = uuid;
    for (const row of this.element.querySelectorAll('.feat-row.highlighted')) {
      row.classList.remove('highlighted');
      row.querySelector('[aria-current]')?.removeAttribute('aria-current');
    }
    const row = target.closest('.feat-row');
    row?.classList.add('highlighted');
    target.setAttribute('aria-current', 'true');
    await this.render({ parts: ['details'] });
  }

  static #onSelect(event, target) {
    const uuid = target.closest('[data-uuid]')?.dataset.uuid ?? this.highlighted;
    const candidate = this.candidates.find((c) => c.uuid === uuid);
    if (!candidate) return;
    rememberedFilters.set(this.slot.groupId, this.filters);
    const { prereq, skills, ...pick } = candidate;
    this.wizard.selectFeat(this.slot.key, pick);
    this.close();
  }

  static async #onSendToChat(event, target) {
    event.stopPropagation();
    const uuid = target.closest('[data-uuid]')?.dataset.uuid;
    if (uuid) await sendFeatToChat(uuid, this.wizard.actor);
  }

  /** Toggle chips of the toolbar (aria-pressed buttons) */
  static #onToggleFilter(event, target) {
    const key = target.dataset.filter;
    const f = this.filters;
    if (key === 'commonOnly') {
      const commonOnly = f.rarities.length === 1 && f.rarities[0] === 'common';
      f.rarities = commonOnly
        ? RARITIES.filter((r) => !hiddenRarities().includes(r))
        : ['common'];
    } else if (['hideUnmet', 'showArchetype', 'hideSkillFeats'].includes(key)) {
      f[key] = !f[key];
    } else return;
    this.#refreshList(['toolbar', 'filters', 'list']);
  }

  /** Level quick buttons: one level, or all of them */
  static #onSetLevel(event, target) {
    const level = target.dataset.level;
    const value = level === '' || level === undefined ? null : Number(level);
    const f = this.filters;
    const same = value !== null && f.minLevel === value && f.maxLevel === value;
    f.minLevel = same ? null : value;
    f.maxLevel = same ? null : value;
    this.#refreshList(['filters', 'list']);
  }

  static #onToggleAllSkills() {
    this.showAllSkills = !this.showAllSkills;
    this.render({ parts: ['filters'] });
  }

  static #onResetFilters() {
    rememberedFilters.delete(this.slot.groupId);
    this.filters = this.#defaultFilters();
    this.render({ parts: ['toolbar', 'filters', 'list'] });
  }
}
