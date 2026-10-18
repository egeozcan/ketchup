import { AbrParseError } from './errors.js';

/**
 * A big-endian cursor over bytes where every read is checked against the end,
 * so a short or lying file raises `AbrParseError` rather than reading past it
 * (a DataView would throw a RangeError, which is not ours to leak).
 */
export class ByteReader {
  private _view: DataView;
  private _bytes: Uint8Array;
  /** Absolute offset into the buffer the reader was made over. */
  pos: number;
  readonly end: number;

  constructor(data: ArrayBuffer | ArrayBufferView, start = 0, end?: number) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this._bytes = bytes;
    this._view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.end = Math.min(end ?? bytes.length, bytes.length);
    this.pos = start;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  /** A reader over the next `length` bytes, which this one steps over. */
  slice(length: number): ByteReader {
    this.need(length);
    const sub = new ByteReader(this._bytes, this.pos, this.pos + length);
    this.pos += length;
    return sub;
  }

  /** Throws unless `n` more bytes are there. */
  need(n: number): void {
    if (!Number.isInteger(n) || n < 0 || this.pos + n > this.end) {
      throw new AbrParseError('The file ends unexpectedly (it may be damaged or cut short).');
    }
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }

  seek(pos: number): void {
    if (!Number.isInteger(pos) || pos < 0 || pos > this.end) throw new AbrParseError('A record points outside the file.');
    this.pos = pos;
  }

  u8(): number {
    this.need(1);
    return this._view.getUint8(this.pos++);
  }

  i16(): number {
    this.need(2);
    const v = this._view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }

  u16(): number {
    this.need(2);
    const v = this._view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this._view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this._view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this._view.getFloat64(this.pos);
    this.pos += 8;
    return v;
  }

  /** A 64-bit integer as a (possibly imprecise) number. */
  i64(): number {
    this.need(8);
    const v = Number(this._view.getBigInt64(this.pos));
    this.pos += 8;
    return v;
  }

  /** The next `n` bytes, as a view onto the buffer (not a copy). */
  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this._bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Four characters, as tags and OSTypes are written. */
  fourCC(): string {
    return String.fromCharCode(...this.bytes(4));
  }

  /** The next four characters without moving; empty when fewer remain. */
  peekFourCC(): string {
    if (this.remaining < 4) return '';
    return String.fromCharCode(...this._bytes.subarray(this.pos, this.pos + 4));
  }

  /** A string with a one-byte length in front, in Latin-1. */
  pascal(): string {
    const n = this.u8();
    return String.fromCharCode(...this.bytes(n));
  }

  /** A UTF-16BE string with a 32-bit length in characters in front; trailing NULs are dropped. */
  unicode(maxChars: number): string {
    const n = this.u32();
    if (n > maxChars) throw new AbrParseError('The file holds a text that is too long.');
    this.need(n * 2);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u16());
    return s.replace(/\0+$/, '');
  }
}
