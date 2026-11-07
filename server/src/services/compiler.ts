import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { assertRealPathWithin, resolveWithin } from './paths.js';

/** Severity of a single LaTeX diagnostic. */
export type CompileErrorSeverity = 'error' | 'warning';

/**
 * One diagnostic extracted from the compiler's output.
 *
 * `line` and `file` are optional because not every diagnostic carries a
 * position — a missing package, for instance, is reported without one.
 */
export interface CompileError {
  severity: CompileErrorSeverity;
  /** The error text without the leading "!" or "LaTeX Warning:" prefix. */
  message: string;
  /** Source file the diagnostic refers to, relative to the project root. */
  file?: string;
  /** 1-based line number within that file. */
  line?: number;
  /** The source line the diagnostic points at. */
  context?: string;
}

/** The outcome of a compilation attempt. */
export interface CompileResult {
  /** True when a PDF was produced. */
  success: boolean;
  /** The compiled PDF, when the compilation succeeded. */
  pdf?: Buffer;
  /**
   * The raw SyncTeX data, when the compiler produced any.
   *
   * Kept compressed because that is how tectonic writes it, and because the
   * SyncTeX engine decompresses it on demand rather than on every compile.
   */
  synctex?: Buffer;
  /** Every diagnostic the compiler reported, in the order it reported them. */
  errors: CompileError[];
  /** The compiler's raw output, kept for diagnostics. */
  log: string;
  /** How long the compilation took, in milliseconds. */
  durationMs: number;
  /** Set when the compiler could not be run at all. */
  failureReason?: CompileFailureReason;
}

/** Why a compilation could not be completed. */
export type CompileFailureReason =
  | 'compiler-not-found'
  | 'timeout'
  | 'main-file-missing'
  | 'no-output'
  | 'spawn-failed';

/**
 * Raised when the compilation exceeded its time budget.
 *
 * A dedicated type so the route can report a 504 rather than a generic 500,
 * and so the caller can tell "took too long" from "failed".
 */
