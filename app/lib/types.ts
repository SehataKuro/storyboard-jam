export type Point = { x: number; y: number };
export type Stroke = { color: string; size: number; points: Point[]; eraser?: boolean };
export type Cut = { id: string; title: string; duration: number; note: string; strokes: Stroke[] };

/** Canvas aspect ratio used by both the editor stage and every export. */
export const EXPORT_WIDTH = 1920;
export const EXPORT_HEIGHT = 1080;
export const DEFAULT_FPS = 24;

export const totalDurationOf = (cuts: Cut[]) => cuts.reduce((sum, cut) => sum + cut.duration, 0);
export const cutStartOf = (cuts: Cut[], index: number) =>
  cuts.slice(0, index).reduce((sum, cut) => sum + cut.duration, 0);
