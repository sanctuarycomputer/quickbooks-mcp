// Changed by Sanctuary Computer (quickbooks-mcp-285): the sign-in flow, token store and refresh are removed; no token source until the Stacks token client.
import type QuickBooks from "node-quickbooks";

export class QuickbooksClient {
  static async getInstance(): Promise<QuickBooks> {
    throw new Error("no QuickBooks token source");
  }
}
