import { MODULE_ID } from '../constants.js';
import { attributeLabel, escapeHTML, localize, rankLabel } from '../helpers/utility.js';
import { getFeatSlots } from './featSlots.js';
import { loadDocument } from './abcIndex.js';
import { getHistory } from './apply.js';
import { entrySource, spellSource } from './spellcasting.js';
import { offerFocusSpells } from './focusSpells.js';

export const ATTRIBUTES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const ABC_ORDER = ['ancestry', 'heritage', 'background', 'deity', 'class'];

/** Classes whose level-1 features are built around a deity */
export const DEITY_CLASSES = ['cleric', 'champion'];

/* -------------------------------------------- */
/*  State                                       */
/* -------------------------------------------- */

/** Attributes picked for a row's open (non-fixed) boost slots */
const existingPicks = (item, path) =>
  Object.values(foundry.utils.getProperty(item?._source ?? {}, path) ?? {})
    .filter((b) => b?.value?.length > 1 && b.selected)
    .map((b) => b.selected);

/** A fresh build, prefilled from whatever the actor already has */
export const createBuildState = (actor) => {
  const sourceOf = (item) => item?.sourceId ?? null;
  const build = actor._source.system.build?.attributes ?? {};
  return {
    name: actor.name,
    ancestry: sourceOf(actor.ancestry),
    heritage: sourceOf(actor.heritage),
    background: sourceOf(actor.background),
    class: sourceOf(actor.class),
    deity: sourceOf(actor.deity),
    ancestryMode: actor.ancestry?._source.system.alternateAncestryBoosts ? 'alternate' : 'standard',
    ancestryPicks: existingPicks(actor.ancestry, 'system.boosts'),
    alternateBoosts: [...(actor.ancestry?._source.system.alternateAncestryBoosts ?? [])],
    backgroundPicks: existingPicks(actor.background, 'system.boosts'),
    backgroundSkill: null,
    keyAttribute: actor.class?._source.system.keyAbility?.selected ?? null,
    level1: [...(build.boosts?.[1] ?? [])],
    skills: [],
    languages: [],
    feats: {},
    spellTradition: null,
    spells: {}
  };
};

/* -------------------------------------------- */
/*  Boost rows                                  */
/* -------------------------------------------- */

/**
 * Assign a row's picked attributes to its boost slots ("Int or Wis", "free", …).
 * Slots with a single option are fixed and take no pick. Returns slot key → attribute, or null if
 * the picks can't fill the open slots (each slot takes one pick, no attribute twice).
 */
export const assignSlots = (slots, picks) => {
  const open = slots.filter((s) => s.options.length > 1);
  const fixed = slots.filter((s) => s.options.length === 1).map((s) => s.options[0]);
  if (picks.some((p) => fixed.includes(p))) return null;
  if (picks.length > open.length || new Set(picks).size !== picks.length) return null;

  const result = {};
  const used = new Set();
  const place = (i) => {
    if (i === open.length) return used.size === picks.length;
    for (const attr of picks) {
      if (used.has(attr) || !open[i].options.includes(attr)) continue;
      used.add(attr);
      result[open[i].key] = attr;
      if (place(i + 1)) return true;
      used.delete(attr);
      delete result[open[i].key];
    }
    // Leave this slot empty only if there are fewer picks than slots
    if (open.length - i > picks.length - used.size) return place(i + 1);
    return false;
  };
  return place(0) ? result : null;
};

// Older ancestries (Kitsune, for example) keep an empty boost slot; it gives no boost
const slotsOf = (boosts) =>
  Object.entries(boosts ?? {})
    .map(([key, b]) => ({ key, options: b.value ?? [] }))
    .filter((s) => s.options.length > 0);

/** Number of picks a row takes */
export const openSlotCount = (boosts) => slotsOf(boosts).filter((s) => s.options.length > 1).length;

/** Whether adding `attr` to a row's picks still leaves a valid assignment */
export const canPick = (boosts, picks, attr) =>
  !picks.includes(attr) && assignSlots(slotsOf(boosts), [...picks, attr]) !== null;

