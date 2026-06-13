/**
 * Tests for gitnexus-hook.js — GITNEXUS_HOOK_CLI_PATH override hardening (R12).
 *
 * Runner: Node's built-in `node:test` (the plugin ships no test framework and
 * the hooks run under a bare `node`, so we stay zero-dependency). Run with:
 *   node --test gitnexus-claude-plugin/hooks/gitnexus-hook.test.js
 *
 * These tests pin the defense-in-depth contract for the operator-only
 * GITNEXUS_HOOK_CLI_PATH override: an absolute, normalized path that exists is
 * still executed (behavior unchanged), while a relative path or one containing
 * `..` traversal is ignored — control falls through to PATH/`which`/npx
 * resolution and the override script is NEVER spawned.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isTrustedHookCliPath, runGitNexusCli } = require('./gitnexus-hook.js');

// A sentinel-printing Node script we point GITNEXUS_HOOK_CLI_PATH at. If the
// override is honored, runGitNexusCli runs `process.execPath <script> ...args`
// and this string lands in stdout; if the override is ignored, it never runs.
const SENTINEL = 'GITNEXUS_HOOK_CLI_SENTINEL_OK';
const SCRIPT_BODY = `process.stdout.write(${JSON.stringify(SENTINEL)});\n`;

/**
 * Run `fn` with `process.env` patched by `patch` (keys set to `undefined` are
 * deleted), restoring the original environment afterwards.
 */
function withEnv(patch, fn) {
  const saved = {};
  for (const key of Object.keys(patch)) {
    saved[key] = process.env[key];
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(patch)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('isTrustedHookCliPath accepts an absolute, normalized path', () => {
  const abs = path.join(os.tmpdir(), 'gitnexus-cli-stub.js');
  assert.strictEqual(isTrustedHookCliPath(abs), true);
});

test('isTrustedHookCliPath rejects relative paths', () => {
  assert.strictEqual(isTrustedHookCliPath('relative/cli.js'), false);
  assert.strictEqual(isTrustedHookCliPath('./cli.js'), false);
  assert.strictEqual(isTrustedHookCliPath('cli.js'), false);
});

test('isTrustedHookCliPath rejects paths containing .. traversal', () => {
  // Absolute but not normalized: path.normalize would collapse the `..`.
  assert.strictEqual(isTrustedHookCliPath('/opt/gitnexus/../cli.js'), false);
  // Relative traversal is rejected on both counts.
  assert.strictEqual(isTrustedHookCliPath('../cli.js'), false);
});

test('isTrustedHookCliPath rejects empty / blank / nullish values', () => {
  assert.strictEqual(isTrustedHookCliPath(undefined), false);
  assert.strictEqual(isTrustedHookCliPath(null), false);
  assert.strictEqual(isTrustedHookCliPath(''), false);
  assert.strictEqual(isTrustedHookCliPath('   '), false);
});

test('runGitNexusCli executes a valid absolute, normalized GITNEXUS_HOOK_CLI_PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-hook-valid-'));
  const script = path.join(dir, 'cli-stub.js');
  fs.writeFileSync(script, SCRIPT_BODY);
  try {
    assert.strictEqual(isTrustedHookCliPath(script), true, 'precondition: script path is trusted');
    const child = withEnv(
      {
        GITNEXUS_HOOK_CLI_PATH: script,
        // Disable the coreutils timeout guard so the direct-exec arm runs
        // `process.execPath <script>` deterministically regardless of host
        // coreutils — the guard, when present, still runs the same script, so
        // this only removes host variance from the assertion.
        GITNEXUS_HOOK_TIMEOUT_PATH: 'disabled',
      },
      () => runGitNexusCli(['augment', '--', 'needle'], dir, 7000),
    );
    assert.strictEqual(
      child.error,
      undefined,
      `spawn error: ${child.error && child.error.message}`,
    );
    assert.strictEqual(child.status, 0);
    assert.match(child.stdout || '', new RegExp(SENTINEL), 'override script should have executed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runGitNexusCli ignores a relative GITNEXUS_HOOK_CLI_PATH (override not executed)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-hook-rel-'));
  const script = path.join(dir, 'cli-stub.js');
  fs.writeFileSync(script, SCRIPT_BODY);
  try {
    // A relative path whose target genuinely exists relative to cwd=dir: the
    // file IS resolvable+real, so only the absolute/normalized guard (not the
    // existence check) can reject it.
    const child = withEnv(
      {
        GITNEXUS_HOOK_CLI_PATH: 'cli-stub.js',
        // Strip PATH so the fall-through which/where + npx both ENOENT fast and
        // offline — we never want the npx fallback to actually run gitnexus.
        PATH: '',
        Path: '',
        GITNEXUS_HOOK_TIMEOUT_PATH: 'disabled',
      },
      () => runGitNexusCli(['augment', '--', 'needle'], dir, 7000),
    );
    assert.doesNotMatch(
      child.stdout || '',
      new RegExp(SENTINEL),
      'relative override must NOT be executed',
    );
    // It fell through to PATH/which/npx resolution, which cannot resolve with
    // an empty PATH — so the spawn errors out (no augment) rather than running
    // the override.
    assert.ok(child.error, 'expected fall-through spawn to fail with stripped PATH');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runGitNexusCli ignores a GITNEXUS_HOOK_CLI_PATH containing .. traversal (override not executed)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-hook-dotdot-'));
  const script = path.join(dir, 'cli-stub.js');
  fs.writeFileSync(script, SCRIPT_BODY);
  // Absolute, EXISTING file, but with a `..` segment so it is not normalized:
  // e.g. <dir>/sub/../cli-stub.js resolves to the real script on disk, yet
  // path.normalize collapses the `..` — so the guard rejects it even though
  // fs.existsSync(value) is true. Built by raw concatenation (NOT path.join,
  // which would pre-normalize away the `..` we are deliberately testing).
  const subdir = path.join(dir, 'sub');
  fs.mkdirSync(subdir);
  const traversalPath = dir + path.sep + 'sub' + path.sep + '..' + path.sep + 'cli-stub.js';
  try {
    assert.ok(fs.existsSync(traversalPath), 'precondition: traversal path resolves to a real file');
    assert.strictEqual(
      isTrustedHookCliPath(traversalPath),
      false,
      'precondition: traversal path is not trusted',
    );
    const child = withEnv(
      {
        GITNEXUS_HOOK_CLI_PATH: traversalPath,
        PATH: '',
        Path: '',
        GITNEXUS_HOOK_TIMEOUT_PATH: 'disabled',
      },
      () => runGitNexusCli(['augment', '--', 'needle'], dir, 7000),
    );
    assert.doesNotMatch(
      child.stdout || '',
      new RegExp(SENTINEL),
      '.. traversal override must NOT be executed',
    );
    assert.ok(child.error, 'expected fall-through spawn to fail with stripped PATH');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
