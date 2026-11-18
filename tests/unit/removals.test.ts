// Sanctuary Computer (quickbooks-mcp-285): the removed sign-in flow, token store, upload and switches stay gone.
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
  'QUICKBOOKS_ENVIRONMENT',
];

const NETWORK_IMPORT =
  /\b(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:node:)?(?:open|http|https|http2|net|tls|dns|dns\/promises|dgram|child_process|worker_threads)["']/;

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
    for (const name of REMOVED_PACKAGES) {
      if (Object.prototype.hasOwnProperty.call(lock.packages, `node_modules/${name}`)) {
        found.push(`package-lock.json packages.node_modules/${name}`);
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
      if (NETWORK_IMPORT.test(text)) hits.push(`${f}: network module import ${text.match(NETWORK_IMPORT)![0]}`);
      if (text.includes('writeFileSync') && f !== 'src/tools/get-invoice-pdf.tool.ts') hits.push(`${f}: writeFileSync`);
      text.split('\n').forEach((line, i) => {
        for (const k of KEY_NAMES) {
          if (line.includes(k) && !(f === 'src/allowlist.ts' && line.includes('REFUSED_KEYS'))) {
            hits.push(`${f}:${i + 1}: ${k}`);
          }
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it('A7: no QUICKBOOKS_DISABLE text in src', () => {
    const hits = srcFiles().filter((f) => read(f).includes('QUICKBOOKS_' + 'DISABLE'));
    expect(hits).toEqual([]);
  });
});
