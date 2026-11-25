// Sanctuary Computer (quickbooks-mcp-293): `guard-probe --mode write` (A3.6): contract 1.1 §16's dry decision on one request, one line, nothing
// sent (docs/contracts/quickbooks.md in Stacksbot). Read mode's own cases are tests/unit/guard/probe.test.ts.
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import ts from 'typescript';
import { assertFreshBuild, ROOT } from '../e2e/helpers.js';
import { runProbe } from '../../src/guard-probe.js';

jest.setTimeout(60000);

const CASE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fakes/transactions/cases/account-and-class.json'), 'utf8'));
const SPARSE = CASE.sparse_body as Record<string, unknown>;
const B = JSON.stringify(SPARSE);
const without = (...keys: string[]) => JSON.stringify(Object.fromEntries(Object.entries(SPARSE).filter(([k]) => !keys.includes(k))));
const withField = (key: string, value: unknown) => JSON.stringify({ ...SPARSE, [key]: value });

const REALM = '9990000000000002';
const HOST = 'quickbooks.api.intuit.com';
const U = `https://${HOST}/v3/company/${REALM}`;
const QUERY = 'operation=update&minorversion=75';
const UPDATE = `${U}/purchase?${QUERY}`;
const STACKS = ['--stacks-url', 'https://stacks.example.test', '--key', 'usb-club', '--key', 'garden3d'];
const READ_USAGE = 'usage: guard-probe <METHOD> <URL> --realm <R> [--stacks-url <u>] [--key <k>]...';
const WRITE_USAGE =
  'usage: guard-probe --mode write <METHOD> <URL> --realm <R> [--body <file>] [--header <k:v>]... [--stacks-url <u>] [--key <k>]...';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-write-probe-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
let files = 0;
/** A file holding exactly this. */
function file(content: string | Buffer): string {
  const name = path.join(dir, `body-${++files}.json`);
  fs.writeFileSync(name, content);
  return name;
}

function probe(argv: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = runProbe(argv, (l) => out.push(l), (l) => err.push(l));
  return { code, out, err };
}
/** Write mode's answer, its exit code the one that goes with it. */
function ask(method: string, url: string, body?: string, extra: string[] = []): string {
  const r = probe(['--mode', 'write', method, url, '--realm', REALM, ...(body === undefined ? [] : ['--body', file(body)]), ...extra]);
  expect(r.err).toEqual([]);
  expect(r.out).toHaveLength(1);
  expect(r.code).toBe(r.out[0].startsWith('refuse ') ? 1 : 0);
  return r.out[0];
}
const usage = (reason: string, text = WRITE_USAGE) => ({ code: 2, out: [], err: [`${text} (${reason})`] });

describe('the built probe as a process (A3.6)', () => {
  beforeAll(() => assertFreshBuild());
  // No key set but PATH (and what Node itself needs on Windows); any socket connect or DNS lookup exits 97.
  const run = (argv: string[]) => {
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(ROOT, 'tests', 'fixtures', 'no-network.mjs')).href, path.join(ROOT, 'dist', 'guard-probe.js'), ...argv], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      timeout: 50000,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const said = (status: number, line: string) => ({ status, stdout: `${line}\n`, stderr: '' });
  const ACCOUNT = `${U}/account/5?minorversion=75`;

  it('the checked update needs a capability: exit 0', () => {
    expect(run(['--mode', 'write', 'POST', UPDATE, '--realm', REALM, '--body', file(B)])).toEqual(said(0, 'allowed-with-capability write-update'));
  });

  it('another operation is refused: exit 1', () => {
    expect(run(['--mode', 'write', 'POST', UPDATE.replace('=update', '=delete'), '--realm', REALM, '--body', file(B)])).toEqual(said(1, 'refuse write-update'));
  });

  it('a by-id fetch is allowed: exit 0', () => {
    expect(run(['--mode', 'write', 'GET', ACCOUNT, '--realm', REALM])).toEqual(said(0, 'allow entity-by-id-write'));
  });

  it('a kept form, from 291’s rules, is allowed', () => {
    expect(run(['--mode', 'write', 'GET', `${U}/preferences?minorversion=75`, '--realm', REALM])).toEqual(said(0, 'allow preferences'));
  });

  it('without --mode write, the same POST and GET are read mode’s: refused', () => {
    expect(run(['POST', UPDATE, '--realm', REALM])).toEqual(said(1, 'refuse quickbooks'));
    expect(run(['GET', ACCOUNT, '--realm', REALM])).toEqual(said(1, 'refuse entity-by-id'));
  });

  it('a usage error: exit 2, the line on stderr', () => {
    expect(run(['--mode', 'read', 'GET', ACCOUNT, '--realm', REALM])).toEqual({ status: 2, stdout: '', stderr: `${WRITE_USAGE} (--mode takes only write)\n` });
  });

  it('a body file that isn’t there: exit 2, one line', () => {
    expect(run(['--mode', 'write', 'POST', UPDATE, '--realm', REALM, '--body', path.join(dir, 'none')])).toEqual({
      status: 2,
      stdout: '',
      stderr: `${WRITE_USAGE} (--body is not a readable UTF-8 file)\n`,
    });
  });
});

