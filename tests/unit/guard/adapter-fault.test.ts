// Sanctuary Computer (quickbooks-mcp-291): a fault inside decide itself (A1.11's injected fault): the adapter refuses guard-error and sends nothing.
import { describe, it, expect, afterAll, jest } from '@jest/globals';
import { trapNetwork } from '../../fakes/no-network.js';
import { installStubNetwork } from '../../fakes/stub-network.js';

const trap = trapNetwork();
const net = installStubNetwork();

jest.unstable_mockModule('../../../src/clients/guard-decide.js', () => ({
  decide: () => {
    throw new Error('injected fault');
  },
  newCallRecord: () => ({ queries: [] }),
}));
const { createGuard, installGuard, guardedAxios, configureGuard, defaultCallScope } = await import('../../../src/http-guard.js');

// Before any guard exists (a fresh module): nothing to configure, no default scope.
const beforeGuard = [
  (() => {
    try {
      configureGuard({ keys: () => ['garden3d'] });
      return 'configured';
    } catch (e) {
      return (e as Error).message;
    }
  })(),
  (() => {
    try {
      defaultCallScope();
      return 'scope';
    } catch (e) {
      return (e as Error).message;
    }
  })(),
];

const restoreGuard = installGuard(
  createGuard({ stacksUrl: 'https://stacks.example.test', keys: () => ['garden3d'], allowedRealm: () => true, callRecord: () => ({ queries: [] }) }),
);
afterAll(() => {
  restoreGuard();
  net.restore();
  trap.restore();
});

describe('before createGuard', () => {
  it('configureGuard and defaultCallScope refuse: not started', () => {
    expect(beforeGuard).toEqual(['qbo-guard: not started', 'qbo-guard: not started']);
  });
});

describe('a throw inside decide (A1.11)', () => {
  it('is guard-error, logged, nothing sent', async () => {
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(guardedAxios().get('https://stacks.example.test/api/qbo/access_token?enterprise=garden3d')).rejects.toMatchObject({
      name: 'GuardRefusedError',
      rule: 'guard-error',
    });
    expect(write).toHaveBeenCalledWith('qbo-guard: refused GET https://stacks.example.test/api/qbo/access_token (guard-error)\n');
    expect(net.calls).toHaveLength(0);
    expect(trap.reached).toEqual([]);
  });
});
