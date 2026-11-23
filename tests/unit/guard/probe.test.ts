// Sanctuary Computer (quickbooks-mcp-291): the guard probe: one decide, one line, nothing sent.
import { describe, it, expect, jest } from '@jest/globals';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { assertFreshBuild, ROOT } from '../../e2e/helpers.js';
import { runProbe } from '../../../src/guard-probe.js';

const EX = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fakes/guard-examples.json'), 'utf8'));
const PROBE = path.join(ROOT, 'dist', 'guard-probe.js');
const COMPANYINFO = 'https://quickbooks.api.intuit.com/v3/company/123/companyinfo/123?minorversion=75&format=json';
const S = 'https://stacks.example.test/api/qbo/access_token?enterprise=garden3d';

function probe(argv: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = runProbe(argv, (l) => out.push(l), (l) => err.push(l));
  return { code, out, err };
}

/** The built probe as a process, with any socket connect or DNS lookup exiting 97. */
function probeProcess(argv: string[]) {
  assertFreshBuild();
  if (!fs.existsSync(PROBE)) throw new Error('dist/guard-probe.js is missing: run npm run build');
  return spawnSync(process.execPath, ['--import', pathToFileURL(path.join(ROOT, 'tests', 'fixtures', 'no-network.mjs')).href, PROBE, ...argv], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    timeout: 20000,
  });
}

describe('the built probe as a process (A2.1)', () => {
  it('a POST is refused: a line starting `refuse `, exit 1', () => {
    const r = probeProcess(['POST', 'https://quickbooks.api.intuit.com/v3/company/123/purchase?minorversion=75', '--realm', '123']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^refuse [a-z-]+\n$/);
    expect(r.stderr).toBe('');
  });

  it('the companyinfo GET is allowed: `allow companyinfo`, exit 0', () => {
    const r = probeProcess(['GET', COMPANYINFO, '--realm', '123']);
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ status: 0, stdout: 'allow companyinfo\n', stderr: '' });
  });

  it('the same GET with --realm 456 is refused', () => {
    const r = probeProcess(['GET', COMPANYINFO, '--realm', '456']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^refuse [a-z-]+\n$/);
  });

  it('a usage error exits 2 with usage: on stderr and nothing on stdout', () => {
    const r = probeProcess(['GET', COMPANYINFO]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^usage: guard-probe /);
  });
});

