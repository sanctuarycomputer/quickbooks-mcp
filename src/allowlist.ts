// Sanctuary Computer (quickbooks-mcp-285): the read allowlist and the start refusal; the server registers only what is listed here.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { RegisterTool } from "./helpers/register-tool.js";
import type { ToolDefinition } from "./types/tool-definition.js";

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

// Sign-in material the server must never be given: present at all, even empty, refuses the start.
export const REFUSED_KEYS: readonly string[] = ["QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET", "QUICKBOOKS_REFRESH_TOKEN", "QUICKBOOKS_REALM_ID"];

export interface CompaniesToolDefinition {
  name: string;
  description: string;
  handler: () => Promise<CallToolResult>;
}

export type ReadTool = ToolDefinition<any> | CompaniesToolDefinition;

/** The reason the server must not start, or null. Checks presence only; a value is never read. */
export function startRefusal(env: Record<string, string | undefined>): string | null {
  for (const key of REFUSED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(env, key)) return `${key} is set`;
  }
  return null;
}

/**
 * Registers exactly the allowlist plus the companies tool, or throws before registering anything.
 * An entry without a schema is the companies tool only under its own name; a listed name must carry a schema.
 */
export function registerReadTools(server: McpServer, tools: readonly ReadTool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`allowlist: duplicate ${tool.name}`);
    seen.add(tool.name);
  }
  for (const name of [...READ_ALLOWLIST, COMPANIES_TOOL]) {
    if (!seen.has(name)) throw new Error(`allowlist: missing ${name}`);
  }
  for (const tool of tools) {
    const allowed = "schema" in tool ? READ_ALLOWLIST.includes(tool.name) : tool.name === COMPANIES_TOOL;
    if (!allowed) throw new Error(`allowlist: unlisted ${tool.name}`);
  }
  for (const tool of tools) {
    if ("schema" in tool) RegisterTool(server, tool);
    else server.tool(tool.name, tool.description, {}, tool.handler);
  }
}

/** Refuses first, then registers; every failure is one `refused to start: <reason>` error. */
export function startReadServer(
  env: Record<string, string | undefined>,
  server: McpServer,
  tools: readonly ReadTool[],
): void {
  const reason = startRefusal(env);
  if (reason !== null) throw new Error("refused to start: " + reason);
  try {
    registerReadTools(server, tools);
  } catch (e) {
    throw new Error("refused to start: " + (e as Error).message);
  }
}
