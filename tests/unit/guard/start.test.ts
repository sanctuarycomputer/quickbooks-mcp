// Sanctuary Computer (quickbooks-mcp-291): start: the transport refusals (contract §3), secureStart in process, and the built entry in a process.
// Changed by Sanctuary Computer (quickbooks-mcp-286): the built entry runs with the five start keys (e2e helpers' startEnv).
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import { trapNetwork } from '../../fakes/no-network.js';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { installStubNetwork, type StubAnswer, type StubCall } from '../../fakes/stub-network.js';
import { assertFreshBuild, ROOT, startEnv } from '../../e2e/helpers.js';
import {
  BACKSTOP_MARK,
  checkStartEnv,
  configureGuard,
  defaultCallScope,
  guardedAxios,
  GuardRefusedError,
  secureStart,
} from '../../../src/http-guard.js';

const trap = trapNetwork();
const EX = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fakes/guard-examples.json'), 'utf8'));
const QuickBooks = createRequire(import.meta.url)('node-quickbooks');
const REALM = '9990000000000002';
const Q = `https://quickbooks.api.intuit.com/v3/company/${REALM}`;
const P = `${Q}/preferences?minorversion=75&format=json`;
const S = (company: string) => `https://stacks.example.test/api/qbo/access_token?enterprise=${company}`;
const QR = JSON.stringify({ QueryResponse: {} });
const ENTRY = path.join(ROOT, 'dist', 'index.js');
const fixture = (name: string) => pathToFileURL(path.join(ROOT, 'tests', 'fixtures', name)).href;

let answer: (call: StubCall) => StubAnswer | Promise<StubAnswer> = () => ({ status: 200, body: QR });
const net = installStubNetwork((call) => answer(call));

let stderr: string[] = [];
beforeEach(() => {
  stderr = [];
  jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    stderr.push(String(chunk));
    return true;
  }) as any);
});
afterEach(() => {
  expect(trap.reached).toEqual([]);
  net.calls.length = 0;
  answer = () => ({ status: 200, body: QR });
});

