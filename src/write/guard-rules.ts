// Sanctuary Computer (quickbooks-mcp-293): write mode's guard rules, contract 1.1 §16 (docs/contracts/quickbooks.md in Stacksbot):
// the by-id fetch and the one update a capability allows. Pure: no network, no state. 291's `decide` answers what isn't matched here.
import { decide, type Decision, type GuardContext, type GuardRequest } from "../clients/guard-decide.js";
import { sha256Hex } from "./canonical.js";

/** Capabilities by company, entity path and body hash. `take` checks and consumes in one step; only its `true` allows. */
export type CapabilityRegistry = { has(company: string, entity: string, sha: string): boolean; take(company: string, entity: string, sha: string): boolean };
export type WriteAllowRule = "entity-by-id-write" | "write-update";
export type WriteRefuseRule = WriteAllowRule | "reports" | "body" | "credential-crossing" | "guard-error";
/** 291's shape: `text` is the URL as given and `url` what is sent. A matched form is exact, so they are the same. */
export type WriteDecision = { allow: true; rule: WriteAllowRule; text: string; url: string } | { allow: false; rule: WriteRefuseRule };
export type Unmatched = { match: false };
type Dry<D> = D extends { allow: infer A } ? { answer: A extends true ? "allow" : "refuse" } & Omit<D, "allow"> : never;
/** No `allow` key, so no caller can take it for a decision. `allowed-with-capability`: an update whose every condition but the capability holds. */
export type DryDecision = Dry<Decision | WriteDecision> | { answer: "allowed-with-capability"; rule: "write-update"; text: string; url: string };

type Company = () => string | undefined;
type Capability = { company: string; entity: string; sha: string; text: string };

// The whole URL as given, compared raw: no `new URL`, which drops a written `:443`, resolves dot segments and strips tabs.
const BY_ID = /^https:\/\/quickbooks\.api\.intuit\.com\/v3\/company\/([0-9]{1,20})\/(?:purchase|bill|account|class)\/[0-9]{1,20}\?minorversion=75$/;
const UPDATE =
  /^https:\/\/quickbooks\.api\.intuit\.com\/v3\/company\/([0-9]{1,20})\/(purchase|bill)\?(?:operation=update&minorversion=75|minorversion=75&operation=update)$/;

const refuse = (rule: WriteRefuseRule): { allow: false; rule: WriteRefuseRule } => ({ allow: false, rule });

/** Each field read once, so every rule judges the same request. */
const snapshot = ({ method, url, params, headers, data }: GuardRequest): GuardRequest => ({ method, url, params, headers, data });

/** Any own `X-Api-Key`, in any case, as axios trims a name. Absent headers are none, as 291 reads them; any others that aren't a plain object throw. */
function hasApiKey(headers: unknown): boolean {
  if (headers === undefined || headers === null) return false;
  if (typeof headers !== "object") throw new TypeError("headers");
  const proto = Object.getPrototypeOf(headers);
  if (proto !== Object.prototype && proto !== null) throw new TypeError("headers");
  return Object.getOwnPropertyNames(headers).some((name) => name.trim().toLowerCase() === "x-api-key");
}

const inCall = (context: GuardContext): boolean => Array.isArray((context.callRecord() as { queries?: unknown } | null | undefined)?.queries);

function judgeById(req: GuardRequest, text: string, realm: string, context: GuardContext): WriteDecision {
  if (!inCall(context) || context.allowedRealm(realm) !== true) return refuse("entity-by-id-write");
  if (hasApiKey(req.headers)) return refuse("credential-crossing");
  if (req.data !== undefined && req.data !== null && req.data !== "") return refuse("body");
  return { allow: true, rule: "entity-by-id-write", text, url: text };
}

/** Every condition of an update but its capability, which is returned for the caller to take. */
function judgeUpdate(req: GuardRequest, context: GuardContext, companyOf: Company): WriteDecision | { needs: Capability } {
  const { url, data } = req;
  if (typeof url !== "string") return refuse("guard-error");
  const form = UPDATE.exec(url);
  if (form === null || !inCall(context)) return refuse("write-update");
  const company = companyOf();
  if (typeof company !== "string" || company === "") return refuse("write-update");
  if (context.allowedRealm(form[1]) !== true) return refuse("write-update");
  if (hasApiKey(req.headers)) return refuse("credential-crossing");
  if (typeof data !== "string") return refuse("write-update");
  const body: unknown = JSON.parse(data); // not JSON throws: guard-error
  if (typeof body !== "object" || body === null || Array.isArray(body)) return refuse("write-update");
  const { Id, SyncToken, sparse } = body as Record<string, unknown>;
  if (typeof Id !== "string" || typeof SyncToken !== "string" || sparse !== true) return refuse("write-update");
  return { needs: { company, entity: form[2], sha: sha256Hex(data), text: url } };
}

function judge(req: GuardRequest, context: GuardContext, companyOf: Company): Unmatched | WriteDecision | { needs: Capability } {
  const { method, url, params } = req;
  const bare = params === undefined || params === null;
  if (bare && typeof method === "string" && /^POST$/i.test(method)) return judgeUpdate(req, context, companyOf);
  if (bare && typeof method === "string" && /^GET$/i.test(method) && typeof url === "string") {
    const form = BY_ID.exec(url);
    if (form !== null) return judgeById(req, url, form[1], context);
  }
  const kept = decide(req, context);
  return kept.allow && kept.rule === "reports" ? refuse("reports") : { match: false };
}

/** Write mode's decision, or `{ match: false }` for a request that 291's `decide` answers. An allowed update has consumed its capability. */
export function decideWrite(request: GuardRequest, context: GuardContext, deps: { company: Company; registry: CapabilityRegistry }): Unmatched | WriteDecision {
  try {
    const judged = judge(snapshot(request), context, deps.company);
    if (!("needs" in judged)) return judged;
    const { company, entity, sha, text } = judged.needs;
    // Last of all: nothing after this refuses.
    if (deps.registry.take(company, entity, sha) !== true) return refuse("write-update");
    return { allow: true, rule: "write-update", text, url: text };
  } catch {
    return refuse("guard-error");
  }
}

function asDry(decision: Decision | WriteDecision): DryDecision {
  const { allow, ...rest } = decision;
  return { answer: allow ? "allow" : "refuse", ...rest } as DryDecision;
}

/** What write mode would decide, 291's answers included, on the same request. It has no registry, so it registers and consumes nothing. */
export function decideDry(request: GuardRequest, context: GuardContext, deps: { company: Company }): DryDecision {
  try {
    const req = snapshot(request);
    const judged = judge(req, context, deps.company);
    if (!("needs" in judged)) return asDry("match" in judged ? decide(req, context) : judged);
    const { text } = judged.needs;
    return { answer: "allowed-with-capability", rule: "write-update", text, url: text };
  } catch {
    return asDry(refuse("guard-error"));
  }
}
