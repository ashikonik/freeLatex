import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

import { buildApp, type BuiltApp } from '../app.js';
import { openDatabase, type DbHandle } from '../db/index.js';
import { projects, shareTokens, users } from '../db/schema.js';
import { hashSecret } from '../utils/hash.js';
import { encodeRoomName, decodeRoomName, nodeWebSocketPolyfill } from './yjs.js';
import type { Env } from '../config/env.js';

const ADMIN_KEY = 'admin-secret-key';
const OWNER_KEY = 'sk_user_owner_key_value';
const OTHER_KEY = 'sk_user_other_key_value';

/** A share token that may edit the project. */
const RW_TOKEN = 'rw_share_token_value';
/** A share token that may only view the project. */
const RO_TOKEN = 'ro_share_token_value';

let handle: DbHandle;
let built: BuiltApp;
let dataDir: string;

/** The port the test server listens on. */
let port: number;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'freelatex-yjs-'));

  handle = openDatabase(':memory:', ':memory:');
  handle.db
    .insert(users)
    .values({ id: 'owner', apiKeyHash: hashSecret(OWNER_KEY), name: 'Owner', role: 'user' })
    .run();
  handle.db
    .insert(users)
    .values({ id: 'other', apiKeyHash: hashSecret(OTHER_KEY), name: 'Other', role: 'user' })
    .run();
  handle.db
    .insert(projects)
    .values({ id: 'prj_1', ownerId: 'owner', title: 'Thesis' })
    .run();
  handle.db
    .insert(projects)
    .values({ id: 'prj_other', ownerId: 'other', title: 'Not Mine' })
    .run();
  handle.db
    .insert(shareTokens)
    .values({
      id: 'shr_rw',
      projectId: 'prj_1',
      tokenHash: hashSecret(RW_TOKEN),
      permission: 'rw',
    })
    .run();
  handle.db
    .insert(shareTokens)
    .values({
      id: 'shr_ro',
      projectId: 'prj_1',
      tokenHash: hashSecret(RO_TOKEN),
      permission: 'ro',
    })
    .run();

  built = await buildApp({ env: envFor(), db: handle });
  await built.app.ready();
  await built.app.listen({ port: 0, host: '127.0.0.1' });

  const address = built.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

afterEach(async () => {
  await built?.app.close();
  handle?.close();
  await rm(dataDir, { recursive: true, force: true });
});

function envFor(): Env {
  return {
    adminApiKey: ADMIN_KEY,
    authMode: 'multi',
    port: 3030,
    host: '0.0.0.0',
    dataDir,
    compileTimeoutMs: 30_000,
    nodeEnv: 'test',
    staticDir: '',
  };
}

/** Write a file into prj_1 through the API. */
async function writeFile(path: string, content: string): Promise<void> {
  await built.app.inject({
    method: 'PUT',
    url: `/api/projects/prj_1/files/${path}`,
    headers: { authorization: `Bearer ${OWNER_KEY}` },
    payload: { content },
  });
}

/**
 * Wait for a condition to hold.
 *
 * The collaboration tests wait for state that arrives over a socket, so a
 * fixed delay would either be flaky or slow. The condition is polled until it
 * holds or the budget runs out.
 */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error('waitFor: the condition did not hold within the budget.');
}

/**
 * A connected collaboration client.
 *
 * It owns the Yjs document and the provider, so a test can edit the document
 * and read back what the other clients see.
 */
interface Client {
  doc: Y.Doc;
  provider: WebsocketProvider;
  text: Y.Text;
  close(): void;
}

/**
 * Connect a client to a room and wait until it has synchronised.
 *
 * @param key The API key to authenticate with.
 */
