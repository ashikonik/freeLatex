import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildApp, type BuiltApp } from '../app.js';
import { openDatabase, type DbHandle } from '../db/index.js';
import type { Env } from '../config/env.js';

const ADMIN_KEY = 'admin-secret-key';

let handle: DbHandle;
let built: BuiltApp;
let dataDir: string;
let staticDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'freelatex-static-'));
  staticDir = await mkdtemp(join(tmpdir(), 'freelatex-static-build-'));
  await mkdir(join(staticDir, 'assets'), { recursive: true });
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>freeLatex</title>');
  await writeFile(join(staticDir, 'assets', 'app.js'), 'console.log("app");');

  handle = openDatabase(':memory:', ':memory:');
  built = await buildApp({ env: envFor(), db: handle });
  await built.app.ready();
});

afterEach(async () => {
  await built?.app.close();
  handle?.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(staticDir, { recursive: true, force: true });
});

function envFor(): Env {
  return {
    adminApiKey: ADMIN_KEY,
    authMode: 'single',
    port: 3030,
    host: '0.0.0.0',
    dataDir,
    compileTimeoutMs: 30_000,
    nodeEnv: 'test',
    staticDir,
  };
}

describe('the client served by the server', () => {
  it('serves the page of the application', async () => {
    const response = await built.app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('freeLatex');
  });

  it('serves a file of the build', async () => {
    const response = await built.app.inject({ method: 'GET', url: '/assets/app.js' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('app');
  });

  it('answers a path of the application with the page', async () => {
    const response = await built.app.inject({ method: 'GET', url: '/projects/prj_1' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('freeLatex');
  });

  it('answers an unknown API path with a not found', async () => {
    const response = await built.app.inject({ method: 'GET', url: '/api/nothing-here' });

    expect(response.statusCode).toBe(404);
  });

  it('does not let the page stand in for the API', async () => {
    const response = await built.app.inject({ method: 'GET', url: '/api' });

    expect(response.statusCode).toBe(404);
  });

  it('does not let the page stand in for the WebSocket', async () => {
    const response = await built.app.inject({ method: 'GET', url: '/ws' });

    expect(response.statusCode).toBe(404);
  });

  it('does not let the page stand in for the API when a query is asked for', async () => {
    // The URL of the request carries the query as well as the path, so the
    // path has to be looked at on its own.
    const response = await built.app.inject({ method: 'GET', url: '/api?health=1' });

    expect(response.statusCode).toBe(404);
  });

  it('does not let the page stand in for the WebSocket when a query is asked for', async () => {
    const response = await built.app.inject({ method: 'GET', url: '/ws?room=prj_1' });

    expect(response.statusCode).toBe(404);
  });

  it('does not let the browser cache the page', async () => {
    const response = await built.app.inject({ method: 'GET', url: '/' });

    expect(response.headers['cache-control']).toBe('no-cache');
  });

  it('still answers the health check', async () => {
    const response = await built.app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { status: string }).status).toBe('ok');
  });
});

describe('a server without a build of the client', () => {
  it('answers nothing but the API', async () => {
    const bare = await buildApp({
      env: { ...envFor(), staticDir: '' },
      db: handle,
    });
    await bare.app.ready();

    const response = await bare.app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(404);
    await bare.app.close();
  });
});
