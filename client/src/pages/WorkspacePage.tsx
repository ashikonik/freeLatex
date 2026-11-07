import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { Awareness } from 'y-protocols/awareness';

import { CodeMirrorEditor, encodeRoomName } from '../components/editor/CodeMirrorEditor.js';
import { FileTree } from '../components/layout/FileTree.js';
import { Header, type BuildMode } from '../components/layout/Header.js';
import { SplitPane } from '../components/layout/SplitPane.js';
import { PreviewPanel } from '../components/viewer/PreviewPanel.js';
import { listFiles, readFile, type Project } from '../lib/api.js';
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
  const [mode, setMode] = useState<BuildMode>('server');
  const [cursorLine, setCursorLine] = useState<number | undefined>(undefined);
  const [cursorTarget, setCursorTarget] = useState<{ line: number; token: number } | undefined>(
    undefined,
  );
  const [pendingJump, setPendingJump] = useState<number | undefined>(undefined);
  const jumpToken = useRef(0);
  const [source, setSource] = useState('');
  const [files, setFiles] = useState<{ path: string; content: string }[]>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

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

  // The source of the open file follows the document, so a preview is built
  // from what the reader sees rather than from what was loaded.
  useEffect(() => {
    if (!doc || !activePath) {
      return;
    }
    const text = doc.getText('content');
    const update = (): void => {
      setSource(text.toString());
    };
    update();
    text.observe(update);
    return () => {
      text.unobserve(update);
    };
  }, [doc, activePath]);

  // The other files of the project are needed by the WebAssembly engine,
  // which compiles the whole project rather than a single document.
  useEffect(() => {
    let cancelled = false;
    void listFiles(project.id)
      .then(async ({ tree }) => {
        const paths = collectFilePaths(tree).filter((path) => path !== activePath);
        const loaded = await Promise.all(
          paths.map(async (path) => {
            const { content } = await readFile(project.id, path);
            return { path, content };
          }),
        );
        if (!cancelled) {
          setFiles(loaded);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'The files could not be read.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, activePath]);

  // A jump into a file that was not open yet is applied once its editor
  // exists.
  useEffect(() => {
    if (pendingJump === undefined || !doc) {
      return;
    }
    setCursorTarget({ line: pendingJump, token: (jumpToken.current += 1) });
    setPendingJump(undefined);
  }, [pendingJump, doc]);

  const onSelect = useCallback((path: string): void => {
    setActivePath(path);
  }, []);

  const onJumpToSource = useCallback((file: string, line: number): void => {
    // A jump into another file opens that file first, and the cursor is
    // placed once the editor of that file exists.
    if (file !== activePathRef.current) {
      setActivePath(file);
      setPendingJump(line);
      return;
    }
    setCursorTarget({ line, token: (jumpToken.current += 1) });
  }, []);

  const viewer = useMemo(
    () =>
      activePath ? (
        <PreviewPanel
          projectId={project.id}
          source={source}
          mainPath={activePath}
          files={files}
          mode={mode}
          cursorLine={cursorLine}
          onJumpToSource={onJumpToSource}
        />
      ) : (
        <div className="flex h-full items-center justify-center bg-slate-100 text-sm text-slate-500">
          Open a file to see its preview.
        </div>
      ),
    [project.id, activePath, source, files, mode, cursorLine, onJumpToSource],
  );

  return (
    <div className="flex h-screen flex-col">
      <Header
        title={project.title}
        activePath={activePath}
        mode={mode}
        onModeChange={setMode}
        onShare={() => setShareOpen(true)}
        onHistory={() => setHistoryOpen(true)}
        status={status}
        onBack={onBack}
      />

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
              <CodeMirrorEditor
                doc={doc}
                awareness={awareness}
                onCursorLineChange={setCursorLine}
                cursorTarget={cursorTarget}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-slate-500">
                Connecting…
              </div>
            )
          }
          right={viewer}
        />
      </div>

      {shareOpen ? (
        <Modal title="Share" onClose={() => setShareOpen(false)}>
          <p className="text-sm text-slate-600">
            The share link for this project is created from the server. It arrives with the
            sharing routes.
          </p>
        </Modal>
      ) : null}

      {historyOpen ? (
        <Modal title="Document history" onClose={() => setHistoryOpen(false)}>
          <p className="text-sm text-slate-600">
            The list of snapshots for this project arrives with the history routes.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}

/** The properties of a modal. */
export interface ModalProps {
  /** The title of the modal. */
  title: string;
  /** Called when the modal is dismissed. */
  onClose: () => void;
  /** The modal's body. */
  children: React.ReactNode;
}

/**
 * A modal dialog.
 *
 * The dialog is a plain overlay: it closes on the button and on a click on
 * the backdrop, which is what a reader expects of a lightbox.
 */
export function Modal({ title, onClose, children }: ModalProps): React.ReactElement {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={title}
        className="w-full max-w-lg rounded-lg bg-white p-4 shadow-xl"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium text-slate-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded border border-slate-300 px-2 py-0.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * The paths of the files in a file tree.
 *
 * The tree nests directories, and the compiler wants a flat list of paths.
 */
function collectFilePaths(
  nodes: { type: string; path: string; children?: unknown }[],
): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.type === 'file') {
      paths.push(node.path);
      continue;
    }
    const children = node.children as
      | { type: string; path: string; children?: unknown }[]
      | undefined;
    if (Array.isArray(children)) {
      paths.push(...collectFilePaths(children));
    }
  }
  return paths;
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
