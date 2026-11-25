// Sanctuary Computer (quickbooks-mcp-293): write mode's start, its tools and its stubs in process (A1.1-A1.4, A1.6, A3.10; contract §13).
// The spawned entry's half is entry.test.ts.
import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fakePath, NOW, testEnv } from '../helpers/server.js';
import { readError } from '../helpers/result-grammar.js';
import { COMPANIES_TOOL, READ_ALLOWLIST, REFUSED_KEYS, startWriteServer, WRITE_TOOLS, type WriteTool } from '../../src/allowlist.js';
import { loadConfig } from '../../src/clients/config.js';
import { createRuntime } from '../../src/clients/runtime.js';
import { QboCompaniesTool } from '../../src/tools/qbo-companies.tool.js';
import { CapabilityError } from '../../src/write/capability.js';
import { fetchById, sendUpdate, updateUrl } from '../../src/write/client.js';
import { writeMode } from '../../src/write/mode.js';
import { preSend, type CheckedRequest } from '../../src/write/pre-send.js';
import { asInput, byId, fixture, type Json } from './derive.js';
import { interceptorCount, WRITE_KEYS, writeEnv, writeRig } from './write-rig.js';

const rig = writeRig();
const KEYS = ['sanctuary-computer', 'garden3d', 'index-space', 'usb-club'];
const STUBS = ['qbo_categorize_purchase', 'qbo_categorize_bill', 'qbo_undo_change', 'qbo_write_check'];
/** A file's text with LF line ends, as a Windows checkout's CRLF would otherwise change what is matched. */
const lf = (text: string): string => text.replace(/\r\n/g, '\n');
const call = (name: string): Json => JSON.parse(readFileSync(fakePath(`tool-calls/${name}.json`), 'utf8'));
const NOT_BUILT = { isError: true, content: [{ type: 'text', text: 'reason: fork-error\n\nThis tool is not built yet.' }] };

// First in the file: 291's guard has never started in this module registry.
describe('before 291’s start', () => {
  it('startWriteServer is one refusal, registering nothing', () => {
    const tool = jest.fn();
    expect(() => startWriteServer(writeEnv(), { tool } as unknown as McpServer, writeMode().tools)).toThrow(new Error('refused to start: qbo-guard: not started'));
    expect(tool).not.toHaveBeenCalled();
  });
});

