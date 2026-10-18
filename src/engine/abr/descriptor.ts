import { AbrParseError, ABR_LIMITS } from './errors.js';
import { ByteReader } from './reader.js';

/**
 * Photoshop's Action Descriptor, the tagged tree the presets of a v6+ ABR are
 * written as: an object holds keyed values, each of a type named by a four
 * character OSType. Only what brush presets use is kept in a useful shape;
 * the rest is read to get past it.
 */
export type DescValue =
  | number
  | boolean
  | string
  | Uint8Array
  | DescUnit
  | DescEnum
  | DescObject
  | DescValue[];

/** A number with its unit ('#Prc' percent, '#Pxl' pixels, '#Ang' degrees, ...). */
export interface DescUnit {
  kind: 'unit';
  unit: string;
  value: number;
}

export interface DescEnum {
  kind: 'enum';
  enumType: string;
  value: string;
}

export interface DescObject {
  kind: 'object';
  classId: string;
  name: string;
  items: Map<string, DescValue>;
}

/** What one parse has read so far, shared down the recursion to bound the whole. */
export interface DescBudget {
  nodes: number;
}

/** A key or class id: a 32-bit length, 0 meaning four characters follow instead. */
function readId(r: ByteReader): string {
  const n = r.u32();
  if (n > ABR_LIMITS.maxStringLength) throw new AbrParseError('The file holds a name that is too long.');
  return String.fromCharCode(...r.bytes(n === 0 ? 4 : n));
}

function count(budget: DescBudget, n = 1) {
  budget.nodes += n;
  if (budget.nodes > ABR_LIMITS.maxDescriptorNodes) throw new AbrParseError('The brush settings in this file are too large.');
}

export function readDescriptorBody(r: ByteReader, depth: number, budget: DescBudget): DescObject {
  if (depth > ABR_LIMITS.maxDescriptorDepth) throw new AbrParseError('The brush settings in this file are nested too deeply.');
  const name = r.unicode(ABR_LIMITS.maxStringLength);
  const classId = readId(r);
  const items = new Map<string, DescValue>();
  const n = r.u32();
  // Each item takes at least 8 bytes, so a count the rest can't hold is a lie.
  if (n > r.remaining / 8) throw new AbrParseError('The brush settings in this file are damaged.');
  count(budget, n);
  for (let i = 0; i < n; i++) {
    const key = readId(r);
    items.set(key, readValue(r, r.fourCC(), depth, budget));
  }
  return { kind: 'object', classId, name, items };
}

export function readValue(r: ByteReader, type: string, depth: number, budget: DescBudget): DescValue {
  count(budget);
  switch (type) {
    case 'Objc':
    case 'GlbO':
      return readDescriptorBody(r, depth + 1, budget);
    case 'VlLs': {
      if (depth + 1 > ABR_LIMITS.maxDescriptorDepth) throw new AbrParseError('The brush settings in this file are nested too deeply.');
      const n = r.u32();
      if (n > r.remaining / 4) throw new AbrParseError('The brush settings in this file are damaged.');
      const list: DescValue[] = [];
      for (let i = 0; i < n; i++) list.push(readValue(r, r.fourCC(), depth + 1, budget));
      return list;
    }
    case 'doub':
      return r.f64();
    case 'UntF':
      return { kind: 'unit', unit: r.fourCC(), value: r.f64() };
    case 'TEXT':
      return r.unicode(ABR_LIMITS.maxStringLength);
    case 'enum':
      return { kind: 'enum', enumType: readId(r), value: readId(r) };
    case 'long':
      return r.i32();
    case 'comp':
      return r.i64();
    case 'bool':
      return r.u8() !== 0;
    case 'type':
    case 'GlbC':
      r.unicode(ABR_LIMITS.maxStringLength);
      return readId(r);
    case 'alis':
    case 'tdta': {
      const n = r.u32();
      return r.bytes(n);
    }
    case 'obj ':
      return readReference(r, budget);
    default:
      // Without knowing a type's size nothing after it can be found.
      throw new AbrParseError(`The brush settings use a value type this reader doesn't know ("${type.replace(/[^\x20-\x7e]/g, '?')}").`);
  }
}

/** A reference is read to get past it; its parts are kept as a list of text. */
function readReference(r: ByteReader, budget: DescBudget): DescValue {
  const n = r.u32();
  if (n > r.remaining / 4) throw new AbrParseError('The brush settings in this file are damaged.');
  const out: DescValue[] = [];
  for (let i = 0; i < n; i++) {
    const type = r.fourCC();
    count(budget);
    switch (type) {
      case 'prop':
        r.unicode(ABR_LIMITS.maxStringLength);
        readId(r);
        out.push(readId(r));
        break;
      case 'Clss':
        r.unicode(ABR_LIMITS.maxStringLength);
        out.push(readId(r));
        break;
      case 'Enmr':
        r.unicode(ABR_LIMITS.maxStringLength);
        readId(r);
        readId(r);
        out.push(readId(r));
        break;
      case 'rele':
        r.unicode(ABR_LIMITS.maxStringLength);
        readId(r);
        out.push(r.i32());
        break;
      case 'Idnt':
      case 'indx':
        out.push(r.i32());
        break;
      case 'name':
        r.unicode(ABR_LIMITS.maxStringLength);
        readId(r);
        out.push(r.unicode(ABR_LIMITS.maxStringLength));
        break;
      default:
        throw new AbrParseError('The brush settings hold a reference this reader cannot follow.');
    }
  }
  return out;
}

// Typed reads of an object's items, each undefined when absent or of another kind.

export function getObject(o: DescObject | undefined, key: string): DescObject | undefined {
  const v = o?.items.get(key);
  return v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array) && (v as DescObject).kind === 'object' ? (v as DescObject) : undefined;
}

export function getBool(o: DescObject | undefined, key: string): boolean | undefined {
  const v = o?.items.get(key);
  return typeof v === 'boolean' ? v : undefined;
}

export function getString(o: DescObject | undefined, key: string): string | undefined {
  const v = o?.items.get(key);
  return typeof v === 'string' ? v : undefined;
}

/** A number, whether written plain ('long', 'doub') or with a unit; the unit is not checked. */
export function getNumber(o: DescObject | undefined, key: string): number | undefined {
  const v = o?.items.get(key);
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (v && typeof v === 'object' && !Array.isArray(v) && (v as DescUnit).kind === 'unit') {
    const n = (v as DescUnit).value;
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function getEnum(o: DescObject | undefined, key: string): string | undefined {
  const v = o?.items.get(key);
  return v && typeof v === 'object' && !Array.isArray(v) && (v as DescEnum).kind === 'enum' ? (v as DescEnum).value : undefined;
}
