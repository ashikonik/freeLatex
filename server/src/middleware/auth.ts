import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AuthContext } from '../auth/service.js';
import { authenticateRequest } from '../auth/service.js';
import type { Identity } from '../auth/identity.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireAuth` once the request's credentials are validated. */
    identity?: Identity;
  }
}

/**
 * Attach the resolved identity to the request.
 *
 * Responds 401 with a JSON error body when credentials are missing or invalid.
 * Fastify stops the request lifecycle once the reply is sent from an
 * onRequest hook, so the route handler never runs for a rejected request.
 */
export function requireAuth(context: AuthContext) {
  return async function authHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = request.query as { token?: string } | undefined;

    const result = authenticateRequest(context, {
      authorization: request.headers.authorization,
      shareToken: query?.token,
    });

    if (!result.ok) {
      await reply.status(result.statusCode).send({ error: result.message });
      return;
    }

    request.identity = result.identity;
  };
}
