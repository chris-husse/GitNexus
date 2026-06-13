import { describe, expect, it } from 'vitest';
import {
  validateBackendUrl,
  isValidBackendUrl,
  sanitizeBackendUrl,
  setBackendUrl,
  getBackendUrl,
} from './backend-client';

/**
 * R8 — backend URL validation.
 *
 * A persisted/localStorage or injected (`window.__GITNEXUS_CONFIG__.backendUrl`)
 * value must not be able to point API calls at a `javascript:`/`data:`/`file:`
 * origin. We accept ONLY well-formed http(s) URLs (remote backends are a
 * supported deployment — this is NOT a localhost allowlist) and fall back to the
 * caller's default on anything else.
 */

const DANGEROUS = [
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'file:///etc/passwd',
  '',
  '   ',
  'not a url',
  'ftp://example.com',
  'vbscript:msgbox(1)',
];

const VALID = [
  'http://localhost:4747',
  'https://gitnexus.example.com',
  'http://127.0.0.1:8080',
  'https://example.com:443/base',
];

describe('isValidBackendUrl (R8)', () => {
  for (const url of DANGEROUS) {
    it(`rejects dangerous/malformed value ${JSON.stringify(url)}`, () => {
      expect(isValidBackendUrl(url)).toBe(false);
    });
  }
  for (const url of VALID) {
    it(`accepts valid http(s) URL ${url}`, () => {
      expect(isValidBackendUrl(url)).toBe(true);
    });
  }
});

describe('validateBackendUrl (R8)', () => {
  it('throws on a javascript: URL', () => {
    expect(() => validateBackendUrl('javascript:alert(1)')).toThrow();
  });
  it('throws on a malformed URL', () => {
    expect(() => validateBackendUrl('not a url')).toThrow();
  });
  it('does not throw on a valid remote https URL', () => {
    expect(() => validateBackendUrl('https://gitnexus.example.com')).not.toThrow();
  });
  it('error message never echoes the raw scheme payload', () => {
    let msg = '';
    try {
      validateBackendUrl('javascript:alert(document.cookie)');
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).not.toContain('alert(document.cookie)');
  });
});

describe('sanitizeBackendUrl (R8)', () => {
  const fallback = 'http://localhost:4747';
  for (const url of DANGEROUS) {
    it(`falls back to default for ${JSON.stringify(url)}`, () => {
      expect(sanitizeBackendUrl(url, fallback)).toBe(fallback);
    });
  }
  it('passes through a valid remote https URL unchanged', () => {
    expect(sanitizeBackendUrl('https://gitnexus.example.com', fallback)).toBe(
      'https://gitnexus.example.com',
    );
  });
  it('passes through valid localhost unchanged', () => {
    expect(sanitizeBackendUrl('http://localhost:4747', fallback)).toBe('http://localhost:4747');
  });
});

describe('setBackendUrl (R8)', () => {
  it('accepts a valid remote https URL and stores it (trailing slash stripped)', () => {
    setBackendUrl('https://gitnexus.example.com/');
    expect(getBackendUrl()).toBe('https://gitnexus.example.com');
    // restore default for other suites
    setBackendUrl('http://localhost:4747');
  });
  it('rejects a javascript: URL without mutating the stored value', () => {
    setBackendUrl('http://localhost:4747');
    expect(() => setBackendUrl('javascript:alert(1)')).toThrow();
    expect(getBackendUrl()).toBe('http://localhost:4747');
  });
  it('rejects a malformed URL without mutating the stored value', () => {
    setBackendUrl('http://localhost:4747');
    expect(() => setBackendUrl('not a url')).toThrow();
    expect(getBackendUrl()).toBe('http://localhost:4747');
  });
});
