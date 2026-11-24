// Sanctuary Computer (quickbooks-mcp-293): preload for the spawned entry: at the first tool registration it asks the started guard, in a
// call of its own, for a by-id fetch and an update no capability allows; one `ask ` line each. Nothing leaves: https.request, under the
// backstop, only says that it was reached.
import fs from 'node:fs';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

https.request = () => {
  throw new Error('reached');
};
syncBuiltinESMExports();
const DIST = new URL('../../dist/', import.meta.url);
const ROOT = 'https://quickbooks.api.intuit.com/v3/company/9990000000000002';
const JSON_BODY = { 'Content-Type': 'application/json', Accept: 'application/json' };

let asked = false;
async function ask() {
  const { currentCall, runInCall, setCallToken } = await import(new URL('clients/call-context.js', DIST).href);
  const { guardedAxios } = await import(new URL('http-guard.js', DIST).href);
  for (const [label, request] of [
    ['fetch', () => guardedAxios().get(`${ROOT}/purchase/5?minorversion=75`)],
    ['update', () => guardedAxios().post(`${ROOT}/purchase?operation=update&minorversion=75`, '{"Id":"5","SyncToken":"0","sparse":true}', { headers: JSON_BODY, timeout: 1000, transformRequest: [(t) => t] })],
  ]) {
    const answer = await runInCall('garden3d', async () => {
      setCallToken(['ask', 'token'].join('-'), '9990000000000002');
      if (currentCall()?.company !== 'garden3d') throw new Error('no call');
      return request();
    }).then(() => 'answered', (e) => (e.name === 'GuardRefusedError' ? `refused ${e.rule}` : e.message));
    fs.writeSync(2, `ask ${label}: ${answer}\n`);
  }
  fs.writeSync(2, 'ask done\n');
}
const original = McpServer.prototype.tool;
McpServer.prototype.tool = function (...args) {
  if (!asked) {
    asked = true;
    void ask();
  }
  return original.apply(this, args);
};