/* -------------------------------------------- */
/*  Item sources                                */
/* -------------------------------------------- */

/** Compendium item ids are reused across renders so feat slots keyed by them stay stable */
const stableIds = new Map();

const baseSource = async (uuid) => {
  const doc = await loadDocument(uuid);
  if (!doc) return null;
  const source = doc.toObject();
  if (!stableIds.has(uuid)) stableIds.set(uuid, foundry.utils.randomID());
  source._id = stableIds.get(uuid);
  delete source.folder;
  delete source.sort;
  delete source.ownership;
  foundry.utils.setProperty(source, '_stats.compendiumSource', uuid);
  return source;
};

const applyBoostChoices = (boosts, picks) => {
  const choices = assignSlots(slotsOf(boosts), picks) ?? {};
  for (const [key, boost] of Object.entries(boosts ?? {})) {
    const options = boost.value ?? [];
    boost.selected = options.length === 1 ? options[0] : (choices[key] ?? null);
  }
};

/**
 * Item sources for the picked ancestry, heritage, background, class and deity, with the build's
 * boost and key-attribute choices written onto them the way the system stores them.
 */
export const buildSources = async (state) => {
  const sources = {};
  for (const type of ABC_ORDER) {
    sources[type] = state[type] ? await baseSource(state[type]) : null;
  }

  const ancestry = sources.ancestry;
  if (ancestry) {
    if (state.ancestryMode === 'alternate') {
      ancestry.system.alternateAncestryBoosts = [...state.alternateBoosts];
    } else {
      delete ancestry.system.alternateAncestryBoosts;
      applyBoostChoices(ancestry.system.boosts, state.ancestryPicks);
    }
    for (const flaw of Object.values(ancestry.system.flaws ?? {})) {
      flaw.selected = flaw.value?.length === 1 ? flaw.value[0] : null;
    }
  }
  if (sources.background) {
    applyBoostChoices(sources.background.system.boosts, state.backgroundPicks);
    // A pre-filled choice makes the system skip its prompt (and carries over to granted feats)
    const choice = backgroundSkillChoice(sources.background);
    if (choice && choice.options.includes(state.backgroundSkill)) {
      sources.background.system.rules[choice.index].selection = state.backgroundSkill;
    }
  }
  if (sources.class) {
    const key = sources.class.system.keyAbility ?? {};
    key.selected = key.value?.length === 1 ? key.value[0] : (state.keyAttribute ?? null);
  }
  return sources;
};

/* -------------------------------------------- */
/*  Preview                                     */
/* -------------------------------------------- */

/**
 * The character as it will be once built, prepared by the system in memory. Everything shown in
 * the builder (modifiers, HP, skills, languages, feat slots) is read from this preview.
 */
export const buildPreview = (actor, state, sources) => {
  const source = actor.toObject();
  const replaced = new Set(ABC_ORDER.filter((t) => sources[t]));
  const items = [
    ...source.items.filter((i) => !replaced.has(i.type)),
    ...ABC_ORDER.map((t) => sources[t]).filter(Boolean)
  ];
  const skills = Object.fromEntries(state.skills.map((slug) => [slug, { rank: 1 }]));
  const languages = [
    ...new Set([...(source.system.details?.languages?.value ?? []), ...state.languages])
  ];
  return actor.clone(
    {
      name: state.name || actor.name,
      items,
      system: {
        details: { level: { value: 1 }, languages: { value: languages } },
        build: { attributes: { boosts: { 1: [...state.level1] } } },
        skills
      }
    },
    { keepId: true }
  );
};

/* -------------------------------------------- */
/*  Derived choices                             */
/* -------------------------------------------- */

const describeSlots = (boosts, picks) => {
  const choices = assignSlots(slotsOf(boosts), picks) ?? {};
  return slotsOf(boosts).map(({ key, options }) => ({
    key,
    options,
    fixed: options.length === 1,
    free: options.length === ATTRIBUTES.length,
    selected: options.length === 1 ? options[0] : (choices[key] ?? null)
  }));
};

