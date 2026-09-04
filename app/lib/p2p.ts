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
  getSnapshot: () => RoomSnapshot;
};

/** Where a browser keeps the key proving it owns a room. Losing it closes the room for good. */
export const ownerKeyStorageKey = (roomId: string) => `conte-live-owner:${roomId}`;

/** The passphrase never leaves the browser: only its digest is sent. */
export async function hashPassword(password: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
];

type Link = { pc: RTCPeerConnection; channel: RTCDataChannel | null };

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
    if (link?.channel?.readyState === "open") link.channel.send(JSON.stringify({ type: "hello", name }));
  }

  /**
   * Host only: set or clear the room passphrase. Guests joining from now on
   * have to know it; everyone already inside stays.
   */
  async setPassword(password: string) {
    if (this.role !== "host") return;
    this.passwordHash = password ? await hashPassword(password) : null;
    this.socket?.send(JSON.stringify({ type: "set-password", hash: this.passwordHash }));
    this.handlers.onProtected(this.passwordHash !== null);
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
    const payload = JSON.stringify({ type: "roster", participants });
    this.links.forEach((link) => {
      if (link.channel?.readyState === "open") link.channel.send(payload);
    });
  }

  /**
   * The host keeps editing after a disconnect because the board is theirs, but a
   * guest must not: their copy can never be published, so anything drawn once the
   * host is gone would silently diverge and then be lost.
   */
  canEdit() {
    if (this.role === "host") return true;
    if (this.role === "closed") return this.ownsProject;
    if (this.role !== "guest" || !this.hostId) return false;
    return this.links.get(this.hostId)?.channel?.readyState === "open";
  }

  /** True once this tab has held the board, so a closed room stays editable for it. */
  isOwner() {
    return this.ownsProject;
  }

  /** Host: push the authoritative project to every guest. */
  broadcastSnapshot(project: Project, projectName: string) {
    if (this.role !== "host") return;
    const payload = JSON.stringify({ type: "snapshot", project, projectName });
    this.links.forEach((link) => {
      if (link.channel?.readyState === "open") link.channel.send(payload);
    });
  }

  /** Guest: propose an edit to the host. */
  sendOp(op: RoomOp) {
    if (this.role !== "guest") return;
    const link = this.hostId ? this.links.get(this.hostId) : null;
    if (link?.channel?.readyState === "open") link.channel.send(JSON.stringify({ type: "op", op }));
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
    isFirst?: boolean;
    from?: string;
    payload?: { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit };
  }) {
    if (message.type === "gate") {
      // A protected room asks before it lets anyone see who else is inside.
      if (message.needsPassword) {
        const password = await this.handlers.requestPassword(this.wrongPassword);
        if (password === null) {
          this.closedByUs = true;
          this.setRole("closed");
          this.handlers.onStatus("パスワードの入力を中止しました");
          this.socket?.close();
          return;
        }
        this.passwordHash = await hashPassword(password);
      }
      this.handlers.onProtected(Boolean(message.needsPassword));
      this.socket?.send(JSON.stringify({ type: "auth", hash: this.passwordHash, ownerKey: this.readOwnerKey() }));
      return;
    }

    if (message.type === "denied") {
      // Reconnect and ask again: the socket is closed by the room.
      this.wrongPassword = true;
      this.handlers.onStatus("パスワードが違います");
      window.setTimeout(() => { if (!this.closedByUs) this.connect(); }, 400);
      return;
    }

    if (message.type === "welcome") {
      this.hostId = message.hostId || null;
      this.selfId = message.peerId || null;
      this.wrongPassword = false;
      if (message.ownerKey) this.writeOwnerKey(message.ownerKey);
      this.setRole(message.isHost ? "host" : "guest");
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
    channel.onopen = () => {
      this.handlers.onPeers(this.links.size);
      if (this.role === "host") {
        channel.send(JSON.stringify({ type: "snapshot", ...this.handlers.getSnapshot() }));
        this.handlers.onStatus("参加者が入室しました");
        this.publishRoster();
      } else {
        this.handlers.onStatus("ホストに接続しました");
        channel.send(JSON.stringify({ type: "hello", name: this.selfName }));
      }
    };
    channel.onmessage = (event) => {
      const data = JSON.parse(event.data as string) as {
        type: string;
        project?: Project;
        projectName?: string;
        op?: RoomOp;
        name?: string;
        participants?: Participant[];
      };
      if (data.type === "snapshot" && data.project && this.role === "guest") {
        this.handlers.onSnapshot({ project: data.project, projectName: data.projectName || "" });
      }
      if (data.type === "op" && data.op && this.role === "host") this.handlers.onOp(data.op);
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
