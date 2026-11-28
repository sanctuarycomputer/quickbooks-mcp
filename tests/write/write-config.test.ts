// Sanctuary Computer (quickbooks-mcp-293): isWriteMode and loadWriteConfig (contract §3's mode values and write keys; A1.3, PC2's mirror
// cases, plan's start keys A14), and that read mode never reads a write key.
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { READ_ALLOWLIST, startReadServer, type ReadTool } from '../../src/allowlist.js';
import { isWriteMode, loadConfig, loadWriteConfig } from '../../src/clients/config.js';
import { secureStart } from '../../src/http-guard.js';
import { QboCompaniesTool } from '../../src/tools/qbo-companies.tool.js';
import { STACKS_KEY, testEnv } from '../helpers/server.js';
import { WRITE_KEYS, writeEnv, writeRig } from './write-rig.js';

const FIVE = ['STACKS_QBO_URL', 'STACKS_QBO_TOKEN', 'QUICKBOOKS_ENVIRONMENT', 'QBO_COMPANIES', 'QBO_MODE'];
const FOUR = Object.keys(WRITE_KEYS);
const PASSED = ['NOTION_API_KEY', 'TZ', 'PATH'];
const NOT_WRITE = [undefined, '', 'read', 'Write', 'WRITE', 'readwrite', ' write', 'write ', 'write\n', 'true'];
writeRig();

/** An environment that records each key it is asked for, by any trap. */
function recording(target: Record<string, string | undefined>) {
  const touched: string[] = [];
  const note = (k: string | symbol) => void touched.push(String(k));
  const env = new Proxy(target, {
    get: (t, k) => (note(k), Reflect.get(t, k)),
    has: (t, k) => (note(k), Reflect.has(t, k)),
    getOwnPropertyDescriptor: (t, k) => (note(k), Reflect.getOwnPropertyDescriptor(t, k)),
    ownKeys: (t) => (note('*'), Reflect.ownKeys(t)),
  });
  return { env, touched };
}

describe('isWriteMode', () => {
  it('is true for exactly `write`', () => expect(isWriteMode({ QBO_MODE: 'write' })).toBe(true));
  it.each(NOT_WRITE)('%j: false', (v) => expect(isWriteMode({ QBO_MODE: v })).toBe(false));
  it('reads QBO_MODE and nothing else', () => {
    const { env, touched } = recording(writeEnv());
    isWriteMode(env);
    expect(touched).toEqual(['QBO_MODE']);
  });
});

describe('loadWriteConfig: accepted', () => {
  it('the five and the four, as given', () => {
    const cfg = loadWriteConfig(writeEnv());
    expect(cfg).toEqual({
      ...loadConfig(testEnv()),
      mode: 'write',
      receiptCmd: 'node receipt.mjs',
      writeSwitch: '/nowhere/switch',
      writeLedger: '/nowhere/writes.jsonl',
      sweepStamp: '/nowhere/stamp',
    });
    expect(Object.isFrozen(cfg)).toBe(true);
  });
  it('a write key is checked for being set and non-empty, nothing more', () => {
    const odd = Object.fromEntries(FOUR.map((k) => [k, ' ']));
    expect(loadWriteConfig(writeEnv(odd))).toMatchObject({ receiptCmd: ' ', writeSwitch: ' ', writeLedger: ' ', sweepStamp: ' ' });
  });
  // Changed by quickbooks-mcp-294 (plan T3, Q4): the receipt command's three passed keys are read here too, once, after the four, so
  // its child's environment is built from the config alone (spec A1.2, L-SEC-3). Still no start refusal for any of them.
  it('reads the five, then the four, each once, in contract §3’s order, then NOTION_API_KEY, TZ and PATH, and nothing else', () => {
    const { env, touched } = recording({ ...writeEnv(), NOTION_API_KEY: 'x', PATH: '/usr/bin', HOME: '/h' });
    loadWriteConfig(env);
    expect(touched).toEqual([...FIVE, ...FOUR, ...PASSED]);
  });
  it('keeps NOTION_API_KEY, TZ and PATH as given, each absent when unset (quickbooks-mcp-294)', () => {
    expect(loadWriteConfig(writeEnv({ NOTION_API_KEY: 'n', TZ: 'America/New_York', PATH: '/bin:/usr/bin' }))).toMatchObject({
      notionApiKey: 'n',
      tz: 'America/New_York',
      path: '/bin:/usr/bin',
    });
    const bare = loadWriteConfig(writeEnv());
    for (const key of ['notionApiKey', 'tz', 'path']) expect(Object.prototype.hasOwnProperty.call(bare, key)).toBe(false);
    expect(loadWriteConfig(writeEnv({ NOTION_API_KEY: '', TZ: '', PATH: '' }))).toMatchObject({ notionApiKey: '', tz: '', path: '' });
  });
});

