import { MODULE_ID } from '../constants.js';
import { attributeLabel, localize, rankLabel } from '../helpers/utility.js';
import { buildPotencyModifier, SPELL_HINT_PATTERN, xpInfo } from './plan.js';
import { postLevelUpMessages } from '../helpers/chat.js';
import { offerFocusSpells } from './focusSpells.js';
import {
  entrySlotSnapshot,
  entrySlotUpdate,
  entrySource,
  extraEntryPrepareUpdate,
  extraEntrySlotsAt,
  extraEntrySlotUpdate,
  extraEntrySource,
  extraEntrySpellId,
  isSignature,
  spellSource
} from './spellcasting.js';

/** Level-ups and builds kept per actor; only the latest can be undone */
export const HISTORY_LIMIT = 10;
const HISTORY_PATH = `flags.${MODULE_ID}.history`;

/** Top-level items only: deleting a feat also deletes what it granted, so granted items are not tracked */
export const topLevelIds = (items) => {
  const ids = new Set(items.map((i) => i.id));
  return items
    .filter((i) => !ids.has(i.flags?.[game.system.id]?.grantedBy?.id))
    .map((i) => i.id);
};

export const getHistory = (actor) => actor.getFlag(MODULE_ID, 'history') ?? [];

/**
 * Build the item source for a compendium feat placed in a specific slot, as the system's own feat
 * insertion does, plus the compendium source so PF2e (and later level-ups) recognize the feat.
 */
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
  source.system.level = { ...(source.system.level ?? {}), taken: pick.slot.level };
  return { source, doc };
};

const snapshotSkills = (actor, slugs, options) => {
  const skills = {};
  const lores = {};
  for (const slug of slugs) {
    const option = options.find((s) => s.slug === slug);
    if (!option) continue;
    if (option.isLore) {
      const item = actor.items.get(option.itemId);
      lores[option.itemId] = item?._source.system.proficient?.value ?? 0;
    } else {
      skills[slug] = actor._source.system.skills?.[slug]?.rank ?? 0;
    }
  }
  return { skills, lores };
};

/**
 * Turn the wizard's selections into one actor update, item updates and new feat items.
 * Nothing is written here; see `applyLevelUp`.
 */
export const buildChanges = async (actor, plan, selection) => {
  const update = {};
  const itemUpdates = [];
  const summary = {
    feats: [],
    skills: [],
    boosts: [],
    languages: [],
    potency: [],
    spells: []
  };

  if (!plan.levelAlreadyApplied) {
    update['system.details.level.value'] = plan.targetLevel;
  }

  // Skill increases and Intelligence trainings; ranks build on the prepared rank
  const rankChanges = new Map();
  for (const slug of [...selection.skillIncreases, ...selection.intSkills]) {
    if (!slug) continue;
    const option = plan.skillOptions.find((s) => s.slug === slug);
    if (!option) continue;
    const from = rankChanges.get(slug) ?? option.rank;
    rankChanges.set(slug, Math.min(from + 1, 4));
  }
  for (const [slug, rank] of rankChanges) {
    const option = plan.skillOptions.find((s) => s.slug === slug);
    if (option.isLore) {
      itemUpdates.push({ _id: option.itemId, 'system.proficient.value': rank });
    } else {
      update[`system.skills.${slug}.rank`] = rank;
    }
    summary.skills.push({ label: option.label, rank: rankLabel(rank) });
  }

  for (const { set, existing } of plan.boostSets) {
    const chosen = selection.boosts[set] ?? [];
    if (!chosen.length) continue;
    update[`system.build.attributes.boosts.${set}`] = [...existing, ...chosen];
    summary.boosts.push(...chosen.map(attributeLabel));
  }

  const languages = selection.languages.filter(Boolean);
  if (languages.length) {
    const current = actor._source.system.details?.languages?.value ?? [];
    update['system.details.languages.value'] = [
      ...new Set([...current, ...languages])
    ];
    summary.languages = languages.map((l) =>
      game.i18n.localize(CONFIG.PF2E.languages[l] ?? l)
    );
  }

  const potencyValues = { newBoost: 1, upgradeTo2: 2, upgradeTo3: 3 };
  for (const [key, value] of Object.entries(potencyValues)) {
    const slug = selection.potency[key];
    if (!slug) continue;
    update[`system.customModifiers.${slug}`] = buildPotencyModifier(
      actor,
      slug,
      value
    );
    const label = plan.skillOptions.find((s) => s.slug === slug)?.label ?? slug;
    summary.potency.push({ label, value });
  }

  if (plan.xpEnforcement && !plan.levelAlreadyApplied) {
    const { value, max } = xpInfo(actor);
    const gained = plan.targetLevel - plan.previousLevel;
    update['system.details.xp.value'] = Math.max(0, value - max * gained);
  }

  const picks = Object.values(selection.feats).filter(Boolean);
  const feats = await Promise.all(picks.map(featSource));
  for (const [i, { doc }] of feats.entries()) {
    summary.feats.push({
      name: doc.name,
      uuid: picks[i].uuid,
      slot: picks[i].slot.groupLabel
    });
  }

  const spells = await spellChanges(actor, plan, selection.spellPlan);
  if (spells) {
    summary.spells = addedSpells(spells).map((s) => ({ name: s.name, uuid: s._stats?.compendiumSource }));
  }

  return { update, itemUpdates, feats, spells, summary };
};

