import { MODULE_ID, ORIGINAL_MODULE_ID } from './constants.js';
import { invalidateFeatIndex } from './data/featIndex.js';
import { localize, openApplications } from './helpers/utility.js';

/** Re-render open character sheets (ApplicationV1 today, ApplicationV2 once the system migrates) */
export const rerenderCharacterSheets = () => {
  const sheets = [
    ...Object.values(ui.windows),
    ...openApplications()
  ].filter((app) => app.actor?.type === 'character' && app.rendered);
  for (const sheet of new Set(sheets)) sheet.render(false);
};

/** Header buttons are built once per ApplicationV1 window, so moving the button needs a fresh window */
const reopenCharacterSheets = async () => {
  const sheets = Object.values(ui.windows).filter(
    (app) => app.actor?.type === 'character' && app.rendered
  );
  for (const sheet of sheets) {
    await sheet.close();
    sheet.render(true);
  }
  rerenderCharacterSheets();
};

const rerenderWizards = () => {
  for (const app of openApplications()) {
    if (app.options.classes?.includes(MODULE_ID)) app.render();
  }
};

const choices = (base, keys) =>
  Object.fromEntries(keys.map(([value, key]) => [value, `${base}.${key}`]));

const S = 'NEXT_LEVEL_UP_WIZARD.settings';

export const registerSettings = () => {
  const register = (key, data) =>
    game.settings.register(MODULE_ID, key, {
      name: `${S}.${data.i18n}.name`,
      hint: `${S}.${data.i18n}.hint`,
      config: true,
      ...data
    });

  register('show-level-up-button', {
    i18n: 'showButton',
    scope: 'world',
    type: Boolean,
    default: true,
    requiresReload: true
  });

  register('button-placement', {
    i18n: 'buttonPlacement',
    scope: 'client',
    type: String,
    default: 'CHAR_HEADER_SMALL',
    choices: choices(`${S}.buttonPlacement.options`, [
      ['CHAR_HEADER', 'charHeaderLarge'],
      ['CHAR_HEADER_SMALL', 'charHeaderSmall'],
      ['WINDOW_HEADER', 'windowHeader']
    ]),
    onChange: reopenCharacterSheets
  });

  register('disable-level-input', {
    i18n: 'disableLevelInput',
    scope: 'world',
    type: Boolean,
    default: false,
    onChange: rerenderCharacterSheets
  });

  register('xp-enforcement', {
    i18n: 'xpEnforcement',
    scope: 'world',
    type: Boolean,
    default: false,
    onChange: rerenderCharacterSheets
  });

  register('require-all-choices', {
    i18n: 'requireAllChoices',
    scope: 'world',
    type: Boolean,
    default: true,
    onChange: rerenderWizards
  });

  register('allow-player-undo', {
    i18n: 'allowPlayerUndo',
    scope: 'world',
    type: Boolean,
    default: true
  });

  register('prerequisite-mode', {
    i18n: 'prerequisiteMode',
    scope: 'world',
    type: String,
    default: 'show',
    choices: choices(`${S}.prerequisiteMode.options`, [
      ['show', 'show'],
      ['off', 'off']
    ]),
    onChange: rerenderWizards
  });

  register('hide-unmet-prerequisites', {
    i18n: 'hideUnmetPrerequisites',
    scope: 'client',
    type: Boolean,
    default: false
  });

  register('hidden-rarities', {
    i18n: 'hiddenRarities',
    scope: 'world',
    type: String,
    default: 'none',
    choices: choices(`${S}.hiddenRarities.options`, [
      ['none', 'none'],
      ['rare', 'rare'],
      ['uncommon', 'uncommon']
    ]),
    onChange: rerenderWizards
  });

  register('feat-sort-method', {
    i18n: 'sortMethod',
    scope: 'client',
    type: String,
    default: 'LEVEL_DESC',
    choices: choices(`${S}.sortMethod.options`, [
      ['LEVEL_DESC', 'levelDesc'],
      ['LEVEL_ASC', 'levelAsc'],
      ['ALPHA_ASC', 'alphaAsc'],
      ['ALPHA_DESC', 'alphaDesc']
    ])
  });

  register('skill-increase-info', {
    i18n: 'skillInfo',
    scope: 'client',
    type: String,
    default: 'NAME_WITH_MOD_AND_RANK',
    choices: choices(`${S}.skillInfo.options`, [
      ['NAME_ONLY', 'nameOnly'],
      ['NAME_WITH_MOD', 'nameWithMod'],
      ['NAME_WITH_RANK', 'nameWithRank'],
      ['NAME_WITH_MOD_AND_RANK', 'nameWithModAndRank']
    ]),
    onChange: rerenderWizards
  });

  register('send-gm-whispers', {
    i18n: 'sendGMWhispers',
    scope: 'world',
    type: Boolean,
    default: false
  });

  register('additional-feat-compendiums', {
    i18n: 'additionalCompendiums',
    scope: 'world',
    type: String,
    default: '',
    onChange: invalidateFeatIndex
  });

  game.settings.register(MODULE_ID, 'settings-version', {
    scope: 'world',
    config: false,
    type: Number,
    default: 0
  });

  game.settings.register(MODULE_ID, 'client-settings-version', {
    scope: 'client',
    config: false,
    type: Number,
    default: 0
  });
};

