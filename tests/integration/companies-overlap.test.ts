// Sanctuary Computer (quickbooks-mcp-286): overlapping calls through the started server (spec A3.4; carried T4-3,
// TB7-1). Calls A (garden3d) and B (usb-club) start together, each realm served by its own fake QuickBooks; one side's
// first request is held until the other's call has answered, then released. Each result is its own company's data
// from its own realm, and every request carries its own company's token. TB7-1: two overlapping forced fetches for one
// company, and which token each call ends on. (The bluebird binding these overlaps rely on is decided by runtime.test.ts'
// T4-3 case, whose two calls' handlers share one bluebird drain through fetchAll; a single query here never does.)
import { describe, it, expect, afterEach, afterAll } from '@jest/globals';
import { quickbooksFake } from '../fakes/quickbooks.js';
import { stacksFixture } from '../fakes/stacks-token.js';
import type { StubCall } from '../fakes/stub-network.js';
import type { ReadTool } from '../../src/allowlist.js';
import { QBO_HOST, REALMS, companyInfos, fixtureToken, installNetwork, readTools, startServer, textOf, type Rig } from '../helpers/server.js';

const network = installNetwork();
const { net } = network;

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
  net.calls.length = 0;
});
afterAll(() => {
  expect(network.trap.reached).toEqual([]);
  network.restore();
});

