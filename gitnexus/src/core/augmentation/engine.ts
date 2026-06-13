/**
 * Augmentation Engine
 *
 * Lightweight, fast-path enrichment of search patterns with knowledge graph context.
 * Designed to be called from platform hooks (Claude Code PreToolUse, Cursor postToolUse)
 * when an agent runs grep/glob/read/search.
 *
 * Performance target: <500ms cold start, <200ms warm.
 *
 * Design decisions:
 * - Uses only BM25 search (no semantic/embedding) for speed
 * - Clusters used internally for ranking, NEVER in output
 * - Output is pure relationships: callers, callees, process participation
 * - Graceful failure: any error → return empty string
 */

import { resolveGraphPath } from '../../storage/shared-store.js';
import path from 'path';
import { listRegisteredRepos } from '../../storage/repo-manager.js';
import {
  requireRegisteredStoragePath,
  STATUS_STORAGE_REQUIREMENTS,
} from '../../storage/storage-resolver.js';
import { LBUG_DIRECTORY } from '../../storage/storage-constants.js';
import { BRANCHES_DIR, branchSlug } from '../../storage/branch-index.js';
import { getCurrentBranch } from '../../storage/git.js';

/** Open/close fences for the hook's additional-context data region (R5). */
const CONTEXT_FENCE_START = '--- BEGIN GITNEXUS CONTEXT ---';
const CONTEXT_FENCE_END = '--- END GITNEXUS CONTEXT ---';

/**
 * Neutralize a graph-derived name before it is interpolated into the hook
 * output (R5). Symbol names come from arbitrary third-party repositories; an
 * adversarial name containing newlines or control characters could otherwise
 * inject new top-level lines (e.g. a forged `[GitNexus] …` header or fake
 * instructions) into the additional-context block a downstream agent reads.
 * Strips ASCII/Unicode control chars and collapses any run of whitespace
 * (including newlines/tabs) to a single space so every name stays on one line.
 */
