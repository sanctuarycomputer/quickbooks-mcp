// Sanctuary Computer (quickbooks-mcp-286): the two company tools through the started server (spec A1.1's QuickBooks half,
// A2.7's qbo_companies half, A3.8, A4.6, A4.9, A4.10). Every case starts with tests/helpers/server.ts (291's secureStart,
// then 285's startReadServer, an in-memory MCP client); the stub network answers below the guard. Each get_company_info
// result is compared with its tool-results/get_company_info/ fixture exactly (fork-error-sdk-input.json by its prefix),
// and the afterAll checks that every file in that directory was produced by some case here.
import { describe, it as jestIt, expect, afterEach, afterAll, jest } from '@jest/globals';
import fs from 'fs';
import { z } from 'zod';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  ENTITIES_TWO,
  QBO_HOST,
  REALMS,
  STACKS_KEY,
  STACKS_URL,
  companyInfos,
  fakePath,
  fixtureToken,
  installNetwork,
  readTools,
  startServer,
  testEnv,
  type Rig,
  type StartOpts,
} from '../../helpers/server.js';
import type { StubAnswer, StubCall } from '../../fakes/stub-network.js';
import { guardedAxios } from '../../../src/http-guard.js';
import { QBO_LIMIT_MS } from '../../../src/clients/qbo-transport.js';
import { parseCompanies } from '../../../src/clients/companies.js';
import type { ReadTool } from '../../../src/allowlist.js';

/** Every case is registered through this, so the afterAll can tell an unfiltered run (all ran) from a `-t` run. */
let registered = 0;
let ran = 0;
const it = (name: string, fn: () => Promise<void>): void => {
  registered++;
  jestIt(name, fn);
};

const network = installNetwork();
const { net } = network;

const KEYS = ['sanctuary-computer', 'garden3d', 'index-space', 'usb-club'];
const INFO_DIR = 'tool-results/get_company_info';
const SDK_INPUT_PREFIX = 'MCP error -32602: Input validation error: Invalid arguments for tool get_company_info';

const readFake = (name: string): any => JSON.parse(fs.readFileSync(fakePath(name), 'utf8'));
/** The call tool-calls/get_company_info.json, with `company` set to `key`. */
const callFor = (key: string) => ({ ...readFake('tool-calls/get_company_info.json'), company: key });
/** A get_company_info fixture's CompanyInfo (its data item), as QuickBooks serves it. */
const infoOf = (name: string): object => JSON.parse(readFake(`${INFO_DIR}/${name}.json`).content[0].text);

/** The get_company_info fixtures this file's cases produced. */
const produced = new Set<string>();
/** The result equals the fixture `name` exactly; noted as produced. */
function expectFixture(result: unknown, name: string): void {
  expect(result).toStrictEqual(readFake(`${INFO_DIR}/${name}.json`));
  produced.add(`${name}.json`);
}

let rig: Rig | undefined;
async function start(opts: StartOpts = {}): Promise<Rig> {
  rig = await startServer(opts);
  return rig;
}
afterEach(async () => {
  jest.useRealTimers();
  await rig?.close();
  rig = undefined;
  net.calls.length = 0;
  ran++;
});
afterAll(() => {
  expect(network.trap.reached).toEqual([]);
  network.restore();
  // A4.10: every fixture in the directory, produced by a case here; only when every case ran, so a `-t` run passes.
  if (ran === registered) expect([...produced].sort()).toEqual(fs.readdirSync(fakePath(INFO_DIR)).sort());
});

const isQbo = (c: StubCall) => c.hostname === QBO_HOST;
const qboCalls = () => net.calls.filter(isQbo);
const stacksCalls = () => net.calls.filter((c) => !isQbo(c));
const bearer = (c: StubCall) => String((c.headers as Record<string, unknown>)?.Authorization);
const infoPath = (realm: string) => `/v3/company/${realm}/companyinfo/${realm}`;
/** A QuickBooks request's path without its query. */
const pathOf = (c: StubCall) => (c.path ?? '').split('?')[0];
const json = (status: number, body: unknown, headers: Record<string, string> = {}): StubAnswer => ({ status, headers, body: JSON.stringify(body) });
const call = (r: Rig, key = 'garden3d') => r.client.callTool({ name: 'get_company_info', arguments: callFor(key) });

/**
 * A server whose QuickBooks answers come from the fake until `answerWith` is called; after that, its function answers each QuickBooks
 * request (undefined lets the fake answer). `infos` is the CompanyInfo the fake serves at each realm, changeable later.
 */
