import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';

import type { AuthContext } from '../auth/service.js';
import { authenticateApiKey, parseBearer } from '../auth/service.js';
import { users } from '../db/schema.js';
import { generateSecret, hashSecret } from '../utils/hash.js';
import { nanoid } from 'nanoid';

interface CreateKeyBody {
  name?: string;
}

interface ListKeysReply {
  keys: Array<{ id: string; name: string; role: string; createdAt: string }>;
}

/**
 * The login route, registered outside the authenticated scope.
 *
 * It is the endpoint that *establishes* credentials, so it takes the API key
 * from the request body (or the Authorization header) and validates it itself
 * rather than relying on the `requireAuth` hook.
 */
export async function loginRoutes(
  app: FastifyInstance,
  options: { context: AuthContext },
): Promise<void> {
  const { context } = options;
  app.post('/api/auth/login', async (request, reply) => {
    const body = request.body as { apiKey?: string } | undefined;
    const apiKey = body?.apiKey?.trim() || parseBearer(request.headers.authorization);

    const result = authenticateApiKey(context, apiKey);
    if (!result.ok) {
      return reply.status(result.statusCode).send({ error: result.message });
    }

    return reply.send({
      identity: {
        kind: result.identity.kind,
        role: result.identity.role,
        name: result.identity.name,
        userId: result.identity.userId,
      },
      authMode: context.authMode,
    });
  });
}

/**
 * Authentication routes: identity lookup and admin key provisioning.
 *
 * These sit behind the `requireAuth` hook — the caller is already known.
 */
export async function authRoutes(
  app: FastifyInstance,
  options: { context: AuthContext },
): Promise<void> {
  const { context } = options;
  /** Return the authenticated caller's identity. */
  app.get('/api/auth/me', async (request, reply) => {
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }

    return reply.send({
      kind: identity.kind,
      role: identity.role,
      ...(identity.kind === 'share'
        ? { projectId: identity.projectId, permission: identity.permission }
        : { name: identity.name, userId: identity.userId }),
    });
  });

  /**
   * Provision a new user API key.
   *
   * Admin only, and only meaningful in multi-tenant mode — in single mode the
   * master key is the only credential the instance accepts.
   */
  app.post('/api/auth/keys', async (request, reply) => {
    const identity = request.identity;
    if (!identity || identity.kind !== 'admin') {
      return reply.status(403).send({ error: 'This endpoint requires the admin API key.' });
    }

    if (context.authMode !== 'multi') {
      return reply
        .status(400)
        .send({ error: 'User keys can only be provisioned when AUTH_MODE=multi.' });
    }

    const body = (request.body ?? {}) as CreateKeyBody;
    const name = body.name?.trim() || 'Unnamed user';
    const plaintext = generateSecret('sk_user_');
    const userId = `usr_${nanoid(16)}`;

    context.db
      .insert(users)
      .values({
        id: userId,
        apiKeyHash: hashSecret(plaintext),
        name,
        role: 'user',
      })
      .run();

    return reply.status(201).send({
      id: userId,
      name,
      role: 'user',
      // Shown once. Only the hash is stored, so it cannot be shown again.
      apiKey: plaintext,
    });
  });

  /** List provisioned users. The API keys themselves are never returned. */
  app.get('/api/auth/keys', async (request, reply) => {
    const identity = request.identity;
    if (!identity || identity.kind !== 'admin') {
      return reply.status(403).send({ error: 'This endpoint requires the admin API key.' });
    }

    const rows = context.db.select().from(users).where(eq(users.role, 'user')).limit(1000).all();

    const payload: ListKeysReply = {
      keys: rows.map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        createdAt: row.createdAt.toISOString(),
      })),
    };
    return reply.send(payload);
  });

  /**
   * Revoke a provisioned user key.
   *
   * Deleting the user row invalidates the key immediately — only the hash is
   * stored, so there is nothing else to change. The user's projects cascade
   * away with it.
   */
  app.delete('/api/auth/keys/:id', async (request, reply) => {
    const identity = request.identity;
    if (!identity || identity.kind !== 'admin') {
      return reply.status(403).send({ error: 'This endpoint requires the admin API key.' });
    }

    const { id } = request.params as { id: string };

    const result = context.db
      .delete(users)
      .where(and(eq(users.id, id), eq(users.role, 'user')))
      .run();

    if (result.changes === 0) {
      return reply.status(404).send({ error: 'User key not found.' });
    }
    return reply.status(204).send();
  });
}