// Contract 1.1 §16 Write guard examples: method, URL, body, capability, decision, case; then the probe's line. The probe holds no capability, so
// a row whose other conditions all hold is `allowed-with-capability`, whatever its capability column (§16's `dry` row; task-2 TC3).
const CAP = 'allowed-with-capability write-update';
const EXAMPLES: Array<[string, string, string, string, 'allow' | 'refuse', string, string]> = [
  ['POST', '<U>/purchase?operation=update&minorversion=75', 'B', 'B', 'allow', 'the checked update', CAP],
  ['POST', '<U>/purchase?minorversion=75&operation=update', 'B', 'B', 'allow', 'the other key order', CAP],
  ['POST', '<U>/purchase?operation=update&minorversion=75', 'B', 'B, used', 'refuse', 'a replay', CAP],
  ['POST', '<U>/purchase?operation=update&minorversion=75', 'B with one byte changed', 'B', 'refuse', 'a body changed after the check', CAP],
  ['POST', '<U>/bill?operation=update&minorversion=75', 'B', 'B', 'refuse', "the other entity's path", CAP],
  ['POST', '<U>/purchase?operation=delete&minorversion=75', 'B', 'B', 'refuse', 'another operation', 'refuse write-update'],
  ['POST', '<U>/purchase?minorversion=75', 'B', 'B', 'refuse', 'no operation', 'refuse write-update'],
  ['POST', '<U>/purchase?operation=update&minorversion=75&format=json', 'B', 'B', 'refuse', 'another key', 'refuse write-update'],
  ['POST', '<U>/purchase?operation=update&minorversion=74', 'B', 'B', 'refuse', 'another minor version', 'refuse write-update'],
  ['POST', '<U>/purchase/1001?operation=update&minorversion=75', 'B', 'B', 'refuse', 'a further segment', 'refuse write-update'],
  ['POST', `https://${HOST}/v3/company/9990000000000001/purchase?operation=update&minorversion=75`, 'B', 'B', 'refuse', 'another realm', 'refuse write-update'],
  ['POST', '<U>/purchase?operation=update&minorversion=75', 'B without sparse', 'that body', 'refuse', 'no `sparse`', 'refuse write-update'],
  ['POST', '<U>/purchase?operation=update&minorversion=75', 'B with sparse false', 'that body', 'refuse', '`sparse: false`', 'refuse write-update'],
  ['POST', '<U>/purchase?operation=update&minorversion=75', 'B without Id', 'that body', 'refuse', 'no `Id`', 'refuse write-update'],
  ['POST', '<U>/purchase?operation=update&minorversion=75', 'B without SyncToken', 'that body', 'refuse', 'no `SyncToken`', 'refuse write-update'],
  ['POST', '<U>/purchase?operation=update&minorversion=75', 'B', 'B for index-space', 'refuse', "another company's capability", CAP],
  ['POST', '<U>/purchase?operation=update&minorversion=75', 'B', 'B, 59999 ms old', 'allow', 'a capability just inside its life', CAP],
  ['POST', '<U>/purchase?operation=update&minorversion=75', 'B', 'B, 60000 ms old', 'refuse', 'an expired capability', CAP],
  ['POST', '<U>/purchase?minorversion=75', 'B without Id and SyncToken', 'that body', 'refuse', 'a create', 'refuse write-update'],
  ['POST', '<U>/batch?minorversion=75', 'B', 'that body', 'refuse', 'a batch', 'refuse write-update'],
  ['PUT', '<U>/purchase?operation=update&minorversion=75', 'B', 'B', 'refuse', 'another method', 'refuse quickbooks'],
  ['GET', '<U>/purchase/1001?minorversion=75', '—', 'none', 'allow', "the transaction's fetch", 'allow entity-by-id-write'],
  ['GET', '<U>/bill/2001?minorversion=75', '—', 'none', 'allow', "a Bill's fetch", 'allow entity-by-id-write'],
  ['GET', '<U>/account/84?minorversion=75', '—', 'none', 'allow', "an account's fetch", 'allow entity-by-id-write'],
  ['GET', '<U>/class/12?minorversion=75', '—', 'none', 'allow', "a class's fetch", 'allow entity-by-id-write'],
  ['GET', '<U>/vendor/5?minorversion=75', '—', 'none', 'refuse', 'another entity', 'refuse entity-by-id'],
  ['GET', '<U>/account/84?minorversion=74', '—', 'none', 'refuse', 'another minor version', 'refuse quickbooks'],
  ['GET', '<U>/account/84?minorversion=75&format=json', '—', 'none', 'refuse', 'another key on a by-id fetch', 'refuse entity-by-id'],
  ['GET', '<U>/account/8a?minorversion=75', '—', 'none', 'refuse', 'a non-digit id', 'refuse refused'],
  ['GET', '<U>/reports/ProfitAndLoss?minorversion=75&format=json', '—', 'none', 'refuse', 'a report in write mode', 'refuse reports'],
  ['GET', '<U>/query?query=select%20*%20from%20Purchase%20orderby%20TxnDate%20desc%20maxresults%2020&minorversion=75&format=json', '—', 'none', 'allow', "the write check's Purchase query", 'allow query'],
  ['GET', '<U>/query?query=select%20*%20from%20Bill%20orderby%20TxnDate%20desc%20maxresults%2020&minorversion=75&format=json', '—', 'none', 'allow', "the write check's Bill query", 'allow query'],
  ['GET', '<U>/companyinfo/9990000000000002?minorversion=75&format=json', '—', 'none', 'allow', 'the kept `companyinfo` form', 'allow companyinfo'],
  ['GET', '<U>/preferences?minorversion=75&format=json', '—', 'none', 'allow', 'the kept `preferences` form', 'allow preferences'],
  ['GET', 'https://stacks.example.test/api/qbo/access_token?enterprise=garden3d', '—', 'none', 'allow', 'the kept Stacks form', 'allow stacks'],
];
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

