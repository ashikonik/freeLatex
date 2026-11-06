import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, type DbHandle } from './index.js';
import { projectSnapshots, projects, shareTokens, users } from './schema.js';

let handle: DbHandle;

beforeEach(() => {
  handle = openDatabase(':memory:', ':memory:');
});

afterEach(() => {
  handle.close();
});

describe('users', () => {
  it('inserts and reads back a user', () => {
    handle.db
      .insert(users)
      .values({ id: 'usr_1', apiKeyHash: 'hash1', name: 'Ada', role: 'admin' })
      .run();

    const found = handle.db.select().from(users).where(eq(users.id, 'usr_1')).get();

    expect(found).toBeDefined();
    expect(found?.name).toBe('Ada');
    expect(found?.role).toBe('admin');
  });

  it('defaults role to user and records createdAt', () => {
    const before = Date.now();
    handle.db.insert(users).values({ id: 'usr_2', apiKeyHash: 'hash2', name: 'Bob' }).run();

    const found = handle.db.select().from(users).where(eq(users.id, 'usr_2')).get();

    expect(found?.role).toBe('user');
    expect(found?.createdAt).toBeInstanceOf(Date);
    // The default is applied by the driver, so the read path must interpret
    // the stored unit the same way the write path produced it. A mismatch
    // shows up as a date thousands of years away.
    expect(found!.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(found!.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('rejects a duplicate api_key_hash', () => {
    handle.db.insert(users).values({ id: 'usr_a', apiKeyHash: 'dup', name: 'A' }).run();

    expect(() =>
      handle.db.insert(users).values({ id: 'usr_b', apiKeyHash: 'dup', name: 'B' }).run(),
    ).toThrow();
  });

  it('updates a user name', () => {
    handle.db.insert(users).values({ id: 'usr_3', apiKeyHash: 'hash3', name: 'Old' }).run();

    handle.db.update(users).set({ name: 'New' }).where(eq(users.id, 'usr_3')).run();

    const found = handle.db.select().from(users).where(eq(users.id, 'usr_3')).get();
    expect(found?.name).toBe('New');
  });

  it('deletes a user', () => {
    handle.db.insert(users).values({ id: 'usr_4', apiKeyHash: 'hash4', name: 'Gone' }).run();

    handle.db.delete(users).where(eq(users.id, 'usr_4')).run();

    expect(handle.db.select().from(users).where(eq(users.id, 'usr_4')).get()).toBeUndefined();
  });
});

describe('timestamp units', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'freelatex-timestamps-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stores and reads a timestamp as milliseconds', () => {
    // The schema previously used Drizzle's `timestamp` mode, which *reads* a
    // column as seconds while `defaultNow()` writes milliseconds. The stored
    // value was always milliseconds; only the read was wrong, so the fix
    // changes the interpretation without touching the data.
    const before = Date.now();

    const handle = openDatabase(dir);
    try {
      handle.db
        .insert(users)
        .values({ id: 'usr_ms', apiKeyHash: 'ms-hash', name: 'Ms' })
        .run();

      const raw = handle.sqlite.prepare('SELECT created_at FROM users WHERE id = ?').get('usr_ms');
      const stored = (raw as { created_at: number }).created_at;

      // 13 digits: a millisecond timestamp, not a second one.
      expect(stored).toBeGreaterThan(1_600_000_000_000);
      expect(stored).toBeLessThanOrEqual(Date.now() + 1000);

      const row = handle.db.select().from(users).where(eq(users.id, 'usr_ms')).get();
      expect(row!.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(row!.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    } finally {
      handle.close();
    }
  });

  it('reads a timestamp written by an older build correctly', () => {
    // A database written before the fix holds a millisecond value in the
    // column. Re-opening it must read that value back as the right instant,
    // not as a date thousands of years in the future.
    const legacy = Date.now();

    const first = openDatabase(dir);
    first.sqlite
      .prepare(
        'INSERT INTO users (id, api_key_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('usr_legacy', 'legacy-hash', 'Legacy', 'user', legacy);
    first.close();

    const second = openDatabase(dir);
    try {
      const row = second.db.select().from(users).where(eq(users.id, 'usr_legacy')).get();
      expect(row!.createdAt.getTime()).toBeGreaterThanOrEqual(legacy - 1000);
      expect(row!.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    } finally {
      second.close();
    }
  });
});

describe('projects', () => {
  beforeEach(() => {
    handle.db.insert(users).values({ id: 'owner_1', apiKeyHash: 'h1', name: 'Owner' }).run();
    handle.db
      .insert(users)
      .values({ id: 'owner_2', apiKeyHash: 'h2', name: 'Other' })
      .run();
  });

  it('inserts a project owned by a user', () => {
    handle.db
      .insert(projects)
      .values({ id: 'prj_1', ownerId: 'owner_1', title: 'Thesis' })
      .run();

    const found = handle.db.select().from(projects).where(eq(projects.id, 'prj_1')).get();

    expect(found?.title).toBe('Thesis');
    expect(found?.ownerId).toBe('owner_1');
    expect(found?.mainFile).toBe('main.tex');
  });

  it('scopes projects by owner', () => {
    handle.db.insert(projects).values({ id: 'prj_a', ownerId: 'owner_1', title: 'A' }).run();
    handle.db.insert(projects).values({ id: 'prj_b', ownerId: 'owner_2', title: 'B' }).run();

    const ownedByFirst = handle.db
      .select()
      .from(projects)
      .where(eq(projects.ownerId, 'owner_1'))
      .all();

    expect(ownedByFirst).toHaveLength(1);
    expect(ownedByFirst[0]?.id).toBe('prj_a');
  });

  it('rejects a project for a non-existent owner', () => {
    expect(() =>
      handle.db.insert(projects).values({ id: 'prj_x', ownerId: 'ghost', title: 'X' }).run(),
    ).toThrow();
  });

  it('cascades deletes to projects when the owner is removed', () => {
    handle.db.insert(projects).values({ id: 'prj_c', ownerId: 'owner_1', title: 'C' }).run();

    handle.db.delete(users).where(eq(users.id, 'owner_1')).run();

    expect(handle.db.select().from(projects).where(eq(projects.id, 'prj_c')).get()).toBeUndefined();
  });

  it('updates the timestamp on modification', () => {
    handle.db.insert(projects).values({ id: 'prj_d', ownerId: 'owner_1', title: 'D' }).run();

    handle.db.update(projects).set({ title: 'D2' }).where(eq(projects.id, 'prj_d')).run();

    const found = handle.db.select().from(projects).where(eq(projects.id, 'prj_d')).get();
    expect(found?.title).toBe('D2');
  });
});

describe('shareTokens', () => {
  beforeEach(() => {
    handle.db.insert(users).values({ id: 'owner_1', apiKeyHash: 'h1', name: 'Owner' }).run();
    handle.db.insert(projects).values({ id: 'prj_1', ownerId: 'owner_1', title: 'P' }).run();
  });

  it('creates a share token with a permission', () => {
    handle.db
      .insert(shareTokens)
      .values({
        id: 'shr_1',
        projectId: 'prj_1',
        tokenHash: 'th1',
        permission: 'rw',
        label: 'Reviewer',
      })
      .run();

    const found = handle.db.select().from(shareTokens).where(eq(shareTokens.id, 'shr_1')).get();

    expect(found?.permission).toBe('rw');
    expect(found?.label).toBe('Reviewer');
    expect(found?.expiresAt).toBeNull();
  });

  it('stores an expiry timestamp', () => {
    const expires = new Date('2030-01-01T00:00:00Z');

    handle.db
      .insert(shareTokens)
      .values({ id: 'shr_2', projectId: 'prj_1', tokenHash: 'th2', expiresAt: expires })
      .run();

    const found = handle.db.select().from(shareTokens).where(eq(shareTokens.id, 'shr_2')).get();
    expect(found?.expiresAt?.getTime()).toBe(expires.getTime());
  });

  it('rejects a duplicate token hash', () => {
    handle.db
      .insert(shareTokens)
      .values({ id: 'shr_a', projectId: 'prj_1', tokenHash: 'same' })
      .run();

    expect(() =>
      handle.db
        .insert(shareTokens)
        .values({ id: 'shr_b', projectId: 'prj_1', tokenHash: 'same' })
        .run(),
    ).toThrow();
  });

  it('cascades deletes to share tokens when the project is removed', () => {
    handle.db
      .insert(shareTokens)
      .values({ id: 'shr_c', projectId: 'prj_1', tokenHash: 'thc' })
      .run();

    handle.db.delete(projects).where(eq(projects.id, 'prj_1')).run();

    expect(handle.db.select().from(shareTokens).where(eq(shareTokens.id, 'shr_c')).get()).toBeUndefined();
  });
});

describe('projectSnapshots', () => {
  beforeEach(() => {
    handle.db.insert(users).values({ id: 'owner_1', apiKeyHash: 'h1', name: 'Owner' }).run();
    handle.db.insert(projects).values({ id: 'prj_1', ownerId: 'owner_1', title: 'P' }).run();
  });

  it('stores a snapshot with its payload', () => {
    const payload = JSON.stringify({ 'main.tex': '\\documentclass{article}' });

    handle.db
      .insert(projectSnapshots)
      .values({
        id: 'snp_1',
        projectId: 'prj_1',
        label: 'v1.0',
        snapshotData: payload,
        hash: 'h',
        createdBy: 'owner_1',
      })
      .run();

    const found = handle.db
      .select()
      .from(projectSnapshots)
      .where(eq(projectSnapshots.id, 'snp_1'))
      .get();

    expect(found?.label).toBe('v1.0');
    expect(JSON.parse(found?.snapshotData ?? '{}')).toEqual({
      'main.tex': '\\documentclass{article}',
    });
  });

  it('lists snapshots for a project', () => {
    handle.db
      .insert(projectSnapshots)
      .values({
        id: 'snp_a',
        projectId: 'prj_1',
        label: 'A',
        snapshotData: '{}',
        hash: 'ha',
      })
      .run();
    handle.db
      .insert(projectSnapshots)
      .values({
        id: 'snp_b',
        projectId: 'prj_1',
        label: 'B',
        snapshotData: '{}',
        hash: 'hb',
      })
      .run();

    const list = handle.db
      .select()
      .from(projectSnapshots)
      .where(eq(projectSnapshots.projectId, 'prj_1'))
      .all();

    expect(list).toHaveLength(2);
  });

  it('cascades deletes to snapshots when the project is removed', () => {
    handle.db
      .insert(projectSnapshots)
      .values({
        id: 'snp_c',
        projectId: 'prj_1',
        label: 'C',
        snapshotData: '{}',
        hash: 'hc',
      })
      .run();

    handle.db.delete(projects).where(eq(projects.id, 'prj_1')).run();

    expect(
      handle.db.select().from(projectSnapshots).where(eq(projectSnapshots.id, 'snp_c')).get(),
    ).toBeUndefined();
  });
});
