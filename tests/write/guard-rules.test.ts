// Sanctuary Computer (quickbooks-mcp-293): A3.2, A3.3, A3.5 and A3.9 as pure decisions, and contract 1.1 §16's Write guard examples
// (docs/contracts/quickbooks.md in Stacksbot).
import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decide, newCallRecord, type GuardContext, type GuardRequest } from '../../src/clients/guard-decide.js';
import { sha256Hex } from '../../src/write/canonical.js';
import { decideDry, decideWrite, type CapabilityRegistry } from '../../src/write/guard-rules.js';
import { StubRegistry } from './stub-registry.js';

/** A file's text with LF line ends, as a Windows checkout's CRLF would otherwise change what is matched. */
const lf = (text: string): string => text.replace(/\r\n/g, '\n');
const CASE = JSON.parse(readFileSync(fileURLToPath(new URL('../fakes/transactions/cases/account-and-class.json', import.meta.url)), 'utf8'));
const SPARSE = CASE.sparse_body as Record<string, unknown>;
const B = JSON.stringify(SPARSE);
const without = (...keys: string[]) => JSON.stringify(Object.fromEntries(Object.entries(SPARSE).filter(([k]) => !keys.includes(k))));
const withField = (key: string, value: unknown) => JSON.stringify({ ...SPARSE, [key]: value });

const COMPANY = 'garden3d';
const REALM = '9990000000000002';
const HOST = 'quickbooks.api.intuit.com';
const ROOT = `https://${HOST}/v3/company/${REALM}`;
const QUERY = 'operation=update&minorversion=75';
const UPDATE = `${ROOT}/purchase?${QUERY}`;

const context = (over: Partial<GuardContext> = {}): GuardContext => {
  const record = newCallRecord();
  return {
    stacksUrl: 'https://stacks.example.test',
    keys: () => ['sanctu', 'garden3d', 'index-space', 'usb-club'],
    allowedRealm: (realm) => realm === REALM,
    callRecord: () => record,
    ...over,
  };
};
const boom = (): never => {
  throw new Error('boom');
};
const company = () => COMPANY;
const post = (over: Partial<GuardRequest> = {}): GuardRequest => ({ method: 'POST', url: UPDATE, headers: {}, data: B, ...over });
const get = (path: string, over: Partial<GuardRequest> = {}): GuardRequest => ({ method: 'GET', url: ROOT + path, headers: {}, ...over });
const holding = (body = B, entity = 'purchase', owner = COMPANY) => new StubRegistry().hold(owner, entity, body);

const write = (req: GuardRequest, registry: CapabilityRegistry = holding(), ctx = context(), who: () => string | undefined = company) =>
  decideWrite(req, ctx, { company: who, registry });
/** What write mode's adapter does: the write rules first, then 291's decide. */
const decided = (req: GuardRequest, registry: CapabilityRegistry = holding(), ctx = context(), who: () => string | undefined = company) => {
  const own = write(req, registry, ctx, who);
  return 'match' in own ? decide(req, ctx) : own;
};
const dry = (req: GuardRequest, ctx = context(), who: () => string | undefined = company) => decideDry(req, ctx, { company: who });

const UNMATCHED = { match: false };
const refused = (rule: string) => ({ allow: false, rule });
const REFUSED = refused('write-update');
const allowed = (url = UPDATE) => ({ allow: true, rule: 'write-update', text: url, url });
/** A 291-shaped decision as the dry one says it: `answer`, and no `allow` key. */
const asDry = ({ allow, ...rest }: { allow: boolean }) => ({ answer: allow ? 'allow' : 'refuse', ...rest });
const needsCapability = (url = UPDATE) => ({ answer: 'allowed-with-capability', rule: 'write-update', text: url, url });
const fetched = (url: string) => ({ allow: true, rule: 'entity-by-id-write', text: url, url });

/** Refused by the real decision and the dry one alike, `take` never reached, and the capabilities still there to use. */
function refusedUnconsumed(req: GuardRequest, rule: string, registry = holding(), ctx = context(), who: () => string | undefined = company) {
  const size = registry.size;
  expect(decided(req, registry, ctx, who)).toEqual(refused(rule));
  expect(registry.takes).toEqual([]);
  expect(registry.size).toBe(size);
  expect(dry(req, ctx, who)).toEqual(asDry(refused(rule)));
  const valid = new StubRegistry().hold(COMPANY, 'purchase', B);
  expect(write(req, valid, ctx, who)).not.toMatchObject({ allow: true });
  expect(write(post(), valid)).toEqual(allowed());
}

