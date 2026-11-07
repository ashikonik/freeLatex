import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CompilerNotFoundError,
  CompileTimeoutError,
  compileProject,
  parseCompilerErrors,
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
