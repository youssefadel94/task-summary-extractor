'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { segmentCacheStaleReason, writeSegmentManifest, segmentParams } =
  require('../../src/phases/process-media');
const { asciiDisplayName, uploadFile } = require('../../src/services/gemini');

function tmpSegmentDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'segcache-'));
}

/** A source recording whose size/mtime the manifest records. */
function makeSource(dir, bytes = 1000) {
  const p = path.join(dir, 'meeting.mp4');
  fs.writeFileSync(p, Buffer.alloc(bytes));
  return p;
}

describe('segment cache validity', () => {
  let dir, src;

  beforeEach(() => {
    dir = tmpSegmentDir();
    src = makeSource(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adopts a segment folder that predates the manifest, once', () => {
    // Upgrading must not force everyone into a re-encode.
    expect(segmentCacheStaleReason(dir, src, { speed: 1.6 }, {})).toBeNull();
    expect(fs.existsSync(path.join(dir, '.segment-params.json'))).toBe(true);
  });

  it('accepts segments made with the same settings and source', () => {
    writeSegmentManifest(dir, segmentParams(src, { speed: 1.6, segTime: 280 }, {}));
    expect(segmentCacheStaleReason(dir, src, { speed: 1.6, segTime: 280 }, {})).toBeNull();
  });

  it('rejects segments when the speed changed', () => {
    // Regression: 1.6x segments were silently reused under --speed 2, so every
    // timestamp in the analysis was wrong.
    writeSegmentManifest(dir, segmentParams(src, { speed: 1.6, segTime: 280 }, {}));
    expect(segmentCacheStaleReason(dir, src, { speed: 2, segTime: 280 }, {}))
      .toMatch(/speed changed 1\.6x → 2x/);
  });

  it('rejects segments when the segment time changed', () => {
    writeSegmentManifest(dir, segmentParams(src, { speed: 1.6, segTime: 280 }, {}));
    expect(segmentCacheStaleReason(dir, src, { speed: 1.6, segTime: 600 }, {}))
      .toMatch(/segment time changed/);
  });

  it('rejects segments when compression mode changed', () => {
    writeSegmentManifest(dir, segmentParams(src, {}, { noCompress: true }));
    expect(segmentCacheStaleReason(dir, src, { speed: 1.6 }, {})).toMatch(/--no-compress/);
  });

  it('rejects segments when the source recording changed on disk', () => {
    writeSegmentManifest(dir, segmentParams(src, { speed: 1.6 }, {}));
    fs.writeFileSync(src, Buffer.alloc(5000)); // re-downloaded, different file
    expect(segmentCacheStaleReason(dir, src, { speed: 1.6 }, {}))
      .toMatch(/source recording changed/);
  });

  it('ignores segment time when compression is off (it does not apply)', () => {
    writeSegmentManifest(dir, segmentParams(src, { segTime: 1200 }, { noCompress: true }));
    expect(segmentCacheStaleReason(dir, src, { segTime: 999 }, { noCompress: true })).toBeNull();
  });
});

describe('asciiDisplayName', () => {
  it('makes a non-Latin filename safe to send as a header', () => {
    // Regression: this exact file failed with "Cannot convert argument to a
    // ByteString ... value of 1578" and was dropped from the analysis.
    const out = asciiDisplayName('__1تطبيق الاعمال 1.pdf');
    // eslint-disable-next-line no-control-regex
    expect(/^[\x20-\x7E]*$/.test(out)).toBe(true);
    expect(out).toMatch(/\.pdf$/);
  });

  it('leaves ordinary names untouched', () => {
    expect(asciiDisplayName('CR18881125/azure-tasks.md')).toBe('CR18881125/azure-tasks.md');
  });

  it('falls back to a typed placeholder when nothing ASCII survives', () => {
    expect(asciiDisplayName('تطبيق.pdf')).toBe('document.pdf');
    expect(asciiDisplayName('文件')).toBe('document');
  });

  it('never returns an over-long label', () => {
    expect(asciiDisplayName('a'.repeat(500)).length).toBeLessThanOrEqual(200);
  });
});

describe('uploadFile', () => {
  // The SDK sends the path's basename as X-Goog-Upload-File-Name, so an Arabic
  // filename failed the upload even with a clean displayName.
  it('uploads a non-ASCII-named file from an ASCII-named copy, then removes it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upl-'));
    const src = path.join(dir, 'اصدار كشف الراتب salary slip.pdf');
    fs.writeFileSync(src, 'pdf-bytes');
    let seen;
    const ai = { files: { upload: async ({ file }) => { seen = { file, body: fs.readFileSync(file, 'utf8') }; return { name: 'files/x' }; } } };

    await uploadFile(ai, src, { mimeType: 'application/pdf', displayName: 'x' });

    expect(path.basename(seen.file)).toMatch(/^[\x20-\x7E]+$/);
    expect(seen.body).toBe('pdf-bytes');
    expect(fs.existsSync(seen.file)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes an ASCII path straight through', async () => {
    let seen;
    const ai = { files: { upload: async ({ file }) => { seen = file; return {}; } } };
    await uploadFile(ai, 'D:/calls/seg_00.mp4', {});
    expect(seen).toBe('D:/calls/seg_00.mp4');
  });
});
