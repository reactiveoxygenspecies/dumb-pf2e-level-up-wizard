// Formula grants, level-up picks and the candidate filter. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.game = { i18n: { localize: (k) => k, format: (k) => k, lang: 'en' }, settings: { get: () => null } };
globalThis.CONFIG = { PF2E: {} };

const {
  formulaCandidates,
  formulaFamily,
  grantedFormulaPicks,
  levelUpFormulaPicks,
  withFormulas
} = await import('../src/data/formulas.js');

const item = (name, level, traits = [], extra = {}) => ({
  uuid: `uuid-${name}`,
  name,
  slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  family: formulaFamily(name),
  type: 'consumable',
  level,
  traits: ['alchemical', ...traits],
  rarity: 'common',
  category: null,
  ...extra
});

const index = [
  item('Elixir of Life (Minor)', 1, ['elixir', 'healing'], { category: 'elixir' }),
  item('Elixir of Life (Lesser)', 5, ['elixir', 'healing'], { category: 'elixir' }),
  item('Elixir of Life (Moderate)', 9, ['elixir', 'healing'], { category: 'elixir' }),
  item('Acid Flask (Lesser)', 1, ['bomb'], { type: 'weapon' }),
  item('Versatile Vial', 1, ['bomb'], { type: 'weapon' }),
  item('Bestial Mutagen (Lesser)', 1, ['mutagen', 'elixir'], { category: 'mutagen' }),
  item('Arsenic', 1, ['poison'], { category: 'poison' }),
  item('Smokestick (Lesser)', 1, [], { category: 'other' }),
  item('Quicksilver Mutagen (Moderate)', 3, ['mutagen', 'elixir'], { category: 'mutagen' }),
  item('Rare Bomb', 1, ['bomb'], { type: 'weapon', rarity: 'rare' })
];
const names = (list) => list.map((e) => e.name);

test('formula families drop the grade in parentheses', () => {
  assert.equal(formulaFamily('Elixir of Life (Minor)'), formulaFamily('Elixir of Life (True)'));
  assert.equal(formulaFamily('Arsenic'), 'arsenic');
});

test('the formula book adds two formulas per level gained, capped at that level', () => {
  const features = [
    { slug: 'formula-book', name: 'Formula Book' },
    { slug: 'research-field', name: 'Research Field' }
  ];
  const one = levelUpFormulaPicks(features, 4, 5);
  assert.deepEqual(one.map((p) => [p.key, p.count, p.maxLevel, p.label]), [['formula-book-5', 2, 5, 'Formula Book']]);

  const jump = levelUpFormulaPicks(features, 3, 5);
  assert.deepEqual(jump.map((p) => [p.key, p.maxLevel]), [['formula-book-4', 4], ['formula-book-5', 5]]);

  assert.deepEqual(levelUpFormulaPicks([{ slug: 'reactive-shield', name: 'Reactive Shield' }], 4, 5), []);
});

test('the investigator methodology adds one elixir or tool per level', () => {
  const [pick] = levelUpFormulaPicks([{ slug: 'alchemical-sciences-methodology', name: 'Alchemical Sciences' }], 1, 2);
  assert.equal(pick.count, 1);
  assert.equal(pick.kind, 'elixirOrTool');
});

test('new feats and class features grant one-off formulas', () => {
  const picks = grantedFormulaPicks(
    [
      { type: 'feat', slug: 'alchemical-crafting', name: 'Alchemical Crafting' },
      { type: 'feat', slug: 'formula-book', name: 'Formula Book' },
      // The formula book item itself shares the slug and must not count
      { type: 'equipment', slug: 'formula-book', name: 'Formula Book' },
      { type: 'feat', slug: 'bomber', name: 'Bomber' },
      { type: 'feat', slug: 'alchemist-dedication', name: 'Alchemist Dedication' },
      { type: 'feat', slug: 'power-attack', name: 'Power Attack' }
    ],
    6
  );
  assert.deepEqual(
    picks.map((p) => [p.key, p.kind, p.count, p.maxLevel]),
    [
      ['alchemical-crafting', 'any', 4, 1],
      ['formula-book', 'any', 2, 1],
      ['bomber', 'bomb', 2, 1],
      ['alchemist-dedication', 'any', 4, 6]
    ]
  );
});

test('candidates respect level, kind and rarity', () => {
  const pick = (kind, maxLevel = 1) => ({ key: 'k', kind, count: 2, maxLevel });
  const known = new Set();
  assert.deepEqual(names(formulaCandidates(index, pick('bomb'), { known })), ['Acid Flask (Lesser)']);
  assert.deepEqual(names(formulaCandidates(index, pick('poison'), { known })), ['Arsenic']);
  assert.deepEqual(names(formulaCandidates(index, pick('healingElixir'), { known })), ['Elixir of Life (Minor)']);
  assert.deepEqual(names(formulaCandidates(index, pick('mutagen', 3), { known })), [
    'Quicksilver Mutagen (Moderate)',
    'Bestial Mutagen (Lesser)'
  ]);
  assert.deepEqual(names(formulaCandidates(index, pick('elixirOrTool'), { known })), [
    'Bestial Mutagen (Lesser)',
    'Elixir of Life (Minor)',
    'Smokestick (Lesser)'
  ]);
  assert.ok(!names(formulaCandidates(index, pick('any', 20), { known })).includes('Rare Bomb'));
});

test('a known formula hides itself and its stronger versions, not weaker ones', () => {
  const pick = { key: 'k', kind: 'healingElixir', count: 2, maxLevel: 20 };
  const fromLesser = formulaCandidates(index, pick, { known: new Set(['uuid-Elixir of Life (Lesser)']) });
  assert.deepEqual(names(fromLesser), ['Elixir of Life (Minor)']);
  const fromMinor = formulaCandidates(index, pick, { known: new Set(['uuid-Elixir of Life (Minor)']) });
  assert.deepEqual(names(fromMinor), []);
});

test('formulas are appended once, keeping the existing entries', () => {
  const actor = { _source: { system: { crafting: { formulas: [{ uuid: 'a', deletable: true }] } } } };
  assert.deepEqual(withFormulas(actor, ['a', 'b', 'b']), [{ uuid: 'a', deletable: true }, { uuid: 'b' }]);
});
