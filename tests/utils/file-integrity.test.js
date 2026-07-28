/**
 * Tests for src/utils/file-integrity.js
 *
 * Strategy: Mock fs and child_process via vi.spyOn to simulate
 * different file/probe states without needing real media files or ffprobe.
 */

const path = require('path');
const fs = require('fs');
const childProcess = require('child_process');

// Mock video.js getFFprobe — return a string path
vi.mock('../../src/services/video', () => ({
  getFFprobe: () => 'ffprobe',
}));

// Mock colors utility to passthrough strings
vi.mock('../../src/utils/colors', () => ({
  c: new Proxy({}, {
    get: () => (str) => str,
  }),
}));

const {
  probeMediaIntegrity,
  probeDocIntegrity,
  auditFileIntegrity,
  mergeAudits,
  excludeUnusable,
  printIntegrityReport,
  SEVERITY,
  MIN_VIDEO_BITRATE_BPS,
  MIN_AUDIO_BITRATE_BPS,
  DURATION_MISMATCH_RATIO,
} = require('../../src/utils/file-integrity');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spy on fs.statSync to return a fake stat with the given size */
function mockStatSync(size) {
  vi.spyOn(fs, 'statSync').mockReturnValue({ size, isFile: () => true });
}

function mockFfprobeResult({ format = {}, streams = [], status = 0, stderr = '' } = {}) {
  vi.spyOn(childProcess, 'spawnSync').mockReturnValue({
    status,
    stdout: JSON.stringify({ format, streams }),
    stderr,
  });
}

/**
 * Mock the two-step probe: the metadata call, then the packet-timestamp scan
 * that runs only when the container reports no duration.
 */
function mockProbeThenScan({ format = {}, streams = [], scanStdout = '' } = {}) {
  vi.spyOn(childProcess, 'spawnSync').mockImplementation((bin, args) => {
    const isScan = args.includes('packet=pts_time');
    return isScan
      ? { status: 0, stdout: scanStdout, stderr: '' }
      : { status: 0, stdout: JSON.stringify({ format, streams }), stderr: '' };
  });
}

/**
 * Build typical ffprobe result for a healthy video file.
 * 300s duration, 2 Mbps bitrate, 1 video + 1 audio stream.
 */
