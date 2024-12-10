import { renderLevelUpButton } from './actor.js';
import { registerSettings } from './settings.js';

export const module_name = 'pf2e-level-up-wizard';

Hooks.on('init', () => {
  console.log('PF2e Level-Up Wizard | Module Initialized');
  registerSettings();
});

Hooks.on('renderCharacterSheetPF2e', renderLevelUpButton);

document.addEventListener('change', (event) => {
  console.log('event listener');
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