describe('checkStartEnv (A1.10(a))', () => {
  it.each([
    [{ NODE_USE_ENV_PROXY: '1' }, [], 'NODE_USE_ENV_PROXY'],
    [{ NODE_USE_ENV_PROXY: '' }, [], 'NODE_USE_ENV_PROXY'],
    [{ NODE_USE_ENV_PROXY: '0' }, [], 'NODE_USE_ENV_PROXY'],
    [{}, ['--use-env-proxy'], '--use-env-proxy'],
    [{ NODE_OPTIONS: '--use-env-proxy' }, [], '--use-env-proxy'],
    [{ NODE_OPTIONS: '--max-old-space-size=100   "--use-env-proxy"' }, [], '--use-env-proxy'],
    // TH1: every spelling Node 24 accepts
    [{}, ['--use_env_proxy'], '--use-env-proxy'],
    [{}, ['--use-env-proxy=1'], '--use-env-proxy'],
    [{}, ['--use-env-proxy=true'], '--use-env-proxy'],
    [{ NODE_OPTIONS: '--use_env_proxy' }, [], '--use-env-proxy'],
    [{ NODE_OPTIONS: '--use-env-proxy=1' }, [], '--use-env-proxy'],
    [{ NODE_OPTIONS: '--use-env"-proxy"' }, [], '--use-env-proxy'],
    [{ NODE_OPTIONS: '"--use-env\\-proxy"' }, [], '--use-env-proxy'],
    [{ NODE_OPTIONS: '--a "b c" --use-env-proxy' }, [], '--use-env-proxy'],
    // TH3: a config file can turn it on
    [{}, ['--experimental-config-file=node.config.json'], '--experimental-config-file'],
    [{}, ['--experimental-config-file', 'x.json'], '--experimental-config-file'],
    [{ NODE_OPTIONS: '--experimental_default_config_file' }, [], '--experimental-default-config-file'],
    // TI2: stricter than Node on purpose: a tab ends a token here
    [{ NODE_OPTIONS: '--no-warnings\t--use-env-proxy' }, [], '--use-env-proxy'],
    [{ NODE_TLS_REJECT_UNAUTHORIZED: '0' }, [], 'NODE_TLS_REJECT_UNAUTHORIZED'],
    [{ NODE_EXTRA_CA_CERTS: '/nonexistent' }, [], 'NODE_EXTRA_CA_CERTS'],
    [{ NODE_EXTRA_CA_CERTS: '' }, [], 'NODE_EXTRA_CA_CERTS'],
  ] as Array<[NodeJS.ProcessEnv, string[], string]>)('%j %j → refused naming %s', (env, argv, key) => {
    expect(checkStartEnv(env, argv)).toEqual({ ok: false, key });
  });

  it.each([
    [{}, []],
    [{ NODE_TLS_REJECT_UNAUTHORIZED: '1' }, []],
    [{ NODE_TLS_REJECT_UNAUTHORIZED: '' }, []],
    [{ NODE_OPTIONS: '--use-env-proxy-not --max-old-space-size=100' }, []],
    [{}, ['--experimental-vm-modules', '--no-use-env-proxy', '-use-env-proxy', 'use-env-proxy']],
    [{ NODE_OPTIONS: '"--use-env-proxy-not" --title="--use-env-proxy"' }, []],
    [{ NODE_OPTIONS: '"a b"  ""' }, []],
    [{ NODE_OPTIONS: '--title="a --use-env-proxy"' }, []],
    [{ NODE_OPTIONS: 'xxuse-env-proxy' }, ['xxuse-env-proxy']],
    // TI2: an escape outside quotes is a plain character (Node then rejects the option), and `--` must lead the token
    [{ NODE_OPTIONS: '--use-env\\-proxy' }, []],
    [{ NODE_OPTIONS: 'x--use-env-proxy' }, ['x--use-env-proxy']],
    [{ node_use_env_proxy: '1', PATH: '/bin' }, []],
  ] as Array<[NodeJS.ProcessEnv, string[]]>)('%j %j → ok', (env, argv) => {
    expect(checkStartEnv(env, argv)).toEqual({ ok: true });
  });

  it('the first key in contract order is named when several are set', () => {
    expect(
      checkStartEnv({ NODE_EXTRA_CA_CERTS: 'x', NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_OPTIONS: '--use-env-proxy', NODE_USE_ENV_PROXY: '1' }, []),
    ).toEqual({ ok: false, key: 'NODE_USE_ENV_PROXY' });
    expect(checkStartEnv({ NODE_EXTRA_CA_CERTS: 'x', NODE_TLS_REJECT_UNAUTHORIZED: '0' }, ['--use-env-proxy'])).toEqual({
      ok: false,
      key: '--use-env-proxy',
    });
    expect(checkStartEnv({ NODE_EXTRA_CA_CERTS: 'x', NODE_TLS_REJECT_UNAUTHORIZED: '0' }, [])).toEqual({
      ok: false,
      key: 'NODE_TLS_REJECT_UNAUTHORIZED',
    });
  });

  it('TI1: secureStart refuses when https.globalAgent has a proxyEnv, whatever turned it on, and installs nothing', () => {
    const options = (https.globalAgent as any).options;
    const before = [https.request, http.request, guardedAxios().defaults.adapter];
    options.proxyEnv = { HTTPS_PROXY: 'http://127.0.0.1:9' };
    try {
      expect(() => secureStart({}, [])).toThrow(new Error('qbo-guard: start refused: --use-env-proxy'));
    } finally {
      delete options.proxyEnv;
    }
    expect([https.request, http.request, guardedAxios().defaults.adapter]).toEqual(before);
    expect(() => defaultCallScope()).toThrow('qbo-guard: not started');
  });

  it('secureStart throws the refusal naming the key, never the value, and installs nothing', () => {
    const before = [https.request, http.request, guardedAxios().defaults.adapter];
    const value = 'sentinel-' + process.pid;
    expect(() => secureStart({ NODE_EXTRA_CA_CERTS: value }, [])).toThrow(new Error('qbo-guard: start refused: NODE_EXTRA_CA_CERTS'));
    expect([https.request, http.request, guardedAxios().defaults.adapter]).toEqual(before);
    expect(() => defaultCallScope()).toThrow('qbo-guard: not started');
  });
});

