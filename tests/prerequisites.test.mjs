// Run with: node tests/prerequisites.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPendingChoices,
  buildPrereqContext,
  cleanPrerequisiteText,
  evaluatePrerequisites,
  traitRequirements
} from '../src/helpers/prerequisites.js';

const baseCtx = () => ({
  level: 8,
  lang: 'en',
  skills: {
    acrobatics: 0,
    arcana: 1,
    athletics: 2,
    crafting: 0,
    deception: 0,
    diplomacy: 0,
    intimidation: 0,
    medicine: 3,
    nature: 0,
    occultism: 1,
    performance: 0,
    religion: 0,
    society: 0,
    stealth: 0,
    survival: 0,
    thievery: 0
  },
  skillLabels: {},
  lores: { 'warfare lore': 2, 'cooking lore': 1 },
  attributes: { str: 3, dex: 1, con: 2, int: 0, wis: 2, cha: -1 },
  perception: 2,
  saves: { fortitude: 2, reflex: 1, will: 3 },
  classDC: 2,
  spellRank: 1,
  attacks: { simple: 2, martial: 2, advanced: 0, unarmed: 1, firearm: 1 },
  defenses: { unarmored: 1, light: 2, medium: 1, heavy: 0 },
  spellcasting: {
    canCast: false,
    slotted: false,
    focusPool: false,
    traditions: [],
    slottedTraditions: [],
    maxSpellRank: 0,
    spells: []
  },
  feats: [
    'battle medicine',
    'battle-medicine',
    'assurance (athletics)',
    'assurance',
    'natural medicine',
    'fighter dedication',
    'fighter-dedication',
    'rage'
  ],
  classSlug: 'fighter',
  ancestrySlug: 'elf',
  heritageSlug: 'woodland-elf',
  versatileHeritage: false,
  countsAs: ['elf'],
  traits: ['elf', 'humanoid'],
  deity: null,
  languages: ['common', 'elven'],
  size: 'med',
  senses: ['low-light vision'],
  speeds: { land: 30 },
  classHp: 10,
  hasFamiliar: false
});

const ctxWith = (patch) => ({ ...baseCtx(), ...patch });
const one = (text, ctx = baseCtx()) =>
  evaluatePrerequisites([{ value: text }], ctx).status;

const expectStatuses = (cases, ctx) => {
  for (const [text, expected] of cases) {
    assert.equal(one(text, ctx), expected, `"${text}" should be ${expected}`);
  }
};

test('empty prerequisites are met', () => {
  assert.equal(evaluatePrerequisites([], baseCtx()).status, 'met');
  assert.equal(evaluatePrerequisites({ value: [] }, baseCtx()).status, 'met');
  assert.equal(evaluatePrerequisites(undefined, baseCtx()).status, 'met');
});

test('accepts the system object, the value array, or plain strings', () => {
  const ctx = baseCtx();
  const asObject = evaluatePrerequisites(
    { value: [{ value: 'trained in Athletics' }] },
    ctx
  );
  const asArray = evaluatePrerequisites([{ value: 'trained in Athletics' }], ctx);
  const asStrings = evaluatePrerequisites(['trained in Athletics'], ctx);
  assert.deepEqual(asObject, asArray);
  assert.deepEqual(asArray, asStrings);
  assert.equal(asObject.results[0].text, 'trained in Athletics');
});

test('overall status: unmet beats unknown beats met', () => {
  const ctx = baseCtx();
  const result = evaluatePrerequisites(
    ['trained in Athletics', 'master in Crafting', 'Some Totally Unknown Thing'],
    ctx
  );
  assert.equal(result.status, 'unmet');
  assert.deepEqual(
    result.results.map((r) => r.status),
    ['met', 'unmet', 'unknown']
  );
  assert.equal(
    evaluatePrerequisites(['trained in Athletics', 'weird thing'], ctx).status,
    'unknown'
  );
  assert.equal(evaluatePrerequisites(['trained in Athletics'], ctx).status, 'met');
});

