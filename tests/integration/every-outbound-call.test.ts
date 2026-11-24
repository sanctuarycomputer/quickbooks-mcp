// Sanctuary Computer (quickbooks-mcp-286): 291's every-outbound-call test (A1.9), rerun with the real Stacks client and no
// token stub (spec A3.7). This is the skeleton T10 writes when the runtime lands: every allowlisted tool, each with valid
// params, called through the started server; every outbound request recorded at the stub below the guard passed the
// guard, the Stacks requests included, and none bypassed it. T13 adds A3.7's credential assertions over this recording:
// X-Api-Key and the known STACKS_QBO_TOKEN only on requests to the configured Stacks origin (headers, URL and body all
// read), no Authorization or access token on a Stacks request, and each QuickBooks request carrying only its own
// company's token and no X-Api-Key, every company's calls overlapping in one server.
import { describe, it, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import fs from 'fs';
import { REPORT_KEYS } from '../../src/clients/guard-decide.js';
import { guardedAxios } from '../../src/http-guard.js';
import { COMPANIES_TOOL, READ_ALLOWLIST } from '../../src/allowlist.js';
import type { StubCall } from '../fakes/stub-network.js';
import { QBO_HOST, REALMS, STACKS_KEY, STACKS_URL, fakePath, fixtureToken, installNetwork, startServer, type Rig } from '../helpers/server.js';

const network = installNetwork();
const { net, trap } = network;

const ARGS: Record<string, { params: Record<string, unknown> }> = JSON.parse(fs.readFileSync(fakePath('guard-tool-args.json'), 'utf8'));
const REPORT = { Header: {}, Columns: { Column: [] }, Rows: { Row: [] } };

// The guard's allow decisions, as it sends them: it resolves axios' http adapter only after an allow and sends `send.url` (W).
const ax = guardedAxios();
const realGetAdapter = ax.getAdapter.bind(ax);
const allowed: string[] = [];

const STACKS_HOST = new URL(STACKS_URL).hostname;
const COMPANIES = Object.keys(REALMS);
const companyOfRealm = (realm: string) => COMPANIES.find((k) => REALMS[k] === realm);

/** A recorded request as one text: its URL (host, port, path and query), every header name and value, and its body. */
function wireText(c: StubCall): string {
  return [`${c.module}://${c.hostname}:${c.port}${c.path}`, JSON.stringify(c.headers ?? {}), c.body].join('\n');
}
const headerNames = (c: StubCall) => Object.keys(c.headers ?? {}).map((k) => k.toLowerCase());
const isStacks = (c: StubCall) => c.module === 'https' && c.hostname === STACKS_HOST && String(c.port) === '443';

/**
 * A3.7's credential rules over a recording, as a list of faults (empty when every request keeps them): the key and
 * `X-Api-Key` only on requests to the Stacks origin; no Stacks request with an Authorization header or any company's
 * access token; each QuickBooks request bearing exactly its realm's company's token, no other company's, and no key.
 */
function credentialFaults(calls: StubCall[]): string[] {
  const faults: string[] = [];
  calls.forEach((c, i) => {
    const text = wireText(c);
    const where = `request ${i} (${c.hostname}${c.path})`;
    if (isStacks(c)) {
      if (headerNames(c).includes('authorization')) faults.push(`${where}: Authorization on a Stacks request`);
      for (const k of COMPANIES) if (text.includes(fixtureToken(k))) faults.push(`${where}: ${k}'s access token on a Stacks request`);
      return;
    }
    if (text.includes(STACKS_KEY)) faults.push(`${where}: the key off the Stacks origin`);
    if (headerNames(c).includes('x-api-key')) faults.push(`${where}: X-Api-Key off the Stacks origin`);
    if (c.hostname !== QBO_HOST) {
      faults.push(`${where}: neither the Stacks origin nor QuickBooks`);
      return;
    }
    const own = companyOfRealm(/^\/v3\/company\/([0-9]+)\//.exec(c.path ?? '')?.[1] ?? '');
    const auth = Object.entries(c.headers ?? {}).filter(([k]) => k.toLowerCase() === 'authorization').map(([, v]) => v);
    if (own === undefined) {
      faults.push(`${where}: no known realm`);
      return;
    }
    if (auth.length !== 1 || auth[0] !== `Bearer ${fixtureToken(own)}`) faults.push(`${where}: Authorization isn't ${own}'s token`);
    for (const k of COMPANIES) if (k !== own && text.includes(fixtureToken(k))) faults.push(`${where}: ${k}'s token on ${own}'s request`);
  });
  return faults;
}

let rig: Rig;
let stderr: string[] = [];
beforeEach(async () => {
  stderr = [];
  allowed.length = 0;
  net.calls.length = 0;
  // In beforeEach: jest.config's restoreMocks restores every spy before each test.
  jest.spyOn(ax, 'getAdapter').mockImplementation(((name: any) => {
    const http = realGetAdapter(name) as (c: any) => Promise<any>;
    return (config: any) => {
      allowed.push(`${String(config.method).toUpperCase()} ${config.url}`);
      return http(config);
    };
  }) as any);
  jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    stderr.push(String(chunk));
    return true;
  }) as any);
  rig = await startServer({
    qbo: { report: REPORT, rows: [{ Id: '1' }] },
    // The QuickBooks fake has no preferences endpoint.
    route: (call) => (call.path?.includes('/preferences?') ? { status: 200, body: JSON.stringify({ Preferences: {} }) } : undefined),
  });
});

