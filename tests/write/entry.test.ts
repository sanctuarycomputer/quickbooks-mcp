// Sanctuary Computer (quickbooks-mcp-293): the built entry's modes in a process (A1.1, A1.3, A1.5, A1.6, G3), and what importing each
// module under src/write does (G3, PB5, PC5). Every child runs dist/, so a build older than src fails at once.
import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { assertFreshBuild, ROOT, startEnv } from '../e2e/helpers.js';
import { fakePath } from '../helpers/server.js';
import { READ_ALLOWLIST } from '../../src/tool-lists.js';
import { WRITE_TOOLS } from '../../src/allowlist.js';
import { WRITE_KEYS } from './write-rig.js';

jest.setTimeout(60000);
beforeAll(() => assertFreshBuild());

const ENTRY = path.join(ROOT, 'dist', 'index.js');
const preload = (dir: 'fixtures' | 'write', name: string) => ['--import', pathToFileURL(path.join(ROOT, 'tests', dir, name)).href];
const RECORD = [...preload('fixtures', 'no-network.mjs'), ...preload('write', 'entry-record.mjs')];
const WRITE = { QBO_MODE: 'write', ...WRITE_KEYS };
const READ_LIST = [...READ_ALLOWLIST, 'qbo_companies'].sort();

const call = (name: string) => JSON.parse(fs.readFileSync(fakePath(`tool-calls/${name}.json`), 'utf8'));
const rpc = (id: number, method: string, params: object) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const HELLO = [
  rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'entry-test', version: '0.0.0' } }),
  JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  rpc(2, 'tools/list', {}),
];
const STUB_CALLS = ['qbo_categorize_purchase', 'qbo_categorize_bill', 'qbo_undo_change', 'qbo_write_check'].map((name, i) => rpc(3 + i, 'tools/call', { name, arguments: call(name) }));

type Run = { code: number | null; killed: boolean; stdout: string; stderr: string };
/** Runs the entry under the preloads, with the five keys and `env` (an undefined one left out), writes the lines, and kills it once `done` says so, or after the limit. */
function run(nodeArgs: string[], env: Record<string, string | undefined>, input: string[], done: (r: Run) => boolean): Promise<Run> {
  const all: Record<string, string | undefined> = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot, ...startEnv(), ...env };
  for (const k of Object.keys(all)) if (all[k] === undefined) delete all[k];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, ENTRY], { cwd: ROOT, env: all as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const r: Run = { code: null, killed: false, stdout: '', stderr: '' };
    const kill = () => {
      if (!r.killed && child.exitCode === null) {
        r.killed = true;
        child.kill();
      }
    };
    const timer = setTimeout(kill, 40000);
    const more = () => done(r) && kill();
    child.stdout.on('data', (d) => ((r.stdout += d), more()));
    child.stderr.on('data', (d) => ((r.stderr += d), more()));
    child.stdin.on('error', () => {}); // the child may exit before reading
    child.stdin.write(input.join('\n') + '\n');
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ...r, code });
    });
  });
}
// Node's own warnings (registerHooks is experimental on some) are not the server's lines.
const lines = (s: string) => s.split(/\r?\n/).filter((l) => l !== '' && !l.startsWith('(node:') && !l.startsWith('(Use `node'));
const records = (r: Run, kind: string) => lines(r.stderr).filter((l) => l.startsWith(`record ${kind} `)).map((l) => l.slice(`record ${kind} `.length));
const answer = (r: Run, id: number) => lines(r.stdout).map((l) => JSON.parse(l)).find((m) => m.id === id)?.result;
const answered = (id: number) => (r: Run) => r.stdout.includes('\n') && lines(r.stdout).some((l) => l.includes(`"id":${id}`)) && r.stdout.endsWith('\n');
const sent = (r: Run) => ['request', 'socket', 'child'].flatMap((kind) => records(r, kind));

