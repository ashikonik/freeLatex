import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

loadDotenv();

export type AuthMode = 'single' | 'multi';

export interface Env {
  readonly adminApiKey: string;
  readonly authMode: AuthMode;
  readonly port: number;
  readonly host: string;
  readonly dataDir: string;
  readonly compileTimeoutMs: number;
  readonly nodeEnv: string;
  /**
   * The directory holding the client's built files.
   *
   * When it is set, the server serves the client itself, so that a single
   * process is the whole application. When it is empty — the case in
   * development, where Vite serves the client and proxies the API — the
   * server answers the API alone.
   */
  readonly staticDir: string;
  /**
   * The origin allowed to call the API from a browser, if any.
   *
   * A deployment that serves the client itself needs no cross-origin access
   * at all: the browser talks to one origin. This is empty by default, so a
   * site cannot read the API's answers on the user's behalf. It is set only
   * when the client is served from somewhere else — a separate frontend
   * deployment, or the Vite dev server.
   */
  readonly corsOrigin: string;
}

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

const DEFAULT_PORT = 3030;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_COMPILE_TIMEOUT_MS = 30_000;

/**
 * Read a positive integer from a raw env string.
 * Throws EnvError when the value is present but not a valid positive integer.
 */
function readPositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new EnvError(`${name} must be a positive integer, received "${raw}"`);
  }
  return parsed;
}

/**
 * Build the validated environment from a raw key/value source.
 * Throws EnvError with an actionable message when required values are missing
 * or malformed, so a misconfigured deployment fails at boot rather than at first request.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const adminApiKey = source.ADMIN_API_KEY?.trim();
  if (!adminApiKey) {
    throw new EnvError(
      'ADMIN_API_KEY is required. Set it in the environment or in server/.env (see server/.env.example).',
    );
  }

  const rawAuthMode = source.AUTH_MODE?.trim() ?? 'single';
  if (rawAuthMode !== 'single' && rawAuthMode !== 'multi') {
    throw new EnvError(`AUTH_MODE must be "single" or "multi", received "${rawAuthMode}"`);
  }

  return {
    adminApiKey,
    authMode: rawAuthMode,
    port: readPositiveInt(source.PORT, DEFAULT_PORT, 'PORT'),
    host: source.HOST?.trim() || DEFAULT_HOST,
    dataDir: resolve(source.DATA_DIR?.trim() || 'data'),
    compileTimeoutMs: readPositiveInt(
      source.COMPILE_TIMEOUT_MS,
      DEFAULT_COMPILE_TIMEOUT_MS,
      'COMPILE_TIMEOUT_MS',
    ),
    nodeEnv: source.NODE_ENV?.trim() || 'development',
    staticDir: source.STATIC_DIR?.trim() ? resolve(source.STATIC_DIR.trim()) : '',
    corsOrigin: source.CORS_ORIGIN?.trim() || '',
  };
}

/** Lazily-loaded singleton so importing this module never throws at import time. */
let cached: Env | undefined;

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Reset the cached env. Used by tests to swap configuration between cases. */
export function resetEnv(): void {
  cached = undefined;
}
