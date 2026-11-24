// Autumn leaves. In autumn and late autumn the broad-leaved trees let their leaves go: each flutters down with a little
// spin and sway, drifts with the wind (app.weather.windMph; windDir is where it blows FROM) and comes to rest on the
// ground, where gusts now and then send some skittering on, or lift a swirl of them across a lawn or a street. Few when
// it's calm, more when it's windy; wet leaves don't fly (rain thins them out); none in the other seasons, none under snow.
//
// The colours are the tiles' own (render.js: the LEAF crown palettes and the REMNANT leaves, picked by the same per-tree
// hashes), so a leaf matches the crown it falls from. Which trees still have leaves to drop follows renderer.treeBare:
// in late autumn most broad-leaved trees stand bare and drop nothing but the few remnant leaves the tiles draw on some of
// them, though their fallen leaves still lie beneath them. Conifers keep their needles.
//
// Late autumn also brings leaf piles on some lawns: at most one per 26 m cell, picked by a hash of the cell and the date,
// beside a broad-leaved tree on a lawn and clear of paths, roads, trees and buildings. By day someone now and then rakes
// one (a walker-style person with a rake), and once in a while a kid runs up and jumps in, scattering it in a burst of
// leaves (the next spell, somebody rakes it back up). Each pile's goings-on come from the clock in slots (a hash of the
// pile and the slot), so a pile shows the same thing for everyone and whenever it comes back into view; gusts too come
// from the clock.
//
// Layers: "leaves-ground" z 25 (leaves lying and skittering, the piles with their rakers and jumpers, and the falling
// leaves' shadows; under cars and walkers) and "leaves" z 38 (leaves in the air, above the walkers, under the night
// tint). No switch of their own: they follow "sky" (Real sky & weather); the rakers and the kids also follow "people".
// Only the trees and piles near the view are simulated: the airborne leaves from street zoom, the lying ones closer
// still; from afar nothing moves and both layers ask 0 fps. Things behind a building, a leafy crown or a lamp are hidden:
// the leaves by a point test against what stands in front (cached), the piles and people by clipping out the outlines of
// what stands in front of them (as sports.js and life.js do).
// Click a pile, a raker or a kid for a card. Publishes app.whimsy.leaves (0..1: how much leaf activity is
// on screen) and calls app.sound.cue("rustle") on gusts and jumps and ("crunch") on clicking a pile or its people.
// Test switch: ?leaves=gusty (lots of falling, gusty leaves and piles whatever the season and the weather).
import { pointIn } from "../core/scene.js";
import { SKIN, HAIR, localTime, curve, makeRecorder } from "./life.js";

// ------------------------------------------------------------------------------------------------ tables
// the tiles' crown colours (render.js)
const LEAF = {
  summer: ["#5f8f4a", "#6e9a4e", "#55864a", "#79a457", "#4d7c46", "#668f3f"],
  autumn: ["#c9772f", "#d9a13b", "#b5532f", "#a8742e", "#d68a35", "#9d8a3a", "#c4612e"],
  "late-autumn": ["#9a5f36", "#a8743f", "#8a5a3a", "#b08045", "#8f6a3e"],
};
const REMNANT = ["#b5773e", "#a8683a", "#c08a4a", "#9c6a3c"];
const LITTER = "#8a6440";            // what a fallen leaf fades toward
const SHADOW = "#26323c";

const AIR_S = 3.2, AIR_FULL = 4.4;   // leaves in the air: simulated and drawn from this scale (CSS px per metre), faded in to here
const GROUND_S = 7.5, GROUND_FULL = 9.5;   // leaves lying on the ground (from afar the tiles' own litter is enough)
const PILE_S = 2.2, PILE_FULL = 2.8; // piles…
const PEOPLE_S = 2;                  // …and their people (as the walkers)
const DETAIL_S = 10;                 // people with arms and rakes, cut round what stands in front, from here
const SHAPE_PX = 2.6;                // a leaf longer than this (px) is a little pointed oval, else a dab
const AIR_CAP = 900, GROUND_CAP = 2600;
// leaves let go per second by a leafy broad-leaved tree in still air, by season; the wind multiplies it
const BASE_RATE = { autumn: 0.022, "late-autumn": 0.03 };
const PILE_CELL = 26;                // m: at most one pile per cell
const RAKE_HOURS = [[0, 0], [8, 0], [9.5, 0.7], [11, 1], [16, 1], [17.5, 0.5], [18.5, 0], [24, 0]];
const KID_HOURS = [[0, 0], [9, 0], [11, 0.5], [12, 0.7], [15, 1], [17.5, 1], [18.5, 0], [24, 0]];

// the people: a raker dressed for the cold, a kid in something bright
const RAKER_JACKETS = ["#5f6b4a", "#2f3e5c", "#6d6e71", "#7b2d3a", "#b59a72", "#3f7f86", "#b3202a", "#2f3036", "#8a5a3a"];
const KID_JACKETS = ["#e3b23c", "#3f8f86", "#7a5d9a", "#d0643a", "#4d7fb8", "#b3202a", "#5a9a5a"];
const TROUSERS = ["#34445e", "#2b2b30", "#a8946c", "#55585e", "#3b4b6b"];
const HATS = ["#b3202a", "#2f3e5c", "#e3b23c", "#3f8f86", "#efeee8", "#6d6e71", "#d0643a"];
const RAKE_WOOD = "#a87a4c", RAKE_TINES = "#3e423b";

// lawns piles may lie on, and the area kinds that don't count as "something else in the way"
const LAWN = new Set(["grass", "park", "garden", "meadow"]);
const OPEN = new Set(["grass", "park", "garden", "meadow", "campus", "res", "com", "rel", "ind", "farm", "cons"]);
const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

