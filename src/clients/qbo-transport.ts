// Sanctuary Computer (quickbooks-mcp-286): the QuickBooks request interceptors (spec D2, A4.1-A4.5b, A4.7; contract §5
// "QuickBooks' answers"). They sit on 291's shared guarded instance, which also carries the Stacks client's requests:
// only an answer from the QuickBooks host is read, and only a GET there is limited and resent. A resend is an ordinary
// request through the instance, so the guard decides it again. Each resend runs inside a nested AsyncLocalStorage
// holding its lineage's budget, one resend per status; nothing is kept on the config. Tokens and keys never reach a
// recorded failure: the only text kept is a 400's fault, with the call's secrets replaced first.
import { AsyncLocalStorage } from "node:async_hooks";
import type { AxiosInstance } from "axios";
import { clearFailure, currentCall, recordFailure, setCallToken, type Failure } from "./call-context.js";
import { QBO_HOST } from "./guard-decide.js";
import type { TokenResult } from "./stacks-token.js";

/** The fork's own limit on one QuickBooks request (spec §5 D3). */
export const QBO_LIMIT_MS = 15_000;
const RETRY_CAP_S = 30;
const RETRY_DEFAULT_S = 2;
const FAULT_MAX = 500;
const TID = /^[A-Za-z0-9-]{1,64}$/;
const STATUS = /^[0-9]{3}$/;
const SECONDS = /^[0-9]+$/;
/**
 * The codes of axios' own timeout error, raised by the limit set here: ECONNABORTED, or ETIMEDOUT under
 * `transitional.clarifyTimeoutError`. axios makes that error itself, with no `cause`; a socket's own ETIMEDOUT or
 * ECONNABORTED comes wrapped by `AxiosError.from`, which keeps the socket error as `cause`, and is fork-error.
 */
const LIMIT_CODES: ReadonlySet<string> = new Set(["ECONNABORTED", "ETIMEDOUT"]);

export type QboTransportDeps = {
  /**
   * T5's forced get: a new token for the company, the realm rule applied. `sentAt` is the send mark of the request that
   * got the 401, so the get joins only a forced fetch that started after that request was sent (spec A1.3b).
   */
  reacquire(company: string, sentAt: number): Promise<TokenResult>;
  /** The next send mark (T5's `mark()`): every QuickBooks GET takes one as it is sent. */
  mark(): number;
  /** The call's access token and STACKS_QBO_TOKEN, replaced in a 400's fault text (D6). */
  secrets(): Array<string | undefined>;
  /** Waits before a 429's resend; a timer by default. */
  sleep?(ms: number): Promise<void>;
};

type Budget = { readonly used401: boolean; readonly used429: boolean };
const FRESH: Budget = Object.freeze({ used401: false, used429: false });
/** The budget of the lineage a resend belongs to; a first request runs outside it and so has a fresh one. */
const lineage = new AsyncLocalStorage<Budget>();

/**
 * Where a QuickBooks GET's send mark is kept: a symbol on the request's own copy of its `transformResponse` array. 291's
 * guard sends a fresh config built from a few kept fields, so an error's config is that copy; `transformResponse` is one
 * of the kept fields and passes through by reference, read by neither the guard's decision nor the wire. The headers
 * never carry it.
 */
const SENT_AT: unique symbol = Symbol("qbo-transport.sent-at");
/** A request's send mark, undefined if it has none. */
const sentAtOf = (config: Record<string, unknown>): number | undefined => Object(config.transformResponse)[SENT_AT];

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** The host a request config names (its url against its baseURL); undefined when there is no parsable URL. */
function hostOf(config: Record<string, unknown>): string | undefined {
  try {
    const base = typeof config.baseURL === "string" ? config.baseURL : undefined;
    return new URL(String(config.url), base).hostname;
  } catch {
    return undefined;
  }
}
const isQuickbooks = (config: Record<string, unknown>): boolean => hostOf(config) === QBO_HOST;
const isGet = (config: Record<string, unknown>): boolean => typeof config.method === "string" && config.method.toLowerCase() === "get";

/** A header's value, its name matched in any case; undefined unless it is a string. */
function headerValue(headers: unknown, name: string): string | undefined {
  const entry = Object.entries(Object(headers)).find(([k]) => k.toLowerCase() === name);
  return typeof entry?.[1] === "string" ? entry[1] : undefined;
}