describe('the allowed update', () => {
  it('B is the body the fixture states the hash of', () => {
    expect(sha256Hex(B)).toBe(CASE.sparse_body_sha256);
    expect(CASE.update).toBe(`POST ${UPDATE}`);
  });

  it.each([
    ['purchase', QUERY],
    ['purchase', 'minorversion=75&operation=update'],
    ['bill', QUERY],
    ['bill', 'minorversion=75&operation=update'],
  ])('%s?%s is allowed once, on its own entity and body', (entity, query) => {
    const url = `${ROOT}/${entity}?${query}`;
    const registry = holding(B, entity);
    expect(write(post({ url }), registry)).toEqual(allowed(url));
    expect(new URL(url).href).toBe(url);
    expect(registry.takes).toEqual([{ company: COMPANY, entity, sha: sha256Hex(B), taken: true }]);
    expect(registry.hasCalls).toBe(0);
    expect(write(post({ url }), registry)).toEqual(REFUSED);
  });

  it.each(['post', 'Post', 'POST'])('method %s', (method) => {
    expect(write(post({ method }))).toEqual(allowed());
    expect(dry(post({ method }))).toEqual(needsCapability());
  });

  it.each([undefined, null])('headers of %s are none, as 291 reads them', (headers) => {
    expect(write(post({ headers: headers as any }))).toEqual(allowed());
    expect(dry(post({ headers: headers as any }))).toEqual(needsCapability());
    const req = get('/purchase/5?minorversion=75', { headers: headers as any });
    expect(write(req)).toEqual(fetched(req.url as string));
    expect(dry(req)).toEqual(asDry(fetched(req.url as string)));
  });

  it('null params are no params; other headers are fine', () => {
    expect(write(post({ params: null, headers: { 'Content-Type': 'application/json', Authorization: 'x' } }))).toEqual(allowed());
    expect(write(post({ headers: Object.assign(Object.create(null), { Accept: 'application/json' }) }))).toEqual(allowed());
  });

  it('the realm is asked about once, as written; a realm of 1 and of 20 digits can be', () => {
    for (const realm of ['7', '1'.repeat(20)]) {
      const asked: string[] = [];
      const ctx = context({ allowedRealm: (r) => asked.push(r) === 1 });
      const url = `https://${HOST}/v3/company/${realm}/purchase?${QUERY}`;
      expect(write(post({ url }), holding(), ctx)).toEqual(allowed(url));
      expect(asked).toEqual([realm]);
    }
  });
});

// Contract 1.1 §16 Write guard examples, every row as written there.
const EXAMPLES = [
  '| `POST` | `<U>/purchase?operation=update&minorversion=75` | `B` | `B` | `allow` | the checked update |',
  '| `POST` | `<U>/purchase?minorversion=75&operation=update` | `B` | `B` | `allow` | the other key order |',
  '| `POST` | `<U>/purchase?operation=update&minorversion=75` | `B` | `B, used` | `refuse` | a replay |',
  '| `POST` | `<U>/purchase?operation=update&minorversion=75` | `B with one byte changed` | `B` | `refuse` | a body changed after the check |',
  '| `POST` | `<U>/bill?operation=update&minorversion=75` | `B` | `B` | `refuse` | the other entity\'s path |',
  '| `POST` | `<U>/purchase?operation=delete&minorversion=75` | `B` | `B` | `refuse` | another operation |',
  '| `POST` | `<U>/purchase?minorversion=75` | `B` | `B` | `refuse` | no operation |',
  '| `POST` | `<U>/purchase?operation=update&minorversion=75&format=json` | `B` | `B` | `refuse` | another key |',
  '| `POST` | `<U>/purchase?operation=update&minorversion=74` | `B` | `B` | `refuse` | another minor version |',
  '| `POST` | `<U>/purchase/1001?operation=update&minorversion=75` | `B` | `B` | `refuse` | a further segment |',
  '| `POST` | `https://quickbooks.api.intuit.com/v3/company/9990000000000001/purchase?operation=update&minorversion=75` | `B` | `B` | `refuse` | another realm |',
  '| `POST` | `<U>/purchase?operation=update&minorversion=75` | `B without sparse` | `that body` | `refuse` | no `sparse` |',
  '| `POST` | `<U>/purchase?operation=update&minorversion=75` | `B with sparse false` | `that body` | `refuse` | `sparse: false` |',
  '| `POST` | `<U>/purchase?operation=update&minorversion=75` | `B without Id` | `that body` | `refuse` | no `Id` |',
  '| `POST` | `<U>/purchase?operation=update&minorversion=75` | `B without SyncToken` | `that body` | `refuse` | no `SyncToken` |',
  '| `POST` | `<U>/purchase?operation=update&minorversion=75` | `B` | `B for index-space` | `refuse` | another company\'s capability |',
  '| `POST` | `<U>/purchase?operation=update&minorversion=75` | `B` | `B, 59999 ms old` | `allow` | a capability just inside its life |',
  '| `POST` | `<U>/purchase?operation=update&minorversion=75` | `B` | `B, 60000 ms old` | `refuse` | an expired capability |',
  '| `POST` | `<U>/purchase?minorversion=75` | `B without Id and SyncToken` | `that body` | `refuse` | a create |',
  '| `POST` | `<U>/batch?minorversion=75` | `B` | `that body` | `refuse` | a batch |',
  '| `PUT` | `<U>/purchase?operation=update&minorversion=75` | `B` | `B` | `refuse` | another method |',
  '| `GET` | `<U>/purchase/1001?minorversion=75` | — | `none` | `allow` | the transaction\'s fetch |',
  '| `GET` | `<U>/bill/2001?minorversion=75` | — | `none` | `allow` | a Bill\'s fetch |',
  '| `GET` | `<U>/account/84?minorversion=75` | — | `none` | `allow` | an account\'s fetch |',
  '| `GET` | `<U>/class/12?minorversion=75` | — | `none` | `allow` | a class\'s fetch |',
  '| `GET` | `<U>/vendor/5?minorversion=75` | — | `none` | `refuse` | another entity |',
  '| `GET` | `<U>/account/84?minorversion=74` | — | `none` | `refuse` | another minor version |',
  '| `GET` | `<U>/account/84?minorversion=75&format=json` | — | `none` | `refuse` | another key on a by-id fetch |',
  '| `GET` | `<U>/account/8a?minorversion=75` | — | `none` | `refuse` | a non-digit id |',
  '| `GET` | `<U>/reports/ProfitAndLoss?minorversion=75&format=json` | — | `none` | `refuse` | a report in write mode |',
  '| `GET` | `<U>/query?query=select%20*%20from%20Purchase%20orderby%20TxnDate%20desc%20maxresults%2020&minorversion=75&format=json` | — | `none` | `allow` | the write check\'s Purchase query |',
  '| `GET` | `<U>/query?query=select%20*%20from%20Bill%20orderby%20TxnDate%20desc%20maxresults%2020&minorversion=75&format=json` | — | `none` | `allow` | the write check\'s Bill query |',
  '| `GET` | `<U>/companyinfo/9990000000000002?minorversion=75&format=json` | — | `none` | `allow` | the kept `companyinfo` form |',
  '| `GET` | `<U>/preferences?minorversion=75&format=json` | — | `none` | `allow` | the kept `preferences` form |',
  '| `GET` | `https://stacks.example.test/api/qbo/access_token?enterprise=garden3d` | — | `none` | `allow` | the kept Stacks form |',
].map((line) => {
  const [method, url, body, cap, decision, name] = line.slice(2, -2).split(' | ').map((cell) => cell.replace(/^`(.*)`$/, '$1'));
  return { method, url: url.replace('<U>', ROOT), body, cap, decision, name };
});
const BODIES: Record<string, string | undefined> = {
  B,
  'B with one byte changed': B.replace('"Amount":100', '"Amount":101'),
  'B without sparse': without('sparse'),
  'B with sparse false': withField('sparse', false),
  'B without Id': without('Id'),
  'B without SyncToken': without('SyncToken'),
  'B without Id and SyncToken': without('Id', 'SyncToken'),
  '—': undefined,
};
/** Decided by the real registry's clock (T5). */
const BY_AGE = /^B, (59999|60000) ms old$/;
const registryFor = (cap: string, body: string): StubRegistry => {
  if (cap === 'that body') return holding(body);
  if (cap === 'B for index-space') return holding(B, 'purchase', 'index-space');
  if (cap === 'none') return new StubRegistry();
  const registry = holding();
  if (cap === 'B, used') write(post(), registry);
  return registry;
};

