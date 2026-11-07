import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

import { PreviewPanel } from './PreviewPanel.js';

vi.mock('../../lib/api.js', () => ({
  compileProject: vi.fn(async () => new ArrayBuffer(8)),
  forwardSearch: vi.fn(async () => undefined),
  inverseSearch: vi.fn(async () => undefined),
}));

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
};

describe('the preview panel', () => {
  beforeEach(() => {
    vi.mocked(api.inverseSearch).mockReset();
    vi.mocked(api.inverseSearch).mockResolvedValue(undefined);
    vi.mocked(api.forwardSearch).mockReset();
    vi.mocked(api.forwardSearch).mockResolvedValue(undefined);
    vi.mocked(api.compileProject).mockClear();
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
});
