// Sanctuary Computer (quickbooks-mcp-291): the HTTP guard on the CommonJS axios instance node-quickbooks calls (contract 1.0 §6 in Stacksbot's docs/contracts/quickbooks.md).
import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { createRequire, syncBuiltinESMExports } from "node:module";
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
      // Only a network URL prints: a `data:` or other opaque URL's "path" is its payload.
      if (["http:", "https:", "ws:", "wss:"].includes(u.protocol)) where = `${u.protocol}//${u.host}${u.pathname}`;
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

/**
 * Header names as axios will send them (AxiosHeaders → plain object). toJSON drops a header set to `false`, so a
 * caller can no longer suppress an axios default that way (`User-Agent: false`); node-quickbooks sets none to false.
 */
function headerObject(headers: unknown): Record<string, unknown> {
  // A fresh plain object of the entries, read once: decide and the wire see one snapshot, whatever toJSON returned.
  return Object.fromEntries(Object.entries(guardedAxios().AxiosHeaders.from(headers as any).toJSON() as object));
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
    // Each request field is read once: what decide saw is what is sent, ticketed and logged (an accessor can't flip it).
    let method: unknown;
    let url: unknown;
    try {
      method = config.method;
      url = config.url;
      const headers = headerObject(config.headers);
      const decision = decide({ method: method as string | undefined, url: url as string | undefined, params: config.params, headers, data: config.data }, holder.ctx!);
      if (!decision.allow) throw refusal(method, url, decision.rule);
      const ax = guardedAxios();
      if (ax.getUri(config) !== decision.text) throw refusal(method, url, "guard-error");
      send = {};
      for (const k of KEPT) if (k !== "method" && k !== "headers" && ownProp(config, k)) send[k] = config[k];
      send.method = method;
      send.headers = headers;
      send.url = decision.url;
      send.maxRedirects = 0;
      send.proxy = false;
      send.httpsAgent = AGENT;
      const w = new URL(decision.url);
      ticket = { method: String(method).toUpperCase(), hostname: w.hostname, port: w.port, path: w.pathname + w.search };
      httpAdapter = ax.getAdapter("http") as (c: any) => Promise<any>;
      if (decision.entity !== undefined) {
        const record = holder.ctx!.callRecord();
        if (record === undefined) throw new Error("no call record");
        entry = { entity: decision.entity, url: decision.url, status: null };
        record.queries.push(entry);
      }
    } catch (e) {
      if (e instanceof GuardRefusedError) throw e;
      throw refusal(method, url, "guard-error");
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

/** What a request names, for the log line of a refusal before axios has merged it: (url[, config]) or (config). */
function named(args: unknown[]): { method: unknown; url: unknown } {
  try {
    const cfg = (typeof args[0] === "string" ? args[1] : args[0]) as Record<string, unknown> | undefined;
    const url = typeof args[0] === "string" ? args[0] : cfg?.url;
    return { method: cfg?.method ?? "get", url };
  } catch {
    return { method: undefined, url: undefined };
  }
}

/**
 * Sets the guard as the CommonJS instance's adapter and guards that instance and every instance `create()` makes from a
 * guarded one; any other Axios context (a bare `new axios.Axios()`, an instance made before install) is refused, since
 * every request path, bound or not, goes through `Axios.prototype._request`. Idempotent; returns restore, and restores
 * must run in reverse order of install (an out-of-order restore throws and changes nothing).
 *
 * Guarding an instance adds the identity interceptor first, so under axios' (default) legacy order it runs last of
 * the request interceptors; a request asking for the other order is refused. The interceptor replaces the request's
 * transformRequest with one function of the guard's: it runs a private copy of the given transforms on the config
 * axios dispatches, then checks `adapter` there is a data property holding the guard and pins it (non-writable,
 * non-configurable), so nothing axios runs after it (a `method` getter, say) can change what adapter is read.
 *
 * This holds against request config. Code that holds the instance's interceptor manager (it could add an interceptor
 * whose runWhen or accessors fool the order, or simply eject or clear the guard's) is past it: that is the backstop's.
 */
export function installGuard(guard: Guard): () => void {
  const existing = installed.get(guard);
  if (existing !== undefined) return existing;
  const ax = guardedAxios();
  const previous = ax.defaults.adapter;
  const proto = (ax as any).Axios.prototype as { _request: (...a: unknown[]) => Promise<unknown> };
  const previousRequest = proto._request;
  let active = true;
  const managers = new WeakSet<object>();
  const ejects: Array<() => void> = [];

  const identity = (config: any) => {
    if (config.adapter !== guard.adapter) throw refusal(config.method, config.url, "transport");
    const transitional = config.transitional;
    if (transitional !== undefined && transitional !== null && transitional.legacyInterceptorReqResOrdering !== true) {
      throw refusal(config.method, config.url, "transport");
    }
    const given = config.transformRequest;
    const list: Array<(this: unknown, ...a: unknown[]) => unknown> = given === undefined || given === null ? [] : Array.isArray(given) ? [...given] : [given];
    const only = function qboGuardTransform(this: any, data: unknown, ...rest: unknown[]) {
      let out = data;
      for (const fn of list) out = fn.call(this, out, ...rest);
      try {
        const d = Object.getOwnPropertyDescriptor(this, "adapter");
        // An accessor has no value, so it fails this too.
        if (d === undefined || d.value !== guard.adapter) throw new Error("adapter");
        Object.defineProperty(this, "adapter", { value: guard.adapter, writable: false, configurable: false, enumerable: true });
      } catch {
        let method: unknown;
        let url: unknown;
        // Log what can be read: each field on its own, a throwing getter leaves only that one out.
        try {
          method = this.method;
        } catch {
          method = undefined;
        }
        try {
          url = this.url;
        } catch {
          url = undefined;
        }
        throw refusal(method, url, "transport");
      }
      return out;
    };
    config.transformRequest = Object.freeze([only]);
    return config;
  };

  const guardInstance = (instance: any) => {
    managers.add(instance.interceptors.request);
    const id = instance.interceptors.request.use(identity);
    ejects.push(() => instance.interceptors.request.eject(id));
    const made = instance.create;
    // create() copies the defaults but not the interceptors: guard each instance it makes, and that one's create too.
    instance.create = function qboGuardCreate(this: unknown, ...args: unknown[]) {
      return guardInstance((made as (...a: unknown[]) => unknown).apply(this, args));
    };
    ejects.push(() => {
      instance.create = made;
    });
    return instance;
  };

  ax.defaults.adapter = guard.adapter as any;
  guardInstance(ax);
  // An Axios context nobody guarded (`new axios.Axios(config)`, or an instance made before install) has no identity
  // interceptor: its requests are refused. `request` (also bound into each instance) and every alias call `_request`.
  const wrapper = function qboGuardRequest(this: any, ...args: unknown[]) {
    if (active && !managers.has(this?.interceptors?.request)) {
      const n = named(args);
      return Promise.reject(refusal(n.method, n.url, "transport"));
    }
    return previousRequest.apply(this, args);
  };
  proto._request = wrapper;

  const restore = () => {
    if (installed.get(guard) !== restore) return;
    if (proto._request !== wrapper) throw new Error("qbo-guard: restore out of order");
    installed.delete(guard);
    active = false;
    for (const undo of ejects.reverse()) undo();
    ax.defaults.adapter = previous;
    proto._request = previousRequest;
  };
  installed.set(guard, restore);
  return restore;
}

// ---- the backstop ----

/** Carried by every function the backstop put in place, so a start check can see it. */
export const BACKSTOP_MARK: unique symbol = Symbol.for("qbo-guard.backstop") as any;
/** This module's own wraps (the marker can be forged; this set can't). */
const ownWraps = new WeakSet<object>();

function mark<F extends object>(fn: F): F {
  Object.defineProperty(fn, BACKSTOP_MARK, { value: true });
  ownWraps.add(fn);
  return fn;
}

/**
 * A best-effort URL for the refusal line of a call the backstop could not read (only its host and path print), read as
 * Node would: options over the URL, `hostname` then `host` by truthiness.
 */
function describeTarget(protocol: string, args: unknown[]): string {
  const [first, second] = args;
  const isUrl = typeof first === "string" || first instanceof URL;
  const u = isUrl ? new URL(String(first)) : undefined;
  const raw = isUrl ? second : first;
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const host = String(o.hostname || o.host || u?.hostname || "");
  const portValue = o.port ?? u?.port;
  const port = portValue === undefined || portValue === "" ? "" : `:${String(portValue)}`;
  const path = typeof o.path === "string" ? o.path : u !== undefined ? u.pathname : "/";
  return `${u?.protocol ?? protocol}//${host}${port}${path}`;
}

/** What the wrapped https.request/get sends: the ticket fields, plus the few transport keys axios sets that Node reads. */
type Reading = Ticket & { send: Record<string, unknown> };

/**
 * Option keys a call may carry. `send`: copied to what Node gets. `unset`: allowed only while undefined (each would
 * change where or how the socket connects). Any other own key with a value refuses the call.
 */
const SEND_KEYS = ["family", "maxBodyLength", "timeout", "signal"] as const;
const READ_KEYS = ["protocol", "hostname", "host", "port", "path", "method", "headers", "agent", "insecureHTTPParser", "auth"] as const;
const UNSET_KEYS = ["createConnection", "lookup", "socketPath", "defaultPort", "localAddress", "servername", "setHost", "rejectUnauthorized", "ca", "checkServerIdentity"] as const;
const IGNORED_KEYS = ["agents", "beforeRedirect", "beforeRedirects", "http2Options"] as const; // axios' own; Node's https.request never reads them
const KNOWN = new Set<string>([...SEND_KEYS, ...READ_KEYS, ...UNSET_KEYS, ...IGNORED_KEYS]);

class Unreadable extends Error {}

/** Each own key read exactly once, as a data property (a getter could answer differently when Node reads it). */
function snapshot(o: object): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(o)) {
    if (typeof key !== "string") throw new Unreadable("symbol key");
    const desc = Object.getOwnPropertyDescriptor(o, key);
    if (desc === undefined) throw new Unreadable("no descriptor"); // a Proxy listing a key it does not hold
    if (!("value" in desc)) throw new Unreadable("accessor");
    out.set(key, desc.value);
  }
  return out;
}

