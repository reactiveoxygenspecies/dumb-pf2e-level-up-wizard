import { ATTRIBUTE_SETS, MODULE_ID, systemId, systemSetting } from '../constants.js';
import {
  attributeLabel,
  enrichHTML,
  localize,
  rankLabel,
  signedNumber
} from '../helpers/utility.js';

/* -------------------------------------------- */
/*  Skills                                      */
/* -------------------------------------------- */

/** Highest rank a skill increase can reach at a level (Player Core p. 37) */
export const maxSkillRankForLevel = (level) => (level >= 15 ? 4 : level >= 7 ? 3 : 2);

const countLevelsInRange = (levels, previousLevel, targetLevel) =>
  (levels ?? []).filter((l) => l > previousLevel && l <= targetLevel).length;

export const getSkillIncreaseCount = (preview, previousLevel, targetLevel) =>
  countLevelsInRange(
    preview.class?.system?.skillIncreaseLevels?.value,
    previousLevel,
    targetLevel
  );

/**
 * Every skill and lore on the actor, with current/next rank. Ranks come from the prepared actor so that
 * rule elements that already raised a rank are respected (the increase then goes one above that).
 */
export const getSkillOptions = (actor) => {
  const options = [];
  for (const [slug, statistic] of Object.entries(actor.skills ?? {})) {
    if (!statistic) continue;
    const isLore = !!statistic.lore;
    const loreItem = isLore
      ? actor.itemTypes?.lore?.find((l) => l.slug === slug)
      : null;
    if (isLore && !loreItem) continue;
    options.push({
      slug,
      label: statistic.label ?? slug,
      rank: statistic.rank ?? 0,
      modifier: statistic.mod ?? statistic.check?.mod ?? 0,
      isLore,
      itemId: loreItem?.id ?? null
    });
  }
  return options.sort(
    (a, b) => Number(a.isLore) - Number(b.isLore) || a.label.localeCompare(b.label)
  );
};

export const describeSkillOption = (skill, increaseBy = 1) => {
  const mode = game.settings.get(MODULE_ID, 'skill-increase-info');
  const next = Math.min(skill.rank + increaseBy, 4);
  const mod = signedNumber(skill.modifier);
  const rank = `${rankLabel(skill.rank)} → ${rankLabel(next)}`;
  switch (mode) {
    case 'NAME_WITH_MOD':
      return `${skill.label} ${mod}`;
    case 'NAME_WITH_RANK':
      return `${skill.label} (${rank})`;
    case 'NAME_WITH_MOD_AND_RANK':
      return `${skill.label} ${mod} (${rank})`;
    default:
      return skill.label;
  }
};

/* -------------------------------------------- */
/*  Attribute boosts                            */
/* -------------------------------------------- */

const ATTRIBUTES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const PARTIAL_BOOST_THRESHOLD = 5;

/**
 * Attribute boost sets that gain new boosts in this level-up. Uses the system's own `allowedBoosts`
 * on the preview actor, which already accounts for the gradual ability boosts variant.
 */
export const getBoostSets = (actor, preview) => {
  const build = actor.system.build?.attributes;
  if (!build) return { manual: false, sets: [] };
  if (build.manual) return { manual: true, sets: [] };

  const sets = [];
  for (const set of ATTRIBUTE_SETS) {
    const allowed = preview.system.build?.attributes?.allowedBoosts?.[set] ?? 0;
    const existing = [
      ...(actor._source.system.build?.attributes?.boosts?.[set] ?? [])
    ];
    const remaining = allowed - existing.length;
    if (remaining > 0) sets.push({ set, allowed, existing, remaining });
  }
  return { manual: false, sets };
};

