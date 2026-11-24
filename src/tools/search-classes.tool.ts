// Changed by Sanctuary Computer (quickbooks-mcp-286): a top-level offset, so this search can page (A5.13).
import { searchQuickbooksClasses } from "../handlers/search-quickbooks-classes.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "search_classes";
const toolDescription = "Search for classes in QuickBooks Online with optional filters.";
const toolSchema = z.object({
  name: z.string().optional().describe("Filter by class name"),
  active: z.boolean().optional().describe("Filter by active status"),
  limit: z.number().optional().describe("Maximum results to return"),
  offset: z.number().int().min(1).optional(),
});

const toolHandler = async ({ params }: any) => {
  const response = await searchQuickbooksClasses(params);
  if (response.isError) return { content: [{ type: "text" as const, text: `Error: ${response.error}` }] };
  return { content: [{ type: "text" as const, text: `Found ${response.result.length} classes:` }, { type: "text" as const, text: JSON.stringify(response.result, null, 2) }] };
};

export const SearchClassesTool: ToolDefinition<typeof toolSchema> = { name: toolName, description: toolDescription, schema: toolSchema, handler: toolHandler };
