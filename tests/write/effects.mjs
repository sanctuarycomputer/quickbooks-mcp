// Sanctuary Computer (quickbooks-mcp-293): records what a module does beyond itself, for mode's import and start checks: each effect is
// named to `say` as it happens, then done as before. Network, child processes; with `all`, also file writes (and opens for
// writing), timers and reads of the keys.
import childProcess from 'node:child_process';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

/** Contract §3's keys; the refused four are built here, as elsewhere. */
export const KEYS = [
  ...['STACKS_QBO_URL', 'STACKS_QBO_TOKEN', 'QUICKBOOKS_ENVIRONMENT', 'QBO_COMPANIES', 'QBO_MODE', 'NOTION_API_KEY'],
  ...['RECEIPT_CMD', 'SWITCH', 'LEDGER', 'SWEEP_STAMP'].map((k) => `QBO_WRITE_${k}`),
  ...['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN', 'REALM_ID'].map((k) => `QUICKBOOKS_${k}`),
];
const WRITES = ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'rename', 'copyFile', 'truncate', 'symlink', 'link', 'chmod', 'utimes'];

const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
/** The flags an open was given, when they can write: any but an absent one, `r` and its synchronous spellings, or a number with no such bit. */
const writing = ([, flags]) => {
  if (typeof flags === 'number') return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) !== 0;
  return typeof flags === 'string' && !['r', 'rs', 'sr'].includes(flags);
};

export function recordEffects(say, { all = false } = {}) {
  const wrap = (target, name, label) => {
    const original = target[name];
    if (typeof original !== 'function') return;
    target[name] = function (...args) {
      const named = typeof label === 'function' ? label(args) : label;
      if (named !== undefined) say(named);
      return new.target ? Reflect.construct(original, args, new.target) : Reflect.apply(original, this, args);
    };
  };
  for (const [m, label] of [[http, 'http'], [https, 'https']]) for (const f of ['request', 'get']) wrap(m, f, `request ${label}.${f}`);
  wrap(http2, 'connect', 'request http2.connect');
  wrap(globalThis, 'fetch', 'request fetch');
  wrap(globalThis, 'WebSocket', 'request WebSocket');
  wrap(net.Socket.prototype, 'connect', 'socket connect');
  wrap(net.Server.prototype, 'listen', 'socket listen');
  wrap(tls, 'connect', 'socket tls.connect');
  wrap(dns, 'lookup', 'socket dns.lookup');
  wrap(dns.promises, 'lookup', 'socket dns.lookup');
  for (const f of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) wrap(childProcess, f, `child ${f}`);
  if (all) {
    for (const f of WRITES) {
      wrap(fs, f, `write ${f}`);
      wrap(fs, `${f}Sync`, `write ${f}`);
      wrap(fs.promises, f, `write ${f}`);
    }
    wrap(fs, 'createWriteStream', 'write createWriteStream');
    for (const [target, name, label] of [[fs, 'open', 'open'], [fs, 'openSync', 'openSync'], [fs.promises, 'open', 'promises.open']]) {
      wrap(target, name, (args) => (writing(args) ? `write ${label} ${args[1]}` : undefined));
    }
    for (const [target, name, label] of [[fs, 'cp', 'cp'], [fs, 'cpSync', 'cpSync'], [fs.promises, 'cp', 'promises.cp']]) wrap(target, name, `write ${label}`);
    for (const f of ['setTimeout', 'setInterval', 'setImmediate']) wrap(globalThis, f, `timer ${f}`);
    const note = (k) => KEYS.includes(k) && say(`key ${k}`);
    process.env = new Proxy(process.env, {
      get: (t, k) => (note(k), t[k]),
      has: (t, k) => (note(k), k in t),
      getOwnPropertyDescriptor: (t, k) => (note(k), Reflect.getOwnPropertyDescriptor(t, k)),
      ownKeys: (t) => (say('key *'), Reflect.ownKeys(t)),
    });
  }
  syncBuiltinESMExports();
}
