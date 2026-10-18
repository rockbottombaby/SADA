// Flights as arcs lifted off the globe: a MapLibre custom layer (WebGL2) drawing each flight as a great-circle ribbon
// whose height grows with its length, so routes that overlap on the surface separate in the air. Hovering a bundle of
// overlapping arcs spreads them further apart and brightens the one under the pointer; a click selects it.
// Picking is done on the GPU (ids rendered to an offscreen texture and read back around the pointer).
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from 'maplibre-gl';

export interface ArcFlight { id: string; from: [number, number]; to: [number, number]; color: [number, number, number]; alpha: number }

const GLOBE_RADIUS = 6371008.8;
const TEX_W = 1024;                       // per-arc state texture: two texels per arc (lift, highlight, alpha, width) and (lateral px, 0, 0, 0)
const PICK_R = 10;                        // pixels around the pointer that count as "under" it (the hovered arc)
const LENS_R = 56;                        // the lens: arcs this close to the pointer are spread to even spacing (CSS px)
const REACH_R = 80;                       // arcs this close are pushed out of the way when the spread reaches them
const MAX_FAN = 16;                       // at most this many arcs (the nearest) take part; the spread stays within ±HALF_W px
const HALF_W = 80;
const FALLOFF_PX = 170;                   // the parting of a hovered bundle fades out this far from the pointer (CSS px)
const FLOATS = 13;                        // per vertex: posA xy, posB xy, hA, hB, side, idx, rgba, frac (0..1 along the arc)

function merc(lon: number, lat: number): [number, number] {
  const la = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180;
  return [(lon + 180) / 360, (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + la / 2))) / 360];
}
// great-circle points between two lon/lat pairs, and the central angle (radians)
function greatCircle(a: [number, number], b: [number, number], n: number): { pts: [number, number][]; omega: number } {
  const R = Math.PI / 180, [lo1, la1] = [a[0] * R, a[1] * R], [lo2, la2] = [b[0] * R, b[1] * R];
  const p1 = [Math.cos(la1) * Math.cos(lo1), Math.cos(la1) * Math.sin(lo1), Math.sin(la1)];
  const p2 = [Math.cos(la2) * Math.cos(lo2), Math.cos(la2) * Math.sin(lo2), Math.sin(la2)];
  const om = Math.acos(Math.max(-1, Math.min(1, p1[0] * p2[0] + p1[1] * p2[1] + p1[2] * p2[2])));
  if (om < 1e-6) return { pts: [a, b], omega: om };
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n, s1 = Math.sin((1 - f) * om) / Math.sin(om), s2 = Math.sin(f * om) / Math.sin(om);
    const x = s1 * p1[0] + s2 * p2[0], y = s1 * p1[1] + s2 * p2[1], z = s1 * p1[2] + s2 * p2[2];
    pts.push([Math.atan2(y, x) / R, Math.atan2(z, Math.hypot(x, y)) / R]);
  }
  return { pts, omega: om };
}

