import { useCallback, useState } from 'react';

import { askAi } from '../../lib/api.js';
import { AISettingsModal } from './AISettingsModal.js';
import { readAiSettings, type AiSettings } from './ai-settings.js';

/** The things the assistant can be asked to do. */
export const ASSISTANT_TASKS = [
  {
    id: 'polish',
    label: 'Polish the tone',
    prompt:
      'Rewrite the following LaTeX in a more formal academic tone. Keep the meaning, the citations and the structure exactly as they are.',
  },
  {
    id: 'equation',
    label: 'Draft an equation',
    prompt:
      'Write the LaTeX for the equation the following describes. Give only the equation, ready to paste into the document.',
  },
  {
    id: 'cite',
    label: 'Find a citation',
    prompt:
      'Suggest the BibTeX entry for the work the following describes. Give only the BibTeX entry.',
  },
  {
    id: 'explain',
    label: 'Explain a passage',
    prompt:
      'Explain the following LaTeX passage in plain language, for a reader who knows LaTeX but not the field.',
  },
] as const;

/** One of the assistant's tasks. */
export type AssistantTask = (typeof ASSISTANT_TASKS)[number]['id'];

/** The properties of the assistant. */
export interface AIAssistantProps {
  /** The source the assistant is working on. */
  source: string;
  /** Called when the reader accepts an answer. */
  onApply: (text: string) => void;
}

/**
 * The writing assistant.
 *
 * The assistant is a sidebar: the reader asks for something, the answer
 * arrives, and the reader decides whether to paste it into the document.
 * The assistant never edits the document on its own.
 */
export function AIAssistant({ source, onApply }: AIAssistantProps): React.ReactElement {
  const [settings, setSettings] = useState<AiSettings | undefined>(readAiSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [task, setTask] = useState<AssistantTask>('polish');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [asking, setAsking] = useState(false);

  const ask = useCallback(async (): Promise<void> => {
    if (!settings?.apiKey) {
      setSettingsOpen(true);
      return;
    }

    const chosen = ASSISTANT_TASKS.find((entry) => entry.id === task);
    if (!chosen) {
      return;
    }

    setAsking(true);
    setError(undefined);
    setAnswer(undefined);
    try {
      const text = await askAi(settings.provider, settings.apiKey, {
        prompt: question.trim() ? `${chosen.prompt}\n\n${question.trim()}` : chosen.prompt,
        source,
      });
      setAnswer(text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The assistant could not be reached.');
    } finally {
      setAsking(false);
    }
  }, [settings, task, question, source]);

  return (
    <aside className="flex h-full flex-col bg-slate-50" data-testid="ai-assistant">
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-3 py-2">
        <h2 className="text-sm font-medium text-slate-900">Assistant</h2>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          data-testid="ai-settings-button"
          className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50"
        >
          {settings?.apiKey ? 'Settings' : 'Add key'}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        <label className="mb-2 block text-sm">
          <span className="mb-1 block text-slate-700">What should it do?</span>
          <select
            value={task}
            onChange={(event) => setTask(event.target.value as AssistantTask)}
            data-testid="ai-task"
            className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            {ASSISTANT_TASKS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        <label className="mb-2 block text-sm">
          <span className="mb-1 block text-slate-700">Anything to add?</span>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            rows={3}
            placeholder="Describe what you want, in your own words"
            className="w-full resize-y rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>

        <button
          type="button"
          onClick={() => {
            void ask();
          }}
          disabled={asking}
          data-testid="ai-ask"
          className="w-full rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {asking ? 'Thinking…' : 'Ask'}
        </button>

        {error ? (
          <p role="alert" className="mt-3 rounded bg-red-50 p-2 text-xs text-red-700">
            {error}
          </p>
        ) : null}

        {answer ? (
          <div className="mt-3" data-testid="ai-answer">
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-slate-200 bg-white p-2 font-mono text-xs text-slate-800">
              {answer}
            </pre>
            <button
              type="button"
              onClick={() => onApply(answer)}
              data-testid="ai-apply"
              className="mt-2 w-full rounded-md bg-emerald-700 px-3 py-1.5 text-sm text-white"
            >
              Insert into the document
            </button>
          </div>
        ) : null}
      </div>

      {settingsOpen ? (
        <AISettingsModal
          onClose={() => setSettingsOpen(false)}
          onSaved={(saved) => setSettings(saved)}
          onForgotten={() => setSettings(undefined)}
        />
      ) : null}
    </aside>
  );
}
