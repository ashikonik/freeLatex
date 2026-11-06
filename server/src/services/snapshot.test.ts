import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

import { openDatabase, type DbHandle } from '../db/index.js';
import { projects, projectSnapshots, users } from '../db/schema.js';
import { hashSecret } from '../utils/hash.js';
import { ProjectStorage } from './storage.js';
import { SnapshotService } from './snapshot.js';

let root: string;
let handle: DbHandle;
let storage: ProjectStorage;
let snapshots: SnapshotService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'freelatex-snapshot-'));
  handle = openDatabase(':memory:', ':memory:');

  handle.db
    .insert(users)
    .values({ id: 'owner', apiKeyHash: hashSecret('owner-key'), name: 'Owner' })
    .run();
  handle.db
    .insert(projects)
    .values({ id: 'prj_1', ownerId: 'owner', title: 'Thesis' })
    .run();

  storage = new ProjectStorage(join(root, 'projects'));
  await storage.createProject('prj_1');
  snapshots = new SnapshotService(handle.db, storage);
});

afterEach(async () => {
  handle.close();
  await rm(root, { recursive: true, force: true });
});

describe('createSnapshot', () => {
  it('captures the current project files', async () => {
    await storage.writeProjectFile('prj_1', 'main.tex', 'hello');
    await storage.writeProjectFile('prj_1', 'chapters/one.tex', 'world');

    const summary = await snapshots.createSnapshot('prj_1', 'First cut', 'owner');

    expect(summary.label).toBe('First cut');
    expect(summary.projectId).toBe('prj_1');
    expect(summary.createdBy).toBe('owner');
    expect(summary.fileCount).toBe(2);
    expect(summary.id).toMatch(/^snap_/);
  });

  it('falls back to a generated label', async () => {
    const summary = await snapshots.createSnapshot('prj_1', '   ', 'owner');

    expect(summary.label).not.toBe('');
    expect(summary.label).toContain('Snapshot');
  });

  it('produces the same hash for identical content', async () => {
    await storage.writeProjectFile('prj_1', 'main.tex', 'same');

    const first = await snapshots.createSnapshot('prj_1', 'A', 'owner');
    const second = await snapshots.createSnapshot('prj_1', 'B', 'owner');

    expect(second.hash).toBe(first.hash);
  });

  it('produces a different hash when content changes', async () => {
    await storage.writeProjectFile('prj_1', 'main.tex', 'one');
    const first = await snapshots.createSnapshot('prj_1', 'A', 'owner');

    await storage.writeProjectFile('prj_1', 'main.tex', 'two');
    const second = await snapshots.createSnapshot('prj_1', 'B', 'owner');

    expect(second.hash).not.toBe(first.hash);
  });
});

describe('listSnapshots', () => {
  it('returns the revision history newest first', async () => {
    await snapshots.createSnapshot('prj_1', 'First', 'owner');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await snapshots.createSnapshot('prj_1', 'Second', 'owner');

    const history = snapshots.listSnapshots('prj_1');

    expect(history).toHaveLength(2);
    expect(history[0]?.label).toBe('Second');
    expect(history[1]?.label).toBe('First');
  });

  it('does not leak snapshots from another project', async () => {
    handle.db
      .insert(projects)
      .values({ id: 'prj_2', ownerId: 'owner', title: 'Other' })
      .run();
    await storage.createProject('prj_2');
    await snapshots.createSnapshot('prj_2', 'Other snapshot', 'owner');

    expect(snapshots.listSnapshots('prj_1')).toHaveLength(0);
  });

  it('keeps the history bounded by dropping the oldest revisions', async () => {
    // Every snapshot duplicates the whole project, so an unbounded history
    // would fill the database.
    for (let index = 0; index < 105; index += 1) {
      await snapshots.createSnapshot('prj_1', `Snapshot ${index}`, 'owner');
    }

    const history = snapshots.listSnapshots('prj_1');

    expect(history).toHaveLength(100);
    // The newest revisions are the ones that are kept.
    expect(history[0]?.label).toBe('Snapshot 104');
  });
});

