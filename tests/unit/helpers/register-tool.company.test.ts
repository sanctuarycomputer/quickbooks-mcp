// Sanctuary Computer (quickbooks-mcp-286): every tool takes a required `company` from the loaded keys and runs as one
// tool call (spec A2.7, A3.1, A3.2; T7-4; the unknown-key warning after the first item). Through the started server:
// 291's secureStart, 285's startReadServer, an in-memory MCP client; the stub network answers below the guard.
import { describe, it, expect, afterEach, afterAll, jest } from '@jest/globals';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ENTITIES_TWO,
  NOW,
  REALMS,
  STACKS_KEY,
  fakePath,
  fixtureToken,
  installNetwork,
  readTools,
  startServer,
  testEnv,
  textOf,
  type Rig,
  type StartOpts,
} from '../../helpers/server.js';
import { secureStart } from '../../../src/http-guard.js';
import { recordFailure } from '../../../src/clients/call-context.js';
import { COMPANIES_TOOL, READ_ALLOWLIST, startReadServer, type ReadTool } from '../../../src/allowlist.js';

const network = installNetwork();
const { net } = network;

const KEYS = ['sanctuary-computer', 'garden3d', 'index-space', 'usb-club'];
const KEYS_TWO = [...KEYS, 'north-fork'];
const BILLS = { qbo: { rows: [{ Id: '1' }] } };
const BILL_ARGS = { params: { criteria: [{ field: 'Id', value: '1' }], limit: 10 } };

let rig: Rig | undefined;
async function start(opts: StartOpts = {}): Promise<Rig> {
  rig = await startServer(opts);
  return rig;
}
afterEach(async () => {
  await rig?.close();
  rig = undefined;
  net.calls.length = 0;
});
afterAll(() => {
  expect(network.trap.reached).toEqual([]);
  network.restore();
});

/** A Stacks 200 for garden3d naming `name`. */
const named = (name: string) => ({
  status: 200,
  body: { enterprise: 'garden3d', realm_id: REALMS.garden3d, access_token: fixtureToken('garden3d'), expires_at: '2026-11-18T12:00:00Z', company_name: name },
});

/** The tool list with `name`'s definition replaced by one whose handler is `handler`. */
async function withHandler(name: string, handler: (...a: any[]) => Promise<unknown>): Promise<ReadTool[]> {
  return (await readTools()).map((t) => (t.name === name ? ({ name, description: 'd', schema: z.object({ a: z.string().optional() }), handler } as unknown as ReadTool) : t));
}

describe('A3.1: tools/list', () => {
  it('every tool but qbo_companies requires company and params, its enum the loaded keys in order; qbo_companies has no company', async () => {
    const { client } = await start();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_ALLOWLIST, COMPANIES_TOOL].sort());
    for (const t of tools) {
      const schema = t.inputSchema as { required?: string[]; properties?: Record<string, { enum?: string[] }> };
      if (t.name === COMPANIES_TOOL) {
        expect(schema.properties?.company).toBeUndefined();
        continue;
      }
      expect(schema.required).toEqual(expect.arrayContaining(['company', 'params']));
      expect(schema.properties?.company.enum).toEqual(KEYS);
    }
  });
});

describe('A2.7: the enum and both name checks use what QBO_COMPANIES loaded', () => {
  it('with entities-two.json the enum shows its keys in order', async () => {
    const { client } = await start({ env: testEnv({ QBO_COMPANIES: ENTITIES_TWO }) });
    const { tools } = await client.listTools();
    const bills = tools.find((t) => t.name === 'search_bills')!;
    expect((bills.inputSchema as any).properties.company.enum).toEqual(KEYS_TWO);
  });

  it("a Stacks 200 naming Garden Three LLC: name-mismatch under entities.json, the call's data under entities-two.json", async () => {
    const stacks = { sequence: [named('Garden Three LLC')] };
    let r = await start({ ...BILLS, stacks });
    const refused = await r.client.callTool({ name: 'search_bills', arguments: { company: 'garden3d', ...BILL_ARGS } });
    expect(textOf(refused)).toBe("reason: name-mismatch\nsource: stacks\nreported: Garden Three LLC\n\nStacks' name for this company isn't one of its accepted names.");
    expect(r.qbo.requests).toEqual([]);
    await r.close();
    rig = undefined;
    r = await start({ ...BILLS, stacks, env: testEnv({ QBO_COMPANIES: ENTITIES_TWO }) });
    const ok = await r.client.callTool({ name: 'search_bills', arguments: { company: 'garden3d', ...BILL_ARGS } });
    expect(ok.isError).toBeUndefined();
    expect(textOf(ok)).toBe('{"Id":"1","depth":0}');
  });
});