const isOptionsObject = (v: unknown): v is object =>
  typeof v === "object" && v !== null && !(v instanceof URL) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/**
 * What Node gets for a read call: the compared values, always the guard's agent, the lenient parser off, and every
 * connection key set own and undefined (an own key shadows a polluted Object.prototype, as axios does for its keys).
 */
function nodeOptions(hostname: string, port: string, path: string, method: string): Record<string, unknown> {
  const send: Record<string, unknown> = { protocol: "https:", hostname, port: port === "" ? 443 : Number(port), path, method };
  for (const key of UNSET_KEYS) send[key] = undefined;
  send.insecureHTTPParser = false;
  send.agent = AGENT;
  return send;
}

/**
 * Reads a call to https.request/get as one of two forms: `(url[, callback])` with an https URL and no userinfo, or
 * `(options[, callback])` with a plain object. `(url, options)` and anything else are not read (refused). The returned
 * `send` is a fresh object of exactly the compared values, which is all Node gets.
 */
function requested(args: unknown[]): Reading {
  const callback = typeof args[args.length - 1] === "function" ? args[args.length - 1] : undefined;
  const rest = callback === undefined ? args : args.slice(0, -1);
  if (rest.length !== 1) throw new Unreadable("form");
  const [a] = rest;
  if (typeof a === "string" || a instanceof URL) {
    const u = new URL(String(a));
    if (u.protocol !== "https:" || u.username !== "" || u.password !== "") throw new Unreadable("url");
    const hostname = u.hostname; // an IPv6 host keeps its brackets, as the guard's ticket does (it allows no IPv6 host)
    const path = u.pathname + u.search;
    return { method: "GET", hostname, port: u.port, path, send: nodeOptions(hostname, u.port, path, "GET") };
  }
  if (!isOptionsObject(a)) throw new Unreadable("options");
  const o = snapshot(a);
  for (const [key, value] of o) {
    if (!KNOWN.has(key) && value !== undefined) throw new Unreadable(`key ${key}`);
  }
  for (const key of UNSET_KEYS) if (o.get(key) !== undefined) throw new Unreadable(`key ${key}`);
  const protocol = o.get("protocol");
  if (protocol !== undefined && protocol !== "https:") throw new Unreadable("protocol");
  if (o.get("auth") !== undefined && o.get("auth") !== null) throw new Unreadable("auth");
  if (o.get("insecureHTTPParser") !== undefined && o.get("insecureHTTPParser") !== false) throw new Unreadable("parser");
  const agent = o.get("agent");
  if (agent !== undefined && agent !== AGENT) throw new Unreadable("agent");
  const hostValue = o.get("hostname") ?? o.get("host");
  if (typeof hostValue !== "string" || hostValue === "") throw new Unreadable("hostname");
  const portValue = o.get("port");
  if (portValue !== undefined && portValue !== "" && typeof portValue !== "number" && typeof portValue !== "string") throw new Unreadable("port");
  const port = portValue === undefined || portValue === "" ? "" : String(portValue);
  const path = o.get("path") ?? "/";
  if (typeof path !== "string") throw new Unreadable("path");
  const methodValue = o.get("method") ?? "GET";
  if (typeof methodValue !== "string") throw new Unreadable("method");
  const method = methodValue.toUpperCase();
  const headersValue = o.get("headers");
  let headers: Record<string, unknown> | undefined;
  if (headersValue !== undefined) {
    if (!isOptionsObject(headersValue)) throw new Unreadable("headers");
    headers = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of snapshot(headersValue)) {
      if (k.toLowerCase() === "host") throw new Unreadable("host header"); // the Host Node sends is the ticket's hostname
      headers[k] = v;
    }
  }
  const send = nodeOptions(hostValue, port, path, method);
  if (headers !== undefined) send.headers = headers;
  for (const key of SEND_KEYS) if (o.get(key) !== undefined) send[key] = o.get(key);
  return { method, hostname: hostValue, port, path, send };
}

