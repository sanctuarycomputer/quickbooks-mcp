// Sanctuary Computer (quickbooks-mcp-293): the pre-send check, contract 1.1 §15 and §18 (docs/contracts/quickbooks.md in Stacksbot):
// the fresh fetches, the rules in the contract's order, the body and the check of it. It sends nothing but GETs, through the
// guard, for the current call's company, and only it can make a checked request.
// Changed by Sanctuary Computer (quickbooks-mcp-294): a write refusal carries its detail (spec §3 "gap: free texts", plan-1 P10); a
// checked request carries `checkedAt`, read from `deps.mono` (the registry's kind of clock) when it is made (293 QA1), and the names
// steps 9-10 read, keyed `account:<id>` and `class:<id>` (spec §3 "gap: intent names", plan-1 P12).
import { clearFailure, currentCall, type CallStore, type Failure } from "../clients/call-context.js";
import { cleanName } from "../helpers/name-fold.js";
import { fetchById, fetchPreferences, type Answer, type UpdateEntity } from "./client.js";
import type { Change, Transaction } from "./compare.js";
import { buildBody, checkBody, entityKey, entityKeys, isId, isRecord, lineRefs, MAX_LINES, prop, ruleClosed, ruleIds, ruleLines, ruleNoop, ruleStacksBill, ruleSubjectLine, ruleType, type RuleAnswer } from "./rules.js";

export { ruleClosed, ruleLines, ruleStacksBill, ruleSubjectLine, ruleType };

export type Mode = "categorize" | "undo" | "dry";
/** `beforeFetch` runs after `size` and before the first GET; `afterLine` after `line` and before `account`. A reason refuses. */
export type Hooks = { beforeFetch?: () => Promise<string | null>; afterLine?: (fetched: Transaction) => string | null };
export type PreSendInput = Hooks & { company: string; entity: UpdateEntity; id: string } & (
    | { mode: "categorize" | "undo"; lines: readonly Change[] }
    | { mode: "dry"; lines?: undefined }
  );
/** A `write:` reason with its detail (its §6 case and the ids it names), or a fork reason with whatever 286's failure holds. */
export type Refusal = { ok: false; detail?: Record<string, string> } & Failure;
export type PreSendResult = { ok: true; checked: CheckedRequest } | Refusal;

type Fields = {
  company: string;
  entity: UpdateEntity;
  mode: Mode;
  fetched: Transaction;
  changes: readonly Change[];
  body: Record<string, unknown>;
  bodyText: string;
  checkedAt: number;
  names: Readonly<Record<string, string>>;
};

const TOKEN = Symbol("pre-send");
const made = new WeakSet<object>();

/** Made here only, frozen to its depths. */
class CheckedRequest {
  // So that no other shape has this type.
  private declare readonly brand: never;
  readonly company!: string;
  readonly entity!: UpdateEntity;
  readonly mode!: Mode;
  readonly fetched!: Transaction;
  readonly changes!: readonly Change[];
  readonly body!: Record<string, unknown>;
  readonly bodyText!: string;
  /** `deps.mono` when it was made; NaN when that answered no number, so no registry takes it. */
  readonly checkedAt!: number;
  /** Each account's and class's `Name` steps 9-10 read (a non-empty string), by `account:<id>` and `class:<id>`. */
  readonly names!: Readonly<Record<string, string>>;

  constructor(token: symbol, fields: Fields) {
    if (token !== TOKEN) throw new TypeError("a checked request is made by preSend only");
    // Defined, not set, so no accessor on a prototype takes a field's place.
    Object.defineProperties(this, Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value, enumerable: true }])));
    made.add(Object.freeze(this));
  }
}
Object.freeze(CheckedRequest);
Object.freeze(CheckedRequest.prototype);

export type { CheckedRequest };

/** True only for a request `preSend` made. */
export function isChecked(value: unknown): value is CheckedRequest {
  return made.has(value as object);
}

