// Changed by Sanctuary Computer (quickbooks-mcp-286): the fetchAll and count pass-through case becomes the normalizer's refusals.
import { describe, it, expect } from '@jest/globals';
import { buildQuickbooksSearchCriteria } from '../../../src/helpers/build-quickbooks-search-criteria';
import { normalizeSearch } from '../../../src/helpers/validate-input';

describe('buildQuickbooksSearchCriteria – Fixes #13', () => {
  it('should pass through a simple criteria object', () => {
    const input = { Name: 'Foo' };
    expect(buildQuickbooksSearchCriteria(input)).toEqual(input);
  });

  it('should pass through an array as-is', () => {
    const input = [{ field: 'Name', value: 'Foo', operator: '=' }];
    expect(buildQuickbooksSearchCriteria(input)).toEqual(input);
  });

  it('should convert advanced options with filters', () => {
    const input = {
      filters: [{ field: 'TxnDate', value: '2026-01-01', operator: '>=' }],
      limit: 10,
      asc: 'TxnDate',
    };
    const result = buildQuickbooksSearchCriteria(input) as Array<Record<string, any>>;

    expect(Array.isArray(result)).toBe(true);
    expect(result).toContainEqual({ field: 'TxnDate', value: '2026-01-01', operator: '>=' });
    expect(result).toContainEqual({ field: 'asc', value: 'TxnDate' });
    expect(result).toContainEqual({ field: 'limit', value: 10 });
  });

  it('should accept "criteria" as an alias for "filters" and not drop them', () => {
    // This is the exact scenario from issue #13: criteria + pagination params
    const input = {
      criteria: [{ field: 'TxnDate', value: '2026-01-01', operator: '>=' }],
      limit: 10,
      asc: 'TxnDate',
    };
    const result = buildQuickbooksSearchCriteria(input) as Array<Record<string, any>>;

    expect(Array.isArray(result)).toBe(true);
    // The filter must NOT be silently dropped
    expect(result).toContainEqual({ field: 'TxnDate', value: '2026-01-01', operator: '>=' });
    expect(result).toContainEqual({ field: 'asc', value: 'TxnDate' });
    expect(result).toContainEqual({ field: 'limit', value: 10 });
  });

  it('should prefer "filters" over "criteria" if both are provided', () => {
    const input = {
      filters: [{ field: 'Name', value: 'A', operator: '=' }],
      criteria: [{ field: 'Name', value: 'B', operator: '=' }],
    };
    const result = buildQuickbooksSearchCriteria(input) as Array<Record<string, any>>;

    expect(result).toContainEqual({ field: 'Name', value: 'A', operator: '=' });
    expect(result).not.toContainEqual({ field: 'Name', value: 'B', operator: '=' });
  });

  it('should handle desc and offset options', () => {
    const input = { desc: 'MetaData.CreateTime', offset: 5 };
    const result = buildQuickbooksSearchCriteria(input) as Array<Record<string, any>>;

    expect(result).toContainEqual({ field: 'desc', value: 'MetaData.CreateTime' });
    expect(result).toContainEqual({ field: 'offset', value: 5 });
  });

  // quickbooks-mcp-286 (A5.2, A5.3, A6.3): count and fetchAll are passed on, and the input normalizer refuses them.
  it('passes count and fetchAll on, and the normalizer refuses each', () => {
    const refused = (what: string) => ({
      ok: false,
      failure: { reason: 'fork-error', text: `The search was refused before reaching QuickBooks: ${what}. Use limit up to 1000 and page with offset.` },
    });
    const withCount = buildQuickbooksSearchCriteria({ desc: 'MetaData.CreateTime', offset: 5, count: true });
    expect(withCount).toContainEqual({ field: 'count', value: true });
    expect(normalizeSearch('search_purchases', withCount)).toEqual(refused("count isn't supported by this tool"));
    const withFetchAll = buildQuickbooksSearchCriteria({ desc: 'MetaData.CreateTime', offset: 5, fetchAll: true });
    expect(withFetchAll).toContainEqual({ field: 'fetchAll', value: true });
    expect(normalizeSearch('search_purchases', withFetchAll)).toEqual(refused("fetchAll isn't supported"));
  });

  it('passes every page key on whatever its value, so a bad one is refused rather than dropped', () => {
    const input = { asc: '', desc: '', limit: '10 x', offset: 0, count: false, fetchAll: false };
    expect(buildQuickbooksSearchCriteria(input as any)).toEqual([
      { field: 'asc', value: '' },
      { field: 'desc', value: '' },
      { field: 'limit', value: '10 x' },
      { field: 'offset', value: 0 },
      { field: 'count', value: false },
      { field: 'fetchAll', value: false },
    ]);
  });

  it('should return empty object when advanced options are all empty', () => {
    const input = { filters: [] };
    const result = buildQuickbooksSearchCriteria(input);
    expect(result).toEqual({});
  });

  it('should pass through null/undefined as a simple criteria object', () => {
    // Not advanced, so returned as-is per the pass-through logic
    expect(buildQuickbooksSearchCriteria(null as any)).toBeNull();
    expect(buildQuickbooksSearchCriteria(undefined as any)).toBeUndefined();
  });
});
