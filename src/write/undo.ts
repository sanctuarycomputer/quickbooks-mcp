// Sanctuary Computer (quickbooks-mcp-294): `qbo_undo_change`, contract 1.2 §18 Undo order (docs/contracts/quickbooks.md in Stacksbot),
// spec §5.1 and §7: the sweep; the receipt's company and the `lookup`, read strictly (A2.3); undo-of-undo; a due unknown settled first
// (§17 Settling, through settle.ts), the call prepared just before the settle's refetch; not-sent; the call prepared (if the settle didn't);
// steps 6-12 (293's preSend in `undo` mode, the changed-since check as its `afterLine` hook); then the change flow with `categorize: false`:
// the intent naming `undo_of`, never counted against the cap, `register`, the one send. The switch is never asked (§18: a sent-diff can be
// put back at once). The first step that fails answers and nothing after it runs. The schema and description are 293's (contract §13).
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { runInCall, type Failure } from "../clients/call-context.js";
import type { WriteRuntime, WriteToolDefinition } from "../helpers/register-tool.js";
import { lookupOk, type LineChange, type Lookup, type Side } from "./answers.js";
import { holdsAfter, intentFor, refusalResult, refuse, rereadTxn, runChange, type ChangeTools } from "./change.js";
import { preSend } from "./pre-send.js";
import { runReceipt } from "./receipt-cmd.js";
import { forkReason } from "./results.js";
import { isRecord } from "./rules.js";
import { applySettled, settle } from "./settle.js";
import { readSweep } from "./sweep.js";

export const undoParams = z.strictObject({
  receipt: z
    .string()
    .regex(/^quickbooks-write:(sanctuary-computer|garden3d|index-space|usb-club):(purchase|bill):[0-9]{1,20}:[0-9]{1,20}:[1-9][0-9]{0,5}(:intent)?$/),
});

/** A side as the intent request holds it, its keys in the intent line's order. */
const sideOf = ({ account_id, account_name, class_id, class_name }: Side): Side => ({ account_id, account_name, class_id, class_name });

/** Step 2's not-found: exactly a not-ok answer whose reason is `not-found`. */
const notFound = (answer: unknown): boolean => isRecord(answer) && answer.ok === false && answer.reason === "not-found";

async function undo(tools: ChangeTools, company: string, receipt: string, runtime: WriteRuntime): Promise<CallToolResult> {
  const { cfg } = runtime;
  const { kit, sw } = tools;
  // Step 1: nothing fetched or run.
  if (!(await readSweep(cfg.sweepStamp, kit.wall))) return refuse("write:sweep");
  // Step 2: the key, `:intent` stripped; another company's key names no attempt of this call's, and is never looked up.
  const key = receipt.replace(/:intent$/, "");
  if (key.split(":")[1] !== company) return refuse("write:not-sent");
  const answer = await runReceipt(cfg, { cmd: "lookup", key }, { spawn: kit.spawn });
  const found: Lookup | null = lookupOk(answer, key, company);
  if (found === null) return notFound(answer) ? refuse("write:not-sent") : refuse("write:receipt-failed", { case: "lookup" });
  const { intent } = found;
  // Step 3.
  if (intent.undo_of !== null) return refuse("write:undo-of-undo");
  // The call is prepared once, when it first needs QuickBooks: just before a due settle's refetch, else before step 6.
  let prepared: Promise<Failure | null> | undefined;
  const prepare = (): Promise<Failure | null> => {
    if (prepared === undefined) prepared = runtime.companies.prepareCall(company);
    return prepared;
  };
  // Step 4: an unknown latest outcome, or none, is settled first (§17).
  let latest: string = found.outcome === null ? "unknown" : found.outcome.result;
  if (latest === "unknown") {
    const settled = await settle(found, {
      // change.ts's `rereadTxn`, step 6's own reader: any Fault before the entity (610 is row 5, any other row 6), in any status (TN1).
      reread: async () => ((await prepare()) === null ? rereadTxn(intent.type, intent.id) : { kind: "failed" }),
      wall: kit.wall,
    });
    if (settled === "wait" || settled === "stays") return refuse("write:unknown", { case: "undo" });
    // Acted on first (a sent-diff deletes the switch file), then refused when its outcome wasn't recorded.
    if ((await applySettled(found, settled, { cfg, kit, sw })) === "none") return refuse("write:receipt-failed", { case: "settle" });
    latest = settled.result;
  }
  // Step 5.
  if (latest !== "sent" && latest !== "sent-diff") return refuse("write:not-sent");
  const failure = await prepare();
  if (failure !== null) return forkReason(failure);
  // Steps 6-12: each line's before values put back, once every named line still holds the after values (step 9).
  const after = intent.lines.map((line) => ({ line_id: line.line_id, account_id: line.after.account_id, class_id: line.after.class_id }));
  const changes = intent.lines.map((line) => ({ line_id: line.line_id, account_id: line.before.account_id, class_id: line.before.class_id }));
  const afterLine = (fetched: Record<string, unknown>): string | null => (holdsAfter(fetched, after) ? null : "write:changed-since");
  const pre = await preSend({ company, entity: intent.type, id: intent.id, mode: "undo", lines: changes, afterLine }, { buildBody: kit.buildBody, mono: kit.mono });
  if (!pre.ok) return refusalResult(pre);
  // Step 13: the undo's own lines (before and after swapped, with their names) and the undone intent's reason, naming `undo_of`.
  const lines: LineChange[] = intent.lines.map((line) => ({ line_id: line.line_id, before: sideOf(line.after), after: sideOf(line.before) }));
  return runChange({ runtime, tools, checked: pre.checked, intent: intentFor(pre.checked, lines, intent.reason, key), categorize: false });
}

/** `qbo_undo_change`, on its server's registry, switch and kit. */
export function undoTool(tools: ChangeTools): WriteToolDefinition<typeof undoParams> {
  return {
    name: "qbo_undo_change",
    description: "Put back an earlier change made with a categorize tool, by its receipt key.",
    schema: undoParams,
    // Steps 1-3 need no token: the call is opened at once and prepared when it first needs QuickBooks.
    handler: ({ company, params }, runtime) => runInCall(company, () => undo(tools, company, params.receipt, runtime)),
  };
}
