"use client";

import { ChangeEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_FPS,
  EXPORT_HEIGHT,
  EXPORT_WIDTH,
  MIN_CUT_DURATION,
  Point,
  Project,
  Stroke,
  createEmptyProject,
  cutDurationOf,
  cutIndexAt,
  newCutId,
  normalizeProject,
} from "./lib/types";
import { Room, RoomOp, RoomRole, applyOp } from "./lib/p2p";
import { cutLabel } from "./lib/ae";
import { exportMovie, exportSequenceZip } from "./lib/export-media";
import { downloadBlob } from "./lib/zip";
import { paintStrokes } from "./lib/render";

const COLORS = ["#171714", "#ff5b3d", "#367c5b", "#2f6fc0", "#8e56a8"];

const SHORTCUTS: [string, string][] = [
  ["Space", "再生 / 停止"],
  ["S", "再生位置でカットを分割"],
  ["B / E", "ペン / 消しゴム"],
  ["[ / ]", "ブラシを細く / 太く"],
  ["← / →", "1秒移動（Shiftで1フレーム）"],
  [", / .", "前 / 次のカットへ"],
  ["Ctrl+Z / Ctrl+Shift+Z", "元に戻す / やり直す"],
  ["Delete", "選択中のカットを削除"],
  ["?", "このヘルプ"],
];

function formatTime(seconds: number) {
  const safe = Math.max(0, seconds || 0);
  const min = Math.floor(safe / 60);
  const sec = Math.floor(safe % 60).toString().padStart(2, "0");
  const frame = Math.floor((safe % 1) * DEFAULT_FPS).toString().padStart(2, "0");
  return `${min}:${sec}:${frame}`;
}

function drawCanvas(canvas: HTMLCanvasElement, strokes: Stroke[], draft?: Stroke | null, thumbnail = false) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
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

  if (!thumbnail) {
    ctx.strokeStyle = "rgba(54, 49, 41, .10)";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 7]);
    [1 / 3, 2 / 3].forEach((x) => {
      ctx.beginPath(); ctx.moveTo(width * x, 0); ctx.lineTo(width * x, height); ctx.stroke();
    });
    [1 / 3, 2 / 3].forEach((y) => {
      ctx.beginPath(); ctx.moveTo(0, height * y); ctx.lineTo(width, height * y); ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(54, 49, 41, .18)";
    ctx.strokeRect(width * .08, height * .08, width * .84, height * .84);
  }

  const scale = thumbnail ? .32 : 1;
  [...strokes, ...(draft ? [draft] : [])].forEach((stroke) => {
    if (stroke.points.length < 1) return;
    ctx.globalCompositeOperation = stroke.eraser ? "destination-out" : "source-over";
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size * scale;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    const first = stroke.points[0];
    ctx.moveTo(first.x * width, first.y * height);
    stroke.points.slice(1).forEach((p) => ctx.lineTo(p.x * width, p.y * height));
    if (stroke.points.length === 1) ctx.lineTo(first.x * width + .1, first.y * height + .1);
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
  });
}