describe('getSnapshot', () => {
  it('returns the snapshot file contents', async () => {
    await storage.writeProjectFile('prj_1', 'main.tex', 'the content');
    const created = await snapshots.createSnapshot('prj_1', 'A', 'owner');

    const snapshot = snapshots.getSnapshot('prj_1', created.id);

    expect(snapshot.files.text['main.tex']).toBe('the content');
    expect(snapshot.summary.id).toBe(created.id);
  });

  it('refuses a snapshot from another project', async () => {
    handle.db
      .insert(projects)
      .values({ id: 'prj_2', ownerId: 'owner', title: 'Other' })
      .run();
    await storage.createProject('prj_2');
    const created = await snapshots.createSnapshot('prj_2', 'Other', 'owner');

    expect(() => snapshots.getSnapshot('prj_1', created.id)).toThrow(/not found/i);
  });

  it('throws for an unknown snapshot', () => {
    expect(() => snapshots.getSnapshot('prj_1', 'snap_missing')).toThrow(/not found/i);
  });
});

describe('computeDiff', () => {
  it('shows an added line', async () => {
    await storage.writeProjectFile('prj_1', 'main.tex', 'line one\n');
    const before = await snapshots.createSnapshot('prj_1', 'Before', 'owner');

    await storage.writeProjectFile('prj_1', 'main.tex', 'line one\nline two\n');
    const after = await snapshots.createSnapshot('prj_1', 'After', 'owner');

    const diffs = snapshots.computeDiff('prj_1', before.id, after.id);

    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.path).toBe('main.tex');
    expect(diffs[0]?.changeType).toBe('modified');
    expect(diffs[0]?.patch).toContain('+line two');
    expect(diffs[0]?.addedLines).toBe(1);
    expect(diffs[0]?.removedLines).toBe(0);
  });

  it('shows a removed line', async () => {
    await storage.writeProjectFile('prj_1', 'main.tex', 'keep\nremove\n');
    const before = await snapshots.createSnapshot('prj_1', 'Before', 'owner');

    await storage.writeProjectFile('prj_1', 'main.tex', 'keep\n');
    const after = await snapshots.createSnapshot('prj_1', 'After', 'owner');

    const diffs = snapshots.computeDiff('prj_1', before.id, after.id);

    expect(diffs[0]?.removedLines).toBe(1);
    expect(diffs[0]?.addedLines).toBe(0);
    expect(diffs[0]?.patch).toContain('-remove');
  });

  it('reports an added file', async () => {
    const before = await snapshots.createSnapshot('prj_1', 'Before', 'owner');

    await storage.writeProjectFile('prj_1', 'new.tex', 'brand new');
    const after = await snapshots.createSnapshot('prj_1', 'After', 'owner');

    const diffs = snapshots.computeDiff('prj_1', before.id, after.id);

    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.changeType).toBe('added');
    expect(diffs[0]?.path).toBe('new.tex');
    expect(diffs[0]?.addedLines).toBe(1);
    expect(diffs[0]?.removedLines).toBe(0);
  });

  it('reports a removed file', async () => {
    await storage.writeProjectFile('prj_1', 'gone.tex', 'temporary');
    const before = await snapshots.createSnapshot('prj_1', 'Before', 'owner');

    await storage.deleteProjectFile('prj_1', 'gone.tex');
    const after = await snapshots.createSnapshot('prj_1', 'After', 'owner');

    const diffs = snapshots.computeDiff('prj_1', before.id, after.id);

    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.changeType).toBe('removed');
  });

  it('is empty when nothing changed', async () => {
    await storage.writeProjectFile('prj_1', 'main.tex', 'identical');
    const before = await snapshots.createSnapshot('prj_1', 'Before', 'owner');
    const after = await snapshots.createSnapshot('prj_1', 'After', 'owner');

    expect(snapshots.computeDiff('prj_1', before.id, after.id)).toEqual([]);
  });

  it('is empty when diffing a snapshot against itself', async () => {
    await storage.writeProjectFile('prj_1', 'main.tex', 'identical');
    const snapshot = await snapshots.createSnapshot('prj_1', 'Only', 'owner');

    expect(snapshots.computeDiff('prj_1', snapshot.id, snapshot.id)).toEqual([]);
  });
});

