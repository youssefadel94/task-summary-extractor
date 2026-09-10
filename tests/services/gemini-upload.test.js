const { uploadAndAwaitFile } = require('../../src/services/gemini');

/**
 * A fake File API whose server-side processing fails a given number of times
 * before succeeding — the condition that cost a live run both of its batches.
 */
function makeFilesApi({ failures = 0, reason = 'internal error', processingRounds = 0 } = {}) {
  const state = { uploads: 0, deleted: [], gets: 0 };
  let remainingFailures = failures;
  let remainingProcessing = processingRounds;

  return {
    state,
    files: {
      upload: async () => {
        state.uploads++;
        if (remainingProcessing > 0) {
          return { name: `files/f${state.uploads}`, state: 'PROCESSING' };
        }
        if (remainingFailures > 0) {
          remainingFailures--;
          return { name: `files/f${state.uploads}`, state: 'FAILED', error: { message: reason } };
        }
        return { name: `files/f${state.uploads}`, uri: `https://gen/files/f${state.uploads}`, mimeType: 'video/mp4', state: 'ACTIVE' };
      },
      get: async ({ name }) => {
        state.gets++;
        remainingProcessing--;
        if (remainingProcessing > 0) return { name, state: 'PROCESSING' };
        if (remainingFailures > 0) {
          remainingFailures--;
          return { name, state: 'FAILED', error: { message: reason } };
        }
        return { name, uri: `https://gen/${name}`, mimeType: 'video/mp4', state: 'ACTIVE' };
      },
      delete: async ({ name }) => { state.deleted.push(name); },
    },
  };
}

const opts = { filePath: __filename, displayName: 'segment_00.mp4', label: 'test upload' };

describe('uploadAndAwaitFile', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns the file when processing succeeds first time', async () => {
    const api = makeFilesApi();
    const file = await uploadAndAwaitFile(api, opts);
    expect(file.state).toBe('ACTIVE');
    expect(api.state.uploads).toBe(1);
  });

  it('re-uploads when Gemini fails to process the file', async () => {
    // The upload itself worked; Google's processing of it gave up. That clears
    // on its own often enough to be worth another try before losing the segment.
    const api = makeFilesApi({ failures: 1 });
    const file = await uploadAndAwaitFile(api, opts);
    expect(file.state).toBe('ACTIVE');
    expect(api.state.uploads).toBe(2);
  });

  it('deletes the file it could not use before retrying', async () => {
    const api = makeFilesApi({ failures: 1 });
    await uploadAndAwaitFile(api, opts);
    expect(api.state.deleted).toEqual(['files/f1']);
  });

  it('gives up after three uploads and says why', async () => {
    const api = makeFilesApi({ failures: 99, reason: 'unsupported codec' });
    await expect(uploadAndAwaitFile(api, opts)).rejects.toThrow(/after 3 uploads/);
    await expect(uploadAndAwaitFile(api, opts)).rejects.toThrow(/unsupported codec/);
    expect(api.state.uploads).toBe(6);   // three per call
  });

  it('polls while the file is still processing', async () => {
    const api = makeFilesApi({ processingRounds: 2 });
    const file = await uploadAndAwaitFile(api, opts);
    expect(file.state).toBe('ACTIVE');
    expect(api.state.gets).toBeGreaterThan(0);
    expect(api.state.uploads).toBe(1);
  }, 30000);

  it('propagates an upload error rather than retrying it as a processing failure', async () => {
    const api = makeFilesApi();
    api.files.upload = async () => { throw new Error('INVALID_ARGUMENT: bad file'); };
    await expect(uploadAndAwaitFile(api, opts)).rejects.toThrow(/INVALID_ARGUMENT/);
  }, 30000);
});
