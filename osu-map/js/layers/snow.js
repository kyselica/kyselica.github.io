// Snow days: when snow lies on the ground, the lawns come alive.
//
// None of this is live data. With snow on the ground (the tiles' snow cover, app.tileStyle.snow, or the measured depth,
// app.weather.snowDepthM) the lawns and quads get snowmen of every size (two or three balls, coal eyes and buttons, a
// carrot, stick arms, a scarf, some a hat; leaning, slumping and melting once it's above freezing), snow angels, trails
// of footprints, the green stripes where the balls were rolled up, and trampled patches with snow forts; small groups
// have snowball fights (arcing throws, ducking, puffs where they land), and on the banks of the river and the ponds (the
// only slopes we can be sure of without elevation data) people sled down to the water's edge and trudge back up.
// Elsewhere someone pulls a sled across a lawn along their own footprints.
//
// Everything is placed and scheduled from hashes of the place, the day and the hour: a snowman is built on a given day
// at a given hour and stays until the snow goes; a fight or a sledding run is on or off for each half hour or so; the
// same for everyone, and the same when a place comes back into view. Only the places near the view are simulated. After
// dark the people go home (a few stragglers stay out); the snowmen stay all night.
//
// Lawns are searched for room the first time one comes near the view (as sports.js does): a grid of 2 m cells less the
// paths, roads, fences, trees, lamps, buildings and other areas, and each cell's distance to the nearest of those.
// The water's edge is walked for lanes of clear ground running up from it (one per 60 m square at most).
//
// Drawing ("snowday", z 32: under the walkers and the night tint): the marks in the snow first (flat on the ground,
// batched), then snowmen, people, sleds, fort blocks, snowballs and puffs back to front. Whatever stands in front of
// them (a building, a tree, a lamp post) is left showing by clipping its outline out of the drawing, as life.js and
// sports.js do; from afar a figure behind a building is simply not drawn.
//
// Switches: the snow things follow "Real sky & weather" (layer "sky", since the snow cover is part of it); the people
// also need "People". ?snowday=1 forces it all (and the map's snow cover, unless ?snow= says otherwise).
import { pointIn } from "../core/scene.js";
import { SKIN, HAIR, localTime, curve, makeRecorder } from "./life.js";

// ------------------------------------------------------------------------------------------------ tables
const SIM_S = 1.6;      // scenes are simulated from this scale (CSS px per metre) up…
const MIN_S = 2;        // …snowmen and people drawn from here…
const MARK_S = 2.6;     // …marks in the snow from here…
const PRINT_S = 6;      // …single footprints (a trodden line below this) from here…
const DETAIL_S = 10;    // …faces, arms, scarves and cut-outs round what stands in front from here
const FADE = 0.9;       // seconds: a scene starting or ending in plain view fades in or out
const GROUND_MIN = 0.3; // snow cover (tile snow, or depth / 5 cm) that makes a snow day
const OVAL = [39.9995, -83.0148];
const LAWN_KINDS = new Set(["grass", "park", "meadow"]);
// areas a scene can stand on; any other area on a lawn (a flower bed, a plaza, a pond, a court) is in the way
const OPEN = new Set(["grass", "park", "meadow", "campus", "res", "com", "rel", "ind"]);
const MIN_LAWN = 1200;  // m²
const MIN_WATER = 1500; // m²
const BG = 60;          // m: at most one sledding lane per square this size
// people out in the snow through the day (local hours); a snow day is a holiday, weekday or not
const ACT = [[0, 0.03], [6.5, 0.03], [8, 0.2], [9.5, 0.5], [11, 0.8], [13, 0.92], [15, 1], [16.5, 0.92], [18, 0.55], [19.5, 0.25], [21, 0.1], [24, 0.03]];

// kinds of place
const SNOWMAN = 1, ANGEL = 2, TRAIL = 3, FIGHT = 4, SLED = 5;
// poses
const STAND = 0, SCOOP = 2, PACK = 3, WIND = 4, THROW = 5, DUCK = 6, HIT = 7, SIT = 8, PULL = 9, LIE = 10, CHEER = 11;
// things drawn back to front
const I_SNOWMAN = 1, I_PERSON = 2, I_SLED = 3, I_BALL = 4, I_PUFF = 5, I_BLOCK = 6;
// snowmen's hats
const H_NONE = 0, H_TOP = 1, H_BEANIE = 2, H_CAP = 3, H_CONE = 4, H_POT = 5;

// what they wear
const COATS = ["#b3202a", "#b3202a", "#2f3e5c", "#3f7f86", "#7b2d3a", "#d4a838", "#5f6b4a", "#6d6e71", "#2f3036", "#c75b39", "#4d6a8f", "#7a5d8f", "#e6e0d2", "#8a4f3a"];
const PANTS = ["#2b2b30", "#34445e", "#3b3f48", "#4a4d55", "#1f2226", "#5b4a3e"];
const KNITS = ["#b3202a", "#e6e0d2", "#d4a838", "#3f7f86", "#d98a9a", "#4f7a55", "#7a5d8f", "#c75b39", "#6d6e71", "#2f3e5c", "#f2efe8"];
const SCARVES = ["#b3202a", "#d4a838", "#3f7f86", "#d98a9a", "#f2efe8", "#4f7a55", "#7a5d8f", "#c75b39", "#8fb3d3", "#6d6e71"];
const SCARF_NAMES = ["scarlet", "mustard", "teal", "pink", "cream", "green", "plum", "rust", "sky-blue", "grey"];
// sleds: [kind, colour, name]
const SLEDS = [["toboggan", "#c8372d", "a red toboggan"], ["toboggan", "#3d6fb0", "a blue toboggan"], ["toboggan", "#3f8a5a", "a green toboggan"],
  ["saucer", "#d4562a", "an orange saucer"], ["saucer", "#3d6fb0", "a blue saucer"], ["saucer", "#b9bec4", "a silver saucer"],
  ["wooden", "#a8753f", "a wooden sled"], ["tray", "#c9a46a", "a dining-hall tray (origin unclear)"]];
// the snow and what's in it
const SNOW_LIT = "#fdfdfb", SNOW_SHADE = "#c8d2de", SNOW_RIM = "rgba(104,122,156,.5)", SHADOW = "rgba(70,86,118,.22)";
const COAL = "#29282b", CARROT = "#e07a2c", STICK = "#6e4c2f";
const PRINT_COL = "rgba(112,132,170,.3)", TROD_COL = "rgba(112,132,170,.17)", ANGEL_COL = "rgba(104,124,164,.3)", ANGEL_DEEP = "rgba(104,124,164,.1)";
const ROLL_COL = "rgba(122,138,98,.36)", TRAMPLE_COL = "rgba(118,136,172,.055)", GROOVE_COL = "rgba(104,124,164,.34)";

const SNOWMAN_NAMES = ["Gerald", "Sir Reginald Slush", "Flurry", "Mr. Carrots", "Dr. Snowbody", "Coach Chill", "Lumpy", "Professor Flake", "Stanley",
  "Agnes", "Baron von Brrr", "Marshmallow", "Big Steve", "Penelope", "Slushie", "Biscuit", "Kevin", "Dame Drift", "Captain Sleet", "Mildred", "Chad (frozen)", "Lord Puddleton"];
