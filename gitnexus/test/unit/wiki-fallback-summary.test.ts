import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('wiki fallback summary', () => {
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    vi.resetModules();
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../../src/storage/git.js');
    vi.doUnmock('../../src/storage/repo-manager.js');
    vi.doUnmock('../../src/storage/storage-resolver.js');
    vi.doUnmock('../../src/core/wiki/llm-client.js');
    vi.doUnmock('../../src/core/wiki/generator.js');
    vi.doUnmock('cli-progress');
    process.exitCode = originalExitCode;
  });

  async function run(review: boolean) {
    const firstResult = {
      mode: 'full',
      pagesGenerated: 0,
      failedModules: [],
      groupingFallback: 'completion exhausted',
      moduleTree: review ? [{ name: 'alpha', slug: 'alpha', files: ['alpha/a.ts'] }] : undefined,
    };
    const nextResult = { mode: 'full', pagesGenerated: 2, failedModules: [] };
    const results = [firstResult, nextResult];
    vi.doMock('../../src/storage/git.js', () => ({
      getGitRoot: vi.fn(),
      isGitRepo: vi.fn().mockReturnValue(true),
    }));
    vi.doMock('../../src/storage/storage-resolver.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/storage/storage-resolver.js')>()),
      requireStoragePath: vi.fn().mockResolvedValue('/tmp/wiki-storage'),
    }));
    vi.doMock('../../src/storage/repo-manager.js', () => ({
      getStoragePaths: vi
        .fn()
        .mockReturnValue({ storagePath: '/tmp/wiki-storage', lbugPath: '/tmp/wiki-db' }),
      loadCLIConfig: vi.fn().mockResolvedValue({
        provider: 'openai',
        apiKey: 'key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'test',
      }),
      saveCLIConfig: vi.fn(),
    }));
    vi.doMock('../../src/core/wiki/llm-client.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/wiki/llm-client.js')>()),
      resolveLLMConfig: vi.fn().mockResolvedValue({
        provider: 'openai',
        apiKey: 'key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'test',
        maxTokens: 1000,
      }),
    }));
    vi.doMock('../../src/core/wiki/generator.js', () => ({
      WikiGenerator: vi.fn().mockImplementation(function () {
        return { run: vi.fn().mockResolvedValue(results.shift()) };
      }),
    }));
    vi.doMock('cli-progress', () => ({
      default: {
        SingleBar: vi.fn(function () {
          return { start: vi.fn(), update: vi.fn(), stop: vi.fn() };
        }),
        Presets: { shades_grey: {} },
      },
    }));
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { wikiCommand } = await import('../../src/cli/wiki.js');
    await wikiCommand('/tmp/repo', { review });
    return logs.mock.calls.map((call) => call.join(' ')).join('\n');
  }

  it('prints the fallback reason in the normal summary', async () => {
    expect(await run(false)).toContain('Grouping fallback: completion exhausted');
  });

  it('retains the first run fallback reason in the review continuation summary', async () => {
    expect(await run(true)).toContain('Grouping fallback: completion exhausted');
  });
});
