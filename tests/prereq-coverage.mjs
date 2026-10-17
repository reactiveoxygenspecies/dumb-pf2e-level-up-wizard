// Usage: node tests/prereq-coverage.mjs <path-to-pf2e-checkout> [--no-known] [--unmet] [--sample=N]
// (or set PF2E_SOURCE instead of passing the path)
// Walks every feat JSON in a PF2e checkout and reports how the prerequisite
// parser classifies each prerequisite line for a sample mid-level character.
import fs from 'node:fs';
import path from 'node:path';
import { evaluatePrerequisites } from '../src/helpers/prerequisites.js';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const root = args.find((a) => !a.startsWith('--')) ?? process.env.PF2E_SOURCE;
if (!root) {
  console.error('Usage: node tests/prereq-coverage.mjs <path-to-pf2e-checkout> (or set PF2E_SOURCE)');
  process.exit(1);
}
const packs = path.join(root, 'packs/pf2e');

const readJsonTree = (dir) => {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.json') && !entry.name.startsWith('_')) {
        try {
          out.push(JSON.parse(fs.readFileSync(p, 'utf8')));
        } catch {
          // ignore unreadable files
        }
      }
    }
  };
  walk(dir);
  return out;
};

const feats = readJsonTree(path.join(packs, 'feats'));
const knownNames = [];
for (const dir of [
  'feats',
  'class-features',
  'ancestry-features',
  'ancestries',
  'heritages'
]) {
  for (const doc of dir === 'feats' ? feats : readJsonTree(path.join(packs, dir))) {
    if (doc.name) knownNames.push(doc.name);
    if (doc.system?.slug) knownNames.push(doc.system.slug);
  }
}

// A level 10 human fighter with a typical spread.
const ctx = {
  level: 10,
  lang: 'en',
  skills: {
    acrobatics: 1,
    arcana: 0,
    athletics: 3,
    crafting: 1,
    deception: 0,
    diplomacy: 1,
    intimidation: 2,
    medicine: 1,
    nature: 0,
    occultism: 0,
    performance: 0,
    religion: 0,
    society: 1,
    stealth: 1,
    survival: 1,
    thievery: 0
  },
  lores: { 'warfare lore': 1 },
  attributes: { str: 4, dex: 2, con: 2, int: 0, wis: 1, cha: 0 },
  perception: 2,
  saves: { fortitude: 2, reflex: 2, will: 1 },
  classDC: 2,
  spellRank: 0,
  attacks: { simple: 2, martial: 2, advanced: 1, unarmed: 2 },
  defenses: { unarmored: 1, light: 1, medium: 1, heavy: 1 },
  spellcasting: {
    canCast: false,
    slotted: false,
    focusPool: false,
    traditions: [],
    slottedTraditions: [],
    maxSpellRank: 0,
    spells: []
  },
  feats: ['power attack', 'power-attack', 'toughness', 'shield block', 'sudden charge'],
  classSlug: 'fighter',
  ancestrySlug: 'human',
  heritageSlug: 'versatile-human',
  versatileHeritage: false,
  countsAs: ['human'],
  traits: ['human', 'humanoid'],
  deity: null,
  languages: ['common'],
  size: 'med',
  senses: [],
  speeds: { land: 25 },
  classHp: 10,
  hasFamiliar: false
};
if (!flags.includes('--no-known')) ctx.knownNames = knownNames;

const counts = { met: 0, unmet: 0, unknown: 0 };
const featCounts = { met: 0, unmet: 0, unknown: 0 };
const unknownLines = new Map();
const byLine = new Map();
let lines = 0;
let lineOccurrences = 0;
for (const feat of feats) {
  const prereqs = feat.system?.prerequisites;
  const res = evaluatePrerequisites(prereqs, ctx);
  featCounts[res.status]++;
  for (const r of res.results) {
    lineOccurrences++;
    byLine.set(r.text, r.status);
    if (r.status === 'unknown') {
      unknownLines.set(r.text, (unknownLines.get(r.text) ?? 0) + 1);
    }
  }
}
for (const status of byLine.values()) {
  counts[status]++;
  lines++;
}
const occ = { met: 0, unmet: 0, unknown: 0 };
for (const feat of feats) {
  for (const r of evaluatePrerequisites(feat.system?.prerequisites, ctx).results) {
    occ[r.status]++;
  }
}

const pct = (n, d) => ((100 * n) / d).toFixed(1) + '%';
console.log(`feats: ${feats.length}, known names: ${knownNames.length}`);
console.log(
  `distinct lines: ${lines}  met ${counts.met}  unmet ${counts.unmet}  unknown ${counts.unknown} (${pct(counts.unknown, lines)} unknown)`
);
console.log(
  `line occurrences: ${lineOccurrences}  met ${occ.met}  unmet ${occ.unmet}  unknown ${occ.unknown} (${pct(occ.unknown, lineOccurrences)} unknown)`
);
console.log(
  `per feat overall: met ${featCounts.met}  unmet ${featCounts.unmet}  unknown ${featCounts.unknown} (${pct(featCounts.unknown, feats.length)} unknown)`
);
const top = [...unknownLines].sort((a, b) => b[1] - a[1]);
console.log('\nTop 40 unknown lines:');
for (const [text, n] of top.slice(0, 40)) console.log(`${String(n).padStart(4)}  ${text}`);

const sample = flags.find((f) => f.startsWith('--sample='));
if (sample) {
  const n = Number(sample.split('=')[1]);
  console.log(`\nUnknown lines ${n} onward:`);
  for (const [text, c] of top.slice(40, 40 + n)) console.log(`${String(c).padStart(4)}  ${text}`);
}
if (flags.includes('--unmet')) {
  console.log('\nUnmet lines (distinct):');
  for (const [text, status] of byLine) if (status === 'unmet') console.log('  ' + text);
}
