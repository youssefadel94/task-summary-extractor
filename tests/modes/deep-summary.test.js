const {
  buildBatches,
  deepSummarize,
  summarizeBatch,
  isTranscriptFile,
  TRANSCRIPT_EXTENSIONS,
  BATCH_MAX_CHARS,
  MIN_SUMMARIZE_LENGTH,
} = require('../../src/modes/deep-summary');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoc(name, contentLength = 1000) {
  return {
    type: 'inlineText',
    fileName: name,
    content: 'x'.repeat(contentLength),
  };
}

function makeFileDataDoc(name) {
  return {
    type: 'fileData',
    fileName: name,
    mimeType: 'application/pdf',
    fileUri: 'gs://bucket/file.pdf',
  };
}

function makeHybridDoc(name, contentLength = 2000) {
  return {
    type: 'fileData',
    fileName: name,
    mimeType: 'application/pdf',
    fileUri: 'gs://bucket/file.pdf',
    geminiFileName: 'files/abc123',
    content: 'y'.repeat(contentLength),
  };
}

/** Create a mock AI whose generateContent resolves with a JSON summary */
function makeMockAi(responseFn) {
  return {
    models: {
      generateContent: vi.fn(async (req) => {
        if (responseFn) return responseFn(req);
        return {
          text: JSON.stringify({
            summaries: {},
            metadata: { originalTokensEstimate: 0, summaryTokensEstimate: 0, compressionRatio: 1 },
          }),
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
        };
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// buildBatches tests
// ---------------------------------------------------------------------------

describe('buildBatches', () => {
  it('puts all small docs in one batch when under limit', () => {
    const docs = [makeDoc('a.md', 100), makeDoc('b.md', 200), makeDoc('c.md', 300)];
    const batches = buildBatches(docs, 1000);
    expect(batches.length).toBe(1);
    expect(batches[0].length).toBe(3);
  });

  it('splits docs across batches when they exceed the char limit', () => {
    const docs = [
      makeDoc('a.md', 600),
      makeDoc('b.md', 600),
      makeDoc('c.md', 600),
    ];
    const batches = buildBatches(docs, 1000);
    expect(batches.length).toBe(3);
    batches.forEach(b => expect(b.length).toBe(1));
  });

  it('puts an oversized doc in its own batch', () => {
    const docs = [
      makeDoc('small.md', 100),
      makeDoc('huge.md', 5000),
      makeDoc('another.md', 200),
    ];
    const batches = buildBatches(docs, 1000);
    // small + another could fit → 1 batch, huge → separate
    expect(batches.length).toBeGreaterThanOrEqual(2);
    const hugeBatch = batches.find(b => b.some(d => d.fileName === 'huge.md'));
    expect(hugeBatch.length).toBe(1);
  });

  it('returns empty array for empty input', () => {
    expect(buildBatches([])).toEqual([]);
  });

  it('handles single doc', () => {
    const batches = buildBatches([makeDoc('sole.md', 500)], 1000);
    expect(batches.length).toBe(1);
    expect(batches[0].length).toBe(1);
  });

  it('skips docs with zero content length', () => {
    const docs = [makeDoc('empty.md', 0), makeDoc('ok.md', 100)];
    const batches = buildBatches(docs, 1000);
    expect(batches.length).toBe(1);
    expect(batches[0].length).toBe(1); // empty doc is skipped
    expect(batches[0][0].fileName).toBe('ok.md');
  });

  it('groups adjacent docs until limit, then starts new batch', () => {
    const docs = [
      makeDoc('d1.md', 400),
      makeDoc('d2.md', 400),
      makeDoc('d3.md', 400), // first two fill 800, d3 starts new batch at limit=800
    ];
    const batches = buildBatches(docs, 800);
    expect(batches.length).toBe(2);
    expect(batches[0].length).toBe(2);
    expect(batches[1].length).toBe(1);
  });

  it('uses default BATCH_MAX_CHARS when no maxChars given', () => {
    // Small docs should all fit in one batch with the default 600K limit
    const docs = [makeDoc('a.md', 1000), makeDoc('b.md', 2000)];
    const batches = buildBatches(docs);
    expect(batches.length).toBe(1);
    expect(batches[0].length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// summarizeBatch tests (isolated with mock AI)
// ---------------------------------------------------------------------------

describe('summarizeBatch', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns null when batch has no docs with content', async () => {
    const ai = makeMockAi();
    const result = await summarizeBatch(ai, [makeFileDataDoc('a.pdf')]);
    expect(result).toBeNull();
    expect(ai.models.generateContent).not.toHaveBeenCalled();
  });

  it('summarizes hybrid fileData docs that have content', async () => {
    const ai = makeMockAi(() => ({
      text: JSON.stringify({
        summaries: { 'report.pdf': 'PDF summary' },
        metadata: { compressionRatio: 0.4 },
      }),
      usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 60, totalTokenCount: 360 },
    }));

    const result = await summarizeBatch(ai, [makeHybridDoc('report.pdf', 2000)]);
    expect(result).not.toBeNull();
    expect(result.summaries['report.pdf']).toBe('PDF summary');
    expect(ai.models.generateContent).toHaveBeenCalledTimes(1);
  });

  it('returns summaries and token usage from a successful call', async () => {
    const ai = makeMockAi(() => ({
      text: JSON.stringify({
        summaries: { 'doc.md': 'Condensed content' },
        metadata: { compressionRatio: 0.3 },
      }),
      usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 80, totalTokenCount: 580 },
    }));

    const result = await summarizeBatch(ai, [makeDoc('doc.md', 2000)]);
    expect(result).not.toBeNull();
    expect(result.summaries['doc.md']).toBe('Condensed content');
    expect(result.tokenUsage.inputTokens).toBe(500);
    expect(result.tokenUsage.outputTokens).toBe(80);
  });

  it('returns null on API error (does not throw)', async () => {
    const ai = makeMockAi(() => { throw new Error('rate limit'); });
    const result = await summarizeBatch(ai, [makeDoc('fail.md', 2000)]);
    expect(result).toBeNull();
  });

  it('returns null when response text is not valid JSON', async () => {
    const ai = makeMockAi(() => ({
      text: 'This is not JSON at all',
      usageMetadata: {},
    }));
    const result = await summarizeBatch(ai, [makeDoc('bad.md', 2000)]);
    expect(result).toBeNull();
  });

  it('injects focus topics into the prompt', async () => {
    const ai = makeMockAi(() => ({
      text: JSON.stringify({ summaries: { 'x.md': 'ok' }, metadata: {} }),
      usageMetadata: {},
    }));

    await summarizeBatch(ai, [makeDoc('x.md', 2000)], {
      focusTopics: ['sprint-board.md', 'blockers.md'],
    });

    const call = ai.models.generateContent.mock.calls[0][0];
    const prompt = call.contents[0].parts[0].text;
    expect(prompt).toContain('sprint-board.md');
    expect(prompt).toContain('blockers.md');
    expect(prompt).toContain('FOCUS AREAS');
  });
});

// ---------------------------------------------------------------------------
// deepSummarize integration tests (with mock AI)
// ---------------------------------------------------------------------------

describe('deepSummarize', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns original docs untouched when none are eligible for summarization', async () => {
    const ai = makeMockAi();
    const docs = [
      makeDoc('tiny.md', 100),  // Below MIN_SUMMARIZE_LENGTH
      makeFileDataDoc('report.pdf'),  // Non-inlineText
    ];
    const result = await deepSummarize(ai, docs, { excludeFileNames: [] });
    expect(result.stats.summarized).toBe(0);
    expect(result.stats.keptFull).toBe(2);
    expect(result.docs.length).toBe(2);
    expect(ai.models.generateContent).not.toHaveBeenCalled();
  });

  it('excludes specified docs from summarization', async () => {
    const ai = makeMockAi(() => ({
      text: JSON.stringify({
        summaries: { 'summarize-me.md': 'Short summary' },
        metadata: {},
      }),
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
    }));

    const docs = [
      makeDoc('keep-me.md', 2000),
      makeDoc('summarize-me.md', 2000),
    ];

    const result = await deepSummarize(ai, docs, {
      excludeFileNames: ['keep-me.md'],
    });

    // keep-me.md should retain its original content
    const keptDoc = result.docs.find(d => d.fileName === 'keep-me.md');
    expect(keptDoc.content).toBe('x'.repeat(2000));
    expect(keptDoc._deepSummarized).toBeUndefined();

    // summarize-me.md should have been replaced
    const sumDoc = result.docs.find(d => d.fileName === 'summarize-me.md');
    expect(sumDoc._deepSummarized).toBe(true);
    expect(sumDoc.content).toContain('Short summary');
    expect(sumDoc.content).toContain('[Deep Summary');

    expect(result.stats.keptFull).toBe(1);
    expect(result.stats.summarized).toBe(1);
  });

  it('keeps fileData docs without content as-is (binary only)', async () => {
    const ai = makeMockAi(() => ({
      text: JSON.stringify({
        summaries: { 'normal.md': 'Condensed' },
        metadata: {},
      }),
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, totalTokenCount: 70 },
    }));

    const docs = [
      makeFileDataDoc('report.pdf'),
      makeDoc('normal.md', 2000),
    ];

    const result = await deepSummarize(ai, docs, { excludeFileNames: [] });

    const pdfDoc = result.docs.find(d => d.fileName === 'report.pdf');
    expect(pdfDoc.type).toBe('fileData');
    expect(pdfDoc._deepSummarized).toBeUndefined();
  });

  it('summarizes hybrid fileData docs (PDF with extracted text)', async () => {
    const ai = makeMockAi(() => ({
      text: JSON.stringify({
        summaries: { 'report.pdf': 'PDF summary content' },
        metadata: {},
      }),
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
    }));

    const docs = [makeHybridDoc('report.pdf', 3000)];
    const result = await deepSummarize(ai, docs, { excludeFileNames: [] });

    const pdfDoc = result.docs.find(d => d.fileName === 'report.pdf');
    expect(pdfDoc._deepSummarized).toBe(true);
    expect(pdfDoc.type).toBe('inlineText');
    expect(pdfDoc.content).toContain('PDF summary content');
    // fileData properties should be removed after summarization
    expect(pdfDoc.fileUri).toBeUndefined();
    expect(pdfDoc.mimeType).toBeUndefined();
    expect(pdfDoc.geminiFileName).toBeUndefined();
    expect(result.stats.summarized).toBe(1);
  });

  it('keeps hybrid fileData docs full when excluded', async () => {
    const ai = makeMockAi();
    const docs = [makeHybridDoc('report.pdf', 3000)];
    const result = await deepSummarize(ai, docs, { excludeFileNames: ['report.pdf'] });

    const pdfDoc = result.docs.find(d => d.fileName === 'report.pdf');
    expect(pdfDoc.type).toBe('fileData');
    expect(pdfDoc.content).toBe('y'.repeat(3000));
    expect(pdfDoc._deepSummarized).toBeUndefined();
    expect(result.stats.keptFull).toBe(1);
  });

  it('includes hybrid docs in summarization batch alongside inlineText', async () => {
    const ai = makeMockAi(() => ({
      text: JSON.stringify({
        summaries: {
          'report.pdf': 'PDF condensed',
          'notes.md': 'MD condensed',
        },
        metadata: {},
      }),
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 80, totalTokenCount: 280 },
    }));

    const docs = [
      makeHybridDoc('report.pdf', 2000),
      makeDoc('notes.md', 2000),
    ];

    const result = await deepSummarize(ai, docs, { excludeFileNames: [] });

    expect(result.stats.summarized).toBe(2);
    const pdfDoc = result.docs.find(d => d.fileName === 'report.pdf');
    expect(pdfDoc._deepSummarized).toBe(true);
    expect(pdfDoc.type).toBe('inlineText');

    const mdDoc = result.docs.find(d => d.fileName === 'notes.md');
    expect(mdDoc._deepSummarized).toBe(true);
  });

  it('uses excluded hybrid fileData docs as focus topics', async () => {
    const ai = makeMockAi(() => ({
      text: JSON.stringify({ summaries: { 'other.md': 'Summary' }, metadata: {} }),
      usageMetadata: {},
    }));

    const docs = [
      makeHybridDoc('report.pdf', 3000),
      makeDoc('other.md', 2000),
    ];

    await deepSummarize(ai, docs, {
      excludeFileNames: ['report.pdf'],
    });

    expect(ai.models.generateContent).toHaveBeenCalledTimes(1);
    const prompt = ai.models.generateContent.mock.calls[0][0].contents[0].parts[0].text;
    expect(prompt).toContain('report.pdf');
    expect(prompt).toContain('FOCUS AREAS');
  });

  it('handles AI failure gracefully, returning original content', async () => {
    const ai = makeMockAi(() => { throw new Error('API error'); });
    const docs = [makeDoc('fail.md', 2000)];

    const result = await deepSummarize(ai, docs, { excludeFileNames: [] });

    // No summary was returned so doc keeps original content
    expect(result.docs.length).toBe(1);
    expect(result.docs[0].content).toBe('x'.repeat(2000));
    expect(result.docs[0]._deepSummarized).toBeUndefined();
    expect(result.stats.summarized).toBe(0);
  });

  it('splits a failed batch and retries sub-batches', async () => {
    let callCount = 0;
    const ai = makeMockAi(() => {
      callCount++;
      // First call (full batch) fails with unparseable response
      if (callCount === 1) {
        return { text: '', usageMetadata: { promptTokenCount: 9000, candidatesTokenCount: 0, thoughtsTokenCount: 6553 } };
      }
      // Sub-batch calls succeed
      return {
        text: JSON.stringify({
          summaries: callCount === 2
            ? { 'a.md': 'Summary A', 'b.md': 'Summary B' }
            : { 'c.md': 'Summary C', 'd.md': 'Summary D' },
          metadata: {},
        }),
        usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 50, totalTokenCount: 250 },
      };
    });

    const docs = [makeDoc('a.md', 2000), makeDoc('b.md', 2000), makeDoc('c.md', 2000), makeDoc('d.md', 2000)];
    const result = await deepSummarize(ai, docs, { excludeFileNames: [] });

    // 1 original call + 2 sub-batch retries = 3
    expect(ai.models.generateContent).toHaveBeenCalledTimes(3);
    // All 4 docs should be summarized via the sub-batches
    expect(result.stats.summarized).toBe(4);
    expect(result.docs.every(d => d._deepSummarized)).toBe(true);
  });

  it('does not split a single-doc batch that fails', async () => {
    const ai = makeMockAi(() => ({ text: '', usageMetadata: {} }));
    const docs = [makeDoc('lone.md', 2000)];

    const result = await deepSummarize(ai, docs, { excludeFileNames: [] });

    // Only 1 call — no split because batch has only 1 doc
    expect(ai.models.generateContent).toHaveBeenCalledTimes(1);
    expect(result.stats.summarized).toBe(0);
    // Doc should be returned with original content
    expect(result.docs[0]._deepSummarized).toBeUndefined();
    expect(result.docs[0].content).toBe('x'.repeat(2000));
  });

  it('returns correct token stats for successful summarization', async () => {
    const ai = makeMockAi(() => ({
      text: JSON.stringify({
        summaries: {
          'big.md': 'Big summary',
          'medium.md': 'Med summary',
        },
        metadata: {},
      }),
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 100, totalTokenCount: 300 },
    }));

    const docs = [
      makeDoc('big.md', 5000),
      makeDoc('medium.md', 3000),
    ];

    const result = await deepSummarize(ai, docs, { excludeFileNames: [] });

    expect(result.stats.summarized).toBe(2);
    expect(result.stats.savedTokens).toBeGreaterThan(0);
    expect(result.stats.savingsPercent).toBeGreaterThan(0);
    expect(result.stats.totalInputTokens).toBe(200);
    expect(result.stats.totalOutputTokens).toBe(100);
  });

  it('handles case-insensitive exclude matching', async () => {
    const ai = makeMockAi();
    const docs = [makeDoc('MyDoc.MD', 2000)];

    const result = await deepSummarize(ai, docs, {
      excludeFileNames: ['mydoc.md'],
    });

    expect(result.stats.keptFull).toBe(1);
    expect(result.stats.summarized).toBe(0);
    expect(ai.models.generateContent).not.toHaveBeenCalled();
  });

  it('passes focus topics from excluded docs to the AI prompt', async () => {
    const ai = makeMockAi(() => ({
      text: JSON.stringify({ summaries: { 'other.md': 'Summary' }, metadata: {} }),
      usageMetadata: {},
    }));

    const docs = [
      makeDoc('focus.md', 2000),
      makeDoc('other.md', 2000),
    ];

    await deepSummarize(ai, docs, {
      excludeFileNames: ['focus.md'],
    });

    // Verify AI was called and the prompt contains focus fileName
    expect(ai.models.generateContent).toHaveBeenCalledTimes(1);
    const call = ai.models.generateContent.mock.calls[0][0];
    const promptText = call.contents[0].parts[0].text;
    expect(promptText).toContain('focus.md');
  });

  it('preserves original token estimate in _originalLength', async () => {
    const ai = makeMockAi(() => ({
      text: JSON.stringify({ summaries: { 'doc.md': 'short' }, metadata: {} }),
      usageMetadata: {},
    }));

    const docs = [makeDoc('doc.md', 3000)];
    const result = await deepSummarize(ai, docs, { excludeFileNames: [] });

    const doc = result.docs[0];
    expect(doc._deepSummarized).toBe(true);
    expect(doc._originalLength).toBe(3000);
    expect(doc._summaryLength).toBe(5); // 'short'.length
  });

  it('calls onProgress callback for each batch', async () => {
    // Create enough docs that they require 2 batches at a low limit
    // Force small maxChars so it batches into multiple calls
    const ai = makeMockAi(() => ({
      text: JSON.stringify({ summaries: {}, metadata: {} }),
      usageMetadata: {},
    }));

    // Both docs are above MIN_SUMMARIZE_LENGTH so they go to summarization
    const docs = [makeDoc('a.md', 800), makeDoc('b.md', 800)];
    const progressCalls = [];

    await deepSummarize(ai, docs, {
      excludeFileNames: [],
      onProgress: (done, total) => progressCalls.push({ done, total }),
    });

    // At minimum, onProgress should have been called (1 batch)
    expect(progressCalls.length).toBeGreaterThanOrEqual(1);
    // Last call should have done === total
    const last = progressCalls[progressCalls.length - 1];
    expect(last.done).toBe(last.total);
  });

  it('auto-excludes VTT transcript files from summarization', async () => {
    const ai = makeMockAi(() => ({
      text: JSON.stringify({ summaries: { 'docs.md': 'Condensed' }, metadata: {} }),
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, totalTokenCount: 70 },
    }));

    const docs = [
      makeDoc('transcript.vtt', 5000),
      makeDoc('docs.md', 2000),
    ];

    const result = await deepSummarize(ai, docs, { excludeFileNames: [] });

    // VTT file should be kept full (not summarized)
    const vttDoc = result.docs.find(d => d.fileName === 'transcript.vtt');
    expect(vttDoc.content).toBe('x'.repeat(5000));
    expect(vttDoc._deepSummarized).toBeUndefined();

    // MD file should have been summarized
    const mdDoc = result.docs.find(d => d.fileName === 'docs.md');
    expect(mdDoc._deepSummarized).toBe(true);
  });

  it('auto-excludes SRT subtitle files from summarization', async () => {
    const ai = makeMockAi(() => ({
      text: JSON.stringify({ summaries: { 'notes.md': 'Condensed' }, metadata: {} }),
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, totalTokenCount: 70 },
    }));

    const docs = [
      makeDoc('subtitles.srt', 3000),
      makeDoc('notes.md', 2000),
    ];

    const result = await deepSummarize(ai, docs, { excludeFileNames: [] });

    // SRT file should be kept full
    const srtDoc = result.docs.find(d => d.fileName === 'subtitles.srt');
    expect(srtDoc.content).toBe('x'.repeat(3000));
    expect(srtDoc._deepSummarized).toBeUndefined();
  });

  it('does NOT include VTT/SRT files in focus topics', async () => {
    const ai = makeMockAi(() => ({
      text: JSON.stringify({ summaries: { 'other.md': 'Summary' }, metadata: {} }),
      usageMetadata: {},
    }));

    const docs = [
      makeDoc('call.vtt', 5000),
      makeDoc('other.md', 2000),
    ];

    await deepSummarize(ai, docs, { excludeFileNames: [] });

    // AI was called — prompt should NOT contain the VTT as a focus topic
    expect(ai.models.generateContent).toHaveBeenCalledTimes(1);
    const prompt = ai.models.generateContent.mock.calls[0][0].contents[0].parts[0].text;
    expect(prompt).not.toContain('call.vtt');
    expect(prompt).not.toContain('FOCUS AREAS');
  });
});

