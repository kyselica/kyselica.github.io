// Landmark art: the looks and the extra geometry of Ohio State's recognisable buildings.
//
// A building is a landmark when campus.json gives it `lm`, a key into data.landmarks (built from
// data-src/landmarks.json by tools/build-data.mjs). render.js calls these hooks with `api`, its toolkit (see the
// "LANDMARK API" block in makeRenderer). Everything here must be deterministic and drawn the same at the same cam.lod in
// tiles and in app.occlude's redraws, like the rest of render.js.
//
// A landmark's spec (data-src/landmarks.json) may carry, besides match / set / setId:
//   look            style overrides (render.js styleOf fields: facade, wall, trim, roof, roofKind, glass, fh, spacing…)
//   lookPitched     … for its parts that have a pitched roof;  lookId { id: {…} } … for one record
//   roofs   [{ x, y, ang, L, W, rh, shape: hipped|gabled|pyramidal|vault|dome|mansard, color, z?, ov?, on?, dormers? }]
//           a roof over a rectangle (ground metres, centre x/y, `ang` the direction of L), standing on the building's
//           roof (or at z). Several roofs over the wings of one footprint read as one hipped roof.
//   orn     [{ type: tower|box|scaffold|turret|ring|flagpole, … , on? }]  ornaments (see buildOrn)
//   walls   [{ type: band|piers|zone|shingle|grid, … , on? }]  paint on the building's own walls (see wallDeco)
// `on` (an OSM id or a list of them) says which record of the landmark draws it; by default the one that isn't a part.
// Ornaments that rise above the building must be covered by its "top" (set/setId) so tiles don't clip them.

const LU = -0.85, LV = -0.52;   // toward the light, in the camera's (u, v) frame (as render.js)
const TAU = Math.PI * 2;
const lightOf = (nu, nd) => Math.max(0, -(nu * LU + nd * LV));

// per-renderer caches (a worker has one renderer, the main thread one more)
const states = new WeakMap();
function stateOf(api) {
  let s = states.get(api);
  if (!s) { s = { items: new Map(), walls: new Map(), shades: new Map(), mixes: new Map(), hulls: new Map() }; states.set(api, s); }
  return s;
}
const specOf = (api, key) => { const L = api.data.landmarks; return L && key != null && Object.prototype.hasOwnProperty.call(L, key) ? L[key] : null; };
function shd(api, col, f) {
  const s = stateOf(api), q = Math.round(f * 50), key = col + q;
  let v = s.shades.get(key);
  if (v === undefined) { v = api.shade(col, q / 50); s.shades.set(key, v); }
  return v;
}
function mixd(api, a, b, t) {
  const s = stateOf(api), q = Math.round(t * 20), key = a + b + q;
  let v = s.mixes.get(key);
  if (v === undefined) { v = api.mix(a, b, q / 20); s.mixes.set(key, v); }
  return v;
}
// does record b draw this item?
function owns(o, b) {
  if (o.on == null) return !b.part;
  return Array.isArray(o.on) ? o.on.includes(b.id) : o.on === b.id;
}

/** Style overrides merged into render.js styleOf(i) for landmark building b (or null). */
export function look(api, b, st) {
  const spec = specOf(api, b.lm);
  if (!spec) return null;
  let o = null;
  if (spec.look) o = Object.assign({}, spec.look);
  if (spec.lookPitched && b.roof && b.roof !== "flat" && b.obb) o = Object.assign(o || {}, spec.lookPitched);
  if (spec.lookId && spec.lookId[b.id]) o = Object.assign(o || {}, spec.lookId[b.id]);
  return o;
}

/** Draw the whole building yourself; return true to skip the standard building. */
export function draw(api, ctx, r, cam, i, style) { return false; }

// ------------------------------------------------------------------------------------------------ geometry
// An item is one piece of extra geometry: faces (screen metres) with their colours, details for close views, a depth
// for painter's order, and a hull for blots and silhouettes.
function newItem(depth) { return { depth, faces: [], details: [], glow: [], pts: [] }; }
function addFace(it, pts, col, kind, minK = 0) {
  it.faces.push({ pts, col, kind, minK });
  for (let q = 0; q < pts.length; q += 2) it.pts.push([pts[q], pts[q + 1]]);
}
function projector(api, r) {
  const R = api.geo.ROTS[r], S = api.S, C = api.C;
  return {
    R, S, C,
    P: (x, y, z) => [x * R.R[0] + y * R.R[1], -((x * R.D[0] + y * R.D[1]) * S + z * C)],
    depth: (x, y) => x * R.D[0] + y * R.D[1],
    // a vertical face with outward normal (nx, ny): facing the camera?, its shade factor
    wallVis: (nx, ny) => nx * R.D[0] + ny * R.D[1] < -0.001,
    wallF: (nx, ny) => 0.7 + 0.36 * lightOf(nx * R.R[0] + ny * R.R[1], nx * R.D[0] + ny * R.D[1]),
    // a sloped face with unit normal (nx, ny, nz)
    roofVis: (nx, ny, nz) => (nx * R.D[0] + ny * R.D[1]) * C - nz * S < -0.0005,
    roofF: (nx, ny) => 0.78 + 0.42 * lightOf(nx * R.R[0] + ny * R.R[1], nx * R.D[0] + ny * R.D[1]),
  };
}
const flat = (arr) => { const out = new Float64Array(arr.length * 2); for (let q = 0; q < arr.length; q++) { out[2 * q] = arr[q][0]; out[2 * q + 1] = arr[q][1]; } return out; };

