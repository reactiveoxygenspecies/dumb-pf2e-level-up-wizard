export const MODULE_ID = 'pf2e-level-up-wizard';

export const TEMPLATE_PATH = `modules/${MODULE_ID}/templates`;

/** Localization prefix shared by every string in languages/*.json */
export const I18N = 'PF2E_LEVEL_UP_WIZARD';

/** PF2e and SF2e share one code base and expose the same APIs under their own system id */
export const SUPPORTED_SYSTEMS = ['pf2e', 'sf2e'];

export const systemId = () => game.system.id;

/** Read a system setting, returning `fallback` when the setting does not exist in this system version */
export const systemSetting = (key, fallback = null) => {
  try {
    return game.settings.get(systemId(), key);
  } catch {
    return fallback;
  }
};

/** Proficiency ranks, 0 = untrained … 4 = legendary */
export const RANK_KEYS = ['untrained', 'trained', 'expert', 'master', 'legendary'];

/** Class item slugs (and English names) for actors the wizard should not level */
export const COMPANION_CLASSES = [
  'animal-companion',
  'construct-companion',
  'eidolon',
  'Animal Companion',
  'Construct Companion',
  'Eidolon'
];

export const ATTRIBUTE_SETS = [5, 10, 15, 20];
