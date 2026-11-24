// Changed by Sanctuary Computer (quickbooks-mcp-286): the input normalizer checks the report options before any request (A6.4).
import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { normalizeReport, refusal } from "../helpers/validate-input.js";

export interface TrialBalanceOptions {
  start_date?: string;
  end_date?: string;
  accounting_method?: "Cash" | "Accrual";
}

export async function getQuickbooksTrialBalance(options: TrialBalanceOptions): Promise<ToolResponse<any>> {
  try {
    const r = normalizeReport("get_trial_balance", options);
    if (!r.ok) return refusal(r.failure);
    const o = r.options as TrialBalanceOptions;
    const quickbooks = await QuickbooksClient.getInstance();
    const params: Record<string, any> = {};
    if (o.start_date) params.start_date = o.start_date;
    if (o.end_date) params.end_date = o.end_date;
    if (o.accounting_method) params.accounting_method = o.accounting_method;

    return new Promise((resolve) => {
      (quickbooks as any).reportTrialBalance(params, (err: any, report: any) => {
        if (err) resolve({ result: null, isError: true, error: formatError(err) });
        else resolve({ result: report, isError: false, error: null });
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