describe('tools/list (A1.1, §13)', () => {
  it('is exactly the five tools', async () => {
    const { client } = await rig.start();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(5);
    expect(new Set(names)).toEqual(new Set([...STUBS, 'qbo_companies']));
    expect([...WRITE_TOOLS].sort()).toEqual([...names].sort());
    expect(names.filter((n) => READ_ALLOWLIST.includes(n))).toEqual([]);
  });

  const ID = { type: 'string', pattern: '^[0-9]{1,20}$' };
  const CATEGORIZE = {
    type: 'object',
    properties: {
      id: ID,
      lines: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: { line_id: ID, account_id: ID, class_id: { anyOf: [ID, { type: 'null' }] } },
          required: ['line_id', 'account_id'],
          additionalProperties: false,
        },
      },
      reason: { type: 'string', minLength: 1, maxLength: 200, allOf: [{ type: 'string', pattern: '\\S' }, { type: 'string', pattern: '^[^\\p{Cc}\\u2028\\u2029]*$' }] },
    },
    required: ['id', 'lines', 'reason'],
    additionalProperties: false,
  };
  const RECEIPT = '^quickbooks-write:(sanctuary-computer|garden3d|index-space|usb-club):(purchase|bill):[0-9]{1,20}:[0-9]{1,20}:[1-9][0-9]{0,5}(:intent)?$';
  const categorizeText = (type: string) =>
    `Change the expense account (category) and optionally the class of existing expense lines on one QuickBooks ${type}. ` +
    "`reason` is a short plain sentence stored in the team's Audit Log: leave amounts out of it.";
  it.each([
    ['qbo_categorize_purchase', categorizeText('Purchase'), CATEGORIZE],
    ['qbo_categorize_bill', categorizeText('Bill'), CATEGORIZE],
    ['qbo_undo_change', 'Put back an earlier change made with a categorize tool, by its receipt key.', {
      type: 'object', properties: { receipt: { type: 'string', pattern: RECEIPT } }, required: ['receipt'], additionalProperties: false,
    }],
    ['qbo_write_check', "Run the write path's checks for a company without changing anything (the daily check's dry run).", {
      type: 'object', properties: { settle: { type: 'boolean', default: true } }, additionalProperties: false,
    }],
  ] as Array<[string, string, Json]>)('%s: §13’s description and schema', async (name, description, params) => {
    const { client } = await rig.start();
    const tool = (await client.listTools()).tools.find((t) => t.name === name)!;
    expect(tool.description).toBe(description);
    expect(tool.inputSchema).toEqual({
      $schema: expect.any(String),
      type: 'object',
      properties: { company: { type: 'string', enum: KEYS }, params },
      required: ['company', 'params'],
    });
  });

  it('qbo_companies is the read server’s own definition and answers as there', async () => {
    const { client, mode } = await rig.start();
    expect(mode.tools.filter((t) => t.name === COMPANIES_TOOL)).toEqual([QboCompaniesTool]);
    expect(mode.tools.at(-1)).toBe(QboCompaniesTool);
    const ok = JSON.parse(readFileSync(fakePath('tool-results/qbo_companies/ok.json'), 'utf8'));
    expect(await client.callTool({ name: 'qbo_companies', arguments: call('qbo_companies') })).toEqual(ok);
    const { inputSchema, description } = (await client.listTools()).tools.find((t) => t.name === COMPANIES_TOOL)!;
    expect([inputSchema.properties, inputSchema.required, description]).toEqual([{}, undefined, QboCompaniesTool.description]);
  });
});

