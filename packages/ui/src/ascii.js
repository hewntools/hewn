// SPDX-License-Identifier: Apache-2.0
// Hewn's mark, moving: the thirteen pixels of the pixel H, in polished chrome, run together into one pixel and part
// again, in one 26 s loop. A shader draws it small (WebGL 2), 2×4 samples a braille character, and a second pass
// turns each character's samples into its dots by an ordered dither and draws them: characters only, never the picture
// itself. Each dot is a small square on an even, square grid of whole device pixels, with a faint glow of the
// character's colour behind it on a dark page. It all stays on the GPU; the page only says when.
// The <pre> keeps blank braille (cols × rows), so it has the size its characters give it; the mark's canvas lies over
// it, as wide as it is tall (the mark's own square), centred.
//
// window.hewnAscii(preEl, { cols, rows, speed, fps, ink, opacity, fill, dot, focal, shade, at, still, reduced }) → stop()
//   ink: "auto" (the default: "colour" on a dark page, "tone" on a light one, judged by the <pre>'s own colour),
//        "colour" (the chrome's own colours; on a light page they wash out), "tone" (the <pre>'s colour, fainter where
//        the metal is darker) or "mono" (the <pre>'s colour, even).
//   fill: how readily a dot lights (1); more makes the mark denser. dot: a dot's side, against the space between dots
//   (0.6).
//   at: hold the loop at this point (0 to 1). still: the H standing still, as without WebGL 2. reduced: the logo seen
//   square on, as under prefers-reduced-motion.
// It paints 30 frames a second (fps), and none while the page or the <pre> is out of sight. stop() ends it and frees
// its GL context; stop.ms is what a frame has cost the page lately, in ms.
// To compare looks on a real page, its address can set these for every mark on it, over what the page asks:
// ?mark-ink=mono&mark-opacity=0.4 (also mark-fps, mark-fill, mark-dot, mark-focal, mark-shade, mark-speed, mark-at,
// mark-still, mark-reduced).
(function () {
  const GLYPH = ["##..#", ".#..#", ".####", ".#..#", ".#..#"]; // Hewn's pixel H
  const HOME = [];
  for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 5; gx++) if (GLYPH[gy][gx] === "#") HOME.push([gx - 2, 2 - gy]);
  const TAU = Math.PI * 2, T = 26, FPS = 30, CAM = 14; // the loop in seconds, frames a second, how far away the eye is
  // Where the loop rests: the logo seen square on, where the eye's yaw in pose(), 0.34·sin(2πu + 0.6), is 0.
  const REST = (Math.PI - 0.6) / TAU;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const frac = (x) => x - Math.floor(x);
  const hash = (n) => { n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d); n = Math.imul(n ^ (n >>> 12), 0x297a2d39); return ((n ^ (n >>> 15)) >>> 0) / 4294967296; };

  // ───────────────────────── where everything is, at a point u in the loop (0 to 1) ─────────────────────────
  // 0–48%: the logo. Then the thirteen pixels soften, spiral in from the outside and run together (48–61%) into one
  // pixel, the thing the whole design language is built from. It holds (61–80%), turned so you see it is a block and
  // never square on, still turning a little; then it breaks into thirteen again, and each goes home, squares off, and
  // lands with a shiver.
  const P = { blob: new Float32Array(52), half: 0.4, k: 0.02, one: 0, oneHalf: 1.5, oneTurn: 0, wob: 0, pix: 1, oneW: 0, bmin: [0, 0, 0], bmax: [0, 0, 0], yaw: 0, pitch: 0 };
  function pose(u) {
    const m = smooth(0.48, 0.61, u) - smooth(0.8, 0.94, u), w = frac(u - 0.94);
    const half = 0.4 + 0.2 * m + (w < 0.14 ? 0.035 * Math.exp(-w * 44) * Math.sin(w * 170) : 0);
    let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (let i = 0; i < 13; i++) {
      const hx = HOME[i][0], hy = HOME[i][1], rn = Math.hypot(hx, hy) / 2.83, mi = smooth(0, 1, m * 1.35 - (1 - rn) * 0.35);
      const ang = 1.5 * mi, sc = 1 - 0.86 * mi, ca = Math.cos(ang), sa = Math.sin(ang);
      const x = (hx * ca - hy * sa) * sc, y = (hx * sa + hy * ca) * sc, z = Math.sin(Math.PI * mi) * 2.2 * (hash(i * 7 + 1) - 0.5) + 0.05 * Math.sin(TAU * 4 * u + i * 1.7) * (1 - mi);
      P.blob[i * 4] = x; P.blob[i * 4 + 1] = y; P.blob[i * 4 + 2] = z; P.blob[i * 4 + 3] = 0.8 * Math.sin(Math.PI * Math.min(1, mi * 1.15)); // a drop on the way, a pixel at both ends
      lo = [Math.min(lo[0], x), Math.min(lo[1], y), Math.min(lo[2], z)]; hi = [Math.max(hi[0], x), Math.max(hi[1], y), Math.max(hi[2], z)];
    }
    P.half = half; P.k = 0.02 + 1.15 * Math.pow(m, 1.5); P.one = smooth(0.78, 1, m);
    const settle = frac(u - 0.61), calm = smooth(0.9, 1, m); // the one pixel shivers as it forms, then is still
    P.oneHalf = 1.5 + (settle < 0.14 && m > 0.5 ? 0.06 * Math.exp(-settle * 40) * Math.sin(settle * 150) : 0); P.wob = 0.32 * m * (1 - 0.86 * calm); P.pix = 1 - smooth(0, 0.3, m); P.oneW = 0.4 * smooth(0.92, 1, m);
    const pad = half + P.k * 0.35 + 1.0, R = P.one > 0 ? P.oneHalf * 1.45 + 1.0 : 0; // turned, its corners reach further
    for (let a = 0; a < 3; a++) { P.bmin[a] = Math.min(lo[a] - pad, -R); P.bmax[a] = Math.max(hi[a] + pad, R); }
    const em = m * m * (3 - 2 * m);
    P.yaw = 0.34 * Math.sin(TAU * u + 0.6); P.pitch = -0.15 + 0.06 * Math.cos(TAU * u) - 0.2 * em; // for the one pixel the eye rises, to see its top
    P.oneTurn = em * (0.52 + 0.3 * smooth(0.58, 0.82, u)); // and the pixel is turned 30° to 47° from the eye, more as it holds
  }

  // ───────────────────────── the scene, as a shader ─────────────────────────
  // Thirteen square pixels of polished metal, joined by a smooth minimum so they can run together, ray marched; lit only
  // by what they reflect: a studio of soft boxes that goes round once a loop, and each other. Nobody sees this picture:
  // it is drawn small, 2×4 samples a cell, and read back to choose the characters.
  const VS = `#version 300 es
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2. - 1., 0., 1.); }`;
  const FS = `#version 300 es
precision highp float;
uniform vec2 uView;                 // the picture, in character widths
uniform float uPh, uHalf, uK, uOne, uOneHalf, uWob, uPix, uOneW;
uniform vec4 uBlob[13];             // centre, and how far from block (0) to ball (1)
uniform vec3 uCam, uBMin, uBMax;    // yaw pitch distance; a box round everything
uniform vec2 uOneCS;                // the one pixel is turned about its upright: cos and sin of how far
uniform float uFocal;               // how tight the eye frames it
uniform float uShade;               // 0: lit from everywhere. 1: a shadow side, deep gaps, less ceiling
uniform vec2 uFbo, uTexel; uniform int uAA; out vec4 o;
const float ROUND = 0.1, BEVEL = 0.13, DOME = 0.16, GLOW = 0.75, EXPO = 0.92;
const vec3 F0 = vec3(0.6, 0.86, 0.22), GLOWCOL = vec3(0.5, 0.82, 0.2);   // chrome with a little lime in it; the haze

float gSig;                         // how much of this sample is the thing itself, not the haze behind it
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0., -s, 0., 1., 0., s, 0., c); }
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1., 0., 0., 0., c, s, 0., -s, c); }
/** How far q is from a pixel of half-width h. Pixels are square, never round, with barely rounded corners (the logo's
 *  are a tenth of the pixel's width). So: that square, pushed into depth, and only the rim round its face rounded
 *  more. ball: 0 is the pixel, 1 a drop. */
float pixelDist(vec3 q, float h, float ball) {
  float r = 2. * h * ROUND, b = 2. * h * BEVEL;
  vec2 a = abs(q.xy) - (h - r), w = vec2(length(max(a, 0.)) + min(max(a.x, a.y), 0.) - r + b, abs(q.z) - h + b);
  return mix(length(max(w, 0.)) + min(max(w.x, w.y), 0.) - b, length(q) - h, ball);
}
float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.) / k; return min(a, b) - h * h * k * 0.25; }

float map(vec3 p) {
  float d = 1e5;
  for (int i = 0; i < 13; i++) { vec4 b = uBlob[i]; d = smin(d, pixelDist(p - b.xyz, uHalf, b.w), uK); }
  if (uOne > 0.001) d = mix(d, pixelDist(vec3(uOneCS.x * p.x - uOneCS.y * p.z, p.y, uOneCS.y * p.x + uOneCS.x * p.z), uOneHalf, 0.), uOne);   // the thirteen, become one pixel
  if (uWob > 0.001) d += uWob * 0.11 * sin(p.x * 4.3 + uPh * 5. + 1.7 * sin(p.y * 3.1 + uPh * 3.)) * sin(p.y * 4.9 - uPh * 6.) * sin(p.z * 4.1 + uPh * 3.);
  return d;
}
vec3 calcN(vec3 p) { const vec2 e = vec2(0.003, -0.003); return normalize(e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) + e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx)); }
float occ(vec3 p, vec3 n) { float o = 0., s = 1.; for (int i = 1; i <= 4; i++) { float h = 0.04 + 0.12 * float(i); o += (h - map(p + n * h)) * s; s *= 0.68; } return clamp(1. - 1.5 * o, 0., 1.); }

float softbox(vec3 d, vec3 L, vec2 sz, float soft) {
  float c = dot(d, L); if (c <= 0.02) return 0.;
  vec3 U = normalize(cross(vec3(0., 1., 0.), L)), V = cross(L, U);
  vec2 q = abs(vec2(dot(d, U), dot(d, V)) / c), e = smoothstep(sz + soft, sz - soft, q);
  return e.x * e.y;
}
/** What the metal sees: a bright ceiling over a dark floor, so every domed face carries a horizon; a key and a strip
 *  that go round once a loop; a lime light from behind for the rims. */
vec3 env(vec3 d) {
  float up = smoothstep(-0.03, 0.05, d.y + 0.06 * sin(uPh) - 0.09 * uShade);   // shaded, the ceiling sits higher: a thinner bright band on each face
  vec3 c = mix(vec3(0.012, 0.03, 0.008) + vec3(0.03, 0.07, 0.015) * exp(d.y * 4.), mix(vec3(1.05, 1.03, 0.98), vec3(0.2, 0.24, 0.22), smoothstep(0., 0.85, d.y)), up);
  c += vec3(1.0, 0.99, 0.95) * softbox(d, normalize(vec3(0.0, 0.5, 1.0)), vec2(1.3, 0.3), 0.3) * 0.6;
  vec3 e = rotY(uPh) * d;
  c += vec3(1.0, 0.97, 0.9) * softbox(e, normalize(vec3(-0.55, 0.6, 0.55)), vec2(0.34, 0.2), 0.05) * 9.;
  c += vec3(0.85, 0.95, 1.0) * softbox(e, normalize(vec3(0.9, 0.12, 0.3)), vec2(0.07, 0.5), 0.07) * 5.;
  c += vec3(0.75, 1.0, 0.45) * softbox(d, normalize(vec3(0.25, 0.5, -0.83)), vec2(0.7, 0.35), 0.25) * 3.2;
  c += vec3(0.95, 1.0, 0.9) * softbox(d, normalize(vec3(-1.0, -0.1, 0.0)), vec2(0.6, 0.75), 0.45) * 1.35;   // a wall of light at the far left: only a face turned well away from you catches it, and is lighter than its neighbour
  return c;
}

vec3 shade(vec3 p, vec3 n, vec3 rd) {
  if (uPix + uOneW > 0.001) {   // a flat mirror face shows one flat tone. The shape stays square; only the normal it is lit by leans out from the pixel's middle.
    float best = 1e9; vec3 c = vec3(0.);
    for (int i = 0; i < 13; i++) { vec3 v = p - uBlob[i].xyz; float dd = dot(v, v); if (dd < best) { best = dd; c = v; } }
    n = normalize(n + DOME * (c / uHalf * uPix + p / uOneHalf * uOneW));
  }
  vec3 R = reflect(rd, n); float ndv = clamp(dot(n, -rd), 0., 1.), ao = pow(occ(p, n), 1. + 1.7 * uShade), fr = pow(1. - ndv, 5.);
  vec3 refl = env(R);
  // the shadow side: what is turned from a light up, left and in front goes dark, except where a lamp itself is mirrored
  float lit = clamp(dot(n, normalize(vec3(-0.5, 0.72, 0.48))) * 0.62 + 0.42, 0., 1.);
  float form = mix(1., mix(0.07 + 0.93 * lit * sqrt(lit), 1., smoothstep(1.6, 4., max(refl.r, max(refl.g, refl.b)))), uShade);
  { vec3 q = p + n * 0.03; float t = 0.03; for (int i = 0; i < 26; i++) { float d = map(q + R * t); if (d < 0.004) { vec3 p2 = q + R * t; refl = env(reflect(R, calcN(p2))) * F0 * 0.85; break; } t += d; if (t > 5.) break; } }
  return (refl * (F0 + (1. - F0) * fr) * (0.3 + 0.7 * ao) + F0 * (0.1 + 0.07 * ao) * (1. - 0.7 * uShade)) * form;
}

vec3 render(vec2 px) {
  vec2 uv = (px - 0.5 * uView) / min(uView.x, uView.y); uv.y = -uv.y; gSig = 0.;   // framed by the narrower side, so taller cells leave room above and below
  mat3 cam = rotY(uCam.x) * rotX(uCam.y);
  vec3 ro = cam * vec3(0., 0., uCam.z), rd = cam * normalize(vec3(uv, -uFocal));
  vec3 col = vec3(0.0095, 0.0115, 0.0105), inv = 1. / rd, a = (uBMin - ro) * inv, b = (uBMax - ro) * inv, mn = min(a, b), mx = max(a, b);
  float t0 = max(max(mn.x, mn.y), mn.z), t1 = min(min(mx.x, mx.y), mx.z), glow = 0.;
  if (t1 > max(t0, 0.)) {
    float t = max(t0, 0.); bool hit = false;
    for (int i = 0; i < 96; i++) { float d = map(ro + rd * t); glow += exp(-d * 8.) * 0.02; if (d < 0.0012 * t) { hit = true; break; } t += d * 0.9; if (t > t1) break; }
    if (hit) { vec3 p = ro + rd * t; gSig = 1.; return shade(p, calcN(p), rd) + GLOWCOL * glow * 0.2 * GLOW; }
  }
  gSig = clamp(glow * GLOW * 0.55, 0., 0.45);
  return col + GLOWCOL * glow * GLOW;
}
vec3 tone(vec3 c) { c *= EXPO; c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14); return pow(clamp(c, 0., 1.), vec3(1. / 2.2)); }

// each sample the mean of uAA×uAA rays, and with it how much of the sample is the mark itself
void main() {
  vec2 px = vec2(gl_FragCoord.x, uFbo.y - gl_FragCoord.y) * uTexel; vec3 c = vec3(0.); float sg = 0., n = float(uAA);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) { if (i >= uAA || j >= uAA) continue; c += tone(render(px + ((vec2(float(i), float(j)) + 0.5) / n - 0.5) * uTexel)); sg += gSig; }
  o = vec4(c / (n * n), sg / (n * n));
}`;

  // the second pass: from the samples, each character's dots by an ordered dither, as squares; and the glow
  const FS_DOTS = `#version 300 es
precision highp float;
uniform sampler2D uS;               // the samples, 2×4 a character, bottom row first
uniform ivec2 uGrid;                // characters across and down
uniform int uP, uSide, uInk;        // dot pitch and side, in device px; 0 "colour", 1 "tone", 2 "mono"
uniform float uH, uGain, uShade, uHalo;
uniform vec3 uColor;                // the <pre>'s colour, for "tone" and "mono"
out vec4 o;
const float TONE = 0.4;             // "tone": the darkest metal still gets this much of the ink
const int BAYER[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
void main() {
  ivec2 px = ivec2(int(gl_FragCoord.x), int(uH - gl_FragCoord.y)), d = px / uP, c = d / ivec2(2, 4);
  o = vec4(0.);
  if (c.x >= uGrid.x || c.y >= uGrid.y) return;
  float peak = 0., ws = 0., sig = 0., Ld = 0.; vec3 w = vec3(0.), a = vec3(0.);
  for (int j = 0; j < 4; j++) for (int k = 0; k < 2; k++) {
    ivec2 s = c * ivec2(2, 4) + ivec2(k, j);
    vec4 t = texelFetch(uS, ivec2(s.x, uGrid.y * 4 - 1 - s.y), 0);
    float L = dot(t.rgb, vec3(0.2126, 0.7152, 0.0722)) * min(1., t.a * 1.5);
    peak = max(peak, L); w += t.rgb * L; ws += L; a += t.rgb; sig += t.a;
    if (s == d) Ld = L;
  }
  float g = uInk == 0 ? uHalo * min(1., sig / 8. * 255. / 60.) : 0.;   // as faint as the haze the mark leaves there
  ivec2 r = px - d * uP; int inset = (uP - uSide) / 2;
  if (peak < 0.06 || any(lessThan(r, ivec2(inset))) || any(greaterThanEqual(r, ivec2(inset + uSide)))
      || Ld * uGain <= (float(BAYER[(d.y & 3) * 4 + (d.x & 3)]) + 0.5) / 16.) { o = vec4(a / 8. * g, g); return; }
  float top = mix(245. / 255., clamp(0.26 + 0.82 * pow(peak, 0.8), 0.26, 0.97), min(1., uShade));
  if (uInk == 0) { vec3 m = w / ws; o = vec4(m * (top / max(max(m.r, m.g), max(m.b, 1. / 255.))), 1.); }
  else { float al = uInk == 1 ? min(1., TONE + (1. - TONE) * top) : 1.; o = vec4(uColor * al, al); }
}`;

  // ───────────────────────── GL: each mark its own context, on its own canvas ─────────────────────────
  /** The mark's GL: a context on a canvas of its own, both passes' programs, and a texture for the samples. null when
   *  the browser has no WebGL 2, or draws it in software (a 64×40 mark costs 11 ms a frame there, where a GPU takes 1:
   *  such a browser gets the H standing still). */
  function makeGL() {
    const cv = document.createElement("canvas");
    const gl = cv.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power", failIfMajorPerformanceCaveat: true });
    if (!gl) return null;
    let renderer = gl.getParameter(gl.RENDERER);
    if (/^webkit webgl$/i.test(renderer)) { const x = gl.getExtension("WEBGL_debug_renderer_info"); if (x) renderer = gl.getParameter(x.UNMASKED_RENDERER_WEBGL); }
    if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer)) { const x = gl.getExtension("WEBGL_lose_context"); if (x) x.loseContext(); return null; }
    const program = (fs) => {
      const p = gl.createProgram(), loc = {};
      for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]]) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); gl.attachShader(p, s); }
      gl.linkProgram(p); // where the browser can, this goes on in the background: see linked()
      return { p, u: (n) => (n in loc ? loc[n] : (loc[n] = gl.getUniformLocation(p, n))) };
    };
    const g = { cv, gl, scene: program(FS), dots: program(FS_DOTS), tex: gl.createTexture(), fbo: gl.createFramebuffer(), fw: 0, fh: 0, state: 0, lost: false, par: gl.getExtension("KHR_parallel_shader_compile") };
    gl.bindTexture(gl.TEXTURE_2D, g.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    cv.addEventListener("webglcontextlost", () => { g.lost = true; });
    return g;
  }
  /** 1 once both programs are ready, 0 while they still compile, -1 if they can't be used. */
  function linked(g) {
    if (g.lost) return -1;
    if (g.state) return g.state;
    const gl = g.gl, progs = [g.scene.p, g.dots.p];
    if (g.par && progs.some((p) => !gl.getProgramParameter(p, g.par.COMPLETION_STATUS_KHR))) return 0;
    g.state = progs.every((p) => gl.getProgramParameter(p, gl.LINK_STATUS)) ? 1 : -1;
    if (g.state < 0) console.warn("hewnAscii: the mark's shaders didn't build here, so it stands still.", progs.map((p) => gl.getProgramInfoLog(p)).join(" "));
    return g.state;
  }
  /** How a size is drawn, from how many characters the mark spans: the fewer the dots, the more rays each gets, the
   *  readier it is to light (but not so ready that the block's faces look alike), the less shadow (a small mark can't
   *  spare the dots) and the less glow behind it. */
  function sizing(m) {
    const R = Math.min(m.cols, m.rows * 2) / 2;
    return { aa: R <= 12 ? 4 : R <= 24 ? 3 : 2, gain: 1.3 + 0.35 * (1 - smooth(8, 30, R)), sh: 0.4 + 0.6 * smooth(8, 30, R), halo: 0.22 * smooth(6, 28, R) };
  }
  /** The loop at u, drawn: the scene into the samples (2×4 a character), then the dots onto the canvas. */
  function render(g, m, u) {
    const gl = g.gl, S = g.scene.u, D = g.dots.u, z = sizing(m), fw = m.cols * 2, fh = m.rows * 4;
    if (fw !== g.fw || fh !== g.fh) {
      g.fw = fw; g.fh = fh;
      gl.bindTexture(gl.TEXTURE_2D, g.tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, fw, fh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, g.fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, g.tex, 0);
    }
    pose(u);
    gl.bindFramebuffer(gl.FRAMEBUFFER, g.fbo); gl.viewport(0, 0, fw, fh); gl.useProgram(g.scene.p);
    gl.uniform1f(S("uPh"), TAU * u); gl.uniform1f(S("uFocal"), m.focal); gl.uniform1f(S("uShade"), m.shade * z.sh);
    gl.uniform1f(S("uHalf"), P.half); gl.uniform1f(S("uK"), P.k); gl.uniform1f(S("uOne"), P.one); gl.uniform1f(S("uOneHalf"), P.oneHalf); gl.uniform1f(S("uWob"), P.wob);
    gl.uniform1f(S("uPix"), P.pix); gl.uniform1f(S("uOneW"), P.oneW); gl.uniform4fv(S("uBlob[0]"), P.blob); gl.uniform3f(S("uCam"), P.yaw, P.pitch, CAM);
    gl.uniform3fv(S("uBMin"), P.bmin); gl.uniform3fv(S("uBMax"), P.bmax); gl.uniform2f(S("uOneCS"), Math.cos(P.yaw + P.oneTurn), Math.sin(P.yaw + P.oneTurn));
    gl.uniform2f(S("uView"), m.cols, m.rows * 2); gl.uniform2f(S("uTexel"), 0.5, 0.5); gl.uniform2f(S("uFbo"), fw, fh); gl.uniform1i(S("uAA"), z.aa);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const ink = m.ink === "auto" ? (light(m.color) ? 0 : 1) : { colour: 0, tone: 1, mono: 2 }[m.ink] ?? 1, c = rgb(m.color);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, m.W, m.H); gl.useProgram(g.dots.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, g.tex); gl.uniform1i(D("uS"), 0);
    gl.uniform2i(D("uGrid"), m.cols, m.rows); gl.uniform1i(D("uP"), m.p); gl.uniform1i(D("uSide"), m.side); gl.uniform1i(D("uInk"), ink);
    gl.uniform1f(D("uH"), m.H); gl.uniform1f(D("uGain"), z.gain * m.fill); gl.uniform1f(D("uShade"), m.shade * z.sh * 1.25); gl.uniform1f(D("uHalo"), z.halo);
    gl.uniform3f(D("uColor"), c[0] / 255, c[1] / 255, c[2] / 255);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ───────────────────────── without WebGL 2: the H standing still ─────────────────────────
  const BIT = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80]; // a cell's dots, row by row, as braille numbers them
  /** The H standing still, seen square on, for a browser without WebGL 2: a dot is on where most of it lies on a pixel.
   *  Drawn once, in the <pre>'s colour, as the same squares on the same grid. */
  function standStill(m) {
    const { cols, rows } = m, vw = cols, vh = rows * 2, s = (CAM - 0.4) / m.focal / Math.min(vw, vh); // picture units to the pixels' faces
    const onPixel = (x, y) => HOME.some(([hx, hy]) => { const dx = Math.abs(x - hx) - 0.32, dy = Math.abs(y - hy) - 0.32; return dx <= 0.08 && dy <= 0.08 && (dx <= 0 || dy <= 0 || Math.hypot(dx, dy) <= 0.08); });
    const g = m.cv.getContext("2d"), { p, side } = m, inset = (p - side) >> 1;
    g.clearRect(0, 0, m.W, m.H); g.fillStyle = m.color;
    for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) for (let q = 0; q < 8; q++) {
      let n = 0;
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) if (onPixel((cx + ((q & 1) + (a + 0.5) / 3) / 2 - vw / 2) * s, (vh / 2 - (cy + ((q >> 1) + (b + 0.5) / 3) / 4) * 2) * s)) n++;
      if (n >= 5) g.fillRect((cx * 2 + (q & 1)) * p + inset, (cy * 4 + (q >> 1)) * p + inset, side, side);
    }
  }

  // ───────────────────────── the page ─────────────────────────
  /** A CSS colour as [r, g, b] 0–255: a canvas reads any colour CSS can write. */
  const rgbCache = new Map();
  let swatch;
  function rgb(css) {
    if (!rgbCache.has(css)) {
      swatch = swatch || document.createElement("canvas").getContext("2d", { willReadFrequently: true });
      swatch.clearRect(0, 0, 1, 1); swatch.fillStyle = "#000"; swatch.fillStyle = css; swatch.fillRect(0, 0, 1, 1);
      rgbCache.set(css, [...swatch.getImageData(0, 0, 1, 1).data.slice(0, 3)]);
    }
    return rgbCache.get(css);
  }
  /** Whether the <pre>'s colour is light, so the page behind it is dark. */
  const light = (css) => { const [r, g, b] = rgb(css); return 0.2126 * r + 0.7152 * g + 0.0722 * b > 128; };
  /** The size of a character cell, as this <pre> sets braille, in CSS px; null while it isn't laid out. */
  function measure(el) {
    if (!el.isConnected) return null;
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;left:0;top:0;display:inline-block;visibility:hidden;white-space:pre";
    probe.textContent = Array(10).fill("⣿".repeat(10)).join("\n");
    el.append(probe);
    const r = probe.getBoundingClientRect();
    probe.remove();
    return r.width > 0 && r.height > 0 ? { cw: r.width / 10, ch: r.height / 10 } : null;
  }
  /** The dots' grid: a square pitch of whole device pixels, about two dots to a character's width; as many characters
   *  as fill the box the <pre>'s characters make, but no wider than tall (the mark is framed by the narrower side, so
   *  past that there's only haze), centred in it. */
  function regrid(m) {
    const dpr = Math.min(2, window.devicePixelRatio || 1), BW = m.tcols * m.cw * dpr, BH = m.trows * m.ch * dpr;
    const p = Math.max(2, Math.round((m.cw * dpr) / 2)), fitC = Math.max(1, Math.floor(BW / (2 * p))), fitR = Math.max(1, Math.floor(BH / (4 * p)));
    const cols = Math.min(fitC, fitR * 2), rows = Math.min(fitR, Math.ceil(fitC / 2)), W = cols * 2 * p, H = rows * 4 * p;
    Object.assign(m, { dpr, p, side: Math.max(1, Math.round(m.dot * p)), cols, rows, W, H, gridded: true });
    const { cv } = m, cs = getComputedStyle(m.el);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    cv.style.width = `${W / dpr}px`; cv.style.height = `${H / dpr}px`;
    cv.style.left = `calc(${cs.paddingLeft} + ${(BW - W) / 2 / dpr}px)`; cv.style.top = `calc(${cs.paddingTop} + ${(BH - H) / 2 / dpr}px)`;
  }

  // To compare looks on a real page: ?mark-ink=mono&mark-opacity=0.4 and so on, over what the page asks.
  const KNOBS = {};
  try {
    const q = new URLSearchParams(location.search);
    for (const k of ["fps", "fill", "dot", "focal", "shade", "speed", "opacity", "at"]) { const v = q.get("mark-" + k); if (v && isFinite(+v)) KNOBS[k] = +v; }
    const ink = q.get("mark-ink");
    if (ink === "auto" || ink === "colour" || ink === "tone" || ink === "mono") KNOBS.ink = ink;
    for (const k of ["still", "reduced"]) if (q.has("mark-" + k)) KNOBS[k] = q.get("mark-" + k) !== "0";
  } catch {}

  window.hewnAscii = function (el, opts = {}) {
    const o = { ...opts, ...KNOBS }, cols = o.cols || 72, rows = o.rows || 34, speed = o.speed ?? 1, fps = Math.min(120, o.fps || FPS);
    // the text's characters (tcols × trows) give the box; the dots' grid (cols × rows of 2×4 square dots) is set once it's measured
    const m = { el, tcols: cols, trows: rows, cols: 0, rows: 0, ink: o.ink || "auto", fill: o.fill || 1, dot: o.dot || 0.6, focal: o.focal || 2.05, shade: o.shade ?? 0.75,
      cw: 0, ch: 0, measured: false, gridded: false, dpr: 1, p: 0, side: 0, W: 0, H: 0, color: "", cv: null };
    const reduced = o.reduced ?? matchMedia("(prefers-reduced-motion: reduce)").matches;
    let mode = o.still ? "still" : "live", g = null, u = o.at != null ? frac(o.at) : REST, last = 0, raf = 0, want = true, seen = true, stopped = false;
    el.setAttribute("aria-hidden", "true"); // braille would be read out dot by dot
    if (o.opacity != null) el.style.opacity = String(o.opacity);
    // blank braille: the <pre> keeps the size its characters give it, and the canvas lies over them
    el.textContent = Array(rows).fill("⠀".repeat(cols)).join("\n");
    /** The canvas to draw on: the GL one while it moves, a 2D one for the H standing still. */
    const useCanvas = (cv) => {
      if (m.cv) m.cv.remove();
      m.cv = cv; cv.style.cssText = "position:absolute;pointer-events:none"; el.append(cv); m.gridded = false;
    };
    if (mode === "live" && !(g = makeGL())) mode = "still";
    useCanvas(g ? g.cv : document.createElement("canvas"));

    /** Draws the frame at u if one is wanted; false while the shaders still compile. */
    function step() {
      if (!m.measured) {
        const c = measure(el);
        if (c) { if (getComputedStyle(el).position === "static") el.style.position = "relative"; m.cw = c.cw; m.ch = c.ch; m.measured = true; m.gridded = false; }
      }
      if (m.measured && (!m.gridded || Math.min(2, window.devicePixelRatio || 1) !== m.dpr)) regrid(m);
      if (!m.gridded || !want) return true; // not laid out yet, or nothing new to draw
      if (mode === "live") {
        const s = linked(g);
        if (s === 0) return false;
        if (s > 0) { const t = performance.now(); m.color = getComputedStyle(el).color; render(g, m, u); want = false; cost(performance.now() - t); return true; }
        mode = "still"; g = null; useCanvas(document.createElement("canvas")); regrid(m);
      }
      const t = performance.now(); m.color = getComputedStyle(el).color; standStill(m); want = false; cost(performance.now() - t);
      return true;
    }
    /** What a frame took on the page's thread, kept as a running mean. */
    const cost = (ms) => { stop.ms = stop.ms ? stop.ms + (ms - stop.ms) * 0.2 : ms; };
    const moving = () => mode === "live" && !reduced && o.at == null && speed !== 0;
    const shown = () => seen && document.visibilityState !== "hidden";
    const busy = () => want || moving();
    const pause = () => { cancelAnimationFrame(raf); raf = 0; last = 0; }; // the loop picks up where it was
    const kick = () => { if (!raf && !stopped && shown() && busy()) raf = requestAnimationFrame(tick); };
    function tick(now) {
      raf = 0;
      if (stopped || !shown()) return pause();
      if (moving() && (!last || now - last >= 1000 / fps - 4)) {
        if (last) u = frac(u + (Math.min(250, now - last) / 1000) * (speed / T));
        last = now; want = true;
      }
      if (!step()) last = 0; // while the shaders compile, the loop waits at its start
      if (busy()) raf = requestAnimationFrame(tick);
    }
    const onVisibility = () => (document.visibilityState === "hidden" ? pause() : kick());
    document.addEventListener("visibilitychange", onVisibility);
    const io = typeof IntersectionObserver === "function" ? new IntersectionObserver((es) => { seen = es[es.length - 1].isIntersecting; if (seen) kick(); else pause(); }) : null;
    if (io) { seen = false; io.observe(el); }
    // a font that loads late, or a new font size, changes the box: measure again (a hair's change is no change)
    let box = [0, 0];
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver((es) => {
      const r = es[es.length - 1].contentRect;
      if (Math.abs(r.width - box[0]) < 1 && Math.abs(r.height - box[1]) < 1) return;
      box = [r.width, r.height]; m.measured = false; want = true; kick();
    }) : null;
    if (ro) ro.observe(el);
    // the colours follow a theme switch, from the system or from the page's own data-theme
    const dark = matchMedia("(prefers-color-scheme: dark)"), retheme = () => { want = true; kick(); };
    const mo = typeof MutationObserver === "function" ? new MutationObserver(retheme) : null;
    dark.addEventListener("change", retheme);
    if (mo) mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    function stop() {
      stopped = true; pause();
      if (io) io.disconnect();
      if (ro) ro.disconnect();
      if (mo) mo.disconnect();
      dark.removeEventListener("change", retheme);
      document.removeEventListener("visibilitychange", onVisibility);
      if (g && !g.lost) { const x = g.gl.getExtension("WEBGL_lose_context"); if (x) x.loseContext(); }
      if (m.cv) m.cv.remove();
    }
    stop.ms = 0;
    kick();
    return stop;
  };
})();
