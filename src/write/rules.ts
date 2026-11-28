// Sanctuary Computer (quickbooks-mcp-293): the pre-send rules, the update's body and the check of it, contract 1.1 §15
// (docs/contracts/quickbooks.md in Stacksbot). Pure: no network, no state, nothing given is changed.
// Changed by Sanctuary Computer (quickbooks-mcp-294): each rule answers its reason with a detail, the case spec §6's free text needs
// and the ids it names (plan-1 P10), or null.
import type { UpdateEntity } from "./client.js";
import type { Change, Transaction } from "./compare.js";

/** The most lines one categorize call names. */
export const MAX_LINES = 20;
/** Each update entity's key in QuickBooks' answer. */
export const entityKey = (entity: UpdateEntity): "Purchase" | "Bill" => (entity === "purchase" ? "Purchase" : "Bill");

/** A rule's refusal: its reason, and its case (`case`, absent for a reason with one text) with the ids and type §6's text names. */
export type RuleAnswer = { reason: string; detail: Record<string, string> } | null;
const no = (reason: string, detail: Record<string, string> = {}): RuleAnswer => ({ reason, detail });

const ACCOUNT_LINE = "AccountBasedExpenseLineDetail";

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const prop = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);
/** The contract's id: what an input may name and the guard lets a path hold. */
export const isId = (value: unknown): value is string => typeof value === "string" && /^[0-9]{1,20}$/.test(value);

const linesOf = (txn: Transaction): unknown[] => (Array.isArray(txn.Line) ? txn.Line : []);
const isAccountLine = (line: unknown): boolean => prop(line, "DetailType") === ACCOUNT_LINE;
const refOf = (line: unknown, ref: "AccountRef" | "ClassRef"): unknown => prop(prop(line, ACCOUNT_LINE), ref);
/** As the compare reads it: an absent `ClassRef` is `null`, a present one with no string `value` no class there is. */
const classOf = (line: unknown): string | null | undefined => {
  const ref = refOf(line, "ClassRef");
  if (ref === undefined) return null;
  const value = prop(ref, "value");
  return typeof value === "string" ? value : undefined;
};

/** An answer's entity keys: everything but its `time`. */
export const entityKeys = (answer: Record<string, unknown>): string[] => Object.keys(answer).filter((key) => key !== "time");

/** Step 5, on the answer as fetched, `{ Purchase: … }` (a queried row is wrapped the same way). */
export function ruleType(entity: UpdateEntity, answer: Record<string, unknown>): RuleAnswer {
  const keys = entityKeys(answer);
  if (keys.length !== 1 || keys[0] !== entityKey(entity)) return no("write:type", { case: "entity", T: entityKey(entity) });
  return prop(answer.Purchase, "Credit") === true ? no("write:type", { case: "credit" }) : null;
}

/** Step 6. */
export function ruleStacksBill(entity: UpdateEntity, txn: Transaction): RuleAnswer {
  const starts = (value: unknown, prefix: string): boolean => typeof value === "string" && value.startsWith(prefix);
  if (entity !== "bill") return null;
  if (starts(txn.DocNumber, "Stacks_")) return no("write:stacks-bill", { case: "doc-number" });
  return starts(txn.PrivateNote, "garden3d invoice") ? no("write:stacks-bill", { case: "private-note" }) : null;
}

/** A string `YYYY-MM-DD` naming a real calendar date. */
function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  // A day past its month's end rolls into the next one.
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/**
 * Step 7, on `Preferences.AccountingInfoPrefs`. Once a close date is set, a `TxnDate` that is no date can't be shown to be after it.
 * A close date that is no date is `unreadable`; one the transaction isn't after is `before-send`, or undo's own `undo` (§6).
 */
export function ruleClosed(txn: Transaction, accountingInfoPrefs: Record<string, unknown>, undo = false): RuleAnswer {
  if (!Object.keys(accountingInfoPrefs).includes("BookCloseDate")) return null;
  const { BookCloseDate: closed } = accountingInfoPrefs;
  if (!isDate(closed)) return no("write:closed", { case: "unreadable" });
  return isDate(txn.TxnDate) && txn.TxnDate > closed ? null : no("write:closed", { case: undo ? "undo" : "before-send" });
}

/** Step 8's part on every fetched line, and undo's whole `line`: each has an `Id`, and no two share one. */
export function ruleIds(txn: Transaction): RuleAnswer {
  const ids = linesOf(txn).map((line) => prop(line, "Id"));
  return ids.every((id) => typeof id === "string" && id !== "") && new Set(ids).size === ids.length ? null : no("write:line", { case: "ids" });
}

/**
 * Step 8: the fetched lines' ids, and each named line, at least one, is an account-based one named once. In the step's own
 * order: no line named is `none` (the schema's `minItems` keeps it from a tool); then the fetched ids (`ids`); then, in call
 * order, the first named line that is `missing` or `not-account`; then the first line named again (`twice`).
 */
