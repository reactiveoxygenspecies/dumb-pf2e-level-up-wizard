import { MODULE_ID } from '../constants.js';
import { sluggify } from '../helpers/utility.js';

/**
 * An in-memory copy of the actor as it will be at `targetLevel`. The system prepares it exactly like the
 * real actor, so its feat groups, slots, attribute modifiers and language counts reflect the new level.
 * PF2e itself uses the same approach when it adjusts hit points on a level change.
 */
export const createPreviewActor = (actor, targetLevel, changes = {}) => {
  const data = foundry.utils.mergeObject(
    { system: { details: { level: { value: targetLevel } } } },
    changes
  );
  return actor.clone(data, { keepId: true });
};

const toTraitList = (value) => (Array.isArray(value) ? value : []);

/**
 * Class trait(s) for actors whose class item is a merged dual class ("Fighter - Wizard") or translated
 * name the system cannot map to a feat trait on its own.
 */
const fallbackClassTraits = (actor) => {
  const cls = actor.class;
  if (!cls) return [];
  const featTraits = CONFIG.PF2E.featTraits ?? {};
  if (cls.slug && cls.slug in featTraits) return [];

  const labelToSlug = new Map(
    Object.entries(CONFIG.PF2E.classTraits ?? {}).map(([slug, label]) => [
      game.i18n.localize(label).toLocaleLowerCase(),
      slug
    ])
  );
  const names = [cls.flags?.babele?.originalName, cls.name].filter(Boolean);
  const traits = new Set();
  for (const name of names) {
    for (const part of name.split(/\s*[-–/]\s*/)) {
      const slug =
        labelToSlug.get(part.trim().toLocaleLowerCase()) ?? sluggify(part);
      if (slug in featTraits) traits.add(slug);
    }
  }
  return [...traits];
};

/**
 * Empty feat slots on the preview actor.
 * @returns {{ current: object[], missed: object[] }} slots gained at the target level, and empty
 *   slots from earlier levels (offered as optional picks)
 */
export const getFeatSlots = (preview, targetLevel, previousLevel) => {
  const current = [];
  const missed = [];
  const extraClassTraits = fallbackClassTraits(preview);

  for (const group of preview.feats ?? []) {
    if (!group.slotted) continue;
    const isTiered = !!group.customLimit;

    for (const slot of Object.values(group.slots ?? {})) {
      if (!slot || slot.feat) continue;
      if (typeof slot.level !== 'number') continue;

      const filter = foundry.utils.deepClone(slot.filter ?? group.filter ?? {});
      filter.categories ??= group.supported ?? [];
      if (group.id === 'class' && extraClassTraits.length) {
        filter.traits = [...new Set([...extraClassTraits, ...(filter.traits ?? [])])];
      }

      const data = {
        key: `${group.id}::${slot.id}`,
        groupId: group.id,
        groupLabel: game.i18n.localize(group.label),
        slotId: slot.id,
        level: slot.level,
        label: game.i18n.localize(String(slot.label ?? slot.level)),
        // Keep specific prompts (e.g. mythic destiny) but not the system's generic "Empty Slot"
        placeholder:
          slot.placeholder && slot.placeholder !== 'PF2E.EmptySlot'
            ? game.i18n.localize(slot.placeholder)
            : null,
        filter,
        supported: group.supported ?? []
      };

      // Tiered groups (mythic "variant tiers") open slots by GM-set tier, not by level
      const isNew = isTiered
        ? false
        : slot.level > previousLevel && slot.level <= targetLevel;
      if (isNew) current.push(data);
      else missed.push(data);
    }
  }

  const order = ['ancestry', 'class', 'archetype', 'skill', 'general', 'mythic'];
  const rank = (s) => {
    const i = order.indexOf(s.groupId);
    return i === -1 ? order.length : i;
  };
  const sort = (a, b) => a.level - b.level || rank(a) - rank(b);
  return { current: current.sort(sort), missed: missed.sort(sort) };
};

const creatureTraits = () =>
  new Set(Object.keys(CONFIG.PF2E.creatureTraits ?? {}));