describe('the write server (A1.1, G3)', () => {
  it('loads write/mode.js, lists the five tools, and neither its start nor its stubs send anything or start a process', async () => {
    const r = await run(RECORD, WRITE, [...HELLO, ...STUB_CALLS], (x) => [3, 4, 5, 6].every((id) => answered(id)(x)));
    expect(answer(r, 2).tools.map((t: any) => t.name).sort()).toEqual([...WRITE_TOOLS].sort());
    for (const id of [3, 4, 5, 6]) expect(answer(r, id)).toEqual({ isError: true, content: [{ type: 'text', text: 'reason: fork-error\n\nThis tool is not built yet.' }] });
    expect(records(r, 'load')).toEqual(expect.arrayContaining(['index.js', 'write/mode.js', 'write/capability.js', 'write/guard-rules.js', 'write/stubs.js']));
    expect(records(r, 'tool').sort()).toEqual([...WRITE_TOOLS].sort());
    expect(sent(r)).toEqual([]);
    expect(r.stdout).not.toContain('network-reached');
  });

  it('the guard, the backstop and the rules are in before the first tool registers', async () => {
    const r = await run([...preload('fixtures', 'report-start.mjs')], WRITE, HELLO, answered(2));
    expect(lines(r.stderr)).toEqual(['report-start: https.request yes, https.get yes, http.request yes, http.get yes, http2.connect yes, fetch yes, WebSocket yes, adapter yes']);
  });

  it('its guard allows the by-id fetch, and no update without a capability (A3.10)', async () => {
    const r = await run(preload('write', 'entry-ask.mjs'), WRITE, HELLO, (x) => x.stderr.includes('ask done'));
    expect(lines(r.stderr).filter((l) => l.startsWith('ask '))).toEqual(['ask fetch: reached', 'ask update: refused write-update', 'ask done']);
  });

  it.each([
    ['QBO_WRITE_SWITCH unset', { QBO_WRITE_SWITCH: undefined }, 'refused to start: QBO_WRITE_SWITCH is not set'],
    ['QBO_COMPANIES unset', { QBO_COMPANIES: undefined }, 'refused to start: QBO_COMPANIES is not set'],
    ['NODE_USE_ENV_PROXY set', { NODE_USE_ENV_PROXY: '1' }, 'qbo-guard: start refused: NODE_USE_ENV_PROXY'],
  ])('%s: one line, exit 1, no tool', async (_label, over, message) => {
    const r = await run(preload('fixtures', 'report-start.mjs'), { ...WRITE, ...over }, HELLO, answered(2));
    expect([r.killed, r.code, r.stdout, lines(r.stderr)]).toEqual([false, 1, '', [message, 'report-start: no registration']]);
  });

  it('a failed import of write/mode.js: one line, exit 1, no tool registered, no read server (G3)', async () => {
    const r = await run([...preload('fixtures', 'report-start.mjs'), ...preload('write', 'fail-mode.mjs')], WRITE, HELLO, answered(2));
    expect([r.killed, r.code, r.stdout, lines(r.stderr)]).toEqual([false, 1, '', ['write mode cannot load', 'report-start: no registration']]);
  });
});

