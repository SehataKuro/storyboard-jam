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
  cutIndexAt,
  formatFrameDuration,
  formatFramePosition,
  newCutId,
  normalizeProject,
  parseFrameDuration,
  snapToFrame,
} from "./lib/types";
import { Room, RoomOp, RoomRole, applyOp } from "./lib/p2p";
import { cutLabel } from "./lib/ae";
import { exportMovie, exportSequenceZip } from "./lib/export-media";
import { downloadBlob } from "./lib/zip";
import { readBundleFromFiles, readBundleFromZip } from "./lib/project-io";
import { STROKE_REFERENCE_WIDTH, canvasToPngBlob, drawContainedImage, renderCutToCanvas } from "./lib/render";

const COLORS = ["#171714", "#ff5b3d", "#367c5b", "#2f6fc0", "#8e56a8"];
const LEGACY_STORAGE_KEY = "conte-live-project";
const roomStorageKey = (roomId: string) => `${LEGACY_STORAGE_KEY}:${roomId}`;

const SHORTCUTS: [string, string][] = [
  ["Space", "再生 / 停止"],
  ["S", "再生位置でカットを分割"],
  ["B / E", "ペン / 消しゴム"],
  ["[ / ]", "ブラシを細く / 太く"],
  ["← / →", "1秒移動（Shiftで1フレーム）"],
  [", / .", "前 / 次のカットへ"],
  ["Ctrl+Z / Ctrl+Shift+Z", "元に戻す / やり直す"],
  ["Ctrl+V", "画像を現在のカットへ貼り付け"],
  ["Delete", "選択中のカットを削除"],
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
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  if (!thumbnail) fitCanvas(canvas);
  const dpr = thumbnail ? 1 : Math.min(window.devicePixelRatio || 1, 2);
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
  const strokeScale = frame.width / STROKE_REFERENCE_WIDTH;
  [...strokes, ...(draft ? [draft] : [])].forEach((stroke) => {
    if (stroke.points.length < 1) return;
    ctx.globalCompositeOperation = stroke.eraser ? "destination-out" : "source-over";
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = Math.max(thumbnail ? .5 : 1, stroke.size * strokeScale);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    const first = stroke.points[0];
    ctx.moveTo(frame.left + first.x * frame.width, frame.top + first.y * frame.height);
    stroke.points.slice(1).forEach((p) => ctx.lineTo(frame.left + p.x * frame.width, frame.top + p.y * frame.height));
    if (stroke.points.length === 1) {
      ctx.lineTo(frame.left + first.x * frame.width + .1, frame.top + first.y * frame.height + .1);
    }
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
  });

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
  const [selectedTool, setSelectedTool] = useState<"pen" | "eraser">("pen");
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const dragIndexRef = useRef(-1);
  const animationRef = useRef<number | null>(null);
  const playStartRef = useRef({ at: 0, time: 0 });
  const historyRef = useRef<Record<string, CutContent[]>>({});
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
    return () => { room.close(); roomRef.current = null; };
  }, []);

  useEffect(() => {
    const previousRole = previousRoleRef.current;
    previousRoleRef.current = role;
    if (previousRole !== "guest" || role !== "closed") return;

    const shouldReload = window.confirm(
      "ホストとの接続が切断されました。再読み込みして再接続しますか？",
    );
    if (shouldReload) window.location.reload();
  }, [role]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeCut) return;
    drawCanvas(canvas, activeCut.strokes, activeBackgroundImage, draft);
  }, [activeCut, activeBackgroundImage, draft, panelOpen]);

  useEffect(() => {
    const onResize = () => {
      if (canvasRef.current && activeCut) drawCanvas(canvasRef.current, activeCut.strokes, activeBackgroundImage, draft);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [activeCut, activeBackgroundImage, draft]);

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

  // Coordinates are normalised against the frame, so values outside 0..1 sit in the margin.
  const pointerPoint = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    const frame = frameBox(rect.width, rect.height, true);
    return {
      x: (event.clientX - rect.left - frame.left) / frame.width,
      y: (event.clientY - rect.top - frame.top) / frame.height,
    };
  };

  const beginStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!roomRef.current?.canEdit()) {
      setToast("接続が完了してから編集してください");
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraft({ color, size: selectedTool === "eraser" ? brushSize * 4 : brushSize, eraser: selectedTool === "eraser", points: [pointerPoint(event)] });
  };

  const moveStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!draft || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const point = pointerPoint(event);
    setDraft((old) => old ? { ...old, points: [...old.points, point] } : old);
  };

  const endStroke = () => {
    if (!draft) return;
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

      const step = event.shiftKey ? 1 / DEFAULT_FPS : 1;
      const key = event.key;

      if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      switch (key) {
        case " ": event.preventDefault(); void togglePlay(); break;
        case "s": case "S": event.preventDefault(); splitAtPlayhead(); break;
        case "b": case "B": setSelectedTool("pen"); break;
        case "e": case "E": setSelectedTool("eraser"); break;
        case "[": setBrushSize((size) => Math.max(1, size - 1)); break;
        case "]": setBrushSize((size) => Math.min(14, size + 1)); break;
        case "ArrowLeft": event.preventDefault(); seek(currentTime - step); break;
        case "ArrowRight": event.preventDefault(); seek(currentTime + step); break;
        case ",": chooseCut(activeIndex - 1); break;
        case ".": chooseCut(activeIndex + 1); break;
        case "Delete": deleteCut(); break;
        case "?": setHelpOpen((open) => !open); break;
        case "Escape": setHelpOpen(false); break;
        default: break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, currentTime, activeIndex, togglePlay, splitAtPlayhead, deleteCut, chooseCut, seek, undo, redo]);

  const onTimelinePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
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

  const rulerMarks = useMemo(() => {
    const count = Math.min(21, 5 * Math.round(zoom));
    return Array.from({ length: count }, (_, index) => index / (count - 1));
  }, [zoom]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">C</span><span>CONTE</span><b>LIVE</b></div>
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
          <div className="avatars"><span className="av av1">YOU</span>{peers > 0 && <span className="av av2">+{peers}</span>}</div>
          <button className="share" onClick={() => void shareRoom()}>招待する</button>
        </div>
      </header>

      <section className="workspace">
        <aside className="cuts-panel">
          <div className="section-heading"><span>カット</span><button onClick={splitAtPlayhead} title="再生位置で分割 (S)" aria-label="再生位置で分割">✂</button></div>
          <div className="cut-list">
            {cuts.map((cut, index) => (
              <button key={cut.id} className={`cut-card ${cut.id === activeId ? "active" : ""}`} onClick={() => chooseCut(index)}>
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
            <div className="canvas-wrap">
              <div className="canvas-label"><span>CUT {String(activeIndex + 1).padStart(2, "0")}</span><span>{activeCut?.title}</span></div>
              <canvas ref={canvasRef} className="drawing-canvas" onPointerDown={beginStroke} onPointerMove={moveStroke} onPointerUp={endStroke} onPointerCancel={endStroke} aria-label="絵コンテ描画キャンバス" />
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
              <div className="note-actions"><button onClick={splitAtPlayhead}>分割</button><button onClick={() => void exportFrame()}>PNG</button><button className="danger" onClick={deleteCut}>削除</button></div>
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
            <span className="wave-icon">≋</span>
            <div><strong>{audioName || "音源なし"}</strong><small>{audioUrl ? "この端末だけで再生" : "楽曲を読み込むと全体の尺が決まります"}</small></div>
            <label className="volume-control" title="音量">
              <span aria-hidden="true">🔈</span>
              <input type="range" min="0" max="100" value={Math.round(volume * 100)} aria-label="音量"
                onChange={(e) => setVolume(Number(e.target.value) / 100)} />
            </label>
            <label className="audio-upload">音源を変更<input type="file" accept="audio/*" onChange={onAudio} /></label>
            {/* Playback engine for the timeline, not user-facing media, so there is nothing to caption. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            {audioUrl && <audio ref={audioRef} src={audioUrl} onEnded={() => setPlaying(false)} />}
          </div>
          <div className="view-control" title="タイムラインの拡大縮小">
            <button onClick={() => setZoom((z) => Math.max(1, z - 1))} aria-label="縮小">−</button>
            <input type="range" min="1" max="8" step="1" value={zoom} aria-label="タイムラインの拡大率" onChange={(e) => setZoom(Number(e.target.value))} />
            <button onClick={() => setZoom((z) => Math.min(8, z + 1))} aria-label="拡大">＋</button>
            <b>{zoom}x</b>
          </div>
        </div>
        <div className="timeline-scroller">
          <div className="track-labels"><span>VIDEO</span><span>AUDIO</span></div>
          <div className="timeline-viewport" ref={viewportRef}>
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
