import type { FastifyInstance, FastifyRequest } from 'fastify';
import { WebSocket as WebSocketImpl } from 'ws';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';

import type { AuthContext } from '../auth/service.js';
import { authenticateWebSocket } from '../auth/service.js';
import { canAccessProject } from '../auth/authorize.js';
import type { ProjectStorage } from './storage.js';
import { toPosixPath } from './paths.js';

/**
 * The message types of the Yjs WebSocket protocol.
 *
 * The client (`y-websocket`) writes a one-byte message type followed by the
 * payload; the server mirrors the numbering. These values are part of the wire
 * format, so they must not be changed.
 */
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_AUTH = 2;
const MESSAGE_QUERY_AWARENESS = 3;

/**
 * The WebSocket constructor `y-websocket` expects.
 *
 * The provider's option is typed as the browser's `WebSocket`, but the `ws`
 * package implements the same interface; Node's own `WebSocket` type is a
 * different declaration of the same shape. The cast bridges the two
 * declarations — the runtime behaviour is what matters here, and the provider
 * only calls the constructor and the event handlers.
 */
export type WebSocketPolyfill = NonNullable<
  ConstructorParameters<typeof import('y-websocket').WebsocketProvider>[3]
>['WebSocketPolyfill'];

/**
 * The WebSocket implementation a Node client hands to `y-websocket`.
 */
export function nodeWebSocketPolyfill(): WebSocketPolyfill {
  return WebSocketImpl as unknown as WebSocketPolyfill;
}

/**
 * How long to wait after the last edit before writing the file to disk.
 *
 * A keystroke produces a CRDT update, and writing the file on every one of
 * them would turn a paragraph into hundreds of disk writes. The delay is short
 * enough that the file on disk is never meaningfully out of date, and long
 * enough that a burst of typing costs a single write.
 */
const FLUSH_DEBOUNCE_MS = 500;

/**
 * Upper bound on the number of rooms held in memory at once.
 *
 * Each room holds a document, an awareness instance and a set of sockets, so
 * an unbounded number of rooms would exhaust the server. Rooms are evicted in
 * creation order once the limit is reached.
 */
const MAX_ROOMS = 200;

/**
 * How long a room with no sockets is kept before it is torn down.
 *
 * A brief pause — a reconnect, a page reload — should not lose the room, but a
 * room nobody returns to must not be held forever.
 */
const ROOM_IDLE_TTL_MS = 5 * 60 * 1000;

/**
 * The name of the text type inside a room's document.
 *
 * The document carries the file's content in a single `Y.Text`. Keeping the
 * name fixed means the client and the server always agree on where the text
 * lives.
 */
const TEXT_KEY = 'content';

/**
 * Encode a room name.
 *
 * A room names one file in one project, so the name is the project id and the
 * file's path. The path is base64url-encoded because the room name travels as
 * a single URL path segment, and a path may contain slashes.
 */
export function encodeRoomName(projectId: string, filePath: string): string {
  const encoded = Buffer.from(toPosixPath(filePath), 'utf8').toString('base64url');
  return `${projectId}.${encoded}`;
}

/**
 * Decode a room name back into its project id and file path.
 *
 * @returns The parts, or undefined when the name is not a room this server
 *   issued.
 */
export function decodeRoomName(room: string): { projectId: string; filePath: string } | undefined {
  const separator = room.indexOf('.');
  if (separator <= 0) {
    return undefined;
  }

  const projectId = room.slice(0, separator);
  const encoded = room.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId) || encoded.length === 0) {
    return undefined;
  }

  let filePath: string;
  try {
    filePath = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }

  // A round trip that does not reproduce the name means the name was not
  // produced by `encodeRoomName`, so it is not a room of ours.
  if (encodeRoomName(projectId, filePath) !== room) {
    return undefined;
  }

  return { projectId, filePath };
}

/** One connected client. */
interface Connection {
  socket: WebSocket;
  /** The awareness client ids this connection owns. */
  readonly clientIds: Set<number>;
}

/**
 * A collaboration room: one file, shared by every client editing it.
 *
 * The room owns the CRDT document, the awareness state and the sockets. It
 * persists the document to disk, so a file's contents survive a restart.
 */
export class Room {
  readonly name: string;
  readonly projectId: string;
  readonly filePath: string;
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;

  private readonly connections = new Set<Connection>();
  private readonly storage: ProjectStorage;

  /** The text currently in the document. */
  private readonly text: Y.Text;

