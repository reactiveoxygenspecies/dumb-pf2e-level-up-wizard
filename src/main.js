import { MODULE_ID, SUPPORTED_SYSTEMS, TEMPLATE_PATH } from './constants.js';
import { migrateSettings, registerSettings, warnIfOriginalActive } from './settings.js';
import { registerFeatIndexHooks } from './data/featIndex.js';
import { getHistory, undoLastLevelUp } from './data/apply.js';
import {
  onGetHeaderButtons,
  onGetHeaderControls,
  onPreUpdateActor,
  onRenderCharacterSheet,
  onUpdateActor,
  openHistory,
  renderWizard
} from './sheetButton.js';

Hooks.once('init', () => {
  if (!SUPPORTED_SYSTEMS.includes(game.system.id)) return;
  registerSettings();
  registerFeatIndexHooks();

  foundry.applications.handlebars.loadTemplates({
    lvlupFeatSlot: `${TEMPLATE_PATH}/partials/feat-slot.hbs`
  });

  const helpers = {
    lvlupEq: (a, b) => a === b,
    lvlupSigned: (n) => (n >= 0 ? `+${n}` : `${n}`)
  };
  for (const [name, fn] of Object.entries(helpers)) Handlebars.registerHelper(name, fn);

  game.modules.get(MODULE_ID).api = {
    /** Open the wizard for an actor (respects the same checks as the sheet button) */
    open: (actor) => renderWizard(actor),
    /** Show the level-up history of an actor */
    history: (actor) => openHistory(actor),
    getHistory,
    undoLastLevelUp
  };
});

Hooks.once('ready', async () => {
  if (!SUPPORTED_SYSTEMS.includes(game.system.id)) return;
  // Settings copied from the original module decide the button mode below
  try {
    await migrateSettings();
  } catch (error) {
    console.error(`${MODULE_ID} | Settings migration failed`, error);
  }
  warnIfOriginalActive();

  if (game.settings.get(MODULE_ID, 'show-level-up-button')) {
    Hooks.on('renderCharacterSheetPF2e', onRenderCharacterSheet);
    Hooks.on('getCharacterSheetPF2eHeaderButtons', onGetHeaderButtons);
    Hooks.on('getHeaderControlsCharacterSheetPF2e', onGetHeaderControls);
  } else {
    Hooks.on('preUpdateActor', onPreUpdateActor);
    Hooks.on('updateActor', onUpdateActor);
  }
});
