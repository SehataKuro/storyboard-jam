import { env } from "cloudflare:workers";

const ensureSchema = async () => {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS storyboard_projects (
    room TEXT PRIMARY KEY NOT NULL,
    payload TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  )`).run();
};

export async function GET(request: Request) {
  await ensureSchema();
  const room = new URL(request.url).searchParams.get("room") || "main";
  const row = await env.DB.prepare("SELECT payload, version, updated_at AS updatedAt FROM storyboard_projects WHERE room = ?")
    .bind(room).first<{ payload: string; version: number; updatedAt: number }>();
  if (!row) return Response.json({ project: null });
  return Response.json({ project: { cuts: JSON.parse(row.payload), version: row.version, updatedAt: row.updatedAt } });
}

export async function POST(request: Request) {
  await ensureSchema();
  const body = await request.json() as { room?: string; cuts?: unknown };
  const room = (body.room || "main").slice(0, 80);
  if (!Array.isArray(body.cuts)) return Response.json({ error: "cuts is required" }, { status: 400 });
  const payload = JSON.stringify(body.cuts);
  if (payload.length > 900_000) return Response.json({ error: "project is too large" }, { status: 413 });
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO storyboard_projects (room, payload, version, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(room) DO UPDATE SET payload = excluded.payload, version = storyboard_projects.version + 1, updated_at = excluded.updated_at`)
    .bind(room, payload, now).run();
  const row = await env.DB.prepare("SELECT version FROM storyboard_projects WHERE room = ?").bind(room).first<{ version: number }>();
  return Response.json({ version: row?.version || 1, updatedAt: now });
}
