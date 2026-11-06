import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { ProjectStorage } from './storage.js';
import { isWithinRoot, resolveWithin } from './paths.js';

let root: string;
let storage: ProjectStorage;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'freelatex-storage-'));
  storage = new ProjectStorage(join(root, 'projects'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * CRC-32 (IEEE 802.3), used by the zip entry format.
 */
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a zip archive byte-for-byte from a map of entry name -> content.
 *
 * The archive is assembled by hand rather than with `archiver` because
 * `archiver` sanitises entry names: it rewrites `../evil.tex` to
 * `evil.tex`. A hand-built archive keeps the raw name, which is what a
 * malicious upload would actually contain — and therefore what the import
 * path has to defend against.
 */
function makeZip(entries: Record<string, string>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const dataBuffer = Buffer.from(content, 'utf8');
    const crc = crc32(dataBuffer);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBuffer.length, 18); // compressed size
    localHeader.writeUInt32LE(dataBuffer.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(localHeader, nameBuffer, dataBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central directory signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBuffer.length, 20);
    centralHeader.writeUInt32LE(dataBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt32LE(offset, 42); // offset of local header
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + dataBuffer.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  endRecord.writeUInt16LE(Object.keys(entries).length, 8);
  endRecord.writeUInt16LE(Object.keys(entries).length, 10);
  endRecord.writeUInt32LE(centralBuffer.length, 12);
  endRecord.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralBuffer, endRecord]);
}

describe('resolveWithin', () => {
  const base = '/data/projects/prj_1';

  it('resolves a plain relative path', () => {
    expect(resolveWithin(base, 'main.tex')).toBe('/data/projects/prj_1/main.tex');
  });

  it('resolves a nested path', () => {
    expect(resolveWithin(base, 'chapters/intro.tex')).toBe(
      '/data/projects/prj_1/chapters/intro.tex',
    );
  });

  it('rejects a parent-directory escape', () => {
    expect(() => resolveWithin(base, '../other.tex')).toThrow(/escapes/);
  });

  it('rejects a deep parent-directory escape', () => {
    expect(() => resolveWithin(base, '../../etc/passwd')).toThrow(/escapes/);
  });

  it('rejects an absolute path', () => {
    expect(() => resolveWithin(base, '/etc/passwd')).toThrow(/must be relative/);
  });

  it('rejects a null byte', () => {
    expect(() => resolveWithin(base, 'main.tex\0.png')).toThrow(/null byte/);
  });

  it('rejects a sibling directory with a shared prefix', () => {
    expect(() => resolveWithin(base, '../prj_1_evil/x.tex')).toThrow(/escapes/);
  });

  it('allows a path that walks down and back but stays inside', () => {
    expect(resolveWithin(base, 'a/../b.tex')).toBe('/data/projects/prj_1/b.tex');
  });

  it('isWithinRoot mirrors resolveWithin', () => {
    expect(isWithinRoot(base, 'main.tex')).toBe(true);
    expect(isWithinRoot(base, '../escape.tex')).toBe(false);
  });
});

describe('ProjectStorage', () => {
  it('creates a project with a starter main.tex', async () => {
    await storage.createProject('prj_1');

    const content = await storage.readProjectFile('prj_1', 'main.tex');
    expect(content).toContain('\\documentclass');
    expect(content).toContain('\\begin{document}');
  });

  it('lists files in a project', async () => {
    await storage.createProject('prj_1');
    await storage.writeProjectFile('prj_1', 'chapter.tex', 'hello');
    await storage.writeProjectFile('prj_1', 'sub/other.tex', 'world');

    const files = await storage.listProjectFiles('prj_1');
    const paths = files.filter((f) => f.type === 'file').map((f) => f.path);

    expect(paths).toContain('main.tex');
    expect(paths).toContain('chapter.tex');
    expect(paths).toContain('sub/other.tex');
  });

  it('builds a nested file tree', async () => {
    await storage.createProject('prj_1');
    await storage.writeProjectFile('prj_1', 'sub/other.tex', 'world');

    const tree = await storage.buildFileTree('prj_1');
    const sub = tree.find((node) => node.name === 'sub');

    expect(sub).toBeDefined();
    expect(sub?.type).toBe('directory');
    expect(sub?.children?.map((c) => c.name)).toContain('other.tex');
  });

  it('reads and writes a file', async () => {
    await storage.createProject('prj_1');
    await storage.writeProjectFile('prj_1', 'notes.md', '# Notes');

    expect(await storage.readProjectFile('prj_1', 'notes.md')).toBe('# Notes');
  });

  it('creates parent directories on write', async () => {
    await storage.createProject('prj_1');
    await storage.writeProjectFile('prj_1', 'a/b/c/deep.tex', 'deep');

    expect(await storage.readProjectFile('prj_1', 'a/b/c/deep.tex')).toBe('deep');
  });

  it('deletes a file', async () => {
    await storage.createProject('prj_1');
    await storage.writeProjectFile('prj_1', 'temp.tex', 'x');
    await storage.deleteProjectFile('prj_1', 'temp.tex');

    expect(await storage.exists('prj_1', 'temp.tex')).toBe(false);
  });

  it('refuses to read outside the project directory', async () => {
    await storage.createProject('prj_1');

    await expect(storage.readProjectFile('prj_1', '../../etc/passwd')).rejects.toThrow(
      /escapes/,
    );
  });

  it('refuses to write outside the project directory', async () => {
    await storage.createProject('prj_1');

    await expect(storage.writeProjectFile('prj_1', '../evil.tex', 'x')).rejects.toThrow(
      /escapes/,
    );
  });

  it('refuses to delete outside the project directory', async () => {
    await storage.createProject('prj_1');

    await expect(storage.deleteProjectFile('prj_1', '../evil.tex')).rejects.toThrow(/escapes/);
  });

  it('reads all files for a snapshot', async () => {
    await storage.createProject('prj_1');
    await storage.writeProjectFile('prj_1', 'a.tex', 'A');

    const all = await storage.readAllFiles('prj_1');

    expect(all['a.tex']).toBe('A');
    expect(Object.keys(all)).toContain('main.tex');
  });

  it('writes all files at once', async () => {
    await storage.createProject('prj_1');
    await storage.writeAllFiles('prj_1', { 'x.tex': 'X', 'deep/y.tex': 'Y' });

    expect(await storage.readProjectFile('prj_1', 'x.tex')).toBe('X');
    expect(await storage.readProjectFile('prj_1', 'deep/y.tex')).toBe('Y');
  });

  it('deletes a project directory', async () => {
    await storage.createProject('prj_1');
    await storage.deleteProject('prj_1');

    expect(await storage.exists('prj_1', 'main.tex')).toBe(false);
  });
});

describe('zip export and import', () => {
  it('exports a project as a zip', async () => {
    await storage.createProject('prj_1');
    await storage.writeProjectFile('prj_1', 'chapter.tex', 'chapter content');

    const pass = new PassThrough();
    const chunks: Buffer[] = [];
    pass.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve) => pass.on('end', resolve));

    await storage.exportZip('prj_1', pass);
    await done;

    const buffer = Buffer.concat(chunks);
    expect(buffer.length).toBeGreaterThan(0);
    // A zip archive starts with the local file header signature "PK\x03\x04".
    expect(buffer.subarray(0, 4).toString('hex')).toBe('504b0304');
  });

  it('round-trips a project through export and import', async () => {
    await storage.createProject('prj_1');
    await storage.writeProjectFile('prj_1', 'main.tex', 'the main file');
    await storage.writeProjectFile('prj_1', 'chapters/one.tex', 'chapter one');

    const pass = new PassThrough();
    const chunks: Buffer[] = [];
    pass.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve) => pass.on('end', resolve));
    await storage.exportZip('prj_1', pass);
    await done;

    const result = await storage.importZip('prj_2', Buffer.concat(chunks));

    expect(result.files).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(await storage.readProjectFile('prj_2', 'main.tex')).toBe('the main file');
    expect(await storage.readProjectFile('prj_2', 'chapters/one.tex')).toBe('chapter one');
  });

  it('skips archive entries that try to escape the project directory', async () => {
    const zip = makeZip({
      'good.tex': 'safe content',
      '../evil.tex': 'malicious content',
    });

    const result = await storage.importZip('prj_1', zip);

    expect(result.files).toBe(1);
    expect(result.skipped).toContain('../evil.tex');
    expect(await storage.exists('prj_1', 'good.tex')).toBe(true);
  });

  it('does not write an escaped file to the parent directory', async () => {
    const zip = makeZip({ '../escaped.tex': 'malicious' });

    await storage.importZip('prj_1', zip);

    const escaped = join(root, 'projects', 'escaped.tex');
    await expect(readFile(escaped, 'utf8')).rejects.toThrow();
  });

  it('skips absolute paths inside an archive', async () => {
    const zip = makeZip({ '/tmp/absolute.tex': 'nope' });

    const result = await storage.importZip('prj_1', zip);

    expect(result.files).toBe(0);
    expect(result.skipped).toHaveLength(1);
  });

  it('rejects a buffer that is not a zip archive', async () => {
    await expect(storage.importZip('prj_1', Buffer.from('not a zip'))).rejects.toThrow();
  });

  it('never writes outside the project when a symlink is planted inside it', async () => {
    const outside = join(root, 'outside');
    await mkdir(outside, { recursive: true });

    const { symlink } = await import('node:fs/promises');
    await storage.createProject('prj_1');
    await symlink(outside, join(root, 'projects', 'prj_1', 'link'));

    // The entry is lexically inside the project, but `link` points out of it.
    // Creating the parent directory before the realpath check would create
    // `outside/sub` on disk even though the file itself is rejected.
    const zip = makeZip({ 'link/sub/file.tex': 'content' });

    await storage.importZip('prj_1', zip);

    // Nothing may be created outside the project directory.
    await expect(stat(join(outside, 'sub'))).rejects.toThrow();
    await expect(stat(join(outside, 'sub', 'file.tex'))).rejects.toThrow();
  });

  it('leaves no project directory behind when an import fails', async () => {
    await expect(storage.importZip('prj_1', Buffer.from('not a zip'))).rejects.toThrow();

    // The failed import must not leave a half-populated project directory.
    await expect(stat(join(root, 'projects', 'prj_1'))).rejects.toThrow();
    await expect(stat(join(root, 'projects', 'prj_1.importing'))).rejects.toThrow();
  });
});

