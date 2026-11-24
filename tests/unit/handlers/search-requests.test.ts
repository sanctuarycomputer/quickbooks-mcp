// Sanctuary Computer (quickbooks-mcp-286): the request half of the input normalizer (spec A5.1, A5.2, A5.3's refusal
// half, A5.13's request half, A6.3 and A6.4 per handler). Each search runs through its tool file's handler (so the shapes
// are the ones that file builds) and each report through its handler, inside a call with a token and realm set, on
// node-quickbooks' own client over 291's guard, with the QuickBooks fake answering below it. "No request" is the fake's
// request list being empty.
import { describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import { trapNetwork } from '../../fakes/no-network.js';
import { installStubNetwork, type StubCall } from '../../fakes/stub-network.js';
import { quickbooksFake, type QuickbooksFakeOpts } from '../../fakes/quickbooks.js';
import { startTestGuard } from '../../helpers/guard.js';
import { currentCall, runInCall, setCallToken, type Failure } from '../../../src/clients/call-context.js';
import type { ToolResponse } from '../../../src/types/tool-response.js';
import { SearchBillPaymentsTool } from '../../../src/tools/search-bill-payments.tool.js';
import { SearchBillsTool } from '../../../src/tools/search-bills.tool.js';
import { SearchClassesTool } from '../../../src/tools/search-classes.tool.js';
import { SearchCreditMemosTool } from '../../../src/tools/search-credit-memos.tool.js';
import { SearchCustomersTool } from '../../../src/tools/search-customers.tool.js';
import { SearchDepartmentsTool } from '../../../src/tools/search-departments.tool.js';
import { SearchDepositsTool } from '../../../src/tools/search-deposits.tool.js';
import { SearchEmployeesTool } from '../../../src/tools/search-employees.tool.js';
import { SearchJournalEntriesTool } from '../../../src/tools/search-journal-entries.tool.js';
import { SearchPaymentsTool } from '../../../src/tools/search-payments.tool.js';
import { SearchPurchasesTool } from '../../../src/tools/search-purchases.tool.js';
import { SearchSalesReceiptsTool } from '../../../src/tools/search-sales-receipts.tool.js';
import { SearchTransfersTool } from '../../../src/tools/search-transfers.tool.js';
import { SearchVendorCreditsTool } from '../../../src/tools/search-vendor-credits.tool.js';
import { SearchVendorsTool } from '../../../src/tools/search-vendors.tool.js';
import { searchQuickbooksAccounts } from '../../../src/handlers/search-quickbooks-accounts.handler.js';
import { searchQuickbooksInvoices } from '../../../src/handlers/search-quickbooks-invoices.handler.js';
import { searchQuickbooksItems } from '../../../src/handlers/search-quickbooks-items.handler.js';
import { searchQuickbooksBillPayments } from '../../../src/handlers/search-quickbooks-bill-payments.handler.js';
import { searchQuickbooksJournalEntries } from '../../../src/handlers/search-quickbooks-journal-entries.handler.js';
import { searchQuickbooksBills } from '../../../src/handlers/search-quickbooks-bills.handler.js';
import { searchQuickbooksCustomers } from '../../../src/handlers/search-quickbooks-customers.handler.js';
import { searchQuickbooksVendors } from '../../../src/handlers/search-quickbooks-vendors.handler.js';
import { getQuickbooksAgedPayables } from '../../../src/handlers/get-quickbooks-aged-payables.handler.js';
import { getQuickbooksAgedReceivables } from '../../../src/handlers/get-quickbooks-aged-receivables.handler.js';
import { getQuickbooksBalanceSheet } from '../../../src/handlers/get-quickbooks-balance-sheet.handler.js';
import { getQuickbooksCashFlow } from '../../../src/handlers/get-quickbooks-cash-flow.handler.js';
import { getQuickbooksCustomerBalance } from '../../../src/handlers/get-quickbooks-customer-balance.handler.js';
import { getQuickbooksCustomerSales } from '../../../src/handlers/get-quickbooks-customer-sales.handler.js';
import { getQuickbooksGeneralLedger } from '../../../src/handlers/get-quickbooks-general-ledger.handler.js';
import { getQuickbooksProfitAndLoss } from '../../../src/handlers/get-quickbooks-profit-and-loss.handler.js';
import { getQuickbooksTrialBalance } from '../../../src/handlers/get-quickbooks-trial-balance.handler.js';
import { getQuickbooksVendorBalance } from '../../../src/handlers/get-quickbooks-vendor-balance.handler.js';
import { getQuickbooksVendorExpenses } from '../../../src/handlers/get-quickbooks-vendor-expenses.handler.js';

// Order matters: the trap, then the stub (so the guard's backstop wraps the stub), then the guard.
const trap = trapNetwork();
let fake = quickbooksFake();
const net = installStubNetwork((call) => fake.handler(call));

const STACKS = 'https://stacks.example.test';
const REALM = '9990000000000002'; // garden3d's, in 200-garden3d.json
// Built at runtime: no secret-shaped literal sits in this file.
const TOKEN = ['qbo', 'test', 'access', 't8'].join('-');

let restore: () => void;
beforeAll(() => {
  restore = startTestGuard({ stacksUrl: STACKS, keys: ['garden3d'] });
});
afterAll(() => restore());
afterEach(() => {
  expect(trap.reached).toEqual([]);
});

const SENTENCE = (what: string) => `The search was refused before reaching QuickBooks: ${what}. Use limit up to 1000 and page with offset.`;
const REPORT = (option: string) => `The report was refused before reaching QuickBooks: ${option} isn't a valid value.`;
const LIMIT = 'limit must be a whole number from 1 to 1000';
const OFFSET = 'offset must be a whole number of at least 1';
const FETCH_ALL = "fetchAll isn't supported";
const COUNT_NO = "count isn't supported by this tool";
const COUNT_ONLY = 'count is supported only as count: true with no other criterion and no page key';

type Ran = { out: any; failure: Failure | null; usedOffset: number | undefined; requests: StubCall[]; queries: string[] };
/** A handler's error path, or a tool file's `Error…` text. */
const isError = (o: any): boolean => o?.isError === true || /^Error/.test(o?.content?.[0]?.text ?? '');
const queryOf = (r: StubCall): string => new URL(r.path ?? '/', 'https://quickbooks.invalid').searchParams.get('query') ?? '';

/** Runs `fn` as one tool call for garden3d with its token and realm set, against a fresh fake. */
async function inCall(fn: () => Promise<unknown>, opts: QuickbooksFakeOpts = {}): Promise<Ran> {
  fake = quickbooksFake(opts);
  return runInCall('garden3d', async () => {
    setCallToken(TOKEN, REALM);
    const out = await fn();
    const call = currentCall()!;
    return { out, failure: call.failure, usedOffset: call.usedOffset, requests: [...fake.requests], queries: fake.requests.map(queryOf) };
  });
}

function expectRefused(r: Ran, what: string): void {
  expect(r.failure).toEqual({ reason: 'fork-error', text: SENTENCE(what) });
  expect(r.requests).toEqual([]);
}

function expectOneQuery(r: Ran, entity: string): string {
  expect(r.failure).toBeNull();
  expect(r.queries).toHaveLength(1);
  const q = r.queries[0];
  expect(q.toLowerCase().startsWith(`select * from ${entity.toLowerCase()}`)).toBe(true);
  return q;
}

type Family = 'criteria' | 'top' | 'spread' | 'fixed';
type P = Record<string, unknown>;
type SearchCase = {
  tool: string;
  family: Family;
  entity: string;
  run: (params: P) => Promise<unknown>;
  /** a string field (fixed) or filter field (the others) whose value the case sets */
  field: string;
  /** a value that field accepts */
  good: string;
};

/** The three criteria-only tools run at their handler, with the criteria their tool file passes on (its own check is
 * upstream's, before the handler; through the server it is T12's). */
const viaHandler = (handler: (criteria: any) => Promise<unknown>) => (params: P): Promise<unknown> => handler(params.criteria);
const viaTool = (def: { handler: unknown }) => (params: P): Promise<unknown> => (def.handler as (args: unknown, extra: unknown) => Promise<unknown>)({ params }, {});

const SEARCHES: SearchCase[] = [
  { tool: 'search_accounts', family: 'criteria', entity: 'account', run: viaHandler(searchQuickbooksAccounts), field: 'Name', good: 'Cash' },
  { tool: 'search_invoices', family: 'criteria', entity: 'invoice', run: viaHandler(searchQuickbooksInvoices), field: 'DocNumber', good: '1001' },
  { tool: 'search_items', family: 'criteria', entity: 'item', run: viaHandler(searchQuickbooksItems), field: 'Name', good: 'Widget' },
  { tool: 'search_bill_payments', family: 'top', entity: 'billPayment', run: viaTool(SearchBillPaymentsTool), field: 'DocNumber', good: '7' },
  { tool: 'search_employees', family: 'top', entity: 'employee', run: viaTool(SearchEmployeesTool), field: 'DisplayName', good: 'Ann' },
  { tool: 'search_journal_entries', family: 'top', entity: 'journalEntry', run: viaTool(SearchJournalEntriesTool), field: 'DocNumber', good: '8' },
  { tool: 'search_purchases', family: 'top', entity: 'purchase', run: viaTool(SearchPurchasesTool), field: 'TxnDate', good: '2026-10-01' },
  { tool: 'search_bills', family: 'spread', entity: 'bill', run: viaTool(SearchBillsTool), field: 'DocNumber', good: '9' },
  { tool: 'search_customers', family: 'spread', entity: 'customer', run: viaTool(SearchCustomersTool), field: 'DisplayName', good: 'Ann' },
  { tool: 'search_vendors', family: 'spread', entity: 'vendor', run: viaTool(SearchVendorsTool), field: 'DisplayName', good: 'Acme' },
  { tool: 'search_classes', family: 'fixed', entity: 'class', run: viaTool(SearchClassesTool), field: 'name', good: 'Ops' },
  { tool: 'search_credit_memos', family: 'fixed', entity: 'creditMemo', run: viaTool(SearchCreditMemosTool), field: 'customer_ref', good: '12' },
  { tool: 'search_departments', family: 'fixed', entity: 'department', run: viaTool(SearchDepartmentsTool), field: 'name', good: 'Studio' },
  { tool: 'search_deposits', family: 'fixed', entity: 'deposit', run: viaTool(SearchDepositsTool), field: 'txn_date_from', good: '2026-10-01' },
  { tool: 'search_payments', family: 'fixed', entity: 'payment', run: viaTool(SearchPaymentsTool), field: 'customer_ref', good: '12' },
  { tool: 'search_sales_receipts', family: 'fixed', entity: 'salesReceipt', run: viaTool(SearchSalesReceiptsTool), field: 'customer_ref', good: '12' },
  { tool: 'search_transfers', family: 'fixed', entity: 'transfer', run: viaTool(SearchTransfersTool), field: 'txn_date_from', good: '2026-10-01' },
  { tool: 'search_vendor_credits', family: 'fixed', entity: 'vendorCredit', run: viaTool(SearchVendorCreditsTool), field: 'vendor_ref', good: '12' },
];

/** The params a search tool takes with no criteria (for the three that require criteria, `criteria: {}`). */
const noCriteria = (c: SearchCase): P => (c.family === 'criteria' ? { criteria: {} } : {});

/** Each shape a `limit` (or `offset`) can arrive in for the tool (fork review §Page size), as [label, params]. */
function pageShapes(c: SearchCase, key: 'limit' | 'offset', n: unknown): Array<[string, P]> {
  const up = key.toUpperCase();
  const cap = key[0].toUpperCase() + key.slice(1);
  switch (c.family) {
    case 'criteria':
      return [
        ['advanced object', { criteria: { [key]: n } }],
        ['advanced object with filters', { criteria: { filters: [{ field: c.field, value: c.good }], [key]: n } }],
        ['plain record, any case', { criteria: { [up]: n } }],
        ['{field,value} entry', { criteria: [{ field: key, value: n }] }],
        ['{field,value} entry, any case', { criteria: [{ field: cap, value: n }] }],
        ['plain record in an array', { criteria: [{ [key]: n }] }],
        ['plain record in an array, any case', { criteria: [{ [cap]: n }] }],
      ];
    case 'top':
      return [
        ['top level', { [key]: n }],
        ['top level beside criteria', { criteria: [{ field: c.field, value: c.good }], [key]: n }],
        ['{field,value} entry', { criteria: [{ field: key, value: n }] }],
        ['{field,value} entry, any case', { criteria: [{ field: up, value: n }] }],
      ];
    case 'spread':
      return [
        ['top level', { [key]: n }],
        ['top level beside a {field} criterion', { criteria: [{ field: c.field, value: c.good }], [key]: n }],
        ['top level beside a {key} criterion', { criteria: [{ key: c.field, value: c.good }], [key]: n }],
        ['{key,value} entry', { criteria: [{ key, value: n }] }],
        ['{key,value} entry, any case', { criteria: [{ key: cap, value: n }] }],
      ];
    case 'fixed':
      return [
        ['top level', { [key]: n }],
        ['top level beside a field', { [c.field]: c.good, [key]: n }],
      ];
  }
}

/** The first, simplest shape: where each refused value is tried. */
const firstShape = (c: SearchCase, key: 'limit' | 'offset', n: unknown): P => pageShapes(c, key, n)[0][1];

/** Each shape `fetchAll: true` can arrive in for the tool's schema (the 8 have none: RegisterTool strips it, T12). */
function fetchAllShapes(c: SearchCase): Array<[string, P]> {
  switch (c.family) {
    case 'criteria':
      return [
        ['advanced object', { criteria: { fetchAll: true } }],
        ['advanced object, false', { criteria: { fetchAll: false } }],
        ['advanced object with filters', { criteria: { filters: [{ field: c.field, value: c.good }], fetchAll: true } }],
        ['plain record, any case', { criteria: { FetchAll: true } }],
        ['plain record, lower case', { criteria: { fetchall: true } }],
        ['{field,value} entry', { criteria: [{ field: 'fetchAll', value: true }] }],
        ['{field,value} entry, any case', { criteria: [{ field: 'FETCHALL', value: true }] }],
        ['plain record in an array', { criteria: [{ fetchAll: true }] }],
      ];
    case 'top':
      return [
        ['top level', { fetchAll: true }],
        ['top level, false', { fetchAll: false }],
        ['top level beside criteria', { criteria: [{ field: c.field, value: c.good }], fetchAll: true }],
        ['{field,value} entry', { criteria: [{ field: 'fetchAll', value: true }] }],
        ['{field,value} entry, any case', { criteria: [{ field: 'Fetchall', value: true }] }],
      ];
    case 'spread':
      return [
        ['top level', { fetchAll: true }],
        ['top level, false', { fetchAll: false }],
        ['top level beside a {field} criterion', { criteria: [{ field: c.field, value: c.good }], fetchAll: true }],
        ['{key,value} entry', { criteria: [{ key: 'fetchAll', value: true }] }],
        ['{key,value} entry, any case', { criteria: [{ key: 'FETCHALL', value: true }] }],
      ];
    case 'fixed':
      return [];
  }
}

/** A filter on the tool's field with `value`, in the tool's own shape. */
function filterOn(c: SearchCase, value: unknown): P {
  switch (c.family) {
    case 'criteria':
      return { criteria: { [c.field]: value } };
    case 'top':
      return { criteria: [{ field: c.field, value }] };
    case 'spread':
      return { criteria: [{ field: c.field, value }] };
    case 'fixed':
      return { [c.field]: value };
  }
}

describe.each(SEARCHES)('$tool', (c) => {
  it('A5.1: with no criteria, one query ending maxresults 1000, from startposition 1', async () => {
    const r = await inCall(() => c.run(noCriteria(c)));
    expect(expectOneQuery(r, c.entity)).toMatch(/ startposition 1 maxresults 1000$/);
    expect(r.usedOffset).toBe(1);
  });

  it.each([1000, 5, 1])('A5.1: each limit shape caps the request at maxresults %d', async (n) => {
    for (const [label, params] of pageShapes(c, 'limit', n)) {
      const r = await inCall(() => c.run(params));
      expect([label, expectOneQuery(r, c.entity)]).toEqual([label, expect.stringMatching(new RegExp(` maxresults ${n}$`))]);
    }
  });

  it.each([0, 1001, 1.5, '10 x'])('A5.2: limit %j is refused with no request', async (n) => {
    expectRefused(await inCall(() => c.run(firstShape(c, 'limit', n))), LIMIT);
  });

  it('A5.13: each offset shape reaches startposition <offset> before maxresults, and usedOffset equals it', async () => {
    for (const [label, params] of pageShapes(c, 'offset', 101)) {
      const r = await inCall(() => c.run(params));
      expect([label, expectOneQuery(r, c.entity)]).toEqual([label, expect.stringMatching(/ startposition 101 maxresults 1000$/)]);
      expect([label, r.usedOffset]).toEqual([label, 101]);
    }
  });

  it.each([0, 1.5, '2'])('A5.13: offset %j is refused with no request', async (n) => {
    const r = await inCall(() => c.run(firstShape(c, 'offset', n)));
    expectRefused(r, OFFSET);
    expect(r.usedOffset).toBeUndefined();
  });

  const fetchAll = fetchAllShapes(c);
  if (fetchAll.length > 0) {
    it.each(fetchAll)('A5.3: fetchAll as %s is refused with no request', async (_label, params) => {
      expectRefused(await inCall(() => c.run(params)), FETCH_ALL);
    });
  }

  it('A6.3: a filter value ending in a backslash is refused with no request; its accepted twin sends one', async () => {
    expectRefused(await inCall(() => c.run(filterOn(c, c.good + '\\'))), `the value for ${c.family === 'fixed' ? fixedField(c) : c.field} isn't valid`);
    const q = expectOneQuery(await inCall(() => c.run(filterOn(c, c.good))), c.entity);
    expect(q).toContain(`'${c.good}'`);
  });

  it("a QuickBooks error answer takes the handler's error path; outside a call the handler errors with no request", async () => {
    const r = await inCall(() => c.run(noCriteria(c)), { answers: [{ status: 400, body: { Fault: { Error: [{ Message: 'bad' }] } } }] });
    expect(r.requests).toHaveLength(1);
    expect(isError(r.out)).toBe(true);
    fake = quickbooksFake();
    const out = (await c.run(noCriteria(c))) as any;
    expect(isError(out)).toBe(true);
    expect(fake.requests).toEqual([]);
  });

  it('A6.3: a filter value holding a control character is refused with no request; a plain space is accepted', async () => {
    expectRefused(await inCall(() => c.run(filterOn(c, 'a\u0001b'))), `the value for ${c.family === 'fixed' ? fixedField(c) : c.field} isn't valid`);
    expectOneQuery(await inCall(() => c.run(filterOn(c, 'a b'))), c.entity);
  });
});

/** The QuickBooks field each fixed-schema handler puts its string field under. */
function fixedField(c: SearchCase): string {
  return { name: 'Name', customer_ref: 'CustomerRef', txn_date_from: 'TxnDate', vendor_ref: 'VendorRef' }[c.field] as string;
}

describe("A5.13 the 8 fixed-schema tools' new offset: an optional integer >= 1 in the schema", () => {
  const EIGHT = [
    SearchClassesTool, SearchCreditMemosTool, SearchDepartmentsTool, SearchDepositsTool,
    SearchPaymentsTool, SearchSalesReceiptsTool, SearchTransfersTool, SearchVendorCreditsTool,
  ];
  it.each(EIGHT.map((d) => [d.name, d] as const))('%s', (_name, def) => {
    const schema = def.schema as unknown as { safeParse: (v: unknown) => { success: boolean; data?: unknown } };
    expect(schema.safeParse({ offset: 1 })).toMatchObject({ success: true, data: { offset: 1 } });
    expect(schema.safeParse({ offset: 101 })).toMatchObject({ success: true, data: { offset: 101 } });
    expect(schema.safeParse({})).toMatchObject({ success: true, data: {} });
    for (const bad of [0, 1.5, '2', -1]) expect([bad, schema.safeParse({ offset: bad }).success]).toEqual([bad, false]);
  });
});

describe('A5.1 the three with required criteria, called at the handler with no criteria at all', () => {
  it.each([
    ['search_accounts', 'account', searchQuickbooksAccounts],
    ['search_invoices', 'invoice', searchQuickbooksInvoices],
    ['search_items', 'item', searchQuickbooksItems],
  ] as const)('%s', async (_tool, entity, handler) => {
    const r = await inCall(() => (handler as (c: unknown) => Promise<unknown>)(undefined));
    expect(expectOneQuery(r, entity)).toMatch(/ startposition 1 maxresults 1000$/);
    expect(r.usedOffset).toBe(1);
  });
});

// Fix round 1 (T8-1, T8-3): the three criteria-only tools' mixed objects and broken lists, at the request.
describe('T8-1 a filter beside a page key filters the query on the three criteria-only tools', () => {
  const THREE: Array<[string, string, (c: any) => Promise<unknown>, string, string]> = [
    ['search_accounts', 'account', searchQuickbooksAccounts, 'Name', 'Cash'],
    ['search_invoices', 'invoice', searchQuickbooksInvoices, 'CustomerRef', '5'],
    ['search_items', 'item', searchQuickbooksItems, 'Name', 'Widget'],
  ];
  it.each(THREE)('%s: beside limit, offset, asc and desc', async (_tool, entity, handler, field, value) => {
    const where = `select * from ${entity} where ${field} = '${value}'`;
    const cases: Array<[P, string, number]> = [
      [{ [field]: value, limit: 5 }, `${where} startposition 1 maxresults 5`, 1],
      [{ [field]: value, offset: 1001 }, `${where} startposition 1001 maxresults 1000`, 1001],
      [{ [field]: value, offset: 101, limit: 21 }, `${where} startposition 101 maxresults 21`, 101],
      [{ [field]: value, asc: 'Id' }, `${where} orderby Id asc startposition 1 maxresults 1000`, 1],
      [{ [field]: value, desc: 'Id' }, `${where} orderby Id desc startposition 1 maxresults 1000`, 1],
    ];
    for (const [criteria, query, used] of cases) {
      const r = await inCall(() => handler(criteria));
      expect([criteria, r.failure, r.queries, r.usedOffset]).toEqual([criteria, null, [query], used]);
    }
  });
  it.each(THREE)('%s: a bad key beside a page key is refused with no request', async (_tool, _entity, handler) => {
    const cases: Array<[P, string]> = [
      [{ 'Name;': 'x', limit: 5 }, "a field name isn't valid"],
      [{ FetchAll: true, limit: 5 }, FETCH_ALL],
      [{ Count: true, limit: 5 }, COUNT_NO],
      [{ Name: 'x', Limit: 5, limit: 5 }, 'limit is given more than once'],
    ];
    for (const [criteria, what] of cases) {
      const r = await inCall(() => handler(criteria));
      expect([criteria, r.failure, r.requests]).toEqual([criteria, { reason: 'fork-error', text: SENTENCE(what) }, []]);
    }
  });
});

// Fix round 2 (TB8-1, TB8-2), at the request.
describe('TB8-1 a list element with another key is refused with no request, on each builder handler', () => {
  const EXTRA = 'a criterion has a key other than field, value and operator';
  it.each([
    ['search_accounts filters + fetchAll', () => searchQuickbooksAccounts({ filters: [{ field: 'Id', value: '1', fetchAll: true }] } as any)],
    ['search_invoices filters + count', () => searchQuickbooksInvoices({ filters: [{ field: 'Id', value: '1', count: true }] } as any)],
    ['search_items criteria + Count', () => searchQuickbooksItems({ criteria: [{ field: 'Id', value: '1', Count: true }] } as any)],
    ['search_invoices criteria + extra', () => searchQuickbooksInvoices({ criteria: [{ field: 'Id', value: '1', extra: 'y' }] } as any)],
    ['search_purchases criteria + fetchAll', () => viaTool(SearchPurchasesTool)({ criteria: [{ field: 'Id', value: '1', fetchAll: true }] })],
    ['search_employees criteria + count', () => viaTool(SearchEmployeesTool)({ criteria: [{ field: 'Id', value: '1', count: true }] })],
    ['search_bill_payments criteria + Count', () => searchQuickbooksBillPayments({ criteria: [{ field: 'Id', value: '1', Count: true }] })],
    ['search_journal_entries criteria + extra', () => searchQuickbooksJournalEntries({ criteria: [{ field: 'Id', value: '1', extra: 'y' }] })],
  ] as Array<[string, () => Promise<unknown>]>)('%s', async (_label, run) => {
    expectRefused(await inCall(run), EXTRA);
  });
});

describe('TB8-2 one {field, value, operator} object with page keys beside it filters the query once', () => {
  it.each([
    [{ field: 'Name', value: 'Cash', operator: '=' }, "select * from account where Name = 'Cash' startposition 1 maxresults 1000", 1],
    [{ field: 'Name', value: 'Cash', operator: '=', limit: 5 }, "select * from account where Name = 'Cash' startposition 1 maxresults 5", 1],
    [{ field: 'Name', value: 'Cash', operator: '=', offset: 101 }, "select * from account where Name = 'Cash' startposition 101 maxresults 1000", 101],
    [{ field: 'Name', value: 'Cash', operator: '=', asc: 'Id' }, "select * from account where Name = 'Cash' orderby Id asc startposition 1 maxresults 1000", 1],
    [{ field: 'Name', value: 'Cash', operator: '=', desc: 'Id' }, "select * from account where Name = 'Cash' orderby Id desc startposition 1 maxresults 1000", 1],
  ] as Array<[P, string, number]>)('%j', async (criteria, query, used) => {
    const r = await inCall(() => searchQuickbooksAccounts(criteria as any));
    expect([r.failure, r.queries, r.usedOffset]).toEqual([null, [query], used]);
  });
  it('a field name that would escape the statement is refused with no request', async () => {
    expectRefused(await inCall(() => searchQuickbooksAccounts({ field: "Id = '1' or Id", value: 'x', limit: 5 } as any)), "a field name isn't valid");
  });
  it("search_bills' {key} form folding to {field, value} filters once, and a hostile field is refused", async () => {
    const ok = await inCall(() => viaTool(SearchBillsTool)({ criteria: [{ key: 'field', value: 'DocNumber' }, { key: 'value', value: '9' }] }));
    expect([ok.failure, ok.queries]).toEqual([null, ["select * from bill where DocNumber = '9' startposition 1 maxresults 1000"]]);
    const bad = await inCall(() => viaTool(SearchBillsTool)({ criteria: [{ key: 'field', value: "DocNumber = '1' or Id" }, { key: 'value', value: '9' }] }));
    expectRefused(bad, "a field name isn't valid");
  });
});

describe('T8-3 a broken filters or criteria list is refused before the builder, with no request', () => {
  it.each([
    ['search_accounts filters a string', () => searchQuickbooksAccounts({ filters: 'abc' } as any), 'filters must be an array'],
    ['search_invoices criteria a string', () => searchQuickbooksInvoices({ criteria: 'abc' } as any), 'criteria must be an array'],
    ['search_items filters holding null', () => searchQuickbooksItems({ filters: [null] } as any), 'each criterion must be an object'],
    ['search_purchases criteria holding null', () => viaTool(SearchPurchasesTool)({ criteria: [null] }), 'each criterion must be an object'],
    ['search_employees criteria holding null', () => viaTool(SearchEmployeesTool)({ criteria: [{ field: 'Id', value: '1' }, null] }), 'each criterion must be an object'],
    ['search_bill_payments criteria a string', () => searchQuickbooksBillPayments({ criteria: 'abc' }), 'criteria must be an array'],
    ['search_journal_entries criteria holding null', () => searchQuickbooksJournalEntries({ criteria: [null] }), 'each criterion must be an object'],
    ['search_accounts filters and criteria both', () => searchQuickbooksAccounts({ filters: [], criteria: [{ field: 'Name', value: 'x' }] } as any), 'give filters or criteria, not both'],
  ] as Array<[string, () => Promise<unknown>, string]>)('%s', async (_label, run, what) => {
    const r = await inCall(run);
    expect(isError(r.out)).toBe(true);
    expectRefused(r, what);
  });
});

describe('A5.2 a page key given twice is refused with no request', () => {
  it.each([
    ['search_purchases top level and a {field} entry', viaTool(SearchPurchasesTool), { limit: 5, criteria: [{ field: 'limit', value: 5 }] }, 'limit'],
    ['search_bills top level and a {key} entry', viaTool(SearchBillsTool), { offset: 2, criteria: [{ key: 'Offset', value: 2 }] }, 'offset'],
    ['search_accounts two cases of one key', viaHandler(searchQuickbooksAccounts), { criteria: { Limit: 5, LIMIT: 5 } }, 'limit'],
  ] as const)('%s', async (_label, run, params, key) => {
    expectRefused(await inCall(() => (run as (p: P) => Promise<unknown>)(params as P)), `${key} is given more than once`);
  });
});

describe('A5.2 a criteria string or function is refused at the handler with no request', () => {
  it.each([
    ['a string', "Name = 'x'"],
    ['a function', () => undefined],
  ])('%s', async (_label, criteria) => {
    expectRefused(await inCall(() => searchQuickbooksAccounts(criteria as any)), 'criteria must be an object or an array');
  });
});

describe('A6.3 count (D9)', () => {
  const SEVEN: Array<[string, (p: P) => Promise<unknown>, Array<[string, P]>]> = [
    ...(['search_accounts', 'search_invoices', 'search_items'] as const).map((t): [string, (p: P) => Promise<unknown>, Array<[string, P]>] => [
      t,
      viaHandler({ search_accounts: searchQuickbooksAccounts, search_invoices: searchQuickbooksInvoices, search_items: searchQuickbooksItems }[t]),
      [
        ['count: true in criteria', { criteria: { count: true } }],
        ['Count: true in criteria', { criteria: { Count: true } }],
        ['COUNT: true in criteria', { criteria: { COUNT: true } }],
        ['a {field: count} entry', { criteria: [{ field: 'count', value: true }] }],
        ['a record in an array', { criteria: [{ count: true }] }],
      ],
    ]),
    ...([
      ['search_bill_payments', SearchBillPaymentsTool],
      ['search_employees', SearchEmployeesTool],
      ['search_journal_entries', SearchJournalEntriesTool],
      ['search_purchases', SearchPurchasesTool],
    ] as const).map(([t, def]): [string, (p: P) => Promise<unknown>, Array<[string, P]>] => [
      t,
      viaTool(def),
      [
        ['top-level count: true', { count: true }],
        ['a {field: count} entry', { criteria: [{ field: 'count', value: true }] }],
        ['a {field: Count} entry', { criteria: [{ field: 'Count', value: true }] }],
        ['a {field: COUNT} entry', { criteria: [{ field: 'COUNT', value: true }] }],
      ],
    ]),
  ];
  it.each(SEVEN)('%s refuses count in every shape with no request', async (_tool, run, shapes) => {
    for (const [label, params] of shapes) {
      const r = await inCall(() => run(params));
      expect([label, r.failure, r.requests]).toEqual([label, { reason: 'fork-error', text: SENTENCE(COUNT_NO) }, []]);
    }
  });

  const THREE: Array<[string, string, { handler: unknown }, string]> = [
    ['search_bills', 'bill', SearchBillsTool, 'DocNumber'],
    ['search_customers', 'customer', SearchCustomersTool, 'DisplayName'],
    ['search_vendors', 'vendor', SearchVendorsTool, 'DisplayName'],
  ];
  it.each(THREE)('%s: top-level count: true and a lone {key: count|Count} entry send one count query', async (_tool, entity, def) => {
    for (const params of [{ count: true }, { criteria: [{ key: 'count', value: true }] }, { criteria: [{ key: 'Count', value: true }] }]) {
      const r = await inCall(() => viaTool(def)(params), { answers: [{ status: 200, body: { QueryResponse: { totalCount: 3 }, time: 't' } }] });
      expect(r.failure).toBeNull();
      expect(r.queries).toEqual([`select count(*) from ${entity} startposition 1 maxresults 1000`]);
      expect(r.usedOffset).toBe(1);
      expect(r.out).toEqual({ content: [{ type: 'text', text: 'Count: 3' }] });
    }
  });
  it.each(THREE)('%s refuses count: false, count beside a criterion and count beside limit, with no request', async (_tool, _entity, def, field) => {
    const refused: Array<[string, P]> = [
      ['count: false', { count: false }],
      ['a {key: count, value: false} entry', { criteria: [{ key: 'count', value: false }] }],
      ['a {key: Count, value: false} entry', { criteria: [{ key: 'Count', value: false }] }],
      ['count beside a {field} criterion', { criteria: [{ field, value: 'x' }], count: true }],
      ['count beside a {key} criterion', { criteria: [{ key: field, value: 'x' }], count: true }],
      ['count beside limit: 10', { count: true, limit: 10 }],
    ];
    for (const [label, params] of refused) {
      const r = await inCall(() => viaTool(def)(params));
      expect([label, r.failure, r.requests]).toEqual([label, { reason: 'fork-error', text: SENTENCE(COUNT_ONLY) }, []]);
    }
  });
});

describe('the spread tools render each row they get, and their handlers default to no criteria', () => {
  const rows = [{ Id: '1' }, { Id: '2' }];
  it.each([
    ['search_bills', 'bill', SearchBillsTool, searchQuickbooksBills],
    ['search_customers', 'customer', SearchCustomersTool, searchQuickbooksCustomers],
    ['search_vendors', 'vendor', SearchVendorsTool, searchQuickbooksVendors],
  ] as Array<[string, string, { handler: unknown }, () => Promise<ToolResponse<any>>]>)('%s', async (tool, entity, def, handler) => {
    const viaDef = await inCall(() => viaTool(def)({}), { rows });
    expect(viaDef.out).toEqual({
      content: [{ type: 'text', text: `Found 2 ${tool.slice('search_'.length)}:` }, ...rows.map((r) => ({ type: 'text', text: JSON.stringify(r) }))],
    });
    // No params at all, and a {key} entry with a null value (the tool file skips it), each send the plain capped query.
    const noParams = await inCall(() => (def.handler as (a: unknown, e: unknown) => Promise<unknown>)({}, {}), { rows });
    expect(noParams.queries).toEqual([`select * from ${entity} startposition 1 maxresults 1000`]);
    const nullKey = await inCall(() => viaTool(def)({ criteria: [{ key: 'DocNumber', value: null }] }), { rows });
    expect(nullKey.queries).toEqual([`select * from ${entity} startposition 1 maxresults 1000`]);
    const bare = await inCall(() => handler(), { rows });
    expect(bare.out).toEqual({ result: rows, isError: false, error: null });
    expect(bare.queries).toEqual([`select * from ${entity} startposition 1 maxresults 1000`]);
  });
});

describe('D9: search_bill_payments and search_journal_entries return the entity rows, [] when absent', () => {
  const rows = [{ Id: '1' }, { Id: '2' }];
  it.each([
    ['search_bill_payments', searchQuickbooksBillPayments],
    ['search_journal_entries', searchQuickbooksJournalEntries],
  ] as const)('%s', async (_tool, handler) => {
    const some = await inCall(() => handler({}), { rows });
    expect(some.out).toEqual({ result: rows, isError: false, error: null });
    const none = await inCall(() => handler({}), { rows: [] });
    expect(none.out).toEqual({ result: [], isError: false, error: null });
  });
});

describe('a refusal answers the handler error path; the tool file words it as its error', () => {
  it('search_bill_payments', async () => {
    const r = await inCall(() => searchQuickbooksBillPayments({ limit: 0 }));
    expect(r.out).toEqual({ result: null, isError: true, error: SENTENCE(LIMIT) });
    expect(r.requests).toEqual([]);
  });
});

type ReportCase = [string, string, (o: any) => Promise<ToolResponse<any>>, Record<string, 'date' | 'id' | 'period' | 'sort' | 'enum'>];
const REPORTS: ReportCase[] = [
  ['get_aged_payables', 'AgedPayables', getQuickbooksAgedPayables, { report_date: 'date', vendor: 'id', aging_method: 'enum', days_per_aging_period: 'period', num_periods: 'period' }],
  ['get_aged_receivables', 'AgedReceivables', getQuickbooksAgedReceivables, { report_date: 'date', customer: 'id', aging_method: 'enum', days_per_aging_period: 'period', num_periods: 'period' }],
  ['get_balance_sheet', 'BalanceSheet', getQuickbooksBalanceSheet, { start_date: 'date', end_date: 'date', accounting_method: 'enum', summarize_column_by: 'enum' }],
  ['get_cash_flow', 'CashFlow', getQuickbooksCashFlow, { start_date: 'date', end_date: 'date', summarize_column_by: 'enum' }],
  ['get_customer_balance', 'CustomerBalance', getQuickbooksCustomerBalance, { report_date: 'date', customer: 'id', summarize_column_by: 'enum' }],
  ['get_customer_sales', 'CustomerSales', getQuickbooksCustomerSales, { start_date: 'date', end_date: 'date', customer: 'id', summarize_column_by: 'enum' }],
  ['get_general_ledger', 'GeneralLedger', getQuickbooksGeneralLedger, { start_date: 'date', end_date: 'date', accounting_method: 'enum', account: 'id', source_account: 'id', sort_by: 'sort' }],
  ['get_profit_and_loss', 'ProfitAndLoss', getQuickbooksProfitAndLoss, {
    start_date: 'date', end_date: 'date', accounting_method: 'enum', summarize_column_by: 'enum',
    customer: 'id', vendor: 'id', item: 'id', department: 'id', class: 'id',
  }],
  ['get_trial_balance', 'TrialBalance', getQuickbooksTrialBalance, { start_date: 'date', end_date: 'date', accounting_method: 'enum' }],
  ['get_vendor_balance', 'VendorBalance', getQuickbooksVendorBalance, { report_date: 'date', vendor: 'id', summarize_column_by: 'enum' }],
  ['get_vendor_expenses', 'VendorExpenses', getQuickbooksVendorExpenses, { start_date: 'date', end_date: 'date', vendor: 'id', summarize_column_by: 'enum', accounting_method: 'enum' }],
];
// Spec A6.4's refused values per pattern and each one's boundary twin. The enum keys' refusal is the direct normalizer
// case (validate-input.test.ts); here an enum key's accepted value sends one request.
const REFUSED: Record<string, unknown[]> = { date: ['2026-10-01&x=1'], id: ['5#', '1,'], period: [0, 1000, 1.5], sort: ['a b'], enum: [] };
const ACCEPTED: Record<string, unknown[]> = {
  date: ['2026-10-01'],
  id: ['1', '12345678901234567890', '1,2'],
  period: [1, 999],
  sort: ['a'.repeat(64)],
  enum: [],
};
const ENUM_OK: Record<string, string> = { aging_method: 'Report_Date', accounting_method: 'Cash', summarize_column_by: 'Month' };

describe.each(REPORTS)('A6.4 %s', (_tool, name, handler, keys) => {
  it.each(Object.entries(keys))('%s: each refused value is refused with no request; each boundary value sends one', async (key, kind) => {
    for (const v of REFUSED[kind]) {
      const r = await inCall(() => handler({ [key]: v }));
      expect([v, r.out, r.failure, r.requests]).toEqual([v, { result: null, isError: true, error: REPORT(key) }, { reason: 'fork-error', text: REPORT(key) }, []]);
    }
    for (const v of kind === 'enum' ? [ENUM_OK[key]] : ACCEPTED[kind]) {
      const r = await inCall(() => handler({ [key]: v }), { report: { Header: { ReportName: name } } });
      expect([v, r.failure, r.requests.length]).toEqual([v, null, 1]);
      const url = new URL(r.requests[0].path!, 'https://quickbooks.invalid');
      expect(url.pathname).toBe(`/v3/company/${REALM}/reports/${name}`);
      expect(url.searchParams.get(key)).toBe(String(v));
      expect(r.out).toEqual({ result: { Header: { ReportName: name } }, isError: false, error: null });
    }
  });
});

// T13: jest shares node's built-ins across the files a worker runs, so the stub and the trap are put back once this file
// is done (declared last: it runs after every other afterAll here); a later file opening a real socket gets the real ones.
afterAll(() => {
  net.restore();
  trap.restore();
});