describe('runProbe in process (A2.2)', () => {
  it.each([
    ['no arguments', [], 'missing METHOD'],
    ['a missing URL', ['GET', '--realm', '123'], 'missing URL'],
    ['a missing method and URL', ['--realm', '123'], 'missing METHOD'],
    ['a missing --realm', ['GET', COMPANYINFO], 'missing --realm'],
    ['--realm without a value', ['GET', COMPANYINFO, '--realm'], '--realm needs a value'],
    ['--realm with an empty value', ['GET', COMPANYINFO, '--realm', ''], '--realm needs a value'],
    ['--realm followed by a flag', ['GET', COMPANYINFO, '--realm', '--key', 'garden3d'], '--realm needs a value'],
    ['--realm twice', ['GET', COMPANYINFO, '--realm', '123', '--realm', '456'], '--realm given twice'],
    ['--stacks-url twice', ['GET', S, '--realm', '1', '--stacks-url', 'https://a.test', '--stacks-url', 'https://b.test'], '--stacks-url given twice'],
    ['--key without a value', ['GET', S, '--realm', '1', '--key'], '--key needs a value'],
    ['an unknown flag', ['GET', COMPANYINFO, '--realm', '123', '--mode', 'write'], 'unknown flag --mode'],
    ['an unknown flag with =', ['GET', COMPANYINFO, '--realm=123'], 'unknown flag --realm=123'],
    ['a third positional', ['GET', COMPANYINFO, 'extra', '--realm', '123'], 'too many arguments'],
  ] as Array<[string, string[], string]>)('%s → 2, usage: on err, nothing on out', (_what, argv, reason) => {
    const r = probe(argv);
    expect(r).toEqual({
      code: 2,
      out: [],
      err: [`usage: guard-probe <METHOD> <URL> --realm <R> [--stacks-url <u>] [--key <k>]... (${reason})`],
    });
  });

  it('a Stacks URL without --stacks-url is refused (refused)', () => {
    expect(probe(['GET', S, '--realm', '123', '--key', 'garden3d'])).toEqual({ code: 1, out: ['refuse refused'], err: [] });
  });

  it('a Stacks URL with an http:// --stacks-url is refused (stacks-config)', () => {
    expect(probe(['GET', S.replace('https:', 'http:'), '--realm', '123', '--stacks-url', 'http://stacks.example.test', '--key', 'garden3d'])).toEqual({
      code: 1,
      out: ['refuse stacks-config'],
      err: [],
    });
    expect(probe(['GET', S, '--realm', '123', '--stacks-url', 'http://stacks.example.test', '--key', 'garden3d'])).toEqual({
      code: 1,
      out: ['refuse stacks-config'],
      err: [],
    });
  });

  it('a Stacks URL with an https --stacks-url and a matching --key is allowed; another key is not', () => {
    const base = ['--realm', '123', '--stacks-url', 'https://stacks.example.test'];
    expect(probe(['GET', S, ...base, '--key', 'garden3d'])).toEqual({ code: 0, out: ['allow stacks'], err: [] });
    expect(probe(['GET', S, ...base, '--key', 'usb-club', '--key', 'garden3d'])).toEqual({ code: 0, out: ['allow stacks'], err: [] });
    expect(probe(['GET', S, ...base, '--key', 'usb-club']).code).toBe(1);
    expect(probe(['GET', S, ...base]).code).toBe(1);
  });

  it('flags may come before the positionals', () => {
    expect(probe(['--realm', '123', 'GET', COMPANYINFO])).toEqual({ code: 0, out: ['allow companyinfo'], err: [] });
  });

  it("each run is the call's first request: a query is allowed on every run", () => {
    const q = 'https://quickbooks.api.intuit.com/v3/company/123/query?query=select%20*%20from%20account%20maxresults%2010&minorversion=75';
    expect(probe(['GET', q, '--realm', '123'])).toEqual({ code: 0, out: ['allow query'], err: [] });
    expect(probe(['GET', q, '--realm', '123'])).toEqual({ code: 0, out: ['allow query'], err: [] });
  });
});

