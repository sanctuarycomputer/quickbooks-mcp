// Sanctuary Computer (quickbooks-mcp-286): the read server's start configuration, contract 1.1 §3 (docs/contracts/quickbooks.md in Stacksbot).
// The only reader of the five keys. Each refusal is `refused to start: <KEY> <reason>`, naming the key and never its value.
import { readFileSync } from "fs";
import { parseCompanies, type Company } from "./companies.js";

export type Config = {
  readonly stacksUrl: URL;
  readonly stacksKey: string;
  readonly companies: readonly Company[];
  readonly mode: "read";
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

/** Reads and checks the five keys in contract §3's order; throws at the first that fails, before any later key is read. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const url = stacksUrl(env.STACKS_QBO_URL);
  const token = env.STACKS_QBO_TOKEN;
  if (token === undefined) return refuse("STACKS_QBO_TOKEN", "is not set");
  if (token === "") return refuse("STACKS_QBO_TOKEN", "is empty");
  const environment = env.QUICKBOOKS_ENVIRONMENT;
  if (environment === undefined) return refuse("QUICKBOOKS_ENVIRONMENT", "is not set");
  if (environment !== "production") return refuse("QUICKBOOKS_ENVIRONMENT", "is not production");
  const list = companies(env.QBO_COMPANIES);
  const mode = env.QBO_MODE;
  if (mode !== undefined && mode !== "read") return refuse("QBO_MODE", "is not read");
  return Object.freeze({ stacksUrl: url, stacksKey: token, companies: list, mode: "read" });
}
