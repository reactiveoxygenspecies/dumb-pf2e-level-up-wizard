import { MODULE_ID, TEMPLATE_PATH } from '../constants.js';
import { localize, renderTemplate, sluggify } from '../helpers/utility.js';

/* -------------------------------------------- */
/*  Rules                                       */
/* -------------------------------------------- */

/**
 * Which alchemical items a formula grant allows. Research fields and the investigator's methodology
 * each ask for one kind of item; everything else takes any common alchemical item.
 */
const KINDS = {
  any: () => true,
  bomb: (e) => e.traits.includes('bomb') && e.slug !== 'versatile-vial',
  poison: (e) => e.category === 'poison',
  healingElixir: (e) => e.traits.includes('elixir') && e.traits.includes('healing'),
  mutagen: (e) => e.traits.includes('mutagen'),
  // Alchemical tools have no trait of their own; they are the alchemical consumables that are not
  // bombs, elixirs, mutagens, poisons or drugs
  elixirOrTool: (e) =>
    e.traits.includes('elixir') ||
    (e.type === 'consumable' &&
      ['other', 'toolkit'].includes(e.category) &&
      !['bomb', 'mutagen', 'poison', 'drug'].some((t) => e.traits.includes(t)))
};

/**
 * Formulas a feat or class feature adds once, when it is gained (slug → grant). `level` is the
 * highest item level allowed; null means the character's level.
 */
export const FORMULA_GRANTS = {
  'alchemical-crafting': { kind: 'any', count: 4, level: 1 },
  'formula-book': { kind: 'any', count: 2, level: 1 },
  'alchemist-dedication': { kind: 'any', count: 4, level: null },
  bomber: { kind: 'bomb', count: 2, level: 1 },
  chirurgeon: { kind: 'healingElixir', count: 2, level: 1 },
  mutagenist: { kind: 'mutagen', count: 2, level: 1 },
  toxicologist: { kind: 'poison', count: 2, level: 1 },
  'alchemical-sciences-methodology': { kind: 'elixirOrTool', count: 2, level: 1 }
};

/** Formulas a class feature adds every level after the first (the alchemist's formula book) */
export const LEVEL_GRANTS = {
  'formula-book': { kind: 'any', count: 2 },
  'alchemical-sciences-methodology': { kind: 'elixirOrTool', count: 1 }
};

const slugOf = (item) => item.slug ?? item.system?.slug ?? sluggify(item.name);

/**
 * Formula picks for the levels gained, from the class features the actor has: one pick per feature
 * and level, each limited to items of that level or lower.
 * @param {{ slug: string, name: string }[]} features the actor's feats and class features
 */
export const levelUpFormulaPicks = (features, previousLevel, targetLevel) => {
  const picks = [];
  const seen = new Set();
  for (const feature of features) {
    const grant = LEVEL_GRANTS[feature.slug];
    if (!grant || seen.has(feature.slug)) continue;
    seen.add(feature.slug);
    for (let level = previousLevel + 1; level <= targetLevel; level++) {
      picks.push({
        key: `${feature.slug}-${level}`,
        label:
          targetLevel - previousLevel > 1
            ? localize('formulas.atLevel', { name: feature.name, level })
            : feature.name,
        kind: grant.kind,
        count: grant.count,
        maxLevel: level
      });
    }
  }
  return picks;
};

/** Formula picks the newly gained items give (feats, class features, research fields) */
export const grantedFormulaPicks = (items, level) => {
  const picks = [];
  const seen = new Set();
  for (const item of items) {
    if (item.type !== 'feat') continue;
    const slug = slugOf(item);
    const grant = FORMULA_GRANTS[slug];
    if (!grant || seen.has(slug)) continue;
    seen.add(slug);
    picks.push({
      key: slug,
      label: item.name,
      kind: grant.kind,
      count: grant.count,
      maxLevel: grant.level ?? level
    });
  }
  return picks;
};

