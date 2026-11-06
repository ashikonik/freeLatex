import { eq } from 'drizzle-orm';

import type { Db } from '../db/index.js';
import { projects } from '../db/schema.js';
import type { Identity } from './identity.js';
import { isAdmin } from './identity.js';

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; statusCode: 403 | 404; message: string };

/**
 * Decide whether an identity may act on a specific project.
 *
 * The rules, in order:
 *  - The admin may act on any project.
 *  - A provisioned user may act only on projects they own.
 *  - A share token may act only on the project it was minted for, and only
 *    if it carries write permission.
 */
export function canAccessProject(
  db: Db,
  identity: Identity,
  projectId: string,
  options: { write?: boolean } = {},
): AccessDecision {
  if (isAdmin(identity)) {
    return { allowed: true };
  }

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return { allowed: false, statusCode: 404, message: 'Project not found.' };
  }

  if (identity.kind === 'share') {
    // A share token is bound to the project it was minted for. It must never
    // reach a different project, even if the URL is guessed.
    if (identity.projectId !== projectId) {
      return {
        allowed: false,
        statusCode: 403,
        message: 'This share link does not grant access to that project.',
      };
    }
    if (options.write && identity.permission !== 'rw') {
      return { allowed: false, statusCode: 403, message: 'This share link is read-only.' };
    }
    return { allowed: true };
  }

  // A provisioned user is confined to their own workspace.
  if (project.ownerId !== identity.userId) {
    return {
      allowed: false,
      statusCode: 403,
      message: 'You do not have access to that project.',
    };
  }

  return { allowed: true };
}

/**
 * Check whether an identity owns a project (ignoring share tokens).
 *
 * Used by endpoints that only the owner may use, such as minting share links.
 * The admin counts as owning every project.
 */
export function isProjectOwner(db: Db, identity: Identity, projectId: string): boolean {
  if (isAdmin(identity)) {
    return true;
  }
  if (identity.kind === 'share') {
    return false;
  }
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  return project?.ownerId === identity.userId;
}
