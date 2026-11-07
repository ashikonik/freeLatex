import { eq } from 'drizzle-orm';

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
 * The credential in the Authorization header wins over a share token in the
 * query string, so a signed-in collaborator is never downgraded to a lesser
 * share permission.
 *
 * A credential in the header is judged by its shape: a `rw_`/`ro_` prefix
 * means a share token, anything else is an account key. Without this, a
 * reader who arrived through a share link could not make any request at
 * all, because the browser sends the link's token as a bearer while the
 * share token is only ever accepted as a query parameter.
 */
export function authenticateRequest(
  context: AuthContext,
  request: { authorization?: string; shareToken?: string },
  now: Date = new Date(),
): AuthResult {
  const bearer = parseBearer(request.authorization);
  if (bearer) {
    if (isShareTokenShape(bearer)) {
      return authenticateShareToken(context, bearer, now);
    }
    return authenticateApiKey(context, bearer);
  }
  if (request.shareToken) {
    return authenticateShareToken(context, request.shareToken, now);
  }
  return fail('No credentials provided.');
}

/**
 * The prefixes a share token carries.
 *
 * The prefix is what tells a share token apart from an API key without
 * consulting the database, which is what a WebSocket upgrade needs: the
 * browser's WebSocket API cannot set request headers, so the credential has
 * to travel in the query string, where both kinds of token can appear.
 */
const SHARE_TOKEN_PREFIXES = ['rw_', 'ro_'] as const;

/**
 * True when a credential is shaped like a share token.
 */
export function isShareTokenShape(token: string): boolean {
  return SHARE_TOKEN_PREFIXES.some((prefix) => token.startsWith(prefix));
}

/**
 * Resolve an identity from a WebSocket upgrade request.
 *
 * The credential may arrive in the `Authorization` header or in the query
 * string. The query string is needed because the browser's WebSocket API
 * cannot set headers, so a browser client has nowhere else to put its key.
 *
 * A credential in the header is always an API key, because the header is the
 * account credential in the REST API. A credential in the query string is
 * judged by its shape: a `rw_`/`ro_` prefix means a share token, anything
 * else is an API key.
 */
export function authenticateWebSocket(
  context: AuthContext,
  request: { authorization?: string; token?: string },
  now: Date = new Date(),
): AuthResult {
  const bearer = parseBearer(request.authorization);
  if (bearer) {
    return authenticateApiKey(context, bearer);
  }

  const token = request.token?.trim();
  if (!token) {
    return fail('No credentials provided.');
  }

  if (isShareTokenShape(token)) {
    return authenticateShareToken(context, token, now);
  }

  return authenticateApiKey(context, token);
}
