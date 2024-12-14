let cachedFeats = null;

// @Constants
const abilityScoreIncreaseLevels = [5, 10, 15, 20];
const newSpellRankLevels = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19];

export const skillProficiencyRanks = {
  0: 'Untrained',
  1: 'Trained',
  2: 'Expert',
  3: 'Master',
  4: 'Legendary'
};

// @Utility
const getCachedFeats = async () => {
  if (!cachedFeats) {
    const featsCompendium = game.packs.get('pf2e.feats-srd');
    cachedFeats = await featsCompendium.getDocuments();
  }
  return cachedFeats;
};

export const normalizeString = (str) => str.replace(/\s+/g, '-').toLowerCase();

export const getSkillRankClass = (rank) => {
  switch (rank) {
    case 0:
      return 'skill-option-untrained';
    case 1:
      return 'skill-option-trained';
    case 2:
      return 'skill-option-expert';
    case 3:
      return 'skill-option-master';
    case 4:
      return 'skill-option-legendary';
    default:
      return '';
  }
};

export const getMaxSkillProficiency = (level) => {
  if (level >= 15) return 4; // Legendary
  if (level >= 7) return 3; // Master
  return 2; // Expert
};

const stripParagraphTags = (html) => html?.replace(/^<p>|<\/p>$/g, '') || '';

export const getClassSpecificDescription = (description, characterClass) => {
  if (!description || !characterClass) return description;

  const regex = new RegExp(`<p><strong>(.*?)</strong>(.*?)</p>`, 'gi');

  let match;
  while ((match = regex.exec(description))) {
    const classes = match[1].split(',').map((c) => c.trim().toLowerCase());
    if (classes.includes(characterClass.toLowerCase())) {
      return `<p>${match[2].trim()}</p>`;
    }
  }

  return description;
};

export const confirmChanges = async () => {
  return Dialog.confirm({
    title: 'Confirm Changes',
    content: '<p>Are you sure you want to apply these level-up changes?</p>'
  });
};

const filterAndSortFeats = async (searchQuery, targetLevel) => {
  const feats = await getCachedFeats();
  const normalizedQuery = normalizeString(searchQuery);

  const filteredFeats = feats.filter((feat) => {
    const traits = feat.system.traits.value.map(normalizeString);
    return (
      traits.includes(normalizedQuery) && feat.system.level.value <= targetLevel
    );
  });

  return filteredFeats.sort((a, b) =>
    a.system.level.value !== b.system.level.value
      ? b.system.level.value - a.system.level.value
      : a.name.localeCompare(b.name)
  );
};

export const getFeatsForLevel = async (characterData, type, targetLevel) => {
  const levelsArray =
    characterData?.class?.system?.[`${type}FeatLevels`]?.value;

  if (!levelsArray.includes(targetLevel)) return;

  const queryMap = {
    class: characterData?.class?.name,
    ancestry: characterData?.ancestry?.name,
    general: 'general',
    skill: 'skill'
  };

  const searchQuery = queryMap[type];
  if (!searchQuery) {
    console.error(`Unknown feat type: ${type}`);
    return;
  }

  return filterAndSortFeats(searchQuery, targetLevel);
};

const mapFeaturesWithDetails = async (features, characterClass) => {
  return Promise.all(
    features.map(async (feature) => {
      const item = await fromUuid(feature.uuid).catch(() => null);
      if (!item) return null;

      const filteredDescription = getClassSpecificDescription(
        item.system.description.value,
        characterClass
      );

      return {
        name: feature.name,
        description: stripParagraphTags(filteredDescription),
        img: feature.img || item.img,
        uuid: feature.uuid
      };
    })
  ).then((results) => results.filter((feature) => feature));
};

export const getFeaturesForLevel = async (characterData, targetLevel) => {
  const characterClass = characterData?.class?.name;
  const spellcasting = characterData?.class?.system?.spellcasting;
  const featuresArray = Object.values(characterData?.class?.system?.items);

  const featuresForLevel = featuresArray.filter(
    (boon) => boon.level === targetLevel
  );

  const featuresWithDetails = await mapFeaturesWithDetails(
    featuresForLevel,
    characterClass
  );

  return {
    featuresForLevel: featuresWithDetails,
    abilityScoreIncreaseLevel: abilityScoreIncreaseLevels.includes(targetLevel),
    newSpellRankLevel: newSpellRankLevels.includes(targetLevel) && spellcasting,
    spellcasting
  };
};

export const getSkillsForLevel = (characterData, targetLevel) => {
  const levelsArray = characterData?.class?.system?.skillIncreaseLevels?.value;

  if (!levelsArray.includes(targetLevel)) return [];

  const maxProficiency = getMaxSkillProficiency(targetLevel);

  return Object.values(characterData?.skills)
    .filter((skill) => skill.rank < maxProficiency)
    .map((skill) => ({ ...skill, class: getSkillRankClass(skill.rank) }));
};

export const createGlobalLevelMessage = (
  actorName,
  targetLevel,
  selectedFeats,
  skillIncreaseMessage
) => {
  const globalMessage = `
  <h2>${actorName} has leveled up to Level ${targetLevel}!</h2>
  <p><strong>Selected Feats:</strong> ${
    selectedFeats || 'No feats selected.'
  }</p>
  ${
    skillIncreaseMessage
      ? `<p><strong>Skill Increase:</strong> ${skillIncreaseMessage}</p>`
      : ''
  }
`;
  ChatMessage.create({
    content: globalMessage,
    speaker: { alias: actorName }
  });
};

export const createPersonalLevelMessage = (formData, playerId, actorName) => {
  const manualUpdates = [];
  if (formData.abilityScoreIncreaseLevel) {
    manualUpdates.push('Ability Score Increases (Character tab)');
  }
  if (formData.spellcasting) {
    manualUpdates.push(
      formData.newSpellRankLevel
        ? 'New Spell Rank & Slots (Spellcasting tab)'
        : 'New Spell Slots (Spellcasting tab)'
    );
  }

  if (manualUpdates.length > 0) {
    const whisperMessage = `
                <h2>Manual Updates Needed</h2>
                <ul>${manualUpdates
                  .map((update) => `<li>${update}</li>`)
                  .join('')}</ul>
            `;
    ChatMessage.create({
      content: whisperMessage,
      whisper: [playerId],
      speaker: { alias: actorName }
    });
  }
};
