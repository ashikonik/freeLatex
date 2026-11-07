import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { compileProject, resolveTectonicBinary } from './compiler.js';
import { SyncTexEngine, SyncTexError } from './synctex.js';

/**
 * The timeout for a test that runs the compiler.
 *
 * A first run of tectonic initialises its format bundle, which is far slower
 * than the runs that follow, so the compilation needs more than the default
 * five-second budget.
 */
const COMPILE_TEST_TIMEOUT = 60_000;

const DOCUMENT = `\\documentclass{article}
\\begin{document}
\\section{First}
Alpha beta gamma.
\\section{Second}
Delta epsilon.
\\end{document}
`;

/**
 * A document whose body text follows a section heading.
 *
 * The compiler records such a line as a single glyph box with no width, and
 * the box that carries the width starts at the left margin rather than at
 * the text. This is the shape that a naive width lookup misses.
 */
const DOCUMENT_WITH_BODY = `\\documentclass{article}
\\begin{document}
Hi
\\section{Probe}
Probe body
\\end{document}
`;

/**
 * The SyncTeX data of a real compilation.
 *
 * Building it once in `beforeAll` keeps the tests fast: the fixture is
 * compiled a single time and every test reads the same bytes.
 */
let synctexData: Buffer | undefined;

/** The SyncTeX data of the document with body text after a heading. */
let bodySynctexData: Buffer | undefined;

