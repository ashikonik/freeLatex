import { existsSync } from 'node:fs';
import { join } from 'node:path';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * The client's built files, served by the server.
 *
 * A deployment that ships one container needs the server to hand out the
 * client's files as well as answer the API, so that a browser talks to a
 * single origin and no CORS or cookie handling is needed.
 *
 * The client's routes are the paths of a single-page application: every
 * path that is not a file of the build is the application itself, and the
 * server answers it with `index.html` so that the browser's router can take
 * over.
 */
export async function staticRoutes(
  app: FastifyInstance,
  staticDir: string,
): Promise<void> {
  if (!staticDir || !existsSync(join(staticDir, 'index.html'))) {
    // There is no build to serve. This is the case in development, where
    // Vite serves the client, and in the tests, where only the API matters.
    return;
  }

  await app.register(fastifyStatic, {
    root: staticDir,
    // The build's own files are fingerprinted by Vite, so they can be
    // cached for as long as the browser likes. The page itself names the
    // fingerprinted files, so a stale page would point at files that are
    // gone; it is therefore never cached.
    cacheControl: true,
    maxAge: '1h',
    index: ['index.html'],
    setHeaders(reply, path) {
      if (path.endsWith('index.html')) {
        reply.header('cache-control', 'no-cache');
      }
    },
  });

  // The application itself is a single page, so a path that is not a file
  // of the build is answered with the page rather than with a 404.
  app.setNotFoundHandler((request, reply) => {
    // `/api` without a trailing slash is the API too, and `/ws` is the
    // WebSocket's path, so neither is the application.
    if (
      request.url === '/api' ||
      request.url.startsWith('/api/') ||
      request.url === '/ws' ||
      request.url.startsWith('/ws/')
    ) {
      return reply.status(404).send({ error: 'Not found.' });
    }
    return reply.type('text/html').sendFile('index.html');
  });
}
