import { useCallback } from 'react';

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
  /** How the preview is produced. */
  mode: BuildMode;
  /** Called when the mode changes. */
  onModeChange: (mode: BuildMode) => void;
  /** Called when the user asks to share the project. */
  onShare: () => void;
  /** Called when the user asks for the document's history. */
  onHistory: () => void;
  /** The connection state of the collaboration session. */
  status: 'connecting' | 'connected' | 'offline';
  /** Called when the user leaves the workspace. */
  onBack: () => void;
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
  mode,
  onModeChange,
  onShare,
  onHistory,
  status,
  onBack,
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

      <h1 className="font-medium text-slate-900">{title}</h1>
      <span className="text-sm text-slate-500">{activePath ?? 'No file open'}</span>

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

      <span className={`rounded-full px-2 py-0.5 text-xs ${stateClass}`} data-testid="connection-status">
        {stateLabel}
      </span>
    </header>
  );
}
