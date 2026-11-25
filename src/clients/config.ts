// Sanctuary Computer (quickbooks-mcp-286): the read server's start configuration, contract 1.1 §3 (docs/contracts/quickbooks.md in Stacksbot).
// The only reader of the five keys and of write mode's four. Each refusal is `refused to start: <KEY> <reason>`, naming the key and never its value.
// Changed by Sanctuary Computer (quickbooks-mcp-293): isWriteMode, and loadWriteConfig for the write server; loadConfig is the read server's, as it was.
import { readFileSync } from "fs";
import { parseCompanies, type Company } from "./companies.js";

export type Config = {
  readonly stacksUrl: URL;
  readonly stacksKey: string;
  readonly companies: readonly Company[];
  readonly mode: "read" | "write";
};

/** The write server's: the receipt command, and the switch file's, the ledger's and the sweep stamp's paths, as given. */
export type WriteConfig = Config & {
  readonly mode: "write";
  readonly receiptCmd: string;
  readonly writeSwitch: string;
  readonly writeLedger: string;
  readonly sweepStamp: string;
};

const refuse = (key: string, reason: string): never => {
  throw new Error(`refused to start: ${key} ${reason}`);
};

/** STACKS_QBO_URL: https, no username or password, nothing but the origin (a trailing `/` allowed). */
function stacksUrl(raw: string | undefined): URL {
  const key = "STACKS_QBO_URL";
  if (raw === undefined) return refuse(key, "is not set");
  if (raw === "") return refuse(key, "is empty");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse(key, "is not a URL");
  }
  if (url.protocol !== "https:") return refuse(key, "is not https");
  if (url.username !== "") return refuse(key, "has a username");
  if (url.password !== "") return refuse(key, "has a password");
  if (url.pathname !== "/") return refuse(key, "has a path");
  // A bare `?` or `#` leaves search and hash empty but still is not the origin.
  if (url.href !== url.origin + "/") return refuse(key, "has a query or fragment");
  return url;
}

/** QBO_COMPANIES: the path of a readable entities file; the parser's refusal (`QBO_COMPANIES <reason>`) becomes the start refusal. */
function companies(path: string | undefined): readonly Company[] {
  const key = "QBO_COMPANIES";
  if (path === undefined) return refuse(key, "is not set");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return refuse(key, "is unreadable");
  }
  try {
    return parseCompanies(text);
  } catch (e) {
    throw new Error(`refused to start: ${(e as Error).message}`);
  }
}

/** The four keys before QBO_MODE, in contract §3's order. */
function firstFour(env: Record<string, string | undefined>): Omit<Config, "mode"> {
  const url = stacksUrl(env.STACKS_QBO_URL);
  const token = env.STACKS_QBO_TOKEN;
  if (token === undefined) return refuse("STACKS_QBO_TOKEN", "is not set");
  if (token === "") return refuse("STACKS_QBO_TOKEN", "is empty");
  const environment = env.QUICKBOOKS_ENVIRONMENT;
  if (environment === undefined) return refuse("QUICKBOOKS_ENVIRONMENT", "is not set");
  if (environment !== "production") return refuse("QUICKBOOKS_ENVIRONMENT", "is not production");
  return { stacksUrl: url, stacksKey: token, companies: companies(env.QBO_COMPANIES) };
}

/** Reads and checks the five keys in contract §3's order; throws at the first that fails, before any later key is read. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const four = firstFour(env);
  const mode = env.QBO_MODE;
  if (mode !== undefined && mode !== "read") return refuse("QBO_MODE", "is not read");
  return Object.freeze({ ...four, mode: "read" });
}

/** Whether the write server was asked for: exactly `write`. Every other value is the read server's, whose loadConfig accepts or refuses it. */
export function isWriteMode(env: Record<string, string | undefined>): boolean {
  return env.QBO_MODE === "write";
}

/** A write key: set and non-empty, nothing more. */
function writeKey(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (value === undefined) return refuse(key, "is not set");
  if (value === "") return refuse(key, "is empty");
  return value;
}

/** The write server's loadConfig: the five keys in the same order, `QBO_MODE` exactly `write`, then the four write keys in contract §3's. */
export function loadWriteConfig(env: Record<string, string | undefined>): WriteConfig {
  const four = firstFour(env);
  if (!isWriteMode(env)) return refuse("QBO_MODE", "is not write");
  return Object.freeze({
    ...four,
    mode: "write",
    receiptCmd: writeKey(env, "QBO_WRITE_RECEIPT_CMD"),
    writeSwitch: writeKey(env, "QBO_WRITE_SWITCH"),
    writeLedger: writeKey(env, "QBO_WRITE_LEDGER"),
    sweepStamp: writeKey(env, "QBO_WRITE_SWEEP_STAMP"),
  });
}