/**
 * The class spellcasting entry for the new level: a slot update for the managed entry, or a new
 * entry, plus the picked spells (placed in the entry once it exists).
 */
const spellChanges = async (actor, plan, spellPlan) => {
  if (!spellPlan?.rules || !spellPlan.tradition) return null;
  const { rules, slug, entry } = spellPlan;
  const uuids = Object.values(spellPlan.selection ?? {}).flat();
  const sources = await Promise.all(uuids.map((uuid) => spellSource(uuid, entry?.id ?? null)));
  const sig = spellPlan.signature ?? null;
  for (const source of sources) {
    const cantrip = source.system?.traits?.value?.includes('cantrip') ?? false;
    source.system.location.signature = isSignature(sig?.at, sig?.choice, `new:${source._stats.compendiumSource}`, cantrip);
  }
  // Existing spells whose signature mark changes
  const signatureUpdates = sig?.at
    ? [...(entry?.spells ?? [])]
        .map((spell) => ({
          spell,
          signature: isSignature(sig.at, sig.choice, `item:${spell.id}`, spell.isCantrip)
        }))
        .filter(({ spell, signature }) => !!spell.system?.location?.signature !== signature)
        .map(({ spell, signature }) => ({ _id: spell.id, 'system.location.signature': signature }))
    : [];
  const extra = await extraEntryChanges(spellPlan, plan.targetLevel);
  if (entry) {
    const entryUpdate = entrySlotUpdate(rules, entry, slug, plan.targetLevel);
    if (!entry.system?.tradition?.value) entryUpdate['system.tradition.value'] = spellPlan.tradition;
    return { entryUpdate, newEntry: null, sources, signatureUpdates, extra };
  }
  const newEntry = entrySource(rules, {
    slug,
    className: spellPlan.className,
    tradition: spellPlan.tradition,
    attribute: spellPlan.attribute,
    level: plan.targetLevel
  });
  return { entryUpdate: null, newEntry, sources, signatureUpdates, extra };
};

/**
 * The class's separate extra entry (cleric divine font), checked apart from the regular slots: its
 * slots move to the level's rank, and the heal/harm spell is added when the entry doesn't hold one.
 */
export const extraEntryChanges = async (spellPlan, level) => {
  const { rules, slug, extraEntry } = spellPlan;
  if (!extraEntrySlotsAt(rules, level)) return null;
  const spellId = extraEntry ? extraEntrySpellId(extraEntry) : null;
  const spell = !spellId && spellPlan.extraSpell ? await spellSource(spellPlan.extraSpell, extraEntry?.id ?? null) : null;
  return {
    rules,
    level,
    update: extraEntry ? extraEntrySlotUpdate(rules, extraEntry, slug, level, spellId) : null,
    newEntry: extraEntry
      ? null
      : extraEntrySource(rules, { slug, tradition: spellPlan.tradition, attribute: spellPlan.attribute, level }),
    spell
  };
};

/** Create or update the extra entry and prepare its heal/harm spell; returns the created items */
export const applyExtraEntry = async (actor, extra, created) => {
  if (!extra) return;
  let entryId = extra.update?._id ?? null;
  if (extra.newEntry) {
    const [entry] = await actor.createEmbeddedDocuments('Item', [extra.newEntry]);
    created.push(entry);
    entryId = entry.id;
  } else if (extra.update) {
    await actor.updateEmbeddedDocuments('Item', [extra.update]);
  }
  if (!extra.spell || !entryId) return;
  const source = foundry.utils.deepClone(extra.spell);
  source.system.location = { value: entryId };
  const [spell] = await actor.createEmbeddedDocuments('Item', [source]);
  created.push(spell);
  const prepare = extraEntryPrepareUpdate(extra.rules, entryId, spell.id, extra.level);
  if (prepare) await actor.updateEmbeddedDocuments('Item', [prepare]);
};

