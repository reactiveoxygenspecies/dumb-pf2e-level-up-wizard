import {
  normalizeString,
  getFeatsForLevel,
  getFeaturesForLevel,
  getSkillsForLevel,
  createGlobalLevelMessage,
  createPersonalLevelMessage,
  skillProficiencyRanks,
  confirmChanges
} from './helpers.js';

export class PF2eLevelUpWizardConfig extends FormApplication {
  constructor(actorData, triggeredByManualLevelUp = false) {
    super();
    this.actorData = actorData;
    this.triggeredByManualLevelUp = triggeredByManualLevelUp;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      height: 'auto',
      width: 525,
      resizable: true,
      id: 'level-up-wizard',
      template: './modules/pf2e-level-up-wizard/templates/level-up-wizard.hbs',
      title: 'Level Up Wizard',
      closeOnSubmit: false
    });
  }

  render(force = false, options = {}) {
    super.render(force, options);

    Hooks.once('renderPF2eLevelUpWizardConfig', () => {
      const form = this.element.find('form');
      const submitButton = this.element.find('button[type="submit"]');

      const validateForm = () => {
        const requiredFields = form.find('[data-required="true"]');

        const allValid = Array.from(requiredFields).every(
          (field) => field.value.trim() !== ''
        );

        submitButton.prop('disabled', !allValid);
      };

      validateForm();

      form.on('change', '[data-required="true"]', validateForm);
    });
  }

  close(options) {
    const form = this.element.find('form');
    form.off('change', '[data-required="true"]');
    return super.close(options);
  }

  async getData() {
    const currentLevel = this.actorData.system.details.level.value;

    const targetLevel = this.triggeredByManualLevelUp
      ? currentLevel
      : currentLevel + 1;
    const classFeats = await getFeatsForLevel(
      this.actorData,
      'class',
      targetLevel
    );
    const ancestryFeats = await getFeatsForLevel(
      this.actorData,
      'ancestry',
      targetLevel
    );
    const skillFeats = await getFeatsForLevel(
      this.actorData,
      'skill',
      targetLevel
    );
    const generalFeats = await getFeatsForLevel(
      this.actorData,
      'general',
      targetLevel
    );
    const features = await getFeaturesForLevel(this.actorData, targetLevel);
    const skills = getSkillsForLevel(this.actorData, targetLevel);
    const actorName = this.actorData.name;

    // Check if at least one field in `features` is truthy
    const hasFeaturesToDisplay = !!(
      features.featuresForLevel.length > 0 ||
      features.abilityScoreIncreaseLevel ||
      features.newSpellRankLevel ||
      features.spellcasting
    );

    return {
      classFeats,
      ancestryFeats,
      skillFeats,
      generalFeats,
      features,
      skills,
      hasFeaturesToDisplay,
      actorName,
      targetLevel
    };
  }

  async _updateObject(event, formData) {
    const confirmed = await confirmChanges();

    if (!confirmed) return;

    const actor = this.actorData;
    const currentLevel = actor.system.details.level.value;
    const targetLevel = this.triggeredByManualLevelUp
      ? currentLevel
      : currentLevel + 1;
    const playerId = game.user.id;
    const actorName = actor.name;

    const data = await this.getData();

    formData.abilityScoreIncreaseLevel =
      data.features.abilityScoreIncreaseLevel;
    formData.spellcasting = data.features.spellcasting;
    formData.newSpellRankLevel = data.features.newSpellRankLevel;

    if (!this.triggeredByManualLevelUp) {
      ui.notifications.info(`Updating ${actorName} to level ${targetLevel}...`);

      await actor.update({ 'system.details.level.value': targetLevel });

      await Hooks.once('updateActor', () => {});
    }

    const featEntries = Object.entries({
      classFeats: formData.classFeats,
      ancestryFeats: formData.ancestryFeats,
      skillFeats: formData.skillFeats,
      generalFeats: formData.generalFeats
    });

    const validFeatEntries = featEntries.filter(([, uuid]) => uuid);

    const featPromises = validFeatEntries.map(async ([type, uuid]) => {
      const feat = await fromUuid(uuid).catch(() => null);
      return { feat, type };
    });

    const featsToAdd = (await Promise.all(featPromises)).filter(
      ({ feat }) => feat
    );

    const featGroupMap = {
      classFeats: 'class',
      ancestryFeats: 'ancestry',
      skillFeats: 'skill',
      generalFeats: 'general'
    };

    const itemsToCreate = featsToAdd.map(({ feat, type }) => ({
      ...feat.toObject(),
      system: {
        ...feat.system,
        location: `${featGroupMap[type]}-${targetLevel}`,
        level: { ...feat.system.level, taken: targetLevel }
      }
    }));

    await actor.createEmbeddedDocuments('Item', itemsToCreate);

    let skillIncreaseMessage = '';
    if (formData.skills) {
      const skill = formData.skills;
      const normalizedSkill = normalizeString(skill);
      const skillRankPath = `system.skills.${normalizedSkill}.rank`;
      const updatedRank = actor.system.skills[normalizedSkill].rank + 1;
      await actor.update({ [skillRankPath]: updatedRank });

      const rankName =
        skillProficiencyRanks[updatedRank] || `Rank ${updatedRank}`;
      skillIncreaseMessage = `${skill} skill rank increased to ${rankName}.`;
    }

    const selectedFeats = featsToAdd
      .map(({ feat }) => `@UUID[${feat.uuid}]`)
      .join(', ');

    createGlobalLevelMessage(
      actorName,
      targetLevel,
      selectedFeats,
      skillIncreaseMessage
    );

    createPersonalLevelMessage(formData, playerId, actorName);

    ui.notifications.info(`${actorName} Level up complete!`);

    this.close();
  }
}
