// Squirrels: grey and fox squirrels on the lawns and round the trees, most of them on the Oval and the quads.
//
// None of this is live data. Some of the trees that stand on a lawn are homes ("dens") to a squirrel or two: more of
// them on the named lawns (the Oval, the quads, the greens) and round the middle of campus, fewer out in the
// neighbourhoods. Which trees, how many squirrels and when each is out come from hashes of the tree and the clock, so a
// lawn has the same squirrels whenever it comes back into view, and for everyone. How many are out follows the hour
// (none at night: they're asleep in their dreys), the season (busiest in autumn, when they bury nuts), the cold, rain,
// falling snow, deep snow on the ground and strong wind.
//
// A squirrel out of its tree forages round it on the lawn (never further than its range, never onto a building, a road
// or a plaza): it nibbles with its nose to the ground, scampers in short bounding bursts, freezes, sits up to look
// round, flicks its tail, digs and buries a nut (mostly in autumn; in winter it digs one up), darts up its trunk and
// back down head first, and now and then chases a neighbour round and round a trunk and off across the grass. One that
// comes out in plain view climbs down its tree; one whose time is up climbs back into it.
//
// Only the dens near the view are looked at (a 40 m grid, worked out the first time a cell comes near), and only their
// squirrels are simulated, from street zoom in. Drawing ("squirrels", z 33: under the walkers and the night tint): a
// side view in the squirrel's own frame (along its body, and up off the ground or out from the trunk), drawn back to
// front; close up, whatever stands in front of one (a building, a tree, a lamp post, its own trunk when it runs round
// behind it) is left showing by clipping its outline out of the drawing, as sports.js does; from afar a squirrel behind
// something is simply not drawn. A squirrel that climbs into a leafy crown fades into it.
//
// Click one for its card (a name and what it's up to); it notices you. Test switch: ?squirrels=many (lots of them, at
// any hour on clear ground). The squirrels follow the shared "Wildlife" switch. app.whimsy.squirrels: how many are
// on screen.
import { pointIn } from "../core/scene.js";
import { localTime, curve, makeRecorder } from "./life.js";

// ------------------------------------------------------------------------------------------------ tables
const SIM_S = 3.2;      // squirrels are simulated from this scale (CSS px per metre) up…
const MIN_S = 4;        // …drawn (as specks) from here, fading in over a unit of scale…
const DETAIL_S = 7;     // …as little drawings, cut round what stands in front, from here
const SZ = 1.75;        // drawn larger than life (≈0.45 m nose to tail tip), so they read at street zoom
const GC = 40;          // grid cell, ground metres
const OVAL = [39.9995, -83.0127];
const LAWN_NAME = /\b(oval|quad|quadrangle|green|lawn|commons|mall)\b/i;
// a lawn is where the smallest of these areas that holds a point is one of LAWN (a grass island in a car park is lawn;
// a plaza in a park isn't)
const LAWN = new Set(["grass", "park", "meadow", "garden", "flower", "cem", "wood", "scrub"]);
const BLOCK = new Set(["plaza", "parking", "water", "pitch", "court", "pool", "road", "bridge", "stall", "sand", "track", "cons"]);
// how busy they are through the day (local hours) by season, and the season's own share
const DAY = {
  autumn: [[0, 0], [6, 0.2], [7.5, 0.9], [10, 1], [13, 0.85], [16, 0.95], [18, 0.7], [20, 0.2], [24, 0]],
  winter: [[0, 0], [7, 0.1], [9, 0.55], [11, 0.9], [14, 1], [16, 0.6], [17.5, 0.2], [24, 0]],
  spring: [[0, 0], [6, 0.25], [8, 0.9], [12, 0.85], [16, 0.9], [19, 0.6], [21, 0.1], [24, 0]],
  // in summer they rest through the heat of the day
  summer: [[0, 0], [5.5, 0.2], [7, 0.9], [9.5, 1], [12, 0.55], [14.5, 0.4], [17, 0.75], [19.5, 0.95], [21, 0.3], [24, 0]],
};
DAY["late-autumn"] = DAY.autumn;
const SEASON = { autumn: 1, "late-autumn": 0.95, winter: 0.55, spring: 0.8, summer: 0.75 };
// a typical afternoon by season (°F), when the live reading doesn't apply (another date with ?time=, test weather)
const CLIMATE = { winter: 36, spring: 62, summer: 82, autumn: 64, "late-autumn": 48 };
// as render.js sizes a bare tree's crown (its crown-to-height ratios)
const BARE_A = [0.26, 0.36, 0.48, 0.62];

// what they look like: an eastern grey squirrel and a fox squirrel
const PALS = [
  { name: "Eastern grey squirrel", body: "#7f7972", dark: "#6c665f", belly: "#efeae0", head: "#857f77", tail: "#7a746c", fringe: "#d3cec4", far: "#77716a" },
  { name: "Fox squirrel", body: "#a9764e", dark: "#946543", belly: "#e0a467", head: "#ae7c54", tail: "#a06b43", fringe: "#d99b62", far: "#a5734d" },
];
const SHADOW = "rgba(38,50,60,.22)", EYE = "#2a2622";
const DIRT = "#7a5d45", SNOWDIRT = "#eef1f4";
const DIG_LIFE = 100;   // seconds a dug patch shows

// states
const FORAGE = 0, HOP = 1, ALERT = 2, SIT = 3, DIG = 4, BURY = 5, TOTREE = 6, UP = 7, PERCH = 8, DOWN = 9, CHASE = 10, FREEZE = 11;
// poses
const CROUCH = 0, RUN = 1, SITUP = 2, CLIMB = 3;

// the card
const NAMES = ["Hazel", "Juniper", "Pip", "Clementine", "Biscuit", "Nutmeg", "Pecan", "Chestnut", "Maple", "Rusty", "Ash", "Willow",
  "Oakley", "Fern", "Thistle", "Bramble", "Penny", "Mabel", "Gus", "Waffles", "Noodle", "Pickles", "Truffle", "Dumpling", "Sprocket",
  "Dash", "Scout", "Pretzel", "Cinnamon", "Tater", "Beans", "Marbles", "Pistachio", "Hickory", "Butternut", "Walnut", "Cashew", "Mocha",
  "Toffee", "Bagel", "Muffin", "Nibbles", "Fidget", "Jitters", "Professor Whiskers", "Dean Fluffington", "Sir Reginald Nutters",
  "Captain Twitch", "Lady Hazelnut", "Mister Pockets", "Doctor Scampers", "Little Bean", "Old Gus"];
const EPITHETS = ["the Bold", "the Unbothered", "the Hoarder", "the Swift", "the Suspicious", "the Magnificent", "the Forgetful", "the Tiny", "the Elder"];
const FACTS = [
  "Grey and fox squirrels bury nuts one at a time, in many small caches, and find a lot of them again by memory and smell.",
  "A squirrel's nest of twigs and leaves up in a tree is called a drey.",
  "Squirrels can run down a trunk head first: they turn their hind feet round to grip the bark.",
  "A squirrel's front teeth never stop growing; gnawing keeps them in trim.",
  "A flicking tail is a squirrel's alarm signal.",
  "Some buried nuts are never dug up again, and a few of them grow into trees.",
  "Tree squirrels don't hibernate: through the winter they live off what they buried in the autumn.",
];
const FOX_FACT = "Fox squirrels are the largest tree squirrels native to North America.";
const GREY_FACT = "Eastern grey squirrels are often not all grey: many have a reddish-brown wash on the back and sides.";

