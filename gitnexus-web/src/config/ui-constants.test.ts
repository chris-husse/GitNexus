import { describe, expect, it } from 'vitest';
import { resolveDefaultBackendUrl } from './ui-constants';

/**
 * R8 — the deploy-time `window.__GITNEXUS_CONFIG__.backendUrl` override must be
 * validated before it becomes DEFAULT_BACKEND_URL: an injected `javascript:` /
 * `data:` / malformed value must fall back to the localhost default, while a
 * valid remote http(s) backend is honored.
 */
describe('resolveDefaultBackendUrl (R8)', () => {
  const FALLBACK = 'http://localhost:4747';

  it('falls back when the config value is absent', () => {
    expect(resolveDefaultBackendUrl(undefined, FALLBACK)).toBe(FALLBACK);
  });

  it('falls back on a javascript: config value', () => {
    expect(resolveDefaultBackendUrl('javascript:alert(1)', FALLBACK)).toBe(FALLBACK);
  });

  it('falls back on a data: config value', () => {
    expect(resolveDefaultBackendUrl('data:text/html,x', FALLBACK)).toBe(FALLBACK);
  });

  it('falls back on a malformed config value', () => {
    expect(resolveDefaultBackendUrl('://nope', FALLBACK)).toBe(FALLBACK);
  });

  it('honors a valid remote https backend', () => {
    expect(resolveDefaultBackendUrl('https://gitnexus.example.com', FALLBACK)).toBe(
      'https://gitnexus.example.com',
    );
  });

  it('honors a valid localhost http backend', () => {
    expect(resolveDefaultBackendUrl('http://localhost:9999', FALLBACK)).toBe(
      'http://localhost:9999',
    );
  });
});
