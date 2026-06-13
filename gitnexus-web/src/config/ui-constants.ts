// Centralized UI and provider defaults to reduce magic numbers and duplicated URLs.
export const ERROR_RESET_DELAY_MS = 3000;
export const BACKEND_URL_DEBOUNCE_MS = 500;

const LOCALHOST_BACKEND_URL = 'http://localhost:4747';

/**
 * Resolve the deploy-time backend-URL override into a safe default (R8). The
 * `window.__GITNEXUS_CONFIG__.backendUrl` value is attacker-influenceable (it
 * is injected into the page and can be tampered with), so a `javascript:` /
 * `data:` / `file:` / blank / malformed value must fall back to the localhost
 * default rather than becoming the fetch-target base. Remote http(s) backends
 * are intentionally honored — this is a scheme/format check, not a localhost
 * allowlist. Kept self-contained (no import from backend-client) to avoid a
 * config↔service import cycle.
 */
export function resolveDefaultBackendUrl(
  configUrl: string | null | undefined,
  fallback: string = LOCALHOST_BACKEND_URL,
): string {
  if (typeof configUrl !== 'string') return fallback;
  let parsed: URL;
  try {
    parsed = new URL(configUrl);
  } catch {
    return fallback;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? configUrl : fallback;
}

export const DEFAULT_BACKEND_URL = resolveDefaultBackendUrl(
  typeof window !== 'undefined' ? window.__GITNEXUS_CONFIG__?.backendUrl : undefined,
  LOCALHOST_BACKEND_URL,
);
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Default node-count above which the WebUI connects in chat-only mode (skips
 * the full graph download). Grounded in sigma.js/graphology prior art: ~10K
 * nodes render smoothly, complex-styled rendering struggles past ~5K, and the
 * force-layout degrades beyond ~50K edges. GitNexus renders labeled nodes with
 * force layout and has ~1.7x more edges than nodes, so the edge cliff is crossed
 * around ~25-30K nodes. Override at deploy time via
 * window.__GITNEXUS_CONFIG__.largeGraphNodeThreshold. See issue #2178.
 */
const DEFAULT_LARGE_GRAPH_NODE_THRESHOLD = 25_000;

/**
 * Default edge-count above which the WebUI connects in chat-only mode. The
 * browser force-layout cliff is edge-driven (degrades beyond ~50K edges), and
 * GitNexus graphs carry more edges than nodes, so an edge-heavy but node-light
 * repo can still hang even when under the node threshold. Override via
 * window.__GITNEXUS_CONFIG__.largeGraphEdgeThreshold. See issue #2178.
 */
const DEFAULT_LARGE_GRAPH_EDGE_THRESHOLD = 50_000;

const resolveThreshold = (override: number | undefined, fallback: number): number =>
  // Ignore non-finite, NaN, or non-positive overrides — fall back to the default.
  typeof override === 'number' && Number.isFinite(override) && override > 0 ? override : fallback;

export const LARGE_GRAPH_NODE_THRESHOLD = resolveThreshold(
  typeof window !== 'undefined' ? window.__GITNEXUS_CONFIG__?.largeGraphNodeThreshold : undefined,
  DEFAULT_LARGE_GRAPH_NODE_THRESHOLD,
);

export const LARGE_GRAPH_EDGE_THRESHOLD = resolveThreshold(
  typeof window !== 'undefined' ? window.__GITNEXUS_CONFIG__?.largeGraphEdgeThreshold : undefined,
  DEFAULT_LARGE_GRAPH_EDGE_THRESHOLD,
);

/** Minimum Node.js version required by the gitnexus CLI (injected by Vite from package.json engines). */
declare const __REQUIRED_NODE_VERSION__: string;
export const REQUIRED_NODE_VERSION = __REQUIRED_NODE_VERSION__;