// ------------------------------------------------------------------------------------------------ the module
export function init(app) {
  const { data, geo, view, renderer } = app;
  if (!data || !data.trees || !data.world || !renderer || !renderer.treeBare) return;
  const { SIN_T, COS_T } = geo;
  const world = data.world, TR = data.trees, NT = TR.length / 5;
  const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");
  // ?leaves=gusty: lots of falling, gusty leaves and piles, whatever the season and the weather (for tests)
  const GUSTY = (app.params.get("leaves") || "").trim().toLowerCase() === "gusty";
  const perf0 = performance.now(), sim0 = app.now().getTime() / 1000;
  // seconds on the campus clock as it stood at start, then running at the real pace (gusts and the piles' goings-on)
  const simNow = () => sim0 + (performance.now() - perf0) / 1000;

  // ---------------------------------------------------------------- per-frame camera (CSS px from ground metres)
  // px = PA·x + PB·y + PE,  py = PC·x + PD·y + PF − PK·z  (as life.js)
  let PA = 0, PB = 0, PC = 0, PD = 0, PE = 0, PF = 0, PK = 0, VW = 1, VH = 1, SCALE = 1, ROT = 0, R0 = 1, R1 = 0, D0 = 0, D1 = 1;
  const CAM = { k: 1, lod: 1, ox: 0, oy: 0 };
  function setCamera() {
    const o = geo.ROTS[view.rot], s = view.s;
    ROT = view.rot; SCALE = s; VW = view.w; VH = view.h;
    R0 = o.R[0]; R1 = o.R[1]; D0 = o.D[0]; D1 = o.D[1];
    PA = s * R0; PB = s * R1; PC = -s * SIN_T * D0; PD = -s * SIN_T * D1;
    PE = VW / 2 - view.X * s; PF = VH / 2 - view.Y * s; PK = s * COS_T;
    CAM.k = s; CAM.ox = -PE; CAM.oy = -PF;
    CAM.lod = app.tiles && app.tiles.levelFor ? Math.pow(2, app.tiles.levelFor(view)) : s * view.dpr;
  }

  // ---------------------------------------------------------------- spatial grids (ground metres)
  const GC = 32, GX = Math.ceil((world.x1 - world.x0) / GC) + 1, GY = Math.ceil((world.y1 - world.y0) / GC) + 1;
  const cellOf = (x, y) => {
    const i = Math.floor((x - world.x0) / GC), j = Math.floor((y - world.y0) / GC);
    return i < 0 || j < 0 || i >= GX || j >= GY ? -1 : j * GX + i;
  };
  // trees, by cell (one flat list)
  const tStart = new Int32Array(GX * GY + 1), tItems = new Int32Array(NT);
  {
    const cnt = new Int32Array(GX * GY);
    for (let t = 0; t < NT; t++) { const c = cellOf(TR[5 * t], TR[5 * t + 1]); if (c >= 0) cnt[c]++; }
    for (let c = 0; c < GX * GY; c++) tStart[c + 1] = tStart[c] + cnt[c];
    const fill = tStart.slice(0, GX * GY);
    for (let t = 0; t < NT; t++) { const c = cellOf(TR[5 * t], TR[5 * t + 1]); if (c >= 0) tItems[fill[c]++] = t; }
  }
  // buildings, for leaves that would land on a roof or blow indoors
  const bGrid = new Array(GX * GY), bBox = new Float32Array(data.buildings.length * 4);
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
  data.buildings.forEach((b, i) => {
    const bb = ringBox(b.p[0]);
    bBox.set(bb, 4 * i);
    gridAdd(bGrid, i, bb[0], bb[1], bb[2], bb[3]);
  });
  // the building whose footprint holds ground point (x, y) (the tallest, if parts overlap), or -1
  function buildingAt(x, y) {
    const c = cellOf(x, y), L = c < 0 ? null : bGrid[c];
    if (!L) return -1;
    let best = -1, bh = -1;
    for (let q = 0; q < L.length; q++) {
      const i = L[q];
      if (x < bBox[4 * i] || x > bBox[4 * i + 2] || y < bBox[4 * i + 1] || y > bBox[4 * i + 3]) continue;
      const h = data.buildings[i].h || 0;
      if (h > bh && app.scene.contains(i, x, y)) { best = i; bh = h; }
    }
    return best;
  }

  // ---------------------------------------------------------------- colours
  // A palette of colour strings, and for each base colour its variants: 0–2 a leaf in the air (shades), 3 its underside,
  // 4–6 lying on the ground (duller, browner).
  const PAL = [], PAL_IDX = new Map(), VAR = new Map();
  function palIdx(hex) { let i = PAL_IDX.get(hex); if (i === undefined) { i = PAL.length; PAL.push(hex); PAL_IDX.set(hex, i); } return i; }
  function variants(hex) {
    let v = VAR.get(hex);
    if (v) return v;
    v = new Int16Array(7);
    v[0] = palIdx(shade(hex, 0.94)); v[1] = palIdx(shade(hex, 1.05)); v[2] = palIdx(shade(hex, 1.16)); v[3] = palIdx(shade(hex, 0.84));
    const g = mix(hex, LITTER, 0.24);
    v[4] = palIdx(shade(g, 0.84)); v[5] = palIdx(g); v[6] = palIdx(shade(g, 1.06));
    VAR.set(hex, v);
    return v;
  }
  const PAL_MAX = 1024;

  // ---------------------------------------------------------------- the trees
  // kind: -1 not worked out yet · 0 drops nothing (a conifer) · 1 leafy · 2 still green (autumn) · 3 bare with a few
  // remnant leaves hanging on · 4 bare. Worked out lazily for the tiles' current season.
  const tKind = new Int8Array(NT).fill(-1);
  const tAir = new Array(NT);       // base colour of the leaves it drops
  const tLie = new Array(NT);       // …and of those lying under it
  const emitAcc = new Float32Array(NT).fill(-1);   // −1: not met yet (then a random start, so trees don't let go in step)
  const seeded = new Uint8Array(NT);
  let seededList = [];
  function treeKind(t) {
    let k = tKind[t];
    if (k >= 0) return k;
    const fl = TR[5 * t + 4];
    if (fl & 1) { tKind[t] = 0; return 0; }
    const st = app.tileStyle || {}, real = st.season || "summer";
    const season = real === "autumn" || real === "late-autumn" ? real : "autumn";   // forced (?leaves=gusty): as if autumn
    const hh = nHash(t * 2654435761 + 7), hh2 = nHash(t * 40503 + 11);
    if (season === "late-autumn" && renderer.treeBare(t, st)) {
      const remnant = (hh2 * 7) % 1 < 0.55;
      k = remnant ? 3 : 4;
      tAir[t] = remnant ? pick(REMNANT, (hh * 5) % 1) : null;
      tLie[t] = pick(LEAF.autumn, hh);   // what it dropped earlier
    } else if (season === "late-autumn") {
      k = 1; tAir[t] = tLie[t] = pick(LEAF["late-autumn"], hh);
    } else if (hh2 < 0.22) {
      // a tree that hasn't turned yet: now and then a yellowing leaf
      k = 2; tAir[t] = tLie[t] = mix(pick(LEAF.summer, hh2 * 4.5), "#c9a13b", 0.5);
    } else { k = 1; tAir[t] = tLie[t] = pick(LEAF.autumn, hh); }
    tKind[t] = k;
    return k;
  }
  function resetTrees() {
    tKind.fill(-1);
    clusterCand.clear();
    clearGround();
    nAir = 0;
    piles.length = 0; pileCell.clear(); nearPiles.length = 0;
  }

  // ---------------------------------------------------------------- conditions
  const C = { on: false, late: false, season: "autumn", mph: 0, dir: 240, rain: 0, snowFall: 0, night: 0, temp: 45, cloud: 0, people: true, hour: 12, weekend: false, day: 0 };
  let styleKey = "", condAt = -1e9;
  function readConditions() {
    const W = app.weather || {}, st = app.tileStyle || {};
    const season = st.season || "summer", cover = Math.max(st.snow || 0, (W.snowDepthM || 0) / 0.05);
    const autumnish = season === "autumn" || season === "late-autumn";
    C.on = app.layerEnabled("sky") && !reduceMQ.matches && (GUSTY || (autumnish && cover < 0.2));
    C.late = GUSTY || season === "late-autumn";
    C.season = season === "late-autumn" ? "late-autumn" : "autumn";
    C.mph = GUSTY ? Math.max(W.windMph || 0, 16) : Math.max(0, W.windMph || 0);
    C.dir = Number.isFinite(W.windDir) ? W.windDir : 240;
    C.rain = GUSTY ? 0 : W.rain || 0;
    C.snowFall = GUSTY ? 0 : W.snow || 0;
    C.night = Number.isFinite(W.night) ? W.night : 0;
    C.temp = Number.isFinite(W.tempF) ? W.tempF : 45;
    C.cloud = (W.cloud || 0) / 100;
    C.people = app.layerEnabled("people");
    const now = app.now(), lt = localTime(now);
    C.hour = lt.h; C.weekend = lt.dow === 0 || lt.dow === 6;
    // the campus's calendar day (New York, near enough), for the piles
    const day = Math.floor((now.getTime() - 5 * 3600e3) / 86400e3);
    const key = `${season}|${st.snow || 0}|${C.on}`;
    if (key !== styleKey) { styleKey = key; resetTrees(); }
    if (day !== C.day) { C.day = day; piles.length = 0; pileCell.clear(); nearPiles.length = 0; }
    condAt = performance.now();
  }
  // where the wind goes (ground unit vector), wandering a little; and how fast a leaf drifts in it (m/s)
  const WIND = { x: 0, y: 1, ms: 0 };
  function windNow(T, gust) {
    const a = ((C.dir + 180) * Math.PI) / 180 + 0.22 * Math.sin(T * 0.043) + 0.12 * Math.sin(T * 0.11 + 1.3) + gust * 0.15;
    WIND.x = Math.sin(a); WIND.y = Math.cos(a);
    WIND.ms = 0.25 + C.mph * 0.447 * 0.5 * (1 + 1.4 * gust);
  }
  // how much more often leaves let go in the wind (1 calm … ×11 at 30 mph); wet leaves cling on
  const windFactor = () => (1 + Math.pow(C.mph / 7, 1.6)) * Math.max(0.08, 1 - 1.4 * C.rain) * Math.max(0.3, 1 - 0.6 * C.snowFall);

  // ---------------------------------------------------------------- gusts (from the clock: the same for everyone)
  const G = { k: -1, env: 0, str: 0 };
  function gustPeriod() { return GUSTY ? 9 : 50 - 36 * smooth(2, 25, C.mph); }
  function gustAt(T) {
    const P = gustPeriod(), k = Math.floor(T / P);
    G.k = k; G.env = 0; G.str = 0;
    const prob = GUSTY ? 1 : 0.25 + 0.7 * smooth(3, 18, C.mph);
    if (hash01(k, 0x9057) > prob) return;
    const D = 3.5 + 2.5 * hash01(k, 3), start = k * P + hash01(k, 2) * Math.max(0, P - D - 0.5), u = (T - start) / D;
    if (u < 0 || u > 1) return;
    G.str = GUSTY ? 0.75 + 0.25 * hash01(k, 4) : (0.35 + 0.65 * hash01(k, 4)) * (0.35 + 0.65 * smooth(2, 16, C.mph));
    G.env = G.str * (u < 0.25 ? smooth(0, 0.25, u) : u < 0.55 ? 1 : 1 - smooth(0.55, 1, u));
  }
  // a swirl: a little whirl of leaves lifted under a tree and carried downwind across a lawn or a street
  const SW = { on: false, x: 0, y: 0, vx: 0, vy: 0, R: 3, t: 0, T: 6, spin: 1, k: -1, tree: -1, picked: 0, acc: 0 };
  function swirlEnv() { if (!SW.on) return 0; const u = SW.t / SW.T; return u < 0.2 ? smooth(0, 0.2, u) : 1 - smooth(0.6, 1, u); }
  function startSwirl(k) {
    // under one of the leafy trees on screen (by the gust's hash), moving off downwind
    let n = 0;
    for (let q = 0; q < nNear; q++) { const t = nearList[q]; if (nearOn[q] && treeKind(t) > 0) n++; }
    if (!n) return;
    let pickN = Math.floor(hash01(k, 6) * n), t = -1;
    for (let q = 0; q < nNear; q++) { const tt = nearList[q]; if (nearOn[q] && treeKind(tt) > 0 && pickN-- === 0) { t = tt; break; } }
    if (t < 0) return;
    const rad = TR[5 * t + 2];
    SW.on = true; SW.k = k; SW.tree = t; SW.t = 0; SW.T = 5 + 2.5 * hash01(k, 7); SW.R = 2.2 + 1.6 * hash01(k, 8);
    SW.spin = hash01(k, 9) < 0.5 ? 1 : -1; SW.picked = 0; SW.acc = 0;
    SW.x = TR[5 * t] - WIND.x * rad * 0.3; SW.y = TR[5 * t + 1] - WIND.y * rad * 0.3;
    const sp = 1.1 + 0.5 * Math.max(1.5, WIND.ms);
    SW.vx = WIND.x * sp; SW.vy = WIND.y * sp;
    cue("rustle", SW.x, SW.y);
  }

  // ================================================================================================ leaves in the air
  const aX = new Float32Array(AIR_CAP), aY = new Float32Array(AIR_CAP), aZ = new Float32Array(AIR_CAP);
  const aVX = new Float32Array(AIR_CAP), aVY = new Float32Array(AIR_CAP), aVZ = new Float32Array(AIR_CAP);
  const aPh = new Float32Array(AIR_CAP), aPhW = new Float32Array(AIR_CAP), aSw = new Float32Array(AIR_CAP), aSwA = new Float32Array(AIR_CAP);
  const aRot = new Float32Array(AIR_CAP), aRotW = new Float32Array(AIR_CAP), aTum = new Float32Array(AIR_CAP), aTumW = new Float32Array(AIR_CAP);
  const aLen = new Float32Array(AIR_CAP), aVt = new Float32Array(AIR_CAP), aResp = new Float32Array(AIR_CAP), aAge = new Float32Array(AIR_CAP);
  const aTop = new Int16Array(AIR_CAP), aBot = new Int16Array(AIR_CAP), aLie = new Int16Array(AIR_CAP), aSrc = new Int32Array(AIR_CAP);
  const aHid = new Uint8Array(AIR_CAP), aHidT = new Float32Array(AIR_CAP);
  const aOn = new Uint8Array(AIR_CAP);   // drawn on screen last frame (for shadows)
  let nAir = 0, simClock = 0;
  function airMove(from, to) {
    aX[to] = aX[from]; aY[to] = aY[from]; aZ[to] = aZ[from]; aVX[to] = aVX[from]; aVY[to] = aVY[from]; aVZ[to] = aVZ[from];
    aPh[to] = aPh[from]; aPhW[to] = aPhW[from]; aSw[to] = aSw[from]; aSwA[to] = aSwA[from]; aRot[to] = aRot[from]; aRotW[to] = aRotW[from];
    aTum[to] = aTum[from]; aTumW[to] = aTumW[from]; aLen[to] = aLen[from]; aVt[to] = aVt[from]; aResp[to] = aResp[from]; aAge[to] = aAge[from];
    aTop[to] = aTop[from]; aBot[to] = aBot[from]; aLie[to] = aLie[from]; aSrc[to] = aSrc[from]; aHid[to] = aHid[from]; aHidT[to] = aHidT[from];
    aOn[to] = aOn[from];
  }
  function airRemove(i) { nAir--; if (i !== nAir) airMove(nAir, i); }
  // a new leaf in the air at (x, y, z), its colours from base colour hex; vz up (a burst, a swirl) or a gentle start
  function airAdd(x, y, z, hex, src, vx, vy, vz) {
    if (nAir >= AIR_CAP) return -1;
    const i = nAir++, v = hex ? variants(hex) : null, r = Math.random;
    aX[i] = x; aY[i] = y; aZ[i] = z; aVX[i] = vx; aVY[i] = vy; aVZ[i] = vz;
    aPh[i] = r() * 6.283; aPhW[i] = 2 + 2.2 * r(); aSw[i] = (0.2 + 0.45 * r()) * (1 - 0.6 * Math.min(1, C.rain)); aSwA[i] = r() * Math.PI;
    aRot[i] = r() * 6.283; aRotW[i] = (r() < 0.5 ? -1 : 1) * (1.2 + 4.5 * r()); aTum[i] = r() * 6.283; aTumW[i] = (r() < 0.5 ? -1 : 1) * (1.6 + 3.4 * r());
    aLen[i] = 0.28 + 0.13 * r(); aVt[i] = (0.7 + 0.6 * r()) * (1 + 0.8 * Math.min(1, C.rain)); aResp[i] = 0.7 + 0.55 * r(); aAge[i] = 0;
    const sh = r();
    if (v) { aTop[i] = v[sh < 0.3 ? 0 : sh < 0.75 ? 1 : 2]; aBot[i] = v[3]; aLie[i] = v[4 + ((r() * 3) | 0)]; }
    aSrc[i] = src; aHid[i] = 0; aHidT[i] = 0; aOn[i] = 0;
    return i;
  }
  // a leaf lets go of tree t
  function release(t) {
    const x = TR[5 * t], y = TR[5 * t + 1], rad = TR[5 * t + 2], h = TR[5 * t + 3], k = tKind[t], r = Math.random;
    const a = r() * 6.283, d = rad * 0.85 * Math.sqrt(r());
    const cz = Math.max(h - rad, h * 0.55);
    const z = k === 3 ? h * (0.5 + 0.45 * r()) : cz + (r() - 0.35) * rad * 1.1;
    airAdd(x + Math.cos(a) * d, y + Math.sin(a) * d, Math.max(1.2, z), tAir[t], t, WIND.x * WIND.ms * 0.3, WIND.y * WIND.ms * 0.3, -0.1);
  }

  // ================================================================================================ leaves on the ground
  const gX = new Float32Array(GROUND_CAP), gY = new Float32Array(GROUND_CAP), gZ = new Float32Array(GROUND_CAP);
  const gVX = new Float32Array(GROUND_CAP), gVY = new Float32Array(GROUND_CAP), gVZ = new Float32Array(GROUND_CAP);
  const gRot = new Float32Array(GROUND_CAP), gRotW = new Float32Array(GROUND_CAP), gLen = new Float32Array(GROUND_CAP);
  const gCol = new Int16Array(GROUND_CAP), gSrc = new Int32Array(GROUND_CAP), gBorn = new Float32Array(GROUND_CAP);
  const gLanded = new Uint8Array(GROUND_CAP), gMov = new Uint8Array(GROUND_CAP), gHid = new Uint8Array(GROUND_CAP), gTest = new Uint8Array(GROUND_CAP);
  const gTestT = new Float32Array(GROUND_CAP);
  let nGround = 0;
  function groundMove(from, to) {
    gX[to] = gX[from]; gY[to] = gY[from]; gZ[to] = gZ[from]; gVX[to] = gVX[from]; gVY[to] = gVY[from]; gVZ[to] = gVZ[from];
    gRot[to] = gRot[from]; gRotW[to] = gRotW[from]; gLen[to] = gLen[from]; gCol[to] = gCol[from]; gSrc[to] = gSrc[from]; gBorn[to] = gBorn[from];
    gLanded[to] = gLanded[from]; gMov[to] = gMov[from]; gHid[to] = gHid[from]; gTest[to] = gTest[from]; gTestT[to] = gTestT[from];
  }
  function groundRemove(i) { nGround--; if (i !== nGround) groundMove(nGround, i); }
  function groundAdd(x, y, rot, len, col, src, landed) {
    if (nGround >= GROUND_CAP) return -1;
    const i = nGround++;
    gX[i] = x; gY[i] = y; gZ[i] = 0; gVX[i] = gVY[i] = gVZ[i] = 0; gRot[i] = rot; gRotW[i] = 0; gLen[i] = len; gCol[i] = col;
    gSrc[i] = src; gBorn[i] = simClock; gLanded[i] = landed; gMov[i] = 0; gHid[i] = 0; gTest[i] = 0; gTestT[i] = 0;
    return i;
  }
  function clearGround() {
    nGround = 0;
    for (const t of seededList) seeded[t] = 0;
    seededList = [];
  }
  // the leaves lying round tree t (where its hash puts them; none indoors or raked up under a pile)
  function seedTree(t) {
    seeded[t] = 1; seededList.push(t);
    const k = treeKind(t);
    if (k <= 0) return;
    const x = TR[5 * t], y = TR[5 * t + 1], rad = TR[5 * t + 2];
    const dens = (k === 2 ? 0.25 : k >= 3 ? 1.2 : 1) * (C.season === "late-autumn" || GUSTY ? 1 : 0.55);
    const n = Math.min(10, Math.round((2 + rad * 0.85) * dens));
    const v = variants(tLie[t]);
    for (let j = 0; j < n; j++) {
      const h1 = hash01(t, 16 * j + 1), h2 = hash01(t, 16 * j + 2), h3 = hash01(t, 16 * j + 3), h4 = hash01(t, 16 * j + 4);
      const a = h1 * 6.283, d = rad * (0.15 + 1.3 * Math.sqrt(h2));
      const lx = x + Math.cos(a) * d, ly = y + Math.sin(a) * d;
      if (buildingAt(lx, ly) >= 0 || underPile(lx, ly)) continue;
      groundAdd(lx, ly, h3 * Math.PI, 0.24 + 0.12 * h4, v[4 + ((hash01(t, 16 * j + 5) * 3) | 0)], t, 0);
    }
  }
  function underPile(x, y) {
    for (const P of nearPiles) if ((x - P.x) ** 2 + (y - P.y) ** 2 < (P.R + 1.4) ** 2) return true;
    return false;
  }

  // ================================================================================================ the trees near the view
  // nearList: the trees whose leaves may be seen soon (a wide margin round the screen: they emit); nearOn: on screen
  // (crown and all); nearLie: near enough to seed the leaves under them.
  const nearList = new Int32Array(NT), nearOn = new Uint8Array(NT), nearLie = new Uint8Array(NT);
  const lieMark = new Uint32Array(NT);
  let nNear = 0, nearGen = 1, rateOn = 0, manageAt = -1e9, lastS = 0, lastRot = -1;
  const VB = [0, 0, 0, 0];
  function viewBox(margin) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let c = 0; c < 4; c++) {
      const g = view.screenToGround(c & 1 ? VW + margin : -margin, c & 2 ? VH + margin : -margin);
      if (g[0] < x0) x0 = g[0]; if (g[0] > x1) x1 = g[0]; if (g[1] < y0) y0 = g[1]; if (g[1] > y1) y1 = g[1];
    }
    VB[0] = x0; VB[1] = y0; VB[2] = x1; VB[3] = y1;
  }
  function manage() {
    manageAt = performance.now();
    nearGen++;
    nNear = 0; rateOn = 0;
    const s = SCALE, airOK = s >= AIR_S, lieOK = s >= GROUND_S - 0.4;
    if (!C.on || (!airOK && s < PILE_S)) { if (nGround) clearGround(); nearPiles.length = 0; return; }
    const M = 0.3 * Math.max(VW, VH) + 20, ML = 70;
    if (airOK || lieOK) {
      viewBox(M);
      const i0 = Math.max(0, Math.floor((VB[0] - 20 - world.x0) / GC)), i1 = Math.min(GX - 1, Math.floor((VB[2] + 20 - world.x0) / GC));
      const j0 = Math.max(0, Math.floor((VB[1] - 20 - world.y0) / GC)), j1 = Math.min(GY - 1, Math.floor((VB[3] + 20 - world.y0) / GC));
      const base = BASE_RATE[C.season] * (GUSTY ? 6 : 1) * windFactor();
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const c = j * GX + i;
        for (let q = tStart[c]; q < tStart[c + 1]; q++) {
          const t = tItems[q];
          const x = TR[5 * t], y = TR[5 * t + 1], rad = TR[5 * t + 2], h = TR[5 * t + 3];
          const px = PA * x + PB * y + PE, py = PC * x + PD * y + PF;
          if (px < -M || px > VW + M || py < -M || py > VH + M + h * PK) continue;
          const k = treeKind(t);
          if (k <= 0) continue;
          if (emitAcc[t] < 0) emitAcc[t] = Math.random();
          const on = px > -rad * s && px < VW + rad * s && py > -rad * s && py - h * PK < VH;
          const lie = lieOK && px > -ML - rad * 1.5 * s && px < VW + ML + rad * 1.5 * s && py > -ML - rad * s && py < VH + ML + rad * s;
          nearList[nNear] = t; nearOn[nNear] = on ? 1 : 0; nearLie[nNear] = lie ? 1 : 0; nNear++;
          if (lie) lieMark[t] = nearGen;
          if (airOK && (k === 1 || k === 2 || k === 3)) {
            const r = base * rateOf(t);
            if (on) rateOn += r;
          }
        }
      }
    }
    // piles near the view (late autumn)
    managePiles(M);
    // the leaves lying round the trees that came near, and away with those of the trees that went
    if (lieOK) {
      let gone = false;
      for (const t of seededList) if (lieMark[t] !== nearGen) { gone = true; break; }
      if (gone) {
        for (let i = nGround - 1; i >= 0; i--) if (lieMark[gSrc[i]] !== nearGen) groundRemove(i);
        const keep = [];
        for (const t of seededList) { if (lieMark[t] === nearGen) keep.push(t); else seeded[t] = 0; }
        seededList = keep;
      }
      for (let q = 0; q < nNear; q++) if (nearLie[q] && !seeded[nearList[q]]) seedTree(nearList[q]);
    } else if (nGround) clearGround();
    lastS = s; lastRot = ROT;
  }
  function rateOf(t) {
    const k = tKind[t];
    return k === 1 ? 1 : k === 2 ? 0.2 : k === 3 ? (GUSTY ? 0.6 : 0.12) : 0;
  }

  // ================================================================================================ what stands in front
  // is screen-metre point (U, Y) inside building i's swept outline (as scene.pickBuilding tests it)?
  function overBuilding(i, U, Y) {
    const S = app.scene.forRot(ROT), bb = S.objBB, o = 4 * i;
    if (U < bb[o] || U > bb[o + 2] || Y < bb[o + 1] || Y > bb[o + 3]) return false;
    const rings = S.objRings[i];
    if (!rings) return false;
    const ring = rings[0], bd = data.buildings[i], top = bd.h * COS_T, bot = (bd.mh || 0) * COS_T;
    if (pointIn(ring, U, Y + top) || pointIn(ring, U, Y + bot)) return true;
    const n = ring.length / 2;
    for (let a = 0, b = n - 1; a < n; b = a++) {
      const x1 = ring[2 * b], y1 = ring[2 * b + 1], x2 = ring[2 * a], y2 = ring[2 * a + 1];
      if (U < Math.min(x1, x2) || U > Math.max(x1, x2)) continue;
      const t = x2 === x1 ? 0.5 : (U - x1) / (x2 - x1), yy = y1 + (y2 - y1) * t;
      if (Y <= yy - bot + 0.01 && Y >= yy - top - 0.01) return true;
    }
    return false;
  }
  // does tree t's crown (as the tiles paint it, near enough) cover screen-metre point (U, Y)?
  function crownCovers(t, U, Y) {
    const x = TR[5 * t], y = TR[5 * t + 1], rad = TR[5 * t + 2], h = TR[5 * t + 3], con = TR[5 * t + 4] & 1;
    const cz = con ? h * 0.5 : Math.max(h - rad, h * 0.55), rr = con ? rad * 0.8 : rad * 0.95;
    const cu = x * R0 + y * R1, cv = -(x * D0 + y * D1) * SIN_T - cz * COS_T;
    return (U - cu) * (U - cu) + (Y - cv) * (Y - cv) < rr * rr;
  }
  // Is ground point (x, y), z up, hidden behind a building or a leafy crown standing in front of it? cand: the object ids
  // to try (a tree's cluster, below), else a search of the scene.
  function hiddenAt(x, y, z, cand) {
    const sc = app.scene;
    if (!sc) return false;
    const U = x * R0 + y * R1, v = x * D0 + y * D1, Y = -v * SIN_T - z * COS_T, B = sc.B, T = sc.T;
    const ids = cand || sc.query(ROT, "objects", U - 0.15, Y - 0.15, U + 0.15, Y + 0.15);
    const S = sc.forRot(ROT), st = app.tileStyle;
    for (let q = 0; q < ids.length; q++) {
      const id = ids[q];
      if (id < B) { if (overBuilding(id, U, Y) && sc.inFront(ROT, id, x, y, 0)) return true; }
      else if (id < B + T) {
        const t = id - B;
        if (S.objV[id] < v - 0.3 && crownCovers(t, U, Y) && !renderer.treeBare(t, st)) return true;
      }
    }
    return false;
  }
  // The objects that might stand in front of some leaf lying round tree t (buildings, and leafy crowns not far behind
  // it), worked out once per turn of the view.
  const clusterCand = new Map();
  function candOf(t) {
    let c = clusterCand.get(t);
    if (c) return c;
    const sc = app.scene, B = sc.B, T = sc.T, S = sc.forRot(ROT), st = app.tileStyle;
    const x = TR[5 * t], y = TR[5 * t + 1], cr = TR[5 * t + 2] * 1.5 + 2.5;
    const U = x * R0 + y * R1, v = x * D0 + y * D1, Y = -v * SIN_T;
    const ids = sc.query(ROT, "objects", U - cr, Y - cr * SIN_T, U + cr, Y + cr * SIN_T), out = [];
    for (const id of ids) {
      if (id < B) out.push(id);
      else if (id < B + T && S.objV[id] < v + cr && !renderer.treeBare(id - B, st)) out.push(id);
    }
    c = Int32Array.from(out);
    clusterCand.set(t, c);
    return c;
  }

  // ================================================================================================ piles
  // ---------------------------------------------------------------- room on a lawn (grids built the first time)
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
    for (const p of data.paths || []) if (!p.tn) addLine(p.pts, (p.w || 2) / 2 + 0.6);
    for (const r of data.roads || []) if (!r.tn) addLine(r.pts, (r.w || 6) / 2 + 1.2);
    for (const b of data.barriers || []) addLine(b.pts, 0.6);
    const lGrid = new Array(GX * GY), aGrid = new Array(GX * GY), aBox = new Float32Array(data.areas.length * 4);
    data.areas.forEach((a, i) => {
      const bb = ringBox(a.p[0]);
      aBox.set(bb, 4 * i);
      if (LAWN.has(a.k)) gridAdd(lGrid, i, bb[0], bb[1], bb[2], bb[3]);
      else if (!OPEN.has(a.k)) gridAdd(aGrid, i, bb[0], bb[1], bb[2], bb[3]);
    });
    return (OBS = { segs: Float32Array.from(segs), sGrid, lGrid, aGrid, aBox });
  }
  const inRings = (rings, x, y) => { let n = false; for (const f of rings) if (pointIn(f, x, y)) n = !n; return n; };
  function onLawn(x, y) {
    const O = OBS, c = cellOf(x, y);
    if (c < 0) return false;
    let lawn = false, L = O.lGrid[c];
    if (L) for (const i of L) {
      if (x < O.aBox[4 * i] || x > O.aBox[4 * i + 2] || y < O.aBox[4 * i + 1] || y > O.aBox[4 * i + 3]) continue;
      if (inRings(data.areas[i].p, x, y)) { lawn = true; break; }
    }
    if (!lawn) return false;
    L = O.aGrid[c];
    if (L) for (const i of L) {
      if (x < O.aBox[4 * i] || x > O.aBox[4 * i + 2] || y < O.aBox[4 * i + 1] || y > O.aBox[4 * i + 3]) continue;
      if (inRings(data.areas[i].p, x, y)) return false;
    }
    return buildingAt(x, y) < 0;
  }
  function clearOfLines(x, y, r) {
    const O = OBS, c = cellOf(x, y);
    if (c < 0) return false;
    const L = O.sGrid[c];
    if (L) for (const id of L) { const S = O.segs, o = id * 5; if (segDist(x, y, S[o], S[o + 1], S[o + 2], S[o + 3]) < S[o + 4] + r) return false; }
    return true;
  }
  function clearOfTrunks(x, y, r) {
    const c0 = cellOf(x, y);
    if (c0 < 0) return false;
    const ci = c0 % GX, cj = (c0 / GX) | 0;
    for (let j = Math.max(0, cj - 1); j <= Math.min(GY - 1, cj + 1); j++) for (let i = Math.max(0, ci - 1); i <= Math.min(GX - 1, ci + 1); i++) {
      const c = j * GX + i;
      for (let q = tStart[c]; q < tStart[c + 1]; q++) {
        const t = tItems[q];
        if ((TR[5 * t] - x) ** 2 + (TR[5 * t + 1] - y) ** 2 < (r + Math.min(1.2, TR[5 * t + 2] * 0.25)) ** 2) return false;
      }
    }
    return true;
  }
  // ---------------------------------------------------------------- the piles of the day, one cell at a time
  const piles = [], pileCell = new Map(), nearPiles = [];
  const PCX = Math.ceil((world.x1 - world.x0) / PILE_CELL) + 1;
  function cellPile(ci, cj) {
    const key = cj * PCX + ci;
    if (pileCell.has(key)) return pileCell.get(key);
    pileCell.set(key, null);
    const day = C.day, h = hash01(key, day * 7919 + 13);
    if (h > (GUSTY ? 0.5 : 0.17)) return null;
    obstacles();
    const cx0 = world.x0 + ci * PILE_CELL, cy0 = world.y0 + cj * PILE_CELL;
    // the broad-leaved trees in the cell, in the order of their hash for the day
    const cand = [];
    const i0 = Math.max(0, Math.floor((cx0 - world.x0) / GC)), i1 = Math.min(GX - 1, Math.floor((cx0 + PILE_CELL - world.x0) / GC));
    const j0 = Math.max(0, Math.floor((cy0 - world.y0) / GC)), j1 = Math.min(GY - 1, Math.floor((cy0 + PILE_CELL - world.y0) / GC));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const c = j * GX + i;
      for (let q = tStart[c]; q < tStart[c + 1]; q++) {
        const t = tItems[q], x = TR[5 * t], y = TR[5 * t + 1];
        if (x < cx0 || x >= cx0 + PILE_CELL || y < cy0 || y >= cy0 + PILE_CELL || treeKind(t) <= 0) continue;
        cand.push(t);
      }
    }
    if (!cand.length) return null;
    cand.sort((a, b) => hash01(a, day) - hash01(b, day));
    for (let q = 0; q < Math.min(4, cand.length); q++) {
      const t = cand[q], seed = hashInt(t, day * 31 + 7);
      const R = 0.95 + 0.42 * hash01(seed, 1), rad = TR[5 * t + 2];
      for (let tries = 0; tries < 3; tries++) {
        const a = hash01(seed, 10 + tries) * 6.283, d = rad * 0.75 + R + 1.2 + 2 * hash01(seed, 20 + tries);
        const x = TR[5 * t] + Math.cos(a) * d, y = TR[5 * t + 1] + Math.sin(a) * d;
        // inside the cell (with room to the next one), on a lawn all round, clear of paths, roads, fences and trunks
        if (x < cx0 + 3 || x > cx0 + PILE_CELL - 3 || y < cy0 + 3 || y > cy0 + PILE_CELL - 3) continue;
        if (!onLawn(x, y) || !clearOfLines(x, y, R + 0.8) || !clearOfTrunks(x, y, R + 0.5)) continue;
        let ok = true;
        for (let s = 0; s < 6 && ok; s++) { const b = (s / 6) * 6.283; ok = onLawn(x + Math.cos(b) * (R + 0.7), y + Math.sin(b) * (R + 0.7)); }
        if (!ok) continue;
        const P = makePile(t, x, y, R, seed, key);
        pileCell.set(key, P);
        return P;
      }
    }
    return null;
  }
  function makePile(t, x, y, R, seed, key) {
    const base = tLie[t] || pick(LEAF.autumn, hash01(seed, 2)), r = rng(seed);
    // its leaves: the tree's own and a few others blown in (each in three shades: in shadow, lit, in the sun)
    const hues = [base, pick(LEAF.autumn, r()), pick(LEAF["late-autumn"], r()), pick(REMNANT, r())];
    const dabCols = new Int16Array(12), skirtCols = new Int16Array(4);
    hues.forEach((h, c) => { dabCols[3 * c] = palIdx(shade(h, 0.7)); dabCols[3 * c + 1] = palIdx(shade(h, 0.93)); dabCols[3 * c + 2] = palIdx(shade(h, 1.13)); skirtCols[c] = variants(h)[5]; });
    const P = {
      key, x, y, R, H: 0.62 + 0.3 * hash01(seed, 3), seed, tree: t, num: 1 + (hashInt(key, 0x7a1e) % 97),
      body: [palIdx(shade(mix(base, "#5a3a22", 0.4), 0.85)), palIdx(shade(base, 0.8)), palIdx(shade(base, 1.06))], dabCols, skirtCols, airCols: hues,
      dabs: null, skirt: null, flat: 0, act: 0, actK: -1, burstK: -1, strokes: 0, jumps: 0, where: undefined,
      raker: null, kid: null, occR: -1, occ: null, hidR: -1, hid: false, seen: false, spr: null, sprKey: "",
    };
    // leaves on the mound (unit disc + which colour + turn), and loose ones round its foot
    const nd = Math.min(DAB_MAX, 44 + Math.round(R * 34)), dabs = new Float32Array(nd * 5);
    for (let k = 0; k < nd; k++) {
      const a = r() * 6.283, d = Math.sqrt(r()) * 0.97;
      dabs[5 * k] = Math.cos(a) * d; dabs[5 * k + 1] = Math.sin(a) * d; dabs[5 * k + 2] = r() < 0.45 ? 0 : 1 + ((r() * 3) | 0); dabs[5 * k + 3] = r() * Math.PI;
      dabs[5 * k + 4] = (r() - 0.5) * 0.3;   // its own light or shade
    }
    const ns = 14 + Math.round(R * 8), skirt = new Float32Array(ns * 4);
    for (let k = 0; k < ns; k++) {
      const a = r() * 6.283, d = 0.95 + 0.6 * Math.pow(r(), 1.7);
      skirt[4 * k] = Math.cos(a) * d; skirt[4 * k + 1] = Math.sin(a) * d; skirt[4 * k + 2] = r() < 0.45 ? 0 : 1 + ((r() * 3) | 0); skirt[4 * k + 3] = r() * Math.PI;
    }
    P.dabs = dabs; P.skirt = skirt;
    // its people: the raker and the kid (their looks for the day)
    P.raker = { x, y, z: 0, fx: 1, fy: 0, m: 1, jacket: pick(RAKER_JACKETS, r()), legs: pick(TROUSERS, r()), skin: pick(SKIN, r()), hair: pick(HAIR, r()),
      hat: r() < 0.55 ? pick(HATS, r()) : null, pom: false, ph: 0, run: 0, pose: 0, alpha: 0, sunk: 0, on: false, rk: null, hid: false, hidT: 0 };
    P.kid = { x, y, z: 0, fx: 1, fy: 0, m: 0.8, jacket: pick(KID_JACKETS, r()), legs: pick(TROUSERS, r()), skin: pick(SKIN, r()), hair: pick(HAIR, r()),
      hat: r() < 0.7 ? pick(HATS, r()) : null, pom: true, ph: 0, run: 0, pose: 0, alpha: 0, sunk: 0, on: false, rk: null, hid: false, hidT: 0 };
    P.raker.rk = { hx: x, hy: y, hz: 0, d: 0.5, lat: 0, pull: 0, raking: false, last: -1, h1x: 0, h1y: 0, h2x: 0, h2y: 0 };
    P.kid.rk = P.raker.rk;
    P.raker.pile = P; P.kid.pile = P;
    piles.push(P);
    return P;
  }
  function managePiles(M) {
    nearPiles.length = 0;
    if (!C.on || !C.late || SCALE < PILE_S) return;
    viewBox(M * 0.5 + 30);
    const i0 = Math.max(0, Math.floor((VB[0] - world.x0) / PILE_CELL)), i1 = Math.floor((VB[2] - world.x0) / PILE_CELL);
    const j0 = Math.max(0, Math.floor((VB[1] - world.y0) / PILE_CELL)), j1 = Math.floor((VB[3] - world.y0) / PILE_CELL);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 2500) return;
    let made = 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const key = j * PCX + i;
      // a cell not worked out yet costs a little: a few a tick while the view moves far
      if (!pileCell.has(key) && made++ > 60) continue;
      const P = cellPile(i, j);
      if (!P) continue;
      const px = PA * P.x + PB * P.y + PE, py = PC * P.x + PD * P.y + PF, m = M * 0.5 + 30;
      if (px < -m || px > VW + m || py < -m || py > VH + m) { P.seen = false; continue; }
      nearPiles.push(P);
    }
  }

  // ---------------------------------------------------------------- what goes on at a pile
  // In slots (5 minutes; 36 s with ?leaves=gusty) from the clock: nothing, someone raking, or a kid jumping in (the slot
  // after a jump is always raking: it gets raked back up). By day, in the hours people are out, not in the rain.
  const RAKE = 1, JUMP = 2;
  function slotLen() { return GUSTY ? 36 : 300; }
  function actOf(P, k) {
    const h = hash01(P.seed, k * 2 + 1);
    let pr, pj;
    if (GUSTY) { pr = 0.45; pj = 0.45; }
    else {
      const busy = (C.weekend ? 1.3 : 1) * (C.rain > 0.15 || C.snowFall > 0.2 ? 0 : 1);
      pr = 0.32 * curve(RAKE_HOURS, C.hour) * busy; pj = 0.14 * curve(KID_HOURS, C.hour) * busy * (C.weekend ? 1.4 : 1);
    }
    if (h < pj) return JUMP;
    if (h < pj + pr) return RAKE;
    // after a jump, somebody rakes it back up
    if (hash01(P.seed, (k - 1) * 2 + 1) < pj) return RAKE | 4;
    return 0;
  }
  // the pile's state at clock T: its activity, how flattened it is, where its raker and kid are
  function updatePile(P, T, dt) {
    const L = slotLen(), off = hash01(P.seed, 77) * L, k = Math.floor((T + off) / L), u = T - (k * L - off);
    const ks = GUSTY ? 1.5 : 4 + hash01(P.seed, k * 3 + 7) * (L * 0.5);   // when the kid turns up
    const act = C.night < 0.35 && C.people ? actOf(P, k) : 0;
    if (act !== P.act || k !== P.actK) { P.act = act; P.actK = k; }
    const raker = P.raker, kid = P.kid;
    raker.on = false; kid.on = false;
    // flattened by a jump in this slot (from the landing on), raked back up through the next
    let flat = 0;
    if (act & RAKE && act & 4) flat = 1 - smooth(0.15, 0.7, u / L);
    if ((act & 3) === RAKE) placeRaker(P, u, L);
    else if (act === JUMP) flat = placeKid(P, u, k, ks);
    P.flat += (flat - P.flat) * Math.min(1, dt * 6);
  }
  function placeRaker(P, u, L) {
    const h = P.raker, rk = h.rk, walk = 1.25, entry = 7;
    const a0 = hash01(P.seed, P.actK * 5 + 2) * 6.283, ent = a0 + 2.2;
    const T1 = entry / walk;                           // walking in
    const SEG = 7.5;                                   // a spot, then the next
    const spot = (n) => a0 + (hash01(P.seed, P.actK * 97 + n) - 0.5) * 2.2;
    const rr = pileR(P) + 1.85;   // facing the pile, sweeping the loose leaves into it
    h.on = true; h.run = 0; h.pose = 0; h.alpha = 1;
    let x, y, fx, fy, raking = false, ph = 0;
    if (u < T1 || u > L - T1) {
      // walking in from (or off to) a few metres away
      const into = u < T1, v = into ? u / T1 : (L - u) / T1, a = into ? ent : ent + 1.4, sp = into ? spot(0) : spot(Math.floor((L - 2 * T1) / SEG));
      const ex = P.x + Math.cos(a) * (rr + entry), ey = P.y + Math.sin(a) * (rr + entry);
      const sx = P.x + Math.cos(sp) * rr, sy = P.y + Math.sin(sp) * rr;
      x = sx + (ex - sx) * (1 - v); y = sy + (ey - sy) * (1 - v);
      const d = Math.hypot(sx - ex, sy - ey) || 1;
      fx = ((into ? sx - ex : ex - sx) / d); fy = ((into ? sy - ey : ey - sy) / d);
      h.run = 1; h.ph = u * 4.2;
      h.alpha = Math.min(1, (into ? u : L - u) / 0.8);
    } else {
      const w = u - T1, n = Math.floor(w / SEG), q = w - n * SEG;
      const a1 = spot(n), a2 = spot(n + 1);
      if (q > SEG - 1.4) {
        // stepping round to the next spot
        const v = smooth(0, 1, (q - (SEG - 1.4)) / 1.4), a = a1 + (a2 - a1) * v;
        x = P.x + Math.cos(a) * rr; y = P.y + Math.sin(a) * rr;
        const s = Math.sign(a2 - a1) || 1;
        fx = -Math.sin(a) * s; fy = Math.cos(a) * s;
        h.run = 1; h.ph = q * 4.2;
      } else {
        x = P.x + Math.cos(a1) * rr; y = P.y + Math.sin(a1) * rr; fx = -Math.cos(a1); fy = -Math.sin(a1);
        raking = true; ph = (q / 1.7) % 1;
        const stroke = n * 10 + Math.floor(q / 1.7);
        rk.lat = (hash01(P.seed, stroke) - 0.5) * 0.7;
        if (stroke !== rk.last) { rk.last = stroke; P.strokes++; }
      }
    }
    h.x = x; h.y = y; h.fx = fx; h.fy = fy; h.z = 0;
    // the rake: swept out along the grass toward the pile, lifted back, set down again
    let d, hz;
    if (!raking) { d = 0.55; hz = 0.35; rk.pull = 0; }
    else if (ph < 0.5) { const v = smooth(0, 1, ph / 0.5); d = 0.7 + 1.1 * v; hz = 0; rk.pull = v; }
    else if (ph < 0.82) { const v = smooth(0, 1, (ph - 0.5) / 0.32); d = 1.8 - 1.1 * v; hz = 0.22 * Math.sin(Math.PI * v); rk.pull = -1; }
    else { d = 0.7; hz = 0; rk.pull = 0; }
    h.pose = raking ? 1 : 2;   // 1 raking, 2 carrying the rake
    // leaning into the sweep
    if (raking && ph < 0.5) { const lean = 0.08 * Math.sin(Math.PI * ph / 0.5); h.x += fx * lean; h.y += fy * lean; }
    rk.d = d; rk.hz = hz; rk.raking = raking;
    rk.hx = h.x + fx * d - fy * rk.lat * (d / 1.8); rk.hy = h.y + fy * d + fx * rk.lat * (d / 1.8);
  }
  // a pile's size, flattened by a jump (lower and wider, its leaves strewn round it)
  const pileR = (P) => P.R * (1 + 0.22 * P.flat), pileH = (P) => P.H * (1 - 0.45 * P.flat);
  // the kid's run, jump, sit, get up and run off; returns how flattened the pile is
  const SUNK = 0.3;   // m of the kid down in the pile
  function placeKid(P, u, k, t0) {
    const h = P.kid, a = hash01(P.seed, k * 3 + 5) * 6.283, a2 = a + 2 + 2.3 * hash01(P.seed, k * 3 + 6), t = u - t0;
    const Rf = P.R * 1.4, run = 3.2, far = 7.5;
    const RUN = far / run, JUMP_T = 0.62, SIT = 3.2, UP = 0.7, OFF = 3.2;
    if (t < 0) return 0;
    const landT = RUN + JUMP_T;
    const flat = t < landT ? 0 : smooth(0, 0.35, t - landT);
    if (t > landT + SIT + UP + OFF) return flat;
    h.on = true; h.alpha = 1; h.sunk = 0; h.z = 0; h.run = 0; h.pose = 0;
    const ex = P.x + Math.cos(a) * (P.R + 0.7), ey = P.y + Math.sin(a) * (P.R + 0.7);
    if (t < RUN) {
      const v = t / RUN, sx = P.x + Math.cos(a) * (P.R + far), sy = P.y + Math.sin(a) * (P.R + far);
      h.x = sx + (ex - sx) * v; h.y = sy + (ey - sy) * v; h.fx = -Math.cos(a); h.fy = -Math.sin(a);
      h.run = 1; h.ph = t * 7; h.alpha = Math.min(1, t / 0.5); h.pose = 3;
    } else if (t < landT) {
      const v = (t - RUN) / JUMP_T;
      h.x = ex + (P.x - ex) * v; h.y = ey + (P.y - ey) * v; h.fx = -Math.cos(a); h.fy = -Math.sin(a);
      h.z = 3.6 * v * (1 - v) * 0.95; h.sunk = SUNK * v * v; h.pose = 4;
    } else if (t < landT + SIT) {
      if (P.burstK !== k) { P.burstK = k; P.jumps++; burst(P); }
      const w = t - landT;
      h.x = P.x; h.y = P.y; h.sunk = SUNK - 0.04 * Math.sin(w * 5); h.pose = w < 1.6 ? 4 : 5;
      // turning round to look about
      const ang = a + Math.PI + Math.sin(w * 1.7) * 0.6;
      h.fx = Math.cos(ang); h.fy = Math.sin(ang);
    } else if (t < landT + SIT + UP) {
      const v = (t - landT - SIT) / UP, ox = P.x + Math.cos(a2) * Rf * 0.6, oy = P.y + Math.sin(a2) * Rf * 0.6;
      h.x = P.x + (ox - P.x) * v; h.y = P.y + (oy - P.y) * v; h.sunk = SUNK * (1 - v); h.fx = Math.cos(a2); h.fy = Math.sin(a2); h.run = v; h.ph = t * 6;
    } else {
      const v = (t - landT - SIT - UP) / OFF, sx = P.x + Math.cos(a2) * Rf * 0.6, sy = P.y + Math.sin(a2) * Rf * 0.6;
      h.x = sx + Math.cos(a2) * 9 * v; h.y = sy + Math.sin(a2) * 9 * v; h.fx = Math.cos(a2); h.fy = Math.sin(a2);
      h.run = 1; h.ph = t * 7; h.alpha = Math.min(1, (1 - v) * OFF / 0.7); h.pose = 3;
    }
    return flat;
  }
  // a kid lands in a pile: leaves everywhere
  function burst(P) {
    if (SCALE < AIR_S) return;
    const n = GUSTY ? 70 : 55;
    for (let q = 0; q < n; q++) {
      const a = Math.random() * 6.283, d = Math.sqrt(Math.random()) * P.R * 0.8, sp = 0.6 + 2.2 * Math.random();
      const i = airAdd(P.x + Math.cos(a) * d, P.y + Math.sin(a) * d, 0.2 + 0.5 * Math.random(), P.airCols[(Math.random() * P.airCols.length) | 0], P.tree,
        Math.cos(a) * sp, Math.sin(a) * sp, 2.2 + 3 * Math.random());
      if (i < 0) break;
    }
    cue("rustle", P.x, P.y);
  }

  // ================================================================================================ the simulation step
  let gustK = -1, lastStepT = performance.now(), lastFrameT = 0;
  function step(f) {
    const now = performance.now();
    let dt = Math.min(1, (now - lastStepT) / 1000);
    lastStepT = now; lastFrameT = now;
    if (reduceMQ.matches) dt = 0;
    if (now - condAt > 2000) readConditions();
    setCamera();
    if (!C.on || (SCALE < AIR_S && SCALE < PILE_S)) { if (nAir || nGround || nearPiles.length || nNear) { nAir = 0; clearGround(); nearPiles.length = 0; nNear = 0; } SW.on = false; return; }
    if (now - manageAt > (f.moving ? 250 : 500) || SCALE !== lastS || ROT !== lastRot) manage();
    if (dt <= 0) return;
    simClock += dt;
    const T = simNow();
    gustAt(T);
    if (G.k !== gustK && G.env > 0.02) {
      gustK = G.k;
      if (SCALE >= AIR_S && G.str >= 0.5 && hash01(G.k, 5) < (GUSTY ? 0.9 : 0.6)) startSwirl(G.k);
      else if (G.str >= 0.45 && nNear) cue("rustle", view.screenToGround(VW / 2, VH / 2)[0], view.screenToGround(VW / 2, VH / 2)[1]);
    }
    windNow(T, G.env);
    // leaves let go (more in a gust)
    if (SCALE >= AIR_S) {
      const base = BASE_RATE[C.season] * (GUSTY ? 6 : 1) * windFactor() * (1 + 5 * G.env);
      for (let q = 0; q < nNear; q++) {
        const t = nearList[q], r = rateOf(t);
        if (!r) continue;
        let a = emitAcc[t] + base * r * dt;
        while (a >= 1) { a -= 1; release(t); }
        emitAcc[t] = a;
      }
    } else if (nAir) nAir = 0;
    if (SW.on) stepSwirl(dt);
    // the physics, in steps of at most 50 ms
    const n = Math.max(1, Math.ceil(dt / 0.05 - 1e-6)), h = dt / n;
    for (let s = 0; s < n; s++) { stepAir(h); stepGround(h); }
    for (const P of nearPiles) updatePile(P, T, dt);
  }
  function stepSwirl(dt) {
    SW.t += dt;
    if (SW.t >= SW.T) { SW.on = false; return; }
    SW.x += SW.vx * dt; SW.y += SW.vy * dt;
    const e = swirlEnv();
    // it picks up what's lying in its way (the litter the tiles paint under the trees, too)
    if (SW.t < SW.T * 0.5 && SW.picked < (GUSTY ? 36 : 24)) {
      SW.acc += dt * 11 * e;
      while (SW.acc >= 1) {
        SW.acc -= 1; SW.picked++;
        const a = Math.random() * 6.283, d = Math.sqrt(Math.random()) * SW.R * 0.7;
        const hex = SW.tree >= 0 && tLie[SW.tree] ? tLie[SW.tree] : pick(LEAF["late-autumn"], Math.random());
        airAdd(SW.x + Math.cos(a) * d, SW.y + Math.sin(a) * d, 0.05, hex, SW.tree, SW.vx, SW.vy, 1.2 + Math.random() * 1.4);
      }
    }
    // and lifts the leaves lying under it
    if (nGround) {
      const R2 = (SW.R * 0.9) ** 2, p = 1 - Math.exp(-dt * 4 * e);
      for (let i = nGround - 1; i >= 0; i--) {
        const dx = gX[i] - SW.x, dy = gY[i] - SW.y;
        if (dx * dx + dy * dy > R2 || Math.random() > p) continue;
        const j = airAdd(gX[i], gY[i], 0.03, null, gSrc[i], SW.vx, SW.vy, 1 + Math.random() * 1.5);
        if (j >= 0) { aTop[j] = gCol[i]; aBot[j] = gCol[i]; aLie[j] = gCol[i]; aLen[j] = gLen[i]; }
        groundRemove(i);
      }
    }
  }
  function stepAir(dt) {
    const sw = SW.on, se = sw ? swirlEnv() : 0, wx = WIND.x * WIND.ms, wy = WIND.y * WIND.ms, kz = Math.min(1, dt * 2.6);
    const M = 0.6 * Math.max(VW, VH) + 60;
    for (let i = nAir - 1; i >= 0; i--) {
      aAge[i] += dt;
      aPh[i] += aPhW[i] * dt; aRot[i] += aRotW[i] * dt; aTum[i] += aTumW[i] * dt;
      let tx = wx * aResp[i], ty = wy * aResp[i];
      const c = Math.cos(aPh[i]);
      let tz = -aVt[i] * (0.45 + 1.1 * c * c);
      if (sw) {
        const dx = aX[i] - SW.x, dy = aY[i] - SW.y, d = Math.hypot(dx, dy), R = SW.R;
        if (d < 2 * R && d > 0.01) {
          const f = se * (1 - d / (2 * R)), vt = 4.2 * f * Math.min(1, d / (0.5 * R)) * SW.spin;
          tx += SW.vx * f - (dy / d) * vt - (dx / d) * 0.9 * f; ty += SW.vy * f + (dx / d) * vt - (dy / d) * 0.9 * f;
          tz += 2.6 * f * Math.max(0, 1 - aZ[i] / 4.5);
        }
      }
      const kh = Math.min(1, dt * 1.6 * (aZ[i] < 0.4 ? 0.6 : 1));
      aVX[i] += (tx - aVX[i]) * kh; aVY[i] += (ty - aVY[i]) * kh;
      // rising (a burst, a swirl) the air brakes it hard; falling it settles to its own pace
      aVZ[i] += (aVZ[i] > tz ? -9.8 * dt * 0.55 : 0) + (tz - aVZ[i]) * kz * (aVZ[i] > 0 ? 0.35 : 1);
      aX[i] += aVX[i] * dt; aY[i] += aVY[i] * dt; aZ[i] += aVZ[i] * dt;
      if (aZ[i] <= 0) { land(i); continue; }
      if (aAge[i] > 45) { airRemove(i); continue; }
      const px = PA * aX[i] + PB * aY[i] + PE, py = PC * aX[i] + PD * aY[i] + PF;
      if (px < -M || px > VW + M || py < -M || py > VH + M) airRemove(i);
    }
  }
  // a leaf comes down: it lies where it fell (if the lying leaves are kept at this zoom)
  function land(i) {
    const sw = aSw[i] * Math.sin(aPh[i]);
    const x = aX[i] + Math.cos(aSwA[i]) * sw, y = aY[i] + Math.sin(aSwA[i]) * sw, src = aSrc[i];
    if (SCALE >= GROUND_S - 0.4 && src >= 0 && lieMark[src] === nearGen && buildingAt(x, y) < 0) {
      if (nGround >= GROUND_CAP) recycleLanded();
      groundAdd(x, y, aRot[i], aLen[i], aLie[i], src, 1);
    }
    airRemove(i);
  }
  function recycleLanded() {
    let best = -1, bt = Infinity;
    for (let i = 0; i < nGround; i++) if (gLanded[i] && gBorn[i] < bt) { bt = gBorn[i]; best = i; }
    if (best >= 0) groundRemove(best);
  }
  function stepGround(dt) {
    const wet = C.rain > 0.25, ge = G.env, kick = !wet && ge > 0.25 ? 1 - Math.exp(-dt * ge * 0.8) : 0, fr = Math.exp(-dt * 1.7);
    for (let i = nGround - 1; i >= 0; i--) {
      // leaves that came down settle into the litter after a couple of minutes
      if (gLanded[i] && simClock - gBorn[i] > 150) { groundRemove(i); continue; }
      if (kick && Math.random() < kick) {
        const sp = (0.8 + 2.6 * Math.random()) * (0.5 + ge) * (0.6 + 0.4 * Math.min(1, WIND.ms / 3));
        gVX[i] = WIND.x * sp + (Math.random() - 0.5) * 0.6; gVY[i] = WIND.y * sp + (Math.random() - 0.5) * 0.6;
        gVZ[i] = Math.random() < 0.35 ? 0.6 + 0.8 * Math.random() : 0; gRotW[i] = (Math.random() - 0.5) * 14; gMov[i] = 1;
      }
      if (!gMov[i]) continue;
      const nx = gX[i] + gVX[i] * dt, ny = gY[i] + gVY[i] * dt;
      if (buildingAt(nx, ny) >= 0) { gVX[i] = gVY[i] = 0; gMov[i] = 0; gTest[i] = 0; continue; }
      gX[i] = nx; gY[i] = ny; gRot[i] += gRotW[i] * dt;
      if (gZ[i] > 0 || gVZ[i] > 0) { gVZ[i] -= 9.8 * 0.45 * dt; gZ[i] += gVZ[i] * dt; if (gZ[i] <= 0) { gZ[i] = 0; gVZ[i] = 0; } }
      gVX[i] *= fr; gVY[i] *= fr; gRotW[i] *= fr;
      if (gVX[i] * gVX[i] + gVY[i] * gVY[i] < 0.02 && gZ[i] <= 0) { gMov[i] = 0; gTest[i] = 0; }
      else if (simClock > gTestT[i]) gTest[i] = 0;   // look again at what stands in front, now and then
    }
  }

  // ================================================================================================ drawing
  const cnt = new Int32Array(PAL_MAX + 1), start = new Int32Array(PAL_MAX + 1), order = new Int32Array(Math.max(AIR_CAP, GROUND_CAP));
  const lSX = new Float32Array(Math.max(AIR_CAP, GROUND_CAP)), lSY = new Float32Array(Math.max(AIR_CAP, GROUND_CAP)), lCol = new Int16Array(Math.max(AIR_CAP, GROUND_CAP));
  let airWant = 0, groundWant = 0, airVisible = 0, groundMoving = 0;
  const fadeIn = (s, a, b) => clamp((s - a) / (b - a), 0, 1);

  // ---------------------------------------------------------------- leaves in the air (z 38)
  function drawAir(ctx) {
    airWant = 0; airVisible = 0;
    for (let i = 0; i < nAir; i++) aOn[i] = 0;
    if (!C.on || !nAir || SCALE < AIR_S) return;
    const s = SCALE, alpha = fadeIn(s, AIR_S, AIR_FULL), clock = simClock;
    let budget = 40, n = 0;
    cnt.fill(0, 0, PAL.length + 1);
    for (let i = 0; i < nAir; i++) {
      const sw = aSw[i] * Math.sin(aPh[i]), x = aX[i] + Math.cos(aSwA[i]) * sw, y = aY[i] + Math.sin(aSwA[i]) * sw;
      const px = PA * x + PB * y + PE, py = PC * x + PD * y + PF - PK * aZ[i];
      if (px < -8 || px > VW + 8 || py < -8 || py > VH + 8) continue;
      // what stands in front, now and then (and a leaf that drifts against a wall comes down on the roof)
      if (clock >= aHidT[i] && budget > 0) {
        budget--;
        aHidT[i] = clock + 0.28 + Math.random() * 0.15;
        const b = buildingAt(x, y);
        if (b >= 0 && aZ[i] < (data.buildings[b].h || 0)) { aZ[i] = -1; continue; }   // lands on the next step
        aHid[i] = hiddenAt(x, y, aZ[i], null) ? 1 : 0;
      }
      airVisible++;
      if (aHid[i]) continue;
      const c = Math.cos(aTum[i]) >= 0 ? aTop[i] : aBot[i];
      aOn[i] = 1;
      order[n] = i; lSX[n] = px; lSY[n] = py; lCol[n] = c; n++;
      cnt[c + 1]++;
    }
    if (n) paintAir(ctx, n, s, alpha);
    if (airVisible && !reduceMQ.matches) airWant = SW.on || airVisible > 10 || G.env > 0.2 ? (s >= 12 ? 26 : 22) : s >= 12 ? 20 : 15;
  }
  // batched by colour: each leaf a little pointed oval, turning (its spin) and tumbling (its width), or a dab when tiny
  function paintAir(ctx, n, s, alpha) {
    for (let c = 0; c < PAL.length; c++) cnt[c + 1] += cnt[c];
    for (let c = 0; c <= PAL.length; c++) start[c] = cnt[c];
    for (let q = 0; q < n; q++) { const c = lCol[q]; tmpOrder[start[c]++] = q; }
    ctx.globalAlpha = alpha;
    for (let c = 0; c < PAL.length; c++) {
      const a = cnt[c], b = cnt[c + 1];
      if (a === b) continue;
      ctx.fillStyle = PAL[c];
      ctx.beginPath();
      for (let k = a; k < b; k++) {
        const q = tmpOrder[k], i = order[q], x = lSX[q], y = lSY[q], L = aLen[i] * s;
        if (L < SHAPE_PX) { const d = Math.max(1, L * 0.75); ctx.rect(x - d / 2, y - d / 2, d, d); continue; }
        const ca = Math.cos(aRot[i]), sa = Math.sin(aRot[i]), w = (0.3 + 0.7 * Math.abs(Math.cos(aTum[i]))) * L * 0.3;
        const ex = ca * L * 0.5, ey = sa * L * 0.5, fx = -sa * w, fy = ca * w;
        ctx.moveTo(x + ex, y + ey);
        ctx.quadraticCurveTo(x + 2 * fx, y + 2 * fy, x - ex, y - ey);
        ctx.quadraticCurveTo(x - 2 * fx, y - 2 * fy, x + ex, y + ey);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  const tmpOrder = new Int32Array(Math.max(AIR_CAP, GROUND_CAP));

  // ---------------------------------------------------------------- on the ground (z 25)
  function drawGround(ctx) {
    groundWant = 0; groundMoving = 0;
    if (!C.on) return;
    const s = SCALE;
    if (s >= AIR_S && nAir && s >= 9 && C.night < 0.7) drawShadows(ctx, s);
    if (nGround && s >= GROUND_S) drawLying(ctx, s);
    if (nearPiles.length && s >= PILE_S) drawPiles(ctx, s);
  }
  // the falling leaves' shadows, faint, straight below them (less under cloud, none at night)
  function drawShadows(ctx, s) {
    const a = 0.13 * (1 - C.night) * (1 - 0.55 * C.cloud);
    if (a < 0.02) return;
    ctx.globalAlpha = a * fadeIn(s, AIR_S, AIR_FULL);
    ctx.fillStyle = SHADOW;
    ctx.beginPath();
    for (let i = 0; i < nAir; i++) {
      if (!aOn[i] || aZ[i] > 12) continue;
      const sw = aSw[i] * Math.sin(aPh[i]), x = aX[i] + Math.cos(aSwA[i]) * sw, y = aY[i] + Math.sin(aSwA[i]) * sw;
      const px = PA * x + PB * y + PE + 0.1 * s, py = PC * x + PD * y + PF, r = aLen[i] * s * 0.3 * (1 - Math.min(0.5, aZ[i] / 16));
      ctx.rect(px - r, py - r * 0.5, 2 * r, r);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  function drawLying(ctx, s) {
    const alpha = fadeIn(s, GROUND_S, GROUND_FULL), clock = simClock, m = 6;
    let budget = 400, n = 0, pending = 0;
    cnt.fill(0, 0, PAL.length + 1);
    for (let i = 0; i < nGround; i++) {
      const px = PA * gX[i] + PB * gY[i] + PE, py = PC * gX[i] + PD * gY[i] + PF - PK * gZ[i];
      if (px < -m || px > VW + m || py < -m || py > VH + m) continue;
      if (gMov[i]) groundMoving++;
      if (!gTest[i]) {
        if (budget <= 0) { pending++; continue; }
        budget--;
        const t = gSrc[i], near = t >= 0 && (gX[i] - TR[5 * t]) ** 2 + (gY[i] - TR[5 * t + 1]) ** 2 < (TR[5 * t + 2] * 1.5 + 2.4) ** 2;
        gHid[i] = hiddenAt(gX[i], gY[i], gZ[i], near ? candOf(t) : null) ? 1 : 0;
        gTest[i] = 1; gTestT[i] = clock + 0.3;
      }
      if (gHid[i]) continue;
      order[n] = i; lSX[n] = px; lSY[n] = py; lCol[n] = gCol[i]; n++;
      cnt[gCol[i] + 1]++;
    }
    if (n) {
      for (let c = 0; c < PAL.length; c++) cnt[c + 1] += cnt[c];
      for (let c = 0; c <= PAL.length; c++) start[c] = cnt[c];
      for (let q = 0; q < n; q++) { const c = lCol[q]; tmpOrder[start[c]++] = q; }
      ctx.globalAlpha = alpha;
      for (let c = 0; c < PAL.length; c++) {
        const a = cnt[c], b = cnt[c + 1];
        if (a === b) continue;
        ctx.fillStyle = PAL[c];
        ctx.beginPath();
        for (let k = a; k < b; k++) {
          const q = tmpOrder[k], i = order[q], x = lSX[q], y = lSY[q], L = gLen[i];
          // (a few pixels long, a dab looks the same and costs a fraction)
          if (L * s < 4) { const d = Math.max(1, L * s * 0.75), e = (gRot[i] * 7) % 1 < 0.5 ? 0.5 : 0.35; ctx.rect(x - d / 2, y - d * e / 2, d, d * e); continue; }
          // flat on the ground: its axes foreshortened like the ground
          const ca = Math.cos(gRot[i]), sa = Math.sin(gRot[i]);
          const ex = (PA * ca + PB * sa) * L * 0.5, ey = (PC * ca + PD * sa) * L * 0.5;
          const fx = (-PA * sa + PB * ca) * L * 0.27, fy = (-PC * sa + PD * ca) * L * 0.27;
          ctx.moveTo(x + ex, y + ey);
          ctx.quadraticCurveTo(x + 2 * fx, y + 2 * fy, x - ex, y - ey);
          ctx.quadraticCurveTo(x - 2 * fx, y - 2 * fy, x + ex, y + ey);
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    if (pending) groundWant = Math.max(groundWant, 15);
    if (groundMoving && !reduceMQ.matches) groundWant = Math.max(groundWant, s >= 12 ? 24 : 20);
  }

  // ---------------------------------------------------------------- piles and their people
  const items = [], itemPool = [];
  let nItems = 0;
  const PILE = 1, RAKER = 2, KID = 3;
  function item(d, t, P) {
    let it = itemPool[nItems];
    if (!it) itemPool[nItems] = it = { d: 0, t: 0, P: null };
    it.d = d; it.t = t; it.P = P; nItems++;
    items.push(it);
  }
  const byDepth = (p, q) => q.d - p.d;
  function drawPiles(ctx, s) {
    nItems = 0; items.length = 0;
    const pa = fadeIn(s, PILE_S, PILE_FULL), people = C.people && s >= PEOPLE_S;
    for (const P of nearPiles) {
      const px = PA * P.x + PB * P.y + PE, py = PC * P.x + PD * P.y + PF, m = (P.R + 10) * s;
      if (px < -m || px > VW + m || py < -m || py > VH + m) { P.seen = false; continue; }
      P.seen = true;
      const d = P.x * D0 + P.y * D1;
      item(d, PILE, P);
      if (!people) continue;
      if (P.raker.on && P.raker.alpha > 0.01) item(P.raker.x * D0 + P.raker.y * D1, RAKER, P);
      if (P.kid.on && P.kid.alpha > 0.01) item(P.kid.sunk > 0.05 ? d - 0.01 : P.kid.x * D0 + P.kid.y * D1, KID, P);
    }
    if (!nItems) return;
    items.sort(byDepth);
    const close = s >= DETAIL_S, clock = simClock;
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const it of items) {
      const P = it.P, a = it.t === PILE ? pa : pa * (it.t === RAKER ? P.raker.alpha : P.kid.alpha);
      if (a <= 0.01) continue;
      if (close && app.scene) {
        const ids = objectsOver(P);
        if (ids && ids.length) drawCut(ctx, it, a, ids);
        else drawItem(ctx, it, a, true);
      } else if (!hiddenItem(it, clock)) drawItem(ctx, it, a, close);
      if (it.t !== PILE && !reduceMQ.matches) {
        const h = it.t === RAKER ? P.raker : P.kid;
        const hx = PA * h.x + PB * h.y + PE, hy = PC * h.x + PD * h.y + PF;
        if (hx > -20 && hx < VW + 20 && hy > -20 && hy < VH + 40) groundWant = Math.max(groundWant, it.t === KID ? (s >= DETAIL_S ? 26 : 20) : s >= DETAIL_S ? 15 : 10);
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    // a pile settling (flattened or raked back up) in view
    for (const P of nearPiles) if (P.seen && Math.abs(P.flat - Math.round(P.flat)) > 0.01 && !reduceMQ.matches) groundWant = Math.max(groundWant, 15);
  }
  function drawItem(ctx, it, a, close) {
    const P = it.P;
    if (it.t === PILE) drawPile(ctx, P, a, close);
    else if (it.t === RAKER) drawHuman(ctx, P.raker, a, close);
    else { drawHuman(ctx, P.kid, a, close); if (P.kid.sunk > 0.05) drawPileFront(ctx, P, a); }
  }

  // from afar: a building or a leafy crown in front of the middle of it (checked now and then)
  function hiddenItem(it, clock) {
    if (!app.scene) return false;
    const P = it.P;
    if (it.t === PILE) {
      if (P.hidR !== ROT) { P.hid = hiddenAt(P.x, P.y, P.H * 0.5, null); P.hidR = ROT; }
      return P.hid;
    }
    const h = it.t === RAKER ? P.raker : P.kid;
    if (clock >= h.hidT) { h.hid = hiddenAt(h.x, h.y, 0.9 * h.m, null); h.hidT = clock + 0.45 + Math.random() * 0.2; }
    return h.hid;
  }
  // The scene objects whose screen box meets the pile's surroundings (its people go up to 11 m from it, 2.5 m tall),
  // in front of it or not: worked out once per turn of the view.
  function objectsOver(P) {
    if (P.occR === ROT) return P.occ;
    const o = geo.ROTS[ROT], r = P.R + 11;
    let X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity;
    for (let c = 0; c < 8; c++) {
      const x = P.x + (c & 1 ? r : -r), y = P.y + (c & 2 ? r : -r);
      const X = x * o.R[0] + y * o.R[1], Y = -(x * o.D[0] + y * o.D[1]) * SIN_T - (c & 4 ? 2.6 : 0) * COS_T;
      if (X < X0) X0 = X; if (X > X1) X1 = X; if (Y < Y0) Y0 = Y; if (Y > Y1) Y1 = Y;
    }
    P.occ = app.scene.query(ROT, "objects", X0, Y0, X1, Y1);
    P.occR = ROT;
    return P.occ;
  }
  const SIL = makeRecorder(), SIL_EXACT = SIL.withAddPath();
  const BOX = [0, 0, 0, 0, 0, 0, 0];
  function boxOf(it) {
    const P = it.P, s = SCALE;
    if (it.t === PILE) {
      const R = pileR(P) * 1.6, cx = PA * P.x + PB * P.y + PE, cy = PC * P.x + PD * P.y + PF;
      BOX[0] = cx - R * s - 2; BOX[2] = cx + R * s + 2; BOX[1] = cy - P.H * PK - R * s * SIN_T - 3; BOX[3] = cy + R * s * SIN_T + 3;
      BOX[4] = P.x; BOX[5] = P.y; BOX[6] = R;
      return;
    }
    const h = it.t === RAKER ? P.raker : P.kid, cx = PA * h.x + PB * h.y + PE, cy = PC * h.x + PD * h.y + PF, pad = (it.t === RAKER ? 2.1 : 0.7) * s;
    BOX[0] = cx - pad - 2; BOX[2] = cx + pad + 2; BOX[1] = cy - (2.3 * h.m + h.z) * PK - 3; BOX[3] = cy + 0.5 * s + (it.t === RAKER ? 1.2 * s * SIN_T : 0) + 3;
    BOX[4] = h.x; BOX[5] = h.y; BOX[6] = it.t === RAKER ? 0.9 : 0.4;
  }
  // Draw an item through a clip that leaves out the outlines (the renderer's own) of the objects among ids standing in
  // front of it: the tiles beneath already show them there (as sports.js).
  function drawCut(ctx, it, a, ids) {
    const sc = app.scene, S = sc.forRot(ROT), bb = S.objBB, B = sc.B, T = sc.T, s = SCALE;
    boxOf(it);
    const X0 = BOX[0], Y0 = BOX[1], X1 = BOX[2], Y1 = BOX[3];
    const mX0 = (X0 - PE) / s, mY0 = (Y0 - PF) / s, mX1 = (X1 - PE) / s, mY1 = (Y1 - PF) / s;
    SIL.reset();
    let n = 0;
    for (let q = 0; q < ids.length; q++) {
      const id = ids[q], o = 4 * id;
      if (bb[o + 2] < mX0 || bb[o] > mX1 || bb[o + 3] < mY0 || bb[o + 1] > mY1) continue;
      if (!sc.inFront(ROT, id, BOX[4], BOX[5], BOX[6])) continue;
      const conifer = id >= B && id < B + T && (TR[5 * (id - B) + 4] & 1);
      renderer.silhouette(conifer ? SIL_EXACT : SIL, ROT, CAM, id, app.tileStyle);
      n++;
    }
    if (!n) { drawItem(ctx, it, a, true); return; }
    SIL.closePath();
    let cuts = 0;
    for (let p = 0; p < SIL.count; p++) if (SIL.meets(p, X0, Y0, X1, Y1)) cuts++;
    if (!cuts) { drawItem(ctx, it, a, true); return; }
    ctx.save();
    ctx.beginPath(); ctx.rect(X0, Y0, X1 - X0, Y1 - Y0); ctx.clip();
    for (let p = 0; p < SIL.count; p++) if (SIL.meets(p, X0, Y0, X1, Y1)) SIL.cut(ctx, p, X0 - 2, Y0 - 2, X1 + 2, Y1 + 2);
    drawItem(ctx, it, a, true);
    ctx.restore();
  }

  // ---------------------------------------------------------------- painting a pile
  // A dome of leaves: a dark body (what shows between the leaves, and its shaded side), a lit cap toward the light
  // (from the left, as the tiles light everything), the leaves on it shaded by where they face, loose leaves round its
  // foot, and a soft shadow.
  const DAB_MAX = 120;
  const dX = new Float32Array(DAB_MAX), dY = new Float32Array(DAB_MAX), dR = new Float32Array(DAB_MAX), dB = new Int8Array(DAB_MAX), dOrd = new Int16Array(DAB_MAX), dCnt = new Int16Array(13);
  // A pile is painted once into a little canvas of its own for the scale, the turn of the view and how flattened it
  // is (the light comes from screen-left, so the turn matters), and stamped from there.
  function drawPile(ctx, P, a, close) {
    const s = SCALE, dpr = view.dpr, f = P.flat, R = pileR(P), H = pileH(P);
    const fq = Math.round(f * 12) / 12, key = `${s}|${ROT}|${dpr}|${fq}|${close}`;
    const cx = PA * P.x + PB * P.y + PE, cy = PC * P.x + PD * P.y + PF;
    // its box round its foot, CSS px (as far as the loose leaves round it reach; the shadow a little right)
    const E = Math.max(R * 1.2, P.R * (1 + 0.9 * f) * 1.6) * s;
    const hw = Math.ceil(E + 0.4 * s + 3), up = Math.ceil(H * PK + E * SIN_T + 3), dn = Math.ceil(E * SIN_T + 0.2 * s + 3);
    if (P.sprKey !== key) {
      const w = Math.ceil(2 * hw * dpr), h = Math.ceil((up + dn) * dpr);
      if (w * h > 4e6) { paintPile(ctx, P, a, close, cx, cy); return; }
      if (!P.spr) P.spr = document.createElement("canvas");
      const c = P.spr;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      const g = c.getContext("2d");
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, w, h);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintPile(g, P, 1, close, hw, up);
      P.sprKey = key;
    }
    ctx.globalAlpha = a;
    ctx.drawImage(P.spr, Math.round((cx - hw) * dpr) / dpr, Math.round((cy - up) * dpr) / dpr, P.spr.width / dpr, P.spr.height / dpr);
    ctx.globalAlpha = 1;
  }
  // paint pile P with its foot's middle at CSS px (cx, cy)
  function paintPile(ctx, P, a, close, cx, cy) {
    const f = P.flat, R = pileR(P), H = pileH(P);
    // (the projections below are relative to the pile's middle, put at (cx, cy))
    const ox = PE, oy = PF;
    PE = ox + cx - (PA * P.x + PB * P.y + PE); PF = oy + cy - (PC * P.x + PD * P.y + PF);
    try { paintPileAt(ctx, P, a, close, f, R, H); } finally { PE = ox; PF = oy; }
  }
  function paintPileAt(ctx, P, a, close, f, R, H) {
    const s = SCALE;
    const cx = PA * P.x + PB * P.y + PE, cy = PC * P.x + PD * P.y + PF;
    const rx = R * s, ry = rx * SIN_T, top = H * PK, ey = Math.sqrt(ry * ry + top * top);
    ctx.globalAlpha = a * 0.22; ctx.fillStyle = SHADOW;
    ctx.beginPath(); ctx.ellipse(cx + 0.3 * s, cy + 0.08 * s, rx * 1.1, ry * 1.15, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = a;
    if (s >= 3.5) skirtSet(ctx, P, P.R * (1 + 0.9 * f));
    dome(ctx, PAL[P.body[0]], cx, cy, rx, ry, ey);
    dome(ctx, PAL[P.body[1]], cx - rx * 0.1, cy - ey * 0.1, rx * 0.84, ry * 0.7, ey * 0.86);
    ctx.fillStyle = PAL[P.body[2]];
    ctx.beginPath(); ctx.ellipse(cx - rx * 0.28, cy - ey * 0.55, rx * 0.36, ey * 0.24, -0.25, 0, Math.PI * 2); ctx.fill();
    if (s >= 3.5) domeLeaves(ctx, P, cx, R, H, rx, close ? 0.3 : 0.34);
    ctx.globalAlpha = 1;
  }
  function dome(ctx, col, cx, cy, rx, ry, ey) {
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ey, 0, Math.PI, Math.PI * 2); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI); ctx.fill();
  }
  // the leaves on the dome that face the camera, shaded by height and by side, batched by colour
  function domeLeaves(ctx, P, cx, R, H, rx, len) {
    const s = SCALE, D = P.dabs, n = D.length / 5, L = len * s, tiny = L < SHAPE_PX;
    dCnt.fill(0);
    let m = 0;
    for (let k = 0; k < n; k++) {
      const u = D[5 * k], v = D[5 * k + 1], w2 = 1 - u * u - v * v, w = w2 > 0 ? Math.sqrt(w2) : 0;
      // facing the camera? (the dome's normal against the view: depth along D, height up)
      if ((u * D0 + v * D1) * COS_T * H > w * SIN_T * R + 0.04) continue;
      const x = P.x + u * R, y = P.y + v * R, px = PA * x + PB * y + PE, py = PC * x + PD * y + PF - PK * H * w * 0.96;
      const lit = 0.22 + 0.6 * w - 0.32 * ((px - cx) / rx) + D[5 * k + 4];
      const b = 3 * D[5 * k + 2] + (lit < 0.42 ? 0 : lit < 0.78 ? 1 : 2);
      dX[m] = px; dY[m] = py; dR[m] = D[5 * k + 3]; dB[m] = b; m++;
      dCnt[b + 1]++;
    }
    for (let b = 0; b < 12; b++) dCnt[b + 1] += dCnt[b];
    const at = dOrd;   // reuse as the sorted order
    const fill = tmpFill; for (let b = 0; b <= 12; b++) fill[b] = dCnt[b];
    for (let q = 0; q < m; q++) at[fill[dB[q]]++] = q;
    for (let b = 0; b < 12; b++) {
      if (dCnt[b] === dCnt[b + 1]) continue;
      ctx.fillStyle = PAL[P.dabCols[b]];
      ctx.beginPath();
      for (let j = dCnt[b]; j < dCnt[b + 1]; j++) {
        const q = at[j], px = dX[q], py = dY[q];
        if (tiny) { const d = Math.max(1, L * 0.7); ctx.rect(px - d / 2, py - d * 0.35, d, d * 0.7); continue; }
        const ca = Math.cos(dR[q]), sa = Math.sin(dR[q]);
        const ex = ca * L * 0.5, ey = sa * L * 0.4, fx = -sa * L * 0.24, fy = ca * L * 0.2;
        ctx.moveTo(px + ex, py + ey);
        ctx.quadraticCurveTo(px + 2 * fx, py + 2 * fy, px - ex, py - ey);
        ctx.quadraticCurveTo(px - 2 * fx, py - 2 * fy, px + ex, py + ey);
      }
      ctx.fill();
    }
  }
  const tmpFill = new Int16Array(13);
  // loose leaves round a pile's foot, flat on the ground
  function skirtSet(ctx, P, R) {
    const S = P.skirt, n = S.length / 4, len = 0.28, tiny = len * SCALE < SHAPE_PX;
    for (let c = 0; c < 4; c++) {
      ctx.fillStyle = PAL[P.skirtCols[c]];
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        if (S[4 * k + 2] !== c) continue;
        const x = P.x + S[4 * k] * R, y = P.y + S[4 * k + 1] * R, px = PA * x + PB * y + PE, py = PC * x + PD * y + PF;
        if (tiny) { const d = Math.max(1, len * SCALE * 0.7); ctx.rect(px - d / 2, py - d * 0.3, d, d * 0.6); continue; }
        const r = S[4 * k + 3], ca = Math.cos(r), sa = Math.sin(r);
        const ex = (PA * ca + PB * sa) * len * 0.5, ey = (PC * ca + PD * sa) * len * 0.5, fx = (-PA * sa + PB * ca) * len * 0.27, fy = (-PC * sa + PD * ca) * len * 0.27;
        ctx.moveTo(px + ex, py + ey);
        ctx.quadraticCurveTo(px + 2 * fx, py + 2 * fy, px - ex, py - ey);
        ctx.quadraticCurveTo(px - 2 * fx, py - 2 * fy, px + ex, py + ey);
      }
      ctx.fill();
    }
  }
  // the near lip of a pile, over a kid sitting in it
  function drawPileFront(ctx, P, a) {
    const s = SCALE, R = pileR(P), H = pileH(P);
    const cx = PA * P.x + PB * P.y + PE, cy = PC * P.x + PD * P.y + PF;
    const rx = Math.min(0.5, R * 0.42) * s, ry = rx * SIN_T, top = H * 0.55 * PK;
    ctx.globalAlpha = a;
    dome(ctx, PAL[P.body[1]], cx, cy + 0.1 * s, rx, ry, Math.sqrt(ry * ry + top * top));
    if (s < 3.5) return;
    const L = 0.3 * s;
    for (let k = 0; k < 9; k++) {
      const ang = Math.PI * (0.08 + 0.84 * (k / 8)), px = cx - Math.cos(ang) * rx * 0.9, py = cy + 0.1 * s - Math.sin(ang) * top * 0.75 + ((k * 5) % 3) * 0.05 * s;
      const r = P.dabs[5 * k + 3], ca = Math.cos(r), sa = Math.sin(r);
      const ex = ca * L * 0.5, ey = sa * L * 0.4, fx = -sa * L * 0.24, fy = ca * L * 0.2;
      ctx.fillStyle = PAL[P.dabCols[3 * (k % 4) + (k < 4 ? 2 : 1)]];
      ctx.beginPath(); ctx.moveTo(px + ex, py + ey); ctx.quadraticCurveTo(px + 2 * fx, py + 2 * fy, px - ex, py - ey); ctx.quadraticCurveTo(px - 2 * fx, py - 2 * fy, px + ex, py + ey); ctx.fill();
    }
  }

  // ---------------------------------------------------------------- painting a person (as life.js draws walkers)
  // h: { x, y, z, fx, fy (facing, ground), m (1, a kid 0.72), jacket, legs, skin, hair, hat, pom, ph (stride), run,
  // pose (0 standing, 1 raking, 2 carrying a rake, 3 running, 4 arms up, 5 sitting), sunk (m sunk into a pile) }
  function drawHuman(ctx, h, a, close) {
    const s = SCALE, m = h.m, k = PK * m;
    const gx = PA * h.x + PB * h.y + PE, gy = PC * h.x + PD * h.y + PF;
    const px = gx, py = gy - Math.max(0, h.z) * PK + h.sunk * PK;
    const bw = Math.max(1, 0.46 * s * (m < 1 ? 0.84 : 1)), lw = Math.max(0.6, 0.16 * s * (m < 1 ? 0.9 : 1));
    const hsx = PA * h.fx + PB * h.fy, hsy = PC * h.fx + PD * h.fy, away = h.fx * D0 + h.fy * D1 > 0;
    const rake = h.pose === 1 || h.pose === 2;
    ctx.globalAlpha = a;
    // shadow on the ground (smaller under a jump)
    if (h.sunk < 0.05) {
      ctx.globalAlpha = a * 0.22; ctx.fillStyle = SHADOW;
      const sr = 0.32 * s * m * (1 - Math.min(0.4, h.z * 0.5));
      ctx.beginPath(); ctx.ellipse(gx + 0.18 * s, gy + 0.02 * s, sr, sr * 0.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = a;
    }
    const sw = h.run * Math.sin(h.ph) * 0.16, z0 = 0.8, z1 = 1.44;
    if (!close) {
      // a few pixels: legs, jacket, head (and the rake as a stroke)
      const top = py - 0.86 * k;
      if (rake && away) rakeFar(ctx, h, a);
      if (h.sunk < 0.2) {
        ctx.fillStyle = h.legs;
        ctx.fillRect(px - bw * 0.42 + sw * s, top, lw, 0.86 * k - h.sunk * PK); ctx.fillRect(px + bw * 0.42 - lw - sw * s, top, lw, 0.86 * k - h.sunk * PK);
      }
      ctx.fillStyle = h.jacket; ctx.fillRect(px - bw / 2, py - 1.42 * k, bw, 0.62 * k);
      if (s >= 5 && h.pose === 4) { ctx.fillRect(px - bw * 0.5, py - 2.05 * k, lw, 0.65 * k); ctx.fillRect(px + bw * 0.5 - lw, py - 2.05 * k, lw, 0.65 * k); }
      const hs = Math.max(1, 0.26 * s * (m < 1 ? 0.92 : 1));
      ctx.fillStyle = h.skin; ctx.fillRect(px - hs / 2, py - 1.44 * k - hs, hs, hs);
      if (h.hat) { ctx.fillStyle = h.hat; ctx.fillRect(px - hs / 2, py - 1.44 * k - hs * 1.15, hs, hs * 0.5); }
      if (rake && !away) rakeFar(ctx, h, a);
      return;
    }
    // legs: a stride when moving (none showing when sunk in a pile)
    if (h.sunk < 0.2) {
      const lx = hsx * sw * m, ly = hsy * sw * m, tuck = h.z > 0.05 ? 0.15 * k : 0, legH = 0.86 * k - tuck - h.sunk * PK;
      ctx.fillStyle = h.legs;
      ctx.fillRect(px - bw * 0.45 + lx, py + ly - 0.86 * k, lw, legH);
      ctx.fillRect(px + bw * 0.45 - lw - lx, py - ly - 0.86 * k, lw, legH);
      if (s >= 12 && h.sunk < 0.05) {
        ctx.fillStyle = "#2a2a2e";
        ctx.fillRect(px - bw * 0.45 + lx, py + ly - 0.1 * k - tuck, lw * 1.1, 0.1 * k);
        ctx.fillRect(px + bw * 0.45 - lw - lx, py - ly - 0.1 * k - tuck, lw * 1.1, 0.1 * k);
      }
    }
    // the rake and the arms behind the body when seen from behind
    if (away) { if (rake) drawRake(ctx, h, a); arms(ctx, h, px, py, bw, k, hsx, hsy, z1); }
    ctx.fillStyle = h.jacket;
    roundRectFill(ctx, px - bw / 2, py - z1 * k, bw, (z1 - z0) * k + 0.05 * s, 0.14 * s * m);
    if (s >= 12) { ctx.fillStyle = "rgba(30,30,40,.18)"; ctx.fillRect(px, py - z1 * k + 0.08 * s, bw / 2, (z1 - z0) * k - 0.04 * s); }
    if (!away) { if (rake) drawRake(ctx, h, a); arms(ctx, h, px, py, bw, k, hsx, hsy, z1); }
    // head, hair, a woolly hat
    const hr = 0.13 * s * (m < 1 ? 0.95 : 1), hy = py - (z1 + 0.15) * k;
    ctx.fillStyle = h.skin;
    ctx.beginPath(); ctx.arc(px, hy, hr, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = h.hair;
    ctx.beginPath();
    if (away) ctx.arc(px, hy, hr * 1.02, 0, Math.PI * 2);
    else ctx.arc(px, hy - hr * 0.1, hr * 1.02, Math.PI * 1.02, Math.PI * 1.98);
    ctx.fill();
    if (h.hat) {
      ctx.fillStyle = h.hat;
      ctx.beginPath(); ctx.arc(px, hy - hr * 0.18, hr * 1.08, Math.PI, Math.PI * 2); ctx.fill();
      if (h.pom) { ctx.beginPath(); ctx.arc(px, hy - hr * 1.28, hr * 0.34, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  // arms as strokes from the shoulders, by pose
  function arms(ctx, h, px, py, bw, k, hsx, hsy, z1) {
    const s = SCALE, ps = h.pose;
    if (ps === 0) return;
    const shY = py - (z1 - 0.1) * k, lx = px - bw * 0.42, rx = px + bw * 0.42;
    let ax, ay, bx, by;
    if (ps === 1) {
      // both hands on the rake's handle
      const R = h.rk;
      ax = R.h1x; ay = R.h1y; bx = R.h2x; by = R.h2y;
    } else if (ps === 2) {
      // one hand trailing the rake, the other swinging
      const R = h.rk, sw = Math.sin(h.ph) * 0.25, side = hsx * 0 + (R.h1x < px ? 1 : -1);
      if (side > 0) { bx = rx + hsx * sw; by = shY + 0.52 * k + hsy * sw; ax = R.h1x; ay = R.h1y; }
      else { ax = lx + hsx * sw; ay = shY + 0.52 * k + hsy * sw; bx = R.h1x; by = R.h1y; }
    } else if (ps === 3) {
      const sw = Math.sin(h.ph) * 0.3;
      ax = lx + hsx * sw * h.m; ay = shY + 0.5 * k + hsy * sw; bx = rx - hsx * sw * h.m; by = shY + 0.5 * k - hsy * sw;
    } else if (ps === 4) {
      ax = px - 0.3 * s * h.m; ay = py - 2.05 * k; bx = px + 0.3 * s * h.m; by = ay;
    } else { ax = lx - 0.12 * s; ay = shY + 0.35 * k; bx = rx + 0.12 * s; by = ay; }
    ctx.strokeStyle = h.jacket; ctx.lineWidth = Math.max(1, 0.11 * s * h.m);
    ctx.beginPath(); ctx.moveTo(lx, shY); ctx.lineTo(ax, ay); ctx.moveTo(rx, shY); ctx.lineTo(bx, by); ctx.stroke();
    if (s >= 14) {
      ctx.fillStyle = h.skin;
      const r = Math.max(0.8, 0.05 * s);
      ctx.beginPath(); ctx.moveTo(ax + r, ay); ctx.arc(ax, ay, r, 0, Math.PI * 2); ctx.moveTo(bx + r, by); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fill();
    }
  }
  // the rake: a wooden handle from above the hands to a fan of tines on the ground (lifted on the way back), and the
  // few leaves it is pulling along; sets the hand positions for arms()
  function drawRake(ctx, h, a) {
    const s = SCALE, R = h.rk, carry = h.pose === 2;
    // the top of the handle a little in front of the body, at about shoulder height
    let tx, ty, tz, gx, gy, gz;
    if (carry) {
      // trailed along at the side, tines on the grass behind
      const sx = -h.fy * 0.3, sy = h.fx * 0.3;
      tx = h.x + sx + h.fx * 0.12; ty = h.y + sy + h.fy * 0.12; tz = 1.12; gx = h.x + sx * 1.2 - h.fx * 1.35; gy = h.y + sy * 1.2 - h.fy * 1.35; gz = 0.02;
    } else { tx = h.x + h.fx * 0.22; ty = h.y + h.fy * 0.22; tz = 1.25; gx = R.hx; gy = R.hy; gz = R.hz; }
    const Tx = PA * tx + PB * ty + PE, Ty = PC * tx + PD * ty + PF - PK * tz;
    const Gx = PA * gx + PB * gy + PE, Gy = PC * gx + PD * gy + PF - PK * gz;
    // hands along the handle
    const u1 = carry ? 0.07 : 0.1, u2 = carry ? 0.07 : 0.4;
    R.h1x = Tx + (Gx - Tx) * u1; R.h1y = Ty + (Gy - Ty) * u1; R.h2x = Tx + (Gx - Tx) * u2; R.h2y = Ty + (Gy - Ty) * u2;
    ctx.globalAlpha = a;
    // the fan: across the handle's line on the ground, its tines from a neck on the handle
    const dx = gx - tx, dy = gy - ty, dl = Math.hypot(dx, dy) || 1, ux = dx / dl, uy = dy / dl, wx = -uy * 0.32, wy = ux * 0.32;
    const nx = gx - ux * 0.2, ny = gy - uy * 0.2;
    const Nx = PA * nx + PB * ny + PE, Ny = PC * nx + PD * ny + PF - PK * (gz + 0.1);
    const Ax = PA * (gx + wx) + PB * (gy + wy) + PE, Ay = PC * (gx + wx) + PD * (gy + wy) + PF - PK * gz;
    const Bx = PA * (gx - wx) + PB * (gy - wy) + PE, By = PC * (gx - wx) + PD * (gy - wy) + PF - PK * gz;
    ctx.strokeStyle = RAKE_WOOD; ctx.lineWidth = Math.max(1.1, 0.075 * s);
    ctx.beginPath(); ctx.moveTo(Tx, Ty); ctx.lineTo(Nx, Ny); ctx.stroke();
    ctx.strokeStyle = RAKE_TINES; ctx.lineWidth = Math.max(0.8, 0.04 * s);
    ctx.beginPath();
    const nt = s >= 14 ? 9 : 5;
    for (let q = 0; q < nt; q++) { const v = q / (nt - 1); ctx.moveTo(Nx, Ny); ctx.lineTo(Ax + (Bx - Ax) * v, Ay + (By - Ay) * v); }
    ctx.stroke();
    ctx.lineWidth = Math.max(0.9, 0.05 * s);
    ctx.beginPath();
    ctx.moveTo(Nx + (Ax - Nx) * 0.35, Ny + (Ay - Ny) * 0.35); ctx.lineTo(Nx + (Bx - Nx) * 0.35, Ny + (By - Ny) * 0.35);
    ctx.stroke();
    // what it pulls along
    if (!carry && R.raking && s >= 6 && R.pull >= 0) {
      const P = h.pile;
      const cols = P ? P.skirtCols : null;
      if (cols) {
        for (let q = 0; q < 5; q++) {
          const o = (q / 4 - 0.5) * 0.5, ahead = 0.1 + 0.12 * ((q * 7) % 3);
          const lx = gx + ux * ahead + (-uy) * o, ly = gy + uy * ahead + ux * o;
          const px = PA * lx + PB * ly + PE, py = PC * lx + PD * ly + PF;
          const r = q * 1.3 + 0.4, ca = Math.cos(r), sa = Math.sin(r);
          const ex = (PA * ca + PB * sa) * 0.13, ey = (PC * ca + PD * sa) * 0.13, fx = (-PA * sa + PB * ca) * 0.07, fy = (-PC * sa + PD * ca) * 0.07;
          ctx.fillStyle = PAL[cols[q % cols.length]];
          ctx.beginPath(); ctx.moveTo(px + ex, py + ey); ctx.quadraticCurveTo(px + 2 * fx, py + 2 * fy, px - ex, py - ey); ctx.quadraticCurveTo(px - 2 * fx, py - 2 * fy, px + ex, py + ey); ctx.fill();
        }
      }
    }
  }
  function rakeFar(ctx, h, a) {
    if (SCALE < 3) return;
    const R = h.rk, carry = h.pose === 2;
    const tx = h.x + h.fx * 0.22, ty = h.y + h.fy * 0.22;
    const gx = carry ? h.x - h.fx * 1.35 : R.hx, gy = carry ? h.y - h.fy * 1.35 : R.hy, gz = carry ? 0 : R.hz;
    ctx.globalAlpha = a;
    ctx.strokeStyle = RAKE_WOOD; ctx.lineWidth = Math.max(0.7, 0.06 * SCALE);
    ctx.beginPath();
    ctx.moveTo(PA * tx + PB * ty + PE, PC * tx + PD * ty + PF - PK * 1.15);
    ctx.lineTo(PA * gx + PB * gy + PE, PC * gx + PD * gy + PF - PK * gz);
    ctx.stroke();
  }

  // ================================================================================================ clicks and cards
  function hitGround(px, py) {
    if (!C.on || SCALE < PILE_S || !nearPiles.length) return null;
    const s = SCALE, pad = app.mobile ? 14 : 10, people = C.people && s >= PEOPLE_S;
    let best = null, bd = Infinity;
    for (const P of nearPiles) {
      if (!P.seen) continue;
      if (people) for (let q = 0; q < 2; q++) {
        const h = q ? P.raker : P.kid;
        if (!h.on || h.alpha < 0.3) continue;
        const hx = PA * h.x + PB * h.y + PE, hy = PC * h.x + PD * h.y + PF - (Math.max(0, h.z) + 1.0 * h.m - h.sunk) * PK;
        const r = Math.max(pad, 0.6 * s), d = (px - hx) ** 2 + (py - hy) ** 2;
        // (not through a building or a crown standing in front)
        if (d < r * r && d < bd && !hiddenAt(h.x, h.y, 0.9 * h.m, null)) { bd = d; best = { kind: q ? "raker" : "kid", P }; }
      }
      if (best) continue;
      if (P.hidR !== ROT) { P.hid = hiddenAt(P.x, P.y, P.H * 0.5, null); P.hidR = ROT; }
      if (P.hid) continue;
      const R = pileR(P), H = pileH(P);
      const cx = PA * P.x + PB * P.y + PE, cy = PC * P.x + PD * P.y + PF - H * PK * 0.4;
      const rx = R * s + pad, ry = Math.hypot(R * s * SIN_T, H * PK) * 0.75 + pad;
      const d = ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2;
      if (d <= 1 && d * 1e4 < bd) { bd = d * 1e4; best = { kind: "pile", P }; }
    }
    return best;
  }
  function onClick(tg) {
    const ui = app.ui;
    if (!tg || !ui || !ui.card) return;
    const P = tg.P;
    cue("crunch", P.x, P.y);
    if (tg.kind === "pile") pileCard(P);
    else if (tg.kind === "raker") rakerCard(P);
    else kidCard(P);
  }
  const row = (k, v) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`;
  function body(rows, note) {
    const el = document.createElement("div");
    el.className = "leaves-card";
    el.innerHTML = `<dl class="leaves-grid">${rows.join("")}</dl>` + (note ? `<p class="leaves-note">${esc(note)}</p>` : "");
    return el;
  }
  const dirTo = (vx, vy) => COMPASS[Math.round((((Math.atan2(vx, vy) * 180) / Math.PI + 360) % 360) / 45) % 8];
  function whereOf(P) {
    if (P.where !== undefined) return P.where;
    P.where = null;
    for (const a of data.areas) {
      if (!a.n || !(a.k === "park" || a.k === "grass" || a.k === "garden")) continue;
      const bb = ringBox(a.p[0]);
      if (P.x < bb[0] || P.x > bb[2] || P.y < bb[1] || P.y > bb[3]) continue;
      if (inRings(a.p, P.x, P.y)) { P.where = a.n; break; }
    }
    if (P.where == null) {
      let lawn = "a lawn";
      for (const a of data.areas) {
        if (a.k !== "garden") continue;
        const bb = ringBox(a.p[0]);
        if (P.x < bb[0] || P.x > bb[2] || P.y < bb[1] || P.y > bb[3]) continue;
        if (inRings(a.p, P.x, P.y)) { lawn = "a back garden"; break; }
      }
      P.where = lawn;
    }
    return P.where;
  }
  function crunchOf() {
    if (C.rain > 0.15) return "soggy (it's raining)";
    if (C.snowFall > 0.15) return "muffled (it's snowing)";
    if (C.temp < 32) return "frosty, extra crisp";
    return C.temp < 50 ? "maximum" : "pleasant";
  }
  function heightOf(P) {
    const H = pileH(P);
    return H < 0.35 ? "ankle-high, now" : H < 0.6 ? "about knee-high" : "nearly waist-high on a kid";
  }
  function pileCard(P) {
    const jumped = P.flat > 0.3, raking = P.raker.on, kid = P.kid.on && !jumped;
    const ratings = ["excellent", "superb", "very bouncy", "8/10, would jump again", "crunchy with notes of maple"];
    const rows = [
      row("Jump rating", jumped ? "excellent, apparently" : ratings[hashInt(P.seed, 3) % ratings.length]),
      row("Crunch", crunchOf()),
      row("Height", heightOf(P)),
      row("Leaves", "plenty; nobody has counted"),
      row("Raked by", jumped ? "someone who will have to rake it again" : raking ? "the person right there, still at it" : "someone with a rake and a plan"),
    ];
    if (kid) rows.push(row("Inspection", "a pile inspector is on the way"));
    if (C.mph >= 12 && C.rain < 0.25) rows.push(row("Stability", `slowly relocating to the ${dirTo(WIND.x, WIND.y)}`));
    ui().card({ id: "leaves-pile", title: `Leaf pile #${P.num}`, subtitle: `Late autumn · ${whereOf(P)}`, color: PAL[P.body[2]],
      body: body(rows, "An imaginary pile: the map rakes a few up on its lawns every late autumn."), anchor: { x: P.x, y: P.y, z: P.H } });
  }
  function rakerCard(P) {
    const h = P.raker, rows = [
      row("Doing", P.raker.pose === 1 ? "raking" : "walking with a rake"),
      row("Pile", `#${P.num}`),
      row("Strokes so far", P.strokes ? String(P.strokes) : "just getting started"),
      row("Progress", C.mph >= 10 || G.env > 0.2 ? "two steps forward, one gust back" : P.act & 4 ? "putting a jumped-in pile back together" : "steady"),
      row("Mood", C.temp < 35 ? "brisk" : "optimistic"),
    ];
    ui().card({ id: "leaves-raker", title: "Someone raking", subtitle: `Late autumn · ${whereOf(P)}`, color: h.jacket,
      body: body(rows, "One of the map's imaginary neighbours."), anchor: { x: h.x, y: h.y, z: 1.6 } });
  }
  function kidCard(P) {
    const h = P.kid, inPile = h.sunk > 0.1, rows = [
      row("Title", "pile inspector"),
      row("Inspection", inPile ? "underway, from the inside" : h.pose === 3 && P.flat < 0.3 ? "about to begin" : "complete"),
      row("Verdict", P.flat > 0.3 ? `${crunchOf().split(" ")[0]} crunch, no notes` : "pending"),
      row("Pile", `#${P.num}`),
      row("Jumps seen here today", String(Math.max(P.jumps, inPile ? 1 : 0))),
    ];
    ui().card({ id: "leaves-kid", title: "A kid and a leaf pile", subtitle: `Late autumn · ${whereOf(P)}`, color: h.jacket,
      body: body(rows, "One of the map's imaginary neighbours."), anchor: { x: h.x, y: h.y, z: 1.2 } });
  }
  const ui = () => app.ui;
  function injectStyle() {
    if (document.getElementById("leaves-style")) return;
    const st = document.createElement("style");
    st.id = "leaves-style";
    st.textContent = `
      .leaves-card { font: 13px/1.45 "Inter", system-ui, sans-serif; }
      .leaves-grid { display: grid; grid-template-columns: auto 1fr; gap: 3px 14px; margin: 2px 0 0; }
      .leaves-grid dt { color: var(--mute, #7a7064); }
      .leaves-grid dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
      .leaves-note { margin: 9px 0 0; padding: 7px 10px; border-radius: 8px; background: var(--well, #f1ebdd); font: italic 12.5px/1.4 "Fraunces", Georgia, serif; color: var(--text, #3a352e); }
      body[data-ui="dark"] .leaves-note { background: rgba(255,255,255,.06); }
    `;
    document.head.append(st);
  }
  injectStyle();
  function cue(name, x, y) {
    try { if (app.sound && app.sound.cue) app.sound.cue(name, { x, y }); } catch { /* no sound */ }
  }

  // ================================================================================================ wiring
  let failed = false;
  app.whimsy = app.whimsy || {};
  app.whimsy.leaves = 0;
  function publish() {
    let v = 0;
    if (C.on) {
      v = Math.min(1, airVisible / 60) + Math.min(0.3, groundMoving / 80) + (SW.on ? 0.25 * swirlEnv() : 0) + (G.env > 0.2 && (airVisible || groundMoving) ? 0.2 * G.env : 0);
      for (const P of nearPiles) if (P.seen) { if (P.kid.on) v += 0.3; else if (P.raker.on) v += 0.08; }
    }
    app.whimsy.leaves = Math.min(1, v);
  }
  app.on("frame", (f) => {
    if (failed) return;
    try { step(f); } catch (e) {
      failed = true; nAir = 0; nGround = 0; nearPiles.length = 0;
      console.error("leaves: stopped", e);
    }
  });
  // with the map asleep (nothing moving on screen), a leaf letting go in view, a gust, or someone arriving at a pile
  // still has to wake it
  setInterval(() => {
    if (failed || document.hidden) return;
    try {
      const now = performance.now();
      if (now - condAt > 4000) readConditions();
      if (!C.on || now - lastFrameT < 600) return;
      const sec = (now - lastStepT) / 1000;
      let wake = SCALE >= AIR_S && rateOn * sec >= 0.8;
      if (!wake) {
        const T = simNow();
        gustAt(T);
        if (G.env > 0.2 && G.k !== gustK && (nGround || (SCALE >= AIR_S && nNear))) wake = true;
        if (!wake && SCALE >= PILE_S && C.people) {
          for (const P of nearPiles) {
            if (!P.seen) continue;
            updatePile(P, T, 0);
            if (P.raker.on || P.kid.on) { wake = true; break; }
          }
        }
      }
      if (wake) app.requestRender("leaves");
    } catch (e) { failed = true; console.error("leaves: stopped", e); }
  }, 700);
  app.on("rotate", () => { clusterCand.clear(); for (let i = 0; i < nGround; i++) gTest[i] = 0; for (const P of piles) { P.occR = -1; P.hidR = -1; } });
  app.on("style", () => { condAt = -1e9; });
  app.on("weather", () => { condAt = -1e9; });
  app.on("layers", (p) => { if (p && (p.id === "sky" || p.id === "people")) { condAt = -1e9; app.requestRender("leaves"); } });

  app.addLayer({
    id: "leaves-ground", z: 25,
    fps: () => (C.on && app.layerEnabled("sky") ? groundWant : 0),
    draw: (ctx) => { if (failed || !app.layerEnabled("sky")) { groundWant = 0; return; } drawGround(ctx); },
    hit: (px, py) => (failed || !app.layerEnabled("sky") ? null : hitGround(px, py)),
    onClick,
  });
  app.addLayer({
    id: "leaves", z: 38,
    fps: () => (C.on && app.layerEnabled("sky") ? airWant : 0),
    draw: (ctx) => { if (failed || !app.layerEnabled("sky")) { airWant = 0; airVisible = 0; publish(); return; } drawAir(ctx); publish(); },
  });

}

// ------------------------------------------------------------------------------------------------ helpers
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function smooth(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
function segDist(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / L, 0, 1) : 0;
  return Math.hypot(x - ax - dx * t, y - ay - dy * t);
}
function roundRectFill(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2))); else ctx.rect(x, y, w, h);
  ctx.fill();
}
// render.js's hash and pick, exactly: the crown colours must be the tiles' own
const nHash = (n) => { n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4); n = Math.imul(n, 0x27d4eb2d); n = n ^ (n >>> 15); return (n >>> 0) / 4294967296; };
const pick = (arr, h) => arr[Math.min(arr.length - 1, Math.floor(h * arr.length))];
function hashInt(a, b) {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}
const hash01 = (a, b) => hashInt(a, b) / 4294967296;
function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const toHex = (c) => "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const shade = (h, f) => toHex(hexRgb(h).map((v) => v * f));
const mix = (a, b, t) => { const A = hexRgb(a), B = hexRgb(b); return toHex(A.map((v, i) => v + (B[i] - v) * t)); };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