describe('rollbackToSnapshot', () => {
  it('restores the original file contents', async () => {
    await storage.writeProjectFile('prj_1', 'main.tex', 'original');
    const snapshot = await snapshots.createSnapshot('prj_1', 'Good', 'owner');

    await storage.writeProjectFile('prj_1', 'main.tex', 'mangled');
    await storage.writeProjectFile('prj_1', 'extra.tex', 'added later');

    const fileCount = await snapshots.rollbackToSnapshot('prj_1', snapshot.id);

    expect(fileCount).toBe(1);
    expect(await storage.readProjectFile('prj_1', 'main.tex')).toBe('original');
  });

  it('removes files that did not exist in the snapshot', async () => {
    const snapshot = await snapshots.createSnapshot('prj_1', 'Before', 'owner');

    await storage.writeProjectFile('prj_1', 'extra.tex', 'added later');
    await snapshots.rollbackToSnapshot('prj_1', snapshot.id);

    expect(await storage.exists('prj_1', 'extra.tex')).toBe(false);
  });

  it('refuses a snapshot from another project', async () => {
    handle.db
      .insert(projects)
      .values({ id: 'prj_2', ownerId: 'owner', title: 'Other' })
      .run();
    await storage.createProject('prj_2');
    const created = await snapshots.createSnapshot('prj_2', 'Other', 'owner');

    await expect(snapshots.rollbackToSnapshot('prj_1', created.id)).rejects.toThrow(
      /not found/i,
    );
  });
});

describe('binary files', () => {
  it('keeps a binary file byte-for-byte through a snapshot and rollback', async () => {
    // A PNG header: invalid UTF-8, so a naive text snapshot would corrupt it.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
    await writeFile(join(root, 'projects', 'prj_1', 'image.png'), png);

    const created = await snapshots.createSnapshot('prj_1', 'With image', 'owner');

    const snapshot = snapshots.getSnapshot('prj_1', created.id);
    expect(snapshot.files.binary['image.png']).toBe(png.toString('base64'));

    await writeFile(join(root, 'projects', 'prj_1', 'image.png'), Buffer.from([0x00]));
    await snapshots.rollbackToSnapshot('prj_1', created.id);

    expect(await readFile(join(root, 'projects', 'prj_1', 'image.png'))).toEqual(png);
  });

  it('reports a changed binary file without a line diff', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    await writeFile(join(root, 'projects', 'prj_1', 'image.png'), png);
    const before = await snapshots.createSnapshot('prj_1', 'Before', 'owner');

    await writeFile(join(root, 'projects', 'prj_1', 'image.png'), Buffer.from([0x89, 0x50, 0x00]));
    const after = await snapshots.createSnapshot('prj_1', 'After', 'owner');

    const diffs = snapshots.computeDiff('prj_1', before.id, after.id);

    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.path).toBe('image.png');
    expect(diffs[0]?.changeType).toBe('modified');
    expect(diffs[0]?.patch).toContain('Binary files');
  });

  it('reports an added binary file', async () => {
    const before = await snapshots.createSnapshot('prj_1', 'Before', 'owner');

    await writeFile(
      join(root, 'projects', 'prj_1', 'image.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
    );
    const after = await snapshots.createSnapshot('prj_1', 'After', 'owner');

    const diffs = snapshots.computeDiff('prj_1', before.id, after.id);

    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.changeType).toBe('added');
    // The patch must not be empty: an empty patch reads as "no change".
    expect(diffs[0]?.patch).toContain('image.png');
  });

  it('reports a removed binary file', async () => {
    await writeFile(
      join(root, 'projects', 'prj_1', 'image.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
    );
    const before = await snapshots.createSnapshot('prj_1', 'Before', 'owner');

    await rm(join(root, 'projects', 'prj_1', 'image.png'));
    const after = await snapshots.createSnapshot('prj_1', 'After', 'owner');

    const diffs = snapshots.computeDiff('prj_1', before.id, after.id);

    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.changeType).toBe('removed');
    expect(diffs[0]?.patch).toContain('image.png');
  });
});

