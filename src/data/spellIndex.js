import { MODULE_ID } from '../constants.js';
import { sluggify } from '../helpers/utility.js';

const FIELDS = [
  'system.slug',
  'system.level.value',
  'system.traits.value',
  'system.traits.rarity',
  'system.traits.traditions',
  'system.time.value',
  'system.ritual',
  'system.publication.title'
];

let cache = null;

export const invalidateSpellIndex = () => {
  cache = null;
};

const toEntry = (raw, pack) => {
  const system = raw.system ?? {};
  const traits = system.traits?.value ?? [];
  const originalName = raw.originalName ?? null;
  return {
    uuid: raw.uuid ?? `Compendium.${pack.collection}.Item.${raw._id}`,
    name: raw.name,
    originalName,
    slug: system.slug || sluggify(originalName ?? raw.name),
    img: raw.img,
    rank: Number(system.level?.value ?? 1),
    cantrip: traits.includes('cantrip'),
    focus: traits.includes('focus'),
    ritual: !!system.ritual,
    traits,
    traditions: system.traits?.traditions ?? [],
    rarity: system.traits?.rarity ?? 'common',
    time: system.time?.value ?? '',
    publication: system.publication?.title ?? '',
    searchText: `${raw.name} ${originalName ?? ''}`.toLocaleLowerCase()
  };
};

/**
 * Every spell in the packs the compendium browser loads for spells (plus any other Item pack holding
 * spells the user can see), without focus spells or rituals.
 * @returns {Promise<object[]>}
 */
export const getSpellIndex = async () => {
  if (cache) return cache;
  cache = (async () => {
    let browserSettings = {};
    try {
      browserSettings = game.settings.get(game.system.id, 'compendiumBrowserPacks')?.spell ?? {};
    } catch {
      browserSettings = {};
    }
    const entries = [];
    const seen = new Set();
    for (const pack of game.packs) {
      if (pack.documentName !== 'Item') continue;
      if (!pack.testUserPermission(game.user, 'LIMITED')) continue;
      if (!pack.index.some((e) => e.type === 'spell')) continue;
      if (browserSettings[pack.collection]?.load === false) continue;
      try {
        const index = await pack.getIndex({ fields: FIELDS });
        for (const raw of index) {
          if (raw.type !== 'spell') continue;
          const entry = toEntry(raw, pack);
          if (entry.focus || entry.ritual || seen.has(entry.uuid)) continue;
          seen.add(entry.uuid);
          entries.push(entry);
        }
      } catch (error) {
        console.error(`${MODULE_ID} | Failed to index spells in ${pack.collection}`, error);
      }
    }
    return entries.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, game.i18n.lang));
  })();
  cache.catch(() => {
    cache = null;
  });
  return cache;
};

/** UUID of a spell by slug (heal, harm), preferring the PF2e system's own spells */
export const findSpellUuid = (index, slug) => {
  if (!slug || !index?.length) return null;
  const matches = index.filter((s) => s.slug === slug);
  return (matches.find((s) => s.uuid.startsWith('Compendium.pf2e.spells-srd.')) ?? matches[0])?.uuid ?? null;
};

export const registerSpellIndexHooks = () => {
  const onChange = (item) => {
    if (item.pack && item.type === 'spell') invalidateSpellIndex();
  };
  Hooks.on('createItem', onChange);
  Hooks.on('updateItem', onChange);
  Hooks.on('deleteItem', onChange);
};
