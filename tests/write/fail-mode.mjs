// Sanctuary Computer (quickbooks-mcp-293): preload for the spawned entry: dist/write/mode.js can't be loaded.
import { registerHooks } from 'node:module';

const MODE = new URL('../../dist/write/mode.js', import.meta.url).href;
registerHooks({
  load(url, context, next) {
    if (url === MODE) throw new Error('write mode cannot load\nand says more');
    return next(url, context);
  },
});
