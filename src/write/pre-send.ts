// Sanctuary Computer (quickbooks-mcp-293): the pre-send check, contract 1.1 §15 and §18 (docs/contracts/quickbooks.md in Stacksbot):
// the fresh fetches, the rules in the contract's order, the body and the check of it. It sends nothing but GETs, through the
// guard, for the current call's company, and only it can make a checked request.
import { clearFailure, currentCall, type CallStore, type Failure } from "../clients/call-context.js";
import { fetchById, fetchPreferences, type Answer, type UpdateEntity } from "./client.js";
import type { Change, Transaction } from "./compare.js";
import { buildBody, checkBody, entityKey, entityKeys, isId, isRecord, lineRefs, MAX_LINES, prop, ruleClosed, ruleIds, ruleLines, ruleNoop, ruleStacksBill, ruleSubjectLine, ruleType } from "./rules.js";

export { ruleClosed, ruleLines, ruleStacksBill, ruleSubjectLine, ruleType };

export type Mode = "categorize" | "undo" | "dry";
/** `beforeFetch` runs after `size` and before the first GET; `afterLine` after `line` and before `account`. A reason refuses. */
export type Hooks = { beforeFetch?: () => Promise<string | null>; afterLine?: (fetched: Transaction) => string | null };
export type PreSendInput = Hooks & { company: string; entity: UpdateEntity; id: string } & (
    | { mode: "categorize" | "undo"; lines: readonly Change[] }
    | { mode: "dry"; lines?: undefined }
  );
/** A `write:` reason, or a fork reason with whatever 286's failure holds. */
export type Refusal = { ok: false } & Failure;
export type PreSendResult = { ok: true; checked: CheckedRequest } | Refusal;

type Fields = { company: string; entity: UpdateEntity; mode: Mode; fetched: Transaction; changes: readonly Change[]; body: Record<string, unknown>; bodyText: string };

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

  constructor(token: symbol, fields: Fields) {
    if (token !== TOKEN) throw new TypeError("a checked request is made by preSend only");
    Object.assign(this, fields);
    made.add(Object.freeze(this));
  }
}

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
const refuse = (reason: string): never => {
  throw new Refused({ ok: false, reason });
};
/** For an answer or input the check can't read, and anything unexpected. */
const broken = (): never => refuse("fork-error");
/** A rule's or a hook's answer: null goes on, a reason refuses, anything else is unexpected. */
function apply(reason: unknown): void {
  if (reason === null) return;
  if (typeof reason !== "string" || reason === "") broken();
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
async function read(call: CallStore, fetch: () => Promise<Answer>, missing: string | null): Promise<Record<string, unknown>> {
  const failed = (): never => {
    throw new Refused({ ok: false, ...(call.failure ?? { reason: "fork-error" }) });
  };
  let answer: Answer;
  try {
    answer = await fetch();
  } catch {
    return failed();
  }
  const { status, data } = answer;
  if (missing !== null && faultCode(data) === "610") {
    // The answer is the rule's now, not a failure of the call.
    clearFailure();
    return refuse(missing);
  }
  if (status < 200 || status > 299) return failed();
  return isRecord(data) && !Object.keys(data).includes("Fault") ? data : broken();
}

/** One account or class, which must be the one asked for. */
async function readRef(call: CallStore, entity: "account" | "class", id: unknown): Promise<Record<string, unknown>> {
  if (!isId(id)) return broken();
  const found = (await read(call, () => fetchById(entity, id), `write:${entity}`))[entity === "account" ? "Account" : "Class"];
  return prop(found, "Id") === id ? (found as Record<string, unknown>) : broken();
}

const mustBeActive = ({ Active }: Record<string, unknown>, reason: string): void => {
  if (typeof Active !== "boolean") broken();
  if (!Active) refuse(reason);
};

/** Steps 9 and 10. Undo and the write check need each to exist, no more. */
async function checkRefs(call: CallStore, mode: Mode, accounts: unknown[], classes: unknown[]): Promise<void> {
  for (const id of new Set(accounts)) {
    const account = await readRef(call, "account", id);
    if (mode !== "categorize") continue;
    const { AccountType } = account;
    if (typeof AccountType !== "string") return broken();
    mustBeActive(account, "write:account");
    if (AccountType !== "Expense" && AccountType !== "Other Expense" && AccountType !== "Cost of Goods Sold") refuse("write:account");
  }
  for (const id of new Set(classes)) {
    const found = await readRef(call, "class", id);
    if (mode === "categorize") mustBeActive(found, "write:class");
  }
}

async function check(input: PreSendInput, build: typeof buildBody): Promise<CheckedRequest> {
  // Each field read once, before anything waits, so a caller that changes its input changes nothing here.
  const { company, entity, id, mode, lines, beforeFetch, afterLine } = input;
  if (mode === "categorize" && Array.isArray(lines) && lines.length > MAX_LINES) refuse("write:size");
  const call = currentCall();
  if (call === undefined || call.company !== company) return broken();
  if ((entity !== "purchase" && entity !== "bill") || !isId(id)) return broken();
  if (mode !== "categorize" && mode !== "undo" && (mode !== "dry" || lines !== undefined)) return broken();
  const changes = mode === "dry" ? frozenCopy<readonly Change[]>([]) : copyChanges(lines);

  if (beforeFetch !== undefined) apply(await beforeFetch());

  const answer = frozenCopy(await read(call, () => fetchById(entity, id), "write:not-found"));
  if (entityKeys(answer).length === 0) broken();
  const txn = answer[entityKey(entity)] as Transaction;
  if (txn !== undefined && !(prop(txn, "Id") === id && typeof txn.SyncToken === "string" && typeof txn.TxnDate === "string" && Array.isArray(txn.Line))) broken();
  const prefs = prop((await read(call, fetchPreferences, null)).Preferences, "AccountingInfoPrefs");
  if (!isRecord(prefs)) return broken();

  apply(ruleType(entity, answer));
  apply(ruleStacksBill(entity, txn));
  apply(ruleClosed(txn, prefs));
  if (mode === "dry") apply(ruleSubjectLine(txn));
  else if (mode === "undo") apply(changes.length === 0 ? "write:line" : ruleIds(txn));
  else apply(ruleLines(txn, changes));
  if (afterLine !== undefined) apply(afterLine(txn));
  const refs = mode === "dry" ? lineRefs(txn) : { accounts: changes.map((c) => c.account_id), classes: changes.map((c) => c.class_id).filter((c) => typeof c === "string") };
  await checkRefs(call, mode, refs.accounts, refs.classes);
  if (mode === "categorize") apply(ruleNoop(txn, changes));

  const bodyText: unknown = JSON.stringify(build(txn, changes));
  const body = checkBody(txn, bodyText, changes);
  if (body === null) return refuse("write:diff");
  return new CheckedRequest(TOKEN, { company, entity, mode, fetched: txn, changes, body: frozenCopy(body), bodyText: bodyText as string });
}

/** Whether the change may be sent, and the checked request if so. `deps.buildBody` is for tests; `checkBody` judges whatever it makes. */
export async function preSend(input: PreSendInput, deps: { buildBody?: typeof buildBody } = {}): Promise<PreSendResult> {
  try {
    return { ok: true, checked: await check(input, deps.buildBody ?? buildBody) };
  } catch (e) {
    return e instanceof Refused ? e.refusal : { ok: false, reason: "fork-error" };
  }
}
