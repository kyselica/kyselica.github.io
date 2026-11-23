// The illustration: draws map tiles (in a worker) and single objects (on the main thread, to put buildings and trees back
// in front of moving vehicles) from the projected scene. Everything is procedural Canvas2D: no images.
//
// A "camera" here is { k, ox, oy, lod? }: device pixels per screen metre and the pixel offset, so that
//   px = X·k − ox,  py = Y·k − oy        (X, Y in screen metres, see geo.js)
// lod is the scale of the tile level being matched: objects pick their level of detail from it (not from k), so an object
// redrawn over a moving vehicle is the very picture already in the tile beneath.
// Ground features are drawn in ground metres under an affine transform (setWorld), so widths, circles and textures are
// foreshortened like everything else. Buildings and trees are drawn in screen metres from their projected outlines.
//
// drawObject never changes the composite operation and never sets globalAlpha outright: callers draw objects with
// "destination-out" to rub out what stands behind them (buses.js), or with an alpha of their own. The paper wash is laid
// on the ground only, under the objects, so an object redrawn by app.occlude is pixel for pixel the one in the tile.
//
// For other modules (life.js clips cars and people out where something stands in front of them):
//   treeBare(t, style) → whether broad-leaved tree t (its index in data.trees / 5) stands bare in style.season
//     (late-autumn: ~72 % of them, by a hash of t; winter: all). Conifers never are.
//   silhouette(path, r, cam, id, style) → path. Appends scene object id's visible outline (as drawObject paints it at
//     cam.lod) in device pixels for cam { k, lod?, ox, oy } (px = X·k − ox, py = Y·k − oy, X/Y in screen metres):
//       building — its camera-facing walls and the solid outline of its roof (pitched: eaves and ridge; a stadium bowl:
//                  the facade and the rim all round, plus press box, scoreboard, rotunda), and from lod 2 its rooftop
//                  plant rooms and air handlers. Courtyards count as solid (nothing in one can be behind the building).
//       tree     — canopy and trunk (a conifer's tiered outline; a leafy crown's circles); a bare tree only its trunk;
//                  from afar (lod < 0.7) the single circle or triangle drawn there.
//       lamp     — post and lantern; nothing below lod 1.2 (lamps aren't drawn there).
//     Pieces overlap and all wind like ctx.rect(), so fill or clip with the "nonzero" rule. path may be a Path2D (crowns
//     are added exactly, with addPath) or a 2D context's current path (crowns fall back to their bounding circle).

export const TS = 512;   // tile size, device pixels
// Debugging aid for tools/profile.mjs --check (off in the app): which object, and which part of it (0 walls, 1 roof and
// what stands on it, 2 things in front of a wall, 3 night lights), is being painted right now, so a wrapped context can
// paint every building in its own flat colour and compare the night lights with the day tiles pixel by pixel.
export const DBG = { on: false, id: -1, part: 0 };

// ------------------------------------------------------------------------------------------------ colour helpers
const hexToRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rgbToHex = (c) => "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
export const shade = (h, f) => rgbToHex(hexToRgb(h).map((v) => v * f));
export const mix = (a, b, t) => { const A = hexToRgb(a), B = hexToRgb(b); return rgbToHex(A.map((v, i) => v + (B[i] - v) * t)); };
// Quantised, memoised versions for the hot paths: the same few hundred colours are asked for thousands of times a tile,
// and building a colour string each time is most of the cost of a small fill.
// (Keyed colour → table by the quantised step: no key string is built per call.)
const SHADES = new Map(), MIXES = new Map(), RGBAS = new Map();
function sh(h, f) {
  const q = Math.round(f * 50);
  let t = SHADES.get(h);
  if (t === undefined) SHADES.set(h, (t = []));
  let v = t[q];
  if (v === undefined) v = t[q] = shade(h, q / 50);
  return v;
}
function mx(a, b, t) {
  const q = Math.round(t * 40);
  if (q <= 0) return a;
  if (q >= 40) return b;
  let m = MIXES.get(a);
  if (m === undefined) MIXES.set(a, (m = new Map()));
  let tb = m.get(b);
  if (tb === undefined) m.set(b, (tb = []));
  let v = tb[q];
  if (v === undefined) v = tb[q] = mix(a, b, q / 40);
  return v;
}
function rgba(h, a) {
  const q = Math.round(a * 100);
  let t = RGBAS.get(h);
  if (t === undefined) RGBAS.set(h, (t = []));
  let v = t[q];
  if (v === undefined) { const c = hexToRgb(h); v = t[q] = `rgba(${c[0]},${c[1]},${c[2]},${q / 100})`; }
  return v;
}
const strHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
const nHash = (n) => { n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4); n = Math.imul(n, 0x27d4eb2d); n = n ^ (n >>> 15); return (n >>> 0) / 4294967296; };
const pick = (arr, h) => arr[Math.min(arr.length - 1, Math.floor(h * arr.length))];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const TAU = Math.PI * 2;
// a weighted pick: list of [value, weight]
function pickW(list, h) {
  let tot = 0;
  for (const it of list) tot += it[it.length - 1];
  let x = h * tot;
  for (const it of list) { x -= it[it.length - 1]; if (x < 0) return it; }
  return list[list.length - 1];
}

// ------------------------------------------------------------------------------------------------ palette
export const PAL = {
  bg: "#efe9db",
  land: "#e9e2cc", res: "#e8e0cb", com: "#e9dfd1", ind: "#e0dbd0", rel: "#e6ddca", campus: "#e6e2c9", cem: "#c7d6a2", farm: "#e1d9a8", cons: "#d4bd90",
  grass: "#bcd391", park: "#b6cf8b", meadow: "#c6d79c", garden: "#adca87", flower: "#b2cc88", scrub: "#a5c084", wood: "#97b87a", sand: "#ecdcab",
  water: "#8fc5d8", waterEdge: "#6aa3bb", pool: "#82d1e3", bank: "#b9b48c", shallow: "#a9d6e2",
  parking: "#b3b1ac", stall: "#f4f2ea", plaza: "#e6dcc6", plazaEdge: "#d2c6ad", roadArea: "#9a9b9e",
  pitch: "#8cc36b", turf: "#7dbd63", pitchLine: "#f6f6ee", track: "#c4654d", court: "#6f9fb4",
  road: "#8f9296", roadMajor: "#878a8f", motorway: "#7f8389", curb: "#dcd6c7", centre: "#efc94c", lane: "#f3f1ea",
  path: "#eee6d3", pathEdge: "#d5caB3".toLowerCase(), sidewalk: "#e7e2d6", pavers: "#dcc3a9", cycle: "#e6dac4", steps: "#ddd1b8", dirt: "#d3c49c",
  rail: "#6a6a6a", ballast: "#b9ae9c", tie: "#7d6a55",
  hedge: "#6e9a55", wall: "#bdb4a5", fence: "#7d766b",
  shadow: "#26323c",
  trunk: "#6b5442",
};
const BRICK = ["#b3563f", "#a94e3b", "#bd6549", "#b56a50", "#9f4b3a", "#c07152", "#a85a44", "#b8624a"];
const STONE = ["#dccdae", "#cfc09f", "#ddd3bc", "#cbba97", "#e2d8c2"];
const TRIM = ["#e8dcc0", "#ece3cf", "#dfd2b4", "#efe8d8"];
const MODERN = ["#c9c5bd", "#b4babd", "#d2cdc4", "#aab2b6", "#c3c5c2", "#bdb5a8"];
const GLASSWALL = ["#8ea5b2", "#98acb5", "#8199a8", "#a3b3b8"];
const HOUSE = ["#e8dcc0", "#d9c8a2", "#b9c7c0", "#a9b8c9", "#e0d6cb", "#c9a77f", "#b4775a", "#f0ebe0", "#9fb59a", "#d6b46e", "#c4cfd6", "#e3c9b0", "#c98f72", "#efe3c8"];
// asphalt shingles, mostly greys and browns, a few weathered reds, slate blues and greens (lit, they come out lighter)
const HOUSE_ROOF = ["#5b5450", "#6b5d55", "#4c4a4f", "#7a5a4c", "#58616b", "#6e665e", "#8a5a48", "#4f5a55", "#665a62",
  "#7d7571", "#8c8279", "#66717c", "#93604d", "#5f6b60", "#857a70"];
const APT = ["#c58f6e", "#d6c3a5", "#a87a62", "#bfb6a8", "#9c6b55", "#d9cbb6", "#b7a08a", "#b0644c"];
const COMM = ["#cdbb9c", "#b98d6a", "#c9c2b6", "#a6876c", "#d8cdb9", "#bfa98c", "#b25e48"];
const IND = ["#b8bcc0", "#a9a59c", "#c2bfb6", "#9fa6ab"];
const DOORS = ["#7a3b33", "#3f5a4a", "#2f3f5a", "#efece4", "#6b4a3a", "#8c2f2f", "#4a4f55"];
// flat roofs: [kind, colour, weight]
const FLAT_ROOFS = [["membrane", "#e5e2db", 26], ["membrane", "#d8d5ce", 18], ["gravel", "#b6b0a5", 16], ["gravel", "#a59f95", 9], ["tar", "#8f8c88", 9], ["metal", "#c5c9ca", 6], ["green", "#a3b57d", 5]];
// a few campus landmarks whose material everyone knows: [facade, wall, trim]
const LANDMARK_LOOK = new Map([
  ["William Oxley Thompson Memorial Library", ["stone", "#d9d2c1", "#efe9da"]],
  ["University Hall", ["brick", "#a64b39", "#e9dfc9"]],
  ["Orton Hall", ["stone", "#c7ae86", "#e6d9bd"]],
  // the twin dormitory towers by the river, in the same brown brick
  ["Morrill Tower", ["brick", "#9e5844", "#e3d6bc"]],
  ["Lincoln Tower", ["brick", "#9e5844", "#e3d6bc"]],
]);
// pitched roofs on the parts of big campus buildings: slate, weathered copper, old tile
const PART_ROOF = ["#5f6567", "#6c7173", "#77867f", "#55605f", "#7a5c50", "#6f8a80"];
const HOUSE_FLAT = [["tar", "#8a8580", 3], ["membrane", "#cfcbc3", 2], ["gravel", "#a8a297", 2]];
const CAMPUS_KINDS = new Set(["university", "college", "school", "dormitory", "civic", "public", "government", "library", "sports_centre", "sports_hall", "museum", "theatre", "kindergarten", "train_station", "transportation", "pavilion"]);
const HOUSE_KINDS = new Set(["house", "detached", "semidetached_house", "terrace", "residential", "bungalow", "duplex"]);
const SMALL_KINDS = new Set(["garage", "garages", "shed", "carport", "hut", "kiosk", "roof", "shelter", "toilets", "service", "transformer_tower", "storage_tank", "farm_auxiliary"]);
const STREETS = new Set(["residential", "tertiary", "secondary", "primary", "unclassified", "living_street", "trunk"]);

const LEAF = {
  summer: ["#5f8f4a", "#6e9a4e", "#55864a", "#79a457", "#4d7c46", "#668f3f"],
  spring: ["#8fbf5f", "#9ccb68", "#7fb35a", "#a9d07a", "#86b65e"],
  autumn: ["#c9772f", "#d9a13b", "#b5532f", "#a8742e", "#d68a35", "#9d8a3a", "#c4612e"],
  "late-autumn": ["#9a5f36", "#a8743f", "#8a5a3a", "#b08045", "#8f6a3e"],   // the oaks that hold their brown leaves
};
const BLOSSOM = ["#efc6d2", "#f3eee4", "#e9b3c4"];
const REMNANT = ["#b5773e", "#a8683a", "#c08a4a", "#9c6a3c"];
const NEEDLE = ["#3f6b4a", "#47734f", "#36603f", "#4a6e52", "#3b6550"];
// parked-car paint, weighted like real fleets (as life.js paints the moving ones)
const PAINT = [["#ecebe6", 22], ["#34373c", 18], ["#767b80", 14], ["#b9bdc0", 13], ["#3f5f86", 8], ["#a8342e", 8], ["#2c3d57", 3],
  ["#b3202a", 1.6], ["#465f4e", 2], ["#8a7058", 2.2], ["#8fa8bf", 1.4], ["#d29b3f", 0.6], ["#e3ddcc", 2]];

