import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { SyncTeXOverlay } from './SyncTeXOverlay.js';
import { LETTER_POINT_HEIGHT, LETTER_POINT_WIDTH } from './synctex-math.js';

/** The metrics of a page rendered at its natural size. */
const LETTER = {
  width: LETTER_POINT_WIDTH,
  height: LETTER_POINT_HEIGHT,
  pointWidth: LETTER_POINT_WIDTH,
  pointHeight: LETTER_POINT_HEIGHT,
};

describe('the SyncTeX highlight', () => {
  it('draws nothing when there is no position', () => {
    render(<SyncTeXOverlay position={undefined} metrics={LETTER} />);

    expect(screen.queryByTestId('synctex-overlay')).not.toBeInTheDocument();
  });

  it('draws nothing when the page has no size yet', () => {
    render(
      <SyncTeXOverlay
        position={{ page: 1, x: 10, y: 10, width: 10, height: 10 }}
        metrics={{ width: 0, height: 0, pointWidth: 612, pointHeight: 792 }}
      />,
    );

    expect(screen.queryByTestId('synctex-overlay')).not.toBeInTheDocument();
  });

  it('draws the box where SyncTeX put it', () => {
    render(
      <SyncTeXOverlay
        position={{ page: 1, x: 100, y: 700, width: 50, height: 20 }}
        metrics={LETTER}
      />,
    );

    const overlay = screen.getByTestId('synctex-overlay');

    expect(overlay).toHaveStyle({ left: '100px', top: '72px', width: '50px', height: '20px' });
  });

  it('scales the box with the rendered page', () => {
    render(
      <SyncTeXOverlay
        position={{ page: 1, x: 100, y: 700, width: 50, height: 20 }}
        metrics={{
          width: LETTER_POINT_WIDTH * 2,
          height: LETTER_POINT_HEIGHT * 2,
          pointWidth: LETTER_POINT_WIDTH,
          pointHeight: LETTER_POINT_HEIGHT,
        }}
      />,
    );

    const overlay = screen.getByTestId('synctex-overlay');

    expect(overlay).toHaveStyle({ left: '200px', width: '100px', height: '40px' });
  });

  it('moves the box down to the page it belongs to', () => {
    render(
      <SyncTeXOverlay
        position={{ page: 3, x: 100, y: 700, width: 50, height: 20 }}
        metrics={LETTER}
        offsetTop={1600}
      />,
    );

    const overlay = screen.getByTestId('synctex-overlay');

    expect(overlay).toHaveStyle({ top: '1672px' });
  });

  it('reports the click on the highlighted area as a PDF point', () => {
    const onClick = vi.fn();
    render(
      <SyncTeXOverlay
        position={{ page: 1, x: 100, y: 700, width: 50, height: 20 }}
        metrics={LETTER}
        onClick={onClick}
      />,
    );

    fireEvent.click(screen.getByLabelText('Jump to the source'));

    // The click lands in the middle of the box, so the point is the middle
    // of the box in PDF points.
    expect(onClick).toHaveBeenCalledWith(125, 710);
  });

  it('has no button when there is nothing to jump to', () => {
    render(
      <SyncTeXOverlay
        position={{ page: 1, x: 100, y: 700, width: 50, height: 20 }}
        metrics={LETTER}
      />,
    );

    expect(screen.queryByLabelText('Jump to the source')).not.toBeInTheDocument();
  });
});