function MiniCanvas({ strokes }: { strokes: Stroke[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) drawCanvas(ref.current, strokes, null, true);
  }, [strokes]);
  return <canvas ref={ref} className="mini-canvas" aria-hidden="true" />;
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
  const historyRef = useRef<Record<string, Stroke[][]>>({});
  const redoRef = useRef<Record<string, Stroke[][]>>({});
  const roomRef = useRef<Room | null>(null);
  const projectRef = useRef<Project>(project);

  // While dragging a boundary the UI shows the pending position, not the committed one.
  const displayProject = useMemo(
    () => (drag ? applyOp(project, { type: "move", cutId: drag.cutId, start: drag.start }) : project),
    [project, drag],
  );
  const cuts = displayProject.cuts;
  const totalDuration = displayProject.duration;
  const activeIndex = Math.max(0, cuts.findIndex((cut) => cut.id === activeId));
  const activeCut = cuts[activeIndex] || cuts[0];
  const activeDuration = cutDurationOf(displayProject, activeIndex);
  const isLastCut = activeIndex === cuts.length - 1;
  const exportName = projectName.trim() || "storyboard";

  useEffect(() => { projectRef.current = project; }, [project]);

  /** Local edits go through here: the host owns state, guests only propose. */
  const mutate = useCallback((op: RoomOp) => {
    const next = applyOp(projectRef.current, op);
    projectRef.current = next;
    setProject(next);
    const room = roomRef.current;
    if (!room) return;
    if (room.isHost()) room.broadcastSnapshot(next);
    else room.sendOp(op);
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem("conte-live-project");
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as { project?: Project; projectName?: string };
      if (parsed.project?.cuts?.length) {
        const restored = normalizeProject(parsed.project);
        projectRef.current = restored;
        setProject(restored);
        setActiveId(restored.cuts[0].id);
      }
      if (parsed.projectName) setProjectName(parsed.projectName);
    } catch { /* start from an empty board */ }
  }, []);

  // Only the host persists: it is the copy everyone else is mirroring.
  useEffect(() => {
    if (role !== "host") return;
    window.localStorage.setItem("conte-live-project", JSON.stringify({ project, projectName }));
  }, [project, projectName, role]);

  useEffect(() => {
    const url = new URL(window.location.href);
    let roomId = url.searchParams.get("room");
    if (!roomId) {
      // A fresh visit opens its own room so boards are not shared by guessing the URL.
      roomId = Math.random().toString(36).slice(2, 10);
      url.searchParams.set("room", roomId);
      window.history.replaceState(null, "", url.toString());
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
        projectRef.current = incoming;
        setProject(incoming);
        setActiveId((current) => (incoming.cuts.some((cut) => cut.id === current) ? current : incoming.cuts[0]?.id || current));
        pulse();
      },
      onOp: (op) => {
        const next = applyOp(projectRef.current, op);
        projectRef.current = next;
        setProject(next);
        roomRef.current?.broadcastSnapshot(next);
        pulse();
      },
      getSnapshot: () => projectRef.current,
    });
    roomRef.current = room;
    room.connect();
    return () => { room.close(); roomRef.current = null; };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeCut) return;
    drawCanvas(canvas, activeCut.strokes, draft);
  }, [activeCut, draft, panelOpen]);

  useEffect(() => {
    const onResize = () => {
      if (canvasRef.current && activeCut) drawCanvas(canvasRef.current, activeCut.strokes, draft);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [activeCut, draft]);

  // Playback position is intentionally local: every participant scrubs independently.
  useEffect(() => {
    const found = cuts[cutIndexAt(project, currentTime)]?.id;
    if (found && found !== activeId) setActiveId(found);
  }, [currentTime, project]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume, audioUrl]);

  useEffect(() => {
    if (!playing) {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      return;
    }
    playStartRef.current = { at: performance.now(), time: currentTime };
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
    const next = Math.max(0, Math.min(totalDuration, time));
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
    setPlaying(true);
    if (audioUrl && audioRef.current) {
      audioRef.current.currentTime = from;
      await audioRef.current.play().catch(() => setPlaying(false));
    }
  }, [playing, currentTime, totalDuration, audioUrl, seek]);

  const pointerPoint = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  };

  const beginStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
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
    historyRef.current[activeId] = [...(historyRef.current[activeId] || []), activeCut.strokes];
    redoRef.current[activeId] = [];
    mutate({ type: "strokes", cutId: activeId, strokes: [...activeCut.strokes, draft] });
    setDraft(null);
  };

  const undo = useCallback(() => {
    const cut = projectRef.current.cuts.find((c) => c.id === activeId);
    const history = historyRef.current[activeId] || [];
    if (!cut || !history.length) return;
    redoRef.current[activeId] = [...(redoRef.current[activeId] || []), cut.strokes];
    historyRef.current[activeId] = history.slice(0, -1);
    mutate({ type: "strokes", cutId: activeId, strokes: history[history.length - 1] });
  }, [activeId, mutate]);

  const redo = useCallback(() => {
    const cut = projectRef.current.cuts.find((c) => c.id === activeId);
    const redoStack = redoRef.current[activeId] || [];
    if (!cut || !redoStack.length) return;
    historyRef.current[activeId] = [...(historyRef.current[activeId] || []), cut.strokes];
    redoRef.current[activeId] = redoStack.slice(0, -1);
    mutate({ type: "strokes", cutId: activeId, strokes: redoStack[redoStack.length - 1] });
  }, [activeId, mutate]);

  /** Cuts are created by splitting the song at the playhead, never by appending a length. */
  const splitAtPlayhead = useCallback(() => {
    const current = projectRef.current;
    if (currentTime <= MIN_CUT_DURATION || currentTime >= current.duration - MIN_CUT_DURATION) {
      setToast("この位置では分割できません");
      return;
    }
    if (current.cuts.some((cut) => Math.abs(cut.start - currentTime) < MIN_CUT_DURATION)) {
      setToast("すでにこの位置で分割されています");
      return;
    }
    const id = newCutId();
    mutate({ type: "split", at: currentTime, id });
    setActiveId(id);
    setToast(`${formatTime(currentTime)} で分割しました`);
  }, [currentTime, mutate]);

  const deleteCut = useCallback(() => {
    if (projectRef.current.cuts.length <= 1) {
      setToast("最後のカットは削除できません");
      return;
    }
    const remaining = projectRef.current.cuts.filter((cut) => cut.id !== activeId);
    mutate({ type: "delete", cutId: activeId });
    setActiveId(remaining[Math.max(0, Math.min(activeIndex, remaining.length - 1))].id);
    setToast("カットを削除しました");
  }, [activeId, activeIndex, mutate]);

  const updateActive = (patch: { title?: string; note?: string }) =>
    mutate({ type: "patch", cutId: activeId, patch });

  /** Editing a cut's length moves the boundary that follows it; the song length never changes. */
  const updateActiveDuration = (seconds: number) => {
    const next = cuts[activeIndex + 1];
    if (!next) return;
    mutate({ type: "move", cutId: next.id, start: activeCut.start + Math.max(MIN_CUT_DURATION, seconds) });
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
      setToast(`楽曲に合わせて全体を ${formatTime(probe.duration)} にしました`);
    };
  };

  const exportFrame = () => {
    const canvas = document.createElement("canvas");
    canvas.width = EXPORT_WIDTH;
    canvas.height = EXPORT_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    paintStrokes(ctx, activeCut.strokes, EXPORT_WIDTH, EXPORT_HEIGHT);
    const link = document.createElement("a");
    link.download = `${cutLabel(activeCut.title, activeIndex)}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    setToast("現在のカットを書き出しました");
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

  const timeAtClientX = (clientX: number) => {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return ((clientX - rect.left) / rect.width) * totalDuration;
  };

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubbing, seek, totalDuration]);

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
      const start = Math.min(Math.max(timeAtClientX(event.clientX), lower), upper);
      setDrag((current) => (current ? { ...current, start } : current));
    };
    const onUp = () => {
      mutate({ type: "move", cutId: drag.cutId, start: drag.start });
      setToast(`区切りを ${formatTime(drag.start)} に移動しました`);
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
  }, [drag, boundaryRange, mutate, totalDuration]);

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
          <input aria-label="プロジェクト名" placeholder="無題のプロジェクト" value={projectName} onChange={(e) => setProjectName(e.target.value)} />
          <span className="saved"><i />{role === "host" ? "この端末に保存" : "ホストが保存中"}</span>
        </div>
        <div className="export-actions">
          <button onClick={() => setHelpOpen(true)} title="ショートカット一覧 (?)">?</button>
          <button onClick={exportSequence} disabled={Boolean(busy)}>連番＋AE</button>
          <button onClick={exportMp4} disabled={Boolean(busy)}>MP4</button>
        </div>
        <div className="people" aria-label="参加中のメンバー">
          <span className="presence-text" title={ROLE_LABEL[role]}><i className={collabPulse ? "pulse" : ""} />{ROLE_LABEL[role]}</span>
          <div className="avatars"><span className="av av1">YOU</span>{peers > 0 && <span className="av av2">+{peers}</span>}</div>
          <button className="share" onClick={() => { navigator.clipboard?.writeText(location.href); setToast("招待リンクをコピーしました"); }}>招待する</button>
        </div>
      </header>

      <section className="workspace">
        <aside className="cuts-panel">
          <div className="section-heading"><span>カット</span><button onClick={splitAtPlayhead} title="再生位置で分割 (S)" aria-label="再生位置で分割">✂</button></div>
          <div className="cut-list">
            {cuts.map((cut, index) => (
              <button key={cut.id} className={`cut-card ${cut.id === activeId ? "active" : ""}`} onClick={() => chooseCut(index)}>
                <span className="cut-no">{String(index + 1).padStart(2, "0")}</span>
                <span className="thumb"><MiniCanvas strokes={cut.strokes} />{cut.strokes.length === 0 && <span className={`placeholder p${index % 4}`} />}</span>
                <span className="cut-copy">
                  <strong className={cut.title.trim() ? "" : "untitled"}>{cutLabel(cut.title, index)}</strong>
                  <small>{cutDurationOf(displayProject, index).toFixed(1)}秒 · {formatTime(cut.start)}</small>
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
              <label>カット名<input placeholder={cutLabel("", activeIndex)} value={activeCut.title} onChange={(e) => updateActive({ title: e.target.value })} /></label>
              <label>尺
                <div className="duration-field">
                  <input type="number" min={MIN_CUT_DURATION} step="0.1" value={activeDuration.toFixed(2)} disabled={isLastCut}
                    onChange={(e) => updateActiveDuration(Number(e.target.value))} />
                  <span>秒</span>
                </div>
              </label>
              {isLastCut && <p className="field-hint">最後のカットは楽曲の終わりまでです</p>}
              <label>演出メモ<textarea value={activeCut.note} onChange={(e) => updateActive({ note: e.target.value })} /></label>
              <div className="tag-row"><span>CAM</span><button>FIX</button><button>PAN →</button><button>＋</button></div>
              <div className="note-actions"><button onClick={splitAtPlayhead}>分割</button><button onClick={exportFrame}>PNG</button><button className="danger" onClick={deleteCut}>削除</button></div>
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
            <span className="timecode">{formatTime(currentTime)} <small>/ {formatTime(totalDuration)}</small></span>
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
              <div className="ruler">{rulerMarks.map((v) => <span key={v} style={{ left: `${v * 100}%` }}>{formatTime(v * totalDuration).slice(0, 5)}</span>)}</div>
              <div className="video-track">
                {cuts.map((cut, index) => (
                  <button key={cut.id} className={`timeline-cut ${cut.id === activeId ? "active" : ""}`}
                    style={{ width: `${(cutDurationOf(displayProject, index) / totalDuration) * 100}%` }}
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
                    title={`${cutLabel(cut.title, index)} の開始位置 ${formatTime(cut.start)}`}
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
