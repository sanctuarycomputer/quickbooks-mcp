// Sanctuary Computer (quickbooks-mcp-286): A5.11's paging through the started server. The stub holds 2,500 rows and
// answers each query by its decoded startposition and maxresults; following each `truncated` marker's next offset until
// a result has none reads every row exactly once, none repeated or skipped, for search_purchases (a top-level offset),
// search_classes (the new top-level offset, A5.13) and search_invoices (offset inside criteria).
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { QBO_HOST, installNetwork, startServer, type Rig } from '../helpers/server.js';

const network = installNetwork();
const { net } = network;

const TOTAL = 2500;
/** 2,500 rows, built once: each renders to one line of about 120 characters, so every 1,000-row page is cut. */
const ROWS: Array<{ Id: string; Memo: string }> = [];
const MARKER = /^truncated: ([1-9][0-9]*) of ([1-9][0-9]*) rows left out\. Next page: pass offset ([1-9][0-9]*)( inside criteria)?\.$/;

let rig: Rig;
beforeAll(async () => {
  for (let i = 1; i <= TOTAL; i++) ROWS.push({ Id: String(i), Memo: `row ${i} `.padEnd(100, '.') });
  rig = await startServer({ qbo: { rows: ROWS } });
});
afterAll(async () => {
  await rig.close();
  expect(network.trap.reached).toEqual([]);
  network.restore();
});

/** A query's startposition and maxresults, decoded from the request the stub saw. */
function page(path: string): [number, number] {
  const q = new URL(path, 'https://quickbooks.invalid').searchParams.get('query') ?? '';
  const m = / startposition ([0-9]+) maxresults ([0-9]+)$/i.exec(q);
  if (m === null) throw new Error(`no page in ${q}`);
  return [Number(m[1]), Number(m[2])];
}

const CASES: Array<[string, (offset: number | undefined) => Record<string, unknown>, boolean]> = [
  ['search_purchases', (o) => (o === undefined ? {} : { offset: o }), false],
  ['search_classes', (o) => (o === undefined ? {} : { offset: o }), false],
  ['search_invoices', (o) => ({ criteria: o === undefined ? {} : { offset: o } }), true],
];

describe('A5.11: following the next offset reads 2,500 rows exactly once', () => {
  it.each(CASES)('%s', async (tool, paramsFor, inside) => {
    const seen: string[] = [];
    const offsets: number[] = [];
    let offset: number | undefined;
    for (let calls = 0; calls < 50; calls++) {
      net.calls.length = 0;
      const out: any = await rig.client.callTool({ name: tool, arguments: { company: 'garden3d', params: paramsFor(offset) } });
      expect(out.isError).toBeUndefined();
      expect(out.content).toHaveLength(1);
      const queries = net.calls.filter((c) => c.hostname === QBO_HOST && (c.path ?? '').includes('/query?'));
      expect(queries).toHaveLength(1);
      // The request starts where the last marker said, 1 when none was given; the 1,000-row cap is the request's.
      expect(page(queries[0].path ?? '')).toEqual([offset ?? 1, 1000]);
      const lines: string[] = out.content[0].text.split('\n');
      const marker = MARKER.exec(lines[0]);
      const rows = (marker ? lines.slice(1) : lines).map((l) => JSON.parse(l));
      for (const r of rows) seen.push(r.Id);
      if (marker === null) break;
      expect(out.content[0].text.length).toBeLessThanOrEqual(30000);
      expect([marker[4] !== undefined, Number(marker[2]), Number(marker[2]) - Number(marker[1])]).toEqual([inside, Math.min(1000, TOTAL - (offset ?? 1) + 1), rows.length]);
      // <o> is the offset used plus the rows kept.
      expect(Number(marker[3])).toBe((offset ?? 1) + rows.length);
      offset = Number(marker[3]);
      offsets.push(offset);
    }
    expect(seen).toEqual(ROWS.map((r) => r.Id));
    expect(new Set(seen).size).toBe(TOTAL);
    // Many pages, each cut: at least nine calls for 2,500 rows of this size.
    expect(offsets.length).toBeGreaterThanOrEqual(8);
  });
});
