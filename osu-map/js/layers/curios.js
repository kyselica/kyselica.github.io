// Curios: small, whimsical things left about campus, a new set every day.
//
// None of this is real. Each day (the campus's own calendar day) a hash of the date picks 15–25 curios and puts each in
// a believable spot: a frisbee on a low flat roof, a kite tangled in a tree's crown, sidewalk chalk on a path or a plaza,
// a forgotten umbrella on a lawn, a bicycle with a basket against a lamp post, a hammock between two trees, a picnic
// blanket, a lost mitten on a fence post, a paper airplane, a rubber duck on Mirror Lake, a balloon caught on a lamp
// post, a chess game left on a bench, a pumpkin on a porch step, a library book on a bench, a lost sock, a lamp post in
// a knitted hat, a snowman, a raked pile of leaves, a traffic cone on a lawn. Which kinds can turn up follows the season,
// the weather and the hour: hammocks and picnics on warm dry days, mittens and hats in the cold, more umbrellas after
// rain, chalk only while it's dry, snowmen while there is snow on the ground, pumpkins in October and November.
//
// The day has numbered slots. Each slot draws its kind (a weighted draw among the kinds that fit right now, from the
// slot's own hash) and its place (a point drawn round the Oval, then the nearest spot that suits the kind), so a change
// in the weather swaps a few of them and leaves the rest where they were, and everyone sees the same ones.
//
// Drawing ("curios", z 40: under the night tint): from the walkers' scale up, back to front. Close up, whatever stands in
// front of a curio (a building, a tree, a lamp post) is left showing by clipping its outline out of the drawing, as
// sports.js does; from afar a curio behind a building or a leafy crown is simply not drawn. A few move a little (a
// balloon bobs, a kite's tail flutters, rubber ducks drift, a hammock sways): the layer asks for frames only while one of
// those is on screen. Each answers a click with a short card and a sound.
//
// ?curios=all: every kind at once, whatever the date, season and weather (one of each near the view the page opened
// on, besides the day's own).
import { pointIn } from "../core/scene.js";
import { localTime, makeRecorder } from "./life.js";

// ------------------------------------------------------------------------------------------------ tables
const MIN_S = 2;          // drawn from this scale (CSS px per metre) up, as the walkers are
const CLIP_S = 6;         // cut round whatever stands in front from here; from afar, seen or not
const DETAIL_S = 9;       // the finer touches from here
const ANIM_S = 4;         // movement is worth frames from here
const ANIM_FPS = 12;
const OVAL = [39.9995, -83.0148];
const SPREAD = 480;       // metres: how far round the Oval the day's curios are scattered (one standard deviation)
const TZ = "America/New_York";
const SHADOW = "#26323c";
const TAU = Math.PI * 2;
// areas: lawns curios may lie on; anything not "open" (a plaza, water, a flower bed, a car park…) is in the way
const OPEN = new Set(["grass", "park", "meadow", "campus", "res", "com", "rel", "ind", "cem", "farm"]);
const LAWN = new Set(["grass", "park", "meadow"]);
const HOUSES = new Set(["house", "detached", "semidetached_house", "terrace", "residential", "apartments"]);
const NOT_ROOF = new Set(["garage", "garages", "roof", "roof;yes", "carport", "parking", "shed", "storage_tank", "construction", "greenhouse", "grandstand", "stadium", "bridge", "service"]);
const FOOT = new Set(["footway", "pedestrian", "path"]);
// a typical afternoon by season (°F), when the live reading doesn't apply (another date with ?time=)
const CLIMATE = { winter: 36, spring: 62, summer: 82, autumn: 64, "late-autumn": 48 };

// paint
const BRIGHT = ["#e2525c", "#f2c84b", "#5c9bd6", "#7cc47f", "#ec8a3a", "#8f6fc0", "#ef8fae", "#3fa7a0"];
const FRISBEE = ["#f2c84b", "#e8743b", "#5c9bd6", "#e2525c", "#7cc47f", "#f4f1ea", "#ef8fae"];
const KITES = [["#c8372d", "#f3ead2"], ["#5f9fd1", "#f2c84b"], ["#5f9f63", "#ec8a3a"], ["#7d5ea8", "#ef9fb2"], ["#e2525c", "#3f7f86"]];
const CHALK = ["#ee7c9e", "#f2c12e", "#55a3df", "#72c060", "#a487d9", "#f2924a"];
const UMBRELLAS = [["#2b2b30", "#3a3a40"], ["#2f3e5c", "#f3eee2"], ["#b3202a", "#f3eee2"], ["#f2c84b", "#f2c84b"], ["#3f7f86", "#5aa2a8"], ["#7d5ea8", "#f3eee2"]];
const BIKES = ["#8fc9b8", "#f0e6cf", "#c8372d", "#2f3e5c", "#8fb3d3", "#e3a3b2", "#4f7a55"];
const HAMMOCK = [["#d9643a", "#f2e3c0", "#3d6d8f"], ["#3f7f86", "#f4efe2", "#e3b23c"], ["#b3202a", "#efe6d2", "#6d6e71"]];
const MITTENS = [["#c8372d", "#f4f1ea"], ["#4f7a55", "#f4f1ea"], ["#3d5f8a", "#e3c45a"], ["#7d5ea8", "#f2d4dc"], ["#d9822b", "#5a3b28"]];
const HATS = [["#b3202a", "#a3a6ab"], ["#4f7a55", "#f2ead8"], ["#e3b23c", "#2f3e5c"], ["#8fb3d3", "#f4f1ea"], ["#7b2d3a", "#e9dcc6"]];
const SOCKS = [["#c8372d", "#f4f1ea"], ["#3fa7a0", "#f2c84b"], ["#7d5ea8", "#ec8a3a"], ["#a3a6ab", "#ef8fae"], ["#2f3e5c", "#e3c45a"]];
const BOOKS = ["#2f6f73", "#7b2d3a", "#2f3e5c", "#5f6b4a", "#a8642f"];
const LEAVES = ["#d9822b", "#c4512b", "#e3b23c", "#9c4a2a", "#b8772e", "#a33a26"];
const SKINS = ["#f1c9a5", "#e0ac84", "#c68b62", "#8d5a3b", "#5e3a25"];
const HAIRS = ["#2b221c", "#5a3c26", "#a47a4a", "#d8b26a", "#1d1a18"];
const RAINBOW = ["#f4a7b9", "#f6b37e", "#f6dd7c", "#a8d89a", "#93c6ea"];
const POSIES = ["#ef8fae", "#f2c84b", "#f4f1ea", "#e2525c"];
const HOP_ROWS = [[1], [2], [3], [4, 5], [6], [7, 8]];
const SIDES = [-1, 1], WHEELS = [-0.52, 0.53], LEGS_U = [-0.68, 0.68], LEGS_V = [-0.17, 0.17], SLATS = [-0.07, 0.07];
const BACK_SLATS = [[0.56, 0.66], [0.72, 0.84]];
const SNOWBALLS = [[0.32, 0.38], [0.86, 0.28], [1.3, 0.2]];
const PUMPKINS_TWO = [[0.1, -0.2, 0.25], [0.12, 0.25, 0.16]], PUMPKIN_ONE = [[0.1, 0, 0.26]];

// the kinds: what spot each takes, how likely it is now (0: not now), at most how many a day, the sound of a click,
// whether it moves
const KINDS = {
  frisbee: { max: 2, sound: "pop", w: () => 1 },
  kite: { max: 2, sound: "rustle", w: (C) => (C.storm ? 0 : C.wind >= 10 ? 1.1 : 0.7) },
  chalk: { max: 4, sound: "pop", w: (C) => (C.wet || C.rained || C.ground > 0.15 || C.temp < 34 ? 0 : 1.3) },
  umbrella: { max: 4, sound: "pop", w: (C) => (C.wet || C.rained ? 2.4 : 0.35) },
  bike: { max: 3, sound: "pop", w: (C) => (C.ground > 0.5 ? 0.25 : 1) },
  hammock: { max: 2, sound: "rustle", w: (C) => (C.temp >= 62 && !C.wet && C.night < 0.5 && C.hour >= 10 && C.hour < 19.5 && C.season !== "winter" ? 1.4 : 0) },
  picnic: { max: 2, sound: "chirp", w: (C) => (C.temp >= 60 && !C.rained && C.ground < 0.05 && C.night < 0.5 && C.hour >= 10.5 && C.hour < 19 ? 1.2 : 0) },
  mitten: { max: 3, sound: "pop", w: (C) => (C.temp <= 45 || C.season === "winter" ? 1.3 : 0) },
  plane: { max: 2, sound: "pop", w: (C) => (C.wet || C.ground > 0.3 ? 0 : 0.8) },
  duck: { max: 1, sound: "quack", w: () => 0.9 },
  balloon: { max: 2, sound: "pop", w: (C) => (C.storm ? 0 : 0.9) },
  chess: { max: 1, sound: "pop", w: (C) => (C.wet || C.ground > 0.3 ? 0 : 0.6) },
  pumpkin: { max: 3, sound: "pop", w: (C) => (C.month === 10 ? 1.6 : C.month === 11 ? 0.9 : 0) },
  book: { max: 1, sound: "rustle", w: (C) => (C.wet ? 0 : 0.6) },
  sock: { max: 1, sound: "pop", w: (C) => (C.ground > 0.3 ? 0 : 0.55) },
  beanie: { max: 2, sound: "pop", w: (C) => (C.temp <= 45 || C.season === "winter" ? 0.8 : 0) },
  snowman: { max: 3, sound: "crunch", w: (C) => (C.ground >= 0.3 ? 2.6 : 0) },
  leaves: { max: 3, sound: "crunch", w: (C) => ((C.season === "autumn" || C.season === "late-autumn") && C.ground < 0.3 ? 1.3 : 0) },
  cone: { max: 1, sound: "pop", w: () => 0.45 },
};
const KIND_LIST = Object.keys(KINDS);

