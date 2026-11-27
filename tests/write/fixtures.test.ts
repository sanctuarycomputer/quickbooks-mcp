// Sanctuary Computer (quickbooks-mcp-294): spec A3.1. 292's tool-calls/, tool-results/, receipt-cmd/ and sweep-stamp/ are copied whole
// from Stacksbot's docs/contracts/quickbooks/ and never edited: tests/fakes/manifest.json names every file with the SHA-256 of its text,
// CRLF made LF (a Windows checkout writes CRLF; plan ruling d-20261127-044022509). The byte-for-byte check is verification.md's diff -r.
import { createHash } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';

const FAKES = fileURLToPath(new URL('../fakes/', import.meta.url));
const DIRS = ['tool-calls', 'tool-results', 'receipt-cmd', 'sweep-stamp'];

const lfHash = (file: string): string => createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), 'utf8').digest('hex');

/** Every file under `dir`, as `dir/rel` with `/` separators, sorted. */
function walk(dir: string): string[] {
  const out: string[] = [];
  const go = (rel: string): void => {
    for (const name of readdirSync(FAKES + rel)) {
      const child = `${rel}/${name}`;
      if (statSync(FAKES + child).isDirectory()) go(child);
      else out.push(child);
    }
  };
  go(dir);
  return out.sort();
}

describe('A3.1: the copied fixtures', () => {
  const manifest: { source: string; files: Record<string, string> } = JSON.parse(readFileSync(FAKES + 'manifest.json', 'utf8'));

  it('names the four directories and nothing else', () => {
    expect([...new Set(Object.keys(manifest.files).map((rel) => rel.split('/')[0]))].sort()).toEqual([...DIRS].sort());
    expect(manifest.source).toMatch(/^[0-9a-f]{40}$/);
  });

  it.each(DIRS)('%s/ holds exactly the manifest’s files', (dir) => {
    expect(walk(dir)).toEqual(Object.keys(manifest.files).filter((rel) => rel.startsWith(`${dir}/`)).sort());
  });

  it.each(DIRS)('%s/ files have the manifest’s hashes', (dir) => {
    for (const rel of walk(dir)) expect([rel, lfHash(FAKES + rel)]).toEqual([rel, manifest.files[rel]]);
  });

  it('holds 292’s receipt vectors and sweep stamps', () => {
    expect(walk('receipt-cmd').length).toBeGreaterThan(0);
    expect(walk('sweep-stamp')).toContain('sweep-stamp/clean.json');
  });
});
