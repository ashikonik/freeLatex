import { describe, expect, it } from 'vitest';

import { pairDiff, parseDiff } from './diff-view.js';

/**
 * A patch as the server writes it.
 *
 * The server builds its patches with `createTwoFilesPatch`, which writes an
 * `Index:` line, a separator, the two file headers and then the hunks.
 */
const REAL_PATCH = [
  'Index: main.tex',
  '===================================================================',
  '--- main.tex',
  '+++ main.tex',
  '@@ -1,2 +1,2 @@',
  ' line one',
  '-line two',
  '+line two changed',
  '',
].join('\n');

describe('the reading of a unified diff', () => {
  it('finds nothing in an empty diff', () => {
    expect(parseDiff('')).toEqual([]);
  });

  it('reads the content of a patch the server wrote', () => {
    const lines = parseDiff(REAL_PATCH);

    expect(lines.map((line) => line.kind)).toEqual(['context', 'removed', 'added']);
    expect(lines.map((line) => line.text)).toEqual([
      'line one',
      'line two',
      'line two changed',
    ]);
  });

  it('leaves the structure of the patch out', () => {
    const lines = parseDiff(REAL_PATCH);

    expect(lines.some((line) => line.text.includes('Index:'))).toBe(false);
    expect(lines.some((line) => line.text.includes('==='))).toBe(false);
  });

  it('strips the marker from the line', () => {
    const lines = parseDiff('+added');

    expect(lines[0]?.text).toBe('added');
  });

  it('reads a context line whose content is empty', () => {
    const lines = parseDiff(' ');

    expect(lines).toHaveLength(1);
    expect(lines[0]?.kind).toBe('context');
    expect(lines[0]?.text).toBe('');
  });

  it('leaves out the marker of a missing newline', () => {
    const lines = parseDiff('+added\n\\ No newline at end of file');

    expect(lines).toHaveLength(1);
    expect(lines[0]?.kind).toBe('added');
  });

  it('reads the hunks of a patch that has more than one', () => {
    const patch = [
      'Index: main.tex',
      '--- main.tex',
      '+++ main.tex',
      '@@ -1,1 +1,1 @@',
      '-first',
      '+first changed',
      '@@ -10,1 +10,1 @@',
      '-later',
      '+later changed',
    ].join('\n');

    const lines = parseDiff(patch);

    expect(lines.map((line) => line.kind)).toEqual([
      'removed',
      'added',
      'removed',
      'added',
    ]);
  });
});

describe('the two sides of a diff', () => {
  it('puts a context line on both sides', () => {
    const sides = pairDiff(parseDiff(' kept'));

    expect(sides.left).toHaveLength(1);
    expect(sides.right).toHaveLength(1);
    expect(sides.left[0]?.kind).toBe('context');
    expect(sides.right[0]?.kind).toBe('context');
  });

  it('puts a changed line and its replacement on the same row', () => {
    const sides = pairDiff(parseDiff('-old\n+new'));

    expect(sides.left).toHaveLength(1);
    expect(sides.right).toHaveLength(1);
    expect(sides.left[0]?.text).toBe('old');
    expect(sides.right[0]?.text).toBe('new');
  });

  it('pairs the lines of a longer change one by one', () => {
    const sides = pairDiff(parseDiff('-one\n-two\n+new one\n+new two'));

    expect(sides.left.map((line) => line?.text)).toEqual(['one', 'two']);
    expect(sides.right.map((line) => line?.text)).toEqual(['new one', 'new two']);
  });

  it('leaves a gap when one side of the change is longer', () => {
    const sides = pairDiff(parseDiff('-one\n-two\n+new one'));

    expect(sides.left.map((line) => line?.text)).toEqual(['one', 'two']);
    expect(sides.right.map((line) => line?.text)).toEqual(['new one', undefined]);
  });

  it('keeps the sides the same length', () => {
    const sides = pairDiff(parseDiff(' one\n-old\n+new\n two'));

    expect(sides.left).toHaveLength(sides.right.length);
  });

  it('keeps the sides the same length for a patch the server wrote', () => {
    const sides = pairDiff(parseDiff(REAL_PATCH));

    expect(sides.left).toHaveLength(sides.right.length);
    expect(sides.left[0]?.text).toBe('line one');
    expect(sides.left[1]?.text).toBe('line two');
    expect(sides.right[1]?.text).toBe('line two changed');
  });

  it('leaves the headers out of both sides', () => {
    const sides = pairDiff(parseDiff('--- a/main.tex\n+++ b/main.tex\n+added'));

    expect(sides.left).toHaveLength(1);
    expect(sides.right).toHaveLength(1);
  });
});
