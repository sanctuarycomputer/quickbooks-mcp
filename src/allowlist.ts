// Sanctuary Computer (quickbooks-mcp-285): the read allowlist and the start refusal; the server registers only what is listed here.
// Changed by Sanctuary Computer (quickbooks-mcp-286): the start loads the config and builds the runtime before registering,
// and every tool registers with it; the lists moved to tool-lists.ts (no import cycle through tool-result.ts).
// Changed by Sanctuary Computer (quickbooks-mcp-293): write mode's list and start (contract §13). The write tools are given to it: it imports none.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, loadWriteConfig, type Config } from "./clients/config.js";
import { createRuntime, type Runtime } from "./clients/runtime.js";
import { RegisterTool, RegisterWriteTool, requireStrictParams, type WriteRuntime, type WriteToolDefinition } from "./helpers/register-tool.js";
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
export type WriteTool = WriteToolDefinition<any> | CompaniesToolDefinition;

/** Every tool of the write server. A change here is a change to what it exposes. */
export const WRITE_TOOLS: readonly string[] = ["qbo_categorize_purchase", "qbo_categorize_bill", "qbo_undo_change", "qbo_write_check", COMPANIES_TOOL];

// A `schema` key holding undefined counts as no schema, so it can't slip a listed name past the checks.
function hasSchema<T extends { name: string }>(tool: T | CompaniesToolDefinition): tool is T {
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
 * Registers exactly the listed tools, or throws before registering anything.
 * An entry without a schema is the companies tool only under its own name; another listed name must carry a schema.
 */
function registerExactly<T extends { name: string }>(
  server: McpServer,
  tools: readonly (T | CompaniesToolDefinition)[],
  listed: readonly string[],
  runtime: Runtime,
  register: (tool: T) => void,
): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`allowlist: duplicate ${tool.name}`);
    seen.add(tool.name);
  }
  for (const name of listed) {
    if (!seen.has(name)) throw new Error(`allowlist: missing ${name}`);
  }
  for (const tool of tools) {
    const allowed = hasSchema(tool) ? tool.name !== COMPANIES_TOOL && listed.includes(tool.name) : tool.name === COMPANIES_TOOL;
    if (!allowed) throw new Error(`allowlist: unlisted ${tool.name}`);
  }
  for (const tool of tools) {
    if (hasSchema(tool)) register(tool);
    else {
      const { handler } = tool;
      server.tool(tool.name, tool.description, {}, (args: Record<string, unknown>) => handler(args, runtime));
    }
  }
}

/** Registers exactly the allowlist plus the companies tool, or throws before registering anything. */
export function registerReadTools(server: McpServer, tools: readonly ReadTool[], runtime: Runtime): void {
  registerExactly<ToolDefinition<any>>(server, tools, [...READ_ALLOWLIST, COMPANIES_TOOL], runtime, (tool) => RegisterTool(server, tool, runtime));
}

/** Registers exactly WRITE_TOOLS, each with strict params, or throws before registering anything. */
function registerWriteTools(server: McpServer, tools: readonly WriteTool[], runtime: WriteRuntime): void {
  for (const tool of tools) if (hasSchema<WriteToolDefinition<any>>(tool)) requireStrictParams(tool.name, tool.schema);
  registerExactly<WriteToolDefinition<any>>(server, tools, WRITE_TOOLS, runtime, (tool) => RegisterWriteTool(server, tool, runtime));
}

type Env = Record<string, string | undefined>;

/** The start either server makes, with its own config and registration. */
function start<C extends Config>(env: Env, load: (env: Env) => C, register: (runtime: Runtime & { cfg: C }) => void, deps: { now?: () => number }): Runtime & { cfg: C } {
  const reason = startRefusal(env);
  if (reason !== null) throw new Error("refused to start: " + reason);
  // The config's own refusals already read `refused to start: <KEY> <reason>`.
  const cfg = load(env);
  let runtime: Runtime & { cfg: C };
  try {
    // createRuntime keeps this cfg; its type there is Config.
    runtime = { ...createRuntime(cfg, deps), cfg };
  } catch (e) {
    throw new Error("refused to start: " + (e as Error).message);
  }
  try {
    register(runtime);
  } catch (e) {
    runtime.close();
    throw new Error("refused to start: " + (e as Error).message);
  }
  return runtime;
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
  return start(env, loadConfig, (runtime) => registerReadTools(server, tools, runtime), deps);
}

/** As startReadServer, with the write server's config and WRITE_TOOLS. `secureStart` must have run, with write mode's rules. */
export function startWriteServer(
  env: Record<string, string | undefined>,
  server: McpServer,
  tools: readonly WriteTool[],
  deps: { now?: () => number } = {},
): WriteRuntime {
  return start(env, loadWriteConfig, (runtime) => registerWriteTools(server, tools, runtime), deps);
}
