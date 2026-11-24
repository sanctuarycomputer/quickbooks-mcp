// Sanctuary Computer (quickbooks-mcp-293): the capability registry (A3.8, A3.3(d), SB2), on checked requests the real pre-send check made.
import { describe, it, expect, jest } from '@jest/globals';
import { createHash } from 'crypto';
import * as capabilityModule from '../../src/write/capability.js';
import { CapabilityError, createRegistry } from '../../src/write/capability.js';
import type { CheckedRequest } from '../../src/write/pre-send.js';
import { B, COMPANY, DRY, OTHER, P, sendRig, UNDO } from './send-rig.js';
import { type Json } from './derive.js';

const rig = sendRig();
const shaOf = (checked: CheckedRequest): string => createHash('sha256').update(Buffer.from(checked.bodyText, 'utf8')).digest('hex');
type Key = [string, string, string];
const keyOf = (checked: CheckedRequest): Key => [checked.company, checked.entity, shaOf(checked)];
const LIFE = 60_000;

/** One registry on its own clock, holding one request registered at 1000 ms. */
async function held(input: Json = P()) {
  const clock = { ms: 1000 };
  const registry = createRegistry({ now: () => clock.ms });
  const checked = await rig.check(input);
  registry.register(checked);
  return { clock, registry, checked, key: keyOf(checked) };
}

describe('register', () => {
  it.each([['categorize', P], ['undo', UNDO]] as const)('a real %s request: its company, entity and the hash of its own bodyText', async (mode, input) => {
    const { registry, checked, key } = await held(input());
    expect(checked.mode).toBe(mode);
    expect([registry.size, registry.has(...key)]).toEqual([1, true]);
    expect([registry.take(...key), registry.size, registry.has(...key)]).toEqual([true, 0, false]);
  });

  it('A3.8, SB2: anything else is a CapabilityError, and nothing is added or lost', async () => {
    const { registry, checked, key } = await held();
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const trapped = new Proxy({}, { get: () => { throw new Error('x'); }, has: () => { throw new Error('x'); }, getPrototypeOf: () => { throw new Error('x'); } });
    const throwing = Object.defineProperty({ ...checked }, 'mode', { get: () => { throw new Error('x'); } });
    const forged = [{ ...checked }, structuredClone(checked), Object.create(Object.getPrototypeOf(checked)), Object.create(checked), new Proxy(checked, {})];
    for (const one of [...forged, throwing, trapped, proxy, shaOf(checked), checked.bodyText, undefined, null, 5, Symbol('x'), () => checked, [checked], { checked }]) {
      const thrown = (() => {
        try {
          return registry.register(one as any);
        } catch (e) {
          return e;
        }
      })();
      expect(thrown).toBeInstanceOf(CapabilityError);
      expect(thrown).not.toBeInstanceOf(TypeError);
      expect((thrown as Error).name).toBe('CapabilityError');
      expect(registry.size).toBe(1);
    }
    expect(registry.take(...key)).toBe(true);
  });

  it('A3.8: a real dry request is a CapabilityError, and nothing is added', async () => {
    const { registry } = await held();
    const dry = await rig.check(DRY());
    expect(dry.mode).toBe('dry');
    expect(() => registry.register(dry)).toThrow(CapabilityError);
    expect([registry.size, registry.has(...keyOf(dry))]).toEqual([1, false]);
  });

  it('a body registered twice has one use, its life from the later registration', async () => {
    const { registry, clock, checked, key } = await held();
    clock.ms += 50_000;
    registry.register(checked);
    expect(registry.size).toBe(1);
    clock.ms += LIFE - 1;
    expect(registry.has(...key)).toBe(true);
    // Another request of the same company, entity and body is the same capability.
    registry.register(await rig.check());
    expect(registry.size).toBe(1);
    expect([registry.take(...key), registry.take(...key), registry.size]).toEqual([true, false, 0]);
  });

  it('a request that differs in company, entity or body alone is its own capability', async () => {
    const { registry, key } = await held();
    const company = await rig.check({ ...P(), company: OTHER });
    const body = await rig.check({ ...P(), lines: [{ ...P().lines[0], account_id: '91' }] });
    rig.books['bill/1001'] = { Bill: { ...rig.books['purchase/1001'].Purchase } };
    const entity = await rig.check({ ...P(), entity: 'bill' });
    expect(keyOf(company)).toEqual([OTHER, 'purchase', key[2]]);
    expect(keyOf(entity)).toEqual([COMPANY, 'bill', key[2]]);
    for (const one of [company, body, entity]) registry.register(one);
    expect(registry.size).toBe(4);
    for (const one of [key, keyOf(company), keyOf(body), keyOf(entity)]) expect([registry.take(...one), registry.take(...one)]).toEqual([true, false]);
  });
});

