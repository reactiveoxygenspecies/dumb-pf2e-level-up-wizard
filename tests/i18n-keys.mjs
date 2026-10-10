// Checks that every localization key used in src/ and templates/ exists in languages/en.json,
// and reports keys in en.json that nothing uses. Translations may leave strings out (Foundry falls
// back to English) or placeholders, but must not keep keys en.json no longer has or use a
// {placeholder} the English string doesn't (the code may not pass it, and it would show as text).
// Run: node tests/i18n-keys.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const PREFIX = 'DUMB_LEVEL_UP_WIZARD';

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const flatten = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`]
  );

const en = JSON.parse(readFileSync(join(root, 'languages/en.json'), 'utf8'));
const defined = new Set(flatten(en));
const valueAt = (obj, key) => key.split('.').reduce((o, k) => o?.[k], obj);
const placeholders = (str) => [...String(str).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

const used = new Set();
for (const file of walk(join(root, 'src')).filter((f) => f.endsWith('.js'))) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/localize\(\s*[`'"]([\w.-]+)[`'"]/g)) used.add(`${PREFIX}.${m[1]}`);
  for (const m of text.matchAll(/localize\(\s*`([\w.-]+)\$\{/g)) used.add(`${PREFIX}.${m[1]}*`);
  // localize(condition ? 'a.b' : 'c.d', ...)
  for (const m of text.matchAll(/localize\(\s*[^'"`(),]+\?\s*'([\w.-]+)'\s*:\s*'([\w.-]+)'/g)) {
    // System keys (PF2E.*) go through game.i18n directly and aren't ours to check
    for (const key of [m[1], m[2]]) if (!/^[A-Z]/.test(key)) used.add(`${PREFIX}.${key}`);
  }
  for (const m of text.matchAll(/['"`](DUMB_LEVEL_UP_WIZARD\.[\w.-]+)['"`]/g)) used.add(m[1]);
}
// Keys picked indirectly (stored in a variable first): any string literal that is exactly a defined key
for (const file of walk(join(root, 'src')).filter((f) => f.endsWith('.js'))) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/'([a-z][\w-]*(?:\.[\w-]+)+)'/g)) {
    if (defined.has(`${PREFIX}.${m[1]}`)) used.add(`${PREFIX}.${m[1]}`);
  }
}
for (const file of walk(join(root, 'templates'))) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/'(DUMB_LEVEL_UP_WIZARD\.[\w.-]+)'/g)) used.add(m[1]);
}

const missing = [...used].filter((k) => {
  if (k.endsWith('*')) {
    const base = k.slice(0, -1);
    return ![...defined].some((d) => d.startsWith(base));
  }
  if (defined.has(k)) return false;
  // `${S}.x` settings keys register name/hint/options automatically
  return ![...defined].some((d) => d.startsWith(`${k}.`));
});
const unused = [...defined].filter(
  (k) =>
    ![...used].some((u) => u === k || (u.endsWith('*') && k.startsWith(u.slice(0, -1)))) &&
    !k.startsWith(`${PREFIX}.settings.`)
);

console.log(`used: ${used.size}, defined: ${defined.size}`);
if (missing.length) console.log('MISSING:\n  ' + missing.join('\n  '));
if (unused.length) console.log('UNUSED:\n  ' + unused.join('\n  '));

let translationErrors = 0;
for (const file of readdirSync(join(root, 'languages')).filter((f) => f !== 'en.json')) {
  const lang = JSON.parse(readFileSync(join(root, 'languages', file), 'utf8'));
  const keys = flatten(lang);
  const stale = keys.filter((k) => !defined.has(k));
  const mismatched = keys.filter((k) => {
    if (!defined.has(k)) return false;
    const english = placeholders(valueAt(en, k));
    return placeholders(valueAt(lang, k)).some((p) => !english.includes(p));
  });
  console.log(`${file}: ${keys.length - stale.length}/${defined.size} translated`);
  if (stale.length) console.log(`  NOT IN en.json:\n    ${stale.join('\n    ')}`);
  if (mismatched.length) console.log(`  PLACEHOLDERS NOT IN ENGLISH:\n    ${mismatched.join('\n    ')}`);
  translationErrors += stale.length + mismatched.length;
}
process.exitCode = missing.length || translationErrors ? 1 : 0;