describe('contract §16 Write guard examples, through the probe', () => {
  it('35 rows, every body known; a line differs from the decision only where the capability decides', () => {
    expect(EXAMPLES).toHaveLength(35);
    expect(EXAMPLES.filter(([, , body]) => !(body in BODIES))).toEqual([]);
    expect(EXAMPLES.filter(([, , , , decision, , line]) => line.startsWith('allow') !== (decision === 'allow')).map(([, , , , , name]) => name)).toEqual([
      'a replay',
      'a body changed after the check',
      "the other entity's path",
      "another company's capability",
      'an expired capability',
    ]);
  });

  it.each(EXAMPLES)('%s %s, %s, capability %s (%s, %s): %s', (method, url, body, _cap, _decision, _name, line) => {
    expect(ask(method, url.replace('<U>', U), BODIES[body], STACKS)).toBe(line);
  });
});

// A3.2, each case that a method, a URL, a body's text and headers can say. `write-update` unless another rule is named.
const A32: Array<[string, { method?: string; url?: string; body?: string | null; headers?: string[] }, string?]> = [
  ['(b) another operation', { url: `${U}/purchase?operation=delete&minorversion=75` }],
  ['(c) no sparse', { body: without('sparse') }],
  ['(d) sparse false', { body: withField('sparse', false) }],
  ['(d) sparse a truthy string', { body: withField('sparse', 'true') }],
  ['(d) sparse 1', { body: withField('sparse', 1) }],
  ['(e) another realm', { url: UPDATE.replace(REALM, '9990000000000001') }],
  ['(e) a realm that extends --realm', { url: UPDATE.replace(REALM, `${REALM}1`) }],
  ['(f) format=json after', { url: `${UPDATE}&format=json` }],
  ['(f) format=json before', { url: `${U}/purchase?format=json&${QUERY}` }],
  ['(f) requestid', { url: `${UPDATE}&requestid=1` }],
  ['(f) include', { url: `${UPDATE}&include=void` }],
  ['(f) an empty pair', { url: `${UPDATE}&` }],
  ['(g) minorversion alone', { url: `${U}/purchase?minorversion=75` }],
  ['(g) operation alone', { url: `${U}/purchase?operation=update` }],
  ['(g) no query', { url: `${U}/purchase` }],
  ['(h) an id segment', { url: `${U}/purchase/123?${QUERY}` }],
  ['(i) PUT', { method: 'PUT' }, 'quickbooks'],
  ['(i) PATCH', { method: 'PATCH' }, 'quickbooks'],
  ['(i) DELETE', { method: 'DELETE' }, 'quickbooks'],
  ['(i) GET', { method: 'GET' }, 'quickbooks'],
  ['(i) a word holding POST', { method: 'POSTS' }, 'quickbooks'],
  ['(j) no Id', { body: without('Id') }],
  ['(j) a number Id', { body: withField('Id', 1001) }],
  ['(j) no SyncToken', { body: without('SyncToken') }],
  ['(j) a number SyncToken', { body: withField('SyncToken', 3) }],
  ['(k) update then delete', { url: `${U}/purchase?operation=update&operation=delete&minorversion=75` }],
  ['(k) delete then update', { url: `${U}/purchase?operation=delete&operation=update&minorversion=75` }],
  ['(l) two minorversions', { url: `${UPDATE}&minorversion=74` }],
  ['(n) a re-cased key', { url: `${U}/purchase?Operation=update&minorversion=75` }],
  ['(n) a re-cased value', { url: `${U}/purchase?operation=Update&minorversion=75` }],
  ['(o) an encoded value', { url: `${U}/purchase?operation=%75pdate&minorversion=75` }],
  ['(o) an encoded key', { url: `${U}/purchase?%6fperation=update&minorversion=75` }],
  ['(p) a trailing slash', { url: `${U}/purchase/?${QUERY}` }],
  ['(p) a capital', { url: `${U}/Purchase?${QUERY}` }],
  ['(p) an encoded letter', { url: `${U}/%70urchase?${QUERY}` }],
  ['(p) another entity', { url: `${U}/invoice?${QUERY}` }],
  ['(p) account, which is only fetched', { url: `${U}/account?${QUERY}` }],
  ['(q) minorversion 76', { url: `${U}/purchase?operation=update&minorversion=76` }],
  ['(r) the sandbox host', { url: UPDATE.replace(HOST, `sandbox-${HOST}`) }],
  ['(s) another host', { url: UPDATE.replace(HOST, 'evil.example.test') }],
  ['(s) the host as a prefix', { url: UPDATE.replace(HOST, `${HOST}.evil.example.test`) }],
  ['(s) the Stacks host', { url: 'https://stacks.example.test/api/qbo/access_token?enterprise=garden3d' }],
  ['(t) http', { url: UPDATE.replace('https:', 'http:') }],
  ['(u) :443', { url: UPDATE.replace(HOST, `${HOST}:443`) }],
  ['(u) :8443', { url: UPDATE.replace(HOST, `${HOST}:8443`) }],
  ['(v) userinfo', { url: UPDATE.replace(HOST, `u:p@${HOST}`) }],
  ['(w) X-Api-Key', { headers: ['X-Api-Key:k'] }, 'credential-crossing'],
  ['(w) x-api-key, after another', { headers: ['Accept:application/json', 'x-api-key:k'] }, 'credential-crossing'],
  ['(w) X-Api-Key with no value', { headers: ['X-Api-Key:'] }, 'credential-crossing'],
  ['(w) X-Api-Key with a space axios trims', { headers: [' X-Api-Key :k'] }, 'credential-crossing'],
  ['(w) X-Api-Key, its value holding a colon', { headers: ['X-Api-Key:a:b'] }, 'credential-crossing'],
  ['SB3 a .. segment', { url: `${U}/x/../purchase?${QUERY}` }],
  ['SB3 %2e%2e', { url: `${U}/x/%2e%2e/purchase?${QUERY}` }],
  ['SB3 a doubled slash', { url: `${U}//purchase?${QUERY}` }],
  ['SB3 a tab inside', { url: `${U}/pur\tchase?${QUERY}` }],
  ['SB3 a trailing newline', { url: `${UPDATE}\n` }],
  ['SB3 a leading space', { url: ` ${UPDATE}` }],
  ['SB3 a trailing space', { url: `${UPDATE} ` }],
  ['SB3 a fragment', { url: `${UPDATE}#x` }],
  ['SB3 no realm', { url: UPDATE.replace(REALM, '') }],
  ['a batch', { url: `${U}/batch?${QUERY}` }],
  ['no body', { body: null }],
  ['a body of null', { body: 'null' }],
  ['a body of a string', { body: '"x"' }],
  ['a body of an array', { body: `[${B}]` }],
  ['an empty body', { body: '' }, 'guard-error'],
  ['a body that is not JSON', { body: `${B}x` }, 'guard-error'],
];
describe('A3.2 and A3.3 through the probe', () => {
  it.each(A32)('%s is refused', (_name, { method = 'POST', url = UPDATE, body = B, headers = [] }, rule = 'write-update') => {
    expect(ask(method, url, body ?? undefined, headers.flatMap((h) => ['--header', h]))).toBe(`refuse ${rule}`);
  });

  it('(a) the same body to bill: only the capability fails, so as the update itself (TC3)', () => {
    expect(ask('POST', `${U}/bill?${QUERY}`, B)).toBe(CAP);
  });

  it('A3.3 (e) a create', () => expect(ask('POST', UPDATE, without('Id', 'SyncToken'))).toBe('refuse write-update'));

  it('other headers are fine, and a name that only holds the key’s', () => {
    expect(ask('POST', UPDATE, B, ['--header', 'Content-Type:application/json', '--header', 'Accept:X-Api-Key:k', '--header', 'X-Api-Key-Id:k'])).toBe(CAP);
  });
});

