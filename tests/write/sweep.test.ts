// Sanctuary Computer (quickbooks-mcp-294): spec A2.10 at the reader, contract §19 Sweep reader, row by row, from 292's sweep-stamp/ files
// (copied whole, tests/fakes/manifest.json) and stamps derived from clean.json, at wall 2026-11-18T15:00:00.000Z.
import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readSweep } from '../../src/write/sweep.js';

const STAMPS = join(dirname(fileURLToPath(import.meta.url)), '..', 'fakes', 'sweep-stamp');
const NOW = Date.parse('2026-11-18T15:00:00.000Z');
const at = (iso: string) => () => Date.parse(iso);
const DIR = mkdtempSync(join(tmpdir(), 'qbo-sweep-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

let n = 0;
/** A stamp file holding `text`, in this suite's temp directory. */
const file = (text: string): string => {
  const p = join(DIR, `stamp-${n++}.json`);
  writeFileSync(p, text);
  return p;
};
const fixture = (name: string): string => join(STAMPS, name);
const clean = (): Record<string, unknown> => JSON.parse(readFileSync(fixture('clean.json'), 'utf8'));
const derived = (over: Record<string, unknown>, drop: string[] = []): string => {
  const stamp = { ...clean(), ...over };
  for (const k of drop) delete stamp[k];
  return file(JSON.stringify(stamp));
};
const wall = () => NOW;

describe('readSweep: the fixtures at 15:00:00.000Z', () => {
  it.each(['clean.json', 'boundary-20m.json', 'boundary-60s.json'])('%s passes', async (name) => {
    expect(await readSweep(fixture(name), wall)).toBe(true);
  });
  it.each([
    ['stale.json', 'step 6, 20:00.001 old'],
    ['unclean.json', 'step 5'],
    ['malformed.json', 'step 2, clean a string'],
    ['negative-jobs.json', 'step 2, jobs -1'],
    ['reason-with-clean.json', 'step 2, a reason with clean true'],
    ['bad-at.json', 'step 2, not a time'],
    ['bad-at-no-millis.json', 'step 2, parses but fails the round trip'],
    ['v2.json', 'step 3'],
    ['future.json', 'step 4, 5 minutes ahead'],
    ['future-60001ms.json', 'step 4, 60.001 s ahead'],
  ])('%s refuses (%s)', async (name) => {
    expect(await readSweep(fixture(name), wall)).toBe(false);
  });
  it('clean.json at 15:11:00.000Z (21 minutes old) refuses; at 15:10:00.000Z (20:00 exactly) passes', async () => {
    expect(await readSweep(fixture('clean.json'), at('2026-11-18T15:11:00.000Z'))).toBe(false);
    expect(await readSweep(fixture('clean.json'), at('2026-11-18T15:10:00.000Z'))).toBe(true);
    expect(await readSweep(fixture('clean.json'), at('2026-11-18T15:10:00.001Z'))).toBe(false);
  });
  it('the 60 s edge, by the clock: clean.json at 14:49:00.000Z passes, at 14:48:59.999Z refuses', async () => {
    expect(await readSweep(fixture('clean.json'), at('2026-11-18T14:49:00.000Z'))).toBe(true);
    expect(await readSweep(fixture('clean.json'), at('2026-11-18T14:48:59.999Z'))).toBe(false);
  });
  it('the clock is asked, not Date.now', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:00.000Z'));
    expect(await readSweep(fixture('clean.json'), wall)).toBe(true);
    jest.restoreAllMocks();
  });
});

describe('readSweep: step 1, missing or unreadable', () => {
  it('a missing file refuses', async () => {
    expect(await readSweep(join(DIR, 'nowhere.json'), wall)).toBe(false);
  });
  it('a directory at the path refuses', async () => {
    const d = join(DIR, 'a-dir');
    mkdirSync(d);
    expect(await readSweep(d, wall)).toBe(false);
  });
  it('an empty path refuses', async () => {
    expect(await readSweep('', wall)).toBe(false);
  });
  it('a clock that answers NaN refuses (no comparison with NaN passes a stamp)', async () => {
    expect(await readSweep(fixture('clean.json'), () => Number.NaN)).toBe(false);
  });
  it('a clock that throws refuses', async () => {
    expect(
      await readSweep(fixture('clean.json'), () => {
        throw new Error('clock');
      }),
    ).toBe(false);
  });
});

describe('readSweep: step 2, the shape, each case decided by its rule alone (derived from clean.json)', () => {
  it('the derivation itself passes', async () => {
    expect(await readSweep(derived({}), wall)).toBe(true);
  });
  it.each<[string, string]>([
    ['not JSON', '{"v":1,'],
    ['JSON null', 'null'],
    ['a JSON array', '[1]'],
    ['a JSON string', '"clean"'],
    ['empty', ''],
  ])('%s refuses', async (_name, text) => {
    expect(await readSweep(file(text), wall)).toBe(false);
  });
  it.each<[string, Record<string, unknown>, string[]]>([
    ['jobs missing', {}, ['jobs']],
    ['v missing', {}, ['v']],
    ['at missing', {}, ['at']],
    ['clean missing', {}, ['clean']],
    ['an extra key', { extra: 1 }, []],
    ['unclean with no reason', { clean: false }, []],
    ['unclean with an empty reason', { clean: false, reason: '' }, []],
    ['unclean with a reason that is not a string', { clean: false, reason: 7 }, []],
    ['jobs 1.5', { jobs: 1.5 }, []],
    ['jobs a string', { jobs: '7' }, []],
    ['v a string', { v: '1' }, []],
    ['at a number', { at: NOW - 600_000 }, []],
    ['clean null', { clean: null }, []],
  ])('%s refuses', async (_name, over, drop) => {
    expect(await readSweep(derived(over, drop), wall)).toBe(false);
  });
  it('jobs 0 passes; an unclean stamp with a reason is the right shape and refuses at step 5 alone', async () => {
    expect(await readSweep(derived({ jobs: 0 }), wall)).toBe(true);
    const unclean = derived({ clean: false, reason: 'report' });
    expect(await readSweep(unclean, wall)).toBe(false);
    expect(await readSweep(derived({ clean: true }), wall)).toBe(true);
  });
  it('v 1.0 in the text is 1', async () => {
    expect(await readSweep(file('{"v":1.0,"at":"2026-11-18T14:50:00.000Z","clean":true,"jobs":7}'), wall)).toBe(true);
  });
  it('a key inherited, not own, is not there: __proto__ JSON key is an extra key', async () => {
    expect(await readSweep(file('{"v":1,"at":"2026-11-18T14:50:00.000Z","clean":true,"jobs":7,"__proto__":{}}'), wall)).toBe(false);
  });
});