test('skill proficiency ranks', () => {
  expectStatuses([
    ['trained in Athletics', 'met'],
    ['expert in Athletics', 'met'],
    ['master in Athletics', 'unmet'],
    ['trained in Crafting', 'unmet'],
    ['expert in Medicine', 'met'],
    ['master in Medicine', 'met'],
    ['legendary in Medicine', 'unmet'],
    ['legendary Stealth', 'unmet'],
    ['Expert in Athletics', 'met'],
    ['trained in athletics.', 'met'],
    ['trained in Athletics;', 'met'],
    ['master at Medicine', 'met']
  ]);
});

test('any-of and all-of skill lists', () => {
  expectStatuses([
    ['trained in Arcana, Nature, Occultism, or Religion', 'met'],
    ['expert in Arcana, Nature, Occultism, or Religion', 'unmet'],
    ['expert in Deception or Diplomacy', 'unmet'],
    ['expert in Athletics or Diplomacy', 'met'],
    ['trained in Athletics and Medicine', 'met'],
    ['trained in Athletics and Crafting', 'unmet'],
    ['trained in Occultism or Religion', 'met'],
    ['master in either Medicine or Crafting', 'met']
  ]);
});

test('lore skills', () => {
  expectStatuses([
    ['trained in Warfare Lore', 'met'],
    ['expert in Warfare Lore', 'met'],
    ['master in Warfare Lore', 'unmet'],
    ['trained in Underworld Lore', 'unmet'],
    ['expert in a Lore skill', 'met'],
    ['master in a Lore skill', 'unmet'],
    ['trained in at least one Lore skill', 'met'],
    ['expert in Religion or Warfare Lore', 'met'],
    ['trained in Lore about a specific terrain', 'unknown']
  ]);
  // A translated character cannot be proven to lack an English-named lore
  assert.equal(
    one('trained in Underworld Lore', ctxWith({ lang: 'de' })),
    'unknown'
  );
});

test('skill counts and recall knowledge skills', () => {
  expectStatuses([
    ['trained in at least seven skills', 'unmet'],
    ['trained in at least two skills', 'met'],
    ['trained in a skill with the Recall Knowledge action', 'met'],
    ['master in a Recall Knowledge skill', 'met'],
    ['legendary in a Recall Knowledge skill', 'unknown']
  ]);
});

test('translated skill names match through skillLabels', () => {
  const ctx = ctxWith({ skillLabels: { athletics: 'Athletik', medicine: 'Medizin' } });
  expectStatuses(
    [
      ['trained in Athletik', 'met'],
      ['master in Medizin', 'met'],
      ['master in Athletik', 'unmet']
    ],
    ctx
  );
});

test('attributes: modifiers and old-style scores', () => {
  expectStatuses([
    ['Strength +2', 'met'],
    ['Strength +3', 'met'],
    ['Strength +4', 'unmet'],
    ['Dexterity +3', 'unmet'],
    ['Charisma +0', 'unmet'],
    ['Intelligence +2 or Wisdom +2', 'met'],
    ['Intelligence +2 or Charisma +2', 'unmet'],
    ['Strength 14', 'met'],
    ['Strength 18', 'unmet'],
    ['Wisdom 14', 'met'],
    ['Dexterity 14', 'unmet']
  ]);
});

test('perception, saves, class DC, spell DCs', () => {
  expectStatuses([
    ['expert in Perception', 'met'],
    ['master in Perception', 'unmet'],
    ['expert in Fortitude saves', 'met'],
    ['master in Will saves', 'met'],
    ['master in Reflex saves', 'unmet'],
    ['master in Fortitude or Will saves', 'met'],
    ['expert in at least one saving throw', 'met'],
    ['expert in class DC', 'met'],
    ['master in class DC', 'unmet'],
    ['trained in spell DCs', 'met'],
    ['expert in spell DCs', 'unmet']
  ]);
});

test('weapon and armor proficiency', () => {
  expectStatuses([
    ['trained in martial weapons', 'met'],
    ['expert in martial weapons', 'met'],
    ['trained in all martial weapons', 'met'],
    ['trained in advanced weapons', 'unmet'],
    ['expert in unarmed attacks', 'unmet'],
    ['trained in light armor', 'met'],
    ['expert in light armor', 'met'],
    ['trained in heavy armor', 'unmet'],
    ['expert in medium or heavy armor', 'unmet'],
    ['trained in light, medium, or heavy armor', 'met'],
    ['trained in medium armor and martial weapons', 'met'],
    ['master in any kind of weapon or unarmed attack', 'unknown']
  ]);
});