// ------------------------------------------------------------------------------------------------ the module
export function init(app) {
  const { data, geo, view, renderer } = app;
  if (!data || !data.areas || !data.trees || !data.world) return;
  const { SIN_T, COS_T } = geo;
  const world = data.world, tr = data.trees;
  const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");
  // ?squirrels=many: squirrels under most trees, at any hour on clear ground (for screenshots and tests)
  const MANY = (app.params.get("squirrels") || "").trim().toLowerCase() === "many";
  const [ovalX, ovalY] = geo.toXY(OVAL[0], OVAL[1]);
  const whimsy = (app.whimsy = app.whimsy || {});
  whimsy.squirrels = 0;
  if (app.ui && app.ui.registerToggle) app.ui.registerToggle({ id: "wildlife", label: "Wildlife", count: "simulated" });
  const wildlifeOn = () => app.layerEnabled("wildlife");

  // ---------------------------------------------------------------- per-frame camera (CSS px from ground metres)
  // px = PA·x + PB·y + PE,  py = PC·x + PD·y + PF − PK·z  (as life.js and sports.js)
  let PA = 0, PB = 0, PC = 0, PD = 0, PE = 0, PF = 0, PK = 0, VW = 1, VH = 1, SCALE = 1, ROT = 0, D0 = 0, D1 = 0, R0 = 0, R1 = 0;
  // the same camera for renderer.silhouette (CSS px = X·k − ox), and the tiles' level of detail, so outlines match them
  const CAM = { k: 1, lod: 1, ox: 0, oy: 0 };
  function setCamera() {
    const o = geo.ROTS[view.rot], s = view.s;
    ROT = view.rot; SCALE = s; VW = view.w; VH = view.h;
    D0 = o.D[0]; D1 = o.D[1]; R0 = o.R[0]; R1 = o.R[1];
    PA = s * R0; PB = s * R1; PC = -s * SIN_T * D0; PD = -s * SIN_T * D1;
    PE = VW / 2 - view.X * s; PF = VH / 2 - view.Y * s; PK = s * COS_T;
    CAM.k = s; CAM.ox = -PE; CAM.oy = -PF;
    CAM.lod = app.tiles && app.tiles.levelFor ? Math.pow(2, app.tiles.levelFor(view)) : s * view.dpr;
  }
  // a ground point (with room round it of rad metres and margin px) on screen?
  function onView(x, y, rad, margin) {
    const px = PA * x + PB * y + PE, py = PC * x + PD * y + PF, m = margin + rad * SCALE;
    return px > -m && px < VW + m && py > -m - 4 * PK && py < VH + m;
  }

  // ---------------------------------------------------------------- grids (ground metres), built the first time
  const GX = Math.ceil((world.x1 - world.x0) / GC) + 1, GY = Math.ceil((world.y1 - world.y0) / GC) + 1;
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
  // (built a few milliseconds at a time, over the first frames at street zoom: the whole campus takes a tenth of a
  // second or so, too long for one frame)
  let G = null, building = null, buildMs = 0;
  function grids(budget) {
    if (G) return G;
    if (!building) building = buildGrids();
    const t0 = performance.now(), end = t0 + budget;
    for (;;) {
      const r = building.next();
      if (r.done) { G = r.value; building = null; break; }
      if (performance.now() > end) break;
    }
    buildMs += performance.now() - t0;
    if (G) G.ms = buildMs;
    return G;
  }
  function* buildGrids() {
    // what a squirrel can't cross or stand on: buildings, roads (and footpaths, which it crosses but doesn't stop on)
    const segs = [], sGrid = new Array(GX * GY);
    let n = 0;
    const addLine = (pts, reach, road) => {
      for (let k = 0; k + 3 < pts.length; k += 2) {
        const id = segs.length / 6, ax = pts[k], ay = pts[k + 1], bx = pts[k + 2], by = pts[k + 3];
        segs.push(ax, ay, bx, by, reach, road);
        gridAdd(sGrid, id, Math.min(ax, bx) - reach, Math.min(ay, by) - reach, Math.max(ax, bx) + reach, Math.max(ay, by) + reach);
      }
    };
    for (const p of data.paths) { if (!p.tn) addLine(p.pts, (p.w || 2) / 2 + 0.2, 0); if ((++n & 255) === 0) yield; }
    for (const r of data.roads) { if (!r.tn && !r.br) addLine(r.pts, (r.w || 6) / 2 + 0.8, 1); if ((++n & 255) === 0) yield; }
    const bGrid = new Array(GX * GY), bBox = new Float32Array(data.buildings.length * 4);
    for (let i = 0; i < data.buildings.length; i++) {
      const b = data.buildings[i];
      if ((++n & 511) === 0) yield;
      if (b.part) continue;
      const bb = ringBox(b.p[0]);
      bBox.set(bb, 4 * i);
      gridAdd(bGrid, i, bb[0], bb[1], bb[2], bb[3]);
    }
    // lawns and what lies on them, by area (the smallest that holds a point is what's there)
    const aGrid = new Array(GX * GY), aBox = new Float32Array(data.areas.length * 4), aSize = new Float64Array(data.areas.length);
    const named = [];
    for (let i = 0; i < data.areas.length; i++) {
      const a = data.areas[i];
      if ((++n & 255) === 0) yield;
      if (!LAWN.has(a.k) && !BLOCK.has(a.k)) continue;
      const bb = ringBox(a.p[0]);
      aBox.set(bb, 4 * i);
      aSize[i] = a.A || (bb[2] - bb[0]) * (bb[3] - bb[1]);
      gridAdd(aGrid, i, bb[0], bb[1], bb[2], bb[3]);
      if (a.n && (LAWN.has(a.k) || a.k === "water")) named.push(i);
    }
    yield;
    const tGrid = new Array(GX * GY);
    for (let t = 0; t < tr.length / 5; t++) { const c = cellOf(tr[5 * t], tr[5 * t + 1]); if (c >= 0) (tGrid[c] ||= []).push(t); }
    yield;
    return { segs: Float32Array.from(segs), sGrid, bGrid, bBox, aGrid, aBox, aSize, named, tGrid, dens: new Array(GX * GY), ms: 0 };
  }
  // 1: lawn; 2: a footpath across a lawn (crossed, not stopped on); 0: anything else. Asked again and again round the
  // same trees, so kept per half-metre square (as at its middle).
  const LAWN_AT = new Map();
  function lawnAt(x, y) {
    const i = Math.floor((x - world.x0) * 2), j = Math.floor((y - world.y0) * 2), key = i * 16384 + j;
    let v = LAWN_AT.get(key);
    if (v === undefined) {
      if (LAWN_AT.size > 200000) LAWN_AT.clear();
      v = lawnAtRaw(world.x0 + (i + 0.5) / 2, world.y0 + (j + 0.5) / 2);
      LAWN_AT.set(key, v);
    }
    return v;
  }
  function lawnAtRaw(x, y) {
    const c = cellOf(x, y);
    if (c < 0) return 0;
    let L = G.bGrid[c];
    if (L) for (const i of L) {
      const B = G.bBox;
      if (x >= B[4 * i] && x <= B[4 * i + 2] && y >= B[4 * i + 1] && y <= B[4 * i + 3] && app.scene.contains(i, x, y)) return 0;
    }
    let path = false;
    L = G.sGrid[c];
    if (L) for (const id of L) {
      const S = G.segs, o = id * 6;
      if (segDist(x, y, S[o], S[o + 1], S[o + 2], S[o + 3]) < S[o + 4]) { if (S[o + 5]) return 0; path = true; }
    }
    L = G.aGrid[c];
    let best = -1, bestA = Infinity;
    if (L) for (const i of L) {
      const B = G.aBox;
      if (G.aSize[i] >= bestA || x < B[4 * i] || x > B[4 * i + 2] || y < B[4 * i + 1] || y > B[4 * i + 3]) continue;
      if (inRings(data.areas[i].p, x, y)) { best = i; bestA = G.aSize[i]; }
    }
    if (best < 0 || !LAWN.has(data.areas[best].k)) return 0;
    return path ? 2 : 1;
  }
  // the name of the place a den is on (the smallest named lawn or park round it), or by Mirror Lake; "" if none
  function placeOf(x, y) {
    let best = "", bestA = Infinity;
    for (const i of G.named) {
      const a = data.areas[i], B = G.aBox, m = a.k === "water" ? 25 : 0;
      if (x < B[4 * i] - m || x > B[4 * i + 2] + m || y < B[4 * i + 1] - m || y > B[4 * i + 3] + m) continue;
      if (a.k === "water") { if (G.aSize[i] < bestA) { best = "by " + a.n; bestA = G.aSize[i]; } continue; }
      if (G.aSize[i] < bestA && inRings(a.p, x, y)) { best = (/park\b/i.test(a.n) ? "in " : "on ") + a.n.replace(/^The /, "the "); bestA = G.aSize[i]; }
    }
    return best;
  }

  // ---------------------------------------------------------------- dens
  // The trees of grid cell c that are home to squirrels (worked out the first time the cell comes near the view): a
  // tree on a lawn (most of the ground round it is lawn), with one or two squirrels, more often on the named lawns and
  // round the middle of campus.
  function densOf(c) {
    let D = G.dens[c];
    if (D) return D;
    D = G.dens[c] = [];
    const L = G.tGrid[c];
    if (!L) return D;
    for (const t of L) {
      const x = tr[5 * t], y = tr[5 * t + 1], rad = tr[5 * t + 2], h = tr[5 * t + 3], con = tr[5 * t + 4] & 1;
      if (h < 4) continue;
      const seed = hashInt(t, 0x5c1a);
      const dO = Math.hypot(x - ovalX, y - ovalY), central = Math.exp(-(dO * dO) / (1000 * 1000));
      // (cheap before costly: most trees out in the neighbourhoods are no one's home)
      const pre = MANY ? 1 : 0.12 + 0.3 * central + 0.3;
      if (hash01(seed, 1) >= pre) continue;
      const ok = [];
      for (let q = 0; q < 8; q++) {
        const a = (q * Math.PI) / 4 + hash01(seed, 2) * 6.283, d = q & 1 ? Math.max(1.6, rad * 0.45) : Math.max(3, rad * 0.9);
        const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
        if (lawnAt(px, py) === 1) ok.push(px, py);
      }
      if (ok.length < 8) continue;
      const place = placeOf(x, y), lawnNamed = LAWN_NAME.test(place);
      let w = 0.12 + 0.3 * central + (lawnNamed ? 0.3 : 0);
      if (con) w *= 0.6;
      if (MANY) w = 1;
      if (hash01(seed, 1) >= w) continue;
      const n = MANY ? 2 + (hash01(seed, 3) < 0.5 ? 1 : 0) : 1 + (hash01(seed, 3) < 0.25 + 0.35 * central ? 1 : 0);
      D.push({
        t, x, y, rad, h, con, seed, n, place, ok: Float32Array.from(ok), R: 7 + 6 * hash01(seed, 4) + Math.min(4, rad * 0.5),
        tr0: 0.15, tr1: 0.1, top: 1, bare: false, style: null, seen: false, stamp: 0,
      });
    }
    return D;
  }
  // the trunk as the tiles draw it, for the season: its radius at the foot and up top, and the height to which it shows
  // (above it a squirrel is up in the crown, or among the branches of a bare tree)
  function trunk(den) {
    const style = app.tileStyle || {};
    if (den.style === style.season) return den;
    den.style = style.season;
    const { rad, h } = den;
    if (den.con) { den.tr0 = 0.17; den.tr1 = 0.15; den.top = 0.16 * h; den.bare = false; }
    else if (renderer && renderer.treeBare && renderer.treeBare(den.t, style)) {
      const unit = h * COS_T, a0 = rad / unit;
      let a = BARE_A[0];
      for (const q of BARE_A) if (Math.abs(q - a0) < Math.abs(a - a0)) a = q;
      const ccy = -Math.max(1 - a * COS_T, 0.55), fork = Math.min(-0.24, ccy + a * 0.98 * 0.62);
      den.tr0 = (0.03 + a * 0.012) * unit * 0.85; den.tr1 = 0.016 * unit; den.top = -fork * h; den.bare = true;
    } else {
      const cz = Math.max(h - rad, h * 0.55);
      den.tr0 = Math.max(0.12, rad * 0.07); den.tr1 = den.tr0 * 0.6; den.top = Math.max(0.3, cz - (0.95 * rad) / COS_T); den.bare = false;
    }
    return den;
  }
  const trunkR = (den, z) => den.tr0 + (den.tr1 - den.tr0) * clamp(z / Math.max(0.5, den.top), 0, 1) + 0.04;

  // ================================================================================================ conditions
  const C = { act: 0, day: 1, temp: 55, rain: 0, snow: 0, storm: false, ground: 0, wind: 0, season: "autumn" };
  function readConditions() {
    const now = app.now(), t = localTime(now), W = app.weather || {}, style = app.tileStyle || {};
    const season = DAY[style.season] ? style.season : seasonOf(now);
    C.season = season;
    C.day = 1 - smooth(0.2, 0.6, Number.isFinite(W.night) ? W.night : t.h < 6.5 || t.h > 18.5 ? 1 : 0);
    // the reading (live or ?weather=) is for now: for another date (?time=), a typical temperature for the season
    const reading = W.source !== "none" && Number.isFinite(W.tempF) && Math.abs(now.getTime() - Date.now()) < 3 * 3600e3;
    C.temp = reading ? W.tempF : CLIMATE[season] ?? 55;
    C.rain = W.rain || 0; C.snow = W.snow || 0; C.storm = !!W.storm; C.wind = W.windMph || 0;
    C.ground = Math.max(style.snow || 0, (W.snowDepthM || 0) / 0.05);
    let a = curve(DAY[season], t.h) * SEASON[season] * C.day;
    a *= 0.25 + 0.75 * smooth(8, 32, C.temp);      // the cold keeps them in their dreys…
    a *= 1 - 0.5 * smooth(88, 100, C.temp);        // …and so does the heat
    a *= C.storm ? 0.04 : Math.max(0.05, 1 - 1.1 * C.rain);
    a *= 1 - 0.45 * smooth(22, 40, C.wind);
    // At snow-day cover (0.3, or 1.5 cm) all residents stay in their dens.
    const snowActivity = (1 - smooth(0, 0.3, C.ground)) * (1 - smooth(0, 0.65, C.snow));
    C.act = (MANY ? 1 : clamp(a, 0, 1)) * snowActivity;
  }
  function seasonOf(d) {
    const m = d.getMonth();
    return m === 11 || m <= 1 ? "winter" : m <= 4 ? "spring" : m <= 7 ? "summer" : m === 10 ? "late-autumn" : "autumn";
  }
  const autumn = () => C.season === "autumn" || C.season === "late-autumn";
  // is resident r of a den out of its tree now? (each takes turns of 9–23 minutes, out or in)
  function present(den, r, tMin) {
    const seed = hashInt(den.seed, r + 1), slot = 9 + 14 * hash01(seed, 5), off = hash01(seed, 6) * slot;
    return hash01(seed, Math.floor((tMin + off) / slot)) < C.act * (MANY ? 1 : 0.92);
  }

  // ================================================================================================ the squirrels
  const live = [], byKey = new Map();
  let stamp = 0;
  // mode: 0 just there, 1 fading in, 2 climbing down out of its tree
  function spawn(den, r, mode) {
    const seed = hashInt(den.seed, r + 1), R = rng(hashInt(seed, Math.floor(app.now().getTime() / 60000)));
    const nameI = (hash01(seed, 7) * NAMES.length) | 0;
    const S = {
      key: den.t * 4 + r, den, seed, R, sp: hash01(seed, 8) < (MANY ? 0.4 : 0.3) ? 1 : 0, sz: 0.92 + 0.16 * hash01(seed, 9),
      name: NAMES[nameI] + (hash01(seed, 10) < 0.22 ? " " + EPITHETS[(hash01(seed, 11) * EPITHETS.length) | 0] : ""),
      x: den.x, y: den.y, z: 0, h: R() * 6.283, st: FORAGE, t: 1, sub: 0, tx: 0, ty: 0, v: 0, mv: 0, ph: R(), hd: -1, look: 0,
      flick: 0, flickT: 0, alpha: 1, fade: 0, onTrunk: false, tree: null, th: 0, up: 1, cz: 0, vz: 0, thx: 0, thy: 0, side: 1,
      leaving: false, chase: null, role: 0, a: 0, d: 0,
      buried: 0, digX: 0, digY: 0, digT: -1, say: 0, sx: 0, sy: 0, vis: false, hid: false, hidK: -1, acc: 0,
      occ: null, occX: 1e9, occY: 1e9, occR: -1, occT: 0,
      gone: false, clock: 0,
    };
    if (mode === 2) {
      // out of the crown and down the trunk, head first
      trunk(den);
      S.onTrunk = true; S.tree = den; S.th = camAngle() + (R() - 0.5) * 2; S.z = den.top + 0.6; S.up = -1;
      placeOnTrunk(S); setState(S, PERCH, 0.3 + R() * 1.5);
    } else {
      // somewhere round its tree, doing something
      const k = (R() * (den.ok.length / 2)) | 0;
      S.x = den.ok[2 * k]; S.y = den.ok[2 * k + 1];
      if (pickTarget(S, 0, 3.5)) { S.x = S.tx; S.y = S.ty; }
      setState(S, R() < 0.6 ? FORAGE : SIT, 1 + R() * 4);
      if (mode === 1) { S.alpha = 0; S.fade = 1; }
    }
    live.push(S); byKey.set(S.key, S);
    return S;
  }
  function remove(S) {
    const i = live.indexOf(S);
    if (i >= 0) { live[i] = live[live.length - 1]; live.pop(); }
    byKey.delete(S.key);
    S.gone = true;
    if (S.chase) endChase(S.chase);
  }
  function dropAll() { for (const S of live) { S.gone = true; S.chase = null; } live.length = 0; byKey.clear(); }
  // the direction (ground angle) from a tree toward the camera: a squirrel climbing on that side is in plain view
  const camAngle = () => Math.atan2(-D1, -D0);
  function placeOnTrunk(S) {
    const den = S.tree, r = trunkR(den, S.z);
    S.x = den.x + Math.cos(S.th) * r; S.y = den.y + Math.sin(S.th) * r;
  }

  // ---------------------------------------------------------------- choosing what to do
  function setState(S, st, t) {
    S.st = st; S.t = t; S.sub = 0; S.say = (S.R() * 1e6) | 0;
    if (st === HOP || st === TOTREE) S.ph = 0;
  }
  // somewhere to go: lawn (not path), within the squirrel's range of its tree and clear of the trunk, between d0 and d1
  // metres away, and not across a building or a road
  function pickTarget(S, d0, d1) {
    const den = S.den, R = S.R;
    for (let k = 0; k < 6; k++) {
      let a = R() * 6.283;
      const toDen = Math.hypot(S.x - den.x, S.y - den.y);
      if (toDen > den.R * 0.6 && R() < 0.6) a = Math.atan2(den.y - S.y, den.x - S.x) + (R() - 0.5) * 1.6;
      const d = d0 + (d1 - d0) * R(), x = S.x + Math.cos(a) * d, y = S.y + Math.sin(a) * d;
      const fromDen = Math.hypot(x - den.x, y - den.y);
      if (fromDen > den.R || fromDen < trunkR(den, 0) + 0.3) continue;
      if (lawnAt(x, y) !== 1 || (d > 1.5 && lawnAt((x + S.x) / 2, (y + S.y) / 2) === 0)) continue;
      S.tx = x; S.ty = y;
      return true;
    }
    // nowhere new: back toward one of the lawn spots round its tree
    const k = (R() * (den.ok.length / 2)) | 0;
    S.tx = den.ok[2 * k]; S.ty = den.ok[2 * k + 1];
    return false;
  }
  function hopTo(S, d0, d1, speed) {
    pickTarget(S, d0, d1);
    S.v = speed; setState(S, HOP, 6);
  }
  function toTree(S) {
    const den = trunk(S.den);
    S.tree = den;
    S.th = camAngle() + (S.R() - 0.5) * 2.2;
    const r = trunkR(den, 0);
    S.tx = den.x + Math.cos(S.th) * (r + 0.05); S.ty = den.y + Math.sin(S.th) * (r + 0.05);
    S.v = 2.6 + S.R(); setState(S, TOTREE, 8);
  }
  function decide(S) {
    const R = S.R, r = R();
    if (S.leaving) { toTree(S); return; }
    const dig = autumn() ? 0.22 : C.season === "winter" ? 0.12 : 0.05;
    let acc = 0;
    if (r < (acc += 0.4)) { hopTo(S, 1.2, 5.5, 2 + R() * 2.2); return; }
    if (r < (acc += 0.14)) { setState(S, SIT, 1.5 + R() * 3.5); return; }
    if (r < (acc += dig)) { setState(S, DIG, 1.6 + R() * 1.8); S.digX = S.x + Math.cos(S.h) * 0.16; S.digY = S.y + Math.sin(S.h) * 0.16; S.digT = performance.now() / 1000; return; }
    if (r < (acc += 0.07)) { toTree(S); return; }
    if (r < (acc += 0.07) && startChase(S)) return;
    setState(S, FORAGE, 2 + R() * 4);
  }
  // after a dash: a pause, head up, a flick of the tail; then often another dash (they go in bursts)
  function afterHop(S) {
    S.flick = Math.max(S.flick, 0.6 + S.R() * 0.4);
    setState(S, ALERT, 0.35 + S.R() * 1.1);
  }

  // ---------------------------------------------------------------- chases
  // A chase: the one being chased (lead) runs to its tree, spirals up the trunk and back down (or round its foot, under
  // a low crown) and bolts off across the lawn; the chaser follows the same path a moment behind.
  const LEG = 12;   // floats per leg: kind, t0, t1, then a line's x0 y0 x1 y1 or a spiral's cx cy r0 r1 th0 w z0 z1
  function startChase(S) {
    let P = null, best = 6.5;
    for (const Q of live) {
      if (Q === S || Q.chase || Q.leaving || Q.onTrunk || Q.alpha < 1 || Q === sel) continue;
      if (Q.st !== FORAGE && Q.st !== SIT && Q.st !== ALERT && Q.st !== DIG) continue;
      const d = Math.hypot(Q.x - S.x, Q.y - S.y);
      if (d < best) { best = d; P = Q; }
    }
    if (!P || S.leaving) return false;
    // up the chased one's own tree, or the chaser's if that's nearer
    const dA = Math.hypot(P.x - P.den.x, P.y - P.den.y), dB = Math.hypot(P.x - S.den.x, P.y - S.den.y);
    const den = trunk(dB < dA ? S.den : P.den), R = S.R;
    const L = new Float32Array(LEG * 6);
    let n = 0, t = 0;
    const line = (x0, y0, x1, y1, v) => {
      const T = Math.max(0.15, Math.hypot(x1 - x0, y1 - y0) / v), o = LEG * n++;
      L[o] = 0; L[o + 1] = t; L[o + 2] = t + T; L[o + 3] = x0; L[o + 4] = y0; L[o + 5] = x1; L[o + 6] = y1;
      t += T;
    };
    const spiral = (r0, r1, th0, w, turns, z0, z1) => {
      const T = (turns * 6.283) / Math.abs(w), o = LEG * n++;
      L[o] = 1; L[o + 1] = t; L[o + 2] = t + T; L[o + 3] = den.x; L[o + 4] = den.y; L[o + 5] = r0; L[o + 6] = r1;
      L[o + 7] = th0; L[o + 8] = w; L[o + 9] = z0; L[o + 10] = z1;
      t += T;
      return th0 + w * T;
    };
    const w = (R() < 0.5 ? -1 : 1) * (4.6 + R() * 1.4);
    const th0 = Math.atan2(P.y - den.y, P.x - den.x);
    const low = den.top < 0.75, H = low ? 0 : Math.max(0.45, Math.min(den.top - 0.12, 1 + R() * 1.6));
    const r0 = low ? trunkR(den, 0) + 0.45 : trunkR(den, 0), r1 = low ? r0 : trunkR(den, H);
    line(P.x, P.y, den.x + Math.cos(th0) * r0, den.y + Math.sin(th0) * r0, 4.2);
    let th = low ? spiral(r0, r0, th0, w * 0.8, 1.6 + R(), 0, 0) : spiral(r0, r1, th0, w, 1.2 + R() * 1.1, 0, H);
    if (!low) th = spiral(r1, r0, th, w, 0.9 + R() * 0.7, H, 0);
    // off across the lawn, with a jink half way
    const fx = den.x + Math.cos(th) * r0, fy = den.y + Math.sin(th) * r0, Sq = { den, R, x: fx, y: fy, tx: 0, ty: 0 };
    pickTarget(Sq, 2.5, 4);
    const mx = Sq.tx, my = Sq.ty;
    Sq.x = mx; Sq.y = my;
    pickTarget(Sq, 2, 4);
    line(fx, fy, mx, my, 4.6);
    line(mx, my, Sq.tx, Sq.ty, 4);
    const ch = { lead: P, fol: S, den, L, n, T: t, t: 0, lag: 0.42, locked: false, done: false };
    for (const Q of [P, S]) { Q.chase = ch; setState(Q, CHASE, 99); Q.mv = 0; }
    P.role = 1; S.role = 2;
    P.flick = S.flick = 1;
    if (P.vis && SCALE >= DETAIL_S) cue("squirrel", P.x, P.y, 7);
    return true;
  }
  const EV = { x: 0, y: 0, z: 0, hx: 1, hy: 0, vz: 0, trunk: false, th: 0, v: 0 };
  function evalChase(ch, t, O) {
    const L = ch.L;
    t = clamp(t, 0, ch.T - 1e-4);
    let o = 0;
    for (let k = 0; k < ch.n; k++) { o = LEG * k; if (t < L[o + 2]) break; }
    const u = (t - L[o + 1]) / Math.max(1e-6, L[o + 2] - L[o + 1]);
    if (L[o] === 0) {
      const dx = L[o + 5] - L[o + 3], dy = L[o + 6] - L[o + 4], d = Math.hypot(dx, dy);
      O.x = L[o + 3] + dx * u; O.y = L[o + 4] + dy * u; O.z = 0; O.vz = 0; O.trunk = false;
      if (d > 1e-4) { O.hx = dx / d; O.hy = dy / d; }
      O.v = d / Math.max(1e-6, L[o + 2] - L[o + 1]);
    } else {
      const th = L[o + 7] + L[o + 8] * (t - L[o + 1]), r = L[o + 5] + (L[o + 6] - L[o + 5]) * u, sg = Math.sign(L[o + 8]);
      O.x = L[o + 3] + Math.cos(th) * r; O.y = L[o + 4] + Math.sin(th) * r;
      O.z = L[o + 9] + (L[o + 10] - L[o + 9]) * u; O.vz = (L[o + 10] - L[o + 9]) / Math.max(1e-6, L[o + 2] - L[o + 1]);
      O.hx = -Math.sin(th) * sg; O.hy = Math.cos(th) * sg; O.th = th;
      O.trunk = L[o + 9] > 0 || L[o + 10] > 0;
      O.v = Math.abs(L[o + 8]) * r;
    }
    return O;
  }
  function endChase(ch) {
    if (ch.done) return;
    ch.done = true;
    for (const Q of [ch.lead, ch.fol]) {
      if (Q.chase !== ch) continue;
      Q.chase = null; Q.role = 0;
      if (Q.gone) continue;
      if (Q.onTrunk) { Q.up = -1; setState(Q, DOWN, 9); continue; }
      Q.z = 0; Q.flick = 1;
      setState(Q, Q === ch.lead ? SIT : ALERT, 0.8 + Q.R() * 1.6);
    }
  }
  function stepChase(ch, dt) {
    ch.t += dt;
    const A = ch.lead, B = ch.fol;
    if (A.gone || B.gone) { endChase(ch); return; }
    put(A, evalChase(ch, ch.t, EV), ch, dt);
    if (ch.t >= ch.T) A.mv = 0;
    evalChase(ch, ch.t - ch.lag, EV);
    if (!ch.locked) {
      // the chaser closes in on the path first
      const dx = EV.x - B.x, dy = EV.y - B.y, d = Math.hypot(dx, dy), st = 6.5 * dt;
      if (d <= st + 0.05) ch.locked = true;
      else {
        B.x += (dx / d) * st; B.y += (dy / d) * st; B.h = Math.atan2(dy, dx); B.mv = 6.5; B.z = 0; B.onTrunk = false;
        B.ph += st / 0.5;
      }
    }
    if (ch.locked) put(B, EV, ch, dt);
    if (ch.t >= ch.T + ch.lag) endChase(ch);
  }
  // a squirrel where the chase path puts it
  function put(S, O, ch, dt) {
    const moved = Math.hypot(O.x - S.x, O.y - S.y) + Math.abs(O.z - S.z);
    S.x = O.x; S.y = O.y; S.z = O.z; S.mv = O.v;
    S.onTrunk = O.trunk;
    if (O.trunk) { S.th = O.th; S.tree = ch.den; S.up = O.vz >= 0 ? 1 : -1; S.vz = O.vz; S.thx = O.hx; S.thy = O.hy; }
    else { S.h = Math.atan2(O.hy, O.hx); S.tree = null; }
    S.ph += moved / (O.trunk ? 0.3 : 0.5);
    if (dt > 0 && !O.trunk) S.z = 0.05 * Math.abs(Math.sin(Math.PI * S.ph));
  }

  // ---------------------------------------------------------------- stepping
  function step(S, dt) {
    S.clock += dt;
    if (S.fade) {
      S.alpha += S.fade * dt / 0.8;
      if (S.alpha >= 1) { S.alpha = 1; S.fade = 0; }
      else if (S.alpha <= 0) { remove(S); return; }
    }
    if (S.flick > 0) S.flick = Math.max(0, S.flick - dt * 0.9);
    else if (S.st !== HOP && S.st !== CHASE && (S.flickT -= dt) <= 0) { S.flick = 0.5 + S.R() * 0.5; S.flickT = 3 + S.R() * 9; }
    if (S.st === CHASE) return;   // its chase moves it
    S.t -= dt;
    const R = S.R;
    switch (S.st) {
      case FORAGE: {
        // nose to the grass; now and then a little step, or a look up
        S.sub -= dt;
        if (S.sub <= 0) {
          const r = R();
          if (r < 0.45) { const a = S.h + (R() - 0.5) * 2.4, d = 0.12 + R() * 0.3; const x = S.x + Math.cos(a) * d, y = S.y + Math.sin(a) * d; if (lawnAt(x, y) === 1) { S.tx = x; S.ty = y; S.v = 0.7; } S.hd = -1; }
          else if (r < 0.7) S.hd = 0.6;
          else S.hd = -1;
          S.sub = 0.5 + R() * 1.4;
        }
        if (S.v > 0) moveToward(S, dt, true); else S.mv = 0;
        if (S.t <= 0) decide(S);
        break;
      }
      case HOP: {
        S.hd = 0;
        if (moveToward(S, dt, false)) { S.z = 0; afterHop(S); }
        else if (S.t <= 0) { S.z = 0; afterHop(S); }
        break;
      }
      case ALERT:
        S.hd = 1; S.mv = 0;
        if (S.t <= 0) {
          if (S.leaving) toTree(S);
          else if (R() < 0.45) hopTo(S, 0.8, 4, 1.8 + R() * 2.4);
          else if (R() < 0.5) setState(S, FORAGE, 1.5 + R() * 4);
          else setState(S, SIT, 1.2 + R() * 3);
        }
        break;
      case SIT:
      case FREEZE:
        S.mv = 0;
        S.sub -= dt;
        if (S.sub <= 0) { S.look = R() < 0.4 ? 0 : R() < 0.5 ? -1 : 1; S.sub = 0.6 + R() * 1.6; if (S.st === SIT && R() < 0.3) S.h += (R() - 0.5) * 2.2; }
        if (S.t <= 0) { if (S.st === FREEZE) hopTo(S, 2, 5, 3 + R() * 1.5); else decide(S); }
        break;
      case DIG:
        S.mv = 0; S.hd = -1;
        if (S.t <= 0) setState(S, BURY, 0.9 + R() * 1.2);
        break;
      case BURY:
        S.mv = 0; S.hd = -1;
        if (S.t <= 0) {
          S.buried++;
          if (autumn() && S.vis && SCALE >= DETAIL_S) cue("rustle", S.x, S.y, 10);
          S.flick = 1; setState(S, ALERT, 0.6 + R() * 1.2);
        }
        break;
      case TOTREE:
        if (moveToward(S, dt, false) || S.t <= 0) {
          S.z = 0; S.onTrunk = true; S.up = 1;
          const den = trunk(S.tree || S.den);
          S.tree = den;
          S.th = Math.atan2(S.y - den.y, S.x - den.x);
          // up a little way and back down; or, going home, up into the crown
          S.cz = S.leaving ? den.top + 0.7 : Math.max(0.5, Math.min(den.bare ? den.top * 0.85 : den.top + (R() < 0.35 ? 0.7 : -0.15), 1 + R() * 2.6));
          setState(S, UP, 30);
        }
        break;
      case UP: {
        const den = trunk(S.tree);
        S.z += 1.7 * dt; S.mv = 1.7; S.ph += (1.7 * dt) / 0.3; S.vz = 1.7;
        placeOnTrunk(S);
        if (S.z >= S.cz) {
          S.z = S.cz;
          if (S.leaving && S.z > den.top + 0.4) { remove(S); return; }
          setState(S, PERCH, S.z > den.top + 0.3 ? 3 + R() * 9 : 0.8 + R() * 2.5);
          S.flick = 0.8;
        }
        break;
      }
      case PERCH:
        S.mv = 0; S.vz = 0;
        if (S.t <= 0) { S.up = -1; setState(S, DOWN, 30); }
        break;
      case DOWN: {
        S.z -= 1.4 * dt; S.mv = 1.4; S.ph += (1.4 * dt) / 0.3; S.vz = -1.4;
        S.onTrunk = true;
        placeOnTrunk(S);
        if (S.z <= 0) {
          // off the trunk and away
          const den = S.tree, r = trunkR(den, 0) + 0.12;
          S.z = 0; S.onTrunk = false; S.tree = null;
          S.x = den.x + Math.cos(S.th) * r; S.y = den.y + Math.sin(S.th) * r; S.h = S.th;
          if (S.leaving) toTree(S); else hopTo(S, 1.5, 5, 2.6 + R() * 1.6);
        }
        break;
      }
    }
  }
  // towards (tx, ty) at v, bounding (or stepping, when foraging); true on arrival
  function moveToward(S, dt, stepping) {
    const dx = S.tx - S.x, dy = S.ty - S.y, d = Math.hypot(dx, dy);
    if (d < 0.02) { S.mv = 0; S.v = stepping ? 0 : S.v; return true; }
    const st = Math.min(d, S.v * dt);
    S.x += (dx / d) * st; S.y += (dy / d) * st; S.h = Math.atan2(dy, dx); S.mv = st / Math.max(1e-6, dt);
    S.ph += st / (stepping ? 0.18 : 0.5);
    S.z = stepping ? 0 : 0.055 * Math.abs(Math.sin(Math.PI * S.ph)) * Math.min(1, S.v / 2);
    if (st >= d - 1e-6) { if (stepping) S.v = 0; return true; }
    return false;
  }

  // ================================================================================================ the population
  let failed = false, tickAt = -1e9, condAt = -1e9, cellsLeft = 0;
  const todo = [];
  // Which dens are near the view, which of their squirrels should be out, and those squirrels brought out or sent home.
  function manage(force, slice) {
    const now = performance.now();
    if (!force && now - tickAt < 400) return;
    tickAt = now;
    setCamera();
    if (now - condAt > 4000) { readConditions(); condAt = now; }
    const on = wildlifeOn() && SCALE >= SIM_S && !!app.scene;
    if (!on) { if (live.length) { dropAll(); app.requestRender("squirrels"); } cellsLeft = 0; return; }
    if (!grids(force ? 1e9 : slice || 5)) { tickAt = -1e9; return; }   // (the next slice on the next frame or tick)
    const tMin = app.now().getTime() / 60000, M = 0.25 * Math.max(VW, VH);
    // the ground under the view (and a margin): the corners of the screen, unprojected
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let c = 0; c < 4; c++) {
      const g = view.screenToGround(c & 1 ? VW + M : -M, c & 2 ? VH + M : -M);
      if (g[0] < x0) x0 = g[0]; if (g[0] > x1) x1 = g[0]; if (g[1] < y0) y0 = g[1]; if (g[1] > y1) y1 = g[1];
    }
    const i0 = Math.max(0, Math.floor((x0 - 20 - world.x0) / GC)), i1 = Math.min(GX - 1, Math.floor((x1 + 20 - world.x0) / GC));
    const j0 = Math.max(0, Math.floor((y0 - 20 - world.y0) / GC)), j1 = Math.min(GY - 1, Math.floor((y1 + 20 - world.y0) / GC));
    stamp++;
    // new cells are worked out a few milliseconds' worth at a time, the ones nearest the middle of the view first
    const budget = now + (force ? 40 : 6);
    const cx = Math.round((i0 + i1) / 2), cy = Math.round((j0 + j1) / 2);
    let left = 0, changed = false;
    // (the cells not yet worked out, nearest the middle first, as far as the budget goes)
    todo.length = 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (!G.dens[j * GX + i]) todo.push(Math.max(Math.abs(i - cx), Math.abs(j - cy)) * 1e7 + j * GX + i);
    if (todo.length) {
      todo.sort((a, b) => a - b);
      for (const q of todo) { if (performance.now() > budget) { left++; continue; } densOf(q % 1e7); }
    }
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const D = G.dens[j * GX + i];
        if (!D) continue;
        for (const den of D) {
          if (!onView(den.x, den.y, den.R, M)) continue;
          den.stamp = stamp;
          const seen = SCALE >= MIN_S && onView(den.x, den.y, 2, 0);
          for (let r = 0; r < den.n; r++) {
            const S = byKey.get(den.t * 4 + r), want = present(den, r, tMin);
            if (want && !S) { spawn(den, r, den.seen && seen && !reduceMQ.matches ? 2 : 0); changed = true; }
            else if (want && S && S.leaving) S.leaving = false;
            else if (!want && S && !S.leaving) {
              if (S.vis && !reduceMQ.matches) S.leaving = true;
              else { remove(S); changed = true; }
            }
          }
          den.seen = seen;
        }
    }
    cellsLeft = left;
    // the ones whose den has gone out of range
    for (let k = live.length - 1; k >= 0; k--) {
      const S = live[k];
      if (S.den.stamp !== stamp) { remove(S); changed = true; }
    }
    if (changed) app.requestRender("squirrels");
  }
  let lastStep = performance.now();
  function stepAll() {
    const now = performance.now(), dt = Math.min(0.5, Math.max(0, (now - lastStep) / 1000));
    lastStep = now;
    if (dt <= 0 || reduceMQ.matches || !live.length) return;
    setCamera();
    const n = Math.max(1, Math.ceil(dt / 0.1 - 1e-6)), h = dt / n, M = 40 + 0.5 * SCALE;
    for (let k = live.length - 1; k >= 0; k--) {
      const S = live[k];
      if (!S) continue;
      let sub = n, hh = h;
      // off screen (and not in a chase, nor the one whose card is open) it's stepped twice a second, in larger steps
      if (!S.vis && !S.chase && S !== sel && !onView(S.x, S.y, 1, M)) {
        S.acc += dt;
        if (S.acc < 0.5) continue;
        sub = Math.ceil(S.acc / 0.25 - 1e-6); hh = S.acc / sub; S.acc = 0;
      } else S.acc = 0;
      for (let q = 0; q < sub && !S.gone; q++) {
        if (S.chase && S.chase.lead === S) stepChase(S.chase, hh);
        step(S, hh);
      }
    }
  }

  // ================================================================================================ drawing
  const vis = [], shown = [], solo = [];
  let want = 0, nShown = 0;
  const byDepth = (a, b) => b.d - a.d;
  // the screen frame a squirrel is drawn in: F along its body (nose forward), U up off the ground (or out from the
  // trunk), both CSS px per metre of squirrel; and the point it stands on
  const M6 = { fx: 0, fy: 0, ux: 0, uy: 0, bx: 0, by: 0, away: false };
  function frameOf(S) {
    const s = SCALE, k = PK, sc = SZ * S.sz;
    if (!S.onTrunk) {
      const hx = Math.cos(S.h), hy = Math.sin(S.h);
      const hsx = PA * hx + PB * hy, hsy = PC * hx + PD * hy;
      // seen nose-on it is drawn foreshortened, never edge-on
      const dir = hsx >= 0 ? 1 : -1;
      M6.fx = dir * Math.max(Math.abs(hsx), 0.6 * s) * sc; M6.fy = hsy * 0.8 * sc;
      M6.ux = 0; M6.uy = -k * sc;
      M6.bx = S.sx; M6.by = S.sy;
      M6.away = hx * D0 + hy * D1 > 0;
      return M6;
    }
    // on a trunk: along its climb (up, down, or round), its back away from the trunk
    let gx = 0, gy = 0, vz = S.up >= 0 ? 1 : -1;
    if (S.st === CHASE) { gx = S.thx * 0.8; gy = S.thy * 0.8; vz = S.vz; }
    let dx = PA * gx + PB * gy, dy = PC * gx + PD * gy - k * vz;
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl; dy /= dl;
    if (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3) { dx = 0; dy = -1; }
    const ox = Math.cos(S.th) * R0 + Math.sin(S.th) * R1;
    if (Math.abs(ox) > 0.25) S.side = ox > 0 ? 1 : -1;
    let px = -dy, py = dx;
    if (Math.abs(px) > 0.2 ? Math.sign(px) !== S.side : py > 0) { px = -px; py = -py; }
    M6.fx = dx * s * sc; M6.fy = dy * s * sc; M6.ux = px * 0.8 * s * sc; M6.uy = py * 0.8 * s * sc;
    M6.bx = S.sx; M6.by = S.sy - S.z * k;
    M6.away = false;
    return M6;
  }
  // how much of a squirrel on a trunk shows: it fades into a leafy crown (or among a bare tree's branches)
  function trunkAlpha(S) {
    if (!S.onTrunk) return 1;
    const top = (S.tree || S.den).top;
    return 1 - smooth(top - 0.05, top + 0.35, S.z);
  }

  function draw(ctx) {
    vis.length = 0; want = 0; nShown = 0;
    if (failed || !live.length || !wildlifeOn()) { whimsy.squirrels = 0; return; }
    setCamera();
    const s = SCALE;
    if (s < MIN_S) { whimsy.squirrels = 0; return; }
    const fadeS = Math.min(1, (s - MIN_S) / 1);
    const m = 0.6 * s * SZ + 4;
    for (const S of live) {
      S.vis = false;
      S.sx = PA * S.x + PB * S.y + PE; S.sy = PC * S.x + PD * S.y + PF;
      if (S.sx < -m || S.sx > VW + m || S.sy < -m - S.z * PK || S.sy > VH + m) continue;
      S.a = S.alpha * trunkAlpha(S) * fadeS;
      if (S.a <= 0.02) continue;
      S.d = S.x * D0 + S.y * D1 - (S.onTrunk ? 0.05 : 0);
      vis.push(S);
    }
    if (!vis.length && !sel) { whimsy.squirrels = 0; return; }
    vis.sort(byDepth);
    const close = s >= DETAIL_S, clock = performance.now() / 1000, dpr = view.dpr;
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    // what they've dug: a little scuffed patch, fading over DIG_LIFE seconds (in three steps, a fill each; a patch a few
    // pixels across is as good as a rectangle)
    if (close) {
      ctx.fillStyle = C.ground > 0.3 ? "#c9d0d8" : DIRT;
      const rx = 0.075 * s * SZ, ry = 0.034 * s * SZ, small = rx < 3;
      for (let lv = 3; lv >= 1; lv--) {
        let any = false;
        for (const S of live) {
          if (S.digT < 0) continue;
          const age = clock - S.digT, a = (S.st === DIG || S.st === BURY ? Math.min(1, (age + 0.3) / 1.2) : 1) * (1 - age / DIG_LIFE);
          if (a <= 0.02) { if (age > DIG_LIFE) S.digT = -1; continue; }
          if (Math.ceil(a * 3) !== lv) continue;
          const px = PA * S.digX + PB * S.digY + PE, py = PC * S.digX + PD * S.digY + PF;
          if (px < -10 || px > VW + 10 || py < -10 || py > VH + 10) continue;
          if (!any) { ctx.beginPath(); any = true; }
          if (small) ctx.rect(px - rx * 0.8, py - ry * 0.8, rx * 1.6, ry * 1.6);
          else { ctx.moveTo(px + rx, py); ctx.ellipse(px, py, rx, ry, 0, 0, Math.PI * 2); }
        }
        if (any) { ctx.globalAlpha = 0.38 * (lv / 3) * fadeS; ctx.fill(); }
      }
    }
    // the one whose card is open: a ring at its feet
    if (sel && !sel.gone && sel.a > 0.05 && cardH) {
      const k = sel.onTrunk ? sel.z * PK : 0;
      ctx.globalAlpha = 0.85; ctx.strokeStyle = "#b3202a"; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.ellipse(sel.sx, sel.sy - k, Math.max(7, 0.36 * s * SZ), Math.max(3.5, 0.18 * s * SZ), 0, 0, Math.PI * 2); ctx.stroke();
    }
    let moving = false, idle = false;
    // On the ground a squirrel is a few pixels across: seen or hidden whole, as life.js treats walkers from afar. Those
    // seen go into the frame's batch (or, fading, are drawn on their own); on a trunk, close up, each is drawn on its own,
    // cut round whatever stands in front (its own trunk, when it goes round the back).
    shown.length = 0; solo.length = 0;
    for (const S of vis) {
      if (close && S.onTrunk) solo.push(S);
      else if (hidden(S)) continue;
      else if (S.a >= 0.98 * fadeS) shown.push(S);
      else solo.push(S);
      S.vis = true;
      if (S.a > 0.1) nShown++;
      if (S.mv > 0.9 || S.fade || S.st === CHASE) moving = true;
      else idle = true;
    }
    if (close) {
      for (const S of shown) batch(S);
      ctx.globalAlpha = 1;
      flush(ctx, s >= 11);
      for (const S of shown) if (S.st === DIG) dirt(ctx, S, frameOf(S));
    } else if (shown.length) {
      ctx.globalAlpha = fadeS;
      for (let sp = 0; sp < 2; sp++) {
        ctx.fillStyle = PALS[sp].far; ctx.beginPath();
        for (const S of shown) if (S.sp === sp) farBody(ctx, S);
        ctx.fill();
        ctx.fillStyle = PALS[sp].fringe; ctx.beginPath();
        for (const S of shown) if (S.sp === sp) farTail(ctx, S);
        ctx.fill();
      }
    }
    for (const S of solo) {
      if (close && S.onTrunk) { if (!drawCut(ctx, S, occluders(S, clock), dpr)) paint(ctx, S, true, dpr); }
      else paint(ctx, S, close, dpr);
    }
    ctx.restore();
    whimsy.squirrels = nShown;
    // a bound is a few pixels a frame at these rates; close up the nibbling, digging and tail flicks want a few frames too
    if (!reduceMQ.matches) want = moving ? (close ? 24 : 12) : idle && close ? 8 : 0;
  }

  // ---------------------------------------------------------------- what stands in front
  // The scene objects whose screen box meets the squirrel's (with a few metres' room, so the list holds while it moves
  // about), refreshed when it has moved a metre or two, or the view has turned.
  function occluders(S, clock) {
    if (!app.scene) return null;
    if (S.occR === ROT && Math.abs(S.x - S.occX) + Math.abs(S.y - S.occY) < 1.5 && clock < S.occT) return S.occ;
    const X = S.x * R0 + S.y * R1, Y = -(S.x * D0 + S.y * D1) * SIN_T;
    S.occ = app.scene.query(ROT, "objects", X - 2.5, Y - (S.z + 1.2) * COS_T - 2.5, X + 2.5, Y + 2.5);
    S.occR = ROT; S.occX = S.x; S.occY = S.y; S.occT = clock + 2;
    return S.occ;
  }
  // Draw a squirrel through a clip that leaves out the outlines of the objects standing in front of it (and its own
  // tree when it's round the back of the trunk); false if nothing does (then it's drawn plainly).
  const SIL = makeRecorder(), SIL_EXACT = SIL.withAddPath();
  const BOX = [0, 0, 0, 0];
  function drawCut(ctx, S, ids, dpr) {
    const sc = app.scene;
    if (!sc) return false;
    const s = SCALE, k = PK, r = 0.45 * s * SZ * S.sz + 2;
    BOX[0] = S.sx - r; BOX[2] = S.sx + r; BOX[1] = S.sy - S.z * k - 0.5 * k * SZ - r * 0.5; BOX[3] = S.sy + 0.25 * s * SZ + 2;
    const X0 = BOX[0], Y0 = BOX[1], X1 = BOX[2], Y1 = BOX[3];
    const St = sc.forRot(ROT), bb = St.objBB, B = sc.B, T = sc.T;
    const mX0 = (X0 - PE) / s, mY0 = (Y0 - PF) / s, mX1 = (X1 - PE) / s, mY1 = (Y1 - PF) / s;
    SIL.reset();
    let n = 0;
    const own = S.onTrunk && S.tree ? B + S.tree.t : -1;
    if (ids) for (let q = 0; q < ids.length; q++) {
      const id = ids[q], o = 4 * id;
      if (id === own || bb[o + 2] < mX0 || bb[o] > mX1 || bb[o + 3] < mY0 || bb[o + 1] > mY1) continue;
      if (!sc.inFront(ROT, id, S.x, S.y, 0.2)) continue;
      const conifer = id >= B && id < B + T && (tr[5 * (id - B) + 4] & 1);
      renderer.silhouette(conifer ? SIL_EXACT : SIL, ROT, CAM, id, app.tileStyle);
      n++;
    }
    // round the back of its own trunk
    if (own >= 0 && S.x * D0 + S.y * D1 > S.tree.x * D0 + S.tree.y * D1 + 0.02) {
      renderer.silhouette(tr[5 * S.tree.t + 4] & 1 ? SIL_EXACT : SIL, ROT, CAM, own, app.tileStyle);
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
    paint(ctx, S, true, dpr);
    ctx.restore();
    return true;
  }
  // A building, a leafy crown or a trunk in front of the middle of it: worked out once per half-metre square of
  // ground for the view's turn (and the season), and kept until the view turns.
  const HID = new Map();
  function hidden(S) {
    if (!app.scene) return false;
    const i = Math.floor((S.x - world.x0) * 2), j = Math.floor((S.y - world.y0) * 2), key = i * 16384 + j;
    if (key === S.hidK) return S.hid;
    let v = HID.get(key);
    if (v === undefined) {
      if (HID.size > 60000) HID.clear();
      v = pointHidden(world.x0 + (i + 0.5) / 2, world.y0 + (j + 0.5) / 2, 0.1 * SZ);
      HID.set(key, v);
    }
    S.hidK = key; S.hid = v;
    return v;
  }
  function pointHidden(x, y, h) {
    const sc = app.scene, r = ROT, o = geo.ROTS[r];
    const U = x * o.R[0] + y * o.R[1], Y = -(x * o.D[0] + y * o.D[1]) * SIN_T - h * COS_T;
    const b = sc.pickBuilding(r, U, Y);
    if (b >= 0 && sc.inFront(r, b, x, y, 0)) return true;
    const ids = sc.query(r, "objects", U - 0.2, Y - 0.2, U + 0.2, Y + 0.2), B = sc.B, T = sc.T;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k];
      if (id < B || id >= B + T || !sc.inFront(r, id, x, y, 0)) continue;
      const t = id - B, tx = tr[5 * t], ty = tr[5 * t + 1], rad = tr[5 * t + 2], th = tr[5 * t + 3];
      const cu = tx * o.R[0] + ty * o.R[1], base = -(tx * o.D[0] + ty * o.D[1]) * SIN_T;
      // the crown (a leafy one; a conifer's as a circle round its middle)…
      const con = tr[5 * t + 4] & 1, bare = !con && renderer.treeBare(t, app.tileStyle);
      if (!bare) {
        const cv = base - (con ? th * 0.55 : Math.max(th - rad, th * 0.55)) * COS_T;
        if ((U - cu) ** 2 + (Y - cv) ** 2 < rad * rad * (con ? 0.6 : 1)) return true;
      }
      // …or the trunk, as the tiles draw it
      const tk = trunkOf(t);
      if (Y <= base && Y >= base - tk.top * COS_T && Math.abs(U - cu) < tk.tr0 + (tk.tr1 - tk.tr0) * ((base - Y) / Math.max(0.1, tk.top * COS_T))) return true;
    }
    return false;
  }
  // any tree's trunk (as a den's, without keeping it)
  const TK = { t: -1, con: 0, rad: 0, h: 0, tr0: 0, tr1: 0, top: 0, bare: false, style: null };
  function trunkOf(t) {
    TK.t = t; TK.con = tr[5 * t + 4] & 1; TK.rad = tr[5 * t + 2]; TK.h = tr[5 * t + 3]; TK.style = null;
    return trunk(TK);
  }

  // ---------------------------------------------------------------- painting
  // A pose, its animation held to a few frames (a bound in 8, a tail flick in 5 positions, a nibble in 3…), is drawn from
  // a template: one outline per paint (shadow, tail fringe and core, shaded haunch, body, belly, eye) as points and
  // Bézier curves (ellipses too) in the squirrel's own frame, in metres (along the body, and up off the ground or out
  // from the trunk), the same at every zoom. A squirrel is that template with its frame's matrix applied point by point
  // (an affine map takes Béziers to Béziers): on its own (fading, on a trunk, cut round what's in front) as seven fills,
  // or, the usual case, into the frame's batch: one path per paint and kind of squirrel, filled once.
  const TPL = new Map();
  const PZ = { pose: 0, hd: 0, nib: 0, dig: 0, df: 0, fl: 0, ph: 0, look: 0, eat: 0, lo: 0 };
  function poseKey(S) {
    const t = S.clock, Z = PZ;
    const pose = S.onTrunk ? CLIMB : S.st === SIT || S.st === FREEZE ? SITUP : S.mv > 0.9 ? RUN : CROUCH;
    Z.pose = pose; Z.hd = 0; Z.nib = 0; Z.dig = 0; Z.df = 0; Z.fl = 0; Z.ph = 0; Z.look = 0; Z.eat = 0;
    if (pose === RUN || pose === CLIMB) { Z.ph = Math.floor((S.ph % 1) * 8) & 7; return pose + 4 * Z.ph; }
    // (keys: the pose in the low two bits, then each quantity in its own range)
    const fl = S.flick > 0 ? Math.round(S.flick * Math.sin(t * 26) * 2) : 0;
    Z.fl = fl;
    let key = pose + 4 * (fl + 2);
    if (pose === SITUP) {
      Z.look = S.look; Z.eat = S.look === 0 && S.st === SIT ? 1 : 0;
      if (Z.eat) { const sn = Math.sin(t * 14); Z.nib = sn > 0.33 ? 1 : sn < -0.33 ? -1 : 0; }
      return key + 20 * (Z.look + 1) + 60 * Z.eat + 120 * (Z.nib + 1);
    }
    const hd = S.hd < 0 ? 0 : S.hd < 0.3 ? 1 : S.hd < 0.8 ? 2 : 3, dig = S.st === DIG ? 1 : S.st === BURY ? 2 : 0;
    Z.hd = HDS[hd]; Z.dig = dig;
    if (dig) Z.df = Math.floor((t * (dig === 1 ? 16 : 8)) / (Math.PI / 2)) & 3;
    else if (hd === 0) { const sn = Math.sin(t * 15); Z.nib = sn > 0.33 ? 1 : sn < -0.33 ? -1 : 0; }
    return key + 20 * hd + 80 * dig + 240 * Z.df + 960 * (Z.nib + 1);
  }
  const HDS = [-1, 0, 0.6, 1], ROCK = [0, 1, 0, -1], PAWQ = [1, 0, -1, 0];
  function templateOf(S) {
    // (from afar, below 11 px a metre, a lighter outline: the tail's edges as one curve each, no ear)
    PZ.lo = SCALE < 11 ? 1 : 0;
    const key = poseKey(S) + 8192 * PZ.lo;
    let T = TPL.get(key);
    if (!T) { if (TPL.size > 3000) TPL.clear(); T = buildTemplate(PZ); TPL.set(key, T); }
    return T;
  }
  function buildTemplate(Z) {
    const T = { shadow: null, fringe: null, core: null, dark: null, body: null, belly: null, eye: null }, R = REC;
    const pose = Z.pose, ph = (Z.ph / 8) * Math.PI * 2, e = Math.cos(ph), w = Math.sin(ph), fl = Z.fl / 2, A = TAIL;
    // the tail: a bushy plume, a pale fringe round a darker core; flicked now and then
    switch (pose) {
      case RUN:
        A[0] = -0.09; A[1] = 0.08; A[2] = -0.19; A[3] = 0.13 + 0.03 * w; A[4] = -0.28; A[5] = 0.2 + 0.035 * Math.sin(ph + 1.2); A[6] = -0.36; A[7] = 0.15 + 0.035 * Math.sin(ph + 2.4);
        break;
      case CLIMB:
        A[0] = -0.09; A[1] = 0.06; A[2] = -0.2; A[3] = 0.13; A[4] = -0.29; A[5] = 0.16 + 0.03 * w; A[6] = -0.35; A[7] = 0.09 + 0.02 * e;
        break;
      case SITUP:
        A[0] = -0.06; A[1] = 0.05; A[2] = -0.2; A[3] = 0.07; A[4] = -0.21 + 0.03 * fl; A[5] = 0.31; A[6] = -0.09 + 0.05 * fl; A[7] = 0.33 + 0.02 * fl;
        break;
      default:
        A[0] = -0.08; A[1] = 0.085; A[2] = -0.23; A[3] = 0.1; A[4] = -0.24 + 0.03 * fl; A[5] = 0.31; A[6] = -0.11 + 0.06 * fl; A[7] = 0.3 + 0.03 * fl;
    }
    if (Z.lo) { plumeLo(R, 1); T.fringe = R.take(); plumeLo(R, 0.55); T.core = R.take(); }
    else { plume(R, 1); T.fringe = R.take(); plume(R, 0.55); T.core = R.take(); }
    // a shadow on the ground (not on a trunk)
    if (pose !== CLIMB) { oval(R, -0.03, 0, pose === SITUP ? 0.13 : 0.19, 0.04, 0); T.shadow = R.take(); }
    // the haunch (and paws) in shade; body, head and ear; the pale belly
    let hx, hy, bx, by, brx, bry, brot, lx, ly, lrx, lry, ax, ay, arx, ary, erot, haX, haY, haR, haR2, hrot = 0, paws = 0;
    switch (pose) {
      case SITUP: {
        haX = -0.025; haY = 0.062; haR = 0.085; haR2 = 0.068;
        bx = 0; by = 0.13; brx = 0.072; bry = 0.105; brot = 0.15;
        lx = 0.034; ly = 0.125; lrx = 0.036; lry = 0.08;
        hx = 0.032 + 0.014 * Z.look; hy = 0.25;
        ax = hx - 0.016; ay = hy + 0.044; arx = 0.014; ary = 0.024; erot = 0.2; hrot = 0.1;
        if (Z.eat) { paws = 1; PAW[0] = 0.068; PAW[1] = 0.178 + 0.008 * Z.nib; }   // paws at its mouth
        break;
      }
      case RUN:
      case CLIMB: {
        // stretching and gathering as it bounds
        const o = pose === CLIMB ? -0.02 : 0;
        haX = -0.065 - 0.02 * e; haY = 0.062 + o; haR = 0.066; haR2 = 0.06;
        bx = 0; by = 0.074 + o; brx = 0.12 + 0.02 * e; bry = 0.056 - 0.006 * e; brot = 0.16 * w;
        lx = 0.012; ly = 0.046; lrx = pose === RUN ? 0.08 : 0; lry = 0.022;
        hx = 0.135 + 0.015 * e; hy = 0.09 + 0.01 * w + o;
        ax = hx - 0.022; ay = hy + 0.036; arx = 0.013; ary = 0.022; erot = -0.2; hrot = -0.05;
        break;
      }
      default: {
        // crouched: nose down (nibbling, digging), level, or up (alert)
        const hd = Z.hd, rock = Z.dig ? 0.08 * ROCK[Z.df] : 0;
        brot = (hd < 0 ? -0.22 : 0.12 * hd) + rock;
        haX = -0.058; haY = 0.068; haR = 0.072; haR2 = 0.066;
        bx = 0; by = 0.076; brx = 0.115; bry = 0.06;
        lx = 0.018; ly = 0.045; lrx = 0.075; lry = 0.022;
        hx = hd < 0 ? 0.135 : 0.125 - 0.012 * hd; hy = hd < 0 ? 0.045 + 0.006 * Z.nib : 0.1 + 0.038 * hd;
        ax = hx - 0.02; ay = hy + 0.038; arx = 0.013; ary = 0.022; erot = -0.15; hrot = hd < 0 ? -0.5 : 0.25 * hd;
        // paws going as it digs
        if (Z.dig) { const q = Z.dig === 1 ? PAWQ[Z.df] : 0; paws = 2; PAW[0] = 0.12 + 0.014 * q; PAW[1] = 0.014; PAW[2] = 0.145 - 0.014 * q; PAW[3] = 0.014; }
      }
    }
    oval(R, haX, haY, haR, haR2, 0);
    for (let i = 0; i < paws; i++) oval(R, PAW[2 * i], PAW[2 * i + 1], 0.019, 0.016, 0);
    T.dark = R.take();
    oval(R, bx, by, brx, bry, brot); if (!Z.lo) oval(R, ax, ay, arx, ary, erot); oval(R, hx, hy, 0.051, 0.043, hrot);
    T.body = R.take();
    if (lrx > 0) { oval(R, lx, ly, lrx, lry, brot); T.belly = R.take(); }
    oval(R, hx + 0.022, hy + 0.01, 0.011, 0.011, 0);
    T.eye = R.take();
    return T;
  }
  // Records an outline as [op, points…]: 0 moveTo x y · 1 lineTo x y · 2 bezierCurveTo x1 y1 x2 y2 x y; ellipses and
  // arcs become Béziers (a quarter turn or less each)
  const REC = (() => {
    const ops = [];
    const bez = (x1, y1, x2, y2, x, y) => { ops.push(2, x1, y1, x2, y2, x, y); };
    // the arc of ellipse (cx, cy, rx, ry, rot) from angle a0 to a1, as Béziers
    function arcs(cx, cy, rx, ry, rot, a0, a1) {
      const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2) - 1e-9)), d = (a1 - a0) / n, k = (4 / 3) * Math.tan(d / 4);
      const cr = Math.cos(rot), sr = Math.sin(rot);
      const P = (u, v) => [cx + u * cr - v * sr, cy + u * sr + v * cr];
      for (let i = 0; i < n; i++) {
        const t0 = a0 + i * d, t1 = t0 + d, c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
        const p1 = P(rx * (c0 - k * s0), ry * (s0 + k * c0)), p2 = P(rx * (c1 + k * s1), ry * (s1 - k * c1)), p3 = P(rx * c1, ry * s1);
        bez(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
      }
    }
    return {
      moveTo(x, y) { ops.push(0, x, y); },
      lineTo(x, y) { ops.push(1, x, y); },
      bezierCurveTo(x1, y1, x2, y2, x, y) { bez(x1, y1, x2, y2, x, y); },
      // (as oval() uses it: a whole ellipse after a moveTo to its start)
      ellipse(cx, cy, rx, ry, rot, a0, a1) { arcs(cx, cy, rx, ry, rot, a0, a1); },
      arc(cx, cy, r, a0, a1, ccw) {
        if (ccw && a1 > a0) a1 -= Math.PI * 2;
        const p = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)];
        ops.push(1, p[0], p[1]);
        arcs(cx, cy, r, r, 0, a0, a1);
      },
      take() { const out = Float32Array.from(ops); ops.length = 0; return out; },
    };
  })();
  // an outline into the current path, through the matrix (a b c d e f) — CSS px
  function emit(ctx, G, a, b, c, d, e, f) {
    for (let k = 0, n = G.length; k < n;) {
      const op = G[k];
      if (op === 2) {
        const x1 = G[k + 1], y1 = G[k + 2], x2 = G[k + 3], y2 = G[k + 4], x = G[k + 5], y = G[k + 6];
        ctx.bezierCurveTo(a * x1 + c * y1 + e, b * x1 + d * y1 + f, a * x2 + c * y2 + e, b * x2 + d * y2 + f, a * x + c * y + e, b * x + d * y + f);
        k += 7;
      } else {
        const x = G[k + 1], y = G[k + 2];
        if (op) ctx.lineTo(a * x + c * y + e, b * x + d * y + f); else ctx.moveTo(a * x + c * y + e, b * x + d * y + f);
        k += 3;
      }
    }
  }
  // the tail along the curve in TAIL (start, two controls, tip), fullest two thirds of the way out, k times as wide
  const TAIL = new Float32Array(8), TAIL_N = 7, TAIL_W = [0.026, 0.047, 0.062, 0.07, 0.068, 0.054, 0.022];
  const EDGE = new Float32Array(TAIL_N * 4);
  function plume(path, k) {
    const A = TAIL;
    for (let i = 0; i < TAIL_N; i++) {
      const u = i / (TAIL_N - 1), v = 1 - u, a = v * v * v, b = 3 * v * v * u, c = 3 * v * u * u, d = u * u * u;
      const x = a * A[0] + b * A[2] + c * A[4] + d * A[6], y = a * A[1] + b * A[3] + c * A[5] + d * A[7];
      let dx = 3 * v * v * (A[2] - A[0]) + 6 * v * u * (A[4] - A[2]) + 3 * u * u * (A[6] - A[4]);
      let dy = 3 * v * v * (A[3] - A[1]) + 6 * v * u * (A[5] - A[3]) + 3 * u * u * (A[7] - A[5]);
      const l = Math.hypot(dx, dy) || 1;
      dx /= l; dy /= l;
      EDGE[4 * i] = x; EDGE[4 * i + 1] = y; EDGE[4 * i + 2] = -dy; EDGE[4 * i + 3] = dx;
    }
    for (let i = 0; i < TAIL_N; i++) { const w = TAIL_W[i] * k, o = 4 * i; if (i) path.lineTo(EDGE[o] + EDGE[o + 2] * w, EDGE[o + 1] + EDGE[o + 3] * w); else path.moveTo(EDGE[o] + EDGE[o + 2] * w, EDGE[o + 1] + EDGE[o + 3] * w); }
    // round the tip
    const o = 4 * (TAIL_N - 1), w = TAIL_W[TAIL_N - 1] * k, ta = Math.atan2(EDGE[o + 3], EDGE[o + 2]);
    path.arc(EDGE[o], EDGE[o + 1], w, ta, ta - Math.PI, true);
    for (let i = TAIL_N - 1; i >= 0; i--) { const w2 = TAIL_W[i] * k, q = 4 * i; path.lineTo(EDGE[q] - EDGE[q + 2] * w2, EDGE[q + 1] - EDGE[q + 3] * w2); }
  }

  // the same plume with each edge two Béziers: the tail's curve split in half, the control points of the halves pushed
  // out along the curve's normals there by the plume's width
  const HALF = new Float32Array(14);
  function plumeLo(path, k) {
    const A = TAIL, H = HALF, E = EDGE;
    // the halves' control points (de Casteljau at ½): they sit at u = 0, ⅙, …, 1, where TAIL_W gives the widths
    H[0] = A[0]; H[1] = A[1];
    H[2] = (A[0] + A[2]) / 2; H[3] = (A[1] + A[3]) / 2;
    H[4] = (A[0] + 2 * A[2] + A[4]) / 4; H[5] = (A[1] + 2 * A[3] + A[5]) / 4;
    H[6] = (A[0] + 3 * A[2] + 3 * A[4] + A[6]) / 8; H[7] = (A[1] + 3 * A[3] + 3 * A[5] + A[7]) / 8;
    H[8] = (A[2] + 2 * A[4] + A[6]) / 4; H[9] = (A[3] + 2 * A[5] + A[7]) / 4;
    H[10] = (A[4] + A[6]) / 2; H[11] = (A[5] + A[7]) / 2;
    H[12] = A[6]; H[13] = A[7];
    for (let i = 0; i < 7; i++) {
      const u = i / 6, v = 1 - u;
      const dx = 3 * v * v * (A[2] - A[0]) + 6 * v * u * (A[4] - A[2]) + 3 * u * u * (A[6] - A[4]);
      const dy = 3 * v * v * (A[3] - A[1]) + 6 * v * u * (A[5] - A[3]) + 3 * u * u * (A[7] - A[5]);
      const l = Math.hypot(dx, dy) || 1, w = TAIL_W[i] * k;
      E[2 * i] = (-dy / l) * w; E[2 * i + 1] = (dx / l) * w;
    }
    const o = (i, sg) => [H[2 * i] + sg * E[2 * i], H[2 * i + 1] + sg * E[2 * i + 1]];
    let p = o(0, 1), q, r;
    path.moveTo(p[0], p[1]);
    q = o(1, 1); r = o(2, 1); p = o(3, 1); path.bezierCurveTo(q[0], q[1], r[0], r[1], p[0], p[1]);
    q = o(4, 1); r = o(5, 1); p = o(6, 1); path.bezierCurveTo(q[0], q[1], r[0], r[1], p[0], p[1]);
    const ta = Math.atan2(E[13], E[12]);
    path.arc(H[12], H[13], TAIL_W[6] * k, ta, ta - Math.PI, true);
    q = o(5, -1); r = o(4, -1); p = o(3, -1); path.bezierCurveTo(q[0], q[1], r[0], r[1], p[0], p[1]);
    q = o(2, -1); r = o(1, -1); p = o(0, -1); path.bezierCurveTo(q[0], q[1], r[0], r[1], p[0], p[1]);
  }

  // one squirrel on its own (fading, on a trunk, or cut round what stands in front)
  function paint(ctx, S, close, dpr) {
    const P = PALS[S.sp];
    if (!close) {
      ctx.globalAlpha = S.a;
      ctx.fillStyle = P.far; ctx.beginPath(); farBody(ctx, S); ctx.fill();
      ctx.fillStyle = P.fringe; ctx.beginPath(); farTail(ctx, S); ctx.fill();
      return;
    }
    const T = templateOf(S), M = frameOf(S), a = M.fx, b = M.fy, c = M.ux, d = M.uy, e = M.bx, f = M.by - (S.onTrunk ? 0 : S.z * PK);
    const one = (G, col) => { ctx.fillStyle = col; ctx.beginPath(); emit(ctx, G, a, b, c, d, e, f); ctx.fill(); };
    ctx.globalAlpha = S.a;
    if (T.shadow) { ctx.fillStyle = SHADOW; ctx.beginPath(); emit(ctx, T.shadow, a, b, c, d, e, M.by); ctx.fill(); }
    if (!M.away) { one(T.fringe, P.fringe); one(T.core, P.tail); }
    one(T.dark, P.dark); one(T.body, P.body);
    if (T.belly) one(T.belly, P.belly);
    if (SCALE >= 11) one(T.eye, EYE);
    if (S.st === DIG) dirt(ctx, S, M);
    if (M.away) { one(T.fringe, P.fringe); one(T.core, P.tail); }
  }
  // the earth (or snow) flying out behind a digger, in its frame M
  function dirt(ctx, S, M) {
    const t = S.clock, a0 = ctx.globalAlpha, r = Math.max(0.5, 0.016 * SCALE * SZ * S.sz);
    ctx.fillStyle = C.ground > 0.3 ? SNOWDIRT : DIRT;
    for (let i = 0; i < 3; i++) {
      const u = (t * 2.3 + i / 3) % 1, x = -0.07 - 0.28 * u, y = 0.02 + 0.22 * Math.sin(Math.PI * u);
      const X = M.fx * x + M.ux * y + M.bx, Y = M.fy * x + M.uy * y + M.by;
      ctx.globalAlpha = a0 * (1 - u);
      ctx.beginPath(); ctx.moveTo(X + r, Y); ctx.arc(X, Y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = a0;
  }
  // from afar: a body and a dab of tail
  function farBody(ctx, S) {
    const s = SCALE, k = PK, sc = SZ * S.sz, x = S.sx, y = S.sy - S.z * k, rx = Math.max(0.9, 0.11 * s * sc), cy = y - 0.07 * k * sc;
    ctx.moveTo(x + rx, cy); ctx.ellipse(x, cy, rx, Math.max(0.7, 0.055 * k * sc), 0, 0, Math.PI * 2);
  }
  function farTail(ctx, S) {
    const s = SCALE, k = PK, sc = SZ * S.sz, x = S.sx, y = S.sy - S.z * k;
    const run = S.mv > 0.9 && !S.onTrunk, dir = Math.cos(S.h) * R0 + Math.sin(S.h) * R1 >= 0 ? 1 : -1;
    const cx = x - dir * (run ? 0.2 : 0.13) * s * sc, cy = y - (run ? 0.12 : 0.17) * k * sc;
    const rx = run ? Math.max(0.8, 0.08 * s * sc) : Math.max(0.6, 0.045 * s * sc), ry = run ? Math.max(0.6, 0.04 * k * sc) : Math.max(0.8, 0.1 * k * sc);
    ctx.moveTo(cx + rx, cy); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  }
  // the batch: each squirrel's template and matrix, then one path per paint (and kind of squirrel), filled once each
  let NB = 0, BT = [], BM = new Float64Array(64 * 8);
  function batch(S) {
    const M = frameOf(S);
    if (8 * (NB + 1) > BM.length) { const o = new Float64Array(BM.length * 2); o.set(BM); BM = o; }
    const o = 8 * NB;
    BT[NB] = templateOf(S);
    BM[o] = M.fx; BM[o + 1] = M.fy; BM[o + 2] = M.ux; BM[o + 3] = M.uy; BM[o + 4] = M.bx; BM[o + 5] = M.by;
    BM[o + 6] = M.by - S.z * PK; BM[o + 7] = S.sp + (M.away ? 2 : 0);
    NB++;
  }
  // which paint: 0 shadow, 1 tail fringe, 2 tail core, 3 haunch, 4 body, 5 belly, 6 eye; tail: 0 any, 1 behind, 2 in front
  function pass(ctx, what, sp, tail, col) {
    let any = false;
    for (let i = 0; i < NB; i++) {
      const o = 8 * i, kind = BM[o + 7];
      if (sp >= 0 && (kind & 1) !== sp) continue;
      if (tail && (kind >= 2) !== (tail === 2)) continue;
      const T = BT[i], G = what === 0 ? T.shadow : what === 1 ? T.fringe : what === 2 ? T.core : what === 3 ? T.dark : what === 4 ? T.body : what === 5 ? T.belly : T.eye;
      if (!G) continue;
      if (!any) { ctx.beginPath(); any = true; }
      emit(ctx, G, BM[o], BM[o + 1], BM[o + 2], BM[o + 3], BM[o + 4], what === 0 ? BM[o + 5] : BM[o + 6]);
    }
    if (any) { ctx.fillStyle = col; ctx.fill(); }
  }
  function flush(ctx, eye) {
    if (!NB) return;
    pass(ctx, 0, -1, 0, SHADOW);
    for (let sp = 0; sp < 2; sp++) { pass(ctx, 1, sp, 1, PALS[sp].fringe); pass(ctx, 2, sp, 1, PALS[sp].tail); }
    for (let sp = 0; sp < 2; sp++) { pass(ctx, 3, sp, 0, PALS[sp].dark); pass(ctx, 4, sp, 0, PALS[sp].body); pass(ctx, 5, sp, 0, PALS[sp].belly); }
    if (eye) pass(ctx, 6, -1, 0, EYE);
    for (let sp = 0; sp < 2; sp++) { pass(ctx, 1, sp, 2, PALS[sp].fringe); pass(ctx, 2, sp, 2, PALS[sp].tail); }
    NB = 0; BT.length = 0;
  }

  // ================================================================================================ the card
  let sel = null, cardH = null, cardEl = null, cardKey = "", cardAt = 0;
  const UI = () => app.ui;
  injectStyle();
  function openCard(S) {
    const ui = UI();
    if (!ui || !ui.card) return;
    sel = S;
    cardEl = document.createElement("div");
    cardEl.className = "sq-card";
    cardEl.innerHTML = `<p class="sq-status"></p><dl class="sq-grid"></dl><p class="sq-fact"></p><p class="sq-src"></p>`;
    cardKey = "";
    cardH = ui.card({
      id: "squirrel", title: S.name, subtitle: PALS[S.sp].name + (S.den.place ? " · " + S.den.place : ""), color: PALS[S.sp].body,
      body: cardEl,
      anchor: () => (sel && !sel.gone && sel.a > 0.05 ? { x: sel.x, y: sel.y, z: sel.z + 0.15, mark: false } : null),
      onClose: () => { if (sel === S) { sel = null; cardH = null; cardEl = null; } app.requestRender("squirrels"); },
    });
    fillCard(true);
  }
  function fillCard(force) {
    if (!cardH || !cardEl || !sel) return;
    const S = sel, el = cardEl;
    const status = S.gone ? (C.act < 0.05 ? "Gone home to its drey for the night." : "Gone home to its drey.") : statusOf(S);
    const rows = [["Mood", moodOf(S)]];
    const n = acorns(S);
    if (n > 0) rows.push(["Acorns buried", `${n.toLocaleString("en-US")} ${app.now().getMonth() >= 8 && app.now().getMonth() <= 10 ? "so far this autumn" : "last autumn"}`]);
    rows.push(["Home", S.den.bare ? "A bare tree, with a drey in it" : S.den.con ? "An evergreen, with a drey in it" : "A drey up in a leafy tree"]);
    const key = status + "|" + rows.map((r) => r[1]).join("|");
    if (!force && key === cardKey) return;
    cardKey = key;
    el.querySelector(".sq-status").textContent = status;
    el.querySelector(".sq-grid").replaceChildren(...rows.flatMap(([k, v]) => { const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = k; dd.textContent = v; return [dt, dd]; }));
    if (force) {
      const facts = FACTS.concat(S.sp ? FOX_FACT : GREY_FACT);
      el.querySelector(".sq-fact").textContent = facts[hashInt(S.seed, Math.floor(Date.now() / 600000)) % facts.length];
      el.querySelector(".sq-src").textContent = MANY ? "A simulated squirrel (?squirrels=many)." : "A simulated squirrel, though the campus has plenty of real ones.";
    }
  }
  // how many acorns it has put away this autumn (made up, but steady: it grows through the season)
  function acorns(S) {
    const now = app.now(), y = now.getFullYear(), m = now.getMonth();
    if (m >= 3 && m <= 7) return 0;
    const start = new Date(m <= 2 ? y - 1 : y, 8, 1).getTime(), end = new Date(m <= 2 ? y - 1 : y, 11, 1).getTime();
    const days = Math.max(0, Math.min(end, now.getTime()) - start) / 86400000;
    return Math.floor(days * (3 + 5 * hash01(S.seed, 12))) + S.buried + (S.st === DIG || S.st === BURY ? 1 : 0);
  }
  const pickOf = (list, S) => list[S.say % list.length];
  function statusOf(S) {
    const n = acorns(S), wet = C.rain > 0.2, deep = C.ground > 0.5;
    if (S.chase) {
      const other = S.chase.lead === S ? S.chase.fol : S.chase.lead;
      return S.chase.lead === S
        ? pickOf([`Being chased round a tree by ${other.name}. Again.`, `Fleeing ${other.name}, at speed, in circles`, `Leading ${other.name} on a merry dance`], S)
        : pickOf([`Chasing ${other.name} round a tree. It's personal.`, `In hot pursuit of ${other.name}`, `Explaining to ${other.name} whose tree this is`], S);
    }
    if (S.leaving && !S.onTrunk && S.st !== FREEZE) return C.act < 0.05 && C.day < 0.5 ? "Off to bed in its drey" : wet ? "Heading home out of the rain" : "Heading home to its drey";
    switch (S.st) {
      case FREEZE: return pickOf(["Frozen. Hoping you can't see it.", "Staring at you, tail flicking", "Has noticed you. Is deciding what to do about it."], S);
      case DIG:
      case BURY:
        if (C.season === "winter" || deep) return pickOf(["Digging up something it buried in October. Possibly someone else's.", "Excavating a cache from the autumn", "Digging through the snow for a cache"], S);
        if (autumn() && n > 0) return S.st === BURY ? pickOf([`Patting down acorn #${n}`, `Tucking in acorn #${n} for the winter`], S)
          : pickOf([`Burying acorn #${n} of the season`, `Hiding acorn #${n}. Will definitely remember where.`, `Filing acorn #${n} under "lawn, somewhere"`], S);
        return pickOf(["Digging, for reasons it won't share", "Planting an oak tree by accident, possibly", "Looking for a nut it buried last autumn"], S);
      case HOP:
        if (deep) return "Bounding through snow up to its elbows";
        return pickOf(["In a tremendous hurry, for reasons of its own", "Late for an 8 a.m.", "Doing zoomies", "Off to check on a cache", "Bounding. Mostly for fun."], S);
      case ALERT: return pickOf(["Frozen mid-step. Something moved.", "Listening very hard", "Pausing dramatically"], S);
      case SIT:
        if (wet) return "Sitting it out under its own tail";
        return pickOf(["On lookout duty", "Thinking about acorns", "Keeping an eye on you", "Eyeing a passer-by's sandwich", "Enjoying the view", "Having a snack, paws and all"], S);
      case TOTREE: case UP: return pickOf(["Popping up to check on the drey", "Heading up the trunk", "Off up the tree. Back soon."], S);
      case PERCH: return S.z > (S.tree || S.den).top ? "Up in the tree, minding its own business" : pickOf(["Clinging to the trunk, considering things", "Halfway up a tree, perfectly comfortable"], S);
      case DOWN: return "Coming down head first";
      default:
        if (deep || C.season === "winter") return pickOf(["Sniffing through the snow for a cache", "Looking for last autumn's savings", "Nibbling something. Probably a nut."], S);
        if (autumn()) return pickOf(["Comparing two acorns. Both excellent.", "Shopping for acorns", "Inspecting a promising patch of lawn", "Sniffing out something buried", "Nibbling something. Probably a nut."], S);
        return pickOf(["Inspecting a promising patch of lawn", "Sniffing out something buried", "Checking the lawn for dropped snacks", "Very busy with a single blade of grass", "Nibbling something. Probably a nut."], S);
    }
  }
  function moodOf(S) {
    if (S.gone) return "Sleepy";
    if (S.chase) return S.chase.lead === S ? "Indignant" : "Competitive";
    switch (S.st) {
      case FREEZE: return "Suspicious of you";
      case HOP: return "Zoomy";
      case DIG: case BURY: return autumn() ? "Secretive" : "Peckish";
      case SIT: return pickOf(["Content", "Smug", "Watchful"], S);
      case ALERT: return "Twitchy";
      case PERCH: case UP: case DOWN: case TOTREE: return "Unbothered";
      default: return pickOf(["Busy", "Peckish", "Distracted", "Plotting"], S);
    }
  }
  function injectStyle() {
    if (document.getElementById("sq-style")) return;
    const st = document.createElement("style");
    st.id = "sq-style";
    st.textContent = `
      .sq-card { font: 13px/1.45 "Inter", system-ui, sans-serif; }
      .sq-status { margin: 2px 0 9px; font: italic 500 17px/1.3 "Fraunces", Georgia, serif; color: var(--ink, #2a2622); }
      .sq-grid { display: grid; grid-template-columns: auto 1fr; gap: 3px 14px; margin: 0; }
      .sq-grid dt { color: var(--mute, #7a7064); }
      .sq-grid dd { margin: 0; min-width: 0; }
      .sq-fact { margin: 9px 0 0; padding: 7px 10px; border-radius: 8px; background: var(--well, #f1ebdd); font-size: 12.5px; }
      .sq-src { margin: 8px 0 0; font-size: 11px; color: var(--mute, #7a7064); }
    `;
    document.head.append(st);
  }

  // ---------------------------------------------------------------- sounds
  let cueAt = 0;
  function cue(name, x, y, gap) {
    const now = performance.now();
    if (gap && now - cueAt < gap * 1000) return;
    cueAt = now;
    try { if (app.sound && app.sound.cue) app.sound.cue(name, { x, y }); } catch {}
  }

  // ================================================================================================ wiring
  function tick(idle) {
    if (failed) return;
    try {
      manage(false, idle ? 15 : 5);
      stepAll();
      if (cardH && performance.now() - cardAt > 400) { cardAt = performance.now(); fillCard(false); }
    } catch (e) {
      // a broken squirrel should not spam the console every frame: report once, then rest
      failed = true; dropAll(); whimsy.squirrels = 0;
      console.error("squirrels: stopped", e);
    }
  }
  let frameAt = 0;
  app.on("frame", () => { frameAt = performance.now(); tick(); });
  // between frames (the map asleep: nothing moving on screen) the squirrels carry on, and wake the map when one on
  // screen starts to move
  setInterval(() => {
    if (failed || document.hidden || performance.now() - frameAt < 300) return;
    if (!live.length && (!wildlifeOn() || view.s < SIM_S)) { lastStep = performance.now(); return; }
    tick(true);
    if (want === 0 && wakes()) app.requestRender("squirrels");
  }, 250);
  // is a squirrel on screen moving (or coming or going)?
  function wakes() {
    if (view.s < MIN_S || !wildlifeOn()) return false;
    setCamera();
    for (const S of live) {
      if (!(S.mv > 0.9 || S.fade || S.st === CHASE || (SCALE >= DETAIL_S && (S.st === DIG || S.flick > 0)))) continue;
      if (onView(S.x, S.y, 1, 10)) return true;
    }
    return false;
  }
  app.on("layers", (p) => { if (p && p.id === "wildlife") { if (!p.on) { dropAll(); whimsy.squirrels = 0; if (cardH) cardH.close(); } tickAt = -1e9; app.requestRender("squirrels"); } });
  app.on("rotate", () => { HID.clear(); for (const S of live) { S.occR = -1; S.hidK = -1; } });
  app.on("weather", () => { condAt = -1e9; });
  app.on("style", () => { condAt = -1e9; HID.clear(); for (const S of live) S.hidK = -1; });

  app.addLayer({
    id: "squirrels", z: 33,
    fps: () => want,
    draw: (ctx) => draw(ctx),
    hit(px, py) {
      if (failed || !vis.length || SCALE < MIN_S || !wildlifeOn()) return null;
      const pad = app.mobile ? 16 : 10;
      let best = null, bd = Infinity;
      for (const S of vis) {
        if (!S.vis || S.a < 0.3) continue;
        const r = Math.max(pad, 0.35 * SCALE * SZ), dx = px - S.sx, dy = py - (S.sy - (S.z + 0.12 * SZ) * PK), d = dx * dx + dy * dy;
        if (d <= r * r && d < bd) { bd = d; best = S; }
      }
      return best;
    },
    onClick(S) {
      if (!S || S.gone) return;
      openCard(S);
      cue("squirrel", S.x, S.y, 0);
      // it notices you: sits up, flicks its tail at you, and then dashes off
      if (!S.chase && !S.onTrunk && !S.leaving && S.st !== FREEZE && !reduceMQ.matches) {
        setState(S, FREEZE, 1.8 + S.R() * 1.6); S.flick = 1; S.look = 0; S.sub = 1; S.h = camAngle() + (S.R() - 0.5) * 0.8;
      }
      app.requestRender("squirrels");
    },
  });

  app.squirrels = {
    get count() { return live.length; },
    debug: {
      conditions: C,
      get live() { return live.length; },
      get cellsLeft() { return cellsLeft; },
      get gridMs() { return buildMs; },
      // what's out near the view: name, kind, what it's doing, where (for tests: fly there and look)
      list() {
        return live.map((S) => {
          const [lat, lon] = geo.toLatLon(S.x, S.y);
          return { name: S.name, kind: PALS[S.sp].name, st: ["forage", "hop", "alert", "sit", "dig", "bury", "totree", "up", "perch", "down", "chase", "freeze"][S.st], z: +S.z.toFixed(2), vis: S.vis, sx: Math.round(S.sx), sy: Math.round(S.sy), lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
        });
      },
      // run them on for sec seconds without drawing; any off its lawn, or not a number, is reported
      advance(sec, dt = 0.05) {
        const bad = [];
        for (let t = 0; t < sec; t += dt) {
          lastStep = performance.now() - dt * 1000;
          stepAll();
          for (const S of live) if (!Number.isFinite(S.x + S.y + S.z) || Math.hypot(S.x - S.den.x, S.y - S.den.y) > S.den.R + 12) bad.push({ name: S.name, st: S.st, x: S.x, y: S.y });
          if (bad.length > 20) break;
        }
        return { live: live.length, bad };
      },
      // set every squirrel near the view to a state (for screenshots): "chase", "dig", "sit", "up", "hop"
      force(what) {
        let n = 0;
        for (const S of live) {
          if (S.chase || S.onTrunk) continue;
          if (what === "chase") { if (startChase(S)) n++; }
          else if (what === "dig") { setState(S, DIG, 30); S.digX = S.x; S.digY = S.y; S.digT = performance.now() / 1000; n++; }
          else if (what === "sit") { setState(S, SIT, 30); n++; }
          else if (what === "up") { toTree(S); n++; }
          else if (what === "hop") { hopTo(S, 2, 5, 3); n++; }
        }
        app.requestRender("squirrels");
        return n;
      },
      // open the card of the squirrel nearest the middle of the screen
      click() {
        let best = null, bd = Infinity;
        for (const S of vis) { const d = (S.sx - VW / 2) ** 2 + (S.sy - VH / 2) ** 2; if (d < bd) { bd = d; best = S; } }
        if (best) app.layers.find((l) => l.id === "squirrels").onClick(best);
        return best ? { name: best.name, sx: Math.round(best.sx), sy: Math.round(best.sy) } : null;
      },
    },
  };
  Object.defineProperty(app.squirrels, "debug", { enumerable: false });
}

// ------------------------------------------------------------------------------------------------ helpers
// an ellipse as its own piece of the current path
function oval(ctx, x, y, rx, ry, rot) {
  ctx.moveTo(x + rx * Math.cos(rot), y + rx * Math.sin(rot));
  ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
}
const PAW = new Float32Array(4);
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function smooth(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
function segDist(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / L, 0, 1) : 0;
  return Math.hypot(x - ax - dx * t, y - ay - dy * t);
}
function hashInt(a, b) {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}
const hash01 = (a, b) => hashInt(a, b) / 4294967296;
// a small seeded generator (mulberry32): a squirrel's doings repeat for the same tree and minute
function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
