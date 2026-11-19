// Changed by Sanctuary Computer (quickbooks-mcp-285): the removed switches are gone; every definition passed here registers.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

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
  toolDefinition: ToolDefinition<T>
) {
  const known = knownParamKeys(toolDefinition.schema);
  const paramsSchema = permissiveParamsSchema(toolDefinition.schema);
  const baseHandler = toolDefinition.handler as unknown as (...a: any[]) => Promise<any>;

  const handler = (async (...a: any[]) => {
    let callArgs = a;
    let warning: string | null = null;
    try {
      const params = (a[0] as any)?.params;
      warning = unsupportedParamsWarning(toolDefinition.name, known, params);
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
        callArgs = [{ ...(a[0] as any), params: cleaned }, ...a.slice(1)];
      }
    } catch {
      /* diagnostics must never break a working call */
    }

    const result = await baseHandler(...callArgs);

    try {
      if (warning && result && Array.isArray(result.content)) {
        // Prepended so it cannot be missed, and added even on error responses.
        result.content.unshift({ type: "text" as const, text: warning });
      }
    } catch {
      /* diagnostics must never break a working call */
    }
    return result;
  }) as typeof toolDefinition.handler;

  server.tool(toolDefinition.name, toolDefinition.description, { params: paramsSchema }, handler);
}