// Sanctuary Computer (quickbooks-mcp-293): the update send (A3.1, A3.3, A3.5, A3.7, SB7), through the real adapter, backstop, 286's
// interceptors, write mode's rules and the real registry, on checked requests the real pre-send check made.
import { describe, it, expect } from '@jest/globals';
import { fixtureToken, QBO_HOST, REALMS } from '../helpers/server.js';
import { guardedAxios } from '../../src/http-guard.js';
import { currentCall, runInCall, setCallToken } from '../../src/clients/call-context.js';
import { QBO_LIMIT_MS } from '../../src/clients/qbo-transport.js';
import { sha256Hex } from '../../src/write/canonical.js';
import { fetchById, fetchPreferences, sendUpdate, updateUrl } from '../../src/write/client.js';
import { decideDry } from '../../src/write/guard-rules.js';
import type { CheckedRequest } from '../../src/write/pre-send.js';
import { B, COMPANY, DRY, NOTE, OTHER, P, sendRig, UNDO, type Failing } from './send-rig.js';
import { type Json } from './derive.js';

const rig = sendRig();
const ax = guardedAxios();
const REFUSED = { name: 'GuardRefusedError', rule: 'write-update' };

/** A checked request, registered. */
async function registered(input: Json = P()): Promise<CheckedRequest> {
  const checked = await rig.check(input);
  rig.registry.register(checked);
  return checked;
}
const send = (checked: CheckedRequest, company = COMPANY) => rig.inCall(() => sendUpdate(checked), company);
const holds = (checked: CheckedRequest): boolean => rig.registry.has(checked.company, checked.entity, sha256Hex(checked.bodyText));

describe('A3.1: the allowed update', () => {
  it.each([['purchase', P], ['bill', B], ['an undone purchase', UNDO]] as const)('%s reaches the stub once, its capability consumed before it leaves', async (_name, input) => {
    const checked = await registered(input());
    const sizes: number[] = [];
    rig.answer = () => (sizes.push(rig.registry.size), { status: 200, body: '{"Purchase":{"Id":"1001"}}' });
    expect(await send(checked)).toEqual({ status: 200, data: { Purchase: { Id: '1001' } } });
    expect(sizes).toEqual([0]);
    expect([rig.net.calls.length, rig.seen.length]).toEqual([1, 1]);
    expect(rig.net.calls[0]).toMatchObject({ module: 'https', method: 'POST', hostname: QBO_HOST, path: `/v3/company/${REALMS[COMPANY]}/${input().entity}?operation=update&minorversion=75`, body: checked.bodyText });
  });

  it('A3.7: the exact bytes, the three headers alone, and the limit on the transport', async () => {
    const checked = await registered();
    expect(checked.bodyText).toContain(NOTE);
    await send(checked);
    const [call] = rig.posts();
    expect(Buffer.from(call.body, 'utf8').equals(Buffer.from(checked.bodyText, 'utf8'))).toBe(true);
    expect(call.headers).toMatchObject({ 'Content-Length': String(Buffer.byteLength(checked.bodyText)) });
    expect(rig.seen).toHaveLength(1);
    const [[request]] = rig.seen;
    expect(request).toEqual({ method: 'post', url: updateUrl(REALMS[COMPANY], 'purchase'), params: undefined, headers: { Accept: 'application/json', Authorization: `Bearer ${fixtureToken(COMPANY)}`, 'Content-Type': 'application/json' }, data: checked.bodyText });
    expect(call.headers).toMatchObject(request.headers);
    expect(rig.limits).toEqual([QBO_LIMIT_MS]);
  });

  it('A3.7: no transform of the instance\'s touches the body', async () => {
    const checked = await registered();
    const { transformRequest } = ax.defaults;
    ax.defaults.transformRequest = [(data) => `${data} `];
    try {
      await send(checked);
    } finally {
      ax.defaults.transformRequest = transformRequest;
    }
    expect([rig.posts().map((c) => c.body), rig.seen.length]).toEqual([[checked.bodyText], 1]);
  });
});

