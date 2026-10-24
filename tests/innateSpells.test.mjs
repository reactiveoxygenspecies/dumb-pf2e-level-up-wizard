// Innate spells from feats and heritages: the generated data and how grants resolve. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.game = { system: { id: 'pf2e' }, i18n: { localize: (k) => k, format: (k) => k, lang: 'en' }, settings: { get: () => null } };
globalThis.CONFIG = { PF2E: {} };

const { innateRank, resolveInnateGrant, setInnateData } = await import('../src/data/innateSpells.js');
const data = JSON.parse(readFileSync(new URL('../src/data/innateSpells.json', import.meta.url), 'utf8'));
setInnateData(data);

const DETECT_MAGIC = 'Compendium.pf2e.spells-srd.Item.gpzpAAAJ1Lza2JVl';
const item = (rulesSelections = {}) => ({ flags: { pf2e: { rulesSelections } } });
const spell = (slug, extra = {}) => ({
  uuid: `Compendium.pf2e.spells-srd.Item.${slug}`,
  slug,
  rarity: 'common',
  cantrip: false,
  traditions: ['arcane'],
  ...extra
});
const index = [
  spell('shatter', { traditions: ['arcane', 'primal'] }),
  spell('tangle-vine', { cantrip: true, traditions: ['primal'] }),
  spell('light', { cantrip: true, traditions: ['arcane', 'divine', 'primal'] }),
  spell('rare-cantrip', { cantrip: true, traditions: ['primal'], rarity: 'rare' })
];

test('Seer Elf: detect magic, arcane, at will', () => {
  const [grant] = data.grants['seer-elf'].grants;
  assert.equal(grant.tradition, 'arcane');
  assert.equal(grant.atWill, true);
  const out = resolveInnateGrant(item(), grant, index);
  assert.deepEqual(out.fixed.map((s) => s.uuid), [DETECT_MAGIC]);
  assert.equal(out.options.length, 0);
});

test('ranks and uses are read per spell', () => {
  const [deny] = data.grants['deny-the-songs-of-war'].grants;
  assert.deepEqual(deny.spells.map((s) => s.rank ?? null), [null, 4], 'only Silence is 4th rank');
  assert.equal(deny.perDay, 1);
  assert.equal(deny.tradition, null, 'no tradition named: the player picks');
  const [shaitan] = data.grants['shaitan-skin'].grants;
  assert.equal(shaitan.perDay, 3);
  assert.equal(shaitan.spells[0].rank, 4);
});

test('"either X or Y" is a pick of one', () => {
  const [grant] = data.grants['the-moon-weavers-art'].grants;
  const out = resolveInnateGrant(item(), grant, index);
  assert.equal(out.fixed.length, 0);
  assert.equal(out.options.length, 2);
  assert.equal(out.count, 1);
});

test('a ChoiceSet spell follows the choice made in the system prompt', () => {
  const [grant] = data.grants['fiendish-magic'].grants;
  assert.equal(grant.kind, 'chosen');
  assert.equal(resolveInnateGrant(item(), grant, index), null, 'no choice yet');
  const out = resolveInnateGrant(item({ [grant.flag]: 'shatter' }), grant, index);
  assert.deepEqual(out.fixed, [{ uuid: spell('shatter').uuid, rank: 2, heighten: null }]);
});

test('"choose a cantrip from the primal list" offers the common primal cantrips', () => {
  const [grant] = data.grants['first-world-magic'].grants;
  const out = resolveInnateGrant(item(), grant, index);
  assert.deepEqual(out.options.map((s) => s.uuid.split('.').pop()), ['tangle-vine', 'light']);
  assert.equal(out.count, 1);
});

test('innate spells heighten to half the level when the feat says so', () => {
  assert.equal(innateRank({ heighten: 'half' }, 4, 13), 7);
  assert.equal(innateRank({ heighten: 'half' }, 4, 5), 4, 'never below the spell rank');
  assert.equal(innateRank({ rank: 2 }, 1, 9), 2);
  assert.equal(innateRank({}, 3, 9), 3);
});
