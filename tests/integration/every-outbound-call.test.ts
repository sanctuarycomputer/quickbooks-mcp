// Sanctuary Computer (quickbooks-mcp-286): 291's every-outbound-call test (A1.9), rerun with the real Stacks client and no
// token stub (spec A3.7). This is the skeleton T10 writes when the runtime lands: every allowlisted tool, each with valid
// params, called through the started server; every outbound request recorded at the stub below the guard passed the
// guard, the Stacks requests included, and none bypassed it. T13 adds A3.7's credential assertions over this recording.
import { describe, it, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import fs from 'fs';
import { REPORT_KEYS } from '../../src/clients/guard-decide.js';
import { guardedAxios } from '../../src/http-guard.js';
import { COMPANIES_TOOL, READ_ALLOWLIST } from '../../src/allowlist.js';
import { QBO_HOST, fakePath, installNetwork, startServer, type Rig } from '../helpers/server.js';

const network = installNetwork();
const { net, trap } = network;

const ARGS: Record<string, { params: Record<string, unknown> }> = JSON.parse(fs.readFileSync(fakePath('guard-tool-args.json'), 'utf8'));
const REPORT = { Header: {}, Columns: { Column: [] }, Rows: { Row: [] } };

// The guard's allow decisions, as it sends them: it resolves axios' http adapter only after an allow and sends `send.url` (W).
const ax = guardedAxios();
const realGetAdapter = ax.getAdapter.bind(ax);
const allowed: string[] = [];

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

  it(`${COMPANIES_TOOL} makes no request`, async () => {
    await rig.client.callTool({ name: COMPANIES_TOOL, arguments: {} });
    expect(net.calls).toEqual([]);
    expect(allowed).toEqual([]);
  });
});
