// Sanctuary Computer (quickbooks-mcp-293): the capability registry, contract 1.1 §16 `capability` (docs/contracts/quickbooks.md in
// Stacksbot): each update the pre-send check passed may be sent once, within its life. Only a checked request makes one.
// Changed by Sanctuary Computer (quickbooks-mcp-294): 293 QA1, one check, one send: a check registers once per registry, and only
// while its age (the registry's clock less its checkedAt) is in [0, 60000) ms (spec §3 "293 QA1").
import { sha256Hex } from "./canonical.js";
import type { CapabilityRegistry } from "./guard-rules.js";
import { isChecked, type CheckedRequest } from "./pre-send.js";

/** What was given to `register` is not a request the pre-send check made to be sent, or not one that may be registered now. */
export class CapabilityError extends Error {
  constructor() {
    super("capability: not a checked request to send");
    this.name = "CapabilityError";
  }
}

/** `size` counts the expired that are still held, too. */
export type Registry = CapabilityRegistry & { register(checked: CheckedRequest): void; readonly size: number };
/** Company, entity and body hash, compared part by part. */
type Key = readonly [string, string, string];
type Entry = { key: Key; at: number };

const LIFE_MS = 60_000;

/**
 * A registry of its own: each `register` makes an entry, each `take` uses one up. `now` is in ms; the default never goes back, so a
 * changed wall clock lengthens no life. `register` refuses a check it registered before, and one whose age isn't in [0, 60000):
 * a checkedAt after now, NaN, or 60000 ms old (fail closed, so clocks of two kinds can't pass).
 */
export function createRegistry({ now = () => performance.now() }: { now?: () => number } = {}): Registry {
  let entries: Entry[] = [];
  const registered = new WeakSet<CheckedRequest>();
  const live = (entry: Entry, at: number): boolean => {
    const age = at - entry.at;
    return age >= 0 && age < LIFE_MS; // false for NaN
  };
  const is = ({ key }: Entry, asked: Key): boolean => key.every((part, i) => part === asked[i]);
  const dropExpired = (at: number): void => {
    entries = entries.filter((entry) => live(entry, at));
  };
  return Object.freeze({
    register(checked: CheckedRequest): void {
      if (!isChecked(checked) || (checked.mode !== "categorize" && checked.mode !== "undo")) throw new CapabilityError();
      const at = now();
      const age = at - checked.checkedAt;
      // False for NaN and either infinity too.
      if (registered.has(checked) || !(age >= 0 && age < LIFE_MS)) throw new CapabilityError();
      registered.add(checked);
      dropExpired(at);
      entries.push({ key: [checked.company, checked.entity, sha256Hex(checked.bodyText)], at });
    },
    has(company: string, entity: string, sha: string): boolean {
      const at = now();
      return entries.some((entry) => live(entry, at) && is(entry, [company, entity, sha]));
    },
    take(company: string, entity: string, sha: string): boolean {
      dropExpired(now());
      // Entries are in the order registered, so the first is the oldest.
      const i = entries.findIndex((entry) => is(entry, [company, entity, sha]));
      if (i === -1) return false;
      entries.splice(i, 1);
      return true;
    },
    get size(): number {
      return entries.length;
    },
  });
}
