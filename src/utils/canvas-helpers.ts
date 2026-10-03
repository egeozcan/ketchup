// src/utils/canvas-helpers.ts

export async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('canvas.toBlob returned null'));
    }, 'image/png');
  });
}

// ---------------------------------------------------------------------------
// Lossless stored pixel format
//
// Canvas toBlob/drawImage go through premultiplied alpha, which shifts
// semi-transparent pixels. Stored layer pixels and history ImageData are
// therefore written as raw RGBA, deflate-compressed, behind a 16 byte header:
// magic "KTCH", u32 version, u32 width, u32 height (big endian).
// Canvas stores premultiplied internally, so only the encode/decode boundary
// is lossless: what matters is that getImageData -> encode -> decode ->
// putImageData reproduces the ImageData exactly (no drawImage in between).
// Old projects hold PNG blobs; decoding sniffs the magic and reads both.
// Without CompressionStream, encoding falls back to PNG.
// ---------------------------------------------------------------------------

const RAW_MAGIC = [0x4b, 0x54, 0x43, 0x48]; // "KTCH"
const RAW_VERSION = 1;
const RAW_HEADER_BYTES = 16;

function canCompress(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

async function encodeRaw(imageData: ImageData): Promise<Blob> {
  const header = new ArrayBuffer(RAW_HEADER_BYTES);
  const view = new DataView(header);
  RAW_MAGIC.forEach((b, i) => view.setUint8(i, b));
  view.setUint32(4, RAW_VERSION);
  view.setUint32(8, imageData.width);
  view.setUint32(12, imageData.height);
  const body = new Blob([imageData.data as unknown as BlobPart]).stream()
    .pipeThrough(new CompressionStream('deflate'));
  const compressed = await new Response(body).blob();
  return new Blob([header, compressed], { type: 'application/octet-stream' });
}

/** Parsed header when the blob is in the raw format, null for anything else (PNG). */
async function readRawHeader(blob: Blob): Promise<{ width: number; height: number } | null> {
  if (blob.size < RAW_HEADER_BYTES) return null;
  const view = new DataView(await blob.slice(0, RAW_HEADER_BYTES).arrayBuffer());
  for (let i = 0; i < 4; i++) if (view.getUint8(i) !== RAW_MAGIC[i]) return null;
  if (view.getUint32(4) !== RAW_VERSION) throw new Error('Unsupported stored pixel format version');
  return { width: view.getUint32(8), height: view.getUint32(12) };
}

async function decodeRaw(blob: Blob, width: number, height: number): Promise<ImageData> {
  if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream is unavailable');
  const out = new Uint8ClampedArray(width * height * 4);
  const reader = blob.slice(RAW_HEADER_BYTES).stream()
    .pipeThrough(new DecompressionStream('deflate')).getReader();
  let off = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (off + value.length > out.length) throw new Error('Stored pixel data is larger than expected');
    out.set(value, off);
    off += value.length;
  }
  if (off !== out.length) throw new Error('Stored pixel data is truncated');
  return new ImageData(out, width, height);
}

/** Decode a stored pixel blob (raw format or legacy PNG) to ImageData of width x height. */
export async function blobToImageData(
  blob: Blob,
  width: number,
  height: number,
): Promise<ImageData> {
  const raw = await readRawHeader(blob);
  if (raw) {
    if (raw.width === width && raw.height === height) return decodeRaw(blob, width, height);
    // Size differs from what the record says (shouldn't happen): clip/pad like the PNG path did.
    const src = await decodeRaw(blob, raw.width, raw.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(src, 0, 0);
    return ctx.getImageData(0, 0, width, height);
  }
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, width, height);
}

/** Decode a stored pixel blob (raw format or legacy PNG) onto a new canvas. */
export async function blobToCanvas(
  blob: Blob,
  width: number,
  height: number,
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const raw = await readRawHeader(blob);
  if (raw) {
    // putImageData is the only canvas touch, so no extra rounding on load.
    ctx.putImageData(await decodeRaw(blob, raw.width, raw.height), 0, 0);
    return canvas;
  }
  const bitmap = await createImageBitmap(blob);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

/** Encode ImageData for storage: lossless raw+deflate where available, else PNG. */
export async function imageDataToBlob(imageData: ImageData): Promise<Blob> {
  if (canCompress()) return encodeRaw(imageData);
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(imageData, 0, 0);
  return canvasToBlob(canvas);
}
