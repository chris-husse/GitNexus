import { describe, expect, it } from 'vitest';
import { isValidQueryParams } from '../../src/core/lbug/query-params.js';

describe('isValidQueryParams', () => {
  it('accepts plain objects', () => {
    expect(isValidQueryParams({})).toBe(true);
    expect(isValidQueryParams({ name: 'main', limit: 10 })).toBe(true);
    expect(isValidQueryParams({ enabled: true, score: null })).toBe(true);
    expect(isValidQueryParams(Object.create(null))).toBe(true);
  });

  it('rejects null and arrays', () => {
    expect(isValidQueryParams(null)).toBe(false);
    expect(isValidQueryParams([])).toBe(false);
  });

  it('rejects primitives', () => {
    expect(isValidQueryParams('x')).toBe(false);
    expect(isValidQueryParams(1)).toBe(false);
    expect(isValidQueryParams(false)).toBe(false);
    expect(isValidQueryParams(undefined)).toBe(false);
  });

  it('rejects non-plain objects and non-scalar values', () => {
    expect(isValidQueryParams(new Date())).toBe(false);
    expect(isValidQueryParams(new Map())).toBe(false);
    expect(isValidQueryParams({ nested: { value: 1 } })).toBe(false);
  });

  // R2-server: arrays of scalars are needed so `WHERE n.id IN $ids` works from
  // the web LLM tools. They are accepted; nested objects / arrays-of-objects
  // are still rejected.
  it('accepts top-level array-of-scalar param values (R2)', () => {
    expect(isValidQueryParams({ ids: ['a', 'b', 'c'] })).toBe(true);
    expect(isValidQueryParams({ ids: [] })).toBe(true);
    expect(isValidQueryParams({ nums: [1, 2, 3], flags: [true, false, null] })).toBe(true);
    expect(isValidQueryParams({ id: 'x', ids: ['a', 'b'] })).toBe(true);
  });

  it('rejects arrays containing non-scalars and nested arrays (R2)', () => {
    expect(isValidQueryParams({ ids: [{ a: 1 }] })).toBe(false);
    expect(isValidQueryParams({ ids: [['nested']] })).toBe(false);
    expect(isValidQueryParams({ ids: ['ok', { bad: 1 }] })).toBe(false);
    // The param map itself must still be a plain object, never an array.
    expect(isValidQueryParams(['a', 'b'])).toBe(false);
  });
});
