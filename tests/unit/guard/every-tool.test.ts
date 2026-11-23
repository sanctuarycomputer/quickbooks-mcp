// Sanctuary Computer (quickbooks-mcp-291): every allowlisted tool, called through the registered server, sends only what the guard allowed (A1.9).
import { describe, it, expect, beforeEach, afterAll, jest } from '@jest/globals';
import { REPORT_KEYS } from '../../../src/clients/guard-decide.js';
import { trapNetwork } from '../../fakes/no-network.js';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { installStubNetwork, type StubCall, type StubAnswer } from '../../fakes/stub-network.js';
import { assertFreshBuild, ROOT } from '../../e2e/helpers.js';

// Order matters: the trap, then the stub (so the backstop wraps the stub), then start.
assertFreshBuild(); // the tools load from dist/ (npm run build first, as CI does)
const trap = trapNetwork();
const answerFor = (call: StubCall): StubAnswer => {
  const p = new URL(`https://x${call.path ?? '/'}`).pathname;
  if (p.endsWith('/query')) return { status: 200, body: JSON.stringify({ QueryResponse: {} }) };
  if (p.includes('/reports/')) return { status: 200, body: JSON.stringify({ Header: {}, Columns: { Column: [] }, Rows: { Row: [] } }) };
  if (p.includes('/companyinfo/')) return { status: 200, body: JSON.stringify({ CompanyInfo: {} }) };
  if (p.endsWith('/preferences')) return { status: 200, body: JSON.stringify({ Preferences: {} }) };
  return { status: 404, body: '{}' };
};
const net = installStubNetwork(answerFor);

const REALM = '9990000000000002';
const QuickBooks = createRequire(import.meta.url)('node-quickbooks');
// 285's client seam (in the built dist/, which the tools below are loaded from): until 286, getInstance has no token source; here it gives a real client with a fake token.
jest.unstable_mockModule('../../../dist/clients/quickbooks-client.js', () => ({
  QuickbooksClient: {
    getInstance: async () => new QuickBooks('id', 'secret', 'qbo-fake-' + 'token', false, REALM, false, false, null, '2.0', 'r'),
  },
}));

const { secureStart, defaultCallScope, guardedAxios } = await import('../../../src/http-guard.js');
const restoreStart = secureStart({}, []);
const { READ_ALLOWLIST, COMPANIES_TOOL, startReadServer } = await import('../../../src/allowlist.js');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

// The tool list as 285's src/index.ts builds it, loaded from the build (dist/, what ships): the tools are upstream code this test
// exercises but does not cover, so loading their sources would count them in the coverage report.
const indexText = fs.readFileSync(path.join(ROOT, 'src', 'index.ts'), 'utf8');
const toolImports = [...indexText.matchAll(/^import \{ (\w+) \} from "\.\/tools\/([\w-]+\.tool)\.js";$/gm)];
const TOOLS: any[] = [];
for (const [, name, file] of toolImports) {
  const mod = await import(`../../../dist/tools/${file}.js`);
  TOOLS.push(mod[name]);
}

const server = new McpServer({ name: 'every-tool', version: '0.0.0' }, { capabilities: { tools: {} } });
startReadServer({}, server, TOOLS);
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await server.connect(serverSide);
const client = new Client({ name: 'every-tool-test', version: '0.0.0' });
await client.connect(clientSide);

const ARGS: Record<string, Record<string, unknown>> = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fakes/guard-tool-args.json'), 'utf8'));

// The guard's allow decisions, as it sends them: it resolves axios' http adapter only after an allow and sends `send.url` (W).
const ax = guardedAxios();
const realGetAdapter = ax.getAdapter.bind(ax);
const allowed: string[] = [];

let stderr: string[] = [];
beforeEach(() => {
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
});

afterAll(async () => {
  await client.close();
  await server.close();
  restoreStart();
  net.restore();
  trap.restore();
});

const textOf = (r: any) => (r.content as Array<{ type: string; text: string }>).map((c) => c.text).join('\n');

describe('every allowlisted tool through the guard (A1.9)', () => {
  it('the args file covers exactly the allowlist, and the server lists the allowlist and the stub', async () => {
    expect(Object.keys(ARGS).sort()).toEqual([...READ_ALLOWLIST].sort());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_ALLOWLIST, COMPANIES_TOOL].sort());
  });

  it.each([...READ_ALLOWLIST])('%s: its requests are exactly the guard-allowed ones, at least one, none refused', async (name) => {
    const scope = defaultCallScope();
    const result: any = await scope.run(async () => {
      scope.setRealm(REALM);
      return client.callTool({ name, arguments: ARGS[name] });
    });
    const sent = net.calls.map((c) => `${c.method} https://${c.hostname}${c.path}`);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent).toEqual(allowed);
    expect(net.calls.every((c) => c.module === 'https' && c.hostname === 'quickbooks.api.intuit.com' && c.method === 'GET')).toBe(true);
    expect(stderr.filter((l) => l.includes('qbo-guard'))).toEqual([]);
    expect(textOf(result)).not.toContain('qbo-guard');
    expect(trap.reached).toEqual([]);
    // TL1: the args reach the request, so a thinned args file fails
    const url = new URL(sent[0].slice('GET '.length));
    const keys = [...url.searchParams.keys()].filter((k) => k !== 'minorversion' && k !== 'format').sort();
    const params = ARGS[name].params as Record<string, unknown>;
    if (url.pathname.includes('/reports/')) {
      // every key the contract allows for that report, so a thinned args file sends fewer and fails
      const report = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
      expect(keys).toEqual([...REPORT_KEYS[report]].filter((k) => k !== 'minorversion' && k !== 'format').sort());
      expect(Object.keys(params).length).toBeGreaterThan(0);
    } else if (name.startsWith('search_')) {
      const statement = url.searchParams.get('query') ?? '';
      expect(statement).toMatch(/ where /i);
      expect(statement).toMatch(/maxresults 10$/i);
    }
  });

  it(`${COMPANIES_TOOL} makes no request`, async () => {
    const scope = defaultCallScope();
    await scope.run(async () => {
      scope.setRealm(REALM);
      return client.callTool({ name: COMPANIES_TOOL, arguments: {} });
    });
    expect(net.calls).toEqual([]);
    expect(allowed).toEqual([]);
  });
});
