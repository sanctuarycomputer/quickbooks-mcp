<!-- Changed by Sanctuary Computer (quickbooks-mcp-285): describes the read-only fork. -->
# QuickBooks Online MCP Server

## This fork

This is Sanctuary Computer's read-only fork of the QuickBooks Online MCP server.

- It is read only. It registers 31 read tools (listed under [Available Tools](#available-tools)) and one stub, `qbo_companies`. Nothing else is registered: no create, update or delete tools.
- There is no sign-in. The OAuth flow, the auth server, the auth command and the token store are removed. Until the Stacks token client lands (ticket 286), the client has no token source, so every tool call fails with "no QuickBooks token source" and `qbo_companies` answers with a fork error.
- The server refuses to start if any of `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_REFRESH_TOKEN` or `QUICKBOOKS_REALM_ID` is present in its environment, even with an empty value. It never reads or prints the value.
- Configuration for the new token source comes with ticket 286, which documents its keys. Until then there is nothing to configure.
- Files this fork changed carry a "Changed by Sanctuary Computer (quickbooks-mcp-285)" notice, and files it added a "Sanctuary Computer (quickbooks-mcp-285)" one, where the format allows a comment (source, tests, `jest.config.js`, the docs and `.env.example`); `package.json` and `package-lock.json` can't hold one, and the fork's pull request lists their changes. Deleted files are listed there too.
- Licence mismatch: `LICENSE` holds the Apache-2.0 text (with "January 2025" typed for "January 2004" and a filled-in "Copyright 2025 Intuit, Inc."), while `package.json` says MIT. This fork leaves both as they are. See the ticket 283 fork review.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the start check works.

---

## Overview

This MCP server exposes read-only access to QuickBooks Online (reports and searches) to Claude Code and other MCP-compatible clients. It runs as a local stdio subprocess.

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

There is no QuickBooks configuration to set yet. Configuration for the token source comes with ticket 286. Do not set the four sign-in keys named above: the server refuses to start with any of them present.

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

The `env` block takes the new keys once ticket 286 documents them.

---

## Available Tools

The server registers these 31 read tools and the `qbo_companies` stub, and nothing else. It checks this list at start, before it registers any tool.

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
- `qbo_companies` (stub until ticket 286)

---

## Authentication

There is no sign-in in this fork. The OAuth flow, the auth command, the token store and the Intuit app setup steps are removed. Ticket 286 adds a Stacks token client that supplies the token and documents the keys it needs. Ticket 291 adds a guard that sends every QuickBooks request through one HTTP client.

Until then the client has no token source, and tool calls fail with "no QuickBooks token source".

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
├── clients/          # QuickBooks API client
├── allowlist.ts      # Read allowlist and the start check
├── handlers/         # Business logic handlers
├── tools/           # MCP tool definitions
├── helpers/         # Utility functions
├── server/          # The MCP server instance
├── types/           # TypeScript types
└── index.ts         # Server entry point

tests/
├── unit/            # Unit tests (allowlist, removals, client, stub, entry point, lockfile floors)
│   ├── clients/     # Client test
│   ├── handlers/    # Handler tests (25 test files)
│   ├── helpers/     # Helper tests
│   └── tools/       # Tool tests
├── e2e/             # Tests that spawn the built server
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

- A start that fails says `refused to start: <reason>`. The reason is a sign-in key that is set, or an allowlist mismatch (duplicate, missing or unlisted tool).
- Until ticket 286, tool calls fail with "no QuickBooks token source".

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. A new tool must be added to the allowlist in `src/allowlist.ts` to be registered, and that is a change to what the server exposes.

---

## License

`LICENSE` holds the Apache-2.0 text and `package.json` says MIT. See the licence mismatch note at the top of this file.

---

## Acknowledgments

- Based on [Intuit's QuickBooks Online MCP Server](https://github.com/intuit/quickbooks-online-mcp-server)
- Built with the [Model Context Protocol](https://modelcontextprotocol.io/)