/** Boost counts per attribute, as PF2e's attribute builder computes them */
const boostCounts = (build, overrides) => {
  const boosts = { ...build.boosts, ...overrides };
  return Object.fromEntries(
    ATTRIBUTES.map((attr) => [
      attr,
      {
        base:
          (boosts.ancestry?.includes(attr) ? 1 : 0) +
          (boosts.background?.includes(attr) ? 1 : 0) +
          (boosts.class === attr ? 1 : 0) +
          (boosts[1]?.includes(attr) ? 1 : 0),
        flaw: build.flaws?.ancestry?.includes(attr) ? 1 : 0,
        sets: Object.fromEntries(
          ATTRIBUTE_SETS.map((s) => [s, boosts[s]?.includes(attr) ? 1 : 0])
        )
      }
    ])
  );
};

/** True if boosting `attr` in `set` only grants a partial boost (odd count at or above +4) */
const isPartialBoost = (counts, attr, set) => {
  const c = counts[attr];
  const total =
    c.base + ATTRIBUTE_SETS.filter((s) => s <= set).reduce((n, s) => n + c.sets[s], 0);
  const net = total - c.flaw;
  return net >= PARTIAL_BOOST_THRESHOLD && net % 2 === 1;
};

/**
 * Display data for the boost buttons of every set, given the current selections.
 * @param {Record<number, string[]>} selected new boosts chosen per set
 */
export const describeBoosts = (actor, boostSets, selected) => {
  const build = actor.system.build.attributes;
  const overrides = {};
  for (const { set, existing } of boostSets) {
    overrides[set] = [...existing, ...(selected[set] ?? [])];
  }
  const counts = boostCounts(build, overrides);

  const gains = Object.fromEntries(ATTRIBUTES.map((a) => [a, 0]));
  const sets = boostSets.map(({ set, existing, remaining }) => {
    const chosen = selected[set] ?? [];
    const attributes = ATTRIBUTES.map((attr) => {
      const isExisting = existing.includes(attr);
      const isSelected = chosen.includes(attr);
      const partial =
        (isSelected || !isExisting) &&
        isPartialBoost(
          isSelected
            ? counts
            : boostCounts(build, { ...overrides, [set]: [...overrides[set], attr] }),
          attr,
          set
        );
      if (isSelected && !partial) gains[attr] += 1;
      return {
        key: attr,
        label: attributeLabel(attr),
        selected: isSelected || isExisting,
        locked: isExisting,
        partial,
        disabled: isExisting || (!isSelected && chosen.length >= remaining)
      };
    });
    return {
      set,
      remaining,
      chosen: chosen.length,
      complete: chosen.length >= remaining,
      attributes
    };
  });

  const modifiers = ATTRIBUTES.map((attr) => {
    const current = actor.system.abilities?.[attr]?.mod ?? 0;
    return {
      key: attr,
      label: attributeLabel(attr),
      current,
      next: current + gains[attr],
      changed: gains[attr] > 0,
      display: signedNumber(current + gains[attr])
    };
  });

  // PF2e counts languages from max(Int, 0), so raising Int from -1 to 0 grants nothing
  const int = modifiers.find((m) => m.key === 'int');
  const intGain = Math.max(int.next, 0) - Math.max(int.current, 0);

  return { sets, modifiers, gains, intGain };
};

/* -------------------------------------------- */
/*  Languages                                   */
/* -------------------------------------------- */

export const getLanguageOptions = (actor) => {
  const known = new Set(actor.system.details?.languages?.value ?? []);
  const rarities = game.pf2e?.settings?.campaign?.languages;
  const rarityOf = (slug) => {
    if (!rarities) return 'common';
    for (const r of ['unavailable', 'secret', 'rare', 'uncommon']) {
      if (rarities[r]?.has?.(slug)) return r;
    }
    return 'common';
  };

  return Object.entries(CONFIG.PF2E.languages ?? {})
    .filter(([slug]) => !known.has(slug))
    .map(([slug, label]) => ({
      slug,
      label: game.i18n.localize(label),
      rarity: rarityOf(slug)
    }))
    .filter((l) => l.rarity !== 'secret' && l.rarity !== 'unavailable')
    .sort(
      (a, b) =>
        ['common', 'uncommon', 'rare'].indexOf(a.rarity) -
          ['common', 'uncommon', 'rare'].indexOf(b.rarity) ||
        a.label.localeCompare(b.label)
    );
};

