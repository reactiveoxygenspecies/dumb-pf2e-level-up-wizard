// Slot matching and boost math against real PF2e feat data.
// Run: node tests/featSlots.test.mjs [path-to-pf2e-checkout]
// The checkout needs packs/pf2e/feats (PF2e 8.2.0 was used when writing these tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// A PF2e source checkout: `PF2E_SOURCE=/path/to/pf2e node --test`. The data tests skip without one.
const PF2E = process.argv[2] ?? process.env.PF2E_SOURCE ?? null;

// Minimal Foundry/PF2e globals used by the modules under test
globalThis.game = {
  i18n: { localize: (k) => k, format: (k) => k, lang: 'en' },
  settings: { get: () => 'NAME_ONLY' }
};
globalThis.CONFIG = {
  PF2E: {
    creatureTraits: Object.fromEntries(
      ['human', 'elf', 'dwarf', 'orc', 'goblin', 'halfling', 'gnome', 'leshy', 'aiuvarin', 'dromaar'].map((t) => [t, t])
    ),
    abilities: { str: 'Str', dex: 'Dex', con: 'Con', int: 'Int', wis: 'Wis', cha: 'Cha' }
  }
};

const { toEntry } = await import('../src/data/featIndex.js');
const { getCandidatesForSlot, buildIndexLookups } = await import('../src/data/featSlots.js');
const { describeBoosts } = await import('../src/data/plan.js');

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.json') && !name.startsWith('_') ? [path] : [];
  });

const featsDir = PF2E ? join(PF2E, 'packs/pf2e/feats') : null;
const haveData = !!featsDir && existsSync(featsDir);
const pack = { collection: 'pf2e.feats-srd' };
const index = haveData
  ? walk(featsDir).map((file) => toEntry({ ...JSON.parse(readFileSync(file, 'utf8')), type: 'feat' }, pack))
  : [];
const lookups = buildIndexLookups(index);
const granted = JSON.parse(readFileSync(new URL('../src/data/grantedArchetypeFeats.json', import.meta.url), 'utf8'));

// featSlots reads the granted data through loadGrantedArchetypeFeats(); feed it the file directly
globalThis.foundry = { utils: { fetchJsonWithTimeout: async () => granted } };
await (await import('../src/data/featSlots.js')).loadGrantedArchetypeFeats();

const slot = (groupId, level, filter) => ({ key: `${groupId}::${level}`, groupId, slotId: `${groupId}-${level}`, level, filter });
const candidates = (s, { owned = [], dedications = [] } = {}) =>
  getCandidatesForSlot(s, index, {
    ownedKeys: new Map(owned.map((k) => [k, 1])),
    dedications: new Set(dedications),
    ...lookups
  });
const names = (list) => list.map((c) => c.name);

test('feat data loaded', { skip: !haveData && 'PF2e checkout not found' }, () => {
  assert.ok(index.length > 3000, `only ${index.length} feats`);
});

test('class slot: class feats plus dedications, nothing above the slot level', { skip: !haveData }, () => {
  const list = candidates(slot('class', 2, { categories: ['class'], traits: ['fighter', 'dedication'] }));
  assert.ok(names(list).includes('Sudden Charge'));
  assert.ok(names(list).includes('Wizard Dedication'));
  assert.ok(!names(list).includes('Twin Takedown'), 'ranger feat leaked into fighter slot');
  assert.ok(list.every((c) => c.level <= 2));
  const dedication = list.find((c) => c.name === 'Wizard Dedication');
  assert.equal(dedication.isArchetype, true);
  assert.equal(list.find((c) => c.name === 'Sudden Charge').isArchetype, false);
});

test('universal ancestry feats, with or without traits, reach any ancestry slot', { skip: !haveData }, () => {
  const list = names(candidates(slot('ancestry', 5, { categories: ['ancestry'], traits: ['human'] })));
  assert.ok(list.includes('Fey Influence'), 'untraited universal feat missing');
  assert.ok(list.includes('Caustic Nectar'), 'untraited universal feat missing');
  assert.ok(list.includes('Reincarnated Ridiculer'), 'reincarnated feat missing');
  assert.ok(!list.includes('Dwarven Lore'), 'dwarf feat leaked into human slot');
});

test('versatile heritage: ancestry slot uses countsAs traits', { skip: !haveData }, () => {
  const list = candidates(slot('ancestry', 1, { categories: ['ancestry'], traits: ['human', 'elf', 'aiuvarin'] }));
  assert.ok(names(list).includes('Natural Ambition'));
  assert.ok(names(list).includes('Elven Lore'));
  assert.ok(!names(list).some((n) => n === 'Dwarven Lore'));
});

