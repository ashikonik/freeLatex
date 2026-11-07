import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { App } from './App.js';
import { clearActiveShareLink } from './lib/share-link.js';
import { setApiKeyProvider } from './lib/api.js';

/** A project as the API reports one. */
const PROJECT = {
  id: 'prj_1',
  title: 'My thesis',
  mainFile: 'main.tex',
  ownerId: 'admin',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

/**
 * Point the browser at a URL.
 *
 * The application reads the share link out of the URL when it starts, so the
 * URL has to be in place before the first render.
 */
function setLocation(href: string): void {
  window.history.replaceState({}, '', href);
}

describe('a reader who arrives through a share link', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearActiveShareLink();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearActiveShareLink();
    setApiKeyProvider(() => undefined);
  });

  it('is asked for nothing and the project is opened', async () => {
    setLocation('/p/prj_1?token=rw_secret');

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/projects/prj_1') {
        return new Response(JSON.stringify(PROJECT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === '/api/projects/prj_1/files') {
        return new Response(JSON.stringify({ tree: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    // The sign-in page must not stand between the reader and the document.
    await waitFor(() => expect(screen.queryByLabelText('API key')).not.toBeInTheDocument());

    // The project is read with the share token, not with an account key.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/prj_1',
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: 'Bearer rw_secret' }),
        }),
      ),
    );

    // The workspace is reached: the project's title is in the header.
    await waitFor(() => expect(screen.getByText('My thesis')).toBeInTheDocument());
  });

  it('is told plainly when the link no longer works', async () => {
    setLocation('/p/prj_1?token=ro_expired');

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/projects/prj_1') {
        return new Response(JSON.stringify({ error: 'Invalid share token.' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Invalid share token.'),
    );
  });
});

describe('a reader who arrives at the application itself', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearActiveShareLink();
    setLocation('/');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearActiveShareLink();
    setApiKeyProvider(() => undefined);
  });

  it('is asked to sign in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText('API key')).toBeInTheDocument());
  });
});