/** Stops the check with its answer. */
class Refused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.reason);
  }
}
const refuse = (reason: string, detail: Record<string, string> = {}): never => {
  throw new Refused({ ok: false, reason, detail });
};
/** A rule's answer: null goes on, a reason refuses with its detail. */
const applyRule = (answer: RuleAnswer): void => {
  if (answer !== null) refuse(answer.reason, answer.detail);
};
/** A write refusal before any rule's. */
type Missing = { reason: string; detail: Record<string, string> };
/** For an answer or input the check can't read, and anything unexpected. */
const broken = (): never => {
  // A fork reason: no detail.
  throw new Refused({ ok: false, reason: "fork-error" });
};
/** A hook's answer: null goes on, a reason refuses, anything else is unexpected. */
function apply(reason: unknown): void {
  if (reason === null) return;
  if (typeof reason !== "string" || reason === "") {
    // A promise's own rejection is handled, whatever it comes to: it is refused already.
    new Promise((resolve) => resolve(reason)).catch(() => undefined);
    broken();
  }
  // A hook's reason has one text (§6): no case.
  refuse(reason as string);
}

/** A deep-frozen copy of JSON; own keys of any name. */
function frozenCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy)) as T;
  if (!isRecord(value)) return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, frozenCopy(inner)]))) as T;
}

/** The changes as asked, in their own objects; each field read once. */
function copyChanges(lines: unknown): readonly Change[] {
  if (!Array.isArray(lines)) return broken();
  return frozenCopy(
    Array.from(lines, (line: unknown) => {
      const { line_id, account_id, class_id } = line as Record<string, unknown>;
      if (!isId(line_id) || !isId(account_id)) return broken();
      if (class_id === undefined) return { line_id, account_id };
      return class_id === null || isId(class_id) ? { line_id, account_id, class_id } : broken();
    }),
  );
}

/** A Fault's code decides in any status (§17 Send answers). */
const faultCode = (data: unknown): unknown => {
  const errors = prop(prop(data, "Fault"), "Error");
  return Array.isArray(errors) ? prop(errors[0], "code") : undefined;
};

/** One GET's body, a JSON object with no Fault. Fault 610 answers `missing`; any other failure the one 286 recorded. */
async function read(call: CallStore, get: () => Promise<Answer>, missing: Missing | null): Promise<Record<string, unknown>> {
  const failed = (): never => {
    throw new Refused({ ok: false, ...(call.failure ?? { reason: "fork-error" }) });
  };
  let answer: Answer;
  try {
    answer = await get();
  } catch {
    return failed();
  }
  const { status, data } = answer;
  if (missing !== null && faultCode(data) === "610") {
    // The answer is the rule's now, not a failure of the call.
    clearFailure();
    return refuse(missing.reason, missing.detail);
  }
  if (status < 200 || status > 299) return failed();
  return isRecord(data) && !Object.keys(data).includes("Fault") ? data : broken();
}

/**
 * One account or class, which must be the one asked for; its `Name`, when a non-empty string, goes in `names`. Missing is
 * `missing` for categorize, and `undo` ("no longer exists") for undo and the write check.
 */
async function readRef(call: CallStore, mode: Mode, entity: "account" | "class", id: unknown, names: Record<string, string>): Promise<Record<string, unknown>> {
  if (!isId(id)) return broken();
  const missing = { reason: `write:${entity}`, detail: { case: mode === "categorize" ? "missing" : "undo", id } };
  const found = (await read(call, () => fetchById(entity, id), missing))[entity === "account" ? "Account" : "Class"];
  if (prop(found, "Id") !== id) return broken();
  const { Name } = found as Record<string, unknown>;
  if (typeof Name === "string" && Name !== "") names[`${entity}:${id}`] = Name;
  return found as Record<string, unknown>;
}

/** What an `AccountType` that §5's name rule cleans to nothing reads as in the free text. */
const UNTYPED = "untyped";

const mustBeActive = ({ Active }: Record<string, unknown>, reason: string, id: string): void => {
  if (typeof Active !== "boolean") broken();
  if (!Active) refuse(reason, { case: "inactive", id });
};

