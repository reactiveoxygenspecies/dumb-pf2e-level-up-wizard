/**
 * Feat prerequisite evaluation.
 *
 * Nothing here imports Foundry at module level, so the evaluator can be unit
 * tested in plain node. `buildPrereqContext` is the only function that touches
 * a live actor; it reduces the actor to a plain, serializable "ctx" object.
 *
 * The evaluator is deliberately conservative: a line is only 'unmet' when the
 * parser is sure. Anything it cannot interpret is 'unknown'.
 */

const SKILL_SLUGS = [
  'acrobatics',
  'arcana',
  'athletics',
  'crafting',
  'deception',
  'diplomacy',
  'intimidation',
  'medicine',
  'nature',
  'occultism',
  'performance',
  'religion',
  'society',
  'stealth',
  'survival',
  'thievery'
];
const ATTRIBUTES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const ATTRIBUTE_NAMES = {
  strength: 'str',
  dexterity: 'dex',
  constitution: 'con',
  intelligence: 'int',
  wisdom: 'wis',
  charisma: 'cha',
  str: 'str',
  dex: 'dex',
  con: 'con',
  int: 'int',
  wis: 'wis',
  cha: 'cha'
};
const RANKS = { trained: 1, expert: 2, master: 3, legendary: 4 };
const RECALL_KNOWLEDGE_SKILLS = [
  'arcana',
  'crafting',
  'medicine',
  'nature',
  'occultism',
  'religion',
  'society'
];
const TRADITIONS = ['arcane', 'divine', 'occult', 'primal'];
const SIZE_CODES = {
  tiny: 'tiny',
  small: 'sm',
  medium: 'med',
  large: 'lg',
  huge: 'huge',
  gargantuan: 'grg'
};
const NUMBER_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10
};
const SENSES = [
  'darkvision',
  'greater darkvision',
  'low-light vision',
  'scent',
  'tremorsense'
];

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

/** Lowercase, strip diacritics, straighten quotes, collapse whitespace. */
const norm = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Slug in the style of PF2e's sluggify (apostrophes removed). */
const slug = (s) =>
  norm(s)
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&rsquo;': "'",
  '&lsquo;': "'"
};

/**
 * Strip HTML, enrichers (`@UUID[...]{Label}`) and trailing punctuation from a
 * prerequisite line.
 * @param {*} raw
 * @returns {string}
 */
export function cleanPrerequisiteText(raw) {
  let s = String(raw ?? '');
  s = s
    .replace(/@[A-Za-z]+\[[^\]]*\]\{([^}]*)\}/g, '$1')
    .replace(/@[A-Za-z]+\[([^\]]*)\]/g, (_, inner) => {
      const last = String(inner).split(/[.|]/).pop();
      return last ?? '';
    })
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39|rsquo|lsquo);/g, (m) => ENTITIES[m])
    .replace(/\s+/g, ' ')
    .trim();
  return s.replace(/[\s.;:,]+$/, '');
}

const unique = (list) => [...new Set(list)];

const addNames = (set, value) => {
  if (value === undefined || value === null || value === '') return;
  const n = norm(value);
  if (!n) return;
  set.add(n);
  set.add(slug(n));
};

/* ------------------------------------------------------------------ */
/* Context building (runs inside Foundry)                              */
/* ------------------------------------------------------------------ */

const toArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value.contents !== 'undefined') return [...value.contents];
  if (typeof value[Symbol.iterator] === 'function') return [...value];
  return [];
};

const numberOr = (value, fallback) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * Reduce a PF2e character to a plain, serializable context for
 * {@link evaluatePrerequisites}. Every read is defensive; missing fields
 * simply stay empty/undefined.
 *
 * ctx shape:
 * {
 *   level, lang,
 *   skills: { [slug]: 0-4 }, skillLabels: { [slug]: localized label },
 *   lores: { [normalized lore name]: 0-4 },
 *   attributes: { str, dex, con, int, wis, cha } (modifiers),
 *   perception, saves: { fortitude, reflex, will }, classDC, spellRank,
 *   attacks: { [category|group|base]: rank }, defenses: { [category]: rank },
 *   spellcasting: { canCast, slotted, focusPool, traditions[], slottedTraditions[],
 *                   maxSpellRank, spells[] },
 *   feats: string[] (lowercased names, slugs, Babele original names),
 *   classSlug, ancestrySlug, heritageSlug, versatileHeritage, countsAs[],
 *   traits[], deity: { name, slug } | null, languages[], size, senses[],
 *   speeds: { [type]: feet }, classHp, hasFamiliar,
 *   knownNames?: string[]   (optional; see below)
 * }
 *
 * `knownNames` is NOT filled here. Callers may add lowercased names/slugs of
 * every feat and class feature they know of; a bare prerequisite that matches
 * a known name the actor does not own is then reported 'unmet' instead of
 * 'unknown'.
 *
 * @param {object} actor A CharacterPF2e
 * @returns {object}
 */
