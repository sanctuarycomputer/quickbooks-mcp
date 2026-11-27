// Sanctuary Computer (quickbooks-mcp-293): write mode's four tools before they are built: contract 1.1 §13's schemas and descriptions
// (docs/contracts/quickbooks.md in Stacksbot), each answering an error. 294 builds categorize and undo, 298 the write check.
// Changed by Sanctuary Computer (quickbooks-mcp-294): the two categorize tools are categorize.ts's now (T7); undo and the write check stay.
import { z } from "zod";
import type { WriteToolDefinition } from "../helpers/register-tool.js";
import { errorResult } from "../helpers/tool-result.js";

const notBuilt = async () => errorResult({ reason: "fork-error", text: "This tool is not built yet." }, []);

export const QboUndoChangeTool = {
  name: "qbo_undo_change",
  description: "Put back an earlier change made with a categorize tool, by its receipt key.",
  schema: z.strictObject({
    receipt: z
      .string()
      .regex(/^quickbooks-write:(sanctuary-computer|garden3d|index-space|usb-club):(purchase|bill):[0-9]{1,20}:[0-9]{1,20}:[1-9][0-9]{0,5}(:intent)?$/),
  }),
  handler: notBuilt,
} satisfies WriteToolDefinition<any>;

export const QboWriteCheckTool = {
  name: "qbo_write_check",
  description: "Run the write path's checks for a company without changing anything (the daily check's dry run).",
  schema: z.strictObject({ settle: z.boolean().default(true) }),
  handler: notBuilt,
} satisfies WriteToolDefinition<any>;
