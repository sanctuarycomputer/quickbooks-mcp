// Sanctuary Computer (quickbooks-mcp-286): the 11 report tools through the started server (spec A5.5's per-tool half,
// A6.4 per report tool and key). One server for the file (tests/helpers/server.ts); the QuickBooks fake answers each
// reports/<Name> request with the report the case sets. A refusal is compared exactly (`reason: fork-error`, D6's report
// sentence) with no request at all: the company is warmed in beforeAll, so its token and first-use read are done.
import { describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import fs from 'fs';
import { QBO_HOST, fakePath, installNetwork, startServer, type Rig } from '../helpers/server.js';
import type { StubCall } from '../fakes/stub-network.js';
import { REPORT_TOOLS } from '../../src/helpers/validate-input.js';

const network = installNetwork();
const { net } = network;

const readFake = (name: string): any => JSON.parse(fs.readFileSync(fakePath(name), 'utf8'));
const PNL = readFake('render/ProfitAndLoss.json');
const PNL_OK = readFake('tool-results/get_profit_and_loss/ok.json');

/** The report the fake serves; each case sets it. */
let report: unknown = PNL;
let rig: Rig;
beforeAll(async () => {
  rig = await startServer({
    route: (c) => (c.hostname === QBO_HOST && (c.path ?? '').includes('/reports/') ? { status: 200, body: JSON.stringify(report) } : undefined),
  });
  await call('get_trial_balance', {});
  net.calls.length = 0;
});
afterEach(() => {
  net.calls.length = 0;
});
afterAll(async () => {
  await rig.close();
  expect(network.trap.reached).toEqual([]);
  network.restore();
});

const call = (name: string, params: Record<string, unknown>): Promise<any> => rig.client.callTool({ name, arguments: { company: 'garden3d', params } });
const urlOf = (c: StubCall) => new URL(c.path ?? '/', 'https://quickbooks.invalid');

/** Each report tool's QuickBooks report name (contract §6's reports/<Name> rule). */
const NAMES: Record<string, string> = {
  get_aged_payables: 'AgedPayables',
  get_aged_receivables: 'AgedReceivables',
  get_balance_sheet: 'BalanceSheet',
  get_cash_flow: 'CashFlow',
  get_customer_balance: 'CustomerBalance',
  get_customer_sales: 'CustomerSales',
  get_general_ledger: 'GeneralLedger',
  get_profit_and_loss: 'ProfitAndLoss',
  get_trial_balance: 'TrialBalance',
  get_vendor_balance: 'VendorBalance',
  get_vendor_expenses: 'VendorExpenses',
};

/** The one request a call sent: reports/<its Name>, with the keys given. */
function expectOneReport(tool: string): URL {
  expect(net.calls).toHaveLength(1);
  const url = urlOf(net.calls[0]);
  expect(url.pathname).toBe(`/v3/company/9990000000000002/reports/${NAMES[tool]}`);
  return url;
}

// A nested P&L by month: 13 columns (the account, 11 months, the total), sections two deep, each value distinct.
const COLUMNS = {
  Column: [
    { ColTitle: '', ColType: 'Account', MetaData: [{ Name: 'ColKey', Value: 'account' }] },
    ...Array.from({ length: 11 }, (_, i) => ({ ColTitle: `2026-${String(i + 1).padStart(2, '0')}`, ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: `m${i + 1}` }] })),
    { ColTitle: 'Total', ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: 'total' }] },
  ],
};
const cells = (label: string, base: number) => ({ ColData: [{ value: label, id: String(base) }, ...Array.from({ length: 12 }, (_, i) => ({ value: (base + i * 0.01).toFixed(2) }))] });
const data = (label: string, base: number) => ({ ...cells(label, base), type: 'Data' });
const BY_MONTH = {
  Header: { ReportName: 'ProfitAndLoss', StartPeriod: '2026-01-01', EndPeriod: '2026-11-30', SummarizeColumnsBy: 'Month', Currency: 'USD' },
  Columns: COLUMNS,
  Rows: {
    Row: [
      {
        Header: cells('Income', 100),
        Rows: {
          Row: [
            { Header: cells('Services', 110), Rows: { Row: [data('Design', 111), data('Development', 112)] }, Summary: cells('Total Services', 119), type: 'Section', group: 'Services' },
            data('Other Income', 120),
          ],
        },
        Summary: cells('Total Income', 199),
        type: 'Section',
        group: 'Income',
      },
      { Header: cells('Expenses', 200), Rows: { Row: [data('Rent', 201)] }, Summary: cells('Total Expenses', 299), type: 'Section', group: 'Expenses' },
      { Summary: cells('Net Income', 300), type: 'Section', group: 'NetIncome' },
    ],
  },
};
const NO_DATA = {
  Header: { ReportName: 'ProfitAndLoss', StartPeriod: '2026-10-01', EndPeriod: '2026-10-31', Option: [{ Name: 'NoReportData', Value: 'true' }] },
  Columns: { Column: [{ ColTitle: '', ColType: 'Account' }, { ColTitle: 'Total', ColType: 'Money' }] },
};

