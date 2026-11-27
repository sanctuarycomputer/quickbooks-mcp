// Sanctuary Computer (quickbooks-mcp-294): the fake receipt command as a test drives it (spec §4). Each fake gets its own temp
// directory holding its script and log; `cmd` is the QBO_WRITE_RECEIPT_CMD value that runs it, with node's own path first, so nothing
// rests on PATH. `done()` appends every logged request, marked malformed or not, to the file RECEIPT_REPLAY_LOG names (A4.4's collector).
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

export type Step = string | { answer: unknown } | { misbehave: string; value?: unknown; text?: string };
export type FakeScript = Partial<Record<'intent' | 'outcome' | 'lookup' | 'pending' | 'ping' | '*', Step[]>>;
export type Logged = { request: unknown; env: Record<string, string> };

export const FAKE_PATH = fileURLToPath(new URL('../fakes/receipt-cmd.mjs', import.meta.url));
const VECTORS = new URL('../fakes/receipt-cmd/', import.meta.url);

/** A receipt-cmd/ vector, parsed. */
export const vector = (name: string): Record<string, any> => JSON.parse(readFileSync(fileURLToPath(new URL(name, VECTORS)), 'utf8'));

export function receiptFake(answers: FakeScript = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qbo-receipt-fake-'));
  const log = join(dir, 'log.jsonl');
  const scriptPath = join(dir, 'script.json');
  writeFileSync(scriptPath, JSON.stringify({ log, answers }));
  const malformed = new Set<string>();
  const read = (): Logged[] => {
    try {
      return readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Logged);
    } catch {
      return [];
    }
  };
  return {
    dir,
    cmd: `${process.execPath} ${FAKE_PATH} ${scriptPath}`,
    argv: [process.execPath, FAKE_PATH, scriptPath],
    log: read,
    requests: (): unknown[] => read().map((entry) => entry.request),
    /** Marks a request the test sends malformed on purpose, by its text. */
    malformed(request: unknown): void {
      malformed.add(JSON.stringify(request));
    },
    done(): void {
      const out = process.env.RECEIPT_REPLAY_LOG;
      if (out !== undefined && out !== '') {
        for (const { request } of read()) {
          if (request !== null) appendFileSync(out, JSON.stringify({ request, malformed: malformed.has(JSON.stringify(request)) }) + '\n');
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
