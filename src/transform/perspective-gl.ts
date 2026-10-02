import type { Point } from '../types.js';
import type { TransformRect } from './transform-types.js';
import { warpGeometry } from './transform-math.js';

/**
 * `warpPerspective` on the GPU: the same per-pixel inverse map, exact
 * coverage and premultiplied bilinear sampling as a WebGL2 fragment shader,
 * so it takes milliseconds where the CPU takes tens to thousands of them.
 * Results agree with the CPU's to within rounding. Where WebGL2 is missing,
 * software-only or lost, or the source is larger than a texture may be, the
 * callers fall back to the CPU.
 */

const VERTEX_SHADER = `#version 300 es
void main() {
  // One triangle covering the viewport.
  gl_Position = vec4(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0, 0.0, 1.0);
}`;

// A line-by-line port of warpPerspective and its helpers in transform-math.ts;
// see there for what each step is for. Everything is relative to the quad's
// first corner.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uSrc;
// The tile's top-left corner, and its height (gl_FragCoord counts from the bottom).
uniform vec2 uOrigin;
uniform float uTileH;
uniform vec2 uE, uF, uG;
uniform float uK2, uEF;
uniform bool uLinear, uConvex;
uniform vec2 uQuad[4];
uniform vec4 uLines[4];
uniform vec4 uLobes[8];
out vec4 outColor;

float meanClamped(float la, float lb) {
  float lo = min(la, lb), hi = max(la, lb);
  if (hi <= 0.0) return 0.0;
  if (lo >= 1.0) return 1.0;
  if (hi == lo) return lo;
  float a = max(lo, 0.0), b = min(hi, 1.0);
  return (max(hi - 1.0, 0.0) + (b - a) * (a + b) * 0.5) / (hi - lo);
}

float edgeArea(vec4 e, vec2 p0) {
  if (e.y == e.w) return 0.0;
  float ya = max(min(e.y, e.w), p0.y), yb = min(max(e.y, e.w), p0.y + 1.0);
  if (ya >= yb) return 0.0;
  float slope = (e.z - e.x) / (e.w - e.y);
  float la = e.x + (ya - e.y) * slope - p0.x, lb = e.x + (yb - e.y) * slope - p0.x;
  float area = (yb - ya) * meanClamped(la, lb);
  return e.w > e.y ? area : -area;
}

float pixelCoverage(vec2 p0) {
  float first = 0.0, second = 0.0;
  for (int i = 0; i < 4; i++) first += edgeArea(uLobes[i], p0);
  for (int i = 4; i < 8; i++) second += edgeArea(uLobes[i], p0);
  return min(abs(first) + abs(second), 1.0);
}

int winding(vec2 p) {
  int w = 0;
  for (int i = 0; i < 4; i++) {
    vec2 a = uQuad[i], b = uQuad[(i + 1) % 4];
    float side = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
    if (a.y <= p.y) {
      if (b.y > p.y && side > 0.0) w++;
    } else if (b.y <= p.y && side < 0.0) {
      w--;
    }
  }
  return w;
}

float nearestOnQuad(vec2 p, out vec2 nearest, out vec2 edge) {
  float best = 3.0e38;
  nearest = uQuad[0];
  edge = uQuad[1] - uQuad[0];
  for (int i = 0; i < 4; i++) {
    vec2 a = uQuad[i], q = uQuad[(i + 1) % 4] - a, w = p - a;
    float len2 = dot(q, q);
    float t = len2 > 0.0 ? clamp(dot(w, q) / len2, 0.0, 1.0) : 0.0;
    vec2 d = w - q * t;
    float d2 = dot(d, d);
    if (d2 < best) {
      best = d2;
      nearest = a + q * t;
      edge = q;
    }
  }
  return best;
}

float outsideBy(float u, float v) {
  float du = u < 0.0 ? -u : u > 1.0 ? u - 1.0 : 0.0;
  float dv = v < 0.0 ? -v : v > 1.0 ? v - 1.0 : 0.0;
  return max(du, dv);
}

