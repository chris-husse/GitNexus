/**
 * Unit tests for the Markdown/YAML escaping helpers (R4).
 *
 * These guard the structural-injection properties each helper must hold for
 * graph-derived (untrusted) strings flowing into generated SKILL.md / AGENTS.md.
 */
import { describe, it, expect } from 'vitest';
import {
  mdTableCell,
  mdInlineCode,
  mdProse,
  yamlQuotedScalar,
  codeExampleString,
} from '../../src/core/util/markdown-escape.js';

describe('mdTableCell', () => {
  it('escapes pipes so a value cannot inject a new column', () => {
    expect(mdTableCell('a | b')).not.toMatch(/[^\\]\|/);
    expect(mdTableCell('a | b')).toBe('a \\| b');
  });

  it('collapses newlines so a value cannot end the table row', () => {
    const out = mdTableCell('row1\nrow2\n| evil | row |');
    expect(out).not.toContain('\n');
    // The pipe from the injected row is escaped.
    expect(out).not.toMatch(/[^\\]\|/);
  });

  it('escapes backticks so a value cannot open a stray code span', () => {
    expect(mdTableCell('`code`')).toBe('\\`code\\`');
  });
});

describe('mdInlineCode', () => {
  it('removes backticks so the value cannot close the code span early', () => {
    expect(mdInlineCode('a`b`c')).not.toContain('`');
  });

  it('escapes pipes (cells still split on pipe inside code spans)', () => {
    expect(mdInlineCode('a|b')).toBe('a\\|b');
  });

  it('collapses newlines to keep the span on one line', () => {
    expect(mdInlineCode('a\nb')).toBe('a b');
  });
});

describe('mdProse', () => {
  it('strips backticks and braces', () => {
    expect(mdProse('`x` {y}')).toBe('x y');
  });

  it('collapses newlines so it cannot inject a new list item or heading', () => {
    const out = mdProse('intro\n- injected item\n# Injected Heading');
    expect(out).not.toContain('\n');
  });
});

describe('yamlQuotedScalar', () => {
  it('produces a quoted scalar that escapes embedded double-quotes', () => {
    expect(yamlQuotedScalar('a"b')).toBe('"a\\"b"');
  });

  it('a value with a newline + key cannot inject a sibling frontmatter key', () => {
    const out = yamlQuotedScalar('x"\ninjected: pwned');
    // Single physical token, fully quoted; no real newline escapes the scalar.
    expect(out.startsWith('"')).toBe(true);
    expect(out.endsWith('"')).toBe(true);
    expect(out).not.toContain('\n');
    // The would-be key name is inside the quoted scalar, not a YAML key.
    expect(out).toContain('injected: pwned');
  });

  it('a value with a colon stays inside the scalar', () => {
    expect(yamlQuotedScalar('name: value')).toBe('"name: value"');
  });
});

describe('codeExampleString', () => {
  it('escapes embedded quotes without adding outer quotes', () => {
    expect(codeExampleString('a"b')).toBe('a\\"b');
  });

  it('collapses newlines', () => {
    expect(codeExampleString('a\nb')).toBe('a b');
  });
});
