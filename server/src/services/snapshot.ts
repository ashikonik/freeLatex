import { createHash } from 'node:crypto';
import { eq, desc, sql } from 'drizzle-orm';
import { createTwoFilesPatch, diffLines } from 'diff';
import { nanoid } from 'nanoid';

import { projectSnapshots, type ProjectSnapshot } from '../db/schema.js';
import type { Db } from '../db/index.js';
import type { ProjectStorage } from './storage.js';

/**
 * A snapshot's file map: project-relative path -> file content.
 *
 * Text files hold their content verbatim. Binary files hold base64, so a
 * restore can decode them back to the exact bytes they had.
 */
export interface SnapshotFiles {
  text: Record<string, string>;
  binary: Record<string, string>;
}

/** Summary of one revision, without the file payload. */
export interface SnapshotSummary {
  id: string;
  projectId: string;
  label: string;
  hash: string;
  createdBy: string | null;
  createdAt: string;
  /** Number of files captured in the snapshot. */
  fileCount: number;
}

/** The unified diff of one file between two snapshots. */
export interface FileDiff {
  path: string;
  /** 'added' when the file only exists in B, 'removed' when only in A. */
  changeType: 'added' | 'removed' | 'modified';
  /** Unified diff text. Empty when the file is unchanged. */
  patch: string;
  /** Number of added lines, excluding the diff header. */
  addedLines: number;
  /** Number of removed lines, excluding the diff header. */
  removedLines: number;
}

/**
 * Raised when a snapshot id does not belong to the requested project.
 *
 * A dedicated type so the routes can answer 404 for a missing snapshot and
 * let every other failure reach the global error handler as a 500.
 */
export class SnapshotNotFoundError extends Error {
  constructor(message = 'Snapshot not found.') {
    super(message);
    this.name = 'SnapshotNotFoundError';
  }
}

/**
 * Raised when a stored snapshot payload cannot be parsed.
 *
 * Reading a corrupt snapshot may degrade gracefully, but *restoring* one must
 * not: an empty file map would delete every file in the project.
 */
export class CorruptSnapshotError extends Error {
  constructor(message = 'The stored snapshot is corrupt.') {
    super(message);
    this.name = 'CorruptSnapshotError';
  }
}

/**
 * Maximum number of snapshots kept per project.
 *
 * Every snapshot duplicates the whole project, so the history has to be
 * bounded. The oldest revisions are dropped once the limit is reached.
 */
const MAX_SNAPSHOTS_PER_PROJECT = 100;

/**
 * In-product version control.
 *
 * A snapshot is a frozen copy of every file in a project, stored as JSON in
 * the database. Snapshots give the workspace a revision history that works
 * offline and needs no external VCS, which is what a self-hosted Overleaf
 * replacement needs.
 */
export class SnapshotService {
  constructor(
    private readonly db: Db,
    private readonly storage: ProjectStorage,
  ) {}

  /**
   * Capture the current state of a project.
   *
   * The label is what the user sees in the history list, so it defaults to
   * something meaningful rather than an empty string.
   */
  async createSnapshot(
    projectId: string,
    label: string,
    createdBy: string | null,
  ): Promise<SnapshotSummary> {
    const files = await this.storage.readAllFiles(projectId);
    const snapshotData = JSON.stringify(files);
    const hash = hashSnapshot(files);

    const id = `snap_${nanoid(12)}`;
    const finalLabel = label.trim() || defaultLabel();
    const createdAt = new Date();

    this.db
      .insert(projectSnapshots)
      .values({
        id,
        projectId,
        label: finalLabel,
        snapshotData,
        hash,
        createdBy,
        createdAt,
      })
      .run();

    this.pruneOldSnapshots(projectId);

    return {
      id,
      projectId,
      label: finalLabel,
      hash,
      createdBy,
      createdAt: createdAt.toISOString(),
      fileCount: Object.keys(files.text).length + Object.keys(files.binary).length,
    };
  }

  /**
   * List a project's revisions, newest first.
   *
   * The row id is the tiebreaker: two snapshots captured within the same
   * millisecond would otherwise come back in an arbitrary order. SQLite's
   * `rowid` is monotonic with insertion, which the random snapshot id is not.
   */
  listSnapshots(projectId: string): SnapshotSummary[] {
    const rows = this.db
      .select()
      .from(projectSnapshots)
      .where(eq(projectSnapshots.projectId, projectId))
      .orderBy(desc(projectSnapshots.createdAt), desc(sql`rowid`))
      .all();

    return rows.map((row) => toSummary(row));
  }

  /**
   * Fetch one snapshot's metadata and file map.
   *
   * @throws SnapshotNotFoundError when the snapshot does not exist or belongs
   * to another project.
   */
  getSnapshot(projectId: string, snapshotId: string): {
    summary: SnapshotSummary;
    files: SnapshotFiles;
  } {
    const row = this.findSnapshot(projectId, snapshotId);
    return { summary: toSummary(row), files: parseSnapshotData(row.snapshotData) };
  }

