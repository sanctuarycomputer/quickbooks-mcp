// Sanctuary Computer (quickbooks-mcp-293): the write server started as the entry starts it (writeMode, 291's secureStart with its rules,
// then startWriteServer), over the socket trap and the stub network, with an in-memory MCP client. Its hooks are the importing file's.
// Changed by Sanctuary Computer (quickbooks-mcp-294): `start` takes the kit's deps and hands them to writeMode (or, with `production`, no
// deps anywhere: A3.5); the Stacks fake is the rig's to set; a request may be made to time out or reset (`fail`); `world` lays out one test's
// switch file, sweep stamp, fake receipt command and books in a temp directory the rig removes, pass or fail; and A3.4's token collector
// runs after each test: no known token in any result, logged receipt request or stderr line, and no Stacks token in a logged env.
import { afterAll, afterEach, beforeEach, expect, jest } from '@jest/globals';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import https from 'https';
import { tmpdir } from 'os';
import { join } from 'path';
import { trapNetwork } from '../fakes/no-network.js';
import { installStubNetwork, type StubAnswer, type StubCall } from '../fakes/stub-network.js';
import { stacksFake } from '../fakes/stacks-token.js';
import { companyInfos, fakePath, fixtureToken, NOW, QBO_HOST, REALMS, STACKS_KEY, testEnv } from '../helpers/server.js';
import { startWriteServer, type WriteTool } from '../../src/allowlist.js';
import { guardedAxios, secureStart } from '../../src/http-guard.js';
import { runInCall, setCallToken } from '../../src/clients/call-context.js';
import type { WriteRuntime } from '../../src/helpers/register-tool.js';
import type { WriteKit } from '../../src/write/kit.js';
import { writeMode, type WriteMode } from '../../src/write/mode.js';
import { byId, fixture, type Json } from './derive.js';
import { receiptFake, type FakeScript } from './receipt-fake.js';

/** The four keys, in contract §3's order, each with a value of its own. */
export const WRITE_KEYS: Record<string, string> = {
  QBO_WRITE_RECEIPT_CMD: 'node receipt.mjs',
  QBO_WRITE_SWITCH: '/nowhere/switch',
  QBO_WRITE_LEDGER: '/nowhere/writes.jsonl',
  QBO_WRITE_SWEEP_STAMP: '/nowhere/stamp',
};
export const writeEnv = (over: Record<string, string | undefined> = {}) => testEnv({ QBO_MODE: 'write', ...WRITE_KEYS, ...over });

/** The sweep-stamp/ fixtures' clock: clean.json is 10 minutes old at it. */
export const STAMP_NOW = Date.parse('2026-11-18T15:00:00.000Z');
/** NOTION_API_KEY in a world's env, built at runtime (no secret-shaped literal); A3.4 looks for it outside the env. */
export const NOTION_KEY = ['notion', 'test', 'key', 'value'].join('-');

/** Interceptors on the guarded instance: a runtime that is open holds two. */
export const interceptorCount = (): number => {
  const { request, response } = guardedAxios().interceptors as any;
  return [...request.handlers, ...response.handlers].filter((h: unknown) => h !== null).length;
};

export type WriteServer = { mode: WriteMode; runtime: WriteRuntime; client: Client };
/** A request's own failure in place of its answer: nothing within the transport's limit, or a reset connection. */
export type Failing = 'timeout' | 'reset' | undefined;
type ReceiptFake = ReturnType<typeof receiptFake>;
/** A GET's answer in the books: a body (200), or a whole answer. */
export type Book = Json | { answer: StubAnswer };

/** The path under the company's realm, without its query: `purchase/1001`, `companyinfo/<realm>`. */
export const qboPath = (call: StubCall): string => /^\/v3\/company\/[0-9]+\/([^?]*)/.exec(call.path ?? '')?.[1] ?? '';