const realmOf = (c: StubCall) => /^\/v3\/company\/([0-9]+)\//.exec(c.path ?? '')?.[1];
const bearerOf = (c: StubCall) => Object.entries(c.headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
/** Each company's one purchase, naming it, so a result shows whose data it is. */
const purchase = (company: string) => ({ Id: '1', PrivateNote: `${company}'s purchase`, TotalAmt: company === 'garden3d' ? 2 : 4 });
const row = (company: string) => JSON.stringify({ ...purchase(company), depth: 0 });

type Side = 'A' | 'B';
const COMPANY: Record<Side, string> = { A: 'garden3d', B: 'usb-club' };

/**
 * A and B at once, `held`'s first QuickBooks request (its first-use companyinfo read) held until the other's call has
 * answered. Returns both results, the order things happened in, and each realm's fake's requests.
 */
async function overlap(held: Side) {
  const infos = companyInfos();
  const fakes = Object.fromEntries(
    (['A', 'B'] as Side[]).map((s) => {
      const realm = REALMS[COMPANY[s]];
      return [s, quickbooksFake({ companyInfo: { [realm]: infos[realm] }, rows: [purchase(COMPANY[s])] })];
    }),
  ) as Record<Side, ReturnType<typeof quickbooksFake>>;
  const other: Side = held === 'A' ? 'B' : 'A';
  let otherDone!: () => void;
  const otherAnswered = new Promise<void>((r) => (otherDone = r));
  const events: string[] = [];
  let heldFirst = true;
  rig = await startServer({
    route: (call) => {
      if (call.hostname !== QBO_HOST) return undefined;
      const side = (['A', 'B'] as Side[]).find((s) => REALMS[COMPANY[s]] === realmOf(call));
      if (side === undefined) return { status: 404 };
      if (side === held && heldFirst) {
        heldFirst = false;
        events.push(`${held} first request held`);
        return otherAnswered.then(() => {
          events.push(`${held} first request released`);
          return fakes[side].handler(call);
        });
      }
      return fakes[side].handler(call);
    },
  });
  const client = rig.client;
  const run = (s: Side) => client.callTool({ name: 'search_purchases', arguments: { company: COMPANY[s], params: {} } });
  const pending = { A: run('A'), B: run('B') };
  const otherResult = await pending[other];
  events.push(`${other} answered`);
  otherDone();
  const heldResult = await pending[held];
  events.push(`${held} answered`);
  return { results: { [held]: heldResult, [other]: otherResult } as Record<Side, any>, events, fakes };
}

describe('A3.4: calls for two companies overlap without bleeding, through the started server', () => {
  it.each(['A', 'B'] as Side[])('with %s held: each result is its own company\'s data from its own realm, each request with its own token', async (held) => {
    const other: Side = held === 'A' ? 'B' : 'A';
    const { results, events, fakes } = await overlap(held);
    // The held side's first request was still waiting when the other's call answered.
    expect(events).toEqual([`${held} first request held`, `${other} answered`, `${held} first request released`, `${held} answered`]);
    for (const s of ['A', 'B'] as Side[]) {
      expect(results[s]).toStrictEqual({ content: [{ type: 'text', text: row(COMPANY[s]) }] });
      // Each fake saw its own company's first-use read and query, at its own realm, with its own token.
      const realm = REALMS[COMPANY[s]];
      expect(fakes[s].requests.map((c) => c.path?.split('?')[0])).toEqual([`/v3/company/${realm}/companyinfo/${realm}`, `/v3/company/${realm}/query`]);
      expect(fakes[s].requests.map(bearerOf)).toEqual([`Bearer ${fixtureToken(COMPANY[s])}`, `Bearer ${fixtureToken(COMPANY[s])}`]);
    }
    // Over the whole recording: every QuickBooks request is at a realm whose company's token it carries.
    const qbo = net.calls.filter((c) => c.hostname === QBO_HOST);
    expect(qbo).toHaveLength(4);
    for (const c of qbo) {
      const company = Object.keys(REALMS).find((k) => REALMS[k] === realmOf(c)) as string;
      expect([company, bearerOf(c)]).toEqual([company, `Bearer ${fixtureToken(company)}`]);
    }
    // usb-club's own fixture (200-usb-club.json) handed B its token (A1.8).
    expect(rig!.stacks.requests.map((c) => new URL(c.path ?? '/', 'https://s.invalid').searchParams.get('enterprise')).sort()).toEqual(['garden3d', 'usb-club']);
  });
});

// TB7-1: C1 and C2 for garden3d both hold the first token, t0, which QuickBooks has stopped taking. C1's 401 starts a
// forced fetch (F1), held at Stacks. C2's request is sent after F1 began (its handler waits for that), so its 401 starts
// a fetch of its own (F2, A1.3b) instead of joining F1. F2 answers t2 at once; F1 is released after and answers t1.
// What happens: F2's start made F1 unable to write the cache, so the cache holds t2, the newer; C1 resends with t1, the
// older but still fresh token F1 brought, and its call ends on t1. Both calls succeed; the next call uses t2, no fetch.
describe('TB7-1: two overlapping forced fetches for one company', () => {
  it('the call whose fetch began first ends on the older fresh token (t1); the cache keeps the newer (t2); both succeed', async () => {
    const t1 = ['qbo', 'forced', 'first', 'token'].join('-');
    const t2 = ['qbo', 'forced', 'second', 'token'].join('-');
    const t0 = fixtureToken('garden3d');
    const fresh = (token: string) => ({ status: 200, body: { ...(stacksFixture('200-garden3d.json').body as object), access_token: token } });
    let releaseF1!: () => void;
    const f1Held = new Promise<void>((r) => (releaseF1 = r));
    let gateC2!: () => void;
    const c2Gate = new Promise<void>((r) => (gateC2 = r));
    const tools: ReadTool[] = (await readTools()).map((t) => {
      if (t.name !== 'search_purchases' || !('schema' in t)) return t;
      const real = t.handler as (...a: unknown[]) => Promise<unknown>;
      // C2 (params.desc set) holds t0 from its prepared call, and waits here until F1 has begun before it sends.
      return { ...t, handler: async (args: any, rt: unknown) => ((args.params?.desc !== undefined ? await c2Gate : undefined, real(args, rt))) } as ReadTool;
    });
    let expired = false;
    const infos = companyInfos();
    const qbo = quickbooksFake({ companyInfo: infos, rows: [purchase('garden3d')] });
    rig = await startServer({
      tools,
      stacks: { sequence: ['200-garden3d.json', { answer: fresh(t1), hold: f1Held }, fresh(t2)] },
      route: (call) => (call.hostname === QBO_HOST && expired && bearerOf(call) === `Bearer ${t0}` ? { status: 401, body: '{}' } : call.hostname === QBO_HOST ? qbo.handler(call) : undefined),
    });
    const client = rig.client;
    const stacksAsked = () => rig!.stacks.requests.length;
    // The first call fetches t0 and passes the first-use read; then QuickBooks stops taking t0.
    expect((await client.callTool({ name: 'get_company_info', arguments: { company: 'garden3d', params: {} } })).isError).toBeUndefined();
    expired = true;
    const c1 = client.callTool({ name: 'search_purchases', arguments: { company: 'garden3d', params: { asc: 'Id' } } });
    const c2 = client.callTool({ name: 'search_purchases', arguments: { company: 'garden3d', params: { desc: 'Id' } } });
    // F1 began: C1's 401 asked Stacks again (held).
    while (stacksAsked() < 2) await new Promise((r) => setImmediate(r));
    gateC2();
    // F2 began and answered t2: C2's call is done, on t2, while F1 is still held.
    const r2: any = await c2;
    expect(stacksAsked()).toBe(3);
    releaseF1();
    const r1: any = await c1;
    expect([r1.isError, textOf(r1)]).toEqual([undefined, row('garden3d')]);
    expect([r2.isError, textOf(r2)]).toEqual([undefined, row('garden3d')]);
    const queries = net.calls.filter((c) => c.hostname === QBO_HOST && (c.path ?? '').includes('/query?'));
    const by = (dir: string) => queries.filter((c) => decodeURIComponent(c.path ?? '').includes(`orderby Id ${dir}`)).map(bearerOf);
    // C1: t0 (401), resent with t1. C2: t0 (401), resent with t2.
    expect(by('asc')).toEqual([`Bearer ${t0}`, `Bearer ${t1}`]);
    expect(by('desc')).toEqual([`Bearer ${t0}`, `Bearer ${t2}`]);
    // The cache holds t2: a get answers it with no fetch, and the next call sends it.
    const got = await rig.runtime.stacks.get('garden3d');
    expect(got.ok && got.token.access_token).toBe(t2);
    const r3: any = await client.callTool({ name: 'search_purchases', arguments: { company: 'garden3d', params: {} } });
    expect(r3.isError).toBeUndefined();
    expect(bearerOf(net.calls[net.calls.length - 1])).toBe(`Bearer ${t2}`);
    expect(stacksAsked()).toBe(3);
  });
});