/* -------------------------------------------- */
/*  Migration from the original module          */
/* -------------------------------------------- */

/** Settings with the same key and meaning in the original PF2e Level-Up Wizard */
const ORIGINAL_WORLD_SETTINGS = [
  'show-level-up-button',
  'disable-level-input',
  'xp-enforcement',
  'send-gm-whispers',
  'additional-feat-compendiums'
];
const ORIGINAL_CLIENT_SETTINGS = ['button-placement', 'feat-sort-method', 'skill-increase-info'];

/** A stored value of the original module, or undefined if it was never changed from its default */
const readOriginal = (scope, key) => {
  const id = `${ORIGINAL_MODULE_ID}.${key}`;
  const raw =
    scope === 'world'
      ? game.settings.storage.get('world')?.getItem(id)
      : game.settings.storage.get('client')?.getItem(id);
  if (raw === null || raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const copyOriginal = async (key, scope) => {
  const value = readOriginal(scope, key);
  if (value === undefined) return false;
  const setting = game.settings.settings.get(`${MODULE_ID}.${key}`);
  if (setting?.choices && !(value in setting.choices)) return false;
  await game.settings.set(MODULE_ID, key, value);
  return true;
};

/**
 * Carry settings over from the original module the first time this one runs. World settings are
 * copied by the first GM to log in; client settings by each user on their own browser.
 */
export const migrateSettings = async () => {
  if (game.settings.get(MODULE_ID, 'client-settings-version') < 1) {
    for (const key of ORIGINAL_CLIENT_SETTINGS) await copyOriginal(key, 'client');
    await game.settings.set(MODULE_ID, 'client-settings-version', 1);
  }

  if (!game.user.isGM || game.settings.get(MODULE_ID, 'settings-version') >= 1) return;
  const copied = [];
  for (const key of ORIGINAL_WORLD_SETTINGS) {
    if (await copyOriginal(key, 'world')) copied.push(key);
  }
  // The original's single "hide rare and uncommon feats" switch became a rarity choice (#94)
  if (readOriginal('world', 'hide-uncommon-feats') === true) {
    await game.settings.set(MODULE_ID, 'hidden-rarities', 'uncommon');
    copied.push('hide-uncommon-feats');
  }
  await game.settings.set(MODULE_ID, 'settings-version', 1);
  if (copied.length) {
    console.log(`${MODULE_ID} | ${localize('notifications.settingsMigrated')}`, copied);
  }
};

/** Both modules add a hat to the sheet and react to level changes; running both is confusing */
export const warnIfOriginalActive = () => {
  if (!game.user.isGM || !game.modules.get(ORIGINAL_MODULE_ID)?.active) return;
  ui.notifications.warn(localize('notifications.originalActive'), { permanent: true });
};
