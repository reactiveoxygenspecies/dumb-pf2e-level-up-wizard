// Boost-row slot matching for the character builder. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.game = { i18n: { localize: (k) => k, format: (k) => k, lang: 'en' }, settings: { get: () => null } };
globalThis.CONFIG = { PF2E: {} };

const { assignSlots, canPick, openSlotCount } = await import('../src/data/builder.js');

const ALL = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
// Shapes copied from PF2e 8.2.0 pack data
const goblin = { 0: { value: ['cha'] }, 1: { value: ['dex'] }, 2: { value: ALL } };
const human = { 0: { value: ALL }, 1: { value: ALL } };
const scholar = { 0: { value: ['int', 'wis'] }, 1: { value: ALL } };
const slots = (boosts) => Object.entries(boosts).map(([key, b]) => ({ key, options: b.value }));

test('open slot counts', () => {
  assert.equal(openSlotCount(goblin), 1);
  assert.equal(openSlotCount(human), 2);
  assert.equal(openSlotCount(scholar), 2);
});

test('fixed ancestry boosts cannot be picked again', () => {
  assert.equal(canPick(goblin, [], 'dex'), false);
  assert.equal(canPick(goblin, [], 'int'), true);
  assert.equal(canPick(goblin, ['int'], 'str'), false, 'row is full');
});

test('background: the restricted slot takes Int or Wis, the free slot anything else', () => {
  // Picking Con first leaves Int/Wis for the restricted slot
  assert.equal(canPick(scholar, [], 'con'), true);
  assert.equal(canPick(scholar, ['con'], 'str'), false, 'second pick must be Int or Wis');
  assert.equal(canPick(scholar, ['con'], 'int'), true);
  assert.deepEqual(assignSlots(slots(scholar), ['con', 'int']), { 0: 'int', 1: 'con' });
  // Int and Wis together also work: one restricted, one free
  assert.deepEqual(assignSlots(slots(scholar), ['wis', 'int']), { 0: 'wis', 1: 'int' });
  assert.equal(assignSlots(slots(scholar), ['int', 'int']), null);
});

test('background skill choices are detected from ChoiceSet rules', async () => {
  const { backgroundSkillChoice } = await import('../src/data/builder.js');
  globalThis.CONFIG.PF2E.skills = Object.fromEntries(
    ['arcana', 'nature', 'occultism', 'religion', 'athletics'].map((s) => [s, { label: s }])
  );
  // Scholar, PF2e 8.2.0
  const scholar = {
    system: {
      rules: [
        {
          key: 'ChoiceSet',
          flag: 'skill',
          choices: ['arcana', 'nature', 'occultism', 'religion'].map((value) => ({ value }))
        },
        { key: 'ActiveEffectLike', mode: 'upgrade', path: 'system.skills.{item|flags.system.rulesSelections.skill}.rank', value: 1 },
        { key: 'GrantItem', uuid: 'Compendium.pf2e.feats-srd.Item.Assurance' }
      ]
    }
  };
  assert.deepEqual(backgroundSkillChoice(scholar), {
    index: 0,
    options: ['arcana', 'nature', 'occultism', 'religion']
  });
  // A ChoiceSet over something other than skills is left to the system's prompt
  const other = { system: { rules: [{ key: 'ChoiceSet', choices: [{ value: 'fire' }] }] } };
  assert.equal(backgroundSkillChoice(other), null);
  assert.equal(backgroundSkillChoice(null), null);
});

test('partial rows assign what they can', () => {
  assert.deepEqual(assignSlots(slots(human), ['str']), { 0: 'str' });
  assert.deepEqual(assignSlots(slots(human), []), {});
});
