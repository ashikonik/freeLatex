import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { normalize } from 'node:path';

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
 *
 * The compiler records absolute paths, so the engine is told the project's
 * root and reports file names relative to it.
 */
export class SyncTexEngine {
  private readonly document: SynctexDocument;
  /** Every hittable box, in document order. */
  private readonly boxes: HitBox[] = [];
  /** The first hittable box of each source line. */
  private readonly byLine = new Map<string, HitBox>();

  /**
   * @param compressed The `.synctex.gz` payload.
   * @param projectRoot The absolute path of the project directory, used to
   * turn the compiler's absolute file paths into project-relative ones.
   */
  constructor(compressed: Buffer, projectRoot?: string) {
    const body = decompress(compressed);
    this.document = parse(body);
    this.projectRoot = projectRoot ? normalize(projectRoot) : undefined;
    this.index();
  }

  /** The absolute path of the project directory, when the engine knows it. */
  private readonly projectRoot: string | undefined;

  /** The number of pages the document has. */
  get pageCount(): number {
    return this.document.numberPages;
  }

  /**
   * The file names the compiler recorded, relative to the project root.
   *
   * The compiler records a file's full path and a bare name. Two files in
   * different directories can share a name, so the name alone is not enough
   * to address a file; the path relative to the project root is.
   */
  get fileNames(): string[] {
    return Object.values(this.document.files).map((file) => this.relativePath(file));
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
   *
   * The map is keyed by a file's *bare name*, so two files that share a name
   * in different directories appear under one key. Each box therefore names
   * its own file through its file number, and the file number is what
   * decides which file a box belongs to.
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

    for (const byLine of Object.values(this.document.blockNumberLine)) {
      for (const [line, byPage] of Object.entries(byLine)) {
        const lineNumber = Number(line);
        if (!Number.isInteger(lineNumber) || lineNumber < 1) {
          continue;
        }

        for (const [page, boxes] of Object.entries(byPage)) {
          for (const box of boxes) {
            const file = this.fileOf(box);
            if (!file) {
              continue;
            }

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

  /**
   * The project-relative path of the file a box belongs to.
   *
   * The box names its file by number, which is the only way to tell two
   * files that share a base name apart.
   */
  private fileOf(box: SynctexBox): string | undefined {
    const file = this.document.files[String(box.fileNumber)];
    if (file) {
      return this.relativePath(file);
    }

    // A box that names its file directly still identifies it.
    if (box.file?.name) {
      return this.relativePath(box.file);
    }

    return undefined;
  }

  /**
   * Turn a recorded file into a project-relative path.
   *
   * The compiler records an absolute path and a bare name. The path is
   * preferred, because two files can share a name; the name is the fallback
   * for a file whose path could not be related to the project root.
   */
  private relativePath(file: SynctexFile): string {
    const path = normalizeFileName(file.path ?? '');
    if (path && this.projectRoot) {
      const relative = relativePathFrom(this.projectRoot, path);
      if (relative && !relative.startsWith('..')) {
        return relative;
      }
    }
    return normalizeFileName(file.name ?? path);
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

  // A real SyncTeX file always records its files and the pages it laid out.
  // An empty result means the parser was handed something else entirely:
  // the parser is forgiving and returns an empty document rather than
  // failing, so the result has to be checked.
  if (Object.keys(document.files ?? {}).length === 0) {
    throw new SyncTexError('The SyncTeX data is malformed.');
  }

  if (!Number.isInteger(document.numberPages) || document.numberPages < 1) {
    throw new SyncTexError('The SyncTeX data is malformed.');
  }

  // A document with pages but no boxes at all carries no usable positions.
  if (Object.keys(document.blockNumberLine ?? {}).length === 0) {
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
 * Normalise a recorded file name to a POSIX path.
 *
 * The compiler records paths with the host's separators.
 */
function normalizeFileName(name: string): string {
  return name.replace(/\\/g, '/');
}

/**
 * The path of a file relative to a root directory.
 *
 * Returns an empty string when the file lies outside the root, so that the
 * caller can tell "inside the project" from "somewhere else".
 */
function relativePathFrom(root: string, path: string): string {
  const normalizedRoot = normalize(root);
  const normalizedPath = normalize(path);
  if (normalizedPath === normalizedRoot) {
    return '';
  }
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return '';
  }
  return normalizedPath.slice(normalizedRoot.length + 1);
}
