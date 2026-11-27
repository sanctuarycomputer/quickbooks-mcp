// Sanctuary Computer (quickbooks-mcp-294): spec A1.2, the receipt command's process (contract §20): split on single spaces, no shell, an
// environment built from the write config alone, one JSON object out with exit 0, killed (SIGKILL) at 20 s or past 1 MiB of stdout.
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PassThrough } from 'stream';
import type { WriteConfig } from '../../src/clients/config.js';
import { RECEIPT_MAX_BYTES, RECEIPT_TIMEOUT_MS, runReceipt, type Spawn } from '../../src/write/receipt-cmd.js';
import { FAKE_PATH, receiptFake, type FakeScript } from './receipt-fake.js';

const FAILED = { ok: false, reason: 'failed', cause: 'command' };
const LINUX = process.platform !== 'win32';
const PING = { cmd: 'ping' };

type Fake = ReturnType<typeof receiptFake>;
const fakes: Fake[] = [];
const make = (script: FakeScript): Fake => {
  const fake = receiptFake(script);
  fakes.push(fake);
  return fake;
};
afterEach(() => {
  while (fakes.length > 0) fakes.pop()!.done();
  jest.useRealTimers();
});

/** A write config as loadWriteConfig makes it; only the fields runReceipt reads matter. */
const cfg = (receiptCmd: string, over: Partial<Record<'notionApiKey' | 'tz' | 'path', string>> = {}): WriteConfig =>
  ({ mode: 'write', receiptCmd, writeLedger: '/ledger/writes.jsonl', writeSwitch: '/s', sweepStamp: '/t', ...over }) as unknown as WriteConfig;
const ALL = { notionApiKey: 'notion-value', tz: 'America/New_York', path: process.env.PATH ?? '/usr/bin' };

describe('the child’s environment, from the config alone', () => {
  const FORBIDDEN = ['STACKS_QBO_TOKEN', 'QBO_COMPANIES', 'HOME'];
  const before = { ...process.env };
  afterEach(() => {
    for (const k of FORBIDDEN) if (before[k] === undefined) delete process.env[k];
    Object.assign(process.env, before);
  });
  const setForbidden = () => {
    process.env.STACKS_QBO_TOKEN = 'stacks-token-value';
    process.env.QBO_COMPANIES = 'garden3d=1';
    process.env.HOME = '/home/someone';
  };

  (LINUX ? it : it.skip)('linux only (exact list): all three set gives exactly the four keys', async () => {
    setForbidden();
    const fake = make({ ping: [{ answer: { ok: true } }] });
    expect(await runReceipt(cfg(fake.cmd, ALL), PING, { spawn })).toEqual({ ok: true });
    expect(fake.log()[0].env).toEqual({ NOTION_API_KEY: 'notion-value', QBO_WRITE_LEDGER: '/ledger/writes.jsonl', PATH: ALL.path, TZ: 'America/New_York' });
  });

  (LINUX ? it : it.skip)('linux only (exact list): NOTION_API_KEY and TZ unset gives exactly QBO_WRITE_LEDGER and PATH', async () => {
    setForbidden();
    const fake = make({ ping: [{ answer: { ok: true } }] });
    await runReceipt(cfg(fake.cmd, { path: ALL.path }), PING, { spawn });
    expect(fake.log()[0].env).toEqual({ QBO_WRITE_LEDGER: '/ledger/writes.jsonl', PATH: ALL.path });
  });

  (LINUX ? it : it.skip)('linux only (no PATH): an unset PATH leaves no PATH key, and the absolute command still runs', async () => {
    const fake = make({ ping: [{ answer: { ok: true } }] });
    expect(await runReceipt(cfg(fake.cmd), PING, { spawn })).toEqual({ ok: true });
    expect(fake.log()[0].env).toEqual({ QBO_WRITE_LEDGER: '/ledger/writes.jsonl' });
  });

  it('every platform: the named keys hold the config’s values, and no forbidden key is passed', async () => {
    setForbidden();
    const fake = make({ ping: [{ answer: { ok: true } }, { answer: { ok: true } }] });
    await runReceipt(cfg(fake.cmd, ALL), PING, { spawn });
    // The rig's default: no PATH, no NOTION_API_KEY, no TZ (covers the unset arms on win32 too, plan-4 W2).
    await runReceipt(cfg(fake.cmd), PING, { spawn });
    const [full, bare] = fake.log().map((entry) => entry.env);
    expect(full).toMatchObject({ NOTION_API_KEY: 'notion-value', QBO_WRITE_LEDGER: '/ledger/writes.jsonl', TZ: 'America/New_York' });
    expect(bare.QBO_WRITE_LEDGER).toBe('/ledger/writes.jsonl');
    for (const env of [full, bare]) for (const k of FORBIDDEN) expect(Object.keys(env).map((key) => key.toUpperCase())).not.toContain(k);
    for (const k of ['NOTION_API_KEY', 'TZ']) expect(Object.prototype.hasOwnProperty.call(bare, k)).toBe(false);
  });

  it('passes exactly what the config holds, to spawn, with no shell', async () => {
    const seen: unknown[] = [];
    const spy = ((file: string, args: string[], options: object) => {
      seen.push({ file, args, options });
      return spawn(file, args, options as never);
    }) as unknown as Spawn;
    const fake = make({ ping: [{ answer: { ok: true } }] });
    await runReceipt(cfg(fake.cmd, ALL), PING, { spawn: spy });
    expect(seen).toEqual([
      {
        file: fake.argv[0],
        args: fake.argv.slice(1),
        options: { shell: false, stdio: 'pipe', env: { NOTION_API_KEY: 'notion-value', QBO_WRITE_LEDGER: '/ledger/writes.jsonl', PATH: ALL.path, TZ: 'America/New_York' } },
      },
    ]);
  });
});

