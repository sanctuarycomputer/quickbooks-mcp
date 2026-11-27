// Sanctuary Computer (quickbooks-mcp-294): the sweep stamp's reader, contract §19 Sweep reader, read on each categorize and undo call.
// True only on step 7 (pass); every other row, and any throw, is false (write:sweep). `wall` is epoch ms (the kit's wall).
import { readFile } from "node:fs/promises";

const SWEEP_KEYS = new Set(["v", "at", "clean", "jobs", "reason"]);
const FUTURE_MS = 60_000;
const STALE_MS = 20 * 60_000;

/** Step 2: exactly the Sweep stamp's keys and types; `at` an ISO 8601 UTC time that round-trips. */
function shapeOk(stamp: unknown): stamp is { v: number; at: string; clean: boolean; jobs: number; reason?: string } {
  if (typeof stamp !== "object" || stamp === null || Array.isArray(stamp)) return false;
  const s = stamp as Record<string, unknown>;
  const keys = Object.keys(s);
  if (keys.some((k) => !SWEEP_KEYS.has(k))) return false;
  if (!Number.isInteger(s.v) || typeof s.at !== "string" || typeof s.clean !== "boolean") return false;
  if (!Number.isInteger(s.jobs) || (s.jobs as number) < 0) return false;
  if (s.clean) {
    if (Object.prototype.hasOwnProperty.call(s, "reason")) return false;
  } else if (typeof s.reason !== "string" || s.reason === "") return false;
  const t = Date.parse(s.at);
  return !Number.isNaN(t) && new Date(t).toISOString() === s.at;
}

/** The Sweep reader at `wall()`: true only when the stamp at `path` is clean and fresh. */
export async function readSweep(path: string, wall: () => number): Promise<boolean> {
  try {
    const stamp: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!shapeOk(stamp)) return false;
    if (stamp.v !== 1) return false;
    const now = wall();
    const t = Date.parse(stamp.at);
    if (t - now > FUTURE_MS) return false;
    if (!stamp.clean) return false;
    if (now - t > STALE_MS) return false;
    return Number.isFinite(now);
  } catch {
    return false;
  }
}
