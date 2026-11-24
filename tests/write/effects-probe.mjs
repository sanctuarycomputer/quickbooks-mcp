// Sanctuary Computer (quickbooks-mcp-293): a module that does, at import, each thing import-effects.mjs must name.
import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { request } from 'node:https';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistry } from '../../dist/write/capability.js';
import { createGuard } from '../../dist/http-guard.js';

createRegistry();
createGuard({ stacksUrl: undefined, keys: () => [], allowedRealm: () => false, callRecord: () => undefined });
clearTimeout(setTimeout(() => {}, 1));
void process.env.QBO_WRITE_LEDGER;
rmSync(join(tmpdir(), 'qbo-effects-probe-none'), { force: true });
// A local name nothing listens on.
new Socket().on('error', () => {}).connect({ path: join(tmpdir(), 'qbo-effects-probe-none') });
execFile(process.execPath, ['--version'], () => {});
// Refused in Node before any socket is opened.
try {
  request('http://127.0.0.1:1');
} catch {
  /* a protocol https doesn't take */
}