describe('one decide (A2.3)', () => {
  const c = EX.context;
  const ctxArgs = ['--realm', c.realm, '--stacks-url', c.stacksUrl, ...c.keys.flatMap((k: string) => ['--key', k])];

  it.each(EX.examples.map((r: any) => [r.decision, r.case, r]) as Array<[string, string, any]>)('%s: %s', (decision, _case, row) => {
    const r = probe([row.method, row.url, ...ctxArgs]);
    expect(r.err).toEqual([]);
    expect(r.out).toHaveLength(1);
    expect(r.out[0].startsWith(decision === 'allow' ? 'allow ' : 'refuse ')).toBe(true);
    expect(r.code).toBe(decision === 'allow' ? 0 : 1);
  });

  // Static imports and re-exports at a line start, side-effect imports, import() and require() with a literal.
  const IMPORT_RE = /^\s*(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\s*\(\s*["'`]([^"'`]+)["'`]|\brequire\s*\(\s*["'`]([^"'`]+)["'`]/gm;
  const specifiers = (text: string) => [...text.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
  const importsOf = (file: string) => specifiers(fs.readFileSync(path.join(ROOT, file), 'utf8'));

  it('guard-probe.ts imports only ./clients/guard-decide.js', () => {
    expect(importsOf('src/guard-probe.ts')).toEqual(['./clients/guard-decide.js']);
  });

  it('guard-decide.ts imports nothing, so no network module', () => {
    expect(importsOf('src/clients/guard-decide.ts')).toEqual([]);
  });

  it('neither file names axios, node-quickbooks or a network module', () => {
    const banned = ['axios', 'node-quickbooks', 'http', 'https', 'net', 'tls', 'dns', 'http2'];
    for (const f of ['src/guard-probe.ts', 'src/clients/guard-decide.ts']) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const named = banned.filter((b) => new RegExp(`["'\`](?:node:)?${b}(?:/[^"'\`]*)?["'\`]`).test(text));
      expect({ f, named }).toEqual({ f, named: [] });
    }
  });

  it('the import check sees every import form', () => {
    const forms = 'import a from "x1";\nimport "x2";\nawait import("x3");\nrequire(\'x4\');\nexport { b } from "x5";\n// a comment: we read from `here` and from "there"\nimport {\n  c,\n} from "x6";';
    expect(specifiers(forms)).toEqual(['x1', 'x2', 'x3', 'x4', 'x5', 'x6']);
  });
});

describe('the process entry line (T0 pattern)', () => {
  it('runs runProbe when argv[1] names the probe, and sets the exit code', async () => {
    const argv = process.argv;
    const exitCode = process.exitCode;
    const out: string[] = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      out.push(String(chunk));
      return true;
    }) as any);
    try {
      process.argv = [argv[0], '/x/dist/guard-probe.js', 'GET', COMPANYINFO, '--realm', '123'];
      await jest.isolateModulesAsync(async () => {
        await import('../../../src/guard-probe.js');
      });
      expect(out).toEqual(['allow companyinfo\n']);
      expect(process.exitCode).toBe(0);
      process.argv = [argv[0], '/x/src/guard-probe.ts', 'POST', COMPANYINFO, '--realm', '123'];
      out.length = 0;
      await jest.isolateModulesAsync(async () => {
        await import('../../../src/guard-probe.js');
      });
      expect(out).toEqual(['refuse quickbooks\n']);
      expect(process.exitCode).toBe(1);
    } finally {
      spy.mockRestore();
      process.argv = argv;
      process.exitCode = exitCode;
    }
  });

  it('usage errors go to stderr from the entry', async () => {
    const argv = process.argv;
    const exitCode = process.exitCode;
    const err: string[] = [];
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      err.push(String(chunk));
      return true;
    }) as any);
    try {
      process.argv = [argv[0], '/x/dist/guard-probe.js'];
      await jest.isolateModulesAsync(async () => {
        await import('../../../src/guard-probe.js');
      });
      expect(err).toHaveLength(1);
      expect(err[0]).toMatch(/^usage: guard-probe .*\(missing METHOD\)\n$/);
      expect(process.exitCode).toBe(2);
    } finally {
      spy.mockRestore();
      process.argv = argv;
      process.exitCode = exitCode;
    }
  });

  it('importing the module under jest (argv[1] is jest) prints nothing', () => {
    expect(/guard-probe\.[jt]s$/.test(process.argv[1] ?? '')).toBe(false);
  });

  it('with no argv[1] at all (node -e), the entry does not run', async () => {
    const argv = process.argv;
    const exitCode = process.exitCode;
    const writes: string[] = [];
    const o = jest.spyOn(process.stdout, 'write').mockImplementation(((c: string) => (writes.push(String(c)), true)) as any);
    const e = jest.spyOn(process.stderr, 'write').mockImplementation(((c: string) => (writes.push(String(c)), true)) as any);
    try {
      process.argv = [argv[0]];
      await jest.isolateModulesAsync(async () => {
        await import('../../../src/guard-probe.js');
      });
      expect(writes).toEqual([]);
      expect(process.exitCode).toBe(exitCode);
    } finally {
      o.mockRestore();
      e.mockRestore();
      process.argv = argv;
      process.exitCode = exitCode;
    }
  });
});
