// Sanctuary Computer (quickbooks-mcp-294): the write tools' results, contract 1.2 §14 (docs/contracts/quickbooks.md in Stacksbot):
// an error's header block in the Write result grammar's order (never `writes_off`, spec V2), a success's change item with exactly
// the Change result keys, spec §6's free texts, and a 1.0 reason as 286's result less its trailing status (spec §3).
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Failure } from "../clients/call-context.js";
import { errorResult, REASON_TEXT } from "../helpers/tool-result.js";

/** The write keys an error's header may carry after `reason`, in the grammar's order (`settled` is the write check's, 298). */
export type Head = { receipt: string; code: string; intuit_tid: string; note: "id-mismatch"; recorded: "notion" | "ledger" | "none" };
const HEAD_KEYS = ["receipt", "code", "intuit_tid", "note", "recorded"] as const;
/** §5's `intuit_tid`, which §14 keeps: a value off it, or not a string at all, gives no line, as 286's renderer does. */
const TID = /^[A-Za-z0-9-]{1,64}$/;
/** §14's `code`: QuickBooks' Fault code. */
const CODE = /^[A-Za-z0-9_-]{1,64}$/;
/** The values `note` and `recorded` may take, on an error and on a success. */
const NOTES: readonly unknown[] = ["id-mismatch"];
const ERROR_RECORDED: readonly unknown[] = ["ledger", "none"];
const SUCCESS_RECORDED: readonly unknown[] = ["notion", "ledger", "none"];

export type Refs = { account_id: string; class_id: string | null };
/** One named line of a change. */
export type LineItem = { line_id: string; before: Refs; after: Refs };
/** The Change result's keys but the three the head carries (`receipt`, `note`, `recorded`). */
export type ChangeItem = {
  result: "sent" | "sent-diff";
  company: string;
  type: "purchase" | "bill";
  id: string;
  sync_token: string;
  sync_token_after: string;
  lines: readonly LineItem[];
  undo_of: string | null;
  diff: readonly string[] | null;
  writes_off: boolean;
};

const text = (t: string) => ({ type: "text" as const, text: t });

/** A header value: one non-empty line, so nothing can add a header line of its own. */
function oneLine(value: unknown): string {
  if (typeof value !== "string" || value === "" || /[\r\n]/.test(value)) throw new TypeError("results: a header value is one non-empty line");
  return value;
}

/** A value that must be one of `allowed` (undefined when `absent` allows it): anything else is a bug, so it throws, and no wrong header is written. */
function oneOf(value: unknown, allowed: readonly unknown[], what: string): void {
  if (!allowed.includes(value)) throw new TypeError(`results: ${what} isn't one of its values`);
}

/**
 * An error: `reason`, then each write key given, in the grammar's order, then the empty line and the free text. An `intuit_tid` that
 * isn't a string of §5's form is left out, never thrown on (the result after a send must render); a `code` off §14's pattern, or a
 * `note` or `recorded` outside its values, throws.
 */
export function writeError(reason: string, head: Partial<Head>, free: string): CallToolResult {
  const lines = [`reason: ${oneLine(reason)}`];
  if (head.code !== undefined && !(typeof head.code === "string" && CODE.test(head.code))) throw new TypeError("results: code is off its pattern");
  if (head.note !== undefined) oneOf(head.note, NOTES, "note");
  if (head.recorded !== undefined) oneOf(head.recorded, ERROR_RECORDED, "recorded");
  for (const key of HEAD_KEYS) {
    const value: unknown = head[key];
    if (value === undefined || (key === "intuit_tid" && !(typeof value === "string" && TID.test(value)))) continue;
    lines.push(`${key}: ${oneLine(value)}`);
  }
  return { content: [text(`${lines.join("\n")}\n\n${free}`)], isError: true };
}

const refs = ({ account_id, class_id }: Refs): Refs => ({ account_id, class_id });

/**
 * A stored change: the one data item, its keys in the Change result's order; no note is `null`, no recorded is `notion`. Checked as it
 * runs, each a throw: an `undo_of` not a string or null, a `diff` not null or a list of strings, a `writes_off` not a boolean, a `note`
 * or `recorded` outside its values.
 */
export function writeSuccess(change: ChangeItem, head: Partial<Head>): CallToolResult {
  const { undo_of, diff, writes_off } = change as Record<keyof ChangeItem, unknown>;
  if (!(undo_of === null || typeof undo_of === "string")) throw new TypeError("results: undo_of is a string or null");
  if (!(diff === null || (Array.isArray(diff) && diff.every((name) => typeof name === "string")))) throw new TypeError("results: diff is null or names");
  if (typeof writes_off !== "boolean") throw new TypeError("results: writes_off is a boolean");
  if (head.note !== undefined) oneOf(head.note, NOTES, "note");
  if (head.recorded !== undefined) oneOf(head.recorded, SUCCESS_RECORDED, "recorded");
  const item = {
    result: change.result,
    receipt: oneLine(head.receipt),
    company: change.company, // the call's company, as the change flow was given it
    type: change.type,
    id: change.id,
    sync_token: change.sync_token,
    sync_token_after: change.sync_token_after,
    lines: change.lines.map(({ line_id, before, after }) => ({ line_id, before: refs(before), after: refs(after) })),
    undo_of: change.undo_of,
    diff: change.diff,
    note: head.note ?? null,
    writes_off: change.writes_off,
    recorded: head.recorded ?? "notion",
  };
  return { content: [text(JSON.stringify(item))] };
}

