// Sanctuary Computer (quickbooks-mcp-285): the read allowlist, the start refusal and their order.
// Changed by Sanctuary Computer (quickbooks-mcp-286): registration takes the runtime, every listed tool gains `company`,
// and startReadServer needs 291's start and the five keys (tests/helpers/server.ts' testEnv).
import { describe, it, expect, jest } from '@jest/globals';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  READ_ALLOWLIST,
  COMPANIES_TOOL,
  REFUSED_KEYS,
  startRefusal,
  registerReadTools,
  startReadServer,
  type ReadTool,
} from '../../src/allowlist';
import { QboCompaniesTool } from '../../src/tools/qbo-companies.tool';
import type { Runtime } from '../../src/clients/runtime';
import { secureStart } from '../../src/http-guard';
import { testEnv } from '../helpers/server';

// The fork review's appendix A (scripts-283 tools/data/allowlist-final.txt), copied as a literal.
const APPENDIX_A = [
  'get_aged_payables',
  'get_aged_receivables',
  'get_balance_sheet',
  'get_cash_flow',
  'get_company_info',
  'get_customer_balance',
  'get_customer_sales',
  'get_general_ledger',
  'get_preferences',
  'get_profit_and_loss',
  'get_trial_balance',
  'get_vendor_balance',
  'get_vendor_expenses',
  'search_accounts',
  'search_bill_payments',
  'search_bills',
  'search_classes',
  'search_credit_memos',
  'search_customers',
  'search_departments',
  'search_deposits',
  'search_employees',
  'search_invoices',
  'search_items',
  'search_journal_entries',
  'search_payments',
  'search_purchases',
  'search_sales_receipts',
  'search_transfers',
  'search_vendor_credits',
  'search_vendors',
];

const KEYS = ['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN', 'REALM_ID'].map((k) => 'QUICKBOOKS_' + k);

function fakeServer() {
  const tool = jest.fn();
  return { server: { tool } as unknown as McpServer, calls: tool.mock.calls as any[][] };
}

function fakeDef(name: string): ReadTool {
  return { name, description: 'd', schema: z.object({}), handler: (async () => ({ content: [] })) as any };
}

function fullTools(): ReadTool[] {
  return [...APPENDIX_A.map(fakeDef), QboCompaniesTool];
}

// Registration reads only the loaded keys; nothing is called on it while registering.
const RUNTIME = { cfg: { companies: [{ key: 'garden3d', name: 'garden3d, LLC', acceptedNames: ['garden3d, LLC'] }] } } as unknown as Runtime;

/** startReadServer after 291's start, with the test environment; the runtime it returns is closed. */
function started(server: McpServer, tools: ReadTool[]): void {
  const restore = secureStart(testEnv() as NodeJS.ProcessEnv, []);
  try {
    startReadServer(testEnv(), server, tools).close();
  } finally {
    restore();
  }
}

const sentinel = () => 'sentinel-' + process.pid + '-' + Date.now();

// First in the file: 291's guard has never started in this module registry, so configureGuard still throws.
describe('before 291\'s start', () => {
  it('createRuntime fails, and startReadServer answers it as one refusal, registering nothing', () => {
    const { server, calls } = fakeServer();
    expect(() => startReadServer(testEnv(), server, fullTools())).toThrow(new Error('refused to start: qbo-guard: not started'));
    expect(calls).toHaveLength(0);
  });
});

