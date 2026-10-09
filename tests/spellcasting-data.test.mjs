// Sanity checks for src/data/spellcasting.json (built by scripts/build-spellcasting.mjs).
// Run: node --test tests/spellcasting-data.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'spellcasting.json');

const CASTERS = ['animist', 'bard', 'cleric', 'druid', 'magus', 'oracle', 'psychic', 'sorcerer', 'summoner', 'witch', 'wizard'];
const RANKS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const TRADITIONS = ['arcane', 'divine', 'occult', 'primal'];

test('the JSON parses and has every caster class', () => {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(data).sort(), [...CASTERS].sort());
});

const data = JSON.parse(readFileSync(file, 'utf8'));

/** Every number array that should hold one value per level, with a label. */
function* levelArrays(slug, c) {
  yield [`${slug}.cantrips`, c.cantrips];
  for (const r of RANKS) yield [`${slug}.slots.${r}`, c.slots[r]];
  if (c.secondary) {
    yield [`${slug}.secondary.cantrips`, c.secondary.cantrips];
    for (const r of RANKS) yield [`${slug}.secondary.slots.${r}`, c.secondary.slots[r]];
  }
  if (c.extraSlots) {
    if (c.extraSlots.cantrips) yield [`${slug}.extraSlots.cantrips`, c.extraSlots.cantrips];
    for (const r of RANKS) yield [`${slug}.extraSlots.slots.${r}`, c.extraSlots.slots[r]];
  }
  if (c.repertoire) {
    yield [`${slug}.repertoire.cantrips`, c.repertoire.cantrips];
    if (c.repertoire.ranks) for (const r of RANKS) yield [`${slug}.repertoire.ranks.${r}`, c.repertoire.ranks[r]];
    if (c.repertoire.total) yield [`${slug}.repertoire.total`, c.repertoire.total];
    if (c.repertoire.granted) {
      yield [`${slug}.repertoire.granted.cantrips`, c.repertoire.granted.cantrips];
      for (const r of RANKS) yield [`${slug}.repertoire.granted.ranks.${r}`, c.repertoire.granted.ranks[r]];
    }
  }
}

for (const slug of CASTERS) {
  const c = data[slug];

  test(`${slug}: required fields`, () => {
    assert.equal(typeof c.name, 'string');
    assert.equal(typeof c.automate, 'boolean');
    assert.ok(c.tradition === null || TRADITIONS.includes(c.tradition), `tradition ${c.tradition}`);
    if (c.tradition === null) assert.equal(typeof c.traditionSource, 'string');
    else assert.equal(c.traditionSource, null);
    assert.ok(['prepared', 'spontaneous'].includes(c.preparation));
    assert.ok(Array.isArray(c.footnotes));
    assert.equal(typeof c.notes, 'string');
    assert.deepEqual(Object.keys(c.slots), RANKS);
    if (c.preparation === 'spontaneous' && !c.secondary) {
      assert.ok(c.repertoire, 'spontaneous casters need a repertoire');
      assert.equal(c.spellbook, null);
      assert.equal(c.familiar, null);
    }
    if (c.preparation === 'prepared') assert.equal(c.repertoire, null);
  });

  test(`${slug}: 20 non-negative integers everywhere`, () => {
    for (const [label, arr] of levelArrays(slug, c)) {
      assert.ok(Array.isArray(arr), `${label} is not an array`);
      assert.equal(arr.length, 20, `${label} has ${arr.length} values`);
      for (const n of arr) assert.ok(Number.isInteger(n) && n >= 0, `${label} has bad value ${n}`);
    }
  });

  test(`${slug}: slots never decrease level to level`, () => {
    for (const r of RANKS) {
      const arr = c.slots[r];
      if (!c.dropsLowerRanks) {
        for (let i = 1; i < 20; i++) assert.ok(arr[i] >= arr[i - 1], `${slug} rank ${r} drops at level ${i + 1}`);
      } else {
        // Magus and summoner give up lower ranks: a rank may fall to 0 once, but never comes back,
        // and while it is in use it never decreases.
        let gone = false;
        for (let i = 1; i < 20; i++) {
          if (arr[i] === 0 && arr[i - 1] > 0) gone = true;
          else if (!gone) assert.ok(arr[i] >= arr[i - 1], `${slug} rank ${r} drops at level ${i + 1}`);
          if (gone) assert.equal(arr[i], 0, `${slug} rank ${r} returns at level ${i + 1}`);
        }
      }
    }
    // The cantrip count and the repertoire never shrink either (except the summoner total, which is capped).
    for (let i = 1; i < 20; i++) assert.ok(c.cantrips[i] >= c.cantrips[i - 1]);
  });

  test(`${slug}: a rank first appears at 1, 3, 5 ... (odd level, 2*rank-1)`, () => {
    const tables = [c.slots, ...(c.secondary ? [c.secondary.slots] : [])];
    for (const slots of tables) {
      for (const r of RANKS) {
        const first = slots[r].findIndex((n) => n > 0) + 1; // 0 when never
        if (first === 0) continue;
        assert.equal(first % 2, 1, `${slug} rank ${r} first at even level ${first}`);
        assert.equal(first, 2 * Number(r) - 1, `${slug} rank ${r} first at level ${first}`);
      }
    }
    // Every caster reaches 9th rank at level 17 and has the 10th-rank slot at 19.
    assert.equal(c.slots['9'].findIndex((n) => n > 0) + 1 || c.secondary?.slots['9'].findIndex((n) => n > 0) + 1, 17);
  });

  test(`${slug}: extra slots never exceed the highest rank the class can cast`, () => {
    if (!c.extraSlots) return;
    for (let i = 0; i < 20; i++) {
      const highest = Math.max(0, ...RANKS.filter((r) => c.slots[r][i] > 0).map(Number));
      for (const r of RANKS) {
        if (c.extraSlots.slots[r][i] > 0) assert.ok(Number(r) <= highest, `${slug} extra rank ${r} at level ${i + 1}`);
      }
    }
  });
}