/** Spell sources a level-up adds: the picks, plus the divine font's heal/harm when it was missing */
const addedSpells = (spells) => [...spells.sources, ...(spells.extra?.spell ? [spells.extra.spell] : [])];

/** Spellcasting entries the module manages: the class entry and its extra entry (divine font) */
const managedEntry = (item) => !!(item.flags?.[MODULE_ID]?.classEntry || item.flags?.[MODULE_ID]?.extraEntry);

/** Create or update the class entry and add the picked spells; returns the created items */
const applySpells = async (actor, spells, created) => {
  let entryId = spells.entryUpdate?._id ?? null;
  if (spells.newEntry) {
    const [entry] = await actor.createEmbeddedDocuments('Item', [spells.newEntry]);
    created.push(entry);
    entryId = entry.id;
  } else if (spells.entryUpdate) {
    await actor.updateEmbeddedDocuments('Item', [spells.entryUpdate, ...spells.signatureUpdates]);
  }
  await applyExtraEntry(actor, spells.extra, created);
  if (!spells.sources.length) return;
  const sources = spells.sources.map((source) => {
    const copy = foundry.utils.deepClone(source);
    copy.system.location = { value: entryId, signature: !!source.system.location.signature };
    return copy;
  });
  created.push(...(await actor.createEmbeddedDocuments('Item', sources)));
};

const snapshot = (actor, plan, selection, changes) => {
  const sourceSystem = actor._source.system;
  const touchedSkills = [...selection.skillIncreases, ...selection.intSkills].filter(
    Boolean
  );
  const { skills, lores } = snapshotSkills(actor, touchedSkills, plan.skillOptions);

  const customModifiers = {};
  for (const key of Object.keys(changes.update)) {
    const match = key.match(/^system\.customModifiers\.(.+)$/);
    if (match) {
      customModifiers[match[1]] = foundry.utils.deepClone(
        sourceSystem.customModifiers?.[match[1]] ?? []
      );
    }
  }

  const boosts = {};
  for (const { set } of plan.boostSets) {
    boosts[set] = [...(sourceSystem.build?.attributes?.boosts?.[set] ?? [])];
  }

  const spellEntry = selection.spellPlan?.entry ?? null;
  const extraEntry = selection.spellPlan?.extraEntry ?? null;
  return {
    extraEntry: extraEntry
      ? {
          id: extraEntry.id,
          slots: entrySlotSnapshot(extraEntry),
          flag: extraEntry.flags?.[MODULE_ID]?.extraEntry ?? null
        }
      : null,
    spellEntry: spellEntry
      ? {
          id: spellEntry.id,
          slots: entrySlotSnapshot(spellEntry),
          flag: spellEntry.flags?.[MODULE_ID]?.classEntry ?? null,
          tradition: spellEntry.system?.tradition?.value ?? '',
          signatures: Object.fromEntries(
            [...(spellEntry.spells ?? [])].map((s) => [s.id, !!s.system?.location?.signature])
          )
        }
      : null,
    level: plan.previousLevel,
    xp: sourceSystem.details?.xp?.value ?? 0,
    skills,
    lores,
    boosts,
    languages: [...(sourceSystem.details?.languages?.value ?? [])],
    customModifiers
  };
};

