// Sanctuary Computer (quickbooks-mcp-286): the QBO_COMPANIES file's parser, contract 1.1 §2 Keys and §3 (docs/contracts/quickbooks.md in Stacksbot).
// Pure: it reads text, never a path. Each refusal is `QBO_COMPANIES <reason>`, never a value from the file; the config turns it into a start refusal.
import { fold } from "../helpers/name-fold.js";

export type Company = { key: string; name: string; acceptedNames: string[] };

const VERSION = /^1\.0(\.[0-9]+)?$/;

const refuse = (reason: string): never => {
  throw new Error(`QBO_COMPANIES ${reason}`);
};

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const nonEmpty = (x: unknown): x is string => typeof x === "string" && x !== "";

function readEntry(raw: unknown): Company {
  if (!isObject(raw)) return refuse("has a company that is not an object");
  const { stacks_key: key, name, accepted_names: accepted } = raw;
  if (!nonEmpty(key)) return refuse("has a company with no valid stacks_key");
  if (!nonEmpty(name)) return refuse("has a company with no valid name");
  if (!Array.isArray(accepted) || accepted.length === 0 || !accepted.every((a) => typeof a === "string")) {
    return refuse("has a company with no valid accepted_names");
  }
  if (accepted[0] !== name) return refuse("has a company whose accepted_names[0] is not its name");
  return Object.freeze({ key, name, acceptedNames: Object.freeze([...accepted]) as string[] });
}

/** Parse a QBO_COMPANIES file's text (entities.json's shape) into its companies, in file order; throws per A2.8. */
export function parseCompanies(text: string): Company[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return refuse("is not JSON");
  }
  if (!isObject(doc)) return refuse("is not an object");
  if (typeof doc.v !== "string" || !VERSION.test(doc.v)) return refuse("has no v 1.0");
  if (!Array.isArray(doc.companies)) return refuse("companies is not an array");
  if (doc.companies.length === 0) return refuse("has no companies");
  const companies = doc.companies.map(readEntry);
  const keys = new Set<string>();
  const owner = new Map<string, string>();
  for (const c of companies) {
    if (keys.has(c.key)) return refuse("repeats a stacks_key");
    keys.add(c.key);
    for (const a of c.acceptedNames) {
      const k = fold(a);
      if (k === "") return refuse("has an accepted name that folds to an empty key");
      const seen = owner.get(k);
      if (seen !== undefined && seen !== c.key) return refuse("has two companies whose accepted names fold to the same key");
      owner.set(k, c.key);
    }
  }
  return Object.freeze(companies) as Company[];
}