describe('secureStart with an axios that cannot be resolved (A1.10(d), in process)', () => {
  it.each([
    ['throws', () => {
      throw new Error('no axios');
    }],
    ['returns nothing', () => undefined],
    ['returns an object without getAdapter', () => ({ getUri: () => '' })],
    ['returns an object without getUri', () => ({ getAdapter: () => undefined })],
  ] as Array<[string, () => unknown]>)('resolveAxios %s: install failed, nothing replaced', (_what, resolveAxios) => {
    const before = [https.request, https.get, http.request, http.get, (globalThis as any).fetch, guardedAxios().defaults.adapter];
    expect(() => secureStart({}, [], { resolveAxios })).toThrow(new Error('qbo-guard: install failed'));
    expect([https.request, https.get, http.request, http.get, (globalThis as any).fetch, guardedAxios().defaults.adapter]).toEqual(before);
    expect(() => defaultCallScope()).toThrow('qbo-guard: not started');
    expect(() => configureGuard({})).toThrow('qbo-guard: not started');
  });
});

describe('secureStart when the backstop fails after the guard is in (TH4, all or nothing in process)', () => {
  it('install failed, and the guard, its context and the scope are all put back', () => {
    const ax = guardedAxios();
    const before = [ax.defaults.adapter, https.request, http.request];
    const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      get() {
        throw new Error('no fetch');
      },
    });
    try {
      expect(() => secureStart({}, [])).toThrow(new Error('qbo-guard: install failed'));
    } finally {
      if (fetchDescriptor) Object.defineProperty(globalThis, 'fetch', fetchDescriptor);
      else delete (globalThis as any).fetch;
    }
    expect([ax.defaults.adapter, https.request, http.request]).toEqual(before);
    expect((https.request as any)[BACKSTOP_MARK]).toBeUndefined();
    expect(() => configureGuard({})).toThrow('qbo-guard: not started');
    expect(() => defaultCallScope()).toThrow('qbo-guard: not started');
  });
});

