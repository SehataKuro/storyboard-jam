import { Cut, MIN_CUT_DURATION, Project, Stroke, newCutId, normalizeProject } from "./types";

export type RoomOp =
  | { type: "strokes"; cutId: string; strokes: Stroke[] }
  | { type: "content"; cutId: string; strokes: Stroke[]; backgroundImage?: string }
  | { type: "patch"; cutId: string; patch: { title?: string; note?: string } }
  | { type: "rename"; value: string }
  /** Swap what two cuts show, leaving both timings untouched. */
  | { type: "swap"; aId: string; bId: string }
  /** Insert a cut boundary at a point on the song timeline. */
  | { type: "split"; at: number; id: string; content?: Partial<Pick<Cut, "title" | "note" | "strokes" | "backgroundImage">> }
  /** Move an existing boundary, which resizes the cut before it. */
  | { type: "move"; cutId: string; start: number }
  | { type: "delete"; cutId: string }
  /** Host loaded a song, so the whole board adopts its length. */
  | { type: "duration"; value: number }
  /** A whole board was imported from an exported bundle. */
  | { type: "replace"; project: Project };

export type RoomRole = "connecting" | "host" | "guest" | "waiting" | "closed";
export type RoomSnapshot = { project: Project; projectName: string };
/** Everyone currently in the room, as the host sees it. */
export type Participant = { id: string; name: string; isHost: boolean };

export type RoomHandlers = {
  onRole: (role: RoomRole) => void;
  onStatus: (text: string) => void;
  onPeers: (count: number) => void;
  /** Guest side: authoritative project pushed by the host. */
  onSnapshot: (snapshot: RoomSnapshot) => void;
  /** Host side: an edit proposed by a guest. */
  onOp: (op: RoomOp) => void;
  /** Everyone in the room, host first. Kept by the host and pushed to guests. */
  onRoster: (participants: Participant[]) => void;
  /** The host removed us from the room, so there is nothing to reconnect to. */
  onEvicted: () => void;
  /** Asked for the room passphrase when joining a protected room. */
  requestPassword: (retry: boolean) => Promise<string | null>;
  /** The room's protection state changed, so the header can show a lock. */
  onProtected: (locked: boolean) => void;
  /**
   * The key this device should use for its recovery copy, or null while the room
   * is open to anyone. A protected room's copy is useless without the passphrase.
   */
  onCacheKey: (key: CryptoKey | null) => void;
  getSnapshot: () => RoomSnapshot;
};

/** Where a browser keeps the key proving it owns a room. Losing it closes the room for good. */
export const ownerKeyStorageKey = (roomId: string) => `conte-live-owner:${roomId}`;

/**
 * How a digest was derived. The digest is what the room checks, so it is itself
 * the credential: "v1", a bare SHA-256, could be reversed from a leaked copy or
 * guessed from a table. "v2" derives it with PBKDF2 salted by the room name, so
 * one stolen digest is worth nothing anywhere else and costs real work to crack.
 * Rooms protected before the change still answer "v1", and are upgraded silently
 * the next time their host proves the passphrase.
 */
export type PasswordScheme = "v1" | "v2";

/** Deliberately slow: it is what stands between a short passphrase and a list. */
const PBKDF2_ITERATIONS = 210_000;

/**
 * The key that encrypts this device's recovery copy of a protected room. It is
 * derived from the same passphrase but with its own salt, so the digest sent to
 * the room can never be used to read the cache, nor the cache to guess the digest.
 */
export async function deriveCacheKey(password: string, room: string) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode(`conte-live-cache:${room}`),
      iterations: PBKDF2_ITERATIONS,
    },
    key,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const toHex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** The passphrase never leaves the browser: only its digest is sent. */
export async function hashPassword(password: string, room: string, scheme: PasswordScheme = "v2") {
  const bytes = new TextEncoder().encode(password);
  if (scheme === "v1") return toHex(await crypto.subtle.digest("SHA-256", bytes));
  const key = await crypto.subtle.importKey("raw", bytes, "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      // The room name is a poor secret but a fine salt: it stops one table from
      // covering every room at once.
      salt: new TextEncoder().encode(`conte-live:${room}`),
      iterations: PBKDF2_ITERATIONS,
    },
    key,
    256,
  );
  return toHex(derived);
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
];

type Link = { pc: RTCPeerConnection; channel: RTCDataChannel | null };

