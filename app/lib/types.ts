export type Point = { x: number; y: number };
export type Stroke = { color: string; size: number; points: Point[]; eraser?: boolean };

/**
 * A cut is a boundary on the song timeline, not a length of its own.
 * The cut runs from its own `start` to the next cut's `start` (or to the end of the song).
 */
export type Cut = { id: string; title: string; note: string; start: number; strokes: Stroke[] };

/** The shared project: the song length owns the total, cuts partition it. */
export type Project = { duration: number; cuts: Cut[] };

export const EXPORT_WIDTH = 1920;
export const EXPORT_HEIGHT = 1080;
export const DEFAULT_FPS = 24;

/** Used until a song is loaded, so the timeline is never zero-length. */
export const DEFAULT_DURATION = 60;
export const MIN_CUT_DURATION = 0.1;

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
    cuts.push({ ...cut, start });
  });
  return { duration, cuts: cuts.length ? cuts : createEmptyProject(duration).cuts };
}
