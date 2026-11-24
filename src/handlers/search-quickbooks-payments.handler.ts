// Changed by Sanctuary Computer (quickbooks-mcp-286): the input normalizer checks the criteria before any request, and the
// offset the request uses is kept for the call (A5.1-A5.3, A5.13, A6.3).
// T12 fix 1b: a string filter given as "" is passed on as that filter, never dropped.
import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { normalizeSearch, refusal } from "../helpers/validate-input.js";
import { setUsedOffset } from "../clients/call-context.js";

export interface SearchPaymentsInput {
  customer_ref?: string;
  txn_date_from?: string;
  txn_date_to?: string;
  limit?: number;
  offset?: number;
}

export async function searchQuickbooksPayments(data: SearchPaymentsInput): Promise<ToolResponse<any>> {
  try {
    const criteria: Array<Record<string, any>> = [];

    if (data.customer_ref !== undefined) {
      criteria.push({ field: "CustomerRef", value: data.customer_ref, operator: "=" });
    }
    if (data.txn_date_from !== undefined) {
      criteria.push({ field: "TxnDate", value: data.txn_date_from, operator: ">=" });
    }
    if (data.txn_date_to !== undefined) {
      criteria.push({ field: "TxnDate", value: data.txn_date_to, operator: "<=" });
    }

    const r = normalizeSearch("search_payments", criteria, { limit: data.limit, offset: data.offset });
    if (!r.ok) return refusal(r.failure);
    setUsedOffset(r.usedOffset);
    const quickbooks = await QuickbooksClient.getInstance();

    return new Promise((resolve) => {
      (quickbooks as any).findPayments(r.criteria, (err: any, result: any) => {
        if (err) {
          resolve({ result: null, isError: true, error: formatError(err) });
        } else {
          const payments = result?.QueryResponse?.Payment || [];
          resolve({ result: payments, isError: false, error: null });
        }
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}

