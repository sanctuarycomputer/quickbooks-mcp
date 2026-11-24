// Sanctuary Computer (quickbooks-mcp-293): 297's transactions/ as the pre-send tests read them, and the few shapes it doesn't hold, each
// built from one of its files by a helper that changes only what it names.
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import type { Change } from '../../src/write/compare.js';

export type Json = Record<string, any>;
const DIR = new URL('../fakes/transactions/', import.meta.url);
/** A fresh copy of one file. */
export const fixture = (rel: string): Json => JSON.parse(readFileSync(fileURLToPath(new URL(rel, DIR)), 'utf8'));
/** Each file of one directory, by its entity's `Id`. */
export const byId = (dir: string): Map<string, Json> =>
  new Map(readdirSync(fileURLToPath(new URL(`${dir}/`, DIR))).map((name) => fixture(`${dir}/${name}`)).map((body) => [entityOf(body).Id, body]));
export const entityOf = (answer: Json): Json => Object.entries(answer).find(([key]) => key !== 'time')![1];

/** A 297 case as `preSend` takes it: a categorize call's own lines, or an undo's `before` values. */
export function asInput(name: string): { input: Json & { lines: Change[] }; fetched: string; expected: Json } {
  const file = fixture(`cases/${name}.json`);
  const undo = file.intent !== null;
  const fetched = file.fetched.replace('docs/contracts/quickbooks/transactions/', '');
  const answer = fixture(fetched);
  const lines: Change[] = undo ? file.intent.lines.map((line: Json) => ({ line_id: line.line_id, ...line.before })) : file.params.lines;
  const input = { company: 'garden3d', entity: answer.Purchase ? 'purchase' : 'bill', id: entityOf(answer).Id, mode: undo ? 'undo' : 'categorize', lines };
  return { input, fetched, expected: file };
}

/** The answer's transaction with `n` copies of its first line, ids `1` to `n`. */
export function withLines(answer: Json, n: number): Json {
  const txn = entityOf(answer);
  txn.Line = Array.from({ length: n }, (_, i) => ({ ...JSON.parse(JSON.stringify(txn.Line[0])), Id: String(i + 1) }));
  return answer;
}
/** `n` changes of lines `1` to `n` to one account. */
export const changesOf = (n: number, account_id = '84'): Change[] => Array.from({ length: n }, (_, i) => ({ line_id: String(i + 1), account_id }));
/** The answer's last line with no `Id`. */
export function withoutId(answer: Json): Json {
  delete entityOf(answer).Line.at(-1).Id;
  return answer;
}
/** The answer's last line sharing the first one's `Id`. */
export function sharedId(answer: Json): Json {
  const { Line } = entityOf(answer);
  Line.at(-1).Id = Line[0].Id;
  return answer;
}
