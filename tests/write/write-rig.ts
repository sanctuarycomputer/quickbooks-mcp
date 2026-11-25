// Sanctuary Computer (quickbooks-mcp-293): the write server started as the entry starts it (writeMode, 291's secureStart with its rules,
// then startWriteServer), over the socket trap and the stub network, with an in-memory MCP client. Its hooks are the importing file's.
import { afterAll, afterEach, beforeEach, expect, jest } from '@jest/globals';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { trapNetwork } from '../fakes/no-network.js';
import { installStubNetwork, type StubAnswer, type StubCall } from '../fakes/stub-network.js';
import { stacksFake } from '../fakes/stacks-token.js';
import { fixtureToken, NOW, QBO_HOST, REALMS, testEnv } from '../helpers/server.js';
import { startWriteServer, type WriteTool } from '../../src/allowlist.js';
import { guardedAxios, secureStart } from '../../src/http-guard.js';
import { runInCall, setCallToken } from '../../src/clients/call-context.js';
import type { WriteRuntime } from '../../src/helpers/register-tool.js';
import { writeMode, type WriteMode } from '../../src/write/mode.js';

/** The four keys, in contract §3's order, each with a value of its own. */
export const WRITE_KEYS: Record<string, string> = {
  QBO_WRITE_RECEIPT_CMD: 'node receipt.mjs',
  QBO_WRITE_SWITCH: '/nowhere/switch',
  QBO_WRITE_LEDGER: '/nowhere/writes.jsonl',
  QBO_WRITE_SWEEP_STAMP: '/nowhere/stamp',
};
export const writeEnv = (over: Record<string, string | undefined> = {}) => testEnv({ QBO_MODE: 'write', ...WRITE_KEYS, ...over });

/** Interceptors on the guarded instance: a runtime that is open holds two. */
export const interceptorCount = (): number => {
  const { request, response } = guardedAxios().interceptors as any;
  return [...request.handlers, ...response.handlers].filter((h: unknown) => h !== null).length;
};

export type WriteServer = { mode: WriteMode; runtime: WriteRuntime; client: Client };

export function writeRig() {
  const trap = trapNetwork();
  const net = installStubNetwork((call) => (call.hostname === QBO_HOST ? rig.answer(call) : stacksFake().handler(call)));
  const undo: Array<() => unknown> = [];
  const rig = {
    net,
    answer: ((): StubAnswer => ({ status: 200 })) as (call: StubCall) => StubAnswer,
    posts: (): StubCall[] => net.calls.filter((c) => c.method === 'POST'),
    /** secureStart alone: read mode's when no rules are given. */
    secure(env: Record<string, string | undefined>, mode?: WriteMode): void {
      const restore = mode === undefined ? secureStart(env as NodeJS.ProcessEnv, []) : secureStart(env as NodeJS.ProcessEnv, [], { extraRules: mode.extraRules });
      undo.push(restore);
    },
    onStop(fn: () => unknown): void {
      undo.push(fn);
    },
    async start(opts: { env?: Record<string, string | undefined>; tools?: readonly WriteTool[]; mode?: WriteMode } = {}): Promise<WriteServer> {
      const env = opts.env ?? writeEnv();
      const mode = opts.mode ?? writeMode();
      rig.secure(env, mode);
      const server = new McpServer({ name: 'write-rig', version: '0.0.0' }, { capabilities: { tools: {} } });
      const runtime = startWriteServer(env, server, opts.tools ?? mode.tools, { now: () => NOW });
      rig.onStop(() => runtime.close());
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: 'write-rig-client', version: '0.0.0' });
      await client.connect(clientSide);
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
  beforeEach(() => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    rig.answer = () => ({ status: 200 });
    net.calls.length = 0;
  });
  afterEach(async () => {
    await rig.stop();
    jest.restoreAllMocks();
    expect(trap.reached).toEqual([]);
  });
  afterAll(() => {
    net.restore();
    trap.restore();
  });
  return rig;
}