/** https.request/get: only under an unused ticket whose every field equals the call's; Node gets the compared reading. */
function wrapHttps(original: (...args: any[]) => any): (...args: any[]) => any {
  return mark(function qboGuardHttps(this: unknown, ...args: any[]) {
    let reading: Reading | undefined;
    let allowed = false;
    try {
      const ticket = currentTicket();
      reading = requested(args);
      allowed =
        ticket !== undefined &&
        !ticket.used &&
        ticket.method === reading.method &&
        ticket.hostname === reading.hostname &&
        ticket.port === reading.port &&
        ticket.path === reading.path;
      if (allowed) ticket!.used = true;
    } catch {
      allowed = false;
    }
    if (!allowed || reading === undefined) throw backstopRefusal("https:", args, reading);
    const callback = typeof args[args.length - 1] === "function" ? [args[args.length - 1]] : [];
    return original.call(this, reading.send, ...callback);
  });
}

/** Logs and returns the backstop's refusal; describing the call never throws past here. */
function backstopRefusal(protocol: string, args: unknown[], reading?: Reading): GuardRefusedError {
  let method = "OTHER";
  let target = "";
  try {
    if (reading !== undefined) {
      method = reading.method;
      const joined = `https://${reading.hostname}${reading.port === "" ? "" : `:${reading.port}`}${reading.path}`;
      // Print it only if it parses back to the host that was read (an `@` in the port or host would move it).
      target = new URL(joined).hostname === reading.hostname ? joined : "";
    } else {
      target = describeTarget(protocol, args);
      // The method a call names in its options object (first or second argument), else GET for a bare URL.
      const objects = args.slice(0, 2).filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null && !(x instanceof URL));
      const named = objects.map((x) => x.method).find((m) => typeof m === "string");
      // Node's default method is GET, for a bare URL and for an options object that names none.
      method = typeof named === "string" ? named : objects.length > 0 || typeof args[0] === "string" || args[0] instanceof URL ? "GET" : "OTHER";
    }
  } catch {
    // keep OTHER <unparsable url>
  }
  return refusal(method, target, "backstop");
}

