// Sanctuary Computer (quickbooks-mcp-286): the 18 search tools' successes through the started server (spec A5.4, A5.6;
// carried U4). One server for the file (tests/helpers/server.ts: 291's secureStart, 285's startReadServer, an in-memory
// MCP client); the QuickBooks fake answers each query with node-quickbooks' whole answer, `{ QueryResponse: { <Entity>:
// [...] }, time }`, so search_bill_payments and search_journal_entries pass only through their handlers' change (D9).
// Each tool is called with its params from guard-tool-args.json, the rows the fake serves set per case.
import { describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import fs from 'fs';
import { QBO_HOST, fakePath, installNetwork, startServer, type Rig } from '../helpers/server.js';
import type { StubCall } from '../fakes/stub-network.js';
import { READ_ALLOWLIST } from '../../src/tool-lists.js';

const network = installNetwork();
const { net } = network;

const SEARCHES = READ_ALLOWLIST.filter((t) => t.startsWith('search_'));
const ARGS: Record<string, { params: Record<string, unknown> }> = JSON.parse(fs.readFileSync(fakePath('guard-tool-args.json'), 'utf8'));

/** The rows the fake serves, by startposition and maxresults; each case sets them. */
const ROWS: object[] = [];
const serve = (rows: object[]) => ROWS.splice(0, ROWS.length, ...rows);

let rig: Rig;
beforeAll(async () => {
  rig = await startServer({ qbo: { rows: ROWS } });
});
afterEach(() => {
  net.calls.length = 0;
});
afterAll(async () => {
  await rig.close();
  expect(network.trap.reached).toEqual([]);
  network.restore();
});

const isQuery = (c: StubCall) => c.hostname === QBO_HOST && (c.path ?? '').includes('/query?');
const queryOf = (c: StubCall) => new URL(c.path ?? '/', 'https://quickbooks.invalid').searchParams.get('query') ?? '';
const queries = () => net.calls.filter(isQuery).map(queryOf);
const call = (name: string, params: Record<string, unknown>): Promise<any> => rig.client.callTool({ name, arguments: { company: 'garden3d', params } });

// Two built rows, the same for every tool: the first with two Lines (a journal Line's PostingType among them), every
// field the spec names (a bill's DueDate and Balance, a purchase's AccountRef, PaymentType and Credit), another array
// (LinkedTxn) that stays inside its object, and a PrivateNote and a Line Description holding LF, CR and U+2028.
const MEMO = 'memo line one\nline two\rend\u2028after';
const FIRST = {
  Id: '1',
  SyncToken: '0',
  TxnDate: '2026-10-02',
  DueDate: '2026-11-01',
  Balance: 12.5,
  AccountRef: { value: '35', name: 'Operating Card' },
  PaymentType: 'CreditCard',
  Credit: false,
  PrivateNote: MEMO,
  LinkedTxn: [{ TxnId: '9', TxnType: 'Bill' }],
  Line: [
    {
      Id: '1',
      Description: 'first\nsecond\r',
      Amount: 10.25,
      DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '61' } },
    },
    { Id: '2', Amount: 2.25, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '62' } } },
  ],
};
const SECOND = { Id: '2', TotalAmt: 0, Active: true, CustomField: [{ DefinitionId: '1', Name: 'Crew' }] };

/** The search rows back from the data item's lines: `depth` dropped, each depth-1 line put back under its header's `Line`. */
function rebuild(text: string): object[] {
  const rows: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    const { depth, ...rest } = JSON.parse(line);
    if (depth === 0) rows.push(rest);
    else ((rows[rows.length - 1].Line ??= []) as object[]).push(rest);
  }
  return rows;
}

describe.each(SEARCHES)('%s', (tool) => {
  it('A5.4, A5.6: two rows give exactly their lines (header at depth 0, each Line at depth 1, depth last), one data item, no label', async () => {
    serve([FIRST, SECOND]);
    const out = await call(tool, ARGS[tool].params);
    const { Line: lines, ...firstHeader } = FIRST;
    const expected = [
      JSON.stringify({ ...firstHeader, depth: 0 }),
      JSON.stringify({ ...lines[0], depth: 1 }),
      JSON.stringify({ ...lines[1], depth: 1 }),
      JSON.stringify({ ...SECOND, depth: 0 }),
    ];
    expect(out).toStrictEqual({ content: [{ type: 'text', text: expected.join('\n') }] });
    expect(queries()).toHaveLength(1);
  });

  it('A5.4: the lines parse back to the stub\'s rows deep-equal; LF and CR stay escaped on one line, U+2028 raw', async () => {
    serve([FIRST, SECOND]);
    const text: string = (await call(tool, ARGS[tool].params)).content[0].text;
    expect(rebuild(text)).toStrictEqual([FIRST, SECOND]);
    const split = text.split('\n');
    expect(split).toHaveLength(4);
    expect(split[0]).toContain('"PrivateNote":"memo line one\\nline two\\rend\u2028after"');
    expect(split[1]).toContain('"Description":"first\\nsecond\\r"');
    expect(text).not.toContain('\r');
    // Each line ends with depth, after the entity's own keys.
    expect(split.map((l) => Object.keys(JSON.parse(l)).pop())).toEqual(['depth', 'depth', 'depth', 'depth']);
    expect(split.map((l) => JSON.parse(l).depth)).toEqual([0, 1, 1, 0]);
  });

  it('A5.6: no rows give the empty data item ""', async () => {
    serve([]);
    expect(await call(tool, ARGS[tool].params)).toStrictEqual({ content: [{ type: 'text', text: '' }] });
    expect(queries()).toHaveLength(1);
  });
});

