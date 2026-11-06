import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AuthContext } from '../auth/service.js';
import { authenticateRequest } from '../auth/service.js';
import type { Identity } from '../auth/identity.js';
import { canWrite, isAccount, isAdmin } from '../auth/identity.js';

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

/**
 * Guard that requires an account-level identity (admin or provisioned user).
 *
 * Share tokens are rejected: they are scoped to a single project and must not
 * reach instance-wide endpoints such as project listing or key provisioning.
 */
export async function requireAccount(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const identity = request.identity;
  if (!identity || !isAccount(identity)) {
    await reply.status(403).send({ error: 'This endpoint requires an account API key.' });
  }
}

/** Guard that requires the admin role. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const identity = request.identity;
  if (!identity || !isAdmin(identity)) {
    await reply.status(403).send({ error: 'This endpoint requires the admin API key.' });
  }
}

/** Guard that rejects read-only share tokens on mutating endpoints. */
export async function requireWrite(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const identity = request.identity;
  if (!identity) {
    await reply.status(401).send({ error: 'Not authenticated.' });
    return;
  }
  if (!canWrite(identity)) {
    await reply.status(403).send({ error: 'This share link is read-only.' });
  }
}
