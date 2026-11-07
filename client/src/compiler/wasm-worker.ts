/**
 * The Web Worker that compiles LaTeX in the browser.
 *
 * The worker exists so that a compilation never blocks the editor: TeX runs
 * for seconds, and on the main thread that would freeze the page. The
 * worker holds one engine, answers one compilation at a time, and reports
 * back through messages.
 */

/// <reference lib="webworker" />

import { BusyTexRunner, XeLatex, type FileInput } from 'texlyre-busytex';

import { extractErrors } from './log-errors.js';

/** A message the worker accepts. */
export type CompileRequest = {
  type: 'compile';
  /** The identifier the answer carries. */
  id: string;
  /** The main document's source. */
  source: string;
  /** The path of the main document. */
  mainPath: string;
  /** The other files of the project. */
  files: FileInput[];
};

/** A message the worker sends back. */
export type CompileResponse =
  | {
      type: 'result';
      id: string;
      success: boolean;
      /** The compiled PDF, transferred to the main thread. */
      pdf?: ArrayBuffer;
      /** The errors the compiler reported. */
      errors: string[];
      /** The engine's log. */
      log: string;
    }
  | { type: 'error'; id: string; message: string };

/**
 * Where the engine's assets are served from.
 *
 * The engine's WebAssembly and data files are not part of the JavaScript
 * bundle, so they are fetched at runtime from the server's own origin.
 */
const BUSYTEX_BASE_PATH = '/core/busytex';

const scope = self as unknown as DedicatedWorkerGlobalScope;

/** The tool that drives the engine. */
let engine: XeLatex | undefined;

/**
 * Load the engine.
 *
 * The engine is loaded once and kept, because loading it costs seconds and
 * every compilation after the first is then fast.
 */
async function ensureEngine(): Promise<XeLatex> {
  if (engine) {
    return engine;
  }

  const created = new BusyTexRunner({
    busytexBasePath: BUSYTEX_BASE_PATH,
    verbose: false,
    engineMode: 'xetex',
  });
  await created.initialize(true);
  engine = new XeLatex(created);
  return engine;
}

/**
 * Compile a project.
 *
 * @param request The compilation to run.
 */
async function compile(request: CompileRequest): Promise<CompileResponse> {
  try {
    const tool = await ensureEngine();

    const result = await tool.compile({
      input: request.source,
      mainTexPath: request.mainPath,
      additionalFiles: request.files,
      // A document that refers to its own bibliography needs the extra
      // passes, and a document that does not is only slowed down by them.
      bibtex: true,
      biber: true,
      makeindex: true,
      rerun: true,
    });

    const errors = extractErrors(result.log);

    if (!result.success || !result.pdf) {
      return {
        type: 'result',
        id: request.id,
        success: false,
        errors: errors.length > 0 ? errors : ['The compilation failed.'],
        log: result.log,
      };
    }

    // The PDF is transferred rather than copied, which keeps a large
    // document from being duplicated in memory.
    const pdf = result.pdf.buffer.slice(
      result.pdf.byteOffset,
      result.pdf.byteOffset + result.pdf.byteLength,
    ) as ArrayBuffer;

    return {
      type: 'result',
      id: request.id,
      success: true,
      pdf,
      errors,
      log: result.log,
    };
  } catch (cause) {
    return {
      type: 'error',
      id: request.id,
      message: cause instanceof Error ? cause.message : 'The compilation failed.',
    };
  }
}

scope.addEventListener('message', (event: MessageEvent<CompileRequest>) => {
  const request = event.data;
  if (request?.type !== 'compile') {
    return;
  }

  void compile(request).then((response) => {
    const transfer: Transferable[] = [];
    if (response.type === 'result' && response.pdf) {
      transfer.push(response.pdf);
    }
    scope.postMessage(response, transfer);
  });
});
