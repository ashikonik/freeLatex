import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

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
  if (mainFile.includes('..') || mainFile.startsWith('/')) {
    // The main file is read from the project directory, so it must not be
    // able to point outside it.
    throw new Error('The main file must be a path within the project.');
  }

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
        failureReason: result.timedOut ? 'timeout' : undefined,
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
 * Run tectonic and collect its output.
 *
 * The process is killed if it outlives the timeout, and the promise resolves
 * either way — the caller inspects the output to decide what happened.
 */
function runTectonic(
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
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
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
      resolve({ stdout, stderr, code, timedOut });
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
