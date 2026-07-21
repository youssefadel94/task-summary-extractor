'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { isGitAvailable, getChangedFilesSince, getDiffSummary, getCommitsSince } = require('../../src/services/git');

// These are integration tests against a throwaway git repo. Skip entirely if git
// is not on PATH so the suite still runs in minimal environments.
const gitOk = isGitAvailable();
const d = gitOk ? describe : describe.skip;

function git(repo, args) {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

d('git change detection (integration)', () => {
  let repo;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tsx-git-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('detects a renamed file by its NEW path (regression for R100 status)', () => {
    fs.writeFileSync(path.join(repo, 'Foo.cs'), 'class Foo {}\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'add Foo']);

    // Rename Foo.cs -> Bar.cs with content preserved so git records it as a rename.
    fs.renameSync(path.join(repo, 'Foo.cs'), path.join(repo, 'Bar.cs'));
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'rename Foo to Bar']);

    // Since a very old timestamp so all commits are included.
    const changed = getChangedFilesSince(repo, '2000-01-01T00:00:00Z');
    const paths = changed.map(c => c.path);
    expect(paths).toContain('Bar.cs');
  });

  it('detects plain add/modify', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'add a']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'modify a']);

    const changed = getChangedFilesSince(repo, '2000-01-01T00:00:00Z');
    expect(changed.map(c => c.path)).toContain('a.txt');
  });

  it('getCommitsSince returns commits (regression: null-byte format arg)', () => {
    // Previously the field separator was a null byte, which Node >= 20 rejects as
    // a spawn argument, so this silently returned [] on every call.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'first commit']);

    const commits = getCommitsSince(repo, '2000-01-01T00:00:00Z');
    expect(commits.length).toBeGreaterThan(0);
    expect(commits[0].message).toBe('first commit');
    expect(commits[0].hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('getDiffSummary includes the root commit changes', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'line one\nline two\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'root commit']);

    const summary = getDiffSummary(repo, '2000-01-01T00:00:00Z');
    // Root commit added 2 lines — the shortstat must reflect insertions, not be empty.
    expect(summary).toMatch(/insertion/);
  });
});