// ---------------------------------------------------------------------------
// isTranscriptFile utility tests
// ---------------------------------------------------------------------------

describe('isTranscriptFile', () => {
  it('recognises .vtt files', () => {
    expect(isTranscriptFile('meeting.vtt')).toBe(true);
    expect(isTranscriptFile('Call with Team.VTT')).toBe(true);
  });

  it('recognises .srt files', () => {
    expect(isTranscriptFile('subtitles.srt')).toBe(true);
    expect(isTranscriptFile('RECORDING.SRT')).toBe(true);
  });

  it('rejects non-transcript files', () => {
    expect(isTranscriptFile('readme.md')).toBe(false);
    expect(isTranscriptFile('report.pdf')).toBe(false);
    expect(isTranscriptFile('data.csv')).toBe(false);
    expect(isTranscriptFile('notes.txt')).toBe(false);
  });

  it('handles edge cases', () => {
    expect(isTranscriptFile('')).toBe(false);
    expect(isTranscriptFile(null)).toBe(false);
    expect(isTranscriptFile(undefined)).toBe(false);
  });

  it('exports TRANSCRIPT_EXTENSIONS array', () => {
    expect(TRANSCRIPT_EXTENSIONS).toContain('.vtt');
    expect(TRANSCRIPT_EXTENSIONS).toContain('.srt');
  });
});