export class CompileTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The compilation timed out after ${timeoutMs} ms.`);
    this.name = 'CompileTimeoutError';
  }
}

/**
 * Raised when the `tectonic` binary cannot be found.
 *
 * This is a deployment problem rather than a user problem, so the route
 * answers 503 and says what to install.
 */
export class CompilerNotFoundError extends Error {
  constructor(message = 'The tectonic compiler is not installed on this server.') {
    super(message);
    this.name = 'CompilerNotFoundError';
  }
}

export interface CompilerOptions {
  /** Directory holding the project's source files. */
  projectDir: string;
  /** The project's main file, relative to `projectDir`. */
  mainFile: string;
  /** How long the compilation may run. */
  timeoutMs: number;
  /** Override the tectonic executable (used by tests). */
  binaryPath?: string;
}

/**
 * Upper bound on the compiler's output.
 *
 * A document can make TeX print an enormous amount — a runaway loop with a
 * `\message` in a loop, for instance. The output is collected in memory, so
 * it has to be capped or a single build could exhaust the server.
 */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * The name of the tectonic executable.
 *
 * `node-tectonic` installs a wrapper with the same name on the PATH, so
 * looking up the plain name covers both the system install and the npm one.
 */
const TECTONIC_BINARY = 'tectonic';

/**
 * Locations to search for the tectonic binary when it is not on the PATH.
 *
 * `node-tectonic` places its wrapper inside the package's own directory, so
 * the path is derived from the module location rather than hard-coded.
 */
const TECTONIC_FALLBACK_PATHS = [
  join(process.cwd(), 'node_modules', '.bin', TECTONIC_BINARY),
  '/usr/local/bin/tectonic',
  '/usr/bin/tectonic',
];

/**
 * Find the tectonic executable.
 *
 * @returns The absolute path of the binary, or undefined when it is not
 * installed.
 */
export async function resolveTectonicBinary(): Promise<string | undefined> {
  // An explicit override wins, so tests can point at a stub.
  const override = process.env.TECTONIC_BINARY;
  if (override && (await isExecutable(override))) {
    return override;
  }

  for (const candidate of TECTONIC_FALLBACK_PATHS) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  // Fall back to a PATH lookup: spawning a bare name lets the OS resolve it.
  const pathDirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, TECTONIC_BINARY);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/** True when the path exists and is executable by the current user. */
async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compile a LaTeX project with tectonic.
 *
 * The compiler runs in a scratch directory so that the intermediate files it
 * produces (`.aux`, `.log`, `.synctex.gz`) never end up mixed into the
 * project's own files — those belong to the user and to the snapshots.
 *
 * @throws CompilerNotFoundError when tectonic is not installed.
 * @throws CompileTimeoutError when the compilation exceeds its budget.
 */
export async function compileProject(options: CompilerOptions): Promise<CompileResult> {
  const startedAt = Date.now();
  const binary = options.binaryPath ?? (await resolveTectonicBinary());

  if (!binary) {
    throw new CompilerNotFoundError();
  }

  const mainFile = options.mainFile.trim() || 'main.tex';

  // The main file is read from the project directory, so it must not be able
  // to point outside it. The same two checks the storage service uses apply
  // here: a lexical check for `..` and an absolute path, and a check of the
  // real path so that a symlink planted in the project cannot lead the
  // compiler out of it.
  const mainFilePath = resolveWithin(options.projectDir, mainFile);
  await assertRealPathWithin(options.projectDir, mainFilePath);

  // A scratch directory keeps the compiler's intermediates out of the project.
  const workDir = await mkdtemp(join(tmpdir(), 'freelatex-build-'));

  try {
    const args = [
      '-X',
      'compile',
      mainFile,
      '--outfmt',
      'pdf',
      '--synctex',
      '--keep-logs',
      '--keep-intermediates',
      '--outdir',
      workDir,
    ];

    const result = await runTectonic(binary, args, options.projectDir, options.timeoutMs);

    const log = result.stdout + result.stderr;
    const errors = parseCompilerErrors(log);

    // A build that overran its budget is raised rather than returned: the
    // caller has to tell "took too long" from "did not compile", and the two
    // need different answers.
    if (result.timedOut) {
      throw new CompileTimeoutError(options.timeoutMs);
    }

    // A non-zero exit is only a failure when no PDF was produced: tectonic
    // can report a recoverable error and still emit a document.
    const outputBase = stripExtension(mainFile);
    const pdf = await readFile(join(workDir, `${outputBase}.pdf`)).catch(() => undefined);
    const synctex = await readFile(join(workDir, `${outputBase}.synctex.gz`)).catch(() => undefined);

    if (!pdf) {
      return {
        success: false,
        errors,
        log,
        durationMs: Date.now() - startedAt,
        failureReason: 'no-output',
      };
    }

    return {
      success: true,
      pdf,
      synctex,
      errors,
      log,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The result of one compiler process. */
interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * How many compilations may run at the same time.
 *
 * Every compilation is a whole TeX engine, and each one wants a core of its
 * own. Without a limit, a client that asks for a hundred builds at once
 * takes every core and every megabyte of the server, and the other tenants
 * wait. The queue keeps the machine usable: the builds wait their turn
 * rather than all starting at once.
 *
 * The limit follows the machine's own cores, but it can be set down with
 * MAX_CONCURRENT_COMPILATIONS. A small host needs that: the compiler wants
 * about 190 megabytes while it runs, so a machine with half a gigabyte of
 * memory can afford one build at a time and no more.
 */
function resolveCompilationLimit(): number {
  const configured = Number.parseInt(process.env.MAX_CONCURRENT_COMPILATIONS ?? '', 10);
  if (Number.isInteger(configured) && configured >= 1) {
    return configured;
  }
  return Math.max(1, Math.min(4, cpus().length));
}

const MAX_CONCURRENT_COMPILATIONS = resolveCompilationLimit();

/**
 * How many compilations may run at the same time.
 *
 * Exported so that the limit can be tested without guessing the machine's
 * core count.
 */
export const compilationLimit = MAX_CONCURRENT_COMPILATIONS;

/**
 * The compilations that are running right now.
 */
let runningCompilations = 0;

/**
 * The callers waiting for a free slot.
 */
const compilationQueue: (() => void)[] = [];

/**
 * Take a slot for a compilation, waiting for one if they are all taken.
 *
 * @returns A function that gives the slot back.
 */
async function acquireCompilationSlot(): Promise<() => void> {
  if (runningCompilations < MAX_CONCURRENT_COMPILATIONS) {
    runningCompilations += 1;
    return releaseCompilationSlot;
  }

  await new Promise<void>((resolve) => {
    compilationQueue.push(resolve);
  });

  runningCompilations += 1;
  return releaseCompilationSlot;
}

/**
 * Give a slot back and let the next waiting compilation take it.
 */
function releaseCompilationSlot(): void {
  runningCompilations -= 1;
  const next = compilationQueue.shift();
  if (next) {
    next();
  }
}

/**
 * Run tectonic and collect its output.
 *
 * The process is killed if it outlives the timeout, and the promise resolves
 * either way — the caller inspects the output to decide what happened.
 *
 * The output is capped: a document can make TeX print an unbounded amount,
 * and the output is held in memory until the build finishes.
 */
async function runTectonic(
  binary: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ProcessResult> {
  // The slot is taken before the process starts and given back when it ends,
  // however it ends.
  const release = await acquireCompilationSlot();
  try {
    return await startProcess(binary, args, cwd, timeoutMs);
  } finally {
    release();
  }
}

/**
 * Start the compiler process and settle with its result.
 */
function startProcess(
  binary: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      // A LaTeX run must not be able to prompt for input.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let collected = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    /** Append to a buffer, up to the cap. */
    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (collected >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const text = chunk.toString('utf8');
      const room = MAX_OUTPUT_BYTES - collected;
      if (text.length >= room) {
        truncated = true;
        collected = MAX_OUTPUT_BYTES;
        if (target === 'stdout') {
          stdout += text.slice(0, room);
        } else {
          stderr += text.slice(0, room);
        }
        return;
      }
      collected += text.length;
      if (target === 'stdout') {
        stdout += text;
      } else {
        stderr += text;
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      append('stdout', chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      append('stderr', chunk);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(new CompilerNotFoundError());
        return;
      }
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: truncated ? `${stdout}\n[output truncated]\n` : stdout,
        stderr,
        code,
        timedOut,
      });
    });
  });
}

/** Strip a `.tex` (or any) extension from a file name. */
function stripExtension(fileName: string): string {
  const base = basename(fileName);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Extract the diagnostics from tectonic's output.
 *
 * Tectonic reports a position on a line of its own:
 *
 *     error: main.tex:3: Undefined control sequence
 *
 * and the raw TeX log carries the classic `! Undefined control sequence.`
 * form. Both are recognised so that a diagnostic survives whichever channel
 * the compiler chose to use.
 */
export function parseCompilerErrors(output: string): CompileError[] {
  const errors: CompileError[] = [];

  for (const line of output.split('\n')) {
    const trimmed = line.trim();

    // Tectonic's own summary line: "error: file.tex:12: message".
    const summary = /^error:\s+(.+?):(\d+):\s*(.+)$/.exec(trimmed);
    if (summary) {
      errors.push({
        severity: 'error',
        message: summary[3] ?? '',
        file: summary[1] ?? undefined,
        line: Number(summary[2]),
      });
      continue;
    }

    // The raw TeX form: "! Undefined control sequence.".
    const tex = /^!\s+(.+)$/.exec(trimmed);
    if (tex) {
      errors.push({
        severity: 'error',
        message: (tex[1] ?? '').replace(/\.$/, ''),
      });
      continue;
    }

    // "LaTeX Warning: ... on input line 12."
    const warning = /^LaTeX Warning:\s+(.+?)(?:\s+on input line (\d+))?\.$/.exec(trimmed);
    if (warning) {
      errors.push({
        severity: 'warning',
        message: warning[1] ?? '',
        line: warning[2] ? Number(warning[2]) : undefined,
      });
      continue;
    }
  }

  return errors;
}
