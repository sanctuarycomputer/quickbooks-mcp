// Sanctuary Computer (quickbooks-mcp-286): the Stacks token client, contract 1.1 §2 (docs/contracts/quickbooks.md in Stacksbot).
// It asks Stacks for a company's access token through the guarded axios instance, reads every answer by §2's mapping
// (steps 1-7, the realm rule inside steps 1-2, then Stacks' name), keeps one token per company in memory, and keeps
// each company's realm in the RealmStore. It holds no refresh material, writes nothing to disk, and logs nothing: the
// access token and STACKS_QBO_TOKEN never reach a Failure, an error or a log line.
import { guardedAxios } from "../http-guard.js";
import { cleanName, matches } from "../helpers/name-fold.js";
import type { Failure } from "./call-context.js";
import type { Company } from "./companies.js";
import type { Config } from "./config.js";

/** A token Stacks handed out that passed step 1 and the name check; exactly these four fields are kept. */
export type Token = { readonly access_token: string; readonly realm_id: string; readonly expires_at: string; readonly company_name: string };
export type TokenResult = { ok: true; token: Token } | { ok: false; failure: Failure };

/** Each company's kept realm (§2 "The realm is kept", D4) and its refusal until restart; one per process, built at start. */
export type RealmStore = {
  kept(company: string): string | undefined;
  keep(company: string, realm: string): void;
  refuse(company: string, f: Failure): void;
  refused(company: string): Failure | undefined;
};

export function createRealmStore(): RealmStore {
  const realms = new Map<string, string>();
  const refusals = new Map<string, Failure>();
  return {
    kept: (company) => realms.get(company),
    keep: (company, realm) => void realms.set(company, realm),
    refuse: (company, f) => void refusals.set(company, f),
    refused: (company) => refusals.get(company),
  };
}

const PATH = "/api/qbo/access_token";
const TIMEOUT_MS = 10_000;
/** A kept token is used while now < expires_at − 300 s (§2 Tokens: 286 may ask earlier). */
const EARLY_MS = 300_000;
const TOKEN_KEYS = ["access_token", "company_name", "enterprise", "expires_at", "realm_id"];
const REALM = /^[0-9]{1,20}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const CODE = /^[A-Za-z0-9_-]{1,64}$/;

/** What one request brought back: a status and the body's text, or null for no answer (timeout, refused, reset, TLS). */
type Answer = { status: number; text: string } | null;
/** One answer read by the mapping: a step-1 token, a step 2-6 failure (`refuse` for the realm rule), or step 7. */
type Reading = { kind: "token"; token: Token } | { kind: "failure"; failure: Failure; refuse: boolean } | { kind: "unreachable" };

