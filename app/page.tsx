"use client";

import { ChangeEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_FPS,
  EXPORT_HEIGHT,
  EXPORT_WIDTH,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  MARGIN_RATIO_X,
  MARGIN_RATIO_Y,
  MIN_CUT_DURATION,
  Point,
  Project,
  Stroke,
  Cut,
  createEmptyProject,
  cutDurationOf,
  cutEndOf,
  cutIndexAt,
  formatFrameDuration,
  formatFramePosition,
  newCutId,
  normalizeProject,
  parseFrameDuration,
  snapToFrame,
} from "./lib/types";
import { Participant, Room, RoomOp, RoomRole, applyOp } from "./lib/p2p";
import { cutLabel } from "./lib/ae";
import { exportMovie, exportSequenceZip } from "./lib/export-media";
import { downloadBlob } from "./lib/zip";
import { readBundleFromFiles, readBundleFromZip } from "./lib/project-io";
import { STROKE_REFERENCE_WIDTH, canvasToPngBlob, drawContainedImage, paintStroke, renderCutToCanvas } from "./lib/render";

const COLORS = ["#171714", "#ff5b3d", "#367c5b", "#2f6fc0", "#8e56a8"];

type Tool = "pen" | "eraser" | "line" | "rect" | "ellipse" | "lasso" | "select";
const SHAPE_TOOLS: { tool: Tool; label: string; hint: string }[] = [
  { tool: "line", label: "直線", hint: "直線 (L)" },
  { tool: "rect", label: "□", hint: "四角 (R)" },
  { tool: "ellipse", label: "○", hint: "円 (O)" },
  { tool: "lasso", label: "投げなわ塗", hint: "投げなわ塗 (G)" },
  { tool: "select", label: "投げなわ選択", hint: "投げなわ選択 (M)" },
];

/** Ray casting, in the same normalised frame coordinates the strokes use. */
function pointInPolygon(point: Point, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * A stroke belongs to the lasso when most of it does. Strokes are whole
 * objects here, so a selection can only take them or leave them.
 */
function strokeInPolygon(stroke: Stroke, polygon: Point[]) {
  if (!stroke.points.length) return false;
  const inside = stroke.points.filter((point) => pointInPolygon(point, polygon)).length;
  return inside * 2 > stroke.points.length;
}

const translateStroke = (stroke: Stroke, dx: number, dy: number): Stroke => ({
  ...stroke,
  points: stroke.points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
});

/**
 * Points for a shape dragged from one corner to another. Shapes are stored as
 * ordinary strokes, so nothing downstream needs to know about them.
 */
function shapePoints(tool: Tool, from: Point, to: Point, constrain: boolean): Point[] {
  let end = to;
  if (constrain) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (tool === "line") {
      // Snap to the nearest eighth turn, the way a set square would.
      const length = Math.hypot(dx, dy);
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      end = { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
    } else {
      const size = Math.max(Math.abs(dx), Math.abs(dy));
      end = { x: from.x + Math.sign(dx) * size, y: from.y + Math.sign(dy) * size };
    }
  }
  if (tool === "line") return [from, end];
  if (tool === "rect") {
    return [from, { x: end.x, y: from.y }, end, { x: from.x, y: end.y }, from];
  }
  const cx = (from.x + end.x) / 2;
  const cy = (from.y + end.y) / 2;
  const rx = (end.x - from.x) / 2;
  const ry = (end.y - from.y) / 2;
  return Array.from({ length: 49 }, (_, index) => {
    const angle = (index / 48) * Math.PI * 2;
    return { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
  });
}
const LEGACY_STORAGE_KEY = "conte-live-project";
const NAME_STORAGE_KEY = "conte-live-name";
/** Shown for anyone who has not typed a name yet. */
const guestLabel = (participant: Participant, index: number) =>
  participant.name.trim() || (participant.isHost ? "ホスト" : `ゲスト${index}`);
const roomStorageKey = (roomId: string) => `${LEGACY_STORAGE_KEY}:${roomId}`;

const SHORTCUTS: [string, string][] = [
  ["Space", "再生 / 停止"],
  ["S", "再生位置でカットを分割"],
  ["B / E", "ペン / 消しゴム"],
  ["L / R / O", "直線 / 四角 / 円（Shiftで正方形・45度）"],
  ["G", "投げなわ塗"],
  ["M", "投げなわ選択（ドラッグで移動、Deleteで削除）"],
  ["[ / ]", "ブラシを細く / 太く"],
  ["← / →", "1コマ移動（Shiftで1秒）"],
  [", / .", "前 / 次のカットへ"],
  ["Ctrl+Z / Ctrl+Shift+Z", "元に戻す / やり直す"],
  ["Ctrl+V", "画像を現在のカットへ貼り付け"],
  ["Ctrl+C / Ctrl+Shift+V", "選択範囲またはカットの絵をコピー / 貼り付け"],
  ["Ctrl+D", "カットを複製"],
  ["Delete", "選択範囲、なければカットを削除"],
  ["?", "このヘルプ"],
];

/**
 * Stage geometry for a given canvas size. Thumbnails show the frame alone;
 * the editor adds the working margin around it.
 */
function frameBox(width: number, height: number, withMargin: boolean) {
  const left = withMargin ? width * MARGIN_RATIO_X : 0;
  const top = withMargin ? height * MARGIN_RATIO_Y : 0;
  return { left, top, width: width - left * 2, height: height - top * 2 };
}

const MAX_STAGE_WIDTH = 1120;
const MIN_TIMELINE_ZOOM = 1;
const MAX_TIMELINE_ZOOM = 40;
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);
const MIN_VIEW_SCALE = 0.2;
const MAX_VIEW_SCALE = 8;
type CutContent = Pick<Cut, "strokes" | "backgroundImage">;

const cutContent = (cut: Cut): CutContent => ({
  strokes: cut.strokes,
  backgroundImage: cut.backgroundImage,
});

async function clipboardImageDataUrl(blob: Blob) {
  const image = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = EXPORT_WIDTH;
    canvas.height = EXPORT_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("貼り付け画像を処理できませんでした");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawContainedImage(ctx, image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/webp", 0.92);
  } finally {
    image.close();
  }
}

function useLoadedImage(source?: string) {
  const [loaded, setLoaded] = useState<{ source: string; image: HTMLImageElement } | null>(null);
  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    const next = new Image();
    next.onload = () => { if (!cancelled) setLoaded({ source, image: next }); };
    next.src = source;
    return () => { cancelled = true; };
  }, [source]);
  return loaded && loaded.source === source ? loaded.image : null;
}

/**
 * Sizes the stage to fit its padded container while keeping the frame-plus-margin ratio.
 * CSS aspect-ratio alone breaks here: max-height clamps the height without shrinking the width.
 */
