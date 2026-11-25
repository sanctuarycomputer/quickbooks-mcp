// Sanctuary Computer (quickbooks-mcp-293): a module that does, at import, each thing import-effects.mjs must name.
import { execFile } from 'node:child_process';
import { constants, cp, cpSync, open, openSync, promises, rmSync } from 'node:fs';
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
// Each open and copy for writing is of a file in a directory that isn't there, so nothing is made; the opens for reading aren't effects.
const none = join(tmpdir(), 'qbo-effects-probe-none', 'file');
const quiet = (fn) => {
  try {
    fn();
  } catch {
    /* no such file */
  }
};
const done = () => {};
open(none, 'w', done);
open(none, constants.O_WRONLY, done);
quiet(() => openSync(none, constants.O_WRONLY));
quiet(() => openSync(none, 'r+'));
promises.open(none, 'a').catch(done);
open(none, done);
open(none, undefined, done);
quiet(() => openSync(none));
quiet(() => openSync(none, 'r'));
quiet(() => openSync(none, 'rs'));
quiet(() => openSync(none, constants.O_RDONLY));
promises.open(none).catch(done);
cp(none, `${none}2`, done);
quiet(() => cpSync(none, `${none}2`));
promises.cp(none, `${none}2`).catch(done);
// A local name nothing listens on.
new Socket().on('error', () => {}).connect({ path: join(tmpdir(), 'qbo-effects-probe-none') });
execFile(process.execPath, ['--version'], () => {});
// Refused in Node before any socket is opened.
try {
  request('http://127.0.0.1:1');
} catch {
  /* a protocol https doesn't take */
}
