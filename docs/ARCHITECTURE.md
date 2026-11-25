<!-- Changed by Sanctuary Computer (quickbooks-mcp-285, quickbooks-mcp-286, quickbooks-mcp-293): describes the read server and, with QBO_MODE=write, the write server. -->
# Architecture Documentation

This document explains the architecture, design decisions, and code patterns used in the QuickBooks Online MCP Server.

## Table of Contents

- [Overview](#overview)
- [System Architecture](#system-architecture)
- [Read-only fork](#read-only-fork)
- [Configuration](#configuration)
- [Call flow](#call-flow)
- [HTTP guard](#http-guard)
- [Write mode](#write-mode)
- [Directory Structure](#directory-structure)
- [Core Components](#core-components)
- [Handler Pattern](#handler-pattern)
- [Tool Registration](#tool-registration)
- [Error Handling](#error-handling)
- [Type System](#type-system)
- [Design Decisions](#design-decisions)

---

## Overview

This fork of the QuickBooks Online MCP Server is a Model Context Protocol (MCP) server with two modes. By default (`QBO_MODE` unset or `read`) it is a read-only server: it exposes a fixed list of QuickBooks Online read tools (reports and searches) to Claude Code and other MCP-compatible clients. See [Read-only fork](#read-only-fork). With `QBO_MODE=write` it is the write server, which registers five tools and can send one kind of update. See [Write mode](#write-mode).

### Key Metrics

| Metric | Value |
|--------|-------|
| Registered tools | read mode: 32 (31 allowlisted read tools + `qbo_companies`); write mode: 5 (four write tools + `qbo_companies`) |
| Server mode | read (default) or write (`QBO_MODE=write`) |

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
│  │  • No sign-in; the call's Stacks token is its only key   │    │
│  │  • Every request goes through the HTTP guard             │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                                │
                                │ HTTPS
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│   QuickBooks Online API (quickbooks.api.intuit.com)              │
│   Stacks token service (STACKS_QBO_URL)                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Read-only fork

In read mode (`QBO_MODE` unset or `read`) this fork registers read tools only. Write mode is a separate server, described under [Write mode](#write-mode); read mode loads none of its code.

**The allowlist.** `READ_ALLOWLIST` in `src/allowlist.ts` lists 31 tool names (`get_*` reports and `search_*` queries). `COMPANIES_TOOL` is `qbo_companies`, which answers each loaded company's key and name. Together that is 32 registered tools.

**`startReadServer(env, server, tools)`** does these steps in order; steps 1 and 2 finish before any tool registers:

1. Refuse if any of the four refused keys is in the environment, or if the five-key configuration fails (see [Configuration](#configuration)).
2. Check the tool list against the allowlist: a duplicate name, a missing name or an unlisted name throws.
3. Register the tools.

Every failure is one error, `refused to start: <reason>`.

**Refused keys.** The four sign-in keys the fork removed, listed as `REFUSED_KEYS` in `src/allowlist.ts`. The start is refused when a key is present at all, even with an empty value. The value is never read or printed.

**Removed.** The OAuth sign-in flow, the auth server, the token store with its refresh and rotation, the switches that disabled write, update and delete tools, the attachable upload (its tool and handler) and the attachable file source.

**Unregistered, not removed.** The other create, update and delete tools and their handlers are still in `src/tools/` and `src/handlers/` as upstream wrote them, but nothing registers them: `src/index.ts` passes only the allowlisted tools to `startReadServer`, and an unlisted name refuses the start.

**Tokens and companies.** The Stacks token client, the `company` argument on every read tool and the real `qbo_companies` answer are in place: see [Configuration](#configuration) and [Call flow](#call-flow). The HTTP guard is described under [HTTP guard](#http-guard).

---

## Configuration

`loadConfig` in `src/clients/config.ts` is the only reader of five keys, in this order, and throws at the first that fails: `refused to start: <KEY> <reason>`, naming the key and never its value.

1. `STACKS_QBO_URL`: https, with no username, password, path, query or fragment.
2. `STACKS_QBO_TOKEN`: set and not empty. It is the `X-Api-Key` sent to Stacks.
3. `QUICKBOOKS_ENVIRONMENT`: set, and exactly `production`.
4. `QBO_COMPANIES`: the path of a readable entities file (`v` 1.0) whose companies each have a `stacks_key`, a `name` and `accepted_names` (the first is the name).
5. `QBO_MODE`: optional; unset or `read` is the read server. `loadConfig` refuses any other value, the empty string included, with `refused to start: QBO_MODE is not read`. The write server is the one value `write` (see [Write mode](#write-mode)); its own loader, `loadWriteConfig`, reads the same five keys in this order and then four write keys.

`.env.example` lists them with placeholder values.

---

## Call flow

1. A tool call arrives with `company`, a key from `qbo_companies`.
2. The call context starts (`src/clients/call-context.ts`). It holds the call's company, tokens, realm and failure, and is not shared between calls. What is kept across calls is each company's token, realm, refusal and passed name check (`stacks-token.ts`, `company-state.ts`).
3. The access token comes from Stacks: `GET <STACKS_QBO_URL>/api/qbo/access_token?enterprise=<company>` with the `X-Api-Key` header and a 10 second timeout. A token the fork already keeps is used with no request until 5 minutes before its `expires_at`; then it is fetched again. The request is sent once more only when there was no answer, or the answer is not HTTP, or the status is one the mapping does not know (a 3xx, say), or a 403, 404, 409 or 502 has a body that is not Stacks' own. A 200 the fork cannot read is not asked again: it is a fork error, and so is a request the guard refused. A 403, 404, 409 or 502 with Stacks' own body is not asked again either.
4. On the first use per company, its QuickBooks name is checked against that company's `accepted_names` in `QBO_COMPANIES`. A mismatch is kept until restart.
5. Every request goes through the HTTP guard.
6. Every QuickBooks request has a 15 second limit. A GET answered 401: the token is refetched and the request is sent once more. 429: the request is sent once more after `Retry-After` in whole seconds, at most 30 (2 when the header is missing or not whole seconds). Each resend is made once per request.
7. Results follow contract 1.1.

**Redaction.** Every access token the call held, and the Stacks key, are kept out of results, errors and logs. An `intuit_tid` that contains any of them is dropped.

---

## HTTP guard

Every request that leaves the server goes through one guard. It decides each request, sends only what it decided, and refuses the rest with a rule name.

**Where it hooks.** `node-quickbooks` requires the CommonJS `axios` instance, which is a different object from the fork's ESM `import axios`. `guardedAxios()` returns that CommonJS instance. `installGuard` sets the guard as its `defaults.adapter` and adds a request interceptor that refuses (`transport`) any request whose config names another adapter. `secureStart(process.env, process.execArgv)` installs it as the first statement of `main()` in `src/index.ts`, before any tool registers.

**What it allows.** Contract 1.1 §6 in Stacksbot's `docs/contracts/quickbooks.md` is the rule set; this document does not restate it. The allow rules are `companyinfo`, `preferences`, `query`, `reports` and `stacks`. Every other request is refused with a rule name. This is read mode. Write mode adds two rules, asked first, and refuses `reports`: see [Write mode](#write-mode). The guard's own rule names are:

- `raw-text`: the URL spelling is one `new URL` would rewrite, or its head is not the exact allowed head.
- `dot-segments`: the raw path holds a `\`, a `%2e`, or a `.` or `..` segment.
- `stacks-config`: the configured Stacks URL breaks the contract's form, or has no usable hostname.
- `body`: the request has a body (in write mode, the update's body is allowed only by the `write-update` rule).
- `credential-crossing`: a QuickBooks request carries `X-Api-Key`, or a Stacks request carries `Authorization`.
- `guard-error`: an exception inside the guard, or the decided URL differs from the instance's own `getUri`.
- `transport`: the interceptor above.
- `backstop`: the backstop below.

`decide` lives in `src/clients/guard-decide.ts`. It loads no network module and sends nothing. The adapter and the probe both call it.

**Transport pins.** The guard sends only the decided URL, with no `params`. It sets `maxRedirects: 0`, `proxy: false` and its own `https.Agent({ rejectUnauthorized: true })`. From the request config it keeps `method`, `headers`, `responseType`, `timeout`, `transformRequest`, `transformResponse` and `validateStatus` (the `KEPT` list), and only as own properties. Every other key is dropped. The guard passes the request's `timeout` through unchanged. Every QuickBooks GET carries a 15 second limit (`QBO_LIMIT_MS` in `src/clients/qbo-transport.ts`); the Stacks token request sets its own 10 second timeout.

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

**The probe.** `node dist/guard-probe.js <METHOD> <URL> --realm <R> [--stacks-url <u>] [--key <k>]...` asks `decide` about one request. It prints `allow <rule>` and exits 0, or prints `refuse <rule>` and exits 1. A usage error prints a line starting `usage:` to stderr and exits 2. Read the stdout line, not the exit code alone: Node also exits 1 when it crashes (a closed stdout, a missing file), so a refusal is the line `refuse <rule>` with exit 1, and anything else (an empty stdout included, as when Node is pointed at a directory rather than the file) is a failed probe, never an allow. The probe sends nothing and imports only `guard-decide` and `write/guard-rules` (which loads no network module either), plus `node:fs` and `node:url` to find its own path. In read mode it has no headers or body, so its answer covers method and URL only (`--mode write` is described under [Write mode](#write-mode)). Without `--stacks-url`, a Stacks request is refused (`refused`); `--stacks-url ''` stands for a `STACKS_QBO_URL` set but empty (`stacks-config`).

```
$ node dist/guard-probe.js GET 'https://quickbooks.api.intuit.com/v3/company/123/companyinfo/123?minorversion=75' --realm 123
allow companyinfo
$ node dist/guard-probe.js GET 'https://quickbooks.api.intuit.com/v3/company/123/customer/5?minorversion=75' --realm 123
refuse entity-by-id
```

---

## Write mode

Contract 1.1 §13 to §17 in Stacksbot's `docs/contracts/quickbooks.md` is the rule set for the words below; this section says what the code in `src/write/` does.

**Two modes.** `QBO_MODE` unset or `read` is the read server, unchanged. Exactly `write` is the write server (`isWriteMode` in `src/clients/config.ts`). Any other value, the empty string included, is not write mode, so `loadConfig` refuses it (`refused to start: QBO_MODE is not read`). The write server refuses to start unless the four write keys are set (see below).

The read server loads nothing under `src/write` (only the probe imports `src/write/guard-rules.ts`, and it sends nothing). In write mode, `main()` in `src/index.ts` imports `./write/mode.js` dynamically and calls `writeMode()` before `secureStart`, then passes the rules that call made to `secureStart` as `extraRules`. A failed import stops the start the way a refusal does: the first line of the error goes to stderr and the process exits 1, before any tool registers. `startWriteServer` then does what `startReadServer` does, with `loadWriteConfig` and the write tool list.

**The five tools.** `WRITE_TOOLS` in `src/allowlist.ts` lists them: `qbo_categorize_purchase`, `qbo_categorize_bill`, `qbo_undo_change`, `qbo_write_check` and `qbo_companies`. No read tool is registered. A missing, duplicate or unlisted name refuses the start before anything registers, as in read mode.

The four write tools are stubs (`src/write/stubs.ts`). They have the schemas and descriptions of contract §13, and each handler answers an error result with `reason: fork-error` and the text "This tool is not built yet." Ticket 294 builds the two categorize tools and the undo, and ticket 298 builds the write check.

`params` is strict. Every write tool takes a required `company` (an enum of the `QBO_COMPANIES` keys) and a required `params`. At start, `requireStrictParams` checks that `params` and every object inside it refuses an unknown key; a schema that does not (or holds a lazy schema, which it cannot walk) refuses the start with `refused to start: allowlist: params not strict <tool>`. A key inside `params` that the tool does not declare fails the schema, so it is the SDK's input error. A key beside `company` and `params` is stripped by the SDK, as in read mode. `RegisterWriteTool` does not prepare the call: nothing is fetched from Stacks or sent to QuickBooks before the handler runs, and an error the handler throws is never read (an axios error carries the token and the body), so it answers `fork-error`.

**The write keys.** `loadWriteConfig` reads the five keys in the order under [Configuration](#configuration) (`QBO_MODE` must be `write`) and then these four, each set and not empty, else `refused to start: <KEY> is not set` or `<KEY> is empty`:

| Key | What it is |
|-----|------------|
| `QBO_WRITE_RECEIPT_CMD` | The receipt command. |
| `QBO_WRITE_SWITCH` | The path of the off switch's file. |
| `QBO_WRITE_LEDGER` | The path of `writes.jsonl`. |
| `QBO_WRITE_SWEEP_STAMP` | The path of the job sweep's stamp. |

The config holds each value as given; nothing in this code opens the files or runs the command yet. `NOTION_API_KEY` is not read by this code. The write entry carries it for ticket 294's receipt command.

**The guard's two extra rules.** The write mode's rules (`decideWrite` in `src/write/guard-rules.ts`) are asked first, and what they do not match goes to 291's `decide`. They match a GET with no `params` to the by-id fetch form and a POST with no `params` to the update form, comparing the whole URL as written.

- `entity-by-id-write`: `GET https://quickbooks.api.intuit.com/v3/company/<R>/<purchase|bill|account|class>/<id>?minorversion=75`, with `<id>` of 1 to 20 digits. It needs a tool call and a realm the call may use. A request that carries `X-Api-Key` is refused `credential-crossing`, and one with a body `body`. (Contract §16 names this rule `entity-by-id`; the code's name is `entity-by-id-write`.)
- `write-update`: `POST` to `/v3/company/<R>/purchase` or `/v3/company/<R>/bill` with the query `operation=update&minorversion=75` in either order. It needs a tool call, the call's company, a realm the call may use and no `X-Api-Key`. The body must be a string that parses as a JSON object with a string `Id`, a string `SyncToken` and `sparse` equal to `true`. Last of all, it takes a capability. A body that is not JSON is refused `guard-error`.
- `reports` is refused in write mode. Anything else the rules do not match is decided as in read mode, and an exception inside a rule is `guard-error`.

**The capability** (`src/write/capability.ts`). It is bound to the company, the entity (`purchase` or `bill`) and the SHA-256 of the exact body text. It can be used once: `take` finds and removes an entry in one step, and only a `take` that finds one allows the request. It lives 60 seconds, measured on a clock that never goes back; it is expired at 60000 ms, and expired entries are dropped on each `register` and `take`. It is made only from a checked request: `register` throws `CapabilityError` for anything `preSend` did not make, and for a `dry` one. Several registrations of one body are separate entries, and each request uses one.

**What the adapter checks before the rules.** With extra rules installed (write mode only), the guard's adapter first checks what axios, Node or the backstop would change or refuse (`checkSendable` in `src/http-guard.ts`). A GET with a `Host` header is refused. Any other request may carry only `Authorization`, `Content-Type` and `Accept` (any case), with plain printable values, and `Content-Type` must be `application/json`; its `timeout`, when set, must be an integer from 0 to 2147483647. It also checks that the URL axios composes is the URL decided. Each failure is `guard-error`. All of this runs before the rules are asked, so a refused request consumes no capability: the capability is taken last, and nothing after an allow can refuse.

**The update is sent once.** `sendUpdate` in `src/write/client.ts` takes a checked request only (a `dry` one is refused, and so is one for another company's call). It POSTs the checked body text as it is, once, through the guarded axios instance, with a 15 second limit. The interceptors that resend a GET after a 401 or 429 resend no POST, and `sendUpdate` never sends again, whatever comes of it, a request that failed on the network included: its capability is used up before the request leaves. It answers any whole HTTP answer (status, parsed body and a valid `intuit_tid`) and rejects when there is none.

**The pre-send check** (`preSend` in `src/write/pre-send.ts`). It sends only GETs, through the guard, for the current call's company, and it is the only code that makes a checked request: the class is frozen and its constructor needs a private token. The rules run in this order, and the first to fail answers:

| Step | Reason | What is checked |
|------|--------|-----------------|
| size | `write:size` | A categorize call names more than 20 lines. Checked before any fetch. |
| inputs | `fork-error` | The call, company, entity, id, mode or lines are not as `preSend` is given them. |
| `beforeFetch` hook | the hook's reason | Runs before the first GET. |
| fetch | `write:not-found` | The transaction (a Fault 610 is `write:not-found`; any other failure is the failure 286 recorded, or `fork-error`) and the company's preferences. |
| type | `write:type` | The answer's one key is the asked entity's, and a Purchase has not `Credit: true`. |
| stacks-bill | `write:stacks-bill` | A Bill's `DocNumber` starts `Stacks_` or its `PrivateNote` starts `garden3d invoice`. |
| closed | `write:closed` | `BookCloseDate`, when present, is a real `YYYY-MM-DD` date before the transaction's `TxnDate`. A malformed one refuses. |
| line | `write:line` | See the modes below. |
| `afterLine` hook | the hook's reason | Runs after `line` and before `account`. |
| account | `write:account` | Each distinct account exists (Fault 610 is `write:account`); in categorize it is active and of type Expense, Other Expense or Cost of Goods Sold. |
| class | `write:class` | Each distinct class exists; in categorize it is active. |
| noop | `write:noop` | Categorize only: at least one named line's account or class would change. |
| body | `write:diff` | The body check below. |

The three modes are `categorize`, `undo` and `dry`. In `categorize`, every rule runs. In `undo`, `line` asks only that at least one line is given and that the fetched lines have unique ids; `account` and `class` ask only that each exists; `noop` is skipped. In `dry` no lines are given: `line` asks for at least one account-based line and unique ids, the accounts and classes checked are those on the fetched account-based lines, `account` and `class` ask only that each exists, and `noop` is skipped; and a `dry` checked request can neither register a capability nor be sent.

Any answer or input the check cannot read is `fork-error`, and so is a hook or rule that answers anything but `null` or a non-empty string.

**The body check.** The body is built from the fetched transaction: every field but `MetaData`, `sparse` set to `true`, the whole `Line` array in order, and in each named line `AccountRef` set to the new account and `ClassRef` set, removed (a `null` class) or left. `checkBody` then judges the text that will be sent, whatever made it. It must parse as an object with `sparse` true; every field but `Line` and `sparse` must equal the fetched one; the line count must be the same; an unnamed line must be equal; and a named line may differ only in its `AccountRef` and `ClassRef`, as asked. Each change must be made on a line of its own. Anything else is `write:diff`.

**The compare** (`src/write/compare.ts`). `digests` maps names to the SHA-256 of a value's canonical JSON (keys sorted by UTF-16 code unit at every depth, no white space): one for each top-level field except `SyncToken`, `MetaData`, `sparse` and `Line`; `Line` for the list of line ids in order; and `Line:<Id>` for each line with a string `Id`, with the named lines' `AccountRef` and `ClassRef` left out. `compare` (against the fetched copy) and `compareDigests` (against an intent's digests) give `{ same: true }` or `{ same: false, fields }`, the names sorted. A name is a field whose hash differs or is on one side only; `Line:<Id>` for a line that differs or is on one side only; `Line` when the line ids are in another order, a line has no string `Id` or shares one, or there is no list of lines; and `Line:<Id>.AccountRef` or `Line:<Id>.ClassRef` for a named line whose stored ref is not the intended one (an absent `ClassRef` reads as no class). The only things that may differ are `SyncToken`, `MetaData`, `sparse`, and a named line's two refs when they are the intended ones. A stored copy of any shape is read without throwing; what it cannot match, it names.

**The write probe.** `node dist/guard-probe.js --mode write <METHOD> <URL> --realm <R> [--body <file>] [--header <k:v>]... [--stacks-url <u>] [--key <k>]...` asks write mode's dry decision (`decideDry`) and sends nothing. `--mode` takes only `write`, given once; `--body` (a UTF-8 file, read exactly) and `--header` (once per name) are accepted only with `--mode`. It prints one line and exits:

- `allow <rule>`, exit 0.
- `allowed-with-capability write-update`, exit 0: every condition of an update holds but the capability, which the probe has no registry to check.
- `refuse <rule>`, exit 1.
- A usage error prints a line starting `usage:` to stderr and exits 2.

The probe asks the rules alone: it registers and consumes nothing, and it does not run the adapter's checks above. A request with a header the adapter refuses (anything but `Authorization`, `Content-Type` `application/json` and `Accept` on an update, or `Host` on a GET) can therefore be answered `allow`. Read the stdout line, as for the read probe.

```
$ node dist/guard-probe.js --mode write GET 'https://quickbooks.api.intuit.com/v3/company/123/purchase/5?minorversion=75' --realm 123
allow entity-by-id-write
```

**Known limits.**

- `Credit` refuses only `true`: a Purchase with `Credit: false`, or without the key, passes `type`.
- A number too long for JavaScript, or a duplicate key in a JSON answer, is re-sent as parsed: the answer is read with `JSON.parse`, and the body is built from that.
- The error `sendUpdate` rejects with holds the token and the body in its `config` (its `toJSON()` gives them). Never log or serialize it whole; read its `code` and `message` only.

---

## Directory Structure

```
src/
├── index.ts                    # MCP server entry point
│                               # - Registers the 31 allowlisted tools and `qbo_companies`, through startReadServer
│                               # - With QBO_MODE=write, imports ./write/mode.js and registers its five tools through startWriteServer
│                               # - Handles MCP protocol communication
│
├── clients/
│   ├── config.ts               # The five keys and their start refusals; the write server's four more
│   ├── companies.ts            # Parser for the QBO_COMPANIES file
│   ├── stacks-token.ts         # Stacks token client: keeps tokens, refetches
│   ├── company-state.ts        # Per-call preparation: token, first-use name check
│   ├── call-context.ts         # The per-call store (company, tokens, realm, failure)
│   ├── qbo-transport.ts        # QuickBooks 401 and 429 resends, limits, failures
│   ├── runtime.ts              # Joins the above for the tools
│   ├── bluebird-context.ts     # Keeps the call context across node-quickbooks promises
│   ├── guard-decide.ts         # The guard's pure decision; loads no network module
│   └── quickbooks-client.ts    # QuickBooks API client wrapper
│                               # - No sign-in; built from the call's token and realm
│
├── allowlist.ts                # Read allowlist, write tool list, refused keys, start checks
├── http-guard.ts               # HTTP guard, backstop and secureStart
├── guard-probe.ts              # Probe: asks decide (or, with --mode write, the dry decision) about one request, sends nothing
│
├── write/                      # Write mode only; loaded by index.ts when QBO_MODE=write
│   ├── mode.ts                 # Makes the registry, the guard's extra rules and the five tools
│   ├── stubs.ts                # The four write tools, not built yet
│   ├── guard-rules.ts          # The two extra guard rules and the dry decision
│   ├── capability.ts           # The capability registry
│   ├── pre-send.ts             # The pre-send check and the checked request
│   ├── rules.ts                # The pre-send rules, the sparse body and its check
│   ├── client.ts               # The fetches and the one update send
│   ├── compare.ts              # Digests and the compare
│   └── canonical.ts            # Canonical JSON and SHA-256
│
├── handlers/                   # Business logic layer
│   └── *.handler.ts            # Only handlers behind an allowlisted tool
│                               # are reachable
│
├── tools/                      # MCP tool definitions
│   └── *.tool.ts               # Zod schemas + tool metadata
│
├── helpers/
│   ├── format-error.ts         # Standardized error formatting
│   └── register-tool.ts        # Registers a read tool (RegisterTool) or a write tool (RegisterWriteTool)
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
- Calls `startReadServer` with the process environment, the server and the tool list, or, with `QBO_MODE=write`, `startWriteServer` with the write mode's tools
- Registers the 31 allowlisted read tools and `qbo_companies`, and nothing else (write mode: its five tools, and nothing else)
- Manages the MCP stdio transport

### 2. QuickBooks Client (`src/clients/quickbooks-client.ts`)

Wraps the `node-quickbooks` library, but has no sign-in. `QuickbooksClient.getInstance()` builds the instance from the current call's Stacks access token and realm. The OAuth flow, the auth server and the token store are removed, and the fork never holds or stores a refresh token, client id or client secret.

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
    // 2a. Get the client for this tool call (rejects only outside a tool call)
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
3. **Error Handling**: the call is prepared before the handler runs (see [Error Handling](#error-handling)); the handler handles the API callback's error, and a failure getting the client, which happens only outside a tool call
4. **Field Mapping**: Clean separation between snake_case inputs and PascalCase API

---

## Tool Registration

Tools are registered only through `startReadServer` or `startWriteServer` in `src/allowlist.ts`, called from `src/index.ts` (see [Read-only fork](#read-only-fork) and [Write mode](#write-mode)). Each tool definition connects:

1. Tool name (MCP protocol identifier, must be on the allowlist)
2. Description (shown to users)
3. Schema (Zod validation)
4. Handler (business logic)

---

## Error Handling

### Two Kinds of Error

```
┌─────────────────────────────────────────────────┐
│  Preparing the call fails                        │
│  • Stacks token request failures                │
│  • A refused company, a name mismatch           │
│  • A failed first-use name read                 │
│  Handled by: RegisterTool, before the handler   │
│  runs: it answers the error result at once      │
└─────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────┐
│  The QuickBooks call fails                       │
│  • Validation, not found, permission errors     │
│  • Network errors                               │
│  • A failed token refetch after a 401           │
│  Handled by: the callback's err parameter       │
└─────────────────────────────────────────────────┘
```

`RegisterTool` (`src/helpers/register-tool.ts`) prepares each call (the token, and on a company's first use the name check) before it runs the handler. A failure there answers the error result at once and the handler never runs. `QuickbooksClient.getInstance()` rejects only outside a tool call, so the handler's try/catch is left for that; a token failure on a 401's refetch is recorded on the call by the transport interceptor and comes back through the callback's `err`. The handler's own failures become `{ result: null, isError: true, error: formatError(...) }`; the result a tool call returns follows contract 1.1.

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
    -> the call context starts for the named company, and the token comes from Stacks
    -> the search handler calls QuickbooksClient.getInstance()
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

1. **No credentials in this server**: it holds no QuickBooks refresh token, client id or client secret; the token client gets an access token from Stacks and keeps it in memory until 5 minutes before it expires
2. **No sign-in material**: the server refuses to start if any of the four removed sign-in keys is present
3. **Redaction**: every access token the call held, and the Stacks key, are kept out of results, errors and logs; an `intuit_tid` that contains any of them is dropped
4. **Read only in read mode**: only the allowlisted read tools are registered; write mode registers exactly its five listed tools, and its four write tools are not built yet
5. **Input Validation**: Zod schemas validate all inputs

---

## Extending the Server

A new tool is exposed only if it is added to `READ_ALLOWLIST` in `src/allowlist.ts`, listed in `src/index.ts`, and covered by tests. That is a change to what the server exposes, so it is a deliberate change. The write, update and delete tools in `src/tools/` stay unregistered. The write server's tools are the separate list `WRITE_TOOLS` in `src/allowlist.ts`.
