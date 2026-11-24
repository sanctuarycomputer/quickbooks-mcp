// Changed by Sanctuary Computer (quickbooks-mcp-286): `company_id` is dropped (spec A4.9; contract §4). The realm read is
// always the one kept for the call's company; a `company_id` sent anyway is stripped as any unknown key is, and named in
// the call's WARNING: item after the data item.
import { getQuickbooksCompanyInfo } from "../handlers/get-quickbooks-company-info.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "get_company_info";
const toolDescription = "Retrieve the company information from QuickBooks Online.";
const toolSchema = z.object({});

const toolHandler = async () => {
  const response = await getQuickbooksCompanyInfo();
  if (response.isError) return { content: [{ type: "text" as const, text: `Error: ${response.error}` }] };
  return { content: [{ type: "text" as const, text: JSON.stringify(response.result, null, 2) }] };
};

export const GetCompanyInfoTool: ToolDefinition<typeof toolSchema> = { name: toolName, description: toolDescription, schema: toolSchema, handler: toolHandler };
