import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildApp, type BuiltApp } from '../app.js';
import { eq } from 'drizzle-orm';
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
  // Each test gets its own data directory so project files cannot leak
  // between tests through the shared storage root.
  dataDir = await mkdtemp(join(tmpdir(), 'freelatex-projects-'));

  handle = openDatabase(':memory:', ':memory:');
  handle.db
    .insert(users)
    .values({ id: 'owner', apiKeyHash: hashSecret(OWNER_KEY), name: 'Owner', role: 'user' })
    .run();
  handle.db
    .insert(users)
    .values({ id: 'someone_else', apiKeyHash: hashSecret('other-key'), name: 'Other', role: 'user' })
    .run();
  handle.db
    .insert(projects)
    .values({ id: 'prj_1', ownerId: 'owner', title: 'Thesis' })
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
    corsOrigin: '',
    staticDir: '',
  };
}

describe('GET /api/projects', () => {
  it('lists only the caller’s own projects', async () => {
    handle.db
      .insert(projects)
      .values({ id: 'prj_other', ownerId: 'someone_else', title: 'Not Mine' })
      .run();

    const response = await built.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(200);
    const ids = response.json().projects.map((p: { id: string }) => p.id);
    expect(ids).toEqual(['prj_1']);
  });

  it('lets the admin list every project', async () => {
    handle.db
      .insert(projects)
      .values({ id: 'prj_other', ownerId: 'someone_else', title: 'Not Mine' })
      .run();

    const response = await built.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().projects).toHaveLength(2);
  });

  it('refuses to list projects with a share token', async () => {
    const created = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/share',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { permission: 'rw' },
    });
    const token = created.json().token;

    const response = await built.app.inject({
      method: 'GET',
      url: '/api/projects',
      query: { token },
    });

    expect(response.statusCode).toBe(403);
  });

  it('requires authentication', async () => {
    const response = await built.app.inject({ method: 'GET', url: '/api/projects' });

    expect(response.statusCode).toBe(401);
  });
});

