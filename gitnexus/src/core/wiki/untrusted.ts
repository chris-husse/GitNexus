/**
 * Untrusted-content fencing for wiki LLM prompts (A1 — indirect prompt-injection
 * hardening, round 2).
 *
 * The wiki generator interpolates content from arbitrary third-party
 * repositories — source file bodies, symbol names, call-edge labels, process
 * labels — verbatim into LLM prompts. That content is attacker-controlled: a
 * source file (or a symbol literally named `</untrusted_file> SYSTEM: ...`)
 * could otherwise close the data region and pose its remainder as instructions
 * to the model.
 *
 * These helpers wrap untrusted regions in explicit, clearly-named
 * instruction-boundary tags and "defang" any occurrence of the matching closing
 * token inside the content so it cannot terminate the fence early. The system
 * prompts carry a fixed framing line stating that everything inside `untrusted_*`
 * tags is repository data to document, never instructions to follow.
 *
 * This mirrors the `UNTRUSTED_CLUSTER_DATA` fence in
 * `core/ingestion/cluster-enricher.ts`. It is defense-in-depth, not a guarantee
 * — see the design spec's honesty statement.
 */

/** Opening prefix / closing tag for a single fenced source file. */
export const UNTRUSTED_FILE_OPEN_PREFIX = '<untrusted_file path="';
export const UNTRUSTED_FILE_CLOSE = '</untrusted_file>';

/** Opening/closing tags for the reference-data (call edges / processes) region. */
export const UNTRUSTED_GRAPH_OPEN = '<untrusted_graph_data>';
export const UNTRUSTED_GRAPH_CLOSE = '</untrusted_graph_data>';

/**
 * Matches C0/C1 control characters plus the Unicode line/paragraph separators.
 * Built from an escaped string (rather than a literal regex with raw control
 * bytes) so the source stays ASCII-readable. Same character set as the round-1
 * `collapseToSingleLine` pass in `core/util/markdown-escape.ts`.
 */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029]+', 'g');

/**
 * Collapse control characters / line breaks and any whitespace run to a single
 * space, then trim.
 */
function collapseToSingleLine(value: string): string {
  return value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Escape a value for safe use inside an HTML/XML-ish double-quoted attribute.
 * Collapses control characters / line breaks first (the path must stay on the
 * tag's single line), then strips the structural characters (`<`, `>`, `"`, `&`)
 * that could otherwise close the attribute or the opening tag and inject sibling
 * markup.
 */
function escapeTagAttribute(value: string): string {
  return collapseToSingleLine(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Neutralize every occurrence of the closing `token` inside `content`
 * (case-insensitive, tolerant of whitespace before the `>`) by escaping the
 * `</` that starts the tag. The attacker's text survives as inert data; only the
 * tag that would break the fence is disarmed.
 *
 * `token` must be a closing tag of the form `</name>`; the matcher is derived
 * from its tag name so `</name >`, `</NAME>`, etc. are all caught.
 */
export function defangFenceToken(content: string, token: string): string {
  const tagName = token.replace(/^<\//, '').replace(/>$/, '').trim();
  if (!tagName) return content;
  // Match the closing tag for this name, case-insensitively, allowing optional
  // whitespace before the `>` (e.g. `</untrusted_file >`).
  const re = new RegExp('</\\s*' + tagName + '\\s*>', 'gi');
  // Replace the leading `</` with `<\/` — the backslash breaks the literal
  // closing tag (it is no longer a valid tag start) while leaving the text
  // readable as data.
  return content.replace(re, (m) => m.replace('</', '<\\/'));
}

/**
 * Fence a single untrusted source file. The path is attribute-escaped; any
 * closing `</untrusted_file>` token inside the content is defanged so the file
 * body cannot break out of its fence.
 */
export function fenceUntrustedFile(filePath: string, content: string): string {
  const safePath = escapeTagAttribute(filePath);
  const safeContent = defangFenceToken(content, UNTRUSTED_FILE_CLOSE);
  return `<untrusted_file path="${safePath}">\n${safeContent}\n${UNTRUSTED_FILE_CLOSE}`;
}

/**
 * Fence an untrusted reference-data block (formatted call edges / processes /
 * file lists). Any closing `</untrusted_graph_data>` token inside the content is
 * defanged.
 */
export function fenceUntrustedGraphData(content: string): string {
  const safeContent = defangFenceToken(content, UNTRUSTED_GRAPH_CLOSE);
  return `${UNTRUSTED_GRAPH_OPEN}\n${safeContent}\n${UNTRUSTED_GRAPH_CLOSE}`;
}
