// Sanctuary Computer (quickbooks-mcp-293): imports the baseline modules, then the module under test, and prints what each import did:
// `node import-effects.mjs <module URL> <baseline URL>...` writes {"baseline":[…],"module":[…]}. Beside effects.mjs' effects it names a
// registry or a guard made: createRegistry and createGuard say so as they run.
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { recordEffects } from './effects.mjs';

const [target, ...baseline] = process.argv.slice(2);
const DIST = new URL('../../dist/', import.meta.url).href;
const MAKERS = { [`${DIST}write/capability.js`]: 'createRegistry', [`${DIST}http-guard.js`]: 'createGuard' };
const out = { baseline: [], module: [] };
let phase = out.baseline;
globalThis.madeInTest = (name) => phase.push(`made ${name}`);
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    const maker = MAKERS[url];
    if (maker === undefined) return loaded;
    const text = String(Buffer.from(loaded.source));
    const source = text.replace(new RegExp(`^export function ${maker}\\(.*\\) \\{$`, 'm'), (head) => `${head} globalThis.madeInTest('${maker}');`);
    if (source === text) throw new Error(`no ${maker} in ${url}`);
    return { ...loaded, source };
  },
});
recordEffects((effect) => phase.push(effect), { all: true });
for (const url of baseline) await import(url);
phase = out.module;
await import(target);
const text = JSON.stringify(out);
phase = [];
fs.writeSync(1, text);
