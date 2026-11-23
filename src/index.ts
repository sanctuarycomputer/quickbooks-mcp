#!/usr/bin/env node
// Changed by Sanctuary Computer (quickbooks-mcp-285): registers only the read allowlist and the qbo_companies stub, through startReadServer.
// Changed by Sanctuary Computer (quickbooks-mcp-291): secureStart (start refusals, the HTTP guard, the backstop) runs first in main().

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { secureStart } from "./http-guard.js";
import { QuickbooksMCPServer } from "./server/qbo-mcp-server.js";
import { startReadServer, type ReadTool } from "./allowlist.js";
import { QboCompaniesTool } from "./tools/qbo-companies.tool.js";
import { GetAgedPayablesTool } from "./tools/get-aged-payables.tool.js";
import { GetAgedReceivablesTool } from "./tools/get-aged-receivables.tool.js";
import { GetBalanceSheetTool } from "./tools/get-balance-sheet.tool.js";
import { GetCashFlowTool } from "./tools/get-cash-flow.tool.js";
import { GetCompanyInfoTool } from "./tools/get-company-info.tool.js";
import { GetCustomerBalanceTool } from "./tools/get-customer-balance.tool.js";
import { GetCustomerSalesTool } from "./tools/get-customer-sales.tool.js";
import { GetGeneralLedgerTool } from "./tools/get-general-ledger.tool.js";
import { GetPreferencesTool } from "./tools/get-preferences.tool.js";
import { GetProfitAndLossTool } from "./tools/get-profit-and-loss.tool.js";
import { GetTrialBalanceTool } from "./tools/get-trial-balance.tool.js";
import { GetVendorBalanceTool } from "./tools/get-vendor-balance.tool.js";
import { GetVendorExpensesTool } from "./tools/get-vendor-expenses.tool.js";
import { SearchAccountsTool } from "./tools/search-accounts.tool.js";
import { SearchBillPaymentsTool } from "./tools/search-bill-payments.tool.js";
import { SearchBillsTool } from "./tools/search-bills.tool.js";
import { SearchClassesTool } from "./tools/search-classes.tool.js";
import { SearchCreditMemosTool } from "./tools/search-credit-memos.tool.js";
import { SearchCustomersTool } from "./tools/search-customers.tool.js";
import { SearchDepartmentsTool } from "./tools/search-departments.tool.js";
import { SearchDepositsTool } from "./tools/search-deposits.tool.js";
import { SearchEmployeesTool } from "./tools/search-employees.tool.js";
import { SearchInvoicesTool } from "./tools/search-invoices.tool.js";
import { SearchItemsTool } from "./tools/search-items.tool.js";
import { SearchJournalEntriesTool } from "./tools/search-journal-entries.tool.js";
import { SearchPaymentsTool } from "./tools/search-payments.tool.js";
import { SearchPurchasesTool } from "./tools/search-purchases.tool.js";
import { SearchSalesReceiptsTool } from "./tools/search-sales-receipts.tool.js";
import { SearchTransfersTool } from "./tools/search-transfers.tool.js";
import { SearchVendorCreditsTool } from "./tools/search-vendor-credits.tool.js";
import { SearchVendorsTool } from "./tools/search-vendors.tool.js";

const TOOLS: readonly ReadTool[] = [
  GetAgedPayablesTool,
  GetAgedReceivablesTool,
  GetBalanceSheetTool,
  GetCashFlowTool,
  GetCompanyInfoTool,
  GetCustomerBalanceTool,
  GetCustomerSalesTool,
  GetGeneralLedgerTool,
  GetPreferencesTool,
  GetProfitAndLossTool,
  GetTrialBalanceTool,
  GetVendorBalanceTool,
  GetVendorExpensesTool,
  SearchAccountsTool,
  SearchBillPaymentsTool,
  SearchBillsTool,
  SearchClassesTool,
  SearchCreditMemosTool,
  SearchCustomersTool,
  SearchDepartmentsTool,
  SearchDepositsTool,
  SearchEmployeesTool,
  SearchInvoicesTool,
  SearchItemsTool,
  SearchJournalEntriesTool,
  SearchPaymentsTool,
  SearchPurchasesTool,
  SearchSalesReceiptsTool,
  SearchTransfersTool,
  SearchVendorCreditsTool,
  SearchVendorsTool,
  QboCompaniesTool,
];

const main = async () => {
  // The guard and the backstop go in before any tool registers; a refusal or a failed install stops start here.
  try {
    secureStart(process.env, process.execArgv);
  } catch (e) {
    process.stderr.write((e as Error).message + "\n");
    process.exit(1);
  }
  const server = QuickbooksMCPServer.GetServer();
  startReadServer(process.env, server, TOOLS);
  await server.connect(new StdioServerTransport());
};

main().catch((e) => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n");
  process.exitCode = 1;
});
