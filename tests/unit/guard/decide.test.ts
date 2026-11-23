// Sanctuary Computer (quickbooks-mcp-291): contract 1.0 §6's decisions, the ticket's clauses and the guard's own rules, through decide().
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import {
  decide,
  newCallRecord,
  QBO_HOST,
  REPORT_KEYS,
  type CallRecord,
  type Decision,
  type GuardContext,
  type GuardRequest,
} from '../../../src/clients/guard-decide.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const EX = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fakes/guard-examples.json'), 'utf8'));

const REALM = '9990000000000002';
const Q = `https://quickbooks.api.intuit.com/v3/company/${REALM}`;
const S = 'https://stacks.example.test/api/qbo/access_token';
const P = `${Q}/preferences?minorversion=75&format=json`;
const TAIL = '&minorversion=75&format=json';
const PNL = `${Q}/reports/ProfitAndLoss?start_date=2026-10-01&end_date=2026-10-31${TAIL}`;
const fakeToken = () => 'qbo-fake-' + 'token';

/** A query URL whose statement is percent-encoded (spaces as %20). */
const lq = (statement: string) => `${Q}/query?query=${encodeURIComponent(statement)}${TAIL}`;
/** A query URL with the statement as node-quickbooks puts it in `url`: literal spaces. */
const lit = (statement: string) => `${Q}/query?query=${statement}${TAIL}`;

function ctx(over: Partial<GuardContext> = {}, record: CallRecord | undefined = newCallRecord()): GuardContext {
  return {
    stacksUrl: EX.context.stacksUrl,
    keys: () => [...EX.context.keys],
    allowedRealm: (r: string) => r === REALM,
    callRecord: () => record,
    ...over,
  };
}

const d = (method: string | undefined, url: string | undefined, c: GuardContext = ctx(), extra: Partial<GuardRequest> = {}) =>
  decide({ method, url, ...extra }, c);

/** `allow <rule>` or the refusal's rule name. */
const name = (dec: Decision) => (dec.allow ? `allow ${dec.rule}` : dec.rule);

/** Runs one tool call's requests the way the adapter does: decide, then record an allowed query with its answer. */
function call(steps: Array<{ method?: string; url: string; status?: number }>, c?: GuardContext) {
  const record = newCallRecord();
  const context = c ?? ctx({}, record);
  return steps.map((s) => {
    const dec = decide({ method: s.method ?? 'GET', url: s.url }, context);
    if (dec.allow && dec.entity !== undefined) record.queries.push({ entity: dec.entity, url: dec.url, status: s.status ?? null });
    return dec;
  });
}

const P1: string = EX.requestIds.P1.url;
const B1: string = EX.requestIds.B1.url;

describe('contract rows (A1.2)', () => {
  it('has the 41 Guard examples and 11 Guard call examples', () => {
    expect(EX.contract).toBe('docs/contracts/quickbooks.md@1.0');
    expect(EX.examples).toHaveLength(41);
    expect(EX.callExamples).toHaveLength(11);
  });

  it.each(EX.examples.map((r: any) => [r.case, r]))('Guard examples: %s', (_c, row: any) => {
    const dec = d(row.method, row.url);
    expect(dec.allow ? 'allow' : 'refuse').toBe(row.decision);
  });

  it.each(EX.callExamples.map((r: any) => [r.case, r]))('Guard call examples: %s', (_c, row: any) => {
    const steps = row.requests.map((r: any) => ({ method: EX.requestIds[r.id].method, url: EX.requestIds[r.id].url, status: r.status }));
    const decs = call(steps);
    for (const prior of decs.slice(0, -1)) expect(prior.allow).toBe(true);
    expect(decs[decs.length - 1].allow ? 'allow' : 'refuse').toBe(row.decision);
  });

  it('the allowed rows carry their form rule, the text as given and the URL new URL makes of it', () => {
    const rules = EX.examples.filter((r: any) => r.decision === 'allow').map((r: any) => {
      const dec = d(r.method, r.url);
      if (!dec.allow) throw new Error('refused ' + r.url);
      expect(dec.text).toBe(r.url);
      expect(dec.url).toBe(new URL(r.url).href);
      return dec.rule;
    });
    expect(rules).toEqual(['companyinfo', 'preferences', 'preferences', 'query', 'reports', 'stacks', 'stacks']);
  });
});

