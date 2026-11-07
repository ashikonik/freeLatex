import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp, type BuiltApp } from '../app.js';
import { openDatabase, type DbHandle } from '../db/index.js';
import { projects, shareTokens, users } from '../db/schema.js';
import { hashSecret } from '../utils/hash.js';
import type { Env } from '../config/env.js';

const ADMIN_KEY = 'admin-secret-key';
const OWNER_KEY = 'sk_user_owner_key_value';
const ATTACKER_KEY = 'sk_user_attacker_key_value';

let handle: DbHandle;
let built: BuiltApp;

function envFor(): Env {
  return {
    adminApiKey: ADMIN_KEY,
    authMode: 'multi',
    port: 3030,
    host: '0.0.0.0',
    dataDir: '/tmp/freelatex-test',
    compileTimeoutMs: 30_000,
    nodeEnv: 'test',
    corsOrigin: '',
    staticDir: '',
  };
}

beforeEach(async () => {
  handle = openDatabase(':memory:', ':memory:');

  handle.db
    .insert(users)
    .values({ id: 'owner', apiKeyHash: hashSecret(OWNER_KEY), name: 'Owner', role: 'user' })
    .run();
  handle.db
    .insert(users)
    .values({ id: 'attacker', apiKeyHash: hashSecret(ATTACKER_KEY), name: 'Attacker', role: 'user' })
    .run();

  handle.db
    .insert(projects)
    .values({ id: 'owner_project', ownerId: 'owner', title: 'Owner Thesis' })
    .run();
  handle.db
    .insert(projects)
    .values({ id: 'attacker_project', ownerId: 'attacker', title: 'Attacker Doc' })
    .run();

  built = await buildApp({ env: envFor(), db: handle });
  await built.app.ready();
});

afterEach(async () => {
  await built?.app.close();
  handle?.close();
});

describe('cross-tenant share token isolation', () => {
  it('refuses to mint a share link on another user project', async () => {
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects/owner_project/share',
      headers: { authorization: `Bearer ${ATTACKER_KEY}` },
      payload: { permission: 'rw' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses to list another user project share links', async () => {
    const response = await built.app.inject({
      method: 'GET',
      url: '/api/projects/owner_project/share',
      headers: { authorization: `Bearer ${ATTACKER_KEY}` },
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses to revoke another user project share links', async () => {
    // The owner creates a real token first.
    const created = await built.app.inject({
      method: 'POST',
      url: '/api/projects/owner_project/share',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { permission: 'rw' },
    });
    expect(created.statusCode).toBe(201);
    const tokenId = created.json().id;
    const plaintext = created.json().token;

    // The attacker tries to revoke it.
    const revoke = await built.app.inject({
      method: 'DELETE',
      url: `/api/projects/owner_project/share/${tokenId}`,
      headers: { authorization: `Bearer ${ATTACKER_KEY}` },
    });
    expect(revoke.statusCode).toBe(403);

    // The owner's token must still work.
    const check = await built.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      query: { token: plaintext },
    });
    expect(check.statusCode).toBe(200);
  });

  it('refuses to mint a share link with a share token', async () => {
    const created = await built.app.inject({
      method: 'POST',
      url: '/api/projects/owner_project/share',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { permission: 'rw' },
    });
    const plaintext = created.json().token;

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects/owner_project/share',
      query: { token: plaintext },
      payload: { permission: 'rw' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('lets a user manage share links on their own project', async () => {
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects/attacker_project/share',
      headers: { authorization: `Bearer ${ATTACKER_KEY}` },
      payload: { permission: 'ro' },
    });

    expect(response.statusCode).toBe(201);
  });

  it('lets the admin manage share links on any project', async () => {
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects/owner_project/share',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { permission: 'rw' },
    });

    expect(response.statusCode).toBe(201);
  });
});

describe('key revocation', () => {
  it('invalidates a user key when the admin revokes it', async () => {
    const before = await built.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { apiKey: ATTACKER_KEY },
    });
    expect(before.statusCode).toBe(200);

    const revoke = await built.app.inject({
      method: 'DELETE',
      url: '/api/auth/keys/attacker',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(revoke.statusCode).toBe(204);

    const after = await built.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { apiKey: ATTACKER_KEY },
    });
    expect(after.statusCode).toBe(401);
  });

  it('refuses to revoke the admin account', async () => {
    const response = await built.app.inject({
      method: 'DELETE',
      url: '/api/auth/keys/admin',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses revocation by a non-admin', async () => {
    const response = await built.app.inject({
      method: 'DELETE',
      url: '/api/auth/keys/attacker',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('share token binding', () => {
  it('reports the project a share token is bound to', async () => {
    const created = await built.app.inject({
      method: 'POST',
      url: '/api/projects/owner_project/share',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { permission: 'rw' },
    });
    const plaintext = created.json().token;

    const response = await built.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      query: { token: plaintext },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      kind: 'share',
      projectId: 'owner_project',
      permission: 'rw',
    });
  });

  it('cannot use a share token to act on a different project', async () => {
    // The share token is bound to owner_project.
    handle.db
      .insert(shareTokens)
      .values({
        id: 'shr_bound',
        projectId: 'owner_project',
        tokenHash: hashSecret('rw_bound'),
        permission: 'rw',
      })
      .run();

    // canAccessProject must refuse it for attacker_project.
    const { canAccessProject } = await import('../auth/authorize.js');
    const identity = {
      kind: 'share' as const,
      role: 'share' as const,
      tokenId: 'shr_bound',
      projectId: 'owner_project',
      permission: 'rw' as const,
    };

    const allowed = canAccessProject(handle.db, identity, 'attacker_project');
    expect(allowed.allowed).toBe(false);

    const permitted = canAccessProject(handle.db, identity, 'owner_project');
    expect(permitted.allowed).toBe(true);
  });
});