export function buildPrereqContext(actor) {
  const G = globalThis;
  const sys = actor?.system ?? {};
  const config = G.CONFIG?.PF2E ?? {};
  const localize = (key) => {
    try {
      return G.game?.i18n?.localize?.(key) ?? key;
    } catch {
      return key;
    }
  };

  const skillSlugs = Object.keys(config.skills ?? {}).length
    ? Object.keys(config.skills)
    : SKILL_SLUGS;
  const skills = {};
  const skillLabels = {};
  for (const key of skillSlugs) {
    skills[key] = numberOr(
      actor?.skills?.[key]?.rank,
      numberOr(sys.skills?.[key]?.rank, 0)
    );
    const labelKey = config.skills?.[key]?.label;
    if (labelKey) skillLabels[key] = localize(labelKey);
  }

  const lores = {};
  const addLore = (name, rank) => {
    const key = norm(name);
    if (key) lores[key] = Math.max(lores[key] ?? 0, rank);
  };
  const loreItems = toArray(actor?.itemTypes?.lore);
  for (const item of loreItems) {
    const rank = numberOr(item?.system?.proficient?.value, 0);
    addLore(item.name, rank);
    addLore(item.flags?.babele?.originalName, rank);
  }
  for (const stat of Object.values(actor?.skills ?? {})) {
    if (stat?.lore) addLore(stat.label ?? stat.name, numberOr(stat.rank, 0));
  }

  const attributes = {};
  for (const key of ATTRIBUTES) {
    const mod = sys.abilities?.[key]?.mod;
    if (typeof mod === 'number') attributes[key] = mod;
  }

  const saves = {};
  for (const key of ['fortitude', 'reflex', 'will']) {
    saves[key] = numberOr(
      actor?.saves?.[key]?.rank,
      numberOr(sys.saves?.[key]?.rank, 0)
    );
  }

  const classDCs = Object.values(sys.proficiencies?.classDCs ?? {});
  const classDC = classDCs.length
    ? Math.max(...classDCs.map((c) => numberOr(c?.rank, 0)))
    : numberOr(actor?.classDC?.rank, undefined);

  const rankMap = (record) => {
    const out = {};
    for (const [key, value] of Object.entries(record ?? {})) {
      if (typeof value?.rank === 'number') out[key] = value.rank;
    }
    return out;
  };

  // Spellcasting
  const entries = (
    toArray(actor?.spellcasting).length
      ? toArray(actor.spellcasting)
      : toArray(actor?.itemTypes?.spellcastingEntry)
  ).filter((e) => e?.system && e.id !== 'rituals' && !e.isRitual);
  const entryCategory = (e) => e.category ?? e.system?.prepared?.value;
  const entryTradition = (e) => e.tradition ?? e.system?.tradition?.value;
  const slotted = entries.filter((e) =>
    ['prepared', 'spontaneous'].includes(entryCategory(e))
  );
  let maxSpellRank = 0;
  for (const entry of entries) {
    for (let r = 1; r <= 10; r++) {
      if (numberOr(entry.system?.slots?.[`slot${r}`]?.max, 0) > 0) {
        maxSpellRank = Math.max(maxSpellRank, r);
      }
    }
  }
  const spellItems = toArray(actor?.itemTypes?.spell);
  const spellNames = new Set();
  for (const spell of spellItems) {
    addNames(spellNames, spell.name);
    addNames(spellNames, spell.slug ?? spell.system?.slug);
    addNames(spellNames, spell.flags?.babele?.originalName);
  }
  const focusPool =
    numberOr(sys.resources?.focus?.max, 0) > 0 ||
    entries.some((e) => entryCategory(e) === 'focus' || e.isFocusPool);
  const ranks = entries.map((e) => numberOr(e.rank, 0));
  const spellRank = Math.max(
    numberOr(sys.proficiencies?.spellcasting?.rank, 0),
    ...ranks,
    0
  );
  const traditionsOf = (list) =>
    unique(list.map(entryTradition).filter((t) => TRADITIONS.includes(t)));

  // Feats and class features (class features are `feat` items in PF2e)
  const feats = new Set();
  for (const item of toArray(actor?.items)) {
    if (item?.type !== 'feat') continue;
    const names = [
      item.name,
      item.slug,
      item.system?.slug,
      item.flags?.babele?.originalName
    ];
    for (const name of names) {
      addNames(feats, name);
      // "Assurance (Athletics)" also counts as "Assurance"
      const base = String(name ?? '').replace(/\s*\(.*\)\s*$/, '');
      if (base !== name) addNames(feats, base);
    }
  }

  const deity = actor?.deity
    ? {
        name: actor.deity.name,
        slug: actor.deity.slug ?? slug(actor.deity.name)
      }
    : null;

  const heritage = actor?.heritage;
  const speeds = {};
  const speedSource = sys.movement?.speeds ?? {};
  for (const [type, data] of Object.entries(speedSource)) {
    const value = numberOr(data?.value, undefined);
    if (value !== undefined) speeds[type] = value;
  }

  const languages = toArray(sys.details?.languages?.value).map((l) => norm(l));
  const senses = toArray(sys.perception?.senses).map((s) => norm(s?.type));

  return {
    level: numberOr(actor?.level, numberOr(sys.details?.level?.value, 1)),
    lang: G.game?.i18n?.lang ?? 'en',
    skills,
    skillLabels,
    lores,
    attributes,
    perception: numberOr(
      actor?.perception?.rank,
      numberOr(sys.perception?.rank, 0)
    ),
    saves,
    classDC,
    spellRank,
    attacks: rankMap(sys.proficiencies?.attacks),
    defenses: rankMap(sys.proficiencies?.defenses),
    spellcasting: {
      canCast: entries.length > 0 || spellItems.length > 0,
      slotted: slotted.length > 0,
      focusPool,
      traditions: traditionsOf(entries),
      slottedTraditions: traditionsOf(slotted),
      maxSpellRank,
      spells: [...spellNames]
    },
    feats: [...feats],
    classSlug: actor?.class?.slug ?? null,
    ancestrySlug: actor?.ancestry?.slug ?? null,
    heritageSlug: heritage?.slug ?? null,
    versatileHeritage: heritage
      ? !heritage.system?.ancestry
      : undefined,
    countsAs: toArray(sys.details?.ancestry?.countsAs).map((s) => norm(s)),
    traits: toArray(actor?.traits).map((t) => norm(t)),
    deity,
    languages,
    size: actor?.size ?? sys.traits?.size?.value ?? 'med',
    senses,
    speeds,
    classHp: numberOr(actor?.class?.hpPerLevel, undefined),
    hasFamiliar: !!actor?.familiar
  };
}

