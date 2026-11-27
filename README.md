<!-- Changed by Sanctuary Computer (quickbooks-mcp-285, quickbooks-mcp-286, quickbooks-mcp-293, quickbooks-mcp-294): describes the read-only fork and its write mode. -->
# QuickBooks Online MCP Server

## This fork

This is Sanctuary Computer's fork of the QuickBooks Online MCP server. It starts as a read-only server, and with `QBO_MODE=write` as a write server (see [Write mode](#write-mode)).

- By default it is read only. It registers 31 read tools (listed under [Available Tools](#available-tools)) and `qbo_companies`. Nothing else is registered: no create, update or delete tools. Write mode registers five tools instead: the three write tools (`qbo_categorize_purchase`, `qbo_categorize_bill` and `qbo_undo_change`) and `qbo_companies` are built, and `qbo_write_check` is still a stub.
- There is no sign-in in this fork, and it never holds or stores a QuickBooks refresh token, client id or client secret. It gets an access token for the company a call names from Stacks, and keeps it in memory until 5 minutes before it expires (see [Configuration](#configuration) and [How a call works](#how-a-call-works)).
- Every read tool takes a required `company`. `qbo_companies` lists the company keys and names you can pass.
- Files this fork changed carry a "Changed by Sanctuary Computer (quickbooks-mcp-NNN)" notice, and files it added a "Sanctuary Computer (quickbooks-mcp-NNN)" one, where NNN is the ticket that made the change (285, 286, 291, 293 or 294), where the format allows a comment (source, tests, `jest.config.js`, the docs and `.env.example`); `package.json` and `package-lock.json` can't hold one, and the fork's pull request lists their changes. Deleted files are listed there too.
- Licence mismatch: `LICENSE` holds the Apache-2.0 text (with "January 2025" typed for "January 2004" and a filled-in "Copyright 2025 Intuit, Inc."), while `package.json` says MIT. This fork leaves both as they are. See the ticket 283 fork review.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the start check, the token client and the guard work.

---

## Overview

In its default mode this MCP server exposes read-only access to QuickBooks Online (reports and searches) to Claude Code and other MCP-compatible clients. It runs as a local stdio subprocess.

---

## Quick Start

### Installation

```bash
# Clone the repository
git clone <this repository's URL>
cd quickbooks-mcp

# Install dependencies
npm install

# Build the project
npm run build
```

### Configuration

The read server reads five keys from its environment; the write server reads the same five and four more (see [Write mode](#write-mode)). `.env.example` lists them with placeholder values.

| Key | Required | What it is |
|-----|----------|------------|
| `STACKS_QBO_URL` | yes | The Stacks origin. https only; no username, password, path, query or fragment. |
| `STACKS_QBO_TOKEN` | yes | The key sent to Stacks in the `X-Api-Key` header. |
| `QBO_COMPANIES` | yes | The path of the entities file (`v` 1.0) listing the companies by `stacks_key`, `name` and `accepted_names`. |
| `QUICKBOOKS_ENVIRONMENT` | yes | Must be `production`. |
| `QBO_MODE` | optional | Unset or `read` is the read server. `write` is the write server (see [Write mode](#write-mode)). Any other value refuses. |

The server refuses to start when any of these holds. The key refusals read `refused to start: <KEY> <reason>`; they name the key and never print its value.

Key refusals:

- `STACKS_QBO_URL` is not set, is empty, is not a URL, is not https, or has a username, password, path, query or fragment;
- `STACKS_QBO_TOKEN` is not set or is empty;
- `QUICKBOOKS_ENVIRONMENT` is not set or is not `production`;
- `QBO_COMPANIES` is not set, is unreadable, or its file is not a valid entities file;
- `QBO_MODE` is set to anything but `read` or `write`, the empty string included;
- in write mode, any of the four write keys is not set or is empty;
- any of the four QuickBooks sign-in keys the fork removed is present in the environment, even empty (the list is `REFUSED_KEYS` in `src/allowlist.ts`).

Other refusals:

- the tools given to register do not match the running mode's list (`refused to start: allowlist: <duplicate, missing or unlisted> <tool>`, which names no key), or in write mode a tool's `params` would accept an unknown key (`refused to start: allowlist: params not strict <tool>`);
- in write mode, the write modules cannot be loaded (the first line of the error);
- the process environment is unsafe for the guard: a proxy (`NODE_USE_ENV_PROXY`, `--use-env-proxy` or a config-file flag), `NODE_TLS_REJECT_UNAUTHORIZED=0` or `NODE_EXTRA_CA_CERTS`. These read `qbo-guard: start refused: <key>`, and a guard that cannot be installed reads `qbo-guard: install failed` (see [HTTP guard](docs/ARCHITECTURE.md#http-guard)).

### Claude Code Integration

Add to your Claude Code MCP configuration:

```json
{
  "mcpServers": {
    "quickbooks": {
      "command": "node",
      "args": ["path/to/quickbooks-mcp/dist/index.js"]
    }
  }
}
```

Put the five keys above in the `env` block of that entry, and for the write server the four write keys too (see [Write mode](#write-mode)).

---

## Available Tools

In read mode the server registers these 31 read tools and `qbo_companies`, and nothing else. It checks this list at start, before it registers any tool. Write mode registers its own five tools instead (see [Write mode](#write-mode)). Every read tool takes a required `company`, a key from `qbo_companies`. `qbo_companies` takes no argument and lists each company's key and name, in file order.

- `get_aged_payables`
- `get_aged_receivables`
- `get_balance_sheet`
- `get_cash_flow`
- `get_company_info`
- `get_customer_balance`
- `get_customer_sales`
- `get_general_ledger`
- `get_preferences`
- `get_profit_and_loss`
- `get_trial_balance`
- `get_vendor_balance`
- `get_vendor_expenses`
- `search_accounts`
- `search_bill_payments`
- `search_bills`
- `search_classes`
- `search_credit_memos`
- `search_customers`
- `search_departments`
- `search_deposits`
- `search_employees`
- `search_invoices`
- `search_items`
- `search_journal_entries`
- `search_payments`
- `search_purchases`
- `search_sales_receipts`
- `search_transfers`
- `search_vendor_credits`
- `search_vendors`
- `qbo_companies`

---

## Write mode

With `QBO_MODE=write` the server is the write server. It registers five tools and no read tool: `qbo_categorize_purchase`, `qbo_categorize_bill`, `qbo_undo_change`, `qbo_write_check` and `qbo_companies`. The first three change books (see [The three write tools](#the-three-write-tools)); `qbo_write_check` is not built yet (ticket 298) and answers `reason: fork-error` ("This tool is not built yet."). The write server needs the five keys above and four more, and refuses to start without them. The read server loads nothing under `src/write` and ignores these keys. `.env.example` lists them, commented out. The rules for every word below are contract 1.2 §13 to §20 (`docs/contracts/quickbooks.md` in Stacksbot).

| Key | Required in write mode | What it is |
|-----|------------------------|------------|
| `QBO_WRITE_RECEIPT_CMD` | yes | The receipt command: a program and its arguments, split on single spaces and run with no shell (see [The receipt command](#the-receipt-command)). |
| `QBO_WRITE_SWITCH` | yes | The path of the switch file (see [The switch file](#the-switch-file)). |
| `QBO_WRITE_LEDGER` | yes | The path of `writes.jsonl`. It is handed to the receipt command; this server never opens it. |
| `QBO_WRITE_SWEEP_STAMP` | yes | The path of the job sweep's stamp (see [The sweep stamp](#the-sweep-stamp)). |
| `NOTION_API_KEY` | no | Read once at start, as given, and passed to the receipt command when set. |
| `TZ` | no | Read once at start, as given, and passed to the receipt command when set. |
| `PATH` | no | The server's own `PATH`, read once at start, as given, and passed to the receipt command when set. |

A write key that is not set or is empty refuses the start: `refused to start: <KEY> is not set` or `<KEY> is empty`. The three keys that are passed on never refuse a start, set or not. See [Write mode](docs/ARCHITECTURE.md#write-mode) in the architecture document for the guard rules, the capability, the pre-send check, the compare, the send and the settling.

### The three write tools

Each takes a required `company` and a required `params`. `qbo_categorize_purchase` and `qbo_categorize_bill` take `params` `{ id, lines: [{ line_id, account_id, class_id? }], reason }`: they move the named expense lines of one Purchase or Bill to another account, and optionally another class (`class_id: null` clears it; leaving it out keeps the line's class). `qbo_undo_change` takes `params` `{ receipt }`: the receipt key a categorize result gave, which puts each line's earlier account and class back. A tool stops at the first check that fails and answers that reason (`write:size`, `write:sweep` and so on); nothing after it runs.

**Categorize runs these checks, in this order** (contract §15):

1. Size: at most 20 lines (`write:size`). Nothing is fetched.
2. The sweep stamp is clean and fresh (`write:sweep`).
3. The switch file exists (`write:disabled`).
4. The call is opened and prepared: Stacks gives the company's token, and on the company's first use its QuickBooks name is checked. A failure answers its 1.0 reason.
5. The pre-send check (`preSend`): the transaction and the company's preferences are fetched fresh; then its type, `stacks-bill`, closed books, its lines, each new account (an Expense, Other Expense or Cost of Goods Sold account, its type exactly that as QuickBooks gives it, that is active; a type refused only for stray spaces or control characters is shown JSON-quoted), each new class (active), that some line really changes, and that the request to send differs from the transaction only in the named lines' refs (`write:not-found`, `write:type`, `write:stacks-bill`, `write:closed`, `write:line`, `write:account`, `write:class`, `write:noop`, `write:diff`). Only GETs are sent.
6. The names of the accounts and classes the receipt will carry: one GET per account or class id, for each ref not already read in step 5. A name that is not a non-empty string, or a deleted account or class (Fault 610, in any status), answers `fork-error`; any other failure answers the reason the call recorded (`http-<status>` for a failed status, `fork-error` for a 2xx that holds a Fault).
7. The switch file is looked at again (a `sent-diff` in another call may have deleted it meanwhile): off answers `write:disabled`, with no intent.
8. The intent: the receipt command is asked to record what is about to be sent (see [The receipt command](#the-receipt-command)). Only an answer that is exactly ok goes on; a cap is `write:cap`, anything else `write:receipt-failed`, and nothing was sent.
9. The update is registered with the guard, once, and sent once. It is never sent again, an answer of 401 or 429 included.
10. The answer is read (below).

**Undo runs these checks, in this order** (contract §18): the sweep stamp (`write:sweep`); the receipt key's company is the call's, and the receipt command's `lookup` of exactly that attempt answers ok (`write:not-sent` for an unknown key or another company's, `write:receipt-failed` for any other not-ok answer); the attempt is not itself an undo (`write:undo-of-undo`); an attempt whose latest outcome is `unknown`, or which has none, is settled first (see [Settling](#settling)), and an age under 10 minutes or a settle that leaves it unknown answers `write:unknown`; the latest outcome is `sent` or `sent-diff` (else `write:not-sent`); the call is prepared; then the pre-send check with the intent's earlier values as the changes (`write:not-found`, `write:type`, `write:stacks-bill`, `write:closed`, `write:line`, `write:changed-since` when a line no longer holds what the change set, `write:account` or `write:class` when a before value no longer exists, `write:diff`); then the undo's own intent (it names `undo_of`, is never counted against the daily cap, and a `write:cap` answer is a `write:receipt-failed`), and the one send. An undo ignores the switch file, so a `sent-diff` can be put back at once. It still needs the sweep stamp.

**After the send, the answer is read** (contract §17, in this order): a Fault `5010` is `write:stale`; `6200` or `6210` is `write:closed`; any other Fault is `write:failed`; a Fault decides in any HTTP status, whatever else the body holds. A Fault whose first code is not 1 to 64 characters of letters, digits, `_` and `-` is no answer, even beside the entity: the refetch below decides. With no Fault, a 2xx that holds the entity with the sent `Id` and a SyncToken of 1 to 20 digits is stored, and what QuickBooks stored is compared with what was asked: the same is `sent`, and a difference is `sent-diff`, which names the fields and deletes the switch file. An entity with another `Id` deletes the switch file too (`note: id-mismatch`). Anything else, and any failure to get an answer, is no answer: the server reads the transaction once at once, and a SyncToken that moved with every named line holding its new values is stored; anything else is `write:unknown`. After an update answered 401 the server takes a new Stacks token for the call before it reads anything else; if it can't, or the token is for another realm, no refetch is made, so an answer that decided nothing is `write:unknown`.

From the send on, every result carries `receipt:` with the attempt key, and records its outcome with the receipt command. A header `recorded: ledger` or `recorded: none` says the outcome reached the ledger only, or that the server had no confirmation. A failure after the send never says "nothing was sent": it answers `write:unknown`. When a later step fails after the outcome was decided as something other than `unknown` (the result can't be written, say), that `write:unknown` says what was decided instead of "QuickBooks didn't answer", with one of four texts: "QuickBooks stored the change." (`sent`), "QuickBooks stored the change, with differences from what was asked." (`sent-diff`), "QuickBooks refused the change: the transaction had changed since it was read." (`stale`) or "QuickBooks refused the change." (`failed`), each followed by "Its outcome, <outcome>, was recorded; this result couldn't be written." ("wasn't confirmed recorded" with `recorded: none`). See [Decided texts after a throw](docs/ARCHITECTURE.md#the-three-write-tools) in the architecture document.

### The receipt command

`QBO_WRITE_RECEIPT_CMD` is run as a child process, with no shell: the value is split on single spaces, the first word is the program. It gets one JSON request on stdin and must print one JSON object on stdout and exit 0; anything else is not ok. Its environment is only `NOTION_API_KEY`, `QBO_WRITE_LEDGER`, `PATH` and `TZ` (`NOTION_API_KEY`, `PATH` and `TZ` only when the server was started with them; never `STACKS_QBO_TOKEN`, `QBO_COMPANIES` or `HOME`). It is killed with `SIGKILL` after 20 seconds, or if it prints more than 1 MiB. Every answer is read strictly: the intent must be exactly `{ ok: true, key, n }` for this call's transaction and SyncToken, or nothing is registered or sent.

The server asks it for an **intent** before any send (what is about to be changed, the transaction's digests and the reason), and for an **outcome** after it, once for each attempt of the call. The intent comes first, always: a crash between the two leaves an intent with no outcome, which is settled later.

### The switch file

`QBO_WRITE_SWITCH` is a file whose presence switches categorizing on. It must be a regular file; one that is missing, a directory, or can't be `stat`ed counts as absent. Absent, categorize answers `write:disabled` and does nothing else. Undo runs without it.

The server deletes the file itself on a `sent-diff` (answered, or found later when an unknown is settled) and on an `id-mismatch`: categorizing stops until someone looks. A success then says `writes_off: true`; an `id-mismatch` that ends in `write:unknown` is an error, which has no `writes_off` key (contract §14): its `note: id-mismatch` and its text ("writes are switched off") say it. If the file can't be deleted (anything but "it is already gone"), a success says `writes_off: false`, the server writes one line to stderr, and an in-process latch refuses every later categorize call with `write:disabled` until the server restarts, whatever the file says. A file already gone deletes nothing either, so a success says `writes_off: false` then too. A deleted file that is recreated switches categorizing on again at once; a restart reads the file again, so the latch does not outlast one.

When undo settles an earlier unknown as `sent-diff` (its step 4), that deletion is the settle's, not the undo's own attempt's, so it never changes the undo's `writes_off`. Every result the undo gives after it, success or error, ends instead with "Writes are switched off." once (an error's text gains it after a space; a success gains a `WARNING: Writes are switched off.` item after its data item). If the settle couldn't delete the file (the latch), the sentence is "The switch file couldn't be deleted; delete it by hand." instead; if the file was already gone, there is none. These are sentences beyond the spec's text table, added so the session is always told. An undo whose own answer is a `sent-diff` or an `id-mismatch` after its settle deleted the file finds the file gone; it still says `writes_off: true`, as contract §14 asks, since this server deleted it in this call. When the undo's own answer then tries to delete the file too, the sentence follows what the file shows after that, not the settle: deleted ("Writes are switched off.", once, even after a latched settle), still there (the by-hand sentence, even after the settle deleted it and the file came back), or gone (none).

**When a result says `writes_off: false` after a `sent-diff`, or ends "The switch file couldn't be deleted; delete it by hand.", delete the switch file by hand.** The server stopped categorizing in this process only; the file is still there, and the next restart would read it and start categorizing again. (After a `sent-diff` whose file was already gone the result says `writes_off: false` too, and there is nothing to delete.)

### The sweep stamp

`QBO_WRITE_SWEEP_STAMP` is a JSON file the job guard writes at the end of each run: `{ v: 1, at, clean, jobs, reason? }`. Categorize and undo read it on every call and answer `write:sweep` unless it is clean and at most 20 minutes old (exactly 20 minutes passes). A stamp that is missing, unreadable, not exactly that shape, version 2, unclean, or dated more than 60 seconds ahead also answers `write:sweep`.

### Settling

An attempt whose latest outcome is `unknown`, or which has an intent and no outcome, is settled by undo. It waits until at least 10 minutes have passed since the `unknown` outcome (or the intent, with no outcome): under that, undo answers `write:unknown` and fetches nothing. After that the ledger and a read of the transaction decide, in this order: another attempt on the same SyncToken that was stored, or a later intent one SyncToken ahead that doesn't build on this one: `failed`; two or more ahead: `unsettled`; the transaction deleted: `unsettled`; no answer from QuickBooks, or any other Fault: still unknown; the SyncToken not moved: `failed`; moved by one with the new values: `sent` or, with differences, `sent-diff`; moved by more than one with the new values: `sent` with `note: edited-since`; anything else: `unsettled`. A settled `sent-diff` deletes the switch file, and the undo's result then says so (see [The switch file](#the-switch-file)). The settled outcome is recorded with the receipt command, and undo goes on only when that was recorded.

### Contract 1.2's differences from 1.1

- The guard rule for GETs by id in write mode is named `entity-by-id-write` (1.1's §16 said `entity-by-id`, which is the read server's rule).
- A stored copy whose lines lack a string `Id`, share one, or have no `Line` array is named `Line` by the compare (the code already did; 1.1's table left the case out).
- An intent's digests are sent with their keys in code-unit order.
- A Fault whose code is off its pattern, and a stored entity whose SyncToken is not digits, are read as no answer, and the refetch decides.
- The receipt command's causes gain `command`: the server's own cause, when the command couldn't be run or answered off-shape.
- Not in the contract: the in-process latch above (known difference 6), which adds an off-state after a failed deletion; and, as 1.1 already says, a 401 on an update drops the kept token (the server takes a new one before the next request).

To ask what write mode's guard would decide for a request, without sending anything:

```bash
node dist/guard-probe.js --mode write <METHOD> <URL> --realm <R> [--body <file>] [--header <k:v>]... [--stacks-url <u>] [--key <k>]...
```

It prints `allow <rule>` or `allowed-with-capability write-update` (exit 0), or `refuse <rule>` (exit 1); a usage error exits 2. It asks the guard's rules alone, so a request with a header the server's adapter refuses can still be answered `allow` or `allowed-with-capability`.

---

## How a call works

This is the read server's call; the write tools' own order is under [The three write tools](#the-three-write-tools). There is no sign-in. The fork gets a short-lived access token for each company from Stacks and keeps it in memory until 5 minutes before it expires.

1. A tool call arrives with `company`.
2. The call context starts. It holds that call's company, tokens and failure, and is not shared between calls. What is kept across calls is each company's token, realm, refusal and passed name check.
3. The access token comes from Stacks: `GET <STACKS_QBO_URL>/api/qbo/access_token?enterprise=<company>` with the `X-Api-Key` header and a 10 second timeout. A token the fork already keeps is used with no request until 5 minutes before its `expires_at`; then it is fetched again. The request is sent once more only when there was no answer, or the answer is not HTTP, or the status is one the mapping does not know (a 3xx, say), or a 403, 404, 409 or 502 has a body that is not Stacks' own. A 200 the fork cannot read is not asked again: it is a fork error, and so is a request the guard refused. A 403, 404, 409 or 502 with Stacks' own body is not asked again either.
4. On the first use of each company, its QuickBooks company name is checked against `accepted_names` in the `QBO_COMPANIES` file. A mismatch refuses that company until the server restarts.
5. Every request goes through the HTTP guard, which allows only the read requests in contract 1.1.
6. Every QuickBooks request has a 15 second limit. If QuickBooks answers a GET with 401, the token is fetched again and the request is sent once more. If it answers a GET with 429, the request is sent once more after `Retry-After` in whole seconds (at most 30 seconds; 2 seconds when the header is missing or not whole seconds). Each resend is made once per request.
7. Results follow contract 1.1 (`docs/contracts/quickbooks.md` in Stacksbot).

The fork never holds or stores a refresh token, client id or client secret.

**Redaction.** Every access token the call held, and the Stacks key, are kept out of results, errors and logs. An `intuit_tid` that contains any of them is dropped.

---

## Development

### Building

```bash
npm run build
```

### Testing

```bash
npm test
```

### Project Structure

```
src/
├── clients/          # QuickBooks API client, configuration, tokens and the guard's decision
├── allowlist.ts      # Write tool list, start checks and both servers' starts
├── tool-lists.ts     # Read allowlist
├── http-guard.ts     # HTTP guard, backstop and secureStart
├── guard-probe.ts    # Guard probe (sends nothing)
├── write/            # Write mode only (not loaded by the read server)
├── handlers/         # Business logic handlers
├── tools/           # MCP tool definitions
├── helpers/         # Utility functions
├── server/          # The MCP server instance
├── types/           # TypeScript types
└── index.ts         # Server entry point

tests/
├── unit/            # Unit tests (allowlist, removals, docs, client, entry point, lockfile floors)
│   ├── clients/     # Client test
│   ├── handlers/    # Handler tests (25 test files)
│   ├── helpers/     # Helper tests
│   └── tools/       # Tool tests
├── integration/     # Tests that run the server's parts together
├── e2e/             # Tests that spawn the built server
├── fakes/           # Fake Stacks and QuickBooks answers and fixtures for the contract
├── fixtures/        # Scripts the tests spawn
├── write/           # Write mode tests
├── helpers/         # Test helpers
└── mocks/           # Test mocks

docs/
├── ARCHITECTURE.md  # System architecture & design patterns
├── TESTING.md       # Testing guide & patterns
└── plans/           # Development plans
```

---

## Documentation

| Document | Description |
|----------|-------------|
| [CHANGELOG.md](CHANGELOG.md) | Version history and all changes |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture, patterns, and design decisions |
| [docs/TESTING.md](docs/TESTING.md) | Testing strategy, ESM patterns, and coverage guide |

---

## Error Handling

- A start that fails says `refused to start: <reason>` for a key or an allowlist mismatch, `qbo-guard: start refused: <key>` for an unsafe environment, `qbo-guard: install failed` for a guard that cannot be installed, or, when the write modules cannot be loaded, the first line of that error; all are listed under [Configuration](#configuration).
- A tool call that fails returns an error result that follows contract 1.1. It never holds a token or the Stacks key.

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. A new tool must be added to the read allowlist in `src/tool-lists.ts` (or, for write mode, `WRITE_TOOLS` in `src/allowlist.ts`) to be registered, and that is a change to what the server exposes.

---

## License

`LICENSE` holds the Apache-2.0 text and `package.json` says MIT. See the licence mismatch note at the top of this file.

---

## Acknowledgments

- Based on [Intuit's QuickBooks Online MCP Server](https://github.com/intuit/quickbooks-online-mcp-server)
- Built with the [Model Context Protocol](https://modelcontextprotocol.io/)
