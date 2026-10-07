import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { listTrackedFiles } from '../../src/storage/git.js';

const makeTempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-tracked-'));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: path.join(cwd, '.no-global-git-config'),
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim();

describe('listTrackedFiles', () => {
  it('includes committed and staged paths verbatim, but excludes untracked files and gitlinks', () => {
    const root = makeTempDir();
    try {
      git(root, 'init', '-q');
      fs.writeFileSync(path.join(root, 'committed.ts'), 'committed');
      git(root, 'add', '--', 'committed.ts');
      git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'fixture');

      for (const name of ['staged.ts', 'tab\tname.ts', 'line\nname.ts', 'é.ts']) {
        fs.writeFileSync(path.join(root, name), name);
        git(root, 'add', '--', name);
      }
      fs.writeFileSync(path.join(root, 'untracked.ts'), 'untracked');
      const commit = git(root, 'rev-parse', 'HEAD');
      git(root, 'update-index', '--add', '--cacheinfo', `160000,${commit},module`);

      expect(listTrackedFiles(root)).toEqual(
        new Set(['committed.ts', 'staged.ts', 'tab\tname.ts', 'line\nname.ts', 'é.ts']),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns paths relative to a subdirectory and limited to that directory', () => {
    const root = makeTempDir();
    try {
      git(root, 'init', '-q');
      fs.mkdirSync(path.join(root, 'sub'));
      fs.writeFileSync(path.join(root, 'outside.ts'), 'outside');
      fs.writeFileSync(path.join(root, 'sub', 'inside.ts'), 'inside');
      git(root, 'add', '--', 'outside.ts', 'sub/inside.ts');

      expect(listTrackedFiles(path.join(root, 'sub'))).toEqual(new Set(['inside.ts']));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns an empty set for a repository without tracked files', () => {
    const root = makeTempDir();
    try {
      git(root, 'init', '-q');
      expect(listTrackedFiles(root)).toEqual(new Set());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null outside a Git repository', () => {
    const root = makeTempDir();
    try {
      expect(listTrackedFiles(root)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null when Git cannot be executed', () => {
    const root = makeTempDir();
    const previousPath = process.env.PATH;
    try {
      git(root, 'init', '-q');
      process.env.PATH = '';
      expect(listTrackedFiles(root)).toBeNull();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
