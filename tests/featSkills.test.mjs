// Feats that train a skill the character already has. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.game = { i18n: { localize: (k) => k, format: (k) => k, lang: 'en' }, settings: { get: () => null } };
globalThis.CONFIG = { PF2E: {} };

const { keepReplacements, overlappingTrainings, trainedSkillsOf } = await import('../src/data/featSkills.js');

const SKILLS = ['acrobatics', 'athletics', 'stealth', 'thievery'];

// Rules copied from PF2e 8.2.0 pack data
const bouncyGoblin = {
  system: {
    rules: [
      { key: 'FlatModifier', predicate: ['action:tumble-through'], selector: 'acrobatics', type: 'circumstance', value: 2 },
      { key: 'ActiveEffectLike', mode: 'upgrade', path: 'system.skills.acrobatics.rank', value: 1 }
    ]
  }
};

test('a feat trains the skills its rules raise to trained', () => {
  assert.deepEqual(trainedSkillsOf(bouncyGoblin, SKILLS), ['acrobatics']);
});

test('conditional, chosen, higher-rank and lore trainings are left out', () => {
  const feat = {
    system: {
      rules: [
        { key: 'ActiveEffectLike', mode: 'upgrade', path: 'system.skills.athletics.rank', value: 1, predicate: ['feat:x'] },
        { key: 'ActiveEffectLike', mode: 'upgrade', path: 'system.skills.{item|flags.system.rulesSelections.skill}.rank', value: 1 },
        { key: 'ActiveEffectLike', mode: 'upgrade', path: 'system.skills.stealth.rank', value: 2 },
        { key: 'ActiveEffectLike', mode: 'upgrade', path: 'system.skills.warfare-lore.rank', value: 1 },
        { key: 'ActiveEffectLike', mode: 'add', path: 'system.skills.thievery.rank', value: 1 }
      ]
    }
  };
  assert.deepEqual(trainedSkillsOf(feat, SKILLS), []);
});

test('only trainings on a skill already trained need a replacement', () => {
  const picks = [
    { key: 'ancestry-1', name: 'Bouncy Goblin', skills: ['acrobatics'] },
    { key: 'class-1', name: 'Sneaky', skills: ['stealth'] }
  ];
  assert.deepEqual(overlappingTrainings(picks, ['acrobatics']), [
    { key: 'ancestry-1:acrobatics', slotKey: 'ancestry-1', featName: 'Bouncy Goblin', skill: 'acrobatics' }
  ]);
  assert.deepEqual(overlappingTrainings(picks, []), [], 'nothing trained yet');
});

test('two feats training the same skill: the second needs a replacement', () => {
  const picks = [
    { key: 'a', name: 'First', skills: ['stealth'] },
    { key: 'b', name: 'Second', skills: ['stealth'] }
  ];
  assert.deepEqual(overlappingTrainings(picks, []).map((o) => o.slotKey), ['b']);
});

test('replacements for overlaps that went away are dropped', () => {
  const overlaps = [{ key: 'a:acrobatics' }];
  assert.deepEqual(keepReplacements({ 'a:acrobatics': 'thievery', 'b:stealth': 'athletics' }, overlaps), {
    'a:acrobatics': 'thievery'
  });
  assert.deepEqual(keepReplacements(undefined, overlaps), {});
});
