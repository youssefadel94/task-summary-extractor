'use strict';

const { dedupeFormatTwins } = require('../../src/utils/fs');

const doc = relPath => ({ absPath: `/calls/x/${relPath}`, relPath });

describe('dedupeFormatTwins', () => {
  it('keeps the markdown and drops its html/pdf twins', () => {
    // Real case: one export folder shipped .md + .html + .pdf of every doc,
    // tripling context tokens for identical words.
    const { kept, dropped } = dedupeFormatTwins([
      doc('exports/db-handoff.md'),
      doc('exports/db-handoff.html'),
      doc('exports/db-handoff.pdf'),
    ]);

    expect(kept.map(d => d.relPath)).toEqual(['exports/db-handoff.md']);
    expect(dropped.map(d => d.relPath).sort()).toEqual(['exports/db-handoff.html', 'exports/db-handoff.pdf']);
    expect(dropped[0].supersededBy).toBe('exports/db-handoff.md');
  });

  it('falls back to html when no markdown exists', () => {
    const { kept } = dedupeFormatTwins([doc('parts/00-overview.pdf'), doc('parts/00-overview.html')]);
    expect(kept.map(d => d.relPath)).toEqual(['parts/00-overview.html']);
  });

  it('never drops formats that may carry unique structure', () => {
    // .csv/.json/.vtt are not re-renderings of the prose doc — a spreadsheet
    // export can hold columns the markdown write-up omits.
    const { kept, dropped } = dedupeFormatTwins([doc('azure-tasks.md'), doc('azure-tasks.csv')]);
    expect(kept.map(d => d.relPath).sort()).toEqual(['azure-tasks.csv', 'azure-tasks.md']);
    expect(dropped).toHaveLength(0);
  });

  it('does not merge same-named files in different folders', () => {
    const { kept, dropped } = dedupeFormatTwins([doc('database.md'), doc('exports/database.pdf')]);
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(0);
  });

  it('preserves order and leaves unique documents alone', () => {
    const input = [doc('a.md'), doc('b.txt'), doc('c.pdf')];
    const { kept, dropped } = dedupeFormatTwins(input);
    expect(kept.map(d => d.relPath)).toEqual(['a.md', 'b.txt', 'c.pdf']);
    expect(dropped).toHaveLength(0);
  });
});
