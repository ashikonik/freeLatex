import type { FastifyInstance } from 'fastify';
/** The providers the assistant can talk to. */
export type AiProvider = 'gemini' | 'openai' | 'anthropic';

/** A request for the assistant. */
export interface AiRequestBody {
  /** The provider to talk to. */
  provider: AiProvider;
  /** The prompt to send. */
  prompt: string;
  /** The source the prompt is about, for the error-fixing assistant. */
  source?: string;
  /** The compiler errors the assistant is asked to fix. */
  errors?: string[];
}

/** How long an AI request may take. */
const AI_TIMEOUT_MS = 120_000;

/**
 * The header the provider's key travels in.
 *
 * The `Authorization` header already carries the reader's workspace key,
 * which the authentication reads before the route is reached. The provider's
 * key therefore gets a header of its own.
 */
export const PROVIDER_KEY_HEADER = 'x-provider-key';

/**
 * The endpoints of the providers.
 *
 * The server forwards the request to the provider and returns the answer.
 * The API key is the user's own and travels in the request, never in the
 * server's own configuration.
 */
const ENDPOINTS: Record<AiProvider, string> = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
  openai: 'https://api.openai.com/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
};

/**
 * The prompt that frames the request.
 *
 * The assistant is asked for LaTeX, so the answer is asked for in LaTeX too,
 * and the answer is asked for on its own, without a preamble.
 */
const SYSTEM_PROMPT = [
  'You are a LaTeX writing assistant for an academic writer.',
  'Answer with LaTeX that can be pasted straight into the document.',
  'Do not wrap the answer in a Markdown code fence.',
  'Keep the answer as short as the question allows.',
].join(' ');

/**
 * AI routes: a thin proxy to the model providers.
 *
 * The server exists here so that the browser does not have to deal with the
 * providers' differing shapes, and so that the provider's key never has to
 * be handed to the server's own storage: it travels with the request and is
 * used once.
 */
export async function aiRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Send a prompt to a provider.
   *
   * The provider's key travels in its own header, so a key that is meant for
   * OpenAI is never sent to Anthropic, and so the workspace's own key can
   * keep the `Authorization` header for the authentication.
   */
  app.post('/api/ai/complete', async (request, reply) => {
    const identity = request.identity;
    if (!identity) {
      return reply.status(401).send({ error: 'Not authenticated.' });
    }
    // A share token opens a document to somebody who has no account of
    // their own, so it is not enough to spend the reader's key on a paid
    // provider. Only a signed-in account may use the assistant.
    if (identity.kind === 'share') {
      return reply.status(403).send({
        error: 'The assistant is not available to a shared link.',
      });
    }

    const body = (request.body ?? {}) as AiRequestBody;
    const provider = body.provider;
    if (provider !== 'gemini' && provider !== 'openai' && provider !== 'anthropic') {
      return reply.status(400).send({ error: 'provider must be gemini, openai or anthropic.' });
    }

    const prompt = body.prompt?.trim();
    if (!prompt) {
      return reply.status(400).send({ error: 'prompt is required.' });
    }

    // The provider's key is the one the reader brought, so it is read from
    // the header rather than from the server's own configuration.
    const key = readProviderKey(headerValue(request.headers[PROVIDER_KEY_HEADER]));
    if (!key) {
      return reply.status(400).send({
        error: `No API key for ${provider}. Add one in the assistant's settings.`,
      });
    }

    const fullPrompt = buildPrompt(prompt, body.source, body.errors);

    let upstream: Response;
    try {
      upstream = await fetch(ENDPOINTS[provider], {
        method: 'POST',
        headers: providerHeaders(provider, key),
        body: JSON.stringify(providerBody(provider, fullPrompt)),
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      });
    } catch (cause) {
      // A provider that cannot be reached is not the server's failure, so
      // the reader is told what happened instead of seeing a 500.
      return reply.status(502).send({
        error:
          cause instanceof Error && cause.name === 'TimeoutError'
            ? 'The assistant did not answer in time.'
            : 'The assistant could not be reached.',
      });
    }

    const raw = await upstream.text();
    if (!upstream.ok) {
      // The provider's own message says what went wrong with the key or the
      // request, but the raw body can echo a fragment of the key back. Only
      // the message the provider wrote is passed on.
      return reply.status(upstream.status).send({
        error: `The assistant answered with an error: ${providerError(raw)}`,
      });
    }

    const text = extractText(provider, raw);
    if (!text) {
      return reply.status(502).send({ error: 'The assistant returned an empty answer.' });
    }

    return reply.send({ text });
  });
}

/**
 * One value of a header.
 *
 * A header that was sent more than once arrives as a list, and only the
 * first value is of any use here.
 */
function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/**
 * The provider's key, taken from the header that carries it.
 *
 * The header holds the key the reader configured, so the proxy can pass it
 * on without ever storing it.
 */
function readProviderKey(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const trimmed = header.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The headers a provider's request needs. */
function providerHeaders(provider: AiProvider, key: string): Record<string, string> {
  switch (provider) {
    case 'openai':
      return {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      };
    case 'anthropic':
      return {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      };
    case 'gemini':
      return {
        'content-type': 'application/json',
        'x-goog-api-key': key,
      };
  }
}

/** The body a provider's request needs. */
function providerBody(provider: AiProvider, prompt: string): unknown {
  switch (provider) {
    case 'openai':
      return {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
      };
    case 'anthropic':
      return {
        model: 'claude-3-5-haiku-latest',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      };
    case 'gemini':
      return {
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      };
  }
}

/**
 * The prompt that is sent.
 *
 * The error-fixing assistant is told what the errors are and what the
 * document looked like, so that the answer is a change to that document.
 */
function buildPrompt(
  prompt: string,
  source: string | undefined,
  errors: string[] | undefined,
): string {
  const parts = [prompt];
  if (errors && errors.length > 0) {
    parts.push(`\n\nThe compiler reported these errors:\n${errors.join('\n')}`);
  }
  if (source) {
    parts.push(`\n\nThe document is:\n${source}`);
  }
  return parts.join('');
}

/**
 * The answer's text, out of the provider's own shape.
 *
 * Each provider wraps the answer differently, so the text is taken out of
 * the place that provider puts it.
 */
function extractText(provider: AiProvider, raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  switch (provider) {
    case 'openai': {
      const choices = (parsed as { choices?: { message?: { content?: string } }[] }).choices;
      return choices?.[0]?.message?.content;
    }
    case 'anthropic': {
      const content = (parsed as { content?: { type: string; text?: string }[] }).content;
      const block = content?.find((entry) => entry.type === 'text');
      return block?.text;
    }
    case 'gemini': {
      const candidates = (
        parsed as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
      ).candidates;
      const parts = candidates?.[0]?.content?.parts;
      return parts?.map((part) => part.text ?? '').join('');
    }
  }
}

/**
 * The message of a provider's error, for the reader.
 *
 * Each provider puts its error message in its own place: OpenAI and
 * Anthropic write an `error` object with a `message`, and Gemini writes an
 * `error` object with a `message` of its own. Whatever the provider wrote is
 * read from there.
 *
 * A body that cannot be read is not passed on: a provider that answers with
 * something unexpected can echo the key back, and that has no place in a
 * message to the reader.
 */
function providerError(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'the provider did not explain why.';
  }

  const error = (parsed as { error?: { message?: unknown } }).error;
  const message = error?.message;
  if (typeof message === 'string' && message.trim().length > 0) {
    const trimmed = message.trim();
    return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
  }

  return 'the provider did not explain why.';
}
