import { dirname, isAbsolute, normalize, relative, sep } from 'node:path';
import { realpath } from 'node:fs/promises';

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
 * @throws Error when the path escapes the root or is absolute.
 */
export function resolveWithin(root: string, relativePath: string): string {
  if (relativePath.includes('\0')) {
    throw new Error('Path contains a null byte.');
  }

  // An absolute path in the request would ignore the root entirely.
  if (isAbsolute(relativePath)) {
    throw new Error('Path must be relative to the project.');
  }

  const normalizedRoot = normalize(root);
  const target = normalize(`${normalizedRoot}${sep}${relativePath}`);

  // `relative` yields a path starting with '..' when the target sits outside
  // the root. Comparing with the normalized root catches both '..' escapes
  // and sibling-prefix tricks like "/data/projects-evil".
  const rel = relative(normalizedRoot, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Path escapes the project directory.');
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
 * @throws Error when the resolved path lands outside the root.
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
        throw new Error('Path escapes the project directory.');
      }
      return;
    } catch (error) {
      if (error instanceof Error && error.message === 'Path escapes the project directory.') {
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