describe("R5's form for the five keys: each bad value refuses the start and registers nothing", () => {
  const unreadable = fakePath('no-such-entities.json');
  it.each([
    ['STACKS_QBO_URL unset', { STACKS_QBO_URL: undefined }, 'refused to start: STACKS_QBO_URL is not set'],
    ['STACKS_QBO_URL http', { STACKS_QBO_URL: 'http://stacks.example.test' }, 'refused to start: STACKS_QBO_URL is not https'],
    ['STACKS_QBO_TOKEN unset', { STACKS_QBO_TOKEN: undefined }, 'refused to start: STACKS_QBO_TOKEN is not set'],
    ['STACKS_QBO_TOKEN empty', { STACKS_QBO_TOKEN: '' }, 'refused to start: STACKS_QBO_TOKEN is empty'],
    ['QUICKBOOKS_ENVIRONMENT unset', { QUICKBOOKS_ENVIRONMENT: undefined }, 'refused to start: QUICKBOOKS_ENVIRONMENT is not set'],
    ['QUICKBOOKS_ENVIRONMENT sandbox', { QUICKBOOKS_ENVIRONMENT: 'sandbox' }, 'refused to start: QUICKBOOKS_ENVIRONMENT is not production'],
    ['QBO_COMPANIES unset', { QBO_COMPANIES: undefined }, 'refused to start: QBO_COMPANIES is not set'],
    ['QBO_COMPANIES unreadable', { QBO_COMPANIES: unreadable }, 'refused to start: QBO_COMPANIES is unreadable'],
    ['QBO_MODE write', { QBO_MODE: 'write' }, 'refused to start: QBO_MODE is not read'],
  ] as Array<[string, Record<string, string | undefined>, string]>)('%s', async (_label, over, message) => {
    const env = testEnv(over);
    const tools = await readTools();
    const tool = jest.fn();
    const restore = secureStart(env as NodeJS.ProcessEnv, []);
    try {
      expect(() => startReadServer(env, { tool } as unknown as McpServer, [] as ReadTool[])).toThrow(new Error(message));
      expect(() => startReadServer(env, { tool } as unknown as McpServer, tools)).toThrow(new Error(message));
    } finally {
      restore();
    }
    expect(tool).not.toHaveBeenCalled();
    expect(net.calls).toEqual([]);
  });
});

describe('A3.2: a call without company, or with an unknown one, is the SDK refusal and no request leaves', () => {
  const PREFIX = 'MCP error -32602: Input validation error: Invalid arguments for tool search_bills';
  it.each([
    ['no company', BILL_ARGS],
    ['family-intelligence', { company: 'family-intelligence', ...BILL_ARGS }],
    ['a key in another letter case', { company: 'Garden3d', ...BILL_ARGS }],
    ['a key of entities-two.json only', { company: 'north-fork', ...BILL_ARGS }],
  ])('%s', async (_label, args) => {
    const { client } = await start(BILLS);
    const r: any = await client.callTool({ name: 'search_bills', arguments: args });
    expect(r.isError).toBe(true);
    expect(r.content).toHaveLength(1);
    expect(r.content[0].text.startsWith(PREFIX)).toBe(true);
    expect(net.calls).toEqual([]);
  });
});

