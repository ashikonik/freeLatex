import { dirname, isAbsolute, normalize, relative, sep } from 'node:path';
import { realpath } from 'node:fs/promises';

/**
 * Raised when a path would leave the directory it must stay inside.
 *
 * A dedicated type so callers can distinguish "this input is unsafe" from
 * "the disk failed" without matching on message text.
 */
export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathEscapeError';
  }
}

/**
 * Resolve a project-relative path to an absolute path inside a root directory.
 *
 * This is the single gate against path traversal. A relative path like
 * `../../etc/passwd` must never escape the project directory, so the result
 * is checked against the root after resolution.
 *
 * @param root Absolute path of the directory the file must stay inside.
 * @param relativePath Project-relative path from user input.
 * @returns The absolute path, guaranteed to be inside `root`.
 * @throws PathEscapeError when the path escapes the root or is absolute.
 */
export function resolveWithin(root: string, relativePath: string): string {
  if (relativePath.includes('\0')) {
    throw new PathEscapeError('Path contains a null byte.');
  }

  // An absolute path in the request would ignore the root entirely.
  if (isAbsolute(relativePath)) {
    throw new PathEscapeError('Path must be relative to the project.');
  }

  const normalizedRoot = normalize(root);
  const target = normalize(`${normalizedRoot}${sep}${relativePath}`);

  // `relative` yields a path starting with '..' when the target sits outside
  // the root. Comparing with the normalized root catches both '..' escapes
  // and sibling-prefix tricks like "/data/projects-evil".
  const rel = relative(normalizedRoot, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new PathEscapeError('Path escapes the project directory.');
  }

  return target;
}

/**
 * Check whether a relative path stays inside the project directory.
 *
 * A convenience wrapper for callers that only need the verdict.
 */
export function isWithinRoot(root: string, relativePath: string): boolean {
  try {
    resolveWithin(root, relativePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a project-relative path to a canonical POSIX form.
 *
 * Uses forward slashes so the same file has the same key regardless of the
 * host operating system. This matters for snapshots and zip round-trips.
 */
export function toPosixPath(relativePath: string): string {
  return relativePath.split(sep).join('/');
}

/**
 * Check that a project id is a plain, safe identifier.
 *
 * Project ids become directory names under the storage root, so an id
 * containing a path separator or `..` would place the project outside the
 * root. Route handlers already authorise the caller against the project
 * row, but the directory name must stand on its own.
 *
 * @throws PathEscapeError when the id is not a safe identifier.
 */
export function assertSafeProjectId(projectId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) {
    throw new PathEscapeError('Project id is not a valid identifier.');
  }
}

/**
 * Verify that a path, after following any symlinks, is still inside the root.
 *
 * The lexical check in `resolveWithin` is not enough: a symlink planted
 * inside the project directory can point anywhere on disk, and reading
 * through it would escape the project. This resolves the real path of the
 * closest existing ancestor and checks that instead.
 *
 * The target file itself may not exist yet (a write), so the check walks up
 * to the nearest existing parent directory.
 *
 * @throws PathEscapeError when the resolved path lands outside the root.
 */
export async function assertRealPathWithin(root: string, target: string): Promise<void> {
  const realRoot = await realpath(root).catch(() => normalize(root));

  // Walk up until something exists that we can resolve.
  let probe = target;
  let suffix = '';
  for (;;) {
    try {
      const real = await realpath(probe);
      const resolved = suffix === '' ? real : `${real}${sep}${suffix}`;
      const rel = relative(realRoot, resolved);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new PathEscapeError('Path escapes the project directory.');
      }
      return;
    } catch (error) {
      if (error instanceof PathEscapeError) {
        throw error;
      }
    }

    const parent = dirname(probe);
    if (parent === probe) {
      // Reached the filesystem root without finding anything that exists.
      return;
    }
    suffix = `${normalize(probe).split(sep).pop()}${suffix === '' ? '' : `${sep}${suffix}`}`;
    probe = parent;
  }
}
