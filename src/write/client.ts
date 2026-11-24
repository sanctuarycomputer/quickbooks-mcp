// Sanctuary Computer (quickbooks-mcp-293): write mode's own QuickBooks requests (spec A2.1, A2.16), through the guarded axios instance, so
// 291's guard decides each one and 286's interceptors give a GET its one 401 and one 429 resend. Nothing is cached. The update is sent
// once, whatever comes of it: those interceptors resend no POST.
import { currentCall, type CallStore } from "../clients/call-context.js";
import { QBO_HOST } from "../clients/guard-decide.js";
import { QBO_LIMIT_MS } from "../clients/qbo-transport.js";
import { guardedAxios } from "../http-guard.js";
import { isChecked, type CheckedRequest } from "./pre-send.js";

/** The one minor version, on every fetch and the update. */
export const MINOR_VERSION = "75";

export type UpdateEntity = "purchase" | "bill";
export type FetchEntity = UpdateEntity | "account" | "class";
/** An HTTP answer, whatever its status. */
export type Answer = { status: number; data: unknown };

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

/** One GET with the call's token, to the call's realm. Rejects when there is no HTTP answer (a refusal, a failed connection). */
async function get(urlFor: (realm: string) => string): Promise<Answer> {
  const call = callWithToken();
  try {
    const { status, data } = await guardedAxios().get(urlFor(call.realm), { headers: { Authorization: `Bearer ${call.token}`, Accept: "application/json" } });
    return { status, data };
  } catch (e) {
    const { response } = e as { response?: Answer };
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

/**
 * Sends a checked request's exact text once, for the call it was checked in; its capability must be registered. Answers any whole HTTP
 * answer as it came; rejects when there is none (a refusal, a timeout, a reset, in the answer's body too) with the error as it came.
 */
export async function sendUpdate(checked: CheckedRequest): Promise<Answer> {
  if (!isChecked(checked)) throw new Error("write client: not a checked request");
  if (checked.mode === "dry") throw new Error("write client: a dry request");
  const call = callWithToken();
  if (call.company !== checked.company) throw new Error("write client: another company's call");
  try {
    const { status, data } = await guardedAxios().post(updateUrl(call.realm, checked.entity), checked.bodyText, {
      headers: { Authorization: `Bearer ${call.token}`, "Content-Type": "application/json", Accept: "application/json" },
      timeout: QBO_LIMIT_MS,
      transformRequest: [(text: unknown) => text],
    });
    return { status, data };
  } catch (e) {
    const { response } = e as { response?: Answer };
    // axios gives an answer cut off in its body a response with no data; a whole one's is at least "".
    if (response?.data === undefined) throw e;
    return { status: response.status, data: response.data };
  }
}
