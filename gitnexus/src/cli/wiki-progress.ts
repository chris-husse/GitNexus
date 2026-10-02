/**
 * Off-TTY progress reporting for `gitnexus wiki`.
 *
 * cli-progress renders nothing when stderr is not a TTY, so a piped parent
 * (omc's stall guard, CI logs) saw total silence for the whole run. When
 * piped, the wiki command reports one newline-terminated JSON line per
 * progress change on stderr instead. Consumers match on the prefix — pino's
 * own JSON records share the stream.
 */
import type { ProgressCallback } from '../core/wiki/generator.js';

export const PROGRESS_LINE_PREFIX = 'GITNEXUS_PROGRESS ';

/**
 * Build a ProgressCallback that writes `GITNEXUS_PROGRESS {…}` lines.
 * - one line per changed (percent, detail) pair; an unchanged pair is not repeated
 * - `stream` chunk events are skipped: they only move a token-count label, and
 *   the in-flight heartbeat already carries liveness during a call
 * - `write` receives the line WITHOUT a trailing newline
 */
export function makeProgressLineWriter(write: (line: string) => void): ProgressCallback {
  let last = '';
  return (phase, percent, detail) => {
    if (phase === 'stream') return;
    const label = detail ?? phase;
    const key = `${percent}\u0000${label}`;
    if (key === last) return;
    last = key;
    write(PROGRESS_LINE_PREFIX + JSON.stringify({ phase, percent, detail: label }));
  };
}
