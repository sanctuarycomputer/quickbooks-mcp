// Sanctuary Computer (quickbooks-mcp-294): the write kit, every seam the write tools use, made once per server by writeMode(deps) (plan note
// m-20261127-041616786). Two clocks: mono (performance.now, never goes back) for ages and timeouts, wall (Date.now) for stamps and the sweep.
// spawn comes from the receipt runner, the one file that loads node:child_process (tests/unit/removals.test.ts R3).
import fs from "node:fs/promises";
import { spawn, type Spawn } from "./receipt-cmd.js";
import { buildBody } from "./rules.js";

/** What the switch uses of node:fs/promises. */
export type SwitchFs = { readonly stat: typeof fs.stat; readonly unlink: typeof fs.unlink };

export type WriteKit = {
  readonly mono: () => number;
  readonly wall: () => number;
  readonly spawn: Spawn;
  readonly buildBody: typeof buildBody;
  readonly fs: SwitchFs;
};

/** The kit: each dep given (and not undefined) replaces only itself; every other is the real one. */
export function createKit(deps: Partial<WriteKit> = {}): WriteKit {
  return Object.freeze({
    // A bare performance.now throws ERR_INVALID_THIS once detached.
    mono: deps.mono ?? (() => performance.now()),
    wall: deps.wall ?? (() => Date.now()),
    spawn: deps.spawn ?? spawn,
    buildBody: deps.buildBody ?? buildBody,
    fs: deps.fs ?? Object.freeze({ stat: fs.stat, unlink: fs.unlink }),
  });
}
