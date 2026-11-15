import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

import { PreviewPanel } from './PreviewPanel.js';

vi.mock('../../lib/api.js', async (importOriginal) => {
  // The error class is the real one: the panel recognises a failed build by
  // its type, so a stand-in would not be recognised.
  const actual = await importOriginal<typeof import('../../lib/api.js')>();
  return {
    ...actual,
    compileProject: vi.fn(async () => new ArrayBuffer(8)),
    forwardSearch: vi.fn(async () => undefined),
    inverseSearch: vi.fn(async () => undefined),
  };
});

/** The API module, mocked. */
const api = await import('../../lib/api.js');

/** The properties every test starts from. */
const BASE = {
  projectId: 'p1',
  source: '\\documentclass{article}',
  mainPath: 'main.tex',
  files: [],
  cursorLine: undefined as number | undefined,
  onJumpToSource: vi.fn(),
  autoBuild: true,
  buildRequest: 0,
};

describe('the preview panel', () => {
  beforeEach(() => {
    vi.mocked(api.inverseSearch).mockReset();
    vi.mocked(api.inverseSearch).mockResolvedValue(undefined);
    vi.mocked(api.forwardSearch).mockReset();
    vi.mocked(api.forwardSearch).mockResolvedValue(undefined);
    vi.mocked(api.compileProject).mockClear();
    vi.mocked(api.compileProject).mockResolvedValue(new ArrayBuffer(8));
  });

  it('builds the document on the server when the server mode is chosen', async () => {
    render(<PreviewPanel {...BASE} mode="server" />);

    await waitFor(() => {
      expect(api.compileProject).toHaveBeenCalledWith('p1', 'main.tex');
    });
  });

  it('does not build on the server when the WebAssembly mode is chosen', async () => {
    render(<PreviewPanel {...BASE} mode="wasm" />);

    // The debounce delays the build, so the wait is long enough for it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    expect(api.compileProject).not.toHaveBeenCalled();
  });

  it('shows a preview once the document is built', async () => {
    render(<PreviewPanel {...BASE} mode="server" />);

    await waitFor(() => {
      expect(screen.getByTestId('preview-panel')).toBeInTheDocument();
    });
  });

  it('asks the server where a source line is on the page', async () => {
    vi.mocked(api.forwardSearch).mockResolvedValue({
      source: { file: 'main.tex', line: 7 },
      position: { page: 1, x: 100, y: 700, width: 50, height: 20 },
    });

    render(<PreviewPanel {...BASE} mode="server" cursorLine={7} />);

    await waitFor(() => {
      expect(api.forwardSearch).toHaveBeenCalledWith('p1', 'main.tex', 7);
    });
  });

  it('does not search for a line when the WebAssembly mode is chosen', async () => {
    render(<PreviewPanel {...BASE} mode="wasm" cursorLine={7} />);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    expect(api.forwardSearch).not.toHaveBeenCalled();
  });

  it('does not build on its own when the automatic build is off', async () => {
    render(<PreviewPanel {...BASE} mode="server" autoBuild={false} />);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    expect(api.compileProject).not.toHaveBeenCalled();
  });

  it('builds when the reader asks for a build', async () => {
    const { rerender } = render(<PreviewPanel {...BASE} mode="server" autoBuild={false} />);

    // The counter changes, which is how the header's button reaches the
    // panel.
    rerender(<PreviewPanel {...BASE} mode="server" autoBuild={false} buildRequest={1} />);

    await waitFor(() => {
      expect(api.compileProject).toHaveBeenCalledWith('p1', 'main.tex');
    });
  });

  it('shows where a failed build went wrong and reports the errors', async () => {
    const onErrors = vi.fn();
    const diagnostic = {
      severity: 'error' as const,
      message: 'Extra }, or forgotten \\endgroup',
      file: 'sigconf.bbl',
      line: 149,
    };
    vi.mocked(api.compileProject).mockRejectedValue(
      new api.CompileFailedError(
        'Extra }, or forgotten \\endgroup (sigconf.bbl:149)',
        [diagnostic],
        '',
        'no-output',
      ),
    );

    render(<PreviewPanel {...BASE} mode="server" onErrors={onErrors} />);

    await waitFor(() => {
      expect(screen.getByTestId('compile-errors')).toBeInTheDocument();
    });

    // The diagnostic is shown with the file and the line it was found in.
    const list = screen.getByTestId('compile-errors');
    expect(list).toHaveTextContent('sigconf.bbl:149');
    expect(list).toHaveTextContent('Extra }, or forgotten \\endgroup');

    // And the errors reach the header, so the fix button can appear.
    expect(onErrors).toHaveBeenCalledWith([diagnostic]);
  });
});