/** "Elixir of Life (Minor)" and "Elixir of Life (Greater)" share one formula family */
export const formulaFamily = (name) => sluggify(String(name ?? '').replace(/\s*\([^)]*\)\s*$/, ''));

/**
 * Items a pick can take: common, alchemical, of the pick's kind and level, not known yet. Stronger
 * versions of a formula the actor knows (or picked elsewhere) are left out: the base formula already
 * covers them.
 * @param {object[]} index formula index
 * @param {object} pick
 * @param {object} options
 * @param {Set<string>} options.known uuids already in the formula book or picked for another pick
 */
export const formulaCandidates = (index, pick, { known }) => {
  const lowest = new Map();
  for (const entry of index) {
    if (!known.has(entry.uuid)) continue;
    lowest.set(entry.family, Math.min(lowest.get(entry.family) ?? Infinity, entry.level));
  }
  const matches = KINDS[pick.kind] ?? KINDS.any;
  return index
    .filter((e) => e.rarity === 'common' && e.level <= pick.maxLevel && matches(e))
    .filter((e) => !known.has(e.uuid) && !(lowest.get(e.family) <= e.level))
    .sort((a, b) => b.level - a.level || a.name.localeCompare(b.name, game.i18n.lang));
};

/** Uuids in the actor's formula book */
export const knownFormulas = (actor) =>
  new Set((actor._source.system.crafting?.formulas ?? []).map((f) => f.uuid).filter(Boolean));

/** The formula list with `uuids` added (once each) */
export const withFormulas = (actor, uuids) => {
  const current = actor._source.system.crafting?.formulas ?? [];
  const known = new Set(current.map((f) => f.uuid));
  return [...current, ...[...new Set(uuids)].filter((u) => !known.has(u)).map((uuid) => ({ uuid }))];
};

/* -------------------------------------------- */
/*  Index                                       */
/* -------------------------------------------- */

const FIELDS = [
  'system.slug',
  'system.level.value',
  'system.traits.value',
  'system.traits.rarity',
  'system.category'
];
const PHYSICAL_TYPES = new Set(['consumable', 'weapon', 'ammo', 'armor', 'equipment', 'shield']);

let cache = null;

export const invalidateFormulaIndex = () => {
  cache = null;
};

const toEntry = (raw, pack) => {
  const system = raw.system ?? {};
  const originalName = raw.originalName ?? null;
  return {
    uuid: raw.uuid ?? `Compendium.${pack.collection}.Item.${raw._id}`,
    name: raw.name,
    slug: system.slug || sluggify(originalName ?? raw.name),
    family: formulaFamily(originalName ?? raw.name),
    img: raw.img,
    type: raw.type,
    level: Number(system.level?.value ?? 0),
    traits: system.traits?.value ?? [],
    rarity: system.traits?.rarity ?? 'common',
    category: system.category ?? null,
    searchText: `${raw.name} ${originalName ?? ''}`.toLocaleLowerCase()
  };
};

/**
 * Every alchemical item in the packs the compendium browser loads for equipment (plus any other Item
 * pack of physical items the user can see).
 * @returns {Promise<object[]>}
 */
export const getFormulaIndex = async () => {
  if (cache) return cache;
  cache = (async () => {
    let browserSettings = {};
    try {
      browserSettings = game.settings.get(game.system.id, 'compendiumBrowserPacks')?.equipment ?? {};
    } catch {
      browserSettings = {};
    }
    const entries = [];
    const seen = new Set();
    for (const pack of game.packs) {
      if (pack.documentName !== 'Item') continue;
      if (!pack.testUserPermission(game.user, 'LIMITED')) continue;
      if (!pack.index.some((e) => PHYSICAL_TYPES.has(e.type))) continue;
      if (browserSettings[pack.collection]?.load === false) continue;
      try {
        const index = await pack.getIndex({ fields: FIELDS });
        for (const raw of index) {
          if (!PHYSICAL_TYPES.has(raw.type) || !raw.system?.traits?.value?.includes('alchemical')) continue;
          const entry = toEntry(raw, pack);
          if (seen.has(entry.uuid)) continue;
          seen.add(entry.uuid);
          entries.push(entry);
        }
      } catch (error) {
        console.error(`${MODULE_ID} | Failed to index alchemical items in ${pack.collection}`, error);
      }
    }
    return entries;
  })();
  cache.catch(() => {
    cache = null;
  });
  return cache;
};

