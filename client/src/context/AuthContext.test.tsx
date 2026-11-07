import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import {
  AuthProvider,
  clearStoredApiKey,
  readStoredApiKey,
  storeApiKey,
  useAuth,
} from './AuthContext.js';
import { setApiKeyProvider } from '../lib/api.js';

describe('the stored key', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('reads back what it stored', () => {
    storeApiKey('sk_user_example');
    expect(readStoredApiKey()).toBe('sk_user_example');
  });

  it('forgets the key when it is cleared', () => {
    storeApiKey('sk_user_example');
    clearStoredApiKey();
    expect(readStoredApiKey()).toBeUndefined();
  });

  it('reports no key when none was stored', () => {
    expect(readStoredApiKey()).toBeUndefined();
  });
});

/** A component that shows the authentication state. */
function Probe(): React.ReactElement {
  const { identity, loading } = useAuth();
  if (loading) {
    return <span>loading</span>;
  }
  return <span>{identity ? identity.name : 'signed out'}</span>;
}

describe('the auth context', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // The provider is left installed by the last test, so it is cleared.
    setApiKeyProvider(() => undefined);
  });

  it('starts signed out when no key is stored', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('signed out')).toBeInTheDocument());
  });

  it('verifies a stored key against the server on mount', async () => {
    storeApiKey('sk_user_stored');

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ kind: 'user', role: 'user', name: 'Ada' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument());
    // The stored key is sent to the server to prove it is still valid.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/me',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer sk_user_stored' }),
      }),
    );
  });

  it('discards a stored key the server refuses', async () => {
    storeApiKey('sk_user_stale');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Invalid API key.' }), { status: 401 })),
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('signed out')).toBeInTheDocument());
    // A key that no longer works must not be kept.
    expect(readStoredApiKey()).toBeUndefined();
  });
});
