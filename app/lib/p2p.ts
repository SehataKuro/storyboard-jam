import { Cut, Stroke } from "./types";

export type RoomOp =
  | { type: "strokes"; cutId: string; strokes: Stroke[] }
  | { type: "patch"; cutId: string; patch: Partial<Pick<Cut, "title" | "duration" | "note">> }
  | { type: "add"; cut: Cut; afterId: string | null }
  | { type: "delete"; cutId: string };

export type RoomRole = "connecting" | "host" | "guest" | "closed";

export type RoomHandlers = {
  onRole: (role: RoomRole) => void;
  onStatus: (text: string) => void;
  onPeers: (count: number) => void;
  /** Guest side: authoritative project pushed by the host. */
  onSnapshot: (cuts: Cut[]) => void;
  /** Host side: an edit proposed by a guest. */
  onOp: (op: RoomOp) => void;
  getSnapshot: () => Cut[];
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

  /** Host: push the authoritative project to every guest. */
  broadcastSnapshot(cuts: Cut[]) {
    if (this.role !== "host") return;
    const payload = JSON.stringify({ type: "snapshot", cuts });
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
        channel.send(JSON.stringify({ type: "snapshot", cuts: this.handlers.getSnapshot() }));
        this.handlers.onStatus("参加者が入室しました");
      } else {
        this.handlers.onStatus("ホストに接続しました");
      }
    };
    channel.onmessage = (event) => {
      const data = JSON.parse(event.data as string) as { type: string; cuts?: Cut[]; op?: RoomOp };
      if (data.type === "snapshot" && data.cuts && this.role === "guest") this.handlers.onSnapshot(data.cuts);
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
export function applyOp(cuts: Cut[], op: RoomOp): Cut[] {
  if (op.type === "strokes") return cuts.map((cut) => (cut.id === op.cutId ? { ...cut, strokes: op.strokes } : cut));
  if (op.type === "patch") return cuts.map((cut) => (cut.id === op.cutId ? { ...cut, ...op.patch } : cut));
  if (op.type === "delete") return cuts.length <= 1 ? cuts : cuts.filter((cut) => cut.id !== op.cutId);
  if (op.type === "add") {
    if (cuts.some((cut) => cut.id === op.cut.id)) return cuts;
    const at = op.afterId ? cuts.findIndex((cut) => cut.id === op.afterId) : -1;
    if (at < 0) return [...cuts, op.cut];
    return [...cuts.slice(0, at + 1), op.cut, ...cuts.slice(at + 1)];
  }
  return cuts;
}
