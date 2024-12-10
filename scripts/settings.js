import { module_name } from './pf2e-level-up-wizard.js';
import { renderLevelUpButton } from './actor.js';

export const registerSettings = () => {
  game.settings.register(module_name, 'buttonPlacement', {
    name: 'Button Placement',
    hint: 'Controls whether the Level Up button is on the character sheet next to the level or in the toolbar',
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
