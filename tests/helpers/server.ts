// Sanctuary Computer (quickbooks-mcp-286): the read server started as the entry starts it, for through-the-server tests:
// 291's secureStart, then 285's startReadServer with a test environment (the five keys, an entities file) and the Stacks
// client's clock held at 2026-11-18T11:00:00Z, an hour before the fixtures' expires_at; an in-memory MCP client on it.
// The stub network routes QuickBooks' host to the QuickBooks fake and every other host to the Stacks fake.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { trapNetwork, type NetworkTrap } from '../fakes/no-network.js';
import { installStubNetwork, type StubCall, type StubNetwork, type StubTable } from '../fakes/stub-network.js';
import { quickbooksFake, type QuickbooksFakeOpts } from '../fakes/quickbooks.js';
import { stacksFake, type StacksFakeOpts } from '../fakes/stacks-token.js';
import { secureStart } from '../../src/http-guard.js';
import { startReadServer, type ReadTool } from '../../src/allowlist.js';
import type { Runtime } from '../../src/clients/runtime.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const fakePath = (name: string) => path.join(ROOT, 'tests', 'fakes', name);
export const ENTITIES = fakePath('entities.json');
export const ENTITIES_TWO = fakePath('entities-two.json');
export const QBO_HOST = 'quickbooks.api.intuit.com';
export const STACKS_URL = 'https://stacks.example.test';
/** STACKS_QBO_TOKEN for tests, built at runtime so no secret-shaped literal sits in the tree. */
export const STACKS_KEY = ['stacks', 'test', 'key', 'value'].join('-');
/** The clock every through-the-server test holds: an hour before the fixtures' expires_at. */
export const NOW = Date.parse('2026-11-18T11:00:00Z');
/** Each company's realm, as its stacks-token/200-<key>.json fixture hands it out. */
export const REALMS: Record<string, string> = {
  'sanctuary-computer': '9990000000000001',
  garden3d: '9990000000000002',
  'index-space': '9990000000000003',
  'usb-club': '9990000000000004',
};
/** A fixture token's access token, built at runtime. */
export const fixtureToken = (key: string) => ['qbo', 'fake', 'access', 'token', key].join('-');

/** A valid start environment: the five keys, entities.json; `over` replaces or (with undefined) removes keys. */
export function testEnv(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    STACKS_QBO_URL: STACKS_URL,
    STACKS_QBO_TOKEN: STACKS_KEY,
    QUICKBOOKS_ENVIRONMENT: 'production',
    QBO_COMPANIES: ENTITIES,
    QBO_MODE: 'read',
    ...over,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

/** Each company's CompanyInfo (its get_company_info ok-<key>.json data item), served at its realm. */
export function companyInfos(): Record<string, object> {
  const out: Record<string, object> = {};
  for (const [key, realm] of Object.entries(REALMS)) {
    const file = fakePath(`tool-results/get_company_info/ok-${key}.json`);
    out[realm] = JSON.parse(JSON.parse(fs.readFileSync(file, 'utf8')).content[0].text);
  }
  return out;
}

let toolList: ReadTool[] | undefined;
/** The tool list as src/index.ts builds it (its `./tools/*.tool.js` imports, in order), loaded from src. */
export async function readTools(): Promise<ReadTool[]> {
  if (toolList !== undefined) return toolList;
  const index = fs.readFileSync(path.join(ROOT, 'src', 'index.ts'), 'utf8');
  const list: ReadTool[] = [];
  for (const [, name, file] of index.matchAll(/^import \{ (\w+) \} from "\.\/tools\/([\w-]+\.tool)\.js";$/gm)) {
    const mod = await import(`../../src/tools/${file}.js`);
    list.push(mod[name]);
  }
  toolList = list;
  return list;
}

export type Network = { trap: NetworkTrap; net: StubNetwork; restore(): void };
let table: StubTable = () => ({ status: 500 });
/**
 * The socket trap, then the stub network (so the guard's backstop wraps the stub). Call once at a test file's top,
 * before any start; restore in afterAll, after every server is closed.
 */
export function installNetwork(): Network {
  const trap = trapNetwork();
  const net = installStubNetwork((call) => table(call));
  return {
    trap,
    net,
    restore() {
      net.restore();
      trap.restore();
    },
  };
}

export type Rig = {
  server: McpServer;
  client: Client;
  runtime: Runtime;
  qbo: ReturnType<typeof quickbooksFake>;
  stacks: ReturnType<typeof stacksFake>;
  /** Closes the client, the server and the runtime, then puts 291's start back. */
  close(): Promise<void>;
};

export type StartOpts = {
  env?: Record<string, string | undefined>;
  tools?: ReadTool[];
  qbo?: QuickbooksFakeOpts;
  stacks?: StacksFakeOpts;
  /** Routes a request before the fakes; undefined lets the fakes answer. */
  route?: (call: StubCall) => ReturnType<StubTable> | undefined;
  now?: () => number;
};

/** secureStart, then startReadServer with the test environment; on a start failure 291's start is put back and the error thrown. */
export async function startServer(opts: StartOpts = {}): Promise<Rig> {
  const qbo = quickbooksFake({ companyInfo: companyInfos(), ...opts.qbo });
  const stacks = stacksFake(opts.stacks);
  table = (call) => opts.route?.(call) ?? (call.hostname === QBO_HOST ? qbo.handler(call) : stacks.handler(call));
  const env = opts.env ?? testEnv();
  const restoreStart = secureStart(env as NodeJS.ProcessEnv, []);
  const server = new McpServer({ name: 'server-helper', version: '0.0.0' }, { capabilities: { tools: {} } });
  let runtime: Runtime;
  try {
    runtime = startReadServer(env, server, opts.tools ?? (await readTools()), { now: opts.now ?? (() => NOW) });
  } catch (e) {
    restoreStart();
    throw e;
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'server-helper-client', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    server,
    client,
    runtime,
    qbo,
    stacks,
    async close() {
      await client.close();
      await server.close();
      runtime.close();
      restoreStart();
    },
  };
}

/** A result's text items joined by LF. */
export const textOf = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join('\n');