export function writeRig() {
  const trap = trapNetwork();
  const net = installStubNetwork((call) => (call.hostname === QBO_HOST ? rig.answer(call) : rig.stacks.handler(call)));
  // Under the backstop's wrap, over the stub's request: a request made to time out fires its transport's limit at once; a reset fails it.
  const stubRequest = https.request as any;
  (https as any).request = (...args: unknown[]) => {
    const req = stubRequest(...args);
    const failing = rig.fail(net.calls.at(-1)!);
    if (failing === undefined) return req;
    let expire: () => void = () => undefined;
    req.setTimeout = (_ms: number, onTimeout: () => void) => ((expire = onTimeout), req);
    req.end = (chunk: unknown) => {
      if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') req.write(chunk);
      queueMicrotask(() => (failing === 'timeout' ? expire() : req.destroy(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))));
      return req;
    };
    return req;
  };
  const undo: Array<() => unknown> = [];
  const fakes: ReceiptFake[] = [];
  /** Each fake's log, kept as it is done, so the collector reads it whichever afterEach runs first. */
  const kept = new Map<ReceiptFake, ReturnType<ReceiptFake['log']>>();
  let stderr: ReturnType<typeof jest.spyOn> | undefined;
  const rig = {
    net,
    stacks: stacksFake(),
    answer: ((): StubAnswer => ({ status: 200 })) as (call: StubCall) => StubAnswer | Promise<StubAnswer>,
    fail: ((): Failing => undefined) as (call: StubCall) => Failing,
    /** Every result a started server's client got, for the collector. */
    results: [] as unknown[],
    /** Tokens a test adds to A3.4's known ones (a forced get's new token). */
    tokens: [] as string[],
    posts: (): StubCall[] => net.calls.filter((c) => c.method === 'POST'),
    /** QuickBooks requests, as `METHOD path` with the realm and query left out. */
    qbo: (): string[] => net.calls.filter((c) => c.hostname === QBO_HOST).map((c) => `${c.method} ${qboPath(c)}`),
    /** secureStart alone: read mode's when no rules are given. */
    secure(env: Record<string, string | undefined>, mode?: WriteMode): void {
      const restore = mode === undefined ? secureStart(env as NodeJS.ProcessEnv, []) : secureStart(env as NodeJS.ProcessEnv, [], { extraRules: mode.extraRules });
      undo.push(restore);
    },
    onStop(fn: () => unknown): void {
      undo.push(fn);
    },
    /** A fake receipt command the collector reads after the test. */
    receipt(script: FakeScript = {}): ReceiptFake {
      const fake = receiptFake(script);
      const done = fake.done;
      fake.done = () => {
        kept.set(fake, fake.log());
        done();
      };
      fakes.push(fake);
      return fake;
    },
    /**
     * Starts the write server. `kit` goes to writeMode (a `mode` given is used as it is); `production` passes no deps at all, to writeMode
     * or to startWriteServer, as src/index.ts does (A3.5).
     */
    async start(opts: { env?: Record<string, string | undefined>; tools?: readonly WriteTool[]; mode?: WriteMode; kit?: Partial<WriteKit>; production?: boolean } = {}): Promise<WriteServer> {
      const env = opts.env ?? writeEnv();
      const mode = opts.mode ?? (opts.production === true ? writeMode() : writeMode(opts.kit));
      rig.secure(env, mode);
      const server = new McpServer({ name: 'write-rig', version: '0.0.0' }, { capabilities: { tools: {} } });
      const tools = opts.tools ?? mode.tools;
      const runtime = opts.production === true ? startWriteServer(env, server, tools) : startWriteServer(env, server, tools, { now: () => NOW });
      rig.onStop(() => runtime.close());
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: 'write-rig-client', version: '0.0.0' });
      await client.connect(clientSide);
      const callTool = client.callTool.bind(client);
      client.callTool = (async (...args: Parameters<Client['callTool']>) => {
        const result = await callTool(...args);
        rig.results.push(result);
        return result;
      }) as Client['callTool'];
      rig.onStop(async () => {
        await client.close();
        await server.close();
      });
      return { mode, runtime, client };
    },
    async stop(): Promise<void> {
      while (undo.length > 0) await undo.pop()!();
    },
    /** Runs `fn` as a tool call that holds its company's fake token. */
    inCall: <T>(fn: () => Promise<T>, company = 'garden3d'): Promise<T> =>
      runInCall(company, () => {
        setCallToken(fixtureToken(company), REALMS[company]);
        return fn();
      }),
  };
  /** A3.4: the known tokens appear in no result, receipt request or stderr line; the Stacks ones in no logged env either. */
  function collect(): void {
    const stacksTokens = [...Object.keys(REALMS).map(fixtureToken), STACKS_KEY, ...rig.tokens];
    const all = [...stacksTokens, NOTION_KEY];
    const logged = fakes.flatMap((fake) => [...(kept.get(fake) ?? []), ...fake.log()]);
    const texts: Array<[string, string]> = [
      ...rig.results.map((r): [string, string] => ['result', JSON.stringify(r)]),
      ...logged.map((l): [string, string] => ['request', JSON.stringify(l.request)]),
      ...(stderr?.mock.calls ?? []).map((c: unknown[]): [string, string] => ['stderr', String(c[0])]),
    ];
    const leaks = texts.flatMap(([where, text]) => all.filter((token) => text.includes(token)).map((token) => `${where} holds ${token}`));
    for (const { env } of logged) for (const token of stacksTokens) if (JSON.stringify(env).includes(token)) leaks.push(`env holds ${token}`);
    expect(leaks).toEqual([]);
  }
  beforeEach(() => {
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    rig.answer = () => ({ status: 200 });
    rig.fail = () => undefined;
    rig.stacks = stacksFake();
    rig.results = [];
    rig.tokens = [];
    fakes.length = 0;
    kept.clear();
    net.calls.length = 0;
  });
  afterEach(async () => {
    try {
      collect();
    } finally {
      await rig.stop();
      jest.restoreAllMocks();
    }
    expect(trap.reached).toEqual([]);
  });
  afterAll(() => {
    (https as any).request = stubRequest;
    net.restore();
    trap.restore();
  });
  return rig;
}