function healthyVideoProbe(durationSec = 300) {
  return {
    format: {
      duration: String(durationSec),
      bit_rate: '2000000',
      nb_streams: '2',
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    },
    streams: [
      { codec_type: 'video', duration: String(durationSec), bit_rate: '1800000', nb_frames: String(durationSec * 30) },
      { codec_type: 'audio', duration: String(durationSec), bit_rate: '128000' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Constants tests
// ---------------------------------------------------------------------------
describe('Constants', () => {
  it('exports severity levels', () => {
    expect(SEVERITY.ERROR).toBe('error');
    expect(SEVERITY.WARNING).toBe('warning');
    expect(SEVERITY.INFO).toBe('info');
  });

  it('exports threshold constants', () => {
    expect(MIN_VIDEO_BITRATE_BPS).toBe(80_000);
    expect(MIN_AUDIO_BITRATE_BPS).toBe(8_000);
    expect(DURATION_MISMATCH_RATIO).toBe(0.50);
  });
});

// ---------------------------------------------------------------------------
// probeMediaIntegrity — VIDEO
// ---------------------------------------------------------------------------
describe('probeMediaIntegrity (video)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error for non-existent file', () => {
    vi.spyOn(fs, 'statSync').mockImplementation(() => { throw new Error('ENOENT'); });
    const result = probeMediaIntegrity('/fake/video.mp4', 'video');

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe('error');
    expect(result.issues[0].message).toMatch(/not found|unreadable/i);
  });

  it('returns error for zero-byte file', () => {
    mockStatSync(0);
    const result = probeMediaIntegrity('/fake/video.mp4', 'video');

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe('error');
    expect(result.issues[0].message).toMatch(/empty.*0 bytes/i);
  });

  it('returns error when ffprobe fails to execute', () => {
    mockStatSync(100_000_000); // 100 MB
    vi.spyOn(childProcess, 'spawnSync').mockImplementation(() => { throw new Error('ENOENT: ffprobe not found'); });

    const result = probeMediaIntegrity('/fake/video.mp4', 'video');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe('error');
    expect(result.issues[0].message).toMatch(/ffprobe failed/i);
  });

  it('returns error when ffprobe returns non-zero exit code', () => {
    mockStatSync(100_000_000);
    vi.spyOn(childProcess, 'spawnSync').mockReturnValue({ status: 1, stdout: '', stderr: 'Invalid data' });

    const result = probeMediaIntegrity('/fake/video.mp4', 'video');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe('error');
    expect(result.issues[0].message).toMatch(/could not read/i);
  });

  it('returns error when ffprobe returns invalid JSON', () => {
    mockStatSync(100_000_000);
    vi.spyOn(childProcess, 'spawnSync').mockReturnValue({ status: 0, stdout: 'NOT JSON', stderr: '' });

    const result = probeMediaIntegrity('/fake/video.mp4', 'video');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe('error');
    expect(result.issues[0].message).toMatch(/invalid JSON/i);
  });

  it('returns no issues for healthy video', () => {
    // 100 MB, 300s = ~2.67 Mbps — perfectly healthy
    mockStatSync(100_000_000);
    mockFfprobeResult(healthyVideoProbe(300));

    const result = probeMediaIntegrity('/fake/video.mp4', 'video');
    expect(result.issues).toHaveLength(0);
    expect(result.meta.formatDuration).toBe(300);
    expect(result.meta.hasVideoStream).toBe(true);
    expect(result.meta.hasAudioStream).toBe(true);
  });

  it('flags suspiciously low bitrate (like the Mohamed Elhadi case)', () => {
    // 27 MB file claiming 60:28 (3628s) = ~60 kbps (below 50 kbps threshold)
    const fileSize = 27 * 1024 * 1024; // 27 MB
    const duration = 3628; // 60:28
    mockStatSync(fileSize);
    mockFfprobeResult({
      format: { duration: String(duration), bit_rate: '59500', nb_streams: '2', format_name: 'mp4' },
      streams: [
        { codec_type: 'video', duration: String(duration), bit_rate: '50000' },
        { codec_type: 'audio', duration: String(duration), bit_rate: '9500' },
      ],
    });

    const result = probeMediaIntegrity('/fake/corrupt.mp4', 'video');
    const bitrateWarning = result.issues.find(i => i.message.includes('bitrate'));
    expect(bitrateWarning).toBeDefined();
    expect(bitrateWarning.severity).toBe('warning');
    expect(bitrateWarning.message).toMatch(/Suspiciously low bitrate/);
    expect(result.meta.calculatedBitrateBps).toBeLessThan(MIN_VIDEO_BITRATE_BPS);
  });

  it('flags missing video stream in video file', () => {
    mockStatSync(50_000_000); // 50 MB
    mockFfprobeResult({
      format: { duration: '300', bit_rate: '1000000', nb_streams: '1', format_name: 'mp4' },
      streams: [
        { codec_type: 'audio', duration: '300', bit_rate: '128000' },
      ],
    });

    const result = probeMediaIntegrity('/fake/video.mp4', 'video');
    const noVideoIssue = result.issues.find(i => i.message.includes('No video stream'));
    expect(noVideoIssue).toBeDefined();
    expect(noVideoIssue.severity).toBe('warning');
  });

  it('flags missing audio stream as info', () => {
    mockStatSync(50_000_000);
    mockFfprobeResult({
      format: { duration: '300', bit_rate: '1500000', nb_streams: '1', format_name: 'mp4' },
      streams: [
        { codec_type: 'video', duration: '300', bit_rate: '1500000' },
      ],
    });

    const result = probeMediaIntegrity('/fake/video.mp4', 'video');
    const noAudioIssue = result.issues.find(i => i.message.includes('No audio stream'));
    expect(noAudioIssue).toBeDefined();
    expect(noAudioIssue.severity).toBe('info');
  });

  it('errors on missing duration only when the stream is also unreadable', () => {
    mockStatSync(50_000_000);
    mockProbeThenScan({
      format: { duration: '0', nb_streams: '2', format_name: 'mp4' },
      streams: [{ codec_type: 'video' }, { codec_type: 'audio' }],
      scanStdout: '', // no packets came back
    });

    const result = probeMediaIntegrity('/fake/video.mp4', 'video');
    const durIssue = result.issues.find(i => i.message.includes('no readable packets'));
    expect(durIssue).toBeDefined();
    expect(durIssue.severity).toBe('error');
  });

  it('recovers duration by scanning packets when the header has none', () => {
    // Regression: unfinalized recordings (browser MediaRecorder .webm, OBS
    // captures) carry no Duration element but play fine. They used to be
    // reported as ERROR "File header may be corrupt".
    mockStatSync(46_000_000);
    mockProbeThenScan({
      format: { nb_streams: '2', format_name: 'matroska,webm' },
      streams: [{ codec_type: 'video' }, { codec_type: 'audio' }],
      scanStdout: '0.000\n0.033\n849.500\n', // last packet at ~14:09
    });

    const result = probeMediaIntegrity('/fake/recording.webm', 'video');
    const durIssue = result.issues.find(i => i.message.includes('measured'));
    expect(durIssue).toBeDefined();
    expect(durIssue.severity).toBe('info');
    expect(result.meta.formatDuration).toBe(849.5);
    expect(result.meta.durationSource).toBe('packet-scan');
    // An INFO-only file must not trip the "some files may be broken" banner.
    expect(result.issues.some(i => i.severity === 'error')).toBe(false);
  });

  it('stays informational when packets are readable but carry no timestamps', () => {
    mockStatSync(46_000_000);
    mockProbeThenScan({
      format: { duration: '0', nb_streams: '1', format_name: 'matroska,webm' },
      streams: [{ codec_type: 'video' }],
      scanStdout: 'N/A\nN/A\n',
    });

    const result = probeMediaIntegrity('/fake/recording.webm', 'video');
    const durIssue = result.issues.find(i => i.message.includes('packets readable'));
    expect(durIssue).toBeDefined();
    expect(durIssue.severity).toBe('info');
  });

  it('explains an unreadable MP4 that has no ftyp box', () => {
    mockStatSync(409_504);
    vi.spyOn(childProcess, 'spawnSync').mockReturnValue({
      status: 1, stdout: '', stderr: 'moov atom not found',
    });
    // Header bytes of a failed download — no recognizable box type at offset 4.
    vi.spyOn(fs, 'openSync').mockReturnValue(7);
    vi.spyOn(fs, 'closeSync').mockImplementation(() => {});
    vi.spyOn(fs, 'readSync').mockImplementation((fd, buf) => {
      Buffer.from('b0f0e44e5381fd145f0e8467', 'hex').copy(buf);
      return 16;
    });

    const result = probeMediaIntegrity('/fake/broken.mp4', 'video');
    const issue = result.issues[0];
    expect(issue.severity).toBe('error');
    expect(issue.detail).toMatch(/not a real MP4/);
    expect(issue.detail).toMatch(/moov atom not found/);
  });

  it('flags duration mismatch between container and stream', () => {
    // Container says 3600s (1 hour), but video stream only has 600s (10 min) → ratio 0.167
    mockStatSync(500_000_000); // 500 MB — high enough bitrate for the container duration
    mockFfprobeResult({
      format: { duration: '3600', bit_rate: '1000000', nb_streams: '2', format_name: 'mp4' },
      streams: [
        { codec_type: 'video', duration: '600', bit_rate: '6000000' },
        { codec_type: 'audio', duration: '600', bit_rate: '128000' },
      ],
    });

    const result = probeMediaIntegrity('/fake/mismatch.mp4', 'video');
    const mismatchIssue = result.issues.find(i => i.message.includes('Duration mismatch'));
    expect(mismatchIssue).toBeDefined();
    expect(mismatchIssue.severity).toBe('warning');
    expect(result.meta.durationMatchRatio).toBeLessThan(DURATION_MISMATCH_RATIO);
  });

  it('flags unusually small file at info level', () => {
    // 2 MB for a 10-minute video = 0.2 MB/min (below 0.5 MB/min threshold)
    const fileSize = 2 * 1024 * 1024; // 2 MB
    const duration = 600; // 10 min
    // bitrate: 2MB/600s = ~26kbps — will also trigger low bitrate
    mockStatSync(fileSize);
    mockFfprobeResult({
      format: { duration: String(duration), bit_rate: '26000', nb_streams: '2', format_name: 'mp4' },
      streams: [
        { codec_type: 'video', duration: String(duration), bit_rate: '20000' },
        { codec_type: 'audio', duration: String(duration), bit_rate: '6000' },
      ],
    });

    const result = probeMediaIntegrity('/fake/small.mp4', 'video');
    const smallIssue = result.issues.find(i => i.message.includes('Unusually small'));
    expect(smallIssue).toBeDefined();
    expect(smallIssue.severity).toBe('info');
    expect(result.meta.mbPerMinute).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// probeMediaIntegrity — AUDIO
// ---------------------------------------------------------------------------
describe('probeMediaIntegrity (audio)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns no issues for healthy audio', () => {
    // 5 MB, 300s = ~133 kbps — healthy audio
    mockStatSync(5_000_000);
    mockFfprobeResult({
      format: { duration: '300', bit_rate: '128000', nb_streams: '1', format_name: 'mp3' },
      streams: [{ codec_type: 'audio', duration: '300', bit_rate: '128000' }],
    });

    const result = probeMediaIntegrity('/fake/audio.mp3', 'audio');
    // May have info about no video stream, but no errors/warnings
    const errorsAndWarnings = result.issues.filter(i => i.severity !== 'info');
    expect(errorsAndWarnings).toHaveLength(0);
  });

  it('uses lower bitrate threshold for audio', () => {
    // 100 KB for 300s = ~2.6 kbps — way below 8 kbps audio threshold
    mockStatSync(100_000);
    mockFfprobeResult({
      format: { duration: '300', bit_rate: '2600', nb_streams: '1', format_name: 'mp3' },
      streams: [{ codec_type: 'audio', duration: '300', bit_rate: '2600' }],
    });

    const result = probeMediaIntegrity('/fake/corrupt.mp3', 'audio');
    const bitrateWarning = result.issues.find(i => i.message.includes('bitrate'));
    expect(bitrateWarning).toBeDefined();
    expect(bitrateWarning.severity).toBe('warning');
    expect(result.meta.calculatedBitrateBps).toBeLessThan(MIN_AUDIO_BITRATE_BPS);
  });
});

// ---------------------------------------------------------------------------
// probeDocIntegrity
// ---------------------------------------------------------------------------
describe('probeDocIntegrity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error for non-existent file', () => {
    vi.spyOn(fs, 'statSync').mockImplementation(() => { throw new Error('ENOENT'); });

    const result = probeDocIntegrity({ absPath: '/fake/doc.pdf', relPath: 'doc.pdf' });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe('error');
    expect(result.issues[0].message).toMatch(/not found|unreadable/i);
  });

  it('returns error for zero-byte file', () => {
    mockStatSync(0);

    const result = probeDocIntegrity({ absPath: '/fake/doc.vtt', relPath: 'doc.vtt' });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe('error');
    expect(result.issues[0].message).toMatch(/empty.*0 bytes/i);
  });

  it('flags whitespace-only text file', () => {
    mockStatSync(5);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('   \n\n  ');

    const result = probeDocIntegrity({ absPath: '/fake/doc.vtt', relPath: 'doc.vtt' });
    const emptyIssue = result.issues.find(i => i.message.includes('no text content'));
    expect(emptyIssue).toBeDefined();
    expect(emptyIssue.severity).toBe('warning');
  });

  it('flags very small text file as info', () => {
    mockStatSync(5);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('hello');

    const result = probeDocIntegrity({ absPath: '/fake/tiny.txt', relPath: 'tiny.txt' });
    const smallIssue = result.issues.find(i => i.message.includes('very little content'));
    expect(smallIssue).toBeDefined();
    expect(smallIssue.severity).toBe('info');
  });

  it('returns no issues for a sufficient text file', () => {
    mockStatSync(1000);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('This is a valid meeting transcript with substantial content for analysis purposes.');

    const result = probeDocIntegrity({ absPath: '/fake/meeting.vtt', relPath: 'meeting.vtt' });
    expect(result.issues).toHaveLength(0);
  });

  it('flags unreadable text file', () => {
    mockStatSync(1000);
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('encoding error'); });

    const result = probeDocIntegrity({ absPath: '/fake/broken.txt', relPath: 'broken.txt' });
    const readIssue = result.issues.find(i => i.message.includes('could not be read'));
    expect(readIssue).toBeDefined();
    expect(readIssue.severity).toBe('error');
  });

  it('flags invalid PDF magic bytes', () => {
    mockStatSync(50_000);
    const fakeBuf = Buffer.from('NOT_PDF_XX');
    vi.spyOn(fs, 'openSync').mockReturnValue(42);
    vi.spyOn(fs, 'readSync').mockImplementation((fd, buf) => {
      fakeBuf.copy(buf, 0, 0, 8);
      return 8;
    });
    vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);

    const result = probeDocIntegrity({ absPath: '/fake/bad.pdf', relPath: 'bad.pdf' });
    const pdfIssue = result.issues.find(i => i.message.includes('PDF header'));
    expect(pdfIssue).toBeDefined();
    expect(pdfIssue.severity).toBe('warning');
  });

  it('passes valid PDF magic bytes', () => {
    mockStatSync(50_000);
    const pdfBuf = Buffer.from('%PDF-1.4');
    vi.spyOn(fs, 'openSync').mockReturnValue(42);
    vi.spyOn(fs, 'readSync').mockImplementation((fd, buf) => {
      pdfBuf.copy(buf, 0, 0, 8);
      return 8;
    });
    vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);

    const result = probeDocIntegrity({ absPath: '/fake/good.pdf', relPath: 'good.pdf' });
    const pdfIssue = result.issues.find(i => i.message.includes('PDF header'));
    expect(pdfIssue).toBeUndefined();
  });

  it('flags invalid DOCX magic bytes (not ZIP)', () => {
    mockStatSync(50_000);
    const fakeBuf = Buffer.from('XXXXXXXX');
    vi.spyOn(fs, 'openSync').mockReturnValue(42);
    vi.spyOn(fs, 'readSync').mockImplementation((fd, buf) => {
      fakeBuf.copy(buf, 0, 0, 8);
      return 8;
    });
    vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);

    const result = probeDocIntegrity({ absPath: '/fake/bad.docx', relPath: 'bad.docx' });
    const zipIssue = result.issues.find(i => i.message.includes('ZIP header'));
    expect(zipIssue).toBeDefined();
    expect(zipIssue.severity).toBe('warning');
  });

  it('uses relPath for display name when available', () => {
    vi.spyOn(fs, 'statSync').mockImplementation(() => { throw new Error('ENOENT'); });

    const result = probeDocIntegrity({ absPath: '/some/deep/path/file.txt', relPath: 'folder/file.txt' });
    expect(result.file).toBe('folder/file.txt');
  });
});

