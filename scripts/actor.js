import { module_name } from './pf2e-level-up-wizard.js';
import { PF2eLevelUpWizardConfig } from './levelUpWizard.js';

export const renderLevelUpButton = (sheet, html) => {
  if (!sheet.actor.isOwner) return;

  const title = game.i18n.localize('PF2E_LEVEL_UP_WIZARD.button-tooltip');

  html.find('.level-up-icon-button').remove();
  html.find('.level-up-wizard').remove();

  if (game.settings.get(module_name, 'buttonPlacement') === 'CHAR_HEADER') {
    const button = $(
      `<button type='button' class='level-up-icon-button flex0' title="${title}">
      <i class='fas fa-hat-wizard'></i>
      </button>`
    );

    button.on('click', () => new PF2eLevelUpWizardConfig(sheet).render(true));

    html.find('section.char-level').prepend(button);
  }

  if (game.settings.get(module_name, 'buttonPlacement') === 'WINDOW_HEADER') {
    const button = $(
      `<a class="level-up-wizard" title="Level Up Wizard"><i class="fas fa-hat-wizard"></i>${title}</a>`
    );
    button.on('click', () => new PF2eLevelUpWizardConfig(sheet).render(true));

    html.find('.window-title').after(button);
  }
};
