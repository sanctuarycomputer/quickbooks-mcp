// Sanctuary Computer (quickbooks-mcp-294): a fake QBO_WRITE_RECEIPT_CMD for the write tools' tests (spec §4, "The fake receipt command").
// Run as `node receipt-cmd.mjs <script.json>`. It reads one JSON object on stdin, appends `{ request, env }` (its whole environment) as one
// line to the script's `log`, answers `bad-request` to any request the real command's shape check refuses, and otherwise answers the
// script's next answer for that `cmd`: a receipt-cmd/ vector's `answer` by file name, `{ "answer": … }`, or `{ "misbehave": … }`.
// Touches nothing but the log; no network.
import { appendFileSync, readFileSync } from "node:fs";

const script = JSON.parse(readFileSync(process.argv[2], "utf8"));
const VECTORS = new URL("./receipt-cmd/", import.meta.url);

// ---- The real command's shape check, ported line for line from Stacksbot's scripts/quickbooks/write-receipt.mjs at 72d97af8
// (ATTEMPT…NOTES :32-36, LINE_KEYS :50-79, isIsoAt :80-81, SIDE_KEYS…digestsValid :82-118, lineValid :120-158, keyOf…outcomeLine
// :160-187, REQUEST_FIELDS…requestShapeOk :193-210). Left out: the `notion` line kind (LINE_KEYS.notion and lineValid's notion branch),
// which no request builds. Like the real one, a request may carry keys beyond its fields. A4.4 replays every logged request through the
// real check to keep the two equal.
const ATTEMPT =
  /^quickbooks-write:(sanctuary-computer|garden3d|index-space|usb-club):(purchase|bill):[0-9]{1,20}:[0-9]{1,20}:[1-9][0-9]{0,5}$/;
const DIGEST_HEX = /^[0-9a-f]{64}$/;
const RESULTS = ["sent", "sent-diff", "stale", "failed", "unknown", "unsettled", "refused"];
const NOTES = ["id-mismatch", "edited-since", "deleted"];
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const TYPES = { string: (x) => typeof x === "string", integer: Number.isInteger, array: Array.isArray, object: isObj };
const typeHolds = (type, x) => type.split(" or ").some((t) => (t === "null" ? x === null : TYPES[t](x)));
const LINE_KEYS = {
  intent: {
    v: "string",
    kind: "string",
    key: "string",
    n: "integer",
    at: "string",
    company: "string",
    type: "string",
    id: "string",
    sync_token: "string",
    lines: "array",
    digests: "object",
    reason: "string",
    undo_of: "string or null",
  },
  outcome: {
    v: "string",
    kind: "string",
    key: "string",
    m: "integer",
    at: "string",
    result: "string",
    sync_token_after: "string or null",
    diff: "array or null",
    error: "object or null",
    note: "string or null",
  },
};
const isIsoAt = (at) => typeof at === "string" && !Number.isNaN(Date.parse(at)) && new Date(Date.parse(at)).toISOString() === at;
const SIDE_KEYS = [
  ["account_id", "string"],
  ["account_name", "string"],
  ["class_id", "string or null"],
  ["class_name", "string or null"],
];
const ID = /^[0-9]{1,20}$/;
const FAULT_CODE = /^[A-Za-z0-9_-]{1,64}$/;
const INTUIT_TID = /^[A-Za-z0-9-]{1,64}$/;
const DIFF_NAME = /^[A-Za-z0-9_:.-]{1,64}$/;
const sideValid = (x) =>
  isObj(x) &&
  Object.keys(x).length === SIDE_KEYS.length &&
  SIDE_KEYS.every(([k, t]) => typeHolds(t, x[k])) &&
  ID.test(x.account_id) &&
  (x.class_id === null || ID.test(x.class_id));
const lineChangeValid = (x) =>
  isObj(x) && Object.keys(x).length === 3 && typeof x.line_id === "string" && ID.test(x.line_id) && sideValid(x.before) && sideValid(x.after);
