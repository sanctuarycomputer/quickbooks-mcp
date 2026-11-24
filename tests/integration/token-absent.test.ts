// Sanctuary Computer (quickbooks-mcp-286): the known token and key absent everywhere (spec A5.7; carried TC6-1, TB6).
// Every row of scenarios.ts runs through the started server with every printing console method (each call's text as
// Node's console prints it, and each object argument inspected in full: T13-1), process.stdout.write and
// process.stderr.write captured; neither the tokens Stacks handed out nor STACKS_QBO_TOKEN appears, as a substring, in
// any result item, any thrown message or any captured line. Each row's result is also read by the whole Result grammar
// and must give the row's reason, and what reached the wire must be the row's (the Stacks requests, each QuickBooks
// request's bearer: T13-7), so every path is really taken.
import { describe, it, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import { captureConsole, PRINTING } from '../helpers/console-capture.js';
import { readError } from '../helpers/result-grammar.js';
import type { StubCall } from '../fakes/stub-network.js';
import { QBO_HOST, installNetwork, startServer, testEnv, type Rig } from '../helpers/server.js';
import { KEY, SCENARIOS, SECRETS, TOKEN, TOKEN_2, type Scenario } from './scenarios.js';

const network = installNetwork();
const { net } = network;

let captured: string[] = [];
let rig: Rig | undefined;

beforeEach(() => {
  captured = [];
  // In beforeEach: jest.config's restoreMocks restores every spy before each test.
  captureConsole(captured);
  for (const s of ['stdout', 'stderr'] as const) {
    jest.spyOn(process[s], 'write').mockImplementation(((chunk: unknown) => {
      captured.push(`${s}: ${String(chunk)}`);
      return true;
    }) as never);
  }
});
afterEach(async () => {
  jest.useRealTimers();
  await rig?.close();
  rig = undefined;
  net.calls.length = 0;
});
afterAll(() => {
  expect(network.trap.reached).toEqual([]);
  network.restore();
});

/** A request header by name, whatever its case on the wire. */
const header = (c: StubCall, name: string) => Object.entries(c.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];

/** Each secret found as a substring of each text, as `<where>: <which>`. */
function leaks(texts: Array<[string, string]>): string[] {
  const names = new Map([
    [TOKEN, 'the token'],
    [TOKEN_2, 'the refetched token'],
    [KEY, 'the key'],
  ]);
  return texts.flatMap(([where, text]) => SECRETS.filter((s) => text.includes(s)).map((s) => `${where}: ${names.get(s)}`));
}

/** Runs one row through a fresh server; gives the result (or the thrown message) and every text to scan. */
async function replay(row: Scenario): Promise<{ result: unknown; texts: Array<[string, string]> }> {
  let n = 0;
  rig = await startServer({
    env: testEnv({ STACKS_QBO_TOKEN: KEY }),
    stacks: row.stacks,
    tools: row.tools ? await row.tools() : undefined,
    route: (call) => (call.hostname === QBO_HOST && row.qbo ? row.qbo(n++, call) : undefined),
  });
  if (row.advance !== undefined) jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  const texts: Array<[string, string]> = [];
  let result: unknown;
  try {
    const p = rig.client.callTool({ name: row.tool, arguments: { company: 'garden3d', params: row.params ?? {} } });
    if (row.advance !== undefined) await jest.advanceTimersByTimeAsync(row.advance);
    result = await p;
    ((result as { content?: Array<{ text?: unknown }> }).content ?? []).forEach((c, i) => texts.push([`result item ${i}`, String(c.text)]));
    texts.push(['the whole result', JSON.stringify(result)]);
  } catch (e) {
    texts.push(['a thrown message', `${(e as Error).message} ${(e as Error).stack ?? ''}`]);
  }
  captured.forEach((line, i) => texts.push([`captured line ${i}`, line]));
  return { result, texts };
}

describe('A5.7: the known token and key are absent from every result, thrown message and captured line', () => {
  it('the table covers success, each reason, each resend, a guard refusal and the echoing answers', () => {
    const reasons = new Set(SCENARIOS.map((s) => s.reason.replace(/:.*/, ':')));
    for (const r of ['ok', 'name-mismatch', 'not-connected', 'unknown-enterprise', 'renewal-failed:', 'stacks-auth', 'stacks-unreachable', 'fork-error', 'timeout', 'http-500', 'http-400', 'http-401']) {
      expect([r, reasons.has(r)]).toEqual([r, true]);
    }
    expect(SCENARIOS.filter((s) => /resend|guard refusal|echo|holds the token/.test(s.name)).length).toBeGreaterThanOrEqual(10);
  });

  it.each(SCENARIOS.map((s) => [s.name, s] as const))('%s', async (_name, row) => {
    const { result, texts } = await replay(row);
    if (row.reason === 'ok') expect((result as { isError?: unknown }).isError).toBeUndefined();
    else expect(readError(result).reason).toBe(row.reason);
    // The server did hand the secrets out, on the row's path: the key on each Stacks request, and each QuickBooks
    // request's bearer the token Stacks had handed out by then.
    const toStacks = net.calls.filter((c) => c.hostname !== QBO_HOST);
    const toQbo = net.calls.filter((c) => c.hostname === QBO_HOST);
    expect(toStacks.map((c) => header(c, 'x-api-key'))).toEqual(Array(row.sent.stacks).fill(KEY));
    expect(toQbo.map((c) => header(c, 'authorization'))).toEqual(row.sent.bearers.map((t) => `Bearer ${t}`));
    expect(leaks(texts)).toEqual([]);
  });

  // T13-1: the capture holds what the console prints, so each form a logged secret can take is found.
  it.each([
    ['an object argument', () => console.log('state', { company: 'garden3d', token: TOKEN })],
    ['an Error with the token in a nested property, below util.format\'s depth', () => console.error(Object.assign(new Error('Request failed with status code 400'), { config: { headers: { common: { Authorization: `Bearer ${TOKEN}` } } } }))],
    ['a %o format string', () => console.warn('sent %o', { headers: { Authorization: `Bearer ${TOKEN}` } })],
    ['a %s format string with an object', () => console.info('sent %s', { a: { b: { c: TOKEN } } })],
    ['console.dir', () => console.dir({ a: { b: { c: { d: TOKEN } } } })],
    ['console.table', () => console.table([{ token: TOKEN }])],
    ['console.assert', () => console.assert(false, { token: TOKEN })],
    ['console.group', () => console.group({ token: TOKEN })],
  ])('the capture finds the token logged as %s', (_name, log) => {
    log();
    expect(leaks(captured.map((l, i) => [`captured line ${i}`, l]))).toEqual(['captured line 0: the token']);
  });

  it('every console method that prints is captured', () => {
    for (const m of PRINTING) expect([m, jest.isMockFunction(console[m])]).toEqual([m, true]);
  });

  it('the scan finds a secret inside a longer value, in any text it is given', () => {
    expect(leaks([['a', `tid-${TOKEN}-x`], ['b', 'clean'], ['c', `${KEY}${TOKEN_2}`]])).toEqual(['a: the token', 'c: the refetched token', 'c: the key']);
  });
});
