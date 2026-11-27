// Sanctuary Computer (quickbooks-mcp-294): the receipt command's answers, read strictly (spec §5.1 answers.ts; contract 1.2 §20 Receipt
// commands and the writes.jsonl intent and outcome line tables, docs/contracts/quickbooks.md in Stacksbot). Anything not exactly ok is not
// ok: a command answering fast but wrong never lets a send, an undo or a settle through. A ledger line is valid as the receipt command's own
// check reads it (Stacksbot scripts/quickbooks/write-receipt.mjs lineValid), and a lookup's intent must have at least one line. Pure.
import { isRecord } from "./rules.js";
import { isIsoAt } from "./sweep.js";

/** One side of a line change, as the intent request and line hold it. */
export type Side = { account_id: string; account_name: string; class_id: string | null; class_name: string | null };
export type LineChange = { line_id: string; before: Side; after: Side };
/** §20's writes.jsonl intent line. */
export type IntentLine = {
  v: "1.1";
  kind: "intent";
  key: string;
  n: number;
  at: string;
  company: string;
  type: "purchase" | "bill";
  id: string;
  sync_token: string;
  lines: LineChange[];
  digests: Record<string, string>;
  reason: string;
  undo_of: string | null;
};
export type OutcomeResult = "sent" | "sent-diff" | "stale" | "failed" | "unknown" | "unsettled" | "refused";
/** §20's writes.jsonl outcome line. */
export type OutcomeLine = {
  v: "1.1";
  kind: "outcome";
  key: string;
  m: number;
  at: string;
  result: OutcomeResult;
  sync_token_after: string | null;
  diff: string[] | null;
  error: { code: string; intuit_tid: string | null } | null;
  note: "id-mismatch" | "edited-since" | "deleted" | null;
};
/**
 * A `lookup` answer's entry (or a `pending` one's), checked: `key` the attempt asked for, `intent` its valid intent line, `outcome` its
 * latest valid outcome line or null, and the receipt command's `superseded_by` (an attempt key) and `superseded_ahead` (an integer of at
 * least 0), both null or both set (§20 Receipt command rules, `superseded`).
 */
export type Lookup = {
  key: string;
  intent: IntentLine;
  outcome: OutcomeLine | null;
  superseded_by: string | null;
  superseded_ahead: number | null;
};

/** §20's attempt key (§13's Write params pattern, without `:intent`). */
const ATTEMPT = /^quickbooks-write:(sanctuary-computer|garden3d|index-space|usb-club):(purchase|bill):[0-9]{1,20}:[0-9]{1,20}:[1-9][0-9]{0,5}$/;
const ID = /^[0-9]{1,20}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const FAULT_CODE = /^[A-Za-z0-9_-]{1,64}$/;
const TID = /^[A-Za-z0-9-]{1,64}$/;
const DIFF_NAME = /^[A-Za-z0-9_:.-]{1,64}$/;
const RESULT = /^(sent|sent-diff|stale|failed|unknown|unsettled|refused)$/;
const NOTE = /^(id-mismatch|edited-since|deleted)$/;

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
/** Exactly these own keys, in any order. */
const keysAre = (value: Record<string, unknown>, ...keys: string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => hasOwn(value, key));
const isString = (value: unknown): value is string => typeof value === "string";
const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
const isAttempt = (value: unknown): value is string => isString(value) && ATTEMPT.test(value);
/** Strings in code-unit order (a repeat allowed, as write-receipt.mjs sorts and compares). */
const sorted = (values: string[]): boolean => values.every((value, i) => i === 0 || values[i - 1] <= value);

const sideOk = (side: unknown): boolean =>
  isRecord(side) &&
  keysAre(side, "account_id", "account_name", "class_id", "class_name") &&
  isString(side.account_id) &&
  ID.test(side.account_id) &&
  isString(side.account_name) &&
  (side.class_id === null || (isString(side.class_id) && ID.test(side.class_id))) &&
  isStringOrNull(side.class_name);

const lineChangeOk = (line: unknown): boolean =>
  isRecord(line) && keysAre(line, "line_id", "before", "after") && isString(line.line_id) && ID.test(line.line_id) && sideOk(line.before) && sideOk(line.after);

/** §17 Digests as the intent line holds them: hex SHA-256s, keys in code-unit order, `Line` and each line's `Line:<id>`, none of the left-out
 * fields (write-receipt.mjs digestsValid). */
function digestsOk(digests: unknown, lines: LineChange[]): boolean {
  if (!isRecord(digests)) return false;
  const keys = Object.keys(digests);
  return (
    !keys.some((key) => key === "SyncToken" || key === "MetaData" || key === "sparse" || key === "Line:") &&
    hasOwn(digests, "Line") &&
    lines.every((line) => hasOwn(digests, `Line:${line.line_id}`)) &&
    sorted(keys) &&
    Object.values(digests).every((hash) => isString(hash) && DIGEST.test(hash))
  );
}

/** A valid intent line whose key is `key`. */
function intentLineOk(line: unknown, key: string): line is IntentLine {
  if (!isRecord(line)) return false;
  if (!keysAre(line, "v", "kind", "key", "n", "at", "company", "type", "id", "sync_token", "lines", "digests", "reason", "undo_of")) return false;
  if (line.v !== "1.1" || line.kind !== "intent" || line.key !== key || !isIsoAt(line.at)) return false;
  // The key's parts are the line's company, type, id, SyncToken and n.
  const parts = key.split(":").slice(1);
  if (!Number.isInteger(line.n) || [line.company, line.type, line.id, line.sync_token, String(line.n)].some((part, i) => part !== parts[i])) return false;
  if (!Array.isArray(line.lines) || line.lines.length === 0 || !line.lines.every(lineChangeOk)) return false;
  return digestsOk(line.digests, line.lines) && isString(line.reason) && (line.undo_of === null || isAttempt(line.undo_of));
}

