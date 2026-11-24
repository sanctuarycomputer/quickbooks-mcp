// Sanctuary Computer (quickbooks-mcp-286): the input normalizer (spec A5.1-A5.3, A5.13, A6.3, A6.4; D6, D8, D9). Every
// search handler calls normalizeSearch on the criteria it is about to hand `find*`, and every report handler calls
// normalizeReport on its options before `report*`: a refusal records a `fork-error` with D6's sentence and sends nothing.
// The patterns are the fork review's §Allowlist (query and reports/<Name> rows), transcribed by contract §6.
import QuickBooks from "node-quickbooks";
import { recordFailure, type Failure } from "../clients/call-context.js";
import type { ToolResponse } from "../types/tool-response.js";
import { buildQuickbooksSearchCriteria } from "./build-quickbooks-search-criteria.js";

// node-quickbooks' own operator list (index.js:24): an operator outside it never reaches the statement.
const QUERY_OPERATORS: readonly string[] = (QuickBooks as unknown as { QUERY_OPERATORS: string[] }).QUERY_OPERATORS;

const NAME = /^[A-Za-z][A-Za-z0-9.]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IDS = /^[0-9]{1,20}(,[0-9]{1,20})*$/;
const SORT_BY = /^[A-Za-z_]{1,64}$/;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
/** `\p{Zs}` other than U+0020, and U+0085, U+2028, U+2029 (contract §6's `query` rule at 66cd209c). */
const SEPARATOR = /(?! )\p{Zs}|[\u0085\u2028\u2029]/u;
/** `from` as a word: no letter, digit or `_` on either side, any case (contract §6's `query` rule). */
const FROM_WORD = /(?<![A-Za-z0-9_])from(?![A-Za-z0-9_])/i;
const MAX_STRING = 200;
const MAX_LIMIT = 1000;

/** The three whose upstream tool files have the count form (D9): only there is a lone `count: true` accepted. */
const COUNT_TOOLS: readonly string[] = ["search_bills", "search_customers", "search_vendors"];
/** The three that take their page keys only inside `criteria`, so their next offset is passed there (A5.11). */
const CRITERIA_ONLY_TOOLS: readonly string[] = ["search_accounts", "search_invoices", "search_items"];

type PageKey = "limit" | "offset" | "asc" | "desc";
const PAGE_KEYS: readonly PageKey[] = ["limit", "offset", "asc", "desc"];

export type SearchTop = { limit?: unknown; offset?: unknown; count?: unknown };
export type SearchNormalized =
  | { ok: true; criteria: object | unknown[]; usedOffset: number; count: boolean; criteriaOffset: boolean }
  | { ok: false; failure: Failure };
export type ReportNormalized = { ok: true; options: object } | { ok: false; failure: Failure };

/** D6's criteria refusal. */
export function searchRefusalText(what: string): string {
  return `The search was refused before reaching QuickBooks: ${what}. Use limit up to 1000 and page with offset.`;
}

/** D6's report-option refusal. */
export function reportRefusalText(option: string): string {
  return `The report was refused before reaching QuickBooks: ${option} isn't a valid value.`;
}

/** Records the refusal on the call (a no-op outside one) and answers the handler's error path; no request was made. */
export function refusal(failure: Failure): ToolResponse<never> {
  recordFailure(failure);
  return { result: null, isError: true, error: failure.text as string };
}

