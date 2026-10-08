import { MODULE_ID, TEMPLATE_PATH } from '../constants.js';
import {
  buildIndexLookups,
  createPreviewActor,
  getCandidatesForSlot,
  getDedications,
  getFeatSlots,
  getOwnedFeatKeys,
  loadGrantedArchetypeFeats
} from '../data/featSlots.js';
import { getFeatIndex } from '../data/featIndex.js';
import {
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
  maxSkillRankForLevel
} from '../data/plan.js';
import { applyLevelUp, canUndo, getHistory, undoLastLevelUp } from '../data/apply.js';
import {
  applyPendingChoices,
  buildPrereqContext,
  evaluatePrerequisites
} from '../helpers/prerequisites.js';
import { escapeHTML, localize, rankLabel } from '../helpers/utility.js';
import { FeatSelector } from './FeatSelector.js';
import { LevelUpHistory } from './LevelUpHistory.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const RANK_CLASSES = ['untrained', 'trained', 'expert', 'master', 'legendary'];

export class LevelUpWizard extends HandlebarsApplicationMixin(ApplicationV2) {
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
      potency: {}
    };
    this.showMissed = false;
    this.submitting = false;
  }

  static DEFAULT_OPTIONS = {
    classes: [MODULE_ID, 'level-up-wizard'],
    tag: 'form',
    window: {
      icon: 'fa-solid fa-hat-wizard',
      resizable: true
    },
    position: { width: 660, height: 'auto' },
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
      openHistory: LevelUpWizard.#onOpenHistory,
      undo: LevelUpWizard.#onUndo
    }
  };

  static PARTS = {
    form: {
      template: `${TEMPLATE_PATH}/level-up-wizard.hbs`,
      scrollable: ['']
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

  _getHeaderControls() {
    const controls = super._getHeaderControls();
    controls.push({
      icon: 'fa-solid fa-clock-rotate-left',
      label: 'PF2E_LEVEL_UP_WIZARD.history.title',
      action: 'openHistory',
      visible: () => getHistory(this.actor).length > 0
    });
    return controls;
  }

  /* -------------------------------------------- */
  /*  Plan                                        */
  /* -------------------------------------------- */

  /** Everything that depends only on the actor, computed once when the wizard opens */
  async #buildPlan() {
    const actor = this.actor;
    const { previousLevel, targetLevel } = this;
    const preview = createPreviewActor(actor, targetLevel);

    const [index] = await Promise.all([getFeatIndex(), loadGrantedArchetypeFeats()]);
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
      languageSlots: 0
    };

    this.selection.skillIncreases = new Array(plan.skillIncreaseCount).fill('');
    for (const { set } of boostSets) this.selection.boosts[set] = [];
    return plan;
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
    return getCandidatesForSlot(slot, plan.index, {
      ownedKeys,
      dedications: getDedications(this.actor),
      ...plan.lookups
    });
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

    // Feats
    const featRow = (slot, required) => {
      const pick = sel.feats[slot.key] ?? null;
      let prereq = null;
      if (pick && prereqCtx && prereqMode !== 'off') {
        prereq = evaluatePrerequisites(pick.prerequisites, prereqCtx);
      }
      return {
        ...slot,
        required,
        pick,
        prereq: prereq ? this.#prereqBadge(prereq) : null,
        placeholder: slot.placeholder ?? localize('menu.dropdown.placeholder')
      };
    };
    const featSlots = plan.slots.current.map((s) => featRow(s, true));
    const missedSlots = plan.slots.missed.map((s) => featRow(s, false));

    // Attribute boosts
    const boosts = plan.boostSets.length
      ? describeBoosts(this.actor, plan.boostSets, sel.boosts)
      : null;
    const intGain = boosts?.intGain ?? 0;
    this.#syncArray('intSkills', intGain);
    plan.languageSlots = getOpenLanguageSlots(this.actor, intGain);
    this.#syncArray('languages', plan.languageSlots);

    // Skills
    const skillRow = (value, index, { forTraining = false } = {}) => {
      const taken = new Set(
        [...sel.skillIncreases, ...sel.intSkills].filter((s) => s && s !== value)
      );
      const options = plan.skillOptions
        .filter((s) =>
          forTraining ? s.rank === 0 && !s.isLore : s.rank < plan.maxSkillRank
        )
        .map((s) => ({
          value: s.slug,
          label: describeSkillOption(s),
          rankClass: `rank-${RANK_CLASSES[s.rank]}`,
          disabled: taken.has(s.slug),
          selected: s.slug === value
        }));
      return { index, value, options };
    };
    const skillIncreases = sel.skillIncreases.map((v, i) => skillRow(v, i));
    const intSkills = sel.intSkills.map((v, i) => skillRow(v, i, { forTraining: true }));

    const languages = sel.languages.map((value, index) => ({
      index,
      value,
      options: plan.languageOptions.map((l) => ({
        value: l.slug,
        label: l.rarity === 'common' ? l.label : `${l.label} (${game.i18n.localize(CONFIG.PF2E.rarityTraits?.[l.rarity] ?? l.rarity)})`,
        disabled: sel.languages.includes(l.slug) && l.slug !== value,
        selected: l.slug === value
      }))
    }));

    // Skill potency (ABP)
    let potency = null;
    if (plan.potency) {
      const select = (key, list) =>
        list
          ? {
              key,
              label: localize(`menu.skillPotency.${key}`),
              value: sel.potency[key] ?? '',
              options: list.map((s) => ({
                value: s.slug,
                label: describeSkillOption(s, 0),
                selected: s.slug === sel.potency[key],
                disabled: Object.entries(sel.potency).some(([k, v]) => k !== key && v === s.slug)
              }))
            }
          : null;
      potency = {
        current: plan.potency.current,
        selects: [
          select('newBoost', plan.potency.newBoost),
          select('upgradeTo2', plan.potency.upgradeTo2),
          select('upgradeTo3', plan.potency.upgradeTo3)
        ].filter(Boolean)
      };
    }

    // Validation
    const missing = [];
    for (const slot of featSlots) if (!slot.pick) missing.push(`${slot.groupLabel} (${slot.label})`);
    if (sel.skillIncreases.some((s) => !s)) missing.push(localize('menu.skillIncreases.header'));
    for (const set of boosts?.sets ?? []) {
      if (!set.complete) missing.push(localize('menu.attributeBoosts.header'));
    }
    if (potency?.selects.some((s) => !s.value)) missing.push(localize('menu.skillPotency.header'));
    if (sel.intSkills.some((s) => !s)) missing.push(localize('menu.intBonus.skill'));

    const canSubmit = !this.submitting && (!requireAll || missing.length === 0);

    return Object.assign(context, {
      actor: this.actor,
      actorName: this.actor.name,
      targetLevel: plan.targetLevel,
      previousLevel: plan.previousLevel,
      levelJump: plan.levelAlreadyApplied && plan.targetLevel - plan.previousLevel > 1,
      classJournals: plan.classJournals,
      featSlots,
      missedSlots,
      showMissed: this.showMissed,
      skillIncreases,
      maxSkillRankLabel: rankLabel(plan.maxSkillRank),
      boosts,
      manualAttributes: plan.manualAttributes,
      gradualBoosts: !!game.pf2e?.settings?.variants?.gab,
      intSkills,
      languages,
      potency,
      classFeatures: plan.classFeatures,
      spellcasting: plan.spellcasting,
      missing: [...new Set(missing)],
      requireAll,
      canSubmit,
      canUndo: canUndo(this.actor),
      submitting: this.submitting,
      hasNothingToChoose:
        !featSlots.length &&
        !skillIncreases.length &&
        !boosts?.sets.length &&
        !potency &&
        !languages.length
    });
  }

  #prereqBadge(result) {
    const icons = { met: 'fa-circle-check', unmet: 'fa-circle-xmark', unknown: 'fa-circle-question' };
    const lines = (result.results ?? [])
      .map((r) => `${r.status === 'met' ? '✓' : r.status === 'unmet' ? '✗' : '?'} ${escapeHTML(r.text)}`)
      .join('<br>');
    return {
      status: result.status,
      icon: icons[result.status] ?? icons.unknown,
      tooltip: `<strong>${localize(`prerequisites.${result.status}`)}</strong>${lines ? `<br>${lines}` : ''}`
    };
  }

  /** Resize a selection array to `length`, keeping existing choices */
  #syncArray(key, length) {
    const current = this.selection[key];
    if (current.length === length) return;
    this.selection[key] = Array.from({ length }, (_, i) => current[i] ?? '');
  }

  _attachPartListeners(partId, htmlElement, options) {
    super._attachPartListeners(partId, htmlElement, options);
    if (partId !== 'form') return;
    htmlElement.querySelectorAll('select[data-choice]').forEach((select) => {
      select.addEventListener('change', (event) => this.#onChoiceChange(event));
    });
  }

  #onChoiceChange(event) {
    const { choice, index } = event.currentTarget.dataset;
    const value = event.currentTarget.value;
    const sel = this.selection;
    switch (choice) {
      case 'skillIncrease':
        sel.skillIncreases[Number(index)] = value;
        break;
      case 'intSkill':
        sel.intSkills[Number(index)] = value;
        break;
      case 'language':
        sel.languages[Number(index)] = value;
        break;
      case 'potency':
        sel.potency[index] = value;
        break;
    }
    this.render();
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
    // Guard the whole submit, including the confirmation dialog, against double clicks
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
    const requireAll = context.requireAll;
    if (requireAll && context.missing.length) {
      ui.notifications.warn(localize('notifications.incomplete'));
      return;
    }

    const skipped = context.missing.length
      ? `<p>${localize('menu.confirmDialog.skipped')}</p><ul>${context.missing
          .map((m) => `<li>${escapeHTML(m)}</li>`)
          .join('')}</ul>`
      : '';
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: localize('menu.confirmDialog.title'), icon: 'fa-solid fa-hat-wizard' },
      content: `<p>${localize('menu.confirmDialog.content', {
        actorName: escapeHTML(this.actor.name),
        targetLevel: this.targetLevel
      })}</p>${skipped}`,
      modal: true,
      renderOptions: { window: { windowId: this.window.windowId } }
    });
    if (!confirmed) return;

    if (!this.levelAlreadyApplied && this.actor.level !== this.previousLevel) {
      ui.notifications.error(localize('notifications.levelChanged'));
      return this.close();
    }

    this.submitting = true;
    await this.render({ parts: ['footer'] });
    const selection = {
      ...this.selection,
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