async function startSwitchable(): Promise<{ r: Rig; infos: Record<string, object>; answerWith(f: (c: StubCall) => ReturnType<NonNullable<StartOpts['route']>>): void }> {
  let after: ((c: StubCall) => ReturnType<NonNullable<StartOpts['route']>>) | undefined;
  const infos = companyInfos();
  const r = await start({ qbo: { companyInfo: infos }, route: (c) => (isQbo(c) ? after?.(c) : undefined) });
  return { r, infos, answerWith: (f) => void (after = f) };
}

describe('A4.9: get_company_info', () => {
  it('its params schema has no company_id: an object with no properties', async () => {
    const { client } = await start();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'get_company_info')!;
    const schema = tool.inputSchema as { properties: Record<string, any> };
    expect(JSON.stringify(tool.inputSchema)).not.toContain('company_id');
    expect(schema.properties.params.type).toBe('object');
    expect(schema.properties.params.properties ?? {}).toEqual({});
  });

  it('tool-calls/get_company_info.json for each company answers ok-<key>.json exactly, reading companyinfo/<its realm>', async () => {
    const r = await start();
    for (const key of KEYS) {
      net.calls.length = 0;
      expectFixture(await call(r, key), `ok-${key}`);
      // The first-use read, then the tool's own: both companyinfo/<realm>, with the company's token.
      expect(qboCalls().map(pathOf)).toEqual([infoPath(REALMS[key]), infoPath(REALMS[key])]);
      for (const c of qboCalls()) expect(bearer(c)).toBe(`Bearer ${fixtureToken(key)}`);
    }
  });

  it('ok-legal-name-only served (CompanyName not accepted, LegalName accepted): ok-legal-name-only.json exactly', async () => {
    const r = await start({ qbo: { companyInfo: { [REALMS.garden3d]: infoOf('ok-legal-name-only') } } });
    expectFixture(await call(r), 'ok-legal-name-only');
  });

  it("params { company_id: '123' }: the data item, then upstream's WARNING: naming it; every request is companyinfo/<kept realm>", async () => {
    const r = await start();
    const out: any = await r.client.callTool({ name: 'get_company_info', arguments: { company: 'garden3d', params: { company_id: '123' } } });
    expect(out.isError).toBeUndefined();
    expect(out.content).toStrictEqual([
      readFake(`${INFO_DIR}/ok-garden3d.json`).content[0],
      {
        type: 'text',
        text: 'WARNING: get_company_info does not support this parameter: company_id. It was IGNORED - the value did not reach QuickBooks. Supported parameters: .',
      },
    ]);
    expect(qboCalls().map(pathOf)).toEqual([infoPath(REALMS.garden3d), infoPath(REALMS.garden3d)]);
    expect(qboCalls().some((c) => (c.path ?? '').includes('123'))).toBe(false);
  });

  it("company_id naming another company's realm is ignored too: garden3d's data, usb-club's realm never asked", async () => {
    const r = await start();
    const out: any = await r.client.callTool({ name: 'get_company_info', arguments: { company: 'garden3d', params: { company_id: REALMS['usb-club'] } } });
    expect(out.content[0]).toStrictEqual(readFake(`${INFO_DIR}/ok-garden3d.json`).content[0]);
    expect(out.content[1].text).toMatch(/^WARNING: get_company_info does not support this parameter: company_id\./);
    expect(qboCalls().map(pathOf)).toEqual([infoPath(REALMS.garden3d), infoPath(REALMS.garden3d)]);
  });
});

describe("A1.1 through get_company_info: one Stacks request with the key, the company's token and realm on QuickBooks", () => {
  for (const [label, url] of [
    ['STACKS_QBO_URL', STACKS_URL],
    ["STACKS_QBO_URL ending in '/'", `${STACKS_URL}/`],
  ]) {
    it(`${label}: GET /api/qbo/access_token?enterprise=garden3d with X-Api-Key; Bearer qbo-fake-access-token-garden3d, realm 9990000000000002`, async () => {
      const r = await start({ env: testEnv({ STACKS_QBO_URL: url }) });
      expectFixture(await call(r), 'ok-garden3d');
      const [stacks, ...more] = stacksCalls();
      expect(more).toEqual([]);
      expect(stacks.method).toBe('GET');
      expect(stacks.hostname).toBe('stacks.example.test');
      expect(stacks.path).toBe('/api/qbo/access_token?enterprise=garden3d');
      expect((stacks.headers as Record<string, unknown>)['X-Api-Key']).toBe(STACKS_KEY);
      expect(qboCalls()).toHaveLength(2);
      for (const c of qboCalls()) {
        expect(bearer(c)).toBe('Bearer qbo-fake-access-token-garden3d');
        expect(pathOf(c)).toBe('/v3/company/9990000000000002/companyinfo/9990000000000002');
      }
    });
  }
});

