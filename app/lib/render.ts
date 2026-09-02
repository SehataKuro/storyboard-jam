import { Stroke } from "./types";

/** Stroke sizes are authored against a stage roughly this wide, so exports scale from it. */
export const STROKE_REFERENCE_WIDTH = 960;
export const PAPER_COLOR = "#fffef8";
export const EXPORT_PAPER_COLOR = "#ffffff";

/** Draws an image without cropping, centred inside the requested rectangle. */
export function drawContainedImage(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  image: HTMLImageElement | ImageBitmap,
  left: number,
  top: number,
  width: number,
  height: number,
) {
  const sourceWidth = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
  const sourceHeight = image instanceof HTMLImageElement ? image.naturalHeight : image.height;
  if (!sourceWidth || !sourceHeight) return;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  ctx.drawImage(image, left + (width - drawWidth) / 2, top + (height - drawHeight) / 2, drawWidth, drawHeight);
}

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

function loadImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("貼り付け画像を読み込めませんでした"));
    image.src = source;
  });
}

/** Renders a cut to an offscreen canvas at export resolution. */
export async function renderCutToCanvas(
  strokes: Stroke[],
  width: number,
  height: number,
  backgroundImage?: string,
) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2Dコンテキストを取得できませんでした");
  ctx.fillStyle = PAPER_COLOR;
  ctx.fillRect(0, 0, width, height);
  if (backgroundImage) drawContainedImage(ctx, await loadImage(backgroundImage), 0, 0, width, height);

  // Eraser strokes may cut holes through the drawing and pasted image. A final
  // destination-over pass guarantees every exported pixel is opaque white.
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
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = EXPORT_PAPER_COLOR;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = "source-over";
  return canvas;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data = new Uint8Array()) {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/** Encodes an RGB PNG (colour type 2), deliberately omitting an alpha channel. */
export async function canvasToPngBlob(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("PNGの生成に失敗しました");
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const rowLength = 1 + canvas.width * 3;
  const rgb = new Uint8Array(rowLength * canvas.height);
  for (let y = 0; y < canvas.height; y += 1) {
    const rowStart = y * rowLength;
    rgb[rowStart] = 0; // PNG filter: None
    for (let x = 0; x < canvas.width; x += 1) {
      const source = (y * canvas.width + x) * 4;
      const target = rowStart + 1 + x * 3;
      rgb[target] = rgba[source];
      rgb[target + 1] = rgba[source + 1];
      rgb[target + 2] = rgba[source + 2];
    }
  }

  const compressed = new Uint8Array(await new Response(
    new Blob([rgb]).stream().pipeThrough(new CompressionStream("deflate")),
  ).arrayBuffer());
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, canvas.width);
  headerView.setUint32(4, canvas.height);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour RGB, no alpha

  return new Blob([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", compressed),
    pngChunk("IEND"),
  ], { type: "image/png" });
}