// vertical walls of a prism over a ground polygon (CCW [x, y]…), from z0 to z1, the faces seen; then its top
function prismFaces(api, pr, it, ring, z0, z1, wall, top, kind = "wall") {
  const n = ring.length, faces = [];
  for (let a = 0; a < n; a++) {
    const p = ring[a], q = ring[(a + 1) % n];
    const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy);
    if (L < 1e-6) continue;
    const nx = dy / L, ny = -dx / L;
    if (!pr.wallVis(nx, ny)) continue;
    faces.push({ d: pr.depth((p[0] + q[0]) / 2, (p[1] + q[1]) / 2), pts: flat([pr.P(p[0], p[1], z0), pr.P(q[0], q[1], z0), pr.P(q[0], q[1], z1), pr.P(p[0], p[1], z1)]), col: shd(api, wall, pr.wallF(nx, ny)), p, q, nx, ny });
  }
  faces.sort((A, B) => B.d - A.d);
  for (const f of faces) addFace(it, f.pts, f.col, kind);
  if (top) addFace(it, flat(ring.map((p) => pr.P(p[0], p[1], z1))), top, "top");
  return faces;
}
const circle = (cx, cy, rad, n, a0 = 0) => { const out = []; for (let j = 0; j < n; j++) { const a = a0 + (j / n) * TAU; out.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]); } return out; };
const rect = (cx, cy, ang, L, W) => {
  const ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux, hl = L / 2, hw = W / 2;
  return [[cx - ux * hl - vx * hw, cy - uy * hl - vy * hw], [cx + ux * hl - vx * hw, cy + uy * hl - vy * hw], [cx + ux * hl + vx * hw, cy + uy * hl + vy * hw], [cx - ux * hl + vx * hw, cy - uy * hl + vy * hw]];
};
// a pyramid / cone: base polygon (CCW) at z to an apex
function pyramidFaces(api, pr, it, ring, z, ax, ay, az, col, snowable = true) {
  const n = ring.length, faces = [];
  for (let a = 0; a < n; a++) {
    const p = ring[a], q = ring[(a + 1) % n];
    const ex = q[0] - p[0], ey = q[1] - p[1], vx = ax - p[0], vy = ay - p[1], vz = az - z;
    let nx = ey * vz, ny = -ex * vz, nz = ex * vy - ey * vx;
    const m = Math.hypot(nx, ny, nz) || 1; nx /= m; ny /= m; nz /= m;
    if (!pr.roofVis(nx, ny, nz)) continue;
    faces.push({ d: pr.depth((p[0] + q[0] + ax) / 3, (p[1] + q[1] + ay) / 3), pts: flat([pr.P(p[0], p[1], z), pr.P(q[0], q[1], z), pr.P(ax, ay, az)]), col: shd(api, col, pr.roofF(nx, ny)) });
  }
  faces.sort((A, B) => B.d - A.d);
  for (const f of faces) addFace(it, f.pts, f.col, snowable ? "roof" : "wall");
}
// a dome (half ellipsoid) of radius rad and height h over (cx, cy) at z
function domeFaces(api, pr, it, cx, cy, z, rad, h, col, n = 16, bands = 4) {
  const ring = (k) => { const ph = (k / bands) * (Math.PI / 2); return [Math.cos(ph) * rad, z + Math.sin(ph) * h]; };
  const faces = [];
  for (let k = 0; k < bands; k++) {
    const [r0, z0] = ring(k), [r1, z1] = ring(k + 1);
    const phm = ((k + 0.5) / bands) * (Math.PI / 2);
    for (let j = 0; j < n; j++) {
      const a0 = (j / n) * TAU, a1 = ((j + 1) / n) * TAU, am = (a0 + a1) / 2;
      let nx = (Math.cos(phm) * Math.cos(am)) / rad, ny = (Math.cos(phm) * Math.sin(am)) / rad, nz = Math.sin(phm) / h;
      const m = Math.hypot(nx, ny, nz); nx /= m; ny /= m; nz /= m;
      if (!pr.roofVis(nx, ny, nz)) continue;
      const pts = k === bands - 1
        ? [pr.P(cx + Math.cos(a0) * r0, cy + Math.sin(a0) * r0, z0), pr.P(cx + Math.cos(a1) * r0, cy + Math.sin(a1) * r0, z0), pr.P(cx, cy, z + h)]
        : [pr.P(cx + Math.cos(a0) * r0, cy + Math.sin(a0) * r0, z0), pr.P(cx + Math.cos(a1) * r0, cy + Math.sin(a1) * r0, z0), pr.P(cx + Math.cos(a1) * r1, cy + Math.sin(a1) * r1, z1), pr.P(cx + Math.cos(a0) * r1, cy + Math.sin(a0) * r1, z1)];
      faces.push({ d: pr.depth(cx + Math.cos(am) * r0, cy + Math.sin(am) * r0) - k * 0.001, pts: flat(pts), col: shd(api, col, pr.roofF(nx, ny)) });
    }
  }
  faces.sort((A, B) => B.d - A.d);
  for (const f of faces) addFace(it, f.pts, f.col, "roof");
}
// a roof over a rectangle: hipped, gabled, pyramidal, mansard (steep lower slopes to a low hip), vault (a barrel), dome
function roofItem(api, pr, b, o, r, wallCol) {
  const z = o.z != null ? o.z : b.h;
  const ang = o.ang || 0, lx = Math.cos(ang), ly = Math.sin(ang), wx = -ly, wy = lx;
  const ov = o.ov != null ? o.ov : 0.4;
  const L = o.L, W = o.W, rh = o.rh, col = o.color;
  const it = newItem(pr.depth(o.x, o.y));
  const G = (along, across) => [o.x + lx * along + wx * across, o.y + ly * along + wy * across];
  const P = (along, across, zz) => { const g = G(along, across); return pr.P(g[0], g[1], zz); };
  const shape = o.shape || "hipped";
  if (shape === "dome") { domeFaces(api, pr, it, o.x, o.y, z, Math.min(L, W) / 2, rh, col); return it; }
  if (shape === "vault") {
    // a barrel along L: strips across W, then the arched ends (walls)
    const M = 10, hw = W / 2 + ov, hl = L / 2 + ov;
    const zAt = (s) => z + rh * (1 - s * s);
    const faces = [];
    for (let j = 0; j < M; j++) {
      const s0 = -1 + (2 * j) / M, s1 = -1 + (2 * (j + 1)) / M, sm = (s0 + s1) / 2;
      const slope = (-2 * rh * sm) / hw;    // dz / d(across)
      let nx = -slope * wx, ny = -slope * wy, nz = 1;
      const m = Math.hypot(nx, ny, nz); nx /= m; ny /= m; nz /= m;
      if (!pr.roofVis(nx, ny, nz)) continue;
      faces.push({ d: pr.depth(...G(0, sm * hw)), pts: flat([P(-hl, s0 * hw, zAt(s0)), P(hl, s0 * hw, zAt(s0)), P(hl, s1 * hw, zAt(s1)), P(-hl, s1 * hw, zAt(s1))]), col: shd(api, col, pr.roofF(nx, ny)), kind: "roof" });
    }
    for (const sg of [1, -1]) {
      const nx = lx * sg, ny = ly * sg;
      if (!pr.wallVis(nx, ny)) continue;
      const pts = [];
      for (let j = 0; j <= M; j++) { const s = -1 + (2 * j) / M; pts.push(P(sg * (L / 2), s * (W / 2), z + rh * (1 - s * s) * 0.97)); }
      faces.push({ d: pr.depth(...G(sg * L / 2, 0)) + 1e3, pts: flat(pts), col: shd(api, o.endColor || wallCol, pr.wallF(nx, ny)), kind: "wall", end: true });
    }
    faces.sort((A, B) => B.d - A.d);
    for (const f of faces) addFace(it, f.pts, f.col, f.kind);
    // ribs across the vault, from close up
    if (o.ribs) {
      const det = { minK: 1.2, lines: [], col: shd(api, col, 0.82), w: 0.12 };
      const nrib = Math.max(2, Math.round(L / o.ribs));
      for (let q = 1; q < nrib; q++) {
        const a = -L / 2 + (q * L) / nrib, seg = [];
        for (let j = 0; j <= M; j++) { const s = -1 + (2 * j) / M; seg.push(P(a, s * hw, zAt(s) + 0.05)); }
        det.lines.push(flat(seg));
      }
      it.details.push(det);
    }
    return it;
  }
  const hl = L / 2 + ov, hw = W / 2 + ov;
  if (shape === "mansard") {
    // steep slopes up to a curb, then a low hip (University Hall, Smith Lab)
    const inset = o.inset != null ? o.inset : Math.min(2.2, W * 0.18), zc = z + rh * 0.78;
    const cl = Math.max(0.5, hl - inset), cw = Math.max(0.5, hw - inset);
    const faces = [];
    // lower slopes: 4 trapezoids
    const lower = [
      [[-hl, -hw], [hl, -hw], [cl, -cw], [-cl, -cw], 0, -1],
      [[hl, -hw], [hl, hw], [cl, cw], [cl, -cw], 1, 0],
      [[hl, hw], [-hl, hw], [-cl, cw], [cl, cw], 0, 1],
      [[-hl, hw], [-hl, -hw], [-cl, -cw], [-cl, cw], -1, 0],
    ];
    const pitchL = Math.atan2(zc - z, inset);
    for (const [a, c, d, e, sa, sw] of lower) {
      const hx = lx * sa + wx * sw, hy = ly * sa + wy * sw;
      const nx = hx * Math.sin(pitchL), ny = hy * Math.sin(pitchL), nz = Math.cos(pitchL);
      if (!pr.roofVis(nx, ny, nz)) continue;
      faces.push({ d: pr.depth(...G((a[0] + c[0]) / 2, (a[1] + c[1]) / 2)), pts: flat([P(a[0], a[1], z - 0.2), P(c[0], c[1], z - 0.2), P(d[0], d[1], zc), P(e[0], e[1], zc)]), col: shd(api, col, pr.roofF(nx, ny)), kind: "roof" });
    }
    faces.sort((A, B) => B.d - A.d);
    for (const f of faces) addFace(it, f.pts, f.col, f.kind);
    // the upper hip: a low pyramid-ish cap
    const capCol = o.capColor || col;
    const ridge = Math.max(0, cl - cw);
    const top = z + rh;
    const capFaces = [];
    const quadsCap = [
      [[-cl, -cw], [cl, -cw], [ridge, 0], [-ridge, 0], 0, -1],
      [[cl, -cw], [cl, cw], [ridge, 0], null, 1, 0],
      [[cl, cw], [-cl, cw], [-ridge, 0], [ridge, 0], 0, 1],
      [[-cl, cw], [-cl, -cw], [-ridge, 0], null, -1, 0],
    ];
    const pitchU = Math.atan2(top - zc, cw);
    for (const [a, c, d, e, sa, sw] of quadsCap) {
      const hx = lx * sa + wx * sw, hy = ly * sa + wy * sw;
      const nx = hx * Math.sin(pitchU), ny = hy * Math.sin(pitchU), nz = Math.cos(pitchU);
      if (!pr.roofVis(nx, ny, nz)) continue;
      const pts = e ? [P(a[0], a[1], zc), P(c[0], c[1], zc), P(d[0], d[1], top), P(e[0], e[1], top)] : [P(a[0], a[1], zc), P(c[0], c[1], zc), P(d[0], d[1], top)];
      capFaces.push({ d: pr.depth(...G((a[0] + c[0]) / 2, (a[1] + c[1]) / 2)), pts: flat(pts), col: shd(api, capCol, pr.roofF(nx, ny)) });
    }
    capFaces.sort((A, B) => B.d - A.d);
    for (const f of capFaces) addFace(it, f.pts, f.col, "roof");
    if (o.dormers) dormers(api, pr, it, o, G, P, z, zc, hl, hw, inset, wallCol);
    return it;
  }
  const eave = z, h = z + rh;
  const shp = shape === "pyramidal" ? "pyramidal" : shape === "gabled" ? "gabled" : "hipped";
  const ridgeHalf = shp === "gabled" ? hl : shp === "hipped" ? Math.max(0, L / 2 - W / 2) : 0;
  const pitch = Math.atan2(rh, W / 2);
  const faces = [];
  for (const sg of [1, -1]) {
    const nx = wx * sg * Math.sin(pitch), ny = wy * sg * Math.sin(pitch), nz = Math.cos(pitch);
    if (!pr.roofVis(nx, ny, nz)) continue;
    faces.push({ d: pr.depth(...G(0, sg * hw * 0.5)), pts: flat([P(-hl, sg * hw, eave - 0.25), P(hl, sg * hw, eave - 0.25), P(ridgeHalf, 0, h), P(-ridgeHalf, 0, h)]), col: shd(api, col, pr.roofF(nx, ny)), kind: "roof" });
  }
  for (const sg of [1, -1]) {
    if (shp === "gabled") {
      const nx = lx * sg, ny = ly * sg;
      if (!pr.wallVis(nx, ny)) continue;
      faces.push({ d: pr.depth(...G(sg * L / 2, 0)) - 0.5, pts: flat([P(sg * (L / 2), -W / 2, eave), P(sg * (L / 2), W / 2, eave), P(sg * (L / 2), 0, h)]), col: shd(api, o.endColor || wallCol, pr.wallF(nx, ny)), kind: "wall" });
    } else {
      const hp = Math.atan2(rh, shp === "pyramidal" ? L / 2 : W / 2);
      const nx = lx * sg * Math.sin(hp), ny = ly * sg * Math.sin(hp), nz = Math.cos(hp);
      if (!pr.roofVis(nx, ny, nz)) continue;
      faces.push({ d: pr.depth(...G(sg * hl * 0.5, 0)), pts: flat([P(sg * hl, -hw, eave - 0.25), P(sg * hl, hw, eave - 0.25), P(sg * ridgeHalf, 0, h)]), col: shd(api, col, pr.roofF(nx, ny)), kind: "roof" });
    }
  }
  // gable walls first, then slopes far to near
  faces.sort((A, B) => (A.kind === B.kind ? B.d - A.d : A.kind === "wall" ? -1 : 1));
  for (const f of faces) addFace(it, f.pts, f.col, f.kind);
  // the ridge line
  if (ridgeHalf > 0) it.details.push({ minK: 0.8, lines: [flat([P(-ridgeHalf, 0, h), P(ridgeHalf, 0, h)])], col: shd(api, col, 0.62), w: 0.14, snowCol: true });
  if (o.dormers) dormers(api, pr, it, o, G, P, eave, h, hl, hw, null, wallCol, pitch);
  return it;
}
// little gabled dormers along the long slopes (the near ones), from close up
function dormers(api, pr, it, o, G, P, z0, z1, hl, hw, inset, wallCol, pitch) {
  const n = Math.max(1, Math.floor((o.L - 4) / o.dormers));
  const det = { minK: 1.6, polys: [] };
  const dz = (z1 - z0), dh = Math.min(2.4, dz * 0.45);
  for (const sg of [1, -1]) {
    // only the slope that faces us
    const nx = (Math.cos(o.ang + Math.PI / 2)) * sg, ny = Math.sin(o.ang + Math.PI / 2) * sg;
    if (!pr.wallVis(nx, ny)) continue;
    for (let q = 0; q < n; q++) {
      const a = -o.L / 2 + 2 + (q + 0.5) * ((o.L - 4) / n);
      const across = sg * (hw - (inset != null ? inset * 0.45 : hw * 0.35));
      const zb = z0 + dz * (inset != null ? 0.35 : 0.3);
      const w = 0.9;
      const front = [P(a - w, across, zb), P(a + w, across, zb), P(a + w, across, zb + dh), P(a, across, zb + dh + 0.9), P(a - w, across, zb + dh)];
      det.polys.push({ pts: flat(front), col: shd(api, o.dormerColor || "#ece5d6", pr.wallF(nx, ny)) });
      det.polys.push({ pts: flat([P(a - w * 0.55, across, zb + 0.35), P(a + w * 0.55, across, zb + 0.35), P(a + w * 0.55, across, zb + dh - 0.15), P(a - w * 0.55, across, zb + dh - 0.15)]), col: "#3d4651", glassSlot: true });
    }
  }
  it.details.push(det);
}