/**
 * Return a new ctx with this level-up's pending choices applied.
 * @param {object} ctx
 * @param {object} [pending]
 * @param {string|string[]} [pending.skillIncrease] Skill slug(s) being raised one rank.
 * @param {string[]} [pending.feats] Names or slugs of feats chosen this level.
 * @param {string[]} [pending.attributeBoosts] Attribute keys (str/dex/...) boosted.
 * @returns {object}
 */
export function applyPendingChoices(
  ctx,
  { skillIncrease, feats, attributeBoosts } = {}
) {
  const next = {
    ...ctx,
    skills: { ...ctx.skills },
    lores: { ...ctx.lores },
    attributes: { ...ctx.attributes },
    feats: [...(ctx.feats ?? [])]
  };
  for (const skill of [skillIncrease].flat().filter(Boolean)) {
    const key = norm(skill);
    if (key in next.skills) {
      next.skills[key] = Math.min(4, (next.skills[key] ?? 0) + 1);
    } else if (key in next.lores) {
      next.lores[key] = Math.min(4, (next.lores[key] ?? 0) + 1);
    }
  }
  for (const feat of feats ?? []) {
    if (!feat) continue;
    next.feats.push(norm(feat), slug(feat));
    const base = String(feat).replace(/\s*\(.*\)\s*$/, '');
    if (base !== feat) next.feats.push(norm(base), slug(base));
  }
  for (const attr of attributeBoosts ?? []) {
    const key = ATTRIBUTE_NAMES[norm(attr)];
    if (key) next.attributes[key] = (next.attributes[key] ?? 0) + 1;
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

const anyOf = (list) =>
  list.includes('met')
    ? 'met'
    : list.length && list.every((s) => s === 'unmet')
      ? 'unmet'
      : 'unknown';
const allOf = (list) =>
  list.includes('unmet')
    ? 'unmet'
    : list.length && list.every((s) => s === 'met')
      ? 'met'
      : 'unknown';

const knownSets = new WeakMap();
const indexes = new WeakMap();

function getKnown(ctx) {
  if (!Array.isArray(ctx.knownNames)) return null;
  let set = knownSets.get(ctx.knownNames);
  if (!set) {
    set = new Set();
    for (const name of ctx.knownNames) {
      addNames(set, name);
      const base = String(name).replace(/\s*\(.*\)\s*$/, '');
      if (base !== name) addNames(set, base);
    }
    knownSets.set(ctx.knownNames, set);
  }
  return set;
}

function getIndex(ctx) {
  let idx = indexes.get(ctx);
  if (idx) return idx;
  const owned = new Set();
  for (const f of ctx.feats ?? []) addNames(owned, f);
  addNames(owned, ctx.classSlug);
  addNames(owned, ctx.ancestrySlug);
  addNames(owned, ctx.heritageSlug);
  for (const c of ctx.countsAs ?? []) addNames(owned, c);

  const skillByLabel = new Map(SKILL_SLUGS.map((s) => [s, s]));
  for (const [key, label] of Object.entries(ctx.skillLabels ?? {})) {
    skillByLabel.set(norm(label), key);
    skillByLabel.set(key, key);
  }
  for (const key of Object.keys(ctx.skills ?? {})) skillByLabel.set(key, key);

  const lores = new Map();
  for (const [name, rank] of Object.entries(ctx.lores ?? {})) {
    const key = norm(name).replace(/\s+lore$/, '');
    lores.set(key, Math.max(lores.get(key) ?? 0, rank));
  }

  idx = {
    owned,
    known: getKnown(ctx),
    skillByLabel,
    lores,
    english: /^en/i.test(ctx.lang ?? 'en'),
    dedications: [...owned].some((n) => n.endsWith('-dedication')),
    traits: new Set((ctx.traits ?? []).map(norm)),
    languages: new Set((ctx.languages ?? []).flatMap((l) => [norm(l), slug(l)])),
    senses: new Set((ctx.senses ?? []).map(norm)),
    spells: new Set((ctx.spellcasting?.spells ?? []).map(norm))
  };
  indexes.set(ctx, idx);
  return idx;
}

/** Replace parenthesised/quoted spans so connectors inside are ignored. */
function protect(text) {
  const saved = [];
  const masked = text.replace(/\([^)]*\)|"[^"]*"/g, (m) => {
    saved.push(m);
    return `${saved.length - 1}`;
  });
  return { masked, restore: (s) => s.replace(/(\d+)/g, (_, i) => saved[i]) };
}