describe('after secureStart (P2)', () => {
  const ax = guardedAxios();
  const originalAdapter = ax.defaults.adapter;
  let restore: () => void = () => {};
  const inCall = <T>(fn: () => Promise<T>): Promise<T> => {
    const scope = defaultCallScope();
    return scope.run(async () => {
      scope.setRealm(REALM);
      return fn();
    });
  };

  describe('with STACKS_QBO_URL set', () => {
    beforeAll(() => {
      restore = secureStart({ STACKS_QBO_URL: 'https://stacks.example.test' }, []);
    });
    afterAll(() => restore());

    it('the adapter is the guard, and the backstop is in place', () => {
      expect(ax.defaults.adapter).not.toBe(originalAdapter);
      expect((ax.defaults.adapter as any).name).toBe('qboGuardAdapter');
      expect((https.request as any)[BACKSTOP_MARK]).toBe(true);
      expect((http.get as any)[BACKSTOP_MARK]).toBe(true);
    });

    it("TH2: the started guard holds QuickBooks to the call's realm: another realm, and no realm, are refused", async () => {
      const other = P.replace(REALM, '9341450000000001');
      expect(other).not.toBe(P);
      await expect(inCall(() => ax.get(other))).rejects.toMatchObject({ name: 'GuardRefusedError', rule: 'quickbooks' });
      const scope = defaultCallScope();
      await expect(scope.run(() => ax.get(P))).rejects.toMatchObject({ name: 'GuardRefusedError', rule: 'quickbooks' });
      expect(net.calls).toHaveLength(0);
    });

    it('a second start fails and changes nothing', () => {
      const before = [https.request, ax.defaults.adapter, defaultCallScope()];
      expect(() => secureStart({}, [])).toThrow(new Error('qbo-guard: install failed'));
      expect([https.request, ax.defaults.adapter, defaultCallScope()]).toEqual(before);
    });

    it('a findAccounts call through a fake-token client in defaultCallScope reaches the stub once (A1.1)', async () => {
      const client = new QuickBooks('id', 'secret', 'qbo-fake-' + 'token', false, REALM, false, false, null, '2.0', 'r');
      await inCall(
        () => new Promise((resolve, reject) => client.findAccounts([{ field: 'limit', value: 10 }], (err: unknown, d: unknown) => (err ? reject(err) : resolve(d)))),
      );
      expect(net.calls).toHaveLength(1);
      expect(net.calls[0].path).toBe(`/v3/company/${REALM}/query?query=select%20*%20from%20account%20startposition%201%20maxresults%2010&minorversion=75&format=json`);
    });

    it('Stacks: garden3d refused with no keys, allowed after configureGuard; usb-club still refused; QuickBooks still allowed; stacksUrl kept (A1.15)', async () => {
      await expect(ax.get(S('garden3d'))).rejects.toMatchObject({ rule: 'stacks' });
      configureGuard({ keys: () => ['garden3d'] });
      await ax.get(S('garden3d'));
      await expect(ax.get(S('usb-club'))).rejects.toMatchObject({ rule: 'stacks' });
      await inCall(() => ax.get(P));
      expect(net.calls.map((c) => `${c.hostname}${c.path}`)).toEqual([
        'stacks.example.test/api/qbo/access_token?enterprise=garden3d',
        `quickbooks.api.intuit.com/v3/company/${REALM}/preferences?minorversion=75&format=json`,
      ]);
      configureGuard({ keys: () => [] });
    });

    it('a contract refuse row and allow row through the started guard (A1.2, A1.3)', async () => {
      const allow = EX.examples.find((r: any) => r.decision === 'allow' && r.url.startsWith('https://quickbooks.'));
      const refuse = EX.examples.find((r: any) => r.decision === 'refuse' && r.method !== 'GET');
      await inCall(() => ax.request({ method: allow.method, url: allow.url }));
      await expect(inCall(() => ax.request({ method: refuse.method, url: refuse.url }))).rejects.toBeInstanceOf(GuardRefusedError);
      expect(net.calls).toHaveLength(1);
    });

    it('a raw https.request outside the guard is refused by the backstop', () => {
      expect(() => https.request(`${Q}/upload`, { method: 'POST' })).toThrow(GuardRefusedError);
      expect(net.calls).toHaveLength(0);
    });
  });

  describe('with STACKS_QBO_URL absent', () => {
    beforeAll(() => {
      restore = secureStart({}, []);
    });
    afterAll(() => restore());

    it('a Stacks request is refused (refused), even with the key configured', async () => {
      configureGuard({ keys: () => ['garden3d'] });
      await expect(ax.get(S('garden3d'))).rejects.toMatchObject({ rule: 'refused' });
      expect(net.calls).toHaveLength(0);
    });
  });

  it('restore puts back the adapter and the transport functions, and start is open again', () => {
    expect(ax.defaults.adapter).toBe(originalAdapter);
    expect((https.request as any)[BACKSTOP_MARK]).toBeUndefined();
    expect(() => defaultCallScope()).toThrow('qbo-guard: not started');
  });
});

afterAll(() => {
  net.restore();
  trap.restore();
});

// ---- the built entry in a process ----

const INITIALIZE =
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'start-test', version: '0.0.0' } },
  }) + '\n';

type Run = { code: number | null; killed: boolean; stdout: string; stderr: string };

/** Runs node <nodeArgs> dist/index.js with exactly env (plus PATH, SystemRoot, the five start keys), writes initialize, and kills it once `until` is seen on stdout or after the timeout. */
function runEntry(nodeArgs: string[], env: Record<string, string>, until?: string, timeoutMs = 15000, entryArgs: string[] = []): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, ENTRY, ...entryArgs], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...startEnv(), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let err = '';
    let killed = false;
    const kill = () => {
      if (!killed && child.exitCode === null) {
        killed = true;
        child.kill();
      }
    };
    const timer = setTimeout(kill, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d;
      if (until !== undefined && stdout.includes(until)) kill();
    });
    child.stderr.on('data', (d) => (err += d));
    child.stdin.on('error', () => {}); // the child may exit before reading
    child.stdin.end(INITIALIZE);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, killed, stdout, stderr: err });
    });
  });
}

const lines = (s: string) => s.split(/\r?\n/).filter(Boolean);
// Node's own startup warning for an unreadable NODE_EXTRA_CA_CERTS names the path; it is Node's line, not ours.
const ours = (s: string) => lines(s).filter((l) => !l.startsWith('Warning: Ignoring extra certs from') && !l.startsWith('(Use `node --trace-warnings'));

