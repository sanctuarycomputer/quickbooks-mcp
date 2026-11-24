// Sanctuary Computer (quickbooks-mcp-285): the built server lists only the allowlist, fits the size bound and refuses sign-in keys.
import { describe, it, expect, beforeAll, afterEach, jest } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { READ_ALLOWLIST } from '../../src/allowlist';
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
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'reason: fork-error\n\nqbo_companies lands with the Stacks token client' }],
    });
  });

  // Contract §5 and §11 (sdk-absent-arguments.json): at the pinned SDK a tools/call with no `arguments`
  // reaches the handler as `{}`. Contract 1.0 pinned SDK 1.30.0's refusal; scripts-292 re-pins the fixture
  // to this answer (ruling d-20261118-234219059), so 285 merges after 292. An SDK that refuses again turns this red.
  it('A9: qbo_companies without arguments answers as with {}', async () => {
    const { client } = await connect();
    const absent = await client.request(
      { method: 'tools/call', params: { name: 'qbo_companies' } },
      CallToolResultSchema,
    );
    const empty = await client.callTool({ name: 'qbo_companies', arguments: {} });
    expect(absent).toEqual(empty);
    expect(absent.isError).toBe(true);
    expect(absent.content).toEqual([
      { type: 'text', text: 'reason: fork-error\n\nqbo_companies lands with the Stacks token client' },
    ]);
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

  // 286 T7: until T10 runs each tool in a call, getInstance answers its outside-a-call error.
  it('R10: a listed tool answers getInstance\'s outside-a-call error and the server stays up', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'get_company_info', arguments: { params: {} } });
    const text = (result.content as Array<{ type: string; text: string }>).map((c) => c.text).join('\n');
    expect(text).toContain('getInstance outside a tool call');
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(32);
  });
});
