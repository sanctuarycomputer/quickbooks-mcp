<!-- Changed by Sanctuary Computer (quickbooks-mcp-285, quickbooks-mcp-286, quickbooks-mcp-293): describes the read-only fork and its write mode. -->
# QuickBooks Online MCP Server

## This fork

This is Sanctuary Computer's fork of the QuickBooks Online MCP server. It starts as a read-only server, and with `QBO_MODE=write` as a write server (see [Write mode](#write-mode)).

- By default it is read only. It registers 31 read tools (listed under [Available Tools](#available-tools)) and `qbo_companies`. Nothing else is registered: no create, update or delete tools. Write mode registers five tools instead, four of them not built yet.
- There is no sign-in in this fork, and it never holds or stores a QuickBooks refresh token, client id or client secret. It gets an access token for the company a call names from Stacks, and keeps it in memory until 5 minutes before it expires (see [Configuration](#configuration) and [How a call works](#how-a-call-works)).
- Every read tool takes a required `company`. `qbo_companies` lists the company keys and names you can pass.
- Files this fork changed carry a "Changed by Sanctuary Computer (quickbooks-mcp-NNN)" notice, and files it added a "Sanctuary Computer (quickbooks-mcp-NNN)" one, where NNN is the ticket that made the change (285, 286, 291 or 293), where the format allows a comment (source, tests, `jest.config.js`, the docs and `.env.example`); `package.json` and `package-lock.json` can't hold one, and the fork's pull request lists their changes. Deleted files are listed there too.
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

With `QBO_MODE=write` the server is the write server. It registers five tools and no read tool: `qbo_categorize_purchase`, `qbo_categorize_bill`, `qbo_undo_change`, `qbo_write_check` and `qbo_companies`. The four write tools are not built yet: each answers `reason: fork-error` ("This tool is not built yet.") until tickets 294 and 298 build them. Until then no tool sends anything to QuickBooks. The write server needs the five keys above and four more, and refuses to start without them. The read server loads nothing under `src/write` and ignores these keys. `.env.example` lists them, commented out.

| Key | Required in write mode | What it is |
|-----|------------------------|------------|
| `QBO_WRITE_RECEIPT_CMD` | yes | The receipt command. |
| `QBO_WRITE_SWITCH` | yes | The path of the off switch's file. |
| `QBO_WRITE_LEDGER` | yes | The path of `writes.jsonl`. |
| `QBO_WRITE_SWEEP_STAMP` | yes | The path of the job sweep's stamp. |
| `NOTION_API_KEY` | no | Not read by this code. The write entry carries it for ticket 294's receipt command. |

A write key that is not set or is empty refuses the start: `refused to start: <KEY> is not set` or `<KEY> is empty`. See [Write mode](docs/ARCHITECTURE.md#write-mode) in the architecture document for the guard rules, the capability, the pre-send check and the compare.

To ask what write mode's guard would decide for a request, without sending anything:

```bash
node dist/guard-probe.js --mode write <METHOD> <URL> --realm <R> [--body <file>] [--header <k:v>]... [--stacks-url <u>] [--key <k>]...
```

It prints `allow <rule>` or `allowed-with-capability write-update` (exit 0), or `refuse <rule>` (exit 1); a usage error exits 2. It asks the guard's rules alone, so a request with a header the server's adapter refuses can still be answered `allow` or `allowed-with-capability`.

---

## How a call works

This is the read server's call; the write server's tools are not built yet. There is no sign-in. The fork gets a short-lived access token for each company from Stacks and keeps it in memory until 5 minutes before it expires.

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