/** Restore the parts of the actor a level-up changed */
const revertTo = async (actor, entry, { keepHistory = false } = {}) => {
  const existing = entry.createdItemIds.filter((id) => actor.items.has(id));
  if (existing.length) await actor.deleteEmbeddedDocuments('Item', existing);

  const before = entry.before;
  const update = {};
  if (entry.levelChanged) update['system.details.level.value'] = before.level;
  if (entry.xpChanged) update['system.details.xp.value'] = before.xp;
  for (const [slug, rank] of Object.entries(before.skills ?? {})) {
    update[`system.skills.${slug}.rank`] = rank;
  }
  for (const [set, boosts] of Object.entries(before.boosts ?? {})) {
    update[`system.build.attributes.boosts.${set}`] = boosts;
  }
  if (entry.languagesChanged)
    update['system.details.languages.value'] = before.languages;
  for (const [slug, modifiers] of Object.entries(before.customModifiers ?? {})) {
    update[`system.customModifiers.${slug}`] = modifiers;
  }
  if (!keepHistory) {
    update[HISTORY_PATH] = getHistory(actor).filter((h) => h.id !== entry.id);
  }
  await actor.update(update, { [MODULE_ID]: { undo: true } });

  const spellEntry = before.spellEntry;
  if (spellEntry && actor.items.has(spellEntry.id)) {
    const entryUpdate = { _id: spellEntry.id, 'system.tradition.value': spellEntry.tradition };
    for (const [rank, { max, value }] of Object.entries(spellEntry.slots)) {
      entryUpdate[`system.slots.slot${rank}.max`] = max;
      entryUpdate[`system.slots.slot${rank}.value`] = value;
    }
    entryUpdate[`flags.${MODULE_ID}.classEntry`] = spellEntry.flag;
    const signatureUpdates = Object.entries(spellEntry.signatures ?? {})
      .filter(([id, signature]) => {
        const spell = actor.items.get(id);
        return spell && !!spell.system?.location?.signature !== signature;
      })
      .map(([id, signature]) => ({ _id: id, 'system.location.signature': signature }));
    await actor.updateEmbeddedDocuments('Item', [entryUpdate, ...signatureUpdates]);
  }

  // The divine font entry: its slots move back to the old rank, with what was prepared there
  const extraEntry = before.extraEntry;
  if (extraEntry && actor.items.has(extraEntry.id)) {
    const entryUpdate = { _id: extraEntry.id, [`flags.${MODULE_ID}.extraEntry`]: extraEntry.flag };
    for (const [rank, { max, value, prepared }] of Object.entries(extraEntry.slots)) {
      entryUpdate[`system.slots.slot${rank}.max`] = max;
      entryUpdate[`system.slots.slot${rank}.value`] = value;
      entryUpdate[`system.slots.slot${rank}.prepared`] = (prepared ?? []).filter(
        (p) => !p.id || actor.items.has(p.id)
      );
    }
    await actor.updateEmbeddedDocuments('Item', [entryUpdate]);
  }

  const loreUpdates = Object.entries(before.lores ?? {})
    .filter(([id]) => actor.items.has(id))
    .map(([id, rank]) => ({ _id: id, 'system.proficient.value': rank }));
  if (loreUpdates.length) await actor.updateEmbeddedDocuments('Item', loreUpdates);
};

/**
 * Apply a level-up. The actor changes go out as a single update; if creating the feats then fails,
 * everything is rolled back so a character is never left half-leveled.
 * @returns {Promise<boolean>} whether the level-up was applied
 */
