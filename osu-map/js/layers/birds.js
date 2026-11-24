// Birds: mallards and Canada geese on the water and its banks, and birds in the evening sky.
//
// None of this is live data. Each body of water big enough for ducks (Mirror Lake, the Olentangy and the ponds beside
// it) is rasterised the first time it comes near the view into a 2 m grid of signed distances to the shore (bridge decks
// count as shore, so nothing swims under one), and seeded with groups: a mallard pair, a little flock of mallards, a hen
// with a line of ducklings (late spring), a gaggle of geese, a goose family with goslings. Where a group is, what it is
// and what it does come from hashes of the group and the clock (its kind for the day, its plan for each 18 minutes:
// paddling about, resting on the bank, the geese grazing a lawn beside the water; asleep at night, on the bank or rafted
// on the water), so the same water holds the same birds for everyone, and again when it comes back into view. Only the
// groups near the view are simulated: paddling with soft V-wakes, dabbling tail-up, preening, drifting with the wind,
// waddling up the bank, the young following their parent in a line, the odd take-off and landing with a splash. Deep
// cold freezes the ponds (no birds) and thins them on the river.
//
// In the sky ("birds-sky", above the night tint, soft dark silhouettes): a starling murmuration over the river at dusk
// on autumn and winter evenings (a few hundred dots on a folding, twisting sheet — no neighbour search), small birds
// flying into the trees to roost at dusk (and out again at dawn), and Canada geese passing over in a V, most often in
// the spring and autumn migrations. Every bird is clickable.
//
// Drawing ("waterfowl", z 31, under the night tint): each bird is a few soft ellipsoids (the outline of a projected
// ellipsoid is an ellipse, so a body, a breast, a head and a bill are one fill each), back to front; close up, cut round
// the outlines of whatever stands in front (as life.js does for walkers); from afar, either shown or hidden.
//
// Test switches: ?birds=many (lots of waterfowl, any season, never frozen) · ?birds=dusk (a murmuration over the river
// nearest the starting view, whatever the hour) · ?birds=geese (a V of geese across the view every 40 s) — combine with commas.
import { pointIn } from "../core/scene.js";
import { makeRecorder } from "./life.js";

// ------------------------------------------------------------------------------------------------ tables
const SIM_S = 1.6;       // waterfowl are simulated from this scale (CSS px per metre) up…
const MIN_S = 2.2;       // …drawn from here (a body and a head, a little larger than life)…
const FULL_S = 6;        // …modelled (body, back, breast, head, bill, wakes) from here…
const CUT_S = 7;         // …cut round what stands in front from here (from afar: shown or hidden)…
const DETAIL_S = 12;     // …with neck rings, chinstraps, legs and feet from here
const SKY_MIN_S = 0.22;  // a murmuration shows from here…
const VEE_MIN_S = 0.45;  // …geese in a V from here…
const SMALL_MIN_S = 3.5; // …small birds going to roost from here
const SIZE = 1.5;        // the birds a little larger than life, to read at map scale
const KMIN = 4.6;        // and never smaller than this (px per model metre)
const CS = 2;            // water grid cell (m); the signed distances are in metres
const MARGIN = 50;       // land kept round each body of water in its grid (m)
const SLOT = 18;         // minutes: a group's plan holds this long
const FADE = 1;          // s: a group arriving or leaving in plain view fades
const TAU = Math.PI * 2;
const OVAL = [39.9995, -83.0148];
// a typical afternoon by season (°F), when the live reading doesn't apply (another date with ?time=, test weather)
const CLIMATE = { winter: 31, spring: 58, summer: 80, autumn: 62, "late-autumn": 45 };
// group density, groups per m² of open water
const DENSITY = { lake: 1 / 650, river: 1 / 5200, pond: 1 / 2600 };

// species
const DRAKE = 0, HEN = 1, DUCKLING = 2, GOOSE = 3, GOSLING = 4;
// what a bird is doing
const SWIM = 0, IDLE = 1, DABBLE = 2, PREEN = 3, WALK = 4, GRAZE = 5, REST = 6, SLEEP = 7, FLY = 8;
// what a group is doing
const P_WATER = 0, P_BANK = 1, P_GRAZE = 2, P_RAFT = 3, P_BANKSLEEP = 4;
// kinds of group
const G_PAIR = 0, G_MALLARDS = 1, G_BROOD = 2, G_GEESE = 3, G_GPAIR = 4, G_GFAM = 5;

// colours: sides, back, breast, rear, tail, head, head highlight, bill, legs
const LOOK = [];
LOOK[DRAKE] = { side: "#cdc7bb", back: "#8a8174", breast: "#6c4331", rear: "#2e2c2a", tail: "#ece8df", head: "#2f5c41", hi: "#4f8a63", bill: "#d9b94b", legs: "#d88a3c", far: "#b3aa9a" };
LOOK[HEN] = { side: "#a8865f", back: "#7a5f45", breast: "#a07c56", rear: "#6d543c", tail: "#b89a74", head: "#8e6f4e", hi: "#5f4732", bill: "#cf8a3a", legs: "#d88a3c", far: "#9a7a55" };
LOOK[DUCKLING] = { side: "#8f7046", back: "#6c5435", breast: "#dcc26a", rear: "#6c5435", tail: "#6c5435", head: "#dcc069", hi: "#6c5435", bill: "#4f4230", legs: "#8a7a50", far: "#a88a50" };
LOOK[GOOSE] = { side: "#9b8a75", back: "#6c5c4b", breast: "#d6cab5", rear: "#f2eee6", tail: "#2b2927", head: "#272523", hi: "#f3efe6", bill: "#2b2927", legs: "#2f2d2b", far: "#8a7a66" };
LOOK[GOSLING] = { side: "#c7b679", back: "#a29560", breast: "#d8c98a", rear: "#a29560", tail: "#a29560", head: "#b7a865", hi: "#8f8350", bill: "#4a4636", legs: "#6a6448", far: "#bfae72" };
// a drake in late summer moults into "eclipse" plumage: a hen's colours with a drake's yellowish bill
const ECLIPSE = { ...LOOK[HEN], bill: "#c2b04f", head: "#7d6646" };
const SHADOW = "rgba(38,50,60,.16)";
const WAKE = "rgba(250,252,255,";
const WATERLINE = WAKE + "0.28)";
const SKY_INK = "rgba(36,33,31,";

const ACT_NAMES = ["paddling about", "floating", "dabbling, tail up", "preening", "waddling", "grazing on the lawn", "resting on the bank", "asleep, head tucked under a wing", "flying"];
const SPECIES = ["Mallard", "Mallard", "Mallard duckling", "Canada goose", "Canada gosling"];

