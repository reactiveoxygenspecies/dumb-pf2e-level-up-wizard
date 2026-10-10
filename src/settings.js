import { MODULE_ID, ORIGINAL_MODULE_ID, PREVIOUS_MODULE_ID } from './constants.js';
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

const S = 'DUMB_LEVEL_UP_WIZARD.settings';

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

  game.settings.register(MODULE_ID, 'flags-version', {
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

/** A stored value of another module's setting, or undefined if it was never changed from its default */
const readStored = (moduleId, scope, key) => {
  const id = `${moduleId}.${key}`;
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

const readOriginal = (scope, key) => readStored(ORIGINAL_MODULE_ID, scope, key);

const copyFrom = async (moduleId, key, scope) => {
  const value = readStored(moduleId, scope, key);
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
    // Settings saved under this module's previous ID win over the original module's
    if (!(await copyPrevious('client')).length) {
      for (const key of ORIGINAL_CLIENT_SETTINGS) await copyFrom(ORIGINAL_MODULE_ID, key, 'client');
    }
    await game.settings.set(MODULE_ID, 'client-settings-version', 1);
  }

  if (!game.user.isGM || game.settings.get(MODULE_ID, 'settings-version') >= 1) return;
  const previous = await copyPrevious('world');
  if (previous.length) {
    await game.settings.set(MODULE_ID, 'settings-version', 1);
    console.log(`${MODULE_ID} | ${localize('notifications.settingsMigrated')}`, previous);
    return;
  }
  const copied = [];
  for (const key of ORIGINAL_WORLD_SETTINGS) {
    if (await copyFrom(ORIGINAL_MODULE_ID, key, 'world')) copied.push(key);
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

/** Copy every setting of a scope saved under the previous module ID; returns the copied keys */
const copyPrevious = async (scope) => {
  const copied = [];
  for (const setting of game.settings.settings.values()) {
    if (setting.namespace !== MODULE_ID || setting.scope !== scope) continue;
    if (setting.key.endsWith('settings-version')) continue;
    if (await copyFrom(PREVIOUS_MODULE_ID, setting.key, scope)) copied.push(setting.key);
  }
  return copied;
};

/**
 * Move level-up history and managed-entry markers saved under the previous module ID onto this one.
 * Runs once per world, by a GM.
 */
export const migratePreviousFlags = async () => {
  if (!game.user.isGM || game.settings.get(MODULE_ID, 'flags-version') >= 1) return;
  let moved = 0;
  for (const actor of game.actors) {
    const old = actor.flags?.[PREVIOUS_MODULE_ID];
    if (old) {
      await actor.update({
        [`flags.${MODULE_ID}`]: old,
        [`flags.${PREVIOUS_MODULE_ID}`]: foundry.data.operators.ForcedDeletion.create()
      });
      moved++;
    }
    const items = actor.items
      .filter((item) => item.flags?.[PREVIOUS_MODULE_ID])
      .map((item) => ({
        _id: item.id,
        [`flags.${MODULE_ID}`]: item.flags[PREVIOUS_MODULE_ID],
        [`flags.${PREVIOUS_MODULE_ID}`]: foundry.data.operators.ForcedDeletion.create()
      }));
    if (items.length) {
      await actor.updateEmbeddedDocuments('Item', items);
      moved += items.length;
    }
  }
  await game.settings.set(MODULE_ID, 'flags-version', 1);
  if (moved) console.log(`${MODULE_ID} | Moved ${moved} flags from ${PREVIOUS_MODULE_ID}`);
};

/**
 * The original module and this one under its previous ID both add a hat to the sheet and react to
 * level changes; running either next to this one is confusing
 */
export const warnIfOriginalActive = () => {
  if (!game.user.isGM) return;
  for (const id of [ORIGINAL_MODULE_ID, PREVIOUS_MODULE_ID]) {
    const module = game.modules.get(id);
    if (!module?.active) continue;
    ui.notifications.warn(localize('notifications.originalActive', { title: module.title }), {
      permanent: true
    });
  }
};