/** A function that always refuses, for fetch, WebSocket, http.request/get and http2.connect. */
function refuseAlways(protocol: string) {
  return mark(function qboGuardRefuse(...args: unknown[]): never {
    throw backstopRefusal(protocol, args);
  });
}

type Replacement = { target: object; key: string; make: (current: unknown) => object };

/**
 * Replaces fetch, WebSocket, http.request/get and http2.connect with refusals and wraps https.request/get,
 * then syncs the ESM named exports. Idempotent per property; all or nothing: if one can't be replaced, every
 * replacement made is put back and it throws `qbo-guard: install failed`. Returns restore.
 */
export function installBackstop(deps?: { modules?: { http: object; https: object; http2: object }; global?: object }): () => void {
  const mods = deps?.modules ?? { http, https, http2 };
  const g = deps?.global ?? globalThis;
  const plan: Replacement[] = [
    { target: g, key: "fetch", make: () => refuseAlways("https:") },
    { target: g, key: "WebSocket", make: () => refuseAlways("wss:") },
    { target: mods.http, key: "request", make: () => refuseAlways("http:") },
    { target: mods.http, key: "get", make: () => refuseAlways("http:") },
    { target: mods.http2, key: "connect", make: () => refuseAlways("https:") },
    { target: mods.https, key: "get", make: (cur) => wrapHttps(cur as (...args: any[]) => any) },
    { target: mods.https, key: "request", make: (cur) => wrapHttps(cur as (...args: any[]) => any) },
  ];
  const done: Array<{ target: object; key: string; desc: PropertyDescriptor | undefined }> = [];
  const undo = () => {
    for (const { target, key, desc } of done.reverse()) {
      if (desc === undefined) delete (target as Record<string, unknown>)[key];
      else if (desc.configurable) Object.defineProperty(target, key, desc);
      else (target as Record<string, unknown>)[key] = desc.value; // writable, not configurable: it was replaced by assignment
    }
    done.length = 0;
  };
  try {
    for (const { target, key, make } of plan) {
      const t = target as Record<string, unknown>;
      const current = t[key];
      if (ownWraps.has(current as object)) continue;
      const desc = Object.getOwnPropertyDescriptor(target, key);
      const fn = make(current);
      if (desc === undefined || desc.configurable) {
        Object.defineProperty(target, key, { value: fn, writable: true, configurable: true, enumerable: desc?.enumerable ?? true });
      } else if (desc.writable) {
        t[key] = fn; // a data property that can be written but not redefined
      } else {
        throw new Error("not replaceable"); // neither writable nor configurable (or a fixed accessor)
      }
      done.push({ target, key, desc });
    }
    syncBuiltinESMExports();
  } catch {
    undo();
    // No sync here: every replacement is undone before the one sync at the end of the try ever ran.
    throw new Error("qbo-guard: install failed");
  }
  const restore = () => {
    undo();
    syncBuiltinESMExports();
  };
  return restore;
}