// ------------------------------------------------------------------------------------------------ the module
export function init(app) {
  const { data, geo, view, renderer } = app;
  if (!data || !data.areas || !data.world) return;
  const { SIN_T, COS_T } = geo;
  const world = data.world;
  const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");
  const OPT = (app.params.get("birds") || "").trim().toLowerCase().split(/[,\s]+/);
  const MANY = OPT.includes("many"), DUSK = OPT.includes("dusk"), VFORCE = OPT.includes("geese");
  const [ovalX, ovalY] = geo.toXY(OVAL[0], OVAL[1]);

  if (app.ui && app.ui.registerToggle) app.ui.registerToggle({ id: "wildlife", label: "Wildlife", count: "simulated" });
  app.whimsy = app.whimsy || {};
  app.whimsy.waterfowl = 0; app.whimsy.flock = 0;
  const wild = () => app.layerEnabled("wildlife");
  const cue = (name, x, y) => { try { if (app.sound && app.sound.cue) app.sound.cue(name, { x, y }); } catch (e) { /* no sound is fine */ } };
  injectStyle();

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
  function onView(x, y, rad, margin, up = 0) {
    const px = PA * x + PB * y + PE, py = PC * x + PD * y + PF, m = margin + rad * SCALE;
    return px > -m && px < VW + m && py > -m - up * PK && py < VH + m;
  }
  // the ground rectangle (bounding box) the view covers, for ground z = 0
  const VIEWBOX = [0, 0, 0, 0];
  function viewGround(margin) {
    const det = PA * PD - PB * PC;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let c = 0; c < 4; c++) {
      const px = (c & 1 ? VW + margin : -margin) - PE, py = (c & 2 ? VH + margin : -margin) - PF;
      const x = (PD * px - PB * py) / det, y = (-PC * px + PA * py) / det;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    VIEWBOX[0] = x0; VIEWBOX[1] = y0; VIEWBOX[2] = x1; VIEWBOX[3] = y1;
    return VIEWBOX;
  }

  // ---------------------------------------------------------------- the clock
  // The schedules follow the campus clock; with it stopped (?speed=0) they run on in real time from where it stopped.
  let simMs = app.now().getTime(), lastAppMs = simMs;
  function tickClock(dt) {
    const an = app.now().getTime();
    if (an !== lastAppMs) { simMs = an; lastAppMs = an; } else simMs += dt * 1000;
  }

  // ---------------------------------------------------------------- conditions
  const C = { night: 0, isNight: false, temp: 50, frozen: false, riverCold: false, windX: 0, windY: 0, doy: 300, day: 0, rain: 0, storm: false, snow: 0, fog: 0 };
  let condAt = -1e9;
  function readConditions() {
    const now = app.now(), W = app.weather || {}, style = app.tileStyle || {};
    const reading = W.source !== "none" && Number.isFinite(W.tempF) && Math.abs(now.getTime() - Date.now()) < 3 * 3600e3;
    C.temp = reading ? W.tempF : CLIMATE[style.season] ?? 55;
    const ground = Math.max(style.snow || 0, (W.snowDepthM || 0) / 0.05);
    // well below freezing (or snow lying in hard cold) and the ponds are iced over; the river keeps open water longer
    C.frozen = !MANY && (C.temp < 20 || (ground > 0.3 && C.temp < 27));
    C.riverCold = !MANY && C.temp < 12;
    C.night = Number.isFinite(W.night) ? W.night : 0;
    C.isNight = C.isNight ? C.night > 0.5 : C.night > 0.72;
    // the water drifts downwind (windDir is where the wind comes from)
    const ws = (W.windMph || 0) * 0.447, dir = (((W.windDir || 0) + 180) * Math.PI) / 180, d = Math.min(0.1, ws * 0.011);
    C.windX = Math.sin(dir) * d; C.windY = Math.cos(dir) * d;
    const local = new Date(now.getTime() - 5 * 3600e3);
    C.doy = Math.floor((Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - Date.UTC(local.getUTCFullYear(), 0, 1)) / 864e5) + 1;
    C.day = Math.floor((now.getTime() - 9 * 3600e3) / 864e5);   // a "bird day" runs from 4 am
    C.rain = W.rain || 0; C.storm = !!W.storm; C.snow = W.snow || 0; C.fog = W.fog || 0;
  }
  const ducklingSeason = () => C.doy >= 112 && C.doy <= 178;
  const goslingSeason = () => C.doy >= 115 && C.doy <= 170;
  const eclipse = () => C.doy >= 176 && C.doy <= 262;

  // ================================================================================================ water
  const bodies = [];
  const RIVER_LINES = (data.waterways || []).filter((w) => /olentangy/i.test(w.n || "") && w.pts && w.pts.length >= 4);
  const ringBox = (f) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < f.length; k += 2) { if (f[k] < x0) x0 = f[k]; if (f[k] > x1) x1 = f[k]; if (f[k + 1] < y0) y0 = f[k + 1]; if (f[k + 1] > y1) y1 = f[k + 1]; }
    return [x0, y0, x1, y1];
  };
  const inRings = (rings, x, y) => { let n = false; for (const f of rings) if (pointIn(f, x, y)) n = !n; return n; };
  const distToRiver = (x, y) => {
    let best = Infinity;
    for (const w of RIVER_LINES) for (let k = 0; k + 3 < w.pts.length; k += 2) best = Math.min(best, segDist(x, y, w.pts[k], w.pts[k + 1], w.pts[k + 2], w.pts[k + 3]));
    return best;
  };
  data.areas.forEach((a, i) => {
    if (a.k !== "water" || a.sp || (a.A || 0) < 900 || !a.p || !a.p[0]) return;
    const bb = ringBox(a.p[0]);
    const x0 = Math.max(bb[0], world.x0 + 6), y0 = Math.max(bb[1], world.y0 + 6), x1 = Math.min(bb[2], world.x1 - 6), y1 = Math.min(bb[3], world.y1 - 6);
    if (x1 - x0 < 6 || y1 - y0 < 6) return;
    let river = false;
    for (const w of RIVER_LINES) { for (let k = 0; k < w.pts.length && !river; k += 6) river = inRings(a.p, w.pts[k], w.pts[k + 1]); if (river) break; }
    const lake = /mirror lake/i.test(a.n || "");
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const name = a.n || (river ? "Olentangy River" : distToRiver(cx, cy) < 250 ? "a pond by the Olentangy" : "a pond");
    bodies.push({ i, a, kind: lake ? "lake" : river ? "river" : "pond", name, bb: [x0, y0, x1, y1], cx, cy, rad: Math.hypot(x1 - x0, y1 - y0) / 2, built: false, groups: [], x0: 0, y0: 0, nx: 0, ny: 0, D: null });
  });

  // The grid: water cells hold their distance to the shore (m, > 0), land cells minus their distance to the water.
  function build(B) {
    B.built = true;
    const [bx0, by0, bx1, by1] = B.bb;
    const x0 = Math.max(world.x0 + 1, bx0 - MARGIN), y0 = Math.max(world.y0 + 1, by0 - MARGIN);
    const x1 = Math.min(world.x1 - 1, bx1 + MARGIN), y1 = Math.min(world.y1 - 1, by1 + MARGIN);
    const nx = Math.max(1, Math.ceil((x1 - x0) / CS)), ny = Math.max(1, Math.ceil((y1 - y0) / CS)), n = nx * ny;
    B.x0 = x0; B.y0 = y0; B.nx = nx; B.ny = ny;
    const Wm = new Uint8Array(n);
    fillRings(Wm, B, B.a.p, 1);
    // the slab's edge is the end of the water
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * CS, y = y0 + (j + 0.5) * CS;
      if (x < world.x0 + 8 || x > world.x1 - 8 || y < world.y0 + 8 || y > world.y1 - 8) Wm[j * nx + i] = 0;
    }
    // bridges: their decks (and abutments) are not water
    for (const a of data.areas) {
      if (a.k !== "bridge" || !a.p || !a.p[0]) continue;
      const bb = ringBox(a.p[0]);
      if (bb[2] < x0 || bb[0] > x1 || bb[3] < y0 || bb[1] > y1) continue;
      fillRings(Wm, B, a.p, 0, 2);
    }
    const strip = (pts, hw) => {
      for (let k = 0; k + 3 < pts.length; k += 2) {
        const ax = pts[k], ay = pts[k + 1], bx = pts[k + 2], by = pts[k + 3];
        if (Math.max(ax, bx) + hw < x0 || Math.min(ax, bx) - hw > x1 || Math.max(ay, by) + hw < y0 || Math.min(ay, by) - hw > y1) continue;
        const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - hw - x0) / CS)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx) + hw - x0) / CS));
        const j0 = Math.max(0, Math.floor((Math.min(ay, by) - hw - y0) / CS)), j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by) + hw - y0) / CS));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          if (segDist(x0 + (i + 0.5) * CS, y0 + (j + 0.5) * CS, ax, ay, bx, by) <= hw) Wm[j * nx + i] = 0;
        }
      }
    };
    for (const r of data.roads || []) if (r.br && r.pts) strip(r.pts, (r.w || 6) / 2 + 2.5);
    for (const p of data.paths || []) if (p.br && p.pts) strip(p.pts, (p.w || 2) / 2 + 2);
    // signed chamfer distances (2 per cell along, 3 across: with 2 m cells, about metres)
    const A = new Uint16Array(n), BIG = 60000;
    for (let k = 0; k < n; k++) A[k] = Wm[k] ? BIG : 0;
    chamfer(A, nx, ny, 0);
    const D = new Int16Array(n);
    for (let k = 0; k < n; k++) D[k] = Wm[k] ? Math.min(A[k], 30000) : 0;
    for (let k = 0; k < n; k++) A[k] = Wm[k] ? 0 : BIG;
    chamfer(A, nx, ny, BIG);
    for (let k = 0; k < n; k++) if (!Wm[k]) D[k] = -Math.min(A[k], 30000);
    B.D = D;
    seedGroups(B);
  }
  // scanline fill of rings (even-odd) into M with value val; grow: extra cells round each span
  function fillRings(M, B, rings, val, grow = 0) {
    const xs = [];
    for (let j = 0; j < B.ny; j++) {
      const y = B.y0 + (j + 0.5) * CS;
      xs.length = 0;
      for (const f of rings) for (let k = 0, m = f.length, q = m - 2; k < m; q = k, k += 2) {
        const ya = f[q + 1], yb = f[k + 1];
        if ((ya > y) !== (yb > y)) xs.push(f[q] + ((y - ya) * (f[k] - f[q])) / (yb - ya));
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - B.x0) / CS - 0.5) - grow), i1 = Math.min(B.nx - 1, Math.floor((xs[k + 1] - B.x0) / CS - 0.5) + grow);
        for (let i = i0; i <= i1; i++) M[j * B.nx + i] = val;
        if (grow) for (let g = 1; g <= grow; g++) {
          for (const jj of [j - g, j + g]) if (jj >= 0 && jj < B.ny) for (let i = i0; i <= i1; i++) M[jj * B.nx + i] = val;
        }
      }
    }
  }
  // signed distance at a ground point (m): > 0 in the water, < 0 on land, -999 off the grid
  function dAt(B, x, y) {
    const i = Math.floor((x - B.x0) / CS), j = Math.floor((y - B.y0) / CS);
    if (i < 0 || j < 0 || i >= B.nx || j >= B.ny) return -999;
    return B.D[j * B.nx + i];
  }
  // is the straight line from a to b water at least `clear` m from the shore all the way?
  function lineWater(B, ax, ay, bx, by, clear) {
    const L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(L / 1.5));
    for (let k = 1; k <= n; k++) if (dAt(B, ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n) < clear) return false;
    return true;
  }

  // ---------------------------------------------------------------- groups: where they live
  function seedGroups(B) {
    const BLK = 24, dens = DENSITY[B.kind] * (MANY ? 3.5 : 1), { nx, ny, D } = B;
    let blk = 0;
    for (let bj = 0; bj < ny; bj += BLK) for (let bi = 0; bi < nx; bi += BLK, blk++) {
      let open = 0;
      for (let j = bj; j < Math.min(ny, bj + BLK); j++) for (let i = bi; i < Math.min(nx, bi + BLK); i++) if (D[j * nx + i] >= 2) open++;
      if (!open) continue;
      const seed0 = hashInt(B.i * 7919 + blk, 0xb1d5);
      const lam = open * CS * CS * dens, n = Math.floor(lam) + (hash01(seed0, 1) < lam - Math.floor(lam) ? 1 : 0);
      for (let g = 0; g < n; g++) {
        const seed = hashInt(seed0, 10 + g);
        let ax = 0, ay = 0, best = -1;
        for (let t = 0; t < 24; t++) {
          const i = bi + Math.floor(hash01(seed, 100 + 2 * t) * BLK), j = bj + Math.floor(hash01(seed, 101 + 2 * t) * BLK);
          if (i >= nx || j >= ny) continue;
          const d = D[j * nx + i];
          if (d > best) { best = d; ax = B.x0 + (i + 0.5) * CS; ay = B.y0 + (j + 0.5) * CS; }
          if (d >= 6) break;
        }
        if (best < 2) continue;
        B.groups.push(newGroupRecord(B, seed, ax, ay));
      }
    }
  }
  function newGroupRecord(B, seed, ax, ay) {
    return {
      B, seed, ax, ay, off: hash01(seed, 3) * SLOT, live: false, birds: [], kind: 0, alpha: 1, fade: 0, seen: false,
      plan: -1, key: NaN, cx: ax, cy: ay, ctx: ax, cty: ay, cT: 0, R: null, flyAt: Infinity, flying: false,
      bank: undefined, lawn: undefined, trail: null, th: 0, tn: 0, tlx: 0, tly: 0,
      occR: -1, occ: null, ob: [0, 0, 0, 0], hidR: -1,
    };
  }

  // ================================================================================================ obstacles (banks, lawns)
  // Built the first time a group looks for a bank or a lawn: roads, paths, fences, buildings, trees, and the areas that
  // are not somewhere to sit (car parks, plazas, courts…) or are lawns, in 40 m bins.
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
  const BLOCK_AREAS = new Set(["parking", "plaza", "road", "bridge", "pool", "court", "pitch", "track", "stall", "garden", "flower", "sand"]);
  const LAWN_AREAS = new Set(["grass", "park", "meadow", "campus"]);
  let OBS = null;
  function obstacles() {
    if (OBS) return OBS;
    const segs = [], sGrid = new Array(GX * GY);
    const addLine = (pts, reach, hard) => {
      for (let k = 0; k + 3 < pts.length; k += 2) {
        const id = segs.length / 6, ax = pts[k], ay = pts[k + 1], bx = pts[k + 2], by = pts[k + 3];
        segs.push(ax, ay, bx, by, reach, hard);
        gridAdd(sGrid, id, Math.min(ax, bx) - reach, Math.min(ay, by) - reach, Math.max(ax, bx) + reach, Math.max(ay, by) + reach);
      }
    };
    for (const p of data.paths || []) if (!p.tn && p.pts) addLine(p.pts, (p.w || 2) / 2 + 0.7, 0);
    for (const r of data.roads || []) if (!r.tn && r.pts) addLine(r.pts, (r.w || 6) / 2 + 1.5, 1);
    for (const b of data.barriers || []) if (b.pts) addLine(b.pts, 0.8, 1);
    const bGrid = new Array(GX * GY), bBox = new Float32Array(data.buildings.length * 4);
    data.buildings.forEach((b, i) => { const bb = ringBox(b.p[0]); bBox.set(bb, 4 * i); gridAdd(bGrid, i, bb[0], bb[1], bb[2], bb[3]); });
    const tr = data.trees, tGrid = new Array(GX * GY);
    for (let t = 0; t < tr.length / 5; t++) gridAdd(tGrid, t, tr[5 * t] - 1, tr[5 * t + 1] - 1, tr[5 * t] + 1, tr[5 * t + 1] + 1);
    const aGrid = new Array(GX * GY), lGrid = new Array(GX * GY), aBox = new Float32Array(data.areas.length * 4);
    data.areas.forEach((a, i) => {
      const blockK = BLOCK_AREAS.has(a.k), lawnK = LAWN_AREAS.has(a.k);
      if ((!blockK && !lawnK) || !a.p || !a.p[0]) return;
      const bb = ringBox(a.p[0]);
      aBox.set(bb, 4 * i);
      gridAdd(blockK ? aGrid : lGrid, i, bb[0], bb[1], bb[2], bb[3]);
    });
    return (OBS = { segs: Float32Array.from(segs), sGrid, bGrid, bBox, tGrid, aGrid, lGrid, aBox });
  }
  // somewhere a bird can't stand: a road, a fence, a building, a tree trunk, a car park… (soft: paths too)
  function blockedAt(x, y, soft) {
    const O = obstacles(), c = cellOf(x, y);
    if (c < 0) return true;
    let L = O.sGrid[c];
    if (L) for (const id of L) { const S = O.segs, o = id * 6; if ((soft || S[o + 5]) && segDist(x, y, S[o], S[o + 1], S[o + 2], S[o + 3]) < S[o + 4]) return true; }
    L = O.bGrid[c];
    if (L) for (const i of L) if (x >= O.bBox[4 * i] && x <= O.bBox[4 * i + 2] && y >= O.bBox[4 * i + 1] && y <= O.bBox[4 * i + 3] && app.scene.contains(i, x, y)) return true;
    if (soft) {
      L = O.tGrid[c];
      if (L) for (const t of L) if (Math.hypot(x - data.trees[5 * t], y - data.trees[5 * t + 1]) < 0.9) return true;
    }
    L = O.aGrid[c];
    if (L) for (const i of L) {
      if (x < O.aBox[4 * i] || x > O.aBox[4 * i + 2] || y < O.aBox[4 * i + 1] || y > O.aBox[4 * i + 3]) continue;
      if (inRings(data.areas[i].p, x, y)) return true;
    }
    return false;
  }
  function lawnAt(x, y) {
    const O = obstacles(), c = cellOf(x, y), L = c < 0 ? null : O.lGrid[c];
    if (L) for (const i of L) {
      if (x < O.aBox[4 * i] || x > O.aBox[4 * i + 2] || y < O.aBox[4 * i + 1] || y > O.aBox[4 * i + 3]) continue;
      if (inRings(data.areas[i].p, x, y)) return true;
    }
    return false;
  }
  // A bank near the group's water: a land point 0.5–4 m from the water a bird can sit on, and the water just off it.
  function bankOf(G) {
    if (G.bank !== undefined) return G.bank;
    G.bank = null;
    const B = G.B, a0 = hash01(G.seed, 7) * TAU;
    for (let r = 3; r <= 44 && !G.bank; r += 2) for (let q = 0; q < 18; q++) {
      const a = a0 + (q * TAU) / 18, x = G.ax + r * Math.cos(a), y = G.ay + r * Math.sin(a), d = dAt(B, x, y);
      if (d > -0.5 || d < -4 || blockedAt(x, y, true)) continue;
      // the water just off it: walk back toward the middle until there is room to swim
      let ex = x, ey = y, ok = false;
      for (let k = 0; k < 8; k++) {
        ex += Math.cos(a + Math.PI) * 1; ey += Math.sin(a + Math.PI) * 1;
        if (dAt(B, ex, ey) >= 3) { ok = true; break; }
      }
      if (!ok || !lineWater(B, ex, ey, G.ax, G.ay, 0.8)) continue;
      // room round the seat for the whole group
      let room = 0;
      for (let k = 0; k < 8; k++) { const xx = x + 1.6 * Math.cos((k * TAU) / 8), yy = y + 1.6 * Math.sin((k * TAU) / 8); if (dAt(B, xx, yy) < -0.3 && !blockedAt(xx, yy, true)) room++; }
      if (room < 3) continue;
      G.bank = { x, y, ex, ey, a };
      break;
    }
    return G.bank;
  }
  // A lawn for geese to graze: grass 5–40 m back from the bank, reachable without crossing a road or a building.
  function lawnOf(G) {
    if (G.lawn !== undefined) return G.lawn;
    G.lawn = null;
    const bk = bankOf(G);
    if (!bk) return null;
    const B = G.B, a0 = bk.a, sgn = hash01(G.seed, 8) < 0.5 ? 1 : -1;
    for (let r = 6; r <= 40 && !G.lawn; r += 3) for (let q = 0; q < 12; q++) {
      const a = a0 + sgn * (q % 2 ? -1 : 1) * Math.ceil(q / 2) * 0.32, x = bk.x + r * Math.cos(a), y = bk.y + r * Math.sin(a), d = dAt(B, x, y);
      if (d > -5 || !lawnAt(x, y) || blockedAt(x, y, true)) continue;
      let ok = true;
      const n = Math.ceil(r / 2);
      for (let k = 1; k < n && ok; k++) { const xx = bk.x + ((x - bk.x) * k) / n, yy = bk.y + ((y - bk.y) * k) / n; ok = dAt(B, xx, yy) < 0 && !blockedAt(xx, yy, false); }
      if (!ok) continue;
      let room = 0;
      for (let k = 0; k < 8; k++) { const xx = x + 3.5 * Math.cos((k * TAU) / 8), yy = y + 3.5 * Math.sin((k * TAU) / 8); if (lawnAt(xx, yy) && !blockedAt(xx, yy, true) && dAt(B, xx, yy) < -1) room++; }
      if (room < 5) continue;
      G.lawn = { x, y };
      break;
    }
    return G.lawn;
  }

  // ================================================================================================ groups: who and what
  function groupKind(G) {
    const r = hash01(G.seed, C.day * 3 + 1), spring = C.doy >= 60 && C.doy < 250;
    const brood = ducklingSeason() ? 0.22 : 0, gfam = goslingSeason() ? 0.14 : 0;
    const w = spring ? [0.32, 0.18, brood, 0.13, 0.12, gfam] : [0.24, 0.36, 0, 0.28, 0.12, 0];
    if (G.B.kind === "lake") { w[G_GEESE] *= 0.6; w[G_PAIR] *= 1.3; }
    let tot = 0;
    for (const v of w) tot += v;
    let acc = 0;
    for (let k = 0; k < w.length; k++) { acc += w[k] / tot; if (r < acc) return k; }
    return G_PAIR;
  }
  // is the group here today (frozen ponds empty, the river thinned in deep cold)?
  function present(G) {
    let p = MANY ? 1 : 0.82;
    if (G.B.kind !== "river" && C.frozen) p = 0;
    if (G.B.kind === "river" && C.riverCold) p *= 0.5;
    return hash01(G.seed, C.day * 3 + 2) < p;
  }
  function newBird(G, sp, k) {
    return {
      G, sp, k, x: G.ax, y: G.ay, z: 0, hd: 0, v: 0, spd: 0.35, act: IDLE, t: 1, ph: hash01(G.seed, 50 + k) * 10,
      onW: true, tx: G.ax, ty: G.ay, hx: G.ax, hy: G.ay, wait: 0, follow: -1, mate: -1,
      path: new Float32Array(15), np: 0, pi: 0,
      fx0: 0, fy0: 0, fx1: 0, fy1: 0, fT: 1, ft: 0, fh: 0, fbow: 0, fsplash: false,
      size: 1, look: LOOK[sp], name: hashInt(G.seed, 70 + k),
      hid: false, hidT: 0, occ: new Int32Array(24), nOcc: -1, occX: 1e9, occY: 1e9, occZ: 0, occR: -1,
      sx: -1e4, sy: -1e4, sr: 0,
    };
  }
  function spawn(G) {
    const kind = (G.kind = groupKind(G));
    const R = (G.R = rng(hashInt(G.seed, C.day)));
    const B = G.birds;
    B.length = 0;
    const winter = C.doy >= 280 || C.doy < 120;
    const add = (sp) => { const b = newBird(G, sp, B.length); B.push(b); return b; };
    switch (kind) {
      case G_PAIR: add(HEN); add(DRAKE).mate = 0; break;
      case G_MALLARDS: { const n = 3 + Math.floor(R() * 6); for (let k = 0; k < n; k++) add(R() < (winter ? 0.58 : 0.5) ? DRAKE : HEN); break; }
      case G_BROOD: { add(HEN); const n = 4 + Math.floor(R() * 6); for (let k = 0; k < n; k++) add(DUCKLING).follow = k + 1; break; }
      case G_GEESE: { const n = 4 + Math.floor(R() * (winter ? 11 : 7)); for (let k = 0; k < n; k++) add(GOOSE); break; }
      case G_GPAIR: add(GOOSE); add(GOOSE).mate = 0; break;
      case G_GFAM: { add(GOOSE); const n = 3 + Math.floor(R() * 4); for (let k = 0; k < n; k++) add(GOSLING).follow = k + 1; add(GOOSE).follow = n + 2; break; }
    }
    if (eclipse()) for (const b of B) if (b.sp === DRAKE) b.look = ECLIPSE;
    // the young grow through the season
    const grow = (from, to, a, b) => from + (to - from) * clamp((C.doy - a) / (b - a), 0, 1);
    for (const b of B) {
      if (b.sp === DUCKLING) b.size = grow(0.36, 0.7, 112, 178) * (0.94 + 0.12 * R());
      else if (b.sp === GOSLING) b.size = grow(0.34, 0.72, 115, 170) * (0.94 + 0.12 * R());
      else b.size = 0.93 + 0.14 * R();
    }
    if (G.birds[0].follow < 0 && B.some((b) => b.follow >= 0)) G.trail = G.trail || new Float32Array(3 * 160);
    G.live = true; G.alpha = 1; G.fade = 0; G.plan = -1; G.key = NaN; G.flyAt = Infinity; G.flying = false;
    G.occR = -1; G.hidR = -1;
    updatePlan(G, true);
  }
  const isGeese = (G) => G.kind === G_GEESE || G.kind === G_GPAIR || G.kind === G_GFAM;
  const hasYoung = (G) => G.kind === G_BROOD || G.kind === G_GFAM;

  // ---------------------------------------------------------------- plans
  function choosePlan(G, slot) {
    if (C.isNight) return hash01(G.seed, C.day * 5 + 4) < 0.45 && bankOf(G) ? P_BANKSLEEP : P_RAFT;
    const r = hash01(G.seed, slot * 11 + 1), cold = C.temp < 28;
    if (isGeese(G)) {
      if (r < 0.36 && !cold && lawnOf(G)) return P_GRAZE;
      if (r < 0.52 && bankOf(G)) return P_BANK;
      return P_WATER;
    }
    if (r < (cold ? 0.12 : 0.26) && bankOf(G)) return P_BANK;
    return P_WATER;
  }
  function updatePlan(G, instant) {
    const tMin = simMs / 60000, slot = Math.floor((tMin + G.off) / SLOT);
    const key = C.isNight ? -1 - C.day : slot;
    if (G.key === key) return;
    G.key = key;
    // the water this slot's paddling is centred on
    const R = G.R;
    G.cx = G.ax; G.cy = G.ay; G.cT = 0;
    wanderCentre(G, rng(hashInt(G.seed, slot * 13 + 5)), 14);
    if (instant) { G.cx = G.ctx; G.cy = G.cty; }
    const plan = choosePlan(G, slot);
    // now and then a group takes off and lands somewhere else on the water (not with young, not at night)
    const pFly = isGeese(G) ? 0.3 : 0.16;
    G.flyAt = !C.isNight && !hasYoung(G) && plan === P_WATER && hash01(G.seed, slot * 11 + 3) < pFly
      ? (slot * SLOT - G.off) * 60000 + (0.15 + 0.7 * hash01(G.seed, slot * 11 + 4)) * SLOT * 60000 : Infinity;
    setPlan(G, plan, instant, R);
  }
  // a new centre for the group's paddling, within reach water of the anchor
  function wanderCentre(G, R, reach) {
    const B = G.B;
    for (let t = 0; t < 10; t++) {
      const a = R() * TAU, r = reach * Math.sqrt(R()), x = G.ax + r * Math.cos(a), y = G.ay + r * Math.sin(a);
      if (dAt(B, x, y) >= 3 && lineWater(B, G.cx, G.cy, x, y, 1)) { G.ctx = x; G.cty = y; return; }
    }
    G.ctx = G.ax; G.cty = G.ay;
  }
  function setPlan(G, plan, instant, R) {
    G.plan = plan;
    const bk = G.bank, lw = G.lawn, geese = isGeese(G), young = hasYoung(G);
    let k = 0;
    for (const b of G.birds) {
      const lead = b.follow < 0;
      b.np = 0; b.pi = 0; b.wait = 0;
      if (instant) {
        // put each bird where this plan has it, doing what it does there
        const a = hash01(b.name, 1) * TAU, r = (geese ? 1.2 : 0.7) * Math.sqrt(k + 0.5) * (0.8 + 0.4 * hash01(b.name, 2));
        if (plan === P_BANK || plan === P_BANKSLEEP) placeLand(G, b, bk.x, bk.y, r, a);
        else if (plan === P_GRAZE) placeLand(G, b, lw.x, lw.y, r * 1.8, a);
        else placeWater(G, b, G.cx, G.cy, plan === P_RAFT ? r * 0.8 : r * 1.6, a);
        b.hd = hash01(b.name, 3) * TAU;
        b.hx = b.x; b.hy = b.y;
        settle(G, b, R);
        if (plan === P_WATER) b.t *= hash01(b.name, 4);
        k++;
        continue;
      }
      if (!lead) continue;   // the young follow their parent's trail
      b.wait = (b.mate >= 0 ? 1.2 : k * (geese ? 1.4 : 0.9)) + R() * 0.4;
      const a = hash01(b.name, 1) * TAU, r = (geese ? 1.2 : 0.7) * Math.sqrt(k + 0.5);
      if (plan === P_BANK || plan === P_BANKSLEEP) {
        if (b.onW) { pushWp(b, bk.ex, bk.ey, 0); }
        const s = landSpot(G, bk.x, bk.y, r, a);
        pushWp(b, s[0], s[1], 0);
      } else if (plan === P_GRAZE) {
        if (b.onW) { pushWp(b, bk.ex, bk.ey, 0); pushWp(b, bk.x, bk.y, 0); }
        const s = landSpot(G, lw.x, lw.y, r * 1.8, a);
        pushWp(b, s[0], s[1], 0);
      } else if (!b.onW) {
        // back to the water by way of the bank
        const bk2 = bankOf(G);
        if (bk2) { if (Math.hypot(b.x - bk2.x, b.y - bk2.y) > 3) pushWp(b, bk2.x, bk2.y, 0); pushWp(b, bk2.ex, bk2.ey, 1); }
      } else if (plan === P_RAFT) {
        const s = waterSpot(G, G.cx, G.cy, r * 0.8, a);
        pushWp(b, s[0], s[1], 1);
      }
      if (b.act === REST || b.act === SLEEP || b.act === GRAZE) b.act = IDLE;
      b.t = 0;
      k++;
    }
    // the young start in a line behind their parent (or huddled round it on the bank); later they follow its trail
    if (young && instant) resetTrail(G, plan === P_WATER || plan === P_RAFT);
  }
  function pushWp(b, x, y, water) { if (b.np >= 5) return; b.path[3 * b.np] = x; b.path[3 * b.np + 1] = y; b.path[3 * b.np + 2] = water; b.np++; }
  const SPOT = [0, 0];
  function landSpot(G, x, y, r, a) {
    for (let t = 0; t < 6; t++) {
      const rr = r * (1 - t * 0.15), xx = x + rr * Math.cos(a + t), yy = y + rr * Math.sin(a + t);
      if (dAt(G.B, xx, yy) < -0.3 && !blockedAt(xx, yy, true)) { SPOT[0] = xx; SPOT[1] = yy; return SPOT; }
    }
    SPOT[0] = x; SPOT[1] = y; return SPOT;
  }
  function waterSpot(G, x, y, r, a) {
    for (let t = 0; t < 6; t++) {
      const rr = r * (1 - t * 0.15), xx = x + rr * Math.cos(a + t), yy = y + rr * Math.sin(a + t);
      if (dAt(G.B, xx, yy) >= 1.2) { SPOT[0] = xx; SPOT[1] = yy; return SPOT; }
    }
    SPOT[0] = x; SPOT[1] = y; return SPOT;
  }
  function placeLand(G, b, x, y, r, a) { const s = landSpot(G, x, y, r, a); b.x = s[0]; b.y = s[1]; b.onW = false; b.z = 0; }
  function placeWater(G, b, x, y, r, a) { const s = waterSpot(G, x, y, r, a); b.x = s[0]; b.y = s[1]; b.onW = true; b.z = 0; }
  // the young in a line behind their parent, along its heading (as far as the water goes)
  function resetTrail(G, place) {
    const L = G.birds[0], T = G.trail;
    if (!T) return;
    const n = T.length / 3;
    G.th = 0; G.tn = 0;
    const ux = -Math.cos(L.hd), uy = -Math.sin(L.hd);
    let x = L.x, y = L.y;
    for (let k = n - 1; k >= 0; k--) {
      const nx = L.x + ux * k * 0.25, ny = L.y + uy * k * 0.25;
      if (!L.onW || dAt(G.B, nx, ny) >= 0.6) { x = nx; y = ny; } else { x = L.x; y = L.y; }
      const i = (n - 1 - k) % n;
      T[3 * i] = x; T[3 * i + 1] = y; T[3 * i + 2] = L.onW ? 1 : 0;
    }
    G.th = n - 1; G.tn = n; G.tlx = L.x; G.tly = L.y;
    if (!place) return;
    for (const b of G.birds) if (b.follow >= 0) { trailPoint(G, b.follow * gapOf(G)); b.x = TP[0]; b.y = TP[1]; b.onW = TP[2] > 0.5; b.hd = L.hd; }
  }
  const gapOf = (G) => (G.kind === G_GFAM ? 0.75 : 0.42);
  const TP = [0, 0, 0];
  function trailPoint(G, back) {
    const T = G.trail, n = T.length / 3, idx = Math.min(G.tn - 1, Math.round(back / 0.25)), i = ((G.th - idx) % n + n) % n;
    TP[0] = T[3 * i]; TP[1] = T[3 * i + 1]; TP[2] = T[3 * i + 2];
    return TP;
  }
  function recordTrail(G) {
    const L = G.birds[0], T = G.trail;
    if (!T || Math.hypot(L.x - G.tlx, L.y - G.tly) < 0.25) return;
    const n = T.length / 3;
    G.th = (G.th + 1) % n; G.tn = Math.min(n, G.tn + 1);
    T[3 * G.th] = L.x; T[3 * G.th + 1] = L.y; T[3 * G.th + 2] = L.onW ? 1 : 0;
    G.tlx = L.x; G.tly = L.y;
  }

  // ---------------------------------------------------------------- what a bird does next
  function settle(G, b, R) {
    const plan = G.plan, geese = b.sp >= GOOSE;
    if (plan === P_BANKSLEEP || plan === P_RAFT) { b.act = SLEEP; b.t = 1e9; b.v = 0; return; }
    if (plan === P_BANK) { b.act = R() < 0.72 ? REST : PREEN; b.t = b.act === REST ? 8 + R() * 30 : 3 + R() * 6; b.v = 0; return; }
    if (plan === P_GRAZE) {
      b.act = GRAZE; b.t = 2.5 + R() * 5;
      const a = R() * TAU, r = 0.3 + R() * 0.9;
      let tx = b.x + r * Math.cos(a), ty = b.y + r * Math.sin(a);
      if (Math.hypot(tx - b.hx, ty - b.hy) > 3.5) { tx = b.hx + (tx - b.hx) * 0.4; ty = b.hy + (ty - b.hy) * 0.4; }
      if (dAt(G.B, tx, ty) < -1 && !blockedAt(tx, ty, true)) { b.tx = tx; b.ty = ty; } else { b.tx = b.x; b.ty = b.y; }
      return;
    }
    // on the water (a bird left on land walks back to it)
    if (!b.onW) {
      const bk = bankOf(G);
      b.act = IDLE; b.t = 1;
      if (bk) { if (Math.hypot(b.x - bk.x, b.y - bk.y) > 2) pushWp(b, bk.x, bk.y, 0); pushWp(b, bk.ex, bk.ey, 1); }
      return;
    }
    const r = R();
    if (r < 0.42) {
      if (swimTarget(G, b, R)) { b.act = SWIM; b.t = 25; return; }
      b.act = IDLE; b.t = 2 + R() * 3; return;
    }
    if (r < (geese ? 0.52 : 0.66)) { b.act = DABBLE; b.t = 1.6 + R() * (geese ? 2 : 3.2); return; }
    if (r < 0.8) { b.act = PREEN; b.t = 2.5 + R() * 5; return; }
    b.act = IDLE; b.t = 2 + R() * 6;
  }
  function swimTarget(G, b, R) {
    const B = G.B, mate = b.mate >= 0 ? G.birds[b.mate] : null;
    const cx = mate && mate.onW ? mate.x : G.cx, cy = mate && mate.onW ? mate.y : G.cy;
    const reach = mate ? 1.6 : G.kind === G_GEESE || G.kind === G_MALLARDS ? 6 : 4.5;
    for (let t = 0; t < 6; t++) {
      const a = R() * TAU, r = reach * Math.sqrt(R()), x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
      if (dAt(B, x, y) >= 1.4 && lineWater(B, b.x, b.y, x, y, 0.7)) {
        b.tx = x; b.ty = y; b.spd = (b.sp >= GOOSE ? 0.42 : 0.34) * (0.8 + 0.4 * R()); return true;
      }
    }
    return false;
  }

  // ================================================================================================ moving
  function steer(b, tx, ty, v, dt, turn) {
    const dx = tx - b.x, dy = ty - b.y, d = Math.hypot(dx, dy);
    if (d < 0.04) { b.v = 0; return d; }
    let da = Math.atan2(dy, dx) - b.hd;
    da -= TAU * Math.round(da / TAU);
    const mt = turn * dt;
    b.hd += da < -mt ? -mt : da > mt ? mt : da;
    const st = Math.min(d, v * dt * Math.max(0.15, Math.cos(da)));
    b.x += Math.cos(b.hd) * st; b.y += Math.sin(b.hd) * st;
    b.v = st / Math.max(dt, 1e-3);
    return d - st;
  }
  function stepBird(G, b, dt) {
    b.ph += dt;
    if (b.act === FLY) { stepFlight(G, b, dt); return; }
    if (b.follow >= 0) { stepYoung(G, b, dt); return; }
    if (b.wait > 0) { b.wait -= dt; b.v = 0; return; }
    const B = G.B, R = G.R;
    if (b.np > b.pi) {
      // on the way somewhere: swimming to the bank, waddling up it, across the grass
      const o = 3 * b.pi, tx = b.path[o], ty = b.path[o + 1];
      const v = b.onW ? (b.sp >= GOOSE ? 0.45 : 0.38) : b.sp >= GOOSE ? 0.5 : 0.36;
      b.act = b.onW ? SWIM : WALK;
      const left = steer(b, tx, ty, v, dt, 3.2);
      b.onW = dAt(B, b.x, b.y) > 0.25;
      if (left < 0.15) {
        b.x = tx; b.y = ty;
        b.onW = b.path[o + 2] > 0.5 || dAt(B, b.x, b.y) > 0.25;
        b.pi++;
        if (b.pi >= b.np) { b.np = 0; b.pi = 0; b.hx = b.x; b.hy = b.y; settle(G, b, R); }
      }
      return;
    }
    b.t -= dt;
    switch (b.act) {
      case SWIM: {
        const ox = b.x, oy = b.y, d0 = dAt(B, ox, oy);
        const left = steer(b, b.tx, b.ty, b.spd, dt, 2.4), d1 = dAt(B, b.x, b.y);
        if (d1 < 0.5 && d1 <= d0) { b.x = ox; b.y = oy; b.v = 0; b.t = 0; }
        if (left < 0.25 || b.t <= 0) settle(G, b, R);
        break;
      }
      case GRAZE: {
        // a step or two, head down, and peck
        if (Math.hypot(b.tx - b.x, b.ty - b.y) > 0.05 && (b.ph % 2.2) < 1.1) steer(b, b.tx, b.ty, 0.28, dt, 4);
        else b.v = 0;
        if (b.t <= 0) settle(G, b, R);
        break;
      }
      case REST: case PREEN: case IDLE: case DABBLE: {
        b.v = 0;
        if (b.onW) drift(B, b, dt);
        if (b.t <= 0) settle(G, b, R);
        break;
      }
      case SLEEP: b.v = 0; break;
      default: if (b.t <= 0) settle(G, b, R);
    }
  }
  // idle on the water, a bird drifts downwind (and paddles to stay off the bank)
  function drift(B, b, dt) {
    if (!C.windX && !C.windY) return;
    const nx = b.x + C.windX * dt, ny = b.y + C.windY * dt;
    if (dAt(B, nx, ny) >= 1.2) { b.x = nx; b.y = ny; }
  }
  // the young: along their parent's trail while it goes somewhere, round it while it rests
  function stepYoung(G, b, dt) {
    const L = G.birds[0];
    const settled = L.np === 0 && L.wait <= 0 && (L.act === REST || L.act === SLEEP || L.act === GRAZE || L.act === PREEN) && !L.onW;
    if (L.act === FLY || !G.trail) { b.v = 0; return; }
    if (settled) {
      // huddled round the parent (on the landward side)
      const a = b.follow * 2.4, r = (b.sp === GOOSE ? 1.1 : b.sp === GOSLING ? 0.5 : 0.32) + 0.09 * b.follow;
      let tx = L.x + r * Math.cos(a), ty = L.y + r * Math.sin(a);
      if (dAt(G.B, tx, ty) > -0.2) { tx = L.x - r * Math.cos(a) * 0.6; ty = L.y - r * Math.sin(a) * 0.6; }
      const left = steer(b, tx, ty, 0.4, dt, 5);
      b.onW = false;
      if (left > 0.08) { b.act = WALK; return; }
      b.act = L.act === SLEEP ? SLEEP : L.act === GRAZE ? GRAZE : REST;
      b.tx = b.x; b.ty = b.y; b.v = 0;
      return;
    }
    const p = trailPoint(G, b.follow * gapOf(G));
    const d = Math.hypot(p[0] - b.x, p[1] - b.y);
    b.onW = p[2] > 0.5;
    if (d > 0.06) {
      steer(b, p[0], p[1], Math.min(0.9, 0.12 + d * 1.8), dt, 6);
      b.act = b.onW ? SWIM : WALK;
    } else {
      b.v = 0;
      if (L.act === SLEEP) b.act = SLEEP;
      else if (b.act === SWIM || b.act === WALK || b.act === SLEEP) b.act = b.onW ? IDLE : REST;
    }
  }

  // ---------------------------------------------------------------- flights: a hop across the water, with a splash
  function startFlight(G) {
    const B = G.B, R = G.R, geese = isGeese(G);
    let lx = 0, ly = 0, ok = false;
    for (let t = 0; t < 16 && !ok; t++) {
      const a = R() * TAU, r = 35 + R() * 70, x = G.ax + r * Math.cos(a), y = G.ay + r * Math.sin(a);
      if (dAt(B, x, y) >= 4) { lx = x; ly = y; ok = true; }
    }
    if (!ok) return;
    G.flying = true;
    let k = 0, vis = false;
    for (const b of G.birds) {
      if (!b.onW) continue;
      const a = hash01(b.name, 11) * TAU, r = (geese ? 1.6 : 1) * Math.sqrt(k + 0.5);
      const s = waterSpot(G, lx, ly, r, a);
      b.fx0 = b.x; b.fy0 = b.y; b.fx1 = s[0]; b.fy1 = s[1];
      const d = Math.hypot(b.fx1 - b.fx0, b.fy1 - b.fy0);
      b.fT = d / (geese ? 8.5 : 9.5) + (geese ? 2.4 : 1.6);
      b.fh = Math.min(18, (geese ? 4 : 3) + d * (geese ? 0.09 : 0.07));
      b.fbow = (hash01(G.seed, 17) - 0.5) * 0.5 * d;
      b.ft = -k * (geese ? 0.45 : 0.22) - R() * 0.2;
      b.act = FLY; b.np = 0; b.wait = 0; b.fsplash = false;
      if (onView(b.x, b.y, 2, 0)) vis = true;
      k++;
    }
    G.cx = G.ctx = lx; G.cy = G.cty = ly;
    if (vis && SCALE >= MIN_S) cue(geese ? "honk" : "quack", G.birds[0].x, G.birds[0].y);
  }
  function stepFlight(G, b, dt) {
    b.ft += dt;
    if (b.ft < 0) { b.v = 0; return; }
    if (!b.fsplash) { b.fsplash = true; splash(b.fx0, b.fy0, b.sp >= GOOSE ? 1.3 : 1); }
    const s = Math.min(1, b.ft / b.fT), geese = b.sp >= GOOSE;
    const bow = Math.sin(Math.PI * s) * b.fbow, dx = b.fx1 - b.fx0, dy = b.fy1 - b.fy0, L = Math.hypot(dx, dy) || 1;
    const nx = b.fx0 + dx * s - (dy / L) * bow, ny = b.fy0 + dy * s + (dx / L) * bow;
    // geese patter across the water before they lift, and ski in to land
    const up = geese ? smooth(0.06, 0.32, s) * (1 - smooth(0.72, 0.95, s)) : Math.pow(Math.sin(Math.PI * Math.min(1, s * 1.05)), 0.6);
    const px = b.x, py = b.y;
    b.x = nx; b.y = ny; b.z = b.fh * up;
    const mx = b.x - px, my = b.y - py;
    if (mx * mx + my * my > 1e-6) b.hd = Math.atan2(my, mx);
    b.v = Math.hypot(mx, my) / Math.max(dt, 1e-3);
    if (s >= 1) {
      b.z = 0; b.onW = true; b.act = IDLE; b.t = 1 + G.R() * 2;
      splash(b.x, b.y, geese ? 1.3 : 1);
      if (G.birds.every((q) => q.act !== FLY)) G.flying = false;
    }
  }
  const SPL = [];   // splashes: x, y, t0, size
  function splash(x, y, size) {
    if (SPL.length > 24) SPL.shift();
    SPL.push({ x, y, t0: performance.now() / 1000, size });
  }

  // ================================================================================================ the population
  let near = [], failed = false, tickAt = -1e9;
  function manage(force) {
    const now = performance.now();
    if (!force && now - tickAt < 400) return;
    tickAt = now;
    setCamera();
    if (now - condAt > 4000) { readConditions(); condAt = now; }
    const on = wild() && SCALE >= SIM_S, M = 0.3 * Math.max(VW, VH);
    // a body of water near the view is rasterised the first time (one a tick)
    if (on) for (const B of bodies) if (!B.built && onView(B.cx, B.cy, B.rad, M)) { build(B); break; }
    near.length = 0;
    let changed = false;
    for (const B of bodies) {
      if (!B.built) continue;
      for (const G of B.groups) {
        if (!onView(G.ax, G.ay, 40, M)) {
          if (G.live) { G.live = false; G.birds.length = 0; changed = true; }
          G.seen = false;
          continue;
        }
        near.push(G);
        const want = on && present(G), seen = SCALE >= MIN_S && onView(G.ax, G.ay, 20, 0);
        if (want && !G.live) {
          spawn(G);
          if (G.seen && seen && !reduceMQ.matches) { G.alpha = 0; G.fade = 1; }
          changed = true;
        } else if (!want && G.live) {
          if (seen && !reduceMQ.matches) { if (G.fade >= 0) { G.fade = -1; changed = true; } }
          else { G.live = false; G.birds.length = 0; changed = true; }
        } else if (want && G.live && G.fade < 0) G.fade = 1;
        if (G.live && !G.flying) updatePlan(G, false);
        G.seen = seen;
      }
    }
    if (changed) app.requestRender("birds");
  }
  function stepAll(dt) {
    if (dt <= 0) return;
    const n = Math.max(1, Math.ceil(dt / 0.1 - 1e-6)), h = dt / n;
    for (const G of near) {
      if (!G.live) continue;
      if (G.fade) {
        G.alpha += (G.fade * dt) / FADE;
        if (G.alpha >= 1) { G.alpha = 1; G.fade = 0; }
        else if (G.alpha <= 0) { G.alpha = 0; G.fade = 0; G.live = false; G.birds.length = 0; continue; }
      }
      if (simMs >= G.flyAt && G.plan === P_WATER) { G.flyAt = Infinity; startFlight(G); }
      // the paddling centre glides about
      G.cT -= dt;
      if (G.cT <= 0 && G.plan === P_WATER && !G.flying) { wanderCentre(G, G.R, 18); G.cT = 40 + G.R() * 50; }
      const cd = Math.hypot(G.ctx - G.cx, G.cty - G.cy);
      if (cd > 0.05) { const st = Math.min(cd, 0.15 * dt); G.cx += ((G.ctx - G.cx) / cd) * st; G.cy += ((G.cty - G.cy) / cd) * st; }
      for (let k = 0; k < n; k++) {
        for (const b of G.birds) stepBird(G, b, h);
        if (G.trail) recordTrail(G);
      }
      separate(G);
    }
  }
  // a nudge keeps a swimming bird in the water and a bird on land out of it
  function fits(B, b, x, y) { const d = dAt(B, x, y); return b.onW ? d >= 0.6 : b.np > b.pi || d <= -0.3; }
  // birds don't sit on top of each other
  function separate(G) {
    const L = G.birds, B = G.B;
    for (let i = 0; i < L.length; i++) {
      const a = L[i];
      if (a.act === FLY || a.act === SLEEP) continue;
      for (let j = i + 1; j < L.length; j++) {
        const b = L[j];
        if (b.act === FLY || b.act === SLEEP) continue;
        const min = 0.3 + 0.28 * (a.size * (a.sp >= GOOSE ? 1.7 : 1) + b.size * (b.sp >= GOOSE ? 1.7 : 1));
        const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
        if (d2 >= min * min || d2 < 1e-8) continue;
        const d = Math.sqrt(d2), push = (min - d) * 0.25, ux = dx / d, uy = dy / d;
        if (a.follow < 0 && fits(B, a, a.x - ux * push, a.y - uy * push)) { a.x -= ux * push; a.y -= uy * push; }
        if (b.follow < 0 && fits(B, b, b.x + ux * push, b.y + uy * push)) { b.x += ux * push; b.y += uy * push; }
      }
    }
  }

  // ================================================================================================ drawing the waterfowl
  const vis = [];
  let nVis = 0, wfWant = 0, wfCount = 0;
  const byDepth = (p, q) => q._d - p._d;
  // the bird's frame on screen (px per model metre): H along its heading, P to its left, Z up; base point BX, BY
  let HX = 0, HY = 0, PX = 0, PY = 0, ZY = 0, BX = 0, BY = 0, KM = 1;
  function frame(b, k) {
    const c = Math.cos(b.hd), s = Math.sin(b.hd);
    HX = (PA * c + PB * s) / SCALE * k; HY = (PC * c + PD * s) / SCALE * k;
    PX = (-PA * s + PB * c) / SCALE * k; PY = (-PC * s + PD * c) / SCALE * k;
    ZY = -COS_T * k; KM = k;
    BX = PA * b.x + PB * b.y + PE; BY = PC * b.x + PD * b.y + PF - PK * b.z;
  }
  // the outline of the ellipsoid with semi-axes (ux,uy), (vx,vy), (wx,wy) on screen round (cx, cy): an ellipse
  function blob(ctx, cx, cy, ux, uy, vx, vy, wx, wy) {
    const sxx = ux * ux + vx * vx + wx * wx, syy = uy * uy + vy * vy + wy * wy, sxy = ux * uy + vx * vy + wx * wy;
    const tr = (sxx + syy) / 2, df = (sxx - syy) / 2, r = Math.sqrt(df * df + sxy * sxy);
    const l1 = tr + r, l2 = tr - r;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.sqrt(Math.max(l1, 0.01)), Math.sqrt(Math.max(l2, 0.01)), 0.5 * Math.atan2(2 * sxy, sxx - syy), 0, TAU);
    ctx.fill();
  }
  // an ellipsoid at (u, v, w) in the bird's frame (model metres), semi-axes a along, b across, c up; pitch tilts it nose-down (< 0)
  function ell(ctx, u, v, w, a, b, c, pitch = 0) {
    const cx = BX + u * HX + v * PX, cy = BY + u * HY + v * PY + w * ZY;
    if (!pitch) { blob(ctx, cx, cy, a * HX, a * HY, b * PX, b * PY, 0, c * ZY); return; }
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    blob(ctx, cx, cy, a * cp * HX, a * (cp * HY + sp * ZY), b * PX, b * PY, -c * sp * HX, c * (-sp * HY + cp * ZY));
  }
  const ptX = (u, v) => BX + u * HX + v * PX, ptY = (u, v, w) => BY + u * HY + v * PY + w * ZY;

  function drawWaterfowl(ctx) {
    nVis = 0; wfWant = 0; wfCount = 0;
    if (failed || !wild() || SCALE < MIN_S) { app.whimsy.waterfowl = 0; return; }
    setCamera();
    const s = SCALE, m = 24 + 3 * s;
    let moving = false;
    for (const G of near) {
      if (!G.live) continue;
      for (const b of G.birds) {
        const px = PA * b.x + PB * b.y + PE, py = PC * b.x + PD * b.y + PF - PK * b.z;
        if (px < -m || px > VW + m || py < -m || py > VH + m) { b.sx = -1e4; continue; }
        b._d = b.x * D0 + b.y * D1 - b.z * 0.01;
        vis[nVis++] = b;
        if (b.act !== SLEEP && b.act !== REST && (b.act !== IDLE || b.onW)) moving = true;
        if (b.act === FLY) moving = true;
      }
    }
    vis.length = nVis;
    app.whimsy.waterfowl = 0;
    const clock = performance.now() / 1000;
    // splashes still going on
    let splashing = false;
    for (let i = SPL.length - 1; i >= 0; i--) if (clock - SPL[i].t0 > 0.9) SPL.splice(i, 1); else splashing = true;
    if (!nVis && !splashing) return;
    vis.sort(byDepth);
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (splashing) drawSplashes(ctx, clock);
    const close = s >= CUT_S;
    for (let q = 0; q < nVis; q++) {
      const b = vis[q], G = b.G, a = G.alpha * Math.min(1, (s - MIN_S) / 0.5 + 0.2);
      b.sx = PA * b.x + PB * b.y + PE; b.sy = PC * b.x + PD * b.y + PF - PK * b.z;
      if (a <= 0.01) continue;
      if (close && app.scene) {
        if (drawCutBird(ctx, b, a)) { wfCount++; } else b.sx = -1e4;
      } else if (!hiddenBird(b, clock)) { drawBird(ctx, b, a); wfCount++; } else b.sx = -1e4;
    }
    ctx.restore();
    app.whimsy.waterfowl = wfCount;
    if ((moving || splashing) && !reduceMQ.matches) wfWant = splashing || s >= 8 ? 20 : s >= 4 ? 14 : 9;
  }

  function sizeOf(b) { return Math.max(SCALE * SIZE, KMIN) * b.size; }

  function drawBird(ctx, b, a) {
    const geese = b.sp >= GOOSE, s = SCALE, k = sizeOf(b);
    frame(b, k);
    b.sr = k * (geese ? 0.6 : 0.36);
    ctx.globalAlpha = a;
    if (s < FULL_S) { drawFar(ctx, b, geese); return; }
    const L = b.look, detail = s >= DETAIL_S && b.size > 0.55, young = b.sp === DUCKLING || b.sp === GOSLING;
    const away = Math.cos(b.hd) * D0 + Math.sin(b.hd) * D1 > 0;       // heading away from the camera
    const leftSeen = -Math.sin(b.hd) * D0 + Math.cos(b.hd) * D1 < 0;  // its left side faces us
    const side = leftSeen ? 1 : -1;
    if (b.act === FLY && b.z > 0.05) { drawFlying(ctx, b, a, geese, away, side); return; }
    const onW = b.onW, act = b.act, t = b.ph;
    // geese are the same model, stretched
    const g = geese ? 1.62 : 1;
    // the water round it, and its wake
    if (onW) {
      if (b.v > 0.06) drawWake(ctx, b, a, g);
      if (act === DABBLE) ripple(ctx, b, a, t, g);
      ctx.fillStyle = a >= 0.99 ? WATERLINE : WAKE + (0.28 * a).toFixed(3) + ")";
      ell(ctx, -0.02 * g, 0, 0, 0.34 * g, 0.17 * g, 0);
    } else {
      ctx.fillStyle = SHADOW;
      ell(ctx, 0.02 * g, 0, 0, 0.28 * g, 0.14 * g, 0);
    }
    // standing on land: legs lift the body; sitting, it's down on the ground
    const sitting = !onW && (act === REST || act === SLEEP);
    const lift = onW ? 0 : sitting ? 0.03 : (geese ? 0.2 : 0.11);
    const waddle = !onW && b.v > 0.05 ? Math.sin(t * 9) * 0.018 : 0;
    if (!onW && !sitting && detail) {
      // legs
      ctx.strokeStyle = L.legs; ctx.lineWidth = Math.max(0.8, 0.035 * k * g);
      const st = b.v > 0.05 ? Math.sin(t * 9) * 0.06 : 0;
      ctx.beginPath();
      ctx.moveTo(ptX(0, 0.05 * g), ptY(0, 0.05 * g, lift + 0.02)); ctx.lineTo(ptX(st * g, 0.05 * g), ptY(st * g, 0.05 * g, 0));
      ctx.moveTo(ptX(0, -0.05 * g), ptY(0, -0.05 * g, lift + 0.02)); ctx.lineTo(ptX(-st * g, -0.05 * g), ptY(-st * g, -0.05 * g, 0));
      ctx.stroke();
    }
    if (act === DABBLE && onW) { drawDabble(ctx, b, L, g, t, detail); return; }
    const bodyW = lift + (onW ? 0.06 : 0.09) * (geese ? 1.3 : 1);
    // where the head is (model metres): up, turned back to preen, tucked in to sleep, down to graze
    let hu, hv = 0, hw, bill = true, pitch = 0;
    if (geese) {
      if (act === SLEEP) { hu = -0.08; hv = 0.1 * side; hw = bodyW + 0.2; bill = false; }
      else if (act === PREEN) { hu = -0.14 + 0.06 * Math.sin(t * 2.3); hv = 0.15 * side; hw = bodyW + 0.26; pitch = -0.6; }
      else if (act === GRAZE) { hu = 0.56; hw = 0.07 + ((t % 1.3) < 0.6 ? Math.abs(Math.sin(t * 9)) * 0.03 : 0); pitch = -0.9; }
      else { hu = young ? 0.32 : 0.36; hw = bodyW + (young ? 0.26 : onW ? 0.5 : 0.56); }
    } else {
      if (act === SLEEP) { hu = -0.04; hv = 0.05 * side; hw = bodyW + 0.1; bill = false; }
      else if (act === PREEN) { hu = -0.06 + 0.04 * Math.sin(t * 2.3); hv = 0.08 * side; hw = bodyW + 0.13; pitch = -0.5; }
      else if (act === GRAZE) { hu = 0.27; hw = 0.06; pitch = -0.6; }
      else { hu = 0.2; hw = bodyW + (young ? 0.14 : 0.19); }
    }
    if (away && act !== SLEEP && act !== PREEN) {
      drawHead(ctx, b, L, g, hu, hv, hw, bodyW, bill, pitch, detail, side, geese, young);
      drawBody(ctx, b, L, g, bodyW, detail, side, geese, young, waddle);
    } else {
      drawBody(ctx, b, L, g, bodyW, detail, side, geese, young, waddle);
      drawHead(ctx, b, L, g, hu, hv, hw, bodyW, bill, pitch, detail, side, geese, young);
    }
  }
  function drawBody(ctx, b, L, g, w, detail, side, geese, young, waddle) {
    const v = waddle;
    if (young) {
      ctx.fillStyle = L.side; ell(ctx, -0.02 * g, v, w, 0.22 * g, 0.13 * g, 0.12 * g);
      ctx.fillStyle = L.back; ell(ctx, -0.05 * g, v, w + 0.05 * g, 0.15 * g, 0.09 * g, 0.06 * g);
      ctx.fillStyle = L.breast; ell(ctx, 0.1 * g, v, w + 0.01, 0.1 * g, 0.1 * g, 0.08 * g);
      return;
    }
    // the rear (and under the tail), the body, the folded wings on its back, the tail, the breast
    ctx.fillStyle = L.rear; ell(ctx, -0.24 * g, v, w + 0.035 * g, 0.08 * g, 0.075 * g, 0.06 * g);
    ctx.fillStyle = L.side; ell(ctx, -0.03 * g, v, w, 0.27 * g, 0.125 * g, 0.09 * g);
    ctx.fillStyle = L.back; ell(ctx, -0.07 * g, v, w + 0.045 * g, 0.2 * g, 0.088 * g, 0.05 * g);
    ctx.fillStyle = L.tail; ell(ctx, -0.31 * g, v, w + 0.06 * g, 0.045 * g, 0.045 * g, 0.025 * g);
    ctx.fillStyle = L.breast; ell(ctx, 0.15 * g, v, w + 0.02 * g, 0.1 * g, 0.105 * g, 0.08 * g);
    if (detail && !geese && b.look === LOOK[DRAKE]) {
      // the blue speculum on the wing, on the side we see
      ctx.fillStyle = "#3d5596"; ell(ctx, -0.12, v + side * 0.07, w + 0.06, 0.05, 0.02, 0.018);
    }
  }
  function drawHead(ctx, b, L, g, hu, hv, hw, bodyW, bill, pitch, detail, side, geese, young) {
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    if (geese) {
      // the long black neck, then the head with its white chinstrap
      const nu = 0.2 * g, nw = bodyW + 0.05 * g;
      ctx.strokeStyle = young ? L.head : "#272523"; ctx.lineWidth = Math.max(1, (young ? 0.1 : 0.085) * KM);
      ctx.beginPath(); ctx.moveTo(ptX(nu, 0), ptY(nu, 0, nw));
      ctx.quadraticCurveTo(ptX(nu + (hu - nu) * 0.2, hv * 0.5), ptY(nu + (hu - nu) * 0.2, hv * 0.5, nw + (hw - nw) * 0.75), ptX(hu, hv), ptY(hu, hv, hw));
      ctx.stroke();
      const hr = young ? 0.075 : 0.068;
      ctx.fillStyle = L.head; ell(ctx, hu, hv, hw, hr * 1.25, hr * 0.8, hr * 0.85, pitch);
      if (!young && bill) { ctx.fillStyle = "#f3efe6"; ell(ctx, hu - 0.012, hv + side * 0.03, hw - 0.012, 0.045, 0.03, 0.035); }
      if (bill) { ctx.fillStyle = L.bill; ell(ctx, hu + (hr * 1.25 + 0.025) * cp, hv, hw - 0.01 + (hr * 1.25 + 0.025) * sp, 0.04, 0.02, 0.014, pitch); }
      return;
    }
    if (!young && b.act !== SLEEP) {
      // the neck (with a drake's white collar close up)
      ctx.fillStyle = L.head; ell(ctx, hu * 0.85, hv * 0.8, (hw + bodyW) * 0.5 + 0.03, 0.045, 0.045, (hw - bodyW) * 0.5 + 0.02);
      if (detail && b.look === LOOK[DRAKE]) { ctx.fillStyle = "#f2efe8"; ell(ctx, hu * 0.8, hv * 0.8, bodyW + 0.075, 0.05, 0.05, 0.012); }
    }
    const hr = young ? 0.08 : 0.065;
    ctx.fillStyle = L.head; ell(ctx, hu, hv, hw, hr * 1.12, hr * 0.85, hr * 0.95, pitch * 0.5);
    if (detail && b.look === LOOK[DRAKE]) { ctx.fillStyle = L.hi; ell(ctx, hu - 0.01, hv - side * 0.01, hw + 0.03, 0.035, 0.024, 0.02); }
    if (young && detail) { ctx.fillStyle = L.hi; ell(ctx, hu - 0.01, hv, hw + 0.035, 0.05, 0.03, 0.025); }
    if (bill) {
      const bl = young ? 0.035 : 0.045, r = hr + bl * 0.6;
      ctx.fillStyle = L.bill;
      ell(ctx, hu + r * cp, hv, hw - 0.015 + r * sp, bl, 0.022, 0.012, pitch);
    }
  }
  // tail up, head under: the rear end and the paddling feet
  function drawDabble(ctx, b, L, g, t, detail) {
    const bob = Math.sin(t * 5) * 0.01;
    // the back end bobbing up out of the water, tail to the sky, and the feet paddling
    ctx.fillStyle = L.side; ell(ctx, -0.02 * g, 0, 0.04 + bob, 0.15 * g, 0.115 * g, 0.075 * g, -0.75);
    ctx.fillStyle = L.back; ell(ctx, -0.05 * g, 0, 0.08 * g + bob, 0.1 * g, 0.08 * g, 0.04 * g, -0.75);
    ctx.fillStyle = L.rear; ell(ctx, -0.085 * g, 0, 0.13 * g + bob, 0.06 * g, 0.06 * g, 0.05 * g, -0.9);
    ctx.fillStyle = L.tail; ell(ctx, -0.11 * g, 0, 0.18 * g + bob, 0.03 * g, 0.035 * g, 0.022 * g);
    if (detail) {
      ctx.strokeStyle = L.legs; ctx.lineWidth = Math.max(0.8, 0.028 * KM * g);
      const k1 = Math.sin(t * 12) * 0.03, k2 = Math.sin(t * 12 + 2) * 0.03;
      ctx.beginPath();
      ctx.moveTo(ptX(-0.06 * g, 0.03), ptY(-0.06 * g, 0.03, 0.12 * g)); ctx.lineTo(ptX(-0.1 * g + k1, 0.05), ptY(-0.1 * g + k1, 0.05, 0.19 * g));
      ctx.moveTo(ptX(-0.06 * g, -0.03), ptY(-0.06 * g, -0.03, 0.12 * g)); ctx.lineTo(ptX(-0.1 * g + k2, -0.05), ptY(-0.1 * g + k2, -0.05, 0.19 * g));
      ctx.stroke();
    }
  }
  // the soft V a paddling bird leaves behind: two arms opening at the Kelvin angle (19.5°), fading
  function drawWake(ctx, b, a, g) {
    const L = (0.55 + Math.min(1, b.v / 0.5) * 1.1) * g, w = L * 0.354, al = Math.min(1, b.v / 0.3) * a * (b.sp === DUCKLING || b.sp === GOSLING ? 0.45 : 1);
    ctx.lineWidth = Math.max(0.7, 0.045 * KM * g);
    for (let seg = 0; seg < 2; seg++) {
      const u0 = 0.22 * g - seg * L * 0.5, u1 = 0.22 * g - (seg + 1) * L * 0.5;
      const f0 = seg * 0.5, f1 = (seg + 1) * 0.5;
      ctx.strokeStyle = WAKE + ((seg ? 0.18 : 0.45) * al).toFixed(3) + ")";
      ctx.beginPath();
      ctx.moveTo(ptX(u0, w * f0 + 0.08 * g), ptY(u0, w * f0 + 0.08 * g, 0)); ctx.lineTo(ptX(u1, w * f1 + 0.08 * g), ptY(u1, w * f1 + 0.08 * g, 0));
      ctx.moveTo(ptX(u0, -w * f0 - 0.08 * g), ptY(u0, -w * f0 - 0.08 * g, 0)); ctx.lineTo(ptX(u1, -w * f1 - 0.08 * g), ptY(u1, -w * f1 - 0.08 * g, 0));
      ctx.stroke();
    }
  }
  // rings spreading from a dabbling bird
  function ripple(ctx, b, a, t, g) {
    ctx.lineWidth = Math.max(0.6, 0.03 * KM);
    for (let r = 0; r < 2; r++) {
      const p = ((t * 0.55 + r * 0.5) % 1), rad = (0.24 + p * 0.5) * g;
      ctx.strokeStyle = WAKE + ((1 - p) * 0.4 * a).toFixed(3) + ")";
      ctx.beginPath();
      blobPath(ctx, BX, BY, rad * HX, rad * HY, rad * PX, rad * PY);
      ctx.stroke();
    }
  }
  function blobPath(ctx, cx, cy, ux, uy, vx, vy) {
    const sxx = ux * ux + vx * vx, syy = uy * uy + vy * vy, sxy = ux * uy + vx * vy;
    const tr = (sxx + syy) / 2, df = (sxx - syy) / 2, r = Math.sqrt(df * df + sxy * sxy);
    ctx.ellipse(cx, cy, Math.sqrt(Math.max(tr + r, 0.01)), Math.sqrt(Math.max(tr - r, 0.01)), 0.5 * Math.atan2(2 * sxy, sxx - syy), 0, TAU);
  }
  // in the air: a shadow below, the body, the neck stretched out, wings beating
  function drawFlying(ctx, b, a, geese, away, side) {
    const L = b.look, g = geese ? 1.62 : 1, z = b.z, k = KM;
    const sx = PA * b.x + PB * b.y + PE, sy = PC * b.x + PD * b.y + PF;
    ctx.fillStyle = "rgba(38,50,60," + (0.18 * a * Math.max(0.25, 1 - z / 20)).toFixed(3) + ")";
    blobPath0(ctx, sx, sy, 0.3 * g * HX, 0.3 * g * HY, 0.5 * g * PX, 0.5 * g * PY);
    const wa = Math.sin(b.ph * (geese ? 15 : 20)) * 0.9, span = 0.42 * g;
    drawWing(ctx, L, -side, wa, span, g);   // the far wing first
    ctx.fillStyle = L.side; ell(ctx, -0.02 * g, 0, 0, 0.27 * g, 0.1 * g, 0.08 * g);
    ctx.fillStyle = L.rear; ell(ctx, -0.25 * g, 0, 0.01, 0.06 * g, 0.06 * g, 0.045 * g);
    if (geese) {
      ctx.strokeStyle = "#272523"; ctx.lineWidth = Math.max(1, 0.055 * k * g);
      ctx.beginPath(); ctx.moveTo(ptX(0.2 * g, 0), ptY(0.2 * g, 0, 0.02)); ctx.lineTo(ptX(0.5 * g, 0), ptY(0.5 * g, 0, 0.05)); ctx.stroke();
      ctx.fillStyle = "#272523"; ell(ctx, 0.55 * g, 0, 0.05, 0.07 * g, 0.04 * g, 0.045 * g);
      ctx.fillStyle = "#f3efe6"; ell(ctx, 0.54 * g, side * 0.02 * g, 0.045, 0.035 * g, 0.025 * g, 0.025 * g);
    } else {
      ctx.fillStyle = L.head; ell(ctx, 0.3, 0, 0.04, 0.075, 0.05, 0.055);
      ctx.fillStyle = L.bill; ell(ctx, 0.38, 0, 0.03, 0.04, 0.02, 0.012);
    }
    drawWing(ctx, L, side, wa, span, g);
  }
  function drawWing(ctx, L, sg, wa, span, g) {
    const cw = Math.cos(wa), sw = Math.sin(wa);
    const ux = sg * cw * span * PX, uy = sg * cw * span * PY + sw * span * ZY;
    ctx.fillStyle = L.back;
    blob(ctx, BX + ux * 0.55, BY + uy * 0.55 + 0.04 * ZY, ux * 0.55, uy * 0.55, 0.1 * g * HX, 0.1 * g * HY, 0, 0.01 * ZY);
  }
  function blobPath0(ctx, cx, cy, ux, uy, vx, vy) { ctx.beginPath(); blobPath(ctx, cx, cy, ux, uy, vx, vy); ctx.fill(); }

  // from afar: a body and a head (and a goose's neck)
  function drawFar(ctx, b, geese) {
    const L = b.look, g = geese ? 1.62 : 1, act = b.act;
    if (act === FLY && b.z > 0.05) {
      const flap = Math.sin(b.ph * 16) * 0.8, span = 0.45 * g;
      ctx.strokeStyle = L.back; ctx.lineWidth = Math.max(0.9, 0.09 * KM * g);
      ctx.beginPath();
      ctx.moveTo(BX + span * PX, BY + span * PY + flap * span * ZY); ctx.lineTo(BX, BY); ctx.lineTo(BX - span * PX, BY - span * PY + flap * span * ZY);
      ctx.stroke();
      ctx.fillStyle = L.far; ell(ctx, 0, 0, 0, 0.3 * g, 0.1 * g, 0.08 * g);
      return;
    }
    if (b.onW && b.v > 0.12) {
      ctx.strokeStyle = WAKE + "0.22)"; ctx.lineWidth = 0.7;
      const Lw = 1.6 * g;
      ctx.beginPath();
      ctx.moveTo(ptX(-Lw, 0.5 * Lw * 0.7), ptY(-Lw, 0.5 * Lw * 0.7, 0)); ctx.lineTo(ptX(0.1, 0), ptY(0.1, 0, 0)); ctx.lineTo(ptX(-Lw, -0.5 * Lw * 0.7), ptY(-Lw, -0.5 * Lw * 0.7, 0));
      ctx.stroke();
    }
    const w = b.onW ? 0.06 : 0.1;
    if (act === DABBLE && b.onW) { ctx.fillStyle = L.far; ell(ctx, -0.02 * g, 0, 0.1, 0.14 * g, 0.12 * g, 0.1 * g); return; }
    ctx.fillStyle = L.far; ell(ctx, -0.03 * g, 0, w, 0.3 * g, 0.14 * g, 0.1 * g);
    if (act === SLEEP) return;
    if (geese) {
      const up = act === GRAZE ? 0.05 : 0.45;
      ctx.strokeStyle = "#2b2927"; ctx.lineWidth = Math.max(0.9, 0.08 * KM);
      ctx.beginPath(); ctx.moveTo(ptX(0.2 * g, 0), ptY(0.2 * g, 0, w + 0.06)); ctx.lineTo(ptX(0.34 * g, 0), ptY(0.34 * g, 0, w + up)); ctx.stroke();
      ctx.fillStyle = "#2b2927"; ell(ctx, 0.36 * g, 0, w + up, 0.09, 0.06, 0.06);
    } else {
      ctx.fillStyle = L.head; ell(ctx, 0.2, 0, w + 0.18, 0.08, 0.07, 0.07);
    }
  }

  function drawSplashes(ctx, clock) {
    for (const p of SPL) {
      const age = clock - p.t0, q = age / 0.9;
      if (q < 0 || q > 1 || !onView(p.x, p.y, 3, 10)) continue;
      const cx = PA * p.x + PB * p.y + PE, cy = PC * p.x + PD * p.y + PF, k = Math.max(SCALE * SIZE, KMIN) * p.size;
      // a ring spreading, and drops thrown up and falling back
      ctx.strokeStyle = WAKE + ((1 - q) * 0.75).toFixed(3) + ")";
      ctx.lineWidth = Math.max(0.7, 0.05 * k);
      const r = (0.25 + q * 1.1) * k;
      ctx.beginPath(); ctx.ellipse(cx, cy, r, r * SIN_T, 0, 0, TAU); ctx.stroke();
      ctx.fillStyle = WAKE + ((1 - q) * 0.9).toFixed(3) + ")";
      ctx.beginPath();
      for (let d = 0; d < 7; d++) {
        const ang = d * 0.9 + p.t0, rr = (0.2 + q * 0.7) * k * (0.6 + 0.4 * ((d * 37) % 5) / 5);
        const h = (2.2 * q - 2.4 * q * q) * k * 0.55;
        const dx = cx + Math.cos(ang) * rr, dy = cy + Math.sin(ang) * rr * SIN_T - Math.max(0, h);
        const ds = Math.max(0.8, 0.045 * k);
        ctx.rect(dx - ds / 2, dy - ds / 2, ds, ds);
      }
      ctx.fill();
    }
  }

  // ---------------------------------------------------------------- what stands in front
  // The scene objects whose screen box meets the group's ground box (with room round it, up to 20 m high): worked out
  // when the group wanders out of the box last asked about, or the view turns.
  function objectsOver(G) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of G.birds) { if (b.x < x0) x0 = b.x; if (b.x > x1) x1 = b.x; if (b.y < y0) y0 = b.y; if (b.y > y1) y1 = b.y; }
    const ob = G.ob;
    if (G.occR === ROT && x0 >= ob[0] && y0 >= ob[1] && x1 <= ob[2] && y1 <= ob[3]) return G.occ;
    ob[0] = x0 - 12; ob[1] = y0 - 12; ob[2] = x1 + 12; ob[3] = y1 + 12;
    const o = geo.ROTS[ROT];
    let X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity;
    for (let c = 0; c < 8; c++) {
      const x = c & 1 ? ob[2] : ob[0], y = c & 2 ? ob[3] : ob[1];
      const X = x * o.R[0] + y * o.R[1], Y = -(x * o.D[0] + y * o.D[1]) * SIN_T - (c & 4 ? 20 : 0) * COS_T;
      if (X < X0) X0 = X; if (X > X1) X1 = X; if (Y < Y0) Y0 = Y; if (Y > Y1) Y1 = Y;
    }
    G.occ = app.scene.query(ROT, "objects", X0 - 2, Y0 - 2, X1 + 2, Y1 + 2);
    G.occR = ROT;
    for (const b of G.birds) b.nOcc = -1;
    return G.occ;
  }
  const SIL = makeRecorder(), SIL_EXACT = SIL.withAddPath();
  const BOX = [0, 0, 0, 0];
  // the screen box a bird (and its wake) may cover, CSS px
  function birdBox(b) {
    const k = sizeOf(b), g = b.sp >= GOOSE ? 1.62 : 1, px = PA * b.x + PB * b.y + PE, py = PC * b.x + PD * b.y + PF - PK * b.z;
    const r = (b.act === FLY ? 0.6 : b.onW && b.v > 0.06 ? 0.4 + 3.2 * Math.min(1, b.v / 0.5) : 0.45) * g * k;
    BOX[0] = px - r - 2; BOX[2] = px + r + 2; BOX[1] = py - (0.75 * g * k * COS_T) - 3; BOX[3] = py + r * 0.6 + 2 + (b.act === FLY ? PK * b.z : 0);
    return BOX;
  }
  // close up: draw the bird through a clip that leaves out the outlines of what stands in front of it
  function drawCutBird(ctx, b, a) {
    const sc = app.scene, S = sc.forRot(ROT), bb = S.objBB, Bn = sc.B, T = sc.T, tr = data.trees, s = SCALE;
    const ids = objectsOver(b.G);
    birdBox(b);
    const X0 = BOX[0], Y0 = BOX[1], X1 = BOX[2], Y1 = BOX[3];
    // which of them are in front of it (kept while it stays within half a metre)
    if (b.nOcc < 0 || b.occR !== ROT || Math.hypot(b.x - b.occX, b.y - b.occY) > 0.5 || Math.abs(b.z - b.occZ) > 0.5) {
      const mX0 = (X0 - PE) / s - 2, mY0 = (Y0 - PF) / s - 2, mX1 = (X1 - PE) / s + 2, mY1 = (Y1 - PF) / s + 2;
      let n = 0;
      for (let q = 0; q < ids.length && n < b.occ.length; q++) {
        const id = ids[q], o = 4 * id;
        if (bb[o + 2] < mX0 || bb[o] > mX1 || bb[o + 3] < mY0 || bb[o + 1] > mY1) continue;
        if (sc.inFront(ROT, id, b.x, b.y, 0.3)) b.occ[n++] = id;
      }
      b.nOcc = n; b.occX = b.x; b.occY = b.y; b.occZ = b.z; b.occR = ROT;
    }
    if (!b.nOcc) { drawBird(ctx, b, a); return true; }
    SIL.reset();
    for (let q = 0; q < b.nOcc; q++) {
      const id = b.occ[q], conifer = id >= Bn && id < Bn + T && (tr[5 * (id - Bn) + 4] & 1);
      renderer.silhouette(conifer ? SIL_EXACT : SIL, ROT, CAM, id, app.tileStyle);
    }
    SIL.closePath();
    let cuts = 0;
    for (let p = 0; p < SIL.count; p++) if (SIL.meets(p, X0, Y0, X1, Y1)) cuts++;
    if (!cuts) { drawBird(ctx, b, a); return true; }
    // wholly behind one piece: not drawn (and not clickable)
    ctx.save();
    ctx.beginPath(); ctx.rect(X0, Y0, X1 - X0, Y1 - Y0); ctx.clip();
    for (let p = 0; p < SIL.count; p++) if (SIL.meets(p, X0, Y0, X1, Y1)) SIL.cut(ctx, p, X0 - 2, Y0 - 2, X1 + 2, Y1 + 2);
    drawBird(ctx, b, a);
    ctx.restore();
    // clickable only if its middle isn't under a cut (checked every half second or so)
    return !hiddenBird(b, performance.now() / 1000);
  }
  // from afar: a building or a leafy crown in front of it (checked every half second or so)
  function hiddenBird(b, clock) {
    if (!app.scene) return false;
    if (clock >= b.hidT || b.hidR !== ROT) {
      b.hid = pointHidden(b.x, b.y, b.z + 0.15);
      b.hidT = clock + 0.45 + Math.random() * 0.2; b.hidR = ROT;
    }
    return b.hid;
  }
  function pointHidden(x, y, h) {
    const sc = app.scene, r = ROT, o = geo.ROTS[r];
    const U = x * o.R[0] + y * o.R[1], Y = -(x * o.D[0] + y * o.D[1]) * SIN_T - h * COS_T;
    const bi = sc.pickBuilding(r, U, Y);
    if (bi >= 0 && sc.inFront(r, bi, x, y, 0)) return true;
    const ids = sc.query(r, "objects", U - 0.3, Y - 0.3, U + 0.3, Y + 0.3), Bn = sc.B, T = sc.T, tr = data.trees;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k];
      if (id < Bn || id >= Bn + T) continue;
      const t = id - Bn, tx = tr[5 * t], ty = tr[5 * t + 1], rad = tr[5 * t + 2], th = tr[5 * t + 3];
      if (renderer.treeBare(t, app.tileStyle) || !sc.inFront(r, id, x, y, 0)) continue;
      const cu = tx * o.R[0] + ty * o.R[1], cv = -(tx * o.D[0] + ty * o.D[1]) * SIN_T - Math.max(th - rad, th * 0.55) * COS_T;
      if ((U - cu) ** 2 + (Y - cv) ** 2 < rad * rad * 0.8) return true;
    }
    return false;
  }

  // ================================================================================================ the sky
  // ---------------------------------------------------------------- a murmuration
  const MN = 720;
  const MB = new Float32Array(MN * 4), MXY = new Float32Array(MN * 2);
  {
    const R = rng(0x57a71);
    for (let i = 0; i < MN; i++) {
      // a sheet, denser toward its middle; a few stragglers at the edge
      // (a sharp-edged sheet: most birds inside the rim, a few stragglers)
      const a = R() * TAU, r = Math.pow(R(), 0.5) * (R() < 0.04 ? 1.3 : 1);
      MB[4 * i] = Math.cos(a) * r; MB[4 * i + 1] = Math.sin(a) * r * 0.75;
      MB[4 * i + 2] = (R() + R() + R() - 1.5) * 0.5; MB[4 * i + 3] = R() * TAU;
    }
  }
  const MUR = { I: 0, n: 0, x: 0, y: 0, rx: 0, ry: 0, day: -1, ok: false, onScreen: false, box: [0, 0, 0, 0], cued: -1e9, nDrawn: 0 };
  // where the starlings roost, by the river near campus: a point on the Olentangy chosen for the day
  const ROOSTS = [];
  for (const w of RIVER_LINES) for (let k = 0; k + 1 < w.pts.length; k += 2) {
    const x = w.pts[k], y = w.pts[k + 1];
    if (x < world.x0 + 150 || x > world.x1 - 150 || y < world.y0 + 150 || y > world.y1 - 150) continue;
    if (Math.hypot(x - ovalX, y - ovalY) > 1700) continue;
    if (ROOSTS.length && Math.hypot(x - ROOSTS[ROOSTS.length - 2], y - ROOSTS[ROOSTS.length - 1]) < 60) continue;
    ROOSTS.push(x, y);
  }
  function murmuration() {
    const W = app.weather || {}, M = MUR;
    M.I = 0;
    if (!ROOSTS.length) return M;
    if (DUSK) {
      if (M.day !== -2) {
        const [cx, cy] = view.centreGround();
        let best = Infinity;
        for (let k = 0; k < ROOSTS.length; k += 2) {
          const d = Math.hypot(ROOSTS[k] - cx, ROOSTS[k + 1] - cy);
          if (d < best) { best = d; M.rx = ROOSTS[k]; M.ry = ROOSTS[k + 1]; }
        }
        M.day = -2;
      }
      M.I = 1; M.desc = 0; M.arrive = 1;
      return M;
    }
    if (M.day !== C.day) {
      M.day = C.day;
      const doy = C.doy, h = hashInt(C.day, 0x5ea7);
      const p = doy >= 275 || doy <= 60 ? 0.6 : doy >= 245 || doy <= 80 ? 0.25 : 0;
      M.ok = hash01(h, 1) < p;
      const k = Math.floor(hash01(h, 2) * (ROOSTS.length / 2));
      M.rx = ROOSTS[2 * k]; M.ry = ROOSTS[2 * k + 1];
    }
    if (!M.ok || !Number.isFinite(W.sunAlt) || W.sunAz < 180) return M;
    if (C.storm || C.rain > 0.35 || C.snow > 0.5 || C.fog > 0.55) return M;
    const alt = W.sunAlt;
    M.arrive = smooth(5.5, 1.5, alt);
    M.desc = smooth(-3.2, -7, alt);
    M.I = M.arrive * (1 - smooth(0.55, 1, M.desc));
    return M;
  }
  function drawMurmuration(ctx, tau) {
    const M = MUR;
    M.onScreen = false; M.nDrawn = 0;
    if (M.I <= 0.01 || SCALE < SKY_MIN_S) return;
    const ph = M.rx * 0.013 + M.ry * 0.007;
    const desc = M.desc || 0, grow = 0.45 + 0.55 * Math.sqrt(M.arrive || 1), size = grow * (1 - 0.7 * desc);
    // the flock wanders over the river round its roost, swooping lower and higher
    const cx = M.rx + 70 * Math.sin(tau * 0.031 + ph) + 35 * Math.sin(tau * 0.083 + 2 * ph);
    const cy = M.ry + 55 * Math.cos(tau * 0.027 + ph) + 30 * Math.sin(tau * 0.071 + 3 * ph);
    const alt0 = (40 + 14 * Math.sin(tau * 0.05 + ph)) * (1 - 0.9 * desc) + 4;
    const yaw = tau * 0.085 + 1.5 * Math.sin(tau * 0.037 + ph), cyw = Math.cos(yaw), syw = Math.sin(yaw);
    const tilt = 0.25 + 1.15 * (0.5 + 0.5 * Math.sin(tau * 0.061 + 0.7 + ph)), ctl = Math.cos(tilt), stl = Math.sin(tilt);
    const Ls = 62 * (0.8 + 0.35 * Math.sin(tau * 0.043)) * size, Ws = 30 * (0.75 + 0.45 * Math.sin(tau * 0.057 + 2)) * size, Ts = 5 * size;
    const foldA = 20 * Math.sin(tau * 0.071 + 1) * size, twist = 1.4 * Math.sin(tau * 0.049 + 0.3), waveT = tau * 2.1;
    const n = Math.round(MN * Math.min(1, (M.arrive || 1) * 1.15) * (1 - smooth(0.4, 1, desc)));
    const ds = clamp(0.3 * SCALE + 1, 1.3, 2.6), h = ds / 2;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const W = app.weather || {};
    ctx.fillStyle = SKY_INK + (0.72 - 0.08 * (W.night || 0)).toFixed(3) + ")";
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      let u = MB[4 * i];
      const v = MB[4 * i + 1], w = MB[4 * i + 2], q = MB[4 * i + 3];
      // a wave of density rolling along the flock
      u += 0.16 * Math.sin(u * 3.1 - waveT + q * 0.15);
      const X = u * Ls;
      let Y = v * Ws, Z = w * Ts + foldA * Math.sin(u * 2.3 + tau * 0.9);
      const tw = twist * u, ct = Math.cos(tw), st = Math.sin(tw);
      let y2 = Y * ct - Z * st, z2 = Y * st + Z * ct;
      Y = y2 * ctl - z2 * stl; Z = y2 * stl + z2 * ctl;
      const gx = cx + X * cyw - Y * syw, gy = cy + X * syw + Y * cyw, gz = Math.max(2, alt0 + Z + 1.3 * Math.sin(tau * 1.7 + q));
      const px = PA * gx + PB * gy + PE, py = PC * gx + PD * gy + PF - PK * gz;
      MXY[2 * i] = px; MXY[2 * i + 1] = py;
      if (px < -4 || px > VW + 4 || py < -4 || py > VH + 4) continue;
      ctx.rect(px - h, py - h, ds, ds);
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
    }
    ctx.fill();
    M.nDrawn = n; M.x = cx; M.y = cy;
    if (x1 >= x0) {
      M.onScreen = true; M.box[0] = x0; M.box[1] = y0; M.box[2] = x1; M.box[3] = y1;
      if (performance.now() - M.cued > 120000) { M.cued = performance.now(); cue("flock", cx, cy); }
    }
  }
  // is the murmuration somewhere on screen (cheaply: its middle, with a generous margin)?
  function murmurationNear() {
    if (MUR.I <= 0.01 || SCALE < SKY_MIN_S) return false;
    return onView(MUR.rx, MUR.ry, 260, 40, 90);
  }

  // ---------------------------------------------------------------- Canada geese in a V
  const VSLOT = 90;   // s
  const VEE = { x: 0, y: 0, z: 0, ux: 0, uy: 0, n: 0, armL: 1, armR: 1, seed: 0, ok: false, hd: 0 };
  const VEES = [];    // drawn this frame (for clicks): {x, y, z, ux, uy, n, seed, hd, px[], py[]}
  for (let k = 0; k < 6; k++) VEES.push({ x: 0, y: 0, z: 0, ux: 0, uy: 0, n: 0, seed: 0, hd: 0, armL: 1, armR: 1, px: new Float32Array(32), py: new Float32Array(32), on: false });
  let forcedOrigin;
  const forcedAt = performance.now() / 1000;
  function veeParams(k, out) {
    const h = hashInt(k, 0x6ee5e), doy = C.doy;
    const autumn = doy >= 250 && doy <= 352, spring = doy >= 45 && doy <= 125;
    const p = autumn || spring ? 0.42 : 0.07;
    if (hash01(h, 1) >= p) return false;
    const W = app.weather || {};
    if (Number.isFinite(W.sunAlt) && W.sunAlt < -6) return false;
    if (C.storm || C.fog > 0.6 || C.snow > 0.6) return false;
    // heading: south-ish in the autumn, north-ish in the spring, anywhere otherwise (local geese commute too)
    const hdg = autumn ? 165 + 70 * hash01(h, 2) : spring ? -25 + 70 * hash01(h, 2) : 360 * hash01(h, 2);
    const rad = (hdg * Math.PI) / 180, ux = Math.sin(rad), uy = Math.cos(rad);
    const px = world.x0 + 600 + (world.x1 - world.x0 - 1200) * hash01(h, 3), py = world.y0 + 600 + (world.y1 - world.y0 - 1200) * hash01(h, 4);
    const speed = 17 + 3 * hash01(h, 5), age = simMs / 1000 - (k * VSLOT + hash01(h, 6) * VSLOT * 0.5);
    if (age < 0 || age * speed > 7000) return false;
    out.x = px - ux * 3500 + ux * speed * age; out.y = py - uy * 3500 + uy * speed * age;
    out.z = 110 + 120 * hash01(h, 7); out.ux = ux; out.uy = uy; out.hd = hdg;
    out.n = 7 + Math.floor(hash01(h, 8) * 16); out.seed = h; out.armL = 0.7 + 0.6 * hash01(h, 9); out.armR = 0.7 + 0.6 * hash01(h, 10);
    return true;
  }
  function forcedVee(out) {
    // ?birds=geese: across the middle of the view every 40 s
    const t = performance.now() / 1000 - forcedAt, age = (t % 40) + 1;
    const rad = (205 * Math.PI) / 180, ux = Math.sin(rad), uy = Math.cos(rad), speed = 18, z = 70;
    if (!forcedOrigin) forcedOrigin = view.screenToGround(VW / 2, VH / 2, z);
    out.x = forcedOrigin[0] + ux * speed * (age - 5);
    out.y = forcedOrigin[1] + uy * speed * (age - 5);
    out.z = z; out.ux = ux; out.uy = uy; out.hd = 205; out.n = 15; out.seed = 0xabc + Math.floor(t / 40); out.armL = 1.1; out.armR = 0.85;
    return true;
  }
  let nVees = 0;
  function collectVees() {
    nVees = 0;
    if (SCALE < VEE_MIN_S) return;
    const cur = Math.floor(simMs / 1000 / VSLOT);
    for (let k = cur - 5; k <= cur && nVees < VEES.length - 1; k++) {
      if (!veeParams(k, VEE)) continue;
      if (!onView(VEE.x, VEE.y, 40, 90, VEE.z + 10) && !onView(VEE.x - VEE.ux * 30, VEE.y - VEE.uy * 30, 40, 90, VEE.z + 10)) continue;
      Object.assign(VEES[nVees++], VEE);
    }
    if (VFORCE && forcedVee(VEE)) Object.assign(VEES[nVees++], VEE);
  }
  function drawVees(ctx, tau) {
    // px per metre for the birds and their spacing: zoomed out, the skein is drawn larger than life so it reads as a V
    const k = Math.max(SCALE, 4.5);
    ctx.strokeStyle = SKY_INK + "0.85)";
    ctx.lineWidth = Math.max(1, 0.16 * k);
    for (let v = 0; v < nVees; v++) {
      const V = VEES[v];
      V.on = false;
      const rx = V.uy, ry = -V.ux;   // to the right of the heading
      const Hx = ((PA * V.ux + PB * V.uy) / SCALE) * k, Hy = ((PC * V.ux + PD * V.uy) / SCALE) * k;
      const Rx = ((PA * rx + PB * ry) / SCALE) * k, Ry = ((PC * rx + PD * ry) / SCALE) * k, Zy = -COS_T * k;
      const lx = PA * V.x + PB * V.y + PE, ly = PC * V.x + PD * V.y + PF - PK * V.z;
      ctx.beginPath();
      for (let i = 0; i < V.n; i++) {
        const row = (i + 1) >> 1, sd = i === 0 ? 0 : i % 2 ? 1 : -1, arm = sd > 0 ? V.armR : V.armL;
        const back = row * 2.3 + Math.sin(tau * 0.5 + i * 1.3) * 0.35, lat = sd * row * 1.75 * arm + Math.sin(tau * 0.7 + i) * 0.25;
        const dz = Math.sin(tau * 0.9 + i) * 0.5;
        const px = lx - Hx * back + Rx * lat, py = ly - Hy * back + Ry * lat + Zy * dz;
        V.px[i] = px; V.py[i] = py;
        if (px < -20 || px > VW + 20 || py < -20 || py > VH + 20) continue;
        V.on = true;
        // wings: tip, wrist, body, wrist, tip, beating; then the body and the neck
        const a = 0.7 * Math.sin(tau * 2.2 * TAU + i * 0.8), ca = Math.cos(a), sa = Math.sin(a), c6 = Math.cos(a * 0.6), s6 = Math.sin(a * 0.6);
        const span = 0.8, el = 0.42;
        ctx.moveTo(px - Rx * span * ca, py - Ry * span * ca + Zy * span * sa);
        ctx.lineTo(px - Rx * el * c6, py - Ry * el * c6 + Zy * el * s6);
        ctx.lineTo(px, py);
        ctx.lineTo(px + Rx * el * c6, py + Ry * el * c6 + Zy * el * s6);
        ctx.lineTo(px + Rx * span * ca, py + Ry * span * ca + Zy * span * sa);
        ctx.moveTo(px - Hx * 0.45, py - Hy * 0.45);
        ctx.lineTo(px + Hx * 0.7, py + Hy * 0.7);
      }
      ctx.stroke();
    }
  }
  const veeCued = new Set();

  // ---------------------------------------------------------------- small birds going to roost (and leaving at dawn)
  let TGRID = null;
  function treeGrid() {
    if (TGRID) return TGRID;
    TGRID = new Array(GX * GY);
    const tr = data.trees;
    for (let t = 0; t < tr.length / 5; t++) { const c = cellOf(tr[5 * t], tr[5 * t + 1]); if (c >= 0) (TGRID[c] ||= []).push(t); }
    return TGRID;
  }
  const SMALL = [];   // events: tree, t0 (ms), dur (s), n, sx, sy, sz, ex, ey, ez, dawn, seed
  for (let k = 0; k < 40; k++) SMALL.push({ t: 0, t0: 0, dur: 0, n: 0, sx: 0, sy: 0, sz: 0, ex: 0, ey: 0, ez: 0, dawn: false, seed: 0, cued: false });
  let nSmall = 0, smallAt = -1e9, roostI = 0, roostDawn = false;
  const SMXY = new Float32Array(40 * 5 * 2);
  let nSmXY = 0;
  function roostIntensity() {
    const W = app.weather || {};
    if (!Number.isFinite(W.sunAlt) || C.storm || C.rain > 0.5) return 0;
    const alt = W.sunAlt;
    if (W.sunAz >= 180) { roostDawn = false; return smooth(4, 0.5, alt) * (1 - smooth(-4.5, -7, alt)); }
    roostDawn = true;
    return smooth(-6.5, -3, alt) * (1 - smooth(2, 5, alt)) * 0.8;
  }
  function collectSmall() {
    const now = simMs;
    if (now - smallAt < 500 && now >= smallAt) return;
    smallAt = now;
    nSmall = 0;
    roostI = DUSK ? Math.max(roostIntensity(), 0.7) : roostIntensity();
    if (roostI <= 0.01 || SCALE < SMALL_MIN_S) return;
    const G = treeGrid(), vb = viewGround(30), tr = data.trees;
    const i0 = Math.max(0, Math.floor((vb[0] - world.x0) / GC)), i1 = Math.min(GX - 1, Math.floor((vb[2] - world.x0) / GC));
    const j0 = Math.max(0, Math.floor((vb[1] - world.y0) / GC)), j1 = Math.min(GY - 1, Math.floor((vb[3] - world.y0) / GC));
    const SLOTMS = 20000, cur = Math.floor(now / SLOTMS);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const L = G[j * GX + i];
      if (!L) continue;
      for (const t of L) {
        const x = tr[5 * t], y = tr[5 * t + 1];
        if (!onView(x, y, 2, 10, 20)) continue;
        const bare = renderer.treeBare(t, app.tileStyle);
        for (let sl = cur - 1; sl <= cur; sl++) {
          const h = hashInt(t * 7 + 3, sl);
          if (hash01(h, 1) >= 0.3 * roostI * (bare ? 0.5 : 1)) continue;
          const t0 = sl * SLOTMS + hash01(h, 2) * SLOTMS, n = 1 + Math.floor(hash01(h, 4) * 4), dur = 3.5 + 3 * hash01(h, 3);
          if (now < t0 || now > t0 + (dur + n * 0.35) * 1000) continue;
          if (nSmall >= SMALL.length) break;
          const ang = hash01(h, 5) * TAU, dist = 22 + 26 * hash01(h, 6), th = tr[5 * t + 3], rad = tr[5 * t + 2];
          // a crown hidden behind a building is no place to watch them land
          if (pointHidden(x, y, th - rad * 0.6)) continue;
          const E = SMALL[nSmall++];
          E.t = t; E.t0 = t0; E.dur = dur; E.n = n; E.dawn = roostDawn; E.seed = h;
          E.sx = x + Math.cos(ang) * dist; E.sy = y + Math.sin(ang) * dist; E.sz = th + 5 + 9 * hash01(h, 7);
          E.ex = x + (hash01(h, 8) - 0.5) * rad * 0.6; E.ey = y + (hash01(h, 9) - 0.5) * rad * 0.6; E.ez = Math.max(2, th - rad * 0.7);
          E.cued = false;
        }
      }
    }
  }
  let chirpAt = -1e9;
  function drawSmall(ctx) {
    nSmXY = 0;
    if (!nSmall) return 0;
    const now = simMs, k = Math.max(SCALE, 9), lw = Math.max(0.9, 0.045 * k);
    let n = 0;
    ctx.strokeStyle = SKY_INK + "0.8)";
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (let e = 0; e < nSmall; e++) {
      const E = SMALL[e];
      for (let j = 0; j < E.n; j++) {
        let s = (now - E.t0) / 1000 / E.dur - j * 0.35 / E.dur;
        if (s < 0 || s > 1) continue;
        if (E.dawn) s = 1 - s;   // leaving: the same flight backwards
        const lat = (hash01(E.seed, 20 + j) - 0.5) * 3 * (1 - s);
        const dx = E.ex - E.sx, dy = E.ey - E.sy, L = Math.hypot(dx, dy) || 1;
        const x = E.sx + dx * s - (dy / L) * lat, y = E.sy + dy * s + (dx / L) * lat;
        // a bounding flight: a few beats up, a glide down
        const z = E.sz + (E.ez - E.sz) * smooth(0, 1, s) + Math.sin(s * Math.PI * 5 + j) * 0.5 * (1 - s);
        const px = PA * x + PB * y + PE, py = PC * x + PD * y + PF - PK * z;
        if (px < -10 || px > VW + 10 || py < -10 || py > VH + 10) continue;
        // into the crown at the end (out of it at dawn): fade by shrinking
        const fade = 1 - smooth(0.82, 1, s), span = 0.16 * k * fade, beat = Math.sin((now / 1000) * 30 + j * 2 + E.t) * 0.9;
        if (span < 0.3) continue;
        const hx = ((PA * dx + PB * dy) / L / SCALE) * span * 0.6, hy = ((PC * dx + PD * dy) / L / SCALE) * span * 0.6;
        ctx.moveTo(px - span, py - span * beat * 0.8);
        ctx.quadraticCurveTo(px - span * 0.4, py - span * 0.35, px, py);
        ctx.quadraticCurveTo(px + span * 0.4, py - span * 0.35, px + span, py - span * beat * 0.8);
        ctx.moveTo(px - hx * 0.3, py - hy * 0.3); ctx.lineTo(px + hx * 0.5, py + hy * 0.5);
        if (nSmXY < SMXY.length / 2) { SMXY[2 * nSmXY] = px; SMXY[2 * nSmXY + 1] = py; nSmXY++; }
        n++;
        if (!E.cued) { E.cued = true; if (performance.now() - chirpAt > 4000) { chirpAt = performance.now(); cue("chirp", x, y); } }
      }
    }
    ctx.stroke();
    return n;
  }

  // ---------------------------------------------------------------- the sky layer
  let skyWant = 0;
  function drawSky(ctx) {
    skyWant = 0;
    if (failed || !wild()) { app.whimsy.flock = 0; return; }
    setCamera();
    const tau = performance.now() / 1000;
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    let flock = 0;
    murmuration();
    drawMurmuration(ctx, tau);
    if (MUR.onScreen) { flock = Math.max(flock, MUR.I); skyWant = Math.max(skyWant, SCALE >= 1 ? 24 : 15); }
    collectVees();
    if (nVees) {
      drawVees(ctx, tau);
      for (let v = 0; v < nVees; v++) if (VEES[v].on) {
        // zoomed out a skein crawls across the screen: its wingbeats read fine at 12 fps
        flock = Math.max(flock, 0.55); skyWant = Math.max(skyWant, SCALE >= 2 ? 24 : 12);
        const key = VEES[v].seed;
        if (!veeCued.has(key)) { veeCued.add(key); if (veeCued.size > 64) veeCued.clear(); cue("honk", VEES[v].x, VEES[v].y); }
      }
    }
    collectSmall();
    const ns = drawSmall(ctx);
    if (ns) { flock = Math.max(flock, Math.min(0.4, ns / 25)); skyWant = Math.max(skyWant, 20); }
    ctx.restore();
    app.whimsy.flock = +flock.toFixed(3);
    if (reduceMQ.matches) skyWant = 0;
  }

  // ================================================================================================ clicks and cards
  function hitWaterfowl(px, py) {
    if (!wild() || SCALE < MIN_S) return null;
    let best = null, bd = Infinity;
    for (let q = 0; q < nVis; q++) {
      const b = vis[q];
      if (b.sx < -1e3) continue;
      const cy = b.sy - b.sr * 0.6, r = Math.max(10, b.sr + 4), d = Math.hypot(px - b.sx, py - cy);
      if (d < r && d < bd) { bd = d; best = b; }
    }
    return best ? { kind: "bird", b: best } : null;
  }
  function hitSky(px, py) {
    if (!wild()) return null;
    for (let v = 0; v < nVees; v++) {
      const V = VEES[v];
      if (!V.on) continue;
      for (let i = 0; i < V.n; i++) if (Math.hypot(px - V.px[i], py - V.py[i]) < 12) return { kind: "vee", V: { ...V, px: null, py: null } };
    }
    for (let i = 0; i < nSmXY; i++) if (Math.hypot(px - SMXY[2 * i], py - SMXY[2 * i + 1]) < 11) return { kind: "small", dawn: roostDawn };
    const M = MUR;
    if (M.onScreen && px > M.box[0] - 12 && px < M.box[2] + 12 && py > M.box[1] - 12 && py < M.box[3] + 12) {
      for (let i = 0; i < M.nDrawn; i++) if (Math.abs(px - MXY[2 * i]) < 12 && Math.abs(py - MXY[2 * i + 1]) < 12) return { kind: "flock" };
    }
    return null;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  function doingOf(b) {
    const G = b.G, W = app.weather || {};
    if (b.act === FLY) { const s = b.ft / b.fT; return s < 0.25 ? "taking off" : s > 0.75 ? "coming in to land" : "flying"; }
    if (b.follow >= 0 && (b.act === SWIM || b.act === WALK)) return b.sp === GOOSE ? "bringing up the rear" : G.kind === G_BROOD ? "following Mum, in a line" : "following the family, in a line";
    if (b.act === WALK && isGeese(G) && G.birds.length > 2) return "walking in single file";
    if (b.act === IDLE && b.onW) return (W.windMph || 0) >= 5 ? "drifting on the breeze" : "floating, thinking about nothing";
    if (b.act === IDLE) return "standing about";
    if (b.act === SLEEP) return b.onW ? "asleep on the water, head tucked under a wing" : "asleep, head tucked under a wing";
    if (b.act === REST && b.onW) return "resting";
    return ACT_NAMES[b.act];
  }
  const NOTES = {
    [DRAKE]: [
      "Only the hens give the loud, classic quack; drakes make a quieter, raspier call.",
      "The green head is iridescent: in flat light it can look almost black.",
      "Dabbling ducks feed tail-up, tipping forward for plants just under the surface rather than diving.",
    ],
    [HEN]: [
      "Hens wear mottled brown: good camouflage on a nest.",
      "That loud, classic quack-quack-quack? That's the hens.",
      "Dabbling ducks feed tail-up, tipping forward for plants just under the surface rather than diving.",
    ],
    [DUCKLING]: ["Ducklings leave the nest within a day of hatching and stick close to their mother."],
    [GOOSE]: [
      "The white chinstrap on a black head and neck is the giveaway.",
      "Canada geese graze lawns as happily as they swim.",
      "Goose families stay together through their first winter.",
    ],
    [GOSLING]: ["Goslings can swim and feed themselves within a day or so of hatching; both parents stand guard."],
  };
  const ASIDES = {
    duck: ["Opinion of the weather: unbothered.", "Calm on top, paddling hard underneath.", "Would accept peas or oats. Please, not bread."],
    goose: ["Keeps one eye on you at all times.", "Treats every lawn as a salad bar.", "Will hiss if you get too close. Fair enough."],
  };
  function birdCard(b) {
    const G = b.G, sp = b.sp, geese = sp >= GOOSE;
    const title = sp === DRAKE && b.look === ECLIPSE ? "Mallard" : SPECIES[sp];
    const who = sp === DRAKE ? (b.look === ECLIPSE ? "Drake (in his drab summer moult)" : "Drake") : sp === HEN ? "Hen" : "";
    const where = G.B.name.charAt(0).toUpperCase() + G.B.name.slice(1);
    const notes = NOTES[sp], note = notes[b.name % notes.length], aside = (geese ? ASIDES.goose : ASIDES.duck)[(b.name >>> 4) % 3];
    const body = document.createElement("div");
    body.className = "birds-card";
    body.innerHTML = `<div class="birds-now">Currently: <b>${esc(doingOf(b))}</b>.</div>` +
      `<p class="birds-note">${esc(note)}</p>` + (sp === DUCKLING || sp === GOSLING ? "" : `<p class="birds-aside">${esc(aside)}</p>`) +
      `<div class="birds-sim">Simulated — not a live sighting.</div>`;
    return { id: "birds", title, subtitle: who ? `${who} · ${where}` : where, body, anchor: { x: b.x, y: b.y, z: b.z + 0.4 } };
  }
  function onClick(target) {
    if (!target || !app.ui || !app.ui.card) return;
    let c = null;
    if (target.kind === "bird") {
      const b = target.b;
      c = birdCard(b);
      cue(b.sp >= GOOSE ? "honk" : "quack", b.x, b.y);
    } else if (target.kind === "flock") {
      const n = MUR.nDrawn, body = document.createElement("div");
      body.className = "birds-card";
      body.innerHTML = `<div class="birds-now">About <b>${esc(n)}</b> European starlings, wheeling as one before they drop into a roost for the night.</div>` +
        `<p class="birds-note">Each bird keeps track of only its nearest half-dozen or so neighbours; the whole shape comes out of that.</p>` +
        `<div class="birds-sim">Simulated — winter flocks like this gather at dusk, but this one isn't a live sighting.</div>`;
      c = { id: "birds", title: "Starling murmuration", subtitle: "Over the Olentangy, at dusk", body, anchor: { x: MUR.x, y: MUR.y, z: 50 } };
      cue("flock", MUR.x, MUR.y);
    } else if (target.kind === "vee") {
      const V = target.V, body = document.createElement("div");
      body.className = "birds-card";
      const dir = COMPASS[Math.round((((V.hd % 360) + 360) % 360) / 45) % 8];
      body.innerHTML = `<div class="birds-now">A skein of <b>${esc(V.n)}</b> Canada geese, heading ${esc(dir)}.</div>` +
        `<p class="birds-note">In a V each goose rides the lift off the wingtip of the one ahead, and they take turns at the front. You usually hear them first.</p>` +
        `<div class="birds-sim">Simulated — not a live sighting.</div>`;
      c = { id: "birds", title: "Canada geese", subtitle: "Passing over", body, anchor: { x: V.x, y: V.y, z: V.z } };
      cue("honk", V.x, V.y);
    } else if (target.kind === "small") {
      const body = document.createElement("div");
      body.className = "birds-card";
      body.innerHTML = target.dawn
        ? `<div class="birds-now">Small birds leaving their roost for the day.</div><p class="birds-note">First stop: breakfast.</p>`
        : `<div class="birds-now">Small birds heading in to roost for the night.</div><p class="birds-note">Thick trees and evergreens keep them out of the wind and harder for owls to find.</p>`;
      body.innerHTML += `<div class="birds-sim">Simulated — not a live sighting.</div>`;
      c = { id: "birds", title: target.dawn ? "Up and out" : "Off to roost", subtitle: target.dawn ? "Dawn" : "Dusk", body, anchor: null };
      cue("chirp", 0, 0);
    }
    if (c) app.ui.card(c);
  }

  // ================================================================================================ wiring
  app.on("frame", (f) => {
    if (failed) return;
    try {
      tickClock(f.dt);
      if (!wild()) return;
      manage(false);
      if (!reduceMQ.matches) stepAll(f.dt);
    } catch (e) {
      failed = true; near.length = 0;
      console.error("birds: stopped", e);
    }
  });
  // with the map asleep, a group taking off or a V coming over still has to wake it
  setInterval(() => {
    if (failed || document.hidden || !wild()) return;
    try {
      manage(false);
      setCamera();
      readConditions();
      let wake = false;
      for (const G of near) if (G.live && simMs >= G.flyAt && onView(G.ax, G.ay, 30, 0)) wake = true;
      if (!wake) { murmuration(); wake = murmurationNear(); }
      if (!wake) { collectVees(); wake = nVees > 0; }
      if (!wake && SCALE >= SMALL_MIN_S) { smallAt = -1e9; collectSmall(); wake = nSmall > 0; }
      if (wake) app.requestRender("birds");
    } catch (e) { failed = true; console.error("birds: stopped", e); }
  }, 1000);
  app.on("layers", (p) => {
    if (p && p.id === "wildlife") {
      if (!p.on) { for (const G of near) { G.live = false; G.birds.length = 0; } app.whimsy.waterfowl = 0; app.whimsy.flock = 0; nVis = 0; nVees = 0; nSmall = 0; MUR.onScreen = false; }
      tickAt = -1e9; app.requestRender("birds");
    }
  });
  app.on("weather", () => { condAt = -1e9; });
  app.on("rotate", () => { for (const B of bodies) for (const G of B.groups) { G.occR = -1; G.hidR = -1; for (const b of G.birds) b.nOcc = -1; } });

  app.addLayer({
    id: "waterfowl", z: 31,
    fps: () => (wild() ? wfWant : 0),
    draw: (ctx) => drawWaterfowl(ctx),
    hit: (px, py) => hitWaterfowl(px, py),
    onClick: (t) => onClick(t),
  });
  app.addLayer({
    id: "birds-sky", z: 85.5,
    fps: () => (wild() ? skyWant : 0),
    draw: (ctx) => drawSky(ctx),
    hit: (px, py) => hitSky(px, py),
    onClick: (t) => onClick(t),
  });

  app.birds = {
    get waterfowl() { return wfCount; },
    get flock() { return app.whimsy.flock || 0; },
    debug: {
      conditions: C,
      bodies: () => bodies.map((B) => ({ name: B.name, kind: B.kind, built: B.built, groups: B.groups.length })),
      // the waterfowl near the view: what, where (ground and CSS px), doing what
      list() {
        const out = [];
        for (const G of near) if (G.live) for (const b of G.birds) out.push({ sp: SPECIES[b.sp], act: ACT_NAMES[b.act], onW: b.onW, x: +b.x.toFixed(1), y: +b.y.toFixed(1), px: Math.round(b.sx), py: Math.round(b.sy), plan: G.plan, kind: G.kind });
        return out;
      },
      groups: () => near.filter((G) => G.live).map((G) => { const [lat, lon] = geo.toLatLon(G.ax, G.ay); return { kind: G.kind, plan: G.plan, n: G.birds.length, lat: +lat.toFixed(6), lon: +lon.toFixed(6), body: G.B.name }; }),
      // open the card of the i-th waterfowl on screen
      click(i = 0) { const L = vis.filter((b) => b.sx > -1e3); if (L[i]) onClick({ kind: "bird", b: L[i] }); return L.length; },
      clickFlock() { if (MUR.onScreen) onClick({ kind: "flock" }); return MUR.onScreen; },
      murmuration: () => ({ I: MUR.I, onScreen: MUR.onScreen, n: MUR.nDrawn, ok: MUR.ok, x: MUR.rx, y: MUR.ry }),
    },
  };
  Object.defineProperty(app.birds, "debug", { enumerable: false });
}

