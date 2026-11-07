import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';

import { clampZoom, nextZoom, previousZoom } from './synctex-math.js';

/**
 * The PDF.js worker.
 *
 * PDF.js runs its parser in a worker, and the worker has to be a separate
 * file. Vite resolves the `?url` import to the built asset.
 */
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

/** The size of a rendered page. */
export interface RenderedPage {
  /** The width of the page in CSS pixels. */
  width: number;
  /** The height of the page in CSS pixels. */
  height: number;
  /** The width of the page in PDF points. */
  pointWidth: number;
  /** The height of the page in PDF points. */
  pointHeight: number;
}

/** The properties of the viewer. */
export interface PDFViewerProps {
  /** The PDF to show. */
  file: Blob | ArrayBuffer | Uint8Array | null;
  /** The current zoom factor. */
  zoom?: number;
  /** Called when the zoom changes. */
  onZoomChange?: (zoom: number) => void;
  /** Called when the user clicks a position on a page. */
  onPageClick?: (page: number, x: number, y: number) => void;
  /** The page to scroll to, when it changes. */
  targetPage?: number;
  /** Called with the number of pages once the document is loaded. */
  onPageCountChange?: (count: number) => void;
  /**
   * Called with the size of a rendered page.
   *
   * The overlay and the inverse search need to know how large a page is on
   * the screen and how large it is in PDF points, because a click has to be
   * converted from one into the other.
   */
  onPageMetrics?: (page: number, metrics: RenderedPage) => void;
}

/**
 * The PDF as a file object.
 *
 * PDF.js reads the document from a `File`, so the bytes that came back from
 * the compiler or the server are wrapped in one.
 */
function asFile(file: Blob | ArrayBuffer | Uint8Array): File {
  if (file instanceof File) {
    return file;
  }
  if (file instanceof Blob) {
    // A blob can be handed to the file directly: its bytes are read when
    // PDF.js asks for them.
    return new File([file], 'document.pdf', { type: 'application/pdf' });
  }
  // A view may sit on a shared buffer, which a file cannot hold, so the
  // bytes are copied into a plain buffer first.
  const buffer = new ArrayBuffer(file.byteLength);
  new Uint8Array(buffer).set(
    file instanceof ArrayBuffer
      ? new Uint8Array(file)
      : new Uint8Array(file.buffer, file.byteOffset, file.byteLength),
  );
  return new File([buffer], 'document.pdf', { type: 'application/pdf' });
}

/**
 * The PDF viewer.
 *
 * The pages are stacked in one scrolling column, which is how a reader reads
 * a document: the scroll position carries the place, and a jump to a page is
 * a scroll to an offset.
 */
export function PDFViewer({
  file,
  zoom = 1,
  onZoomChange,
  onPageClick,
  targetPage,
  onPageCountChange,
  onPageMetrics,
}: PDFViewerProps): React.ReactElement {
  const [numberOfPages, setNumberOfPages] = useState(0);
  const [pageWidth, setPageWidth] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const container = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement | null>());

  const onDocumentLoad = useCallback(
    ({ numPages }: { numPages: number }): void => {
      setNumberOfPages(numPages);
      onPageCountChange?.(numPages);
    },
    [onPageCountChange],
  );

  // The width of a page is what the zoom factor scales, so the natural width
  // is measured once and kept.
  const onPageLoad = useCallback(
    (page: number) =>
      ({ width, height }: { width: number; height: number }): void => {
        setPageWidth((current) => (current === 0 ? width : current));
        onPageMetrics?.(page, {
          width,
          height,
          pointWidth: width,
          pointHeight: height,
        });
      },
    [onPageMetrics],
  );

  // A jump to a page scrolls the page into view.
  useEffect(() => {
    if (targetPage === undefined) {
      return;
    }
    const element = pageRefs.current.get(targetPage);
    element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [targetPage, numberOfPages]);

  // The page the reader is looking at is the one nearest the top of the
  // viewport, so it is read from the scroll position.
  const onScroll = useCallback((): void => {
    const element = container.current;
    if (!element) {
      return;
    }
    const top = element.getBoundingClientRect().top;
    let closest = 1;
    let closestDistance = Number.POSITIVE_INFINITY;

    for (const [page, node] of pageRefs.current) {
      if (!node) {
        continue;
      }
      const distance = Math.abs(node.getBoundingClientRect().top - top);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = page;
      }
    }
    setCurrentPage(closest);
  }, []);

  const zoomIn = useCallback((): void => {
    onZoomChange?.(nextZoom(zoom));
  }, [zoom, onZoomChange]);

  const zoomOut = useCallback((): void => {
    onZoomChange?.(previousZoom(zoom));
  }, [zoom, onZoomChange]);

  const pages = useMemo(
    () => Array.from({ length: numberOfPages }, (_, index) => index + 1),
    [numberOfPages],
  );

  const renderWidth = pageWidth > 0 ? pageWidth * clampZoom(zoom) : undefined;

  return (
    <div className="flex h-full flex-col bg-slate-200">
      <div className="flex items-center gap-2 border-b border-slate-300 bg-white px-3 py-1.5 text-sm">
        <button
          type="button"
          onClick={zoomOut}
          aria-label="Zoom out"
          className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-50"
        >
          −
        </button>
        <span className="w-14 text-center tabular-nums text-slate-600">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={zoomIn}
          aria-label="Zoom in"
          className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-50"
        >
          +
        </button>
        <span className="ml-auto tabular-nums text-slate-600" data-testid="page-indicator">
          {currentPage} / {numberOfPages}
        </span>
      </div>

      <div
        ref={container}
        onScroll={onScroll}
        data-testid="pdf-scroll"
        className="min-h-0 flex-1 overflow-auto px-4 py-4"
      >
        <Document
          file={file ? asFile(file) : null}
          onLoadSuccess={onDocumentLoad}
          loading={<p className="p-4 text-sm text-slate-600">Loading the PDF…</p>}
          error={<p className="p-4 text-sm text-red-600">The PDF could not be shown.</p>}
        >
          {pages.map((pageNumber) => (
            <div
              key={pageNumber}
              ref={(node) => {
                pageRefs.current.set(pageNumber, node);
              }}
              className="mb-4 flex justify-center"
            >
              <Page
                pageNumber={pageNumber}
                {...(renderWidth === undefined ? {} : { width: renderWidth })}
                onLoadSuccess={onPageLoad(pageNumber)}
                renderAnnotationLayer={false}
                renderTextLayer={false}
                onClick={(event) => {
                  if (!onPageClick) {
                    return;
                  }
                  // The click may land on the canvas or on any child of the
                  // page, so the offset is measured from the page itself
                  // rather than from whatever was hit.
                  const page = event.currentTarget as HTMLElement;
                  const bounds = page.getBoundingClientRect();
                  onPageClick(
                    pageNumber,
                    event.clientX - bounds.left,
                    event.clientY - bounds.top,
                  );
                }}
              />
            </div>
          ))}
        </Document>
      </div>
    </div>
  );
}
