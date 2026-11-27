// Sanctuary Computer (quickbooks-mcp-294): the switch file (contract §19 Off switch) and the in-process latch (spec §3 T2, ruling
// d-20261127-040002439). One per server. Writes are on when the path is a regular file and the latch isn't set; turnOff unlinks it, and on
// any failure but ENOENT, or a throw, sets the latch and writes one fixed stderr line (no path, no token). Undo never asks the switch.
import type { SwitchFs } from "./kit.js";

export type Switch = { isOn(path: string): Promise<boolean>; turnOff(path: string): Promise<boolean> };

export const SWITCH_STUCK_LINE = "qbo-write: the switch file couldn't be deleted; categorize is off until restart\n";

export function createSwitch(fs: SwitchFs): Switch {
  let latched = false;
  return Object.freeze({
    async isOn(path: string): Promise<boolean> {
      if (latched) return false;
      try {
        return (await fs.stat(path)).isFile();
      } catch {
        return false;
      }
    },
    async turnOff(path: string): Promise<boolean> {
      try {
        await fs.unlink(path);
        return true;
      } catch (e) {
        if ((e as { code?: unknown } | null)?.code === "ENOENT") return false;
        latched = true;
        try {
          process.stderr.write(SWITCH_STUCK_LINE);
        } catch {
          // turnOff never throws (spec V1): the latch is set, and a line that can't be written is lost.
        }
        return false;
      }
    },
  });
}