describe('the command line', () => {
  it('splits on single spaces and runs no shell: an argument holding `;echo` reaches the command as one', async () => {
    const fake = make({ ping: [{ answer: { ok: true, via: 'fake' } }] });
    const odd = join(fake.dir, 'a;echo');
    mkdirSync(odd);
    const script = join(odd, 'script.json');
    writeFileSync(script, JSON.stringify({ log: join(fake.dir, 'log.jsonl'), answers: { ping: [{ answer: { ok: true, via: 'fake' } }] } }));
    expect(await runReceipt(cfg(`${process.execPath} ${FAKE_PATH} ${script}`), PING, { spawn })).toEqual({ ok: true, via: 'fake' });
    expect(fake.requests()).toEqual([PING]);
    rmSync(odd, { recursive: true, force: true });
  });

  it('writes the request as one JSON text on stdin', async () => {
    const request = { cmd: 'lookup', key: 'quickbooks-write:garden3d:purchase:1001:3:1' };
    const look = make({ lookup: [{ answer: { ok: true } }] });
    await runReceipt(cfg(look.cmd), request, { spawn });
    expect(look.requests()).toEqual([request]);
  });

  it('splits on single spaces: two together give an empty argument (task-3-1 TD4)', async () => {
    const { calls, spawn: s, child } = spied();
    const got = runReceipt(cfg('/bin/cmd  a b'), PING, { spawn: s });
    child.stdout.end('{"ok":true}');
    await tick();
    child.emit('close', 0);
    await got;
    expect(calls.map((c) => [c.file, c.args])).toEqual([['/bin/cmd', ['', 'a', 'b']]]);
  });

  it('passes an empty NOTION_API_KEY, TZ and PATH as empty, not dropped (task-3-1 TD5)', async () => {
    const { calls, spawn: s, child } = spied();
    const got = runReceipt(cfg('x', { notionApiKey: '', tz: '', path: '' }), PING, { spawn: s });
    child.stdout.end('{"ok":true}');
    await tick();
    child.emit('close', 0);
    await got;
    expect(calls[0].options.env).toEqual({ NOTION_API_KEY: '', QBO_WRITE_LEDGER: '/ledger/writes.jsonl', PATH: '', TZ: '' });
  });

  it('a request JSON can’t hold (a BigInt, a cycle): not ok, and nothing spawned (task-3-1 TD8)', async () => {
    const { calls, spawn: s } = spied();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(await runReceipt(cfg('x'), { n: BigInt(1) }, { spawn: s })).toEqual(FAILED);
    expect(await runReceipt(cfg('x'), cycle, { spawn: s })).toEqual(FAILED);
    expect(calls).toEqual([]);
  });
});