describe('the stubs (A1.2)', () => {
  it.each([
    ['qbo_categorize_purchase', 'qbo_categorize_purchase'],
    ['qbo_categorize_purchase', 'qbo_categorize_purchase-clear-class'],
    ['qbo_categorize_bill', 'qbo_categorize_bill'],
    ['qbo_undo_change', 'qbo_undo_change'],
    ['qbo_write_check', 'qbo_write_check'],
    ['qbo_write_check', 'qbo_write_check-dry-run'],
  ])('%s, called as %s: fork-error, not built yet, and nothing is sent', async (name, file) => {
    const { client } = await rig.start();
    const result = await client.callTool({ name, arguments: call(file) });
    expect(result).toEqual(NOT_BUILT);
    expect(readError(result)).toEqual({ reason: 'fork-error', free: 'This tool is not built yet.', warnings: [] });
    expect(rig.net.calls).toEqual([]);
  });

  const P = 'qbo_categorize_purchase';
  const base = () => call(P).params as Json;
  const line = (over: Json) => ({ lines: [{ ...base().lines[0], ...over }] });
  const without = (o: Json, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
  const receipt = (text: string) => ({ receipt: text });
  const R = 'quickbooks-write:garden3d:purchase:1001:3:1';
  const ACCEPTED: Array<[string, string, Json]> = [
    ['an id of 20 digits', P, { ...base(), id: '1'.repeat(20) }],
    ['no class_id', P, { ...base(), lines: [without(base().lines[0], 'class_id')] }],
    ['21 lines (write:size is 294’s)', P, { ...base(), lines: Array.from({ length: 21 }, () => base().lines[0]) }],
    ['a reason of 200 code units', P, { ...base(), reason: 'é'.repeat(200) }],
    ['a reason of 200 code units, 100 characters', P, { ...base(), reason: '🙂'.repeat(100) }],
    ['a reason of 1', P, { ...base(), reason: 'x' }],
    ['a receipt with :intent', 'qbo_undo_change', receipt(`${R}:intent`)],
    ['an attempt of 6 digits', 'qbo_undo_change', receipt(R.replace(/1$/, '999999'))],
    ['settle true', 'qbo_write_check', { settle: true }],
  ];
  it.each(ACCEPTED)('takes %s', async (_label, name, params) => {
    const { client } = await rig.start();
    expect(await client.callTool({ name, arguments: { company: 'garden3d', params } })).toEqual(NOT_BUILT);
  });

  const REFUSED: Array<[string, string, Json]> = [
    ['an unknown key in params', P, { ...base(), memo: 'x' }],
    ['an unknown key in a line', P, { ...base(), ...line({ amount: '1' }) }],
    ['no id', P, without(base(), 'id')],
    ['an id of 21 digits', P, { ...base(), id: '1'.repeat(21) }],
    ['an empty id', P, { ...base(), id: '' }],
    ['an id that is a number', P, { ...base(), id: 1001 }],
    ['an id and a line break', P, { ...base(), id: '1001\n' }],
    ['no lines', P, without(base(), 'lines')],
    ['an empty lines', P, { ...base(), lines: [] }],
    ['a line without line_id', P, { ...base(), lines: [without(base().lines[0], 'line_id')] }],
    ['a line without account_id', P, { ...base(), lines: [without(base().lines[0], 'account_id')] }],
    ['a line_id that is no id', P, { ...base(), ...line({ line_id: 'x' }) }],
    ['an account_id that is null', P, { ...base(), ...line({ account_id: null }) }],
    ['a class_id that is empty', P, { ...base(), ...line({ class_id: '' }) }],
    ['no reason', P, without(base(), 'reason')],
    ['an empty reason', P, { ...base(), reason: '' }],
    ['a reason of white space', P, { ...base(), reason: '  ' }],
    ['a reason of 201', P, { ...base(), reason: 'x'.repeat(201) }],
    ['a reason of 201 code units, 101 characters', P, { ...base(), reason: `x${'🙂'.repeat(100)}` }],
    ...['\n', '\t', '\u007f', '\u0085', ' ', ' '].map((c): [string, string, Json] => [`a reason with ${JSON.stringify(c)}`, P, { ...base(), reason: `a${c}b` }]),
    ['an unknown key in undo’s params', 'qbo_undo_change', { ...receipt(R), id: '1' }],
    ['no receipt', 'qbo_undo_change', {}],
    ...['x' + R, R + 'x', R + ':intent:intent', R.replace('garden3d', 'north-fork'), R.replace('purchase', 'invoice'), R.replace(/1$/, '0'), R.replace(/1$/, '1000000')].map(
      (text): [string, string, Json] => [`the receipt ${text}`, 'qbo_undo_change', receipt(text)],
    ),
    ['settle that is a string', 'qbo_write_check', { settle: 'true' }],
    ['an unknown key in the check’s params', 'qbo_write_check', { dry: true }],
    ['params that is no object', 'qbo_write_check', [] as unknown as Json],
  ];
  it.each(REFUSED)('refuses %s, as the SDK’s input error', async (_label, name, params) => {
    const { client } = await rig.start();
    const r: any = await client.callTool({ name, arguments: { company: 'garden3d', params } });
    expect(r).toMatchObject({ isError: true, content: [{ type: 'text' }] });
    expect(r.content[0].text).toMatch(new RegExp(`^MCP error -32602: Input validation error: Invalid arguments for tool ${name}: `));
  });

  it.each([
    ['no company', { params: {} }],
    ['an unknown company', { company: 'north-fork', params: {} }],
    ['no params', { company: 'garden3d' }],
  ])('refuses %s, as the SDK’s input error', async (_label, args) => {
    const { client } = await rig.start();
    const r: any = await client.callTool({ name: 'qbo_write_check', arguments: args });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^MCP error -32602: Input validation error: Invalid arguments for tool qbo_write_check: /);
  });
});

