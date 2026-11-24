// Changed by Sanctuary Computer (quickbooks-mcp-286): report ids are digits now (A6.4's `^[0-9]{1,20}(,[0-9]{1,20})*$`);
// each upstream non-numeric id has a twin below, refused with D6's sentence and no request.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// ESM-compatible module mocking
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

// Dynamic imports after mock setup
const { getQuickbooksBalanceSheet } = await import('../../../src/handlers/get-quickbooks-balance-sheet.handler');
const { getQuickbooksProfitAndLoss } = await import('../../../src/handlers/get-quickbooks-profit-and-loss.handler');
const { getQuickbooksCashFlow } = await import('../../../src/handlers/get-quickbooks-cash-flow.handler');
const { getQuickbooksTrialBalance } = await import('../../../src/handlers/get-quickbooks-trial-balance.handler');
const { getQuickbooksGeneralLedger } = await import('../../../src/handlers/get-quickbooks-general-ledger.handler');
const { getQuickbooksCustomerSales } = await import('../../../src/handlers/get-quickbooks-customer-sales.handler');
const { getQuickbooksAgedReceivables } = await import('../../../src/handlers/get-quickbooks-aged-receivables.handler');
const { getQuickbooksCustomerBalance } = await import('../../../src/handlers/get-quickbooks-customer-balance.handler');
const { getQuickbooksAgedPayables } = await import('../../../src/handlers/get-quickbooks-aged-payables.handler');
const { getQuickbooksVendorExpenses } = await import('../../../src/handlers/get-quickbooks-vendor-expenses.handler');
const { getQuickbooksVendorBalance } = await import('../../../src/handlers/get-quickbooks-vendor-balance.handler');

