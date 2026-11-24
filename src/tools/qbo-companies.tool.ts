// Sanctuary Computer (quickbooks-mcp-285): the qbo_companies tool, with no schema.
// Changed by Sanctuary Computer (quickbooks-mcp-286): it answers the loaded QBO_COMPANIES' keys and names, in file order,
// as one compact JSON line, with no request (spec A2.7, A3.8; contract §4, tool-results/qbo_companies/ok.json).
import type { CompaniesToolDefinition } from "../allowlist.js";

export const QboCompaniesTool: CompaniesToolDefinition = {
  name: "qbo_companies",
  description: "List the companies this server can read (key, name), for the company argument of every other tool.",
  handler: async (_args, runtime) => ({
    content: [{ type: "text", text: JSON.stringify(runtime.cfg.companies.map(({ key, name }) => ({ key, name }))) }],
  }),
};
