import { useCallback, useState, type FormEvent } from 'react';

import { useAuth } from '../context/AuthContext.js';

/**
 * The sign-in page.
 *
 * The page asks for an API key and hands it to the auth context, which
 * verifies it against the server before storing it.
 */
export function LoginPage(): React.ReactElement {
  const { login, error, loading } = useAuth();
  const [apiKey, setApiKey] = useState('');

  const onSubmit = useCallback(
    async (event: FormEvent): Promise<void> => {
      event.preventDefault();
      const trimmed = apiKey.trim();
      if (trimmed.length === 0) {
        return;
      }
      try {
        await login(trimmed);
      } catch {
        // The error is shown by the context.
      }
    },
    [apiKey, login],
  );

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <form
        onSubmit={(event) => {
          void onSubmit(event);
        }}
        className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm"
      >
        <h1 className="text-2xl font-semibold text-slate-900">freeLatex</h1>
        <p className="mt-1 text-sm text-slate-500">
          Sign in with your API key to open your workspace.
        </p>

        <label className="mt-6 block text-sm font-medium text-slate-700" htmlFor="api-key">
          API key
        </label>
        <input
          id="api-key"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          autoComplete="current-password"
          placeholder="sk_user_…"
          className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
        />

        {error ? (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={loading || apiKey.trim().length === 0}
          className="mt-6 w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
