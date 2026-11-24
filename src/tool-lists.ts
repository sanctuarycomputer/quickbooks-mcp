// Sanctuary Computer (quickbooks-mcp-285, moved here by quickbooks-mcp-286): the read allowlist and the companies tool's
// name. This module imports nothing, so allowlist.ts, register-tool.ts and tool-result.ts can all read it with no cycle.

// The fork review's appendix A (scripts-283), sorted. A change here is a change to what the server exposes.
export const READ_ALLOWLIST: readonly string[] = [
  "get_aged_payables",
  "get_aged_receivables",
  "get_balance_sheet",
  "get_cash_flow",
  "get_company_info",
  "get_customer_balance",
  "get_customer_sales",
  "get_general_ledger",
  "get_preferences",
  "get_profit_and_loss",
  "get_trial_balance",
  "get_vendor_balance",
  "get_vendor_expenses",
  "search_accounts",
  "search_bill_payments",
  "search_bills",
  "search_classes",
  "search_credit_memos",
  "search_customers",
  "search_departments",
  "search_deposits",
  "search_employees",
  "search_invoices",
  "search_items",
  "search_journal_entries",
  "search_payments",
  "search_purchases",
  "search_sales_receipts",
  "search_transfers",
  "search_vendor_credits",
  "search_vendors",
];

export const COMPANIES_TOOL = "qbo_companies";
