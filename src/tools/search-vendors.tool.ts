// Changed by Sanctuary Computer (quickbooks-mcp-286, T12 fix 1b and fix 2): the criterion schemas keep unknown keys,
// and countToolCriteria reads the list as sent: a mixed list, a key it would lose, or a key given twice is refused.
import { searchQuickbooksVendors } from "../handlers/search-quickbooks-vendors.handler.js";
import { countToolCriteria, refusal } from "../helpers/validate-input.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "search_vendors";
const toolDescription = "Search vendors in QuickBooks Online that match given criteria.";

// A subset of commonly-used Vendor fields that can be filtered on.
// This is *not* an exhaustive list, but provides helpful IntelliSense / docs
// to users of the tool. Any field returned in the Quickbooks Vendor entity is
// technically valid.
const vendorFieldEnum = z.enum([
  "Id",
  "SyncToken",
  "MetaData.CreateTime",
  "MetaData.LastUpdatedTime",
  "GivenName",
  "MiddleName",
  "FamilyName",
  "CompanyName",
  "DisplayName",
  "PrintOnCheckName",
  "Active",
  "PrimaryPhone",
  "AlternatePhone",
  "Mobile",
  "Fax",
  "PrimaryEmailAddr",
  "WebAddr",
  "Title",
  "Balance",
  "BillRate",
  "AcctNum",
  "Vendor1099"
]).describe(
  "Field to filter on – must be a property of the QuickBooks Online Vendor entity."
);

const criterionSchema = z.object({
  key: z.string().describe("Simple key (legacy) – any Vendor property name."),
  value: z.union([z.string(), z.boolean()]),
}).loose(); // T12 fix 2 (TC12-2): unknown keys reach countToolCriteria

// Advanced criterion schema with operator support.
const advancedCriterionSchema = z.object({
  field: vendorFieldEnum,
  value: z.union([z.string(), z.boolean()]),
  operator: z
    .enum(["=", "<", ">", "<=", ">=", "LIKE", "IN"])
    .optional()
    .describe("Comparison operator. Defaults to '=' if omitted."),
}).loose(); // T12 fix 2 (TC12-2): unknown keys reach normalizeSearch

const toolSchema = z.object({
  // Allow advanced criteria array like [{field,value,operator}]
  criteria: z
    .array(advancedCriterionSchema.or(criterionSchema))
    .optional()
    .describe(
      "Filters to apply. Use the advanced form {field,value,operator?} for operators or the simple {key,value} pairs."
    ),

  limit: z.number().optional(),
  offset: z.number().optional(),
  asc: z.string().optional(),
  desc: z.string().optional(),
  fetchAll: z.boolean().optional(),
  count: z.boolean().optional(),
});

export const SearchVendorsTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: async (args) => {
    const { criteria = [], ...options } = (args.params ?? {}) as z.infer<typeof toolSchema>;

    // build criteria to pass to SDK, supporting advanced operator syntax
    // Sanctuary Computer (quickbooks-mcp-286, T12 fix 2): the fold is countToolCriteria's, which refuses what it would
    // lose or rewrite (TC12-1, TC12-2); a refusal records the failure and nothing is sent.
    const folded = countToolCriteria(criteria, options);
    if (!folded.ok) {
      refusal(folded.failure);
      return { content: [{ type: "text" as const, text: `Error searching vendors: ${folded.failure.text}` }] };
    }
    const criteriaToSend = folded.criteria;

    const response = await searchQuickbooksVendors(criteriaToSend);
    if (response.isError) {
      return {
        content: [{ type: "text" as const, text: `Error searching vendors: ${response.error}` }],
      };
    }
    return {
      content: [
        { type: "text" as const, text: Array.isArray(response.result) ? `Found ${response.result.length} vendors:` : `Count: ${response.result}` },
        ...(Array.isArray(response.result)
          ? response.result.map((v) => ({ type: "text" as const, text: JSON.stringify(v) }))
          : []),
      ],
    };
  },
}; 