describe("A4.6: Stacks' answers through a get_company_info call, each exact, with no QuickBooks request", () => {
  for (const [file, fixture] of [
    ['403.json', 'stacks-auth'],
    ['404.json', 'unknown-enterprise'],
    ['409.json', 'not-connected'],
    ['502-invalid_grant.json', 'renewal-failed-invalid_grant'],
    ['502-unavailable.json', 'renewal-failed-unavailable'],
  ]) {
    it(`${file} → ${fixture}.json`, async () => {
      const r = await start({ stacks: { sequence: [file] } });
      expectFixture(await call(r), fixture);
      expect(stacksCalls()).toHaveLength(1);
      expect(qboCalls()).toEqual([]);
    });
  }

  it('502-proxy twice → stacks-unreachable.json, after two Stacks requests', async () => {
    const r = await start({ stacks: { sequence: ['502-proxy.json'] } });
    expectFixture(await call(r), 'stacks-unreachable');
    expect(stacksCalls()).toHaveLength(2);
    expect(qboCalls()).toEqual([]);
  });

  it('no answer twice (10 s each) → stacks-unreachable.json, after two Stacks requests', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const r = await start({ stacks: { hang: true } });
    const p = call(r);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(stacksCalls()).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await p).toStrictEqual(readFake(`${INFO_DIR}/stacks-unreachable.json`));
    expect(qboCalls()).toEqual([]);
  });
});

/** A Stacks 200 for garden3d naming `name`. */
const named = (name: string) => ({
  status: 200,
  body: { enterprise: 'garden3d', realm_id: REALMS.garden3d, access_token: fixtureToken('garden3d'), expires_at: '2026-11-18T12:00:00Z', company_name: name },
});

describe('A4.10: the name checks through get_company_info', () => {
  it("Stacks names Garden Three LLC (not accepted under entities.json): name-mismatch-stacks.json, no QuickBooks request", async () => {
    const r = await start({ stacks: { sequence: [named('Garden Three LLC')] } });
    expectFixture(await call(r), 'name-mismatch-stacks');
    expect(qboCalls()).toEqual([]);
  });

  it('QuickBooks names Garden Three Studio on first use: name-mismatch-quickbooks.json, after the one first-use read', async () => {
    const r = await start({ qbo: { companyInfo: { [REALMS.garden3d]: infoOf('ok-unaccepted-name') } } });
    expectFixture(await call(r), 'name-mismatch-quickbooks');
    expect(qboCalls().map(pathOf)).toEqual([infoPath(REALMS.garden3d)]);
  });

  for (const fixture of ['ok-unaccepted-name', 'ok-unaccepted-long-name']) {
    it(`QuickBooks' names change after the first-use check passed: the next call is a success, ${fixture}.json exactly`, async () => {
      const { r, infos } = await startSwitchable();
      expectFixture(await call(r), 'ok-garden3d');
      infos[REALMS.garden3d] = infoOf(fixture);
      net.calls.length = 0;
      expectFixture(await call(r), fixture);
      // The check is first use only: the later call reads companyinfo once, the tool's own read.
      expect(qboCalls().map(pathOf)).toEqual([infoPath(REALMS.garden3d)]);
    });
  }
});

