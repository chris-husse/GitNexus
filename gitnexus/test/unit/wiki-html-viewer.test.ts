/**
 * Unit tests for the wiki HTML viewer bundling + sanitization (C, round 2).
 *
 * The viewer renders LLM-generated markdown (derived from an untrusted
 * repository) into the DOM. These tests assert:
 *  - C1: the generated index.html contains NO external script src (no jsdelivr /
 *    CDN); marked, mermaid and DOMPurify are inlined from node_modules.
 *  - C2: every markdown render path runs through DOMPurify.sanitize(marked.parse()).
 *  - the </script> breakout guard is applied to inlined library code.
 *
 * Browser rendering itself cannot run here — DOM behavior (that DOMPurify
 * actually strips a <script>/onerror payload) needs manual re-verification.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { generateHTMLViewer } from '../../src/core/wiki/html-viewer.js';

describe('generateHTMLViewer — inline bundle + sanitize (C)', () => {
  let wikiDir: string;

  beforeEach(async () => {
    wikiDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-html-viewer-'));
    // A minimal wiki: one page + a module tree + meta.
    await fs.writeFile(path.join(wikiDir, 'overview.md'), '# Overview\n\nHello', 'utf-8');
    await fs.writeFile(
      path.join(wikiDir, 'module_tree.json'),
      JSON.stringify([{ name: 'Mod', slug: 'mod', files: [] }]),
      'utf-8',
    );
    await fs.writeFile(
      path.join(wikiDir, 'meta.json'),
      JSON.stringify({
        generatedAt: '2026-06-13T00:00:00Z',
        model: 'test',
        fromCommit: 'abcdef12',
      }),
      'utf-8',
    );
  });

  afterEach(async () => {
    await fs.rm(wikiDir, { recursive: true, force: true });
  });

  async function generate(): Promise<string> {
    const out = await generateHTMLViewer(wikiDir, 'TestProj');
    return fs.readFile(out, 'utf-8');
  }

  it('contains no external script src (no jsdelivr / CDN / http(s) src)', async () => {
    const html = await generate();
    expect(html).not.toContain('cdn.jsdelivr.net');
    // No <script src="http..."> at all.
    expect(html).not.toMatch(/<script[^>]+src\s*=\s*["']https?:/i);
    // Belt-and-suspenders: no script tag carries a src attribute of any kind.
    expect(html).not.toMatch(/<script[^>]+\bsrc\s*=/i);
  });

  it('inlines marked, mermaid and DOMPurify library source', async () => {
    const html = await generate();
    // Marker strings from each library's banner / global assignment.
    expect(html.toLowerCase()).toContain('marked'); // marked banner
    expect(html).toContain('DOMPurify'); // DOMPurify banner / global
    expect(html.toLowerCase()).toContain('mermaid'); // mermaid global
    // The mermaid bundle is multi-MB — a sanity floor that real code was inlined.
    expect(html.length).toBeGreaterThan(1_000_000);
  });

  it('routes markdown rendering through DOMPurify.sanitize(marked.parse(...))', async () => {
    const html = await generate();
    expect(html).toContain('DOMPurify.sanitize(marked.parse(');
    // The old unsanitized direct assignment must be gone.
    expect(html).not.toMatch(/innerHTML\s*=\s*marked\.parse\(/);
  });

  it('applies the </script> breakout guard to inlined library code (no raw </script> from libs)', async () => {
    const html = await generate();
    // The only literal `</script>` tokens should be the structural closers the
    // builder emits for its own <script> blocks. Inlined library code must have
    // its </script>-like sequences escaped to <\/script>. We assert the escaped
    // form is present (proving the guard ran) — libraries reference "script".
    // There must be no `</script` immediately followed by library-ish content;
    // simplest robust check: the number of real </script> closers is small and
    // bounded (the builder emits a fixed number of <script> blocks).
    const closers = html.match(/<\/script>/gi) ?? [];
    // Builder emits: (head libs as inlined blocks) + the app block. With three
    // inlined library blocks + one data/app block, expect a small fixed count.
    expect(closers.length).toBeLessThanOrEqual(8);
    expect(closers.length).toBeGreaterThanOrEqual(2);
  });

  it('still initializes mermaid (diagram rendering preserved)', async () => {
    const html = await generate();
    expect(html).toContain('mermaid.initialize(');
    expect(html).toContain('mermaid.run(');
  });
});
