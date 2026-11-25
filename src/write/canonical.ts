// Sanctuary Computer (quickbooks-mcp-293): canonical JSON and its hash, contract 1.1 §17 "Digests" (docs/contracts/quickbooks.md
// in Stacksbot). Pure: no network, no state.
import { createHash } from "node:crypto";

/** One parsed JSON value's text. Written out, since an object literal can't hold integer-like keys in code-unit order. */
function write(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(write).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  // The default sort compares UTF-16 code units.
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${write(record[key])}`).join(",")}}`;
}

/** `JSON.stringify(value)` with every object's keys sorted by UTF-16 code unit at every depth, no white space. Throws TypeError for a value that has no JSON. */
export function canonicalJson(value: unknown): string {
  const text = JSON.stringify(value) as string | undefined;
  if (text === undefined) throw new TypeError("canonicalJson: the value has no JSON");
  return write(JSON.parse(text));
}

/** The lowercase hex SHA-256 of the text's UTF-8 bytes. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