// U4: a result over 30,000 is cut with the next 1-based offset. Each built row renders to one 999-character line, so
// with the marker as line 1 exactly 29 of the 50 rows asked from offset 5 fit (29 × 1,000 + the marker ≤ 30,000 <
// 30 × 1,000 + the marker), and the next offset is 5 + 29 = 34.
describe('U4: the next offset a cut search names, one case per accepted offset shape', () => {
  const LINE = 999;
  const pad = LINE - JSON.stringify({ Id: '0000', Memo: '', depth: 0 }).length;
  const BIG = Array.from({ length: 100 }, (_, i) => ({ Id: String(i + 1).padStart(4, '0'), Memo: 'x'.repeat(pad) }));
  const MARKER = 'truncated: 21 of 50 rows left out. Next page: pass offset 34.';
  const MARKER_CRITERIA = 'truncated: 21 of 50 rows left out. Next page: pass offset 34 inside criteria.';
  const filter = { field: 'Id', value: '1' };

  const SHAPES: Array<[string, string, Record<string, unknown>, string]> = [
    ...['search_classes', 'search_credit_memos', 'search_departments', 'search_deposits', 'search_payments', 'search_sales_receipts', 'search_transfers', 'search_vendor_credits'].map(
      (t) => [t, 'top level', { offset: 5, limit: 50 }, MARKER] as [string, string, Record<string, unknown>, string],
    ),
    ...['search_accounts', 'search_invoices', 'search_items'].flatMap((t) => [
      [t, 'criteria object', { criteria: { offset: 5, limit: 50 } }, MARKER_CRITERIA],
      [t, 'criteria object with filters', { criteria: { filters: [filter], offset: 5, limit: 50 } }, MARKER_CRITERIA],
      [t, 'criteria {field,value} entries', { criteria: [{ field: 'offset', value: 5 }, { field: 'limit', value: 50 }] }, MARKER_CRITERIA],
    ] as Array<[string, string, Record<string, unknown>, string]>),
    ...['search_bill_payments', 'search_employees', 'search_journal_entries', 'search_purchases'].flatMap((t) => [
      [t, 'top level', { offset: 5, limit: 50 }, MARKER],
      [t, 'top level beside criteria', { criteria: [filter], offset: 5, limit: 50 }, MARKER],
      [t, 'criteria {field,value} entries', { criteria: [{ field: 'offset', value: 5 }, { field: 'limit', value: 50 }] }, MARKER],
    ] as Array<[string, string, Record<string, unknown>, string]>),
    ...['search_bills', 'search_customers', 'search_vendors'].flatMap((t) => [
      [t, 'top level', { offset: 5, limit: 50 }, MARKER],
      [t, 'top level beside a {field} criterion', { criteria: [filter], offset: 5, limit: 50 }, MARKER],
      [t, 'top level beside a {key} criterion', { criteria: [{ key: 'Id', value: '1' }], offset: 5, limit: 50 }, MARKER],
    ] as Array<[string, string, Record<string, unknown>, string]>),
  ];

  it('the shapes name every search tool', () => {
    expect([...new Set(SHAPES.map(([t]) => t))].sort()).toEqual([...SEARCHES].sort());
  });

  it.each(SHAPES)('%s, offset %s: startposition 5 maxresults 50, then 29 whole rows and "pass offset 34"', async (tool, _shape, params, marker) => {
    serve(BIG);
    const out = await call(tool, params);
    expect(queries()).toEqual([expect.stringMatching(/ startposition 5 maxresults 50$/)]);
    expect(out.content).toHaveLength(1);
    const lines: string[] = out.content[0].text.split('\n');
    expect(lines[0]).toBe(marker);
    expect(lines.slice(1)).toEqual(BIG.slice(4, 33).map((r) => JSON.stringify({ ...r, depth: 0 })));
    expect(lines.slice(1).every((l) => l.length === LINE)).toBe(true);
    expect(out.content[0].text.length).toBeLessThanOrEqual(30000);
  });
});
