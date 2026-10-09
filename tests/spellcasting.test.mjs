// Slot tables, spell picks and the picker filter. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.game = { i18n: { localize: (k) => k, format: (k) => k, lang: 'en' }, settings: { get: () => null } };
globalThis.CONFIG = { PF2E: {} };

const { classRules, setSpellcastingData, slotsAt, slotChanges, spellPicks, spellCandidates } = await import(
  '../src/data/spellcasting.js'
);
setSpellcastingData(JSON.parse(readFileSync(new URL('../src/data/spellcasting.json', import.meta.url), 'utf8')));

/** A fake entry holding spells of the given ranks (0 = cantrip) */
const entryWith = (ranks, slots = {}) => ({
  id: 'entry',
  system: { slots },
  spells: Object.entries(ranks).flatMap(([rank, n]) =>
    Array.from({ length: n }, () => ({ isCantrip: rank === '0', baseRank: Number(rank) }))
  )
});
const counts = (picks) => Object.fromEntries(picks.map((p) => [p.key, p.count]));

test('animist is not automated', () => {
  assert.equal(classRules('animist'), null);
  assert.ok(classRules('wizard'));
});

test('slots include the wizard curriculum and the cleric font', () => {
  const wizard = slotsAt(classRules('wizard'), 1);
  assert.equal(wizard[0], 6);
  assert.equal(wizard[1], 3);
  assert.equal(wizard[2], 0);
  assert.equal(slotsAt(classRules('wizard'), 3)[2], 3);
  assert.equal(slotsAt(classRules('cleric'), 1)[1], 6);
  assert.equal(slotsAt(classRules('cleric'), 3)[1], 3, 'font moves to the highest rank');
  assert.equal(slotsAt(classRules('cleric'), 3)[2], 6);
});

test('slot changes compare with the entry', () => {
  const rules = classRules('sorcerer');
  const entry = entryWith({}, { slot0: { max: 5 }, slot1: { max: 4 } });
  const changes = slotChanges(rules, entry, 3);
  assert.deepEqual(
    changes.map((c) => [c.rank, c.from, c.to]),
    [[2, 0, 3]]
  );
});

test('new wizard: spellbook cantrips and first-rank spells with the curriculum', () => {
  assert.deepEqual(counts(spellPicks(classRules('wizard'), null, 0, 1)), {
    'spellbook-0': 10,
    'spellbook-1': 7
  });
});

test('wizard level-up adds two spells per level and a curriculum spell per new rank', () => {
  const picks = spellPicks(classRules('wizard'), entryWith({ 0: 10, 1: 7 }), 1, 3);
  assert.deepEqual(counts(picks), { 'spellbook-any': 5 });
  assert.equal(picks[0].maxRank, 2);
});

test('sorcerer repertoire fills what the entry lacks', () => {
  assert.deepEqual(counts(spellPicks(classRules('sorcerer'), null, 0, 1)), {
    'repertoire-0': 5,
    'repertoire-1': 3
  });
  assert.deepEqual(counts(spellPicks(classRules('sorcerer'), entryWith({ 0: 5, 1: 4 }), 2, 3)), {
    'repertoire-2': 3
  });
});

test('summoner repertoire is a total over the ranks it still has slots for', () => {
  const picks = spellPicks(classRules('summoner'), entryWith({ 0: 5, 1: 2, 2: 2 }), 4, 5);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].count, 3);
  assert.equal(picks[0].minRank, 2);
  assert.equal(picks[0].maxRank, 3);
});

test('witch familiar starts with 10 cantrips and 5 first-rank spells', () => {
  assert.deepEqual(counts(spellPicks(classRules('witch'), null, 0, 1)), {
    'familiar-0': 10,
    'familiar-1': 5
  });
});

test('candidates follow tradition, rank, known spells and rarity', () => {
  const index = [
    { uuid: 'a', slug: 'shield', rank: 1, cantrip: true, traditions: ['arcane'], rarity: 'common' },
    { uuid: 'b', slug: 'fear', rank: 1, cantrip: false, traditions: ['arcane', 'occult'], rarity: 'common' },
    { uuid: 'c', slug: 'blur', rank: 2, cantrip: false, traditions: ['arcane'], rarity: 'common' },
    { uuid: 'd', slug: 'secret', rank: 1, cantrip: false, traditions: ['arcane'], rarity: 'rare' },
    { uuid: 'e', slug: 'heal', rank: 1, cantrip: false, traditions: ['divine'], rarity: 'common' }
  ];
  const ids = (pick, opts) => spellCandidates(index, pick, opts).map((s) => s.uuid);
  assert.deepEqual(ids({ rank: 0 }, { tradition: 'arcane' }), ['a']);
  assert.deepEqual(ids({ rank: 1 }, { tradition: 'arcane', hiddenRarities: ['rare'] }), ['b']);
  assert.deepEqual(ids({ rank: null, maxRank: 2 }, { tradition: 'arcane', known: new Set(['fear']) }), ['c', 'd']);
  assert.deepEqual(ids({ rank: null, minRank: 2, maxRank: 3 }, { tradition: 'arcane' }), ['c']);
});

test('signature spells start at level 3, one per rank up to 9', async () => {
  const { signatureAt, isSignature } = await import('../src/data/spellcasting.js');
  assert.equal(signatureAt(classRules('sorcerer'), 2), null);
  assert.deepEqual(signatureAt(classRules('sorcerer'), 3), { mode: 'onePerRank', ranks: [1, 2] });
  assert.deepEqual(signatureAt(classRules('bard'), 20).ranks, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(signatureAt(classRules('wizard'), 5), null, 'prepared casters have none');
  const summoner = signatureAt(classRules('summoner'), 5);
  assert.equal(summoner.mode, 'all');
  assert.deepEqual(summoner.ranks, [2, 3], 'only the ranks the summoner still has');
  const choice = { 1: 'item:a', 2: 'new:b' };
  assert.equal(isSignature(signatureAt(classRules('sorcerer'), 3), choice, 'new:b', false), true);
  assert.equal(isSignature(signatureAt(classRules('sorcerer'), 3), choice, 'item:c', false), false);
  assert.equal(isSignature(summoner, {}, 'item:c', false), true);
  assert.equal(isSignature(summoner, {}, 'item:c', true), false, 'cantrips never');
});
