// Sanctuary Computer (quickbooks-mcp-285): lockfile floors for the advisories the dependency bump fixes.
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

function entries(name: string): Array<{ key: string; version: string }> {
  return Object.entries(lock.packages as Record<string, { version?: string }>)
    .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))
    .map(([key, v]) => ({ key, version: v.version ?? '' }));
}

function atLeast(version: string, floor: string): boolean {
  const a = version.split('-')[0].split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

describe('dependency floors', () => {
  it('P6: axios is one copy at 1.20.0 or later', () => {
    const found = entries('axios');
    expect(found).toHaveLength(1);
    expect({ ...found[0], ok: atLeast(found[0].version, '1.20.0') }).toMatchObject({ ok: true });
  });

  it('P6: follow-redirects at 1.16.2 or later', () => {
    const found = entries('follow-redirects');
    expect(found.length).toBeGreaterThan(0);
    for (const e of found) expect({ ...e, ok: atLeast(e.version, '1.16.2') }).toMatchObject({ ok: true });
  });

  it('P6: SDK at 1.32.0 or later', () => {
    const found = entries('@modelcontextprotocol/sdk');
    expect(found.length).toBeGreaterThan(0);
    for (const e of found) expect({ ...e, ok: atLeast(e.version, '1.32.0') }).toMatchObject({ ok: true });
  });

  it('P6: zod major 4', () => {
    const found = entries('zod');
    expect(found.length).toBeGreaterThan(0);
    for (const e of found) expect({ ...e, major: e.version.split('.')[0] }).toMatchObject({ major: '4' });
  });

  it('atLeast compares numerically', () => {
    expect(atLeast('1.20.0', '1.20.0')).toBe(true);
    expect(atLeast('1.100.0', '1.20.0')).toBe(true);
    expect(atLeast('1.19.9', '1.20.0')).toBe(false);
    expect(atLeast('2.0.0', '1.20.0')).toBe(true);
    expect(atLeast('0.99.0', '1.0.0')).toBe(false);
  });
});
