import { useCallback, useState } from 'react';

import { askAi } from '../../lib/api.js';
import { useEscapeToClose } from '../use-modal.js';
import { readAiSettings } from './ai-settings.js';

/** The properties of the error-fixing dialog. */
export interface ErrorFixModalProps {
  /** The errors the compiler reported. */
  errors: string[];
  /** The source the errors came from. */
  source: string;
  /** Called when the reader accepts the fix. */
  onApply: (text: string) => void;
  /** Called when the dialog is dismissed. */
  onClose: () => void;
}

/**
 * The one-click error fix.
 *
 * The compiler's errors are handed to the assistant, which is asked for the
 * document with the errors repaired. The answer is shown in full before
 * anything is applied, so the reader can see what would change.
 */
export function ErrorFixModal({
  errors,
  source,
  onApply,
  onClose,
}: ErrorFixModalProps): React.ReactElement {
  const [fixed, setFixed] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [working, setWorking] = useState(false);

  useEscapeToClose(onClose);

  const fix = useCallback(async (): Promise<void> => {
    const settings = readAiSettings();
    if (!settings?.apiKey) {
      setError('Add your provider key in the assistant settings first.');
      return;
    }

    setWorking(true);
    setError(undefined);
    try {
      const text = await askAi(settings.provider, settings.apiKey, {
        prompt: [
          'The LaTeX document below does not compile.',
          'Fix the errors and give the whole corrected document, ready to paste.',
          'Change nothing else about it.',
        ].join(' '),
        source,
        errors,
      });
      setFixed(text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The assistant could not be reached.');
    } finally {
      setWorking(false);
    }
  }, [errors, source]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Fix the errors"
        data-testid="error-fix-modal"
        className="flex h-[80vh] w-full max-w-4xl flex-col rounded-lg bg-white shadow-xl"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="font-medium text-slate-900">Fix the errors</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded border border-slate-300 px-2 py-0.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          <h3 className="mb-1 text-sm font-medium text-slate-900">
            {errors.length} error{errors.length === 1 ? '' : 's'}
          </h3>
          <pre className="mb-4 max-h-40 overflow-auto rounded bg-red-50 p-2 text-xs text-red-800">
            {errors.join('\n\n')}
          </pre>

          {error ? (
            <p role="alert" className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">
              {error}
            </p>
          ) : null}

          {fixed ? (
            <div data-testid="fix-answer">
              <h3 className="mb-1 text-sm font-medium text-slate-900">The corrected document</h3>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 p-2 font-mono text-xs text-slate-800">
                {fixed}
              </pre>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          {fixed ? (
            <button
              type="button"
              onClick={() => onApply(fixed)}
              data-testid="apply-fix"
              className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm text-white"
            >
              Apply fix
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                void fix();
              }}
              disabled={working}
              data-testid="ask-for-fix"
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {working ? 'Thinking…' : 'Ask for a fix'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
