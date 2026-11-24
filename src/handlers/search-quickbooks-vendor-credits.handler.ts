// Changed by Sanctuary Computer (quickbooks-mcp-286): the input normalizer checks the criteria before any request, and the
// offset the request uses is kept for the call (A5.1-A5.3, A5.13, A6.3).
import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { normalizeSearch, refusal } from "../helpers/validate-input.js";
import { setUsedOffset } from "../clients/call-context.js";

export interface SearchVendorCreditsInput {
  vendor_ref?: string;
  limit?: number;
  offset?: number;
}

export async function searchQuickbooksVendorCredits(data: SearchVendorCreditsInput): Promise<ToolResponse<any>> {
  try {
    const criteria: Record<string, any> = {};
    if (data.vendor_ref) criteria.VendorRef = data.vendor_ref;

    const r = normalizeSearch("search_vendor_credits", criteria, { limit: data.limit, offset: data.offset });
    if (!r.ok) return refusal(r.failure);
    setUsedOffset(r.usedOffset);
    const quickbooks = await QuickbooksClient.getInstance();

    return new Promise((resolve) => {
      (quickbooks as any).findVendorCredits(r.criteria, (err: any, result: any) => {
        if (err) resolve({ result: null, isError: true, error: formatError(err) });
        else resolve({ result: result?.QueryResponse?.VendorCredit || [], isError: false, error: null });
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}

