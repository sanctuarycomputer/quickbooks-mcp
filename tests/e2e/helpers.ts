// Sanctuary Computer (quickbooks-mcp-285): spawn the built server, raw or through the SDK client, for end-to-end checks.
// Changed by Sanctuary Computer (quickbooks-mcp-286): every spawned server gets the five start keys and an entities file
// (startEnv), and the company reserve is 0: the real `company` enum is in tools/list now (A5.14).
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = path.join(ROOT, 'dist', 'index.js');

// 286's `company` property is in tools/list itself now, with the enum QBO_COMPANIES loaded, so nothing is reserved for it.
export const COMPANY_RESERVE = 0;

/**
 * The five start keys (contract §3) for a spawned server: tests/fakes/entities.json, and a Stacks origin on the loopback
 * port 1, where nothing listens, so a token fetch fails at once (stacks-unreachable) and no host is reached. The key is
 * built at runtime: no secret-shaped literal sits in the tree.
 */
export function startEnv(): Record<string, string> {
  return {
    STACKS_QBO_URL: 'https://127.0.0.1:1',
    STACKS_QBO_TOKEN: ['stacks', 'e2e', 'key', 'value'].join('-'),
    QUICKBOOKS_ENVIRONMENT: 'production',
    QBO_COMPANIES: path.join(ROOT, 'tests', 'fakes', 'entities.json'),
    QBO_MODE: 'read',
  };
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(p));
    else if (entry.name.endsWith('.ts')) newest = Math.max(newest, fs.statSync(p).mtimeMs);
  }
  return newest;
}

/** The spawned tests run dist/: fail loudly when it is missing or older than src/. */
export function assertFreshBuild(): void {
  if (!fs.existsSync(ENTRY) || fs.statSync(ENTRY).mtimeMs < newestMtime(path.join(ROOT, 'src'))) {
    throw new Error('dist is missing or older than src: run npm run build');
  }
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', ...startEnv() };
  // Windows needs SystemRoot for Node's own startup.
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

/** Runs dist/index.js with exactly the given env (plus PATH, the five start keys, and SystemRoot on Windows), stdin closed. */
export function spawnRaw(
  env: Record<string, string>,
  timeoutMs = 10000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd: ROOT,
      env: { ...baseEnv(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Connects the SDK client to dist/index.js; the SDK adds its default variables (HOME, PATH, …) to env. */
export async function connectClient(
  env: Record<string, string> = {},
): Promise<{ client: Client; transport: StdioClientTransport; stderr: () => string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    cwd: ROOT,
    env: { ...baseEnv(), ...env },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (d) => (stderr += d));
  const client = new Client({ name: 'quickbooks-mcp-285-e2e', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}