/** Split a clause on top-level "or"/"and"/commas. Returns null if atomic. */
function splitClause(text) {
  const { masked, restore } = protect(text);
  const hasOr = /(?:^|[\s,])or\s/i.test(masked);
  const hasAnd = /(?:^|[\s,])and\s/i.test(masked);
  if (!hasOr && !hasAnd) return null;
  // "A or B, C" and "A and B or C" have no reliable grouping; give up on them
  const ambiguous =
    (hasOr && /\sor\s[^,]*,/i.test(masked)) ||
    (hasOr && hasAnd && !/,\s*or\s/i.test(masked));
  if (ambiguous) return { kind: 'ambiguous', parts: [] };
  const kind = hasOr ? 'or' : 'and';
  const connector = hasOr
    ? /\s*,\s*or\s+|\s+or\s+|\s*,\s+/i
    : /\s*,\s*and\s+|\s+and\s+|\s*,\s+/i;
  const parts = masked
    .split(connector)
    .map((p) => restore(p).replace(/^(?:either|both)\s+/i, '').trim())
    .filter(Boolean);
  return parts.length > 1 ? { kind, parts } : null;
}

const PREFIXES = [
  /^(?:trained|expert|master|legendary)(?:\s+proficiency)?(?:\s+(?:in|with|at))?\s+/i,
  /^(?:you\s+)?(?:worship|follow)s?\s+/i,
  /^(?:the\s+)?(?:ability|able)\s+to\s+cast\s+/i,
  /^(?:you\s+)?can\s+cast\s+/i,
  /^(?:worshipper|follower|cleric)\s+of\s+/i,
  /^you\s+speak\s+/i
];
const SUFFIXES =
  /\s+(heritage|trait|size|armor|saves|saving throws?|lore|weapons|languages?|ethnicity|dedication|innovation|muse|order|instinct|racket|methodology|mystery|cause|stance)$/i;

const noConnectors = (s) => !/(?:^|[\s,])(?:and|or)(?:\s|$)|,/i.test(s);

/* --- rank targets -------------------------------------------------- */

const resolveSkill = (name, idx) => idx.skillByLabel.get(norm(name)) ?? null;

