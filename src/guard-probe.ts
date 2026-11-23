// Sanctuary Computer (quickbooks-mcp-291): the guard probe: asks the guard's one decide whether a request would leave, and sends nothing.
// node dist/guard-probe.js <METHOD> <URL> --realm <R> [--stacks-url <u>] [--key <k>]...
import { decide, newCallRecord } from "./clients/guard-decide.js";

const USAGE = "usage: guard-probe <METHOD> <URL> --realm <R> [--stacks-url <u>] [--key <k>]...";

type Args = { method: string; url: string; realm: string; stacksUrl: string | undefined; keys: string[] };

/** Reads argv; a string is the usage error's reason. */
function parse(argv: readonly string[]): Args | string {
  const positional: string[] = [];
  let realm: string | undefined;
  let stacksUrl: string | undefined;
  const keys: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    if (a !== "--realm" && a !== "--stacks-url" && a !== "--key") return `unknown flag ${a}`;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--") || value === "") return `${a} needs a value`;
    i++;
    if (a === "--key") keys.push(value);
    else if (a === "--realm") {
      if (realm !== undefined) return "--realm given twice";
      realm = value;
    } else {
      if (stacksUrl !== undefined) return "--stacks-url given twice";
      stacksUrl = value;
    }
  }
  if (positional.length < 1) return "missing METHOD";
  if (positional.length < 2) return "missing URL";
  if (positional.length > 2) return "too many arguments";
  if (realm === undefined) return "missing --realm";
  return { method: positional[0], url: positional[1], realm, stacksUrl, keys };
}

/** One line, `allow <rule>` (0) or `refuse <rule>` (1); a usage error prints `usage: …` to err (2). */
export function runProbe(argv: readonly string[], out: (line: string) => void, err: (line: string) => void): 0 | 1 | 2 {
  const args = parse(argv);
  if (typeof args === "string") {
    err(`${USAGE} (${args})`);
    return 2;
  }
  const record = newCallRecord();
  const decision = decide(
    { method: args.method, url: args.url },
    {
      stacksUrl: args.stacksUrl,
      keys: () => [...args.keys],
      allowedRealm: (r) => r === args.realm,
      callRecord: () => record,
    },
  );
  out(`${decision.allow ? "allow" : "refuse"} ${decision.rule}`);
  return decision.allow ? 0 : 1;
}

// The process entry (T0's pattern: tests import this file with argv[1] set to cover it).
if (/guard-probe\.[jt]s$/.test(process.argv[1] ?? "")) {
  process.exitCode = runProbe(process.argv.slice(2), (l) => process.stdout.write(l + "\n"), (l) => process.stderr.write(l + "\n"));
}
