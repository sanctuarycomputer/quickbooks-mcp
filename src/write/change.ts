// Sanctuary Computer (quickbooks-mcp-294): the change flow categorize and undo share, contract 1.2 §15 steps 13-14 and §17 Send answers
// (docs/contracts/quickbooks.md in Stacksbot), spec §5.1 `change.ts` and §5.2. For categorize only, the switch is asked again (spec §3
// S16); then the intent (its digests sorted), which must answer exactly ok (A1.4); `register` once (QA1); the mark; the one send. From the
// send on, everything runs inside one `try`: the answer read, a 401's forced token (QA4), the refetch when there is no answer, the compare,
// the switch turned off on a `sent-diff` or an `id-mismatch`, the one outcome, and the result. Any throw there answers `write:unknown`
// with the receipt, asking the outcome only when it wasn't asked yet (A1.16): the update is never sent again.
// Changed in T8 (undo): a `write:cap` answer refuses categorize only; undo is never counted against the cap (§18 step 13), so for undo it is
// a not-ok intent like any other (receipt-failed). The last answer for an undecided outcome keeps `note: id-mismatch` and states `recorded`
// from the outcome's answer (task-7-2 TL2). `holdsAfter` is exported for undo's changed-since check (§18 step 9). `rereadTxn` reads a
// refetched body as §17 does, any Fault before the entity, for step 6 here and undo's settle alike (task-8-2 TN1).
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { currentCall, setCallToken, type Failure } from "../clients/call-context.js";
import type { WriteRuntime } from "../helpers/register-tool.js";
import { readAnswer } from "./answer.js";
import { intentOk, isMoved, outcomeRecorded, type LineChange } from "./answers.js";
import type { Registry } from "./capability.js";
import { fetchById, sendUpdate, type UpdateAnswer, type UpdateEntity } from "./client.js";
import { compare, digests, resolveChanges, type ResolvedChange, type Transaction } from "./compare.js";
import type { WriteKit } from "./kit.js";
import type { CheckedRequest } from "./pre-send.js";
import { runReceipt } from "./receipt-cmd.js";
import { forkReason, freeText, writeError, writeSuccess } from "./results.js";
import { entityKey, isRecord, prop } from "./rules.js";
import type { Reread } from "./settle.js";
import type { Switch } from "./switch.js";

/** §20's intent request, its keys in the vectors' order. */
export type IntentRequest = {
  cmd: "intent";
  company: string;
  type: UpdateEntity;
  id: string;
  sync_token: string;
  lines: LineChange[];
  digests: Record<string, string>;
  reason: string;
  undo_of: string | null;
};
/** What a write tool holds of its server's write mode: one registry, one switch, one kit. */
export type ChangeTools = { readonly registry: Registry; readonly sw: Switch; readonly kit: WriteKit };
export type ChangeContext = { runtime: WriteRuntime; tools: ChangeTools; checked: CheckedRequest; intent: IntentRequest; categorize: boolean };

/** §20's outcome request's values. */
type Outcome = {
  result: "sent" | "sent-diff" | "stale" | "failed" | "unknown";
  sync_token_after: string | null;
  diff: string[] | null;
  error: { code: string; intuit_tid: string | null } | null;
  note: "id-mismatch" | null;
};
type Recorded = "notion" | "ledger" | "none";

const outcome = (result: Outcome["result"], rest: Partial<Outcome> = {}): Outcome => ({ result, sync_token_after: null, diff: null, error: null, note: null, ...rest });

/**
 * A refusal before the send: §6's text for the reason and its case (`detail.case`, the ids it names). A reason and case with no text
 * (`write:line`'s `none` or `subject`, which no categorize call can reach) answers `fork-error`: nothing was sent, and no text is made up.
 */
export function refuse(reason: string, detail: Readonly<Record<string, string>> = {}): CallToolResult {
  try {
    return writeError(reason, {}, freeText(reason, detail.case ?? "", detail));
  } catch {
    return forkReason({ reason: "fork-error" });
  }
}

/** A pre-send failure: a `write:` reason with its detail, or a 1.0 reason as 286's result less its trailing status. */
export function refusalResult(refusal: Failure & { ok?: false; detail?: Record<string, string> }): CallToolResult {
  const { ok: _ok, detail, ...failure } = refusal;
  return failure.reason.startsWith("write:") ? refuse(failure.reason, detail) : forkReason(failure);
}