describe('RegisterWriteTool (G2, H2)', () => {
  /** The rig's tools with one's handler replaced. */
  const withHandler = (name: string, handler: (...args: any[]) => any): WriteTool[] => writeMode().tools.map((t) => (t.name === name ? ({ ...t, handler } as WriteTool) : t));

  it('the handler sees company and params as sent, whatever is beside them, and the runtime; its answer is the result', async () => {
    const seen: any[][] = [];
    const answer = { content: [{ type: 'text', text: 'as it came' }] };
    const { client, runtime } = await rig.start({ tools: withHandler('qbo_categorize_purchase', async (...args) => (seen.push(args), answer)) });
    const args = call('qbo_categorize_purchase');
    expect(await client.callTool({ name: 'qbo_categorize_purchase', arguments: args })).toEqual(answer);
    expect(await client.callTool({ name: 'qbo_categorize_purchase', arguments: { ...args, id: '7', realm: '1', reason: 'x', lines: [] } })).toEqual(answer);
    expect(seen).toEqual([[args, runtime], [args, runtime]]);
    expect(seen[1][1]).toBe(runtime);
    expect(Object.keys(seen[1][0])).toEqual(['company', 'params']);
    expect(runtime.cfg).toMatchObject({ mode: 'write', receiptCmd: WRITE_KEYS.QBO_WRITE_RECEIPT_CMD });
    expect(rig.net.calls).toEqual([]); // no prepared call
  });

  it('settle’s default reaches the handler', async () => {
    const seen: unknown[] = [];
    const { client } = await rig.start({ tools: withHandler('qbo_write_check', async (args) => (seen.push(args), { content: [] })) });
    await client.callTool({ name: 'qbo_write_check', arguments: call('qbo_write_check') });
    expect(seen).toEqual([{ company: 'garden3d', params: { settle: true } }]);
  });

  it.each([
    ['throws', () => { throw thrown; }],
    ['rejects', () => Promise.reject(thrown)],
  ])('a handler that %s is fork-error, the thrown value never read', async (_label, handler) => {
    reads.length = 0;
    const { client } = await rig.start({ tools: withHandler('qbo_write_check', handler) });
    expect(await client.callTool({ name: 'qbo_write_check', arguments: call('qbo_write_check') })).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'reason: fork-error\n\nThe server failed before it could read QuickBooks.' }],
    });
    expect(reads).toEqual([]);
  });
  const reads: string[] = [];
  const thrown: any = new Proxy(function () {}, {
    get: (_t, k) => void reads.push(String(k)),
    has: (_t, k) => (reads.push(String(k)), false),
    getPrototypeOf: () => (reads.push('prototype'), null),
  });
});

describe('start refusals (A1.3)', () => {
  const tool = jest.fn();
  const refuse = (env: Record<string, string | undefined>, message: string, tools: readonly WriteTool[] = writeMode().tools) => {
    tool.mockClear();
    rig.secure(writeEnv(), writeMode());
    const before = interceptorCount();
    expect(() => startWriteServer(env, { tool } as unknown as McpServer, tools)).toThrow(new Error(message));
    expect(tool).not.toHaveBeenCalled();
    expect(interceptorCount()).toBe(before);
    expect(rig.net.calls).toEqual([]);
  };

  it.each(Object.keys(WRITE_KEYS))('%s unset', (key) => refuse(writeEnv({ [key]: undefined }), `refused to start: ${key} is not set`));
  it.each(Object.keys(WRITE_KEYS))('%s empty', (key) => refuse(writeEnv({ [key]: '' }), `refused to start: ${key} is empty`));
  it.each([undefined, '', 'read', 'Write', 'readwrite'])('QBO_MODE %j (PC2)', (v) => refuse(writeEnv({ QBO_MODE: v }), 'refused to start: QBO_MODE is not write'));
  it.each([...REFUSED_KEYS])('%s set, even empty, before anything else', (key) => refuse({ [key]: '' }, `refused to start: ${key} is set`));
  it('STACKS_QBO_URL unset, a key of the five', () => refuse(writeEnv({ STACKS_QBO_URL: undefined }), 'refused to start: STACKS_QBO_URL is not set'));

  const tools = () => writeMode().tools;
  const extra = (name: string): WriteTool => ({ ...(tools()[3] as any), name });
  it.each(WRITE_TOOLS)('A1.4: without %s', (name) => refuse(writeEnv(), `refused to start: allowlist: missing ${name}`, tools().filter((t) => t.name !== name)));
  it.each(['search_bills', 'get_company_info', 'qbo_anything'])('A1.4: with %s too', (name) => refuse(writeEnv(), `refused to start: allowlist: unlisted ${name}`, [...tools(), extra(name)]));
  it('A1.4: with one twice', () => refuse(writeEnv(), 'refused to start: allowlist: duplicate qbo_undo_change', [...tools(), tools()[2]]));
  it('A1.4: a write tool with no schema, and qbo_companies with one', () => {
    refuse(writeEnv(), 'refused to start: allowlist: unlisted qbo_write_check', tools().map((t) => (t.name === 'qbo_write_check' ? { ...QboCompaniesTool, name: t.name } : t)));
  });
  it('A1.4: qbo_companies with a schema', () => {
    refuse(writeEnv(), 'refused to start: allowlist: unlisted qbo_companies', tools().map((t) => (t.name === COMPANIES_TOOL ? extra(COMPANIES_TOOL) : t)));
  });
});

