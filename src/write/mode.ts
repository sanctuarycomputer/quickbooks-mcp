// Sanctuary Computer (quickbooks-mcp-293): write mode: what its start needs. src/index.ts loads this module, and so all of src/write/, only
// when QBO_MODE is `write`. Nothing is made at import.
// Changed by Sanctuary Computer (quickbooks-mcp-294): writeMode(deps) makes the write kit, every seam's one route, and the registry on its mono.
import type { WriteTool } from "../allowlist.js";
import { currentCall } from "../clients/call-context.js";
import type { ExtraRules } from "../http-guard.js";
import { QboCompaniesTool } from "../tools/qbo-companies.tool.js";
import { createRegistry, type Registry } from "./capability.js";
import { decideWrite } from "./guard-rules.js";
import { createKit, type WriteKit } from "./kit.js";
import { QboCategorizeBillTool, QboCategorizePurchaseTool, QboUndoChangeTool, QboWriteCheckTool } from "./stubs.js";

export type WriteMode = { readonly registry: Registry; readonly kit: WriteKit; readonly extraRules: ExtraRules; readonly tools: readonly WriteTool[] };

/** A kit and a registry of its own (on the kit's mono), the guard's rules that take from it (and from no other), and the write server's tools. */
export function writeMode(deps: Partial<WriteKit> = {}): WriteMode {
  const kit = createKit(deps);
  const registry = createRegistry({ now: kit.mono });
  const extraRules: ExtraRules = {
    decide: (request, context) => decideWrite(request, context, { company: () => currentCall()?.company, registry }),
  };
  return Object.freeze({
    registry,
    kit,
    extraRules: Object.freeze(extraRules),
    tools: Object.freeze([QboCategorizePurchaseTool, QboCategorizeBillTool, QboUndoChangeTool, QboWriteCheckTool, QboCompaniesTool]),
  });
}
