/**
 * R2 — web LLM tools must parameterize Cypher.
 *
 * GitNexus feeds adversarial, repository-derived strings (symbol names, file
 * paths, cluster/process IDs) into the `explore`, `impact`, and `overview`
 * tools. Those value positions MUST be bound as prepared-statement params
 * ($placeholders), never string-interpolated into the Cypher text — otherwise a
 * symbol named `x' OR 1=1 //` could alter query structure (Cypher injection).
 *
 * These tests build the real tools with a fake backend that records every
 * (cypher, params) pair, drive the tools with an adversarial target, and assert
 * the adversarial value never appears in the Cypher string and always appears
 * in the bound params.
 */
import { describe, expect, it, vi } from 'vitest';
import { createGraphRAGTools, type GraphRAGBackend } from '../../src/core/llm/tools';

const ADVERSARIAL = "x' OR 1=1 //";

type Call = { cypher: string; params?: Record<string, unknown> };

/**
 * Build the tools with an executeQuery spy that records (cypher, params). The
 * `respond` callback lets a test return rows for specific queries so the tool
 * proceeds past its "find target" step into the value-bearing follow-up queries.
 */
const makeTools = (respond: (cypher: string) => Record<string, unknown>[] = () => []) => {
  const calls: Call[] = [];
  const executeQuery = vi.fn(
    async (
      cypher: string,
      params?: Record<string, unknown>,
    ): Promise<Record<string, unknown>[]> => {
      calls.push({ cypher, params });
      return respond(cypher);
    },
  );
  const backend: GraphRAGBackend = {
    executeQuery,
    search: async () => [],
    grep: async () => [],
    readFile: async () => '',
  };
  const tools = createGraphRAGTools(backend);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { calls, executeQuery, byName };
};

/** True if any recorded Cypher string literally contains the needle. */
const cypherContains = (calls: Call[], needle: string): boolean =>
  calls.some((c) => c.cypher.includes(needle));

/** Flatten every bound param value across all recorded calls. */
const allParamValues = (calls: Call[]): unknown[] =>
  calls.flatMap((c) => (c.params ? Object.values(c.params) : []));

describe('explore tool — R2 parameterized Cypher', () => {
  it('binds an adversarial target as a param, never interpolating it', async () => {
    // Resolve the target as a symbol so the value-bearing follow-up queries run.
    const { calls, byName } = makeTools((cypher) => {
      if (cypher.includes('label(n) AS nodeType')) {
        return [
          { id: 'Function:evil', name: 'evil', filePath: 'src/evil.ts', nodeType: 'Function' },
        ];
      }
      return [];
    });

    await byName.explore.invoke({ target: ADVERSARIAL, type: 'symbol' });

    expect(cypherContains(calls, ADVERSARIAL)).toBe(false);
    expect(cypherContains(calls, 'OR 1=1')).toBe(false);
    // The adversarial string reached the backend as a bound param value.
    expect(allParamValues(calls)).toContain(ADVERSARIAL);
  });

  it('does not double-quote-escape (no "  remnant) — relies on binding instead', async () => {
    const { calls, byName } = makeTools(() => []);
    await byName.explore.invoke({ target: "it's a test" });
    // No query should contain the doubled-quote escaping artifact.
    expect(cypherContains(calls, "it''s")).toBe(false);
    expect(allParamValues(calls)).toContain("it's a test");
  });
});

describe('impact tool — R2 parameterized Cypher', () => {
  it('binds an adversarial name target as a param, never interpolating it', async () => {
    const { calls, byName } = makeTools((cypher) => {
      // Resolve the target node so depth queries run.
      if (cypher.includes('label(n) AS nodeType') && cypher.includes('n.name')) {
        return [{ id: 'Function:evil', nodeType: 'Function', filePath: 'src/evil.ts' }];
      }
      return [];
    });

    await byName.impact.invoke({ target: ADVERSARIAL, direction: 'upstream' });

    expect(cypherContains(calls, ADVERSARIAL)).toBe(false);
    expect(cypherContains(calls, 'OR 1=1')).toBe(false);
    expect(allParamValues(calls)).toContain(ADVERSARIAL);
  });

  it('binds an adversarial file-path target (path branch) as a param', async () => {
    const advPath = "src/'; MATCH (x) DETACH DELETE x ///a.ts";
    const { calls, byName } = makeTools((cypher) => {
      if (cypher.includes('label(n) AS nodeType') && cypher.includes('n.filePath')) {
        return [{ id: 'File:evil', nodeType: 'File', filePath: advPath }];
      }
      return [];
    });

    await byName.impact.invoke({ target: advPath, direction: 'downstream' });

    expect(cypherContains(calls, 'DETACH DELETE')).toBe(false);
    expect(allParamValues(calls)).toContain(advPath);
  });

  it('rejects an invalid relation type (allowlist guards the relType position)', async () => {
    const { calls, byName } = makeTools(() => []);
    const result = await byName.impact.invoke({
      target: 'something',
      direction: 'upstream',
      relationTypes: ["CALLS'; DROP //"],
    });
    // The bogus relType is filtered out by validRelType, leaving none → early return.
    expect(typeof result).toBe('string');
    expect(result).toContain('No valid relation types');
    // It must never have reached a Cypher string.
    expect(cypherContains(calls, 'DROP')).toBe(false);
  });
});

describe('overview tool — R2 parameterized Cypher', () => {
  it('reaches runQuery without interpolating untrusted values', async () => {
    const { calls, byName } = makeTools(() => []);
    await byName.overview.invoke({});
    // overview has no user-supplied value positions; assert it executed queries.
    expect(calls.length).toBeGreaterThan(0);
  });
});
