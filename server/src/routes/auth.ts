import type { FastifyInstance, FastifyRequest } from 'fastify';
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
 * How many failed logins one address may make in a window.
 *
 * The login endpoint is the only route that is open to everybody, so it is
 * the one an attacker will use to try key after key. The keys are long random
 * strings and cannot be guessed, but an unthrottled endpoint is still an
 * oracle: it answers faster than the keys can be tried and it shows whether
 * a guess was close. A few failures in a window are a fat finger; a flood of
 * them is an attack.
 */
const MAX_FAILED_LOGINS = 10;

/**
 * How long the failed attempts are remembered.
 */
const LOGIN_WINDOW_MS = 60_000;

/**
 * The address a request came from.
 *
 * The forwarded header is only trusted when the deployment sits behind a
 * proxy that sets it; otherwise the address is the socket's.
 */
function clientAddress(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof first === 'string' && first.length > 0) {
    return first.split(',')[0]?.trim() || request.ip;
  }
  return request.ip;
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

  /**
   * The failed logins of each address, with the time of the last one.
   *
   * The record belongs to the application rather than to the module, so a
   * restarted server starts with a clean sheet and two applications in one
   * process do not share their history.
   */
  const failedLogins = new Map<string, { count: number; lastAt: number }>();

  /**
   * Whether the address has made too many failed logins recently.
   */
  const isThrottled = (address: string): boolean => {
    const entry = failedLogins.get(address);
    if (!entry) {
      return false;
    }
    if (Date.now() - entry.lastAt > LOGIN_WINDOW_MS) {
      failedLogins.delete(address);
      return false;
    }
    return entry.count >= MAX_FAILED_LOGINS;
  };

  /**
   * Record a failed login for the address.
   */
  const recordFailure = (address: string): void => {
    const entry = failedLogins.get(address);
    if (!entry || Date.now() - entry.lastAt > LOGIN_WINDOW_MS) {
      failedLogins.set(address, { count: 1, lastAt: Date.now() });
      return;
    }
    entry.count += 1;
    entry.lastAt = Date.now();
  };

  app.post('/api/auth/login', async (request, reply) => {
    const address = clientAddress(request);
    if (isThrottled(address)) {
      return reply
        .status(429)
        .header('Retry-After', String(Math.ceil(LOGIN_WINDOW_MS / 1000)))
        .send({ error: 'Too many failed sign-in attempts. Try again in a minute.' });
    }

    const body = request.body as { apiKey?: string } | undefined;
    const apiKey = body?.apiKey?.trim() || parseBearer(request.headers.authorization);

    const result = authenticateApiKey(context, apiKey);
    if (!result.ok) {
      recordFailure(address);
      return reply.status(result.statusCode).send({ error: result.message });
    }

    // The address has just proved it knows the key, so its failures are
    // forgotten.
    failedLogins.delete(address);

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