test('feat names, case-insensitively, by name and slug', () => {
  expectStatuses([
    ['Battle Medicine', 'met'],
    ['battle medicine', 'met'],
    ['Natural Medicine', 'met'],
    ['Fighter Dedication', 'met'],
    ['Rage', 'met'],
    ['Cat Fall', 'unknown'],
    ['Wizard Dedication', 'unmet'],
    ['Fighter Dedication or Wizard Dedication', 'met'],
    ['Wizard Dedication or Druid Dedication', 'unmet'],
    ['Cat Fall or Battle Medicine', 'met'],
    ['Cat Fall or Mystery Feat', 'unknown'],
    ['Battle Medicine.', 'met']
  ]);
});

test('Babele original names match translated items', () => {
  const ctx = ctxWith({ feats: ['medizinische kampfhilfe', 'battle medicine'] });
  assert.equal(one('Battle Medicine', ctx), 'met');
});

test('feats with a skill variant', () => {
  expectStatuses([
    ['Assurance in Athletics', 'met'],
    ['Assurance', 'met'],
    ['Assurance in Athletics or Cat Fall', 'met'],
    ['Assurance (Athletics)', 'met'],
    // owning another variant is not conclusive
    ['Assurance in Crafting', 'unknown']
  ]);
});

test('known names turn missing bare names into unmet', () => {
  const ctx = ctxWith({ knownNames: ['Cat Fall', 'Spellstrike', 'Battle Medicine'] });
  expectStatuses(
    [
      ['Cat Fall', 'unmet'],
      ['Spellstrike', 'unmet'],
      ['Battle Medicine', 'met'],
      ['Cat Fall or Spellstrike', 'unmet'],
      ['Cat Fall or Battle Medicine', 'met'],
      ['Totally Unlisted Thing', 'unknown']
    ],
    ctx
  );
});

test('dedications', () => {
  expectStatuses([
    ['any dedication feat', 'met'],
    ['a dedication feat', 'met'],
    ['Rogue Dedication', 'unmet']
  ]);
  const none = ctxWith({ feats: ['battle medicine'] });
  expectStatuses([['any dedication feat', 'unmet']], none);
});

test('suffix inheritance across dedication lists', () => {
  expectStatuses([
    ['Fighter, Wizard, or Rogue Dedication', 'met'],
    ['Wizard, Druid, or Rogue Dedication', 'unmet']
  ]);
});

test('archetype feat counts are never guessed', () => {
  expectStatuses([
    ['two other feats from the Fighter archetype', 'unknown'],
    ['at least two other class feats from the Oozemorph archetype', 'unknown']
  ]);
});

test('deity: Godless Healing (upstream #95)', () => {
  const godless = evaluatePrerequisites(
    [{ value: 'Battle Medicine' }, { value: "can't have a patron deity" }],
    baseCtx()
  );
  assert.equal(godless.status, 'met');
  assert.deepEqual(
    godless.results.map((r) => r.status),
    ['met', 'met']
  );

  const devout = ctxWith({ deity: { name: 'Sarenrae', slug: 'sarenrae' } });
  assert.equal(
    evaluatePrerequisites(
      [{ value: 'Battle Medicine' }, { value: "can't have a patron deity" }],
      devout
    ).status,
    'unmet'
  );
  // curly apostrophe, trailing period, and the other phrasings
  expectStatuses([
    ['can’t have a patron deity.', 'met'],
    ["you don't have a deity", 'met'],
    ["you don't follow a deity", 'met']
  ]);
  expectStatuses(
    [
      ["can't have a patron deity", 'unmet'],
      ["you don't have a deity", 'unmet']
    ],
    devout
  );
});

