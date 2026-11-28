// Sanctuary Computer (quickbooks-mcp-294): settling an unanswered send, contract 1.2 §17 Settling (docs/contracts/quickbooks.md in
// Stacksbot), exported for undo (§18 step 4) and 298's write check (§19), so the two can't disagree (spec §7). `settle` is pure: rows 1-10
// in order from the lookup and one reread, the first that holds deciding. `applySettled` acts on what it settled: a sent-diff turns the
// switch off, then the outcome is asked of the receipt command (§20), once (plan V6).
import type { WriteConfig } from "../clients/config.js";
import { outcomeRecorded, type Lookup } from "./answers.js";
import { compareDigests, type ResolvedChange, type Transaction } from "./compare.js";
import type { WriteKit } from "./kit.js";
import { runReceipt } from "./receipt-cmd.js";
import { prop } from "./rules.js";
import { isIsoAt } from "./sweep.js";
import type { Switch } from "./switch.js";

/**
 * What the reread of the transaction found, as the caller reads its GET: the transaction out of its envelope (`txn`, rows 7-10); a Fault
 * with its code (`fault`: `610` is row 5, any other row 6); or no reading at all (`failed`, row 6: no answer, a 5xx or any other non-Fault
 * failure, or a 1.0 fork reason such as a failed prepare). A reread that throws is read as `failed`.
 */
export type Reread = { kind: "txn"; txn: Transaction } | { kind: "fault"; code: string } | { kind: "failed" };

/** A settled outcome: the `outcome` request's values (§20), with `error` always null (a settle has no QuickBooks code). */
export type Settled = {
  result: "sent" | "sent-diff" | "failed" | "unsettled";
  sync_token_after: string | null;
  diff: string[] | null;
  note: "edited-since" | "deleted" | null;
};

/** Row 1: an age under this waits. */
const SETTLE_AFTER_MS = 10 * 60_000;
const SYNC_TOKEN = /^[0-9]{1,20}$/;

const outcome = (result: Settled["result"], rest: Partial<Settled> = {}): Settled => ({ result, sync_token_after: null, diff: null, note: null, ...rest });

/** A ref's string value; any other value is none, so it matches no account or class (as compare.ts reads it). */
function refValue(ref: unknown): string | undefined {
  const value = prop(ref, "value");
  return typeof value === "string" ? value : undefined;
}

/** A line's class as the compare reads it: an absent `ClassRef` is null; a present one with no string value is no class. */
function classOf(line: unknown): string | null | undefined {
  const ref = prop(prop(line, "AccountBasedExpenseLineDetail"), "ClassRef");
  return ref === undefined ? null : refValue(ref);
}

/** "Holds the after values": every named line is in the copy, and every copy of it has the after account and class. */
function holds(txn: Transaction, changes: readonly ResolvedChange[]): boolean {
  const lines = Array.isArray(txn.Line) ? txn.Line : [];
  return changes.every((change) => {
    const copies = lines.filter((line) => prop(line, "Id") === change.line_id);
    const account = (line: unknown) => refValue(prop(prop(line, "AccountBasedExpenseLineDetail"), "AccountRef"));
    return copies.length > 0 && copies.every((line) => account(line) === change.account_id && classOf(line) === change.class_id);
  });
}

/** The reread, any throw read as a failure. */
async function reread(read: () => Promise<Reread>): Promise<Reread> {
  try {
    return await read();
  } catch {
    return { kind: "failed" };
  }
}

/**
 * §17 Settling for an attempt whose latest outcome is `unknown` or which has none: `wait` (row 1, no reread), `stays` (row 6, or an age
 * that can't be told: an `at` failing the ledger's test, or a wall clock that isn't a finite number), or the settled outcome. An attempt with any other latest outcome is never settled
 * (`stays`, no reread). `deps` is the reread and the wall clock (epoch ms), and nothing else.
 */
export async function settle(
  attempt: Lookup,
  deps: { reread: () => Promise<Reread>; wall: () => number },
): Promise<"wait" | "stays" | Settled> {
  const { intent, outcome: latest, superseded_ahead } = attempt;
  if (latest !== null && latest.result !== "unknown") return "stays";
  // Row 1: the age from the unknown outcome's at, else the intent's.
  const at = latest === null ? intent.at : latest.at;
  if (!isIsoAt(at)) return "stays";
  const now: unknown = deps.wall();
  if (typeof now !== "number" || !Number.isFinite(now)) return "stays";
  if (now - Date.parse(at) < SETTLE_AFTER_MS) return "wait";
  // Rows 2-4: the receipt command's superseded values.
  if (superseded_ahead === 0) return outcome("failed");
  if (superseded_ahead === 1) return outcome("failed");
  if (superseded_ahead !== null) return outcome("unsettled");
  const got = await reread(deps.reread);
  // Rows 5 and 6.
  if (got.kind === "fault") return got.code === "610" ? outcome("unsettled", { note: "deleted" }) : "stays";
  if (got.kind === "failed") return "stays";
  const token = got.txn.SyncToken;
  // Row 10's non-digit SyncToken: never moved, never equal.
  if (typeof token !== "string" || !SYNC_TOKEN.test(token)) return outcome("unsettled");
  const ahead = BigInt(token) - BigInt(intent.sync_token);
  // Row 7.
  if (ahead === BigInt(0)) return outcome("failed");
  const changes = intent.lines.map((line) => ({ line_id: line.line_id, account_id: line.after.account_id, class_id: line.after.class_id }));
  if (ahead > BigInt(0) && holds(got.txn, changes)) {
    // Row 9: uncompared.
    if (ahead > BigInt(1)) return outcome("sent", { sync_token_after: token, note: "edited-since" });
    // Row 8: the compare through the intent's digests.
    const compared = compareDigests(got.txn, intent.digests, changes);
    return compared.same ? outcome("sent", { sync_token_after: token }) : outcome("sent-diff", { sync_token_after: token, diff: compared.fields });
  }
  // Row 10: moved without the after values, or a lower SyncToken.
  return outcome("unsettled");
}

/**
 * Acts on a settled outcome: a `sent-diff` turns the switch off first (§17: a settled sent-diff deletes the switch file), then the `outcome`
 * request is run through the receipt command with the kit's spawn. Answers what was recorded (`outcomeRecorded`); never throws.
 */
export async function applySettled(
  attempt: Lookup,
  settled: Settled,
  ctx: { cfg: WriteConfig; kit: WriteKit; sw: Switch },
): Promise<"notion" | "ledger" | "none"> {
  if (settled.result === "sent-diff") await ctx.sw.turnOff(ctx.cfg.writeSwitch);
  const request = {
    cmd: "outcome",
    key: attempt.key,
    result: settled.result,
    sync_token_after: settled.sync_token_after,
    diff: settled.diff,
    error: null,
    note: settled.note,
  };
  return outcomeRecorded(await runReceipt(ctx.cfg, request, { spawn: ctx.kit.spawn }));
}
