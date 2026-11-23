// Sanctuary Computer (quickbooks-mcp-286): node-quickbooks' bluebird (3.3.4, no async hooks) runs every queued handler from one
// shared drain, in the context of whichever promise settled first in that tick, so overlapping calls would read each other's
// store (A3.4, A3.5). Binding each handler where it is attached keeps it in its own call.
import { AsyncResource } from "node:async_hooks";
import { createRequire } from "node:module";

const BOUND = Symbol.for("qbo-mcp.bluebird-context");

type ThenFn = (didFulfill: unknown, didReject: unknown, ...rest: unknown[]) => unknown;

const bindIfFunction = (h: unknown): unknown => (typeof h === "function" ? AsyncResource.bind(h as (...a: unknown[]) => unknown) : h);

/** The bluebird node-quickbooks loads (resolved from its own path, as guardedAxios resolves axios). */
export function quickbooksBluebird(): { prototype: Record<string | symbol, unknown> } {
  return createRequire(createRequire(import.meta.url).resolve("node-quickbooks"))("bluebird");
}

/** Wraps bluebird's `_then` once so its two handler slots run in the context they were attached in; a second call is a no-op. */
export function bindPromiseContext(): void {
  const proto = quickbooksBluebird().prototype;
  if (proto[BOUND] === true) return;
  const original = proto._then as ThenFn;
  proto._then = function (this: unknown, didFulfill: unknown, didReject: unknown, ...rest: unknown[]) {
    return original.call(this, bindIfFunction(didFulfill), bindIfFunction(didReject), ...rest);
  };
  proto[BOUND] = true;
}
