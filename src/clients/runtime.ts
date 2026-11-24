// Sanctuary Computer (quickbooks-mcp-286): the read server's runtime, built once at start from the loaded config (spec
// A2.7, A3.1, A3.2; D2). It joins the realm store, the Stacks token client and the company state, plugs 291's guard into
// the per-call store, and installs the QuickBooks interceptors on the guarded instance. Nothing here is module state:
// a new runtime is a fresh process's (A2.4), and close() takes the interceptors off again.
import type { AxiosInstance } from "axios";
import { configureGuard, guardedAxios } from "../http-guard.js";
import { bindPromiseContext } from "./bluebird-context.js";
import { currentCall, currentRealmAllows, currentRecord } from "./call-context.js";
import { createCompanyState, type CompanyState } from "./company-state.js";
import type { Config } from "./config.js";
import { installQboInterceptors } from "./qbo-transport.js";
import { createRealmStore, StacksTokenClient } from "./stacks-token.js";

export type Runtime = { cfg: Config; stacks: StacksTokenClient; companies: CompanyState; close(): void };

/**
 * The runtime for `cfg`; 291's `secureStart` must have run (configureGuard throws before it). `deps.now` is the Stacks
 * client's clock, for tests.
 */
export function createRuntime(cfg: Config, deps: { now?: () => number } = {}): Runtime {
  // Before any call: node-quickbooks' bluebird handlers must run in the call they were attached in (A3.4, A3.5; T4-3).
  bindPromiseContext();
  const realms = createRealmStore();
  const stacks = new StacksTokenClient(cfg, realms, { now: deps.now });
  const companies = createCompanyState(cfg, stacks, realms);
  configureGuard({ keys: () => cfg.companies.map((c) => c.key), allowedRealm: currentRealmAllows, callRecord: currentRecord });
  const interceptors = installQboInterceptors(guardedAxios() as unknown as AxiosInstance, {
    reacquire: (company, sentAt) => stacks.get(company, { force: true, sentAt }),
    mark: () => stacks.mark(),
    // Every token the call held, not only its current one: after a 401's resend a fault may echo the old one (T13, A5.7).
    secrets: () => [...(currentCall()?.held ?? []), cfg.stacksKey],
  });
  return { cfg, stacks, companies, close: () => interceptors.eject() };
}
