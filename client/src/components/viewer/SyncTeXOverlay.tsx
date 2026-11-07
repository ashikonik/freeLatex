import { useEffect, useState } from 'react';

import {
  toPdfPoint,
  toScreenRect,
  type PageMetrics,
  type SyncPosition,
} from './synctex-math.js';

/** The properties of the overlay. */
export interface SyncTeXOverlayProps {
  /** The position to highlight, or undefined when there is none. */
  position: SyncPosition | undefined;
  /** The size of the rendered page, in CSS pixels and PDF points. */
  metrics: PageMetrics;
  /**
   * How far down the scroll the page holding the highlight sits.
   *
   * A document has many pages and the highlight belongs to one of them, so
   * the box has to be moved down by the pages above it.
   */
  offsetTop?: number;
  /** Called when the reader clicks inside the highlighted area. */
  onClick?: (x: number, y: number) => void;
}

/**
 * The SyncTeX highlight.
 *
 * The overlay draws the rectangle that SyncTeX reported for the current
 * source line. It sits over the page, so it must not swallow the clicks that
 * the viewer needs for the inverse jump — the click handler only fires for a
 * click inside the highlighted box.
 */
export function SyncTeXOverlay({
  position,
  metrics,
  offsetTop = 0,
  onClick,
}: SyncTeXOverlayProps): React.ReactElement | null {
  if (!position || metrics.width === 0 || metrics.height === 0) {
    return null;
  }

  const rect = toScreenRect(position, metrics);

  return (
    <div
      data-testid="synctex-overlay"
      className="pointer-events-none absolute rounded-sm border-2 border-amber-400 bg-amber-300/20"
      style={{
        left: `${rect.left}px`,
        top: `${rect.top + offsetTop}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      }}
    >
      {onClick ? (
        <button
          type="button"
          aria-label="Jump to the source"
          onClick={() => {
            const point = toPdfPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
              metrics,
            );
            onClick(point.x, point.y);
          }}
          className="pointer-events-auto absolute inset-0 cursor-pointer bg-transparent"
        />
      ) : null}
    </div>
  );
}

/** The properties of the forward-sync hook's result. */
export interface ForwardSyncState {
  /** The position to highlight. */
  position: SyncPosition | undefined;
  /** Whether a search is in flight. */
  searching: boolean;
  /** The error of the last failed search. */
  error: string | undefined;
}

/**
 * Track the SyncTeX position of a source line.
 *
 * The search runs whenever the line changes, and the previous position is
 * dropped while the new one is being looked up, so the highlight does not
 * linger on a line the reader has already left.
 */
export function useForwardSync(
  search: ((file: string, line: number) => Promise<SyncPosition | undefined>) | undefined,
  file: string | undefined,
  line: number | undefined,
): ForwardSyncState {
  const [state, setState] = useState<ForwardSyncState>({
    position: undefined,
    searching: false,
    error: undefined,
  });

  useEffect(() => {
    if (!search || !file || line === undefined || line < 1) {
      setState({ position: undefined, searching: false, error: undefined });
      return;
    }

    let cancelled = false;
    setState({ position: undefined, searching: true, error: undefined });

    void search(file, line)
      .then((position) => {
        if (cancelled) {
          return;
        }
        setState({ position, searching: false, error: undefined });
      })
      .catch((cause: unknown) => {
        if (cancelled) {
          return;
        }
        setState({
          position: undefined,
          searching: false,
          error: cause instanceof Error ? cause.message : 'The SyncTeX search failed.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [search, file, line]);

  return state;
}
