// Changed by Sanctuary Computer (quickbooks-mcp-286): page keys and filter keys pass on whatever their value, for the input normalizer to check.
export interface QuickbooksFilter {
  /** Field/column name to filter on */
  field: string;
  /** Value to match against */
  value: any;
  /** Comparison operator to use (default '=') */
  operator?: string;
}

export interface AdvancedQuickbooksSearchOptions {
  /** Array of filter objects that map to QuickBooks query filters */
  filters?: QuickbooksFilter[];
  /** Alias for filters — accepted by several tool schemas */
  criteria?: QuickbooksFilter[];
  /** Sort ascending by the provided field */
  asc?: string;
  /** Sort descending by the provided field */
  desc?: string;
  /** Maximum number of rows to return */
  limit?: number;
  /** Number of rows to skip from the start of the result set */
  offset?: number;
  /** If true, only a count of rows is returned */
  count?: boolean;
  /** If true, transparently fetches all records. */
  fetchAll?: boolean;
}

/**
 * User-supplied criteria can be one of:
 *  1. A simple criteria object (e.g. { Name: 'Foo' })
 *  2. An array of objects specifying field/value/operator
 *  3. An {@link AdvancedQuickbooksSearchOptions} object that is translated to the array format expected by node-quickbooks
 */
export type QuickbooksSearchCriteriaInput =
  | Record<string, any>
  | Array<Record<string, any>>
  | AdvancedQuickbooksSearchOptions;

/**
 * Convert various input shapes into the criteria shape that `node-quickbooks` expects.
 *
 * If the input is already an object or array that `node-quickbooks` understands, it is returned untouched.
 * If the input is an {@link AdvancedQuickbooksSearchOptions} instance, it is converted to an array of
 * `{field, value, operator}` objects.
 */
export function buildQuickbooksSearchCriteria(
  input: QuickbooksSearchCriteriaInput
): Record<string, any> | Array<Record<string, any>> {
  // If the user supplied an array we assume they know what they're doing.
  if (Array.isArray(input)) {
    return input as Array<Record<string, any>>;
  }

  // If the input is a plain object that does NOT look like advanced options, forward as-is
  const possibleAdvancedKeys: (keyof AdvancedQuickbooksSearchOptions)[] = [
    "filters",
    "criteria",
    "asc",
    "desc",
    "limit",
    "offset",
    "count",
    "fetchAll",
  ];

  const inputKeys = Object.keys(input || {});
  const isAdvanced = inputKeys.some((k) =>
    possibleAdvancedKeys.includes(k as keyof AdvancedQuickbooksSearchOptions)
  );

  if (!isAdvanced) {
    // simple criteria object – pass through
    return input as Record<string, any>;
  }

  // At this point we treat the input as AdvancedQuickbooksSearchOptions
  const options = input as AdvancedQuickbooksSearchOptions;
  const criteriaArr: Array<Record<string, any>> = [];

  // Convert filters (accept both "filters" and "criteria" as the key)
  const filterList = options.filters ?? options.criteria;
  filterList?.forEach((f) => {
    criteriaArr.push({ field: f.field, value: f.value, operator: f.operator });
  });

  // Changed by Sanctuary Computer (quickbooks-mcp-286): every other key is a filter, passed on as node-quickbooks reads
  // a plain record's key (`IN` for an array), never dropped: so `{ CustomerRef: '5', offset: 1001 }` stays filtered,
  // and the normalizer checks each key's name and value (a case variant of a page key, fetchAll or count included).
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined || possibleAdvancedKeys.includes(key as keyof AdvancedQuickbooksSearchOptions)) continue;
    criteriaArr.push(Array.isArray(value) ? { field: key, value, operator: "IN" } : { field: key, value });
  }

  // Sorting and pagination / meta. Changed by Sanctuary Computer (quickbooks-mcp-286): every key given is passed on,
  // whatever its value, so that the input normalizer (validate-input.ts) sees it and refuses a bad one, never drops it.
  for (const key of ["asc", "desc", "limit", "offset", "count", "fetchAll"] as const) {
    if (options[key] !== undefined) criteriaArr.push({ field: key, value: options[key] });
  }

  // If nothing ended up in the array, return empty object so Quickbooks returns all items.
  return criteriaArr.length > 0 ? criteriaArr : {};
} 