import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';

import type { AuthContext } from '../auth/service.js';
import { canAccessProject } from '../auth/authorize.js';
import { projects, users } from '../db/schema.js';
import { hashSecret } from '../utils/hash.js';
import { ProjectStorage, newProjectId } from '../services/storage.js';
import { PathEscapeError } from '../services/paths.js';
import { invalidateBuild } from './compile.js';

interface CreateProjectBody {
  title?: string;
}

/**
 * Project lifecycle and file routes.
 *
 * Project access is enforced through `canAccessProject`, which confines a
 * user to their own workspace and binds a share token to its own project.
 */
export async function projectRoutes(
  app: FastifyInstance,
  options: { context: AuthContext; storage: ProjectStorage },
): Promise<void> {
  const { context, storage } = options;
  /** List the caller's projects. */
  app.get('/api/projects', async (request, reply) => {
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }

    // A share token is scoped to one project, so it cannot list projects.
    if (identity.kind === 'share') {
      return reply.status(403).send({ error: 'A share link cannot list projects.' });
    }

    // The admin sees every project; a user sees only their own.
    const rows =
      identity.kind === 'admin'
        ? context.db.select().from(projects).all()
        : context.db.select().from(projects).where(eq(projects.ownerId, identity.userId)).all();

    return reply.send({
      projects: rows.map((row) => ({
        id: row.id,
        title: row.title,
        mainFile: row.mainFile,
        ownerId: row.ownerId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    });
  });

  /** Create a new project owned by the caller. */
  app.post('/api/projects', async (request, reply) => {
    const identity = request.identity;
    if (!identity || identity.kind === 'share') {
      return reply
        .status(403)
        .send({ error: 'Only an account API key can create projects.' });
    }

    const body = (request.body ?? {}) as CreateProjectBody;
    const title = body.title?.trim() || 'Untitled project';

    // In single mode there is no provisioned user, so the admin owns projects.
    const ownerId = identity.kind === 'admin' ? 'admin' : identity.userId;

    // The admin owner row must exist for the foreign key to hold.
    if (ownerId === 'admin') {
      ensureAdminUser(context);
    }

    const id = newProjectId();
    await storage.createProject(id);

    context.db
      .insert(projects)
      .values({
        id,
        ownerId,
        title,
        mainFile: 'main.tex',
      })
      .run();

    return reply.status(201).send({
      id,
      title,
      mainFile: 'main.tex',
      ownerId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  /** Return a single project's metadata. */
  app.get('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }

    const decision = canAccessProject(context.db, identity, id);
    if (!decision.allowed) {
      return reply.status(decision.statusCode).send({ error: decision.message });
    }

    const row = context.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) {
      return reply.status(404).send({ error: 'Project not found.' });
    }

    return reply.send({
      id: row.id,
      title: row.title,
      mainFile: row.mainFile,
      ownerId: row.ownerId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  });

  /**
   * Change a project's title or its main file.
   *
   * Either field may be changed on its own, and a request that carries
   * neither is rejected. The main file must exist inside the project: a
   * build of a file that is not there would fail for the reader with a
   * message that says nothing about the cause.
   */
  app.patch('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }

    const decision = canAccessProject(context.db, identity, id, { write: true });
    if (!decision.allowed) {
      return reply.status(decision.statusCode).send({ error: decision.message });
    }

    const body = (request.body ?? {}) as { title?: string; mainFile?: string };
    const title = body.title?.trim();
    const mainFile = body.mainFile?.trim();

    if (!title && !mainFile) {
      return reply.status(400).send({ error: 'title or mainFile is required.' });
    }

    const changes: { title?: string; mainFile?: string; updatedAt: Date } = {
      updatedAt: new Date(),
    };

    if (title) {
      changes.title = title;
    }

    if (mainFile) {
      if (!(await storage.exists(id, mainFile))) {
        return reply
          .status(400)
          .send({ error: `There is no file named "${mainFile}" in this project.` });
      }
      changes.mainFile = mainFile;
    }

    context.db.update(projects).set(changes).where(eq(projects.id, id)).run();

    const row = context.db.select().from(projects).where(eq(projects.id, id)).get();
    return reply.send({
      id,
      title: row?.title ?? title,
      mainFile: row?.mainFile ?? mainFile,
    });
  });

  /** Delete a project and its files. */
  app.delete('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }

    const decision = canAccessProject(context.db, identity, id, { write: true });
    if (!decision.allowed) {
      return reply.status(decision.statusCode).send({ error: decision.message });
    }

    await storage.deleteProject(id);
    context.db.delete(projects).where(eq(projects.id, id)).run();

    // The project's PDF and SyncTeX data must not stay in memory after the
    // project is gone.
    invalidateBuild(id);

    return reply.status(204).send();
  });

  /** Return the project's file tree. */
  app.get('/api/projects/:id/files', async (request, reply) => {
    const { id } = request.params as { id: string };
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }

    const decision = canAccessProject(context.db, identity, id);
    if (!decision.allowed) {
      return reply.status(decision.statusCode).send({ error: decision.message });
    }

    const tree = await storage.buildFileTree(id);
    return reply.send({ tree });
  });

  /** Read one file. */
  app.get('/api/projects/:id/files/*', async (request, reply) => {
    const { id } = request.params as { id: string };
    const relativePath = (request.params as { '*': string })['*'];
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }

    const decision = canAccessProject(context.db, identity, id);
    if (!decision.allowed) {
      return reply.status(decision.statusCode).send({ error: decision.message });
    }

    try {
      const content = await storage.readProjectFile(id, relativePath);
      return reply.send({ path: relativePath, content });
    } catch (error) {
      if (error instanceof PathEscapeError) {
        return reply.status(400).send({ error: error.message });
      }
      const message = error instanceof Error ? error.message : 'Could not read the file.';
      return reply.status(404).send({ error: message });
    }
  });

  /** Write one file. */
  app.put('/api/projects/:id/files/*', async (request, reply) => {
    const { id } = request.params as { id: string };
    const relativePath = (request.params as { '*': string })['*'];
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }

    const decision = canAccessProject(context.db, identity, id, { write: true });
    if (!decision.allowed) {
      return reply.status(decision.statusCode).send({ error: decision.message });
    }

    const body = request.body as { content?: string } | undefined;
    if (typeof body?.content !== 'string') {
      return reply.status(400).send({ error: 'content must be a string.' });
    }

    try {
      await storage.writeProjectFile(id, relativePath, body.content);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not write the file.';
      return reply.status(400).send({ error: message });
    }

    context.db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id)).run();

    // The cached PDF no longer matches the sources, so it must not be served.
    invalidateBuild(id);

    return reply.send({ path: relativePath, bytes: Buffer.byteLength(body.content, 'utf8') });
  });

  /** Delete one file. */
  app.delete('/api/projects/:id/files/*', async (request, reply) => {
    const { id } = request.params as { id: string };
    const relativePath = (request.params as { '*': string })['*'];
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }

    const decision = canAccessProject(context.db, identity, id, { write: true });
    if (!decision.allowed) {
      return reply.status(decision.statusCode).send({ error: decision.message });
    }

    try {
      await storage.deleteProjectFile(id, relativePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not delete the file.';
      return reply.status(400).send({ error: message });
    }

    // The cached PDF no longer matches the sources, so it must not be served.
    invalidateBuild(id);

    return reply.status(204).send();
  });

  /** Export the project as a zip archive. */
  app.get('/api/projects/:id/export', async (request, reply) => {
    const { id } = request.params as { id: string };
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }

    const decision = canAccessProject(context.db, identity, id);
    if (!decision.allowed) {
      return reply.status(decision.statusCode).send({ error: decision.message });
    }

    const row = context.db.select().from(projects).where(eq(projects.id, id)).get();
    const safeTitle = (row?.title ?? 'project').replace(/[^a-zA-Z0-9-_ ]/g, '').trim() || 'project';

    // The archive is streamed straight into the response. Buffering it first
    // would hold a whole project in memory, and handing Fastify an
    // already-ended stream yields an empty body.
    //
    // `hijack()` hands the raw socket over to us, so the headers have to be
    // written to `reply.raw` directly — Fastify no longer serialises them.
    reply.hijack();
    reply.raw.setHeader('Content-Type', 'application/zip');
    reply.raw.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeTitle}.zip"`,
    );
    await storage.exportZip(id, reply.raw);
    return reply;
  });

  /**
   * Import a zip archive as a new project.
   *
   * The archive arrives as a multipart file upload. A JSON body carrying a
   * base64-encoded archive is also accepted so API clients can import
   * without building a multipart request.
   */
  app.post('/api/projects/import', async (request, reply) => {
    const identity = request.identity;
    if (!identity || identity.kind === 'share') {
      return reply
        .status(403)
        .send({ error: 'Only an account API key can import projects.' });
    }

    const { archive, title } = await readImportPayload(request);

    if (!archive) {
      return reply.status(400).send({ error: 'A zip archive is required.' });
    }

    const ownerId = identity.kind === 'admin' ? 'admin' : identity.userId;
    if (ownerId === 'admin') {
      ensureAdminUser(context);
    }

    const id = newProjectId();
    const finalTitle = title?.trim() || 'Imported project';

    const result = await storage.importZip(id, archive);

    // The entry point of an imported archive is not known in advance: an
    // ACM sample builds `sigconf.tex`, a thesis builds `main.tex`, and a
    // hardcoded name would break every project that is not named the same
    // way. So it is looked for in the files that were just imported.
    const mainFile = await detectMainFile(storage, id);

    context.db
      .insert(projects)
      .values({ id, ownerId, title: finalTitle, mainFile })
      .run();

    return reply.status(201).send({
      id,
      title: finalTitle,
      mainFile,
      ownerId,
      importedFiles: result.files,
      skippedFiles: result.skipped,
      skippedCount: result.skippedCount,
    });
  });
}