/** Seconds to wait before a 429's resend: the header's whole seconds capped at 30, else 2. */
function retryAfterSeconds(headers: unknown): number {
  const v = headerValue(headers, "retry-after");
  return v !== undefined && SECONDS.test(v) ? Math.min(Number(v), RETRY_CAP_S) : RETRY_DEFAULT_S;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * D6: a 400's free text when QuickBooks' body has a `Fault.Error[0]` with a Message or Detail: the secrets replaced
 * by `[redacted]` (longest first, so no part of one survives), control and separator characters made spaces, trimmed,
 * then cut to 500 code points. Undefined when nothing is left.
 */
function faultText(data: unknown, secrets: Array<string | undefined>): string | undefined {
  const body = typeof data === "string" ? parse(data) : data;
  const fault = isObject(body) ? body.Fault : undefined;
  const errors = isObject(fault) ? fault.Error : undefined;
  const first = Array.isArray(errors) ? errors[0] : undefined;
  if (!isObject(first)) return undefined;
  const parts = [first.Message, first.Detail].filter((p): p is string => typeof p === "string" && p !== "");
  let said = parts.join(": ");
  const known = secrets.filter((s): s is string => typeof s === "string" && s !== "").sort((a, b) => b.length - a.length);
  for (const s of known) said = said.split(s).join("[redacted]");
  said = Array.from(said.replace(/[\p{Cc}\u2028\u2029]/gu, " ").trim()).slice(0, FAULT_MAX).join("");
  return said === "" ? undefined : `QuickBooks answered 400. QuickBooks said: ${said}`;
}

/** What a QuickBooks answer that won't be resent records: `http-<status>` with a valid tid and a 400's fault text. */
function answerFailure(response: Record<string, unknown>, secrets: Array<string | undefined>): Failure {
  const status = response.status;
  if (typeof status !== "number" || !STATUS.test(String(status))) return Object.freeze({ reason: "fork-error" });
  const f: Failure = { reason: `http-${status}` };
  const tid = headerValue(response.headers, "intuit_tid");
  // A tid equal to a token or key (a token shaped like a tid, echoed in the header) is dropped (TB6-2).
  if (tid !== undefined && TID.test(tid) && !secrets.includes(tid)) f.intuitTid = tid;
  if (status === 400) {
    const text = faultText(response.data, secrets);
    if (text !== undefined) f.text = text;
  }
  return Object.freeze(f);
}

/** No answer: the limit set here is `timeout`; a reset, refusal, TLS failure or anything else is fork-error. */
function noAnswerFailure(e: Record<string, unknown>, config: Record<string, unknown>): Failure {
  const limit = isGet(config) && e.isAxiosError === true && typeof e.code === "string" && LIMIT_CODES.has(e.code) && e.cause === undefined;
  return Object.freeze({ reason: limit ? "timeout" : "fork-error" });
}

/** The token a request was sent with: its Authorization header (any casing) without the `Bearer ` scheme. */
const bearerOf = (headers: unknown): string | undefined => headerValue(headers, "authorization")?.replace(/^Bearer\s+/i, "");

/** The headers to resend with: the request's own, any Authorization replaced by the new token's. */
function withToken(headers: unknown, token: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(Object(headers))) if (k.toLowerCase() !== "authorization") out[k] = v;
  out.Authorization = `Bearer ${token}`;
  return out;
}

/**
 * Installs the request and response interceptors on `ax` (291's guarded instance, in the server). Returns eject,
 * which removes both.
 */
export function installQboInterceptors(ax: AxiosInstance, deps: QboTransportDeps): { eject(): void } {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const resend = (budget: Budget, config: Record<string, unknown>, headers: any) => lineage.run(budget, () => ax({ ...config, headers }));

  const onRequest = (config: any) => {
    if (isQuickbooks(config) && isGet(config)) {
      config.timeout = QBO_LIMIT_MS;
      // A copy, so the mark never lands on axios' shared default array.
      config.transformResponse = Object.assign([config.transformResponse].flat(), { [SENT_AT]: deps.mark() });
    }
    return config;
  };

  const onAnswer = (response: any) => {
    if (isQuickbooks(response.config)) clearFailure();
    return response;
  };

  const onError = async (e: unknown): Promise<unknown> => {
    const err = isObject(e) ? e : {};
    const config = err.config;
    // A request the guard refused, or any throw before a request was made, carries no config: it fails the call (§5).
    if (!isObject(config)) {
      recordFailure(Object.freeze({ reason: "fork-error" }));
      throw e;
    }
    if (!isQuickbooks(config)) throw e;
    const response = err.response;
    if (!isObject(response)) {
      recordFailure(noAnswerFailure(err, config));
      throw e;
    }
    const budget = lineage.getStore() ?? FRESH;
    if (isGet(config) && response.status === 401 && !budget.used401) {
      const call = currentCall();
      if (call !== undefined) {
        let result: TokenResult;
        try {
          result = await deps.reacquire(call.company, sentAtOf(config) as number);
        } catch {
          result = { ok: false, failure: Object.freeze({ reason: "fork-error" }) };
        }
        if (!result.ok) {
          recordFailure(result.failure);
          throw e;
        }
        // T5's realm rule refuses a changed realm; a token for another realm is never sent on this call's URL.
        if (result.token.realm_id !== call.realm) {
          recordFailure(Object.freeze({ reason: "fork-error" }));
          throw e;
        }
        setCallToken(result.token.access_token, result.token.realm_id);
        return resend({ ...budget, used401: true }, config, withToken(config.headers, result.token.access_token));
      }
    }
    if (isGet(config) && response.status === 429 && !budget.used429) {
      await sleep(retryAfterSeconds(response.headers) * 1000);
      return resend({ ...budget, used429: true }, config, config.headers);
    }
    // The failed request's own bearer too: it may be a token the call held before a 401 elsewhere replaced it (T6-1).
    recordFailure(answerFailure(response, [...deps.secrets(), bearerOf(config.headers)]));
    throw e;
  };

  const requestId = ax.interceptors.request.use(onRequest);
  const responseId = ax.interceptors.response.use(onAnswer, onError);
  return {
    eject() {
      ax.interceptors.request.eject(requestId);
      ax.interceptors.response.eject(responseId);
    },
  };
}
