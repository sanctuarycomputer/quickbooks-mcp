// Sanctuary Computer (quickbooks-mcp-291): a socket-level trap under every guard test, so a broken or mutated guard fails instead of reaching a host.
import dns from 'dns';
import http2 from 'http2';
import net from 'net';
import tls from 'tls';

export type NetworkTrap = { reached: string[]; restore(): void };

/** Replaces socket connect, TLS connect, DNS lookups, fetch, WebSocket and HTTP/2 connect with throwing traps. Install before any stub or backstop. */
export function trapNetwork(): NetworkTrap {
  const reached: string[] = [];
  const trap = (label: string) =>
    function trapped(): never {
      reached.push(label);
      throw new Error('network-reached');
    };
  const g = globalThis as Record<string, unknown>;
  const saved = {
    connect: net.Socket.prototype.connect,
    tlsConnect: tls.connect,
    lookup: dns.lookup,
    promisesLookup: dns.promises.lookup,
    fetch: Object.getOwnPropertyDescriptor(g, 'fetch'),
    WebSocket: Object.getOwnPropertyDescriptor(g, 'WebSocket'),
    http2Connect: http2.connect,
  };
  net.Socket.prototype.connect = trap('net.Socket.connect') as any;
  (tls as any).connect = trap('tls.connect');
  (dns as any).lookup = trap('dns.lookup');
  (dns.promises as any).lookup = trap('dns.promises.lookup');
  Object.defineProperty(g, 'fetch', { value: trap('fetch'), writable: true, configurable: true });
  Object.defineProperty(g, 'WebSocket', { value: trap('WebSocket'), writable: true, configurable: true });
  (http2 as any).connect = trap('http2.connect');
  return {
    reached,
    restore() {
      net.Socket.prototype.connect = saved.connect;
      (tls as any).connect = saved.tlsConnect;
      (dns as any).lookup = saved.lookup;
      (dns.promises as any).lookup = saved.promisesLookup;
      for (const k of ['fetch', 'WebSocket'] as const) {
        const desc = saved[k];
        if (desc) Object.defineProperty(g, k, desc);
        else delete g[k];
      }
      (http2 as any).connect = saved.http2Connect;
    },
  };
}
