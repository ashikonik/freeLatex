import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';

import type { AuthContext } from '../auth/service.js';
import { canAccessProject } from '../auth/authorize.js';
import { projects } from '../db/schema.js';
import {
  CorruptSnapshotError,
  SnapshotNotFoundError,
  SnapshotService,
  type SnapshotSummary,
} from '../services/snapshot.js';
import { ProjectTooLargeError } from '../services/storage.js';
import { invalidateBuild } from './compile.js';

/**
 * Version control routes.
 *
 * Snapshots are part of a project's content, so they follow the same access
 * rules: a user reaches their own projects, an admin reaches all of them,
 * and a share token reaches only the project it is bound to.
 */
export async function snapshotRoutes(
  app: FastifyInstance,
  options: { context: AuthContext; snapshots: SnapshotService },
): Promise<void> {
  const { context, snapshots } = options;

  /** Capture the current state of a project. */
  app.post('/api/projects/:id/snapshots', async (request, reply) => {
    const { id } = request.params as { id: string };
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }

    const decision = canAccessProject(context.db, identity, id, { write: true });
    if (!decision.allowed) {
      return reply.status(decision.statusCode).send({ error: decision.message });
    }

    const body = (request.body ?? {}) as { label?: string };
    const createdBy = identity.kind === 'share' ? null : identity.userId;

    let summary: SnapshotSummary;
    try {
      summary = await snapshots.createSnapshot(id, body.label ?? '', createdBy);
    } catch (error) {
      // A project that is too large to snapshot is a client-side problem, not
      // a server failure.
      if (error instanceof ProjectTooLargeError) {
        return reply.status(413).send({ error: error.message });
      }
      throw error;
    }

    context.db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id)).run();

    return reply.status(201).send(summary);
  });

  /** List a project's revision history. */
  app.get('/api/projects/:id/snapshots', async (request, reply) => {
    const { id } = request.params as { id: string };
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }

    const decision = canAccessProject(context.db, identity, id);
    if (!decision.allowed) {
      return reply.status(decision.statusCode).send({ error: decision.message });
    }

    return reply.send({ snapshots: snapshots.listSnapshots(id) });
  });

  /** Fetch one snapshot's metadata and file contents. */
  app.get('/api/projects/:id/snapshots/:snapshotId', async (request, reply) => {
    const { id, snapshotId } = request.params as { id: string; snapshotId: string };
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }

    const decision = canAccessProject(context.db, identity, id);
    if (!decision.allowed) {
      return reply.status(decision.statusCode).send({ error: decision.message });
    }

    try {
      const snapshot = snapshots.getSnapshot(id, snapshotId);
      return reply.send(snapshot);
    } catch (error) {
      // Only a genuinely missing snapshot is a 404. Anything else — a disk
      // error, a path-safety failure — must reach the global error handler so
      // it is not reported to the client as "not found".
      if (error instanceof SnapshotNotFoundError) {
        return reply.status(404).send({ error: 'Snapshot not found.' });
      }
      throw error;
    }
  });

  /**
   * Diff two snapshots of a project.
   *
   * The second snapshot defaults to the newest one, so a client can ask for
   * "what changed since this revision" without tracking the head itself.
   */
  app.get('/api/projects/:id/snapshots/:snapshotId/diff', async (request, reply) => {
    const { id, snapshotId } = request.params as { id: string; snapshotId: string };
    const query = request.query as { against?: string };
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }

    const decision = canAccessProject(context.db, identity, id);
    if (!decision.allowed) {
      return reply.status(decision.statusCode).send({ error: decision.message });
    }

    // With no explicit counterpart, diff against the newest snapshot.
    let against = query.against;
    if (!against) {
      const latest = snapshots.listSnapshots(id)[0];
      if (!latest) {
        return reply.status(404).send({ error: 'The project has no snapshots.' });
      }
      against = latest.id;
    }

    try {
      const diffs = snapshots.computeDiff(id, snapshotId, against);
      return reply.send({ from: snapshotId, to: against, diffs });
    } catch (error) {
      if (error instanceof SnapshotNotFoundError) {
        return reply.status(404).send({ error: 'Snapshot not found.' });
      }
      throw error;
    }
  });

  /** Restore a project to one of its snapshots. */
  app.post('/api/projects/:id/snapshots/:snapshotId/rollback', async (request, reply) => {
    const { id, snapshotId } = request.params as { id: string; snapshotId: string };
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }

    const decision = canAccessProject(context.db, identity, id, { write: true });
    if (!decision.allowed) {
      return reply.status(decision.statusCode).send({ error: decision.message });
    }

    try {
      const fileCount = await snapshots.rollbackToSnapshot(id, snapshotId);
      context.db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id)).run();

      // The restored files differ from the sources the cached PDF was built
      // from, so it must not be served.
      invalidateBuild(id);

      return reply.send({ restored: true, fileCount });
    } catch (error) {
      // A corrupt snapshot must not be reported as "not found": the project
      // was left untouched, and the client needs to know the restore failed.
      if (error instanceof SnapshotNotFoundError) {
        return reply.status(404).send({ error: 'Snapshot not found.' });
      }
      if (error instanceof CorruptSnapshotError) {
        return reply.status(409).send({ error: 'The snapshot is corrupt and cannot be restored.' });
      }
      throw error;
    }
  });
}
