// Sanctuary Computer (quickbooks-mcp-286): the one read of jest's name filter (T13-8), for checks that need every case
// of a file to have run (A1.8's expectServedBy, A4.10's directory check).

/** jest-circus' state (it keeps the run's name filter there), under its unregistered symbol. */
export function circusState(): { testNamePattern: RegExp | null } {
  const sym = Object.getOwnPropertySymbols(globalThis).find((s) => s.description === 'JEST_STATE_SYMBOL');
  if (sym === undefined) throw new Error("jest-circus' state isn't on globalThis");
  return (globalThis as Record<symbol, { testNamePattern: RegExp | null }>)[sym];
}

/** True when jest was given a name filter (`-t` / `--testNamePattern`). */
export function nameFiltered(state: { testNamePattern: RegExp | null } = circusState()): boolean {
  return state.testNamePattern !== null && state.testNamePattern !== undefined;
}