/** Steps 9 and 10, and the names they read. Undo and the write check need each to exist, no more. */
async function checkRefs(call: CallStore, mode: Mode, accounts: unknown[], classes: unknown[]): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  for (const id of new Set(accounts)) {
    const account = await readRef(call, mode, "account", id, names);
    if (mode !== "categorize") continue;
    const { AccountType } = account;
    if (typeof AccountType !== "string") return broken();
    mustBeActive(account, "write:account", id as string);
    // Matched as read; written cleaned by §5's name rule, a type cleaned to nothing reading `untyped` (task-6-1 TJ6).
    if (AccountType !== "Expense" && AccountType !== "Other Expense" && AccountType !== "Cost of Goods Sold") refuse("write:account", { case: "type", id: id as string, AccountType: cleanName(AccountType) ?? UNTYPED });
  }
  for (const id of new Set(classes)) {
    const found = await readRef(call, mode, "class", id, names);
    if (mode === "categorize") mustBeActive(found, "write:class", id as string);
  }
  return names;
}

async function check(input: PreSendInput, build: typeof buildBody, mono: () => number): Promise<CheckedRequest> {
  // Each field read once, before anything waits, so a caller that changes its input changes nothing here.
  const { company, entity, id, mode, lines: given, beforeFetch, afterLine } = input;
  const lines: unknown = Array.isArray(given) ? Array.from(given) : given;
  if (mode === "categorize" && Array.isArray(lines) && lines.length > MAX_LINES) refuse("write:size");
  const call = currentCall();
  if (call === undefined || call.company !== company) return broken();
  if ((entity !== "purchase" && entity !== "bill") || !isId(id)) return broken();
  if (mode !== "categorize" && mode !== "undo" && (mode !== "dry" || lines !== undefined)) return broken();
  const changes = mode === "dry" ? frozenCopy<readonly Change[]>([]) : copyChanges(lines);

  if (beforeFetch !== undefined) apply(await beforeFetch());

  const notFound = { reason: "write:not-found", detail: { case: mode === "undo" ? "undo" : "categorize", T: entityKey(entity), id } };
  const answer = frozenCopy(await read(call, () => fetchById(entity, id), notFound));
  if (entityKeys(answer).length === 0) broken();
  const txn = answer[entityKey(entity)] as Transaction;
  if (txn !== undefined && !(prop(txn, "Id") === id && typeof txn.SyncToken === "string" && typeof txn.TxnDate === "string" && Array.isArray(txn.Line))) broken();
  const prefs = prop((await read(call, fetchPreferences, null)).Preferences, "AccountingInfoPrefs");
  if (!isRecord(prefs)) return broken();

  applyRule(ruleType(entity, answer));
  applyRule(ruleStacksBill(entity, txn));
  applyRule(ruleClosed(txn, prefs, mode === "undo"));
  if (mode === "dry") applyRule(ruleSubjectLine(txn));
  else if (mode === "undo") applyRule(changes.length === 0 ? { reason: "write:line", detail: { case: "none" } } : ruleIds(txn));
  else applyRule(ruleLines(txn, changes));
  if (afterLine !== undefined) apply(afterLine(txn));
  const refs = mode === "dry" ? lineRefs(txn) : { accounts: changes.map((c) => c.account_id), classes: changes.map((c) => c.class_id).filter((c) => typeof c === "string") };
  const names = await checkRefs(call, mode, refs.accounts, refs.classes);
  if (mode === "categorize") applyRule(ruleNoop(txn, changes));

  const bodyText: unknown = JSON.stringify(build(txn, changes));
  const body = checkBody(txn, bodyText, changes);
  if (body === null) return refuse("write:diff");
  // Read once, as the request is made: its age at register is the registry's clock less this (QA1).
  const at: unknown = mono();
  const checkedAt = typeof at === "number" ? at : NaN;
  return new CheckedRequest(TOKEN, { company, entity, mode, fetched: txn, changes, body: frozenCopy(body), bodyText: bodyText as string, checkedAt, names: frozenCopy(names) });
}

/**
 * Whether the change may be sent, and the checked request if so. `deps.buildBody` is for tests; `checkBody` judges whatever it
 * makes. `deps.mono` is the registry's clock (the write kit's), `performance.now()` by default as the registry's is.
 */
export async function preSend(input: PreSendInput, deps: { buildBody?: typeof buildBody; mono?: () => number } = {}): Promise<PreSendResult> {
  try {
    return { ok: true, checked: await check(input, deps.buildBody ?? buildBody, deps.mono ?? (() => performance.now())) };
  } catch (e) {
    return e instanceof Refused ? e.refusal : { ok: false, reason: "fork-error" };
  }
}