describe('A3.3: without a live capability nothing is sent', () => {
  it('(a) a replay', async () => {
    const checked = await registered();
    await send(checked);
    await expect(send(checked)).rejects.toMatchObject(REFUSED);
    expect([rig.posts().length, rig.seen.length]).toEqual([1, 2]);
  });

  it('(d) one 60 000 ms old is refused; one at 59 999 ms is sent', async () => {
    const checked = await registered();
    rig.clock += 60_000;
    await expect(send(checked)).rejects.toMatchObject(REFUSED);
    expect(rig.posts()).toEqual([]);
    rig.registry.register(checked);
    rig.clock += 59_999;
    expect((await send(checked)).status).toBe(200);
    expect(rig.posts()).toHaveLength(1);
  });

  it('a checked request that was never registered: sendUpdate registers nothing', async () => {
    const checked = await rig.check();
    await expect(send(checked)).rejects.toMatchObject(REFUSED);
    expect([rig.posts().length, rig.registry.size, rig.seen.length]).toEqual([0, 0, 1]);
  });
});

describe('A3.5: dry decisions with the real registry', () => {
  it('100 of them leave the size and the capability as they were; A3.1\'s request then succeeds once', async () => {
    const checked = await registered();
    const url = updateUrl(REALMS[COMPANY], 'purchase');
    // The guard's own context, from a request it refuses.
    await rig.inCall(() => expect(ax.get('https://evil.example.test/')).rejects.toThrow());
    const context = rig.seen[0][1];
    const ask = (over: Json = {}) => decideDry({ method: 'POST', url, headers: {}, data: checked.bodyText, ...over } as any, context, { company: () => currentCall()?.company });
    rig.clock = 59_999;
    await rig.inCall(async () => {
      for (let i = 0; i < 100; i++) {
        expect(ask()).toEqual({ answer: 'allowed-with-capability', rule: 'write-update', text: url, url });
        expect(ask({ url: url.replace('update', 'delete') })).toEqual({ answer: 'refuse', rule: 'write-update' });
        expect([rig.registry.size, holds(checked)]).toEqual([1, true]);
      }
      // Nor do they drop an expired one, or claim that one exists.
      rig.clock = 60_000;
      expect(ask()).toMatchObject({ answer: 'allowed-with-capability' });
      expect([rig.registry.size, holds(checked)]).toEqual([1, false]);
      rig.clock = 59_999;
    });
    expect(rig.net.calls).toEqual([]);
    expect((await send(checked)).status).toBe(200);
    await expect(send(checked)).rejects.toMatchObject(REFUSED);
    expect(rig.posts()).toHaveLength(1);
  });
});

describe('A3.7: the answer, as it came, once', () => {
  // The guard is asked once, so nothing is sent again, whatever the registry would allow.
  const once = () => expect([rig.net.calls.length, rig.stacks.requests.length, rig.registry.size, rig.seen.length]).toEqual([1, 0, 0, 1]);

  it.each<[number, string, unknown]>([
    [200, '{"Purchase":{"Id":"1001"}}', { Purchase: { Id: '1001' } }],
    [200, 'not json', 'not json'],
    [200, '', ''],
    [200, 'null', null],
    [302, '{"n":1}', { n: 1 }],
    [400, '{"Fault":{"Error":[{"code":"5010"}]}}', { Fault: { Error: [{ code: '5010' }] } }],
    [401, '{"n":2}', { n: 2 }],
    [429, '', ''],
    [500, '<html>', '<html>'],
  ])('%i %j', async (status, body, data) => {
    const checked = await registered();
    rig.answer = () => ({ status, body, headers: { 'Retry-After': '0', location: updateUrl(REALMS[COMPANY], 'purchase') } });
    expect(await send(checked)).toEqual({ status, data });
    once();
  });

  it('a reset and a refused connection reject once, the error as it came, the capability consumed', async () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED']) {
      const checked = await registered();
      rig.answer = () => Promise.reject(Object.assign(new Error('gone'), { code }));
      await expect(send(checked)).rejects.toMatchObject({ isAxiosError: true, code, message: 'gone' });
      once();
    }
  });

  it.each<[NonNullable<Failing>, Json]>([
    ['timeout', { code: 'ECONNABORTED', message: `timeout of ${QBO_LIMIT_MS}ms exceeded` }],
    ['timeout in the body', { code: 'ECONNABORTED', message: `timeout of ${QBO_LIMIT_MS}ms exceeded` }],
    ['reset in the body', { code: 'ERR_BAD_RESPONSE', message: 'stream has been aborted' }],
  ])('a %s rejects once, the error as it came, the capability consumed', async (failing, error) => {
    const checked = await registered();
    rig.failing = failing;
    await expect(send(checked)).rejects.toMatchObject({ isAxiosError: true, ...error });
    once();
  });
});