async function connect(room: string, key: string): Promise<Client> {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/ws`, room, doc, {
    // The credential travels in a query parameter because the browser's
    // WebSocket API cannot set request headers.
    params: { token: key },
    WebSocketPolyfill: nodeWebSocketPolyfill(),
    connect: true,
  });

  await waitFor(() => provider.wsconnected && provider.synced);

  return {
    doc,
    provider,
    text: doc.getText('content'),
    close: () => {
      provider.destroy();
      doc.destroy();
    },
  };
}

describe('room names', () => {
  it('round-trips a project and a file path', () => {
    const room = encodeRoomName('prj_1', 'chapters/intro.tex');

    expect(decodeRoomName(room)).toEqual({
      projectId: 'prj_1',
      filePath: 'chapters/intro.tex',
    });
  });

  it('produces a name that is one URL path segment', () => {
    const room = encodeRoomName('prj_1', 'chapters/intro.tex');

    // A slash would split the room name across two path segments.
    expect(room).not.toContain('/');
  });

  it('rejects a name it did not issue', () => {
    expect(decodeRoomName('prj_1')).toBeUndefined();
    expect(decodeRoomName('')).toBeUndefined();
    expect(decodeRoomName('.abc')).toBeUndefined();
    expect(decodeRoomName('prj_1.!!!not-base64!!!')).toBeUndefined();
  });

  it('rejects a name with a tampered project id', () => {
    const room = encodeRoomName('prj_1', 'main.tex');
    const tampered = room.replace('prj_1', '../etc');

    expect(decodeRoomName(tampered)).toBeUndefined();
  });
});

describe('collaboration', () => {
  it('rejects a client with no credentials', async () => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/ws`, 'prj_1.bWFpbi50ZXg=', doc, {
      WebSocketPolyfill: nodeWebSocketPolyfill(),
      connect: true,
    });

    await waitFor(() => provider.wsconnecting || provider.wsconnected || !provider.wsconnected);
    // The server refuses the socket, so it never reports a connection.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(provider.wsconnected).toBe(false);

    provider.destroy();
    doc.destroy();
  });

  it('rejects a client whose key belongs to another tenant', async () => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/ws`, 'prj_1.bWFpbi50ZXg=', doc, {
      params: { token: OTHER_KEY },
      WebSocketPolyfill: nodeWebSocketPolyfill(),
      connect: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(provider.wsconnected).toBe(false);

    provider.destroy();
    doc.destroy();
  });

  it('rejects a client that asks for a room it may not open', async () => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/ws`, 'prj_other.bWFpbi50ZXg=', doc, {
      params: { token: OWNER_KEY },
      WebSocketPolyfill: nodeWebSocketPolyfill(),
      connect: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(provider.wsconnected).toBe(false);

    provider.destroy();
    doc.destroy();
  });

  it('converges two clients editing the same file', async () => {
    const room = encodeRoomName('prj_1', 'main.tex');
    const first = await connect(room, OWNER_KEY);
    const second = await connect(room, OWNER_KEY);

    try {
      first.text.insert(0, 'Hello from the first client.');
      await waitFor(() => second.text.toString() === 'Hello from the first client.');

      second.text.insert(second.text.length, ' And from the second.');
      await waitFor(
        () => first.text.toString() === 'Hello from the first client. And from the second.',
      );

      // Both clients agree on the content.
      expect(first.text.toString()).toBe(second.text.toString());
    } finally {
      first.close();
      second.close();
    }
  }, 20_000);

  it('merges concurrent edits instead of dropping one', async () => {
    const room = encodeRoomName('prj_1', 'main.tex');
    const first = await connect(room, OWNER_KEY);
    const second = await connect(room, OWNER_KEY);

    try {
      // Both clients edit before either has seen the other's change.
      first.text.insert(0, 'AAAA');
      second.text.insert(0, 'BBBB');

      await waitFor(() => first.text.toString() === 'BBBBAAAA');
      await waitFor(() => second.text.toString() === 'BBBBAAAA');

      expect(first.text.toString()).toBe('BBBBAAAA');
      expect(second.text.toString()).toBe('BBBBAAAA');
    } finally {
      first.close();
      second.close();
    }
  }, 20_000);

  it('seeds a new room with the file on disk', async () => {
    await writeFile('main.tex', 'The content that was already on disk.');

    const room = encodeRoomName('prj_1', 'main.tex');
    const client = await connect(room, OWNER_KEY);

    try {
      expect(client.text.toString()).toBe('The content that was already on disk.');
    } finally {
      client.close();
    }
  }, 20_000);

  it('keeps two clients in different files apart', async () => {
    const first = await connect(encodeRoomName('prj_1', 'a.tex'), OWNER_KEY);
    const second = await connect(encodeRoomName('prj_1', 'b.tex'), OWNER_KEY);

    try {
      first.text.insert(0, 'Only in a.tex');

      await waitFor(() => first.text.toString() === 'Only in a.tex');
      // The other file's room must not have received it.
      expect(second.text.toString()).toBe('');
    } finally {
      first.close();
      second.close();
    }
  }, 20_000);

  it('writes the edited text to disk', async () => {
    const room = encodeRoomName('prj_1', 'main.tex');
    const client = await connect(room, OWNER_KEY);

    try {
      client.text.insert(0, 'Saved to disk.');
      await waitFor(() => client.text.toString() === 'Saved to disk.');

      // The write is debounced, so the file appears a moment later.
      await waitFor(async () => {
        const response = await built.app.inject({
          method: 'GET',
          url: '/api/projects/prj_1/files/main.tex',
          headers: { authorization: `Bearer ${OWNER_KEY}` },
        });
        return response.statusCode === 200 && response.json().content === 'Saved to disk.';
      });

      const response = await built.app.inject({
        method: 'GET',
        url: '/api/projects/prj_1/files/main.tex',
        headers: { authorization: `Bearer ${OWNER_KEY}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().content).toBe('Saved to disk.');
    } finally {
      client.close();
    }
  }, 20_000);

  it('lets a read-write share token join the room', async () => {
    const room = encodeRoomName('prj_1', 'main.tex');
    const client = await connect(room, RW_TOKEN);

    try {
      client.text.insert(0, 'Edited through a share link.');
      await waitFor(() => client.text.toString() === 'Edited through a share link.');
    } finally {
      client.close();
    }
  }, 20_000);

  it('refuses a read-only share token', async () => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(
      `ws://127.0.0.1:${port}/ws`,
      encodeRoomName('prj_1', 'main.tex'),
      doc,
      {
        params: { token: RO_TOKEN },
        WebSocketPolyfill: nodeWebSocketPolyfill(),
        connect: true,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 400));
    // A read-only link may look, but it may not edit.
    expect(provider.wsconnected).toBe(false);

    provider.destroy();
    doc.destroy();
  });

  it('refuses a share token that belongs to another project', async () => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(
      `ws://127.0.0.1:${port}/ws`,
      encodeRoomName('prj_other', 'main.tex'),
      doc,
      {
        params: { token: RW_TOKEN },
        WebSocketPolyfill: nodeWebSocketPolyfill(),
        connect: true,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(provider.wsconnected).toBe(false);

    provider.destroy();
    doc.destroy();
  });

  it('relays a collaborator\'s presence to the other clients', async () => {
    const room = encodeRoomName('prj_1', 'main.tex');
    const first = await connect(room, OWNER_KEY);
    const second = await connect(room, OWNER_KEY);

    try {
      // The first client announces itself: a name and a cursor.
      first.provider.awareness.setLocalStateField('user', { name: 'Ada' });

      await waitFor(() => {
        const states = second.provider.awareness.getStates();
        return Array.from(states.values()).some(
          (state) => (state as { user?: { name?: string } }).user?.name === 'Ada',
        );
      });
    } finally {
      first.close();
      second.close();
    }
  }, 20_000);

  it('withdraws a collaborator\'s presence when it leaves', async () => {
    const room = encodeRoomName('prj_1', 'main.tex');
    const first = await connect(room, OWNER_KEY);
    const second = await connect(room, OWNER_KEY);

    try {
      first.provider.awareness.setLocalStateField('user', { name: 'Ada' });
      await waitFor(() => second.provider.awareness.getStates().size > 0);

      first.close();

      // The cursor of the client that left must not linger.
      await waitFor(() => {
        const states = second.provider.awareness.getStates();
        return Array.from(states.values()).every(
          (state) => (state as { user?: { name?: string } }).user?.name !== 'Ada',
        );
      });
    } finally {
      second.close();
    }
  }, 20_000);
});
