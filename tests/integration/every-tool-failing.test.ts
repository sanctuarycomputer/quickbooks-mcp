// Sanctuary Computer (quickbooks-mcp-286): every allowlisted tool against a failing network, through its own handler
// (spec A4.8). Arm one: the fake QuickBooks answers the first-use companyinfo read well, then 500 with an intuit_tid to
// the tool's own request (get_company_info's is the second companyinfo read); the stub saw that request in the tool's
// form (contract §4's Read tools table), so the handler ran, and the result is an error whose header, read by the whole
// Result grammar, is `reason: http-500` with that tid. Arm two: Stacks refuses the connection, and every tool answers
// `reason: stacks-unreachable` after two Stacks attempts, with no QuickBooks request.
import { describe, it, expect, beforeEach, afterEach, afterAll } from '@jest/globals';
import fs from 'fs';
import { READ_ALLOWLIST } from '../../src/tool-lists.js';
import type { StubCall } from '../fakes/stub-network.js';
import { readError } from '../helpers/result-grammar.js';
import { QBO_HOST, REALMS, fakePath, installNetwork, startServer, type Rig } from '../helpers/server.js';

const network = installNetwork();
const { net } = network;

const ARGS: Record<string, { params: Record<string, unknown> }> = JSON.parse(fs.readFileSync(fakePath('guard-tool-args.json'), 'utf8'));
const REALM = REALMS.garden3d;
const TID = ['tid', 'a48', 'five', 'hundred'].join('-');

/** Contract 1.1 §4's Read tools table: each tool's request form, the path after /v3/company/<realm>/ (`query` with its entity). */
const FORMS: Record<string, string> = {
  get_aged_payables: 'reports/AgedPayables',
  get_aged_receivables: 'reports/AgedReceivables',
  get_balance_sheet: 'reports/BalanceSheet',
  get_cash_flow: 'reports/CashFlow',
  get_company_info: 'companyinfo/<realm>',
  get_customer_balance: 'reports/CustomerBalance',
  get_customer_sales: 'reports/CustomerSales',
  get_general_ledger: 'reports/GeneralLedger',
  get_preferences: 'preferences',
  get_profit_and_loss: 'reports/ProfitAndLoss',
  get_trial_balance: 'reports/TrialBalance',
  get_vendor_balance: 'reports/VendorBalance',
  get_vendor_expenses: 'reports/VendorExpenses',
  search_accounts: 'query (account)',
  search_bill_payments: 'query (billPayment)',
  search_bills: 'query (bill)',
  search_classes: 'query (class)',
  search_credit_memos: 'query (creditMemo)',
  search_customers: 'query (customer)',
  search_departments: 'query (department)',
  search_deposits: 'query (deposit)',
  search_employees: 'query (employee)',
  search_invoices: 'query (invoice)',
  search_items: 'query (item)',
  search_journal_entries: 'query (journalEntry)',
  search_payments: 'query (payment)',
  search_purchases: 'query (purchase)',
  search_sales_receipts: 'query (salesReceipt)',
  search_transfers: 'query (transfer)',
  search_vendor_credits: 'query (vendorCredit)',
  search_vendors: 'query (vendor)',
};

/** A QuickBooks request's form, as the table writes it: the path after the realm, a query's entity in parentheses. */
function formOf(c: StubCall): string {
  const url = new URL(c.path ?? '/', 'https://quickbooks.invalid');
  const rest = url.pathname.slice(`/v3/company/${REALM}/`.length);
  if (rest === `companyinfo/${REALM}`) return 'companyinfo/<realm>';
  if (rest !== 'query') return rest;
  const entity = /\bfrom\s+(\w+)/i.exec(url.searchParams.get('query') ?? '')?.[1] ?? '';
  return `query (${entity})`;
}

const qboCalls = () => net.calls.filter((c) => c.hostname === QBO_HOST);
const stacksCalls = () => net.calls.filter((c) => c.hostname !== QBO_HOST);

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

it('the forms table names exactly the allowlist', () => {
  expect(Object.keys(FORMS).sort()).toEqual([...READ_ALLOWLIST].sort());
});

describe('A4.8 arm one: QuickBooks answers the first-use read, then 500 with an intuit_tid to the tool\'s own request', () => {
  beforeEach(async () => {
    let n = 0;
    // A fresh server per tool, so each call makes the company's first-use read; every later request answers 500.
    rig = await startServer({
      route: (call) => (call.hostname === QBO_HOST && n++ > 0 ? { status: 500, headers: { intuit_tid: TID }, body: JSON.stringify({ Fault: { Error: [{ Message: 'boom' }] } }) } : undefined),
    });
  });

  it.each([...READ_ALLOWLIST])('%s: the stub saw its own request form, and the result is reason: http-500 with the tid', async (tool) => {
    const result = await rig!.client.callTool({ name: tool, arguments: { company: 'garden3d', ...ARGS[tool] } });
    const calls = qboCalls();
    expect(calls.map(formOf)).toEqual(['companyinfo/<realm>', FORMS[tool]]);
    const read = readError(result);
    expect([read.reason, read.intuit_tid]).toEqual(['http-500', TID]);
    expect((result as any).content[0].text.split('\n')[0]).toBe('reason: http-500');
    expect(read.warnings).toEqual([]);
  });
});

describe('A4.8 arm two: Stacks refuses the connection', () => {
  beforeEach(async () => {
    rig = await startServer({ stacks: { refuse: 'refused' } });
  });

  it.each([...READ_ALLOWLIST])('%s: reason: stacks-unreachable after two Stacks attempts, no QuickBooks request', async (tool) => {
    const result = await rig!.client.callTool({ name: tool, arguments: { company: 'garden3d', ...ARGS[tool] } });
    expect(readError(result).reason).toBe('stacks-unreachable');
    expect((result as any).content[0].text.split('\n')[0]).toBe('reason: stacks-unreachable');
    expect(stacksCalls()).toHaveLength(2);
    expect(qboCalls()).toEqual([]);
  });
});