describe('params that aren’t strict (contract §13)', () => {
  // The stripping one compiles as a write tool's schema: zod's strict and stripping objects have one type.
  const shape = { settle: z.boolean().default(true) };
  const selfHeld: z.ZodType = z.strictObject({
    get a() {
      return z.array(selfHeld).optional();
    },
  });
  const endless = (): z.ZodType =>
    z.strictObject({
      get a() {
        return endless().optional();
      },
    });
  const LOOSE: Array<[string, any]> = [
    ['a stripping z.object', z.object(shape)],
    ['a loose object', z.looseObject(shape)],
    ['an object with another catchall', z.object(shape).catchall(z.string())],
    ['a strict object made loose', z.strictObject(shape).loose()],
    ['a strict object in a transform', z.strictObject(shape).transform((v) => v)],
    ['a loose object in it', z.strictObject({ a: z.object(shape) })],
    ['a loose object in an array in it', z.strictObject({ a: z.string(), b: z.array(z.object(shape)) })],
    ['a loose object in an optional array in it', z.strictObject({ a: z.array(z.object(shape)).min(1).optional() })],
    ['a loose object in a strict line', z.strictObject({ a: z.array(z.strictObject({ b: z.object(shape).nullable() })) })],
    ['a loose object in a union in it', z.strictObject({ a: z.union([z.string(), z.object(shape)]) })],
    ['a lazy schema in it, which isn’t walked', z.strictObject({ a: z.lazy(() => z.strictObject(shape)) })],
    // Forms held under a def key of their own (TJ5).
    ['a loose object in a record in it', z.strictObject({ a: z.record(z.string(), z.object(shape)) })],
    ['a loose object in a tuple in it', z.strictObject({ a: z.tuple([z.string(), z.object(shape)]) })],
    ['a loose object in an intersection in it', z.strictObject({ a: z.intersection(z.strictObject(shape), z.object(shape)) })],
    ['a loose object in a pipe in it', z.strictObject({ a: z.string().pipe(z.transform(() => ({}))).pipe(z.object(shape)) })],
    ['a loose object in a map in it', z.strictObject({ a: z.map(z.string(), z.object(shape)) })],
    // Schemas that let an object of any keys through (TJ3).
    ['any in it', z.strictObject({ a: z.any() })],
    ['unknown in it', z.strictObject({ a: z.unknown() })],
    ['a custom schema in it', z.strictObject({ a: z.custom<object>(() => true) })],
    ['a record of unknown in it', z.strictObject({ a: z.record(z.string(), z.unknown()) })],
    // TJ2: zod's way to write a recursive schema without z.lazy, and one made anew at each read.
    ['a strict object that holds itself', selfHeld],
    ['a strict object that holds a new one like it', endless()],
    // Wrappers that can hide an object's keys (TM4).
    ['a loose object before a transform in it', z.strictObject({ a: z.object(shape).transform((v) => v) })],
    ['a bare transform in it', z.strictObject({ a: z.transform((v) => v) })],
    ['a preprocess in it', z.strictObject({ a: z.preprocess((v) => v, z.strictObject(shape)) })],
    ['a catch on a strict line in it', z.strictObject({ a: z.array(z.strictObject(shape).catch({ settle: true })) })],
    ['a catch on params’ field', z.strictObject({ a: z.string().catch('x') })],
    ['a success in it', z.strictObject({ a: z.success(z.strictObject(shape)) })],
    ['a loose object after a strict one’s transform', z.strictObject({ a: z.strictObject(shape).transform((v) => v).pipe(z.object({ settle: z.boolean() })) })],
    ['a strict schema nested past the depth limit', z.strictObject({ a: Array.from({ length: 32 }).reduce<z.ZodType>((s) => z.strictObject({ a: s }), z.boolean()) })],
    ['no zod schema', {}],
  ];
  /** Its tool last, after every other. */
  const withSchema = (schema: any): WriteTool[] => {
    const tools = writeMode().tools;
    return [...tools.filter((t) => t.name !== 'qbo_write_check'), { ...tools.find((t) => t.name === 'qbo_write_check'), schema } as WriteTool];
  };

  it.each(LOOSE)('%s: the start is refused, nothing registered and the runtime closed', (_label, schema) => {
    const tool = jest.fn();
    rig.secure(writeEnv(), writeMode());
    const before = interceptorCount();
    expect(() => startWriteServer(writeEnv(), { tool } as unknown as McpServer, withSchema(schema))).toThrow(
      new Error('refused to start: allowlist: params not strict qbo_write_check'),
    );
    expect(tool).not.toHaveBeenCalled();
    expect(interceptorCount()).toBe(before);
  });

  // Every case above has the loose tool last (TJ6).
  it.each(STUBS)('a loose schema on %s, in its own place', (name) => {
    const tool = jest.fn();
    rig.secure(writeEnv(), writeMode());
    const tools = writeMode().tools.map((t) => (t.name === name ? ({ ...t, schema: z.object(shape) } as WriteTool) : t));
    expect(() => startWriteServer(writeEnv(), { tool } as unknown as McpServer, tools)).toThrow(new Error(`refused to start: allowlist: params not strict ${name}`));
    expect(tool).not.toHaveBeenCalled();
  });

  it('a strict one, with a check of its own, is registered', async () => {
    const { client } = await rig.start({ tools: withSchema(z.strictObject({ ...shape, one: z.string().refine(() => true), same: shape.settle, kept: z.strictObject(shape).transform((v) => v), codec: z.codec(z.string(), z.number(), { decode: Number, encode: String }), deep: Array.from({ length: 31 }).reduce<z.ZodType>((s) => z.strictObject({ a: s }), z.boolean()), lines: z.array(z.strictObject(shape).optional()).refine(() => true) }).refine(() => true)) });
    expect((await client.listTools()).tools).toHaveLength(5);
  });
});

