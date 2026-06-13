/**
 * R11 — tool-result control markers ([HIGHLIGHT_NODES:…] / [IMPACT:…]) must
 * only drive UI state with IDs that exist in the live graph.
 *
 * `resolveMarkerIds` is the shared validator the marker-parsing code in
 * useAppState uses for BOTH markers. Unknown IDs (e.g. injected by adversarial
 * tool output) must be dropped — there is no "trust the raw IDs" fallback.
 */
import { describe, expect, it } from 'vitest';
import { resolveMarkerIds } from '../../src/hooks/useAppState';

describe('resolveMarkerIds — validates marker IDs against the live graph', () => {
  const graphIds = new Set(['Function:src/a.ts:foo', 'Class:src/b.ts:Bar', 'File:src/c.ts']);

  it('keeps exact-match IDs that are present in the graph', () => {
    const out = resolveMarkerIds(['Function:src/a.ts:foo', 'File:src/c.ts'], graphIds);
    expect([...out].sort()).toEqual(['File:src/c.ts', 'Function:src/a.ts:foo']);
  });

  it('resolves a suffix match to the full graph node ID', () => {
    // The agent may emit a short id; we resolve it to a real graph node by suffix.
    const out = resolveMarkerIds(['foo'], graphIds);
    expect([...out]).toEqual(['Function:src/a.ts:foo']);
  });

  it('drops IDs that do not exist in the graph (no unvalidated fallback)', () => {
    const out = resolveMarkerIds(["'; MATCH (x) DETACH DELETE x //", 'Unknown:node:zzz'], graphIds);
    expect(out.size).toBe(0);
  });

  it('returns an empty set when given only unknown IDs even if non-empty input', () => {
    // This is the key regression guard for R11: a non-empty rawIds list of
    // unknown IDs must NOT highlight anything (the old `else if` fallback did).
    const out = resolveMarkerIds(['ghost1', 'ghost2', 'ghost3'], graphIds);
    expect(out.size).toBe(0);
  });

  it('returns an empty set for empty input', () => {
    expect(resolveMarkerIds([], graphIds).size).toBe(0);
  });
});
