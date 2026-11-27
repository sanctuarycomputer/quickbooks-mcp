// Sanctuary Computer (quickbooks-mcp-294): the two categorize tools, contract 1.2 §15 Categorize order (docs/contracts/quickbooks.md in
// Stacksbot), spec §5.1 and §7: size, sweep, switch; then the call, opened and prepared (a 1.0 reason); steps 4-12 (293's preSend); the
// names (spec §3 "gap: intent names"); then the change flow: the switch again, the intent, register, the one send. The first step that
// fails answers and nothing after it runs. The schema and descriptions are 293's (contract §13), unchanged.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { currentCall, runInCall, type Failure } from "../clients/call-context.js";
import type { WriteRuntime, WriteToolDefinition } from "../helpers/register-tool.js";
import type { LineChange, Side } from "./answers.js";
import { intentFor, refusalResult, refuse, runChange, type ChangeTools } from "./change.js";
import { fetchById, type UpdateEntity } from "./client.js";
import { resolveChanges } from "./compare.js";
import { preSend, type CheckedRequest } from "./pre-send.js";
import { forkReason } from "./results.js";
import { entityKey, isId, MAX_LINES, prop } from "./rules.js";
import { readSweep } from "./sweep.js";

const id = z.string().regex(/^[0-9]{1,20}$/);

export const categorizeParams = z.strictObject({
  id,
  lines: z.array(z.strictObject({ line_id: id, account_id: id, class_id: id.nullable().optional() })).min(1),
  reason: z
    .string()
    .min(1)
    .max(200)
    // UTF-16 code units, where zod counts characters.
    .refine((text) => text.length <= 200)
    .regex(/\S/)
    .regex(/^[^\p{Cc}\u2028\u2029]*$/u),
});

type Params = z.infer<typeof categorizeParams>;
/** A name lookup that failed: the 1.0 reason it answers. */
class NameFailed extends Error {
  constructor(readonly failure: Failure) {
    super(failure.reason);
  }
}
const FORK_ERROR: Failure = Object.freeze({ reason: "fork-error" });

/** The failure 286's interceptors recorded on the call for a QuickBooks request that failed; fork-error if none was. */
const recorded = (): Failure => ({ reason: "fork-error", ...currentCall()?.failure });

/** One account's or class's `Name`, by one GET: a non-empty string, else fork-error; a Fault 610 is fork-error (a line can't name a
 * deleted ref); any other failure answers the 1.0 reason 286 recorded on the call (fork-error if none). A Fault is read as §17 reads one,
 * before the status and the Name: a `Fault.Error` array whose first item has a string `code`, in any status (task-8-3 TP3); one other
 * than 610 is a failed GET like a status off 2xx, so a 2xx holding one answers fork-error (286 records nothing for a 2xx). */
async function readName(entity: "account" | "class", refId: string): Promise<string> {
  let answer;
  try {
    answer = await fetchById(entity, refId);
  } catch {
    throw new NameFailed(recorded());
  }
  const { status, data } = answer;
  const errors = prop(prop(data, "Fault"), "Error");
  const code = Array.isArray(errors) ? prop(errors[0], "code") : undefined;
  if (typeof code === "string") throw new NameFailed(code === "610" ? FORK_ERROR : recorded());
  if (status < 200 || status > 299) throw new NameFailed(recorded());
  const found = prop(data, entity === "account" ? "Account" : "Class");
  const name = prop(found, "Name");
  if (prop(found, "Id") !== refId || typeof name !== "string" || name === "") throw new NameFailed(FORK_ERROR);
  return name;
}

/**
 * Each named line's before and after refs with their names, in call order. The after account's and a set class's names are the ones
 * steps 9-10 read; each other ref (a before account, a before class, a kept class) is read by one GET per id per call, in line order.
 */
async function namedLines(checked: CheckedRequest): Promise<LineChange[]> {
  const fetchedLines = checked.fetched.Line as unknown[];
  // The refs steps 9-10 fetched: their names are the checked request's, or there is none to give.
  const read = new Set(checked.changes.flatMap((c) => [`account:${c.account_id}`, ...(typeof c.class_id === "string" ? [`class:${c.class_id}`] : [])]));
  const names = new Map<string, string>();
  const nameOf = async (entity: "account" | "class", refId: unknown): Promise<string> => {
    if (!isId(refId)) throw new NameFailed(FORK_ERROR);
    const key = `${entity}:${refId}`;
    if (read.has(key)) {
      const name = checked.names[key];
      if (name === undefined) throw new NameFailed(FORK_ERROR);
      return name;
    }
    if (!names.has(key)) names.set(key, await readName(entity, refId));
    return names.get(key) as string;
  };
  const side = async (account: unknown, klass: unknown): Promise<Side> => ({
    account_id: account as string,
    account_name: await nameOf("account", account),
    class_id: klass as string | null,
    class_name: klass === null ? null : await nameOf("class", klass),
  });
  const out: LineChange[] = [];
  for (const change of resolveChanges(checked.fetched, checked.changes)) {
    const line = fetchedLines.find((one) => prop(one, "Id") === change.line_id);
    const detail = prop(line, "AccountBasedExpenseLineDetail");
    const classRef = prop(detail, "ClassRef");
    const before = await side(prop(prop(detail, "AccountRef"), "value"), classRef === undefined ? null : prop(classRef, "value"));
    const after = await side(change.account_id, change.class_id);
    out.push({ line_id: change.line_id, before, after });
  }
  return out;
}

async function categorize(entity: UpdateEntity, tools: ChangeTools, company: string, params: Params, runtime: WriteRuntime): Promise<CallToolResult> {
  const { cfg } = runtime;
  // Steps 1-3: no call, no token, nothing fetched or run.
  if (params.lines.length > MAX_LINES) return refuse("write:size");
  if (!(await readSweep(cfg.sweepStamp, tools.kit.wall))) return refuse("write:sweep");
  if (!(await tools.sw.isOn(cfg.writeSwitch))) return refuse("write:disabled");
  return runInCall(company, async () => {
    const failure = await runtime.companies.prepareCall(company);
    if (failure !== null) return forkReason(failure);
    // Steps 4-12.
    const pre = await preSend({ company, entity, id: params.id, mode: "categorize", lines: params.lines }, { buildBody: tools.kit.buildBody, mono: tools.kit.mono });
    if (!pre.ok) return refusalResult(pre);
    let lines: LineChange[];
    try {
      lines = await namedLines(pre.checked);
    } catch (e) {
      // namedLines throws nothing else.
      return forkReason((e as NameFailed).failure);
    }
    return runChange({ runtime, tools, checked: pre.checked, intent: intentFor(pre.checked, lines, params.reason, null), categorize: true });
  });
}

/** `qbo_categorize_purchase` or `qbo_categorize_bill`, on its server's registry, switch and kit. */
export function categorizeTool(entity: UpdateEntity, tools: ChangeTools): WriteToolDefinition<typeof categorizeParams> {
  const type = entityKey(entity);
  return {
    name: `qbo_categorize_${entity}`,
    description:
      `Change the expense account (category) and optionally the class of existing expense lines on one QuickBooks ${type}. ` +
      "`reason` is a short plain sentence stored in the team's Audit Log: leave amounts out of it.",
    schema: categorizeParams,
    handler: ({ company, params }, runtime) => categorize(entity, tools, company, params, runtime),
  };
}