export function ruleLines(txn: Transaction, changes: readonly Pick<Change, "line_id">[]): RuleAnswer {
  const named = changes.map((change) => change.line_id);
  if (named.length === 0) return no("write:line", { case: "none" });
  const ids = ruleIds(txn);
  if (ids !== null) return ids;
  for (const id of named) {
    const line = linesOf(txn).find((one) => prop(one, "Id") === id);
    if (line === undefined) return no("write:line", { case: "missing", id });
    if (!isAccountLine(line)) return no("write:line", { case: "not-account", id });
  }
  const twice = named.find((id, i) => named.indexOf(id) !== i);
  return twice === undefined ? null : no("write:line", { case: "twice", id: twice });
}

/** §19's *subject line*: the fetched lines' ids, and at least one account-based line (`subject`: the write check's own case, 298). */
export function ruleSubjectLine(txn: Transaction): RuleAnswer {
  return linesOf(txn).some(isAccountLine) ? ruleIds(txn) : no("write:line", { case: "subject" });
}

/** Step 11: no named line's account or class would change. */
export function ruleNoop(txn: Transaction, changes: readonly Change[]): RuleAnswer {
  const changed = changes.some(({ line_id, account_id, class_id }) => {
    const line = linesOf(txn).find((one) => prop(one, "Id") === line_id);
    return prop(refOf(line, "AccountRef"), "value") !== account_id || (class_id !== undefined && classOf(line) !== class_id);
  });
  return changed ? null : no("write:noop");
}

/** The account and class values on every account-based line, as stored; an absent `ClassRef` is none. */
export function lineRefs(txn: Transaction): { accounts: unknown[]; classes: unknown[] } {
  const lines = linesOf(txn).filter(isAccountLine);
  return { accounts: lines.map((line) => prop(refOf(line, "AccountRef"), "value")), classes: lines.map(classOf).filter((value) => value !== null) };
}

/** §15 "Sparse body". What it can't change as asked `checkBody` refuses. */
export function buildBody(fetched: Transaction, changes: readonly Change[]): Record<string, unknown> {
  const { MetaData: _metaData, ...copied } = fetched;
  const Line = linesOf(fetched).map((line) => {
    const change = changes.find((one) => one.line_id === prop(line, "Id"));
    const detail = prop(line, ACCOUNT_LINE);
    if (change === undefined) return line;
    const after: Record<string, unknown> = { ...(detail as object), AccountRef: { value: change.account_id } };
    if (change.class_id === null) delete after.ClassRef;
    else if (change.class_id !== undefined) after.ClassRef = { value: change.class_id };
    return { ...(line as Record<string, unknown>), [ACCOUNT_LINE]: after };
  });
  return { ...copied, Line, sparse: true };
}

/** Equal as parsed JSON: own keys of any name, in any order; an array's items in order. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => same(item, b[i]));
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  const other = new Map(Object.entries(b));
  return keys.length === other.size && keys.every((key) => same(a[key], other.get(key)));
}

/** The record without some of its keys. */
const without = (record: Record<string, unknown>, ...keys: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));

/** The named line changed in its two refs, as asked, and nowhere else. */
function sameButRefs(fetched: unknown, sent: unknown, change: Change): boolean {
  if (!isRecord(sent) || !isAccountLine(fetched)) return false;
  const [before, after] = [prop(fetched, ACCOUNT_LINE), sent[ACCOUNT_LINE]];
  if (!isRecord(before) || !isRecord(after)) return false;
  const { class_id } = change;
  const classRef = class_id === undefined ? before.ClassRef : class_id === null ? undefined : { value: class_id };
  return (
    same(without(sent, ACCOUNT_LINE), without(fetched as Record<string, unknown>, ACCOUNT_LINE)) &&
    same(without(after, "AccountRef", "ClassRef"), without(before, "AccountRef", "ClassRef")) &&
    same(after.AccountRef, { value: change.account_id }) &&
    same(after.ClassRef, classRef)
  );
}

/** Step 12, on the text that is sent: the body it parses to, or null when anything but the named refs differs. */
export function checkBody(fetched: Transaction, bodyText: unknown, changes: readonly Change[]): Record<string, unknown> | null {
  if (typeof bodyText !== "string") return null;
  const body: unknown = JSON.parse(bodyText);
  if (!isRecord(body) || body.sparse !== true) return null;
  if (!same(without(body, "Line", "sparse"), without(fetched, "Line", "MetaData", "sparse"))) return null;
  const [before, after] = [fetched.Line, body.Line];
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return null;
  const changeOf = (line: unknown): Change | undefined => changes.find((change) => change.line_id === prop(line, "Id"));
  const kept = before.every((line, i) => {
    const change = changeOf(line);
    return change === undefined ? same(after[i], line) : sameButRefs(line, after[i], change);
  });
  // Each change is made, on a line of its own.
  const made = new Set(before.map(changeOf).filter((change) => change !== undefined));
  return kept && made.size === changes.length ? body : null;
}