describe('the built entry (A4.1, A1.10(c), A1.10(d))', () => {
  // TI4: each case may wait for runEntry's own 15 s timeout, so jest's 5 s default must not end it first.
  jest.setTimeout(30000);
  const sentinel = 'sentinel' + process.pid;
  it.each([
    ['NODE_USE_ENV_PROXY=1', [], { NODE_USE_ENV_PROXY: '1' }, 'NODE_USE_ENV_PROXY', '1'],
    ['NODE_USE_ENV_PROXY=', [], { NODE_USE_ENV_PROXY: '' }, 'NODE_USE_ENV_PROXY', ''],
    ['node --use-env-proxy', ['--use-env-proxy'], {}, '--use-env-proxy', ''],
    ['NODE_OPTIONS=--use-env-proxy', [], { NODE_OPTIONS: '--use-env-proxy' }, '--use-env-proxy', ''],
    ['node --use_env_proxy (TH1)', ['--use_env_proxy'], {}, '--use-env-proxy', ''],
    ['NODE_OPTIONS=--use-env-proxy=1 (TH1)', [], { NODE_OPTIONS: '--use-env-proxy=1' }, '--use-env-proxy', ''],
    ['NODE_TLS_REJECT_UNAUTHORIZED=0', [], { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, 'NODE_TLS_REJECT_UNAUTHORIZED', ''],
    ['NODE_EXTRA_CA_CERTS=/nonexistent', [], { NODE_EXTRA_CA_CERTS: `/nonexistent-${sentinel}` }, 'NODE_EXTRA_CA_CERTS', `/nonexistent-${sentinel}`],
  ] as Array<[string, string[], Record<string, string>, string, string]>)(
    '%s: our one line naming the key, exit 1, no answer to initialize, the value absent',
    async (_name, nodeArgs, env, key, value) => {
      assertFreshBuild();
      const r = await runEntry(['--import', fixture('report-start.mjs'), ...nodeArgs], env);
      expect(r.killed).toBe(false);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe('');
      expect(ours(r.stderr)).toEqual([`qbo-guard: start refused: ${key}`, 'report-start: no registration']);
      if (value !== '') expect(ours(r.stderr).join('\n')).not.toContain(value);
    },
  );

  // TI1: a config-file flag after the script name, where Node (24) still reads it; on a Node that doesn't, nothing to refuse.
  const CONFIG = path.join(ROOT, 'tests', 'fixtures', 'env-proxy.config.json');
  const configTurnsItOn =
    spawnSync(process.execPath, [`--experimental-config-file=${CONFIG}`, '-e', 'process.stdout.write(typeof require("https").globalAgent.options.proxyEnv)'], {
      encoding: 'utf8',
    }).stdout === 'object';
  (configTurnsItOn ? it : it.skip)('TI1: --experimental-config-file after the script name: our one line, exit 1, no registration', async () => {
    assertFreshBuild();
    const r = await runEntry(['--import', fixture('report-start.mjs')], {}, undefined, 15000, [`--experimental-config-file=${CONFIG}`]);
    expect(r.killed).toBe(false);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(ours(r.stderr)).toEqual(['qbo-guard: start refused: --use-env-proxy', 'report-start: no registration']);
  });

  it('a clean start: at the first registration every marker and the adapter are in place (A1.10(c))', async () => {
    assertFreshBuild();
    const r = await runEntry(['--import', fixture('report-start.mjs')], {}, '"id":1');
    expect(r.stdout).toContain('"id":1'); // it started and answered initialize
    const report = lines(r.stderr).filter((l) => l.startsWith('report-start:'));
    expect(report).toEqual([
      'report-start: https.request yes, https.get yes, http.request yes, http.get yes, http2.connect yes, fetch yes, WebSocket yes, adapter yes',
    ]);
  });

  it('https.request locked before start: exit 1, one line, no registration (A1.10(d))', async () => {
    assertFreshBuild();
    const r = await runEntry(['--import', fixture('lock-https.mjs'), '--import', fixture('report-start.mjs')], {});
    expect(r.killed).toBe(false);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(lines(r.stderr)).toEqual(['qbo-guard: install failed', 'report-start: no registration']);
  });
});