/** Ancestry boost slots for the boost step: fixed, choice-of-some, or free */
export const ancestryBoostSlots = (ancestrySource, state) =>
  describeSlots(ancestrySource?.system.boosts, state.ancestryPicks);

export const ancestryFlaws = (ancestrySource) =>
  Object.values(ancestrySource?.system.flaws ?? {})
    .filter((f) => f.value?.length === 1)
    .map((f) => f.value[0]);

export const backgroundBoostSlots = (backgroundSource, state) =>
  describeSlots(backgroundSource?.system.boosts, state.backgroundPicks);

/**
 * A background whose trained skill is a choice ("Arcana, Nature, Occultism or Religion"), made through a
 * ChoiceSet rule. Returns the rule's index and the skill slugs it offers, or null.
 */
export const backgroundSkillChoice = (backgroundSource) => {
  const skillSlugs = Object.keys(CONFIG.PF2E?.skills ?? {});
  const rules = backgroundSource?.system?.rules ?? [];
  const index = rules.findIndex(
    (r) =>
      r?.key === 'ChoiceSet' &&
      Array.isArray(r.choices) &&
      r.choices.length > 0 &&
      r.choices.every((c) => skillSlugs.includes(c?.value))
  );
  if (index === -1) return null;
  return { index, options: rules[index].choices.map((c) => c.value) };
};

/** Skills the class and background train on their own, and how many more the player picks */
export const skillChoices = (preview, sources, state) => {
  const classSkills = sources.class?.system.trainedSkills?.value ?? [];
  const backgroundSkills = [
    ...(sources.background?.system.trainedSkills?.value ?? []),
    ...(state.backgroundSkill ? [state.backgroundSkill] : [])
  ];
  const overlap = classSkills.filter((s) => backgroundSkills.includes(s)).length;
  const additional = sources.class?.system.trainedSkills?.additional ?? 0;
  const intMod = preview.system.abilities?.int?.mod ?? 0;
  const count = additional + Math.max(intMod, 0) + overlap;

  const skills = Object.entries(CONFIG.PF2E.skills ?? {}).map(([slug, data]) => {
    const rank = preview.skills?.[slug]?.rank ?? 0;
    const chosen = state.skills.includes(slug);
    const from = classSkills.includes(slug)
      ? 'class'
      : backgroundSkills.includes(slug)
        ? 'background'
        : !chosen && rank > 0
          ? 'other'
          : null;
    return {
      slug,
      label: game.i18n.localize(data.label ?? slug),
      rank: chosen ? 1 : rank,
      chosen,
      locked: !!from,
      from
    };
  });
  return {
    count,
    additional,
    intBonus: Math.max(intMod, 0),
    overlap,
    skills: skills.sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang))
  };
};

/** Language slots left after ancestry languages, and the suggested picks */
export const languageChoices = (preview, sources, state, options) => {
  const build = preview.system.build?.languages ?? { value: 0, max: 0 };
  const open = Math.max(0, (build.max ?? 0) - (build.value ?? 0));
  const total = open + state.languages.length;
  const known = new Set(preview.system.details?.languages?.value ?? []);
  const suggested = new Set(sources.ancestry?.system.additionalLanguages?.value ?? []);
  const granted = (build.granted ?? []).map((g) => ({
    slug: g.slug,
    label: game.i18n.localize(CONFIG.PF2E.languages?.[g.slug] ?? g.slug)
  }));
  const list = options
    .filter((l) => !known.has(l.slug) || state.languages.includes(l.slug))
    .map((l) => ({
      ...l,
      suggested: suggested.has(l.slug),
      chosen: state.languages.includes(l.slug)
    }))
    .sort((a, b) => Number(b.suggested) - Number(a.suggested));
  return { total, open, granted, options: list };
};