/** The report back from its lines: Header, Columns, then each row put under the last row one depth up. */
function rebuild(lines: string[]): Record<string, unknown> {
  const [header, columns, ...rows] = lines.map((l) => JSON.parse(l));
  const out: Record<string, unknown> = { Header: header, Columns: columns };
  const top: unknown[] = [];
  const stack: Array<Record<string, any>> = [];
  for (const { depth, ...row } of rows) {
    stack.length = depth;
    if (depth === 0) top.push(row);
    else ((stack[depth - 1].Rows ??= { Row: [] }).Row as unknown[]).push(row);
    stack.push(row);
  }
  if (rows.length > 0) out.Rows = { Row: top };
  return out;
}
const numbers = (s: string) => new Set(s.match(/-?\d+(?:\.\d+)?/g) ?? []);

describe.each([...REPORT_TOOLS])('%s', (tool) => {
  it("A5.5: render/ProfitAndLoss.json served gives get_profit_and_loss/ok.json exactly: Header, Columns, rows by depth", async () => {
    report = PNL;
    expect(await call(tool, {})).toStrictEqual(PNL_OK);
    expectOneReport(tool);
  });

  it('A5.5: a nested P&L by month (13 columns, sections two deep) round-trips; no number that is not in the stub', async () => {
    report = BY_MONTH;
    const out = await call(tool, tool === 'get_profit_and_loss' ? { summarize_column_by: 'Month' } : {});
    expect(out.isError).toBeUndefined();
    expect(out.content).toHaveLength(1);
    const lines: string[] = out.content[0].text.split('\n');
    expect(lines[0]).toBe(JSON.stringify(BY_MONTH.Header));
    expect(lines[1]).toBe(JSON.stringify(COLUMNS));
    // Depth first in document order: Income, Services, Design, Development, Other Income, Expenses, Rent, Net Income.
    expect(lines.slice(2).map((l) => JSON.parse(l).depth)).toEqual([0, 1, 2, 2, 1, 0, 1, 0]);
    expect(lines.slice(2).every((l) => Object.keys(JSON.parse(l)).pop() === 'depth')).toBe(true);
    expect(rebuild(lines)).toStrictEqual(BY_MONTH);
    const stub = numbers(JSON.stringify(BY_MONTH));
    const shown = numbers(out.content[0].text.replace(/,"depth":\d+/g, ''));
    expect([...shown].filter((n) => !stub.has(n))).toEqual([]);
  });

  it('A5.5: a report with NoReportData and no Rows is lines 1 and 2 only', async () => {
    report = NO_DATA;
    expect(await call(tool, {})).toStrictEqual({ content: [{ type: 'text', text: `${JSON.stringify(NO_DATA.Header)}\n${JSON.stringify(NO_DATA.Columns)}` }] });
  });
});

