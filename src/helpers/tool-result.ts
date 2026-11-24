// Sanctuary Computer (quickbooks-mcp-286): every read tool's result in contract 1.1 §5's grammar (spec A4.7, A5.4-A5.6,
// A5.10-A5.12; D6, D9). A handler's answer is classified (D9), rendered as compact JSON lines (Data items), cut at 30,000
// (Cuts), and its WARNING: items put after the data item; an error is the call's recorded failure, else fork-error, as a
// header block and D6's free text. The marker sentences are the Result grammar's; the free texts are the error fixtures'.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CallStore, Failure } from "../clients/call-context.js";
import { READ_ALLOWLIST } from "../allowlist.js";
import { cleanName } from "./name-fold.js";
import { CRITERIA_ONLY_TOOLS, REPORT_TOOLS } from "./validate-input.js";

/** A result's most UTF-16 code units, every text item counted (Cuts). */
export const RESULT_MAX = 30000;
/** A WARNING: item's most UTF-16 code units (Result grammar `warning`). */
export const WARNING_MAX = 2000;
const WARNING_CUT = "truncated: warning cut at 2,000 characters.";
const OBJECT_MARKER = "truncated: the result is longer than 30,000 characters and can't be shown.";

/**
 * Each reason's free text (D6): the `tool-results/get_company_info/` fixture's where one exists. A key with `<status>`,
 * `<code>` or a source after `/` is a form, filled in by `freeText`.
 */
export const REASON_TEXT: Record<string, string> = Object.freeze({
  "fork-error": "The server failed before it could read QuickBooks.",
  timeout: "QuickBooks didn't answer within the server's limit.",
  "http-<status>": "QuickBooks answered <status>.",
  "not-connected": "This company has no QuickBooks connection in Stacks (409).",
  "unknown-enterprise": "Stacks doesn't know this company's key (404).",
  "stacks-auth": "Stacks refused the server's key (403).",
  "stacks-unreachable": "Stacks gave no answer the server knows, twice.",
  "renewal-failed:unavailable": "Stacks couldn't renew the QuickBooks sign-in; Intuit gave no code (502).",
  "renewal-failed:<code>": "Stacks couldn't renew the QuickBooks sign-in; Intuit answered <code> (502).",
  "name-mismatch/stacks": "Stacks' name for this company isn't one of its accepted names.",
  "name-mismatch/quickbooks": "QuickBooks' name for this company isn't one of its accepted names.",
});

/** The Result grammar's `reason` codes with origin `fork`. */
const REASON = /^(name-mismatch|not-connected|unknown-enterprise|renewal-failed:[A-Za-z0-9_-]{1,64}|stacks-auth|stacks-unreachable|http-[0-9]{3}|fork-error|timeout)$/;
const TID = /^[A-Za-z0-9-]{1,64}$/;
const FORK_ERROR: Failure = Object.freeze({ reason: "fork-error" });

export type ToolKind = "search" | "report" | "other";
export type DataKind = "rows" | "report" | "object" | "count";
export type Classified = { ok: true; kind: DataKind; value: unknown; warnings: string[] } | { ok: false; warnings: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (t: string) => ({ type: "text" as const, text: t });

/** The 18 `search_*` read tools are `search`, the 11 report tools `report`, every other tool `other`. */
export function toolKind(tool: string): ToolKind {
  if (REPORT_TOOLS.includes(tool)) return "report";
  if (READ_ALLOWLIST.includes(tool) && tool.startsWith("search_")) return "search";
  return "other";
}

/** A WARNING: item over 2,000 cut to its longest prefix that, with LF and the cut line, is 2,000; a pair is never split. */
export function cutWarning(w: string): string {
  if (w.length <= WARNING_MAX) return w;
  let end = WARNING_MAX - 1 - WARNING_CUT.length;
  const high = w.charCodeAt(end - 1);
  const low = w.charCodeAt(end);
  if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) end--;
  return `${w.slice(0, end)}\n${WARNING_CUT}`;
}

/** The free text of a valid failure: its own `text` when it has one (a 400's fault, a refusal), else D6's sentence. */
function freeText(f: Failure): string {
  if (f.text !== undefined) return f.text;
  if (f.reason.startsWith("http-")) return REASON_TEXT["http-<status>"].replace("<status>", f.reason.slice(5));
  if (f.reason === "name-mismatch") return REASON_TEXT[`name-mismatch/${f.source}`];
  if (f.reason.startsWith("renewal-failed:")) {
    const code = f.reason.slice("renewal-failed:".length);
    return REASON_TEXT[f.reason] ?? REASON_TEXT["renewal-failed:<code>"].replace("<code>", code);
  }
  return REASON_TEXT[f.reason];
}

