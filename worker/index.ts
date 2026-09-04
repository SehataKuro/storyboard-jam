/** Cloudflare Worker entry point: app router + WebRTC signalling for host-authoritative rooms. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  SIGNAL_ROOM: DurableObjectNamespace;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type Peer = { id: string; socket: WebSocket };

/**
 * How a stored passphrase digest was derived. "v1" is the original bare SHA-256,
 * kept only so rooms protected before the change still open; everything new is
 * "v2", a PBKDF2 digest salted with the room name.
 */
type PasswordScheme = "v1" | "v2";

/** Wrong guesses tolerated before answers start being delayed. */
const FREE_ATTEMPTS = 5;
/** Ceiling on the backoff, so a room is never locked away for good. */
const MAX_LOCKOUT_MS = 5 * 60_000;

/**
 * Compare two digests without letting the time taken reveal how much of a guess
 * was right. Length is not secret: both sides are fixed-width hex.
 */
function digestsMatch(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

/**
 * Relays SDP/ICE between peers of one room. It never sees storyboard data:
 * the host peer holds the authoritative project, so when the host leaves the room is closed.
 *
 * The room has one durable owner. Hosting is never granted by arriving first: it
 * belongs to whoever holds the owner key, and the only way to move it is the host
 * handing it to a named guest. That keeps exactly one authoritative copy of the
 * board, so it can never fork or be replaced by an older one.
 */
export class SignalRoom {
  private peers = new Map<string, Peer>();
  private hostId: string | null = null;
  /** Digest of the room passphrase, chosen by the host. Never the plain text. */
  private passwordHash: string | null = null;
  /** Which derivation the stored digest uses, so older rooms keep opening. */
  private passwordScheme: PasswordScheme = "v2";
  /** Wrong guesses so far, and when the current backoff expires. */
  private failures = 0;
  private lockedUntil = 0;
  /** Secret minted for the room's creator and rotated on every handover. */
  private ownerKey: string | null = null;
  /** The key each joined peer presented, so the owner can be found again. */
  private keys = new Map<string, string | null>();
  /**
   * Peers holding the line for an absent host, with the passphrase they already
   * cleared. A dropped connection is usually a blip, so they are parked here
   * instead of being sent away to reload by hand.
   */
  private waiting = new Map<string, { peer: Peer; hash: string | null; ownerKey: string | null }>();

  constructor(private state: DurableObjectState) {
    // Survives eviction: without it a forgotten room would let the next arrival
    // host it, and that peer has no copy of the board.
    state.blockConcurrencyWhile(async () => {
      this.ownerKey = (await state.storage.get<string>("ownerKey")) ?? null;
      this.passwordHash = (await state.storage.get<string>("passwordHash")) ?? null;
      // A room stored before schemes existed holds a bare SHA-256.
      this.passwordScheme = (await state.storage.get<PasswordScheme>("passwordScheme"))
        ?? (this.passwordHash ? "v1" : "v2");
      this.failures = (await state.storage.get<number>("failures")) ?? 0;
      this.lockedUntil = (await state.storage.get<number>("lockedUntil")) ?? 0;
    });
  }

  private persist() {
    return this.state.storage.put({
      ownerKey: this.ownerKey,
      passwordHash: this.passwordHash,
      passwordScheme: this.passwordScheme,
    });
  }

  /**
   * Guessing has to stay slow even though the digest is checked in one comparison.
   * The counter is persisted because it would otherwise reset every time the room
   * is evicted, and going quiet for a minute is enough to bring that about.
   */
  private noteFailure() {
    this.failures += 1;
    if (this.failures > FREE_ATTEMPTS) {
      const backoff = Math.min(1000 * 2 ** (this.failures - FREE_ATTEMPTS - 1), MAX_LOCKOUT_MS);
      this.lockedUntil = Date.now() + backoff;
    }
    void this.state.storage.put({ failures: this.failures, lockedUntil: this.lockedUntil });
  }

  private clearFailures() {
    if (this.failures === 0 && this.lockedUntil === 0) return;
    this.failures = 0;
    this.lockedUntil = 0;
    void this.state.storage.put({ failures: 0, lockedUntil: 0 });
  }

  /** Milliseconds left on the backoff, or 0 when a guess may be checked now. */
  private lockoutLeft() {
    return Math.max(0, this.lockedUntil - Date.now());
  }

  /** Turn a peer away for a wrong passphrase, telling it how long to hold off. */
  private deny(peer: Peer, retryAfter: number) {
    this.send(peer, { type: "denied", retryAfter });
    try { peer.socket.close(1008, "wrong password"); } catch { /* already closing */ }
  }

  fetch(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const id = crypto.randomUUID().slice(0, 8);
    const peer: Peer = { id, socket: server };
    // The peer is in neither map until it has answered the gate: an
    // unauthenticated socket must not be able to see or signal anyone.
    // Deliberately silent about whether the room has ever been opened: that would
    // let anyone map which room names are in use just by guessing at them.
    this.send(peer, {
      type: "gate",
      needsPassword: this.passwordHash !== null,
      scheme: this.passwordHash ? this.passwordScheme : undefined,
    });

    const admit = (isHost: boolean, ownerKey?: string) => {
      this.peers.set(id, peer);
      this.send(peer, { type: "welcome", peerId: id, isHost, hostId: this.hostId, ownerKey });
    };

    const join = (hash: string | null, ownerKey: string | null, scheme: PasswordScheme) => {
      const waitMs = this.passwordHash ? this.lockoutLeft() : 0;
      if (waitMs > 0) {
        // Too many wrong guesses: nothing is compared until the backoff runs out.
        this.deny(peer, waitMs);
        return;
      }
      // Nobody has ever hosted this room, so this peer opens it and takes the key.
      if (this.ownerKey === null) {
        this.ownerKey = crypto.randomUUID();
        this.passwordHash = hash;
        this.passwordScheme = scheme;
        this.hostId = id;
        void this.persist();
        admit(true, this.ownerKey);
        return;
      }
      // The passphrase is checked before anything else, the owner key included.
      // The key says who may host the room; it is not a way past the door, or the
      // room would be open to whoever created it no matter what it was locked with.
      if (this.passwordHash && !digestsMatch(hash ?? "", this.passwordHash)) {
        this.noteFailure();
        this.deny(peer, this.lockoutLeft());
        return;
      }
      this.clearFailures();
      if (this.hostId === null) {
        // The room exists but its host is away. Only the owner can reopen it:
        // anyone else would be hosting a board they do not have. They wait here
        // rather than being turned away, and are let in when the host returns.
        if (!digestsMatch(ownerKey ?? "", this.ownerKey)) {
          this.waiting.set(id, { peer, hash, ownerKey });
          this.send(peer, { type: "waiting" });
          return;
        }
        this.hostId = id;
        admit(true);
        this.admitWaiting();
        return;
      }
      // A host that reloaded lands here: its previous socket is still counted as
      // the host, so it joins as a guest and is promoted back once that one drops.
      this.keys.set(id, ownerKey);
      admit(false);
      const host = this.peers.get(this.hostId);
      if (host) this.send(host, { type: "peer-join", peerId: id });
    };

    server.addEventListener("message", (event) => {
      let message: {
        type?: string; to?: string; payload?: unknown;
        hash?: string | null; ownerKey?: string | null; scheme?: string;
      };
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return;
      }
      if (message.type === "auth") {
        if (!this.peers.has(id) && !this.waiting.has(id)) {
          join(message.hash ?? null, message.ownerKey ?? null, message.scheme === "v1" ? "v1" : "v2");
        }
        return;
      }
      // Waiting peers are not in the room yet, so they may not signal anyone.
      if (!this.peers.has(id)) return;
      if (message.type === "set-password" && id === this.hostId) {
        this.passwordHash = message.hash ?? null;
        this.passwordScheme = message.scheme === "v1" ? "v1" : "v2";
        this.clearFailures();
        void this.persist();
        return;
      }
      if (message.type === "handover" && message.to && id === this.hostId) {
        const successor = this.peers.get(message.to);
        if (!successor) return;
        // Rotating the key is what actually moves ownership: the previous host's
        // stored copy stops working, so it cannot reclaim the room later.
        this.ownerKey = crypto.randomUUID();
        this.hostId = message.to;
        void this.persist();
        this.send(successor, { type: "promoted", hostId: message.to, ownerKey: this.ownerKey });
        this.peers.forEach((other, otherId) => {
          if (otherId === message.to) return;
          this.send(other, { type: "host-changed", hostId: message.to });
          // The new host meshes with everyone through the usual invite path.
          this.send(successor, { type: "peer-join", peerId: otherId });
        });
        return;
      }
      if (message.type === "kick" && message.to && id === this.hostId) {
        const evicted = this.peers.get(message.to);
        if (!evicted) return;
        this.send(evicted, { type: "kicked" });
        try { evicted.socket.close(1000, "removed by host"); } catch { /* already closing */ }
        this.drop(message.to);
        return;
      }
      if (message.type !== "signal" || !message.to) return;
      const target = this.peers.get(message.to);
      if (target) this.send(target, { type: "signal", from: id, payload: message.payload });
    });

    const close = () => this.drop(id);
    server.addEventListener("close", close);
    server.addEventListener("error", close);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Hand the room back to the owner if they are already here. A host that reloads
   * reconnects before its old socket is reported closed, so without this it would
   * be parked in the waiting list holding the key to a room nobody is hosting.
   */
  private promoteWaitingOwner() {
    if (this.ownerKey === null) return;
    for (const [waitingId, entry] of this.waiting) {
      if (entry.ownerKey !== this.ownerKey) continue;
      this.waiting.delete(waitingId);
      this.peers.set(waitingId, entry.peer);
      this.hostId = waitingId;
      this.send(entry.peer, { type: "welcome", peerId: waitingId, isHost: true, hostId: waitingId });
      this.admitWaiting();
      return;
    }
  }

  /** Let everyone who was holding the line into the room the host just reopened. */
  private admitWaiting() {
    const host = this.hostId ? this.peers.get(this.hostId) : null;
    this.waiting.forEach((entry, waitingId) => {
      // The passphrase may have changed while they waited.
      if (this.passwordHash && !digestsMatch(entry.hash ?? "", this.passwordHash)) {
        this.deny(entry.peer, 0);
        return;
      }
      this.peers.set(waitingId, entry.peer);
      this.send(entry.peer, { type: "welcome", peerId: waitingId, isHost: false, hostId: this.hostId });
      if (host) this.send(host, { type: "peer-join", peerId: waitingId });
    });
    this.waiting.clear();
  }

  private drop(id: string) {
    this.keys.delete(id);
    if (this.waiting.delete(id)) return;
    if (!this.peers.delete(id)) return;
    if (this.hostId === id) {
      // The host held the only copy of the project, so nobody can edit until they
      // are back. The others keep their sockets and wait instead of reloading by
      // hand, which turns a brief network blip into a short pause.
      this.hostId = null;
      this.peers.forEach((peer, peerId) => {
        this.send(peer, { type: "host-gone" });
        this.waiting.set(peerId, { peer, hash: this.passwordHash, ownerKey: this.keys.get(peerId) ?? null });
      });
      this.peers.clear();
      this.promoteWaitingOwner();
      return;
    }
    if (this.hostId) {
      const host = this.peers.get(this.hostId);
      if (host) this.send(host, { type: "peer-leave", peerId: id });
    }
  }

  private send(peer: Peer, payload: unknown) {
    try { peer.socket.send(JSON.stringify(payload)); } catch { /* peer already gone */ }
  }
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/signal") {
      const room = (url.searchParams.get("room") || "main").slice(0, 80);
      const id = env.SIGNAL_ROOM.idFromName(room);
      return env.SIGNAL_ROOM.get(id).fetch(request);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