// ------------------------------------------------------------------------------------------------ helpers
function injectStyle() {
  if (document.getElementById("birds-style")) return;
  const st = document.createElement("style");
  st.id = "birds-style";
  st.textContent = `
.birds-card { font: 13px/1.45 "Inter", system-ui, sans-serif; color: var(--text, #3a352e); }
.birds-card .birds-now { margin: 0 0 6px; }
.birds-card .birds-now b { font-weight: 600; color: var(--ink, #2a2622); }
.birds-card .birds-note { margin: 0 0 6px; }
.birds-card .birds-aside { margin: 0 0 6px; font-family: "Fraunces", Georgia, serif; font-style: italic; color: var(--mute, #7a7064); }
.birds-card .birds-sim { font-size: 11px; color: var(--mute, #7a7064); letter-spacing: .01em; }
body[data-ui="dark"] .birds-card .birds-now b { color: inherit; }
`;
  document.head.appendChild(st);
}
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function smooth(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
function segDist(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / L, 0, 1) : 0;
  return Math.hypot(x - ax - dx * t, y - ay - dy * t);
}
// chamfer distances (2 along a row or column, 3 diagonally) from each nonzero cell to the nearest zero one; past the
// grid's edge counts as `edge`
function chamfer(A, nx, ny, edge) {
  const E = edge;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    if (A[k] === 0) continue;
    let d = A[k];
    const l = i > 0 ? A[k - 1] : E, u = j > 0 ? A[k - nx] : E, ul = i > 0 && j > 0 ? A[k - nx - 1] : E, ur = i < nx - 1 && j > 0 ? A[k - nx + 1] : E;
    if (l + 2 < d) d = l + 2; if (u + 2 < d) d = u + 2; if (ul + 3 < d) d = ul + 3; if (ur + 3 < d) d = ur + 3;
    A[k] = d;
  }
  for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const k = j * nx + i;
    if (A[k] === 0) continue;
    let d = A[k];
    const r = i < nx - 1 ? A[k + 1] : E, dn = j < ny - 1 ? A[k + nx] : E, dr = i < nx - 1 && j < ny - 1 ? A[k + nx + 1] : E, dl = i > 0 && j < ny - 1 ? A[k + nx - 1] : E;
    if (r + 2 < d) d = r + 2; if (dn + 2 < d) d = dn + 2; if (dr + 3 < d) d = dr + 3; if (dl + 3 < d) d = dl + 3;
    A[k] = d;
  }
}
function hashInt(a, b) {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}
function hash01(a, b) { return hashInt(a, b) / 4294967296; }
function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