const TEAM_NAMES = ["Mittens", "Icicles", "Slushies", "Snow Owls", "Frostbites", "Polar Bears", "Penguins", "Snowplows", "Yetis", "Hot Cocoas",
  "Earmuffs", "Wet Socks", "Sleet Team", "Snow Days", "Igloos", "Cold Noses", "Avalanche", "Flurries"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ------------------------------------------------------------------------------------------------ the module
export function init(app) {
  const { data, geo, view } = app;
  if (!data || !data.areas || !data.world || !geo) return;
  const renderer = app.renderer;
  const { SIN_T, COS_T } = geo;
  const world = data.world;
  const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");
  // ?snowday=1: snow-day scenes whatever the weather (and the map's snow cover with them, unless ?snow= is given)
  const FORCE = /^(1|true|yes|on|all)$/i.test((app.params.get("snowday") || "").trim());
  const [ovalX, ovalY] = geo.toXY(OVAL[0], OVAL[1]);
  const whimsy = (app.whimsy = app.whimsy || {});
  whimsy.snowday = 0;
  if (FORCE && !app.params.has("snow") && !((app.tileStyle && app.tileStyle.snow) >= GROUND_MIN)) app.setTileStyle({ snow: 0.8 });

  // ---------------------------------------------------------------- per-frame camera (CSS px from ground metres)
  // px = PA·x + PB·y + PE,  py = PC·x + PD·y + PF − PK·z  (as life.js)
  let PA = 0, PB = 0, PC = 0, PD = 0, PE = 0, PF = 0, PK = 0, VW = 1, VH = 1, SCALE = 1, ROT = 0, D0 = 0, D1 = 0;
  const CAM = { k: 1, lod: 1, ox: 0, oy: 0 };
  function setCamera() {
    const o = geo.ROTS[view.rot], s = view.s;
    ROT = view.rot; SCALE = s; VW = view.w; VH = view.h;
    D0 = o.D[0]; D1 = o.D[1];
    PA = s * o.R[0]; PB = s * o.R[1]; PC = -s * SIN_T * D0; PD = -s * SIN_T * D1;
    PE = VW / 2 - view.X * s; PF = VH / 2 - view.Y * s; PK = s * COS_T;
    CAM.k = s; CAM.ox = -PE; CAM.oy = -PF;
    CAM.lod = app.tiles && app.tiles.levelFor ? Math.pow(2, app.tiles.levelFor(view)) : s * view.dpr;
  }
  function onView(x, y, rad, margin) {
    const px = PA * x + PB * y + PE, py = PC * x + PD * y + PF, m = margin + rad * SCALE;
    return px > -m && px < VW + m && py > -m - 4 * PK && py < VH + m;
  }
  const SX = (x, y) => PA * x + PB * y + PE;
  const SY = (x, y, z) => PC * x + PD * y + PF - PK * z;
  const depth = (x, y) => x * D0 + y * D1;

  // ---------------------------------------------------------------- spatial grids (ground metres)
  const GC = 40, GX = Math.ceil((world.x1 - world.x0) / GC) + 1, GY = Math.ceil((world.y1 - world.y0) / GC) + 1;
  const cellOf = (x, y) => {
    const i = Math.floor((x - world.x0) / GC), j = Math.floor((y - world.y0) / GC);
    return i < 0 || j < 0 || i >= GX || j >= GY ? -1 : j * GX + i;
  };
  function gridAdd(grid, id, x0, y0, x1, y1) {
    const i0 = Math.max(0, Math.floor((x0 - world.x0) / GC)), i1 = Math.min(GX - 1, Math.floor((x1 - world.x0) / GC));
    const j0 = Math.max(0, Math.floor((y0 - world.y0) / GC)), j1 = Math.min(GY - 1, Math.floor((y1 - world.y0) / GC));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) (grid[j * GX + i] ||= []).push(id);
  }
  const inRings = (rings, x, y) => { let n = false; for (const f of rings) if (pointIn(f, x, y)) n = !n; return n; };

  // what stands or lies on a lawn and is in the way, in grids (built the first time it's needed)
  let OBS = null;
  function obstacles() {
    if (OBS) return OBS;
    const segs = [], sGrid = new Array(GX * GY);
    const addLine = (pts, reach) => {
      for (let k = 0; k + 3 < pts.length; k += 2) {
        const id = segs.length / 5, ax = pts[k], ay = pts[k + 1], bx = pts[k + 2], by = pts[k + 3];
        segs.push(ax, ay, bx, by, reach);
        gridAdd(sGrid, id, Math.min(ax, bx) - reach, Math.min(ay, by) - reach, Math.max(ax, bx) + reach, Math.max(ay, by) + reach);
      }
    };
    for (const p of data.paths || []) if (!p.tn) addLine(p.pts, (p.w || 2) / 2 + 1.2);
    for (const r of data.roads || []) if (!r.tn) addLine(r.pts, (r.w || 6) / 2 + 2);
    for (const b of data.barriers || []) addLine(b.pts, 0.9);
    const tr = data.trees, tGrid = new Array(GX * GY);
    for (let t = 0; t < tr.length / 5; t++) { const x = tr[5 * t], y = tr[5 * t + 1], r = tr[5 * t + 2] + 0.6; gridAdd(tGrid, t, x - r, y - r, x + r, y + r); }
    const la = data.lamps, lGrid = new Array(GX * GY);
    for (let l = 0; l < la.length / 2; l++) gridAdd(lGrid, l, la[2 * l] - 1, la[2 * l + 1] - 1, la[2 * l] + 1, la[2 * l + 1] + 1);
    const bGrid = new Array(GX * GY), bBox = new Float32Array(data.buildings.length * 4);
    data.buildings.forEach((b, i) => { const bb = ringBox(b.p[0]); bBox.set(bb, 4 * i); gridAdd(bGrid, i, bb[0], bb[1], bb[2], bb[3]); });
    const aGrid = new Array(GX * GY), aBox = new Float32Array(data.areas.length * 4);
    data.areas.forEach((a, i) => {
      if (OPEN.has(a.k)) return;
      const bb = ringBox(a.p[0]);
      aBox.set(bb, 4 * i);
      gridAdd(aGrid, i, bb[0], bb[1], bb[2], bb[3]);
    });
    return (OBS = { segs: Float32Array.from(segs), sGrid, tGrid, lGrid, bGrid, bBox, aGrid, aBox });
  }
  function blockedAt(x, y, self) {
    const O = OBS, c = cellOf(x, y);
    if (c < 0) return true;
    let L = O.sGrid[c];
    if (L) for (const id of L) { const S = O.segs, o = id * 5; if (segDist(x, y, S[o], S[o + 1], S[o + 2], S[o + 3]) < S[o + 4]) return true; }
    L = O.tGrid[c];
    if (L) for (const t of L) { const tr = data.trees; if (Math.hypot(x - tr[5 * t], y - tr[5 * t + 1]) < tr[5 * t + 2] + 0.6) return true; }
    L = O.lGrid[c];
    if (L) for (const l of L) if (Math.hypot(x - data.lamps[2 * l], y - data.lamps[2 * l + 1]) < 1) return true;
    L = O.bGrid[c];
    if (L) for (const i of L) if (x >= O.bBox[4 * i] && x <= O.bBox[4 * i + 2] && y >= O.bBox[4 * i + 1] && y <= O.bBox[4 * i + 3] && app.scene.contains(i, x, y)) return true;
    L = O.aGrid[c];
    if (L) for (const i of L) {
      if (i === self || x < O.aBox[4 * i] || x > O.aBox[4 * i + 2] || y < O.aBox[4 * i + 1] || y > O.aBox[4 * i + 3]) continue;
      if (inRings(data.areas[i].p, x, y)) return true;
    }
    return false;
  }

  // ================================================================================================ places
  const lawns = [], lawnGrid = new Array(GX * GY);
  data.areas.forEach((a, i) => {
    if (!LAWN_KINDS.has(a.k) || !a.p || !a.p[0]) return;
    const A = ringArea(a.p[0]);
    if (A < MIN_LAWN) return;
    const bb = ringBox(a.p[0]);
    if (bb[2] < world.x0 || bb[0] > world.x1 || bb[3] < world.y0 || bb[1] > world.y1) return;
    const L = { id: lawns.length, area: i, A, box: bb, cx: (bb[0] + bb[2]) / 2, cy: (bb[1] + bb[3]) / 2, rad: Math.hypot(bb[2] - bb[0], bb[3] - bb[1]) / 2, done: false, name: a.n || "" };
    lawns.push(L);
    gridAdd(lawnGrid, L.id, bb[0], bb[1], bb[2], bb[3]);
  });
  // lawns overlap (a park round its own lawns): a spot belongs to the largest lawn it lies in, whichever is searched first
  function ownedByOther(L, x, y) {
    const c = cellOf(x, y), list = c < 0 ? null : lawnGrid[c];
    if (!list) return false;
    for (const id of list) {
      const M = lawns[id];
      if (M === L || M.A < L.A || (M.A === L.A && M.area > L.area)) continue;
      if (x < M.box[0] || x > M.box[2] || y < M.box[1] || y > M.box[3]) continue;
      if (inRings(data.areas[M.area].p, x, y)) return true;
    }
    return false;
  }
  // what to call a place
  const olentangy = (data.waterways || []).filter((w) => /olentangy/i.test(w.n || ""));
  function waterName(a) {
    if (a.n) return a.n;
    for (const w of olentangy) for (let k = 0; k < w.pts.length; k += 8) if (inRings(a.p, w.pts[k], w.pts[k + 1])) return "the Olentangy River";
    return "";
  }
  const banks = [];
  data.areas.forEach((a, i) => {
    if (a.k !== "water" || !a.p || !a.p[0]) return;
    const A = ringArea(a.p[0]);
    if (A < MIN_WATER) return;
    banks.push({ area: i, A, name: waterName(a) });
  });

  // ---------------------------------------------------------------- the places found so far
  const sites = [];
  function makeSite(type, x, y, ang, extra) {
    const seed = hashInt((Math.round(x * 4) * 73856093) ^ (Math.round(y * 4) * 19349663), type * 977 + 13);
    const d2 = (x - ovalX) ** 2 + (y - ovalY) ** 2;
    const S = {
      type, x, y, ang, ca: Math.cos(ang), sa: Math.sin(ang), seed, cx: x, cy: y, rad: 2, name: "",
      central: 0.35 + 0.65 * Math.exp(-d2 / (1300 * 1300)), kids: 0.12,
      slotMin: 25 + 30 * hash01(seed, 1), off: 0, p: 0, scene: null, seen: false,
      built: null, builtKey: "", occR: -1, occ: null, hidR: -1, hid: false, melt: 0, sx: 0, sy: 0,
    };
    S.off = hash01(seed, 2) * S.slotMin;
    // the neighbourhood parks have more children in them than the quads
    S.kids = 0.08 + 0.5 * (1 - S.central);
    if (extra) Object.assign(S, extra);
    sites.push(S);
    return S;
  }
  const gxL = (S, u, v) => S.x + u * S.ca - v * S.sa, gyL = (S, u, v) => S.y + u * S.sa + v * S.ca;

  // ---------------------------------------------------------------- searching a lawn
  // The lawn and what lies on it are rasterised into its grid (scanline fills of the lawn, of the areas and buildings on
  // it; discs and capsules for trees, lamps, paths, roads and fences): a few ms even for the Oval.
  const CS = 2;
  const XS = [];
  function fillRings(rings, x0, y0, nx, ny, D, val) {
    let ry0 = Infinity, ry1 = -Infinity;
    for (const f of rings) for (let k = 1; k < f.length; k += 2) { if (f[k] < ry0) ry0 = f[k]; if (f[k] > ry1) ry1 = f[k]; }
    const j0 = Math.max(0, Math.floor((ry0 - y0) / CS - 0.5)), j1 = Math.min(ny - 1, Math.ceil((ry1 - y0) / CS - 0.5));
    for (let j = j0; j <= j1; j++) {
      const y = y0 + (j + 0.5) * CS;
      XS.length = 0;
      for (const f of rings) {
        for (let i = 0, n = f.length, q = n - 2; i < n; q = i, i += 2) {
          const ya = f[q + 1], yb = f[i + 1];
          if (ya > y !== yb > y) XS.push(f[q] + ((y - ya) * (f[i] - f[q])) / (yb - ya));
        }
      }
      if (XS.length < 2) continue;
      XS.sort((a, b) => a - b);
      for (let k = 0; k + 1 < XS.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((XS[k] - x0) / CS - 0.5)), i1 = Math.min(nx - 1, Math.floor((XS[k + 1] - x0) / CS - 0.5));
        for (let i = i0; i <= i1; i++) D[j * nx + i] = val;
      }
    }
  }
  function capsule(D, x0, y0, nx, ny, ax, ay, bx, by, r) {
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - x0) / CS)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx) + r - x0) / CS));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - r - y0) / CS)), j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by) + r - y0) / CS));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * nx + i;
      if (D[k] && segDist(x0 + (i + 0.5) * CS, y0 + (j + 0.5) * CS, ax, ay, bx, by) < r) D[k] = 0;
    }
  }
  let stampN = 0, sStamp = null, tStamp = null, lStamp = null, bStamp = null, aStamp = null;
  function searchLawn(L) {
    L.done = true;
    const O = obstacles(), a = data.areas[L.area];
    const [x0, y0, x1, y1] = L.box;
    const nx = Math.max(1, Math.ceil((x1 - x0) / CS)), ny = Math.max(1, Math.ceil((y1 - y0) / CS));
    if (nx * ny > 250000) return;
    const D = new Float32Array(nx * ny);
    fillRings(a.p, x0, y0, nx, ny, D, 1e6);
    if (!sStamp) { sStamp = new Int32Array(O.segs.length / 5); tStamp = new Int32Array(data.trees.length / 5); lStamp = new Int32Array(data.lamps.length / 2); bStamp = new Int32Array(data.buildings.length); aStamp = new Int32Array(data.areas.length); }
    const st = ++stampN, S = O.segs, tr = data.trees, la = data.lamps;
    const i0 = Math.max(0, Math.floor((x0 - world.x0) / GC)), i1 = Math.min(GX - 1, Math.floor((x1 - world.x0) / GC));
    const j0 = Math.max(0, Math.floor((y0 - world.y0) / GC)), j1 = Math.min(GY - 1, Math.floor((y1 - world.y0) / GC));
    for (let gj = j0; gj <= j1; gj++) for (let gi = i0; gi <= i1; gi++) {
      const c = gj * GX + gi;
      let Lc = O.aGrid[c];
      if (Lc) for (const i of Lc) { if (i === L.area || aStamp[i] === st) continue; aStamp[i] = st; fillRings(data.areas[i].p, x0, y0, nx, ny, D, 0); }
      Lc = O.bGrid[c];
      if (Lc) for (const i of Lc) { if (bStamp[i] === st) continue; bStamp[i] = st; fillRings(data.buildings[i].p, x0, y0, nx, ny, D, 0); }
      Lc = O.sGrid[c];
      if (Lc) for (const id of Lc) { if (sStamp[id] === st) continue; sStamp[id] = st; const o = 5 * id; capsule(D, x0, y0, nx, ny, S[o], S[o + 1], S[o + 2], S[o + 3], S[o + 4]); }
      Lc = O.tGrid[c];
      if (Lc) for (const t of Lc) { if (tStamp[t] === st) continue; tStamp[t] = st; const x = tr[5 * t], y = tr[5 * t + 1]; capsule(D, x0, y0, nx, ny, x, y, x, y, tr[5 * t + 2] + 0.6); }
      Lc = O.lGrid[c];
      if (Lc) for (const l of Lc) { if (lStamp[l] === st) continue; lStamp[l] = st; capsule(D, x0, y0, nx, ny, la[2 * l], la[2 * l + 1], la[2 * l], la[2 * l + 1], 1); }
    }
    let open = 0;
    for (let k = 0; k < D.length; k++) if (D[k]) open++;
    if (!open) return;
    chamfer(D, nx, ny);
    for (let k = 0; k < D.length; k++) D[k] = D[k] > 0 ? (D[k] - 0.5) * CS : 0;   // metres of room round each cell's centre
    pickLawnSites(L, D, nx, ny, x0, y0, open);
  }

  function pickLawnSites(L, D, nx, ny, x0, y0, open) {
    const R = rng(hashInt(L.area, 0x5a0d)), openM2 = open * CS * CS, name = L.name;
    const made = [], trailsAt = [];
    const cx = (k) => x0 + ((k % nx) + 0.5) * CS, cy = (k) => y0 + (Math.floor(k / nx) + 0.5) * CS;
    const room = (x, y) => { const i = Math.floor((x - x0) / CS), j = Math.floor((y - y0) / CS); return i < 0 || j < 0 || i >= nx || j >= ny ? 0 : D[j * nx + i]; };
    const clear = (x, y, r) => { for (const m of made) if (Math.hypot(x - m[0], y - m[1]) < r + m[2]) return false; return true; };
    const mine = (x, y) => !ownedByOther(L, x, y);

    // snowball fights: the roomiest spots, with a clear line between the two sides
    const nF = openM2 < 2600 ? 0 : Math.min(2, 1 + Math.floor(openM2 / 25000));
    if (nF) {
      const cand = [];
      for (let k = 0; k < D.length; k++) if (D[k] >= 4.4) cand.push(k);
      cand.sort((p, q) => D[q] - D[p] || p - q);
      let nf = 0;
      for (const k of cand) {
        if (nf >= nF) break;
        const x = cx(k), y = cy(k);
        if (!clear(x, y, 14) || !mine(x, y)) continue;
        let bestH = 0, bestA = 0;
        for (let q = 0; q < 12; q++) {
          const ang = (q * Math.PI) / 12, ux = Math.cos(ang), uy = Math.sin(ang);
          let h = 0;
          for (let hh = 1; hh <= 8; hh++) {
            if (room(x + hh * ux, y + hh * uy) < (hh >= 4 ? 2.6 : 2) || room(x - hh * ux, y - hh * uy) < (hh >= 4 ? 2.6 : 2)) break;
            h = hh;
          }
          if (h > bestH) { bestH = h; bestA = ang; }
        }
        if (bestH < 5) continue;
        const hl = Math.min(bestH, 7.5) - 1.7, hw = Math.min(D[k], 6);
        const S = makeSite(FIGHT, x, y, bestA, { hl, hw, rad: hl + 3.2, name, forts: R() < 0.6 && hw >= 3.4 });
        fightMarks(S, R);
        made.push([x, y, hl + 4]);
        nf++;
      }
    }
    // snowmen: anywhere with a little room, a few metres apart
    const nS = openM2 < 500 ? 0 : clamp(Math.round(openM2 / 1900), 1, 10);
    for (let tries = 0, ns = 0; ns < nS && tries < 400; tries++) {
      const k = (R() * D.length) | 0;
      if (D[k] < 1.7) continue;
      const x = cx(k) + (R() - 0.5) * 1.4, y = cy(k) + (R() - 0.5) * 1.4;
      if (room(x, y) < 1.3 || !clear(x, y, 5) || !mine(x, y)) continue;
      makeSnowman(x, y, name, R, room);
      made.push([x, y, 2.5]);
      ns++;
    }
    // snow angels, one to three side by side
    const nA = openM2 < 1400 ? 0 : clamp(Math.round(openM2 / 5500), 1, 4);
    for (let tries = 0, na = 0; na < nA && tries < 300; tries++) {
      const k = (R() * D.length) | 0;
      if (D[k] < 2.6) continue;
      const x = cx(k), y = cy(k);
      if (!clear(x, y, 4) || !mine(x, y)) continue;
      makeAngels(x, y, name, R, room);
      made.push([x, y, 3]);
      na++;
    }
    // trails of footprints across the lawn, from near its edge as far as it stays clear
    const nT = openM2 < 1200 ? 0 : clamp(Math.round(openM2 / 3200), 1, 6);
    for (let tries = 0, nt = 0; nt < nT && tries < 300; tries++) {
      const k = (R() * D.length) | 0;
      if (D[k] < 0.9 || D[k] > 2.6) continue;
      const x = cx(k), y = cy(k);
      if (!mine(x, y) || trailsAt.some((t) => Math.hypot(x - t[0], y - t[1]) < 10)) continue;
      const a0 = R() * Math.PI * 2;
      let best = 0, bestA = 0;
      for (let q = 0; q < 16; q++) {
        const ang = a0 + (q * Math.PI) / 8, ux = Math.cos(ang), uy = Math.sin(ang);
        let d = 0;
        while (d < 70 && room(x + (d + 1) * ux, y + (d + 1) * uy) >= 0.75) d++;
        if (d > best) { best = d; bestA = ang; }
      }
      if (best < 14) continue;
      if (makeTrail(x, y, bestA, best, name, R, room)) { trailsAt.push([x, y]); nt++; }
    }
  }

  // a snowman: its build, its looks, the stripes where its balls were rolled and footprints round it
  function makeSnowman(x, y, name, R, room) {
    const big = R() < 0.06, small = !big && R() < 0.3;
    const r0 = big ? 0.62 + R() * 0.12 : small ? 0.2 + R() * 0.08 : 0.3 + R() * 0.17;
    const balls = R() < 0.78 ? 3 : 2;
    const hr = R(), hat = hr < 0.3 ? H_NONE : hr < 0.45 ? H_TOP : hr < 0.73 ? H_BEANIE : hr < 0.85 ? H_CAP : hr < 0.93 ? H_CONE : H_POT;
    const S = makeSite(SNOWMAN, x, y, R() * Math.PI * 2, {
      name, r0, balls, hat, hatCol: KNITS[(R() * KNITS.length) | 0], pom: R() < 0.6,
      scarf: R() < 0.82 ? (R() * SCARVES.length) | 0 : -1, stripe: R() < 0.35,
      arms: R() < 0.9, armUp: [0.2 + R() * 0.7, 0.2 + R() * 0.7], buttons: 2 + ((R() * 2) | 0), smile: R() < 0.75,
      lean: R() * Math.PI * 2, meltBias: R(), dropHead: R() < 0.5, nick: SNOWMAN_NAMES[(R() * SNOWMAN_NAMES.length) | 0],
      lines: [R(), R(), R(), R()],
    });
    // radii and heights (before any melting)
    const rr = balls === 3 ? [r0, r0 * 0.74, r0 * 0.54] : [r0, r0 * 0.62];
    S.rr = rr;
    S.zz = [r0 * 0.9];
    for (let b = 1; b < balls; b++) S.zz.push(S.zz[b - 1] + (rr[b - 1] + rr[b]) * 0.8);
    S.height = S.zz[balls - 1] + rr[balls - 1] + (hat === H_TOP ? 0.34 : hat === H_CONE ? 0.45 : hat ? 0.12 : 0);
    S.rad = 1.6 + r0;
    // the balls were rolled up from a few metres off: a stripe of bare lawn, widening as the ball grew
    S.rolls = [];
    for (let b = 0; b < balls; b++) {
      const ang = R() * Math.PI * 2, ux = Math.cos(ang), uy = Math.sin(ang), want = 2.5 + R() * 6 + rr[b] * 8;
      let d = 0.8;
      while (d < want && room(x + (d + 0.8) * ux, y + (d + 0.8) * uy) >= 0.9) d += 0.8;
      if (d < 2.4) continue;
      const n = Math.max(3, Math.round(d / 0.7)), A = 0.4 + R() * 0.8, lam = 2 + R() * 2.5, ph = R() * 6.28, out = new Float32Array(3 * (n + 1));
      for (let q = 0; q <= n; q++) {
        const t = q / n, along = d * (1 - t) + 0.4, wob = A * Math.sin(along / lam + ph) * Math.sin(Math.PI * Math.min(1, (1 - t) * 1.3));
        out[3 * q] = x + ux * along - uy * wob; out[3 * q + 1] = y + uy * along + ux * wob;
        out[3 * q + 2] = 0.1 + (rr[b] * 1.7 - 0.1) * t;   // width
      }
      S.rolls.push(out);
      S.rad = Math.max(S.rad, d + 1.5);
    }
    // footprints all round it
    const pr = [];
    const np = 10 + ((R() * 12) | 0);
    for (let q = 0; q < np; q++) {
      const a = R() * 6.28, d = r0 + 0.35 + R() * 1.6, px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
      if (room(px, py) < 0.3) continue;
      pr.push(px, py, R() * 6.28);
    }
    S.prints = Float32Array.from(pr);
    return S;
  }
  function makeAngels(x, y, name, R, room) {
    // lying along a compass axis: seen across a diagonal in every turn of the view, never edge-on
    const n = R() < 0.55 ? 1 : R() < 0.7 ? 2 : 3, ang = ((R() * 4) | 0) * Math.PI / 2 + (R() - 0.5) * 0.3, ca = Math.cos(ang), sa = Math.sin(ang);
    const out = [];
    for (let k = 0; k < n; k++) {
      const off = (k - (n - 1) / 2) * 2.05, ax = x - sa * off, ay = y + ca * off;
      if (room(ax, ay) < 1.3) continue;
      out.push(ax, ay, ang + (R() - 0.5) * 0.12);
    }
    if (!out.length) return null;
    const S = makeSite(ANGEL, x, y, ang, { name, angels: Float32Array.from(out), rad: 2.2 + n * 1.1, lines: [R(), R(), R()] });
    // footprints coming in from the feet end, and the jump out of each
    const pr = [];
    for (let k = 0; k < out.length; k += 3) {
      const ax = out[k], ay = out[k + 1], a = out[k + 2], fx = -Math.cos(a), fy = -Math.sin(a);
      const len = 3 + R() * 4, bend = (R() - 0.5) * 0.8;
      for (let d = 1.35, q = 0; d < len; d += 0.4, q++) {
        const side = q & 1 ? 1 : -1, b = bend * (d - 1.35);
        const px = ax + fx * d - fy * (side * 0.13 + b), py = ay + fy * d + fx * (side * 0.13 + b);
        if (room(px, py) < 0.3) break;
        pr.push(px, py, a + Math.PI + bend * 0.5);
      }
    }
    S.prints = Float32Array.from(pr);
    return S;
  }
  function makeTrail(x, y, ang, len, name, R, room) {
    const ux = Math.cos(ang), uy = Math.sin(ang), A = 0.3 + R() * 1.1, lam = 6 + R() * 9, ph = R() * 6.28;
    const n = Math.max(2, Math.ceil(len / 2.5)), pts = new Float32Array(2 * (n + 1));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let q = 0; q <= n; q++) {
      const d = (len * q) / n;
      let wob = A * Math.sin(d / lam + ph) * Math.sin((Math.PI * q) / n);
      let px = x + ux * d - uy * wob, py = y + uy * d + ux * wob;
      if (room(px, py) < 0.5) { wob = 0; px = x + ux * d; py = y + uy * d; }
      pts[2 * q] = px; pts[2 * q + 1] = py;
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
    }
    const cum = new Float32Array(n + 1);
    for (let q = 1; q <= n; q++) cum[q] = cum[q - 1] + Math.hypot(pts[2 * q] - pts[2 * q - 2], pts[2 * q + 1] - pts[2 * q - 1]);
    const S = makeSite(TRAIL, (x0 + x1) / 2, (y0 + y1) / 2, ang, { name, pts, cum, len: cum[n], rad: Math.hypot(x1 - x0, y1 - y0) / 2 + 1, lines: [R(), R(), R()] });
    // one walker's footprints (and, now and then, a second walker's alongside)
    const pr = [];
    const walkers = R() < 0.3 ? 2 : 1;
    for (let w = 0; w < walkers; w++) {
      const sh = w ? 0.45 + R() * 0.2 : 0, stepL = 0.38 + R() * 0.06;
      for (let d = 0.3 + R() * 0.3, q = 0; d < S.len - 0.3; d += stepL, q++) {
        alongPoly(S, d, P2);
        const side = q & 1 ? 1 : -1, nxp = -P2[3], nyp = P2[2], off = side * 0.13 + sh;
        pr.push(P2[0] + nxp * off, P2[1] + nyp * off, Math.atan2(P2[3], P2[2]) + (R() - 0.5) * 0.25);
      }
    }
    S.prints = Float32Array.from(pr);
    S.walkers = walkers;
    return S;
  }
  // a fight's trampled patch, its footprints, and perhaps a snow fort for each side
  function fightMarks(S, R) {
    const bl = [], pr = [];
    for (let q = 0; q < 14; q++) {
      const side = q < 10 ? (q & 1 ? 1 : -1) : 0, u = side ? side * (S.hl + 0.3 + (R() - 0.3) * 2.2) : (R() - 0.5) * 2 * S.hl, v = (R() - 0.5) * 2 * S.hw * 0.8;
      bl.push(gxL(S, u, v), gyL(S, u, v), 0.5 + R() * 0.9, 0.35 + R() * 0.6, R() * 3.14);
    }
    for (let q = 0; q < 80; q++) {
      const side = R() < 0.5 ? -1 : 1, u = side * (S.hl + R() * 2.2 - 0.4), v = (R() - 0.5) * 2 * S.hw * 0.8;
      pr.push(gxL(S, u, v), gyL(S, u, v), R() * 6.28);
    }
    S.blobs = Float32Array.from(bl);
    S.prints = Float32Array.from(pr);
    S.blocks = [];
    if (S.forts) {
      for (let t = 0; t < 2; t++) {
        const sg = t ? 1 : -1, nb = 3 + ((R() * 3) | 0), span = (nb - 1) * 0.62, bend = 0.25 + R() * 0.35, v0 = (R() - 0.5) * S.hw * 0.4;
        for (let b = 0; b < nb; b++) {
          const v = v0 - span / 2 + b * 0.62, u = sg * (S.hl - 0.9 + bend * ((v - v0) / Math.max(0.6, span / 2)) ** 2 * 0.5);
          S.blocks.push({ u, v, a: 0.21 + R() * 0.04, b: 0.29 + R() * 0.03, h: 0.4 + R() * 0.15, rot: (R() - 0.5) * 0.25 + (sg * bend * (v - v0)) / Math.max(1, span), team: t });
        }
        S["fortU" + t] = sg * (S.hl - 0.9);
        S["fortV" + t] = [v0 - span / 2 - 0.3, v0 + span / 2 + 0.3];
      }
    }
  }

  // ---------------------------------------------------------------- the water's edge: sledding lanes
  // Samples every 4 m along every water body's edge, in 60 m squares. A square's best lane (the longest clear run up
  // from the water, at least 8 m) is kept unless a neighbouring square's is better and within 40 m: so the answer for a
  // square doesn't depend on which squares were looked at first.
  const bankCells = new Map();
  let bankReady = false;
  const bankKey = (i, j) => i * 100003 + j;
  function bankSamples() {
    bankReady = true;
    for (const bk of banks) {
      const a = data.areas[bk.area];
      for (const f of a.p) {
        for (let k = 0, n = f.length / 2; k < n; k++) {
          const ax = f[2 * k], ay = f[2 * k + 1], bx = f[(2 * k + 2) % f.length], by = f[(2 * k + 3) % f.length];
          const len = Math.hypot(bx - ax, by - ay);
          if (len < 1) continue;
          const tx = (bx - ax) / len, ty = (by - ay) / len;
          // the normal pointing away from the water
          let nx = -ty, ny = tx;
          const mx = (ax + bx) / 2, my = (ay + by) / 2;
          if (inRings(a.p, mx + nx * 0.6, my + ny * 0.6)) { nx = -nx; ny = -ny; }
          for (let d = 2; d < len - 1; d += 4) {
            const x = ax + tx * d, y = ay + ty * d;
            if (x < world.x0 + 5 || x > world.x1 - 5 || y < world.y0 + 5 || y > world.y1 - 5) continue;
            const key = bankKey(Math.floor(x / BG), Math.floor(y / BG));
            let c = bankCells.get(key);
            if (!c) bankCells.set(key, (c = { i: Math.floor(x / BG), j: Math.floor(y / BG), samples: [], state: 0, cand: null }));
            c.samples.push({ x, y, nx, ny, bank: bk });
          }
        }
      }
    }
  }
  // how far up from the water a lane 2 m wide runs clear (0 if it isn't one)
  function laneLength(sm) {
    const { x, y, nx, ny } = sm;
    let clearD = 0;
    for (let d = 1.2; d <= 17.2; d += 1) {
      const qx = x + nx * d, qy = y + ny * d;
      if (blockedAt(qx, qy, -1) || blockedAt(qx - ny, qy + nx, -1) || blockedAt(qx + ny, qy - nx, -1)) break;
      clearD = d;
    }
    return clearD;
  }
  function evalBankCell(c) {
    obstacles();
    let best = null, bestScore = 0;
    for (const sm of c.samples) {
      const L = laneLength(sm);
      if (L < 8) continue;
      const score = L + hash01((Math.round(sm.x) * 92821) ^ Math.round(sm.y), 7) * 0.5;
      if (score > bestScore) { bestScore = score; best = sm; best.L = L; }
    }
    c.cand = best ? { sm: best, score: bestScore } : null;
    c.state = 1;
  }
  function finalBankCell(c) {
    c.state = 2;
    if (!c.cand) return;
    const me = c.cand.sm;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const o = bankCells.get(bankKey(c.i + di, c.j + dj));
      if (!o || !o.cand) continue;
      const sm = o.cand.sm;
      if (Math.hypot(sm.x - me.x, sm.y - me.y) < 40 && o.cand.score > c.cand.score) return;
    }
    const L = Math.min(me.L, 15) - 1.6, bx = me.x + me.nx * 1.6, by = me.y + me.ny * 1.6;
    makeSite(SLED, bx, by, Math.atan2(me.ny, me.nx), {
      L, rad: L / 2 + 2, cx: bx + me.nx * L / 2, cy: by + me.ny * L / 2, name: me.bank.name, kids: 0.35,
      lines: [hash01(c.i * 31 + c.j, 3), hash01(c.i * 31 + c.j, 4), hash01(c.i * 31 + c.j, 5)],
    });
  }
  // the squares round the view not yet looked at, within the time budget
  function searchBanks(until, M) {
    if (!bankReady) bankSamples();
    const ext = (Math.max(VW, VH) / 2 + M) / SCALE + 20;
    const g = view.screenToGround(VW / 2, VH / 2), gx = g[0], gy = g[1];
    const i0 = Math.floor((gx - ext) / BG), i1 = Math.floor((gx + ext) / BG), j0 = Math.floor((gy - ext) / BG), j1 = Math.floor((gy + ext) / BG);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const c = bankCells.get(bankKey(i, j));
      if (!c || c.state === 2) continue;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const o = bankCells.get(bankKey(i + di, j + dj));
        if (o && o.state === 0) { evalBankCell(o); if (performance.now() > until) return false; }
      }
      finalBankCell(c);
    }
    return true;
  }

  // ================================================================================================ conditions
  const C = { on: false, ground: 0, day: 1, act: 0, temp: 28, melt: 0, rain: 0, storm: false, dayNum: 0, hour: 12, people: true, sky: true, tMin: 0 };
  function readConditions() {
    const now = app.now(), t = localTime(now), W = app.weather || {}, st = app.tileStyle || {};
    C.sky = app.layerEnabled("sky");
    C.people = app.layerEnabled("people");
    C.ground = Math.min(1, Math.max(st.snow || 0, (W.snowDepthM || 0) / 0.05));
    C.on = C.sky && (FORCE || C.ground >= GROUND_MIN);
    const night = Number.isFinite(W.night) ? W.night : t.h < 7 || t.h > 17.5 ? 1 : 0;
    C.day = 1 - smooth(0.15, 0.6, night);
    C.act = curve(ACT, t.h);
    if (FORCE) C.act = Math.max(C.act, 0.8);
    // the reading (live or ?weather=) is for now: for another date (?time=), snow on the ground means a cold day
    const reading = Number.isFinite(W.tempF) && (W.source === "test" || (W.source === "live" && Math.abs(now.getTime() - Date.now()) < 3 * 3600e3));
    C.temp = reading ? W.tempF : 28;
    C.melt = smooth(33, 50, C.temp);
    C.rain = W.rain || 0; C.storm = !!W.storm;
    C.dayNum = dayNumber(now); C.hour = t.h;
    C.tMin = now.getTime() / 60000;
  }

  // ================================================================================================ schedules
  // When was this snowman (or angel) made? The latest of the last three days that hashes in, at an hour of daylight
  // that has already come; null if none.
  function builtOf(S) {
    const key = `${C.dayNum}|${Math.floor(C.hour * 4)}`;
    if (S.builtKey === key) return S.built;
    S.builtKey = key;
    S.built = null;
    const p = (S.type === SNOWMAN ? 0.26 + 0.3 * S.central : 0.3 + 0.2 * S.central) + (FORCE ? 0.25 : 0);
    for (let back = 0; back < 3; back++) {
      const d = C.dayNum - back;
      if (hash01(S.seed, d) >= p) continue;
      const hour = 9 + 8.5 * hash01(S.seed, d * 7 + 3);
      if (back === 0 && hour > C.hour) continue;
      S.built = { day: d, hour, back };
      break;
    }
    return S.built;
  }
  function shareOf(S) {
    if (!C.people) return 0;
    const base = S.type === FIGHT ? 0.5 : S.type === SLED ? 0.55 : 0.14;
    let p = base * (C.day * C.act + 0.05 * (1 - C.day)) * (0.45 + 0.55 * S.central);
    if (FORCE) p = Math.max(p, (S.type === TRAIL ? 0.45 : 0.95) * (C.day + 0.08 * (1 - C.day)));
    p *= C.storm ? 0 : Math.max(0, 1 - 2.5 * C.rain);
    return Math.min(0.97, p);
  }
  const slotOf = (S) => Math.floor((C.tMin + S.off) / S.slotMin);
  const wanted = (S) => S.p > 0 && hash01(S.seed, slotOf(S)) < S.p;
  const intoSlot = (S) => ((C.tMin + S.off) % S.slotMin + S.slotMin) % S.slotMin;

  // ================================================================================================ people
  function makePerson(R, kid) {
    const hat = R();
    return {
      u: 0, v: 0, tu: 0, tv: 0, homeU: 0, homeV: 0, fu: 1, fv: 0, x: 0, y: 0, hx: 1, hy: 0, run: 2, mv: 0, ph: R() * 6.28, z: 0,
      pose: STAND, poseT: 0, st: 0, stT: 0, team: 0, tgt: -1, duck: 0, kid: kid ? 0.72 : 1, lefty: R() < 0.12,
      coat: COATS[(R() * COATS.length) | 0], pants: PANTS[(R() * PANTS.length) | 0], knit: KNITS[(R() * KNITS.length) | 0],
      hat: hat < 0.1 ? 0 : hat < 0.55 ? 2 : hat < 0.78 ? 1 : 3,   // none, beanie, bobble hat, ear flaps
      scarf: R() < 0.72 ? SCARVES[(R() * SCARVES.length) | 0] : null, mitt: KNITS[(R() * KNITS.length) | 0],
      skin: SKIN[(R() * SKIN.length) | 0], hair: HAIR[(R() * HAIR.length) | 0],
      sled: null, hid: false, hidT: 0, vel: 0,
    };
  }
  function moveP(p, dt) {
    const du = p.tu - p.u, dv = p.tv - p.v, d = Math.hypot(du, dv);
    p.mv = 0;
    if (d > 0.03) {
      const st = Math.min(d, p.run * dt);
      p.u += (du / d) * st; p.v += (dv / d) * st; p.mv = st / dt;
      p.ph += st * (p.run > 2.4 ? 3.4 : 4.6);
    }
  }
  function faceP(p, fu, fv, dt) {
    const fl = Math.hypot(fu, fv);
    if (fl < 0.05) return;
    const k = Math.min(1, dt * 9);
    const nu = p.fu + (fu / fl - p.fu) * k, nv = p.fv + (fv / fl - p.fv) * k, n = Math.hypot(nu, nv);
    if (n > 1e-3) { p.fu = nu / n; p.fv = nv / n; }
  }
  // local (u, v) on site S → ground position and heading
  function placeP(S, p) {
    p.x = S.x + p.u * S.ca - p.v * S.sa; p.y = S.y + p.u * S.sa + p.v * S.ca;
    p.hx = p.fu * S.ca - p.fv * S.sa; p.hy = p.fu * S.sa + p.fv * S.ca;
  }

  // ---------------------------------------------------------------- snowball fights
  const F_SCOOP = 0, F_PACK = 1, F_AIM = 2, F_MOVE = 3;
  function newFight(S, slot) {
    const R = rng(hashInt(S.seed, slot)), night = C.day < 0.5;
    const g = { type: FIGHT, S, R, P: [], balls: [], t: 0, alpha: 1, fade: 0, dead: false, score: [0, 0], thrown: 0, dodges: 0,
      names: twoNames(R), cueT: 2 + R() * 4 };
    const nA = night ? 1 : 2 + ((R() * 3) | 0), nB = night ? 1 + (R() < 0.4 ? 1 : 0) : clamp(nA + ((R() * 3) | 0) - 1, 1, 4);
    for (let t = 0; t < 2; t++) {
      const n = t ? nB : nA, sg = t ? 1 : -1;
      for (let k = 0; k < n; k++) {
        const p = makePerson(R, R() < S.kids);
        p.team = t;
        p.homeU = sg * (S.hl + 0.2 + R() * 1.3);
        p.homeV = ((k + 0.5) / n - 0.5) * Math.min(S.hw * 1.5, 1.5 + n * 1.5) + (R() - 0.5) * 0.5;
        p.u = p.tu = p.homeU; p.v = p.tv = p.homeV; p.fu = -sg; p.fv = 0;
        p.st = R() < 0.6 ? F_SCOOP : F_MOVE; p.stT = R() * 1.6;
        g.P.push(p);
        placeP(S, p);
      }
    }
    // the score so far: about a hit a minute a side since it began
    const into = intoSlot(S);
    g.score[0] = Math.floor(into * (0.4 + R() * 0.8)); g.score[1] = Math.floor(into * (0.4 + R() * 0.8));
    g.thrown = Math.round((g.score[0] + g.score[1]) * (2.4 + R())); g.dodges = Math.round(g.thrown * (0.12 + R() * 0.1));
    return g;
  }
  function pickTarget(g, p) {
    const R = g.R, opp = [];
    for (let j = 0; j < g.P.length; j++) if (g.P[j].team !== p.team) opp.push(j);
    return opp.length ? opp[(R() * opp.length) | 0] : -1;
  }
  function stepFight(g, dt) {
    const S = g.S, R = g.R, P = g.P;
    for (let i = 0; i < P.length; i++) {
      const p = P[i], sg = p.team ? 1 : -1;
      if (p.poseT > 0) { p.poseT -= dt; if (p.poseT <= 0) p.pose = STAND; }
      if (p.duck > 0) { p.duck -= dt; p.pose = DUCK; if (p.duck <= 0) { p.pose = STAND; p.poseT = 0; } placeP(S, p); continue; }
      if (p.poseT > 0 && p.pose === HIT) { placeP(S, p); continue; }
      p.stT -= dt;
      switch (p.st) {
        case F_SCOOP:
          if (p.poseT <= 0) p.pose = SCOOP;
          if (p.stT <= 0) { p.st = F_PACK; p.stT = 0.35 + R() * 0.35; }
          break;
        case F_PACK:
          if (p.poseT <= 0) p.pose = PACK;
          if (p.stT <= 0) { p.tgt = pickTarget(g, p); if (p.tgt < 0) { p.st = F_MOVE; break; } p.st = F_AIM; p.stT = 0.3 + R() * 0.3; }
          break;
        case F_AIM:
          p.pose = WIND;
          if (p.stT <= 0) {
            throwBall(g, i, p.tgt);
            p.pose = THROW; p.poseT = 0.32;
            p.st = F_MOVE; p.stT = 0.4 + R() * 0.8;
            p.tu = clamp(p.homeU + (R() - 0.5) * 1.6, sg > 0 ? S.hl : -S.hl - 2, sg > 0 ? S.hl + 2 : -S.hl);
            p.tv = clamp(p.homeV + (R() - 0.5) * 2.2, -S.hw, S.hw);
            p.run = 1.4 + R() * 1.6;
          }
          break;
        default:
          if (p.stT <= 0 && Math.hypot(p.tu - p.u, p.tv - p.v) < 0.1) { p.st = F_SCOOP; p.stT = 0.7 + R() * 1.3; }
      }
      moveP(p, dt);
      // facing: the target while aiming, else the other side
      if (p.st === F_AIM && p.tgt >= 0) faceP(p, P[p.tgt].u - p.u, P[p.tgt].v - p.v, dt);
      else faceP(p, -sg, 0, dt);
      placeP(S, p);
    }
    // the snowballs
    for (let k = 0; k < g.balls.length; k++) {
      const b = g.balls[k];
      if (!b.on) continue;
      b.t += dt;
      const s = Math.min(1, b.t / b.T), pu = b.u;
      b.u = b.u0 + (b.u1 - b.u0) * s; b.v = b.v0 + (b.v1 - b.v0) * s; b.z = b.z0 * (1 - s) + 4 * b.h * s * (1 - s);
      const q = P[b.to];
      // the target sees it coming, and sometimes ducks
      if (!b.decided && q && (b.sa - s) * b.T < 0.42) {
        b.decided = true;
        if (q.st !== F_AIM && q.pose !== HIT && R() < 0.42) { q.duck = 0.7; q.pose = DUCK; }
      }
      // a snow fort in the way
      if (S.blocks.length) {
        const t = q ? q.team : 1 - P[b.from].team, fu = S["fortU" + t], fv = S["fortV" + t];
        if (fu != null && (pu - fu) * (b.u - fu) <= 0 && b.z < 0.58 && b.v > fv[0] && b.v < fv[1]) {
          b.on = false; puff(S, gxL(S, b.u, b.v), gyL(S, b.u, b.v), b.z, 1); continue;
        }
      }
      if (!b.checked && s >= b.sa && q) {
        b.checked = true;
        const top = (q.duck > 0 ? 0.92 : 1.7) * q.kid;
        if (Math.hypot(q.u - b.u, q.v - b.v) < 0.5 && b.z < top + 0.1 && b.z > 0.15) {
          b.on = false;
          q.pose = HIT; q.poseT = 0.6; q.duck = 0;
          const thrower = P[b.from];
          g.score[thrower.team]++;
          if (R() < 0.35 && thrower.pose !== WIND) { thrower.pose = CHEER; thrower.poseT = 0.7; }
          puff(S, gxL(S, b.u, b.v), gyL(S, b.u, b.v), b.z, 1.3);
          if (g.cueT <= 0 && b.vis) { cue("snowball", gxL(S, b.u, b.v), gyL(S, b.u, b.v), false); g.cueT = 5 + R() * 8; }
          continue;
        }
        if (q.duck > 0) g.dodges++;
      }
      if (s >= 1) { b.on = false; puff(S, gxL(S, b.u, b.v), gyL(S, b.u, b.v), 0, 0.8); }
    }
    g.cueT -= dt;
  }
  function throwBall(g, i, j) {
    const p = g.P[i], q = g.P[j], R = g.R;
    if (!q) return;
    let b = null;
    for (const o of g.balls) if (!o.on) { b = o; break; }
    if (!b) { if (g.balls.length >= 10) return; b = {}; g.balls.push(b); }
    const ax = p.u + p.fu * 0.3, ay = p.v + p.fv * 0.3, az = 1.75 * p.kid;
    // where they're aiming (where the target is, give or take), then on past it to the ground
    const tx = q.u + (R() - 0.5) * 1.2, ty = q.v + (R() - 0.5) * 1.2, dx = tx - ax, dy = ty - ay, d = Math.max(0.5, Math.hypot(dx, dy));
    const extra = 1.2 + R() * 2.4, u1 = tx + (dx / d) * extra, v1 = ty + (dy / d) * extra, Dt = d + extra, sa = d / Dt;
    const fort = g.S.blocks.length && g.S["fortU" + q.team] != null && R() < 0.3, za = fort ? 0.45 : 1.15 * q.kid;
    b.on = true; b.u0 = ax; b.v0 = ay; b.z0 = az; b.u1 = u1; b.v1 = v1; b.u = ax; b.v = ay; b.z = az;
    b.T = Dt / (8.5 + R() * 3.5); b.t = 0; b.sa = sa; b.from = i; b.to = j; b.checked = false; b.decided = false; b.vis = false;
    b.h = clamp((za - az * (1 - sa)) / (4 * sa * (1 - sa)), 0.3, 3);
    g.thrown++;
  }

  // ---------------------------------------------------------------- sledding: down to the water's edge, and back up
  const S_READY = 0, S_SLIDE = 1, S_STOP = 2, S_LIE = 3, S_UP = 4, S_CLIMB = 5, S_WALK = 6;
  function newSled(S, slot) {
    const R = rng(hashInt(S.seed, slot)), night = C.day < 0.5;
    const n = night ? 1 : 1 + ((R() * 3) | 0);
    const g = { type: SLED, S, R, P: [], t: 0, alpha: 1, fade: 0, dead: false, runs: 0, top: 0, cueT: 1 + R() * 4 };
    const into = intoSlot(S);
    g.runs = Math.floor(into * n * (0.5 + R() * 0.3));
    for (let k = 0; k < n; k++) {
      const p = makePerson(R, R() < S.kids), sk = SLEDS[(R() * SLEDS.length) | 0];
      p.sled = { kind: sk[0], col: sk[1], name: sk[2], u: 0, v: 0, fu: -1, x: 0, y: 0, hx: 0, hy: 0, rot: R() * 6.28 };
      // spread out round the cycle: some on their way up, one at the top
      const f = (k + R() * 0.5) / n;
      if (k === 0) { p.st = S_READY; p.stT = 0.5 + R() * 2; p.u = S.L; p.v = 0; }
      else { p.st = S_CLIMB; p.u = S.L * f; p.v = 1.1; }
      p.tu = p.u; p.tv = p.v; p.fu = p.st === S_CLIMB ? 1 : -1; p.fv = 0;
      g.P.push(p);
      sledPlace(S, p);
    }
    return g;
  }
  function stepSled(g, dt) {
    const S = g.S, R = g.R, L = S.L, ub = L * 0.36;
    for (const p of g.P) {
      const sl = p.sled;
      p.stT -= dt;
      switch (p.st) {
        case S_READY:
          p.pose = SIT; p.u = L; p.v = 0; p.fu = -1; p.fv = 0; p.mv = 0;
          if (p.stT <= 0) { p.st = S_SLIDE; p.vel = 0.4; }
          break;
        case S_SLIDE: {
          // faster down the slope, slowing on the flat by the water
          if (p.u > ub) p.vel += 2.1 * dt;
          else { const dec = (p.vel * p.vel) / (2 * Math.max(0.2, p.u - 0.15)) + 0.05; p.vel = Math.max(0, p.vel - dec * dt); }
          p.u -= p.vel * dt;
          if (p.vel > g.top) g.top = p.vel;
          if (p.vel <= 0.02 || p.u <= 0.15) {
            p.u = Math.max(0.15, p.u); p.vel = 0; g.runs++;
            if (R() < 0.25) { p.st = S_LIE; p.stT = 1.2 + R() * 0.8; p.pose = LIE; p.v += 0.7; }
            else { p.st = S_STOP; p.stT = 0.4 + R() * 0.6; }
            if (g.cueT <= 0 && p.vis) { cue("crunch", p.x, p.y, false); g.cueT = 8 + R() * 10; }
          }
          break;
        }
        case S_STOP: p.pose = SIT; if (p.stT <= 0) { p.st = S_UP; p.stT = 0.45; p.pose = STAND; } break;
        case S_LIE: p.pose = LIE; if (p.stT <= 0) { p.st = S_UP; p.stT = 0.5; p.pose = STAND; } break;
        case S_UP:
          p.pose = STAND;
          if (p.stT <= 0) { p.st = S_CLIMB; p.tu = p.u; p.tv = 1.1; p.run = 0.9; }
          break;
        case S_CLIMB:
          p.pose = PULL;
          p.tv = 1.1; p.tu = L - 0.3; p.run = 0.75 + (p.kid < 1 ? 0.15 : 0);
          moveP(p, dt);
          if (Math.abs(p.v - 1.1) > 0.05) faceP(p, p.tu - p.u, p.tv - p.v, dt); else faceP(p, 1, 0, dt);
          if (p.u >= L - 0.35) { p.st = S_WALK; p.stT = 1.1; p.w0 = [p.u, p.v, sl.u, sl.v, sl.fu, sl.fv]; }
          break;
        case S_WALK: {
          // at the top: bring the sled round to the start of the run, and sit down on it
          const t = smooth(0, 1, 1 - p.stT / 1.1), w0 = p.w0;
          p.pose = PULL;
          const pu = w0[0] + (L + 0.35 - w0[0]) * t, pv = w0[1] + (0.3 - w0[1]) * t;
          p.mv = Math.hypot(pu - p.u, pv - p.v) / Math.max(1e-3, dt); p.ph += p.mv * dt * 4.6;
          p.u = pu; p.v = pv;
          sl.u = w0[2] + (L - w0[2]) * t; sl.v = w0[3] + (0 - w0[3]) * t;
          const fu = w0[4] + (-1 - w0[4]) * t, fv = w0[5] * (1 - t) + 0.6 * Math.sin(Math.PI * t), fl = Math.hypot(fu, fv) || 1;
          sl.fu = fu / fl; sl.fv = fv / fl;
          faceP(p, sl.u - p.u, sl.v - p.v, dt);
          if (p.stT <= 0) { p.st = S_READY; p.stT = 0.8 + R() * 2.2; p.fu = -1; p.fv = 0; p.u = L; p.v = 0; }
          break;
        }
      }
      sledPlace(S, p);
    }
    g.cueT -= dt;
  }
  // the sled under someone sliding, or trailing behind on its rope
  function sledPlace(S, p) {
    const sl = p.sled;
    placeP(S, p);
    if (p.st === S_CLIMB) {
      // behind them, downhill, on a rope
      const bu = p.u - p.fu * 1.25, bv = p.v - p.fv * 1.25;
      sl.u += (bu - sl.u) * 0.5; sl.v += (bv - sl.v) * 0.5;
      const du = p.u - sl.u, dv = p.v - sl.v, d = Math.hypot(du, dv) || 1;
      sl.fu = du / d; sl.fv = dv / d;
    } else if (p.st === S_READY || p.st === S_SLIDE || p.st === S_STOP) { sl.u = p.u; sl.v = p.v; sl.fu = -1; sl.fv = 0; }
    // (lying in the snow, getting up, bringing it round at the top: it is moved by the step itself or stays put)
    sl.x = gxL(S, sl.u, sl.v); sl.y = gyL(S, sl.u, sl.v);
    sl.hx = sl.fu * S.ca - (sl.fv || 0) * S.sa; sl.hy = sl.fu * S.sa + (sl.fv || 0) * S.ca;
    if (p.st === S_LIE) { p.hx = sl.hy; p.hy = -sl.hx; }
  }

  // ---------------------------------------------------------------- someone pulling a sled along a trail
  function newPull(S, slot) {
    const R = rng(hashInt(S.seed, slot)), w = makePerson(R, false), sk = SLEDS[R() < 0.7 ? (R() * 3) | 0 : 6];
    w.sled = { kind: sk[0], col: sk[1], name: sk[2], u: 0, v: 0, fu: 1, fv: 0, x: 0, y: 0, hx: 1, hy: 0 };
    const g = { type: TRAIL, S, R, P: [w], t: 0, alpha: 1, fade: 0, dead: false, d: R() * S.len * 0.7, dir: R() < 0.5 ? 1 : -1, wait: 0, walkA: 1 };
    if (g.dir < 0) g.d = S.len - g.d;
    if (R() < 0.55) { const r = makePerson(R, true); r.pose = SIT; g.P.push(r); }
    stepPull(g, 0);
    return g;
  }
  const P2 = [0, 0, 1, 0];
  function alongPoly(S, d, out) {
    const pts = S.pts, cum = S.cum, n = cum.length - 1;
    d = clamp(d, 0, S.len);
    let q = 1;
    while (q < n && cum[q] < d) q++;
    const a = cum[q - 1], b = cum[q], t = b > a ? (d - a) / (b - a) : 0;
    const x0 = pts[2 * q - 2], y0 = pts[2 * q - 1], x1 = pts[2 * q], y1 = pts[2 * q + 1], l = Math.hypot(x1 - x0, y1 - y0) || 1;
    out[0] = x0 + (x1 - x0) * t; out[1] = y0 + (y1 - y0) * t; out[2] = (x1 - x0) / l; out[3] = (y1 - y0) / l;
    return out;
  }
  function stepPull(g, dt) {
    const S = g.S, w = g.P[0], sl = w.sled, R = g.R;
    if (g.wait > 0) {
      g.wait -= dt;
      if (g.wait <= 0) { g.dir = R() < 0.5 ? 1 : -1; g.d = g.dir > 0 ? 0.2 : S.len - 0.2; g.walkA = 0; }
    } else {
      g.d += g.dir * 1.05 * dt;
      g.walkA = Math.min(1, g.walkA + dt / 0.8);
      if (g.d > S.len - 0.2 || g.d < 0.2) { g.walkA = Math.max(0, g.walkA - dt / 0.4); if (g.walkA <= 0) g.wait = 3 + R() * 5; }
      w.ph += 1.05 * dt * 4.6; w.mv = 1.05;
    }
    alongPoly(S, g.d, P2);
    w.x = P2[0]; w.y = P2[1]; w.hx = P2[2] * g.dir; w.hy = P2[3] * g.dir; w.pose = PULL;
    alongPoly(S, g.d - g.dir * 1.45, P2);
    sl.x = P2[0]; sl.y = P2[1]; sl.hx = P2[2] * g.dir; sl.hy = P2[3] * g.dir;
    if (g.P[1]) { const r = g.P[1]; r.x = sl.x - sl.hx * 0.1; r.y = sl.y - sl.hy * 0.1; r.hx = sl.hx; r.hy = sl.hy; r.pose = SIT; }
  }

  // ---------------------------------------------------------------- puffs of snow where a ball lands
  const PUFF_N = 48, PUFF_LIFE = 0.5;
  const puffs = new Float32Array(PUFF_N * 5).fill(0), puffSite = new Array(PUFF_N).fill(null);
  for (let k = 0; k < PUFF_N; k++) puffs[5 * k + 3] = PUFF_LIFE;
  let puffNext = 0;
  function puff(S, x, y, z, size) {
    const k = puffNext; puffNext = (puffNext + 1) % PUFF_N;
    puffs[5 * k] = x; puffs[5 * k + 1] = y; puffs[5 * k + 2] = z; puffs[5 * k + 3] = 0; puffs[5 * k + 4] = size;
    puffSite[k] = S;
  }
  function stepPuffs(dt) {
    let alive = false;
    for (let k = 0; k < PUFF_N; k++) if (puffs[5 * k + 3] < PUFF_LIFE) { puffs[5 * k + 3] += dt; alive = true; }
    return alive;
  }

  // ================================================================================================ the population
  let near = [], failed = false, tickAt = -1e9, condAt = -1e9, again = 0;
  function manage(force) {
    const now = performance.now();
    if (!force && now - tickAt < 400) return;
    tickAt = now;
    setCamera();
    if (now - condAt > 3000) { readConditions(); condAt = now; }
    if (!C.on || SCALE < SIM_S) {
      if (near.length) { for (const S of near) { S.scene = null; S.seen = false; } near = []; app.requestRender("snowday"); }
      return;
    }
    const M = 0.3 * Math.max(VW, VH);
    // places near the view are searched the first time (a few ms a tick)
    const until = now + 10, had = sites.length;
    let busy = false;
    for (const L of lawns) {
      if (L.done || !onView(L.cx, L.cy, L.rad, M)) continue;
      if (performance.now() > until) { busy = true; break; }
      searchLawn(L);
    }
    if (!busy && !searchBanks(until, M)) busy = true;
    if (busy && !again) again = setTimeout(() => { again = 0; manage(true); }, 60);
    near = [];
    let changed = sites.length !== had;
    for (const S of sites) {
      if (!onView(S.cx, S.cy, S.rad, M)) {
        if (S.scene) { S.scene = null; changed = true; }
        S.seen = false;
        continue;
      }
      near.push(S);
      if (S.type === SNOWMAN || S.type === ANGEL) builtOf(S);
      if (S.type === SNOWMAN) S.melt = S.built ? clamp(C.melt * (0.55 + 0.9 * S.meltBias) + (C.melt > 0.05 ? 0.12 * S.built.back : 0), 0, 1) : 0;
      if (S.type === SNOWMAN || S.type === ANGEL || (S.type === TRAIL && S.len < 16)) continue;
      S.p = shareOf(S);
      const want = wanted(S), seen = SCALE >= MIN_S && onView(S.cx, S.cy, S.rad, 0);
      if (want && !S.scene) {
        const slot = slotOf(S);
        S.scene = S.type === FIGHT ? newFight(S, slot) : S.type === SLED ? newSled(S, slot) : newPull(S, slot);
        if (S.seen && seen && !reduceMQ.matches) { S.scene.alpha = 0; S.scene.fade = 1; }
        changed = true;
      } else if (!want && S.scene) {
        if (seen && !reduceMQ.matches) { if (S.scene.fade >= 0) { S.scene.fade = -1; changed = true; } }
        else { S.scene = null; changed = true; }
      } else if (want && S.scene && S.scene.fade < 0) S.scene.fade = 1;
      S.seen = seen;
    }
    if (changed) app.requestRender("snowday");
  }
  function stepAll(dt) {
    if (dt <= 0) return;
    const n = Math.max(1, Math.ceil(dt / 0.05 - 1e-6)), h = dt / n;
    for (const S of near) {
      const g = S.scene;
      if (!g) continue;
      for (let k = 0; k < n && !g.dead; k++) {
        g.t += h;
        if (g.fade) {
          g.alpha += (g.fade * h) / FADE;
          if (g.alpha >= 1) { g.alpha = 1; g.fade = 0; }
          else if (g.alpha <= 0) { g.alpha = 0; g.dead = true; break; }
        }
        if (g.type === FIGHT) stepFight(g, h); else if (g.type === SLED) stepSled(g, h); else stepPull(g, h);
      }
      if (g.dead) S.scene = null;
    }
    stepPuffs(dt);
  }
  function dropAll() { for (const S of sites) S.scene = null; near = []; }

  // ================================================================================================ drawing
  const items = [], order = [];
  let nItems = 0, want = 0, count = 0;
  function item(d, t, a, i) {
    let it = items[nItems];
    if (!it) items[nItems] = it = { d: 0, t: 0, a: null, i: 0 };
    it.d = d; it.t = t; it.a = a; it.i = i;
    nItems++;
    order.push(it);
  }
  const byDepth = (p, q) => q.d - p.d;
  // clickable things drawn this frame: CSS px, radius, the place
  const hits = [];
  let nHits = 0;
  function addHit(px, py, r, S) {
    let h = hits[nHits];
    if (!h) hits[nHits] = h = { px: 0, py: 0, r: 0, S: null };
    h.px = px; h.py = py; h.r = r; h.S = S;
    nHits++;
  }
  const visTrails = [];

  // The marks in the snow don't move: while the view is still they are drawn once into a canvas of the view's size and
  // copied (a fight animating at 24 fps then costs one copy, not every footprint and cut-out again).
  let mCan = null, mCtx = null, mKey = "";
  const marksList = [];
  function drawAllMarks(ctx, f, fadeS, sig) {
    const dpr = view.dpr, moving = f && f.moving;
    if (moving || !marksList.length) {
      mKey = "";
      for (const S of marksList) drawMarks(ctx, S, fadeS);
      return;
    }
    const W = Math.round(VW * dpr), H = Math.round(VH * dpr);
    const key = `${view.X}|${view.Y}|${SCALE}|${ROT}|${dpr}|${W}|${H}|${sig}|${app.tileStyle.season}`;
    if (key !== mKey) {
      if (!mCan) { mCan = document.createElement("canvas"); mCtx = mCan.getContext("2d"); }
      if (mCan.width !== W || mCan.height !== H) { mCan.width = W; mCan.height = H; }
      mCtx.setTransform(1, 0, 0, 1, 0, 0);
      mCtx.clearRect(0, 0, W, H);
      mCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      mCtx.lineCap = "round"; mCtx.lineJoin = "round";
      for (const S of marksList) drawMarks(mCtx, S, 1);
      mKey = key;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = fadeS;
    ctx.drawImage(mCan, 0, 0);
    ctx.restore();
  }

  function draw(ctx, f) {
    nItems = 0; order.length = 0; want = 0; nHits = 0; count = 0; visTrails.length = 0; marksList.length = 0;
    if (failed || !C.on || !sites.length) { publish(); return; }
    setCamera();
    const s = SCALE;
    if (s < MIN_S) { publish(); return; }
    const people = C.people, fadeS = Math.min(1, (s - MIN_S) / 0.6);
    let moving = false;
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    // 1. the marks in the snow, flat on the ground
    let sig = 0;
    for (const S of near) {
      if (!onView(S.cx, S.cy, S.rad, 4)) { S.vis = false; continue; }
      const exists = S.type === SNOWMAN || S.type === ANGEL ? !!S.built : S.type === TRAIL ? hash01(S.seed, C.dayNum) < 0.85 || !!S.scene : true;
      S.vis = exists;
      if (!exists) continue;
      if (S.type !== SLED || S.scene) count++;
      if (s >= MARK_S) { marksList.push(S); sig = (Math.imul(sig, 31) + S.seed + (S.type === SNOWMAN && S.melt > 0.35 ? Math.round(S.melt * 10) : 0)) | 0; }
    }
    drawAllMarks(ctx, f, fadeS, sig);
    // 2. what stands on it, back to front
    for (const S of near) {
      if (!S.vis || !onView(S.cx, S.cy, S.rad, 4)) continue;
      if (S.type === SNOWMAN) { item(depth(S.x, S.y), I_SNOWMAN, S, 0); addHit(SX(S.x, S.y), SY(S.x, S.y, S.height * 0.45), Math.max(10, S.height * 0.6 * PK), S); }
      else if (S.type === SLED && !(people && S.scene)) addHit(SX(S.cx, S.cy), SY(S.cx, S.cy, 0), Math.max(10, S.L * 0.25 * s), S);
      else if (S.type === FIGHT && S.blocks.length && !(people && S.scene)) addHit(SX(S.x, S.y), SY(S.x, S.y, 0.3), Math.max(10, S.hl * 0.6 * s), S);
      else if (S.type === FIGHT && S.blocks.length) for (let b = 0; b < S.blocks.length; b++) { const B = S.blocks[b]; item(depth(gxL(S, B.u, B.v), gyL(S, B.u, B.v)), I_BLOCK, S, b); }
      if (S.type === ANGEL) addHit(SX(S.x, S.y), SY(S.x, S.y, 0), Math.max(10, 1.3 * s), S);
      if (S.type === TRAIL && s >= MARK_S) visTrails.push(S);
      const g = S.scene;
      if (!people || !g || g.alpha * fadeS <= 0.01) continue;
      moving = true;
      for (let i = 0; i < g.P.length; i++) {
        const p = g.P[i];
        // a passenger sits on someone else's sled: drawn just after it
        const d = p.pose === SIT && !p.sled && g.P[0].sled ? depth(g.P[0].sled.x, g.P[0].sled.y) - 0.02 : depth(p.x, p.y);
        item(d, I_PERSON, g, i);
        addHit(SX(p.x, p.y), SY(p.x, p.y, 0.9 * p.kid), Math.max(10, 1.1 * PK), S);
        if (p.sled) item(depth(p.sled.x, p.sled.y) + (p.st === S_CLIMB || p.st === S_WALK || g.type === TRAIL ? 0 : 0.05), I_SLED, g, i);
      }
      if (g.balls) for (let k = 0; k < g.balls.length; k++) if (g.balls[k].on) { const b = g.balls[k]; item(depth(gxL(S, b.u, b.v), gyL(S, b.u, b.v)), I_BALL, g, k); }
    }
    for (let k = 0; k < PUFF_N; k++) {
      if (puffs[5 * k + 3] >= PUFF_LIFE || !puffSite[k] || !puffSite[k].vis) continue;
      item(depth(puffs[5 * k], puffs[5 * k + 1]), I_PUFF, puffSite[k], k);
      moving = true;
    }
    if (nItems) {
      order.sort(byDepth);
      const close = s >= DETAIL_S, clock = performance.now() / 1000, camKey = ROT * 100 + s;
      for (const it of order) {
        const S = siteOf(it), a = alphaOf(it, fadeS);
        if (a <= 0.01) continue;
        if (close && app.scene) {
          // nothing in front of it: remembered for this zoom and turn (things that stay put) or half a second (people)
          const t = it.t, h = t === I_PERSON ? it.a.P[it.i] : t === I_SLED ? it.a.P[it.i].sled : t === I_SNOWMAN ? it.a : t === I_BLOCK ? it.a.blocks[it.i] : null;
          const still = t === I_SNOWMAN || t === I_BLOCK;
          if (h && (still ? h.ncK === camKey : h.ncT > clock)) { drawItem(ctx, it, a, true); continue; }
          const ids = objectsOver(S);
          if (ids.length && boxOf(it) && cutBegin(ctx, ids, BOX[4], BOX[5], BOX[6])) { drawItem(ctx, it, a, true); ctx.restore(); }
          else {
            drawItem(ctx, it, a, true);
            if (h) { if (still) h.ncK = camKey; else h.ncT = clock + 0.4 + Math.random() * 0.2; }
          }
        } else if (!hiddenItem(it, S, clock)) drawItem(ctx, it, a, close);
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    publish();
    if (moving && !reduceMQ.matches) want = s >= DETAIL_S ? 24 : s >= 5 ? 15 : 10;
  }
  function publish() { if (whimsy.snowday !== count) whimsy.snowday = count; }
  const siteOf = (it) => (it.t === I_SNOWMAN || it.t === I_BLOCK || it.t === I_PUFF ? it.a : it.a.S);
  function alphaOf(it, fadeS) {
    if (it.t === I_SNOWMAN || it.t === I_BLOCK) return fadeS;
    if (it.t === I_PUFF) return fadeS * (1 - puffs[5 * it.i + 3] / PUFF_LIFE);
    const g = it.a;
    return g.alpha * fadeS * (g.type === TRAIL ? g.walkA : 1);
  }

  // ---------------------------------------------------------------- marks in the snow
  function drawMarks(ctx, S, a) {
    const s = SCALE;
    // whatever stands in front of the farthest of it is cut out (a building or a tree nearer than the marks hides them)
    const fx = S.cx + D0 * S.rad, fy = S.cy + D1 * S.rad;
    const r = S.rad * s, px = SX(S.cx, S.cy), py = SY(S.cx, S.cy, 0);
    BOX[0] = px - r - 2; BOX[2] = px + r + 2; BOX[1] = py - r * SIN_T - 2; BOX[3] = py + r * SIN_T + 2;
    const ids = app.scene ? objectsOver(S) : null;
    const cut = ids && ids.length ? cutBegin(ctx, ids, fx, fy, S.rad, true) : false;
    ctx.save();
    ctx.globalAlpha = a;
    {
      const det = PA * PD - PB * PC, dx = Math.min(1.2, 0.07 * s), dy = dx * 0.6;
      LITX = (PD * dx - PB * dy) / det; LITY = (-PC * dx + PA * dy) / det;
    }
    ctx.transform(PA, PC, PB, PD, PE, PF);   // ground metres from here on
    switch (S.type) {
      case SNOWMAN:
        ctx.fillStyle = ROLL_COL;
        for (const ro of S.rolls) rollStripe(ctx, ro);
        if (S.melt > 0.35) {
          // slush round its base
          ctx.fillStyle = `rgba(110,128,150,${(0.2 * S.melt).toFixed(3)})`;
          ctx.beginPath(); ctx.ellipse(S.x, S.y, S.r0 * (1.3 + S.melt), S.r0 * (1.2 + S.melt * 0.8), S.lean, 0, Math.PI * 2); ctx.fill();
        }
        prints(ctx, S.prints, s);
        break;
      case ANGEL:
        for (let k = 0; k < S.angels.length; k += 3) angel(ctx, S.angels[k], S.angels[k + 1], S.angels[k + 2]);
        prints(ctx, S.prints, s);
        break;
      case TRAIL:
        if (s >= PRINT_S) prints(ctx, S.prints, s);
        else {
          ctx.strokeStyle = TROD_COL; ctx.lineWidth = 0.34 * S.walkers + 0.2;
          ctx.beginPath();
          for (let q = 0; q < S.pts.length; q += 2) q ? ctx.lineTo(S.pts[q], S.pts[q + 1]) : ctx.moveTo(S.pts[q], S.pts[q + 1]);
          ctx.stroke();
        }
        break;
      case FIGHT: {
        ctx.fillStyle = TRAMPLE_COL;
        ctx.beginPath();
        const B = S.blobs;
        for (let k = 0; k < B.length; k += 5) { ctx.moveTo(B[k] + B[k + 2], B[k + 1]); ctx.ellipse(B[k], B[k + 1], B[k + 2], B[k + 3], B[k + 4], 0, Math.PI * 2); }
        ctx.fill();
        prints(ctx, S.prints, s);
        break;
      }
      case SLED: {
        // the run: packed snow, two grooves, and the climbing lane's footprints beside it
        const L = S.L, x0 = S.x, y0 = S.y, ux = S.ca, uy = S.sa;
        ctx.strokeStyle = TRAMPLE_COL; ctx.lineWidth = 0.9;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + ux * L, y0 + uy * L); ctx.stroke();
        ctx.strokeStyle = TRAMPLE_COL; ctx.lineWidth = 0.55;
        ctx.beginPath(); ctx.moveTo(x0 - uy * 1.1, y0 + ux * 1.1); ctx.lineTo(x0 + ux * L - uy * 1.1, y0 + uy * L + ux * 1.1); ctx.stroke();
        if (s >= 4) {
          ctx.strokeStyle = GROOVE_COL; ctx.lineWidth = Math.max(0.05, 0.7 / s);
          ctx.beginPath();
          for (let side = -1; side <= 1; side += 2) {
            for (let w = 0; w < 2; w++) {
              const off = side * (0.2 + w * 0.06) + (w ? 0.15 : 0);
              ctx.moveTo(x0 - uy * off + ux * 0.1, y0 + ux * off + uy * 0.1);
              ctx.quadraticCurveTo(x0 + ux * L * 0.5 - uy * (off + 0.15 * side), y0 + uy * L * 0.5 + ux * (off + 0.15 * side), x0 + ux * (L - 0.2) - uy * off, y0 + uy * (L - 0.2) + ux * off);
            }
          }
          ctx.stroke();
        }
        if (s >= PRINT_S) {
          if (!S.prints) {
            const pr = [];
            for (let d = 0.6, q = 0; d < L; d += 0.38, q++) { const side = q & 1 ? 1 : -1, off = 1.1 + side * 0.13; pr.push(x0 + ux * d - uy * off, y0 + uy * d + ux * off, S.ang + (hash01(S.seed, q) - 0.5) * 0.3); }
            S.prints = Float32Array.from(pr);
          }
          prints(ctx, S.prints, s);
        }
        break;
      }
    }
    ctx.restore();
    if (cut) ctx.restore();
  }
  let LITX = 0, LITY = 0;
  // footprints: a whole set in one fill; a few pixels each, so a little quad (an ellipse looks the same and costs
  // many times more to path and fill)
  function prints(ctx, P, s) {
    if (!P || !P.length || s < 4) return;
    ctx.fillStyle = PRINT_COL;
    ctx.beginPath();
    for (let k = 0; k < P.length; k += 3) {
      const x = P[k], y = P[k + 1], a = P[k + 2], c = Math.cos(a), sn = Math.sin(a);
      const ux = c * 0.15, uy = sn * 0.15, vx = -sn * 0.065, vy = c * 0.065;
      ctx.moveTo(x + ux, y + uy); ctx.lineTo(x + vx * 0.6, y + vy * 0.6 + 0); ctx.lineTo(x - ux * 0.8 + vx, y - uy * 0.8 + vy);
      ctx.lineTo(x - ux * 0.8 - vx, y - uy * 0.8 - vy); ctx.lineTo(x - vx * 0.6, y - vy * 0.6);
    }
    ctx.fill();
  }
  // a stripe of bare lawn behind a rolled ball, widening as it grew
  function rollStripe(ctx, R) {
    const n = R.length / 3;
    ctx.beginPath();
    for (let q = 0; q < n; q++) {
      normalAt(R, q, n);
      const nx = NRM[0], ny = NRM[1], w = R[3 * q + 2] / 2;
      q ? ctx.lineTo(R[3 * q] + nx * w, R[3 * q + 1] + ny * w) : ctx.moveTo(R[3 * q] + nx * w, R[3 * q + 1] + ny * w);
    }
    for (let q = n - 1; q >= 0; q--) { normalAt(R, q, n); const w = R[3 * q + 2] / 2; ctx.lineTo(R[3 * q] - NRM[0] * w, R[3 * q + 1] - NRM[1] * w); }
    ctx.fill();
  }
  const NRM = [0, 0];
  function normalAt(R, q, n) {
    const a = Math.max(0, q - 1), b = Math.min(n - 1, q + 1), dx = R[3 * b] - R[3 * a], dy = R[3 * b + 1] - R[3 * a + 1], l = Math.hypot(dx, dy) || 1;
    NRM[0] = -dy / l; NRM[1] = dx / l;
    return NRM;
  }
  // a snow angel: a feathered fan of wings from the shoulders up over the head, a skirt swept out below, the body and
  // head pressed deepest
  function angel(ctx, x, y, a) {
    // pressed into the snow: the hollow in shade along the edge toward the light, lit along the far edge
    angelShape(ctx, x, y, a, ANGEL_COL, true);
    angelShape(ctx, x + LITX, y + LITY, a, "rgba(252,253,255,.5)", false);
  }
  function angelShape(ctx, x, y, a, col, deep) {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(a);   // +x toward the head
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(0.34, 0);
    for (let q = 0; q <= 26; q++) {
      const t = -1.72 + (q / 26) * 3.44, r = 0.95 + 0.055 * Math.cos(q * 1.9);
      ctx.lineTo(0.34 + Math.cos(t) * r * 0.8, Math.sin(t) * r);
    }
    ctx.moveTo(-0.15, 0);
    for (let q = 0; q <= 14; q++) {
      const t = Math.PI - 0.5 + (q / 14) * 1.0, r = 0.98 + 0.04 * Math.cos(q * 2.3);
      ctx.lineTo(-0.15 + Math.cos(t) * r, Math.sin(t) * r);
    }
    ctx.moveTo(0.54, 0); ctx.ellipse(0.12, 0, 0.42, 0.22, 0, 0, Math.PI * 2);
    ctx.moveTo(1.0, 0); ctx.arc(0.82, 0, 0.18, 0, Math.PI * 2);
    ctx.fill();
    if (!deep) { ctx.restore(); return; }
    ctx.fillStyle = ANGEL_DEEP;
    ctx.beginPath();
    ctx.moveTo(0.46, 0); ctx.ellipse(0.1, 0, 0.36, 0.18, 0, 0, Math.PI * 2);
    ctx.moveTo(0.96, 0); ctx.arc(0.82, 0, 0.14, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------------- what stands in front
  // The scene objects whose screen box meets the place's (with 3 m of height and room round it), in front of it or
  // not: worked out once per turn of the view (in screen metres, so it holds while the view pans and zooms).
  function objectsOver(S) {
    if (S.occR === ROT) return S.occ;
    const o = geo.ROTS[ROT], X = S.cx * o.R[0] + S.cy * o.R[1], Y = -(S.cx * o.D[0] + S.cy * o.D[1]) * SIN_T, r = S.rad + 1.5;
    S.occ = app.scene.query(ROT, "objects", X - r, Y - r * SIN_T - 3.2 * COS_T, X + r, Y + r * SIN_T);
    S.occR = ROT;
    return S.occ;
  }
  // Clip ctx (saved; the caller restores) to BOX less the outlines of the objects among ids standing in front of ground
  // point (x, y) (halfW metres across). False, with nothing changed, when nothing in front crosses BOX.
  const SIL = makeRecorder(), SIL_EXACT = SIL.withAddPath();
  const BOX = [0, 0, 0, 0, 0, 0, 0];
  // flat: the marks in the snow, which only buildings and trees in leaf or needles hide (a bare trunk or a lamp post
  // over a faint footprint makes no difference, and on a wooded lawn each would be one more clip)
  function cutBegin(ctx, ids, x, y, halfW, flat) {
    const sc = app.scene, S = sc.forRot(ROT), bb = S.objBB, B = sc.B, T = sc.T, tr = data.trees, s = SCALE;
    if (BOX[0] < -2) BOX[0] = -2; if (BOX[1] < -2) BOX[1] = -2; if (BOX[2] > VW + 2) BOX[2] = VW + 2; if (BOX[3] > VH + 2) BOX[3] = VH + 2;
    const X0 = BOX[0], Y0 = BOX[1], X1 = BOX[2], Y1 = BOX[3];
    if (X1 <= X0 || Y1 <= Y0) return false;
    const mX0 = (X0 - PE) / s, mY0 = (Y0 - PF) / s, mX1 = (X1 - PE) / s, mY1 = (Y1 - PF) / s;
    SIL.reset();
    let n = 0;
    for (let q = 0; q < ids.length; q++) {
      const id = ids[q], o = 4 * id;
      if (bb[o + 2] < mX0 || bb[o] > mX1 || bb[o + 3] < mY0 || bb[o + 1] > mY1) continue;
      const conifer = id >= B && id < B + T && (tr[5 * (id - B) + 4] & 1);
      if (flat && id >= B && (id >= B + T || (!conifer && renderer.treeBare(id - B, app.tileStyle)))) continue;
      if (!sc.inFront(ROT, id, x, y, halfW)) continue;
      renderer.silhouette(conifer ? SIL_EXACT : SIL, ROT, CAM, id, app.tileStyle);
      n++;
    }
    if (!n) return false;
    SIL.closePath();
    let cuts = 0;
    for (let p = 0; p < SIL.count; p++) if (SIL.meets(p, X0, Y0, X1, Y1)) cuts++;
    if (!cuts) return false;
    ctx.save();
    ctx.beginPath(); ctx.rect(X0, Y0, X1 - X0, Y1 - Y0); ctx.clip();
    for (let p = 0; p < SIL.count; p++) if (SIL.meets(p, X0, Y0, X1, Y1)) SIL.cut(ctx, p, X0 - 2, Y0 - 2, X1 + 2, Y1 + 2);
    return true;
  }
  // the screen box an item may cover (CSS px), and the ground point and half-width it stands at, into BOX
  function box(x0, y0, x1, y1, x, y, hw) { BOX[0] = x0 - 1; BOX[1] = y0 - 1; BOX[2] = x1 + 1; BOX[3] = y1 + 1; BOX[4] = x; BOX[5] = y; BOX[6] = hw; return true; }
  function boxOf(it) {
    const s = SCALE, k = PK;
    switch (it.t) {
      case I_SNOWMAN: {
        const S = it.a, px = SX(S.x, S.y), py = SY(S.x, S.y, 0), w = (S.r0 * 1.7 + 0.8) * s;
        return box(px - w, py - (S.height + 0.5) * k, px + w, py + S.r0 * s + 2, S.x, S.y, S.r0);
      }
      case I_PERSON: {
        const p = it.a.P[it.i], px = SX(p.x, p.y), py = SY(p.x, p.y, 0), w = (p.pose === LIE ? 1.1 : 0.7) * s;
        return box(px - w, py - 2.2 * k, px + w, py + 0.5 * s, p.x, p.y, 0.4);
      }
      case I_SLED: {
        const sl = it.a.P[it.i].sled, px = SX(sl.x, sl.y), py = SY(sl.x, sl.y, 0);
        return box(px - 0.8 * s, py - 0.5 * k, px + 0.8 * s, py + 0.5 * s, sl.x, sl.y, 0.5);
      }
      case I_BALL: {
        const g = it.a, b = g.balls[it.i], x = gxL(g.S, b.u, b.v), y = gyL(g.S, b.u, b.v), px = SX(x, y), py = SY(x, y, b.z), r = Math.max(2, 0.1 * s) + 1;
        return box(px - r, py - r, px + r, SY(x, y, 0) + r, x, y, 0.1);
      }
      case I_BLOCK: {
        const S = it.a, B = S.blocks[it.i], x = gxL(S, B.u, B.v), y = gyL(S, B.u, B.v), px = SX(x, y), py = SY(x, y, 0);
        return box(px - 0.5 * s, py - 0.7 * k, px + 0.5 * s, py + 0.4 * s, x, y, 0.35);
      }
      default: {
        const k5 = 5 * it.i, x = puffs[k5], y = puffs[k5 + 1], px = SX(x, y), py = SY(x, y, puffs[k5 + 2]), r = 0.8 * s + 3;
        return box(px - r, py - r, px + r, py + r, x, y, 0.4);
      }
    }
  }
  // from afar: a building or a leafy crown in front of the middle of it (people checked every half second or so)
  function hiddenItem(it, S, clock) {
    if (!app.scene) return false;
    if (it.t === I_PERSON) {
      const p = it.a.P[it.i];
      if (clock >= p.hidT) { p.hid = pointHidden(p.x, p.y, 1.6); p.hidT = clock + 0.45 + Math.random() * 0.2; }
      return p.hid;
    }
    if (it.t === I_SLED) return it.a.P[it.i].hid;
    if (S.hidR !== ROT) { S.hid = pointHidden(S.x, S.y, it.t === I_SNOWMAN ? S.height : 0.6); S.hidR = ROT; }
    return S.hid;
  }
  function pointHidden(x, y, h) {
    const sc = app.scene, r = ROT, o = geo.ROTS[r];
    const U = x * o.R[0] + y * o.R[1], Y = -(x * o.D[0] + y * o.D[1]) * SIN_T - h * 0.5 * COS_T;
    const b = sc.pickBuilding(r, U, Y);
    if (b >= 0 && sc.inFront(r, b, x, y, 0)) return true;
    const ids = sc.query(r, "objects", U - 0.5, Y - 0.5, U + 0.5, Y + 0.5), B = sc.B, T = sc.T, tr = data.trees;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k];
      if (id < B || id >= B + T) continue;
      const t = id - B, tx = tr[5 * t], ty = tr[5 * t + 1], rad = tr[5 * t + 2], th = tr[5 * t + 3];
      if (renderer.treeBare(t, app.tileStyle) || !sc.inFront(r, id, x, y, 0)) continue;
      const cu = tx * o.R[0] + ty * o.R[1], cv = -(tx * o.D[0] + ty * o.D[1]) * SIN_T - Math.max(th - rad, th * 0.55) * COS_T;
      if ((U - cu) ** 2 + (Y - cv) ** 2 < rad * rad) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- painting
  function drawItem(ctx, it, a, close) {
    ctx.globalAlpha = a;
    switch (it.t) {
      case I_SNOWMAN: drawSnowman(ctx, it.a, close); break;
      case I_PERSON: drawPerson(ctx, it.a.P[it.i], it.a, close); break;
      case I_SLED: drawSled(ctx, it.a.P[it.i], close); break;
      case I_BALL: drawBall(ctx, it.a, it.a.balls[it.i]); break;
      case I_BLOCK: drawBlock(ctx, it.a, it.a.blocks[it.i]); break;
      case I_PUFF: drawPuff(ctx, it.i); break;
    }
  }

  // a snow ball: shade below and to the right, lit above and to the left (light from screen-left)
  function snowBall(ctx, x, y, rx, ry) {
    ctx.fillStyle = SNOW_SHADE;
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    if (rx >= 3) { ctx.strokeStyle = SNOW_RIM; ctx.lineWidth = Math.max(0.6, rx * 0.06); ctx.stroke(); }
    ctx.fillStyle = SNOW_LIT;
    ctx.beginPath(); ctx.ellipse(x - rx * 0.17, y - ry * 0.18, rx * 0.8, ry * 0.8, 0, 0, Math.PI * 2); ctx.fill();
  }
  const SM = { bx: [0, 0, 0], by: [0, 0, 0], br: [0, 0, 0], bq: [0, 0, 0] };
  function drawSnowman(ctx, S, close) {
    const s = SCALE, k = PK, m = S.melt, nb = S.balls;
    const px = SX(S.x, S.y), py = SY(S.x, S.y, 0);
    // leaning as it melts: screen px of lean per metre up
    const lx = Math.cos(S.lean), ly = Math.sin(S.lean), lean = 0.06 + 0.42 * m * m;
    const lsx = (PA * lx + PB * ly) * lean, lsy = (PC * lx + PD * ly) * lean;
    // the balls, sinking and shrinking as they melt; past a point the head has rolled off
    const headOff = m > 0.86 && S.dropHead && nb === 3;
    for (let b = 0; b < nb; b++) {
      const shrink = 1 - m * (b === 0 ? 0.12 : 0.22), z = S.zz[b] * (1 - 0.3 * m) * (b === 0 ? 1 - 0.25 * m : 1);
      SM.br[b] = S.rr[b] * shrink * s; SM.bq[b] = 1 - 0.28 * m * (b === 0 ? 1 : 0.55);
      SM.bx[b] = px + lsx * z; SM.by[b] = py - z * k + lsy * z;
    }
    // its shadow, to the right
    ctx.fillStyle = SHADOW;
    ctx.beginPath(); ctx.ellipse(px + S.r0 * s * 0.5, py + 0.03 * s, S.r0 * s * (1.35 + 0.4 * m), S.r0 * s * (0.55 + 0.2 * m), 0, 0, Math.PI * 2); ctx.fill();
    const fx = Math.cos(S.ang), fy = Math.sin(S.ang), fsx = PA * fx + PB * fy, fsy = PC * fx + PD * fy;
    const toward = fx * D0 + fy * D1 < 0.15;
    // arms: the far one behind the body, the near one in front
    const mid = nb === 3 ? 1 : 0;
    const armL = S.r0 * 1.25 + 0.2, sideX = -fy, sideY = fx, sideNear = sideX * D0 + sideY * D1 < 0 ? 1 : -1;
    if (S.arms && s >= 3) arm(ctx, S, -sideNear, mid, armL, sideX, sideY, m);
    const last = headOff ? nb - 1 : nb;
    for (let b = 0; b < last; b++) {
      snowBall(ctx, SM.bx[b], SM.by[b], SM.br[b], SM.br[b] * SM.bq[b]);
      if (b === 0 && s >= 6) {
        // a little snow banked round the bottom
        ctx.fillStyle = SNOW_LIT;
        ctx.beginPath(); ctx.ellipse(px, py - SM.br[0] * 0.05, SM.br[0] * 1.12, SM.br[0] * 0.42, 0, 0, Math.PI); ctx.fill();
      }
      if (b === nb - 2 && S.scarf >= 0 && s >= 4 && !headOff) scarfRing(ctx, S, b, false);
    }
    if (S.arms && s >= 3) arm(ctx, S, sideNear, mid, armL, sideX, sideY, m);
    // buttons down the front
    if (toward && s >= 6) {
      const b = nb === 3 ? 1 : 0, r = SM.br[b];
      ctx.fillStyle = COAL;
      for (let q = 0; q < S.buttons; q++) {
        const el = 0.5 - q * 0.42, c = Math.cos(el);
        ctx.beginPath(); ctx.arc(SM.bx[b] + fsx * (r / s) * c * 0.95, SM.by[b] + fsy * (r / s) * c * 0.95 - Math.sin(el) * r * SM.bq[b] * 0.9, Math.max(0.7, 0.035 * s), 0, Math.PI * 2); ctx.fill();
      }
    }
    if (headOff) {
      // the head, rolled off beside it, carrot to the sky
      const hx = px + (PA * sideX + PB * sideY) * (S.r0 + 0.35) * sideNear, hy = py + (PC * sideX + PD * sideY) * (S.r0 + 0.35) * sideNear;
      const hr = SM.br[nb - 1];
      snowBall(ctx, hx, hy - hr * 0.7, hr, hr * 0.8);
      if (s >= 4) { ctx.fillStyle = CARROT; ctx.beginPath(); ctx.moveTo(hx - 0.03 * s, hy - hr * 1.2); ctx.lineTo(hx + 0.03 * s, hy - hr * 1.2); ctx.lineTo(hx + 0.01 * s, hy - hr * 1.2 - 0.17 * k); ctx.fill(); }
      if (S.hat && s >= 3) { const sx0 = SM.bx[nb - 2], sy0 = SM.by[nb - 2] - SM.br[nb - 2] * SM.bq[nb - 2]; hat(ctx, S, sx0, sy0 + SM.br[nb - 2] * 0.15, SM.br[nb - 2] * 0.9, 0.5 * S.lean - 0.4); }
      return;
    }
    const hb = nb - 1, hx = SM.bx[hb], hy = SM.by[hb], hr = SM.br[hb], hq = SM.bq[hb];
    if (S.scarf >= 0 && s >= 4) scarfRing(ctx, S, hb - 1, true);
    // the face
    if (toward && s >= 3.5) {
      const r = hr / s;
      if (s >= 5) {
        ctx.fillStyle = COAL;
        for (let e = -1; e <= 1; e += 2) {
          const ex = Math.cos(S.ang + e * 0.42), ey = Math.sin(S.ang + e * 0.42);
          if (ex * D0 + ey * D1 > 0.1) continue;
          ctx.beginPath(); ctx.arc(hx + (PA * ex + PB * ey) * r * 0.82, hy + (PC * ex + PD * ey) * r * 0.82 - r * 0.3 * k * hq, Math.max(0.75, 0.04 * s), 0, Math.PI * 2); ctx.fill();
        }
        if (S.smile && s >= 11) {
          for (let q = -2; q <= 2; q++) {
            const ex = Math.cos(S.ang + q * 0.2), ey = Math.sin(S.ang + q * 0.2), drop = 0.3 + 0.08 * (4 - q * q) / 4 - 0.1;
            ctx.beginPath(); ctx.arc(hx + (PA * ex + PB * ey) * r * 0.9, hy + (PC * ex + PD * ey) * r * 0.9 + r * drop * k, Math.max(0.5, 0.022 * s), 0, Math.PI * 2); ctx.fill();
          }
        }
      }
      // the carrot, drooping as it melts
      const nx0 = hx + fsx * r * 0.85, ny0 = hy + fsy * r * 0.85, len = 0.19 + 0.05 * (S.r0 > 0.5 ? 1 : 0);
      const tipx = nx0 + fsx * len, tipy = ny0 + fsy * len + m * 0.1 * k, w = Math.max(0.8, 0.035 * s);
      const nl = Math.hypot(tipx - nx0, tipy - ny0) || 1, ox = (-(tipy - ny0) / nl) * w, oy = ((tipx - nx0) / nl) * w;
      ctx.fillStyle = CARROT;
      ctx.beginPath(); ctx.moveTo(nx0 + ox, ny0 + oy); ctx.lineTo(nx0 - ox, ny0 - oy); ctx.lineTo(tipx, tipy); ctx.fill();
    }
    if (S.hat && s >= 3) hat(ctx, S, hx, hy - hr * hq * 0.78, hr, (S.lean > Math.PI ? -1 : 1) * m * 0.5);
  }
  // a stick arm out of ball b's side (side ±1 along (sx, sy)), drooping as it melts
  function arm(ctx, S, side, b, len, sx, sy, m) {
    // out to the side on screen (an arm pointing at the camera reads as an antenna), shortened as it turns toward us
    const s = SCALE, k = PK, r = SM.br[b];
    const ex = sx * side, ey = sy * side, esx = PA * ex + PB * ey, esy = PC * ex + PD * ey;
    const dir = Math.abs(esx) > 0.15 * s ? Math.sign(esx) : side * (sx * D1 - sy * D0 >= 0 ? 1 : -1), fore = Math.max(0.55, Math.abs(esx) / s);
    const up = S.armUp[side > 0 ? 1 : 0] * (1 - 1.6 * m), L = len * s * fore;
    const x0 = SM.bx[b] + dir * r * 0.82, y0 = SM.by[b] + (esy / s) * r * 0.3 - r * 0.12;
    const x1 = x0 + dir * L * Math.cos(up), y1 = y0 + (esy / s) * len * 0.3 * s - Math.sin(up) * len * k;
    ctx.strokeStyle = STICK; ctx.lineWidth = Math.max(0.8, 0.04 * s);
    ctx.beginPath();
    ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
    if (s >= 7) {
      // a twig or two near the end
      const fx = x0 + (x1 - x0) * 0.7, fy = y0 + (y1 - y0) * 0.7;
      ctx.moveTo(fx, fy); ctx.lineTo(fx + (x1 - x0) * 0.25 + 0.02 * s, fy + (y1 - y0) * 0.25 - 0.1 * k);
      ctx.moveTo(x1, y1); ctx.lineTo(x1 + (x1 - x0) * 0.12, y1 + 0.06 * k);
      ctx.moveTo(x1, y1); ctx.lineTo(x1 + (x1 - x0) * 0.1 - 0.02 * s, y1 - 0.08 * k);
    }
    ctx.stroke();
  }
  // a scarf round the neck: the back half before the head, the front and the tail after it
  function scarfRing(ctx, S, b, front) {
    const s = SCALE, k = PK, col = SCARVES[S.scarf], r = SM.br[b] * 0.66, x = SM.bx[b], y = SM.by[b] - SM.br[b] * SM.bq[b] * 0.88;
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.2, 0.1 * s);
    ctx.beginPath(); ctx.ellipse(x, y, r, r * SIN_T, 0, front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2); ctx.stroke();
    if (!front) return;
    if (S.stripe && s >= 8) {
      ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = Math.max(0.5, 0.025 * s);
      ctx.beginPath(); ctx.ellipse(x, y, r, r * SIN_T, 0, 0.2, Math.PI - 0.2); ctx.stroke();
    }
    // the tail, hanging down one side of the front
    const fx = Math.cos(S.ang + 0.7), fy = Math.sin(S.ang + 0.7);
    if (fx * D0 + fy * D1 > 0.2) return;
    const tx = x + (PA * fx + PB * fy) * (r / s) * 1.0, ty = y + (PC * fx + PD * fy) * (r / s);
    ctx.fillStyle = col;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(tx - 0.045 * s, ty - 0.02 * k, 0.09 * s, 0.32 * k, 0.02 * s); else ctx.rect(tx - 0.045 * s, ty - 0.02 * k, 0.09 * s, 0.32 * k);
    ctx.fill();
    if (s >= 9) { ctx.fillStyle = "rgba(255,255,255,.5)"; ctx.fillRect(tx - 0.045 * s, ty + 0.26 * k, 0.09 * s, Math.max(0.5, 0.025 * k)); }
  }
  // a hat on a head whose top is at (x, y) (CSS px), head radius r px, tilted by tilt radians
  function hat(ctx, S, x, y, r, tilt) {
    const s = SCALE, k = PK;
    ctx.save();
    ctx.translate(x, y); if (tilt) ctx.rotate(tilt);
    switch (S.hat) {
      case H_TOP: {
        const w = r * 0.72, h = 0.3 * k, br = r * 1.15;
        ctx.fillStyle = "#2b2a2e";
        ctx.beginPath(); ctx.ellipse(0, 0, br, br * 0.32, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillRect(-w, -h, 2 * w, h);
        ctx.fillStyle = "#3a383d"; ctx.beginPath(); ctx.ellipse(0, -h, w, w * 0.3, 0, 0, Math.PI * 2); ctx.fill();
        if (s >= 6) { ctx.fillStyle = S.hatCol === "#2f3e5c" ? "#b3202a" : S.hatCol; ctx.fillRect(-w, -0.08 * k, 2 * w, Math.max(0.8, 0.045 * k)); }
        break;
      }
      case H_BEANIE: {
        ctx.fillStyle = S.hatCol;
        ctx.beginPath(); ctx.arc(0, r * 0.45, r * 0.98, Math.PI * 1.02, Math.PI * 1.98); ctx.fill();
        ctx.fillRect(-r * 1.0, r * 0.2, r * 2.0, r * 0.32);
        if (s >= 6) { ctx.fillStyle = "rgba(0,0,0,.12)"; ctx.fillRect(-r * 1.0, r * 0.2, r * 2.0, r * 0.32); }
        if (S.pom) { ctx.fillStyle = S.hatCol === "#f2efe8" ? "#b3202a" : "#f2efe8"; ctx.beginPath(); ctx.arc(0, -r * 0.6, Math.max(0.8, r * 0.3), 0, Math.PI * 2); ctx.fill(); }
        break;
      }
      case H_CAP: {
        const fx = Math.cos(S.ang), fy = Math.sin(S.ang);
        ctx.fillStyle = "#b3202a";
        ctx.beginPath(); ctx.arc(0, r * 0.4, r * 0.95, Math.PI * 1.02, Math.PI * 1.98); ctx.fill();
        ctx.fillStyle = "#8f1a22";
        ctx.beginPath(); ctx.ellipse((PA * fx + PB * fy) * (r / s) * 0.9, (PC * fx + PD * fy) * (r / s) * 0.9 + r * 0.32, r * 0.62, r * 0.24, 0, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case H_CONE: {
        const w = r * 0.85, h = 0.42 * k;
        ctx.fillStyle = "#e8692a";
        ctx.beginPath(); ctx.moveTo(-w, r * 0.25); ctx.lineTo(w, r * 0.25); ctx.lineTo(w * 0.12, -h); ctx.lineTo(-w * 0.12, -h); ctx.fill();
        ctx.fillStyle = "#f6f3ec";
        ctx.beginPath(); ctx.moveTo(-w * 0.62, -h * 0.25); ctx.lineTo(w * 0.62, -h * 0.25); ctx.lineTo(w * 0.47, -h * 0.5); ctx.lineTo(-w * 0.47, -h * 0.5); ctx.fill();
        ctx.fillStyle = "#c9561f"; ctx.fillRect(-w * 1.15, r * 0.2, w * 2.3, Math.max(0.8, 0.04 * k));
        break;
      }
      case H_POT: {
        const w = r * 0.9, h = 0.16 * k;
        ctx.fillStyle = "#8d949c";
        ctx.fillRect(-w, -h + r * 0.2, 2 * w, h);
        ctx.fillStyle = "#a9b0b7"; ctx.beginPath(); ctx.ellipse(0, -h + r * 0.2, w, w * 0.3, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "#3b3b3f"; ctx.lineWidth = Math.max(0.8, 0.035 * s);
        ctx.beginPath(); ctx.moveTo(w, -h * 0.4 + r * 0.2); ctx.lineTo(w + 0.22 * s, -h * 0.55 + r * 0.2); ctx.stroke();
        break;
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- people, as life.js draws walkers, dressed for snow
  function drawPerson(ctx, p, g, close) {
    const sc = p.kid, s = SCALE * sc, k = PK * sc;
    const px = SX(p.x, p.y), gy = SY(p.x, p.y, 0), py = gy - p.z * PK;
    const bw = Math.max(1, 0.5 * s), lw = Math.max(0.6, 0.17 * s);
    if (p.pose === LIE) { drawLying(ctx, p, px, gy, s, k, close); return; }
    const crouch = p.pose === SCOOP || p.pose === DUCK ? 1 : p.pose === PACK ? 0.25 : 0, sit = p.pose === SIT;
    const hip = sit ? 0.16 : 0.8 - 0.38 * crouch, z0 = sit ? 0.14 : 0.74 - 0.36 * crouch, z1 = sit ? 0.8 : 1.42 - 0.4 * crouch;
    const walking = p.mv > 0.2 && !sit && !crouch;
    if (!close) {
      // a few pixels: shadow, legs, coat, head, hat
      const hs = Math.max(1, 0.27 * s), sw = walking ? Math.sin(p.ph) * 0.15 * s : 0;
      ctx.fillStyle = SHADOW; ctx.fillRect(px - bw * 0.3, gy - 0.12 * s, bw * 1.3, 0.3 * s);
      ctx.fillStyle = p.pants;
      if (sit) ctx.fillRect(px - bw * 0.5, py - hip * k - lw * 0.5, bw, lw);
      else { ctx.fillRect(px - bw * 0.4 + sw, py - hip * k, lw, hip * k); ctx.fillRect(px + bw * 0.4 - lw - sw, py - hip * k, lw, hip * k); }
      ctx.fillStyle = p.coat; ctx.fillRect(px - bw / 2, py - z1 * k, bw, (z1 - z0) * k);
      if (s >= 4 && (p.pose === WIND || p.pose === CHEER || p.pose === DUCK)) ctx.fillRect(px + bw * 0.5 - lw, py - (z1 + 0.5) * k, lw, 0.55 * k);
      if (p.scarf && s >= 4) { ctx.fillStyle = p.scarf; ctx.fillRect(px - bw * 0.5, py - z1 * k, bw, Math.max(0.8, 0.1 * k)); }
      ctx.fillStyle = p.skin; ctx.fillRect(px - hs / 2, py - z1 * k - hs, hs, hs);
      if (p.hat) { ctx.fillStyle = p.knit; ctx.fillRect(px - hs * 0.55, py - z1 * k - hs * 1.15, hs * 1.1, hs * 0.55); }
      return;
    }
    const hsx = PA * p.hx + PB * p.hy, hsy = PC * p.hx + PD * p.hy, away = p.hx * D0 + p.hy * D1 > 0;
    // shadow
    const a0 = ctx.globalAlpha;
    ctx.globalAlpha = a0 * 0.9; ctx.fillStyle = SHADOW;
    ctx.beginPath(); ctx.ellipse(px + 0.18 * s, gy + 0.02 * s, 0.34 * s * (sit ? 1.3 : 1), 0.17 * s, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = a0;
    // the body leans in when crouching
    const lean = crouch * 0.2, bx = px + hsx * lean, by = py + hsy * lean;
    // legs (snow pants and boots); sitting, they point forward along the sled
    ctx.fillStyle = p.pants;
    if (sit) {
      ctx.strokeStyle = p.pants; ctx.lineWidth = lw * 1.25;
      ctx.beginPath(); ctx.moveTo(px, py - 0.2 * k); ctx.lineTo(px + hsx * 0.55, py + hsy * 0.55 - 0.16 * k); ctx.stroke();
      ctx.fillStyle = "#2a2a2e"; ctx.beginPath(); ctx.arc(px + hsx * 0.6, py + hsy * 0.6 - 0.18 * k, lw * 0.6, 0, Math.PI * 2); ctx.fill();
    } else {
      const sw = walking ? Math.sin(p.ph) * 0.14 : 0, lx = hsx * sw, ly = hsy * sw, spread = crouch * 0.08 * s;
      ctx.fillRect(px - bw * 0.42 + lx - spread, py + ly - hip * k, lw, hip * k);
      ctx.fillRect(px + bw * 0.42 - lw - lx + spread, py - ly - hip * k, lw, hip * k);
      ctx.fillStyle = "#2a2a2e";
      ctx.fillRect(px - bw * 0.45 + lx - spread, py + ly - 0.13 * k, lw * 1.15, 0.13 * k);
      ctx.fillRect(px + bw * 0.45 - lw * 1.15 - lx + spread, py - ly - 0.13 * k, lw * 1.15, 0.13 * k);
    }
    if (away) arms(ctx, p, bx, by, hsx, hsy, bw, z1, s, k, sit, crouch);
    // the coat: puffy, lit on one side
    ctx.fillStyle = p.coat;
    roundRectFill(ctx, bx - bw / 2, by - z1 * k, bw, (z1 - z0) * k + 0.06 * s, 0.16 * s);
    if (s >= 12) { ctx.fillStyle = "rgba(30,30,45,.17)"; ctx.fillRect(bx, by - z1 * k + 0.1 * s, bw / 2 - 0.04 * s, (z1 - z0) * k - 0.06 * s); }
    // the scarf: round the neck, the ends hanging down the front (or flying behind)
    if (p.scarf) {
      ctx.fillStyle = p.scarf;
      roundRectFill(ctx, bx - bw * 0.48, by - (z1 + 0.04) * k, bw * 0.96, 0.12 * k, 0.05 * s);
      if (!away) ctx.fillRect(bx - bw * 0.3, by - (z1 - 0.04) * k, 0.1 * s, 0.34 * k);
      else ctx.fillRect(bx + bw * 0.12, by - (z1 - 0.04) * k, 0.1 * s, 0.26 * k);
    }
    if (!away) arms(ctx, p, bx, by, hsx, hsy, bw, z1, s, k, sit, crouch);
    // head, hair, hat
    const hr = 0.135 * s, hx = bx + hsx * crouch * 0.12, hy = by + hsy * crouch * 0.12 - (z1 + 0.17) * k;
    ctx.fillStyle = p.skin;
    ctx.beginPath(); ctx.arc(hx, hy, hr, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = p.hair;
    ctx.beginPath();
    if (away) ctx.arc(hx, hy, hr * 1.02, 0, Math.PI * 2);
    else ctx.arc(hx, hy - hr * 0.1, hr * 1.02, Math.PI * 1.02, Math.PI * 1.98);
    ctx.fill();
    if (p.hat) {
      ctx.fillStyle = p.knit;
      ctx.beginPath(); ctx.arc(hx, hy - hr * 0.12, hr * 1.08, Math.PI * 1.0, Math.PI * 2.0); ctx.fill();
      ctx.fillRect(hx - hr * 1.08, hy - hr * 0.3, hr * 2.16, hr * 0.38);
      if (p.hat === 3) { ctx.fillRect(hx - hr * 1.08, hy - hr * 0.1, hr * 0.45, hr * 0.8); ctx.fillRect(hx + hr * 0.63, hy - hr * 0.1, hr * 0.45, hr * 0.8); }
      if (p.hat === 2) { ctx.fillStyle = p.knit === "#f2efe8" || p.knit === "#e6e0d2" ? "#b3202a" : "#f2efe8"; ctx.beginPath(); ctx.arc(hx, hy - hr * 1.22, hr * 0.4, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  // arms by pose, as strokes from the shoulders, mittens on the ends (and a snowball in hand)
  function arms(ctx, p, bx, by, hsx, hsy, bw, z1, s, k, sit, crouch) {
    const side = p.lefty ? -1 : 1, shY = by - (z1 - 0.12) * k, lx = bx - bw * 0.44, rx = bx + bw * 0.44;
    let ax = lx - bw * 0.1, ay = shY + 0.55 * k, cx = rx + bw * 0.1, cy = shY + 0.55 * k, ball = false;
    const sw = p.mv > 0.2 ? Math.sin(p.ph) * 0.12 : 0;
    switch (p.pose) {
      case SCOOP: ax = bx + hsx * 0.25 - 0.08 * s; cx = bx + hsx * 0.25 + 0.08 * s; ay = cy = by + hsy * 0.25 - 0.1 * k; break;
      case PACK: ax = bx + hsx * 0.3 - 0.06 * s; cx = bx + hsx * 0.3 + 0.06 * s; ay = cy = by + hsy * 0.3 - (z1 - 0.38) * k; ball = true; break;
      case WIND: cx = bx + side * 0.2 * s - hsx * 0.3; cy = by - hsy * 0.3 - (z1 + 0.45) * k; ax = bx + hsx * 0.45 - side * 0.1 * s; ay = by + hsy * 0.45 - (z1 - 0.12) * k; ball = true; break;
      case THROW: cx = bx + hsx * 0.55 + side * 0.08 * s; cy = by + hsy * 0.55 - (z1 - 0.2) * k; ax = bx - hsx * 0.25 - side * 0.2 * s; ay = by - hsy * 0.25 - (z1 - 0.5) * k; break;
      case DUCK: ax = bx - 0.1 * s + hsx * 0.1; cx = bx + 0.1 * s + hsx * 0.1; ay = cy = by - (z1 + 0.22) * k; break;
      case HIT: ax = bx - 0.55 * s; cx = bx + 0.55 * s; ay = cy = by - (z1 - 0.05) * k; break;
      case CHEER: ax = bx - 0.22 * s; cx = bx + 0.22 * s; ay = cy = by - (z1 + 0.55) * k; break;
      case PULL: cx = bx - hsx * 0.38 + side * 0.12 * s; cy = by - hsy * 0.38 - (z1 - 0.62) * k; ax = lx - bw * 0.1 + hsx * sw; ay = shY + 0.55 * k + hsy * sw; break;
      case SIT: ax = bx - bw * 0.62; cx = bx + bw * 0.62; ay = cy = by - 0.22 * k; break;
      default: ax += hsx * sw; ay += hsy * sw; cx -= hsx * sw; cy -= hsy * sw;
    }
    ctx.strokeStyle = p.coat; ctx.lineWidth = Math.max(1, 0.13 * s);
    ctx.beginPath();
    ctx.moveTo(side > 0 ? rx : lx, shY); ctx.lineTo(side > 0 ? cx : ax, side > 0 ? cy : ay);
    ctx.moveTo(side > 0 ? lx : rx, shY); ctx.lineTo(side > 0 ? ax : cx, side > 0 ? ay : cy);
    ctx.stroke();
    if (s >= 8) {
      ctx.fillStyle = p.mitt;
      ctx.beginPath(); ctx.arc(ax, ay, 0.065 * s, 0, Math.PI * 2); ctx.moveTo(cx + 0.065 * s, cy); ctx.arc(cx, cy, 0.065 * s, 0, Math.PI * 2); ctx.fill();
    }
    if (ball) {
      const bxp = p.pose === PACK ? (ax + cx) / 2 : side > 0 ? cx : ax, byp = p.pose === PACK ? ay - 0.04 * k : (side > 0 ? cy : ay) - 0.05 * k;
      snowBall(ctx, bxp, byp, Math.max(1.2, 0.09 * s), Math.max(1.2, 0.09 * s));
    }
  }
  // fallen off the sled: flat on their back in the snow
  function drawLying(ctx, p, px, gy, s, k, close) {
    const hx = p.hx, hy = p.hy;
    const fx = SX(p.x - hx * 0.75, p.y - hy * 0.75), fy = SY(p.x - hx * 0.75, p.y - hy * 0.75, 0.12);
    const mx = SX(p.x - hx * 0.05, p.y - hy * 0.05), my = SY(p.x - hx * 0.05, p.y - hy * 0.05, 0.16);
    const sx2 = SX(p.x + hx * 0.55, p.y + hy * 0.55), sy2 = SY(p.x + hx * 0.55, p.y + hy * 0.55, 0.18);
    const qx = SX(p.x + hx * 0.78, p.y + hy * 0.78), qy = SY(p.x + hx * 0.78, p.y + hy * 0.78, 0.15);
    ctx.fillStyle = SHADOW;
    ctx.beginPath(); ctx.ellipse(px + 0.15 * s, gy + 0.03 * s, 0.85 * s, 0.32 * s, 0, 0, Math.PI * 2); ctx.fill();
    ctx.lineCap = "round";
    ctx.strokeStyle = p.pants; ctx.lineWidth = Math.max(1, 0.3 * s);
    ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(mx, my); ctx.stroke();
    ctx.strokeStyle = p.coat; ctx.lineWidth = Math.max(1.4, 0.48 * s);
    ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(sx2, sy2); ctx.stroke();
    if (close) {
      // arms flung out
      ctx.lineWidth = Math.max(1, 0.12 * s);
      const ox = PA * -hy + PB * hx, oy = PC * -hy + PD * hx;
      ctx.beginPath(); ctx.moveTo(sx2 - ox * 0.2, sy2 - oy * 0.2); ctx.lineTo(sx2 - ox * 0.62 + (qx - sx2) * 0.6, sy2 - oy * 0.62 + (qy - sy2) * 0.6);
      ctx.moveTo(sx2 + ox * 0.2, sy2 + oy * 0.2); ctx.lineTo(sx2 + ox * 0.62 + (qx - sx2) * 0.6, sy2 + oy * 0.62 + (qy - sy2) * 0.6); ctx.stroke();
    }
    ctx.fillStyle = p.skin;
    ctx.beginPath(); ctx.arc(qx, qy, Math.max(1, 0.14 * s), 0, Math.PI * 2); ctx.fill();
    if (p.hat) { ctx.fillStyle = p.knit; ctx.beginPath(); ctx.arc(qx + (qx - sx2) * 0.25, qy + (qy - sy2) * 0.25, Math.max(0.8, 0.12 * s), 0, Math.PI * 2); ctx.fill(); }
  }

  // ---------------------------------------------------------------- sleds, snowballs, fort blocks, puffs
  const Qx = [0, 0, 0, 0], Qy = [0, 0, 0, 0];
  function quadAt(x, y, hx, hy, l0, l1, w, z, zf) {
    // corners of a flat piece from l0 to l1 along (hx, hy), ±w across, at height z (front edge at zf)
    const nx = -hy, ny = hx;
    const c = [[l1, w, zf], [l1, -w, zf], [l0, -w, z], [l0, w, z]];
    for (let q = 0; q < 4; q++) { const gx = x + hx * c[q][0] + nx * c[q][1], gy = y + hy * c[q][0] + ny * c[q][1]; Qx[q] = SX(gx, gy); Qy[q] = SY(gx, gy, c[q][2]); }
  }
  function fillQuad(ctx) { ctx.beginPath(); ctx.moveTo(Qx[0], Qy[0]); ctx.lineTo(Qx[1], Qy[1]); ctx.lineTo(Qx[2], Qy[2]); ctx.lineTo(Qx[3], Qy[3]); ctx.fill(); }
  function drawSled(ctx, p, close) {
    const sl = p.sled, s = SCALE, x = sl.x, y = sl.y, hx = sl.hx, hy = sl.hy;
    const px = SX(x, y), py = SY(x, y, 0);
    ctx.fillStyle = SHADOW;
    ctx.beginPath(); ctx.ellipse(px + 0.12 * s, py + 0.03 * s, 0.6 * s, 0.24 * s, 0, 0, Math.PI * 2); ctx.fill();
    // the rope to whoever is pulling it
    if (p.pose === PULL && s >= 4) {
      const fr = sl.kind === "saucer" ? 0.38 : sl.kind === "tray" ? 0.22 : 0.52, hand = p.kid * 0.82;
      const ax = x + hx * fr, ay = y + hy * fr, rx = p.x - p.hx * 0.32, ry = p.y - p.hy * 0.32;
      ctx.strokeStyle = "#5c4c3c"; ctx.lineWidth = Math.max(0.6, 0.03 * s);
      ctx.beginPath(); ctx.moveTo(SX(ax, ay), SY(ax, ay, 0.2));
      ctx.quadraticCurveTo(SX((ax + rx) / 2, (ay + ry) / 2), SY((ax + rx) / 2, (ay + ry) / 2, 0.18), SX(rx, ry), SY(rx, ry, hand));
      ctx.stroke();
    }
    if (sl.kind === "saucer") {
      const r = 0.4 * s;
      ctx.fillStyle = shade(sl.col, 0.82); ctx.beginPath(); ctx.ellipse(px, py - 0.06 * PK, r, r * SIN_T, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = sl.col; ctx.beginPath(); ctx.ellipse(px - r * 0.06, py - 0.1 * PK, r * 0.86, r * 0.86 * SIN_T, 0, 0, Math.PI * 2); ctx.fill();
      return;
    }
    if (sl.kind === "tray") {
      quadAt(x, y, hx, hy, -0.24, 0.24, 0.18, 0.04, 0.04);
      ctx.fillStyle = shade(sl.col, 0.85); fillQuad(ctx);
      quadAt(x, y, hx, hy, -0.2, 0.2, 0.14, 0.05, 0.05);
      ctx.fillStyle = sl.col; fillQuad(ctx);
      return;
    }
    if (sl.kind === "wooden") {
      // two runners curling up at the front, slats on top
      ctx.strokeStyle = "#3d3a38"; ctx.lineWidth = Math.max(0.7, 0.04 * s);
      ctx.beginPath();
      for (let side = -1; side <= 1; side += 2) {
        const nx = -hy * side * 0.2, ny = hx * side * 0.2;
        ctx.moveTo(SX(x - hx * 0.5 + nx, y - hy * 0.5 + ny), SY(x - hx * 0.5 + nx, y - hy * 0.5 + ny, 0.02));
        ctx.lineTo(SX(x + hx * 0.45 + nx, y + hy * 0.45 + ny), SY(x + hx * 0.45 + nx, y + hy * 0.45 + ny, 0.02));
        ctx.quadraticCurveTo(SX(x + hx * 0.62 + nx, y + hy * 0.62 + ny), SY(x + hx * 0.62 + nx, y + hy * 0.62 + ny, 0.05), SX(x + hx * 0.5 + nx, y + hy * 0.5 + ny), SY(x + hx * 0.5 + nx, y + hy * 0.5 + ny, 0.22));
      }
      ctx.stroke();
      quadAt(x, y, hx, hy, -0.46, 0.38, 0.23, 0.16, 0.16);
      ctx.fillStyle = sl.col; fillQuad(ctx);
      if (close && s >= 10) {
        ctx.strokeStyle = shade(sl.col, 0.75); ctx.lineWidth = Math.max(0.5, 0.02 * s);
        ctx.beginPath();
        for (let q = -0.3; q < 0.35; q += 0.17) { const a1 = x + hx * q - hy * 0.23, b1 = y + hy * q + hx * 0.23, a2 = x + hx * q + hy * 0.23, b2 = y + hy * q - hx * 0.23; ctx.moveTo(SX(a1, b1), SY(a1, b1, 0.16)); ctx.lineTo(SX(a2, b2), SY(a2, b2, 0.16)); }
        ctx.stroke();
      }
      return;
    }
    // a plastic toboggan: a long tray, its front curled up
    quadAt(x, y, hx, hy, -0.55, 0.45, 0.25, 0.06, 0.06);
    ctx.fillStyle = shade(sl.col, 0.8); fillQuad(ctx);
    quadAt(x, y, hx, hy, -0.5, 0.42, 0.2, 0.09, 0.09);
    ctx.fillStyle = sl.col; fillQuad(ctx);
    quadAt(x, y, hx, hy, 0.42, 0.56, 0.25, 0.06, 0.3);
    ctx.fillStyle = shade(sl.col, hx * D0 + hy * D1 < 0 ? 0.92 : 0.72); fillQuad(ctx);
  }
  function drawBall(ctx, g, b) {
    const S = g.S, s = SCALE, x = gxL(S, b.u, b.v), y = gyL(S, b.u, b.v);
    if (s < 3.5) return;
    const px = SX(x, y), gy = SY(x, y, 0), py = gy - b.z * PK, r = Math.max(1.3, 0.1 * s);
    b.vis = true;
    if (s >= 6) { ctx.fillStyle = SHADOW; ctx.beginPath(); ctx.ellipse(px, gy, r, r * 0.5, 0, 0, Math.PI * 2); ctx.fill(); }
    snowBall(ctx, px, py, r, r);
    if (s >= 8) { ctx.strokeStyle = "rgba(120,138,170,.55)"; ctx.lineWidth = Math.max(0.5, 0.015 * s); ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.stroke(); }
  }
  function drawBlock(ctx, S, B) {
    // a block of packed snow: a little box, top lit, faces toward the camera shaded by which way they face
    const x = gxL(S, B.u, B.v), y = gyL(S, B.u, B.v), ang = S.ang + B.rot, ca = Math.cos(ang), sa = Math.sin(ang);
    const ux = ca * B.a, uy = sa * B.a, vx = -sa * B.b, vy = ca * B.b;
    const cxs = [x - ux - vx, x + ux - vx, x + ux + vx, x - ux + vx], cys = [y - uy - vy, y + uy - vy, y + uy + vy, y - uy + vy];
    for (let q = 0; q < 4; q++) {
      const n = (q + 1) % 4, ex = cxs[n] - cxs[q], ey = cys[n] - cys[q];
      // outward normal (the corners run anticlockwise)
      const nx = ey, ny = -ex;
      if (nx * D0 + ny * D1 >= 0) continue;
      const lit = PA * nx + PB * ny < 0;
      ctx.fillStyle = lit ? "#eef1f4" : SNOW_SHADE;
      ctx.beginPath();
      ctx.moveTo(SX(cxs[q], cys[q]), SY(cxs[q], cys[q], 0)); ctx.lineTo(SX(cxs[n], cys[n]), SY(cxs[n], cys[n], 0));
      ctx.lineTo(SX(cxs[n], cys[n]), SY(cxs[n], cys[n], B.h)); ctx.lineTo(SX(cxs[q], cys[q]), SY(cxs[q], cys[q], B.h));
      ctx.fill();
    }
    ctx.fillStyle = SNOW_LIT;
    ctx.beginPath();
    for (let q = 0; q < 4; q++) q ? ctx.lineTo(SX(cxs[q], cys[q]), SY(cxs[q], cys[q], B.h)) : ctx.moveTo(SX(cxs[q], cys[q]), SY(cxs[q], cys[q], B.h));
    ctx.fill();
  }
  function drawPuff(ctx, k) {
    const s = SCALE, x = puffs[5 * k], y = puffs[5 * k + 1], z = puffs[5 * k + 2], age = puffs[5 * k + 3] / PUFF_LIFE, size = puffs[5 * k + 4];
    if (s < 3.5) return;
    const px = SX(x, y), py = SY(x, y, z), spread = (0.12 + 0.5 * Math.sqrt(age)) * size * s, r = Math.max(0.9, (0.07 + 0.05 * (1 - age)) * size * s);
    ctx.fillStyle = "rgba(150,166,195,.55)";
    ctx.beginPath();
    for (let q = 0; q < 7; q++) {
      const a = q * 0.898 + k, d = spread * (0.6 + 0.4 * ((q * 37) % 5) / 4), qx = px + Math.cos(a) * d, qy = py + Math.sin(a) * d * 0.7 - age * 0.25 * PK + (z <= 0 ? -spread * 0.3 : 0);
      ctx.moveTo(qx + r + 0.6, qy + 0.6); ctx.arc(qx + 0.6, qy + 0.6, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.fillStyle = SNOW_LIT;
    ctx.beginPath();
    for (let q = 0; q < 7; q++) {
      const a = q * 0.898 + k, d = spread * (0.6 + 0.4 * ((q * 37) % 5) / 4), qx = px + Math.cos(a) * d, qy = py + Math.sin(a) * d * 0.7 - age * 0.25 * PK + (z <= 0 ? -spread * 0.3 : 0);
      ctx.moveTo(qx + r, qy); ctx.arc(qx, qy, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  // ================================================================================================ clicks and cards
  function hit(px, py) {
    if (!C.on || SCALE < MIN_S || (!nHits && !visTrails.length)) return null;
    let best = null, bd = Infinity;
    for (let q = 0; q < nHits; q++) {
      const h = hits[q], d = (px - h.px) ** 2 + (py - h.py) ** 2;
      if (d < h.r * h.r && d < bd) { bd = d; best = h.S; }
    }
    if (best) return best;
    // a trail of footprints: within a few pixels of its line
    for (const S of visTrails) {
      const r = Math.max(6, 0.5 * SCALE), P = S.pts;
      for (let q = 0; q + 3 < P.length; q += 2) {
        const ax = SX(P[q], P[q + 1]), ay = SY(P[q], P[q + 1], 0), bx = SX(P[q + 2], P[q + 3]), by = SY(P[q + 2], P[q + 3], 0);
        if (segDist(px, py, ax, ay, bx, by) < r) return S;
      }
    }
    return null;
  }
  let card = null, cardSite = null, cardRefs = null, cardTimer = 0;
  function onClick(S) {
    const ui = app.ui;
    if (!S || !ui || !ui.card) return;
    const where = S.name || (S.type === SLED ? "the water's edge" : "a snowy lawn");
    let title = "", sub = "", body = null, anchor = { x: S.x, y: S.y, z: 1 };
    closeCardTimer();
    cardSite = S; cardRefs = null;
    if (S.type === SNOWMAN) {
      cue("crunch", S.x, S.y, true);
      title = S.nick; sub = `Snowman · ${where}`;
      body = snowmanBody(S);
      anchor = { x: S.x, y: S.y, z: S.height * 0.6 };
    } else if (S.type === ANGEL) {
      cue("crunch", S.x, S.y, true);
      const n = S.angels.length / 3;
      title = n > 1 ? `${n} snow angels` : "A snow angel"; sub = where;
      body = factsBody(angelLines(S, n));
      anchor = { x: S.x, y: S.y, z: 0 };
    } else if (S.type === TRAIL && !S.scene) {
      cue("crunch", S.x, S.y, true);
      title = "Footprints"; sub = where;
      body = factsBody(trailLines(S));
      anchor = { x: S.x, y: S.y, z: 0 };
    } else if (S.type === FIGHT) {
      cue("snowball", S.x, S.y, true);
      const g = S.scene;
      title = "Snowball fight";
      sub = g ? `${where} · ${teamCount(g, 0)} v ${teamCount(g, 1)}` : `${where} · ceasefire`;
      cardRefs = fightBody(S);
      body = cardRefs.el;
      anchor = () => (S.scene && S.scene.P.length ? anchorOf(S, S.scene) : { x: S.cx, y: S.cy, z: 0.5 });
    } else if (S.type === SLED) {
      cue("crunch", S.x, S.y, true);
      title = "Sledding"; sub = S.name ? `The bank of ${S.name.replace(/^the /i, "the ")}` : "A bank by the water";
      cardRefs = sledBody(S);
      body = cardRefs.el;
      anchor = () => (S.scene && S.scene.P.length ? anchorOf(S, S.scene) : { x: S.cx, y: S.cy, z: 0.5 });
    } else if (S.type === TRAIL) {
      cue("crunch", S.x, S.y, true);
      const g = S.scene, rider = g && g.P[1];
      title = rider ? "Sled ride" : "Out with the sled"; sub = where;
      body = factsBody([
        rider ? "One passenger, one engine." : "Heading somewhere with a slope, presumably.",
        `Sled: ${g ? g.P[0].sled.name : "a sled"}.`,
        "Following their own footprints, mostly.",
      ]);
      anchor = () => (g && S.scene === g ? { x: g.P[0].x, y: g.P[0].y, z: 1 } : { x: S.x, y: S.y, z: 0 });
    }
    card = ui.card({ id: "snowday", title, subtitle: sub, color: "#8fb3d3", body, anchor, onClose: () => { closeCardTimer(); card = null; cardSite = null; cardRefs = null; } });
    if (cardRefs) { refreshCard(); cardTimer = setInterval(refreshCard, 500); }
    app.requestRender("snowday");
  }
  function closeCardTimer() { if (cardTimer) { clearInterval(cardTimer); cardTimer = 0; } }
  const teamCount = (g, t) => { let n = 0; for (const p of g.P) if (p.team === t) n++; return n; };
  function factsBody(lines, lede) {
    const el = document.createElement("div");
    el.className = "snowday-card";
    if (lede) { const p = document.createElement("p"); p.className = "snowday-lede"; p.textContent = lede; el.append(p); }
    const ul = document.createElement("ul");
    ul.className = "snowday-facts";
    for (const l of lines) { const li = document.createElement("li"); li.textContent = l; ul.append(li); }
    el.append(ul);
    const note = document.createElement("p");
    note.className = "snowday-note";
    note.textContent = "Imagined from the snow on the ground and the hour; not live.";
    el.append(note);
    return el;
  }
  function whenText(b) {
    if (!b) return "recently";
    const part = b.hour < 12 ? "morning" : b.hour < 17 ? "afternoon" : "evening";
    if (b.back === 0) return `this ${part}`;
    if (b.back === 1) return `yesterday ${part}`;
    return `${DAYS[(((b.day + 4) % 7) + 7) % 7]} ${part}`;
  }
  function snowmanBody(S) {
    const L = S.lines, m = S.melt, b = S.built;
    const tall = S.height;
    const lines = [`Built ${whenText(b)}.`];
    lines.push(tall < 0.9 ? `About ${Math.round(tall * 100)} cm tall. Small but determined.` : tall > 2.1 ? `About ${tall.toFixed(1)} m tall. Somebody brought a ladder, or a friend.` : `About ${tall.toFixed(1)} m tall${S.hat ? ", hat included" : ""}.`);
    lines.push(["Carrot: organic.", "Nose: carrot, slightly judgemental.", "Carrot: borrowed from someone's lunch.", "Nose: a carrot, firmly attached."][(L[0] * 4) | 0]);
    const hatLine = S.hat === H_TOP ? "Top hat: very formal. Provenance: unclear." : S.hat === H_CONE ? "Hat: a traffic cone. Nobody saw anything." : S.hat === H_POT ? "Hat: a saucepan, which someone will want back." : S.hat === H_CAP ? "Cap: worn forwards, for once." : S.hat === H_BEANIE ? ["Hat: borrowed.", "Hat: on loan, apparently.", "Hat: knitted, possibly by a grandmother."][(L[1] * 3) | 0] : "Hat: none. Braving it.";
    lines.push(hatLine);
    if (S.scarf >= 0) lines.push(`Scarf: ${SCARF_NAMES[S.scarf]}${S.stripe ? ", striped" : ""}, ${["donated by a roommate", "someone's spare", "returned by the weekend, hopefully"][(L[2] * 3) | 0]}.`);
    lines.push(m < 0.12 ? "Condition: crisp." : m < 0.4 ? "Condition: leaning slightly. Says it's fine." : m < 0.75 ? "Condition: melting with dignity." : "Condition: more puddle than person.");
    if (S.melt < 0.05) lines.push(C.temp <= 32 ? "Outlook: good for as long as the cold holds." : "Outlook: enjoy it while it lasts.");
    return factsBody(lines);
  }
  function angelLines(S, n) {
    const L = S.lines, b = S.built;
    return [
      `Made ${whenText(b)}.`,
      `Wingspan: about ${(1.6 + L[0] * 0.4).toFixed(1)} m.`,
      "Halo: implied.",
      ["Getting up without wrecking it: nailed it.", "Getting up without wrecking it: mostly.", "Getting up without wrecking it: see the scuff by the feet."][(L[1] * 3) | 0],
      ...(n > 1 ? [`A choir of ${n}.`] : []),
    ];
  }
  function trailLines(S) {
    const steps = Math.round(S.len / 0.78), L = S.lines;
    return [
      `About ${steps} steps across ${S.name || "the lawn"}${S.walkers > 1 ? ", two people side by side" : ""}.`,
      ["Shortcut rating: excellent.", "Route: not the path. Never the path.", "Destination: somewhere warm, probably."][(L[0] * 3) | 0],
      ["Boot size: generous.", "Pace: someone late for class.", "Gait: careful on the icy bits."][(L[1] * 3) | 0],
    ];
  }
  function fightBody(S) {
    const el = document.createElement("div");
    el.className = "snowday-card";
    el.innerHTML = `<div class="snowday-score"><span class="snowday-team"></span><b class="snowday-n"></b><i>–</i><b class="snowday-n"></b><span class="snowday-team"></span></div><ul class="snowday-facts"></ul><p class="snowday-note">Imagined from the snow on the ground and the hour; not live.</p>`;
    const teams = el.querySelectorAll(".snowday-team"), ns = el.querySelectorAll(".snowday-n");
    return { el, teams, ns, facts: el.querySelector(".snowday-facts"), key: "" };
  }
  function sledBody(S) {
    const el = document.createElement("div");
    el.className = "snowday-card";
    el.innerHTML = `<p class="snowday-lede"></p><ul class="snowday-facts"></ul><p class="snowday-note">Imagined from the snow on the ground and the hour; not live.</p>`;
    return { el, lede: el.querySelector(".snowday-lede"), facts: el.querySelector(".snowday-facts"), key: "" };
  }
  function refreshCard() {
    const S = cardSite, R = cardRefs;
    if (!card || !S || !R) return;
    const g = S.scene;
    let lines;
    if (S.type === FIGHT) {
      const names = g ? g.names : ["Mittens", "Yetis"], sc = g ? g.score : [0, 0];
      R.teams[0].textContent = names[0]; R.teams[1].textContent = names[1];
      R.ns[0].textContent = sc[0]; R.ns[1].textContent = sc[1];
      lines = g ? [
        `Snowballs thrown: ${g.thrown}.`,
        `Direct hits: ${sc[0] + sc[1]} · dodges: ${g.dodges}.`,
        `${g.names[sc[0] >= sc[1] ? 0 : 1]} ${sc[0] === sc[1] ? "level, for now" : Math.abs(sc[0] - sc[1]) > 4 ? "running away with it" : "edging it"}.`,
        "Rules: none observed.",
      ] : ["Everyone has gone in for hot chocolate.", "Result: disputed."];
    } else {
      const n = g ? g.P.length : 0;
      R.lede.textContent = g ? `${n} ${n === 1 ? "sledder" : "sledders"} on the bank${g.P.some((p) => p.st === S_SLIDE) ? (n === 1 ? ", going down right now" : ", one of them going down right now") : ""}.` : "Nobody on it just now. The run is still there.";
      lines = g ? [
        `Runs so far: ${g.runs}.`,
        `Top speed: about ${Math.max(8, Math.round(g.top * 3.6))} km/h. Claimed: ${Math.max(40, Math.round(g.top * 3.6 * 4 / 5) * 5)}.`,
        `Sleds: ${listOf(g.P.map((p) => p.sled.name))}.`,
        `Run: ${Math.round(S.L)} m, stopping short of the water${S.lines[0] < 0.5 ? " (that's the important bit)" : ""}.`,
        "Hill: modest. Enthusiasm: immense.",
      ] : ["Hill: modest. Enthusiasm: currently indoors."];
    }
    const key = lines.join("|");
    if (key !== R.key) {
      R.key = key;
      R.facts.replaceChildren(...lines.map((l) => { const li = document.createElement("li"); li.textContent = l; return li; }));
    }
    if (S.type === FIGHT && g) { const sub = `${S.name || "a snowy lawn"} · ${teamCount(g, 0)} v ${teamCount(g, 1)}`; if (sub !== R.sub) { R.sub = sub; card.update({ subtitle: sub }); } }
  }
  function anchorOf(S, g) {
    let x = 0, y = 0;
    for (const p of g.P) { x += p.x; y += p.y; }
    return { x: x / g.P.length, y: y / g.P.length, z: 1.2 };
  }
  function listOf(a) {
    const u = [...new Set(a)];
    return u.length <= 1 ? u[0] || "" : `${u.slice(0, -1).join(", ")} and ${u[u.length - 1]}`;
  }
  // sounds: another module may provide app.sound; never fail without it, and don't chatter
  let cueAt = 0;
  function cue(name, x, y, click) {
    const now = performance.now();
    if (!click && now - cueAt < 1500) return;
    cueAt = now;
    try { if (app.sound && app.sound.cue) app.sound.cue(name, { x, y }); } catch (e) { /* the sound is a nicety */ }
  }
  injectStyle();
  function injectStyle() {
    if (document.getElementById("snowday-style")) return;
    const st = document.createElement("style");
    st.id = "snowday-style";
    st.textContent = `
      .snowday-card { font: 13px/1.45 "Inter", system-ui, sans-serif; }
      .snowday-lede { margin: 0 0 6px; font: italic 15px/1.35 "Fraunces", Georgia, serif; color: var(--ink, #2a2622); }
      .snowday-facts { margin: 0; padding: 0; list-style: none; }
      .snowday-facts li { position: relative; padding-left: 14px; margin: 2px 0; }
      .snowday-facts li::before { content: "❄"; position: absolute; left: 0; top: 0; font-size: 9px; color: #8fb3d3; }
      .snowday-score { display: flex; align-items: baseline; justify-content: center; gap: 8px; margin: 2px 0 8px; }
      .snowday-score b { font: 500 28px/1 "Fraunces", Georgia, serif; color: var(--ink, #2a2622); min-width: 1ch; text-align: center; }
      .snowday-score i { font: 400 20px/1 "Fraunces", Georgia, serif; color: var(--mute, #7a7064); font-style: normal; }
      .snowday-team { font: italic 14px/1.2 "Fraunces", Georgia, serif; color: var(--mute, #7a7064); flex: 1; }
      .snowday-team:first-child { text-align: right; }
      .snowday-note { margin: 8px 0 0; font-size: 11px; color: var(--mute, #7a7064); }
    `;
    document.head.append(st);
  }

  // ================================================================================================ wiring
  app.on("frame", (f) => {
    if (failed) return;
    try {
      manage(false);
      if (!reduceMQ.matches && C.on) stepAll(f.dt);
    } catch (e) {
      failed = true; dropAll();
      console.error("snowday: stopped", e);
    }
  });
  // with the map asleep, a scene that starts in view still has to wake it
  setInterval(() => { if (!failed && !document.hidden) { try { manage(false); } catch (e) { failed = true; console.error("snowday: stopped", e); } } }, 1000);
  app.on("layers", (p) => {
    if (p && (p.id === "people" || p.id === "sky")) { condAt = -1e9; tickAt = -1e9; if (!p.on && p.id === "people") for (const S of sites) S.scene = null; app.requestRender("snowday"); }
  });
  app.on("weather", () => { condAt = -1e9; });
  app.on("style", () => {
    condAt = -1e9;
    // under ?snowday=1 the snow stays on the map, whatever the weather says
    if (FORCE && !app.params.has("snow") && !((app.tileStyle.snow || 0) >= GROUND_MIN)) setTimeout(() => app.setTileStyle({ snow: 0.8 }), 0);
  });
  app.on("rotate", () => { for (const S of sites) { S.occR = -1; S.occ = null; S.hidR = -1; } });

  app.addLayer({
    id: "snowday", z: 32,
    fps: () => (C.on && C.sky ? want : 0),
    draw: (ctx, f) => { try { draw(ctx, f); } catch (e) { if (!failed) console.error("snowday: draw", e); failed = true; whimsy.snowday = 0; } },
    hit: (px, py) => (failed ? null : hit(px, py)),
    onClick: (S) => onClick(S),
  });

  app.snowday = {
    get things() { return whimsy.snowday; },
    get on() { return C.on; },
    debug: {
      conditions: C,
      sites() {
        const out = {};
        for (const S of sites) { const k = ["", "snowman", "angel", "trail", "fight", "sled"][S.type]; out[k] = (out[k] || 0) + 1; }
        return out;
      },
      // what's near the view: type, where, whether it's built or busy (for tests: fly there and look)
      list() {
        return near.map((S) => {
          const [lat, lon] = geo.toLatLon(S.cx, S.cy), g = S.scene;
          return { type: ["", "snowman", "angel", "trail", "fight", "sled"][S.type], lat: +lat.toFixed(6), lon: +lon.toFixed(6), name: S.name,
            built: S.built ? whenText(S.built) : null, melt: +S.melt.toFixed(2), people: g ? g.P.length : 0, score: g && g.score ? g.score.slice() : null };
        });
      },
      // open the card of the nearest place of a type to the middle of the view
      click(type) {
        const t = { snowman: SNOWMAN, angel: ANGEL, trail: TRAIL, fight: FIGHT, sled: SLED }[type];
        const g = view.screenToGround(VW / 2, VH / 2);
        let best = null, bd = Infinity;
        for (const S of near) if (S.type === t) { const d = Math.hypot(S.cx - g[0], S.cy - g[1]); if (d < bd) { bd = d; best = S; } }
        if (best) onClick(best);
        return best ? geo.toLatLon(best.cx, best.cy) : null;
      },
      // where the places of a type are (searched lawns and banks only), nearest the middle of the view first
      where(type, n = 5) {
        const t = { snowman: SNOWMAN, angel: ANGEL, trail: TRAIL, fight: FIGHT, sled: SLED }[type];
        const g = view.screenToGround(VW / 2, VH / 2);
        return sites.filter((S) => S.type === t).sort((a, b) => Math.hypot(a.cx - g[0], a.cy - g[1]) - Math.hypot(b.cx - g[0], b.cy - g[1])).slice(0, n)
          .map((S) => geo.toLatLon(S.cx, S.cy).map((v) => +v.toFixed(6)));
      },
      // search every lawn and bank now (slow; for tests)
      searchAll() {
        setCamera();
        for (const L of lawns) if (!L.done) searchLawn(L);
        if (!bankReady) bankSamples();
        for (const c of bankCells.values()) if (c.state === 0) evalBankCell(c);
        for (const c of bankCells.values()) if (c.state === 1) finalBankCell(c);
        return this.sites();
      },
      advance(sec, dt = 0.05) { for (let t = 0; t < sec; t += dt) stepAll(dt); return this.list().filter((x) => x.people).length; },
    },
  };
  Object.defineProperty(app.snowday, "debug", { enumerable: false });
}

// ------------------------------------------------------------------------------------------------ helpers
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function smooth(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
function segDist(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / L, 0, 1) : 0;
  return Math.hypot(x - ax - dx * t, y - ay - dy * t);
}
function ringBox(f) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < f.length; k += 2) { if (f[k] < x0) x0 = f[k]; if (f[k] > x1) x1 = f[k]; if (f[k + 1] < y0) y0 = f[k + 1]; if (f[k + 1] > y1) y1 = f[k + 1]; }
  return [x0, y0, x1, y1];
}
function ringArea(f) {
  let A = 0;
  for (let k = 0, j = f.length - 2; k < f.length; j = k, k += 2) A += f[j] * f[k + 1] - f[k] * f[j + 1];
  return Math.abs(A) / 2;
}
// distance (in cells) from each open cell (> 0) to the nearest blocked one (0), or past the grid's edge
function chamfer(D, nx, ny) {
  const S2 = Math.SQRT2;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    if (D[k] === 0) continue;
    let d = D[k];
    d = Math.min(d, i > 0 ? D[k - 1] + 1 : 1, j > 0 ? D[k - nx] + 1 : 1);
    d = Math.min(d, i > 0 && j > 0 ? D[k - nx - 1] + S2 : 1, i < nx - 1 && j > 0 ? D[k - nx + 1] + S2 : 1);
    D[k] = d;
  }
  for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const k = j * nx + i;
    if (D[k] === 0) continue;
    let d = D[k];
    d = Math.min(d, i < nx - 1 ? D[k + 1] + 1 : 1, j < ny - 1 ? D[k + nx] + 1 : 1);
    d = Math.min(d, i < nx - 1 && j < ny - 1 ? D[k + nx + 1] + S2 : 1, i > 0 && j < ny - 1 ? D[k + nx - 1] + S2 : 1);
    D[k] = d;
  }
}
function roundRectFill(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2))); else ctx.rect(x, y, w, h);
  ctx.fill();
}
const SHADES = new Map();
function shade(hex, f) {
  const key = hex + f;
  let v = SHADES.get(key);
  if (v) return v;
  const n = parseInt(hex.slice(1), 16), r = Math.round(((n >> 16) & 255) * f), g = Math.round(((n >> 8) & 255) * f), b = Math.round((n & 255) * f);
  v = `rgb(${r},${g},${b})`;
  SHADES.set(key, v);
  return v;
}
function twoNames(R) {
  const a = (R() * TEAM_NAMES.length) | 0;
  let b = (R() * (TEAM_NAMES.length - 1)) | 0;
  if (b >= a) b++;
  return [TEAM_NAMES[a], TEAM_NAMES[b]];
}
// the campus's own calendar day, as a day number (days since 1970-01-01), whatever the visitor's time zone
const DATE_FMT = (() => { try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric" }); } catch { return null; } })();
function dayNumber(d) {
  if (DATE_FMT) {
    let y = 1970, m = 1, dd = 1;
    for (const p of DATE_FMT.formatToParts(d)) { if (p.type === "year") y = +p.value; else if (p.type === "month") m = +p.value; else if (p.type === "day") dd = +p.value; }
    return Math.round(Date.UTC(y, m - 1, dd) / 864e5);
  }
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 864e5);
}
function hashInt(a, b) {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}
const hash01 = (a, b) => hashInt(a, b) / 4294967296;
// a small seeded generator (mulberry32): the same draws for the same place and hour
function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
