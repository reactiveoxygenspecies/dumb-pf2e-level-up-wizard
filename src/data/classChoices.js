import { MODULE_ID } from '../constants.js';
import { sluggify } from '../helpers/utility.js';
import { loadDocument } from './abcIndex.js';

/*
 * The choices a class makes at level 1 (bloodline, doctrine, muse, research field, tactics...).
 * The system asks for them through ChoiceSet rules on the class features while the character is
 * created. The builder asks for them up front instead: the answers are written into the features
 * the way the system stores a made choice, so the system has nothing left to ask.
 */

/** Key of one ChoiceSet in the build's answers: the item it sits on and the rule's index */
export const choiceKey = (uuid, index) => `${uuid}#${index}`;

export const isChoiceSet = (rule) => rule?.key === 'ChoiceSet';

const isItemUuid = (value) => typeof value === 'string' && /^(Compendium|Item)\./.test(value);

/** Level-1 entries of a class's feature list, in the class's own order */
export const levelOneFeatures = (classSource) =>
  Object.entries(classSource?.system?.items ?? {})
    .filter(([, entry]) => entry?.uuid && (entry.level ?? 1) <= 1)
    .map(([key, entry]) => ({ key, uuid: entry.uuid, level: entry.level ?? 1 }));

const SELECTION_REF = /^\{item\|flags\.(?:pf2e|system)\.rulesSelections\.([\w-]+)\}$/;

/** The ChoiceSet flag a GrantItem points at: "{item|flags.system.rulesSelections.bloodline}" */
export const selectionFlag = (uuid) => SELECTION_REF.exec(String(uuid ?? '').trim())?.[1] ?? null;

/**
 * ChoiceSets the builder can answer. Choices among the actor's own items or attacks only exist
 * once the character does, and deities have the builder's own picker.
 */
export const isAnswerable = (rule) => {
  const choices = rule?.choices;
  if (!choices || typeof choices !== 'object' || Array.isArray(choices)) return true;
  if (choices.ownedItems || choices.attacks || choices.unarmedAttacks || 'query' in choices) return false;
  return choices.itemType !== 'deity';
};

/** Write the build's answers into an item source's ChoiceSet rules */
export const writeSelections = (source, uuid, choices) => {
  (source?.system?.rules ?? []).forEach((rule, index) => {
    if (!isChoiceSet(rule)) return;
    const key = choiceKey(uuid, index);
    if (key in choices) rule.selection = choices[key];
  });
  return source;
};

/** Whether any of an item's ChoiceSets has an answer */
export const hasSelections = (source) =>
  (source?.system?.rules ?? []).some((rule) => isChoiceSet(rule) && rule.selection != null);

/**
 * Items a feature grants through a chosen option: a GrantItem whose uuid is the selection of a
 * ChoiceSet on the same feature. Returns the GrantItem's index and the chosen item's uuid.
 */
export const chosenGrants = (source, uuid, choices) => {
  const rules = source?.system?.rules ?? [];
  const grants = [];
  rules.forEach((rule, ruleIndex) => {
    if (rule?.key !== 'GrantItem') return;
    const flag = selectionFlag(rule.uuid);
    if (!flag) return;
    const choiceIndex = rules.findIndex((r) => isChoiceSet(r) && r.flag === flag);
    if (choiceIndex === -1) return;
    const value = choices[choiceKey(uuid, choiceIndex)];
    if (isItemUuid(value)) grants.push({ ruleIndex, choiceIndex, uuid: value });
  });
  return grants;
};

/**
 * Run `create` with the answers for the chosen items' own choices (a gate's impulses, an elemental
 * bloodline's element) in place on the documents the system grants them from. The system copies the
 * granted item from that document, and a ChoiceSet that already has a selection isn't asked again.
 * (GrantItem's `preselectChoices` would be the way, but PF2e 8.2 drops it from the rule's data.)
 * The documents are put back as they were afterwards, also when creating fails.
 * @param {{ uuid: string, source: object }[]} granted the chosen items, answers written in
 */
export const withGrantedAnswers = async (granted, create) => {
  const changed = [];
  try {
    for (const { uuid, source } of granted) {
      const rules = (await fromUuid(uuid))?._source?.system?.rules;
      if (!rules) continue;
      (source.system?.rules ?? []).forEach((rule, index) => {
        const target = rules[index];
        if (!isChoiceSet(rule) || rule.selection == null || target?.key !== 'ChoiceSet') return;
        changed.push({ target, had: 'selection' in target, previous: target.selection });
        target.selection = foundry.utils.deepClone(rule.selection);
      });
    }
    return await create();
  } finally {
    for (const { target, had, previous } of changed) {
      if (had) target.selection = previous;
      else delete target.selection;
    }
  }
};

const TRADITIONS = ['arcane', 'divine', 'occult', 'primal'];