/** Empty level-1 feat slots; the background's own skill feat is granted automatically */
export const featSlotsFor = (preview, sources) =>
  getFeatSlots(preview, 1, 0).current.filter(
    (slot) => slot.slotId !== sources.background?._id
  );

/* -------------------------------------------- */
/*  Validation                                  */
/* -------------------------------------------- */

const distinct = (list) => new Set(list.filter(Boolean)).size === list.filter(Boolean).length;

export const boostProblems = (state, sources) => {
  const problems = [];
  if (sources.ancestry) {
    if (state.ancestryMode === 'alternate') {
      if (state.alternateBoosts.length !== 2) problems.push('ancestry');
    } else {
      const slots = ancestryBoostSlots(sources.ancestry, state);
      if (slots.some((s) => !s.selected) || !distinct(slots.map((s) => s.selected)))
        problems.push('ancestry');
    }
  }
  if (sources.background) {
    const slots = backgroundBoostSlots(sources.background, state);
    if (slots.some((s) => !s.selected) || !distinct(slots.map((s) => s.selected)))
      problems.push('background');
  }
  if (sources.class && !sources.class.system.keyAbility?.selected) problems.push('class');
  if (state.level1.length !== 4 || !distinct(state.level1)) problems.push('level1');
  return problems;
};

/* -------------------------------------------- */
/*  Apply                                       */
/* -------------------------------------------- */

const featSource = async (pick) => {
  const doc = await fromUuid(pick.uuid);
  if (!doc) throw new Error(`Feat not found: ${pick.uuid}`);
  const source = doc.toObject();
  delete source._id;
  delete source.folder;
  delete source.sort;
  delete source.ownership;
  foundry.utils.setProperty(source, '_stats.compendiumSource', doc.uuid);
  source.system.location = pick.slot.slotId;
  source.system.level = { ...(source.system.level ?? {}), taken: 1 };
  return source;
};

const topLevelIds = (items) => {
  const ids = new Set(items.map((i) => i.id));
  return items
    .filter((i) => !ids.has(i.flags?.[game.system.id]?.grantedBy?.id))
    .map((i) => i.id);
};

/**
 * Create the character. The ABC items go in the order the system expects (the deity before the
 * class, so class features can offer its domains), then the level-1 feats. The system asks its own
 * follow-up questions (a background's skill, a class's research field, …) as each item is added.
 * On failure everything created so far is removed and the actor is restored.
 * @returns {Promise<boolean>}
 */