test('deity: followers', () => {
  const devout = ctxWith({ deity: { name: 'Sarenrae', slug: 'sarenrae' } });
  expectStatuses([
    ['you follow a deity', 'unmet'],
    ['you worship a good-aligned deity', 'unmet'],
    ['worshipper of Sarenrae', 'unmet'],
    ['follower of a specific religion', 'unmet']
  ]);
  expectStatuses(
    [
      ['you follow a deity', 'met'],
      ['you follow a good-aligned deity', 'unknown'],
      ['worshipper of Sarenrae', 'met'],
      ['worshipper of Torag or Sarenrae', 'met'],
      ['worshipper of Torag or Angradd', 'unmet'],
      ['you worship Sarenrae', 'met'],
      ['deity is Achaekek', 'unmet'],
      ['you follow a good-aligned deity or patron', 'unknown'],
      ['trained in martial weapons and either Athletics or Crafting', 'unknown'],
      ['not a worshipper of Walkena', 'met']
    ],
    devout
  );
});

test('spellcasting', () => {
  const caster = ctxWith({
    spellcasting: {
      canCast: true,
      slotted: true,
      focusPool: true,
      traditions: ['divine', 'arcane'],
      slottedTraditions: ['divine'],
      maxSpellRank: 3,
      spells: ['fireball', 'shield', 'detect-magic', 'detect magic']
    }
  });
  expectStatuses([
    ['ability to cast spells', 'unmet'],
    ['able to cast spells', 'unmet'],
    ['ability to cast spells from spell slots', 'unmet'],
    ['You have a spellcasting class feature.', 'unmet'],
    ['focus pool', 'unmet'],
    ['ability to cast divine spells', 'unmet'],
    ['can cast 3rd rank spells', 'unmet'],
    ['ability to cast fireball', 'unknown']
  ]);
  expectStatuses(
    [
      ['ability to cast spells', 'met'],
      ['able to cast spells', 'met'],
      ['ability to cast spells from spell slots', 'met'],
      ['You have a spellcasting class feature.', 'met'],
      ['spellcasting class feature', 'met'],
      ['You have a spellcasting class feature with the divine or primal tradition', 'met'],
      ['You have a spellcasting class feature with the arcane or primal tradition', 'unmet'],
      ['focus pool', 'met'],
      ['ability to cast focus spells', 'met'],
      ['ability to cast divine spells', 'met'],
      ['ability to cast arcane or occult spells', 'met'],
      ['ability to cast primal spells', 'unmet'],
      ['divine spells', 'met'],
      ['can cast 3rd rank spells', 'met'],
      ['can cast 4th rank spells', 'unmet'],
      ['ability to cast fireball', 'met'],
      ['ability to cast the detect magic cantrip', 'met'],
      ['ability to cast shield and mage hand', 'unknown']
    ],
    caster
  );
});

test('ancestry, heritage, traits, size', () => {
  expectStatuses([
    ['woodland elf heritage', 'met'],
    ['Woodland Elf Heritage', 'met'],
    ['cavern elf heritage', 'unmet'],
    ['cavern elf heritage or woodland elf heritage', 'met'],
    ['cavern elf or woodland elf heritage', 'met'],
    ['cavern elf or arctic elf heritage', 'unmet'],
    ['elf', 'met'],
    ['half-elf', 'unknown'],
    ['elf trait', 'met'],
    ['humanoid trait, plant trait', 'unknown'],
    ['plant trait, or wood trait', 'unmet'],
    ['Medium size', 'met'],
    ['Medium or Small size', 'met'],
    ['Tiny size', 'unmet'],
    ['You have a versatile heritage', 'unmet']
  ]);
  assert.equal(
    one('You have a versatile heritage.', ctxWith({ versatileHeritage: true })),
    'met'
  );
  expectStatuses(
    [
      ['half-elf', 'unmet'],
      ['human', 'unmet'],
      ['elf', 'met']
    ],
    ctxWith({ knownNames: ['Half-Elf', 'Human', 'Elf'] })
  );
});

