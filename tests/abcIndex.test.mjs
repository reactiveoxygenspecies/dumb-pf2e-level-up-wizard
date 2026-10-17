// Which compendium entries the character builder offers. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.game = { i18n: { localize: (k) => k, format: (k) => k, lang: 'en' }, settings: { get: () => null } };

const { isCompanionOption } = await import('../src/data/abcIndex.js');

const ancestry = (traits) => ({ type: 'ancestry', system: { traits: { value: traits } } });

test('companion ancestries and classes are left out of the builder', () => {
  // PF2e Animal Companions: everything it ships is for companions, whatever its traits
  assert.equal(isCompanionOption(ancestry(['undead']), 'pf2e-animal-companions'), true);
  assert.equal(isCompanionOption({ type: 'class', system: {} }, 'pf2e-animal-companions'), true);
  // Companion traits from any source
  assert.equal(isCompanionOption(ancestry(['animal']), 'some-module'), true);
  assert.equal(isCompanionOption(ancestry(['eidolon', 'angel']), 'some-module'), true);
  assert.equal(isCompanionOption(ancestry(['construct', 'minion']), 'some-module'), true);
});

test('playable ancestries stay, including awakened animals and undead', () => {
  assert.equal(isCompanionOption(ancestry(['humanoid', 'elf']), 'pf2e'), false);
  assert.equal(isCompanionOption(ancestry(['awakened-animal', 'beast']), 'pf2e'), false);
  assert.equal(isCompanionOption(ancestry(['skeleton', 'undead']), 'pf2e'), false);
  // Only ancestries are checked by trait
  assert.equal(isCompanionOption({ type: 'class', system: { traits: { value: ['animal'] } } }, 'pf2e'), false);
});