// ---- start ----

const has = (env: NodeJS.ProcessEnv, key: string) => Object.prototype.hasOwnProperty.call(env, key);

/** Node splits NODE_OPTIONS on whitespace and drops quotes around a token. */
/**
 * NODE_OPTIONS split as Node splits it: whitespace outside double quotes ends a token, quotes are dropped wherever they
 * stand, and inside quotes a backslash takes the next character literally.
 */
function nodeOptionTokens(value: string | undefined): string[] {
  // An empty token (`""`) names no option, so it is dropped.
  const tokens: string[] = [];
  let token = "";
  let quoted = false;
  const text = value ?? "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === "\\" && i + 1 < text.length) {
      token += text[++i];
    } else if (c === '"') {
      quoted = !quoted;
    } else if (!quoted && /\s/.test(c)) {
      tokens.push(token);
      token = "";
    } else {
      token += c;
    }
  }
  tokens.push(token);
  return tokens.filter((t) => t !== "");
}

/** An option's name as Node matches it: the part before `=`, with `_` and `-` the same after the leading `--`. */
function optionName(token: string): string | undefined {
  if (!token.startsWith("--")) return undefined;
  const eq = token.indexOf("=");
  return "--" + (eq === -1 ? token.slice(2) : token.slice(2, eq)).replace(/_/g, "-");
}

