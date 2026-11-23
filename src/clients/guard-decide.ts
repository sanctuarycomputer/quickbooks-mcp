// Sanctuary Computer (quickbooks-mcp-291): the guard's decision, contract 1.0 §6 (docs/contracts/quickbooks.md@1.0 in Stacksbot) plus the own rules.
// Pure: no network module, no axios. The adapter (src/http-guard.ts) and the probe (src/guard-probe.ts) share it.

export type GuardRequest = { method?: string; url?: string; params?: unknown; headers?: Record<string, unknown>; data?: unknown };
/** One tool call's QuickBooks query requests, in order; the adapter appends and sets each `status`. Resends are derived from it. */
export type CallRecord = { queries: Array<{ entity: string; url: string; status: number | null }> };
export type GuardContext = {
  stacksUrl: string | undefined;
  keys: () => string[];
  allowedRealm: (realm: string) => boolean;
  callRecord: () => CallRecord | undefined;
};
export type AllowRule = "companyinfo" | "preferences" | "query" | "reports" | "stacks";
export type RefuseRule =
  | "raw-text"
  | "entity-by-id"
  | "query"
  | "reports"
  | "quickbooks"
  | "stacks"
  | "dot-segments"
  | "refused"
  | "stacks-config"
  | "body"
  | "credential-crossing"
  | "guard-error";
/** `text` is the URL as composed (what axios' getUri returns); `url` is `new URL(text).href`, what is sent. */
export type Decision =
  | { allow: true; rule: AllowRule; text: string; url: string; entity?: string; resend?: 401 | 429 }
  | { allow: false; rule: RefuseRule };

export const QBO_HOST = "quickbooks.api.intuit.com";
const QBO_HEAD = `https://${QBO_HOST}/`;
const STACKS_PATH = "/api/qbo/access_token";

/** Contract 1.0 §6 Report query keys. */
export const REPORT_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  AgedPayables: Object.freeze(["aging_method", "days_per_aging_period", "num_periods", "report_date", "vendor"]),
  AgedReceivables: Object.freeze(["aging_method", "customer", "days_per_aging_period", "num_periods", "report_date"]),
  BalanceSheet: Object.freeze(["accounting_method", "end_date", "start_date", "summarize_column_by"]),
  CashFlow: Object.freeze(["end_date", "start_date", "summarize_column_by"]),
  CustomerBalance: Object.freeze(["customer", "report_date", "summarize_column_by"]),
  CustomerSales: Object.freeze(["customer", "end_date", "start_date", "summarize_column_by"]),
  GeneralLedger: Object.freeze(["account", "accounting_method", "end_date", "sort_by", "source_account", "start_date"]),
  ProfitAndLoss: Object.freeze([
    "accounting_method",
    "class",
    "customer",
    "department",
    "end_date",
    "item",
    "start_date",
    "summarize_column_by",
    "vendor",
  ]),
  TrialBalance: Object.freeze(["accounting_method", "end_date", "start_date"]),
  VendorBalance: Object.freeze(["report_date", "summarize_column_by", "vendor"]),
  VendorExpenses: Object.freeze(["accounting_method", "end_date", "start_date", "summarize_column_by", "vendor"]),
});

export function newCallRecord(): CallRecord {
  return { queries: [] };
}

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const refuse = (rule: RefuseRule): Decision => ({ allow: false, rule });

class GuardError extends Error {}

// ---- composing the text as axios' getUri does (url, no baseURL, then params with the default serialiser) ----

/** axios' default `buildURL` encoder (axios 1.21.1, dist/node/axios.cjs:2069-2071). */
function axiosEncode(value: string): string {
  return encodeURIComponent(value).replace(/%3A/gi, ":").replace(/%24/g, "$").replace(/%2C/gi, ",").replace(/%20/g, "+");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object") return false; // callers rule out null first
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function compose(url: string, params: unknown): string {
  if (params === undefined || params === null) return url;
  if (!isPlainObject(params)) throw new GuardError("params");
  const pairs: string[] = [];
  for (const key of Object.keys(params)) {
    // axios trims each key and drops an own `__proto__`, `constructor` or `prototype` (axios.cjs:48, 2002): such a key would not compose as getUri does.
    if (key !== key.trim() || key === "__proto__" || key === "constructor" || key === "prototype") throw new GuardError("param key");
    const value = params[key];
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new GuardError("param value");
    pairs.push(axiosEncode(key) + "=" + axiosEncode(String(value)));
  }
  const serialized = pairs.join("&");
  if (serialized === "") return url;
  const hash = url.indexOf("#");
  const base = hash === -1 ? url : url.slice(0, hash);
  return base + (base.indexOf("?") === -1 ? "?" : "&") + serialized;
}

// ---- raw text (step 3) and dot segments (step 4) ----

/** Any C0 control character (TAB, CR, LF included) or DEL. */
function hasControl(t: string): boolean {
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}
/** `<scheme>://<authority>`: the head the raw path follows; the authority stops at `/`, `?`, `#` or `\`. */
const HEAD = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\\]*/;

