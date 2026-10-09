// Copies exactly the files Foundry needs into dist/<module id>/ (upload that folder).
// Run: npm run build
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const { id } = JSON.parse(readFileSync(join(root, 'module.json'), 'utf8'));
const out = join(root, 'dist', id);

const include = ['module.json', 'LICENSE', 'README.md', 'src', 'styles', 'templates', 'languages'];

rmSync(join(root, 'dist'), { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const entry of include) {
  cpSync(join(root, entry), join(out, entry), { recursive: true });
}
console.log(`Built ${out}`);
