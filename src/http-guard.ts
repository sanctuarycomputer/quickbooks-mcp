// Sanctuary Computer (quickbooks-mcp-291): the HTTP guard on the CommonJS axios instance node-quickbooks calls (contract 1.0 §6 in Stacksbot's docs/contracts/quickbooks.md).
import { AsyncLocalStorage } from "node:async_hooks";
import https from "node:https";
import { createRequire } from "node:module";
import type { AxiosStatic } from "axios";
import { decide, newCallRecord, type CallRecord, type GuardContext } from "./clients/guard-decide.js";

/** A request the guard refused; the message names the rule only, never the URL or a header. */
export class GuardRefusedError extends Error {
  readonly rule: string;
  constructor(rule: string) {
    super(`qbo-guard: refused (${rule})`);
    this.name = "GuardRefusedError";
    this.rule = rule;
  }
}

const requireHere = createRequire(import.meta.url);

/** The CommonJS default axios instance node-quickbooks loads (the fork's ESM `import axios` is a different object). */
export function guardedAxios(): AxiosStatic {
  return createRequire(requireHere.resolve("node-quickbooks"))("axios");
}

// ---- refusal log ----

const LOGGED_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** `qbo-guard: refused <METHOD> <protocol>//<host><path> (<rule>)`: no query, no userinfo, no header, no raw text. */
function logRefusal(method: unknown, url: unknown, rule: string): void {
  try {
    const upper = typeof method === "string" ? method.toUpperCase() : "";
    const m = LOGGED_METHODS.includes(upper) ? upper : "OTHER";
    let where = "<unparsable url>";
    try {
      const u = new URL(url as string);
      where = `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      // keep <unparsable url>
    }
    process.stderr.write(`qbo-guard: refused ${m} ${where} (${rule})\n`);
  } catch {
    // the refusal stands even if the log can't be written
  }
}

function refusal(method: unknown, url: unknown, rule: string): GuardRefusedError {
  logRefusal(method, url, rule);
  return new GuardRefusedError(rule);
}

// ---- tickets (the backstop lets a socket open only under one of these) ----

export type Ticket = { method: string; hostname: string; port: string; path: string };
type IssuedTicket = Ticket & { used: boolean };
const tickets = new AsyncLocalStorage<IssuedTicket>();

/** Runs `fn` with a single-use ticket for exactly one request; T3's wrapped `https.request` requires it. */
export function runIssued<T>(ticket: Ticket, fn: () => T): T {
  return tickets.run({ ...ticket, used: false }, fn);
}

/** The current ticket, for the backstop. */
export function currentTicket(): IssuedTicket | undefined {
  return tickets.getStore();
}

// ---- call scope ----

export type CallScope = {
  run<T>(fn: () => T): T;
  setRealm(realm: string): void;
  allowedRealm(realm: string): boolean;
  callRecord(): CallRecord | undefined;
};

/** An AsyncLocalStorage scope: each `run` is one tool call, with a fresh call record and no realm until `setRealm`. */
export function createCallScope(): CallScope {
  const store = new AsyncLocalStorage<{ realm: string | undefined; record: CallRecord }>();
  return {
    run: (fn) => store.run({ realm: undefined, record: newCallRecord() }, fn),
    setRealm(realm) {
      const s = store.getStore();
      if (s === undefined) throw new Error("qbo-guard: setRealm outside a call");
      if (s.realm !== undefined && s.realm !== realm) throw new Error("qbo-guard: the call's realm is already kept");
      s.realm = realm;
    },
    allowedRealm(realm) {
      const s = store.getStore();
      return s !== undefined && s.realm !== undefined && s.realm === realm;
    },
    callRecord: () => store.getStore()?.record,
  };
}

// ---- the guard ----

/** The one holder: the guard reads its context through it, so configureGuard reaches it. createGuard sets `ctx`; secureStart sets `scope`. */
const holder: { ctx: GuardContext | undefined; scope: CallScope | undefined } = { ctx: undefined, scope: undefined };

/** Replaces any of `keys`, `allowedRealm`, `callRecord`; never `stacksUrl`. */
export function configureGuard(part: Partial<Pick<GuardContext, "keys" | "allowedRealm" | "callRecord">>): void {
  if (holder.ctx === undefined) throw new Error("qbo-guard: not started");
  const next = { ...holder.ctx };
  for (const k of ["keys", "allowedRealm", "callRecord"] as const) {
    if (!Object.prototype.hasOwnProperty.call(part, k)) continue;
    if (typeof part[k] !== "function") throw new TypeError(`qbo-guard: configureGuard ${k} is not a function`);
    (next as Record<string, unknown>)[k] = part[k];
  }
  holder.ctx = next;
}

/** The call scope secureStart made; throws before start. */
export function defaultCallScope(): CallScope {
  if (holder.scope === undefined) throw new Error("qbo-guard: not started");
  return holder.scope;
}

const AGENT = new https.Agent({ rejectUnauthorized: true });
/** What the send config takes from the request; every transport key is the guard's own. */
const KEPT = ["method", "headers", "responseType", "timeout", "transformRequest", "transformResponse", "validateStatus"] as const;

const ownProp = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Header names as axios will send them (AxiosHeaders → plain object). */
function headerObject(headers: unknown): Record<string, unknown> {
  return guardedAxios().AxiosHeaders.from(headers as any).toJSON() as Record<string, unknown>;
}

export type Guard = { adapter: (config: any) => Promise<any> };

/** Builds the guard: decide, check the composed text against getUri, send W with the guard's transport, under a ticket. */
export function createGuard(ctx: GuardContext): Guard {
  holder.ctx = { ...ctx };
  const adapter = async function qboGuardAdapter(config: any): Promise<any> {
    let send: Record<string, unknown>;
    let ticket: Ticket;
    let entry: CallRecord["queries"][number] | undefined;
    let httpAdapter: (c: any) => Promise<any>;
    try {
      const decision = decide(
        { method: config.method, url: config.url, params: config.params, headers: headerObject(config.headers), data: config.data },
        holder.ctx!,
      );
      if (!decision.allow) throw refusal(config.method, config.url, decision.rule);
      const ax = guardedAxios();
      if (ax.getUri(config) !== decision.text) throw refusal(config.method, config.url, "guard-error");
      send = {};
      for (const k of KEPT) if (ownProp(config, k)) send[k] = config[k];
      send.url = decision.url;
      send.maxRedirects = 0;
      send.proxy = false;
      send.httpsAgent = AGENT;
      const w = new URL(decision.url);
      ticket = { method: String(config.method).toUpperCase(), hostname: w.hostname, port: w.port, path: w.pathname + w.search };
      httpAdapter = ax.getAdapter("http") as (c: any) => Promise<any>;
      if (decision.entity !== undefined) {
        const record = holder.ctx!.callRecord();
        if (record === undefined) throw new Error("no call record");
        entry = { entity: decision.entity, url: decision.url, status: null };
        record.queries.push(entry);
      }
    } catch (e) {
      if (e instanceof GuardRefusedError) throw e;
      throw refusal(config?.method, config?.url, "guard-error");
    }
    try {
      const response = await runIssued(ticket, () => httpAdapter(send));
      if (entry !== undefined) entry.status = response.status;
      return response;
    } catch (e) {
      if (entry !== undefined) entry.status = (e as any)?.response?.status ?? null;
      throw e;
    }
  };
  return { adapter };
}

const installed = new WeakMap<Guard, () => void>();

/** Sets the guard as the CommonJS instance's adapter and adds the identity interceptor. Idempotent; returns restore. */
export function installGuard(guard: Guard): () => void {
  const existing = installed.get(guard);
  if (existing !== undefined) return existing;
  const ax = guardedAxios();
  const previous = ax.defaults.adapter;
  ax.defaults.adapter = guard.adapter as any;
  // Request interceptors run newest first, so this one, added at start, sees the config last.
  const id = ax.interceptors.request.use((config: any) => {
    if (config.adapter !== guard.adapter) throw refusal(config.method, config.url, "transport");
    return config;
  });
  const restore = () => {
    if (installed.get(guard) !== restore) return;
    installed.delete(guard);
    ax.interceptors.request.eject(id);
    ax.defaults.adapter = previous;
  };
  installed.set(guard, restore);
  return restore;
}