// A hipped roof over the whole footprint: each wall's eave slopes up and in by `d` to a flat deck `rh` higher (the deck
// closes to ridges where a wing is no wider than 2·d). The footprint is simplified first, then inset; when the inset
// folds over itself (a wing narrower than 2·d) d shrinks until it doesn't.
function simplifyRing(f, tol) {
  const pts = [];
  for (let q = 0; q < f.length; q += 2) pts.push([f[q], f[q + 1]]);
  const area = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  while (pts.length > 4) {
    let best = -1, bestA = Infinity;
    for (let q = 0; q < pts.length; q++) {
      const a = pts[(q + pts.length - 1) % pts.length], b = pts[q], c = pts[(q + 1) % pts.length];
      const A = area(a, b, c), short = Math.min(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - b[0], c[1] - b[1]));
      const score = short < 1.2 ? A * 0.3 : A;
      if (score < bestA) { bestA = score; best = q; }
    }
    if (bestA > tol) break;
    pts.splice(best, 1);
  }
  return pts;
}
function insetRing(pts, d) {
  const n = pts.length, out = [];
  for (let q = 0; q < n; q++) {
    const a = pts[(q + n - 1) % n], b = pts[q], c = pts[(q + 1) % n];
    let e1x = b[0] - a[0], e1y = b[1] - a[1], e2x = c[0] - b[0], e2y = c[1] - b[1];
    const l1 = Math.hypot(e1x, e1y) || 1, l2 = Math.hypot(e2x, e2y) || 1;
    e1x /= l1; e1y /= l1; e2x /= l2; e2y /= l2;
    const n1x = -e1y, n1y = e1x, n2x = -e2y, n2y = e2x;       // left normals: inward for CCW rings, into the building for CW holes
    const den = Math.max(0.25, 1 + n1x * n2x + n1y * n2y);
    out.push([b[0] + ((n1x + n2x) * d) / den, b[1] + ((n1y + n2y) * d) / den]);
  }
  return out;
}
function segX(a, b, c, e) {
  const d1 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d2 = (b[0] - a[0]) * (e[1] - a[1]) - (b[1] - a[1]) * (e[0] - a[0]);
  const d3 = (e[0] - c[0]) * (a[1] - c[1]) - (e[1] - c[1]) * (a[0] - c[0]);
  const d4 = (e[0] - c[0]) * (b[1] - c[1]) - (e[1] - c[1]) * (b[0] - c[0]);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
function insetOk(pts, ins) {
  const n = pts.length;
  for (let q = 0; q < n; q++) {
    const a = pts[q], b = pts[(q + 1) % n], A = ins[q], B = ins[(q + 1) % n];
    const dot = (b[0] - a[0]) * (B[0] - A[0]) + (b[1] - a[1]) * (B[1] - A[1]);
    if (dot < -1e-6) return false;   // an edge turned round: the inset passed a ridge
  }
  for (let q = 0; q < n; q++) for (let p = q + 2; p < n; p++) {
    if (q === 0 && p === n - 1) continue;
    if (segX(ins[q], ins[(q + 1) % n], ins[p], ins[(p + 1) % n])) return false;
  }
  return true;
}
function hipOf(api, i, o) {
  const s = stateOf(api);
  if (!s.hips) s.hips = new Map();
  const key = `${i}:${o.d}:${o.rh}:${o.tol}:${o.ov}`;
  let h = s.hips.get(key);
  if (h !== undefined) return h;
  const b = api.data.buildings[i];
  const rings = b.p.map((f) => simplifyRing(f, o.tol != null ? o.tol : 2.5));
  const ov = o.ov != null ? o.ov : 0.35;
  h = null;
  let d = o.d || 6;
  for (let tries = 0; tries < 9 && !h; tries++, d *= 0.82) {
    const eaves = rings.map((r) => insetRing(r, -ov)), decks = rings.map((r) => insetRing(r, d));
    if (rings.every((r, q) => insetOk(r, decks[q]))) h = { eaves, decks, d, rh: o.rh * Math.min(1, d / (o.d || 6)) };
  }
  s.hips.set(key, h);
  return h;
}
function hipItem(api, pr, b, i, o) {
  const h = hipOf(api, i, o);
  if (!h) return null;
  const z = o.z != null ? o.z : b.h, top = z + h.rh;
  let cx = 0, cy = 0;
  for (const p of h.eaves[0]) { cx += p[0]; cy += p[1]; }
  // the deck (with its courtyards cut out) and each slope that faces us: separate pieces, so that a tower standing on
  // the roof sorts among them
  const out = [];
  const deckIt = newItem(pr.depth(cx / h.eaves[0].length, cy / h.eaves[0].length));
  const deck = [];
  for (const r of h.decks) deck.push(flat(r.map((p) => pr.P(p[0], p[1], top))));
  deckIt.faces.push({ deck, col: o.deck || shd(api, o.color, 0.97), kind: "roof" });
  deckIt.sil = [orient(deck[0])];
  out.push(deckIt);
  const pitch = Math.atan2(h.rh, h.d), sp = Math.sin(pitch), cp = Math.cos(pitch);
  h.eaves.forEach((E, ri) => {
    const D = h.decks[ri], n = E.length;
    for (let q = 0; q < n; q++) {
      const a = E[q], c = E[(q + 1) % n], A = D[q], Cc = D[(q + 1) % n];
      const ex = c[0] - a[0], ey = c[1] - a[1], L = Math.hypot(ex, ey) || 1;
      const nx = (ey / L) * sp, ny = (-ex / L) * sp, nz = cp;
      if (!pr.roofVis(nx, ny, nz)) continue;
      const pts = flat([pr.P(a[0], a[1], z - 0.2), pr.P(c[0], c[1], z - 0.2), pr.P(Cc[0], Cc[1], top), pr.P(A[0], A[1], top)]);
      const it = newItem(pr.depth((a[0] + c[0] + A[0] + Cc[0]) / 4, (a[1] + c[1] + A[1] + Cc[1]) / 4));
      addFace(it, pts, shd(api, o.color, pr.roofF(nx, ny)), "roof");
      it.sil = [orient(pts)];
      out.push(it);
    }
  });
  return out;
}

// ornaments
function buildOrn(api, pr, b, o, r, st) {
  const out = [];
  const z0 = o.z0 != null ? o.z0 : b.h;
  if (o.type === "tower") {
    // a tower standing on the roof (or the ground): shaft, optional belfry openings / clock, and a roof
    const shape = o.shape || "square";
    const n = shape === "round" ? 16 : shape === "oct" ? 8 : 4;
    const ring = shape === "square" ? rect(o.x, o.y, o.ang || 0, o.w, o.d || o.w) : circle(o.x, o.y, o.r, n, shape === "oct" ? Math.PI / 8 + (o.ang || 0) : 0);
    const wall = o.wall || st.wall;
    // below the top of the building's own roofs the shaft sorts among the roof's pieces; above it, it is drawn last
    const zs = Math.min(o.z1, Math.max(z0, o.split != null ? o.split : z0));
    let lo = null;
    if (zs > z0 + 0.01) { lo = newItem(pr.depth(o.x, o.y)); prismFaces(api, pr, lo, ring, z0, zs, wall, null); out.push(lo); }
    const it = newItem(pr.depth(o.x, o.y));
    it.late = zs > z0 + 0.01;
    const faces = prismFaces(api, pr, it, ring, zs, o.z1, wall, o.roof && o.roof.shape !== "flat" ? null : shd(api, wall, 0.95));
    // a cornice / belt at the top of the shaft
    const trim = o.trim || st.trim || shd(api, wall, 1.25);
    const beltLines = [];
    for (const f of faces) {
      for (const zb of o.belts || []) beltLines.push({ f, z: zb });
    }
    if (beltLines.length) {
      const polys = [];
      for (const { f, z } of beltLines) polys.push({ pts: flat([pr.P(f.p[0], f.p[1], z - 0.3), pr.P(f.q[0], f.q[1], z - 0.3), pr.P(f.q[0], f.q[1], z + 0.3), pr.P(f.p[0], f.p[1], z + 0.3)]), col: shd(api, trim, pr.wallF(f.nx, f.ny)) });
      it.details.push({ minK: 0.9, polys });
    }
    // slots cut down a round turret (the Wexner Center's split brick turrets): the facets nearest the given angles
    if (o.slots && shape !== "square") {
      const polys = [];
      for (const a of o.slots) {
        const j = ((Math.round((a / TAU) * n - 0.5) % n) + n) % n;
        const f = faces.find((fc) => fc.p === ring[j]);
        if (!f) continue;
        const at = (t, zz) => pr.P(f.p[0] + (f.q[0] - f.p[0]) * t, f.p[1] + (f.q[1] - f.p[1]) * t, zz);
        polys.push({ pts: flat([at(0.12, o.slotZ != null ? o.slotZ : zs), at(0.88, o.slotZ != null ? o.slotZ : zs), at(0.88, o.z1), at(0.12, o.z1)]), col: shd(api, wall, 0.45) });
      }
      it.details.push({ minK: 0.6, polys });
    }
    // belfry openings: arched, dark, on every face seen (on a round tower every other facet)
    if (o.belfry) {
      const [bz0, bz1] = o.belfry, polys = [], glow = [];
      faces.forEach((f, j) => {
        if (shape === "round" && (ring.indexOf(f.p) & 1)) return;
        const fl = Math.hypot(f.q[0] - f.p[0], f.q[1] - f.p[1]);
        const nOpen = shape === "square" ? Math.max(1, Math.round(fl / 2.2)) : 1;
        for (let q = 0; q < nOpen; q++) {
          const tc = (q + 0.5) / nOpen, half = (0.3 / nOpen) * (shape === "square" ? 1 : 1.25);
          const rad = half * fl, zs = bz1 - rad;
          const pts = [];
          const at = (t, z) => pr.P(f.p[0] + (f.q[0] - f.p[0]) * t, f.p[1] + (f.q[1] - f.p[1]) * t, z);
          pts.push(at(tc - half, bz0), at(tc + half, bz0));
          for (let s = 0; s <= 6; s++) { const a = (s / 6) * Math.PI; pts.push(at(tc + Math.cos(a) * half, zs + Math.sin(a) * rad)); }
          polys.push({ pts: flat(pts), col: "#3b3430" });
          glow.push({ pts: flat(pts), col: "rgba(255,206,128,.55)" });
        }
      });
      it.details.push({ minK: 0.7, polys });
      it.glow.push({ minK: 0.7, polys: glow });
    }
    // windows up the shaft: a column of slits per face
    if (o.slits) {
      // (the ones below the split belong to the lower part of the shaft, which the roof may hide)
      const [sz0, sz1, step] = o.slits, polys = [], glow = [], loPolys = [], loGlow = [];
      faces.forEach((f, j) => {
        if (shape === "round" && (ring.indexOf(f.p) % 4)) return;
        for (let z = sz0, q = 0; z + 1.4 <= sz1; z += step, q++) {
          const at = (t, zz) => pr.P(f.p[0] + (f.q[0] - f.p[0]) * t, f.p[1] + (f.q[1] - f.p[1]) * t, zz);
          const pts = flat([at(0.4, z), at(0.6, z), at(0.6, z + 1.4), at(0.4, z + 1.4)]);
          const below = lo && z + 1.4 <= zs;
          if (!below && z < zs) continue;   // astride the split: left out
          (below ? loPolys : polys).push({ pts, col: "#3d4550" });
          if (api.nHash(q * 31 + j * 7 + (o.seed || 1)) < 0.45) (below ? loGlow : glow).push({ pts, col: "rgba(255,214,150,.9)" });
        }
      });
      it.details.push({ minK: 1.2, polys });
      it.glow.push({ minK: 1.2, polys: glow });
      if (lo) { lo.details.push({ minK: 1.2, polys: loPolys }); lo.glow.push({ minK: 1.2, polys: loGlow }); }
    }
    // clock faces: a pale disc with hands on each face seen
    if (o.clock) {
      const [cz, crad] = o.clock, polys = [], lines = [], glow = [];
      for (const f of faces) {
        const fl = Math.hypot(f.q[0] - f.p[0], f.q[1] - f.p[1]), tr = crad / fl;
        const at = (t, zz) => pr.P(f.p[0] + (f.q[0] - f.p[0]) * t, f.p[1] + (f.q[1] - f.p[1]) * t, zz);
        const pts = [];
        for (let s = 0; s < 14; s++) { const a = (s / 14) * TAU; pts.push(at(0.5 + Math.cos(a) * tr, cz + Math.sin(a) * crad)); }
        polys.push({ pts: flat(pts), col: shd(api, "#f1ecdf", pr.wallF(f.nx, f.ny) + 0.1) });
        glow.push({ pts: flat(pts), col: "rgba(255,240,200,.95)" });
        lines.push(flat([at(0.5, cz), at(0.5, cz + crad * 0.7)]), flat([at(0.5, cz), at(0.5 + tr * 0.5, cz - crad * 0.2)]));
      }
      it.details.push({ minK: 0.9, polys }, { minK: 1.6, lines, col: "#2f2a26", w: 0.09 });
      it.glow.push({ minK: 0.9, polys: glow });
    }
    // the tower's roof
    if (o.roof && o.roof.shape !== "flat") {
      const rf = o.roof, rz = o.z1, ov = rf.ov != null ? rf.ov : 0.35;
      if (rf.shape === "dome") domeFaces(api, pr, it, o.x, o.y, rz, (o.r || o.w / 2) + ov, rf.h, rf.color);
      else {
        const base = shape === "square" ? rect(o.x, o.y, o.ang || 0, o.w + 2 * ov, (o.d || o.w) + 2 * ov) : circle(o.x, o.y, o.r + ov, n, shape === "oct" ? Math.PI / 8 + (o.ang || 0) : 0);
        pyramidFaces(api, pr, it, base, rz, o.x, o.y, rz + rf.h, rf.color);
      }
      if (rf.finial) it.details.push({ minK: 0.8, lines: [flat([pr.P(o.x, o.y, rz + rf.h), pr.P(o.x, o.y, rz + rf.h + rf.finial)])], col: "#4a4540", w: 0.12 });
    }
    out.push(it);
  } else if (o.type === "box") {
    // a plain block (a fly tower, a penthouse, a spine)
    const ring = o.ring || rect(o.x, o.y, o.ang || 0, o.L, o.W);
    const it = newItem(pr.depth(o.x != null ? o.x : ring[0][0], o.y != null ? o.y : ring[0][1]));
    const wall = o.wall || st.wall;
    prismFaces(api, pr, it, ring, z0, o.z1, wall, o.top || shd(api, wall, 0.92));
    if (o.ribbons) {
      // bands of glass round it
      // and at night, bays of it lit here and there (about half, more on a hospital)
      const [rz0, step, hgt] = o.ribbons, polys = [], glow = [];
      const on = o.lit != null ? o.lit : 0.45;
      for (let q = 0; q < ring.length; q++) {
        const p = ring[q], p2 = ring[(q + 1) % ring.length];
        const dx = p2[0] - p[0], dy = p2[1] - p[1], L = Math.hypot(dx, dy);
        const nx = dy / L, ny = -dx / L;
        if (!pr.wallVis(nx, ny)) continue;
        const nb = Math.max(1, Math.round(L / 3.2));
        let fl = 0;
        for (let z = rz0; z + hgt <= o.z1 - 0.3; z += step, fl++) {
          polys.push({ pts: flat([pr.P(p[0], p[1], z), pr.P(p2[0], p2[1], z), pr.P(p2[0], p2[1], z + hgt), pr.P(p[0], p[1], z + hgt)]), col: shd(api, o.glass || "#4b5a66", pr.wallF(nx, ny)) });
          for (let w = 0; w < nb; w++) {
            const hs = api.nHash((o.seed || 7) * 1000 + q * 7919 + fl * 131 + w * 17);
            if (hs > on) continue;
            const t0 = (w + 0.08) / nb, t1 = (w + 0.92) / nb;
            const A = [p[0] + dx * t0, p[1] + dy * t0], B = [p[0] + dx * t1, p[1] + dy * t1];
            glow.push({ pts: flat([pr.P(A[0], A[1], z), pr.P(B[0], B[1], z), pr.P(B[0], B[1], z + hgt), pr.P(A[0], A[1], z + hgt)]), col: hs < on * 0.25 ? "rgba(214,232,255,.9)" : hs < on * 0.7 ? "rgba(255,216,137,.9)" : "rgba(255,196,107,.9)" });
          }
        }
      }
      it.details.push({ minK: 0.6, polys });
      it.glow.push({ minK: 0.5, polys: glow });
    }
    out.push(it);
  } else if (o.type === "scaffold") {
    // an open white steel grid over a rectangle (the Wexner Center's): back members, then front ones
    const ang = o.ang || 0, ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
    const it = newItem(pr.depth(o.x, o.y));
    const zA = o.z0 != null ? o.z0 : 0, zB = o.z1, cell = o.cell || 3.6;
    const nl = Math.max(1, Math.round(o.L / cell)), nw = Math.max(1, Math.round(o.W / cell)), nz = Math.max(1, Math.round((zB - zA) / cell));
    const G = (a, c) => [o.x + ux * a + vx * c, o.y + uy * a + vy * c];
    const back = [], front = [];
    const sideFacing = (nx, ny) => pr.wallVis(nx, ny);
    // the four sides: verticals and horizontals
    const sides = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [sa, sc] of sides) {
      const nx = ux * sa + vx * sc, ny = uy * sa + vy * sc;
      const list = sideFacing(nx, ny) ? front : back;
      const alongLen = sa === 0 ? o.L : o.W, cnt = sa === 0 ? nl : nw;
      for (let q = 0; q <= cnt; q++) {
        const t = -alongLen / 2 + (q * alongLen) / cnt;
        const g = sa === 0 ? G(t, sc * o.W / 2) : G(sa * o.L / 2, t);
        list.push(flat([pr.P(g[0], g[1], zA), pr.P(g[0], g[1], zB)]));
      }
      for (let q = 0; q <= nz; q++) {
        const z = zA + (q * (zB - zA)) / nz;
        const g0 = sa === 0 ? G(-o.L / 2, sc * o.W / 2) : G(sa * o.L / 2, -o.W / 2), g1 = sa === 0 ? G(o.L / 2, sc * o.W / 2) : G(sa * o.L / 2, o.W / 2);
        list.push(flat([pr.P(g0[0], g0[1], z), pr.P(g1[0], g1[1], z)]));
      }
    }
    // the top: cross members
    for (let q = 0; q <= nl; q++) { const t = -o.L / 2 + (q * o.L) / nl; const g0 = G(t, -o.W / 2), g1 = G(t, o.W / 2); front.push(flat([pr.P(g0[0], g0[1], zB), pr.P(g1[0], g1[1], zB)])); }
    const col = o.color || "#f3f1ec";
    it.details.push({ minK: 0, lines: back, col: shd(api, col, 0.86), w: o.lw || 0.28, alpha: 0.85 });
    it.details.push({ minK: 0, lines: front, col, w: o.lw || 0.28 });
    // a thin outline so its bounds count for blots / silhouettes
    for (const g of rect(o.x, o.y, ang, o.L, o.W)) { it.pts.push(pr.P(g[0], g[1], zA), pr.P(g[0], g[1], zB)); }
    it.see = true;   // see-through: not a solid blot
    out.push(it);
  } else if (o.type === "ring") {
    // a steel crown ring on posts above a rotunda (Value City Arena)
    const it = newItem(pr.depth(o.x, o.y));
    const n = 20, lines = [], z1 = o.z1;
    const ringPts = [];
    for (let j = 0; j <= n; j++) { const a = (j / n) * TAU; ringPts.push(pr.P(o.x + Math.cos(a) * o.r, o.y + Math.sin(a) * o.r, z1)); }
    lines.push(flat(ringPts));
    for (let j = 0; j < n; j += 2) { const a = (j / n) * TAU; const x = o.x + Math.cos(a) * o.r, y = o.y + Math.sin(a) * o.r; lines.push(flat([pr.P(x, y, z0), pr.P(x, y, z1)])); }
    it.details.push({ minK: 0.5, lines, col: o.color || "#e9ebec", w: 0.3 });
    for (const p of circle(o.x, o.y, o.r, 8)) it.pts.push(pr.P(p[0], p[1], z0), pr.P(p[0], p[1], z1));
    it.see = true;
    out.push(it);
  } else if (o.type === "flagpole") {
    const it = newItem(pr.depth(o.x, o.y));
    it.details.push({ minK: 0.8, lines: [flat([pr.P(o.x, o.y, z0), pr.P(o.x, o.y, z0 + o.h)])], col: "#ece9e2", w: 0.12 });
    it.details.push({ minK: 1.2, polys: [{ pts: flat([pr.P(o.x, o.y, z0 + o.h - 0.2), pr.P(o.x, o.y, z0 + o.h - 1.4), pr.P(o.x + (o.fx || 1.6), o.y + (o.fy || 0), z0 + o.h - 1.3), pr.P(o.x + (o.fx || 1.6), o.y + (o.fy || 0), z0 + o.h - 0.3)]), col: o.flag || "#b3202a" }] });
    it.see = true;
    out.push(it);
  }
  return out;
}