export const applyLevelUp = async (actor, plan, selection) => {
  let changes;
  try {
    changes = await buildChanges(actor, plan, selection);
  } catch (error) {
    console.error(`${MODULE_ID} |`, error);
    ui.notifications.error(localize('notifications.levelUpFailed'));
    return false;
  }

  const entry = {
    id: foundry.utils.randomID(),
    timestamp: Date.now(),
    userId: game.user.id,
    fromLevel: plan.previousLevel,
    toLevel: plan.targetLevel,
    levelChanged: !plan.levelAlreadyApplied,
    xpChanged: 'system.details.xp.value' in changes.update,
    languagesChanged: 'system.details.languages.value' in changes.update,
    before: snapshot(actor, plan, selection, changes),
    createdItemIds: [],
    summary: changes.summary
  };

  if (!plan.levelAlreadyApplied) {
    ui.notifications.info(
      localize('notifications.levelUpStart', {
        actorName: actor.name,
        targetLevel: plan.targetLevel
      })
    );
  }

  const itemsBefore = new Set(actor.items.map((i) => i.id));
  const pickedSources = new Set([
    ...changes.feats.map((f) => f.doc.uuid),
    ...(changes.spells ? addedSpells(changes.spells) : []).map((s) => s._stats?.compendiumSource)
  ]);
  let created = [];
  try {
    await actor.update(changes.update, { [MODULE_ID]: { levelUp: true } });
    if (changes.itemUpdates.length) {
      await actor.updateEmbeddedDocuments('Item', changes.itemUpdates);
    }
    if (changes.feats.length) {
      created = await actor.createEmbeddedDocuments(
        'Item',
        changes.feats.map((f) => f.source)
      );
    }
    if (changes.spells) await applySpells(actor, changes.spells, created);
  } catch (error) {
    console.error(`${MODULE_ID} | Level-up failed, rolling back`, error);
    // Creation may fail after some items were stored; remove any new copy of a picked feat
    const strays = actor.items.filter(
      (i) =>
        !itemsBefore.has(i.id) &&
        (pickedSources.has(i.sourceId) || (i.type === 'spellcastingEntry' && managedEntry(i)))
    );
    entry.createdItemIds = topLevelIds([...new Set([...created, ...strays])]);
    try {
      await revertTo(actor, entry, { keepHistory: true });
    } catch (rollbackError) {
      console.error(`${MODULE_ID} | Rollback failed`, rollbackError);
    }
    ui.notifications.error(localize('notifications.levelUpRolledBack'));
    return false;
  }

  // Focus spells from the new feats and features, once PF2e has asked its own questions (domains...)
  const focus = await offerFocusSpells(
    actor,
    actor.items.filter((i) => !itemsBefore.has(i.id))
  );
  created.push(...focus.created);
  const focusSpells = focus.created.filter((i) => i.type === 'spell');
  if (focusSpells.length) {
    entry.summary.spells = [
      ...(entry.summary.spells ?? []),
      ...focusSpells.map((s) => ({ name: s.name, uuid: s.sourceId }))
    ];
  }
  entry.createdItemIds = topLevelIds(created);

  // A cancelled choice prompt (e.g. a ChoiceSet) makes the system skip that feat
  const createdSources = new Set(created.map((i) => i.sourceId));
  const skipped = changes.feats
    .filter((f) => !createdSources.has(f.doc.uuid))
    .map((f) => f.doc.name);
  if (skipped.length) {
    ui.notifications.warn(
      localize('notifications.featsSkipped', { feats: skipped.join(', ') })
    );
    entry.summary.feats = entry.summary.feats.filter(
      (f) => !skipped.includes(f.name)
    );
  }

  // The level-up is applied at this point; history and chat failures must not hide that
  try {
    const history = [...getHistory(actor), entry].slice(-HISTORY_LIMIT);
    await actor.update({ [HISTORY_PATH]: history }, { [MODULE_ID]: { history: true } });
  } catch (error) {
    console.error(`${MODULE_ID} | Could not record the level-up history`, error);
  }

  try {
    const spellHints = created
      .filter((item) => SPELL_HINT_PATTERN.test(item.system?.description?.value ?? ''))
      .map((item) => item.name)
      .filter((name) => !focus.handled.includes(name));
    await postLevelUpMessages(actor, plan, selection, entry.summary, spellHints);
  } catch (error) {
    console.error(`${MODULE_ID} | Could not post the level-up messages`, error);
  }

  ui.notifications.info(
    localize('notifications.levelUpComplete', { actorName: actor.name })
  );
  return true;
};

export const canUndo = (actor) => {
  const last = getHistory(actor).at(-1);
  if (!last || !actor.isOwner) return false;
  if (!game.user.isGM && !game.settings.get(MODULE_ID, 'allow-player-undo'))
    return false;
  return actor.level === last.toLevel;
};

/** Undo the most recent level-up recorded on the actor */
export const undoLastLevelUp = async (actor, { windowId } = {}) => {
  const last = getHistory(actor).at(-1);
  if (!last) {
    ui.notifications.warn(localize('notifications.nothingToUndo'));
    return false;
  }
  if (!canUndo(actor)) {
    ui.notifications.warn(
      localize('notifications.cannotUndo', { level: last.toLevel })
    );
    return false;
  }

  const undoKey =
    last.kind === 'build'
      ? 'history.undoConfirmBuild'
      : last.levelChanged
        ? 'history.undoConfirm'
        : 'history.undoConfirmManual';
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: localize('history.undoTitle'), icon: 'fa-solid fa-rotate-left' },
    content: `<p>${localize(undoKey, {
      actorName: foundry.utils.escapeHTML(actor.name),
      fromLevel: last.toLevel,
      toLevel: last.levelChanged ? last.fromLevel : last.toLevel
    })}</p>`,
    modal: true,
    renderOptions: { window: { windowId } }
  });
  if (!confirmed) return false;

  await revertTo(actor, last);
  ui.notifications.info(localize('notifications.undone', { actorName: actor.name }));
  return true;
};