describe('one body registered twice (TG1)', () => {
  const ANSWERS: Array<[string, () => void]> = [
    ...[200, 302, 400, 401, 403, 429, 500, 503].map((status): [string, () => void] => [`a ${status}`, () => (rig.answer = () => ({ status, headers: { 'Retry-After': '0' } }))]),
    ['a reset', () => (rig.answer = () => Promise.reject(Object.assign(new Error('gone'), { code: 'ECONNRESET' })))],
    ...(['timeout', 'timeout in the body', 'reset in the body'] as const).map((failing): [string, () => void] => [`a ${failing}`, () => (rig.failing = failing)]),
  ];
  it.each(ANSWERS)('%s: one send leaves the other capability untouched', async (_name, set) => {
    const checked = await registered();
    rig.registry.register(checked);
    set();
    await send(checked).catch(() => undefined);
    expect([rig.posts().length, rig.seen.length, rig.registry.size, holds(checked)]).toEqual([1, 1, 1, true]);
  });
});

describe('what an answer looks like', () => {
  const READ: Array<[string, unknown]> = [['{"a":1.50}', { a: 1.5 }], ['[1]', [1]], ['null', null], ['5', 5], ['"x"', 'x'], ['not json', 'not json'], ['', ''], ['\ufeff{"a":1}', { a: 1 }], [' {"a":1} ', { a: 1 }], ['\u00a0{"a":1}', '\u00a0{"a":1}']];
  const transitional = { ...ax.defaults.transitional };
  const DEFAULTS: Array<[string, Json]> = [
    ['none', {}],
    ...['arraybuffer', 'stream', 'text', 'json'].map((responseType): [string, Json] => [`responseType ${responseType}`, { responseType }]),
    ['transformResponse', { transformResponse: [() => undefined] }],
    ['no forced parsing', { transitional: { ...transitional, forcedJSONParsing: false } }],
    ['no silent parsing', { transitional: { ...transitional, silentJSONParsing: false }, responseType: 'json' }],
    ['parseReviver', { parseReviver: () => 'other' }],
  ];
  async function withDefaults(set: Json, fn: () => Promise<void>): Promise<void> {
    const defaults = ax.defaults as Json;
    const before = Object.getOwnPropertyDescriptors(defaults);
    Object.assign(defaults, set);
    try {
      await fn();
    } finally {
      for (const key of Object.keys(set)) {
        if (before[key] === undefined) delete defaults[key];
        else Object.defineProperty(defaults, key, before[key]);
      }
    }
  }
  it.each(DEFAULTS)('the same from every request, whatever the instance\'s defaults (TG5): %s', async (_name, set) => {
    const checked = await rig.check();
    for (const [body, data] of READ) {
      for (const status of [200, 500]) {
        rig.registry.register(checked);
        rig.answer = () => ({ status, body });
        rig.read = { status, body };
        await withDefaults(set, async () => {
          for (const ask of [() => sendUpdate(checked), () => fetchById('account', '5'), () => fetchPreferences()]) expect(await rig.inCall(ask)).toEqual({ status, data });
        });
      }
    }
  });
  it.each(DEFAULTS)('an answer cut off in its body rejects, whatever the instance\'s defaults (TG5): %s', async (_name, set) => {
    rig.failing = 'reset in the body';
    const checked = await registered();
    await withDefaults(set, () => expect(send(checked)).rejects.toMatchObject({ code: 'ERR_BAD_RESPONSE' }));
    expect(rig.seen).toHaveLength(1);
  });

  const FAULT = '{"Fault":{"Error":[{"code":"5010"}]}}';
  it.each([[200, FAULT], [200, '{}'], [400, FAULT], [429, '']])('a %i of %j gives its intuit_tid, or none (TG6)', async (status, body) => {
    const checked = await rig.check();
    const tidOf = async (headers: Record<string, string>, call = send) => {
      rig.registry.register(checked);
      rig.answer = () => ({ status, body, headers });
      const answer = await call(checked);
      expect(answer.status).toBe(status);
      expect(Object.keys(answer).filter((key) => key !== 'status' && key !== 'data')).toEqual('intuit_tid' in answer ? ['intuit_tid'] : []);
      return 'intuit_tid' in answer ? answer.intuit_tid : 'absent';
    };
    expect(await tidOf({ intuit_tid: '1-abc-9' })).toBe('1-abc-9');
    expect(await tidOf({ INTUIT_TID: 'A'.repeat(64) })).toBe('A'.repeat(64));
    for (const headers of [{}, { tid: '1-abc' }, { intuit_tid: '' }, { intuit_tid: 'A'.repeat(65) }, { intuit_tid: 'a b' }, { intuit_tid: 'a_b' }]) expect(await tidOf(headers as any)).toBe('absent');
    // As 286, the name in any case, though Node gives it in lower case.
    const recase = (response: any) => (response.headers = { Intuit_TID: response.headers.intuit_tid });
    const id = ax.interceptors.response.use((response) => (recase(response), response), (e) => (recase(e.response), Promise.reject(e)));
    try {
      expect(await tidOf({ intuit_tid: '1-abc-9' })).toBe('1-abc-9');
    } finally {
      ax.interceptors.response.eject(id);
    }
    // As 286: one that holds a token the call held is dropped.
    const earlier = ['an', 'earlier', 'token'].join('-');
    const later = (one: CheckedRequest) =>
      rig.inCall(() => (setCallToken(earlier, REALMS[COMPANY]), setCallToken(fixtureToken(COMPANY), REALMS[COMPANY]), sendUpdate(one)));
    for (const held of [earlier, fixtureToken(COMPANY)]) expect(await tidOf({ intuit_tid: `x${held}x` }, later)).toBe('absent');
    const blank = (one: CheckedRequest) => rig.inCall((call) => (call.held.unshift(''), sendUpdate(one)));
    expect(await tidOf({ intuit_tid: '1-abc' }, blank)).toBe('1-abc');
  });
});

