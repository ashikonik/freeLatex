import { useCallback, useEffect, useState } from 'react';

import {
  createShareToken,
  listShareTokens,
  revokeShareToken,
  type CreatedShareToken,
  type SharePermission,
  type ShareToken,
} from '../../lib/api.js';
import { useEscapeToClose } from '../use-modal.js';

/** The properties of the share modal. */
export interface ShareModalProps {
  /** The project that is shared. */
  projectId: string;
  /** Called when the modal is dismissed. */
  onClose: () => void;
}

/**
 * The share links of a project.
 *
 * The modal mints links, shows the ones that already exist, and lets the
 * owner revoke them. The plaintext of a link is only shown once — right
 * after it is created — because the server cannot recover it afterwards.
 */
export function ShareModal({ projectId, onClose }: ShareModalProps): React.ReactElement {
  const [tokens, setTokens] = useState<ShareToken[]>([]);
  const [permission, setPermission] = useState<SharePermission>('ro');
  const [label, setLabel] = useState('');
  const [expiresIn, setExpiresIn] = useState('');
  const [created, setCreated] = useState<CreatedShareToken | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEscapeToClose(onClose);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const { tokens: found } = await listShareTokens(projectId);
      setTokens(found);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The share links could not be read.');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(async (): Promise<void> => {
    setError(undefined);
    try {
      const options: { permission: SharePermission; label?: string; expiresAt?: string } = {
        permission,
      };
      if (label.trim()) {
        options.label = label.trim();
      }
      const days = expiresIn.trim() ? Number(expiresIn) : undefined;
      if (days !== undefined) {
        // A number that is not a number, or one that is not a whole number
        // of days, has no expiry to compute. Saying so is better than
        // sending the server a date that is not a date.
        if (!Number.isFinite(days) || !Number.isInteger(days) || days < 1) {
          setError('The expiry must be a whole number of days of at least one.');
          return;
        }
        options.expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
      }
      const token = await createShareToken(projectId, options);
      setCreated(token);
      setCopied(false);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The share link could not be created.');
    }
  }, [projectId, permission, label, expiresIn, refresh]);

  const revoke = useCallback(
    async (tokenId: string): Promise<void> => {
      setError(undefined);
      try {
        await revokeShareToken(projectId, tokenId);
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'The share link could not be revoked.');
      }
    },
    [projectId, refresh],
  );

  const copy = useCallback(async (): Promise<void> => {
    if (!created) {
      return;
    }
    const url = `${location.origin}${created.url}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // A browser that will not let the page write to the clipboard leaves
      // the link on the page, where the reader can copy it by hand.
      setCopied(false);
    }
  }, [created]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Share"
        data-testid="share-modal"
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg bg-white shadow-xl"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="font-medium text-slate-900">Share</h2>
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

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {created ? (
            <div
              className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 p-3"
              data-testid="created-link"
            >
              <p className="mb-1 text-sm text-emerald-900">
                The link is shown once. Copy it now.
              </p>
              <code className="block break-all rounded bg-white p-2 font-mono text-xs text-slate-800">
                {location.origin}
                {created.url}
              </code>
              <button
                type="button"
                onClick={() => {
                  void copy();
                }}
                data-testid="copy-button"
                className="mt-2 rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white"
              >
                {copied ? 'Copied' : 'Copy link'}
              </button>
            </div>
          ) : null}

          <div className="mb-4 space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-slate-700">Permission</span>
              <select
                value={permission}
                onChange={(event) => {
                  setPermission(event.target.value === 'rw' ? 'rw' : 'ro');
                }}
                data-testid="share-permission"
                className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              >
                <option value="ro">Read-only</option>
                <option value="rw">Read and write</option>
              </select>
            </label>

            <label className="block text-sm">
              <span className="mb-1 block text-slate-700">Label</span>
              <input
                type="text"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="For the thesis adviser"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>

            <label className="block text-sm">
              <span className="mb-1 block text-slate-700">Expires in (days)</span>
              <input
                type="number"
                min={1}
                value={expiresIn}
                onChange={(event) => setExpiresIn(event.target.value)}
                placeholder="Never"
                data-testid="share-expires-in"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>

            <button
              type="button"
              onClick={() => {
                void create();
              }}
              data-testid="create-link-button"
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white"
            >
              Create link
            </button>
          </div>

          <h3 className="mb-2 text-sm font-medium text-slate-900">Active links</h3>
          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : tokens.length === 0 ? (
            <p className="text-sm text-slate-500">No share links yet.</p>
          ) : (
            <ul data-testid="token-list">
              {tokens.map((token) => (
                <li
                  key={token.id}
                  className="flex items-center gap-2 border-b border-slate-100 py-2 text-sm"
                >
                  <span className="flex-1 truncate text-slate-700">
                    {token.label || 'Untitled link'}
                  </span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                    {token.permission === 'rw' ? 'Can edit' : 'Read only'}
                  </span>
                  {token.expired ? (
                    <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700">
                      Expired
                    </span>
                  ) : token.expiresAt ? (
                    <span className="text-xs text-slate-500">
                      until {new Date(token.expiresAt).toLocaleDateString()}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      void revoke(token.id);
                    }}
                    aria-label={`Revoke ${token.label || 'the share link'}`}
                    className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50"
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