/** The intent for a checked request: its fetched copy's company, type, id and SyncToken, the lines with their names, and its digests
 * with the keys sorted by code unit (contract 1.2 §20). */
export function intentFor(checked: CheckedRequest, lines: LineChange[], reason: string, undoOf: string | null): IntentRequest {
  const all = digests(checked.fetched, lines.map((line) => line.line_id));
  const sorted = Object.fromEntries(Object.keys(all).sort().map((key) => [key, all[key]]));
  return {
    cmd: "intent",
    company: checked.company,
    type: checked.entity,
    id: checked.fetched.Id as string,
    sync_token: checked.fetched.SyncToken as string,
    lines,
    digests: sorted,
    reason,
    undo_of: undoOf,
  };
}

/** A ref's string value, else undefined. */
const valueOf = (ref: unknown): unknown => prop(ref, "value");
/** A line's class: an absent `ClassRef` is null; one with no string value is no class. */
function classOf(line: unknown): string | null | undefined {
  const ref = prop(prop(line, "AccountBasedExpenseLineDetail"), "ClassRef");
  if (ref === undefined) return null;
  const value = valueOf(ref);
  return typeof value === "string" ? value : undefined;
}

/** §17 "holds the after values": every named line is in the copy, and each copy of it has the after account and class. */
export function holdsAfter(txn: Transaction, changes: readonly ResolvedChange[]): boolean {
  const lines = Array.isArray(txn.Line) ? txn.Line : [];
  return changes.every((change) => {
    const copies = lines.filter((line) => prop(line, "Id") === change.line_id);
    return copies.length > 0 && copies.every((line) => valueOf(prop(prop(line, "AccountBasedExpenseLineDetail"), "AccountRef")) === change.account_id && classOf(line) === change.class_id);
  });
}

/**
 * A refetch of the sent transaction, read as §17 reads a body (task-8-2 TN1), shared by step 6 here and undo's settle: a Fault first, in any
 * HTTP status and whatever else the body holds (a `Fault.Error` array whose first item has a string `code`), with its code. Only with no
 * Fault, the transaction under the key of the entity sent with the asked `Id`, in a 2xx; anything else `failed`. A first code off §17's
 * pattern needs no test of its own: 1.2 reads it as no answer, which on a refetch is Settling row 6 and step 6's `unknown`, exactly as
 * "another Fault" is, and `610` is on the pattern. A throw is the caller's to read.
 */
export async function rereadTxn(entity: UpdateEntity, id: string): Promise<Reread> {
  const { status, data } = await fetchById(entity, id);
  const errors = prop(prop(data, "Fault"), "Error");
  const code = Array.isArray(errors) ? prop(errors[0], "code") : undefined;
  if (typeof code === "string") return { kind: "fault", code };
  const txn = prop(data, entityKey(entity));
  return status >= 200 && status <= 299 && isRecord(txn) && txn.Id === id ? { kind: "txn", txn } : { kind: "failed" };
}

/** Step 6's refetch, once: the transaction as QuickBooks holds it now, or undefined for any failure (a Fault, 610 included; no answer;
 * a status off 2xx; another entity or `Id`). */
async function reread(entity: UpdateEntity, id: string): Promise<Transaction | undefined> {
  try {
    const got = await rereadTxn(entity, id);
    return got.kind === "txn" ? got.txn : undefined;
  } catch {
    return undefined;
  }
}

/** QA4: after an update answered 401, a forced token for the call's company; set on the call only when it is for the call's realm. True
 * when the call now holds it, so the refetch may go. */
async function forceToken(runtime: WriteRuntime, company: string, sentAt: number): Promise<boolean> {
  const realm = currentCall()?.realm;
  const got = await runtime.stacks.get(company, { force: true, sentAt });
  // The prepared call always holds a realm, so an undefined one is never equal.
  if (!got.ok || got.token.realm_id !== realm) return false;
  setCallToken(got.token.access_token, got.token.realm_id);
  return true;
}