describe('Report Handlers', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  describe('getQuickbooksBalanceSheet', () => {
    it('should get balance sheet report', async () => {
      const mockReport = { Header: { ReportName: 'BalanceSheet' }, Rows: [] };
      mockQuickBooksInstance.reportBalanceSheet.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksBalanceSheet({ end_date: '2024-12-31' });

      expect(result.isError).toBe(false);
      expect(result.result).toEqual(mockReport);
    });

    it('should handle all options', async () => {
      const mockReport = { Header: {} };
      mockQuickBooksInstance.reportBalanceSheet.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksBalanceSheet({
        start_date: '2024-01-01',
        end_date: '2024-12-31',
        accounting_method: 'Accrual',
        summarize_column_by: 'Month'
      });

      expect(result.isError).toBe(false);
    });

    it('should handle errors', async () => {
      mockQuickBooksInstance.reportBalanceSheet.mockImplementation((params: any, cb: any) =>
        cb(new Error('Report failed'), null)
      );

      const result = await getQuickbooksBalanceSheet({});

      expect(result.isError).toBe(true);
    });

    it('should handle start_date only (no end_date)', async () => {
      const mockReport = { Header: { ReportName: 'BalanceSheet' } };
      mockQuickBooksInstance.reportBalanceSheet.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksBalanceSheet({ start_date: '2024-01-01' });

      expect(result.isError).toBe(false);
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await getQuickbooksBalanceSheet({});

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Auth failed');
    });
  });

  describe('getQuickbooksProfitAndLoss', () => {
    it('should get P&L report', async () => {
      const mockReport = { Header: { ReportName: 'ProfitAndLoss' } };
      mockQuickBooksInstance.reportProfitAndLoss.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksProfitAndLoss({ start_date: '2024-01-01', end_date: '2024-12-31' });

      expect(result.isError).toBe(false);
    });

    it('should handle all filters', async () => {
      mockQuickBooksInstance.reportProfitAndLoss.mockImplementation((params: any, cb: any) => cb(null, {}));

      const result = await getQuickbooksProfitAndLoss({
        customer: '101',
        vendor: '201',
        item: '301',
        department: '401',
        class: '501'
      });

      expect(result.isError).toBe(false);
    });

    it('should handle accounting method and summarize options', async () => {
      mockQuickBooksInstance.reportProfitAndLoss.mockImplementation((params: any, cb: any) => cb(null, {}));

      const result = await getQuickbooksProfitAndLoss({
        accounting_method: 'Accrual',
        summarize_column_by: 'Month'
      });

      expect(result.isError).toBe(false);
    });

    it('should handle API errors', async () => {
      mockQuickBooksInstance.reportProfitAndLoss.mockImplementation((params: any, cb: any) =>
        cb(new Error('Report failed'), null)
      );

      const result = await getQuickbooksProfitAndLoss({});

      expect(result.isError).toBe(true);
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await getQuickbooksProfitAndLoss({});

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Auth failed');
    });
  });

  describe('getQuickbooksCashFlow', () => {
    it('should get cash flow report', async () => {
      const mockReport = { Header: { ReportName: 'CashFlow' } };
      mockQuickBooksInstance.reportCashFlow.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksCashFlow({});

      expect(result.isError).toBe(false);
    });

    it('should handle all options', async () => {
      const mockReport = { Header: {} };
      mockQuickBooksInstance.reportCashFlow.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksCashFlow({
        start_date: '2024-01-01',
        end_date: '2024-12-31',
        summarize_column_by: 'Month'
      });

      expect(result.isError).toBe(false);
    });

    it('should handle API errors', async () => {
      mockQuickBooksInstance.reportCashFlow.mockImplementation((params: any, cb: any) =>
        cb(new Error('Report failed'), null)
      );

      const result = await getQuickbooksCashFlow({});

      expect(result.isError).toBe(true);
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await getQuickbooksCashFlow({});

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Auth failed');
    });
  });

  describe('getQuickbooksTrialBalance', () => {
    it('should get trial balance report', async () => {
      const mockReport = { Header: { ReportName: 'TrialBalance' } };
      mockQuickBooksInstance.reportTrialBalance.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksTrialBalance({ accounting_method: 'Cash' });

      expect(result.isError).toBe(false);
    });

    it('should handle all options', async () => {
      const mockReport = { Header: {} };
      mockQuickBooksInstance.reportTrialBalance.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksTrialBalance({
        start_date: '2024-01-01',
        end_date: '2024-12-31',
        accounting_method: 'Accrual'
      });

      expect(result.isError).toBe(false);
    });

    it('should handle API errors', async () => {
      mockQuickBooksInstance.reportTrialBalance.mockImplementation((params: any, cb: any) =>
        cb(new Error('Report failed'), null)
      );

      const result = await getQuickbooksTrialBalance({});

      expect(result.isError).toBe(true);
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await getQuickbooksTrialBalance({});

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Auth failed');
    });
  });

  describe('getQuickbooksGeneralLedger', () => {
    it('should get general ledger report', async () => {
      const mockReport = { Header: { ReportName: 'GeneralLedger' } };
      mockQuickBooksInstance.reportGeneralLedgerDetail.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksGeneralLedger({ account: '1', source_account: '2', sort_by: 'Date' });

      expect(result.isError).toBe(false);
    });

    it('should handle all options', async () => {
      const mockReport = { Header: {} };
      mockQuickBooksInstance.reportGeneralLedgerDetail.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksGeneralLedger({
        start_date: '2024-01-01',
        end_date: '2024-12-31',
        accounting_method: 'Accrual',
        account: '1',
        source_account: '2',
        sort_by: 'Date'
      });

      expect(result.isError).toBe(false);
    });

    it('should handle API errors', async () => {
      mockQuickBooksInstance.reportGeneralLedgerDetail.mockImplementation((params: any, cb: any) =>
        cb(new Error('Report failed'), null)
      );

      const result = await getQuickbooksGeneralLedger({});

      expect(result.isError).toBe(true);
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await getQuickbooksGeneralLedger({});

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Auth failed');
    });
  });

  describe('getQuickbooksCustomerSales', () => {
    it('should get customer sales report', async () => {
      const mockReport = { Header: { ReportName: 'CustomerSales' } };
      mockQuickBooksInstance.reportCustomerSales.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksCustomerSales({ customer: '101' });

      expect(result.isError).toBe(false);
    });

    it('should handle all options', async () => {
      const mockReport = { Header: {} };
      mockQuickBooksInstance.reportCustomerSales.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksCustomerSales({
        start_date: '2024-01-01',
        end_date: '2024-12-31',
        customer: '101',
        summarize_column_by: 'Month'
      });

      expect(result.isError).toBe(false);
    });

    it('should handle API errors', async () => {
      mockQuickBooksInstance.reportCustomerSales.mockImplementation((params: any, cb: any) =>
        cb(new Error('Report failed'), null)
      );

      const result = await getQuickbooksCustomerSales({});

      expect(result.isError).toBe(true);
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await getQuickbooksCustomerSales({});

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Auth failed');
    });
  });

  describe('getQuickbooksAgedReceivables', () => {
    it('should get aged receivables report', async () => {
      const mockReport = { Header: { ReportName: 'AgedReceivables' } };
      mockQuickBooksInstance.reportAgedReceivables.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksAgedReceivables({
        report_date: '2024-12-31',
        aging_method: 'Current',
        days_per_aging_period: 30,
        num_periods: 4
      });

      expect(result.isError).toBe(false);
    });

    it('should get aged receivables report with customer filter', async () => {
      const mockReport = { Header: { ReportName: 'AgedReceivables' } };
      mockQuickBooksInstance.reportAgedReceivables.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksAgedReceivables({
        customer: '123'
      });

      expect(result.isError).toBe(false);
    });

    it('should handle API errors', async () => {
      mockQuickBooksInstance.reportAgedReceivables.mockImplementation((params: any, cb: any) =>
        cb(new Error('Report failed'), null)
      );

      const result = await getQuickbooksAgedReceivables({});

      expect(result.isError).toBe(true);
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await getQuickbooksAgedReceivables({});

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Auth failed');
    });
  });

  describe('getQuickbooksCustomerBalance', () => {
    it('should get customer balance report', async () => {
      const mockReport = { Header: { ReportName: 'CustomerBalance' } };
      mockQuickBooksInstance.reportCustomerBalance.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksCustomerBalance({});

      expect(result.isError).toBe(false);
    });

    it('should handle all options', async () => {
      const mockReport = { Header: {} };
      mockQuickBooksInstance.reportCustomerBalance.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksCustomerBalance({
        report_date: '2024-12-31',
        customer: '101',
        summarize_column_by: 'Month'
      });

      expect(result.isError).toBe(false);
    });

    it('should handle API errors', async () => {
      mockQuickBooksInstance.reportCustomerBalance.mockImplementation((params: any, cb: any) =>
        cb(new Error('Report failed'), null)
      );

      const result = await getQuickbooksCustomerBalance({});

      expect(result.isError).toBe(true);
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await getQuickbooksCustomerBalance({});

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Auth failed');
    });
  });

  describe('getQuickbooksAgedPayables', () => {
    it('should get aged payables report', async () => {
      const mockReport = { Header: { ReportName: 'AgedPayables' } };
      mockQuickBooksInstance.reportAgedPayables.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksAgedPayables({ vendor: '201' });

      expect(result.isError).toBe(false);
    });

    it('should handle all options', async () => {
      const mockReport = { Header: {} };
      mockQuickBooksInstance.reportAgedPayables.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksAgedPayables({
        report_date: '2024-12-31',
        vendor: '201',
        aging_method: 'Current',
        days_per_aging_period: 30,
        num_periods: 4
      });

      expect(result.isError).toBe(false);
    });

    it('should handle API errors', async () => {
      mockQuickBooksInstance.reportAgedPayables.mockImplementation((params: any, cb: any) =>
        cb(new Error('Report failed'), null)
      );

      const result = await getQuickbooksAgedPayables({});

      expect(result.isError).toBe(true);
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await getQuickbooksAgedPayables({});

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Auth failed');
    });
  });

  describe('getQuickbooksVendorExpenses', () => {
    it('should get vendor expenses report', async () => {
      const mockReport = { Header: { ReportName: 'VendorExpenses' } };
      mockQuickBooksInstance.reportVendorExpenses.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksVendorExpenses({ accounting_method: 'Accrual' });

      expect(result.isError).toBe(false);
    });

    it('should handle all options', async () => {
      const mockReport = { Header: {} };
      mockQuickBooksInstance.reportVendorExpenses.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksVendorExpenses({
        start_date: '2024-01-01',
        end_date: '2024-12-31',
        vendor: '201',
        summarize_column_by: 'Month',
        accounting_method: 'Accrual'
      });

      expect(result.isError).toBe(false);
    });

    it('should handle API errors', async () => {
      mockQuickBooksInstance.reportVendorExpenses.mockImplementation((params: any, cb: any) =>
        cb(new Error('Report failed'), null)
      );

      const result = await getQuickbooksVendorExpenses({});

      expect(result.isError).toBe(true);
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await getQuickbooksVendorExpenses({});

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Auth failed');
    });
  });

  describe('getQuickbooksVendorBalance', () => {
    it('should get vendor balance report', async () => {
      const mockReport = { Header: { ReportName: 'VendorBalance' } };
      mockQuickBooksInstance.reportVendorBalance.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksVendorBalance({});

      expect(result.isError).toBe(false);
    });

    it('should handle all options', async () => {
      const mockReport = { Header: {} };
      mockQuickBooksInstance.reportVendorBalance.mockImplementation((params: any, cb: any) => cb(null, mockReport));

      const result = await getQuickbooksVendorBalance({
        report_date: '2024-12-31',
        vendor: '201',
        summarize_column_by: 'Month'
      });

      expect(result.isError).toBe(false);
    });

    it('should handle API errors', async () => {
      mockQuickBooksInstance.reportVendorBalance.mockImplementation((params: any, cb: any) =>
        cb(new Error('Report failed'), null)
      );

      const result = await getQuickbooksVendorBalance({});

      expect(result.isError).toBe(true);
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await getQuickbooksVendorBalance({});

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Auth failed');
    });
  });

  // quickbooks-mcp-286 (A6.4, plan-5 U2): the ids upstream used, each refused before any request.
  describe('non-numeric ids are refused before any request', () => {
    const refused = (option: string) => `The report was refused before reaching QuickBooks: ${option} isn't a valid value.`;
    const cases: Array<[string, () => Promise<any>, string, any]> = [
      ['P&L all filters', () => getQuickbooksProfitAndLoss({ customer: 'cust-1', vendor: 'vendor-1', item: 'item-1', department: 'dept-1', class: 'class-1' }), 'customer', mockQuickBooksInstance.reportProfitAndLoss],
      ['P&L vendor', () => getQuickbooksProfitAndLoss({ vendor: 'vendor-1' }), 'vendor', mockQuickBooksInstance.reportProfitAndLoss],
      ['P&L item', () => getQuickbooksProfitAndLoss({ item: 'item-1' }), 'item', mockQuickBooksInstance.reportProfitAndLoss],
      ['P&L department', () => getQuickbooksProfitAndLoss({ department: 'dept-1' }), 'department', mockQuickBooksInstance.reportProfitAndLoss],
      ['P&L class', () => getQuickbooksProfitAndLoss({ class: 'class-1' }), 'class', mockQuickBooksInstance.reportProfitAndLoss],
      ['customer sales', () => getQuickbooksCustomerSales({ customer: 'cust-1' }), 'customer', mockQuickBooksInstance.reportCustomerSales],
      ['customer sales all options', () => getQuickbooksCustomerSales({ start_date: '2024-01-01', end_date: '2024-12-31', customer: 'cust-1', summarize_column_by: 'Month' }), 'customer', mockQuickBooksInstance.reportCustomerSales],
      ['aged receivables customer', () => getQuickbooksAgedReceivables({ customer: 'cust-123' }), 'customer', mockQuickBooksInstance.reportAgedReceivables],
      ['customer balance all options', () => getQuickbooksCustomerBalance({ report_date: '2024-12-31', customer: 'cust-1', summarize_column_by: 'Month' }), 'customer', mockQuickBooksInstance.reportCustomerBalance],
      ['aged payables vendor', () => getQuickbooksAgedPayables({ vendor: 'vendor-1' }), 'vendor', mockQuickBooksInstance.reportAgedPayables],
      ['aged payables all options', () => getQuickbooksAgedPayables({ report_date: '2024-12-31', vendor: 'vendor-1', aging_method: 'Current', days_per_aging_period: 30, num_periods: 4 }), 'vendor', mockQuickBooksInstance.reportAgedPayables],
      ['vendor expenses all options', () => getQuickbooksVendorExpenses({ start_date: '2024-01-01', end_date: '2024-12-31', vendor: 'vendor-1', summarize_column_by: 'Month', accounting_method: 'Accrual' }), 'vendor', mockQuickBooksInstance.reportVendorExpenses],
      ['vendor balance all options', () => getQuickbooksVendorBalance({ report_date: '2024-12-31', vendor: 'vendor-1', summarize_column_by: 'Month' }), 'vendor', mockQuickBooksInstance.reportVendorBalance],
    ];
    it.each(cases)('%s', async (_name, call, option, report) => {
      const result = await call();
      expect(result).toEqual({ result: null, isError: true, error: refused(option) });
      expect(report).not.toHaveBeenCalled();
      expect(mockQuickbooksClientClass.getInstance).not.toHaveBeenCalled();
    });
  });
});
