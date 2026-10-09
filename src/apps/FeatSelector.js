import { MODULE_ID, TEMPLATE_PATH } from '../constants.js';
import { sendFeatToChat } from '../helpers/chat.js';
import { enrichHTML, escapeHTML, localize } from '../helpers/utility.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const RARITIES = ['common', 'uncommon', 'rare', 'unique'];

/** Filters are remembered per feat group for the rest of the session */
const rememberedFilters = new Map();

const hiddenRarities = () => {
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
    const { wizard, slot, candidates, prereqContext, currentPick, ...rest } = options;
    super({ ...rest, id: `${wizard.id}-feats` });
    this.wizard = wizard;
    this.slot = slot;
    this.prereqContext = prereqContext;
    this.highlighted = currentPick?.uuid ?? null;
    this.descriptions = new Map();

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
    this.filters = rememberedFilters.get(this.slot.groupId) ?? this.#defaultFilters();
  }

  #defaultFilters() {
    const sort = game.settings.get(MODULE_ID, 'feat-sort-method').toLowerCase().split('_');
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
    classes: [MODULE_ID, 'feat-selector'],
    window: { icon: 'fa-solid fa-medal', resizable: true },
    position: { width: 860, height: 640 },
    actions: {
      highlight: FeatSelector.#onHighlight,
      select: FeatSelector.#onSelect,
      sendToChat: FeatSelector.#onSendToChat,
      toggleSortOrder: FeatSelector.#onToggleSortOrder,
      resetFilters: FeatSelector.#onResetFilters
    }
  };

  static PARTS = {
    filters: { template: `${TEMPLATE_PATH}/feat-selector-filters.hbs`, scrollable: [''] },
    list: { template: `${TEMPLATE_PATH}/feat-selector-list.hbs`, scrollable: ['.feat-list'] },
    details: { template: `${TEMPLATE_PATH}/feat-selector-details.hbs`, scrollable: [''] }
  };

  get title() {
    return localize('selector.title', {
      group: this.slot.groupLabel,
      level: this.slot.level
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
      if (isGeneral && f.hideSkillFeats && c.traits.includes('skill')) return false;
      if (f.skills.length && !f.skills.some((s) => c.skills.includes(s))) return false;
      if (f.hideUnmet && c.prereq?.status === 'unmet') return false;
      if (dedication) {
        const name = c.searchText;
        const prereqs = c.prerequisites.join(' ').toLocaleLowerCase();
        const granted = (c.grantedByName ?? '').toLocaleLowerCase();
        if (!name.includes(dedication) && !prereqs.includes(dedication) && !granted.includes(dedication))
          return false;
      }
      return true;
    });

    const dir = f.sortOrder === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (f.sortBy === 'name') return dir * a.name.localeCompare(b.name, game.i18n.lang);
      return dir * (a.effectiveLevel - b.effectiveLevel) || a.name.localeCompare(b.name, game.i18n.lang);
    });
    return list;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const hidden = hiddenRarities();
    const f = this.filters;
    const takenElsewhere = new Set(
      Object.entries(this.wizard.selection.feats)
        .filter(([key, pick]) => pick && key !== this.slot.key)
        .map(([, pick]) => pick.uuid)
    );
    return Object.assign(context, {
      slot: this.slot,
      filters: f,
      rarities: RARITIES.filter((r) => !hidden.includes(r)).map((r) => ({
        key: r,
        label: game.i18n.localize(CONFIG.PF2E.rarityTraits?.[r] ?? r),
        checked: f.rarities.includes(r)
      })),
      skills: skillMatchers().map((m) => ({
        slug: m.slug,
        label: game.i18n.localize(CONFIG.PF2E.skills[m.slug]?.label ?? m.slug),
        checked: f.skills.includes(m.slug)
      })),
      showArchetypeToggle: this.hasClassFeats && this.hasArchetypeFeats,
      showDedicationSearch: this.hasArchetypeFeats,
      showSkillFilter: ['skill', 'general'].includes(this.slot.groupId) || this.candidates.some((c) => c.skills.length),
      showHideSkillFeats: this.slot.groupId === 'general',
      prereqEnabled: !!this.prereqContext && game.settings.get(MODULE_ID, 'prerequisite-mode') !== 'off',
      takenElsewhere
    });
  }

  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);
    if (partId === 'list') {
      const list = this.#filtered();
      context.total = this.candidates.length;
      context.count = list.length;
      context.feats = list.map((c) => ({
        ...c,
        highlighted: c.uuid === this.highlighted,
        takenElsewhere: context.takenElsewhere.has(c.uuid) && (c.maxTakable ?? 1) <= 1,
        rarityLabel: c.rarity !== 'common' ? game.i18n.localize(CONFIG.PF2E.rarityTraits?.[c.rarity] ?? c.rarity) : null,
        prereqIcon: this.#prereqIcon(c.prereq),
        prereqTooltip: this.#prereqTooltip(c)
      }));
    }
    if (partId === 'details') {
      const feat = this.candidates.find((c) => c.uuid === this.highlighted) ?? null;
      context.feat = feat;
      if (feat) {
        context.description = await this.#description(feat.uuid);
        context.prereqTooltip = this.#prereqTooltip(feat);
        context.prereqLines = (feat.prereq?.results ?? []).map((r) => ({
          ...r,
          icon: this.#prereqIcon({ status: r.status })
        }));
        context.rarityLabel =
          feat.rarity !== 'common'
            ? game.i18n.localize(CONFIG.PF2E.rarityTraits?.[feat.rarity] ?? feat.rarity)
            : null;
        context.traitLabels = feat.traits.map((t) =>
          game.i18n.localize(CONFIG.PF2E.featTraits?.[t] ?? t)
        );
        context.featTakenElsewhere =
          context.takenElsewhere.has(feat.uuid) && (feat.maxTakable ?? 1) <= 1;
      }
    }
    return context;
  }

  #prereqIcon(prereq) {
    if (!prereq) return null;
    return {
      met: 'fa-solid fa-circle-check',
      unmet: 'fa-solid fa-circle-xmark',
      unknown: 'fa-solid fa-circle-question'
    }[prereq.status];
  }

  #prereqTooltip(c) {
    if (!c.prerequisites.length) return '';
    const lines = c.prereq?.results?.length
      ? c.prereq.results.map((r) => `${r.status === 'met' ? '✓' : r.status === 'unmet' ? '✗' : '?'} ${escapeHTML(r.text)}`)
      : c.prerequisites.map(escapeHTML);
    return `<strong>${localize('selector.prerequisites')}</strong><br>${lines.join('<br>')}`;
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
    if (partId !== 'filters') return;
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
      this.filters[e.currentTarget.dataset.filter] = Number.isFinite(value) ? value : null;
      refresh();
    });
    on('[data-filter="sortBy"]', 'change', (e) => {
      this.filters.sortBy = e.currentTarget.value;
      this.#refreshList();
    });
    on('[data-filter="rarity"]', 'change', (e) => {
      const r = e.currentTarget.value;
      this.filters.rarities = e.currentTarget.checked
        ? [...new Set([...this.filters.rarities, r])]
        : this.filters.rarities.filter((x) => x !== r);
      this.#refreshList();
    });
    on('[data-filter="skill"]', 'change', (e) => {
      const s = e.currentTarget.value;
      this.filters.skills = e.currentTarget.checked
        ? [...new Set([...this.filters.skills, s])]
        : this.filters.skills.filter((x) => x !== s);
      this.#refreshList();
    });
    for (const key of ['showArchetype', 'hideSkillFeats', 'hideUnmet']) {
      on(`[data-filter="${key}"]`, 'change', (e) => {
        this.filters[key] = e.currentTarget.checked;
        this.#refreshList();
      });
    }
    root.querySelector('[data-filter="search"]')?.focus();
  }

  #refreshList() {
    rememberedFilters.set(this.slot.groupId, this.filters);
    this.render({ parts: ['list'] });
  }

  /* -------------------------------------------- */

  static async #onHighlight(event, target) {
    const uuid = target.closest('[data-uuid]')?.dataset.uuid;
    if (!uuid) return;
    if (event.detail > 1) return FeatSelector.#onSelect.call(this, event, target);
    this.highlighted = uuid;
    this.element
      .querySelectorAll('.feat-row.highlighted')
      .forEach((el) => el.classList.remove('highlighted'));
    target.closest('.feat-row')?.classList.add('highlighted');
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

  static #onToggleSortOrder() {
    this.filters.sortOrder = this.filters.sortOrder === 'asc' ? 'desc' : 'asc';
    rememberedFilters.set(this.slot.groupId, this.filters);
    this.render({ parts: ['filters', 'list'] });
  }

  static #onResetFilters() {
    rememberedFilters.delete(this.slot.groupId);
    this.filters = this.#defaultFilters();
    this.render({ parts: ['filters', 'list'] });
  }
}
