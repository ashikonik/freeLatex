import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';

import { latex, LATEX_KEYWORDS } from './latex.js';

/**
 * The name of the token that covers a piece of text.
 *
 * The syntax tree is the only way to see how the grammar classified a run of
 * characters, so the tests read it rather than the editor's rendering. The
 * tree is completed first, because a lazily parsed tree may not have reached
 * the interesting part yet.
 */
function tokenAt(code: string, needle: string): string | undefined {
  const state = EditorState.create({
    doc: code,
    extensions: [latex()],
  });
  const tree = ensureSyntaxTree(state, code.length, 5_000);
  if (!tree) {
    return undefined;
  }

  let found: string | undefined;
  tree.iterate({
    enter(node) {
      if (found !== undefined) {
        return;
      }
      // The root node spans the whole document, so it would match every
      // needle; only the leaves say how a piece of text was classified.
      if (node.name === 'Document') {
        return;
      }
      const text = state.doc.sliceString(node.from, node.to);
      if (text.includes(needle)) {
        found = node.name;
      }
    },
  });
  return found;
}

describe('the LaTeX grammar', () => {
  it('marks a known command as a keyword', () => {
    expect(tokenAt('\\section{Intro}', '\\section')).toBe('keyword');
  });

  it('marks an unknown command as a macro name', () => {
    expect(tokenAt('\\mycustommacro{x}', '\\mycustommacro')).toBe('macroName');
  });

  it('marks a comment as a comment', () => {
    expect(tokenAt('Hello % a note', '% a note')).toBe('comment');
  });

  it('marks braces as brackets', () => {
    expect(tokenAt('{grouped}', '{')).toBe('bracket');
  });

  it('marks a math delimiter as a special token', () => {
    expect(tokenAt('$x$', '$')).toBe('dollar');
  });

  it('keeps ordinary text unstyled', () => {
    // The text between the commands carries no token of its own.
    expect(tokenAt('plain words', 'plain words')).toBeUndefined();
  });

  it('treats an escaped percent sign as text', () => {
    // A comment is a percent sign that starts a line comment; an escaped
    // one is not.
    expect(tokenAt('100\\% sure', '\\%')).toBe('macroName');
  });

  it('knows the common commands', () => {
    expect(LATEX_KEYWORDS.has('documentclass')).toBe(true);
    expect(LATEX_KEYWORDS.has('begin')).toBe(true);
    expect(LATEX_KEYWORDS.has('frac')).toBe(true);
    expect(LATEX_KEYWORDS.has('notacommand')).toBe(false);
  });
});