describe('clause cases (A1.4, guard-clauses.md)', () => {
  const each = (cases: Array<[string, string, string]>, c?: () => GuardContext) =>
    it.each(cases)('%s %s', (method, url, expected) => {
      expect(name(d(method, url, c ? c() : ctx()))).toBe(expected);
    });

  describe('clause 1: no control character, space or DEL; inner query spaces allowed', () => {
    each([
      ['GET', `${Q}/pref\terences?minorversion=75&format=json`, 'raw-text'],
      ['GET', `${Q}/pref\rerences?minorversion=75&format=json`, 'raw-text'],
      ['GET', `${Q}/pref\nerences?minorversion=75&format=json`, 'raw-text'],
      ['GET', `${Q}/pref\x7ferences?minorversion=75&format=json`, 'raw-text'],
      ['GET', `${Q}/pref\x00erences?minorversion=75&format=json`, 'raw-text'],
      ['GET', `${Q}/pref\x1ferences?minorversion=75&format=json`, 'raw-text'],
      ['GET', lit('select *\tfrom purchase maxresults 10'), 'raw-text'],
      ['GET', lit('select * from purchase\x1fmaxresults 10'), 'raw-text'],
      ['GET', lit("select * from purchase where Memo %3D %27~%27 maxresults 10"), 'allow query'],
      ['GET', ` ${P}`, 'raw-text'],
      ['GET', `${P} `, 'raw-text'],
      ['GET', lit('select * from purchase maxresults 10'), 'allow query'],
    ]);
  });

  describe('clause 2: no fragment', () => {
    each([
      ['GET', `${P}#x`, 'raw-text'],
      ['GET', `${P}#`, 'raw-text'],
    ]);
  });

  describe('clause 3: starts <scheme>://<authority>', () => {
    const tail = `/v3/company/${REALM}/preferences?minorversion=75&format=json`;
    const dots = `/v3/company/${REALM}/query/../preferences?minorversion=75&format=json`;
    const st = '/api/qbo/access_token?enterprise=garden3d';
    const sd = '/x/../api/qbo/access_token?enterprise=garden3d';
    each([
      ['GET', `https:/quickbooks.api.intuit.com${tail}`, 'raw-text'],
      ['GET', `https:quickbooks.api.intuit.com${tail}`, 'raw-text'],
      ['GET', `https:\\\\quickbooks.api.intuit.com${tail}`, 'raw-text'],
      ['GET', `https:/quickbooks.api.intuit.com${dots}`, 'raw-text'],
      ['GET', `https:quickbooks.api.intuit.com${dots}`, 'raw-text'],
      ['GET', `https:\\\\quickbooks.api.intuit.com${dots}`, 'raw-text'],
      ['GET', `https:/stacks.example.test${st}`, 'raw-text'],
      ['GET', `https:stacks.example.test${st}`, 'raw-text'],
      ['GET', `https:\\\\stacks.example.test${st}`, 'raw-text'],
      ['GET', `https:/stacks.example.test${sd}`, 'raw-text'],
      ['GET', `https:stacks.example.test${sd}`, 'raw-text'],
      ['GET', `https:\\\\stacks.example.test${sd}`, 'raw-text'],
    ]);
  });

  describe('clause 4: the head as given', () => {
    each([
      ['GET', `HTTPS://quickbooks.api.intuit.com/v3/company/${REALM}/preferences?minorversion=75&format=json`, 'raw-text'],
      ['GET', `https://QuickBooks.api.intuit.com/v3/company/${REALM}/preferences?minorversion=75&format=json`, 'raw-text'],
      ['GET', `https://quickbooks.api.intuit.com:443/v3/company/${REALM}/preferences?minorversion=75&format=json`, 'raw-text'],
      ['GET', 'https://stacks.example.test:443/api/qbo/access_token?enterprise=garden3d', 'raw-text'],
      ['GET', 'HTTPS://stacks.example.test/api/qbo/access_token?enterprise=garden3d', 'raw-text'],
    ]);
  });

  describe('clause 5: \\ in the path', () => {
    each([
      ['GET', `${Q}\\preferences?minorversion=75&format=json`, 'dot-segments'],
      ['GET', `${Q}/pre\\ferences?minorversion=75&format=json`, 'dot-segments'],
      ['GET', 'https://stacks.example.test\\api/qbo/access_token?enterprise=garden3d', 'dot-segments'],
    ]);
  });

  describe('clause 6: %2e any case', () => {
    each([
      ['GET', `${Q}/query/%2e/preferences?minorversion=75&format=json`, 'dot-segments'],
      ['GET', `${Q}/query/.%2e/preferences?minorversion=75&format=json`, 'dot-segments'],
      ['GET', `${Q}/query/%2E/preferences?minorversion=75&format=json`, 'dot-segments'],
      ['GET', `${Q}/query/%2E%2E/preferences?minorversion=75&format=json`, 'dot-segments'],
      ['GET', 'https://stacks.example.test/api/%2e%2e/api/qbo/access_token?enterprise=garden3d', 'dot-segments'],
    ]);
  });

  describe('clause 7: a . segment; a .. on Stacks', () => {
    each([
      ['GET', `${Q}/./preferences?minorversion=75&format=json`, 'dot-segments'],
      ['GET', 'https://stacks.example.test/x/../api/qbo/access_token?enterprise=garden3d', 'dot-segments'],
    ]);
  });

  describe('clause 8: the path stops at ?', () => {
    each([['GET', lit("select * from purchase where Memo %3D %27/../%27 maxresults 10"), 'allow query']]);
  });

  describe('clause 9: https: only', () => {
    each([['GET', `http://quickbooks.api.intuit.com/v3/company/${REALM}/preferences?minorversion=75&format=json`, 'raw-text']]);
  });

  describe('clause 10: host exactly', () => {
    each([
      ['GET', `https://quickbooks.api.intuit.com.evil.test/v3/company/${REALM}/preferences?minorversion=75&format=json`, 'refused'],
      ['GET', `https://quickbooks.api.intuit.com./v3/company/${REALM}/preferences?minorversion=75&format=json`, 'refused'],
    ]);
  });

  describe('clause 11: no password-only userinfo', () => {
    each([['GET', `https://:pw@quickbooks.api.intuit.com/v3/company/${REALM}/preferences?minorversion=75&format=json`, 'raw-text']]);
  });

  describe('clause 12: GET only', () => {
    each([
      ['PATCH', P, 'quickbooks'],
      ['HEAD', P, 'quickbooks'],
      ['OPTIONS', P, 'quickbooks'],
    ]);
  });

  describe('clause 13: path starts /v3/company/<R>/ exactly', () => {
    each([
      ['GET', `https://quickbooks.api.intuit.com/V3/company/${REALM}/preferences?minorversion=75&format=json`, 'quickbooks'],
      ['GET', `https://quickbooks.api.intuit.com/x/v3/company/${REALM}/preferences?minorversion=75&format=json`, 'quickbooks'],
    ]);
  });

  describe('clause 14: inside a call', () => {
    each([['GET', P, 'quickbooks']], () => ctx({ callRecord: () => undefined }));
  });

  describe('clause 15: minorversion exactly 75', () => {
    each([
      ['GET', `${Q}/preferences?minorversion=75.0&format=json`, 'quickbooks'],
      ['GET', `${Q}/preferences?minorversion=075&format=json`, 'quickbooks'],
    ]);
  });

  describe('clause 16: format exactly json', () => {
    each([
      ['GET', `${Q}/preferences?minorversion=75&format=xml`, 'quickbooks'],
      ['GET', `${Q}/preferences?minorversion=75&format=JSON`, 'quickbooks'],
      ['GET', `${Q}/preferences?minorversion=75&format=%20json`, 'quickbooks'],
    ]);
  });

  describe('clause 17: no key twice', () => {
    each([
      ['GET', `${Q}/preferences?minorversion=75&format=json&format=json`, 'quickbooks'],
      ['GET', `${Q}/reports/ProfitAndLoss?start_date=2026-10-01&start_date=2026-10-02${TAIL}`, 'quickbooks'],
    ]);
  });

  describe('clause 18: query, report keys and the refused keys', () => {
    each([
      ['GET', `${Q}/companyinfo/${REALM}?query=select%20*%20from%20purchase%20maxresults%2010${TAIL}`, 'quickbooks'],
      ['GET', `${Q}/preferences?start_date=2026-10-01${TAIL}`, 'quickbooks'],
      ['GET', `${Q}/reports/TrialBalance?vendor=5${TAIL}`, 'quickbooks'],
      ['GET', `${lq('select * from purchase maxresults 10')}&include=allowduplicatedocnum`, 'quickbooks'],
      ['GET', `${PNL}&requestid=fake-req-0001`, 'quickbooks'],
      ['GET', `${Q}/companyinfo/${REALM}?operation=update${TAIL}`, 'quickbooks'],
    ]);
  });

  describe('clause 19: companyinfo/<R> exactly', () => {
    each([
      ['GET', `${Q}/companyinfo/${REALM}/x?minorversion=75&format=json`, 'refused'],
      ['GET', `${Q}/companyinfo/${REALM}/?minorversion=75&format=json`, 'refused'],
    ]);
  });

  describe('clause 20: preferences exactly', () => {
    each([
      ['GET', `${Q}/preferences/x?minorversion=75&format=json`, 'refused'],
      ['GET', `${Q}/preferences/?minorversion=75&format=json`, 'refused'],
      ['GET', `${Q}/pr%65ferences?minorversion=75&format=json`, 'refused'],
    ]);
  });

  describe('clause 21: query exactly', () => {
    each([['GET', `${Q}/query/x?query=select%20*%20from%20purchase%20maxresults%2010${TAIL}`, 'refused']]);
  });

  describe('clause 22: reports/<Name> exactly one of 11, with case', () => {
    each([
      ['GET', `${Q}/reports/ProfitAndLossX?minorversion=75&format=json`, 'reports'],
      ['GET', `${Q}/reports/profitandloss?minorversion=75&format=json`, 'reports'],
    ]);
  });

  describe('clause 23: select and its whitespace', () => {
    each([
      ['GET', lq('select* from purchase maxresults 10'), 'query'],
      ['GET', lq('SELECT * FROM purchase MAXRESULTS 10'), 'allow query'],
      ['GET', lq(' select * from purchase maxresults 10'), 'query'],
    ]);
  });

  describe('clause 24: ends maxresults <n>', () => {
    each([
      ['GET', lq('select * from purchase'), 'query'],
      ['GET', lq('select * from purchase maxresults  10'), 'allow query'],
      ['GET', lq('select * from purchase maxresults\n10'), 'allow query'],
      ['GET', lq('select * from purchase maxresults 10 x'), 'query'],
      ['GET', lq('select * from purchase MAXRESULTS 10'), 'allow query'],
      ['GET', lq('select * from purchase maxresults 10 '), 'query'],
    ]);
  });

  describe('clause 25: n at most 1000', () => {
    each([
      ['GET', lq('select * from purchase maxresults 10000'), 'query'],
      ['GET', lq('select * from purchase maxresults 1000'), 'allow query'],
    ]);
  });

  describe('clause 26: decoded, + is a space', () => {
    each([['GET', `${Q}/query?query=select+*+from+purchase+maxresults+10${TAIL}`, 'allow query']]);
  });

  describe('clause 27: one distinct query per entity; no from refused', () => {
    it('FROM purchase, then from Purchase in the same call', () => {
      const decs = call([{ url: lq('select * FROM purchase maxresults 10'), status: 200 }, { url: lq('select * from Purchase maxresults 10') }]);
      expect(decs.map(name)).toEqual(['allow query', 'query']);
      expect(decs[0].allow && decs[0].entity).toBe('purchase');
    });
    each([['GET', lq('select count(*) maxresults 10'), 'query']]);
  });

  describe('clause 28: resend cap per call', () => {
    it('P1 [401], P1 [200], B1 [401], B1', () => {
      const decs = call([{ url: P1, status: 401 }, { url: P1, status: 200 }, { url: B1, status: 401 }, { url: B1 }]);
      expect(decs.map(name)).toEqual(['allow query', 'allow query', 'allow query', 'query']);
    });
  });

  describe('clause 29: resend URL byte for byte', () => {
    it('P1 [401], then P1 with %20 written +', () => {
      const decs = call([{ url: P1, status: 401 }, { url: P1.replace(/%20/g, '+') }]);
      expect(decs.map(name)).toEqual(['allow query', 'query']);
    });
  });

  describe('clause 30: another entity between a request and its resend', () => {
    it('P1 [401], B1 [200], P1', () => {
      const decs = call([{ url: P1, status: 401 }, { url: B1, status: 200 }, { url: P1 }]);
      expect(decs.map(name)).toEqual(['allow query', 'allow query', 'allow query']);
      expect(decs[2].allow && decs[2].resend).toBe(401);
    });
  });

  describe('clause 31: Stacks host exactly', () => {
    each([
      ['GET', 'https://other.example.test/api/qbo/access_token?enterprise=garden3d', 'refused'],
      ['GET', 'https://stacks.example.test.evil/api/qbo/access_token?enterprise=garden3d', 'refused'],
      ['GET', 'https://xstacks.example.test/api/qbo/access_token?enterprise=garden3d', 'refused'],
    ]);
  });

  describe('clause 32: Stacks GET only', () => {
    each([
      ['POST', `${S}?enterprise=garden3d`, 'stacks'],
      ['HEAD', `${S}?enterprise=garden3d`, 'stacks'],
      ['PATCH', `${S}?enterprise=garden3d`, 'stacks'],
    ]);
  });

  describe('clause 33: Stacks path exactly', () => {
    each([
      ['GET', 'https://stacks.example.test/api/qbo/token?enterprise=garden3d', 'stacks'],
      ['GET', 'https://stacks.example.test/api/qbo/access_token/x?enterprise=garden3d', 'stacks'],
      ['GET', 'https://stacks.example.test/api/qbo/access_token/?enterprise=garden3d', 'stacks'],
      ['GET', 'https://stacks.example.test/API/qbo/access_token?enterprise=garden3d', 'stacks'],
      ['GET', 'https://stacks.example.test/x/api/qbo/access_token?enterprise=garden3d', 'stacks'],
    ]);
  });

  describe('clause 34: Stacks, no password-only userinfo', () => {
    each([['GET', 'https://:pw@stacks.example.test/api/qbo/access_token?enterprise=garden3d', 'raw-text']]);
  });

  describe('clause 35: the key exactly, with case, not trimmed', () => {
    each([
      ['GET', `${S}?enterprise=Garden3d`, 'stacks'],
      ['GET', `${S}?enterprise=%20garden3d`, 'stacks'],
    ]);
  });

  describe('clause 36: none of the QuickBooks rules', () => {
    each([['GET', `${S}?enterprise=garden3d&minorversion=75`, 'stacks']]);
  });

  describe('clause 37: Stacks not counted', () => {
    it('P1 [401], S, P1', () => {
      const decs = call([{ url: P1, status: 401 }, { url: `${S}?enterprise=garden3d`, status: 200 }, { url: P1 }]);
      expect(decs.map(name)).toEqual(['allow query', 'allow stacks', 'allow query']);
      expect(decs[2].allow && decs[2].resend).toBe(401);
    });
  });

  describe('clause 38: Stacks outside a call', () => {
    each([['GET', `${S}?enterprise=garden3d`, 'allow stacks']], () => ctx({ callRecord: () => undefined }));
  });

  describe('decided here: other spellings of an allowed head, third hosts, counting', () => {
    each([
      ['GET', `https://quickbooks.api.intuit.co%6d/v3/company/${REALM}/preferences?minorversion=75&format=json`, 'raw-text'],
      ['GET', `https://quickbooks.api.intuit.\uff43om/v3/company/${REALM}/preferences?minorversion=75&format=json`, 'raw-text'],
      ['GET', `https://quickbooks.api.intuit.com:/v3/company/${REALM}/preferences?minorversion=75&format=json`, 'raw-text'],
      ['GET', lq("select * from 1 where Memo = ' from bill ' maxresults 10"), 'query'],
      ['GET', 'HTTPS://example.test/', 'refused'],
      ['GET', 'https://stacks.example.test./api/qbo/access_token?enterprise=garden3d', 'refused'],
      ['GET', `${Q}/reports/ProfitAndLoss?start_date=2026-01-01&end_date=2026-03-31&accounting_method=Cash&&minorversion=75&format=json`, 'allow reports'],
    ]);
    it('a tab before from and two spaces after it both count under purchase', () => {
      const tab = lq('select *\tfrom purchase maxresults 10');
      const two = lq('select * from  purchase maxresults 10');
      for (const u of [tab, two]) {
        const dec = d('GET', u);
        expect(dec.allow && dec.entity).toBe('purchase');
      }
      expect(call([{ url: tab, status: 200 }, { url: two }]).map(name)).toEqual(['allow query', 'query']);
    });
  });

  describe("after 284's proposal-1", () => {
    each([
      ['GET', lq("select * from purchase where Memo = 'x from y' maxresults 10"), 'query'],
      ['GET', lq('select *\u00a0from purchase maxresults 10'), 'query'],
      ['GET', lq('select * from purchase where Memo = \u3000 maxresults 10'), 'query'],
      ['GET', lq('select * from purchase\u2028maxresults 10'), 'query'],
      ['GET', lit('select * from purchase maxresults 10'), 'allow query'],
    ]);
    it.each([['\v'], ['\f'], ['\n'], ['\r'], ['\t']])('from with %j on either side counts under the entity', (ws) => {
      for (const s of [`select *${ws}from purchase maxresults 10`, `select * from${ws}purchase maxresults 10`]) {
        const dec = d('GET', lq(s));
        expect(name(dec)).toBe('allow query');
        expect(dec.allow && dec.entity).toBe('purchase');
      }
    });
  });

  describe('bound to the contract at 66cd209c', () => {
    each([
      ['GET', `${Q}/pre ferences?minorversion=75&format=json`, 'raw-text'],
      ['GET', `${Q}/preferences?minorversion=75&format= json`, 'raw-text'],
      ['GET', lq("select * from purchase where Memo = 'from' maxresults 10"), 'query'],
      ['GET', lq('select * from purchase where xfrom = 1 maxresults 10'), 'allow query'],
      ['GET', lq('select * from purchase where from_x = 1 maxresults 10'), 'allow query'],
      ['GET', lq('select\t* from purchase maxresults 10'), 'allow query'],
      ['GET', lq('select * from purchase maxresults\v10'), 'allow query'],
      ['GET', lq("select * from purchase where Memo = 'a\ufeffb' maxresults 10"), 'allow query'],
    ]);
    it('the entity is the longest run of letters', () => {
      const dec = d('GET', lq('select * from purchase,bill maxresults 10'));
      expect(dec.allow && dec.entity).toBe('purchase');
    });
  });

  describe('plan-5 and plan-6 cases', () => {
    each([
      ['GET', `${Q}/reports/ProfitAndLoss?start_date=query=a b&minorversion=75`, 'raw-text'],
      ['GET', `${Q}/reports/ProfitAndLoss?start_date=x?query=a b&minorversion=75`, 'raw-text'],
      ['get', P, 'allow preferences'],
      ['Get', P, 'allow preferences'],
      [' GET', P, 'quickbooks'],
      ['GET ', P, 'quickbooks'],
      ['get', `${S}?enterprise=garden3d`, 'allow stacks'],
      [' GET', `${S}?enterprise=garden3d`, 'stacks'],
      ['GET', lq('select * from purchas\u00e9 maxresults 10'), 'query'],
      ['GET', lq('select * from purchase\u0301 maxresults 10'), 'query'],
      ['GET', lq("select * from purchase where Memo = 'a\u00a0b' maxresults 10"), 'query'],
      ['GET', lq("select * from purchase where Memo = 'a\u3000b' maxresults 10"), 'query'],
      ['GET', lq("select * from purchase where Memo = 'a\u0085b' maxresults 10"), 'query'],
      ['GET', lq("select * from purchase where Memo = 'a\u2028b' maxresults 10"), 'query'],
      ['GET', lq("select * from purchase where Memo = 'a\u2029b' maxresults 10"), 'query'],
      ['GET', lq("select * from purchase where Memo = 'a b' maxresults 10"), 'allow query'],
      // plan-6 V1: the spaced pair is allowed past raw-text wherever its key is `query`; off the query form the key itself is refused.
      ['GET', `${Q}/preferences?query=a b&minorversion=75`, 'quickbooks'],
      ['GET', `${S}?enterprise=garden3d&query=a b`, 'stacks'],
      ['GET', `${Q}/preferences?xquery=a b&minorversion=75`, 'raw-text'],
      ['GET', `${Q}/preferences?minorversion=75&query a=b`, 'raw-text'],
    ]);
  });

  describe("284's open cases and its added clauses 39-49", () => {
    each([
      ['GET', lq('select * from purchase maxresults 0'), 'allow query'],
      ['GET', lq('select * from purchase maxresults 010'), 'query'],
      ['GET', lq('select * from purchase maxresults \u0661\u0660'), 'query'],
      ['GET', lq("select * from 'x' maxresults 10"), 'query'],
      ['GET', lq('select * \u00e9from purchase maxresults 10'), 'query'],
      ['GET', lq('select * from purchase maxresults 10\n'), 'query'],
      ['GET', lq('select * from purchasemaxresults 10'), 'query'],
      ['GET', `${Q}/query?query=${TAIL}`, 'query'],
      ['GET', `${Q}/query?minorversion=75&format=json`, 'query'],
      ['GET', `${Q}/query?%71uery=select%20*%20from%20purchase%20maxresults%2010${TAIL}`, 'allow query'],
      ['GET', `${Q}/preferences?minorversion=75&format=json&%66ormat=json`, 'quickbooks'],
      ['GET', `${Q}/preferences?minorversion=75&Format=json`, 'quickbooks'],
      ['GET', `${Q}/preferences?Minorversion=75&format=json`, 'quickbooks'],
      ['GET', `${Q}/preferences?minorversion=&format=json`, 'quickbooks'],
      ['GET', `${Q}/preferences?minorversion=%2075&format=json`, 'quickbooks'],
      ['GET', `${Q}/preferences?minorversion=75%20&format=json`, 'quickbooks'],
      ['GET', `${Q}/preferences?minorversion=75&format=jsonx`, 'quickbooks'],
      ['GET', `${Q}/preferences?minorversion=75&format=`, 'quickbooks'],
      ['GET', `${Q}/preferences?minorversion=75&=x`, 'quickbooks'],
      ['GET', `${Q}/Preferences?minorversion=75&format=json`, 'refused'],
      ['GET', `${Q}/query/?query=select%20*%20from%20purchase%20maxresults%2010${TAIL}`, 'refused'],
      ['GET', `${Q}/reports/ProfitAndLoss/?minorversion=75&format=json`, 'reports'],
      ['GET', `${Q}/reports?minorversion=75&format=json`, 'refused'],
      ['GET', `https://quickbooks.api.intuit.com/v3/company/0${REALM}/preferences?minorversion=75&format=json`, 'quickbooks'],
      ['GET', `${Q}/companyinfo/0${REALM}?minorversion=75&format=json`, 'entity-by-id'],
      ['GET', `${Q}//preferences?minorversion=75&format=json`, 'refused'],
      ['GET', `${Q}/purchase/5?minorversion=75&format=json`, 'entity-by-id'],
      ['GET', `${Q}/invoice/5/pdf?minorversion=75&format=json`, 'refused'],
      ['GET', `${PNL.replace('end_date=2026-10-31', 'end_date=')}`, 'allow reports'],
      ['GET', `${Q}/reports/Constructor?minorversion=75&format=json`, 'reports'],
      ['GET', `${Q}/reports/toString?minorversion=75&format=json`, 'reports'],
      ['GET', `${Q}/reports/ProfitAndLoss?constructor=x${TAIL}`, 'quickbooks'],
      ['GET', `${Q}/reports/constructor?minorversion=75&format=json`, 'reports'],
      ['GET', `${Q}/reports/ProfitAndLoss/x?start_date=2026-10-01${TAIL}`, 'quickbooks'],
      ['GET', `${Q}/query?query &minorversion=75`, 'raw-text'],
      ['GET', `${Q}/preferences?minorversion=75&a b`, 'raw-text'],
      ['GET', `https://quickbooks.api.intuit.com.evil.test/`, 'refused'],
      ['GET', `https://sub.quickbooks.api.intuit.com/v3/company/${REALM}/preferences?minorversion=75&format=json`, 'refused'],
      ['GET', 'https://sub.stacks.example.test/api/qbo/access_token?enterprise=garden3d', 'refused'],
      ['GET', S, 'stacks'],
      ['GET', `${S}?enterprise=garden3`, 'stacks'],
      ['GET', `${S}?enterprise=garden3dx`, 'stacks'],
      ['GET', `${S}?enterprise=`, 'stacks'],
      ['GET', `${S}?enterprise=garden3d&enterprise=garden3d`, 'stacks'],
      ['GET', `${S}?Enterprise=garden3d`, 'stacks'],
      ['GET', `${S}?%65nterprise=garden3d`, 'allow stacks'],
      ['GET', `${S}?enterprise=constructor`, 'stacks'],
    ]);
  });

  it('a third distinct entity after a 429 resend: P1 [429], P1, then a 401 resend of B1 is still allowed', () => {
    const decs = call([{ url: P1, status: 429 }, { url: P1, status: 200 }, { url: B1, status: 401 }, { url: B1 }]);
    expect(decs.map(name)).toEqual(['allow query', 'allow query', 'allow query', 'allow query']);
    expect(decs.map((x) => (x.allow ? x.resend : undefined))).toEqual([undefined, 429, undefined, 401]);
  });

  it('a query whose previous request has no answer yet (status null) is not a resend', () => {
    const decs = call([{ url: P1 }, { url: P1 }]);
    expect(decs.map(name)).toEqual(['allow query', 'query']);
  });
});