/** Contract §6 at 66cd209c: a literal space only inside the value of a pair whose key is exactly `query`. */
function rawTextOk(t: string): boolean {
  // A leading space is a space before `?`, refused below; a trailing one is refused here (new URL would strip it).
  if (hasControl(t) || t.includes("#") || t.endsWith(" ")) return false;
  const q = t.indexOf("?");
  const before = q === -1 ? t : t.slice(0, q);
  if (before.includes(" ")) return false;
  // With no `?`, t.slice(0) is `before`, which has no space: the loop allows it.
  for (const pair of t.slice(q + 1).split("&")) {
    if (!pair.includes(" ")) continue;
    const eq = pair.indexOf("=");
    if (eq === -1 || pair.slice(0, eq) !== "query") return false;
  }
  return true;
}

/** The path as given (after the authority, up to `?`): no `\`, no `%2e` in any case, no `.` or `..` segment. */
function dotSegments(t: string): boolean {
  const head = HEAD.exec(t);
  if (head === null) return false; // a malformed head is refused whole at step 5b (or as another host)
  const rest = t.slice(head[0].length);
  const q = rest.indexOf("?");
  const p = q === -1 ? rest : rest.slice(0, q);
  if (p.includes("\\") || /%2e/i.test(p)) return true;
  return p.split("/").some((s) => s === "." || s === "..");
}

// ---- STACKS_QBO_URL (contract §3) ----

type Stacks = { kind: "none" } | { kind: "unusable" } | { kind: "parsed"; url: URL; ok: boolean };

function readStacks(stacksUrl: string | undefined): Stacks {
  if (stacksUrl === undefined) return { kind: "none" };
  let url: URL;
  try {
    url = new URL(stacksUrl);
  } catch {
    return { kind: "unusable" };
  }
  const ok = url.protocol === "https:" && url.username === "" && url.password === "" && url.pathname === "/" && !stacksUrl.includes("?") && !stacksUrl.includes("#");
  return { kind: "parsed", url, ok };
}

// ---- query keys ----

/** Decoded entries; an empty `&&` pair is no key. Duplicate names (after decoding) refuse. */
function entries(w: URL): Array<[string, string]> | null {
  const list = [...w.searchParams];
  const seen = new Set<string>();
  for (const [k] of list) {
    if (seen.has(k)) return null;
    seen.add(k);
  }
  return list;
}

const WS = "[ \\t\\n\\v\\f\\r]";
const IS_WS = new RegExp(`^${WS}$`);
const STARTS_SELECT = new RegExp(`^select${WS}`, "i");
const ENDS_MAXRESULTS = new RegExp(`${WS}maxresults${WS}+(0|[1-9][0-9]*)$`, "i");
/** `\p{Zs}` other than U+0020, and U+0085, U+2028, U+2029 (contract §6 at 66cd209c; never JS `\s`). */
const SEPARATOR = /(?! )\p{Zs}|[\u0085\u2028\u2029]/u;
const FROM_WORD = /(?<![A-Za-z0-9_])from(?![A-Za-z0-9_])/gi;
const NON_ASCII_LETTER_OR_MARK = /^[\p{L}\p{M}]/u;

/** The entity a query statement reads, or null when the statement breaks the `query` rule. */
function queryEntity(statement: string): string | null {
  if (SEPARATOR.test(statement) || !STARTS_SELECT.test(statement)) return null;
  const end = ENDS_MAXRESULTS.exec(statement);
  if (end === null || Number(end[1]) > 1000) return null;
  const froms = [...statement.matchAll(FROM_WORD)];
  if (froms.length !== 1) return null;
  // The statement starts `select` and ends with digits, so `from` is never its first or last word: both neighbours exist.
  // After it, FROM_WORD's lookahead plus the empty-run check below refuse anything but whitespace.
  const at = froms[0].index as number;
  if (!IS_WS.test(statement[at - 1])) return null;
  let i = at + 4;
  while (IS_WS.test(statement[i])) i++;
  const run = /^[A-Za-z]*/.exec(statement.slice(i))![0];
  if (run === "" || NON_ASCII_LETTER_OR_MARK.test(statement.slice(i + run.length))) return null;
  return run.toLowerCase();
}

/** The per-call count: a first query for the entity, or one identical resend after its 401 or 429, at most one of each per call. */
function countQuery(record: CallRecord, entity: string, url: string): { ok: true; resend?: 401 | 429 } | { ok: false } {
  const resends = { 401: 0, 429: 0 };
  const last = new Map<string, { url: string; status: number | null }>();
  for (const q of record.queries) {
    const prev = last.get(q.entity);
    if (prev !== undefined && prev.url === q.url && (prev.status === 401 || prev.status === 429)) resends[prev.status]++;
    last.set(q.entity, q);
  }
  const prev = last.get(entity);
  if (prev === undefined) return { ok: true };
  if (prev.url !== url || (prev.status !== 401 && prev.status !== 429) || resends[prev.status] > 0) return { ok: false };
  return { ok: true, resend: prev.status };
}

// ---- headers and body ----

