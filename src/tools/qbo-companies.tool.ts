// Sanctuary Computer (quickbooks-mcp-285): the qbo_companies stub; the Stacks token client replaces its answer.
import type { CompaniesToolDefinition } from "../allowlist.js";

export const QboCompaniesTool: CompaniesToolDefinition = {
  name: "qbo_companies",
  description: "List the companies this server can read (key, name), for the company argument of every other tool.",
  handler: async () => ({
    isError: true,
    content: [{ type: "text", text: "reason: fork-error\n\nqbo_companies lands with the Stacks token client" }],
  }),
};