describe('the read server (A1.5, A1.6, G3)', () => {
  it.each([undefined, 'read'])('QBO_MODE %j, the write keys set: the read list, and nothing under write/ loads', async (QBO_MODE) => {
    const r = await run(RECORD, { ...WRITE, QBO_MODE }, HELLO, answered(2));
    expect(answer(r, 2).tools.map((t: any) => t.name).sort()).toEqual(READ_LIST);
    expect(records(r, 'load')).toEqual(expect.arrayContaining(['index.js', 'allowlist.js', 'helpers/register-tool.js']));
    expect(records(r, 'load').filter((l) => l.startsWith('write/'))).toEqual([]);
    expect(records(r, 'tool').sort()).toEqual(READ_LIST);
    expect(sent(r)).toEqual([]);
  });

  it('starts though write/mode.js can’t be loaded', async () => {
    const r = await run(preload('write', 'fail-mode.mjs'), {}, HELLO, answered(2));
    expect(answer(r, 2).tools).toHaveLength(32);
  });

  it('its guard allows neither the by-id fetch nor the update', async () => {
    const r = await run(preload('write', 'entry-ask.mjs'), {}, HELLO, (x) => x.stderr.includes('ask done'));
    const asked = lines(r.stderr).filter((l) => l.startsWith('ask '));
    expect(asked).toEqual([expect.stringMatching(/^ask fetch: refused entity-by-id$/), expect.stringMatching(/^ask update: refused (?!write-update)/), 'ask done']);
  });

  it.each(['Write', 'readwrite', '', 'WRITE', 'write '])('QBO_MODE %j: refused as neither mode, and nothing under write/ loads (A1.3)', async (QBO_MODE) => {
    const r = await run(RECORD, { ...WRITE, QBO_MODE }, HELLO, answered(2));
    expect([r.killed, r.code, r.stdout]).toEqual([false, 1, '']);
    expect(lines(r.stderr).filter((l) => !l.startsWith('record '))).toEqual(['refused to start: QBO_MODE is not read']);
    expect(records(r, 'load').filter((l) => l.startsWith('write/'))).toEqual([]);
    expect(records(r, 'tool')).toEqual([]);
  });
});

describe('importing a module under src/write does nothing (G3)', () => {
  const WRITE_SRC = path.join(ROOT, 'src', 'write');
  const WRITE_DIST = path.join(ROOT, 'dist', 'write');
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
  const MODULES = walk(WRITE_SRC).map((f) => path.relative(WRITE_SRC, f).replace(/\.ts$/, '.js'));
  const built = (rel: string) => path.join(WRITE_DIST, rel);
  const href = (file: string) => pathToFileURL(file).href;
  /** The shipped modules the write modules load: each import that leaves dist/write, and each package. */
  function baseline(): string[] {
    const out = new Set<string>();
    for (const rel of MODULES) {
      for (const [, spec] of fs.readFileSync(built(rel), 'utf8').matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        if (!spec.startsWith('.')) out.add(spec);
        else if (path.relative(WRITE_DIST, path.resolve(path.dirname(built(rel)), spec)).startsWith('..')) out.add(href(path.resolve(path.dirname(built(rel)), spec)));
      }
    }
    return [...out].sort();
  }
  function effects(target: string): { baseline: string[]; module: string[] } {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'write', 'import-effects.mjs'), target, ...baseline()], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 50000,
      // None of the keys is set, so listing the environment's names is not a read of one.
      env: { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    if (r.status !== 0) throw new Error(`import-effects: ${r.stderr}`);
    return JSON.parse(r.stdout);
  }

  it('the walk finds the modules, and what they load that ships already', () => {
    expect(MODULES).toEqual(expect.arrayContaining(['mode.js', 'stubs.js', 'capability.js', 'client.js', 'guard-rules.js', 'pre-send.js', 'compare.js']));
    expect(baseline()).toEqual(expect.arrayContaining(['zod', href(path.join(ROOT, 'dist', 'http-guard.js'))]));
    expect(baseline().filter((b) => b.includes('/dist/write/'))).toEqual([]);
  });

  // One child each, so every module is also the first to load of its import cycle.
  it.each(MODULES)('%s', (rel) => {
    const got = effects(href(built(rel)));
    expect(got.module).toEqual([]);
    // What ships already, loaded first: the one effect counted is `debug` (follow-redirects', so axios') listing the environment's names as
    // it loads, for DEBUG_ ones; it reads no key's value, and the read server loads it too. The guard's agent opens no socket until used.
    expect(got.baseline).toEqual(['key *']);
  });

  it('each effect counted is named when a module has it', () => {
    const { module } = effects(href(path.join(ROOT, 'tests', 'write', 'effects-probe.mjs')));
    expect(new Set(module)).toEqual(
      new Set(['made createRegistry', 'made createGuard', 'timer setTimeout', 'key QBO_WRITE_LEDGER', 'write rm', 'child execFile', 'key *', 'request https.request', 'socket connect']),
    );
  });
});
