// Sanctuary Computer (quickbooks-mcp-286): the per-tool-call store. Its AsyncLocalStorage is the only holder of the call's
// company, token and realm (A3.3: no module-level current company); overlapping calls each see their own (A3.4).
import { AsyncLocalStorage } from "node:async_hooks";
import { newCallRecord, type CallRecord } from "./guard-decide.js";

export type Failure = { reason: string; intuitTid?: string; source?: "stacks" | "quickbooks"; reported?: string; text?: string };

/** One tool call: the company it names, the token and realm once fetched, 291's query record, and what went wrong. */
export type CallStore = {
  company: string;
  realm?: string;
  token?: string;
  record: CallRecord;
  failure: Failure | null;
  usedOffset?: number;
  warnings: string[];
};

const calls = new AsyncLocalStorage<CallStore>();

/** Runs `fn` as one tool call for `company`, with a fresh store. */
export function runInCall<T>(company: string, fn: () => Promise<T>): Promise<T> {
  return calls.run({ company, record: newCallRecord(), failure: null, warnings: [] }, fn);
}

/** The current call's store; undefined outside a call. */
export function currentCall(): CallStore | undefined {
  return calls.getStore();
}

/** Keeps the call's failure; a no-op outside a call. */
export function recordFailure(f: Failure): void {
  const s = calls.getStore();
  if (s !== undefined) s.failure = f;
}

/** Clears the call's failure; a no-op outside a call. */
export function clearFailure(): void {
  const s = calls.getStore();
  if (s !== undefined) s.failure = null;
}

/** The call's token and the realm it is for; only ever called inside a call, so outside one it throws. */
export function setCallToken(token: string, realm: string): void {
  const s = calls.getStore();
  if (s === undefined) throw new Error("call-context: setCallToken outside a call");
  s.token = token;
  s.realm = realm;
}

/** The guard's realm callback (A3.5): true only for the current call's realm; false outside a call or before a realm is set. */
export function currentRealmAllows(realm: string): boolean {
  const kept = calls.getStore()?.realm;
  return kept !== undefined && kept === realm;
}

/** The guard's call-record callback: the current call's record; undefined outside a call. */
export function currentRecord(): CallRecord | undefined {
  return calls.getStore()?.record;
}

/** Keeps the offset the call used; a no-op outside a call. */
export function setUsedOffset(n: number): void {
  const s = calls.getStore();
  if (s !== undefined) s.usedOffset = n;
}