/** Unassigned language slots after this level-up (Intelligence increases add one each) */
export const getOpenLanguageSlots = (actor, intGain) => {
  const build = actor.system.build?.languages;
  if (!build) return 0;
  return Math.max(0, (build.max ?? 0) + intGain - (build.value ?? 0));
};

/* -------------------------------------------- */
/*  Class features                              */
/* -------------------------------------------- */

const stripParagraphTags = (html) => html?.replace(/^<p>|<\/p>$/g, '') || '';

/** Shared class-feature descriptions list per-class lines as "<p><strong>Fighter</strong> …</p>" */
export const getClassSpecificDescription = (description, classNames) => {
  if (!description || !classNames.length) return description;
  const regex = /<p><strong>(.*?)<\/strong>(.*?)<\/p>/gi;
  let match;
  while ((match = regex.exec(description))) {
    const classes = match[1].split(',').map((c) => c.trim().toLowerCase());
    if (classNames.some((n) => classes.includes(n.toLowerCase()))) {
      return `<p>${match[2].trim()}</p>`;
    }
  }
  return description;
};

export const getClassFeatures = async (preview, previousLevel, targetLevel) => {
  const cls = preview.class;
  if (!cls) return [];
  const classNames = [
    cls.name,
    cls.flags?.babele?.originalName,
    ...cls.name.split(/\s*-\s*/)
  ].filter(Boolean);

  const entries = Object.values(cls.system?.items ?? {}).filter(
    (f) => f.level > previousLevel && f.level <= targetLevel
  );

  const features = await Promise.all(
    entries.map(async (entry) => {
      const item = await fromUuid(entry.uuid).catch(() => null);
      if (!item) return null;
      const description = getClassSpecificDescription(
        item.system?.description?.value,
        classNames
      );
      return {
        uuid: entry.uuid,
        name: item.name,
        img: entry.img || item.img,
        level: entry.level,
        description: await enrichHTML(foundry.utils.cleanHTML(stripParagraphTags(description)), {
          relativeTo: item,
          rollData: preview.getRollData?.()
        })
      };
    })
  );
  return features
    .filter(Boolean)
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
};

export const getClassJournals = async (actor) => {
  const pack = game.packs.get(`${systemId()}.journals`);
  if (!pack || !actor.class) return [];
  const classesEntry = pack.index.find(
    (e) => e.name === 'Classes' || e.originalName === 'Classes'
  );
  if (!classesEntry) return [];
  const journal = await fromUuid(classesEntry.uuid).catch(() => null);
  if (!journal) return [];

  const names = new Set(
    [
      actor.class.name,
      actor.class.flags?.babele?.originalName,
      ...actor.class.name.split(/\s*-\s*/)
    ]
      .filter(Boolean)
      .map((n) => n.toLowerCase())
  );
  const slug = actor.class.slug;
  return journal.pages.contents
    .filter(
      (page) =>
        names.has(page.name.toLowerCase()) ||
        (slug && page.name.toLowerCase() === slug.replace(/-/g, ' '))
    )
    .map((page) => ({ uuid: page.uuid, name: page.name }));
};

/* -------------------------------------------- */
/*  Spellcasting                                */
/* -------------------------------------------- */

const BOUNDED_CASTERS = ['magus', 'summoner'];

/**
 * Spellcasting reminders. Slots and repertoires are not automated by the system, so the wizard can only
 * point out what to update: every prepared/spontaneous entry (class or archetype), and the new spell
 * rank for full casters on odd levels.
 */