describe('answers', () => {
  it('an object answer with exit 0, whitespace around it allowed', async () => {
    const fake = make({ ping: [{ misbehave: 'raw', text: '  {"ok":true,"n":1}\n\n' }] });
    expect(await runReceipt(cfg(fake.cmd), PING, { spawn })).toEqual({ ok: true, n: 1 });
  });

  it.each<[string, FakeScript]>([
    ['exit 1', { ping: [{ misbehave: 'exit 1' }] }],
    ['no JSON', { ping: [{ misbehave: 'no-json' }] }],
    ['two JSON objects', { ping: [{ misbehave: 'two-json' }] }],
    ['an ok answer, then exit 2', { ping: [{ misbehave: 'ok-then-exit 2', value: { ok: true } }] }],
    ['JSON that is an array', { ping: [{ misbehave: 'raw', text: '[]' }] }],
    ['JSON that is a string', { ping: [{ misbehave: 'raw', text: '"ok"' }] }],
    ['JSON that is null', { ping: [{ misbehave: 'raw', text: 'null' }] }],
    ['nothing at all', { ping: [{ misbehave: 'raw', text: '' }] }],
    ['an exit before reading stdin', { '*': [{ misbehave: 'close-stdin' }] }],
    ['stdout over 1 MiB', { ping: [{ misbehave: `big ${RECEIPT_MAX_BYTES + 1}` }] }],
  ])('%s: not ok', async (_name, script) => {
    const fake = make(script);
    expect(await runReceipt(cfg(fake.cmd), PING, { spawn })).toEqual(FAILED);
  });

  it('a large answer just under the cap is read whole, through the real pipe (the edge itself is the driven case’s)', async () => {
    const fake = make({ ping: [{ misbehave: 'raw', text: JSON.stringify({ ok: true, pad: 'x'.repeat(RECEIPT_MAX_BYTES - 22) }) }] });
    const got = (await runReceipt(cfg(fake.cmd), PING, { spawn })) as { ok: boolean; pad: string };
    expect([got.ok, got.pad.length]).toEqual([true, RECEIPT_MAX_BYTES - 22]);
  });

  it('a command that doesn’t exist (ENOENT): not ok', async () => {
    expect(await runReceipt(cfg(join('/', 'nowhere-294', 'receipt')), PING, { spawn })).toEqual(FAILED);
  });

  it('a spawn that throws: not ok', async () => {
    const thrower = (() => {
      throw new Error('spawn failed');
    }) as unknown as Spawn;
    expect(await runReceipt(cfg('x'), PING, { spawn: thrower })).toEqual(FAILED);
  });

  it('a timeout given: the slow command is killed and not ok', async () => {
    const fake = make({ ping: [{ misbehave: 'sleep 5000' }] });
    expect(await runReceipt(cfg(fake.cmd), PING, { spawn, timeoutMs: 100 })).toEqual(FAILED);
  });
});

/** A child the test drives: streams it can write, the signals it was sent, and the request it was given. */
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    signals: [] as string[],
    kill(signal: string) {
      child.signals.push(signal);
      return true;
    },
  });
  return child;
}
const tick = () => new Promise((r) => setImmediate(r));
const driven = () => {
  const child = fakeChild();
  return { child, spawn: (() => child) as unknown as Spawn };
};
/** A driven child, and each spawn call's file, arguments and options. */
const spied = () => {
  const child = fakeChild();
  const calls: Array<{ file: string; args: string[]; options: { env: Record<string, string> } }> = [];
  const s = ((file: string, args: string[], options: { env: Record<string, string> }) => {
    calls.push({ file, args, options });
    return child;
  }) as unknown as Spawn;
  return { child, calls, spawn: s };
};

