import { COMPANION_CLASSES, MODULE_ID } from './constants.js';
import { openLevelUpWizard } from './apps/LevelUpWizard.js';
import { xpInfo } from './data/plan.js';
import { getHistory } from './data/apply.js';
import { LevelUpHistory } from './apps/LevelUpHistory.js';
import { localize } from './helpers/utility.js';

/** Characters the wizard can level: has a class, is not a companion/eidolon */
export const validateActor = (actor, { notify = true, levelAlreadyApplied = false } = {}) => {
  const fail = (key) => {
    if (notify) ui.notifications.error(localize(`notifications.${key}`));
    return false;
  };
  if (actor?.type !== 'character') return false;
  if (!actor.class) return fail('missingClass');
  const cls = actor.class;
  const ids = [cls.slug, cls.name, cls.flags?.babele?.originalName].filter(Boolean);
  if (ids.some((id) => COMPANION_CLASSES.includes(id))) return fail('companionClass');
  if (!levelAlreadyApplied && actor.level >= 20) return fail('maxLevel');
  return true;
};

export const renderWizard = (actor, options = {}) => {
  if (!validateActor(actor, { levelAlreadyApplied: options.levelAlreadyApplied })) return null;
  return openLevelUpWizard(actor, options);
};

const hasEnoughXP = (actor) => {
  if (!game.settings.get(MODULE_ID, 'xp-enforcement')) return true;
  const { value, max } = xpInfo(actor);
  return value >= max;
};

/** Element roots of a render hook's `html` (jQuery for ApplicationV1, an element for ApplicationV2) */
const toRoots = (html) => {
  if (!html) return [];
  if (html.nodeType === Node.ELEMENT_NODE) return [html];
  return Array.from(html).filter((n) => n?.nodeType === Node.ELEMENT_NODE);
};

const queryAll = (roots, selector) =>
  roots.flatMap((root) => [
    ...(root.matches(selector) ? [root] : []),
    ...root.querySelectorAll(selector)
  ]);

export const openHistory = (actor) =>
  new LevelUpHistory({ actor }).render({ force: true });

/**
 * Add the wizard button to the PF2e character sheet. The sheet is still an ApplicationV1 sheet in
 * PF2e 8.x, so `html` is jQuery; both shapes are accepted.
 * Left click opens the wizard, right click opens the level-up history (and undo).
 */
export const onRenderCharacterSheet = (sheet, html) => {
  const actor = sheet.actor;
  const roots = toRoots(html);
  if (!roots.length || actor?.type !== 'character' || !actor.isOwner) return;

  queryAll(roots, '.level-up-wizard-button').forEach((el) => el.remove());

  // Lock the level field regardless of XP so the wizard stays the way to level (upstream #82)
  if (game.settings.get(MODULE_ID, 'disable-level-input')) {
    for (const input of queryAll(roots, 'input[name="system.details.level.value"]')) {
      input.disabled = true;
      input.dataset.tooltip = localize('button.levelLocked');
    }
  }

  const placement = game.settings.get(MODULE_ID, 'button-placement');
  if (placement === 'WINDOW_HEADER' || !actor.class) return;

  const atMax = actor.level >= 20;
  const enough = hasEnoughXP(actor);
  const { value, max } = xpInfo(actor);
  const ready = enough && !atMax;
  const hasHistory = getHistory(actor).length > 0;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = `level-up-wizard-button ${placement === 'CHAR_HEADER' ? 'large' : 'small'}`;
  button.classList.toggle('inactive', !ready);
  button.innerHTML = '<i class="fa-solid fa-hat-wizard"></i>';
  const tooltip = atMax
    ? localize('notifications.maxLevel')
    : enough
      ? localize('button-tooltip')
      : localize('button.needXp', { needed: max - value });
  button.dataset.tooltip = hasHistory
    ? `${tooltip}<br><em>${localize('button.historyHint')}</em>`
    : tooltip;
  button.setAttribute('aria-label', tooltip);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    if (ready) renderWizard(actor);
    else ui.notifications.warn(tooltip);
  });
  button.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (hasHistory) openHistory(actor);
  });

  const level = queryAll(roots, 'section.char-level')[0];
  if (level) {
    level.classList.add('level-up-wizard-anchor');
    level.prepend(button);
  }
};

/**
 * Header entries for the toolbar placement. ApplicationV1 builds header buttons only once per window,
 * so they are always present for owners and check XP / level when clicked instead.
 */
const headerEntries = (actor) => {
  if (game.settings.get(MODULE_ID, 'button-placement') !== 'WINDOW_HEADER') return [];
  if (actor?.type !== 'character' || !actor.isOwner) return [];
  return [
    {
      key: 'toolbarLabel',
      icon: 'fa-solid fa-hat-wizard',
      run: () => {
        if (actor.level >= 20) return ui.notifications.warn(localize('notifications.maxLevel'));
        if (!hasEnoughXP(actor)) {
          const { value, max } = xpInfo(actor);
          return ui.notifications.warn(localize('button.needXp', { needed: max - value }));
        }
        renderWizard(actor);
      }
    },
    {
      key: 'historyLabel',
      icon: 'fa-solid fa-clock-rotate-left',
      run: () => openHistory(actor)
    }
  ];
};

/** Toolbar placement uses the sheet's header-button hook, so it works in every sheet render */
export const onGetHeaderButtons = (sheet, buttons) => {
  for (const entry of headerEntries(sheet.actor).reverse()) {
    buttons.unshift({
      label: localize(`button.${entry.key}`),
      class: `level-up-wizard-${entry.key}`,
      icon: entry.icon,
      onclick: entry.run
    });
  }
};

/** ApplicationV2 sheets (future PF2e versions) use header controls instead */
export const onGetHeaderControls = (app, controls) => {
  for (const entry of headerEntries(app.actor ?? app.document).reverse()) {
    controls.unshift({
      icon: entry.icon,
      label: `PF2E_LEVEL_UP_WIZARD.button.${entry.key}`,
      onClick: entry.run
    });
  }
};

/* -------------------------------------------- */
/*  Automatic mode: open after a manual level change */
/* -------------------------------------------- */

export const onPreUpdateActor = (actor, changed, options) => {
  if (actor.type !== 'character') return;
  if (changed.system?.details?.level?.value === undefined) return;
  options[MODULE_ID] ??= {};
  options[MODULE_ID].previousLevel ??= actor.level;
};

export const onUpdateActor = (actor, changed, options, userId) => {
  if (actor.type !== 'character' || game.user.id !== userId) return;
  const moduleOptions = options[MODULE_ID] ?? {};
  if (moduleOptions.levelUp || moduleOptions.undo) return;
  const newLevel = changed.system?.details?.level?.value;
  const previousLevel = moduleOptions.previousLevel;
  if (typeof newLevel !== 'number' || typeof previousLevel !== 'number') return;
  if (newLevel <= previousLevel) return;
  if (!validateActor(actor, { notify: false, levelAlreadyApplied: true })) return;

  ui.notifications.info(localize('notifications.wizardStartup'));
  renderWizard(actor, { levelAlreadyApplied: true, previousLevel });
};
