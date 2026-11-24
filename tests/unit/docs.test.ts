// Sanctuary Computer (quickbooks-mcp-286): the docs name the five keys the server reads and none of the removed ones (A5.8).
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const README = read('README.md');
const ENV_EXAMPLE = read('.env.example');
const ARCHITECTURE = read('docs/ARCHITECTURE.md');

const REQUIRED_KEYS = ['STACKS_QBO_URL', 'STACKS_QBO_TOKEN', 'QBO_COMPANIES', 'QUICKBOOKS_ENVIRONMENT'];

// Built from parts so this file never carries the removed names as one literal.
const q = 'QUICKBOOKS' + '_';
const REMOVED = [
  q + 'CLIENT_ID',
  q + 'CLIENT_SECRET',
  q + 'REFRESH_TOKEN',
  q + 'REALM_ID',
  q + 'REDIRECT_URI',
  q + 'TOKEN_STORE_PATH',
  'npm run ' + 'auth',
];

/** The text of `.env.example` with comment lines kept: a key is named if it appears anywhere in the file. */
const names = (text: string, key: string): boolean => new RegExp(`(^|[^A-Z_])${key}([^A-Z_]|$)`, 'm').test(text);

/** The README row for a key in its configuration table. */
const readmeRow = (key: string): string | undefined => README.split('\n').find((l) => l.startsWith('| `' + key + '`'));

/** The assertions, run on the two files given; the mutation harness calls them on altered text. */
export function checkDocs(readme: string, env: string): string[] {
  const problems: string[] = [];
  for (const key of REQUIRED_KEYS) {
    if (!names(readme, key)) problems.push(`README names ${key}`);
    if (!new RegExp(`^${key}=`, 'm').test(env)) problems.push(`.env.example sets ${key}`);
  }
  if (!names(readme, 'QBO_MODE')) problems.push('README names QBO_MODE');
  if (!/^\| `QBO_MODE` \| optional \|/m.test(readme)) problems.push('README marks QBO_MODE optional');
  if (!/^# QBO_MODE=read$/m.test(env) || !/^# Optional\./m.test(env.split('QBO_MODE')[0].split('\n').slice(-2).join('\n'))) {
    problems.push('.env.example marks QBO_MODE optional');
  }
  for (const [label, text] of [['README', readme], ['.env.example', env]] as const) {
    for (const removed of REMOVED) if (text.includes(removed)) problems.push(`${label} has no removed name ${removed}`);
  }
  return problems;
}

describe('docs', () => {
  it('names the four required keys in README.md and .env.example', () => {
    expect(REQUIRED_KEYS.filter((k) => !names(README, k) || !new RegExp(`^${k}=`, 'm').test(ENV_EXAMPLE))).toEqual([]);
  });

  it('names QBO_MODE and marks it optional in both files', () => {
    expect(readmeRow('QBO_MODE')).toContain('optional');
    expect(ENV_EXAMPLE).toMatch(/# Optional\.[^\n]*\n# QBO_MODE=read/);
  });

  it('has no removed key and no `npm run auth` in README.md, .env.example or docs/ARCHITECTURE.md', () => {
    for (const text of [README, ENV_EXAMPLE, ARCHITECTURE]) {
      expect(REMOVED.filter((r) => text.includes(r))).toEqual([]);
    }
  });

  it('passes as a whole', () => {
    expect(checkDocs(README, ENV_EXAMPLE)).toEqual([]);
  });

  it('keeps every placeholder value free of anything that looks like a secret', () => {
    const values = ENV_EXAMPLE.split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split('=')[1]);
    expect(values).toEqual(['https://stacks.example', 'replace-me', '/path/to/entities.json', 'production']);
  });

  describe('mutations', () => {
    it('baseline: the unaltered files pass', () => {
      expect(checkDocs(README, ENV_EXAMPLE)).toEqual([]);
    });

    it.each(REMOVED)('fails when %s is put back into README.md', (removed) => {
      expect(checkDocs(README + `\n${removed}\n`, ENV_EXAMPLE)).toContain(`README has no removed name ${removed}`);
    });

    it.each(REMOVED)('fails when %s is put back into .env.example', (removed) => {
      expect(checkDocs(README, ENV_EXAMPLE + `\n${removed}=x\n`)).toContain(`.env.example has no removed name ${removed}`);
    });

    it.each(REQUIRED_KEYS)('fails when %s is dropped from README.md', (key) => {
      expect(checkDocs(README.split(key).join('DROPPED'), ENV_EXAMPLE)).toContain(`README names ${key}`);
    });

    it.each(REQUIRED_KEYS)('fails when %s is dropped from .env.example', (key) => {
      expect(checkDocs(README, ENV_EXAMPLE.split(key).join('DROPPED'))).toContain(`.env.example sets ${key}`);
    });

    it('fails when QBO_MODE is dropped from README.md', () => {
      expect(checkDocs(README.split('QBO_MODE').join('DROPPED'), ENV_EXAMPLE)).toContain('README names QBO_MODE');
    });

    it('fails when README.md stops marking QBO_MODE optional', () => {
      expect(checkDocs(README.replace('| `QBO_MODE` | optional |', '| `QBO_MODE` | yes |'), ENV_EXAMPLE)).toContain('README marks QBO_MODE optional');
    });

    it('fails when .env.example stops marking QBO_MODE optional', () => {
      expect(checkDocs(README, ENV_EXAMPLE.replace('# Optional.', '# Needed.'))).toContain('.env.example marks QBO_MODE optional');
    });
  });
});
