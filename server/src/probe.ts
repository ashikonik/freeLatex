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
