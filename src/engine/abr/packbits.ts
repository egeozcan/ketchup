import { ByteReader } from './reader.js';

/**
 * Photoshop's per-scanline PackBits: `rows` 16-bit byte counts, then each
 * row's packed bytes, which unpack to `rowBytes`. A row that unpacks short is
 * left zero-filled and one that would run long is clipped, so a damaged row
 * damages only itself; the counts themselves are bounds-checked by the reader.
 */
export function unpackRows(r: ByteReader, rows: number, rowBytes: number, out: Uint8Array): void {
  const counts: number[] = [];
  for (let y = 0; y < rows; y++) counts.push(r.u16());
  for (let y = 0; y < rows; y++) {
    const packed = r.bytes(counts[y]);
    unpackRow(packed, out.subarray(y * rowBytes, (y + 1) * rowBytes));
  }
}

function unpackRow(src: Uint8Array, dst: Uint8Array): void {
  let i = 0, o = 0;
  while (i < src.length && o < dst.length) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) {
      const count = Math.min(n + 1, dst.length - o, src.length - i);
      dst.set(src.subarray(i, i + count), o);
      i += n + 1;
      o += count;
    } else if (n !== -128) {
      if (i >= src.length) break;
      const count = Math.min(1 - n, dst.length - o);
      dst.fill(src[i++], o, o + count);
      o += count;
    }
  }
}
