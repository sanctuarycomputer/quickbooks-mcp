// Sanctuary Computer (quickbooks-mcp-286): the tests' Result grammar reader (tests/helpers/result-grammar.ts) reads every
// read-tool error fixture, and refuses each break of contract §5's error grammar, one case per rule.
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import { readError } from '../../helpers/result-grammar.js';
import { fakePath } from '../../helpers/server.js';

const err = (text: string, ...warnings: string[]) => ({ isError: true, content: [text, ...warnings].map((t) => ({ type: 'text', text: t })) });
const NAME = 'reason: name-mismatch\nsource: stacks\nreported: Garden Three LLC\n\nfree';

describe('readError', () => {
  it("reads every read-tool error fixture (get_company_info's), the SDK input error aside", () => {
    const dir = fakePath('tool-results/get_company_info');
    const files = fs.readdirSync(dir).filter((f) => !f.startsWith('ok-') && f !== 'fork-error-sdk-input.json');
    expect(files).toHaveLength(11);
    for (const f of files) {
      const r = readError(JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')));
      expect(f.replace(/\.json$/, '').startsWith(r.reason.replace(':', '-').replace(/-(stacks|quickbooks)$/, ''))).toBe(true);
    }
    expect(readError(JSON.parse(fs.readFileSync(`${dir}/http-500.json`, 'utf8'))).intuit_tid).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it('gives every header value, the free text and the warnings', () => {
    expect(readError(err('reason: http-500\nintuit_tid: t-1\n\nQuickBooks answered 500.', 'WARNING: w'))).toEqual({
      reason: 'http-500',
      intuit_tid: 't-1',
      free: 'QuickBooks answered 500.',
      warnings: ['WARNING: w'],
    });
    expect(readError(err(NAME))).toEqual({ reason: 'name-mismatch', source: 'stacks', reported: 'Garden Three LLC', free: 'free', warnings: [] });
    expect(readError(err('reason: timeout\nintuit_tid: t\n\n')).intuit_tid).toBe('t');
    expect(readError(err('reason: fork-error\n\n')).free).toBe('');
  });

  it.each([
    ['isError not true', { content: [{ type: 'text', text: 'reason: fork-error\n\n' }] }, 'not an error'],
    ['isError a string', { isError: 'true', content: [{ type: 'text', text: 'reason: fork-error\n\n' }] }, 'not an error'],
    ['no content', { isError: true, content: [] }, 'no content'],
    ['an item not text', { isError: true, content: [{ type: 'image', text: 'reason: fork-error\n\n' }] }, 'not text'],
    ['no empty line', err('reason: fork-error\nfree'), 'no empty line'],
    ['an empty first line', err('\nreason: fork-error\n\n'), 'no header line'],
    ['a line without ": "', err('reason:fork-error\n\n'), 'not a header line'],
    ['a key outside the table', err('reason: fork-error\nnote: x\n\n'), 'not a header line'],
    ['a key in another case', err('Reason: fork-error\n\n'), 'not a header line'],
    ['reported before source', err('reason: name-mismatch\nreported: X\nsource: stacks\n\n'), 'out of order'],
    ['a repeated key', err('reason: fork-error\nreason: fork-error\n\n'), 'out of order or repeated'],
    ['an empty value', err('reason: http-500\nintuit_tid: \n\n'), 'empty value'],
    ['no reason', err('intuit_tid: t\n\n'), 'no reason line'],
    ['an unknown reason', err('reason: ok\n\n'), 'unknown reason'],
    ['a reason with a bad renewal code', err('reason: renewal-failed:a b\n\n'), 'unknown reason'],
    ['source without name-mismatch', err('reason: fork-error\nsource: stacks\n\n'), 'go with name-mismatch'],
    ['reported without name-mismatch', err('reason: fork-error\nreported: X\n\n'), 'go with name-mismatch'],
    ['name-mismatch without reported', err('reason: name-mismatch\nsource: stacks\n\n'), 'go with name-mismatch'],
    ['name-mismatch without source', err('reason: name-mismatch\nreported: X\n\n'), 'go with name-mismatch'],
    ['another source', err('reason: name-mismatch\nsource: check\nreported: X\n\n'), 'source check'],
    ['reported with a trailing space', err('reason: name-mismatch\nsource: stacks\nreported: X \n\n'), 'name rule'],
    ['reported with a control character', err('reason: name-mismatch\nsource: stacks\nreported: X\tY\n\n'), 'name rule'],
    ['reported with U+2028', err('reason: name-mismatch\nsource: stacks\nreported: X\u2028Y\n\n'), 'name rule'],
    ['reported of 201 ASCII characters', err(`reason: name-mismatch\nsource: stacks\nreported: ${'x'.repeat(201)}\n\n`), 'name rule'],
    ['reported over 200 code points', err(`reason: name-mismatch\nsource: stacks\nreported: ${'\u{1F600}'.repeat(201)}\n\n`), 'name rule'],
    ['intuit_tid with fork-error', err('reason: fork-error\nintuit_tid: t\n\n'), 'only with http-<status> and timeout'],
    ['an intuit_tid off the pattern', err('reason: http-500\nintuit_tid: t_1\n\n'), 'intuit_tid t_1'],
    ['a later item not a WARNING:', err('reason: fork-error\n\n', 'note'), 'not a WARNING:'],
    ['a WARNING: over 2,000', err('reason: fork-error\n\n', `WARNING: ${'w'.repeat(1992)}`), 'not a WARNING:'],
  ])('refuses %s', (_label, result, message) => {
    expect(() => readError(result)).toThrow(message);
  });

  it('takes a name of exactly 200 code points and a WARNING: of exactly 2,000', () => {
    expect(readError(err(`reason: name-mismatch\nsource: quickbooks\nreported: ${'\u{1F600}'.repeat(200)}\n\n`)).reported).toHaveLength(400);
    expect(readError(err('reason: fork-error\n\n', `WARNING: ${'w'.repeat(1991)}`)).warnings[0]).toHaveLength(2000);
  });
});
