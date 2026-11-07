/**
 * Head 3 runtime functional probe.
 *
 * Boots the real modules against a throwaway data directory and asserts the
 * environment layer resolves and the data directory is writable. Exits non-zero
 * on the first failure so `scripts/verify-step.sh` catches it.
 */
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEnv } from './config/env.js';
import { openDatabase } from './db/index.js';
import { users } from './db/schema.js';
import { hashSecret } from './utils/hash.js';

async function main(): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'freelatex-probe-'));

  try {
    const env = loadEnv({
      ...process.env,
      ADMIN_API_KEY: process.env.ADMIN_API_KEY ?? 'probe-admin-key',
      DATA_DIR: dataDir,
    });

    // The env layer must resolve a usable configuration.
    if (!env.adminApiKey) {
      throw new Error('probe: adminApiKey resolved empty');
    }
    if (env.authMode !== 'single' && env.authMode !== 'multi') {
      throw new Error(`probe: unexpected authMode "${env.authMode}"`);
    }

    // The data directory must be usable for the SQLite file and project tree.
    await writeFile(join(dataDir, '.probe'), 'ok', 'utf8');
    const content = await readFile(join(dataDir, '.probe'), 'utf8');
    if (content !== 'ok') {
      throw new Error('probe: data directory is not writable');
    }

    // The database must open, create its schema, and accept a write.
    const handle = openDatabase(dataDir);
    try {
      handle.db
        .insert(users)
        .values({ id: 'probe_user', apiKeyHash: hashSecret('probe'), name: 'Probe' })
        .run();

      const rows = handle.db.select().from(users).all();
      if (rows.length !== 1) {
        throw new Error('probe: user insert did not persist');
      }

      // The HTTP server must boot and answer real requests.
      const { buildApp } = await import('./app.js');
      const { app } = await buildApp({ env, db: handle });
      await app.ready();
      try {
        const health = await app.inject({ method: 'GET', url: '/api/health' });
        if (health.statusCode !== 200) {
          throw new Error(`probe: health check returned ${health.statusCode}`);
        }

        const unauthorized = await app.inject({ method: 'GET', url: '/api/auth/me' });
        if (unauthorized.statusCode !== 401) {
          throw new Error(
            `probe: unauthenticated request returned ${unauthorized.statusCode}, expected 401`,
          );
        }

        const login = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { apiKey: env.adminApiKey },
        });
        if (login.statusCode !== 200) {
          throw new Error(`probe: admin login returned ${login.statusCode}`);
        }

        // Step 4: create a project, upload a .tex file, and download the
        // exported zip. This exercises the storage service end to end.
        const auth = { authorization: `Bearer ${env.adminApiKey}` };

        const created = await app.inject({
          method: 'POST',
          url: '/api/projects',
          headers: auth,
          payload: { title: 'Probe Project' },
        });
        if (created.statusCode !== 201) {
          throw new Error(`probe: project creation returned ${created.statusCode}`);
        }
        const projectId = created.json().id as string;

        const uploaded = await app.inject({
          method: 'PUT',
          url: `/api/projects/${projectId}/files/main.tex`,
          headers: auth,
          payload: { content: '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n' },
        });
        if (uploaded.statusCode !== 200) {
          throw new Error(`probe: file upload returned ${uploaded.statusCode}`);
        }

        const exported = await app.inject({
          method: 'GET',
          url: `/api/projects/${projectId}/export`,
          headers: auth,
        });
        if (exported.statusCode !== 200) {
          throw new Error(`probe: zip export returned ${exported.statusCode}`);
        }
        if (exported.rawPayload.subarray(0, 4).toString('hex') !== '504b0304') {
          throw new Error('probe: exported archive is not a zip file');
        }

        // The exported archive must import back as a project.
        const imported = await app.inject({
          method: 'POST',
          url: '/api/projects/import',
          headers: auth,
          payload: { buffer: exported.rawPayload, title: 'Probe Import' },
        });
        if (imported.statusCode !== 201) {
          throw new Error(`probe: zip import returned ${imported.statusCode}`);
        }
        if ((imported.json().importedFiles as number) < 1) {
          throw new Error('probe: zip import extracted no files');
        }

        // Step 5: capture a snapshot, change a file, and diff the two
        // revisions. This checks the diff engine's runtime output format.
        const snapshotted = await app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/snapshots`,
          headers: auth,
          payload: { label: 'Probe Snapshot' },
        });
        if (snapshotted.statusCode !== 201) {
          throw new Error(`probe: snapshot creation returned ${snapshotted.statusCode}`);
        }
        const snapshotId = snapshotted.json().id as string;

        await app.inject({
          method: 'PUT',
          url: `/api/projects/${projectId}/files/main.tex`,
          headers: auth,
          payload: { content: '\\documentclass{article}\n\\begin{document}\nHi\nAgain\n\\end{document}\n' },
        });

        const second = await app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/snapshots`,
          headers: auth,
          payload: { label: 'Probe Snapshot 2' },
        });
        if (second.statusCode !== 201) {
          throw new Error(`probe: second snapshot returned ${second.statusCode}`);
        }

        const diffed = await app.inject({
          method: 'GET',
          url: `/api/projects/${projectId}/snapshots/${snapshotId}/diff`,
          headers: auth,
          query: { against: second.json().id },
        });
        if (diffed.statusCode !== 200) {
          throw new Error(`probe: snapshot diff returned ${diffed.statusCode}`);
        }
        const diffs = diffed.json().diffs as { path: string; changeType: string; patch: string }[];
        if (diffs.length !== 1) {
          throw new Error(`probe: expected 1 diff, got ${diffs.length}`);
        }
        if (diffs[0]?.path !== 'main.tex' || diffs[0]?.changeType !== 'modified') {
          throw new Error('probe: diff did not report main.tex as modified');
        }
        if (!diffs[0]?.patch.includes('+Again')) {
          throw new Error('probe: diff patch is missing the added line');
        }

        // Step 6: compile the project for real and check that the result is
        // a valid PDF with usable SyncTeX data.
        await app.inject({
          method: 'PUT',
          url: `/api/projects/${projectId}/files/main.tex`,
          headers: auth,
          payload: {
            content:
              '\\documentclass{article}\n\\begin{document}\nHi\n\\section{Probe}\nProbe body\n\\end{document}\n',
          },
        });

        const compiled = await app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/compile`,
          headers: auth,
        });
        if (compiled.statusCode !== 200) {
          throw new Error(`probe: compilation returned ${compiled.statusCode}`);
        }
        const compileBody = compiled.json();
        if (compileBody.success !== true) {
          throw new Error('probe: compilation reported a failure');
        }
        if (compileBody.pageCount < 1) {
          throw new Error('probe: compilation reported no pages');
        }

        const pdf = await app.inject({
          method: 'GET',
          url: `/api/projects/${projectId}/pdf`,
          headers: auth,
        });
        if (pdf.statusCode !== 200) {
          throw new Error(`probe: pdf download returned ${pdf.statusCode}`);
        }
        // The PDF must be a real PDF: every document starts with this header.
        if (pdf.rawPayload.subarray(0, 8).toString('ascii') !== '%PDF-1.5') {
          throw new Error(
            `probe: compiled output is not a %PDF-1.5 document (got "${pdf.rawPayload
              .subarray(0, 8)
              .toString('ascii')}")`,
          );
        }

        // The SyncTeX data must support both directions of the jump.
        const syncTex = await app.inject({
          method: 'GET',
          url: `/api/projects/${projectId}/synctex`,
          headers: auth,
        });
        if (syncTex.statusCode !== 200) {
          throw new Error(`probe: synctex query returned ${syncTex.statusCode}`);
        }
        const mainFile = (syncTex.json().files as string[]).find((name) =>
          name.endsWith('main.tex'),
        );
        if (!mainFile) {
          throw new Error('probe: synctex data does not mention main.tex');
        }

        const forward = await app.inject({
          method: 'GET',
          url: `/api/projects/${projectId}/synctex/forward?file=${encodeURIComponent(mainFile)}&line=5`,
          headers: auth,
        });
        if (forward.statusCode !== 200) {
          throw new Error(`probe: forward search returned ${forward.statusCode}`);
        }
        const position = forward.json().position as {
          x: number;
          y: number;
          width: number;
          height: number;
          page: number;
        };
        if (position.width <= 0 || position.height <= 0) {
          throw new Error('probe: forward search returned a degenerate box');
        }

        const inverse = await app.inject({
          method: 'GET',
          url: `/api/projects/${projectId}/synctex/inverse?x=${position.x + position.width / 2}&y=${position.y + position.height / 2}&page=${position.page}`,
          headers: auth,
        });
        if (inverse.statusCode !== 200) {
          throw new Error(`probe: inverse search returned ${inverse.statusCode}`);
        }
        if ((inverse.json().source as { line: number }).line !== 5) {
          throw new Error('probe: inverse search did not return the same line');
        }
      } finally {
        await app.close();
      }
    } finally {
      handle.close();
    }

    console.log(`probe OK — authMode=${env.authMode} port=${env.port} dataDir=${env.dataDir}`);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error('probe FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
