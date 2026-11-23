// Sanctuary Computer (quickbooks-mcp-291): under plain Node, ESM named and namespace imports of node:https see the backstop (syncBuiltinESMExports).
// Run with --import tests/fixtures/no-network.mjs after npm run build; prints one line per import form.
import { request } from 'node:https';
import * as httpsNamespace from 'node:https';

const { installBackstop } = await import('../../dist/http-guard.js');
installBackstop();

const url = 'https://quickbooks.api.intuit.com/v3/company/9990000000000002/upload';
for (const [label, call] of [
  ['named', () => request(url, { method: 'POST' })],
  ['namespace', () => httpsNamespace.request(url, { method: 'POST' })],
]) {
  try {
    call();
    process.stdout.write(`${label}: not refused\n`);
  } catch (e) {
    const refused = e && e.name === 'GuardRefusedError' && e.rule === 'backstop';
    process.stdout.write(`${label}: ${refused ? 'refused' : 'error'}\n`);
  }
}
