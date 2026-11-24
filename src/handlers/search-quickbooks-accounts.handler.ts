// Changed by Sanctuary Computer (quickbooks-mcp-286): the input normalizer checks the criteria before any request, and the
// offset the request uses is kept for the call (A5.1-A5.3, A5.13, A6.3).
import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { normalizeBuiltSearch, refusal } from "../helpers/validate-input.js";
import { setUsedOffset } from "../clients/call-context.js";
import { QuickbooksSearchCriteriaInput } from "../helpers/build-quickbooks-search-criteria.js";

export type AccountSearchCriteria = QuickbooksSearchCriteriaInput;

export async function searchQuickbooksAccounts(criteria: AccountSearchCriteria): Promise<ToolResponse<any[]>> {
  try {
    const r = normalizeBuiltSearch("search_accounts", criteria);
    if (!r.ok) return refusal(r.failure);
    setUsedOffset(r.usedOffset);
    const normalizedCriteria = r.criteria;
    const quickbooks = await QuickbooksClient.getInstance();

    return new Promise((resolve) => {
      (quickbooks as any).findAccounts(normalizedCriteria, (err: any, accounts: any) => {
        if (err) {
          resolve({ result: null, isError: true, error: formatError(err) });
        } else {
          resolve({ result: accounts.QueryResponse.Account || [], isError: false, error: null });
        }
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
} 
