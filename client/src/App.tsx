import { useEffect, useState } from 'react';

import { AuthProvider, useAuth } from './context/AuthContext.js';
import { LoginPage } from './pages/LoginPage.js';
import { ProjectsPage } from './pages/ProjectsPage.js';
import { WorkspacePage } from './pages/WorkspacePage.js';
import { apiRequest, type Project } from './lib/api.js';
import {
  clearActiveShareLink,
  parseShareLink,
  readActiveShareProjectId,
  setActiveShareLink,
  type ShareLink,
} from './lib/share-link.js';

/**
 * The application.
 *
 * The auth provider wraps the whole tree, because every page needs to know
 * whether the caller is signed in.
 */
export function App(): React.ReactElement {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}

/**
 * The part of the application that depends on the signed-in state.
 */
function Shell(): React.ReactElement {
  const { identity, loading } = useAuth();
  const [project, setProject] = useState<Project | undefined>(undefined);
  const share = useShareLink();

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        Loading…
      </main>
    );
  }

  if (project) {
    return <WorkspacePage project={project} onBack={() => setProject(undefined)} />;
  }

  // A reader who arrived through a share link is a guest of one project, and
  // the link itself is their credential. They never see the sign-in page,
  // because they have nothing to sign in with and nothing else to see.
  if (share) {
    return <SharePage projectId={share.projectId} onOpen={setProject} />;
  }

  if (!identity) {
    return <LoginPage />;
  }

  return <ProjectsPage onOpen={setProject} />;
}

/**
 * The properties of the shared page.
 */
export interface SharePageProps {
  /** The project the link names. */
  projectId: string;
  /** Called when the project has been opened. */
  onOpen(project: Project): void;
}

/**
 * The page a share link leads to.
 *
 * It reads the project the link names and hands it to the workspace. A link
 * that has been revoked, that has expired, or that names a project the server
 * will not show is reported plainly, because the reader has no other way to
 * find out what went wrong.
 */
function SharePage({ projectId, onOpen }: SharePageProps): React.ReactElement {
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setError(undefined);

    void apiRequest<Project>(`/projects/${projectId}`)
      .then((found) => {
        if (!cancelled) {
          onOpen(found);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'This share link could not be opened.',
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, onOpen]);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
        <div
          role="alert"
          className="w-full max-w-md rounded-xl border border-red-200 bg-white p-8 text-center shadow-sm"
        >
          <h1 className="text-lg font-medium text-slate-900">This link cannot be opened</h1>
          <p className="mt-2 text-sm text-slate-600">{error}</p>
          <a
            href="/"
            className="mt-6 inline-block rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
          >
            Go to the sign-in page
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center text-sm text-slate-500">
      Opening the project…
    </main>
  );
}

/**
 * The share link the reader arrived with.
 *
 * The URL is the only place a share link can come from, so it is read once,
 * when the application starts, and kept for as long as the visit lasts. A
 * link that names no project, or that carries no token, is not a share link
 * and is ignored.
 */
function useShareLink(): ShareLink | undefined {
  const [link] = useState<ShareLink | undefined>(() => {
    // The link is put in place as the state is read, not in an effect
    // afterwards: a child's effect runs before the parent's, so a page that
    // reads the credential on mount would otherwise find none.
    const found = parseShareLink(location.href);
    setActiveShareLink(found);
    return found;
  });

  useEffect(() => {
    return () => {
      clearActiveShareLink();
    };
  }, []);

  return link;
}

/**
 * The project the current visit's share link names.
 *
 * It is read rather than taken as an argument, because the share page needs
 * it before the project itself has been read from the server.
 */
export function useActiveShareProjectId(): string | undefined {
  return readActiveShareProjectId();
}
