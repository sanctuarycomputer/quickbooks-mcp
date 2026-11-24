// Sanctuary Computer (quickbooks-mcp-285): the read allowlist and the start refusal; the server registers only what is listed here.
// Changed by Sanctuary Computer (quickbooks-mcp-286): the start loads the config and builds the runtime before registering,
// and every tool registers with it; the lists moved to tool-lists.ts (no import cycle through tool-result.ts).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./clients/config.js";
import { createRuntime, type Runtime } from "./clients/runtime.js";
import { RegisterTool } from "./helpers/register-tool.js";
import { COMPANIES_TOOL, READ_ALLOWLIST } from "./tool-lists.js";
import type { ToolDefinition } from "./types/tool-definition.js";

export { COMPANIES_TOOL, READ_ALLOWLIST };

// Sign-in material the server must never be given: present at all, even empty, refuses the start.
export const REFUSED_KEYS: readonly string[] = ["QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET", "QUICKBOOKS_REFRESH_TOKEN", "QUICKBOOKS_REALM_ID"];

export interface CompaniesToolDefinition {
  name: string;
  description: string;
  /** Receives the call's arguments and the runtime (so the companies tool can read `runtime.cfg.companies`). */
  handler: (args: Record<string, unknown>, runtime: Runtime) => Promise<CallToolResult>;
}

export type ReadTool = ToolDefinition<any> | CompaniesToolDefinition;

// A `schema` key holding undefined counts as no schema, so it can't slip a listed name past the checks.
function hasSchema(tool: ReadTool): tool is ToolDefinition<any> {
  return "schema" in tool && tool.schema !== undefined;
}

/** The reason the server must not start, or null. Checks presence only; a value is never read. */
export function startRefusal(env: Record<string, string | undefined>): string | null {
  for (const key of REFUSED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(env, key)) return `${key} is set`;
  }
  return null;
}

/**
 * Registers exactly the allowlist plus the companies tool, or throws before registering anything.
 * An entry without a schema is the companies tool only under its own name; a listed name must carry a schema.
 */
export function registerReadTools(server: McpServer, tools: readonly ReadTool[], runtime: Runtime): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`allowlist: duplicate ${tool.name}`);
    seen.add(tool.name);
  }
  for (const name of [...READ_ALLOWLIST, COMPANIES_TOOL]) {
    if (!seen.has(name)) throw new Error(`allowlist: missing ${name}`);
  }
  for (const tool of tools) {
    const allowed = hasSchema(tool) ? READ_ALLOWLIST.includes(tool.name) : tool.name === COMPANIES_TOOL;
    if (!allowed) throw new Error(`allowlist: unlisted ${tool.name}`);
  }
  for (const tool of tools) {
    if (hasSchema(tool)) RegisterTool(server, tool, runtime);
    else {
      const { handler } = tool;
      server.tool(tool.name, tool.description, {}, (args: Record<string, unknown>) => handler(args, runtime));
    }
  }
}

/**
 * Refuses first (285's sign-in keys), then loads the config (the five keys), builds the runtime and registers; returns
 * the runtime, which tests close. Every failure is one `refused to start: <reason>` error, and a failure after the
 * runtime was built closes it first (U1). 291's `secureStart` must have run. `deps.now` is the Stacks client's clock (tests).
 */
export function startReadServer(
  env: Record<string, string | undefined>,
  server: McpServer,
  tools: readonly ReadTool[],
  deps: { now?: () => number } = {},
): Runtime {
  const reason = startRefusal(env);
  if (reason !== null) throw new Error("refused to start: " + reason);
  // loadConfig's own refusals already read `refused to start: <KEY> <reason>`.
  const cfg = loadConfig(env);
  let runtime: Runtime;
  try {
    runtime = createRuntime(cfg, deps);
  } catch (e) {
    throw new Error("refused to start: " + (e as Error).message);
  }
  try {
    registerReadTools(server, tools, runtime);
  } catch (e) {
    runtime.close();
    throw new Error("refused to start: " + (e as Error).message);
  }
  return runtime;
}
