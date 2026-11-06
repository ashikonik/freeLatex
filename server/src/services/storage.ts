import { createWriteStream } from 'node:fs';
import type { Dirent } from 'node:fs';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import yauzl from 'yauzl';
import { nanoid } from 'nanoid';

import {
  assertRealPathWithin,
  assertSafeProjectId,
  PathEscapeError,
  resolveWithin,
  toPosixPath,
} from './paths.js';

/**
 * Decode a zip entry name to a string.
 *
 * With `decodeStrings: false`, yauzl yields the raw name bytes; the bundled
 * typings always claim `string`, so the runtime shape is checked here instead
 * of being cast blindly.
 */
function decodeEntryName(fileName: string | Buffer): string {
  return Buffer.isBuffer(fileName) ? fileName.toString('utf8') : fileName;
}

/**
 * Raised when a project is too large to be captured in one snapshot.
 *
 * A dedicated type so the route can answer 413 rather than a generic 500,
 * and so the failure is never mistaken for "the file could not be read".
 */
export class ProjectTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectTooLargeError';
  }
}

/**
 * True when an error is "the path does not exist".
 *
 * Node reports this as an `ENOENT` error code; the check is on the code
 * rather than the message so it does not depend on the platform's wording.
 */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * True when a buffer holds content that is not valid UTF-8 text.
 *
 * Node's UTF-8 decoder replaces invalid byte sequences with U+FFFD instead
 * of throwing, so a binary file silently comes back as mojibake. Round-tripping
 * the decoded text back to bytes and comparing with the original detects that
 * loss: a valid text file always survives the round trip unchanged.
 */
export function isBinaryContent(buffer: Buffer): boolean {
  const decoded = buffer.toString('utf8');
  return !Buffer.from(decoded, 'utf8').equals(buffer);
}

export interface FileEntry {
  /** Project-relative path, POSIX separators, e.g. "chapters/intro.tex". */
  path: string;
  name: string;
  type: 'file' | 'directory';
  size: number;
  /** Last modification time. */
  modifiedAt: string;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  children?: FileTreeNode[];
}

/** Starter content for a brand-new project. */
const STARTER_MAIN_TEX = `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath}
\\usepackage{graphicx}

\\title{My Document}
\\author{Anonymous}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}
Start writing here.

\\end{document}
`;

/** Upper bound on a single imported file, to keep a zip bomb from filling the disk. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Upper bound on total extracted size for one import. */
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
/** Upper bound on the number of entries in one imported archive. */
const MAX_ARCHIVE_ENTRIES = 5_000;
/**
 * Upper bound on how many skipped entry names are reported back.
 *
 * The names are echoed to the client, so an archive of 5000 bad entries
 * must not produce a 5000-element response body.
 */
const MAX_REPORTED_SKIPS = 50;

/**
 * File storage for projects.
 *
 * Every project lives in its own directory under `data/projects/<id>/`. Files
 * are plain text on disk, which keeps the on-disk format portable and makes
 * the whole workspace greppable.
 */
export class ProjectStorage {
  readonly root: string;

  constructor(projectsRoot: string) {
    this.root = projectsRoot;
  }

  /** Absolute path of a project's directory. */
  projectDir(projectId: string): string {
    assertSafeProjectId(projectId);
    return join(this.root, projectId);
  }

