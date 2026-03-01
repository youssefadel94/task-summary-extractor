const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Logger', () => {
  let Logger;
  let tmpDir;

  beforeAll(() => {
    Logger = require('../src/logger');
  });

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ---- session_end written on close ----

  it('writes session_end event to structured JSONL on close()', () => {
    const log = new Logger(tmpDir, 'test-call', { flushIntervalMs: 60000 });
    log.info('hello');
    log.close();

    const structuredPath = log.structuredPath;
    const lines = fs.readFileSync(structuredPath, 'utf8').trim().split('\n');
    const events = lines.map(l => JSON.parse(l));
    const sessionEnd = events.find(e => e.event === 'session_end');

    expect(sessionEnd).toBeDefined();
    expect(sessionEnd.totalElapsedMs).toBeGreaterThanOrEqual(0);
    expect(sessionEnd.phases).toBeInstanceOf(Array);
  });

  it('writes session_end even when a phase is active at close', () => {
    const log = new Logger(tmpDir, 'test-call', { flushIntervalMs: 60000 });
    log.phaseStart('some_phase');
    log.info('working...');
    log.close();

    const lines = fs.readFileSync(log.structuredPath, 'utf8').trim().split('\n');
    const events = lines.map(l => JSON.parse(l));

    const phaseEnd = events.find(e => e.event === 'phase_end');
    expect(phaseEnd).toBeDefined();
    expect(phaseEnd.phase).toBe('some_phase');

    const sessionEnd = events.find(e => e.event === 'session_end');
    expect(sessionEnd).toBeDefined();
  });

  it('close() is idempotent — second call does nothing', () => {
    const log = new Logger(tmpDir, 'test-call', { flushIntervalMs: 60000 });
    log.close();
    log.close(); // should not throw or duplicate footer

    const lines = fs.readFileSync(log.structuredPath, 'utf8').trim().split('\n');
    const events = lines.map(l => JSON.parse(l));
    const sessionEnds = events.filter(e => e.event === 'session_end');
    expect(sessionEnds.length).toBe(1);
  });

  // ---- detailed/minimal log footer ----

  it('writes CLOSED footer to detailed and minimal logs', () => {
    const log = new Logger(tmpDir, 'test-call', { flushIntervalMs: 60000 });
    log.step('milestone');
    log.close();

    const detailed = fs.readFileSync(log.detailedPath, 'utf8');
    const minimal = fs.readFileSync(log.minimalPath, 'utf8');

    expect(detailed).toContain('=== CLOSED');
    expect(minimal).toContain('=== CLOSED');
  });

  // ---- basic log methods ----

  it('logs info, warn, error, step, debug correctly', () => {
    const log = new Logger(tmpDir, 'test-call', { level: 'debug', flushIntervalMs: 60000 });
    log.debug('dbg msg');
    log.info('info msg');
    log.warn('warn msg');
    log.error('error msg');
    log.step('step msg');
    log.close();

    const detailed = fs.readFileSync(log.detailedPath, 'utf8');
    expect(detailed).toContain('DBG  dbg msg');
    expect(detailed).toContain('INFO info msg');
    expect(detailed).toContain('WARN warn msg');
    expect(detailed).toContain('ERR  error msg');
    expect(detailed).toContain('STEP step msg');
  });

  // ---- ANSI stripping ----

  it('strips ANSI escape codes from log files', () => {
    const log = new Logger(tmpDir, 'test-call', { flushIntervalMs: 60000 });
    log.info('\x1b[32mGreen text\x1b[0m');
    log.close();

    const detailed = fs.readFileSync(log.detailedPath, 'utf8');
    expect(detailed).toContain('Green text');
    expect(detailed).not.toContain('\x1b[');
  });

  // ---- metric goes to structured only ----

  it('writes metric events to structured log only', () => {
    const log = new Logger(tmpDir, 'test-call', { flushIntervalMs: 60000 });
    log.metric('test_metric', 42);
    log.close();

    const lines = fs.readFileSync(log.structuredPath, 'utf8').trim().split('\n');
    const events = lines.map(l => JSON.parse(l));
    const metric = events.find(e => e.event === 'metric' && e.metric === 'test_metric');
    expect(metric).toBeDefined();
    expect(metric.value).toBe(42);
  });

  // ---- phase timing ----

  it('tracks phase start/end with duration', async () => {
    const log = new Logger(tmpDir, 'test-call', { flushIntervalMs: 60000 });
    log.phaseStart('upload');
    // Small delay to ensure duration > 0
    await new Promise(resolve => setTimeout(resolve, 10));
    const duration = log.phaseEnd({ files: 3 });
    log.close();

    expect(duration).toBeGreaterThan(0);

    const phases = log.getPhases();
    expect(phases.length).toBe(1);
    expect(phases[0].phase).toBe('upload');
    expect(phases[0].files).toBe(3);
  });

  // ---- no writes after close ----

  it('does not write after logger is closed', () => {
    const log = new Logger(tmpDir, 'test-call', { flushIntervalMs: 60000 });
    log.close();

    const sizeBefore = fs.statSync(log.detailedPath).size;
    log.info('should be ignored');
    // Force any pending writes
    log._flush(true);
    const sizeAfter = fs.statSync(log.detailedPath).size;

    expect(sizeAfter).toBe(sizeBefore);
  });
});