/** What the post-send flow knows when it answers write:unknown: the outcome asked (if any), what it answered, the note, the tid, the switch. */
type AfterState = { result?: Outcome["result"]; recorded: Recorded; note: "id-mismatch" | null; tid?: string; writesOff: boolean };

/** What QuickBooks did, for an outcome already asked other than unknown (TK7): never a later settle, which no check will make. */
type Decided = Exclude<Outcome["result"], "unknown">;
const DECIDED: Readonly<Record<Decided, string>> = Object.freeze({
  sent: "QuickBooks stored the change.",
  "sent-diff": "QuickBooks stored the change, with differences from what was asked.",
  stale: "QuickBooks refused the change: the transaction had changed since it was read.",
  failed: "QuickBooks refused the change.",
});

/** The sentence for a throw after an outcome other than unknown was asked: what QuickBooks did, the outcome and whether it was recorded,
 * and that the switch is off when this attempt turned it off. */
function decidedText(result: Decided, s: AfterState): string {
  const recorded = s.recorded === "none" ? "wasn't confirmed recorded" : "was recorded";
  return `${DECIDED[result]} Its outcome, ${result}, ${recorded}; this result couldn't be written.${s.writesOff ? " Writes are switched off." : ""}`;
}

/**
 * The write:unknown answered after the send (§6: id-mismatch's sentence first, then the recorded-none one, else the send one), with the
 * receipt; after a throw that came once an outcome other than unknown was asked, what was decided instead (TK7). Never throws.
 */
function unknownResult(key: string, s: AfterState): CallToolResult {
  const decided = s.result !== undefined && s.result !== "unknown" ? s.result : undefined;
  const kase = s.note === "id-mismatch" ? "id-mismatch" : s.recorded === "none" ? "recorded-none" : "send";
  try {
    const head = { receipt: key, intuit_tid: s.tid, note: s.note ?? undefined, recorded: s.recorded === "notion" ? undefined : s.recorded };
    return writeError("write:unknown", head, decided !== undefined ? decidedText(decided, s) : freeText("write:unknown", kase, {}));
  } catch {
    // The last answer, built from fixed strings: the receipt, the note and what the outcome's answer recorded (`none` unless the command
    // confirmed it), and nothing claimed that wasn't decided.
    const note = s.note === null ? "" : `\nnote: ${s.note}`;
    const recorded = s.recorded === "notion" ? "" : `\nrecorded: ${s.recorded}`;
    return lastAnswer(`reason: write:unknown\nreceipt: ${key}${note}${recorded}\n\n${decided !== undefined ? decidedText(decided, s) : LAST_UNKNOWN[kase]}`);
  }
}
const lastAnswer = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });
/** §6's three post-send unknown sentences, as fixed strings for the last answer. */
const LAST_UNKNOWN: Readonly<Record<"send" | "recorded-none" | "id-mismatch", string>> = Object.freeze({
  send: "QuickBooks didn't answer; the change will be settled by a later check.",
  "recorded-none": "No answer, and the outcome wasn't confirmed recorded.",
  "id-mismatch": "QuickBooks answered with another transaction's id; writes are switched off.",
});

/** Runs the change from the switch's re-check to its result, inside the call `preSend` checked it in, the call prepared. */
export async function runChange(ctx: ChangeContext): Promise<CallToolResult> {
  const { runtime, checked, intent } = ctx;
  const { registry, sw, kit } = ctx.tools;
  const { cfg } = runtime;
  // Step 3 again (spec §3 S16): categorize only; undo never asks the switch.
  if (ctx.categorize && !(await sw.isOn(cfg.writeSwitch))) return refuse("write:disabled");
  // Step 13: exactly ok, for this attempt, or nothing is registered or sent.
  const attempt = { company: intent.company, type: intent.type, id: intent.id, syncToken: intent.sync_token };
  const asked = intentOk(await runReceipt(cfg, intent, { spawn: kit.spawn }), attempt);
  if (!asked.ok) {
    // The cap is categorize's alone (§14, §18 step 13).
    if (asked.cap === true && ctx.categorize) return refuse("write:cap");
    if (asked.key === undefined) return refuse("write:receipt-failed", { case: "intent" });
    return writeError("write:receipt-failed", { receipt: asked.key }, freeText("write:receipt-failed", "intent-key", {}));
  }
  // Step 14: one registration, then the one send (QA1). A refused registration sends nothing; the intent settles failed (unmoved).
  try {
    registry.register(checked);
  } catch {
    return forkReason({ reason: "fork-error" });
  }
  const sentAt = runtime.stacks.mark();
  let got: { answer: UpdateAnswer } | { error: unknown };
  try {
    got = { answer: await sendUpdate(checked) };
  } catch (error) {
    got = { error };
  }
  return afterSend(ctx, asked.key, got, sentAt);
}