/** The company's books, for the check's fetches. */
function answerBooks(): void {
  const books: Json = { preferences: fixture('preferences/book-close-date.json'), 'purchase/1001': fixture('fetched/purchase-1001.json') };
  for (const [id, body] of byId('accounts')) books[`account/${id}`] = body;
  for (const [id, body] of byId('classes')) books[`class/${id}`] = body;
  rig.answer = (c) => (c.method === 'GET' ? { status: 200, body: JSON.stringify(books[/company\/[0-9]+\/(.*)\?/.exec(c.path!)![1]]) } : { status: 200 });
}
/** 297's purchase case through the started server's own guard. */
async function checkedPurchase(): Promise<CheckedRequest> {
  answerBooks();
  const out: any = await rig.inCall(() => preSend(asInput('account-and-class').input as any));
  expect(out).toMatchObject({ ok: true });
  rig.net.calls.length = 0;
  return out.checked;
}
const send = (checked: CheckedRequest) => rig.inCall(() => sendUpdate(checked));

describe('A3.10: the guard write mode starts', () => {
  it('takes from the registry writeMode gives, which is createRegistry’s own', async () => {
    const { mode } = await rig.start();
    const checked = await checkedPurchase();
    // Nothing registered: refused, so no permissive registry.
    await expect(send(checked)).rejects.toMatchObject({ name: 'GuardRefusedError', rule: 'write-update' });
    expect(rig.posts()).toEqual([]);
    expect(() => mode.registry.register({ ...checked } as CheckedRequest)).toThrow(CapabilityError);
    expect(() => mode.registry.register({} as CheckedRequest)).toThrow(CapabilityError);
    expect(mode.registry.size).toBe(0);
    mode.registry.register(checked);
    expect(mode.registry.size).toBe(1);
    expect((await send(checked)).status).toBe(200);
    expect(mode.registry.size).toBe(0);
    expect(rig.posts().map((c) => c.body)).toEqual([checked.bodyText]);
    await expect(send(checked)).rejects.toMatchObject({ rule: 'write-update' });
    expect(rig.posts()).toHaveLength(1);
  });

  it('is asked about the call’s own company', async () => {
    const { mode } = await rig.start();
    const checked = await checkedPurchase();
    mode.registry.register(checked);
    // The same request in another company's call, the realm that call's own.
    const { guardedAxios } = await import('../../src/http-guard.js');
    const post = (realm: string) =>
      guardedAxios().post(updateUrl(realm, 'purchase'), checked.bodyText, { transformRequest: [(t: unknown) => t], headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 1000 });
    await expect(rig.inCall(() => post('9990000000000003'), 'index-space')).rejects.toMatchObject({ rule: 'write-update' });
    expect(mode.registry.size).toBe(1);
    expect((await send(checked)).status).toBe(200);
  });

  it('two write modes share no registry, and nothing is made until it is called', async () => {
    const other = writeMode();
    const { mode } = await rig.start();
    const checked = await checkedPurchase();
    expect(other.registry).not.toBe(mode.registry);
    other.registry.register(checked);
    expect(mode.registry.size).toBe(0);
    await expect(send(checked)).rejects.toMatchObject({ rule: 'write-update' });
    expect(other.registry.size).toBe(1);
  });

  it('what writeMode gives can’t be swapped after', () => {
    const mode = writeMode();
    for (const o of [mode, mode.registry, mode.extraRules, mode.tools]) expect(Object.isFrozen(o)).toBe(true);
  });
});

