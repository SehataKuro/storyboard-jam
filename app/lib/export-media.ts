import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { canvasToPngBlob, renderCutToCanvas } from "./render";
import { buildAeScript, buildCutSheet, cutLabel } from "./ae";
import { createZip, ZipEntry } from "./zip";
import { Project, cutDurationOf, cutEndOf } from "./types";
import { IMAGE_DIR, PROJECT_FILE, buildProjectFile } from "./project-io";

export type ExportOptions = {
  fps: number;
  width: number;
  height: number;
  projectName: string;
  onProgress?: (ratio: number, label: string) => void;
};

const paddedName = (index: number) => `cut_${String(index + 1).padStart(4, "0")}.png`;
/** Images live in their own folder so the bundle root stays readable. */
const imagePath = (index: number) => `${IMAGE_DIR}/${paddedName(index)}`;

/** Frame index of a timeline position, used so per-cut frame counts never drift apart. */
const frameAt = (seconds: number, fps: number) => Math.round(seconds * fps);

/** PNG sequence + AE script + cut sheet, bundled as a single ZIP. */
export async function exportSequenceZip(project: Project, options: ExportOptions) {
  const { fps, width, height, projectName, onProgress } = options;
  const cuts = project.cuts;
  const entries: ZipEntry[] = [];

  for (let index = 0; index < cuts.length; index += 1) {
    onProgress?.(index / cuts.length, `カット ${index + 1}/${cuts.length} を描画中`);
    const canvas = await renderCutToCanvas(cuts[index].strokes, width, height, cuts[index].backgroundImage);
    const blob = await canvasToPngBlob(canvas);
    entries.push({ name: imagePath(index), data: new Uint8Array(await blob.arrayBuffer()) });
  }

  const encoder = new TextEncoder();
  entries.push({ name: `${projectName}.jsx`, data: encoder.encode(buildAeScript(project, { fps, width, height, projectName })) });
  entries.push({ name: "cut_sheet.txt", data: encoder.encode(buildCutSheet(project, fps)) });
  // Re-importable copy of the board, including the strokes the images cannot carry.
  entries.push({ name: PROJECT_FILE, data: encoder.encode(buildProjectFile(project, projectName)) });
  entries.push({
    name: "timing.json",
    data: encoder.encode(JSON.stringify({
      project: projectName,
      fps,
      width,
      height,
      totalDuration: project.duration,
      cuts: cuts.map((cut, index) => ({
        index: index + 1,
        file: imagePath(index),
        title: cutLabel(cut.title, index),
        note: cut.note,
        start: cut.start,
        duration: cutDurationOf(project, index),
        startFrame: frameAt(cut.start, fps),
        sourceTime: index / fps,
      })),
    }, null, 2)),
  });

  onProgress?.(1, "ZIPを生成中");
  return createZip(entries);
}

async function pickVideoCodec(width: number, height: number, fps: number) {
  const candidates = ["avc1.640028", "avc1.4d0028", "avc1.42e01e"];
  for (const codec of candidates) {
    const support = await VideoEncoder.isConfigSupported({ codec, width, height, framerate: fps });
    if (support.supported) return codec;
  }
  throw new Error("この環境ではH.264エンコードに対応していません。Chrome系のブラウザをお試しください。");
}

/**
 * AAC rejects unusual rates, and a plain AudioContext decodes at the output device rate
 * (96kHz on some machines), which would silently force the Opus fallback. Decode at 48kHz.
 */
const AUDIO_SAMPLE_RATE = 48_000;

async function decodeAudio(file: File, maxDuration: number) {
  const context = new OfflineAudioContext(2, 1, AUDIO_SAMPLE_RATE);
  const buffer = await context.decodeAudioData(await file.arrayBuffer());
  const frames = Math.min(buffer.length, Math.ceil(maxDuration * buffer.sampleRate));
  return { buffer, frames, sampleRate: buffer.sampleRate, channels: Math.min(2, buffer.numberOfChannels) };
}

