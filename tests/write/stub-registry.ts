// Sanctuary Computer (quickbooks-mcp-293): a test-only capability registry that takes raw hashes, for the guard rules' tests.
// Nothing under src/ may import it: the real registry hashes a checked request itself.
import { sha256Hex } from '../../src/write/canonical.js';

export class StubRegistry {
  private readonly held = new Set<string>();
  hasCalls = 0;
  /** Every `take`, in order, with its answer. */
  readonly takes: Array<{ company: string; entity: string; sha: string; taken: boolean }> = [];

  hold(company: string, entity: string, body: string): this {
    this.held.add(`${company} ${entity} ${sha256Hex(body)}`);
    return this;
  }

  has(company: string, entity: string, sha: string): boolean {
    this.hasCalls += 1;
    return this.held.has(`${company} ${entity} ${sha}`);
  }

  take(company: string, entity: string, sha: string): boolean {
    const taken = this.held.delete(`${company} ${entity} ${sha}`);
    this.takes.push({ company, entity, sha, taken });
    return taken;
  }

  get size(): number {
    return this.held.size;
  }
}
