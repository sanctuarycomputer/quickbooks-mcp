// Sanctuary Computer (quickbooks-mcp-285, quickbooks-mcp-286): the client's source stays free of env, process hooks and fs;
// outside a tool call getInstance throws (A3.3; the in-call cases are in quickbooks-client.company.test.ts).
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
    const count = () => process.eventNames().reduce((n, e) => n + process.listenerCount(e), 0);
    const before = count();
    await expect(import('../../../src/clients/quickbooks-client.js')).resolves.toBeDefined();
    expect(count()).toBe(before);
  });

  it('R4: client source has no env, process hooks or fs', () => {
    const text = fs.readFileSync(CLIENT, 'utf8');
    expect(text).not.toMatch(/\bprocess\s*(?:\.\s*env\b|\[)/);
    // Every listener method: on, once, addListener, prependListener, prependOnceListener.
    expect(text).not.toMatch(/\bprocess\s*\.\s*(?:on|once|addListener|prependListener|prependOnceListener)\b/);
    // fs or path named as a string literal, which every way to load them needs: any quote, bare or node:, any subpath.
    expect(text).not.toMatch(/["'`](?:node:)?(?:fs|path)(?:\/[^"'`]*)?["'`]/);
  });

  it('R4 / A3.3: getInstance outside a tool call throws', async () => {
    const { QuickbooksClient } = await import('../../../src/clients/quickbooks-client.js');
    await expect(QuickbooksClient.getInstance()).rejects.toThrow(/^getInstance outside a tool call$/);
  });
});
