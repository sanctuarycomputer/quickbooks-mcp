// Sanctuary Computer (quickbooks-mcp-294): the receipt command's runner, contract §20 (docs/contracts/quickbooks.md in Stacksbot).
// QBO_WRITE_RECEIPT_CMD split on single spaces and run with no shell; its environment is built from the write config alone (NOTION_API_KEY
// and TZ when set, QBO_WRITE_LEDGER, PATH when set; never STACKS_QBO_TOKEN); one JSON request on stdin, one JSON object on stdout with
// exit 0; killed with SIGKILL at 20 s or past 1 MiB of stdout. Anything else is not ok. stderr is read and dropped. This is the one file
// that may load node:child_process, and only `spawn` (tests/unit/removals.test.ts R3, ruling d-20261127-041558577).
import { spawn } from "node:child_process";
import type { WriteConfig } from "../clients/config.js";

export { spawn };
export type Spawn = typeof spawn;

export const RECEIPT_TIMEOUT_MS = 20_000;
export const RECEIPT_MAX_BYTES = 1_048_576;

/** Every way the command fails, as the receipt command itself would say it couldn't be asked. */
const FAILED = Object.freeze({ ok: false, reason: "failed", cause: "command" });

/** What runReceipt uses of a child spawned with `stdio: "pipe"`, whose three streams are never null. */
type Child = {
  readonly stdin: { on(event: "error", listener: () => void): unknown; end(text: string): unknown };
  readonly stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
  readonly stderr: { on(event: "data", listener: () => void): unknown };
  on(event: "error" | "close", listener: (code: number | null) => void): unknown;
  kill(signal: "SIGKILL"): unknown;
};

/** The child's environment: the config's keys only. */
function childEnv(cfg: WriteConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (cfg.notionApiKey !== undefined) env.NOTION_API_KEY = cfg.notionApiKey;
  env.QBO_WRITE_LEDGER = cfg.writeLedger;
  if (cfg.path !== undefined) env.PATH = cfg.path;
  if (cfg.tz !== undefined) env.TZ = cfg.tz;
  return env;
}

/** The one JSON object `text` holds, whitespace around it allowed; else not ok. */
function oneObject(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : FAILED;
  } catch {
    return FAILED;
  }
}

/** Runs the receipt command once for `request` and answers what it printed, or `{ ok: false, reason: "failed", cause: "command" }`. */
export function runReceipt(
  cfg: WriteConfig,
  request: object,
  deps: { spawn: Spawn; timeoutMs?: number; maxBytes?: number },
): Promise<unknown> {
  const timeoutMs = deps.timeoutMs ?? RECEIPT_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? RECEIPT_MAX_BYTES;
  const [file, ...args] = cfg.receiptCmd.split(" ");
  return new Promise((resolve) => {
    let settled = false;
    let child: Child;
    try {
      child = deps.spawn(file, args, { shell: false, stdio: "pipe", env: childEnv(cfg) }) as unknown as Child;
    } catch {
      resolve(FAILED);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const kill = (): void => {
      child.kill("SIGKILL");
      finish(FAILED);
    };
    const timer = setTimeout(kill, timeoutMs);
    child.on("error", () => finish(FAILED));
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) kill();
      else chunks.push(chunk);
    });
    child.stderr.on("data", () => undefined);
    // The command may exit before reading its input (EPIPE): its exit code and output decide.
    child.stdin.on("error", () => undefined);
    child.on("close", (code: number | null) => finish(code === 0 ? oneObject(Buffer.concat(chunks).toString("utf8")) : FAILED));
    child.stdin.end(JSON.stringify(request));
  });
}