describe('the kills and the defaults, through a driven child', () => {
  it('the constants', () => {
    expect([RECEIPT_TIMEOUT_MS, RECEIPT_MAX_BYTES]).toEqual([20000, 1048576]);
  });

  it('no timeout given: not killed at 19 999 ms, killed with SIGKILL at 20 000 ms, and not ok', async () => {
    jest.useFakeTimers();
    const { child, spawn: s } = driven();
    let done: unknown = 'pending';
    void runReceipt(cfg('x'), PING, { spawn: s }).then((v) => (done = v));
    await jest.advanceTimersByTimeAsync(19999);
    expect([child.signals, done]).toEqual([[], 'pending']);
    await jest.advanceTimersByTimeAsync(1);
    expect([child.signals, done]).toEqual([['SIGKILL'], FAILED]);
  });

  it('a finished run leaves no timer behind (task-3-1 TD3)', async () => {
    jest.useFakeTimers();
    const { child, spawn: s } = driven();
    const got = runReceipt(cfg('x'), PING, { spawn: s });
    expect(jest.getTimerCount()).toBe(1);
    child.stdout.end('{"ok":true}');
    await jest.advanceTimersByTimeAsync(0);
    child.emit('close', 0);
    expect(await got).toEqual({ ok: true });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('no byte cap given: 1 048 576 bytes are read, the next one kills with SIGKILL', async () => {
    const { child, spawn: s } = driven();
    const got = runReceipt(cfg('x'), PING, { spawn: s });
    child.stdout.write(Buffer.alloc(RECEIPT_MAX_BYTES, 0x20));
    await new Promise((r) => setImmediate(r));
    expect(child.signals).toEqual([]);
    child.stdout.write(Buffer.from(' '));
    expect(await got).toEqual(FAILED);
    expect(child.signals).toEqual(['SIGKILL']);
  });

  it('a stdin error (EPIPE, the command gone before reading) is ignored: the answer decides', async () => {
    const { child, spawn: s } = driven();
    const got = runReceipt(cfg('x'), PING, { spawn: s });
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    child.stdout.end('{"ok":true}');
    await tick();
    child.emit('close', 0);
    expect(await got).toEqual({ ok: true });
  });

  it('a stdin error and a non-zero exit: not ok', async () => {
    const { child, spawn: s } = driven();
    const got = runReceipt(cfg('x'), PING, { spawn: s });
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    await tick();
    child.emit('close', 1);
    expect(await got).toEqual(FAILED);
  });

  it('stderr is read (flowing), so a chatty command never blocks on a full pipe (task-3-1 TD1)', async () => {
    const { child, spawn: s } = driven();
    const got = runReceipt(cfg('x'), PING, { spawn: s });
    expect(child.stderr.readableFlowing).toBe(true);
    child.stdout.end('{"ok":true}');
    await tick();
    child.emit('close', 0);
    expect(await got).toEqual({ ok: true });
  });

  it('stderr is drained and dropped, never part of the answer', async () => {
    const { child, spawn: s } = driven();
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const got = runReceipt(cfg('x'), PING, { spawn: s });
    child.stderr.end('secret-ish text');
    child.stdout.end('{"ok":true}');
    await tick();
    child.emit('close', 0);
    expect(await got).toEqual({ ok: true });
    expect(write).not.toHaveBeenCalled();
  });

  it('a child error event: not ok, once', async () => {
    const { child, spawn: s } = driven();
    const got = runReceipt(cfg('x'), PING, { spawn: s });
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await tick();
    child.emit('close', -2);
    expect(await got).toEqual(FAILED);
  });

  it('the request reaches stdin whole, and stdin is closed', async () => {
    const { child, spawn: s } = driven();
    let text = '';
    child.stdin.on('data', (c) => (text += c));
    const ended = new Promise((r) => child.stdin.on('end', r));
    const got = runReceipt(cfg('x'), { cmd: 'pending', company: 'garden3d' }, { spawn: s });
    await ended;
    child.stdout.end('{"ok":true}');
    await tick();
    child.emit('close', 0);
    await got;
    expect(text).toBe('{"cmd":"pending","company":"garden3d"}');
  });
});
