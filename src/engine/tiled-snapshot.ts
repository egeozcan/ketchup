/**
 * A layer's pixels as they are while a stroke is under way, read back from
 * the canvas a tile at a time, the first time something looks there. The
 * layer doesn't change until the stroke commits, so a tile read late holds
 * what one read at the start would have; a stroke then pays for the tiles
 * it passes over rather than for the whole document before its first dab.
 */

type ReadableContext = Pick<CanvasRenderingContext2D, 'getImageData'>;

/** Tile side in pixels; a power of two, so a pixel's tile is a shift away. */
export const SNAPSHOT_TILE_SHIFT = 9;
export const SNAPSHOT_TILE = 1 << SNAPSHOT_TILE_SHIFT;
const TILE_MASK = SNAPSHOT_TILE - 1;

/** Documents up to this many pixels are cheap to read whole, in one readback. */
export const SNAPSHOT_WHOLE_PIXELS = 1024 * 1024;

export class TiledSnapshot {
  readonly width: number;
  readonly height: number;
  private readonly _ctx: ReadableContext;
  private readonly _cols: number;
  private readonly _tiles: (Uint8ClampedArray | undefined)[];

  constructor(ctx: ReadableContext, width: number, height: number) {
    this._ctx = ctx;
    this.width = width;
    this.height = height;
    this._cols = Math.ceil(width / SNAPSHOT_TILE);
    this._tiles = new Array(this._cols * Math.ceil(height / SNAPSHOT_TILE));
  }

  /**
   * RGBA of the tile holding pixel (x, y), which must be on the document;
   * every tile is SNAPSHOT_TILE wide and high (clear past the document's
   * edge), so the pixel is at `tileIndex(x, y)` in it.
   */
  tileAt(x: number, y: number): Uint8ClampedArray {
    const tx = x >> SNAPSHOT_TILE_SHIFT;
    const ty = y >> SNAPSHOT_TILE_SHIFT;
    const slot = ty * this._cols + tx;
    let tile = this._tiles[slot];
    if (!tile) {
      tile = this._ctx.getImageData(tx << SNAPSHOT_TILE_SHIFT, ty << SNAPSHOT_TILE_SHIFT, SNAPSHOT_TILE, SNAPSHOT_TILE).data;
      this._tiles[slot] = tile;
    }
    return tile;
  }

  /** Offset of pixel (x, y)'s red byte within its tile. */
  static tileIndex(x: number, y: number): number {
    return (((y & TILE_MASK) << SNAPSHOT_TILE_SHIFT) + (x & TILE_MASK)) * 4;
  }
}