describe('the probe’s context', () => {
  it('is one call’s, its first request: each run allows the query and the update again', () => {
    const query = `${U}/query?query=select%20*%20from%20Bill%20maxresults%2020&minorversion=75`;
    for (let i = 0; i < 2; i++) {
      expect(ask('GET', query)).toBe('allow query');
      expect(ask('POST', UPDATE, B)).toBe(CAP);
    }
  });

  it('allows --realm’s own realm and no other', () => {
    expect(ask('GET', `${U}1/purchase/5?minorversion=75`)).toBe('refuse entity-by-id-write');
    expect(probe(['--mode', 'write', 'GET', `${U}/purchase/5?minorversion=75`, '--realm', `${REALM}1`])).toEqual({ code: 1, out: ['refuse entity-by-id-write'], err: [] });
  });

  it('has the Stacks origin and the keys it was given', () => {
    const url = 'https://stacks.example.test/api/qbo/access_token?enterprise=garden3d';
    expect(ask('GET', url, undefined, STACKS)).toBe('allow stacks');
    expect(ask('GET', url, undefined, STACKS.slice(0, 4))).toBe('refuse stacks');
    expect(ask('GET', url, undefined, STACKS.slice(2))).toBe('refuse refused');
    expect(ask('GET', url, undefined, ['--stacks-url', '', '--key', 'garden3d'])).toBe('refuse stacks-config');
  });
});