describe('a rejection', () => {
  it('holds no token and no body in its message or stack (TG7)', async () => {
    for (const failing of ['timeout', 'timeout in the body', 'reset in the body', 'reset', 'refusal'] as const) {
      const checked = failing === 'refusal' ? await rig.check() : await registered();
      rig.failing = failing === 'reset' || failing === 'refusal' ? undefined : failing;
      rig.answer = () => Promise.reject(Object.assign(new Error('gone'), { code: 'ECONNRESET' }));
      const error = await send(checked).then(() => undefined, (e) => e);
      expect(typeof error.stack).toBe('string');
      for (const text of [error.message, error.stack]) for (const secret of [fixtureToken(COMPANY), checked.bodyText, NOTE]) expect(text).not.toContain(secret);
    }
  });

  it.each([[null], [undefined], ['x']])('%p passes through as it came (TG8)', async (value) => {
    const checked = await registered();
    const id = ax.interceptors.response.use(undefined, () => Promise.reject(value));
    rig.answer = () => ({ status: 500 });
    rig.read = { status: 500 };
    try {
      for (const ask of [() => sendUpdate(checked), () => fetchById('account', '5'), () => fetchPreferences()]) {
        expect(await rig.inCall(ask).then(() => 'resolved', (e) => [e])).toEqual([value]);
      }
    } finally {
      ax.interceptors.response.eject(id);
    }
  });
});

