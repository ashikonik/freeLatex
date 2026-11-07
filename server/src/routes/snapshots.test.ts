import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildApp, type BuiltApp } from '../app.js';
import { openDatabase, type DbHandle } from '../db/index.js';
import { projects, users } from '../db/schema.js';
import { hashSecret } from '../utils/hash.js';
import type { Env } from '../config/env.js';

const ADMIN_KEY = 'admin-secret-key';
const OWNER_KEY = 'sk_user_owner_key_value';

let handle: DbHandle;
let built: BuiltApp;
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'freelatex-snapshots-'));

  handle = openDatabase(':memory:', ':memory:');
  handle.db
    .insert(users)
    .values({ id: 'owner', apiKeyHash: hashSecret(OWNER_KEY), name: 'Owner', role: 'user' })
    .run();
  handle.db
    .insert(users)
    .values({ id: 'other', apiKeyHash: hashSecret('other-key'), name: 'Other', role: 'user' })
    .run();
  handle.db
    .insert(projects)
    .values({ id: 'prj_1', ownerId: 'owner', title: 'Thesis' })
    .run();
  handle.db
    .insert(projects)
    .values({ id: 'prj_other', ownerId: 'other', title: 'Not Mine' })
    .run();

  built = await buildApp({ env: envFor(), db: handle });
  await built.app.ready();
});

afterEach(async () => {
  await built?.app.close();
  handle?.close();
  await rm(dataDir, { recursive: true, force: true });
});

function envFor(): Env {
  return {
    adminApiKey: ADMIN_KEY,
    authMode: 'multi',
    port: 3030,
    host: '0.0.0.0',
    dataDir,
    compileTimeoutMs: 30_000,
    nodeEnv: 'test',
    staticDir: '',
  };
}

/** Write a file into prj_1 through the API. */
async function writeFile(path: string, content: string): Promise<void> {
  await built.app.inject({
    method: 'PUT',
    url: `/api/projects/prj_1/files/${path}`,
    headers: { authorization: `Bearer ${OWNER_KEY}` },
    payload: { content },
  });
}

describe('POST /api/projects/:id/snapshots', () => {
  it('captures a snapshot', async () => {
    await writeFile('main.tex', 'hello');

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/snapshots',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { label: 'First cut' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.label).toBe('First cut');
    expect(body.createdBy).toBe('owner');
    expect(body.id).toMatch(/^snap_/);
  });

  it('refuses to snapshot another user’s project', async () => {
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_other/snapshots',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { label: 'Sneaky' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('requires authentication', async () => {
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/snapshots',
      payload: {},
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('GET /api/projects/:id/snapshots', () => {
  it('lists the revision history', async () => {
    await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/snapshots',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { label: 'One' },
    });

    const response = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/snapshots',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().snapshots).toHaveLength(1);
  });
});

describe('GET /api/projects/:id/snapshots/:snapshotId/diff', () => {
  it('returns a unified diff between two snapshots', async () => {
    await writeFile('main.tex', 'first\n');
    const before = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/snapshots',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { label: 'Before' },
    });

    await writeFile('main.tex', 'first\nsecond\n');
    const after = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/snapshots',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { label: 'After' },
    });

    const response = await built.app.inject({
      method: 'GET',
      url: `/api/projects/prj_1/snapshots/${before.json().id}/diff`,
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      query: { against: after.json().id },
    });

    expect(response.statusCode).toBe(200);
    const diffs = response.json().diffs;
    expect(diffs).toHaveLength(1);
    expect(diffs[0].path).toBe('main.tex');
    expect(diffs[0].changeType).toBe('modified');
    expect(diffs[0].patch).toContain('+second');
  });

  it('diffs against the newest snapshot by default', async () => {
    await writeFile('main.tex', 'first\n');
    const before = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/snapshots',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { label: 'Before' },
    });

    await writeFile('main.tex', 'first\nsecond\n');
    await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/snapshots',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { label: 'After' },
    });

    const response = await built.app.inject({
      method: 'GET',
      url: `/api/projects/prj_1/snapshots/${before.json().id}/diff`,
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().diffs[0].addedLines).toBe(1);
  });

  it('returns 404 for an unknown snapshot', async () => {
    const response = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/snapshots/snap_missing/diff',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/projects/:id/snapshots/:snapshotId/rollback', () => {
  it('restores the project to the snapshot', async () => {
    await writeFile('main.tex', 'original');
    const created = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/snapshots',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { label: 'Good' },
    });

    await writeFile('main.tex', 'mangled');

    const rollback = await built.app.inject({
      method: 'POST',
      url: `/api/projects/prj_1/snapshots/${created.json().id}/rollback`,
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(rollback.statusCode).toBe(200);
    expect(rollback.json().restored).toBe(true);

    const read = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/files/main.tex',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });
    expect(read.json().content).toBe('original');
  });

  it('refuses to roll back another user’s project', async () => {
    const created = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/snapshots',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { label: 'Mine' },
    });

    const response = await built.app.inject({
      method: 'POST',
      url: `/api/projects/prj_other/snapshots/${created.json().id}/rollback`,
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses to roll back with a read-only share token', async () => {
    const created = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/snapshots',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { label: 'Mine' },
    });

    const share = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/share',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { permission: 'ro' },
    });

    const response = await built.app.inject({
      method: 'POST',
      url: `/api/projects/prj_1/snapshots/${created.json().id}/rollback`,
      query: { token: share.json().token },
    });

    expect(response.statusCode).toBe(403);
  });
});