/**
 * Find the file an imported project is built from.
 *
 * The search is in two steps, because the two names mean different things:
 *
 * - `main.tex` is the conventional name, so a project that has one is
 *   built from it whatever else it contains.
 * - otherwise the file that declares `\documentclass` is the entry point —
 *   that is what makes a LaTeX file a document rather than an included
 *   fragment.
 *
 * A project with neither has no entry point that can be found, so the
 * conventional name is kept: the build then fails with "no such file",
 * which the reader can fix by setting the main file.
 */
async function detectMainFile(storage: ProjectStorage, projectId: string): Promise<string> {
  const entries = await storage.listProjectFiles(projectId);
  const texFiles = entries
    .filter((entry) => entry.type === 'file' && entry.path.toLowerCase().endsWith('.tex'))
    .map((entry) => entry.path);

  if (texFiles.length === 0) {
    return 'main.tex';
  }

  const conventional = texFiles.find((path) => path.toLowerCase() === 'main.tex');
  if (conventional) {
    return conventional;
  }

  // The document class is declared near the top of the file, so the first
  // few kilobytes are enough to find it and a large file is not read whole.
  for (const path of texFiles) {
    const content = await storage.readProjectFile(projectId, path).catch(() => '');
    if (/\\documentclass/.test(content.slice(0, 8192))) {
      return path;
    }
  }

  return 'main.tex';
}

