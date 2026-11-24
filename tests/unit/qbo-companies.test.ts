// Sanctuary Computer (quickbooks-mcp-285): the qbo_companies tool's name and description.
// Changed by Sanctuary Computer (quickbooks-mcp-286): 285's A9 is A3.8: the handler, given the runtime, answers the loaded
// companies' keys and names exactly as tool-results/qbo_companies/ok.json (through the server: tools/company-tools.test.ts).
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { QboCompaniesTool } from '../../src/tools/qbo-companies.tool';
import { parseCompanies } from '../../src/clients/companies';
import type { Runtime } from '../../src/clients/runtime';

const fake = (name: string) => readFileSync(fileURLToPath(new URL(`../fakes/${name}`, import.meta.url)), 'utf8');

describe('qbo_companies', () => {
  it('A3.8: name, description, and the answer for entities.json is ok.json exactly', async () => {
    expect(QboCompaniesTool.name).toBe('qbo_companies');
    expect(QboCompaniesTool.description).toBe(
      'List the companies this server can read (key, name), for the company argument of every other tool.',
    );
    const runtime = { cfg: { companies: parseCompanies(fake('entities.json')) } } as unknown as Runtime;
    expect(await QboCompaniesTool.handler({}, runtime)).toStrictEqual(JSON.parse(fake('tool-results/qbo_companies/ok.json')));
  });
});