function hasHeader(headers: unknown, lower: string): boolean {
  if (headers === undefined || headers === null) return false;
  if (!isPlainObject(headers)) throw new GuardError("headers"); // a Map, pair array or class instance: not read, refused
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

const emptyBody = (data: unknown) => data === undefined || data === null || data === "";
const isGet = (method: string) => /^GET$/i.test(method);

// ---- the decision ----

const REALM_PATH = /^\/v3\/company\/([0-9]{1,20})\//;
const ENTITY_BY_ID = /^[A-Za-z]+\/[0-9]+$/;

function decideQuickbooks(req: GuardRequest, method: string, t: string, w: URL, ctx: GuardContext): Decision {
  const allow = (rule: AllowRule, extra: { entity?: string; resend?: 401 | 429 } = {}): Decision => ({ allow: true, rule, text: t, url: w.href, ...extra });
  if (!isGet(method)) return refuse("quickbooks");
  const record = ctx.callRecord();
  if (record === undefined) return refuse("quickbooks"); // outside a call
  if (!Array.isArray((record as { queries?: unknown } | null)?.queries)) throw new GuardError("call record"); // null, 0, or no queries array

  // Which form's keys apply: the path's first word after the realm, and for reports the report's own keys.
  const realmMatch = REALM_PATH.exec(w.pathname);
  const rest = realmMatch === null ? "" : w.pathname.slice(realmMatch[0].length);
  const segments = rest.split("/");
  const allowed = new Set(["minorversion", "format"]);
  if (segments[0] === "query") allowed.add("query");
  if (segments[0] === "reports" && segments.length === 2 && own(REPORT_KEYS, segments[1])) {
    for (const k of REPORT_KEYS[segments[1]]) allowed.add(k);
  }
  const list = entries(w);
  if (list === null) return refuse("quickbooks");
  const values = new Map(list);
  for (const [k] of list) if (!allowed.has(k)) return refuse("quickbooks");
  if (values.get("minorversion") !== "75") return refuse("quickbooks");
  if (values.has("format") && values.get("format") !== "json") return refuse("quickbooks");

  if (hasHeader(req.headers, "x-api-key")) return refuse("credential-crossing");
  if (!emptyBody(req.data)) return refuse("body");

  if (realmMatch === null || ctx.allowedRealm(realmMatch[1]) !== true) return refuse("quickbooks");
  const realm = realmMatch[1];
  if (rest === `companyinfo/${realm}`) return allow("companyinfo");
  if (rest === "preferences") return allow("preferences");
  if (rest === "query") {
    const statement = values.get("query");
    const entity = statement === undefined ? null : queryEntity(statement);
    if (entity === null) return refuse("query");
    const counted = countQuery(record, entity, w.href);
    if (!counted.ok) return refuse("query");
    return allow("query", counted.resend === undefined ? { entity } : { entity, resend: counted.resend });
  }
  if (rest.startsWith("reports/")) return own(REPORT_KEYS, rest.slice("reports/".length)) ? allow("reports") : refuse("reports");
  if (ENTITY_BY_ID.test(rest)) return refuse("entity-by-id");
  return refuse("refused");
}

function decideStacks(req: GuardRequest, method: string, t: string, w: URL, ctx: GuardContext): Decision {
  if (!isGet(method) || w.pathname !== STACKS_PATH) return refuse("stacks");
  const list = entries(w);
  if (list === null || list.length !== 1 || list[0][0] !== "enterprise") return refuse("stacks");
  const keys = ctx.keys();
  if (!Array.isArray(keys)) throw new GuardError("keys");
  if (!keys.includes(list[0][1])) return refuse("stacks");
  if (hasHeader(req.headers, "authorization")) return refuse("credential-crossing");
  if (!emptyBody(req.data)) return refuse("body");
  return { allow: true, rule: "stacks", text: t, url: w.href };
}

export function decide(req: GuardRequest, ctx: GuardContext): Decision {
  try {
    const { method, url } = req;
    if (typeof method !== "string" || typeof url !== "string") return refuse("guard-error");
    const t = compose(url, req.params);
    const w = new URL(t); // relative or unparsable throws: guard-error

    if (!rawTextOk(t)) return refuse("raw-text");
    if (dotSegments(t)) return refuse("dot-segments");

    // Step 5b: the head as given, compared whole, for the two allowed hosts.
    if (w.hostname === QBO_HOST) {
      if (!t.startsWith(QBO_HEAD)) return refuse("raw-text");
      return decideQuickbooks(req, method, t, w, ctx);
    }
    const stacks = readStacks(ctx.stacksUrl);
    if (stacks.kind === "none") return refuse("refused");
    if (stacks.kind === "unusable") return refuse("stacks-config"); // "" or not a URL: every non-QuickBooks host
    if (stacks.url.hostname !== w.hostname) return refuse("refused");
    if (!stacks.ok) return refuse("stacks-config");
    if (!t.startsWith(stacks.url.origin + "/")) return refuse("raw-text");
    return decideStacks(req, method, t, w, ctx);
  } catch {
    return refuse("guard-error");
  }
}