describe('contract §16 Write guard examples', () => {
  it('35 rows; every body is known and changed; the two by age are the real registry\'s (T5)', () => {
    expect(EXAMPLES).toHaveLength(35);
    expect(EXAMPLES.filter((row) => !(row.body in BODIES))).toEqual([]);
    expect(new Set(Object.values(BODIES)).size).toBe(Object.keys(BODIES).length);
    expect(BODIES['B with one byte changed']).toHaveLength(B.length);
    expect(EXAMPLES.filter((row) => BY_AGE.test(row.cap)).map((row) => row.name)).toEqual(['a capability just inside its life', 'an expired capability']);
  });

  it.each(EXAMPLES.filter((row) => !BY_AGE.test(row.cap)))('$method $url: $name ($decision)', (row) => {
    const data = BODIES[row.body];
    const registry = registryFor(row.cap, data as string);
    const before = registry.size;
    const answer = decided({ method: row.method, url: row.url, headers: {}, data }, registry);
    expect(answer.allow).toBe(row.decision === 'allow');
    if (row.decision === 'refuse') expect(registry.size).toBe(before);
  });
});

// A3.2, each with the capability that only the named condition keeps from use.
const A32: Array<[string, GuardRequest, string, StubRegistry?]> = [
  ['(b) another operation', post({ url: `${ROOT}/purchase?operation=delete&minorversion=75` }), 'write-update'],
  ['(c) no sparse', post({ data: without('sparse') }), 'write-update', holding(without('sparse'))],
  ['(d) sparse false', post({ data: withField('sparse', false) }), 'write-update', holding(withField('sparse', false))],
  ['(d) sparse a truthy string', post({ data: withField('sparse', 'true') }), 'write-update', holding(withField('sparse', 'true'))],
  ['(d) sparse 1', post({ data: withField('sparse', 1) }), 'write-update', holding(withField('sparse', 1))],
  ['(e) another realm', post({ url: UPDATE.replace(REALM, '9990000000000001') }), 'write-update'],
  ['(f) format=json after', post({ url: `${UPDATE}&format=json` }), 'write-update'],
  ['(f) format=json before', post({ url: `${ROOT}/purchase?format=json&${QUERY}` }), 'write-update'],
  ['(f) requestid', post({ url: `${UPDATE}&requestid=1` }), 'write-update'],
  ['(f) include', post({ url: `${UPDATE}&include=void` }), 'write-update'],
  ['(f) an empty pair', post({ url: `${UPDATE}&` }), 'write-update'],
  ['(g) minorversion alone', post({ url: `${ROOT}/purchase?minorversion=75` }), 'write-update'],
  ['(g) operation alone', post({ url: `${ROOT}/purchase?operation=update` }), 'write-update'],
  ['(g) no query', post({ url: `${ROOT}/purchase` }), 'write-update'],
  ['(h) an id segment', post({ url: `${ROOT}/purchase/123?${QUERY}` }), 'write-update'],
  ['(i) PUT', post({ method: 'PUT' }), 'quickbooks'],
  ['(i) PATCH', post({ method: 'PATCH' }), 'quickbooks'],
  ['(i) DELETE', post({ method: 'DELETE' }), 'quickbooks'],
  ['(i) GET', post({ method: 'GET' }), 'quickbooks'],
  ['(i) a word holding POST', post({ method: 'POSTS' }), 'quickbooks'],
  ['(i) POST after a letter', post({ method: 'XPOST' }), 'quickbooks'],
  ['(j) no Id', post({ data: without('Id') }), 'write-update', holding(without('Id'))],
  ['(j) a number Id', post({ data: withField('Id', 1001) }), 'write-update', holding(withField('Id', 1001))],
  ['(j) no SyncToken', post({ data: without('SyncToken') }), 'write-update', holding(without('SyncToken'))],
  ['(j) a number SyncToken', post({ data: withField('SyncToken', 3) }), 'write-update', holding(withField('SyncToken', 3))],
  ['(k) update then delete', post({ url: `${ROOT}/purchase?operation=update&operation=delete&minorversion=75` }), 'write-update'],
  ['(k) delete then update', post({ url: `${ROOT}/purchase?operation=delete&operation=update&minorversion=75` }), 'write-update'],
  ['(l) two minorversions', post({ url: `${UPDATE}&minorversion=74` }), 'write-update'],
  ['(m) operation in params', post({ params: { operation: 'delete' } }), 'quickbooks'],
  ['(m) empty params', post({ params: {} }), 'quickbooks'],
  ['(m) the query split between URL and params', post({ url: `${ROOT}/purchase?operation=update`, params: { minorversion: '75' } }), 'quickbooks'],
  ['(m) params of another type', post({ params: '' }), 'guard-error'],
  ['(n) a re-cased key', post({ url: `${ROOT}/purchase?Operation=update&minorversion=75` }), 'write-update'],
  ['(n) a re-cased value', post({ url: `${ROOT}/purchase?operation=Update&minorversion=75` }), 'write-update'],
  ['(o) an encoded value', post({ url: `${ROOT}/purchase?operation=%75pdate&minorversion=75` }), 'write-update'],
  ['(o) an encoded key', post({ url: `${ROOT}/purchase?%6fperation=update&minorversion=75` }), 'write-update'],
  ['(p) a trailing slash', post({ url: `${ROOT}/purchase/?${QUERY}` }), 'write-update'],
  ['(p) a capital', post({ url: `${ROOT}/Purchase?${QUERY}` }), 'write-update'],
  ['(p) an encoded letter', post({ url: `${ROOT}/%70urchase?${QUERY}` }), 'write-update'],
  ['(p) another entity', post({ url: `${ROOT}/invoice?${QUERY}` }), 'write-update', holding(B, 'invoice')],
  ['(p) account, which is only fetched', post({ url: `${ROOT}/account?${QUERY}` }), 'write-update', holding(B, 'account')],
  ['(p) class, which is only fetched', post({ url: `${ROOT}/class?${QUERY}` }), 'write-update', holding(B, 'class')],
  ['(p) a longer entity', post({ url: `${ROOT}/purchaseorder?${QUERY}` }), 'write-update', holding(B, 'purchaseorder')],
  ['(p) billpayment', post({ url: `${ROOT}/billpayment?${QUERY}` }), 'write-update', holding(B, 'billpayment')],
  ['(p) a letter before the entity', post({ url: `${ROOT}/xbill?${QUERY}` }), 'write-update', holding(B, 'xbill')],
  ['(p) another API version', post({ url: UPDATE.replace('/v3/', '/v4/') }), 'write-update'],
  ['(p) a capital in the path', post({ url: UPDATE.replace('/company/', '/Company/') }), 'write-update'],
  ['(q) minorversion 76', post({ url: `${ROOT}/purchase?operation=update&minorversion=76` }), 'write-update'],
  ['(q) minorversion 750', post({ url: `${ROOT}/purchase?operation=update&minorversion=750` }), 'write-update'],
  ['(r) the sandbox host', post({ url: UPDATE.replace(HOST, `sandbox-${HOST}`) }), 'write-update'],
  ['(s) another host', post({ url: UPDATE.replace(HOST, 'evil.example.test') }), 'write-update'],
  ['(s) the host as a prefix', post({ url: UPDATE.replace(HOST, `${HOST}.evil.example.test`) }), 'write-update'],
  ['(s) the URL inside another', post({ url: `https://evil.example.test/?u=${UPDATE}` }), 'write-update'],
  ['(s) another character for the first dot', post({ url: UPDATE.replace('quickbooks.', 'quickbooksx') }), 'write-update'],
  ['(s) another character for the second dot', post({ url: UPDATE.replace('api.', 'apix') }), 'write-update'],
  ['(s) another character for the third dot', post({ url: UPDATE.replace('intuit.', 'intuitx') }), 'write-update'],
  ['(s) the Stacks host', post({ url: 'https://stacks.example.test/api/qbo/access_token?enterprise=garden3d' }), 'write-update'],
  ['(s) a re-cased host', post({ url: UPDATE.replace('quickbooks', 'QuickBooks') }), 'write-update'],
  ['(t) http', post({ url: UPDATE.replace('https:', 'http:') }), 'write-update'],
  ['(t) a re-cased scheme', post({ url: UPDATE.replace('https:', 'HTTPS:') }), 'write-update'],
  ['(u) :443', post({ url: UPDATE.replace(HOST, `${HOST}:443`) }), 'write-update'],
  ['(u) :8443', post({ url: UPDATE.replace(HOST, `${HOST}:8443`) }), 'write-update'],
  ['(u) an empty port', post({ url: UPDATE.replace(HOST, `${HOST}:`) }), 'write-update'],
  ['(v) userinfo', post({ url: UPDATE.replace(HOST, `u:p@${HOST}`) }), 'write-update'],
  ['(w) X-Api-Key', post({ headers: { 'X-Api-Key': 'k' } }), 'credential-crossing'],
  ['(w) x-api-key', post({ headers: { 'x-api-key': 'k' } }), 'credential-crossing'],
  ['(w) X-API-KEY after another, with no value', post({ headers: { Accept: 'a', 'X-API-KEY': undefined } }), 'credential-crossing'],
  ['(w) X-Api-Key with a space axios trims', post({ headers: { ' X-Api-Key ': 'k' } }), 'credential-crossing'],
  ['(w) X-Api-Key not enumerable', post({ headers: Object.defineProperty({}, 'X-Api-Key', { value: 'k' }) }), 'credential-crossing'],
  // SB3: what new URL would have dropped or resolved.
  ['SB3 a .. segment', post({ url: `${ROOT}/x/../purchase?${QUERY}` }), 'write-update'],
  ['SB3 a . segment', post({ url: `${ROOT}/./purchase?${QUERY}` }), 'write-update'],
  ['SB3 %2e%2e', post({ url: `${ROOT}/x/%2e%2e/purchase?${QUERY}` }), 'write-update'],
  ['SB3 a doubled slash', post({ url: `${ROOT}//purchase?${QUERY}` }), 'write-update'],
  ['SB3 a backslash', post({ url: `${ROOT}\\purchase?${QUERY}` }), 'write-update'],
  ['SB3 a tab inside', post({ url: `${ROOT}/pur\tchase?${QUERY}` }), 'write-update'],
  ['SB3 a newline inside', post({ url: `${ROOT}/pur\nchase?${QUERY}` }), 'write-update'],
  ['SB3 a trailing newline', post({ url: `${UPDATE}\n` }), 'write-update'],
  ['SB3 a newline and another line', post({ url: `${UPDATE}\nx` }), 'write-update'],
  ['SB3 a line before', post({ url: `x\n${UPDATE}` }), 'write-update'],
  ['SB3 a leading space', post({ url: ` ${UPDATE}` }), 'write-update'],
  ['SB3 a trailing space', post({ url: `${UPDATE} ` }), 'write-update'],
  ['SB3 a space inside', post({ url: `${ROOT}/purchase ?${QUERY}` }), 'write-update'],
  ['SB3 a fragment', post({ url: `${UPDATE}#x` }), 'write-update'],
  ['SB3 an empty fragment', post({ url: `${UPDATE}#` }), 'write-update'],
  ['SB3 a realm with a letter', post({ url: UPDATE.replace(REALM, '99a') }), 'write-update'],
  ['SB3 no realm', post({ url: UPDATE.replace(REALM, '') }), 'write-update'],
  ['a batch', post({ url: `${ROOT}/batch?${QUERY}` }), 'write-update', holding(B, 'batch')],
  // The body: a string that parses to a JSON object.
  ['the body as an object', post({ data: SPARSE }), 'write-update'],
  ['no body', post({ data: undefined }), 'write-update'],
  ['the body as bytes', post({ data: Buffer.from(B) }), 'write-update'],
  ['a body of null', post({ data: 'null' }), 'write-update', holding('null')],
  ['a body of a string', post({ data: '"x"' }), 'write-update', holding('"x"')],
  ['a body of an array', post({ data: `[${B}]` }), 'write-update', holding(`[${B}]`)],
  ['an empty body', post({ data: '' }), 'guard-error', holding('')],
  ['a body that is not JSON', post({ data: `${B}x` }), 'guard-error', holding(`${B}x`)],
  // Headers: a plain object and nothing else.
  ['headers as a Map', post({ headers: new Map([['X-Api-Key', 'k']]) as any }), 'guard-error'],
  ['headers as an array', post({ headers: [] as any }), 'guard-error'],
  ['headers of 0', post({ headers: 0 as any }), 'guard-error'],
  ['headers of false', post({ headers: false as any }), 'guard-error'],
  ['headers of a string', post({ headers: '' as any }), 'guard-error'],
  ['headers of a function with no prototype', post({ headers: Object.setPrototypeOf(() => undefined, null) }), 'guard-error'],
  ['headers with another prototype', post({ headers: Object.create({ 'X-Api-Key': 'k' }) }), 'guard-error'],
  // The URL: a string.
  ['a URL object', post({ url: new URL(UPDATE) as any }), 'guard-error'],
  ['a String URL', post({ url: new String(UPDATE) as any }), 'guard-error'],
  ['no URL', post({ url: undefined }), 'guard-error'],
];

