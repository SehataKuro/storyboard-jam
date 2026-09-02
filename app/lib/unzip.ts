/**
 * Minimal ZIP reader for re-importing an exported bundle.
 * Handles stored (method 0) entries written by our own writer, and deflated (method 8)
 * entries produced when a folder is re-zipped by the OS.
 */

type CentralEntry = { name: string; method: number; compressedSize: number; localOffset: number };

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

function findEndOfCentralDirectory(view: DataView) {
  // The EOCD sits at the end, after an optional comment of up to 64KB.
  const start = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= start; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

export function listZipEntries(buffer: ArrayBuffer): CentralEntry[] {
  const view = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new Error("ZIPとして読み取れませんでした");

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries: CentralEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) break;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    entries.push({
      name: decoder.decode(new Uint8Array(buffer, offset + 46, nameLength)),
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      localOffset: view.getUint32(offset + 42, true),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array) {
  const stream = new Blob([data as unknown as BlobPart]).stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZipEntry(buffer: ArrayBuffer, entry: CentralEntry) {
  const view = new DataView(buffer);
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const data = new Uint8Array(buffer, start, entry.compressedSize);

  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRaw(data);
  throw new Error("対応していない圧縮形式のZIPです");
}

/** Reads one text entry by matching the tail of its path, ignoring any wrapping folder. */
export async function readZipTextBySuffix(buffer: ArrayBuffer, suffix: string) {
  const entry = listZipEntries(buffer).find((item) => item.name.endsWith(suffix));
  if (!entry) return null;
  return new TextDecoder().decode(await readZipEntry(buffer, entry));
}
