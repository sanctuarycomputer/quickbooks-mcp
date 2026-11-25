// Sanctuary Computer (quickbooks-mcp-291): the guard probe: asks the guard's one decide whether a request would leave, and sends nothing.
// Changed by Sanctuary Computer (quickbooks-mcp-293): `--mode write` asks write mode's dry decision instead.
// node dist/guard-probe.js [--mode write] <METHOD> <URL> --realm <R> [--body <file>] [--header <k:v>]... [--stacks-url <u>] [--key <k>]... (--body and --header with --mode only)
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decide, newCallRecord } from "./clients/guard-decide.js";
import { decideDry } from "./write/guard-rules.js";

const USAGE = "usage: guard-probe <METHOD> <URL> --realm <R> [--stacks-url <u>] [--key <k>]...";
const WRITE_USAGE =
  "usage: guard-probe --mode write <METHOD> <URL> --realm <R> [--body <file>] [--header <k:v>]... [--stacks-url <u>] [--key <k>]...";

type Args = { method: string; url: string; realm: string; stacksUrl: string | undefined; keys: string[]; body: string | undefined; headers: Record<string, string> };

/** `--mode` in any form: write mode's flags and its usage string. Any but `--mode write`, once, is a usage error. */
const isMode = (arg: string): boolean => arg === "--mode" || arg.startsWith("--mode=");

/** The file's exact text (a trailing newline and a byte order mark kept), or undefined when it can't be read or isn't UTF-8. */
function readText(file: string): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(file));
  } catch {
    return undefined;
  }
}

/** Reads argv; a string is the usage error's reason. */
function parse(argv: readonly string[], write: boolean): Args | string {
  const positional: string[] = [];
  let realm: string | undefined;
  let stacksUrl: string | undefined;
  const keys: string[] = [];
  let mode: string | undefined;
  let bodyFile: string | undefined;
  let body: string | undefined;
  const headers: Array<[string, string]> = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const known = a === "--realm" || a === "--stacks-url" || a === "--key" || (write && (a === "--mode" || a === "--body" || a === "--header"));
    if (!known) return `unknown flag ${a}`;
    const value = argv[i + 1];
    // An empty --stacks-url stands for a box whose STACKS_QBO_URL is set but empty (decide says stacks-config there).
    if (value === undefined || value.startsWith("--") || (value === "" && a !== "--stacks-url")) return `${a} needs a value`;
    i++;
    if (a === "--key") keys.push(value);
    else if (a === "--realm") {
      if (realm !== undefined) return "--realm given twice";
      realm = value;
    } else if (a === "--mode") {
      if (mode !== undefined) return "--mode given twice";
      if (value !== "write") return "--mode takes only write";
      mode = value;
    } else if (a === "--body") {
      if (bodyFile !== undefined) return "--body given twice";
      bodyFile = value;
    } else if (a === "--header") {
      const colon = value.indexOf(":");
      if (colon < 1) return "--header is not <k:v>";
      const name = value.slice(0, colon);
      if (headers.some(([other]) => other.toLowerCase() === name.toLowerCase())) return "--header names one twice";
      headers.push([name, value.slice(colon + 1)]);
    } else {
      if (stacksUrl !== undefined) return "--stacks-url given twice";
      stacksUrl = value;
    }
  }
  if (positional.length < 1) return "missing METHOD";
  if (positional.length < 2) return "missing URL";
  if (positional.length > 2) return "too many arguments";
  if (realm === undefined) return "missing --realm";
  if (bodyFile !== undefined) {
    body = readText(bodyFile);
    if (body === undefined) return "--body is not a readable UTF-8 file";
  }
  return { method: positional[0], url: positional[1], realm, stacksUrl, keys, body, headers: Object.fromEntries(headers) };
}

/** One line, `allow <rule>` (0), `allowed-with-capability <rule>` (0, write mode) or `refuse <rule>` (1); a usage error prints `usage: …` to err (2). */
export function runProbe(argv: readonly string[], out: (line: string) => void, err: (line: string) => void): 0 | 1 | 2 {
  const write = argv.some(isMode);
  const args = parse(argv, write);
  if (typeof args === "string") {
    err(`${write ? WRITE_USAGE : USAGE} (${args})`);
    return 2;
  }
  const record = newCallRecord();
  const context = {
    stacksUrl: args.stacksUrl,
    keys: () => [...args.keys],
    allowedRealm: (r: string) => r === args.realm,
    callRecord: () => record,
  };
  if (write) {
    // Any company will do: the dry decision has no registry, so it asks only that the call has one.
    const dry = decideDry({ method: args.method, url: args.url, headers: args.headers, data: args.body }, context, { company: () => "guard-probe" });
    out(`${dry.answer} ${dry.rule}`);
    return dry.answer === "refuse" ? 1 : 0;
  }
  const decision = decide({ method: args.method, url: args.url }, context);
  out(`${decision.allow ? "allow" : "refuse"} ${decision.rule}`);
  return decision.allow ? 0 : 1;
}

/**
 * True when argv[1] is this file, by real path: however Node was pointed at it (no extension, as Node resolves
 * `dist/guard-probe`, or a symlink under another name). An import names some other main, so it runs nothing.
 */
export function isEntry(argv1: string | undefined, self: string): boolean {
  if (argv1 === undefined || argv1 === "") return false;
  let me: string;
  try {
    me = realpathSync(self);
  } catch {
    return false;
  }
  // argv[1] itself when it exists; only when it doesn't, argv[1] plus `.js` (as Node resolves `dist/guard-probe`), so a
  // main named like this file without its extension that merely imports it does not run it.
  try {
    return realpathSync(argv1) === me;
  } catch {
    // no such path: try the name Node would have loaded
  }
  try {
    return realpathSync(`${argv1}.js`) === me;
  } catch {
    return false;
  }
}

// The process entry (T0's pattern: tests import this file with argv[1] set to cover it).
if (isEntry(process.argv[1], fileURLToPath(import.meta.url))) {
  process.exitCode = runProbe(process.argv.slice(2), (l) => process.stdout.write(l + "\n"), (l) => process.stderr.write(l + "\n"));
}
