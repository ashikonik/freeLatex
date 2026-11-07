import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { apiRequest, setApiKeyProvider } from '../lib/api.js';

/** Who the caller is. */
export interface Identity {
  kind: 'admin' | 'user' | 'share';
  role: string;
  name?: string;
  userId?: string;
}

/** The value the auth context carries. */
export interface AuthContextValue {
  /** The identity of the signed-in caller, or undefined when signed out. */
  identity: Identity | undefined;
  /** The mode the server runs in. */
  authMode: 'single' | 'multi' | undefined;
  /** Whether the key is being checked. */
  loading: boolean;
  /** The error of the last failed attempt, if any. */
  error: string | undefined;
  /** Sign in with an API key. */
  login(apiKey: string): Promise<void>;
  /** Sign out and forget the stored key. */
  logout(): void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * Where the API key is kept between visits.
 *
 * `localStorage` is the only storage a browser tab can read synchronously
 * before the first render, which matters because the editor has to know
 * whether it may connect to the collaboration socket on mount.
 */
const STORAGE_KEY = 'freelatex.apiKey';

/**
 * Read the stored API key.
 *
 * A browser without `localStorage` — a private window in some
 * configurations — yields undefined rather than throwing, so the application
 * falls back to asking for a key.
 */
export function readStoredApiKey(): string | undefined {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Store the API key. */
export function storeApiKey(apiKey: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, apiKey);
  } catch {
    // The key stays in memory for this session only.
  }
}

/** Forget the stored API key. */
export function clearStoredApiKey(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to forget.
  }
}

/**
 * Provide the authentication state to the application.
 *
 * The key is read once on mount and verified against the server. A key that
 * the server rejects is discarded, so a stale key does not leave the
 * application in a half-signed-in state.
 */
export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [apiKey, setApiKey] = useState<string | undefined>(undefined);
  const [identity, setIdentity] = useState<Identity | undefined>(undefined);
  const [authMode, setAuthMode] = useState<'single' | 'multi' | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  // The API client reads the key through this provider rather than through
  // the context, which keeps the client module free of React.
  useEffect(() => {
    setApiKeyProvider(() => apiKey);
  }, [apiKey]);

  useEffect(() => {
    const stored = readStoredApiKey();
    if (!stored) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setApiKey(stored);
    // The provider is installed here as well, because the request below
    // leaves before the effect above runs again with the new key.
    setApiKeyProvider(() => stored);

    void apiRequest<{ kind: Identity['kind']; role: string; name?: string; userId?: string }>(
      '/auth/me',
    )
      .then((me) => {
        if (cancelled) {
          return;
        }
        setIdentity(me);
      })
      .catch(() => {
        // The stored key is not accepted any more.
        if (cancelled) {
          return;
        }
        clearStoredApiKey();
        setApiKey(undefined);
        setIdentity(undefined);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (candidate: string): Promise<void> => {
    setError(undefined);
    setLoading(true);

    try {
      const result = await apiRequest<{
        identity: Identity;
        authMode: 'single' | 'multi';
      }>('/auth/login', { method: 'POST', body: { apiKey: candidate } });

      storeApiKey(candidate);
      setApiKey(candidate);
      setIdentity(result.identity);
      setAuthMode(result.authMode);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The key was refused.';
      setError(message);
      throw cause;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback((): void => {
    clearStoredApiKey();
    setApiKey(undefined);
    setIdentity(undefined);
    setError(undefined);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ identity, authMode, loading, error, login, logout }),
    [identity, authMode, loading, error, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Read the authentication state.
 *
 * @throws When used outside the provider, which is a programming error
 *   rather than a runtime condition.
 */
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside an AuthProvider.');
  }
  return value;
}
