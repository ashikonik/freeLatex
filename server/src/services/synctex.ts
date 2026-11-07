import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

/**
 * `synctex-js` is a CommonJS package with no type declarations, so it is
 * loaded through `createRequire` and given a typed facade below. Importing it
 * with a plain `import` would pull an untyped namespace into a strict
 * TypeScript build.
 */
const require = createRequire(import.meta.url);

interface SynctexFile {
  path: string;
  name: string;
}

interface SynctexBox {
  type: string;
  fileNumber: number;
  file: SynctexFile;
  line: number;
  left: number;
  bottom: number;
  /** `null` when the compiler did not record a width for this box. */
  width: number | null;
  height: number;
  depth: number;
  page: number;
  blocks?: SynctexBox[];
  elements?: SynctexBox[];
}

interface SynctexPage {
  page: number;
  type: string;
  blocks: SynctexBox[];
}

interface SynctexDocument {
  version: string;
  files: Record<string, SynctexFile>;
  pages: Record<string, SynctexPage>;
  blockNumberLine: Record<string, Record<string, Record<string, SynctexBox[]>>>;
  numberPages: number;
}

interface SynctexParser {
  parseSyncTex: (body: string) => SynctexDocument;
}

/**
 * A rectangle on the page, in PDF points.
 *
 * The origin is the bottom-left of the page, which is what a PDF viewer
 * expects when it converts to screen coordinates.
 */
export interface SyncPosition {
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

/** A source location, identified relative to the project root. */
export interface SyncSourceLocation {
  /** The file, relative to the project root, e.g. "chapters/intro.tex". */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The page the location is on, when known. */
  page?: number;
}

/** The result of a forward search: source line to page position. */
export interface ForwardSearchResult {
  source: SyncSourceLocation;
  position: SyncPosition;
}

/** The result of an inverse search: page position to source line. */
export interface InverseSearchResult {
  position: SyncPosition;
  source: SyncSourceLocation;
}

/**
 * Raised when the SyncTeX data cannot be read.
 *
 * A dedicated type so a caller can tell "this document has no SyncTeX
 * information" from "the data was malformed".
 */
export class SyncTexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncTexError';
  }
}

/**
 * A box that can be hit by a click.
 *
 * The width is resolved at index time: the compiler records a glyph box with
 * an unknown width and a box of the same size that carries the width, so a
 * box without a width borrows one from its twin.
 */
interface HitBox {
  file: string;
  line: number;
  page: number;
  left: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * The SyncTeX engine of a compiled document.
 *
 * Both searches are served from an index built from the document's
 * `blockNumberLine` map, which lists every source line the compiler saw
 * together with the boxes it produced for it. The document's page tree is
 * used as a fallback for the width of a box whose own width is unknown.
 */
export class SyncTexEngine {
  private readonly document: SynctexDocument;
  /** Every hittable box, in document order. */
  private readonly boxes: HitBox[] = [];
  /** The first hittable box of each source line. */
  private readonly byLine = new Map<string, HitBox>();

  constructor(compressed: Buffer) {
    const body = decompress(compressed);
    this.document = parse(body);
    this.index();
  }

  /** The number of pages the document has. */
  get pageCount(): number {
    return this.document.numberPages;
  }

  /** The file names the compiler recorded, relative to the project root. */
  get fileNames(): string[] {
    return Object.values(this.document.files).map((file) => file.name);
  }

  /**
   * Find where a source line appears on the page.
   *
   * This is the "forward" jump: the user clicks a line in the editor and the
   * viewer scrolls to it.
   *
   * @param file The source file, relative to the project root.
   * @param line The 1-based line number.
   * @returns The position, or undefined when the line produced no output.
   */
  forwardSearch(file: string, line: number): ForwardSearchResult | undefined {
    const box = this.byLine.get(lineKey(file, line));
    if (!box) {
      return undefined;
    }

    return {
      source: { file, line, page: box.page },
      position: toPosition(box),
    };
  }

  /**
   * Find which source line produced a point on the page.
   *
   * This is the "inverse" jump: the user clicks in the PDF and the editor
   * moves to the line that produced it.
   *
   * @param x Distance from the left edge of the page, in points.
   * @param y Distance from the bottom edge of the page, in points.
   * @param page The 1-based page number.
   */
  inverseSearch(x: number, y: number, page: number): InverseSearchResult | undefined {
    // The box that contains the point and is smallest wins: a small box is a
    // more precise answer than the large block that encloses it.
    let best: HitBox | undefined;
    let bestArea = Number.POSITIVE_INFINITY;

    for (const box of this.boxes) {
      if (box.page !== page) {
        continue;
      }
      if (!containsPoint(box, x, y)) {
        continue;
      }
      const area = box.width * box.height;
      if (area < bestArea) {
        best = box;
        bestArea = area;
      }
    }

    if (!best) {
      return undefined;
    }

    return {
      position: toPosition(best),
      source: {
        file: best.file,
        line: best.line,
        page: best.page,
      },
    };
  }