/** Compendium browser semantics: categories OR'd, traits OR'd/AND'd by conjunction, omitTraits excluded */
/** Selectable feat categories when a (module-added) group doesn't restrict them */
const DEFAULT_CATEGORIES = ['ancestry', 'class', 'general', 'skill'];

const matchesFilter = (entry, filter) => {
  const categories = toTraitList(filter.categories);
  const allowed = categories.length ? categories : DEFAULT_CATEGORIES;
  if (!allowed.includes(entry.category)) return false;

  const omit = toTraitList(filter.omitTraits);
  if (omit.some((t) => entry.traits.includes(t))) return false;

  const traits = toTraitList(filter.traits);
  if (!traits.length) return true;
  return filter.conjunction === 'and'
    ? traits.every((t) => entry.traits.includes(t))
    : traits.some((t) => entry.traits.includes(t));
};

let grantedArchetypeFeats = null;

/** Feats from other classes that archetypes unlock, keyed by dedication slug (see scripts/build-archetype-feats.mjs) */
export const loadGrantedArchetypeFeats = async () => {
  if (grantedArchetypeFeats) return grantedArchetypeFeats;
  try {
    grantedArchetypeFeats = await foundry.utils.fetchJsonWithTimeout(
      `modules/${MODULE_ID}/src/data/grantedArchetypeFeats.json`
    );
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to load archetype feat data`, error);
    grantedArchetypeFeats = {};
  }
  return grantedArchetypeFeats;
};

const getGrantedArchetypeFeats = () => grantedArchetypeFeats ?? {};

/** Identifiers of feats the actor already has, for "already taken" checks */
export const getOwnedFeatKeys = (actor) => {
  const keys = new Map();
  for (const item of actor.itemTypes?.feat ?? []) {
    const ids = [
      item.sourceId,
      item.slug,
      sluggify(item.name),
      item.flags?.babele?.originalName
        ? sluggify(item.flags.babele.originalName)
        : null
    ].filter(Boolean);
    for (const id of ids) keys.set(id, (keys.get(id) ?? 0) + 1);
  }
  return keys;
};

const timesTaken = (entry, ownedKeys) =>
  Math.max(ownedKeys.get(entry.uuid) ?? 0, ownedKeys.get(entry.slug) ?? 0);

/**
 * Feats that can go into a slot, flagged by how they qualify.
 * Archetype feats in a class slot are flagged `isArchetype` so the selector can hide them by default.
 */
export const getCandidatesForSlot = (slot, index, context) => {
  const { ownedKeys, dedications } = context;
  const maxLevel = slot.level;
  const results = [];
  const byUuid = new Map();

  const filter = slot.filter;
  const filterTraits = toTraitList(filter.traits);
  const archetypeTraits = ['archetype', 'dedication'];
  const isArchetypeGroup =
    filterTraits.length > 0 &&
    filterTraits.every((t) => archetypeTraits.includes(t));
  const isAncestrySlot = toTraitList(filter.categories).includes('ancestry');
  const creatures = isAncestrySlot ? creatureTraits() : null;

  for (const entry of index) {
    if (entry.level > maxLevel) continue;

    let matches = matchesFilter(entry, filter);
    // Universal ancestry feats have no ancestry trait, so a trait filter alone never finds them.
    // Feats with no traits at all are data gaps for one specific group, not universal feats.
    if (
      !matches &&
      isAncestrySlot &&
      entry.category === 'ancestry' &&
      entry.traits.length > 0 &&
      !entry.traits.some((t) => creatures.has(t))
    ) {
      matches = true;
    }
    if (!matches) continue;

    const taken = timesTaken(entry, ownedKeys);
    if (taken >= (entry.maxTakable ?? 1)) continue;

    const isArchetype =
      isArchetypeGroup ||
      (entry.traits.some((t) => archetypeTraits.includes(t)) &&
        !filterTraits.some(
          (t) => !archetypeTraits.includes(t) && entry.traits.includes(t)
        ));

    const candidate = {
      ...entry,
      effectiveLevel: entry.level,
      isArchetype,
      isDedication: entry.traits.includes('dedication'),
      timesTaken: taken
    };
    results.push(candidate);
    byUuid.set(entry.uuid, candidate);
  }

  // Feats from other classes that an archetype lets you take (journal "Additional Feats")
  const classLike = toTraitList(filter.categories).includes('class');
  const omit = toTraitList(filter.omitTraits);
  const allowsArchetype =
    filterTraits.length === 0 || filterTraits.includes('archetype');
  if (classLike && allowsArchetype && !omit.includes('archetype')) {
    const granted = getGrantedArchetypeFeats();
    const indexByUuid = context.indexByUuid;
    for (const dedication of dedications) {
      for (const extra of granted[dedication] ?? []) {
        if (extra.level > maxLevel) continue;
        const entry =
          indexByUuid.get(extra.uuid) ?? context.indexBySlug.get(extra.slug);
        if (!entry || byUuid.has(entry.uuid)) continue;
        const taken = timesTaken(entry, ownedKeys);
        if (taken >= (entry.maxTakable ?? 1)) continue;
        const candidate = {
          ...entry,
          effectiveLevel: extra.level,
          isArchetype: true,
          isDedication: false,
          grantedBy: dedication,
          grantedByName: context.indexBySlug.get(dedication)?.name ?? dedication,
          timesTaken: taken
        };
        results.push(candidate);
        byUuid.set(entry.uuid, candidate);
      }
    }
  }

  return results;
};

/** Slugs of the dedication feats the actor has (or is about to take) */
export const getDedications = (actor, pendingEntries = []) => {
  const slugs = new Set();
  for (const feat of actor.itemTypes?.feat ?? []) {
    if (feat.system?.traits?.value?.includes('dedication')) {
      slugs.add(feat.slug ?? sluggify(feat.name));
      const original = feat.flags?.babele?.originalName;
      if (original) slugs.add(sluggify(original));
    }
  }
  for (const entry of pendingEntries) {
    if (entry?.traits?.includes('dedication')) slugs.add(entry.slug);
  }
  return slugs;
};

/**
 * Progress towards the archetype rule "you can't take another dedication feat until you have gained two
 * other feats from your archetype". Archetype feats name their dedication as a prerequisite, and feats
 * an archetype unlocks from other classes are listed in the granted-feats data.
 * @param {object[]} pending feats picked earlier in this level-up
 * @returns {{ name: string, count: number }[]} one entry per owned dedication
 */
export const getDedicationProgress = (actor, pending = []) => {
  const granted = getGrantedArchetypeFeats();
  const feats = actor.itemTypes?.feat ?? [];
  const prereqText = (f) =>
    (f.system?.prerequisites?.value ?? f.prerequisites ?? [])
      .map((p) => (typeof p === 'string' ? p : p?.value ?? ''))
      .join(' ')
      .toLowerCase();
  const others = [
    ...feats.map((f) => ({ id: f.id, slug: f.slug ?? sluggify(f.name), text: prereqText(f) })),
    ...pending.map((p) => ({ id: p.uuid, slug: p.slug, text: prereqText(p) }))
  ];

  return feats
    .filter((f) => f.system?.traits?.value?.includes('dedication'))
    .map((dedication) => {
      const slug = dedication.slug ?? sluggify(dedication.name);
      const names = [dedication.name, dedication.flags?.babele?.originalName]
        .filter(Boolean)
        .map((n) => n.toLowerCase());
      const unlocked = new Set((granted[slug] ?? []).map((g) => g.slug));
      const count = others.filter(
        (o) =>
          o.id !== dedication.id &&
          (names.some((n) => o.text.includes(n)) || unlocked.has(o.slug))
      ).length;
      // 'Fighter Dedication' -> 'Fighter' for messages about the archetype
      const archetype =
        dedication.name.replace(/\s*\bdedication\b\s*/i, ' ').trim() || dedication.name;
      return { name: archetype, count };
    });
};

export const buildIndexLookups = (index) => ({
  indexByUuid: new Map(index.map((e) => [e.uuid, e])),
  indexBySlug: new Map(index.map((e) => [e.slug, e]))
});