/**
 * A data channel refuses any single message much past 64KB, and the send throws
 * instead of the message simply arriving late. One pasted background image is
 * already far bigger than that, so the snapshot carrying it used to vanish and
 * the guest sat looking at an empty board. Everything therefore goes over in
 * pieces small enough that no browser argues about them.
 */
const CHUNK_SIZE = 16_000;
/** Marks a piece. Plain messages are JSON, which never starts with this byte. */
const CHUNK_PREFIX = "";
/** Let the pipe drain before pushing more, so a big board cannot burst past it. */
const BUFFER_LIMIT = 1 << 20;

let chunkSeq = 0;

/** Resolves once the channel has flushed enough to accept more, or is gone. */
function drain(channel: RTCDataChannel) {
  return new Promise<void>((resolve) => {
    channel.bufferedAmountLowThreshold = BUFFER_LIMIT / 2;
    const done = () => {
      channel.removeEventListener("bufferedamountlow", done);
      channel.removeEventListener("close", done);
      resolve();
    };
    channel.addEventListener("bufferedamountlow", done);
    channel.addEventListener("close", done);
  });
}

async function sendChunks(channel: RTCDataChannel, id: string, text: string, total: number) {
  for (let index = 0; index < total; index += 1) {
    if (channel.readyState !== "open") return;
    if (channel.bufferedAmount > BUFFER_LIMIT) await drain(channel);
    if (channel.readyState !== "open") return;
    const part = text.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
    try {
      channel.send(`${CHUNK_PREFIX}${id}:${index}:${total}:${part}`);
    } catch {
      return; // the channel died mid-board; the next snapshot starts over
    }
  }
}

/** Send anything over a channel, split up when it is too big to go at once. */
function sendMessage(channel: RTCDataChannel | null | undefined, payload: unknown) {
  if (!channel || channel.readyState !== "open") return;
  const text = JSON.stringify(payload);
  if (text.length <= CHUNK_SIZE) {
    try { channel.send(text); } catch { /* the channel closed under us */ }
    return;
  }
  chunkSeq += 1;
  void sendChunks(channel, `${chunkSeq}`, text, Math.ceil(text.length / CHUNK_SIZE));
}

/**
 * Puts a chunked message back together. Returns the whole text once the last
 * piece lands, and null while pieces are still outstanding.
 */
function joinChunks(pending: Map<string, string[]>, raw: string) {
  const head = raw.indexOf(":", raw.indexOf(":", raw.indexOf(":") + 1) + 1);
  const [id, indexText, totalText] = raw.slice(1, head).split(":");
  const index = Number(indexText);
  const total = Number(totalText);
  if (!id || !Number.isInteger(index) || !Number.isInteger(total) || total < 1) return null;
  const parts = pending.get(id) ?? new Array<string>(total).fill("");
  parts[index] = raw.slice(head + 1);
  pending.set(id, parts);
  if (parts.some((part) => part === "")) return null;
  pending.delete(id);
  return parts.join("");
}

/**
 * Host-authoritative mesh: the host holds the project and pushes snapshots,
 * guests only propose operations. Playback position is deliberately never sent.
 */
export class Room {
  private socket: WebSocket | null = null;
  private links = new Map<string, Link>();
  private role: RoomRole = "connecting";
  private hostId: string | null = null;
  /** Set once this tab becomes host and never cleared: it holds the only copy. */
  private ownsProject = false;
  private closedByUs = false;
  private selfId: string | null = null;
  private selfName = "";
  /** Host only: the display name each guest sent over its data channel. */
  private names = new Map<string, string>();
  private evicted = false;
  /**
   * Host: how many times each cut's drawing has changed, and the cuts as they
   * were last published. A guest edit replaces a whole cut, so without this a
   * guest working from a snapshot it never received would hand the host an empty
   * cut and the host's drawing would be gone.
   */
  private revisions = new Map<string, number>();
  private published = new Map<string, { strokes: Stroke[]; backgroundImage?: string }>();
  /** Who last changed each cut: a peer id, or null for the host itself. */
  private revisionAuthor = new Map<string, string | null>();
  /** The guest whose op is being applied right now, set only for that moment. */
  private applying: string | null = null;
  /** Guest: the revisions that came with the last snapshot from the host. */
  private hostRevisions = new Map<string, number>();
  /** Where this tab remembers the owner key of a room it hosts. */
  private readOwnerKey() {
    try {
      this.ownerKeyInUse = window.localStorage.getItem(ownerKeyStorageKey(this.room));
    } catch {
      this.ownerKeyInUse = null;
    }
    return this.ownerKeyInUse;
  }