/**
 * Ensure the synthetic `admin` owner row exists.
 *
 * In single-host mode there are no provisioned users, so projects are owned by
 * a reserved `admin` row. The foreign key on `projects.owner_id` needs it.
 */
function ensureAdminUser(context: AuthContext): void {
  const existing = context.db.select().from(users).where(eq(users.id, 'admin')).get();
  if (existing) {
    return;
  }
  context.db
    .insert(users)
    .values({
      id: 'admin',
      apiKeyHash: hashSecret('admin-reserved-owner'),
      name: 'Admin',
      role: 'admin',
    })
    .run();
}

/**
 * Read the archive and title out of an import request.
 *
 * Two shapes are accepted:
 *
 * - `multipart/form-data` with a `file` part and an optional `title` field.
 *   This is what the web client uses.
 * - A JSON body with `buffer` and `title`. JSON has no binary type, so the
 *   bytes arrive either as a byte array or as a base64 string; `encoding`
 *   selects between them and defaults to base64, which is the only way a
 *   JSON client can carry binary at all.
 */
async function readImportPayload(
  request: FastifyRequest,
): Promise<{ archive?: Buffer; title?: string }> {
  const contentType = request.headers['content-type'] ?? '';

  if (contentType.includes('multipart/form-data')) {
    const file = await request.file();
    if (!file) {
      return {};
    }
    const archive = await file.toBuffer();
    const title = (file.fields.title as { value?: string } | undefined)?.value;
    return { archive, title };
  }

  const body = request.body as
    | { buffer?: unknown; title?: string; encoding?: string }
    | undefined;

  if (!body || body.buffer === undefined || body.buffer === null) {
    return { title: body?.title };
  }

  const archive = toBuffer(body.buffer, body.encoding);
  return { archive, title: body.title };
}

/**
 * Coerce a JSON-encoded binary payload back into a Buffer.
 *
 * `Buffer.from({ type: 'Buffer', data: [...] })` is what `JSON.stringify`
 * produces, so that shape and a plain byte array are accepted directly.
 * A string is base64 by default because that is the only lossless way to
 * carry binary through JSON.
 */
function toBuffer(value: unknown, encoding?: string): Buffer | undefined {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    const bytes = value.filter((item): item is number => typeof item === 'number');
    return Buffer.from(bytes);
  }

  if (typeof value === 'string') {
    if (encoding === 'utf8' || encoding === 'binary') {
      return Buffer.from(value, 'utf8');
    }
    return Buffer.from(value, 'base64');
  }

  if (value && typeof value === 'object') {
    const candidate = value as { type?: string; data?: unknown };
    if (candidate.type === 'Buffer' && Array.isArray(candidate.data)) {
      const bytes = candidate.data.filter(
        (item): item is number => typeof item === 'number',
      );
      return Buffer.from(bytes);
    }
  }

  return undefined;
}
