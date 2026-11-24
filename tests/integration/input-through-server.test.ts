// Sanctuary Computer (quickbooks-mcp-286): the input checks through the started server (spec A4.7's through-the-server
// arm, A5.3, A5.13, A6.3 per search tool, D9's count form; carried T8-2, T8-4). One server for the file (tests/helpers/
// server.ts), its company warmed in beforeAll, so "no request" is no request at all: the token and the first-use read are
// done. A refusal is compared exactly (`reason: fork-error`, D6's criteria sentence with the code's own <what>); the SDK's
// input error by its `MCP error -32602: Input validation error` prefix (contract §5 `sdk-input`).
import { describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import { z } from 'zod';
import { QBO_HOST, installNetwork, readTools, startServer, type Rig } from '../helpers/server.js';
import type { StubAnswer, StubCall } from '../fakes/stub-network.js';
import { READ_ALLOWLIST } from '../../src/tool-lists.js';
import { CRITERIA_ONLY_TOOLS } from '../../src/helpers/validate-input.js';
import type { ReadTool } from '../../src/allowlist.js';

const network = installNetwork();
const { net } = network;

const SEARCHES = READ_ALLOWLIST.filter((t) => t.startsWith('search_'));
const ROW = { Id: '1', Name: 'Row one' };
const COUNT = 7;

const queryOf = (c: StubCall) => new URL(c.path ?? '/', 'https://quickbooks.invalid').searchParams.get('query') ?? '';
const isQuery = (c: StubCall) => c.hostname === QBO_HOST && (c.path ?? '').includes('/query?');
/** When set, the next query is answered with it (once). */
let nextAnswer: StubAnswer | undefined;
function route(c: StubCall): StubAnswer | undefined {
  if (!isQuery(c)) return undefined;
  if (nextAnswer !== undefined) {
    const a = nextAnswer;
    nextAnswer = undefined;
    return a;
  }
  // node-quickbooks' count statement: QuickBooks answers totalCount.
  if (queryOf(c).startsWith('select count(*) from ')) return { status: 200, body: JSON.stringify({ QueryResponse: { totalCount: COUNT } }) };
  return undefined;
}

// A4.7: get_preferences' handler gives a label alone (no other case here calls it).
const labelOnly = async () => ({ content: [{ type: 'text', text: 'Preferences:' }] });

let rig: Rig;
beforeAll(async () => {
  const tools = (await readTools()).map((t) =>
    t.name === 'get_preferences' ? ({ name: t.name, description: 'd', schema: z.object({}), handler: labelOnly } as unknown as ReadTool) : t,
  );
  rig = await startServer({ qbo: { rows: [ROW] }, route, tools });
  await call('search_classes', {});
  net.calls.length = 0;
});
afterEach(() => {
  net.calls.length = 0;
  nextAnswer = undefined;
});
afterAll(async () => {
  await rig.close();
  expect(network.trap.reached).toEqual([]);
  network.restore();
});

type P = Record<string, unknown>;
const call = (name: string, params: P | undefined): Promise<any> =>
  rig.client.callTool({ name, arguments: params === undefined ? { company: 'garden3d' } : { company: 'garden3d', params } });

const SENTENCE = (what: string) => `The search was refused before reaching QuickBooks: ${what}. Use limit up to 1000 and page with offset.`;
const refused = (what: string) => ({ content: [{ type: 'text', text: `reason: fork-error\n\n${SENTENCE(what)}` }], isError: true });
const FORK_ERROR = { content: [{ type: 'text', text: 'reason: fork-error\n\nThe server failed before it could read QuickBooks.' }], isError: true };
const OFFSET = 'offset must be a whole number of at least 1';
const FETCH_ALL = "fetchAll isn't supported";
// T8-2: D9's count sentence is false on the three that have the count form; these are the code's words (validate-input.ts).
const COUNT_NO = "count isn't supported by this tool";
const COUNT_ONLY = 'count is supported only as count: true with no other criterion and no page key';
const SDK_INPUT = (tool: string) => `MCP error -32602: Input validation error: Invalid arguments for tool ${tool}`;
const ROW_LINE = JSON.stringify({ ...ROW, depth: 0 });

/** The result is exactly the refusal of `what`, and no request went. */
async function expectRefused(out: Promise<any>, what: string): Promise<void> {
  expect(await out).toStrictEqual(refused(what));
  expect(net.calls).toEqual([]);
}
/** The result is the SDK's input error for `tool` (one text item, by prefix), and no request went. */
async function expectSdk(out: Promise<any>, tool: string): Promise<void> {
  const r = await out;
  expect(r.isError).toBe(true);
  expect(r.content).toHaveLength(1);
  expect(r.content[0].text.startsWith(SDK_INPUT(tool))).toBe(true);
  expect(net.calls).toEqual([]);
}
/** Exactly one request went, a query; its statement. */
function oneQuery(): string {
  expect(net.calls).toHaveLength(1);
  expect(isQuery(net.calls[0])).toBe(true);
  return queryOf(net.calls[0]);
}

type Family = 'criteria' | 'top' | 'spread' | 'fixed';
type Tool = { family: Family; entity: string; field: string; good: string; qbField?: string; keys?: string };
/** Per search tool: its shape family, its entity, a field it filters on and a value that field accepts. */
const TOOLS: Record<string, Tool> = {
  search_accounts: { family: 'criteria', entity: 'account', field: 'Name', good: 'Cash' },
  search_invoices: { family: 'criteria', entity: 'invoice', field: 'DocNumber', good: '1001' },
  search_items: { family: 'criteria', entity: 'item', field: 'Name', good: 'Widget' },
  search_bill_payments: { family: 'top', entity: 'billPayment', field: 'DocNumber', good: '7' },
  search_employees: { family: 'top', entity: 'employee', field: 'DisplayName', good: 'Ann' },
  search_journal_entries: { family: 'top', entity: 'journalEntry', field: 'DocNumber', good: '8' },
  search_purchases: { family: 'top', entity: 'purchase', field: 'TxnDate', good: '2026-10-01' },
  search_bills: { family: 'spread', entity: 'bill', field: 'DocNumber', good: '9' },
  search_customers: { family: 'spread', entity: 'customer', field: 'DisplayName', good: 'Ann' },
  search_vendors: { family: 'spread', entity: 'vendor', field: 'DisplayName', good: 'Acme' },
  // The 8 fixed-schema tools: a string field of the schema, the QuickBooks field it fills, the schema's keys (sorted).
  search_classes: { family: 'fixed', entity: 'class', field: 'name', qbField: 'Name', good: 'Ops', keys: 'active, limit, name, offset' },
  search_credit_memos: { family: 'fixed', entity: 'creditMemo', field: 'customer_ref', qbField: 'CustomerRef', good: '12', keys: 'customer_ref, limit, offset, txn_date_from, txn_date_to' },
  search_departments: { family: 'fixed', entity: 'department', field: 'name', qbField: 'Name', good: 'Studio', keys: 'active, limit, name, offset' },
  search_deposits: { family: 'fixed', entity: 'deposit', field: 'txn_date_from', qbField: 'TxnDate', good: '2026-10-01', keys: 'limit, offset, txn_date_from, txn_date_to' },
  search_payments: { family: 'fixed', entity: 'payment', field: 'customer_ref', qbField: 'CustomerRef', good: '12', keys: 'customer_ref, limit, offset, txn_date_from, txn_date_to' },
  search_sales_receipts: { family: 'fixed', entity: 'salesReceipt', field: 'customer_ref', qbField: 'CustomerRef', good: '12', keys: 'customer_ref, limit, offset, txn_date_from, txn_date_to' },
  search_transfers: { family: 'fixed', entity: 'transfer', field: 'txn_date_from', qbField: 'TxnDate', good: '2026-10-01', keys: 'limit, offset, txn_date_from, txn_date_to' },
  search_vendor_credits: { family: 'fixed', entity: 'vendorCredit', field: 'vendor_ref', qbField: 'VendorRef', good: '12', keys: 'limit, offset, vendor_ref' },
};

/** A filter on the tool's field with `value`, in a shape the tool's schema lets through. */
function filterOn(tool: string, value: unknown): P {
  const t = TOOLS[tool];
  if (t.family === 'criteria') return { criteria: { [t.field]: value } };
  if (t.family === 'fixed') return { [t.field]: value };
  return { criteria: [{ field: t.field, value }] };
}
/** `key: value` where the tool takes its page keys: inside criteria for the three, top level for the others. */
const pageKey = (tool: string, key: string, value: unknown): P => (TOOLS[tool].family === 'criteria' ? { criteria: { [key]: value } } : { [key]: value });
/** RegisterTool's warning for unknown keys on a tool whose schema's keys are `keys`. */
const stripWarning = (tool: string, extras: string[], keys: string) =>
  `WARNING: ${tool} does not support ${extras.length === 1 ? 'this parameter' : 'these parameters'}: ${extras.join(', ')}. ` +
  `${extras.length === 1 ? 'It was' : 'They were'} IGNORED - the value did not reach QuickBooks. Supported parameters: ${keys}.`;

it('the tool table names the 18 search tools, and the criteria family is CRITERIA_ONLY_TOOLS', () => {
  expect(Object.keys(TOOLS).sort()).toEqual([...SEARCHES].sort());
  expect(SEARCHES).toHaveLength(18);
  expect(Object.keys(TOOLS).filter((t) => TOOLS[t].family === 'criteria').sort()).toEqual([...CRITERIA_ONLY_TOOLS].sort());
});

describe.each(SEARCHES)('%s', (tool) => {
  const t = TOOLS[tool];
  const named = t.qbField ?? t.field;

  it('A6.3: a value ending in a backslash is refused with no request; its accepted twin sends one query carrying it', async () => {
    await expectRefused(call(tool, filterOn(tool, `${t.good}\\`)), `the value for ${named} isn't valid`);
    const out = await call(tool, filterOn(tool, t.good));
    expect(out).toStrictEqual({ content: [{ type: 'text', text: ROW_LINE }] });
    const q = oneQuery();
    expect(q.startsWith(`select * from ${t.entity} where `)).toBe(true);
    expect(q).toContain(`'${t.good}'`);
  });

  it('A6.3: a value holding a control character is refused with no request; a plain inner space is accepted', async () => {
    await expectRefused(call(tool, filterOn(tool, 'a\u0001b')), `the value for ${named} isn't valid`);
    await call(tool, filterOn(tool, 'a b'));
    expect(oneQuery()).toContain("'a b'");
  });

  it.each([0, 1.5, '2'])('A5.13, A6.3: offset %j is refused with no request', async (n) => {
    // The 8's schemas take offset as an integer >= 1, and the 7 others' top-level offset is a number: the SDK refuses
    // what its schema refuses; the normalizer refuses the rest (the three's offset sits inside criteria, a z.any()).
    const sdk = t.family === 'fixed' || (t.family !== 'criteria' && typeof n === 'string');
    if (sdk) await expectSdk(call(tool, pageKey(tool, 'offset', n)), tool);
    else await expectRefused(call(tool, pageKey(tool, 'offset', n)), OFFSET);
  });

  it('A5.13: offset 3 is the request\'s startposition 3, before maxresults 1000', async () => {
    await call(tool, pageKey(tool, 'offset', 3));
    expect(oneQuery()).toMatch(/ startposition 3 maxresults 1000$/);
  });

  if (t.family === 'fixed') {
    it('A5.3: a top-level fetchAll is stripped with its WARNING: item after the data item; exactly one query, maxresults 1000', async () => {
      const out = await call(tool, { fetchAll: true });
      expect(out).toStrictEqual({ content: [{ type: 'text', text: ROW_LINE }, { type: 'text', text: stripWarning(tool, ['fetchAll'], t.keys!) }] });
      expect(oneQuery()).toBe(`select * from ${t.entity} startposition 1 maxresults 1000`);
    });

    it('A6.3, D9: a top-level count is stripped with its WARNING: item; exactly one query, not a count', async () => {
      const out = await call(tool, { count: true });
      expect(out).toStrictEqual({ content: [{ type: 'text', text: ROW_LINE }, { type: 'text', text: stripWarning(tool, ['count'], t.keys!) }] });
      expect(oneQuery()).toBe(`select * from ${t.entity} startposition 1 maxresults 1000`);
    });

    it('A5.3, A6.3: fetchAll and count together are one warning naming both; exactly one query', async () => {
      const out = await call(tool, { fetchAll: true, count: false, [t.field]: t.good });
      expect(out.content).toStrictEqual([{ type: 'text', text: ROW_LINE }, { type: 'text', text: stripWarning(tool, ['fetchAll', 'count'], t.keys!) }]);
      expect(oneQuery()).toContain(`'${t.good}'`);
    });
  } else {
    it('A5.3: fetchAll: true where the tool takes it is refused with no request', async () => {
      await expectRefused(call(tool, pageKey(tool, 'fetchAll', true)), FETCH_ALL);
    });
  }

  if (t.family === 'spread') {
    it.each([
      ['top level', { count: true }],
      ["a lone {key: 'count'} entry", { criteria: [{ key: 'count', value: true }] }],
      ["a lone {key: 'Count'} entry", { criteria: [{ key: 'Count', value: true }] }],
    ])('A6.3, D9: count: true as %s answers the compact line {"count":7}; one count query', async (_label, params) => {
      expect(await call(tool, params)).toStrictEqual({ content: [{ type: 'text', text: `{"count":${COUNT}}` }] });
      expect(oneQuery()).toBe(`select count(*) from ${t.entity} startposition 1 maxresults 1000`);
    });

    it('A5.6, D9: the count form with an unknown key is {"count":7}, then the WARNING: item', async () => {
      const out = await call(tool, { count: true, extra: 1 });
      expect(out).toStrictEqual({
        content: [{ type: 'text', text: `{"count":${COUNT}}` }, { type: 'text', text: stripWarning(tool, ['extra'], 'asc, count, criteria, desc, fetchAll, limit, offset') }],
      });
      oneQuery();
    });

    it.each([
      ['count: false top level', { count: false }],
      ["{key: 'count', value: false}", { criteria: [{ key: 'count', value: false }] }],
      ["{key: 'Count', value: false}", { criteria: [{ key: 'Count', value: false }] }],
      ['count beside a {field} criterion', { criteria: [{ field: 'Id', value: '1' }], count: true }],
      ['count beside a {key} criterion', { criteria: [{ key: 'Id', value: '1' }], count: true }],
      ['count beside limit: 10', { count: true, limit: 10 }],
    ])("T8-2: %s is refused with no request, in the code's count sentence", async (_label, params) => {
      await expectRefused(call(tool, params), COUNT_ONLY);
    });

    it("D9: a {field: 'count'} entry is the SDK's -32602 (by prefix), with no request", async () => {
      await expectSdk(call(tool, { criteria: [{ field: 'count', value: true }] }), tool);
    });
  }

  if (t.family === 'top') {
    it.each([
      ['top level', { count: true }],
      ['a {field} entry', { criteria: [{ field: 'count', value: true }] }],
      ['a {field} entry, any case', { criteria: [{ field: 'COUNT', value: true }] }],
    ])("A6.3, D9: count: true as %s is refused with no request (count isn't supported)", async (_label, params) => {
      await expectRefused(call(tool, params), COUNT_NO);
    });
  }

  if (t.family === 'criteria') {
    it.each(['count', 'Count', 'COUNT'])("A6.3, D9: %s: true inside criteria is refused with no request (count isn't supported)", async (key) => {
      await expectRefused(call(tool, { criteria: { [key]: true } }), COUNT_NO);
      await expectRefused(call(tool, { criteria: [{ field: key, value: true }] }), COUNT_NO);
    });
  }
});

describe("A4.7: the three criteria tools' own check, through the server", () => {
  it.each([...CRITERIA_ONLY_TOOLS])("%s: criteria a string, then a number: the tool file's Invalid criteria text answers fork-error, no request", async (tool) => {
    for (const criteria of ['x', 5]) {
      expect([criteria, await call(tool, { criteria })]).toStrictEqual([criteria, FORK_ERROR]);
      expect(net.calls).toEqual([]);
    }
  });

  // Ruling 1: at the pinned SDK (1.32.2, zod 4.6.7) the schema `z.object({ criteria: z.any() })` makes criteria
  // required, so an omitted criteria is the SDK's -32602 before the handler.
  it.each([...CRITERIA_ONLY_TOOLS])("%s: criteria omitted is the SDK's -32602 (by prefix), no request", async (tool) => {
    await expectSdk(call(tool, {}), tool);
  });

  it('a label-only result on get_preferences is fork-error', async () => {
    expect(await call('get_preferences', {})).toStrictEqual(FORK_ERROR);
  });
});

// T8-4: the three through their own tool files: RUNTIME_CRITERIA_SCHEMA's three arms, normalizeAccountCriteria's three
// branches, the success label ("Found 1 accounts:", "Found 1 invoices") dropped, and the tool file's `Error searching …`
// text answered as the call's recorded failure.
describe('T8-4: search_accounts, search_invoices, search_items through their tool files', () => {
  const SHAPES: Array<[string, string, P, string]> = [
    ['search_accounts', 'a plain record (coerced: Active "true" to true)', { criteria: { Active: 'true' } }, 'select * from account where Active = true startposition 1 maxresults 1000'],
    ['search_accounts', 'an array of records (each coerced)', { criteria: [{ CurrentBalance: '5' }] }, 'select * from account where CurrentBalance = 5 startposition 1 maxresults 1000'],
    ['search_accounts', 'advanced filters (each value coerced)', { criteria: { filters: [{ field: 'SubAccount', value: 1 }], limit: 2 } }, 'select * from account where SubAccount = true startposition 1 maxresults 2'],
    ['search_accounts', 'a field the type map lacks (passed as given)', { criteria: { Bogus: 'x' } }, "select * from account where Bogus = 'x' startposition 1 maxresults 1000"],
    ['search_invoices', 'a plain record', { criteria: { DocNumber: '1001' } }, "select * from invoice where DocNumber = '1001' startposition 1 maxresults 1000"],
    ['search_invoices', 'an array of records', { criteria: [{ DocNumber: '1001' }] }, "select * from invoice where DocNumber = '1001' startposition 1 maxresults 1000"],
    ['search_invoices', 'advanced filters', { criteria: { filters: [{ field: 'Balance', value: 3, operator: '>' }] } }, 'select * from invoice where Balance > 3 startposition 1 maxresults 1000'],
    ['search_items', 'a plain record', { criteria: { Name: 'Widget' } }, "select * from item where Name = 'Widget' startposition 1 maxresults 1000"],
    ['search_items', 'an array of records', { criteria: [{ Name: 'Widget' }] }, "select * from item where Name = 'Widget' startposition 1 maxresults 1000"],
    ['search_items', 'advanced filters', { criteria: { filters: [{ field: 'Active', value: true }] } }, 'select * from item where Active = true startposition 1 maxresults 1000'],
  ];

  it.each(SHAPES)('%s, %s: the row\'s line, one query: %s', async (tool, _label, params, statement) => {
    expect(await call(tool, params)).toStrictEqual({ content: [{ type: 'text', text: ROW_LINE }] });
    expect(oneQuery()).toBe(statement);
  });

  it.each([...CRITERIA_ONLY_TOOLS])("%s: QuickBooks' 500 (the tool file's Error searching text) answers http-500", async (tool) => {
    nextAnswer = { status: 500, body: JSON.stringify({ Fault: { Error: [{ Message: 'boom' }] } }) };
    expect(await call(tool, { criteria: {} })).toStrictEqual({ content: [{ type: 'text', text: 'reason: http-500\n\nQuickBooks answered 500.' }], isError: true });
    oneQuery();
  });

  it.each([...CRITERIA_ONLY_TOOLS])('%s: no rows: the label alone gives the empty data item ""', async (tool) => {
    nextAnswer = { status: 200, body: JSON.stringify({ QueryResponse: {}, time: '2026-11-18T00:00:00.000Z' }) };
    expect(await call(tool, { criteria: {} })).toStrictEqual({ content: [{ type: 'text', text: '' }] });
  });
});

// TB12-1, TB12-2: search_accounts' coercion runs after the normalizer has judged the values as sent, and converts only a
// value's exact other spelling. Each value A6.3 refuses on a mapped field is refused in each of the tool file's three
// shapes, with no request; each arm of the coercion has a case naming the statement it sends.
describe('TB12-1, TB12-2: search_accounts checks the values as sent, then coerces only what keeps its meaning', () => {
  /** `{ field: value }` in each of the tool file's three shapes. */
  const shapes = (field: string, value: unknown): Array<[string, P]> => [
    ['a plain record', { criteria: { [field]: value } }],
    ['an array of records', { criteria: [{ [field]: value }] }],
    ['advanced filters', { criteria: { filters: [{ field, value }] } }],
  ];
  const REFUSED: Array<[string, unknown]> = [
    ['Active', null],
    ['Active', { a: 1 }],
    ['Active', [['true']]],
    ['CurrentBalance', null],
    ['CurrentBalance', { a: 1 }],
    // 201 characters: refused as sent, though Number() would make it 5.
    ['CurrentBalance', `${'0'.repeat(200)}5`],
    ['Name', null],
    ['Name', { a: 1 }],
    ['Name', [['x']]],
    ['MetaData.CreateTime', null],
  ];
  const CASES = REFUSED.flatMap(([field, value]) => shapes(field, value).map(([shape, params]) => [field, JSON.stringify(value).slice(0, 40), shape, params] as const));

  it.each(CASES)('%s %s as %s is refused with no request', async (field, _value, _shape, params) => {
    await expectRefused(call('search_accounts', params), `the value for ${field} isn't valid`);
  });

  const where = (clause: string) => `select * from account where ${clause} startposition 1 maxresults 1000`;
  const ARMS: Array<[string, string, unknown, string]> = [
    ['boolean', 'Active', 'true', 'Active = true'],
    ['boolean', 'Active', '1', 'Active = true'],
    ['boolean', 'Active', 1, 'Active = true'],
    ['boolean', 'Active', true, 'Active = true'],
    ['boolean', 'Active', 'false', 'Active = false'],
    ['boolean', 'Active', '0', 'Active = false'],
    ['boolean', 'Active', 0, 'Active = false'],
    ['boolean, another spelling passed as given', 'Active', 'yes', "Active = 'yes'"],
    ['boolean, another number passed as given', 'Active', 2, 'Active = 2'],
    ['number', 'CurrentBalance', '5', 'CurrentBalance = 5'],
    ['number', 'CurrentBalance', '-2.5', 'CurrentBalance = -2.5'],
    ['number, a number given', 'CurrentBalance', 7, 'CurrentBalance = 7'],
    ['number, an empty string passed as given', 'CurrentBalance', '', "CurrentBalance = ''"],
    ['number, a boolean passed as given', 'CurrentBalance', true, 'CurrentBalance = true'],
    ['number, not a number passed as given', 'CurrentBalance', '5x', "CurrentBalance = '5x'"],
    ['string, a number given', 'Name', 5, "Name = '5'"],
    ['string', 'Name', 'Cash', "Name = 'Cash'"],
    ['string, a boolean passed as given', 'Name', true, 'Name = true'],
    ['date', 'MetaData.CreateTime', '2026-10-01', "MetaData.CreateTime = '2026-10-01'"],
    ['date, a number given', 'MetaData.CreateTime', 20261001, "MetaData.CreateTime = '20261001'"],
    ['date, a boolean passed as given', 'MetaData.CreateTime', false, 'MetaData.CreateTime = false'],
  ];
  const ARM_CASES = ARMS.flatMap(([arm, field, value, clause]) => shapes(field, value).map(([shape, params]) => [arm, field, JSON.stringify(value), shape, params, clause] as const));

  it.each(ARM_CASES)('%s arm: %s %s as %s sends exactly its filter', async (_arm, _field, _value, _shape, params, clause) => {
    expect(await call('search_accounts', params)).toStrictEqual({ content: [{ type: 'text', text: ROW_LINE }] });
    expect(oneQuery()).toBe(where(clause));
  });

  it.each([
    ['a plain record', { criteria: { Active: ['true', '0', 1] } }],
    ['an array of records', { criteria: [{ Active: ['true', '0', 1] }] }],
    ['advanced filters', { criteria: { filters: [{ field: 'Active', value: ['true', '0', 1], operator: 'IN' }] } }],
  ])('an array value as %s is converted element by element', async (_shape, params) => {
    await call('search_accounts', params);
    expect(oneQuery()).toBe(where('Active IN (true,false,true)'));
  });
});

// T12 fix 1b: on the 8 fixed-schema searches, a string filter given as "" reaches the request as that filter, written in
// the query's quoted form as a non-empty string is; and on the three count tools a list mixing {field} and {key}
// criteria is refused (the tool file folded it by its first element's form, so the other form's entries went out as
// other filters).
describe('T12 fix 1b: an empty-string filter on the 8 fixed-schema searches reaches the request, never dropped', () => {
  const EMPTY: Array<[string, string, string]> = [
    ['search_classes', 'name', "Name = ''"],
    ['search_departments', 'name', "Name = ''"],
    ['search_credit_memos', 'customer_ref', "CustomerRef = ''"],
    ['search_credit_memos', 'txn_date_from', "TxnDate >= ''"],
    ['search_credit_memos', 'txn_date_to', "TxnDate <= ''"],
    ['search_payments', 'customer_ref', "CustomerRef = ''"],
    ['search_payments', 'txn_date_from', "TxnDate >= ''"],
    ['search_payments', 'txn_date_to', "TxnDate <= ''"],
    ['search_sales_receipts', 'customer_ref', "CustomerRef = ''"],
    ['search_sales_receipts', 'txn_date_from', "TxnDate >= ''"],
    ['search_sales_receipts', 'txn_date_to', "TxnDate <= ''"],
    ['search_deposits', 'txn_date_from', "TxnDate >= ''"],
    ['search_deposits', 'txn_date_to', "TxnDate <= ''"],
    ['search_transfers', 'txn_date_from', "TxnDate >= ''"],
    ['search_transfers', 'txn_date_to', "TxnDate <= ''"],
    ['search_vendor_credits', 'vendor_ref', "VendorRef = ''"],
  ];

  it('the table names every string field of the 8 fixed-schema tools', () => {
    const fixed = Object.keys(TOOLS).filter((t) => TOOLS[t].family === 'fixed');
    const strings = fixed.flatMap((t) => TOOLS[t].keys!.split(', ').filter((k) => !['active', 'limit', 'offset'].includes(k)).map((k) => `${t} ${k}`));
    expect(EMPTY.map(([t, f]) => `${t} ${f}`).sort()).toEqual(strings.sort());
  });

  it.each(EMPTY)('%s %s: "" sends exactly the filter %s', async (tool, field, clause) => {
    expect(await call(tool, { [field]: '' })).toStrictEqual({ content: [{ type: 'text', text: ROW_LINE }] });
    expect(oneQuery()).toBe(`select * from ${TOOLS[tool].entity} where ${clause} startposition 1 maxresults 1000`);
  });

  it.each(['search_classes', 'search_departments'])('%s: active false sends exactly Active = false', async (tool) => {
    await call(tool, { active: false });
    expect(oneQuery()).toBe(`select * from ${TOOLS[tool].entity} where Active = false startposition 1 maxresults 1000`);
  });
});

describe('T12 fix 1b: a list mixing {field} and {key} criteria on the three count tools is refused', () => {
  const MIXED = "give every criterion as {field, value} or every one as {key, value}, not both";
  it.each(['search_bills', 'search_customers', 'search_vendors'])('%s: either order is refused with no request', async (tool) => {
    await expectRefused(call(tool, { criteria: [{ field: 'Id', value: '1' }, { key: 'DocNumber', value: '9' }] }), MIXED);
    await expectRefused(call(tool, { criteria: [{ key: 'DocNumber', value: '9' }, { field: 'Id', value: '1' }] }), MIXED);
  });

  it.each(['search_bills', 'search_customers', 'search_vendors'])('%s: a {key} list with an empty value sends it as that filter', async (tool) => {
    await call(tool, { criteria: [{ key: 'DocNumber', value: '' }] });
    expect(oneQuery()).toBe(`select * from ${TOOLS[tool].entity} where DocNumber = '' startposition 1 maxresults 1000`);
  });
});
