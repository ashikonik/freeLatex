/**
 * The HTTP client for the freeLatex API.
 *
 * Every request carries the API key in the `Authorization` header. The key
 * comes from the auth context, so the client reads it from a setter rather
 * than from the context directly, which keeps this module free of React.
 */

import type { AiProvider } from '../components/ai/ai-settings.js';
import { readActiveShareToken } from './share-link.js';

/** The shape of a project as the API reports it. */
export interface Project {
  id: string;
  title: string;
  mainFile: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

/** A node of a project's file tree. */
export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  children?: FileTreeNode[];
}

/** The diagnostics of the most recent build. */
export interface BuildMetadata {
  success: boolean;
  errors: string[];
  durationMs: number;
  pageCount: number;
  hasSyncTex: boolean;
  builtAt: string;
}

/** An error carrying the HTTP status the server answered with. */
export class ApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}

/** Where the API key comes from. */
type KeyProvider = () => string | undefined;

let readKey: KeyProvider = () => undefined;

/**
 * Install the function that hands the API key to the client.
 *
 * The auth context calls this when it mounts, so the rest of the application
 * never has to thread the key through every call.
 */
export function setApiKeyProvider(provider: KeyProvider): void {
  readKey = provider;
}

/**
 * The credential the request carries.
 *
 * A reader who arrived through a share link is a guest of one project, so
 * the share token is their credential for this visit; it wins over the stored
 * account key, because the account key may name a different workspace
 * entirely. The server tells the two apart by the token's own shape.
 */
function credentialOf(): string | undefined {
  return readActiveShareToken() ?? readKey();
}

/**
 * Perform an authenticated request against the API.
 *
 * @param path The path below `/api`.
 * @param options The request options. `body` is sent as JSON, and `headers`
 *   are added to the ones the client always sends.
 */
export async function apiRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    raw?: boolean;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = { ...options.headers };
  const key = credentialOf();
  // The caller's own header wins, so a request can say something different
  // about who it is on purpose.
  if (key && !('authorization' in headers)) {
    headers.authorization = `Bearer ${key}`;
  }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const request: RequestInit = {
    method: options.method ?? 'GET',
    headers,
  };
  if (options.body !== undefined) {
    request.body = JSON.stringify(options.body);
  }

  const response = await fetch(`/api${path}`, request);

  if (!response.ok) {
    // The server answers a failure with `{ error }`; anything else is a
    // message of the client's own making.
    let message = `The request failed with status ${response.status}.`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // The body was not JSON, so the default message stands.
    }
    throw new ApiError(response.status, message);
  }

  if (options.raw) {
    return (await response.arrayBuffer()) as unknown as T;
  }

  return (await response.json()) as T;
}

/** List the projects the caller may see. */
export function listProjects(): Promise<{ projects: Project[] }> {
  return apiRequest<{ projects: Project[] }>('/projects');
}

/** Create a project. */
export function createProject(title: string): Promise<Project> {
  return apiRequest<Project>('/projects', { method: 'POST', body: { title } });
}

/** Delete a project. */
export function deleteProject(id: string): Promise<{ success: boolean }> {
  return apiRequest<{ success: boolean }>(`/projects/${id}`, { method: 'DELETE' });
}

/** The result of importing a zip archive. */
export interface ImportResult {
  id: string;
  title: string;
  importedFiles: number;
  skippedFiles: string[];
  skippedCount: number;
}

/**
 * Import a project from a zip archive.
 *
 * The archive is sent as multipart form data, because the API takes the
 * archive as a file part rather than as a JSON value.
 */
export async function importProject(
  archive: Blob,
  title?: string,
): Promise<ImportResult> {
  const headers: Record<string, string> = {};
  const key = credentialOf();
  if (key) {
    headers.authorization = `Bearer ${key}`;
  }

  const form = new FormData();
  form.append('file', archive, 'project.zip');
  if (title) {
    form.append('title', title);
  }

  const response = await fetch('/api/projects/import', {
    method: 'POST',
    headers,
    body: form,
  });

  if (!response.ok) {
    let message = `The import failed with status ${response.status}.`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // The body was not JSON, so the default message stands.
    }
    throw new ApiError(response.status, message);
  }

  return (await response.json()) as ImportResult;
}

