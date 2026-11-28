// Sanctuary Computer (quickbooks-mcp-293): write mode's four tools before they are built: contract 1.1 §13's schemas and descriptions
// (docs/contracts/quickbooks.md in Stacksbot), each answering an error. 294 builds categorize and undo, 298 the write check.
// Changed by Sanctuary Computer (quickbooks-mcp-294): the two categorize tools are categorize.ts's now (T7), and undo is undo.ts's (T8);
// the write check stays.
import { z } from "zod";
import type { WriteToolDefinition } from "../helpers/register-tool.js";
import { errorResult } from "../helpers/tool-result.js";

const notBuilt = async () => errorResult({ reason: "fork-error", text: "This tool is not built yet." }, []);

export const QboWriteCheckTool = {
  name: "qbo_write_check",
  description: "Run the write path's checks for a company without changing anything (the daily check's dry run).",
  schema: z.strictObject({ settle: z.boolean().default(true) }),
  handler: notBuilt,
} satisfies WriteToolDefinition<any>;
