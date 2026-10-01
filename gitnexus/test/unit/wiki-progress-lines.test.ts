/**
 * Off-TTY progress lines: when stderr is piped, cli-progress renders nothing,
 * so the wiki command reports one GITNEXUS_PROGRESS JSON line per change
 * instead. Consumers (omc) match on the prefix.
 */
import { describe, it, expect } from 'vitest';
import { makeProgressLineWriter, PROGRESS_LINE_PREFIX } from '../../src/cli/wiki-progress.js';

function collect() {
  const lines: string[] = [];
  const report = makeProgressLineWriter((line) => lines.push(line));
  return { lines, report };
}

describe('makeProgressLineWriter', () => {
  it('writes one prefixed JSON line per changed (percent, detail) pair', () => {
    const { lines, report } = collect();
    report('grouping', 15, 'Grouping files into modules (LLM)...');
    report('grouping', 17, 'Grouping batch 1/3 (LLM)...');
    expect(lines).toEqual([
      `${PROGRESS_LINE_PREFIX}{"phase":"grouping","percent":15,"detail":"Grouping files into modules (LLM)..."}`,
      `${PROGRESS_LINE_PREFIX}{"phase":"grouping","percent":17,"detail":"Grouping batch 1/3 (LLM)..."}`,
    ]);
    expect(PROGRESS_LINE_PREFIX).toBe('GITNEXUS_PROGRESS ');
  });

  it('does not repeat an unchanged pair', () => {
    const { lines, report } = collect();
    report('modules', 40, 'auth');
    report('modules', 40, 'auth');
    expect(lines).toHaveLength(1);
  });

  it('skips stream chunk events entirely', () => {
    const { lines, report } = collect();
    report('grouping', 15, 'Grouping files into modules (LLM)...');
    report('stream', 16, 'Grouping files into modules (LLM)... (120 tok)');
    report('stream', 18, 'Grouping files into modules (LLM)... (900 tok)');
    expect(lines).toHaveLength(1);
  });

  it('writes every heartbeat tick because its detail changes', () => {
    const { lines, report } = collect();
    report('grouping', 15, 'Grouping files into modules (LLM)...');
    report('heartbeat', 15, 'Grouping files into modules (LLM)... (30s)');
    report('heartbeat', 15, 'Grouping files into modules (LLM)... (60s)');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2].slice(PROGRESS_LINE_PREFIX.length))).toEqual({
      phase: 'heartbeat',
      percent: 15,
      detail: 'Grouping files into modules (LLM)... (60s)',
    });
  });

  it('falls back to the phase name when detail is absent', () => {
    const { lines, report } = collect();
    report('done', 100);
    expect(lines).toEqual([
      `${PROGRESS_LINE_PREFIX}{"phase":"done","percent":100,"detail":"done"}`,
    ]);
  });

  it('never embeds a newline (one line per event, the caller terminates it)', () => {
    const { lines, report } = collect();
    report('modules', 50, 'line\nbreak');
    expect(lines[0].includes('\n')).toBe(false); // JSON.stringify escapes it
  });
});
