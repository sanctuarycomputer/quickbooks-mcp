// Changed by Sanctuary Computer (quickbooks-mcp-286): the input normalizer checks the criteria before any request, and the
// offset the request uses is kept for the call (A5.1-A5.3, A5.13, A6.3).
import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { normalizeSearch, refusal } from "../helpers/validate-input.js";
import { setUsedOffset } from "../clients/call-context.js";

/**
 * Search vendors from QuickBooks Online.
 *
 * Accepts either:
 *   • A plain criteria object (key/value pairs) – passed directly to findVendors
 *   • An **array** of objects in the `{ field, value, operator? }` shape – this
 *     allows use of operators such as `IN`, `LIKE`, `>`, `<`, `>=`, `<=` etc.
 *
 * Pagination / sorting options such as `limit`, `offset`, `asc`, `desc`,
 * `fetchAll`, `count` can be supplied via the top‑level criteria object or as
 * dedicated entries in the array form.
 */
export async function searchQuickbooksVendors(criteria: object | Array<Record<string, any>> = {}): Promise<ToolResponse<any[]>> {
  try {
    const r = normalizeSearch("search_vendors", criteria);
    if (!r.ok) return refusal(r.failure);
    setUsedOffset(r.usedOffset);
    const quickbooks = await QuickbooksClient.getInstance();

    return new Promise((resolve) => {
      (quickbooks as any).findVendors(r.criteria as any, (err: any, vendors: any) => {
        if (err) {
          resolve({
            result: null,
            isError: true,
            error: formatError(err),
          });
        } else {
          resolve({
            result:
              vendors?.QueryResponse?.Vendor ??
              vendors?.QueryResponse?.totalCount ??
              [],
            isError: false,
            error: null,
          });
        }
      });
    });
  } catch (error) {
    return {
      result: null,
      isError: true,
      error: formatError(error),
    };
  }
} 
