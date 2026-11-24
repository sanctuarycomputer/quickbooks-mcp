// Changed by Sanctuary Computer (quickbooks-mcp-286, T12 fix 1b and fix 2): the criterion schemas keep unknown keys,
// and countToolCriteria reads the list as sent: a mixed list, a key it would lose, or a key given twice is refused.
import { searchQuickbooksCustomers } from "../handlers/search-quickbooks-customers.handler.js";
import { countToolCriteria, refusal } from "../helpers/validate-input.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "search_customers";
const toolDescription = "Search customers in QuickBooks Online that match given criteria.";

// Common Customer entity fields that are filterable. Not exhaustive – any
// property present on the QuickBooks Customer object is valid.
const customerFieldEnum = z.enum([
  "Id",
  "DisplayName",
  "GivenName",
  "FamilyName",
  "CompanyName",
  "PrimaryEmailAddr",
  "PrimaryPhone",
  "Balance",
  "Active",
  "MetaData.CreateTime",
  "MetaData.LastUpdatedTime",
]).describe(
  "Field to filter on – must be a property of the QuickBooks Online Customer entity."
);

const criterionSchema = z.object({
  key: z.string().describe("Simple key (legacy) – any Customer property name."),
  value: z.union([z.string(), z.boolean()]),
}).loose(); // T12 fix 2 (TC12-2): unknown keys reach countToolCriteria

const advancedCriterionSchema = z.object({
  field: customerFieldEnum,
  value: z.union([z.string(), z.boolean()]),
  operator: z.enum(["=", "<", ">", "<=", ">=", "LIKE", "IN"]).optional(),
}).loose(); // T12 fix 2 (TC12-2): unknown keys reach normalizeSearch

const toolSchema = z.object({
  // Criteria can be passed as list of key/value/operator triples (array form)
  // or omitted for unfiltered search.
  criteria: z
    .array(advancedCriterionSchema.or(criterionSchema))
    .optional()
    .describe(
      "Filters to apply. Use the advanced form {field,value,operator?} for operators or the simple {key,value} pairs."
    ),

  // Pagination / sorting / count
  limit: z.number().optional(),
  offset: z.number().optional(),
  asc: z.string().optional(),
  desc: z.string().optional(),
  fetchAll: z.boolean().optional(),
  count: z.boolean().optional(),
});

const toolHandler = async (args: any) => {
  const { criteria = [], ...options } = (args.params ?? {}) as z.infer<typeof toolSchema>;

  // Build criteria to send to SDK. If user provided the advanced array with field/operator/value
  // we pass it straight through. Otherwise we transform legacy {key,value} pairs to object.
  // Sanctuary Computer (quickbooks-mcp-286, T12 fix 2): the fold is countToolCriteria's, which refuses what it would
  // lose or rewrite (TC12-1, TC12-2); a refusal records the failure and nothing is sent.
  const folded = countToolCriteria(criteria, options);
  if (!folded.ok) {
    refusal(folded.failure);
    return { content: [{ type: "text" as const, text: `Error searching customers: ${folded.failure.text}` }] };
  }
  const criteriaToSend = folded.criteria;

  const response = await searchQuickbooksCustomers(criteriaToSend);
  if (response.isError) {
    return {
      content: [{ type: "text" as const, text: `Error searching customers: ${response.error}` }],
    };
  }
  return {
    content: [
      { type: "text" as const, text: Array.isArray(response.result) ? `Found ${response.result.length} customers:` : `Count: ${response.result}` },
      ...(Array.isArray(response.result)
        ? response.result.map((c) => ({ type: "text" as const, text: JSON.stringify(c) }))
        : []),
    ],
  };
};

export const SearchCustomersTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
}; 