"use client";

import { ChangeEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cut, DEFAULT_FPS, EXPORT_HEIGHT, EXPORT_WIDTH, Point, Stroke, cutStartOf, totalDurationOf } from "./lib/types";
import { Room, RoomOp, RoomRole, applyOp } from "./lib/p2p";
import { exportMovie, exportSequenceZip } from "./lib/export-media";
import { downloadBlob } from "./lib/zip";
import { paintStrokes } from "./lib/render";

const COLORS = ["#171714", "#ff5b3d", "#367c5b", "#2f6fc0", "#8e56a8"];
const INITIAL_CUTS: Cut[] = [
  { id: "c1", title: "朝の部屋", duration: 3.2, note: "窓から差し込む光。ゆっくり寄る。", strokes: [] },
  { id: "c2", title: "目を開ける", duration: 2.3, note: "音の立ち上がりで目を開く。", strokes: [] },
  { id: "c3", title: "走り出す", duration: 4.1, note: "ビートに合わせてカメラを振る。", strokes: [] },
  { id: "c4", title: "街の俯瞰", duration: 3.4, note: "サビ前。空を広く見せる。", strokes: [] },
  { id: "c5", title: "振り返る", duration: 2.7, note: "一瞬だけ静止。", strokes: [] },
  { id: "c6", title: "タイトル", duration: 4.3, note: "余韻を残して暗転。", strokes: [] },
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
  const [cuts, setCuts] = useState<Cut[]>(INITIAL_CUTS);
  const [activeId, setActiveId] = useState("c1");
  const [selectedTool, setSelectedTool] = useState<"pen" | "eraser">("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [brushSize, setBrushSize] = useState(3);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [audioName, setAudioName] = useState("デモトラック");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [toast, setToast] = useState("ようこそ。ルームを開きました");
  const [draft, setDraft] = useState<Stroke | null>(null);
  const [collabPulse, setCollabPulse] = useState(false);
  const [projectName, setProjectName] = useState("雨上がりのMV");
  const [role, setRole] = useState<RoomRole>("connecting");
  const [peers, setPeers] = useState(0);
  const [busy, setBusy] = useState<{ label: string; ratio: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number | null>(null);
  const playStartRef = useRef({ at: 0, time: 0 });
  const historyRef = useRef<Record<string, Stroke[][]>>({});
  const redoRef = useRef<Record<string, Stroke[][]>>({});
  const roomRef = useRef<Room | null>(null);
  const cutsRef = useRef<Cut[]>(INITIAL_CUTS);
  const isHostRef = useRef(false);

  const totalDuration = useMemo(() => totalDurationOf(cuts), [cuts]);
  const activeIndex = Math.max(0, cuts.findIndex((cut) => cut.id === activeId));
  const activeCut = cuts[activeIndex] || cuts[0];
  const cutStart = useCallback((index: number) => cutStartOf(cuts, index), [cuts]);

  useEffect(() => { cutsRef.current = cuts; }, [cuts]);
  useEffect(() => { isHostRef.current = role === "host"; }, [role]);

  /** Local edits go through here: the host owns state, guests only propose. */
  const mutate = useCallback((op: RoomOp) => {
    const next = applyOp(cutsRef.current, op);
    cutsRef.current = next;
    setCuts(next);
    const room = roomRef.current;
    if (!room) return;
    if (room.isHost()) room.broadcastSnapshot(next);
    else room.sendOp(op);
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem("conte-live-project");
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as { cuts: Cut[]; projectName?: string };
        if (parsed.cuts?.length) {
          cutsRef.current = parsed.cuts;
          setCuts(parsed.cuts);
          setActiveId(parsed.cuts[0].id);
        }
        if (parsed.projectName) setProjectName(parsed.projectName);
      } catch { /* keep demo project */ }
    }
  }, []);

  // Only the host persists: it is the copy everyone else is mirroring.
  useEffect(() => {
    if (role !== "host") return;
    window.localStorage.setItem("conte-live-project", JSON.stringify({ cuts, projectName }));
  }, [cuts, projectName, role]);

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
        cutsRef.current = incoming;
        setCuts(incoming);
        setActiveId((current) => (incoming.some((cut) => cut.id === current) ? current : incoming[0]?.id || current));
        pulse();
      },
      onOp: (op) => {
        const next = applyOp(cutsRef.current, op);
        cutsRef.current = next;
        setCuts(next);
        roomRef.current?.broadcastSnapshot(next);
        pulse();
      },
      getSnapshot: () => cutsRef.current,
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
    let elapsed = 0;
    let found = cuts[0]?.id;
    for (const cut of cuts) {
      if (currentTime < elapsed + cut.duration) { found = cut.id; break; }
      elapsed += cut.duration;
    }
    if (found && found !== activeId) setActiveId(found);
  }, [currentTime, cuts]);

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

  const seek = (time: number) => {
    const next = Math.max(0, Math.min(totalDuration, time));
    setCurrentTime(next);
    if (audioRef.current) audioRef.current.currentTime = Math.min(next, audioRef.current.duration || next);
    playStartRef.current = { at: performance.now(), time: next };
  };

  const togglePlay = async () => {
    if (currentTime >= totalDuration) seek(0);
    if (playing) {
      setPlaying(false);
      audioRef.current?.pause();
    } else {
      setPlaying(true);
      if (audioUrl && audioRef.current) {
        audioRef.current.currentTime = currentTime;
        await audioRef.current.play().catch(() => setPlaying(false));
      }
    }
  };

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

  const undo = () => {
    const history = historyRef.current[activeId] || [];
    if (!history.length) return;
    const previous = history[history.length - 1];
    redoRef.current[activeId] = [...(redoRef.current[activeId] || []), activeCut.strokes];
    historyRef.current[activeId] = history.slice(0, -1);
    mutate({ type: "strokes", cutId: activeId, strokes: previous });
  };

  const redo = () => {
    const redoStack = redoRef.current[activeId] || [];
    if (!redoStack.length) return;
    const next = redoStack[redoStack.length - 1];
    historyRef.current[activeId] = [...(historyRef.current[activeId] || []), activeCut.strokes];
    redoRef.current[activeId] = redoStack.slice(0, -1);
    mutate({ type: "strokes", cutId: activeId, strokes: next });
  };

  const addCut = () => {
    const id = `c${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    mutate({ type: "add", cut: { id, title: `新しいカット ${cuts.length + 1}`, duration: 3, note: "演出メモを入力…", strokes: [] }, afterId: null });
    setActiveId(id);
    setCurrentTime(totalDuration);
    setToast("カットを追加しました");
  };

  const duplicateCut = () => {
    const id = `c${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const clone = { ...activeCut, id, title: `${activeCut.title} コピー`, strokes: activeCut.strokes.map((s) => ({ ...s, points: [...s.points] })) };
    mutate({ type: "add", cut: clone, afterId: activeCut.id });
    setToast("カットを複製しました");
  };

  const deleteCut = () => {
    if (cuts.length <= 1) return;
    const next = cuts.filter((cut) => cut.id !== activeId);
    mutate({ type: "delete", cutId: activeId });
    setActiveId(next[Math.min(activeIndex, next.length - 1)].id);
    setToast("カットを削除しました");
  };

  const updateActive = (patch: Partial<Pick<Cut, "title" | "duration" | "note">>) =>
    mutate({ type: "patch", cutId: activeId, patch });

  const chooseCut = (cut: Cut, index: number) => {
    setActiveId(cut.id);
    seek(cutStart(index));
  };

  const onAudio = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(URL.createObjectURL(file));
    setAudioFile(file);
    setAudioName(file.name.replace(/\.[^.]+$/, ""));
    setPlaying(false);
    seek(0);
    setToast("楽曲を読み込みました");
  };

  const exportFrame = () => {
    const canvas = document.createElement("canvas");
    canvas.width = EXPORT_WIDTH;
    canvas.height = EXPORT_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    paintStrokes(ctx, activeCut.strokes, EXPORT_WIDTH, EXPORT_HEIGHT);
    const link = document.createElement("a");
    link.download = `${activeCut.title}.png`;
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
    const blob = await exportSequenceZip(cuts, {
      fps: DEFAULT_FPS,
      width: EXPORT_WIDTH,
      height: EXPORT_HEIGHT,
      projectName,
      onProgress: (ratio, label) => setBusy({ ratio, label }),
    });
    downloadBlob(blob, `${projectName}_sequence.zip`);
    setToast("連番PNGとAEスクリプトを書き出しました");
  });

  const exportMp4 = () => runExport("ムービー書き出し", async () => {
    const result = await exportMovie(cuts, audioFile, {
      fps: DEFAULT_FPS,
      width: EXPORT_WIDTH,
      height: EXPORT_HEIGHT,
      projectName,
      onProgress: (ratio, label) => setBusy({ ratio, label }),
    });
    downloadBlob(result.blob, `${projectName}.mp4`);
    if (result.hadAudio && !result.audioCodec) setToast("音声コーデック非対応のため映像のみ書き出しました");
    else if (!result.hadAudio) setToast("音源未読み込みのため映像のみ書き出しました");
    // Opus inside MP4 plays in browsers but After Effects will not read it.
    else if (result.audioCodec === "opus") setToast("AAC非対応環境のため音声はOpusです（AEでは読めません）");
    else setToast("音声付きMP4を書き出しました");
  });

  const onTimelinePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    seek(((event.clientX - rect.left) / rect.width) * totalDuration);
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">C</span><span>CONTE</span><b>LIVE</b></div>
        <div className="project-title">
          <button className="crumb">Projects</button><span>/</span>
          <input aria-label="プロジェクト名" value={projectName} onChange={(e) => setProjectName(e.target.value)} />
          <span className="saved"><i />{role === "host" ? "この端末に保存" : "ホストが保存中"}</span>
        </div>
        <div className="export-actions">
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
          <div className="section-heading"><span>カット</span><button onClick={addCut} aria-label="カットを追加">＋</button></div>
          <div className="cut-list">
            {cuts.map((cut, index) => (
              <button key={cut.id} className={`cut-card ${cut.id === activeId ? "active" : ""}`} onClick={() => chooseCut(cut, index)}>
                <span className="cut-no">{String(index + 1).padStart(2, "0")}</span>
                <span className="thumb"><MiniCanvas strokes={cut.strokes} />{cut.strokes.length === 0 && <span className={`placeholder p${index % 4}`} />}</span>
                <span className="cut-copy"><strong>{cut.title}</strong><small>{cut.duration.toFixed(1)}秒 · {formatTime(cutStart(index))}</small></span>
              </button>
            ))}
          </div>
          <button className="add-cut" onClick={addCut}>＋ カットを追加</button>
        </aside>

        <section className="stage-area">
          <div className="tool-row">
            <div className="tools">
              <button className={selectedTool === "pen" ? "selected" : ""} onClick={() => setSelectedTool("pen")} title="ペン"><span className="pen-icon" /></button>
              <button className={selectedTool === "eraser" ? "selected" : ""} onClick={() => setSelectedTool("eraser")} title="消しゴム"><span className="eraser-icon" /></button>
              <span className="divider" />
              {COLORS.map((swatch) => <button key={swatch} className={`swatch ${color === swatch ? "selected" : ""}`} style={{ "--swatch": swatch } as React.CSSProperties} onClick={() => { setColor(swatch); setSelectedTool("pen"); }} aria-label={`色 ${swatch}`} />)}
              <span className="divider" />
              <label className="size-control"><span>線</span><input type="range" min="1" max="14" value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} /><b>{brushSize}</b></label>
            </div>
            <div className="history-tools">
              <button onClick={undo} title="元に戻す">↶</button><button onClick={redo} title="やり直す">↷</button>
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
              <label>カット名<input value={activeCut.title} onChange={(e) => updateActive({ title: e.target.value })} /></label>
              <label>尺<div className="duration-field"><input type="number" min="0.3" step="0.1" value={activeCut.duration} onChange={(e) => updateActive({ duration: Math.max(.3, Number(e.target.value)) })} /><span>秒</span></div></label>
              <label>演出メモ<textarea value={activeCut.note} onChange={(e) => updateActive({ note: e.target.value })} /></label>
              <div className="tag-row"><span>CAM</span><button>FIX</button><button>PAN →</button><button>＋</button></div>
              <div className="note-actions"><button onClick={duplicateCut}>複製</button><button onClick={exportFrame}>PNG</button><button className="danger" onClick={deleteCut}>削除</button></div>
            </aside>}
          </div>
        </section>
      </section>

      <section className="transport">
        <div className="transport-main">
          <div className="playback">
            <button onClick={() => seek(Math.max(0, currentTime - 1))}>−1s</button>
            <button className="play" onClick={togglePlay} aria-label={playing ? "停止" : "再生"}>{playing ? "Ⅱ" : "▶"}</button>
            <button onClick={() => seek(Math.min(totalDuration, currentTime + 1))}>+1s</button>
            <span className="timecode">{formatTime(currentTime)} <small>/ {formatTime(totalDuration)}</small></span>
          </div>
          <div className="audio-info">
            <span className="wave-icon">≋</span><div><strong>{audioName}</strong><small>{audioUrl ? "読み込み済み · この端末だけで再生" : "デモ再生 · 音源を追加できます"}</small></div>
            <label className="audio-upload">音源を変更<input type="file" accept="audio/*" onChange={onAudio} /></label>
            {/* Playback engine for the timeline, not user-facing media, so there is nothing to caption. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            {audioUrl && <audio ref={audioRef} src={audioUrl} onEnded={() => setPlaying(false)} />}
          </div>
          <div className="view-control"><span>−</span><input type="range" min="70" max="130" defaultValue="100" /><span>＋</span></div>
        </div>
        <div className="timeline-scroller">
          <div className="track-labels"><span>VIDEO</span><span>AUDIO</span></div>
          <div className="timeline" ref={timelineRef} onPointerDown={onTimelinePointer}>
            <div className="ruler">{[0, .25, .5, .75, 1].map((v) => <span key={v} style={{ left: `${v * 100}%` }}>{formatTime(v * totalDuration).slice(0, 5)}</span>)}</div>
            <div className="video-track">
              {cuts.map((cut, index) => <button key={cut.id} className={`timeline-cut ${cut.id === activeId ? "active" : ""}`} style={{ width: `${(cut.duration / totalDuration) * 100}%` }} onClick={(e) => { e.stopPropagation(); chooseCut(cut, index); }}><span>{index + 1}</span><b>{cut.title}</b></button>)}
            </div>
            <div className="audio-track"><div className="waveform">{Array.from({ length: 90 }, (_, i) => <i key={i} style={{ height: `${20 + ((i * 37) % 65)}%` }} />)}</div></div>
            <div className="playhead" style={{ left: `${(currentTime / totalDuration) * 100}%` }}><i /></div>
          </div>
        </div>
      </section>

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