describe('SB7: the call', () => {
  it('two companies\' overlapping sends each carry their own token and body, to their own realm', async () => {
    const names = [COMPANY, OTHER];
    const checked = [await registered(), await registered({ ...B(), company: OTHER })];
    const release: Array<() => void> = [];
    rig.answer = () => new Promise((resolve) => (release.push(() => resolve({ status: 200 })), release.length === 2 && release.forEach((go) => go())));
    await Promise.all(names.map((name, i) => send(checked[i], name)));
    const sent = rig.posts().map((c) => [c.path, c.headers?.Authorization, c.body]);
    expect(sent.sort()).toEqual(
      names.map((name, i) => [`/v3/company/${REALMS[name]}/${checked[i].entity}?operation=update&minorversion=75`, `Bearer ${fixtureToken(name)}`, checked[i].bodyText]).sort(),
    );
  });

  it('the call\'s token is the one it holds when the update is sent (TG3)', async () => {
    const checked = await registered();
    const newer = ['a', 'newer', 'token'].join('-');
    await rig.inCall(() => (setCallToken(newer, REALMS[COMPANY]), sendUpdate(checked)));
    expect(rig.posts().map((c) => c.headers?.Authorization)).toEqual([`Bearer ${newer}`]);
  });

  /** Throws a plain error before the guard is asked, and the capability stays. */
  async function stopped(run: () => Promise<unknown>, message: string): Promise<void> {
    const size = rig.registry.size;
    const error = await run().then(() => undefined, (e) => e);
    expect(error).toBeInstanceOf(Error);
    expect([error.name, error.message]).toEqual(['Error', `write client: ${message}`]);
    expect([rig.seen, rig.net.calls, rig.registry.size]).toEqual([[], [], size]);
  }

  it('another company\'s call', async () => {
    const checked = await registered();
    await stopped(() => send(checked, OTHER), 'another company\'s call');
    expect(holds(checked)).toBe(true);
    // The same realm and token under another name is another company's too.
    await stopped(() => runInCall(OTHER, () => (setCallToken(fixtureToken(COMPANY), REALMS[COMPANY]), sendUpdate(checked))), 'another company\'s call');
    expect((await send(checked)).status).toBe(200);
  });

  it('no call, no token, no realm', async () => {
    const checked = await registered();
    const none = 'no call with a token';
    await stopped(() => sendUpdate(checked), none);
    await stopped(() => runInCall(COMPANY, () => sendUpdate(checked)), none);
    for (const [key, value] of [['token', fixtureToken(COMPANY)], ['realm', REALMS[COMPANY]]] as const) {
      await stopped(() => runInCall(COMPANY, () => ((currentCall()![key] = value), sendUpdate(checked))), none);
    }
    expect((await send(checked)).status).toBe(200);
  });

  it('a forged or a dry request', async () => {
    const checked = await registered();
    const forged = [{ ...checked }, structuredClone(checked), Object.create(Object.getPrototypeOf(checked)), new Proxy(checked, {}), checked.bodyText, undefined, null];
    for (const one of forged) await stopped(() => send(one as any), 'not a checked request');
    const dry = await rig.check(DRY());
    await stopped(() => send(dry), 'a dry request');
    expect((await send(checked)).status).toBe(200);
  });
});
