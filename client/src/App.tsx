import { useState } from 'react';

import { AuthProvider, useAuth } from './context/AuthContext.js';
import { LoginPage } from './pages/LoginPage.js';
import { ProjectsPage } from './pages/ProjectsPage.js';
import { WorkspacePage } from './pages/WorkspacePage.js';
import type { Project } from './lib/api.js';

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

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        Loading…
      </main>
    );
  }

  if (!identity) {
    return <LoginPage />;
  }

  if (project) {
    return <WorkspacePage project={project} onBack={() => setProject(undefined)} />;
  }

  return <ProjectsPage onOpen={setProject} />;
}