class Refused extends Error {
  constructor(readonly what: string) {
    super(what);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** An integer from `lo` to `hi`; never a string, so `"2"` is refused. */
const wholeIn = (v: unknown, lo: number, hi: number): boolean => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

function checkName(name: unknown, what: string): string {
  if (typeof name !== "string" || !NAME.test(name) || FROM_WORD.test(name)) throw new Refused(what);
  return name;
}

function checkScalar(v: unknown, field: string): void {
  if (typeof v === "boolean") return;
  if (Number.isFinite(v)) return;
  if (typeof v === "string") {
    if (SEPARATOR.test(v)) throw new Refused(`the value for ${field} holds a space other than a plain space`);
    if (v.length > MAX_STRING || v.includes("\\") || CONTROL.test(v)) throw new Refused(`the value for ${field} isn't valid`);
    if (FROM_WORD.test(v)) throw new Refused(`the value for ${field} holds the word from`);
    return;
  }
  throw new Refused(`the value for ${field} isn't valid`);
}

function checkValue(v: unknown, field: string): void {
  // An array (for IN) of scalars: checkScalar refuses a nested array, as anything that isn't one.
  if (Array.isArray(v)) {
    for (const e of v) checkScalar(e, field);
    return;
  }
  checkScalar(v, field);
}

function checkPageValue(key: PageKey, v: unknown): void {
  if (key === "limit") {
    if (!wholeIn(v, 1, MAX_LIMIT)) throw new Refused("limit must be a whole number from 1 to 1000");
  } else if (key === "offset") {
    if (!wholeIn(v, 1, Infinity)) throw new Refused("offset must be a whole number of at least 1");
  } else {
    checkName(v, `${key} must name a field`);
  }
}

/** One walk over every shape the criteria arrive in, keys compared case-insensitively (fork review §Page size). */
class Walk {
  readonly page = new Map<PageKey, unknown>();
  /** Each `count` seen; `inArray` when it came from inside an array (an entry or a record), never the count form. */
  readonly counts: { value: unknown; inArray: boolean }[] = [];
  filters = 0;

  /** A key or `{field}` name that isn't a filter: true when it was taken as a page key or `count`. */
  private special(name: string, value: unknown, inArray: boolean): boolean {
    const lower = name.toLowerCase();
    if (lower === "fetchall") throw new Refused("fetchAll isn't supported");
    if (lower === "count") {
      this.counts.push({ value, inArray });
      return true;
    }
    const key = PAGE_KEYS.find((k) => k === lower);
    if (key === undefined) return false;
    if (this.page.has(key)) throw new Refused(`${key} is given more than once`);
    checkPageValue(key, value);
    this.page.set(key, value);
    return true;
  }

  /** A plain record's keys (the whole criteria object, or one record in an array): each key a field, its value `=` or `IN`. */
  record(rec: Record<string, unknown>, inArray: boolean): Record<string, unknown> {
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (v === undefined || this.special(k, v, inArray)) continue;
      checkName(k, "a field name isn't valid");
      checkValue(v, k);
      kept[k] = v;
      this.filters++;
    }
    return kept;
  }

  /** A `{field, value, operator?}` entry, as node-quickbooks' toCriterion reads one. */
  entry(e: Record<string, unknown>): Record<string, unknown> | null {
    if (Object.keys(e).some((k) => k !== "field" && k !== "value" && k !== "operator")) throw new Refused("a criterion has a key other than field, value and operator");
    const field = checkName(e.field, "a field name isn't valid");
    if (this.special(field, e.value, true)) return null;
    if (e.operator !== undefined && !QUERY_OPERATORS.includes(e.operator as string)) throw new Refused(`the operator isn't one of ${QUERY_OPERATORS.join(" ")}`);
    checkValue(e.value, field);
    this.filters++;
    return e.operator === undefined ? { field, value: e.value } : { field, value: e.value, operator: e.operator };
  }

  top(top: SearchTop): void {
    for (const key of ["limit", "offset", "count"] as const) {
      if (top[key] !== undefined) this.special(key, top[key], false);
    }
  }
}

/** The count form (D9): accepted only on the three, as a lone `count: true` key with no criterion and no page key. */
function countForm(tool: string, w: Walk): boolean {
  if (w.counts.length === 0) return false;
  if (!COUNT_TOOLS.includes(tool)) throw new Refused("count isn't supported by this tool");
  const [c] = w.counts;
  if (w.counts.length > 1 || c.inArray || c.value !== true || w.filters > 0 || w.page.size > 0) {
    throw new Refused("count is supported only as count: true with no other criterion and no page key");
  }
  return true;
}

function pageEntries(w: Walk): { field: string; value: unknown }[] {
  const out = PAGE_KEYS.filter((k) => w.page.has(k)).map((k) => ({ field: k, value: w.page.get(k) }));
  if (!w.page.has("limit")) out.push({ field: "limit", value: MAX_LIMIT });
  return out;
}

/**
 * Checks the criteria a search handler is about to pass `find*`, with the tool's own top-level page keys in `top`, and
 * gives them back with the page keys under their exact names and `limit` 1000 when none is given: an object stays an
 * object and an array an array, so node-quickbooks reads them as before. `usedOffset` is the `startposition` the
 * request carries (`1` when no offset is given); `criteriaOffset` is true for the three tools whose offset goes inside
 * `criteria`.
 */
export function normalizeSearch(tool: string, criteria: unknown, top: SearchTop = {}): SearchNormalized {
  try {
    const w = new Walk();
    w.top(top);
    let out: object | unknown[];
    if (criteria === undefined || criteria === null) {
      out = {};
    } else if (Array.isArray(criteria)) {
      const kept: unknown[] = [];
      for (const el of criteria) {
        if (!isRecord(el)) throw new Refused("each criterion must be an object");
        if ("field" in el && "value" in el) {
          const e = w.entry(el);
          if (e !== null) kept.push(e);
        } else {
          const r = w.record(el, true);
          if (Object.keys(r).length > 0) kept.push(r);
        }
      }
      out = kept;
    } else if (isRecord(criteria)) {
      out = w.record(criteria, false);
    } else {
      throw new Refused("criteria must be an object or an array");
    }
    if (countForm(tool, w)) {
      return { ok: true, criteria: { count: true }, usedOffset: 1, count: true, criteriaOffset: false };
    }
    const page = pageEntries(w);
    const criteriaOut = Array.isArray(out) ? [...out, ...page] : { ...out, ...Object.fromEntries(page.map((p) => [p.field, p.value])) };
    const usedOffset = (w.page.get("offset") as number | undefined) ?? 1;
    return { ok: true, criteria: criteriaOut, usedOffset, count: false, criteriaOffset: CRITERIA_ONLY_TOOLS.includes(tool) };
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    return refusedSearch(e.what);
  }
}

/**
 * For the seven handlers that build their criteria with buildQuickbooksSearchCriteria: checks every value the builder
 * dereferences before it runs (its `filters` or `criteria` list must be an array of objects, and only one of the two
 * may be given, since the builder would drop the other), then builds and normalizes.
 */
export function normalizeBuiltSearch(tool: string, input: unknown): SearchNormalized {
  if (isRecord(input)) {
    const lists = (["filters", "criteria"] as const).filter((k) => input[k] !== undefined && input[k] !== null);
    if (lists.length > 1) return refusedSearch("give filters or criteria, not both");
    for (const key of lists) {
      const list = input[key];
      if (!Array.isArray(list)) return refusedSearch(`${key} must be an array`);
      if (!list.every(isRecord)) return refusedSearch("each criterion must be an object");
    }
  }
  return normalizeSearch(tool, buildQuickbooksSearchCriteria(input as Record<string, unknown>));
}

const refusedSearch = (what: string): SearchNormalized => ({ ok: false, failure: { reason: "fork-error", text: searchRefusalText(what) } });

type OptionRule = (v: unknown) => boolean;
const matches = (re: RegExp): OptionRule => (v) => typeof v === "string" && re.test(v);
const oneOf = (values: readonly string[]): OptionRule => (v) => values.includes(v as string);
const periods: OptionRule = (v) => wholeIn(v, 1, 999);

// The enums are each tool schema's own (src/tools/get-*.tool.ts); the keys are contract §6's Report query keys.
const METHOD = oneOf(["Cash", "Accrual"]);
const SUMMARIZE = oneOf(["Total", "Month", "Week", "Days"]);
const AGING = oneOf(["Current", "Report_Date"]);
const DATES: Record<string, OptionRule> = { start_date: matches(DATE), end_date: matches(DATE) };
const ID = matches(IDS);
const AGED = { report_date: matches(DATE), aging_method: AGING, days_per_aging_period: periods, num_periods: periods };

const REPORT_RULES = {
  get_aged_payables: { ...AGED, vendor: ID },
  get_aged_receivables: { ...AGED, customer: ID },
  get_balance_sheet: { ...DATES, accounting_method: METHOD, summarize_column_by: SUMMARIZE },
  get_cash_flow: { ...DATES, summarize_column_by: SUMMARIZE },
  get_customer_balance: { report_date: matches(DATE), customer: ID, summarize_column_by: SUMMARIZE },
  get_customer_sales: { ...DATES, customer: ID, summarize_column_by: SUMMARIZE },
  get_general_ledger: { ...DATES, accounting_method: METHOD, account: ID, source_account: ID, sort_by: matches(SORT_BY) },
  get_profit_and_loss: {
    ...DATES,
    accounting_method: METHOD,
    summarize_column_by: oneOf(["Total", "Month", "Week", "Days", "Classes"]),
    customer: ID,
    vendor: ID,
    item: ID,
    department: ID,
    class: ID,
  },
  get_trial_balance: { ...DATES, accounting_method: METHOD },
  get_vendor_balance: { report_date: matches(DATE), vendor: ID, summarize_column_by: SUMMARIZE },
  get_vendor_expenses: { ...DATES, vendor: ID, summarize_column_by: SUMMARIZE, accounting_method: METHOD },
} satisfies Record<string, Record<string, OptionRule>>;

export type ReportTool = keyof typeof REPORT_RULES;

/** Checks a report handler's options against its keys' patterns (A6.4); none of them admits `&`, `#`, `=` or `%`. Gives back only those keys. */
export function normalizeReport(tool: ReportTool, options: unknown): ReportNormalized {
  const refuse = (option: string): ReportNormalized => ({ ok: false, failure: { reason: "fork-error", text: reportRefusalText(option) } });
  if (options === undefined || options === null) return { ok: true, options: {} };
  if (!isRecord(options)) return refuse("options");
  const rules: Record<string, OptionRule> = REPORT_RULES[tool];
  // Only the keys checked here are passed on: a key with no rule never reaches the handler (T8-6).
  const checked: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(rules)) {
    const v = options[key];
    if (v === undefined) continue;
    if (!rule(v)) return refuse(key);
    checked[key] = v;
  }
  return { ok: true, options: checked };
}