// ------------------------------------------------------------------------------------------------ the module
export function init(app) {
  const { data, geo, view, renderer } = app;
  if (!data || !data.areas || !data.world || !data.trees) return;
  const { SIN_T, COS_T } = geo;
  const IC = 1 / COS_T;
  const world = data.world;
  const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");
  const ALL = (app.params.get("curios") || "").trim().toLowerCase() === "all";
  const [ovalX, ovalY] = geo.toXY(OVAL[0], OVAL[1]);
  const tr = data.trees, la = data.lamps || [];
  const NT = tr.length / 5, NL = la.length / 2;
  const B = data.buildings.length;
  const W_ = () => app.weather || {};

  // ---------------------------------------------------------------- per-frame camera (CSS px from ground metres)
  // px = PA·x + PB·y + PE,  py = PC·x + PD·y + PF − PK·z  (as life.js and sports.js)
  let PA = 0, PB = 0, PC = 0, PD = 0, PE = 0, PF = 0, PK = 0, VW = 1, VH = 1, S = 1, ROT = 0, D0 = 0, D1 = 0, DPR = 1;
  const CAM = { k: 1, lod: 1, ox: 0, oy: 0 };
  function setCamera() {
    const o = geo.ROTS[view.rot], s = view.s;
    ROT = view.rot; S = s; VW = view.w; VH = view.h; DPR = view.dpr;
    D0 = o.D[0]; D1 = o.D[1];
    PA = s * o.R[0]; PB = s * o.R[1]; PC = -s * SIN_T * D0; PD = -s * SIN_T * D1;
    PE = VW / 2 - view.X * s; PF = VH / 2 - view.Y * s; PK = s * COS_T;
    CAM.k = s; CAM.ox = -PE; CAM.oy = -PF;
    CAM.lod = app.tiles && app.tiles.levelFor ? Math.pow(2, app.tiles.levelFor(view)) : s * view.dpr;
  }
  const Q = [0, 0];
  function P(x, y, z) { Q[0] = PA * x + PB * y + PE; Q[1] = PC * x + PD * y + PF - PK * z; return Q; }
  // drawing frames (ctx transforms; units are metres):
  //   hframe: the horizontal plane at height z, canvas x along ground direction (ca, sa), canvas y a quarter turn clockwise
  //           of it (so a drawing reads the right way round from above)
  //   vframe: the upright plane along (ca, sa), canvas y = −height; lean tips it toward ground direction (la, lb)
  //   bframe: upright and facing the camera at a screen point, x in metres across, y in metres of height (down +)
  //   sframe: facing the camera, the same scale both ways, turned by rot
  function hframe(ctx, x, y, z, ca, sa) {
    ctx.setTransform(DPR * (PA * ca + PB * sa), DPR * (PC * ca + PD * sa), DPR * (PA * sa - PB * ca), DPR * (PC * sa - PD * ca),
      DPR * (PA * x + PB * y + PE), DPR * (PC * x + PD * y + PF - PK * z));
  }
  function vframe(ctx, x, y, z, ca, sa, lean = 0, la0 = 0, lb0 = 0) {
    const lx = (PA * la0 + PB * lb0) * lean, ly = (PC * la0 + PD * lb0) * lean;
    ctx.setTransform(DPR * (PA * ca + PB * sa), DPR * (PC * ca + PD * sa), -DPR * lx, DPR * (PK - ly),
      DPR * (PA * x + PB * y + PE), DPR * (PC * x + PD * y + PF - PK * z));
  }
  function bframe(ctx, px, py) { ctx.setTransform(DPR * S, 0, 0, DPR * PK, DPR * px, DPR * py); }
  function sframe(ctx, px, py, rot) {
    const c = Math.cos(rot) * S * DPR, s = Math.sin(rot) * S * DPR;
    ctx.setTransform(c, s, -s, c, DPR * px, DPR * py);
  }
  const base = (ctx) => ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  // a line width in metres that is never thinner than px CSS pixels
  const lw = (m, px) => Math.max(m, px / S);

  // ---------------------------------------------------------------- spatial grids (ground metres), built on first use
  const GC = 32, GX = Math.ceil((world.x1 - world.x0) / GC) + 1, GY = Math.ceil((world.y1 - world.y0) / GC) + 1;
  const cellIJ = (x, y) => [Math.floor((x - world.x0) / GC), Math.floor((y - world.y0) / GC)];
  const cellOf = (x, y) => {
    const i = Math.floor((x - world.x0) / GC), j = Math.floor((y - world.y0) / GC);
    return i < 0 || j < 0 || i >= GX || j >= GY ? -1 : j * GX + i;
  };
  function gridAdd(grid, id, x0, y0, x1, y1) {
    const i0 = Math.max(0, Math.floor((x0 - world.x0) / GC)), i1 = Math.min(GX - 1, Math.floor((x1 - world.x0) / GC));
    const j0 = Math.max(0, Math.floor((y0 - world.y0) / GC)), j1 = Math.min(GY - 1, Math.floor((y1 - world.y0) / GC));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) (grid[j * GX + i] ||= []).push(id);
  }
  const ringBox = (f) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < f.length; k += 2) { if (f[k] < x0) x0 = f[k]; if (f[k] > x1) x1 = f[k]; if (f[k + 1] < y0) y0 = f[k + 1]; if (f[k + 1] > y1) y1 = f[k + 1]; }
    return [x0, y0, x1, y1];
  };
  const inRings = (rings, x, y) => { let n = false; for (const f of rings) if (pointIn(f, x, y)) n = !n; return n; };
  let G = null;
  // segments: [ax, ay, bx, by, half width, type (0 path, 1 road, 2 barrier), feature index] × n
  function grids() {
    if (G) return G;
    const segs = [], sGrid = new Array(GX * GY);
    const addLine = (pts, hw, type, idx) => {
      for (let k = 0; k + 3 < pts.length; k += 2) {
        const id = segs.length / 7, ax = pts[k], ay = pts[k + 1], bx = pts[k + 2], by = pts[k + 3], r = hw + 3;
        segs.push(ax, ay, bx, by, hw, type, idx);
        gridAdd(sGrid, id, Math.min(ax, bx) - r, Math.min(ay, by) - r, Math.max(ax, bx) + r, Math.max(ay, by) + r);
      }
    };
    data.paths.forEach((p, i) => { if (!p.tn) addLine(p.pts, (p.w || 2) / 2, 0, i); });
    data.roads.forEach((r, i) => { if (!r.tn) addLine(r.pts, (r.w || 6) / 2, 1, i); });
    (data.barriers || []).forEach((b, i) => addLine(b.pts, b.k === "hedge" ? 0.75 : 0.3, 2, i));
    const tGrid = new Array(GX * GY);
    for (let t = 0; t < NT; t++) { const x = tr[5 * t], y = tr[5 * t + 1], r = tr[5 * t + 2] + 2; gridAdd(tGrid, t, x - r, y - r, x + r, y + r); }
    const lGrid = new Array(GX * GY);
    for (let l = 0; l < NL; l++) gridAdd(lGrid, l, la[2 * l] - 2, la[2 * l + 1] - 2, la[2 * l] + 2, la[2 * l + 1] + 2);
    const bGrid = new Array(GX * GY), bBox = new Float32Array(B * 4), bC = new Float32Array(B * 2);
    data.buildings.forEach((b, i) => {
      const bb = ringBox(b.p[0]);
      bBox.set(bb, 4 * i);
      bC[2 * i] = (bb[0] + bb[2]) / 2; bC[2 * i + 1] = (bb[1] + bb[3]) / 2;
      gridAdd(bGrid, i, bb[0] - 2, bb[1] - 2, bb[2] + 2, bb[3] + 2);
    });
    const aGrid = new Array(GX * GY), aBox = new Float32Array(data.areas.length * 4);
    data.areas.forEach((a, i) => {
      const bb = ringBox(a.p[0]);
      aBox.set(bb, 4 * i);
      gridAdd(aGrid, i, bb[0], bb[1], bb[2], bb[3]);
    });
    G = { segs: Float32Array.from(segs), sGrid, tGrid, lGrid, bGrid, bBox, bC, aGrid, aBox };
    return G;
  }
  // distance from (x, y) to the edge of the nearest path (type 0), road (1) or barrier (2) in its cell
  function edgeDist(x, y, type, skip = -1) {
    const c = cellOf(x, y);
    if (c < 0) return 0;
    const L = G.sGrid[c], S7 = G.segs;
    let best = Infinity;
    if (L) for (const id of L) {
      const o = id * 7;
      if (S7[o + 5] !== type || (skip >= 0 && S7[o + 6] === skip)) continue;
      const d = segDist(x, y, S7[o], S7[o + 1], S7[o + 2], S7[o + 3]) - S7[o + 4];
      if (d < best) best = d;
    }
    return best;
  }
  function inBuilding(x, y, skip = -1) {
    const c = cellOf(x, y), L = c < 0 ? null : G.bGrid[c], bb = G.bBox;
    if (L) for (const i of L) {
      if (i === skip || x < bb[4 * i] || x > bb[4 * i + 2] || y < bb[4 * i + 1] || y > bb[4 * i + 3]) continue;
      if (app.scene.contains(i, x, y)) return i;
    }
    return -1;
  }
  // 0: nothing in particular, 1: on a lawn, 2: on something in the way (a plaza, water, a flower bed, a car park…)
  function groundAt(x, y) {
    const c = cellOf(x, y), L = c < 0 ? null : G.aGrid[c], bb = G.aBox;
    let lawn = false;
    if (L) for (const i of L) {
      if (x < bb[4 * i] || x > bb[4 * i + 2] || y < bb[4 * i + 1] || y > bb[4 * i + 3]) continue;
      const a = data.areas[i];
      if (!inRings(a.p, x, y)) continue;
      if (!OPEN.has(a.k)) return 2;
      if (LAWN.has(a.k)) lawn = true;
    }
    return lawn ? 1 : 0;
  }
  // a tree's crown (or trunk, with trunkOnly) within r of (x, y)?
  function nearTree(x, y, r, trunkOnly, skipA = -1, skipB = -1) {
    const c = cellOf(x, y), L = c < 0 ? null : G.tGrid[c];
    if (L) for (const t of L) {
      if (t === skipA || t === skipB) continue;
      const reach = trunkOnly ? 0.5 : tr[5 * t + 2] * 0.85;
      if (Math.hypot(x - tr[5 * t], y - tr[5 * t + 1]) < reach + r) return true;
    }
    return false;
  }
  function nearLamp(x, y, r) {
    const c = cellOf(x, y), L = c < 0 ? null : G.lGrid[c];
    if (L) for (const l of L) if (Math.hypot(x - la[2 * l], y - la[2 * l + 1]) < r) return true;
    return false;
  }
  // a building (an outline or any of its parts, a landmark's ornament included) standing over (x, y) above height z?
  function tallerAt(x, y, z, skip) {
    const c = cellOf(x, y), L = c < 0 ? null : G.bGrid[c], bb = G.bBox;
    if (L) for (const i of L) {
      if (i === skip || x < bb[4 * i] || x > bb[4 * i + 2] || y < bb[4 * i + 1] || y > bb[4 * i + 3]) continue;
      const b = data.buildings[i];
      if (Math.max(b.h, b.top || 0) <= z || (b.mh || 0) >= z) continue;
      if (app.scene.contains(i, x, y)) return true;
    }
    return false;
  }
  // open lawn round (x, y): nothing within r of it
  function openLawn(x, y, r, opt = {}) {
    if (x < world.x0 + 5 || x > world.x1 - 5 || y < world.y0 + 5 || y > world.y1 - 5) return false;
    if (groundAt(x, y) !== 1) return false;
    for (let q = 0; q < 4; q++) { const a = q * 1.5708 + 0.4; if (groundAt(x + Math.cos(a) * r, y + Math.sin(a) * r) === 2) return false; }
    if (edgeDist(x, y, 0) < r + (opt.path ?? 0.8)) return false;
    if (edgeDist(x, y, 1) < r + 2) return false;
    if (edgeDist(x, y, 2) < r + 0.5) return false;
    if (opt.pathMax && !(edgeDist(x, y, 0) < opt.pathMax)) return false;
    if (nearTree(x, y, r, false, opt.skipA, opt.skipB) || nearLamp(x, y, r + 1)) return false;
    if (inBuilding(x, y) >= 0) return false;
    for (let q = 0; q < 4; q++) { const a = q * 1.5708; if (inBuilding(x + Math.cos(a) * (r + 1), y + Math.sin(a) * (r + 1)) >= 0) return false; }
    return true;
  }

  // Would a building or a leafy crown stand in front of (x, y, z) seen with view rotation r? Buildings: walking from the
  // point toward the camera, the line of sight climbs tan 30° a metre; a footprint it passes under that is taller hides
  // the point. Trees: a crown in front whose circle on the screen covers the point.
  const TAN_T = SIN_T / COS_T, TSTAMP = new Uint32Array(NT);
  let tstamp = 0;
  function hiddenFrom(x, y, z, r, skipB = -1, skipT = -1, skipT2 = -1, offU = 0) {
    const o = geo.ROTS[r], dx = o.D[0], dy = o.D[1];
    // (a point drawn offU screen metres to the side of the ground point: the same as one that far along the screen's x)
    x += o.R[0] * offU; y += o.R[1] * offU;
    for (let d = 0.8; d <= 80; d += 1.2) {
      const hz = z + d * TAN_T;
      if (hz > 90) break;
      if (tallerAt(x - dx * d, y - dy * d, hz, skipB)) return true;
    }
    const pv = x * dx + y * dy, pu = x * o.R[0] + y * o.R[1], st = ++tstamp;
    for (let d = 0; d <= 48; d += GC / 2) {
      const c = cellOf(x - dx * d, y - dy * d), L = c < 0 ? null : G.tGrid[c];
      if (L) for (const t of L) {
        if (TSTAMP[t] === st || t === skipT || t === skipT2) continue;
        TSTAMP[t] = st;
        const tx = tr[5 * t], ty = tr[5 * t + 1], tv = tx * dx + ty * dy;
        if (tv > pv - 0.3) continue;
        const rad = tr[5 * t + 2], h = tr[5 * t + 3], cz = tr[5 * t + 4] & 1 ? h * 0.5 : Math.max(h - rad, h * 0.55);
        const du = tx * o.R[0] + ty * o.R[1] - pu, dv = (pv - tv) * SIN_T - (cz - z) * COS_T;
        // the trunk (and a bare tree's thicker limbs) in front of it
        if (Math.abs(du) < 0.5 && (pv - tv) * SIN_T + z * COS_T < cz * COS_T) return true;
        if (renderer.treeBare(t, app.tileStyle)) continue;
        const rr = (tr[5 * t + 4] & 1 ? 0.55 : 0.85) * rad;
        if (du * du + dv * dv < rr * rr) return true;
      }
    }
    return false;
  }
  // in plain view from the usual turn of the view (north-west), and from at least two of the others
  function seen(x, y, z, skipB = -1, skipT = -1, skipT2 = -1, offU = 0) {
    if (hiddenFrom(x, y, z, 0, skipB, skipT, skipT2, offU)) return false;
    let n = 0;
    for (let r = 1; r < 4; r++) if (hiddenFrom(x, y, z, r, skipB, skipT, skipT2, offU) && ++n > 1) return false;
    return true;
  }

  // ---------------------------------------------------------------- candidate sites (lazily)
  let lawnAreas = null, kiteTrees = null, roofs = null, houses = null, lakes = null, plazas = null, posts = null;
  function lawnList() {
    if (lawnAreas) return lawnAreas;
    lawnAreas = [];
    data.areas.forEach((a, i) => { if (LAWN.has(a.k) && (a.A || 0) >= 150) { const bb = ringBox(a.p[0]); lawnAreas.push({ i, bb }); } });
    return lawnAreas;
  }
  function treeList() {
    if (kiteTrees) return kiteTrees;
    kiteTrees = [];
    for (let t = 0; t < NT; t++) {
      if (tr[5 * t + 4] & 1 || tr[5 * t + 3] < 6 || tr[5 * t + 2] < 2) continue;
      if (groundAt(tr[5 * t], tr[5 * t + 1]) !== 1) continue;
      kiteTrees.push(t);
    }
    return kiteTrees;
  }
  function roofList() {
    if (roofs) return roofs;
    roofs = [];
    data.buildings.forEach((b, i) => {
      if (b.hidden || b.part || b.lm != null || (b.mh || 0) > 0 || NOT_ROOF.has(b.k)) return;
      if (b.roof && b.roof !== "flat") return;
      if (b.h < 4 || b.h > 18 || b.p[0].length < 8) return;
      const bb = G.bBox, w = bb[4 * i + 2] - bb[4 * i], h = bb[4 * i + 3] - bb[4 * i + 1];
      if (w < 10 || h < 10 || w * h > 9000) return;
      roofs.push(i);
    });
    return roofs;
  }
  function houseList() {
    if (houses) return houses;
    houses = [];
    data.buildings.forEach((b, i) => {
      if (b.hidden || b.part || b.lm != null || !HOUSES.has(b.k)) return;
      const bb = G.bBox, w = bb[4 * i + 2] - bb[4 * i], h = bb[4 * i + 3] - bb[4 * i + 1];
      if (w * h > 600 || w < 5 || h < 5) return;
      houses.push(i);
    });
    return houses;
  }
  function lakeList() {
    if (lakes) return lakes;
    lakes = [];
    data.areas.forEach((a, i) => { if (a.k === "water" && (a.A || 0) >= 800 && (a.A || 0) < 60000) lakes.push({ i, bb: ringBox(a.p[0]), mirror: /mirror lake/i.test(a.n || "") }); });
    return lakes;
  }
  function plazaList() {
    if (plazas) return plazas;
    plazas = [];
    data.areas.forEach((a, i) => { if (a.k === "plaza" && (a.A || 0) >= 150) plazas.push({ i, bb: ringBox(a.p[0]) }); });
    return plazas;
  }
  // fence and wall corners (a mitten's perch): [x, y, height, barrier]
  function postList() {
    if (posts) return posts;
    posts = [];
    (data.barriers || []).forEach((b, i) => {
      if (b.k !== "fence" && b.k !== "wall") return;
      for (let k = 0; k < b.pts.length; k += 2) posts.push(b.pts[k], b.pts[k + 1], b.k === "fence" ? 1.2 : 0.8, i);
    });
    return posts;
  }
  const bboxDist = (bb, x, y) => Math.hypot(Math.max(0, bb[0] - x, x - bb[2]), Math.max(0, bb[1] - y, y - bb[3]));
  // the n nearest entries of list (by key(e) distance) to (x, y)
  function nearestOf(list, n, dist) {
    const best = [];
    for (const e of list) {
      const d = dist(e);
      if (best.length < n || d < best[best.length - 1][0]) {
        best.push([d, e]);
        best.sort((a, b) => a[0] - b[0]);
        if (best.length > n) best.pop();
      }
    }
    return best;
  }
  // footway segments near (x, y), nearest first: [segment id, distance]
  function footSegs(x, y, reach, minLen, minW) {
    const [ci, cj] = cellIJ(x, y), n = Math.ceil(reach / GC), out = [], seen = new Set(), S7 = G.segs;
    for (let j = cj - n; j <= cj + n; j++) for (let i = ci - n; i <= ci + n; i++) {
      if (i < 0 || j < 0 || i >= GX || j >= GY) continue;
      const L = G.sGrid[j * GX + i];
      if (L) for (const id of L) {
        if (seen.has(id)) continue;
        seen.add(id);
        const o = id * 7;
        if (S7[o + 5] !== 0) continue;
        const p = data.paths[S7[o + 6]];
        if (!FOOT.has(p.k) || p.br || p.ly || (p.w || 2) < minW || (p.w || 2) > 7) continue;
        if (Math.hypot(S7[o + 2] - S7[o], S7[o + 3] - S7[o + 1]) < minLen) continue;
        const d = segDist(x, y, S7[o], S7[o + 1], S7[o + 2], S7[o + 3]);
        if (d < reach) out.push([id, d]);
      }
    }
    return out.sort((a, b) => a[1] - b[1]);
  }

  // ---------------------------------------------------------------- conditions
  const C = { temp: 50, wet: false, rained: false, storm: false, ground: 0, season: "summer", month: 1, dom: 1, hour: 12, wind: 0, windDir: 0, night: 0, frozen: false, day: 0 };
  const DAY_FMT = (() => { try { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }); } catch { return null; } })();
  function readConditions() {
    const now = app.now(), W = W_(), st = app.tileStyle || {};
    let y = now.getFullYear(), m = now.getMonth() + 1, d = now.getDate();
    if (DAY_FMT) for (const p of DAY_FMT.formatToParts(now)) { if (p.type === "year") y = +p.value; else if (p.type === "month") m = +p.value; else if (p.type === "day") d = +p.value; }
    C.month = m; C.dom = d; C.day = Math.round(Date.UTC(y, m - 1, d) / 864e5);
    C.hour = localTime(now).h;
    C.season = st.season || "summer";
    // the reading (live or ?weather=) is for now: for another date (?time=), a typical temperature for the season
    const reading = W.source && W.source !== "none" && Number.isFinite(W.tempF) && Math.abs(now.getTime() - Date.now()) < 3 * 3600e3;
    C.temp = reading ? W.tempF : CLIMATE[C.season] ?? 60;
    C.storm = !!W.storm;
    C.wet = (W.rain || 0) > 0.05 || C.storm;
    C.rained = C.wet || (W.precipMm || 0) > 0.05;
    C.ground = Math.max(st.snow || 0, (W.snowDepthM || 0) / 0.05);
    C.wind = W.windMph || 0; C.windDir = W.windDir || 0;
    C.night = Number.isFinite(W.night) ? W.night : 0;
    C.frozen = (C.season === "winter" || C.ground > 0.5) && C.temp < 30;
  }
  const weights = new Float64Array(KIND_LIST.length);
  function signature() {
    let s = `${C.day}|${C.frozen ? 1 : 0}`;
    for (let k = 0; k < KIND_LIST.length; k++) { weights[k] = ALL ? 1 : KINDS[KIND_LIST[k]].w(C); s += "|" + weights[k].toFixed(2); }
    return s;
  }

  // ================================================================================================ the day's curios
  let curios = [], sig = "", allFocus = null;
  function mk(kind, x, y, z, seed, o) {
    const c = {
      kind, K: KINDS[kind], x, y, z, seed, ang: 0, ca: 1, sa: 0, host: -1, rw: 0.6, top: 0.6, zc: z + 0.3, ax: 0, ay: 0, odx: 0, ody: 0,
      anim: false, where: "", col: null, ph: hash01(seed, 7) * TAU, R: hash01(seed, 9),
      occR: -1, occ: null, hidR: -1, hid: false, d: 0, vis: false,
    };
    Object.assign(c, o);
    c.ca = Math.cos(c.ang); c.sa = Math.sin(c.ang);
    return c;
  }
  // the slot's kind: a weighted draw among the kinds that fit now (an exponential race, so that one kind's weight
  // changing leaves the other slots' draws alone)
  function pickKind(seed, counts) {
    let best = null, bk = Infinity;
    for (let k = 0; k < KIND_LIST.length; k++) {
      const name = KIND_LIST[k], w = weights[k];
      if (!(w > 0) || counts[name] >= KINDS[name].max) continue;
      const key = -Math.log(hash01(seed, 100 + k) || 1e-9) / w;
      if (key < bk) { bk = key; best = name; }
    }
    return best;
  }
  function focus(R) {
    const a = R() * TAU, r = SPREAD * Math.sqrt(-2 * Math.log(1 - R() * 0.995));
    return [clamp(ovalX + Math.cos(a) * r, world.x0 + 60, world.x1 - 60), clamp(ovalY + Math.sin(a) * r, world.y0 + 60, world.y1 - 60)];
  }
  function build() {
    grids();
    readConditions();
    sig = signature();
    const list = [], counts = {}, used = new Set();
    for (const k of KIND_LIST) counts[k] = 0;
    const n = 15 + (hashInt(C.day, 0x51) % 11);
    for (let i = 0; i < 120 && list.length < n; i++) {
      const seed = hashInt(C.day * 977 + i, 0xc0710);
      const kind = pickKind(seed, counts);
      if (!kind) break;
      const R = rng(hashInt(seed, 2));
      const [fx, fy] = focus(R);
      let c = null;
      try { c = place(kind, fx, fy, R, used, seed); } catch (e) { report(e); }
      if (!c || crowded(c, list, 10)) continue;
      list.push(c); counts[kind]++;
    }
    if (ALL) {
      // one of every kind round the view the page opened on (for tests and screenshots)
      if (!allFocus) { const g = view.screenToGround(view.w / 2, view.h / 2); allFocus = g && Number.isFinite(g[0]) ? [g[0], g[1]] : [ovalX, ovalY]; }
      KIND_LIST.forEach((kind, k) => {
        for (let q = 0; q < 4; q++) {
          const seed = hashInt(k + 1, 0xa11 + q), R = rng(seed), a = (k / KIND_LIST.length) * TAU + q, rr = 18 + q * 30;
          const fx = allFocus[0] + Math.cos(a) * rr, fy = allFocus[1] + Math.sin(a) * rr;
          let c = null;
          try { c = place(kind, fx, fy, R, used, seed); } catch (e) { report(e); }
          if (c && !crowded(c, list, 3)) { list.push(c); break; }
        }
      });
    }
    for (const c of list) c.where = c.where || whereOf(c.x, c.y);
    curios = list;
    app.requestRender("curios");
  }
  // a broken placement or rebuild is reported once, not on every rebuild
  let reported = false;
  function report(e) { if (!reported) { reported = true; console.error("curios:", e); } }
  function crowded(c, list, d) {
    for (const o of list) if ((c.host >= 0 && o.host === c.host) || Math.hypot(o.x - c.x, o.y - c.y) < d) return true;
    return false;
  }
  // rebuild when the day turns or what may turn up changes (checked now and then, and on new weather or style)
  function check() {
    try {
      readConditions();
      if (signature() !== sig) build();
    } catch (e) { report(e); }
  }

  // ---------------------------------------------------------------- placing
  function place(kind, fx, fy, R, used, seed) {
    switch (kind) {
      case "frisbee": return placeRoof(fx, fy, R, used, seed);
      case "kite": return placeKite(fx, fy, R, used, seed);
      case "chalk": return placeChalk(fx, fy, R, used, seed);
      case "hammock": return placeHammock(fx, fy, R, used, seed);
      case "bike": case "balloon": case "beanie": return placeLamp(kind, fx, fy, R, used, seed);
      case "mitten": return placePost(fx, fy, R, used, seed);
      case "duck": return placeDuck(fx, fy, R, used, seed);
      case "pumpkin": return placePorch(fx, fy, R, used, seed);
      case "chess": case "book": return placeBench(kind, fx, fy, R, used, seed);
      default: return placeLawn(kind, fx, fy, R, used, seed);
    }
  }
  // a point on open lawn near (fx, fy) with r metres clear round it
  function lawnSpot(fx, fy, R, r, opt) {
    const near = nearestOf(lawnList(), 6, (e) => bboxDist(e.bb, fx, fy));
    for (const [d, e] of near) {
      if (d > 300) break;
      const a = data.areas[e.i], bb = e.bb;
      const cx = clamp(fx, bb[0], bb[2]), cy = clamp(fy, bb[1], bb[3]);
      const span = Math.min(80, Math.max(bb[2] - bb[0], bb[3] - bb[1]));
      for (let q = 0; q < 50; q++) {
        const x = clamp(cx + (R() - 0.5) * span, bb[0], bb[2]), y = clamp(cy + (R() - 0.5) * span, bb[1], bb[3]);
        if (!inRings(a.p, x, y) || !openLawn(x, y, r, opt) || !seen(x, y, opt.zc ?? 0.3)) continue;
        return [x, y];
      }
    }
    return null;
  }
  const SIZES = {   // lawn curios: [clear radius, half width, height]
    umbrella: [0.9, 0.7, 0.9], picnic: [1.5, 1.1, 0.5], plane: [0.4, 0.3, 0.15], sock: [0.4, 0.25, 0.1],
    snowman: [0.8, 0.6, 1.75], leaves: [1.2, 1.3, 1.4], cone: [0.5, 0.3, 0.75],
  };
  function placeLawn(kind, fx, fy, R, used, seed) {
    const [r, rw, top] = SIZES[kind];
    const opt = kind === "umbrella" ? { pathMax: 7 } : kind === "leaves" ? { path: 1.2 } : {};
    opt.zc = top * 0.5;
    const p = lawnSpot(fx, fy, R, r, opt);
    if (!p) return null;
    const o = { ang: R() * TAU, rw, top, zc: top * 0.45 };
    if (kind === "umbrella") { const u = UMBRELLAS[(R() * UMBRELLAS.length) | 0]; Object.assign(o, { col: u[0], col2: u[1], rot: (R() < 0.5 ? -1 : 1) * (0.35 + R() * 0.35), dots: R() < 0.2 }); }
    else if (kind === "picnic") Object.assign(o, { col: "#b3202a", apple: R() < 0.7, plates: 1 + ((R() * 2) | 0) });
    else if (kind === "plane") Object.assign(o, { col: "#f7f5ef", lined: R() < 0.5 });
    else if (kind === "sock") { const s = SOCKS[(R() * SOCKS.length) | 0]; Object.assign(o, { col: s[0], col2: s[1] }); }
    else if (kind === "snowman") Object.assign(o, { hat: R() < 0.45, scarf: BRIGHT[(R() * BRIGHT.length) | 0], nose: R() < 0.5 ? -1 : 1, col: "#f7f8fa" });
    else if (kind === "leaves") {
      const n = 46, L = new Float32Array(n * 3), RR = rng(seed ^ 0x1eaf);
      for (let k = 0; k < n; k++) {
        // scattered over the mound (x across, y up from the ground; a few lie round its foot)
        const out = k >= n - 8;
        const u = (RR() * 2 - 1) * (out ? 1.15 : 0.62), hmax = out ? 0 : 0.5 * Math.sqrt(Math.max(0, 1 - (u / 0.66) ** 2));
        L[3 * k] = u; L[3 * k + 1] = out ? (RR() - 0.5) * 0.08 : -RR() * hmax; L[3 * k + 2] = RR();
      }
      Object.assign(o, { leaves: L, rake: R() < 0.75 ? (R() < 0.5 ? -1 : 1) : 0, col: "#d9822b" });
    } else if (kind === "cone") Object.assign(o, { col: "#ea7a33", tipped: R() < 0.25 });
    return mk(kind, p[0], p[1], 0, seed, o);
  }
  // a frisbee (and whatever else got up there) near the edge of a low flat roof
  function placeRoof(fx, fy, R, used, seed) {
    const near = nearestOf(roofList(), 6, (i) => Math.hypot(G.bC[2 * i] - fx, G.bC[2 * i + 1] - fy));
    for (const [d, i] of near) {
      if (d > 400) break;
      if (used.has("b" + i)) continue;
      const b = data.buildings[i], f = b.p[0], n = f.length / 2;
      for (let q = 0; q < 8; q++) {
        const e = (R() * n) | 0, e2 = (e + 1) % n;
        const ax = f[2 * e], ay = f[2 * e + 1], bx = f[2 * e2], by = f[2 * e2 + 1], L = Math.hypot(bx - ax, by - ay);
        if (L < 4) continue;
        const t = 0.2 + R() * 0.6, nx = -(by - ay) / L, ny = (bx - ax) / L;
        for (const s of [1, -1]) {
          const x = ax + (bx - ax) * t + nx * s * 1.0, y = ay + (by - ay) * t + ny * s * 1.0;
          if (!app.scene.contains(i, x, y) || !app.scene.contains(i, x + nx * s * 0.6, y + ny * s * 0.6)) continue;
          // nothing taller standing on the spot (a tower, another part)
          if (inBuilding(x, y, i) >= 0 || !seen(x, y, b.h + 0.1, i)) continue;
          used.add("b" + i);
          const items = [{ u: 0, v: 0, t: 0, col: FRISBEE[(R() * FRISBEE.length) | 0] }];
          const extra = R() < 0.55 ? 1 + ((R() * 2) | 0) : 0;
          for (let k = 0; k < extra; k++) {
            const a = R() * TAU, rr = 0.35 + R() * 0.3;
            items.push({ u: Math.cos(a) * rr, v: Math.sin(a) * rr, t: 1 + ((R() * 3) | 0), col: FRISBEE[(R() * FRISBEE.length) | 0] });
          }
          return mk("frisbee", x, y, b.h, seed, { host: i, items, rw: 0.8, top: 0.2, zc: b.h + 0.05, col: items[0].col, bname: b.n || "" });
        }
      }
    }
    return null;
  }
  function placeKite(fx, fy, R, used, seed) {
    const near = nearestOf(treeList(), 6, (t) => Math.hypot(tr[5 * t] - fx, tr[5 * t + 1] - fy));
    for (const [d, t] of near) {
      if (d > 300 || used.has("t" + t)) continue;
      if (tr[5 * t + 3] < 8 || tr[5 * t + 2] < 2.6) continue;
      const x = tr[5 * t], y = tr[5 * t + 1], rad = tr[5 * t + 2], h = tr[5 * t + 3];
      const cz = Math.max(h - rad, h * 0.55), side = R() < 0.5 ? -1 : 1;
      // on the crown's upper flank (in screen metres from the crown's middle: the crown is drawn as a circle there)
      const odx = side * rad * (0.35 + R() * 0.25), ody = -rad * (0.15 + R() * 0.3);
      if (!seen(x, y, cz - ody / COS_T, -1, t, -1, odx)) continue;
      used.add("t" + t);
      const k = KITES[(R() * KITES.length) | 0];
      return mk("kite", x, y, 0, seed, {
        host: B + t, tree: t, side, col: k[0], col2: k[1], tilt: side * (0.25 + R() * 0.3),
        odx, ody, rw: rad + 1.5, top: h + 1, zc: cz, anim: true,
      });
    }
    return null;
  }
  function placeHammock(fx, fy, R, used, seed) {
    const near = nearestOf(treeList(), 30, (t) => Math.hypot(tr[5 * t] - fx, tr[5 * t + 1] - fy));
    for (const [d, a] of near) {
      if (d > 350 || used.has("t" + a)) continue;
      const ax = tr[5 * a], ay = tr[5 * a + 1], c = cellOf(ax, ay), L = c < 0 ? null : G.tGrid[c];
      if (!L) continue;
      for (const b of L) {
        if (b === a || used.has("t" + b) || tr[5 * b + 4] & 1) continue;
        const bx = tr[5 * b], by = tr[5 * b + 1], D = Math.hypot(bx - ax, by - ay);
        if (D < 3.6 || D > 5.6) continue;
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        if (!openLawn(mx, my, 0.5, { skipA: a, skipB: b, path: 0.6 })) continue;
        // nothing else between the trunks
        let clear = true;
        for (const t of L) if (t !== a && t !== b && segDist(tr[5 * t], tr[5 * t + 1], ax, ay, bx, by) < 1) { clear = false; break; }
        if (!clear || !seen(mx, my, 0.8, -1, a, b)) continue;
        used.add("t" + a); used.add("t" + b);
        const pal = HAMMOCK[(R() * HAMMOCK.length) | 0];
        return mk("hammock", mx, my, 0, seed, {
          ang: Math.atan2(by - ay, bx - ax), len: D, rw: D / 2 + 0.6, top: 1.9, zc: 0.8, anim: true,
          col: pal[0], col2: pal[1], col3: pal[2], napper: R() < 0.55,
          shirt: BRIGHT[(R() * BRIGHT.length) | 0], skin: SKINS[(R() * SKINS.length) | 0], hair: HAIRS[(R() * HAIRS.length) | 0],
        });
      }
    }
    return null;
  }
  function placeLamp(kind, fx, fy, R, used, seed) {
    const near = [];
    for (let l = 0; l < NL; l++) {
      const d = Math.hypot(la[2 * l] - fx, la[2 * l + 1] - fy);
      if (d < 350) near.push([d, l]);
    }
    near.sort((a, b) => a[0] - b[0]);
    for (const [, l] of near.slice(0, 12)) {
      if (used.has("l" + l)) continue;
      const x = la[2 * l], y = la[2 * l + 1];
      if (inBuilding(x, y) >= 0) continue;
      if (kind === "bike") {
        // along the nearest path or road, on whichever side of the post has room
        const segs = footSegs(x, y, 12, 1, 0.5);
        let ang = R() * TAU;
        if (segs.length) { const o = segs[0][0] * 7, S7 = G.segs; ang = Math.atan2(S7[o + 3] - S7[o + 1], S7[o + 2] - S7[o]); }
        const ca = Math.cos(ang), sa = Math.sin(ang);
        for (const s of R() < 0.5 ? [1, -1] : [-1, 1]) {
          const bx = x - sa * s * 0.3, by = y + ca * s * 0.3;
          if (inBuilding(bx, by) >= 0 || edgeDist(bx, by, 1) < 0.4 || groundAt(bx, by) === 2 && edgeDist(bx, by, 0) > 0 || !seen(bx, by, 0.6)) continue;
          used.add("l" + l);
          const basket = C.month >= 10 && C.month <= 11 && R() < 0.4 ? "pumpkin" : ["bread", "flowers", "book", "empty", "flowers"][(R() * 5) | 0];
          return mk("bike", bx, by, 0, seed, { host: B + NT + l, lx: x, ly: y, ang, lean: -s, col: BIKES[(R() * BIKES.length) | 0], basket, rw: 1, top: 1.2, zc: 0.6 });
        }
        continue;
      }
      if (!seen(x, y, kind === "balloon" ? 6.4 : 6)) continue;
      used.add("l" + l);
      if (kind === "balloon") {
        const a = R() * TAU, heart = R() < 0.22;
        return mk("balloon", x + Math.cos(a) * 0.45, y + Math.sin(a) * 0.45, 0, seed, {
          host: B + NT + l, lx: x, ly: y, col: heart ? (R() < 0.5 ? "#d9474f" : "#c9ced3") : BRIGHT[(R() * BRIGHT.length) | 0], heart,
          rw: 1.2, top: 7.2, zc: 6.5, anim: true,
        });
      }
      const h = HATS[(R() * HATS.length) | 0];
      return mk("beanie", x, y, 0, seed, { host: B + NT + l, col: h[0], col2: h[1], rw: 0.5, top: 6.4, zc: 6.0 });
    }
    return null;
  }
  function placePost(fx, fy, R, used, seed) {
    const P4 = postList();
    let best = [];
    for (let k = 0; k < P4.length; k += 4) {
      const d = Math.hypot(P4[k] - fx, P4[k + 1] - fy);
      if (d < 300) best.push([d, k]);
    }
    best.sort((a, b) => a[0] - b[0]);
    for (const [, k] of best.slice(0, 10)) {
      const x = P4[k], y = P4[k + 1];
      if (used.has("p" + k) || inBuilding(x, y) >= 0 || edgeDist(x, y, 1) < 0.5 || !seen(x, y, P4[k + 2] + 0.1)) continue;
      used.add("p" + k);
      const m = MITTENS[(R() * MITTENS.length) | 0];
      return mk("mitten", x, y, P4[k + 2], seed, { post: P4[k + 2] > 1, col: m[0], col2: m[1], thumb: R() < 0.5 ? -1 : 1, rw: 0.3, top: 0.35, zc: P4[k + 2] + 0.12 });
    }
    return null;
  }
  function placeDuck(fx, fy, R, used, seed) {
    const list = lakeList();
    // Mirror Lake first when it's anywhere near
    const mirror = list.find((e) => e.mirror);
    let near = nearestOf(list, 3, (e) => bboxDist(e.bb, fx, fy));
    if (mirror && bboxDist(mirror.bb, fx, fy) < 900) near = [[0, mirror], ...near.filter((q) => q[1] !== mirror)];
    for (const [d, e] of near) {
      if (d > 600 || used.has("w" + e.i)) continue;
      const a = data.areas[e.i], bb = e.bb;
      for (let q = 0; q < 40; q++) {
        const x = bb[0] + R() * (bb[2] - bb[0]), y = bb[1] + R() * (bb[3] - bb[1]);
        if (!inRings(a.p, x, y) || ringsEdge(a.p, x, y) < 4 || !seen(x, y, 0.1)) continue;
        used.add("w" + e.i);
        const n = R() < 0.35 ? 3 : 1;
        return mk("duck", x, y, 0, seed, { n, lake: e.i, rw: 2.2, top: 0.4, zc: 0.1, anim: true, col: "#f5cd3d", face: R() < 0.5 ? -1 : 1, where: a.n || "" });
      }
    }
    return null;
  }
  // a pumpkin (or two) on the step by a house's door, on the side facing its street
  function placePorch(fx, fy, R, used, seed) {
    const near = nearestOf(houseList(), 24, (i) => Math.hypot(G.bC[2 * i] - fx, G.bC[2 * i + 1] - fy));
    for (const [d, i] of near) {
      if (d > 700 || used.has("b" + i)) continue;
      const b = data.buildings[i], f = b.p[0], cx = G.bC[2 * i], cy = G.bC[2 * i + 1];
      const road = nearestRoad(cx, cy, 45);
      if (!road) continue;
      // the wall nearest the street, and a step out from its middle
      let best = Infinity, px = 0, py = 0, nx = 0, ny = 0;
      const n = f.length / 2;
      for (let e = 0; e < n; e++) {
        const e2 = (e + 1) % n, ax = f[2 * e], ay = f[2 * e + 1], bx = f[2 * e2], by = f[2 * e2 + 1], L = Math.hypot(bx - ax, by - ay);
        if (L < 2.2) continue;
        const mx = (ax + bx) / 2, my = (ay + by) / 2, dd = Math.hypot(mx - road[0], my - road[1]);
        if (dd < best) { best = dd; px = mx; py = my; nx = -(by - ay) / L; ny = (bx - ax) / L; }
      }
      if (!Number.isFinite(best)) continue;
      if (app.scene.contains(i, px + nx * 0.5, py + ny * 0.5)) { nx = -nx; ny = -ny; }
      const x = px + nx * 0.5, y = py + ny * 0.5;
      // (against a wall it can't be seen from behind the house: the usual view must see it, the others may not)
      if (inBuilding(x, y) >= 0 || inBuilding(x + nx * 0.3, y + ny * 0.3) >= 0 || edgeDist(x, y, 1) < 1.5 || hiddenFrom(x, y, 0.35, 0)) continue;
      used.add("b" + i);
      const late = C.month === 11 && C.dom > 10;
      return mk("pumpkin", x, y, 0, seed, {
        host: -1, house: i, ang: Math.atan2(ny, nx), two: R() < 0.6, carved: C.month === 11 || (C.month === 10 && C.dom >= 24) || (ALL && R() < 0.6),
        soft: late, rw: 0.8, top: 0.7, zc: 0.35, col: late ? "#d9772e" : "#e8832f", where: road[2] ? `A porch step on ${road[2]}` : "A porch step",
      });
    }
    return null;
  }
  function nearestRoad(x, y, reach) {
    const [ci, cj] = cellIJ(x, y), n = Math.ceil(reach / GC), S7 = G.segs;
    let best = Infinity, out = null;
    for (let j = cj - n; j <= cj + n; j++) for (let i = ci - n; i <= ci + n; i++) {
      if (i < 0 || j < 0 || i >= GX || j >= GY) continue;
      const L = G.sGrid[j * GX + i];
      if (L) for (const id of L) {
        const o = id * 7;
        if (S7[o + 5] !== 1) continue;
        const rd = data.roads[S7[o + 6]];
        if (rd.k === "service" || rd.k === "motorway" || rd.k === "busway") continue;
        const ax = S7[o], ay = S7[o + 1], dx = S7[o + 2] - ax, dy = S7[o + 3] - ay, L2 = dx * dx + dy * dy;
        const t = L2 > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / L2, 0, 1) : 0, qx = ax + dx * t, qy = ay + dy * t, d = Math.hypot(x - qx, y - qy);
        if (d < best && d < reach) { best = d; out = [qx, qy, rd.n || ""]; }
      }
    }
    return out;
  }
  // a bench beside a footway, facing it
  function placeBench(kind, fx, fy, R, used, seed) {
    const segs = footSegs(fx, fy, 260, 4, 1.5);
    const S7 = G.segs;
    for (const [id] of segs.slice(0, 14)) {
      const o = id * 7, ax = S7[o], ay = S7[o + 1], bx = S7[o + 2], by = S7[o + 3], hw = S7[o + 4];
      const L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L;
      for (let q = 0; q < 3; q++) {
        const t = 0.25 + R() * 0.5, s = R() < 0.5 ? 1 : -1;
        const off = hw + 0.45, x = ax + (bx - ax) * t - uy * s * off, y = ay + (by - ay) * t + ux * s * off;
        let ok = groundAt(x, y) !== 2 && inBuilding(x, y) < 0 && edgeDist(x, y, 1) > 1.5 && edgeDist(x, y, 2) > 0.6;
        // room for the whole bench: not on another path, a tree trunk or a lamp
        for (const e of [-0.9, 0.9]) {
          const ex = x + ux * e, ey = y + uy * e;
          if (!ok) break;
          ok = inBuilding(ex, ey) < 0 && edgeDist(ex, ey, 0, S7[o + 6]) > 0.2 && groundAt(ex, ey) !== 2;
        }
        if (!ok || nearTree(x, y, 0.6, true) || nearTree(x, y, 0.2, false) || nearLamp(x, y, 1.2) || !seen(x, y, 0.5)) continue;
        used.add("s" + id);
        // the bench faces the path: its back is on the far side
        const o2 = {
          ang: Math.atan2(uy, ux), face: s, rw: 1.1, top: 1, zc: 0.55,
          col: BOOKS[(R() * BOOKS.length) | 0], pieces: chessPieces(R), side: R() < 0.5 ? -1 : 1,
        };
        return mk(kind, x, y, 0, seed, o2);
      }
    }
    return null;
  }
  function chessPieces(R) {
    const out = [];
    for (let k = 0; k < 11; k++) out.push((R() * 8) | 0, (R() * 8) | 0, k % 2, R() < 0.3 ? 1 : 0);
    return out;
  }
  function placeChalk(fx, fy, R, used, seed) {
    const set = (R() * ART_SETS.length) | 0, art = ART_SETS[set], hop = art[0][0] === "hop";
    const colours = [];
    for (let k = 0; k < art.length; k++) colours.push(CHALK[(R() * CHALK.length) | 0], CHALK[(R() * CHALK.length) | 0]);
    const o = { art, colours, rw: hop ? 2 : 1.4, top: 0.05, zc: 0, col: colours[0] };
    // on a plaza, or along a footway
    if (!hop && R() < 0.5) {
      const near = nearestOf(plazaList(), 3, (e) => bboxDist(e.bb, fx, fy));
      for (const [d, e] of near) {
        if (d > 200 || used.has("z" + e.i)) continue;
        const a = data.areas[e.i], bb = e.bb;
        for (let q = 0; q < 25; q++) {
          const x = bb[0] + R() * (bb[2] - bb[0]), y = bb[1] + R() * (bb[3] - bb[1]);
          if (!inRings(a.p, x, y) || ringsEdge(a.p, x, y) < 1.8 || inBuilding(x, y) >= 0 || nearTree(x, y, 1.2, true) || nearTree(x, y, 0.3, false) || nearLamp(x, y, 1.5) || !seen(x, y, 0.05)) continue;
          used.add("z" + e.i);
          return mk("chalk", x, y, 0, seed, { ...o, ang: R() * TAU, where: a.n || "" });
        }
      }
    }
    const segs = footSegs(fx, fy, 220, hop ? 5 : 3, 1.9);
    const S7 = G.segs;
    for (const [id] of segs.slice(0, 10)) {
      if (used.has("s" + id)) continue;
      const k = id * 7, ax = S7[k], ay = S7[k + 1], bx = S7[k + 2], by = S7[k + 3];
      const L = Math.hypot(bx - ax, by - ay), t = clamp(0.5 + (R() - 0.5) * (1 - (hop ? 4 : 2.4) / L), 0.1, 0.9);
      const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
      if (inBuilding(x, y) >= 0 || edgeDist(x, y, 1) < 1.5 || nearTree(x, y, 0.2, false) || !seen(x, y, 0.05)) continue;
      used.add("s" + id);
      return mk("chalk", x, y, 0, seed, { ...o, ang: Math.atan2(by - ay, bx - ax) + (R() < 0.5 ? 0 : Math.PI) });
    }
    return null;
  }
  // where a curio is, in words: a named lawn, plaza or lake round it, a named building beside it, or its street
  function whereOf(x, y) {
    const c = cellOf(x, y);
    let best = null, ba = Infinity;
    const L = c < 0 ? null : G.aGrid[c];
    if (L) for (const i of L) {
      const a = data.areas[i];
      if (!a.n || (a.A || 0) >= ba) continue;
      if (inRings(a.p, x, y)) { best = a.n; ba = a.A || 0; }
    }
    if (best) return best;
    let bd = 45, bn = "";
    const [ci, cj] = cellIJ(x, y);
    for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 1; i <= ci + 1; i++) {
      if (i < 0 || j < 0 || i >= GX || j >= GY) continue;
      const Lb = G.bGrid[j * GX + i];
      if (Lb) for (const b of Lb) {
        const bd2 = data.buildings[b];
        if (!bd2.n || bd2.part) continue;
        const bb = G.bBox, d = bboxDist([bb[4 * b], bb[4 * b + 1], bb[4 * b + 2], bb[4 * b + 3]], x, y);
        if (d < bd) { bd = d; bn = bd2.n; }
      }
    }
    if (bn) return `By ${bn}`;
    const r = nearestRoad(x, y, 50);
    return r && r[2] ? `Along ${r[2]}` : "Somewhere on campus";
  }

  // ================================================================================================ drawing
  const vis = [];
  let want = 0, failed = false;
  const byDepth = (p, q) => q.d - p.d;
  function onView(c) {
    P(c.x, c.y, c.z);
    const m = c.rw * S + 24;
    return Q[0] > -m && Q[0] < VW + m && Q[1] > -m && Q[1] < VH + m + (c.top + c.z) * PK;
  }
  function draw(ctx, f) {
    vis.length = 0; want = 0;
    if (failed || !curios.length) { publish(0); return; }
    setCamera();
    if (S < MIN_S) { publish(0); return; }
    const t = f.t / 1000;
    for (const c of curios) {
      if (!onView(c)) { c.vis = false; continue; }
      c.d = c.x * D0 + c.y * D1;
      vis.push(c);
    }
    if (!vis.length) { publish(0); return; }
    vis.sort(byDepth);
    const close = S >= CLIP_S, still = reduceMQ.matches;
    let n = 0, moving = false;
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    try {
      for (const c of vis) {
        const hid = app.scene ? hiddenFar(c) : false;
        c.vis = !hid;
        if (!hid) { n++; if (c.anim && S >= ANIM_S && !(c.kind === "duck" && C.frozen)) moving = true; }
        if (close) {
          const ids = app.scene ? occluders(c) : null;
          if (ids && ids.length) drawCut(ctx, c, ids, still ? 0 : t);
          else paint(ctx, c, still ? 0 : t);
        } else if (!hid) paint(ctx, c, still ? 0 : t);
      }
    } finally {
      base(ctx);
      ctx.globalAlpha = 1;
      ctx.restore();
    }
    publish(n);
    if (moving && !still) want = ANIM_FPS;
  }
  function publish(n) {
    const w = (app.whimsy = app.whimsy || {});
    if (w.curios !== n) w.curios = n;
  }

  // ---------------------------------------------------------------- what stands in front
  // the scene objects in front of a curio whose screen box meets it (once per turn of the view: it holds while the view
  // pans and zooms); its host (the lamp it's on, the tree it's in, the roof it's on) never counts
  function occluders(c) {
    if (c.occR === ROT) return c.occ;
    const o = geo.ROTS[ROT];
    const X = c.x * o.R[0] + c.y * o.R[1], Y = -(c.x * o.D[0] + c.y * o.D[1]) * SIN_T;
    const ids = app.scene.query(ROT, "objects", X - c.rw - 0.5, Y - (c.z + c.top) * COS_T - c.rw, X + c.rw + 0.5, Y - c.z * COS_T + c.rw);
    const out = [];
    for (const id of ids) if (id !== c.host && app.scene.inFront(ROT, id, c.x, c.y, Math.min(c.rw, 1.5))) out.push(id);
    c.occ = out; c.occR = ROT;
    return out;
  }
  // from afar: a building or a leafy crown in front of its middle
  function hiddenFar(c) {
    if (c.hidR === ROT) return c.hid;
    c.hidR = ROT;
    const sc = app.scene, o = geo.ROTS[ROT], x = c.x, y = c.y;
    const U = x * o.R[0] + y * o.R[1] + c.odx, Yv = -(x * o.D[0] + y * o.D[1]) * SIN_T - c.zc * COS_T + c.ody;
    let hid = false;
    const b = sc.pickBuilding(ROT, U, Yv);
    if (b >= 0 && b !== c.host && sc.inFront(ROT, b, x, y, 0)) hid = true;
    if (!hid) {
      const ids = sc.query(ROT, "objects", U - 0.5, Yv - 0.5, U + 0.5, Yv + 0.5), TB = sc.B, TT = sc.T;
      for (const id of ids) {
        if (id < TB || id >= TB + TT || id === c.host) continue;
        const t = id - TB, tx = tr[5 * t], ty = tr[5 * t + 1], rad = tr[5 * t + 2], th = tr[5 * t + 3];
        if (renderer.treeBare(t, app.tileStyle) || !sc.inFront(ROT, id, x, y, 0)) continue;
        const cu = tx * o.R[0] + ty * o.R[1], cv = -(tx * o.D[0] + ty * o.D[1]) * SIN_T - Math.max(th - rad, th * 0.55) * COS_T;
        if ((U - cu) ** 2 + (Yv - cv) ** 2 < rad * rad * 0.8) { hid = true; break; }
      }
    }
    c.hid = hid;
    return hid;
  }
  const SIL = makeRecorder(), SIL_EXACT = SIL.withAddPath();
  const BOX = [0, 0, 0, 0];
  function drawCut(ctx, c, ids, t) {
    const sc = app.scene, Sr = sc.forRot(ROT), bb = Sr.objBB, TB = sc.B, TT = sc.T;
    P(c.x, c.y, c.z);
    const X0 = Q[0] - c.rw * S - 3, X1 = Q[0] + c.rw * S + 3, Y0 = Q[1] - c.top * PK - c.rw * S * 0.6 - 3, Y1 = Q[1] + c.rw * S * 0.6 + 3;
    BOX[0] = X0; BOX[1] = Y0; BOX[2] = X1; BOX[3] = Y1;
    const mX0 = (X0 - PE) / S, mY0 = (Y0 - PF) / S, mX1 = (X1 - PE) / S, mY1 = (Y1 - PF) / S;
    SIL.reset();
    let n = 0;
    for (let q = 0; q < ids.length; q++) {
      const id = ids[q], o = 4 * id;
      if (bb[o + 2] < mX0 || bb[o] > mX1 || bb[o + 3] < mY0 || bb[o + 1] > mY1) continue;
      const conifer = id >= TB && id < TB + TT && (tr[5 * (id - TB) + 4] & 1);
      renderer.silhouette(conifer ? SIL_EXACT : SIL, ROT, CAM, id, app.tileStyle);
      n++;
    }
    if (!n) { paint(ctx, c, t); return; }
    SIL.closePath();
    let cuts = 0;
    for (let p = 0; p < SIL.count; p++) if (SIL.meets(p, X0, Y0, X1, Y1)) cuts++;
    if (!cuts) { paint(ctx, c, t); return; }
    ctx.save();
    base(ctx);
    ctx.beginPath(); ctx.rect(X0, Y0, X1 - X0, Y1 - Y0); ctx.clip();
    for (let p = 0; p < SIL.count; p++) if (SIL.meets(p, X0, Y0, X1, Y1)) SIL.cut(ctx, p, X0 - 2, Y0 - 2, X1 + 2, Y1 + 2);
    paint(ctx, c, t);
    base(ctx);
    ctx.restore();
  }

  // ---------------------------------------------------------------- painting
  function paint(ctx, c, t) {
    ctx.globalAlpha = 1;
    switch (c.kind) {
      case "frisbee": drawFrisbee(ctx, c); break;
      case "kite": drawKite(ctx, c, t); break;
      case "chalk": drawChalk(ctx, c); break;
      case "umbrella": drawUmbrella(ctx, c); break;
      case "bike": drawBike(ctx, c); break;
      case "hammock": drawHammock(ctx, c, t); break;
      case "picnic": drawPicnic(ctx, c); break;
      case "mitten": drawMitten(ctx, c); break;
      case "plane": drawPlane(ctx, c); break;
      case "duck": drawDucks(ctx, c, t); break;
      case "balloon": drawBalloon(ctx, c, t); break;
      case "chess": case "book": drawBench(ctx, c); break;
      case "pumpkin": drawPumpkins(ctx, c); break;
      case "sock": drawSock(ctx, c); break;
      case "beanie": drawBeanie(ctx, c); break;
      case "snowman": drawSnowman(ctx, c); break;
      case "leaves": drawLeaves(ctx, c); break;
      case "cone": drawCone(ctx, c); break;
    }
    ctx.globalAlpha = 1;
  }
  function shadow(ctx, x, y, z, rx, ry, ca, sa, a) {
    hframe(ctx, x, y, z, ca, sa);
    ctx.globalAlpha = a; ctx.fillStyle = SHADOW;
    ctx.beginPath(); ctx.ellipse(0.06, 0.03, rx, ry, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
  }
  const ell = (ctx, x, y, rx, ry, rot = 0) => { ctx.beginPath(); ctx.ellipse(x, y, Math.max(0.001, rx), Math.max(0.001, ry), rot, 0, TAU); };
  // a box in a curio's frame (u along (ca, sa), v to its left), z0 to z1: its sides that face the camera, then its top
  const BX = new Float64Array(16);
  function box(ctx, c, u, v, hu, hv, z0, z1, top, lit, dark) {
    const ca = c.ca, sa = c.sa;
    for (let k = 0; k < 4; k++) {
      const su = k === 1 || k === 2 ? 1 : -1, sv = k >= 2 ? 1 : -1, lu = u + su * hu, lv = v + sv * hv;
      const x = c.x + lu * ca - lv * sa, y = c.y + lu * sa + lv * ca;
      P(x, y, z0); BX[2 * k] = Q[0]; BX[2 * k + 1] = Q[1];
      P(x, y, z1); BX[8 + 2 * k] = Q[0]; BX[8 + 2 * k + 1] = Q[1];
    }
    for (let e = 0; e < 4; e++) {
      const e2 = (e + 1) & 3;
      // the face's outward normal, on the ground
      const mu = e === 0 ? 0 : e === 1 ? 1 : e === 2 ? 0 : -1, mv = e === 0 ? -1 : e === 1 ? 0 : e === 2 ? 1 : 0;
      const nx = mu * ca - mv * sa, ny = mu * sa + mv * ca;
      if (nx * D0 + ny * D1 >= 0) continue;
      ctx.fillStyle = PA * nx + PB * ny < 0 ? lit : dark;
      ctx.beginPath();
      ctx.moveTo(BX[2 * e], BX[2 * e + 1]); ctx.lineTo(BX[2 * e2], BX[2 * e2 + 1]);
      ctx.lineTo(BX[8 + 2 * e2], BX[8 + 2 * e2 + 1]); ctx.lineTo(BX[8 + 2 * e], BX[8 + 2 * e + 1]);
      ctx.fill();
    }
    ctx.fillStyle = top;
    ctx.beginPath();
    ctx.moveTo(BX[8], BX[9]); ctx.lineTo(BX[10], BX[11]); ctx.lineTo(BX[12], BX[13]); ctx.lineTo(BX[14], BX[15]);
    ctx.fill();
  }
  // a point of a curio's frame (u along, v left, z up), into Q
  function L(c, u, v, z) { return P(c.x + u * c.ca - v * c.sa, c.y + u * c.sa + v * c.ca, z); }

  // ---- a frisbee on a roof (and a tennis ball, a second frisbee, an old football)
  function drawFrisbee(ctx, c) {
    for (const it of c.items) {
      const x = c.x + it.u, y = c.y + it.v, z = c.z;
      if (it.t === 0 || it.t === 2) {
        const r = Math.max(0.14, 1.8 / S);
        shadow(ctx, x, y, z + 0.005, r * 1.05, r * 1.05, 1, 0, 0.22);
        hframe(ctx, x, y, z + 0.035, 1, 0);
        ctx.fillStyle = it.col; ell(ctx, 0, 0, r, r); ctx.fill();
        if (S >= DETAIL_S) {
          ctx.strokeStyle = "rgba(40,30,30,.22)"; ctx.lineWidth = lw(0.016, 0.5); ell(ctx, 0, 0, r * 0.66, r * 0.66); ctx.stroke();
          ctx.strokeStyle = "rgba(255,255,255,.45)"; ctx.lineWidth = lw(0.02, 0.6); ctx.beginPath(); ctx.arc(0, 0, r * 0.88, 2.3, 3.6); ctx.stroke();
        }
      } else if (it.t === 1) {
        P(x, y, z + 0.035);
        const r = Math.max(0.8, 0.035 * S);
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        ctx.fillStyle = "#d6e353"; ell(ctx, Q[0], Q[1], r, r); ctx.fill();
      } else {
        shadow(ctx, x, y, z + 0.005, 0.15, 0.1, 0.8, 0.6, 0.2);
        hframe(ctx, x, y, z + 0.06, 0.8, 0.6);
        ctx.fillStyle = "#7a4a2a"; ell(ctx, 0, 0, Math.max(0.14, 1.6 / S), Math.max(0.085, 1 / S)); ctx.fill();
        if (S >= DETAIL_S * 1.5) { ctx.strokeStyle = "#f2efe8"; ctx.lineWidth = lw(0.012, 0.5); ctx.beginPath(); ctx.moveTo(-0.05, 0); ctx.lineTo(0.05, 0); ctx.stroke(); }
      }
    }
  }

  // ---- a kite caught in a crown, its tail blowing
  const BOWS = new Float64Array(12);
  function drawKite(ctx, c, t) {
    P(c.x, c.y, c.zc);
    const kx = Q[0] + c.odx * S, ky = Q[1] + c.ody * S;
    const W = W_(), wf = clamp((C.wind || 0) / 14, 0, 1);
    // where the wind blows to, on screen
    const wa = geo.headingToScreen(((C.windDir || 0) + 180) % 360, ROT), wx = Math.cos(wa), wy = Math.sin(wa);
    // the line, hanging down through the branches
    sframe(ctx, kx, ky, 0);
    ctx.strokeStyle = "rgba(246,243,233,.85)"; ctx.lineWidth = lw(0.014, 0.6);
    ctx.beginPath(); ctx.moveTo(0, 0.05); ctx.quadraticCurveTo(-c.side * 0.6, 1.1, -c.side * 0.35, 2.4); ctx.stroke();
    // the tail, from the bottom corner: down, and with the wind
    const bx = Math.sin(-c.tilt) * -0.45, by = Math.cos(c.tilt) * 0.45;
    let x = bx, y = by, a0 = Math.atan2(1 - wf * 0.75 + wy * wf * 0.5, wx * wf * 1.2 + 1e-3);
    ctx.strokeStyle = c.col2; ctx.lineWidth = lw(0.022, 0.7);
    ctx.beginPath(); ctx.moveTo(x, y);
    let nb = 0;
    for (let j = 1; j <= 7; j++) {
      const a = a0 + Math.sin(t * (2.6 + wf * 3) - j * 0.85 + c.ph) * (0.18 + 0.32 * wf) * Math.min(1, j / 3);
      x += Math.cos(a) * 0.2; y += Math.sin(a) * 0.2;
      ctx.lineTo(x, y);
      if (j % 2 === 0) { BOWS[nb++] = x; BOWS[nb++] = y; BOWS[nb++] = a; }
    }
    ctx.stroke();
    if (S >= 5) {
      ctx.fillStyle = c.col;
      for (let k = 0; k < nb; k += 3) {
        const bx2 = BOWS[k], by2 = BOWS[k + 1], a = BOWS[k + 2] + Math.PI / 2, ca = Math.cos(a) * 0.07, sa = Math.sin(a) * 0.07;
        ctx.beginPath(); ctx.moveTo(bx2, by2); ctx.lineTo(bx2 + ca - sa * 0.5, by2 + sa + ca * 0.5); ctx.lineTo(bx2 + ca + sa * 0.5, by2 + sa - ca * 0.5);
        ctx.moveTo(bx2, by2); ctx.lineTo(bx2 - ca - sa * 0.5, by2 - sa + ca * 0.5); ctx.lineTo(bx2 - ca + sa * 0.5, by2 - sa - ca * 0.5); ctx.fill();
      }
    }
    // the kite: a diamond in two colours, the right-hand panels in shade
    sframe(ctx, kx, ky, c.tilt);
    const A = c.col, Bc = c.col2;
    tri(ctx, 0, -0.5, -0.34, -0.12, 0, 0, A); tri(ctx, 0, -0.5, 0.34, -0.12, 0, 0, shadeHex(Bc, 0.9));
    tri(ctx, -0.34, -0.12, 0, 0.47, 0, 0, Bc); tri(ctx, 0.34, -0.12, 0, 0.47, 0, 0, shadeHex(A, 0.86));
    if (S >= 6) {
      ctx.strokeStyle = "rgba(70,50,40,.5)"; ctx.lineWidth = lw(0.016, 0.5);
      ctx.beginPath(); ctx.moveTo(0, -0.5); ctx.lineTo(0, 0.47); ctx.moveTo(-0.34, -0.12); ctx.lineTo(0.34, -0.12); ctx.stroke();
    }
  }
  function tri(ctx, ax, ay, bx, by, cx, cy, col) { ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx, cy); ctx.fill(); }

  // ---- sidewalk chalk
  function drawChalk(ctx, c) {
    const art = c.art;
    for (let k = 0; k < art.length; k++) {
      const [type, pu, pw, rot] = art[k];
      // the piece's own frame: offset in the drawing's frame, turned by rot
      const x = c.x + pu * c.ca + pw * c.sa, y = c.y + pu * c.sa - pw * c.ca, a = c.ang - rot;
      hframe(ctx, x, y, 0.004, Math.cos(a), Math.sin(a));
      ctx.globalAlpha = 0.92;
      ctx.lineWidth = lw(0.075, 0.8);
      chalkPiece(ctx, type, c.colours[2 * k], c.colours[2 * k + 1]);
    }
    ctx.globalAlpha = 1;
  }
  function chalkPiece(ctx, type, a, b) {
    ctx.strokeStyle = a; ctx.fillStyle = a;
    switch (type) {
      case "hop": {
        // hopscotch along the canvas's up: 1, 2, 3, then 4|5, 6, 7|8, and a half-round home
        const rows = HOP_ROWS, sz = 0.5;
        ctx.beginPath();
        rows.forEach((r, j) => {
          const y0 = 1.6 - j * sz;
          if (r.length === 1) ctx.rect(-sz / 2, y0 - sz, sz, sz);
          else { ctx.rect(-sz, y0 - sz, sz, sz); ctx.rect(0, y0 - sz, sz, sz); }
        });
        const yTop = 1.6 - rows.length * sz;
        ctx.moveTo(-sz / 2, yTop); ctx.arc(0, yTop, sz / 2, Math.PI, 0); ctx.stroke();
        if (S >= 7) {
          ctx.fillStyle = b;
          ctx.scale(0.01, 0.01);
          ctx.font = "600 30px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          rows.forEach((r, j) => {
            const y0 = (1.6 - j * sz - sz / 2) * 100;
            if (r.length === 1) ctx.fillText(String(r[0]), 0, y0);
            else { ctx.fillText(String(r[0]), -25, y0); ctx.fillText(String(r[1]), 25, y0); }
          });
          ctx.scale(100, 100);
        }
        break;
      }
      case "sun": {
        ctx.globalAlpha = 0.4; ell(ctx, 0, 0, 0.3, 0.3); ctx.fill(); ctx.globalAlpha = 0.85;
        ell(ctx, 0, 0, 0.3, 0.3); ctx.stroke();
        ctx.beginPath();
        for (let q = 0; q < 10; q++) { const r = q * TAU / 10, cs = Math.cos(r), sn = Math.sin(r); ctx.moveTo(cs * 0.4, sn * 0.4); ctx.lineTo(cs * 0.6, sn * 0.6); }
        ctx.stroke();
        ctx.strokeStyle = b; ctx.beginPath(); ctx.arc(0, 0.02, 0.15, 0.4, Math.PI - 0.4); ctx.stroke();
        ctx.fillStyle = b; ell(ctx, -0.1, -0.08, 0.035, 0.035); ctx.fill(); ell(ctx, 0.1, -0.08, 0.035, 0.035); ctx.fill();
        break;
      }
      case "hi": {
        ctx.lineWidth = lw(0.075, 0.7);
        ctx.beginPath();
        ctx.moveTo(-0.32, -0.42); ctx.lineTo(-0.32, 0.4);
        ctx.moveTo(-0.32, 0.06); ctx.quadraticCurveTo(-0.14, -0.22, 0.0, 0.0); ctx.lineTo(0.0, 0.4);
        ctx.moveTo(0.26, -0.04); ctx.lineTo(0.26, 0.4);
        ctx.stroke();
        ell(ctx, 0.26, -0.24, 0.055, 0.055); ctx.fill();
        break;
      }
      case "heart": {
        ctx.beginPath();
        ctx.moveTo(0, 0.28); ctx.bezierCurveTo(-0.42, 0.0, -0.3, -0.32, 0, -0.12); ctx.bezierCurveTo(0.3, -0.32, 0.42, 0.0, 0, 0.28);
        ctx.globalAlpha = 0.45; ctx.fill(); ctx.globalAlpha = 0.85; ctx.stroke();
        break;
      }
      case "flower": {
        ctx.strokeStyle = "#a8d89a";
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(0.05, 0.3, 0, 0.6); ctx.stroke();
        ell(ctx, 0.1, 0.36, 0.1, 0.04, -0.5); ctx.stroke();
        ctx.strokeStyle = a;
        ctx.beginPath();
        for (let q = 0; q < 5; q++) { const r = q * TAU / 5 - Math.PI / 2, x = Math.cos(r) * 0.16, y = Math.sin(r) * 0.16; ctx.moveTo(x + 0.11, y); ctx.arc(x, y, 0.11, 0, TAU); }
        ctx.stroke();
        ctx.fillStyle = b; ell(ctx, 0, 0, 0.07, 0.07); ctx.fill();
        break;
      }
      case "star": {
        ctx.beginPath();
        for (let q = 0; q <= 10; q++) { const r = q * Math.PI / 5 - Math.PI / 2, rr = q % 2 ? 0.13 : 0.32; if (q) ctx.lineTo(Math.cos(r) * rr, Math.sin(r) * rr); else ctx.moveTo(Math.cos(r) * rr, Math.sin(r) * rr); }
        ctx.stroke();
        break;
      }
      case "rainbow": {
        const cols = RAINBOW;
        ctx.lineWidth = lw(0.08, 0.7);
        for (let q = 0; q < cols.length; q++) { ctx.strokeStyle = cols[q]; ctx.beginPath(); ctx.arc(0, 0.25, 0.75 - q * 0.1, Math.PI, TAU); ctx.stroke(); }
        ctx.fillStyle = "#f7f4ec"; ctx.globalAlpha = 0.7;
        for (const s of SIDES) { ell(ctx, s * 0.6, 0.27, 0.13, 0.09); ctx.fill(); ell(ctx, s * 0.5, 0.3, 0.1, 0.07); ctx.fill(); }
        ctx.globalAlpha = 0.85;
        break;
      }
      case "smile": {
        ell(ctx, 0, 0, 0.3, 0.3); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0.02, 0.17, 0.35, Math.PI - 0.35); ctx.stroke();
        ell(ctx, -0.1, -0.09, 0.035, 0.035); ctx.fill(); ell(ctx, 0.1, -0.09, 0.035, 0.035); ctx.fill();
        break;
      }
    }
  }

  // ---- an umbrella, open, on its side in the grass
  function drawUmbrella(ctx, c) {
    shadow(ctx, c.x, c.y, 0, 0.6, 0.35, c.ca, c.sa, 0.2);
    P(c.x, c.y, 0);
    sframe(ctx, Q[0], Q[1] - 0.22 * PK, c.rot);
    // the canopy: a dome with a scalloped rim, its panels in two colours
    ctx.beginPath();
    ctx.moveTo(-0.5, 0); ctx.ellipse(0, 0, 0.5, 0.34, 0, Math.PI, TAU);
    for (let q = 0; q < 6; q++) { const x0 = 0.5 - q * (1 / 6), x1 = x0 - 1 / 6; ctx.quadraticCurveTo((x0 + x1) / 2, -0.07, x1, 0); }
    ctx.fillStyle = c.col; ctx.fill();
    if (c.col2 !== c.col || c.dots) {
      ctx.save();
      ctx.clip();
      ctx.fillStyle = c.col2;
      ctx.beginPath();
      if (c.dots) for (let q = 0; q < 7; q++) { const a = Math.PI + (q + 0.5) * Math.PI / 7; ell(ctx, Math.cos(a) * 0.3, Math.sin(a) * 0.2, 0.045, 0.04); ctx.fill(); }
      else { for (let q = 0; q < 6; q += 2) { const x0 = -0.5 + q / 6; ctx.moveTo(0, -0.34); ctx.lineTo(x0, 0.01); ctx.lineTo(x0 + 1 / 6, 0.01); } ctx.fill(); }
      ctx.restore();
    }
    // shade on the side away from the light, the ribs, the tip, the shaft and its hooked handle
    ctx.fillStyle = "rgba(20,24,40,.16)";
    ctx.beginPath(); ctx.moveTo(0, -0.34); ctx.ellipse(0, 0, 0.5, 0.34, 0, -Math.PI / 2, 0); ctx.lineTo(0, 0); ctx.fill();
    ctx.strokeStyle = "#3a3330"; ctx.lineWidth = lw(0.022, 0.6);
    ctx.beginPath(); ctx.moveTo(0, -0.42); ctx.lineTo(0, 0.3); ctx.arc(0.06, 0.3, 0.06, Math.PI, 0, true); ctx.stroke();
  }

  // ---- a bicycle with a basket, leaning on a lamp post
  function drawBike(ctx, c) {
    shadow(ctx, c.x, c.y, 0, 0.85, 0.16, c.ca, c.sa, 0.2);
    // upright along its frame, leaning a little toward the post
    vframe(ctx, c.x, c.y, 0, c.ca, c.sa, 0.1, -c.sa * c.lean, c.ca * c.lean);
    const fine = S >= DETAIL_S;
    // wheels
    ctx.strokeStyle = "#2f3034"; ctx.lineWidth = lw(0.045, 0.8);
    ell(ctx, -0.52, -0.34, 0.33, 0.33); ctx.stroke(); ell(ctx, 0.53, -0.34, 0.33, 0.33); ctx.stroke();
    if (fine) {
      ctx.strokeStyle = "rgba(120,124,130,.6)"; ctx.lineWidth = lw(0.008, 0.4);
      ctx.beginPath();
      for (const cx of WHEELS) for (let q = 0; q < 8; q++) { const a = q * Math.PI / 8; ctx.moveTo(cx + Math.cos(a) * 0.3, -0.34 + Math.sin(a) * 0.3); ctx.lineTo(cx - Math.cos(a) * 0.3, -0.34 - Math.sin(a) * 0.3); }
      ctx.stroke();
    }
    // a step-through frame, the mudguard, the saddle, the bars
    ctx.strokeStyle = c.col; ctx.lineWidth = lw(0.042, 0.8);
    ctx.beginPath();
    ctx.moveTo(-0.52, -0.34); ctx.lineTo(0, -0.33); ctx.lineTo(-0.15, -0.86);
    ctx.moveTo(-0.52, -0.34); ctx.lineTo(-0.15, -0.8);
    ctx.moveTo(0, -0.33); ctx.quadraticCurveTo(0.2, -0.45, 0.36, -0.86);
    ctx.moveTo(0.36, -0.88); ctx.lineTo(0.53, -0.34);
    ctx.stroke();
    if (fine) { ctx.lineWidth = lw(0.03, 0.6); ctx.beginPath(); ctx.arc(-0.52, -0.34, 0.38, Math.PI * 1.05, Math.PI * 1.75); ctx.stroke(); }
    ctx.strokeStyle = "#3d4147"; ctx.lineWidth = lw(0.03, 0.6);
    ctx.beginPath(); ctx.moveTo(-0.15, -0.86); ctx.lineTo(-0.18, -0.96); ctx.moveTo(0.36, -0.88); ctx.lineTo(0.34, -1.04); ctx.lineTo(0.2, -1.06); ctx.stroke();
    ctx.strokeStyle = "#5a3b28"; ctx.lineWidth = lw(0.06, 0.9);
    ctx.beginPath(); ctx.moveTo(-0.29, -0.98); ctx.lineTo(-0.08, -0.98); ctx.stroke();
    // the basket, and what's in it
    if (c.basket === "flowers" && fine) {
      ctx.strokeStyle = "#5f8f4a"; ctx.lineWidth = lw(0.015, 0.5);
      ctx.beginPath(); for (let q = 0; q < 4; q++) { ctx.moveTo(0.52 + q * 0.05, -1.05); ctx.lineTo(0.48 + q * 0.07, -1.28 + q * 0.02); } ctx.stroke();
      const fl = POSIES;
      for (let q = 0; q < 4; q++) { ctx.fillStyle = fl[q]; ell(ctx, 0.48 + q * 0.07, -1.29 + q * 0.02, 0.045, 0.045); ctx.fill(); }
    } else if (c.basket === "bread") {
      ctx.strokeStyle = "#d9a55a"; ctx.lineWidth = lw(0.07, 0.9);
      ctx.beginPath(); ctx.moveTo(0.5, -1.0); ctx.lineTo(0.66, -1.3); ctx.stroke();
    } else if (c.basket === "pumpkin") {
      ctx.fillStyle = "#e8832f"; ell(ctx, 0.58, -1.12, 0.11, 0.09); ctx.fill();
    } else if (c.basket === "book") {
      ctx.fillStyle = "#2f6f73"; ctx.fillRect(0.5, -1.18, 0.16, 0.1);
    }
    ctx.fillStyle = "#c39a5f"; ctx.fillRect(0.4, -1.13, 0.34, 0.26);
    if (fine) {
      ctx.strokeStyle = "rgba(110,80,45,.6)"; ctx.lineWidth = lw(0.012, 0.4);
      ctx.beginPath(); for (let q = 1; q < 4; q++) { ctx.moveTo(0.4, -1.13 + q * 0.065); ctx.lineTo(0.74, -1.13 + q * 0.065); } ctx.stroke();
    }
  }

  // ---- a hammock between two trees (with someone napping in it, perhaps)
  const HM = new Float64Array(4 * 13);
  function drawHammock(ctx, c, t) {
    const n = 12, u0 = -c.len / 2 + 0.55, u1 = c.len / 2 - 0.55, sw = Math.sin(t * 1.1 + c.ph) * 0.07;
    shadow(ctx, c.x, c.y, 0, (u1 - u0) / 2, 0.45, c.ca, c.sa, 0.16);
    // ropes from the trunks
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.strokeStyle = "#8b7a62"; ctx.lineWidth = Math.max(0.6, 0.025 * S);
    ctx.beginPath();
    L(c, -c.len / 2, 0, 1.65); ctx.moveTo(Q[0], Q[1]); L(c, u0, 0, 1.15); ctx.lineTo(Q[0], Q[1]);
    L(c, c.len / 2, 0, 1.65); ctx.moveTo(Q[0], Q[1]); L(c, u1, 0, 1.15); ctx.lineTo(Q[0], Q[1]);
    ctx.stroke();
    // the cloth: cross sections from end to end, each sagging to the middle and swaying a little
    for (let k = 0; k <= n; k++) {
      const s = k / n, u = u0 + (u1 - u0) * s, bulge = Math.sin(Math.PI * s), w = 0.04 + 0.42 * Math.pow(bulge, 0.6), z = 1.15 - 0.62 * bulge, v = sw * bulge;
      L(c, u, v + w, z + 0.06 * bulge); HM[4 * k] = Q[0]; HM[4 * k + 1] = Q[1];
      L(c, u, v - w, z + 0.06 * bulge); HM[4 * k + 2] = Q[0]; HM[4 * k + 3] = Q[1];
    }
    hmBand(ctx, n, 1, c.col);
    hmBand(ctx, n, 0.55, c.col2);
    hmBand(ctx, n, 0.2, c.col3);
    if (c.napper) {
      // someone asleep, a book open over their face
      const mid = (u0 + u1) / 2, zz = 1.15 - 0.62 + 0.05;
      ctx.lineCap = "round";
      ctx.strokeStyle = "#3b4b6b"; ctx.lineWidth = Math.max(1.5, 0.22 * S);
      ctx.beginPath(); L(c, mid + 0.15, sw, zz + 0.12); ctx.moveTo(Q[0], Q[1]); L(c, mid + 0.75, sw, zz + 0.3); ctx.lineTo(Q[0], Q[1]); ctx.stroke();
      ctx.strokeStyle = c.shirt; ctx.lineWidth = Math.max(2, 0.34 * S);
      ctx.beginPath(); L(c, mid - 0.45, sw, zz + 0.2); ctx.moveTo(Q[0], Q[1]); L(c, mid + 0.15, sw, zz + 0.12); ctx.lineTo(Q[0], Q[1]); ctx.stroke();
      L(c, mid - 0.72, sw, zz + 0.32);
      const hx = Q[0], hy = Q[1], hr = Math.max(1.2, 0.13 * S);
      ctx.fillStyle = c.skin; ell(ctx, hx, hy, hr, hr); ctx.fill();
      ctx.fillStyle = c.hair; ctx.beginPath(); ctx.arc(hx, hy, hr * 1.02, Math.PI * 0.9, Math.PI * 1.9); ctx.fill();
      if (S >= 7) {
        ctx.fillStyle = "#f4efe2"; ctx.beginPath(); ctx.moveTo(hx - hr * 1.3, hy + hr * 0.2); ctx.lineTo(hx, hy - hr * 0.9); ctx.lineTo(hx + hr * 1.3, hy + hr * 0.2); ctx.fill();
        ctx.strokeStyle = "#7b2d3a"; ctx.lineWidth = Math.max(0.6, 0.03 * S); ctx.stroke();
      }
    }
  }
  // the band of the cloth between fractions ±f of its width, filled
  function hmBand(ctx, n, f, col) {
    ctx.fillStyle = col;
    ctx.beginPath();
    for (let k = 0; k <= n; k++) {
      const lx = HM[4 * k], ly = HM[4 * k + 1], rx = HM[4 * k + 2], ry = HM[4 * k + 3], mx = (lx + rx) / 2, my = (ly + ry) / 2;
      const x = mx + (lx - mx) * f, y = my + (ly - my) * f;
      if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    for (let k = n; k >= 0; k--) {
      const lx = HM[4 * k], ly = HM[4 * k + 1], rx = HM[4 * k + 2], ry = HM[4 * k + 3], mx = (lx + rx) / 2, my = (ly + ry) / 2;
      ctx.lineTo(mx + (rx - mx) * f, my + (ry - my) * f);
    }
    ctx.fill();
  }

  // ---- a picnic: a gingham blanket, a basket, plates and an apple
  function drawPicnic(ctx, c) {
    hframe(ctx, c.x, c.y, 0.01, c.ca, c.sa);
    ctx.fillStyle = "rgba(38,50,60,.14)"; ctx.fillRect(-0.76, -0.6, 1.6, 1.3);
    ctx.fillStyle = "#f4efe4"; ctx.fillRect(-0.8, -0.65, 1.6, 1.3);
    if (S >= 4) {
      ctx.fillStyle = "rgba(179,32,42,.42)";
      ctx.beginPath();
      for (let q = 0; q < 8; q++) ctx.rect(-0.8 + q * 0.2, -0.65, 0.1, 1.3);
      for (let q = 0; q < 7; q++) ctx.rect(-0.8, -0.65 + q * 0.2, 1.6, 0.1);
      ctx.fill();
    } else { ctx.fillStyle = "rgba(179,32,42,.45)"; ctx.fillRect(-0.8, -0.65, 1.6, 1.3); }
    // plates
    ctx.fillStyle = "#fbf8f1";
    ell(ctx, -0.35, 0.3, 0.12, 0.12); ctx.fill();
    if (c.plates > 1) { ell(ctx, 0.25, 0.35, 0.12, 0.12); ctx.fill(); }
    if (S >= DETAIL_S) { ctx.fillStyle = "#d9a55a"; tri(ctx, -0.42, 0.28, -0.27, 0.24, -0.33, 0.37, "#e3c48a"); }
    // the basket, with its lid and handle
    box(ctx, c, 0.42, -0.3, 0.22, 0.15, 0.01, 0.25, "#c9a067", "#b48a52", "#96713f");
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.strokeStyle = "#8a6a3e"; ctx.lineWidth = Math.max(0.8, 0.03 * S);
    ctx.beginPath(); L(c, 0.26, -0.3, 0.25); ctx.moveTo(Q[0], Q[1]);
    const hx = Q[0], hy = Q[1]; L(c, 0.58, -0.3, 0.25); const ex = Q[0], ey = Q[1];
    ctx.quadraticCurveTo((hx + ex) / 2, (hy + ey) / 2 - 0.32 * PK, ex, ey); ctx.stroke();
    if (c.apple) {
      L(c, -0.1, -0.2, 0.05);
      const r = Math.max(1, 0.05 * S);
      ctx.fillStyle = "#c8372d"; ell(ctx, Q[0], Q[1], r, r); ctx.fill();
      ctx.fillStyle = "#f3e7c9"; ell(ctx, Q[0] + r * 0.35, Q[1] - r * 0.1, r * 0.45, r * 0.6); ctx.fill();   // one bite out of it
    }
  }

  // ---- a lost mitten, on a fence post (or a low wall)
  function drawMitten(ctx, c) {
    P(c.x, c.y, 0);
    const gx = Q[0], gy = Q[1];
    if (c.post) {
      bframe(ctx, gx, gy);
      ctx.fillStyle = "#8a8174"; ctx.fillRect(-0.05, -c.z, 0.1, c.z);
      ctx.fillStyle = "#6f675c"; ctx.fillRect(0.0, -c.z, 0.05, c.z);
      ctx.fillStyle = "#9b9285"; ctx.fillRect(-0.06, -c.z - 0.03, 0.12, 0.04);
    }
    bframe(ctx, gx, gy - c.z * PK);
    const k = Math.max(1.4, 4 / (0.27 * S));   // (a generous mitten: it has to be seen)
    ctx.scale(k, k);
    const m = c.thumb;
    ctx.fillStyle = c.col;
    ctx.beginPath(); ctx.ellipse(m * 0.075, -0.15, 0.035, 0.055, m * 0.5, 0, TAU); ctx.fill();
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-0.07, -0.27, 0.14, 0.23, [0.07, 0.07, 0.01, 0.01]); else ctx.rect(-0.07, -0.27, 0.14, 0.23);
    ctx.fill();
    ctx.fillStyle = "rgba(30,20,30,.18)"; ctx.fillRect(0.02, -0.25, 0.05, 0.2);
    ctx.fillStyle = c.col2; ctx.fillRect(-0.075, -0.07, 0.15, 0.07);
    if (S >= 16) { ctx.fillStyle = c.col2; ell(ctx, 0, -0.17, 0.02, 0.02); ctx.fill(); }
  }

  // ---- a paper airplane in the grass
  const PL = new Float64Array(10);
  function drawPlane(ctx, c) {
    shadow(ctx, c.x, c.y, 0, 0.17, 0.11, c.ca, c.sa, 0.18);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const k = Math.max(1.35, 3 / (0.3 * S));   // a big one, and never smaller than a few pixels
    L(c, 0.17 * k, 0, 0.05); PL[0] = Q[0]; PL[1] = Q[1];         // nose
    L(c, -0.13 * k, 0.13 * k, 0.08); PL[2] = Q[0]; PL[3] = Q[1]; // wing tips
    L(c, -0.13 * k, -0.13 * k, 0.08); PL[4] = Q[0]; PL[5] = Q[1];
    L(c, -0.13 * k, 0, 0.02); PL[6] = Q[0]; PL[7] = Q[1];        // the keel's tail
    L(c, -0.13 * k, 0, 0.07); PL[8] = Q[0]; PL[9] = Q[1];
    const lit = PA * -c.sa + PB * c.ca < 0;   // which wing faces the light (screen left)
    ctx.fillStyle = lit ? "#fbfaf5" : "#e3dfd4";
    ctx.beginPath(); ctx.moveTo(PL[0], PL[1]); ctx.lineTo(PL[2], PL[3]); ctx.lineTo(PL[8], PL[9]); ctx.fill();
    ctx.fillStyle = lit ? "#e3dfd4" : "#fbfaf5";
    ctx.beginPath(); ctx.moveTo(PL[0], PL[1]); ctx.lineTo(PL[4], PL[5]); ctx.lineTo(PL[8], PL[9]); ctx.fill();
    ctx.fillStyle = "#cfc9bb";
    ctx.beginPath(); ctx.moveTo(PL[0], PL[1]); ctx.lineTo(PL[6], PL[7]); ctx.lineTo(PL[8], PL[9]); ctx.fill();
    if (c.lined && S >= 14) {
      ctx.strokeStyle = "rgba(90,130,190,.45)"; ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.moveTo((PL[0] + PL[2]) / 2, (PL[1] + PL[3]) / 2); ctx.lineTo((PL[2] + PL[8]) / 2, (PL[3] + PL[9]) / 2); ctx.stroke();
    }
  }

  // ---- rubber ducks drifting on the lake
  function drawDucks(ctx, c, t) {
    const frozen = C.frozen, n = c.n;
    for (let i = n - 1; i >= 0; i--) {
      const tt = frozen ? c.ph * 20 - i * 3 : t - i * 3.2, sz = n > 1 ? (i ? 0.95 : 1.5) : 1.8;
      const w1 = TAU / 83, w2 = TAU / 61;
      const dx = Math.sin(tt * w1 + c.ph) * 1.4, dy = Math.sin(tt * w2 + c.ph * 1.7) * 1.0;
      const vx = Math.cos(tt * w1 + c.ph) * w1 * 1.4, vy = Math.cos(tt * w2 + c.ph * 1.7) * w2 * 1.0;
      const x = c.x + dx, y = c.y + dy;
      if (!frozen) {
        // rings spreading from it
        hframe(ctx, x, y, 0, 1, 0);
        ctx.strokeStyle = "#ffffff"; ctx.lineWidth = lw(0.02, 0.5);
        for (let r = 0; r < 2; r++) {
          const p = (t * 0.35 + r * 0.5 + i * 0.3 + c.ph) % 1;
          ctx.globalAlpha = 0.5 * (1 - p); ell(ctx, 0, 0, (0.18 + p * 0.45) * sz, (0.18 + p * 0.45) * sz); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      P(x, y, 0);
      const svx = PA * vx + PB * vy, fs = Math.abs(svx) > 1e-4 ? (svx > 0 ? 1 : -1) : c.face;
      const bob = frozen ? 0 : Math.sin(t * 2.1 + i) * 0.008;
      bframe(ctx, Q[0], Q[1] + bob * PK);
      const k = Math.max(sz, 3 / (0.24 * S));
      ctx.fillStyle = "#d9a62a"; ell(ctx, 0, -0.045 * k, 0.12 * k, 0.05 * k * IC); ctx.fill();
      ctx.fillStyle = c.col; ell(ctx, -0.01 * fs * k, -0.06 * k, 0.11 * k, 0.05 * k * IC); ctx.fill();
      tri(ctx, -0.1 * fs * k, -0.07 * k, -0.15 * fs * k, -0.13 * k, -0.06 * fs * k, -0.1 * k, c.col);
      ell(ctx, 0.07 * fs * k, -0.15 * k, 0.055 * k, 0.055 * k * IC); ctx.fill();
      ctx.fillStyle = "#ec8a2f"; ell(ctx, 0.13 * fs * k, -0.145 * k, 0.035 * k, 0.016 * k * IC); ctx.fill();
      if (S * k >= 8) {
        ctx.fillStyle = "#2a2622"; ell(ctx, 0.085 * fs * k, -0.165 * k, 0.011 * k, 0.011 * k * IC); ctx.fill();
        ctx.fillStyle = "#e7b52f"; ell(ctx, -0.02 * fs * k, -0.07 * k, 0.05 * k, 0.022 * k * IC, fs * 0.3); ctx.fill();
      }
    }
  }

  // ---- a balloon caught on a lamp post, bobbing
  function drawBalloon(ctx, c, t) {
    const dz = Math.sin(t * 1.25 + c.ph) * 0.1, sway = Math.sin(t * 0.8 + c.ph * 1.3) * 0.07;
    P(c.lx, c.ly, 4.3); const sx0 = Q[0], sy0 = Q[1];
    P(c.x, c.y, 6.55 + dz);
    const bx = Q[0] + sway * S, by = Q[1], rx = Math.max(1.6, 0.3 * S), ry = Math.max(1.9, 0.36 * S);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.strokeStyle = "rgba(120,112,100,.85)"; ctx.lineWidth = Math.max(0.5, 0.014 * S);
    ctx.beginPath(); ctx.moveTo(sx0, sy0); ctx.quadraticCurveTo((sx0 + bx) / 2 - sway * S * 2, (sy0 + by + ry) / 2 + 0.25 * PK, bx, by + ry * 1.05); ctx.stroke();
    ctx.translate(bx, by);
    if (c.heart) {
      ctx.fillStyle = shadeHex(c.col, 0.78);
      heartPath(ctx, rx * 1.05); ctx.fill();
      ctx.fillStyle = c.col; ctx.translate(-rx * 0.06, -ry * 0.06); heartPath(ctx, rx * 0.93); ctx.fill();
    } else {
      ctx.fillStyle = shadeHex(c.col, 0.78); ell(ctx, 0, 0, rx, ry); ctx.fill();
      ctx.fillStyle = c.col; ell(ctx, -rx * 0.08, -ry * 0.08, rx * 0.88, ry * 0.88); ctx.fill();
      ctx.fillStyle = shadeHex(c.col, 0.78);
      ctx.beginPath(); ctx.moveTo(0, ry * 0.96); ctx.lineTo(-rx * 0.14, ry * 1.12); ctx.lineTo(rx * 0.14, ry * 1.12); ctx.fill();
    }
    ctx.fillStyle = "rgba(255,255,255,.55)"; ell(ctx, -rx * 0.38, -ry * 0.42, rx * 0.17, ry * 0.25, -0.5); ctx.fill();
  }
  function heartPath(ctx, r) {
    ctx.beginPath();
    ctx.moveTo(0, r * 1.05); ctx.bezierCurveTo(-r * 1.5, -r * 0.1, -r * 0.8, -r * 1.25, 0, -r * 0.5); ctx.bezierCurveTo(r * 0.8, -r * 1.25, r * 1.5, -r * 0.1, 0, r * 1.05);
  }

  // ---- a bench beside a path: a chess game left mid-play, or a library book left face down
  function drawBench(ctx, c) {
    const f = c.face, back = -f * 0.24;
    shadow(ctx, c.x, c.y, 0, 0.9, 0.3, c.ca, c.sa, 0.16);
    // the back stands farther from the camera than the seat, or nearer
    const bx = c.x - back * c.sa, by = c.y + back * c.ca, backFar = bx * D0 + by * D1 > c.x * D0 + c.y * D1;
    if (backFar) benchBack(ctx, c, back);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.strokeStyle = "#43474d"; ctx.lineWidth = Math.max(0.8, 0.05 * S);
    ctx.beginPath();
    for (const u of LEGS_U) for (const v of LEGS_V) { L(c, u, v, 0); ctx.moveTo(Q[0], Q[1]); L(c, u, v, 0.42); ctx.lineTo(Q[0], Q[1]); }
    ctx.stroke();
    box(ctx, c, 0, 0, 0.8, 0.21, 0.4, 0.46, "#c99260", "#a8774a", "#8f6440");
    if (S >= DETAIL_S) {
      ctx.strokeStyle = "rgba(90,60,35,.35)"; ctx.lineWidth = Math.max(0.5, 0.012 * S);
      ctx.beginPath(); for (const v of SLATS) { L(c, -0.8, v, 0.46); ctx.moveTo(Q[0], Q[1]); L(c, 0.8, v, 0.46); ctx.lineTo(Q[0], Q[1]); } ctx.stroke();
    }
    if (c.kind === "chess") chessboard(ctx, c);
    else book(ctx, c);
    if (!backFar) benchBack(ctx, c, back);
  }
  function benchBack(ctx, c, back) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.strokeStyle = "#43474d"; ctx.lineWidth = Math.max(0.8, 0.045 * S);
    ctx.beginPath(); for (const u of LEGS_U) { L(c, u, back * 0.7, 0.44); ctx.moveTo(Q[0], Q[1]); L(c, u, back, 0.86); ctx.lineTo(Q[0], Q[1]); } ctx.stroke();
    const facing = (-c.sa * Math.sign(-back)) * D0 + (c.ca * Math.sign(-back)) * D1 < 0;   // its front toward the camera?
    const col = facing ? "#b98654" : "#8f6440";
    for (const [z0, z1] of BACK_SLATS) {
      ctx.fillStyle = col; ctx.beginPath();
      L(c, -0.8, back, z0); ctx.moveTo(Q[0], Q[1]); L(c, 0.8, back, z0); ctx.lineTo(Q[0], Q[1]);
      L(c, 0.8, back, z1); ctx.lineTo(Q[0], Q[1]); L(c, -0.8, back, z1); ctx.lineTo(Q[0], Q[1]); ctx.fill();
    }
  }
  function chessboard(ctx, c) {
    const u0 = 0.1 * c.side;
    const bx = c.x + (0.3 * c.side) * c.ca, by = c.y + (0.3 * c.side) * c.sa;
    hframe(ctx, bx, by, 0.465, c.ca, c.sa);
    ctx.fillStyle = "#efe3c4"; ctx.fillRect(-0.19, -0.19, 0.38, 0.38);
    ctx.fillStyle = "#7a5638";
    ctx.beginPath();
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) if ((i + j) & 1) ctx.rect(-0.19 + i * 0.0475, -0.19 + j * 0.0475, 0.0475, 0.0475);
    ctx.fill();
    ctx.strokeStyle = "#5a3b28"; ctx.lineWidth = lw(0.012, 0.4); ctx.strokeRect(-0.19, -0.19, 0.38, 0.38);
    if (S < 7) return;
    // the pieces, standing up off the board
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const pc = c.pieces, hw = Math.max(0.6, 0.017 * S);
    for (let k = 0; k < pc.length; k += 4) {
      const u = -0.19 + (pc[k] + 0.5) * 0.0475, w = -0.19 + (pc[k + 1] + 0.5) * 0.0475;
      // (the board's frame: canvas y is the ground direction a quarter turn clockwise of the bench)
      const x = bx + u * c.ca + w * c.sa, y = by + u * c.sa - w * c.ca, h = pc[k + 3] ? 0.075 : 0.05;
      P(x, y, 0.47);
      ctx.fillStyle = pc[k + 2] ? "#2b2b30" : "#f7f4ec";
      ctx.fillRect(Q[0] - hw, Q[1] - h * PK, hw * 2, h * PK);
      ell(ctx, Q[0], Q[1] - h * PK, hw * 1.1, hw * 1.1); ctx.fill();
    }
    void u0;
  }
  function book(ctx, c) {
    const u = -0.35 * c.side;
    // open, face down: two covers sloping from the spine to the seat
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const hv = 0.08, sp = 0.52, edge = 0.465;
    ctx.fillStyle = "#f1ead8";
    ctx.beginPath(); L(c, u - 0.12, -hv, edge); ctx.moveTo(Q[0], Q[1]); L(c, u + 0.12, -hv, edge); ctx.lineTo(Q[0], Q[1]); L(c, u + 0.12, hv, edge); ctx.lineTo(Q[0], Q[1]); L(c, u - 0.12, hv, edge); ctx.lineTo(Q[0], Q[1]); ctx.fill();
    for (const s of SIDES) {
      ctx.fillStyle = s * (PA * c.ca + PB * c.sa) < 0 ? c.col : shadeHex(c.col, 0.8);
      ctx.beginPath(); L(c, u, -hv, sp); ctx.moveTo(Q[0], Q[1]); L(c, u, hv, sp); ctx.lineTo(Q[0], Q[1]);
      L(c, u + s * 0.115, hv, edge + 0.008); ctx.lineTo(Q[0], Q[1]); L(c, u + s * 0.115, -hv, edge + 0.008); ctx.lineTo(Q[0], Q[1]); ctx.fill();
    }
    if (S >= 14) {
      ctx.strokeStyle = "#f4f1ea"; ctx.lineWidth = Math.max(0.6, 0.02 * S);
      ctx.beginPath(); L(c, u, -hv * 0.6, sp + 0.002); ctx.moveTo(Q[0], Q[1]); L(c, u, -hv * 0.1, sp + 0.002); ctx.lineTo(Q[0], Q[1]); ctx.stroke();
    }
  }

  // ---- pumpkins on a porch step
  function drawPumpkins(ctx, c) {
    box(ctx, c, 0.1, 0, 0.3, 0.55, 0, 0.16, "#d8d0c0", "#c2b9a8", "#a9a090");
    const facing = c.ca * D0 + c.sa * D1 < 0;   // they face the street: is that toward us?
    const list = c.two ? PUMPKINS_TWO : PUMPKIN_ONE;
    // farther first
    let first = 0;
    if (list.length > 1) {
      const d0 = (c.x - list[0][1] * c.sa) * D0 + (c.y + list[0][1] * c.ca) * D1, d1 = (c.x - list[1][1] * c.sa) * D0 + (c.y + list[1][1] * c.ca) * D1;
      if (d1 > d0) first = 1;
    }
    for (let q = 0; q < list.length; q++) {
      const [u, v, r] = list[(first + q) % list.length];
      L(c, u, v, 0.16);
      pumpkin(ctx, Q[0], Q[1], r, c, facing && c.carved && r > 0.2);
    }
  }
  function pumpkin(ctx, px, py, r, c, face) {
    const rx = Math.max(1.5, r * S), ry = rx * (c.soft ? 0.66 : 0.78), cy = py - ry * 0.95;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = shadeHex(c.col, 0.78); ell(ctx, px, cy, rx, ry); ctx.fill();
    ctx.fillStyle = c.col; ell(ctx, px - rx * 0.07, cy - ry * 0.05, rx * 0.86, ry * 0.9); ctx.fill();
    if (rx >= 3) {
      ctx.strokeStyle = shadeHex(c.col, 0.7); ctx.lineWidth = Math.max(0.5, rx * 0.06); ctx.globalAlpha = 0.6;
      ell(ctx, px, cy, rx * 0.45, ry * 0.97); ctx.stroke(); ell(ctx, px, cy, rx * 0.12, ry * 0.98); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = "#6b6b3a"; ctx.lineWidth = Math.max(0.8, rx * 0.13);
    ctx.beginPath(); ctx.moveTo(px, cy - ry * 0.85); ctx.quadraticCurveTo(px + rx * 0.05, cy - ry * 1.3, px + rx * 0.22, cy - ry * 1.35); ctx.stroke();
    if (face && rx >= 4) {
      ctx.fillStyle = "#5a2a10";
      tri(ctx, px - rx * 0.42, cy - ry * 0.05, px - rx * 0.18, cy - ry * 0.05, px - rx * 0.3, cy - ry * 0.4, "#5a2a10");
      tri(ctx, px + rx * 0.42, cy - ry * 0.05, px + rx * 0.18, cy - ry * 0.05, px + rx * 0.3, cy - ry * 0.4, "#5a2a10");
      ctx.beginPath();
      ctx.moveTo(px - rx * 0.5, cy + ry * 0.2); ctx.quadraticCurveTo(px, cy + ry * 0.75, px + rx * 0.5, cy + ry * 0.2);
      ctx.lineTo(px + rx * 0.25, cy + ry * 0.35); ctx.lineTo(px + rx * 0.1, cy + ry * 0.22); ctx.lineTo(px - rx * 0.1, cy + ry * 0.36); ctx.lineTo(px - rx * 0.28, cy + ry * 0.24);
      ctx.fill();
    }
  }

  // ---- one sock
  function drawSock(ctx, c) {
    shadow(ctx, c.x, c.y, 0, 0.16, 0.1, c.ca, c.sa, 0.16);
    hframe(ctx, c.x, c.y, 0.012, c.ca, c.sa);
    const k = Math.max(1.3, 3.5 / (0.28 * S));
    ctx.scale(k, k);
    ctx.fillStyle = c.col;
    ctx.beginPath();
    ctx.moveTo(-0.14, -0.045); ctx.lineTo(0.06, -0.045); ctx.quadraticCurveTo(0.09, -0.045, 0.09, -0.01); ctx.lineTo(0.09, 0.1);
    ctx.quadraticCurveTo(0.09, 0.14, 0.045, 0.14); ctx.quadraticCurveTo(0.0, 0.14, 0.0, 0.1); ctx.lineTo(0.0, 0.045); ctx.lineTo(-0.14, 0.045);
    ctx.fill();
    ctx.fillStyle = c.col2;
    ctx.fillRect(-0.14, -0.045, 0.03, 0.09); ctx.fillRect(-0.09, -0.045, 0.025, 0.09);
    ctx.beginPath(); ctx.moveTo(0.0, 0.1); ctx.quadraticCurveTo(0.0, 0.14, 0.045, 0.14); ctx.quadraticCurveTo(0.09, 0.14, 0.09, 0.1); ctx.fill();
  }

  // ---- a lamp post wearing a knitted hat
  function drawBeanie(ctx, c) {
    P(c.x, c.y, 5.82);
    bframe(ctx, Q[0], Q[1]);
    ctx.fillStyle = c.col;
    ctx.beginPath(); ctx.moveTo(-0.27, 0); ctx.bezierCurveTo(-0.3, -0.44, 0.3, -0.44, 0.27, 0); ctx.fill();
    if (S >= 6) {
      ctx.save(); ctx.clip();
      ctx.fillStyle = c.col2; ctx.fillRect(-0.3, -0.24, 0.6, 0.06);
      ctx.fillStyle = "rgba(20,20,30,.2)"; ctx.fillRect(0.06, -0.4, 0.3, 0.4);
      ctx.restore();
    }
    ctx.fillStyle = shadeHex(c.col, 0.82); ctx.fillRect(-0.29, -0.1, 0.58, 0.11);
    if (S >= 12) {
      ctx.strokeStyle = "rgba(20,20,30,.2)"; ctx.lineWidth = lw(0.012, 0.4);
      ctx.beginPath(); for (let q = -4; q <= 4; q++) { ctx.moveTo(q * 0.06, -0.1); ctx.lineTo(q * 0.06, 0.01); } ctx.stroke();
    }
    ctx.fillStyle = c.col2; ell(ctx, 0, -0.38, 0.09, 0.09 * IC); ctx.fill();
    ctx.fillStyle = "rgba(20,20,30,.15)"; ell(ctx, 0.03, -0.37, 0.06, 0.07 * IC); ctx.fill();
  }

  // ---- a snowman
  function drawSnowman(ctx, c) {
    shadow(ctx, c.x, c.y, 0, 0.5, 0.42, 1, 0, 0.18);
    P(c.x, c.y, 0);
    const gx = Q[0], gy = Q[1];
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const balls = SNOWBALLS;
    for (const [z, r] of balls) {
      const y = gy - z * PK, R = Math.max(1.2, r * S);
      ctx.fillStyle = "#cfd8e3"; ell(ctx, gx, y, R, R); ctx.fill();
      ctx.fillStyle = c.col; ell(ctx, gx - R * 0.09, y - R * 0.08, R * 0.9, R * 0.9); ctx.fill();
    }
    const hy = gy - 1.3 * PK, hr = Math.max(1.2, 0.2 * S), my = gy - 0.86 * PK, mr = 0.28 * S;
    if (S >= 4) {
      // stick arms
      ctx.strokeStyle = "#6b4a33"; ctx.lineWidth = Math.max(0.7, 0.03 * S);
      ctx.beginPath();
      for (const s of SIDES) {
        ctx.moveTo(gx + s * mr * 0.85, my - mr * 0.1); ctx.lineTo(gx + s * mr * 2.1, my - mr * 0.9);
        ctx.moveTo(gx + s * mr * 1.7, my - mr * 0.62); ctx.lineTo(gx + s * mr * 1.95, my - mr * 1.15);
      }
      ctx.stroke();
      // scarf
      ctx.fillStyle = c.scarf;
      ctx.beginPath(); ctx.ellipse(gx, hy + hr * 0.85, hr * 0.95, hr * 0.3, 0, 0, TAU); ctx.fill();
      ctx.fillRect(gx + hr * 0.25, hy + hr * 0.9, hr * 0.35, hr * 1.1);
      // eyes, nose, smile, buttons
      ctx.fillStyle = "#2a2622";
      const er = Math.max(0.5, hr * 0.09);
      ell(ctx, gx - hr * 0.35, hy - hr * 0.2, er, er); ctx.fill(); ell(ctx, gx + hr * 0.25, hy - hr * 0.2, er, er); ctx.fill();
      for (let q = 0; q < 4; q++) { const a = 0.5 + q * 0.6; ell(ctx, gx - hr * 0.05 + Math.cos(a) * hr * 0.45, hy + Math.sin(a) * hr * 0.4, er * 0.7, er * 0.7); ctx.fill(); }
      for (let q = 0; q < 3; q++) { ell(ctx, gx - mr * 0.05, my - mr * 0.45 + q * mr * 0.45, er * 1.1, er * 1.1); ctx.fill(); }
      tri(ctx, gx - hr * 0.05, hy - hr * 0.08, gx - hr * 0.05, hy + hr * 0.12, gx + c.nose * hr * 0.75, hy + hr * 0.05, "#ec8a2f");
      if (c.hat) {
        ctx.fillStyle = "#2b2b30";
        ctx.fillRect(gx - hr * 0.85, hy - hr * 0.95, hr * 1.7, hr * 0.18);
        ctx.fillRect(gx - hr * 0.55, hy - hr * 1.7, hr * 1.1, hr * 0.8);
        ctx.fillStyle = "#b3202a"; ctx.fillRect(gx - hr * 0.55, hy - hr * 1.08, hr * 1.1, hr * 0.14);
      }
    }
  }

  // ---- a raked pile of leaves, the rake left leaning on it
  function drawLeaves(ctx, c) {
    shadow(ctx, c.x, c.y, 0, 0.85, 0.6, c.ca, c.sa, 0.16);
    P(c.x, c.y, 0);
    const gx = Q[0], gy = Q[1];
    bframe(ctx, gx, gy);
    const brown = C.season === "late-autumn" || C.season === "winter";
    if (c.rake < 0) rake(ctx, c);
    ctx.fillStyle = brown ? "#9a6337" : "#b8692f";
    ctx.beginPath(); ctx.moveTo(-0.72, 0.02); ctx.bezierCurveTo(-0.6, -0.62, 0.6, -0.62, 0.72, 0.02); ctx.fill();
    if (S >= 4) {
      const Lv = c.leaves;
      for (let k = 0; k < Lv.length; k += 3) {
        const pal = (Lv[k + 2] * LEAVES.length) | 0;
        ctx.fillStyle = brown && pal % 2 ? "#a0683a" : LEAVES[pal];
        ell(ctx, Lv[k], Lv[k + 1], 0.055, 0.04 * IC, Lv[k + 2] * 6); ctx.fill();
      }
    }
    ctx.fillStyle = "rgba(40,24,10,.16)";
    ctx.beginPath(); ctx.moveTo(0.1, -0.46); ctx.bezierCurveTo(0.5, -0.4, 0.66, -0.2, 0.72, 0.02); ctx.lineTo(0.2, 0.02); ctx.fill();
    if (c.rake > 0) rake(ctx, c);
  }
  function rake(ctx, c) {
    const s = c.rake;
    ctx.strokeStyle = "#b08850"; ctx.lineWidth = lw(0.035, 0.7);
    ctx.beginPath(); ctx.moveTo(s * 0.95, 0); ctx.lineTo(s * 0.25, -1.35); ctx.stroke();
    ctx.fillStyle = "#4f7a55";
    ctx.beginPath(); ctx.moveTo(s * 0.95, 0); ctx.lineTo(s * 1.18, 0.03); ctx.lineTo(s * 1.0, -0.2); ctx.lineTo(s * 0.72, 0.03); ctx.fill();
  }

  // ---- a traffic cone, off duty
  function drawCone(ctx, c) {
    shadow(ctx, c.x, c.y, 0, 0.3, 0.3, c.ca, c.sa, 0.18);
    hframe(ctx, c.x, c.y, 0.01, c.ca, c.sa);
    ctx.fillStyle = "#3a3c40"; ctx.fillRect(-0.19, -0.19, 0.38, 0.38);
    P(c.x, c.y, 0.03);
    if (c.tipped) {
      // knocked over: on its side
      sframe(ctx, Q[0], Q[1] - 0.12 * PK, c.R < 0.5 ? 1.35 : -1.35);
    } else bframe(ctx, Q[0], Q[1]);
    ctx.fillStyle = "#ea7a33";
    ctx.beginPath(); ctx.moveTo(-0.16, 0); ctx.lineTo(-0.03, -0.7); ctx.lineTo(0.03, -0.7); ctx.lineTo(0.16, 0); ctx.fill();
    ctx.fillStyle = "#c95f24";
    ctx.beginPath(); ctx.moveTo(0.03, 0); ctx.lineTo(0.012, -0.7); ctx.lineTo(0.03, -0.7); ctx.lineTo(0.16, 0); ctx.fill();
    ctx.fillStyle = "#f4f1ea";
    ctx.beginPath(); ctx.moveTo(-0.098, -0.3); ctx.lineTo(-0.075, -0.42); ctx.lineTo(0.075, -0.42); ctx.lineTo(0.098, -0.3); ctx.fill();
  }

  // ================================================================================================ cards
  const pick = (arr, r) => arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];
  function textOf(c) {
    const r = c.R, r2 = hash01(c.seed, 21), r3 = hash01(c.seed, 33);
    const wind = C.wind, cold = C.temp <= 40;
    switch (c.kind) {
      case "frisbee": {
        const n = c.items.length - 1, balls = c.items.filter((it) => it.t === 1).length;
        const extra = n ? ` Also up here: ${[balls ? `${balls} tennis ball${balls > 1 ? "s" : ""}` : "", c.items.some((it) => it.t === 2) ? "a second frisbee" : "", c.items.some((it) => it.t === 3) ? "an old football" : ""].filter(Boolean).join(", ")}, origin unknown.` : "";
        return {
          title: "Frisbee, rooftop", sub: c.bname ? `On the roof of ${c.bname}` : "On a rooftop",
          story: pick(["Thrown during a very confident pickup game. The thrower is still describing it as “basically a perfect throw”.",
            "It has been up here long enough to have opinions about the pigeons.",
            "Everyone saw exactly where it went. Nobody has a ladder."], r) + extra,
          status: pick(["legend", "unretrievable", "enjoying the view"], r2),
        };
      }
      case "kite":
        return {
          title: "Kite, in a tree", sub: c.where,
          story: pick(["It flew beautifully for eleven seconds.", "The tree has been told it isn't a kite tree. The tree disagrees.",
            "Its string still points hopefully at the sky."], r) + (wind >= 12 ? " Today's wind is giving it ideas." : wind < 4 ? " Not much wind today to help it escape." : ""),
          status: wind >= 12 ? "practising flying in place" : pick(["tangled", "waiting for a stronger wind", "part of the tree now"], r2),
        };
      case "chalk": {
        const kinds = c.art.map((a) => a[0]);
        const hop = kinds.includes("hop"), hi = kinds.includes("hi");
        return {
          title: hop ? "Hopscotch" : hi ? "Chalk: “hi”" : "Chalk drawings", sub: c.where,
          story: hop ? pick(["Eight squares and a home. The 7 is a little wobbly.", "Drawn in one go, without lifting the chalk. Mostly."], r)
            : hi ? pick(["Just “hi”. To everyone. Including you.", "Someone stopped on their way to class to say hi in chalk. That's it. That's the whole story."], r)
              : pick(["Someone with a box of chalk and a free afternoon.", "Drawn in five colours, one of which has nearly run out.", "A little gallery, open until the next rain."], r),
          status: "on display until it rains",
        };
      }
      case "umbrella":
        return {
          title: "Forgotten umbrella", sub: c.where,
          story: C.rained ? pick(["It did its job in the rain and was promptly abandoned. Typical.", "Left open to dry. Then just left."], r)
            : pick(["Brought along just in case. The case did not come.", "Somebody is going to need this the next time it rains, and will not have it."], r),
          status: pick(["drying off", "waiting for its person", "between jobs"], r2),
        };
      case "bike": {
        const what = { bread: "a baguette, slightly squashed", flowers: "a bunch of flowers", book: "a library book", pumpkin: "a small pumpkin", empty: "nothing at all, which is somehow worse" }[c.basket];
        return {
          title: "Bicycle with a basket", sub: c.where,
          story: `${pick(["Leaning on the lamp post as if it owns the place.", "Parked with great confidence and no lock in sight.", "Its rider popped in somewhere “for one minute”."], r)} The basket holds ${what}.`,
          status: pick(["parked, sort of", "patiently waiting", "leaning"], r2),
        };
      }
      case "hammock":
        return {
          title: "Hammock", sub: c.where,
          story: c.napper ? pick(["Occupied. A book is open over someone's face. Studying, technically.", "Someone is reading in here, with their eyes closed, very slowly."], r)
            : pick(["Strung between two trees that seem fine with it.", "Free for anyone with half an hour and nowhere to be."], r),
          status: c.napper ? "do not disturb" : "swaying",
        };
      case "picnic":
        return {
          title: "Picnic blanket", sub: c.where,
          story: pick(["Gingham, a basket, and one apple with a single bite out of it. Its people went to get drinks.",
            "Someone brought sandwiches for four and invited three.", "Laid out with care. The ants were not invited, but they RSVPed anyway."], r),
          status: "back in five minutes",
        };
      case "mitten":
        return {
          title: "A single mitten", sub: c.where,
          story: pick(["Put on the post by a kind stranger, so its owner can spot it on the way back.", "Its other half is somewhere warm, missing it.",
            "Hand-knitted, by someone who will definitely ask about it."], r) + (cold ? " It's a cold one to lose a mitten on." : ""),
          status: "waiting to be found",
        };
      case "plane":
        return {
          title: "Paper airplane", sub: c.where,
          story: pick(["Folded from a lecture handout. It got further than anyone expected.", "Its flight lasted four seconds and was, by all accounts, magnificent.",
            "It has a name written on one wing: “Gerald”."], r),
          status: pick(["landed", "awaiting its next flight", "grounded"], r2),
        };
      case "duck":
        return {
          title: c.n > 1 ? "Rubber ducks" : "Rubber duck", sub: c.where || "On the water",
          story: C.frozen ? "Frozen in place for now. It doesn't seem to mind: it's waiting for spring."
            : c.n > 1 ? pick(["A big rubber duck and two small ones, out for a very slow lap.", "Single file, perfectly in line. Nobody is quite sure who's in charge."], r)
              : pick(["Has been here since about an hour ago, which for a rubber duck is a lifetime.", "Patrolling the water. All is well.", "Drifting wherever the breeze suggests. A philosophy, really."], r),
          status: C.frozen ? "on ice" : pick(["afloat", "on duty", "unsinkable"], r2),
        };
      case "balloon":
        return {
          title: "Balloon, caught on a lamp post", sub: c.where,
          story: c.heart ? "A heart-shaped balloon that got away. It made it as far as here and decided this was far enough."
            : pick(["Escaped from a party, made it this far, and decided this was far enough.", "It said “Happy Birthday” before the wind turned it round.",
              "Tied on by its string by somebody tall, or by the wind. Nobody's saying which."], r),
          status: pick(["bobbing", "still festive", "staying put"], r2),
        };
      case "chess":
        return {
          title: "Chess game, mid-play", sub: c.where,
          story: pick(["White to move. White went to get coffee.", "Both players agreed to a short break forty minutes ago.",
            "Someone has moved a knight in a way knights do not move. Nobody has said anything."], r),
          status: "adjourned",
        };
      case "book":
        return {
          title: "Library book, on a bench", sub: c.where,
          story: pick(["Left face down at chapter seven, which is where it starts to get good.", "Not overdue. Yet.",
            "Its bookmark is a receipt for one coffee and one muffin."], r),
          status: pick(["due back soon", "mid-chapter", "waiting for its reader"], r2),
        };
      case "pumpkin":
        return {
          title: c.carved ? "Jack-o'-lantern" : "Pumpkin on a porch step", sub: c.where,
          story: C.month === 10 && C.dom < 31 ? (c.carved ? "Carved a little early. Practising its face." : "Picked out with care. Not yet carved, still deciding on a face.")
            : C.month === 10 ? "It's Halloween. This is its big night."
              : c.soft ? "A little softer than it was in October. Still smiling, mostly." : "Halloween is over. Nobody has told the pumpkin.",
          status: c.soft ? "past its best, proud of it" : "seasonal",
        };
      case "sock":
        return {
          title: "One sock", sub: c.where,
          story: pick(["The other one is presumably in a dryer somewhere, living its best life.", "How do you lose one sock outdoors? Nobody knows. It happens anyway."], r),
          status: "unpaired",
        };
      case "beanie":
        return {
          title: "Lamp post, wearing a hat", sub: c.where,
          story: pick(["Someone thought this lamp post looked cold. It does look warmer.", "A knitted hat with a pompom, pulled down snug over the lantern."], r) + (cold ? " Sensible, in this weather." : ""),
          status: "toasty",
        };
      case "snowman":
        return {
          title: "Snowman", sub: c.where,
          story: pick(["Built with great care and one slightly lopsided head.", "Pebble smile, twig arms. Will be here until it isn't.",
            "The work of at least three people and one very strong opinion about the nose."], r),
          status: C.temp > 34 ? "melting, slowly and with dignity" : "holding up well",
        };
      case "leaves":
        return {
          title: "Leaf pile", sub: c.where,
          story: pick(["Raked into a neat pile. The rake is still here. The raker, not.", "Somebody has already jumped in it once. Probably twice.",
            "Carefully raked, deeply tempting."], r) + (wind >= 12 ? " The wind is undoing it, one leaf at a time." : ""),
          status: "irresistible",
        };
      case "cone":
        return {
          title: "Traffic cone, on a lawn", sub: c.where,
          story: pick(["Nothing to direct out here. It seems at peace.", "How it got here is a mystery that will outlast us all.",
            "Off duty, and enjoying the grass."], r) + (c.tipped ? " It has tipped over for a rest." : ""),
          status: "off duty",
        };
    }
    void r3;
    return { title: "Curio", sub: c.where, story: "", status: "" };
  }
  function openCard(c) {
    const ui = app.ui;
    if (!ui || !ui.card) return;
    const T = textOf(c);
    const el = document.createElement("div");
    el.className = "curios-card";
    const p = document.createElement("p");
    p.className = "curios-story"; p.textContent = T.story;
    el.append(p);
    if (T.status) {
      const s = document.createElement("p"), b = document.createElement("span");
      s.className = "curios-status"; b.textContent = "Status";
      s.append(b, document.createTextNode(T.status));
      el.append(s);
    }
    const foot = document.createElement("p");
    foot.className = "curios-foot"; foot.textContent = "A curio: made up, just for fun. New ones turn up every day.";
    el.append(foot);
    ui.card({ id: "curio", title: T.title, subtitle: T.sub || "", color: /^#[0-9a-f]{6}$/i.test(c.col || "") ? c.col : null, body: el, anchor: anchorOf(c) });
  }
  function anchorOf(c) {
    if (c.kind === "kite") { const o = geo.ROTS[view.rot]; return { x: c.x + o.R[0] * c.odx, y: c.y + o.R[1] * c.odx, z: c.zc - c.ody / COS_T }; }
    if (c.kind === "balloon") return { x: c.x, y: c.y, z: 6.5 };
    return { x: c.x, y: c.y, z: c.zc };
  }
  function cue(c) {
    try { if (app.sound && app.sound.cue) app.sound.cue(c.K.sound, { x: c.x, y: c.y }); } catch (e) { /* the sound is a nicety */ }
  }
  function injectStyle() {
    if (document.getElementById("curios-style")) return;
    const st = document.createElement("style");
    st.id = "curios-style";
    st.textContent = `
      .curios-card { font: 13px/1.5 "Inter", system-ui, sans-serif; }
      .curios-story { margin: 2px 0 8px; font: italic 15px/1.45 "Fraunces", Georgia, serif; color: var(--ink, #2a2622); }
      .curios-status { margin: 0; display: flex; gap: 8px; align-items: baseline; }
      .curios-status span { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--mute, #7a7064); }
      .curios-foot { margin: 9px 0 0; font-size: 11px; color: var(--mute, #7a7064); }
    `;
    document.head.append(st);
  }
  injectStyle();

  // ================================================================================================ wiring
  app.addLayer({
    id: "curios", z: 40,
    fps: () => want,
    draw: (ctx, f) => { try { draw(ctx, f); } catch (e) { failed = true; publish(0); throw e; } },
    hit(px, py) {
      if (!vis.length || S < MIN_S) return null;
      setCamera();
      const pad = app.mobile ? 16 : 10;
      let best = null, bd = Infinity;
      for (const c of vis) {
        if (!c.vis) continue;
        const a = anchorOf(c);
        P(a.x, a.y, a.z);
        const x = Q[0], y = Q[1];
        const r = Math.max(pad, Math.min(c.rw, 1.2) * S * 0.8), d = (px - x) ** 2 + (py - y) ** 2;
        if (d < r * r && d < bd) { bd = d; best = c; }
      }
      return best;
    },
    onClick(c) { openCard(c); cue(c); },
  });
  app.on("rotate", () => { for (const c of curios) { c.occR = -1; c.occ = null; c.hidR = -1; } });
  app.on("style", () => { for (const c of curios) { c.occR = -1; c.hidR = -1; } setTimeout(check, 0); });
  app.on("weather", () => setTimeout(check, 0));
  // the first set once the map is up (placing them reads the map data: a few tens of ms), then a look now and then
  let started = false;
  const start = () => { if (started) return; started = true; try { build(); } catch (e) { failed = true; console.error("curios:", e); } };
  const soon = () => (window.requestIdleCallback || ((fn) => setTimeout(fn, 300)))(start, { timeout: 1500 });
  if (app.status && app.status.loaded) soon();
  else app.on("ready", soon);
  setTimeout(start, 5000);
  setInterval(() => { if (started && !failed && !document.hidden) check(); }, 20000);

  // for tests: what's out today, and where (lat/lon, and the anchor in ground metres), and a card opened from here
  app.curios = {
    get count() { return curios.length; },
    list() {
      return curios.map((c) => { const [lat, lon] = geo.toLatLon(c.x, c.y), a = anchorOf(c); return { kind: c.kind, lat: +lat.toFixed(6), lon: +lon.toFixed(6), where: c.where, x: a.x, y: a.y, z: a.z }; });
    },
    open(kind) { const c = curios.find((q) => q.kind === kind); if (c) openCard(c); return !!c; },
    conditions: C,
  };
  Object.defineProperty(app.curios, "conditions", { enumerable: false });
}

// ------------------------------------------------------------------------------------------------ chalk sets
// each a few pieces: [kind, across, along (metres, in the drawing's frame), turn]
const ART_SETS = [
  [["hop", 0, 0, -Math.PI / 2]],
  [["sun", -0.75, 0, 0], ["hi", 0.55, 0.05, 0]],
  [["flower", -0.7, 0, 0.1], ["heart", 0.05, 0.15, 0], ["star", 0.7, -0.2, 0.3]],
  [["rainbow", 0, 0.1, 0], ["heart", 0.95, 0.35, -0.2]],
  [["hi", -0.25, 0, 0], ["heart", 0.55, 0.05, 0.15]],
  [["sun", -0.55, -0.1, 0], ["flower", 0.5, 0.05, -0.1]],
  [["smile", -0.5, 0, 0], ["star", 0.35, -0.25, 0], ["star", 0.7, 0.2, 0.5]],
];

// ------------------------------------------------------------------------------------------------ helpers
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function segDist(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / L, 0, 1) : 0;
  return Math.hypot(x - ax - dx * t, y - ay - dy * t);
}
// distance from (x, y) to the nearest edge of any ring
function ringsEdge(rings, x, y) {
  let best = Infinity;
  for (const f of rings) for (let k = 0, n = f.length; k < n; k += 2) {
    const k2 = (k + 2) % n, d = segDist(x, y, f[k], f[k + 1], f[k2], f[k2 + 1]);
    if (d < best) best = d;
  }
  return best;
}
function shadeHex(hex, f) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${Math.round(r * f)},${Math.round(g * f)},${Math.round(b * f)})`;
}
function hashInt(a, b) {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}
const hash01 = (a, b) => hashInt(a, b) / 4294967296;
// a small seeded generator (mulberry32): a slot's draws repeat for the same day
function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
