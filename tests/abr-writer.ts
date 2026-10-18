// A tiny ABR writer for tests: just enough of the v1/v2 and v6 layouts to
// build small synthetic files with known contents.

export class Out {
  parts: number[] = [];
  u8(v: number) { this.parts.push(v & 255); return this; }
  u16(v: number) { return this.u8(v >> 8).u8(v); }
  u32(v: number) { return this.u16(Math.floor(v / 65536) & 0xffff).u16(v & 0xffff); }
  i16(v: number) { return this.u16(v & 0xffff); }
  i32(v: number) { return this.u32(v >>> 0); }
  f64(v: number) {
    const b = new DataView(new ArrayBuffer(8));
    b.setFloat64(0, v);
    for (let i = 0; i < 8; i++) this.u8(b.getUint8(i));
    return this;
  }
  raw(s: string) { for (const c of s) this.u8(c.charCodeAt(0)); return this; }
  bytes(b: ArrayLike<number>) { for (let i = 0; i < b.length; i++) this.u8(b[i]); return this; }
  zeros(n: number) { for (let i = 0; i < n; i++) this.u8(0); return this; }
  pascal(s: string) { return this.u8(s.length).raw(s); }
  unicode(s: string, nul = false) {
    this.u32(s.length + (nul ? 1 : 0));
    for (const c of s) this.u16(c.charCodeAt(0));
    if (nul) this.u16(0);
    return this;
  }
  pad4() { while (this.parts.length % 4) this.u8(0); return this; }
  get length() { return this.parts.length; }
  done(): Uint8Array { return Uint8Array.from(this.parts); }
}

export function packBitsRow(row: ArrayLike<number>): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < row.length) {
    let run = 1;
    while (i + run < row.length && row[i + run] === row[i] && run < 128) run++;
    if (run >= 2) {
      out.push(257 - run, row[i]);
      i += run;
    } else {
      let n = 1;
      while (i + n < row.length && n < 128 && !(row[i + n] === row[i + n - 1] && i + n + 1 < row.length && row[i + n + 1] === row[i + n])) n++;
      out.push(n - 1, ...Array.from({ length: n }, (_, k) => row[i + k]));
      i += n;
    }
  }
  return out;
}

/** Pixel rows (8 or 16 bit big-endian samples) as raw bytes, or as counts then PackBits rows. */
export function imageData(px: ArrayLike<number>, width: number, height: number, depth: 8 | 16, rle: boolean): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < px.length; i++) {
    if (depth === 16) bytes.push((px[i] >> 8) & 255, px[i] & 255);
    else bytes.push(px[i]);
  }
  if (!rle) return bytes;
  const rowBytes = width * (depth / 8);
  const rows = Array.from({ length: height }, (_, y) => packBitsRow(bytes.slice(y * rowBytes, (y + 1) * rowBytes)));
  const o = new Out();
  for (const r of rows) o.u16(r.length);
  for (const r of rows) o.bytes(r);
  return o.parts;
}

export interface LegacySampled { kind: 'sampled'; name?: string; width: number; height: number; px: number[]; rle?: boolean; depth?: 8 | 16; spacing?: number }
export interface LegacyComputed { kind: 'computed'; spacing: number; diameter: number; roundness: number; angle: number; hardness: number }

export function writeLegacy(version: 1 | 2, brushes: (LegacySampled | LegacyComputed)[]): Uint8Array {
  const o = new Out().i16(version).i16(brushes.length);
  for (const b of brushes) {
    const body = new Out();
    if (b.kind === 'computed') {
      body.u32(0).u16(b.spacing).u16(b.diameter).u16(b.roundness).i16(b.angle).u16(b.hardness);
      o.u16(1).u32(body.length).bytes(body.parts);
    } else {
      body.u32(0).u16(b.spacing ?? 25);
      if (version === 2) body.unicode(b.name ?? 'Sampled', true);
      body.u8(0).zeros(8).i32(0).i32(0).i32(b.height).i32(b.width);
      body.i16(b.depth ?? 8).u8(b.rle ? 1 : 0).bytes(imageData(b.px, b.width, b.height, b.depth ?? 8, !!b.rle));
      o.u16(2).u32(body.length).bytes(body.parts);
    }
  }
  return o.done();
}