function fitCanvas(canvas: HTMLCanvasElement) {
  const wrap = canvas.parentElement;
  if (!wrap) return;
  const style = getComputedStyle(wrap);
  const box = wrap.getBoundingClientRect();
  const availableWidth = box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const availableHeight = box.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const ratio = CANVAS_WIDTH / CANVAS_HEIGHT;
  let width = Math.max(1, Math.min(availableWidth, MAX_STAGE_WIDTH));
  let height = width / ratio;
  if (height > availableHeight) {
    height = Math.max(1, availableHeight);
    width = height * ratio;
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
}

function drawCanvas(
  canvas: HTMLCanvasElement,
  strokes: Stroke[],
  backgroundImage: HTMLImageElement | null,
  draft?: Stroke | null,
  thumbnail = false,
  resolution = 1,
  selection?: Point[] | null,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  if (!thumbnail) fitCanvas(canvas);
  const dpr = thumbnail ? 1 : Math.min((window.devicePixelRatio || 1) * Math.max(1, resolution), 3);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fffef8";
  ctx.fillRect(0, 0, width, height);

  const frame = frameBox(width, height, !thumbnail);
  if (backgroundImage) {
    drawContainedImage(ctx, backgroundImage, frame.left, frame.top, frame.width, frame.height);
  }

  if (!thumbnail) {
    ctx.strokeStyle = "rgba(54, 49, 41, .10)";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 7]);
    [1 / 3, 2 / 3].forEach((ratio) => {
      const x = frame.left + frame.width * ratio;
      ctx.beginPath(); ctx.moveTo(x, frame.top); ctx.lineTo(x, frame.top + frame.height); ctx.stroke();
      const y = frame.top + frame.height * ratio;
      ctx.beginPath(); ctx.moveTo(frame.left, y); ctx.lineTo(frame.left + frame.width, y); ctx.stroke();
    });
    ctx.setLineDash([]);
  }

  // Stroke sizes are authored against the frame, so editor, thumbnail and export all match.
  [...strokes, ...(draft ? [draft] : [])].forEach((stroke) => paintStroke(ctx, stroke, frame, thumbnail ? .5 : 1));

  if (selection && selection.length > 1 && !thumbnail) {
    // Marching-ants outline so the selected region reads as a selection and
    // never as part of the drawing.
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(20, 20, 20, .85)";
    ctx.beginPath();
    ctx.moveTo(frame.left + selection[0].x * frame.width, frame.top + selection[0].y * frame.height);
    selection.slice(1).forEach((point) => ctx.lineTo(frame.left + point.x * frame.width, frame.top + point.y * frame.height));
    ctx.closePath();
    ctx.stroke();
    ctx.strokeStyle = "rgba(255, 255, 255, .9)";
    ctx.lineDashOffset = 5;
    ctx.stroke();
    ctx.restore();
  }

  if (!thumbnail) {
    // Everything outside the frame is drawable but will not be exported, so dim it.
    ctx.fillStyle = "rgba(0, 0, 0, .5)";
    ctx.fillRect(0, 0, width, frame.top);
    ctx.fillRect(0, frame.top + frame.height, width, height - frame.top - frame.height);
    ctx.fillRect(0, frame.top, frame.left, frame.height);
    ctx.fillRect(frame.left + frame.width, frame.top, width - frame.left - frame.width, frame.height);

    ctx.strokeStyle = "rgba(255, 255, 255, .55)";
    ctx.lineWidth = 1;
    ctx.strokeRect(frame.left + .5, frame.top + .5, frame.width - 1, frame.height - 1);
  }
}

