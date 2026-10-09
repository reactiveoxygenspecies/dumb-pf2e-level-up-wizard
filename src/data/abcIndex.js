import { MODULE_ID } from '../constants.js';
import { sluggify } from '../helpers/utility.js';

/** Index fields per item type, enough to draw the builder's cards without loading documents */
const FIELDS = {
  ancestry: [
    'system.slug',
    'system.traits.rarity',
    'system.traits.value',
    'system.hp',
    'system.size',
    'system.speed',
    'system.boosts',
    'system.flaws',
    'system.vision',
    'system.languages',
    'system.additionalLanguages',
    'system.publication.title'
  ],
  heritage: ['system.slug', 'system.traits.rarity', 'system.ancestry', 'system.publication.title'],
  background: [
    'system.slug',
    'system.traits.rarity',
    'system.boosts',
    'system.trainedSkills',
    'system.publication.title'
  ],
  class: [
    'system.slug',
    'system.traits.rarity',
    'system.hp',
    'system.keyAbility',
    'system.trainedSkills',
    'system.spellcasting',
    'system.publication.title'
  ],
  deity: [
    'system.slug',
    'system.category',
    'system.domains',
    'system.sanctification',
    'system.font',
    'system.publication.title'
  ]
};

export const ABC_TYPES = Object.keys(FIELDS);

const RARITY_ORDER = ['common', 'uncommon', 'rare', 'unique'];

let cache = null;

export const invalidateAbcIndex = () => {
  cache = null;
};

const toEntry = (raw, pack) => {
  const system = raw.system ?? {};
  const originalName = raw.originalName ?? null; // added by Babele
  return {
    uuid: raw.uuid ?? `Compendium.${pack.collection}.Item.${raw._id}`,
    type: raw.type,
    name: raw.name,
    originalName,
    slug: system.slug || sluggify(originalName ?? raw.name),
    img: raw.img,
    rarity: system.traits?.rarity ?? 'common',
    publication: system.publication?.title ?? '',
    system,
    searchText: `${raw.name} ${originalName ?? ''}`.toLocaleLowerCase()
  };
};

/**
 * Every ancestry, heritage, background, class and deity the user can see, grouped by type.
 * One index request per pack, with only the fields the builder shows.
 * @returns {Promise<Record<string, object[]>>}
 */
export const getAbcIndex = async () => {
  if (cache) return cache;
  cache = (async () => {
    const byType = Object.fromEntries(ABC_TYPES.map((t) => [t, []]));
    const fields = [...new Set(Object.values(FIELDS).flat())];
    for (const pack of game.packs) {
      if (pack.documentName !== 'Item') continue;
      if (!pack.testUserPermission(game.user, 'LIMITED')) continue;
      if (!pack.index.some((e) => ABC_TYPES.includes(e.type))) continue;
      try {
        const index = await pack.getIndex({ fields });
        for (const raw of index) {
          if (byType[raw.type]) byType[raw.type].push(toEntry(raw, pack));
        }
      } catch (error) {
        console.error(`${MODULE_ID} | Failed to index ${pack.collection}`, error);
      }
    }
    for (const list of Object.values(byType)) {
      list.sort(
        (a, b) =>
          RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity) ||
          a.name.localeCompare(b.name, game.i18n.lang)
      );
    }
    return byType;
  })();
  cache.catch(() => {
    cache = null;
  });
  return cache;
};

/** Heritages for an ancestry, plus the versatile heritages any ancestry can take */
export const heritagesFor = (index, ancestry) => {
  if (!ancestry) return [];
  return index.heritage.filter((h) => {
    const parent = h.system.ancestry;
    if (!parent) return true;
    return parent.slug === ancestry.slug || parent.uuid === ancestry.uuid;
  });
};

/** Full documents are only needed once something is picked; keep them for the session */
const documents = new Map();
export const loadDocument = async (uuid) => {
  if (!uuid) return null;
  if (!documents.has(uuid)) {
    documents.set(
      uuid,
      fromUuid(uuid).catch(() => null)
    );
  }
  return documents.get(uuid);
};

export const registerAbcIndexHooks = () => {
  const onChange = (item) => {
    if (item.pack && ABC_TYPES.includes(item.type)) invalidateAbcIndex();
  };
  Hooks.on('createItem', onChange);
  Hooks.on('updateItem', onChange);
  Hooks.on('deleteItem', onChange);
};
