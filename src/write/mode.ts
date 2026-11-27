// Sanctuary Computer (quickbooks-mcp-293): write mode: what its start needs. src/index.ts loads this module, and so all of src/write/, only
// when QBO_MODE is `write`. Nothing is made at import.
// Changed by Sanctuary Computer (quickbooks-mcp-294): writeMode(deps) makes the write kit, every seam's one route, the registry on its mono,
// and the switch on its fs: one each per server, so one latch (spec §3 T2). The tools get the three (T7, T8): the two categorize tools are
// categorize.ts's (T7).
import type { WriteTool } from "../allowlist.js";
import { currentCall } from "../clients/call-context.js";
import type { ExtraRules } from "../http-guard.js";
import { QboCompaniesTool } from "../tools/qbo-companies.tool.js";
import { createRegistry, type Registry } from "./capability.js";
import { decideWrite } from "./guard-rules.js";
import { createKit, type WriteKit } from "./kit.js";
import { createSwitch, type Switch } from "./switch.js";
import { categorizeTool } from "./categorize.js";
import { QboUndoChangeTool, QboWriteCheckTool } from "./stubs.js";

export type WriteMode = { readonly registry: Registry; readonly sw: Switch; readonly kit: WriteKit; readonly extraRules: ExtraRules; readonly tools: readonly WriteTool[] };

/** A kit, a registry (on the kit's mono) and a switch (on the kit's fs) of its own, the guard's rules that take from that registry (and from no other), and the write server's tools. */
export function writeMode(deps: Partial<WriteKit> = {}): WriteMode {
  const kit = createKit(deps);
  const registry = createRegistry({ now: kit.mono });
  const sw = createSwitch(kit.fs);
  const extraRules: ExtraRules = {
    decide: (request, context) => decideWrite(request, context, { company: () => currentCall()?.company, registry }),
  };
  const tools = { registry, sw, kit };
  return Object.freeze({
    registry,
    sw,
    kit,
    extraRules: Object.freeze(extraRules),
    tools: Object.freeze([categorizeTool("purchase", tools), categorizeTool("bill", tools), QboUndoChangeTool, QboWriteCheckTool, QboCompaniesTool]),
  });
}
