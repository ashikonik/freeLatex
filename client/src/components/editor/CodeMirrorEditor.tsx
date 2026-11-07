import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import type { Awareness } from 'y-protocols/awareness';

import { latex } from './latex.js';

/**
 * The name of the text type inside a room's document.
 *
 * The server keeps the file's content in a `Y.Text` under this name, so the
 * client has to use the same name or the two would edit different texts.
 */
export const TEXT_KEY = 'content';

/**
 * A colour assigned to a collaborator.
 *
 * The colours are picked from a fixed palette so two browsers pick the same
 * colour for the same collaborator, which is what makes a remote cursor
 * recognisable.
 */
export const COLLABORATOR_COLORS: readonly string[] = [
  '#e11d48',
  '#db2777',
  '#7c3aed',
  '#2563eb',
  '#0891b2',
  '#059669',
  '#65a30d',
  '#ca8a04',
  '#ea580c',
];

/**
 * The colour for a client id.
 *
 * The id is a number that differs between sessions, so the colour is stable
 * for the length of a session but not across sessions — which is what a
 * cursor colour should be.
 */
export function colorForClientId(clientId: number): string {
  const index = Math.abs(clientId) % COLLABORATOR_COLORS.length;
  return COLLABORATOR_COLORS[index] as string;
}

/** The name of a collaborator. */
export interface Collaborator {
  clientId: number;
  name: string;
  color: string;
}

/** The properties of the editor. */
export interface CodeMirrorEditorProps {
  /** The document the editor edits. */
  doc: Y.Doc;
  /** The awareness instance that carries the presence. */
  awareness: Awareness;
  /** Whether the document may be edited. */
  readOnly?: boolean;
  /** Called when the cursor moves, so the PDF can follow it. */
  onCursorLineChange?: (line: number) => void;
  /**
   * The line the cursor should be moved to.
   *
   * The line is the one an inverse search found, so a reader who clicks a
   * spot on the page lands on the source that produced it. The line is
   * applied once, and the property is then left alone.
   */
  cursorTarget?: { line: number; token: number } | undefined;
}

/**
 * The CodeMirror editor, bound to a Yjs document.
 *
 * The binding is what makes the editor collaborative: the local document and
 * the remote ones are the same CRDT, so an edit made here arrives in every
 * other editor of the same room without any extra work.
 */
export function CodeMirrorEditor({
  doc,
  awareness,
  readOnly = false,
  onCursorLineChange,
  cursorTarget,
}: CodeMirrorEditorProps): React.ReactElement {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);

  // The callback is read through a ref, so a caller that passes a new
  // function on every render does not rebuild the editor.
  const onCursorLineChangeRef = useRef(onCursorLineChange);
  onCursorLineChangeRef.current = onCursorLineChange;

  const extensions = useMemo<Extension[]>(
    () => [
      lineNumbers(),
      history(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      latex(),
      keymap.of([...yUndoManagerKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      EditorView.lineWrapping,
      // The binding edits the shared text of the document, not the document
      // itself: `yCollab` works on the `Y.Text` that holds the content.
      yCollab(doc.getText(TEXT_KEY), awareness, {
        undoManager: new Y.UndoManager(doc.getText(TEXT_KEY)),
      }),
      EditorView.updateListener.of((update) => {
        if (!update.selectionSet && !update.docChanged) {
          return;
        }
        const line = update.state.doc.lineAt(update.state.selection.main.head).number;
        onCursorLineChangeRef.current?.(line);
      }),
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
    ],
    // The editor is rebuilt when the document changes, not on every render.
    [doc, awareness, readOnly],
  );

  useEffect(() => {
    const element = host.current;
    if (!element) {
      return;
    }

    const instance = new EditorView({
      state: EditorState.create({ doc: doc.getText('content').toString(), extensions }),
      parent: element,
    });
    view.current = instance;

    return () => {
      instance.destroy();
      view.current = null;
    };
  }, [doc, extensions]);

  // The cursor is moved to the line an inverse search found. The token makes
  // the move happen once per request, so a re-render does not pull the
  // reader's cursor away from where they put it.
  useEffect(() => {
    if (!cursorTarget) {
      return;
    }
    const instance = view.current;
    if (!instance) {
      return;
    }
    const total = instance.state.doc.lines;
    const line = Math.min(Math.max(cursorTarget.line, 1), total);
    const position = instance.state.doc.line(line).from;
    instance.dispatch({
      selection: { anchor: position },
      scrollIntoView: true,
    });
  }, [cursorTarget]);

  // The presence of the other clients is read from the awareness instance,
  // which changes whenever somebody moves their cursor or leaves.
  useEffect(() => {
    const read = (): void => {
      const states = awareness.getStates();
      const next: Collaborator[] = [];
      for (const [clientId, state] of states) {
        if (clientId === awareness.clientID) {
          // The local client is not a collaborator.
          continue;
        }
        const user = (state as { user?: { name?: string; color?: string } }).user;
        next.push({
          clientId,
          name: user?.name ?? 'Anonymous',
          color: user?.color ?? colorForClientId(clientId),
        });
      }
      setCollaborators(next);
    };

    read();
    awareness.on('change', read);
    return () => {
      awareness.off('change', read);
    };
  }, [awareness]);

  return (
    <div className="flex h-full flex-col">
      {collaborators.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-xs">
          <span className="text-slate-500">Editing now:</span>
          {collaborators.map((collaborator) => (
            <span
              key={collaborator.clientId}
              className="inline-flex items-center gap-1.5 rounded-full bg-white px-2 py-0.5 shadow-sm"
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: collaborator.color }}
              />
              {collaborator.name}
            </span>
          ))}
        </div>
      ) : null}
      <div ref={host} className="min-h-0 flex-1 overflow-auto" data-testid="cm-editor" />
    </div>
  );
}

/**
 * Build a provider that connects to the collaboration server.
 *
 * The room name is the project id and the file path, base64url-encoded, so
 * that it travels as a single URL path segment — the server decodes it back
 * with the same rule.
 */
export function connectToRoom(
  projectId: string,
  filePath: string,
  apiKey: string,
  doc: Y.Doc,
): { provider: WebsocketProvider; room: string } {
  const room = encodeRoomName(projectId, filePath);
  const provider = new WebsocketProvider(
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
    room,
    doc,
    {
      params: { token: apiKey },
      connect: true,
    },
  );
  return { provider, room };
}

/**
 * Encode a room name the way the server does.
 *
 * The server's rule is the project id, a dot, and the base64url-encoded path.
 * The client repeats it so that both sides name a room identically.
 */
export function encodeRoomName(projectId: string, filePath: string): string {
  const bytes = new TextEncoder().encode(filePath);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${projectId}.${encoded}`;
}
