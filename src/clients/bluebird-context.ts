// Sanctuary Computer (quickbooks-mcp-286): node-quickbooks' bluebird (3.3.4, no async hooks) runs every queued handler from one
// shared drain, in the context of whichever promise settled first in that tick, so overlapping calls would read each other's
// store (A3.4, A3.5). Binding each handler where it is attached keeps it in its own call.
import { AsyncResource } from "node:async_hooks";
import { createRequire } from "node:module";

const BOUND = Symbol.for("qbo-mcp.bluebird-context");

/** bluebird 3.3.4's `_then(didFulfill, didReject, _, receiver, internalData)` (promise.js:217): `_` is unused there,
 * `receiver` carries finally's and spread's state, `internalData` bind-to-a-promise's and reduce's. */
type ThenFn = (didFulfill: unknown, didReject: unknown, _: unknown, receiver: unknown, internalData: unknown) => unknown;
type Bluebird = { prototype: Record<string | symbol, unknown> };

const bindIfFunction = (h: unknown): unknown => (typeof h === "function" ? AsyncResource.bind(h as (...a: unknown[]) => unknown) : h);

/** The bluebird node-quickbooks loads (resolved from its own path, as guardedAxios resolves axios). */
export function quickbooksBluebird(): Bluebird {
  return createRequire(createRequire(import.meta.url).resolve("node-quickbooks"))("bluebird");
}

/**
 * Wraps bluebird's `_then` once so its two handler slots run in the context they were attached in; the other three slots
 * pass through as given. A second call is a no-op. Throws at bind time if the bluebird has no `_then`.
 */
export function bindPromiseContext(deps?: { bluebird?: () => Bluebird }): void {
  const proto = (deps?.bluebird ?? quickbooksBluebird)().prototype;
  if (proto[BOUND] === true) return;
  const original = proto._then;
  if (typeof original !== "function") throw new Error("bluebird-context: bluebird has no _then");
  proto._then = function (this: unknown, didFulfill: unknown, didReject: unknown, _: unknown, receiver: unknown, internalData: unknown) {
    return (original as ThenFn).call(this, bindIfFunction(didFulfill), bindIfFunction(didReject), _, receiver, internalData);
  };
  proto[BOUND] = true;
}