beforeAll(async () => {
  if ((await resolveTectonicBinary()) === undefined) {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'freelatex-synctex-'));
  try {
    await writeFile(join(dir, 'main.tex'), DOCUMENT, 'utf8');
    const result = await compileProject({
      projectDir: dir,
      mainFile: 'main.tex',
      timeoutMs: 60_000,
    });
    synctexData = result.synctex;

    await writeFile(join(dir, 'main.tex'), DOCUMENT_WITH_BODY, 'utf8');
    const bodyResult = await compileProject({
      projectDir: dir,
      mainFile: 'main.tex',
      timeoutMs: 60_000,
    });
    bodySynctexData = bodyResult.synctex;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, COMPILE_TEST_TIMEOUT);

afterAll(() => {
  synctexData = undefined;
  bodySynctexData = undefined;
});

describe('SyncTexEngine', () => {
  it('raises a typed error for data that is not gzip', () => {
    expect(() => new SyncTexEngine(Buffer.from('not gzip'))).toThrow(SyncTexError);
  });

  it('raises a typed error for gzip that is not SyncTeX', () => {
    // A gzip stream of plain text decompresses but does not parse.
    const bogus = gzipSync(Buffer.from('this is not synctex'));
    expect(() => new SyncTexEngine(bogus)).toThrow(SyncTexError);
  });

  it('reports the page count of a compiled document', () => {
    if (!synctexData) {
      return;
    }
    const engine = new SyncTexEngine(synctexData);

    expect(engine.pageCount).toBeGreaterThanOrEqual(1);
  });

  it('records the source files of the document', () => {
    if (!synctexData) {
      return;
    }
    const engine = new SyncTexEngine(synctexData);

    expect(engine.fileNames.some((name) => name.endsWith('main.tex'))).toBe(true);
  });

  it('finds the position of a source line', () => {
    if (!synctexData) {
      return;
    }
    const engine = new SyncTexEngine(synctexData);

    // The first line of the body is line 4 of the file.
    const file = engine.fileNames.find((name) => name.endsWith('main.tex'));
    expect(file).toBeDefined();
    if (!file) {
      return;
    }

    const result = engine.forwardSearch(file, 4);
    expect(result).toBeDefined();
    expect(result?.source.file).toBe(file);
    expect(result?.source.line).toBe(4);
    expect(result?.position.page).toBeGreaterThanOrEqual(1);
    // The box lies within the page.
    expect(result?.position.x).toBeGreaterThanOrEqual(0);
    expect(result?.position.y).toBeGreaterThanOrEqual(0);
  });

  it('finds every line the compiler recorded', () => {
    if (!synctexData) {
      return;
    }
    const engine = new SyncTexEngine(synctexData);

    // The document has content on lines 3 to 6. A forward search must find
    // every one of them: a line that is missing would make the editor's
    // forward jump silently fail.
    for (const line of [3, 4, 5, 6]) {
      expect(engine.forwardSearch('main.tex', line)).toBeDefined();
    }
  });

  it('gives a forward-searched position a usable width', () => {
    if (!synctexData) {
      return;
    }
    const engine = new SyncTexEngine(synctexData);

    // The compiler records a glyph box with no width; the engine has to
    // resolve it, or the position cannot be used to scroll the viewer.
    const result = engine.forwardSearch('main.tex', 3);
    expect(result?.position.width).toBeGreaterThan(0);
  });

  it('gives body text after a heading a usable width', () => {
    if (!bodySynctexData) {
      return;
    }
    const engine = new SyncTexEngine(bodySynctexData);

    // Line 5 is the body text under the heading. The compiler records it as
    // a lone glyph box whose width has to be borrowed from the box that
    // describes the extent of that line.
    const result = engine.forwardSearch('main.tex', 5);
    expect(result).toBeDefined();
    expect(result?.position.width).toBeGreaterThan(0);
    expect(result?.position.height).toBeGreaterThan(0);
  });

  it('round-trips every line of a document with body text', () => {
    if (!bodySynctexData) {
      return;
    }
    const engine = new SyncTexEngine(bodySynctexData);

    for (const line of [3, 4, 5]) {
      const forward = engine.forwardSearch('main.tex', line);
      expect(forward).toBeDefined();
      if (!forward) {
        return;
      }

      const inverse = engine.inverseSearch(
        forward.position.x + forward.position.width / 2,
        forward.position.y + forward.position.height / 2,
        forward.position.page,
      );

      expect(inverse).toBeDefined();
      expect(inverse?.source.line).toBe(line);
    }
  });

  it('returns nothing for a line that produced no output', () => {
    if (!synctexData) {
      return;
    }
    const engine = new SyncTexEngine(synctexData);

    // Line 999 is past the end of the document.
    const file = engine.fileNames.find((name) => name.endsWith('main.tex'));
    expect(file).toBeDefined();
    if (!file) {
      return;
    }

    expect(engine.forwardSearch(file, 999)).toBeUndefined();
  });

  it('returns nothing for a file the compiler never saw', () => {
    if (!synctexData) {
      return;
    }
    const engine = new SyncTexEngine(synctexData);

    expect(engine.forwardSearch('not-a-real-file.tex', 1)).toBeUndefined();
  });

  it('finds the source line behind a point on the page', () => {
    if (!synctexData) {
      return;
    }
    const engine = new SyncTexEngine(synctexData);

    // Forward-search a known line, then inverse-search the same point. The
    // two directions have to agree, or the editor and the viewer would
    // disagree about where a line lives.
    const file = engine.fileNames.find((name) => name.endsWith('main.tex'));
    expect(file).toBeDefined();
    if (!file) {
      return;
    }

    for (const line of [3, 4, 5, 6]) {
      const forward = engine.forwardSearch(file, line);
      expect(forward).toBeDefined();
      if (!forward) {
        return;
      }

      // A point just inside the box's lower-left corner must hit that box.
      const inverse = engine.inverseSearch(
        forward.position.x + 0.5,
        forward.position.y + 0.5,
        forward.position.page,
      );

      expect(inverse).toBeDefined();
      expect(inverse?.source.line).toBe(line);
      expect(inverse?.source.file).toBe(file);
    }
  });

  it('returns nothing for a point outside the page content', () => {
    if (!synctexData) {
      return;
    }
    const engine = new SyncTexEngine(synctexData);

    // The very bottom-left corner is outside every text box.
    expect(engine.inverseSearch(1, 1, 1)).toBeUndefined();
  });

  it('returns nothing for a page that does not exist', () => {
    if (!synctexData) {
      return;
    }
    const engine = new SyncTexEngine(synctexData);

    expect(engine.inverseSearch(100, 100, 999)).toBeUndefined();
  });
});
