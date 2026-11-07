import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { Awareness } from 'y-protocols/awareness';

import { CodeMirrorEditor, encodeRoomName } from '../components/editor/CodeMirrorEditor.js';
import { FileTree } from '../components/layout/FileTree.js';
import { SplitPane } from '../components/layout/SplitPane.js';
import { type Project } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.js';

/** The properties of the workspace. */
export interface WorkspacePageProps {
  /** The project that is open. */
  project: Project;
  /** Called when the user leaves the workspace. */
  onBack(): void;
}

/**
 * The editing workspace.
 *
 * The workspace owns the collaboration session: a Yjs document, a websocket
 * provider and an awareness instance. Every file the user opens gets its own
 * document and its own room, so two people editing different files do not
 * hold each other up.
 */
export function WorkspacePage({ project, onBack }: WorkspacePageProps): React.ReactElement {
  const { identity } = useAuth();
  const [activePath, setActivePath] = useState<string | undefined>(project.mainFile);
  const [doc, setDoc] = useState<Y.Doc | undefined>(undefined);
  const [awareness, setAwareness] = useState<Awareness | undefined>(undefined);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'offline'>('connecting');
  const [error, setError] = useState<string | undefined>(undefined);

  // The document and the provider are torn down when the file changes, so
  // the previous file's socket does not linger.
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;

  useEffect(() => {
    if (!activePath) {
      return;
    }

    let cancelled = false;
    setError(undefined);
    setStatus('connecting');

    const nextDoc = new Y.Doc();
    const nextAwareness = new Awareness(nextDoc);

    // The server seeds a new room with the file's content, so the local
    // document does not have to be seeded with it. Reading it here would
    // race the server's own copy.
    const room = encodeRoomName(project.id, activePath);
    const nextProvider = new WebsocketProvider(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
      room,
      nextDoc,
      { params: { token: apiKeyOf() }, connect: true },
    );

    nextProvider.on('status', ({ status: next }: { status: string }): void => {
      if (cancelled) {
        return;
      }
      setStatus(next === 'connected' ? 'connected' : 'connecting');
    });

    nextProvider.on('connection-error', (): void => {
      if (!cancelled) {
        setStatus('offline');
      }
    });

    setDoc(nextDoc);
    setAwareness(nextAwareness);

    return () => {
      cancelled = true;
      nextProvider.destroy();
      nextAwareness.destroy();
      nextDoc.destroy();
      setDoc(undefined);
      setAwareness(undefined);
    };
  }, [project.id, activePath]);

  // The presence of the local user is announced to the other clients.
  useEffect(() => {
    if (!awareness) {
      return;
    }
    awareness.setLocalStateField('user', {
      name: identity?.name ?? 'Anonymous',
      color: undefined,
    });
  }, [awareness, identity?.name]);

  const onSelect = useCallback((path: string): void => {
    setActivePath(path);
  }, []);

  const viewer = useMemo(
    () => (
      <div className="flex h-full items-center justify-center bg-slate-100 p-6 text-sm text-slate-500">
        The PDF viewer arrives with the next step.
      </div>
    ),
    [],
  );

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-4 border-b border-slate-200 bg-white px-4 py-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
        >
          ← Projects
        </button>
        <h1 className="font-medium text-slate-900">{project.title}</h1>
        <span className="text-sm text-slate-500">{activePath ?? 'No file open'}</span>
        <span
          className={`ml-auto rounded-full px-2 py-0.5 text-xs ${
            status === 'connected'
              ? 'bg-emerald-100 text-emerald-700'
              : status === 'offline'
                ? 'bg-red-100 text-red-700'
                : 'bg-amber-100 text-amber-700'
          }`}
        >
          {status === 'connected' ? 'Connected' : status === 'offline' ? 'Offline' : 'Connecting…'}
        </span>
      </header>

      {error ? (
        <p role="alert" className="bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1">
        <SplitPane
          left={
            <FileTree
              projectId={project.id}
              activePath={activePath}
              onSelect={onSelect}
            />
          }
          center={
            doc && awareness ? (
              <CodeMirrorEditor doc={doc} awareness={awareness} />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-slate-500">
                Connecting…
              </div>
            )
          }
          right={viewer}
        />
      </div>
    </div>
  );
}

/**
 * The API key the socket authenticates with.
 *
 * The socket needs the key before the auth context has verified it, so it is
 * read straight from the storage the context writes to.
 */
function apiKeyOf(): string {
  try {
    return window.localStorage.getItem('freelatex.apiKey') ?? '';
  } catch {
    return '';
  }
}