/**
 * The spell tradition a chosen subclass sets: a witch's patron sets it directly, a bloodline's
 * blood magic names it, an eidolon's description lists it. Null when it can't be told.
 */
export const traditionFrom = (source, classSlug) => {
  const rules = source?.system?.rules ?? [];
  const alias = rules.find(
    (r) =>
      r?.key === 'ActiveEffectLike' &&
      r.path === `system.proficiencies.aliases.${classSlug}` &&
      TRADITIONS.includes(r.value)
  );
  if (alias) return alias.value;
  const named = new Set(
    [...JSON.stringify(rules).matchAll(/spellcasting:tradition:(arcane|divine|occult|primal)/g)].map(
      (m) => m[1]
    )
  );
  if (named.size === 1) return [...named][0];
  const description = source?.system?.description?.value ?? '';
  const match = /(?:Tradition|Spell List)[^<]*<\/strong>\s*(arcane|divine|occult|primal)\b/i.exec(description);
  return match ? match[1].toLowerCase() : null;
};

/** Answers can be objects ({ slug, damageType }); they match by value, whatever the key order */
const sameValue = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => sameValue(a[k], b[k]));
};

/**
 * Keep the answers in line with the groups now on offer: answers for groups that went away or to
 * options no longer offered are dropped, and a group with a single option takes it. Returns true
 * when anything changed (the preview then needs rebuilding).
 */
export const settleChoices = (choices, groups) => {
  let changed = false;
  const live = new Set(groups.map((g) => g.key));
  for (const key of Object.keys(choices)) {
    if (!live.has(key)) {
      delete choices[key];
      changed = true;
    }
  }
  for (const group of groups) {
    if (group.key in choices && !group.options.some((o) => sameValue(o.value, choices[group.key]))) {
      delete choices[group.key];
      changed = true;
    }
    if (!(group.key in choices) && group.options.length === 1 && !group.optional) {
      choices[group.key] = group.options[0].value;
      changed = true;
    }
  }
  return changed;
};

/** The option a group's answer points at */
export const chosenOption = (group, choices) =>
  group.key in choices ? (group.options.find((o) => sameValue(o.value, choices[group.key])) ?? null) : null;

/* -------------------------------------------- */
/*  Options from the compendiums                */
/* -------------------------------------------- */

// The fields the system indexes for its own compendium choices, plus the art
const QUERY_FIELDS = [
  'img',
  'flags',
  'system.ancestry',
  'system.baseItem',
  'system.category',
  'system.damage.damageType',
  'system.group',
  'system.level',
  'system.maxTakable',
  'system.publication.title',
  'system.range',
  'system.runes',
  'system.sanctification',
  'system.slug',
  'system.traits',
  'system.usage'
];

const rawIndex = new Map();
const candidates = new Map();

/** Every indexed item of a type, from all item compendiums and the world */
const indexOf = (itemType) => {
  if (!rawIndex.has(itemType)) {
    const promise = (async () => {
      const list = [];
      for (const pack of game.packs) {
        if (pack.metadata.type !== 'Item' || !pack.index.some((e) => e.type === itemType)) continue;
        try {
          const index = await pack.getIndex({ fields: QUERY_FIELDS });
          for (const raw of index) if (raw.type === itemType) list.push({ raw, pack: pack.collection });
        } catch (error) {
          console.error(`${MODULE_ID} | Failed to index ${pack.collection}`, error);
        }
      }
      for (const item of game.items.filter((i) => i.type === itemType)) list.push({ item });
      return list;
    })();
    rawIndex.set(itemType, promise);
    promise.catch(() => rawIndex.delete(itemType));
  }
  return rawIndex.get(itemType);
};

