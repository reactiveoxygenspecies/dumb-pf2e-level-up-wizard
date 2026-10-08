import { MODULE_ID, systemId, systemSetting } from '../constants.js';
import { localize, sluggify } from '../helpers/utility.js';

const INDEX_FIELDS = [
  'img',
  'system.slug',
  'system.category',
  'system.featType.value',
  'system.level.value',
  'system.traits.value',
  'system.traits.rarity',
  'system.prerequisites.value',
  'system.maxTakable',
  'system.actionType.value',
  'system.actions.value',
  'system.publication.title'
];

let cache = null;
const warnedMissing = new Set();

/** Drop the cached index, e.g. after a compendium is edited or the pack selection changes */
export const invalidateFeatIndex = () => {
  cache = null;
};

/**
 * Feat compendiums to search. Mirrors the compendium browser: every Item pack holding feats that the
 * user can see and that the GM has not unticked in the browser's pack settings, plus the module's
 * own "additional compendiums" setting for anything the browser would not pick up.
 */
export const getFeatPackIds = () => {
  const browserSettings = systemSetting('compendiumBrowserPacks', {})?.feat ?? {};
  const ids = new Set();

  for (const pack of game.packs) {
    if (pack.documentName !== 'Item') continue;
    if (!pack.testUserPermission(game.user, 'LIMITED')) continue;
    if (!pack.index.some((entry) => entry.type === 'feat')) continue;
    if (browserSettings[pack.collection]?.load === false) continue;
    ids.add(pack.collection);
  }

  const extra = game.settings.get(MODULE_ID, 'additional-feat-compendiums');
  for (const key of (extra ?? '').split(',').map((k) => k.trim())) {
    if (!key) continue;
    if (game.packs.get(key)) ids.add(key);
    else if (!warnedMissing.has(key)) {
      warnedMissing.add(key);
      ui.notifications.warn(
        localize('notifications.additionalCompendiums.compendiumNotFound', {
          key
        })
      );
    }
  }

  if (!ids.size) {
    const fallback = game.packs.get(`${systemId()}.feats-srd`);
    if (fallback) ids.add(fallback.collection);
  }

  return [...ids];
};

/** Normalize a compendium index entry (exported for tests) */
export const toEntry = (raw, pack) => {
  const system = raw.system ?? {};
  const category = system.category ?? system.featType?.value ?? 'bonus';
  const originalName = raw.originalName ?? null; // added by Babele
  const slug = system.slug || sluggify(originalName ?? raw.name);
  const traits = (system.traits?.value ?? []).map((t) =>
    String(t).replace(/^hb_/, '')
  );

  return {
    uuid: raw.uuid ?? `Compendium.${pack.collection}.Item.${raw._id}`,
    id: raw._id,
    name: raw.name,
    originalName,
    slug,
    img: raw.img,
    category,
    level: Number(system.level?.value ?? 0),
    traits,
    rarity: system.traits?.rarity ?? 'common',
    prerequisites: (system.prerequisites?.value ?? [])
      .map((p) => (typeof p === 'string' ? p : p?.value))
      .filter(Boolean),
    // null means unlimited (PF2e prepares it as Infinity); a missing field means the default of 1
    maxTakable:
      system.maxTakable === undefined ? 1 : (system.maxTakable ?? Infinity),
    actionType: system.actionType?.value ?? 'passive',
    actions: system.actions?.value ?? null,
    publication: system.publication?.title ?? '',
    pack: pack.collection,
    searchText: `${raw.name} ${originalName ?? ''}`.toLocaleLowerCase()
  };
};

/**
 * Load a lightweight index of every feat in the selected packs. Only index fields are read, so this is
 * far cheaper than loading full documents; full documents are fetched on demand when a feat is shown
 * in detail or added to the actor.
 * @returns {Promise<object[]>}
 */
export const getFeatIndex = async () => {
  const packIds = getFeatPackIds();
  const key = packIds.join('|');
  if (cache?.key === key) return cache.promise;

  const promise = (async () => {
    const entries = [];
    const seen = new Set();
    for (const id of packIds) {
      const pack = game.packs.get(id);
      try {
        const index = await pack.getIndex({ fields: INDEX_FIELDS });
        for (const raw of index) {
          if (raw.type !== 'feat') continue;
          const entry = toEntry(raw, pack);
          if (seen.has(entry.uuid)) continue;
          seen.add(entry.uuid);
          entries.push(entry);
        }
      } catch (error) {
        console.error(`${MODULE_ID} | Failed to index ${id}`, error);
        ui.notifications.warn(
          localize('notifications.additionalCompendiums.failedToLoad', {
            key: id
          })
        );
      }
    }
    return entries;
  })();

  cache = { key, promise };
  promise.catch(() => {
    if (cache?.promise === promise) cache = null;
  });
  return promise;
};

export const registerFeatIndexHooks = () => {
  const onItemChange = (item) => {
    if (item.pack && item.type === 'feat') invalidateFeatIndex();
  };
  Hooks.on('createItem', onItemChange);
  Hooks.on('updateItem', onItemChange);
  Hooks.on('deleteItem', onItemChange);
  Hooks.on('updateCompendium', invalidateFeatIndex);
  Hooks.on('updateSetting', (setting) => {
    if (setting.key === `${systemId()}.compendiumBrowserPacks`)
      invalidateFeatIndex();
  });
};
