// Sanctuary Computer (quickbooks-mcp-286): the per-company state that prepares each tool call (spec A2.3-A2.5, A2.9;
// contract §5's name rule). Built once at start and handed to the tools: never module state, so a new one is a fresh
// process (A2.4's restart). Each call gets its token from the Stacks client, sets it on the call, and on a company's first
// use reads QuickBooks' `companyinfo/<realm>` through the same node-quickbooks client a tool uses. A mismatch refuses
// the company until restart through the realm store; a failed read keeps nothing, so the next call reads again.
import { cleanName, matches } from "../helpers/name-fold.js";
import { currentCall, setCallToken, type Failure } from "./call-context.js";
import type { Config } from "./config.js";
import { QuickbooksClient } from "./quickbooks-client.js";
import type { RealmStore, StacksTokenClient } from "./stacks-token.js";

export type CompanyState = {
  /** Inside a tool call for `company`: null when the call may go on (its token set), else the failure it answers. */
  prepareCall(company: string): Promise<Failure | null>;
};

const FORK_ERROR: Failure = Object.freeze({ reason: "fork-error" });

/** One `companyinfo/<realm>` read through node-quickbooks: the CompanyInfo object, or the failure the read recorded. */
async function readInfo(realm: string): Promise<{ info: { CompanyName?: unknown; LegalName?: unknown } } | { failure: Failure }> {
  const qb = await QuickbooksClient.getInstance();
  const { err, info } = await new Promise<{ err: unknown; info: unknown }>((resolve) =>
    (qb as any).getCompanyInfo(realm, (err: unknown, info: unknown) => resolve({ err, info })),
  );
  // The interceptors record a QuickBooks answer's failure on the call; an error with none recorded (a Fault in a 200,
  // say) is the fork's own.
  if (err) return { failure: currentCall()!.failure ?? FORK_ERROR };
  // Whatever node-quickbooks hands back (an object, a string, nothing) is read as an object: a non-object has no names.
  return { info: Object(info) };
}

export function createCompanyState(cfg: Config, client: StacksTokenClient, realms: RealmStore): CompanyState {
  const accepted = new Map(cfg.companies.map((c) => [c.key, c.acceptedNames]));
  /** Companies whose first-use read passed in this state's life. */
  const checked = new Set<string>();
  /** Each company's first-use read in flight: concurrent first calls share it (A2.9). */
  const reads = new Map<string, Promise<Failure | null>>();

  /** The first-use check (A2.3): CompanyName, then LegalName, matched as read; a mismatch is kept until restart (A2.4). */
  async function firstUse(company: string, realm: string): Promise<Failure | null> {
    const read = await readInfo(realm);
    if ("failure" in read) return read.failure;
    const names = [read.info.CompanyName, read.info.LegalName];
    if (names.some((n) => matches(n, accepted.get(company)))) {
      checked.add(company);
      return null;
    }
    // `reported:` is the first name present after the name rule; with neither present the answer has no usable data (A2.5).
    const reported = names.map(cleanName).find((n) => n !== null);
    if (reported === undefined) return FORK_ERROR;
    const f: Failure = Object.freeze({ reason: "name-mismatch", source: "quickbooks", reported });
    realms.refuse(company, f);
    return f;
  }

  /** The company's token from the Stacks client, set on the call; a refused company answers its kept failure, with no request (T5). */
  async function takeToken(company: string): Promise<Failure | null> {
    const got = await client.get(company);
    if (!got.ok) return got.failure;
    setCallToken(got.token.access_token, got.token.realm_id);
    return null;
  }

  return {
    async prepareCall(company) {
      const failure = await takeToken(company);
      if (failure !== null) return failure;
      if (checked.has(company)) return null;
      const inFlight = reads.get(company);
      if (inFlight === undefined) {
        const read = firstUse(company, currentCall()!.realm as string);
        reads.set(company, read);
        const done = () => void reads.delete(company);
        read.then(done, done);
        return read;
      }
      // A joined read ran in another call: if it was resent after a 401, only that call holds the new token. Take the
      // token again (the cache now holds the newest) so this call's first request doesn't spend a 401 on the old one (T7-2).
      return (await inFlight) ?? takeToken(company);
    },
  };
}
