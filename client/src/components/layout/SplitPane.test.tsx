import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { SplitPane } from './SplitPane.js';

/**
 * Give the container a size.
 *
 * jsdom reports every element as zero pixels wide, so the pane cannot work
 * out the ratio of a drag without this.
 */
function stubContainerWidth(width: number): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ): DOMRect {
    if ((this as HTMLElement).dataset.testid === 'split-pane') {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: width,
        bottom: 600,
        width,
        height: 600,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

/**
 * Move the pointer to a horizontal position.
 *
 * The pane listens for the move on the window, so the event is dispatched
 * there rather than on the handle.
 */
function movePointerTo(clientX: number): void {
  fireEvent.pointerMove(window, { clientX });
}

describe('the split pane', () => {
  it('renders all three panels', () => {
    render(
      <SplitPane
        left={<div>Files</div>}
        center={<div>Editor</div>}
        right={<div>Preview</div>}
      />,
    );

    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByText('Editor')).toBeInTheDocument();
    expect(screen.getByText('Preview')).toBeInTheDocument();
  });

  it('omits the right panel when none is given', () => {
    render(<SplitPane left={<div>Files</div>} center={<div>Editor</div>} />);

    expect(screen.getByText('Files')).toBeInTheDocument();
    // Only one handle is needed when there is no right panel.
    expect(screen.queryByTestId('split-handle-right')).not.toBeInTheDocument();
    expect(screen.getByTestId('split-handle-left')).toBeInTheDocument();
  });

  it('gives the panels a share of the width', () => {
    render(
      <SplitPane
        left={<div>Files</div>}
        center={<div>Editor</div>}
        right={<div>Preview</div>}
        initialLeftRatio={0.25}
        initialRightRatio={0.5}
        leftTestId="left-panel"
        rightTestId="right-panel"
      />,
    );

    expect(screen.getByTestId('left-panel')).toHaveStyle({ width: '25%' });
    expect(screen.getByTestId('right-panel')).toHaveStyle({ width: '50%' });
  });

  it('resizes the left panel when the handle is dragged', () => {
    stubContainerWidth(1000);

    render(
      <SplitPane
        left={<div>Files</div>}
        center={<div>Editor</div>}
        initialLeftRatio={0.2}
        leftTestId="left-panel"
      />,
    );

    const before = screen.getByTestId('left-panel').getAttribute('style');

    fireEvent.pointerDown(screen.getByTestId('split-handle-left'));
    movePointerTo(300);

    const after = screen.getByTestId('left-panel').getAttribute('style');
    expect(after).not.toBe(before);
    // 300 of 1000 pixels is thirty percent.
    expect(screen.getByTestId('left-panel')).toHaveStyle({ width: '30%' });
  });

  it('keeps a panel from being dragged below the minimum', () => {
    stubContainerWidth(1000);

    render(
      <SplitPane
        left={<div>Files</div>}
        center={<div>Editor</div>}
        initialLeftRatio={0.2}
        minRatio={0.1}
        leftTestId="left-panel"
      />,
    );

    fireEvent.pointerDown(screen.getByTestId('split-handle-left'));
    // Far to the left of the pane, which would make the panel vanish.
    movePointerTo(-500);

    expect(screen.getByTestId('left-panel')).toHaveStyle({ width: '10%' });
  });
});
