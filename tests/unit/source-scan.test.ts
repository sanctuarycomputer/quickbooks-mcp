// Sanctuary Computer (quickbooks-mcp-286): the source scans, read from each module's syntax tree (comments never count).
// A1.7: no refresh material and no disk write on the token path. A3.3: no reader of company identity but the call
// store, no module-level current company. A6.1's source half: `process.env` only where the spec names it.
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { ROOT } from '../helpers/server.js';

function walk(dir: string): string[] {
  return fs
    .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : []))
    .sort();
}
const parse = (file: string, text = fs.readFileSync(path.join(ROOT, file), 'utf8')) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
function nodes(sf: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Spec A1.7's token path: the modules the scan reads. */
const TOKEN_PATH = [
  ...walk('src/clients'),
  'src/http-guard.ts',
  'src/helpers/register-tool.ts',
  'src/helpers/tool-result.ts',
  'src/helpers/name-fold.ts',
  'src/helpers/validate-input.ts',
  'src/tools/get-company-info.tool.ts',
  'src/handlers/get-quickbooks-company-info.handler.ts',
  'src/tools/qbo-companies.tool.ts',
];
/** Outside the scan by design (spec A1.7), each named: the unregistered PDF tool and the library's own signature. */
const OUTSIDE = ['src/tools/get-invoice-pdf.tool.ts', 'src/types/node-quickbooks.d.ts'];

const REFRESH_NAMES = ['refresh_token', 'refreshToken', 'client_secret', 'clientSecret', 'client_id', 'clientId'];
const ENV_NAMES = ['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN', 'REALM_ID'].map((k) => 'QUICKBOOKS_' + k);
const FS = /^(node:)?fs(\/.*)?$/;

/** A1.7's finds in one module's text: each forbidden name as an identifier, a property name or a string, and each fs load. */
function refreshFinds(file: string, text: string): string[] {
  const sf = parse(file, text);
  const finds: string[] = [];
  for (const n of nodes(sf)) {
    const name = ts.isIdentifier(n) || ts.isPrivateIdentifier(n) ? n.text : ts.isStringLiteralLike(n) ? n.text : undefined;
    if (name === undefined) continue;
    for (const r of REFRESH_NAMES) if (name === r) finds.push(`${file}:${lineOf(sf, n)}: ${r}`);
    for (const k of ENV_NAMES) if (name.includes(k)) finds.push(`${file}:${lineOf(sf, n)}: ${k}`);
    if (ts.isStringLiteralLike(n) && FS.test(n.text)) finds.push(`${file}:${lineOf(sf, n)}: loads ${n.text}`);
  }
  return finds;
}

/** How a module imports fs: each import declaration's bindings, `import { a, b as c }` as ['a', 'b as c']; '*' and 'default' too. */
function fsBindings(file: string, text: string): string[] {
  const sf = parse(file, text);
  const out: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !FS.test(st.moduleSpecifier.text)) continue;
    const clause = st.importClause;
    if (clause?.name) out.push('default');
    const b = clause?.namedBindings;
    if (b && ts.isNamespaceImport(b)) out.push('*');
    if (b && ts.isNamedImports(b)) for (const e of b.elements) out.push(e.propertyName ? `${e.propertyName.text} as ${e.name.text}` : e.name.text);
  }
  return out;
}

