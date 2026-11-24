// Changed by Sanctuary Computer (quickbooks-mcp-285): the removed switches are gone; every definition passed here registers.
// Changed by Sanctuary Computer (quickbooks-mcp-286): every tool takes a required `company` from the loaded keys and runs
// as one tool call: the company's call is prepared, then the handler's answer is shaped into contract §5's result.
// Changed by Sanctuary Computer (quickbooks-mcp-293): RegisterWriteTool, for write mode's tools; RegisterTool is as it was.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";
import { currentCall, runInCall, type CallStore, type Failure } from "../clients/call-context.js";
import type { WriteConfig } from "../clients/config.js";
import type { Runtime } from "../clients/runtime.js";
import { errorResult, shapeResult } from "./tool-result.js";

const FORK_ERROR: Failure = Object.freeze({ reason: "fork-error" });

/**
 * Unsupported-parameter reporting.
 *
 * Tool schemas are strict zod objects, so a parameter a tool does not declare is
 * SILENTLY DISCARDED during validation: the call succeeds, the value never
 * reaches QuickBooks, and the caller has no way to find out. In practice this
 * surfaced as an invoice sent to a customer with a blank Ship Date — the caller
 * passed `ship_date`, `create_invoice` did not declare it, and nothing said so.
 *
 * Hard-failing on unknown keys would turn a harmless stray parameter into a
 * failed transaction, so instead the schema is registered permissively (unknown
 * keys survive validation and can therefore be seen), the wrapper STRIPS them
 * before the handler runs, and the response names them.
 */

/** Top-level keys a tool's params schema declares, or null if not an object schema. */
export function knownParamKeys(schema: unknown): Set<string> | null {
  const shape = (schema as any)?._def?.shape;
  if (!shape) return null;
  try {
    return new Set(Object.keys(typeof shape === "function" ? shape() : shape));
  } catch {
    return null;
  }
}

/** Keep unknown keys through validation so they can be reported rather than vanish. */
export function permissiveParamsSchema<T>(schema: T): T {
  const anySchema = schema as any;
  return typeof anySchema?.passthrough === "function" ? anySchema.passthrough() : schema;
}

/** Human-readable notice naming parameters the tool does not support. */
export function unsupportedParamsWarning(
  toolName: string,
  known: Set<string> | null,
  params: unknown
): string | null {
  if (!known || !params || typeof params !== "object" || Array.isArray(params)) return null;
  const extras = Object.keys(params as Record<string, unknown>).filter((k) => !known.has(k));
  if (extras.length === 0) return null;
  return (
    `WARNING: ${toolName} does not support ${extras.length === 1 ? "this parameter" : "these parameters"}: ` +
    `${extras.join(", ")}. ${extras.length === 1 ? "It was" : "They were"} IGNORED - the value did not reach ` +
    `QuickBooks. Supported parameters: ${[...known].sort().join(", ")}.`
  );
}

export function RegisterTool<T extends z.ZodType<any, any>>(
  server: McpServer,
  toolDefinition: ToolDefinition<T>,
  runtime: Runtime
) {
  const known = knownParamKeys(toolDefinition.schema);
  const paramsSchema = permissiveParamsSchema(toolDefinition.schema);
  // The handler receives `({ params }, runtime)`; upstream's handlers read only their first argument.
  const baseHandler = toolDefinition.handler as unknown as (args: { params: unknown }, runtime: Runtime) => Promise<unknown>;
  // The loaded keys, in file order (A2.7, A3.1); loadConfig refuses an empty list, so the enum is never empty.
  const keys = runtime.cfg.companies.map((c) => c.key) as [string, ...string[]];

  // The SDK has checked `company` against the enum and `params` against the schema before this runs (A3.2).
  const handler = (async (args: { company: string; params: unknown }) =>
    runInCall(args.company, async () => {
      const call = currentCall() as CallStore;
      let params = args.params;
      try {
        const warning = unsupportedParamsWarning(toolDefinition.name, known, params);
        if (warning && known && params && typeof params === "object" && !Array.isArray(params)) {
          // Strip unknown keys before the handler runs. The permissive schema
          // exists only so they can be SEEN; it must not change what reaches
          // QuickBooks. Several search tools destructure their params with a rest
          // element and pass the rest on as query criteria (search-bills,
          // search-customers, search-estimates, search-vendors), so an unknown key
          // left in place would become a real SQL filter - quietly changing which
          // records the search returns while this warning claimed it was ignored.
          const cleaned: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
            if (known.has(k)) cleaned[k] = v;
          }
          params = cleaned;
          // The call's warnings go after the result's first item, on errors too (contract §5).
          call.warnings.push(warning);
        }
      } catch {
        /* diagnostics must never break a working call */
      }
      try {
        // A prepare failure (a token failure, a name mismatch, a failed first-use read) comes only from this return (T7-4).
        const failure = await runtime.companies.prepareCall(args.company);
        if (failure !== null) return errorResult(failure, call.warnings);
        return shapeResult(await baseHandler({ params }, runtime), call, toolDefinition.name);
      } catch {
        // The thrown value is never read: an error rethrown by the interceptors carries the bearer in its config (TB6).
        return errorResult(currentCall()?.failure ?? FORK_ERROR, call.warnings);
      }
    })) as unknown as Parameters<McpServer["tool"]>[3];

  server.tool(toolDefinition.name, toolDefinition.description, { company: z.enum(keys), params: paramsSchema }, handler as any);
}

/** The runtime, with the write server's config as its own. */
export type WriteRuntime = Runtime & { cfg: WriteConfig };

/** `params` refuses an unknown key (contract §13); the schema's type says so, so a loose one doesn't compile. */
export interface WriteToolDefinition<T extends z.ZodObject<any, z.core.$strict> = z.ZodObject<any, z.core.$strict>> {
  name: string;
  description: string;
  schema: T;
  /** Answers the whole result. No call is open and nothing was sent: it opens and prepares its own, where it needs one. */
  handler(args: { company: string; params: z.infer<T> }, runtime: WriteRuntime): Promise<CallToolResult>;
}

/**
 * Registers a write tool: `params` is checked as its schema says, nothing is added to it or taken out, and the call isn't
 * prepared, so nothing is sent before the handler runs. A key beside `company` and `params` is stripped by the SDK, as in read mode.
 */
export function RegisterWriteTool(server: McpServer, toolDefinition: WriteToolDefinition, runtime: WriteRuntime) {
  const keys = runtime.cfg.companies.map((c) => c.key) as [string, ...string[]];
  const handler = async (args: { company: string; params: unknown }): Promise<CallToolResult> => {
    try {
      return await toolDefinition.handler(args as Parameters<WriteToolDefinition["handler"]>[0], runtime);
    } catch {
      // Never read: an axios error carries the token and the body.
      return errorResult(FORK_ERROR, []);
    }
  };
  server.tool(toolDefinition.name, toolDefinition.description, { company: z.enum(keys), params: toolDefinition.schema }, handler as any);
}
