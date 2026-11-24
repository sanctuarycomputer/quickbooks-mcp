// Sanctuary Computer (quickbooks-mcp-286): bindPromiseContext keeps node-quickbooks' bluebird handlers in the call they were attached in (A3.4, A3.5).
import { describe, it, expect, beforeAll, jest } from '@jest/globals';
import { spawnSync } from 'child_process';
import { bindPromiseContext, quickbooksBluebird } from '../../../src/clients/bluebird-context.js';
import { currentCall, runInCall } from '../../../src/clients/call-context.js';
import { ROOT } from '../../e2e/helpers.js';

const Bluebird = quickbooksBluebird() as any;

/** Both calls resume in one tick, so their bluebird handlers share one drain; each returns what its handler saw. */
async function overlap(attach: (company: string) => Promise<unknown>): Promise<unknown[]> {
  let open: () => void = () => {};
  const both = new Promise<void>((resolve) => (open = resolve));
  let started = 0;
  const one = (company: string) =>
    runInCall(company, async () => {
      started += 1;
      if (started === 2) open();
      await both;
      return attach(company);
    });
  return Promise.all([one('garden3d'), one('usb-club')]);
}

const company = () => currentCall()?.company;

describe('without bindPromiseContext (a separate process, node-quickbooks bluebird unbound)', () => {
  it('a handler attached in the second call runs in the first call (the bleed this fixes)', () => {
    // Plain AsyncLocalStorage, the same overlap; no fork code is loaded.
    const script = `
      const { AsyncLocalStorage } = require('node:async_hooks');
      const { createRequire } = require('node:module');
      const B = createRequire(require.resolve('node-quickbooks'))('bluebird');
      const als = new AsyncLocalStorage();
      let open; const both = new Promise((r) => (open = r)); let started = 0;
      const one = (c) => als.run(c, async () => { started += 1; if (started === 2) open(); await both; return B.resolve().then(() => als.getStore()); });
      Promise.all([one('garden3d'), one('usb-club')]).then((r) => process.stdout.write(JSON.stringify(r)));
    `;
    const out = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' });
    expect(out.stderr).toBe('');
    expect(JSON.parse(out.stdout)).toEqual(['garden3d', 'garden3d']);
  });
});

describe('after bindPromiseContext', () => {
  let before: unknown;
  let bound: unknown;
  beforeAll(() => {
    before = Bluebird.prototype._then;
    bindPromiseContext();
    bound = Bluebird.prototype._then;
  });

  it('binds once: a second call is a no-op and _then keeps its identity', () => {
    expect(bound).not.toBe(before);
    bindPromiseContext();
    expect(Bluebird.prototype._then).toBe(bound);
  });

  it('a fulfil handler runs in the call it was attached in', async () => {
    await expect(overlap(() => Bluebird.resolve().then(company))).resolves.toEqual(['garden3d', 'usb-club']);
  });

  it('a reject handler (then(_, cb) and catch) runs in the call it was attached in', async () => {
    await expect(overlap(() => Bluebird.reject(new Error('x')).then(undefined, company))).resolves.toEqual(['garden3d', 'usb-club']);
    await expect(overlap(() => Bluebird.reject(new Error('x')).catch(company))).resolves.toEqual(['garden3d', 'usb-club']);
  });

  it("a node-quickbooks-shaped chain (new Promise(executor).then(cb), settled later) calls cb in the caller's store", async () => {
    const chain = () => new Bluebird((resolve: (v: unknown) => void) => setImmediate(() => resolve(1))).then(company);
    await expect(overlap(chain)).resolves.toEqual(['garden3d', 'usb-club']);
  });

  it('a handler keeps its receiver and value, and a non-function slot passes the value through', async () => {
    const ctx = { tag: 't' };
    await expect(Bluebird.resolve(5).bind(ctx).then(function (this: typeof ctx, v: number) { return `${this.tag}${v}`; })).resolves.toBe('t5');
    await expect(Bluebird.resolve(6).then(null, null)).resolves.toBe(6);
  });

  // _then(didFulfill, didReject, _, receiver, internalData): the third slot is unused by bluebird 3.3.4; these cases decide
  // that receiver and internalData pass through (finally and spread put their state in receiver; bind-to-a-promise and
  // reduce put theirs in internalData).
  it('receiver passes through: finally resolves the value and calls fn once; spread applies the array', async () => {
    const fn = jest.fn();
    await expect(Bluebird.resolve(7).finally(fn)).resolves.toBe(7);
    expect(fn).toHaveBeenCalledTimes(1);
    await expect(Bluebird.resolve([1, 2]).spread((x: number, y: number) => x + y)).resolves.toBe(3);
  });

  it('internalData passes through: bind to a promise of a receiver, and reduce', async () => {
    const ctx = { tag: 'p' };
    await expect(Bluebird.resolve(8).bind(Bluebird.resolve(ctx)).then(function (this: typeof ctx, v: number) { return `${this.tag}${v}`; })).resolves.toBe('p8');
    await expect(Bluebird.reduce([1, 2, 3], (a: number, b: number) => a + b, 0)).resolves.toBe(6);
  });
});

describe('bindPromiseContext on a bluebird without _then', () => {
  it('throws by name at bind time and sets no marker', () => {
    const fake = { prototype: {} as Record<string | symbol, unknown> };
    expect(() => bindPromiseContext({ bluebird: () => fake })).toThrow(new Error('bluebird-context: bluebird has no _then'));
    expect(Object.getOwnPropertySymbols(fake.prototype)).toEqual([]);
    expect(fake.prototype._then).toBeUndefined();
  });
});
