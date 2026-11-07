/**
 * The share link the reader arrived with.
 *
 * A share link is a URL of the form `/p/{projectId}?token={token}`. It is
 * the one way into a project that needs no account: the owner mints the
 * link, and whoever holds it may read the project or edit it, according to
 * the link's permission.
 *
 * The token is held apart from the stored account key, because the two mean
 * different things. The account key is the reader's own credential and stays
 * in the browser between visits; the share token belongs to one project and
 * is only ever used for the project the link names. Keeping them apart also
 * keeps a share token out of the account's storage, so it is not sent along
 * with the reader's other requests.
 */

/**
 * Where the share token of the current visit is kept.
 *
 * It is deliberately not `localStorage`: the token lives only as long as the
 * visit does, and a reader who opens somebody else's link must not have it
 * left behind on a shared machine.
 */
let activeShareToken: string | undefined;

/**
 * The project a share link names, if the reader arrived through one.
 */
let activeShareProjectId: string | undefined;

/**
 * The prefix of a path that names a shared project.
 */
const SHARE_PATH_PREFIX = '/p/';

/**
 * The prefixes a share token carries.
 *
 * The prefix is what tells a share token apart from an account key without
 * asking the server, which is what the browser needs to decide how to treat
 * a token it finds in the URL.
 */
const SHARE_TOKEN_PREFIXES = ['rw_', 'ro_'] as const;

/**
 * True when a credential is shaped like a share token.
 */
export function isShareTokenShape(token: string): boolean {
  return SHARE_TOKEN_PREFIXES.some((prefix) => token.startsWith(prefix));
}

/**
 * The share link the reader arrived with, if any.
 */
export interface ShareLink {
  /** The project the link names. */
  projectId: string;
  /** The token that opens it. */
  token: string;
}

/**
 * Read the share link out of a URL.
 *
 * A path that is not a share path, or a share path without a token, is not a
 * share link — the reader simply came to the application in the ordinary
 * way.
 */
export function parseShareLink(url: string): ShareLink | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url, 'http://localhost');
  } catch {
    return undefined;
  }

  if (!parsed.pathname.startsWith(SHARE_PATH_PREFIX)) {
    return undefined;
  }

  const projectId = parsed.pathname.slice(SHARE_PATH_PREFIX.length).replace(/\/+$/, '');
  const token = parsed.searchParams.get('token')?.trim();
  if (!projectId || !token || !isShareTokenShape(token)) {
    return undefined;
  }

  return { projectId, token };
}

/**
 * Remember the share link of the current visit.
 */
export function setActiveShareLink(link: ShareLink | undefined): void {
  activeShareToken = link?.token;
  activeShareProjectId = link?.projectId;
}

/**
 * The share token of the current visit, if there is one.
 */
export function readActiveShareToken(): string | undefined {
  return activeShareToken;
}

/**
 * The project the current visit's share link names, if there is one.
 */
export function readActiveShareProjectId(): string | undefined {
  return activeShareProjectId;
}

/**
 * Forget the share link of the current visit.
 */
export function clearActiveShareLink(): void {
  activeShareToken = undefined;
  activeShareProjectId = undefined;
}
