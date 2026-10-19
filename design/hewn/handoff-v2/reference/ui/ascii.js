// SPDX-License-Identifier: Apache-2.0
// Hewn ASCII field: the pixel H as separate square pixels (gapped and barely rounded, like the
// logo), each extruded with a rounded bevel on its front and back edges, slowly turned.
// Rendered as shaded ASCII into a <pre>.
// window.hewnAscii(preEl, { cols, rows, speed }) → stop()
(function () {
  const GLYPH = ["##..#", ".#..#", ".####", ".#..#", ".#..#"];
  const C = GLYPH.length, G = 16; // samples per cell
  const P = 0.8, R = 0.08, DEPTH = 0.9, BEV = 0.2; // pixel size, XY corner radius, depth, bevel (cell units)
  const pts = [], half = C / 2, inset = (1 - P) / 2;
  for (let cy = 0; cy < C; cy++) for (let cx = 0; cx < C; cx++) {
    if (GLYPH[cy][cx] !== "#") continue;
    for (let iy = 0; iy < G; iy++) for (let ix = 0; ix < G; ix++) {
      const pu = (ix + 0.5) / G - inset, pv = (iy + 0.5) / G - inset;
      if (pu < 0 || pv < 0 || pu > P || pv > P) continue;
      const du = Math.min(pu, P - pu), dv = Math.min(pv, P - pv);
      if (du < R && dv < R && Math.hypot(R - du, R - dv) > R) continue; // square, slightly rounded corners
      const d = Math.min(du, dv);
      // outward direction of the nearest edge (image coords: x right, y down)
      let ox = du <= dv ? (pu < P / 2 ? -1 : 1) : 0, oy = dv <= du ? (pv < P / 2 ? -1 : 1) : 0;
      const ol = Math.hypot(ox, oy) || 1; ox /= ol; oy /= ol;
      const X = cx + inset + pu - half, Y = half - (cy + inset + pv);
      // quarter-round bevel: flat face in the middle, curving into the side wall at the edge
      const th = d < BEV ? Math.asin(1 - d / BEV) : 0, sn = Math.sin(th), cs = Math.cos(th);
      for (const sz of [-1, 1]) pts.push([X, Y, sz * (DEPTH / 2 - BEV + BEV * cs), ox * sn, -oy * sn, sz * cs]);
      if (d < 1 / G) for (let i = 1; i < 10; i++) pts.push([X, Y, (i / 10 - 0.5) * (DEPTH - 2 * BEV), ox, -oy, 0]);
    }
  }
  const L = (() => { const l = [-0.45, 0.55, -0.7], q = Math.hypot(...l); return l.map((c) => c / q); })();
  const CH = " .,-~:;=!*#$@";

  window.hewnAscii = function (el, { cols = 72, rows = 34, speed = 1 } = {}) {
    const dist = 9, K = (rows * 0.6 * dist) / C;
    let A = 0.5, t = 0, raf;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frame = () => {
      const out = new Array(cols * rows).fill(" "), zb = new Float32Array(cols * rows);
      const B = Math.sin(t) * 0.22;
      const cA = Math.cos(A), sA = Math.sin(A), cB = Math.cos(B), sB = Math.sin(B);
      for (const [x, y, z, nx, ny, nz] of pts) {
        const x1 = x * cA + z * sA, z1 = -x * sA + z * cA;
        const y2 = y * cB - z1 * sB, z2 = y * sB + z1 * cB;
        const nx1 = nx * cA + nz * sA, nz1 = -nx * sA + nz * cA;
        const ny2 = ny * cB - nz1 * sB, nz2 = ny * sB + nz1 * cB;
        const ooz = 1 / (z2 + dist);
        const sx = Math.floor(cols / 2 + K * ooz * x1 * 2), sy = Math.floor(rows / 2 - K * ooz * y2);
        if (sx < 0 || sx >= cols || sy < 0 || sy >= rows) continue;
        const i = sx + sy * cols;
        if (ooz > zb[i]) {
          zb[i] = ooz;
          const lum = nx1 * L[0] + ny2 * L[1] + nz2 * L[2];
          out[i] = CH[1 + Math.max(0, Math.min(11, Math.floor((lum * 0.5 + 0.5) * 11.99)))];
        }
      }
      let str = "";
      for (let r = 0; r < rows; r++) str += out.slice(r * cols, r * cols + cols).join("") + "\n";
      el.textContent = str;
      A += 0.004 * speed; t += 0.003 * speed;
      if (!reduced) raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
  };
})();
