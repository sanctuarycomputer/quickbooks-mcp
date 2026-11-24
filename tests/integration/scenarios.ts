// Sanctuary Computer (quickbooks-mcp-286): the scenario table spec A5.7 replays (token-absent.test.ts). One row per path a
// call can take: success, each error reason, each resend, a guard refusal, Stacks errors whose body echoes the key, and
// QuickBooks answers whose fault Detail or intuit_tid holds the access token. Stacks hands out distinctive tokens and the
// server runs with a distinctive STACKS_QBO_TOKEN; every value is built at runtime, so no secret-shaped literal sits here.
import { z } from 'zod';
import { stacksFixture, type StacksFakeOpts } from '../fakes/stacks-token.js';
import type { StubAnswer, StubCall } from '../fakes/stub-network.js';
import { guardedAxios } from '../../src/http-guard.js';
import { QBO_LIMIT_MS } from '../../src/clients/qbo-transport.js';
import type { ReadTool } from '../../src/allowlist.js';
import { QBO_HOST, REALMS, readTools } from '../helpers/server.js';

/** The distinctive access tokens Stacks hands out (the first, then a refetch's), and the distinctive STACKS_QBO_TOKEN. */
export const TOKEN = ['tok', 'Q7x', 'Zv9', 'first'].join('-');
export const TOKEN_2 = ['tok', 'Q7x', 'Zv9', 'second'].join('-');
export const KEY = ['key', 'M4w', 'Pd2', 'Hn6'].join('-');
export const SECRETS = [TOKEN, TOKEN_2, KEY];

/** A Stacks 200 for garden3d handing out `token`, with `over` applied. */
export function handOut(token: string, over: Record<string, unknown> = {}): { status: number; body: Record<string, unknown> } {
  return { status: 200, body: { ...(stacksFixture('200-garden3d.json').body as object), access_token: token, ...over } };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): StubAnswer => ({ status, headers, body: JSON.stringify(body) });
/** A QuickBooks fault whose Detail holds `said`. */
const fault = (status: number, said: string, headers: Record<string, string> = {}) => json(status, { Fault: { Error: [{ Message: 'Request failed', Detail: said }], type: 'ValidationFault' } }, headers);

export type Scenario = {
  name: string;
  tool: string;
  params?: Record<string, unknown>;
  stacks?: StacksFakeOpts;
  /** The QuickBooks request numbered `n` (0 is the first-use companyinfo read): an answer, or undefined for the fake's. */
  qbo?: (n: number, call: StubCall) => StubAnswer | Promise<StubAnswer> | undefined;
  /** Replaces the tools the server registers. */
  tools?: () => Promise<ReadTool[]>;
  /** Fake timers, advanced by this many ms once the call is sent. */
  advance?: number;
  /** What reaches the wire (T13-7): the Stacks requests, and each QuickBooks request's bearer token in order. */
  sent: { stacks: number; bearers: string[] };
  /** The result's `reason:`, or 'ok' for a success. */
  reason: string;
};

const ONE_TOKEN: StacksFakeOpts = { sequence: [handOut(TOKEN)] };
const TWO_TOKENS: StacksFakeOpts = { sequence: [handOut(TOKEN), handOut(TOKEN_2)] };
const never = () => new Promise<StubAnswer>(() => {});

/** get_company_info's handler replaced by one asking another company's realm inside the call: the guard refuses it. */
async function guardRefusing(): Promise<ReadTool[]> {
  const probe = async () => {
    const usb = REALMS['usb-club'];
    await guardedAxios()({ method: 'get', url: `https://${QBO_HOST}/v3/company/${usb}/companyinfo/${usb}?minorversion=75&format=json`, headers: { Authorization: `Bearer ${TOKEN}` } });
    return { content: [{ type: 'text', text: '{}' }] };
  };
  return (await readTools()).map((t) => (t.name === 'get_company_info' ? ({ name: t.name, description: t.description, schema: z.object({}), handler: probe } as unknown as ReadTool) : t));
}

