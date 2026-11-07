import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';

import type { AuthContext } from '../auth/service.js';
import { canAccessProject } from '../auth/authorize.js';
import { projects } from '../db/schema.js';
import {
  CompilerNotFoundError,
  CompileTimeoutError,
  compileProject,
  type CompileError,
} from '../services/compiler.js';
import { SyncTexEngine } from '../services/synctex.js';
import { ProjectStorage } from '../services/storage.js';

/**
 * A compiled document, kept in memory for the lifetime of the process.
 *
 * The PDF and the SyncTeX data are the two artefacts a client needs after a
 * build, and both are cheap to keep. A cache keyed by project id lets the
 * preview endpoint serve the last build without recompiling, and lets the
 * SyncTeX endpoints answer queries without a build of their own.
 */
interface BuildArtifact {
  pdf: Buffer;
  synctex: Buffer | undefined;
  engine: SyncTexEngine | undefined;
  errors: CompileError[];
  durationMs: number;
  builtAt: number;
}

/**
 * The most recent build of each project.
 *
 * A map rather than a database table: the data is a derived artefact, it is
 * cheap to recreate, and it must never outlive the process.
 */
const builds = new Map<string, BuildArtifact>();

/**
 * Compilation routes.
 *
 * A build is a write action: it consumes server CPU and can be triggered
 * repeatedly, so it requires write access to the project. Reading the last
 * build's PDF is a read action.
 */
