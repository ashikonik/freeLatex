/**
 * The assistant's settings.
 *
 * The reader brings their own key, so the key is theirs and theirs alone:
 * it is kept in the browser's own storage and never sent to the server
 * except on the request it is needed for.
 */

/** The providers the assistant can talk to. */
export type AiProvider = 'gemini' | 'openai' | 'anthropic';

/** The names of the providers, as a reader knows them. */
export const PROVIDER_NAMES: Record<AiProvider, string> = {
  gemini: 'Google Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

/** The key of the settings in the browser's storage. */
const STORAGE_KEY = 'freelatex.ai';

/**
 * How much of the document is sent to the provider.
 *
 * A whole thesis is more than any provider's context holds and more than the
 * reader wants to pay for, so only the beginning of the document is sent.
 * The reader is told when that happens.
 */
export const MAX_SOURCE_CHARS = 12_000;

/**
 * The beginning of a document, cut to what the provider is given.
 *
 * @param source The whole document.
 * @returns The part of it that is sent.
 */
export function boundSource(source: string): string {
  return source.length > MAX_SOURCE_CHARS ? source.slice(0, MAX_SOURCE_CHARS) : source;
}

/** The assistant's settings. */
export interface AiSettings {
  /** The provider the assistant talks to. */
  provider: AiProvider;
  /** The reader's key for that provider. */
  apiKey: string;
}

/**
 * Read the settings from the browser's storage.
 *
 * A browser that will not let the page read its storage — a private window,
 * a locked-down setting — is treated as having no settings.
 */
export function readAiSettings(): AiSettings | undefined {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    if (parsed.provider !== 'gemini' && parsed.provider !== 'openai' && parsed.provider !== 'anthropic') {
      return undefined;
    }
    return {
      provider: parsed.provider,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
    };
  } catch {
    return undefined;
  }
}

/**
 * Write the settings to the browser's storage.
 *
 * @param settings The settings to keep.
 */
export function storeAiSettings(settings: AiSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // A browser that will not let the page write its storage simply does
    // not remember the settings; the assistant still works for this session.
  }
}

/** Forget the settings. */
export function clearAiSettings(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to forget if the storage cannot be reached.
  }
}
