import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import type { AuthContext } from '../auth/service.js';
import { shareTokens } from '../db/schema.js';
import { generateSecret, hashSecret } from '../utils/hash.js';
import { isAccount } from '../auth/identity.js';

interface CreateShareBody {
  /** 'rw' for edit access, 'ro' for view-only. */
  permission?: 'rw' | 'ro';
  label?: string;
  /** ISO timestamp; omit for a token that never expires. */
  expiresAt?: string;
}

const SHARE_TOKEN_PREFIX = { rw: 'rw_', ro: 'ro_' } as const;

/**
 * Share-link routes: mint, list, and revoke project access tokens.
 */
export async function shareRoutes(app: FastifyInstance, context: AuthContext): Promise<void> {
  /**
   * Create a share token for a project.
   *
   * The plaintext token is returned exactly once, in the response. Only its
   * hash is persisted, so a leaked database cannot be used to forge links.
   */
  app.post('/api/projects/:id/share', async (request, reply) => {
    const { id } = request.params as { id: string };
    const identity = request.identity;

    if (!identity || !isAccount(identity)) {
      return reply.status(403).send({ error: 'Only the project owner can share it.' });
    }

    const body = (request.body ?? {}) as CreateShareBody;
    const permission = body.permission === 'rw' ? 'rw' : 'ro';
    const label = body.label?.trim() || null;

    let expiresAt: Date | null = null;
    if (body.expiresAt) {
      const parsed = new Date(body.expiresAt);
      if (Number.isNaN(parsed.getTime())) {
        return reply.status(400).send({ error: 'expiresAt must be a valid ISO timestamp.' });
      }
      if (parsed.getTime() <= Date.now()) {
        return reply.status(400).send({ error: 'expiresAt must be in the future.' });
      }
      expiresAt = parsed;
    }

    const plaintext = generateSecret(SHARE_TOKEN_PREFIX[permission]);
    const tokenId = `shr_${nanoid(16)}`;

    context.db
      .insert(shareTokens)
      .values({
        id: tokenId,
        projectId: id,
        tokenHash: hashSecret(plaintext),
        permission,
        label,
        expiresAt,
      })
      .run();

    return reply.status(201).send({
      id: tokenId,
      token: plaintext,
      permission,
      label,
      expiresAt: expiresAt?.toISOString() ?? null,
      url: `/p/${id}?token=${plaintext}`,
    });
  });

  /** List a project's active share tokens. Plaintext tokens are not recoverable. */
  app.get('/api/projects/:id/share', async (request, reply) => {
    const { id } = request.params as { id: string };
    const identity = request.identity;

    if (!identity || !isAccount(identity)) {
      return reply.status(403).send({ error: 'Only the project owner can view share links.' });
    }

    const rows = context.db
      .select()
      .from(shareTokens)
      .where(eq(shareTokens.projectId, id))
      .all();

    const now = Date.now();
    return reply.send({
      tokens: rows.map((row) => ({
        id: row.id,
        permission: row.permission,
        label: row.label,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt?.toISOString() ?? null,
        expired: row.expiresAt !== null && row.expiresAt.getTime() <= now,
      })),
    });
  });

  /** Revoke a share token. */
  app.delete('/api/projects/:id/share/:tokenId', async (request, reply) => {
    const { id, tokenId } = request.params as { id: string; tokenId: string };
    const identity = request.identity;

    if (!identity || !isAccount(identity)) {
      return reply.status(403).send({ error: 'Only the project owner can revoke share links.' });
    }

    const result = context.db
      .delete(shareTokens)
      .where(and(eq(shareTokens.id, tokenId), eq(shareTokens.projectId, id)))
      .run();

    if (result.changes === 0) {
      return reply.status(404).send({ error: 'Share token not found.' });
    }
    return reply.status(204).send();
  });
}
