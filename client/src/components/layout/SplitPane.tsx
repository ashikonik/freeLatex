import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/** The properties of the split pane. */
export interface SplitPaneProps {
  /** The panel on the left. */
  left: ReactNode;
  /** The panel in the middle. */
  center?: ReactNode;
  /** The panel on the right. */
  right?: ReactNode;
  /** The share of the width the left panel takes, as a fraction. */
  initialLeftRatio?: number;
  /** The share of the width the right panel takes, as a fraction. */
  initialRightRatio?: number;
  /** The smallest a panel may be dragged to, as a fraction of the total. */
  minRatio?: number;
  /** Identifies the wrapper of the left panel. */
  leftTestId?: string;
  /** Identifies the wrapper of the right panel. */
  rightTestId?: string;
}

/**
 * A row of resizable panels.
 *
 * The panels are sized by a ratio of the total width rather than by pixels,
 * so the layout keeps its proportions when the window is resized.
 */
export function SplitPane({
  left,
  center,
  right,
  initialLeftRatio = 0.2,
  initialRightRatio = 0.35,
  minRatio = 0.1,
  leftTestId,
  rightTestId,
}: SplitPaneProps): React.ReactElement {
  const container = useRef<HTMLDivElement | null>(null);
  const [leftRatio, setLeftRatio] = useState(initialLeftRatio);
  const [rightRatio, setRightRatio] = useState(initialRightRatio);
  const dragging = useRef<'left' | 'right' | undefined>(undefined);

  const clamp = useCallback(
    (ratio: number): number => Math.min(Math.max(ratio, minRatio), 1 - minRatio),
    [minRatio],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent): void => {
      const element = container.current;
      const which = dragging.current;
      if (!element || !which) {
        return;
      }

      const bounds = element.getBoundingClientRect();
      if (bounds.width === 0) {
        return;
      }
      const offset = event.clientX - bounds.left;

      if (which === 'left') {
        setLeftRatio(clamp(offset / bounds.width));
      } else {
        setRightRatio(clamp((bounds.width - offset) / bounds.width));
      }
    },
    [clamp],
  );

  const stopDragging = useCallback((): void => {
    dragging.current = undefined;
  }, []);

  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDragging);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDragging);
    };
  }, [onPointerMove, stopDragging]);

  // The two handles must not share the width, so the centre panel takes
  // whatever is left over.
  const leftWidth = `${leftRatio * 100}%`;
  const rightWidth = `${rightRatio * 100}%`;

  return (
    <div ref={container} className="flex h-full w-full overflow-hidden" data-testid="split-pane">
      <div
        style={{ width: leftWidth }}
        data-testid={leftTestId}
        className="min-w-0 shrink-0 overflow-auto"
      >
        {left}
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the panels"
        data-testid="split-handle-left"
        onPointerDown={() => {
          dragging.current = 'left';
        }}
        className="w-1 shrink-0 cursor-col-resize bg-slate-200 hover:bg-slate-300"
      />

      <div className="min-w-0 flex-1 overflow-hidden">{center}</div>

      {right !== undefined ? (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the panels"
            data-testid="split-handle-right"
            onPointerDown={() => {
              dragging.current = 'right';
            }}
            className="w-1 shrink-0 cursor-col-resize bg-slate-200 hover:bg-slate-300"
          />
          <div
            style={{ width: rightWidth }}
            data-testid={rightTestId}
            className="min-w-0 shrink-0 overflow-auto"
          >
            {right}
          </div>
        </>
      ) : null}
    </div>
  );
}
