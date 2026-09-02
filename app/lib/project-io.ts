import { Project, newCutId, normalizeProject } from "./types";
import { readZipTextBySuffix } from "./unzip";

export const PROJECT_FILE = "project.json";
export const TIMING_FILE = "timing.json";
export const IMAGE_DIR = "images";

export type Bundle = { project: Project; projectName: string; strokesRestored: boolean };

/** The complete, re-importable state. Images in the bundle are for other tools, not for us. */
export function buildProjectFile(project: Project, projectName: string) {
  return JSON.stringify({ format: "conte-live/project", version: 1, projectName, project }, null, 2);
}

function parseProjectFile(text: string): Bundle | null {
  const parsed = JSON.parse(text) as { projectName?: string; project?: Project };
  if (!parsed.project?.cuts?.length) return null;
  return {
    project: normalizeProject(parsed.project),
    projectName: parsed.projectName || "",
    strokesRestored: true,
  };
}

/** Older bundles only carry timing, so cuts come back without their drawings. */
function parseTimingFile(text: string): Bundle | null {
  const parsed = JSON.parse(text) as {
    project?: string;
    totalDuration?: number;
    cuts?: { title?: string; note?: string; start?: number }[];
  };
  if (!parsed.cuts?.length || !parsed.totalDuration) return null;
  return {
    project: normalizeProject({
      duration: parsed.totalDuration,
      cuts: parsed.cuts.map((cut) => ({
        id: newCutId(),
        title: cut.title || "",
        note: cut.note || "",
        start: cut.start || 0,
        strokes: [],
      })),
    }),
    projectName: parsed.project || "",
    strokesRestored: false,
  };
}

const NOT_A_BUNDLE = "project.json が見つかりません。書き出したZIPかそのフォルダを選んでください。";

export async function readBundleFromZip(file: File): Promise<Bundle> {
  const buffer = await file.arrayBuffer();
  const projectText = await readZipTextBySuffix(buffer, PROJECT_FILE);
  if (projectText) {
    const bundle = parseProjectFile(projectText);
    if (bundle) return bundle;
  }
  const timingText = await readZipTextBySuffix(buffer, TIMING_FILE);
  const fallback = timingText ? parseTimingFile(timingText) : null;
  if (fallback) return fallback;
  throw new Error(NOT_A_BUNDLE);
}

/** Accepts the extracted folder as picked by a directory input. */
export async function readBundleFromFiles(files: FileList): Promise<Bundle> {
  const all = Array.from(files);
  const byName = (name: string) => all.find((file) => file.name === name);

  const projectFile = byName(PROJECT_FILE);
  if (projectFile) {
    const bundle = parseProjectFile(await projectFile.text());
    if (bundle) return bundle;
  }
  const timingFile = byName(TIMING_FILE);
  const fallback = timingFile ? parseTimingFile(await timingFile.text()) : null;
  if (fallback) return fallback;

  // A single .zip dropped into the folder picker is still worth handling.
  const zip = all.find((file) => file.name.toLowerCase().endsWith(".zip"));
  if (zip) return readBundleFromZip(zip);

  throw new Error(NOT_A_BUNDLE);
}