// ---------------------------------------------------------------------------
// auditFileIntegrity
// ---------------------------------------------------------------------------
describe('excludeUnusable / mergeAudits', () => {
  const audit = {
    unusable: [{ file: 'broken.mp4', filePath: '/calls/broken.mp4', type: 'video', reason: 'unreadable' }],
  };

  it('splits media paths into kept and dropped', () => {
    const { kept, dropped } = excludeUnusable(['/calls/good.mp4', '/calls/broken.mp4'], audit);
    expect(kept).toEqual(['/calls/good.mp4']);
    expect(dropped).toEqual(['/calls/broken.mp4']);
  });

  it('splits document objects by absPath', () => {
    const docs = [{ absPath: '/calls/notes.md', relPath: 'notes.md' }, { absPath: '/calls/broken.mp4' }];
    const { kept, dropped } = excludeUnusable(docs, audit);
    expect(kept).toHaveLength(1);
    expect(kept[0].relPath).toBe('notes.md');
    expect(dropped).toHaveLength(1);
  });

  it('keeps everything when there is no audit or nothing unusable', () => {
    expect(excludeUnusable(['/a.mp4'], null).kept).toEqual(['/a.mp4']);
    expect(excludeUnusable(['/a.mp4'], { unusable: [] }).dropped).toEqual([]);
  });

  it('merges audits run at different points into one report', () => {
    const a = { warnings: [{ file: 'a' }], hasErrors: true, hasSuspicious: true, report: [{}], unusable: [{ file: 'a' }] };
    const b = { warnings: [{ file: 'b' }], hasErrors: false, hasSuspicious: false, report: [{}], unusable: [] };
    const merged = mergeAudits(a, b, null);

    expect(merged.warnings).toHaveLength(2);
    expect(merged.unusable).toHaveLength(1);
    expect(merged.hasErrors).toBe(true);
    expect(merged.totalFiles).toBe(2);
  });
});

