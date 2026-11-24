// Sanctuary Computer (quickbooks-mcp-286): real sockets, loopback only (supervisor m-20261124-070106098; carried 291's
// defect and T5). A local HTTPS (or TLS) server on 127.0.0.1, port 0, with a self-signed certificate made at test time
// and trusted only while the test runs (Node's default CA list set to it alone, then put back). Through the started
// server's installed guard and backstop: a Stacks request reaches the socket and the identity check runs; a certificate
// for another name is refused, the right one answers; a Stacks side writing an answer that isn't HTTP gives
// stacks-unreachable after two attempts. No outside host, ever: every socket connect but to 127.0.0.1 and every DNS
// lookup but of 127.0.0.1 throws, and no stub network is installed.
import { describe, it, expect, beforeAll, afterEach, afterAll, jest } from '@jest/globals';
import dns from 'dns';
import https from 'https';
import net from 'net';
import tls from 'tls';
import { BACKSTOP_MARK, guardedAxios } from '../../src/http-guard.js';
import { selfSigned, type AltName } from '../helpers/self-signed.js';
import { readError } from '../helpers/result-grammar.js';
import { REALMS, fixtureToken, readTools, startServer, testEnv, type Rig } from '../helpers/server.js';

// ---- the certificate, trusted only by the test ----
type CaApi = { setDefaultCACertificates?(certs: string[]): void; getCACertificates?(kind: string): string[] };
/** T13-3: why this Node can't run the file (tls's default-CA calls came in Node 22.19 and 24.5), or undefined. */
export function caUnsupported(api: CaApi, version: string): string | undefined {
  if (typeof api.setDefaultCACertificates === 'function' && typeof api.getCACertificates === 'function') return undefined;
  return `loopback-tls needs Node 22.19 or later (24.5 or later on 24): tls.setDefaultCACertificates and tls.getCACertificates are missing on ${version}`;
}
const caApi = tls as unknown as Required<CaApi>;
let defaultCA: string[] = [];
const setDefaultCA = (certs: string[]) => caApi.setDefaultCACertificates(certs);
beforeAll(() => {
  // The file's first check: a Node without the default-CA calls fails here, naming the version it needs.
  const unsupported = caUnsupported(caApi, process.version);
  if (unsupported !== undefined) throw new Error(unsupported);
  defaultCA = caApi.getCACertificates('default');
});
afterEach(() => setDefaultCA(defaultCA));

