import { afterEach, describe, expect, it } from 'vitest';

import { buildApp, type BuiltApp } from '../app.js';
import { openDatabase, type DbHandle } from '../db/index.js';
import { hashSecret } from '../utils/hash.js';
import type { Env } from '../config/env.js';

const ADMIN_KEY = 'admin-secret-key';

let handle: DbHandle;
let built: BuiltApp;

function envFor(overrides: Partial<Env> = {}): Env {
  return {
    adminApiKey: ADMIN_KEY,
    authMode: 'multi',
    port: 3030,
    host: '0.0.0.0',
    dataDir: '/tmp/freelatex-test',
    compileTimeoutMs: 30_000,
    nodeEnv: 'test',
    staticDir: '',
    corsOrigin: '',
    ...overrides,
  };
}

async function makeApp(overrides: Partial<Env> = {}): Promise<BuiltApp> {
  handle = openDatabase(':memory:', ':memory:');
  built = await buildApp({ env: envFor(overrides), db: handle });
  await built.app.ready();
  return built;
}

afterEach(async () => {
  await built?.app.close();
  handle?.close();
});

describe('the logger keeps the credentials out of the log', () => {
  it('does not put the share token in the request line', async () => {
    // The logger writes to a stream, so the lines are captured where they
    // are produced rather than read back out of the application.
    const lines: string[] = [];
    const stream = {
      write(chunk: string): boolean {
        lines.push(chunk);
        return true;
      },
    };

    handle = openDatabase(':memory:', ':memory:');
    built = await buildApp({
      env: envFor(),
      db: handle,
      logger: true,
      logStream: stream,
    });
    await built.app.ready();

    // The browser's WebSocket API cannot set a header, so a share token
    // travels in the query string — and the query string is part of the
    // request line that every log line carries.
    await built.app.inject({
      method: 'GET',
      url: '/api/projects/prj_missing/files/main.tex?token=ro_super_secret_token',
    });

    const logged = lines.join('');
    expect(logged.length).toBeGreaterThan(0);
    expect(logged).not.toContain('ro_super_secret_token');
    // The path itself is still there, so the request remains traceable.
    expect(logged).toContain('/api/projects/prj_missing/files/main.tex');
  });
});

describe('cross-origin access', () => {
  it('is refused when no origin is configured', async () => {
    await makeApp();

    const response = await built.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://evil.example' },
    });

    expect(response.statusCode).toBe(200);
    // No origin is reflected, so a page on another site cannot read the
    // answer.
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('is allowed for the one origin that is configured', async () => {
    await makeApp({ corsOrigin: 'https://app.example' });

    const response = await built.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://app.example' },
    });

    expect(response.headers['access-control-allow-origin']).toBe('https://app.example');
  });

  it('is refused for any other origin', async () => {
    await makeApp({ corsOrigin: 'https://app.example' });

    const response = await built.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://evil.example' },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('the sign-in endpoint', () => {
  it('refuses an address that has failed too often', async () => {
    await makeApp();

    // Ten failures are allowed; the eleventh attempt is refused.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const failed = await built.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { apiKey: 'wrong' },
      });
      expect(failed.statusCode).toBe(401);
    }

    const refused = await built.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { apiKey: 'wrong' },
    });

    expect(refused.statusCode).toBe(429);
  });

  it('lets the right key through after a few failures', async () => {
    await makeApp();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await built.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { apiKey: 'wrong' },
      });
    }

    const accepted = await built.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { apiKey: ADMIN_KEY },
    });

    expect(accepted.statusCode).toBe(200);
  });
});

describe('the hash of a secret', () => {
  it('is the same for the same secret', () => {
    expect(hashSecret('abc')).toBe(hashSecret('abc'));
  });

  it('is different for a different secret', () => {
    expect(hashSecret('abc')).not.toBe(hashSecret('abd'));
  });
});
