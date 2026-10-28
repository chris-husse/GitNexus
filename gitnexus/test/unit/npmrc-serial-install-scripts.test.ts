import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression guard: source-checkout `npm ci` on linux-arm64 compiles
// tree-sitter-typescript and its nested tree-sitter-javascript, whose
// node-gyp configures race on a shared node-addon-api makefile. Serial
// install scripts (see gitnexus/.npmrc) are what keep that build green.
describe('gitnexus/.npmrc', () => {
  it('runs dependency install scripts serially', () => {
    const npmrc = readFileSync(fileURLToPath(new URL('../../.npmrc', import.meta.url)), 'utf8');
    const settings = npmrc
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && !line.startsWith(';'));
    expect(settings).toContain('foreground-scripts=true');
  });
});