describe('A1.7: no refresh material, and no disk write, on the token path', () => {
  it('the scanned modules and the two outside it all exist; src/clients is read whole', () => {
    for (const f of [...TOKEN_PATH, ...OUTSIDE]) expect([f, fs.existsSync(path.join(ROOT, f))]).toEqual([f, true]);
    expect(TOKEN_PATH.filter((f) => f.startsWith('src/clients/'))).toEqual(walk('src/clients'));
    expect(walk('src/clients').length).toBeGreaterThanOrEqual(10);
    for (const f of OUTSIDE) expect(TOKEN_PATH).not.toContain(f);
  });

  it('no refresh_token, refreshToken, client_secret, clientSecret, client_id or clientId, and no QUICKBOOKS_ sign-in key, in any scanned module', () => {
    const finds = TOKEN_PATH.flatMap((f) => refreshFinds(f, fs.readFileSync(path.join(ROOT, f), 'utf8')).filter((x) => !x.includes(': loads ')));
    expect(finds).toEqual([]);
  });

  it('fs is loaded in exactly one scanned module, src/clients/config.ts, which imports readFileSync from it and nothing else', () => {
    const loads = TOKEN_PATH.flatMap((f) => refreshFinds(f, fs.readFileSync(path.join(ROOT, f), 'utf8')).filter((x) => x.includes(': loads ')));
    expect(loads).toEqual([expect.stringMatching(/^src\/clients\/config\.ts:\d+: loads fs$/)]);
    expect(fsBindings('src/clients/config.ts', fs.readFileSync(path.join(ROOT, 'src/clients/config.ts'), 'utf8'))).toEqual(['readFileSync']);
  });

  it('the scan finds each form it names (identifier, property, string; an fs load by import, require or import(); a write import)', () => {
    const f = 'x.ts';
    expect(refreshFinds(f, `const ${REFRESH_NAMES[0]} = 1;`)).toEqual([`x.ts:1: ${REFRESH_NAMES[0]}`]);
    expect(refreshFinds(f, `a.${REFRESH_NAMES[1]};\nb["${REFRESH_NAMES[2]}"];`)).toEqual([`x.ts:1: ${REFRESH_NAMES[1]}`, `x.ts:2: ${REFRESH_NAMES[2]}`]);
    expect(refreshFinds(f, `({ ${REFRESH_NAMES[3]}: 1, ${REFRESH_NAMES[4]}: 2, ${REFRESH_NAMES[5]}: 3 });`)).toHaveLength(3);
    expect(refreshFinds(f, `env["${ENV_NAMES[3]}"]; env.${ENV_NAMES[0]};`)).toEqual([`x.ts:1: ${ENV_NAMES[3]}`, `x.ts:1: ${ENV_NAMES[0]}`]);
    // A comment is no read; a longer name holding none is not one.
    expect(refreshFinds(f, `// ${REFRESH_NAMES[0]} ${ENV_NAMES[1]}\nconst my_client_identity = 1;`)).toEqual([]);
    expect(refreshFinds(f, 'import a from "fs";\nconst b = require("node:fs/promises");\nconst c = await import(`fs`);')).toEqual(['x.ts:1: loads fs', 'x.ts:2: loads node:fs/promises', 'x.ts:3: loads fs']);
    expect(fsBindings(f, 'import { readFileSync, writeFileSync } from "fs";')).toEqual(['readFileSync', 'writeFileSync']);
    expect(fsBindings(f, 'import { readFileSync as r } from "node:fs";')).toEqual(['readFileSync as r']);
    expect(fsBindings(f, 'import fsx, * as all from "fs";')).toEqual(['default', '*']);
    expect(fsBindings(f, 'import { readFileSync } from "path";')).toEqual([]);
  });
});

/**
 * Every top-level variable in a module: `let`/`var` named as such, and each `const` holding a container or a store: one
 * made by `new`, an array or object literal, or a call (named by its callee, T13-5: `Object.freeze({…})` or a factory's
 * result holds whatever it was given).
 */
function moduleState(file: string, text: string): string[] {
  const sf = parse(file, text);
  const out: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const d of st.declarationList.declarations) {
      const name = d.name.getText(sf);
      let init = d.initializer;
      // `x as T` and `x satisfies T` hold what x holds; `as const` makes an array or object readonly, so no state.
      while (init && (ts.isSatisfiesExpression(init) || (ts.isAsExpression(init) && init.type.getText(sf) !== 'const'))) init = init.expression;
      if (!isConst) out.push(`${file}: let ${name}`);
      else if (init && ts.isNewExpression(init) && init.expression.getText(sf) !== 'RegExp') out.push(`${file}: ${name} = new ${init.expression.getText(sf)}`);
      else if (init && (ts.isArrayLiteralExpression(init) || ts.isObjectLiteralExpression(init))) out.push(`${file}: ${name} = ${ts.isArrayLiteralExpression(init) ? '[…]' : '{…}'}`);
      else if (init && ts.isCallExpression(init)) out.push(`${file}: ${name} = ${init.expression.getText(sf)}(…)`);
    }
  }
  return out;
}

