import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';

import { loadEnv, type Env } from './config/env.js';
import { openDatabase, type DbHandle } from './db/index.js';
import { requireAuth } from './middleware/auth.js';
import { authRoutes, loginRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { shareRoutes } from './routes/share.js';
import { snapshotRoutes } from './routes/snapshots.js';
import { compileRoutes } from './routes/compile.js';
import { aiRoutes } from './routes/ai.js';
import { staticRoutes } from './routes/static.js';
import { yjsRoutes } from './services/yjs.js';
import { ProjectStorage } from './services/storage.js';
import { SnapshotService } from './services/snapshot.js';
import { join } from 'node:path';

export interface AppOptions {
  env?: Env;
  /** Inject an open database handle. Used by tests to supply an in-memory DB. */
  db?: DbHandle;
  logger?: boolean;
  /**
   * Where the log is written.
   *
   * The default is the standard output. A test passes a stream of its own so
   * that it can read back what was logged and check that a credential never
   * reached it.
   */
  logStream?: { write(chunk: string): boolean };
}

export interface BuiltApp {
  app: FastifyInstance;
  env: Env;
  db: DbHandle;
}

/**
 * Build the Fastify application.
 *
 * Kept separate from the process entry point so tests can build an app and
 * use `app.inject()` without binding a port.
 */
export async function buildApp(options: AppOptions = {}): Promise<BuiltApp> {
  const env = options.env ?? loadEnv();
  const db = options.db ?? openDatabase(env.dataDir);

  const app = Fastify({
    // A credential must never reach the log. The browser's WebSocket API
    // cannot set a header, so a share token travels in the query string of
    // the upgrade request — and the request's URL is part of every log line.
    // The serializer keeps the path and drops the query string, so the token
    // stays out of the logs while the request itself is still traceable.
    logger: options.logger
      ? {
          ...(options.logStream ? { stream: options.logStream } : {}),
          serializers: {
            req(request: { method?: string; url?: string }) {
              return {
                method: request.method,
                url: request.url?.split('?')[0],
              };
            },
          },
        }
      : false,
  });

  // Cross-origin access is off unless a deployment names the one origin that
  // may use it. Reflecting whatever origin asks — with credentials — would
  // let any site on the internet read the API's answers on the user's
  // behalf, so the default is to allow none.
  //
  // The origin is a function rather than a string so that a request from
  // anywhere else gets no header at all, rather than one naming an origin
  // the browser will refuse.
  await app.register(cors, env.corsOrigin
    ? {
        origin: (
          origin: string | undefined,
          callback: (error: Error | null, allow: string | boolean | RegExp) => void,
        ) => {
          callback(null, origin === env.corsOrigin);
        },
        credentials: true,
      }
    : { origin: false });
  await app.register(websocket, {
    options: {
      maxPayload: 5 * 1024 * 1024,
    },
  });
  await app.register(multipart, {
    limits: {
      fileSize: 200 * 1024 * 1024,
      files: 1,
    },
  });

  const context = {
    db: db.db,
    authMode: env.authMode,
    adminApiKey: env.adminApiKey,
  };

  const storage = new ProjectStorage(join(env.dataDir, 'projects'));
  const snapshots = new SnapshotService(db.db, storage);

  app.get('/api/health', async () => ({
    status: 'ok',
    authMode: env.authMode,
    version: '0.1.0',
  }));

  // /api/auth/login is registered OUTSIDE the guarded scope below: it is the
  // endpoint that *establishes* credentials, so it receives the API key in the
  // request body and validates it itself.
  await app.register(loginRoutes, { context });

  // The collaboration socket is registered outside the guarded scope for the
  // same reason: a WebSocket upgrade carries its credentials in the request's
  // headers and query string, and the socket handler validates them itself
  // before any document is touched.
  await app.register(yjsRoutes, { context, storage });

  // Every other /api route requires credentials. Share tokens are accepted on
  // the project-scoped routes; the guard picks whichever is present.
  await app.register(async (scoped) => {
    scoped.addHook('onRequest', requireAuth(context));

    await scoped.register(authRoutes, { context });
    await scoped.register(shareRoutes, { context });
    await scoped.register(projectRoutes, { context, storage });
    await scoped.register(snapshotRoutes, { context, snapshots });
    await scoped.register(compileRoutes, {
      context,
      storage,
      compileTimeoutMs: env.compileTimeoutMs,
    });
    await scoped.register(aiRoutes);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, 'request failed');
    const statusCode = error.statusCode ?? 500;
    return reply.status(statusCode).send({
      error: statusCode === 500 ? 'Internal server error.' : error.message,
    });
  });

  // The client's own files are served last, so that the API routes above
  // keep their own answers. A deployment that ships one container needs
  // this; a development run does not set STATIC_DIR and is unaffected.
  await staticRoutes(app, env.staticDir);

  return { app, env, db };
}
