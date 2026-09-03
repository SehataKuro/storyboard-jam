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
 * Relays SDP/ICE between peers of one room. It never sees storyboard data:
 * the host peer holds the authoritative project, so when the host leaves the room is closed.
 */
export class SignalRoom {
  private peers = new Map<string, Peer>();
  private hostId: string | null = null;

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
    const isHost = this.hostId === null;
    if (isHost) this.hostId = id;
    this.peers.set(id, peer);

    this.send(peer, { type: "welcome", peerId: id, isHost, hostId: this.hostId });
    if (!isHost && this.hostId) {
      const host = this.peers.get(this.hostId);
      if (host) this.send(host, { type: "peer-join", peerId: id });
    }

    server.addEventListener("message", (event) => {
      let message: { type?: string; to?: string; payload?: unknown };
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
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

  private drop(id: string) {
    if (!this.peers.delete(id)) return;
    if (this.hostId === id) {
      // Host owned the only copy of the project, so the room ends with it.
      this.hostId = null;
      this.peers.forEach((peer) => {
        this.send(peer, { type: "host-gone" });
        try { peer.socket.close(1000, "host left"); } catch { /* already closing */ }
      });
      this.peers.clear();
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