  /** The content last written to disk, used to skip redundant writes. */
  private lastWritten: string | undefined;

  private flushTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(options: {
    name: string;
    projectId: string;
    filePath: string;
    storage: ProjectStorage;
    initialContent: string;
  }) {
    this.name = options.name;
    this.projectId = options.projectId;
    this.filePath = options.filePath;
    this.storage = options.storage;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    // The server is not a participant: it has no cursor and no name.
    this.awareness.setLocalState(null);

    // The file's content starts as the text on disk, so a client that
    // connects to a room nobody has edited yet sees the real file.
    this.text = this.doc.getText(TEXT_KEY);
    if (options.initialContent.length > 0) {
      this.text.insert(0, options.initialContent);
      this.lastWritten = options.initialContent;
    }

    // Every change to the text schedules a write to disk.
    this.text.observe(() => {
      this.scheduleFlush();
    });

    // A change to somebody's presence — a cursor, a name — is relayed to
    // everybody else in the room.
    this.awareness.on(
      'update',
      ({
        added,
        updated,
        removed,
      }: {
        added: number[];
        updated: number[];
        removed: number[];
      }) => {
        const changed = added.concat(updated, removed);
        if (changed.length === 0) {
          return;
        }
        this.broadcastAwareness(changed);
      },
    );

    // The document changed but the change did not arrive from a client — it
    // came from this server — so it has to reach every client.
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') {
        return;
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder));
    });
  }

  /** The current content of the file. */
  get content(): string {
    return this.text.toString();
  }

  /** How many clients are connected. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** Add a socket to the room and answer it with the current state. */
  connect(socket: WebSocket): void {
    if (this.closed) {
      socket.close();
      return;
    }

    this.connections.add({ socket, clientIds: new Set() });

    // Tell the client what it needs to catch up: the document's state vector
    // (step 1) and the awareness states it is missing.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    socket.send(encoding.toUint8Array(encoder));

    const states = this.awareness.getStates();
    if (states.size > 0) {
      this.sendAwareness(socket, Array.from(states.keys()));
    }

    // A room with a client is not idle.
    this.clearIdleTimer();
  }

  /** Remove a socket from the room. */
  disconnect(socket: WebSocket): void {
    for (const connection of this.connections) {
      if (connection.socket !== socket) {
        continue;
      }
      this.connections.delete(connection);

      // The client's presence must be withdrawn, or its cursor would linger
      // in everybody else's editor.
      if (connection.clientIds.size > 0) {
        awarenessProtocol.removeAwarenessStates(
          this.awareness,
          Array.from(connection.clientIds),
          null,
        );
      }
      break;
    }

    if (this.connections.size === 0) {
      this.scheduleIdleClose();
    }
  }

  /**
   * Handle one message from a client.
   *
   * @param socket The socket the message came from. A reply that answers the
   *   sender is sent only to that socket; an update that concerns the whole
   *   room is sent to everybody.
   */
  handleMessage(socket: WebSocket, data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const encoder = encoding.createEncoder();
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MESSAGE_SYNC: {
        // The 'remote' origin marks updates that arrived from a client, so
        // the document's update handler does not send them back out.
        const replyType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, 'remote');
        // The reply needs the outer message type in front of the sync
        // payload: the client reads the first byte as the message type and
        // the rest as the payload.
        if (replyType !== undefined && encoding.length(encoder) > 0) {
          const framed = encoding.createEncoder();
          encoding.writeVarUint(framed, MESSAGE_SYNC);
          encoding.writeUint8Array(framed, encoding.toUint8Array(encoder));
          socket.send(encoding.toUint8Array(framed));
        }
        break;
      }
      case MESSAGE_AWARENESS: {
        const update = decoding.readVarUint8Array(decoder);
        // The client ids in the update are the ones this connection owns.
        // They are collected before the update is applied, because applying
        // it makes the room's awareness instance announce the change.
        const ids = this.clientIdsIn(update);
        const connection = this.connectionFor(socket);
        if (connection) {
          for (const id of ids) {
            connection.clientIds.add(id);
          }
        }
        awarenessProtocol.applyAwarenessUpdate(this.awareness, update, 'remote');
        break;
      }
      case MESSAGE_AUTH: {
        // The server does not use the client's auth message: permission was
        // settled when the socket was accepted.
        break;
      }
      case MESSAGE_QUERY_AWARENESS: {
        const states = this.awareness.getStates();
        if (states.size > 0) {
          this.sendAwareness(socket, Array.from(states.keys()));
        }
        break;
      }
      default: {
        // An unknown message type is ignored rather than fatal: a newer
        // client may send types this server does not know.
        break;
      }
    }
  }

  /**
   * The awareness client ids carried by an update.
   *
   * An awareness update is a sequence of records, each of which names the
   * client id it belongs to. The ids are read out so the connection that
   * sent the update can be asked to withdraw them when it goes away.
   */
  private clientIdsIn(update: Uint8Array): number[] {
    const ids: number[] = [];
    try {
      const decoder = decoding.createDecoder(update);
      const count = decoding.readVarUint(decoder);
      for (let index = 0; index < count; index += 1) {
        const clientId = decoding.readVarUint(decoder);
        decoding.readVarUint(decoder); // the clock
        decoding.readVarString(decoder); // the state, as JSON
        ids.push(clientId);
      }
    } catch {
      // A malformed update is dropped; the awareness instance ignores it too.
      return [];
    }
    return ids;
  }

  /** Send an awareness update to one socket. */
  private sendAwareness(socket: WebSocket, clients: number[]): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients),
    );
    socket.send(encoding.toUint8Array(encoder));
  }

  /** Relay an awareness change to every client in the room. */
  private broadcastAwareness(clients: number[]): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients),
    );
    this.broadcast(encoding.toUint8Array(encoder));
  }

  /** Send a message to every client in the room, optionally excluding one. */
  private broadcast(payload: Uint8Array, exclude?: WebSocket): void {
    for (const connection of this.connections) {
      if (connection.socket === exclude) {
        continue;
      }
      if (connection.socket.readyState !== connection.socket.OPEN) {
        continue;
      }
      try {
        connection.socket.send(payload);
      } catch {
        // A socket that fails mid-send is closed by the disconnect handler.
      }
    }
  }

  /** The connection record belonging to a socket. */
  private connectionFor(socket: WebSocket): Connection | undefined {
    for (const connection of this.connections) {
      if (connection.socket === socket) {
        return connection;
      }
    }
    return undefined;
  }

  /**
   * Schedule a write of the document to disk.
   *
   * The write is debounced: a burst of edits costs one write.
   */
  private scheduleFlush(): void {
    if (this.closed) {
      return;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
    // A pending flush must not keep the process alive on its own.
    this.flushTimer.unref?.();
  }

  /** Write the document to disk, if it changed. */
  async flush(): Promise<void> {
    if (this.closed) {
      return;
    }

    const content = this.content;
    if (content === this.lastWritten) {
      return;
    }

    try {
      await this.storage.writeProjectFile(this.projectId, this.filePath, content);
      this.lastWritten = content;
    } catch {
      // A file that cannot be written — a deleted path, a permission
      // problem — must not take the room down. The next edit tries again.
    }
  }

  /** Close the room once it has been empty for long enough. */
  private scheduleIdleClose(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.connections.size === 0) {
        this.close();
      }
    }, ROOM_IDLE_TTL_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** Tear the room down, flushing the document first. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.clearIdleTimer();

    void this.flush();

    for (const connection of this.connections) {
      try {
        connection.socket.close();
      } catch {
        // The socket is going away anyway.
      }
    }
    this.connections.clear();

    this.awareness.destroy();
    this.doc.destroy();
  }
}

