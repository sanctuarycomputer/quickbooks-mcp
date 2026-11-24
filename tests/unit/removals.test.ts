// Sanctuary Computer (quickbooks-mcp-285): the removed sign-in flow, token store, upload and switches stay gone.
// Changed by Sanctuary Computer (quickbooks-mcp-291): src/http-guard.ts may load http, https and http2 (it pins and wraps them), and nothing else on the network list.
// Changed by Sanctuary Computer (quickbooks-mcp-286): and node:tls, for the one value it reads (tls.checkServerIdentity, the identity check it hands Node);
// TB10-2: any other read of tls (destructuring, a bracket, an alias, another import binding) is refused. T13-4: so is a write to tls.checkServerIdentity (assigned or deleted).
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function srcFiles(dir = 'src'): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...srcFiles(rel));
    else if (entry.name.endsWith('.ts')) out.push(rel);
  }
  return out.sort();
}

const REMOVED_FILES = [
  'src/auth-server.ts',
  'src/handlers/create-quickbooks-attachable.handler.ts',
  'src/helpers/attachable-file-source.ts',
  'src/tools/create-attachable.tool.ts',
  'src/types/open.d.ts',
  'src/types/intuit-oauth.d.ts',
  'scripts/capture-balance-sheet.mjs',
  'scripts/capture-balance-sheet-raw.mjs',
];

const REMOVED_PACKAGES = ['intuit-oauth', 'open', 'dotenv'];

// Built from parts so this file never carries the swept text as one literal elsewhere.
const SWEPT_TEXT = [
  'intuit-oauth',
  'dotenv',
  'createServer',
  'getAuth' + 'Credentials',
  'renameSync',
  'unlinkSync',
  'createWriteStream',
  'appendFileSync',
  '.request(',
  'fetch(',
  'QUICKBOOKS_TOKEN_STORE_PATH',
  'QUICKBOOKS_REDIRECT_URI',
  'QUICKBOOKS_ATTACHABLE',
];

// The module's name as a string literal anywhere: every way to load it (from, a side-effect import,
// import() with or without comments, require(), process.getBuiltinModule()) has to spell it so.
// Any quote (backticks included), bare or `node:`, and any subpath (`dns/promises`).
function moduleLoad(names: string): RegExp {
  return new RegExp('["\'`](?:node:)?(?:' + names + ')(?:/[^"\'`]*)?["\'`]');
}

const NETWORK_IMPORT = moduleLoad('open|http|https|http2|net|tls|dns|dgram|child_process|worker_threads');
// The guard (quickbooks-mcp-291) is the one file that loads network modules, and only these four, each by its node: name
// (node:tls for tls.checkServerIdentity only: 286 T10 step 6).
const GUARD_FILE = 'src/http-guard.ts';
const GUARD_LOADS = ['"node:http"', '"node:https"', '"node:http2"', '"node:tls"'];

/** The network-module loads a file's text spells; for the guard file only, its own four and axios' adapter name (`getAdapter("http")`) are left out. */
function networkLoads(f: string, text: string): string[] {
  const t = f === GUARD_FILE ? text.split('getAdapter("http")').join('getAdapter()') : text;
  const all = t.match(new RegExp(NETWORK_IMPORT.source, 'g')) ?? [];
  return f === GUARD_FILE ? all.filter((m) => !GUARD_LOADS.includes(m)) : all;
}

const TLS_IMPORT = 'import tls from "node:tls";';
/**
 * The guard's uses of node:tls other than reading its one value (TB10-2, T13-4): node:tls loaded other than by
 * TLS_IMPORT once, and every line with a `tls` word left once that import, the module's name and each
 * `tls.checkServerIdentity` read are taken out (a destructuring, a bracket read, an alias, `tls.connect`). A write to
 * the member stays: one assigned (`=`, a compound `op=`, `++`/`--`, but not `==`) or deleted.
 */