describe('diff line counts', () => {
  it('counts a content line that looks like a diff header', async () => {
    // The rendered patch contains "++++hello". A patch-text scan would mistake
    // it for a file header and drop the line.
    await storage.writeProjectFile('prj_1', 'main.tex', '+++hello\n');
    const before = await snapshots.createSnapshot('prj_1', 'Before', 'owner');

    await storage.writeProjectFile('prj_1', 'main.tex', '');
    const after = await snapshots.createSnapshot('prj_1', 'After', 'owner');

    const diffs = snapshots.computeDiff('prj_1', before.id, after.id);

    expect(diffs[0]?.removedLines).toBe(1);
  });

  it('counts an added content line that looks like a diff header', async () => {
    await storage.writeProjectFile('prj_1', 'main.tex', '');
    const before = await snapshots.createSnapshot('prj_1', 'Before', 'owner');

    await storage.writeProjectFile('prj_1', 'main.tex', '+++hello\n');
    const after = await snapshots.createSnapshot('prj_1', 'After', 'owner');

    const diffs = snapshots.computeDiff('prj_1', before.id, after.id);

    expect(diffs[0]?.addedLines).toBe(1);
  });

  it('does not count the missing-newline marker as a change', async () => {
    // "x" (no trailing newline) becomes "x\ny". The rendered patch is
    // "-x / +x / +y" plus two "\ No newline at end of file" markers, so the
    // counts must be 2 added and 1 removed — the markers themselves are not
    // content changes.
    await storage.writeProjectFile('prj_1', 'main.tex', 'x');
    const before = await snapshots.createSnapshot('prj_1', 'Before', 'owner');

    await storage.writeProjectFile('prj_1', 'main.tex', 'x\ny');
    const after = await snapshots.createSnapshot('prj_1', 'After', 'owner');

    const diffs = snapshots.computeDiff('prj_1', before.id, after.id);

    expect(diffs[0]?.addedLines).toBe(2);
    expect(diffs[0]?.removedLines).toBe(1);
  });
});

describe('corrupt snapshots', () => {
  it('refuses to roll back a corrupt snapshot instead of emptying the project', async () => {
    await storage.writeProjectFile('prj_1', 'main.tex', 'important');
    const created = await snapshots.createSnapshot('prj_1', 'Good', 'owner');

    // Corrupt the stored payload directly.
    handle.db
      .update(projectSnapshots)
      .set({ snapshotData: '{not json' })
      .where(eq(projectSnapshots.id, created.id))
      .run();

    await expect(snapshots.rollbackToSnapshot('prj_1', created.id)).rejects.toThrow(/corrupt/i);

    // The project must be untouched.
    expect(await storage.readProjectFile('prj_1', 'main.tex')).toBe('important');
  });

  it('refuses to roll back a snapshot whose payload is an empty object', async () => {
    await storage.writeProjectFile('prj_1', 'main.tex', 'important');
    const created = await snapshots.createSnapshot('prj_1', 'Good', 'owner');

    // An empty payload parses as valid JSON but carries no file map. Restoring
    // it would delete every file in the project.
    handle.db
      .update(projectSnapshots)
      .set({ snapshotData: '{}' })
      .where(eq(projectSnapshots.id, created.id))
      .run();

    await expect(snapshots.rollbackToSnapshot('prj_1', created.id)).rejects.toThrow(/corrupt/i);
    expect(await storage.readProjectFile('prj_1', 'main.tex')).toBe('important');
  });

  it('refuses to roll back a snapshot in the old flat payload format', async () => {
    await storage.writeProjectFile('prj_1', 'main.tex', 'important');
    const created = await snapshots.createSnapshot('prj_1', 'Good', 'owner');

    // The format before the two-map layout: a flat path -> content map. It
    // parses as valid JSON but is not a snapshot payload.
    handle.db
      .update(projectSnapshots)
      .set({ snapshotData: JSON.stringify({ 'main.tex': 'old' }) })
      .where(eq(projectSnapshots.id, created.id))
      .run();

    await expect(snapshots.rollbackToSnapshot('prj_1', created.id)).rejects.toThrow(/corrupt/i);
    expect(await storage.readProjectFile('prj_1', 'main.tex')).toBe('important');
  });

  it('still lists a corrupt snapshot in the history', async () => {
    const created = await snapshots.createSnapshot('prj_1', 'Good', 'owner');
    handle.db
      .update(projectSnapshots)
      .set({ snapshotData: '{not json' })
      .where(eq(projectSnapshots.id, created.id))
      .run();

    const history = snapshots.listSnapshots('prj_1');

    expect(history).toHaveLength(1);
    expect(history[0]?.fileCount).toBe(0);
  });
});