const digestsValid = (d, lines) => {
  const keys = Object.keys(d);
  return (
    !keys.some((k) => ["SyncToken", "MetaData", "sparse", "Line:"].includes(k)) &&
    Object.hasOwn(d, "Line") &&
    lines.every((x) => Object.hasOwn(d, `Line:${x.line_id}`)) &&
    keys.join("\n") === [...keys].sort().join("\n") &&
    Object.values(d).every((h) => typeof h === "string" && DIGEST_HEX.test(h))
  );
};
function lineValid(l) {
  if (!isObj(l) || !Object.hasOwn(LINE_KEYS, l.kind)) return false;
  const keys = LINE_KEYS[l.kind];
  if (Object.keys(l).length !== Object.keys(keys).length) return false;
  if (!Object.entries(keys).every(([k, t]) => Object.hasOwn(l, k) && typeHolds(t, l[k]))) return false;
  if (l.v !== "1.1" || !ATTEMPT.test(l.key) || !isIsoAt(l.at)) return false;
  if (l.kind === "intent") {
    const parts = l.key.split(":");
    if ([l.company, l.type, l.id, l.sync_token, String(l.n)].some((v, i) => v !== parts[i + 1])) return false;
    if (!l.lines.every(lineChangeValid) || !digestsValid(l.digests, l.lines)) return false;
    return l.undo_of === null || ATTEMPT.test(l.undo_of);
  }
  if (l.m < 1 || !RESULTS.includes(l.result)) return false;
  if (l.sync_token_after !== null && !ID.test(l.sync_token_after)) return false;
  if (l.result === "sent-diff") {
    if (l.diff === null || l.diff.length === 0) return false;
  } else if (l.diff !== null) return false;
  if (l.diff !== null && (l.diff.some((x) => typeof x !== "string" || !DIFF_NAME.test(x)) || l.diff.join("\n") !== [...l.diff].sort().join("\n")))
    return false;
  if (l.error !== null) {
    if (l.result !== "failed") return false;
    const ek = Object.keys(l.error).sort().join();
    if (
      ek !== "code,intuit_tid" ||
      typeof l.error.code !== "string" ||
      !FAULT_CODE.test(l.error.code) ||
      (typeof l.error.intuit_tid === "string" && !INTUIT_TID.test(l.error.intuit_tid)) ||
      !typeHolds("string or null", l.error.intuit_tid)
    )
      return false;
  }
  if (l.note !== null && !NOTES.includes(l.note)) return false;
  return l.note !== "id-mismatch" || l.m === 1;
}
const keyOf = (r, n) => `quickbooks-write:${r.company}:${r.type}:${r.id}:${r.sync_token}:${n}`;
const intentLine = (r, n, at) => ({
  v: "1.1",
  kind: "intent",
  key: keyOf(r, n),
  n,
  at,
  company: r.company,
  type: r.type,
  id: r.id,
  sync_token: r.sync_token,
  lines: r.lines,
  digests: r.digests,
  reason: r.reason,
  undo_of: r.undo_of,
});
const outcomeLine = (r, m, at) => ({
  v: "1.1",
  kind: "outcome",
  key: r.key,
  m,
  at,
  result: r.result,
  sync_token_after: r.sync_token_after,
  diff: r.diff,
  error: r.error,
  note: r.note,
});
const REQUEST_FIELDS = {
  intent: ["company", "type", "id", "sync_token", "lines", "digests", "reason", "undo_of"],
  outcome: ["key", "result", "sync_token_after", "diff", "error", "note"],
  lookup: ["key"],
  pending: ["company"],
  ping: [],
};
const SHAPE_PROBE_AT = "2026-01-01T00:00:00.000Z";
function requestShapeOk(req) {
  if (!isObj(req) || typeof req.cmd !== "string" || !Object.hasOwn(REQUEST_FIELDS, req.cmd)) return false;
  const table = req.cmd === "outcome" ? LINE_KEYS.outcome : LINE_KEYS.intent;
  if (!REQUEST_FIELDS[req.cmd].every((k) => Object.hasOwn(req, k) && typeHolds(table[k], req[k]))) return false;
  if (req.cmd === "intent") return lineValid(intentLine(req, 1, SHAPE_PROBE_AT));
  if (req.cmd === "outcome") return lineValid(outcomeLine(req, 1, SHAPE_PROBE_AT));
  return true;
}
// ---- End of the port.

const log = (request) => appendFileSync(script.log, JSON.stringify({ request, env: { ...process.env } }) + "\n");
const answer = (value) => process.stdout.write(JSON.stringify(value) + "\n");

/** This run's answer for `cmd`: the next of the script's list, counted by the earlier runs the log holds. */
function next(cmd) {
  let seen = 0;
  try {
    for (const line of readFileSync(script.log, "utf8").split("\n")) if (line !== "" && JSON.parse(line).request?.cmd === cmd) seen++;
  } catch {
    // No log yet: this is the first run.
  }
  // This run's own line is already in the log, so it is the `seen`th.
  return (script.answers?.[cmd] ?? [])[seen - 1];
}

async function main() {
  const first = (script.answers?.["*"] ?? [])[0];
  if (first?.misbehave === "close-stdin") {
    log(null);
    process.exit(0);
  }
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    request = undefined;
  }
  log(request ?? null);
  if (!requestShapeOk(request)) return answer({ ok: false, reason: "bad-request", cause: "bad-request" });
  const step = next(request.cmd);
  if (step === undefined) return answer({ ok: false, reason: "failed", cause: "script-exhausted" });
  if (typeof step === "string") return answer(JSON.parse(readFileSync(new URL(step, VECTORS), "utf8")).answer);
  if ("answer" in step) return answer(step.answer);
  const [what, arg] = String(step.misbehave).split(" ");
  if (what === "exit") process.exit(Number(arg));
  if (what === "no-json") return process.stdout.write("not json\n");
  if (what === "two-json") return process.stdout.write('{"ok":true}\n{"ok":true}\n');
  if (what === "big") return process.stdout.write("x".repeat(Number(arg)));
  if (what === "ok-then-exit") {
    answer(step.value);
    process.exitCode = Number(arg);
    return;
  }
  if (what === "sleep") return new Promise((resolve) => setTimeout(resolve, Number(arg)));
  if (what === "raw") return process.stdout.write(step.text);
  throw new Error(`unknown misbehaviour ${step.misbehave}`);
}

await main();
