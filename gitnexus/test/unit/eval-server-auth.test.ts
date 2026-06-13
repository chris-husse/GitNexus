import { describe, it, expect, afterEach, vi } from 'vitest';
import http, { type IncomingMessage } from 'http';
import type { AddressInfo } from 'node:net';
import {
  isLoopbackHost,
  resolveEvalServerToken,
  isAuthorized,
  isProtectedRequest,
  createEvalRequestHandler,
  type EvalRequestBackend,
} from '../../src/cli/eval-server.js';

/**
 * R7 (security round 3): the eval-server defaults to 127.0.0.1 but had no auth on
 * /tool/* or /shutdown. When GITNEXUS_EVAL_SERVER_TOKEN is set, those endpoints
 * require a matching `Authorization: Bearer <token>`; /health stays open. When a
 * non-loopback host is bound without a token, the server must warn loudly.
 *
 * These tests exercise the extracted pure helpers so shutdown auth is verifiable
 * without binding a socket or calling process.exit.
 */
function fakeReq(opts: { method?: string; url?: string; auth?: string }): IncomingMessage {
  return {
    method: opts.method ?? 'POST',
    url: opts.url ?? '/shutdown',
    headers: opts.auth !== undefined ? { authorization: opts.auth } : {},
  } as unknown as IncomingMessage;
}

describe('isLoopbackHost (R7)', () => {
  it.each(['127.0.0.1', '::1', 'localhost', '127.5.5.5'])('treats %s as loopback', (h) => {
    expect(isLoopbackHost(h)).toBe(true);
  });
  it.each(['0.0.0.0', '192.168.1.5', '::', '10.0.0.1', 'example.com'])(
    'treats %s as non-loopback',
    (h) => {
      expect(isLoopbackHost(h)).toBe(false);
    },
  );
});

describe('resolveEvalServerToken (R7)', () => {
  const orig = process.env.GITNEXUS_EVAL_SERVER_TOKEN;
  afterEach(() => {
    if (orig === undefined) delete process.env.GITNEXUS_EVAL_SERVER_TOKEN;
    else process.env.GITNEXUS_EVAL_SERVER_TOKEN = orig;
  });

  it('returns undefined when env is unset', () => {
    delete process.env.GITNEXUS_EVAL_SERVER_TOKEN;
    expect(resolveEvalServerToken()).toBeUndefined();
  });
  it('returns undefined for an empty / whitespace token', () => {
    process.env.GITNEXUS_EVAL_SERVER_TOKEN = '   ';
    expect(resolveEvalServerToken()).toBeUndefined();
  });
  it('returns the trimmed token when set', () => {
    process.env.GITNEXUS_EVAL_SERVER_TOKEN = 's3cret';
    expect(resolveEvalServerToken()).toBe('s3cret');
  });
});

describe('isProtectedRequest (R7)', () => {
  it('protects /shutdown and /tool/*', () => {
    expect(isProtectedRequest(fakeReq({ url: '/shutdown' }))).toBe(true);
    expect(isProtectedRequest(fakeReq({ url: '/tool/query' }))).toBe(true);
  });
  it('does NOT protect /health', () => {
    expect(isProtectedRequest(fakeReq({ method: 'GET', url: '/health' }))).toBe(false);
  });
});