/** A table with no prototype, so only its own keys are found. */
const table = <T>(entries: Record<string, T>): Readonly<Record<string, T>> => Object.freeze(Object.assign(Object.create(null) as Record<string, T>, entries));
const one = (sentence: string) => table({ "": sentence });

/** Spec §6, by reason and case (`""` for a reason with one text). */
const TEXTS = table({
  "write:size": one("At most 20 lines can be changed in one call."),
  "write:sweep": one("The job guard hasn't run clean in the last 20 minutes; writes are held."),
  "write:disabled": one("Writes are switched off."),
  "write:not-found": table({ categorize: "QuickBooks has no <T> <id>.", undo: "QuickBooks has no <T> <id> any more." }),
  "write:type": table({
    credit: "The transaction is a credit card credit, which can't be recategorized.",
    entity: "QuickBooks answered with another kind of transaction than a <T>.",
  }),
  "write:stacks-bill": table({
    "doc-number": "Stacks made this bill (DocNumber Stacks_…); Stacks would undo the change.",
    "private-note": "This is an intercompany bill Stacks made.",
  }),
  "write:closed": table({
    "before-send": "The books are closed for this transaction's date.",
    unreadable: "The company's close date can't be read.",
    undo: "The books have since closed for this transaction's date.",
    "after-send": "QuickBooks says the books are closed.",
  }),
  "write:line": table({
    "not-account": "Line <id> isn't an account-based expense line.",
    missing: "Line <id> isn't on this transaction.",
    twice: "Line <id> is named twice.",
    ids: "A line of this transaction has no Id or shares one, so it can't be re-sent safely.",
  }),
  "write:account": table({
    type: "Account <id> is an <AccountType> account; choose an Expense, Other Expense or Cost of Goods Sold account.",
    missing: "Account <id> doesn't exist.",
    inactive: "Account <id> is inactive.",
    undo: "Account <id> no longer exists.",
  }),
  "write:class": table({ inactive: "Class <id> is inactive.", missing: "Class <id> doesn't exist.", undo: "Class <id> no longer exists." }),
  "write:noop": one("No named line would change."),
  "write:diff": one("The built request differs from the transaction outside the named lines; nothing was sent."),
  "write:cap": one("The daily limit of changes for this company is reached."),
  "write:receipt-failed": table({
    intent: "The write receipt couldn't be recorded; nothing was sent.",
    "intent-key": "Notion refused the intent receipt; nothing was sent.",
    lookup: "The write ledger couldn't be read; nothing was sent.",
    settle: "The settled outcome couldn't be recorded; nothing was sent.",
  }),
  "write:stale": one("Someone edited the transaction meanwhile; nothing was overwritten."),
  "write:failed": one("QuickBooks refused the change."),
  "write:unknown": table({
    send: "QuickBooks didn't answer; the change will be settled by a later check.",
    "recorded-none": "No answer, and the outcome wasn't confirmed recorded.",
    "id-mismatch": "QuickBooks answered with another transaction's id; writes are switched off.",
    undo: "That change's result isn't settled yet; try again in a few minutes.",
  }),
  "write:changed-since": one("Someone changed these lines since; nothing was sent."),
  "write:not-sent": one("That change was never sent."),
  "write:undo-of-undo": one("That receipt is itself an undo; categorize again instead."),
  // A refused registration (QA1): 286's text.
  "fork-error": one(REASON_TEXT["fork-error"]),
});

/** §6's text for a reason and case, `<T>`, `<id>` and `<AccountType>` filled from `vars`; a case or var it lacks is a bug: it throws. */
export function freeText(reason: string, kase: string, vars: Record<string, string>): string {
  const form = TEXTS[reason]?.[kase];
  if (form === undefined) throw new TypeError(`results: no free text for ${reason} ${kase}`);
  return form.replace(/<(T|id|AccountType)>/g, (_, name: string) => {
    const value = vars[name];
    if (typeof value !== "string") throw new TypeError(`results: ${reason} ${kase} needs ${name}`);
    return value;
  });
}

/** The 1.0 reasons whose text loses its trailing status (spec §3): every other 1.0 text is 286's, whole. */
const CUT_REASONS = /^(stacks-auth|not-connected|unknown-enterprise|renewal-failed:.*)$/;

/**
 * 286's result for a 1.0 failure. For `stacks-auth`, `not-connected`, `unknown-enterprise` and `renewal-failed:*` only, its free
 * text's trailing ` (<3 digits>)` (before a last full stop, if any) is cut (spec §3).
 */
export function forkReason(f: Failure): CallToolResult {
  const result = errorResult(f, []);
  if (!CUT_REASONS.test(f.reason)) return result;
  const [first] = result.content as Array<{ type: "text"; text: string }>;
  return { content: [text(first.text.replace(/ \([0-9]{3}\)(\.?)$/, "$1"))], isError: true };
}
