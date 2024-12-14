import { module_name } from './pf2e-level-up-wizard.js';
import { renderLevelUpButton } from './actor.js';

export const registerSettings = () => {
  game.settings.register(module_name, 'show-level-up-button', {
    name: 'Enable Level-Up Button',
    hint: "Choose whether to show a Level-Up button on character sheets. When disabled, the Level-Up Wizard will activate automatically after manually updating a character's level.",
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
    requiresReload: true
  });

  game.settings.register(module_name, 'button-placement', {
    name: 'Level-Up Button Placement',
    hint: "Select where the Level-Up button appears: either next to the character's level or in the toolbar at the top of the character sheet.",
    scope: 'client',
    config: true,
    type: String,
    default: 'CHAR_HEADER',
    choices: {
      CHAR_HEADER: 'Next to Level',
      WINDOW_HEADER: 'Toolbar'
    },
    onChange: () => {
      Object.values(ui.windows).forEach((app) => {
        if (
          app.options.classes.includes('character') &&
          app.actor?.type === 'character'
        ) {
          app.render(false);

          const html = $(app.element);
          renderLevelUpButton(app, html);
        }
      });
    }
  });
};