describe('the body', () => {
  /** The texts the rules parsed. */
  function parsed(content: string | Buffer): { texts: unknown[]; line: string } {
    const argv = ['--mode', 'write', 'POST', UPDATE, '--realm', REALM, '--body', file(content)];
    const spy = jest.spyOn(JSON, 'parse');
    const r = probe(argv);
    const texts = spy.mock.calls.map(([text]) => text);
    spy.mockRestore();
    return { texts, line: r.out[0] };
  }

  it.each([
    ['as built', B],
    ['with a trailing newline', `${B}\n`],
    ['with CR LF around it', `\r\n${B}\r\n`],
    ['not ASCII', JSON.stringify({ ...SPARSE, PrivateNote: 'é – 🙂\u2028' })],
  ])('%s, is judged as the file has it', (_label, text) => {
    expect(parsed(text)).toEqual({ texts: [text], line: CAP });
  });

  it('a byte order mark is kept, so the text isn’t JSON', () => {
    expect(parsed(`\uFEFF${B}`)).toEqual({ texts: [`\uFEFF${B}`], line: 'refuse guard-error' });
  });

  it('a newline alone is a body; an empty file and no --body are none', () => {
    const url = `${U}/purchase/5?minorversion=75`;
    expect(ask('GET', url, '\n')).toBe('refuse body');
    expect(ask('GET', url, '')).toBe('allow entity-by-id-write');
    expect(ask('GET', url)).toBe('allow entity-by-id-write');
  });

  const NOT_READ = usage('--body is not a readable UTF-8 file');
  it.each([
    ['a missing file', () => path.join(dir, 'none')],
    ['a directory', () => dir],
    ['a file that isn’t UTF-8', () => file(Buffer.concat([Buffer.from(withField('PrivateNote', 'cut').replace('cut"', 'secret')), Buffer.from([0xff]), Buffer.from('"}')]))],
    ['a file cut inside a character', () => file(Buffer.from(`${B}é`).subarray(0, -1))],
  ])('%s is a usage error that names nothing of it', (_label, make) => {
    expect(probe(['--mode', 'write', 'POST', UPDATE, '--realm', REALM, '--body', make()])).toEqual(NOT_READ);
  });
});