// The camera position in the space the matrix projects from: the eye is the point that lands on clip-space w = 0,
// i.e. the solution of M x = (0, 0, 1, 0), homogenised. Far away (no occlusion) when the projection is not perspective.
function cameraOf(m: Float32Array): [number, number, number] {
  // Gaussian elimination with partial pivoting on the 4x4 (column-major) system
  const A = [0, 1, 2, 3].map(r => [m[r], m[4 + r], m[8 + r], m[12 + r], r === 2 ? 1 : 0]);
  for (let c = 0; c < 4; c++) {
    let piv = c; for (let r = c + 1; r < 4; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-18) return [0, 0, 1e9];
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < 4; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k < 5; k++) A[r][k] -= f * A[c][k]; }
  }
  const x = [0, 1, 2, 3].map(r => A[r][4] / A[r][r]);
  if (Math.abs(x[3]) < 1e-12) return [0, 0, 1e9];
  return [x[0] / x[3], x[1] / x[3], x[2] / x[3]];
}
const VERT = (prelude: string, define: string) => `#version 300 es
${prelude}
${define}
in vec2 a_posA; in vec2 a_posB; in float a_hA; in float a_hB; in float a_side; in float a_idx; in vec4 a_color; in float a_frac;
uniform vec2 u_viewport; uniform float u_lift; uniform float u_pick; uniform sampler2D u_arc; uniform int u_arcW;
uniform vec2 u_pointer; uniform float u_radius;   // pointer in framebuffer pixels (y up), and the falloff radius in pixels
uniform float u_part;   // 1: arcs part around the pointer; 0: drawn where they are (the pass that decides which arcs are under it)
uniform float u_mpp;    // metres per framebuffer pixel at the map centre: the parting's rise is set in pixels, so it looks the same at every zoom
uniform float u_strength;   // 0 when zoomed out (the lens is noise at globe scale), 1 close up
uniform vec3 u_cam;         // the camera in the globe's unit-sphere space (for exact occlusion by the planet)
out vec4 v_color; out float v_side; out float v_clip; flat out float v_idx;
void main() {
  int i = int(a_idx + 0.5) * 2;
  vec4 st = texelFetch(u_arc, ivec2(i % u_arcW, i / u_arcW), 0);   // lift factor, highlight, alpha factor, width factor
  vec4 st2 = texelFetch(u_arc, ivec2((i + 1) % u_arcW, (i + 1) / u_arcW), 0);   // lateral offset in pixels (a fanned-out bundle)
  // how much this vertex takes part in the parting: 1 at the pointer, 0 beyond the falloff radius (smooth bell)
  vec4 c0 = projectTileFor3D(a_posA, a_hA * u_lift);
  vec2 hv = u_viewport * 0.5;
  float dist = length(c0.xy / c0.w * hv + hv - u_pointer);
  float f = 1.0 - smoothstep(0.0, u_radius, dist);
  f = f * f * (3.0 - 2.0 * f) * u_part * u_strength;
  f *= smoothstep(0.0, 0.14, a_frac) * (1.0 - smoothstep(0.86, 1.0, a_frac));   // tapers to nothing at both airports: no loose ends
  float hA = a_hA * u_lift + st.r * u_mpp * f, hB = a_hB * u_lift + st.r * u_mpp * f;
  vec4 cA = projectTileFor3D(a_posA, hA);
  vec4 cB = projectTileFor3D(a_posB, hB);
  vec2 sA = cA.xy / cA.w * hv, sB = cB.xy / cB.w * hv;
  vec2 d = sB - sA; float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float w = 0.7 + 0.9 * st.a + (u_pick > 0.5 ? 3.0 : 0.8);   // half width in pixels, plus an anti-aliasing margin (or a picking margin)
  gl_Position = cA;
  gl_Position.xy += nrm * (a_side * w + st2.r * f) / hv * cA.w;
#ifdef GLOBE
  // exact occlusion: the point is hidden when the line from the camera to it passes through the sphere (a lifted arc
  // stays visible past the horizon until the planet itself is in the way)
  vec3 P = projectToSphere(a_posA, a_posA) * (1.0 + hA / GLOBE_RADIUS);
  vec3 dd = P - u_cam;
  float tt = clamp(-dot(u_cam, dd) / max(dot(dd, dd), 1e-12), 0.0, 1.0);
  v_clip = u_projection_transition > 0.999 ? length(u_cam + dd * tt) - 1.0 : 1.0;   // < 0: inside the sphere, hidden
#else
  v_clip = 1.0;
#endif
  v_side = a_side; v_idx = a_idx;
  v_color = vec4(mix(a_color.rgb, vec3(1.0), st.g * 0.85), a_color.a * st.b);
}`;
const FRAG = `#version 300 es
precision highp float;
in vec4 v_color; in float v_side; in float v_clip; flat in float v_idx;
uniform float u_pick;
out vec4 fragColor;
void main() {
  if (v_clip < 0.0) discard;
  if (u_pick > 0.5) { int i = int(v_idx + 0.5) + 1; fragColor = vec4(float(i & 255) / 255.0, float((i >> 8) & 255) / 255.0, float((i >> 16) & 255) / 255.0, 1.0); return; }
  float a = v_color.a * (1.0 - smoothstep(0.55, 1.0, abs(v_side)));
  fragColor = vec4(v_color.rgb * a, a);
}`;