/** Renders the whole storyboard to MP4 (H.264 + AAC) with the loaded track mixed in. */
export async function exportMovie(project: Project, audioFile: File | null, options: ExportOptions) {
  if (typeof window === "undefined" || typeof VideoEncoder === "undefined") {
    throw new Error("この環境はWebCodecsに未対応のため、ムービー書き出しを利用できません。");
  }
  const { fps, width, height, onProgress } = options;
  const cuts = project.cuts;
  const total = project.duration;
  const totalFrames = Math.max(1, frameAt(total, fps));
  const codec = await pickVideoCodec(width, height, fps);

  const audio = audioFile ? await decodeAudio(audioFile, total) : null;
  let audioCodec: "aac" | "opus" | null = null;
  if (audio) {
    const aac = await AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: audio.sampleRate, numberOfChannels: audio.channels, bitrate: 192_000 });
    if (aac.supported) audioCodec = "aac";
    else {
      const opus = await AudioEncoder.isConfigSupported({ codec: "opus", sampleRate: audio.sampleRate, numberOfChannels: audio.channels, bitrate: 192_000 });
      audioCodec = opus.supported ? "opus" : null;
    }
  }

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    fastStart: "in-memory",
    video: { codec: "avc", width, height, frameRate: fps },
    ...(audio && audioCodec
      ? { audio: { codec: audioCodec, numberOfChannels: audio.channels, sampleRate: audio.sampleRate } }
      : {}),
  });

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => { throw error; },
  });
  videoEncoder.configure({
    codec,
    width,
    height,
    framerate: fps,
    bitrate: 8_000_000,
    avc: { format: "avc" },
  });

  let emitted = 0;
  for (let index = 0; index < cuts.length; index += 1) {
    const startFrame = frameAt(cuts[index].start, fps);
    const endFrame = index === cuts.length - 1 ? totalFrames : frameAt(cutEndOf(project, index), fps);
    const canvas = await renderCutToCanvas(cuts[index].strokes, width, height, cuts[index].backgroundImage);

    for (let frame = startFrame; frame < endFrame; frame += 1) {
      // Keep the encoder queue shallow so memory stays flat on long boards.
      while (videoEncoder.encodeQueueSize > 8) await new Promise((resolve) => setTimeout(resolve, 4));
      const videoFrame = new VideoFrame(canvas, {
        timestamp: Math.round((frame / fps) * 1_000_000),
        duration: Math.round(1_000_000 / fps),
      });
      videoEncoder.encode(videoFrame, { keyFrame: frame === startFrame });
      videoFrame.close();
      emitted += 1;
      if (emitted % 12 === 0) onProgress?.((emitted / totalFrames) * 0.8, `映像 ${emitted}/${totalFrames} フレーム`);
    }
  }
  await videoEncoder.flush();
  videoEncoder.close();

  if (audio && audioCodec) {
    onProgress?.(0.85, "音声をエンコード中");
    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (error) => { throw error; },
    });
    audioEncoder.configure({
      codec: audioCodec === "aac" ? "mp4a.40.2" : "opus",
      sampleRate: audio.sampleRate,
      numberOfChannels: audio.channels,
      bitrate: 192_000,
    });

    const chunkFrames = 4096;
    const planes = Array.from({ length: audio.channels }, (_, channel) =>
      audio.buffer.getChannelData(Math.min(channel, audio.buffer.numberOfChannels - 1)));

    for (let offset = 0; offset < audio.frames; offset += chunkFrames) {
      const length = Math.min(chunkFrames, audio.frames - offset);
      const interleaved = new Float32Array(length * audio.channels);
      for (let channel = 0; channel < audio.channels; channel += 1) {
        interleaved.set(planes[channel].subarray(offset, offset + length), channel * length);
      }
      const data = new AudioData({
        format: "f32-planar",
        sampleRate: audio.sampleRate,
        numberOfFrames: length,
        numberOfChannels: audio.channels,
        timestamp: Math.round((offset / audio.sampleRate) * 1_000_000),
        data: interleaved,
      });
      audioEncoder.encode(data);
      data.close();
      while (audioEncoder.encodeQueueSize > 8) await new Promise((resolve) => setTimeout(resolve, 4));
    }
    await audioEncoder.flush();
    audioEncoder.close();
  }

  onProgress?.(0.97, "MP4を書き出し中");
  muxer.finalize();
  return {
    blob: new Blob([target.buffer], { type: "video/mp4" }),
    audioCodec,
    hadAudio: Boolean(audio),
  };
}