describe('auditFileIntegrity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty result when no files are provided', () => {
    const result = auditFileIntegrity({});
    expect(result.warnings).toHaveLength(0);
    expect(result.hasErrors).toBe(false);
    expect(result.hasSuspicious).toBe(false);
    expect(result.report).toHaveLength(0);
  });

  it('returns empty result for all healthy files', () => {
    // Healthy video
    mockStatSync(100_000_000);
    mockFfprobeResult(healthyVideoProbe(300));

    const result = auditFileIntegrity({
      videoFiles: ['/fake/video.mp4'],
      audioFiles: [],
      docFiles: [],
    });

    expect(result.warnings).toHaveLength(0);
    expect(result.hasErrors).toBe(false);
    expect(result.report).toHaveLength(1);
    expect(result.report[0].issues).toHaveLength(0);
  });

  it('lists unreadable files as unusable and marks their warnings excluded', () => {
    mockStatSync(409_504);
    vi.spyOn(childProcess, 'spawnSync').mockReturnValue({ status: 1, stdout: '', stderr: 'moov atom not found' });

    const result = auditFileIntegrity({ videoFiles: ['/fake/broken.mp4'] });

    expect(result.unusable).toHaveLength(1);
    expect(result.unusable[0].filePath).toBe('/fake/broken.mp4');
    expect(result.unusable[0].type).toBe('video');
    expect(result.warnings.every(w => w.excluded)).toBe(true);
    expect(result.totalFiles).toBe(1);
  });

  it('does not mark WARNING/INFO files as unusable', () => {
    // Healthy container, but the bitrate looks low → WARNING, still processed.
    mockStatSync(1_000_000);
    mockFfprobeResult({
      format: { duration: '3600', nb_streams: '2', format_name: 'mp4' },
      streams: [
        { codec_type: 'video', duration: '3600' },
        { codec_type: 'audio', duration: '3600' },
      ],
    });

    const result = auditFileIntegrity({ videoFiles: ['/fake/thin.mp4'] });

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.unusable).toHaveLength(0);
    expect(result.warnings.every(w => w.excluded === false)).toBe(true);
  });

  it('aggregates issues across file types', () => {
    // First call: statSync for video (zero-byte)
    vi.spyOn(fs, 'statSync')
      .mockReturnValueOnce({ size: 0, isFile: () => true })  // video
      .mockReturnValueOnce({ size: 0, isFile: () => true }); // doc

    const result = auditFileIntegrity({
      videoFiles: ['/fake/broken.mp4'],
      audioFiles: [],
      docFiles: [{ absPath: '/fake/empty.vtt', relPath: 'empty.vtt' }],
    });

    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    expect(result.hasErrors).toBe(true);
    expect(result.report).toHaveLength(2);
  });

  it('sets hasSuspicious for warning-level issues', () => {
    // Low bitrate video (warning, not error)
    const fileSize = 1 * 1024 * 1024; // 1 MB
    mockStatSync(fileSize);
    mockFfprobeResult({
      format: { duration: '3600', bit_rate: '2200', nb_streams: '2', format_name: 'mp4' },
      streams: [
        { codec_type: 'video', duration: '3600', bit_rate: '2000' },
        { codec_type: 'audio', duration: '3600', bit_rate: '200' },
      ],
    });

    const result = auditFileIntegrity({
      videoFiles: ['/fake/suspect.mp4'],
      audioFiles: [],
      docFiles: [],
    });

    expect(result.hasSuspicious).toBe(true);
    // May or may not have errors depending on exact bitrate calc
  });

  it('flat warnings array has correct structure', () => {
    vi.spyOn(fs, 'statSync').mockImplementation(() => { throw new Error('ENOENT'); });

    const result = auditFileIntegrity({
      videoFiles: ['/fake/missing.mp4'],
      audioFiles: [],
      docFiles: [],
    });

    expect(result.warnings).toHaveLength(1);
    const w = result.warnings[0];
    expect(w).toHaveProperty('file');
    expect(w).toHaveProperty('type');
    expect(w).toHaveProperty('severity');
    expect(w).toHaveProperty('message');
    expect(w).toHaveProperty('detail');
    expect(w.type).toBe('video');
  });
});