describe('A3.2: refused, with the capability unconsumed; the dry decision agrees', () => {
  it('(a) the same body to bill: the one case where the dry decision differs, since only the capability fails', () => {
    const registry = holding();
    expect(write(post({ url: `${ROOT}/bill?${QUERY}` }), registry)).toEqual(REFUSED);
    expect(registry.size).toBe(1);
    expect(write(post(), registry)).toEqual(allowed());
    // Contract §16's `dry` row: `allowed-with-capability` when everything but the capability holds. To bill, all of it does: it is the
    // capability that is for purchase, and the dry decision has no registry to see that in. Every other A3.2 case agrees.
    expect(dry(post({ url: `${ROOT}/bill?${QUERY}` }))).toEqual(needsCapability(`${ROOT}/bill?${QUERY}`));
  });

  it.each(A32.map(([name, req, rule, registry]) => ({ name, req, rule, registry })))('$name', ({ req, rule, registry }) => refusedUnconsumed(req, rule, registry));

  it('a realm that is no 1 to 20 digits, even where every realm is allowed', () => {
    for (const realm of ['', '99a', 'a99', '1'.repeat(21), '%39']) refusedUnconsumed(post({ url: UPDATE.replace(REALM, realm) }), 'write-update', holding(), context({ allowedRealm: () => true }));
  });

  it('a POST with params is not matched here, so 291 refuses it', () => {
    for (const params of [{ operation: 'delete' }, {}, { operation: 'update', minorversion: '75' }, '']) {
      expect(write(post({ params }))).toEqual(UNMATCHED);
      expect(write(post({ url: `${ROOT}/purchase`, params }))).toEqual(UNMATCHED);
      expect(decided(post({ params })).allow).toBe(false);
    }
  });

  it('another method is not matched here; nor is a method that is no string', () => {
    for (const method of ['PUT', 'POSTS', undefined, ['POST'] as any, new String('POST') as any]) {
      expect(write(post({ method }))).toEqual(UNMATCHED);
      expect(decided(post({ method })).allow).toBe(false);
    }
  });

  it('every POST without params is matched here, whatever its URL', () => {
    for (const url of ['https://evil.example.test/', 'data:,x', '', '/relative']) expect(write(post({ url }))).toEqual(REFUSED);
  });

  it('a parsed body carrying the fields that is no object is refused', () => {
    // JSON has no array or function with these fields, so only a replaced parse shows each is decided by its type.
    const parse = JSON.parse;
    try {
      JSON.parse = () => Object.assign([], SPARSE);
      refusedOnce();
      JSON.parse = () => Object.assign(() => undefined, SPARSE);
      refusedOnce();
    } finally {
      JSON.parse = parse;
    }
    expect(write(post())).toEqual(allowed());
    function refusedOnce() {
      const registry = holding();
      expect(write(post(), registry)).toEqual(REFUSED);
      expect(registry.takes).toEqual([]);
    }
  });

  it('each request field is read once: a changing one is judged as first read', () => {
    const reads: string[] = [];
    const values: Record<string, unknown[]> = { method: ['POST', 'PUT'], url: [UPDATE, 'x'], params: [undefined, {}], headers: [{}, { 'X-Api-Key': 'k' }], data: [B, 'x'] };
    const req = Object.defineProperties({}, Object.fromEntries(Object.entries(values).map(([key, [first, later]]) => [key, { enumerable: true, get: () => (reads.includes(key) ? later : (reads.push(key), first)) }])));
    expect(write(req)).toEqual(allowed());
    expect(reads.sort()).toEqual(['data', 'headers', 'method', 'params', 'url']);
    reads.length = 0;
    expect(dry(req)).toEqual(needsCapability());
  });
});

