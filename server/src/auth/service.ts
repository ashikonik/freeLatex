import { and, eq } from 'drizzle-orm';

import type { Db } from '../db/index.js';
import { shareTokens, users } from '../db/schema.js';
import { hashSecret, verifySecret } from '../utils/hash.js';
import type { AuthMode } from '../config/env.js';
import type { AdminIdentity, Identity, ShareIdentity, UserIdentity } from './identity.js';

export interface AuthContext {
  db: Db;
  authMode: AuthMode;
  adminApiKey: string;
}

export type AuthResult<T extends Identity = Identity> =
  | { ok: true; identity: T }
  | { ok: false; statusCode: 401; message: string };

/** Extract a bearer token from an Authorization header. */
export function parseBearer(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

function fail<T extends Identity = Identity>(message: string): AuthResult<T> {
  return { ok: false, statusCode: 401, message };
}

/**
 * Resolve an identity from an API key.
 *
 * In single-host mode the master key is the only accepted credential, and it
 * always maps to the admin identity. In multi-tenant mode the master key also
 * works (the admin provisions user keys with it), and provisioned sk_user_...
 * keys map to their owning user.
 */
export function authenticateApiKey(
  context: AuthContext,
  apiKey: string | undefined,
): AuthResult<AdminIdentity | UserIdentity> {
  if (!apiKey) {
    return fail<AdminIdentity | UserIdentity>('Missing API key.');
  }

  // The admin key is compared with a constant-time check so a wrong key
  // cannot be discovered by timing the response.
  if (verifySecret(apiKey, hashSecret(context.adminApiKey))) {
    return { ok: true, identity: { kind: 'admin', role: 'admin', userId: 'admin', name: 'Admin' } };
  }

  if (context.authMode === 'single') {
    return fail<AdminIdentity | UserIdentity>('Invalid API key.');
  }

  const user = context.db
    .select()
    .from(users)
    .where(eq(users.apiKeyHash, hashSecret(apiKey)))
    .get();

  if (!user) {
    return fail<AdminIdentity | UserIdentity>('Invalid API key.');
  }

  return {
    ok: true,
    identity: { kind: 'user', role: 'user', userId: user.id, name: user.name },
  };
}

/**
 * Resolve an identity from a share token.
 *
 * A share token grants access to exactly one project. Read-only tokens may not
 * modify anything. Expired tokens are rejected.
 */
export function authenticateShareToken(
  context: AuthContext,
  token: string | undefined,
  now: Date = new Date(),
): AuthResult<ShareIdentity> {
  if (!token) {
    return fail<ShareIdentity>('Missing share token.');
  }

  const record = context.db
    .select()
    .from(shareTokens)
    .where(eq(shareTokens.tokenHash, hashSecret(token)))
    .get();

  if (!record) {
    return fail<ShareIdentity>('Invalid share token.');
  }

  if (record.expiresAt !== null && record.expiresAt.getTime() <= now.getTime()) {
    return fail<ShareIdentity>('Share token has expired.');
  }

  return {
    ok: true,
    identity: {
      kind: 'share',
      role: 'share',
      tokenId: record.id,
      projectId: record.projectId,
      permission: record.permission,
    },
  };
}

/**
 * Resolve an identity from whichever credential the request carries.
 *
 * An Authorization header wins over a share token query parameter, so a
 * signed-in collaborator is never downgraded to a lesser share permission.
 */
export function authenticateRequest(
  context: AuthContext,
  request: { authorization?: string; shareToken?: string },
  now: Date = new Date(),
): AuthResult {
  const bearer = parseBearer(request.authorization);
  if (bearer) {
    return authenticateApiKey(context, bearer);
  }
  if (request.shareToken) {
    return authenticateShareToken(context, request.shareToken, now);
  }
  return fail('No credentials provided.');
}

/**
 * Find the share token record for a project that matches the given plaintext.
 *
 * Used when a project-scoped request must confirm the caller holds a token
 * for *this* project rather than for some other project.
 */
export function findShareTokenForProject(
  db: Db,
  projectId: string,
  plaintextToken: string,
): typeof shareTokens.$inferSelect | undefined {
  return db
    .select()
    .from(shareTokens)
    .where(
      and(eq(shareTokens.projectId, projectId), eq(shareTokens.tokenHash, hashSecret(plaintextToken))),
    )
    .get();
}