/**
 * The registry of live collaboration rooms.
 *
 * It owns the documents, the idle eviction and the disk persistence, so the
 * route layer only has to authenticate a socket and hand it over.
 */
export class CollaborationHub {
  readonly context: AuthContext;
  readonly storage: ProjectStorage;

  private readonly rooms = new Map<string, Room>();

  constructor(options: { context: AuthContext; storage: ProjectStorage }) {
    this.context = options.context;
    this.storage = options.storage;
  }

  /**
   * Find or create the room a name refers to.
   *
   * The file's current content seeds a new room, so a client that connects
   * to a file nobody has edited in this session sees the file as it is on
   * disk.
   */
  async roomFor(roomName: string): Promise<Room | undefined> {
    const existing = this.rooms.get(roomName);
    if (existing) {
      return existing;
    }

    const parts = decodeRoomName(roomName);
    if (!parts) {
      return undefined;
    }

    let initialContent: string;
    try {
      initialContent = await this.storage.readProjectFile(parts.projectId, parts.filePath);
    } catch {
      // A file that does not exist yet starts empty; the client will save it.
      initialContent = '';
    }

    const room = new Room({
      name: roomName,
      projectId: parts.projectId,
      filePath: parts.filePath,
      storage: this.storage,
      initialContent,
    });

    // The registry is bounded: the oldest room is closed to make room for a
    // new one.
    while (this.rooms.size >= MAX_ROOMS) {
      const oldest = this.rooms.keys().next();
      if (oldest.done) {
        break;
      }
      const evicted = this.rooms.get(oldest.value);
      this.rooms.delete(oldest.value);
      evicted?.close();
    }

    this.rooms.set(roomName, room);
    return room;
  }