export const SCENARIOS: Scenario[] = [
  { name: 'success: get_company_info', tool: 'get_company_info', stacks: ONE_TOKEN, sent: { stacks: 1, bearers: [TOKEN, TOKEN] }, reason: 'ok' },
  { name: 'success: search_purchases', tool: 'search_purchases', stacks: ONE_TOKEN, sent: { stacks: 1, bearers: [TOKEN, TOKEN] }, reason: 'ok' },
  { name: 'name-mismatch, source stacks', tool: 'get_company_info', stacks: { sequence: [handOut(TOKEN, { company_name: 'Garden Three LLC' })] }, sent: { stacks: 1, bearers: [] }, reason: 'name-mismatch' },
  {
    name: 'name-mismatch, source quickbooks',
    tool: 'get_company_info',
    stacks: ONE_TOKEN,
    qbo: (n) => (n === 0 ? json(200, { CompanyInfo: { CompanyName: 'Garden Three Studio' }, time: '2026-11-18T00:00:00.000Z' }) : undefined),
    sent: { stacks: 1, bearers: [TOKEN] }, reason: 'name-mismatch',
  },
  { name: 'not-connected (409)', tool: 'search_bills', stacks: { sequence: ['409.json'] }, sent: { stacks: 1, bearers: [] }, reason: 'not-connected' },
  { name: 'unknown-enterprise (404)', tool: 'search_bills', stacks: { sequence: ['404.json'] }, sent: { stacks: 1, bearers: [] }, reason: 'unknown-enterprise' },
  { name: 'renewal-failed:invalid_grant (502)', tool: 'search_bills', stacks: { sequence: ['502-invalid_grant.json'] }, sent: { stacks: 1, bearers: [] }, reason: 'renewal-failed:invalid_grant' },
  { name: 'renewal-failed:unavailable (502)', tool: 'search_bills', stacks: { sequence: ['502-unavailable.json'] }, sent: { stacks: 1, bearers: [] }, reason: 'renewal-failed:unavailable' },
  {
    name: 'stacks-auth: a 403 whose body echoes the key',
    tool: 'get_company_info',
    stacks: { sequence: [{ status: 403, body: { errors: [{ status: 'forbidden', detail: `the key ${KEY} is revoked` }] } }] },
    sent: { stacks: 1, bearers: [] }, reason: 'stacks-auth',
  },
  { name: 'stacks-unreachable: a 502 page echoing the key, twice', tool: 'get_company_info', stacks: { sequence: [{ status: 502, body: `<html>bad gateway for ${KEY}</html>` }] }, sent: { stacks: 2, bearers: [] }, reason: 'stacks-unreachable' },
  { name: 'stacks-unreachable: the connection refused, twice', tool: 'get_company_info', stacks: { refuse: 'refused' }, sent: { stacks: 2, bearers: [] }, reason: 'stacks-unreachable' },
  { name: 'fork-error: a Stacks 200 with a sixth key echoing the key and the token', tool: 'get_company_info', stacks: { sequence: [handOut(TOKEN, { refresh_token: `${KEY}.${TOKEN}` })] }, sent: { stacks: 1, bearers: [] }, reason: 'fork-error' },
  { name: 'stacks-unreachable: a 409 whose body echoes the key, a form the mapping does not know, twice', tool: 'get_company_info', stacks: { sequence: [{ status: 409, body: { error: 'not-connected', key: KEY } }] }, sent: { stacks: 2, bearers: [] }, reason: 'stacks-unreachable' },
  { name: 'fork-error: a guard refusal inside the call', tool: 'get_company_info', stacks: ONE_TOKEN, tools: guardRefusing, sent: { stacks: 1, bearers: [TOKEN] }, reason: 'fork-error' },
  { name: 'http-500 with an intuit_tid', tool: 'search_purchases', stacks: ONE_TOKEN, qbo: (n) => (n === 1 ? json(500, {}, { intuit_tid: 'tid-500-one' }) : undefined), sent: { stacks: 1, bearers: [TOKEN, TOKEN] }, reason: 'http-500' },
  {
    name: 'http-500 whose intuit_tid holds the token inside a longer value (TC6-1)',
    tool: 'search_purchases',
    stacks: ONE_TOKEN,
    qbo: (n) => (n === 1 ? json(500, {}, { intuit_tid: `t-${TOKEN}-x` }) : undefined),
    sent: { stacks: 1, bearers: [TOKEN, TOKEN] }, reason: 'http-500',
  },
  { name: 'http-500 whose intuit_tid is the key', tool: 'search_purchases', stacks: ONE_TOKEN, qbo: (n) => (n === 1 ? json(500, {}, { intuit_tid: KEY }) : undefined), sent: { stacks: 1, bearers: [TOKEN, TOKEN] }, reason: 'http-500' },
  { name: 'timeout: QuickBooks never answers the tool\'s request', tool: 'get_preferences', stacks: ONE_TOKEN, qbo: (n) => (n === 1 ? never() : undefined), advance: QBO_LIMIT_MS, sent: { stacks: 1, bearers: [TOKEN, TOKEN] }, reason: 'timeout' },
  { name: 'resend after a 401: the refetched token, then the data', tool: 'search_purchases', stacks: TWO_TOKENS, qbo: (n) => (n === 1 ? fault(401, `token ${TOKEN} expired`) : undefined), sent: { stacks: 2, bearers: [TOKEN, TOKEN, TOKEN_2] }, reason: 'ok' },
  { name: 'resend after a 429: then the data', tool: 'search_purchases', stacks: ONE_TOKEN, qbo: (n) => (n === 1 ? fault(429, `slow down ${TOKEN}`, { 'retry-after': '0' }) : undefined), sent: { stacks: 1, bearers: [TOKEN, TOKEN, TOKEN] }, reason: 'ok' },
  {
    name: 'http-400 whose fault Detail holds the token and the key',
    tool: 'search_purchases',
    stacks: ONE_TOKEN,
    qbo: (n) => (n === 1 ? fault(400, `bad request with bearer ${TOKEN} and key ${KEY} and ${TOKEN}${TOKEN}`) : undefined),
    sent: { stacks: 1, bearers: [TOKEN, TOKEN] }, reason: 'http-400',
  },
  {
    name: 'http-401: a 401 whose fault Detail holds the token, and its resend\'s holds the refetched one',
    tool: 'search_purchases',
    stacks: TWO_TOKENS,
    qbo: (n) => (n === 1 ? fault(401, `token ${TOKEN} expired`, { intuit_tid: TOKEN }) : n === 2 ? fault(401, `token ${TOKEN_2} expired`, { intuit_tid: TOKEN_2 }) : undefined),
    sent: { stacks: 2, bearers: [TOKEN, TOKEN, TOKEN_2] }, reason: 'http-401',
  },
  {
    name: 'http-400: a 401, then a 400 echoing the refetched token',
    tool: 'search_purchases',
    stacks: TWO_TOKENS,
    qbo: (n) => (n === 1 ? fault(401, `token ${TOKEN} expired`) : n === 2 ? fault(400, `bad request, bearer ${TOKEN_2}, old ${TOKEN}`) : undefined),
    sent: { stacks: 2, bearers: [TOKEN, TOKEN, TOKEN_2] }, reason: 'http-400',
  },
  { name: 'http-401 on the first-use read, its resend refused by Stacks (403)', tool: 'get_company_info', stacks: { sequence: [handOut(TOKEN), { status: 403, body: { errors: [{ status: 'forbidden', key: KEY }] } }] }, qbo: (n) => (n === 0 ? fault(401, `token ${TOKEN}`) : undefined), sent: { stacks: 2, bearers: [TOKEN] }, reason: 'stacks-auth' },
];
