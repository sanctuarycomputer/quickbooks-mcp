// Changed by Sanctuary Computer (quickbooks-mcp-286): the input normalizer checks the report options before any request (A6.4).
import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { normalizeReport, refusal } from "../helpers/validate-input.js";

export interface BalanceSheetOptions {
  start_date?: string;
  end_date?: string;
  accounting_method?: "Cash" | "Accrual";
  summarize_column_by?: "Total" | "Month" | "Week" | "Days";
}

export async function getQuickbooksBalanceSheet(options: BalanceSheetOptions): Promise<ToolResponse<any>> {
  try {
    const r = normalizeReport("get_balance_sheet", options);
    if (!r.ok) return refusal(r.failure);
    const o = r.options as BalanceSheetOptions;
    // Use getInstance() so token freshness is checked on every call
    const quickbooks = await QuickbooksClient.getInstance();

    // Build params — Balance Sheet is a point-in-time report.
    // QBO silently ignores end_date when start_date is absent. To ensure the
    // caller's end_date is honoured, auto-supply start_date as Jan 1 of the
    // same year when the caller omits it.
    const params: Record<string, any> = {};
    if (o.end_date) {
      params.end_date = o.end_date;
      params.start_date = o.start_date || `${o.end_date.substring(0, 4)}-01-01`;
    } else if (o.start_date) {
      params.start_date = o.start_date;
    }
    if (o.accounting_method) params.accounting_method = o.accounting_method;
    if (o.summarize_column_by) params.summarize_column_by = o.summarize_column_by;

    return new Promise((resolve) => {
      (quickbooks as any).reportBalanceSheet(params, (err: any, report: any) => {
        if (err) {
          resolve({ result: null, isError: true, error: formatError(err) });
        } else {
          resolve({ result: report, isError: false, error: null });
        }
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