afterEach(async () => {
  await rig.close();
});

afterAll(() => {
  network.restore();
});

describe('every allowlisted tool through the guard, with the real Stacks client (A3.7, replacing A1.9)', () => {
  it('the args file covers exactly the allowlist, and the server lists the allowlist and qbo_companies', async () => {
    expect(Object.keys(ARGS).sort()).toEqual([...READ_ALLOWLIST].sort());
    const { tools } = await rig.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_ALLOWLIST, COMPANIES_TOOL].sort());
  });

  it.each([...READ_ALLOWLIST])('%s: its requests are exactly the guard-allowed ones, Stacks first, none refused', async (name) => {
    const result: any = await rig.client.callTool({ name, arguments: { company: 'garden3d', ...ARGS[name] } });
    expect(result.isError).toBeUndefined();
    const sent = net.calls.map((c) => `${c.method} https://${c.hostname}${c.path}`);
    expect(sent).toEqual(allowed);
    expect(net.calls.every((c) => c.module === 'https' && c.method === 'GET' && String(c.port) === '443')).toBe(true);
    // The Stacks token fetch, the first-use companyinfo read, then the tool's own requests.
    expect(net.calls[0].hostname).toBe('stacks.example.test');
    expect(net.calls.slice(1).every((c) => c.hostname === QBO_HOST)).toBe(true);
    expect(net.calls[1].path).toContain('/companyinfo/');
    expect(net.calls.length).toBeGreaterThanOrEqual(3);
    expect(stderr.filter((l) => l.includes('qbo-guard'))).toEqual([]);
    expect(trap.reached).toEqual([]);
    // A3.7: the key on the Stacks request only, garden3d's token on each QuickBooks request only.
    expect(credentialFaults(net.calls)).toEqual([]);
    expect(wireText(net.calls[0])).toContain(STACKS_KEY);
    // TL1: the args reach the request, so a thinned args file fails
    const url = new URL(sent[2].slice('GET '.length));
    const keys = [...url.searchParams.keys()].filter((k) => k !== 'minorversion' && k !== 'format').sort();
    if (url.pathname.includes('/reports/')) {
      // every key the contract allows for that report, so a thinned args file sends fewer and fails
      const report = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
      expect(keys).toEqual([...REPORT_KEYS[report]].filter((k) => k !== 'minorversion' && k !== 'format').sort());
      expect(Object.keys(ARGS[name].params).length).toBeGreaterThan(0);
    } else if (name.startsWith('search_')) {
      const statement = url.searchParams.get('query') ?? '';
      expect(statement).toMatch(/ where /i);
      expect(statement).toMatch(/maxresults 10$/i);
    }
  });

  // Company after company, so each later token fetch runs with the earlier companies' tokens cached; each company's 31
  // calls at once, so they overlap.
  it('A3.7: every tool for every company, each company\'s calls at once: each request keeps the credential rules, read over headers, URL and body', async () => {
    const results: any[] = [];
    for (const company of COMPANIES) {
      results.push(...(await Promise.all(READ_ALLOWLIST.map((name) => rig.client.callTool({ name, arguments: { company, ...ARGS[name] } })))));
    }
    expect(results).toHaveLength(COMPANIES.length * READ_ALLOWLIST.length);
    expect(results.filter((r) => r.isError)).toEqual([]);
    const sent = net.calls.map((c) => `${c.method} https://${c.hostname}${c.path}`);
    expect([...sent].sort()).toEqual([...allowed].sort());
    // One token fetch per company; every company's realm reached.
    expect(net.calls.filter(isStacks).map((c) => new URL(c.path ?? '/', STACKS_URL).searchParams.get('enterprise')).sort()).toEqual([...COMPANIES].sort());
    const realms = new Set(net.calls.filter((c) => c.hostname === QBO_HOST).map((c) => /^\/v3\/company\/([0-9]+)\//.exec(c.path ?? '')?.[1]));
    expect([...realms].sort()).toEqual(Object.values(REALMS).sort());
    expect(credentialFaults(net.calls)).toEqual([]);
    expect(trap.reached).toEqual([]);
  });

  it('A3.7: the credential rules find each fault they name (a key off the origin, in a URL or a body; a crossed or missing token)', () => {
    const base = (over: Partial<StubCall>): StubCall => ({ module: 'https', method: 'GET', hostname: QBO_HOST, port: 443, path: `/v3/company/${REALMS.garden3d}/preferences`, headers: { Authorization: `Bearer ${fixtureToken('garden3d')}` }, agent: undefined, options: {}, body: '', ...over });
    const stacks = (over: Partial<StubCall>): StubCall => base({ hostname: STACKS_HOST, path: '/api/qbo/access_token?enterprise=garden3d', headers: { 'X-Api-Key': STACKS_KEY }, ...over });
    expect(credentialFaults([base({}), stacks({})])).toEqual([]);
    expect(credentialFaults([base({ body: STACKS_KEY })])).toEqual([expect.stringContaining('the key off the Stacks origin')]);
    expect(credentialFaults([base({ path: `/v3/company/${REALMS.garden3d}/preferences?k=${STACKS_KEY}` })])).toEqual([expect.stringContaining('the key off the Stacks origin')]);
    expect(credentialFaults([base({ headers: { Authorization: `Bearer ${fixtureToken('garden3d')}`, 'x-api-key': 'other' } })])).toEqual([expect.stringContaining('X-Api-Key off')]);
    expect(credentialFaults([base({ headers: { Authorization: `Bearer ${fixtureToken('usb-club')}` } })])).toEqual([
      expect.stringContaining("Authorization isn't garden3d's"),
      expect.stringContaining("usb-club's token on garden3d's request"),
    ]);
    expect(credentialFaults([base({ headers: {} })])).toEqual([expect.stringContaining("Authorization isn't garden3d's")]);
    expect(credentialFaults([base({ path: '/v3/company/1/preferences' })])).toEqual([expect.stringContaining('no known realm')]);
    expect(credentialFaults([base({ hostname: 'elsewhere.test' })])).toEqual([expect.stringContaining('neither the Stacks origin nor QuickBooks')]);
    expect(credentialFaults([base({ port: 8443, hostname: STACKS_HOST, headers: { 'X-Api-Key': STACKS_KEY } })])).toEqual([
      expect.stringContaining('the key off the Stacks origin'),
      expect.stringContaining('X-Api-Key off'),
      expect.stringContaining('neither the Stacks origin nor QuickBooks'),
    ]);
    expect(credentialFaults([stacks({ headers: { 'X-Api-Key': STACKS_KEY, authorization: 'x' } })])).toEqual([expect.stringContaining('Authorization on a Stacks request')]);
    expect(credentialFaults([stacks({ body: fixtureToken('index-space') })])).toEqual([expect.stringContaining("index-space's access token on a Stacks request")]);
  });

  it(`${COMPANIES_TOOL} makes no request`, async () => {
    await rig.client.callTool({ name: COMPANIES_TOOL, arguments: {} });
    expect(net.calls).toEqual([]);
    expect(allowed).toEqual([]);
  });
});