export class ArcLayer implements CustomLayerInterface {
  id = 'arcs';
  type = 'custom' as const;
  renderingMode = '3d' as const;
  onHover: (id: string | null) => void = () => {};
  private map: MlMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private programs = new Map<string, { prog: WebGLProgram; loc: Record<string, WebGLUniformLocation | null>; attr: Record<string, number> }>();
  private vbo: WebGLBuffer | null = null;
  private ibo: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private nIndex = 0;
  private flights: ArcFlight[] = [];
  private byId = new Map<string, number>();
  private omega: number[] = [];
  private arcPts: Float32Array[] = [];     // per arc: mercator x, y and height (m) per point, for the layout under the pointer
  private proj: { d: CustomRenderMethodInput['defaultProjectionData']; W: number; H: number } | null = null;
  private viewVersion = 0;                 // bumped when the camera moves: the screen-space cache below is rebuilt
  private screen: { v: number; lift: number; pts: (Float32Array | null)[]; box: Float32Array } = { v: -1, lift: -1, pts: [], box: new Float32Array(0) };
  // per-arc state: target and current (lift factor, highlight, alpha factor, width factor), uploaded as a float texture
  private target = new Float32Array(0);
  private cur = new Float32Array(0);
  private tex: WebGLTexture | null = null;
  private texH = 1;
  private texDirty = true;
  private lift = 0;                      // global lift, animated 0 → 1 when a new set arrives
  private liftT0 = 0;
  private selected: string | null = null;
  private pointerPos: [number, number] | null = null;
  private pickDirty = false;
  private hoveredIdx = -1;
  private bundle: number[] = [];
  private disp = new Map<number, number>();    // bundle member -> sideways displacement in px (along its own normal)
  private anchor: [number, number] | null = null;   // where the lens sits: fixed across the route while the pointer is inside the fan
  private anchorT: [number, number] = [1, 0];       // the route's direction there
  private pickFbo: WebGLFramebuffer | null = null;
  private pickTex: WebGLTexture | null = null;
  private pickW = 0;
  private pickH = 0;

  // ---------- public ----------
  setFlights(flights: ArcFlight[]) {
    this.flights = flights;
    this.byId = new Map(flights.map((f, i) => [f.id, i]));
    this.hoveredIdx = -1; this.bundle = [];
    const n = Math.max(1, flights.length);
    this.target = new Float32Array(n * 8); this.cur = new Float32Array(n * 8);
    for (let i = 0; i < n; i++) { this.target.set([0, 0, 1, 0, 0, 0, 0, 0], i * 8); this.cur.set([0, 0, 1, 0, 0, 0, 0, 0], i * 8); }
    this.texH = Math.max(1, Math.ceil(2 * n / TEX_W));
    this.applySelection();
    this.lift = 0; this.liftT0 = performance.now();
    if (this.gl) this.build(this.gl);
    this.texDirty = true;
    this.map?.triggerRepaint();
  }
  setSelected(id: string | null) { this.selected = id; this.applySelection(); this.map?.triggerRepaint(); }
  // pointer position in CSS pixels over the map (null when it left)
  pointer(p: [number, number] | null) {
    this.pointerPos = p;
    if (!p) { this.anchor = null; this.setHover(-1, []); return; }
    this.pickDirty = true;
    this.map?.triggerRepaint();
  }
  hovered(): string | null { return this.hoveredIdx >= 0 ? this.flights[this.hoveredIdx]?.id ?? null : null; }
  // a tap (touch screens, no hover): what is under this point, reported once the next frame has picked
  private tapCb: ((hovered: string | null, under: string[]) => void) | null = null;
  tap(p: [number, number], cb: (hovered: string | null, under: string[]) => void) { this.tapCb = cb; this.pointer(p); }

