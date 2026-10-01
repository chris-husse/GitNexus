/**
 * In-flight heartbeat: while an LLM call is in flight the generator reports
 * onProgress('heartbeat', …) every 30s, so a piped parent (omc's stall guard)
 * sees output during long calls. Scoped to LLM calls on purpose — outside one,
 * silence means a wedge the parent should catch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

const SLOW_LLM_MS = 6 * 60_000;

type Event = { phase: string; percent: number; detail?: string };

describe('WikiGenerator heartbeat', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-heartbeat-test-'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function makeGenerator() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    vi.doMock('../../src/core/wiki/graph-queries.js', () => ({
      initWikiDb: vi.fn().mockResolvedValue(undefined),
      closeWikiDb: vi.fn().mockResolvedValue(undefined),
      touchWikiDb: vi.fn(),
      getFilesWithExports: vi
        .fn()
        .mockResolvedValue([{ filePath: 'src/a.ts', symbols: [{ name: 'a', type: 'function' }] }]),
      getAllFiles: vi.fn().mockResolvedValue(['src/a.ts']),
      getIntraModuleCallEdges: vi.fn().mockResolvedValue([]),
      getInterModuleCallEdges: vi.fn().mockResolvedValue({ incoming: [], outgoing: [] }),
      getProcessesForFiles: vi.fn().mockResolvedValue([]),
      getAllProcesses: vi.fn().mockResolvedValue([]),
      getInterModuleEdgesForOverview: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('child_process', () => ({
      execSync: vi.fn().mockImplementation(() => {
        throw new Error('not a git repo');
      }),
      execFileSync: vi.fn(),
    }));

    const llmClient = await import('../../src/core/wiki/llm-client.js');
    // Buffered provider simulation: nothing streams; the answer lands after 6 min.
    const callLLMSpy = vi.spyOn(llmClient, 'callLLM').mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ content: JSON.stringify({ All: ['src/a.ts'] }) }), SLOW_LLM_MS),
        ),
    );

    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');
    const storagePath = path.join(tmpDir, 'storage');
    await fs.mkdir(path.join(storagePath, 'wiki'), { recursive: true });
    const repoPath = path.join(tmpDir, 'repo');
    await fs.mkdir(repoPath, { recursive: true });
    const events: Event[] = [];
    const gen = new WikiGenerator(
      repoPath,
      storagePath,
      path.join(storagePath, 'lbug'),
      {
        apiKey: 'key',
        baseUrl: 'http://localhost',
        model: 'test',
        maxTokens: 1000,
        temperature: 0,
        provider: 'openai',
      },
      { reviewOnly: true },
      (phase, percent, detail) => events.push({ phase, percent, detail }),
    );
    return { gen, events, callLLMSpy };
  }

  it('reports a heartbeat every 30s while an LLM call is in flight, and not after', async () => {
    const { gen, events, callLLMSpy } = await makeGenerator();
    const run = gen.run();
    // Wait until the mocked call is actually in flight before touching the fake clock
    // (run() does real async fs I/O first; see wiki-keepalive.test.ts).
    while (callLLMSpy.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }
    await run;

    const beats = events.filter((e) => e.phase === 'heartbeat');
    expect(beats.length).toBeGreaterThanOrEqual(10); // 6 min / 30 s = 12, allow edge ticks
    expect(beats[0].detail).toBe('Grouping files into modules (LLM)... (30s)');
    expect(beats[1].detail).toBe('Grouping files into modules (LLM)... (60s)');
    // grouping is reported at 15 before the call and nothing else moves it during the call
    expect(beats.every((e) => e.percent === 15)).toBe(true);

    // After run() settles the interval is cleared — no further heartbeats
    const settled = beats.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(events.filter((e) => e.phase === 'heartbeat').length).toBe(settled);
  }, 60000);

  it('emits no heartbeat before the first LLM call', async () => {
    const { gen, events, callLLMSpy } = await makeGenerator();
    const run = gen.run();
    while (callLLMSpy.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    // Nothing has ticked yet: the interval starts with the call, not with run()
    expect(events.filter((e) => e.phase === 'heartbeat')).toEqual([]);
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }
    await run;
  }, 60000);
});