  /**
   * Compute the diff between two snapshots.
   *
   * Passing the same snapshot twice yields an empty diff, which is what a
   * client wants when it renders "no changes since this revision".
   */
  computeDiff(
    projectId: string,
    snapshotIdA: string,
    snapshotIdB: string,
  ): FileDiff[] {
    const before = parseSnapshotData(this.findSnapshot(projectId, snapshotIdA).snapshotData);
    const after = parseSnapshotData(this.findSnapshot(projectId, snapshotIdB).snapshotData);

    const paths = new Set([
      ...Object.keys(before.text),
      ...Object.keys(after.text),
      ...Object.keys(before.binary),
      ...Object.keys(after.binary),
    ]);
    const diffs: FileDiff[] = [];

    for (const path of [...paths].sort()) {
      const oldContent = before.text[path];
      const newContent = after.text[path];
      const oldBinary = before.binary[path];
      const newBinary = after.binary[path];

      const existedBefore = oldContent !== undefined || oldBinary !== undefined;
      const existsAfter = newContent !== undefined || newBinary !== undefined;

      // A file that exists in only one snapshot was added or removed outright.
      if (!existedBefore || !existsAfter) {
        const addedBinary = newBinary !== undefined;
        const removedBinary = oldBinary !== undefined;

        // A binary file has no line diff, so it is reported with a marker
        // rather than an empty patch that looks like "no change".
        const patch =
          addedBinary || removedBinary
            ? binaryPatch(path, existedBefore ? 'removed' : 'added')
            : createTwoFilesPatch(
                path,
                path,
                oldContent ?? '',
                newContent ?? '',
                undefined,
                undefined,
                { context: 3 },
              );

        diffs.push({
          path,
          changeType: existedBefore ? 'removed' : 'added',
          patch,
          addedLines: existedBefore ? 0 : addedBinary ? 0 : countLines(newContent ?? ''),
          removedLines: existedBefore ? (removedBinary ? 0 : countLines(oldContent ?? '')) : 0,
        });
        continue;
      }

      // A binary file is compared by its bytes, not by a line diff.
      if (oldBinary !== undefined || newBinary !== undefined) {
        if (oldBinary === newBinary) {
          continue;
        }
        diffs.push({
          path,
          changeType: 'modified',
          patch: binaryPatch(path),
          addedLines: 0,
          removedLines: 0,
        });
        continue;
      }

      if (oldContent === newContent) {
        continue;
      }

      // The counts come from the structured diff, not from parsing the patch
      // text: a content line that happens to start with "+++" would otherwise
      // be mistaken for a file header and silently dropped.
      const { addedLines, removedLines } = countChangedLines(oldContent ?? '', newContent ?? '');

      diffs.push({
        path,
        changeType: 'modified',
        patch: createTwoFilesPatch(
          path,
          path,
          oldContent ?? '',
          newContent ?? '',
          undefined,
          undefined,
          { context: 3 },
        ),
        addedLines,
        removedLines,
      });
    }

    return diffs;
  }

  /**
   * Restore a project's files to a snapshot's contents.
   *
   * Files created after the snapshot are removed, so the project matches the
   * snapshot exactly rather than becoming a merge.
   *
   * @throws SnapshotNotFoundError when the snapshot does not exist.
   * @throws CorruptSnapshotError when the stored payload cannot be read; the
   * project is left untouched in that case rather than emptied.
   */
  async rollbackToSnapshot(projectId: string, snapshotId: string): Promise<number> {
    const row = this.findSnapshot(projectId, snapshotId);
    const files = parseSnapshotData(row.snapshotData, { strict: true });

    await this.storage.writeAllFiles(projectId, files);
    return Object.keys(files.text).length + Object.keys(files.binary).length;
  }

  /**
   * Find a snapshot belonging to a project.
   *
   * The project id is part of the lookup so a snapshot from another project
   * can never be read or restored through this project.
   */
  private findSnapshot(projectId: string, snapshotId: string): ProjectSnapshot {
    const row = this.db
      .select()
      .from(projectSnapshots)
      .where(eq(projectSnapshots.id, snapshotId))
      .get();

    if (!row || row.projectId !== projectId) {
      throw new SnapshotNotFoundError();
    }

    return row;
  }

  /**
   * Drop the oldest snapshots once a project's history grows too long.
   *
   * Every snapshot holds a full copy of the project, so an unbounded history
   * would fill the database.
   */
  private pruneOldSnapshots(projectId: string): void {
    const rows = this.db
      .select({ id: projectSnapshots.id })
      .from(projectSnapshots)
      .where(eq(projectSnapshots.projectId, projectId))
      .orderBy(desc(projectSnapshots.createdAt), desc(sql`rowid`))
      .all();

    const excess = rows.slice(MAX_SNAPSHOTS_PER_PROJECT);
    for (const row of excess) {
      this.db.delete(projectSnapshots).where(eq(projectSnapshots.id, row.id)).run();
    }
  }
}

