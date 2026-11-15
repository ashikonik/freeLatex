import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * How the preview is produced.
 *
 * The two engines do the same work in different places: the WebAssembly one
 * runs in the browser and never leaves the machine, the server one runs
 * Tectonic and needs the project's files to be on the server.
 */
export type BuildMode = 'wasm' | 'server';

/** The properties of the header. */
export interface HeaderProps {
  /** The title of the project. */
  title: string;
  /** The file that is open. */
  activePath: string | undefined;
  /** The file the project is built from. */
  mainFile?: string;
  /** How the preview is produced. */
  mode: BuildMode;
  /** Called when the mode changes. */
  onModeChange: (mode: BuildMode) => void;
  /** Called when the user asks to share the project. */
  onShare: () => void;
  /** Called when the user asks for the document's history. */
  onHistory: () => void;
  /** Called when the user asks the assistant for help. */
  onAssistant?: () => void;
  /** Called when the user asks the assistant to fix the compile errors. */
  onFixErrors?: () => void;
  /** How many compile errors the last build reported. */
  errorCount?: number;
  /** The connection state of the collaboration session. */
  status: 'connecting' | 'connected' | 'offline';
  /** Called when the user leaves the workspace. */
  onBack: () => void;
  /** Called when the reader asks for a build. */
  onBuild?: (() => void) | undefined;
  /** Whether the document is rebuilt whenever it changes. */
  autoBuild?: boolean;
  /** Called when the automatic build is turned on or off. */
  onAutoBuildChange?: ((autoBuild: boolean) => void) | undefined;
  /** Called when the reader renames the project. */
  onRename?: ((title: string) => void) | undefined;
}

/**
 * The labels of the two engines.
 *
 * They are shown on the toggle, so a reader knows at a glance where the
 * preview is coming from.
 */
const MODE_LABELS: Record<BuildMode, string> = {
  wasm: '⚡ Instant Wasm Preview',
  server: '🖥️ Server Tectonic Build',
};

/**
 * The workspace header.
 *
 * The header carries the project's name, the connection state and the three
 * actions the reader reaches for: choosing where the preview is built,
 * sharing the document and opening its history.
 */
export function Header({
  title,
  activePath,
  mainFile,
  mode,
  onModeChange,
  onShare,
  onHistory,
  onAssistant,
  onFixErrors,
  errorCount = 0,
  status,
  onBack,
  onBuild,
  autoBuild = true,
  onAutoBuildChange,
  onRename,
}: HeaderProps): React.ReactElement {
  const toggle = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>): void => {
      onModeChange(event.target.value === 'server' ? 'server' : 'wasm');
    },
    [onModeChange],
  );

  const stateClass =
    status === 'connected'
      ? 'bg-emerald-100 text-emerald-700'
      : status === 'offline'
        ? 'bg-red-100 text-red-700'
        : 'bg-amber-100 text-amber-700';

  const stateLabel =
    status === 'connected' ? 'Connected' : status === 'offline' ? 'Offline' : 'Connecting…';

  return (
    <header className="flex items-center gap-4 border-b border-slate-200 bg-white px-4 py-2">
      <button
        type="button"
        onClick={onBack}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
      >
        ← Projects
      </button>

      <EditableTitle title={title} onRename={onRename} />

      <span className="text-sm text-slate-500">{activePath ?? 'No file open'}</span>

      {mainFile ? (
        <span
          className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
          data-testid="main-file"
          title="The file this project is built from"
        >
          main: {mainFile}
        </span>
      ) : null}

      <label className="ml-auto flex items-center gap-2 text-sm">
        <span className="sr-only">Build mode</span>
        <select
          value={mode}
          onChange={toggle}
          data-testid="build-mode"
          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700"
        >
          <option value="wasm">{MODE_LABELS.wasm}</option>
          <option value="server">{MODE_LABELS.server}</option>
        </select>
      </label>

      {onBuild ? (
        <button
          type="button"
          onClick={onBuild}
          data-testid="build-button"
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
        >
          Build
        </button>
      ) : null}

      {onAutoBuildChange ? (
        <label className="flex items-center gap-1.5 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={autoBuild}
            onChange={(event) => onAutoBuildChange(event.target.checked)}
            data-testid="auto-build-toggle"
          />
          Auto
        </label>
      ) : null}

      <button
        type="button"
        onClick={onShare}
        data-testid="share-button"
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
      >
        Share
      </button>

      <button
        type="button"
        onClick={onHistory}
        data-testid="history-button"
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
      >
        History
      </button>

      {onAssistant ? (
        <button
          type="button"
          onClick={onAssistant}
          data-testid="assistant-button"
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
        >
          Assistant
        </button>
      ) : null}

      {onFixErrors && errorCount > 0 ? (
        <button
          type="button"
          onClick={onFixErrors}
          data-testid="fix-errors-button"
          className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700"
        >
          Fix {errorCount} error{errorCount === 1 ? '' : 's'}
        </button>
      ) : null}

      <span className={`rounded-full px-2 py-0.5 text-xs ${stateClass}`} data-testid="connection-status">
        {stateLabel}
      </span>
    </header>
  );
}

/**
 * The project's title, editable in place.
 *
 * Clicking the title turns it into a field; Enter saves it and Escape
 * leaves it as it was. A title that is not given a new name is not changed,
 * so an empty edit never wipes the name.
 */
function EditableTitle({
  title,
  onRename,
}: {
  title: string;
  onRename?: ((title: string) => void) | undefined;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const input = useRef<HTMLInputElement | null>(null);

  // The field starts with the title it is editing, and the title may change
  // under it when the project is renamed elsewhere.
  useEffect(() => {
    setValue(title);
  }, [title]);

  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  if (!editing || !onRename) {
    return (
      <h1
        className={`font-medium text-slate-900 ${onRename ? 'cursor-text hover:underline' : ''}`}
        onClick={() => {
          if (onRename) {
            setEditing(true);
          }
        }}
        data-testid="project-title"
      >
        {title}
      </h1>
    );
  }

  const commit = (): void => {
    const next = value.trim();
    setEditing(false);
    if (next.length > 0 && next !== title) {
      onRename(next);
    } else {
      setValue(title);
    }
  };

  return (
    <input
      ref={input}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commit();
        } else if (event.key === 'Escape') {
          setValue(title);
          setEditing(false);
        }
      }}
      aria-label="Project title"
      data-testid="project-title-input"
      className="w-64 rounded-md border border-slate-300 px-2 py-0.5 text-sm font-medium text-slate-900 outline-none focus:border-slate-500"
    />
  );
}
