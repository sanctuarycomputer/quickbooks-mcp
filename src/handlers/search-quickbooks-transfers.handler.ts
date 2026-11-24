// Changed by Sanctuary Computer (quickbooks-mcp-286): the input normalizer checks the criteria before any request, and the
// offset the request uses is kept for the call (A5.1-A5.3, A5.13, A6.3).
import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { normalizeSearch, refusal } from "../helpers/validate-input.js";
import { setUsedOffset } from "../clients/call-context.js";

export interface SearchTransfersInput {
  txn_date_from?: string;
  txn_date_to?: string;
  limit?: number;
  offset?: number;
}

export async function searchQuickbooksTransfers(data: SearchTransfersInput): Promise<ToolResponse<any>> {
  try {
    const criteria: Array<Record<string, any>> = [];
    if (data.txn_date_from) criteria.push({ field: "TxnDate", value: data.txn_date_from, operator: ">=" });
    if (data.txn_date_to) criteria.push({ field: "TxnDate", value: data.txn_date_to, operator: "<=" });

    const r = normalizeSearch("search_transfers", criteria, { limit: data.limit, offset: data.offset });
    if (!r.ok) return refusal(r.failure);
    setUsedOffset(r.usedOffset);
    const quickbooks = await QuickbooksClient.getInstance();

    return new Promise((resolve) => {
      (quickbooks as any).findTransfers(r.criteria, (err: any, result: any) => {
        if (err) resolve({ result: null, isError: true, error: formatError(err) });
        else resolve({ result: result?.QueryResponse?.Transfer || [], isError: false, error: null });
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}

