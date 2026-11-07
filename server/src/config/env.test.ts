import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv } from './env.js';

const BASE = { ADMIN_API_KEY: 'secret-admin-key' } satisfies NodeJS.ProcessEnv;

describe('loadEnv', () => {
  it('requires ADMIN_API_KEY', () => {
    expect(() => loadEnv({})).toThrow(EnvError);
    expect(() => loadEnv({})).toThrow(/ADMIN_API_KEY is required/);
  });

  it('rejects a blank ADMIN_API_KEY', () => {
    expect(() => loadEnv({ ADMIN_API_KEY: '   ' })).toThrow(EnvError);
  });

  it('applies documented defaults', () => {
    const env = loadEnv(BASE);

    expect(env.adminApiKey).toBe('secret-admin-key');
    expect(env.authMode).toBe('single');
    expect(env.port).toBe(3030);
    expect(env.host).toBe('0.0.0.0');
    expect(env.compileTimeoutMs).toBe(30_000);
    expect(env.nodeEnv).toBe('development');
  });

  it('reads AUTH_MODE=multi', () => {
    expect(loadEnv({ ...BASE, AUTH_MODE: 'multi' }).authMode).toBe('multi');
  });

  it('rejects an unknown AUTH_MODE', () => {
    expect(() => loadEnv({ ...BASE, AUTH_MODE: 'shared' })).toThrow(/AUTH_MODE must be/);
  });

  it('overrides PORT and HOST from the environment', () => {
    const env = loadEnv({ ...BASE, PORT: '8080', HOST: '127.0.0.1' });

    expect(env.port).toBe(8080);
    expect(env.host).toBe('127.0.0.1');
  });

  it('rejects a non-numeric or non-positive PORT', () => {
    expect(() => loadEnv({ ...BASE, PORT: 'abc' })).toThrow(/PORT must be a positive integer/);
    expect(() => loadEnv({ ...BASE, PORT: '0' })).toThrow(/PORT must be a positive integer/);
    expect(() => loadEnv({ ...BASE, PORT: '-1' })).toThrow(/PORT must be a positive integer/);
    expect(() => loadEnv({ ...BASE, PORT: '80.5' })).toThrow(/PORT must be a positive integer/);
  });

  it('falls back to the default PORT when it is empty', () => {
    expect(loadEnv({ ...BASE, PORT: '' }).port).toBe(3030);
  });

  it('reads COMPILE_TIMEOUT_MS and rejects invalid values', () => {
    expect(loadEnv({ ...BASE, COMPILE_TIMEOUT_MS: '5000' }).compileTimeoutMs).toBe(5000);
    expect(() => loadEnv({ ...BASE, COMPILE_TIMEOUT_MS: 'soon' })).toThrow(
      /COMPILE_TIMEOUT_MS must be a positive integer/,
    );
  });

  it('resolves DATA_DIR to an absolute path', () => {
    const env = loadEnv({ ...BASE, DATA_DIR: 'tmp/data' });

    expect(env.dataDir.startsWith('/')).toBe(true);
    expect(env.dataDir.endsWith('/tmp/data')).toBe(true);
  });

  it('trims surrounding whitespace from ADMIN_API_KEY', () => {
    expect(loadEnv({ ...BASE, ADMIN_API_KEY: '  padded-key  ' }).adminApiKey).toBe('padded-key');
  });

  it('serves no static files when STATIC_DIR is not set', () => {
    expect(loadEnv(BASE).staticDir).toBe('');
  });

  it('resolves STATIC_DIR to an absolute path', () => {
    const env = loadEnv({ ...BASE, STATIC_DIR: 'client/dist' });

    expect(env.staticDir.startsWith('/')).toBe(true);
    expect(env.staticDir.endsWith('/client/dist')).toBe(true);
  });
});