/** Everything after the send: never a second send, always a result with the receipt. */
async function afterSend(ctx: ChangeContext, key: string, got: { answer: UpdateAnswer } | { error: unknown }, sentAt: number): Promise<CallToolResult> {
  const { runtime, checked, intent } = ctx;
  const { sw, kit } = ctx.tools;
  const { cfg } = runtime;
  const s: AfterState & { asked: boolean } = { asked: false, recorded: "none", note: null, writesOff: false };
  /** The attempt's one outcome request; what it answered, any failure read as `none`. */
  const record = async (o: Outcome): Promise<void> => {
    s.asked = true;
    s.result = o.result;
    try {
      s.recorded = outcomeRecorded(await runReceipt(cfg, { cmd: "outcome", key, ...o }, { spawn: kit.spawn }));
    } catch {
      s.recorded = "none";
    }
  };
  const headRecorded = (): { recorded?: "ledger" | "none" } => (s.recorded === "notion" ? {} : { recorded: s.recorded });
  try {
    const read = readAnswer(got, { entity: checked.entity, id: intent.id, syncToken: intent.sync_token });
    s.tid = read.tid;
    // QA4: before any later request, so the refetch carries the new token.
    const fresh = "answer" in got && got.answer.status === 401 ? await forceToken(runtime, intent.company, sentAt) : true;
    /** A stored copy: the compare against the fetched one gives sent or sent-diff; a sent-diff turns the switch off. */
    const stored = async (txn: Transaction): Promise<CallToolResult> => {
      const compared = compare(txn, checked.fetched, checked.changes);
      const diff = compared.same ? null : compared.fields;
      // An id-mismatch has turned it off already.
      if (diff !== null && s.note === null) s.writesOff = await sw.turnOff(cfg.writeSwitch);
      const after = txn.SyncToken as string;
      await record(outcome(diff === null ? "sent" : "sent-diff", { sync_token_after: after, diff, note: s.note }));
      const change = { result: diff === null ? ("sent" as const) : ("sent-diff" as const), company: intent.company, type: intent.type, id: intent.id, sync_token: intent.sync_token, sync_token_after: after, lines: intent.lines, undo_of: intent.undo_of, diff, writes_off: s.writesOff };
      return writeSuccess(change, { receipt: key, note: s.note ?? undefined, recorded: s.recorded });
    };
    if (read.kind === "stale") {
      await record(outcome("stale"));
      return writeError("write:stale", { receipt: key, intuit_tid: read.tid, ...headRecorded() }, freeText("write:stale", "", {}));
    }
    if (read.kind === "closed" || read.kind === "failed") {
      await record(outcome("failed", { error: { code: read.code, intuit_tid: read.tid ?? null } }));
      const reason = read.kind === "closed" ? "write:closed" : "write:failed";
      return writeError(reason, { receipt: key, code: read.code, intuit_tid: read.tid, ...headRecorded() }, freeText(reason, read.kind === "closed" ? "after-send" : "", {}));
    }
    if (read.kind === "stored") return await stored(read.txn);
    if (read.kind === "id-mismatch") {
      s.note = "id-mismatch";
      s.writesOff = await sw.turnOff(cfg.writeSwitch);
    }
    // Step 6: no answer. The refetch, once, at once; moved with the after values is stored.
    const txn = fresh ? await reread(checked.entity, intent.id) : undefined;
    if (txn !== undefined && isMoved(intent.sync_token, txn.SyncToken) && holdsAfter(txn, resolveChanges(checked.fetched, checked.changes))) return await stored(txn);
    await record(outcome("unknown", { note: s.note }));
    return unknownResult(key, s);
  } catch {
    if (!s.asked) await record(outcome("unknown", { note: s.note }));
    return unknownResult(key, s);
  }
}