describe('a handler that throws (T7-4)', () => {
  it("answers the failure it recorded first, the thrown value never read", async () => {
    const tools = await withHandler('search_bills', async () => {
      recordFailure({ reason: 'http-503', intuitTid: 'tid-1' });
      throw new Error(`thrown ${STACKS_KEY}`);
    });
    const { client } = await start({ tools });
    const r = await client.callTool({ name: 'search_bills', arguments: { company: 'garden3d', params: {} } });
    expect(r).toEqual({ isError: true, content: [{ type: 'text', text: 'reason: http-503\nintuit_tid: tid-1\n\nQuickBooks answered 503.' }] });
  });

  it('with nothing recorded: fork-error', async () => {
    const tools = await withHandler('search_bills', async () => {
      throw new Error('boom');
    });
    const { client } = await start({ tools });
    const r = await client.callTool({ name: 'search_bills', arguments: { company: 'garden3d', params: {} } });
    expect(r).toEqual({ isError: true, content: [{ type: 'text', text: 'reason: fork-error\n\nThe server failed before it could read QuickBooks.' }] });
  });

  it('a prepare failure is answered from prepareCall: the handler never runs', async () => {
    const handler = jest.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));
    const { client } = await start({ tools: await withHandler('search_bills', handler), stacks: { sequence: ['409.json'] } });
    const r = await client.callTool({ name: 'search_bills', arguments: { company: 'garden3d', params: {} } });
    expect(textOf(r)).toBe('reason: not-connected\n\nThis company has no QuickBooks connection in Stacks (409).');
    expect(handler).not.toHaveBeenCalled();
  });

  it('the handler receives the cleaned params and the runtime', async () => {
    const seen: unknown[][] = [];
    const tools = await withHandler('search_bills', async (...a: unknown[]) => {
      seen.push(a);
      return { content: [{ type: 'text', text: 'Found 0 bills:' }] };
    });
    const r = await start({ tools });
    await r.client.callTool({ name: 'search_bills', arguments: { company: 'garden3d', params: { a: 'x', b: 'y' } } });
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toEqual({ params: { a: 'x' } });
    expect(seen[0][1]).toBe(r.runtime);
  });
});

describe("upstream's unknown-key warning goes into the call's warnings, after the first item", () => {
  const WARNING = /^WARNING: search_bills does not support this parameter: ship_date\. It was IGNORED/;
  it('a token failure: the error item, then the warning', async () => {
    const { client } = await start({ stacks: { sequence: ['409.json'] } });
    const r: any = await client.callTool({ name: 'search_bills', arguments: { company: 'garden3d', params: { ...BILL_ARGS.params, ship_date: 'x' } } });
    expect(r.isError).toBe(true);
    expect(r.content).toHaveLength(2);
    expect(r.content[0].text).toBe('reason: not-connected\n\nThis company has no QuickBooks connection in Stacks (409).');
    expect(r.content[1].text).toMatch(WARNING);
  });

  it('a success: the data item, then the warning; the key never reached QuickBooks', async () => {
    const { client, qbo } = await start(BILLS);
    const r: any = await client.callTool({ name: 'search_bills', arguments: { company: 'garden3d', params: { ...BILL_ARGS.params, ship_date: 'x' } } });
    expect(r.isError).toBeUndefined();
    expect(r.content.map((c: any) => c.text.slice(0, 20))).toEqual(['{"Id":"1","depth":0}', 'WARNING: search_bill']);
    expect(r.content[1].text).toMatch(WARNING);
    const query = qbo.requests.map((c) => c.path ?? '').filter((p) => p.includes('/query'));
    expect(query).toHaveLength(1);
    expect(decodeURIComponent(query[0])).not.toContain('ship_date');
  });

  it('a supported call has no warning', async () => {
    const { client } = await start(BILLS);
    const r: any = await client.callTool({ name: 'search_bills', arguments: { company: 'garden3d', ...BILL_ARGS } });
    expect(r.content).toEqual([{ type: 'text', text: '{"Id":"1","depth":0}' }]);
  });
});

it('the clock is the injected one: NOW is an hour before the fixtures expire', () => {
  expect(new Date(NOW).toISOString()).toBe('2026-11-18T11:00:00.000Z');
});
