import { useState } from 'react';

import { useEscapeToClose } from '../use-modal.js';
import {
  PROVIDER_NAMES,
  clearAiSettings,
  readAiSettings,
  storeAiSettings,
  type AiProvider,
  type AiSettings,
} from './ai-settings.js';

/** The properties of the settings modal. */
export interface AISettingsModalProps {
  /** Called when the modal is dismissed. */
  onClose: () => void;
  /** Called when the settings are saved. */
  onSaved: (settings: AiSettings) => void;
  /**
   * Called when the key is forgotten.
   *
   * The key is gone from the browser's storage, so whoever is holding it
   * has to let it go as well. Otherwise the old key would still be sent with
   * the next question.
   */
  onForgotten?: () => void;
}

/**
 * The assistant's settings.
 *
 * The reader brings their own key, so the key is asked for here and kept in
 * the browser's own storage. It is never sent to the server except on the
 * request it is needed for.
 */
export function AISettingsModal({
  onClose,
  onSaved,
  onForgotten,
}: AISettingsModalProps): React.ReactElement {
  const stored = readAiSettings();
  const [provider, setProvider] = useState<AiProvider>(stored?.provider ?? 'gemini');
  const [apiKey, setApiKey] = useState(stored?.apiKey ?? '');
  const [error, setError] = useState<string | undefined>(undefined);

  useEscapeToClose(onClose);

  const save = (): void => {
    const key = apiKey.trim();
    // Saving an empty key would leave the reader with an assistant that
    // cannot answer, and no way of telling why.
    if (!key) {
      setError('A key is needed. Paste the key of the provider you chose.');
      return;
    }
    const settings: AiSettings = { provider, apiKey: key };
    storeAiSettings(settings);
    onSaved(settings);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Assistant settings"
        data-testid="ai-settings-modal"
        className="w-full max-w-md rounded-lg bg-white p-4 shadow-xl"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium text-slate-900">Assistant settings</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded border border-slate-300 px-2 py-0.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            ×
          </button>
        </div>

        <p className="mb-3 text-sm text-slate-600">
          The assistant uses your own key. It is kept in this browser and is sent to the
          provider only when you ask a question.
        </p>

        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-slate-700">Provider</span>
          <select
            value={provider}
            onChange={(event) => {
              setProvider(event.target.value as AiProvider);
            }}
            data-testid="ai-provider"
            className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            <option value="gemini">{PROVIDER_NAMES.gemini}</option>
            <option value="openai">{PROVIDER_NAMES.openai}</option>
            <option value="anthropic">{PROVIDER_NAMES.anthropic}</option>
          </select>
        </label>

        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-slate-700">API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Paste your key"
            data-testid="ai-api-key"
            className="w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-sm"
          />
        </label>

        {error ? (
          <p role="alert" className="mb-3 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              clearAiSettings();
              setApiKey('');
              setError(undefined);
              onForgotten?.();
            }}
            data-testid="forget-ai-key"
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            Forget key
          </button>
          <button
            type="button"
            onClick={save}
            data-testid="save-ai-settings"
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
