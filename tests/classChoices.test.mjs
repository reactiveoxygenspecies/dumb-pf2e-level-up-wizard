// The builder's class choices: reading ChoiceSets, writing answers, handing them to granted items. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.game = { i18n: { localize: (k) => k, format: (k) => k, lang: 'en' }, settings: { get: () => null } };
globalThis.CONFIG = { PF2E: {} };
globalThis.foundry = { utils: { deepClone: (o) => structuredClone(o) } };

const {
  choiceKey,
  chosenGrants,
  chosenOption,
  hasSelections,
  isAnswerable,
  levelOneFeatures,
  selectionFlag,
  settleChoices,
  traditionFrom,
  withGrantedAnswers,
  writeSelections
} = await import('../src/data/classChoices.js');

const clone = (o) => JSON.parse(JSON.stringify(o));
const BLOODLINE_UUID = 'Compendium.pf2e.classfeatures.Item.bloodline';
const ABERRANT_UUID = 'Compendium.pf2e.classfeatures.Item.aberrant';
const GATE_UUID = 'Compendium.pf2e.classfeatures.Item.kinetic-gate';
const FIRE_GATE_UUID = 'Compendium.pf2e.classfeatures.Item.fire-gate';

// Rule shapes copied from PF2e 8.2.0 pack data
const bloodline = {
  name: 'Bloodline',
  system: {
    rules: [
      { adjustName: false, choices: { filter: ['item:tag:sorcerer-bloodline'] }, flag: 'bloodline', key: 'ChoiceSet' },
      { key: 'GrantItem', uuid: '{item|flags.system.rulesSelections.bloodline}' }
    ]
  }
};
const kineticGate = {
  name: 'Kinetic Gate',
  system: {
    rules: [
      { key: 'ActiveEffectLike', mode: 'override', path: 'flags.system.kineticist.elements', value: [] },
      { key: 'ActiveEffectLike', mode: 'override', path: 'flags.system.kineticist.gate', value: {} },
      {
        choices: [
          { label: 'Dual', value: 'dual-gate' },
          { label: 'Single', value: 'single-gate' }
        ],
        key: 'ChoiceSet',
        rollOption: 'kinetic-gate:initial'
      },
      { choices: { filter: ['item:tag:kineticist-kinetic-gate'] }, flag: 'elementOne', key: 'ChoiceSet' },
      { key: 'GrantItem', uuid: '{item|flags.system.rulesSelections.elementOne}' },
      {
        choices: { filter: ['item:tag:kineticist-kinetic-gate'] },
        flag: 'elementTwo',
        key: 'ChoiceSet',
        predicate: ['kinetic-gate:initial:dual-gate']
      },
      { key: 'GrantItem', uuid: '{item|flags.system.rulesSelections.elementTwo}' }
    ]
  }
};
const fireGate = {
  name: 'Fire Gate',
  system: {
    rules: [
      { choices: { filter: ['item:trait:impulse'] }, flag: 'impulseOne', key: 'ChoiceSet' },
      { key: 'GrantItem', uuid: '{item|flags.system.rulesSelections.impulseOne}' },
      { choices: { filter: ['item:trait:impulse'] }, flag: 'impulseTwo', key: 'ChoiceSet' },
      { key: 'GrantItem', uuid: '{item|flags.system.rulesSelections.impulseTwo}' }
    ]
  }
};

test('level-1 features come from the class feature list, in its order', () => {
  const sorcerer = {
    system: {
      items: {
        a: { uuid: BLOODLINE_UUID, level: 1, name: 'Bloodline' },
        b: { uuid: 'Compendium.pf2e.classfeatures.Item.signature', level: 3, name: 'Signature Spells' },
        c: { uuid: 'Compendium.pf2e.classfeatures.Item.spellcasting', level: 1, name: 'Sorcerer Spellcasting' }
      }
    }
  };
  assert.deepEqual(
    levelOneFeatures(sorcerer).map((f) => f.key),
    ['a', 'c']
  );
});

test('a GrantItem that points at a ChoiceSet names its flag', () => {
  assert.equal(selectionFlag('{item|flags.system.rulesSelections.bloodline}'), 'bloodline');
  assert.equal(selectionFlag('{item|flags.pf2e.rulesSelections.elementOne}'), 'elementOne');
  assert.equal(selectionFlag('Compendium.pf2e.feats-srd.Item.abc'), null);
});

test('an answer is written into its ChoiceSet and finds the item it grants', () => {
  const source = clone(bloodline);
  const choices = { [choiceKey(BLOODLINE_UUID, 0)]: ABERRANT_UUID };
  assert.equal(hasSelections(source), false);
  writeSelections(source, BLOODLINE_UUID, choices);
  assert.equal(source.system.rules[0].selection, ABERRANT_UUID);
  assert.equal(hasSelections(source), true);
  assert.deepEqual(chosenGrants(source, BLOODLINE_UUID, choices), [
    { ruleIndex: 1, choiceIndex: 0, uuid: ABERRANT_UUID }
  ]);
});