/**
 * Options that turn on Node's env proxy for https.globalAgent: the flag in any spelling or with any value, and the
 * config-file flags, since a config file can set it (`nodeOptions: { "use-env-proxy": true }`).
 */
const PROXY_OPTIONS = ["--use-env-proxy", "--experimental-config-file", "--experimental-default-config-file"];

/** Contract §3's transport refusals. Pure: reads only its arguments, and names a key, never a value. */
export function checkStartEnv(env: NodeJS.ProcessEnv, execArgv: readonly string[]): { ok: true } | { ok: false; key: string } {
  if (has(env, "NODE_USE_ENV_PROXY")) return { ok: false, key: "NODE_USE_ENV_PROXY" };
  const names = [...execArgv, ...nodeOptionTokens(env.NODE_OPTIONS)].map(optionName);
  for (const option of PROXY_OPTIONS) if (names.includes(option)) return { ok: false, key: option };
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") return { ok: false, key: "NODE_TLS_REJECT_UNAUTHORIZED" };
  if (has(env, "NODE_EXTRA_CA_CERTS")) return { ok: false, key: "NODE_EXTRA_CA_CERTS" };
  return { ok: true };
}

/**
 * Refuses an unsafe environment, then installs the guard on the CommonJS instance, then the backstop.
 * All or nothing: any throw while installing puts back what was installed and throws `qbo-guard: install failed`.
 * Returns a restore of both (for tests; the entry ignores it).
 */
export function secureStart(env: NodeJS.ProcessEnv, execArgv: readonly string[], deps?: { resolveAxios?: () => unknown }): () => void {
  const check = checkStartEnv(env, execArgv);
  if (!check.ok) throw new Error(`qbo-guard: start refused: ${check.key}`);
  if (holder.scope !== undefined) throw new Error("qbo-guard: install failed"); // a second start would add a second interceptor
  let restoreGuard: (() => void) | undefined;
  const previousCtx = holder.ctx;
  try {
    const ax = (deps?.resolveAxios ?? guardedAxios)() as Partial<AxiosStatic> | undefined;
    if (typeof ax?.getAdapter !== "function" || typeof ax.getUri !== "function") throw new Error("axios");
    const scope = createCallScope();
    const guard = createGuard({
      stacksUrl: env.STACKS_QBO_URL,
      keys: () => [],
      allowedRealm: (realm) => scope.allowedRealm(realm),
      callRecord: () => scope.callRecord(),
    });
    const guardRestore = installGuard(guard);
    restoreGuard = guardRestore;
    const restoreBackstop = installBackstop();
    holder.scope = scope;
    return () => {
      restoreBackstop();
      guardRestore();
      holder.scope = undefined;
    };
  } catch {
    restoreGuard?.();
    holder.ctx = previousCtx;
    throw new Error("qbo-guard: install failed");
  }
}
