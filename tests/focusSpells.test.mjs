// Which focus spells new feats and features give. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.game = { system: { id: 'pf2e' }, i18n: { localize: (k) => k, format: (k) => k, lang: 'en' }, settings: { get: () => null } };
globalThis.CONFIG = { PF2E: {} };

const { resolveGrant, setFocusData } = await import('../src/data/focusSpells.js');
const data = JSON.parse(readFileSync(new URL('../src/data/focusSpells.json', import.meta.url), 'utf8'));
setFocusData(data);

const item = (name, slug, rulesSelections = {}) => ({ name, slug, flags: { pf2e: { rulesSelections } } });
const actorWith = (items, deity = null) => ({ items, deity });

test('bard composition spells are fixed', () => {
  const grant = data.grants['composition-spells'];
  const out = resolveGrant(actorWith([]), item('Composition Spells', 'composition-spells'), grant);
  assert.equal(out.fixed.length, 2);
});

test('Domain Initiate follows the domain chosen in PF2e\'s prompt', () => {
  const grant = data.grants['domain-initiate'];
  const feat = item('Domain Initiate', 'domain-initiate', { domainInitiate: 'fire' });
  const out = resolveGrant(actorWith([feat]), feat, grant);
  assert.deepEqual(out.fixed, data.domains.fire.initial);
  assert.equal(resolveGrant(actorWith([]), item('Domain Initiate', 'domain-initiate'), grant), null, 'no choice yet');
});

test('a druid order spell comes from the order feature on the actor', () => {
  const grant = data.grants['druidic-order'];
  const order = item('Animal Order', 'animal-order');
  const out = resolveGrant(actorWith([order]), item('Druidic Order', 'druidic-order'), grant);
  assert.deepEqual(out.fixed, grant.choice.map['animal-order']);
});

test('devotion spells offer only what the deity\'s font allows', () => {
  const grant = data.grants['devotion-spells'];
  const healer = { system: { font: ['heal'] } };
  const out = resolveGrant(actorWith([], healer), item('Devotion Spells', 'devotion-spells'), grant);
  assert.equal(out.count, 1);
  for (const [uuid, condition] of Object.entries(grant.pick.conditions)) {
    assert.equal(out.options.includes(uuid), condition.endsWith(':heal'), condition);
  }
});

test('Advanced Domain offers the advanced spells of the domains already held', () => {
  const grant = data.grants['advanced-domain'];
  const initiate = item('Domain Initiate', 'domain-initiate', { domainInitiate: 'fire' });
  const out = resolveGrant(actorWith([initiate]), item('Advanced Domain', 'advanced-domain'), grant);
  assert.deepEqual(out.options, data.domains.fire.advanced);
});
