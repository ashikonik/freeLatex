import { useCallback, useEffect, useState } from 'react';

import {
  diffSnapshot,
  listSnapshots,
  rollbackToSnapshot,
  type FileDiff,
  type SnapshotSummary,
} from '../../lib/api.js';
import { pairDiff, parseDiff } from './diff-view.js';
import { useEscapeToClose } from '../use-modal.js';

/** The properties of the history modal. */
export interface HistoryModalProps {
  /** The project whose history is shown. */
  projectId: string;
  /** Called when the modal is dismissed. */
  onClose: () => void;
  /** Called after the project has been restored to a revision. */
  onRestored: () => void;
}

/**
 * The document history.
 *
 * The modal shows the revisions of a project, the difference between one of
 * them and the newest, and offers to restore the project to the revision
 * that is selected.
 */
export function HistoryModal({
  projectId,
  onClose,
  onRestored,
}: HistoryModalProps): React.ReactElement {
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  /**
   * The revision the difference was taken against.
   *
   * The server answers with the newest revision when none is asked for, so
   * this is what the comparison is actually against.
   */
  const [comparedWith, setComparedWith] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [restoring, setRestoring] = useState(false);

  useEscapeToClose(onClose);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void listSnapshots(projectId)
      .then(({ snapshots: found }) => {
        if (cancelled) {
          return;
        }
        setSnapshots(found);
        // The newest revision is the interesting one to start from.
        setSelected(found[0]?.id);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'The history could not be read.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // The difference is asked for whenever the selected revision changes.
  useEffect(() => {
    if (!selected) {
      setDiffs([]);
      setComparedWith(undefined);
      return;
    }
    let cancelled = false;
    void diffSnapshot(projectId, selected)
      .then(({ diffs: found, to }) => {
        if (!cancelled) {
          setDiffs(found);
          setComparedWith(to);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'The difference could not be read.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selected]);

  const restore = useCallback(async (): Promise<void> => {
    if (!selected) {
      return;
    }
    setRestoring(true);
    setError(undefined);
    try {
      await rollbackToSnapshot(projectId, selected);
      onRestored();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The restore failed.');
    } finally {
      setRestoring(false);
    }
  }, [projectId, selected, onRestored, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Document history"
        data-testid="history-modal"
        className="flex h-[80vh] w-full max-w-5xl flex-col rounded-lg bg-white shadow-xl"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="font-medium text-slate-900">Document history</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded border border-slate-300 px-2 py-0.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            ×
          </button>
        </div>

        {error ? (
          <p role="alert" className="bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <div className="flex min-h-0 flex-1">
          <div className="w-64 shrink-0 overflow-auto border-r border-slate-200">
            {loading ? (
              <p className="p-3 text-sm text-slate-500">Loading…</p>
            ) : snapshots.length === 0 ? (
              <p className="p-3 text-sm text-slate-500">No revisions yet.</p>
            ) : (
              <ul>
                {snapshots.map((snapshot) => (
                  <li key={snapshot.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(snapshot.id)}
                      aria-current={snapshot.id === selected}
                      className={`w-full border-b border-slate-100 px-3 py-2 text-left text-sm ${
                        snapshot.id === selected
                          ? 'bg-slate-100 text-slate-900'
                          : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span className="block font-medium">
                        {snapshot.label || 'Untitled revision'}
                      </span>
                      <span className="block text-xs text-slate-500">
                        {formatWhen(snapshot.createdAt)} · {snapshot.fileCount} files
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="min-w-0 flex-1 overflow-auto p-4">
            {diffs.length === 0 ? (
              <p className="text-sm text-slate-500">No differences to show.</p>
            ) : (
              <>
                <p className="mb-3 text-sm text-slate-600">
                  {comparedWith
                    ? `Comparing this revision with ${labelOf(snapshots, comparedWith)}.`
                    : 'Comparing this revision with the newest one.'}
                </p>
                {diffs.map((diff) => (
                  <DiffFile key={diff.path} diff={diff} />
                ))}
              </>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => {
              void restore();
            }}
            disabled={!selected || restoring}
            data-testid="restore-button"
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {restoring ? 'Restoring…' : 'Restore this version'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The name of a revision.
 *
 * A revision the reader has given a name to is named by it; one without a
 * name is called by the time it was made.
 *
 * @param snapshots The revisions of the project.
 * @param id The revision to name.
 */
function labelOf(snapshots: SnapshotSummary[], id: string): string {
  const found = snapshots.find((snapshot) => snapshot.id === id);
  if (!found) {
    return 'the newest revision';
  }
  return found.label ? `"${found.label}"` : `the revision of ${formatWhen(found.createdAt)}`;
}

/** The properties of one file's diff. */
interface DiffFileProps {
  /** The diff of the file. */
  diff: FileDiff;
}

/**
 * The difference of one file, side by side.
 *
 * The two columns are the old file and the new one. A line that only exists
 * on one side leaves its place on the other side empty, which is what makes
 * the two columns line up.
 */
function DiffFile({ diff }: DiffFileProps): React.ReactElement {
  const sides = pairDiff(parseDiff(diff.patch));

  return (
    <section className="mb-6" data-testid="diff-file">
      <header className="mb-2 flex items-center gap-2">
        <h3 className="font-mono text-sm font-medium text-slate-900">{diff.path}</h3>
        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700">
          +{diff.addedLines}
        </span>
        <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700">
          −{diff.removedLines}
        </span>
      </header>

      <div className="overflow-hidden rounded border border-slate-200 font-mono text-xs">
        {sides.left.map((left, index) => {
          const right = sides.right[index];
          return (
            <div key={index} className="grid grid-cols-2">
              <div
                className={`whitespace-pre-wrap px-2 py-0.5 ${
                  left?.kind === 'removed' ? 'bg-red-50 text-red-900' : 'text-slate-600'
                }`}
              >
                {left?.text ?? ''}
              </div>
              <div
                className={`whitespace-pre-wrap px-2 py-0.5 ${
                  right?.kind === 'added' ? 'bg-emerald-50 text-emerald-900' : 'text-slate-600'
                }`}
              >
                {right?.text ?? ''}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The time of a revision, in words.
 *
 * A date that is close to now is said as "just now" or "5 minutes ago",
 * because that is what a reader of a history wants to know.
 *
 * @param value The revision's timestamp.
 */
function formatWhen(value: string): string {
  const when = new Date(value).getTime();
  if (Number.isNaN(when)) {
    return value;
  }

  const seconds = Math.round((Date.now() - when) / 1000);
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 30) {
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }
  return new Date(value).toLocaleDateString();
}
