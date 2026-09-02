export type Point = { x: number; y: number };
export type Stroke = { color: string; size: number; points: Point[]; eraser?: boolean };

/**
 * A cut is a boundary on the song timeline, not a length of its own.
 * The cut runs from its own `start` to the next cut's `start` (or to the end of the song).
 */
export type Cut = {
  id: string;
  title: string;
  note: string;
  start: number;
  strokes: Stroke[];
  /** A clipboard image placed underneath the pen strokes. */
  backgroundImage?: string;
};

/** The shared project: the song length owns the total, cuts partition it. */
export type Project = { duration: number; cuts: Cut[] };

/** The frame is what gets exported. Stroke coordinates are normalised against it. */
export const EXPORT_WIDTH = 1920;
export const EXPORT_HEIGHT = 1080;
export const DEFAULT_FPS = 24;

/** The timeline's smallest unit is one frame, so every position lands on one. */
export function snapToFrame(seconds: number, fps = DEFAULT_FPS) {
  if (!Number.isFinite(seconds)) return 0;
  return Math.round(seconds * fps) / fps;
}

/** A timeline position is zero-based: frame 24 is displayed as 1+0. */
export function formatFramePosition(seconds: number, fps = DEFAULT_FPS) {
  const totalFrames = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * fps));
  return `${Math.floor(totalFrames / fps)}+${totalFrames % fps}`;
}

/** A duration is at least one frame: 0+1 ... 0+23, then 1+0 at 24fps. */
export function formatFrameDuration(seconds: number, fps = DEFAULT_FPS) {
  const totalFrames = Math.max(1, Math.round((Number.isFinite(seconds) ? seconds : 0) * fps));
  return `${Math.floor(totalFrames / fps)}+${totalFrames % fps}`;
}

/** Parses the seconds+frames notation used by the cut duration field. */
export function parseFrameDuration(value: string, fps = DEFAULT_FPS) {
  const match = value.trim().match(/^(\d+)\s*\+\s*(\d+)$/);
  if (!match) return null;
  const seconds = Number(match[1]);
  const frames = Number(match[2]);
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(frames) || frames >= fps) return null;
  const totalFrames = seconds * fps + frames;
  return totalFrames >= 1 ? totalFrames / fps : null;
}

/** Working margin around the frame, in frame pixels. Drawable, but outside the export. */
export const FRAME_MARGIN = 200;
export const CANVAS_WIDTH = EXPORT_WIDTH + FRAME_MARGIN * 2;
export const CANVAS_HEIGHT = EXPORT_HEIGHT + FRAME_MARGIN * 2;
/** How much of the stage each margin band takes, used to place the frame on any canvas size. */
export const MARGIN_RATIO_X = FRAME_MARGIN / CANVAS_WIDTH;
export const MARGIN_RATIO_Y = FRAME_MARGIN / CANVAS_HEIGHT;

/** Used until a song is loaded, so the timeline is never zero-length. */
export const DEFAULT_DURATION = 60;
export const MIN_CUT_DURATION = 1 / DEFAULT_FPS;

export const newCutId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const cutEndOf = (project: Project, index: number) =>
  index + 1 < project.cuts.length ? project.cuts[index + 1].start : project.duration;

export const cutDurationOf = (project: Project, index: number) =>
  Math.max(0, cutEndOf(project, index) - project.cuts[index].start);

export const cutIndexAt = (project: Project, time: number) => {
  for (let index = project.cuts.length - 1; index >= 0; index -= 1) {
    if (time >= project.cuts[index].start) return index;
  }
  return 0;
};

export const createEmptyProject = (duration = DEFAULT_DURATION): Project => ({
  duration,
  cuts: [{ id: newCutId(), title: "", note: "", start: 0, strokes: [] }],
});

/** Keeps the invariants every consumer relies on: sorted, starting at 0, inside the song. */
export function normalizeProject(project: Project): Project {
  const duration = Math.max(MIN_CUT_DURATION, project.duration || DEFAULT_DURATION);
  const sorted = [...project.cuts].sort((a, b) => a.start - b.start);
  const cuts: Cut[] = [];
  sorted.forEach((cut) => {
    const previous = cuts[cuts.length - 1];
    const floor = previous ? previous.start + MIN_CUT_DURATION : 0;
    const start = cuts.length === 0 ? 0 : Math.min(Math.max(cut.start, floor), duration - MIN_CUT_DURATION);
    if (previous && start - previous.start < MIN_CUT_DURATION) return;
    cuts.push({ ...cut, start, strokes: Array.isArray(cut.strokes) ? cut.strokes : [] });
  });
  return { duration, cuts: cuts.length ? cuts : createEmptyProject(duration).cuts };
}