describe('loadWriteConfig: refused', () => {
  it.each(NOT_WRITE)('QBO_MODE %j (PC2)', (v) => {
    expect(() => loadWriteConfig(writeEnv({ QBO_MODE: v }))).toThrow(new Error('refused to start: QBO_MODE is not write'));
  });
  it.each(FOUR)('%s unset, and empty', (key) => {
    expect(() => loadWriteConfig(writeEnv({ [key]: undefined }))).toThrow(new Error(`refused to start: ${key} is not set`));
    expect(() => loadWriteConfig(writeEnv({ [key]: '' }))).toThrow(new Error(`refused to start: ${key} is empty`));
  });
  it.each([
    ['STACKS_QBO_URL', undefined, 'is not set'],
    ['STACKS_QBO_URL', '', 'is empty'],
    ['STACKS_QBO_URL', 'http://stacks.example.test', 'is not https'],
    ['STACKS_QBO_TOKEN', undefined, 'is not set'],
    ['STACKS_QBO_TOKEN', '', 'is empty'],
    ['QUICKBOOKS_ENVIRONMENT', undefined, 'is not set'],
    ['QUICKBOOKS_ENVIRONMENT', 'sandbox', 'is not production'],
    ['QBO_COMPANIES', undefined, 'is not set'],
    ['QBO_COMPANIES', '', 'is unreadable'],
  ])('%s %j: as loadConfig', (key, value, reason) => {
    const error = new Error(`refused to start: ${key} ${reason}`);
    expect(() => loadWriteConfig(writeEnv({ [key]: value }))).toThrow(error);
    expect(() => loadConfig(testEnv({ [key]: value }))).toThrow(error);
  });
  it('stops at the first key that fails, and reads none after it', () => {
    const last = [...FIVE, ...FOUR];
    for (const [i, key] of last.entries()) {
      const { env, touched } = recording(writeEnv({ [key]: undefined }));
      expect(() => loadWriteConfig(env)).toThrow(`refused to start: ${key} is not`);
      expect(touched).toEqual(last.slice(0, i + 1));
    }
  });
  it('names the key, never a value', () => {
    let message = '';
    try {
      loadWriteConfig(writeEnv({ QBO_MODE: 'sentinel', QBO_WRITE_SWITCH: '' }));
    } catch (e) {
      message = (e as Error).message;
    }
    for (const value of ['sentinel', STACKS_KEY, ...Object.values(WRITE_KEYS)]) expect(message).not.toContain(value);
  });
});

describe('read mode', () => {
  let restore = () => {};
  afterEach(() => restore());
  it('loadConfig still refuses write mode, with its own text', () => {
    expect(() => loadConfig(writeEnv())).toThrow(new Error('refused to start: QBO_MODE is not read'));
  });
  it.each(['read', undefined])('QBO_MODE %j: the whole start reads none of the write keys, set as they are', (QBO_MODE) => {
    const { env, touched } = recording({ ...writeEnv({ QBO_MODE }), NOTION_API_KEY: 'x' });
    expect(isWriteMode(env)).toBe(false);
    restore = secureStart(env as NodeJS.ProcessEnv, []);
    const def = (name: string): ReadTool => ({ name, description: 'd', schema: z.object({}), handler: (async () => ({ content: [] })) as any });
    const tool = jest.fn();
    startReadServer(env, { tool } as unknown as McpServer, [...READ_ALLOWLIST.map(def), QboCompaniesTool]).close();
    expect(tool).toHaveBeenCalledTimes(32);
    expect(touched).toEqual(expect.arrayContaining(FIVE));
    expect(touched.filter((k) => [...FOUR, 'NOTION_API_KEY', '*'].includes(k))).toEqual([]);
  });
});
