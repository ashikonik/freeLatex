/**
 * The coordinate maths of the SyncTeX overlay.
 *
 * SyncTeX reports a rectangle in PDF points, measured from the bottom-left
 * of the page. A browser draws from the top-left in CSS pixels, so every
 * position has to be converted before it can be drawn. The conversions live
 * here, apart from the drawing, so they can be tested on their own.
 */

/** A rectangle on the page, in PDF points. */
export interface SyncPosition {
  /** The 1-based page the rectangle is on. */
  page: number;
  /** Distance from the left edge of the page, in points. */
  x: number;
  /** Distance from the bottom edge of the page, in points. */
  y: number;
  /** Width of the box, in points. */
  width: number;
  /** Height of the box, in points. */
  height: number;
}

/** A rectangle on the screen, in CSS pixels. */
export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The size of a rendered page. */
export interface PageMetrics {
  /** The width of the page in CSS pixels. */
  width: number;
  /** The height of the page in CSS pixels. */
  height: number;
  /** The height of the page in PDF points. */
  pointHeight: number;
  /** The width of the page in PDF points. */
  pointWidth: number;
}

/**
 * The height of a US Letter page in PDF points.
 *
 * PDF points are 1/72 of an inch, and a Letter page is eleven inches tall.
 */
export const LETTER_POINT_HEIGHT = 792;

/**
 * The width of a US Letter page in PDF points.
 */
export const LETTER_POINT_WIDTH = 612;

/**
 * Convert a SyncTeX rectangle to a rectangle on the screen.
 *
 * The vertical axis is flipped: SyncTeX measures from the bottom of the page
 * and the browser measures from the top. The height of the box is kept, and
 * its top is placed at the height of the page minus the distance of the box's
 * bottom edge from the foot of the page.
 *
 * @param position The rectangle SyncTeX reported.
 * @param metrics The size of the rendered page.
 */
export function toScreenRect(position: SyncPosition, metrics: PageMetrics): ScreenRect {
  const scaleX = metrics.width / metrics.pointWidth;
  const scaleY = metrics.height / metrics.pointHeight;

  const left = position.x * scaleX;
  // The bottom edge of the box, measured from the top of the page.
  const bottomFromTop = metrics.height - position.y * scaleY;

  return {
    left,
    top: bottomFromTop - position.height * scaleY,
    width: position.width * scaleX,
    height: position.height * scaleY,
  };
}

/**
 * Convert a point on the screen back to PDF points.
 *
 * This is the inverse of `toScreenRect` for a single point, and it is what
 * the inverse search needs: the user clicks somewhere on the page, and the
 * server is asked which source line produced that spot.
 *
 * @param clientX The horizontal position within the page element.
 * @param clientY The vertical position within the page element.
 * @param metrics The size of the rendered page.
 */
export function toPdfPoint(
  clientX: number,
  clientY: number,
  metrics: PageMetrics,
): { x: number; y: number } {
  const scaleX = metrics.pointWidth / metrics.width;
  const scaleY = metrics.pointHeight / metrics.height;

  return {
    x: clientX * scaleX,
    // The browser measures from the top and SyncTeX from the bottom.
    y: metrics.pointHeight - clientY * scaleY,
  };
}

/**
 * The vertical offset of a page within a continuous scroll.
 *
 * A continuous viewer stacks the pages, so the offset of a page is the sum
 * of the heights of the pages before it, plus the gap between them.
 *
 * @param pageIndex The zero-based index of the page.
 * @param pageHeights The heights of the pages, in order.
 * @param gap The gap between two pages, in CSS pixels.
 */
export function pageOffset(
  pageIndex: number,
  pageHeights: number[],
  gap: number,
): number {
  let offset = 0;
  for (let index = 0; index < pageIndex && index < pageHeights.length; index += 1) {
    offset += (pageHeights[index] ?? 0) + gap;
  }
  return offset;
}

/**
 * The index of the page a scroll position falls on.
 *
 * @param scrollTop The distance scrolled from the top of the viewer.
 * @param pageHeights The heights of the pages, in order.
 * @param gap The gap between two pages, in CSS pixels.
 */
export function pageAtOffset(
  scrollTop: number,
  pageHeights: number[],
  gap: number,
): number {
  let offset = 0;
  for (let index = 0; index < pageHeights.length; index += 1) {
    const height = pageHeights[index] ?? 0;
    if (scrollTop < offset + height) {
      return index;
    }
    offset += height + gap;
  }
  // A scroll past the last page still shows the last one.
  return Math.max(0, pageHeights.length - 1);
}

/**
 * Clamp a zoom factor to the range the viewer supports.
 *
 * A zoom of zero would hide the page and a very large one would allocate a
 * canvas no browser can hold.
 */
export function clampZoom(zoom: number, min = 0.25, max = 4): number {
  if (!Number.isFinite(zoom)) {
    return 1;
  }
  return Math.min(Math.max(zoom, min), max);
}

/**
 * The zoom levels the viewer's buttons step through.
 */
export const ZOOM_STEPS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/**
 * The next zoom level above the current one.
 */
export function nextZoom(current: number): number {
  const clamped = clampZoom(current);
  const found = ZOOM_STEPS.find((step) => step > clamped);
  return found ?? ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? 1;
}

/**
 * The zoom level below the current one.
 */
export function previousZoom(current: number): number {
  const clamped = clampZoom(current);
  for (let index = ZOOM_STEPS.length - 1; index >= 0; index -= 1) {
    const step = ZOOM_STEPS[index];
    if (step !== undefined && step < clamped) {
      return step;
    }
  }
  return ZOOM_STEPS[0] ?? 1;
}
