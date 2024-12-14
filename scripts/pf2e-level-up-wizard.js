import { renderLevelUpButton } from './actor.js';
import { PF2eLevelUpWizardConfig } from './levelUpWizard.js';
import { registerSettings } from './settings.js';

export const module_name = 'pf2e-level-up-wizard';

const renderWizardOnLevelUp = (actor, updateData, options, userId) => {
  if (actor.type !== 'character' || game.user.id !== userId) return;

  const newLevel = updateData?.system?.details?.level?.value;

  if (!newLevel) return;

  new PF2eLevelUpWizardConfig(actor, true).render(true);
};

Hooks.on('init', () => {
  console.log('PF2e Level-Up Wizard | Module Initialized');
  registerSettings();
});

Hooks.on('ready', () => {
  if (game.settings.get(module_name, 'show-level-up-button')) {
    Hooks.on('renderCharacterSheetPF2e', renderLevelUpButton);
  } else {
    Hooks.on('updateActor', renderWizardOnLevelUp);
  }
});

document.addEventListener('change', (event) => {
  if (event.target.matches('#skills')) {
    const selectElement = event.target;
    const selectedOption = selectElement.options[selectElement.selectedIndex];
    const selectedClass = selectedOption.className;

    // Remove previous skill rank classes
    selectElement.classList.remove(
      'skill-option-untrained',
      'skill-option-trained',
      'skill-option-expert',
      'skill-option-master',
      'skill-option-legendary'
    );

    // Add the class of the selected option
    if (selectedClass) {
      selectElement.classList.add(selectedClass);
    }
  }
});
