import { MODULE_ID } from '../constants.js';
import { localize } from '../helpers/utility.js';

export const TRADITIONS = ['arcane', 'divine', 'occult', 'primal'];
const RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

let classData = null;

/** Per-class spellcasting rules generated from PF2e's class journal (scripts/build-spellcasting.mjs) */
export const loadSpellcastingData = async () => {
  if (classData) return classData;
  try {
    classData = await foundry.utils.fetchJsonWithTimeout(
      `modules/${MODULE_ID}/src/data/spellcasting.json`
    );
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to load spellcasting data`, error);
    classData = {};
  }
  return classData;
};

/** For tests and tools: use data that was loaded some other way */
export const setSpellcastingData = (data) => {
  classData = data;
};

/** Spellcasting rules for a class slug, when the module can automate that class */
export const classRules = (slug) => {
  const rules = classData?.[slug];
  return rules?.automate ? rules : null;
};

const at = (list, level) => (Array.isArray(list) ? (list[Math.max(1, Math.min(level, 20)) - 1] ?? 0) : 0);

/**
 * Slots per rank (0 = cantrips) at a level, including the extra slots the class always has
 * (wizard curriculum, cleric divine font, magus studious spells).
 */
export const slotsAt = (rules, level) => {
  const extra = rules.extraSlots;
  const slots = { 0: at(rules.cantrips, level) + at(extra?.cantrips, level) };
  for (const rank of RANKS) {
    slots[rank] = at(rules.slots?.[rank], level) + at(extra?.slots?.[rank], level);
  }
  return slots;
};

/** Ranks with a regular slot at a level */
const ranksAt = (rules, level) => RANKS.filter((r) => at(rules.slots?.[r], level) > 0);

/** Highest spell rank with a slot at a level */
export const maxRankAt = (rules, level) => ranksAt(rules, level).pop() ?? 0;

/* -------------------------------------------- */
/*  Finding the class entry                     */
/* -------------------------------------------- */

const entryFlag = (entry) => entry.flags?.[MODULE_ID]?.classEntry ?? null;

/**
 * The spellcasting entry this module manages for the actor's class: one flagged by the module, or
 * an existing entry of the class's kind (same preparation, and the class tradition if it has one).
 */
export const findClassEntry = (actor, rules, slug) => {
  const entries = actor.itemTypes?.spellcastingEntry ?? [];
  const flagged = entries.find((e) => entryFlag(e) === slug);
  if (flagged) return { entry: flagged, adopted: false };
  const candidate = entries.find((e) => {
    const prepared = e.system?.prepared?.value;
    if (prepared !== rules.preparation) return false;
    const tradition = e.system?.tradition?.value;
    return !rules.tradition || tradition === rules.tradition;
  });
  return candidate ? { entry: candidate, adopted: true } : null;
};

/** The tradition for a class: fixed, read from the actor (witch patrons), or null when unknown */
export const detectTradition = (actor, rules, slug) => {
  if (rules.tradition) return rules.tradition;
  const alias = actor?.system?.proficiencies?.aliases?.[slug];
  if (TRADITIONS.includes(alias)) return alias;
  return null;
};

/* -------------------------------------------- */
/*  What a level change needs                   */
/* -------------------------------------------- */

/** Spells an entry holds, counted by base rank (0 = cantrips) */
const spellsByRank = (entry) => {
  const counts = { 0: 0 };
  for (const rank of RANKS) counts[rank] = 0;
  const spells = entry?.spells ?? [];
  for (const spell of spells) {
    const rank = spell.isCantrip ? 0 : (spell.baseRank ?? 1);
    counts[rank] = (counts[rank] ?? 0) + 1;
  }
  return counts;
};

/**
 * Spell choices for reaching `toLevel`. Repertoires and familiars count what the entry already holds,
 * so the same call works for a new character, a level-up, or a character set up late.
 * @returns {{ kind: string, rank: number|null, maxRank: number|null, count: number, label: string }[]}
 */
export const spellPicks = (rules, entry, fromLevel, toLevel) => {
  const have = entry ? spellsByRank(entry) : { 0: 0 };
  const picks = [];
  let minRank = null;
  const push = (kind, rank, count, maxRank = null) => {
    if (count > 0) picks.push({ kind, rank, maxRank, minRank, count, key: `${kind}-${rank ?? 'any'}` });
  };

  const rep = rules.repertoire;
  if (rep) {
    push('repertoire', 0, at(rep.cantrips, toLevel) - (have[0] ?? 0));
    if (rep.ranks) {
      for (const rank of RANKS) push('repertoire', rank, at(rep.ranks[rank], toLevel) - (have[rank] ?? 0));
    } else if (rep.total) {
      // Summoner: a total split freely between the ranks the class still has slots for
      const ranks = ranksAt(rules, toLevel);
      const held = ranks.reduce((n, r) => n + (have[r] ?? 0), 0);
      minRank = ranks[0] ?? 1;
      push('repertoire', null, at(rep.total, toLevel) - held, ranks.at(-1) ?? 1);
      minRank = null;
    }
  }

  const book = rules.spellbook ?? rules.familiar;
  if (book) {
    const kind = rules.spellbook ? 'spellbook' : 'familiar';
    const curriculum = book.curriculum ?? null;
    // Wizards add a curriculum spell for every new rank of slots
    const newRanks = (from) => ranksAt(rules, toLevel).length - ranksAt(rules, Math.max(1, from)).length;
    if (!entry || fromLevel < 1) {
      push(kind, 0, (book.cantrips ?? 0) - (have[0] ?? 0));
      push(kind, 1, (book.firstRank ?? 0) + (curriculum?.firstRank ?? 0) - (have[1] ?? 0));
      // Spells added for levels beyond 1 when a character is set up late
      const later = (book.perLevel ?? 0) * Math.max(0, toLevel - 1) + (curriculum?.perNewRank ?? 0) * newRanks(1);
      push(kind, null, later, maxRankAt(rules, toLevel));
    } else {
      const later =
        (book.perLevel ?? 0) * Math.max(0, toLevel - fromLevel) + (curriculum?.perNewRank ?? 0) * newRanks(fromLevel);
      push(kind, null, later, maxRankAt(rules, toLevel));
    }
  }

  return picks.map((p) => ({ ...p, label: pickLabel(p) }));
};

const rankName = (rank) =>
  rank === 0 ? localize('spells.cantrips') : localize('spells.rank', { rank });

const pickLabel = (pick) => {
  if (pick.rank === null && pick.minRank > 1) {
    return localize('spells.rankRange', { min: pick.minRank, max: pick.maxRank });
  }
  if (pick.rank === null && (pick.maxRank ?? 1) <= 1) return rankName(1);
  if (pick.rank === null) return localize('spells.anyRank', { rank: pick.maxRank });
  return rankName(pick.rank);
};

/** Slot changes for the entry, as `{ rank, from, to }` for every rank that changes */
export const slotChanges = (rules, entry, level) => {
  const target = slotsAt(rules, level);
  const changes = [];
  for (const rank of [0, ...RANKS]) {
    const current = entry?.system?.slots?.[`slot${rank}`]?.max ?? 0;
    if (current !== target[rank]) changes.push({ rank, from: current, to: target[rank], label: rankName(rank) });
  }
  return changes;
};

/* -------------------------------------------- */
/*  Signature spells                            */
/* -------------------------------------------- */

/**
 * Signature spells at a level: `{ mode, ranks }`, or null when the class has none (yet).
 * Mode "onePerRank": one chosen spell per rank (bard, sorcerer, oracle, psychic).
 * Mode "all": every repertoire spell is a signature spell (summoner).
 * 10th-rank spells can't be signature spells.
 */
export const signatureAt = (rules, level) => {
  const sig = rules?.signatureSpells;
  if (!sig || level < (sig.fromLevel ?? 1)) return null;
  return { mode: sig.mode ?? 'onePerRank', ranks: ranksAt(rules, level).filter((r) => r <= 9) };
};

/** The entry's current signature spells, as rank → `item:<id>` */
export const currentSignatures = (entry) => {
  const out = {};
  for (const spell of entry?.spells ?? []) {
    if (spell.isCantrip || !spell.system?.location?.signature) continue;
    out[spell.baseRank] ??= `item:${spell.id}`;
  }
  return out;
};

/**
 * Whether a spell should be a signature spell after this change.
 * @param {{ mode: string }} sig from `signatureAt`
 * @param {Record<number, string>} choice rank → `item:<id>` or `new:<uuid>`
 * @param {string} key the spell's key in the same form
 * @param {boolean} cantrip
 */
export const isSignature = (sig, choice, key, cantrip) => {
  if (!sig || cantrip) return false;
  if (sig.mode === 'all') return true;
  return Object.values(choice ?? {}).includes(key);
};

/* -------------------------------------------- */
/*  Sources and updates                         */
/* -------------------------------------------- */

/** A new spellcasting entry for the class, with slots for the level */
export const entrySource = (rules, { slug, className, tradition, attribute, level }) => {
  const slots = slotsAt(rules, level);
  return {
    type: 'spellcastingEntry',
    name: localize('spells.entryName', { className }),
    system: {
      ability: { value: attribute ?? '' },
      tradition: { value: tradition ?? '' },
      prepared: { value: rules.preparation, flexible: false },
      proficiency: { slug: '', value: 1 },
      showSlotlessLevels: { value: false },
      autoHeightenLevel: { value: null },
      slots: Object.fromEntries(
        [0, ...RANKS].map((rank) => [
          `slot${rank}`,
          { max: slots[rank], value: slots[rank], prepared: [] }
        ])
      )
    },
    flags: { [MODULE_ID]: { classEntry: slug } }
  };
};

/** Item update that sets an existing entry's slot maximums for a level (and flags it as managed) */
export const entrySlotUpdate = (rules, entry, slug, level) => {
  const slots = slotsAt(rules, level);
  const update = { _id: entry.id, [`flags.${MODULE_ID}.classEntry`]: slug };
  for (const rank of [0, ...RANKS]) {
    const key = `slot${rank}`;
    const current = entry.system?.slots?.[key] ?? {};
    if ((current.max ?? 0) === slots[rank]) continue;
    update[`system.slots.${key}.max`] = slots[rank];
    // Spontaneous casters spend `value` as they cast: new slots arrive unspent. Prepared casters
    // don't spend it, so it simply follows the maximum.
    update[`system.slots.${key}.value`] =
      rules.preparation === 'spontaneous'
        ? Math.min(slots[rank], Math.max(0, (current.value ?? 0) + slots[rank] - (current.max ?? 0)))
        : slots[rank];
  }
  return update;
};

/** Snapshot of an entry's slots, to restore on undo */
export const entrySlotSnapshot = (entry) =>
  Object.fromEntries(
    [0, ...RANKS].map((rank) => {
      const s = entry.system?.slots?.[`slot${rank}`] ?? {};
      return [rank, { max: s.max ?? 0, value: s.value ?? 0 }];
    })
  );

/** Spell item source placed in an entry */
export const spellSource = async (uuid, entryId) => {
  const doc = await fromUuid(uuid);
  if (!doc) throw new Error(`Spell not found: ${uuid}`);
  const source = doc.toObject();
  delete source._id;
  delete source.folder;
  delete source.sort;
  delete source.ownership;
  foundry.utils.setProperty(source, '_stats.compendiumSource', doc.uuid);
  source.system.location = { value: entryId };
  return source;
};

/* -------------------------------------------- */
/*  Picker                                      */
/* -------------------------------------------- */

/**
 * Spells that fit a pick: the tradition, the rank (or any rank up to the maximum), not already known,
 * and not hidden by the GM's rarity setting.
 */
export const spellCandidates = (index, pick, { tradition, known = new Set(), hiddenRarities = [] }) =>
  index.filter((s) => {
    if (hiddenRarities.includes(s.rarity)) return false;
    if (tradition && !s.traditions.includes(tradition)) return false;
    if (known.has(s.uuid) || known.has(s.slug)) return false;
    if (pick.rank === 0) return s.cantrip;
    if (s.cantrip) return false;
    if (pick.rank === null) return s.rank >= (pick.minRank ?? 1) && s.rank <= (pick.maxRank ?? 1);
    return s.rank === pick.rank;
  });
