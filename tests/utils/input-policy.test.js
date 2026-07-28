'use strict';

const policy = require('../../src/utils/input-policy');

describe('input policy', () => {
  const wasTTY = process.stdin.isTTY;

  beforeEach(() => {
    policy.setInputMode('setup');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    policy.setInputMode('setup');
    Object.defineProperty(process.stdin, 'isTTY', { value: wasTTY, configurable: true });
  });

  it('waits generously while the user is setting the run up', () => {
    expect(policy.promptTimeoutMs()).toBe(policy.SETUP_TIMEOUT_MS);
    expect(policy.isInputDisabled()).toBe(false);
  });

  it('waits only briefly once work is running', () => {
    // Regression: a per-file prompt mid-run left a real run parked for 690s
    // (11.5 min) because the question was buried under background output.
    policy.setInputMode('running');
    expect(policy.promptTimeoutMs()).toBe(policy.RUNNING_TIMEOUT_MS);
    expect(policy.RUNNING_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it('never waits when input is disabled (--no-input)', () => {
    policy.setInputMode('disabled');
    expect(policy.isInputDisabled()).toBe(true);
    expect(policy.promptTimeoutMs()).toBe(0);
  });

  it('never waits when there is no TTY to ask on', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    expect(policy.isInputDisabled()).toBe(true);
    expect(policy.promptTimeoutMs()).toBe(0);
  });

  it('always reports a finite timeout, in every mode', () => {
    for (const mode of ['setup', 'running', 'disabled']) {
      policy.setInputMode(mode);
      const ms = policy.promptTimeoutMs();
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('promptUser / promptUserText never block', () => {
  const wasTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    policy.setInputMode('setup');
    Object.defineProperty(process.stdin, 'isTTY', { value: wasTTY, configurable: true });
  });

  it('resolves immediately with the stated default when input is unavailable', async () => {
    const { promptUser, promptUserText } = require('../../src/utils/cli');

    const started = Date.now();
    await expect(promptUser('Re-analyze? ')).resolves.toBe(false);
    await expect(promptUser('Continue? ', { defaultYes: true })).resolves.toBe(true);
    await expect(promptUserText('Name? ', { defaultText: 'anon' })).resolves.toBe('anon');
    // "Immediately" — no timer is awaited on this path.
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
