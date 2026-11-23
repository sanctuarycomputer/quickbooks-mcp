// Sanctuary Computer (quickbooks-mcp-291): a stub network in place of http(s).request/get; it records each call and answers from a table, never opening a socket.
import { EventEmitter } from 'events';
import http from 'http';
import https from 'https';
import { PassThrough } from 'stream';

export type StubCall = {
  module: 'http' | 'https';
  method: string | undefined;
  hostname: string | undefined;
  port: string | number | undefined;
  path: string | undefined;
  headers: Record<string, unknown> | undefined;
  agent: unknown;
  options: Record<string, unknown>;
};
export type StubAnswer = { status: number; headers?: Record<string, string>; body?: string };
export type StubTable = (call: StubCall) => StubAnswer | Promise<StubAnswer>;
export type StubNetwork = { calls: StubCall[]; restore(): void };

class FakeRequest extends EventEmitter {
  destroyed = false;
  private ended = false;
  constructor(
    private readonly call: StubCall,
    private readonly table: StubTable,
    onResponse: ((res: PassThrough) => void) | undefined,
  ) {
    super();
    if (onResponse) this.once('response', onResponse);
  }
  setTimeout(): this {
    return this;
  }
  setNoDelay(): void {}
  setSocketKeepAlive(): void {}
  write(): boolean {
    return true;
  }
  end(): this {
    if (this.ended) return this;
    this.ended = true;
    Promise.resolve()
      .then(() => this.table(this.call))
      .then((answer) => {
        if (this.destroyed) return;
        const res = new PassThrough();
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        for (const [k, v] of Object.entries(answer.headers ?? {})) headers[k.toLowerCase()] = v;
        Object.assign(res, { statusCode: answer.status, statusMessage: String(answer.status), headers, req: this });
        this.emit('response', res);
        res.end(answer.body ?? '{}');
      })
      .catch((err) => this.emit('error', err));
    return this;
  }
  destroy(err?: Error): this {
    this.destroyed = true;
    if (err) this.emit('error', err);
    return this;
  }
  abort(): void {
    this.destroyed = true;
  }
}

/** Replaces https.request, https.get, http.request and http.get on the module objects; restore() puts the originals back. */
export function installStubNetwork(table: StubTable = () => ({ status: 200 })): StubNetwork {
  const calls: StubCall[] = [];
  const saved = { hr: https.request, hg: https.get, pr: http.request, pg: http.get };
  const fake = (module: 'http' | 'https') =>
    function request(...args: any[]): FakeRequest {
      let options: Record<string, unknown> = {};
      let cb: ((res: PassThrough) => void) | undefined;
      for (const a of args) {
        if (typeof a === 'function') cb = a;
        else if (typeof a === 'string' || a instanceof URL) {
          const u = new URL(String(a));
          options = { ...options, hostname: u.hostname, port: u.port, path: u.pathname + u.search, protocol: u.protocol };
        } else if (a && typeof a === 'object') options = { ...options, ...a };
      }
      const call: StubCall = {
        module,
        method: (options.method as string | undefined) ?? 'GET',
        hostname: (options.hostname ?? options.host) as string | undefined,
        port: options.port as string | number | undefined,
        path: options.path as string | undefined,
        headers: options.headers as Record<string, unknown> | undefined,
        agent: options.agent,
        options,
      };
      calls.push(call);
      return new FakeRequest(call, table, cb);
    };
  const get = (request: (...args: any[]) => FakeRequest) =>
    function get(...args: any[]): FakeRequest {
      return request(...args).end();
    };
  const httpsRequest = fake('https');
  const httpRequest = fake('http');
  (https as any).request = httpsRequest;
  (https as any).get = get(httpsRequest);
  (http as any).request = httpRequest;
  (http as any).get = get(httpRequest);
  return {
    calls,
    restore() {
      (https as any).request = saved.hr;
      (https as any).get = saved.hg;
      (http as any).request = saved.pr;
      (http as any).get = saved.pg;
    },
  };
}
