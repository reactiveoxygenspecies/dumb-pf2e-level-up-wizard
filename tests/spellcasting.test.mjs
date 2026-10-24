// Slot tables, spell picks and the picker filter. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.game = { i18n: { localize: (k) => k, format: (k) => k, lang: 'en' }, settings: { get: () => null } };
globalThis.CONFIG = { PF2E: {} };

const {
  classRules,
  extraEntrySlotChanges,
  extraEntrySlotsAt,
  extraEntrySlotUpdate,
  extraEntrySpellSlug,
  extraEntrySource,
  findClassEntry,
  findExtraEntry,
  setSpellcastingData,
  slotsAt,
  slotChanges,
  spellPicks,
  spellCandidates
} = await import('../src/data/spellcasting.js');
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

test('slots include the wizard curriculum', () => {
  const wizard = slotsAt(classRules('wizard'), 1);
  assert.equal(wizard[0], 6);
  assert.equal(wizard[1], 3);
  assert.equal(wizard[2], 0);
  assert.equal(slotsAt(classRules('wizard'), 3)[2], 3);
  assert.equal(extraEntrySlotsAt(classRules('wizard'), 3), null);
});

test('cleric regular slots leave the divine font out', () => {
  const cleric = classRules('cleric');
  assert.equal(slotsAt(cleric, 1)[1], 2);
  assert.equal(slotsAt(cleric, 3)[2], 2);
  const level9 = slotsAt(cleric, 9);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((r) => level9[r]), [3, 3, 3, 3, 2, 0]);
});

test('divine font: 4, 5 then 6 slots, only at the highest rank', () => {
  const cleric = classRules('cleric');
  const total = (slots) => Object.values(slots).reduce((n, v) => n + v, 0);
  for (let level = 1; level <= 20; level++) {
    const font = extraEntrySlotsAt(cleric, level);
    const expected = level >= 15 ? 6 : level >= 5 ? 5 : 4;
    assert.equal(total(font), expected, `font total at level ${level}`);
    const ranks = Object.entries(font).filter(([, n]) => n > 0).map(([r]) => Number(r));
    assert.equal(ranks.length, 1, `one font rank at level ${level}`);
  }
  assert.equal(extraEntrySlotsAt(cleric, 1)[1], 4);
  assert.equal(extraEntrySlotsAt(cleric, 8)[4], 5);
  assert.equal(extraEntrySlotsAt(cleric, 9)[4], 0);
  assert.equal(extraEntrySlotsAt(cleric, 9)[5], 5);
  assert.equal(extraEntrySlotsAt(cleric, 15)[8], 6);
});

/** A fake spellcasting entry with slots per rank and prepared spell ids */
const fakeEntry = ({ id = 'font', name = 'Divine Font', flags = {}, slots = {}, spells = [] } = {}) => ({
  id,
  name,
  flags,
  system: {
    prepared: { value: 'prepared' },
    tradition: { value: 'divine' },
    slots: Object.fromEntries(
      Object.entries(slots).map(([rank, { max, prepared = [] }]) => [`slot${rank}`, { max, value: max, prepared }])
    )
  },
  spells
});

test('cleric level 8 to 9: regular rank-5 slots are 2, the font moves to rank 5 with its heal', () => {
  const cleric = classRules('cleric');
  const heal = { id: 'heal1', isCantrip: false, baseRank: 1 };
  const main = fakeEntry({
    id: 'main',
    name: 'Cleric Spells',
    flags: { 'dumb-pf2e-level-up-wizard': { classEntry: 'cleric' } },
    slots: { 0: { max: 5 }, 1: { max: 3 }, 2: { max: 3 }, 3: { max: 3 }, 4: { max: 3 } }
  });
  assert.deepEqual(
    slotChanges(cleric, main, 9).map((c) => [c.rank, c.from, c.to]),
    [[5, 0, 2]]
  );
  const font = fakeEntry({
    slots: { 4: { max: 5, prepared: Array.from({ length: 5 }, () => ({ id: 'heal1', expended: true })) } },
    spells: [heal]
  });
  assert.deepEqual(
    extraEntrySlotChanges(cleric, font, 9).map((c) => [c.rank, c.from, c.to]),
    [[4, 5, 0], [5, 0, 5]]
  );
  const update = extraEntrySlotUpdate(cleric, font, 'cleric', 9);
  assert.equal(update['system.slots.slot4.max'], 0);
  assert.equal(update['system.slots.slot5.max'], 5);
  assert.deepEqual(update['system.slots.slot4.prepared'], []);
  assert.deepEqual(
    update['system.slots.slot5.prepared'],
    Array.from({ length: 5 }, () => ({ id: 'heal1', expended: false }))
  );
  assert.equal(update['flags.dumb-pf2e-level-up-wizard.extraEntry'], 'cleric');
});