describe('path safety at the project level', () => {
  it('keeps two projects isolated', async () => {
    await storage.createProject('prj_1');
    await storage.createProject('prj_2');
    await storage.writeProjectFile('prj_1', 'only-here.tex', 'secret');

    expect(await storage.exists('prj_2', 'only-here.tex')).toBe(false);
  });

  it('refuses a project id that is not a plain identifier', async () => {
    // The project id becomes a directory name, so it must not be able to
    // place the project outside the storage root.
    await expect(storage.createProject('../evil')).rejects.toThrow(/not a valid identifier/);
    await expect(storage.writeProjectFile('../evil', 'a.tex', 'x')).rejects.toThrow(
      /not a valid identifier/,
    );
    await expect(storage.readProjectFile('prj/../../evil', 'a.tex')).rejects.toThrow(
      /not a valid identifier/,
    );
  });

  it('does not follow a symlink planted in the project directory', async () => {
    await storage.createProject('prj_1');
    const outside = join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'secret data');

    const { symlink } = await import('node:fs/promises');
    await symlink(outside, join(root, 'projects', 'prj_1', 'link'));

    // Reading through the symlink must fail rather than escape the project.
    await expect(storage.readProjectFile('prj_1', 'link/secret.txt')).rejects.toThrow();
  });
});
