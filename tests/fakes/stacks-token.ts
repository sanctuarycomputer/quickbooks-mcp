// Sanctuary Computer (quickbooks-mcp-286): a fake Stacks token endpoint for 291's stub network; serves the copied stacks-token/ fixtures.
// Each fixture file served is logged with the running test's name, so a named case can show it served its files (A1.8).
import { expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import type { StubAnswer, StubCall, StubTable } from './stub-network.js';

const DIR = fileURLToPath(new URL('./stacks-token/', import.meta.url));

/** Each copied stacks-token/ file and the check that serves it (A1.8; usb-club is also A3.4). */
export const SERVED_STACKS_FIXTURES: Record<string, string> = {
  '200-garden3d.json': 'A1.1',
  '200-sanctuary-computer.json': 'A4.9',
  '200-index-space.json': 'A4.9',
  '200-usb-club.json': 'A4.9',
  '403.json': 'A1.5',
  '404.json': 'A1.5',
  '409.json': 'A1.5',
  '502-invalid_grant.json': 'A1.5',
  '502-proxy.json': 'A1.5',
  '502-unavailable.json': 'A1.5',
};

/** An answer: a fixture file name, or a status/headers/body object (no `body` sends `{}`, `body: ''` an empty answer). */
export type StacksAnswer = string | { status: number; headers?: Record<string, string>; body?: unknown };
/**
 * A sequence step: an answer, an answer sent only once `hold` resolves, a failed connection, or no answer ever.
 * (T5, T1-1: A1.3b holds one fetch while a second is made.)
 */
export type StacksStep = StacksAnswer | { answer: StacksAnswer; hold: Promise<unknown> } | { refuse: 'reset' | 'refused' } | { hang: true };
export type StacksFakeOpts = {
  /** enterprise key -> fixture file name; a key not listed gets 200-<key>.json when that file exists, else 404.json */
  byKey?: Record<string, string>;
  /** steps in order (StacksStep: an answer, a held answer, a refusal or a hang); the last one repeats */
  sequence?: StacksStep[];
  /** never answer */
  hang?: boolean;
  /** fail the connection instead of answering */
  refuse?: 'reset' | 'refused';
  /** overrides the status of every answer */
  status?: number;
  /** replaces the headers of every answer */
  headers?: Record<string, string>;
};

export function stacksFixture(file: string): { status: number; headers: Record<string, string>; body: unknown } {
  return JSON.parse(readFileSync(DIR + file, 'utf8'));
}

/** Each fixture file this module's fakes served, with the test running then ('' outside a test). One log per test file. */
export const servedLog: Array<{ file: string; test: string }> = [];

/** True when jest was given a name filter (`-t`): jest-circus keeps it on its state, under its unregistered symbol. */
function nameFiltered(): boolean {
  const sym = Object.getOwnPropertySymbols(globalThis).find((x) => x.description === 'JEST_STATE_SYMBOL');
  if (sym === undefined) throw new Error("jest-circus' state isn't on globalThis");
  const pattern = (globalThis as Record<symbol, { testNamePattern?: RegExp | null }>)[sym].testNamePattern;
  return pattern !== null && pattern !== undefined;
}

/**
 * A1.8's named case: each of `files` was served by this test file's fakes inside a test whose full name holds `check`
 * (its describe's title or its own). For an afterAll; skipped under a name filter, when the named tests may not run.
 */
export function expectServedBy(check: string, files: string[]): void {
  if (nameFiltered()) return;
  for (const file of files) expect({ check, file, served: servedLog.some((s) => s.file === file && s.test.includes(check)) }).toEqual({ check, file, served: true });
}

function answerOf(step: StacksAnswer, opts: StacksFakeOpts): StubAnswer {
  if (typeof step === 'string') servedLog.push({ file: step, test: expect.getState().currentTestName ?? '' });
  const f = typeof step === 'string' ? stacksFixture(step) : { headers: {}, ...step };
  const body = f.body;
  return {
    status: opts.status ?? f.status,
    headers: opts.headers ?? f.headers,
    // A string body is sent as-is, an object as JSON.
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

export function enterpriseOf(call: StubCall): string {
  return new URL(call.path ?? '/', 'https://stacks.invalid').searchParams.get('enterprise') ?? '';
}

const refusal = (refuse: 'reset' | 'refused'): Promise<never> => {
  const code = refuse === 'reset' ? 'ECONNRESET' : 'ECONNREFUSED';
  return Promise.reject(Object.assign(new Error(`connect ${code}`), { code }));
};

function stepOf(step: StacksStep, opts: StacksFakeOpts): StubAnswer | Promise<StubAnswer> {
  if (typeof step === 'object' && 'hang' in step) return new Promise<StubAnswer>(() => {});
  if (typeof step === 'object' && 'refuse' in step) return refusal(step.refuse);
  if (typeof step === 'object' && 'hold' in step) return step.hold.then(() => answerOf(step.answer, opts));
  return answerOf(step, opts);
}

export function stacksFake(opts: StacksFakeOpts = {}): { handler: StubTable; requests: StubCall[] } {
  const requests: StubCall[] = [];
  const handler: StubTable = (call) => {
    requests.push(call);
    if (opts.hang) return new Promise<StubAnswer>(() => {});
    if (opts.refuse) return refusal(opts.refuse);
    if (opts.sequence) return stepOf(opts.sequence[Math.min(requests.length - 1, opts.sequence.length - 1)], opts);
    const key = enterpriseOf(call);
    const own = `200-${key}.json`;
    return answerOf(opts.byKey?.[key] ?? (own in SERVED_STACKS_FIXTURES ? own : '404.json'), opts);
  };
  return { handler, requests };
}