export const registerFormulaIndexHooks = () => {
  const onChange = (item) => {
    if (item.pack && PHYSICAL_TYPES.has(item.type)) invalidateFormulaIndex();
  };
  Hooks.on('createItem', onChange);
  Hooks.on('updateItem', onChange);
  Hooks.on('deleteItem', onChange);
};

/* -------------------------------------------- */
/*  Picker                                      */
/* -------------------------------------------- */

/**
 * View data for formula picks, in the shape of the shared spell picker (partials/spell-picker.hbs).
 * @param {object} options
 * @param {object[]} options.picks
 * @param {object[]} options.index formula index
 * @param {Record<string, string[]>} options.selection pick key → chosen uuids
 * @param {Set<string>} options.known uuids in the formula book
 * @param {Record<string, string>} [options.search] pick key → search text
 */
export const formulaPickerView = ({ picks, index, selection, known, search = {} }) => {
  const chosenAnywhere = Object.values(selection).flat();
  return picks.map((pick) => {
    const chosen = selection[pick.key] ?? [];
    const elsewhere = chosenAnywhere.filter((uuid) => !chosen.includes(uuid));
    const candidates = formulaCandidates(index, pick, { known: new Set([...known, ...elsewhere]) });
    const term = (search[pick.key] ?? '').trim().toLocaleLowerCase();
    const full = chosen.length >= pick.count;
    return {
      key: pick.key,
      label: pick.label,
      action: 'toggleFormula',
      hint: localize(`formulas.kind.${pick.kind}`, { level: pick.maxLevel }),
      searchLabel: localize('formulas.search'),
      emptyLabel: localize('formulas.none'),
      readLabel: localize('formulas.read'),
      count: pick.count,
      chosenCount: chosen.length,
      complete: chosen.length === pick.count,
      search: search[pick.key] ?? '',
      empty: candidates.length === 0,
      rows: candidates.map((e) => ({
        uuid: e.uuid,
        name: e.name,
        img: e.img,
        searchText: e.searchText,
        hidden: !!term && !e.searchText.includes(term),
        rankLabel: localize('formulas.level', { level: e.level }),
        rarity: e.rarity,
        rarityLabel: null,
        chosen: chosen.includes(e.uuid),
        disabled: full && !chosen.includes(e.uuid)
      }))
    };
  });
};

/* -------------------------------------------- */
/*  Granted formulas, after a build or level-up */
/* -------------------------------------------- */