export const getSpellcastingReminders = (actor, previousLevel, targetLevel) => {
  const entries = (actor.itemTypes?.spellcastingEntry ?? []).filter(
    (e) => e.isPrepared || e.isSpontaneous
  );
  const classCasts = (actor.class?.system?.spellcasting ?? 0) > 0;
  if (!entries.length && !classCasts) return null;

  const maxRank = (level) => Math.min(10, Math.ceil(level / 2));
  const isFullCaster =
    classCasts && !BOUNDED_CASTERS.includes(actor.class?.slug);
  const newRank =
    isFullCaster && maxRank(targetLevel) > maxRank(previousLevel)
      ? maxRank(targetLevel)
      : null;

  return {
    newRank,
    entries: entries.map((e) => ({
      id: e.id,
      name: e.name,
      type: game.i18n.localize(
        e.isPrepared
          ? 'PF2E.PreparationTypePrepared'
          : 'PF2E.PreparationTypeSpontaneous'
      )
    }))
  };
};

/** Picked feats that most likely need manual spell work (focus spells, cantrips, spellcasting entries) */
export const SPELL_HINT_PATTERN =
  /focus spell|focus point|cantrip|spell slot|spellcasting|spell repertoire|innate spell/i;

/* -------------------------------------------- */
/*  Automatic bonus progression                 */
/* -------------------------------------------- */

const POTENCY_LEVELS = {
  newBoost: [3, 6, 13, 15, 17, 20],
  upgradeTo2: [9, 13, 15, 17, 20],
  upgradeTo3: [17, 20]
};

export const isSkillPotencyActive = (actor) => {
  if (systemSetting('automaticBonusVariant', 'noABP') !== 'ABPRulesAsWritten') return false;
  const abp = game.pf2e?.variantRules?.AutomaticBonusProgression;
  return abp?.isEnabled ? abp.isEnabled(actor) : true;
};

const currentPotency = (actor, slug) =>
  (actor._source.system.customModifiers?.[slug] ?? []).find(
    (m) => m.type === 'potency'
  )?.modifier ?? 0;

/** Skill potency choices (ABP rules as written), one set per level gained */
export const getSkillPotency = (actor, skills, previousLevel, targetLevel) => {
  if (!isSkillPotencyActive(actor)) return null;
  const inRange = (levels) => levels.some((l) => l > previousLevel && l <= targetLevel);
  const core = skills.filter((s) => !s.isLore);
  const withPotency = core.map((s) => ({ ...s, potency: currentPotency(actor, s.slug) }));

  const result = {
    current: withPotency
      .filter((s) => s.potency > 0)
      .map((s) => ({ label: s.label, potency: s.potency })),
    newBoost: inRange(POTENCY_LEVELS.newBoost)
      ? withPotency.filter((s) => s.potency === 0)
      : null,
    upgradeTo2: inRange(POTENCY_LEVELS.upgradeTo2)
      ? withPotency.filter((s) => s.potency === 1)
      : null,
    upgradeTo3: inRange(POTENCY_LEVELS.upgradeTo3)
      ? withPotency.filter((s) => s.potency === 2)
      : null
  };
  for (const key of ['newBoost', 'upgradeTo2', 'upgradeTo3']) {
    if (result[key] && !result[key].length) result[key] = null;
  }
  return result.newBoost || result.upgradeTo2 || result.upgradeTo3 ? result : null;
};

export const buildPotencyModifier = (actor, slug, value) => {
  const others = (actor._source.system.customModifiers?.[slug] ?? []).filter(
    (m) => m.type !== 'potency'
  );
  return [
    ...others,
    {
      slug: 'potency',
      label: localize('menu.skillPotency.modifierLabel'),
      modifier: value,
      type: 'potency',
      enabled: true,
      ignored: false,
      custom: true,
      predicate: []
    }
  ];
};

/* -------------------------------------------- */
/*  XP                                          */
/* -------------------------------------------- */

export const xpInfo = (actor) => {
  const xp = actor.system.details?.xp ?? {};
  return { value: xp.value ?? 0, max: xp.max ?? 1000 };
};
