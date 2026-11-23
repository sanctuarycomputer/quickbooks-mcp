// Sanctuary Computer (quickbooks-mcp-286): a fake QuickBooks Online API for 291's stub network.
import type { StubAnswer, StubCall, StubTable } from './stub-network.js';

export type QuickbooksAnswer = { status: number; headers?: Record<string, string>; body?: unknown };
export type QuickbooksFakeOpts = {
  /** realm id -> the CompanyInfo object served at /companyinfo/<realm> */
  companyInfo?: Record<string, object>;
  /** scripted answers, used first, one per request, in order */
  answers?: QuickbooksAnswer[];
  /** rows served by a query's startposition and maxresults (the entity is the one after `from`) */
  rows?: object[];
  /** served at /reports/... */
  report?: object;
  /** every answer waits for this */
  holdUntil?: Promise<void>;
  /** fail the connection instead of answering */
  fail?: 'reset' | 'refused' | 'tls';
};

const FAIL_CODES = { reset: 'ECONNRESET', refused: 'ECONNREFUSED', tls: 'CERT_HAS_EXPIRED' } as const;

const json = (status: number, body: unknown): StubAnswer => ({ status, body: JSON.stringify(body) });

export function quickbooksFake(opts: QuickbooksFakeOpts = {}): { handler: StubTable; requests: StubCall[] } {
  const requests: StubCall[] = [];
  let scripted = 0;
  const handler: StubTable = async (call) => {
    requests.push(call);
    if (opts.holdUntil) await opts.holdUntil;
    if (opts.fail) {
      const code = FAIL_CODES[opts.fail];
      throw Object.assign(new Error(opts.fail === 'tls' ? `certificate has expired (${code})` : `connect ${code}`), { code });
    }
    if (opts.answers && scripted < opts.answers.length) {
      const a = opts.answers[scripted++];
      return {
        status: a.status,
        headers: a.headers,
        body: typeof a.body === 'string' || a.body === undefined ? (a.body as string | undefined) : JSON.stringify(a.body),
      };
    }
    const url = new URL(call.path ?? '/', 'https://quickbooks.invalid');
    const parts = url.pathname.split('/'); // '', 'v3', 'company', realm, kind, ...
    const kind = parts[4];
    if (kind === 'companyinfo') {
      const info = opts.companyInfo?.[parts[3]];
      return info ? json(200, { CompanyInfo: info, time: '2026-11-18T00:00:00.000Z' }) : json(404, { Fault: { Error: [{ Message: 'not found' }] } });
    }
    if (kind === 'reports') return json(200, opts.report ?? {});
    if (kind === 'query') {
      const q = url.searchParams.get('query') ?? '';
      const start = Number(/startposition\s+(\d+)/i.exec(q)?.[1] ?? 1);
      const max = Number(/maxresults\s+(\d+)/i.exec(q)?.[1] ?? 100);
      const entity = /from\s+(\w+)/i.exec(q)?.[1] ?? 'Entity';
      const page = (opts.rows ?? []).slice(start - 1, start - 1 + max);
      const name = entity.charAt(0).toUpperCase() + entity.slice(1);
      return json(200, { QueryResponse: page.length ? { [name]: page, startPosition: start, maxResults: page.length } : {}, time: '2026-11-18T00:00:00.000Z' });
    }
    return json(404, { Fault: { Error: [{ Message: 'not found' }] } });
  };
  return { handler, requests };
}
