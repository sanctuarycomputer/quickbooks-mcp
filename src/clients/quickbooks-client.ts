// Changed by Sanctuary Computer (quickbooks-mcp-285, quickbooks-mcp-286): the sign-in flow, token store and refresh are
// removed; the client is built for one tool call from that call's token and realm (A3.3), never from process state.
import QuickBooks from "node-quickbooks";
import { currentCall } from "./call-context.js";

export class QuickbooksClient {
  /**
   * A node-quickbooks client for the current tool call. node-quickbooks reads `token` and `realmId` when it sends each
   * request, so both read the call's store then: after a 401 resend has replaced the call's token, the next request
   * carries the new one (T6-4). It holds no client id, secret or refresh token. Outside a call it throws.
   */
  static async getInstance(): Promise<QuickBooks> {
    const call = currentCall();
    if (call === undefined) throw new Error("getInstance outside a tool call");
    // OAuth 2.0 with a bearer token only: no consumer key or secret, no token secret, production, no debug output.
    const qb = new QuickBooks("", "", "", false, "", false, false, null, "2.0");
    Object.defineProperties(qb, {
      token: { get: () => call.token, enumerable: true },
      realmId: { get: () => call.realm, enumerable: true },
    });
    return qb;
  }
}