  /**
   * Create a project directory with a starter `main.tex`.
   */
  async createProject(projectId: string): Promise<string> {
    const dir = this.projectDir(projectId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'main.tex'), STARTER_MAIN_TEX, 'utf8');
    return dir;
  }

  /** Delete a project directory and everything in it. */
  async deleteProject(projectId: string): Promise<void> {
    await rm(this.projectDir(projectId), { recursive: true, force: true });
  }

  /**
   * List every file in a project as a flat list of entries.
   *
   * Results are sorted by path so callers get a stable order — snapshots and
   * diffs depend on that.
   *
   * A project row can exist in the database without a directory on disk (a
   * project whose files were removed, or one whose directory was never
   * created). Such a project simply has no files, so a missing directory
   * yields an empty list rather than an error.
   */
  async listProjectFiles(projectId: string): Promise<FileEntry[]> {
    const dir = this.projectDir(projectId);
    const entries: FileEntry[] = [];

    const walk = async (current: string): Promise<void> => {
      let items: Dirent[];
      try {
        items = await readdir(current, { withFileTypes: true });
      } catch (error) {
        // A missing directory means the project has no files. Anything else
        // (permissions, I/O errors) is a real failure and must surface.
        if (isNotFound(error)) {
          return;
        }
        throw error;
      }
      for (const item of items) {
        const absolute = join(current, item.name);
        const relPath = toPosixPath(relative(dir, absolute));

        if (item.isDirectory()) {
          const info = await stat(absolute);
          entries.push({
            path: relPath,
            name: item.name,
            type: 'directory',
            size: 0,
            modifiedAt: info.mtime.toISOString(),
          });
          await walk(absolute);
        } else if (item.isFile()) {
          const info = await stat(absolute);
          entries.push({
            path: relPath,
            name: item.name,
            type: 'file',
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
          });
        }
      }
    };

    await walk(dir);
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return entries;
  }
  /**
   * Build a nested file tree from the flat entry list.
   */
  async buildFileTree(projectId: string): Promise<FileTreeNode[]> {
    const entries = await this.listProjectFiles(projectId);
    const root: FileTreeNode[] = [];
    const directories = new Map<string, FileTreeNode>();

    for (const entry of entries) {
      const node: FileTreeNode = {
        name: entry.name,
        path: entry.path,
        type: entry.type,
        size: entry.size,
        children: entry.type === 'directory' ? [] : undefined,
      };

      const parentPath = entry.path.split('/').slice(0, -1).join('/');
      if (parentPath === '') {
        root.push(node);
      } else {
        const parent = directories.get(parentPath);
        if (parent) {
          parent.children?.push(node);
        }
      }

      if (entry.type === 'directory') {
        directories.set(entry.path, node);
      }
    }

    return root;
  }

  /** Read a file's contents as UTF-8 text. */
  async readProjectFile(projectId: string, relativePath: string): Promise<string> {
    const dir = this.projectDir(projectId);
    const absolute = resolveWithin(dir, relativePath);
    await assertRealPathWithin(dir, absolute);
    return readFile(absolute, 'utf8');
  }

  /** Write a file, creating parent directories as needed. */
  async writeProjectFile(
    projectId: string,
    relativePath: string,
    content: string,
  ): Promise<void> {
    const dir = this.projectDir(projectId);
    const absolute = resolveWithin(dir, relativePath);
    await assertRealPathWithin(dir, absolute);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }

  /** Delete a file. */
  async deleteProjectFile(projectId: string, relativePath: string): Promise<void> {
    const dir = this.projectDir(projectId);
    const absolute = resolveWithin(dir, relativePath);
    await assertRealPathWithin(dir, absolute);
    await rm(absolute, { force: true, recursive: true });
  }

  /** True when the path exists inside the project. */
  async exists(projectId: string, relativePath: string): Promise<boolean> {
    try {
      const absolute = resolveWithin(this.projectDir(projectId), relativePath);
      await stat(absolute);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read every file in a project into a text map and a binary map.
   *
   * This is the snapshot format. Text files hold their content verbatim;
   * binary files hold base64 so they survive a round trip byte-for-byte.
   * Node's UTF-8 decoder silently substitutes U+FFFD for invalid bytes, so
   * binary content has to be detected and encoded rather than decoded.
   *
   * @throws Error when the project's total size exceeds the snapshot limit.
   */
  async readAllFiles(projectId: string): Promise<{
    text: Record<string, string>;
    binary: Record<string, string>;
  }> {
    const entries = await this.listProjectFiles(projectId);
    const text: Record<string, string> = {};
    const binary: Record<string, string> = {};
    let totalBytes = 0;

    for (const entry of entries) {
      if (entry.type !== 'file') {
        continue;
      }

      let buffer: Buffer;
      try {
        const absolute = resolveWithin(this.projectDir(projectId), entry.path);
        await assertRealPathWithin(this.projectDir(projectId), absolute);
        buffer = await readFile(absolute);
      } catch (error) {
        // A path-safety failure must not be silently swallowed: it means the
        // project contains something that does not belong to it, and the
        // caller needs to know rather than silently lose the file.
        if (error instanceof PathEscapeError) {
          throw error;
        }
        // Skip files that cannot be read (locked, vanished, or unreadable).
        continue;
      }

      // The size check sits outside the read's try/catch on purpose: a file
      // that is too large has to fail the whole snapshot. Silently omitting
      // it would produce a snapshot that looks complete but loses the file —
      // and a later rollback to it would delete the file for good.
      if (buffer.length > MAX_FILE_BYTES) {
        throw new ProjectTooLargeError(`"${entry.path}" is too large to snapshot.`);
      }
      totalBytes += buffer.length;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new ProjectTooLargeError('The project is too large to snapshot.');
      }

      if (isBinaryContent(buffer)) {
        binary[entry.path] = buffer.toString('base64');
      } else {
        text[entry.path] = buffer.toString('utf8');
      }
    }

    return { text, binary };
  }

  /**
   * Write a complete set of files into a project, replacing what is there.
   *
   * Used by snapshot rollback and zip import. Files present in the project
   * but absent from the new set are deleted, so the result matches the given
   * files exactly rather than being a merge.
   */
  async writeAllFiles(
    projectId: string,
    files: { text: Record<string, string>; binary: Record<string, string> },
  ): Promise<void> {
    const dir = this.projectDir(projectId);
    await mkdir(dir, { recursive: true });

    for (const [relativePath, content] of Object.entries(files.text)) {
      const absolute = resolveWithin(dir, relativePath);
      await assertRealPathWithin(dir, absolute);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, 'utf8');
    }

    for (const [relativePath, content] of Object.entries(files.binary)) {
      const absolute = resolveWithin(dir, relativePath);
      await assertRealPathWithin(dir, absolute);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, Buffer.from(content, 'base64'));
    }

    // Remove anything that the new file set does not mention.
    const keep = new Set([...Object.keys(files.text), ...Object.keys(files.binary)]);
    const existing = await this.listProjectFiles(projectId);
    for (const entry of existing) {
      if (entry.type === 'file' && !keep.has(entry.path)) {
        await this.deleteProjectFile(projectId, entry.path);
      }
    }
  }

  /**
   * Stream a project as a zip archive.
   *
   * The archive mirrors the project directory, so importing it back produces
   * the same layout — this is the Overleaf-compatible round-trip.
   */
  async exportZip(projectId: string, destination: NodeJS.WritableStream): Promise<void> {
    const dir = this.projectDir(projectId);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    // The destination must be attached before the entries are appended, and
    // `finalize()` must not be awaited — awaiting it deadlocks because the
    // archive only finishes once its output stream drains. The returned
    // promise is discarded with a rejection handler so a mid-archive failure
    // surfaces through the pipeline instead of an unhandled rejection.
    const done = pipeline(archive, destination);
    archive.glob('**/*', { cwd: dir, dot: true, nodir: true });
    void archive.finalize().catch(() => undefined);
    await done;
  }

  /**
   * Extract a zip archive into a project.
   *
   * Entry paths are validated before anything touches the disk: an archive
   * containing `../../etc/passwd` or an absolute path is rejected outright
   * rather than written outside the project directory.
   *
   * The extraction happens in a staging directory and is moved into place only
   * once every entry has been processed. A failure part-way through therefore
   * leaves no half-imported project behind.
   */
  async importZip(
    projectId: string,
    zipBuffer: Buffer,
  ): Promise<{ files: number; skipped: string[]; skippedCount: number }> {
    const dir = this.projectDir(projectId);
    const staging = `${dir}.importing`;

    // Clear any staging directory left behind by an interrupted import.
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });

    const skipped: string[] = [];
    let skippedCount = 0;
    let fileCount = 0;
    let totalBytes = 0;

    // Only the first few names are kept: the list is echoed to the client.
    const skip = (entryName: string): void => {
      skippedCount += 1;
      if (skipped.length < MAX_REPORTED_SKIPS) {
        skipped.push(entryName);
      }
    };

    try {
      await new Promise<void>((resolve, reject) => {
        // `decodeStrings: false` hands us the raw entry-name bytes. yauzl's own
        // decoding rejects `../evil.tex` with a fatal archive-level error,
        // which would abort the whole import; we want to skip that entry and
        // keep importing. Owning the decode also means we own the path
        // validation.
        yauzl.fromBuffer(
          zipBuffer,
          { lazyEntries: true, decodeStrings: false },
          (error, zipFile) => {
            if (error || !zipFile) {
              reject(error ?? new Error('Could not read the uploaded archive.'));
              return;
            }

            let entryCount = 0;

            zipFile.readEntry();

            zipFile.on('entry', (entry: yauzl.Entry) => {
              entryCount += 1;
              if (entryCount > MAX_ARCHIVE_ENTRIES) {
                zipFile.close();
                reject(new Error('The archive contains too many files.'));
                return;
              }

              const entryName = decodeEntryName(entry.fileName);

              // Skip macOS resource-fork noise and directory entries.
              if (entryName.startsWith('__MACOSX/') || entryName.endsWith('/')) {
                zipFile.readEntry();
                return;
              }

              let absolute: string;
              try {
                absolute = resolveWithin(staging, entryName);
              } catch {
                // A path that tries to escape the project is never written.
                skip(entryName);
                zipFile.readEntry();
                return;
              }

              if (entry.uncompressedSize > MAX_FILE_BYTES) {
                skip(entryName);
                zipFile.readEntry();
                return;
              }

              zipFile.openReadStream(entry, (streamError, readStream) => {
                if (streamError || !readStream) {
                  skip(entryName);
                  zipFile.readEntry();
                  return;
                }

                totalBytes += entry.uncompressedSize;
                if (totalBytes > MAX_TOTAL_BYTES) {
                  zipFile.close();
                  reject(new Error('The archive is too large to import.'));
                  return;
                }

                // The realpath check must run before the directory is
                // created: `mkdir` follows a symlink planted in the project,
                // so creating first would write a directory outside it.
                assertRealPathWithin(staging, absolute)
                  .then(() => mkdir(dirname(absolute), { recursive: true }))
                  .then(() => assertRealPathWithin(staging, absolute))
                  .then(() => pipeline(readStream, createWriteStream(absolute)))
                  .then(() => {
                    fileCount += 1;
                    zipFile.readEntry();
                  })
                  .catch((writeError: unknown) => {
                    // A symlink escape is skipped like any other unsafe entry;
                    // a genuine I/O failure aborts the import.
                    if (writeError instanceof PathEscapeError) {
                      skip(entryName);
                      zipFile.readEntry();
                      return;
                    }
                    zipFile.close();
                    reject(writeError);
                  });
              });
            });

          zipFile.on('end', () => {
            resolve();
          });

          zipFile.on('error', (zipError: unknown) => {
            reject(zipError);
          });
        },
      );
    });

      // The import is complete: swap the staging directory into place.
      await rm(dir, { recursive: true, force: true });
      await rename(staging, dir);

      return { files: fileCount, skipped, skippedCount };
    } catch (error) {
      // Leave no partially imported project behind.
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
}

/** Generate a new project id. */
export function newProjectId(): string {
  return `prj_${nanoid(16)}`;
}
