import { expect, test } from 'bun:test';
import { config } from '../src/config';
import { sourceBody, sourceMetadata } from '../src/sources';

test('ordinary Markdown retains its title and text without an index-specific wrapper', () => {
  const markdown = '# My talk\n\nIdeas from my own notes.';
  expect(sourceBody(markdown)).toBe(markdown);
  expect(sourceMetadata(markdown)).toEqual({});
});

test('generic provenance removes only the wrapper and preserves the document heading', () => {
  const previous = config.sources.metadataMarker;
  config.sources.metadataMarker = 'source-metadata';
  try {
    const raw = '# talk.md\nПоисковая копия документа.\n<!-- source-metadata {"source":"repo://owner/materials/talk.md","repository":"materials"} -->\n\n# My talk\n\nIdeas';
    expect(sourceMetadata(raw)).toEqual({ source: 'repo://owner/materials/talk.md', repository: 'materials' });
    expect(sourceBody(raw)).toBe('# My talk\n\nIdeas');
    expect(sourceMetadata('<!-- source-metadata {broken} -->')).toEqual({});
    expect(sourceMetadata('<!-- source-metadata {"source":{},"repository":42} -->')).toEqual({});
  } finally { config.sources.metadataMarker = previous; }
});

test('another installation can configure its own literal metadata marker', () => {
  const previous = config.sources.metadataMarker;
  config.sources.metadataMarker = 'custom.marker+';
  try {
    const raw = '# talk.md\n<!-- custom.marker+ {"source":"repo://speaker/notes/talk.md"} -->\n\n# My talk';
    expect(sourceMetadata(raw).source).toBe('repo://speaker/notes/talk.md');
    expect(sourceBody(raw)).toBe('# My talk');
    expect(sourceMetadata('<!-- customXmarker {"source":"wrong"} -->')).toEqual({});
  } finally { config.sources.metadataMarker = previous; }
});