  /**
   * Build the search index.
   *
   * Two structures in the document are combined:
   *
   * - `blockNumberLine` lists every source line the compiler saw, with the
   *   boxes it produced. It is the only place that covers *every* line, so
   *   it decides which lines exist.
   * - The page tree and the wider boxes carry the real geometry. A glyph
   *   box in `blockNumberLine` has an exact position but usually no width.
   *
   * A box without a width therefore borrows the width of the box that shares
   * its vertical band — the same bottom and height — which is what turns a
   * marker into a rectangle that a click can hit.
   */
  private index(): void {
    // Widths by vertical band, taken from every box the document records.
    const widths = new Map<string, number>();

    for (const page of Object.values(this.document.pages)) {
      for (const block of page.blocks) {
        collectWidths(block, widths);
      }
    }
    for (const byLine of Object.values(this.document.blockNumberLine)) {
      for (const byPage of Object.values(byLine)) {
        for (const boxes of Object.values(byPage)) {
          for (const box of boxes) {
            recordWidth(box, widths);
          }
        }
      }
    }

    for (const [fileName, byLine] of Object.entries(this.document.blockNumberLine)) {
      const file = normalizeFileName(fileName);
      for (const [line, byPage] of Object.entries(byLine)) {
        const lineNumber = Number(line);
        if (!Number.isInteger(lineNumber) || lineNumber < 1) {
          continue;
        }

        for (const [page, boxes] of Object.entries(byPage)) {
          for (const box of boxes) {
            const width =
              box.width ?? widths.get(bandKey(box.bottom, box.height)) ?? 0;

            // A box with neither a width nor a height covers no area, so it
            // cannot be the answer to a click.
            if (width <= 0 && box.height <= 0) {
              continue;
            }

            const hit: HitBox = {
              file,
              line: lineNumber,
              page: Number(page),
              left: box.left,
              bottom: box.bottom,
              width,
              height: box.height,
            };

            this.boxes.push(hit);

            // The first box of a line is the start of that line, which is
            // what a forward jump wants.
            const key = lineKey(file, lineNumber);
            if (!this.byLine.has(key)) {
              this.byLine.set(key, hit);
            }
          }
        }
      }
    }
  }
}

/**
 * Record the width of a box, keyed by its vertical band.
 *
 * The smallest width at a band wins: it is the tightest rectangle around
 * the content there, and it is the one a click on that content should hit.
 */
function recordWidth(box: SynctexBox, widths: Map<string, number>): void {
  if (box.width === null || box.width <= 0) {
    return;
  }
  const key = bandKey(box.bottom, box.height);
  const existing = widths.get(key);
  if (existing === undefined || box.width < existing) {
    widths.set(key, box.width);
  }
}

/** Record the widths of a page tree. */
function collectWidths(box: SynctexBox, widths: Map<string, number>): void {
  recordWidth(box, widths);
  for (const child of box.blocks ?? []) {
    collectWidths(child, widths);
  }
}

/** The key under which a source line is indexed. */
function lineKey(file: string, line: number): string {
  return `${file}:${line}`;
}

/**
 * The key under which a box's width is remembered.
 *
 * A box is identified by its vertical band — the bottom and height it
 * occupies — because that is what a line of text shares with the boxes that
 * describe the extent of that line.
 */
function bandKey(bottom: number, height: number): string {
  // The coordinates are rounded so that two boxes that differ only in
  // floating-point noise share a key.
  return `${bottom.toFixed(2)}:${height.toFixed(2)}`;
}

/** Decompress the `.synctex.gz` payload. */
function decompress(compressed: Buffer): string {
  try {
    return gunzipSync(compressed).toString('utf8');
  } catch (error) {
    throw new SyncTexError(
      `Could not decompress the SyncTeX data: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

/**
 * Parse the SyncTeX body with the third-party parser.
 *
 * The parser is forgiving: given something that is not SyncTeX at all it
 * returns an empty document rather than failing. The result is therefore
 * validated — a document with no files is not a document this compiler
 * produced.
 */
function parse(body: string): SynctexDocument {
  let parser: SynctexParser;
  try {
    ({ parser } = require('synctex-js') as { parser: SynctexParser });
  } catch (error) {
    throw new SyncTexError(
      `Could not load the SyncTeX parser: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  let document: SynctexDocument;
  try {
    document = parser.parseSyncTex(body);
  } catch (error) {
    throw new SyncTexError(
      `Could not parse the SyncTeX data: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  if (!document || typeof document !== 'object') {
    throw new SyncTexError('The SyncTeX data is malformed.');
  }

  // A real SyncTeX file always records its files. An empty result means the
  // parser was handed something else entirely.
  if (Object.keys(document.files ?? {}).length === 0) {
    throw new SyncTexError('The SyncTeX data is malformed.');
  }

  return document;
}

/** Convert an indexed box into a page position. */
function toPosition(box: HitBox): SyncPosition {
  return {
    page: box.page,
    x: box.left,
    y: box.bottom,
    width: box.width,
    height: box.height,
  };
}

/** True when the point lies inside the box. */
function containsPoint(box: HitBox, x: number, y: number): boolean {
  // A box with no width is a zero-width marker; it can still be hit.
  if (box.width === 0) {
    return (
      Math.abs(x - box.left) <= 2 &&
      Math.abs(y - box.bottom) <= Math.max(box.height, 2)
    );
  }
  return (
    x >= box.left &&
    x <= box.left + box.width &&
    y >= box.bottom &&
    y <= box.bottom + box.height
  );
}

/**
 * Normalise a recorded file name to a project-relative POSIX path.
 *
 * The compiler records absolute paths; the API speaks project-relative ones.
 */
function normalizeFileName(name: string): string {
  return name.replace(/\\/g, '/');
}