test('misc: level, hit points, languages, senses, speeds', () => {
  expectStatuses([
    ['class granting no more Hit Points per level than 10 + your Constitution modifier', 'met'],
    ['class granting no more Hit Points per level than 8 + your Constitution modifier', 'unmet'],
    ['low-light vision', 'met'],
    ['darkvision', 'unknown'],
    ['You speak Elven', 'met'],
    ['You speak Muan', 'unknown'],
    ['You speak at least three languages', 'unmet'],
    ['You speak at least two languages', 'met'],
    ['You have a swim Speed', 'unmet'],
    ["You don't have a swim Speed.", 'met'],
    ['fly Speed of at least 20 feet', 'unmet'],
    ['a familiar', 'unknown']
  ]);
});

test('HTML and @UUID links are stripped to their label', () => {
  assert.equal(
    cleanPrerequisiteText('<p>trained in <strong>Athletics</strong>.</p>'),
    'trained in Athletics'
  );
  assert.equal(
    cleanPrerequisiteText('@UUID[Compendium.pf2e.feats-srd.Item.Abc]{Battle Medicine}'),
    'Battle Medicine'
  );
  expectStatuses([
    ['@UUID[Compendium.pf2e.feats-srd.Item.Abc]{Battle Medicine}', 'met'],
    ['<p>expert in Athletics&nbsp;</p>', 'met'],
    ['trained in&nbsp;Athletics;', 'met']
  ]);
});

test('conservative defaults: nothing uninterpretable is unmet', () => {
  expectStatuses([
    ['member of the Pathfinder Society', 'unknown'],
    ['you have been in a psychic duel', 'unknown'],
    ['holy', 'unknown'],
    ['master in Arcana or Religion, depending on your chosen tradition', 'unknown'],
    ['trained in Diplomacy as well as either Arcana, Nature Occultism, or Religion', 'unknown'],
    ['Celebrity Dedication or Dandy Dedication, trained in Deception', 'unknown']
  ]);
});

test('applyPendingChoices returns a new ctx and leaves the original alone', () => {
  const ctx = baseCtx();
  const next = applyPendingChoices(ctx, {
    skillIncrease: 'crafting',
    feats: ['Cat Fall'],
    attributeBoosts: ['int', 'Strength']
  });
  assert.notEqual(next, ctx);
  assert.equal(ctx.skills.crafting, 0);
  assert.equal(next.skills.crafting, 1);
  assert.equal(ctx.attributes.int, 0);
  assert.equal(next.attributes.int, 1);
  assert.equal(next.attributes.str, 4);
  assert.equal(one('trained in Crafting', ctx), 'unmet');
  assert.equal(one('trained in Crafting', next), 'met');
  assert.equal(one('Cat Fall', next), 'met');
  assert.equal(one('Cat Fall', ctx), 'unknown');
  assert.equal(one('Intelligence +1', next), 'met');
});

test('applyPendingChoices caps ranks and handles lores', () => {
  const ctx = ctxWith({ skills: { ...baseCtx().skills, medicine: 4 } });
  assert.equal(applyPendingChoices(ctx, { skillIncrease: 'medicine' }).skills.medicine, 4);
  const lore = applyPendingChoices(baseCtx(), { skillIncrease: 'warfare lore' });
  assert.equal(lore.lores['warfare lore'], 3);
});

