// Sanctuary Computer (quickbooks-mcp-293): preload for the spawned entry: each built module as it loads, each request, socket and child
// process, and each tool registered, is one `record ` line on stderr, written as it happens: the test kills the server, so no exit handler runs.
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { recordEffects } from './effects.mjs';

const say = (line) => fs.writeSync(2, `record ${line}\n`);
const DIST = new URL('../../dist/', import.meta.url).href;
registerHooks({
  load(url, context, next) {
    if (url.startsWith(DIST)) say(`load ${url.slice(DIST.length)}`);
    return next(url, context);
  },
});
recordEffects(say);
for (const method of ['registerTool', 'tool']) {
  const original = McpServer.prototype[method];
  McpServer.prototype[method] = function (...args) {
    say(`tool ${args[0]}`);
    return original.apply(this, args);
  };
}
