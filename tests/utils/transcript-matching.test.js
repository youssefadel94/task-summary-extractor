'use strict';

const { matchTranscriptToMedia, partitionTranscripts, nameTokens } = require('../../src/utils/context-manager');

const vtt = fileName => ({ type: 'inlineText', fileName, content: 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nhello' });

describe('matchTranscriptToMedia', () => {
  // The real folder that exposed the bug: four recordings, one transcript.
  const MEDIA = [
    'D:/calls/x/Call with Huda Ibrahim-20260728_113242-Meeting Recording.mp4',
    'D:/calls/x/Recording-20260728_173815.webm',
    'D:/calls/x/Recording-20260728_175919.webm',
    'D:/calls/x/Recording0.webm',
  ];
  const TRANSCRIPTS = [vtt('Call with Huda Ibrahim.vtt')];

  it('matches a transcript to the recording it names', () => {
    expect(matchTranscriptToMedia(MEDIA[0], TRANSCRIPTS, MEDIA)).toBe(TRANSCRIPTS[0]);
  });

  it('does not attach one recording\'s transcript to another', () => {
    // Regression: the first VTT in context was sliced by every video's segment
    // timestamps, so three recordings were analyzed against a transcript of a
    // meeting they had nothing to do with.
    for (const other of MEDIA.slice(1)) {
      expect(matchTranscriptToMedia(other, TRANSCRIPTS, MEDIA)).toBeNull();
    }
  });

  it('pairs a lone transcript with a lone recording whatever they are called', () => {
    const media = ['D:/calls/y/zoom_0.mp4'];
    const t = [vtt('transcript-final.vtt')];
    expect(matchTranscriptToMedia(media[0], t, media)).toBe(t[0]);
  });

  it('requires more than one shared word to claim a match', () => {
    const media = ['D:/calls/z/Standup Alpha.mp4', 'D:/calls/z/Standup Beta.mp4'];
    // "Standup" alone is shared with both — too weak to pick either.
    expect(matchTranscriptToMedia(media[0], [vtt('Standup.vtt')], media)).toBeNull();
    // With the distinguishing word present, it resolves.
    expect(matchTranscriptToMedia(media[0], [vtt('Standup Alpha.vtt')], media)).not.toBeNull();
  });

  it('ignores export timestamps and generic words when comparing names', () => {
    expect([...nameTokens('Call with Huda Ibrahim-20260728_113242-Meeting Recording.mp4')].sort())
      .toEqual(['call', 'huda', 'ibrahim']);
  });
});

describe('partitionTranscripts', () => {
  const MEDIA = ['/c/Call with Huda Ibrahim-20260728.mp4', '/c/Recording0.webm'];
  const docs = [
    vtt('Call with Huda Ibrahim.vtt'),
    { type: 'inlineText', fileName: 'notes.md', content: 'reference' },
  ];

  it('keeps the matching transcript and all non-transcript docs', () => {
    const r = partitionTranscripts(MEDIA[0], docs, MEDIA);
    expect(r.transcript).toBe(docs[0]);
    expect(r.dropped).toHaveLength(0);
    expect(r.docs).toHaveLength(2);
  });

  it('drops another recording\'s transcript from the context entirely', () => {
    const r = partitionTranscripts(MEDIA[1], docs, MEDIA);
    expect(r.transcript).toBeNull();
    expect(r.dropped).toEqual([docs[0]]);
    expect(r.docs.map(d => d.fileName)).toEqual(['notes.md']);
  });

  it('keeps an unclaimed transcript available as context', () => {
    // No recording matches "kickoff.vtt", so it is general reference material
    // rather than a mismatched transcript.
    const stray = vtt('kickoff.vtt');
    const r = partitionTranscripts(MEDIA[1], [...docs, stray], MEDIA);
    expect(r.docs).toContain(stray);
    expect(r.dropped).toEqual([docs[0]]);
  });

  it('is a no-op when there are no transcripts at all', () => {
    const only = [{ type: 'inlineText', fileName: 'notes.md', content: 'x' }];
    const r = partitionTranscripts(MEDIA[0], only, MEDIA);
    expect(r.transcript).toBeNull();
    expect(r.docs).toBe(only);
  });
});
