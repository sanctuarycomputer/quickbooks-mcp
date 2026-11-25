// Sanctuary Computer (quickbooks-mcp-293): preload for the spawned entry: dist/write/mode.js can't be loaded; with
// TEST_MODE_THROWS set, it loads and throws that expression's value.
import { registerHooks } from 'node:module';

const MODE = new URL('../../dist/write/mode.js', import.meta.url).href;
const THROWS = process.env.TEST_MODE_THROWS;
registerHooks({
  load(url, context, next) {
    if (url !== MODE) return next(url, context);
    if (THROWS === undefined) throw new Error('write mode cannot load\nand says more');
    return { format: 'module', source: `throw ${THROWS};`, shortCircuit: true };
  },
});