/** Index entries are only turned into items (for their roll options) when a filter wants them */
const candidateOf = ({ raw, pack, item }) => {
  const uuid = item?.uuid ?? raw.uuid ?? `Compendium.${pack}.Item.${raw._id}`;
  if (!candidates.has(uuid)) {
    let entry = null;
    try {
      const doc = item ?? new CONFIG.Item.documentClass(foundry.utils.deepClone(raw), { pack });
      entry = {
        uuid,
        name: doc.name,
        img: doc.img,
        slug: doc.slug ?? sluggify(doc.name),
        rarity: doc.system?.traits?.rarity ?? 'common',
        options: doc.getRollOptions('item')
      };
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not read ${uuid}`, error);
    }
    candidates.set(uuid, entry);
  }
  return candidates.get(uuid);
};

const ATOM = /^item:(tag|trait|category):(.+)$/;

/** Cheap checks on the raw index for the filter's plain "must have" statements */
const prefilter = (statements) => {
  const atoms = statements.filter((s) => typeof s === 'string').map((s) => ATOM.exec(s)).filter(Boolean);
  return ({ raw, item }) => {
    const system = (raw ?? item?._source)?.system ?? {};
    return atoms.every(([, kind, value]) => {
      if (kind === 'tag') return (system.traits?.otherTags ?? []).includes(value);
      if (kind === 'trait') return (system.traits?.value ?? []).includes(value);
      return system.category === value;
    });
  };
};

/** The options of a compendium-filter ChoiceSet, as the system's own query would find them */
const queryOptions = async (rule, choices, rollOptions) => {
  const statements = rule.resolveInjectedProperties(foundry.utils.deepClone(choices.filter));
  const filter = new game.pf2e.Predicate(statements);
  if (!filter.isValid || !filter.length) return [];
  const itemType = CONFIG.PF2E.Item.documentClasses?.[choices.itemType] ? choices.itemType : 'feat';
  const options = [...rollOptions];
  return (await indexOf(itemType))
    .filter((e) => typeof choices.pack !== 'string' || e.pack === choices.pack)
    .filter(prefilter(statements))
    .map(candidateOf)
    .filter((c) => c && filter.test([...c.options, ...options]))
    .map((c) => ({
      value: choices.slugsAsValues ? c.slug : c.uuid,
      uuid: c.uuid,
      label: c.name,
      img: c.img,
      rarity: c.rarity
    }))
    .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
};

/** Options listed on the rule itself (heal or harm, single or dual gate), checked against the actor */
const listedOptions = async (rule, list, rollOptions) => {
  const options = [];
  for (const choice of list) {
    const predicate = rule.resolveInjectedProperties(new game.pf2e.Predicate(choice.predicate ?? []));
    if (!predicate.test(rollOptions)) continue;
    const doc = isItemUuid(choice.value) ? await loadDocument(choice.value) : null;
    options.push({
      value: choice.value,
      uuid: doc ? choice.value : null,
      label: game.i18n.localize(choice.label ?? doc?.name ?? String(choice.value)),
      img: choice.img ?? doc?.img ?? null,
      rarity: doc?.system?.traits?.rarity ?? 'common'
    });
  }
  return options;
};

/** Options from a config path ("skills", "CONFIG.PF2E.damageTypes"), through the system */
const pathOptions = async (rule, rollOptions) =>
  (await rule.inflateChoices(rollOptions, [])).map((c) => ({
    value: c.value,
    uuid: isItemUuid(c.value) ? c.value : null,
    label: c.label,
    img: c.img ?? null,
    rarity: 'common'
  }));

/** Roll options a ChoiceSet's own answer sets; they must not decide whether it is asked */
const ownRollOptions = (rule, value) => {
  if (!rule.rollOption || value == null) return [];
  return isItemUuid(value) ? [rule.rollOption] : [`${rule.rollOption}:${value}`];
};

/**
 * The choices to ask for, read from the previewed character: one group per ChoiceSet on the level-1
 * class features and on the items chosen through them. Each group has the options the system would
 * offer, given the answers so far.
 * @param {Actor} preview  the previewed character, with the class features and chosen items on it
 * @param {object[]} items  [{ uuid, source, parentKey }] for the features, then the chosen items
 * @param {object} choices  the build's answers
 */
export const choiceGroups = async (preview, items, choices) => {
  const groups = [];
  const actorOptions = preview.getRollOptions();
  for (const { uuid, source, parentKey = null } of items) {
    const item = preview.items.get(source._id);
    if (!item) continue;
    const parentOptions = item.getRollOptions('parent');
    for (const rule of item.rules ?? []) {
      if (rule.key !== 'ChoiceSet' || rule.invalid) continue;
      const ruleSource = source.system.rules[rule.sourceIndex];
      if (!isAnswerable(ruleSource)) continue;
      const key = choiceKey(uuid, rule.sourceIndex);
      const own = new Set(ownRollOptions(rule, choices[key]));
      const rollOptions = new Set([...actorOptions, ...parentOptions].filter((o) => !own.has(o)));
      try {
        if (!rule.resolveInjectedProperties(rule.predicate).test(rollOptions)) continue;
        const raw = ruleSource.choices;
        const options = Array.isArray(raw)
          ? await listedOptions(rule, raw, rollOptions)
          : raw && typeof raw === 'object' && Array.isArray(raw.filter)
            ? await queryOptions(rule, raw, rollOptions)
            : await pathOptions(rule, rollOptions);
        groups.push({
          key,
          uuid,
          index: rule.sourceIndex,
          parentKey,
          itemName: source.name,
          prompt: game.i18n.localize(ruleSource.prompt ?? 'PF2E.UI.RuleElements.ChoiceSet.Prompt'),
          optional: !!ruleSource.allowNoSelection,
          // ChoiceSets on one item offering the same list (a commander's tactics) take different picks
          signature: JSON.stringify(raw),
          options
        });
      } catch (error) {
        console.warn(`${MODULE_ID} | Could not read the choice on ${source.name}`, error);
      }
    }
  }
  return groups;
};