test('a choice that is not an item grants nothing', () => {
  const source = clone(kineticGate);
  const choices = { [choiceKey(GATE_UUID, 2)]: 'single-gate' };
  writeSelections(source, GATE_UUID, choices);
  assert.equal(source.system.rules[2].selection, 'single-gate');
  assert.deepEqual(chosenGrants(source, GATE_UUID, choices), []);
});

test("a granted item's answers sit on its compendium document only while creating", async () => {
  const compendium = { _source: clone(fireGate) };
  globalThis.fromUuid = async (uuid) => (uuid === FIRE_GATE_UUID ? compendium : null);
  const choices = {
    [choiceKey(FIRE_GATE_UUID, 0)]: 'Compendium.pf2e.feats-srd.Item.flying-flame',
    [choiceKey(FIRE_GATE_UUID, 2)]: 'Compendium.pf2e.feats-srd.Item.ignite'
  };
  const granted = [{ uuid: FIRE_GATE_UUID, source: writeSelections(clone(fireGate), FIRE_GATE_UUID, choices) }];
  let during = null;
  await withGrantedAnswers(granted, async () => {
    during = compendium._source.system.rules.map((r) => r.selection ?? null);
  });
  assert.deepEqual(during, ['Compendium.pf2e.feats-srd.Item.flying-flame', null, 'Compendium.pf2e.feats-srd.Item.ignite', null]);
  assert.deepEqual(compendium._source, fireGate, 'put back afterwards');

  await assert.rejects(withGrantedAnswers(granted, async () => {
    throw new Error('creation failed');
  }));
  assert.deepEqual(compendium._source, fireGate, 'put back when creating fails');
});

test('choices among the actor’s own items and deities are left to the system and the deity picker', () => {
  assert.equal(isAnswerable({ choices: { filter: ['item:tag:sorcerer-bloodline'] } }), true);
  assert.equal(isAnswerable({ choices: [{ value: 'heal' }, { value: 'harm' }] }), true);
  assert.equal(isAnswerable({ choices: 'skills' }), true);
  assert.equal(isAnswerable({ choices: { itemType: 'deity', filter: ['item:category:deity'] } }), false);
  assert.equal(isAnswerable({ choices: { ownedItems: true, types: ['weapon'] } }), false);
  assert.equal(isAnswerable({ choices: { attacks: true } }), false);
});

test('answers settle: stale ones go, a single option is taken', () => {
  const choices = { gone: 'x', bad: 'nope', obj: { slug: 'fire', damageType: 'fire' } };
  const groups = [
    { key: 'bad', options: [{ value: 'a' }, { value: 'b' }] },
    { key: 'only', options: [{ value: 'holy' }] },
    { key: 'optionalOnly', optional: true, options: [{ value: 'z' }] },
    { key: 'obj', options: [{ value: { damageType: 'fire', slug: 'fire' } }, { value: { slug: 'air' } }] }
  ];
  assert.equal(settleChoices(choices, groups), true);
  assert.deepEqual(Object.keys(choices).sort(), ['obj', 'only']);
  assert.equal(choices.only, 'holy');
  assert.equal(chosenOption(groups[3], choices), groups[3].options[0], 'objects compare by value');
  assert.equal(settleChoices(choices, groups), false, 'nothing left to change');
});

test('the spell tradition is read from the chosen subclass', () => {
  const patron = {
    system: {
      rules: [
        { key: 'ActiveEffectLike', mode: 'upgrade', path: 'system.skills.occultism.rank', value: 1 },
        { key: 'ActiveEffectLike', mode: 'override', path: 'system.proficiencies.aliases.witch', value: 'occult' }
      ]
    }
  };
  const aberrant = {
    system: {
      rules: [
        {
          key: 'ItemAlteration',
          predicate: [{ or: [{ and: ['item:spell-slot', 'spellcasting:tradition:occult'] }] }]
        }
      ]
    }
  };
  const eidolon = {
    system: { rules: [], description: { value: '<p><strong>Tradition</strong> primal</p>' } }
  };
  assert.equal(traditionFrom(patron, 'witch'), 'occult');
  assert.equal(traditionFrom(aberrant, 'sorcerer'), 'occult');
  assert.equal(traditionFrom(eidolon, 'summoner'), 'primal');
  assert.equal(traditionFrom({ system: { rules: [] } }, 'sorcerer'), null, 'draconic: depends on the dragon');
});