export async function compileRoutes(
  app: FastifyInstance,
  options: { context: AuthContext; storage: ProjectStorage; compileTimeoutMs: number },
): Promise<void> {
  const { context, storage, compileTimeoutMs } = options;

  /**
   * Compile a project.
   *
   * A successful build answers with the PDF itself, so that a client can
   * render it without a second request. A failed build has no PDF, so the
   * answer is the structured error log instead.
   *
   * The diagnostics of a successful build are not in the body — a body
   * carries one representation — so they are available from the build
   * metadata endpoint.
   */
  app.post('/api/projects/:id/compile', async (request, reply) => {
    const { id } = request.params as { id: string };
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }

    const decision = canAccessProject(context.db, identity, id, { write: true });
    if (!decision.allowed) {
      return reply.status(decision.statusCode).send({ error: decision.message });
    }

    const row = context.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) {
      return reply.status(404).send({ error: 'Project not found.' });
    }

    const body = (request.body ?? {}) as { mainFile?: string };
    const mainFile = body.mainFile?.trim() || row.mainFile || 'main.tex';

    let result;
    try {
      result = await compileProject({
        projectDir: storage.projectDir(id),
        mainFile,
        timeoutMs: compileTimeoutMs,
      });
    } catch (error) {
      // A missing compiler is a deployment problem, not a user problem: the
      // client cannot fix it, so the answer says what has to be installed.
      if (error instanceof CompilerNotFoundError) {
        return reply.status(503).send({ error: error.message });
      }
      // A compilation that outlived its budget is reported as a timeout so
      // the client can say so rather than showing a generic failure.
      if (error instanceof CompileTimeoutError) {
        return reply.status(504).send({ error: error.message });
      }
      throw error;
    }

    if (!result.pdf) {
      // No PDF was produced. The diagnostics are the useful part of the
      // answer, so they are returned in full.
      return reply.status(422).send({
        success: false,
        errors: result.errors,
        log: result.log,
        durationMs: result.durationMs,
        failureReason: result.failureReason ?? 'no-output',
      });
    }

    // A SyncTeX file that cannot be parsed must not fail the build: the PDF
    // is good, and the SyncTeX endpoints can report the problem themselves.
    let engine: SyncTexEngine | undefined;
    if (result.synctex) {
      try {
        // The project root lets the engine report file names relative to
        // it, which is the only way to tell two files that share a base
        // name apart.
        engine = new SyncTexEngine(result.synctex, storage.projectDir(id));
      } catch {
        engine = undefined;
      }
    }

    builds.set(id, {
      pdf: result.pdf,
      synctex: result.synctex,
      engine,
      errors: result.errors,
      durationMs: result.durationMs,
      builtAt: Date.now(),
    });

    context.db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id)).run();

    // The build's own PDF is the answer: a client can render it without a
    // second request. The diagnostics of a successful build are not in the
    // body — a body carries one representation — so they come from the
    // build metadata endpoint instead.
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Length', String(result.pdf.length));
    // The PDF changes with every build, so it must never be cached by the
    // browser or an intermediary.
    reply.header('Cache-Control', 'no-store');
    return reply.send(result.pdf);
  });

  /**
   * Report the metadata of the most recent build.
   *
   * The compile route answers with the PDF, so the diagnostics of a
   * successful build have to be asked for separately.
   */
  app.get('/api/projects/:id/compile', async (request, reply) => {
    const { id } = request.params as { id: string };
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }

    const decision = canAccessProject(context.db, identity, id);
    if (!decision.allowed) {
      return reply.status(decision.statusCode).send({ error: decision.message });
    }

    const build = builds.get(id);
    if (!build) {
      return reply.status(404).send({ error: 'The project has not been compiled yet.' });
    }

    return reply.send({
      success: true,
      errors: build.errors,
      durationMs: build.durationMs,
      pageCount: build.engine?.pageCount ?? 0,
      hasSyncTex: build.engine !== undefined,
      builtAt: new Date(build.builtAt).toISOString(),
    });
  });

  /** Serve the PDF of the most recent build. */
  app.get('/api/projects/:id/pdf', async (request, reply) => {
    const { id } = request.params as { id: string };
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }

    const decision = canAccessProject(context.db, identity, id);
    if (!decision.allowed) {
      return reply.status(decision.statusCode).send({ error: decision.message });
    }

    const build = builds.get(id);
    if (!build) {
      return reply.status(404).send({ error: 'The project has not been compiled yet.' });
    }

    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Length', String(build.pdf.length));
    // The PDF changes with every build, so it must never be cached by the
    // browser or an intermediary.
    reply.header('Cache-Control', 'no-store');
    return reply.send(build.pdf);
  });

  /**
   * Forward search: where does a source line appear on the page?
   *
   * This is the jump from the editor to the PDF.
   */
  app.get('/api/projects/:id/synctex/forward', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { file?: string; line?: string };
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }

    const decision = canAccessProject(context.db, identity, id);
    if (!decision.allowed) {
      return reply.status(decision.statusCode).send({ error: decision.message });
    }

    const file = query.file?.trim();
    const line = Number(query.line);
    if (!file || !Number.isInteger(line) || line < 1) {
      return reply.status(400).send({ error: 'file and line are required.' });
    }

    const build = builds.get(id);
    if (!build?.engine) {
      return reply.status(404).send({ error: 'No SyncTeX data is available for this project.' });
    }

    const result = build.engine.forwardSearch(file, line);
    if (!result) {
      return reply.status(404).send({ error: 'No SyncTeX entry for that line.' });
    }

    return reply.send(result);
  });

  /**
   * Inverse search: which source line produced a point on the page?
   *
   * This is the jump from the PDF to the editor. The coordinates are in PDF
   * points, measured from the bottom-left of the page.
   */
  app.get('/api/projects/:id/synctex/inverse', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { x?: string; y?: string; page?: string };
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }

    const decision = canAccessProject(context.db, identity, id);
    if (!decision.allowed) {
      return reply.status(decision.statusCode).send({ error: decision.message });
    }

    const x = Number(query.x);
    const y = Number(query.y);
    const page = Number(query.page);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isInteger(page) || page < 1) {
      return reply.status(400).send({ error: 'x, y and page are required.' });
    }

    const build = builds.get(id);
    if (!build?.engine) {
      return reply.status(404).send({ error: 'No SyncTeX data is available for this project.' });
    }

    const result = build.engine.inverseSearch(x, y, page);
    if (!result) {
      return reply.status(404).send({ error: 'No SyncTeX entry for that position.' });
    }

    return reply.send(result);
  });

  /** Report the SyncTeX state of the last build. */
  app.get('/api/projects/:id/synctex', async (request, reply) => {
    const { id } = request.params as { id: string };
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }

    const decision = canAccessProject(context.db, identity, id);
    if (!decision.allowed) {
      return reply.status(decision.statusCode).send({ error: decision.message });
    }

    const build = builds.get(id);
    if (!build) {
      return reply.status(404).send({ error: 'The project has not been compiled yet.' });
    }

    if (!build.engine) {
      return reply.status(404).send({ error: 'No SyncTeX data is available for this project.' });
    }

    return reply.send({
      pageCount: build.engine.pageCount,
      files: build.engine.fileNames,
    });
  });
}

/**
 * Drop a project's cached build.
 *
 * Called when the project's files change so that a stale PDF is not served
 * after an edit.
 */
export function invalidateBuild(projectId: string): void {
  builds.delete(projectId);
}

/**
 * Clear every cached build.
 *
 * Only used by tests, which build several projects against one module-level
 * map.
 */
export function clearBuilds(): void {
  builds.clear();
}