describe('A3.3: no matching capability', () => {
  it('(a) a replay', () => {
    const registry = holding();
    expect(write(post(), registry)).toEqual(allowed());
    expect(write(post(), registry)).toEqual(REFUSED);
  });

  it('(b) one byte changed', () => {
    const registry = holding();
    expect(write(post({ data: BODIES['B with one byte changed'] }), registry)).toEqual(REFUSED);
    expect(write(post({ data: `${B} ` }), registry)).toEqual(REFUSED);
    expect(write(post(), registry)).toEqual(allowed());
  });

  it('(c) another company\'s capability', () => {
    const registry = holding(B, 'purchase', 'index-space');
    expect(write(post(), registry)).toEqual(REFUSED);
    expect(registry.size).toBe(1);
    expect(write(post(), registry, context(), () => 'index-space')).toEqual(allowed());
  });

  it('(e) a create', () => {
    const body = without('Id', 'SyncToken');
    refusedUnconsumed(post({ url: `${ROOT}/purchase?minorversion=75`, data: body }), 'write-update', holding(body));
    refusedUnconsumed(post({ data: body }), 'write-update', holding(body));
  });

  it('(f) /batch', () => refusedUnconsumed(post({ url: `${ROOT}/batch?${QUERY}` }), 'write-update'));

  it('(g) outside a call', () => refusedUnconsumed(post(), 'write-update', holding(), context({ callRecord: () => undefined })));

  it('a call record that is none', () => {
    for (const record of [null, 0, {}, { queries: 'x' }]) refusedUnconsumed(post(), 'write-update', holding(), context({ callRecord: () => record as any }));
  });

  it('no company', () => {
    for (const who of [undefined, null, '', 7]) refusedUnconsumed(post(), 'write-update', holding(B, 'purchase', String(who)), context(), () => who as any);
  });

  it('a truthy realm answer that is not true', () => {
    for (const answer of [1, 'yes', {}, Promise.resolve(true)]) refusedUnconsumed(post(), 'write-update', holding(), context({ allowedRealm: () => answer as any }));
  });
});

