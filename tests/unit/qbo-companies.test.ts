// Sanctuary Computer (quickbooks-mcp-285): the qbo_companies stub until the Stacks token client lands.
import { describe, it, expect } from '@jest/globals';
import { QboCompaniesTool } from '../../src/tools/qbo-companies.tool';

describe('qbo_companies stub', () => {
  it('A9: name, description and the stub error', async () => {
    expect(QboCompaniesTool.name).toBe('qbo_companies');
    expect(QboCompaniesTool.description).toBe(
      'List the companies this server can read (key, name), for the company argument of every other tool.',
    );
    expect(await QboCompaniesTool.handler()).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'reason: fork-error\n\nqbo_companies lands with the Stacks token client' }],
    });
  });
});