/** The header lines in the Result grammar's order, or null when the failure breaks the grammar (it answers fork-error). */
function headerLines(f: Failure): string[] | null {
  if (!REASON.test(f.reason)) return null;
  const lines = [`reason: ${f.reason}`];
  if (f.reason === "name-mismatch") {
    const reported = cleanName(f.reported);
    if ((f.source !== "stacks" && f.source !== "quickbooks") || reported === null) return null;
    lines.push(`source: ${f.source}`, `reported: ${reported}`);
  }
  const tidAllowed = f.reason.startsWith("http-") || f.reason === "timeout";
  if (tidAllowed && f.intuitTid !== undefined && TID.test(f.intuitTid)) lines.push(`intuit_tid: ${f.intuitTid}`);
  return lines;
}

/** An error result: the header block, an empty line and the free text, then the warnings, each cut at 2,000. */
export function errorResult(f: Failure, warnings: string[]): CallToolResult {
  let header = headerLines(f);
  if (header === null) {
    f = FORK_ERROR;
    header = ["reason: fork-error"];
  }
  return { content: [text(`${header.join("\n")}\n\n${freeText(f)}`), ...warnings.map((w) => text(cutWarning(w)))], isError: true };
}

/** D9's label: one line, not starting `Error`, with no `{`, `[` or `"`, ending `:` or of the form `Found <n> <things>`. */
function isLabel(t: string): boolean {
  if (/[\n\r{["]/.test(t) || t.startsWith("Error")) return false;
  return t.endsWith(":") || /^Found [0-9]+ [a-z]+$/.test(t);
}

const NOT_JSON = Symbol("not JSON");
function parseJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return NOT_JSON;
  }
}

/** A report's `Rows`: absent, or an object whose `Row` is absent or an array of objects, each with valid `Rows`. */
function validRows(rows: unknown): boolean {
  if (rows === undefined) return true;
  if (!isRecord(rows)) return false;
  if (rows.Row === undefined) return true;
  return Array.isArray(rows.Row) && rows.Row.every((r) => isRecord(r) && validRows(r.Rows));
}

/**
 * D9: a success is a result without `isError` whose text items, WARNING: items set aside, are labels followed by JSON
 * items, or (on a search) exactly upstream's count form. Anything else, or any item that isn't text, is an error.
 */
export function classify(raw: unknown, kind: ToolKind): Classified {
  const content = isRecord(raw) && Array.isArray(raw.content) ? (raw.content as unknown[]) : [];
  const warnings: string[] = [];
  const rest: unknown[] = [];
  for (const item of content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string" && item.text.startsWith("WARNING:")) warnings.push(item.text);
    else rest.push(item);
  }
  const fail: Classified = { ok: false, warnings };
  if (!isRecord(raw) || (raw.isError !== undefined && raw.isError !== false) || rest.length === 0) return fail;
  const texts: string[] = [];
  for (const item of rest) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return fail;
    texts.push(item.text);
  }
  if (kind === "search" && texts.length === 1 && /^Count: [0-9]+$/.test(texts[0])) {
    return { ok: true, kind: "count", value: Number(texts[0].slice("Count: ".length)), warnings };
  }
  const values: unknown[] = [];
  for (const t of texts) {
    if (values.length === 0 && isLabel(t)) continue;
    const v = parseJson(t);
    if (v === NOT_JSON) return fail;
    values.push(v);
  }
  if (kind === "search") {
    const rows: unknown[] = values.flatMap((v) => (Array.isArray(v) ? v : [v]));
    return rows.every(isRecord) ? { ok: true, kind: "rows", value: rows, warnings } : fail;
  }
  if (values.length !== 1) return fail;
  const [value] = values;
  if (kind === "other") return { ok: true, kind: "object", value, warnings };
  const report = isRecord(value) && "Header" in value && "Columns" in value && validRows(value.Rows);
  return report ? { ok: true, kind: "report", value, warnings } : fail;
}

function reportRowLines(rows: Record<string, unknown>[], depth: number, out: string[]): void {
  for (const row of rows) {
    const { Rows: inner, ...rest } = row;
    out.push(JSON.stringify({ ...rest, depth }));
    const children = (inner as { Row?: Record<string, unknown>[] } | undefined)?.Row;
    if (children !== undefined) reportRowLines(children, depth + 1, out);
  }
}

/** Data items: search rows with their Lines (`depth` 0 and 1), a report's Header, Columns and rows by depth, else one line. */
export function render(kind: DataKind, value: unknown): string[] {
  if (kind === "count") return [JSON.stringify({ count: value })];
  if (kind === "object") return [JSON.stringify(value)];
  if (kind === "report") {
    const report = value as Record<string, unknown>;
    const out = [JSON.stringify(report.Header), JSON.stringify(report.Columns)];
    const rows = (report.Rows as { Row?: Record<string, unknown>[] } | undefined)?.Row;
    if (rows !== undefined) reportRowLines(rows, 0, out);
    return out;
  }
  const out: string[] = [];
  for (const entity of value as Record<string, unknown>[]) {
    const { Line: lines, ...rest } = entity;
    // Only a Line array of objects is spread into Line lines; any other Line value stays in its header.
    if (Array.isArray(lines) && lines.every(isRecord)) {
      out.push(JSON.stringify({ ...rest, depth: 0 }));
      for (const line of lines) out.push(JSON.stringify({ ...line, depth: 1 }));
    } else {
      out.push(JSON.stringify({ ...entity, depth: 0 }));
    }
  }
  return out;
}

const sum = (ns: number[]): number => ns.reduce((a, b) => a + b, 0);
/** The length of lines joined by LF. */
const joined = (lines: string[]): number => sum(lines.map((l) => l.length)) + Math.max(0, lines.length - 1);

/** A search's lines, grouped into search rows: each header line (`depth` 0, written last by render) starts one. */
function searchRows(lines: string[]): string[][] {
  const rows: string[][] = [];
  for (const line of lines) {
    if (line.endsWith('"depth":0}')) rows.push([line]);
    else rows[rows.length - 1].push(line);
  }
  return rows;
}

function cutSearch(lines: string[], room: number, usedOffset: number, criteriaOffset: boolean): string[] {
  const rows = searchRows(lines);
  const t = rows.length;
  const next = (kept: number) => `Next page: pass offset ${usedOffset + kept}${criteriaOffset ? " inside criteria" : ""}.`;
  const rowsMarker = (k: number) => `truncated: ${t - k} of ${t} rows left out. ${next(k)}`;
  // Each kept row adds its lines, each after an LF (the marker is line 1).
  const cost = rows.map((r) => sum(r.map((l) => l.length + 1)));
  const prefix = [0];
  for (const c of cost) prefix.push(prefix[prefix.length - 1] + c);
  for (let k = t - 1; k >= 1; k--) {
    if (rowsMarker(k).length + prefix[k] <= room) return [rowsMarker(k), ...rows.slice(0, k).flat()];
  }
  const [header, ...firstLines] = rows[0];
  const total = firstLines.length;
  if (total === 0) return t === 1 ? lines : [rowsMarker(1), header];
  const linesMarker = (j: number) =>
    `truncated: ${total - j} of ${total} Lines of the first row left out, and ${t - 1} of ${t} rows. That row's later Lines can't be read here. ${next(1)}`;
  let used = header.length + 1;
  let keep = 0;
  for (let j = 1; j < total; j++) {
    used += firstLines[j - 1].length + 1;
    if (linesMarker(j).length + used <= room) keep = j;
  }
  return [linesMarker(keep), header, ...firstLines.slice(0, keep)];
}

function cutReport(lines: string[], room: number): string[] {
  const [header, columns, ...rows] = lines;
  const t = rows.length;
  if (t === 0) return lines;
  const marker = (k: number) => `truncated: ${t - k} of ${t} report rows left out. Narrow the report: a shorter date range, or fewer columns.`;
  const prefix = [header.length + 1 + columns.length + 1];
  for (const r of rows) prefix.push(prefix[prefix.length - 1] + r.length + 1);
  let k = t - 1;
  while (k > 0 && marker(k).length + prefix[k] > room) k--;
  return [marker(k), header, columns, ...rows.slice(0, k)];
}

/**
 * Cuts: the warnings cut at 2,000 first; a result of at most 30,000, every item counted, is untouched. A longer one keeps
 * the most whole rows that fit with the marker as line 1, never going below a report's Header and Columns or a search's
 * first header line; any other data item becomes its marker alone, and a count is never cut.
 */
export function cut(kind: DataKind, lines: string[], warnings: string[], usedOffset: number, criteriaOffset: boolean): { lines: string[]; warnings: string[] } {
  const kept = warnings.map(cutWarning);
  const room = RESULT_MAX - sum(kept.map((w) => w.length));
  if (kind === "count" || joined(lines) <= room) return { lines, warnings: kept };
  if (kind === "rows") return { lines: cutSearch(lines, room, usedOffset, criteriaOffset), warnings: kept };
  if (kind === "report") return { lines: cutReport(lines, room), warnings: kept };
  return { lines: [OBJECT_MARKER], warnings: kept };
}

/**
 * A tool's result: the call's recorded failure first, whatever the handler answered; else D9's classification, the
 * data item rendered and cut, then the warnings (the call's own, then the handler's WARNING: items).
 */
export function shapeResult(raw: unknown, call: CallStore, tool: string): CallToolResult {
  const classified = classify(raw, toolKind(tool));
  const warnings = [...call.warnings, ...classified.warnings];
  if (call.failure !== null) return errorResult(call.failure, warnings);
  if (!classified.ok) return errorResult(FORK_ERROR, warnings);
  const lines = render(classified.kind, classified.value);
  const out = cut(classified.kind, lines, warnings, call.usedOffset ?? 1, CRITERIA_ONLY_TOOLS.includes(tool));
  return { content: [text(out.lines.join("\n")), ...out.warnings.map(text)] };
}