/** @returns {{value: number|undefined, sure: boolean}|null} */
function resolveRankTarget(rawTarget, ctx, idx) {
  const t = norm(rawTarget);
  const skill = resolveSkill(t, idx);
  if (skill) return { value: ctx.skills?.[skill], sure: true };

  if (t === 'perception') return { value: ctx.perception, sure: true };
  let m = t.match(/^(fortitude|reflex|will)(?:\s+(?:saves?|saving throws?))?$/);
  if (m) return { value: ctx.saves?.[m[1]], sure: true };
  if (/^(?:a |any |at least one )(?:saving throw|save)s?$/.test(t)) {
    const values = Object.values(ctx.saves ?? {});
    return values.length ? { value: Math.max(...values), sure: true } : null;
  }
  if (/^(?:your )?class dcs?$/.test(t)) {
    return { value: ctx.classDC, sure: true };
  }
  if (/^spell (?:attack rolls?|dcs?|attack)(?: and spell dcs?)?$/.test(t)) {
    return { value: ctx.spellRank, sure: true };
  }

  m = t.match(/^(.+?)\s+lore$/);
  if (m) {
    const key = m[1];
    if (!noConnectors(key)) return null;
    if (idx.lores.has(key)) return { value: idx.lores.get(key), sure: true };
    if (/^(?:a|any|at least one)$/.test(key)) return null;
    return { value: 0, sure: idx.english };
  }
  if (/^(?:(?:a|any|at least one) )?lore(?: skill)?$/.test(t)) {
    const values = [...idx.lores.values()];
    return { value: values.length ? Math.max(...values) : 0, sure: true };
  }
  if (
    /^(?:a |any |at least one )(?:skill (?:used to |that can be used to ))?(?:skill with the )?recall knowledge(?: action| skill)?$/.test(
      t
    ) ||
    /^(?:a |any |at least one )skill (?:with|that has) the recall knowledge action$/.test(
      t
    )
  ) {
    const values = [
      ...RECALL_KNOWLEDGE_SKILLS.map((s) => ctx.skills?.[s] ?? 0),
      ...idx.lores.values()
    ];
    return { value: Math.max(...values), sure: false };
  }
  if (/^(?:a |any |at least one )skill$/.test(t)) {
    const values = [...Object.values(ctx.skills ?? {}), ...idx.lores.values()];
    return values.length ? { value: Math.max(...values), sure: false } : null;
  }

  // Armor
  m = t.match(/^(light|medium|heavy|unarmored)(?:\s+(?:armor|defense))?$/);
  if (m) return { value: ctx.defenses?.[m[1]], sure: true };

  // Weapons
  const w = t.replace(/^(?:all|any|the)\s+/, '');
  m = w.match(/^(simple|martial|advanced)\s+weapons?$/);
  if (m) return { value: ctx.attacks?.[m[1]], sure: true };
  if (/^unarmed(?:\s+attacks?)?$/.test(w)) {
    return { value: ctx.attacks?.unarmed, sure: true };
  }
  if (
    /^(?:a |any |any kind of |at least one )(?:melee |ranged )?weapon(?: or unarmed attacks?)?$/.test(
      w
    ) ||
    /^(?:a |any |at least one )weapon$/.test(t)
  ) {
    const cats = ['simple', 'martial', 'advanced', 'unarmed'];
    const values = cats.map((c) => ctx.attacks?.[c] ?? 0);
    return { value: Math.max(...values), sure: false };
  }
  const key = slug(w.replace(/\s+(?:weapons?|attacks?)$/, '')).replace(
    /s$/,
    ''
  );
  if (key && ctx.attacks && key in ctx.attacks) {
    return { value: ctx.attacks[key], sure: true };
  }
  return null;
}

function compareRank(need, target) {
  if (!target || typeof target.value !== 'number') return 'unknown';
  if (target.value >= need) return 'met';
  return target.sure ? 'unmet' : 'unknown';
}

/* --- feat names ---------------------------------------------------- */

function nameCandidates(text) {
  const t = norm(text);
  const stripped = t
    .replace(/^(?:the|a|an)\s+/, '')
    .replace(
      /\s+(?:skill feat|class feat|ancestry feat|general feat|feat|class feature|feature)$/,
      ''
    );
  const noClassSuffix = stripped.replace(
    /\s+(?:muse|racket|methodology|innovation|hybrid study|cause|mystery|subconscious mind|doctrine)$/,
    ''
  );
  const exact = unique([t, stripped, noClassSuffix]);
  const bases = [];
  const inMatch = stripped.match(/^(.+?)\s+in\s+([^()]+)$/);
  if (
    inMatch &&
    noConnectors(inMatch[2]) &&
    !/^(?:that|this|those|the|your|an?|any|at|all)\b/.test(inMatch[2])
  ) {
    exact.push(`${inMatch[1]} (${inMatch[2]})`);
    bases.push(inMatch[1]);
  }
  const paren = stripped.match(/^(.+?)\s*\(.+\)$/);
  if (paren && noConnectors(paren[1])) bases.push(paren[1]);
  return { exact, bases };
}

/** @returns {'met'|'unmet'|'unknown'|null} null when the name is not recognised */
function resolveFeatName(text, idx) {
  const { exact, bases } = nameCandidates(text);
  const has = (set, id) => set?.has(id) || set?.has(slug(id));
  if (exact.some((id) => has(idx.owned, id))) return 'met';
  if (bases.length) {
    if (bases.some((id) => has(idx.owned, id))) return 'unknown';
    if (bases.some((id) => has(idx.known, id))) return 'unmet';
    return null;
  }
  if (exact.some((id) => has(idx.known, id))) return 'unmet';
  return null;
}

/* --- atoms --------------------------------------------------------- */

function deityMatches(deity, name) {
  const n = norm(name);
  return !!deity && (norm(deity.name) === n || deity.slug === slug(n));
}