/** Each read of company identity in a module: a `currentCall()` call, a `.company` property read, a `new AsyncLocalStorage`. */
function companyReads(file: string, text: string): string[] {
  const sf = parse(file, text);
  const out: string[] = [];
  for (const n of nodes(sf)) {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === 'currentCall') out.push(`${file}: currentCall()`);
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'company') out.push(`${file}: ${n.getText(sf)}`);
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === 'company') out.push(`${file}: ${n.getText(sf)}`);
    if (ts.isNewExpression(n) && n.expression.getText(sf) === 'AsyncLocalStorage') out.push(`${file}: ${n.getText(sf).replace(/\(\)$/, '')}`);
  }
  return out;
}

describe('A3.3: the call store is the only holder and reader of company identity', () => {
  const ALL = walk('src');

  it('no module in src has a top-level let or var', () => {
    expect(ALL.flatMap((f) => moduleState(f, fs.readFileSync(path.join(ROOT, f), 'utf8'))).filter((x) => x.includes(': let '))).toEqual([]);
  });

  // Each module-level container on the token path, and what it holds: none is a current company.
  it('the token path holds exactly these module-level containers and stores', () => {
    const state = TOKEN_PATH.flatMap((f) => moduleState(f, fs.readFileSync(path.join(ROOT, f), 'utf8')));
    expect(state).toEqual([
      'src/clients/bluebird-context.ts: BOUND = Symbol.for(…)', // the bound-promise mark, a symbol
      'src/clients/call-context.ts: calls = new AsyncLocalStorage', // the per-call store itself
      'src/clients/company-state.ts: FORK_ERROR = Object.freeze(…)', // a frozen fork-error reading, no company
      'src/clients/guard-decide.ts: REPORT_KEYS = Object.freeze(…)', // the report entities' frozen key list
      'src/clients/qbo-transport.ts: LIMIT_CODES = new Set', // axios' timeout codes
      'src/clients/qbo-transport.ts: FRESH = Object.freeze(…)', // a frozen fresh resend budget, no company
      'src/clients/qbo-transport.ts: lineage = new AsyncLocalStorage', // a resend's budget, no company
      'src/clients/qbo-transport.ts: SENT_AT = Symbol(…)', // the request's sent-at mark, a symbol
      'src/clients/stacks-token.ts: TOKEN_KEYS = […]', // the five keys of a Stacks 200
      'src/clients/stacks-token.ts: TRANSPORT_CODES = new Set', // step 7's codes
      'src/clients/stacks-token.ts: BROKEN = Symbol(…)', // a reading's mark, a symbol
      'src/clients/stacks-token.ts: UNREACHABLE = {…}', // a frozen reading
      'src/clients/stacks-token.ts: RETRY = Symbol(…)', // a reading's mark, a symbol
      'src/http-guard.ts: requireHere = createRequire(…)', // 291's require for axios' CJS build
      'src/http-guard.ts: LOGGED_METHODS = […]', // 291's log line methods
      'src/http-guard.ts: tickets = new AsyncLocalStorage', // 291's single-use socket tickets
      'src/http-guard.ts: holder = {…}', // 291's guard context (the runtime's callbacks), never a company
      'src/http-guard.ts: AGENT = new https.Agent', // the guard's own agent
      'src/http-guard.ts: installed = new WeakMap', // 291's installed guards
      'src/http-guard.ts: BACKSTOP_MARK = Symbol.for(…)', // 291's backstop mark, a symbol
      'src/http-guard.ts: ownWraps = new WeakSet', // 291's backstop wraps
      'src/http-guard.ts: KNOWN = new Set', // 291's option keys
      'src/http-guard.ts: PROXY_OPTIONS = […]', // 291's refused options
      'src/helpers/register-tool.ts: FORK_ERROR = Object.freeze(…)', // a frozen fork-error result
      'src/helpers/tool-result.ts: REASON_TEXT = Object.freeze(…)', // each reason's fixed text
      'src/helpers/tool-result.ts: FORK_ERROR = Object.freeze(…)', // a frozen fork-error result
      'src/helpers/tool-result.ts: NOT_JSON = Symbol(…)', // a parse mark, a symbol
      'src/helpers/name-fold.ts: SUFFIXES = Object.freeze(…)', // the company-name suffixes folded
      'src/helpers/validate-input.ts: COUNT_TOOLS = […]', // tool names, from here down: tables and validators, never written
      'src/helpers/validate-input.ts: CRITERIA_ONLY_TOOLS = […]',
      'src/helpers/validate-input.ts: ENTRY_KEYS = […]',
      'src/helpers/validate-input.ts: PAGE_KEYS = […]',
      'src/helpers/validate-input.ts: METHOD = oneOf(…)',
      'src/helpers/validate-input.ts: SUMMARIZE = oneOf(…)',
      'src/helpers/validate-input.ts: AGING = oneOf(…)',
      'src/helpers/validate-input.ts: DATES = {…}',
      'src/helpers/validate-input.ts: ID = matches(…)',
      'src/helpers/validate-input.ts: AGED = {…}',
      'src/helpers/validate-input.ts: REPORT_RULES = {…}',
      'src/helpers/validate-input.ts: REPORT_TOOLS = Object.keys(…)',
      'src/tools/get-company-info.tool.ts: toolSchema = z.object(…)', // the tool's empty schema
      'src/tools/get-company-info.tool.ts: GetCompanyInfoTool = {…}', // the two tool definitions
      'src/tools/qbo-companies.tool.ts: QboCompaniesTool = {…}',
    ]);
  });

  it("company identity is read only from the call store: currentCall() in the named modules, `.company` at the SDK's arguments and the call", () => {
    const reads = ALL.flatMap((f) => companyReads(f, fs.readFileSync(path.join(ROOT, f), 'utf8')));
    expect(reads).toEqual([
      'src/clients/call-context.ts: new AsyncLocalStorage<CallStore>',
      'src/clients/company-state.ts: currentCall()',
      'src/clients/company-state.ts: currentCall()',
      'src/clients/qbo-transport.ts: new AsyncLocalStorage<Budget>',
      'src/clients/qbo-transport.ts: currentCall()',
      'src/clients/qbo-transport.ts: call.company', // the 401's forced get, for the call's own company
      'src/clients/quickbooks-client.ts: currentCall()',
      'src/clients/runtime.ts: currentCall()',
      'src/helpers/register-tool.ts: args.company', // runInCall's company, from the SDK-checked enum
      'src/helpers/register-tool.ts: currentCall()',
      'src/helpers/register-tool.ts: args.company', // prepareCall's, the same
      'src/helpers/register-tool.ts: currentCall()',
      'src/http-guard.ts: new AsyncLocalStorage<IssuedTicket>',
      'src/http-guard.ts: new AsyncLocalStorage<{ realm: string | undefined; record: CallRecord }>', // 291's default scope, replaced at start
      'src/write/answers.ts: line.company', // a lookup's intent line's company, compared with its key's (the call's, checked before)
      'src/write/answers.ts: attempt.company', // the intent's attempt, the caller's: the call's company, compared with the answer's key
      'src/write/capability.ts: checked.company', // the checked request's, which the capability is bound to
      'src/write/client.ts: currentCall()', // the write client's GETs: the call's own token and realm
      'src/write/client.ts: call.company', // the update's call, compared with the checked request's company
      'src/write/client.ts: checked.company', // the same
      'src/write/guard-rules.ts: deps.company', // decideWrite's company callback (the call's), never a kept company
      'src/write/guard-rules.ts: deps.company', // decideDry's, the same
      'src/write/mode.ts: currentCall()?.company', // decideWrite's company callback: the call's, read when asked
      'src/write/mode.ts: currentCall()', // the same
      'src/write/pre-send.ts: currentCall()', // the pre-send check's call, whose failure it reads
      'src/write/pre-send.ts: call.company', // compared with the input's company, which must be the call's
      'src/write/results.ts: change.company', // the change item's company, the call's as the change flow gives it, written into the success
    ]);
  });

  it('the scans find each form they name', () => {
    expect(moduleState('x.ts', 'let a = 1;\nvar b;\nconst c = new Map();\nconst d = [1];\nconst e = {};\nconst f = 1;\nconst g = new RegExp("x");')).toEqual([
      'x.ts: let a',
      'x.ts: let b',
      'x.ts: c = new Map',
      'x.ts: d = […]',
      'x.ts: e = {…}',
    ]);
    expect(moduleState('x.ts', 'function f() { let a = new Map(); }')).toEqual([]);
    expect(moduleState('x.ts', 'const h = [] as string[];\nconst k = ["a"] as const;\nconst r = {} satisfies object;\nconst w = new WeakMap() as any;')).toEqual([
      'x.ts: h = […]',
      'x.ts: r = {…}',
      'x.ts: w = new WeakMap',
    ]);
    // T13-5: a const made by a call is named by its callee.
    expect(moduleState('x.ts', 'const state = makeState();\nconst current = Object.seal({ company: "" });\nconst n = 1 + f();')).toEqual([
      'x.ts: state = makeState(…)',
      'x.ts: current = Object.seal(…)',
    ]);
    expect(companyReads('x.ts', 'currentCall(); s.company; s["company"]; new AsyncLocalStorage<X>(); other();')).toEqual([
      'x.ts: currentCall()',
      'x.ts: s.company',
      'x.ts: s["company"]',
      'x.ts: new AsyncLocalStorage<X>',
    ]);
  });
});

