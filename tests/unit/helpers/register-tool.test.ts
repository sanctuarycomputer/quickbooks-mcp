// Changed by Sanctuary Computer (quickbooks-mcp-285): the removed switches' cases are gone.
import { describe, it, expect, jest } from "@jest/globals";
import {
  knownParamKeys,
  permissiveParamsSchema,
  RegisterTool,
  unsupportedParamsWarning,
} from "../../../src/helpers/register-tool";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDefinition } from "../../../src/types/tool-definition";

// ── RegisterTool ─────────────────────────────────────────────────────────────
// Verifies RegisterTool forwards the definition's fields to server.tool().
// Uses a minimal mock server object to avoid coupling to the MCP SDK internals.

describe("RegisterTool", () => {
  const schema = z.object({ id: z.string() });
  const handler = jest.fn() as ToolDefinition<typeof schema>["handler"];
  const def = (name: string): ToolDefinition<typeof schema> =>
    ({ name, description: `desc:${name}`, schema, handler });

  // Confirm all four ToolDefinition fields are forwarded to server.tool() unchanged.
  it("calls server.tool() with all definition fields", () => {
    const server = { tool: jest.fn() } as unknown as McpServer;
    const d = def("get_invoice");
    RegisterTool(server, d);
    expect(server.tool).toHaveBeenCalledTimes(1);
    const [name, description, shape, handler] = (server.tool as jest.Mock).mock.calls[0] as any[];
    expect(name).toBe(d.name);
    expect(description).toBe(d.description);
    expect(typeof handler).toBe("function");
    // The registered schema is the definition's schema made permissive, so an
    // unsupported parameter survives validation and can be reported instead of
    // silently vanishing. It is therefore not the same object identity.
    expect((shape.params as any).parse({ id: "1", unexpected_key: 1 }).unexpected_key).toBe(1);
  });
});


// ── unsupported parameters ───────────────────────────────────────────────────
// A tool schema is a strict zod object, so an undeclared parameter is dropped
// during validation and the caller is never told. These cover both halves of
// the fix: naming the parameter, and still not forwarding it to QuickBooks.
describe("unsupported parameter reporting", () => {
  const runRegistered = async (toolName: string, schema: any, params: any) => {
    const seen: any[] = [];
    const handler = jest.fn(async (args: any) => {
      seen.push(args);
      return { content: [{ type: "text", text: "ok" }] };
    });
    const server = { tool: jest.fn() } as unknown as McpServer;
    RegisterTool(server, { name: toolName, description: "d", schema, handler } as any);
    const registered = (server.tool as jest.Mock).mock.calls[0][3] as any;
    const result = await registered({ params });
    return { result, seenByHandler: seen[0]?.params };
  };

  it("names an unsupported parameter in the response", async () => {
    const { result } = await runRegistered(
      "create_invoice",
      z.object({ customer_ref: z.string() }),
      { customer_ref: "1", ship_date: "2026-09-01" }
    );
    expect(result.content[0].text).toContain("create_invoice does not support");
    expect(result.content[0].text).toContain("ship_date");
    expect(result.content[0].text).toContain("customer_ref"); // lists what IS supported
    expect(result.content[1].text).toBe("ok"); // original response preserved
  });

  it("strips unknown keys so they cannot reach QuickBooks", async () => {
    // search-bills/customers/estimates/vendors spread leftover params into query
    // criteria; a key left in place would become a real SQL filter.
    const { seenByHandler } = await runRegistered(
      "search_bills",
      z.object({ criteria: z.any().optional() }),
      { criteria: [], DocNumber: "1042" }
    );
    expect(seenByHandler).toEqual({ criteria: [] });
    expect(seenByHandler).not.toHaveProperty("DocNumber");
  });

  it("leaves a fully supported call untouched", async () => {
    const { result, seenByHandler } = await runRegistered(
      "read_invoice",
      z.object({ invoice_id: z.string() }),
      { invoice_id: "42" }
    );
    expect(seenByHandler).toEqual({ invoice_id: "42" });
    expect(result.content[0].text).toBe("ok");
  });

  it("pluralises, and stays silent on input it cannot analyse", () => {
    const known = knownParamKeys(z.object({ a: z.string() }));
    expect(unsupportedParamsWarning("t", known, { b: 1, c: 2 })).toContain("these parameters");
    expect(unsupportedParamsWarning("t", known, { a: "x" })).toBeNull();
    expect(unsupportedParamsWarning("t", known, undefined)).toBeNull();
    expect(unsupportedParamsWarning("t", null, { b: 1 })).toBeNull();
  });

  it("knownParamKeys returns null for schemas without an object shape", () => {
    expect(knownParamKeys(z.string())).toBeNull();
    expect(knownParamKeys(undefined)).toBeNull();
  });

  it("knownParamKeys reads shape provided as a plain object (zod v4 style)", () => {
    const objectShapeSchema = { _def: { shape: { a: true, b: true } } };
    expect(knownParamKeys(objectShapeSchema)).toEqual(new Set(["a", "b"]));
  });

  it("knownParamKeys returns null when reading the shape throws", () => {
    const throwingSchema = {
      _def: {
        shape: () => {
          throw new Error("broken shape");
        },
      },
    };
    expect(knownParamKeys(throwingSchema)).toBeNull();
  });

  it("permissiveParamsSchema keeps unknown keys and passes non-object schemas through", () => {
    const permissive: any = permissiveParamsSchema(z.object({ a: z.string() }));
    expect(permissive.parse({ a: "x", extra: 1 }).extra).toBe(1);
    const plain = z.string();
    expect(permissiveParamsSchema(plain)).toBe(plain);
  });
});