describe('take and has', () => {
  it('another company, entity or hash is not held and not taken, and consumes nothing', async () => {
    const { registry, checked, key } = await held();
    const others: Key[] = [
      [OTHER, key[1], key[2]],
      [key[0], 'bill', key[2]],
      [key[0], key[1], createHash('sha256').update(`${checked.bodyText} `).digest('hex')],
      [key[0], key[1], key[2].toUpperCase()],
      [key[0], key[1], checked.bodyText],
      [undefined, undefined, undefined] as any,
    ];
    for (const other of others) expect([registry.has(...other), registry.take(...other), registry.size]).toEqual([false, false, 1]);
    expect(registry.take(...key)).toBe(true);
  });

  it.each(['', ' ', ':', '|', '/', ',', '\n', '\0'])('a company, entity and hash joined by %j never stand for others', async (by) => {
    const { registry, key } = await held({ ...P(), company: `x${by}y` });
    const other: Key = ['x', `y${by}purchase`, key[2]];
    expect([registry.has(...other), registry.take(...other), registry.size]).toEqual([false, false, 1]);
    expect(registry.take(...key)).toBe(true);
  });

  it('has consumes nothing; take answers true once', async () => {
    const { registry, key } = await held();
    for (let i = 0; i < 100; i++) expect(registry.has(...key)).toBe(true);
    expect([registry.size, registry.take(...key), registry.take(...key), registry.has(...key)]).toEqual([1, true, false, false]);
  });

  it('take takes the one named, of two', async () => {
    const { registry, key } = await held();
    const bill = await rig.check(B());
    registry.register(bill);
    expect([registry.take(...keyOf(bill)), registry.size, registry.has(...key), registry.take(...key)]).toEqual([true, 1, true, true]);
  });
});

describe('the life of a capability (A3.3(d))', () => {
  it.each([0, 1, LIFE - 1])('live at %i ms, for has and for take', async (age) => {
    const { registry, clock, key } = await held();
    clock.ms += age;
    expect([registry.has(...key), registry.take(...key), registry.size]).toEqual([true, true, 0]);
  });

  it.each([LIFE, LIFE + 1, Infinity, -1, -5000, -Infinity, NaN])('expired at %d ms, for has, which drops nothing, and for take', async (age) => {
    const { registry, clock, key } = await held();
    clock.ms += age;
    expect([registry.has(...key), registry.size]).toEqual([false, 1]);
    expect([registry.take(...key), registry.size]).toEqual([false, 0]);
  });

  it('has answers again as the clock does, having dropped nothing', async () => {
    const { registry, clock, key } = await held();
    clock.ms += LIFE;
    expect(registry.has(...key)).toBe(false);
    clock.ms -= 1;
    expect([registry.has(...key), registry.take(...key)]).toEqual([true, true]);
  });

  it('register drops the expired and keeps the live (A3.8)', async () => {
    const { registry, clock, key } = await held();
    clock.ms += 10_000;
    const live = await rig.check(B());
    registry.register(live);
    clock.ms += LIFE - 10_000;
    const next = await rig.check({ ...P(), company: OTHER });
    registry.register(next);
    expect(registry.size).toBe(2);
    expect([registry.has(...key), registry.has(...keyOf(live)), registry.has(...keyOf(next))]).toEqual([false, true, true]);
    clock.ms -= 1; // The dropped one is gone, not hidden.
    expect(registry.has(...key)).toBe(false);
  });

  it('a take of another drops the expired and keeps the live', async () => {
    const { registry, clock } = await held();
    clock.ms += 10_000;
    const live = await rig.check(B());
    registry.register(live);
    clock.ms += LIFE - 10_000;
    expect([registry.size, registry.take(OTHER, 'bill', 'x'), registry.size]).toEqual([2, false, 1]);
    expect(registry.take(...keyOf(live))).toBe(true);
  });

  it.each([[undefined], [{}]])('the default clock is monotonic: the wall clock neither lengthens nor ends a life (createRegistry(%j))', async (options) => {
    const checked = await rig.check();
    const now = jest.spyOn(performance, 'now').mockReturnValue(5);
    const wall = jest.spyOn(Date, 'now').mockReturnValue(1e12);
    const registry = createRegistry(options);
    registry.register(checked);
    for (const at of [0, 1e12, 2e12]) {
      wall.mockReturnValue(at);
      now.mockReturnValue(5 + LIFE - 1);
      expect(registry.has(...keyOf(checked))).toBe(true);
      now.mockReturnValue(5 + LIFE);
      expect(registry.has(...keyOf(checked))).toBe(false);
    }
  });
});

describe('the registry', () => {
  it('two are independent', async () => {
    const { registry, checked, key } = await held();
    const other = createRegistry({ now: () => 1000 });
    expect([other.size, other.has(...key), other.take(...key), registry.size]).toEqual([0, false, false, 1]);
    other.register(checked);
    expect([registry.take(...key), other.size, other.take(...key)]).toEqual([true, 1, true]);
  });

  it('holds exactly these, and none can be changed', async () => {
    const { registry } = await held();
    expect(Object.keys(registry).sort()).toEqual(['has', 'register', 'size', 'take']);
    expect(() => ((registry as any).size = 0)).toThrow(TypeError);
    expect(() => ((registry as any).take = () => true)).toThrow(TypeError);
    expect(registry.size).toBe(1);
  });

  it('capability.ts exports exactly these (SB2)', () => {
    expect(Object.keys(capabilityModule).sort()).toEqual(['CapabilityError', 'createRegistry']);
  });
});
