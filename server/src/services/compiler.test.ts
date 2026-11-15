import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BiberNotFoundError,
  CompilerNotFoundError,
  CompileTimeoutError,
  compileProject,
  needsBiber,
  parseBiberErrors,
  parseCompilerErrors,
  resolveBiberBinary,
  resolveTectonicBinary,
} from './compiler.js';

let workDir: string;

/**
 * True when tectonic is installed.
 *
 * The compilation tests need the real binary, so they are skipped rather
 * than failed when it is absent — a machine without LaTeX installed is a
 * legitimate environment, not a broken test run.
 */
async function tectonicAvailable(): Promise<boolean> {
  return (await resolveTectonicBinary()) !== undefined;
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'freelatex-compiler-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Write a LaTeX file into the scratch directory. */
async function writeTex(name: string, content: string): Promise<void> {
  await writeFile(join(workDir, name), content, 'utf8');
}

const VALID_DOCUMENT = `\\documentclass{article}
\\begin{document}
Hello, world.
\\end{document}
`;

const INVALID_DOCUMENT = `\\documentclass{article}
\\begin{document}
\\undefinedcommand
\\end{document}
`;

/**
 * The timeout for a test that runs the compiler.
 *
 * A first run of tectonic initialises its format bundle, which is far slower
 * than the runs that follow. The default five-second budget is not enough
 * for that, so the compilation tests are given room to finish.
 */
const COMPILE_TEST_TIMEOUT = 60_000;

describe('resolveTectonicBinary', () => {
  it('finds the tectonic binary on this machine', async () => {
    const binary = await resolveTectonicBinary();
    // The step is only meaningful with the compiler present.
    expect(binary).toBeDefined();
  });

  it('prefers an explicit override', async () => {
    const previous = process.env.TECTONIC_BINARY;
    process.env.TECTONIC_BINARY = '/usr/bin/tectonic';
    try {
      expect(await resolveTectonicBinary()).toBe('/usr/bin/tectonic');
    } finally {
      if (previous === undefined) {
        delete process.env.TECTONIC_BINARY;
      } else {
        process.env.TECTONIC_BINARY = previous;
      }
    }
  });
});

describe('parseCompilerErrors', () => {
  it('reads a tectonic summary line', () => {
    const errors = parseCompilerErrors('error: main.tex:3: Undefined control sequence');

    expect(errors).toHaveLength(1);
    expect(errors[0]?.severity).toBe('error');
    expect(errors[0]?.message).toBe('Undefined control sequence');
    expect(errors[0]?.file).toBe('main.tex');
    expect(errors[0]?.line).toBe(3);
  });

  it('reads the raw TeX error form', () => {
    const errors = parseCompilerErrors('! Undefined control sequence.');

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('Undefined control sequence');
  });

  it('reads a LaTeX warning with a line number', () => {
    const errors = parseCompilerErrors('LaTeX Warning: Reference `x` on page 1 undefined on input line 12.');

    expect(errors).toHaveLength(1);
    expect(errors[0]?.severity).toBe('warning');
    expect(errors[0]?.line).toBe(12);
  });

  it('ignores ordinary output', () => {
    const errors = parseCompilerErrors(
      'This is pdfTeX, Version 3.141592653-2.6-1.40.27 (TeX Live 2024)\n\n(./main.tex\n',
    );

    expect(errors).toEqual([]);
  });

  it('collects several diagnostics in order', () => {
    const errors = parseCompilerErrors(
      [
        'error: main.tex:3: Undefined control sequence',
        'LaTeX Warning: Citation `x` undefined on input line 5.',
      ].join('\n'),
    );

    expect(errors).toHaveLength(2);
    expect(errors[0]?.severity).toBe('error');
    expect(errors[1]?.severity).toBe('warning');
  });
});

describe('compileProject', () => {
  it('compiles a valid document into a PDF', async () => {
    if (!(await tectonicAvailable())) {
      return;
    }
    await writeTex('main.tex', VALID_DOCUMENT);

    const result = await compileProject({
      projectDir: workDir,
      mainFile: 'main.tex',
      timeoutMs: 60_000,
    });

    expect(result.success).toBe(true);
    expect(result.pdf).toBeDefined();
    // A PDF always starts with this header.
    expect(result.pdf?.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  }, COMPILE_TEST_TIMEOUT);

  it('produces SyncTeX data alongside the PDF', async () => {
    if (!(await tectonicAvailable())) {
      return;
    }
    await writeTex('main.tex', VALID_DOCUMENT);

    const result = await compileProject({
      projectDir: workDir,
      mainFile: 'main.tex',
      timeoutMs: 60_000,
    });

    expect(result.success).toBe(true);
    expect(result.synctex).toBeDefined();
    // The SyncTeX file is gzip-compressed, so it starts with the gzip magic.
    expect(result.synctex?.subarray(0, 2).toString('hex')).toBe('1f8b');
  }, COMPILE_TEST_TIMEOUT);

  it('reports a structured error for an invalid document', async () => {
    if (!(await tectonicAvailable())) {
      return;
    }
    await writeTex('main.tex', INVALID_DOCUMENT);

    const result = await compileProject({
      projectDir: workDir,
      mainFile: 'main.tex',
      timeoutMs: 60_000,
    });

    expect(result.success).toBe(false);
    // A failed compile produces no PDF.
    expect(result.pdf).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.message.includes('Undefined control sequence'))).toBe(true);
  }, COMPILE_TEST_TIMEOUT);

  it('leaves no intermediate files in the project directory', async () => {
    if (!(await tectonicAvailable())) {
      return;
    }
    await writeTex('main.tex', VALID_DOCUMENT);

    await compileProject({
      projectDir: workDir,
      mainFile: 'main.tex',
      timeoutMs: 60_000,
    });

    // The compiler's `.aux`, `.log` and `.synctex.gz` must not pollute the
    // user's project: they would otherwise end up in the next snapshot.
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(workDir);
    expect(files.sort()).toEqual(['main.tex']);
  }, COMPILE_TEST_TIMEOUT);

  it('rejects a main file that points outside the project', async () => {
    await expect(
      compileProject({
        projectDir: workDir,
        mainFile: '../escape.tex',
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/escapes/);
  });

  it('rejects an absolute main file', async () => {
    await expect(
      compileProject({
        projectDir: workDir,
        mainFile: '/etc/passwd',
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/must be relative/);
  });

  it('rejects a main file that is a symlink out of the project', async () => {
    // The lexical check cannot see a symlink, so the real path has to be
    // checked too. Without it, the compiler would read a file outside the
    // project.
    const outside = await mkdtemp(join(tmpdir(), 'freelatex-outside-'));
    try {
      await writeFile(join(outside, 'secret.tex'), '\\documentclass{article}\n', 'utf8');
      const { symlink } = await import('node:fs/promises');
      await symlink(join(outside, 'secret.tex'), join(workDir, 'link.tex'));

      await expect(
        compileProject({
          projectDir: workDir,
          mainFile: 'link.tex',
          timeoutMs: 10_000,
        }),
      ).rejects.toThrow(/escapes/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('raises a dedicated error when the binary does not exist', async () => {
    await expect(
      compileProject({
        projectDir: workDir,
        mainFile: 'main.tex',
        timeoutMs: 10_000,
        binaryPath: join(workDir, 'no-such-tectonic'),
      }),
    ).rejects.toThrow(CompilerNotFoundError);
  });

  it('raises a timeout error when the compilation outlives its budget', async () => {
    if (!(await tectonicAvailable())) {
      return;
    }
    // A document that makes TeX loop forever.
    await writeTex(
      'main.tex',
      '\\documentclass{article}\n\\begin{document}\n\\loop\\iftrue\\repeat\n\\end{document}\n',
    );

    await expect(
      compileProject({
        projectDir: workDir,
        mainFile: 'main.tex',
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(CompileTimeoutError);
  }, COMPILE_TEST_TIMEOUT);

  it('reports a missing main file as a failed compile', async () => {
    if (!(await tectonicAvailable())) {
      return;
    }

    const result = await compileProject({
      projectDir: workDir,
      mainFile: 'absent.tex',
      timeoutMs: 60_000,
    });

    expect(result.success).toBe(false);
    expect(result.pdf).toBeUndefined();
  });
});

/**
 * True when biber is installed.
 *
 * The biber tests need the real binary, so they are skipped rather than
 * failed when it is absent — the same rule the tectonic tests follow.
 */
async function biberAvailable(): Promise<boolean> {
  return (await resolveBiberBinary()) !== undefined;
}

/**
 * A document that uses biblatex.
 *
 * The `addbibresource` and `printbibliography` commands are what mark a
 * document as a biblatex one.
 */
const BIBLATEX_DOCUMENT = `\\documentclass{article}
\\usepackage[backend=biber]{biblatex}
\\addbibresource{refs.bib}
\\begin{document}
Hello, world.\\cite{knuth1984}
\\printbibliography
\\end{document}
`;

const CLASSIC_DOCUMENT = `\\documentclass{article}
\\begin{document}
Hello, world.
\\end{document}
`;

describe('needsBiber', () => {
  it('recognises a biblatex document', async () => {
    await writeTex('main.tex', BIBLATEX_DOCUMENT);

    expect(await needsBiber(workDir, 'main.tex')).toBe(true);
  });

  it('does not claim a classic document needs biber', async () => {
    await writeTex('main.tex', CLASSIC_DOCUMENT);

    expect(await needsBiber(workDir, 'main.tex')).toBe(false);
  });

  it('finds the commands in a file the main file includes', async () => {
    // The resource is often added in the preamble and the bibliography is
    // printed in the body, so the check has to look at both.
    await writeTex(
      'main.tex',
      '\\documentclass{article}\n\\input{preamble}\n\\begin{document}\nHi.\n\\end{document}\n',
    );
    await writeTex('preamble.tex', '\\usepackage[backend=biber]{biblatex}\n\\addbibresource{r.bib}\n');

    expect(await needsBiber(workDir, 'main.tex')).toBe(true);
  });

  it('is false for a file that is not there', async () => {
    expect(await needsBiber(workDir, 'absent.tex')).toBe(false);
  });
});

describe('parseBiberErrors', () => {
  it('reads an error header with its file and line', () => {
    const errors = parseBiberErrors(
      'ERROR - Error at line 63 of file sample-base.bib:',
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.severity).toBe('error');
    expect(errors[0]?.file).toBe('sample-base.bib');
    expect(errors[0]?.line).toBe(63);
  });

  it('reads a warning header as a warning', () => {
    const errors = parseBiberErrors('WARN - Warning at line 12 of file refs.bib:');

    expect(errors).toHaveLength(1);
    expect(errors[0]?.severity).toBe('warning');
  });

  it('reads a summary line without a position', () => {
    const errors = parseBiberErrors('ERROR - Cannot find control sequence "x"');

    expect(errors).toHaveLength(1);
    expect(errors[0]?.severity).toBe('error');
    expect(errors[0]?.message).toContain('Cannot find control sequence');
  });

  it('ignores ordinary output', () => {
    const errors = parseBiberErrors('INFO - This is Biber 2.22\nINFO - Logfile is "main.blg"');

    expect(errors).toEqual([]);
  });
});

describe('resolveBiberBinary', () => {
  it('prefers an explicit override', async () => {
    // The override has to name a file that is there, so the executable
    // check in the resolver does not reject it.
    const stub = join(workDir, 'biber-stub');
    await writeFile(stub, '#!/bin/sh\nexit 0\n', { encoding: 'utf8', mode: 0o755 });

    const previous = process.env.BIBER_BINARY;
    process.env.BIBER_BINARY = stub;
    try {
      expect(await resolveBiberBinary()).toBe(stub);
    } finally {
      if (previous === undefined) {
        delete process.env.BIBER_BINARY;
      } else {
        process.env.BIBER_BINARY = previous;
      }
    }
  });

  it('ignores an override that names a file that is not there', async () => {
    const previous = process.env.BIBER_BINARY;
    process.env.BIBER_BINARY = join(workDir, 'no-such-biber');
    try {
      // The resolver falls through to the usual locations rather than
      // returning a path that cannot be run.
      const found = await resolveBiberBinary();
      expect(found).not.toBe(join(workDir, 'no-such-biber'));
    } finally {
      if (previous === undefined) {
        delete process.env.BIBER_BINARY;
      } else {
        process.env.BIBER_BINARY = previous;
      }
    }
  });
});

describe('the biber path', () => {
  it('reports a missing biber in an actionable way', async () => {
    // The binary is pointed at a file that is not there, so the biber path
    // is chosen but cannot be run.
    await writeTex('main.tex', BIBLATEX_DOCUMENT);

    await expect(
      compileProject({
        projectDir: workDir,
        mainFile: 'main.tex',
        timeoutMs: 10_000,
        binaryPath: (await resolveTectonicBinary()) ?? '/usr/bin/tectonic',
        biberPath: '',
      }),
    ).rejects.toThrow(BiberNotFoundError);
  }, COMPILE_TEST_TIMEOUT);

  it('leaves a classic document to tectonic\'s own BibTeX', async () => {
    if (!(await tectonicAvailable())) {
      return;
    }
    await writeTex('main.tex', CLASSIC_DOCUMENT);

    // A biber path that does not exist would fail the build if it were
    // used, so a successful build proves the classic path was taken.
    const result = await compileProject({
      projectDir: workDir,
      mainFile: 'main.tex',
      timeoutMs: 60_000,
      biberPath: join(workDir, 'no-such-biber'),
    });

    expect(result.success).toBe(true);
    expect(result.pdf?.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  }, COMPILE_TEST_TIMEOUT);

  it('builds a biblatex document', async () => {
    if (!(await tectonicAvailable()) || !(await biberAvailable())) {
      return;
    }
    await writeTex('main.tex', BIBLATEX_DOCUMENT);
    await writeTex(
      'refs.bib',
      '@book{knuth1984,\n  author = {Knuth, Donald E.},\n  title = {The TeXbook},\n  year = {1984},\n  publisher = {Addison-Wesley}\n}\n',
    );

    const result = await compileProject({
      projectDir: workDir,
      mainFile: 'main.tex',
      timeoutMs: 60_000,
    });

    expect(result.success).toBe(true);
    expect(result.pdf?.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  }, COMPILE_TEST_TIMEOUT);

  it('runs biber between the two passes and builds the document', async () => {
    if (!(await tectonicAvailable())) {
      return;
    }
    // A stand-in for biber: it writes the `.bbl` that the second pass needs
    // and records that it ran. The real biber is a Perl program, so this
    // proves that tectonic invokes biber at all rather than proving biber
    // itself works.
    //
    // Tectonic calls biber by its bare name, so the stub has to be called
    // `biber` and live in a directory of its own.
    const binDir = join(workDir, 'stub-bin');
    await mkdir(binDir, { recursive: true });
    const stub = join(binDir, 'biber');
    await writeFile(
      stub,
      [
        '#!/bin/sh',
        'echo "biber ran" >> "$BIBER_MARKER"',
        'out=$(sed -n "s/^output_directory=//p" "$1.conf")',
        'printf "\\\\begin{thebibliography}{1}\n',
        '\\\\bibitem{knuth1984} Knuth, The TeXbook, 1984.\n',
        '\\\\end{thebibliography}\n" > "$out/$1.bbl"',
        'exit 0',
        '',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o755 },
    );
    const marker = join(workDir, 'biber-marker.txt');

    await writeTex('main.tex', BIBLATEX_DOCUMENT);
    await writeTex(
      'refs.bib',
      '@book{knuth1984,\n  author = {Knuth, Donald E.},\n  title = {The TeXbook},\n  year = {1984},\n  publisher = {Addison-Wesley}\n}\n',
    );

    const previousMarker = process.env.BIBER_MARKER;
    process.env.BIBER_MARKER = marker;
    try {
      const result = await compileProject({
        projectDir: workDir,
        mainFile: 'main.tex',
        timeoutMs: 60_000,
        biberPath: stub,
      });

      expect(result.success).toBe(true);
      expect(result.pdf?.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    } finally {
      if (previousMarker === undefined) {
        delete process.env.BIBER_MARKER;
      } else {
        process.env.BIBER_MARKER = previousMarker;
      }
    }

    // The stub ran, so tectonic invoked biber by itself.
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(marker, 'utf8')).toContain('biber ran');
  }, COMPILE_TEST_TIMEOUT);

  it('reports the biber errors when biber fails', async () => {
    if (!(await tectonicAvailable())) {
      return;
    }
    // A stand-in for a biber that cannot read the bibliography.
    const binDir = join(workDir, 'failing-bin');
    await mkdir(binDir, { recursive: true });
    const stub = join(binDir, 'biber');
    await writeFile(
      stub,
      [
        '#!/bin/sh',
        'echo "ERROR - Error at line 63 of file refs.bib:"',
        'echo "Illegal character in name"',
        'exit 2',
        '',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o755 },
    );

    await writeTex('main.tex', BIBLATEX_DOCUMENT);
    await writeTex(
      'refs.bib',
      '@book{knuth1984,\n  author = {Knuth, Donald E.},\n  title = {The TeXbook},\n  year = {1984},\n  publisher = {Addison-Wesley}\n}\n',
    );

    const result = await compileProject({
      projectDir: workDir,
      mainFile: 'main.tex',
      timeoutMs: 60_000,
      biberPath: stub,
    });

    expect(result.success).toBe(false);
    expect(result.pdf).toBeUndefined();
    expect(result.errors.some((e) => e.file === 'refs.bib' && e.line === 63)).toBe(true);
  }, COMPILE_TEST_TIMEOUT);
});