const TLS_VALUE_READ = /(?<!\bdelete\s+)\btls\.checkServerIdentity\b(?!\s*(?:=(?!=)|\+\+|--|(?:[-+*/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)=))/g;
function tlsReads(text: string): string[] {
  const out: string[] = [];
  const loads = text.split('"node:tls"').length - 1;
  if (loads !== 1 || !text.includes(TLS_IMPORT)) out.push(`node:tls loaded ${loads} time(s), ${text.includes(TLS_IMPORT) ? 'with' : 'without'} ${TLS_IMPORT}`);
  const rest = text.split(TLS_IMPORT).join('').split('"node:tls"').join('').replace(TLS_VALUE_READ, '');
  for (const line of rest.split('\n')) if (/\btls\b/.test(line)) out.push(line.trim());
  return out;
}

const KEY_NAMES = ['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN', 'REALM_ID'].map((k) => 'QUICKBOOKS_' + k);

describe('removals', () => {
  it('R1: removed files are absent', () => {
    const present = REMOVED_FILES.filter((f) => fs.existsSync(path.join(ROOT, f)));
    expect(present).toEqual([]);
  });

  it('R2: removed packages and the auth script are gone', () => {
    const pkg = JSON.parse(read('package.json'));
    const found: string[] = [];
    for (const block of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of REMOVED_PACKAGES) {
        if (pkg[block] && Object.prototype.hasOwnProperty.call(pkg[block], name)) found.push(`package.json ${block}.${name}`);
      }
    }
    if (pkg.scripts && pkg.scripts.auth !== undefined) found.push('package.json scripts.auth');
    const lock = JSON.parse(read('package-lock.json'));
    for (const key of Object.keys(lock.packages)) {
      for (const name of REMOVED_PACKAGES) {
        if (key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`)) found.push(`package-lock.json packages.${key}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('R3: no removed code or network module in src', () => {
    const files = srcFiles();
    expect(files).toContain('src/index.ts');
    const hits: string[] = [];
    for (const f of files) {
      const text = read(f);
      for (const s of SWEPT_TEXT) if (text.includes(s)) hits.push(`${f}: ${s}`);
      for (const m of networkLoads(f, text)) hits.push(`${f}: network module import ${m}`);
      if (text.includes('writeFileSync') && f !== 'src/tools/get-invoice-pdf.tool.ts') hits.push(`${f}: writeFileSync`);
      text.split('\n').forEach((line, i) => {
        for (const k of KEY_NAMES) {
          if (line.includes(k) && !(f === 'src/allowlist.ts' && line.startsWith('export const REFUSED_KEYS'))) {
            hits.push(`${f}:${i + 1}: ${k}`);
          }
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it("R3: the guard's exemption covers its four modules in that file only", () => {
    expect(networkLoads(GUARD_FILE, 'import a from "node:https"; import b from "node:http"; import c from "node:http2"; import d from "node:tls";')).toEqual([]);
    expect(networkLoads(GUARD_FILE, 'import a from "node:net"; import b from "https"; import c from \'node:http\'; import d from "tls";')).toEqual([
      '"node:net"',
      '"https"',
      "'node:http'",
      '"tls"',
    ]);
    expect(networkLoads('src/index.ts', 'import t from "node:tls"')).toEqual(['"node:tls"']);
    expect(networkLoads(GUARD_FILE, 'ax.getAdapter("http"); require("http")')).toEqual(['"http"']);
    expect(networkLoads('src/index.ts', 'import a from "node:https"; ax.getAdapter("http")')).toEqual(['"node:https"', '"http"']);
    expect(read(GUARD_FILE)).toContain('"node:https"');
    // node:tls is loaded for one value (T10-4, TB10-2): the guard reads tls only as tls.checkServerIdentity.
    expect(tlsReads(read(GUARD_FILE))).toEqual([]);
    expect(read(GUARD_FILE)).toContain('send.checkServerIdentity = tls.checkServerIdentity;');
  });

  it.each([
    ['destructuring', 'const { connect } = tls;', ['const { connect } = tls;']],
    ['a bracket read', 'tls["connect"](o);', ['tls["connect"](o);']],
    ['an alias', 'const t = tls;\nt.connect(o);', ['const t = tls;']],
    ['another member', 'tls.connect(o);', ['tls.connect(o);']],
    ['a second import binding', 'import * as t from "node:tls";', ['node:tls loaded 2 time(s), with import tls from "node:tls";']],
    ['writing its member (T13-4)', 'tls.checkServerIdentity = () => undefined;', ['tls.checkServerIdentity = () => undefined;']],
    ['a compound write to its member (T13-4)', 'tls.checkServerIdentity ??= f;', ['tls.checkServerIdentity ??= f;']],
    ['deleting its member (T13-4)', 'delete tls.checkServerIdentity;', ['delete tls.checkServerIdentity;']],
  ])('R3: the guard reading tls by %s is refused (TB10-2)', (_form, added, found) => {
    const text = `${TLS_IMPORT}\nx.checkServerIdentity = tls.checkServerIdentity;\n${added}`;
    expect(tlsReads(text)).toEqual(found);
  });

  it('R3: the guard without its import, or loading node:tls under another binding, is refused (TB10-2)', () => {
    expect(tlsReads('import t from "node:tls";\nt.checkServerIdentity;')).toEqual(['node:tls loaded 1 time(s), without import tls from "node:tls";']);
    expect(tlsReads(`${TLS_IMPORT}\n// tls.checkServerIdentity, Node's own\nsend.c = tls.checkServerIdentity;`)).toEqual([]);
    // A comparison reads the member; it is not a write (T13-4).
    expect(tlsReads(`${TLS_IMPORT}\nif (f === tls.checkServerIdentity) g();\nif (tls.checkServerIdentity == f) g();`)).toEqual([]);
  });

  it('A7: no QUICKBOOKS_DISABLE text in src', () => {
    const hits = srcFiles().filter((f) => read(f).includes('QUICKBOOKS_' + 'DISABLE'));
    expect(hits).toEqual([]);
  });
});
