import { Stroke } from "./types";

/** Stroke sizes are authored against a stage roughly this wide, so exports scale from it. */
export const STROKE_REFERENCE_WIDTH = 960;
export const PAPER_COLOR = "#fffef8";

/** Paints one cut onto any 2D context. Used by the editor, the PNG sequence and the movie encoder. */
export function paintStrokes(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  strokes: Stroke[],
  width: number,
  height: number,
) {
  ctx.fillStyle = PAPER_COLOR;
  ctx.fillRect(0, 0, width, height);
  const scale = width / STROKE_REFERENCE_WIDTH;

  strokes.forEach((stroke) => {
    if (!stroke.points.length) return;
    ctx.globalCompositeOperation = stroke.eraser ? "destination-out" : "source-over";
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = Math.max(1, stroke.size * scale);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    const first = stroke.points[0];
    ctx.moveTo(first.x * width, first.y * height);
    stroke.points.slice(1).forEach((point) => ctx.lineTo(point.x * width, point.y * height));
    if (stroke.points.length === 1) ctx.lineTo(first.x * width + 0.1, first.y * height + 0.1);
    ctx.stroke();
  });
  ctx.globalCompositeOperation = "source-over";
}

/** Renders a cut to an offscreen canvas at export resolution. */
export function renderCutToCanvas(strokes: Stroke[], width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2Dコンテキストを取得できませんでした");
  // Eraser strokes cut holes in the paper, so composite on white afterwards.
  paintStrokes(ctx, strokes, width, height);
  return canvas;
}

export function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNGの生成に失敗しました"))), "image/png");
  });
}
