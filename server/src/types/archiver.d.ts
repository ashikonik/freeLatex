/**
 * Local type declarations for `archiver` v8.
 *
 * The published `@types/archiver` package still describes the v5 CommonJS API
 * (`archiver('zip')`), while v8 is ESM with named class exports and ships no
 * types of its own. Only the surface this project uses is declared here.
 */
declare module 'archiver' {
  import type { Readable, Writable } from 'node:stream';

  export interface ArchiverOptions {
    zlib?: { level?: number };
    /** Alias for zlib.level, kept for API compatibility. */
    compression?: number;
  }

  export interface AppendOptions {
    name: string;
    date?: Date;
    mode?: number;
    prefix?: string;
  }

  export interface GlobOptions {
    cwd?: string;
    prefix?: string;
    dot?: boolean;
    nodir?: boolean;
    ignore?: string | string[];
  }

  export class Archiver extends Readable {
    constructor(options?: ArchiverOptions);
    append(source: string | Buffer | Readable, options: AppendOptions): this;
    file(filepath: string, options: AppendOptions): this;
    directory(dirpath: string, destpath: string | false): this;
    glob(pattern: string, options?: GlobOptions): this;
    pointer(): number;
    finalize(): Promise<void>;
    pipe<T extends Writable>(destination: T, options?: { end?: boolean }): T;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'warning', listener: (error: Error) => void): this;
    on(event: string, listener: (...args: never[]) => void): this;
  }

  export class ZipArchive extends Archiver {}
  export class TarArchive extends Archiver {}
  export class JsonArchive extends Archiver {}
}
