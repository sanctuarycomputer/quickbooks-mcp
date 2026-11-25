// Sanctuary Computer (quickbooks-mcp-293): write mode's four tools before they are built: contract 1.1 §13's schemas and descriptions
// (docs/contracts/quickbooks.md in Stacksbot), each answering an error. 294 builds categorize and undo, 298 the write check.
import { z } from "zod";
import type { WriteToolDefinition } from "../helpers/register-tool.js";
import { errorResult } from "../helpers/tool-result.js";

const notBuilt = async () => errorResult({ reason: "fork-error", text: "This tool is not built yet." }, []);

const id = z.string().regex(/^[0-9]{1,20}$/);

const categorizeParams = z.strictObject({
  id,
  lines: z.array(z.strictObject({ line_id: id, account_id: id, class_id: id.nullable().optional() })).min(1),
  reason: z
    .string()
    .min(1)
    .max(200)
    // UTF-16 code units, where zod counts characters.
    .refine((text) => text.length <= 200)
    .regex(/\S/)
    .regex(/^[^\p{Cc}\u2028\u2029]*$/u),
});

const categorize = (name: string, type: string): WriteToolDefinition<typeof categorizeParams> => ({
  name,
  description:
    `Change the expense account (category) and optionally the class of existing expense lines on one QuickBooks ${type}. ` +
    "`reason` is a short plain sentence stored in the team's Audit Log: leave amounts out of it.",
  schema: categorizeParams,
  handler: notBuilt,
});

export const QboCategorizePurchaseTool = categorize("qbo_categorize_purchase", "Purchase");
export const QboCategorizeBillTool = categorize("qbo_categorize_bill", "Bill");

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
