// Sanctuary Computer (quickbooks-mcp-286): A1.8's copy half. Every copied stacks-token/ file is served by a named case, and the fakes serve them.
// T13: A1.8's named-case half: each file is named by its check in an afterAll's expectServedBy, which fails unless that
// check's cases served it (tests/fakes/stacks-token.ts logs each fixture served with the running test's name).
import { describe, it, expect, afterEach } from '@jest/globals';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import ts from 'typescript';
import { fileURLToPath } from 'url';
import { installStubNetwork, type StubNetwork } from '../../fakes/stub-network.js';
import { SERVED_STACKS_FIXTURES, expectServedBy, servedLog, stacksFake, stacksFixture } from '../../fakes/stacks-token.js';
import { quickbooksFake } from '../../fakes/quickbooks.js';
import https from 'https';

const dir = (name: string) => fileURLToPath(new URL(`../../fakes/${name}`, import.meta.url));

function get(path: string, host: string): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode as number, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('copied fixtures', () => {
  it('every file in tests/fakes/stacks-token/ is a key of SERVED_STACKS_FIXTURES, and every key is a file', () => {
    expect(readdirSync(dir('stacks-token')).sort()).toEqual(Object.keys(SERVED_STACKS_FIXTURES).sort());
    expect(readdirSync(dir('stacks-token'))).toHaveLength(10);
  });

  it('every fixture file is 2-space JSON with a trailing newline', () => {
    // A Windows checkout may hold CRLF line ends: the format is what is checked, not the checkout's line ends.
    const readText = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    for (const d of ['stacks-token', 'tool-calls', 'tool-results', 'render', 'sequences']) {
      const walk = (p: string): string[] =>
        readdirSync(p, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${p}/${e.name}`) : [`${p}/${e.name}`]));
      for (const f of walk(dir(d)).filter((x) => x.endsWith('.json'))) {
        const text = readText(f);
        expect(JSON.stringify(JSON.parse(text), null, 2) + '\n').toBe(text);
      }
    }
    for (const f of ['name-fold.json', 'entities.json', 'entities-two.json']) {
      const text = readText(dir(f));
      expect(JSON.stringify(JSON.parse(text), null, 2) + '\n').toBe(text);
    }
  });

  it('the copied dirs hold the contract 1.1 write-tool fixtures', () => {
    const names = readdirSync(dir('tool-results'));
    for (const n of ['qbo_categorize_bill', 'qbo_categorize_purchase', 'qbo_undo_change', 'qbo_write_check']) expect(names).toContain(n);
  });

  it('entities-two.json adds one accepted name to garden3d and one company that folds to no other', () => {
    const one = JSON.parse(readFileSync(dir('entities.json'), 'utf8'));
    const two = JSON.parse(readFileSync(dir('entities-two.json'), 'utf8'));
    const g = (e: any) => e.companies.find((c: any) => c.stacks_key === 'garden3d').accepted_names;
    expect(g(two)).toEqual([...g(one), 'Garden Three LLC']);
    expect(two.companies).toHaveLength(one.companies.length + 1);
    const extra = two.companies.find((c: any) => !one.companies.some((o: any) => o.stacks_key === c.stacks_key));
    const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const others = two.companies.filter((c: any) => c !== extra).flatMap((c: any) => c.accepted_names.map(fold));
    for (const n of extra.accepted_names) expect(others).not.toContain(fold(n));
  });
});

describe('fakes', () => {
  let net: StubNetwork | undefined;
  afterEach(() => net?.restore());

  it('stacksFake serves each fixture status, headers and body, a string body as-is', async () => {
    for (const file of Object.keys(SERVED_STACKS_FIXTURES)) {
      const fx = stacksFixture(file);
      const key = (fx.body as any)?.enterprise ?? 'garden3d';
      const fake = stacksFake({ byKey: { [key]: file } });
      net = installStubNetwork(fake.handler);
      const res = await get(`/api/qbo/access_token?enterprise=${key}`, 'stacks.example.test');
      net.restore();
      expect(res.status).toBe(fx.status);
      expect(res.body).toBe(typeof fx.body === 'string' ? fx.body : JSON.stringify(fx.body));
      expect(res.headers['content-type']).toBe(fx.headers['content-type']);
      expect(fake.requests).toHaveLength(1);
    }
  });

  it('stacksFake defaults by enterprise key, then 404; sequence repeats its last; status and headers override', async () => {
    const fake = stacksFake({});
    net = installStubNetwork(fake.handler);
    expect((await get('/api/qbo/access_token?enterprise=usb-club', 'h')).status).toBe(200);
    expect((await get('/api/qbo/access_token?enterprise=nope', 'h')).status).toBe(404);
    net.restore();
    const seq = stacksFake({ sequence: ['502-proxy.json', { status: 200, body: { ok: true } }], status: undefined });
    net = installStubNetwork(seq.handler);
    expect((await get('/x', 'h')).status).toBe(502);
    expect((await get('/x', 'h')).body).toBe('{"ok":true}');
    expect((await get('/x', 'h')).status).toBe(200);
    net.restore();
    const over = stacksFake({ status: 429, headers: { 'retry-after': '30' } });
    net = installStubNetwork(over.handler);
    const r = await get('/api/qbo/access_token?enterprise=garden3d', 'h');
    expect([r.status, r.headers['retry-after']]).toEqual([429, '30']);
  });

  it('stacksFake refuses and hangs', async () => {
    for (const [refuse, code] of [['reset', 'ECONNRESET'], ['refused', 'ECONNREFUSED']] as const) {
      const fake = stacksFake({ refuse });
      net = installStubNetwork(fake.handler);
      await expect(get('/x', 'h')).rejects.toMatchObject({ code });
      net.restore();
      expect(fake.requests).toHaveLength(1);
    }
    const hung = stacksFake({ hang: true });
    net = installStubNetwork(hung.handler);
    let settled = false;
    void get('/x', 'h').then(() => (settled = true), () => (settled = true));
    await new Promise((r) => setTimeout(r, 20));
    expect([settled, hung.requests.length]).toEqual([false, 1]);
  });

  it('quickbooksFake serves company info, paged rows, a report, scripted answers, failures and a hold', async () => {
    const rows = [{ Id: '1' }, { Id: '2' }, { Id: '3' }];
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const fake = quickbooksFake({ companyInfo: { '999': { CompanyName: 'X' } }, rows, report: { Header: {} }, answers: [{ status: 401, body: { Fault: 1 } }] });
    net = installStubNetwork(fake.handler);
    expect((await get('/v3/company/999/companyinfo/999', 'q')).status).toBe(401);
    expect(JSON.parse((await get('/v3/company/999/companyinfo/999', 'q')).body).CompanyInfo).toEqual({ CompanyName: 'X' });
    expect((await get('/v3/company/1/companyinfo/1', 'q')).status).toBe(404);
    const page = JSON.parse((await get('/v3/company/999/query?query=select%20*%20from%20purchase%20startposition%202%20maxresults%201', 'q')).body);
    expect(page.QueryResponse.Purchase).toEqual([{ Id: '2' }]);
    expect(JSON.parse((await get('/v3/company/999/query?query=select%20*%20from%20bill%20startposition%209%20maxresults%201', 'q')).body).QueryResponse).toEqual({});
    expect(JSON.parse((await get('/v3/company/999/reports/ProfitAndLoss', 'q')).body)).toEqual({ Header: {} });
    expect((await get('/v3/company/999/other', 'q')).status).toBe(404);
    expect(fake.requests).toHaveLength(7);
    net.restore();
    for (const [fail, code] of [['reset', 'ECONNRESET'], ['refused', 'ECONNREFUSED'], ['tls', 'CERT_HAS_EXPIRED']] as const) {
      net = installStubNetwork(quickbooksFake({ fail }).handler);
      await expect(get('/x', 'q')).rejects.toMatchObject({ code });
      net.restore();
    }
    const held = quickbooksFake({ holdUntil: hold, answers: [{ status: 200, body: 'raw' }] });
    net = installStubNetwork(held.handler);
    let done = false;
    const p = get('/x', 'q').then((r) => ((done = true), r));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    release();
    expect((await p).body).toBe('raw');
  });
});

const TESTS = fileURLToPath(new URL('../../', import.meta.url));

/** Every `expectServedBy('<check>', ['<file>', …])` in a test file's afterAll, as `<check> <file> <test file>`; any other form is listed as such. */
function servedByCalls(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const inAfterAll = (n: ts.Node): boolean => {
    for (let p = n.parent; p !== undefined; p = p.parent) if (ts.isCallExpression(p) && p.expression.getText(sf) === 'afterAll') return true;
    return false;
  };
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === 'expectServedBy') {
      const [check, files] = n.arguments;
      if (!inAfterAll(n) || !check || !ts.isStringLiteral(check) || !files || !ts.isArrayLiteralExpression(files) || !files.elements.every(ts.isStringLiteral)) out.push(`${file}: an expectServedBy not read (${n.getText(sf).slice(0, 60)})`);
      else for (const f of files.elements as ts.NodeArray<ts.StringLiteral>) out.push(`${check.text} ${f.text} ${file}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? testFiles(path.join(dir, e.name)) : e.name.endsWith('.test.ts') ? [path.join(dir, e.name)] : []));
}

describe("A1.8's named-case half: every copied stacks-token/ file is served by a named case", () => {
  it("each file is named by its check (SERVED_STACKS_FIXTURES' id; usb-club by A3.4 too) in an afterAll's expectServedBy; no copy is unused", () => {
    // This file's own expectServedBy calls test the helper; they name no fixture's check.
    const calls = testFiles(TESTS)
      .filter((f) => f !== fileURLToPath(import.meta.url))
      .flatMap((f) => servedByCalls(path.relative(TESTS, f).split(path.sep).join('/'), readFileSync(f, 'utf8')))
      .sort();
    const want = [
      ...Object.entries(SERVED_STACKS_FIXTURES).map(([file, check]) => `${check} ${file}`),
      'A3.4 200-usb-club.json',
    ];
    expect(calls.map((c) => c.split(' ').slice(0, 2).join(' ')).sort()).toEqual(want.sort());
    expect(calls).toEqual([
      'A1.1 200-garden3d.json unit/clients/stacks-token.test.ts',
      'A1.5 403.json unit/clients/stacks-token.test.ts',
      'A1.5 404.json unit/clients/stacks-token.test.ts',
      'A1.5 409.json unit/clients/stacks-token.test.ts',
      'A1.5 502-invalid_grant.json unit/clients/stacks-token.test.ts',
      'A1.5 502-proxy.json unit/clients/stacks-token.test.ts',
      'A1.5 502-unavailable.json unit/clients/stacks-token.test.ts',
      'A3.4 200-usb-club.json integration/companies-overlap.test.ts',
      'A4.9 200-index-space.json unit/tools/company-tools.test.ts',
      'A4.9 200-sanctuary-computer.json unit/tools/company-tools.test.ts',
      'A4.9 200-usb-club.json unit/tools/company-tools.test.ts',
    ]);
    // No copy unused: every file in the directory is named.
    expect([...new Set(calls.map((c) => c.split(' ')[1]))].sort()).toEqual(readdirSync(dir('stacks-token')).sort());
  });

  it('the scan reads only an afterAll call with literal arguments; anything else is listed', () => {
    expect(servedByCalls('t.ts', "afterAll(() => { expectServedBy('A9', ['a.json', 'b.json']); });")).toEqual(['A9 a.json t.ts', 'A9 b.json t.ts']);
    expect(servedByCalls('t.ts', "it('x', () => { expectServedBy('A9', ['a.json']); });")).toEqual([expect.stringContaining('not read')]);
    expect(servedByCalls('t.ts', "afterAll(() => expectServedBy(CHECK, ['a.json']));")).toEqual([expect.stringContaining('not read')]);
    expect(servedByCalls('t.ts', "afterAll(() => expectServedBy('A9', FILES));")).toEqual([expect.stringContaining('not read')]);
  });

  it("expectServedBy passes only for a file served inside a test whose name holds the check (this test's own name names A1.8)", () => {
    const before = servedLog.length;
    stacksFake({ byKey: { garden3d: '409.json' } }).handler({ path: '/api/qbo/access_token?enterprise=garden3d' } as never);
    expect(servedLog.slice(before)).toEqual([{ file: '409.json', test: expect.stringContaining('A1.8') }]);
    expect(() => expectServedBy('A1.8', ['409.json'])).not.toThrow();
    expect(() => expectServedBy('A1.8', ['403.json'])).toThrow();
    expect(() => expectServedBy('A9.9', ['409.json'])).toThrow();
  });
});
