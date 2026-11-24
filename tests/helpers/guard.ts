// Sanctuary Computer (quickbooks-mcp-286): 291's guard started for a test and plugged into the per-call store, as the entry will (T10).
import { configureGuard, secureStart } from '../../src/http-guard.js';
import { currentRealmAllows, currentRecord } from '../../src/clients/call-context.js';
import { bindPromiseContext } from '../../src/clients/bluebird-context.js';

/** Binds node-quickbooks' bluebird to the call context, then starts the guard with `stacksUrl` as STACKS_QBO_URL, reading keys, realm and record from the call store; returns the restore. */
export function startTestGuard(opts: { stacksUrl: string; keys: string[] }): () => void {
  bindPromiseContext();
  const restore = secureStart({ STACKS_QBO_URL: opts.stacksUrl }, []);
  configureGuard({ keys: () => opts.keys, allowedRealm: currentRealmAllows, callRecord: currentRecord });
  return restore;
}
