// Builds src/data/grantedArchetypeFeats.json from the PF2e system source.
//
// Usage: node scripts/build-archetype-feats.mjs <path to pf2e checkout>
//
// The checkout needs packs/pf2e/feats and packs/pf2e/journals/archetypes.json.
// Archetype journal pages list "Additional Feats": feats from other sources that
// the archetype grants at a given level, even though they lack the archetype trait.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2];
if (!root) {
  console.error('Usage: node scripts/build-archetype-feats.mjs <path to pf2e checkout>');
  process.exit(1);
}

const featsDir = path.join(root, 'packs', 'pf2e', 'feats');
const journalPath = path.join(root, 'packs', 'pf2e', 'journals', 'archetypes.json');
const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'grantedArchetypeFeats.json');
const FEAT_PREFIX = 'Compendium.pf2e.feats-srd.Item.';

function sluggify(text) {
  return text
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function decode(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.json') && !entry.name.startsWith('_')) yield full;
  }
}

// Index every feat by id, exact name and normalized name
const byId = new Map();
const byName = new Map();
const byNormalized = new Map();
const bySlug = new Map();

function addTo(map, key, feat) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(feat);
}

for (const file of walk(featsDir)) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.type !== 'feat') continue;
  const feat = {
    id: data._id,
    name: data.name,
    slug: data.system.slug || sluggify(data.name),
    level: data.system.level?.value ?? 1,
    traits: data.system.traits?.value ?? []
  };
  byId.set(feat.id, feat);
  addTo(byName, feat.name, feat);
  addTo(byNormalized, normalize(feat.name), feat);
  bySlug.set(feat.slug, feat);
}

function resolveFeat(ref) {
  const key = decode(ref.slice(FEAT_PREFIX.length)).trim();
  if (byId.has(key)) return { feat: byId.get(key) };
  for (const candidates of [byName.get(key), byNormalized.get(normalize(key))]) {
    if (!candidates) continue;
    if (candidates.length === 1) return { feat: candidates[0] };
    return { error: `ambiguous name "${key}" (${candidates.map(c => c.id).join(', ')})` };
  }
  return { error: `no feat found for "${key}"` };
}

const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
const result = {};
const unresolved = [];
const notes = [];

for (const page of journal.pages) {
  const html = page.text?.content ?? '';
  const paragraph = html.match(/<p>(?:(?!<\/p>)[\s\S])*?Additional Feats(?:(?!<\/p>)[\s\S])*?<\/p>/);
  if (!paragraph) continue;

  const baseName = page.name.replace(/\s*\(.*?\)\s*$/, '').trim();
  const dedicationName = `${baseName} Dedication`;
  const dedications = (byName.get(dedicationName) ?? []).filter(f => f.traits.includes('dedication'));
  let dedication = dedications[0];
  if (dedications.length > 1) notes.push(`${page.name}: several dedication feats named "${dedicationName}", used ${dedication.slug}`);
  if (!dedication) {
    // fall back to the first dedication feat linked from the page itself
    for (const link of html.matchAll(/@UUID\[(Compendium\.pf2e\.feats-srd\.Item\.[^\]]+)\]/g)) {
      const found = resolveFeat(link[1]).feat;
      if (found?.traits.includes('dedication')) {
        dedication = found;
        break;
      }
    }
  }
  if (!dedication) {
    unresolved.push(`${page.name}: has an Additional Feats paragraph but no dedication feat could be found`);
    continue;
  }

  // Strip tags and label overrides, then walk level markers and feat links in order
  const text = decode(paragraph[0].replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, ''));
  const entries = [];
  const seen = new Set();
  let level = null;
  for (const token of text.matchAll(/(\d+)(?:st|nd|rd|th)\b|@UUID\[([^\]]+)\]/g)) {
    if (token[1]) {
      level = Number(token[1]);
      continue;
    }
    const ref = token[2];
    if (!ref.startsWith(FEAT_PREFIX)) continue;
    const { feat, error } = resolveFeat(ref);
    if (!feat) {
      unresolved.push(`${page.name}: ${error}`);
      continue;
    }
    if (feat.traits.includes('archetype') || seen.has(feat.id)) continue;
    seen.add(feat.id);
    entries.push({ slug: feat.slug, level: level ?? feat.level, uuid: FEAT_PREFIX + feat.id });
    if (level === null) notes.push(`${page.name}: no level in journal for ${feat.slug}, used feat level ${feat.level}`);
  }

  // Plain-text mentions without a link cannot be resolved automatically
  const unlinked = text.replace(/@UUID\[[^\]]*\]/g, '').match(/\d+(?:st|nd|rd|th)\s+[A-Z][A-Za-z' ]+/g);
  if (unlinked) unresolved.push(`${page.name}: unlinked feat text ${JSON.stringify(unlinked)}`);

  if (!entries.length) continue;
  if (result[dedication.slug]) {
    notes.push(`${page.name}: duplicate dedication slug ${dedication.slug}, merged`);
    for (const entry of entries) {
      if (!result[dedication.slug].some(e => e.slug === entry.slug)) result[dedication.slug].push(entry);
    }
  } else {
    result[dedication.slug] = entries;
  }
}

// Entries the journals do not link but that were in the hand-typed file or appear as plain text.
// A missing level falls back to the feat's own level.
const supplements = [
  { dedication: 'elementalist-dedication', slug: 'current-spell' },
  { dedication: 'time-mage-dedication', slug: 'quickened-casting' },
  { dedication: 'soul-warden-dedication', slug: 'familiar', level: 4 }
];
for (const { dedication, slug, level } of supplements) {
  const feat = bySlug.get(slug);
  if (!feat || !result[dedication]) {
    unresolved.push(`supplement ${dedication} / ${slug} could not be applied`);
    continue;
  }
  if (result[dedication].some(e => e.slug === slug)) continue;
  result[dedication].push({ slug, level: level ?? feat.level, uuid: FEAT_PREFIX + feat.id });
  result[dedication].sort((a, b) => a.level - b.level);
  notes.push(`supplement: ${dedication} + ${slug} (level ${level ?? feat.level})`);
}

// Validate and write
let featCount = 0;
const lines = [];
for (const key of Object.keys(result).sort()) {
  for (const entry of result[key]) {
    if (!bySlug.has(entry.slug)) throw new Error(`Slug ${entry.slug} (${key}) is not in the feats pack`);
    featCount++;
  }
  lines.push(`  ${JSON.stringify(key)}: [\n${result[key].map(e => `    ${JSON.stringify(e).replace(/,"/g, ', "').replace(/^\{/, '{ ').replace(/\}$/, ' }').replace(/":/g, '": ')}`).join(',\n')}\n  ]`);
}
fs.writeFileSync(outPath, `{\n${lines.join(',\n')}\n}\n`);

console.log(`Wrote ${outPath}`);
console.log(`${lines.length} archetypes, ${featCount} feats`);
for (const note of notes) console.log(`note: ${note}`);
for (const item of unresolved) console.log(`unresolved: ${item}`);
