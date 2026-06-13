/**
 * Unit tests for wiki graph-query Cypher parameterization (B1, round 2).
 *
 * The wiki module previously interpolated file paths / process ids directly into
 * Cypher via `IN [${fileList}]` with a hand-rolled `'' ` quote-escape. These
 * tests mock the pooled adapter and assert that file paths and ids are now bound
 * as prepared-statement parameter arrays (`WHERE a.filePath IN $files`,
 * `WHERE ... {id: $procId}` etc.) and that adversarial values never appear
 * interpolated into the Cypher string.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every (cypher, params) pair the queries send to the adapter.
const calls: Array<{ cypher: string; params: Record<string, unknown> }> = [];

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn(async () => {}),
  closeLbug: vi.fn(async () => {}),
  touchRepo: vi.fn(() => {}),
  executeQuery: vi.fn(async (_repo: string, cypher: string) => {
    calls.push({ cypher, params: {} });
    return [];
  }),
  executeParameterized: vi.fn(
    async (_repo: string, cypher: string, params: Record<string, unknown>) => {
      calls.push({ cypher, params });
      return [];
    },
  ),
}));

import {
  getIntraModuleCallEdges,
  getInterModuleCallEdges,
  getProcessesForFiles,
} from '../../src/core/wiki/graph-queries.js';

beforeEach(() => {
  calls.length = 0;
});

describe('getIntraModuleCallEdges — parameterized (B1)', () => {
  it('binds file paths as a $files array and does not interpolate them', async () => {
    const adversarial = ["src/a.ts' OR '1'='1", 'src/b.ts'];
    await getIntraModuleCallEdges(adversarial);

    expect(calls).toHaveLength(1);
    const { cypher, params } = calls[0];
    // File paths are bound, not interpolated.
    expect(params).toHaveProperty('files');
    expect(params.files).toEqual(adversarial);
    // The Cypher references the param, not a literal IN [ ... ] list.
    expect(cypher).toContain('$files');
    expect(cypher).not.toContain("'1'='1");
    expect(cypher).not.toMatch(/IN \[/);
  });

  it('returns [] without touching the adapter for an empty file list', async () => {
    const out = await getIntraModuleCallEdges([]);
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('getInterModuleCallEdges — parameterized (B1)', () => {
  it('binds file paths as $files in both the outgoing and incoming queries', async () => {
    const files = ["src/x.ts'); DROP", 'src/y.ts'];
    await getInterModuleCallEdges(files);

    expect(calls).toHaveLength(2);
    for (const { cypher, params } of calls) {
      expect(params.files).toEqual(files);
      expect(cypher).toContain('$files');
      expect(cypher).not.toMatch(/IN \[/);
      expect(cypher).not.toContain('DROP');
    }
  });
});

describe('getProcessesForFiles — parameterized (B1)', () => {
  it('binds the file list and the process id as params (no interpolation)', async () => {
    // First query returns one process row so the per-process step query runs and
    // we can assert the id is bound rather than interpolated.
    const adapter = await import('../../src/core/lbug/pool-adapter.js');
    (adapter.executeParameterized as any).mockImplementationOnce(
      async (_repo: string, cypher: string, params: Record<string, unknown>) => {
        calls.push({ cypher, params });
        return [{ id: "p1' OR '1'='1", label: 'L', type: 'http', stepCount: 1 }];
      },
    );

    await getProcessesForFiles(["src/a.ts' --", 'src/b.ts']);

    // 1 process-discovery query + 1 step query.
    expect(calls.length).toBe(2);
    const discovery = calls[0];
    expect(discovery.params.files).toEqual(["src/a.ts' --", 'src/b.ts']);
    expect(discovery.cypher).toContain('$files');
    expect(discovery.cypher).not.toMatch(/IN \[/);

    const stepQuery = calls[1];
    // The process id is bound, never interpolated into the Cypher.
    expect(stepQuery.params).toHaveProperty('procId', "p1' OR '1'='1");
    expect(stepQuery.cypher).toContain('$procId');
    expect(stepQuery.cypher).not.toContain("'1'='1");
  });
});
