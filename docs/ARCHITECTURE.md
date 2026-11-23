<!-- Changed by Sanctuary Computer (quickbooks-mcp-285): describes the read-only fork. -->
# Architecture Documentation

This document explains the architecture, design decisions, and code patterns used in the QuickBooks Online MCP Server.

## Table of Contents

- [Overview](#overview)
- [System Architecture](#system-architecture)
- [Read-only fork](#read-only-fork)
- [HTTP guard](#http-guard)
- [Directory Structure](#directory-structure)
- [Core Components](#core-components)
- [Handler Pattern](#handler-pattern)
- [Tool Registration](#tool-registration)
- [Error Handling](#error-handling)
- [Type System](#type-system)
- [Design Decisions](#design-decisions)

---

## Overview

This fork of the QuickBooks Online MCP Server is a read-only Model Context Protocol (MCP) server. It exposes a fixed list of QuickBooks Online read tools (reports and searches) to Claude Code and other MCP-compatible clients. See [Read-only fork](#read-only-fork).

### Key Metrics

| Metric | Value |
|--------|-------|
| Registered tools | 32 (31 allowlisted read tools + `qbo_companies`) |
| Server mode | read only |

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         MCP Client                               │
│                    (Claude Code / IDE)                           │
└─────────────────────────────────────────────────────────────────┘
                                │
                                │ MCP Protocol (stdio)
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                         MCP Server                               │
│                        (src/index.ts)                            │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    Tool Registry                         │    │
│  │              (src/tools/*.tool.ts)                       │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                │                                 │
│                                │ Tool Invocation                 │
│                                ▼                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                      Handlers                            │    │
│  │            (src/handlers/*.handler.ts)                   │    │
│  │                                                          │    │
│  │  ┌──────────────┐  ┌──────────────┐                     │    │
│  │  │     Get      │  │    Search    │                     │    │
│  │  └──────────────┘  └──────────────┘                     │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                │                                 │
│                                │ API Calls                       │
│                                ▼                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │               QuickBooks Client                          │    │
│  │           (src/clients/quickbooks-client.ts)             │    │
│  │                                                          │    │
│  │  • No sign-in; getInstance() rejects                     │    │
│  │  • Token source arrives in ticket 286                    │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                                │
                                │ HTTPS
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                   QuickBooks Online API                          │
│               (sandbox.api.intuit.com / api.intuit.com)          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Read-only fork

This fork registers read tools only.

**The allowlist.** `READ_ALLOWLIST` in `src/allowlist.ts` lists 31 tool names (`get_*` reports and `search_*` queries). `COMPANIES_TOOL` is `qbo_companies`, a stub that answers a fork error until ticket 286. Together that is 32 registered tools.

**`startReadServer(env, server, tools)`** does these steps in order; steps 1 and 2 finish before any tool registers:

1. Refuse if any of the four refused keys is in the environment.
2. Check the tool list against the allowlist: a duplicate name, a missing name or an unlisted name throws.
3. Register the tools.

Every failure is one error, `refused to start: <reason>`.

**Refused keys.** `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_REFRESH_TOKEN` and `QUICKBOOKS_REALM_ID`. The start is refused when a key is present at all, even with an empty value. The value is never read or printed.

**Removed.** The OAuth sign-in flow, the auth server, the token store with its refresh and rotation, the switches that disabled write, update and delete tools, the attachable upload (its tool and handler) and the attachable file source.

**Unregistered, not removed.** The other create, update and delete tools and their handlers are still in `src/tools/` and `src/handlers/` as upstream wrote them, but nothing registers them: `src/index.ts` passes only the allowlisted tools to `startReadServer`, and an unlisted name refuses the start.

**Still to come.**
- Ticket 286 adds the Stacks token client: `getInstance` gets a token from Stacks, tools take a `company` argument, and `qbo_companies` gives a real answer. It documents its new configuration keys.
- The HTTP guard (ticket 291) is in place: see [HTTP guard](#http-guard) below.

---

## HTTP guard

Every request that leaves the server goes through one guard. It decides each request, sends only what it decided, and refuses the rest with a rule name.

**Where it hooks.** `node-quickbooks` requires the CommonJS `axios` instance, which is a different object from the fork's ESM `import axios`. `guardedAxios()` returns that CommonJS instance. `installGuard` sets the guard as its `defaults.adapter` and adds a request interceptor that refuses (`transport`) any request whose config names another adapter. `secureStart(process.env, process.execArgv)` installs it as the first statement of `main()` in `src/index.ts`, before any tool registers.

**What it allows.** Contract 1.0 §6 in Stacksbot's `docs/contracts/quickbooks.md` is the rule set; this document does not restate it. The allow rules are `companyinfo`, `preferences`, `query`, `reports` and `stacks`. Every other request is refused with a rule name. The guard's own rule names are:

- `raw-text`: the URL spelling is one `new URL` would rewrite, or its head is not the exact allowed head.
- `dot-segments`: the raw path holds a `\`, a `%2e`, or a `.` or `..` segment.
- `stacks-config`: the configured Stacks URL breaks the contract's form, or has no usable hostname.
- `body`: the request has a body.
- `credential-crossing`: a QuickBooks request carries `X-Api-Key`, or a Stacks request carries `Authorization`.
- `guard-error`: an exception inside the guard, or the decided URL differs from the instance's own `getUri`.
- `transport`: the interceptor above.
- `backstop`: the backstop below.

`decide` lives in `src/clients/guard-decide.ts`. It loads no network module and sends nothing. The adapter and the probe both call it.

**Transport pins.** The guard sends only the decided URL, with no `params`. It sets `maxRedirects: 0`, `proxy: false` and its own `https.Agent({ rejectUnauthorized: true })`. From the request config it keeps `method`, `headers`, `responseType`, `timeout`, `transformRequest`, `transformResponse` and `validateStatus` (the `KEPT` list), and only as own properties. Every other key is dropped. QuickBooks requests carry no timeout until the Stacks token client (ticket 286) sets one; the guard passes the request's `timeout` through unchanged.

**The backstop.** `installBackstop()` replaces these on the module and global objects:

- `https.request` and `https.get` are wrapped. A call goes on only inside a single-use ticket whose method, hostname, port and path match the call's. The adapter issues the ticket for the one request it decided.
- `http.request`, `http.get`, `http2.connect`, `globalThis.fetch` and `globalThis.WebSocket` always refuse (`backstop`).

It then calls `syncBuiltinESMExports()`, so ESM imports of `node:http`, `node:https` and `node:http2` see the replacements. Each replacement carries the `Symbol.for('qbo-guard.backstop')` marker. If one cannot be replaced, it puts back the others and throws `qbo-guard: install failed`.

The backstop covers the HTTP paths above and nothing else. It is not a sandbox. It does not cover native addons, child processes, sockets opened directly with `net`, `tls` or `dgram`, or worker threads (a worker loads its own copies of these modules). It does not cover code that took a reference to an original function before the backstop was installed, or an HTTP client library that opens its own sockets.

**Start refusals.** `secureStart` refuses to start when any of these holds:

- `NODE_USE_ENV_PROXY` is set, with any value.
- `--use-env-proxy` is in `process.execArgv` or in `NODE_OPTIONS`.
- `NODE_TLS_REJECT_UNAUTHORIZED` is `0`.
- `NODE_EXTRA_CA_CERTS` is set, with any value.

The refusal is one stderr line, `qbo-guard: start refused: <key>`, naming the key and never the value, and exit code 1. A failed install writes `qbo-guard: install failed` and exits 1. In both cases no tool is registered.

**Call scope.** `defaultCallScope()` returns the scope `secureStart` made. `defaultCallScope().run(fn)` starts one tool call with a fresh call record and no realm. `setRealm(r)` sets the realm for the current call. Outside a call, or before `setRealm`, every QuickBooks request is refused. `configureGuard({ keys, allowedRealm, callRecord })` replaces any of those three callbacks. It never replaces `stacksUrl`, which is `STACKS_QBO_URL` read once at start.

**The probe.** `node dist/guard-probe.js <METHOD> <URL> --realm <R> [--stacks-url <u>] [--key <k>]...` asks `decide` about one request. It prints `allow <rule>` and exits 0, or prints `refuse <rule>` and exits 1. A usage error prints a line starting `usage:` to stderr and exits 2. The probe sends nothing and imports only `guard-decide`. It has no headers or body, so its answer covers method and URL only. Without `--stacks-url`, a Stacks request is refused (`refused`).

```
$ node dist/guard-probe.js GET 'https://quickbooks.api.intuit.com/v3/company/123/companyinfo/123?minorversion=75' --realm 123
allow companyinfo
$ node dist/guard-probe.js GET 'https://quickbooks.api.intuit.com/v3/company/123/customer/5?minorversion=75' --realm 123
refuse entity-by-id
```

---

## Directory Structure

```
src/
├── index.ts                    # MCP server entry point
│                               # - Registers the 31 allowlisted tools and the stub, through startReadServer
│                               # - Handles MCP protocol communication
│
├── clients/
│   ├── guard-decide.ts         # The guard's pure decision; loads no network module
│   └── quickbooks-client.ts    # QuickBooks API client wrapper
│                               # - No sign-in; getInstance() rejects with
│                               #   "no QuickBooks token source" until 286
│
├── allowlist.ts                # Read allowlist, refused keys, start check
├── http-guard.ts               # HTTP guard, backstop and secureStart
├── guard-probe.ts              # Probe: asks decide about one request, sends nothing
│
├── handlers/                   # Business logic layer
│   └── *.handler.ts            # Only handlers behind an allowlisted tool
│                               # are reachable
│
├── tools/                      # MCP tool definitions
│   └── *.tool.ts               # Zod schemas + tool metadata
│
├── helpers/
│   └── format-error.ts         # Standardized error formatting
│
├── types/
│   └── tool-response.ts        # Response type definitions
│
└── server/
    └── *.ts                    # Server utilities
```

---

## Core Components

### 1. MCP Server Entry Point (`src/index.ts`)

The main server file:
- Initializes the MCP server
- Calls `startReadServer` with the process environment, the server and the tool list
- Registers the 31 allowlisted read tools and the `qbo_companies` stub, and nothing else
- Manages the MCP stdio transport

### 2. QuickBooks Client (`src/clients/quickbooks-client.ts`)

Wraps the `node-quickbooks` library, but has no sign-in. `QuickbooksClient.getInstance()` rejects with "no QuickBooks token source". The OAuth flow, the auth server, the token store and token refresh are removed. Ticket 286 adds the Stacks token client, so `getInstance` gets a token from Stacks.

### 3. Handlers (`src/handlers/*.handler.ts`)

Each handler:
- Defines a typed input interface
- Gets the QuickBooks client (`QuickbooksClient.getInstance()`)
- Maps input to QuickBooks API format
- Executes the API call
- Returns standardized response

### 4. Tools (`src/tools/*.tool.ts`)

Define the MCP tool interface:
- Tool name and description
- Zod schema for input validation
- Links to handler function

### 5. Helpers (`src/helpers/format-error.ts`)

Standardizes error messages:

```typescript
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  } else if (typeof error === 'string') {
    return `Error: ${error}`;
  } else {
    return `Unknown error: ${JSON.stringify(error)}`;
  }
}
```

---

## Handler Pattern

All handlers follow a consistent pattern for maintainability:

### Standard Handler Structure

```typescript
// 1. Imports
import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

// 2. Handler function (src/handlers/search-quickbooks-customers.handler.ts)
export async function searchQuickbooksCustomers(
  criteria: object | Array<Record<string, any>> = {}
): Promise<ToolResponse<any[]>> {
  try {
    // 2a. Get the client (rejects until the token source exists)
    const quickbooks = await QuickbooksClient.getInstance();

    // 2b. Execute the API call with a Promise wrapper
    return new Promise((resolve) => {
      (quickbooks as any).findCustomers(criteria as any, (err: any, customers: any) => {
        if (err) {
          resolve({ result: null, isError: true, error: formatError(err) });
        } else {
          resolve({
            result: customers?.QueryResponse?.Customer ?? customers?.QueryResponse?.totalCount ?? [],
            isError: false,
            error: null,
          });
        }
      });
    });
  } catch (error) {
    // 2c. Handle client/setup errors
    return { result: null, isError: true, error: formatError(error) };
  }
}
```

### Why This Pattern?

1. **Type Safety**: TypeScript interfaces ensure compile-time validation
2. **Consistency**: Same structure across the handlers makes codebase predictable
3. **Error Handling**: two levels: the API callback's error, and a failure getting the client (today, always: no token source)
4. **Field Mapping**: Clean separation between snake_case inputs and PascalCase API

---

## Tool Registration

Tools are registered only through `startReadServer` in `src/allowlist.ts`, called from `src/index.ts` (see [Read-only fork](#read-only-fork)). Each tool definition connects:

1. Tool name (MCP protocol identifier, must be on the allowlist)
2. Description (shown to users)
3. Schema (Zod validation)
4. Handler (business logic)

---

## Error Handling

### Two Kinds of Error

```
┌─────────────────────────────────────────────────┐
│  Getting the client fails                        │
│  • No token source (until ticket 286)           │
│  • Token request failures (from ticket 286)     │
│  Handled by: the handler's try/catch            │
└─────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────┐
│  The QuickBooks call fails                       │
│  • Validation, not found, permission errors     │
│  • Network errors                               │
│  Handled by: the callback's err parameter       │
└─────────────────────────────────────────────────┘
```

Both become `{ result: null, isError: true, error: formatError(...) }`.

### Response Format

All handlers return a consistent `ToolResponse<T>`:

```typescript
interface ToolResponse<T> {
  result: T | null;      // Data on success, null on error
  isError: boolean;      // Quick error check
  error: string | null;  // Error message, null on success
}

// Success response
{ result: { Id: '123', ... }, isError: false, error: null }

// Error response
{ result: null, isError: true, error: 'Error: Customer not found' }
```

---

## Type System

### Input Types

Each handler defines its input interface:

```typescript
// Required fields have no optional modifier
// Optional fields use TypeScript's optional property syntax

export interface ExampleSearchInput {
  limit?: number;                      // Optional
  offset?: number;                     // Optional
  fetch_all?: boolean;                 // Optional
}
```

### Field Naming Conventions

| Context | Convention | Example |
|---------|------------|---------|
| Handler inputs | snake_case | `customer_ref` |
| QuickBooks API | PascalCase | `CustomerRef` |
| Reference fields | Wrapped object | `{ value: 'id' }` |

---

## Design Decisions

### Why Separate Handlers and Tools?

**Handlers** contain business logic:
- Client setup
- Data transformation
- API interaction
- Error handling

**Tools** contain interface definition:
- Schema validation
- Description for users
- Response formatting

This separation allows:
- Testing handlers in isolation
- Reusing handlers across different tool registrations
- Cleaner code organization

### Why Callback-to-Promise Wrapping?

The `node-quickbooks` library uses callback patterns:

```typescript
quickbooks.findCustomers(criteria, (err, result) => { ... });
```

We wrap these in Promises for:
- Consistent async/await usage
- Better error handling flow
- Cleaner code structure

### Why 100% Test Coverage?

1. **Reliability**: Every code path is verified
2. **Regression Prevention**: Changes must pass all tests
3. **Documentation**: Tests show how handlers should behave
4. **Confidence**: Refactoring is safe

### Why ESM (ECMAScript Modules)?

1. **Modern Standard**: ESM is the JavaScript module standard
2. **Better Tree-Shaking**: Unused code can be eliminated
3. **Top-Level Await**: Cleaner async initialization
4. **Future-Proof**: Node.js is moving toward ESM

---

## Data Flow Example

**Searching customers (`search_customers`):**

```
MCP client sends a tool invocation
    -> MCP server validates args against the Zod schema
    -> the search handler calls QuickbooksClient.getInstance()
       (rejects with "no QuickBooks token source" until ticket 286)
    -> the handler runs the QuickBooks query
    -> the handler wraps the result in { result, isError, error }
    -> the MCP server formats it as MCP content and returns it
```

---

## Performance Considerations

1. **Minimal Payloads**: Only requested fields are sent to API
2. **No Polling**: Direct request/response pattern

---

## Security

1. **No credentials in this server**: it holds no QuickBooks secret; ticket 286's token client gets tokens from Stacks
2. **No sign-in material**: the server refuses to start if any of the four sign-in keys is present
3. **Read only**: only the allowlisted read tools are registered
4. **Input Validation**: Zod schemas validate all inputs

---

## Extending the Server

A new tool is exposed only if it is added to `READ_ALLOWLIST` in `src/allowlist.ts`, listed in `src/index.ts`, and covered by tests. That is a change to what the server exposes, so it is a deliberate change. The write, update and delete tools in `src/tools/` stay unregistered.