// ------------------------------------------------------------------------------------------------ plane geometry
function ringArea(f) {
  let a = 0;
  for (let i = 0, n = f.length; i < n; i += 2) { const j = (i + 2) % n; a += f[i] * f[j + 1] - f[j] * f[i + 1]; }
  return a / 2;
}
function ringBox(f) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < f.length; i += 2) { if (f[i] < x0) x0 = f[i]; if (f[i] > x1) x1 = f[i]; if (f[i + 1] < y0) y0 = f[i + 1]; if (f[i + 1] > y1) y1 = f[i + 1]; }
  return [x0, y0, x1, y1];
}
function ringCentroid(f) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = f.length; i < n; i += 2) {
    const j = (i + 2) % n, c = f[i] * f[j + 1] - f[j] * f[i + 1];
    a += c; cx += (f[i] + f[j]) * c; cy += (f[i + 1] + f[j + 1]) * c;
  }
  if (Math.abs(a) < 1e-9) { const b = ringBox(f); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }
  return [cx / (3 * a), cy / (3 * a)];
}
function ptInRing(f, x, y) {
  let inside = false;
  for (let i = 0, n = f.length, j = n - 2; i < n; j = i, i += 2) {
    const xi = f[i], yi = f[i + 1], xj = f[j], yj = f[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// inside a polygon with holes (even-odd over all its rings)
function ptInRings(rings, x, y) {
  let inside = false;
  for (const f of rings) if (ptInRing(f, x, y)) inside = !inside;
  return inside;
}
function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / L2, 0, 1) : 0;
  const ex = ax + dx * t - px, ey = ay + dy * t - py;
  return ex * ex + ey * ey;
}
function lineDist(f, x, y) {
  let d = Infinity;
  for (let i = 2; i < f.length; i += 2) { const q = segDist2(x, y, f[i - 2], f[i - 1], f[i], f[i + 1]); if (q < d) d = q; }
  return Math.sqrt(d);
}
// distance from (x, y) to the nearest edge of any ring
function ringsEdgeDist(rings, x, y) {
  let d = Infinity;
  for (const f of rings) for (let i = 0, n = f.length, j = n - 2; i < n; j = i, i += 2) { const q = segDist2(x, y, f[j], f[j + 1], f[i], f[i + 1]); if (q < d) d = q; }
  return Math.sqrt(d);
}
// the farthest crossing of the ray from (cx, cy) along (dx, dy) with a ring, or -1
function rayFar(f, cx, cy, dx, dy) {
  let best = -1;
  for (let i = 0, n = f.length, j = n - 2; i < n; j = i, i += 2) {
    const ax = f[j] - cx, ay = f[j + 1] - cy, ex = f[i] - f[j], ey = f[i + 1] - f[j + 1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = (ax * ey - ay * ex) / den, s = (ax * dy - ay * dx) / den;
    if (t > 0 && s >= 0 && s <= 1 && t > best) best = t;
  }
  return best;
}
// minimum-area rectangle of a ring: { cx, cy, ang, L, W } (L along ang)
export function obbOf(f) {
  let best = null;
  const n = f.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ang = Math.atan2(f[2 * j + 1] - f[2 * i + 1], f[2 * j] - f[2 * i]);
    const c = Math.cos(ang), s = Math.sin(ang);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let q = 0; q < n; q++) { const u = f[2 * q] * c + f[2 * q + 1] * s, v = -f[2 * q] * s + f[2 * q + 1] * c; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }
    const A = (u1 - u0) * (v1 - v0);
    if (!best || A < best.A) { const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2; best = { A, cx: uc * c - vc * s, cy: uc * s + vc * c, ang, L: u1 - u0, W: v1 - v0 }; }
  }
  if (best && best.W > best.L) { best.ang += Math.PI / 2; [best.L, best.W] = [best.W, best.L]; }
  return best;
}
function hull2(p) {
  p.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
// a polyline moved sideways by d metres (left of travel for d > 0)
function offsetLine(f, d) {
  const n = f.length / 2, o = new Array(f.length);
  for (let i = 0; i < n; i++) {
    const ax = f[2 * Math.max(0, i - 1)], ay = f[2 * Math.max(0, i - 1) + 1], bx = f[2 * Math.min(n - 1, i + 1)], by = f[2 * Math.min(n - 1, i + 1) + 1];
    let nx = -(by - ay), ny = bx - ax;
    const L = Math.hypot(nx, ny) || 1;
    nx /= L; ny /= L;
    o[2 * i] = f[2 * i] + nx * d; o[2 * i + 1] = f[2 * i + 1] + ny * d;
  }
  return o;
}
// a small deterministic random stream (templates and placements must come out the same in every worker)
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// ------------------------------------------------------------------------------------------------ renderer
import * as LM from "./landmarks.js";

export function makeRenderer(scene) {
  const { data, geo } = scene;
  const { SIN_T: S, COS_T: C } = geo;
  // the shadow of 1 m of height, as a ground vector in the camera's own (u, v) frame: to the right and a little back
  const SH_U = 0.62, SH_V = 0.36;
  const LIGHT_U = -0.85, LIGHT_V = -0.52;   // direction toward the light (unit-ish), same frame
  const canMakeCanvas = typeof OffscreenCanvas !== "undefined";
  const hasMatrix = typeof DOMMatrix !== "undefined";
  const B = scene.B, T = scene.T;
  let currentStyle = { season: "summer", snow: 0 };

  const setScreen = (ctx, cam) => ctx.setTransform(cam.k, 0, 0, cam.k, -cam.ox, -cam.oy);
  const setWorld = (ctx, cam, r, z = 0) => {
    const o = geo.ROTS[r], k = cam.k;
    ctx.setTransform(k * o.R[0], -k * S * o.D[0], k * o.R[1], -k * S * o.D[1], -cam.ox, -cam.oy - k * C * z);
  };
  const ringPath = (ctx, f) => {
    ctx.moveTo(f[0], f[1]);
    for (let i = 2; i < f.length; i += 2) ctx.lineTo(f[i], f[i + 1]);
    ctx.closePath();
  };
  const linePath = (ctx, f) => {
    ctx.moveTo(f[0], f[1]);
    for (let i = 2; i < f.length; i += 2) ctx.lineTo(f[i], f[i + 1]);
  };
  const lightOf = (nu, nd) => Math.max(0, -(nu * LIGHT_U + nd * LIGHT_V));
  // screen metres of ground point (x, y) at height z, for rotation r, into out[o], out[o + 1]
  function projInto(out, o, x, y, z, rot) {
    const R = geo.ROTS[rot];
    out[o] = x * R.R[0] + y * R.R[1];
    out[o + 1] = -((x * R.D[0] + y * R.D[1]) * S + z * C);
  }
  const depthOf = (x, y, r) => x * geo.ROTS[r].D[0] + y * geo.ROTS[r].D[1];
  // indexes of one kind of feature near a ground rectangle (the scene indexes screen boxes, so ask for the rectangle's)
  function nearGround(r, name, x0, y0, x1, y1) {
    const o = geo.ROTS[r];
    let X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity;
    for (let c = 0; c < 4; c++) {
      const x = c & 1 ? x1 : x0, y = c & 2 ? y1 : y0;
      const X = x * o.R[0] + y * o.R[1], Y = -(x * o.D[0] + y * o.D[1]) * S;
      if (X < X0) X0 = X; if (X > X1) X1 = X; if (Y < Y0) Y0 = Y; if (Y > Y1) Y1 = Y;
    }
    return scene.query(r, name, X0, Y0, X1, Y1);
  }

  // ================================================================ per-building look (stable: from its id)
  const buildingStyle = new Map();
  function styleOf(i) {
    let st = buildingStyle.get(i);
    if (st) return st;
    const b = data.buildings[i];
    const h1 = strHash(b.id), h2 = strHash(b.id + "r"), h3 = strHash(b.id + "w"), h4 = strHash(b.id + "x");
    const k = b.k;
    const area = Math.abs(ringArea(b.p[0]));
    st = {
      kind: "campus", facade: "brick", wall: "#b3563f", roof: "#d8d5ce", roofKind: "membrane", trim: null, glass: "#3e4a57", frame: null,
      fh: 4, spacing: 3, winW: 0.45, z0f: 0.28, z1f: 0.8, cornice: false, plinth: false, string: false, siding: false,
      hvac: 0, skylights: false, solar: false, penthouse: false, h1, h2, h3, h4, area,
    };
    const flatRoof = (list) => { const fr = pickW(list, h2); st.roofKind = fr[0]; st.roof = fr[1]; };
    // Simple-3D-building parts are drawn in place of their (hidden) outline, so they wear its look: a library drawn as
    // a podium, a stack tower and wings stays one building in one material (not a row of sided houses, which is what a
    // gabled part of kind "yes" would otherwise become). Canopies (building:part=roof) keep their own.
    const pi = b.part && k !== "roof" ? parentOf(i) : -1;
    const ps = pi >= 0 ? styleOf(pi) : null;
    if (ps && ps.kind !== "bowl" && ps.kind !== "bleachers") {
      st = { ...ps, h1, h2, h3, h4, area };
      if (b.roof && b.roof !== "flat" && b.obb) { st.roof = pick(PART_ROOF, ps.h2); st.roofKind = "tar"; }
      // only big parts carry rooftop plant
      if (area < 300) { st.hvac = 0; st.penthouse = false; st.solar = false; st.skylights = false; }
      else st.penthouse = st.penthouse && b.h > 14;
    } else if (b.lm === "Ohio Stadium" || ((k === "stadium" || k === "grandstand") && b.p.length > 1 && area > 3000)) {
      st.kind = "bowl"; st.facade = "bowl"; st.wall = b.lm === "Ohio Stadium" ? "#dccfb2" : "#cfc6b5"; st.roof = "#d6cdbb";
    } else if (k === "grandstand" || (k === "stadium" && area < 2500)) {
      st.kind = "bleachers"; st.facade = "bleachers"; st.wall = "#c9c1b2"; st.roof = "#b9b6b0";
    } else if (k === "stadium") {
      st.kind = "campus"; st.facade = "arena"; st.wall = pick(["#c98f6e", "#d8cdb6", "#b86b52"], h1); st.trim = "#e6dcc6";
      st.roofKind = "metal"; st.roof = "#d3d5d2"; st.fh = 6; st.spacing = 5; st.winW = 0.35; st.z0f = 0.35; st.z1f = 0.85; st.cornice = true; st.hvac = 0.3;
    } else if (HOUSE_KINDS.has(k) || (k === "yes" && b.roof && b.roof !== "flat")) {
      houseLook(st, h1, h2, h3);
    } else if (k === "apartments") {
      st.kind = "apt"; st.facade = "apt"; st.wall = pick(APT, h1); flatRoof([["tar", "#8f8b86", 3], ["membrane", "#d6d2ca", 3], ["gravel", "#aaa398", 3]]);
      st.fh = 3.2; st.spacing = 2.9 + h3 * 0.6; st.winW = 0.42; st.z0f = 0.3; st.z1f = 0.78; st.glass = "#424e5b"; st.frame = "#ece7dc";
      st.cornice = h3 < 0.45; st.trim = "#e6dcc6"; st.hvac = 0.4; st.solar = h4 < 0.06;
    } else if (k === "parking") {
      st.kind = "parking"; st.facade = "parking"; st.wall = mix("#cbc8c0", "#b9b6ae", h1); st.roof = "#a9a8a4"; st.roofKind = "deck"; st.fh = 3.1;
    } else if (k === "hospital" || k === "clinic") {
      st.kind = "hospital"; st.facade = h3 < 0.5 ? "ribbon" : "hospital"; st.wall = pick(["#dcd7cd", "#cfc9bd", "#c3c7c9", "#e1ddd3"], h1);
      flatRoof(FLAT_ROOFS); st.fh = 4.3; st.spacing = 2.6; st.winW = 0.55; st.z0f = 0.3; st.z1f = 0.82; st.glass = "#566c7c"; st.hvac = 1.2; st.penthouse = true;
    } else if (k === "church" || k === "chapel" || k === "cathedral") {
      st.facade = "church"; st.wall = h1 < 0.6 ? pick(STONE, h1 / 0.6) : pick(BRICK, (h1 - 0.6) / 0.4); st.trim = "#e9e0cc";
      st.roof = pick(HOUSE_ROOF, h2); st.roofKind = "tar"; st.fh = 7; st.spacing = 3.6; st.winW = 0.34; st.z0f = 0.18; st.z1f = 0.86; st.glass = "#4b4f6a"; st.cornice = true;
    } else if (k === "greenhouse") {
      st.facade = "curtain"; st.wall = "#b9cdc8"; st.roof = "#c9dcd6"; st.roofKind = "glass"; st.glass = "#9fbab6"; st.fh = 3;
    } else if (CAMPUS_KINDS.has(k) || k === "yes" && b.n && area > 400) {
      campusLook(st, h1, h2, h3, h4, b);
    } else if (k === "commercial" || k === "retail" || k === "office" || k === "hotel" || k === "supermarket") {
      st.kind = "comm"; st.facade = "comm"; st.wall = pick(COMM, h1); flatRoof(FLAT_ROOFS);
      st.fh = 4; st.spacing = 3.2; st.winW = 0.5; st.z0f = 0.3; st.z1f = 0.8; st.glass = "#4d6273"; st.trim = "#e2d6bd"; st.cornice = h3 < 0.5; st.hvac = 1; st.skylights = h4 < 0.15;
    } else if (k === "industrial" || k === "warehouse" || k === "manufacture" || k === "service") {
      st.kind = "ind"; st.facade = "ind"; st.wall = pick(IND, h1); flatRoof([["metal", "#c4c7c8", 3], ["membrane", "#d9d6cf", 2], ["gravel", "#aaa49a", 2]]);
      st.fh = 5; st.spacing = 6; st.winW = 0.3; st.z0f = 0.6; st.z1f = 0.85; st.hvac = 0.6; st.skylights = h4 < 0.4;
    } else if (SMALL_KINDS.has(k)) {
      st.kind = "small"; st.facade = "small"; st.wall = pick(["#d9d2c2", "#c9bfae", "#bfb6a6", "#e2dccf", "#b9a58c"], h1); st.roof = pick(HOUSE_ROOF, h2); st.roofKind = "tar"; st.fh = 3;
      if (!b.roof || b.roof === "flat") st.roof = pick(["#8f8a84", "#a09a92", "#7f7b77"], h2);
    } else if (k === "dormitory") {
      campusLook(st, h1, h2, h3, h4, b);
    } else {
      // unlabelled: small ones look like houses, big ones like campus or commercial blocks
      if (area < 300) houseLook(st, h1, h2, h3);
      else if (h1 < 0.5) campusLook(st, h1 * 2 * 0.62, h2, h3, h4, b);
      else { st.kind = "comm"; st.facade = "comm"; st.wall = pick(COMM, (h1 - 0.5) * 2); flatRoof(FLAT_ROOFS); st.fh = 4; st.spacing = 3; st.winW = 0.48; st.glass = "#4d6273"; st.hvac = 0.8; st.trim = "#e2d6bd"; }
    }
    const lm = b.n ? LANDMARK_LOOK.get(b.n) : null;
    if (lm && !ps) { campusLook(st, lm[0] === "stone" ? 0.6 : 0.3, h2, h3, h4, b); st.wall = lm[1]; st.trim = lm[2]; }
    // LANDMARK HOOK (look): landmarks.js may override any of the style fields
    if (b.lm != null) { const ov = LM.look(api, b, st); if (ov) Object.assign(st, ov); }
    if (b.c) st.wall = b.c;
    if (b.rc) st.roof = b.rc;
    if (b.mat === "brick" && !b.c) { st.wall = pick(BRICK, h1); if (st.facade === "modern" || st.facade === "curtain") st.facade = "brick"; }
    if ((b.mat === "glass" || b.mat === "metal") && !b.c) st.wall = mix(pick(MODERN, h1), "#7e97a6", 0.3);
    if (!st.trim) st.trim = sh(st.wall, 1.25);
    buildingStyle.set(i, st);
    return st;
  }
  // the innermost hidden outline a building part stands in (by its centroid), or -1
  let hiddenList = null;
  const parents = new Map();
  function parentOf(i) {
    let p = parents.get(i);
    if (p !== undefined) return p;
    if (!hiddenList) {
      hiddenList = [];
      data.buildings.forEach((b, j) => { if (b.hidden) hiddenList.push([j, ringBox(b.p[0])]); });
    }
    const [cx, cy] = ringCentroid(data.buildings[i].p[0]);
    p = -1;
    let best = Infinity;
    for (const [j, bb] of hiddenList) {
      if (cx < bb[0] || cx > bb[2] || cy < bb[1] || cy > bb[3] || !ptInRing(data.buildings[j].p[0], cx, cy)) continue;
      const a = (bb[2] - bb[0]) * (bb[3] - bb[1]);
      if (a < best) { best = a; p = j; }
    }
    parents.set(i, p);
    return p;
  }
  function houseLook(st, h1, h2, h3) {
    st.kind = "house"; st.facade = "house"; st.wall = pick(HOUSE, h1); st.roof = pick(HOUSE_ROOF, h2);
    const fr = pickW(HOUSE_FLAT, h2); st.roofKind = fr[0];
    st.fh = 3.2; st.spacing = 3.3; st.winW = 0.36; st.z0f = 0.32; st.z1f = 0.8; st.glass = "#465462"; st.frame = "#f4f1ea";
    st.siding = h3 < 0.62; st.trim = "#f2eee6";
  }
  function campusLook(st, h1, h2, h3, h4, b) {
    st.kind = "campus";
    const flatRoof = (list) => { const fr = pickW(list, h2); st.roofKind = fr[0]; st.roof = fr[1]; };
    flatRoof(FLAT_ROOFS);
    st.hvac = 1; st.skylights = h4 > 0.12 && h4 < 0.3; st.solar = h4 < 0.1; st.penthouse = b.h > 14;
    if (h1 < 0.58) {
      st.facade = "brick"; st.wall = pick(BRICK, h1 / 0.58); st.trim = pick(TRIM, h3); st.cornice = true; st.plinth = true; st.string = h3 < 0.5;
      st.fh = 4.2; st.spacing = 2.6 + h3 * 0.9; st.winW = 0.42 + h3 * 0.1; st.z0f = 0.26; st.z1f = 0.82; st.glass = "#3e4a57"; st.frame = "#efe8d8";
    } else if (h1 < 0.76) {
      st.facade = "stone"; st.wall = pick(STONE, (h1 - 0.58) / 0.18); st.trim = "#efe7d3"; st.cornice = true; st.plinth = true; st.string = h3 < 0.3;
      st.fh = 4.4; st.spacing = 2.9 + h3 * 0.8; st.winW = 0.44; st.z0f = 0.24; st.z1f = 0.84; st.glass = "#3c4753"; st.frame = "#f3eee2";
    } else if (h1 < 0.92) {
      st.facade = "ribbon"; st.wall = pick(MODERN, (h1 - 0.76) / 0.16); st.trim = sh(st.wall, 1.12);
      st.fh = 4.2; st.z0f = 0.34; st.z1f = 0.86; st.glass = "#56707f";
    } else {
      st.facade = "curtain"; st.wall = pick(GLASSWALL, (h1 - 0.92) / 0.08); st.trim = "#d7dcdc"; st.fh = 4.2; st.glass = "#6f8a9a";
    }
  }

  // ================================================================ caches of derived geometry
  const obbCache = new Map();
  function obbFor(i) {
    let o = obbCache.get(i);
    if (o !== undefined) return o;
    const b = data.buildings[i];
    o = b.obb ? { cx: b.obb[0], cy: b.obb[1], ang: b.obb[2], L: b.obb[3], W: b.obb[4] } : obbOf(b.p[0]);
    obbCache.set(i, o);
    return o;
  }
  // wall faces of a building that face the viewer, far ones first: [{ri, c, a, L, nx, ny, nu, nd, light}]
  const wallCache = new Map();
  function visibleWalls(i, r) {
    const key = i * 4 + r;
    let out = wallCache.get(key);
    if (out) return out;
    const b = data.buildings[i];
    const o = geo.ROTS[r];
    out = [];
    b.p.forEach((f, ri) => {
      const n = f.length / 2;
      for (let a = 0, c = n - 1; a < n; c = a++) {
        const ax = f[2 * c], ay = f[2 * c + 1], bx = f[2 * a], by = f[2 * a + 1];
        const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
        if (L < 0.05) continue;
        const nx = dy / L, ny = -dx / L;     // outward for CCW outers and CW holes
        const nd = nx * o.D[0] + ny * o.D[1];
        if (nd >= -0.001) continue;
        const nu = nx * o.R[0] + ny * o.R[1];
        const u1 = ax * o.R[0] + ay * o.R[1], u2 = bx * o.R[0] + by * o.R[1];
        out.push({ ri, c, a, L, nx, ny, nu, nd, light: lightOf(nu, nd), depth: ((ax + bx) / 2) * o.D[0] + ((ay + by) / 2) * o.D[1],
          u1, v1: ax * o.D[0] + ay * o.D[1], u2, v2: bx * o.D[0] + by * o.D[1] });
      }
    });
    out.sort((p, q) => q.depth - p.depth);
    wallCache.set(key, orderWalls(out));
    return wallCache.get(key);
  }
  // Far to near by the middles is not always back to front: a short wall can sit in front of the far end of a long one
  // whose middle is nearer (a notch, the arm of an L). Two walls that share some of the screen are ordered by which is
  // nearer where they overlap (the edges of a footprint never cross, so this never loops); the rest keep the middles'
  // order.
  // (`overlap` on the result: whether any two of the walls share some of the screen; when none do, as round any convex
  // footprint, the night lights can rub out all the walls at once and light all their windows in one go)
  function orderWalls(w) {
    const n = w.length;
    w.overlap = false;
    if (n < 2) return w;
    const after = new Array(n), indeg = new Int32Array(n);
    let any = false;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const A = w[p], Q = w[q];
      const lo = Math.max(Math.min(A.u1, A.u2), Math.min(Q.u1, Q.u2)), hi = Math.min(Math.max(A.u1, A.u2), Math.max(Q.u1, Q.u2));
      if (hi - lo < 0.02) continue;
      w.overlap = true;
      const u = (lo + hi) / 2;
      const va = A.v1 + ((A.v2 - A.v1) * (u - A.u1)) / (A.u2 - A.u1), vq = Q.v1 + ((Q.v2 - Q.v1) * (u - Q.u1)) / (Q.u2 - Q.u1);
      // the farther one first
      const [first, then] = va >= vq ? [p, q] : [q, p];
      if (first > then) any = true;
      (after[first] || (after[first] = [])).push(then);
      indeg[then]++;
    }
    if (!any) return w;
    const out = [], ready = [];
    for (let p = 0; p < n; p++) if (!indeg[p]) ready.push(p);
    while (out.length < n) {
      if (!ready.length) for (let p = 0; p < n; p++) if (indeg[p] >= 0) { ready.push(p); break; }   // (a degenerate loop)
      // the farthest of the walls that are free to go
      let bi = 0;
      for (let k = 1; k < ready.length; k++) if (ready[k] < ready[bi]) bi = k;
      const p = ready.splice(bi, 1)[0];
      indeg[p] = -1;
      out.push(w[p]);
      if (after[p]) for (const q of after[p]) if (indeg[q] > 0 && --indeg[q] === 0) ready.push(q);
    }
    out.overlap = true;
    return out;
  }
  const idInt = new Map();
  function strHashInt(s) { let v = idInt.get(s); if (v == null) { v = Math.floor(strHash(s) * 1e9); idInt.set(s, v); } return v; }

  // The front of a house: the side of its rectangle nearest a street (not an alley: back yards run onto those).
  const fronts = new Map();
  function frontOf(i, r) {
    let f = fronts.get(i);
    if (f !== undefined) return f;
    f = null;
    const o = obbFor(i);
    if (o && o.L > 3) {
      const ux = Math.cos(o.ang), uy = Math.sin(o.ang), vx = -uy, vy = ux;
      // every road within 40 m of the middle, whatever the rotation: only nearer ones count, so all rotations agree
      const ids = nearGround(r, "roads", o.cx - 40, o.cy - 40, o.cx + 40, o.cy + 40);
      let best = 28;
      for (const [nx, ny, d] of [[ux, uy, o.L / 2], [-ux, -uy, o.L / 2], [vx, vy, o.W / 2], [-vx, -vy, o.W / 2]]) {
        const px = o.cx + nx * d, py = o.cy + ny * d;
        for (const ri of ids) {
          const rd = data.roads[ri];
          if (!STREETS.has(rd.k) || rd.tn || rd.br) continue;
          const dd = lineDist(rd.pts, px, py);
          // [direction out of the front, distance from that side's middle to the street's centre line, its width]
          if (dd < best - 0.01) { best = dd; f = [nx, ny, dd, rd.w]; }
        }
      }
    }
    fronts.set(i, f);
    return f;
  }

  // A house's front walk: from its front door (where drawWindows puts it, on the longest wall facing the street) straight
  // out to the sidewalk. [x0, y0, x1, y1] in ground metres, or null.
  const walks = new Map();
  function frontWalk(i, r) {
    let w = walks.get(i);
    if (w !== undefined) return w;
    w = null;
    const b = data.buildings[i], st = styleOf(i), front = st.kind === "house" ? frontOf(i, r) : null;
    if (front) {
      const f = b.p[0], n = f.length / 2;
      let best = null;
      for (let a = 0, c = n - 1; a < n; c = a++) {
        const dx = f[2 * a] - f[2 * c], dy = f[2 * a + 1] - f[2 * c + 1], L = Math.hypot(dx, dy);
        if (L < 4.5) continue;
        const nx = dy / L, ny = -dx / L;
        if (nx * front[0] + ny * front[1] > 0.8 && (!best || L > best.L)) best = { c, a, L, nx, ny };
      }
      const len = front[2] - front[3] / 2 - 2.6;
      if (best && len > 0.8 && len < 16) {
        const count = Math.max(1, Math.floor(best.L / st.spacing)), pad = (best.L - count * st.spacing) / 2 / best.L, span = st.spacing / best.L;
        const t = pad + span * (Math.floor(count / 2) + 0.5);
        const x = f[2 * best.c] + (f[2 * best.a] - f[2 * best.c]) * t, y = f[2 * best.c + 1] + (f[2 * best.a + 1] - f[2 * best.c + 1]) * t;
        w = new Float32Array([x, y, x + best.nx * len, y + best.ny * len]);
      }
    }
    walks.set(i, w);
    return w;
  }
  function drawFrontWalks(ctx, r, X0, Y0, X1, Y1, G) {
    const ids = scene.query(r, "objects", X0 - 16, Y0 - 16, X1 + 16, Y1 + 16);
    ctx.beginPath();
    let any = false;
    for (const i of ids) {
      if (i >= B || data.buildings[i].hidden) continue;
      const w = frontWalk(i, r);
      if (!w) continue;
      ctx.moveTo(w[0], w[1]); ctx.lineTo(w[2], w[3]);
      any = true;
    }
    if (!any) return;
    ctx.lineCap = "butt"; ctx.lineWidth = 1.1; ctx.strokeStyle = G.sidewalk; ctx.stroke();
  }

  // ================================================================ tiles
  function renderTile(ctx, r, z, tx, ty, style, layer) {
    const k = Math.pow(2, z);
    const cam = { k, ox: tx * TS, oy: ty * TS };
    currentStyle = style || currentStyle;
    const X0 = (tx * TS) / k, Y0 = (ty * TS) / k, X1 = ((tx + 1) * TS) / k, Y1 = ((ty + 1) * TS) / k;
    if (DBG.on) DBG.id = -1;
    ctx.save();
    if (layer === "lights") drawLights(ctx, r, cam, X0, Y0, X1, Y1, style || currentStyle);
    else drawBase(ctx, r, cam, X0, Y0, X1, Y1, style || currentStyle);
    ctx.restore();
  }

  function worldClip(ctx, cam, r) {
    const w = data.world;
    setWorld(ctx, cam, r);
    ctx.beginPath(); ctx.rect(w.x0, w.y0, w.x1 - w.x0, w.y1 - w.y0); ctx.clip();
  }
  // the ground rectangle a screen-metre rectangle shows (at z = 0)
  function groundBox(r, X0, Y0, X1, Y1) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let c = 0; c < 4; c++) {
      const [x, y] = geo.unproj(c & 1 ? X1 : X0, c & 2 ? Y1 : Y0, r, 0);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return [x0, y0, x1, y1];
  }

  // colours of the ground for a season and a depth of snow
  const groundCols = new Map();
  function groundStyle(season, snow) {
    const key = season + "|" + snow;
    let G = groundCols.get(key);
    if (G) return G;
    const turn = { summer: null, spring: ["#b2d986", 0.3], autumn: ["#cdd08e", 0.18], "late-autumn": ["#cfc995", 0.3], winter: ["#d2cca6", 0.48] }[season] || null;
    const green = (c) => (turn ? mix(c, turn[0], turn[1]) : c);
    const snowy = (c, f = 1) => (snow > 0 ? mix(c, "#f4f6f8", Math.min(0.88, snow * f)) : c);
    G = { snow, season };
    for (const key2 of ["land", "res", "com", "ind", "rel", "campus", "farm", "cons"]) G[key2] = snowy(PAL[key2], 0.9);
    for (const key2 of ["grass", "park", "meadow", "garden", "flower", "scrub", "wood", "cem", "pitch"]) G[key2] = snowy(green(PAL[key2]), 1);
    G.turf = snowy(PAL.turf, 0.3);                     // artificial turf is cleared and stays green
    G.sand = snowy(PAL.sand, 0.9);
    G.water = snow > 0.6 ? mix(PAL.water, "#e3eef2", 0.45) : PAL.water;
    G.pool = snow > 0.4 ? mix(PAL.pool, "#e3eef2", 0.5) : PAL.pool;
    G.bank = snowy(PAL.bank, 0.8); G.shallow = PAL.shallow; G.waterEdge = PAL.waterEdge;
    G.parking = snowy(PAL.parking, 0.35); G.plaza = snowy(PAL.plaza, 0.6); G.plazaEdge = snowy(PAL.plazaEdge, 0.5); G.roadArea = snowy(PAL.roadArea, 0.35);
    G.track = snowy(PAL.track, 0.4); G.court = snowy(PAL.court, 0.5); G.bridge = snowy("#cfc8bb", 0.5);
    G.road = snowy(PAL.road, 0.3); G.roadMajor = snowy(PAL.roadMajor, 0.25); G.motorway = snowy(PAL.motorway, 0.25); G.curb = snowy(PAL.curb, 0.6);
    G.path = snowy(PAL.path, 0.5); G.sidewalk = snowy(PAL.sidewalk, 0.45); G.pavers = snowy(PAL.pavers, 0.5); G.cycle = snowy(PAL.cycle, 0.5);
    G.steps = snowy(PAL.steps, 0.5); G.dirt = snowy(PAL.dirt, 0.7); G.pathEdge = snowy(PAL.pathEdge, 0.5);
    G.hedge = snowy(season === "winter" ? "#78905e" : PAL.hedge, 0.5);
    // house lawns: the park grass a little dulled toward the paper, so neighbourhoods read leafy but quieter than parks
    G.yard = snowy(green(mix(PAL.grass, PAL.res, 0.14)), 1);
    G.flowers = season === "summer" || season === "spring" ? 1 : season === "autumn" ? 0.45 : 0;
    G.litter = snow > 0.3 ? 0 : season === "autumn" ? 0.22 : season === "late-autumn" ? 0.34 : 0;
    groundCols.set(key, G);
    return G;
  }

  function drawBase(ctx, r, cam, X0, Y0, X1, Y1, style) {
    const k = cam.k, w = data.world;
    const prof = style.__prof || null;
    let tp = prof ? performance.now() : 0;
    const lap = (name) => { if (!prof) return; const t = performance.now(); prof[name] = (prof[name] || 0) + t - tp; tp = t; };
    const m = 4 + 8 / k;
    const q = (name, pad = m) => scene.query(r, name, X0 - pad, Y0 - pad, X1 + pad, Y1 + pad);
    const G = groundStyle(style.season || "summer", style.snow || 0);
    const gb = groundBox(r, X0 - m, Y0 - m, X1 + m, Y1 + m);
    const objIds = scene.query(r, "objects", X0 - 2, Y0 - 2, X1 + 2, Y1 + 2);

    // ground: everything on the world's top face is clipped to it
    ctx.save();
    worldClip(ctx, cam, r);
    ctx.fillStyle = G.land;
    ctx.fillRect(w.x0, w.y0, w.x1 - w.x0, w.y1 - w.y0);
    ctx.lineJoin = "round";

    // areas, in priority order (the data is sorted): land use first, then lawns round the houses (OSM rarely maps
    // yards), then everything else (lots, plazas and gardens cover the lawns)
    let yards = false;
    const underlay = () => {
      drawYards(ctx, r, X0, Y0, X1, Y1, k, G);
      // the floor of a stadium bowl is all turf, round the marked field
      for (const i of objIds) if (i < B && styleOf(i).kind === "bowl") bowlFloor(ctx, i, G);
      yards = true;
    };
    const areaIds = q("areas");
    for (const i of areaIds) {
      if (!yards && !LANDUSE.has(data.areas[i].k)) underlay();
      drawArea(ctx, i, k, G, gb, cam, r);
    }
    if (!yards) underlay();
    lap("areas");

    // streams and the river's centre line
    for (const i of q("waterways")) {
      const f = data.waterways[i];
      if (f.k === "river" && f.w > 10) continue;   // the river is drawn by its area
      ctx.beginPath(); linePath(ctx, f.pts);
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.strokeStyle = G.bank; ctx.lineWidth = f.w + 1.4; ctx.stroke();
      ctx.strokeStyle = G.water; ctx.lineWidth = f.w; ctx.stroke();
    }

    // paths under roads (footway crossings run under the street)
    const pathIds = q("paths");
    const roadIds = q("roads");
    if (k >= 1.5) drawFrontWalks(ctx, r, X0, Y0, X1, Y1, G);
    if (k >= 0.5) drawStreetWalks(ctx, r, roadIds, k, G);
    drawPaths(ctx, pathIds.filter((i) => !data.paths[i].br && !data.paths[i].tn), k, G, false);
    drawRails(ctx, q("rails"), k);
    drawRoads(ctx, roadIds.filter((i) => !data.roads[i].br && !data.roads[i].tn), k, G, false);
    drawCrossings(ctx, r, cam, X0, Y0, X1, Y1, k);
    const bridgeRoads = roadIds.filter((i) => data.roads[i].br && !data.roads[i].tn), bridgePaths = pathIds.filter((i) => data.paths[i].br);
    if (bridgeRoads.length || bridgePaths.length) drawBridges(ctx, r, cam, bridgeRoads, bridgePaths, k, G);
    if (k >= 1) drawBarriers(ctx, r, cam, q("barriers"), k, G);
    drawSites(ctx, r, cam, areaIds, k, G);
    lap("lines");

    // things lying on the ground: fallen leaves, parked cars
    if (G.litter && k >= 0.5) drawLitter(ctx, r, cam, objIds, k, G);
    if (k >= 0.2) drawParked(ctx, r, cam, roadIds, q("areas", 8), gb, k);
    lap("cars");

    // shadows (from anything whose shadow can reach this tile), still inside the world's clip: a shadow cast past the
    // map's edge must not darken the diorama's earth sides
    drawShadows(ctx, r, cam, X0, Y0, X1, Y1);
    ctx.restore();
    lap("shadows");

    // paper over the ground (not over the transparent margin round it, and not over the objects: those are redrawn on
    // the main thread over moving things, and must come out the same there)
    if (k >= 0.2) { ctx.save(); worldClip(ctx, cam, r); paper(ctx, cam); ctx.restore(); }
    lap("paper");

    // objects, back to front
    if (prof) {
      for (const i of objIds) {
        const t = performance.now();
        drawObject(ctx, r, cam, i, style);
        const kind = i < B ? "buildings" : i < B + T ? "trees" : "lamps";
        prof[kind] = (prof[kind] || 0) + performance.now() - t;
        prof["n_" + kind] = (prof["n_" + kind] || 0) + 1;
      }
      tp = performance.now();
    } else for (const i of objIds) drawObject(ctx, r, cam, i, style);
  }

  // ================================================================ ground areas
  const areaBoxes = new Map();
  function areaBox(i) {
    let b = areaBoxes.get(i);
    if (!b) { b = ringBox(data.areas[i].p[0]); areaBoxes.set(i, b); }
    return b;
  }
  const areaObbs = new Map();
  function areaObb(i) {
    let o = areaObbs.get(i);
    if (o === undefined) { o = obbOf(data.areas[i].p[0]); areaObbs.set(i, o); }
    return o;
  }
  function areaPath(ctx, a) {
    ctx.beginPath();
    for (const f of a.p) ringPath(ctx, f);
  }
  const GREENS = new Set(["grass", "park", "meadow", "garden", "cem", "farm"]);

  function drawArea(ctx, i, k, G, gb, cam, r) {
    const a = data.areas[i], kind = a.k;
    const bb = areaBox(i);
    if (bb[2] < gb[0] || bb[0] > gb[2] || bb[3] < gb[1] || bb[1] > gb[3]) return;
    if (kind === "stall") {
      if (k < 1.5) return;
      areaPath(ctx, a);
      ctx.strokeStyle = PAL.stall; ctx.lineWidth = 0.13; ctx.lineJoin = "miter"; ctx.stroke(); ctx.lineJoin = "round";
      return;
    }
    if (kind === "water") return drawWater(ctx, i, a, k, G, gb, r);
    if (kind === "pool") {
      areaPath(ctx, a);
      ctx.fillStyle = G.pool; ctx.fill("evenodd");
      if (k >= 0.35) { ctx.strokeStyle = "#f2f0ea"; ctx.lineWidth = 0.7; ctx.stroke(); }
      if (k >= 2 && a.A > 150 && G.snow < 0.4) poolLanes(ctx, i, a);
      return;
    }
    if (kind === "pitch") return drawPitch(ctx, i, a, k, G, cam, r);
    if (kind === "court") return drawCourt(ctx, i, a, k, G, cam, r);
    if (kind === "track") return drawTrack(ctx, i, a, k, G);
    if (kind === "cons") { areaPath(ctx, a); return drawSiteGround(ctx, i, a, k, G, cam, r); }
    // grass inside a stadium bowl is its artificial turf
    const col = GREENS.has(kind) && inBowl(i) ? G.turf : G[kind] || (kind === "road" ? G.roadArea : kind === "bridge" ? G.bridge : G.land);
    areaPath(ctx, a);
    ctx.fillStyle = col;
    ctx.fill("evenodd");
    if (GREENS.has(kind)) {
      if (k >= 1 && G.snow < 0.5) texture(ctx, "grass", k, 1);
      if (k >= 2 && G.snow < 0.3 && G.season !== "winter" && (kind === "grass" || kind === "park") && a.A > 2500) mowLines(ctx, i, a);
      if (k >= 0.8) { ctx.strokeStyle = sh(col, 0.93); ctx.lineWidth = Math.min(0.5, 1.2 / k); ctx.stroke(); }
    } else if (kind === "plaza") {
      if (k >= 2) texture(ctx, a.su === "bricks" || a.su === "paving_stones" || a.su === "bricksq" ? "pavers" : "slabs", k, 1);
      // (edges thinner than a quarter of a pixel are left out: they cost a stroke and show nothing)
      if (k >= 0.7) { ctx.strokeStyle = G.plazaEdge; ctx.lineWidth = 0.35; ctx.stroke(); }
    } else if (kind === "bridge") {
      if (k >= 0.55) { ctx.strokeStyle = "#8f877b"; ctx.lineWidth = 0.45; ctx.stroke(); }
    } else if (kind === "parking") {
      if (k >= 2 && G.snow < 0.5) texture(ctx, "asphalt", k, 1);
      if (k >= 0.4) { ctx.strokeStyle = G.curb; ctx.lineWidth = 0.6; ctx.stroke(); }
    } else if (kind === "wood" || kind === "scrub") {
      if (k >= 0.7 && G.snow < 0.6) texture(ctx, "undergrowth", k, 1);
      if (k >= 0.35) { ctx.strokeStyle = sh(col, 0.86); ctx.lineWidth = 0.7; ctx.stroke(); }
    } else if (kind === "flower") {
      if (k >= 0.8) { ctx.strokeStyle = sh(col, 0.9); ctx.lineWidth = 0.4; ctx.stroke(); }
      if (k >= 2 && G.snow < 0.3) flowerDots(ctx, a, bb, gb, G);
    } else if (kind === "sand") {
      if (k >= 1) texture(ctx, "sand", k, 1);
    }
  }

  function drawWater(ctx, i, a, k, G, gb, r) {
    areaPath(ctx, a);
    // a muddy, grassy bank, then the water over its inner half
    if (k >= 0.4) { ctx.strokeStyle = G.bank; ctx.lineWidth = 3.4; ctx.stroke(); }
    ctx.fillStyle = G.water; ctx.fill("evenodd");
    if (k < 1) { ctx.strokeStyle = G.waterEdge; ctx.lineWidth = Math.min(2.4, 1.2 / k); ctx.stroke(); return; }
    ctx.save();
    ctx.clip("evenodd");
    // shallows: a pale band along the shore, a darker line right at the water's edge
    ctx.strokeStyle = rgba(G.shallow, G.snow > 0.6 ? 0.2 : 0.55); ctx.lineWidth = 9; ctx.stroke();
    ctx.strokeStyle = rgba(G.shallow, 0.5); ctx.lineWidth = 4; ctx.stroke();
    ctx.strokeStyle = G.waterEdge; ctx.lineWidth = 1; ctx.stroke();
    if (k >= 1.5 && G.snow < 0.6) waterShimmer(ctx, i, a, k, gb, r);
    ctx.restore();
  }
  // short ripples, level on the screen (as a painter would draw them), only inside the tile and the water
  function waterShimmer(ctx, i, a, k, gb, r) {
    const bb = areaBox(i);
    const x0 = Math.max(bb[0], gb[0]), x1 = Math.min(bb[2], gb[2]), y0 = Math.max(bb[1], gb[1]), y1 = Math.min(bb[3], gb[3]);
    if (x0 >= x1 || y0 >= y1) return;
    const o = geo.ROTS[r], rx = o.R[0], ry = o.R[1];
    const step = k >= 4 ? 4.5 : 6.5;
    ctx.lineCap = "round";
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      for (let y = Math.floor(y0 / step) * step; y < y1; y += step) for (let x = Math.floor(x0 / step) * step; x < x1; x += step) {
        const h = nHash(((x * 73) | 0) ^ ((y * 151) | 0) ^ 0x5bd1e995);
        if (pass === 0 ? h > 0.42 : h < 0.86) continue;
        const cx = x + h * step, cy = y + nHash(((x * 7 + y) | 0) + 99) * step, L = 0.9 + h * 2.4;
        ctx.moveTo(cx - rx * L, cy - ry * L); ctx.lineTo(cx + rx * L, cy + ry * L);
      }
      ctx.strokeStyle = pass === 0 ? "rgba(255,255,255,.5)" : "rgba(52,98,124,.22)";
      ctx.lineWidth = pass === 0 ? 0.32 : 0.28;
      ctx.stroke();
    }
  }
  // A big lawn's mowing stripes: broad bands along its longer side, alternately a touch lighter (laid inside a clip,
  // which keeps the area's path for the edge stroke that follows)
  function mowLines(ctx, i, a) {
    const o = areaObb(i);
    if (!o || o.W < 18) return;
    ctx.save();
    ctx.clip("evenodd");
    ctx.translate(o.cx, o.cy); ctx.rotate(o.ang);
    ctx.fillStyle = "rgba(255,255,236,.07)";
    const sw = 3.2;
    ctx.beginPath();
    for (let v = -o.W / 2, n = 0; v < o.W / 2; v += sw, n++) if (n & 1) ctx.rect(-o.L / 2, v, o.L, sw);
    ctx.fill();
    ctx.restore();
    areaPath(ctx, a);
  }
  function poolLanes(ctx, i, a) {
    const o = areaObb(i);
    if (!o || o.L < 12) return;
    ctx.save();
    ctx.translate(o.cx, o.cy); ctx.rotate(o.ang);
    ctx.strokeStyle = "rgba(40,90,140,.35)"; ctx.lineWidth = 0.22;
    ctx.beginPath();
    const n = Math.floor(o.W / 2.5);
    for (let l = 1; l < n; l++) { const y = -o.W / 2 + (o.W / n) * l; ctx.moveTo(-o.L / 2 + 1.5, y); ctx.lineTo(o.L / 2 - 1.5, y); }
    ctx.stroke();
    ctx.restore();
  }
  function flowerDots(ctx, a, bb, gb, G) {
    const x0 = Math.max(bb[0], gb[0]), x1 = Math.min(bb[2], gb[2]), y0 = Math.max(bb[1], gb[1]), y1 = Math.min(bb[3], gb[3]);
    if (x0 >= x1 || y0 >= y1 || (x1 - x0) * (y1 - y0) > 40000) return;
    ctx.save();
    areaPath(ctx, a); ctx.clip("evenodd");
    // mulch, then blooms (fewer as the year goes on)
    const cols = G.flowers ? ["#e66b6b", "#f2c94c", "#f4f1e8", "#d67ab1", "#ef8f4c"] : ["#8a6a4a", "#7d6a4a"];
    const keep = G.flowers ? 0.45 * G.flowers : 0.15;
    for (let c = 0; c < cols.length; c++) {
      ctx.fillStyle = cols[c];
      ctx.beginPath();
      for (let y = Math.floor(y0); y < y1; y += 1.2) for (let x = Math.floor(x0); x < x1; x += 1.2) {
        const h = nHash((Math.round(x * 10) * 73856093) ^ (Math.round(y * 10) * 19349663));
        if (h > keep || Math.floor(h * 113) % cols.length !== c) continue;
        ctx.rect(x + h, y + nHash(Math.round(x * 31 + y * 7)), 0.38, 0.38);
      }
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- lawns, sidewalks, the stadium floor
  // ================================================================ construction sites
  // A site should read as one on purpose, not as unrendered ground: packed ochre earth with a speckle of spoil, the ruts
  // of the trucks that come in at its gate and a heap or two of earth; round it a hoarding (2 m of green windscreen
  // mesh, open at the gate and wherever a road, path or building meets the line); and on bigger sites the site office
  // and a container just inside the gate, lit at night. The earth is laid with the land use (other areas mapped inside
  // the site cover it); the hoarding and the cabins stand up, so they go in after the roads and the other areas.
  // Each site is planned once, from ground geometry only, so every tile, worker and rotation agrees.
  const HOARD_H = 2, HOARD = "#56675a";
  const CABIN = { L: 6.1, W: 2.5, H: 2.6, side: "#e2ddd1", top: "#cbc6ba" }, CONTAINER = { L: 6.1, W: 2.4, H: 2.6, side: "#b0623d", top: "#9b5535" };
  const sitePlans = new Map();
  function sitePlan(i, r) {
    let P = sitePlans.get(i);
    if (P) return P;
    const a = data.areas[i], f = a.p[0], n = f.length / 2, bb = areaBox(i), rnd = rng(i * 7919 + 17);
    // what the plan must keep clear of (the scene's screen-box query is a superset of what lies near on the ground, so
    // the filtered answer is the same whichever rotation asks first)
    const near = (name, pad) => nearGround(r, name, bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad);
    // each with its bounding box, [rings or points, box, half-width]
    const ways = [];
    for (const q of near("roads", 30)) { const w = data.roads[q]; if (!w.tn && w.pts && w.pts.length >= 4) ways.push([w.pts, ringBox(w.pts), w.w / 2, 1]); }
    for (const q of near("paths", 4)) { const w = data.paths[q]; if (!w.tn && w.pts && w.pts.length >= 4) ways.push([w.pts, ringBox(w.pts), (w.w || 2) / 2, 0.5]); }
    const blds = [], trees = [], others = [];
    for (const o of near("objects", 6)) {
      if (o < B) { const b = data.buildings[o]; blds.push([b.p, ringBox(b.p[0])]); }
      else if (o < B + T) trees.push(o - B);
    }
    for (const q of near("areas", 4)) { const ar = data.areas[q]; if (q !== i && !LANDUSE.has(ar.k) && ar.k !== "stall") others.push([ar.p, areaBox(q)]); }
    const inBox = (bx, x, y, m) => x > bx[0] - m && x < bx[2] + m && y > bx[1] - m && y < bx[3] + m;
    // on a road or path (or within pad of one; paths count half)
    const onWay = (x, y, pad) => {
      for (const [pts, bx, hw, kp] of ways) if (inBox(bx, x, y, hw + pad) && lineDist(pts, x, y) < hw + pad * kp) return true;
      return false;
    };
    // well inside a carriageway (a site's edge mapped along the kerb keeps its hoarding)
    const onRoad = (x, y) => {
      for (const [pts, bx, hw, kp] of ways) if (kp === 1 && inBox(bx, x, y, hw) && lineDist(pts, x, y) < hw - 1) return true;
      return false;
    };
    // in (or within pad of) a building
    const inBuilding = (x, y, pad) => {
      for (const [rings, bx] of blds) if (inBox(bx, x, y, pad) && (ptInRings(rings, x, y) || (pad > 0 && ringsEdgeDist(rings, x, y) < pad))) return true;
      return false;
    };
    // that, under a tree, or on an area mapped as something else (a lot, a lawn)
    const blocked = (x, y, pad) => {
      if (inBuilding(x, y, pad)) return true;
      const tr = data.trees;
      for (const t of trees) if (Math.hypot(tr[5 * t] - x, tr[5 * t + 1] - y) < tr[5 * t + 2] + pad * 0.5) return true;
      for (const [rings, bx] of others) if (inBox(bx, x, y, 0) && ptInRings(rings, x, y)) return true;
      return false;
    };
    // A construction polygon is often a project long finished (OpenStreetMap lags), or a campus block with one building
    // going up: when most of the site is built over or mapped as something else, it gets no hoarding, office or ruts.
    let inside = 0, free = 0;
    const step = Math.max(3, Math.sqrt(a.A / 300));
    for (let y = bb[1] + step / 2; y < bb[3]; y += step) for (let x = bb[0] + step / 2; x < bb[2]; x += step) {
      if (!ptInRing(f, x, y)) continue;
      inside++;
      if (!blocked(x, y, 0) && !onWay(x, y, 0)) free++;
    }
    if (free < 0.5 * inside) { P = { panels: [], boxes: [], tracks: [], heaps: [], gate: [0, 0], ux: 1, uy: 0 }; sitePlans.set(i, P); return P; }
    const ccw = ringArea(f) > 0;
    // the gate: on the side nearest a road (the longer of two equally near), where the trucks turn in
    let gs = 0, gScore = -Infinity;
    for (let s = 0; s < n; s++) {
      const e = (s + 1) % n, L = Math.hypot(f[2 * e] - f[2 * s], f[2 * e + 1] - f[2 * s + 1]);
      if (L < 9) continue;
      const mx = (f[2 * s] + f[2 * e]) / 2, my = (f[2 * s + 1] + f[2 * e + 1]) / 2;
      let d = 60;
      for (const [pts, bx, hw, kp] of ways) if (kp === 1 && inBox(bx, mx, my, 60)) d = Math.min(d, lineDist(pts, mx, my) - hw);
      const score = Math.min(L, 40) - 2 * Math.max(0, d);
      if (score > gScore) { gScore = score; gs = s; }
    }
    const ge = (gs + 1) % n, gdx = f[2 * ge] - f[2 * gs], gdy = f[2 * ge + 1] - f[2 * gs + 1], gL = Math.hypot(gdx, gdy) || 1;
    const ux = gdx / gL, uy = gdy / gL, inx = ccw ? -uy : uy, iny = ccw ? ux : -ux;   // along the gate side; inward
    const gx = f[2 * gs] + gdx / 2, gy = f[2 * gs + 1] + gdy / 2;
    // does any way cross the line from (ax, ay) to (bx, by)? (a sidewalk running along the site's edge doesn't open the
    // hoarding; a path or a driveway through it does)
    const crossed = (ax, ay, bx, by) => {
      const ex = bx - ax, ey = by - ay;
      for (const [pts, bx2] of ways) {
        if (Math.max(ax, bx) < bx2[0] || Math.min(ax, bx) > bx2[2] || Math.max(ay, by) < bx2[1] || Math.min(ay, by) > bx2[3]) continue;
        for (let q = 2; q < pts.length; q += 2) {
          const px = pts[q - 2], py = pts[q - 1], qx = pts[q] - px, qy = pts[q + 1] - py, den = ex * qy - ey * qx;
          if (Math.abs(den) < 1e-9) continue;
          const t = ((px - ax) * qy - (py - ay) * qx) / den, u = ((px - ax) * ey - (py - ay) * ex) / den;
          if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return true;
        }
      }
      return false;
    };
    // the hoarding: each side in pieces of about 4 m, a piece left open at the gate, where a way crosses the line, where
    // the line runs down a carriageway, or where a building stands on it
    const panels = [];
    for (let s = 0; s < n; s++) {
      const e = (s + 1) % n, x0 = f[2 * s], y0 = f[2 * s + 1], dx = f[2 * e] - x0, dy = f[2 * e + 1] - y0, L = Math.hypot(dx, dy);
      if (L < 0.5) continue;
      const m = Math.max(1, Math.round(L / 4));
      let run = -1;
      for (let p = 0; p < m; p++) {
        const t0 = p / m, t1 = (p + 1) / m, cx = x0 + dx * (t0 + t1) / 2, cy = y0 + dy * (t0 + t1) / 2;
        const ax = x0 + dx * t0, ay = y0 + dy * t0, bx = x0 + dx * t1, by = y0 + dy * t1;
        const open = (s === gs && Math.hypot(cx - gx, cy - gy) < 4) || crossed(ax, ay, bx, by) || onRoad(cx, cy) || inBuilding(cx, cy, 0.2);
        if (open) { run = -1; continue; }
        if (run < 0) { run = panels.length; panels.push({ x0: x0 + dx * t0, y0: y0 + dy * t0, x1: 0, y1: 0, nx: ccw ? dy / L : -dy / L, ny: ccw ? -dx / L : dx / L }); }
        panels[run].x1 = x0 + dx * t1; panels[run].y1 = y0 + dy * t1;
      }
    }
    // a box of size S that fits: wholly inside the site, 4 m clear of its edge, clear of buildings, trees, ways and areas
    const fits = (cx, cy, S) => {
      const hx = S.L / 2 + 1, hy = S.W / 2 + 1;
      for (let c = 0; c < 5; c++) {
        const su = c === 4 ? 0 : c & 1 ? hx : -hx, sv = c === 4 ? 0 : c & 2 ? hy : -hy;
        const x = cx + ux * su + inx * sv, y = cy + uy * su + iny * sv;
        if (!ptInRing(f, x, y) || ringsEdgeDist([f], x, y) < 4 || onWay(x, y, 1.5) || blocked(x, y, 2)) return false;
      }
      return true;
    };
    const boxes = [];
    if (a.A >= 1500) {
      // the site office just inside the gate (looking for room a little deeper and to either side), its container beside it
      search: for (let d = 8; d <= 30; d += 4) for (const side of [0, 1, -1, 2, -2]) {
        const cx = gx + inx * d + ux * side * 7, cy = gy + iny * d + uy * side * 7;
        if (!fits(cx, cy, CABIN)) continue;
        boxes.push({ cx, cy, S: CABIN });
        if (a.A >= 4000) for (const o of [7.4, -7.4]) if (fits(cx + ux * o, cy + uy * o, CONTAINER)) { boxes.push({ cx: cx + ux * o, cy: cy + uy * o, S: CONTAINER }); break; }
        break search;
      }
    }
    // truck ruts from the gate: to the office, and on into the site
    const tracks = [], ends = [];
    if (boxes.length) ends.push([boxes[0].cx + inx * 4, boxes[0].cy + iny * 4]);
    const far = rayFar(f, gx + inx * 0.5, gy + iny * 0.5, inx, iny);
    if (far > 12) {
      ends.push([gx + inx * far * 0.75 + ux * far * (rnd() - 0.5) * 0.5, gy + iny * far * 0.75 + uy * far * (rnd() - 0.5) * 0.5]);
      if (a.A >= 6000) ends.push([gx + inx * far * 0.45 + ux * far * (rnd() < 0.5 ? -0.5 : 0.5), gy + iny * far * 0.45 + uy * far * (rnd() < 0.5 ? -0.5 : 0.5)]);
    }
    for (const [tx, ty] of ends) {
      // a gentle curve: straight in through the gate, then bending toward where it's going
      const d = Math.hypot(tx - gx, ty - gy), kx = gx + inx * d * 0.5, ky = gy + iny * d * 0.5, pts = [];
      for (let q = 0; q <= 14; q++) { const t = q / 14, u = 1 - t; pts.push(u * u * (gx - inx * 3) + 2 * u * t * kx + t * t * tx, u * u * (gy - iny * 3) + 2 * u * t * ky + t * t * ty); }
      tracks.push(pts);
    }
    // a heap of spoil or two, on open ground
    const heaps = [];
    for (let h = 0, tries = 0; h < (a.A >= 3000 ? (a.A >= 12000 ? 3 : 2) : a.A >= 1200 ? 1 : 0) && tries < 30; tries++) {
      const x = bb[0] + (bb[2] - bb[0]) * rnd(), y = bb[1] + (bb[3] - bb[1]) * rnd(), rad = 3.5 + 3 * rnd();
      if (!ptInRing(f, x, y) || ringsEdgeDist([f], x, y) < rad + 3 || blocked(x, y, rad + 1) || onWay(x, y, rad)) continue;
      if (boxes.some((b) => Math.hypot(b.cx - x, b.cy - y) < rad + 6) || tracks.some((t) => lineDist(t, x, y) < rad + 2)) continue;
      heaps.push([x, y, rad, rnd()]);
      h++;
    }
    P = { panels, boxes, tracks, heaps, gate: [gx, gy], ux, uy };
    sitePlans.set(i, P);
    return P;
  }
  // the earth, its ruts and heaps (with the land use, under everything else; the path is the site's outline)
  function drawSiteGround(ctx, i, a, k, G, cam, r) {
    ctx.fillStyle = G.cons;
    ctx.fill("evenodd");
    if (k >= 0.7 && G.snow < 0.6) texture(ctx, "spoil", k, 1);
    if (k < 0.6) return;
    const P = sitePlan(i, r), snowy = G.snow >= 0.3;
    ctx.save();
    ctx.clip("evenodd");
    // ruts: two wheel lines a lorry's track apart, or one worn band from further off
    const rut = snowy ? "rgba(120,116,110,.3)" : "rgba(112,82,48,.26)";
    ctx.lineCap = "round"; ctx.strokeStyle = rut;
    for (const t of P.tracks) {
      if (k >= 1.5) {
        ctx.lineWidth = 0.5;
        ctx.beginPath(); linePath(ctx, offsetLine(t, 0.95)); linePath(ctx, offsetLine(t, -0.95)); ctx.stroke();
      } else { ctx.lineWidth = 2.2; ctx.beginPath(); linePath(ctx, t); ctx.stroke(); }
    }
    // heaps: a low mound seen from above, its flank at ground level (lit on the light's side, shaded on the other) and
    // its crown a third of its width up, so the near flank shows below it
    const o = geo.ROTS[r], lx = LIGHT_U * o.R[0] + LIGHT_V * o.D[0], ly = LIGHT_U * o.R[1] + LIGHT_V * o.D[1];
    const lit = snowy ? "#eef0f2" : sh(G.cons, 1.02), dark = snowy ? "#c9ced4" : sh(G.cons, 0.8), crown = snowy ? "#f4f6f8" : sh(G.cons, 1.06);
    for (const [x, y, rad, h] of P.heaps) {
      const ry = rad * (0.75 + 0.2 * h), rot = h * 3;
      const g = ctx.createLinearGradient(x + lx * rad, y + ly * rad, x - lx * rad, y - ly * rad);
      g.addColorStop(0, lit); g.addColorStop(1, dark);
      setWorld(ctx, cam, r);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(x, y, rad, ry, rot, 0, TAU); ctx.fill();
      setWorld(ctx, cam, r, rad * 0.32);
      ctx.fillStyle = crown;
      ctx.beginPath(); ctx.ellipse(x + lx * rad * 0.12, y + ly * rad * 0.12, rad * 0.62, ry * 0.62, rot, 0, TAU); ctx.fill();
    }
    setWorld(ctx, cam, r);
    ctx.restore();
  }
  // the hoarding and the cabins (after the roads and areas: they stand up over whatever lies behind them)
  function drawSites(ctx, r, cam, ids, k, G) {
    if (k < 0.5) return;
    const o = geo.ROTS[r], sx = SH_U * o.R[0] + SH_V * o.D[0], sy = SH_U * o.R[1] + SH_V * o.D[1];
    const panel = (p, col) => {
      projInto(PQ, 0, p.x0, p.y0, 0, r); projInto(PQ, 2, p.x1, p.y1, 0, r);
      ctx.beginPath();
      ctx.moveTo(PQ[0], PQ[1]); ctx.lineTo(PQ[2], PQ[3]); ctx.lineTo(PQ[2], PQ[3] - HOARD_H * C); ctx.lineTo(PQ[0], PQ[1] - HOARD_H * C); ctx.closePath();
      ctx.fillStyle = col; ctx.fill();
    };
    const fence = (P, front) => {
      for (const p of P.panels) {
        const nd = p.nx * o.D[0] + p.ny * o.D[1];
        if ((nd < 0) !== front) continue;
        // the outer face lit by its bearing to the light; from inside the site, its shaded back
        panel(p, front ? sh(HOARD, 0.8 + 0.32 * lightOf(p.nx * o.R[0] + p.ny * o.R[1], nd)) : sh(HOARD, 0.66));
      }
      // the top rail, and from closer in the posts
      ctx.beginPath();
      for (const p of P.panels) {
        if ((p.nx * o.D[0] + p.ny * o.D[1] < 0) !== front) continue;
        projInto(PQ, 0, p.x0, p.y0, HOARD_H, r); projInto(PQ, 2, p.x1, p.y1, HOARD_H, r);
        ctx.moveTo(PQ[0], PQ[1]); ctx.lineTo(PQ[2], PQ[3]);
        if (k >= 2) {
          const L = Math.hypot(p.x1 - p.x0, p.y1 - p.y0), m = Math.max(1, Math.round(L / 3));
          for (let q = 0; q <= m; q++) { const x = PQ[0] + (PQ[2] - PQ[0]) * q / m, y = PQ[1] + (PQ[3] - PQ[1]) * q / m; ctx.moveTo(x, y); ctx.lineTo(x, y + HOARD_H * C); }
        }
      }
      ctx.strokeStyle = sh(HOARD, front ? 0.62 : 0.55); ctx.lineWidth = Math.max(0.1, 0.7 / k); ctx.stroke();
    };
    for (const i of ids) {
      if (data.areas[i].k !== "cons") continue;
      const P = sitePlan(i, r);
      setScreen(ctx, cam);
      fence(P, false);
      for (const bx of P.boxes) {
        const q = rectQuad(bx.cx, bx.cy, Math.atan2(P.uy, P.ux), bx.S.L / 2, bx.S.W / 2);
        // a contact shadow, then the box
        setWorld(ctx, cam, r);
        ctx.beginPath();
        const hull = hull2([0, 1, 2, 3].flatMap((c) => [[q[2 * c], q[2 * c + 1]], [q[2 * c] + sx * bx.S.H, q[2 * c + 1] + sy * bx.S.H]]));
        ctx.moveTo(hull[0][0], hull[0][1]); for (const h of hull) ctx.lineTo(h[0], h[1]); ctx.closePath();
        ctx.fillStyle = rgba(PAL.shadow, 0.2); ctx.fill();
        setScreen(ctx, cam);
        prism(ctx, r, q, 0, bx.S.H, bx.S.side, bx.S.top, Math.min(0.12, 0.8 / k));
        if (bx.S === CABIN && k >= 1.2) cabinWindows(ctx, r, q, "#4b5763");
      }
      fence(P, true);
      setWorld(ctx, cam, r);
    }
  }
  // the office's windows on its camera-facing long side: dark by day, lit (drawn again over the lights) at night
  function cabinWindows(ctx, r, q, col) {
    const o = geo.ROTS[r];
    for (const e of [0, 2]) {
      const a = e, c = e + 1, dx = q[2 * c] - q[2 * a], dy = q[2 * c + 1] - q[2 * a + 1], L = Math.hypot(dx, dy) || 1;
      if ((dy / L) * o.D[0] + (-dx / L) * o.D[1] >= 0) continue;
      projInto(PQ, 0, q[2 * a], q[2 * a + 1], 0, r); projInto(PQ, 2, q[2 * c], q[2 * c + 1], 0, r);
      ctx.beginPath();
      quadF(ctx, PQ[0], PQ[1], PQ[2], PQ[3], 0.14, 0.38, 1.1, 2.0);
      quadF(ctx, PQ[0], PQ[1], PQ[2], PQ[3], 0.62, 0.86, 1.1, 2.0);
      ctx.fillStyle = col; ctx.fill();
    }
  }

  const LANDUSE = new Set(["land", "res", "com", "ind", "rel", "cem", "campus", "farm", "cons"]);
  // A lawn round each house (and a narrower one round apartment blocks): their outlines stroked wide and filled, so
  // neighbours' yards run together into green blocks cut by the streets, alleys and lots drawn over them.
  function drawYards(ctx, r, X0, Y0, X1, Y1, k, G) {
    if (k < 0.2) return;
    const ids = scene.query(r, "objects", X0 - 9, Y0 - 9, X1 + 9, Y1 + 9);
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      let any = false;
      for (const i of ids) {
        if (i >= B || data.buildings[i].hidden) continue;
        const kind = styleOf(i).kind;
        if (kind !== (pass === 0 ? "house" : "apt")) continue;
        // (each ring closed by going round past its start to its second corner, not by closePath(), which is slow on a
        // path of many: see quadF. The stroke then joins at the start like everywhere else, and the fill is the same.)
        const f = data.buildings[i].p[0];
        linePath(ctx, f); ctx.lineTo(f[0], f[1]); ctx.lineTo(f[2], f[3]);
        any = true;
      }
      if (!any) continue;
      ctx.lineJoin = k >= 1 ? "round" : "bevel";   // round joins cost twice as much and don't show from afar
      ctx.strokeStyle = ctx.fillStyle = G.yard;
      ctx.lineWidth = pass === 0 ? 13 : 7;
      ctx.stroke(); ctx.fill();
    }
  }
  // is area i inside the field of a stadium bowl?
  let bowlHoles = null;
  const inBowlCache = new Map();
  function inBowl(i) {
    let v = inBowlCache.get(i);
    if (v !== undefined) return v;
    if (!bowlHoles) {
      bowlHoles = [];
      data.buildings.forEach((b, j) => {
        if (b.hidden || b.p.length < 2 || !(b.lm || b.k === "stadium" || b.k === "grandstand") || styleOf(j).kind !== "bowl") return;
        for (let q = 1; q < b.p.length; q++) if (Math.abs(ringArea(b.p[q])) > 400) bowlHoles.push(b.p[q]);
      });
    }
    const [cx, cy] = ringCentroid(data.areas[i].p[0]);
    v = bowlHoles.some((f) => ptInRing(f, cx, cy));
    inBowlCache.set(i, v);
    return v;
  }
  function bowlFloor(ctx, i, G) {
    const b = data.buildings[i];
    let inner = null, ia = 0;
    for (let q = 1; q < b.p.length; q++) { const a = Math.abs(ringArea(b.p[q])); if (a > ia) { ia = a; inner = b.p[q]; } }
    if (!inner) return;
    ctx.fillStyle = G.turf;
    ctx.beginPath(); ringPath(ctx, inner); ctx.fill();
    // and out to the foot of the stands as drawBowl builds them (its smoothed rays can reach a little past the ring)
    const g = bowlOf(i);
    if (!g) return;
    ctx.beginPath();
    for (let j = 0; j < g.N; j++) {
      const a = (j / g.N) * TAU, x = g.cx + Math.cos(a) * (g.rin[j] + 0.3), y = g.cy + Math.sin(a) * (g.rin[j] + 0.3);
      if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath(); ctx.fill();
  }
  // Sidewalks along the streets where OSM has none mapped (most of the neighbourhoods): a strip of concrete on each
  // side, a tree lawn's width back from the curb. A side counts as mapped when footways run along most of it.
  const walkSides = new Map();
  function streetWalks(ri, r) {
    let v = walkSides.get(ri);
    if (v !== undefined) return v;
    const rd = data.roads[ri];
    v = null;
    if (STREETS.has(rd.k) && rd.k !== "trunk" && !rd.br && !rd.tn && rd.pts.length >= 4) {
      const off = rd.w / 2 + 2.9, f = rd.pts, bb = ringBox(f), pad = off + 6;
      const near = nearGround(r, "paths", bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad).filter((j) => {
        const p = data.paths[j];
        return p.fw !== "crossing" && p.k !== "steps";
      });
      const sides = [null, null];
      let some = false;
      for (let side = 0; side < 2; side++) {
        const line = offsetLine(f, (side ? -1 : 1) * off);
        // sample every ~6 m along the side: is there a mapped walk within 3.5 m?
        let n = 0, hit = 0;
        for (let q = 2; q < line.length; q += 2) {
          const L = Math.hypot(line[q] - line[q - 2], line[q + 1] - line[q - 1]), m = Math.max(1, Math.round(L / 6));
          for (let t = 0; t < m; t++) {
            const x = line[q - 2] + ((line[q] - line[q - 2]) * (t + 0.5)) / m, y = line[q - 1] + ((line[q + 1] - line[q - 1]) * (t + 0.5)) / m;
            n++;
            for (const j of near) if (lineDist(data.paths[j].pts, x, y) < 3.5) { hit++; break; }
          }
        }
        if (n && hit / n < 0.35) { sides[side] = line; some = true; }
      }
      if (some) v = sides;
    }
    walkSides.set(ri, v);
    return v;
  }
  function drawStreetWalks(ctx, r, roadIds, k, G) {
    ctx.beginPath();
    let any = false;
    for (const ri of roadIds) {
      const v = streetWalks(ri, r);
      if (!v) continue;
      for (const line of v) if (line) { linePath(ctx, line); any = true; }
    }
    if (!any) return;
    ctx.lineCap = "butt"; ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(1.6, 0.8 / k); ctx.strokeStyle = G.sidewalk; ctx.stroke();
    if (k >= 2.5 && G.snow < 0.5) {
      // slab joints
      ctx.setLineDash([0.07, 1.5]);
      ctx.lineWidth = 1.6; ctx.strokeStyle = "rgba(120,105,80,.16)"; ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ---------------------------------------------------------------- sports
  function drawPitch(ctx, i, a, k, G, cam, r) {
    const sp = a.sp || "", su = a.su || "";
    const sand = su === "sand" || sp.includes("beachvolleyball");
    const turf = su === "artificial_turf" || su === "plastic";
    let col = sand ? G.sand : turf ? G.turf : su === "clay" ? "#c98a62" : su === "concrete" || su === "asphalt" ? "#b7b4ad" : sp === "equestrian" ? "#cdb68c" : sp === "skateboard" ? "#c5c2bb" : G.pitch;
    areaPath(ctx, a);
    ctx.fillStyle = col; ctx.fill("evenodd");
    if (k < 0.8) return;
    const o = areaObb(i);
    if (!o) return;
    ctx.save();
    ctx.clip("evenodd");
    ctx.translate(o.cx, o.cy); ctx.rotate(o.ang);
    const L = o.L, W = o.W;
    if (!sand && (col === G.pitch || col === G.turf) && G.snow < 0.5) {
      // mowing stripes across the field
      ctx.fillStyle = "rgba(255,255,255,.075)";
      const sw = L > 60 ? 4.6 : 3;
      for (let x = -L / 2, n = 0; x < L / 2; x += sw, n++) if (n & 1) ctx.fillRect(x, -W / 2, sw, W);
    }
    ctx.strokeStyle = PAL.pitchLine; ctx.lineWidth = 0.15;
    if (G.snow > 0.5) { ctx.restore(); return; }
    if (sand) {
      if (sp.includes("volleyball")) volleyballLines(ctx, L, W, k, 16, 8);
      else if (k >= 1.5) { ctx.fillStyle = "rgba(160,130,80,.18)"; dots(ctx, L, W, 0.6); }
    } else if (sp.includes("american_football") && L > 80) {
      // end zones and a yard line every five yards
      const field = Math.min(L - 2, 109.7), ez = 9.14 * (field / 109.7), x0 = -field / 2;
      const ww = Math.min(W - 1.6, 48.8);
      // scarlet end zones (painted over the turf: its stripes still show through a little)
      ctx.fillStyle = "rgba(176, 28, 44, .9)";
      ctx.fillRect(x0, -ww / 2, ez, ww); ctx.fillRect(-x0 - ez, -ww / 2, ez, ww);
      ctx.strokeRect(x0, -ww / 2, field, ww);
      ctx.beginPath();
      for (let yd = 0; yd <= 100; yd += 5) { const x = x0 + ez + ((field - 2 * ez) * yd) / 100; ctx.moveTo(x, -ww / 2); ctx.lineTo(x, ww / 2); }
      ctx.stroke();
      if (k >= 2) {
        // hash marks
        ctx.beginPath();
        for (let yd = 1; yd < 100; yd++) { const x = x0 + ez + ((field - 2 * ez) * yd) / 100; for (const s of [-1, 1]) { ctx.moveTo(x, s * 3.1); ctx.lineTo(x, s * 3.1 + s * 0.6); ctx.moveTo(x, s * (ww / 2 - 0.2)); ctx.lineTo(x, s * (ww / 2 - 0.8)); } }
        ctx.lineWidth = 0.1; ctx.stroke();
      }
      ctx.fillStyle = "rgba(255,255,255,.5)";
      ctx.beginPath(); ctx.arc(0, 0, Math.min(4, W / 8), 0, TAU); ctx.fill();
    } else if (sp.includes("baseball") || sp.includes("softball")) {
      baseballDiamond(ctx, i, a, o, k);
    } else if (sp.includes("soccer") || sp.includes("lacrosse") || sp.includes("rugby") || sp.includes("field_hockey") || sp.includes("multi") || sp === "hockey" || sp === "cricket" || (!sp && L > 60)) {
      ctx.strokeRect(-L / 2 + 0.6, -W / 2 + 0.6, L - 1.2, W - 1.2);
      ctx.beginPath(); ctx.moveTo(0, -W / 2 + 0.6); ctx.lineTo(0, W / 2 - 0.6); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, Math.min(9.15, W / 6), 0, TAU); ctx.stroke();
      const bw = Math.min(40.3, W * 0.6), bd = Math.min(16.5, L * 0.15);
      ctx.strokeRect(-L / 2 + 0.6, -bw / 2, bd, bw); ctx.strokeRect(L / 2 - 0.6 - bd, -bw / 2, bd, bw);
      if (k >= 2) {
        const gw = Math.min(18.3, W * 0.3), gd = Math.min(5.5, L * 0.05);
        ctx.strokeRect(-L / 2 + 0.6, -gw / 2, gd, gw); ctx.strokeRect(L / 2 - 0.6 - gd, -gw / 2, gd, gw);
        // the goals: white frames standing on the line
        goal(ctx, cam, r, o, -L / 2 + 0.6, Math.min(7.3, W * 0.15));
        goal(ctx, cam, r, o, L / 2 - 0.6, Math.min(7.3, W * 0.15));
      }
    } else if (sp.includes("tennis") || sp.includes("basketball")) {
      ctx.strokeRect(-L / 2 + 0.6, -W / 2 + 0.6, L - 1.2, W - 1.2);
      ctx.beginPath(); ctx.moveTo(0, -W / 2 + 0.6); ctx.lineTo(0, W / 2 - 0.6); ctx.stroke();
    } else if (L > 20) {
      ctx.strokeRect(-L / 2 + 0.6, -W / 2 + 0.6, L - 1.2, W - 1.2);
    }
    ctx.restore();
  }
  function dots(ctx, L, W, step) {
    ctx.beginPath();
    for (let y = -W / 2; y < W / 2; y += step) for (let x = -L / 2; x < L / 2; x += step) {
      const h = nHash(((x * 13) | 0) * 7919 + ((y * 17) | 0));
      if (h < 0.3) ctx.rect(x + h, y, 0.12, 0.12);
    }
    ctx.fill();
  }
  // a goal frame on the line x (in the field's frame, already set on ctx): drawn in ground metres as a raised bar
  function goal(ctx, cam, r, o, x, gw) {
    // the crossbar stands 2.44 m up: offset the drawing straight up the screen by that much
    const m = ctx.getTransform();
    ctx.save();
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f - cam.k * C * 2.44);
    ctx.strokeStyle = "rgba(255,255,255,.95)"; ctx.lineWidth = 0.14;
    ctx.beginPath(); ctx.moveTo(x, -gw / 2); ctx.lineTo(x, gw / 2); ctx.stroke();
    ctx.restore();
    // posts: from the ground line up to the bar, in screen space
    ctx.save();
    ctx.lineWidth = 0.12; ctx.strokeStyle = "rgba(255,255,255,.9)";
    for (const s of [-1, 1]) {
      const gx = o.cx + Math.cos(o.ang) * x - Math.sin(o.ang) * s * gw / 2, gy = o.cy + Math.sin(o.ang) * x + Math.cos(o.ang) * s * gw / 2;
      const [X, Y] = geo.proj(gx, gy, 0, r);
      setScreen(ctx, cam);
      ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X, Y - 2.44 * C); ctx.stroke();
    }
    ctx.restore();
  }
  function baseballDiamond(ctx, i, a, o, k) {
    // home plate: the corner of the fan where the outline turns closest to a right angle
    const f = a.p[0], n = f.length / 2;
    let best = -1, bs = Infinity;
    for (let v = 0; v < n; v++) {
      const p = (v + n - 1) % n, q = (v + 1) % n;
      const ax = f[2 * p] - f[2 * v], ay = f[2 * p + 1] - f[2 * v + 1], bx = f[2 * q] - f[2 * v], by = f[2 * q + 1] - f[2 * v + 1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la < 8 || lb < 8) continue;
      const cos = (ax * bx + ay * by) / (la * lb);
      const score = Math.abs(cos) + (cos < -0.3 ? 2 : 0);
      if (score < bs) { bs = score; best = v; }
    }
    if (best < 0) return;
    const [cx, cy] = ringCentroid(f);
    // undo the field frame: draw in plain ground metres
    ctx.rotate(-o.ang); ctx.translate(-o.cx, -o.cy);
    const hx = f[2 * best], hy = f[2 * best + 1];
    let dx = cx - hx, dy = cy - hy;
    const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
    const size = clamp(dl * 0.55, 12, 27.4) / 27.4;   // softball diamonds are smaller
    const base = 27.43 * size, arc = 29 * size;
    // the infield dirt: a fan round home, then the grass diamond inside it
    const ang = Math.atan2(dy, dx);
    ctx.fillStyle = "#c9a074";
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.arc(hx, hy, arc, ang - Math.PI / 4 - 0.02, ang + Math.PI / 4 + 0.02); ctx.closePath(); ctx.fill();
    const px = -dy, py = dx, d = base / Math.SQRT2;
    ctx.fillStyle = "#8cc36b";
    ctx.beginPath();
    ctx.moveTo(hx + dx * 1.5, hy + dy * 1.5);
    ctx.lineTo(hx + dx * d + px * (d - 1.2), hy + dy * d + py * (d - 1.2));
    ctx.lineTo(hx + dx * (2 * d - 1.5), hy + dy * (2 * d - 1.5));
    ctx.lineTo(hx + dx * d - px * (d - 1.2), hy + dy * d - py * (d - 1.2));
    ctx.closePath(); ctx.fill();
    // mound and bases
    ctx.fillStyle = "#c9a074";
    ctx.beginPath(); ctx.arc(hx + dx * 18.4 * size, hy + dy * 18.4 * size, 2.7 * size, 0, TAU); ctx.fill();
    if (k >= 1.5) {
      ctx.fillStyle = "#f6f4ec";
      for (const [u, v] of [[0, 0], [d, d], [2 * d, 0], [d, -d]]) { const bx = hx + dx * u + px * v, by = hy + dy * u + py * v; ctx.fillRect(bx - 0.3, by - 0.3, 0.6, 0.6); }
      ctx.strokeStyle = "#f6f4ec"; ctx.lineWidth = 0.12;
      ctx.beginPath();
      ctx.moveTo(hx, hy); ctx.lineTo(hx + (dx + px) * 70 * size, hy + (dy + py) * 70 * size);
      ctx.moveTo(hx, hy); ctx.lineTo(hx + (dx - px) * 70 * size, hy + (dy - py) * 70 * size);
      ctx.stroke();
    }
  }
  function volleyballLines(ctx, L, W, k, cl, cw) {
    const l = Math.min(cl, L - 2), w = Math.min(cw, W - 2);
    ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 0.1;
    ctx.strokeRect(-l / 2, -w / 2, l, w);
    ctx.strokeStyle = "#3b3d40"; ctx.lineWidth = 0.12;
    ctx.beginPath(); ctx.moveTo(0, -w / 2 - 0.6); ctx.lineTo(0, w / 2 + 0.6); ctx.stroke();
  }
  // Courts: tennis, basketball, volleyball. A polygon often holds a whole row of tennis courts side by side: fit as
  // many as there's room for.
  function drawCourt(ctx, i, a, k, G, cam, r) {
    const sp = a.sp || "";
    const tennis = sp.includes("tennis") || sp.includes("pickleball");
    const surround = tennis ? (a.su === "clay" ? "#c47c55" : nHash(i) < 0.5 ? "#5e8f6c" : "#4f7f99") : a.su === "clay" ? "#c47c55" : G.court;
    areaPath(ctx, a);
    ctx.fillStyle = G.snow > 0.4 ? mx(surround, "#f4f6f8", Math.min(0.8, G.snow)) : surround; ctx.fill("evenodd");
    if (k < 1 || G.snow > 0.4) return;
    const o = areaObb(i);
    if (!o) return;
    ctx.save();
    ctx.clip("evenodd");
    ctx.translate(o.cx, o.cy); ctx.rotate(o.ang);
    const inner = tennis ? (a.su === "clay" ? "#d08c63" : nHash(i) < 0.5 ? "#79a77f" : "#6a9cbc") : sh(surround, 1.08);
    if (tennis) {
      // courts run along whichever axis fits 36.6 m best; side by side across the other
      const alongL = Math.abs(o.L - 36.6) <= Math.abs(o.W - 36.6) || o.W < 15;
      const len = alongL ? o.L : o.W, wid = alongL ? o.W : o.L;
      const n = Math.max(1, Math.round(wid / 18.3));
      if (!alongL) ctx.rotate(Math.PI / 2);
      const cl = Math.min(23.77, len * 0.72), cw = Math.min(10.97, (wid / n) * 0.66), sw = cw * (8.23 / 10.97);
      for (let c = 0; c < n; c++) {
        const y = -wid / 2 + (wid / n) * (c + 0.5);
        ctx.fillStyle = inner; ctx.fillRect(-cl / 2, y - cw / 2, cl, cw);
        if (k < 1.5) continue;
        ctx.strokeStyle = "rgba(255,255,255,.92)"; ctx.lineWidth = 0.08;
        ctx.strokeRect(-cl / 2, y - cw / 2, cl, cw);
        ctx.beginPath();
        ctx.moveTo(-cl / 2, y - sw / 2); ctx.lineTo(cl / 2, y - sw / 2); ctx.moveTo(-cl / 2, y + sw / 2); ctx.lineTo(cl / 2, y + sw / 2);
        const sl = cl * (6.4 / 23.77);
        ctx.moveTo(-sl, y - sw / 2); ctx.lineTo(-sl, y + sw / 2); ctx.moveTo(sl, y - sw / 2); ctx.lineTo(sl, y + sw / 2);
        ctx.moveTo(-sl, y); ctx.lineTo(sl, y);
        ctx.stroke();
        // the net, standing a metre up
        net(ctx, cam, y - cw / 2 - 0.5, y + cw / 2 + 0.5, 0.95);
      }
    } else if (sp.includes("basketball")) {
      const cl = Math.min(28, o.L - 1), cw = Math.min(15, o.W - 1);
      ctx.fillStyle = inner; ctx.fillRect(-cl / 2, -cw / 2, cl, cw);
      if (k >= 1.5) {
        ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 0.08;
        ctx.strokeRect(-cl / 2, -cw / 2, cl, cw);
        ctx.beginPath(); ctx.moveTo(0, -cw / 2); ctx.lineTo(0, cw / 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, Math.min(1.8, cw / 8), 0, TAU); ctx.stroke();
        for (const s of [-1, 1]) {
          ctx.fillStyle = "rgba(180,70,50,.35)";
          ctx.fillRect(s > 0 ? cl / 2 - 5.8 * (cl / 28) : -cl / 2, -2.45 * (cw / 15), 5.8 * (cl / 28), 4.9 * (cw / 15));
          ctx.beginPath(); ctx.arc(s * (cl / 2 - 1.6), 0, 6.75 * Math.min(1, cw / 15), s > 0 ? Math.PI / 2 : -Math.PI / 2, s > 0 ? Math.PI * 1.5 : Math.PI / 2); ctx.stroke();
        }
      }
    } else if (sp.includes("volleyball")) {
      ctx.fillStyle = inner; ctx.fillRect(-Math.min(9, o.L / 2 - 0.5), -Math.min(4.5, o.W / 2 - 0.5), Math.min(18, o.L - 1), Math.min(9, o.W - 1));
      if (k >= 1.5) volleyballLines(ctx, o.L, o.W, k, 18, 9);
    } else {
      ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 0.1;
      ctx.strokeRect(-o.L / 2 + 0.8, -o.W / 2 + 0.8, o.L - 1.6, o.W - 1.6);
    }
    ctx.restore();
  }
  // a net across x = 0 of the current (court) frame, from y0 to y1, h metres high: a dark band with a white tape
  function net(ctx, cam, y0, y1, h) {
    const m = ctx.getTransform();
    ctx.strokeStyle = "rgba(40,44,48,.55)"; ctx.lineWidth = 0.06;
    ctx.beginPath();
    for (let z = 0.15; z < h; z += 0.22) {
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f - cam.k * C * z);
      ctx.moveTo(0, y0); ctx.lineTo(0, y1);
    }
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.stroke();
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f - cam.k * C * h);
    ctx.strokeStyle = "#f4f2ec"; ctx.lineWidth = 0.09;
    ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(0, y1); ctx.stroke();
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  }
  function drawTrack(ctx, i, a, k, G) {
    areaPath(ctx, a);
    ctx.fillStyle = G.track; ctx.fill("evenodd");
    if (k < 0.8 || G.snow > 0.5) return;
    // lane lines: the outline stroked ever narrower, light and track colour in turn, inside a clip
    ctx.save();
    ctx.clip("evenodd");
    const lanes = k >= 2 ? 8 : 4, lw = 1.22 * (8 / lanes);
    for (let l = lanes; l >= 1; l--) {
      ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.lineWidth = 2 * l * lw + 0.12; ctx.stroke();
      ctx.strokeStyle = G.track; ctx.lineWidth = 2 * l * lw - 0.12; ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 0.24; ctx.stroke();
    ctx.restore();
  }

  // ---------------------------------------------------------------- textures (patterns made once, laid in ground metres)
  const textures = {};
  function textureCanvas(name) {
    if (textures[name] !== undefined) return textures[name];
    if (!canMakeCanvas) return (textures[name] = null);
    const N = 64, c = new OffscreenCanvas(N, N), g = c.getContext("2d");
    const rnd = rng(strHash(name) * 1e9);
    const spots = (n, cols, w, h) => { for (let s = 0; s < n; s++) { g.fillStyle = cols[s % cols.length]; g.fillRect(Math.floor(rnd() * N), Math.floor(rnd() * N), w, h); } };
    if (name === "grass") spots(260, ["rgba(70,110,40,.16)", "rgba(255,255,220,.16)", "rgba(90,120,50,.12)"], 1, 2);
    else if (name === "undergrowth") spots(220, ["rgba(50,80,40,.22)", "rgba(120,140,80,.18)", "rgba(80,70,40,.14)"], 2, 2);
    else if (name === "sand") spots(300, ["rgba(150,120,70,.2)", "rgba(255,255,240,.25)"], 1, 1);
    else if (name === "asphalt") spots(340, ["rgba(0,0,0,.07)", "rgba(255,255,255,.07)"], 1, 1);
    else if (name === "gravel") spots(700, ["rgba(0,0,0,.12)", "rgba(255,255,255,.14)", "rgba(80,60,40,.08)"], 1, 1);
    else if (name === "sedum") spots(500, ["rgba(70,100,40,.25)", "rgba(200,210,120,.25)", "rgba(160,90,60,.12)"], 1, 1);
    else if (name === "spoil") spots(420, ["rgba(96,66,36,.16)", "rgba(255,248,228,.2)", "rgba(120,96,70,.14)", "rgba(70,60,52,.1)"], 1, 1);
    else if (name === "slabs" || name === "pavers") {
      // joints of square slabs (or small pavers), a little irregular
      g.strokeStyle = name === "slabs" ? "rgba(110,95,70,.20)" : "rgba(120,70,50,.22)"; g.lineWidth = 1;
      const cell = name === "slabs" ? 16 : 8;
      g.beginPath();
      for (let p = 0; p <= N; p += cell) { g.moveTo(p + 0.5, 0); g.lineTo(p + 0.5, N); g.moveTo(0, p + 0.5); g.lineTo(N, p + 0.5); }
      g.stroke();
      spots(80, ["rgba(0,0,0,.04)", "rgba(255,255,255,.08)"], 2, 2);
    }
    return (textures[name] = c);
  }
  const patternOf = new Map();
  // fill the current path with a texture; ground textures sit in the ground plane (under setWorld), a texel ≈ a pixel
  function texture(ctx, name, k, alpha) {
    if (!hasMatrix) return;
    const c = textureCanvas(name);
    if (!c) return;
    let p = patternOf.get(name);
    if (!p) { p = ctx.createPattern(c, "repeat"); patternOf.set(name, p); }
    if (!p) return;
    const metresPerTexel = name === "slabs" ? 2 / 16 : name === "pavers" ? 0.6 / 8 : clamp(1.2 / k, 0.12, 2);
    p.setTransform(new DOMMatrix([metresPerTexel, 0, 0, metresPerTexel, 0, 0]));
    ctx.fillStyle = p;
    ctx.fill("evenodd");
  }
  // fill the current path (in screen metres, under setScreen) with a texture of device-pixel texels
  function screenTexture(ctx, name, k) {
    if (!hasMatrix) return;
    const c = textureCanvas(name);
    if (!c) return;
    let p = patternOf.get(name + "@s");
    if (!p) { p = ctx.createPattern(c, "repeat"); patternOf.set(name + "@s", p); }
    if (!p) return;
    p.setTransform(new DOMMatrix([1 / k, 0, 0, 1 / k, 0, 0]));
    ctx.fillStyle = p;
    ctx.fill("evenodd");
  }

  // ================================================================ lines on the ground
  function stroke(ctx, f, width, color, cap = "round") {
    ctx.beginPath(); linePath(ctx, f);
    ctx.lineCap = cap; ctx.lineJoin = "round"; ctx.lineWidth = width; ctx.strokeStyle = color; ctx.stroke();
  }
  const PAVED = new Set(["paving_stones", "bricks", "sett", "cobblestone", "brick"]);
  const SOFT = new Set(["grass", "dirt", "ground", "earth", "mud", "woodchips", "gravel", "fine_gravel", "compacted", "unpaved"]);
  function pathCol(p, G) {
    if (p.k === "cycleway") return G.cycle;
    if (p.k === "steps") return G.steps;
    if (SOFT.has(p.su)) return G.dirt;
    if (PAVED.has(p.su)) return G.pavers;
    if (p.fw === "sidewalk" || p.su === "concrete") return G.sidewalk;
    if (p.su === "asphalt") return mx(G.sidewalk, G.road, 0.25);
    return G.path;
  }
  function drawPaths(ctx, ids, k, G, bridges) {
    if (!ids.length) return;
    const minW = 1 / k;
    if (!bridges && k >= 1) {
      // a soft edge (a curb, a lawn edge) under the whole network first, so crossings merge
      for (const i of ids) {
        const p = data.paths[i];
        if (p.fw === "crossing") continue;
        stroke(ctx, p.pts, Math.max(p.w, minW * 0.8) + 0.5, G.pathEdge);
      }
    }
    for (const i of ids) {
      const p = data.paths[i];
      if (k < 0.35 && p.k !== "pedestrian") continue;
      const w = Math.max(p.w, minW * 0.8);
      stroke(ctx, p.pts, w, pathCol(p, G), bridges ? "butt" : "round");
    }
    if (k < 2.5) return;
    // joints: concrete slabs every ~1.5 m, pavers finer; steps as treads (a dashed stroke as wide as the path)
    ctx.lineCap = "butt";
    for (const i of ids) {
      const p = data.paths[i];
      if (p.fw === "crossing") continue;
      if (p.k === "steps") { ctx.setLineDash([0.12, 0.3]); stroke(ctx, p.pts, p.w * 0.92, "rgba(120,100,80,.45)", "butt"); }
      else if (PAVED.has(p.su)) { ctx.setLineDash([0.05, 0.42]); stroke(ctx, p.pts, p.w, "rgba(140,80,55,.25)", "butt"); }
      else if (!SOFT.has(p.su) && p.k !== "cycleway" && p.su !== "asphalt") { ctx.setLineDash([0.07, 1.5]); stroke(ctx, p.pts, p.w, "rgba(120,105,80,.16)", "butt"); }
    }
    ctx.setLineDash([]);
  }

  function drawRails(ctx, ids, k) {
    for (const i of ids) {
      const f = data.rails[i];
      stroke(ctx, f.pts, 4.2, PAL.ballast, "butt");
      if (k >= 1) {
        ctx.setLineDash([0.28, 0.55]); stroke(ctx, f.pts, 2.7, PAL.tie, "butt"); ctx.setLineDash([]);
        stroke(ctx, f.pts, 1.65, PAL.rail, "butt");
        stroke(ctx, f.pts, 1.3, k >= 3 ? "#9b8a74" : PAL.tie, "butt");
      }
    }
  }

  const MAJOR = new Set(["motorway", "trunk", "primary", "secondary", "tertiary"]);
  const roadCol = (r, G) => (r.k === "motorway" || r.k === "trunk" ? G.motorway : r.k === "primary" || r.k === "secondary" ? G.roadMajor : G.road);

  function drawRoads(ctx, ids, k, G, bridges) {
    if (!ids.length) return;
    const minW = 1.2 / k;
    // curbs first, then the asphalt, so crossings merge
    if (!bridges) for (const i of ids) {
      const r = data.roads[i];
      if (k < 0.3 && r.k === "service") continue;
      stroke(ctx, r.pts, Math.max(r.w, minW) + (r.k === "service" ? 0.5 : 1.1), G.curb);
    }
    for (const i of ids) {
      const r = data.roads[i];
      if (k < 0.3 && r.k === "service") continue;
      stroke(ctx, r.pts, Math.max(r.w, minW), roadCol(r, G), bridges ? "butt" : "round");
    }
    if (k >= 3 && G.snow < 0.5) {
      // a gutter: the asphalt a shade darker along the curb
      for (const i of ids) {
        const r = data.roads[i];
        if (r.k === "service" || r.w < 6) continue;
        ctx.beginPath(); linePath(ctx, r.pts);
        ctx.lineCap = "butt"; ctx.lineWidth = r.w - 0.7; ctx.strokeStyle = sh(roadCol(r, G), 1.04); ctx.stroke();
      }
    }
    if (k < 1.5 || G.snow > 0.6) return;
    // markings
    for (const i of ids) {
      const r = data.roads[i];
      if (r.k === "service" || r.k === "living_street") continue;
      const major = MAJOR.has(r.k);
      const lanes = r.ln || (major ? (r.ow ? 2 : 4) : r.ow ? 1 : 2);
      if (!r.ow && major) {
        // double yellow centre line
        ctx.beginPath(); linePath(ctx, offsetLine(r.pts, 0.12)); linePath(ctx, offsetLine(r.pts, -0.12));
        ctx.lineCap = "butt"; ctx.lineWidth = 0.12; ctx.strokeStyle = PAL.centre; ctx.stroke();
      }
      const per = r.ow ? lanes : Math.floor(lanes / 2);
      if (per >= 2) {
        const lw = (r.w - 1) / lanes;
        ctx.setLineDash([3, 9]);
        ctx.beginPath();
        for (let l = 1; l < per; l++) {
          if (r.ow) linePath(ctx, offsetLine(r.pts, -r.w / 2 + 0.5 + l * lw));
          else { linePath(ctx, offsetLine(r.pts, l * lw)); linePath(ctx, offsetLine(r.pts, -l * lw)); }
        }
        ctx.lineCap = "butt"; ctx.lineWidth = 0.13; ctx.strokeStyle = PAL.lane; ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  // Bridges: a shadow on whatever is beneath, the deck's edge (its thickness, seen from above), the deck, then railings
  // either side, their top rail a metre up.
  function drawBridges(ctx, r, cam, roadIds, pathIds, k, G) {
    const o = geo.ROTS[r];
    const sx = SH_U * o.R[0] + SH_V * o.D[0], sy = SH_U * o.R[1] + SH_V * o.D[1];
    const items = [];
    for (const i of roadIds) { const rd = data.roads[i]; if (k < 0.3 && rd.k === "service") continue; items.push([rd.pts, Math.max(rd.w, 1.2 / k), roadCol(rd, G), 1.3]); }
    for (const i of pathIds) { const p = data.paths[i]; if (k < 0.35 && p.k !== "pedestrian") continue; items.push([p.pts, Math.max(p.w, 0.8 / k), pathCol(p, G), 0.5]); }
    // shadow
    ctx.save();
    ctx.translate(sx * 2.5, sy * 2.5);
    for (const [pts, w, , e] of items) stroke(ctx, pts, w + 2 * e + 0.6, "rgba(38,50,60,.16)", "butt");
    ctx.restore();
    // the deck's edge, one metre deep: the same strokes a metre lower
    setWorld(ctx, cam, r, -1.1);
    for (const [pts, w, , e] of items) stroke(ctx, pts, w + 2 * e, "#8c8478", "butt");
    setWorld(ctx, cam, r);
    for (const [pts, w, , e] of items) stroke(ctx, pts, w + 2 * e, G.curb === PAL.curb ? "#cdc5b6" : G.curb, "butt");
    for (const [pts, w, col] of items) stroke(ctx, pts, w, col, "butt");
    if (k < 1) return;
    // railings: posts as a dashed line standing up, then the rail
    for (const [pts, w, , e] of items) {
      for (const s of [-1, 1]) {
        const rail = offsetLine(pts, s * (w / 2 + e - 0.2));
        if (k >= 2.5) {
          for (let z = 0.35; z <= 0.75; z += 0.4) { setWorld(ctx, cam, r, z); stroke(ctx, rail, 0.07, "rgba(70,66,60,.55)", "butt"); }
        }
        setWorld(ctx, cam, r, 1.05);
        stroke(ctx, rail, 0.16, "#6f675d", "butt");
      }
    }
    setWorld(ctx, cam, r);
    if (k >= 2) {
      // markings on bridged roads continue
      drawRoadMarkingsOnly(ctx, roadIds, k, G);
    }
  }
  function drawRoadMarkingsOnly(ctx, ids, k, G) {
    for (const i of ids) {
      const r = data.roads[i];
      if (r.k === "service" || !MAJOR.has(r.k) || r.ow) continue;
      ctx.beginPath(); linePath(ctx, offsetLine(r.pts, 0.12)); linePath(ctx, offsetLine(r.pts, -0.12));
      ctx.lineCap = "butt"; ctx.lineWidth = 0.12; ctx.strokeStyle = PAL.centre; ctx.stroke();
    }
  }

  function drawCrossings(ctx, r, cam, X0, Y0, X1, Y1, k) {
    if (k < 1.5) return;
    const cr = data.crossings;
    const o = geo.ROTS[r];
    ctx.fillStyle = "rgba(247,245,238,.94)";
    for (let c = 0; c < cr.length; c += 2) {
      const x = cr[c], y = cr[c + 1];
      const X = x * o.R[0] + y * o.R[1], Y = -(x * o.D[0] + y * o.D[1]) * S;
      if (X < X0 - 15 || X > X1 + 15 || Y < Y0 - 15 || Y > Y1 + 15) continue;
      // the road this crossing sits on: the nearest segment
      const near = scene.query(r, "roads", X - 1, Y - 1, X + 1, Y + 1);
      let best = null, bd = Infinity;
      for (const i of near) {
        const rd = data.roads[i];
        if (rd.br || rd.tn) continue;
        const f = rd.pts;
        for (let p = 2; p < f.length; p += 2) {
          const ax = f[p - 2], ay = f[p - 1], bx = f[p], by = f[p + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
          const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
          if (d < bd) { bd = d; best = { rd, ang: Math.atan2(dy, dx) }; }
        }
      }
      if (!best || bd > best.rd.w / 2 + 1.5 || best.rd.k === "service") continue;
      // continental bars: parallel to the road, across its width, 3 m long
      ctx.save();
      ctx.translate(x, y); ctx.rotate(best.ang);
      const half = best.rd.w / 2 - 0.3;
      ctx.beginPath();
      for (let s = -half; s < half - 0.3; s += 1.1) ctx.rect(-1.5, s, 3, 0.55);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawBarriers(ctx, r, cam, ids, k, G) {
    for (const i of ids) {
      const b = data.barriers[i];
      if (b.k === "hedge") {
        stroke(ctx, b.pts, 1.5, sh(G.hedge, 0.8));
        setWorld(ctx, cam, r, 0.7);
        stroke(ctx, b.pts, 1.2, G.hedge);
        if (k >= 2) { ctx.translate(-0.15, 0.15); stroke(ctx, b.pts, 0.5, sh(G.hedge, 1.15)); }
        setWorld(ctx, cam, r);
      } else if (b.k === "wall" || b.k === "retaining_wall" || b.k === "city_wall") {
        // a low wall: its face, then its lit coping 0.8 m up
        stroke(ctx, b.pts, 0.5, sh(PAL.wall, 0.8), "butt");
        setWorld(ctx, cam, r, 0.8);
        stroke(ctx, b.pts, 0.5, PAL.wall, "butt");
        setWorld(ctx, cam, r);
      } else if (k >= 2) {
        // a fence: posts every 2.5 m, a top rail
        setWorld(ctx, cam, r, 1.2);
        stroke(ctx, b.pts, 0.08, rgba(PAL.fence, 0.8), "butt");
        setWorld(ctx, cam, r);
        stroke(ctx, b.pts, 0.08, rgba(PAL.fence, 0.35), "butt");
      }
    }
  }

  // leaves fallen round the trunks: a warm soft disc under each broad-leaved tree
  function drawLitter(ctx, r, cam, objIds, k, G) {
    const spr = softSprite("litter");
    if (!spr) return;
    const tr = data.trees;
    const a0 = ctx.globalAlpha;
    for (const i of objIds) {
      if (i < B || i >= B + T) continue;
      const t = i - B;
      if (tr[5 * t + 4] & 1) continue;
      const x = tr[5 * t], y = tr[5 * t + 1], rr = tr[5 * t + 2] * 1.25;
      ctx.globalAlpha = a0 * G.litter * (0.6 + 0.8 * nHash(t * 31 + 5));
      ctx.drawImage(spr, x - rr, y - rr, rr * 2, rr * 2);
    }
    ctx.globalAlpha = a0;
  }

  // ================================================================ parked cars
  // Slots are laid out once per parking aisle, stall, small lot and driveway (in ground metres, the same in every worker
  // and rotation), as [x, y, angle, seed, lines] per slot. A slot holds a car when its hash is under the lot's fill; seed
  // is then that hash over the fill (0..1, which picks the car's paint and shape), else 2 (empty).
  const slotCache = new Map();
  const PITCH = 2.7, DEPTH = 5.1;
  const lotFill = (ai) => 0.38 + 0.5 * nHash(ai * 7907 + 3);
  function aisleSlots(ri, r) {
    const key = "a" + ri;
    let out = slotCache.get(key);
    if (out) return out;
    const rd = data.roads[ri], f = rd.pts, half = rd.w / 2;
    const bb = ringBox(f), pad = half + DEPTH + 4;
    const areas = nearGround(r, "areas", bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad);
    const lots = [], stalls = [];
    for (const ai of areas) { const a = data.areas[ai]; if (a.k === "parking") lots.push(ai); else if (a.k === "stall") stalls.push(a); }
    const res = [];
    if (lots.length) {
      const others = nearGround(r, "roads", bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad).filter((j) => j !== ri && !data.roads[j].tn);
      const objs = nearGround(r, "objects", bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad).filter((j) => j < B && !data.buildings[j].mh);
      const n = f.length / 2;
      let carry = PITCH / 2 + 0.6;
      for (let s = 1; s < n; s++) {
        const ax = f[2 * s - 2], ay = f[2 * s - 1], bx = f[2 * s], by = f[2 * s + 1];
        const L = Math.hypot(bx - ax, by - ay);
        if (L < 0.01) continue;
        const tx = (bx - ax) / L, ty = (by - ay) / L, nx = -ty, ny = tx;
        for (let d = carry; d < L - 0.6; d += PITCH) {
          const px = ax + tx * d, py = ay + ty * d;
          for (let side = -1; side <= 1; side += 2) {
            const off = half + 0.25 + DEPTH / 2;
            const cx = px + nx * side * off, cy = py + ny * side * off;
            let lot = -1;
            for (const ai of lots) if (ptInRings(data.areas[ai].p, cx, cy)) { lot = ai; break; }
            if (lot < 0) continue;
            const la = data.areas[lot].p;
            // the whole stall must be in the lot: its four corners
            let ok = true;
            for (let c = 0; c < 4 && ok; c++) {
              const u = (c & 1 ? 1 : -1) * (PITCH / 2 - 0.25), v = (c & 2 ? 1 : -1) * (DEPTH / 2 - 0.2);
              if (!ptInRings(la, cx + tx * u + nx * side * v, cy + ty * u + ny * side * v)) ok = false;
            }
            if (!ok) continue;
            for (const st of stalls) if (ptInRings(st.p, cx, cy)) { ok = false; break; }
            if (!ok) continue;
            for (const j of others) { const o2 = data.roads[j]; if (lineDist(o2.pts, cx, cy) < o2.w / 2 + 2.2) { ok = false; break; } }
            if (!ok) continue;
            for (const j of objs) if (ptInRing(data.buildings[j].p[0], cx, cy)) { ok = false; break; }
            if (!ok) continue;
            const seed = nHash((Math.round(cx * 10) * 73856093) ^ (Math.round(cy * 10) * 19349663));
            const fill = lotFill(lot);
            res.push(cx, cy, Math.atan2(ny * side, nx * side), seed < fill ? seed / fill : 2, 1);
          }
        }
        carry = Math.max(0.6, carry - L + Math.ceil((L - carry) / PITCH) * PITCH);
        if (carry > PITCH) carry -= PITCH;
      }
    }
    out = new Float32Array(res);
    slotCache.set(key, out);
    return out;
  }
  function stallSlot(ai) {
    const key = "s" + ai;
    let out = slotCache.get(key);
    if (out) return out;
    const a = data.areas[ai], o = areaObb(ai);
    out = new Float32Array(0);
    if (o && o.L > 3.6 && o.L < 9 && o.W > 1.9 && o.W < 4.5) {
      const seed = nHash(ai * 2654435761 + 17);
      // nose in: either way along the stall
      out = new Float32Array([o.cx, o.cy, o.ang + (nHash(ai + 5) < 0.5 ? Math.PI : 0), seed < 0.78 ? seed / 0.78 : 2, 0]);
    }
    slotCache.set(key, out);
    return out;
  }
  // a lot with no aisles or stalls mapped: a row along each long side
  function lotSlots(ai, r) {
    const key = "p" + ai;
    let out = slotCache.get(key);
    if (out) return out;
    const a = data.areas[ai], o = areaObb(ai), bb = areaBox(ai);
    const res = [];
    if (o && o.W >= 5.4 && o.L >= 6 && a.A < 20000 && a.su !== "grass") {
      const roads = nearGround(r, "roads", bb[0] - 4, bb[1] - 4, bb[2] + 4, bb[3] + 4);
      let served = false;
      for (const j of roads) {
        const rd = data.roads[j];
        if (rd.sv !== "parking_aisle") continue;
        const p = rd.pts;
        for (let q = 0; q < p.length && !served; q += 2) if (ptInRings(a.p, p[q], p[q + 1])) served = true;
        if (served) break;
      }
      if (!served) for (const j of nearGround(r, "areas", bb[0], bb[1], bb[2], bb[3])) {
        const s2 = data.areas[j];
        if (s2.k === "stall") { const bb2 = areaBox(j); if (ptInRings(a.p, (bb2[0] + bb2[2]) / 2, (bb2[1] + bb2[3]) / 2)) { served = true; break; } }
      }
      if (!served) {
        const ux = Math.cos(o.ang), uy = Math.sin(o.ang), vx = -uy, vy = ux;
        const sides = o.W >= 10.5 ? [-1, 1] : [nHash(ai) < 0.5 ? -1 : 1];
        const fill = lotFill(ai);
        for (const s of sides) {
          const off = o.W / 2 - DEPTH / 2 - 0.3;
          for (let d = -o.L / 2 + PITCH / 2 + 0.6; d < o.L / 2 - PITCH / 2 - 0.4; d += PITCH) {
            const cx = o.cx + ux * d + vx * s * off, cy = o.cy + uy * d + vy * s * off;
            let ok = true;
            for (let c = 0; c < 4 && ok; c++) {
              const u = (c & 1 ? 1 : -1) * (PITCH / 2 - 0.25), v = (c & 2 ? 1 : -1) * (DEPTH / 2 - 0.2);
              if (!ptInRings(a.p, cx + ux * u + vx * v, cy + uy * u + vy * v)) ok = false;
            }
            if (!ok) continue;
            const seed = nHash((Math.round(cx * 10) * 73856093) ^ (Math.round(cy * 10) * 19349663));
            res.push(cx, cy, Math.atan2(vy * s, vx * s), seed < fill ? seed / fill : 2, 1);
          }
        }
      }
    }
    out = new Float32Array(res);
    slotCache.set(key, out);
    return out;
  }
  function drivewaySlot(ri, r) {
    const key = "d" + ri;
    let out = slotCache.get(key);
    if (out) return out;
    const rd = data.roads[ri], f = rd.pts;
    out = new Float32Array(0);
    let len = 0;
    for (let q = 2; q < f.length; q += 2) len += Math.hypot(f[q] - f[q - 2], f[q + 1] - f[q - 1]);
    const seed = nHash(ri * 2246822519 + 7);
    if (len > 10 && seed < 0.55) {
      // halfway up the drive
      let d = len * (0.42 + 0.16 * nHash(ri + 11));
      for (let q = 2; q < f.length; q += 2) {
        const L = Math.hypot(f[q] - f[q - 2], f[q + 1] - f[q - 1]);
        if (d <= L && L > 4.6) {
          const tx = (f[q] - f[q - 2]) / L, ty = (f[q + 1] - f[q - 1]) / L;
          const t = clamp(d, 2.4, L - 2.4);
          const cx = f[q - 2] + tx * t, cy = f[q - 1] + ty * t;
          let ok = true;
          for (const j of nearGround(r, "objects", cx - 3, cy - 3, cx + 3, cy + 3)) if (j < B && ptInRing(data.buildings[j].p[0], cx, cy)) { ok = false; break; }
          if (ok) out = new Float32Array([cx, cy, Math.atan2(ty, tx) + (seed < 0.3 ? Math.PI : 0), seed / 0.55, 0]);
          break;
        }
        d -= L;
      }
    }
    slotCache.set(key, out);
    return out;
  }

  const paintCum = (() => { let t = 0; return PAINT.map((p) => (t += p[1])); })();
  const paintOf = (s) => { const x = s * paintCum[paintCum.length - 1]; for (let i = 0; i < paintCum.length; i++) if (x < paintCum[i]) return i; return 0; };
  const SLOTS = [];          // gathered per tile: [array, offset]
  const carOrder = [];
  function drawParked(ctx, r, cam, roadIds, areaIds, gb, k) {
    SLOTS.length = 0;
    for (const ri of roadIds) {
      const rd = data.roads[ri];
      if (rd.sv === "parking_aisle" && !rd.tn) SLOTS.push(aisleSlots(ri, r));
      else if (rd.sv === "driveway" && !rd.tn && k >= 0.5) SLOTS.push(drivewaySlot(ri, r));
    }
    for (const ai of areaIds) {
      const a = data.areas[ai];
      if (a.k === "stall") SLOTS.push(stallSlot(ai));
      else if (a.k === "parking") SLOTS.push(lotSlots(ai, r));
    }
    const x0 = gb[0] - 3, y0 = gb[1] - 3, x1 = gb[2] + 3, y1 = gb[3] + 3;
    const o = geo.ROTS[r];
    // painted stall lines between the slots (whether or not a car is in them)
    if (k >= 2) {
      ctx.beginPath();
      for (const arr of SLOTS) for (let s = 0; s < arr.length; s += 5) {
        if (!arr[s + 4]) continue;
        const x = arr[s], y = arr[s + 1];
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        const ca = Math.cos(arr[s + 2]), sa = Math.sin(arr[s + 2]);
        for (const e of [-1, 1]) {
          const bx = x - sa * e * PITCH / 2, by = y + ca * e * PITCH / 2;
          ctx.moveTo(bx - ca * (DEPTH / 2 - 0.1), by - sa * (DEPTH / 2 - 0.1)); ctx.lineTo(bx + ca * (DEPTH / 2 - 0.4), by + sa * (DEPTH / 2 - 0.4));
        }
      }
      ctx.lineCap = "butt"; ctx.lineWidth = 0.12; ctx.strokeStyle = "rgba(248,246,238,.75)"; ctx.stroke();
    }
    // the cars, far ones first
    carOrder.length = 0;
    for (let a = 0; a < SLOTS.length; a++) {
      const arr = SLOTS[a];
      for (let s = 0; s < arr.length; s += 5) {
        if (arr[s + 3] > 1) continue;
        const x = arr[s], y = arr[s + 1];
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        carOrder.push(a * 1e6 + s);
      }
    }
    if (!carOrder.length) return;
    const dep = (id) => { const arr = SLOTS[Math.floor(id / 1e6)], s = id % 1e6; return arr[s] * o.D[0] + arr[s + 1] * o.D[1]; };
    if (k < 0.8) { parkedSpecks(ctx, r, cam, k); return; }
    carOrder.sort((p, q) => dep(q) - dep(p));
    // soft shadows under them all, then each car
    const sx = SH_U * o.R[0] + SH_V * o.D[0], sy = SH_U * o.R[1] + SH_V * o.D[1];
    ctx.beginPath();
    for (const id of carOrder) {
      const arr = SLOTS[Math.floor(id / 1e6)], s = id % 1e6;
      const x = arr[s] + sx * 0.7, y = arr[s + 1] + sy * 0.7, ca = Math.cos(arr[s + 2]), sa = Math.sin(arr[s + 2]);
      const l = 2.45, w = 1.05;
      ctx.moveTo(x + ca * l - sa * w, y + sa * l + ca * w); ctx.lineTo(x + ca * l + sa * w, y + sa * l - ca * w);
      ctx.lineTo(x - ca * l + sa * w, y - sa * l - ca * w); ctx.lineTo(x - ca * l - sa * w, y - sa * l + ca * w);
    }
    ctx.fillStyle = "rgba(38,50,60,.2)"; ctx.fill();
    setScreen(ctx, cam);
    for (const id of carOrder) {
      const arr = SLOTS[Math.floor(id / 1e6)], s = id % 1e6;
      drawCar(ctx, r, arr[s], arr[s + 1], arr[s + 2], arr[s + 3], k);
    }
    setWorld(ctx, cam, r);
  }
  // From afar a parked car is a pixel or two of its paint. A big lot holds thousands, and as many tiny antialiased paths
  // cost about a second a tile, so they are written straight into an image (blended by hand, a soft shadow pixel under
  // each), which is then laid on the tile: a millisecond or two.
  const PAINT_RGB = PAINT.map((p) => hexToRgb(p[0]));
  let speckImg = null;
  function parkedSpecks(ctx, r, cam, k) {
    if (!canMakeCanvas) return;
    const W = ctx.canvas.width, H = ctx.canvas.height;
    if (!speckImg || speckImg.width !== W || speckImg.height !== H) speckImg = { width: W, height: H, img: new ImageData(W, H), canvas: new OffscreenCanvas(W, H) };
    const px = speckImg.img.data;
    px.fill(0);
    const o = geo.ROTS[r];
    // a car's length and width in pixels: specks are a pixel at 0.25 px/m, two along the car at 0.5 px/m
    const along = k >= 0.45 ? 2 : 1, cover = k >= 0.45 ? 0.95 : 0.8;
    // blend a colour into pixel (x, y) by alpha a (straight alpha, as ImageData holds it)
    const put = (x, y, c, a) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const p = 4 * (y * W + x), a0 = px[p + 3] / 255, ao = a + a0 * (1 - a);
      if (ao <= 0) return;
      for (let q = 0; q < 3; q++) px[p + q] = (c[q] * a + px[p + q] * a0 * (1 - a)) / ao;
      px[p + 3] = ao * 255;
    };
    const SHADOW = [38, 50, 60];
    let any = false;
    for (const id of carOrder) {
      const arr = SLOTS[Math.floor(id / 1e6)], s = id % 1e6;
      const x = arr[s], y = arr[s + 1];
      const X = (x * o.R[0] + y * o.R[1]) * k - cam.ox, Y = -(x * o.D[0] + y * o.D[1]) * S * k - cam.oy;
      const ix = Math.floor(X), iy = Math.floor(Y);
      if (ix < -2 || iy < -2 || ix > W + 1 || iy > H + 1) continue;
      any = true;
      const col = PAINT_RGB[paintOf(arr[s + 3])];
      // the car's axis on the screen picks which neighbour the second pixel goes in
      const ca = Math.cos(arr[s + 2]), sa = Math.sin(arr[s + 2]);
      const fx = ca * o.R[0] + sa * o.R[1], fy = -(ca * o.D[0] + sa * o.D[1]) * S;
      const dx = Math.abs(fx) >= Math.abs(fy) ? 1 : 0, dy = 1 - dx;
      put(ix + 1, iy + 1, SHADOW, 0.22);
      put(ix, iy, col, cover);
      if (along > 1) put(ix + dx, iy + dy, col, cover * 0.85);
    }
    if (!any) return;
    const g = speckImg.canvas.getContext("2d");
    g.putImageData(speckImg.img, 0, 0);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(speckImg.canvas, 0, 0);
    ctx.restore();
  }
  // a parked car: a body and a glasshouse, each a box, their camera-facing sides and tops (in screen metres)
  const CQ = new Float64Array(16);
  function drawCar(ctx, r, x, y, ang, seed, k, lift = 0) {
    const o = geo.ROTS[r];
    const type = seed * 7.3 % 1;   // a second number from the same seed
    const L = type < 0.55 ? 4.5 : type < 0.85 ? 4.8 : 4.1, W = type < 0.55 ? 1.8 : type < 0.85 ? 1.95 : 1.75, H = type < 0.55 ? 1.42 : type < 0.85 ? 1.72 : 1.48;
    const paint = PAINT[paintOf(seed)][0];
    const fx = Math.cos(ang), fy = Math.sin(ang), rx = fy, ry = -fx;
    const X = x * o.R[0] + y * o.R[1], Y = -(x * o.D[0] + y * o.D[1]) * S - lift * C;
    const Fx = fx * o.R[0] + fy * o.R[1], Fy = -(fx * o.D[0] + fy * o.D[1]) * S;
    const Rx = rx * o.R[0] + ry * o.R[1], Ry = -(rx * o.D[0] + ry * o.D[1]) * S;
    const fd = fx * o.D[0] + fy * o.D[1], rd = rx * o.D[0] + ry * o.D[1];
    const fu = fx * o.R[0] + fy * o.R[1], ru = rx * o.R[0] + ry * o.R[1];
    const zb = H * 0.6;
    carBox(ctx, X, Y, Fx, Fy, Rx, Ry, fd, rd, fu, ru, -L / 2, L / 2, W / 2, 0.28, zb, paint, paint, k);
    if (k >= 1.5) carBox(ctx, X, Y, Fx, Fy, Rx, Ry, fd, rd, fu, ru, -L * 0.3 - (type >= 0.55 && type < 0.85 ? 0.35 : 0), L * 0.17, W / 2 - 0.14, zb, H, "#4a5763", sh(paint, 1.06), k);
    else {
      // just the glass roof as a darker patch
      const a0 = -L * 0.28, a1 = L * 0.17, w = W / 2 - 0.16, z = zb * C;
      ctx.fillStyle = "#56606a";
      ctx.beginPath();
      ctx.moveTo(X + Fx * a0 - Rx * w, Y + Fy * a0 - Ry * w - z); ctx.lineTo(X + Fx * a1 - Rx * w, Y + Fy * a1 - Ry * w - z);
      ctx.lineTo(X + Fx * a1 + Rx * w, Y + Fy * a1 + Ry * w - z); ctx.lineTo(X + Fx * a0 + Rx * w, Y + Fy * a0 + Ry * w - z); ctx.closePath();
      ctx.fill();
    }
  }
  function carBox(ctx, X, Y, Fx, Fy, Rx, Ry, fd, rd, fu, ru, a0, a1, w, z0, z1, side, top, k) {
    const zb = z0 * C, zt = z1 * C;
    // 0 rear-left 1 front-left 2 front-right 3 rear-right (bottom), +8 the same on top
    CQ[0] = X + Fx * a0 - Rx * w; CQ[1] = Y + Fy * a0 - Ry * w;
    CQ[2] = X + Fx * a1 - Rx * w; CQ[3] = Y + Fy * a1 - Ry * w;
    CQ[4] = X + Fx * a1 + Rx * w; CQ[5] = Y + Fy * a1 + Ry * w;
    CQ[6] = X + Fx * a0 + Rx * w; CQ[7] = Y + Fy * a0 + Ry * w;
    const face = (i, j, nu, nd) => {
      ctx.fillStyle = sh(side, 0.72 + 0.3 * lightOf(nu, nd));
      ctx.beginPath();
      ctx.moveTo(CQ[2 * i], CQ[2 * i + 1] - zb); ctx.lineTo(CQ[2 * j], CQ[2 * j + 1] - zb);
      ctx.lineTo(CQ[2 * j], CQ[2 * j + 1] - zt); ctx.lineTo(CQ[2 * i], CQ[2 * i + 1] - zt); ctx.closePath();
      ctx.fill();
    };
    if (k >= 1.5) {
      if (fd < 0) face(1, 2, fu, fd); else face(3, 0, -fu, -fd);
      if (rd < 0) face(2, 3, ru, rd); else face(0, 1, -ru, -rd);
    }
    ctx.fillStyle = k >= 1.5 ? sh(top, 1.04) : top;
    ctx.beginPath();
    ctx.moveTo(CQ[0], CQ[1] - zt); ctx.lineTo(CQ[2], CQ[3] - zt); ctx.lineTo(CQ[4], CQ[5] - zt); ctx.lineTo(CQ[6], CQ[7] - zt); ctx.closePath();
    ctx.fill();
  }

  // ================================================================ shadows
  function drawShadows(ctx, r, cam, X0, Y0, X1, Y1) {
    const k = cam.k;
    // a shadow falls to the right and up the screen: look left and down for its casters
    const ids = scene.query(r, "objects", X0 - 80, Y0 - 4, X1 + 4, Y1 + 40);
    if (!ids.length) return;
    let sctx = ctx, off = null;
    if (canMakeCanvas) {
      off = getScratch(ctx.canvas.width, ctx.canvas.height);
      sctx = off.getContext("2d");
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.globalAlpha = 1; sctx.globalCompositeOperation = "source-over";
      sctx.clearRect(0, 0, off.width, off.height);
    }
    const o = geo.ROTS[r];
    // the shadow vector per metre of height, in ground metres
    const sx = SH_U * o.R[0] + SH_V * o.D[0], sy = SH_U * o.R[1] + SH_V * o.D[1];
    // (drawBase calls this inside the world's clip: the mask may run past the edge, the tile it lands on can't)
    setWorld(sctx, cam, r);
    sctx.fillStyle = "#000";
    sctx.save();
    // buildings: their hulls all turn the same way, so they simply union. They come as ready-made paths, one per cell of
    // a grid (built once per rotation, in ground metres): a far tile fills a few hundred of them where it used to add
    // every corner of thousands of buildings (most of a whole-world tile's time went into that).
    if (shadowGridOK) {
      const grid = shadowGrid(r, k <= 0.3 ? 1 : 0, sx, sy);
      const stamp = ++shadowStamp;
      for (const i of ids) {
        if (i >= B) continue;
        const c = grid.of[i];
        if (c < 0 || grid.seen[c] === stamp) continue;
        grid.seen[c] = stamp;
        let p = grid.paths[c];
        if (p === undefined) p = grid.paths[c] = shadowCellPath(grid, c, r, sx, sy);
        if (p) sctx.fill(p);
      }
    } else {
      sctx.beginPath();
      for (const i of ids) {
        if (i >= B) continue;
        const poly = shadowPoly(i, r, sx, sy);
        if (!poly) continue;
        sctx.moveTo(poly[0], poly[1]);
        for (let q = 2; q < poly.length; q += 2) sctx.lineTo(poly[q], poly[q + 1]);
        sctx.closePath();
      }
      sctx.fill();
    }
    // trees: soft discs; bare ones throw a thin, dappled shade
    const soft = off && k >= 0.45 ? softSprite("shadow") : null;
    if (soft) {
      const tr = data.trees;
      for (const i of ids) {
        if (i < B || i >= B + T) continue;
        const t = i - B, x = tr[5 * t], y = tr[5 * t + 1], rad = tr[5 * t + 2], h = tr[5 * t + 3], fl = tr[5 * t + 4];
        const bare = treeBare(t, currentStyle), needle = fl & 1;
        const cz = needle ? h * 0.45 : Math.max(h - rad, h * 0.55), rr = rad * (needle ? 1.15 : bare ? 1.0 : 1.25);
        sctx.globalAlpha = needle ? 0.95 : bare ? 0.34 : 0.9;
        sctx.drawImage(soft, x + sx * cz - rr, y + sy * cz - rr, rr * 2, rr * 2);
      }
      sctx.globalAlpha = 1;
    }
    sctx.restore();
    if (off) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = currentStyle && currentStyle.snow > 0.3 ? 0.17 : 0.21;
      ctx.globalCompositeOperation = "multiply";
      // tint the mask: colour it with source-in on the scratch, then lay it on
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.globalCompositeOperation = "source-in";
      sctx.fillStyle = PAL.shadow; sctx.fillRect(0, 0, off.width, off.height);
      sctx.globalCompositeOperation = "source-over";
      ctx.drawImage(off, 0, 0);
      ctx.restore();
    }
  }
  // A building's shadow on the ground: the convex hull of its outline lifted to its base and to its top, both pushed
  // along the shadow vector. (Exact for convex outlines; a little generous in the notch of an L.)
  const shadowCache = new Map();
  function shadowPoly(i, r, sx, sy) {
    const key = i * 4 + r;
    let poly = shadowCache.get(key);
    if (poly !== undefined) return poly;
    const b = data.buildings[i];
    poly = null;
    if (!b.hidden) {
      const f = b.p[0], n = f.length / 2, h = b.h, mh = b.mh || 0;
      const pts = [];
      for (let a = 0; a < n; a++) {
        pts.push([f[2 * a] + sx * mh, f[2 * a + 1] + sy * mh]);
        pts.push([f[2 * a] + sx * h, f[2 * a + 1] + sy * h]);
      }
      const hull = hull2(pts);
      if (hull.length >= 3) {
        // make every hull turn the same way, so overlapping ones union under the nonzero rule
        const flat = hull.flat();
        poly = new Float32Array(ringArea(flat) < 0 ? flat.reverse().map((v, q, arr) => arr[q ^ 1]) : flat);
      }
    }
    shadowCache.set(key, poly);
    return poly;
  }
  // The grid the building shadows are cached in: a building belongs to the cell of its footprint's first corner. Two
  // sizes: fine cells for near tiles (few buildings each, so a tile fills little it doesn't show) and coarse ones for
  // the far levels (a whole-world tile fills ~60 paths instead of ~1000).
  const shadowGridOK = typeof Path2D !== "undefined";
  const SH_CELLS = [128, 1024];
  const shadowGrids = new Map();
  let shadowStamp = 0;
  function shadowGrid(r, coarse, sx, sy) {
    const key = r * 2 + coarse;
    let g = shadowGrids.get(key);
    if (g) return g;
    const w = data.world, size = SH_CELLS[coarse];
    const cols = Math.max(1, Math.ceil((w.x1 - w.x0) / size) + 1), rows = Math.max(1, Math.ceil((w.y1 - w.y0) / size) + 1);
    const of = new Int32Array(B).fill(-1), members = new Map();
    for (let i = 0; i < B; i++) {
      const b = data.buildings[i];
      if (b.hidden) continue;
      const f = b.p[0];
      const cx = clamp(Math.floor((f[0] - w.x0) / size), 0, cols - 1), cy = clamp(Math.floor((f[1] - w.y0) / size), 0, rows - 1);
      const c = cy * cols + cx;
      of[i] = c;
      let list = members.get(c);
      if (!list) members.set(c, (list = []));
      list.push(i);
    }
    g = { of, members, paths: new Array(cols * rows), seen: new Int32Array(cols * rows) };
    shadowGrids.set(key, g);
    return g;
  }
  function shadowCellPath(g, c, r, sx, sy) {
    const p = new Path2D();
    let any = false;
    for (const i of g.members.get(c) || []) {
      const poly = shadowPoly(i, r, sx, sy);
      if (!poly) continue;
      p.moveTo(poly[0], poly[1]);
      for (let q = 2; q < poly.length; q += 2) p.lineTo(poly[q], poly[q + 1]);   // (left open: see quadF)
      any = true;
    }
    return any ? p : null;
  }

  let scratch = null;
  function getScratch(w, h) {
    if (!scratch || scratch.width !== w || scratch.height !== h) scratch = new OffscreenCanvas(w, h);
    return scratch;
  }
  const sprites = {};
  function softSprite(kind) {
    if (!canMakeCanvas) return null;
    if (sprites[kind]) return sprites[kind];
    const c = new OffscreenCanvas(64, 64), g = c.getContext("2d");
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    if (kind === "shadow") { gr.addColorStop(0, "rgba(0,0,0,1)"); gr.addColorStop(0.55, "rgba(0,0,0,.85)"); gr.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); }
    else if (kind === "litter") {
      gr.addColorStop(0, "rgba(176,112,58,.55)"); gr.addColorStop(0.6, "rgba(170,110,60,.35)"); gr.addColorStop(1, "rgba(170,110,60,0)");
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      // and a scatter of single leaves
      const rnd = rng(77);
      for (let s = 0; s < 90; s++) {
        const a = rnd() * TAU, d = Math.sqrt(rnd()) * 30;
        g.fillStyle = ["rgba(150,85,40,.7)", "rgba(190,130,60,.7)", "rgba(120,80,45,.6)"][s % 3];
        g.fillRect(32 + Math.cos(a) * d, 32 + Math.sin(a) * d, 2, 1.5);
      }
    } else if (kind === "haze" || kind === "haze-w") {
      // the twigs of a bare crown: dense in the middle, thinning to nothing at the edge
      const c = kind === "haze" ? "130,100,84" : "120,106,100";
      gr.addColorStop(0, `rgba(${c},1)`); gr.addColorStop(0.55, `rgba(${c},.8)`); gr.addColorStop(0.85, `rgba(${c},.3)`); gr.addColorStop(1, `rgba(${c},0)`);
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    } else if (kind === "pool") { gr.addColorStop(0, "rgba(255, 210, 140, .5)"); gr.addColorStop(1, "rgba(255, 210, 140, 0)"); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); }
    else { gr.addColorStop(0, "rgba(255, 236, 190, 1)"); gr.addColorStop(1, "rgba(255, 220, 160, 0)"); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); }
    return (sprites[kind] = c);
  }

  // ================================================================ objects
  function drawObject(ctx, r, cam, i, style) {
    currentStyle = style || currentStyle;
    if (DBG.on) { DBG.id = i; DBG.part = 0; }
    if (i < B) drawBuilding(ctx, r, cam, i, currentStyle);
    else if (i < B + T) drawTree(ctx, r, cam, i - B, currentStyle);
    else drawLamp(ctx, r, cam, i - B - T);
  }

  /** Draw a list of objects (already in back-to-front order) with the given camera: for the main thread. */
  function drawObjects(ctx, r, cam, ids, style) {
    ctx.save();
    for (const i of ids) drawObject(ctx, r, cam, i, style);
    ctx.restore();
  }

  // ---------------------------------------------------------------- trees
  // which broad-leaved trees stand bare (life.js knows this rule too, to clip cars to the trees' outlines)
  function treeBare(t, style) {
    const season = (style && style.season) || "summer";
    const h = nHash(t * 2654435761);
    if (data.trees[5 * t + 4] & 1) return false;           // conifers keep their needles
    if (season === "winter") return true;
    if (season === "late-autumn") return h < 0.72;
    return false;
  }

  // Templates: each tree shape is a few Path2Ds made once and drawn under a per-tree transform.
  // Bare trees: unit = the tree's screen height, origin at the foot of the trunk, y down. The crown is a circle of
  // radius a (the bucket's crown-to-height ratio) centred where the leafy crown would be.
  const BARE_A = [0.26, 0.36, 0.48, 0.62];
  const bareTpls = [];
  function bareTemplate(bucket, variant) {
    const key = bucket * 4 + variant;
    if (bareTpls[key]) return bareTpls[key];
    const a = BARE_A[bucket];
    const rnd = rng(9173 + key * 7919);
    const ccy = -Math.max(1 - a * C, 0.55), rx = a * 0.96, ry = a * 0.98;
    const inCrown = (x, y) => (x / rx) ** 2 + ((y - ccy) / ry) ** 2 <= 1;
    const l1 = new Path2D(), l2 = new Path2D(), l3 = new Path2D(), tips = new Path2D(), tipsMany = new Path2D();
    const fork = Math.min(-0.24, ccy + ry * 0.62);
    const lean = (rnd() - 0.5) * 0.04;
    // the trunk, tapering
    const trunk = new Path2D();
    const tw0 = 0.03 + a * 0.012, tw1 = 0.016;
    trunk.moveTo(-tw0, 0); trunk.lineTo(tw0, 0); trunk.lineTo(lean + tw1, fork); trunk.lineTo(lean - tw1, fork); trunk.closePath();
    let tipN = 0;
    const branch = (x, y, ang, len, level) => {
      // shorten to stay inside the crown
      let ex = x + Math.cos(ang) * len, ey = y + Math.sin(ang) * len;
      for (let g = 0; g < 6 && !inCrown(ex, ey); g++) { len *= 0.8; ex = x + Math.cos(ang) * len; ey = y + Math.sin(ang) * len; }
      // a slight bend: the midpoint nudged sideways
      const mx2 = (x + ex) / 2 + Math.cos(ang + Math.PI / 2) * len * (rnd() - 0.5) * 0.18, my2 = (y + ey) / 2 + Math.sin(ang + Math.PI / 2) * len * (rnd() - 0.5) * 0.18;
      const p = level === 1 ? l1 : level === 2 ? l2 : l3;
      p.moveTo(x, y); p.quadraticCurveTo(mx2, my2, ex, ey);
      if (level >= 3) {
        const tr2 = 0.012 + rnd() * 0.01;
        if (rnd() < 0.5) { tips.moveTo(ex + tr2, ey); tips.arc(ex, ey, tr2, 0, TAU); }
        tipsMany.moveTo(ex + tr2 * 1.3, ey); tipsMany.arc(ex, ey, tr2 * 1.3, 0, TAU);
        tipN++;
        return;
      }
      const n = 2 + (rnd() < 0.45 ? 1 : 0);
      for (let c = 0; c < n; c++) {
        const spread = (0.32 + rnd() * 0.3) * (c === 0 ? -1 : c === 1 ? 1 : (rnd() - 0.5) * 0.6);
        // branches turn upward a little as they go
        const na = ang + spread + (-Math.PI / 2 - ang) * 0.12;
        const at = c === 2 ? 0.55 : 1;
        branch(x + (ex - x) * at, y + (ey - y) * at, na, len * (0.58 + rnd() * 0.16), level + 1);
      }
    };
    const n1 = 3 + (rnd() < 0.5 ? 1 : 0);
    for (let j = 0; j < n1; j++) {
      const ang = -Math.PI / 2 + ((j / (n1 - 1)) - 0.5) * 1.85 + (rnd() - 0.5) * 0.3;
      const sy = fork + rnd() * 0.05;
      const sx = lean * (sy / fork);
      // reach for the crown's edge
      let len = 0;
      for (let s = 0.02; s < 2; s += 0.02) if (inCrown(sx + Math.cos(ang) * s, sy + Math.sin(ang) * s)) len = s; else if (len) break;
      branch(sx, sy, ang, Math.max(0.08, len * (0.5 + rnd() * 0.14)), 1);
    }
    // a leader up the middle
    branch(lean, fork, -Math.PI / 2 + (rnd() - 0.5) * 0.2, (fork - (ccy - ry)) * 0.55, 1);
    return (bareTpls[key] = { trunk, l1, l2, l3, tips, tipsMany, ccy, rx, ry, a, tw: [tw0, tw1], lean, fork });
  }
  // Leafy crowns: unit = crown radius, origin at the crown's middle. A dark mass, the lit middle tone, highlights up
  // and to the left (where the light comes from), and a sprinkle of leaf flecks for close up.
  const leafTpls = [];
  function leafTemplate(variant) {
    if (leafTpls[variant]) return leafTpls[variant];
    const rnd = rng(4111 + variant * 104729);
    const circles = (p, n, cx, cy, ring, r0, r1, phase) => {
      for (let c = 0; c < n; c++) {
        const a = phase + (c / n) * TAU + (rnd() - 0.5) * 0.5;
        const d = ring * (0.75 + rnd() * 0.3);
        let rr = r0 + rnd() * (r1 - r0);
        const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d * 0.92;
        // keep inside the unit circle (life.js clips cars to it)
        rr = Math.min(rr, 0.99 - Math.hypot(x, y));
        if (rr <= 0.02) continue;
        p.moveTo(x + rr, y); p.arc(x, y, rr, 0, TAU);
      }
    };
    const base = new Path2D(), mid = new Path2D(), light = new Path2D(), dark = new Path2D(), flecks = new Path2D(), flecksL = new Path2D();
    base.moveTo(0.58, 0.04); base.arc(0.02, 0.04, 0.56, 0, TAU);
    circles(base, 7, 0, 0, 0.5, 0.36, 0.48, rnd() * TAU);
    circles(mid, 5, -0.12, -0.13, 0.3, 0.3, 0.42, rnd() * TAU);
    circles(light, 3, -0.3, -0.36, 0.16, 0.16, 0.25, rnd() * TAU);
    circles(dark, 3, 0.36, 0.32, 0.18, 0.14, 0.22, rnd() * TAU);
    for (let s = 0; s < 22; s++) {
      const a = rnd() * TAU, d = Math.sqrt(rnd()) * 0.82, x = Math.cos(a) * d, y = Math.sin(a) * d, rr = 0.035 + rnd() * 0.03;
      const p = x + y < -0.2 ? flecksL : flecks;
      p.moveTo(x + rr, y); p.arc(x, y, rr, 0, TAU);
    }
    // the whole crown's outline, for silhouette(): every circle above, all wound the same way
    const sil = new Path2D();
    for (const p of [base, mid, light, dark]) sil.addPath(p);
    return (leafTpls[variant] = { base, mid, light, dark, flecks, flecksL, sil });
  }
  // Conifers: unit x = crown radius, unit y = the tree's screen height; origin at the foot. Tiers droop at the tips.
  const coneTpls = [];
  function coneTemplate(variant) {
    if (coneTpls[variant]) return coneTpls[variant];
    const rnd = rng(7717 + variant * 15485863);
    const n = 5 + (variant & 1);
    const yb = -0.17, yt = -1;
    const left = [], right = [];
    for (let t = 0; t < n; t++) {
      const y0 = yb + (yt - yb) * (t / n) * 0.93, w = (1 - t / n) * 0.96 + 0.04;
      const th = (yt - yb) / n;
      const jl = 1 + (rnd() - 0.5) * 0.14, jr = 1 + (rnd() - 0.5) * 0.14;
      // a drooping tip, then back in toward the trunk for the next tier up
      left.push([-w * jl, y0 + th * 0.06], [-w * 0.5 * jl, y0 + th * 0.5]);
      right.push([w * jr, y0 + th * 0.06], [w * 0.5 * jr, y0 + th * 0.5]);
    }
    const sil = new Path2D(), lit = new Path2D(), snow = new Path2D();
    sil.moveTo(0, yt);
    for (let q = right.length - 1; q >= 0; q--) sil.lineTo(right[q][0], right[q][1]);
    sil.lineTo(0.06, yb + 0.02); sil.lineTo(-0.06, yb + 0.02);
    for (let q = 0; q < left.length; q++) sil.lineTo(left[q][0], left[q][1]);
    sil.closePath();
    // the lit (left) half of each tier
    for (let t = 0; t < n; t++) {
      const a2 = left[2 * t], b2 = left[2 * t + 1];
      const y0 = a2[1], top = t + 1 < n ? left[2 * t + 3][1] - 0.02 : yt;
      lit.moveTo(a2[0] * 0.92, a2[1] - 0.01); lit.lineTo(b2[0] * 0.8, b2[1]); lit.lineTo(-0.02, top); lit.lineTo(0.02, y0 - (y0 - top) * 0.25); lit.closePath();
      snow.moveTo(a2[0] * 0.9, a2[1] - 0.012); snow.lineTo(b2[0] * 0.7, b2[1] - 0.01); snow.lineTo(-0.03, top + 0.02); snow.lineTo(b2[0] * 0.5, b2[1] + 0.02); snow.closePath();
    }
    return (coneTpls[variant] = { sil, lit, snow, yb });
  }

  function drawTree(ctx, r, cam, t, style) {
    const tr = data.trees, k = cam.lod || cam.k;
    const x = tr[5 * t], y = tr[5 * t + 1], rad = tr[5 * t + 2], h = tr[5 * t + 3], fl = tr[5 * t + 4];
    const o = geo.ROTS[r];
    const X = x * o.R[0] + y * o.R[1], Yg = -(x * o.D[0] + y * o.D[1]) * S;
    const hh = nHash(t * 2654435761 + 7), hh2 = nHash(t * 40503 + 11);
    const season = style.season || "summer";
    const snow = style.snow || 0;
    const kk = cam.k;
    if (fl & 1) {
      // a conifer
      const col = sh(pick(NEEDLE, hh), season === "winter" ? 0.92 : 1);
      if (k < 0.7) {
        setScreen(ctx, cam);
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.moveTo(X - rad, Yg - h * 0.17 * C); ctx.lineTo(X + rad, Yg - h * 0.17 * C); ctx.lineTo(X, Yg - h * C); ctx.closePath(); ctx.fill();
        return;
      }
      setScreen(ctx, cam);
      ctx.fillStyle = PAL.trunk; ctx.fillRect(X - 0.17, Yg - h * 0.2 * C, 0.34, h * 0.2 * C);
      const tpl = coneTemplate(Math.floor(hh2 * 4));
      ctx.setTransform(kk * rad, 0, 0, kk * h * C, X * kk - cam.ox, Yg * kk - cam.oy);
      ctx.fillStyle = sh(col, 0.86); ctx.fill(tpl.sil);
      ctx.fillStyle = sh(col, 1.16); ctx.fill(tpl.lit);
      if (snow > 0.2) { ctx.fillStyle = `rgba(250,252,255,${Math.min(0.9, snow).toFixed(2)})`; ctx.fill(tpl.snow); }
      return;
    }
    const bare = treeBare(t, style);
    if (bare) return drawBareTree(ctx, cam, t, X, Yg, rad, h, k, season, snow, hh, hh2);
    // leafy
    const cz = Math.max(h - rad, h * 0.55);
    const cy = Yg - cz * C;
    let col;
    if (season === "spring" && hh2 < 0.12) col = pick(BLOSSOM, hh * 3 % 1);
    else if (season === "autumn" && hh2 < 0.22) col = pick(LEAF.summer, hh2 * 4.5);
    else col = pick(LEAF[season] || LEAF.summer, hh);
    setScreen(ctx, cam);
    if (k < 0.7) {
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(X, cy, rad, 0, TAU); ctx.fill();
      return;
    }
    // trunk, tapering into the crown
    const tw = Math.max(0.12, rad * 0.07);
    ctx.fillStyle = PAL.trunk;
    ctx.beginPath(); ctx.moveTo(X - tw, Yg); ctx.lineTo(X + tw, Yg); ctx.lineTo(X + tw * 0.6, cy); ctx.lineTo(X - tw * 0.6, cy); ctx.closePath(); ctx.fill();
    const tpl = leafTemplate(Math.floor(hh2 * 6));
    ctx.setTransform(kk * rad, 0, 0, kk * rad, X * kk - cam.ox, cy * kk - cam.oy);
    const thin = season === "late-autumn";
    ctx.fillStyle = sh(col, thin ? 0.8 : 0.76); ctx.fill(tpl.base);
    ctx.fillStyle = col; ctx.fill(tpl.mid);
    ctx.fillStyle = sh(col, 1.17); ctx.fill(tpl.light);
    if (k >= 2) { ctx.fillStyle = sh(col, 0.66); ctx.fill(tpl.dark); }
    if (k >= 3) {
      ctx.fillStyle = sh(col, 0.72); ctx.fill(tpl.flecks);
      ctx.fillStyle = sh(col, 1.28); ctx.fill(tpl.flecksL);
    }
    if (snow > 0.3) { ctx.fillStyle = `rgba(250,252,255,${(snow * 0.6).toFixed(2)})`; ctx.beginPath(); ctx.ellipse(-0.1, -0.45, 0.62, 0.32, 0, 0, TAU); ctx.fill(); }
  }
  function drawBareTree(ctx, cam, t, X, Yg, rad, h, k, season, snow, hh, hh2) {
    const kk = cam.k, unit = h * C;
    const a = rad / unit;
    let bucket = 0;
    for (let q = 1; q < BARE_A.length; q++) if (Math.abs(BARE_A[q] - a) < Math.abs(BARE_A[bucket] - a)) bucket = q;
    const tpl = bareTemplate(bucket, Math.floor(hh2 * 4));
    // stretch sideways to the tree's own crown (a little), mirror half of them
    const sx = clamp(a / tpl.a, 0.8, 1.25) * (hh < 0.5 ? -1 : 1);
    ctx.setTransform(kk * unit * sx, 0, 0, kk * unit, X * kk - cam.ox, Yg * kk - cam.oy);
    const px = 1 / (k * unit);   // one device pixel, in template units (at the detail level)
    // a haze of twigs, soft at the edge: from afar this is all there is of the crown
    const winter = season === "winter";
    const haze = softSprite(winter ? "haze-w" : "haze");
    if (k < 0.4) {
      // from afar the haze is a few pixels across: a flat blot of its average tone looks the same and costs a tenth
      // of a scaled sprite; the trunk is under a third of a pixel
      ctx.fillStyle = winter ? "rgba(120,106,100,.47)" : "rgba(130,100,84,.47)";
      ctx.beginPath(); ctx.ellipse(0, tpl.ccy, tpl.rx * 0.8, tpl.ry * 0.79, 0, 0, TAU); ctx.fill();
      if (k * unit * Math.abs(sx) * tpl.tw[0] * 2 >= 0.35) { ctx.fillStyle = "#5d4a3e"; ctx.fill(tpl.trunk); }
      return;
    }
    if (haze) {
      const a0 = ctx.globalAlpha;
      ctx.globalAlpha = a0 * (k < 1 ? 0.62 : k < 2.5 ? 0.4 : 0.24);
      ctx.drawImage(haze, -tpl.rx * 0.96, tpl.ccy - tpl.ry * 0.95, tpl.rx * 1.92, tpl.ry * 1.9);
      ctx.globalAlpha = a0;
    } else {
      ctx.fillStyle = k < 1 ? "rgba(128,100,86,.5)" : k < 2.5 ? "rgba(130,100,84,.3)" : "rgba(132,102,86,.18)";
      ctx.beginPath(); ctx.ellipse(0, tpl.ccy, tpl.rx * 0.9, tpl.ry * 0.88, 0, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = "#5d4a3e"; ctx.fill(tpl.trunk);
    if (k < 0.6) return;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = "#5f4c40"; ctx.lineWidth = Math.max(0.022, 0.8 * px); ctx.stroke(tpl.l1);
    if (k >= 1.2) { ctx.strokeStyle = "rgba(98,78,66,.9)"; ctx.lineWidth = Math.max(0.011, 0.55 * px); ctx.stroke(tpl.l2); }
    if (k >= 2.5) { ctx.strokeStyle = "rgba(118,96,82,.75)"; ctx.lineWidth = Math.max(0.0055, 0.4 * px); ctx.stroke(tpl.l3); }
    if (season === "late-autumn" && hh2 * 7 % 1 < 0.55 && k >= 1.2) {
      // a few leaves hang on
      ctx.fillStyle = pick(REMNANT, hh * 5 % 1);
      ctx.fill(hh2 * 13 % 1 < 0.35 ? tpl.tipsMany : tpl.tips);
    }
    if (snow > 0.25 && k >= 1.2) {
      // snow along the tops of the limbs
      const m = ctx.getTransform();
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f - Math.max(0.6, kk * 0.05));
      ctx.strokeStyle = `rgba(250,252,255,${Math.min(0.9, snow).toFixed(2)})`; ctx.lineWidth = Math.max(0.014, 0.6 * px); ctx.stroke(tpl.l1);
      ctx.lineWidth = Math.max(0.007, 0.45 * px); ctx.stroke(tpl.l2);
    }
  }

  function drawLamp(ctx, r, cam, l) {
    const k = cam.lod || cam.k;
    if (k < 1.2) return;
    const x = data.lamps[2 * l], y = data.lamps[2 * l + 1];
    const o = geo.ROTS[r];
    const X = x * o.R[0] + y * o.R[1], Y = -(x * o.D[0] + y * o.D[1]) * S;
    setScreen(ctx, cam);
    ctx.strokeStyle = "#474b51"; ctx.lineWidth = 0.15; ctx.lineCap = "butt";
    ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X, Y - 5.5 * C); ctx.stroke();
    if (k >= 3) {
      // an acorn lantern: a pale glass globe under a dark cap, on a little base
      ctx.fillStyle = "#3d4147"; ctx.fillRect(X - 0.13, Y - 0.5 * C, 0.26, 0.5 * C);
      ctx.fillStyle = "#efe6cf";
      ctx.beginPath(); ctx.ellipse(X, Y - 5.72 * C, 0.2, 0.26, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = "#3a3e44";
      ctx.beginPath(); ctx.moveTo(X - 0.24, Y - 5.86 * C); ctx.lineTo(X + 0.24, Y - 5.86 * C); ctx.lineTo(X, Y - 6.15 * C); ctx.closePath(); ctx.fill();
    } else {
      ctx.fillStyle = "#3d4147"; ctx.fillRect(X - 0.25, Y - 5.9 * C, 0.5, 0.32);
    }
  }

  // ---------------------------------------------------------------- buildings
  // a vertical prism over a ground quad (4 corners, counter-clockwise): its camera-facing sides, then its top
  const PQ = new Float64Array(16);
  function prism(ctx, r, q, z0, z1, side, top, outline) {
    const o = geo.ROTS[r];
    for (let c = 0; c < 4; c++) { projInto(PQ, 2 * c, q[2 * c], q[2 * c + 1], z0, r); projInto(PQ, 8 + 2 * c, q[2 * c], q[2 * c + 1], z1, r); }
    for (let e = 0; e < 4; e++) {
      const a = e, c = (e + 1) & 3;
      const dx = q[2 * c] - q[2 * a], dy = q[2 * c + 1] - q[2 * a + 1], L = Math.hypot(dx, dy) || 1;
      const nx = dy / L, ny = -dx / L, nd = nx * o.D[0] + ny * o.D[1];
      if (nd >= 0) continue;
      ctx.beginPath();
      ctx.moveTo(PQ[2 * a], PQ[2 * a + 1]); ctx.lineTo(PQ[2 * c], PQ[2 * c + 1]); ctx.lineTo(PQ[8 + 2 * c], PQ[8 + 2 * c + 1]); ctx.lineTo(PQ[8 + 2 * a], PQ[8 + 2 * a + 1]); ctx.closePath();
      ctx.fillStyle = sh(side, 0.72 + 0.3 * lightOf(nx * o.R[0] + ny * o.R[1], nd)); ctx.fill();
    }
    if (top) {
      ctx.beginPath(); ctx.moveTo(PQ[8], PQ[9]); ctx.lineTo(PQ[10], PQ[11]); ctx.lineTo(PQ[12], PQ[13]); ctx.lineTo(PQ[14], PQ[15]); ctx.closePath();
      ctx.fillStyle = top; ctx.fill();
      if (outline) { ctx.strokeStyle = sh(top, 0.78); ctx.lineWidth = outline; ctx.stroke(); }
    }
  }
  const BQ = new Float64Array(8);
  // a rectangle on the ground: centre, half-sizes along an angle → BQ (counter-clockwise)
  function rectQuad(cx, cy, ang, hx, hy) {
    const ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
    BQ[0] = cx - ux * hx - vx * hy; BQ[1] = cy - uy * hx - vy * hy;
    BQ[2] = cx + ux * hx - vx * hy; BQ[3] = cy + uy * hx - vy * hy;
    BQ[4] = cx + ux * hx + vx * hy; BQ[5] = cy + uy * hx + vy * hy;
    BQ[6] = cx - ux * hx + vx * hy; BQ[7] = cy - uy * hx + vy * hy;
    return BQ;
  }
  // a quad on a wall between fractions t0..t1 along it and heights z0..z1 (added to the current path)
  function quad(ctx, x1, y1, x2, y2, t0, t1, z0, z1) {
    const ax = x1 + (x2 - x1) * t0, ay = y1 + (y2 - y1) * t0, bx = x1 + (x2 - x1) * t1, by = y1 + (y2 - y1) * t1;
    ctx.moveTo(ax, ay - z0 * C); ctx.lineTo(bx, by - z0 * C); ctx.lineTo(bx, by - z1 * C); ctx.lineTo(ax, ay - z1 * C); ctx.closePath();
  }
  // The same, for paths that are only filled (or clipped to), as every one in this file is: left open. Filling closes a
  // subpath anyway, and closePath() costs Chrome time in proportion to the whole path so far, so on a path of many
  // subpaths (a wall's windows, a lot's cars, a tile's shadows) closing each one made building the path quadratic:
  // 6000 little polygons took half a second to add up, against 10 ms left open.
  function quadF(ctx, x1, y1, x2, y2, t0, t1, z0, z1) {
    const ax = x1 + (x2 - x1) * t0, ay = y1 + (y2 - y1) * t0, bx = x1 + (x2 - x1) * t1, by = y1 + (y2 - y1) * t1;
    ctx.moveTo(ax, ay - z0 * C); ctx.lineTo(bx, by - z0 * C); ctx.lineTo(bx, by - z1 * C); ctx.lineTo(ax, ay - z1 * C);
  }
  const wallTop = (b) => (b.roof && b.roof !== "flat" && b.obb ? b.h - b.rh : b.h);

  // LANDMARK HOOK (draw/decorate): a landmark may draw itself entirely, or add geometry after the standard building
  function drawBuilding(ctx, r, cam, i, style) {
    const b = data.buildings[i];
    if (b.hidden) return;
    if (b.lm != null && LM.draw(api, ctx, r, cam, i, style)) return;
    drawBuildingStd(ctx, r, cam, i, style);
    if (b.lm != null) LM.decorate(api, ctx, r, cam, i, style);
  }
  function drawBuildingStd(ctx, r, cam, i, style) {
    const b = data.buildings[i];
    if (b.hidden) return;
    const st = styleOf(i);
    const k = cam.lod || cam.k;   // level of detail: the tile level's scale, so redraws match the tiles
    if (st.kind === "bowl") { const g = bowlOf(i); if (g) return drawBowl(ctx, r, cam, i, b, st, g, k, style); }
    if (st.kind === "bleachers") return drawBleachers(ctx, r, cam, i, b, st, k, style);
    const Sr = scene.forRot(r);
    const rings = Sr.objRings[i];
    const snow = style.snow || 0;
    const pitched = b.roof && b.roof !== "flat" && b.obb;
    const base = b.mh || 0;
    const he = pitched ? b.h - b.rh : b.h;      // eaves
    const top = he * C, bot = base * C;
    setScreen(ctx, cam);
    const walls = visibleWalls(i, r);
    const outline = k >= 0.8;
    const lineW = Math.min(0.12, 0.9 / k);

    // walls
    if (k < 0.6) {
      // far away: two tones, the lit walls and the shaded
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        let any = false;
        for (const wv of walls) {
          if ((wv.light >= 0.45) !== (pass === 0)) continue;
          const f = rings[wv.ri];
          ctx.moveTo(f[2 * wv.c], f[2 * wv.c + 1] - bot); ctx.lineTo(f[2 * wv.a], f[2 * wv.a + 1] - bot);
          ctx.lineTo(f[2 * wv.a], f[2 * wv.a + 1] - top); ctx.lineTo(f[2 * wv.c], f[2 * wv.c + 1] - top);   // (filled only: open, see quadF)
          any = true;
        }
        if (any) { ctx.fillStyle = sh(st.wall, pass === 0 ? 0.96 : 0.76); ctx.fill(); }
      }
    } else {
      const front = st.kind === "house" && k >= 2 ? frontOf(i, r) : null;
      let frontWall = null;
      for (const wv of walls) {
        const f = rings[wv.ri];
        const x1 = f[2 * wv.c], y1 = f[2 * wv.c + 1], x2 = f[2 * wv.a], y2 = f[2 * wv.a + 1];
        ctx.beginPath();
        ctx.moveTo(x1, y1 - bot); ctx.lineTo(x2, y2 - bot); ctx.lineTo(x2, y2 - top); ctx.lineTo(x1, y1 - top); ctx.closePath();
        const wc = sh(st.wall, 0.7 + 0.36 * wv.light);
        ctx.fillStyle = wc; ctx.fill();
        if (outline) { ctx.strokeStyle = sh(wc, 0.74); ctx.lineWidth = lineW; ctx.stroke(); }
        const isFront = front && wv.ri === 0 && wv.nx * front[0] + wv.ny * front[1] > 0.8 && (!frontWall || wv.L > frontWall.wv.L);
        if (isFront) frontWall = { wv, x1, y1, x2, y2 };
        if (k >= 1) wallDetail(ctx, i, b, st, wv, x1, y1, x2, y2, base, he, k, wc, isFront ? 1 : 0, pitched);
      }
      if (frontWall && k >= 2) {
        // a front door, already drawn on the wall: now the porch in front of it
        const fw = frontWall;
        if (fw.wv.L > 4.5 && he - base > 2.6) drawPorch(ctx, r, cam, i, b, st, fw.wv, he, k);
      }
    }

    // roof
    if (DBG.on) DBG.part = 1;
    if (pitched) drawPitchedRoof(ctx, r, cam, i, b, st, snow, outline, lineW, k);
    else drawFlatRoof(ctx, r, cam, i, b, st, rings, top, k, snow, outline, lineW, base);
    if (DBG.on) DBG.part = 0;   // (a landmark's own pieces, drawn next, carry their own lights)
  }

  // Facade details on one wall: a stone plinth, a cornice, string courses, windows (bands of them from afar, each one
  // close up), a door; siding on houses. Everything is quads in the wall's plane.
  function wallDetail(ctx, i, b, st, wv, x1, y1, x2, y2, base, he, k, wc, front, pitched) {
    const hgt = he - base;
    if (hgt < 1.6) return;
    const f = st.facade;
    if (f === "bowl" || f === "bleachers") return;
    const L = wv.L;
    // ambient occlusion near the ground
    if (k >= 2 && base < 0.5 && hgt > 2.5) {
      ctx.beginPath(); quadF(ctx, x1, y1, x2, y2, 0, 1, 0, Math.min(1.4, hgt * 0.3));
      ctx.fillStyle = "rgba(40,32,24,.09)"; ctx.fill();
    }
    if (st.plinth && k >= 1.5 && base < 0.5 && hgt > 5) {
      ctx.beginPath(); quadF(ctx, x1, y1, x2, y2, 0, 1, 0, 0.9);
      ctx.fillStyle = sh(st.trim, 0.72 + 0.3 * wv.light); ctx.fill();
    }
    if (st.siding && k >= 4 && hgt < 12) {
      ctx.beginPath();
      for (let z = base + 0.32; z < he - 0.2; z += 0.32) { ctx.moveTo(x1, y1 - z * C); ctx.lineTo(x2, y2 - z * C); }
      ctx.strokeStyle = rgba(sh(wc, 0.8), 0.45); ctx.lineWidth = 0.035; ctx.stroke();
    }
    if (st.string && k >= 3 && hgt > 8) {
      const floors = Math.max(1, Math.round(hgt / st.fh)), fhh = hgt / floors;
      ctx.beginPath();
      for (let fl = 1; fl < floors; fl++) { const z = base + fl * fhh; quadF(ctx, x1, y1, x2, y2, 0, 1, z - 0.12, z + 0.1); }
      ctx.fillStyle = sh(st.trim, 0.66 + 0.34 * wv.light); ctx.fill();
    }
    drawWindows(ctx, b, st, wv, x1, y1, x2, y2, k >= 2 ? 1 : 0, k, front);
    if (st.cornice && k >= 1.5 && hgt > 4) {
      // a cornice: a light band at the top with a soft shadow under it
      const c0 = he - Math.min(0.8, hgt * 0.08);
      ctx.beginPath(); quadF(ctx, x1, y1, x2, y2, 0, 1, c0, he);
      ctx.fillStyle = sh(st.trim, 0.74 + 0.32 * wv.light); ctx.fill();
      if (k >= 3) { ctx.beginPath(); quadF(ctx, x1, y1, x2, y2, 0, 1, c0 - 0.25, c0); ctx.fillStyle = "rgba(30,25,20,.14)"; ctx.fill(); }
    } else if (pitched && k >= 2) {
      // the eaves' shadow
      ctx.beginPath(); quadF(ctx, x1, y1, x2, y2, 0, 1, he - 0.35, he);
      ctx.fillStyle = "rgba(30,25,20,.16)"; ctx.fill();
    }
  }

  // The windows of one wall, in one of three modes: 0 day from afar (a band per floor), 1 day close up (each window,
  // frames, sills), 2 lit at night (each window on or off, as the lights tiles draw them). All three share one layout,
  // so night lights land exactly on the windows the day tiles show.
  function drawWindows(ctx, b, st, wv, x1, y1, x2, y2, mode, k, front) {
    const base = b.mh || 0;
    const he = wallTop(b);
    const f = st.facade;
    const hgt = he - base;
    const floors = Math.max(1, Math.round(hgt / st.fh));
    const fhh = hgt / floors;
    const L = wv.L;
    const idBase = strHashInt(b.id) + wv.c * 131 + wv.ri * 7919;
    if (f === "blank") return;   // no windows: a landmark paints its own (landmarks.js walls)
    if (f === "parking") {
      // open decks: a dark band per level
      const g = mode === 2 && litBatch ? litBatch[3] : ctx;
      if (g === ctx) ctx.beginPath();
      for (let fl = 0; fl < floors; fl++) {
        const z0 = base + fl * fhh + fhh * 0.38, z1 = base + fl * fhh + fhh * 0.86;
        if (mode === 2 && nHash(strHashInt(b.id) + fl * 7) < 0.35) continue;
        quadF(g, x1, y1, x2, y2, 0.02, 0.98, z0, z1);
        if (g !== ctx) litUsed[3] = true;
      }
      if (g === ctx) {
        ctx.fillStyle = mode === 2 ? LIT_PARK : "rgba(48, 52, 58, .55)";
        ctx.fill();
      }
      if (mode === 1 && k >= 3) {
        // columns between the openings
        ctx.beginPath();
        const n = Math.max(1, Math.round(L / 8));
        for (let c = 1; c < n; c++) quadF(ctx, x1, y1, x2, y2, c / n - 0.25 / L, c / n + 0.25 / L, base, he);
        ctx.fillStyle = sh(st.wall, 0.75 + 0.3 * wv.light); ctx.fill();
      }
      return;
    }
    if (f === "small") {
      // a garage door on the longest wall
      if (mode !== 1 || L < 3 || hgt < 2.2 || (b.k !== "garage" && b.k !== "garages")) return;
      const n = b.k === "garages" ? Math.max(1, Math.floor(L / 3.2)) : 1;
      ctx.beginPath();
      for (let d = 0; d < n; d++) { const c = (d + 0.5) / n, hw = Math.min(1.25, L / n * 0.4) / L; quadF(ctx, x1, y1, x2, y2, c - hw, c + hw, base, base + Math.min(2.1, hgt - 0.3)); }
      ctx.fillStyle = sh(st.wall, 0.82); ctx.fill();
      return;
    }
    if (L < 1.8) return;
    const glassLit = (hsh, on) => (hsh < on * 0.22 ? "#cfe4ff" : hsh < on * 0.62 ? "#ffd889" : "#ffc46b");
    // ---- curtain walls and ribbon windows: bays of mullion width
    if (f === "curtain" || f === "ribbon") {
      const bay = 1.6, nb = Math.max(1, Math.round(L / bay)), pad = f === "ribbon" ? Math.min(0.08, 0.5 / L) : 0;
      const z0f = f === "curtain" ? 0.08 : st.z0f, z1f = f === "curtain" ? 0.94 : st.z1f;
      if (mode === 2) {
        const on = 0.34;
        for (let pass = 0; pass < 3; pass++) {
          const g = litBatch ? litBatch[pass] : ctx;
          if (g === ctx) ctx.beginPath();
          let any = false;
          for (let fl = 0; fl < floors; fl++) for (let w = 0; w < nb; w++) {
            const hsh = nHash(idBase + fl * 977 + w * 31);
            if (hsh > on) continue;
            const cl = hsh < on * 0.22 ? 0 : hsh < on * 0.62 ? 1 : 2;
            if (cl !== pass) continue;
            const t0 = pad + ((1 - 2 * pad) * w) / nb, t1 = pad + ((1 - 2 * pad) * (w + 1)) / nb;
            quadF(g, x1, y1, x2, y2, t0 + 0.04 / L, t1 - 0.04 / L, base + fl * fhh + fhh * z0f, base + fl * fhh + fhh * z1f);
            any = true;
          }
          if (!any) continue;
          if (g === ctx) { ctx.fillStyle = LIT[pass]; ctx.fill(); } else litUsed[pass] = true;
        }
        return;
      }
      ctx.beginPath();
      for (let fl = 0; fl < floors; fl++) quadF(ctx, x1, y1, x2, y2, pad, 1 - pad, base + fl * fhh + fhh * z0f, base + fl * fhh + fhh * z1f);
      const gl = f === "curtain" ? sh(st.glass, 0.8 + 0.3 * wv.light) : sh(st.glass, 0.85 + 0.25 * wv.light);
      ctx.fillStyle = mode === 0 ? mx(gl, sh(st.wall, 0.8), 0.3) : gl; ctx.fill();
      if (mode === 1) {
        // a sky reflection sliding across the glass, then mullions
        if (f === "curtain" || k >= 3) {
          ctx.beginPath();
          const s0 = nHash(idBase) * 0.6;
          for (let fl = 0; fl < floors; fl++) {
            const za = base + fl * fhh + fhh * z0f, zb = base + fl * fhh + fhh * z1f;
            const ta = clamp(s0 + fl * 0.03, pad, 1 - pad), tb = clamp(ta + 0.18, pad, 1 - pad);
            quadF(ctx, x1, y1, x2, y2, ta, tb, za, zb);
          }
          ctx.fillStyle = "rgba(255,255,255,.13)"; ctx.fill();
        }
        if (k >= 3) {
          ctx.beginPath();
          for (let w = 1; w < nb; w++) {
            const t = pad + ((1 - 2 * pad) * w) / nb;
            const ax = x1 + (x2 - x1) * t, ay = y1 + (y2 - y1) * t;
            ctx.moveTo(ax, ay - (base + fhh * z0f) * C); ctx.lineTo(ax, ay - (he - fhh * (1 - z1f)) * C);
          }
          ctx.strokeStyle = rgba(sh(st.wall, 1.1), 0.7); ctx.lineWidth = 0.08; ctx.stroke();
        }
      }
      return;
    }
    // ---- punched windows
    const spacing = st.spacing, count = Math.max(1, Math.floor(L / spacing));
    if (st.spacing > 50) return;
    const pad = (L - count * spacing) / 2 / L, span = spacing / L, ww = st.winW;
    // a door: the front door of a house; on other buildings, some longer walls get an entrance in the middle
    const doorSlot = front ? Math.floor(count / 2) : (f !== "house" && f !== "ind" && L > 12 && nHash(idBase + 5) < 0.5 ? Math.floor(count / 2) : -1);
    const store = f === "comm" && fhh >= 3.4;
    const z0f = st.z0f, z1f = st.z1f;
    if (mode === 2) {
      const on = st.kind === "hospital" ? 0.72 : f === "house" || f === "apt" ? 0.5 : st.kind === "campus" ? 0.36 : 0.3;
      for (let pass = 0; pass < 3; pass++) {
        const g = litBatch ? litBatch[pass] : ctx;
        if (g === ctx) ctx.beginPath();
        let any = false;
        for (let fl = 0; fl < floors; fl++) {
          if (fl === 0 && store) {
            // shop fronts: most of them lit
            if (pass === 1 && nHash(idBase + 3) < 0.75) { quadF(g, x1, y1, x2, y2, 0.06, 0.94, base + 0.35, base + Math.min(3, fhh * 0.82)); any = true; }
            continue;
          }
          const z0 = base + fl * fhh + fhh * z0f, z1 = base + fl * fhh + fhh * z1f;
          for (let w = 0; w < count; w++) {
            if (fl === 0 && w === doorSlot) {
              if (pass === 1 && (front || nHash(idBase + 9) < 0.7)) { const t0 = pad + span * w + (span * (1 - (front ? 0.3 : 0.7))) / 2; quadF(g, x1, y1, x2, y2, t0, t0 + span * (front ? 0.3 : 0.7), base, base + Math.min(2.6, fhh * 0.7)); any = true; }
              continue;
            }
            const hsh = nHash(idBase + fl * 977 + w * 31);
            if (hsh > on) continue;
            const cl = hsh < on * 0.22 ? 0 : hsh < on * 0.62 ? 1 : 2;
            if (cl !== pass) continue;
            const t0 = pad + span * w + (span * (1 - ww)) / 2;
            quadF(g, x1, y1, x2, y2, t0, t0 + span * ww, z0, z1);
            any = true;
          }
        }
        if (!any) continue;
        if (g === ctx) { ctx.fillStyle = LIT[pass]; ctx.fill(); } else litUsed[pass] = true;
      }
      return;
    }
    const glass = sh(st.glass, 0.86 + 0.24 * wv.light);
    if (mode === 0) {
      // from afar: each floor's row of windows as one band, its colour half way to the wall's
      ctx.beginPath();
      for (let fl = 0; fl < floors; fl++) {
        if (fl === 0 && store) { quadF(ctx, x1, y1, x2, y2, 0.06, 0.94, base + 0.35, base + Math.min(3, fhh * 0.82)); continue; }
        const t0 = pad + (span * (1 - ww)) / 2, t1 = pad + span * (count - 1) + (span * (1 + ww)) / 2;
        quadF(ctx, x1, y1, x2, y2, t0, t1, base + fl * fhh + fhh * z0f, base + fl * fhh + fhh * z1f);
      }
      ctx.fillStyle = mx(glass, sh(st.wall, 0.7 + 0.36 * wv.light), 0.45); ctx.fill();
      return;
    }
    // close up: frames (and sills), then glass, then a glint on the upper panes
    const frame = st.frame && k >= 4 ? sh(st.frame, 0.8 + 0.25 * wv.light) : null;
    const sill = (f === "brick" || f === "stone" || f === "church") && k >= 3 ? sh(st.trim, 0.78 + 0.25 * wv.light) : null;
    const fw = 0.11 / L;
    if (frame || sill) {
      ctx.beginPath();
      for (let fl = 0; fl < floors; fl++) {
        if (fl === 0 && store) continue;
        const z0 = base + fl * fhh + fhh * z0f, z1 = base + fl * fhh + fhh * z1f;
        for (let w = 0; w < count; w++) {
          if (fl === 0 && w === doorSlot) continue;
          const t0 = pad + span * w + (span * (1 - ww)) / 2, t1 = t0 + span * ww;
          if (frame) quadF(ctx, x1, y1, x2, y2, t0 - fw, t1 + fw, z0 - 0.1, z1 + 0.1);
          if (sill) { quadF(ctx, x1, y1, x2, y2, t0 - fw * 1.6, t1 + fw * 1.6, z0 - 0.2, z0); quadF(ctx, x1, y1, x2, y2, t0 - fw, t1 + fw, z1, z1 + 0.16); }
        }
      }
      // frames and sills share one fill (the frame's colour where there are frames)
      ctx.fillStyle = frame || sill; ctx.fill();
    }
    ctx.beginPath();
    for (let fl = 0; fl < floors; fl++) {
      if (fl === 0 && store) { quadF(ctx, x1, y1, x2, y2, 0.06, 0.94, base + 0.35, base + Math.min(3, fhh * 0.82)); continue; }
      const z0 = base + fl * fhh + fhh * z0f, z1 = base + fl * fhh + fhh * z1f;
      for (let w = 0; w < count; w++) {
        if (fl === 0 && w === doorSlot) continue;
        const t0 = pad + span * w + (span * (1 - ww)) / 2;
        quadF(ctx, x1, y1, x2, y2, t0, t0 + span * ww, z0, z1);
      }
    }
    ctx.fillStyle = glass; ctx.fill();
    if (k >= 4) {
      ctx.beginPath();
      for (let fl = 0; fl < floors; fl++) {
        if (fl === 0 && store) continue;
        const z0 = base + fl * fhh + fhh * z0f, z1 = base + fl * fhh + fhh * z1f;
        for (let w = 0; w < count; w++) {
          if (fl === 0 && w === doorSlot) continue;
          const t0 = pad + span * w + (span * (1 - ww)) / 2;
          quadF(ctx, x1, y1, x2, y2, t0, t0 + span * ww * 0.45, z0 + (z1 - z0) * 0.55, z1);
        }
      }
      ctx.fillStyle = "rgba(255,255,255,.12)"; ctx.fill();
    }
    if (store && k >= 3) {
      // mullions in the shop windows and an awning line over them
      ctx.beginPath();
      const n = Math.max(1, Math.round(L / 3));
      for (let c = 1; c < n; c++) quadF(ctx, x1, y1, x2, y2, c / n - 0.07 / L, c / n + 0.07 / L, base + 0.35, base + Math.min(3, fhh * 0.82));
      quadF(ctx, x1, y1, x2, y2, 0.04, 0.96, base + Math.min(3, fhh * 0.82), base + Math.min(3.35, fhh * 0.9));
      ctx.fillStyle = sh(st.wall, 0.55); ctx.fill();
    }
    if (doorSlot >= 0) {
      const dw = front ? 0.3 : 0.7;
      const t0 = pad + span * doorSlot + (span * (1 - dw)) / 2, t1 = t0 + span * dw;
      const dh = front ? Math.min(2.2, fhh * 0.72) : Math.min(2.7, fhh * 0.72);
      ctx.beginPath(); quadF(ctx, x1, y1, x2, y2, t0 - fw * 1.5, t1 + fw * 1.5, base, base + dh + 0.25);
      ctx.fillStyle = sh(front ? "#f2eee6" : st.trim, 0.8 + 0.25 * wv.light); ctx.fill();
      ctx.beginPath(); quadF(ctx, x1, y1, x2, y2, t0, t1, base, base + dh);
      ctx.fillStyle = front ? sh(pick(DOORS, st.h4), 0.8 + 0.25 * wv.light) : sh("#34414c", 0.9 + 0.2 * wv.light); ctx.fill();
    }
  }

  // A front porch: a deck, posts and a little roof, along the middle of the front wall.
  function drawPorch(ctx, r, cam, i, b, st, wv, he, k) {
    if (DBG.on) DBG.part = 2;
    const f = b.p[wv.ri];
    const ax = f[2 * wv.c], ay = f[2 * wv.c + 1], bx = f[2 * wv.a], by = f[2 * wv.a + 1];
    const L = wv.L, tx = (bx - ax) / L, ty = (by - ay) / L, nx = wv.nx, ny = wv.ny;
    const pw = Math.min(L * 0.82, 8), depth = 1.7, mid = L / 2;
    const s0 = mid - pw / 2, s1 = mid + pw / 2;
    const P = (s, d) => [ax + tx * s + nx * d, ay + ty * s + ny * d];
    const q = new Float64Array(8);
    const set = (pts) => { for (let c = 0; c < 4; c++) { q[2 * c] = pts[c][0]; q[2 * c + 1] = pts[c][1]; } return q; };
    // corners counter-clockwise: the wall runs a → b with the outside on its right... (nx, ny) is outward, so walk
    // along the wall, out, back, in
    const quadOut = (sa, sb, d0, d1) => set([P(sa, d0), P(sb, d0), P(sb, d1), P(sa, d1)]);
    const ph = Math.min(2.75, he - 0.4);
    const deck = sh("#cdbfa8", 1);
    // ground the corners' order: the wall runs counter-clockwise round the house, so (along, then out) turns clockwise
    // — reverse it for prism's counter-clockwise rule
    const ccw = (qq) => { const out = new Float64Array(8); for (let c = 0; c < 4; c++) { out[2 * c] = qq[2 * (3 - c)]; out[2 * c + 1] = qq[2 * (3 - c) + 1]; } return out; };
    prism(ctx, r, ccw(quadOut(s0, s1, 0, depth)), 0, 0.45, deck, sh(deck, 1.06), 0);
    // posts
    if (k >= 3) {
      const post = st.trim || "#f2eee6";
      const n = pw > 5 ? 3 : 2;
      for (let p = 0; p < n; p++) {
        const s = s0 + 0.2 + ((pw - 0.4) * p) / (n - 1);
        prism(ctx, r, ccw(quadOut(s - 0.09, s + 0.09, depth - 0.28, depth - 0.1)), 0.45, ph, post, null, 0);
      }
    }
    const roofCol = st.roof;
    prism(ctx, r, ccw(quadOut(s0 - 0.15, s1 + 0.15, 0, depth + 0.15)), ph, ph + 0.22, st.trim || "#f2eee6", sh(roofCol, 1.1), k >= 3 ? 0.04 : 0);
  }

  // ---------------------------------------------------------------- roofs
  // set while the night lights paint a roof to rub out what it hides: only its outline counts, not what lies on it
  let erasing = false;
  // Flat roofs: membrane, gravel, tar or a green roof; a coping round the parapet with its shadow inside; seams; then
  // what stands on top: plant rooms, air handlers with fans, skylights, solar arrays (never in a courtyard).
  function drawFlatRoof(ctx, r, cam, i, b, st, rings, top, k, snow, outline, lineW, base) {
    ctx.beginPath();
    for (const f of rings) { ctx.moveTo(f[0], f[1] - top); for (let q = 2; q < f.length; q += 2) ctx.lineTo(f[q], f[q + 1] - top); ctx.closePath(); }
    let rc = st.roof;
    if (snow > 0.15) rc = mx(rc, "#f5f7f9", Math.min(0.9, snow * 1.1));
    ctx.fillStyle = rc; ctx.fill("evenodd");
    if (k >= 1 && snow < 0.4 && !erasing) {
      // texels of the tile level's pixels (k is cam.lod), so a redraw over a moving bus matches the tile
      if (st.roofKind === "gravel") screenTexture(ctx, "gravel", k);
      else if (st.roofKind === "green") screenTexture(ctx, "sedum", k);
    }
    if (outline) { ctx.strokeStyle = sh(rc, 0.72); ctx.lineWidth = lineW; ctx.stroke(); }
    const hgt = b.h - base;
    if (k >= 2 && hgt >= 2.5) {
      // the parapet's coping: a light line along the edge
      ctx.strokeStyle = st.kind === "house" || st.kind === "small" ? sh(rc, 1.1) : mx(rc, "#ffffff", 0.35);
      ctx.lineWidth = Math.min(0.32, 1.4 / k); ctx.stroke();
    }
    if (st.kind === "parking") { if (k >= 0.8) deckCars(ctx, r, cam, i, b, k, snow); return; }
    if (k < 2 || hgt < 2.5) return;
    if (st.kind === "house" || st.kind === "small") return;
    if (k >= 3 && !erasing) {
      // the parapet's shadow inside the edge, and membrane seams, kept to the roof by a clip
      ctx.save();
      ctx.clip("evenodd");
      ctx.strokeStyle = "rgba(40,34,28,.11)"; ctx.lineWidth = 1.5; ctx.stroke();
      if (st.roofKind === "membrane" || st.roofKind === "metal") roofSeams(ctx, r, i, b, st, he(b), k);
      ctx.restore();
    }
    const items = roofItemsOf(i, r);
    if (items.length) drawRoofItems(ctx, r, i, b, st, items, k, snow);
  }
  const he = (b) => wallTop(b);
  function roofSeams(ctx, r, i, b, st, z, k) {
    const o = obbFor(i);
    if (!o) return;
    const ux = Math.cos(o.ang), uy = Math.sin(o.ang), vx = -uy, vy = ux;
    const step = st.roofKind === "metal" ? 1.2 : 2.6;
    ctx.beginPath();
    const n = Math.floor(o.W / step);
    if (n > 200) return;
    for (let s = 1; s < n; s++) {
      const v = -o.W / 2 + s * (o.W / n);
      const ax = o.cx - ux * o.L / 2 + vx * v, ay = o.cy - uy * o.L / 2 + vy * v, bx = o.cx + ux * o.L / 2 + vx * v, by = o.cy + uy * o.L / 2 + vy * v;
      projInto(PQ, 0, ax, ay, z, r); projInto(PQ, 2, bx, by, z, r);
      ctx.moveTo(PQ[0], PQ[1]); ctx.lineTo(PQ[2], PQ[3]);
    }
    ctx.strokeStyle = st.roofKind === "metal" ? "rgba(90,95,100,.22)" : "rgba(120,110,95,.16)"; ctx.lineWidth = 0.07; ctx.stroke();
  }
  // The top deck of a parking garage: rows of stalls (against each parapet, back to back down the middle of a wide
  // deck, 6.5 m aisles between), painted lines, and cars in some of them. Laid out once per garage in its own frame.
  function deckSlots(i) {
    const key = "g" + i;
    let out = slotCache.get(key);
    if (out) return out;
    const b = data.buildings[i], o = obbFor(i), res = [];
    if (o && o.W >= 11 && o.L >= 12) {
      const ux = Math.cos(o.ang), uy = Math.sin(o.ang), vx = -uy, vy = ux;
      const rows = [];
      let v = -o.W / 2 + 0.5, back = false;
      while (v + DEPTH <= o.W / 2 - 0.5) {
        rows.push([v + DEPTH / 2, back ? 1 : -1]);
        v += DEPTH;
        // after a stall row facing the parapet comes an aisle; after one facing the aisle, a row back to back with it
        if (back) back = false;
        else { v += 6.5; back = true; }
      }
      const fill = 0.3 + 0.45 * nHash(strHashInt(b.id) + 19);
      for (const [c, face] of rows) for (let u = -o.L / 2 + PITCH / 2 + 1.2; u < o.L / 2 - PITCH / 2 - 1.2; u += PITCH) {
        const cx = o.cx + ux * u + vx * c, cy = o.cy + uy * u + vy * c;
        let ok = ringsEdgeDist(b.p, cx, cy) > 1.2;
        for (let q = 0; q < 4 && ok; q++) {
          const du = (q & 1 ? 1 : -1) * (PITCH / 2 - 0.2), dv = (q & 2 ? 1 : -1) * (DEPTH / 2 - 0.1);
          if (!ptInRings(b.p, cx + ux * du + vx * dv, cy + uy * du + vy * dv)) ok = false;
        }
        if (!ok) continue;
        const seed = nHash((Math.round(cx * 10) * 73856093) ^ (Math.round(cy * 10) * 19349663));
        res.push(cx, cy, Math.atan2(vy * face, vx * face), seed < fill ? seed / fill : 2, 1);
      }
    }
    out = new Float32Array(res);
    slotCache.set(key, out);
    return out;
  }
  function deckCars(ctx, r, cam, i, b, k, snow) {
    const arr = deckSlots(i);
    if (!arr.length) return;
    const o = geo.ROTS[r], z = b.h;
    // lines and shadows in the deck's own plane
    setWorld(ctx, cam, r, z);
    if (k >= 2 && snow < 0.5) {
      ctx.beginPath();
      for (let s = 0; s < arr.length; s += 5) {
        const x = arr[s], y = arr[s + 1], ca = Math.cos(arr[s + 2]), sa = Math.sin(arr[s + 2]);
        for (const e of [-1, 1]) {
          const bx = x - sa * e * PITCH / 2, by = y + ca * e * PITCH / 2;
          ctx.moveTo(bx - ca * (DEPTH / 2 - 0.1), by - sa * (DEPTH / 2 - 0.1)); ctx.lineTo(bx + ca * (DEPTH / 2 - 0.4), by + sa * (DEPTH / 2 - 0.4));
        }
      }
      ctx.lineCap = "butt"; ctx.lineWidth = 0.12; ctx.strokeStyle = "rgba(248,246,238,.7)"; ctx.stroke();
    }
    const sx = SH_U * o.R[0] + SH_V * o.D[0], sy = SH_U * o.R[1] + SH_V * o.D[1];
    const order = [];
    ctx.beginPath();
    for (let s = 0; s < arr.length; s += 5) {
      if (arr[s + 3] > 1) continue;
      order.push(s);
      const x = arr[s] + sx * 0.7, y = arr[s + 1] + sy * 0.7, ca = Math.cos(arr[s + 2]), sa = Math.sin(arr[s + 2]);
      const l = 2.45, w = 1.05;
      ctx.moveTo(x + ca * l - sa * w, y + sa * l + ca * w); ctx.lineTo(x + ca * l + sa * w, y + sa * l - ca * w);
      ctx.lineTo(x - ca * l + sa * w, y - sa * l - ca * w); ctx.lineTo(x - ca * l - sa * w, y - sa * l + ca * w);
    }
    ctx.fillStyle = "rgba(38,50,60,.2)"; ctx.fill();
    setScreen(ctx, cam);
    order.sort((p, q) => depthOf(arr[q], arr[q + 1], r) - depthOf(arr[p], arr[p + 1], r));
    for (const s of order) drawCar(ctx, r, arr[s], arr[s + 1], arr[s + 2], arr[s + 3], k, z);
  }

  // Rooftop clutter, laid out once per building in its own frame (along its rectangle), so it lines up with the walls.
  const roofItems = new Map();
  function roofItemsOf(i, r) {
    let items = roofItems.get(i);
    if (items) return items;
    items = [];
    const b = data.buildings[i], st = styleOf(i);
    const o = obbFor(i);
    const rings = b.p;
    const area = st.area - (rings.length > 1 ? rings.slice(1).reduce((s, f) => s + Math.abs(ringArea(f)), 0) : 0);
    if (o && area > 160 && (st.hvac || st.skylights || st.solar || st.penthouse)) {
      const ux = Math.cos(o.ang), uy = Math.sin(o.ang), vx = -uy, vy = ux;
      const rnd = rng(strHashInt(b.id) + 77);
      // clear of the parapet by `m`, everywhere under a rotated rectangle (its corners and middle)
      const fits = (cx, cy, hx, hy, m) => {
        for (let c = 0; c < 5; c++) {
          const su = c === 4 ? 0 : c & 1 ? 1 : -1, sv = c === 4 ? 0 : c & 2 ? 1 : -1;
          const x = cx + ux * hx * su + vx * hy * sv, y = cy + uy * hx * su + vy * hy * sv;
          if (!ptInRings(rings, x, y) || ringsEdgeDist(rings, x, y) < m) return false;
        }
        return true;
      };
      const taken = [];
      const clear = (cx, cy, hx, hy) => {
        for (const t of taken) if (Math.abs((cx - t[0]) * ux + (cy - t[1]) * uy) < hx + t[2] + 0.8 && Math.abs((cx - t[0]) * vx + (cy - t[1]) * vy) < hy + t[3] + 0.8) return false;
        return true;
      };
      const add = (type, cx, cy, hx, hy, h, col) => { items.push({ type, cx, cy, ang: o.ang, hx, hy, h, col, seed: rnd() }); taken.push([cx, cy, hx, hy]); };
      const top = b.h;
      if (st.penthouse && area > 500) {
        // a plant room or stair tower, set back from the edge
        for (let tries = 0; tries < 8; tries++) {
          const hx = 2.6 + rnd() * 3, hy = 2.2 + rnd() * 2;
          const cx = o.cx + ux * (rnd() - 0.5) * o.L * 0.5 + vx * (rnd() - 0.5) * o.W * 0.3, cy = o.cy + uy * (rnd() - 0.5) * o.L * 0.5 + vy * (rnd() - 0.5) * o.W * 0.3;
          if (fits(cx, cy, hx, hy, 2.5) && clear(cx, cy, hx, hy)) { add("room", cx, cy, hx, hy, 2.8 + rnd(), null); break; }
        }
      }
      if (st.solar && area > 300) {
        // a block of panels on the open part of the roof
        const bw = Math.min(o.L * 0.5, 30), bh = Math.min(o.W * 0.5, 16);
        const cx0 = o.cx + ux * (rnd() - 0.5) * (o.L - bw) * 0.6, cy0 = o.cy + uy * (rnd() - 0.5) * (o.L - bw) * 0.6;
        for (let u = -bw / 2; u < bw / 2; u += 2.1) for (let v = -bh / 2; v < bh / 2; v += 2.4) {
          const cx = cx0 + ux * u + vx * v, cy = cy0 + uy * u + vy * v;
          if (fits(cx, cy, 0.95, 0.85, 1.2) && clear(cx, cy, 0.95, 0.85)) items.push({ type: "solar", cx, cy, ang: o.ang, hx: 0.95, hy: 0.85, h: 0.35, col: null, seed: 0 });
        }
      }
      if (st.skylights && area > 400) {
        // a row (or two) of skylights down the middle
        const rows = o.W > 30 ? [-o.W / 6, o.W / 6] : [0];
        for (const v of rows) for (let u = -o.L / 2 + 4; u < o.L / 2 - 4; u += 4.2) {
          const cx = o.cx + ux * u + vx * v, cy = o.cy + uy * u + vy * v;
          if (fits(cx, cy, 1.3, 0.8, 1.5) && clear(cx, cy, 1.3, 0.8)) add("sky", cx, cy, 1.3, 0.8, 0.45, null);
        }
      }
      if (st.hvac) {
        const n = Math.min(14, Math.round((area / 450) * st.hvac) + 1);
        for (let tries = 0, got = 0; tries < n * 5 && got < n; tries++) {
          const big = rnd() < 0.3;
          const hx = big ? 2 + rnd() * 1.6 : 0.8 + rnd() * 0.8, hy = big ? 1.2 + rnd() * 0.8 : 0.6 + rnd() * 0.5;
          const cx = o.cx + ux * (rnd() - 0.5) * (o.L - 4) + vx * (rnd() - 0.5) * (o.W - 4), cy = o.cy + uy * (rnd() - 0.5) * (o.L - 4) + vy * (rnd() - 0.5) * (o.W - 4);
          if (!fits(cx, cy, hx, hy, 1.4) || !clear(cx, cy, hx, hy)) continue;
          add(big ? "ahu" : "unit", cx, cy, hx, hy, big ? 1.5 + rnd() * 0.6 : 0.9 + rnd() * 0.5, pick(["#c9cbcc", "#bfc2c3", "#d3d2cc", "#b7bab9"], rnd()));
          got++;
        }
      }
      for (const it of items) it.z = top;
    }
    items.sorted = [];
    roofItems.set(i, items);
    return items;
  }
  function drawRoofItems(ctx, r, i, b, st, items, k, snow) {
    let order = items.sorted[r];
    if (!order) {
      order = items.map((_, q) => q).sort((p, q) => depthOf(items[q].cx, items[q].cy, r) - depthOf(items[p].cx, items[p].cy, r));
      items.sorted[r] = order;
    }
    const o = geo.ROTS[r];
    const sx = SH_U * o.R[0] + SH_V * o.D[0], sy = SH_U * o.R[1] + SH_V * o.D[1];
    // their shadows on the roof first
    if (k >= 2.5) {
      ctx.beginPath();
      for (const q of order) {
        const it = items[q];
        if (it.type === "solar") continue;
        const Q = rectQuad(it.cx + sx * it.h * 0.9, it.cy + sy * it.h * 0.9, it.ang, it.hx, it.hy);
        for (let c = 0; c < 4; c++) { projInto(PQ, 2 * c, Q[2 * c], Q[2 * c + 1], it.z, r); }
        ctx.moveTo(PQ[0], PQ[1]); ctx.lineTo(PQ[2], PQ[3]); ctx.lineTo(PQ[4], PQ[5]); ctx.lineTo(PQ[6], PQ[7]);   // (filled only)
      }
      ctx.fillStyle = "rgba(38,50,60,.13)"; ctx.fill();
    }
    const snowTop = (c) => (snow > 0.2 ? mx(c, "#f1f4f6", Math.min(0.85, snow)) : c);
    for (const q of order) {
      const it = items[q];
      const Q = rectQuad(it.cx, it.cy, it.ang, it.hx, it.hy);
      if (it.type === "solar") {
        // a tilted panel: its low edge on its rack, its high edge a little up
        projInto(PQ, 0, Q[0], Q[1], it.z + 0.25, r); projInto(PQ, 2, Q[2], Q[3], it.z + 0.25, r);
        projInto(PQ, 4, Q[4], Q[5], it.z + 0.7, r); projInto(PQ, 6, Q[6], Q[7], it.z + 0.7, r);
        ctx.beginPath(); ctx.moveTo(PQ[0], PQ[1]); ctx.lineTo(PQ[2], PQ[3]); ctx.lineTo(PQ[4], PQ[5]); ctx.lineTo(PQ[6], PQ[7]); ctx.closePath();
        ctx.fillStyle = snow > 0.4 ? "#e8edf1" : "#34495f"; ctx.fill();
        if (k >= 4 && snow <= 0.4) {
          ctx.beginPath();
          for (let s = 1; s < 3; s++) { const t = s / 3; ctx.moveTo(PQ[0] + (PQ[2] - PQ[0]) * t, PQ[1] + (PQ[3] - PQ[1]) * t); ctx.lineTo(PQ[6] + (PQ[4] - PQ[6]) * t, PQ[7] + (PQ[5] - PQ[7]) * t); }
          ctx.moveTo((PQ[0] + PQ[6]) / 2, (PQ[1] + PQ[7]) / 2); ctx.lineTo((PQ[2] + PQ[4]) / 2, (PQ[3] + PQ[5]) / 2);
          ctx.strokeStyle = "rgba(160,190,215,.45)"; ctx.lineWidth = 0.05; ctx.stroke();
        }
        continue;
      }
      if (it.type === "sky") {
        prism(ctx, r, Q, it.z, it.z + it.h, "#c9ccc9", snowTop("#9db7c5"), 0);
        if (k >= 4 && snow < 0.2) {
          projInto(PQ, 0, it.cx - Math.cos(it.ang) * it.hx * 0.6, it.cy - Math.sin(it.ang) * it.hx * 0.6, it.z + it.h, r);
          projInto(PQ, 2, it.cx + Math.cos(it.ang) * it.hx * 0.6, it.cy + Math.sin(it.ang) * it.hx * 0.6, it.z + it.h, r);
          ctx.beginPath(); ctx.moveTo(PQ[0], PQ[1]); ctx.lineTo(PQ[2], PQ[3]);
          ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = 0.12; ctx.stroke();
        }
        continue;
      }
      if (it.type === "room") { prism(ctx, r, Q, it.z, it.z + it.h, st.wall, snowTop(sh(st.roof, 0.95)), k >= 3 ? 0.05 : 0); continue; }
      prism(ctx, r, Q, it.z, it.z + it.h, it.col, snowTop(sh(it.col, 1.1)), k >= 3 ? 0.04 : 0);
      if (k >= 4 && it.seed < 0.6 && snow < 0.3) {
        // a fan grille on top
        const [X, Y] = geo.proj(it.cx, it.cy, it.z + it.h, r);
        const fr = Math.min(it.hx, it.hy) * 0.7;
        ctx.fillStyle = "#6a6e72"; ctx.beginPath(); ctx.ellipse(X, Y, fr, fr * S, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = "#8d9195"; ctx.beginPath(); ctx.ellipse(X, Y, fr * 0.35, fr * 0.35 * S, 0, 0, TAU); ctx.fill();
      }
    }
  }

  // A pitched roof's faces that face the camera (gable walls first, then the slopes), projected once per rotation.
  const pitchedCache = new Map();
  function pitchedGeom(i, r, b) {
    const key = i * 4 + r;
    let g = pitchedCache.get(key);
    if (g) return g;
    const [cx, cy, ang, L, W] = b.obb;
    const ov = 0.35;
    const lx = Math.cos(ang), ly = Math.sin(ang), wx = -ly, wy = lx;
    const hl = L / 2 + ov, hw = W / 2 + ov;
    const eave = b.h - b.rh, h = b.h;
    const shape = b.roof === "hipped" || b.roof === "half-hipped" || b.roof === "mansard" ? "hipped" : b.roof === "pyramidal" ? "pyramidal" : "gabled";
    const ridgeHalf = shape === "gabled" ? hl : shape === "hipped" ? Math.max(0, L / 2 - W / 2) : 0;
    const P = (along, across, z) => geo.proj(cx + lx * along + wx * across, cy + ly * along + wy * across, z, r);
    const o = geo.ROTS[r];
    const viewDot = (nx, ny, nz) => (nx * o.D[0] + ny * o.D[1]) * C - nz * S;   // < 0: faces the camera
    const pitch = Math.atan2(b.rh, W / 2);
    const faces = [];
    // the two long slopes
    for (const sgn of [1, -1]) {
      const nx = wx * sgn * Math.sin(pitch), ny = wy * sgn * Math.sin(pitch), nz = Math.cos(pitch);
      const pts = [P(-hl, sgn * hw, eave - 0.25), P(hl, sgn * hw, eave - 0.25), P(ridgeHalf, 0, h), P(-ridgeHalf, 0, h)];
      faces.push({ pts, vis: viewDot(nx, ny, nz), roof: true, nu: (nx * o.R[0] + ny * o.R[1]), nd: (nx * o.D[0] + ny * o.D[1]) });
    }
    // the ends: gable triangles (wall) or hip triangles (roof)
    for (const sgn of [1, -1]) {
      if (shape === "gabled") {
        const nx = lx * sgn, ny = ly * sgn;
        const pts = [P(sgn * (L / 2), -W / 2, eave), P(sgn * (L / 2), W / 2, eave), P(sgn * (L / 2), 0, h)];
        faces.push({ pts, vis: viewDot(nx, ny, 0), roof: false, nu: nx * o.R[0] + ny * o.R[1], nd: nx * o.D[0] + ny * o.D[1] });
      } else {
        const hp = Math.atan2(b.rh, shape === "pyramidal" ? L / 2 : W / 2);
        const nx = lx * sgn * Math.sin(hp), ny = ly * sgn * Math.sin(hp), nz = Math.cos(hp);
        const pts = [P(sgn * hl, -hw, eave - 0.25), P(sgn * hl, hw, eave - 0.25), P(sgn * ridgeHalf, 0, h)];
        faces.push({ pts, vis: viewDot(nx, ny, nz), roof: true, nu: nx * o.R[0] + ny * o.R[1], nd: nx * o.D[0] + ny * o.D[1] });
      }
    }
    // gable walls first, then the slopes; only those facing the camera
    faces.sort((a, b2) => (a.roof === b2.roof ? 0 : a.roof ? 1 : -1));
    const shown = faces.filter((fc) => fc.vis < 0).map((fc) => ({ pts: fc.pts, roof: fc.roof, light: lightOf(fc.nu, fc.nd) }));
    g = { faces: shown, ridge: [P(-ridgeHalf, 0, h), P(ridgeHalf, 0, h)], lx, ly, ridgeHalf, L, W, ang, cx, cy, h };
    pitchedCache.set(key, g);
    return g;
  }
  function drawPitchedRoof(ctx, r, cam, i, b, st, snow, outline, lineW, k) {
    const g = pitchedGeom(i, r, b);
    const { lx, ly, ridgeHalf, L, W, ang, cx, cy, h } = g;
    const rc = st.roof;
    for (const fc of g.faces) {
      ctx.beginPath(); ctx.moveTo(fc.pts[0][0], fc.pts[0][1]); for (let q = 1; q < fc.pts.length; q++) ctx.lineTo(fc.pts[q][0], fc.pts[q][1]);
      ctx.closePath();
      const light = fc.light;
      let col;
      if (fc.roof) { col = sh(rc, 0.78 + 0.42 * light); if (snow > 0.15) col = mx(col, "#f6f8fa", Math.min(0.92, snow * 1.15)); }
      else col = sh(st.wall, 0.7 + 0.36 * light);
      ctx.fillStyle = col; ctx.fill();
      if (outline) { ctx.strokeStyle = sh(col, 0.68); ctx.lineWidth = lineW; ctx.stroke(); }
      if (fc.roof && k >= 4 && snow < 0.5) {
        // shingle courses, parallel to the eaves
        const p = fc.pts;
        const n = Math.min(24, Math.max(3, Math.round(Math.hypot(b.rh, W / 2) / 0.42)));
        ctx.beginPath();
        for (let s = 1; s < n; s++) {
          const t = s / n;
          const a0 = p[0], a1 = p[1], c1 = p.length === 4 ? p[2] : p[2], c0 = p.length === 4 ? p[3] : p[2];
          ctx.moveTo(a0[0] + (c0[0] - a0[0]) * t, a0[1] + (c0[1] - a0[1]) * t); ctx.lineTo(a1[0] + (c1[0] - a1[0]) * t, a1[1] + (c1[1] - a1[1]) * t);
        }
        ctx.strokeStyle = rgba(sh(col, 0.78), 0.55); ctx.lineWidth = 0.05; ctx.stroke();
      } else if (!fc.roof && k >= 3 && b.rh > 1.6) {
        // a little attic window in the gable
        const p = fc.pts, mxp = (p[0][0] + p[1][0]) / 2, myp = (p[0][1] + p[1][1]) / 2;
        const ddx = (p[1][0] - p[0][0]) * 0.07, ddy = (p[1][1] - p[0][1]) * 0.07, z0 = b.rh * 0.25 * C, z1 = b.rh * 0.55 * C;
        ctx.beginPath(); ctx.moveTo(mxp - ddx, myp - ddy - z0); ctx.lineTo(mxp + ddx, myp + ddy - z0); ctx.lineTo(mxp + ddx, myp + ddy - z1); ctx.lineTo(mxp - ddx, myp - ddy - z1); ctx.closePath();
        ctx.fillStyle = sh(st.glass, 0.95); ctx.fill();
        if (k >= 4 && st.frame) { ctx.strokeStyle = st.frame; ctx.lineWidth = 0.08; ctx.stroke(); }
      }
    }
    if (outline) {
      // the ridge
      const a = g.ridge[0], c = g.ridge[1];
      ctx.strokeStyle = sh(rc, snow > 0.3 ? 0.9 : 0.62); ctx.lineWidth = lineW * 1.3;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(c[0], c[1]); ctx.stroke();
    }
    // a chimney on most houses, astride the ridge
    if (k >= 2 && st.kind === "house" && st.h4 < 0.7 && L > 5) {
      const along = (st.h4 / 0.7 - 0.5) * (ridgeHalf * 1.4 || L * 0.3);
      const Q = rectQuad(cx + lx * along, cy + ly * along, ang, 0.4, 0.35);
      prism(ctx, r, Q, h - 0.9, h + 0.7, st.h3 < 0.5 ? "#9c5a45" : "#8d8a85", snow > 0.3 ? "#eef1f3" : "#4a4440", 0);
    }
  }

  // ---------------------------------------------------------------- the stadium bowl
  // A building=stadium with the field as its hole: tiers of seats rise from a wall round the field to a concourse at
  // the rim, a band of suites part way up; outside, an arcade of arches; light banks on the rim. Built along rays from
  // the field's middle: for each of N directions, how far the field and the outer wall are. Then every face (seat
  // tier, riser, rim, facade) is a quad between neighbouring rays, sorted far to near per rotation (a height field
  // rising away from the field draws correctly in that order).
  const bowls = new Map();
  function bowlOf(i) {
    if (bowls.has(i)) return bowls.get(i);
    const b = data.buildings[i];
    let inner = null, ia = 0;
    for (let q = 1; q < b.p.length; q++) { const a = Math.abs(ringArea(b.p[q])); if (a > ia) { ia = a; inner = b.p[q]; } }
    let g = null;
    if (inner && ia > 400) {
      const outer = b.p[0];
      const [cx, cy] = ringCentroid(inner);
      const N = 112;
      const rin = new Float64Array(N), rout = new Float64Array(N);
      for (let j = 0; j < N; j++) {
        const a = (j / N) * TAU, dx = Math.cos(a), dy = Math.sin(a);
        rin[j] = rayFar(inner, cx, cy, dx, dy); rout[j] = rayFar(outer, cx, cy, dx, dy);
      }
      fillGaps(rin); fillGaps(rout);
      smoothRing(rout, 2); smoothRing(rin, 1);
      for (let j = 0; j < N; j++) if (rout[j] < rin[j] + 10) rout[j] = rin[j] + 10;
      const fo = obbOf(inner);
      const shoe = b.lm === "Ohio Stadium";
      const H = b.h, rim = H - Math.min(5, H * 0.18), zw = Math.min(2.4, rim * 0.12);
      g = { cx, cy, N, rin, rout, fo, shoe, H, rim, zw, pieces: null, rot: [] };
      buildBowl(g, b);
    }
    bowls.set(i, g);
    return g;
  }
  function fillGaps(arr) {
    const n = arr.length;
    let good = -1;
    for (let j = 0; j < n; j++) if (arr[j] > 0) { good = j; break; }
    if (good < 0) { arr.fill(10); return; }
    for (let s = 1; s <= n; s++) { const j = (good + s) % n; if (!(arr[j] > 0)) arr[j] = arr[(j + n - 1) % n]; }
  }
  function smoothRing(arr, passes) {
    const n = arr.length, tmp = new Float64Array(n);
    for (let p = 0; p < passes; p++) {
      for (let j = 0; j < n; j++) tmp[j] = (arr[(j + n - 1) % n] + 2 * arr[j] + arr[(j + 1) % n]) / 4;
      arr.set(tmp);
    }
  }
  // the pieces of the bowl in ground metres: { kind, pts: [x, y, z]*, n: outward normal (vertical faces), slope, col }
  function buildBowl(g, b) {
    const { cx, cy, N, rin, rout, fo, shoe, rim, zw, H } = g;
    const pieces = [];
    const dirX = new Float64Array(N), dirY = new Float64Array(N);
    for (let j = 0; j < N; j++) { dirX[j] = Math.cos((j / N) * TAU); dirY[j] = Math.sin((j / N) * TAU); }
    // the profile along each ray
    const R1 = new Float64Array(N), Z1 = new Float64Array(N), Z2 = new Float64Array(N), R2 = new Float64Array(N);
    for (let j = 0; j < N; j++) {
      const span = rout[j] - rin[j];
      const side = Math.abs(Math.sin((j / N) * TAU - fo.ang));
      const rimW = Math.min(5, span * 0.1);
      R1[j] = rin[j] + (span - rimW) * (shoe ? 0.48 : 0.55);
      Z1[j] = zw + (rim - zw) * (shoe ? 0.4 : 0.5);
      const riser = shoe ? 1.4 + 5.2 * side * side : (1 + 1.5 * side * side) * Math.min(1, rim / 20);
      Z2[j] = Math.min(rim - 2, Z1[j] + riser);
      R2[j] = rout[j] - rimW;
    }
    const P = (j, rr, z) => [cx + dirX[j] * rr, cy + dirY[j] * rr, z];
    const seatLo = shoe ? "#c3b6b2" : "#b9b5ad", seatUp = shoe ? "#b3aca8" : "#b3afa8";
    // The Horseshoe's stands are grey seats with a scarlet cast; solid scarlet in the middle of each sideline's lower
    // deck and toward the ends of the upper deck (as in aerial photos)
    const seatCol = (j, upper) => {
      if (!shoe) return upper ? seatUp : seatLo;
      const sd = Math.abs(Math.sin(((j + 0.5) / N) * TAU - fo.ang));
      if (!upper) return sd > 0.93 ? "#b3474f" : seatLo;
      return sd > 0.5 && sd < 0.72 ? "#b0525a" : seatUp;
    };
    const wallCol = b.lm === "Ohio Stadium" ? "#dccfb2" : "#cfc6b5";
    for (let j = 0; j < N; j++) {
      const j2 = (j + 1) % N;
      const mxd = (dirX[j] + dirX[j2]) / 2, myd = (dirY[j] + dirY[j2]) / 2, ml = Math.hypot(mxd, myd);
      const ux = mxd / ml, uy = myd / ml;   // outward along the rays
      // the wall round the field (faces in)
      pieces.push({ kind: "fieldwall", pts: [...P(j, rin[j], 0), ...P(j2, rin[j2], 0), ...P(j2, rin[j2], zw), ...P(j, rin[j], zw)], nx: -ux, ny: -uy, col: "#5b6a5e", j });
      // lower tier
      const sl = Math.atan2(Z1[j] - zw, R1[j] - rin[j]);
      pieces.push({ kind: "seats", pts: [...P(j, rin[j], zw), ...P(j2, rin[j2], zw), ...P(j2, R1[j2], Z1[j2]), ...P(j, R1[j], Z1[j])], ux, uy, slope: sl, col: seatCol(j, false), j, rows: (R1[j] - rin[j]) / 0.9 });
      // the suites' glass face (faces in)
      pieces.push({ kind: "suites", pts: [...P(j, R1[j], Z1[j]), ...P(j2, R1[j2], Z1[j2]), ...P(j2, R1[j2], Z2[j2]), ...P(j, R1[j], Z2[j])], nx: -ux, ny: -uy, col: "#3e4b57", j });
      // upper tier
      const su = Math.atan2(rim - Z2[j], R2[j] - R1[j]);
      pieces.push({ kind: "seats", pts: [...P(j, R1[j], Z2[j]), ...P(j2, R1[j2], Z2[j2]), ...P(j2, R2[j2], rim), ...P(j, R2[j], rim)], ux, uy, slope: su, col: seatCol(j, true), j, rows: (R2[j] - R1[j]) / 0.95 });
      // concourse at the rim, the parapet's inner face, the facade
      pieces.push({ kind: "rim", pts: [...P(j, R2[j], rim), ...P(j2, R2[j2], rim), ...P(j2, rout[j2], rim), ...P(j, rout[j], rim)], ux, uy, slope: 0, col: "#d9d1c0", j });
      pieces.push({ kind: "parapet", pts: [...P(j, rout[j], rim), ...P(j2, rout[j2], rim), ...P(j2, rout[j2], rim + 1.1), ...P(j, rout[j], rim + 1.1)], nx: -ux, ny: -uy, col: sh(wallCol, 0.95), j });
      pieces.push({ kind: "facade", pts: [...P(j, rout[j], 0), ...P(j2, rout[j2], 0), ...P(j2, rout[j2], rim + 1.1), ...P(j, rout[j], rim + 1.1)], nx: ux, ny: uy, col: wallCol, j });
    }
    // light banks on the rim: along the long sides (and the corners of smaller bowls)
    const banks = shoe ? [0.18, 0.32, 0.68, 0.82].flatMap((f) => [fo.ang / TAU + f * 0.5, fo.ang / TAU + 0.5 + f * 0.5]) : [0.125, 0.375, 0.625, 0.875].map((f) => fo.ang / TAU + f);
    for (const fr of banks) {
      const j = ((Math.round(fr * N) % N) + N) % N;
      const rr = rout[j] - 0.8;
      const [x, y] = P(j, rr, 0);
      pieces.push({ kind: "bank", x, y, ux: dirX[j], uy: dirY[j], z0: rim + 1.1, z1: H - 0.4, col: "#8d9196" });
    }
    if (shoe) {
      // the north end's rotunda, the press box along the west side, the scoreboard over the south stands
      const ax = Math.cos(fo.ang), ay = Math.sin(fo.ang);
      const nDir = ay >= 0 ? [ax, ay] : [-ax, -ay];
      const rN = rayFar(b.p[0], cx, cy, nDir[0], nDir[1]);
      if (rN > 0) pieces.push({ kind: "rotunda", x: cx + nDir[0] * (rN - 6.5), y: cy + nDir[1] * (rN - 6.5), rad: 9, z1: rim + 2.6, ux: nDir[0], uy: nDir[1] });
      const wDir = -ay > 0 ? [-ay, ax] : [ay, -ax];   // the perpendicular pointing west (−x)
      const west = wDir[0] < 0 ? wDir : [-wDir[0], -wDir[1]];
      const rW = rayFar(b.p[0], cx, cy, west[0], west[1]);
      if (rW > 0) {
        const tx = -west[1], ty = west[0];
        const len = 96, segs = 6;
        for (let s = 0; s < segs; s++) {
          const along = -len / 2 + (len / segs) * (s + 0.5);
          // follow the curve of the stands: each segment at the rim's distance along its own ray
          const px = cx + west[0] * (rW - 7) + tx * along, py = cy + west[1] * (rW - 7) + ty * along;
          const a = Math.atan2(py - cy, px - cx), jj = ((Math.round((a / TAU) * N) % N) + N) % N;
          const rr = rout[jj] - 6.5;
          pieces.push({ kind: "press", x: cx + dirX[jj] * rr, y: cy + dirY[jj] * rr, ang: Math.atan2(ty, tx), hx: len / segs / 2 + 0.3, hy: 3.6, z0: rim - 5, z1: H - 0.6, ux: west[0], uy: west[1] });
        }
      }
      const sDir = [-nDir[0], -nDir[1]];
      const rS = rayFar(b.p[0], cx, cy, sDir[0], sDir[1]);
      if (rS > 0) pieces.push({ kind: "board", x: cx + sDir[0] * (rS - 4), y: cy + sDir[1] * (rS - 4), ang: Math.atan2(sDir[0], -sDir[1]), hx: 17, hy: 0.9, z0: rim - 2, z1: H - 0.5, ux: sDir[0], uy: sDir[1] });
    }
    g.pieces = pieces;
  }
  // the pieces seen from rotation r, culled, lit, projected and sorted far to near
  function bowlFor(g, r) {
    if (g.rot[r]) return g.rot[r];
    const o = geo.ROTS[r];
    const list = [];
    for (const p of g.pieces) {
      if (p.pts) {
        const pts = p.pts, n = pts.length / 3;
        let dsum = 0;
        for (let q = 0; q < n; q++) dsum += pts[3 * q] * o.D[0] + pts[3 * q + 1] * o.D[1];
        let depth = dsum / n, fill;
        if (p.nx != null) {
          const nd = p.nx * o.D[0] + p.ny * o.D[1];
          if (nd >= 0) continue;
          fill = sh(p.col, 0.7 + 0.36 * lightOf(p.nx * o.R[0] + p.ny * o.R[1], nd));
        } else {
          // a slope rising outward along (ux, uy): its normal leans inward
          const sn = Math.sin(p.slope), cs = Math.cos(p.slope);
          const nx = -p.ux * sn, ny = -p.uy * sn;
          if ((nx * o.D[0] + ny * o.D[1]) * C - cs * S >= 0) continue;
          fill = sh(p.col, 0.84 + 0.22 * lightOf(nx * o.R[0] + ny * o.R[1], nx * o.D[0] + ny * o.D[1]) / Math.max(0.2, sn || 1) * sn + 0.04 * cs);
        }
        const P2 = new Float32Array(n * 2);
        for (let q = 0; q < n; q++) projInto(P2, 2 * q, pts[3 * q], pts[3 * q + 1], pts[3 * q + 2], r);
        // a nudge so that, where depths tie, risers come after the seats behind them
        if (p.kind === "fieldwall" || p.kind === "suites") depth -= 0.01;
        list.push({ p, P: P2, depth, fill });
      } else {
        const dd = p.x * o.D[0] + p.y * o.D[1];
        const far = p.ux * o.D[0] + p.uy * o.D[1] > 0;
        let depth = dd;
        if (p.kind === "rotunda") depth = dd + (far ? p.rad : -p.rad);
        else if (p.kind === "bank") depth = dd - 0.6;
        else if (p.kind === "press") depth = dd + (far ? 3 : -3);
        else if (p.kind === "board") depth = dd + (far ? 1 : -1);
        list.push({ p, P: null, depth, fill: null });
      }
    }
    list.sort((a, b2) => b2.depth - a.depth);
    g.rot[r] = list;
    return list;
  }
  function drawBowl(ctx, r, cam, i, b, st, g, k, style) {
    setScreen(ctx, cam);
    const list = bowlFor(g, r);
    const snow = style.snow || 0;
    const outline = k >= 0.8, lineW = Math.min(0.12, 0.9 / k);
    for (const it of list) {
      const p = it.p;
      if (it.P) {
        const P2 = it.P;
        ctx.beginPath(); ctx.moveTo(P2[0], P2[1]);
        for (let q = 2; q < P2.length; q += 2) ctx.lineTo(P2[q], P2[q + 1]);
        ctx.closePath();
        let fill = it.fill;
        if (snow > 0.15 && (p.kind === "seats" || p.kind === "rim")) fill = mx(fill, "#f4f6f8", Math.min(0.85, snow));
        ctx.fillStyle = fill; ctx.fill();
        if (p.kind === "seats" && k >= 1.5) seatRows(ctx, P2, p, fill, k, g);
        else if (p.kind === "suites" && k >= 1.5) {
          // a scarlet fascia along the top of the suite level
          ctx.beginPath();
          const f0 = 0.78;
          ctx.moveTo(P2[0] + (P2[6] - P2[0]) * f0, P2[1] + (P2[7] - P2[1]) * f0); ctx.lineTo(P2[2] + (P2[4] - P2[2]) * f0, P2[3] + (P2[5] - P2[3]) * f0);
          ctx.lineTo(P2[4], P2[5]); ctx.lineTo(P2[6], P2[7]); ctx.closePath();
          ctx.fillStyle = g.shoe ? "#a4252c" : "#6d6e71"; ctx.fill();
        } else if (p.kind === "facade") {
          if (outline) { ctx.strokeStyle = sh(fill, 0.8); ctx.lineWidth = lineW * 0.6; ctx.stroke(); }
          if (k >= 1) facadeArches(ctx, P2, g, k, fill, 0);
        } else if (p.kind === "rim" && outline) {
          // the coping of the parapet along the outer edge
          ctx.beginPath(); ctx.moveTo(P2[6], P2[7]); ctx.lineTo(P2[4], P2[5]);
          ctx.strokeStyle = sh(fill, 0.82); ctx.lineWidth = lineW; ctx.stroke();
        }
        continue;
      }
      if (p.kind === "bank") lightBank(ctx, r, p, k);
      else if (p.kind === "rotunda") rotunda(ctx, r, p, k, g, snow);
      else if (p.kind === "press") {
        const Q = rectQuad(p.x, p.y, p.ang, p.hx, p.hy);
        prism(ctx, r, Q, p.z0, p.z1, "#3f4b56", snow > 0.2 ? "#eef1f3" : "#cfc9bd", 0);
        if (k >= 2) pressBoxBands(ctx, r, p, k);
      } else if (p.kind === "board") {
        const Q = rectQuad(p.x, p.y, p.ang, p.hx, p.hy);
        prism(ctx, r, Q, p.z0, p.z1, "#45484d", "#5a5d62", 0);
        if (k >= 1.5) scoreboardFace(ctx, r, p);
      }
    }
  }
  // rows of seats: lines across the tier between its inner and outer edges, and an aisle down every few bays
  function seatRows(ctx, P2, p, fill, k, g) {
    const n = Math.max(2, Math.round(p.rows / (k >= 4 ? 1 : k >= 2.5 ? 2 : 4)));
    ctx.beginPath();
    for (let s = 1; s < n; s++) {
      const t = s / n;
      ctx.moveTo(P2[0] + (P2[6] - P2[0]) * t, P2[1] + (P2[7] - P2[1]) * t); ctx.lineTo(P2[2] + (P2[4] - P2[2]) * t, P2[3] + (P2[5] - P2[3]) * t);
    }
    ctx.strokeStyle = sh(fill, 0.8); ctx.lineWidth = k >= 4 ? 0.12 : 0.2; ctx.stroke();
    if (p.j % 4 === 0) {
      ctx.beginPath(); ctx.moveTo(P2[0], P2[1]); ctx.lineTo(P2[6], P2[7]);
      ctx.strokeStyle = sh(fill, 1.12); ctx.lineWidth = k >= 3 ? 0.55 : 0.8; ctx.stroke();
    }
  }
  // the arcade round the outside: a tall arch per bay, a row of small windows above it
  function facadeArches(ctx, P2, g, k, fill, lit) {
    // P2: bottom-left, bottom-right, top-right, top-left of one bay of facade
    const H = g.rim + 1.1;
    const at = (t, z) => {
      const bx = P2[0] + (P2[2] - P2[0]) * t, by = P2[1] + (P2[3] - P2[1]) * t;
      return [bx, by - z * C];
    };
    const w = 0.28, za = g.rim * 0.08, zb = g.rim * (g.shoe ? 0.42 : 0.36);
    ctx.beginPath();
    let p0 = at(0.5 - w, za);
    ctx.moveTo(p0[0], p0[1]);
    p0 = at(0.5 + w, za); ctx.lineTo(p0[0], p0[1]);
    p0 = at(0.5 + w, zb); ctx.lineTo(p0[0], p0[1]);
    // the round head of the arch, in the wall's plane
    const bayLen = Math.hypot(P2[2] - P2[0], (P2[3] - P2[1]) / Math.max(0.3, S));
    const rr = Math.min(w * bayLen, zb * 0.3);
    for (let s = 1; s < 8; s++) {
      const a = (s / 8) * Math.PI;
      const t = 0.5 + w * Math.cos(a), z = zb + rr * Math.sin(a);
      p0 = at(t, z); ctx.lineTo(p0[0], p0[1]);
    }
    p0 = at(0.5 - w, zb); ctx.lineTo(p0[0], p0[1]);
    ctx.closePath();
    if (lit) { ctx.fillStyle = lit; ctx.fill(); return; }
    ctx.fillStyle = sh(fill, 0.55); ctx.fill();
    if (k >= 2) {
      ctx.beginPath();
      const z0 = zb + rr + g.rim * 0.12, z1 = Math.min(H - 2, z0 + g.rim * 0.14);
      for (const c of [0.3, 0.7]) {
        let q = at(c - 0.08, z0); ctx.moveTo(q[0], q[1]);
        q = at(c + 0.08, z0); ctx.lineTo(q[0], q[1]);
        q = at(c + 0.08, z1); ctx.lineTo(q[0], q[1]);
        q = at(c - 0.08, z1); ctx.lineTo(q[0], q[1]);
        ctx.closePath();
      }
      ctx.fillStyle = sh(fill, 0.62); ctx.fill();
      // pilasters between the bays
      ctx.beginPath();
      let q = at(0.02, 0); ctx.moveTo(q[0], q[1]); q = at(0.02, H - 0.4); ctx.lineTo(q[0], q[1]);
      ctx.strokeStyle = sh(fill, 1.1); ctx.lineWidth = 0.35; ctx.stroke();
    }
  }
  function lightBank(ctx, r, p, k) {
    const [X, Y0] = geo.proj(p.x, p.y, p.z0, r);
    const Y1 = Y0 - (p.z1 - p.z0) * C;
    ctx.strokeStyle = "#6f7378"; ctx.lineWidth = 0.45; ctx.lineCap = "butt";
    ctx.beginPath(); ctx.moveTo(X, Y0); ctx.lineTo(X, Y1 + 1.2); ctx.stroke();
    // the bank of lamps, facing the field
    const Q = rectQuad(p.x - p.ux * 0.4, p.y - p.uy * 0.4, Math.atan2(p.uy, p.ux) + Math.PI / 2, 3.2, 0.35);
    prism(ctx, r, Q, p.z1 - 1.8, p.z1, "#9a9ea3", "#7b7f84", 0);
    if (k >= 2) {
      // lamps: a grid of pale dots on whichever face we see
      const o = geo.ROTS[r], facing = -(p.ux * o.D[0] + p.uy * o.D[1]) < 0;
      if (facing) {
        const tx = -p.uy, ty = p.ux;
        ctx.fillStyle = "#f4efdc";
        ctx.beginPath();
        for (let a = -2.6; a <= 2.7; a += 0.9) for (let z = p.z1 - 1.5; z < p.z1 - 0.2; z += 0.55) {
          const [x2, y2] = geo.proj(p.x - p.ux * 0.8 + tx * a, p.y - p.uy * 0.8 + ty * a, z, r);
          ctx.rect(x2 - 0.2, y2 - 0.16, 0.4, 0.32);
        }
        ctx.fill();
      }
    }
  }
  function rotunda(ctx, r, p, k, g, snow) {
    const [X, Y] = geo.proj(p.x, p.y, 0, r);
    const R = p.rad, Ht = p.z1 * C, ry = R * S;
    // the drum: lit on the left, a horizontal gradient of stone
    const body = ctx.createLinearGradient(X - R, 0, X + R, 0);
    body.addColorStop(0, "#eee3c9"); body.addColorStop(0.45, "#dccfb2"); body.addColorStop(1, "#b1a68f");
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(X - R, Y - Ht); ctx.lineTo(X - R, Y); ctx.ellipse(X, Y, R, ry, 0, Math.PI, 0, true); ctx.lineTo(X + R, Y - Ht);
    ctx.ellipse(X, Y - Ht, R, ry, 0, 0, Math.PI, false);
    ctx.closePath(); ctx.fill();
    if (k >= 1.2) {
      // tall arched windows round the front half
      ctx.fillStyle = "#6a5e52";
      ctx.beginPath();
      for (let s = 0; s < 7; s++) {
        const a = Math.PI * (0.1 + 0.8 * (s / 6));
        const ax = X - Math.cos(a) * R, ay = Y + Math.sin(a) * ry;
        const w = R * 0.11 * Math.sin(a);
        const z0 = p.z1 * 0.14, z1 = p.z1 * 0.62;
        ctx.moveTo(ax - w, ay - z0 * C); ctx.lineTo(ax + w, ay - z0 * C); ctx.lineTo(ax + w, ay - z1 * C);
        ctx.ellipse(ax, ay - z1 * C, w, w * 1.1, 0, 0, Math.PI, true); ctx.closePath();
      }
      ctx.fill();
      // a frieze band near the top
      ctx.strokeStyle = "#f1e8d3"; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.ellipse(X, Y - Ht * 0.82, R, ry, 0, 0, Math.PI); ctx.stroke();
    }
    // the roof: a shallow copper dome with a little lantern
    const top = snow > 0.2 ? "#eef1f3" : "#8fa39a";
    ctx.fillStyle = top;
    ctx.beginPath(); ctx.ellipse(X, Y - Ht, R, ry, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = sh(top, 0.86);
    ctx.beginPath(); ctx.ellipse(X, Y - Ht, R * 0.98, ry * 0.98, 0, Math.PI, TAU); ctx.ellipse(X, Y - Ht - R * 0.2, R * 0.98, R * 0.32, 0, 0, Math.PI, true); ctx.closePath(); ctx.fill();
    ctx.fillStyle = sh(top, 1.12);
    ctx.beginPath(); ctx.ellipse(X - R * 0.25, Y - Ht - R * 0.18, R * 0.4, R * 0.14, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = "#e9e0cb"; ctx.fillRect(X - 0.9, Y - Ht - R * 0.32 - 1.6, 1.8, 1.6);
  }
  function pressBoxBands(ctx, r, p, k) {
    // floors of glass: light mullion lines on whichever long face we see
    const o = geo.ROTS[r];
    const ux = Math.cos(p.ang), uy = Math.sin(p.ang);
    for (const s of [-1, 1]) {
      const nx = -uy * s, ny = ux * s;
      if (nx * o.D[0] + ny * o.D[1] >= 0) continue;
      ctx.beginPath();
      for (let z = p.z0 + 1.8; z < p.z1; z += 2.6) {
        const [ax, ay] = geo.proj(p.x - ux * p.hx + nx * p.hy, p.y - uy * p.hx + ny * p.hy, z, r);
        const [bx, by] = geo.proj(p.x + ux * p.hx + nx * p.hy, p.y + uy * p.hx + ny * p.hy, z, r);
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      }
      ctx.strokeStyle = "rgba(220,225,228,.55)"; ctx.lineWidth = 0.25; ctx.stroke();
    }
  }
  function scoreboardFace(ctx, r, p) {
    // the face that looks over the field: a dark screen in a light frame, a scarlet stripe along the top
    const o = geo.ROTS[r];
    const nx = -p.ux, ny = -p.uy;
    if (nx * o.D[0] + ny * o.D[1] >= 0) return;
    const ux = Math.cos(p.ang), uy = Math.sin(p.ang);
    const cx = p.x + nx * (p.hy + 0.05), cy = p.y + ny * (p.hy + 0.05);
    const corner = (a, z) => geo.proj(cx + ux * a, cy + uy * a, z, r);
    const face = (a0, a1, z0, z1, col) => {
      const q0 = corner(a0, z0), q1 = corner(a1, z0), q2 = corner(a1, z1), q3 = corner(a0, z1);
      ctx.beginPath(); ctx.moveTo(q0[0], q0[1]); ctx.lineTo(q1[0], q1[1]); ctx.lineTo(q2[0], q2[1]); ctx.lineTo(q3[0], q3[1]); ctx.closePath();
      ctx.fillStyle = col; ctx.fill();
    };
    face(-p.hx + 0.6, p.hx - 0.6, p.z0 + 0.6, p.z1 - 1.4, "#22262b");
    face(-p.hx + 0.6, p.hx - 0.6, p.z1 - 1.3, p.z1 - 0.4, "#a4252c");
    face(-p.hx * 0.8, -p.hx * 0.1, p.z0 + 1.4, p.z1 - 2.4, "#3b4652");
    face(p.hx * 0.1, p.hx * 0.8, p.z0 + 1.4, p.z1 - 2.4, "#3b4652");
  }

  // ---------------------------------------------------------------- grandstands and bleachers
  // Seats rise away from the nearest field: heights follow the distance from the field's middle, so a stand curved
  // round a diamond gets curved rows.
  let fieldCentres = null;
  const stands = new Map();
  function standOf(i) {
    if (stands.has(i)) return stands.get(i);
    if (!fieldCentres) {
      fieldCentres = [];
      data.areas.forEach((a) => { if (a.k === "pitch" || a.k === "track") { const [x, y] = ringCentroid(a.p[0]); fieldCentres.push([x, y]); } });
    }
    const b = data.buildings[i], f = b.p[0];
    const [gx, gy] = ringCentroid(f);
    let best = null, bd = 160 * 160;
    for (const c of fieldCentres) { const d = (c[0] - gx) ** 2 + (c[1] - gy) ** 2; if (d < bd) { bd = d; best = c; } }
    let cx, cy;
    if (best) { cx = best[0]; cy = best[1]; }
    else {
      const o = obbFor(i) || { cx: gx, cy: gy, ang: 0 };
      cx = o.cx + Math.cos(o.ang + Math.PI / 2) * 1000; cy = o.cy + Math.sin(o.ang + Math.PI / 2) * 1000;
    }
    let dmin = Infinity, dmax = -Infinity;
    for (let q = 0; q < f.length; q += 2) { const d = Math.hypot(f[q] - cx, f[q + 1] - cy); if (d < dmin) dmin = d; if (d > dmax) dmax = d; }
    const zf = Math.min(1.2, b.h * 0.12), zt = b.h;
    const s = { cx, cy, dmin, dmax: Math.max(dmax, dmin + 1), zf, zt, z: null };
    s.zAt = (x, y) => s.zf + (s.zt - s.zf) * clamp((Math.hypot(x - s.cx, y - s.cy) - s.dmin) / (s.dmax - s.dmin), 0, 1);
    stands.set(i, s);
    return s;
  }
  function drawBleachers(ctx, r, cam, i, b, st, k, style) {
    const s = standOf(i);
    const f = b.p[0], n = f.length / 2;
    const rings = scene.forRot(r).objRings[i];
    const F = rings[0];
    const snow = style.snow || 0;
    setScreen(ctx, cam);
    const walls = visibleWalls(i, r);
    // walls: from the ground up to the seats' height at each end
    for (const wv of walls) {
      if (wv.ri !== 0) continue;
      const za = s.zAt(f[2 * wv.c], f[2 * wv.c + 1]), zb = s.zAt(f[2 * wv.a], f[2 * wv.a + 1]);
      ctx.beginPath();
      ctx.moveTo(F[2 * wv.c], F[2 * wv.c + 1]); ctx.lineTo(F[2 * wv.a], F[2 * wv.a + 1]);
      ctx.lineTo(F[2 * wv.a], F[2 * wv.a + 1] - zb * C); ctx.lineTo(F[2 * wv.c], F[2 * wv.c + 1] - za * C); ctx.closePath();
      const wc = sh(st.wall, 0.68 + 0.34 * wv.light);
      ctx.fillStyle = wc; ctx.fill();
      if (k >= 0.8) { ctx.strokeStyle = sh(wc, 0.75); ctx.lineWidth = Math.min(0.12, 0.9 / k); ctx.stroke(); }
      if (k >= 2 && Math.max(za, zb) > 3) {
        // the steel frame under the seats
        ctx.beginPath();
        const m = Math.max(1, Math.round(wv.L / 4));
        for (let q = 1; q < m; q++) {
          const t = q / m, x = F[2 * wv.c] + (F[2 * wv.a] - F[2 * wv.c]) * t, y = F[2 * wv.c + 1] + (F[2 * wv.a + 1] - F[2 * wv.c + 1]) * t;
          ctx.moveTo(x, y); ctx.lineTo(x, y - (za + (zb - za) * t) * C);
        }
        ctx.strokeStyle = sh(wc, 0.8); ctx.lineWidth = 0.1; ctx.stroke();
      }
    }
    // the seats: the outline lifted to its heights
    ctx.beginPath();
    for (let q = 0; q < n; q++) {
      const [X, Y] = geo.proj(f[2 * q], f[2 * q + 1], s.zAt(f[2 * q], f[2 * q + 1]), r);
      if (q) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
    }
    ctx.closePath();
    const seat = snow > 0.15 ? mx(st.roof, "#f4f6f8", Math.min(0.85, snow)) : st.roof;
    ctx.fillStyle = seat; ctx.fill();
    if (k >= 1.5 && s.dmax - s.dmin > 2) {
      // rows: arcs round the field's middle at each row's height, kept to the stand
      ctx.save(); ctx.clip();
      const rows = Math.min(40, Math.round((s.dmax - s.dmin) / (k >= 3 ? 0.85 : 1.7)));
      let a0 = Infinity, a1 = -Infinity;
      const ref = Math.atan2(f[1] - s.cy, f[0] - s.cx);
      for (let q = 0; q < n; q++) {
        let a = Math.atan2(f[2 * q + 1] - s.cy, f[2 * q] - s.cx) - ref;
        a = ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
        if (a < a0) a0 = a; if (a > a1) a1 = a;
      }
      ctx.beginPath();
      for (let w = 1; w < rows; w++) {
        const d = s.dmin + ((s.dmax - s.dmin) * w) / rows, z = s.zf + ((s.zt - s.zf) * w) / rows;
        const steps = Math.max(2, Math.min(24, Math.ceil(((a1 - a0) * d) / 4)));
        for (let q = 0; q <= steps; q++) {
          const a = ref + a0 + ((a1 - a0) * q) / steps;
          const [X, Y] = geo.proj(s.cx + Math.cos(a) * d, s.cy + Math.sin(a) * d, z, r);
          if (q) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
        }
      }
      ctx.strokeStyle = sh(seat, 0.78); ctx.lineWidth = 0.12; ctx.stroke();
      ctx.restore();
    }
  }

  // ================================================================ outlines (shared by the night lights and silhouette)
  // What of a building can hide what stands behind it, in screen metres: its camera-facing walls (far to near, in the
  // order of visibleWalls for ordinary buildings), the solid outline of its roof, and the roof's courtyard holes. Every
  // polygon winds the same way on the screen as ctx.rect() does (clockwise, y down), so a list of them fills as one union
  // under the nonzero rule.
  const outlines = new Map();
  function orientPoly(p) {
    let a = 0;
    for (let q = 0, n = p.length; q < n; q += 2) { const j = (q + 2) % n; a += p[q] * p[j + 1] - p[j] * p[q + 1]; }
    if (a >= 0) return p;
    const out = new Float32Array(p.length);
    for (let q = 0, n = p.length / 2; q < n; q++) { out[2 * q] = p[2 * (n - 1 - q)]; out[2 * q + 1] = p[2 * (n - 1 - q) + 1]; }
    return out;
  }
  // the convex hull of a flat list of screen points, as a polygon
  function hullPoly(pts) {
    const list = [];
    for (let q = 0; q < pts.length; q += 2) list.push([pts[q], pts[q + 1]]);
    const h = hull2(list);
    return orientPoly(new Float32Array(h.flat()));
  }
  // a box standing on a ground quad (q: 4 corners), from z0 to z1: its screen outline
  function boxHull(q, z0, z1, r) {
    const pts = new Float64Array(16);
    for (let c = 0; c < 4; c++) { projInto(pts, 2 * c, q[2 * c], q[2 * c + 1], z0, r); projInto(pts, 8 + 2 * c, q[2 * c], q[2 * c + 1], z1, r); }
    return hullPoly(pts);
  }
  function outlineOf(i, r) {
    const key = i * 4 + r;
    let ol = outlines.get(key);
    if (ol !== undefined) return ol;
    const b = data.buildings[i];
    ol = null;
    if (!b.hidden) {
      const st = styleOf(i), rings = scene.forRot(r).objRings[i];
      const walls = [], roof = [], holes = [];
      const g = st.kind === "bowl" ? bowlOf(i) : null;
      if (g) {
        // the facade bays that face us, and the rim all round (the stands inside it hide everything behind)
        for (const it of bowlFor(g, r)) if (it.p.kind === "facade") walls.push(orientPoly(Float32Array.from(it.P)));
        const rimP = new Float32Array(g.N * 2);
        for (let j = 0; j < g.N; j++) { const a = (j / g.N) * TAU; projInto(rimP, 2 * j, g.cx + Math.cos(a) * g.rout[j], g.cy + Math.sin(a) * g.rout[j], g.rim + 1.1, r); }
        roof.push(orientPoly(rimP));
        for (const p of g.pieces) {
          if (p.kind === "press" || p.kind === "board") roof.push(boxHull(rectQuad(p.x, p.y, p.ang, p.hx, p.hy), p.z0, p.z1, r));
          else if (p.kind === "rotunda") roof.push(boxHull(rectQuad(p.x, p.y, 0, p.rad, p.rad), 0, p.z1 + 1.2, r));
        }
      } else if (st.kind === "bleachers") {
        const s = standOf(i), f = b.p[0], F = rings[0], n = f.length / 2;
        for (const wv of visibleWalls(i, r)) {
          if (wv.ri !== 0) continue;
          const za = s.zAt(f[2 * wv.c], f[2 * wv.c + 1]) * C, zb = s.zAt(f[2 * wv.a], f[2 * wv.a + 1]) * C;
          walls.push(orientPoly(new Float32Array([F[2 * wv.c], F[2 * wv.c + 1], F[2 * wv.a], F[2 * wv.a + 1], F[2 * wv.a], F[2 * wv.a + 1] - zb, F[2 * wv.c], F[2 * wv.c + 1] - za])));
        }
        const seat = new Float32Array(n * 2);
        for (let q = 0; q < n; q++) projInto(seat, 2 * q, f[2 * q], f[2 * q + 1], s.zAt(f[2 * q], f[2 * q + 1]), r);
        roof.push(orientPoly(seat));
      } else {
        const pitched = b.roof && b.roof !== "flat" && b.obb;
        const top = wallTop(b) * C, bot = (b.mh || 0) * C;
        for (const wv of visibleWalls(i, r)) {
          const f = rings[wv.ri];
          const x1 = f[2 * wv.c], y1 = f[2 * wv.c + 1], x2 = f[2 * wv.a], y2 = f[2 * wv.a + 1];
          walls.push(orientPoly(new Float32Array([x1, y1 - bot, x2, y2 - bot, x2, y2 - top, x1, y1 - top])));
        }
        if (pitched) roof.push(pitchedHull(b, r));
        else {
          const lift = (f) => { const p = new Float32Array(f.length); for (let q = 0; q < f.length; q += 2) { p[q] = f[q]; p[q + 1] = f[q + 1] - top; } return p; };
          roof.push(orientPoly(lift(rings[0])));
          for (let q = 1; q < rings.length; q++) holes.push(lift(rings[q]));
        }
      }
      ol = { walls, roof, holes };
    }
    outlines.set(key, ol);
    return ol;
  }
  // A pitched roof's outline: the hull of its eaves (with the overhang, as drawPitchedRoof draws them) and its ridge.
  function pitchedHull(b, r) {
    const [cx, cy, ang, L, W] = b.obb;
    const ov = 0.35, lx = Math.cos(ang), ly = Math.sin(ang), wx = -ly, wy = lx;
    const hl = L / 2 + ov, hw = W / 2 + ov, eave = b.h - b.rh;
    const shape = b.roof === "hipped" || b.roof === "half-hipped" || b.roof === "mansard" ? "hipped" : b.roof === "pyramidal" ? "pyramidal" : "gabled";
    const ridgeHalf = shape === "gabled" ? hl : shape === "hipped" ? Math.max(0, L / 2 - W / 2) : 0;
    const pts = new Float64Array(12);
    let o = 0;
    for (const [a, c, z] of [[-hl, -hw, eave - 0.25], [hl, -hw, eave - 0.25], [hl, hw, eave - 0.25], [-hl, hw, eave - 0.25], [-ridgeHalf, 0, b.h], [ridgeHalf, 0, b.h]]) {
      projInto(pts, o, cx + lx * a + wx * c, cy + ly * a + wy * c, z, r); o += 2;
    }
    return hullPoly(pts);
  }
  // roof clutter tall enough to show over the roof's back edge: its boxes' outlines (when the tiles draw it)
  const itemOutlines = new Map();
  function roofItemOutlines(i, r) {
    const key = i * 4 + r;
    let out = itemOutlines.get(key);
    if (out) return out;
    out = [];
    for (const it of roofItemsOf(i, r)) {
      if (it.type === "solar" || it.type === "sky") continue;
      out.push(boxHull(rectQuad(it.cx, it.cy, it.ang, it.hx, it.hy), it.z, it.z + it.h, r));
    }
    itemOutlines.set(key, out);
    return out;
  }
  // does drawFlatRoof put clutter on this building's roof at this level of detail?
  function roofItemsShown(b, st, k) {
    return k >= 2 && !(b.roof && b.roof !== "flat" && b.obb) && b.h - (b.mh || 0) >= 2.5 && st.kind !== "house" && st.kind !== "small" && st.kind !== "parking" && st.kind !== "bowl" && st.kind !== "bleachers";
  }
  // append a polygon (screen metres) to a path, as device pixels for the scale s and offset (ox, oy). (Silhouettes are
  // only ever filled or clipped to: their subpaths are left open, see quadF.)
  function polyOut(p, f, s, ox, oy) {
    p.moveTo(f[0] * s - ox, f[1] * s - oy);
    for (let q = 2; q < f.length; q += 2) p.lineTo(f[q] * s - ox, f[q + 1] * s - oy);
  }
  // append a polygon (screen metres) to a path as it is (left open: for fills, see quadF)
  function polyAdd(p, f) {
    p.moveTo(f[0], f[1]);
    for (let q = 2; q < f.length; q += 2) p.lineTo(f[q], f[q + 1]);
  }
  // an outline's courtyard holes, wound against its roof (so under the nonzero rule they open only their own roof)
  function holesReversed(ol) {
    if (ol.holesRev) return ol.holesRev;
    return (ol.holesRev = ol.holes.map((h) => {
      const p = orientPoly(h), n = p.length / 2, out = new Float32Array(p.length);
      for (let q = 0; q < n; q++) { out[2 * q] = p[2 * (n - 1 - q)]; out[2 * q + 1] = p[2 * (n - 1 - q) + 1]; }
      return out;
    }));
  }
  function quadOut(p, s, ox, oy, ax, ay, bx, by, cx, cy, dx, dy) {
    // four corners in any order round the quad: wound like rect()
    const a = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (a < 0) { let t = bx; bx = dx; dx = t; t = by; by = dy; dy = t; }
    p.moveTo(ax * s - ox, ay * s - oy); p.lineTo(bx * s - ox, by * s - oy); p.lineTo(cx * s - ox, cy * s - oy); p.lineTo(dx * s - ox, dy * s - oy);
  }

  /**
   * Append object id's visible outline to path (a Path2D, or a 2D context's current path), in device pixels for the
   * camera { k, lod?, ox, oy }: exactly the shapes drawObject paints at that level of detail. See the notes at the top.
   */
  function silhouette(path, r, cam, id, style) {
    const s = cam.k, ox = cam.ox, oy = cam.oy, lod = cam.lod || cam.k;
    style = style || currentStyle;
    if (id < B) {
      const ol = outlineOf(id, r);
      if (!ol) return path;
      for (const f of ol.walls) polyOut(path, f, s, ox, oy);
      for (const f of ol.roof) polyOut(path, f, s, ox, oy);
      const b = data.buildings[id], st = styleOf(id);
      if (roofItemsShown(b, st, lod)) for (const f of roofItemOutlines(id, r)) polyOut(path, f, s, ox, oy);
      // LANDMARK HOOK (silhouette): a landmark's extra pieces (towers, roofs on top) hide what is behind them too
      if (b.lm != null) LM.silhouette(api, path, r, cam, id);
      return path;
    }
    const o = geo.ROTS[r];
    if (id < B + T) {
      const t = id - B, tr = data.trees;
      const x = tr[5 * t], y = tr[5 * t + 1], rad = tr[5 * t + 2], h = tr[5 * t + 3], fl = tr[5 * t + 4];
      const X = x * o.R[0] + y * o.R[1], Yg = -(x * o.D[0] + y * o.D[1]) * S;
      const canAdd = typeof path.addPath === "function" && hasMatrix;
      if (fl & 1) {
        const yb = Yg - h * 0.17 * C, yt = Yg - h * C;
        if (lod < 0.7 || !canAdd) { quadOut(path, s, ox, oy, X - rad, yb, X, yt, X, yt, X + rad, yb); return path; }
        quadOut(path, s, ox, oy, X - 0.17, Yg - h * 0.2 * C, X + 0.17, Yg - h * 0.2 * C, X + 0.17, Yg, X - 0.17, Yg);
        const tpl = coneTemplate(Math.floor(nHash(t * 40503 + 11) * 4));
        path.addPath(tpl.sil, new DOMMatrix([s * rad, 0, 0, s * h * C, X * s - ox, Yg * s - oy]));
        return path;
      }
      const hh2 = nHash(t * 40503 + 11);
      if (treeBare(t, style)) {
        // a bare tree hides only its trunk (the twigs are a thin haze)
        const unit = h * C, a = rad / unit;
        let bucket = 0;
        for (let q = 1; q < BARE_A.length; q++) if (Math.abs(BARE_A[q] - a) < Math.abs(BARE_A[bucket] - a)) bucket = q;
        const tpl = bareTemplate(bucket, Math.floor(hh2 * 4));
        const sx = clamp(a / tpl.a, 0.8, 1.25) * (nHash(t * 2654435761 + 7) < 0.5 ? -1 : 1) * unit;
        const tw = tpl.tw, lean = tpl.lean, fork = tpl.fork;
        quadOut(path, s, ox, oy, X - tw[0] * sx, Yg, X + tw[0] * sx, Yg, X + (lean + tw[1]) * sx, Yg + fork * unit, X + (lean - tw[1]) * sx, Yg + fork * unit);
        return path;
      }
      const cy = Yg - Math.max(h - rad, h * 0.55) * C;
      if (lod < 0.7 || !canAdd) { path.moveTo((X + rad) * s - ox, cy * s - oy); path.arc(X * s - ox, cy * s - oy, rad * s, 0, TAU); if (lod < 0.7) return path; }
      const tw = Math.max(0.12, rad * 0.07);
      quadOut(path, s, ox, oy, X - tw, Yg, X + tw, Yg, X + tw * 0.6, cy, X - tw * 0.6, cy);
      if (canAdd) path.addPath(leafTemplate(Math.floor(hh2 * 6)).sil, new DOMMatrix([s * rad, 0, 0, s * rad, X * s - ox, cy * s - oy]));
      return path;
    }
    // a lamp post (none drawn below 1.2 px/m)
    if (lod < 1.2) return path;
    const l = id - B - T, x = data.lamps[2 * l], y = data.lamps[2 * l + 1];
    const X = x * o.R[0] + y * o.R[1], Y = -(x * o.D[0] + y * o.D[1]) * S;
    quadOut(path, s, ox, oy, X - 0.075, Y - 5.5 * C, X + 0.075, Y - 5.5 * C, X + 0.075, Y, X - 0.075, Y);
    if (lod >= 3) {
      quadOut(path, s, ox, oy, X - 0.13, Y - 0.5 * C, X + 0.13, Y - 0.5 * C, X + 0.13, Y, X - 0.13, Y);
      path.moveTo((X + 0.2) * s - ox, (Y - 5.72 * C) * s - oy); path.ellipse(X * s - ox, (Y - 5.72 * C) * s - oy, 0.2 * s, 0.26 * s, 0, 0, TAU); path.closePath();
      quadOut(path, s, ox, oy, X - 0.24, Y - 5.86 * C, X, Y - 6.15 * C, X, Y - 6.15 * C, X + 0.24, Y - 5.86 * C);
    } else quadOut(path, s, ox, oy, X - 0.25, Y - 5.9 * C, X + 0.25, Y - 5.9 * C, X + 0.25, Y - 5.9 * C + 0.32, X - 0.25, Y - 5.9 * C + 0.32);
    return path;
  }

  // ================================================================ night lights (a transparent layer, added on top)
  const SPECK = ["rgba(255,214,150,.85)", "rgba(255,226,170,.85)", "rgba(255,200,130,.85)"];
  const LIT = ["#cfe4ff", "#ffd889", "#ffc46b"], LIT_PARK = "rgba(255, 238, 200, .75)";
  // While set, drawWindows (mode 2) and speckle add their lit quads to these paths (three window colours, the parking
  // decks' glow, three speck colours) instead of filling them: one building's windows in a handful of fills.
  let litBatch = null;
  const litUsed = [false, false, false, false, false, false, false];
  const LIT_FILL = [...LIT, LIT_PARK, ...SPECK];
  function drawLights(ctx, r, cam, X0, Y0, X1, Y1, style) {
    const k = cam.k;
    const ids = scene.query(r, "objects", X0 - 12, Y0 - 12, X1 + 12, Y1 + 12);
    const Sr = scene.forRot(r);
    setScreen(ctx, cam);
    // pools of lamp light on the ground first: anything standing in front of them hides them
    const pool = softSprite("pool"), head = softSprite("head");
    for (const i of ids) {
      if (i < B + T) continue;
      const l = i - B - T;
      const [X, Y] = geo.proj(data.lamps[2 * l], data.lamps[2 * l + 1], 0, r);
      const rad = 9;
      if (pool) ctx.drawImage(pool, X - rad, Y - rad * S, rad * 2, rad * 2 * S);
    }
    // construction sites: a floodlight's pool between the gate and the site office, and the office's lit windows
    if (k >= 0.5) for (const i of scene.query(r, "areas", X0 - 12, Y0 - 12, X1 + 12, Y1 + 12)) {
      if (data.areas[i].k !== "cons") continue;
      const P = sitePlan(i, r), b = P.boxes[0];
      if (!b) continue;
      const [X, Y] = geo.proj((b.cx + P.gate[0]) / 2, (b.cy + P.gate[1]) / 2, 0, r), rad = 14;
      if (pool) { ctx.globalAlpha = 0.85; ctx.drawImage(pool, X - rad, Y - rad * S, rad * 2, rad * 2 * S); ctx.globalAlpha = 1; }
      if (k >= 1.2) cabinWindows(ctx, r, rectQuad(b.cx, b.cy, Math.atan2(P.uy, P.ux), b.S.L / 2, b.S.W / 2), "#ffd28a");
    }
    const blot = (f) => { ctx.moveTo(f[0], f[1]); for (let q = 2; q < f.length; q += 2) ctx.lineTo(f[q], f[q + 1]); };   // (fills only: open, see quadF)
    // Under 0.5 px/m no window is lit: past the pools above, every object only rubs light out, and rubbing out commutes.
    // So the blots are gathered into three paths (buildings; bare crowns' haze; crowns and trunks) and rubbed out
    // together, before anything adds light again (a landmark's own lights) and at the end: the same picture for a
    // fraction of the fills. (Where two crowns overlap they now dim the light behind them once, not twice.)
    const far = k < 0.5 && typeof Path2D !== "undefined";
    let farB = null, farH = null, farT = null;
    const farFlush = () => {
      if (!farB && !farH && !farT) return;
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "#000";
      setScreen(ctx, cam);
      if (farB) ctx.fill(farB, "nonzero");
      if (farH) { ctx.globalAlpha = 0.35; ctx.fill(farH); }
      if (farT) { ctx.globalAlpha = 0.8; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fill(farT); setScreen(ctx, cam); }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      farB = farH = farT = null;
    };
    // then every object back to front: it blots out the light behind it, then adds its own
    for (const i of ids) {
      if (DBG.on) { DBG.id = i < B ? i : -1; DBG.part = 3; }
      if (i < B) {
        const b = data.buildings[i];
        if (b.hidden) continue;
        const st = styleOf(i);
        const ol = outlineOf(i, r);
        if (!ol) continue;
        if (far) {
          // its walls and roof, courtyards open (the holes wind the other way, so they cancel only their own roof)
          if (!farB) farB = new Path2D();
          for (const f of ol.walls) polyAdd(farB, f);
          for (const f of ol.roof) polyAdd(farB, f);
          if (ol.holes.length) for (const f of holesReversed(ol)) polyAdd(farB, f);
          if (b.lm != null) {
            // (its own lights, as at the landmark hook for lights below)
            farFlush();
            LM.lights(api, ctx, r, cam, i, style);
            ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
            setScreen(ctx, cam);
          }
          continue;
        }
        const rings = Sr.objRings[i];
        const walls = visibleWalls(i, r);
        const base = b.mh || 0, he2 = wallTop(b);
        const special = st.kind === "bowl" || st.kind === "bleachers";
        // windows: each one (as the day tiles lay them out) from 1 px/m, a sparse speckle from 0.5 px/m
        const lit = !special && he2 - base >= 1.6 ? (k >= 1 ? 2 : k >= 0.5 ? 3 : 0) : 0;
        ctx.fillStyle = "#000";
        let frontWall = null;
        if (!lit) {
          ctx.globalCompositeOperation = "destination-out";
          ctx.beginPath(); for (const f of ol.walls) blot(f); ctx.fill("nonzero");
        } else {
          // walls far to near, exactly as the base tiles draw them: each rubs out the windows of the walls behind it
          // (notches, the far side of an L), then lights its own
          const front = st.kind === "house" && k >= 2 ? frontOf(i, r) : null;
          // walls that don't overlap one another (any convex footprint) need no order among themselves: rub them all
          // out at once, and gather all their windows into a few paths
          const batch = !walls.overlap && typeof Path2D !== "undefined";
          if (batch) {
            ctx.globalCompositeOperation = "destination-out";
            ctx.beginPath(); for (const f of ol.walls) blot(f); ctx.fill("nonzero");
            ctx.globalCompositeOperation = "source-over";
            litBatch = [];
            for (let q = 0; q < 7; q++) { litBatch.push(new Path2D()); litUsed[q] = false; }
          }
          for (let w = 0; w < walls.length; w++) {
            const wv = walls[w], f = rings[wv.ri];
            if (!batch) {
              ctx.globalCompositeOperation = "destination-out";
              ctx.fillStyle = "#000";
              ctx.beginPath(); blot(ol.walls[w]); ctx.fill();
              ctx.globalCompositeOperation = "source-over";
            }
            // the front door goes where the day tiles put it (they weigh every wall, edge-on ones too)
            const isFront = front && wv.ri === 0 && wv.nx * front[0] + wv.ny * front[1] > 0.8 && (!frontWall || wv.L > frontWall.L);
            if (isFront) frontWall = wv;
            // a wall seen nearly edge-on is a sliver: its lit windows would be bright dashes where the day's dark ones
            // don't show at all
            if (wv.nd > -0.12) continue;
            if (lit === 3) { speckle(ctx, b, st, wv, f[2 * wv.c], f[2 * wv.c + 1], f[2 * wv.a], f[2 * wv.a + 1], k); continue; }
            drawWindows(ctx, b, st, wv, f[2 * wv.c], f[2 * wv.c + 1], f[2 * wv.a], f[2 * wv.a + 1], 2, k, isFront ? 1 : 0);
          }
          if (batch) {
            for (let q = 0; q < 7; q++) if (litUsed[q]) { ctx.fillStyle = LIT_FILL[q]; ctx.fill(litBatch[q]); }
            litBatch = null;
          }
        }
        // Then whatever the day tiles paint over the walls hides the lights behind it, this building's own included: a
        // house's porch, and the roof with everything that stands on it (plant rooms, air handlers, the cars on a
        // parking deck, a chimney). They are painted exactly as by day, but rubbing out; courtyards stay open.
        ctx.globalCompositeOperation = "destination-out";
        if (special) {
          ctx.beginPath(); for (const f of ol.roof) blot(f); for (const f of ol.holes) blot(f);
          ctx.fill(ol.holes.length ? "evenodd" : "nonzero");
        } else {
          erasing = true;
          if (frontWall && k >= 2 && frontWall.L > 4.5 && he2 - base > 2.6) drawPorch(ctx, r, cam, i, b, st, frontWall, he2, k);
          const outline = k >= 0.8, lineW = Math.min(0.12, 0.9 / k), snow = style.snow || 0;
          if (b.roof && b.roof !== "flat" && b.obb) drawPitchedRoof(ctx, r, cam, i, b, st, snow, outline, lineW, k);
          else drawFlatRoof(ctx, r, cam, i, b, st, rings, he2 * C, k, snow, outline, lineW, base);
          erasing = false;
          setScreen(ctx, cam);
          if (DBG.on) DBG.part = 3;
        }
        ctx.globalCompositeOperation = "source-over";
        if (st.kind === "bowl") { if (k >= 0.5) bowlLights(ctx, r, i, b, st, k); continue; }
        // LANDMARK HOOK (lights): a landmark's own pieces hide what is behind them and show their own lights
        if (b.lm != null) { LM.lights(api, ctx, r, cam, i, style); ctx.globalCompositeOperation = "source-over"; }
        if (!lit) continue;
        if (frontWall && head && frontWall.L > 4.5 && nHash(strHashInt(b.id) + 41) < 0.7) {
          // a porch light by the front door
          const f = rings[0];
          const t = 0.5 + 0.09 * (frontWall.L > 0 ? 3 / frontWall.L : 0);
          const x = f[2 * frontWall.c] + (f[2 * frontWall.a] - f[2 * frontWall.c]) * t, y = f[2 * frontWall.c + 1] + (f[2 * frontWall.a + 1] - f[2 * frontWall.c + 1]) * t - 2.4 * C;
          ctx.drawImage(head, x - 1.1, y - 1.1, 2.2, 2.2);
        }
      } else if (i < B + T) {
        // a tree dims the lights behind it: its crown (exactly the day's shape) mostly, a bare one's twigs a little
        const t = i - B;
        if (far) {
          if (treeBare(t, style)) {
            const tr = data.trees, x = tr[5 * t], y = tr[5 * t + 1], rad = tr[5 * t + 2], h = tr[5 * t + 3];
            const X = x * geo.ROTS[r].R[0] + y * geo.ROTS[r].R[1], Yc = -(x * geo.ROTS[r].D[0] + y * geo.ROTS[r].D[1]) * S - Math.max(h - rad, h * 0.55) * C;
            if (!farH) farH = new Path2D();
            farH.moveTo(X + rad, Yc); farH.arc(X, Yc, rad, 0, TAU);
          }
          silhouette(farT || (farT = new Path2D()), r, cam, i, style);
          continue;
        }
        ctx.globalCompositeOperation = "destination-out";
        if (treeBare(t, style)) {
          const tr = data.trees, x = tr[5 * t], y = tr[5 * t + 1], rad = tr[5 * t + 2], h = tr[5 * t + 3];
          const [X, Yg] = geo.proj(x, y, 0, r);
          ctx.globalAlpha = 0.35;
          ctx.beginPath(); ctx.arc(X, Yg - Math.max(h - rad, h * 0.55) * C, rad, 0, TAU); ctx.fill();
        }
        // (a bare tree's silhouette is its trunk; from afar a crown is a disc, which the context's own path can hold)
        const p = k >= 0.7 && typeof Path2D !== "undefined" ? new Path2D() : null;
        ctx.globalAlpha = 0.8;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (p) { silhouette(p, r, cam, i, style); ctx.fill(p); }
        else { ctx.beginPath(); silhouette(ctx, r, cam, i, style); ctx.fill(); }
        setScreen(ctx, cam);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      } else if (k >= 1) {
        const l = i - B - T;
        const [X, Y] = geo.proj(data.lamps[2 * l], data.lamps[2 * l + 1], 0, r);
        const hy = Y - 5.75 * C;
        if (head) ctx.drawImage(head, X - 1.6, hy - 1.6, 3.2, 3.2);
      }
    }
    farFlush();
  }
  // From mid-distance (0.5–1 px/m) a window is under a pixel: a sparse speckle of lit ones stands in, about one per 9 m
  // of wall (more on tall walls) at varied heights, ~45 % of them on. Deterministic per building and wall.
  function speckle(ctx, b, st, wv, x1, y1, x2, y2, k) {
    const base = b.mh || 0, he = wallTop(b), hgt = he - base;
    if (hgt < 2.5 || wv.L < 3 || st.facade === "small" || st.facade === "blank") return;
    const on = st.kind === "hospital" ? 0.62 : st.kind === "ind" ? 0.22 : st.facade === "parking" ? 0.6 : 0.45;
    const n = Math.max(1, Math.round((wv.L / (st.kind === "hospital" ? 7 : 9)) * clamp(hgt / 10, 1, 4)));
    const idBase = strHashInt(b.id) + wv.c * 131 + wv.ri * 7919;
    // about a device pixel and a half across and a little less tall, on a floor's row of windows; laid in the wall's
    // plane and kept inside the wall (a speck must not hang off a narrow wall's end, over whatever is beside it)
    const floors = Math.max(1, Math.round(hgt / st.fh)), fhh = hgt / floors;
    const dt = Math.min(1, 1.5 / k / Math.max(1e-6, Math.abs(x2 - x1))), dz = Math.min(fhh, 1.25 / k / C);
    for (let c = 0; c < SPECK.length; c++) {
      const g = litBatch ? litBatch[4 + c] : ctx;
      if (g === ctx) ctx.beginPath();
      let any = false;
      for (let s = 0; s < n; s++) {
        const hs = nHash(idBase + s * 31 + 5);
        if (hs >= on || Math.floor((hs / on) * 7) % SPECK.length !== c) continue;
        const t = clamp((s + 0.5 + (nHash(idBase + s * 17 + 3) - 0.5) * 0.6) / n - dt / 2, 0, 1 - dt);
        const fl = Math.min(floors - 1, Math.floor(nHash(idBase + s * 7 + 11) * floors));
        const zm = base + fl * fhh + fhh * (st.z0f + st.z1f) / 2;
        const z0 = clamp(zm - dz / 2, base, he - dz);
        quadF(g, x1, y1, x2, y2, t, t + dt, z0, z0 + dz);
        any = true;
      }
      if (!any) continue;
      if (g === ctx) { ctx.fillStyle = SPECK[c]; ctx.fill(); } else litUsed[4 + c] = true;
    }
  }
  // at night the stadium's arcade glows here and there, and the concourse lights ring the rim
  function bowlLights(ctx, r, i, b, st, k) {
    const g = bowlOf(i);
    if (!g) return;
    const list = bowlFor(g, r);
    const head = softSprite("head"), o = geo.ROTS[r];
    for (const it of list) {
      const p = it.p;
      // (not on bays seen almost edge-on: there a lit arch is a bright sliver, where the day's dark one hardly shows)
      if (p.kind === "facade" && nHash(p.j * 7 + 3) < 0.55 && p.nx * o.D[0] + p.ny * o.D[1] < -0.22) facadeArches(ctx, it.P, g, k, it.fill, nHash(p.j * 13 + 1) < 0.5 ? "#ffd889" : "#ffc46b");
      else if (p.kind === "rim" && head && p.j % 3 === 0) {
        const P2 = it.P;
        const x = (P2[4] + P2[6]) / 2, y = (P2[5] + P2[7]) / 2 - 1.2 * C;
        ctx.drawImage(head, x - 1.2, y - 1.2, 2.4, 2.4);
      }
    }
  }

  // ================================================================ paper
  let grain = null, mottle = null;
  function paper(ctx, cam) {
    if (!canMakeCanvas) return;
    if (!grain) {
      const g = new OffscreenCanvas(128, 128), gx = g.getContext("2d");
      const img = gx.createImageData(128, 128);
      for (let p = 0; p < 128 * 128; p++) {
        const v = 200 + Math.floor(nHash(p * 2654435761) * 55);
        img.data[4 * p] = v; img.data[4 * p + 1] = v; img.data[4 * p + 2] = v - 6; img.data[4 * p + 3] = 255;
      }
      gx.putImageData(img, 0, 0);
      grain = g;
      // a soft, blotchy wash, like the tooth of watercolour paper (value noise, wrapped so it tiles)
      const M = 64, m = new OffscreenCanvas(M, M), mx2 = m.getContext("2d");
      const mi = mx2.createImageData(M, M);
      const G2 = 8, lat = new Float32Array(G2 * G2);
      for (let q = 0; q < lat.length; q++) lat[q] = nHash(q * 7919 + 13);
      const at = (x, y) => lat[((y % G2) + G2) % G2 * G2 + ((x % G2) + G2) % G2];
      for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
        const fx = (x / M) * G2, fy = (y / M) * G2, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const v = (at(ix, iy) * (1 - sx) + at(ix + 1, iy) * sx) * (1 - sy) + (at(ix, iy + 1) * (1 - sx) + at(ix + 1, iy + 1) * sx) * sy;
        const c = 236 + Math.round(v * 19);
        const p = 4 * (y * M + x);
        mi.data[p] = c; mi.data[p + 1] = c - 2; mi.data[p + 2] = c - 7; mi.data[p + 3] = 255;
      }
      mx2.putImageData(mi, 0, 0);
      mottle = m;
    }
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = ctx.createPattern(grain, "repeat");
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    // the wash is 64 texels stretched 12×: anchor it to the map (not the tile) so neighbouring tiles agree
    const P = 64 * 12;
    const ox = ((cam.ox % P) + P) % P, oy = ((cam.oy % P) + P) % P;
    ctx.setTransform(12, 0, 0, 12, -ox, -oy);
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = ctx.createPattern(mottle, "repeat");
    ctx.fillRect(0, 0, (ctx.canvas.width + ox) / 12 + 1, (ctx.canvas.height + oy) / 12 + 1);
    ctx.restore();
  }

  // LANDMARK API: the toolkit landmarks.js draws with (add to it as needed; keep existing members stable)
  const api = { data, scene, geo, S, C, shade, mix, nHash, strHash, setScreen, setWorld, styleOf, prism, quad, rectQuad, projInto, visibleWalls, drawWindows, outlineOf, drawBuildingStd };
  // floodlit landmarks (Lincoln and Morrill Towers' piers): which buildings, and their paint in its own colours, for the
  // layer that lays it over the night tint (atmosphere.js "sky-uplights")
  const uplitIds = () => LM.uplitIds(api);
  const uplights = (ctx, r, cam, i) => LM.uplights(api, ctx, r, cam, i);
  const uplightBeams = (ctx, r, cam, i, alpha) => LM.uplightBeams(api, ctx, r, cam, i, alpha);
  return { renderTile, drawObjects, drawObject, styleOf, setWorld, setScreen, treeBare, silhouette, uplitIds, uplights, uplightBeams };
}
