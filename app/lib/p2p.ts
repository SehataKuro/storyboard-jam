import { MIN_CUT_DURATION, Project, Stroke, newCutId, normalizeProject } from "./types";

export type RoomOp =
  | { type: "strokes"; cutId: string; strokes: Stroke[] }
  | { type: "content"; cutId: string; strokes: Stroke[]; backgroundImage?: string }
  | { type: "patch"; cutId: string; patch: { title?: string; note?: string } }
  | { type: "rename"; value: string }
  /** Insert a cut boundary at a point on the song timeline. */
  | { type: "split"; at: number; id: string }
  /** Move an existing boundary, which resizes the cut before it. */
  | { type: "move"; cutId: string; start: number }
  | { type: "delete"; cutId: string }
  /** Host loaded a song, so the whole board adopts its length. */
  | { type: "duration"; value: number }
  /** A whole board was imported from an exported bundle. */
  | { type: "replace"; project: Project };

export type RoomRole = "connecting" | "host" | "guest" | "closed";
export type RoomSnapshot = { project: Project; projectName: string };

export type RoomHandlers = {
  onRole: (role: RoomRole) => void;
  onStatus: (text: string) => void;
  onPeers: (count: number) => void;
  /** Guest side: authoritative project pushed by the host. */
  onSnapshot: (snapshot: RoomSnapshot) => void;
  /** Host side: an edit proposed by a guest. */
  onOp: (op: RoomOp) => void;
  getSnapshot: () => RoomSnapshot;
};

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
  private closedByUs = false;

  constructor(private room: string, private handlers: RoomHandlers) {}

  connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/api/signal?room=${encodeURIComponent(this.room)}`);
    this.socket = socket;
    this.handlers.onStatus("ルームに接続中…");

    socket.onmessage = (event) => void this.onSignalMessage(JSON.parse(event.data as string));
    socket.onerror = () => this.handlers.onStatus("シグナリングに接続できません");
    socket.onclose = () => {
      if (this.closedByUs) return;
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

  /** Closed rooms remain locally editable; guests wait for the data channel. */
  canEdit() {
    if (this.role === "host" || this.role === "closed") return true;
    if (this.role !== "guest" || !this.hostId) return false;
    return this.links.get(this.hostId)?.channel?.readyState === "open";
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
    from?: string;
    payload?: { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit };
  }) {
    if (message.type === "welcome") {
      this.hostId = message.hostId || null;
      this.setRole(message.isHost ? "host" : "guest");
      this.handlers.onStatus(message.isHost ? "ホストとしてルームを開きました" : "ホストへ接続中…");
      return;
    }

    if (message.type === "peer-join" && message.peerId) {
      await this.inviteGuest(message.peerId);
      return;
    }

    if (message.type === "peer-leave" && message.peerId) {
      this.links.get(message.peerId)?.pc.close();
      this.links.delete(message.peerId);
      this.handlers.onPeers(this.links.size);
      return;
    }

    if (message.type === "host-gone") {
      this.setRole("closed");
      this.handlers.onStatus("ホストが退出したため切断しました");
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
      } else {
        this.handlers.onStatus("ホストに接続しました");
      }
    };
    channel.onmessage = (event) => {
      const data = JSON.parse(event.data as string) as { type: string; project?: Project; projectName?: string; op?: RoomOp };
      if (data.type === "snapshot" && data.project && this.role === "guest") {
        this.handlers.onSnapshot({ project: data.project, projectName: data.projectName || "" });
      }
      if (data.type === "op" && data.op && this.role === "host") this.handlers.onOp(data.op);
    };
    channel.onclose = () => this.handlers.onPeers(this.links.size);
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
    this.handlers.onPeers(0);
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
    // The new cut is a fresh blank frame starting at the split point.
    const cut = { id: op.id || newCutId(), title: "", note: "", start: at, strokes: [] };
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
