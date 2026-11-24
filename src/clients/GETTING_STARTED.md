<!-- Changed by Sanctuary Computer (quickbooks-mcp-285 and quickbooks-mcp-286): no sign-in setup in this fork. -->
## Setup

1. Install dependencies:
```bash
npm install
```

2. There is no sign-in in this read-only fork. The server gets each company's access token from Stacks, keeps it in memory until 5 minutes before it expires, and is configured by five keys: see the Configuration section of the README (`../../README.md`).

3. Do not set `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_REFRESH_TOKEN` or `QUICKBOOKS_REALM_ID`. The server refuses to start if any of them is present, even empty.
