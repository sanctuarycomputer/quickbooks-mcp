// Sanctuary Computer (quickbooks-mcp-286): tests/helpers/guard.ts starts 291's guard wired to the per-call store (keys, realm, record), and restores it.
import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { trapNetwork } from '../../fakes/no-network.js';
import { installStubNetwork } from '../../fakes/stub-network.js';
import { guardedAxios } from '../../../src/http-guard.js';
import { currentRecord, runInCall, setCallToken } from '../../../src/clients/call-context.js';
import { quickbooksBluebird } from '../../../src/clients/bluebird-context.js';
import { startTestGuard } from '../../helpers/guard.js';

// Order matters: the trap, then the stub (so the backstop wraps the stub), then start.
const trap = trapNetwork();
const net = installStubNetwork(() => ({ status: 200, body: JSON.stringify({ QueryResponse: {} }) }));

const REALM = '9990000000000002';
const OTHER = '9990000000000004';
const STACKS = 'https://stacks.example.test';
const query = (realm: string) =>
  `https://quickbooks.api.intuit.com/v3/company/${realm}/query?query=select%20*%20from%20account%20maxresults%2010&minorversion=75&format=json`;
const stacks = (company: string) => `${STACKS}/api/qbo/access_token?enterprise=${company}`;
const TOKEN = ['qbo', 'test', '1'].join('-');

afterEach(() => {
  expect(trap.reached).toEqual([]);
  net.calls.length = 0;
});

describe('startTestGuard', () => {
  it('binds bluebird, wires keys, the realm callback and the call record to the call store, and restores so a second start works', async () => {
    jest.spyOn(process.stderr, 'write').mockImplementation((() => true) as any);
    const ax = guardedAxios();
    const proto = (quickbooksBluebird() as any).prototype;
    const unbound = proto._then;
    const restore = startTestGuard({ stacksUrl: STACKS, keys: ['garden3d'] });
    expect(proto._then).not.toBe(unbound); // bluebird is bound to the call context
    try {
      await runInCall('garden3d', async () => {
        // keys: a listed company's Stacks request is sent, another is refused
        await expect(ax.get(stacks('garden3d'))).resolves.toMatchObject({ status: 200 });
        await expect(ax.get(stacks('usb-club'))).rejects.toMatchObject({ name: 'GuardRefusedError', rule: 'stacks' });
        // realm: refused before setCallToken, sent after for the call's realm only
        await expect(ax.get(query(REALM))).rejects.toMatchObject({ name: 'GuardRefusedError', rule: 'quickbooks' });
        setCallToken(TOKEN, REALM);
        await expect(ax.get(query(OTHER))).rejects.toMatchObject({ name: 'GuardRefusedError', rule: 'quickbooks' });
        await expect(ax.get(query(REALM))).resolves.toMatchObject({ status: 200 });
        // record: the guard appended the query to this call's record
        expect(currentRecord()!.queries).toEqual([{ entity: 'account', url: query(REALM), status: 200 }]);
      });
      expect(net.calls.map((c) => c.hostname)).toEqual(['stacks.example.test', 'quickbooks.api.intuit.com']);
    } finally {
      restore();
    }
    const again = startTestGuard({ stacksUrl: STACKS, keys: [] });
    again();
  });
});
