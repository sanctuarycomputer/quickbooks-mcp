// Sanctuary Computer (quickbooks-mcp-293): preload for the spawned entry: each writeMode() is numbered. Its tools' descriptions are `mode <n>`,
// and its rules write `rules of mode <n>` on stderr when asked.
import { registerHooks } from 'node:module';

const MODE = new URL('../../dist/write/mode.js', import.meta.url).href;
const HEAD = 'export function writeMode(';
const NUMBERED = `
import { writeSync } from 'node:fs';
let made = 0;
export function writeMode() {
  const name = 'mode ' + ++made;
  const mode = shippedWriteMode();
  return {
    ...mode,
    tools: mode.tools.map((t) => ({ ...t, description: name })),
    extraRules: { decide: (...args) => (writeSync(2, 'rules of ' + name + '\\n'), mode.extraRules.decide(...args)) },
  };
}
`;
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    if (url !== MODE) return loaded;
    const text = String(Buffer.from(loaded.source));
    if (!text.includes(HEAD)) throw new Error('no writeMode in write/mode.js');
    return { ...loaded, source: text.replace(HEAD, 'function shippedWriteMode(') + NUMBERED };
  },
});
