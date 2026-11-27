// Sanctuary Computer (quickbooks-mcp-294): the write kit, every write seam's one route (plan note m-20261127-041616786): each default is the
// right thing (each clock follows only its own source), each given dep replaces only itself, and writeMode's registry runs on its mono.
import { describe, expect, it, jest } from '@jest/globals';
import fs from 'fs/promises';
import { sha256Hex } from '../../src/write/canonical.js';
import { createKit } from '../../src/write/kit.js';
import { writeMode } from '../../src/write/mode.js';
import { spawn } from '../../src/write/receipt-cmd.js';
import { buildBody } from '../../src/write/rules.js';
import { sendRig } from './send-rig.js';

const rig = sendRig();

describe('createKit', () => {
  it('mono follows performance.now alone, wall follows Date.now alone (plan-2 Q2)', () => {
    const perf = jest.spyOn(performance, 'now').mockReturnValue(5);
    const date = jest.spyOn(Date, 'now').mockReturnValue(1e12);
    const kit = createKit();
    expect([kit.mono(), kit.wall()]).toEqual([5, 1e12]);
    date.mockReturnValue(2e12);
    expect([kit.mono(), kit.wall()]).toEqual([5, 2e12]);
    perf.mockReturnValue(7);
    expect([kit.mono(), kit.wall()]).toEqual([7, 2e12]);
  });

  it('spawn is the receipt runner’s, buildBody 293’s, fs node:fs/promises’ stat and unlink', () => {
    const kit = createKit();
    expect(kit.spawn).toBe(spawn);
    expect(kit.buildBody).toBe(buildBody);
    expect(kit.fs.stat).toBe(fs.stat);
    expect(kit.fs.unlink).toBe(fs.unlink);
  });

  it('each of the five, given, is the one the kit holds, and the others stay the defaults (task-3-1 TD2)', () => {
    const given = {
      mono: () => 1,
      wall: () => 2,
      spawn: (() => undefined) as unknown as typeof spawn,
      buildBody: (() => ({})) as unknown as typeof buildBody,
      fs: { stat: fs.stat, unlink: fs.unlink },
    };
    for (const [key, value] of Object.entries(given)) {
      const kit = createKit({ [key]: value });
      expect([key, kit[key as keyof typeof kit]]).toEqual([key, value]);
      for (const other of Object.keys(given).filter((k) => k !== key && k !== 'mono' && k !== 'wall' && k !== 'fs'))
        expect([other, kit[other as keyof typeof kit]]).toEqual([other, (createKit() as Record<string, unknown>)[other]]);
    }
    expect(createKit({ fs: given.fs }).fs).toBe(given.fs);
  });

  it('each given dep replaces only itself, an undefined one replaces nothing, and the kit is frozen', () => {
    const mono = () => 1;
    const kit = createKit({ mono, wall: undefined });
    expect(kit.mono).toBe(mono);
    expect(kit.spawn).toBe(spawn);
    jest.spyOn(Date, 'now').mockReturnValue(42);
    expect(kit.wall()).toBe(42);
    expect(Object.isFrozen(kit)).toBe(true);
    expect(Object.isFrozen(kit.fs)).toBe(true);
    expect(Object.keys(kit).sort()).toEqual(['buildBody', 'fs', 'mono', 'spawn', 'wall']);
  });
});

describe('writeMode(deps)', () => {
  it('holds its kit, and makes the registry with the kit’s mono', async () => {
    let now = 1000;
    const mode = writeMode({ mono: () => now });
    expect(mode.kit.mono()).toBe(1000);
    const first = await rig.check();
    const key = [first.company, first.entity, sha256Hex(first.bodyText)] as const;
    mode.registry.register(first);
    now += 59_999;
    expect(mode.registry.take(...key)).toBe(true);
    // QA1: the second check on the registry's own clock, so its age is in range.
    mode.registry.register(await rig.check(undefined, () => now));
    now += 60_000;
    expect(mode.registry.take(...key)).toBe(false);
  });

  it('with no deps, its kit has the defaults, and it is frozen', () => {
    const mode = writeMode();
    expect(mode.kit.spawn).toBe(spawn);
    expect(Object.isFrozen(mode.kit)).toBe(true);
  });
});
