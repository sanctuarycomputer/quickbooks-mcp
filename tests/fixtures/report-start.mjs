// Sanctuary Computer (quickbooks-mcp-291): preload for start tests: at the first tool registration, reports whether the guard and the backstop are in place.
// Writes to stderr (stdout is the MCP channel): one `report-start:` line at the first registration, or `report-start: no registration` at exit.
import { createRequire } from 'node:module';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const { McpServer } = await import(pathToFileURL(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'server', 'mcp.js')).href);
const MARK = Symbol.for('qbo-guard.backstop');

let reported = false;
const yes = (v) => (v ? 'yes' : 'no');
function report() {
  if (reported) return;
  reported = true;
  const nq = createRequire(path.join(ROOT, 'package.json')).resolve('node-quickbooks');
  const axios = createRequire(nq)('axios');
  const g = globalThis;
  const parts = [
    ['https.request', https.request],
    ['https.get', https.get],
    ['http.request', http.request],
    ['http.get', http.get],
    ['http2.connect', http2.connect],
    ['fetch', g.fetch],
    ['WebSocket', g.WebSocket],
  ].map(([name, fn]) => `${name} ${yes(fn && fn[MARK] === true)}`);
  const adapter = axios.defaults.adapter;
  parts.push(`adapter ${yes(typeof adapter === 'function' && adapter.name === 'qboGuardAdapter')}`);
  process.stderr.write(`report-start: ${parts.join(', ')}\n`);
}
for (const method of ['registerTool', 'tool']) {
  const original = McpServer.prototype[method];
  McpServer.prototype[method] = function (...args) {
    report();
    return original.apply(this, args);
  };
}
process.on('exit', () => {
  if (!reported) process.stderr.write('report-start: no registration\n');
});