// ---------------------------------------------------------------------------
// printIntegrityReport
// ---------------------------------------------------------------------------
describe('printIntegrityReport', () => {
  let consoleSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('prints nothing when no warnings', () => {
    printIntegrityReport({ warnings: [], hasErrors: false, hasSuspicious: false });
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('prints warnings grouped by file', () => {
    printIntegrityReport({
      warnings: [
        { file: 'video.mp4', type: 'video', severity: 'warning', message: 'Low bitrate', detail: 'May be truncated' },
        { file: 'doc.vtt', type: 'document', severity: 'error', message: 'Empty file', detail: null },
      ],
      hasErrors: true,
      hasSuspicious: true,
    });

    // Should have been called multiple times
    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('File Integrity Check');
    expect(output).toContain('video.mp4');
    expect(output).toContain('doc.vtt');
    expect(output).toContain('Low bitrate');
    expect(output).toContain('Empty file');
    // Errors mean the file was skipped, not that the whole run is compromised.
    expect(output).toContain('Unreadable files were skipped');
  });

  it('shows suspicious-only message when no errors', () => {
    printIntegrityReport({
      warnings: [
        { file: 'video.mp4', type: 'video', severity: 'warning', message: 'Low bitrate', detail: null },
      ],
      hasErrors: false,
      hasSuspicious: true,
    });

    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('suspicious');
    expect(output).not.toContain('broken');
  });

  it('calls logger when provided', () => {
    const mockLog = { warn: vi.fn(), error: vi.fn() };

    printIntegrityReport({
      warnings: [
        { file: 'a.mp4', type: 'video', severity: 'error', message: 'Unreadable', detail: null },
        { file: 'b.mp4', type: 'video', severity: 'warning', message: 'Low bitrate', detail: null },
      ],
      hasErrors: true,
      hasSuspicious: true,
    }, mockLog);

    expect(mockLog.error).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
  });
});
