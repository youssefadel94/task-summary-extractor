const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseArgs, showHelp, discoverFolders } = require('../../src/utils/cli');

// ─── Helper: create a temp directory with controlled structure ────────────────

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── parseArgs ───────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('returns empty flags and positional for no arguments', () => {
    const { flags, positional } = parseArgs([]);
    expect(flags).toEqual({});
    expect(positional).toEqual([]);
  });

  it('parses a boolean flag (--help)', () => {
    const { flags } = parseArgs(['--help']);
    expect(flags.help).toBe(true);
  });

  it('parses --key=value syntax', () => {
    const { flags } = parseArgs(['--name=Alice']);
    expect(flags.name).toBe('Alice');
  });

  it('parses --key value syntax for non-boolean flags', () => {
    const { flags } = parseArgs(['--model', 'gemini-2.5-pro']);
    expect(flags.model).toBe('gemini-2.5-pro');
  });

  it('boolean flags do not consume the next argument as a value', () => {
    const { flags, positional } = parseArgs(['--skip-upload', 'myFolder']);
    expect(flags['skip-upload']).toBe(true);
    expect(positional).toContain('myFolder');
  });

  it('collects positional arguments', () => {
    const { positional } = parseArgs(['call 1', 'extra']);
    expect(positional).toEqual(['call 1', 'extra']);
  });

  it('parses short flags like -v and -h', () => {
    const { flags } = parseArgs(['-v', '-h']);
    expect(flags.v).toBe(true);
    expect(flags.h).toBe(true);
  });

  it('handles mixed boolean flags, value flags, and positional args', () => {
    const { flags, positional } = parseArgs([
      '--resume', '--model', 'gemini-2.5-flash', '--name=Youssef', 'call 1',
    ]);
    expect(flags.resume).toBe(true);
    expect(flags.model).toBe('gemini-2.5-flash');
    expect(flags.name).toBe('Youssef');
    expect(positional).toEqual(['call 1']);
  });

  it('treats a trailing flag with no next arg as boolean true', () => {
    const { flags } = parseArgs(['--custom-flag']);
    expect(flags['custom-flag']).toBe(true);
  });

  it('treats a flag followed by another --flag as boolean true', () => {
    const { flags } = parseArgs(['--output', '--dry-run']);
    // --output has no value (next arg is --dry-run), so it becomes true
    expect(flags.output).toBe(true);
    expect(flags['dry-run']).toBe(true);
  });

  it('handles --key=value with equals sign in value', () => {
    const { flags } = parseArgs(['--request=Plan API=v2 migration']);
    expect(flags.request).toBe('Plan API=v2 migration');
  });

  it('handles multiple boolean flags from BOOLEAN_FLAGS set', () => {
    const { flags } = parseArgs([
      '--skip-compression', '--skip-gemini', '--no-html', '--dry-run',
    ]);
    expect(flags['skip-compression']).toBe(true);
    expect(flags['skip-gemini']).toBe(true);
    expect(flags['no-html']).toBe(true);
    expect(flags['dry-run']).toBe(true);
  });

  it('parses --deep-summary as a boolean flag', () => {
    const { flags, positional } = parseArgs(['--deep-summary', 'call 1']);
    expect(flags['deep-summary']).toBe(true);
    expect(positional).toContain('call 1');
  });

  it('parses --exclude-docs as a value flag', () => {
    const { flags } = parseArgs(['--deep-summary', '--exclude-docs', 'board.md,spec.md', 'call 1']);
    expect(flags['deep-summary']).toBe(true);
    expect(flags['exclude-docs']).toBe('board.md,spec.md');
  });

  it('parses --exclude-docs=value syntax', () => {
    const { flags } = parseArgs(['--exclude-docs=notes.md']);
    expect(flags['exclude-docs']).toBe('notes.md');
  });

  it('parses --no-progress as a boolean flag', () => {
    const { flags, positional } = parseArgs(['--no-progress', 'call 1']);
    expect(flags['no-progress']).toBe(true);
    expect(positional).toContain('call 1');
  });

  it('--no-progress does not consume the next argument', () => {
    const { flags, positional } = parseArgs(['--no-progress', '--name', 'Alice', 'folder']);
    expect(flags['no-progress']).toBe(true);
    expect(flags.name).toBe('Alice');
    expect(positional).toContain('folder');
  });
});

// ─── RUN_PRESETS ─────────────────────────────────────────────────────────────

