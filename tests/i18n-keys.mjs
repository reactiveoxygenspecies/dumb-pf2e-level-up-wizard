// Checks that every localization key used in src/ and templates/ exists in languages/en.json,
// and reports keys in en.json that nothing uses. Run: node tests/i18n-keys.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const PREFIX = 'PF2E_LEVEL_UP_WIZARD';

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

const used = new Set();
for (const file of walk(join(root, 'src')).filter((f) => f.endsWith('.js'))) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/localize\(\s*[`'"]([\w.-]+)[`'"]/g)) used.add(`${PREFIX}.${m[1]}`);
  for (const m of text.matchAll(/localize\(\s*`([\w.-]+)\$\{/g)) used.add(`${PREFIX}.${m[1]}*`);
  for (const m of text.matchAll(/['"`](PF2E_LEVEL_UP_WIZARD\.[\w.-]+)['"`]/g)) used.add(m[1]);
}
for (const file of walk(join(root, 'templates'))) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/'(PF2E_LEVEL_UP_WIZARD\.[\w.-]+)'/g)) used.add(m[1]);
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
process.exitCode = missing.length ? 1 : 0;
