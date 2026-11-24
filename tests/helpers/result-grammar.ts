// Sanctuary Computer (quickbooks-mcp-286): contract 1.1 §5's Result grammar for an error, whole, for the tests that read
// a result's header (T12-3: not name-results.test.ts' parseHeader, which reads only name-mismatch and a lone reason).
// Every header line is `<key>: <value>` with a non-empty value, its keys in the table's order (reason, source, reported,
// intuit_tid), each at most once and none outside it; `reason` first, one of the fork's codes; `source` and `reported`
// with name-mismatch and only there; `intuit_tid` only with http-<status> and timeout; an empty line ends the block;
// every later item is a WARNING: of at most 2,000 code units.

/** The Result grammar's `reason` codes with origin `fork`. */
export const REASON = /^(name-mismatch|not-connected|unknown-enterprise|renewal-failed:[A-Za-z0-9_-]{1,64}|stacks-auth|stacks-unreachable|http-[0-9]{3}|fork-error|timeout)$/;
const TID = /^[A-Za-z0-9-]{1,64}$/;
const KEYS = ['reason', 'source', 'reported', 'intuit_tid'] as const;
type Key = (typeof KEYS)[number];
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export type ErrorReading = { reason: string; source?: string; reported?: string; intuit_tid?: string; free: string; warnings: string[] };

/** An error result read by the Result grammar; throws, naming the break, on anything the grammar refuses. */
export function readError(result: unknown): ErrorReading {
  const r = result as { isError?: unknown; content?: Array<{ type?: unknown; text?: unknown }> };
  if (r?.isError !== true) throw new Error('not an error: isError is not true');
  const items = r.content ?? [];
  if (items.length === 0) throw new Error('no content');
  for (const it of items) if (it.type !== 'text' || typeof it.text !== 'string') throw new Error('an item is not text');
  const [first, ...rest] = items.map((it) => it.text as string);
  const lines = first.split('\n');
  const blank = lines.indexOf('');
  if (blank < 1) throw new Error(blank === 0 ? 'no header line' : 'no empty line ends the header block');
  const header: Partial<Record<Key, string>> = {};
  let at = -1;
  for (const line of lines.slice(0, blank)) {
    const colon = line.indexOf(': ');
    const key = line.slice(0, colon) as Key;
    const value = line.slice(colon + 2);
    const index = KEYS.indexOf(key);
    if (colon < 1 || index < 0) throw new Error(`not a header line: ${JSON.stringify(line)}`);
    if (index <= at) throw new Error(`${key} out of order or repeated`);
    if (value === '') throw new Error(`${key} has an empty value`);
    at = index;
    header[key] = value;
  }
  const { reason, source, reported, intuit_tid } = header;
  // The keys are in the table's order, so a reason present is the first line.
  if (reason === undefined) throw new Error('no reason line');
  if (!REASON.test(reason)) throw new Error(`unknown reason ${reason}`);
  const mismatch = reason === 'name-mismatch';
  if (mismatch !== (source !== undefined) || mismatch !== (reported !== undefined)) throw new Error('source and reported go with name-mismatch, and only there');
  if (source !== undefined && source !== 'stacks' && source !== 'quickbooks') throw new Error(`source ${source}`);
  if (reported !== undefined && (reported !== reported.trim() || CONTROL.test(reported) || Array.from(reported).length > 200)) {
    throw new Error(`reported is not a name after the name rule: ${JSON.stringify(reported)}`);
  }
  if (intuit_tid !== undefined && !(reason.startsWith('http-') || reason === 'timeout')) throw new Error('intuit_tid only with http-<status> and timeout');
  if (intuit_tid !== undefined && !TID.test(intuit_tid)) throw new Error(`intuit_tid ${intuit_tid}`);
  for (const w of rest) if (!w.startsWith('WARNING:') || w.length > 2000) throw new Error('an item after the first is not a WARNING: of at most 2,000');
  return { ...header, reason, free: lines.slice(blank + 1).join('\n'), warnings: rest };
}