const failure = (reason: string): Failure => Object.freeze({ reason });
const failed = (reason: string): TokenResult => ({ ok: false, failure: failure(reason) });
const forkError = (refuse = false): Reading => ({ kind: "failure", failure: failure("fork-error"), refuse });
const UNREACHABLE: Reading = { kind: "unreachable" };
/** Step 7's answer to a first request: ask once more. */
const RETRY: unique symbol = Symbol("retry");

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const hasExactly = (o: Record<string, unknown>, keys: string[]): boolean => {
  const own = Object.keys(o).sort();
  return own.length === keys.length && own.every((k, i) => k === keys[i]);
};

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$` naming a real time: Date.parse must not roll it (2026-02-30 is not 2 March). */
function realInstant(s: unknown): s is string {
  if (typeof s !== "string" || !INSTANT.test(s)) return false;
  const t = Date.parse(s);
  return !Number.isNaN(t) && new Date(t).toISOString() === `${s.slice(0, -1)}.000Z`;
}

/** Steps 1 and 2: a 200. The realm rule sits in step 1's order: a realm other than the kept one refuses the company. */
function readToken(body: unknown, key: string, kept: string | undefined, now: number): Reading {
  if (!isObject(body) || !hasExactly(body, TOKEN_KEYS)) return forkError();
  const { enterprise, realm_id, access_token, expires_at, company_name } = body;
  if (enterprise !== key) return forkError();
  if (typeof realm_id !== "string" || !REALM.test(realm_id)) return forkError();
  if (kept !== undefined && realm_id !== kept) return forkError(true);
  if (typeof access_token !== "string" || access_token === "") return forkError();
  if (!realInstant(expires_at) || Date.parse(expires_at) <= now) return forkError();
  // cleanName is null for a non-string too.
  if (cleanName(company_name) === null) return forkError();
  return { kind: "token", token: Object.freeze({ access_token, realm_id, expires_at, company_name: company_name as string }) };
}

/** §2's Stacks mapping, steps 1-7, in order; the first that holds decides. */
function read(answer: Answer, key: string, kept: string | undefined, now: number): Reading {
  if (answer === null) return UNREACHABLE;
  const { status } = answer;
  const body = parse(answer.text);
  if (status === 200) return readToken(body, key, kept, now);
  const fail = (reason: string): Reading => ({ kind: "failure", failure: failure(reason), refuse: false });
  if (status === 403 && isObject(body) && Array.isArray(body.errors) && isObject(body.errors[0]) && body.errors[0].status === "forbidden") {
    return fail("stacks-auth");
  }
  if (status === 404 && isObject(body) && hasExactly(body, ["error"]) && body.error === "unknown-enterprise") return fail("unknown-enterprise");
  if (status === 409 && isObject(body) && hasExactly(body, ["error"]) && body.error === "not-connected") return fail("not-connected");
  if (status === 502 && isObject(body) && hasExactly(body, ["code", "error"]) && body.error === "renewal-failed" && typeof body.code === "string" && CODE.test(body.code)) {
    return fail(`renewal-failed:${body.code}`);
  }
  return UNREACHABLE;
}

type Flight = { forced: boolean; result: Promise<TokenResult> };

export class StacksTokenClient {
  private readonly url: string;
  private readonly key: string;
  private readonly companies: ReadonlyMap<string, Company>;
  private readonly now: () => number;
  private readonly tokens = new Map<string, Token>();
  private readonly flights = new Map<string, Flight>();
  /** Per company, the sequence number of its latest forced fetch: a fetch started before it never writes the cache. */
  private readonly floors = new Map<string, number>();
  private sequence = 0;

  constructor(
    cfg: Config,
    private readonly realms: RealmStore,
    deps: { now?: () => number } = {},
  ) {
    // Read once, as strings: the live URL object is never kept or handed on (T3-5).
    const origin = cfg.stacksUrl.origin;
    const path = cfg.stacksUrl.pathname.replace(/\/+$/, "");
    this.url = `${origin}${path}${PATH}`;
    this.key = cfg.stacksKey;
    this.companies = new Map(cfg.companies.map((c) => [c.key, c]));
    this.now = deps.now ?? Date.now;
  }

  /**
   * The company's token: its kept failure if refused (no request); the kept token while now < expires_at − 300 s;
   * else a fetch. Unforced gets join any fetch in flight; a forced get joins only a forced one, drops the kept token,
   * and makes every fetch started before it unable to write the cache.
   */
  get(company: string, opts: { force?: boolean } = {}): Promise<TokenResult> {
    const refusal = this.realms.refused(company);
    if (refusal !== undefined) return Promise.resolve({ ok: false, failure: refusal });
    const entry = this.companies.get(company);
    if (entry === undefined) return Promise.resolve(failed("fork-error"));
    const flight = this.flights.get(company);
    if (opts.force === true) {
      if (flight?.forced === true) return flight.result;
      return this.start(entry, true);
    }
    const token = this.tokens.get(company);
    if (token !== undefined && this.now() < Date.parse(token.expires_at) - EARLY_MS) return Promise.resolve({ ok: true, token });
    if (flight !== undefined) return flight.result;
    return this.start(entry, false);
  }

  private start(entry: Company, forced: boolean): Promise<TokenResult> {
    const seq = ++this.sequence;
    if (forced) {
      this.tokens.delete(entry.key);
      this.floors.set(entry.key, seq);
    }
    const flight: Flight = { forced, result: this.fetchToken(entry, seq) };
    this.flights.set(entry.key, flight);
    const done = () => {
      if (this.flights.get(entry.key) === flight) this.flights.delete(entry.key);
    };
    flight.result.then(done, done);
    return flight.result;
  }

  /** One fetch: an answer read by `decide`, step 7 asked again once at once; a token is cached unless a later force began. */
  private async fetchToken(entry: Company, seq: number): Promise<TokenResult> {
    let result = this.decide(entry, await this.ask(entry.key));
    if (result === RETRY) result = this.decide(entry, await this.ask(entry.key));
    if (result === RETRY) return failed("stacks-unreachable");
    if (result.ok && seq >= (this.floors.get(entry.key) ?? 0)) this.tokens.set(entry.key, result.token);
    return result;
  }

  /**
   * One answer, synchronously from reading the kept realm to keeping one (so no other fetch's answer comes between):
   * the mapping, the realm rule's refusal, the name check (nothing kept on a mismatch), then the realm kept if none is.
   */
  private decide(entry: Company, answer: Answer): TokenResult | typeof RETRY {
    const reading = read(answer, entry.key, this.realms.kept(entry.key), this.now());
    if (reading.kind === "unreachable") return RETRY;
    if (reading.kind === "failure") {
      if (reading.refuse) this.realms.refuse(entry.key, reading.failure);
      return { ok: false, failure: reading.failure };
    }
    const { token } = reading;
    if (!matches(token.company_name, entry.acceptedNames)) {
      // Step 1 found the name non-empty after the name rule, so `reported:` is never empty.
      return { ok: false, failure: Object.freeze({ reason: "name-mismatch", source: "stacks", reported: cleanName(token.company_name) as string }) };
    }
    if (this.realms.kept(entry.key) === undefined) this.realms.keep(entry.key, token.realm_id);
    return { ok: true, token };
  }

  /** One GET through the guarded instance, `X-Api-Key` its only credential; any status is an answer, no answer is null. */
  private async ask(key: string): Promise<Answer> {
    try {
      const res = await guardedAxios()({
        method: "get",
        url: `${this.url}?enterprise=${encodeURIComponent(key)}`,
        headers: { "X-Api-Key": this.key },
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
        responseType: "text",
        transformResponse: [(data: unknown) => data],
      });
      return { status: res.status, text: String(res.data) };
    } catch {
      return null;
    }
  }
}
