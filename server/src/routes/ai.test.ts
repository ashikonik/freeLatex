import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildApp, type BuiltApp } from '../app.js';
import { openDatabase, type DbHandle } from '../db/index.js';
import { users } from '../db/schema.js';
import { hashSecret } from '../utils/hash.js';
import { PROVIDER_KEY_HEADER } from './ai.js';
import type { Env } from '../config/env.js';

const ADMIN_KEY = 'admin-secret-key';
const OWNER_KEY = 'sk_user_owner_key_value';
const PROVIDER_KEY = 'sk_openai_provider_key';

let handle: DbHandle;
let built: BuiltApp;
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'freelatex-ai-'));
  handle = openDatabase(':memory:', ':memory:');
  handle.db
    .insert(users)
    .values({ id: 'owner', apiKeyHash: hashSecret(OWNER_KEY), name: 'Owner', role: 'user' })
    .run();
  built = await buildApp({ env: envFor(), db: handle });
  await built.app.ready();
});

afterEach(async () => {
  vi.unstubAllGlobals();
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

/** Stub the provider's answer. */
function stubProvider(body: unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok,
      status: ok ? 200 : 401,
      text: async () => JSON.stringify(body),
    })),
  );
}

/**
 * The headers of a request to the assistant.
 *
 * The workspace's own key keeps the `Authorization` header, which the
 * authentication reads, and the provider's key travels in the header of its
 * own.
 */
function headersOf(providerKey: string = PROVIDER_KEY): Record<string, string> {
  return {
    authorization: `Bearer ${OWNER_KEY}`,
    [PROVIDER_KEY_HEADER]: providerKey,
  };
}

/** The headers of the request the stubbed fetch received. */
function upstreamHeaders(fetchMock: { mock: { calls: unknown[][] } }): Record<string, string> {
  const call = fetchMock.mock.calls[0];
  const options = (call?.[1] ?? {}) as RequestInit;
  return (options.headers ?? {}) as Record<string, string>;
}

describe('POST /api/ai/complete', () => {
  it('rejects an unauthenticated request', async () => {
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/ai/complete',
      payload: { provider: 'openai', prompt: 'Hello' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects an unknown provider', async () => {
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/ai/complete',
      headers: headersOf(),
      payload: { provider: 'nonsense', prompt: 'Hello' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a request without a prompt', async () => {
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/ai/complete',
      headers: headersOf(),
      payload: { provider: 'openai' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a request without a key for the provider', async () => {
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/ai/complete',
      headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { provider: 'openai', prompt: 'Hello' },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toContain('openai');
  });

  it('sends the prompt to the provider and returns its answer', async () => {
    stubProvider({ choices: [{ message: { content: 'The answer.' } }] });

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/ai/complete',
      headers: headersOf(),
      payload: { provider: 'openai', prompt: 'Hello' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ text: 'The answer.' });
  });

  it('passes the key of the reader to the provider', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await built.app.inject({
      method: 'POST',
      url: '/api/ai/complete',
      headers: headersOf(),
      payload: { provider: 'openai', prompt: 'Hello' },
    });

    const headers = upstreamHeaders(fetchMock);
    expect(headers.authorization).toBe(`Bearer ${PROVIDER_KEY}`);
  });

  it('keeps the workspace key out of the request to the provider', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await built.app.inject({
      method: 'POST',
      url: '/api/ai/complete',
      headers: headersOf(),
      payload: { provider: 'openai', prompt: 'Hello' },
    });

    const headers = upstreamHeaders(fetchMock);
    expect(headers.authorization).not.toContain(OWNER_KEY);
  });

  it('reports the error of the provider', async () => {
    stubProvider({ error: { message: 'Bad key' } }, false);

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/ai/complete',
      headers: headersOf(),
      payload: { provider: 'openai', prompt: 'Hello' },
    });

    expect(response.statusCode).toBe(401);
    expect((response.json() as { error: string }).error).toContain('Bad key');
  });

  it('reports a provider that cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('the network is down');
      }),
    );

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/ai/complete',
      headers: headersOf(),
      payload: { provider: 'openai', prompt: 'Hello' },
    });

    expect(response.statusCode).toBe(502);
  });

  it('keeps the key out of the error it reports', async () => {
    // A provider that answers with the key in its body must not have that
    // body passed on to the reader.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => `the key ${PROVIDER_KEY} is wrong`,
      })),
    );

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/ai/complete',
      headers: headersOf(),
      payload: { provider: 'openai', prompt: 'Hello' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(PROVIDER_KEY);
  });

  it('keeps the key out of the error it reports when the body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => `the key ${PROVIDER_KEY} is wrong`,
      })),
    );

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/ai/complete',
      headers: headersOf(),
      payload: { provider: 'openai', prompt: 'Hello' },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(PROVIDER_KEY);
  });

  it('refuses a share token', async () => {
    const shareToken = await createShareToken();

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/ai/complete',
      headers: { [PROVIDER_KEY_HEADER]: PROVIDER_KEY },
      query: { token: shareToken },
      payload: { provider: 'openai', prompt: 'Hello' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('reads the answer of Anthropic', async () => {
    stubProvider({
      content: [
        { type: 'tool_use', id: 'x' },
        { type: 'text', text: 'The answer.' },
      ],
    });

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/ai/complete',
      headers: headersOf(),
      payload: { provider: 'anthropic', prompt: 'Hello' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ text: 'The answer.' });
  });

  it('reads the answer of Gemini', async () => {
    stubProvider({
      candidates: [{ content: { parts: [{ text: 'The ' }, { text: 'answer.' }] } }],
    });

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/ai/complete',
      headers: headersOf(),
      payload: { provider: 'gemini', prompt: 'Hello' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ text: 'The answer.' });
  });

  it('sends the key of the reader in the header Anthropic expects', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await built.app.inject({
      method: 'POST',
      url: '/api/ai/complete',
      headers: headersOf(),
      payload: { provider: 'anthropic', prompt: 'Hello' },
    });

    const headers = upstreamHeaders(fetchMock);
    expect(headers['x-api-key']).toBe(PROVIDER_KEY);
    expect(headers.authorization).toBeUndefined();
  });

  it('sends the key of the reader in the header Gemini expects', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await built.app.inject({
      method: 'POST',
      url: '/api/ai/complete',
      headers: headersOf(),
      payload: { provider: 'gemini', prompt: 'Hello' },
    });

    const headers = upstreamHeaders(fetchMock);
    expect(headers['x-goog-api-key']).toBe(PROVIDER_KEY);
    expect(headers.authorization).toBeUndefined();
  });

  it('reports an answer that is empty', async () => {
    stubProvider({ choices: [] });

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/ai/complete',
      headers: headersOf(),
      payload: { provider: 'openai', prompt: 'Hello' },
    });

    expect(response.statusCode).toBe(502);
  });
});

/**
 * A share token for a project of the owner.
 *
 * A share link opens a document to somebody with no account of their own, so
 * it must not be enough to spend the owner's key on a paid provider.
 */
async function createShareToken(): Promise<string> {
  const created = await built.app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { authorization: `Bearer ${OWNER_KEY}` },
    payload: { title: 'Shared' },
  });
  const projectId = (created.json() as { id: string }).id;

  const token = await built.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/share`,
    headers: { authorization: `Bearer ${OWNER_KEY}` },
    payload: { permission: 'ro' },
  });

  return (token.json() as { token: string }).token;
}
