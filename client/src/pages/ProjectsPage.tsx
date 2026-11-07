import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import {
  createProject,
  deleteProject,
  importProject,
  listProjects,
  type Project,
} from '../lib/api.js';
import { useAuth } from '../context/AuthContext.js';

/** The properties of the dashboard. */
export interface ProjectsPageProps {
  /** Called when a project is opened. */
  onOpen(project: Project): void;
}

/**
 * The project dashboard.
 *
 * It lists the projects the caller may see and offers the three ways a
 * project comes into existence: a new empty one, an import of a zip
 * archive, and the ones that already exist.
 */
export function ProjectsPage({ onOpen }: ProjectsPageProps): React.ReactElement {
  const { identity, logout } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await listProjects();
      setProjects(result.projects);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load the projects.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onCreate = useCallback(
    async (event: FormEvent): Promise<void> => {
      event.preventDefault();
      const name = title.trim();
      if (name.length === 0) {
        return;
      }
      setError(undefined);
      try {
        await createProject(name);
        setTitle('');
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not create the project.');
      }
    },
    [title, refresh],
  );

  const onImport = useCallback(
    async (file: File): Promise<void> => {
      setError(undefined);
      setNotice(undefined);
      try {
        const result = await importProject(file);
        setNotice(
          `Imported "${result.title}" with ${result.importedFiles} file(s).` +
            (result.skippedCount > 0 ? ` ${result.skippedCount} file(s) were skipped.` : ''),
        );
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not import the archive.');
      }
    },
    [refresh],
  );

  const onDelete = useCallback(
    async (project: Project): Promise<void> => {
      setError(undefined);
      try {
        await deleteProject(project.id);
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not delete the project.');
      }
    },
    [refresh],
  );

  return (
    <main className="mx-auto min-h-screen w-full max-w-4xl px-6 py-10">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Your projects</h1>
          <p className="mt-1 text-sm text-slate-500">
            Signed in as {identity?.name ?? 'a guest'}.
          </p>
        </div>
        <button
          type="button"
          onClick={logout}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
        >
          Sign out
        </button>
      </header>

      <section className="mt-8 flex flex-wrap items-end gap-3">
        <form
          onSubmit={(event) => {
            void onCreate(event).catch(() => {
              // The error is shown below.
            });
          }}
          className="flex flex-1 items-end gap-2"
        >
          <div className="flex-1">
            <label className="block text-sm font-medium text-slate-700" htmlFor="new-project">
              New project
            </label>
            <input
              id="new-project"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="My thesis"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
            />
          </div>
          <button
            type="submit"
            disabled={title.trim().length === 0}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Create
          </button>
        </form>

        <div>
          <span className="block text-sm font-medium text-slate-700">Import archive</span>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            aria-label="Import a zip archive"
            className="mt-1 block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void onImport(file).catch(() => {
                  // The error is shown below.
                });
              }
              // The input is cleared so the same file can be chosen again.
              event.target.value = '';
            }}
          />
        </div>
      </section>

      {error ? (
        <p role="alert" className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      ) : null}

      {loading ? (
        <p className="mt-8 text-sm text-slate-500">Loading…</p>
      ) : projects.length === 0 ? (
        <p className="mt-8 text-sm text-slate-500">
          No projects yet. Create one above to get started.
        </p>
      ) : (
        <ul className="mt-8 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {projects.map((project) => (
            <li key={project.id} className="flex items-center justify-between gap-4 p-4">
              <button
                type="button"
                onClick={() => onOpen(project)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="block truncate font-medium text-slate-900">
                  {project.title}
                </span>
                <span className="block text-xs text-slate-500">
                  Updated {new Date(project.updatedAt).toLocaleString()}
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  void onDelete(project).catch(() => {
                    // The error is shown above.
                  });
                }}
                className="rounded-md px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
