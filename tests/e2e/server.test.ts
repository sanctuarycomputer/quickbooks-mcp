// Sanctuary Computer (quickbooks-mcp-285): the built server lists only the allowlist, fits the size bound and refuses sign-in keys.
// Changed by Sanctuary Computer (quickbooks-mcp-286): the server starts with the five keys (helpers' startEnv); R10's
// call names a company and answers the Stacks client's failure; qbo_companies answers its contract fixtures (A3.8).
import { describe, it, expect, beforeAll, afterEach, jest } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { READ_ALLOWLIST } from '../../src/allowlist';
import { assertFreshBuild, connectClient, spawnRaw, COMPANY_RESERVE, ROOT } from './helpers';
import fs from 'fs';
import path from 'path';

const fixture = (name: string): any => JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fakes', name), 'utf8'));

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

  // 286 T11: 285's A9 is A3.8: the spawned server's qbo_companies answers tool-results/qbo_companies/ok.json exactly.
  it('A3.8: qbo_companies answers ok.json exactly', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'qbo_companies', arguments: fixture('tool-calls/qbo_companies.json') });
    expect(result).toStrictEqual(fixture('tool-results/qbo_companies/ok.json'));
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
    // 286 T11: the success, exactly sdk-absent-arguments.json (equal to ok.json).
    expect(absent).toStrictEqual(fixture('tool-results/qbo_companies/sdk-absent-arguments.json'));
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

  // 286 T10: each tool runs in a call for its company; nothing listens at startEnv's Stacks origin, so the token fetch is
  // refused at the socket, asked again once, and answers stacks-unreachable.
  it('R10: a listed tool answers the token failure and the server stays up', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'get_company_info', arguments: { company: 'garden3d', params: {} } });
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'reason: stacks-unreachable\n\nStacks gave no answer the server knows, twice.' }],
    });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(32);
  });
});
