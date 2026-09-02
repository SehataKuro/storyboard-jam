"use client";

import { ChangeEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Point = { x: number; y: number };
type Stroke = { color: string; size: number; points: Point[]; eraser?: boolean };
type Cut = { id: string; title: string; duration: number; note: string; strokes: Stroke[] };

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
  const frame = Math.floor((safe % 1) * 24).toString().padStart(2, "0");
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

  [...strokes, ...(draft ? [draft] : [])].forEach((stroke) => {
    if (stroke.points.length < 1) return;
    ctx.globalCompositeOperation = stroke.eraser ? "destination-out" : "source-over";
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = stroke.size * (thumbnail ? .32 : 1);
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
  const [panelOpen, setPanelOpen] = useState(true);
  const [toast, setToast] = useState("全員の変更を同期しました");
  const [draft, setDraft] = useState<Stroke | null>(null);
  const [collabPulse, setCollabPulse] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number | null>(null);
  const playStartRef = useRef({ at: 0, time: 0 });
  const historyRef = useRef<Record<string, Stroke[][]>>({});
  const redoRef = useRef<Record<string, Stroke[][]>>({});
  const clientId = useRef(Math.random().toString(36).slice(2));
  const remoteChange = useRef(false);
  const serverVersion = useRef(0);
  const cloudReady = useRef(false);
  const saving = useRef(false);

  const totalDuration = useMemo(() => cuts.reduce((sum, cut) => sum + cut.duration, 0), [cuts]);
  const activeIndex = Math.max(0, cuts.findIndex((cut) => cut.id === activeId));
  const activeCut = cuts[activeIndex] || cuts[0];
  const cutStart = useCallback((index: number) => cuts.slice(0, index).reduce((sum, cut) => sum + cut.duration, 0), [cuts]);

  useEffect(() => {
    const stored = window.localStorage.getItem("conte-live-project") || window.localStorage.getItem("konte-live-project");
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as { cuts: Cut[] };
        if (parsed.cuts?.length) setCuts(parsed.cuts);
      } catch { /* keep demo project */ }
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("conte-live-project", JSON.stringify({ cuts }));
  }, [cuts]);

  useEffect(() => {
    let cancelled = false;
    const pull = async (initial = false) => {
      try {
        const response = await fetch("/api/project?room=main", { cache: "no-store" });
        const data = await response.json() as { project: { cuts: Cut[]; version: number } | null };
        if (cancelled) return;
        if (data.project && data.project.version > serverVersion.current) {
          serverVersion.current = data.project.version;
          remoteChange.current = true;
          setCuts(data.project.cuts);
          if (!initial) { setCollabPulse(true); window.setTimeout(() => setCollabPulse(false), 900); }
        }
        cloudReady.current = true;
      } catch { cloudReady.current = true; }
    };
    void pull(true);
    const timer = window.setInterval(() => { if (!saving.current) void pull(); }, 1200);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!cloudReady.current || remoteChange.current) return;
    const timer = window.setTimeout(async () => {
      saving.current = true;
      try {
        const response = await fetch("/api/project", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ room: "main", cuts }),
        });
        const data = await response.json() as { version?: number };
        if (data.version) serverVersion.current = data.version;
      } finally { saving.current = false; }
    }, 450);
    return () => window.clearTimeout(timer);
  }, [cuts]);

  useEffect(() => {
    const channel = new BroadcastChannel("conte-live-room-main");
    channel.onmessage = (event) => {
      if (event.data?.clientId === clientId.current) return;
      if (event.data?.type === "project" && event.data.cuts) {
        remoteChange.current = true;
        setCuts(event.data.cuts);
        setCollabPulse(true);
        window.setTimeout(() => setCollabPulse(false), 900);
      }
      if (event.data?.type === "hello") channel.postMessage({ type: "project", cuts, clientId: clientId.current });
    };
    channel.postMessage({ type: "hello", clientId: clientId.current });
    return () => channel.close();
  }, []); // initial room connection

  useEffect(() => {
    if (remoteChange.current) { remoteChange.current = false; return; }
    const channel = new BroadcastChannel("conte-live-room-main");
    channel.postMessage({ type: "project", cuts, clientId: clientId.current });
    channel.close();
  }, [cuts]);

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
    setCuts((all) => all.map((cut) => cut.id === activeId ? { ...cut, strokes: [...cut.strokes, draft] } : cut));
    setDraft(null);
  };

  const undo = () => {
    const history = historyRef.current[activeId] || [];
    if (!history.length) return;
    const previous = history[history.length - 1];
    redoRef.current[activeId] = [...(redoRef.current[activeId] || []), activeCut.strokes];
    historyRef.current[activeId] = history.slice(0, -1);
    setCuts((all) => all.map((cut) => cut.id === activeId ? { ...cut, strokes: previous } : cut));
  };

  const redo = () => {
    const redoStack = redoRef.current[activeId] || [];
    if (!redoStack.length) return;
    const next = redoStack[redoStack.length - 1];
    historyRef.current[activeId] = [...(historyRef.current[activeId] || []), activeCut.strokes];
    redoRef.current[activeId] = redoStack.slice(0, -1);
    setCuts((all) => all.map((cut) => cut.id === activeId ? { ...cut, strokes: next } : cut));
  };

  const addCut = () => {
    const id = `c${Date.now()}`;
    const newCut: Cut = { id, title: `新しいカット ${cuts.length + 1}`, duration: 3, note: "演出メモを入力…", strokes: [] };
    setCuts((all) => [...all, newCut]);
    setActiveId(id);
    setCurrentTime(totalDuration);
    setToast("カットを追加しました");
  };

  const duplicateCut = () => {
    const id = `c${Date.now()}`;
    const clone = { ...activeCut, id, title: `${activeCut.title} コピー`, strokes: activeCut.strokes.map((s) => ({ ...s, points: [...s.points] })) };
    setCuts((all) => [...all.slice(0, activeIndex + 1), clone, ...all.slice(activeIndex + 1)]);
    setToast("カットを複製しました");
  };

  const deleteCut = () => {
    if (cuts.length <= 1) return;
    const next = cuts.filter((cut) => cut.id !== activeId);
    setCuts(next);
    setActiveId(next[Math.min(activeIndex, next.length - 1)].id);
    setToast("カットを削除しました");
  };

  const updateActive = (patch: Partial<Cut>) => setCuts((all) => all.map((cut) => cut.id === activeId ? { ...cut, ...patch } : cut));

  const chooseCut = (cut: Cut, index: number) => {
    setActiveId(cut.id);
    seek(cutStart(index));
  };

  const onAudio = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    const url = URL.createObjectURL(file);
    setAudioUrl(url);
    setAudioName(file.name.replace(/\.[^.]+$/, ""));
    setPlaying(false);
    seek(0);
    setToast("楽曲を読み込みました");
  };

  const exportFrame = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = `${activeCut.title}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    setToast("現在のカットを書き出しました");
  };

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
          <input aria-label="プロジェクト名" defaultValue="雨上がりのMV" />
          <span className="saved"><i />保存済み</span>
        </div>
        <div className="people" aria-label="参加中のメンバー">
          <span className="presence-text"><i className={collabPulse ? "pulse" : ""} />共有ルーム接続中</span>
          <div className="avatars"><span className="av av1">YOU</span></div>
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
            <span className="wave-icon">≋</span><div><strong>{audioName}</strong><small>{audioUrl ? "読み込み済み" : "デモ再生 · 音源を追加できます"}</small></div>
            <label className="audio-upload">音源を変更<input type="file" accept="audio/*" onChange={onAudio} /></label>
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
      <div className="toast" key={toast}>{toast}</div>
    </main>
  );
}
