// Sanctuary Computer (quickbooks-mcp-286): through the built guard and backstop, a Stacks request to a closed local
// port reaches the socket layer: it fails with the connection's own error (ECONNREFUSED), never a synchronous throw from
// the options the backstop hands Node. Prints one line: `axios <isAxiosError> <code>`. No host is reached; nothing listens there.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const guard = await import(pathToFileURL(path.join(ROOT, 'dist', 'http-guard.js')).href);
const ORIGIN = 'https://127.0.0.1:1';
guard.secureStart({ STACKS_QBO_URL: ORIGIN }, []);
guard.configureGuard({ keys: () => ['garden3d'] });
try {
  await guard.guardedAxios()({ method: 'get', url: `${ORIGIN}/api/qbo/access_token?enterprise=garden3d`, timeout: 5000 });
  process.stdout.write('answered\n');
} catch (e) {
  process.stdout.write(`axios ${e?.isAxiosError === true} ${e?.code}\n`);
}
