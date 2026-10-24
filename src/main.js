import { MODULE_ID, SUPPORTED_SYSTEMS, TEMPLATE_PATH } from './constants.js';
import { migratePreviousFlags, migrateSettings, registerSettings, warnIfOriginalActive } from './settings.js';
import { registerFeatIndexHooks } from './data/featIndex.js';
import { registerAbcIndexHooks } from './data/abcIndex.js';
import { registerSpellIndexHooks } from './data/spellIndex.js';
import { registerFormulaIndexHooks } from './data/formulas.js';
import { getHistory, undoLastLevelUp } from './data/apply.js';
import {
  onGetHeaderButtons,
  onGetHeaderControls,
  onPreUpdateActor,
  onRenderCharacterSheet,
  onUpdateActor,
  openBuilder,
  openHistory,
  renderWizard
} from './sheetButton.js';

Hooks.once('init', () => {
  if (!SUPPORTED_SYSTEMS.includes(game.system.id)) return;
  registerSettings();
  registerFeatIndexHooks();
  registerAbcIndexHooks();
  registerSpellIndexHooks();
  registerFormulaIndexHooks();

  foundry.applications.handlebars.loadTemplates({
    lvlupFeatSlot: `${TEMPLATE_PATH}/partials/feat-slot.hbs`,
    lvlupSpellPicker: `${TEMPLATE_PATH}/partials/spell-picker.hbs`,
    lvlupWizardRail: `${TEMPLATE_PATH}/partials/wizard-rail.hbs`,
    lvlupWizardReview: `${TEMPLATE_PATH}/partials/wizard-review.hbs`,
    lvlupWizardSkillGrid: `${TEMPLATE_PATH}/partials/wizard-skill-grid.hbs`
  });

  const helpers = {
    lvlupEq: (a, b) => a === b,
    lvlupSigned: (n) => (n >= 0 ? `+${n}` : `${n}`)
  };
  for (const [name, fn] of Object.entries(helpers)) Handlebars.registerHelper(name, fn);

  game.modules.get(MODULE_ID).api = {
    /** Open the wizard for an actor (respects the same checks as the sheet button) */
    open: (actor) => renderWizard(actor),
    /** Open the character builder (level-1 creation) for an actor */
    build: (actor) => openBuilder(actor),
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
  try {
    await migratePreviousFlags();
  } catch (error) {
    console.error(`${MODULE_ID} | Flag migration failed`, error);
  }
  warnIfOriginalActive();

  // The sheet hooks decide per character: the level-up hat in button mode, the builder hat for
  // characters without a class in every mode
  Hooks.on('renderCharacterSheetPF2e', onRenderCharacterSheet);
  Hooks.on('getCharacterSheetPF2eHeaderButtons', onGetHeaderButtons);
  Hooks.on('getHeaderControlsCharacterSheetPF2e', onGetHeaderControls);
  if (!game.settings.get(MODULE_ID, 'show-level-up-button')) {
    Hooks.on('preUpdateActor', onPreUpdateActor);
    Hooks.on('updateActor', onUpdateActor);
  }
});
