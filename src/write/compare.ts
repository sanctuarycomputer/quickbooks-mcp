// Sanctuary Computer (quickbooks-mcp-293): the digests and the compare, contract 1.1 §17 (docs/contracts/quickbooks.md in
// Stacksbot). Names what differs between the fetched transaction (or an intent's digests) and the stored one. Pure: no
// network, no state. A stored copy of any JSON shape is read without throwing, and what it can't match it names.
import { canonicalJson, sha256Hex } from "./canonical.js";

/** A transaction as QuickBooks' JSON, out of its envelope. */
export type Transaction = Record<string, unknown>;
/** A change as asked: an absent `class_id` keeps the fetched class, `null` clears it. */
export type Change = { line_id: string; account_id: string; class_id?: string | null };
/** A change with the class it ends on. */
export type ResolvedChange = { line_id: string; account_id: string; class_id: string | null };
export type CompareResult = { same: true } | { same: false; fields: string[] };

const hash = (value: unknown): string => sha256Hex(canonicalJson(value));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const prop = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

const linesOf = (txn: Transaction): unknown[] => (Array.isArray(txn.Line) ? txn.Line : []);
const refOf = (line: unknown, ref: "AccountRef" | "ClassRef"): unknown => prop(prop(line, "AccountBasedExpenseLineDetail"), ref);
const accountOf = (line: unknown): unknown => prop(refOf(line, "AccountRef"), "value");
/** A line's class: an absent `ClassRef` reads as `null`; one with no `value` isn't absent, and matches no class. */
const classOf = (line: unknown): unknown => {
  const ref = refOf(line, "ClassRef");
  return ref === undefined || ref === null ? null : prop(ref, "value");
};

/** The line without its account-based detail's two refs; the rest of it, own keys of any name included, as it was. */
function withoutRefs(line: unknown): unknown {
  const detail = prop(line, "AccountBasedExpenseLineDetail");
  if (!isRecord(detail)) return line;
  const { AccountRef: _account, ClassRef: _class, ...rest } = detail;
  return { ...(line as Record<string, unknown>), AccountBasedExpenseLineDetail: rest };
}

/** Each change with its class resolved against the fetched transaction. */
export function resolveChanges(fetched: Transaction, changes: readonly Change[]): ResolvedChange[] {
  return changes.map(({ line_id, account_id, class_id }) => {
    if (class_id !== undefined) return { line_id, account_id, class_id };
    const kept = classOf(linesOf(fetched).find((line) => prop(line, "Id") === line_id));
    return { line_id, account_id, class_id: typeof kept === "string" ? kept : null };
  });
}

/** §17 "Digests": a hash per top-level field, one of the line ids in order, and one per line that has an `Id`. */
export function digests(txn: Transaction, named: Iterable<string>): Record<string, string> {
  const namedIds = new Set<unknown>(named);
  const lines = linesOf(txn);
  const entries: [string, string][] = [["Line", hash(lines.map((line) => prop(line, "Id")))]];
  for (const line of lines) {
    const id = prop(line, "Id");
    if (typeof id === "string") entries.push([`Line:${id}`, hash(namedIds.has(id) ? withoutRefs(line) : line)]);
  }
  // Fields go last, so one that shares a line's key shows instead of being lost. `fromEntries` defines each own key, `__proto__` too.
  for (const [key, value] of Object.entries(txn)) {
    if (key !== "SyncToken" && key !== "MetaData" && key !== "sparse" && key !== "Line") entries.push([key, hash(value)]);
  }
  return Object.fromEntries(entries);
}

/** §17 "Compare", against an intent's digests (made with the same named lines). */
export function compareDigests(stored: Transaction, intentDigests: Record<string, string>, changes: readonly ResolvedChange[]): CompareResult {
  // Maps, so a key is read only if it is an own one.
  const before = new Map(Object.entries(intentDigests));
  const after = new Map(Object.entries(digests(stored, changes.map((change) => change.line_id))));
  const names = new Set<string>();
  const oneSided = (key: string) => before.has(key) !== after.has(key);
  const keys = [...before.keys(), ...after.keys()].filter((key) => key !== "Line");
  for (const key of keys) if (before.get(key) !== after.get(key)) names.add(key);
  // A missing or extra line accounts for differing line ids; anything else that changed them is named Line.
  if (before.get("Line") !== after.get("Line") && !keys.some((key) => key.startsWith("Line:") && oneSided(key))) names.add("Line");

  for (const change of changes) {
    const copies = linesOf(stored).filter((line) => prop(line, "Id") === change.line_id);
    if (copies.length === 0) names.add(`Line:${change.line_id}`);
    for (const line of copies) {
      if (accountOf(line) !== change.account_id) names.add(`Line:${change.line_id}.AccountRef`);
      if (classOf(line) !== change.class_id) names.add(`Line:${change.line_id}.ClassRef`);
    }
  }
  return names.size === 0 ? { same: true } : { same: false, fields: [...names].sort() };
}

/** §17 "Compare", against the fetched transaction in memory: the same names as through its digests. */
export function compare(stored: Transaction, fetched: Transaction, changes: readonly Change[]): CompareResult {
  return compareDigests(stored, digests(fetched, changes.map((change) => change.line_id)), resolveChanges(fetched, changes));
}