describe('POST /api/projects', () => {
  it('creates a project owned by the caller', async () => {
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { title: 'New Paper' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.title).toBe('New Paper');
    expect(body.ownerId).toBe('owner');
    expect(body.id).toMatch(/^prj_/);
  });

  it('falls back to a default title', async () => {
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: {},
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().title).toBe('Untitled project');
  });

  it('refuses creation with a share token', async () => {
    const created = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/share',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { permission: 'rw' },
    });
    const token = created.json().token;

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects',
      query: { token },
      payload: { title: 'Sneaky' },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('PATCH /api/projects/:id', () => {
  it('renames a project', async () => {
    const response = await built.app.inject({
      method: 'PATCH',
      url: '/api/projects/prj_1',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { title: 'Renamed' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().title).toBe('Renamed');
  });

  it('rejects an empty title', async () => {
    const response = await built.app.inject({
      method: 'PATCH',
      url: '/api/projects/prj_1',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { title: '   ' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses to rename another user’s project', async () => {
    handle.db
      .insert(projects)
      .values({ id: 'prj_other', ownerId: 'someone_else', title: 'Not Mine' })
      .run();

    const response = await built.app.inject({
      method: 'PATCH',
      url: '/api/projects/prj_other',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { title: 'Hijacked' },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('DELETE /api/projects/:id', () => {
  it('deletes a project and its files', async () => {
    await built.app.inject({
      method: 'PUT',
      url: '/api/projects/prj_1/files/main.tex',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { content: 'hello' },
    });

    const response = await built.app.inject({
      method: 'DELETE',
      url: '/api/projects/prj_1',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(204);
    expect(
      handle.db.select().from(projects).where(eq(projects.id, 'prj_1')).all(),
    ).toHaveLength(0);
  });

  it('refuses to delete another user’s project', async () => {
    handle.db
      .insert(projects)
      .values({ id: 'prj_other', ownerId: 'someone_else', title: 'Not Mine' })
      .run();

    const response = await built.app.inject({
      method: 'DELETE',
      url: '/api/projects/prj_other',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('project file routes', () => {
  it('writes and reads back a file', async () => {
    const write = await built.app.inject({
      method: 'PUT',
      url: '/api/projects/prj_1/files/chapters/intro.tex',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { content: '\\section{Introduction}' },
    });

    expect(write.statusCode).toBe(200);
    expect(write.json()).toMatchObject({ path: 'chapters/intro.tex' });

    const read = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/files/chapters/intro.tex',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(read.statusCode).toBe(200);
    expect(read.json().content).toBe('\\section{Introduction}');
  });

  it('rejects a write with a non-string body', async () => {
    const response = await built.app.inject({
      method: 'PUT',
      url: '/api/projects/prj_1/files/main.tex',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { content: 42 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 for a path that escapes the project directory', async () => {
    const response = await built.app.inject({
      method: 'PUT',
      url: '/api/projects/prj_1/files/..%2F..%2Fetc%2Fpasswd',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { content: 'pwned' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 404 for a file that does not exist', async () => {
    const response = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/files/missing.tex',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it('lists the project file tree', async () => {
    await built.app.inject({
      method: 'PUT',
      url: '/api/projects/prj_1/files/notes.md',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { content: '# Notes' },
    });

    const response = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/files',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(200);
    const names = response.json().tree.map((node: { name: string }) => node.name);
    expect(names).toContain('notes.md');
  });

  it('deletes a file', async () => {
    await built.app.inject({
      method: 'PUT',
      url: '/api/projects/prj_1/files/temp.tex',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { content: 'x' },
    });

    const response = await built.app.inject({
      method: 'DELETE',
      url: '/api/projects/prj_1/files/temp.tex',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(204);
  });

  it('refuses file access to another user’s project', async () => {
    handle.db
      .insert(projects)
      .values({ id: 'prj_other', ownerId: 'someone_else', title: 'Not Mine' })
      .run();

    const response = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_other/files/main.tex',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(403);
  });

  it('lets a read-only share token read but not write', async () => {
    await built.app.inject({
      method: 'PUT',
      url: '/api/projects/prj_1/files/main.tex',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { content: '\\documentclass{article}' },
    });

    const created = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/share',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { permission: 'ro' },
    });
    const token = created.json().token;

    const read = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/files/main.tex',
      query: { token },
    });
    expect(read.statusCode).toBe(200);

    const write = await built.app.inject({
      method: 'PUT',
      url: '/api/projects/prj_1/files/main.tex',
      query: { token },
      payload: { content: 'nope' },
    });
    expect(write.statusCode).toBe(403);
  });
});

describe('zip export and import over HTTP', () => {
  /** Write a couple of files so the archive is not empty. */
  async function seedFiles(): Promise<void> {
    await built.app.inject({
      method: 'PUT',
      url: '/api/projects/prj_1/files/main.tex',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { content: '\\documentclass{article}' },
    });
    await built.app.inject({
      method: 'PUT',
      url: '/api/projects/prj_1/files/chapters/one.tex',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { content: '\\section{One}' },
    });
  }

  it('exports a project as a zip attachment', async () => {
    await seedFiles();

    const response = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/export',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/zip');
    expect(response.headers['content-disposition']).toContain('Thesis.zip');
    // Local file header signature "PK\x03\x04".
    expect(response.rawPayload.subarray(0, 4).toString('hex')).toBe('504b0304');
  });

  it('imports a zip archive as a new project', async () => {
    await seedFiles();

    const exported = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/export',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects/import',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { buffer: exported.rawPayload, title: 'Imported' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.title).toBe('Imported');
    expect(body.importedFiles).toBe(2);
    expect(body.skippedFiles).toEqual([]);
  });

  it('refuses an import with a share token', async () => {
    const created = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/share',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { permission: 'rw' },
    });
    const token = created.json().token;

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects/import',
      query: { token },
      payload: { buffer: Buffer.from('PK'), title: 'Sneaky' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects an import without a buffer', async () => {
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects/import',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { title: 'Empty' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('imports a multipart file upload', async () => {
    await seedFiles();

    const exported = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/export',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    const boundary = '----freelatexTestBoundary';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="title"\r\n\r\n' +
          'Uploaded\r\n' +
          `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="file"; filename="project.zip"\r\n' +
          'Content-Type: application/zip\r\n\r\n',
        'utf8',
      ),
      exported.rawPayload,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects/import',
      headers: {
        authorization: `Bearer ${OWNER_KEY}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().title).toBe('Uploaded');
    expect(response.json().importedFiles).toBe(2);
  });
});