// Division by zero is undefined in GLSL, so where the CPU would get an
// infinity this takes a value far outside the source instead.
const float FAR = 1.0e30;

float uAt(vec2 h, float v) {
  float dx = uE.x + uG.x * v, dy = uE.y + uG.y * v;
  if (abs(dx) > abs(dy)) return (h.x - uF.x * v) / dx;
  return dy != 0.0 ? (h.y - uF.y * v) / dy : FAR;
}

bool unmapBilinear(vec2 h, out vec2 uv) {
  uv = vec2(0.0);
  float k1 = uEF + h.x * uG.y - h.y * uG.x;
  float k0 = h.x * uE.y - h.y * uE.x;
  float u, v;
  if (uLinear) {
    if (k1 == 0.0) return false;
    v = -k0 / k1;
    u = uAt(h, v);
  } else {
    float w = sqrt(max(k1 * k1 - 4.0 * k0 * uK2, 0.0));
    float q = -0.5 * (k1 >= 0.0 ? k1 + w : k1 - w);
    // With q == 0 both roots are 0.
    v = k1 >= 0.0 ? q / uK2 : q != 0.0 ? k0 / q : 0.0;
    u = uAt(h, v);
    if (!(u >= 0.0 && u <= 1.0 && v >= 0.0 && v <= 1.0) && q != 0.0) {
      float v2 = k1 >= 0.0 ? k0 / q : q / uK2;
      float u2 = uAt(h, v2);
      if (outsideBy(u2, v2) < outsideBy(u, v)) {
        u = u2;
        v = v2;
      }
    }
  }
  uv = vec2(u, v);
  return u > -1.0 && u < 2.0 && v > -1.0 && v < 2.0;
}

