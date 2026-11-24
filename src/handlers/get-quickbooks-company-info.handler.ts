// Changed by Sanctuary Computer (quickbooks-mcp-286): the realm is the call's kept realm, never a caller's id (spec A4.9):
// the request is `companyinfo/<kept realm>`.
import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

export async function getQuickbooksCompanyInfo(): Promise<ToolResponse<any>> {
  try {
    const quickbooks = await QuickbooksClient.getInstance();
    const realm = (quickbooks as any).realmId;

    return new Promise((resolve) => {
      (quickbooks as any).getCompanyInfo(realm, (err: any, info: any) => {
        if (err) resolve({ result: null, isError: true, error: formatError(err) });
        else resolve({ result: info, isError: false, error: null });
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