// Descriptors

export type V = (o: Out) => void;
const key = (o: Out, s: string) => (s.length === 4 ? o.u32(0).raw(s) : o.u32(s.length).raw(s));

export const text = (s: string): V => o => { o.raw('TEXT'); o.unicode(s, true); };
export const long = (n: number): V => o => { o.raw('long'); o.i32(n); };
export const bool = (b: boolean): V => o => { o.raw('bool'); o.u8(b ? 1 : 0); };
export const doub = (n: number): V => o => { o.raw('doub'); o.f64(n); };
export const unit = (u: string, n: number): V => o => { o.raw('UntF'); o.raw(u); o.f64(n); };
export const pct = (n: number): V => unit('#Prc', n);
export const enm = (type: string, v: string): V => o => { o.raw('enum'); key(o, type); key(o, v); };
export const list = (items: V[]): V => o => { o.raw('VlLs'); o.u32(items.length); for (const i of items) i(o); };
export function obj(classId: string, items: Record<string, V>): V {
  return o => { o.raw('Objc'); body(o, classId, items); };
}
function body(o: Out, classId: string, items: Record<string, V>) {
  o.unicode('', true);
  key(o, classId);
  const entries = Object.entries(items);
  o.u32(entries.length);
  for (const [k, v] of entries) { key(o, k); v(o); }
}
export const dyn = (control: number, jitter = 0, steps = 0): V => obj('brVr', { bVTy: long(control), fStp: long(steps), jitter: pct(jitter), 'Mnm ': pct(0) });

export function descriptorSection(presets: V[]): number[] {
  const o = new Out().u32(16);
  body(o, 'null', { Brsh: list(presets) });
  return o.parts;
}

export interface V6Sample { id: string; width: number; height: number; px: number[]; depth?: 8 | 16; rle?: boolean }
export interface V6Pattern { id: string; name: string; width: number; height: number; mode: 1 | 3; channels: number[][]; rle?: boolean }

function section(o: Out, tag: string, data: number[]) {
  o.raw('8BIM').raw(tag).u32(data.length).bytes(data).pad4();
}

export function writeV6(opts: { subversion?: 1 | 2; samples?: V6Sample[]; patterns?: V6Pattern[]; presets?: V[]; order?: ('samp' | 'patt' | 'desc')[] }): Uint8Array {
  const sub = opts.subversion ?? 2;
  const o = new Out().i16(6).i16(sub);
  const sections: Record<string, () => number[] | null> = {
    samp: () => {
      if (!opts.samples) return null;
      const s = new Out();
      for (const sm of opts.samples) {
        const e = new Out().pascal(sm.id).zeros(sub === 1 ? 10 : 264).i32(0).i32(0).i32(sm.height).i32(sm.width);
        e.i16(sm.depth ?? 8).u8(sm.rle ? 1 : 0).bytes(imageData(sm.px, sm.width, sm.height, sm.depth ?? 8, !!sm.rle));
        s.u32(e.length).bytes(e.parts).pad4();
      }
      return s.parts;
    },
    patt: () => {
      if (!opts.patterns) return null;
      const s = new Out();
      for (const p of opts.patterns) {
        const b = new Out().u32(1).u32(p.mode).i16(0).i16(0).unicode(p.name, true).pascal(p.id);
        const arr = new Out().i32(0).i32(0).i32(p.height).i32(p.width).u32(p.channels.length);
        for (const ch of p.channels) {
          const c = new Out().u32(8).i32(0).i32(0).i32(p.height).i32(p.width).u16(8).u8(p.rle ? 1 : 0).bytes(imageData(ch, p.width, p.height, 8, !!p.rle));
          arr.u32(1).u32(c.length).bytes(c.parts);
        }
        arr.u32(0).u32(0);
        b.u32(3).u32(arr.length).bytes(arr.parts);
        s.u32(b.length).bytes(b.parts).pad4();
      }
      return s.parts;
    },
    desc: () => (opts.presets ? descriptorSection(opts.presets) : null),
  };
  for (const tag of opts.order ?? ['samp', 'patt', 'desc']) {
    const data = sections[tag]();
    if (data) section(o, tag, data);
  }
  return o.done();
}
