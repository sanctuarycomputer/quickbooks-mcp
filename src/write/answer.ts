// Sanctuary Computer (quickbooks-mcp-294): the update answer's reader, contract 1.2 §17 Send answers (docs/contracts/quickbooks.md in
// Stacksbot). Steps 1-6 in order, the first that holds deciding; with 1.2's two readings: a Fault whose first code is off its pattern is no
// answer, and so is an entity with the sent Id whose SyncToken isn't digits. Pure: what to do with the reading (the refetch, the switch,
// the outcome) is the change flow's.
import type { UpdateAnswer, UpdateEntity } from "./client.js";
import type { Transaction } from "./compare.js";
import { entityKey, isRecord, prop } from "./rules.js";

/** What the answer says: a Fault's reading with its code, the stored entity, another Id, or no answer (step 6: refetch). `tid` is the
 * answer's `intuit_tid`, kept only when it matches §5's pattern. */
export type Read =
  | { kind: "stale" | "closed" | "failed"; code: string; tid?: string }
  | { kind: "stored"; txn: Transaction; tid?: string }
  | { kind: "id-mismatch" | "none"; tid?: string };

/** §17's Fault code pattern (1.2: a first code off it is no Fault, and no answer). */
const FAULT_CODE = /^[A-Za-z0-9_-]{1,64}$/;
/** §5's intuit_tid pattern, which §14 names for a write result and the receipt command checks on an outcome's error. */
const TID = /^[A-Za-z0-9-]{1,64}$/;
/** An entity's SyncToken as 1.2 step 4 reads it. */
const SYNC_TOKEN = /^[0-9]{1,20}$/;

/** The first Error item's code when the body is a Fault (§17: a JSON object whose `Fault.Error` is a non-empty array whose first item has
 * a string `code`), else undefined. */
function faultCode(data: unknown): string | undefined {
  const errors = prop(prop(data, "Fault"), "Error");
  // An empty Error array has no first item, so no code.
  const code = Array.isArray(errors) ? prop(errors[0], "code") : undefined;
  return typeof code === "string" ? code : undefined;
}

/** Reads the update's answer, or the error that came instead of one, against what was sent. */
export function readAnswer(
  got: { answer: UpdateAnswer } | { error: unknown },
  sent: { entity: UpdateEntity; id: string; syncToken: string },
): Read {
  // No answer at all: a timeout, a reset, a refusal before it left.
  if (!("answer" in got)) return { kind: "none" };
  const { status, data, intuit_tid } = got.answer;
  const tid = typeof intuit_tid === "string" && TID.test(intuit_tid) ? { tid: intuit_tid } : {};
  const code = faultCode(data);
  if (code !== undefined) {
    if (!FAULT_CODE.test(code)) return { kind: "none", ...tid };
    if (code === "5010") return { kind: "stale", code, ...tid };
    if (code === "6200" || code === "6210") return { kind: "closed", code, ...tid };
    return { kind: "failed", code, ...tid };
  }
  const entity = prop(data, entityKey(sent.entity));
  if (status >= 200 && status <= 299 && isRecord(entity) && typeof entity.Id === "string") {
    if (entity.Id !== sent.id) return { kind: "id-mismatch", ...tid };
    if (typeof entity.SyncToken === "string" && SYNC_TOKEN.test(entity.SyncToken)) return { kind: "stored", txn: entity, ...tid };
  }
  return { kind: "none", ...tid };
}
