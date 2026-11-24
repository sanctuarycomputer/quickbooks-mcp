// Sanctuary Computer (quickbooks-mcp-293): write mode's own QuickBooks requests (spec A2.1, A2.16), through the guarded axios instance, so
// 291's guard decides each one and 286's interceptors give a GET its one 401 and one 429 resend. Nothing is cached. The update is sent
// once, whatever comes of it: those interceptors resend no POST.
import { currentCall, type CallStore } from "../clients/call-context.js";
import { QBO_HOST } from "../clients/guard-decide.js";
import { QBO_LIMIT_MS } from "../clients/qbo-transport.js";
import { guardedAxios } from "../http-guard.js";
// pre-send.ts imports this module too, which holds only while neither uses the other as it loads.
import { isChecked, type CheckedRequest } from "./pre-send.js";

/** The one minor version, on every fetch and the update. */
export const MINOR_VERSION = "75";

export type UpdateEntity = "purchase" | "bill";
export type FetchEntity = UpdateEntity | "account" | "class";
/** An HTTP answer, whatever its status. */
export type Answer = { status: number; data: unknown };
/** `intuit_tid` is the answer's header, absent when there is none that 286 would keep. */
export type UpdateAnswer = Answer & { intuit_tid?: string };

const company = (realm: string): string => `https://${QBO_HOST}/v3/company/${realm}`;

export function byIdUrl(realm: string, entity: FetchEntity, id: string): string {
  return `${company(realm)}/${entity}/${id}?minorversion=${MINOR_VERSION}`;
}

export function updateUrl(realm: string, entity: UpdateEntity): string {
  return `${company(realm)}/${entity}?operation=update&minorversion=${MINOR_VERSION}`;
}

/** The current call, its token and realm known. */
function callWithToken(): CallStore & { token: string; realm: string } {
  const call = currentCall();
  if (call?.token === undefined || call.realm === undefined) throw new Error("write client: no call with a token");
  return call as CallStore & { token: string; realm: string };
}

/** A body as axios parses it by default, whatever the instance's defaults: its JSON, else its text (undefined when it was cut off). */
function parsed(text: unknown): unknown {
  try {
    return JSON.parse(text as string);
  } catch {
    return text;
  }
}

/** One GET with the call's token, to the call's realm. Rejects when there is no HTTP answer (a refusal, a failed connection). */
async function get(urlFor: (realm: string) => string): Promise<Answer> {
  const call = callWithToken();
  try {
    const { status, data } = await guardedAxios().get(urlFor(call.realm), {
      headers: { Authorization: `Bearer ${call.token}`, Accept: "application/json" },
      responseType: "json",
      transformResponse: [parsed],
    });
    return { status, data };
  } catch (e) {
    const response = (e as { response?: Answer } | null | undefined)?.response;
    if (response === undefined) throw e;
    return { status: response.status, data: response.data };
  }
}

export function fetchById(entity: FetchEntity, id: string): Promise<Answer> {
  return get((realm) => byIdUrl(realm, entity, id));
}

export function fetchPreferences(): Promise<Answer> {
  return get((realm) => `${company(realm)}/preferences?minorversion=${MINOR_VERSION}`);
}

/** The answer's `intuit_tid` as 286 reads it (qbo-transport.ts): the name in any case, its form, and none that holds a token of the call's. */
function intuitTid(headers: unknown, held: readonly string[]): { intuit_tid?: string } {
  const tid: unknown = Object.entries(Object(headers)).find(([name]) => name.toLowerCase() === "intuit_tid")?.[1];
  if (typeof tid !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(tid) || held.some((token) => token !== "" && tid.includes(token))) return {};
  return { intuit_tid: tid };
}

/**
 * Sends a checked request's exact text once, for the call it was checked in; its capability must be registered. Answers any whole HTTP
 * answer as it came; rejects when there is none (a refusal, a timeout, a reset, in the answer's body too) with the error as it came.
 * That error's `config` holds the token and the whole body, and its `toJSON()` gives them: never log or serialize it whole, read its `code`
 * and `message` only.
 */
export async function sendUpdate(checked: CheckedRequest): Promise<UpdateAnswer> {
  if (!isChecked(checked)) throw new Error("write client: not a checked request");
  if (checked.mode === "dry") throw new Error("write client: a dry request");
  const call = callWithToken();
  if (call.company !== checked.company) throw new Error("write client: another company's call");
  try {
    const { status, data, headers } = await guardedAxios().post(updateUrl(call.realm, checked.entity), checked.bodyText, {
      headers: { Authorization: `Bearer ${call.token}`, "Content-Type": "application/json", Accept: "application/json" },
      timeout: QBO_LIMIT_MS,
      transformRequest: [(text: unknown) => text],
      responseType: "json",
      transformResponse: [parsed],
    });
    return { status, data, ...intuitTid(headers, call.held) };
  } catch (e) {
    const response = (e as { response?: Answer & { headers: unknown } } | null | undefined)?.response;
    // axios gives an answer cut off in its body a response with no data; a whole one's is at least "".
    if (response?.data === undefined) throw e;
    return { status: response.status, data: response.data, ...intuitTid(response.headers, call.held) };
  }
}
