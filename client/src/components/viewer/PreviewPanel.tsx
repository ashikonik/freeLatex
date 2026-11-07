import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CompilerClient, type CompilerFile } from '../../compiler/compiler-client.js';
import { compileProject, forwardSearch, inverseSearch } from '../../lib/api.js';
import { PDFViewer, type RenderedPage } from './PDFViewer.js';
import { SyncTeXOverlay, useForwardSync } from './SyncTeXOverlay.js';
import {
  pageOffset,
  toPdfPoint,
  type PageMetrics,
  type SyncPosition,
} from './synctex-math.js';

/** The properties of the preview panel. */
export interface PreviewPanelProps {
  /** The project being previewed. */
  projectId: string;
  /** The main document's source. */
  source: string;
  /** The path of the main document. */
  mainPath: string;
  /** The other files of the project. */
  files: CompilerFile[];
  /** Where the preview is built. */
  mode: 'wasm' | 'server';
  /** The line the cursor is on, for the forward search. */
  cursorLine: number | undefined;
  /** Called when the reader clicks a spot on the page. */
  onJumpToSource: (file: string, line: number) => void;
  /** Called with the errors of the last build. */
  onErrors?: (errors: string[]) => void;
}

/** The gap between two pages, in CSS pixels. */
const PAGE_GAP = 16;

/**
 * The preview panel.
 *
 * The panel shows the PDF and the SyncTeX highlight over it. Where the PDF
 * comes from depends on the mode: the WebAssembly engine builds it in the
 * browser, the server builds it with Tectonic.
 */
export function PreviewPanel({
  projectId,
  source,
  mainPath,
  files,
  mode,
  cursorLine,
  onJumpToSource,
  onErrors,
}: PreviewPanelProps): React.ReactElement {
  const [pdf, setPdf] = useState<ArrayBuffer | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [building, setBuilding] = useState(false);
  const [zoom, setZoom] = useState(1);
  /** The size of each rendered page, so the overlay can be placed on it. */
  const [metrics, setMetrics] = useState<Map<number, RenderedPage>>(new Map());

  const compiler = useRef<CompilerClient | undefined>(undefined);
  if (!compiler.current) {
    compiler.current = new CompilerClient();
  }

  // The panel is mounted or it is not, and a build that finishes after the
  // panel has gone must not try to update it.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The compiler is stopped when the panel goes away, because the worker
  // holds a whole TeX installation in memory.
  useEffect(() => {
    const instance = compiler.current;
    return () => {
      instance?.dispose();
    };
  }, []);

  const build = useCallback(async (): Promise<void> => {
    setBuilding(true);
    setError(undefined);
    try {
      if (mode === 'wasm') {
        const outcome = await compiler.current?.compile(source, mainPath, files);
        if (!outcome) {
          return;
        }
        if (!outcome.success || !outcome.pdf) {
          if (mounted.current) {
            setError(outcome.errors.join('\n') || 'The compilation failed.');
            onErrors?.(outcome.errors);
          }
          return;
        }
        if (mounted.current) {
          setPdf(outcome.pdf);
          onErrors?.(outcome.errors);
        }
        return;
      }

      const bytes = await compileProject(projectId, mainPath);
      if (mounted.current) {
        setPdf(bytes);
        onErrors?.([]);
      }
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : 'The compilation failed.');
      }
    } finally {
      if (mounted.current) {
        setBuilding(false);
      }
    }
  }, [mode, projectId, source, mainPath, files, onErrors]);

  // The preview is rebuilt whenever the document changes. The delay keeps a
  // burst of keystrokes from starting a build for every one of them.
  useEffect(() => {
    const timer = setTimeout(() => {
      void build();
    }, 800);
    return () => {
      clearTimeout(timer);
    };
  }, [build]);

  const onPageMetrics = useCallback((page: number, page_metrics: RenderedPage): void => {
    setMetrics((current) => {
      const existing = current.get(page);
      if (
        existing &&
        existing.width === page_metrics.width &&
        existing.height === page_metrics.height &&
        existing.pointWidth === page_metrics.pointWidth &&
        existing.pointHeight === page_metrics.pointHeight
      ) {
        return current;
      }
      const next = new Map(current);
      next.set(page, page_metrics);
      return next;
    });
  }, []);

  // The forward search asks the server where the current line is on the
  // page. The WebAssembly engine's SyncTeX data does not reach the client
  // through the same route, so the search only runs against a server build.
  const search = useMemo(() => {
    if (mode !== 'server') {
      return undefined;
    }
    return async (file: string, line: number): Promise<SyncPosition | undefined> => {
      const result = await forwardSearch(projectId, file, line);
      return result?.position;
    };
  }, [mode, projectId]);

  const forward = useForwardSync(search, mainPath, cursorLine);

  /**
   * The metrics of the page holding the highlight.
   *
   * The page is not known until the document has been read, so the metrics
   * are looked up rather than held.
   */
  const highlightMetrics = useMemo<PageMetrics | undefined>(() => {
    if (!forward.position) {
      return undefined;
    }
    const page = metrics.get(forward.position.page);
    if (!page) {
      return undefined;
    }
    return {
      width: page.width,
      height: page.height,
      pointWidth: page.pointWidth,
      pointHeight: page.pointHeight,
    };
  }, [forward.position, metrics]);

  /**
   * How far down the scroll the page holding the highlight sits.
   *
   * Every page is the same height in a document of one size, so the height
   * of the first page and the number of pages above it give the offset.
   */
  const highlightOffset = useMemo((): number => {
    if (!forward.position) {
      return 0;
    }
    const page = metrics.get(forward.position.page);
    if (!page) {
      return 0;
    }
    const heights = Array.from(metrics.values()).map((entry) => entry.height);
    return pageOffset(forward.position.page - 1, heights, PAGE_GAP);
  }, [forward.position, metrics]);

  const onPageClick = useCallback(
    async (page: number, x: number, y: number): Promise<void> => {
      if (mode !== 'server') {
        return;
      }
      const page_metrics = metrics.get(page);
      if (!page_metrics) {
        return;
      }
      try {
        // The click is in CSS pixels, but the server wants PDF points.
        const point = toPdfPoint(x, y, {
          width: page_metrics.width,
          height: page_metrics.height,
          pointWidth: page_metrics.pointWidth,
          pointHeight: page_metrics.pointHeight,
        });
        const result = await inverseSearch(projectId, point.x, point.y, page);
        if (result) {
          onJumpToSource(result.source.file, result.source.line);
        }
      } catch {
        // A click that no source line produced is not an error worth
        // interrupting the reader for.
      }
    },
    [mode, projectId, metrics, onJumpToSource],
  );

  return (
    <div className="flex h-full flex-col" data-testid="preview-panel">
      {building ? (
        <p className="border-b border-slate-200 bg-amber-50 px-3 py-1 text-xs text-amber-700">
          Building…
        </p>
      ) : null}

      {error ? (
        <pre
          role="alert"
          className="max-h-40 overflow-auto border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          {error}
        </pre>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {pdf ? (
          <PDFViewer
            file={pdf}
            zoom={zoom}
            onZoomChange={setZoom}
            onPageMetrics={onPageMetrics}
            onPageClick={(page, x, y) => {
              void onPageClick(page, x, y);
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-slate-100 text-sm text-slate-500">
            {building ? 'Building the document…' : 'No preview yet.'}
          </div>
        )}

        {forward.position && highlightMetrics ? (
          <div className="pointer-events-none absolute inset-0">
            <SyncTeXOverlay
              position={forward.position}
              metrics={highlightMetrics}
              offsetTop={highlightOffset}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