/** An outcome line's `error`: null, or on a `failed` exactly `{ code, intuit_tid }` in their patterns. */
const errorOk = (error: unknown, result: unknown): boolean =>
  error === null ||
  (result === "failed" &&
    isRecord(error) &&
    keysAre(error, "code", "intuit_tid") &&
    isString(error.code) &&
    FAULT_CODE.test(error.code) &&
    (error.intuit_tid === null || (isString(error.intuit_tid) && TID.test(error.intuit_tid))));

/** A `diff`: a non-empty, sorted list of names on a `sent-diff`, else null. */
const diffOk = (diff: unknown, result: unknown): boolean =>
  result === "sent-diff"
    ? Array.isArray(diff) && diff.length > 0 && diff.every((name) => isString(name) && DIFF_NAME.test(name)) && sorted(diff)
    : diff === null;

/** A valid outcome line whose key is `key`. */
function outcomeLineOk(line: unknown, key: string): line is OutcomeLine {
  if (!isRecord(line)) return false;
  if (!keysAre(line, "v", "kind", "key", "m", "at", "result", "sync_token_after", "diff", "error", "note")) return false;
  if (line.v !== "1.1" || line.kind !== "outcome" || line.key !== key || !isIsoAt(line.at)) return false;
  if (!Number.isInteger(line.m) || (line.m as number) < 1 || !isString(line.result) || !RESULT.test(line.result)) return false;
  if (!(line.sync_token_after === null || (isString(line.sync_token_after) && ID.test(line.sync_token_after)))) return false;
  if (!diffOk(line.diff, line.result) || !errorOk(line.error, line.result)) return false;
  if (!(line.note === null || (isString(line.note) && NOTE.test(line.note)))) return false;
  return line.note !== "id-mismatch" || line.m === 1;
}

/** This attempt's key with `n`. */
const attemptKey = (attempt: { company: string; type: string; id: string; syncToken: string }, n: unknown): string =>
  `quickbooks-write:${attempt.company}:${attempt.type}:${attempt.id}:${attempt.syncToken}:${String(n)}`;

/** A key on a not-ok answer, kept only when it is this attempt's (some `n`). */
function ownKey(key: unknown, attempt: { company: string; type: string; id: string; syncToken: string }): { key?: string } {
  if (!isAttempt(key)) return {};
  return key === attemptKey(attempt, key.slice(key.lastIndexOf(":") + 1)) ? { key } : {};
}

/**
 * The intent's answer (A1.4): ok only for exactly `{ ok: true, key, n }` whose `key` is this attempt's with that integer `n`. Not ok
 * otherwise, with `cap` on `{ ok: false, reason: "write:cap" }` and `key` only when a not-ok answer's key is this attempt's (spec §3 T7).
 */
export function intentOk(
  answer: unknown,
  attempt: { company: string; type: string; id: string; syncToken: string },
): { ok: true; key: string; n: number } | { ok: false; key?: string; cap?: true } {
  if (!isRecord(answer)) return { ok: false };
  if (answer.ok === true) {
    const { key, n } = answer;
    const ok = keysAre(answer, "ok", "key", "n") && Number.isInteger(n) && isAttempt(key) && key === attemptKey(attempt, n);
    return ok ? { ok: true, key: key as string, n: n as number } : { ok: false };
  }
  if (answer.ok !== false) return { ok: false };
  return { ok: false, ...ownKey(answer.key, attempt), ...(answer.reason === "write:cap" ? { cap: true as const } : {}) };
}

/**
 * The lookup's answer (A2.3), for `key` asked in `company`'s call: exactly `{ ok: true, intent, outcome, superseded_by, superseded_ahead }`,
 * the intent a valid intent line of `key`, the outcome null or a valid outcome line of `key`, the two superseded values both null or both
 * set; else null.
 */
export function lookupOk(answer: unknown, key: string, company: string): Lookup | null {
  if (!isAttempt(key) || key.split(":")[1] !== company) return null;
  if (!isRecord(answer) || !keysAre(answer, "ok", "intent", "outcome", "superseded_by", "superseded_ahead") || answer.ok !== true) return null;
  const { intent, outcome, superseded_by, superseded_ahead } = answer;
  if (!intentLineOk(intent, key) || !(outcome === null || outcomeLineOk(outcome, key))) return null;
  const by = superseded_by === null || isAttempt(superseded_by);
  const ahead = superseded_ahead === null || (Number.isInteger(superseded_ahead) && (superseded_ahead as number) >= 0);
  if (!by || !ahead || (superseded_by === null) !== (superseded_ahead === null)) return null;
  return { key, intent, outcome, superseded_by: superseded_by as string | null, superseded_ahead: superseded_ahead as number | null };
}

/** The outcome's answer (A1.10): `notion` for exactly `{ ok: true, notion: true }`, `ledger` for `{ ok: true, notion: false }`, else `none`. */
export function outcomeRecorded(answer: unknown): "notion" | "ledger" | "none" {
  if (!isRecord(answer) || !keysAre(answer, "ok", "notion") || answer.ok !== true) return "none";
  return answer.notion === true ? "notion" : answer.notion === false ? "ledger" : "none";
}

/** §17's "moved": both SyncTokens are 1 to 20 digits and `got` is greater as an integer. */
export function isMoved(sent: string, got: unknown): boolean {
  return ID.test(sent) && isString(got) && ID.test(got) && BigInt(got) > BigInt(sent);
}