function sanitizeName(name: string): string {
  return (
    name
      // Strip ASCII C0 (incl. CR/LF/TAB), DEL/C1 control chars, and the Unicode
      // line/paragraph separators some renderers treat as line breaks.

      .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, ' ')
      // Collapse any remaining whitespace run to a single space so every name
      // stays on one physical line in the output.
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Find the best matching repo for a given working directory.
 * Matches by checking if cwd is within the repo's path.
 */
async function findRepoForCwd(cwd: string): Promise<{
  name: string;
  storagePath: string;
  lbugPath: string;
} | null> {
  try {
    const entries = await listRegisteredRepos({ validate: true });
    const resolved = path.resolve(cwd);

    // Normalize to lowercase on Windows (drive letters can differ: D: vs d:)
    const isWindows = process.platform === 'win32';
    const normalizedCwd = isWindows ? resolved.toLowerCase() : resolved;
    const sep = path.sep;

    // Find the LONGEST matching repo path (most specific match wins)
    let bestMatch: (typeof entries)[0] | null = null;
    let bestLen = 0;

    for (const entry of entries) {
      const repoResolved = path.resolve(entry.path);
      const normalizedRepo = isWindows ? repoResolved.toLowerCase() : repoResolved;

      // Exact path, or cwd inside the repo at a separator boundary.
      // Parent-directory invocation must not attach to a nested registered checkout.
      let matched = false;
      if (normalizedCwd === normalizedRepo) {
        matched = true;
      } else {
        const repoPrefix = normalizedRepo.endsWith(sep) ? normalizedRepo : normalizedRepo + sep;
        if (normalizedCwd.startsWith(repoPrefix)) {
          matched = true;
        }
      }

      if (matched && normalizedRepo.length > bestLen) {
        bestMatch = entry;
        bestLen = normalizedRepo.length;
      }
    }

    if (!bestMatch) return null;

    const storagePath = await requireRegisteredStoragePath(bestMatch, STATUS_STORAGE_REQUIREMENTS);
    const branch = getCurrentBranch(bestMatch.path);
    const branchIsIndexed =
      Boolean(branch) &&
      Array.isArray(bestMatch.branches) &&
      bestMatch.branches.some((summary) => summary.branch === branch);
    const indexDir =
      branchIsIndexed && branch
        ? path.join(storagePath, BRANCHES_DIR, branchSlug(branch))
        : storagePath;
    return {
      name: bestMatch.name,
      storagePath,
      lbugPath:
        indexDir === storagePath
          ? resolveGraphPath(storagePath)
          : path.join(indexDir, LBUG_DIRECTORY),
    };
  } catch {
    return null;
  }
}

/**
 * Augment a search pattern with knowledge graph context.
 *
 * 1. BM25 search for the pattern
 * 2. For top matches, fetch callers/callees/processes
 * 3. Rank by internal cluster cohesion (not exposed)
 * 4. Format as structured text block
 *
 * Returns empty string on any error (graceful failure).
 */
export async function augment(pattern: string, cwd?: string): Promise<string> {
  if (!pattern || pattern.length < 3) return '';

  // No quote-escaping: patternFirstWord is bound as a Cypher parameter ($needle),
  // never interpolated, so it cannot alter query structure (R1).
  const patternFirstWord = pattern.trim().split(/\s+/)[0];
  if (!patternFirstWord || patternFirstWord.length < 2) return '';

  const workDir = cwd || process.cwd();

  try {
    const repo = await findRepoForCwd(workDir);
    if (!repo) return '';

    // Lazy-load lbug adapter (skip unnecessary init). All value-bearing queries
    // go through executeParameterized so graph-/input-derived strings are bound
    // as parameters, never interpolated into Cypher (R1).
    const { initLbug, executeParameterized, isLbugReady } = await import('../lbug/pool-adapter.js');
    const { searchFTSFromLbug } = await import('../search/bm25-index.js');

    const repoId = repo.name.toLowerCase();

    // Init LadybugDB if not already
    if (!isLbugReady(repoId)) {
      await initLbug(repoId, repo.lbugPath);
    }

    // Step 1: BM25 search (fast, no embeddings)
    const { results: bm25Results } = await searchFTSFromLbug(pattern, 10, repoId);

    // Step 2: Map BM25 file results to symbols
    const symbolMatches: Array<{
      nodeId: string;
      name: string;
      type: string;
      filePath: string;
      score: number;
    }> = [];

    for (const result of bm25Results.slice(0, 5)) {
      try {
        const symbols = await executeParameterized(
          repoId,
          `
          MATCH (n) WHERE n.filePath = $fp
          AND n.name CONTAINS $needle
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
          ORDER BY id
          LIMIT 3
        `,
          { fp: result.filePath, needle: patternFirstWord },
        );
        for (const sym of symbols) {
          symbolMatches.push({
            nodeId: sym.id || sym[0],
            name: sym.name || sym[1],
            type: sym.type || sym[2],
            filePath: sym.filePath || sym[3],
            score: result.score,
          });
        }
      } catch {
        /* skip */
      }
    }

    // FTS ranks files by mentions, so a widely referenced symbol's definition
    // may not be present in the top file results. Fall back to graph names
    // whenever those files produce no symbol match, regardless of FTS health.
    if (symbolMatches.length === 0) {
      const fallbackRows = await executeParameterized(
        repoId,
        `
        MATCH (n)
        WHERE n.name CONTAINS $needle
        RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath,
          CASE WHEN n.name = $needle THEN 0 ELSE 1 END AS exactRank
        ORDER BY exactRank, id
        LIMIT 5
      `,
        { needle: patternFirstWord },
      ).catch(() => []);
      for (const sym of fallbackRows) {
        symbolMatches.push({
          nodeId: sym.id || sym[0],
          name: sym.name || sym[1],
          type: sym.type || sym[2],
          filePath: sym.filePath || sym[3],
          score: 1.0,
        });
      }
    }

    if (symbolMatches.length === 0) return '';

    // Step 3: Batch-fetch callers/callees/processes/cohesion for top matches
    // Uses batched WHERE n.id IN [...] queries instead of per-symbol queries
    const uniqueSymbols = symbolMatches
      .slice(0, 5)
      .filter((sym, i, arr) => arr.findIndex((s) => s.nodeId === sym.nodeId) === i);

    if (uniqueSymbols.length === 0) return '';

    // Build the WHERE n.id IN [...] clause from parameter PLACEHOLDERS, not from
    // the node ids themselves (R1). Each id is bound as its own scalar param
    // ($id0, $id1, …); only the fixed placeholder tokens are interpolated, so an
    // adversarial node id cannot alter query structure. This placeholder-list
    // form avoids depending on array-parameter binding in the prepared-statement
    // path while remaining fully injection-safe.
    const idPlaceholders = uniqueSymbols.map((_, i) => `$id${i}`).join(', ');
    const idParams: Record<string, string> = {};
    uniqueSymbols.forEach((s, i) => {
      idParams[`id${i}`] = s.nodeId;
    });

    // Callers/callees are windowed PER SYMBOL, not out of one shared budget.
    // A single `n.id IN [...] ... ORDER BY targetId LIMIT 15` sorts by the very
    // column the rows are grouped by, which turns the cap into a single-bucket
    // prefix: the alphabetically-first target takes every row (the hottest
    // symbol in this repo's own index has 2163 callers) and the other four
    // render with no callers at all. Raising the cap does not bound that, and
    // ordering caller-major only moves the bucket. A per-target window is not
    // expressible in one statement either — LadybugDB does not preserve a
    // per-branch ORDER BY through UNION ALL — so fan out one bounded query per
    // symbol (#2787).
    //
    // `id STARTS WITH 'File:'` sorts container nodes last: node ids are
    // `Label:path:name`, so a bare `ORDER BY id` puts `File:` ahead of
    // `Function:`/`Method:` and the "Called by" line renders bare filenames
    // instead of the calling symbols the hint exists to name.
    const NEIGHBOUR_CAP = 3;
    const neighbourNames = async (nodeId: string, incoming: boolean): Promise<string[]> => {
      const edge = incoming
        ? `(other)-[:CodeRelation {type: 'CALLS'}]->(n)`
        : `(n)-[:CodeRelation {type: 'CALLS'}]->(other)`;
      const rows = await executeParameterized(
        repoId,
        `
        MATCH ${edge}
        WHERE n.id = $nodeId
        RETURN other.name AS name
        ORDER BY other.id STARTS WITH 'File:', other.id
        LIMIT ${NEIGHBOUR_CAP}
      `,
        { nodeId },
      ).catch(() => []);
      const names: string[] = [];
      for (const r of rows) {
        const name = r.name || r[0];
        if (name) names.push(name);
      }
      return names;
    };

    // Keyed by nodeId, like the process/cohesion enrichments below — positional
    // arrays would put two lookup disciplines in one object literal and make
    // "stays index-aligned with uniqueSymbols" an unenforced invariant.
    const neighbourMap = async (incoming: boolean): Promise<Map<string, string[]>> =>
      new Map(
        await Promise.all(
          uniqueSymbols.map(
            async (s) => [s.nodeId, await neighbourNames(s.nodeId, incoming)] as const,
          ),
        ),
      );

    // Batch fetch processes
    const fetchProcesses = async (): Promise<Map<string, string[]>> => {
      const byNode = new Map<string, string[]>();
      try {
        const rows = await executeParameterized(
          repoId,
          `
        MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
        WHERE n.id IN [${idPlaceholders}]
        RETURN n.id AS nodeId, p.heuristicLabel AS label, r.step AS step, p.stepCount AS stepCount
      `,
          idParams,
        );
        for (const r of rows) {
          const nid = r.nodeId || r[0];
          const label = r.label || r[1];
          const step = r.step || r[2];
          const stepCount = r.stepCount || r[3];
          if (nid && label) {
            if (!byNode.has(nid)) byNode.set(nid, []);
            // Sanitize the heuristic label (untrusted, graph-derived) so a
            // newline/control char in it cannot inject a line into the output (R5).
            byNode.get(nid)!.push(`${sanitizeName(String(label))} (step ${step}/${stepCount})`);
          }
        }
      } catch {
        /* skip */
      }
      return byNode;
    };

    // Batch fetch cohesion
    const fetchCohesion = async (): Promise<Map<string, number>> => {
      const byNode = new Map<string, number>();
      try {
        const rows = await executeParameterized(
          repoId,
          `
        MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
        WHERE n.id IN [${idPlaceholders}]
        RETURN n.id AS nodeId, c.cohesion AS cohesion
      `,
          idParams,
        );
        for (const r of rows) {
          const nid = r.nodeId || r[0];
          const coh = r.cohesion ?? r[1] ?? 0;
          if (nid) byNode.set(nid, coh);
        }
      } catch {
        /* skip */
      }
      return byNode;
    };

    // One wave, not three. `augment` runs from the Claude Code PreToolUse hook
    // in a cold process against a <500ms budget, so nothing amortizes — and the
    // process/cohesion queries depend only on `idParams`, never on the neighbour
    // results, so serializing them behind the fan-out bought nothing. Each query
    // keeps its own try/catch, so one failing still degrades to an empty map
    // instead of taking the others down.
    const [callerMap, calleeMap, processesMap, cohesionMap] = await Promise.all([
      neighbourMap(true),
      neighbourMap(false),
      fetchProcesses(),
      fetchCohesion(),
    ]);

    // Assemble enriched results
    const enriched: Array<{
      name: string;
      filePath: string;
      callers: string[];
      callees: string[];
      processes: string[];
      cohesion: number;
    }> = [];

    for (const sym of uniqueSymbols) {
      enriched.push({
        name: sym.name,
        filePath: sym.filePath,
        callers: callerMap.get(sym.nodeId) || [],
        callees: calleeMap.get(sym.nodeId) || [],
        processes: processesMap.get(sym.nodeId) || [],
        cohesion: cohesionMap.get(sym.nodeId) || 0,
      });
    }

    if (enriched.length === 0) return '';

    // Step 4: Rank by cohesion (internal signal) and format
    enriched.sort((a, b) => b.cohesion - a.cohesion);

    // R5: wrap the augment block in a clearly-labeled, delimited region and
    // sanitize every interpolated graph-derived name (symbol names, callers,
    // callees, file paths). Names come from an untrusted repository; without
    // this an adversarial name containing a newline could forge a new
    // top-level line — e.g. a fake `[GitNexus] …` header or instruction —
    // inside the hook's additional-context output. The fences let a downstream
    // agent tell tool-data from instructions.
    const lines: string[] = [
      CONTEXT_FENCE_START,
      `[GitNexus] ${enriched.length} related symbols found:`,
      '',
    ];

    for (const item of enriched) {
      lines.push(`${sanitizeName(item.name)} (${sanitizeName(item.filePath)})`);
      if (item.callers.length > 0) {
        lines.push(`  Called by: ${item.callers.map(sanitizeName).join(', ')}`);
      }
      if (item.callees.length > 0) {
        lines.push(`  Calls: ${item.callees.map(sanitizeName).join(', ')}`);
      }
      if (item.processes.length > 0) {
        // Process entries were already sanitized at collection time.
        lines.push(`  Flows: ${item.processes.join(', ')}`);
      }
      lines.push('');
    }

    lines.push(CONTEXT_FENCE_END);

    return lines.join('\n').trim();
  } catch {
    // Graceful failure — never break the original tool
    return '';
  }
}