describe('RUN_PRESETS', () => {
  const { RUN_PRESETS } = require('../../src/utils/cli');

  it('exports RUN_PRESETS object', () => {
    expect(RUN_PRESETS).toBeDefined();
    expect(typeof RUN_PRESETS).toBe('object');
  });

  it('has fast, balanced, detailed, custom presets', () => {
    expect(Object.keys(RUN_PRESETS)).toEqual(
      expect.arrayContaining(['fast', 'balanced', 'detailed', 'custom'])
    );
  });

  it('each preset has label, icon, description, overrides', () => {
    for (const [key, preset] of Object.entries(RUN_PRESETS)) {
      expect(preset.label).toBeDefined();
      expect(preset.icon).toBeDefined();
      expect(preset.description).toBeDefined();
      expect(preset.overrides).toBeDefined();
    }
  });

  it('fast preset disables progress tracking', () => {
    expect(RUN_PRESETS.fast.overrides.disableProgress).toBe(true);
  });

  it('balanced preset enables progress tracking', () => {
    expect(RUN_PRESETS.balanced.overrides.disableProgress).toBe(false);
  });

  it('detailed preset enables progress tracking', () => {
    expect(RUN_PRESETS.detailed.overrides.disableProgress).toBe(false);
  });
});

// ─── showHelp ────────────────────────────────────────────────────────────────

describe('showHelp', () => {
  it('throws an error with code HELP_SHOWN', () => {
    try {
      showHelp();
      expect.unreachable('showHelp should have thrown');
    } catch (err) {
      expect(err.code).toBe('HELP_SHOWN');
    }
  });

  it('throws an Error instance with message HELP_SHOWN', () => {
    expect(() => showHelp()).toThrow('HELP_SHOWN');
  });
});

// ─── discoverFolders ─────────────────────────────────────────────────────────

describe('discoverFolders', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('returns an empty array for an empty directory', () => {
    const result = discoverFolders(tmpDir);
    expect(result).toEqual([]);
  });

  it('returns an empty array for a non-existent directory', () => {
    const result = discoverFolders(path.join(tmpDir, 'nope'));
    expect(result).toEqual([]);
  });

  it('ignores folders with no relevant files', () => {
    const sub = path.join(tmpDir, 'empty-folder');
    fs.mkdirSync(sub);
    const result = discoverFolders(tmpDir);
    expect(result).toEqual([]);
  });

  it('detects a folder containing a .vtt doc file', () => {
    const sub = path.join(tmpDir, 'my-call');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'meeting.vtt'), 'WEBVTT');
    const result = discoverFolders(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('my-call');
    expect(result[0].docCount).toBe(1);
    expect(result[0].hasVideo).toBe(false);
    expect(result[0].description).toContain('1 doc');
  });

  it('detects a folder containing a video file', () => {
    const sub = path.join(tmpDir, 'video-call');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'recording.mp4'), '');
    const result = discoverFolders(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('video-call');
    expect(result[0].hasVideo).toBe(true);
    expect(result[0].description).toContain('video');
  });

  it('detects audio files and sets hasAudio', () => {
    const sub = path.join(tmpDir, 'audio-call');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'recording.mp3'), '');
    const result = discoverFolders(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].hasAudio).toBe(true);
    expect(result[0].description).toContain('audio');
  });

  it('skips infrastructure folders like node_modules, .git, src', () => {
    for (const skip of ['node_modules', '.git', 'src', 'logs', 'gemini_runs']) {
      const sub = path.join(tmpDir, skip);
      fs.mkdirSync(sub);
      fs.writeFileSync(path.join(sub, 'data.vtt'), 'WEBVTT');
    }
    const result = discoverFolders(tmpDir);
    expect(result).toEqual([]);
  });

  it('detects hasRuns when a "runs" subdirectory exists', () => {
    const sub = path.join(tmpDir, 'call-with-runs');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'transcript.vtt'), 'WEBVTT');
    fs.mkdirSync(path.join(sub, 'runs'));
    const result = discoverFolders(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].hasRuns).toBe(true);
    expect(result[0].description).toContain('has runs');
  });

  it('discovers multiple valid folders', () => {
    const sub1 = path.join(tmpDir, 'call-a');
    const sub2 = path.join(tmpDir, 'call-b');
    fs.mkdirSync(sub1);
    fs.mkdirSync(sub2);
    fs.writeFileSync(path.join(sub1, 'file.pdf'), '');
    fs.writeFileSync(path.join(sub2, 'rec.mp4'), '');
    const result = discoverFolders(tmpDir);
    expect(result).toHaveLength(2);
    const names = result.map(r => r.name).sort();
    expect(names).toEqual(['call-a', 'call-b']);
  });

  it('returns correct absPath for discovered folders', () => {
    const sub = path.join(tmpDir, 'my-project');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'notes.txt'), 'some notes');
    const result = discoverFolders(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].absPath).toBe(sub);
  });
});
