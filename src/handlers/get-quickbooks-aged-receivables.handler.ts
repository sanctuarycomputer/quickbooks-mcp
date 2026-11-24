// Changed by Sanctuary Computer (quickbooks-mcp-286): the input normalizer checks the report options before any request (A6.4).
import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { normalizeReport, refusal } from "../helpers/validate-input.js";

export interface AgedReceivablesOptions {
  report_date?: string;
  customer?: string;
  aging_method?: "Current" | "Report_Date";
  days_per_aging_period?: number;
  num_periods?: number;
}

export async function getQuickbooksAgedReceivables(options: AgedReceivablesOptions): Promise<ToolResponse<any>> {
  try {
    const r = normalizeReport("get_aged_receivables", options);
    if (!r.ok) return refusal(r.failure);
    const o = r.options as AgedReceivablesOptions;
    const quickbooks = await QuickbooksClient.getInstance();
    const params: Record<string, any> = {};
    if (o.report_date) params.report_date = o.report_date;
    if (o.customer) params.customer = o.customer;
    if (o.aging_method) params.aging_method = o.aging_method;
    if (o.days_per_aging_period) params.days_per_aging_period = o.days_per_aging_period;
    if (o.num_periods) params.num_periods = o.num_periods;

    return new Promise((resolve) => {
      (quickbooks as any).reportAgedReceivables(params, (err: any, report: any) => {
        if (err) resolve({ result: null, isError: true, error: formatError(err) });
        else resolve({ result: report, isError: false, error: null });
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
