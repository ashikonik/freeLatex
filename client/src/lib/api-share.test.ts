import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiRequest, setApiKeyProvider } from './api.js';
import { clearActiveShareLink, setActiveShareLink } from './share-link.js';

describe('the credential of a request', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearActiveShareLink();
    setApiKeyProvider(() => undefined);
  });

  it('uses the stored account key when there is no share link', async () => {
    setApiKeyProvider(() => 'sk_user_account');
    const fetchMock = vi.fn(async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/projects');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer sk_user_account' }),
      }),
    );
  });

  it('uses the share token when the reader arrived through a link', async () => {
    // The reader has an account of their own, but the link names a project
    // of somebody else's, so the link is the credential that counts.
    setApiKeyProvider(() => 'sk_user_account');
    setActiveShareLink({ projectId: 'prj_1', token: 'rw_secret' });
    const fetchMock = vi.fn(async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/projects/prj_1');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/prj_1',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer rw_secret' }),
      }),
    );
  });

  it('sends no credential when there is none', async () => {
    setApiKeyProvider(() => undefined);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/projects');

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });
});
