import { describe, expect, it } from 'vitest';
import { htmlTitle, shortTitle } from './html-title';

describe('htmlTitle', () => {
  it('reads and cleans the title', () => {
    expect(htmlTitle('<html><head><title>  Sales &amp; Usage\n Report </title></head></html>'))
      .toBe('Sales & Usage Report');
  });

  it('handles title attributes and mixed casing', () => {
    expect(htmlTitle('<TITLE data-page="report">Quarterly results</TITLE>'))
      .toBe('Quarterly results');
  });

  it('returns null when the title is missing or blank', () => {
    expect(htmlTitle('<h1>No title</h1>')).toBeNull();
    expect(htmlTitle('<title>   </title>')).toBeNull();
  });
});

describe('shortTitle', () => {
  it('leaves short titles alone and truncates long ones', () => {
    expect(shortTitle('Short title')).toBe('Short title');
    expect(shortTitle('A very long document title', 12)).toBe('A very long…');
  });
});