describe('isAuthorized (R7)', () => {
  it('allows any request when no token is configured (loopback dev flow unchanged)', () => {
    expect(isAuthorized(fakeReq({ url: '/shutdown' }), undefined)).toBe(true);
    expect(isAuthorized(fakeReq({ url: '/tool/query' }), undefined)).toBe(true);
  });

  it('rejects a protected request with no/incorrect bearer token', () => {
    expect(isAuthorized(fakeReq({ url: '/shutdown' }), 'good')).toBe(false);
    expect(isAuthorized(fakeReq({ url: '/shutdown', auth: 'Bearer bad' }), 'good')).toBe(false);
    expect(isAuthorized(fakeReq({ url: '/tool/query', auth: 'good' }), 'good')).toBe(false); // missing scheme
    expect(isAuthorized(fakeReq({ url: '/tool/query', auth: 'Bearer ' }), 'good')).toBe(false);
  });

  it('accepts a protected request with the correct bearer token', () => {
    expect(isAuthorized(fakeReq({ url: '/shutdown', auth: 'Bearer good' }), 'good')).toBe(true);
    expect(isAuthorized(fakeReq({ url: '/tool/query', auth: 'Bearer good' }), 'good')).toBe(true);
  });

  it('matches the Bearer scheme case-insensitively', () => {
    expect(isAuthorized(fakeReq({ url: '/shutdown', auth: 'bearer good' }), 'good')).toBe(true);
  });

  it('leaves /health open even when a token is configured', () => {
    expect(isAuthorized(fakeReq({ method: 'GET', url: '/health' }), 'good')).toBe(true);
  });
});

/**
 * End-to-end wiring over a real socket: proves the auth gate guards /tool/* and
 * /shutdown before any side effect. onShutdown is injected (no process.exit) so
 * shutdown auth is observable — a 401 means onShutdown is never invoked.
 */
describe('createEvalRequestHandler — auth wiring over a socket (R7)', () => {
  function startServer(authToken: string | undefined) {
    const callTool = vi.fn(async () => ({ ok: true }));
    const onShutdown = vi.fn();
    const backend: EvalRequestBackend = {
      callTool,
      disconnect: vi.fn(async () => undefined),
    };
    const handler = createEvalRequestHandler({
      backend,
      repoNames: ['repo-a'],
      authToken,
      onShutdown,
    });
    const server = http.createServer(handler);
    return new Promise<{
      base: string;
      callTool: typeof callTool;
      onShutdown: typeof onShutdown;
      close: () => Promise<void>;
    }>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          base: `http://127.0.0.1:${port}`,
          callTool,
          onShutdown,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
    });
  }

  it('with a token set: unauthenticated /shutdown and /tool/* are 401 (no side effects)', async () => {
    const s = await startServer('s3cret');
    try {
      const shutdownRes = await fetch(`${s.base}/shutdown`, { method: 'POST' });
      expect(shutdownRes.status).toBe(401);
      expect(s.onShutdown).not.toHaveBeenCalled();

      const toolRes = await fetch(`${s.base}/tool/query`, {
        method: 'POST',
        body: JSON.stringify({ q: 'x' }),
      });
      expect(toolRes.status).toBe(401);
      expect(s.callTool).not.toHaveBeenCalled();

      // /health stays open without a token.
      const healthRes = await fetch(`${s.base}/health`);
      expect(healthRes.status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('with a token set: the correct bearer token succeeds', async () => {
    const s = await startServer('s3cret');
    try {
      const toolRes = await fetch(`${s.base}/tool/query`, {
        method: 'POST',
        headers: { Authorization: 'Bearer s3cret' },
        body: JSON.stringify({ q: 'x' }),
      });
      expect(toolRes.status).toBe(200);
      expect(s.callTool).toHaveBeenCalledWith('query', { q: 'x' });

      const shutdownRes = await fetch(`${s.base}/shutdown`, {
        method: 'POST',
        headers: { Authorization: 'Bearer s3cret' },
      });
      expect(shutdownRes.status).toBe(200);
      expect(s.onShutdown).toHaveBeenCalledTimes(1);
    } finally {
      await s.close();
    }
  });

  it('with no token: loopback behavior is unchanged (tool + shutdown reachable)', async () => {
    const s = await startServer(undefined);
    try {
      const toolRes = await fetch(`${s.base}/tool/query`, {
        method: 'POST',
        body: JSON.stringify({ q: 'x' }),
      });
      expect(toolRes.status).toBe(200);
      expect(s.callTool).toHaveBeenCalledTimes(1);

      const shutdownRes = await fetch(`${s.base}/shutdown`, { method: 'POST' });
      expect(shutdownRes.status).toBe(200);
      expect(s.onShutdown).toHaveBeenCalledTimes(1);
    } finally {
      await s.close();
    }
  });
});