/** List the file tree of a project. */
export function listFiles(projectId: string): Promise<{ tree: FileTreeNode[] }> {
  return apiRequest<{ tree: FileTreeNode[] }>(`/projects/${projectId}/files`);
}

/** Read one file of a project. */
export function readFile(projectId: string, path: string): Promise<{ content: string }> {
  return apiRequest<{ content: string }>(
    `/projects/${projectId}/files/${encodePath(path)}`,
  );
}

/** Write one file of a project. */
export function writeFile(
  projectId: string,
  path: string,
  content: string,
): Promise<{ success: boolean }> {
  return apiRequest<{ success: boolean }>(`/projects/${projectId}/files/${encodePath(path)}`, {
    method: 'PUT',
    body: { content },
  });
}

/** The metadata of the most recent build of a project. */
export function buildMetadata(projectId: string): Promise<BuildMetadata> {
  return apiRequest<BuildMetadata>(`/projects/${projectId}/compile`);
}

/**
 * Compile a project on the server.
 *
 * The server answers with the PDF itself, so the bytes come back as an
 * array buffer.
 */
export function compileProject(
  projectId: string,
  mainFile?: string,
): Promise<ArrayBuffer> {
  return apiRequest<ArrayBuffer>(`/projects/${projectId}/compile`, {
    method: 'POST',
    body: mainFile ? { mainFile } : {},
    raw: true,
  });
}

/** The PDF of the most recent build of a project. */
export function fetchPdf(projectId: string): Promise<ArrayBuffer> {
  return apiRequest<ArrayBuffer>(`/projects/${projectId}/pdf`, { raw: true });
}

