import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProjectsPage } from './ProjectsPage.js';
import { AuthProvider } from '../context/AuthContext.js';

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
 * Answer every request with the same payload.
 *
 * The dashboard's first request is the project listing, and the tests are
 * about what the page does with the answer, not about the request itself.
 */
function stubFetch(payload: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('the project dashboard', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('lists the projects the server reports', async () => {
    stubFetch({ projects: [PROJECT] });

    render(
      <AuthProvider>
        <ProjectsPage onOpen={() => undefined} />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('My thesis')).toBeInTheDocument());
  });

  it('says so when there are no projects', async () => {
    stubFetch({ projects: [] });

    render(
      <AuthProvider>
        <ProjectsPage onOpen={() => undefined} />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText(/No projects yet/)).toBeInTheDocument());
  });

  it('reports a failure to load', async () => {
    stubFetch({ error: 'Not authenticated.' }, 401);

    render(
      <AuthProvider>
        <ProjectsPage onOpen={() => undefined} />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Not authenticated.'));
  });

  it('opens a project when it is chosen', async () => {
    stubFetch({ projects: [PROJECT] });
    const onOpen = vi.fn();

    render(
      <AuthProvider>
        <ProjectsPage onOpen={onOpen} />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('My thesis')).toBeInTheDocument());

    await userEvent.click(screen.getByText('My thesis'));

    expect(onOpen).toHaveBeenCalledWith(PROJECT);
  });
});