describe('P10: only take answering true allows', () => {
  const registry = (over: Partial<CapabilityRegistry>): CapabilityRegistry => ({ has: () => true, take: () => true, ...over });

  it('has yes, take no: refused; has no, take yes: allowed', () => {
    expect(write(post(), registry({ take: () => false }))).toEqual(REFUSED);
    expect(write(post(), registry({ has: () => false }))).toEqual(allowed());
    expect(write(post(), registry({ has: boom }))).toEqual(allowed());
  });

  it('take answers a truthy value that is not true', () => {
    for (const answer of [1, 'true', {}, Promise.resolve(true)]) expect(write(post(), registry({ take: () => answer as any }))).toEqual(REFUSED);
  });

  it('take throws', () => {
    expect(write(post(), registry({ take: boom }))).toEqual(refused('guard-error'));
  });

  it('company, allowedRealm or callRecord throws: refused, take not reached', () => {
    refusedUnconsumed(post(), 'guard-error', holding(), context(), boom);
    refusedUnconsumed(post(), 'guard-error', holding(), context({ allowedRealm: boom }));
    refusedUnconsumed(post(), 'guard-error', holding(), context({ callRecord: boom }));
  });

  it('a request that throws when read', () => {
    for (const key of ['method', 'url', 'params', 'headers', 'data']) {
      const req = Object.defineProperty(post(), key, { get: boom });
      const stub = holding();
      expect(write(req, stub)).toEqual(refused('guard-error'));
      expect(stub.takes).toEqual([]);
      expect(dry(req)).toEqual(asDry(refused('guard-error')));
    }
    expect(write(undefined as any)).toEqual(refused('guard-error'));
    expect(dry(undefined as any)).toEqual(asDry(refused('guard-error')));
    refusedUnconsumed(post({ headers: new Proxy({}, { ownKeys: boom }) }), 'guard-error');
  });

  it('by-id: allowedRealm or callRecord throws', () => {
    const req = get('/purchase/5?minorversion=75');
    refusedUnconsumed(req, 'guard-error', holding(), context({ allowedRealm: boom }));
    refusedUnconsumed(req, 'guard-error', holding(), context({ callRecord: boom }));
  });
});