export const applyBuild = async (actor, state, featPicks, spellPlan = null) => {
  const sources = await buildSources(state);
  const sourceSystem = actor._source.system;
  const before = {
    level: actor.level,
    xp: sourceSystem.details?.xp?.value ?? 0,
    skills: Object.fromEntries(
      state.skills.map((s) => [s, sourceSystem.skills?.[s]?.rank ?? 0])
    ),
    lores: {},
    boosts: { 1: [...(sourceSystem.build?.attributes?.boosts?.[1] ?? [])] },
    languages: [...(sourceSystem.details?.languages?.value ?? [])],
    customModifiers: {}
  };

  const update = {
    'system.details.level.value': 1,
    'system.build.attributes.boosts.1': [...state.level1]
  };
  if (state.name && state.name !== actor.name) update.name = state.name;
  for (const slug of state.skills) update[`system.skills.${slug}.rank`] = 1;
  if (state.languages.length) {
    update['system.details.languages.value'] = [
      ...new Set([...before.languages, ...state.languages])
    ];
  }

  const created = [];
  const itemsBefore = new Set(actor.items.map((i) => i.id));
  const create = async (list) => {
    const docs = list.filter(Boolean);
    if (!docs.length) return;
    created.push(...(await actor.createEmbeddedDocuments('Item', docs, { keepId: true })));
  };

  try {
    await actor.update(update, { [MODULE_ID]: { build: true } });
    // Existing items of the same kind are replaced by the system when the new ones are created
    await create([sources.ancestry, sources.heritage, sources.background, sources.deity]);
    await create([sources.class]);
    await create(await Promise.all(Object.values(featPicks).map(featSource)));
    // The class spellcasting entry, its slots and the starting spells
    if (spellPlan?.rules && spellPlan.tradition) {
      const [entry] = await actor.createEmbeddedDocuments('Item', [
        entrySource(spellPlan.rules, {
          slug: spellPlan.slug,
          className: spellPlan.className,
          tradition: spellPlan.tradition,
          attribute: spellPlan.attribute,
          level: 1
        })
      ]);
      created.push(entry);
      const uuids = Object.values(spellPlan.selection ?? {}).flat();
      if (uuids.length) {
        await create(await Promise.all(uuids.map((uuid) => spellSource(uuid, entry.id))));
      }
    }
  } catch (error) {
    console.error(`${MODULE_ID} | Character build failed, rolling back`, error);
    try {
      const strays = actor.items.filter((i) => !itemsBefore.has(i.id)).map((i) => i.id);
      if (strays.length) await actor.deleteEmbeddedDocuments('Item', strays);
      const revert = {
        'system.details.level.value': before.level,
        'system.build.attributes.boosts.1': before.boosts[1],
        'system.details.languages.value': before.languages
      };
      for (const [slug, rank] of Object.entries(before.skills)) {
        revert[`system.skills.${slug}.rank`] = rank;
      }
      await actor.update(revert, { [MODULE_ID]: { undo: true } });
    } catch (rollbackError) {
      console.error(`${MODULE_ID} | Rollback failed`, rollbackError);
    }
    ui.notifications.error(localize('builder.notifications.failed'));
    return false;
  }

  // Focus spells from the class features and feats (domain, bloodline, school, order...)
  const focus = await offerFocusSpells(
    actor,
    actor.items.filter((i) => !itemsBefore.has(i.id))
  );
  created.push(...focus.created);

  const summary = {
    feats: Object.values(featPicks).map((p) => ({
      name: p.name,
      uuid: p.uuid,
      slot: p.slot.groupLabel
    })),
    skills: state.skills.map((s) => ({
      label: game.i18n.localize(CONFIG.PF2E.skills?.[s]?.label ?? s),
      rank: rankLabel(1)
    })),
    boosts: state.level1.map(attributeLabel),
    languages: state.languages.map((l) =>
      game.i18n.localize(CONFIG.PF2E.languages?.[l] ?? l)
    ),
    potency: [],
    build: ABC_ORDER.map((t) => created.find((i) => i.type === t)?.name).filter(Boolean),
    spells: created.filter((i) => i.type === 'spell').map((i) => i.name)
  };

  const entry = {
    id: foundry.utils.randomID(),
    kind: 'build',
    timestamp: Date.now(),
    userId: game.user.id,
    fromLevel: before.level,
    toLevel: 1,
    levelChanged: before.level !== 1,
    xpChanged: false,
    languagesChanged: state.languages.length > 0,
    before,
    createdItemIds: topLevelIds(created),
    summary
  };
  try {
    const history = [...getHistory(actor), entry].slice(-10);
    await actor.update(
      { [`flags.${MODULE_ID}.history`]: history },
      { [MODULE_ID]: { history: true } }
    );
  } catch (error) {
    console.error(`${MODULE_ID} | Could not record the build`, error);
  }

  try {
    const name = escapeHTML(actor.name);
    const parts = [
      summary.build.length ? `<p>${summary.build.map(escapeHTML).join(' · ')}</p>` : '',
      summary.feats.length
        ? `<p><strong>${localize('messages.global.feats')}</strong> ${summary.feats
            .map((f) => `@UUID[${f.uuid}]{${escapeHTML(f.name)}}`)
            .join(', ')}</p>`
        : ''
    ];
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<h2>${localize('builder.chat.header', { actorName: name })}</h2>${parts.join('')}`
    });
  } catch (error) {
    console.error(`${MODULE_ID} | Could not post the build message`, error);
  }

  ui.notifications.info(localize('builder.notifications.done', { actorName: actor.name }));
  return true;
};