describe('the flags', () => {
  const REST = ['GET', `${U}/account/5?minorversion=75`, '--realm', REALM];
  const OK = { code: 0, out: ['allow entity-by-id-write'], err: [] };
  const GOOD = file(B);

  it.each(Array.from({ length: REST.length + 1 }, (_, i) => i).filter((i) => i !== 3))('--mode write after %i arguments', (i) => {
    expect(probe([...REST.slice(0, i), '--mode', 'write', ...REST.slice(i)])).toEqual(OK);
  });

  it('--body and --header may come before --mode', () => {
    expect(probe(['--body', GOOD, '--header', 'Accept:x', 'POST', UPDATE, '--realm', REALM, '--mode', 'write'])).toEqual({ code: 0, out: [CAP], err: [] });
  });

  it.each([
    ['--mode without a value', [...REST, '--mode'], '--mode needs a value'],
    ['--mode with an empty value', [...REST, '--mode', ''], '--mode needs a value'],
    ['--mode before a flag', ['--mode', ...REST.slice(2), ...REST.slice(0, 2)], '--mode needs a value'],
    ['--mode read', [...REST, '--mode', 'read'], '--mode takes only write'],
    ['--mode Write', [...REST, '--mode', 'Write'], '--mode takes only write'],
    ['--mode twice', ['--mode', 'write', ...REST, '--mode', 'write'], '--mode given twice'],
    ['--mode with =', ['--mode=write', ...REST], 'unknown flag --mode=write'],
    ['--mode with = and no value', ['--mode=', ...REST], 'unknown flag --mode='],
    ['--mode as another flag’s value', [...REST.slice(0, 3), '--mode', 'write'], '--realm needs a value'],
    ['--body without a value', ['--mode', 'write', ...REST, '--body'], '--body needs a value'],
    ['--body with an empty value', ['--mode', 'write', ...REST, '--body', ''], '--body needs a value'],
    ['--body before a flag', ['--mode', 'write', '--body', ...REST.slice(2), ...REST.slice(0, 2)], '--body needs a value'],
    ['--body twice', ['--mode', 'write', ...REST, '--body', GOOD, '--body', GOOD], '--body given twice'],
    ['--header without a value', ['--mode', 'write', ...REST, '--header'], '--header needs a value'],
    ['--header with an empty value', ['--mode', 'write', ...REST, '--header', ''], '--header needs a value'],
    ['--header before a flag', ['--mode', 'write', '--header', ...REST.slice(2), ...REST.slice(0, 2)], '--header needs a value'],
    ['a --header with no colon', ['--mode', 'write', ...REST, '--header', 'Accept'], '--header is not <k:v>'],
    ['a --header with no name', ['--mode', 'write', ...REST, '--header', ':x'], '--header is not <k:v>'],
    ['a --header twice', ['--mode', 'write', ...REST, '--header', 'Accept:a', '--header', 'Other:b', '--header', 'aCCEPT:c'], '--header names one twice'],
    ['an unknown flag', ['--mode', 'write', ...REST, '--modes', 'write'], 'unknown flag --modes'],
    ['an unknown flag before --mode', ['--headers', 'a:b', ...REST, '--mode', 'write'], 'unknown flag --headers'],
    ['--realm twice', ['--mode', 'write', ...REST, '--realm', REALM], '--realm given twice'],
    ['no --realm', ['--mode', 'write', ...REST.slice(0, 2)], 'missing --realm'],
    ['no URL', ['--mode', 'write', 'GET', '--realm', REALM], 'missing URL'],
    ['no METHOD', ['--mode', 'write'], 'missing METHOD'],
    ['a third positional', ['--mode', 'write', ...REST, 'extra'], 'too many arguments'],
    ['a body that can’t be read, after another error', ['--mode', 'write', ...REST, 'extra', '--body', path.join(dir, 'none')], 'too many arguments'],
  ] as Array<[string, string[], string]>)('%s is a usage error', (_label, argv, reason) => {
    expect(probe(argv)).toEqual(usage(reason));
  });

  it.each([
    ['--body', ['--body', GOOD]],
    ['--header', ['--header', 'Accept:x']],
    ['--modes', ['--modes', 'write']],
    ['-mode', ['-mode', 'write', '--body', GOOD]],
  ])('without --mode, %s is read mode’s usage error', (flag, more) => {
    expect(probe([...REST, ...more])).toEqual(usage(`unknown flag ${flag === '-mode' ? '--body' : flag}`, READ_USAGE));
  });

  it('without --mode, the POST and the by-id fetch are refused, as read mode refuses them', () => {
    expect(probe(['POST', UPDATE, '--realm', REALM])).toEqual({ code: 1, out: ['refuse quickbooks'], err: [] });
    expect(probe(REST)).toEqual({ code: 1, out: ['refuse entity-by-id'], err: [] });
    expect(probe(['GET', `${U}/reports/ProfitAndLoss?minorversion=75`, '--realm', REALM])).toEqual({ code: 0, out: ['allow reports'], err: [] });
  });

  it('`write` as a positional is no mode', () => {
    expect(probe(['write', ...REST])).toEqual(usage('too many arguments', READ_USAGE));
  });
});