describe("284's resend cases (the URL as sent, byte for byte)", () => {
  const stmt = "select * from purchase where Memo = 'x' maxresults 10";
  it('P1 [401], then P1 with literal spaces where it had %20: allowed', () => {
    const decs = call([{ url: P1, status: 401 }, { url: P1.replace(/%20/g, ' ') }]);
    expect(decs.map(name)).toEqual(['allow query', 'allow query']);
    expect(decs[1].allow && decs[1].resend).toBe(401);
  });
  it("%27 [401], then a literal ': allowed", () => {
    const a = lit(stmt.replace(/'/g, '%27'));
    const b = lit(stmt);
    expect(call([{ url: a, status: 401 }, { url: b }]).map(name)).toEqual(['allow query', 'allow query']);
  });
  it('* [401], then %2A: refused', () => {
    expect(call([{ url: lit(stmt), status: 401 }, { url: lit(stmt.replace('*', '%2A')) }]).map(name)).toEqual(['allow query', 'query']);
  });
  it('%20 [401], then +: refused', () => {
    const a = lq(stmt);
    expect(call([{ url: a, status: 401 }, { url: a.replace(/%20/g, '+') }]).map(name)).toEqual(['allow query', 'query']);
  });
  it('decide never changes the call record', () => {
    const record = newCallRecord();
    record.queries.push({ entity: 'purchase', url: new URL(P1).href, status: 401 });
    const before = JSON.stringify(record);
    const dec = decide({ method: 'GET', url: P1 }, ctx({}, record));
    expect(dec.allow && dec.resend).toBe(401);
    expect(JSON.stringify(record)).toBe(before);
  });
  it('newCallRecord starts empty and fresh each time', () => {
    const a = newCallRecord();
    expect(a).toEqual({ queries: [] });
    expect(newCallRecord()).not.toBe(a);
  });
});

describe('node-quickbooks texts (P1, recorded at T0)', () => {
  // verification.md §T0 Step 2: config.url and config.params as node-quickbooks 2.0.50 hands them to axios, and the path axios passes to https.request.
  const params = { minorversion: 75, format: 'json' };
  const recorded = [
    {
      rule: 'query',
      url: `${Q}/query?query=select * from purchase where PaymentType %3D %27Cash%5C%27s%27 startposition 1 maxresults 10`,
      path: `/v3/company/${REALM}/query?query=select%20*%20from%20purchase%20where%20PaymentType%20%3D%20%27Cash%5C%27s%27%20startposition%201%20maxresults%2010&minorversion=75&format=json`,
    },
    {
      rule: 'reports',
      url: `${Q}/reports/ProfitAndLoss?start_date=2026-01-01&end_date=2026-03-31&accounting_method=Cash&`,
      path: `/v3/company/${REALM}/reports/ProfitAndLoss?start_date=2026-01-01&end_date=2026-03-31&accounting_method=Cash&&minorversion=75&format=json`,
    },
    { rule: 'companyinfo', url: `${Q}/companyinfo/${REALM}`, path: `/v3/company/${REALM}/companyinfo/${REALM}?minorversion=75&format=json` },
    { rule: 'preferences', url: `${Q}/preferences`, path: `/v3/company/${REALM}/preferences?minorversion=75&format=json` },
  ];
  it.each(recorded.map((r) => [r.rule, r] as const))('%s is allowed and sent as the recorded path', (rule, r) => {
    const dec = decide({ method: 'get', url: r.url, params: { ...params } }, ctx());
    expect(name(dec)).toBe(`allow ${rule}`);
    if (!dec.allow) return;
    const w = new URL(dec.url);
    expect(w.pathname + w.search).toBe(r.path);
    expect(w.hostname).toBe(QBO_HOST);
  });
  it('a node-quickbooks GET carries no data: undefined is allowed', () => {
    expect(name(decide({ method: 'get', url: recorded[3].url, params, data: undefined }, ctx()))).toBe('allow preferences');
  });
});

describe('own rules (A1.5)', () => {
  it.each([[P], [`${S}?enterprise=garden3d`]])('body: a body is refused, an empty one allowed (%s)', (url) => {
    expect(name(d('GET', url, ctx(), { data: '{}' }))).toBe('body');
    expect(name(d('GET', url, ctx(), { data: { a: 1 } }))).toBe('body');
    expect(name(d('GET', url, ctx(), { data: 0 }))).toBe('body');
    for (const data of [undefined, null, '']) expect(d('GET', url, ctx(), { data }).allow).toBe(true);
    expect(d('GET', url, ctx(), {}).allow).toBe(true);
  });

  it('credential-crossing: the Stacks key header to QuickBooks, a bearer to Stacks', () => {
    const t = fakeToken();
    for (const h of ['X-Api-Key', 'x-api-key', 'X-API-KEY']) {
      expect(name(d('GET', P, ctx(), { headers: { [h]: t } }))).toBe('credential-crossing');
    }
    for (const h of ['Authorization', 'authorization', 'AUTHORIZATION']) {
      expect(name(d('GET', `${S}?enterprise=garden3d`, ctx(), { headers: { [h]: t } }))).toBe('credential-crossing');
    }
    expect(name(d('GET', P, ctx(), { headers: { Authorization: 'Bearer ' + t } }))).toBe('allow preferences');
    expect(name(d('GET', `${S}?enterprise=garden3d`, ctx(), { headers: { 'X-Api-Key': t } }))).toBe('allow stacks');
    expect(name(d('GET', P, ctx(), { headers: undefined }))).toBe('allow preferences');
    // task-1 TA6: null reads as no headers; the adapter's AxiosHeaders toJSON form (null prototype) is read.
    expect(name(d('GET', P, ctx(), { headers: null as any }))).toBe('allow preferences');
    expect(name(d('GET', P, ctx(), { headers: Object.assign(Object.create(null), { 'x-api-key': t }) }))).toBe('credential-crossing');
  });

  it('credential-crossing is decided after the quickbooks rule and before body', () => {
    const h = { headers: { 'x-api-key': fakeToken() }, data: '{}' };
    expect(name(d('POST', P, ctx(), h))).toBe('quickbooks');
    expect(name(d('GET', P, ctx(), h))).toBe('credential-crossing');
    expect(name(d('POST', `${S}?enterprise=garden3d`, ctx(), { headers: { authorization: 'x' }, data: '{}' }))).toBe('stacks');
    expect(name(d('GET', `${S}?enterprise=garden3d`, ctx(), { headers: { authorization: 'x' }, data: '{}' }))).toBe('credential-crossing');
    expect(name(d('GET', `${Q}/batch?minorversion=75&format=json`, ctx(), { data: '{}' }))).toBe('body');
    expect(name(d('GET', `${Q}/batch?minorversion=75&format=json`, ctx({ allowedRealm: () => false }), {}))).toBe('quickbooks');
  });

  it.each([
    ['http://stacks.example.test'],
    ['https://user@stacks.example.test'],
    ['https://:pw@stacks.example.test'],
    ['https://stacks.example.test/x'],
    ['https://stacks.example.test/?a=1'],
    ['https://stacks.example.test/?'],
    ['https://stacks.example.test/#x'],
  ])('stacks-config: STACKS_QBO_URL %s, asked for its own host', (stacksUrl) => {
    expect(name(d('GET', `${S}?enterprise=garden3d`, ctx({ stacksUrl })))).toBe('stacks-config');
  });

  it.each([[''], ['not a url']])('stacks-config: STACKS_QBO_URL %j, asked for any non-QuickBooks host', (stacksUrl) => {
    for (const u of [`${S}?enterprise=garden3d`, 'https://example.test/x', 'data:application/json,%7B%7D']) {
      expect(name(d('GET', u, ctx({ stacksUrl })))).toBe('stacks-config');
    }
    expect(name(d('GET', P, ctx({ stacksUrl })))).toBe('allow preferences');
  });

  it('a broken but parsable STACKS_QBO_URL asked for another host is refused; none at all is refused', () => {
    expect(name(d('GET', 'https://other.example.test/x', ctx({ stacksUrl: 'http://stacks.example.test' })))).toBe('refused');
    expect(name(d('GET', `${S}?enterprise=garden3d`, ctx({ stacksUrl: undefined })))).toBe('refused');
    expect(name(d('GET', P, ctx({ stacksUrl: undefined })))).toBe('allow preferences');
  });

  it('STACKS_QBO_URL with a trailing slash or a port is the origin compared', () => {
    expect(name(d('GET', `${S}?enterprise=garden3d`, ctx({ stacksUrl: 'https://stacks.example.test/' })))).toBe('allow stacks');
    const sp = ctx({ stacksUrl: 'https://stacks.example.test:8443' });
    expect(name(d('GET', 'https://stacks.example.test:8443/api/qbo/access_token?enterprise=garden3d', sp))).toBe('allow stacks');
    expect(name(d('GET', `${S}?enterprise=garden3d`, sp))).toBe('raw-text');
  });

  it('a realm the call has not kept: every QuickBooks form refused, Stacks still allowed', () => {
    const c = ctx({ allowedRealm: () => false });
    for (const u of [`${Q}/companyinfo/${REALM}?minorversion=75&format=json`, P, P1, PNL]) expect(name(d('GET', u, c))).toBe('quickbooks');
    expect(name(d('GET', `${S}?enterprise=garden3d`, c))).toBe('allow stacks');
  });
});

describe('fail closed (A1.11)', () => {
  const boom = () => {
    throw new Error('boom');
  };
  it.each([
    ['an unparsable URL', () => d('GET', 'https://')],
    ['not a URL', () => d('GET', 'not a url')],
    ['a relative URL', () => d('GET', `/v3/company/${REALM}/preferences?minorversion=75`)],
    ['a scheme-relative URL', () => d('GET', `//quickbooks.api.intuit.com/v3/company/${REALM}/preferences`)],
    ['a missing method', () => d(undefined, P)],
    ['a missing url', () => d('GET', undefined)],
    ['a non-string method', () => decide({ method: 1 as any, url: P }, ctx())],
    ['a throwing allowedRealm', () => d('GET', P, ctx({ allowedRealm: boom }))],
    ['a throwing callRecord', () => d('GET', P, ctx({ callRecord: boom }))],
    ['a throwing keys', () => d('GET', `${S}?enterprise=garden3d`, ctx({ keys: boom }))],
    ['keys that are not an array', () => d('GET', `${S}?enterprise=garden3d`, ctx({ keys: () => 'garden3d' as any }))],
    ['array params', () => d('GET', `${Q}/preferences`, ctx(), { params: ['minorversion', '75'] })],
    ['URLSearchParams params', () => d('GET', `${Q}/preferences`, ctx(), { params: new URLSearchParams('minorversion=75') })],
    ['string params', () => d('GET', `${Q}/preferences`, ctx(), { params: 'minorversion=75' })],
    ['an object param value', () => d('GET', `${Q}/preferences`, ctx(), { params: { minorversion: { a: 1 } } })],
    ['an undefined param value', () => d('GET', `${Q}/preferences`, ctx(), { params: { minorversion: undefined } })],
    ['a null param value', () => d('GET', `${Q}/preferences`, ctx(), { params: { minorversion: null } })],
    ['a class-instance params', () => d('GET', `${Q}/preferences`, ctx(), { params: new (class { minorversion = 75 })() })],
    ['headers that are not an object', () => d('GET', P, ctx(), { headers: 'x-api-key: 1' as any })],
    // task-1 TA6: axios would send these forms; decide reads only a plain object, so it refuses the rest.
    ['Map headers', () => d('GET', P, ctx(), { headers: new Map([['x-api-key', fakeToken()]]) as any })],
    ['pair-array headers', () => d('GET', P, ctx(), { headers: [['x-api-key', fakeToken()]] as any })],
    ['pair-array headers on Stacks', () => d('GET', `${S}?enterprise=garden3d`, ctx(), { headers: [['authorization', 'x']] as any })],
    ['class-instance headers', () => d('GET', P, ctx(), { headers: new (class { a = '1' })() as any })],
    // task-1 TA7: a record that is not a record is a fault, not "inside a call".
    ['a null call record', () => d('GET', P, ctx({ callRecord: () => null as any }))],
    ['a 0 call record', () => d('GET', P, ctx({ callRecord: () => 0 as any }))],
    ['a call record without a queries array', () => d('GET', P, ctx({ callRecord: () => ({ queries: 'x' }) as any }))],
    // task-1 TA8: keys axios would compose differently (it trims keys and drops an own __proto__).
    ['a param key with a leading space', () => d('GET', `${Q}/preferences`, ctx(), { params: { ' minorversion': 75 } })],
    ['a param key with a trailing space', () => d('GET', `${Q}/preferences`, ctx(), { params: { 'minorversion ': 75 } })],
    ['an own __proto__ param key', () => d('GET', `${Q}/preferences`, ctx(), { params: JSON.parse('{"__proto__":"x","minorversion":75}') })],
  ])('%s is guard-error', (_what, run) => {
    expect(name(run())).toBe('guard-error');
  });
});

describe('order (spec X2)', () => {
  it('with STACKS_QBO_URL empty: relative is guard-error, a dot segment dot-segments, a third host stacks-config', () => {
    const c = ctx({ stacksUrl: '' });
    expect(name(d('GET', '/x', c))).toBe('guard-error');
    expect(name(d('GET', 'https://h/a/../b', c))).toBe('dot-segments');
    expect(name(d('GET', 'https://h/x', c))).toBe('stacks-config');
  });
  it('raw-text comes before dot-segments, and both before any host rule', () => {
    expect(name(d('GET', 'https://h/a/../b#x', ctx({ stacksUrl: '' })))).toBe('raw-text');
    expect(name(d('POST', `${Q}/./preferences?minorversion=75`))).toBe('dot-segments');
  });
});

describe('serialiser matches axios', () => {
  const require = createRequire(import.meta.url);
  const axios = createRequire(require.resolve('node-quickbooks'))('axios');
  const getUri = (url: string, params?: unknown) => axios.getUri({ url, params });
  const pairs: Array<[string, unknown]> = [
    ...EX.examples.filter((r: any) => r.decision === 'allow').map((r: any) => [r.url, undefined] as [string, unknown]),
    [`${Q}/query?query=select * from purchase where PaymentType %3D %27Cash%5C%27s%27 startposition 1 maxresults 10`, { minorversion: 75, format: 'json' }],
    [`${Q}/reports/ProfitAndLoss?start_date=2026-01-01&end_date=2026-03-31&accounting_method=Cash&`, { minorversion: 75, format: 'json' }],
    [`${Q}/companyinfo/${REALM}`, { minorversion: 75, format: 'json' }],
    [`${Q}/preferences`, { minorversion: 75, format: 'json' }],
    [`${Q}/preferences`, {}],
    [`${Q}/preferences`, null],
    [`${Q}/preferences#frag`, { minorversion: 75 }],
    [`${Q}/preferences#frag`, {}],
    [`${Q}/reports/ProfitAndLoss`, { start_date: '2026-01-01', 'a b': 'c d', x: "!'()*~:$,@/?&=+%", y: true, z: 0, '2': 'two', '1': 'one' }],
    [`${Q}/preferences?minorversion=75`, { format: 'json' }],
    [`${Q}/preferences`, Object.assign(Object.create(null), { minorversion: 75 })],
    // task-1 TA1: an allowed text whose params hold each character the encoder keeps or rewrites (`:`, `$`, `,`, space).
    [`${Q}/reports/ProfitAndLoss`, { start_date: 'a:b$c,d e/@', minorversion: 75 }],
    [`${Q}/reports/ProfitAndLoss`, { start_date: 'a:b', minorversion: 75 }],
    [`${Q}/reports/ProfitAndLoss`, { start_date: 'a$b', minorversion: 75 }],
    [`${Q}/reports/ProfitAndLoss`, { start_date: 'a,b', minorversion: 75 }],
    [`${Q}/reports/ProfitAndLoss`, { start_date: 'a b', minorversion: 75 }],
  ];
  it('the TA1 cases are allowed, so their text is compared (not only their rule)', () => {
    for (const [url, params] of pairs.slice(-5)) expect(name(decide({ method: 'GET', url, params }, ctx()))).toBe('allow reports');
    expect(decide({ method: 'GET', url: `${Q}/reports/ProfitAndLoss`, params: { start_date: 'a:b$c,d e/@', minorversion: 75 } }, ctx())).toMatchObject({
      text: `${Q}/reports/ProfitAndLoss?start_date=a:b$c,d+e%2F%40&minorversion=75`,
    });
  });
  it.each(pairs.map((p, i) => [i, p[0], p[1]]))('%i: text equals axios.getUri, url equals new URL(text).href', (_i, url, params) => {
    const dec = decide({ method: 'GET', url: url as string, params }, ctx());
    const text = getUri(url as string, params);
    if (dec.allow) {
      expect(dec.text).toBe(text);
      expect(dec.url).toBe(new URL(text).href);
    } else {
      // refused texts still compose the same: re-decide the composed text with no params and compare the rule
      expect(name(decide({ method: 'GET', url: text }, ctx()))).toBe(name(dec));
    }
  });
});

describe('REPORT_KEYS', () => {
  it('holds the 11 reports of contract §6 with their keys', () => {
    expect(Object.keys(REPORT_KEYS).sort()).toEqual([
      'AgedPayables', 'AgedReceivables', 'BalanceSheet', 'CashFlow', 'CustomerBalance', 'CustomerSales',
      'GeneralLedger', 'ProfitAndLoss', 'TrialBalance', 'VendorBalance', 'VendorExpenses',
    ]);
    expect(REPORT_KEYS.ProfitAndLoss).toEqual(['accounting_method', 'class', 'customer', 'department', 'end_date', 'item', 'start_date', 'summarize_column_by', 'vendor']);
    expect(REPORT_KEYS.GeneralLedger).toEqual(['account', 'accounting_method', 'end_date', 'sort_by', 'source_account', 'start_date']);
    expect(Object.isFrozen(REPORT_KEYS)).toBe(true);
  });
  it.each(Object.keys(REPORT_KEYS).map((k) => [k]))('every key of %s is allowed on it', (report) => {
    const q = (REPORT_KEYS as Record<string, readonly string[]>)[report].map((k) => `${k}=v`).join('&');
    expect(name(d('GET', `${Q}/reports/${report}?${q}${TAIL}`))).toBe('allow reports');
  });
});

describe('task-1 review: cases only one condition decides (TA2-TA5, TA7, TA9)', () => {
  it.each([
    // TA2: a trailing space inside the query pair (the pair rule allows it; new URL would strip it, so the sent URL differs).
    ['TA2', `${Q}/query?minorversion=75&format=json&query=select * from purchase maxresults 10 `, 'raw-text'],
    // TA3: maxresults needs whitespace before its number.
    ['TA3', lq('select * from purchase maxresults10'), 'query'],
    // TA4: `from` is a word: `_` or a digit on either side makes it part of another word.
    ['TA4', lq('select * from purchase where x_from = 1 maxresults 10'), 'allow query'],
    ['TA4', lq('select * from purchase where a1from = 1 maxresults 10'), 'allow query'],
    ['TA4', lq('select * from purchase where from1 = 1 maxresults 10'), 'allow query'],
    // TA5: entity-by-id is the whole rest, and report keys apply only under reports/.
    ['TA5', `${Q}/x/purchase/5?minorversion=75`, 'refused'],
    ['TA5', `${Q}/x/ProfitAndLoss?start_date=1&minorversion=75`, 'quickbooks'],
  ] as Array<[string, string, string]>)('%s: GET %s → %s', (_id, url, expected) => {
    expect(name(d('GET', url))).toBe(expected);
  });

  it('TA4: the entity is read after the one `from` word', () => {
    const dec = d('GET', lq('select * from purchase where a1from = 1 maxresults 10'));
    expect(dec.allow && dec.entity).toBe('purchase');
  });

  it('TA5: a 21-digit realm is not a realm, even when allowedRealm would accept it', () => {
    const realm21 = '1'.repeat(21);
    const c = ctx({ allowedRealm: () => true });
    expect(name(d('GET', `https://quickbooks.api.intuit.com/v3/company/${realm21}/preferences?minorversion=75`, c))).toBe('quickbooks');
    const realm20 = '1'.repeat(20);
    expect(name(d('GET', `https://quickbooks.api.intuit.com/v3/company/${realm20}/preferences?minorversion=75`, c))).toBe('allow preferences');
  });

  it.each([
    ['a Promise', () => Promise.resolve(true)],
    ['1', () => 1],
    ['"yes"', () => 'yes'],
  ] as Array<[string, () => unknown]>)('TA7: allowedRealm answering %s allows no realm', (_what, answer) => {
    expect(name(d('GET', P, ctx({ allowedRealm: answer as any })))).toBe('quickbooks');
  });

  it('TA9: an entry after a 401 with another URL is not a resend, so a later resend of it is still the call\'s one', () => {
    const a = lq('select * from purchase maxresults 10');
    const b = lq('select * from purchase maxresults 20');
    const record: CallRecord = {
      queries: [
        { entity: 'purchase', url: new URL(a).href, status: 401 },
        { entity: 'purchase', url: new URL(b).href, status: 401 },
      ],
    };
    const dec = d('GET', b, ctx({}, record));
    expect(name(dec)).toBe('allow query');
    expect(dec.allow && dec.resend).toBe(401);
  });
});