// ---- loopback only ----
const outside: string[] = [];
const saved = { connect: net.Socket.prototype.connect, lookup: dns.lookup, promisesLookup: dns.promises.lookup };
/** The host a Socket#connect names: its options' host (or a port, host pair); a pipe ('pipe') has none. */
function hostOf(args: unknown[]): string | undefined {
  const [a, b] = args as [unknown, unknown];
  const first = Array.isArray(a) ? a[0] : a; // Node's internal normalized [options, cb] form
  if (first !== null && typeof first === 'object') {
    // A pipe names a path and no port; an https request's options carry its URL path beside host and port.
    const o = first as { path?: unknown; host?: unknown; port?: unknown };
    return o.port === undefined && o.path !== undefined ? 'pipe' : String(o.host ?? 'localhost');
  }
  return typeof b === 'string' ? b : 'localhost';
}
beforeAll(() => {
  // Every file that traps the network puts it back when done (jest shares built-ins across a worker's files): start clean.
  for (const f of [saved.connect, tls.connect, saved.lookup, saved.promisesLookup]) expect(f.name).not.toBe('trapped');
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const host = hostOf(args);
    if (host !== '127.0.0.1') {
      outside.push(String(host));
      throw new Error('outside-host');
    }
    return (saved.connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  // server.listen looks up its own '127.0.0.1'; any other name is refused.
  (dns as any).lookup = (host: string, ...rest: unknown[]) => {
    if (host === '127.0.0.1') return (saved.lookup as (...a: unknown[]) => unknown)(host, ...rest);
    outside.push(`dns.lookup ${host}`);
    throw new Error('outside-host');
  };
  (dns.promises as any).lookup = (host: string) => {
    outside.push(`dns.promises.lookup ${host}`);
    throw new Error('outside-host');
  };
});
afterAll(() => {
  net.Socket.prototype.connect = saved.connect;
  (dns as any).lookup = saved.lookup;
  (dns.promises as any).lookup = saved.promisesLookup;
  expect(outside).toEqual([]);
});


type Local = { port: number; connections: number; close(): Promise<void> };
/** Closes `s`, destroying any socket still open (the guard's agent may keep one alive). */
function closeServer(s: net.Server): Promise<void> {
  const open = (s as net.Server & { sockets?: Set<net.Socket> }).sockets ?? new Set();
  for (const socket of open) socket.destroy();
  return new Promise<void>((r) => s.close(() => r()));
}
/** Keeps each socket `s` accepts, raw or TLS, so closeServer can destroy it. */
function track(s: net.Server): void {
  const sockets = new Set<net.Socket>();
  Object.assign(s, { sockets });
  s.on('connection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
}

/** An HTTPS server on 127.0.0.1 answering every request with garden3d's Stacks 200, under a certificate for `alt`. */
function stacksServer(cert: { key: string; cert: string }): Promise<Local> {
  const body = JSON.stringify({ enterprise: 'garden3d', realm_id: REALMS.garden3d, access_token: fixtureToken('garden3d'), expires_at: '2026-11-18T12:00:00Z', company_name: 'garden3d, LLC' });
  const local = { port: 0, connections: 0 } as Local;
  const server = https.createServer({ key: cert.key, cert: cert.cert }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  server.on('connection', () => local.connections++);
  track(server);
  local.close = () => closeServer(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(Object.assign(local, { port: (server.address() as net.AddressInfo).port }))));
}

/** A TLS server on 127.0.0.1 that, once the handshake is done, writes text that isn't HTTP and closes. */
function garbageServer(cert: { key: string; cert: string }): Promise<Local> {
  const local = { port: 0, connections: 0 } as Local;
  const server = tls.createServer({ key: cert.key, cert: cert.cert }, (socket) => {
    local.connections++;
    socket.end('this is not HTTP at all\r\n\r\n');
  });
  track(server);
  local.close = () => closeServer(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(Object.assign(local, { port: (server.address() as net.AddressInfo).port }))));
}

let rig: Rig | undefined;
let local: Local | undefined;
afterEach(async () => {
  await rig?.close();
  await local?.close();
  rig = undefined;
  local = undefined;
});

/** Trusts `cert` alone, starts the read server with Stacks at the local port, and records the guard's allowed sends. */
async function start(cert: { cert: string }, port: number): Promise<{ allowed: string[] }> {
  setDefaultCA([cert.cert]);
  rig = await startServer({ env: testEnv({ STACKS_QBO_URL: `https://127.0.0.1:${port}` }), tools: await readTools() });
  const ax = guardedAxios();
  const real = ax.getAdapter.bind(ax);
  const allowed: string[] = [];
  jest.spyOn(ax, 'getAdapter').mockImplementation(((n: any) => {
    const http = real(n) as (c: any) => Promise<any>;
    return (config: any) => (allowed.push(String(config.url)), http(config));
  }) as any);
  return { allowed };
}

const RIGHT: AltName = { ip: '127.0.0.1' };
const WRONG: AltName = { dns: 'stacks.example.test' };

describe("291's guard and backstop on a real socket: the identity check runs (loopback TLS)", () => {
  it('the right certificate answers: the Stacks fetch passes the guard, the backstop lets its one socket open, and the identity check passes', async () => {
    const cert = selfSigned(RIGHT);
    local = await stacksServer(cert);
    const { allowed } = await start(cert, local.port);
    expect((https.request as unknown as Record<symbol, unknown>)[BACKSTOP_MARK]).toBe(true);
    const identity = jest.spyOn(tls, 'checkServerIdentity');
    const got = await rig!.runtime.stacks.get('garden3d');
    expect(got.ok && got.token.access_token).toBe(fixtureToken('garden3d'));
    expect(allowed).toEqual([`https://127.0.0.1:${local.port}/api/qbo/access_token?enterprise=garden3d`]);
    expect(local.connections).toBe(1);
    expect(identity).toHaveBeenCalledTimes(1);
    expect(identity.mock.calls[0][0]).toBe('127.0.0.1');
    expect(identity.mock.results[0].value).toBeUndefined();
  });

  it('a certificate for another name is refused by the identity check: no token, stacks-unreachable after two attempts, each reaching the socket', async () => {
    const cert = selfSigned(WRONG);
    local = await stacksServer(cert);
    await start(cert, local.port);
    const identity = jest.spyOn(tls, 'checkServerIdentity');
    const got = await rig!.runtime.stacks.get('garden3d');
    expect(got).toEqual({ ok: false, failure: { reason: 'stacks-unreachable' } });
    expect(local.connections).toBe(2);
    expect(identity).toHaveBeenCalledTimes(2);
    for (const r of identity.mock.results) expect((r.value as NodeJS.ErrnoException).code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
  });

  it("a request the guard didn't ticket is refused by the backstop before any socket opens", async () => {
    const cert = selfSigned(RIGHT);
    local = await stacksServer(cert);
    await start(cert, local.port);
    const stderr: string[] = [];
    jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => (stderr.push(String(chunk)), true)) as never);
    expect(() => https.request(`https://127.0.0.1:${local!.port}/api/qbo/access_token?enterprise=garden3d`)).toThrow('qbo-guard: refused (backstop)');
    expect(local.connections).toBe(0);
    // The refusal is logged once, naming the request without its query (T13-2).
    expect(stderr).toEqual([`qbo-guard: refused GET https://127.0.0.1:${local.port}/api/qbo/access_token (backstop)\n`]);
  });
});

describe('T5 on a real socket: a Stacks side writing an answer that is not HTTP', () => {
  it('get_company_info answers stacks-unreachable after two attempts, each a TLS connection the server saw', async () => {
    const cert = selfSigned(RIGHT);
    local = await garbageServer(cert);
    await start(cert, local.port);
    jest.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    const result = await rig!.client.callTool({ name: 'get_company_info', arguments: { company: 'garden3d', params: {} } });
    expect(readError(result).reason).toBe('stacks-unreachable');
    expect(local.connections).toBe(2);
  });
});

describe('T13-3: a Node without the default-CA calls', () => {
  it('is refused by the first check, naming the Node version the file needs; this Node has both calls', () => {
    const need = 'loopback-tls needs Node 22.19 or later (24.5 or later on 24): tls.setDefaultCACertificates and tls.getCACertificates are missing on v22.12.0';
    expect(caUnsupported({}, 'v22.12.0')).toBe(need);
    expect(caUnsupported({ getCACertificates: () => [] }, 'v22.12.0')).toBe(need);
    expect(caUnsupported({ setDefaultCACertificates: () => undefined }, 'v22.12.0')).toBe(need);
    expect(caUnsupported(tls as unknown as CaApi, process.version)).toBeUndefined();
  });
});
