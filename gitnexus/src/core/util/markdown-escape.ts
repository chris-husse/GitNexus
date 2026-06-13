/**
 * Markdown / YAML escaping helpers for generated agent-instruction files
 * (R4 — indirect prompt-injection hardening).
 *
 * GitNexus generates `SKILL.md`, `AGENTS.md`, and `CLAUDE.md` from graph-derived
 * strings (cluster labels, symbol names, file paths, process names) extracted
 * from arbitrary third-party repositories. Those strings are untrusted: a
 * symbol literally named `| --- | $(rm -rf)` or containing a newline, backtick,
 * or quote could otherwise inject Markdown table rows, list items, fresh
 * headings, or YAML frontmatter keys into the generated file an agent then
 * loads as instructions. These helpers neutralize the structural metacharacters
 * at each sink. This is defense-in-depth, not a guarantee — see the design
 * spec's honesty statement.
 *
 * All helpers first collapse control characters / line breaks to a single space
 * (a value must never span lines in a single-line Markdown/YAML construct), then
 * escape the metacharacters relevant to the specific sink.
 */

/**
 * Collapse C0/C1 control characters, the Unicode line/paragraph separators, and
 * any whitespace run to a single space, then trim. Shared first pass for every
 * sink — guarantees the value stays on one physical line.
 */
function collapseToSingleLine(value: string): string {
  return value

    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Escape a value for use inside a Markdown table cell as PLAIN text (not wrapped
 * in a code span). Pipes would start a new column; backticks could open a stray
 * code span; line breaks would end the row. Newlines are already collapsed.
 */
export function mdTableCell(value: string): string {
  return collapseToSingleLine(value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`');
}

/**
 * Escape a value for use inside a Markdown INLINE-CODE span (`` `value` ``).
 * A backtick in the value would close the span early and let the remainder
 * render as live Markdown; in a table cell a raw pipe still ends the column even
 * inside a code span, so escape it too. Newlines are collapsed.
 */
export function mdInlineCode(value: string): string {
  return collapseToSingleLine(value).replace(/`/g, "'").replace(/\|/g, '\\|');
}

/**
 * Escape a value interpolated into Markdown PROSE (a sentence or list item).
 * Strips the structural characters that could start a code span/fence (backtick),
 * open a template/JSX-ish brace group some renderers act on (`{`/`}`), or — most
 * importantly — inject a new list item / heading via a leading marker once the
 * value is on its own (it is kept single-line so it cannot reach line start).
 */
export function mdProse(value: string): string {
  return collapseToSingleLine(value).replace(/[`{}]/g, '');
}

/**
 * Produce a safe DOUBLE-QUOTED YAML scalar (including the surrounding quotes)
 * for a frontmatter value. A YAML 1.2 double-quoted scalar uses the same escape
 * grammar as a JSON string, so `JSON.stringify` yields a valid, fully-escaped
 * scalar: embedded quotes are `\"`, newlines `\n`, etc. This prevents a value
 * containing `"`, `:`, or a newline from terminating the scalar and injecting a
 * sibling frontmatter key. Newlines are collapsed first for readability.
 */
export function yamlQuotedScalar(value: string): string {
  return JSON.stringify(collapseToSingleLine(value));
}

/**
 * Escape a value embedded inside a double-quoted string that itself sits WITHIN
 * a Markdown inline-code span (e.g. `` `context({name: "<value>"})` ``). Two
 * layers must hold: (1) the value must not break the example's own string
 * literal — handled by JSON-string escaping of quotes/newlines; (2) the value
 * must not close the surrounding inline-code span — so backticks are removed
 * (there is no in-span escape for a backtick). The call-site template owns the
 * outer double-quotes, so they are stripped from the JSON result.
 */
export function codeExampleString(value: string): string {
  const json = JSON.stringify(collapseToSingleLine(value).replace(/`/g, "'"));
  // Strip the surrounding quotes JSON.stringify adds; the call-site template
  // owns the quotes (e.g. `"${codeExampleString(x)}"`).
  return json.slice(1, -1);
}
