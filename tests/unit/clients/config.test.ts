// Sanctuary Computer (quickbooks-mcp-286): loadConfig, the only reader of the five start keys (contract 1.1 §3): A6.2's rows, A2.8's file refusals, A6.1's recording test.
import { describe, it, expect, jest, afterAll } from '@jest/globals';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { loadConfig, type Config } from '../../../src/clients/config.js';
import { parseCompanies } from '../../../src/clients/companies.js';
import { READ_ALLOWLIST, REFUSED_KEYS, startReadServer, type ReadTool } from '../../../src/allowlist.js';
import { secureStart } from '../../../src/http-guard.js';
import { QboCompaniesTool } from '../../../src/tools/qbo-companies.tool.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ENTITIES = path.join(ROOT, 'tests/fakes/entities.json');
const FIVE = ['STACKS_QBO_URL', 'STACKS_QBO_TOKEN', 'QUICKBOOKS_ENVIRONMENT', 'QBO_COMPANIES', 'QBO_MODE'];
const GUARD_KEYS = ['NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS'];

// Built at runtime so no token-shaped literal sits in the file.
const KEY = 'stacks-fake-' + 'key';
const sentinel = () => 'sentinel-' + process.pid + '-' + Date.now();

const valid = (): Record<string, string | undefined> => ({
  STACKS_QBO_URL: 'https://stacks.example.test',
  STACKS_QBO_TOKEN: KEY,
  QUICKBOOKS_ENVIRONMENT: 'production',
  QBO_COMPANIES: ENTITIES,
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-config-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
/** A QBO_COMPANIES file holding `text`; its path carries a sentinel so a leak of the path shows. */
function companiesFile(text: string): string {
  const p = path.join(tmp, `${sentinel()}-${n++}.json`);
  fs.writeFileSync(p, text);
  return p;
}
const entry = (stacks_key: string, name: string, ...more: string[]) => ({ stacks_key, name, accepted_names: [name, ...more] });
const entitiesText = (companies: unknown[]) => JSON.stringify({ v: '1.0', companies });

/** Expects loadConfig to throw exactly `refused to start: <KEY> <reason>`, with none of the given values in it. */
function refuses(env: Record<string, string | undefined>, message: string, values: string[] = []): void {
  let err: unknown;
  try {
    loadConfig(env);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  const m = (err as Error).message;
  expect(m).toBe(message);
  for (const v of values) if (v !== '') expect(m).not.toContain(v);
}

describe('loadConfig: accepted', () => {
  it('a full valid environment gives the URL, the key, the companies and read mode', () => {
    const config = loadConfig(valid());
    expect(config.stacksUrl).toBeInstanceOf(URL);
    expect(config.stacksUrl.href).toBe('https://stacks.example.test/');
    expect(config.stacksKey).toBe(KEY);
    expect(config.companies).toEqual(parseCompanies(fs.readFileSync(ENTITIES, 'utf8')));
    expect(config.mode).toBe('read');
  });

  it('A6.2: a trailing / on STACKS_QBO_URL is accepted, and so is a port', () => {
    expect(loadConfig({ ...valid(), STACKS_QBO_URL: 'https://stacks.example.test/' }).stacksUrl.href).toBe('https://stacks.example.test/');
    expect(loadConfig({ ...valid(), STACKS_QBO_URL: 'https://stacks.example.test:8443' }).stacksUrl.origin).toBe('https://stacks.example.test:8443');
  });

  it('A6.2: QBO_MODE unset or read is accepted', () => {
    expect(loadConfig(valid()).mode).toBe('read');
    expect(loadConfig({ ...valid(), QBO_MODE: 'read' }).mode).toBe('read');
  });

  it('A2.8: Inc. folds to inc and starts; two accepted names of one company folding alike start', () => {
    expect(loadConfig({ ...valid(), QBO_COMPANIES: companiesFile(entitiesText([entry('a', 'Inc.')])) }).companies).toEqual([
      { key: 'a', name: 'Inc.', acceptedNames: ['Inc.'] },
    ]);
    const one = companiesFile(entitiesText([entry('garden3d', 'garden3d, LLC', 'Garden3D LLC'), entry('usb-club', 'USB Club, LLC')]));
    expect(loadConfig({ ...valid(), QBO_COMPANIES: one }).companies.map((c) => c.key)).toEqual(['garden3d', 'usb-club']);
  });

  it('T2-2: the config and its companies cannot be changed', () => {
    const config: Config = loadConfig(valid());
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.companies)).toBe(true);
    expect(Object.isFrozen(config.companies[0])).toBe(true);
    expect(Object.isFrozen(config.companies[0].acceptedNames)).toBe(true);
    // The types say so too: each line below fails to compile if a field is writable.
    // @ts-expect-error companies is readonly
    expect(() => config.companies.push(config.companies[0])).toThrow(TypeError);
    // @ts-expect-error acceptedNames is readonly
    expect(() => config.companies[0].acceptedNames.push('x')).toThrow(TypeError);
    // @ts-expect-error key is readonly
    expect(() => (config.companies[0].key = 'x')).toThrow(TypeError);
    // @ts-expect-error stacksKey is readonly
    expect(() => (config.stacksKey = 'x')).toThrow(TypeError);
  });
});

describe('loadConfig: A6.2 refusals, each naming the key and never the value', () => {
  it('STACKS_QBO_URL unset, empty, not a url', () => {
    refuses({ ...valid(), STACKS_QBO_URL: undefined }, 'refused to start: STACKS_QBO_URL is not set');
    refuses({ ...valid(), STACKS_QBO_URL: '' }, 'refused to start: STACKS_QBO_URL is empty');
    refuses({ ...valid(), STACKS_QBO_URL: 'not a url' }, 'refused to start: STACKS_QBO_URL is not a URL', ['not a url']);
  });

  it.each([
    ['http://stacks.example.test', 'is not https'],
    ['ftp://stacks.example.test', 'is not https'],
    ['https://user@stacks.example.test', 'has a username'],
    ['https://:pass-' + 'word@stacks.example.test', 'has a password'],
    ['https://stacks.example.test/api', 'has a path'],
    ['https://stacks.example.test/api/', 'has a path'],
    ['https://stacks.example.test/?a=1', 'has a query or fragment'],
    ['https://stacks.example.test?', 'has a query or fragment'],
    ['https://stacks.example.test/#top', 'has a query or fragment'],
  ])('STACKS_QBO_URL %s: %s', (url, reason) => {
    const s = sentinel();
    refuses({ ...valid(), STACKS_QBO_URL: url.replace('stacks.example.test', `${s}.example.test`) }, `refused to start: STACKS_QBO_URL ${reason}`, [s]);
  });

  it('STACKS_QBO_TOKEN unset, empty', () => {
    refuses({ ...valid(), STACKS_QBO_TOKEN: undefined }, 'refused to start: STACKS_QBO_TOKEN is not set');
    refuses({ ...valid(), STACKS_QBO_TOKEN: '' }, 'refused to start: STACKS_QBO_TOKEN is empty');
  });

  it('QUICKBOOKS_ENVIRONMENT unset, sandbox, Production, empty', () => {
    refuses({ ...valid(), QUICKBOOKS_ENVIRONMENT: undefined }, 'refused to start: QUICKBOOKS_ENVIRONMENT is not set');
    for (const v of ['sandbox', 'Production', '', 'production ']) {
      refuses({ ...valid(), QUICKBOOKS_ENVIRONMENT: v }, 'refused to start: QUICKBOOKS_ENVIRONMENT is not production', [v.trim() === 'production' ? '' : v]);
    }
  });

  it('QBO_MODE write, READ, empty', () => {
    for (const v of ['write', 'READ', '', ' read']) {
      refuses({ ...valid(), QBO_MODE: v }, 'refused to start: QBO_MODE is not read', [v === 'write' || v === 'READ' ? v : '']);
    }
  });

  it('a refusal stops at the first failing key, in the contract’s order, and reads none after it', () => {
    const { env, touched } = recording({ ...valid(), STACKS_QBO_TOKEN: '', QBO_MODE: 'write' });
    refuses(env, 'refused to start: STACKS_QBO_TOKEN is empty');
    expect(touched.map(([, k]) => k)).toEqual(['STACKS_QBO_URL', 'STACKS_QBO_TOKEN']);
  });
});

describe('loadConfig: A2.8 QBO_COMPANIES refusals', () => {
  it('unset, empty, unreadable (missing file, a directory), never naming the path', () => {
    refuses({ ...valid(), QBO_COMPANIES: undefined }, 'refused to start: QBO_COMPANIES is not set');
    refuses({ ...valid(), QBO_COMPANIES: '' }, 'refused to start: QBO_COMPANIES is unreadable');
    const missing = path.join(tmp, sentinel() + '-missing.json');
    refuses({ ...valid(), QBO_COMPANIES: missing }, 'refused to start: QBO_COMPANIES is unreadable', [missing, path.basename(missing)]);
    refuses({ ...valid(), QBO_COMPANIES: tmp }, 'refused to start: QBO_COMPANIES is unreadable', [tmp]);
  });

  it.each([
    ['non-JSON', 'Sanctuary Computer Inc', 'is not JSON'],
    ['v missing', JSON.stringify({ companies: [entry('a', 'A')] }), 'has no v 1.0'],
    ['companies not an array', JSON.stringify({ v: '1.0', companies: {} }), 'companies is not an array'],
    ['no companies', entitiesText([]), 'has no companies'],
    ['a repeated stacks_key', entitiesText([entry('a', 'Alpha Co'), entry('a', 'Beta Co')]), 'repeats a stacks_key'],
    ['an entry missing a field', entitiesText([{ stacks_key: 'a', name: 'Alpha Co' }]), 'has a company with no valid accepted_names'],
    ['accepted_names[0] not name', entitiesText([{ stacks_key: 'a', name: 'Alpha Co', accepted_names: ['Beta Co'] }]), 'has a company whose accepted_names[0] is not its name'],
    ['an accepted name folding to an empty key', entitiesText([entry('a', '...')]), 'has an accepted name that folds to an empty key'],
    [
      "two companies' accepted names folding to one key",
      entitiesText([entry('garden3d', 'garden3d'), entry('other', 'Other Co', 'Garden3D LLC')]),
      'has two companies whose accepted names fold to the same key',
    ],
  ])('%s', (_what, text, reason) => {
    const p = companiesFile(text);
    refuses({ ...valid(), QBO_COMPANIES: p }, `refused to start: QBO_COMPANIES ${reason}`, [p, path.basename(p), 'Sanctuary', 'Alpha', 'Beta', 'Garden3D', 'Other Co']);
  });
});

// A6.1: every key touched, by which trap, while the entry's three start steps run in the entry's order.
type Trap = 'get' | 'has' | 'getOwnPropertyDescriptor' | 'ownKeys' | 'set' | 'defineProperty' | 'deleteProperty';
function recording(target: Record<string, string | undefined>) {
  const touched: Array<[Trap, string | symbol]> = [];
  const env = new Proxy(target, {
    get: (t, k) => (touched.push(['get', k]), Reflect.get(t, k)),
    has: (t, k) => (touched.push(['has', k]), Reflect.has(t, k)),
    getOwnPropertyDescriptor: (t, k) => (touched.push(['getOwnPropertyDescriptor', k]), Reflect.getOwnPropertyDescriptor(t, k)),
    ownKeys: (t) => (touched.push(['ownKeys', '*']), Reflect.ownKeys(t)),
    set: (t, k, v) => (touched.push(['set', k]), Reflect.set(t, k, v)),
    defineProperty: (t, k, d) => (touched.push(['defineProperty', k]), Reflect.defineProperty(t, k, d)),
    deleteProperty: (t, k) => (touched.push(['deleteProperty', k]), Reflect.deleteProperty(t, k)),
  });
  return { env, touched };
}

const ALLOWED = new Set([...FIVE, ...REFUSED_KEYS, ...GUARD_KEYS]);
const PRESENCE: Trap[] = ['has', 'getOwnPropertyDescriptor'];
const VALUE: Trap[] = ['get', 'has', 'getOwnPropertyDescriptor'];

/** The A6.1 assertion over a recording; returns its failures, so the traps' own test can see them fire. */
function violations(touched: Array<[Trap, string | symbol]>): string[] {
  const out: string[] = [];
  for (const [trap, key] of touched) {
    const k = String(key);
    if (trap === 'ownKeys') out.push('ownKeys enumerated the environment');
    else if (typeof key !== 'string' || !ALLOWED.has(k)) out.push(`${trap} ${k}: not an allowed key`);
    else if (REFUSED_KEYS.includes(k) && !PRESENCE.includes(trap)) out.push(`${trap} ${k}: a refused key read past presence`);
    else if (!VALUE.includes(trap)) out.push(`${trap} ${k}: written`);
  }
  for (const k of FIVE) if (!touched.some(([t, key]) => t === 'get' && key === k)) out.push(`${k} never read`);
  return out;
}

function fakeTools(): ReadTool[] {
  const def = (name: string): ReadTool => ({ name, description: 'd', schema: z.object({}), handler: (async () => ({ content: [] })) as any });
  return [...READ_ALLOWLIST.map(def), QboCompaniesTool];
}

describe('A6.1: reads only the five, decided by behaviour', () => {
  it('secureStart, startReadServer and loadConfig under one recording touch only allowed keys, each of the five read', () => {
    // Ignored and unrelated keys sit in the target, so a read of them, or an enumeration, would show.
    const target = { ...valid(), QBO_MODE: 'read', QUICKBOOKS_DISABLE_WRITE: 'true', QUICKBOOKS_TOKEN_STORE_PATH: sentinel(), QBO_PDF_OUTPUT_DIR: sentinel(), PATH: '/usr/bin' };
    const { env, touched } = recording(target);
    const tool = jest.fn();
    const restore = secureStart(env as NodeJS.ProcessEnv, []);
    try {
      startReadServer(env, { tool } as unknown as McpServer, fakeTools());
      loadConfig(env);
    } finally {
      restore();
    }
    expect(tool).toHaveBeenCalledTimes(32);
    expect(violations(touched)).toEqual([]);
    for (const k of REFUSED_KEYS) expect(touched.some(([t, key]) => PRESENCE.includes(t) && key === k)).toBe(true);
  });

  it('loadConfig alone reads each of the five by get, and nothing else', () => {
    const { env, touched } = recording({ ...valid(), QBO_MODE: 'read', PATH: '/usr/bin' });
    loadConfig(env);
    expect(violations(touched)).toEqual([]);
    expect(new Set(touched.map(([t, k]) => `${t} ${String(k)}`))).toEqual(new Set(FIVE.map((k) => `get ${k}`)));
  });

  it('the recording catches each thing it forbids (the traps fire)', () => {
    const r = recording({ ...valid(), PATH: '/usr/bin' });
    Reflect.ownKeys(r.env); // Object.keys would also take each key's descriptor
    void r.env.PATH;
    void r.env[REFUSED_KEYS[0]];
    void ('QUICKBOOKS_DISABLE_WRITE' in r.env);
    void Object.getOwnPropertyDescriptor(r.env, 'QBO_PDF_OUTPUT_DIR');
    r.env.QBO_MODE = 'write';
    Object.defineProperty(r.env, 'NODE_OPTIONS', { value: '', configurable: true });
    delete r.env.NODE_OPTIONS;
    expect(violations(r.touched)).toEqual([
      'ownKeys enumerated the environment',
      'get PATH: not an allowed key',
      `get ${REFUSED_KEYS[0]}: a refused key read past presence`,
      'has QUICKBOOKS_DISABLE_WRITE: not an allowed key',
      'getOwnPropertyDescriptor QBO_PDF_OUTPUT_DIR: not an allowed key',
      'set QBO_MODE: written',
      'defineProperty NODE_OPTIONS: written',
      'deleteProperty NODE_OPTIONS: written',
      ...FIVE.map((k) => `${k} never read`),
    ]);
    // A symbol key (an inspect or a coercion) is not an allowed key either.
    const s = recording({});
    void (s.env as any)[Symbol.toPrimitive];
    expect(violations(s.touched)).toContain('get Symbol(Symbol.toPrimitive): not an allowed key');
  });
});

// The only reader: a source read of any of the five sits in config.ts; 291's guard reads STACKS_QBO_URL to pin the origin, by name.
describe('loadConfig is the only reader of the five', () => {
  const srcFiles = (dir: string): string[] =>
    fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
      const rel = path.posix.join(dir, e.name);
      return e.isDirectory() ? srcFiles(rel) : e.name.endsWith('.ts') ? [rel] : [];
    });
  const READ = (k: string) => new RegExp(`\\.${k}\\b|\\[\\s*["'\`]${k}["'\`]\\s*\\]|[{,]\\s*${k}\\s*[,}:=]`);
  const EXEMPT: Record<string, string[]> = { 'src/clients/config.ts': FIVE, 'src/http-guard.ts': ['STACKS_QBO_URL'] };

  it('no other src file reads one of the five', () => {
    const hits: string[] = [];
    for (const f of srcFiles('src')) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      for (const k of FIVE) if (READ(k).test(text) && !(EXEMPT[f] ?? []).includes(k)) hits.push(`${f}: ${k}`);
    }
    expect(hits).toEqual([]);
    const config = fs.readFileSync(path.join(ROOT, 'src/clients/config.ts'), 'utf8');
    for (const k of FIVE) expect(READ(k).test(config)).toBe(true);
  });

  it('the scan sees each way of reading', () => {
    for (const s of ['env.QBO_MODE', 'env["QBO_MODE"]', "env[ 'QBO_MODE' ]", 'const { QBO_MODE } = env', 'const { a, QBO_MODE: m } = env']) {
      expect(READ('QBO_MODE').test(s)).toBe(true);
    }
    expect(READ('QBO_MODE').test('throw new Error(`QBO_MODE is not read`)')).toBe(false);
  });

  it("config.ts takes only readFileSync from fs", () => {
    const config = fs.readFileSync(path.join(ROOT, 'src/clients/config.ts'), 'utf8');
    expect(config.match(/from\s+["'](?:node:)?fs(?:\/[^"']*)?["']/g)).toEqual(['from "fs"']);
    expect(config).toMatch(/^import \{ readFileSync \} from "fs";$/m);
  });
});
