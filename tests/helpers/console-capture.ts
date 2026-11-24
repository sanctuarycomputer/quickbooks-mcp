// Sanctuary Computer (quickbooks-mcp-286): console capture that scans what Node's console prints (T13-1, spec A5.7).
// Each call's arguments are formatted as Node's console formats them (util.format: objects and errors inspected with
// their own properties, %o and %O expanded), and each non-string argument is also inspected in full (every level,
// hidden properties and getters), since an axios error's config.headers sits below util.format's depth of 2.
import { jest } from '@jest/globals';
import util from 'util';

/** Every console method that prints something. */
export const PRINTING = [
  'log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml', 'table', 'assert',
  'group', 'groupCollapsed', 'count', 'time', 'timeLog', 'timeEnd',
] as const;

/** The text a console call with `args` prints, then each non-string argument inspected in full. */
export function printed(args: unknown[]): string {
  const deep = args.filter((a) => typeof a !== 'string').map((a) => util.inspect(a, { depth: null, getters: true, showHidden: true }));
  return [util.format(...args), ...deep].join(' ');
}

/** Spies every printing console method; each call pushes `console.<method>: <printed>` to `into`. Spies restore with jest's. */
export function captureConsole(into: string[]): void {
  for (const m of PRINTING) {
    jest.spyOn(console, m).mockImplementation(((...a: unknown[]) => void into.push(`console.${m}: ${printed(a)}`)) as never);
  }
}
