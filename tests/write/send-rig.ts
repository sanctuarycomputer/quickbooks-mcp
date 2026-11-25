// Sanctuary Computer (quickbooks-mcp-293): write mode's guard with the real capability registry on a test clock, and the real pre-send
// check, over the stub network and the socket trap: for the registry's and the update send's tests. Its hooks are the importing file's.
import { beforeEach, afterEach, afterAll, expect, jest } from '@jest/globals';
import https from 'https';
import type { PassThrough } from 'stream';
import { trapNetwork } from '../fakes/no-network.js';
import { installStubNetwork, type StubAnswer, type StubCall } from '../fakes/stub-network.js';
import { stacksFake } from '../fakes/stacks-token.js';
import { fixtureToken, NOW, QBO_HOST, REALMS, testEnv } from '../helpers/server.js';
import { secureStart } from '../../src/http-guard.js';
import { currentCall, runInCall, setCallToken, type CallStore } from '../../src/clients/call-context.js';
import { loadConfig } from '../../src/clients/config.js';
import { createRuntime, type Runtime } from '../../src/clients/runtime.js';
import { createRegistry } from '../../src/write/capability.js';
import { decideWrite } from '../../src/write/guard-rules.js';
import { preSend, type CheckedRequest } from '../../src/write/pre-send.js';
import { asInput, byId, entityOf, fixture, type Json } from './derive.js';

export const COMPANY = 'garden3d';
export const OTHER = 'index-space';
/** On every fetched transaction, so a re-encoded body is not the same bytes. */
export const NOTE = 'café — 日本 🙂  ';
// 297's allowed calls.
export const P = (): Json => asInput('account-and-class').input;
export const B = (): Json => asInput('account-change').input;
export const UNDO = (): Json => ({ ...P(), mode: 'undo' });
export const DRY = (): Json => ({ company: COMPANY, entity: 'purchase', id: P().id, mode: 'dry' });

/** A wrapped request's own failure, in place of its answer: nothing after the limit, or an answer cut off in its body. */
export type Failing = 'timeout' | 'timeout in the body' | 'reset in the body' | undefined;

export function sendRig() {
  const trap = trapNetwork();
  const net = installStubNetwork((call) => (call.hostname === QBO_HOST ? (call.method === 'GET' ? book(call) : rig.answer(call)) : rig.stacks.handler(call)));
  const rig = {
    net,
    stacks: stacksFake(),
    /** The registry's clock, in ms. */
    clock: 0,
    registry: createRegistry(),
    books: {} as Record<string, Json>,
    /** An answer to every GET, in place of the books. */
    read: undefined as StubAnswer | undefined,
    /** QuickBooks' answer to a POST. */
    answer: ((): StubAnswer => ({ status: 200 })) as (call: StubCall) => StubAnswer | Promise<StubAnswer>,
    /** Each request write mode's rules were asked about, with the guard's context. */
    seen: [] as any[][],
    /** The timeout each POST's transport was given. */
    limits: [] as number[],
    failing: undefined as Failing,
    posts: (): StubCall[] => net.calls.filter((c) => c.method === 'POST'),
    /** Runs `fn` as a tool call that holds its company's fake token. */
    inCall: <T>(fn: (call: CallStore) => Promise<T>, company = COMPANY): Promise<T> =>
      runInCall(company, () => {
        setCallToken(fixtureToken(company), REALMS[company] ?? REALMS[COMPANY]);
        return fn(currentCall()!);
      }),
    /** The real check's request, its GETs forgotten. */
    check: async (input: Json = P()): Promise<CheckedRequest> => {
      const out = await rig.inCall(() => preSend(input as any), input.company);
      expect(out).toMatchObject({ ok: true });
      net.calls.length = 0;
      rig.seen.length = 0;
      return (out as any).checked;
    },
  };
  function book(call: StubCall): StubAnswer {
    if (rig.read !== undefined) return rig.read;
    const path = /^\/v3\/company\/[0-9]+\/(.*)\?minorversion=75$/.exec(call.path!)![1];
    return { status: 200, body: JSON.stringify(rig.books[path]) };
  }

  // Under the backstop's wrap, over the stub's request: each POST's limit, and its failure.
  const stubRequest = https.request as any;
  (https as any).request = (...args: unknown[]) => {
    const req = stubRequest(...args);
    if (net.calls.at(-1)!.method !== 'POST') return req;
    const { failing } = rig;
    let expire: () => void = () => undefined;
    req.setTimeout = (ms: number, onTimeout: () => void) => {
      rig.limits.push(ms);
      expire = onTimeout;
      return req;
    };
    if (failing === 'timeout') {
      req.end = (chunk: unknown) => (req.write(chunk), queueMicrotask(() => expire()), req);
    } else if (failing !== undefined) {
      req.prependListener('response', (res: PassThrough) => {
        (res as any).end = () => {
          res.write('{"Purchase":');
          if (failing === 'timeout in the body') expire();
          else res.emit('aborted');
        };
      });
    }
    return req;
  };

  let runtime: Runtime;
  let restoreStart: () => void;
  beforeEach(() => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    rig.stacks = stacksFake();
    rig.clock = 0;
    rig.registry = createRegistry({ now: () => rig.clock });
    rig.answer = () => ({ status: 200 });
    rig.seen = [];
    rig.limits = [];
    rig.failing = undefined;
    rig.read = undefined;
    rig.books = { preferences: fixture('preferences/book-close-date.json') };
    for (const [id, body] of byId('accounts')) rig.books[`account/${id}`] = body;
    for (const [id, body] of byId('classes')) rig.books[`class/${id}`] = body;
    for (const [path, file] of [['purchase/1001', 'purchase-1001'], ['bill/2001', 'bill-2001']]) {
      rig.books[path] = fixture(`fetched/${file}.json`);
      entityOf(rig.books[path]).PrivateNote = NOTE;
    }
    const extraRules = {
      decide(request: any, context: any) {
        rig.seen.push([request, context]);
        return decideWrite(request, context, { company: () => currentCall()?.company, registry: rig.registry });
      },
    };
    restoreStart = secureStart(testEnv() as NodeJS.ProcessEnv, [], { extraRules });
    runtime = createRuntime(loadConfig(testEnv()), { now: () => NOW });
    net.calls.length = 0;
  });
  afterEach(() => {
    runtime.close();
    restoreStart();
    jest.restoreAllMocks();
    expect(trap.reached).toEqual([]);
  });
  afterAll(() => {
    net.restore();
    trap.restore();
  });
  return rig;
}
