// Layout choice and presentation helpers of the level-up wizard. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.game = {
  i18n: {
    localize: (k) => k,
    format: (k, data) => `${k}:${JSON.stringify(data)}`,
    lang: 'en'
  }
};

const { chooseLayout, prereqPill, mergeSkillChanges, actionGlyph, rankDots, languageChips, withTraitRequirements } =
  await import('../src/apps/wizardView.js');

test('a level with two feats stays on one page', () => {
  assert.equal(chooseLayout({ feats: 2 }).layout, 'single');
  assert.equal(chooseLayout({ feats: 2, optionalFeats: true }).layout, 'single');
});

test('two feats and a boost set still fit one page; more choices switch to steps', () => {
  assert.equal(chooseLayout({ feats: 2, boostSets: 1 }).layout, 'single');
  assert.equal(chooseLayout({ feats: 2, boostSets: 1, languages: 1 }).layout, 'steps', 'four groups');
  assert.equal(chooseLayout({ feats: 1, skillIncreases: 1, skillOptions: 18 }).layout, 'steps', 'tall skill grid');
  assert.equal(chooseLayout({ feats: 4 }).layout, 'steps', 'more than three groups');
});

test('prerequisite pill gives the reason', () => {
  const unmet = prereqPill(
    { status: 'unmet', results: [{ text: 'trained in Athletics', status: 'met' }, { text: 'expert in Medicine', status: 'unmet' }] },
    ['trained in Athletics', 'expert in Medicine']
  );
  assert.equal(unmet.status, 'unmet');
  assert.match(unmet.text, /expert in Medicine/);
  assert.equal(prereqPill({ status: 'met', results: [] }, [], true).text, 'DUMB_LEVEL_UP_WIZARD.selector.fits');
  assert.equal(prereqPill(null), null);
});

test('skill picks stack and cap at legendary', () => {
  const options = [{ slug: 'arcana', label: 'Arcana', rank: 0 }, { slug: 'stealth', label: 'Stealth', rank: 3 }];
  const changes = mergeSkillChanges(options, ['arcana', 'arcana', 'stealth', 'stealth', '']);
  assert.deepEqual(changes, [
    { label: 'Arcana', from: 0, to: 2 },
    { label: 'Stealth', from: 3, to: 4 }
  ]);
});

test('action glyphs follow the PF2e font', () => {
  assert.equal(actionGlyph('action', 2).char, '2');
  assert.equal(actionGlyph('reaction', null).char, 'R');
  assert.equal(actionGlyph('free', null).char, 'F');
  assert.equal(actionGlyph('passive', null), null);
});

test('rank dots mark the gained rank', () => {
  assert.deepEqual(rankDots(1, 2).map((d) => [d.filled, d.gained]), [
    [true, false],
    [true, true],
    [false, false],
    [false, false]
  ]);
});

test('language chips keep chosen uncommon languages visible', () => {
  const options = [
    ...Array.from({ length: 10 }, (_, i) => ({ slug: `c${i}`, rarity: 'common' })),
    { slug: 'aklo', rarity: 'uncommon' }
  ];
  const { chips, hasMore } = languageChips(options, ['aklo'], false);
  assert.equal(chips.length, 9);
  assert.ok(chips.some((c) => c.slug === 'aklo'));
  assert.equal(hasMore, true);
});

test('a reincarnated feat with no prerequisites is a check, not a fit', () => {
  const none = { status: 'met', results: [] };
  const ctx = { traits: ['human'], featTraits: [] };
  const verdict = withTraitRequirements(none, ['reincarnated'], ctx);
  assert.equal(verdict.status, 'unknown');
  assert.equal(verdict.results[0].text, 'DUMB_LEVEL_UP_WIZARD.prerequisites.reincarnated');
  assert.equal(withTraitRequirements(none, ['reincarnated'], { featTraits: ['reincarnated'] }).status, 'met');
  assert.equal(withTraitRequirements(none, ['human'], ctx), none);
  const unmet = { status: 'unmet', results: [{ text: 'x', status: 'unmet' }] };
  assert.equal(withTraitRequirements(unmet, ['reincarnated'], ctx).status, 'unmet');
});
