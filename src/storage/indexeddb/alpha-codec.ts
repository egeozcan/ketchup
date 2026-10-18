// src/storage/indexeddb/alpha-codec.ts
//
// Tip masks are 8-bit and mostly smooth or empty, so deflate takes most of
// their size. Compression is best-effort: without CompressionStream, or when
// the round trip doesn't give the bytes back (some Safari versions truncate
// large flushes), the mask is stored as it is.

export interface PackedAlpha {
  encoding: 'raw' | 'deflate';
  data: ArrayBuffer;
}

async function run(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(out);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function packAlpha(alpha: Uint8Array): Promise<PackedAlpha> {
  const raw: PackedAlpha = { encoding: 'raw', data: alpha.slice().buffer };
  if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') return raw;
  try {
    const packed = await run(alpha, new CompressionStream('deflate'));
    if (packed.length >= alpha.length) return raw;
    const back = await run(packed, new DecompressionStream('deflate'));
    return sameBytes(back, alpha) ? { encoding: 'deflate', data: packed.slice().buffer } : raw;
  } catch {
    return raw;
  }
}

/** The bytes packed by `packAlpha`; null when the record is malformed or can't be inflated here. */
export async function unpackAlpha(encoding: unknown, data: unknown): Promise<Uint8Array | null> {
  if (Object.prototype.toString.call(data) !== '[object ArrayBuffer]') return null;
  if (encoding === 'raw') return new Uint8Array(data as ArrayBuffer);
  if (encoding !== 'deflate' || typeof DecompressionStream === 'undefined') return null;
  try {
    return await run(new Uint8Array(data as ArrayBuffer), new DecompressionStream('deflate'));
  } catch {
    return null;
  }
}