test('owned feats are excluded unless they can be taken again', { skip: !haveData }, () => {
  const general = slot('general', 3, { categories: ['general', 'skill'] });
  const assurance = index.find((e) => e.name === 'Assurance');
  const hauler = index.find((e) => e.name === 'Hefty Hauler');
  const list = candidates(general, { owned: [assurance.uuid, hauler.uuid] });
  assert.ok(names(list).includes('Assurance'), 'Assurance (maxTakable null = unlimited) should stay');
  assert.ok(!names(list).includes('Hefty Hauler'));
});

test('free archetype slot gets archetype-granted class feats at the archetype level', { skip: !haveData }, () => {
  const fa4 = slot('archetype', 4, { categories: ['class'], traits: ['archetype'] });
  const without = candidates(fa4);
  assert.ok(!names(without).includes('Twin Takedown'));
  const withDedication = candidates(fa4, { dedications: ['avenger-dedication'] });
  const twin = withDedication.find((c) => c.name === 'Twin Takedown');
  assert.ok(twin, 'Twin Takedown should be offered through Avenger Dedication');
  assert.equal(twin.effectiveLevel, 4);
  assert.equal(twin.isArchetype, true);
  // Below the archetype level it must not appear even though the ranger feat is level 1
  const fa2 = candidates(slot('archetype', 2, { categories: ['class'], traits: ['archetype'] }), {
    dedications: ['avenger-dedication']
  });
  assert.ok(!names(fa2).includes('Twin Takedown'));
});

test('mythic slot: and-conjunction with omitted traits', { skip: !haveData }, () => {
  const list = candidates(
    slot('mythic', 4, {
      categories: ['class'],
      traits: ['mythic'],
      omitTraits: ['calling', 'destiny'],
      conjunction: 'and'
    })
  );
  assert.ok(list.length > 0);
  assert.ok(list.every((c) => c.traits.includes('mythic') && !c.traits.includes('destiny')));
});

test('class features never fill a slot without a category filter', { skip: !haveData }, () => {
  const fakeFeature = { ...index[0], uuid: 'x', name: 'Fake Feature', category: 'classfeature', level: 1, traits: [] };
  const list = getCandidatesForSlot(slot('custom', 2, {}), [fakeFeature], {
    ownedKeys: new Map(),
    dedications: new Set(),
    ...buildIndexLookups([fakeFeature])
  });
  assert.equal(list.length, 0);
});

// --- Attribute boosts (mirrors PF2e's attribute builder) ---

const actorWith = (boosts, mods, flaws = []) => ({
  system: {
    build: { attributes: { boosts, flaws: { ancestry: flaws }, apex: null } },
    abilities: Object.fromEntries(Object.entries(mods).map(([k, mod]) => [k, { mod }]))
  }
});

test('boost above +4 is partial, second one completes it', () => {
  const actor = actorWith(
    { ancestry: ['str', 'dex'], background: ['str', 'con'], class: 'str', 1: ['str', 'dex', 'con', 'wis'], 5: [], 10: [], 15: [], 20: [] },
    { str: 4, dex: 2, con: 2, int: 0, wis: 1, cha: 0 }
  );
  const sets = [{ set: 5, existing: [], remaining: 4 }];
  const result = describeBoosts(actor, sets, { 5: ['str', 'dex'] });
  const str = result.sets[0].attributes.find((a) => a.key === 'str');
  assert.equal(str.partial, true);
  assert.equal(result.gains.str, 0);
  assert.equal(result.gains.dex, 1);
  assert.equal(result.modifiers.find((m) => m.key === 'dex').next, 3);

  // Level 10: the second boost after a partial raises the modifier
  const actor10 = actorWith(
    { ancestry: ['str', 'dex'], background: ['str', 'con'], class: 'str', 1: ['str', 'dex', 'con', 'wis'], 5: ['str', 'dex', 'con', 'wis'], 10: [], 15: [], 20: [] },
    { str: 4, dex: 3, con: 3, int: 0, wis: 2, cha: 0 }
  );
  const r10 = describeBoosts(actor10, [{ set: 10, existing: [], remaining: 4 }], { 10: ['str'] });
  assert.equal(r10.sets[0].attributes.find((a) => a.key === 'str').partial, false);
  assert.equal(r10.gains.str, 1);
});

test('existing boosts in a gradual set are locked and count toward the limit', () => {
  const actor = actorWith(
    { ancestry: [], background: [], class: 'int', 1: ['int'], 5: ['int'], 10: [], 15: [], 20: [] },
    { str: 0, dex: 0, con: 0, int: 3, wis: 0, cha: 0 }
  );
  const result = describeBoosts(actor, [{ set: 5, existing: ['int'], remaining: 1 }], { 5: [] });
  const int = result.sets[0].attributes.find((a) => a.key === 'int');
  assert.equal(int.locked, true);
  assert.equal(int.disabled, true);
  assert.equal(result.sets[0].complete, false);
});
