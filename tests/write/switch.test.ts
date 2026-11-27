// Sanctuary Computer (quickbooks-mcp-294): spec A1.14 at the switch: off when absent, a directory or unstat-able; the latch set only by an
// unlink failing with anything but ENOENT, or throwing (ruling d-20261127-040002439); a recreated file is on again when no latch is set.
import { afterAll, afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'fs/promises';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SwitchFs } from '../../src/write/kit.js';
import { SWITCH_STUCK_LINE, createSwitch } from '../../src/write/switch.js';

const DIR = mkdtempSync(join(tmpdir(), 'qbo-switch-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));
afterEach(() => {
  jest.restoreAllMocks();
});

let n = 0;
const on = (): string => {
  const p = join(DIR, `switch-${n++}`);
  writeFileSync(p, '');
  return p;
};
const REAL: SwitchFs = { stat: fs.stat, unlink: fs.unlink };
const errno = (code: string) => Object.assign(new Error(code), { code });
const failing = (part: 'stat' | 'unlink', thrown: unknown): SwitchFs => ({
  ...REAL,
  [part]: async () => {
    throw thrown;
  },
});
const stderr = () => jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

describe('isOn', () => {
  it('a regular file: on', async () => {
    expect(await createSwitch(REAL).isOn(on())).toBe(true);
  });
  it('absent: off', async () => {
    expect(await createSwitch(REAL).isOn(join(DIR, 'absent'))).toBe(false);
  });
  it('a directory: off', async () => {
    const d = join(DIR, `dir-${n++}`);
    mkdirSync(d);
    expect(await createSwitch(REAL).isOn(d)).toBe(false);
  });
  it('a stat failing EACCES (the seam, so it holds as root): off, with the file present', async () => {
    expect(await createSwitch(failing('stat', errno('EACCES'))).isOn(on())).toBe(false);
  });
});

describe('turnOff', () => {
  it('succeeding: true, the file gone, no latch, no line; the file recreated is on again', async () => {
    const write = stderr();
    const sw = createSwitch(REAL);
    const p = on();
    expect(await sw.turnOff(p)).toBe(true);
    expect(await sw.isOn(p)).toBe(false);
    writeFileSync(p, '');
    expect(await sw.isOn(p)).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
  it('failing EACCES: false, one fixed stderr line naming no path, and latched: off with the file present', async () => {
    const write = stderr();
    const sw = createSwitch(failing('unlink', errno('EACCES')));
    const p = on();
    expect(await sw.turnOff(p)).toBe(false);
    expect(write.mock.calls).toEqual([[SWITCH_STUCK_LINE]]);
    expect(SWITCH_STUCK_LINE).not.toContain(DIR);
    expect(await sw.isOn(p)).toBe(false);
    expect(await createSwitch(REAL).isOn(p)).toBe(true);
  });
  it('an unlink that throws a non-errno value: false, latched', async () => {
    const write = stderr();
    for (const thrown of ['boom', null, undefined, 42]) {
      const sw = createSwitch(failing('unlink', thrown));
      const p = on();
      expect(await sw.turnOff(p)).toBe(false);
      expect(await sw.isOn(p)).toBe(false);
    }
    expect(write).toHaveBeenCalledTimes(4);
  });
  it('the file absent (ENOENT): false, no latch, no line; the file made afterwards is on', async () => {
    const write = stderr();
    const sw = createSwitch(REAL);
    const p = join(DIR, `later-${n++}`);
    expect(await sw.turnOff(p)).toBe(false);
    writeFileSync(p, '');
    expect(await sw.isOn(p)).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
  it('the latch is per switch: another server’s switch is untouched', async () => {
    stderr();
    const a = createSwitch(failing('unlink', errno('EPERM')));
    const b = createSwitch(REAL);
    const p = on();
    await a.turnOff(p);
    expect([await a.isOn(p), await b.isOn(p)]).toEqual([false, true]);
  });
  it('the line is the fixed one', () => {
    expect(SWITCH_STUCK_LINE).toBe("qbo-write: the switch file couldn't be deleted; categorize is off until restart\n");
  });
});
