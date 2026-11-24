// Sanctuary Computer (quickbooks-mcp-293): write mode's own QuickBooks requests (spec A2.1, A2.16), through the guarded axios instance, so
// 291's guard decides each one and 286's interceptors give a GET its one 401 and one 429 resend. Nothing is cached.
import { currentCall } from "../clients/call-context.js";
import { QBO_HOST } from "../clients/guard-decide.js";
import { guardedAxios } from "../http-guard.js";

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

/** One GET with the call's token, to the call's realm. Rejects when there is no HTTP answer (a refusal, a failed connection). */
async function get(urlFor: (realm: string) => string): Promise<Answer> {
  const call = currentCall();
  if (call?.token === undefined || call.realm === undefined) throw new Error("write client: no call with a token");
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
