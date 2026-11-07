import { describe, expect, it } from 'vitest';

import { extractErrors } from './log-errors.js';

describe('the errors of a TeX log', () => {
  it('finds nothing in a log without errors', () => {
    expect(extractErrors('This is XeTeX, Version 3.141592653\nOutput written on main.pdf')).toEqual(
      [],
    );
  });

  it('finds the message of an error', () => {
    const errors = extractErrors('! Undefined control sequence.\nl.42 \\foo\n');

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('! Undefined control sequence.');
  });

  it('keeps the line the error happened on', () => {
    const errors = extractErrors('! Undefined control sequence.\nl.42 \\foo\n');

    // The line number is the part that tells the reader where to look.
    expect(errors[0]).toContain('l.42');
  });

  it('finds every error in a log', () => {
    const errors = extractErrors(
      ['! Undefined control sequence.', 'l.42 \\foo', '', '! Missing $ inserted.', 'l.17 x'].join(
        '\n',
      ),
    );

    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('Undefined control sequence');
    expect(errors[1]).toContain('Missing $ inserted');
  });

  it('does not report the same error twice', () => {
    const errors = extractErrors(
      ['! Undefined control sequence.', 'l.42 \\foo', '', '! Undefined control sequence.'].join('\n'),
    );

    expect(errors).toHaveLength(2);
  });

  it('keeps the context of an error', () => {
    const errors = extractErrors(
      ['! Missing $ inserted.', '<inserted text>', '                ', 'l.17 x'].join('\n'),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('<inserted text>');
    expect(errors[0]).toContain('l.17');
  });
});