/** A rectangle on a page, in PDF points, measured from the bottom-left. */
export interface SyncPosition {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A place in the source, relative to the project root. */
export interface SyncSourceLocation {
  file: string;
  line: number;
  page?: number;
}

/** The answer of a forward search: a source line and where it is on the page. */
export interface ForwardSearchResult {
  source: SyncSourceLocation;
  position: SyncPosition;
}

/** The answer of an inverse search: a place on the page and the source of it. */
export interface InverseSearchResult {
  position: SyncPosition;
  source: SyncSourceLocation;
}

/**
 * Forward search: where does a source line appear on the page?
 *
 * A line with no entry in the SyncTeX data is not an error the caller has to
 * handle — a document may simply not have that line typeset — so the answer
 * is `undefined` rather than a rejection.
 */
export async function forwardSearch(
  projectId: string,
  file: string,
  line: number,
): Promise<ForwardSearchResult | undefined> {
  try {
    const query = new URLSearchParams({ file, line: String(line) });
    return await apiRequest<ForwardSearchResult>(
      `/projects/${projectId}/synctex/forward?${query.toString()}`,
    );
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 404) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Inverse search: which source line produced a point on the page?
 *
 * A point that no source line produced has no answer, and that is not an
 * error either.
 */
export async function inverseSearch(
  projectId: string,
  x: number,
  y: number,
  page: number,
): Promise<InverseSearchResult | undefined> {
  try {
    const query = new URLSearchParams({ x: String(x), y: String(y), page: String(page) });
    return await apiRequest<InverseSearchResult>(
      `/projects/${projectId}/synctex/inverse?${query.toString()}`,
    );
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 404) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Encode a file path for a URL.
 *
 * A path holds slashes, and the API expects them to survive, so each segment
 * is encoded rather than the whole path.
 */
export function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** A revision of a project, without its file contents. */
export interface SnapshotSummary {
  id: string;
  projectId: string;
  label: string;
  hash: string;
  /** The author of the revision, or undefined for a shared edit. */
  createdBy: string | null;
  createdAt: string;
  /** How many files the revision holds. */
  fileCount: number;
}

/** The unified diff of one file between two revisions. */
export interface FileDiff {
  path: string;
  /** 'added' when the file only exists in the newer revision. */
  changeType: 'added' | 'removed' | 'modified';
  /** The unified diff. Empty when the file is unchanged. */
  patch: string;
  addedLines: number;
  removedLines: number;
}

/** List a project's revisions, newest first. */
export function listSnapshots(projectId: string): Promise<{ snapshots: SnapshotSummary[] }> {
  return apiRequest<{ snapshots: SnapshotSummary[] }>(`/projects/${projectId}/snapshots`);
}

/**
 * The diff between a revision and another one.
 *
 * The other revision defaults to the newest one, so a client can ask "what
 * changed since this revision" without tracking the head itself.
 */
export function diffSnapshot(
  projectId: string,
  snapshotId: string,
  against?: string,
): Promise<{ from: string; to: string; diffs: FileDiff[] }> {
  const query = against ? `?against=${encodeURIComponent(against)}` : '';
  return apiRequest<{ from: string; to: string; diffs: FileDiff[] }>(
    `/projects/${projectId}/snapshots/${encodeURIComponent(snapshotId)}/diff${query}`,
  );
}

/** Restore a project to one of its revisions. */
export function rollbackToSnapshot(
  projectId: string,
  snapshotId: string,
): Promise<{ restored: boolean; fileCount: number }> {
  return apiRequest<{ restored: boolean; fileCount: number }>(
    `/projects/${projectId}/snapshots/${encodeURIComponent(snapshotId)}/rollback`,
    { method: 'POST' },
  );
}

/** How much a share link allows. */
export type SharePermission = 'rw' | 'ro';

/** A share link that already exists. */
export interface ShareToken {
  id: string;
  permission: SharePermission;
  label: string | null;
  createdAt: string;
  expiresAt: string | null;
  /** Whether the link has run out. */
  expired: boolean;
}

/**
 * A share link that was just created.
 *
 * The plaintext token is only ever returned once, so it is part of this
 * answer and of no other.
 */
export interface CreatedShareToken extends ShareToken {
  /** The plaintext token, in the link. */
  token: string;
  /** The path of the share link. */
  url: string;
}

/** Create a share link for a project. */
export function createShareToken(
  projectId: string,
  options: { permission: SharePermission; label?: string; expiresAt?: string } = {
    permission: 'ro',
  },
): Promise<CreatedShareToken> {
  const body: Record<string, unknown> = { permission: options.permission };
  if (options.label) {
    body.label = options.label;
  }
  if (options.expiresAt) {
    body.expiresAt = options.expiresAt;
  }
  return apiRequest<CreatedShareToken>(`/projects/${projectId}/share`, {
    method: 'POST',
    body,
  });
}

/** List a project's share links. */
export function listShareTokens(projectId: string): Promise<{ tokens: ShareToken[] }> {
  return apiRequest<{ tokens: ShareToken[] }>(`/projects/${projectId}/share`);
}

/** Revoke a share link. */
export function revokeShareToken(projectId: string, tokenId: string): Promise<void> {
  return apiRequest<void>(`/projects/${projectId}/share/${encodeURIComponent(tokenId)}`, {
    method: 'DELETE',
  });
}

/**
 * The header the provider's key travels in.
 *
 * The `Authorization` header carries the workspace's own key, which the
 * server's authentication reads, so the provider's key gets a header of its
 * own.
 */
export const PROVIDER_KEY_HEADER = 'x-provider-key';

/**
 * Ask the assistant a question.
 *
 * The reader's own provider key travels in its own header, so the server
 * passes it on to the provider without ever keeping it.
 */
export async function askAi(
  provider: AiProvider,
  providerKey: string,
  body: { prompt: string; source?: string; errors?: string[] },
): Promise<string> {
  const answer = await apiRequest<{ text: string }>('/ai/complete', {
    method: 'POST',
    headers: { [PROVIDER_KEY_HEADER]: providerKey },
    body: { provider, ...body },
  });

  return answer.text;
}
