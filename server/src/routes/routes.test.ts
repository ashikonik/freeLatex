import { afterEach, describe, expect, it } from 'vitest';

import { buildApp, type BuiltApp } from '../app.js';
import { openDatabase, type DbHandle } from '../db/index.js';
import { projects, users } from '../db/schema.js';
import { hashSecret } from '../utils/hash.js';
import type { Env } from '../config/env.js';

const ADMIN_KEY = 'admin-secret-key';

let handle: DbHandle;
let built: BuiltApp;

function envFor(authMode: 'single' | 'multi'): Env {
  return {
    adminApiKey: ADMIN_KEY,
    authMode,
    port: 3030,
    host: '0.0.0.0',
    dataDir: '/tmp/freelatex-test',
    compileTimeoutMs: 30_000,
    nodeEnv: 'test',
    corsOrigin: '',
    staticDir: '',
  };
}

async function makeApp(authMode: 'single' | 'multi' = 'multi'): Promise<BuiltApp> {
  handle = openDatabase(':memory:', ':memory:');
  handle.db
    .insert(users)
    .values({ id: 'owner_1', apiKeyHash: hashSecret('owner-key'), name: 'Owner' })
    .run();
  handle.db
    .insert(projects)
    .values({ id: 'prj_1', ownerId: 'owner_1', title: 'Thesis' })
    .run();

  built = await buildApp({ env: envFor(authMode), db: handle });
  await built.app.ready();
  return built;
}

afterEach(async () => {
  await built?.app.close();
  handle?.close();
});

describe('GET /api/health', () => {
  it('responds without authentication', async () => {
    await makeApp();

    const response = await built.app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', authMode: 'multi' });
  });
});

describe('POST /api/auth/login', () => {
  it('accepts the admin key', async () => {
    await makeApp();

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { apiKey: ADMIN_KEY },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().identity).toMatchObject({ kind: 'admin', role: 'admin' });
  });

  it('rejects a wrong key with 401', async () => {
    await makeApp();

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { apiKey: 'nope' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBeTruthy();
  });
});

describe('GET /api/auth/me', () => {
  it('returns the caller identity', async () => {
    await makeApp();

    const response = await built.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: 'admin', role: 'admin' });
  });

  it('returns 401 without credentials', async () => {
    await makeApp();

    const response = await built.app.inject({ method: 'GET', url: '/api/auth/me' });

    expect(response.statusCode).toBe(401);
  });
});

describe('POST /api/auth/keys', () => {
  it('lets the admin provision a user key in multi mode', async () => {
    await makeApp('multi');

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/auth/keys',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { name: 'Grace' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.apiKey).toMatch(/^sk_user_[0-9a-f]{64}$/);
    expect(body.name).toBe('Grace');

    // The provisioned key must authenticate.
    const login = await built.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { apiKey: body.apiKey },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().identity).toMatchObject({ kind: 'user', name: 'Grace' });
  });

  it('refuses in single mode', async () => {
    await makeApp('single');

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/auth/keys',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { name: 'Grace' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a non-admin caller', async () => {
    await makeApp('multi');

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/auth/keys',
      headers: { authorization: 'Bearer sk_user_not_real' },
      payload: { name: 'Grace' },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('share tokens', () => {
  it('creates a read-write token and returns the share URL', async () => {
    await makeApp();

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/share',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { permission: 'rw', label: 'Reviewer' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.token).toMatch(/^rw_[0-9a-f]{64}$/);
    expect(body.url).toBe(`/p/prj_1?token=${body.token}`);
    expect(body.permission).toBe('rw');
  });

  it('defaults to a read-only token', async () => {
    await makeApp();

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/share',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: {},
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().token).toMatch(/^ro_[0-9a-f]{64}$/);
  });

  it('rejects a past expiry', async () => {
    await makeApp();

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/share',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { expiresAt: '2000-01-01T00:00:00Z' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a malformed expiry', async () => {
    await makeApp();

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/share',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { expiresAt: 'not-a-date' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('lists tokens without exposing their plaintext', async () => {
    await makeApp();

    await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/share',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { permission: 'rw' },
    });

    const response = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/share',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });

    expect(response.statusCode).toBe(200);
    const tokens = response.json().tokens;
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).not.toHaveProperty('token');
    expect(tokens[0].permission).toBe('rw');
  });

  it('revokes a token, after which it no longer authenticates', async () => {
    await makeApp();

    const created = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/share',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { permission: 'rw' },
    });
    const tokenId = created.json().id;
    const plaintext = created.json().token;

    // The token works before revocation.
    const before = await built.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      query: { token: plaintext },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().kind).toBe('share');

    const revoked = await built.app.inject({
      method: 'DELETE',
      url: `/api/projects/prj_1/share/${tokenId}`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(revoked.statusCode).toBe(204);

    const after = await built.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      query: { token: plaintext },
    });
    expect(after.statusCode).toBe(401);
  });

  it('returns 404 when revoking an unknown token', async () => {
    await makeApp();

    const response = await built.app.inject({
      method: 'DELETE',
      url: '/api/projects/prj_1/share/shr_missing',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses share-token access to admin-only endpoints', async () => {
    await makeApp();

    const created = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/share',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { permission: 'rw' },
    });
    const plaintext = created.json().token;

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/auth/keys',
      query: { token: plaintext },
      payload: { name: 'Sneaky' },
    });

    expect(response.statusCode).toBe(403);
  });
});
