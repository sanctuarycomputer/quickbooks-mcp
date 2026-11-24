// Sanctuary Computer (quickbooks-mcp-285): the qbo_companies stub until the Stacks token client lands.
// Changed by Sanctuary Computer (quickbooks-mcp-286): a companies handler is called with the call's arguments and the runtime.
import { describe, it, expect } from '@jest/globals';
import { QboCompaniesTool } from '../../src/tools/qbo-companies.tool';
import type { Runtime } from '../../src/clients/runtime';

describe('qbo_companies stub', () => {
  it('A9: name, description and the stub error', async () => {
    expect(QboCompaniesTool.name).toBe('qbo_companies');
    expect(QboCompaniesTool.description).toBe(
      'List the companies this server can read (key, name), for the company argument of every other tool.',
    );
    expect(await QboCompaniesTool.handler({}, {} as Runtime)).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'reason: fork-error\n\nqbo_companies lands with the Stacks token client' }],
    });
  });
});
