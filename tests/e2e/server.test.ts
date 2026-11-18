// Sanctuary Computer (quickbooks-mcp-285): the built server lists only the allowlist, fits the size bound and refuses sign-in keys.
import { describe, it, expect, beforeAll, afterEach, jest } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { READ_ALLOWLIST } from '../../src/allowlist';
import { QboCompaniesTool } from '../../src/tools/qbo-companies.tool';
import { assertFreshBuild, connectClient, spawnRaw, COMPANY_RESERVE } from './helpers';

jest.setTimeout(30000);

const KEYS = ['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN', 'REALM_ID'].map((k) => 'QUICKBOOKS_' + k);

let open: Client | null = null;
async function connect() {
  const c = await connectClient();
  open = c.client;
  return c;
}

beforeAll(() => {
  assertFreshBuild();
  expect(Object.keys(process.env).filter((k) => k.startsWith('QUICKBOOKS_'))).toEqual([]);
});

afterEach(async () => {
  if (open) await open.close();
  open = null;
});

describe('spawned server', () => {
  it('A5: tools/list is exactly the allowlist and the stub', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_ALLOWLIST, 'qbo_companies'].sort());
  });

  it("A6: tools/list fits the design's bound with the company reserve", async () => {
    const { client } = await connect();
    const result = await client.listTools();
    const toolsChars = JSON.stringify(result.tools).length;
    const responseChars = JSON.stringify({ jsonrpc: '2.0', id: 1, result }).length;
    const margin = 28800 - (Math.max(toolsChars, responseChars) + COMPANY_RESERVE);
    console.log(`tools/list: tools ${toolsChars}, response ${responseChars}, reserve ${COMPANY_RESERVE}, margin ${margin}`);
    expect(toolsChars + COMPANY_RESERVE).toBeLessThanOrEqual(28800);
    expect(responseChars + COMPANY_RESERVE).toBeLessThanOrEqual(28800);
    expect(toolsChars).toBeLessThanOrEqual(32000);
    expect(responseChars).toBeLessThanOrEqual(32000);
  });

  it('A9: qbo_companies answers the stub error', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'qbo_companies', arguments: {} });
    expect(result).toEqual(await QboCompaniesTool.handler());
  });

  it.each(KEYS)('R7: each refused key stops the server (%s)', async (k) => {
    const sentinel = 'sentinel-' + process.pid + '-' + Date.now();
    const { code, stdout, stderr } = await spawnRaw({ [k]: sentinel });
    expect(code).toBe(1);
    expect(stderr.split(/\r?\n/).filter(Boolean)).toEqual([`refused to start: ${k} is set`]);
    expect(stdout).toBe('');
    expect(stderr).not.toContain(sentinel);
    expect(stdout).not.toContain(sentinel);
  });

  it('R10: a listed tool answers the token-source error and the server stays up', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'get_company_info', arguments: { params: {} } });
    const text = (result.content as Array<{ type: string; text: string }>).map((c) => c.text).join('\n');
    expect(text).toContain('no QuickBooks token source');
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(32);
  });
});
