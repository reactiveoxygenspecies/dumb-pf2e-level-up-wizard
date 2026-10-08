import { MODULE_ID } from './constants.js';
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

const S = 'PF2E_LEVEL_UP_WIZARD.settings';

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

  // Replaced by 'hidden-rarities'; kept registered so its stored value can be migrated
  game.settings.register(MODULE_ID, 'hide-uncommon-feats', {
    scope: 'world',
    config: false,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, 'settings-version', {
    scope: 'world',
    config: false,
    type: Number,
    default: 0
  });
};

/** One-time migration of settings from the upstream module (GM only) */
export const migrateSettings = async () => {
  if (!game.user.isGM) return;
  const version = game.settings.get(MODULE_ID, 'settings-version');
  if (version >= 1) return;

  if (game.settings.get(MODULE_ID, 'hide-uncommon-feats')) {
    await game.settings.set(MODULE_ID, 'hidden-rarities', 'uncommon');
  }
  await game.settings.set(MODULE_ID, 'settings-version', 1);
  console.log(`${MODULE_ID} | ${localize('notifications.settingsMigrated')}`);
};
