// Sanctuary Computer (quickbooks-mcp-286): the company-name fold, contract 1.1 §10 (docs/contracts/quickbooks.md in Stacksbot),
// and §5's name rule for a reported name. The fork's own copy of home's scripts/quickbooks/name-fold.mjs; no imports.

/** The contract's Fold suffixes table, in its order. */
export const SUFFIXES: readonly string[] = Object.freeze([
  "llc",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "ltd",
  "limited",
  "lp",
  "llp",
  "pllc",
  "pc",
]);

/** Fold a company name to its comparison key (§10 steps 1-7). Throws TypeError for a non-string. */
export function fold(name: string): string {
  if (typeof name !== "string") throw new TypeError("fold: name must be a string");
  const tokens = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\./g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== "");
  if (tokens.length > 1 && SUFFIXES.includes(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join("");
}

/** True when `reported` folds to a non-empty key equal to the fold of some string in `accepted`; never throws. */
export function matches(reported: unknown, accepted: unknown): boolean {
  if (typeof reported !== "string" || !Array.isArray(accepted)) return false;
  const f = fold(reported);
  return f !== "" && accepted.some((a) => typeof a === "string" && fold(a) === f);
}

/**
 * §5's name rule: control characters and U+2028, U+2029 become a space, trim, keep the first 200 code points, trim the end.
 * Null when `s` is not a string or nothing is left (a `reported:` line is never empty).
 */
export function cleanName(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const kept = Array.from(s.replace(/[\p{Cc}\u2028\u2029]/gu, " ").trim()).slice(0, 200).join("").trimEnd();
  return kept === "" ? null : kept;
}