test('wizard: 1st-rank slots are 2 at level 1 and 3 at level 2 (journal table)', () => {
  const w = data.wizard;
  assert.equal(w.slots['1'][0], 2);
  assert.equal(w.slots['1'][1], 3);
  assert.deepEqual(w.cantrips, Array(20).fill(5));
  assert.equal(w.slots['3'][4], 2); // 3rd rank at level 5
  assert.equal(w.slots['10'][18], 1);
  assert.equal(w.slots['10'][19], 1);
  assert.equal(w.automate, true);
  assert.equal(w.tradition, 'arcane');
  assert.equal(w.preparation, 'prepared');
  assert.deepEqual({ ...w.spellbook, note: undefined, curriculum: undefined }, { cantrips: 10, firstRank: 5, perLevel: 2, note: undefined, curriculum: undefined });
  assert.equal(w.extraSlots.perRank, 1);
  assert.equal(w.extraSlots.slots['1'][0], 1);
  assert.equal(w.extraSlots.slots['10'].every((n) => n === 0), true);
});

test('spot checks against the journal tables', () => {
  // cleric: heal/harm font at the highest rank
  assert.equal(data.cleric.extraSlots.slots['1'][0], 4);
  assert.equal(data.cleric.extraSlots.slots['3'][4], 5);
  assert.equal(data.cleric.extraSlots.slots['8'][14], 6);
  assert.equal(data.cleric.extraSlots.slots['9'][18], 6);
  // sorcerer / oracle: 3 first-rank slots at level 1
  assert.equal(data.sorcerer.slots['1'][0], 3);
  assert.equal(data.oracle.slots['1'][0], 3);
  assert.equal(data.sorcerer.repertoire.ranks['1'][0], 3);
  // psychic: 1 slot at 1st level, 2 afterwards
  assert.deepEqual(data.psychic.slots['1'].slice(0, 3), [1, 2, 2]);
  // magus and summoner lose their 1st-rank slots at level 5
  assert.equal(data.magus.slots['1'][3], 2);
  assert.equal(data.magus.slots['1'][4], 0);
  assert.equal(data.summoner.slots['1'][4], 0);
  // magus studious slots
  assert.equal(data.magus.extraSlots.slots['2'][6], 2);
  assert.equal(data.magus.extraSlots.slots['4'][12], 2);
  // animist: "2+4" cantrips at level 15, "0+1" tenth rank at 19
  assert.equal(data.animist.cantrips[14], 2);
  assert.equal(data.animist.secondary.cantrips[14], 4);
  assert.equal(data.animist.secondary.slots['10'][18], 1);
  assert.equal(data.animist.automate, false);
  // witch familiar
  assert.deepEqual({ c: data.witch.familiar.cantrips, f: data.witch.familiar.firstRank, p: data.witch.familiar.perLevel }, { c: 10, f: 5, p: 2 });
});
