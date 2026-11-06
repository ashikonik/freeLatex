import { createWriteStream } from 'node:fs';
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
   */
  async listProjectFiles(projectId: string): Promise<FileEntry[]> {
    const dir = this.projectDir(projectId);
    const entries: FileEntry[] = [];

    const walk = async (current: string): Promise<void> => {
      const items = await readdir(current, { withFileTypes: true });
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
   * Read every text file in a project into a path -> content map.
   *
   * This is the snapshot format. Binary files are skipped rather than
   * corrupted, since LaTeX sources are text.
   */
  async readAllFiles(projectId: string): Promise<Record<string, string>> {
    const entries = await this.listProjectFiles(projectId);
    const result: Record<string, string> = {};

    for (const entry of entries) {
      if (entry.type !== 'file') {
        continue;
      }
      try {
        result[entry.path] = await this.readProjectFile(projectId, entry.path);
      } catch (error) {
        // A path-safety failure must not be silently swallowed: it means the
        // project contains something that does not belong to it, and the
        // caller needs to know rather than silently lose the file.
        if (error instanceof PathEscapeError) {
          throw error;
        }
        // Skip files that cannot be read as text (binary assets).
      }
    }

    return result;
  }

  /**
   * Write a complete set of files into a project, replacing what is there.
   *
   * Used by snapshot rollback and zip import. Files present in the project
   * but absent from `files` are deleted, so the result matches `files`
   * exactly rather than being a merge.
   */
  async writeAllFiles(projectId: string, files: Record<string, string>): Promise<void> {
    const dir = this.projectDir(projectId);
    await mkdir(dir, { recursive: true });

    for (const [relativePath, content] of Object.entries(files)) {
      const absolute = resolveWithin(dir, relativePath);
      await assertRealPathWithin(dir, absolute);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, 'utf8');
    }

    // Remove anything that the new file set does not mention.
    const existing = await this.listProjectFiles(projectId);
    for (const entry of existing) {
      if (entry.type === 'file' && !(entry.path in files)) {
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