export type Rig = ReturnType<typeof writeRig>;

/**
 * One test's write world: a temp directory (removed by the rig after the test, pass or fail) holding the switch file and a copy of
 * sweep-stamp/clean.json; a fake receipt command with `script`; the books every GET is answered from (297's purchase 1001, bill 2001,
 * preferences, accounts and classes, and each company's companyinfo); `post` answers the update. `start` starts the server on the
 * world's env with the wall clock at the stamps' 15:00:00.000Z.
 */
export function world(rig: Rig, script: FakeScript = {}, opts: { switchOn?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qbo-write-world-'));
  rig.onStop(() => rmSync(dir, { recursive: true, force: true }));
  const switchPath = join(dir, 'write-enabled');
  const stampPath = join(dir, 'job-sweep.json');
  if (opts.switchOn !== false) writeFileSync(switchPath, '');
  copyFileSync(fakePath('sweep-stamp/clean.json'), stampPath);
  const fake = rig.receipt(script);
  const books: Record<string, Book> = { preferences: fixture('preferences/book-close-date.json'), 'purchase/1001': fixture('fetched/purchase-1001.json'), 'bill/2001': fixture('fetched/bill-2001.json') };
  for (const [id, body] of byId('accounts')) books[`account/${id}`] = body;
  for (const [id, body] of byId('classes')) books[`class/${id}`] = body;
  for (const [realm, info] of Object.entries(companyInfos())) books[`companyinfo/${realm}`] = { CompanyInfo: info, time: '2026-11-18T00:00:00.000Z' };
  const w = {
    dir,
    switchPath,
    stampPath,
    fake,
    books,
    env: writeEnv({ QBO_WRITE_RECEIPT_CMD: fake.cmd, QBO_WRITE_SWITCH: switchPath, QBO_WRITE_LEDGER: join(dir, 'writes.jsonl'), QBO_WRITE_SWEEP_STAMP: stampPath, NOTION_API_KEY: NOTION_KEY }),
    /** QuickBooks' answer to each POST; a 200 `{}` unless set. */
    post: ((): StubAnswer => ({ status: 200 })) as (call: StubCall, n: number) => StubAnswer | Promise<StubAnswer>,
    /** Run before a GET is answered from the books (a test's hook: delete the switch, move a clock). */
    onGet: ((): void => undefined) as (path: string, call: StubCall) => void,
    start: (kit: Partial<WriteKit> = {}, more: { tools?: readonly WriteTool[]; mode?: WriteMode } = {}) => rig.start({ env: w.env, kit: { wall: () => STAMP_NOW, ...kit }, ...more }),
  };
  let posts = 0;
  rig.answer = (call) => {
    if (call.method === 'POST') return w.post(call, posts++);
    const path = qboPath(call);
    w.onGet(path, call);
    const book = books[path];
    if (book === undefined) return { status: 404, body: JSON.stringify(fixture('faults/get-missing.json')) };
    return 'answer' in book ? (book.answer as StubAnswer) : { status: 200, body: JSON.stringify(book) };
  };
  return w;
}
export type World = ReturnType<typeof world>;

/** A stored answer's whole stub answer, from a transactions/answers/ file (its body as JSON text), with headers. */
export const stubOf = (file: Json, headers: Record<string, string> = {}): StubAnswer => ({
  status: file.status,
  headers,
  body: typeof file.body === 'string' ? file.body : JSON.stringify(file.body),
});
