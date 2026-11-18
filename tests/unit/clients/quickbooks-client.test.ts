// Sanctuary Computer (quickbooks-mcp-285): the client has no token source until the Stacks token client lands.
import { describe, it, expect, afterAll } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLIENT = path.join(ROOT, 'src/clients/quickbooks-client.ts');

const saved: Record<string, string | undefined> = {};
for (const key of Object.keys(process.env)) {
  if (key.startsWith('QUICKBOOKS_')) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
}
afterAll(() => {
  Object.assign(process.env, saved);
});

describe('QuickbooksClient', () => {
  it('R4: import has no side effects', async () => {
    const before = process.listenerCount('uncaughtException') + process.listenerCount('unhandledRejection');
    await expect(import('../../../src/clients/quickbooks-client.js')).resolves.toBeDefined();
    const after = process.listenerCount('uncaughtException') + process.listenerCount('unhandledRejection');
    expect(after).toBe(before);
  });

  it('R4: client source has no env, process hooks or fs', () => {
    const text = fs.readFileSync(CLIENT, 'utf8');
    expect(text).not.toContain('process.env');
    expect(text).not.toContain('process.on');
    expect(text).not.toMatch(/\bfrom\s*["'](?:node:)?(?:fs|path)["']/);
    expect(text).not.toMatch(/\b(?:import|require)\s*\(\s*["'](?:node:)?(?:fs|path)["']/);
  });

  it('R4: getInstance rejects', async () => {
    const { QuickbooksClient } = await import('../../../src/clients/quickbooks-client.js');
    await expect(QuickbooksClient.getInstance()).rejects.toThrow(/^no QuickBooks token source$/);
  });
});