describe('allowlist', () => {
  it("A1: READ_ALLOWLIST is the fork review's list", () => {
    expect([...READ_ALLOWLIST]).toEqual(APPENDIX_A);
    expect(READ_ALLOWLIST).toHaveLength(31);
    expect([...READ_ALLOWLIST].sort()).toEqual([...READ_ALLOWLIST]);
    expect(new Set(READ_ALLOWLIST).size).toBe(31);
    expect(COMPANIES_TOOL).toBe('qbo_companies');
  });

  it('A2: registers the listed tools and the stub once each', async () => {
    const { server, calls } = fakeServer();
    registerReadTools(server, fullTools(), RUNTIME);
    expect(calls).toHaveLength(32);
    expect(calls.map((c) => c[0]).sort()).toEqual([...APPENDIX_A, 'qbo_companies'].sort());
    for (const c of calls) {
      if (c[0] === 'qbo_companies') {
        expect(Object.keys(c[2])).toEqual([]);
        expect(c[1]).toBe(QboCompaniesTool.description);
        // The stub's handler, handed the call's arguments and the runtime.
        expect(await c[3]({})).toEqual(await QboCompaniesTool.handler({}, RUNTIME));
      } else {
        expect(Object.keys(c[2])).toEqual(['company', 'params']);
      }
    }
  });

  it('A3: missing tool refuses before registering', () => {
    const { server, calls } = fakeServer();
    expect(() => registerReadTools(server, fullTools().filter((t) => t.name !== 'search_vendors'), RUNTIME)).toThrow(
      /^allowlist: missing search_vendors$/,
    );
    expect(() => registerReadTools(server, fullTools().filter((t) => t !== QboCompaniesTool), RUNTIME)).toThrow(
      /^allowlist: missing qbo_companies$/,
    );
    expect(calls).toHaveLength(0);
  });

  it('A4: unlisted tool refuses before registering', () => {
    const { server, calls } = fakeServer();
    expect(() => registerReadTools(server, [...fullTools(), fakeDef('create_invoice')], RUNTIME)).toThrow(
      /^allowlist: unlisted create_invoice$/,
    );
    expect(calls).toHaveLength(0);
  });

  it('A4: duplicate refuses', () => {
    const { server, calls } = fakeServer();
    expect(() => registerReadTools(server, [...fullTools(), fakeDef('search_bills')], RUNTIME)).toThrow(
      /^allowlist: duplicate search_bills$/,
    );
    expect(calls).toHaveLength(0);
  });

  it('A4: a listed name without a schema, or qbo_companies with one, refuses', () => {
    const { server, calls } = fakeServer();
    const schemaless = fullTools().map((t) =>
      t.name === 'search_bills' ? { name: 'search_bills', description: 'd', handler: QboCompaniesTool.handler } : t,
    );
    expect(() => registerReadTools(server, schemaless, RUNTIME)).toThrow(/^allowlist: unlisted search_bills$/);
    const withSchema = fullTools().map((t) => (t === QboCompaniesTool ? fakeDef('qbo_companies') : t));
    expect(() => registerReadTools(server, withSchema, RUNTIME)).toThrow(/^allowlist: unlisted qbo_companies$/);
    const undefinedSchema = fullTools().map((t) =>
      t.name === 'search_bills' ? ({ ...t, schema: undefined } as unknown as ReadTool) : t,
    );
    expect(() => registerReadTools(server, undefinedSchema, RUNTIME)).toThrow(/^allowlist: unlisted search_bills$/);
    expect(calls).toHaveLength(0);
  });

  it('A3/A4: the checks run in order: duplicate, then missing, then unlisted', () => {
    const { server, calls } = fakeServer();
    const withoutVendors = fullTools().filter((t) => t.name !== 'search_vendors');
    expect(() => registerReadTools(server, [...withoutVendors, fakeDef('search_bills')], RUNTIME)).toThrow(
      /^allowlist: duplicate search_bills$/,
    );
    expect(() => registerReadTools(server, [fakeDef('create_invoice'), ...withoutVendors], RUNTIME)).toThrow(
      /^allowlist: missing search_vendors$/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('start refusal', () => {
  it('REFUSED_KEYS is the four sign-in keys', () => {
    expect([...REFUSED_KEYS]).toEqual(KEYS);
  });

  it.each(KEYS)('R5: each refused key refuses before registering (%s)', (k) => {
    const value = sentinel();
    expect(startRefusal({ [k]: value })).toBe(`${k} is set`);
    const { server, calls } = fakeServer();
    let message = '';
    try {
      startReadServer({ [k]: value }, server, fullTools());
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe(`refused to start: ${k} is set`);
    expect(message).not.toContain(value);
    expect(calls).toHaveLength(0);
  });

  it("R6: empty value refuses; other keys don't", () => {
    for (const k of KEYS) expect(startRefusal({ [k]: '' })).toBe(`${k} is set`);
    expect(startRefusal({})).toBeNull();
    expect(startRefusal({ QUICKBOOKS_DISABLE_WRITE: 'true', QUICKBOOKS_ENVIRONMENT: 'production' })).toBeNull();
    const inherited = Object.create({ [KEYS[0]]: 'x' }) as Record<string, string | undefined>;
    expect(startRefusal(inherited)).toBeNull();
  });

  it('the companies tool is handed the call\'s arguments and the runtime', async () => {
    const { server, calls } = fakeServer();
    const handler = jest.fn(async (_args: unknown, _runtime: unknown) => ({ content: [] }));
    const tools = fullTools().map((t) => (t === QboCompaniesTool ? { ...QboCompaniesTool, handler } : t));
    registerReadTools(server, tools, RUNTIME);
    const registered = calls.find((c) => c[0] === 'qbo_companies')!;
    await registered[3]({ a: 1 });
    expect(handler).toHaveBeenCalledWith({ a: 1 }, RUNTIME);
  });

  it('startReadServer registers when nothing refuses', () => {
    const { server, calls } = fakeServer();
    started(server, fullTools());
    expect(calls).toHaveLength(32);
  });

  it('startReadServer prefixes an allowlist mismatch', () => {
    const { server, calls } = fakeServer();
    expect(() => started(server, fullTools().filter((t) => t.name !== 'search_vendors'))).toThrow(
      /^refused to start: allowlist: missing search_vendors$/,
    );
    expect(calls).toHaveLength(0);
  });
});