function MiniCanvas({ strokes, backgroundImage }: { strokes: Stroke[]; backgroundImage?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const image = useLoadedImage(backgroundImage);
  useEffect(() => {
    if (ref.current) drawCanvas(ref.current, strokes, image, null, true);
  }, [strokes, image]);
  return <canvas ref={ref} className="mini-canvas" aria-hidden="true" />;
}

/**
 * A text field that keeps its own value while focused.
 *
 * Two problems come from binding these straight to the shared project: an IME
 * commits its pre-conversion text on every keystroke, and the snapshot that
 * comes back from the room arrives late enough to resurrect characters the
 * user has already deleted. Letting the field own its text and only adopting
 * the incoming value while unfocused fixes both.
 */
function BufferedField({
  value,
  onCommit,
  multiline,
  ...rest
}: {
  value: string;
  onCommit: (value: string) => void;
  multiline?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement> & React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">) {
  // The DOM element owns the text while it is being edited; React only pushes
  // an incoming value in when the field is not the one being typed into.
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const composing = useRef(false);
  useEffect(() => {
    const field = fieldRef.current;
    if (!field || field === document.activeElement || field.value === value) return;
    field.value = value;
  }, [value]);

  const handlers = {
    ref: fieldRef,
    defaultValue: value,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      // Mid-conversion IME text is not an edit yet; compositionend commits it.
      if (!composing.current) onCommit(event.target.value);
    },
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: (event: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      composing.current = false;
      onCommit((event.target as HTMLInputElement | HTMLTextAreaElement).value);
    },
  };
  return multiline
    ? <textarea {...rest} {...handlers} />
    : <input {...rest} {...handlers} />;
}

const ROLE_LABEL: Record<RoomRole, string> = {
  connecting: "接続中…",
  host: "ホスト（このタブが原本）",
  guest: "ゲスト参加中",
  closed: "切断（ローカル編集のみ）",
};

export default function Home() {
  const [project, setProject] = useState<Project>(() => createEmptyProject());
  const [activeId, setActiveId] = useState("");
  const [selectedTool, setSelectedTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [brushSize, setBrushSize] = useState(3);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [audioName, setAudioName] = useState("");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [volume, setVolume] = useState(0.8);
  const [zoom, setZoom] = useState(1);
  const [panelOpen, setPanelOpen] = useState(true);
  const [toast, setToast] = useState("ルームを開きました");
  const [draft, setDraft] = useState<Stroke | null>(null);
  const [collabPulse, setCollabPulse] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [durationInput, setDurationInput] = useState("0+1");
  const [role, setRole] = useState<RoomRole>("connecting");
  const [peers, setPeers] = useState(0);
  const [busy, setBusy] = useState<{ label: string; ratio: number } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  /** Live preview while a boundary is being dragged; committed on release. */
  const [drag, setDrag] = useState<{ cutId: string; start: number } | null>(null);
  /** True while the playhead is being dragged along the timeline. */
  const [scrubbing, setScrubbing] = useState(false);
  /** True while the timeline is being panned with the middle button. */
  const [panning, setPanning] = useState(false);
  /** How the drawing stage is being looked at: zoom, rotation and offset. */
  const [view, setView] = useState({ scale: 1, angle: 0, x: 0, y: 0 });
  /** Follows the pointer over the stage so the brush shows its real size. */
  const [brushRing, setBrushRing] = useState<{ x: number; y: number } | null>(null);
  /** Which stage navigation gesture the middle button started, if any. */
  const [stageDrag, setStageDrag] = useState<"pan" | "rotate" | null>(null);
  /** Laid-out width of the stage, used to size the brush ring. */
  const [canvasWidth, setCanvasWidth] = useState(0);
  /** Index of the cut card being dragged onto another to swap the drawings. */
  const [dragCutId, setDragCutId] = useState<string | null>(null);
  /** The lasso selection: its outline plus which strokes it caught. */
  const [selection, setSelection] = useState<{ polygon: Point[]; indexes: number[] } | null>(null);
  /** Live offset while the selection is being dragged to a new place. */
  const [selectionOffset, setSelectionOffset] = useState<Point | null>(null);
  /** Everyone in the room, as published by the host. */
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [userName, setUserName] = useState("");
  const [peopleOpen, setPeopleOpen] = useState(false);
  /** True once the host has removed us, so reconnecting is not offered. */
  const [evicted, setEvicted] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const dragIndexRef = useRef(-1);
  /** Where a shape drag started, in frame coordinates. */
  const shapeOriginRef = useRef<Point | null>(null);
  const animationRef = useRef<number | null>(null);
  const playStartRef = useRef({ at: 0, time: 0 });
  const historyRef = useRef<Record<string, CutContent[]>>({});
  /** Cut content copied with Ctrl+C, pasted into another cut with Ctrl+Shift+V. */
  const cutClipboardRef = useRef<CutContent | null>(null);
  /** Strokes copied out of a lasso selection, pasted in place. */
  const strokeClipboardRef = useRef<Stroke[] | null>(null);
  /** Where a selection drag started, so the offset can be measured. */
  const selectionDragRef = useRef<Point | null>(null);
  const redoRef = useRef<Record<string, CutContent[]>>({});
  const roomRef = useRef<Room | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const projectRef = useRef<Project>(project);
  const projectNameRef = useRef(projectName);
  const previousRoleRef = useRef<RoomRole>("connecting");

  // While dragging a boundary the UI shows the pending position, not the committed one.
  const displayProject = useMemo(
    () => (drag ? applyOp(project, { type: "move", cutId: drag.cutId, start: drag.start }) : project),
    [project, drag],
  );
  const cuts = displayProject.cuts;
  const totalDuration = displayProject.duration;
  const activeIndex = Math.max(0, cuts.findIndex((cut) => cut.id === activeId));
  const activeCut = cuts[activeIndex] || cuts[0];
  const activeBackgroundImage = useLoadedImage(activeCut?.backgroundImage);
  const activeDuration = cutDurationOf(displayProject, activeIndex);
  const isLastCut = activeIndex === cuts.length - 1;
  const exportName = projectName.trim() || "storyboard";

  useEffect(() => { projectRef.current = project; }, [project]);
  useEffect(() => { projectNameRef.current = projectName; }, [projectName]);
  useEffect(() => { setDurationInput(formatFrameDuration(activeDuration)); }, [activeDuration, activeId]);
  useEffect(() => { setSelection(null); setSelectionOffset(null); }, [activeId, selectedTool]);

  /** Local edits go through here: the host owns state, guests only propose. */
  const mutate = useCallback((op: RoomOp) => {
    const room = roomRef.current;
    if (!room?.canEdit()) {
      setToast("接続が完了してから編集してください");
      return false;
    }
    const next = applyOp(projectRef.current, op);
    projectRef.current = next;
    setProject(next);
    if (room.isHost()) room.broadcastSnapshot(next, projectNameRef.current);
    else room.sendOp(op);
    return true;
  }, []);

  const renameUser = useCallback((value: string) => {
    setUserName(value);
    try {
      window.localStorage.setItem(NAME_STORAGE_KEY, value);
    } catch { /* a missing name is not worth interrupting the session */ }
    roomRef.current?.setName(value);
  }, []);

  const kickParticipant = useCallback((participant: Participant, index: number) => {
    if (!window.confirm(`${guestLabel(participant, index)} をルームから退出させますか？`)) return;
    roomRef.current?.kick(participant.id);
    setToast(`${guestLabel(participant, index)} を退出させました`);
  }, []);

  const renameProject = useCallback((value: string) => {
    const room = roomRef.current;
    if (!room?.canEdit()) {
      setToast("接続が完了してから編集してください");
      return false;
    }
    projectNameRef.current = value;
    setProjectName(value);
    if (room.isHost()) room.broadcastSnapshot(projectRef.current, value);
    else room.sendOp({ type: "rename", value });
    return true;
  }, []);

  // Every connected participant keeps a room-scoped recovery copy. Guests
  // receive the host's authoritative snapshots, so one can safely take over
  // after the host disconnects and the room elects a replacement.
  useEffect(() => {
    const roomId = roomIdRef.current;
    if (role === "connecting" || !roomId) return;
    try {
      window.localStorage.setItem(roomStorageKey(roomId), JSON.stringify({ project, projectName }));
    } catch {
      setToast("端末の保存容量が足りないため、バックアップできませんでした");
    }
  }, [project, projectName, role]);

  useEffect(() => {
    const url = new URL(window.location.href);
    let roomId = url.searchParams.get("room");
    const isExistingRoom = Boolean(roomId);
    if (!roomId) {
      // A fresh visit opens its own room so boards are not shared by guessing the URL.
      roomId = Math.random().toString(36).slice(2, 10);
      url.searchParams.set("room", roomId);
      window.history.replaceState(null, "", url.toString());
    }
    roomIdRef.current = roomId;

    // Storage used to be shared by every room. Move that data into the first
    // existing room opened after this update, while keeping brand-new rooms blank.
    const storageKey = roomStorageKey(roomId);
    let stored = window.localStorage.getItem(storageKey);
    if (!stored && isExistingRoom) {
      const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        stored = legacy;
        window.localStorage.setItem(storageKey, legacy);
        window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    }
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as { project?: Project; projectName?: string };
        if (parsed.project?.cuts?.length) {
          const restored = normalizeProject(parsed.project);
          projectRef.current = restored;
          setProject(restored);
          setActiveId(restored.cuts[0].id);
        }
        if (parsed.projectName) {
          projectNameRef.current = parsed.projectName;
          setProjectName(parsed.projectName);
        }
      } catch { /* start this room from an empty board */ }
    }

    const pulse = () => {
      setCollabPulse(true);
      window.setTimeout(() => setCollabPulse(false), 900);
    };

    const storedName = window.localStorage.getItem(NAME_STORAGE_KEY) || "";
    setUserName(storedName);

    const room = new Room(roomId, {
      onRole: setRole,
      onStatus: setToast,
      onPeers: setPeers,
      onSnapshot: (incoming) => {
        projectRef.current = incoming.project;
        projectNameRef.current = incoming.projectName;
        setProject(incoming.project);
        setProjectName(incoming.projectName);
        setActiveId((current) => (incoming.project.cuts.some((cut) => cut.id === current) ? current : incoming.project.cuts[0]?.id || current));
        pulse();
      },
      onRoster: setParticipants,
      onEvicted: () => setEvicted(true),
      onOp: (op) => {
        if (op.type === "rename") {
          projectNameRef.current = op.value;
          setProjectName(op.value);
          roomRef.current?.broadcastSnapshot(projectRef.current, op.value);
          pulse();
          return;
        }
        const next = applyOp(projectRef.current, op);
        projectRef.current = next;
        setProject(next);
        roomRef.current?.broadcastSnapshot(next, projectNameRef.current);
        pulse();
      },
      getSnapshot: () => ({ project: projectRef.current, projectName: projectNameRef.current }),
    });
    roomRef.current = room;
    room.connect();
    room.setName(storedName);
    return () => { room.close(); roomRef.current = null; };
  }, []);

  useEffect(() => {
    const previousRole = previousRoleRef.current;
    previousRoleRef.current = role;
    if (previousRole !== "guest" || role !== "closed" || evicted) return;

    const shouldReload = window.confirm(
      "ホストとの接続が切断されました。再読み込みして再接続しますか？",
    );
    if (shouldReload) window.location.reload();
  }, [role, evicted]);

  /** What the stage shows: a selection being dragged moves before it is committed. */
  const displayStrokes = useMemo(() => {
    if (!activeCut) return [];
    if (!selection || !selectionOffset) return activeCut.strokes;
    return activeCut.strokes.map((stroke, index) => (selection.indexes.includes(index)
      ? translateStroke(stroke, selectionOffset.x, selectionOffset.y)
      : stroke));
  }, [activeCut, selection, selectionOffset]);

  const displaySelection = useMemo(() => {
    if (!selection) return null;
    return selectionOffset
      ? selection.polygon.map((point) => ({ x: point.x + selectionOffset.x, y: point.y + selectionOffset.y }))
      : selection.polygon;
  }, [selection, selectionOffset]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeCut) return;
    drawCanvas(canvas, displayStrokes, activeBackgroundImage, draft, false, view.scale, displaySelection);
  }, [activeCut, activeBackgroundImage, displayStrokes, displaySelection, draft, panelOpen, view.scale]);

  useEffect(() => {
    const onResize = () => {
      if (canvasRef.current && activeCut) drawCanvas(canvasRef.current, displayStrokes, activeBackgroundImage, draft, false, view.scale, displaySelection);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [activeCut, activeBackgroundImage, displayStrokes, displaySelection, draft, view.scale]);

  // Playback position is intentionally local: every participant scrubs independently.
  useEffect(() => {
    const found = project.cuts[cutIndexAt(project, currentTime)]?.id;
    if (found && found !== activeId) setActiveId(found);
  }, [activeId, currentTime, project]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume, audioUrl]);

  useEffect(() => {
    if (!playing) {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      return;
    }
    const tick = () => {
      const audio = audioRef.current;
      const next = audioUrl && audio && !audio.paused
        ? audio.currentTime
        : playStartRef.current.time + (performance.now() - playStartRef.current.at) / 1000;
      if (next >= totalDuration) {
        setCurrentTime(totalDuration);
        setPlaying(false);
        audio?.pause();
        return;
      }
      setCurrentTime(next);
      animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
    return () => { if (animationRef.current) cancelAnimationFrame(animationRef.current); };
  }, [playing, audioUrl, totalDuration]);

  // Follow the playhead when the timeline is zoomed past the viewport.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || zoom <= 1) return;
    const x = (currentTime / totalDuration) * viewport.scrollWidth;
    if (x < viewport.scrollLeft || x > viewport.scrollLeft + viewport.clientWidth - 40) {
      viewport.scrollLeft = Math.max(0, x - viewport.clientWidth / 2);
    }
  }, [currentTime, zoom, totalDuration]);

  const seek = useCallback((time: number) => {
    const next = snapToFrame(Math.max(0, Math.min(totalDuration, time)));
    setCurrentTime(next);
    if (audioRef.current) audioRef.current.currentTime = Math.min(next, audioRef.current.duration || next);
    playStartRef.current = { at: performance.now(), time: next };
  }, [totalDuration]);

  const togglePlay = useCallback(async () => {
    if (playing) {
      setPlaying(false);
      audioRef.current?.pause();
      return;
    }
    const from = currentTime >= totalDuration ? 0 : currentTime;
    if (from !== currentTime) seek(0);
    playStartRef.current = { at: performance.now(), time: from };
    setPlaying(true);
    if (audioUrl && audioRef.current) {
      audioRef.current.currentTime = from;
      await audioRef.current.play().catch(() => setPlaying(false));
    }
  }, [playing, currentTime, totalDuration, audioUrl, seek]);

  /**
   * Client pixels to untransformed canvas pixels. The bounding box is useless
   * once the stage is rotated, so the view transform is inverted by hand
   * around the stage centre.
   */
  const canvasPoint = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return { x: 0, y: 0, width: 1, height: 1 };
    const box = stage.getBoundingClientRect();
    const dx = clientX - (box.left + box.width / 2) - view.x;
    const dy = clientY - (box.top + box.height / 2) - view.y;
    const cos = Math.cos(-view.angle);
    const sin = Math.sin(-view.angle);
    const width = canvas.offsetWidth || 1;
    const height = canvas.offsetHeight || 1;
    return {
      x: (dx * cos - dy * sin) / view.scale + width / 2,
      y: (dx * sin + dy * cos) / view.scale + height / 2,
      width,
      height,
    };
  }, [view]);

  // Coordinates are normalised against the frame, so values outside 0..1 sit in the margin.
  const pointerPoint = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const local = canvasPoint(event.clientX, event.clientY);
    const frame = frameBox(local.width, local.height, true);
    return {
      x: (local.x - frame.left) / frame.width,
      y: (local.y - frame.top) / frame.height,
    };
  };

  const resetView = useCallback(() => setView({ scale: 1, angle: 0, x: 0, y: 0 }), []);

  // Clip Studio style stage navigation: the wheel zooms at the cursor, the
  // middle button pans and shift+middle rotates.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = stage.getBoundingClientRect();
      const pointerX = event.clientX - (box.left + box.width / 2);
      const pointerY = event.clientY - (box.top + box.height / 2);
      setView((current) => {
        const scale = clamp(current.scale * Math.exp(-event.deltaY * 0.0015), MIN_VIEW_SCALE, MAX_VIEW_SCALE);
        const factor = scale / current.scale;
        return {
          ...current,
          scale,
          x: pointerX - (pointerX - current.x) * factor,
          y: pointerY - (pointerY - current.y) * factor,
        };
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  const beginStageNavigation = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 1) return;
    event.preventDefault();
    setStageDrag(event.shiftKey ? "rotate" : "pan");
  };

  useEffect(() => {
    if (!stageDrag) return;
    const onMove = (event: PointerEvent) => {
      if (stageDrag === "pan") {
        setView((current) => ({ ...current, x: current.x + event.movementX, y: current.y + event.movementY }));
        return;
      }
      setView((current) => ({ ...current, angle: current.angle + event.movementX * 0.005 }));
    };
    const onUp = () => setStageDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [stageDrag]);

  const beginStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    if (!roomRef.current?.canEdit()) {
      setToast("接続が完了してから編集してください");
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointerPoint(event);

    if (selectedTool === "select") {
      // Starting inside an existing selection moves it; anywhere else draws a new lasso.
      if (selection && pointInPolygon(point, selection.polygon)) {
        selectionDragRef.current = point;
        setSelectionOffset({ x: 0, y: 0 });
        return;
      }
      setSelection(null);
      setSelectionOffset(null);
      shapeOriginRef.current = point;
      setDraft({ color: "#3b6ea5", size: 1, points: [point] });
      return;
    }

    shapeOriginRef.current = point;
    setDraft({
      color,
      size: selectedTool === "eraser" ? brushSize * 4 : brushSize,
      eraser: selectedTool === "eraser",
      fill: selectedTool === "lasso" ? true : undefined,
      points: [point],
    });
  };

  const moveStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const dragStart = selectionDragRef.current;
    if (dragStart) {
      const point = pointerPoint(event);
      setSelectionOffset({ x: point.x - dragStart.x, y: point.y - dragStart.y });
      return;
    }
    if (!draft || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const point = pointerPoint(event);
    const origin = shapeOriginRef.current;
    // A shape is re-derived from its two corners; pen, eraser and lasso trail.
    if (origin && (selectedTool === "line" || selectedTool === "rect" || selectedTool === "ellipse")) {
      const points = shapePoints(selectedTool, origin, point, event.shiftKey);
      setDraft((old) => (old ? { ...old, points } : old));
      return;
    }
    setDraft((old) => old ? { ...old, points: [...old.points, point] } : old);
  };

  const endStroke = () => {
    shapeOriginRef.current = null;

    // Committing a moved selection: the strokes it holds move with it.
    if (selectionDragRef.current) {
      selectionDragRef.current = null;
      const offset = selectionOffset;
      setSelectionOffset(null);
      if (!selection || !offset || (!offset.x && !offset.y)) return;
      const moved = activeCut.strokes.map((stroke, index) => (selection.indexes.includes(index)
        ? translateStroke(stroke, offset.x, offset.y)
        : stroke));
      if (mutate({ type: "strokes", cutId: activeId, strokes: moved })) {
        historyRef.current[activeId] = [...(historyRef.current[activeId] || []), cutContent(activeCut)];
        redoRef.current[activeId] = [];
        setSelection({
          polygon: selection.polygon.map((point) => ({ x: point.x + offset.x, y: point.y + offset.y })),
          indexes: selection.indexes,
        });
      }
      return;
    }

    if (!draft) return;

    // The select tool never leaves a mark: its lasso becomes the selection.
    if (selectedTool === "select") {
      const polygon = draft.points;
      setDraft(null);
      if (polygon.length < 3) return;
      const indexes = activeCut.strokes.reduce<number[]>((found, stroke, index) => {
        if (strokeInPolygon(stroke, polygon)) found.push(index);
        return found;
      }, []);
      if (!indexes.length) {
        setToast("選択範囲に線がありませんでした");
        return;
      }
      setSelection({ polygon, indexes });
      setToast(`${indexes.length}本の線を選択しました（Ctrl+Cでコピー、ドラッグで移動）`);
      return;
    }

    if (mutate({ type: "strokes", cutId: activeId, strokes: [...activeCut.strokes, draft] })) {
      historyRef.current[activeId] = [...(historyRef.current[activeId] || []), cutContent(activeCut)];
      redoRef.current[activeId] = [];
    }
    setDraft(null);
  };

  const undo = useCallback(() => {
    const cut = projectRef.current.cuts.find((c) => c.id === activeId);
    const history = historyRef.current[activeId] || [];
    if (!cut || !history.length) return;
    if (mutate({ type: "content", cutId: activeId, ...history[history.length - 1] })) {
      redoRef.current[activeId] = [...(redoRef.current[activeId] || []), cutContent(cut)];
      historyRef.current[activeId] = history.slice(0, -1);
    }
  }, [activeId, mutate]);

  const redo = useCallback(() => {
    const cut = projectRef.current.cuts.find((c) => c.id === activeId);
    const redoStack = redoRef.current[activeId] || [];
    if (!cut || !redoStack.length) return;
    if (mutate({ type: "content", cutId: activeId, ...redoStack[redoStack.length - 1] })) {
      historyRef.current[activeId] = [...(historyRef.current[activeId] || []), cutContent(cut)];
      redoRef.current[activeId] = redoStack.slice(0, -1);
    }
  }, [activeId, mutate]);

  const pasteImageBlob = useCallback(async (blob: Blob) => {
    const cut = projectRef.current.cuts.find((item) => item.id === activeId);
    if (!cut) return;
    const backgroundImage = await clipboardImageDataUrl(blob);
    if (mutate({ type: "content", cutId: cut.id, strokes: cut.strokes, backgroundImage })) {
      historyRef.current[cut.id] = [...(historyRef.current[cut.id] || []), cutContent(cut)];
      redoRef.current[cut.id] = [];
      setToast("クリップボードの画像を貼り付けました");
    }
  }, [activeId, mutate]);

  const pasteFromClipboard = useCallback(async () => {
    if (!navigator.clipboard?.read) {
      setToast("このブラウザではボタンから読めません。Ctrl+Vで貼り付けてください");
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith("image/"));
        if (!imageType) continue;
        await pasteImageBlob(await item.getType(imageType));
        return;
      }
      setToast("クリップボードに画像がありません");
    } catch {
      setToast("クリップボードを読めませんでした。Ctrl+Vをお試しください");
    }
  }, [pasteImageBlob]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const image = Array.from(event.clipboardData?.items || [])
        .find((item) => item.type.startsWith("image/"))
        ?.getAsFile();
      if (!image) return;
      event.preventDefault();
      void pasteImageBlob(image).catch(() => setToast("画像の貼り付けに失敗しました"));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [pasteImageBlob]);

  const clearActiveCut = useCallback(() => {
    const cut = projectRef.current.cuts.find((item) => item.id === activeId);
    if (!cut || (!cut.strokes.length && !cut.backgroundImage)) {
      setToast("現在のカットに消去する絵がありません");
      return;
    }
    if (!window.confirm("現在のカットの描画と貼り付け画像をすべて消去しますか？")) return;
    if (mutate({ type: "content", cutId: cut.id, strokes: [] })) {
      historyRef.current[cut.id] = [...(historyRef.current[cut.id] || []), cutContent(cut)];
      redoRef.current[cut.id] = [];
      setDraft(null);
      setToast("現在のカットを全消去しました（元に戻せます）");
    }
  }, [activeId, mutate]);

  /** Cuts are created by splitting the song at the playhead, never by appending a length. */
  const splitAtPlayhead = useCallback(() => {
    const current = projectRef.current;
    if (currentTime < MIN_CUT_DURATION || currentTime > current.duration - MIN_CUT_DURATION) {
      setToast("この位置では分割できません");
      return;
    }
    if (current.cuts.some((cut) => Math.abs(cut.start - currentTime) < MIN_CUT_DURATION)) {
      setToast("すでにこの位置で分割されています");
      return;
    }
    const id = newCutId();
    if (mutate({ type: "split", at: currentTime, id })) {
      setActiveId(id);
      setToast(`${formatFramePosition(currentTime)} で分割しました`);
    }
  }, [currentTime, mutate]);

  const deleteCut = useCallback(() => {
    if (projectRef.current.cuts.length <= 1) {
      setToast("最後のカットは削除できません");
      return;
    }
    const remaining = projectRef.current.cuts.filter((cut) => cut.id !== activeId);
    if (mutate({ type: "delete", cutId: activeId })) {
      setActiveId(remaining[Math.max(0, Math.min(activeIndex, remaining.length - 1))].id);
      setToast("カットを削除しました");
    }
  }, [activeId, activeIndex, mutate]);

  /** Records the current content so the next content change can be undone. */
  const rememberContent = (cut: Cut) => {
    historyRef.current[cut.id] = [...(historyRef.current[cut.id] || []), cutContent(cut)];
    redoRef.current[cut.id] = [];
  };

  /** Swaps two drawings without touching either cut's place on the song. */
  const swapCutContent = useCallback((aId: string, bId: string) => {
    const current = projectRef.current;
    const a = current.cuts.find((cut) => cut.id === aId);
    const b = current.cuts.find((cut) => cut.id === bId);
    if (!a || !b || a === b) return;
    if (mutate({ type: "swap", aId, bId })) {
      rememberContent(a);
      rememberContent(b);
      setToast("カットの絵を入れ替えました");
    }
  }, [mutate]);

  const copyCutContent = useCallback(() => {
    const cut = projectRef.current.cuts.find((item) => item.id === activeId);
    if (!cut) return;
    if (selection?.indexes.length) {
      strokeClipboardRef.current = selection.indexes.map((index) => cut.strokes[index]).filter(Boolean);
      cutClipboardRef.current = null;
      setToast(`選択範囲の${strokeClipboardRef.current.length}本をコピーしました`);
      return;
    }
    cutClipboardRef.current = cutContent(cut);
    strokeClipboardRef.current = null;
    setToast("カットの絵をコピーしました");
  }, [activeId, selection]);

  /** Drops the selected strokes, leaving the rest of the cut alone. */
  const deleteSelection = useCallback(() => {
    const cut = projectRef.current.cuts.find((item) => item.id === activeId);
    if (!cut || !selection) return;
    const strokes = cut.strokes.filter((_, index) => !selection.indexes.includes(index));
    if (mutate({ type: "strokes", cutId: activeId, strokes })) {
      rememberContent(cut);
      setSelection(null);
      setToast("選択範囲を削除しました");
    }
  }, [activeId, mutate, selection]);

  const pasteCutContent = useCallback(() => {
    const cut = projectRef.current.cuts.find((item) => item.id === activeId);
    const copiedStrokes = strokeClipboardRef.current;
    if (copiedStrokes?.length && cut) {
      // A copied selection lands on top of the cut, in the place it was cut from.
      if (mutate({ type: "strokes", cutId: activeId, strokes: [...cut.strokes, ...copiedStrokes] })) {
        rememberContent(cut);
        setToast(`選択範囲の${copiedStrokes.length}本を貼り付けました`);
      }
      return;
    }
    const copied = cutClipboardRef.current;
    if (!copied || !cut) {
      setToast("コピーされたカットがありません");
      return;
    }
    if (mutate({ type: "content", cutId: cut.id, ...copied })) {
      rememberContent(cut);
      setToast("カットの絵を貼り付けました");
    }
  }, [activeId, mutate]);

  /** Duplicating splits the cut in half and fills the second half with a copy. */
  const duplicateCut = useCallback(() => {
    const current = projectRef.current;
    const index = current.cuts.findIndex((cut) => cut.id === activeId);
    const cut = current.cuts[index];
    if (!cut) return;
    const end = cutEndOf(current, index);
    const at = snapToFrame(cut.start + (end - cut.start) / 2);
    if (at - cut.start < MIN_CUT_DURATION || end - at < MIN_CUT_DURATION) {
      setToast("このカットは短すぎて複製できません");
      return;
    }
    const id = newCutId();
    if (mutate({ type: "split", at, id, content: { ...cutContent(cut), title: cut.title, note: cut.note } })) {
      setActiveId(id);
      seek(at);
      setToast("カットを複製しました");
    }
  }, [activeId, mutate, seek]);

  const updateActive = (patch: { title?: string; note?: string }) =>
    mutate({ type: "patch", cutId: activeId, patch });

  /** Editing a cut's length moves the boundary that follows it; the song length never changes. */
  const updateActiveDuration = (seconds: number) => {
    const next = cuts[activeIndex + 1];
    if (!next) return;
    mutate({ type: "move", cutId: next.id, start: activeCut.start + Math.max(MIN_CUT_DURATION, seconds) });
  };

  const commitDurationInput = () => {
    const seconds = parseFrameDuration(durationInput);
    if (seconds === null) {
      setDurationInput(formatFrameDuration(activeDuration));
      setToast(`尺は「秒+コマ」で入力してください（24fps、最小 0+1）`);
      return;
    }
    updateActiveDuration(seconds);
  };

  const chooseCut = useCallback((index: number) => {
    const cut = projectRef.current.cuts[index];
    if (!cut) return;
    setActiveId(cut.id);
    seek(cut.start);
  }, [seek]);

  const onAudio = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!roomRef.current?.canEdit()) {
      event.target.value = "";
      setToast("接続が完了してから音源を読み込んでください");
      return;
    }
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    const url = URL.createObjectURL(file);
    setAudioUrl(url);
    setAudioFile(file);
    setAudioName(file.name.replace(/\.[^.]+$/, ""));
    setPlaying(false);
    seek(0);
    // The song owns the total length, so adopt it as soon as the metadata arrives.
    const probe = new Audio(url);
    probe.onloadedmetadata = () => {
      if (!Number.isFinite(probe.duration) || probe.duration <= 0) return;
      mutate({ type: "duration", value: probe.duration });
      setToast(`楽曲に合わせて全体を ${formatFramePosition(probe.duration)} にしました`);
    };
  };

  const exportFrame = async () => {
    try {
      const canvas = await renderCutToCanvas(
        activeCut.strokes,
        EXPORT_WIDTH,
        EXPORT_HEIGHT,
        activeCut.backgroundImage,
      );
      const blob = await canvasToPngBlob(canvas);
      downloadBlob(blob, `${cutLabel(activeCut.title, activeIndex)}.png`);
      setToast("現在のカットを書き出しました");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "PNGの書き出しに失敗しました");
    }
  };

  /** Restores a board from an exported bundle: the ZIP itself or its extracted folder. */
  const importBundle = async (event: ChangeEvent<HTMLInputElement>, from: "zip" | "folder") => {
    const files = event.target.files;
    if (!files?.length) return;
    try {
      const bundle = from === "zip" ? await readBundleFromZip(files[0]) : await readBundleFromFiles(files);
      if (!mutate({ type: "replace", project: bundle.project })) return;
      if (bundle.projectName) renameProject(bundle.projectName);
      setActiveId(bundle.project.cuts[0].id);
      historyRef.current = {};
      redoRef.current = {};
      seek(0);
      setToast(bundle.strokesRestored
        ? `${bundle.project.cuts.length}カットを読み込みました`
        : `カット割りのみ読み込みました（絵は含まれていません）`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "読み込みに失敗しました");
    } finally {
      event.target.value = "";
    }
  };

  const shareRoom = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(location.href);
      setToast("招待リンクをコピーしました");
    } catch {
      setToast("招待リンクをコピーできませんでした。URL欄からコピーしてください");
    }
  };

  const runExport = async (label: string, task: () => Promise<void>) => {
    if (busy) return;
    setBusy({ label, ratio: 0 });
    try {
      await task();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "書き出しに失敗しました");
    } finally {
      setBusy(null);
    }
  };

  const exportSequence = () => runExport("連番書き出し", async () => {
    const blob = await exportSequenceZip(projectRef.current, {
      fps: DEFAULT_FPS,
      width: EXPORT_WIDTH,
      height: EXPORT_HEIGHT,
      projectName: exportName,
      onProgress: (ratio, label) => setBusy({ ratio, label }),
    });
    downloadBlob(blob, `${exportName}_sequence.zip`);
    setToast("連番PNGとAEスクリプトを書き出しました");
  });

  const exportMp4 = () => runExport("ムービー書き出し", async () => {
    const result = await exportMovie(projectRef.current, audioFile, {
      fps: DEFAULT_FPS,
      width: EXPORT_WIDTH,
      height: EXPORT_HEIGHT,
      projectName: exportName,
      onProgress: (ratio, label) => setBusy({ ratio, label }),
    });
    downloadBlob(result.blob, `${exportName}.mp4`);
    if (result.hadAudio && !result.audioCodec) setToast("音声コーデック非対応のため映像のみ書き出しました");
    else if (!result.hadAudio) setToast("音源未読み込みのため映像のみ書き出しました");
    // Opus inside MP4 plays in browsers but After Effects will not read it.
    else if (result.audioCodec === "opus") setToast("AAC非対応環境のため音声はOpusです（AEでは読めません）");
    else setToast("音声付きMP4を書き出しました");
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never steal keys from the cut name, note or any slider.
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (busy) return;

      const step = event.shiftKey ? 1 : 1 / DEFAULT_FPS;
      const key = event.key;

      if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "c") {
        event.preventDefault();
        copyCutContent();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && key.toLowerCase() === "v") {
        event.preventDefault();
        pasteCutContent();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateCut();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      switch (key) {
        case " ": event.preventDefault(); void togglePlay(); break;
        case "s": case "S": event.preventDefault(); splitAtPlayhead(); break;
        case "b": case "B": setSelectedTool("pen"); break;
        case "e": case "E": setSelectedTool("eraser"); break;
        case "l": case "L": setSelectedTool("line"); break;
        case "r": case "R": setSelectedTool("rect"); break;
        case "o": case "O": setSelectedTool("ellipse"); break;
        case "g": case "G": setSelectedTool("lasso"); break;
        case "[": setBrushSize((size) => Math.max(1, size - 1)); break;
        case "]": setBrushSize((size) => Math.min(14, size + 1)); break;
        case "ArrowLeft": event.preventDefault(); seek(currentTime - step); break;
        case "ArrowRight": event.preventDefault(); seek(currentTime + step); break;
        case ",": chooseCut(activeIndex - 1); break;
        case ".": chooseCut(activeIndex + 1); break;
        case "m": case "M": setSelectedTool("select"); break;
        case "Delete": if (selection) deleteSelection(); else deleteCut(); break;
        case "?": setHelpOpen((open) => !open); break;
        case "Escape": setHelpOpen(false); setSelection(null); break;
        default: break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, currentTime, activeIndex, togglePlay, splitAtPlayhead, deleteCut, chooseCut, seek, undo, redo,
    copyCutContent, pasteCutContent, duplicateCut, deleteSelection, selection]);

  const onTimelinePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    seek(((event.clientX - rect.left) / rect.width) * totalDuration);
    setScrubbing(true);
  };

  /** Where a boundary is allowed to land: never past its neighbours. */
  const boundaryRange = useCallback((index: number) => {
    const current = projectRef.current;
    const lower = current.cuts[index - 1].start + MIN_CUT_DURATION;
    const upper = (index + 1 < current.cuts.length ? current.cuts[index + 1].start : current.duration) - MIN_CUT_DURATION;
    return { lower, upper };
  }, []);

  const timeAtClientX = useCallback((clientX: number) => {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return ((clientX - rect.left) / rect.width) * totalDuration;
  }, [totalDuration]);

  // Dragging the timeline scrubs the playhead. Tracked on the window so the
  // drag keeps working once the pointer leaves the timeline.
  useEffect(() => {
    if (!scrubbing) return;
    const onMove = (event: PointerEvent) => {
      event.preventDefault();
      seek(timeAtClientX(event.clientX));
    };
    const onUp = () => setScrubbing(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [scrubbing, seek, timeAtClientX]);

  const beginBoundaryDrag = (event: ReactPointerEvent<HTMLButtonElement>, index: number) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    dragIndexRef.current = index;
    setScrubbing(false);
    setDrag({ cutId: cuts[index].id, start: cuts[index].start });
  };

  // Tracked on the window rather than via pointer capture, so the drag survives
  // the pointer leaving the thin handle.
  useEffect(() => {
    if (!drag) return;
    const onMove = (event: PointerEvent) => {
      const { lower, upper } = boundaryRange(dragIndexRef.current);
      if (upper < lower) return;
      const start = Math.min(Math.max(snapToFrame(timeAtClientX(event.clientX)), lower), upper);
      setDrag((current) => (current ? { ...current, start } : current));
    };
    const onUp = () => {
      if (mutate({ type: "move", cutId: drag.cutId, start: drag.start })) {
        setToast(`区切りを ${formatFramePosition(drag.start)} に移動しました`);
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag, boundaryRange, mutate, timeAtClientX]);

  /** Keyboard equivalent of dragging, so boundaries are reachable without a pointer. */
  const nudgeBoundary = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const step = (event.shiftKey ? 1 : 1 / DEFAULT_FPS) * (event.key === "ArrowLeft" ? -1 : 1);
    const { lower, upper } = boundaryRange(index);
    if (upper < lower) return;
    const cut = projectRef.current.cuts[index];
    mutate({ type: "move", cutId: cut.id, start: Math.min(Math.max(cut.start + step, lower), upper) });
  };

  /** Set by a wheel zoom; consumed once the wider timeline has been laid out. */
  const zoomAnchorRef = useRef<{ ratio: number; offset: number } | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    const anchor = zoomAnchorRef.current;
    if (!viewport || !anchor) return;
    zoomAnchorRef.current = null;
    viewport.scrollLeft = anchor.ratio * viewport.scrollWidth - anchor.offset;
  }, [zoom]);

  // Blender-style navigation: the wheel zooms, shift+wheel and the middle
  // button pan. Registered by hand because the wheel must be cancellable.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.shiftKey) {
        viewport.scrollLeft += event.deltaY + event.deltaX;
        return;
      }
      const offset = event.clientX - viewport.getBoundingClientRect().left;
      const ratio = (viewport.scrollLeft + offset) / Math.max(1, viewport.scrollWidth);
      zoomAnchorRef.current = { ratio, offset };
      setZoom((current) => clamp(current * Math.exp(-event.deltaY * 0.0015), MIN_TIMELINE_ZOOM, MAX_TIMELINE_ZOOM));
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, []);

  const beginTimelinePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 1) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    event.preventDefault();
    viewport.setPointerCapture(event.pointerId);
    setPanning(true);
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!panning || !viewport) return;
    const onMove = (event: PointerEvent) => { viewport.scrollLeft -= event.movementX; };
    const onUp = () => setPanning(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [panning]);

  // The stage is resized by its container, so its width is watched rather than
  // read during render.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(([entry]) => setCanvasWidth(entry.contentRect.width));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  /** The ring shows the stroke as it will land on the paper, zoom included. */
  const brushRingSize = useMemo(() => {
    const frameWidth = frameBox(canvasWidth, canvasWidth, true).width;
    const size = selectedTool === "eraser" ? brushSize * 4 : brushSize;
    return Math.max(4, size * (frameWidth / STROKE_REFERENCE_WIDTH) * view.scale);
  }, [brushSize, canvasWidth, selectedTool, view.scale]);

  const rulerMarks = useMemo(() => {
    const count = Math.min(21, 5 * Math.round(zoom));
    return Array.from({ length: count }, (_, index) => index / (count - 1));
  }, [zoom]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">S</span><span>STORYBOARD</span><b>JAM</b></div>
        <div className="project-title">
          <button className="crumb">Projects</button><span>/</span>
          <BufferedField aria-label="プロジェクト名" placeholder="無題のプロジェクト" value={projectName}
            onCommit={renameProject} disabled={role === "connecting"} />
          <span className="saved"><i />{
            role === "host" ? "この端末に保存"
              : role === "guest" ? "同期＋バックアップ"
                : role === "closed" ? "この端末にバックアップ"
                  : "接続中"
          }</span>
        </div>
        <div className="export-actions">
          <button onClick={() => setHelpOpen(true)} title="ショートカット一覧 (?)">?</button>
          <label className="import-action" title="書き出したZIPを読み込む">
            ZIP読込<input type="file" accept=".zip,application/zip" onChange={(e) => importBundle(e, "zip")} />
          </label>
          <label className="import-action" title="解凍したフォルダを読み込む">
            フォルダ読込
            <input type="file" onChange={(e) => importBundle(e, "folder")} {...{ webkitdirectory: "", directory: "" }} />
          </label>
          <button onClick={exportSequence} disabled={Boolean(busy)}>連番＋AE</button>
          <button onClick={exportMp4} disabled={Boolean(busy)}>MP4</button>
        </div>
        <div className="people" aria-label="参加中のメンバー">
          <span className="presence-text" title={ROLE_LABEL[role]}><i className={collabPulse ? "pulse" : ""} />{ROLE_LABEL[role]}</span>
          <BufferedField className="user-name" aria-label="あなたの名前" placeholder="あなたの名前"
            value={userName} onCommit={renameUser} />
          <button className="people-toggle" onClick={() => setPeopleOpen((open) => !open)}
            aria-expanded={peopleOpen} title="参加者一覧">
            参加者 {Math.max(1, participants.length || peers + 1)}
          </button>
          <button className="share" onClick={() => void shareRoom()}>招待する</button>
          {peopleOpen && (
            <div className="people-list" role="dialog" aria-label="参加者一覧">
              <div className="people-head"><span>参加者</span><button onClick={() => setPeopleOpen(false)}>×</button></div>
              <ul>
                {(participants.length ? participants : [{ id: "self", name: userName, isHost: role === "host" }]).map((participant, index) => (
                  <li key={participant.id}>
                    <span className="av av1">{guestLabel(participant, index).slice(0, 2)}</span>
                    <b>{guestLabel(participant, index)}</b>
                    {participant.isHost && <small>ホスト</small>}
                    {role === "host" && !participant.isHost && (
                      <button className="kick" onClick={() => kickParticipant(participant, index)}>退出</button>
                    )}
                  </li>
                ))}
              </ul>
              {role !== "host" && <p className="field-hint">退出させられるのはホストだけです</p>}
            </div>
          )}
        </div>
      </header>

      <section className="workspace">
        <aside className="cuts-panel">
          <div className="section-heading"><span>カット</span><button onClick={splitAtPlayhead} title="再生位置で分割 (S)" aria-label="再生位置で分割">✂</button></div>
          <div className={`cut-list ${dragCutId ? "swapping" : ""}`}>
            {cuts.map((cut, index) => (
              <button key={cut.id}
                className={`cut-card ${cut.id === activeId ? "active" : ""} ${dragCutId === cut.id ? "dragging" : ""}`}
                onClick={() => chooseCut(index)}
                draggable
                onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", cut.id); setDragCutId(cut.id); }}
                onDragEnd={() => setDragCutId(null)}
                onDragOver={(e) => { if (dragCutId && dragCutId !== cut.id) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
                onDrop={(e) => {
                  e.preventDefault();
                  const source = e.dataTransfer.getData("text/plain") || dragCutId;
                  setDragCutId(null);
                  if (source && source !== cut.id) swapCutContent(source, cut.id);
                }}>
                <span className="cut-no">{String(index + 1).padStart(2, "0")}</span>
                <span className="thumb"><MiniCanvas strokes={cut.strokes} backgroundImage={cut.backgroundImage} />{cut.strokes.length === 0 && !cut.backgroundImage && <span className={`placeholder p${index % 4}`} />}</span>
                <span className="cut-copy">
                  <strong className={cut.title.trim() ? "" : "untitled"}>{cutLabel(cut.title, index)}</strong>
                  <small>{formatFrameDuration(cutDurationOf(displayProject, index))} · {formatFramePosition(cut.start)}</small>
                </span>
              </button>
            ))}
          </div>
          <button className="add-cut" onClick={splitAtPlayhead}>✂ 再生位置で分割 <kbd>S</kbd></button>
        </aside>

        <section className="stage-area">
          <div className="tool-row">
            <div className="tools">
              <button className={selectedTool === "pen" ? "selected" : ""} onClick={() => setSelectedTool("pen")} title="ペン (B)"><span className="pen-icon" /></button>
              <button className={selectedTool === "eraser" ? "selected" : ""} onClick={() => setSelectedTool("eraser")} title="消しゴム (E)"><span className="eraser-icon" /></button>
              <span className="divider" />
              {SHAPE_TOOLS.map(({ tool, label, hint }) => (
                <button key={tool} className={`shape-tool ${selectedTool === tool ? "selected" : ""}`}
                  onClick={() => setSelectedTool(tool)} title={hint}>{label}</button>
              ))}
              <span className="divider" />
              {COLORS.map((swatch) => <button key={swatch} className={`swatch ${color === swatch ? "selected" : ""}`} style={{ "--swatch": swatch } as React.CSSProperties} onClick={() => { setColor(swatch); setSelectedTool("pen"); }} aria-label={`色 ${swatch}`} />)}
              <span className="divider" />
              <label className="size-control"><span>線</span><input type="range" min="1" max="14" value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} /><b>{brushSize}</b></label>
            </div>
            <div className="history-tools">
              <button onClick={undo} title="元に戻す (Ctrl+Z)">↶</button><button onClick={redo} title="やり直す (Ctrl+Shift+Z)">↷</button>
              <button className="text-tool" onClick={() => void pasteFromClipboard()} title="クリップボードの画像を貼り付け (Ctrl+V)">貼り付け</button>
              <button className="text-tool danger" onClick={clearActiveCut} title="現在のカットの絵をすべて消去">全消去</button>
              <button className="panel-toggle" onClick={() => setPanelOpen((v) => !v)}>{panelOpen ? "メモを閉じる" : "メモを開く"}</button>
            </div>
          </div>

          <div className={`canvas-and-note ${panelOpen ? "" : "note-closed"}`}>
            <div className="canvas-wrap" ref={stageRef} onPointerDown={beginStageNavigation}
              onAuxClick={(e) => e.preventDefault()}
              onPointerMove={(e) => setBrushRing({ x: e.clientX, y: e.clientY })}
              onPointerLeave={() => setBrushRing(null)}>
              <div className="canvas-label"><span>CUT {String(activeIndex + 1).padStart(2, "0")}</span><span>{activeCut?.title}</span></div>
              <canvas ref={canvasRef} className="drawing-canvas"
                style={{ transform: `translate(${view.x}px, ${view.y}px) rotate(${view.angle}rad) scale(${view.scale})` }}
                onPointerDown={beginStroke} onPointerMove={moveStroke} onPointerUp={endStroke} onPointerCancel={endStroke} aria-label="絵コンテ描画キャンバス" />
              {brushRing && <span className="brush-ring" aria-hidden="true"
                style={{ left: brushRing.x, top: brushRing.y, width: brushRingSize, height: brushRingSize }} />}
              <div className="stage-view-control">
                <button onClick={() => setView((v) => ({ ...v, scale: clamp(v.scale / 1.4, MIN_VIEW_SCALE, MAX_VIEW_SCALE) }))} aria-label="キャンバスを縮小">−</button>
                <b>{Math.round(view.scale * 100)}%</b>
                <button onClick={() => setView((v) => ({ ...v, scale: clamp(v.scale * 1.4, MIN_VIEW_SCALE, MAX_VIEW_SCALE) }))} aria-label="キャンバスを拡大">＋</button>
                <button onClick={() => setView((v) => ({ ...v, angle: v.angle - Math.PI / 12 }))} aria-label="左に回転">⟲</button>
                <button onClick={() => setView((v) => ({ ...v, angle: v.angle + Math.PI / 12 }))} aria-label="右に回転">⟳</button>
                <button onClick={resetView} title="表示をリセット">リセット</button>
              </div>
            </div>
            {panelOpen && <aside className="note-panel">
              <div className="note-head"><span>カット情報</span><button onClick={() => setPanelOpen(false)}>×</button></div>
              <label htmlFor="cut-title">カット名<BufferedField id="cut-title" key={`title-${activeId}`} placeholder={cutLabel("", activeIndex)} value={activeCut.title} onCommit={(title) => updateActive({ title })} /></label>
              <label>尺
                <div className="duration-field">
                  <input type="text" inputMode="numeric" value={durationInput} disabled={isLastCut || role === "connecting"}
                    aria-label="尺（秒+コマ）" onChange={(e) => setDurationInput(e.target.value)} onBlur={commitDurationInput}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") setDurationInput(formatFrameDuration(activeDuration));
                    }} />
                  <span>24fps</span>
                </div>
              </label>
              {isLastCut && <p className="field-hint">最後のカットは楽曲の終わりまでです</p>}
              <label htmlFor="cut-note">演出メモ<BufferedField id="cut-note" multiline key={`note-${activeId}`} value={activeCut.note} onCommit={(note) => updateActive({ note })} /></label>
              <div className="tag-row"><span>CAM</span><button>FIX</button><button>PAN →</button><button>＋</button></div>
              <div className="note-actions">
                <button onClick={splitAtPlayhead}>分割</button>
                <button onClick={duplicateCut} title="カットを複製 (Ctrl+D)">複製</button>
                <button onClick={copyCutContent} title="カットの絵をコピー (Ctrl+C)">コピー</button>
                <button onClick={pasteCutContent} title="カットの絵を貼り付け (Ctrl+Shift+V)">貼り付け</button>
                <button onClick={() => void exportFrame()}>PNG</button>
                <button className="danger" onClick={deleteCut}>削除</button>
              </div>
            </aside>}
          </div>
        </section>
      </section>

      <section className="transport">
        <div className="transport-main">
          <div className="playback">
            <button onClick={() => seek(currentTime - 1)} title="1秒戻す (←)">−1s</button>
            <button className="play" onClick={togglePlay} aria-label={playing ? "停止" : "再生"} title="再生 / 停止 (Space)">{playing ? "Ⅱ" : "▶"}</button>
            <button onClick={() => seek(currentTime + 1)} title="1秒進める (→)">+1s</button>
            <span className="timecode">{formatFramePosition(currentTime)} <small>/ {formatFramePosition(totalDuration)}</small></span>
          </div>
          <div className="audio-info">
            {/* The song name is the picker: clicking it opens the file dialog. */}
            <label className="audio-picker" title="クリックして音源を選択">
              <span className="wave-icon">≋</span>
              <div>
                <strong>{audioName || "音源なし"}</strong>
                <small>{audioUrl ? "クリックで音源を変更" : "クリックで音源を選択（全体の尺が決まります）"}</small>
              </div>
              <input type="file" accept="audio/*" onChange={onAudio} />
            </label>
            <label className="volume-control" title="音量">
              <span aria-hidden="true">🔈</span>
              <input type="range" min="0" max="100" value={Math.round(volume * 100)} aria-label="音量"
                onChange={(e) => setVolume(Number(e.target.value) / 100)} />
            </label>
            {/* Playback engine for the timeline, not user-facing media, so there is nothing to caption. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            {audioUrl && <audio ref={audioRef} src={audioUrl} onEnded={() => setPlaying(false)} />}
          </div>
          <div className="view-control" title="タイムラインの拡大縮小（ホイールで拡大、中ボタンドラッグで移動）">
            <button onClick={() => setZoom((z) => Math.max(MIN_TIMELINE_ZOOM, z / 1.5))} aria-label="縮小">−</button>
            <input type="range" min={MIN_TIMELINE_ZOOM} max={MAX_TIMELINE_ZOOM} step="0.1" value={zoom}
              aria-label="タイムラインの拡大率" onChange={(e) => setZoom(Number(e.target.value))} />
            <button onClick={() => setZoom((z) => Math.min(MAX_TIMELINE_ZOOM, z * 1.5))} aria-label="拡大">＋</button>
            <b>{zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}x</b>
          </div>
        </div>
        <div className="timeline-scroller">
          <div className="track-labels"><span>VIDEO</span><span>AUDIO</span></div>
          <div className={`timeline-viewport ${panning ? "panning" : ""}`} ref={viewportRef}
            onPointerDown={beginTimelinePan} onAuxClick={(e) => e.preventDefault()}>
            <div className={`timeline ${scrubbing ? "scrubbing" : ""}`} ref={timelineRef} style={{ width: `${zoom * 100}%` }} onPointerDown={onTimelinePointer}>
              <div className="ruler">{rulerMarks.map((v) => <span key={v} style={{ left: `${v * 100}%` }}>{formatFramePosition(v * totalDuration)}</span>)}</div>
              <div className="video-track">
                {cuts.map((cut, index) => (
                  <button key={cut.id} className={`timeline-cut ${cut.id === activeId ? "active" : ""} ${index % 2 ? "odd" : ""}`}
                    style={{
                      left: `${(cut.start / totalDuration) * 100}%`,
                      width: `${(cutDurationOf(displayProject, index) / totalDuration) * 100}%`,
                    }}
                    onClick={(e) => { e.stopPropagation(); chooseCut(index); }}>
                    <span>{index + 1}</span><b>{cut.title}</b>
                  </button>
                ))}
              </div>
              {cuts.slice(1).map((cut, offset) => {
                const index = offset + 1;
                return (
                  <button key={`handle-${cut.id}`} className={`cut-handle ${drag?.cutId === cut.id ? "dragging" : ""}`}
                    style={{ left: `${(cut.start / totalDuration) * 100}%` }}
                    title={`${cutLabel(cut.title, index)} の開始位置 ${formatFramePosition(cut.start)}`}
                    aria-label={`カット${index + 1}の開始位置を調整`}
                    onPointerDown={(e) => beginBoundaryDrag(e, index)}
                    onKeyDown={(e) => nudgeBoundary(e, index)}
                    onClick={(e) => e.stopPropagation()}>
                    <i />
                  </button>
                );
              })}
              <div className="audio-track"><div className="waveform">{Array.from({ length: 90 }, (_, i) => <i key={i} style={{ height: `${20 + ((i * 37) % 65)}%` }} />)}</div></div>
              <div className="playhead" style={{ left: `${(currentTime / totalDuration) * 100}%` }}><i /></div>
            </div>
          </div>
        </div>
      </section>

      {helpOpen && (
        <div className="export-overlay">
          <div className="help-card" role="dialog" aria-label="ショートカット一覧">
            <strong>ショートカット</strong>
            <dl>{SHORTCUTS.map(([keys, label]) => <div key={keys}><dt><kbd>{keys}</kbd></dt><dd>{label}</dd></div>)}</dl>
            <button onClick={() => setHelpOpen(false)}>閉じる</button>
          </div>
        </div>
      )}

      {busy && (
        <div className="export-overlay" role="status">
          <div className="export-card">
            <strong>{busy.label}</strong>
            <div className="export-bar"><i style={{ width: `${Math.round(busy.ratio * 100)}%` }} /></div>
            <small>{Math.round(busy.ratio * 100)}%</small>
          </div>
        </div>
      )}
      <div className="toast" key={toast}>{toast}</div>
    </main>
  );
}