function evalDeity(t, ctx) {
  const deity = ctx.deity;
  const known = deity !== undefined;
  if (
    /^(?:you\s+)?(?:can(?:'|)t|cannot|can not)\s+have\s+(?:a|an)\s+(?:patron\s+)?deity$/.test(
      t
    ) ||
    /^(?:you\s+)?(?:don't|do not|doesn't|aren't)\s+(?:have|follow|worship)\s+(?:a|an)\s+(?:patron\s+)?deity$/.test(
      t
    ) ||
    /^(?:you\s+)?(?:have|follow|worship)\s+no\s+(?:patron\s+)?deity$/.test(t) ||
    /^no\s+(?:patron\s+)?deity$/.test(t) ||
    /^(?:without|having no)\s+(?:a\s+)?deity$/.test(t)
  ) {
    return known ? (deity === null ? 'met' : 'unmet') : 'unknown';
  }
  if (/^(?:you\s+)?(?:follow|worship)s?\s+(?:a|an|any)\s+deity$/.test(t)) {
    return known ? (deity === null ? 'unmet' : 'met') : 'unknown';
  }
  if (/^(?:you\s+)?(?:follow|worship)s?\s+(?:a|an)\s+[\w-]+-aligned\s+deity$/.test(t)) {
    return known && deity === null ? 'unmet' : 'unknown';
  }
  if (/^worshipper of a specific deity$/.test(t) || /^follower of a specific religion$/.test(t)) {
    return known && deity === null ? 'unmet' : 'unknown';
  }
  let m = t.match(
    /^(?:(?:you\s+)?(?:worship|follow)s?|(?:a\s+)?(?:worshipper|follower)\s+of|(?:your\s+)?deity\s+is)\s+(?!a\s|an\s|the\s|any\s)(.+)$/
  );
  if (
    m &&
    noConnectors(m[1]) &&
    !/\b(?:deity|deities|religion|philosophy|patron|patrons|god|gods)\b/.test(m[1])
  ) {
    if (!known) return 'unknown';
    if (deity === null) return 'unmet';
    return deityMatches(deity, m[1]) ? 'met' : 'unmet';
  }
  m = t.match(/^not\s+a\s+(?:worshipper|follower)\s+of\s+(.+)$/);
  if (m && noConnectors(m[1])) {
    if (!known) return 'unknown';
    return deity === null || !deityMatches(deity, m[1]) ? 'met' : 'unmet';
  }
  return null;
}

function evalSpellcasting(t, ctx, idx) {
  const sc = ctx.spellcasting;
  const state = (flag, onTrue = 'met') =>
    !sc || typeof flag !== 'boolean' ? 'unknown' : flag ? onTrue : 'unmet';
  const traditionTest = (list) => {
    if (!sc) return 'unknown';
    return anyOf(list.map((x) => (sc.traditions?.includes(x) ? 'met' : 'unmet')));
  };

  if (/^(?:a\s+|the\s+|you have a\s+)?focus pool$/.test(t)) {
    return state(sc?.focusPool);
  }
  let m = t.match(
    /^(?:you have\s+)?(?:an?\s+|the\s+)?spellcasting\s+(?:class\s+)?feature(?:\s+with the\s+(.+?)\s+tradition)?$/
  );
  if (m) {
    if (!sc) return 'unknown';
    if (!m[1]) return state(sc.slotted);
    const wanted = m[1].split(/\s+or\s+/);
    if (!wanted.every((w) => TRADITIONS.includes(w))) return 'unknown';
    return anyOf(
      wanted.map((x) => (sc.slottedTraditions?.includes(x) ? 'met' : 'unmet'))
    );
  }
  m = t.match(/^(arcane|divine|occult|primal)\s+spells?$/);
  if (m) return traditionTest([m[1]]);

  m = t.match(
    /^(?:(?:you(?:'re| are)\s+)?(?:the\s+)?(?:ability|able)\s+to\s+cast|(?:you\s+)?can\s+cast)\s+(.+)$/
  );
  if (!m) return null;
  const rest = m[1].trim();
  if (/^spells?$/.test(rest)) return state(sc?.canCast);
  if (/^spells?\s+(?:from|using)\s+(?:spell\s+)?slots$/.test(rest)) return state(sc?.slotted);
  if (/^focus\s+spells?$/.test(rest)) return state(sc?.focusPool);
  let r = rest.match(/^(\d+)(?:st|nd|rd|th)[- ]rank\s+spells?$/);
  if (r) {
    if (!sc || typeof sc.maxSpellRank !== 'number') return 'unknown';
    return sc.maxSpellRank >= Number(r[1]) ? 'met' : 'unmet';
  }
  r = rest.match(/^(?:an?\s+|at least one\s+)?(arcane|divine|occult|primal)(?:\s+spells?)?$/);
  if (r) return traditionTest([r[1]]);
  if (!noConnectors(rest) || /^(?:at least|an?\s|\d)/.test(rest)) return null;
  const spell = rest.replace(/^the\s+/, '').replace(/\s+(?:cantrip|spell)$/, '');
  return idx.spells.has(norm(spell)) || idx.spells.has(slug(spell))
    ? 'met'
    : 'unknown';
}

/** Evaluate a single clause. Returns null when no rule recognises it. */
function evalAtom(text, ctx, idx) {
  const t = norm(text);
  if (!t) return null;
  let m;

  // Attributes: "Strength +2", "Str 14"
  m = t.match(
    /^(strength|dexterity|constitution|intelligence|wisdom|charisma|str|dex|con|int|wis|cha)\s*:?\s*([+-]?\d+)$/
  );
  if (m) {
    const key = ATTRIBUTE_NAMES[m[1]];
    const raw = Number(m[2]);
    const signed = /^[+-]/.test(m[2]);
    const need = signed || raw < 8 ? raw : Math.floor((raw - 10) / 2);
    const have = ctx.attributes?.[key];
    if (typeof have !== 'number') return 'unknown';
    return have >= need ? 'met' : 'unmet';
  }

  // Level
  m =
    t.match(/^(?:character\s+)?level\s+(\d+)(?:\s+or\s+(?:higher|greater))?$/) ??
    t.match(/^(?:at least\s+)?(\d+)(?:st|nd|rd|th)[- ]level(?:\s+or\s+higher)?$/);
  if (m) {
    return typeof ctx.level === 'number'
      ? ctx.level >= Number(m[1])
        ? 'met'
        : 'unmet'
      : 'unknown';
  }

  // Rank in something
  m = t.match(
    /^(trained|expert|master|legendary)(?:\s+proficiency)?(?:\s+(?:in|with|at))?\s+(.+)$/
  );
  if (m) {
    const need = RANKS[m[1]];
    const target = m[2].replace(/^either\s+/, '');
    if (/\bdepending on\b/.test(target)) return 'unknown';
    const count = target.match(
      /^at least (one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:other\s+)?skills?$/
    );
    if (count) {
      const n = NUMBER_WORDS[count[1]] ?? Number(count[1]);
      const ranks = [...Object.values(ctx.skills ?? {}), ...idx.lores.values()];
      return ranks.filter((r) => r >= need).length >= n ? 'met' : 'unmet';
    }
    const resolved = resolveRankTarget(target, ctx, idx);
    if (resolved) return compareRank(need, resolved);
    return null;
  }

  // Dedications
  if (/^(?:an?|any)\s+(?:other\s+)?dedication(?:\s+feat)?$/.test(t)) {
    return idx.dedications ? 'met' : 'unmet';
  }

  // Deity
  const deityResult = evalDeity(t, ctx);
  if (deityResult) return deityResult;

  // Spellcasting
  const spellResult = evalSpellcasting(t, ctx, idx);
  if (spellResult) return spellResult;

  // Hit points per level of class
  m = t.match(
    /^class granting no more hit points per level than (\d+) \+ your constitution modifier$/
  );
  if (m) {
    return typeof ctx.classHp === 'number'
      ? ctx.classHp <= Number(m[1])
        ? 'met'
        : 'unmet'
      : 'unknown';
  }

  // Heritage
  if (/^(?:you have\s+)?(?:an?\s+)?versatile\s+heritage$/.test(t)) {
    return typeof ctx.versatileHeritage === 'boolean'
      ? ctx.versatileHeritage
        ? 'met'
        : 'unmet'
      : 'unknown';
  }
  m = t.match(/^(.+?)\s+heritage$/);
  if (
    m &&
    noConnectors(m[1]) &&
    m[1].split(' ').length <= 4 &&
    !/^(?:a|an|any|the|one|you|your)\b/.test(m[1])
  ) {
    if (!ctx.heritageSlug) return 'unknown';
    return ctx.heritageSlug === slug(m[1]) ? 'met' : 'unmet';
  }

  // Traits
  m = t.match(/^(.+?)\s+trait$/);
  if (m && noConnectors(m[1]) && m[1].split(' ').length <= 3) {
    if (!Array.isArray(ctx.traits)) return 'unknown';
    if (idx.traits.has(slug(m[1]))) return 'met';
    return ['holy', 'unholy'].includes(m[1]) ? 'unknown' : 'unmet';
  }

  // Size
  m = t.match(/^(tiny|small|medium|large|huge|gargantuan)\s+size$/);
  if (m) {
    return ctx.size ? (ctx.size === SIZE_CODES[m[1]] ? 'met' : 'unmet') : 'unknown';
  }

  // Languages
  m = t.match(/^you speak at least (one|two|three|four|five|six|\d+) languages$/);
  if (m) {
    const n = NUMBER_WORDS[m[1]] ?? Number(m[1]);
    return Array.isArray(ctx.languages)
      ? ctx.languages.length >= n
        ? 'met'
        : 'unmet'
      : 'unknown';
  }
  m = t.match(/^(?:you speak\s+(.+)|(.+?)\s+languages?)$/);
  if (m) {
    const lang = m[1] ?? m[2];
    if (noConnectors(lang) && !/^(?:a|an|any|at least)\b/.test(lang)) {
      return idx.languages.has(slug(lang)) ? 'met' : 'unknown';
    }
  }

  // Senses
  if (SENSES.includes(t)) {
    return idx.senses.has(t) || idx.senses.has(slug(t)) ? 'met' : 'unknown';
  }

  // Speeds
  m = t.match(/^(?:you\s+)?(don't have|do not have|have)\s+an?\s+(burrow|climb|fly|swim)\s+speed$/);
  if (m && ctx.speeds) {
    const has = (ctx.speeds[m[2]] ?? 0) > 0;
    return (m[1] === 'have') === has ? 'met' : 'unmet';
  }
  m = t.match(/^(burrow|climb|fly|swim)\s+speed of at least (\d+) feet$/);
  if (m && ctx.speeds) {
    return (ctx.speeds[m[1]] ?? 0) >= Number(m[2]) ? 'met' : 'unmet';
  }

  // Companions can come from many sources; only owning the feature is certain
  if (
    /^(?:you have\s+)?(?:an?\s+)?(?:animal |construct |undead )?(?:companion|familiar)$/.test(
      t
    )
  ) {
    if (t.endsWith('familiar') && ctx.hasFamiliar === true) return 'met';
    return 'unknown';
  }

  return null;
}

/**
 * Evaluate one prerequisite clause; null means "no rule matched".
 * With `structural`, bare-name guesses (known-name 'unmet', dedications) are skipped.
 */
function evalClause(text, ctx, idx, depth = 0, structural = false) {
  if (!text || depth > 4) return null;
  const nameResult = resolveFeatName(text, idx);
  if (nameResult === 'met') return 'met';

  const atom = evalAtom(text, ctx, idx);
  if (atom) return atom;

  if (nameResult && !structural) return nameResult;

  const split = splitClause(text);
  if (split?.kind === 'ambiguous') return 'unknown';
  if (split) {
    const combine = split.kind === 'or' ? anyOf : allOf;
    const firstPrefix = PREFIXES.map((re) => split.parts[0].match(re)?.[0]).find(Boolean);
    const lastSuffix = split.parts[split.parts.length - 1].match(SUFFIXES)?.[0];
    const statuses = split.parts.map((part, i) => {
      const variants = [];
      const canPrefix = i > 0 && firstPrefix && !PREFIXES.some((re) => re.test(part));
      const canSuffix = lastSuffix && !SUFFIXES.test(part);
      if (canPrefix) variants.push(firstPrefix + part);
      if (canSuffix) variants.push(part + lastSuffix);
      if (canPrefix && canSuffix) variants.push(firstPrefix + part + lastSuffix);
      for (const attempt of variants) {
        const result = evalClause(attempt, ctx, idx, depth + 1, true);
        if (result) return result;
      }
      const bare = evalClause(part, ctx, idx, depth + 1, structural);
      if (bare) return bare;
      if (canSuffix) {
        return evalClause(part + lastSuffix, ctx, idx, depth + 1, structural) ?? 'unknown';
      }
      return 'unknown';
    });
    return combine(statuses);
  }

  if (!structural && /^[\w' -]+ dedication$/.test(norm(text))) return 'unmet';
  return null;
}

/**
 * Evaluate a feat's prerequisites against a context.
 * @param {object|Array<{value:string}|string>|string} prereqs `system.prerequisites`, its `.value`, or strings
 * @param {object} ctx From {@link buildPrereqContext} (or hand built)
 * @returns {{status: 'met'|'unmet'|'unknown', results: Array<{text: string, status: 'met'|'unmet'|'unknown'}>}}
 */
export function evaluatePrerequisites(prereqs, ctx) {
  const list = Array.isArray(prereqs)
    ? prereqs
    : Array.isArray(prereqs?.value)
      ? prereqs.value
      : typeof prereqs === 'string'
        ? [prereqs]
        : [];
  const idx = getIndex(ctx ?? {});
  const results = list
    .map((entry) =>
      cleanPrerequisiteText(typeof entry === 'string' ? entry : entry?.value)
    )
    .filter(Boolean)
    .map((text) => {
      let status = 'unknown';
      try {
        status = evalClause(text, ctx ?? {}, idx) ?? 'unknown';
      } catch {
        status = 'unknown';
      }
      return { text, status };
    });
  const statuses = results.map((r) => r.status);
  const status = statuses.includes('unmet')
    ? 'unmet'
    : statuses.includes('unknown')
      ? 'unknown'
      : 'met';
  return { status, results };
}
