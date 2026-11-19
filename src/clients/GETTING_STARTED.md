<!-- Changed by Sanctuary Computer (quickbooks-mcp-285): no sign-in setup in this fork. -->
## Setup

1. Install dependencies:
```bash
npm install
```

2. There is no sign-in in this read-only fork, and no QuickBooks keys to set. The client has no token source yet, so tool calls fail with "no QuickBooks token source". Ticket 286 adds the Stacks token client and documents its configuration keys.

3. Do not set `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_REFRESH_TOKEN` or `QUICKBOOKS_REALM_ID`. The server refuses to start if any of them is present, even empty.