  private writeOwnerKey(key: string | null) {
    this.ownerKeyInUse = key;
    try {
      if (key) window.localStorage.setItem(ownerKeyStorageKey(this.room), key);
      else window.localStorage.removeItem(ownerKeyStorageKey(this.room));
    } catch { /* a lost key only means the room cannot be reopened */ }
  }

  /**
   * Give up the stored key, unless it is no longer ours. Two tabs of one browser
   * share storage, so a handover between them would otherwise let the old host's
   * cleanup delete the key the new host had just been given.
   */
  private releaseOwnerKey() {
    try {
      if (window.localStorage.getItem(ownerKeyStorageKey(this.room)) === this.ownerKeyInUse) {
        this.writeOwnerKey(null);
      }
    } catch { /* nothing to release */ }
    this.ownerKeyInUse = null;
  }

  /** The owner key this tab last presented or was given, to release only its own. */
  private ownerKeyInUse: string | null = null;

  /** Digest of the passphrase this tab is holding, host or guest. */
  private passwordHash: string | null = null;
  private wrongPassword = false;
  /** Set when the passphrase prompt was dismissed: this tab never got in. */
  private authCancelled = false;
  /** The derivation this room's stored digest uses, as reported by the gate. */
  private passwordScheme: PasswordScheme = "v2";
  /**
   * A v2 digest of the passphrase that just opened a legacy room, kept until we
   * know we are its host and can quietly re-store it under the newer derivation.
   */
  private pendingUpgrade: string | null = null;

  constructor(private room: string, private handlers: RoomHandlers) {}

  connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/api/signal?room=${encodeURIComponent(this.room)}`);
    this.socket = socket;
    this.handlers.onStatus("ルームに接続中…");

    socket.onmessage = (event) => void this.onSignalMessage(JSON.parse(event.data as string));
    socket.onerror = () => this.handlers.onStatus("シグナリングに接続できません");
    socket.onclose = () => {
      if (this.closedByUs || this.evicted || this.wrongPassword) return;
      if (this.role === "waiting" || this.role === "guest") {
        // Our own line dropped, or the room went away while we waited. Either way
        // the board is still someone else's, so keep trying instead of making the
        // user reload by hand.
        this.setRole("waiting");
        this.teardownLinks();
        this.handlers.onStatus("接続が切れました。再接続しています…");
        window.setTimeout(() => { if (!this.closedByUs) this.connect(); }, 3000);
        return;
      }
      const wasHost = this.role === "host";
      this.setRole("closed");
      this.handlers.onStatus(wasHost ? "ルームを終了しました" : "ホストが退出したため切断しました");
      this.teardownLinks();
    };
  }

  close() {
    this.closedByUs = true;
    this.teardownLinks();
    this.socket?.close();
    this.socket = null;
    this.setRole("closed");
  }

  isHost() {
    return this.role === "host";
  }

  /** Tells the room who we are. The host owns the roster and republishes it. */
  setName(name: string) {
    this.selfName = name;
    if (this.role === "host") {
      this.publishRoster();
      return;
    }
    const link = this.hostId ? this.links.get(this.hostId) : null;
    sendMessage(link?.channel, { type: "hello", name });
  }

  /**
   * Host only: set or clear the room passphrase. Guests joining from now on
   * have to know it; everyone already inside stays.
   */
  async setPassword(password: string) {
    if (this.role !== "host") return;
    this.passwordScheme = "v2";
    this.pendingUpgrade = null;
    this.passwordHash = password ? await hashPassword(password, this.room) : null;
    this.socket?.send(JSON.stringify({ type: "set-password", hash: this.passwordHash, scheme: "v2" }));
    this.handlers.onProtected(this.passwordHash !== null);
    this.handlers.onCacheKey(password ? await deriveCacheKey(password, this.room) : null);
  }

  /**
   * Host only: give the room to a guest. This is the only way hosting ever moves,
   * so the board never has two candidate copies.
   */
  handover(peerId: string) {
    if (this.role !== "host" || peerId === this.selfId) return;
    this.socket?.send(JSON.stringify({ type: "handover", to: peerId }));
  }

  /** Host only: remove a guest from the room. */
  kick(peerId: string) {
    if (this.role !== "host" || peerId === this.selfId) return;
    this.socket?.send(JSON.stringify({ type: "kick", to: peerId }));
    this.links.get(peerId)?.pc.close();
    this.links.delete(peerId);
    this.names.delete(peerId);
    this.handlers.onPeers(this.links.size);
    this.publishRoster();
  }

  /** Host only: build the roster and send it to every guest. */
  private publishRoster() {
    if (this.role !== "host") return;
    const participants: Participant[] = [
      { id: this.selfId || "host", name: this.selfName, isHost: true },
      ...[...this.links.keys()].map((id) => ({ id, name: this.names.get(id) || "", isHost: false })),
    ];
    this.handlers.onRoster(participants);
    this.links.forEach((link) => sendMessage(link.channel, { type: "roster", participants }));
  }

  /**
   * The host keeps editing after a disconnect because the board is theirs, but a
   * guest must not: their copy can never be published, so anything drawn once the
   * host is gone would silently diverge and then be lost.
   */
  canEdit() {
    // Dismissing the passphrase prompt means we were never let into the room, so
    // nothing here may be edited, not even the recovery copy this tab still holds.
    if (this.authCancelled) return false;
    if (this.role === "host") return true;
    if (this.role === "closed") return this.ownsProject;
    if (this.role !== "guest" || !this.hostId) return false;
    return this.links.get(this.hostId)?.channel?.readyState === "open";
  }

  /** True once this tab has held the board, so a closed room stays editable for it. */
  isOwner() {
    return this.ownsProject && !this.authCancelled;
  }

  /** True while this tab is sitting outside a protected room it declined to unlock. */
  isLockedOut() {
    return this.authCancelled;
  }

  /**
   * Host: note which cuts changed since the last publish. Edits are immutable,
   * so a cut whose drawing is the same object has not been touched.
   */
  private bumpRevisions(project: Project) {
    const published = new Map<string, { strokes: Stroke[]; backgroundImage?: string }>();
    project.cuts.forEach((cut) => {
      published.set(cut.id, { strokes: cut.strokes, backgroundImage: cut.backgroundImage });
      const before = this.published.get(cut.id);
      if (!before) {
        this.revisions.set(cut.id, this.revisions.get(cut.id) ?? 0);
        return;
      }
      if (before.strokes !== cut.strokes || before.backgroundImage !== cut.backgroundImage) {
        this.revisions.set(cut.id, (this.revisions.get(cut.id) ?? 0) + 1);
        this.revisionAuthor.set(cut.id, this.applying);
      }
    });
    this.published = published;
    // Forget cuts that no longer exist, so a room does not grow a tail of them.
    [...this.revisions.keys()].forEach((id) => {
      if (published.has(id)) return;
      this.revisions.delete(id);
      this.revisionAuthor.delete(id);
    });
  }

  private revisionRecord() {
    return Object.fromEntries(this.revisions);
  }

  /** Host: push the authoritative project to every guest. */
  broadcastSnapshot(project: Project, projectName: string) {
    if (this.role !== "host") return;
    this.bumpRevisions(project);
    const payload = { type: "snapshot", project, projectName, revisions: this.revisionRecord() };
    this.links.forEach((link) => sendMessage(link.channel, payload));
  }

  /** Guest: propose an edit to the host. */
  sendOp(op: RoomOp) {
    if (this.role !== "guest") return;
    const link = this.hostId ? this.links.get(this.hostId) : null;
    // Ops that carry a whole cut say which version of it they were drawn on, so
    // the host can tell a normal edit from one based on a board it no longer has.
    const base = op.type === "strokes" || op.type === "content" ? this.hostRevisions.get(op.cutId) ?? 0 : undefined;
    sendMessage(link?.channel, { type: "op", op, base });
  }

  private setRole(role: RoomRole) {
    if (role === "host") this.ownsProject = true;
    this.role = role;
    this.handlers.onRole(role);
  }

  private signal(to: string, payload: unknown) {
    this.socket?.send(JSON.stringify({ type: "signal", to, payload }));
  }

  private async onSignalMessage(message: {
    type: string;
    peerId?: string;
    isHost?: boolean;
    hostId?: string;
    ownerKey?: string;
    needsPassword?: boolean;
    scheme?: PasswordScheme;
    retryAfter?: number;
    from?: string;
    payload?: { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit };
  }) {
    if (message.type === "gate") {
      // A protected room asks before it lets anyone see who else is inside.
      let cacheKey: CryptoKey | null = null;
      if (message.needsPassword) {
        this.passwordScheme = message.scheme === "v1" ? "v1" : "v2";
        const password = await this.handlers.requestPassword(this.wrongPassword);
        if (password === null) {
          this.authCancelled = true;
          this.closedByUs = true;
          this.setRole("closed");
          this.handlers.onStatus("パスワードの入力を中止しました");
          this.socket?.close();
          return;
        }
        this.authCancelled = false;
        this.passwordHash = await hashPassword(password, this.room, this.passwordScheme);
        // Derive the newer digest now, while the passphrase is still at hand.
        this.pendingUpgrade = this.passwordScheme === "v1"
          ? await hashPassword(password, this.room)
          : null;
        cacheKey = await deriveCacheKey(password, this.room);
      }
      this.handlers.onProtected(Boolean(message.needsPassword));
      this.handlers.onCacheKey(cacheKey);
      this.socket?.send(JSON.stringify({
        type: "auth",
        hash: this.passwordHash,
        scheme: this.passwordScheme,
        ownerKey: this.readOwnerKey(),
      }));
      return;
    }

    if (message.type === "denied") {
      // Reconnect and ask again: the socket is closed by the room. After enough
      // wrong guesses the room makes us wait, and asking sooner is pointless.
      this.wrongPassword = true;
      const retryAfter = Math.max(0, message.retryAfter ?? 0);
      this.handlers.onStatus(retryAfter > 1000
        ? `パスワードが違います。${Math.ceil(retryAfter / 1000)}秒後にもう一度試せます`
        : "パスワードが違います");
      window.setTimeout(() => { if (!this.closedByUs) this.connect(); }, Math.max(400, retryAfter));
      return;
    }

    if (message.type === "welcome") {
      this.hostId = message.hostId || null;
      this.selfId = message.peerId || null;
      this.wrongPassword = false;
      this.authCancelled = false;
      if (message.ownerKey) this.writeOwnerKey(message.ownerKey);
      this.setRole(message.isHost ? "host" : "guest");
      // Only the host may restate the passphrase, so a legacy room is upgraded
      // the first time its owner comes back with the right one.
      if (message.isHost && this.pendingUpgrade) {
        this.passwordHash = this.pendingUpgrade;
        this.passwordScheme = "v2";
        this.pendingUpgrade = null;
        this.socket?.send(JSON.stringify({ type: "set-password", hash: this.passwordHash, scheme: "v2" }));
      }
      this.handlers.onStatus(message.isHost ? "ホストとしてルームを開きました" : "ホストへ接続中…");
      if (message.isHost) this.publishRoster();
      return;
    }

    if (message.type === "waiting") {
      // The room's host is away. We hold the line: hosting is never granted by
      // arriving first, so there is nothing to do but wait for them.
      this.setRole("waiting");
      this.handlers.onStatus("ホストの再接続を待っています");
      return;
    }

    if (message.type === "promoted") {
      // The host handed the room over. We already hold their latest snapshot as a
      // guest, so we become the authoritative copy from here.
      this.writeOwnerKey(message.ownerKey || null);
      this.hostId = message.hostId || this.selfId;
      this.teardownLinks();
      this.setRole("host");
      this.handlers.onStatus("ホストを引き継ぎました");
      this.publishRoster();
      return;
    }

    if (message.type === "host-changed") {
      // Either we just gave the room away, or the host we were following did.
      this.releaseOwnerKey();
      // Handing the room over gives up the copy too, so a later disconnect leaves
      // this tab read-only like any other guest.
      this.ownsProject = false;
      this.hostId = message.hostId || null;
      this.teardownLinks();
      this.setRole("guest");
      this.handlers.onStatus("ホストが交代しました。新しいホストへ接続中…");
      return;
    }

    if (message.type === "kicked") {
      this.evicted = true;
      this.closedByUs = true;
      this.setRole("closed");
      this.handlers.onStatus("ホストによってルームから退出させられました");
      this.teardownLinks();
      this.handlers.onEvicted();
      return;
    }

    if (message.type === "peer-join" && message.peerId) {
      await this.inviteGuest(message.peerId);
      return;
    }

    if (message.type === "peer-leave" && message.peerId) {
      this.links.get(message.peerId)?.pc.close();
      this.links.delete(message.peerId);
      this.names.delete(message.peerId);
      this.handlers.onPeers(this.links.size);
      this.publishRoster();
      return;
    }

    if (message.type === "host-gone") {
      // Usually a blip rather than a goodbye: the socket stays open and the room
      // lets us back in by itself once the host returns.
      this.setRole("waiting");
      this.handlers.onStatus("ホストとの接続が切れました。再接続を待っています");
      this.teardownLinks();
      return;
    }

    if (message.type === "signal" && message.from && message.payload) {
      await this.onPeerSignal(message.from, message.payload);
    }
  }

  private createLink(peerId: string) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const link: Link = { pc, channel: null };
    this.links.set(peerId, link);
    pc.onicecandidate = (event) => {
      if (event.candidate) this.signal(peerId, { ice: event.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        this.handlers.onStatus("直接接続に失敗しました（TURNが必要な回線の可能性があります）");
      }
    };
    return link;
  }

  private bindChannel(peerId: string, channel: RTCDataChannel) {
    const link = this.links.get(peerId);
    if (link) link.channel = channel;
    /** Pieces of oversized messages seen on this channel so far. */
    const pending = new Map<string, string[]>();
    channel.onopen = () => {
      this.handlers.onPeers(this.links.size);
      if (this.role === "host") {
        const snapshot = this.handlers.getSnapshot();
        this.bumpRevisions(snapshot.project);
        sendMessage(channel, { type: "snapshot", ...snapshot, revisions: this.revisionRecord() });
        this.handlers.onStatus("参加者が入室しました");
        this.publishRoster();
      } else {
        this.handlers.onStatus("ホストに接続しました");
        sendMessage(channel, { type: "hello", name: this.selfName });
      }
    };
    channel.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      const text = raw.startsWith(CHUNK_PREFIX) ? joinChunks(pending, raw) : raw;
      if (!text) return;
      let data: {
        type: string;
        project?: Project;
        projectName?: string;
        op?: RoomOp;
        base?: number;
        revisions?: Record<string, number>;
        name?: string;
        participants?: Participant[];
      };
      try {
        data = JSON.parse(text);
      } catch {
        return; // a half-delivered message is not worth acting on
      }
      if (data.type === "snapshot" && data.project && this.role === "guest") {
        this.hostRevisions = new Map(Object.entries(data.revisions || {}));
        this.handlers.onSnapshot({ project: data.project, projectName: data.projectName || "" });
      }
      if (data.type === "stale" && this.role === "guest") {
        this.handlers.onStatus("ホスト側の内容が新しかったため、直前の変更は取り消されました");
      }
      if (data.type === "op" && data.op && this.role === "host") {
        const op = data.op;
        if (op.type === "strokes" || op.type === "content") {
          // The guest drew on a version of this cut the host has since moved past,
          // so taking the op would throw away whatever it has not seen yet.
          const current = this.revisions.get(op.cutId) ?? 0;
          // Being behind one's own last edit is not being stale: a guest drawing
          // quickly sends the next stroke before its snapshot has come back.
          const ours = this.revisionAuthor.get(op.cutId) === peerId;
          if ((data.base ?? 0) !== current && !ours) {
            const snapshot = this.handlers.getSnapshot();
            sendMessage(channel, { type: "snapshot", ...snapshot, revisions: this.revisionRecord() });
            sendMessage(channel, { type: "stale" });
            return;
          }
        }
        this.applying = peerId;
        try {
          this.handlers.onOp(op);
        } finally {
          this.applying = null;
        }
      }
      if (data.type === "hello" && this.role === "host") {
        this.names.set(peerId, data.name || "");
        this.publishRoster();
      }
      if (data.type === "roster" && data.participants && this.role === "guest") {
        this.handlers.onRoster(data.participants);
      }
    };
    channel.onclose = () => {
      this.handlers.onPeers(this.links.size);
      this.publishRoster();
    };
  }

  private async inviteGuest(peerId: string) {
    const link = this.createLink(peerId);
    const channel = link.pc.createDataChannel("conte");
    this.bindChannel(peerId, channel);
    const offer = await link.pc.createOffer();
    await link.pc.setLocalDescription(offer);
    this.signal(peerId, { sdp: offer });
  }

  private async onPeerSignal(
    peerId: string,
    payload: { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit },
  ) {
    let link = this.links.get(peerId);

    if (payload.sdp) {
      if (payload.sdp.type === "offer") {
        if (!link) link = this.createLink(peerId);
        link.pc.ondatachannel = (event) => this.bindChannel(peerId, event.channel);
        await link.pc.setRemoteDescription(payload.sdp);
        const answer = await link.pc.createAnswer();
        await link.pc.setLocalDescription(answer);
        this.signal(peerId, { sdp: answer });
      } else if (link) {
        await link.pc.setRemoteDescription(payload.sdp);
      }
      return;
    }

    if (payload.ice && link) {
      try {
        await link.pc.addIceCandidate(payload.ice);
      } catch {
        /* candidate arrived before the description */
      }
    }
  }

  private teardownLinks() {
    this.links.forEach((link) => link.pc.close());
    this.links.clear();
    this.names.clear();
    this.handlers.onPeers(0);
    this.handlers.onRoster([]);
  }
}

/** Host-side reducer: the single place where a proposed op becomes project state. */
export function applyOp(project: Project, op: RoomOp): Project {
  if (op.type === "strokes") {
    return { ...project, cuts: project.cuts.map((cut) => (cut.id === op.cutId ? { ...cut, strokes: op.strokes } : cut)) };
  }

  if (op.type === "content") {
    return {
      ...project,
      cuts: project.cuts.map((cut) => (cut.id === op.cutId
        ? { ...cut, strokes: op.strokes, backgroundImage: op.backgroundImage }
        : cut)),
    };
  }

  if (op.type === "swap") {
    const a = project.cuts.find((cut) => cut.id === op.aId);
    const b = project.cuts.find((cut) => cut.id === op.bId);
    if (!a || !b || a === b) return project;
    return {
      ...project,
      cuts: project.cuts.map((cut) => {
        // Only the drawing moves: each cut keeps its own place on the song.
        if (cut.id === op.aId) return { ...cut, strokes: b.strokes, backgroundImage: b.backgroundImage };
        if (cut.id === op.bId) return { ...cut, strokes: a.strokes, backgroundImage: a.backgroundImage };
        return cut;
      }),
    };
  }

  if (op.type === "patch") {
    return { ...project, cuts: project.cuts.map((cut) => (cut.id === op.cutId ? { ...cut, ...op.patch } : cut)) };
  }

  if (op.type === "delete") {
    // The first cut owns time zero, so removing it would leave a gap.
    if (project.cuts.length <= 1) return project;
    const index = project.cuts.findIndex((cut) => cut.id === op.cutId);
    if (index < 0) return project;
    const cuts = project.cuts.filter((cut) => cut.id !== op.cutId);
    if (index === 0) cuts[0] = { ...cuts[0], start: 0 };
    return { ...project, cuts };
  }

  if (op.type === "split") {
    const at = op.at;
    if (at < MIN_CUT_DURATION || at > project.duration - MIN_CUT_DURATION) return project;
    if (project.cuts.some((cut) => Math.abs(cut.start - at) < MIN_CUT_DURATION)) return project;
    // The new cut starts blank at the split point unless the caller supplied
    // content, which is how duplicating a cut works.
    const cut: Cut = { id: op.id || newCutId(), title: "", note: "", start: at, strokes: [], ...op.content };
    return normalizeProject({ ...project, cuts: [...project.cuts, cut] });
  }

  if (op.type === "move") {
    const index = project.cuts.findIndex((cut) => cut.id === op.cutId);
    if (index <= 0) return project;
    const lower = project.cuts[index - 1].start + MIN_CUT_DURATION;
    const upper = (index + 1 < project.cuts.length ? project.cuts[index + 1].start : project.duration) - MIN_CUT_DURATION;
    if (upper < lower) return project;
    const start = Math.min(Math.max(op.start, lower), upper);
    return { ...project, cuts: project.cuts.map((cut, i) => (i === index ? { ...cut, start } : cut)) };
  }

  if (op.type === "replace") {
    return normalizeProject(op.project);
  }

  if (op.type === "duration") {
    return normalizeProject({ ...project, duration: op.value });
  }

  return project;
}