  // ---------- MapLibre hooks ----------
  onAdd(map: MlMap, gl: WebGL2RenderingContext) {
    this.map = map; this.gl = gl;
    map.on('move', () => { this.viewVersion++; if (this.pointerPos) { this.pickDirty = true; } });
    this.vbo = gl.createBuffer(); this.ibo = gl.createBuffer(); this.vao = gl.createVertexArray();
    this.tex = gl.createTexture();
    if (this.flights.length) this.build(gl);
  }
  onRemove(_map: MlMap, gl: WebGL2RenderingContext) {
    for (const p of this.programs.values()) gl.deleteProgram(p.prog);
    this.programs.clear();
    gl.deleteBuffer(this.vbo); gl.deleteBuffer(this.ibo); gl.deleteVertexArray(this.vao); gl.deleteTexture(this.tex);
    if (this.pickFbo) { gl.deleteFramebuffer(this.pickFbo); gl.deleteTexture(this.pickTex); }
    this.gl = null; this.map = null;
  }
  render(gl: WebGL2RenderingContext, o: CustomRenderMethodInput) {
    if (!this.nIndex || !this.vao) return;
    this.proj = { d: o.defaultProjectionData, W: gl.drawingBufferWidth, H: gl.drawingBufferHeight };
    const p = this.program(gl, o);
    if (!p) return;
    this.animate();
    this.uploadState(gl);
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const setCommon = (pick: boolean, part = true) => {
      gl.useProgram(p.prog);
      const d = o.defaultProjectionData;
      gl.uniformMatrix4fv(p.loc.u_projection_matrix, false, d.mainMatrix as Float32Array);
      if (p.loc.u_projection_tile_mercator_coords) gl.uniform4fv(p.loc.u_projection_tile_mercator_coords, d.tileMercatorCoords);
      if (p.loc.u_projection_clipping_plane) gl.uniform4fv(p.loc.u_projection_clipping_plane, d.clippingPlane);
      if (p.loc.u_projection_transition) gl.uniform1f(p.loc.u_projection_transition, d.projectionTransition);
      if (p.loc.u_projection_fallback_matrix) gl.uniformMatrix4fv(p.loc.u_projection_fallback_matrix, false, d.fallbackMatrix as Float32Array);
      gl.uniform2f(p.loc.u_viewport, W, H);
      gl.uniform1f(p.loc.u_lift, this.lift);
      gl.uniform1f(p.loc.u_pick, pick ? 1 : 0);
      gl.uniform1f(p.loc.u_part, part ? 1 : 0);
      const dpr = W / (this.map?.getCanvas().clientWidth || W);
      const centre = this.anchor ?? this.pointerPos;   // the lens is centred on its anchor, which only slides along the route
      if (centre) gl.uniform2f(p.loc.u_pointer, centre[0] * dpr, H - centre[1] * dpr); else gl.uniform2f(p.loc.u_pointer, -1e6, -1e6);
      const z = this.map!.getZoom(), st = Math.max(0, Math.min(1, (z - 2.6) / 2));
      gl.uniform1f(p.loc.u_strength, st * st * (3 - 2 * st));
      const cam = cameraOf(d.mainMatrix as Float32Array);
      gl.uniform3f(p.loc.u_cam, cam[0], cam[1], cam[2]);
      gl.uniform1f(p.loc.u_radius, FALLOFF_PX * dpr);
      const m = this.map!, mpp = 40075016.686 * Math.cos(m.getCenter().lat * Math.PI / 180) / (512 * Math.pow(2, m.getZoom())) / dpr;
      gl.uniform1f(p.loc.u_mpp, mpp);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex); gl.uniform1i(p.loc.u_arc, 0);
      gl.uniform1i(p.loc.u_arcW, TEX_W);
      gl.bindVertexArray(this.vao);
    };
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    if (this.pickDirty && this.pointerPos) { this.pickDirty = false; this.pick(gl, W, H, setCommon); }
    setCommon(false);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawElements(gl.TRIANGLES, this.nIndex, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    if (this.animating() || this.lift < 1) this.map?.triggerRepaint();
  }

