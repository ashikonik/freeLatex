import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { PDFViewer } from './PDFViewer.js';

/**
 * The pages PDF.js would render.
 *
 * PDF.js draws onto a canvas, which jsdom does not implement, so the
 * rendering is stubbed out and the tests drive the parts of the viewer that
 * are the viewer's own: the zoom controls, the page indicator and the
 * clicks on a page.
 */
const pages = [
  { pageNumber: 1, width: 612, height: 792 },
  { pageNumber: 2, width: 612, height: 792 },
];

vi.mock('react-pdf', () => ({
  pdfjs: {
    GlobalWorkerOptions: { workerSrc: '' },
  },
  Document: ({
    children,
    onLoadSuccess,
  }: {
    children: React.ReactNode;
    onLoadSuccess?: (props: { numPages: number }) => void;
  }) => {
    // The document reports its page count once it has been read.
    void Promise.resolve().then(() => {
      act(() => {
        onLoadSuccess?.({ numPages: pages.length });
      });
    });
    return <div data-testid="pdf-document">{children}</div>;
  },
  Page: ({
    pageNumber,
    onLoadSuccess,
    onClick,
  }: {
    pageNumber: number;
    width?: number;
    onLoadSuccess?: (props: { width: number; height: number }) => void;
    onClick?: (event: unknown) => void;
  }) => {
    void Promise.resolve().then(() => {
      act(() => {
        onLoadSuccess?.({ width: 612, height: 792 });
      });
    });
    return (
      <button
        type="button"
        data-testid={`pdf-page-${pageNumber}`}
        onClick={(event) => {
          onClick?.({
            // React sets the target to what was hit and the current target to
            // the element the handler is on, which is the page.
            target: event.target,
            currentTarget: event.currentTarget,
            clientX: 100,
            clientY: 200,
          });
        }}
      >
        Page {pageNumber}
      </button>
    );
  },
}));

describe('the PDF viewer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a page for every page of the document', async () => {
    render(<PDFViewer file={new Uint8Array([1, 2, 3])} />);

    await waitFor(() => {
      expect(screen.getByTestId('pdf-page-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pdf-page-2')).toBeInTheDocument();
  });

  it('shows the page the reader is on', async () => {
    render(<PDFViewer file={new Uint8Array([1, 2, 3])} />);

    await waitFor(() => {
      expect(screen.getByTestId('page-indicator')).toHaveTextContent('1 / 2');
    });
  });

  it('reports the number of pages once the document is loaded', async () => {
    const onPageCountChange = vi.fn();
    render(<PDFViewer file={new Uint8Array([1, 2, 3])} onPageCountChange={onPageCountChange} />);

    await waitFor(() => {
      expect(onPageCountChange).toHaveBeenCalledWith(2);
    });
  });

  it('steps the zoom up and down', async () => {
    const onZoomChange = vi.fn();
    render(<PDFViewer file={new Uint8Array([1, 2, 3])} zoom={1} onZoomChange={onZoomChange} />);

    fireEvent.click(screen.getByLabelText('Zoom in'));
    expect(onZoomChange).toHaveBeenCalledWith(1.25);

    fireEvent.click(screen.getByLabelText('Zoom out'));
    expect(onZoomChange).toHaveBeenCalledWith(0.75);
  });

  it('shows the zoom factor', () => {
    render(<PDFViewer file={new Uint8Array([1, 2, 3])} zoom={1.5} />);

    expect(screen.getByText('150%')).toBeInTheDocument();
  });

  it('reports a click on a page', async () => {
    const onPageClick = vi.fn();
    render(<PDFViewer file={new Uint8Array([1, 2, 3])} onPageClick={onPageClick} />);

    await waitFor(() => {
      expect(screen.getByTestId('pdf-page-2')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('pdf-page-2'));

    expect(onPageClick).toHaveBeenCalledWith(2, expect.any(Number), expect.any(Number));
  });
});