describe('A1.6: read mode’s guard', () => {
  it('refuses the POST a live capability allows, and the by-id fetch, sending nothing', async () => {
    const mode = writeMode();
    await rig.start({ mode });
    const checked = await checkedPurchase();
    mode.registry.register(checked);
    await rig.stop();

    // The entry's read start: no third argument.
    rig.secure(testEnv());
    const runtime = createRuntime(loadConfig(testEnv()), { now: () => NOW });
    rig.onStop(() => runtime.close());
    await expect(send(checked)).rejects.toMatchObject({ name: 'GuardRefusedError' });
    await expect(rig.inCall(() => fetchById('purchase', '1001'))).rejects.toMatchObject({ name: 'GuardRefusedError', rule: 'entity-by-id' });
    expect(rig.net.calls).toEqual([]);
    expect(mode.registry.size).toBe(1);
    await rig.stop();

    // The same capability, in write mode's: it was live all along.
    await rig.start({ mode });
    expect((await send(checked)).status).toBe(200);
  });
});

describe('what the read start loads', () => {
  it.each(['src/allowlist.ts', 'src/helpers/register-tool.ts', 'src/index.ts'])('%s imports nothing under src/write, but for the entry’s one dynamic import', (file) => {
    const text = lf(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
    expect(text.match(/["'`][^"'`\n]*write\/[^"'`\n]*["'`]/g) ?? []).toEqual(file === 'src/index.ts' ? ['"./write/mode.js"'] : []);
    expect(text.includes('import("./write/mode.js")')).toBe(file === 'src/index.ts');
  });
});
