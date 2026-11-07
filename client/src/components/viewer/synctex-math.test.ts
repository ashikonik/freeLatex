import { describe, expect, it } from 'vitest';

import {
  LETTER_POINT_HEIGHT,
  LETTER_POINT_WIDTH,
  clampZoom,
  nextZoom,
  pageAtOffset,
  pageOffset,
  previousZoom,
  toPdfPoint,
  toScreenRect,
  type PageMetrics,
} from './synctex-math.js';

/** A page rendered at twice its point size. */
const DOUBLE: PageMetrics = {
  width: LETTER_POINT_WIDTH * 2,
  height: LETTER_POINT_HEIGHT * 2,
  pointWidth: LETTER_POINT_WIDTH,
  pointHeight: LETTER_POINT_HEIGHT,
};

describe('the SyncTeX rectangle', () => {
  it('scales a point rectangle to the screen', () => {
    const rect = toScreenRect({ page: 1, x: 100, y: 100, width: 50, height: 20 }, DOUBLE);

    expect(rect.left).toBe(200);
    expect(rect.width).toBe(100);
    expect(rect.height).toBe(40);
  });

  it('flips the vertical axis', () => {
    // A box at the foot of the page is drawn near the bottom of the screen.
    const rect = toScreenRect({ page: 1, x: 0, y: 0, width: 10, height: 10 }, DOUBLE);

    // The box's bottom edge is at the foot of the page, so its top edge is
    // one box-height above it.
    expect(rect.top).toBe(DOUBLE.height - 20);
    expect(rect.top + rect.height).toBe(DOUBLE.height);
  });

  it('puts a box at the head of the page near the top of the screen', () => {
    // The box's bottom edge is ten points below the head of the page.
    const rect = toScreenRect(
      { page: 1, x: 0, y: LETTER_POINT_HEIGHT - 10, width: 10, height: 10 },
      DOUBLE,
    );

    expect(rect.top).toBe(0);
  });

  it('places a box at the point it came from', () => {
    const rect = toScreenRect({ page: 1, x: 100, y: 200, width: 50, height: 20 }, DOUBLE);

    // The bottom edge of the drawn box is where SyncTeX put the box's
    // bottom edge.
    expect(rect.top + rect.height).toBe(DOUBLE.height - 400);
  });

  it('scales differently on the two axes when the page is stretched', () => {
    const rect = toScreenRect(
      { page: 1, x: 100, y: 100, width: 50, height: 20 },
      { width: 1000, height: 500, pointWidth: 612, pointHeight: 792 },
    );

    expect(rect.width).toBeCloseTo((50 * 1000) / 612);
    expect(rect.height).toBeCloseTo((20 * 500) / 792);
  });
});

describe('a click on the page', () => {
  it('converts the click back to a PDF point', () => {
    const point = toPdfPoint(200, 400, DOUBLE);

    expect(point.x).toBe(100);
    expect(point.y).toBe(LETTER_POINT_HEIGHT - 200);
  });

  it('round-trips a position through the two conversions', () => {
    const original = { page: 1, x: 123, y: 456, width: 10, height: 10 };
    const rect = toScreenRect(original, DOUBLE);

    // The centre of the drawn box is the centre of the original box.
    const point = toPdfPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, DOUBLE);

    expect(point.x).toBeCloseTo(original.x + original.width / 2);
    expect(point.y).toBeCloseTo(original.y + original.height / 2);
  });

  it('maps the top-left corner to the top-left of the page', () => {
    const point = toPdfPoint(0, 0, DOUBLE);

    expect(point.x).toBe(0);
    expect(point.y).toBe(LETTER_POINT_HEIGHT);
  });
});

describe('the pages of a continuous scroll', () => {
  it('offsets a page by the pages before it', () => {
    expect(pageOffset(0, [100, 200, 300], 10)).toBe(0);
    expect(pageOffset(1, [100, 200, 300], 10)).toBe(110);
    expect(pageOffset(2, [100, 200, 300], 10)).toBe(320);
  });

  it('treats a page beyond the end as the last one', () => {
    // The offset runs over every page there is, and no further.
    expect(pageOffset(9, [100, 200], 10)).toBe(320);
  });

  it('finds the page a scroll position falls on', () => {
    expect(pageAtOffset(0, [100, 200, 300], 10)).toBe(0);
    expect(pageAtOffset(50, [100, 200, 300], 10)).toBe(0);
    expect(pageAtOffset(150, [100, 200, 300], 10)).toBe(1);
    expect(pageAtOffset(400, [100, 200, 300], 10)).toBe(2);
  });

  it('shows the last page when the scroll runs past the end', () => {
    expect(pageAtOffset(10_000, [100, 200], 10)).toBe(1);
  });
});

describe('the zoom', () => {
  it('keeps the zoom within the supported range', () => {
    expect(clampZoom(0.01)).toBe(0.25);
    expect(clampZoom(100)).toBe(4);
    expect(clampZoom(1.5)).toBe(1.5);
  });

  it('falls back to full size for a zoom that is not a number', () => {
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it('steps up to the next level', () => {
    expect(nextZoom(1)).toBe(1.25);
    expect(nextZoom(1.25)).toBe(1.5);
  });

  it('stays at the largest level when it is already there', () => {
    expect(nextZoom(3)).toBe(3);
  });

  it('steps down to the previous level', () => {
    expect(previousZoom(1.5)).toBe(1.25);
    expect(previousZoom(1.25)).toBe(1);
  });

  it('stays at the smallest level when it is already there', () => {
    expect(previousZoom(0.5)).toBe(0.5);
  });
});
