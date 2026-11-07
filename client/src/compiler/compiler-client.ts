/**
 * The client-side compiler.
 *
 * The engine runs in a Web Worker, so a compilation never freezes the
 * editor. This module owns the worker and the requests that are in flight,
 * so that a caller can ask for a build and get the answer of that build and
 * not of a later one.
 */

/** A file of the project, as the engine expects it. */
export interface CompilerFile {
  /** The path of the file, relative to the project root. */
  path: string;
  /** The contents of the file. */
  content: string;
}

/** The outcome of a compilation. */
export interface CompileOutcome {
  /** Whether the compiler produced a PDF. */
  success: boolean;
  /** The compiled PDF, when there is one. */
  pdf?: ArrayBuffer;
  /** The errors the compiler reported. */
  errors: string[];
  /** The engine's log. */
  log: string;
}

/** A message the worker sends back. */
interface WorkerResponse {
  type: 'result' | 'error';
  id: string;
  success?: boolean;
  pdf?: ArrayBuffer;
  errors?: string[];
  log?: string;
  message?: string;
}

/**
 * How long a compilation may take before it is given up on.
 *
 * The engine loads its own TeX installation, which takes seconds on the first
 * run, so the budget is generous — but a worker that hangs must not leave
 * the reader staring at a "Building…" message forever.
 */
const COMPILE_TIMEOUT_MS = 120_000;

/**
 * The compiler.
 *
 * The worker is created lazily, because loading the engine costs seconds and
 * a reader who never asks for a preview never pays for it.
 */
export class CompilerClient {
  private worker: Worker | undefined;

  private readonly pending = new Map<
    string,
    { resolve: (outcome: CompileOutcome) => void; reject: (cause: Error) => void }
  >();

  private counter = 0;

  /**
   * Compile a document.
   *
   * @param source The main document's source.
   * @param mainPath The path of the main document.
   * @param files The other files of the project.
   */
  async compile(
    source: string,
    mainPath: string,
    files: CompilerFile[],
  ): Promise<CompileOutcome> {
    const worker = this.ensureWorker();
    const id = `compile-${(this.counter += 1)}`;

    const outcome = new Promise<CompileOutcome>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    // A worker that never answers must not hold the request open forever.
    const timer = setTimeout(() => {
      const entry = this.pending.get(id);
      if (!entry) {
        return;
      }
      this.pending.delete(id);
      entry.reject(new Error('The compilation took too long and was given up on.'));
    }, COMPILE_TIMEOUT_MS);

    worker.postMessage({
      type: 'compile',
      id,
      source,
      mainPath,
      files: files.map((file) => ({ path: file.path, content: file.content })),
    });

    try {
      return await outcome;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Stop the worker and drop every request that is still in flight. */
  dispose(): void {
    this.worker?.terminate();
    this.worker = undefined;
    for (const { reject } of this.pending.values()) {
      reject(new Error('The compiler was closed.'));
    }
    this.pending.clear();
  }

  /** The worker, created the first time it is needed. */
  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }

    const worker = new Worker(new URL('./wasm-worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>): void => {
      const response = event.data;
      const entry = this.pending.get(response.id);
      if (!entry) {
        return;
      }
      this.pending.delete(response.id);

      if (response.type === 'error') {
        entry.reject(new Error(response.message ?? 'The compilation failed.'));
        return;
      }

      entry.resolve({
        success: response.success ?? false,
        ...(response.pdf ? { pdf: response.pdf } : {}),
        errors: response.errors ?? [],
        log: response.log ?? '',
      });
    });

    worker.addEventListener('error', (event: ErrorEvent): void => {
      // A worker that dies takes every request it was serving with it.
      for (const { reject } of this.pending.values()) {
        reject(new Error(event.message || 'The compiler crashed.'));
      }
      this.pending.clear();
      this.worker?.terminate();
      this.worker = undefined;
    });

    this.worker = worker;
    return worker;
  }
}