/** Each use of `process` in a module: `process.<name>` with the enclosing call's callee for `process.env`, or the bare use. */
function processUses(file: string, text: string): string[] {
  const sf = parse(file, text);
  const out: string[] = [];
  for (const n of nodes(sf)) {
    if (!ts.isIdentifier(n) || n.text !== 'process') continue;
    const p = n.parent;
    const at = `${file}:${lineOf(sf, n)}`;
    if (ts.isPropertyAccessExpression(p) && p.expression === n) {
      const name = p.name.text;
      if (name !== 'env') continue; // execArgv, stderr, stdout, argv, exit, exitCode: no environment
      const q = p.parent;
      if (ts.isCallExpression(q) && q.arguments.includes(p)) out.push(`${at}: process.env, an argument of ${q.expression.getText(sf)}`);
      else if (ts.isPropertyAccessExpression(q) && q.expression === p) out.push(`${at}: process.env.${q.name.text}`);
      else out.push(`${at}: process.env, otherwise`);
    } else out.push(`${at}: process, otherwise (${p.getText(sf).slice(0, 40)})`);
  }
  return out;
}

describe("A6.1's source half: process.env only where the spec names it", () => {
  it('src/index.ts hands it to secureStart and startReadServer; the two unregistered PDF files read their own key; nothing else', () => {
    const uses = walk('src').flatMap((f) => processUses(f, fs.readFileSync(path.join(ROOT, f), 'utf8')));
    expect(uses).toEqual([
      'src/handlers/get-quickbooks-invoice-pdf.handler.ts:17: process.env.QBO_PDF_MAX_BYTES',
      'src/index.ts:85: process.env, an argument of isWriteMode',
      'src/index.ts:86: process.env, an argument of secureStart', // read mode's
      'src/index.ts:87: process.env, an argument of secureStart', // write mode's, with its rules
      'src/index.ts:94: process.env, an argument of startReadServer',
      'src/index.ts:95: process.env, an argument of startWriteServer',
      'src/tools/get-invoice-pdf.tool.ts:64: process.env.QBO_PDF_OUTPUT_DIR',
    ]);
  });

  it('get_invoice_pdf, whose two files read those keys, is not listed', async () => {
    const { READ_ALLOWLIST } = await import('../../src/tool-lists.js');
    expect(READ_ALLOWLIST).not.toContain('get_invoice_pdf');
    expect(fs.readFileSync(path.join(ROOT, 'src/index.ts'), 'utf8')).not.toContain('invoice-pdf');
  });

  it('the scan finds every other form: a bracket read, destructuring, an alias, globalThis.process, an env passed elsewhere', () => {
    expect(processUses('x.ts', 'process["env"];')).toEqual(['x.ts:1: process, otherwise (process["env"])']);
    expect(processUses('x.ts', 'const { env } = process;')).toEqual(['x.ts:1: process, otherwise ({ env } = process)']);
    expect(processUses('x.ts', 'const p = process;')).toEqual(['x.ts:1: process, otherwise (p = process)']);
    expect(processUses('x.ts', 'globalThis.process.env;')).toEqual(['x.ts:1: process, otherwise (globalThis.process)']);
    expect(processUses('x.ts', 'loadConfig(process.env);\nconst e = process.env;\nprocess.stderr.write("x");')).toEqual([
      'x.ts:1: process.env, an argument of loadConfig',
      'x.ts:2: process.env, otherwise',
    ]);
  });
});
