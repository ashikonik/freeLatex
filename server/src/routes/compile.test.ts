import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildApp, type BuiltApp } from '../app.js';
import { openDatabase, type DbHandle } from '../db/index.js';
import { projects, users } from '../db/schema.js';
import { hashSecret } from '../utils/hash.js';
import { resolveTectonicBinary } from '../services/compiler.js';
import { clearBuilds } from './compile.js';
import type { Env } from '../config/env.js';

/**
 * The timeout for a test that runs the compiler.
 *
 * A first run of tectonic initialises its format bundle, which is far slower
 * than the runs that follow, so the compilation needs more than the default
 * five-second budget.
 */
const COMPILE_TEST_TIMEOUT = 60_000;

const ADMIN_KEY = 'admin-secret-key';
const OWNER_KEY = 'sk_user_owner_key_value';
const OTHER_KEY = 'sk_user_other_key_value';

let handle: DbHandle;
let built: BuiltApp;
let dataDir: string;

/**
 * True when tectonic is installed.
 *
 * The route tests exercise the real compiler, so they are skipped rather
 * than failed when it is absent.
 */
async function tectonicAvailable(): Promise<boolean> {
  return (await resolveTectonicBinary()) !== undefined;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'freelatex-compile-'));

  handle = openDatabase(':memory:', ':memory:');
  handle.db
    .insert(users)
    .values({ id: 'owner', apiKeyHash: hashSecret(OWNER_KEY), name: 'Owner', role: 'user' })
    .run();
  handle.db
    .insert(users)
    .values({ id: 'other', apiKeyHash: hashSecret(OTHER_KEY), name: 'Other', role: 'user' })
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
  clearBuilds();
});

afterEach(async () => {
  await built?.app.close();
  handle?.close();
  clearBuilds();
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

const VALID_DOCUMENT = `\\documentclass{article}
\\begin{document}
Hello, world.
\\end{document}
`;

const INVALID_DOCUMENT = `\\documentclass{article}
\\begin{document}
\\undefinedcommand
\\end{document}
`;

describe('POST /api/projects/:id/compile', () => {
  it('rejects an unauthenticated request', async () => {
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/compile',
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a caller who does not own the project', async () => {
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_other/compile',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(403);
  });

  it('compiles a valid project', async () => {
    if (!(await tectonicAvailable())) {
      return;
    }
    await writeFile('main.tex', VALID_DOCUMENT);

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/compile',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.pageCount).toBeGreaterThanOrEqual(1);
    expect(body.hasSyncTex).toBe(true);
    expect(body.errors).toEqual([]);
  }, COMPILE_TEST_TIMEOUT);

  it('reports a structured error for an invalid project', async () => {
    if (!(await tectonicAvailable())) {
      return;
    }
    await writeFile('main.tex', INVALID_DOCUMENT);

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/compile',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    // 422: the request was well-formed but the document did not compile.
    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(typeof body.log).toBe('string');
  }, COMPILE_TEST_TIMEOUT);

  it('serves the compiled PDF', async () => {
    if (!(await tectonicAvailable())) {
      return;
    }
    await writeFile('main.tex', VALID_DOCUMENT);
    await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/compile',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    const response = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/pdf',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    const body = response.rawPayload;
    expect(body.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  }, COMPILE_TEST_TIMEOUT);

  it('reports 404 when the project has never been compiled', async () => {
    const response = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/pdf',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it('does not serve a stale PDF after the sources change', async () => {
    if (!(await tectonicAvailable())) {
      return;
    }
    await writeFile('main.tex', VALID_DOCUMENT);
    await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/compile',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    // The PDF was cached, so it is served until the sources change.
    const before = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/pdf',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });
    expect(before.statusCode).toBe(200);

    await writeFile('main.tex', VALID_DOCUMENT.replace('Hello, world.', 'Changed.'));

    const after = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/pdf',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });
    // The stale PDF must not be served.
    expect(after.statusCode).toBe(404);
  }, COMPILE_TEST_TIMEOUT);

  it('does not let one user read another user\'s PDF', async () => {
    if (!(await tectonicAvailable())) {
      return;
    }
    await writeFile('main.tex', VALID_DOCUMENT);
    await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/compile',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    const response = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/pdf',
      headers: { authorization: `Bearer ${OTHER_KEY}` },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('SyncTeX endpoints', () => {
  it('reports the SyncTeX state after a build', async () => {
    if (!(await tectonicAvailable())) {
      return;
    }
    await writeFile('main.tex', VALID_DOCUMENT);
    await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/compile',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    const response = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/synctex',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pageCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.files)).toBe(true);
  }, COMPILE_TEST_TIMEOUT);

  it('performs a forward search from a source line', async () => {
    if (!(await tectonicAvailable())) {
      return;
    }
    await writeFile('main.tex', VALID_DOCUMENT);
    await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/compile',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    const listing = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/synctex',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });
    const file = listing.json().files.find((name: string) => name.endsWith('main.tex'));
    expect(file).toBeDefined();

    const response = await built.app.inject({
      method: 'GET',
      url: `/api/projects/prj_1/synctex/forward?file=${encodeURIComponent(file)}&line=3`,
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.source.line).toBe(3);
    expect(body.position.page).toBeGreaterThanOrEqual(1);
  }, COMPILE_TEST_TIMEOUT);

  it('rejects a forward search without a file and line', async () => {
    if (!(await tectonicAvailable())) {
      return;
    }
    await writeFile('main.tex', VALID_DOCUMENT);
    await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/compile',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    const response = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/synctex/forward',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(400);
  }, COMPILE_TEST_TIMEOUT);

  it('performs an inverse search from a point on the page', async () => {
    if (!(await tectonicAvailable())) {
      return;
    }
    await writeFile('main.tex', VALID_DOCUMENT);
    await built.app.inject({
      method: 'POST',
      url: '/api/projects/prj_1/compile',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    const listing = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/synctex',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });
    const file = listing.json().files.find((name: string) => name.endsWith('main.tex'));

    const forward = await built.app.inject({
      method: 'GET',
      url: `/api/projects/prj_1/synctex/forward?file=${encodeURIComponent(file)}&line=3`,
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });
    const position = forward.json().position;

    // The centre of the box is unambiguously inside it.
    const x = position.x + position.width / 2;
    const y = position.y + position.height / 2;

    const response = await built.app.inject({
      method: 'GET',
      url: `/api/projects/prj_1/synctex/inverse?x=${x}&y=${y}&page=${position.page}`,
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().source.line).toBe(3);
  }, COMPILE_TEST_TIMEOUT);

  it('reports 404 for a SyncTeX query before any build', async () => {
    const response = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/synctex',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it('does not let one user search another user\'s SyncTeX data', async () => {
    const response = await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_1/synctex',
      headers: { authorization: `Bearer ${OTHER_KEY}` },
    });

    expect(response.statusCode).toBe(403);
  });
});
