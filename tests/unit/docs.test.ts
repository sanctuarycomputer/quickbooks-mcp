// Sanctuary Computer (quickbooks-mcp-286): the docs name the five keys the server reads and none of the removed ones (A5.8).
// `checkDocs` is the only statement of each rule: the cases run it on the real files, and the mutation rows run the same
// function on altered text, after a passing baseline. Line ends are normalised first, so a Windows checkout reads the same.
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lf = (text: string): string => text.replace(/\r\n/g, '\n');
const read = (rel: string): string => lf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

type Texts = { readme: string; env: string; architecture: string };
const REAL: Texts = { readme: read('README.md'), env: read('.env.example'), architecture: read('docs/ARCHITECTURE.md') };

const REQUIRED_KEYS = ['STACKS_QBO_URL', 'STACKS_QBO_TOKEN', 'QBO_COMPANIES', 'QUICKBOOKS_ENVIRONMENT'];

// Built from parts so this file never carries the removed names as one literal. The first is a prefix: any `QUICKBOOKS_CLIENT_*`.
const q = 'QUICKBOOKS' + '_';
const REMOVED = [q + 'CLIENT_', q + 'REFRESH_TOKEN', q + 'REALM_ID', q + 'REDIRECT_URI', q + 'TOKEN_STORE_PATH', 'npm run ' + 'auth'];

const FILES = ['README', '.env.example', 'ARCHITECTURE'] as const;
const PLACEHOLDERS = ['https://stacks.example', 'replace-me', '/path/to/entities.json', 'production'];

/** True if `key` appears as a whole name in `text` (not inside a longer one). */
const names = (text: string, key: string): boolean => new RegExp(`(^|[^A-Z_])${key}([^A-Z_]|$)`, 'm').test(text);

const sets = (env: string, key: string): boolean => new RegExp(`^${key}=`, 'm').test(env);

/** Every rule, by the name a failure gives it. */
const RULES: string[] = [
  ...REQUIRED_KEYS.flatMap((k) => [`README names ${k}`, `.env.example sets ${k}`]),
  'README names QBO_MODE',
  'README marks QBO_MODE optional',
  '.env.example marks QBO_MODE optional',
  '.env.example placeholders',
  ...FILES.flatMap((f) => REMOVED.map((r) => `${f} has no removed name ${r}`)),
];

/** The rules the given texts break. Line ends are normalised, so CRLF files are read as LF ones. */
function checkDocs(raw: Texts): string[] {
  const { readme, env, architecture } = { readme: lf(raw.readme), env: lf(raw.env), architecture: lf(raw.architecture) };
  const failed: string[] = [];
  for (const key of REQUIRED_KEYS) {
    if (!names(readme, key)) failed.push(`README names ${key}`);
    if (!sets(env, key)) failed.push(`.env.example sets ${key}`);
  }
  if (!names(readme, 'QBO_MODE')) failed.push('README names QBO_MODE');
  if (!/^\| `QBO_MODE` \| optional \|/m.test(readme)) failed.push('README marks QBO_MODE optional');
  if (!/^# Optional\.[^\n]*\n# QBO_MODE=read$/m.test(env)) failed.push('.env.example marks QBO_MODE optional');
  const values = env.split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.slice(l.indexOf('=') + 1));
  if (JSON.stringify(values) !== JSON.stringify(PLACEHOLDERS)) failed.push('.env.example placeholders');
  const text: Record<(typeof FILES)[number], string> = { README: readme, '.env.example': env, ARCHITECTURE: architecture };
  for (const f of FILES) for (const r of REMOVED) if (text[f].includes(r)) failed.push(`${f} has no removed name ${r}`);
  return failed;
}

describe('docs', () => {
  it.each(RULES)('%s', (rule) => {
    expect(checkDocs(REAL)).not.toContain(rule);
  });

  describe('mutations', () => {
    const rows: Array<[string, Texts, string | null]> = [
      ...FILES.flatMap((f) =>
        [...REMOVED, q + 'CLIENT_KEY'].map((r): [string, Texts, string | null] => {
          const add = (t: string) => `${t}\n${r}=x\n`;
          const t = { ...REAL };
          if (f === 'README') t.readme = add(t.readme);
          else if (f === '.env.example') t.env = add(t.env);
          else t.architecture = add(t.architecture);
          return [`${r} put back into ${f}`, t, `${f} has no removed name ${r === q + 'CLIENT_KEY' ? REMOVED[0] : r}`];
        }),
      ),
      ...REQUIRED_KEYS.flatMap((k): Array<[string, Texts, string | null]> => [
        [`${k} dropped from README`, { ...REAL, readme: REAL.readme.split(k).join('DROPPED') }, `README names ${k}`],
        [`${k} dropped from .env.example`, { ...REAL, env: REAL.env.split(k).join('DROPPED') }, `.env.example sets ${k}`],
      ]),
      ['QBO_MODE dropped from README', { ...REAL, readme: REAL.readme.split('QBO_MODE').join('DROPPED') }, 'README names QBO_MODE'],
      ['README stops marking QBO_MODE optional', { ...REAL, readme: REAL.readme.replace('| `QBO_MODE` | optional |', '| `QBO_MODE` | yes |') }, 'README marks QBO_MODE optional'],
      ['.env.example stops marking QBO_MODE optional', { ...REAL, env: REAL.env.replace('# Optional.', '# Needed.') }, '.env.example marks QBO_MODE optional'],
      ['a placeholder changed', { ...REAL, env: REAL.env.replace('replace-me', 'changed-value') }, '.env.example placeholders'],
      ['a placeholder line removed', { ...REAL, env: REAL.env.replace('QBO_COMPANIES=/path/to/entities.json\n', '') }, '.env.example placeholders'],
      // CRLF line ends, as a Windows checkout writes them: every rule must still pass.
      ['.env.example with CRLF line ends', { ...REAL, env: REAL.env.replace(/\n/g, '\r\n') }, null],
      ['README.md with CRLF line ends', { ...REAL, readme: REAL.readme.replace(/\n/g, '\r\n') }, null],
      ['docs/ARCHITECTURE.md with CRLF line ends', { ...REAL, architecture: REAL.architecture.replace(/\n/g, '\r\n') }, null],
    ];

    it('baseline: the unaltered files break no rule', () => {
      expect(checkDocs(REAL)).toEqual([]);
    });

    it.each(rows)('%s', (_name, texts, expected) => {
      const failed = checkDocs(texts);
      if (expected === null) expect(failed).toEqual([]);
      else expect(failed).toContain(expected);
    });
  });
});
