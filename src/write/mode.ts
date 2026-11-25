// Sanctuary Computer (quickbooks-mcp-293): write mode: what its start needs. src/index.ts loads this module, and so all of src/write/, only
// when QBO_MODE is `write`. Nothing is made at import.
import type { WriteTool } from "../allowlist.js";
import { currentCall } from "../clients/call-context.js";
import type { ExtraRules } from "../http-guard.js";
import { QboCompaniesTool } from "../tools/qbo-companies.tool.js";
import { createRegistry, type Registry } from "./capability.js";
import { decideWrite } from "./guard-rules.js";
import { QboCategorizeBillTool, QboCategorizePurchaseTool, QboUndoChangeTool, QboWriteCheckTool } from "./stubs.js";

export type WriteMode = { readonly registry: Registry; readonly extraRules: ExtraRules; readonly tools: readonly WriteTool[] };

/** A registry of its own, the guard's rules that take from it (and from no other), and the write server's tools. */
export function writeMode(): WriteMode {
  const registry = createRegistry();
  const extraRules: ExtraRules = {
    decide: (request, context) => decideWrite(request, context, { company: () => currentCall()?.company, registry }),
  };
  return Object.freeze({
    registry,
    extraRules: Object.freeze(extraRules),
    tools: Object.freeze([QboCategorizePurchaseTool, QboCategorizeBillTool, QboUndoChangeTool, QboWriteCheckTool, QboCompaniesTool]),
  });
}
