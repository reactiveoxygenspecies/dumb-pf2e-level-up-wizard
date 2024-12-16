import { module_name } from './pf2e-level-up-wizard.js';
import { renderLevelUpButton } from './actor.js';

export const registerSettings = () => {
  game.settings.register(module_name, 'show-level-up-button', {
    name: game.i18n.localize('PF2E_LEVEL_UP_WIZARD.settings.showButton.name'),
    hint: game.i18n.localize('PF2E_LEVEL_UP_WIZARD.settings.showButton.hint'),
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
    requiresReload: true
  });

  game.settings.register(module_name, 'button-placement', {
    name: game.i18n.localize(
      'PF2E_LEVEL_UP_WIZARD.settings.buttonPlacement.name'
    ),
    hint: game.i18n.localize(
      'PF2E_LEVEL_UP_WIZARD.settings.buttonPlacement.hint'
    ),
    scope: 'client',
    config: true,
    type: String,
    default: 'CHAR_HEADER',
    choices: {
      CHAR_HEADER: game.i18n.localize(
        'PF2E_LEVEL_UP_WIZARD.settings.buttonPlacement.options.charHeader'
      ),
      WINDOW_HEADER: game.i18n.localize(
        'PF2E_LEVEL_UP_WIZARD.settings.buttonPlacement.options.windowHeader'
      )
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

  game.settings.register(module_name, 'feat-sort-method', {
    name: game.i18n.localize('PF2E_LEVEL_UP_WIZARD.settings.sortMethod.name'),
    hint: game.i18n.localize('PF2E_LEVEL_UP_WIZARD.settings.sortMethod.hint'),
    scope: 'client',
    config: true,
    default: 'LEVEL_DESC',
    choices: {
      LEVEL_DESC: game.i18n.localize(
        'PF2E_LEVEL_UP_WIZARD.settings.sortMethod.options.levelDesc'
      ),
      LEVEL_ASC: game.i18n.localize(
        'PF2E_LEVEL_UP_WIZARD.settings.sortMethod.options.levelAsc'
      ),
      ALPHABETICAL: game.i18n.localize(
        'PF2E_LEVEL_UP_WIZARD.settings.sortMethod.options.alphabetical'
      )
    }
  });
};