describe('A3.9: the by-id fetch', () => {
  const UNTAKEN = () => new StubRegistry();

  it.each(['purchase', 'bill', 'account', 'class'])('%s is fetched, with or without a company', (entity) => {
    for (const id of ['5', '12345678901234567890']) {
      const req = get(`/${entity}/${id}?minorversion=75`);
      const registry = UNTAKEN();
      expect(write(req, registry)).toEqual(fetched(req.url as string));
      expect(write(req, registry, context(), () => undefined)).toEqual(fetched(req.url as string));
      expect(registry.takes).toEqual([]);
      expect(dry(req)).toEqual(asDry(fetched(req.url as string)));
      expect(decide(req, context())).toEqual(refused('entity-by-id'));
    }
  });

  it('get in any case; null params; an absent body in each form', () => {
    const req = get('/purchase/5?minorversion=75');
    for (const over of [{ method: 'get' }, { method: 'Get' }, { params: null }, { data: null }, { data: '' }]) expect(write({ ...req, ...over })).toEqual(fetched(req.url as string));
  });

  // Not this rule's form: 291 answers.
  it.each([
    ['vendor', '/vendor/5?minorversion=75'],
    ['invoice', '/invoice/5?minorversion=75'],
    ['a longer entity', '/purchaseorder/5?minorversion=75'],
    ['a letter before', '/xclass/5?minorversion=75'],
    ['a word id', '/purchase/abc?minorversion=75'],
    ['an id with a letter', '/purchase/5a?minorversion=75'],
    ['no id', '/purchase/?minorversion=75'],
    ['a further segment', '/purchase/5/x?minorversion=75'],
    ['a trailing slash', '/purchase/5/?minorversion=75'],
    ['a capital', '/Purchase/5?minorversion=75'],
    ['an encoded letter', '/%70urchase/5?minorversion=75'],
    ['an encoded digit', '/purchase/%35?minorversion=75'],
    ['operation=delete', '/purchase/5?minorversion=75&operation=delete'],
    ['operation=delete first', '/purchase/5?operation=delete&minorversion=75'],
    ['format=json', '/purchase/5?minorversion=75&format=json'],
    ['minorversion 74', '/purchase/5?minorversion=74'],
    ['minorversion 750', '/purchase/5?minorversion=750'],
    ['a re-cased key', '/purchase/5?minorVersion=75'],
    ['no query', '/purchase/5'],
    ['a 21-digit id', '/purchase/123456789012345678901?minorversion=75'],
    ['a dot segment', '/x/../purchase/5?minorversion=75'],
    ['%2e%2e', '/x/%2e%2e/purchase/5?minorversion=75'],
    ['a backslash', '\\purchase/5?minorversion=75'],
    ['a tab', '/pur\tchase/5?minorversion=75'],
    ['a trailing newline', '/purchase/5?minorversion=75\n'],
    ['a trailing newline and a line', '/purchase/5?minorversion=75\nx'],
    ['a trailing space', '/purchase/5?minorversion=75 '],
    ['a fragment', '/purchase/5?minorversion=75#x'],
  ])('%s is refused', (_name, path) => {
    expect(write(get(path))).toEqual(UNMATCHED);
    expect(decided(get(path)).allow).toBe(false);
    expect(dry(get(path))).toEqual(asDry(decide(get(path), context())));
  });

  it.each([
    ['the sandbox host', HOST, `sandbox-${HOST}`],
    ['another host', HOST, 'evil.example.test'],
    ['the first dot', 'quickbooks.', 'quickbooksx'],
    ['the second dot', 'api.', 'apix'],
    ['the third dot', 'intuit.', 'intuitx'],
    ['http', 'https:', 'http:'],
    [':443', HOST, `${HOST}:443`],
    [':8443', HOST, `${HOST}:8443`],
    ['userinfo', HOST, `u:p@${HOST}`],
    ['a realm with a letter', REALM, '99a'],
    ['no realm', REALM, ''],
    ['a 21-digit realm', REALM, '1'.repeat(21)],
    ['a line before', 'https:', 'x\nhttps:'],
  ])('%s is refused', (_name, from, to) => {
    const url = `${ROOT}/purchase/5?minorversion=75`.replace(from, to);
    expect(url).not.toBe(`${ROOT}/purchase/5?minorversion=75`);
    const req = get('', { url });
    const everyRealm = context({ allowedRealm: () => true });
    expect(write(req, UNTAKEN(), everyRealm)).toEqual(UNMATCHED);
    expect(decided(req, UNTAKEN(), everyRealm).allow).toBe(false);
  });

  it.each<[string, Partial<GuardRequest>]>([
    ['a method holding GET', { method: 'GETS' }],
    ['a method ending GET', { method: 'XGET' }],
    ['HEAD', { method: 'HEAD' }],
    ['a method that is no string', { method: ['GET'] as any }],
    ['a String URL', { url: new String(`${ROOT}/purchase/5?minorversion=75`) as any }],
    ['params', { params: { operation: 'delete' } }],
    ['empty params', { params: {} }],
    ['the query in params', { url: `${ROOT}/purchase/5`, params: { minorversion: '75' } }],
  ])('%s is refused', (_name, over) => {
    const req = get('/purchase/5?minorversion=75', over);
    expect(write(req)).toEqual(UNMATCHED);
    expect(decided(req).allow).toBe(false);
  });

  it.each<[string, Partial<GuardRequest>, string]>([
    ['another realm', { url: `https://${HOST}/v3/company/9990000000000001/purchase/5?minorversion=75` }, 'entity-by-id-write'],
    ['X-Api-Key', { headers: { 'X-Api-Key': 'k' } }, 'credential-crossing'],
    ['x-api-key', { headers: { 'x-api-key': 'k' } }, 'credential-crossing'],
    ['headers as a Map', { headers: new Map() as any }, 'guard-error'],
    ['a body', { data: '{}' }, 'body'],
    ['a body of false', { data: false }, 'body'],
    ['a body of 0', { data: 0 }, 'body'],
  ])('%s is refused', (_name, over, rule) => {
    const req = get('/purchase/5?minorversion=75', over);
    expect(write(req)).toEqual(refused(rule));
    expect(dry(req)).toEqual(asDry(refused(rule)));
  });

  it('outside a call, and a truthy realm answer', () => {
    const req = get('/purchase/5?minorversion=75');
    for (const ctx of [context({ callRecord: () => undefined }), context({ callRecord: () => ({}) as any }), context({ allowedRealm: () => 1 as any })]) refusedUnconsumed(req, 'entity-by-id-write', holding(), ctx);
  });
});

