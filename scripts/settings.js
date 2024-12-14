import { module_name } from './pf2e-level-up-wizard.js';
import { renderLevelUpButton } from './actor.js';

export const registerSettings = () => {
  game.settings.register(module_name, 'show-level-up-button', {
    name: 'Show Level-Up Button',
    hint: 'If toggled on, display a button to trigger the wizard and subsequent level-up. If toggled off, the wizard will be activated after a character is leveled-up manually.',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
    requiresReload: true
  });

  game.settings.register(module_name, 'button-placement', {
    name: 'Button Placement',
    hint: 'If displaying the Level-Up Button, controls whether it is on the character sheet next to the level or in the toolbar',
    scope: 'client',
    config: true,
    type: String,
    default: 'CHAR_HEADER',
    choices: {
      CHAR_HEADER: 'Next To Level',
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