void main() {
  outColor = vec4(0.0);
  vec2 c = uOrigin + vec2(gl_FragCoord.x, uTileH - gl_FragCoord.y);
  float coverage;
  bool inside = true;
  float dist = 3.0e38;
  vec2 nearest = vec2(0.0), edge = vec2(0.0);
  if (uConvex) {
    bool full = true;
    for (int i = 0; i < 4; i++) {
      float d = dot(uLines[i].xy, c) + uLines[i].z;
      if (d <= -uLines[i].w) return;
      if (d < uLines[i].w) full = false;
      if (d < 0.0) inside = false;
    }
    coverage = full ? 1.0 : pixelCoverage(c - 0.5);
  } else {
    float d2 = nearestOnQuad(c, nearest, edge);
    inside = winding(c) != 0;
    coverage = d2 < 0.5 ? pixelCoverage(c - 0.5) : inside ? 1.0 : 0.0;
    dist = sqrt(d2);
  }
  if (coverage <= 0.0) return;

  vec2 h = c;
  if (!inside || dist < 0.25) {
    if (uConvex) nearestOnQuad(c, nearest, edge);
    float len = length(edge);
    if (len > 0.0) {
      vec2 n = vec2(-edge.y, edge.x) * (0.25 / len);
      if (winding(nearest + n) != 0) h = nearest + n;
      else if (winding(nearest - n) != 0) h = nearest - n;
      else if (!inside) h = nearest;
    }
  }
  vec2 uv;
  if (!unmapBilinear(h, uv)) return;

  ivec2 size = textureSize(uSrc, 0);
  vec2 st = clamp(uv * vec2(size) - 0.5, vec2(0.0), vec2(size - 1));
  ivec2 i0 = ivec2(st);
  ivec2 i1 = min(i0 + 1, size - 1);
  vec2 t = st - vec2(i0);
  vec4 c00 = texelFetch(uSrc, i0, 0);
  vec4 c10 = texelFetch(uSrc, ivec2(i1.x, i0.y), 0);
  vec4 c01 = texelFetch(uSrc, ivec2(i0.x, i1.y), 0);
  vec4 c11 = texelFetch(uSrc, i1, 0);
  // Weighted by alpha, so the result is premultiplied, as the canvas wants it.
  float a00 = c00.a * (1.0 - t.x) * (1.0 - t.y), a10 = c10.a * t.x * (1.0 - t.y);
  float a01 = c01.a * (1.0 - t.x) * t.y, a11 = c11.a * t.x * t.y;
  outColor = vec4(c00.rgb * a00 + c10.rgb * a10 + c01.rgb * a01 + c11.rgb * a11, a00 + a10 + a01 + a11) * coverage;
}`;

const UNIFORMS = [
  'uSrc', 'uOrigin', 'uTileH', 'uE', 'uF', 'uG', 'uK2', 'uEF', 'uLinear', 'uConvex', 'uQuad', 'uLines', 'uLobes',
] as const;

/** Largest tile drawn at once, keeping each draw well clear of GPU watchdogs. */
const MAX_TILE = 2048;
/**
 * Larger sources are warped on the CPU: an upload of over a gigabyte may not
 * fail cleanly, and resetting the GPU can take the layers' canvases with it.
 */
const MAX_SOURCE_PIXELS = 8192 * 8192;

interface Gpu {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  uniforms: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
  texture: WebGLTexture;
  maxTexture: number;
  tile: number;
  /** The source now in `texture`. */
  source: ImageData | null;
}

/** undefined: not tried yet (or lost, to try again); null: unavailable. */
let gpu: Gpu | null | undefined;
/**
 * Sources that failed to upload (out of GPU memory), left to the CPU. Kept
 * across a lost context, which such an upload may itself have caused.
 */
const failed = new WeakSet<ImageData>();

/** null if there is no usable GPU; undefined if the context was lost while setting up, to try again. */
function createGpu(): Gpu | null | undefined {
  if (typeof WebGL2RenderingContext === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    // A copy is taken right after drawing, but some browsers lose the buffer
    // of a canvas outside the document otherwise.
    preserveDrawingBuffer: true,
    // A software renderer would be no faster than the CPU path.
    failIfMajorPerformanceCaveat: true,
  });
  if (!gl) return null;

  const program = gl.createProgram();
  const shaders = [[gl.VERTEX_SHADER, VERTEX_SHADER], [gl.FRAGMENT_SHADER, FRAGMENT_SHADER]] as const;
  for (const [type, source] of shaders) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (gl.isContextLost()) return undefined;
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const logs = gl.getAttachedShaders(program)?.map(s => gl.getShaderInfoLog(s)).filter(Boolean) ?? [];
    console.warn('Perspective warp shader failed; warping on the CPU.', gl.getProgramInfoLog(program), ...logs);
    return null;
  }
  // Dithering may perturb the low bits of what is written.
  gl.disable(gl.DITHER);
  gl.useProgram(program);
  const uniforms = Object.fromEntries(
    UNIFORMS.map(name => [name, gl.getUniformLocation(program, name)]),
  ) as Gpu['uniforms'];
  gl.uniform1i(uniforms.uSrc, 0);

  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // Only sampled with texelFetch, but a texture with mipmap filtering and no
  // mipmaps is incomplete and reads as black.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);

  const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
  const tile = Math.min(MAX_TILE, viewport[0], viewport[1], gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number);

  canvas.addEventListener('webglcontextlost', () => {
    // Try a new context next time; until then the CPU warps.
    if (gpu?.canvas === canvas) gpu = undefined;
  });
  return { canvas, gl, uniforms, texture, maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, tile, source: null };
}

function getGpu(): Gpu | null {
  if (gpu === undefined) {
    gpu = createGpu();
    if (gpu === undefined) return null;
  }
  if (gpu?.gl.isContextLost()) gpu = undefined;
  return gpu ?? null;
}

/** Whether warps of `src` will run on the GPU (as far as can be told before trying). */
export function canWarpOnGpu(src: ImageData): boolean {
  const g = getGpu();
  return !!g && src.width <= g.maxTexture && src.height <= g.maxTexture
    && src.width * src.height <= MAX_SOURCE_PIXELS && !failed.has(src);
}

/**
 * Draws `warpPerspective(src, dst, region)` onto `out` at (0, 0), replacing
 * what is there, on the GPU. Returns false if it can't, and then the region
 * of `out` must be drawn some other way (it may have been partly cleared).
 */
export function warpPerspectiveGpu(
  src: ImageData,
  dst: [Point, Point, Point, Point],
  region: TransformRect,
  out: CanvasRenderingContext2D,
): boolean {
  if (!canWarpOnGpu(src)) return false;
  const g = gpu!;
  const { gl, uniforms: u } = g;

  if (g.source !== src) {
    g.source = null;
    // Several errors may be pending; each call clears one.
    while (gl.getError() !== gl.NO_ERROR && !gl.isContextLost());
    // Failed until known otherwise, in case the upload loses the context.
    failed.add(src);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8, src.width, src.height, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array(src.data.buffer, src.data.byteOffset, src.data.byteLength),
    );
    if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) return false;
    failed.delete(src);
    g.source = src;
  }

  // The drawing buffer holds one tile. A browser short of memory may make it
  // smaller than the canvas, which would scale the copies out of it; then the
  // CPU warps from now on (drafting drags as it does).
  const cw = Math.min(region.w, g.tile), ch = Math.min(region.h, g.tile);
  if (g.canvas.width < cw || g.canvas.height < ch) {
    g.canvas.width = Math.max(g.canvas.width, cw);
    g.canvas.height = Math.max(g.canvas.height, ch);
  }
  if (gl.drawingBufferWidth !== g.canvas.width || gl.drawingBufferHeight !== g.canvas.height) {
    // A lost context has no drawing buffer at all; try a new one next time.
    if (gl.isContextLost()) {
      gpu = undefined;
      return false;
    }
    // Short of memory: free what this holds now rather than whenever it is collected.
    g.canvas.width = g.canvas.height = 1;
    gl.deleteTexture(g.texture);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    gpu = null;
    return false;
  }

  const geo = warpGeometry(dst);
  gl.uniform2f(u.uE, geo.ex, geo.ey);
  gl.uniform2f(u.uF, geo.fx, geo.fy);
  gl.uniform2f(u.uG, geo.gx, geo.gy);
  gl.uniform1f(u.uK2, geo.k2);
  gl.uniform1f(u.uEF, geo.ef);
  gl.uniform1i(u.uLinear, geo.linear ? 1 : 0);
  gl.uniform1i(u.uConvex, geo.convex ? 1 : 0);
  gl.uniform2fv(u.uQuad, geo.quad.flatMap(p => [p.x, p.y]));
  gl.uniform4fv(u.uLines, Float32Array.from(geo.lines));
  gl.uniform4fv(u.uLobes, Float32Array.from(geo.lobes));

  out.save();
  out.setTransform(1, 0, 0, 1, 0, 0);
  out.globalAlpha = 1;
  out.globalCompositeOperation = 'source-over';
  out.imageSmoothingEnabled = false;
  for (let ty = 0; ty < region.h; ty += g.tile) {
    for (let tx = 0; tx < region.w; tx += g.tile) {
      const tw = Math.min(g.tile, region.w - tx), th = Math.min(g.tile, region.h - ty);
      if (geo.empty) {
        out.clearRect(tx, ty, tw, th);
        continue;
      }
      gl.viewport(0, 0, tw, th);
      gl.uniform2f(u.uOrigin, region.x + tx - geo.ax, region.y + ty - geo.ay);
      gl.uniform1f(u.uTileH, th);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // The viewport is the drawing buffer's bottom-left corner.
      out.clearRect(tx, ty, tw, th);
      out.drawImage(g.canvas, 0, g.canvas.height - th, tw, th, tx, ty, tw, th);
    }
  }
  out.restore();
  // A context lost along the way drew nothing; don't let that be cached.
  return !gl.isContextLost();
}

/** Frees the GPU's copy of `src`, and the tile buffer, once no more warps of it are coming. */
export function releaseGpuSource(src: ImageData): void {
  if (!gpu || gpu.source !== src) return;
  const { gl } = gpu;
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gpu.source = null;
  gpu.canvas.width = gpu.canvas.height = 1;
}