describe("A4.10: QuickBooks' failures on the tool's own read, after the first-use check passed", () => {
  it('500 with intuit_tid fake-tid-0001: http-500.json exactly', async () => {
    const { r, answerWith } = await startSwitchable();
    expectFixture(await call(r), 'ok-garden3d');
    answerWith(() => json(500, { Fault: { Error: [{ Message: 'boom' }] } }, { intuit_tid: 'fake-tid-0001' }));
    net.calls.length = 0;
    expectFixture(await call(r), 'http-500');
    expect(qboCalls()).toHaveLength(1);
  });

  it('no answer within 15 s: timeout.json exactly', async () => {
    const { r, answerWith } = await startSwitchable();
    expectFixture(await call(r), 'ok-garden3d');
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    answerWith(() => new Promise<StubAnswer>(() => {}));
    net.calls.length = 0;
    const p = call(r);
    await jest.advanceTimersByTimeAsync(QBO_LIMIT_MS);
    expectFixture(await p, 'timeout');
    expect(qboCalls()).toHaveLength(1);
  });

  it("a 200 holding a Fault (node-quickbooks' error, no failure recorded): fork-error.json exactly", async () => {
    const { r, answerWith } = await startSwitchable();
    expectFixture(await call(r), 'ok-garden3d');
    answerWith(() => json(200, { Fault: { Error: [{ Message: 'odd', Detail: 'odd' }], type: 'SystemFault' } }));
    expectFixture(await call(r), 'fork-error');
  });
});

describe("A4.10: fork-error.json from a guard refusal during the call (A3.5's case run through get_company_info)", () => {
  it("inside a garden3d call a request to usb-club's realm is refused, nothing sent: fork-error.json exactly", async () => {
    let outcome: unknown;
    const probe = async () => {
      const usb = REALMS['usb-club'];
      try {
        await guardedAxios()({ method: 'get', url: `https://${QBO_HOST}/v3/company/${usb}/companyinfo/${usb}?minorversion=75&format=json` });
      } catch (e) {
        outcome = (e as Error).name;
      }
      return { content: [{ type: 'text', text: '{}' }] };
    };
    const tools = (await readTools()).map((t) =>
      t.name === 'get_company_info' ? ({ name: t.name, description: t.description, schema: z.object({}), handler: probe } as unknown as ReadTool) : t,
    );
    jest.spyOn(process.stderr, 'write').mockImplementation((() => true) as any);
    const r = await start({ tools });
    expectFixture(await call(r), 'fork-error');
    expect(outcome).toBe('GuardRefusedError');
    expect(net.calls.filter((c) => (c.path ?? '').includes(REALMS['usb-club']))).toEqual([]);
  });
});

describe('A4.10: the SDK input error', () => {
  it('a valid company and no params: one text item, isError, with fork-error-sdk-input.json\'s prefix; no request', async () => {
    const r = await start();
    const out: any = await r.client.callTool({ name: 'get_company_info', arguments: { company: 'garden3d' } });
    const fixture = readFake(`${INFO_DIR}/fork-error-sdk-input.json`);
    expect(fixture.content[0].text.startsWith(SDK_INPUT_PREFIX)).toBe(true);
    expect(out.isError).toBe(true);
    expect(out.content).toHaveLength(1);
    expect(out.content[0].type).toBe('text');
    expect(out.content[0].text.startsWith(SDK_INPUT_PREFIX)).toBe(true);
    expect(net.calls).toEqual([]);
    produced.add('fork-error-sdk-input.json');
  });
});

describe('A3.8, A2.7: qbo_companies answers the loaded companies, with no request', () => {
  it('tool-calls/qbo_companies.json under entities.json: qbo_companies/ok.json exactly', async () => {
    const r = await start();
    const out = await r.client.callTool({ name: 'qbo_companies', arguments: readFake('tool-calls/qbo_companies.json') });
    expect(out).toStrictEqual(readFake('tool-results/qbo_companies/ok.json'));
    expect(net.calls).toEqual([]);
  });

  it('a call with no arguments: qbo_companies/sdk-absent-arguments.json exactly', async () => {
    const r = await start();
    const out = await r.client.request({ method: 'tools/call', params: { name: 'qbo_companies' } }, CallToolResultSchema);
    expect(out).toStrictEqual(readFake('tool-results/qbo_companies/sdk-absent-arguments.json'));
    expect(net.calls).toEqual([]);
  });

  it("under entities-two.json: that file's companies, keys and names, in its order, one compact line", async () => {
    const r = await start({ env: testEnv({ QBO_COMPANIES: ENTITIES_TWO }) });
    const out: any = await r.client.callTool({ name: 'qbo_companies', arguments: {} });
    const companies = parseCompanies(fs.readFileSync(ENTITIES_TWO, 'utf8'));
    expect(companies.map((c) => c.key)).toEqual([...KEYS, 'north-fork']);
    expect(out).toStrictEqual({ content: [{ type: 'text', text: JSON.stringify(companies.map((c) => ({ key: c.key, name: c.name }))) }] });
    expect(net.calls).toEqual([]);
  });
});
