/**
 * The identity resolved from a request's credentials.
 *
 * A request carries exactly one of these, decided by how it authenticated:
 *  - `admin`  — the master ADMIN_API_KEY. Full control over the instance.
 *  - `user`   — a provisioned sk_user_... key. Owns an isolated workspace.
 *  - `share`  — a link token (rw_... / ro_...). Scoped to one project, no account.
 */
export type Role = 'admin' | 'user';

export interface AdminIdentity {
  kind: 'admin';
  role: 'admin';
  userId: string;
  name: string;
}

export interface UserIdentity {
  kind: 'user';
  role: 'user';
  userId: string;
  name: string;
}

export interface ShareIdentity {
  kind: 'share';
  role: 'share';
  /** The share token record id. */
  tokenId: string;
  projectId: string;
  /** 'rw' can edit the project, 'ro' is view-only. */
  permission: 'rw' | 'ro';
}

export type Identity = AdminIdentity | UserIdentity | ShareIdentity;

/** The admin has unrestricted access to every project on the instance. */
export function isAdmin(identity: Identity): identity is AdminIdentity {
  return identity.kind === 'admin';
}

/** A signed-in account (admin or provisioned user) that owns projects. */
export function isAccount(identity: Identity): identity is AdminIdentity | UserIdentity {
  return identity.kind === 'admin' || identity.kind === 'user';
}

/** True when the identity may modify project contents. */
export function canWrite(identity: Identity): boolean {
  if (isAccount(identity)) {
    return true;
  }
  return identity.permission === 'rw';
}