function itemsOf(api, i, r) {
  const s = stateOf(api), key = i * 4 + r;
  let list = s.items.get(key);
  if (list) return list;
  list = [];
  const b = api.data.buildings[i], spec = specOf(api, b.lm);
  if (spec && (spec.roofs || spec.orn)) {
    const pr = projector(api, r), st = api.styleOf(i);
    for (const o of spec.roofs || []) {
      if (!owns(o, b)) continue;
      if (o.shape === "hip") { const its = hipItem(api, pr, b, i, o); if (its) list.push(...its); }
      else list.push(roofItem(api, pr, b, o, r, st.wall));
    }
    for (const o of spec.orn || []) if (owns(o, b)) list.push(...buildOrn(api, pr, b, o, r, st));
    // pieces that stand above every roof of the building are drawn last (nothing of the roofs can hide them)
    list.sort((p, q) => (p.late ? 1 : 0) - (q.late ? 1 : 0) || q.depth - p.depth);
    for (const it of list) {
      if (it.see || it.sil) continue;
      const hl = hull(it.pts); it.sil = hl ? [hl] : [];
    }
  }
  s.items.set(key, list);
  return list;
}
// a polygon wound like ctx.rect() (positive shoelace area in screen coordinates)
function orient(f) {
  let a = 0;
  for (let q = 0, n = f.length; q < n; q += 2) { const j = (q + 2) % n; a += f[q] * f[j + 1] - f[j] * f[q + 1]; }
  if (a >= 0) return f;
  const out = new Float64Array(f.length);
  for (let q = 0, n = f.length / 2; q < n; q++) { out[2 * q] = f[2 * (n - 1 - q)]; out[2 * q + 1] = f[2 * (n - 1 - q) + 1]; }
  return out;
}
// convex hull (screen metres) of an item's points, for silhouettes
function hull(pts) {
  const P = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (P.length < 3) return null;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let q = P.length - 1; q >= 0; q--) { const p = P[q]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return flat(lo.slice(0, -1).concat(up.slice(0, -1)));
}

