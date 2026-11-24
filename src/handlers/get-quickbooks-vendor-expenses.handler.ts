// Changed by Sanctuary Computer (quickbooks-mcp-286): the input normalizer checks the report options before any request (A6.4).
import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { normalizeReport, refusal } from "../helpers/validate-input.js";

export interface VendorExpensesOptions {
  start_date?: string;
  end_date?: string;
  vendor?: string;
  summarize_column_by?: "Total" | "Month" | "Week" | "Days";
  accounting_method?: "Cash" | "Accrual";
}

export async function getQuickbooksVendorExpenses(options: VendorExpensesOptions): Promise<ToolResponse<any>> {
  try {
    const r = normalizeReport("get_vendor_expenses", options);
    if (!r.ok) return refusal(r.failure);
    const o = r.options as VendorExpensesOptions;
    const quickbooks = await QuickbooksClient.getInstance();
    const params: Record<string, any> = {};
    if (o.start_date) params.start_date = o.start_date;
    if (o.end_date) params.end_date = o.end_date;
    if (o.vendor) params.vendor = o.vendor;
    if (o.summarize_column_by) params.summarize_column_by = o.summarize_column_by;
    if (o.accounting_method) params.accounting_method = o.accounting_method;

    return new Promise((resolve) => {
      (quickbooks as any).reportVendorExpenses(params, (err: any, report: any) => {
        if (err) resolve({ result: null, isError: true, error: formatError(err) });
        else resolve({ result: report, isError: false, error: null });
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