/**
 * Hash a snapshot's file map.
 *
 * The hash is computed over the sorted paths and their contents so that two
 * snapshots of identical content hash the same regardless of file order.
 *
 * The encoding is part of the hash input: a text file and a binary file with
 * the same bytes must not hash the same, or a project that converts a file
 * from text to binary would look unchanged.
 */
function hashSnapshot(files: SnapshotFiles): string {
  const hash = createHash('sha256');
  const entries: { path: string; kind: 'text' | 'binary'; content: string }[] = [
    ...Object.entries(files.text).map(([path, content]) => ({ path, kind: 'text' as const, content })),
    ...Object.entries(files.binary).map(([path, content]) => ({
      path,
      kind: 'binary' as const,
      content,
    })),
  ];
  for (const entry of entries.sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path);
    hash.update('\0');
    hash.update(entry.kind);
    hash.update('\0');
    hash.update(entry.content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Parse a stored snapshot payload.
 *
 * In non-strict mode a corrupt row yields an empty snapshot so that reading
 * the history never takes the whole list down. In strict mode the parse
 * failure is raised instead — restoring a corrupt snapshot would otherwise
 * delete every file in the project.
 */
function parseSnapshotData(snapshotData: string, options?: { strict?: boolean }): SnapshotFiles {
  const empty: SnapshotFiles = { text: {}, binary: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotData);
  } catch {
    if (options?.strict) {
      throw new CorruptSnapshotError();
    }
    return empty;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (options?.strict) {
      throw new CorruptSnapshotError();
    }
    return empty;
  }

  const candidate = parsed as { text?: unknown; binary?: unknown };

  // A payload written before the two-map format was introduced is a flat map
  // of path -> content. It looks superficially valid, so the presence of the
  // two known keys is what distinguishes a real payload from an old one.
  const hasTextKey = 'text' in candidate;
  const hasBinaryKey = 'binary' in candidate;
  if (!hasTextKey && !hasBinaryKey) {
    if (options?.strict) {
      throw new CorruptSnapshotError();
    }
    return empty;
  }

  const text = asStringMap(candidate.text);
  const binary = asStringMap(candidate.binary);

  if (text === undefined || binary === undefined) {
    if (options?.strict) {
      throw new CorruptSnapshotError();
    }
    return empty;
  }

  return { text, binary };
}

/**
 * Validate that a value is a map of string to string.
 *
 * The snapshot payload comes out of the database, so its shape is checked
 * before the values are handed to the diff and write paths.
 */
function asStringMap(value: unknown): Record<string, string> | undefined {
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') {
      return undefined;
    }
    result[key] = entry;
  }
  return result;
}

/** Convert a database row into the summary shape the API returns. */
function toSummary(row: ProjectSnapshot): SnapshotSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    hash: row.hash,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    fileCount: countSnapshotFiles(row.snapshotData),
  };
}

/**
 * Count the files in a stored snapshot.
 *
 * A malformed payload counts as zero files rather than throwing: the history
 * list must stay readable even if one row is corrupt.
 */
function countSnapshotFiles(snapshotData: string): number {
  const files = parseSnapshotData(snapshotData);
  return Object.keys(files.text).length + Object.keys(files.binary).length;
}

/**
 * Count the added and removed lines between two file contents.
 *
 * The counts come from the structured line diff rather than from the rendered
 * patch, so a content line that looks like a diff header ("+++foo") is still
 * counted, and the "no newline at end of file" marker is not mistaken for a
 * change.
 */
function countChangedLines(
  oldContent: string,
  newContent: string,
): { addedLines: number; removedLines: number } {
  let addedLines = 0;
  let removedLines = 0;

  for (const part of diffLines(oldContent, newContent)) {
    if (part.added) {
      addedLines += part.count;
    } else if (part.removed) {
      removedLines += part.count;
    }
  }

  return { addedLines, removedLines };
}

/**
 * Count the lines in a file's content.
 *
 * An empty file has zero lines; a file without a trailing newline still has
 * its last line counted.
 */
function countLines(content: string): number {
  if (content === '') {
    return 0;
  }
  const lines = content.split('\n');
  // A trailing newline ends the last line rather than starting a new one.
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.length;
}

/**
 * A placeholder patch for a binary file.
 *
 * A unified diff of binary content is meaningless, so the change is reported
 * with a marker instead.
 */
function binaryPatch(path: string, changeType: 'added' | 'removed' | 'modified' = 'modified'): string {
  if (changeType === 'added') {
    return `Binary file b/${path} was added\n`;
  }
  if (changeType === 'removed') {
    return `Binary file a/${path} was removed\n`;
  }
  return `Binary files a/${path} and b/${path} differ\n`;
}

/** A label for a snapshot created without one. */
function defaultLabel(): string {
  return `Snapshot ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;
}
