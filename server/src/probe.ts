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