test('a new divine font entry is flagged apart from the class entry', () => {
  const source = extraEntrySource(classRules('cleric'), { slug: 'cleric', tradition: 'divine', level: 9 });
  assert.equal(source.system.slots.slot5.max, 5);
  assert.equal(source.system.slots.slot4.max, 0);
  assert.deepEqual(source.flags['dumb-pf2e-level-up-wizard'], { extraEntry: 'cleric' });
  assert.equal(extraEntrySource(classRules('druid'), { slug: 'druid', level: 9 }), null);
});

test('the divine font entry is never adopted as the class entry', () => {
  const cleric = classRules('cleric');
  const font = fakeEntry({ id: 'font', name: 'Divine Font' });
  const main = fakeEntry({ id: 'main', name: 'Cleric Spells' });
  const actor = { itemTypes: { spellcastingEntry: [font, main] } };
  assert.equal(findClassEntry(actor, cleric, 'cleric').entry.id, 'main');
  assert.equal(findExtraEntry(actor, cleric, 'cleric').entry.id, 'font');
  assert.equal(findExtraEntry({ itemTypes: { spellcastingEntry: [main] } }, cleric, 'cleric'), null);
});

test('the font spell comes from the Divine Font choice, else a single deity font', () => {
  const cleric = classRules('cleric');
  const feature = (choice) => ({ slug: 'divine-font', flags: { pf2e: { rulesSelections: { divineFont: choice } } } });
  assert.equal(extraEntrySpellSlug({ itemTypes: { feat: [feature('harm')] } }, cleric), 'harm');
  assert.equal(extraEntrySpellSlug({ itemTypes: { feat: [] }, deity: { system: { font: ['heal'] } } }, cleric), 'heal');
  assert.equal(extraEntrySpellSlug({ itemTypes: { feat: [] }, deity: { system: { font: ['heal', 'harm'] } } }, cleric), null);
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

test('a spontaneous caster swaps one repertoire spell per level gained', async () => {
  const { repertoireRank, swapCount, swapPick } = await import('../src/data/spellcasting.js');
  const repertoire = entryWith({ 0: 5, 1: 3 });
  assert.equal(swapCount(classRules('sorcerer'), repertoire, 4, 5), 1);
  assert.equal(swapCount(classRules('bard'), repertoire, 3, 5), 2, 'two levels at once');
  assert.equal(swapCount(classRules('wizard'), repertoire, 4, 5), 0, 'prepared casters keep a spellbook');
  assert.equal(swapCount(classRules('sorcerer'), entryWith({}), 4, 5), 0, 'nothing to swap');
  assert.equal(swapCount(classRules('sorcerer'), null, 4, 5), 0);

  const cantrip = { name: 'Shield', isCantrip: true, baseRank: 1, system: { location: {} } };
  const heightened = { name: 'Fear', isCantrip: false, baseRank: 1, system: { location: { heightenedLevel: 3 } } };
  assert.equal(repertoireRank(cantrip), 0);
  assert.equal(repertoireRank(heightened), 3, 'the rank it was learned at');
  assert.deepEqual(
    { ...swapPick(1, heightened), label: undefined },
    { kind: 'swap', key: 'swap-1', rank: 3, minRank: null, maxRank: null, count: 1, label: undefined }
  );
});
