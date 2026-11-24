// Sanctuary Computer (quickbooks-mcp-293): the update send (A3.1, A3.3, A3.5, A3.7, SB7), through the real adapter, backstop, 286's
// interceptors, write mode's rules and the real registry, on checked requests the real pre-send check made.
import { describe, it, expect } from '@jest/globals';
import { fixtureToken, QBO_HOST, REALMS } from '../helpers/server.js';
import { guardedAxios } from '../../src/http-guard.js';
import { currentCall, runInCall, setCallToken } from '../../src/clients/call-context.js';
import { QBO_LIMIT_MS } from '../../src/clients/qbo-transport.js';
import { sha256Hex } from '../../src/write/canonical.js';
import { sendUpdate, updateUrl } from '../../src/write/client.js';
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
    expect(rig.net.calls).toHaveLength(1);
    expect(rig.net.calls[0]).toMatchObject({ module: 'https', method: 'POST', hostname: QBO_HOST, path: `/v3/company/${REALMS[COMPANY]}/${input().entity}?operation=update&minorversion=75`, body: checked.bodyText });
  });

  it('A3.7: the exact bytes, the three headers alone, and the limit on the transport', async () => {
    const checked = await registered();
    expect(checked.bodyText).toContain(NOTE);
    await send(checked);
    const [call] = rig.posts();
    expect(Buffer.from(call.body, 'utf8').equals(Buffer.from(checked.bodyText, 'utf8'))).toBe(true);
    expect(call.headers).toMatchObject({ 'Content-Length': String(Buffer.byteLength(checked.bodyText)) });
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
    expect(rig.posts().map((c) => c.body)).toEqual([checked.bodyText]);
  });
});

describe('A3.3: without a live capability nothing is sent', () => {
  it('(a) a replay', async () => {
    const checked = await registered();
    await send(checked);
    await expect(send(checked)).rejects.toMatchObject(REFUSED);
    expect(rig.posts()).toHaveLength(1);
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
    expect([rig.posts().length, rig.registry.size]).toEqual([0, 0]);
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
    expect([rig.net.calls.length, rig.stacks.requests.length, rig.registry.size]).toEqual([1, 0, 0]);
  });

  it('a reset and a refused connection reject once, the error as it came, the capability consumed', async () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED']) {
      const checked = await registered();
      rig.answer = () => Promise.reject(Object.assign(new Error('gone'), { code }));
      await expect(send(checked)).rejects.toMatchObject({ isAxiosError: true, code, message: 'gone' });
      expect([rig.net.calls.length, rig.stacks.requests.length, rig.registry.size]).toEqual([1, 0, 0]);
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
    expect([rig.net.calls.length, rig.stacks.requests.length, rig.registry.size]).toEqual([1, 0, 0]);
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