// A6.4: every key of every report tool (contract §6's Report query keys), each refused value and each boundary value.
type Kind = 'date' | 'id' | 'periods' | 'sort' | 'method' | 'summarize' | 'aging';
const KEYS: Record<string, Record<string, Kind>> = {
  get_aged_payables: { report_date: 'date', vendor: 'id', aging_method: 'aging', days_per_aging_period: 'periods', num_periods: 'periods' },
  get_aged_receivables: { report_date: 'date', customer: 'id', aging_method: 'aging', days_per_aging_period: 'periods', num_periods: 'periods' },
  get_balance_sheet: { start_date: 'date', end_date: 'date', accounting_method: 'method', summarize_column_by: 'summarize' },
  get_cash_flow: { start_date: 'date', end_date: 'date', summarize_column_by: 'summarize' },
  get_customer_balance: { report_date: 'date', customer: 'id', summarize_column_by: 'summarize' },
  get_customer_sales: { start_date: 'date', end_date: 'date', customer: 'id', summarize_column_by: 'summarize' },
  get_general_ledger: { start_date: 'date', end_date: 'date', accounting_method: 'method', account: 'id', source_account: 'id', sort_by: 'sort' },
  get_profit_and_loss: {
    start_date: 'date',
    end_date: 'date',
    accounting_method: 'method',
    summarize_column_by: 'summarize',
    customer: 'id',
    vendor: 'id',
    item: 'id',
    department: 'id',
    class: 'id',
  },
  get_trial_balance: { start_date: 'date', end_date: 'date', accounting_method: 'method' },
  get_vendor_balance: { report_date: 'date', vendor: 'id', summarize_column_by: 'summarize' },
  get_vendor_expenses: { start_date: 'date', end_date: 'date', vendor: 'id', summarize_column_by: 'summarize', accounting_method: 'method' },
};
const SUMMARIZE = ['Total', 'Month', 'Week', 'Days'];
/** Per kind: the values the normalizer refuses (D6's sentence), and the boundary values that pass with one request. */
const VALUES: Record<Kind, { refused: unknown[]; accepted: unknown[] }> = {
  date: { refused: ['2026-10-01&x=1', '2026-10-1', '2026-10-01 '], accepted: ['2026-10-01'] },
  id: { refused: ['5#', '1,', '1=2', '%31', '123456789012345678901'], accepted: ['1', '1,22', '12345678901234567890'] },
  periods: { refused: [0, 1000, 1.5], accepted: [1, 999] },
  sort: { refused: ['a b', 'tx-date', 'A'.repeat(65)], accepted: ['tx_date', 'A'.repeat(64)] },
  method: { refused: [], accepted: ['Cash', 'Accrual'] },
  summarize: { refused: [], accepted: SUMMARIZE },
  aging: { refused: [], accepted: ['Current', 'Report_Date'] },
};
const ENUM_KINDS: readonly Kind[] = ['method', 'summarize', 'aging'];
const REFUSAL = (key: string) => `reason: fork-error\n\nThe report was refused before reaching QuickBooks: ${key} isn't a valid value.`;
const SDK_INPUT = (tool: string) => `MCP error -32602: Input validation error: Invalid arguments for tool ${tool}`;

describe('A6.4: report-option values through the server, per report tool and key', () => {
  it('the key table names the 11 report tools', () => {
    expect(Object.keys(KEYS).sort()).toEqual([...REPORT_TOOLS].sort());
  });

  const CASES = Object.entries(KEYS).flatMap(([tool, keys]) => Object.entries(keys).map(([key, kind]) => [tool, key, kind] as const));

  it.each(CASES)('%s %s (%s): each refused value is fork-error with no request; each boundary value sends one request carrying it', async (tool, key, kind) => {
    const { refused, accepted: values } = VALUES[kind];
    const accepted = tool === 'get_profit_and_loss' && kind === 'summarize' ? [...values, 'Classes'] : values;
    report = PNL;
    for (const v of refused) {
      net.calls.length = 0;
      expect([v, await call(tool, { [key]: v })]).toStrictEqual([v, { content: [{ type: 'text', text: REFUSAL(key) }], isError: true }]);
      expect([v, net.calls]).toEqual([v, []]);
    }
    for (const v of accepted) {
      net.calls.length = 0;
      const out = await call(tool, { [key]: v });
      expect([v, out]).toStrictEqual([v, PNL_OK]);
      expect([v, expectOneReport(tool).searchParams.get(key)]).toEqual([v, String(v)]);
    }
  });

  it.each(CASES.filter(([, , kind]) => ENUM_KINDS.includes(kind)))(
    "%s %s (%s): a value outside the schema's enum is the SDK's -32602 (by prefix), with no request",
    async (tool, key) => {
      for (const v of ['Bogus', 'Cash&x=1', 'Month#']) {
        net.calls.length = 0;
        const out = await call(tool, { [key]: v });
        expect(out.isError).toBe(true);
        expect(out.content).toHaveLength(1);
        expect([v, out.content[0].text.startsWith(SDK_INPUT(tool))]).toEqual([v, true]);
        expect(net.calls).toEqual([]);
      }
    },
  );
});