describe('reports, and what 291 keeps', () => {
  it('a report 291 would allow is refused here, its query in the URL or in params', () => {
    for (const req of [get('/reports/ProfitAndLoss?minorversion=75&format=json'), get('/reports/BalanceSheet', { params: { minorversion: '75' } }), get('/reports/CashFlow?minorversion=75', { headers: undefined })]) {
      expect(decide(req, context())).toMatchObject({ allow: true, rule: 'reports' });
      expect(write(req)).toEqual(refused('reports'));
      expect(dry(req)).toEqual(asDry(refused('reports')));
    }
  });

  it('every other request is 291\'s, dry and real alike', () => {
    for (const req of [
      get('/preferences?minorversion=75'),
      get(`/companyinfo/${REALM}?minorversion=75`),
      get('/query?query=select%20*%20from%20Bill%20maxresults%2020&minorversion=75'),
      get('', { url: 'https://stacks.example.test/api/qbo/access_token?enterprise=garden3d' }),
      get('/reports/Nope?minorversion=75'),
      get('/vendor/5?minorversion=75'),
      post({ method: 'DELETE' }),
    ]) {
      expect(write(req)).toEqual(UNMATCHED);
      expect(dry(req)).toEqual(asDry(decide(req, context())));
    }
  });
});

describe('A3.5: the dry decision', () => {
  it('no answer has an `allow` key, so none reads as an allow', () => {
    const answers = [post(), get('/purchase/5?minorversion=75'), get('/preferences?minorversion=75'), get('/vendor/5?minorversion=75'), post({ data: 'x' }), post({ method: 'PUT' })].map((req) => dry(req));
    expect(answers.map((a) => a.answer)).toEqual(['allowed-with-capability', 'allow', 'allow', 'refuse', 'refuse', 'refuse']);
    for (const answer of [...answers, dry(post({ url: undefined })), dry(undefined as any)]) expect(answer).not.toHaveProperty('allow');
  });

  it('the valid update needs a capability; by-id is allowed', () => {
    expect(dry(post())).toEqual(needsCapability());
    expect(dry(post({ url: `${ROOT}/purchase?minorversion=75&operation=update` }))).toEqual(needsCapability(`${ROOT}/purchase?minorversion=75&operation=update`));
  });

  // TC4: a later read would answer otherwise.
  it.each<[string, GuardRequest, GuardRequest]>([
    ['a GET that 291 allows', get('/preferences?minorversion=75'), get('/vendor/5?minorversion=75', { headers: { 'X-Api-Key': 'k' }, data: 'x' })],
    ['a refusal that is 291’s', post({ method: 'PUT' }), get('/preferences?minorversion=75')],
  ])('%s is judged as first read, each field read once', (_name, first, later) => {
    const reads: string[] = [];
    const changing = Object.defineProperties(
      {},
      Object.fromEntries(
        (['method', 'url', 'params', 'headers', 'data'] as const).map((key) => [key, { enumerable: true, get: () => (reads.push(key) && reads.indexOf(key) === reads.lastIndexOf(key) ? first : later)[key] }]),
      ),
    );
    expect(dry(changing)).toEqual(asDry(decide(first, context())));
    expect(reads.sort()).toEqual(['data', 'headers', 'method', 'params', 'url']);
    expect(dry(later)).not.toEqual(dry(first));
  });

  it('consumes nothing in 100 calls, and reads no registry it is handed', () => {
    const registry = holding();
    const deps = { company, get registry(): CapabilityRegistry { return boom(); } };
    for (let i = 0; i < 100; i++) expect(decideDry(post(), context(), deps)).toEqual(needsCapability());
    expect(registry.size).toBe(1);
    expect(write(post(), registry)).toEqual(allowed());
    expect(write(post(), registry)).toEqual(REFUSED);
  });
});

describe('the module', () => {
  const root = fileURLToPath(new URL('../../src', import.meta.url));
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));

  it('imports only the decision and the hash, and reads no environment', () => {
    const text = lf(readFileSync(path.join(root, 'write/guard-rules.ts'), 'utf8'));
    expect([...text.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(['../clients/guard-decide.js', './canonical.js']);
    expect(text).not.toMatch(/process\.|require|import\(|^(export )?(let|var) /m);
  });

  it('nothing under src names the stub registry', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((f) => /stub-registry|StubRegistry/.test(lf(readFileSync(path.join(root, f), 'utf8'))))).toEqual([]);
  });
});
