import { describe, it, expect, vi } from 'vitest';
import { fetchMetadataByLabel } from '../../src/core/embeddings/embedding-pipeline.js';

/**
 * R3 (security round 3): the per-label metadata fetch in semanticSearch derives
 * the Cypher label from a DB nodeId substring and interpolates it into a label
 * position (`MATCH (n:\`${label}\`)`). Cypher labels cannot be parameterized, so
 * the label MUST be validated against the NODE_TABLES allowlist before it is
 * interpolated. A nodeId whose prefix is not a known node table must never reach
 * an interpolated query.
 *
 * These tests exercise the extracted, executor-mocked helper directly so the
 * label/id-list hardening is verified without standing up the embedder.
 */
describe('fetchMetadataByLabel — Cypher label allowlist (R3)', () => {
  const chunk = { distance: 0.1, chunkIndex: 0, startLine: 1, endLine: 2 };

  it('does NOT run an interpolated MATCH for a label outside NODE_TABLES', async () => {
    const evilLabel = 'Function`)-[:x]->() DETACH DELETE n //';
    const byLabel = new Map<string, Array<{ nodeId: string; distance: number }>>([
      [evilLabel, [{ nodeId: `${evilLabel}:src/x.ts:foo`, ...chunk }]],
    ]);

    const executeQuery = vi.fn(async () => []);
    const results = await fetchMetadataByLabel(executeQuery, byLabel);

    // The unvalidated label must never be interpolated into a query.
    expect(executeQuery).not.toHaveBeenCalled();
    // No interpolated string containing the evil payload may exist.
    for (const call of executeQuery.mock.calls) {
      expect(String(call[0])).not.toContain('DETACH DELETE');
    }
    expect(results).toEqual([]);
  });

  it('queries normally for a valid label and binds ids (no raw injection)', async () => {
    const nodeId = 'Function:src/calc.ts:add';
    const byLabel = new Map<string, Array<{ nodeId: string; distance: number }>>([
      ['Function', [{ nodeId, ...chunk }]],
    ]);

    const executeQuery = vi.fn(async () => [
      { id: nodeId, name: 'add', filePath: 'src/calc.ts', startLine: 1, endLine: 2 },
    ]);

    const results = await fetchMetadataByLabel(executeQuery, byLabel);

    expect(executeQuery).toHaveBeenCalledTimes(1);
    const cypher = String(executeQuery.mock.calls[0][0]);
    expect(cypher).toContain('MATCH (n:`Function`)');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      nodeId,
      name: 'add',
      label: 'Function',
      filePath: 'src/calc.ts',
    });
  });

  it('prefers parameterized id binding when a prepared executor is supplied', async () => {
    const nodeId = "Function:src/x.ts:weird'name";
    const byLabel = new Map<string, Array<{ nodeId: string; distance: number }>>([
      ['Function', [{ nodeId, ...chunk }]],
    ]);

    const executeParameterized = vi.fn(async () => [
      { id: nodeId, name: 'weird', filePath: 'src/x.ts', startLine: 1, endLine: 2 },
    ]);
    const executeQuery = vi.fn(async () => []);

    const results = await fetchMetadataByLabel(executeQuery, byLabel, executeParameterized);

    // When a prepared executor is available, the id list is bound as a param,
    // not interpolated into the Cypher text.
    expect(executeParameterized).toHaveBeenCalledTimes(1);
    expect(executeQuery).not.toHaveBeenCalled();
    const [cypher, params] = executeParameterized.mock.calls[0];
    expect(String(cypher)).toContain('$ids');
    expect(String(cypher)).not.toContain("weird'name");
    expect((params as Record<string, unknown>).ids).toEqual([nodeId]);
    expect(results).toHaveLength(1);
  });

  it('skips a group whose label is valid but whose query throws (table missing)', async () => {
    const byLabel = new Map<string, Array<{ nodeId: string; distance: number }>>([
      ['Struct', [{ nodeId: 'Struct:src/x.rs:Foo', ...chunk }]],
    ]);
    const executeQuery = vi.fn(async () => {
      throw new Error('Table Struct does not exist');
    });

    const results = await fetchMetadataByLabel(executeQuery, byLabel);
    expect(results).toEqual([]);
  });
});