// ------------------------------------------------------------------------------------------------ wall paint
// Paint on the building's own visible walls (bands, piers, brick zones, shingle courses, a grid), each wall clipped to
// what of it the finished building shows (nearer walls and the roof cover the far walls of an L or a U).
function wallsOf(api, i, r) {
  const s = stateOf(api), key = i * 4 + r;
  let w = s.walls.get(key);
  if (w !== undefined) return w;
  const b = api.data.buildings[i], spec = specOf(api, b.lm);
  const decos = spec && spec.walls ? spec.walls.filter((o) => owns(o, b)) : [];
  if (!decos.length) { s.walls.set(key, null); return null; }
  const walls = api.visibleWalls(i, r);
  const ol = api.outlineOf(i, r);
  const bbOf = (f) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (let q = 0; q < f.length; q += 2) { if (f[q] < x0) x0 = f[q]; if (f[q] > x1) x1 = f[q]; if (f[q + 1] < y0) y0 = f[q + 1]; if (f[q + 1] > y1) y1 = f[q + 1]; } return [x0, y0, x1, y1]; };
  const over = (a, c) => a[0] < c[2] - 1e-3 && c[0] < a[2] - 1e-3 && a[1] < c[3] - 1e-3 && c[1] < a[3] - 1e-3;
  const wbb = ol ? ol.walls.map(bbOf) : [];
  const rbb = ol ? ol.roof.map(bbOf) : [];
  // a convex footprint hides none of its own visible walls: no clipping at all
  const convex = b.p.length === 1 && isConvex(b.p[0]);
  w = { decos, list: walls.map((wv, n) => {
    // what covers this wall: nearer walls that really overlap it (not just touch it at a corner), and the roof where
    // it reaches over it (the near wing of an L, the near side of a courtyard; never along the wall's own top edge)
    const cover = [];
    if (ol && !convex) {
      for (let m = n + 1; m < walls.length; m++) if (over(wbb[n], wbb[m]) && quadsOverlap(ol.walls[n], ol.walls[m])) cover.push(ol.walls[m]);
      ol.roof.forEach((f, q) => { if (over(wbb[n], rbb[q]) && roofOver(ol.walls[n], f)) cover.push(f); });
    }
    return { wv, cover };
  }) };
  s.walls.set(key, w);
  return w;
}
function isConvex(f) {
  let sgn = 0;
  for (let q = 0, n = f.length / 2; q < n; q++) {
    const a = q, b = (q + 1) % n, c = (q + 2) % n;
    const cr = (f[2 * b] - f[2 * a]) * (f[2 * c + 1] - f[2 * b + 1]) - (f[2 * b + 1] - f[2 * a + 1]) * (f[2 * c] - f[2 * b]);
    if (Math.abs(cr) < 0.05) continue;
    if (sgn === 0) sgn = Math.sign(cr); else if (Math.sign(cr) !== sgn) return false;
  }
  return true;
}
// do two convex quads (screen metres) overlap by more than a sliver? (separating axes, with a little tolerance)
function quadsOverlap(A, B) {
  for (const P of [A, B]) {
    const n = P.length / 2;
    for (let q = 0; q < n; q++) {
      const ex = P[2 * ((q + 1) % n)] - P[2 * q], ey = P[2 * ((q + 1) % n) + 1] - P[2 * q + 1];
      const L = Math.hypot(ex, ey);
      if (L < 1e-6) continue;
      const ax = -ey / L, ay = ex / L;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (let k = 0; k < A.length; k += 2) { const v = A[k] * ax + A[k + 1] * ay; if (v < a0) a0 = v; if (v > a1) a1 = v; }
      for (let k = 0; k < B.length; k += 2) { const v = B[k] * ax + B[k + 1] * ay; if (v < b0) b0 = v; if (v > b1) b1 = v; }
      if (a1 <= b0 + 0.05 || b1 <= a0 + 0.05) return false;
    }
  }
  return true;
}
function inPoly(f, x, y) {
  let c = false;
  for (let q = 0, n = f.length, p = n - 2; q < n; p = q, q += 2) {
    const xi = f[q], yi = f[q + 1], xj = f[p], yj = f[p + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
// does the roof outline reach over this wall? (any of a few points inside the wall, away from its top edge)
function roofOver(W, f) {
  // W: bottom-left, bottom-right, top-right, top-left
  for (const t of [0.15, 0.5, 0.85]) for (const u of [0.1, 0.45, 0.8]) {
    const bx = W[0] + (W[2] - W[0]) * t, by = W[1] + (W[3] - W[1]) * t, tx = W[6] + (W[4] - W[6]) * t, ty = W[7] + (W[5] - W[7]) * t;
    if (inPoly(f, bx + (tx - bx) * u, by + (ty - by) * u)) return true;
  }
  return false;
}
const BIG = 1e6;
function clipWall(ctx, w, own) {
  // to the wall itself, then out of everything that covers it (each a complement clip)
  ctx.beginPath(); ctx.moveTo(own[0], own[1]); for (let q = 2; q < own.length; q += 2) ctx.lineTo(own[q], own[q + 1]); ctx.closePath(); ctx.clip();
  for (const f of w.cover) {
    ctx.beginPath(); ctx.rect(-BIG, -BIG, 2 * BIG, 2 * BIG);
    ctx.moveTo(f[0], f[1]); for (let q = 2; q < f.length; q += 2) ctx.lineTo(f[q], f[q + 1]); ctx.closePath();
    ctx.clip("evenodd");
  }
}
// draw (or, at night, rub out) the wall paint of building i; mode 0 day, 1 blot
function paintWalls(api, ctx, r, k, i, mode) {
  const W = wallsOf(api, i, r);
  if (!W) return;
  const b = api.data.buildings[i], st = api.styleOf(i);
  const rings = api.scene.forRot(r).objRings[i];
  const ol = api.outlineOf(i, r);
  const base = b.mh || 0, he = b.roof && b.roof !== "flat" && b.obb ? b.h - b.rh : b.h;
  const pr = projector(api, r);
  for (let n = 0; n < W.list.length; n++) {
    const { wv } = W.list[n];
    const f = rings[wv.ri];
    const x1 = f[2 * wv.c], y1 = f[2 * wv.c + 1], x2 = f[2 * wv.a], y2 = f[2 * wv.a + 1];
    if (wv.L < 0.8) continue;
    let clipped = false;
    const f0 = 0.7 + 0.36 * wv.light;
    for (const o of W.decos) {
      if (o.minK && k < o.minK) continue;
      if (mode === 1 && !((o.type === "band" && !o.windows) || o.type === "piers" || o.type === "zone" || o.type === "arcade")) continue;
      if (!clipped && W.list[n].cover.length) { ctx.save(); clipWall(ctx, W.list[n], ol.walls[n]); clipped = true; }
      const col = mode === 1 ? "#000" : o.color ? shd(api, o.color, f0) : null;
      ctx.beginPath();
      if (o.type === "band") {
        const za = Math.max(base, o.z0), zb = Math.min(he, o.z1 != null ? o.z1 : he);
        if (zb <= za) continue;
        api.quad(ctx, x1, y1, x2, y2, 0, 1, za, zb);
        if (o.windows && k >= 1) {
          // a stone storey keeps its windows: the day's, laid out as ever, put back over the band
          ctx.fillStyle = col; ctx.fill();
          ctx.save(); ctx.beginPath(); api.quad(ctx, x1, y1, x2, y2, 0, 1, za, zb); ctx.clip();
          api.drawWindows(ctx, b, st, wv, x1, y1, x2, y2, k >= 2 ? 1 : 0, k, 0);
          ctx.restore();
          continue;
        }
      } else if (o.type === "piers") {
        // vertical bands at both ends of the wall (and every `every` m between)
        const pw = o.w / wv.L, z0 = o.z0 != null ? Math.max(base, o.z0) : base, z1 = o.z1 != null ? Math.min(he, o.z1) : he;
        if (wv.L > 2.2 * o.w) { api.quad(ctx, x1, y1, x2, y2, 0, pw, z0, z1); api.quad(ctx, x1, y1, x2, y2, 1 - pw, 1, z0, z1); }
        else api.quad(ctx, x1, y1, x2, y2, 0, 1, z0, z1);
        if (o.every && wv.L > o.every * 1.5) {
          const m = Math.round(wv.L / o.every);
          for (let q = 1; q < m; q++) { const t = q / m; api.quad(ctx, x1, y1, x2, y2, t - pw * (o.mid || 0.5), t + pw * (o.mid || 0.5), z0, z1); }
        }
      } else if (o.type === "zone") {
        // the stretch of wall within `rad` of a point (a brick turret inside a stone building)
        const g = b.p[wv.ri], ax = g[2 * wv.c], ay = g[2 * wv.c + 1], bx = g[2 * wv.a], by = g[2 * wv.a + 1];
        for (const [px, py, rad, zt] of o.pts) {
          // the part of segment a-b inside the circle
          const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
          const t = ((px - ax) * dx + (py - ay) * dy) / L2, cx = ax + dx * t - px, cy = ay + dy * t - py;
          const d2 = cx * cx + cy * cy;
          if (d2 >= rad * rad) continue;
          const half = Math.sqrt((rad * rad - d2) / L2);
          const t0 = Math.max(0, t - half), t1 = Math.min(1, t + half);
          if (t1 <= t0) continue;
          api.quad(ctx, x1, y1, x2, y2, t0, t1, base, Math.min(he, zt != null ? zt : he));
        }
      } else if (o.type === "arcade") {
        // round-arched openings along the wall, `step` apart, from z0 up to the crown at z1 (a Romanesque ground
        // floor, a two-storey arcade)
        if (k < 1 || wv.L < o.step * 0.9) continue;
        const nA = Math.max(1, Math.floor(wv.L / o.step)), pad = (wv.L - nA * o.step) / 2 / wv.L, span = o.step / wv.L;
        const half = (span * (o.w || 0.6)) / 2, rad = half * wv.L, zs = Math.min(he, o.z1) - rad, z0 = Math.max(base, o.z0 || 0);
        if (zs <= z0) continue;
        for (let q = 0; q < nA; q++) {
          const tc = pad + span * (q + 0.5);
          const X = (t, z) => [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t - z * pr.C];
          let P = X(tc - half, z0); ctx.moveTo(P[0], P[1]);
          P = X(tc + half, z0); ctx.lineTo(P[0], P[1]);
          for (let a = 0; a <= 8; a++) { const an = (a / 8) * Math.PI; P = X(tc + Math.cos(an) * half, zs + Math.sin(an) * rad); ctx.lineTo(P[0], P[1]); }
          ctx.closePath();
        }
        if (mode === 0) { ctx.fillStyle = o.color ? shd(api, o.color, f0) : "#3a3532"; ctx.fill(); if (o.frame) { ctx.strokeStyle = shd(api, o.frame, f0); ctx.lineWidth = 0.18; ctx.stroke(); } continue; }
      } else if (o.type === "shingle") {
        // courses of stone shingles: fine horizontal lines, the joints staggered
        if (k < 2.2) continue;
        const step = o.step || 0.9;
        for (let z = base + step; z < he - 0.2; z += step) { ctx.moveTo(x1, y1 - z * pr.C); ctx.lineTo(x2, y2 - z * pr.C); }
        ctx.strokeStyle = o.line || "rgba(120,120,116,.28)"; ctx.lineWidth = 0.05; ctx.stroke();
        continue;
      } else if (o.type === "grid") {
        // a white grid laid on walls near a line (a scaffold standing against them)
        const g = b.p[wv.ri], ax = g[2 * wv.c], ay = g[2 * wv.c + 1], bx = g[2 * wv.a], by = g[2 * wv.a + 1];
        const [lx0, ly0, lx1, ly1] = o.line;
        const dist = (x, y) => { const dx = lx1 - lx0, dy = ly1 - ly0, L2 = dx * dx + dy * dy, t = Math.max(0, Math.min(1, ((x - lx0) * dx + (y - ly0) * dy) / L2)); return Math.hypot(lx0 + dx * t - x, ly0 + dy * t - y); };
        if (dist((ax + bx) / 2, (ay + by) / 2) > o.dist) continue;
        const cell = o.cell || 3.6, nseg = Math.max(1, Math.round(wv.L / cell));
        for (let q = 0; q <= nseg; q++) { const t = q / nseg, X = x1 + (x2 - x1) * t, Y = y1 + (y2 - y1) * t; ctx.moveTo(X, Y - base * pr.C); ctx.lineTo(X, Y - he * pr.C); }
        for (let z = base + cell; z < he; z += cell) { ctx.moveTo(x1, y1 - z * pr.C); ctx.lineTo(x2, y2 - z * pr.C); }
        ctx.strokeStyle = mode === 1 ? "#000" : o.color || "#f3f1ec"; ctx.lineWidth = o.lw || 0.28; ctx.stroke();
        continue;
      }
      ctx.fillStyle = col; ctx.fill();
    }
    if (clipped) ctx.restore();
  }
}

// ------------------------------------------------------------------------------------------------ drawing
function fillPoly(ctx, f) {
  ctx.beginPath(); ctx.moveTo(f[0], f[1]);
  for (let q = 2; q < f.length; q += 2) ctx.lineTo(f[q], f[q + 1]);
  ctx.closePath();
}

// polygons in order, one fill per run of the same colour
function fillBatched(ctx, polys) {
  let col = null;
  for (let q = 0; q < polys.length; q++) {
    const p = polys[q];
    if (p.col !== col) { if (col !== null) { ctx.fillStyle = col; ctx.fill(); } ctx.beginPath(); col = p.col; }
    const f = p.pts;
    ctx.moveTo(f[0], f[1]);
    for (let k = 2; k < f.length; k += 2) ctx.lineTo(f[k], f[k + 1]);
    ctx.closePath();
  }
  if (col !== null) { ctx.fillStyle = col; ctx.fill(); }
}

/** Extra geometry drawn after the standard building (towers, domes, clocks, ornaments). */
export function decorate(api, ctx, r, cam, i, style) {
  const b = api.data.buildings[i];
  const spec = specOf(api, b.lm);
  if (!spec) return;
  const k = cam.lod || cam.k;
  api.setScreen(ctx, cam);
  if (spec.walls && k >= 0.6) paintWalls(api, ctx, r, k, i, 0);
  const items = itemsOf(api, i, r);
  if (!items.length) return;
  const snow = (style && style.snow) || 0;
  const outline = k >= 0.8, lineW = Math.min(0.12, 0.9 / k);
  ctx.lineJoin = "round";
  for (const it of items) {
    for (const fc of it.faces) {
      if (fc.minK && k < fc.minK) continue;
      if (fc.deck) {
        ctx.beginPath();
        for (const f of fc.deck) { ctx.moveTo(f[0], f[1]); for (let q = 2; q < f.length; q += 2) ctx.lineTo(f[q], f[q + 1]); ctx.closePath(); }
        ctx.fillStyle = snow > 0.15 ? mixd(api, fc.col, "#f6f8fa", Math.min(0.92, snow * 1.15)) : fc.col; ctx.fill("evenodd");
        continue;
      }
      fillPoly(ctx, fc.pts);
      const col = fc.kind === "roof" && snow > 0.15 ? mixd(api, fc.col, "#f6f8fa", Math.min(0.92, snow * 1.15)) : fc.col;
      ctx.fillStyle = col; ctx.fill();
      if (outline) { ctx.strokeStyle = shd(api, col, 0.72); ctx.lineWidth = lineW; ctx.stroke(); }
    }
    for (const d of it.details) {
      if (k < d.minK) continue;
      if (d.polys) fillBatched(ctx, d.polys);
      if (d.lines) {
        ctx.beginPath();
        for (const l of d.lines) { ctx.moveTo(l[0], l[1]); for (let q = 2; q < l.length; q += 2) ctx.lineTo(l[q], l[q + 1]); }
        ctx.strokeStyle = d.snowCol && snow > 0.3 ? "#eef1f3" : d.col;
        ctx.lineWidth = Math.max(d.w, 0.55 / k); ctx.lineCap = "round";
        if (d.alpha != null && d.alpha < 1) { const a = ctx.globalAlpha; ctx.globalAlpha = a * d.alpha; ctx.stroke(); ctx.globalAlpha = a; }
        else ctx.stroke();
      }
    }
  }
}

/** Night: lit windows / beacons of custom geometry, drawn by drawLights after the building's own lights. */
export function lights(api, ctx, r, cam, i, style) {
  const b = api.data.buildings[i];
  const spec = specOf(api, b.lm);
  if (!spec) return;
  const k = cam.lod || cam.k;
  api.setScreen(ctx, cam);
  const op = ctx.globalCompositeOperation;
  // the wall paint hides the windows it is painted over by day
  if (spec.walls && k >= 0.6) { ctx.globalCompositeOperation = "destination-out"; paintWalls(api, ctx, r, k, i, 1); }
  const items = itemsOf(api, i, r);
  // each piece, back to front, hides the lights behind it (its faces wound alike, one fill; a deck with its
  // courtyards apart), then shows its own
  for (const it of items) {
    if (!it.see) {
      ctx.globalCompositeOperation = "destination-out"; ctx.fillStyle = "#000";
      ctx.beginPath();
      let any = false;
      for (const fc of it.faces) {
        if (fc.deck) continue;
        const f = fc.blot || (fc.blot = orient(fc.pts));
        ctx.moveTo(f[0], f[1]); for (let q = 2; q < f.length; q += 2) ctx.lineTo(f[q], f[q + 1]); ctx.closePath();
        any = true;
      }
      if (any) ctx.fill("nonzero");
      for (const fc of it.faces) {
        if (!fc.deck) continue;
        ctx.beginPath();
        for (const f of fc.deck) { ctx.moveTo(f[0], f[1]); for (let q = 2; q < f.length; q += 2) ctx.lineTo(f[q], f[q + 1]); ctx.closePath(); }
        ctx.fill("evenodd");
      }
    }
    if (!it.glow.length) continue;
    ctx.globalCompositeOperation = "source-over";
    for (const g of it.glow) if (k >= g.minK) fillBatched(ctx, g.polys);
  }
  ctx.globalCompositeOperation = op;
}

/** The outlines of the extra geometry (convex hull per piece), appended to path in device pixels (see render.js silhouette). */
export function silhouette(api, path, r, cam, i) {
  const items = itemsOf(api, i, r);
  const s = cam.k, ox = cam.ox, oy = cam.oy;
  for (const it of items) {
    if (!it.sil) continue;
    for (const f of it.sil) {
      path.moveTo(f[0] * s - ox, f[1] * s - oy);
      for (let q = 2; q < f.length; q += 2) path.lineTo(f[q] * s - ox, f[q + 1] * s - oy);
      path.closePath();
    }
  }
  return path;
}
