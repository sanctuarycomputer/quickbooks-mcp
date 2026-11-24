// Changed by Sanctuary Computer (quickbooks-mcp-286): the input normalizer checks the criteria before any request, and the
// offset the request uses is kept for the call (A5.1-A5.3, A5.13, A6.3).
import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { normalizeSearch, refusal } from "../helpers/validate-input.js";
import { setUsedOffset } from "../clients/call-context.js";
import { buildQuickbooksSearchCriteria } from "../helpers/build-quickbooks-search-criteria.js";

/**
 * Search employees in QuickBooks Online that match given criteria
 */
export async function searchQuickbooksEmployees(params: any): Promise<ToolResponse<any>> {
  try {
    const r = normalizeSearch("search_employees", buildQuickbooksSearchCriteria(params));
    if (!r.ok) return refusal(r.failure);
    setUsedOffset(r.usedOffset);
    const criteria = r.criteria;
    const quickbooks = await QuickbooksClient.getInstance();

    return new Promise((resolve) => {
      quickbooks.findEmployees(criteria, (err: any, employees: any) => {
        if (err) {
          resolve({
            result: null,
            isError: true,
            error: formatError(err),
          });
        } else {
          resolve({
            result: employees?.QueryResponse?.Employee || [],
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
