import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * B2 — Cypher parameterization in ProcessesPanel.
 *
 * The combined-edges and per-process-edges queries must bind step/process ids
 * as a `$ids` (and `$pid`) param array rather than interpolating them into the
 * Cypher string. We mock useAppState to inject a spy `runQuery` and assert on
 * the (cypher, params) pairs it receives.
 */

// Spy that every render of ProcessesPanel will call.
const runQuery = vi.fn<(cypher: string, params?: Record<string, unknown>) => Promise<any[]>>();
const setHighlightedNodeIds = vi.fn();

const processNode = (id: string, processType: string) => ({
  id,
  label: 'Process',
  properties: {
    name: id,
    heuristicLabel: id,
    stepCount: 2,
    communities: [],
    processType,
  },
});

let mockGraph: { nodes: any[]; relationships: any[] } | null = null;

vi.mock('../hooks/useAppState', () => ({
  useAppState: () => ({
    graph: mockGraph,
    runQuery,
    setHighlightedNodeIds,
    highlightedNodeIds: new Set<string>(),
  }),
}));

// ProcessFlowModal pulls in mermaid; stub it so the panel renders in jsdom.
vi.mock('./ProcessFlowModal', () => ({
  ProcessFlowModal: () => null,
}));

import { ProcessesPanel } from './ProcessesPanel';

describe('ProcessesPanel Cypher parameterization (B2)', () => {
  beforeEach(() => {
    runQuery.mockReset();
    setHighlightedNodeIds.mockReset();
    mockGraph = {
      nodes: [processNode('proc-1', 'cross_community'), processNode('proc-2', 'intra_community')],
      relationships: [],
    };
  });

  it('binds step ids as a $ids param for the per-process edges query (no interpolation)', async () => {
    // First runQuery call = steps query; second = edges query.
    runQuery.mockResolvedValueOnce([
      { id: 'step-a', name: 'A', filePath: 'a.ts', stepNumber: 1 },
      { id: 'step-b', name: 'B', filePath: 'b.ts', stepNumber: 2 },
    ]);
    runQuery.mockResolvedValueOnce([{ fromId: 'step-a', toId: 'step-b', type: 'CALLS' }]);

    render(<ProcessesPanel />);

    // Open the first process (cross-community section is expanded by default).
    const viewButtons = await screen.findAllByTestId('process-view-button');
    fireEvent.click(viewButtons[0]);

    await waitFor(() => expect(runQuery).toHaveBeenCalledTimes(2));

    const [edgesCypher, edgesParams] = runQuery.mock.calls[1];
    // Parameterized: placeholders present, no inline id list.
    expect(edgesCypher).toContain('from.id IN $ids');
    expect(edgesCypher).toContain('to.id IN $ids');
    expect(edgesCypher).not.toContain("'step-a'");
    expect(edgesCypher).not.toContain('step-a');
    expect(edgesCypher).not.toMatch(/IN \[/);
    // ids bound as a param array.
    expect(edgesParams).toEqual({ ids: ['step-a', 'step-b'] });
  });

  it('binds the process id as a $pid param for the steps query (no interpolation)', async () => {
    runQuery.mockResolvedValueOnce([]); // steps query returns nothing → no edges query

    render(<ProcessesPanel />);

    const viewButtons = await screen.findAllByTestId('process-view-button');
    fireEvent.click(viewButtons[0]);

    await waitFor(() => expect(runQuery).toHaveBeenCalledTimes(1));

    const [stepsCypher, stepsParams] = runQuery.mock.calls[0];
    expect(stepsCypher).toContain('p:Process {id: $pid}');
    expect(stepsCypher).not.toContain("'proc-1'");
    expect(stepsParams).toEqual({ pid: 'proc-1' });
  });

  it('binds process ids as $ids for the combined "view all" steps query', async () => {
    // "View All" first queries all steps, then (if any) edges.
    runQuery.mockResolvedValueOnce([{ id: 'step-a', name: 'A', filePath: 'a.ts', stepNumber: 1 }]);
    runQuery.mockResolvedValueOnce([]); // edges

    render(<ProcessesPanel />);

    // The "View All Processes" card is the first button rendered (the header
    // above it is a text input, not a button). Selecting by position avoids
    // depending on i18n string resolution timing in jsdom.
    const buttons = await screen.findAllByRole('button');
    fireEvent.click(buttons[0]);

    await waitFor(() => expect(runQuery).toHaveBeenCalled());

    const [allStepsCypher, allStepsParams] = runQuery.mock.calls[0];
    expect(allStepsCypher).toContain('p.id IN $ids');
    expect(allStepsCypher).not.toMatch(/IN \[/);
    expect(allStepsParams).toEqual({ ids: ['proc-1', 'proc-2'] });
  });

  it('binds step ids as $ids for the focus-highlight steps query', async () => {
    runQuery.mockResolvedValueOnce([{ id: 'step-x' }, { id: 'step-y' }]);

    render(<ProcessesPanel />);

    const focusButtons = await screen.findAllByTestId('process-highlight-button');
    fireEvent.click(focusButtons[0]);

    await waitFor(() => expect(runQuery).toHaveBeenCalledTimes(1));
    const [focusCypher, focusParams] = runQuery.mock.calls[0];
    expect(focusCypher).toContain('p:Process {id: $pid}');
    expect(focusCypher).not.toContain("'proc-1'");
    expect(focusParams).toEqual({ pid: 'proc-1' });
  });
});
