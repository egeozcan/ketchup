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

const MAX_RAW_DIMENSION = 16384; // the app's largest canvas side

/**
 * Stored pixel data that is corrupt or malformed (bad header or size, truncated
 * or invalid deflate stream, undecodable PNG), as opposed to a failure to read
 * it from storage. Only this is a reason to drop a history entry on load.
 */
export class PixelDecodeError extends Error {
  override name = 'PixelDecodeError';
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
  }
}

/** A blob that can no longer be read from storage (DOMException NotFoundError / NotReadableError). */
function isBlobReadError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'NotFoundError' || name === 'NotReadableError';
}

function canDecompress(): boolean {
  return typeof DecompressionStream !== 'undefined' && typeof Blob !== 'undefined' &&
    typeof Blob.prototype.stream === 'function';
}

function hasCompressionApis(): boolean {
  return typeof CompressionStream !== 'undefined' && canDecompress();
}

const COMPRESSION_TEST_TIMEOUT_MS = 3000;

// Cached only once the self-test reached a verdict (round trip matched or
// not); a timeout or an exception may be transient, so those aren't cached.
let compressionVerdict: boolean | null = null;
let compressionTest: Promise<boolean> | null = null;
// A timed-out test isn't repeated at once, or every save would wait it out again.
const COMPRESSION_RETRY_AFTER_MS = 60000;
let compressionTimedOutAt = -Infinity;

/**
 * One-time round trip of 64 KB of data that compresses to ~24 KB, all of it
 * written at the final flush (fewer than 16383 deflate symbols, so no block is
 * emitted earlier). Safari 16.4-16.5 truncates output when the flush exceeds
 * 16 KB (WebKit bug 254021), which would corrupt stored blobs; this catches it.
 */
function canCompress(): Promise<boolean> {
  if (compressionVerdict !== null) return Promise.resolve(compressionVerdict);
  if (!hasCompressionApis()) return Promise.resolve(false);
  if (!compressionTest) {
    if (Date.now() - compressionTimedOutAt < COMPRESSION_RETRY_AFTER_MS) return Promise.resolve(false);
    const test = new Promise<boolean>((resolve) => {
      // The test starts (and its timeout with it) once the thread is free, so
      // synchronous work the caller does right after this call doesn't count
      // against it.
      setTimeout(() => {
        const abort = new AbortController();
        let settled = false;
        // A stream that never resolves must not stall saves: past the timeout
        // the test is cancelled and this call falls back to PNG without
        // caching a verdict.
        const timer = setTimeout(() => {
          settled = true;
          compressionTimedOutAt = Date.now();
          abort.abort();
          resolve(false);
        }, COMPRESSION_TEST_TIMEOUT_MS);
        void runCompressionSelfTest(abort.signal).then((verdict) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (verdict !== null) compressionVerdict = verdict;
          else compressionTimedOutAt = Date.now();
          resolve(verdict === true);
        });
      }, 0);
    });
    compressionTest = test;
    void test.then(() => { compressionTest = null; });
  }
  return compressionTest;
}

/** Reads a stream to the end; aborting `signal` cancels it (and what feeds it). */
async function readAll(stream: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<Uint8Array> {
  const reader = stream.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel);
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
    const out = new Uint8Array(length);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

/**
 * true/false is a verdict on the round trip; null means the test itself failed
 * to run or was cancelled (a cancelled read ends early, which is no verdict).
 */
async function runCompressionSelfTest(signal: AbortSignal): Promise<boolean | null> {
  try {
    const n = 1 << 16;
    const data = new Uint8Array(n);
    let x = 12345;
    const next = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0);
    let i = 0;
    for (; i < 4096; i++) data[i] = next() >>> 24;
    // 4-11 byte copies from earlier offsets: stays under one 16383-symbol
    // deflate block, so everything is written at the flush, whatever the chunking.
    while (i < n) {
      const len = 4 + (next() >>> 29);
      const src = i - 1 - (next() % Math.min(i - 1, 30000));
      for (let k = 0; k < len && i < n; k++) data[i++] = data[src + k];
    }
    const packed = await readAll(
      new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'), { signal }), signal);
    if (signal.aborted) return null;
    let back: Uint8Array;
    try {
      back = await readAll(
        new Blob([packed as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'), { signal }),
        signal);
    } catch {
      if (signal.aborted) return null;
      return false; // a stream that can't read back what it wrote is untrustworthy
    }
    if (signal.aborted) return null;
    if (back.length !== n) return false;
    for (let j = 0; j < n; j++) if (back[j] !== data[j]) return false;
    return true;
  } catch {
    return null;
  }
}

function checkRawSize(width: number, height: number) {
  if (!(width > 0 && height > 0) || width > MAX_RAW_DIMENSION || height > MAX_RAW_DIMENSION) {
    throw new PixelDecodeError(`Stored pixel data has invalid dimensions ${width}x${height}`);
  }
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
  if (!canDecompress()) throw new Error('DecompressionStream is unavailable');
  checkRawSize(width, height);
  const out = new Uint8ClampedArray(width * height * 4);
  const reader = blob.slice(RAW_HEADER_BYTES).stream()
    .pipeThrough(new DecompressionStream('deflate')).getReader();
  let off = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (off + value.length > out.length) throw new PixelDecodeError('Stored pixel data is larger than expected');
      out.set(value, off);
      off += value.length;
    }
    if (off !== out.length) throw new PixelDecodeError('Stored pixel data is truncated');
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    // A blob read failure (missing or unreadable storage) isn't a decode error.
    if (err instanceof PixelDecodeError || isBlobReadError(err)) throw err;
    // Otherwise the stream rejecting (a TypeError) means the deflate data is invalid.
    throw new PixelDecodeError('Stored pixel data is not valid deflate', err);
  }
  return new ImageData(out, width, height);
}

async function decodePng(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob);
  } catch (err) {
    // Only an undecodable image (InvalidStateError) is a format error; the
    // rest (out of memory, a read failure) may be transient.
    if ((err as { name?: string } | null)?.name !== 'InvalidStateError') throw err;
    throw new PixelDecodeError('Stored image could not be decoded', err);
  }
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
  const bitmap = await decodePng(blob);
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
  const bitmap = await decodePng(blob);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

// Raw deflate output above this share of the pixel bytes means photo-like
// content, where PNG's per-row filters usually compress much better.
const PNG_TRY_RATIO = 0.25;

/** Every pixel fully opaque: then a canvas round trip (premultiplied) is exact. */
function isOpaque(imageData: ImageData): boolean {
  const d = imageData.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return false;
  return true;
}

/**
 * Encode ImageData for storage: lossless raw+deflate where available, else PNG.
 * An opaque image that deflates poorly is stored as PNG when that is smaller;
 * PNG is lossless only without transparency, and loading reads both.
 */
export async function imageDataToBlob(imageData: ImageData): Promise<Blob> {
  if (await canCompress()) {
    const raw = await encodeRaw(imageData);
    if (raw.size > imageData.data.length * PNG_TRY_RATIO && isOpaque(imageData)) {
      const png = await encodePng(imageData).catch(() => null);
      if (png && png.size < raw.size) return png;
    }
    return raw;
  }
  return encodePng(imageData);
}

function encodePng(imageData: ImageData): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(imageData, 0, 0);
  return canvasToBlob(canvas);
}
