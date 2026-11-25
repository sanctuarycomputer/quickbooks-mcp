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

This fork of the QuickBooks Online MCP Server is a Model Context Protocol (MCP) server with two modes. By default (`QBO_MODE` unset or `read`) it is a read-only server: it exposes a fixed list of QuickBooks Online read tools (reports and searches) to Claude Code and other MCP-compatible clients. See [Read-only fork](#read-only-fork). With `QBO_MODE=write` it is the write server, which registers five tools, and whose guard can allow one kind of update; its tools are not built yet, so nothing sends one. See [Write mode](#write-mode).

### Key Metrics

| Metric | Value |
|--------|-------|
| Registered tools | read mode: 32 (31 allowlisted read tools + `qbo_companies`); write mode: 5 (four write tools + `qbo_companies`) |
| Server mode | read (default) or write (`QBO_MODE=write`) |

---

## System Architecture

This is read mode. In write mode the registry holds the stubs in `src/write/stubs.ts` and `qbo_companies`, and no handler or QuickBooks client is reached by a tool. The write path's requests are in `src/write/client.ts`, which no tool calls yet; they go through the same HTTP guard.

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

In read mode (`QBO_MODE` unset or `read`) this fork registers read tools only. Write mode is a separate server, described under [Write mode](#write-mode); read mode loads nothing under `src/write`.

**The allowlist.** `READ_ALLOWLIST` in `src/tool-lists.ts` (exported again from `src/allowlist.ts`) lists 31 tool names (`get_*` reports and `search_*` queries). `COMPANIES_TOOL` is `qbo_companies`, which answers each loaded company's key and name. Together that is 32 registered tools.

**`startReadServer(env, server, tools)`** does these steps in order; steps 1 and 2 finish before any tool registers:

1. Refuse if any of the four refused keys is in the environment, or if the five-key configuration fails (see [Configuration](#configuration)).
2. Check the tool list against the allowlist: a duplicate name, a missing name or an unlisted name throws.
3. Register the tools.

Every failure is one error, `refused to start: <reason>`.

**Refused keys.** The four sign-in keys the fork removed, listed as `REFUSED_KEYS` in `src/allowlist.ts`. The start is refused when a key is present at all, even with an empty value. The value is never read or printed.

**Removed.** The OAuth sign-in flow, the auth server, the token store with its refresh and rotation, the switches that disabled write, update and delete tools, the attachable upload (its tool and handler) and the attachable file source.

**Unregistered, not removed.** The other create, update and delete tools and their handlers are still in `src/tools/` and `src/handlers/` as upstream wrote them, but nothing registers them: `src/index.ts` passes only the allowlisted tools to `startReadServer`, or only write mode's five to `startWriteServer`, and an unlisted name refuses either start.

**Tokens and companies.** The Stacks token client, the `company` argument on every read tool and the real `qbo_companies` answer are in place: see [Configuration](#configuration) and [Call flow](#call-flow). The HTTP guard is described under [HTTP guard](#http-guard).

---

## Configuration

`loadConfig` in `src/clients/config.ts` (in write mode, `loadWriteConfig`) reads and checks five keys, in this order, and throws at the first that fails. Two are also read before it: `isWriteMode` reads `QBO_MODE`, and `secureStart` gives `STACKS_QBO_URL` to the guard. A refusal reads `refused to start: <KEY> <reason>`, naming the key and never its value.

1. `STACKS_QBO_URL`: https, with no username, password, path, query or fragment.
2. `STACKS_QBO_TOKEN`: set and not empty. It is the `X-Api-Key` sent to Stacks.
3. `QUICKBOOKS_ENVIRONMENT`: set, and exactly `production`.
4. `QBO_COMPANIES`: the path of a readable entities file (`v` 1.0) whose companies each have a `stacks_key`, a `name` and `accepted_names` (the first is the name).
5. `QBO_MODE`: optional; unset or `read` is the read server. `loadConfig` refuses any other value it is given, the empty string included, with `refused to start: QBO_MODE is not read`. The write server is the one value `write` (see [Write mode](#write-mode)); its own loader, `loadWriteConfig`, reads the same five keys in this order and then four write keys.

`.env.example` lists them with placeholder values, the write keys commented out.

---

## Call flow

This is the read server's call. Steps 1 to 4 are `RegisterTool`'s; a write tool's call opens no call context, asks Stacks for nothing and checks no name before its handler, and the stub handlers do none of it either (see [Write mode](#write-mode)). Step 5 and, for a GET, step 6 hold in write mode too.

1. A tool call arrives with `company`, a key from `qbo_companies`.
2. The call context starts (`src/clients/call-context.ts`). It holds the call's company, tokens, realm and failure, and is not shared between calls. What is kept across calls is each company's token, realm, refusal and passed name check (`stacks-token.ts`, `company-state.ts`).
3. The access token comes from Stacks: `GET <STACKS_QBO_URL>/api/qbo/access_token?enterprise=<company>` with the `X-Api-Key` header and a 10 second timeout. A token the fork already keeps is used with no request until 5 minutes before its `expires_at`; then it is fetched again. The request is sent once more only when there was no answer, or the answer is not HTTP, or the status is one the mapping does not know (a 3xx, say), or a 403, 404, 409 or 502 has a body that is not Stacks' own. A 200 the fork cannot read is not asked again: it is a fork error, and so is a request the guard refused. A 403, 404, 409 or 502 with Stacks' own body is not asked again either.
4. On the first use per company, its QuickBooks name is checked against that company's `accepted_names` in `QBO_COMPANIES`. A mismatch is kept until restart.
5. Every request goes through the HTTP guard.
6. Every QuickBooks request has a 15 second limit. A GET answered 401: the token is refetched and the request is sent once more. A GET answered 429: the request is sent once more after `Retry-After` in whole seconds, at most 30 (2 when the header is missing or not whole seconds). Each resend is made once per request.
7. Results follow contract 1.1.

**Redaction.** Every access token the call held, and the Stacks key, are kept out of results, errors and logs. An `intuit_tid` that contains any of them is dropped.

---

## HTTP guard

Every request that leaves the server goes through one guard. It decides each request, sends only what it decided, and refuses the rest with a rule name.

**Where it hooks.** `node-quickbooks` requires the CommonJS `axios` instance, which is a different object from the fork's ESM `import axios`. `guardedAxios()` returns that CommonJS instance. `installGuard` sets the guard as its `defaults.adapter` and adds a request interceptor that refuses (`transport`) any request whose config names another adapter. `main()` in `src/index.ts` calls `secureStart(process.env, process.execArgv)`, which installs it, before any tool registers. In read mode that is the first thing `main()` does after testing `QBO_MODE`; in write mode the import of `./write/mode.js` and `writeMode()` come first, and `secureStart` is also given `{ extraRules }`.

**What it allows.** Contract 1.1 §6 in Stacksbot's `docs/contracts/quickbooks.md` is the rule set; this document does not restate it. The allow rules are `companyinfo`, `preferences`, `query`, `reports` and `stacks`. Every other request is refused with a rule name. This is read mode. Write mode adds the allow rules `entity-by-id-write` and `write-update`, asked first, and refuses `reports`: see [Write mode](#write-mode). The guard's own rule names are:

- `raw-text`: the URL spelling is one `new URL` would rewrite, or its head is not the exact allowed head.
- `dot-segments`: the raw path holds a `\`, a `%2e`, or a `.` or `..` segment.
- `stacks-config`: the configured Stacks URL breaks the contract's form, or has no usable hostname.
- `body`: the request has a body (in write mode, the update's body is allowed only by the `write-update` rule).
- `credential-crossing`: a QuickBooks request carries `X-Api-Key`, or a Stacks request carries `Authorization`.
- `guard-error`: an exception inside the guard, or the decided URL differs from the instance's own `getUri`. In write mode, also a check the adapter makes before the rules, and an update body that is not JSON.
- `transport`: the interceptor above.
- `backstop`: the backstop below.

`decide` lives in `src/clients/guard-decide.ts`. It loads no network module and sends nothing. The adapter and the probe both call it.

**Transport pins.** The guard sends only the decided URL, with no `params`. It sets `maxRedirects: 0`, `proxy: false` and its own `https.Agent({ rejectUnauthorized: true })`. From the request config it keeps `method`, `headers`, `responseType`, `timeout`, `transformRequest`, `transformResponse` and `validateStatus` (the `KEPT` list), each but `method` and `headers` only as an own property. Every other key is dropped, with one exception: for a request the `write-update` rule allowed (write mode only), the guard also sends the request's `data`, which is the whole update body. No other request is sent with a body. The guard passes the request's `timeout` through unchanged (in write mode, one it refuses for an update is named under [Write mode](#write-mode)). Every QuickBooks GET carries a 15 second limit (`QBO_LIMIT_MS` in `src/clients/qbo-transport.ts`), and `sendUpdate` sets the same one on the update; the Stacks token request sets its own 10 second timeout.

**The backstop.** `installBackstop()` replaces these on the module and global objects:

- `https.request` and `https.get` are wrapped. A call goes on only inside a single-use ticket whose method, hostname, port and path match the call's. The adapter issues the ticket for the one request it decided.
- `http.request`, `http.get`, `http2.connect`, `globalThis.fetch` and `globalThis.WebSocket` always refuse (`backstop`).

It then calls `syncBuiltinESMExports()`, so ESM imports of `node:http`, `node:https` and `node:http2` see the replacements. Each replacement carries the `Symbol.for('qbo-guard.backstop')` marker. If one cannot be replaced, it puts back the others and throws `qbo-guard: install failed`.

The backstop covers the HTTP paths above and nothing else. It is not a sandbox. It does not cover native addons, child processes, sockets opened directly with `net`, `tls` or `dgram`, or worker threads (a worker loads its own copies of these modules). It does not cover code that took a reference to an original function before the backstop was installed, or an HTTP client library that opens its own sockets.

**Start refusals.** `secureStart` refuses to start when any of these holds:

- `NODE_USE_ENV_PROXY` is set, with any value.
- `--use-env-proxy`, `--experimental-config-file` or `--experimental-default-config-file` is in `process.execArgv` or in `NODE_OPTIONS`, or Node's env proxy is on for `https.globalAgent` however it was turned on (reported as `--use-env-proxy`).
- `NODE_TLS_REJECT_UNAUTHORIZED` is `0`.
- `NODE_EXTRA_CA_CERTS` is set, with any value.

The refusal is one stderr line, `qbo-guard: start refused: <key>`, naming the key and never the value, and exit code 1. A failed install writes `qbo-guard: install failed` and exits 1. In both cases no tool is registered. A failed write mode import, which comes before both, stops the start too (see [Write mode](#write-mode)).

**Call scope.** `defaultCallScope()` returns the scope `secureStart` made. `defaultCallScope().run(fn)` starts one tool call with a fresh call record and no realm. `setRealm(r)` sets the realm for the current call. Outside a call, or before `setRealm`, every QuickBooks request is refused. `configureGuard({ keys, allowedRealm, callRecord })` replaces any of those three callbacks. It never replaces `stacksUrl`, which is `STACKS_QBO_URL` read once at start, nor the extra rules (asking throws). In both modes `createRuntime` replaces all three, so the server's keys are the configured companies' and its realm and call record are the current call's in `src/clients/call-context.ts`.

**The probe.** `node dist/guard-probe.js <METHOD> <URL> --realm <R> [--stacks-url <u>] [--key <k>]...` asks `decide` about one request. It prints `allow <rule>` and exits 0, or prints `refuse <rule>` and exits 1. A usage error prints a line starting `usage:` to stderr and exits 2. Read the stdout line, not the exit code alone: Node also exits 1 when it crashes (a closed stdout, a missing file), so a refusal is the line `refuse <rule>` with exit 1, and anything else (an empty stdout included, as when Node is pointed at a directory rather than the file) is a failed probe, never an allow. The probe sends nothing and imports only `guard-decide` and `write/guard-rules` (which adds `write/canonical` and `node:crypto`, and loads no network module either), plus `node:fs` and `node:url` to find its own path and read a `--body` file. In read mode it has no headers or body, so its answer covers method and URL only (`--mode write` is described under [Write mode](#write-mode)). Without `--stacks-url`, a Stacks request is refused (`refused`); `--stacks-url ''` stands for a `STACKS_QBO_URL` set but empty (`stacks-config`).

```
$ node dist/guard-probe.js GET 'https://quickbooks.api.intuit.com/v3/company/123/companyinfo/123?minorversion=75' --realm 123
allow companyinfo
$ node dist/guard-probe.js GET 'https://quickbooks.api.intuit.com/v3/company/123/customer/5?minorversion=75' --realm 123
refuse entity-by-id
```

---

## Write mode

Contract 1.1 §13 to §17 in Stacksbot's `docs/contracts/quickbooks.md` is the rule set for the words below; this section says what the code in `src/write/` does.

**Two modes.** `QBO_MODE` unset or `read` is the read server, unchanged. Exactly `write` is the write server (`isWriteMode` in `src/clients/config.ts`). Any other value, the empty string included, is not write mode, so `loadConfig` refuses it (`refused to start: QBO_MODE is not read`). The write server refuses to start unless each of the four write keys is set and not empty (see below).

The read server loads nothing under `src/write` (only the probe imports `src/write/guard-rules.ts`, and it sends nothing). In write mode, `main()` in `src/index.ts` imports `./write/mode.js` dynamically and calls `writeMode()` before `secureStart`, then passes the rules that call made to `secureStart` as `extraRules`. A failed import or `writeMode()` call stops the start the way a refusal does: the first line of the error (or `refused to start: the start failed with no message`) goes to stderr and the process exits 1, before any tool registers. `startWriteServer` then does what `startReadServer` does, the refused sign-in keys first, with `loadWriteConfig` and the write tool list; a write key is therefore checked after the guard is installed.

**The five tools.** `WRITE_TOOLS` in `src/allowlist.ts` lists them: `qbo_categorize_purchase`, `qbo_categorize_bill`, `qbo_undo_change`, `qbo_write_check` and `qbo_companies`. No read tool is registered. A missing, duplicate or unlisted name refuses the start before anything registers, as in read mode.

The four write tools are stubs (`src/write/stubs.ts`). They have the schemas and descriptions of contract §13, and each handler answers an error result with `reason: fork-error` and the text "This tool is not built yet." Ticket 294 builds the two categorize tools and the undo, and ticket 298 builds the write check. Until then nothing in the server calls `preSend`, registers a capability or calls `sendUpdate`, so the guard refuses every update.

`params` is strict. Every write tool takes a required `company` (an enum of the `QBO_COMPANIES` keys) and a required `params`. At start, `requireStrictParams` checks that `params` and every object inside it refuses an unknown key; a schema that does not (or holds a schema that can let any keys through: `z.lazy`, `any`, `unknown`, a custom schema such as `z.instanceof`, a bare transform or a `z.preprocess`, `.catch` or `z.success`; or holds schemas more than 32 deep, as a recursive one does, though a deep one that isn't is refused too) refuses the start with `refused to start: allowlist: params not strict <tool>`. What is let through and not judged: `.transform()` after a schema that is judged (its input is checked first), a schema's own checks such as `.refine` (they only take away from what it accepts), and a record's keys. A key inside `params` that the tool does not declare fails the schema, so it is the SDK's input error. A key beside `company` and `params` is stripped by the SDK, as in read mode: the handler sees only those two, and nothing says the key was dropped. `RegisterWriteTool` does not prepare the call: nothing is fetched from Stacks or sent to QuickBooks before the handler runs, and an error the handler throws is never read (an axios error carries the token and the body), so it answers `fork-error`.

**The write keys.** `loadWriteConfig` reads the five keys in the order under [Configuration](#configuration) (`QBO_MODE` must be `write`) and then these four, each set and not empty, else `refused to start: <KEY> is not set` or `<KEY> is empty`:

| Key | What it is |
|-----|------------|
| `QBO_WRITE_RECEIPT_CMD` | The receipt command. |
| `QBO_WRITE_SWITCH` | The path of the off switch's file. |
| `QBO_WRITE_LEDGER` | The path of `writes.jsonl`. |
| `QBO_WRITE_SWEEP_STAMP` | The path of the job sweep's stamp. |

The config holds each value as given; nothing in this code opens the files or runs the command yet. `NOTION_API_KEY` is not read by this code. The write entry carries it for ticket 294's receipt command.

**The guard's two extra rules.** The write mode's rules (`decideWrite` in `src/write/guard-rules.ts`) are asked first. Every POST with no `params` is theirs, whatever its URL: one that is not in the update form (another path, host, query or operation) is refused `write-update`, never by a read rule. A GET with no `params` is theirs when its whole URL, as written, is the by-id fetch form. They also refuse what `decide` would allow as `reports`. What they do not match goes to 291's `decide`.

- `entity-by-id-write`: `GET https://quickbooks.api.intuit.com/v3/company/<R>/<purchase|bill|account|class>/<id>?minorversion=75`, with `<id>` of 1 to 20 digits. It needs a tool call and a realm the call may use, else it is refused `entity-by-id-write`. A request that carries `X-Api-Key` is refused `credential-crossing`, and one with a body `body`. (Contract §16 names this rule `entity-by-id`; the code's name is `entity-by-id-write`.) A by-id GET in any other form (any other entity but the kept `companyinfo` form, another query key or another minor version) is refused by `decide`.
- `write-update`: `POST` to `https://quickbooks.api.intuit.com/v3/company/<R>/purchase` or `https://quickbooks.api.intuit.com/v3/company/<R>/bill` with the query `operation=update&minorversion=75` or `minorversion=75&operation=update`. It needs a tool call, the call's company and a realm the call may use. The body must be a string that parses as a JSON object with a string `Id`, a string `SyncToken` and `sparse` equal to `true`. Last of all, it takes a capability. Whatever fails is refused `write-update`, except that a request that carries `X-Api-Key` is refused `credential-crossing` and a body that is not JSON `guard-error`.
- `reports` is refused in write mode (`reports`). Anything else (a GET in any other form, another method, a request with `params`) is decided as in read mode, and an exception inside a rule is `guard-error`.

**The capability** (`src/write/capability.ts`). It is bound to the company, the entity (`purchase` or `bill`) and the SHA-256 of the exact body text. It can be used once: `take` finds and removes an entry in one step, and only a `take` that finds one allows the request. It lives 60 seconds, measured on a clock that never goes back; it is expired at 60000 ms, and expired entries are dropped on each `register` and `take`. It is made only from a checked request: `register` throws `CapabilityError` for anything `preSend` did not make, and for a `dry` one. Several registrations of one body are separate entries, and each request uses one.

**What the adapter checks before the rules.** With extra rules installed (write mode only), the guard's adapter first checks what axios, Node or the backstop would change or refuse (`checkSendable` in `src/http-guard.ts`). A GET with a `Host` header is refused. Any other request, to any URL, may carry only `Authorization`, `Content-Type` and `Accept` (any case), with string values of printable ASCII and tabs, and `Content-Type`, when present, must be exactly `application/json`; its `timeout`, when set, must be an integer from 0 to 2147483647. A request with no `params` must also have the URL axios composes as its URL. Each failure is `guard-error`, whatever rule the request would have met. All of this runs before the rules are asked, so a refused request consumes no capability: the capability is taken last, and nothing in the adapter after an allowed update refuses it.

**The update is sent once.** `sendUpdate` in `src/write/client.ts` takes a checked request only (a `dry` one is refused, and so is one for another company's call, or with no call that has a token and realm); its capability must be registered, else the guard refuses it. It POSTs the checked body text as it is, once, through the guarded axios instance, with a 15 second limit. The interceptors that resend a GET after a 401 or 429 resend no POST, and `sendUpdate` never sends again, whatever comes of it, a request that failed on the network included: its capability is used up before the request leaves. It answers any whole HTTP answer (status, parsed body, and an `intuit_tid` of the right form that holds no token of the call's) and rejects when there is none, an answer cut off in its body included.

**The pre-send check** (`preSend` in `src/write/pre-send.ts`). It sends only GETs, through the guard, for the current call's company, and it is the only code that makes a checked request: the class is frozen and its constructor needs a private token. The rules run in this order, and the first to fail answers:

| Step | Reason when it fails | What must hold |
|------|--------|-----------------|
| size | `write:size` | A categorize call names at most 20 lines. Checked before any fetch. |
| inputs | `fork-error` | A call is open for the company; the entity is `purchase` or `bill`; the id is 1 to 20 digits; the mode is one of the three; and the lines are a list whose `line_id`, `account_id` and any non-null `class_id` are each 1 to 20 digits (in `dry`, no lines). |
| `beforeFetch` hook | the hook's reason | Runs before the first GET. |
| fetch | `write:not-found` | The transaction is fetched, then the company's preferences. A Fault 610 on the transaction, in any HTTP status, is `write:not-found`. Any other failed GET is the failure 286 recorded, or `fork-error`. The transaction must have the asked `Id`, a string `SyncToken`, a string `TxnDate` and a `Line` list, and the preferences an `AccountingInfoPrefs` object, else `fork-error`. |
| type | `write:type` | The answer's one key, `time` aside, is the asked entity's, and a Purchase has not `Credit: true`. |
| stacks-bill | `write:stacks-bill` | A Bill's `DocNumber` does not start `Stacks_` and its `PrivateNote` does not start `garden3d invoice` (both case-sensitive). |
| closed | `write:closed` | `BookCloseDate`, when present, and the transaction's `TxnDate` are each a real `YYYY-MM-DD` date, and `TxnDate` is after `BookCloseDate`. With the key present, a `BookCloseDate` or a `TxnDate` that is not such a date refuses (`null` and the empty string too), and so does a `TxnDate` equal to the close date. With no `BookCloseDate` key, nothing is asked of either. |
| line | `write:line` | In categorize: at least one line is named and none twice; each named `line_id` is a fetched line whose `DetailType` is `AccountBasedExpenseLineDetail`; and every fetched line, named or not, has a non-empty string `Id` that no other fetched line shares. Undo and dry ask less: see the modes below. |
| `afterLine` hook | the hook's reason | Runs after `line` and before `account`. |
| account | `write:account` | Each distinct account is fetched and exists (Fault 610 is `write:account`); in categorize its `Active` is `true` and its `AccountType` is `Expense`, `Other Expense` or `Cost of Goods Sold`. |
| class | `write:class` | Each distinct class set by a named line is fetched and exists (Fault 610 is `write:class`); in categorize its `Active` is `true`. A kept (absent) or cleared (`null`) class is not fetched. |
| noop | `write:noop` | Categorize only: at least one named line's account or class would change (an absent `class_id` changes no class; an absent `ClassRef` is no class). |
| body | `write:diff` | The body check below. |

The three modes are `categorize`, `undo` and `dry`. In `categorize`, every rule runs. In `undo`, `size` is skipped; `line` asks only that at least one line is given and that every fetched line has a non-empty string `Id` that no other shares (a given line that is not a fetched account-based line, or is given twice, is refused by the body check); `account` and `class` ask only that each exists; `noop` is skipped. In `dry` no lines are given, so `size` does not apply: `line` asks for at least one account-based line and, as in `undo`, that every fetched line has a non-empty string `Id` that no other shares; the accounts and classes checked are those on the fetched account-based lines, `account` and `class` ask only that each exists, and `noop` is skipped; and a `dry` checked request can neither register a capability nor be sent.

Any answer or input the check cannot read is `fork-error` (a 2xx answer that is not an object or has a `Fault` other than the 610s above, a transaction answer with no entity, an account or class that is not the one asked for, or whose `Active` or `AccountType` is missing or of another type where categorize reads it). So is a hook or rule that answers anything but `null` or a non-empty string, and anything unexpected that is thrown.

**The body check.** The body is built from the fetched transaction: every field but `MetaData`, `sparse` set to `true`, the whole `Line` array in order, and in each named line `AccountRef` set to the new account and `ClassRef` set, removed (a `null` class) or left. `checkBody` then judges the text that will be sent, whatever made it. It must parse as an object with `sparse` true; it must hold no `MetaData`, not even the fetched one unchanged; every other field but `Line` and `sparse` must equal the fetched one, with none added or left out; `Line` must be a list of the same length, in the same order; an unnamed line must be equal; and a named line must be account-based and may differ only in its `AccountRef`, which must be exactly `{ value: <account_id> }`, and its `ClassRef`, which must be exactly `{ value: <class_id> }`, absent for `null`, or the fetched one when no `class_id` was given. Each change must be made on a line of its own. Anything else is `write:diff`, but a text that is not JSON is `fork-error`.

**The compare** (`src/write/compare.ts`). `digests` maps names to the SHA-256 of a value's canonical JSON (keys sorted by UTF-16 code unit at every depth, no white space): one for each top-level field except `SyncToken`, `MetaData`, `sparse` and `Line`; `Line` for the list of line ids in order; and `Line:<Id>` for each line with a string `Id`, with the named lines' `AccountRef` and `ClassRef` left out. `compare` (against the fetched copy) and `compareDigests` (against an intent's digests) give `{ same: true }` or `{ same: false, fields }`, the names sorted. A name is a field whose hash differs or is on one side only, or any stored field whose own name starts `Line:`; `Line:<Id>` for a line that differs or is on one side only; `Line` when the line ids differ with no line on one side only (another order, say), when a stored line has no string `Id` or shares one, or when there is no stored list of lines and no missing line is named; and `Line:<Id>.AccountRef` or `Line:<Id>.ClassRef` for a named line whose stored ref's `value` is not the intended one (an absent `ClassRef` reads as no class; a change with no `class_id` intends the fetched class). The only things that may differ are `SyncToken`, `MetaData`, `sparse`, and a named line's two refs when they are the intended ones. A stored copy of any shape is read without throwing; what it cannot match, it names.

**The write probe.** `node dist/guard-probe.js --mode write <METHOD> <URL> --realm <R> [--body <file>] [--header <k:v>]... [--stacks-url <u>] [--key <k>]...` asks write mode's dry decision (`decideDry`) and sends nothing. `--mode` takes only `write`, given once; `--body` (a UTF-8 file, read exactly, given once) and `--header` (once per name) are accepted only with `--mode`. It prints one line and exits:

- `allow <rule>`, exit 0.
- `allowed-with-capability write-update`, exit 0: every condition of an update holds but the capability, which the probe has no registry to check.
- `refuse <rule>`, exit 1.
- A usage error prints a line starting `usage:` to stderr and exits 2.

The probe asks the rules alone: it registers and consumes nothing, and it does not run the adapter's checks above. A request with a header the adapter refuses (anything but `Authorization`, `Content-Type` `application/json` and `Accept` on an update, or `Host` on a GET) can therefore be answered `allow` or `allowed-with-capability` and still be refused by the server. Read the stdout line, as for the read probe.

```
$ node dist/guard-probe.js --mode write GET 'https://quickbooks.api.intuit.com/v3/company/123/purchase/5?minorversion=75' --realm 123
allow entity-by-id-write
```

**Known limits.**

- `Credit` refuses only `true`: a Purchase with `Credit: false`, or without the key, passes `type`.
- A number too long for JavaScript, or a duplicate key in a JSON answer, is re-sent as parsed: the answer is read with `JSON.parse`, and the body is built from that.
- The error `sendUpdate` rejects with holds the token and the body in its `config` (its `toJSON()` gives them). Never log or serialize it whole; read its `code` and `message` only. `fetchById` and `fetchPreferences` reject with such an error too (with the token and no body) when a GET gets no answer; `preSend` never reads it.
- `sendUpdate` does not check an `intuit_tid` for `STACKS_QBO_TOKEN`, which is never sent to QuickBooks.

---

## Directory Structure

```
src/
├── index.ts                    # MCP server entry point
│                               # - Registers the 31 allowlisted tools and `qbo_companies`, through startReadServer
│                               # - Imports ./write/mode.js only with QBO_MODE=write, then registers its five tools through startWriteServer
│                               # - Handles MCP protocol communication
│
├── clients/
│   ├── config.ts               # The five keys and their start refusals; the write server's four more
│   ├── companies.ts            # Parser for the QBO_COMPANIES file
│   ├── stacks-token.ts         # Stacks token client: keeps tokens, refetches
│   ├── company-state.ts        # Per-call preparation: token, first-use name check
│   ├── call-context.ts         # The per-call store (company, tokens, realm, failure)
│   ├── qbo-transport.ts        # QuickBooks 401 and 429 resends, limits, failures
│   ├── runtime.ts              # Joins the above for either server's tools
│   ├── bluebird-context.ts     # Keeps the call context across node-quickbooks promises
│   ├── guard-decide.ts         # The guard's pure decision; loads no network module
│   └── quickbooks-client.ts    # QuickBooks API client wrapper
│                               # - No sign-in; built from the call's token and realm
│
├── allowlist.ts                # Write tool list, refused keys, start checks, both servers' starts
├── tool-lists.ts               # The read allowlist and the companies tool's name
├── http-guard.ts               # HTTP guard, backstop and secureStart
├── guard-probe.ts              # Probe: asks decide (or, with --mode write, the dry decision) about one request, sends nothing
│
├── write/                      # Write mode only; loaded by index.ts when QBO_MODE=write (guard-probe.ts loads guard-rules.ts and canonical.ts)
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
│   ├── build-quickbooks-search-criteria.ts  # Search criteria for the search handlers
│   ├── format-error.ts         # Standardized error formatting
│   ├── name-fold.ts            # The company name fold and the reported name rule
│   ├── register-tool.ts        # Registers a read tool (RegisterTool) or a write tool (RegisterWriteTool)
│   ├── tool-result.ts          # Tool results and error results
│   └── validate-input.ts       # Input checks for the read tools
│
├── types/
│   ├── node-quickbooks.d.ts    # Types for node-quickbooks
│   ├── tool-definition.ts      # Read tool definition type
│   └── tool-response.ts        # Response type definitions
│
└── server/
    └── *.ts                    # Server utilities
```

---

## Core Components

### 1. MCP Server Entry Point (`src/index.ts`)

The main server file:
- Loads the write mode modules when `QBO_MODE` is `write`, and calls `secureStart` (with write mode's rules, if loaded)
- Initializes the MCP server
- Calls `startReadServer` with the process environment, the server and the tool list, or, with `QBO_MODE=write`, `startWriteServer` with the write mode's tools
- Registers the 31 allowlisted read tools and `qbo_companies`, and nothing else (write mode: its five tools, and nothing else)
- Manages the MCP stdio transport

### 2. QuickBooks Client (`src/clients/quickbooks-client.ts`)

Wraps the `node-quickbooks` library, but has no sign-in. `QuickbooksClient.getInstance()` builds the instance from the current call's Stacks access token and realm. The OAuth flow, the auth server and the token store are removed, and the fork never holds or stores a refresh token, client id or client secret. Write mode's own fetches and its update do not use it: `src/write/client.ts` sends them through the guarded axios instance.

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

Write mode's four tools are in `src/write/stubs.ts`. Each definition carries its handler (the four share one until they are built), and there is no file under `src/handlers` for them; `qbo_companies` is shared with the read server.

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

1. Tool name (MCP protocol identifier, must be on the running mode's list: `READ_ALLOWLIST` or `WRITE_TOOLS`, with `qbo_companies` in both modes)
2. Description (shown to users)
3. Schema (Zod validation; `qbo_companies` has none, and a write tool's `params` must be strict)
4. Handler (business logic)

---

## Error Handling

### Two Kinds of Error

This section is the read server's. A write tool is registered by `RegisterWriteTool`, which prepares no call and answers `fork-error` for anything its handler throws.

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

All handlers in `src/handlers` return a consistent `ToolResponse<T>`:

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

**Searching customers (`search_customers`, read mode):**

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

1. **Minimal Payloads**: A read sends no body. Write mode's one update is a sparse update, but carries every fetched field except `MetaData`, and the whole `Line` array (see [Write mode](#write-mode))
2. **No Polling**: Direct request/response pattern

---

## Security

1. **No credentials in this server**: it holds no QuickBooks refresh token, client id or client secret; the token client gets an access token from Stacks and keeps it in memory until 5 minutes before it expires
2. **No sign-in material**: the server, in either mode, refuses to start if any of the four removed sign-in keys is present
3. **Redaction**: every access token the call held, and the Stacks key, are kept out of results, errors and logs; an `intuit_tid` that contains any of them is dropped. Inside write mode's code, the errors its requests reject with do hold the token, and `sendUpdate` checks an `intuit_tid` for the call's tokens only (see Known limits under [Write mode](#write-mode))
4. **Read only in read mode**: only the allowlisted read tools are registered; write mode registers exactly its five listed tools, and its four write tools are not built yet
5. **Input Validation**: Zod schemas validate all inputs

---

## Extending the Server

A new tool is exposed only if it is added to `READ_ALLOWLIST` in `src/tool-lists.ts`, listed in `src/index.ts`, and covered by tests. That is a change to what the server exposes, so it is a deliberate change. The write, update and delete tools in `src/tools/` stay unregistered. The write server's tools are the separate list `WRITE_TOOLS` in `src/allowlist.ts`, and `writeMode()` in `src/write/mode.ts` gives the tools themselves.
