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

const { chooseLayout, prereqPill, mergeSkillChanges, actionGlyph, rankDots, languageChips, withTraitRequirements, gmApprovalPill, featLinkLookup, prereqFeatLinks } =
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
  const reincarnated = { category: 'ancestry', traits: ['reincarnated'] };
  const verdict = withTraitRequirements(none, reincarnated, ctx);
  assert.equal(verdict.status, 'unknown');
  assert.equal(verdict.results[0].text, 'DUMB_LEVEL_UP_WIZARD.prerequisites.reincarnated');
  assert.equal(withTraitRequirements(none, reincarnated, { featTraits: ['reincarnated'] }).status, 'met');
  const human = { category: 'ancestry', traits: ['human'] };
  assert.equal(withTraitRequirements(none, human, ctx), none);
  const unmet = { status: 'unmet', results: [{ text: 'x', status: 'unmet' }] };
  assert.equal(withTraitRequirements(unmet, reincarnated, ctx).status, 'unmet');
});

test('an ancestry feat with no traits is a check only when nothing else can be checked', () => {
  const ctx = { traits: ['human'], featTraits: [] };
  const untraited = { category: 'ancestry', traits: [] };
  const none = { status: 'met', results: [] };
  const verdict = withTraitRequirements(none, untraited, ctx);
  assert.equal(verdict.status, 'unknown');
  assert.equal(verdict.results[0].text, 'DUMB_LEVEL_UP_WIZARD.prerequisites.noAncestry');
  // its own prerequisites decide: "plant trait" for a leshy fits, for a human it doesn't
  const met = { status: 'met', results: [{ text: 'plant trait', status: 'met' }] };
  assert.equal(withTraitRequirements(met, untraited, ctx), met);
  const unmet = { status: 'unmet', results: [{ text: 'plant trait', status: 'unmet' }] };
  assert.equal(withTraitRequirements(unmet, untraited, ctx), unmet);
  // a general feat without traits is not an ancestry question
  assert.equal(withTraitRequirements(none, { category: 'general', traits: [] }, ctx), none);
});

test('uncommon, rare and unique feats get an Ask GM pill beside the fit pill', () => {
  assert.equal(gmApprovalPill('common'), null);
  assert.equal(gmApprovalPill(undefined), null);
  for (const rarity of ['uncommon', 'rare', 'unique']) {
    const pill = gmApprovalPill(rarity);
    assert.equal(pill.status, 'gm');
    assert.equal(pill.text, 'DUMB_LEVEL_UP_WIZARD.prerequisites.askGm');
  }
});

test('prerequisites that name feats link to them', () => {
  const feat = (name) => ({ uuid: `uuid-${name}`, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') });
  const lookup = featLinkLookup(
    ['Fey Influence', 'Assurance', 'Power Attack', 'Sudden Charge', 'Celebrity Dedication', 'Dandy Dedication', 'Orc Lore', 'Ironblood Stance'].map(feat)
  );
  const names = (text) => prereqFeatLinks(text, lookup).map((l) => l.name);
  assert.deepEqual(names('Fey Influence'), ['Fey Influence']);
  assert.deepEqual(names('Assurance (Athletics)'), ['Assurance']);
  assert.deepEqual(names('Power Attack or Sudden Charge'), ['Power Attack', 'Sudden Charge']);
  assert.deepEqual(names('Celebrity or Dandy Dedication'), ['Celebrity Dedication', 'Dandy Dedication']);
  assert.deepEqual(names('two stances (Ironblood Stance or another)'), ['Ironblood Stance']);
  // a Lore skill in a list is not the ancestry feat of the same name; the feat on its own is
  assert.deepEqual(names('trained in Belkzen Lore or Orc Lore'), []);
  assert.deepEqual(names('Orc Lore'), ['Orc Lore']);
  assert.deepEqual(names('trained in Athletics'), []);
  assert.equal(prereqFeatLinks('Fey Influence', lookup)[0].uuid, 'uuid-Fey Influence');
});