test('buildPrereqContext reads a mocked PF2e character', () => {
  const lore = (name, value) => ({
    name,
    system: { proficient: { value } },
    flags: {}
  });
  const feat = (name, slug, original) => ({
    type: 'feat',
    name,
    slug,
    system: { slug },
    flags: original ? { babele: { originalName: original } } : {}
  });
  const actor = {
    level: 5,
    system: {
      abilities: { str: { mod: 3 }, dex: { mod: 1 }, con: { mod: 2 }, int: { mod: 0 }, wis: { mod: 1 }, cha: { mod: 0 } },
      skills: { athletics: { rank: 2 } },
      proficiencies: {
        attacks: { simple: { rank: 2 }, martial: { rank: 1 } },
        defenses: { light: { rank: 1 } },
        classDCs: { fighter: { rank: 1 } },
        spellcasting: { rank: 0 }
      },
      details: { ancestry: { countsAs: ['human'] }, languages: { value: ['common'] } },
      perception: { rank: 2, senses: [{ type: 'low-light-vision' }] },
      resources: { focus: { max: 0 } },
      movement: { speeds: { land: { value: 25 }, swim: { value: 10 } } },
      traits: { size: { value: 'med' } }
    },
    skills: {
      athletics: { rank: 2 },
      'warfare-lore': { rank: 1, lore: true, label: 'Warfare Lore' }
    },
    saves: { fortitude: { rank: 2 }, reflex: { rank: 1 }, will: { rank: 1 } },
    perception: { rank: 2 },
    itemTypes: {
      lore: [lore('Warfare Lore', 1)],
      spell: [],
      spellcastingEntry: []
    },
    spellcasting: [],
    items: [
      feat('Battle Medicine', 'battle-medicine'),
      feat('Medizinische Kampfhilfe', 'battle-medicine', 'Battle Medicine'),
      feat('Assurance (Athletics)', 'assurance'),
      {
        type: 'feat',
        name: 'Sleep of the Reborn',
        slug: 'sleep-of-the-reborn',
        system: { slug: 'sleep-of-the-reborn', traits: { value: ['reincarnated'] } },
        flags: {}
      }
    ],
    class: { slug: 'fighter', hpPerLevel: 10 },
    ancestry: { slug: 'human' },
    heritage: { slug: 'versatile-heritage', system: { ancestry: null } },
    traits: new Set(['human', 'humanoid']),
    deity: null,
    size: 'med',
    familiar: null
  };
  const saved = { CONFIG: globalThis.CONFIG, game: globalThis.game };
  globalThis.CONFIG = {
    PF2E: { skills: { athletics: { label: 'PF2E.Skill.Athletics' }, medicine: { label: 'PF2E.Skill.Medicine' } } }
  };
  globalThis.game = { i18n: { lang: 'en', localize: (k) => k.split('.').pop() } };
  try {
    const ctx = buildPrereqContext(actor);
    assert.equal(ctx.level, 5);
    assert.equal(ctx.skills.athletics, 2);
    assert.equal(ctx.skills.medicine, 0);
    assert.equal(ctx.skillLabels.athletics, 'Athletics');
    assert.equal(ctx.lores['warfare lore'], 1);
    assert.equal(ctx.attributes.str, 3);
    assert.equal(ctx.saves.fortitude, 2);
    assert.equal(ctx.classDC, 1);
    assert.equal(ctx.attacks.martial, 1);
    assert.equal(ctx.defenses.light, 1);
    assert.equal(ctx.deity, null);
    assert.equal(ctx.versatileHeritage, true);
    assert.equal(ctx.speeds.swim, 10);
    assert.deepEqual(ctx.senses, ['low-light-vision']);
    assert.ok(ctx.feats.includes('battle medicine'));
    assert.ok(ctx.feats.includes('assurance'));
    assert.deepEqual(ctx.traits, ['human', 'humanoid']);
    assert.deepEqual(ctx.featTraits, ['reincarnated']);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(ctx)));
    assert.equal(one('Battle Medicine', ctx), 'met');
    assert.equal(one('trained in Warfare Lore', ctx), 'met');
    assert.equal(one("can't have a patron deity", ctx), 'met');
    assert.equal(one('master in Athletics', ctx), 'unmet');
    // an actor missing most fields must not throw
    assert.doesNotThrow(() => buildPrereqContext({}));
    assert.doesNotThrow(() => buildPrereqContext(null));
  } finally {
    globalThis.CONFIG = saved.CONFIG;
    globalThis.game = saved.game;
  }
});

test('reincarnated feats need a character who has reincarnated', () => {
  const ctx = { traits: ['human', 'humanoid'], featTraits: ['human'] };
  assert.deepEqual(traitRequirements(['human'], ctx), []);
  assert.deepEqual(traitRequirements(['reincarnated'], ctx), [
    { trait: 'reincarnated', status: 'unknown' }
  ]);
  // an earlier reincarnated feat, or the trait on the actor, shows they have
  assert.equal(
    traitRequirements(['reincarnated'], { ...ctx, featTraits: ['reincarnated'] })[0].status,
    'met'
  );
  assert.equal(traitRequirements(['reincarnated'], { traits: ['reincarnated'] })[0].status, 'met');
  assert.equal(traitRequirements(['reincarnated'], {})[0].status, 'unknown');
});