describe('what the probe imports (PC3)', () => {
  const text = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
  /** Every import, re-export, import() and require() with a literal, by TypeScript's own scan. */
  const importsOf = (f: string) => ts.preProcessFile(text(f), true, true).importedFiles.map((i) => i.fileName);
  /** Each file reached by local imports, and each package or builtin those name. */
  function closure(start: string): { local: string[]; other: string[] } {
    const local: string[] = [];
    const other = new Set<string>();
    const walk = (f: string) => {
      if (local.includes(f)) return;
      local.push(f);
      for (const spec of importsOf(f)) {
        if (spec.startsWith('.')) walk(path.posix.join(path.posix.dirname(f), spec).replace(/\.js$/, '.ts'));
        else other.add(spec);
      }
    };
    walk(start);
    return { local: local.sort(), other: [...other].sort() };
  }

  it('guard-rules.ts imports exactly the decision and the hash; canonical.ts exactly node:crypto', () => {
    expect(importsOf('src/write/guard-rules.ts')).toEqual(['../clients/guard-decide.js', './canonical.js']);
    expect(importsOf('src/write/canonical.ts')).toEqual(['node:crypto']);
  });

  it('guard-probe.ts reaches these four files and these three builtins, no network module among them', () => {
    expect(closure('src/guard-probe.ts')).toEqual({
      local: ['src/clients/guard-decide.ts', 'src/guard-probe.ts', 'src/write/canonical.ts', 'src/write/guard-rules.ts'],
      other: ['node:crypto', 'node:fs', 'node:url'],
    });
  });

  it('none of them loads a module another way', () => {
    for (const f of closure('src/guard-probe.ts').local) {
      expect([f, text(f).match(/\bimport\s*\(|\brequire\b|getBuiltinModule|createRequire|process\.binding/g)]).toEqual([f, null]);
    }
  });

  it('the walk reaches a network module where there is one', () => {
    const { local, other } = closure('src/write/client.ts');
    expect(local).toContain('src/http-guard.ts');
    expect(other).toEqual(expect.arrayContaining(['axios', 'node:https']));
  });
});