/** Ask for the formulas the picks allow; resolves to the chosen uuids, or null when skipped */
const askFormulas = async (picks, index, known, { windowId } = {}) => {
  let selection = {};
  const search = {};
  const groups = () => formulaPickerView({ picks, index, selection, known, search });
  const content = async () =>
    renderTemplate(`${TEMPLATE_PATH}/formula-dialog.hbs`, { intro: localize('formulas.dialog.intro'), groups: groups() });

  return foundry.applications.api.DialogV2.wait({
    window: { title: localize('formulas.dialog.title'), icon: 'fa-solid fa-flask' },
    classes: [MODULE_ID, 'lvlup-formula-dialog'],
    position: { width: 520 },
    content: await content(),
    rejectClose: false,
    // Not modal: a modal dialog stays above every other window, so an item opened from the book icon
    // would land behind it, out of reach
    modal: false,
    renderOptions: windowId ? { window: { windowId } } : undefined,
    actions: {
      // Picking re-renders the lists, so a formula picked in one group leaves the others
      toggleFormula: async function (event, target) {
        const { pick: key, uuid } = target.dataset;
        const pick = picks.find((p) => p.key === key);
        const chosen = selection[key] ?? [];
        if (chosen.includes(uuid)) selection = { ...selection, [key]: chosen.filter((u) => u !== uuid) };
        else if (pick && chosen.length < pick.count) selection = { ...selection, [key]: [...chosen, uuid] };
        const body = this.element.querySelector('.lvl-formula-dialog');
        const scroll = Object.fromEntries(
          [...body.querySelectorAll('[data-spell-group]')].map((g) => [
            g.dataset.spellGroup,
            g.querySelector('.lvl-spell-list')?.scrollTop ?? 0
          ])
        );
        body.outerHTML = await content();
        const fresh = this.element.querySelector('.lvl-formula-dialog');
        bindSearch(fresh, search);
        for (const [group, top] of Object.entries(scroll)) {
          const list = fresh.querySelector(`[data-spell-group="${CSS.escape(group)}"] .lvl-spell-list`);
          if (list) list.scrollTop = top;
        }
        fresh
          .querySelector(`[data-pick="${CSS.escape(key)}"][data-uuid="${CSS.escape(uuid)}"]`)
          ?.focus({ preventScroll: true });
      }
    },
    render: (event, dialog) => bindSearch(dialog.element.querySelector('.lvl-formula-dialog'), search),
    buttons: [
      {
        action: 'add',
        label: localize('formulas.dialog.add'),
        icon: 'fa-solid fa-check',
        default: true,
        callback: () => Object.values(selection).flat()
      },
      { action: 'skip', label: localize('formulas.dialog.skip'), icon: 'fa-solid fa-xmark' }
    ]
  }).then((result) => (Array.isArray(result) ? result : null));
};

/** Search filtering for a rendered picker; it only hides rows */
const bindSearch = (root, search) => {
  root?.querySelectorAll('[data-spell-search]').forEach((input) => {
    // Enter would submit the dialog with whatever is picked so far
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') event.preventDefault();
    });
    input.addEventListener('input', (event) => {
      const key = event.currentTarget.dataset.spellSearch;
      search[key] = event.currentTarget.value;
      const needle = search[key].trim().toLocaleLowerCase();
      event.currentTarget
        .closest('[data-spell-group]')
        ?.querySelectorAll('[data-spell-row]')
        .forEach((row) => {
          row.hidden = !!needle && !row.dataset.search.includes(needle);
        });
    });
  });
};

/**
 * After a build or level-up: offer the formulas the new feats and class features give (Alchemical
 * Crafting, a research field, Alchemist Dedication...) and add the chosen ones to the formula book.
 * Never throws; returns the added formulas as `{ name, uuid }`.
 */
export const offerFormulas = async (actor, newItems, options = {}) => {
  try {
    const picks = grantedFormulaPicks(newItems, actor.level);
    if (!picks.length) return [];
    const index = await getFormulaIndex();
    const known = knownFormulas(actor);
    const chosen = await askFormulas(picks, index, known, options);
    if (!chosen?.length) return [];
    await actor.update(
      { 'system.crafting.formulas': withFormulas(actor, chosen) },
      { [MODULE_ID]: { formulas: true } }
    );
    return describeFormulas(index, chosen.filter((uuid) => !known.has(uuid)));
  } catch (error) {
    console.error(`${MODULE_ID} | Could not add formulas`, error);
    ui.notifications.warn(localize('formulas.failed'));
    return [];
  }
};

/** Names and uuids of formulas for summaries */
export const describeFormulas = (index, uuids) => {
  const byUuid = new Map(index.map((e) => [e.uuid, e]));
  return uuids.map((uuid) => ({ name: byUuid.get(uuid)?.name ?? uuid, uuid }));
};
