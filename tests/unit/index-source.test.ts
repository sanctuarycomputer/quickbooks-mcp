// Sanctuary Computer (quickbooks-mcp-285): the entry point registers only through startReadServer.
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const INDEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/index.ts');

describe('src/index.ts', () => {
  it('A8: registers only through startReadServer', () => {
    const text = fs.readFileSync(INDEX, 'utf8');
    expect(text.split('startReadServer(').length - 1).toBe(1);
    for (const s of ['RegisterTool(', 'registerReadTools(', '.tool(', '.registerTool(', 'setRequestHandler(']) {
      expect({ pattern: s, found: text.includes(s) }).toEqual({ pattern: s, found: false });
    }
  });
});
