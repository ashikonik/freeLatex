import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { openDatabase, type DbHandle } from '../db/index.js';
import { projects, shareTokens, users } from '../db/schema.js';
import { hashSecret } from '../utils/hash.js';
import {
  authenticateApiKey,
  authenticateRequest,
  authenticateShareToken,
  parseBearer,
  type AuthContext,
} from './service.js';

const ADMIN_KEY = 'admin-secret-key';
const USER_KEY = 'sk_user_abcdef0123456789';

let handle: DbHandle;

function context(authMode: 'single' | 'multi'): AuthContext {
  return { db: handle.db, authMode, adminApiKey: ADMIN_KEY };
}

beforeEach(() => {
  handle = openDatabase(':memory:', ':memory:');
  handle.db
    .insert(users)
    .values({ id: 'usr_1', apiKeyHash: hashSecret(USER_KEY), name: 'Ada', role: 'user' })
    .run();
  handle.db
    .insert(users)
    .values({ id: 'owner_1', apiKeyHash: hashSecret('owner-key'), name: 'Owner' })
    .run();
  handle.db
    .insert(projects)
    .values({ id: 'prj_1', ownerId: 'owner_1', title: 'Thesis' })
    .run();
});

afterEach(() => {
  handle.close();
});

describe('parseBearer', () => {
  it('extracts the token from a Bearer header', () => {
    expect(parseBearer('Bearer abc123')).toBe('abc123');
  });

  it('is case-insensitive on the scheme', () => {
    expect(parseBearer('bearer abc123')).toBe('abc123');
  });

  it('returns undefined for a missing or non-Bearer header', () => {
    expect(parseBearer(undefined)).toBeUndefined();
    expect(parseBearer('')).toBeUndefined();
    expect(parseBearer('Basic abc')).toBeUndefined();
    expect(parseBearer('Bearer   ')).toBeUndefined();
  });
});

describe('authenticateApiKey', () => {
  it('accepts the admin key in single mode', () => {
    const result = authenticateApiKey(context('single'), ADMIN_KEY);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.kind).toBe('admin');
      expect(result.identity.role).toBe('admin');
    }
  });

  it('rejects a wrong key in single mode', () => {
    const result = authenticateApiKey(context('single'), 'wrong');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(401);
    }
  });

  it('rejects a user key in single mode', () => {
    const result = authenticateApiKey(context('single'), USER_KEY);

    expect(result.ok).toBe(false);
  });

  it('accepts a provisioned user key in multi mode', () => {
    const result = authenticateApiKey(context('multi'), USER_KEY);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.kind).toBe('user');
      expect(result.identity.userId).toBe('usr_1');
      expect(result.identity.name).toBe('Ada');
    }

  });

  it('accepts the admin key in multi mode', () => {
    const result = authenticateApiKey(context('multi'), ADMIN_KEY);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.kind).toBe('admin');
    }
  });

  it('rejects a missing key', () => {
    const result = authenticateApiKey(context('multi'), undefined);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/Missing API key/);
    }
  });

  it('rejects a key whose prefix looks right but is wrong', () => {
    expect(authenticateApiKey(context('multi'), 'sk_user_wrong').ok).toBe(false);
  });
});

describe('authenticateShareToken', () => {
  beforeEach(() => {
    handle.db
      .insert(shareTokens)
      .values({
        id: 'shr_rw',
        projectId: 'prj_1',
        tokenHash: hashSecret('rw_abc'),
        permission: 'rw',
      })
      .run();
    handle.db
      .insert(shareTokens)
      .values({
        id: 'shr_ro',
        projectId: 'prj_1',
        tokenHash: hashSecret('ro_abc'),
        permission: 'ro',
      })
      .run();
  });

  it('accepts a read-write token', () => {
    const result = authenticateShareToken(context('multi'), 'rw_abc');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.kind).toBe('share');
      expect(result.identity.projectId).toBe('prj_1');
      expect(result.identity.permission).toBe('rw');
    }
  });

  it('accepts a read-only token', () => {
    const result = authenticateShareToken(context('multi'), 'ro_abc');

    expect(result.ok).toBe(true);
    if (result.ok && result.identity.kind === 'share') {
      expect(result.identity.permission).toBe('ro');
    }
  });

  it('rejects an unknown token', () => {
    expect(authenticateShareToken(context('multi'), 'rw_unknown').ok).toBe(false);
  });

  it('rejects a token with the wrong prefix', () => {
    expect(authenticateShareToken(context('multi'), 'xx_abc').ok).toBe(false);
  });

  it('rejects an expired token', () => {
    handle.db
      .insert(shareTokens)
      .values({
        id: 'shr_old',
        projectId: 'prj_1',
        tokenHash: hashSecret('rw_old'),
        permission: 'rw',
        expiresAt: new Date('2020-01-01T00:00:00Z'),
      })
      .run();

    const result = authenticateShareToken(context('multi'), 'rw_old');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/expired/i);
    }
  });

  it('accepts a token that has not expired yet', () => {
    handle.db
      .insert(shareTokens)
      .values({
        id: 'shr_future',
        projectId: 'prj_1',
        tokenHash: hashSecret('rw_future'),
        permission: 'rw',
        expiresAt: new Date('2999-01-01T00:00:00Z'),
      })
      .run();

    expect(authenticateShareToken(context('multi'), 'rw_future').ok).toBe(true);
  });
});

describe('authenticateRequest', () => {
  it('prefers the Authorization header over a share token', () => {
    handle.db
      .insert(shareTokens)
      .values({
        id: 'shr_1',
        projectId: 'prj_1',
        tokenHash: hashSecret('ro_abc'),
        permission: 'ro',
      })
      .run();

    const result = authenticateRequest(context('multi'), {
      authorization: `Bearer ${ADMIN_KEY}`,
      shareToken: 'ro_abc',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.kind).toBe('admin');
    }
  });

  it('falls back to the share token when no header is present', () => {
    handle.db
      .insert(shareTokens)
      .values({
        id: 'shr_1',
        projectId: 'prj_1',
        tokenHash: hashSecret('ro_abc'),
        permission: 'ro',
      })
      .run();

    const result = authenticateRequest(context('multi'), { shareToken: 'ro_abc' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.kind).toBe('share');
    }
  });

  it('rejects a request with no credentials at all', () => {
    const result = authenticateRequest(context('multi'), {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/No credentials/);
    }
  });
});

describe('key isolation', () => {
  it('keeps a user scoped to their own projects', () => {
    handle.db
      .insert(projects)
      .values({ id: 'prj_other', ownerId: 'usr_1', title: 'Other' })
      .run();

    const mine = handle.db.select().from(projects).where(eq(projects.ownerId, 'usr_1')).all();
    const theirs = handle.db.select().from(projects).where(eq(projects.ownerId, 'owner_1')).all();

    expect(mine.map((p) => p.id)).toEqual(['prj_other']);
    expect(theirs.map((p) => p.id)).toEqual(['prj_1']);
  });
});