  // ---------- internals ----------
  private failed = new Set<string>();
  private program(gl: WebGL2RenderingContext, o: CustomRenderMethodInput) {
    const key = o.shaderData.variantName;
    let p = this.programs.get(key);
    if (p) return p;
    if (this.failed.has(key)) return null;   // a shader that did not compile is reported once, not every frame
    this.failed.add(key);
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error('arcs shader:', gl.getShaderInfoLog(s)); return null; }
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT(o.shaderData.vertexShaderPrelude, o.shaderData.define)), fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return null;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.error('arcs program:', gl.getProgramInfoLog(prog)); return null; }
    const loc: Record<string, WebGLUniformLocation | null> = {};
    for (const u of ['u_projection_matrix', 'u_projection_tile_mercator_coords', 'u_projection_clipping_plane', 'u_projection_transition', 'u_projection_fallback_matrix', 'u_viewport', 'u_lift', 'u_pick', 'u_arc', 'u_arcW', 'u_pointer', 'u_radius', 'u_part', 'u_mpp', 'u_strength', 'u_cam']) loc[u] = gl.getUniformLocation(prog, u);
    const attr: Record<string, number> = {};
    for (const a of ['a_posA', 'a_posB', 'a_hA', 'a_hB', 'a_side', 'a_idx', 'a_color', 'a_frac']) attr[a] = gl.getAttribLocation(prog, a);
    p = { prog, loc, attr };
    this.programs.set(key, p); this.failed.delete(key);
    this.bindAttributes(gl, p.attr);
    return p;
  }
  private bindAttributes(gl: WebGL2RenderingContext, attr: Record<string, number>) {
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    const S = FLOATS * 4;
    const set = (name: string, size: number, off: number) => { const l = attr[name]; if (l < 0) return; gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, S, off * 4); };
    set('a_posA', 2, 0); set('a_posB', 2, 2); set('a_hA', 1, 4); set('a_hB', 1, 5); set('a_side', 1, 6); set('a_idx', 1, 7); set('a_color', 4, 8); set('a_frac', 1, 12);
    gl.bindVertexArray(null);
  }
  // geometry: every flight sampled along its great circle, two vertices per point (the two sides of the ribbon)
  private build(gl: WebGL2RenderingContext) {
    const verts: number[] = [], idx: number[] = [];
    this.omega = []; this.arcPts = [];
    this.flights.forEach((f, ai) => {
      const dist = greatCircle(f.from, f.to, 2).omega * GLOBE_RADIUS;
      const n = Math.max(10, Math.min(48, Math.round(dist / 110e3)));
      const { pts, omega } = greatCircle(f.from, f.to, n);
      this.omega.push(omega);
      const H = Math.max(12e3, Math.min(900e3, dist * 0.09));   // apex height: 9 % of the distance
      const m = pts.map(([lo, la]) => merc(lo, la));
      const h = (i: number) => H * Math.sin(Math.PI * i / (pts.length - 1));
      this.arcPts.push(new Float32Array(m.flatMap((q, i) => [q[0], q[1], h(i)])));
      // the antimeridian: a mercator jump between neighbours is drawn as two separate arcs would be (left as a gap)
      const base = verts.length / FLOATS;
      for (let i = 0; i < pts.length; i++) {
        const j = i < pts.length - 1 ? i + 1 : i - 1, flip = i < pts.length - 1 ? 1 : -1;
        if (Math.abs(m[j][0] - m[i][0]) > 0.5) { /* crosses the antimeridian: keep the ribbon direction from the other neighbour */ }
        for (const side of [-1, 1]) verts.push(m[i][0], m[i][1], m[j][0], m[j][1], h(i), h(j), side * flip, ai, f.color[0], f.color[1], f.color[2], f.alpha, i / (pts.length - 1));
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const v = base + i * 2;
        idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      }
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(idx), gl.STATIC_DRAW);
    this.nIndex = idx.length;
    for (const p of this.programs.values()) this.bindAttributes(gl, p.attr);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEX_W, this.texH, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.texDirty = true;
  }
  private uploadState(gl: WebGL2RenderingContext) {
    if (!this.texDirty) return;
    this.texDirty = false;
    const data = new Float32Array(TEX_W * this.texH * 4);
    data.set(this.cur.subarray(0, Math.min(this.cur.length, data.length)));
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEX_W, this.texH, gl.RGBA, gl.FLOAT, data);
  }
  private animating() { for (let i = 0; i < this.cur.length; i++) if (Math.abs(this.cur[i] - this.target[i]) > 0.002) return true; return false; }
  private animate() {
    const now = performance.now();
    if (this.lift < 1) { const t = Math.min(1, (now - this.liftT0) / 1100); this.lift = t >= 1 ? 1 : 1 - Math.pow(1 - t, 3); }   // ease-out lift-off
    let moved = false;
    for (let i = 0; i < this.cur.length; i++) {
      const d = this.target[i] - this.cur[i];
      if (Math.abs(d) > 0.002) { this.cur[i] += d * 0.14; moved = true; } else if (d) this.cur[i] = this.target[i];
    }
    if (moved) this.texDirty = true;
  }
  private applySelection() {
    const si = this.selected ? this.byId.get(this.selected) ?? -1 : -1;
    for (let i = 0; i < this.flights.length; i++) {
      const inBundle = this.bundle.includes(i), hov = i === this.hoveredIdx, sel = i === si;
      const t = this.target, k = i * 8;
      t[k] = inBundle ? 7 : 0;                                                       // a small rise near the pointer, in pixels (converted to metres per zoom)…
      t[k + 1] = hov || sel ? 1 : inBundle ? 0.4 : 0;                                // highlight (towards white)
      t[k + 2] = hov || sel || inBundle ? 1 : si >= 0 ? 0.5 : 1;                     // alpha factor (the rest fades behind a selection)
      t[k + 3] = hov || sel ? 1 : inBundle ? 0.5 : 0;                                // extra width
      t[k + 4] = inBundle ? this.disp.get(i) ?? 0 : 0;                              // …and the sideways move to its place in the lens, fading out with distance from the pointer
    }
  }
  private setHover(idx: number, bundle: number[]) {
    const hovChanged = idx !== this.hoveredIdx;
    this.hoveredIdx = idx; this.bundle = bundle;
    this.applySelection();
    if (hovChanged) this.onHover(this.hovered());
    this.map?.triggerRepaint();
  }
  // CPU twin of the shader's projectTileFor3D: mercator x, y (0..1) and height (m) to CSS pixels on the screen
  private toScreen(mx: number, my: number, h: number): [number, number] | null {
    const P = this.proj!; const d = P.d;
    const mul = (m: ArrayLike<number>, v: number[]) => [0, 1, 2, 3].map(r => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);
    const tx = d.tileMercatorCoords[0] + d.tileMercatorCoords[2] * mx, ty = d.tileMercatorCoords[1] + d.tileMercatorCoords[3] * my;
    const sx = tx * Math.PI * 2 + Math.PI, t = Math.exp(Math.PI - ty * Math.PI * 2), t2 = t * t;
    const sinY = (t2 - 1) / (t2 + 1), cosY = (2 * t) / (t2 + 1), k = 1 + h / GLOBE_RADIUS;
    let c = mul(d.mainMatrix, [Math.sin(sx) * cosY * k, sinY * k, Math.cos(sx) * cosY * k, 1]);
    if (d.projectionTransition < 0.999) { const f = mul(d.fallbackMatrix, [mx, my, h, 1]); c = c.map((v, j) => f[j] + (v - f[j]) * d.projectionTransition); }
    if (c[3] <= 0) return null;
    const dpr = P.W / (this.map?.getCanvas().clientWidth || P.W);
    return [((c[0] / c[3]) * 0.5 + 0.5) * P.W / dpr, (1 - ((c[1] / c[3]) * 0.5 + 0.5)) * P.H / dpr];
  }
  private ensureScreen() {
    const sc = this.screen;
    if (sc.v === this.viewVersion && Math.abs(sc.lift - this.lift) < 0.03 && sc.pts.length === this.arcPts.length) return;
    sc.v = this.viewVersion; sc.lift = this.lift;
    sc.pts = this.arcPts.map(a => {
      const out = new Float32Array(a.length / 3 * 2);
      for (let k = 0; k < a.length / 3; k++) { const q = this.toScreen(a[k * 3], a[k * 3 + 1], a[k * 3 + 2] * this.lift); out[k * 2] = q ? q[0] : NaN; out[k * 2 + 1] = q ? q[1] : NaN; }
      return out;
    });
    sc.box = new Float32Array(this.arcPts.length * 4);
    sc.pts.forEach((sp, i) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (let k = 0; k < sp.length; k += 2) { if (!Number.isFinite(sp[k])) continue; x0 = Math.min(x0, sp[k]); x1 = Math.max(x1, sp[k]); y0 = Math.min(y0, sp[k + 1]); y1 = Math.max(y1, sp[k + 1]); } sc.box.set([x0, y0, x1, y1], i * 4); });
  }
  // The lens. Every arc passing within LENS_R of the pointer (geometrically, in screen space) is a member and finds those within LENS_R of the pointer. Each is projected
  // with its closest point and direction there; measured along the bundle's common normal, the arcs are laid out
  // at even spacing in their natural order (no crossings), centred on the bundle's middle, and each gets the sideways
  // move that takes it to its place. A GPU id pass draws them in their new places and picks the one under the pointer.
  private pick(gl: WebGL2RenderingContext, W: number, H: number, setCommon: (pick: boolean, part?: boolean) => void) {
    if (!this.pointerPos || !this.proj) return;
    if (!this.pickFbo || this.pickW !== W || this.pickH !== H) {
      if (!this.pickFbo) { this.pickFbo = gl.createFramebuffer(); this.pickTex = gl.createTexture(); }
      gl.bindTexture(gl.TEXTURE_2D, this.pickTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTex, 0);
      this.pickW = W; this.pickH = H;
    }
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING), prevView = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const dpr = W / (this.map?.getCanvas().clientWidth || W);
    const [mx0, my0] = this.pointerPos;
    // the anchor: a new one where the pointer is, unless the pointer is still inside the current fan, in which case the
    // anchor only moves along the route (so the fan stays where the eye left it and each arc can be reached)
    if (this.anchor && this.bundle.length) {
      const dx = mx0 - this.anchor[0], dy = my0 - this.anchor[1], T = this.anchorT;
      const along = dx * T[0] + dy * T[1], across = -dx * T[1] + dy * T[0];
      if (Math.abs(across) <= HALF_W + 14 && Math.abs(along) <= REACH_R * 2) this.anchor = [this.anchor[0] + T[0] * along, this.anchor[1] + T[1] * along];
      else this.anchor = [mx0, my0];
    } else this.anchor = [mx0, my0];
    const [px0, py0] = this.anchor;
    const cx = Math.round(mx0 * dpr), cy = Math.round(H - my0 * dpr);
    // nearest distance (CSS px) per arc id within a window of radius r (CSS px); the window is sampled every `step` pixels
    const read = (part: boolean, r: number, step = 1) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
      gl.viewport(0, 0, W, H);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      setCommon(true, part);
      gl.drawElements(gl.TRIANGLES, this.nIndex, gl.UNSIGNED_INT, 0);
      const rp = Math.round(r * dpr), size = 2 * rp + 1, px = new Uint8Array(size * size * 4);
      gl.readPixels(cx - rp, cy - rp, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const near = new Map<number, number>();
      for (let y = 0; y < size; y += step) for (let x = 0; x < size; x += step) {
        const k = (y * size + x) * 4, id = px[k] | (px[k + 1] << 8) | (px[k + 2] << 16);
        if (!id) continue;
        const dd = Math.hypot(x - rp, y - rp) / dpr;
        if (dd <= r && dd < (near.get(id - 1) ?? Infinity)) near.set(id - 1, dd);
      }
      return near;
    };
    // every arc in screen space (cached per camera position): membership is geometric, so arcs drawn exactly on top of
    // each other are all found, which a pixel read could never do
    this.ensureScreen();
    type M = { i: number; p: [number, number]; t: [number, number]; d: number };
    const ms: M[] = [];
    const R2 = REACH_R * REACH_R, box = this.screen.box;
    for (let i = 0; i < this.arcPts.length; i++) {
      const sp = this.screen.pts[i]; if (!sp) continue;
      if (px0 < box[i * 4] - REACH_R || px0 > box[i * 4 + 2] + REACH_R || py0 < box[i * 4 + 1] - REACH_R || py0 > box[i * 4 + 3] + REACH_R) continue;
      // closest point on the polyline (segment-wise), and the direction there
      let bd = Infinity, bk = -1, bp: [number, number] = [0, 0];
      for (let k = 0; k + 1 < sp.length / 2; k++) {
        const ax = sp[k * 2], ay = sp[k * 2 + 1], bx = sp[k * 2 + 2], by = sp[k * 2 + 3];
        if (!Number.isFinite(ax) || !Number.isFinite(bx)) continue;
        const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy || 1;
        const u = Math.max(0, Math.min(1, ((px0 - ax) * vx + (py0 - ay) * vy) / L2));
        const qx = ax + u * vx, qy = ay + u * vy, dd = (qx - px0) ** 2 + (qy - py0) ** 2;
        if (dd < bd) { bd = dd; bk = k; bp = [qx, qy]; }
      }
      if (bk < 0 || bd > R2) continue;
      const tx = sp[bk * 2 + 2] - sp[bk * 2], ty = sp[bk * 2 + 3] - sp[bk * 2 + 1], tl = Math.hypot(tx, ty) || 1;
      ms.push({ i, p: bp, t: [tx / tl, ty / tl], d: Math.sqrt(bd) });
      if (ms.length >= 60) break;
    }
    this.disp.clear();
    let bundle: number[] = [];
    if (!ms.length) this.anchor = null;
    if (ms.length) {
      // a common direction (members aligned to the first), its normal, and each member's lateral position along it
      const ref = ms[0].t;
      let tx = 0, ty = 0;
      for (const m of ms) { const sgn = m.t[0] * ref[0] + m.t[1] * ref[1] < 0 ? -1 : 1; tx += m.t[0] * sgn; ty += m.t[1] * sgn; }
      const tl = Math.hypot(tx, ty) || 1, nc: [number, number] = [-ty / tl, tx / tl];
      this.anchorT = [tx / tl, ty / tl];
      const lat = ms.sort((a, b) => a.d - b.d).slice(0, MAX_FAN).map(m => ({ m, s: (m.p[0] - px0) * nc[0] + (m.p[1] - py0) * nc[1], want: 0 })).sort((a, b) => a.s - b.s);
      // packing from the arc nearest the pointer outwards: each keeps its place unless a neighbour's spread reaches it,
      // then it is pushed outward (never inward), so a second bundle next door moves away as a block instead of being
      // overlapped; the spacing is set by how many arcs share the inner radius
      const inner = ms.filter(m => m.d <= LENS_R).length, spacing = Math.max(9, Math.min(16, (2 * LENS_R) / Math.max(1, inner)));
      let c = 0; lat.forEach((x, r) => { if (Math.abs(x.s) < Math.abs(lat[c].s)) c = r; });
      lat.forEach(x => (x.want = x.s));
      // the arcs stacked with the nearest one (same position) fan out symmetrically around it
      const stack = lat.filter(x => Math.abs(x.s - lat[c].s) < 2), half = (stack.length - 1) / 2;
      stack.forEach((x, k) => (x.want = lat[c].s + (k - half) * spacing));
      for (let r = c + 1; r < lat.length; r++) lat[r].want = Math.max(lat[r].want, lat[r - 1].want + spacing);
      for (let r = c - 1; r >= 0; r--) lat[r].want = Math.min(lat[r].want, lat[r + 1].want - spacing);
      const mid = lat[c].s;
      for (const x of lat) x.want = Math.max(mid - HALF_W, Math.min(mid + HALF_W, x.want));   // the whole spread stays within a fixed width
      for (const x of lat) {
        const nLocal: [number, number] = [-x.m.t[1], x.m.t[0]];                       // the shader moves along each arc's own normal
        const sgn = nLocal[0] * nc[0] + nLocal[1] * nc[1] < 0 ? -1 : 1;
        this.disp.set(x.m.i, (x.want - x.s) * sgn);
      }
      bundle = lat.filter(x => Math.abs(x.want - x.s) > 0.5 || x.m.d <= LENS_R).map(x => x.m.i);
    }
    const parted = read(true, PICK_R);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(prevView[0], prevView[1], prevView[2], prevView[3]);
    // the hovered arc: where the arcs are drawn now; the previous one is kept while it is still under the pointer
    let hov = -1;
    if (parted.size) {
      if (this.hoveredIdx >= 0 && parted.has(this.hoveredIdx) && parted.get(this.hoveredIdx)! <= PICK_R * 0.7) hov = this.hoveredIdx;
      else { let bd = Infinity; for (const [i, dd] of parted) if (dd < bd) { bd = dd; hov = i; } }
    }
    this.setHover(hov, bundle);
    if (this.tapCb) {   // a tap: report what was under it (nearest first), then let go of the lens
      const cb = this.tapCb; this.tapCb = null;
      const under = [...ms].sort((a, b) => a.d - b.d).filter(m => m.d <= LENS_R).map(m => this.flights[m.i].id);
      cb(hov >= 0 ? this.flights[hov].id : null, under);
      this.pointerPos = null; this.anchor = null; this.setHover(-1, []);
    }
  }
}