  /** Close every room. Used on shutdown and by tests. */
  closeAll(): void {
    for (const room of this.rooms.values()) {
      room.close();
    }
    this.rooms.clear();
  }

  /** The number of live rooms. */
  get roomCount(): number {
    return this.rooms.size;
  }
}

/**
 * Register the collaboration WebSocket route.
 *
 * The route authenticates the upgrade request and, on success, hands the
 * socket to the room the name refers to. A request that fails authentication
 * is closed before any CRDT traffic is exchanged.
 */
export async function yjsRoutes(
  app: FastifyInstance,
  options: { context: AuthContext; storage: ProjectStorage },
): Promise<CollaborationHub> {
  const { context, storage } = options;
  const hub = new CollaborationHub({ context, storage });

  app.get('/ws/:room', { websocket: true }, (socket, request) => {
    // The handler is asynchronous, so a failure inside it must not become an
    // unhandled rejection: the socket is closed instead.
    void handleSocket(socket, request, hub).catch(() => {
      socket.close(1011, 'The collaboration session failed.');
    });
  });

  // The rooms are flushed to disk when the server stops, so an edit that has
  // not reached the disk yet is not lost.
  app.addHook('onClose', async () => {
    hub.closeAll();
  });

  return hub;
}

/**
 * Authenticate a socket and attach it to its room.
 *
 * The upgrade request is validated before any CRDT traffic is exchanged: an
 * unauthorised client never reaches a document.
 */
async function handleSocket(
  socket: WebSocket,
  request: FastifyRequest,
  hub: CollaborationHub,
): Promise<void> {
  const roomName = (request.params as { room?: string }).room;
  if (!roomName) {
    socket.close(1008, 'A room is required.');
    return;
  }

  const parts = decodeRoomName(roomName);
  if (!parts) {
    socket.close(1008, 'Unknown room.');
    return;
  }

  const query = (request.query ?? {}) as { token?: string };
  const result = authenticateWebSocket(hub.context, {
    authorization: headerValue(request.headers.authorization),
    token: query.token,
  });

  if (!result.ok) {
    socket.close(1008, result.message);
    return;
  }

  // Editing a file is a write action, so the same rule that guards the REST
  // routes guards the socket: a read-only share link may not edit.
  const decision = canAccessProject(hub.context.db, result.identity, parts.projectId, {
    write: true,
  });
  if (!decision.allowed) {
    socket.close(1008, decision.message);
    return;
  }

  // A client sends its first sync step the moment the socket opens, so the
  // listener is attached before the room is looked up. The messages that
  // arrive in the meantime are buffered and replayed once the room is ready:
  // dropping the first one would leave the client unsynchronised forever.
  const pending: Uint8Array[] = [];
  let room: Room | undefined;
  let closed = false;

  socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    const bytes = toBytes(data);
    if (!bytes) {
      return;
    }
    if (room) {
      room.handleMessage(socket, bytes);
    } else {
      pending.push(bytes);
    }
  });

  socket.on('close', () => {
    closed = true;
    room?.disconnect(socket);
  });

  socket.on('error', () => {
    closed = true;
    room?.disconnect(socket);
  });

  const resolved = await hub.roomFor(roomName);
  if (!resolved) {
    socket.close(1008, 'Unknown room.');
    return;
  }
  room = resolved;

  // The socket closed while the room was being looked up; there is nothing
  // left to join.
  if (closed) {
    return;
  }

  room.connect(socket);

  // The buffered messages are replayed in the order they arrived.
  for (const bytes of pending) {
    room.handleMessage(socket, bytes);
  }
  pending.length = 0;
}

/**
 * Read a header value as a string.
 *
 * Node's HTTP headers can be arrays or numbers depending on the header, so
 * the value is normalised rather than cast.
 */
function headerValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return undefined;
}

/** Normalise the payload of a WebSocket message to bytes. */
function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array | undefined {
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data);
  }
  return undefined;
}
