// Pickup games: people playing on the courts, the quads, the ovals and the fields.
//
// None of this is live data. Courts and lawns host small simulated games whose numbers follow the campus clock (after
// class and weekend afternoons are busiest, nobody plays in the dark), the season and the weather (rain empties them;
// the cold thins the sand courts first and the basketball courts last; snow on the ground closes the courts but not
// the lawns): volleyball on the volleyball courts (hard courts and sand), basketball on the basketball courts (a
// shootaround, a half-court game at one basket or a full-court game), tennis or pickleball on the tennis courts
// (singles or doubles), and on the quads, the ovals and the fields people throwing a football or a frisbee or playing
// spikeball; a whole field may host a game of ultimate or of touch football instead.
//
// Each venue's schedule comes from the clock alone (a hash of the venue and the hour it is in), so a court is busy or
// empty the same way whenever it comes back into view, and for everyone; who plays and how is drawn from the same hash.
// Only the venues near the view are simulated. A game that starts or ends in plain view fades in or out.
//
// Lawns are searched for room the first time one comes near the view: a grid of 2 m cells less the paths, roads,
// fences, trees, lamps, buildings and whatever else lies on the lawn (flower beds, plazas, water, courts), and each
// cell's distance to the nearest of those. A line of clear cells takes people throwing to each other; a clear disc of
// a few metres takes a spikeball net.
//
// Drawing ("courts", z 34: under the walkers and the night tint): the players as life.js draws walkers (a few fills
// each from afar; with arms, rackets and poses close up), the ball and its shadow, and the gear that stands up off a
// court: basketball hoops and volleyball nets (the tiles paint the lines; these are drawn here so that players stand in
// front of or behind them, and they stay when People is switched off), and a spikeball net that comes with its game.
// The players are people: the People switch shows and hides them with the walkers. Everything is drawn back to front;
// close up, whatever stands in front of a thing (a building, a tree, a lamp post) is left showing by clipping its
// outline out of the drawing, as life.js does for walkers; from afar a player behind a building is simply not drawn.
import { obbOf } from "../core/render.js";
import { pointIn } from "../core/scene.js";
import { SKIN, HAIR, localTime, curve, makeRecorder } from "./life.js";

// ------------------------------------------------------------------------------------------------ tables
const SIM_S = 1.6;      // games are simulated from this scale (CSS px per metre) up…
const MIN_S = 2;        // …drawn from here, as the walkers are…
const DETAIL_S = 10;    // …with arms, rackets and the ball's shadow from here
const GEAR_S = 2.5;     // hoops and volleyball nets from here
const FADE = 0.9;       // seconds: a game starting or ending in plain view fades in or out
const OVAL = [39.9995, -83.0148];
const LAWN_NAME = /\b(oval|quad|quadrangle|green|lawn|commons|mall)\b/i;
const FIELD_SP = /soccer|american_football|multi|lacrosse|rugby/;
// areas a lawn game can stand on; any other area on a lawn (a flower bed, a plaza, a pond, a court) is in the way
const OPEN = new Set(["grass", "park", "meadow", "campus", "res", "com", "rel", "ind"]);
// the share of each kind of venue in use at the busiest hour, and how warm it has to be (°F: nobody below, all from)
const KINDS = {
  sand: { busy: 0.5, warm: [52, 75] },      // beach volleyball
  volley: { busy: 0.4, warm: [45, 65] },    // volleyball on a hard court
  tennis: { busy: 0.55, warm: [38, 60] },   // tennis or pickleball
  full: { busy: 0.22, warm: [34, 56] },     // full-court basketball
  half: { busy: 0.5, warm: [30, 55] },      // a game or a shootaround at one basket
  lawn: { busy: 0.3, warm: [34, 60] },      // a football, a frisbee, spikeball
  field: { busy: 0.26, warm: [38, 62] },    // ultimate or touch football on a whole field
};
// …through the day (local hours)
const ACT_WEEKDAY = [[0, 0], [7, 0], [8, 0.06], [10, 0.14], [12, 0.32], [14, 0.38], [16, 0.62], [17.5, 0.9], [19, 0.85], [20.5, 0.4], [22, 0], [24, 0]];
const ACT_WEEKEND = [[0, 0], [8, 0], [9.5, 0.2], [11, 0.55], [13, 0.85], [16, 0.9], [18, 0.7], [20, 0.35], [22, 0], [24, 0]];
// a typical afternoon by season (°F), when the live reading doesn't apply (another date with ?time=, test weather)
const CLIMATE = { winter: 36, spring: 62, summer: 82, autumn: 64, "late-autumn": 48 };

// what they wear: team shirts (one light, one dark), their own shirts, or in the cold jackets and trousers
const TEAM_LIGHT = ["#f2efe8", "#d8d2c4", "#8fb3d3", "#e3c45a", "#a3a6ab"];
const TEAM_DARK = ["#b3202a", "#2f3e5c", "#3a3d44", "#4f7a55", "#1f2226", "#c75b39"];
const SHIRTS = ["#b3202a", "#b3202a", "#f2efe8", "#f2efe8", "#a3a6ab", "#3a3d44", "#2f3e5c", "#8fb3d3", "#4f7a55", "#e3c45a", "#c75b39", "#6d6e71", "#d8d2c4", "#7a5d8f"];
const JACKETS = ["#b3202a", "#b3202a", "#6d6e71", "#2f3036", "#2f3e5c", "#4d6a8f", "#5f6b4a", "#b59a72", "#7b2d3a", "#3f7f86"];
const SHORTS = ["#2a2a2e", "#2f3a52", "#5b5e66", "#3b4b6b", "#1f2226", "#6d6e71"];
const TROUSERS = ["#34445e", "#2b2b30", "#55585e", "#3b4b6b", "#4a4d55"];
// balls: [colour, radius m]
const BALLS = {
  volley: ["#f6f1e4", 0.11], hoops: ["#d0632b", 0.12], tennis: ["#d6e353", 0.035], pickle: ["#f2d33a", 0.037],
  football: ["#7a4a2a", 0.11], frisbee: ["#f4f1ea", 0.14], spike: ["#f2cf2f", 0.05],
};
const SHADOW = "#26323c";
// poses
const READY = 0, REACH = 1, THROW = 2, BUMP = 3, DRIBBLE = 4, HOLD = 5, SWING = 6, SPIKE = 7;
// the ball: nowhere, in someone's hands, in the air, loose on the ground
const NONE = 0, HELD = 1, FLY = 2, LOOSE = 3;

// ------------------------------------------------------------------------------------------------ the module
export function init(app) {
  const { data, geo, view, renderer } = app;
  if (!data || !data.areas || !data.world) return;
  const { SIN_T, COS_T } = geo;
  const world = data.world;
  const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");
  // ?sports=all: every venue busy, whatever the hour and the weather (for screenshots and tests)
  const ALL = (app.params.get("sports") || "").trim().toLowerCase() === "all";
  const [ovalX, ovalY] = geo.toXY(OVAL[0], OVAL[1]);

  // ---------------------------------------------------------------- per-frame camera (CSS px from ground metres)
  // px = PA·x + PB·y + PE,  py = PC·x + PD·y + PF − PK·z  (as life.js)
  let PA = 0, PB = 0, PC = 0, PD = 0, PE = 0, PF = 0, PK = 0, VW = 1, VH = 1, SCALE = 1, ROT = 0, D0 = 0, D1 = 0;
  // the same camera for renderer.silhouette (CSS px = X·k − ox), and the tiles' level of detail, so outlines match them
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
  // the venue (or its surroundings, margin px) on screen?
  function onView(x, y, rad, margin) {
    const px = PA * x + PB * y + PE, py = PC * x + PD * y + PF, m = margin + rad * SCALE;
    return px > -m && px < VW + m && py > -m - 5 * PK && py < VH + m;
  }

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
  const ringBox = (f) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < f.length; k += 2) { if (f[k] < x0) x0 = f[k]; if (f[k] > x1) x1 = f[k]; if (f[k + 1] < y0) y0 = f[k + 1]; if (f[k + 1] > y1) y1 = f[k + 1]; }
    return [x0, y0, x1, y1];
  };
  // buildings, for telling an indoor court from an outdoor one (and, later, a lawn's room)
  const bGrid = new Array(GX * GY), bBox = new Float32Array(data.buildings.length * 4);
  data.buildings.forEach((b, i) => {
    const bb = ringBox(b.p[0]);
    bBox.set(bb, 4 * i);
    gridAdd(bGrid, i, bb[0], bb[1], bb[2], bb[3]);
  });
  function indoors(x, y) {
    const c = cellOf(x, y), L = c < 0 ? null : bGrid[c];
    if (!L) return false;
    for (const i of L) {
      if (x < bBox[4 * i] || x > bBox[4 * i + 2] || y < bBox[4 * i + 1] || y > bBox[4 * i + 3]) continue;
      if (app.scene.contains(i, x, y)) return true;
    }
    return false;
  }
  const inRings = (rings, x, y) => { let n = false; for (const f of rings) if (pointIn(f, x, y)) n = !n; return n; };

  // ================================================================================================ venues
  // A venue is a court, one end of a basketball court, a spot on a lawn or a whole field, in its own frame: u along
  // its length, v across, from its centre (ground = centre + u·(ca, sa) + v·(−sa, ca)). L × W: the lines (or the room
  // on a lawn); ru × rv: half the room around them. A venue with a parent (an end of a court, a spot on a field) is
  // free only while its parent isn't in use.
  const venues = [], lawns = [];
  function venue(kind, area, sub, o, L, W, ru, rv, extra) {
    const seed = hashInt(area * 64 + sub, 0x5bd1);
    const V = {
      kind, area, cx: o.cx, cy: o.cy, ang: o.ang, ca: Math.cos(o.ang), sa: Math.sin(o.ang), L, W, ru, rv, rad: Math.hypot(ru, rv),
      parent: null, seed, slotMin: 40 + 40 * hash01(seed, 1), off: 0, central: 1, p: 0, game: null, seen: false,
      occR: -1, occ: null, hidR: -1, hid: false,
    };
    V.off = hash01(seed, 2) * V.slotMin;
    const d2 = (V.cx - ovalX) ** 2 + (V.cy - ovalY) ** 2;
    // the campus round the Oval is busier than the neighbourhoods
    V.central = 0.35 + 0.65 * Math.exp(-d2 / (1300 * 1300));
    if (extra) Object.assign(V, extra);
    venues.push(V);
    return V;
  }
  const at = (o, u, v) => ({ cx: o.cx + u * Math.cos(o.ang) - v * Math.sin(o.ang), cy: o.cy + u * Math.sin(o.ang) + v * Math.cos(o.ang), ang: o.ang });
  const stands = data.buildings.filter((b) => b.k === "grandstand" || b.k === "stadium");
  // a field with stands beside it is a varsity venue (behind a fence)
  function varsity(o) {
    const c = Math.cos(o.ang), s = Math.sin(o.ang);
    for (const b of stands) {
      const f = b.p[0];
      for (let k = 0; k < f.length; k += 2) {
        const dx = f[k] - o.cx, dy = f[k + 1] - o.cy, u = dx * c + dy * s, v = -dx * s + dy * c;
        if (Math.hypot(Math.max(0, Math.abs(u) - o.L / 2), Math.max(0, Math.abs(v) - o.W / 2)) < 20) return true;
      }
    }
    return false;
  }
  data.areas.forEach((a, i) => {
    const k = a.k, sp = a.sp || "";
    if (k === "court" || k === "pitch") {
      const o = obbOf(a.p[0]);
      if (!o || indoors(o.cx, o.cy)) return;
      if (sp.includes("volleyball")) {
        // as render.js lines them: one court in the middle
        const sand = sp.includes("beach") || a.su === "sand";
        const l = Math.min(sand ? 16 : 18, o.L - 2), w = Math.min(sand ? 8 : 9, o.W - 2);
        if (l >= 8 && w >= 4) venue(sand ? "sand" : "volley", i, 0, o, l, w, o.L / 2, o.W / 2, { sand });
      } else if (k === "court" && (sp.includes("tennis") || sp.includes("pickleball"))) {
        // as render.js fits them: along whichever axis fits 36.6 m best, side by side across the other
        const alongL = Math.abs(o.L - 36.6) <= Math.abs(o.W - 36.6) || o.W < 15;
        const len = alongL ? o.L : o.W, wid = alongL ? o.W : o.L, n = Math.max(1, Math.round(wid / 18.3));
        const ang = alongL ? o.ang : o.ang + Math.PI / 2, cl = Math.min(23.77, len * 0.72), cw = Math.min(10.97, (wid / n) * 0.66);
        for (let c = 0; c < n; c++) {
          const y = -wid / 2 + (wid / n) * (c + 0.5);
          venue("tennis", i, c, at({ cx: o.cx, cy: o.cy, ang }, 0, y), cl, cw, len / 2, wid / n / 2, { pickle: !sp.includes("tennis") });
        }
      } else if (k === "court" && sp.includes("basketball")) {
        const cl = Math.min(28, o.L - 1), cw = Math.min(15, o.W - 1);
        if (cl < 10 || cw < 6) return;
        // the court (its hoops, and full-court games) and an end of it at each basket (half-court games); a small one
        // is played at one end only
        const small = cl < 19, court = venue("full", i, 0, o, cl, cw, o.L / 2, o.W / 2, { small, hoops: true });
        const ends = small ? [hash01(court.seed, 3) < 0.5 ? -1 : 1] : [-1, 1];
        for (const e of ends) venue("half", i, e < 0 ? 1 : 2, o, cl, cw, o.L / 2, o.W / 2, { hoop: e, parent: court });
      } else if (k === "pitch" && FIELD_SP.test(sp) && !/stadium|varsity/i.test(a.n || "") && !varsity(o)) {
        // a whole field: ultimate or touch football; or, while it isn't in use, a few groups on spots of it
        const field = o.L >= 55 && o.W >= 30 ? venue("field", i, 0, o, Math.min(o.L - 6, 100), Math.min(o.W - 6, 37), o.L / 2, o.W / 2) : null;
        lawns.push(lawnRecord(i, field));
      }
      return;
    }
    if ((k === "park" || k === "grass") && a.n && LAWN_NAME.test(a.n)) lawns.push(lawnRecord(i, null));
  });
  function lawnRecord(i, field) {
    const [x0, y0, x1, y1] = ringBox(data.areas[i].p[0]);
    return { area: i, field, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, rad: Math.hypot(x1 - x0, y1 - y0) / 2, box: [x0, y0, x1, y1], done: false };
  }

  // ---------------------------------------------------------------- room on a lawn
  let OBS = null;
  // everything that stands or lies on a lawn and is in the way of a game, in grids (built the first time it's needed)
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
    for (const p of data.paths) if (!p.tn) addLine(p.pts, (p.w || 2) / 2 + 1.2);
    for (const r of data.roads) if (!r.tn) addLine(r.pts, (r.w || 6) / 2 + 2);
    for (const b of data.barriers || []) addLine(b.pts, 0.9);
    const tr = data.trees, tGrid = new Array(GX * GY);
    for (let t = 0; t < tr.length / 5; t++) { const x = tr[5 * t], y = tr[5 * t + 1], r = tr[5 * t + 2] + 0.6; gridAdd(tGrid, t, x - r, y - r, x + r, y + r); }
    const la = data.lamps, lGrid = new Array(GX * GY);
    for (let l = 0; l < la.length / 2; l++) gridAdd(lGrid, l, la[2 * l] - 1, la[2 * l + 1] - 1, la[2 * l] + 1, la[2 * l + 1] + 1);
    const aGrid = new Array(GX * GY), aBox = new Float32Array(data.areas.length * 4);
    data.areas.forEach((a, i) => {
      if (OPEN.has(a.k)) return;
      const bb = ringBox(a.p[0]);
      aBox.set(bb, 4 * i);
      gridAdd(aGrid, i, bb[0], bb[1], bb[2], bb[3]);
    });
    return (OBS = { segs: Float32Array.from(segs), sGrid, tGrid, lGrid, aGrid, aBox });
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
    L = bGrid[c];
    if (L) for (const i of L) if (x >= bBox[4 * i] && x <= bBox[4 * i + 2] && y >= bBox[4 * i + 1] && y <= bBox[4 * i + 3] && app.scene.contains(i, x, y)) return true;
    L = O.aGrid[c];
    if (L) for (const i of L) {
      if (i === self || x < O.aBox[4 * i] || x > O.aBox[4 * i + 2] || y < O.aBox[4 * i + 1] || y > O.aBox[4 * i + 3]) continue;
      if (inRings(data.areas[i].p, x, y)) return true;
    }
    return false;
  }
  // Spots for games on a lawn: the cells with the most room first, each taking the longest clear line through it (up
  // to 26 m) and keeping the next spots 8 m clear of it.
  function searchLawn(rec) {
    rec.done = true;
    obstacles();
    const a = data.areas[rec.area], CS = 2, [x0, y0, x1, y1] = rec.box;
    const nx = Math.max(1, Math.ceil((x1 - x0) / CS)), ny = Math.max(1, Math.ceil((y1 - y0) / CS));
    if (nx * ny > 120000) return;
    const D = new Float32Array(nx * ny);
    let open = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * CS, y = y0 + (j + 0.5) * CS;
      if (inRings(a.p, x, y) && !blockedAt(x, y, rec.area)) { D[j * nx + i] = 1e6; open++; }
    }
    if (!open) return;
    chamfer(D, nx, ny);
    for (let k = 0; k < D.length; k++) D[k] = D[k] > 0 ? (D[k] - 0.5) * CS : 0;   // metres of room round each cell's centre
    const cand = [];
    for (let k = 0; k < D.length; k++) if (D[k] >= 3.4) cand.push(k);
    cand.sort((p, q) => D[q] - D[p] || p - q);
    const taken = new Uint8Array(nx * ny), most = Math.max(1, Math.min(10, Math.round((open * CS * CS) / 2600)));
    const cellAt = (x, y) => { const i = Math.floor((x - x0) / CS), j = Math.floor((y - y0) / CS); return i < 0 || j < 0 || i >= nx || j >= ny ? -1 : j * nx + i; };
    let made = 0;
    for (const k of cand) {
      if (made >= most) break;
      if (taken[k]) continue;
      const cx = x0 + ((k % nx) + 0.5) * CS, cy = y0 + (Math.floor(k / nx) + 0.5) * CS;
      let bestH = 0, bestA = 0;
      for (let q = 0; q < 12; q++) {
        const ang = (q * Math.PI) / 12, ux = Math.cos(ang), uy = Math.sin(ang);
        let h = 0;
        for (let hh = 1; hh <= 13; hh++) {
          let ok = true;
          for (let sg = -1; sg <= 1 && ok; sg += 2) {
            const c = cellAt(cx + sg * hh * ux, cy + sg * hh * uy);
            ok = c >= 0 && !taken[c] && D[c] >= (hh >= 5 ? 2.4 : 1.8);
          }
          if (!ok) break;
          h = hh;
        }
        if (h > bestH) { bestH = h; bestA = ang; }
      }
      const line = bestH >= 6, round = D[k] >= 3.6;
      if (!line && !round) continue;
      const half = line ? bestH : 0, clr = D[k];
      venue("lawn", rec.area, 1 + made, { cx, cy, ang: bestA }, 2 * half, 2 * Math.min(clr, 6), half + 2.5, Math.min(clr, 6),
        { line, round, clr, parent: rec.field });
      made++;
      // keep the next spots clear of this one
      const ux = Math.cos(bestA), uy = Math.sin(bestA), reach = 8 + Math.max(0, 3.6 - half);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const x = x0 + (i + 0.5) * CS, y = y0 + (j + 0.5) * CS;
        if (segDist(x, y, cx - ux * half, cy - uy * half, cx + ux * half, cy + uy * half) < reach) taken[j * nx + i] = 1;
      }
    }
  }

  // ================================================================================================ schedule
  const C = { act: 0, day: 1, temp: 60, rain: 0, snow: 0, storm: false, ground: 0 };
  function readConditions() {
    const now = app.now(), t = localTime(now), weekend = t.dow === 0 || t.dow === 6;
    C.act = curve(weekend ? ACT_WEEKEND : ACT_WEEKDAY, t.h);
    const W = app.weather || {}, style = app.tileStyle || {};
    C.day = 1 - smooth(0.15, 0.6, Number.isFinite(W.night) ? W.night : 0);
    // the reading (live or ?weather=) is for now: for another date (?time=), a typical temperature for the season
    const reading = W.source !== "none" && Number.isFinite(W.tempF) && Math.abs(now.getTime() - Date.now()) < 3 * 3600e3;
    C.temp = reading ? W.tempF : CLIMATE[style.season] ?? 60;
    C.rain = W.rain || 0; C.snow = W.snow || 0; C.storm = !!W.storm;
    C.ground = Math.max(style.snow || 0, (W.snowDepthM || 0) / 0.05);
  }
  function shareOf(V) {
    // (with every venue busy, a whole court or field still takes turns with its ends and spots)
    if (ALL) return V.kind === "full" ? (V.small ? 0 : 0.4) : V.kind === "field" ? 0.4 : 1;
    const K = KINDS[V.kind];
    if (!K || (V.kind === "full" && V.small)) return 0;
    let p = K.busy * C.act * C.day * V.central * smooth(K.warm[0], K.warm[1], C.temp) * (1 - 0.5 * smooth(90, 102, C.temp));
    p *= C.storm ? 0 : Math.max(0, 1 - 2.2 * C.rain);
    if (V.kind === "lawn" || V.kind === "field") p *= Math.max(0, 1 - 1.5 * C.snow) * (1 - 0.75 * smooth(0.15, 0.5, C.ground));
    else p *= Math.max(0, 1 - 3 * C.snow) * (1 - smooth(0.15, 0.4, C.ground));
    return Math.min(0.95, p);
  }
  const slotOf = (V, tMin) => Math.floor((tMin + V.off) / V.slotMin);
  function wanted(V, tMin) {
    if (V.parent) { V.parent.p = shareOf(V.parent); if (wanted(V.parent, tMin)) return false; }
    return V.p > 0 && hash01(V.seed, slotOf(V, tMin)) < V.p;
  }

  // ================================================================================================ games
  function newGame(V, n, sport) {
    const R = rng(hashInt(V.seed, n));
    const g = {
      V, R, sport: sport || pickSport(V, R), P: [], t: 0, alpha: 1, fade: 0, dead: false, cold: C.temp < 55,
      b: { st: NONE, by: -1, u: 0, v: 0, z: 0, vu: 0, vv: 0, vz: 0, hid: false, hidT: 0 },
      f: { u0: 0, v0: 0, z0: 0, u1: 0, v1: 0, z1: 0, T: 1, t: 0, h: 0, bow: 0, nu: 0, nv: 0, kind: "", to: -1 },
      hold: 0, pause: 0, fetch: -1, aiming: false, aimU: 0, aimV: 0, dribble: false, phase: "", next: null,
    };
    g.ball = BALL_OF[g.sport];
    SPORT[g.sport].setup(g);
    if (g.b.st === HELD) handPos(g);
    return g;
  }
  function pickSport(V, R) {
    switch (V.kind) {
      case "sand": case "volley": return "volley";
      case "tennis": return V.pickle || R() < 0.32 ? "pickle" : "tennis";
      case "full": case "half": return "hoops";
      case "field": return R() < 0.55 ? "ultimate" : "touch";
      default: {
        if (!V.line) return "spike";
        const r = R();
        return V.round && r < 0.25 ? "spike" : r < 0.62 ? "football" : "frisbee";
      }
    }
  }
  function addPlayer(g, u, v, team, col) {
    const R = g.R;
    const p = {
      u, v, tu: u, tv: v, homeU: u, homeV: v, fu: 1, fv: 0, run: 3, mv: 0, ph: R() * 6.28, z: 0, vz: 0, jumpAt: -1,
      pose: READY, poseT: 0, team, man: -1, t: R() * 2, ang: 0, rad: 0,
      col: col || (g.cold ? JACKETS : SHIRTS)[(R() * (g.cold ? JACKETS : SHIRTS).length) | 0],
      legs: (g.cold ? TROUSERS : SHORTS)[(R() * (g.cold ? TROUSERS : SHORTS).length) | 0],
      skin: SKIN[(R() * SKIN.length) | 0], hair: HAIR[(R() * HAIR.length) | 0], bare: !g.cold, lefty: R() < 0.12,
      hid: false, hidT: 0,
    };
    // face the middle to begin with
    const d = Math.hypot(u, v);
    if (d > 0.1) { p.fu = -u / d; p.fv = -v / d; }
    g.P.push(p);
    return p;
  }
  function teamCols(g) {
    const R = g.R, a = TEAM_LIGHT[(R() * TEAM_LIGHT.length) | 0], b = TEAM_DARK[(R() * TEAM_DARK.length) | 0];
    return R() < 0.5 ? [a, b] : [b, a];
  }

  // ---------------------------------------------------------------- the engine: holding, flying, loose balls, running
  function grab(g, i, hold) { const b = g.b; b.st = HELD; b.by = i; g.hold = hold; handPos(g); }
  function pose(p, k, t) { p.pose = k; p.poseT = t; }
  function aim(g, u, v) { g.aiming = true; g.aimU = u; g.aimV = v; }
  // the ball from where it is to (u1, v1, z1) at about `speed` m/s along the ground, rising `apex` above the straight
  // line, bowing `bow` m sideways (a frisbee's curve); `kind` is what happens when it gets there, `to` who goes for it
  function fly(g, u1, v1, z1, speed, apex, kind, to = -1, bow = 0, T = 0) {
    const b = g.b, f = g.f, d = Math.hypot(u1 - b.u, v1 - b.v);
    f.u0 = b.u; f.v0 = b.v; f.z0 = b.z; f.u1 = u1; f.v1 = v1; f.z1 = z1;
    f.T = T || Math.max(0.28, d / speed); f.t = 0; f.h = apex; f.bow = bow; f.kind = kind; f.to = to;
    f.nu = d > 1e-6 ? -(v1 - b.v) / d : 0; f.nv = d > 1e-6 ? (u1 - b.u) / d : 0;
    b.st = FLY; b.by = -1;
    g.aiming = false; g.dribble = false;
    if (to >= 0) runTo(g.P[to], u1, v1, f.T);
  }
  function runTo(p, u, v, T) {
    p.tu = u; p.tv = v;
    p.run = Math.max(1.6, Math.min(6.5, Math.hypot(u - p.u, v - p.v) / Math.max(0.3, T * 0.85)));
  }
  function walkTo(p, u, v, run) { p.tu = u; p.tv = v; p.run = run; }
  function loose(g, vu, vv, pause, fetch) {
    const b = g.b;
    b.st = LOOSE; b.by = -1; b.vu = vu; b.vv = vv; b.vz = 0;
    g.pause = pause; g.fetch = fetch;
  }
  function nearest(g, u, v, team = -1, not = -1) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < g.P.length; i++) {
      const p = g.P[i];
      if (i === not || (team >= 0 && p.team !== team)) continue;
      const d = (p.u - u) ** 2 + (p.v - v) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  const teamOf = (g, team) => { const out = []; for (let i = 0; i < g.P.length; i++) if (g.P[i].team === team) out.push(i); return out; };
  // where the ball is while someone has it: in front of them at chest height, bounced beside them, overhead
  function handPos(g) {
    const b = g.b, p = g.P[b.by];
    if (g.dribble) {
      b.u = p.u + p.fu * 0.3 - p.fv * 0.28; b.v = p.v + p.fv * 0.3 + p.fu * 0.28;
      b.z = 0.12 + 0.85 * Math.abs(Math.sin(g.t * 7));
    } else {
      b.u = p.u + p.fu * 0.3; b.v = p.v + p.fv * 0.3;
      b.z = p.z + (p.pose === REACH ? 1.95 : p.pose === THROW ? 1.75 : 1.15);
    }
  }

  function stepGame(g, dt) {
    const S = SPORT[g.sport], b = g.b, P = g.P;
    g.t += dt;
    if (g.fade) {
      g.alpha += (g.fade * dt) / FADE;
      if (g.alpha >= 1) { g.alpha = 1; g.fade = 0; }
      else if (g.alpha <= 0) { g.alpha = 0; g.dead = true; return; }
    }
    if (S.think) S.think(g, dt);
    if (b.st === FLY) {
      const f = g.f;
      f.t += dt;
      const s = Math.min(1, f.t / f.T), bow = Math.sin(Math.PI * s) * f.bow;
      b.u = f.u0 + (f.u1 - f.u0) * s + f.nu * bow; b.v = f.v0 + (f.v1 - f.v0) * s + f.nv * bow;
      b.z = f.z0 + (f.z1 - f.z0) * s + 4 * f.h * s * (1 - s);
      if (s >= 1) S.arrive(g, f.kind, f.to);
    } else if (b.st === HELD) {
      handPos(g);
      g.hold -= dt;
      if (g.hold <= 0) S.release(g, b.by);
    } else if (b.st === LOOSE) {
      // it rolls (and bounces) to a stop, and stays inside the room round the venue
      const V = g.V, k = Math.exp(-dt * (V.sand ? 4 : V.kind === "lawn" || V.kind === "field" ? 1.8 : 0.9));
      b.u += b.vu * dt; b.v += b.vv * dt; b.vu *= k; b.vv *= k;
      if (Math.abs(b.u) > V.ru) { b.u = Math.sign(b.u) * V.ru; b.vu *= -0.3; }
      if (Math.abs(b.v) > V.rv) { b.v = Math.sign(b.v) * V.rv; b.vv *= -0.3; }
      if (b.z > 0 || b.vz > 0) {
        b.vz -= 9.8 * dt; b.z += b.vz * dt;
        if (b.z <= 0) { b.z = 0; b.vz = -b.vz * 0.45; if (b.vz < 0.6) b.vz = 0; }
      }
      if (g.pause > 0) g.pause -= dt;
      else if (g.fetch >= 0) {
        const i = g.fetch, p = P[i];
        walkTo(p, b.u, b.v, 2.4);
        if (Math.hypot(p.u - b.u, p.v - b.v) < 0.5) {
          g.fetch = -1;
          grab(g, i, 0.5);
          if (S.picked) S.picked(g, i);
        }
      } else {
        b.st = NONE;
        if (S.restart) S.restart(g);
      }
    }
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      if (p.jumpAt >= 0 && g.t >= p.jumpAt) { p.vz = 3.1; p.jumpAt = -1; }
      if (p.z > 0 || p.vz > 0) { p.vz -= 9.8 * dt; p.z += p.vz * dt; if (p.z <= 0) { p.z = 0; p.vz = 0; } }
      const du = p.tu - p.u, dv = p.tv - p.v, d = Math.hypot(du, dv);
      p.mv = 0;
      if (d > 0.03) {
        const st = Math.min(d, p.run * dt);
        p.u += (du / d) * st; p.v += (dv / d) * st; p.mv = st / dt;
        p.ph += st * (p.run > 2.6 ? 3.4 : 4.6);
      }
      // facing: where they run when they run far, the target when they're about to throw, else the ball
      let fu = 0, fv = 0;
      const holder = b.st === HELD && b.by === i;
      if (holder) { if (g.aiming) { fu = g.aimU - p.u; fv = g.aimV - p.v; } }
      else if (p.mv > 2.2 && d > 1.5) { fu = du; fv = dv; }
      else if (b.st !== NONE) { fu = b.u - p.u; fv = b.v - p.v; }
      const fl = Math.hypot(fu, fv);
      if (fl > 0.2) {
        const k = Math.min(1, dt * 9);
        let nu = p.fu + (fu / fl - p.fu) * k, nv = p.fv + (fv / fl - p.fv) * k;
        const n = Math.hypot(nu, nv);
        if (n > 1e-3) { p.fu = nu / n; p.fv = nv / n; }
      }
      if (p.poseT > 0) { p.poseT -= dt; if (p.poseT <= 0) p.pose = READY; }
      if (p.poseT <= 0) p.pose = holder ? (g.dribble ? DRIBBLE : HOLD) : READY;
    }
  }

  // ---------------------------------------------------------------- a football or a frisbee, thrown round a few people
  const CATCH = {
    setup(g) {
      const V = g.V, R = g.R, n = [2, 2, 2, 3, 3, 4][(R() * 6) | 0];
      const a = V.L / 2 - 0.6, e = Math.max(1.2, Math.min(a * 0.6, V.clr - 1.6)), t0 = n === 2 ? 0 : R() * 6.28;
      for (let k = 0; k < n; k++) {
        const t = t0 + (2 * Math.PI * k) / n + (n > 2 ? (R() - 0.5) * 0.5 : 0);
        addPlayer(g, a * Math.cos(t), e * Math.sin(t), 0);
      }
      g.ea = a; g.eb = e;
      grab(g, (R() * n) | 0, 0.5 + R() * 1.5);
    },
    think(g) {
      // whoever isn't throwing or going for it drifts back to their spot
      const b = g.b;
      for (let i = 0; i < g.P.length; i++) {
        const p = g.P[i];
        if ((b.st === FLY && g.f.to === i) || (b.st === LOOSE && g.fetch === i)) continue;
        if (p.tu !== p.homeU || p.tv !== p.homeV) walkTo(p, p.homeU, p.homeV, 1.4);
      }
    },
    release(g, i) {
      const R = g.R, P = g.P, b = g.b, disc = g.sport === "frisbee";
      const j = (i + 1 + ((R() * (P.length - 1)) | 0)) % P.length, q = P[j];
      let u = q.homeU + (R() - 0.5) * 4.5, v = q.homeV + (R() - 0.5) * 3.5;
      const e = Math.hypot(u / (g.ea + 1), v / (g.eb + 1));
      if (e > 1) { u /= e; v /= e; }
      const d = Math.hypot(u - b.u, v - b.v);
      aim(g, u, v);
      pose(P[i], THROW, 0.4);
      const speed = disc ? 8 + R() * 3 : 12 + R() * 3.5, apex = disc ? 0.4 + d * 0.05 : 0.7 + d * 0.12, bow = disc ? (R() - 0.5) * 0.3 * d : 0;
      if (R() < 0.08) {
        // a bad throw: it comes down past them
        const k = (d + 2 + R() * 3) / Math.max(d, 0.1);
        fly(g, b.u + (u - b.u) * k, b.v + (v - b.v) * k, 0, speed, apex, "ground", j, bow);
      } else {
        const high = R() < 0.18;
        fly(g, u, v, high ? 2.15 : 1.25, speed, apex, "catch", j, bow);
        if (high) q.jumpAt = g.t + g.f.T - 0.36;
      }
    },
    arrive(g, kind, to) {
      const R = g.R, disc = g.sport === "frisbee", f = g.f;
      if (kind === "catch") { pose(g.P[to], REACH, 0.3); grab(g, to, (disc ? 0.6 : 0.9) + R() * 1.5); return; }
      const d = Math.hypot(f.u1 - f.u0, f.v1 - f.v0) || 1, k = disc ? 1.6 : 2.6;
      loose(g, ((f.u1 - f.u0) / d) * k, ((f.v1 - f.v0) / d) * k, 0.5, to);
    },
  };

  // ---------------------------------------------------------------- spikeball: two against two round a little net
  const SPIKEBALL = {
    setup(g) {
      const R = g.R, a0 = R() * 6.28;
      for (let k = 0; k < 4; k++) {
        const p = addPlayer(g, 0, 0, k < 2 ? 0 : 1);
        p.ang = a0 + (k * Math.PI) / 2 + (R() - 0.5) * 0.3; p.rad = 2.1 + R() * 0.5;
        p.u = p.tu = p.homeU = p.rad * Math.cos(p.ang); p.v = p.tv = p.homeV = p.rad * Math.sin(p.ang);
        p.fu = -Math.cos(p.ang); p.fv = -Math.sin(p.ang);
      }
      g.side = 0; g.touch = 0; g.serve = R() < 0.5 ? 0 : 1; g.mill = 0;
      spikeServe(g, -1);
    },
    think(g, dt) {
      // between hits everyone moves round the net
      g.mill -= dt;
      if (g.mill > 0) return;
      const R = g.R, b = g.b;
      g.mill = 0.7 + R() * 0.8;
      for (let i = 0; i < 4; i++) {
        const p = g.P[i];
        if (b.by === i || (b.st === FLY && g.f.to === i) || (b.st === LOOSE && g.fetch === i)) continue;
        p.ang += (R() - 0.5) * 0.5; p.rad = clamp(p.rad + (R() - 0.5) * 0.5, 1.8, 2.9);
        walkTo(p, p.rad * Math.cos(p.ang), p.rad * Math.sin(p.ang), 2.4);
      }
    },
    // a hit down onto the net (the serve, or a held ball)
    release(g, i) { spikeHit(g, i); },
    arrive(g, kind, to) {
      const R = g.R, P = g.P, b = g.b;
      if (kind === "catch") { grab(g, to, 0.9 + R()); return; }
      if (kind === "net") {
        // off the net toward the other pair
        const other = 1 - g.side, mates = teamOf(g, other), j = mates[(R() * mates.length) | 0], q = P[j];
        const a = Math.atan2(q.v, q.u) + (R() - 0.5) * 0.8, r = 1.6 + R() * 1.3;
        if (R() < 0.16) fly(g, Math.cos(a) * r * 1.3, Math.sin(a) * r * 1.3, 0, 4.5, 0.7 + R(), "ground", j);
        else fly(g, Math.cos(a) * r, Math.sin(a) * r, 0.85, 4.5, 0.8 + R() * 1.3, "hit", j);
        g.side = other; g.touch = 1;
        return;
      }
      if (kind === "hit") {
        const p = P[to];
        pose(p, BUMP, 0.3);
        if (g.touch < 3 && (g.touch === 1 || R() < 0.55)) {
          const m = teamOf(g, p.team).find((k) => k !== to), q = P[m];
          fly(g, q.u + (R() - 0.5) * 1.2, q.v + (R() - 0.5) * 1.2, 1, 3.2, 1 + R() * 0.9, "hit", m);
          g.touch++;
        } else spikeHit(g, to);
        return;
      }
      // on the ground: the point's over; someone picks it up for the next serve
      const d = Math.hypot(g.f.u1 - g.f.u0, g.f.v1 - g.f.v0) || 1;
      loose(g, ((g.f.u1 - g.f.u0) / d) * 1.2, ((g.f.v1 - g.f.v0) / d) * 1.2, 1.4, nearest(g, b.u, b.v));
      g.serve = R() < 0.5 ? 0 : 1;
    },
    picked(g, i) { spikeServe(g, i); },
  };
  function spikeServe(g, from) {
    const R = g.R, mates = teamOf(g, g.serve), i = mates[(R() * mates.length) | 0], p = g.P[i];
    walkTo(p, (p.rad + 0.4) * Math.cos(p.ang), (p.rad + 0.4) * Math.sin(p.ang), 1.2);
    if (from < 0 || from === i) grab(g, i, 1.2 + R());
    else fly(g, p.tu, p.tv, 1.2, 4, 0.8, "catch", i);
  }
  function spikeHit(g, i) {
    const R = g.R, p = g.P[i];
    pose(p, SPIKE, 0.35);
    aim(g, 0, 0);
    g.side = p.team; g.touch = 0;
    if (R() < 0.05) {
      // missed the net
      const d = Math.hypot(p.u, p.v) || 1;
      fly(g, (-p.u / d) * 2.5, (-p.v / d) * 2.5, 0, 6.5, 0.2, "ground", -1);
    } else {
      const a = R() * 6.28, r = R() * 0.22;
      fly(g, Math.cos(a) * r, Math.sin(a) * r, 0.32, 6.5, 0.05, "net");
    }
  }

  // ---------------------------------------------------------------- volleyball: two against two on the sand, more on a hard court
  const VOLLEY = {
    setup(g) {
      const V = g.V, R = g.R;
      const per = V.sand ? (R() < 0.65 ? 2 : R() < 0.6 ? 3 : 4) : 4 + ((R() * 3) | 0), cols = teamCols(g);
      for (let t = 0; t < 2; t++) {
        const s = t ? 1 : -1;
        for (const [u, v] of volleyHomes(per, V.L, V.W)) addPlayer(g, s * u, v, t, per > 2 ? cols[t] : null);
      }
      g.rot = [0, 0]; g.serve = R() < 0.5 ? 0 : 1; g.touch = 0; g.side = 0; g.spike = false;
      volleyServe(g, -1);
    },
    think(g) {
      // players not on the ball go back to their places
      const b = g.b;
      for (let i = 0; i < g.P.length; i++) {
        const p = g.P[i];
        if (b.by === i || (b.st === FLY && g.f.to === i) || (b.st === LOOSE && g.fetch === i) || g.server === i) continue;
        if (p.tu !== p.homeU || p.tv !== p.homeV) walkTo(p, p.homeU, p.homeV, 2.2);
      }
    },
    release(g, i) {
      const p = g.P[i], b = g.b;
      // the server walks back behind the line, then tosses the ball up
      if (Math.hypot(p.tu - p.u, p.tv - p.v) > 0.25) { g.hold = 0.25; return; }
      aim(g, 0, p.v);
      fly(g, b.u, b.v, 2.6, 1, 1.1, "toss", i, 0, 0.75);
    },
    arrive(g, kind, to) {
      const V = g.V, R = g.R, P = g.P, b = g.b;
      if (kind === "catch") { grab(g, to, 0.5); return; }
      if (kind === "toss") {
        // the serve
        const p = P[to], os = p.team ? -1 : 1, other = 1 - p.team;
        pose(p, SPIKE, 0.35);
        g.server = -1;
        const u = os * (1.2 + R() * (V.L / 2 - 1.7)), v = (R() - 0.5) * (V.W - 1.2), j = nearest(g, u, v, other);
        if (R() < 0.07) fly(g, os * (V.L / 2 + 0.8 + R() * 2), v, 0, 9, 3.4, "ground", j);
        else fly(g, u, v, 0.75, 8.5 + R() * 2, 3 + R() * 1.5, R() < 0.06 ? "ground" : "hit", j);
        g.side = other; g.touch = 1; g.spike = false;
        return;
      }
      if (kind === "hit") {
        const p = P[to], s = p.team ? 1 : -1, os = -s, mates = teamOf(g, p.team);
        pose(p, g.touch === 1 ? BUMP : g.touch === 2 ? REACH : SPIKE, 0.35);
        const err = R() < 0.05;
        if (!err && g.touch < 3 && mates.length > 1 && (g.touch < 2 || R() < 0.75)) {
          // a pass up to the net, then a set
          const tu = s * (g.touch === 1 ? 1.6 : 1.2), tv = g.touch === 1 ? (R() - 0.5) * V.W * 0.4 : (R() < 0.5 ? -1 : 1) * V.W * 0.3;
          let m = -1, bd = Infinity;
          for (const k of mates) { if (k === to) continue; const d = Math.hypot(P[k].u - tu, P[k].v - tv); if (d < bd) { bd = d; m = k; } }
          fly(g, tu, tv, g.touch === 1 ? 2.3 : 2.6, 6, 2 + R() * 1.4, "hit", m);
          g.touch++;
          g.spike = g.touch === 3 && R() < 0.7;
          if (g.spike) P[m].jumpAt = g.t + g.f.T - 0.32;
          return;
        }
        // over the net
        const other = 1 - p.team, u = os * (1 + R() * (V.L / 2 - 1.5)), v = (R() - 0.5) * (V.W - 1), j = nearest(g, u, v, other);
        if (err) fly(g, os * (V.L / 2 + 1 + R() * 2), (R() - 0.5) * (V.W + 3), 0, 9, 3, "ground", -1);
        else if (g.spike) fly(g, u, v, 0.55, 14, 0.15, R() < 0.5 ? "hit" : "ground", j);
        else fly(g, u, v, 0.8, 8, 2.2 + R() * 1.2, R() < 0.9 ? "hit" : "ground", j);
        g.side = other; g.touch = 1; g.spike = false;
        return;
      }
      // down: the rally's over
      const f = g.f, d = Math.hypot(f.u1 - f.u0, f.v1 - f.v0) || 1, k = V.sand ? 0.5 : 1.8;
      loose(g, ((f.u1 - f.u0) / d) * k, ((f.v1 - f.v0) / d) * k, 1.5, nearest(g, b.u, b.v));
      g.serve = R() < 0.5 ? 0 : 1;
    },
    picked(g, i) { volleyServe(g, i); },
  };
  function volleyHomes(n, l, w) {
    if (n === 2) return [[l * 0.24, -w * 0.24], [l * 0.24, w * 0.24]];
    if (n === 3) return [[l * 0.14, -w * 0.3], [l * 0.14, w * 0.3], [l * 0.36, 0]];
    const out = [], front = n >= 5 ? 3 : 2, back = n - front;
    for (let k = 0; k < front; k++) out.push([l * 0.12, w * ((k + 0.5) / front - 0.5) * 0.8]);
    for (let k = 0; k < back; k++) out.push([l * 0.35, w * ((k + 0.5) / back - 0.5) * 0.8]);
    return out;
  }
  function volleyServe(g, from) {
    const V = g.V, R = g.R, mates = teamOf(g, g.serve), i = mates[g.rot[g.serve]++ % mates.length], p = g.P[i], s = g.serve ? 1 : -1;
    g.server = i;
    walkTo(p, s * (V.L / 2 + 0.9), (R() - 0.5) * V.W * 0.5, 1.6);
    if (from < 0 || from === i) grab(g, i, 1.2);
    else fly(g, p.tu, p.tv, 1.2, 7, 1.6, "catch", i);
  }

  // ---------------------------------------------------------------- tennis and pickleball: singles or doubles
  const TENNIS = {
    setup(g) {
      const V = g.V, R = g.R, pk = g.sport === "pickle", dbl = pk ? R() < 0.7 : R() < 0.35;
      // the lines they play to: a tennis court's (singles or doubles), or a pickleball court's inside it
      g.hl = pk ? Math.min(6.7, V.L / 2) : V.L / 2;
      g.hw = pk ? Math.min(3.05, V.W / 2) : (V.W / 2) * (dbl ? 1 : 8.23 / 10.97);
      g.kl = Math.min(2.13, g.hl * 0.33); g.sl = (V.L / 2) * (6.4 / 11.885); g.box = (V.W / 2) * (8.23 / 10.97);
      for (let t = 0; t < 2; t++) {
        const s = t ? 1 : -1;
        for (let k = 0; k < (dbl ? 2 : 1); k++) addPlayer(g, s * (g.hl + (pk ? -0.2 : 0.9)), dbl ? (k ? 1 : -1) * g.hw * 0.5 : 0, t);
      }
      g.dbl = dbl; g.order = dbl ? [0, 2, 1, 3] : [0, 1]; g.srv = (R() * g.order.length) | 0; g.pt = 0; g.shots = 0;
      tennisPoint(g);
    },
    think(g) {
      const b = g.b, aimed = b.st === FLY ? (g.f.kind === "bounce" && g.next ? g.next.to : g.f.to) : -1;
      for (let i = 0; i < g.P.length; i++) {
        const p = g.P[i];
        if (b.by === i || aimed === i || (g.phase === "serve" && i === g.server)) continue;
        if (p.tu !== p.homeU || p.tv !== p.homeV) walkTo(p, p.homeU, p.homeV, 2.6);
      }
    },
    release(g, i) {
      const p = g.P[i], b = g.b, pk = g.sport === "pickle";
      if (Math.hypot(p.tu - p.u, p.tv - p.v) > 0.25) { g.hold = 0.25; return; }
      aim(g, 0, -p.v);
      if (pk) tennisServe(g, i);   // underhand: no toss
      else fly(g, b.u, b.v, 2.75, 1, 1.0, "toss", i, 0, 0.8);
    },
    arrive(g, kind, to) {
      const R = g.R, P = g.P, b = g.b, f = g.f, pk = g.sport === "pickle";
      if (kind === "toss") { tennisServe(g, to); return; }
      if (kind === "bounce") { const n = g.next; fly(g, n.u, n.v, 0.9, n.speed, pk ? 0.4 : 0.6, "hit", n.to); return; }
      if (kind === "hit") {
        const p = P[to], os = p.team ? -1 : 1;
        pose(p, SWING, 0.3);
        g.shots++; g.phase = "rally";
        if (R() < (pk ? 0.1 : 0.12) + g.shots * 0.01) {
          // into the net, or long
          if (R() < 0.5) fly(g, -os * 0.1, b.v + (R() - 0.5) * 2, 0.35 + R() * 0.4, pk ? 8 : 16, 0.35, "net");
          else fly(g, os * (g.hl + 1 + R() * 3), (R() - 0.5) * 2 * (g.hw + 1.5), 0, pk ? 8 : 17, pk ? 0.9 : 0.8, "out");
          return;
        }
        if (pk) {
          // after the return everybody comes up to the kitchen line, and dinks
          if (g.shots >= 2) for (const q of P) q.homeU = (q.team ? 1 : -1) * (g.kl + 0.35);
          if (g.shots > 2 && R() < 0.6) tennisShot(g, os * (0.4 + R() * (g.kl - 0.5)), (R() - 0.5) * 1.7 * g.hw, 4 + R(), 0.55);
          else tennisShot(g, os * (g.kl + R() * (g.hl - g.kl - 0.3)), (R() - 0.5) * 1.7 * g.hw, 7 + R() * 3, 0.45 + R() * 0.4);
        } else {
          const lob = R() < 0.05;
          tennisShot(g, os * g.hl * (0.35 + R() * 0.6), (R() - 0.5) * 1.7 * g.hw, lob ? 9 : 15 + R() * 7, lob ? 4.5 : 0.45 + R() * 0.6);
        }
        return;
      }
      // dead: into the net (it drops) or out (it rolls on to the fence)
      const d = Math.hypot(f.u1 - f.u0, f.v1 - f.v0) || 1, k = kind === "out" ? 4 : 0;
      loose(g, ((f.u1 - f.u0) / d) * k, ((f.v1 - f.v0) / d) * k, 2.2, -1);
    },
    restart(g) {
      // a new ball for the next point; the serve changes every four
      g.pt++;
      if (g.pt % 4 === 0) g.srv++;
      tennisPoint(g);
    },
  };
  function tennisPoint(g) {
    const R = g.R, pk = g.sport === "pickle", i = g.order[g.srv % g.order.length], p = g.P[i], s = p.team ? 1 : -1;
    g.sv = g.pt % 2 ? -1 : 1;
    g.server = i; g.phase = "serve"; g.shots = 0; g.next = null;
    for (const q of g.P) {
      const qs = q.team ? 1 : -1;
      q.homeU = qs * (g.hl + (pk ? -0.2 : 0.9));
      if (!g.dbl) q.homeV = q === p ? g.sv * g.hw * 0.3 : -g.sv * g.hw * 0.45;
    }
    walkTo(p, s * (g.hl + (pk ? 0.3 : 0.5)), g.sv * g.hw * (g.dbl ? 0.5 : 0.3), 1.4);
    // the receiver waits diagonally across
    const r = nearest(g, -s * g.hl, -g.sv * g.hw * 0.5, 1 - p.team);
    if (r >= 0) walkTo(g.P[r], -s * (g.hl + (pk ? -0.2 : 0.6)), -g.sv * g.hw * 0.5, 1.4);
    grab(g, i, 1.4 + R());
  }
  function tennisServe(g, i) {
    const R = g.R, p = g.P[i], os = p.team ? -1 : 1, pk = g.sport === "pickle";
    pose(p, pk ? SWING : SPIKE, 0.35);
    let u, v;
    if (pk) { u = os * (g.kl + 0.4 + R() * (g.hl - g.kl - 0.8)); v = -g.sv * (0.3 + R() * 0.6) * g.hw; }
    else { u = os * g.sl * (0.4 + R() * 0.55); v = -g.sv * (0.15 + R() * 0.75) * g.box; }
    if (R() < 0.1) { fly(g, -os * 0.15, v * 0.5, 0.45, pk ? 7 : 20, 0.25, "net"); return; }
    tennisShot(g, u, v, pk ? 7 + R() * 2 : 19 + R() * 5, pk ? 1 : 0.25);
  }
  // the ball to its bounce at (u, v), then on to where whoever gets to it on that side meets it
  function tennisShot(g, u, v, speed, apex) {
    const R = g.R, b = g.b, pk = g.sport === "pickle";
    const d = Math.hypot(u - b.u, v - b.v) || 1, du = (u - b.u) / d, dv = (v - b.v) / d, carry = pk ? 1.2 + R() * 1.6 : 2.5 + R() * 3;
    const hu = clamp(u + du * carry, -(g.hl + 3.5), g.hl + 3.5), hv = clamp(v + dv * carry, -(g.hw + 2.5), g.hw + 2.5);
    const j = nearest(g, hu, hv, u > 0 ? 1 : 0);
    g.next = { u: hu, v: hv, to: j, speed: speed * 0.7 };
    fly(g, u, v, 0, speed, apex, "bounce");
    runTo(g.P[j], hu, hv, g.f.T + Math.hypot(hu - u, hv - v) / (speed * 0.7));
  }

  // ---------------------------------------------------------------- basketball: a shootaround, half court or full court
  const HOOPS = {
    setup(g) {
      const V = g.V, R = g.R, full = V.kind === "full";
      g.full = full; g.side = full ? (R() < 0.5 ? -1 : 1) : V.hoop;
      if (!full && R() < 0.35) {
        g.mode = "shoot";
        const n = 1 + ((R() * 3) | 0);
        for (let k = 0; k < n; k++) { const [u, v] = hoopSpot(g, g.side, k, n, 1); addPlayer(g, u, v, 0); }
        g.shooter = 0;
      } else {
        g.mode = "game";
        const per = full ? 4 + (R() < 0.5 ? 1 : 0) : 2 + (R() < 0.55 ? 1 : 0), cols = teamCols(g);
        for (let t = 0; t < 2; t++) for (let k = 0; k < per; k++) { const [u, v] = hoopSpot(g, g.side, k, per, t ? 0.75 : 1); addPlayer(g, u, v, t, cols[t]); }
        g.off = 0;
        hoopAssign(g);
      }
      g.dribble = true;
      grab(g, 0, 1 + R());
    },
    think(g, dt) {
      const P = g.P, b = g.b, R = g.R, H = hoopU(g, g.side), side = g.side, holder = b.st === HELD ? b.by : -1;
      for (let i = 0; i < P.length; i++) {
        const p = P[i];
        if ((b.st === FLY && g.f.to === i) || (b.st === LOOSE && g.fetch === i)) continue;
        if (i === holder) {
          if (g.drive) { aim(g, H, 0); walkTo(p, H - side * 1.1, p.v * 0.3, 3.6); }
          continue;
        }
        p.t -= dt;
        if (g.mode === "shoot") {
          // the shooter goes to a new spot after each shot; the others wait for the rebound under the basket
          if (p.t <= 0) {
            p.t = 2 + R() * 2;
            const [u, v] = i === g.shooter ? hoopSpot(g, side, (R() * 5) | 0, 5, 1) : hoopSpot(g, side, (R() * 3) | 0, 3, 0.45);
            walkTo(p, u, v, 1.8);
          }
        } else if (p.team === g.off) {
          // cuts: a new spot every couple of seconds
          if (p.t <= 0) { p.t = 1.4 + R() * 2.2; const [u, v] = hoopSpot(g, side, (R() * 5) | 0, 5, 1); walkTo(p, u, v, 2.8 + R() * 1.8); }
        } else if (p.man >= 0) {
          // defence: between their man and the basket, tighter on the ball
          const m = P[p.man], k = p.man === holder ? 0.16 : 0.3;
          p.tu = m.u + (H - m.u) * k; p.tv = m.v * (1 - k); p.run = 4.2;
        }
      }
    },
    release(g, i) {
      const P = g.P, R = g.R, V = g.V, p = P[i], side = g.side, H = hoopU(g, side), d = Math.hypot(p.u - H, p.v);
      if (g.clear || g.bring) {
        // a defensive rebound in a half-court game is taken back out past the arc before it's played; in a full-court
        // game the ball is brought up the other end
        if (g.clear === 1 || g.bring === 1) {
          const a = clamp(Math.atan2(p.v, -side * (p.u - H)), -1, 1), r = g.bring ? 6.5 : 7.4;
          walkTo(p, clamp(H - side * r * Math.cos(a), -V.L / 2 + 0.5, V.L / 2 - 0.5), clamp(r * Math.sin(a), -V.W / 2 + 0.5, V.W / 2 - 0.5), g.bring ? 4.5 : 2.6);
          if (g.clear) g.clear = 2; else g.bring = 2;
        }
        if (Math.hypot(p.tu - p.u, p.tv - p.v) > 0.3) { aim(g, H, 0); g.hold = 0.3; return; }
        if (g.clear) { g.off = p.team; hoopAssign(g); }
        g.clear = 0; g.bring = 0; g.hold = 0.4 + R() * 0.8;
        return;
      }
      if (g.mode === "shoot") {
        if (i !== g.shooter) { hoopPass(g, i, g.shooter); return; }
        if (P.length === 1 && Math.hypot(p.tu - p.u, p.tv - p.v) > 0.4) { g.hold = 0.3; return; }
        hoopShoot(g, i);
        return;
      }
      if (g.drive ? d < 1.9 : R() < (d < 4 ? 0.5 : 0.3)) { hoopShoot(g, i); return; }
      if (g.drive) { g.hold = 0.25; return; }
      const mates = teamOf(g, p.team).filter((k) => k !== i);
      hoopPass(g, i, mates[(R() * mates.length) | 0]);
    },
    arrive(g, kind, to) {
      const R = g.R, P = g.P, b = g.b, side = g.side, H = hoopU(g, side), V = g.V;
      if (kind === "catch") {
        grab(g, to, 0.6 + R() * 1.8);
        g.dribble = true; g.drive = g.mode === "game" && R() < 0.28;
        return;
      }
      if (kind === "rim") {
        if (R() < (g.shotD < 2 ? 0.62 : g.shotD < 6.75 ? 0.45 : 0.33)) { fly(g, H, 0, 0.2, 1, 0, "made", -1, 0, 0.45); return; }
        // off the rim: whoever's nearest goes up for it
        const a = (R() - 0.5) * 2.6, r = 1.2 + R() * 2.4;
        const u = clamp(H - side * r * Math.cos(a), -V.L / 2 + 0.4, V.L / 2 - 0.4), v = clamp(r * Math.sin(a), -V.W / 2 + 0.4, V.W / 2 - 0.4);
        const j = g.mode === "shoot" && P.length > 1 ? nearest(g, u, v, -1, g.shooter) : nearest(g, u, v);
        fly(g, u, v, 1.9, 5, 0.5 + R() * 0.7, "reb", j);
        P[j].jumpAt = g.t + g.f.T - 0.32;
        return;
      }
      if (kind === "made") {
        // through: it bounces under the basket; the other team takes it (or the rebounder, shooting around)
        const j = g.mode === "shoot" ? (P.length > 1 ? nearest(g, H, 0, -1, g.shooter) : 0) : nearest(g, H, 0, 1 - g.off);
        loose(g, (R() - 0.5) * 1.2, (R() - 0.5) * 1.2, 0.35, j);
        b.vz = 1.6;
        return;
      }
      if (kind === "reb") {
        grab(g, to, 0.4 + R() * 0.6);
        g.dribble = true;
        if (g.mode === "game") { if (P[to].team !== g.off) hoopChange(g, to); else g.drive = R() < 0.3; }
        else if (P.length === 1) { const [u, v] = hoopSpot(g, side, (R() * 5) | 0, 5, 1); walkTo(P[0], u, v, 2.2); g.hold = 1; }
      }
    },
    picked(g, i) {
      if (g.mode === "shoot") {
        if (g.P.length === 1) { const [u, v] = hoopSpot(g, g.side, (g.R() * 5) | 0, 5, 1); walkTo(g.P[0], u, v, 2.2); g.dribble = true; g.hold = 1; }
        else if (i === g.shooter) g.hold = 0.6;
      } else hoopChange(g, i);
    },
  };
  const hoopU = (g, side) => side * (g.V.L / 2 - 1.6);
  // a place to stand round the basket at that end, k of n across the arc
  function hoopSpot(g, side, k, n, shrink) {
    const V = g.V, R = g.R, H = hoopU(g, side), r = (3 + R() * 3.6) * shrink + (shrink < 1 ? 0.8 : 0), a = -1.2 + (2.4 * (k + 0.5)) / n + (R() - 0.5) * 0.5;
    return [clamp(H - side * r * Math.cos(a), -V.L / 2 + 0.4, V.L / 2 - 0.4), clamp(r * Math.sin(a), -V.W / 2 + 0.4, V.W / 2 - 0.4)];
  }
  function hoopAssign(g) {
    const O = teamOf(g, g.off), D = teamOf(g, 1 - g.off);
    for (const i of O) g.P[i].man = -1;
    D.forEach((i, k) => { g.P[i].man = O[k % O.length]; });
    for (const p of g.P) p.t = 0;
  }
  // the ball changes hands: in a half-court game it's taken back out; in a full-court one brought up the other end
  function hoopChange(g, i) {
    g.drive = false; g.dribble = true;
    if (g.full) { g.off = g.P[i].team; g.side = -g.side; g.bring = 1; hoopAssign(g); }
    else g.clear = 1;
    g.hold = 0.3;
  }
  function hoopShoot(g, i) {
    const p = g.P[i], H = hoopU(g, g.side), d = Math.hypot(p.u - H, p.v);
    pose(p, REACH, 0.55); p.jumpAt = g.t; aim(g, H, 0);
    g.shotD = d; g.drive = false;
    if (g.mode === "shoot") g.shooter = (g.shooter + 1) % g.P.length;   // (the next one shoots after this one)
    fly(g, H, 0, 3.08, 4.8 + d * 0.35, 0.8 + d * 0.16, "rim", -1);
  }
  function hoopPass(g, i, j) {
    const q = g.P[j];
    aim(g, q.tu, q.tv); pose(g.P[i], THROW, 0.3);
    fly(g, q.tu, q.tv, 1.2, 9, 0.3, "catch", j);
  }

  // ---------------------------------------------------------------- ultimate: a disc worked up a whole field
  const ULTI = {
    setup(g) {
      const R = g.R;
      fieldDims(g);
      const per = 5 + ((R() * 3) | 0), cols = teamCols(g), base = -g.dir * (g.FL / 2 - g.ez);
      for (let t = 0; t < 2; t++) for (let k = 0; k < per; k++) {
        const u = k === 0 && t === 0 ? base : base + g.dir * (t ? 6 + R() * 26 : 4 + R() * 22), v = k === 0 && t === 0 ? 0 : (R() - 0.5) * g.FW * 0.85;
        addPlayer(g, u, v, t, cols[t]);
      }
      g.off = 0; g.reset = 0;
      hoopAssign(g);
      grab(g, 0, 1.5);
    },
    think(g, dt) {
      const P = g.P, b = g.b, R = g.R, holder = b.st === HELD ? b.by : -1, du = holder >= 0 ? P[holder].u : b.u;
      if (g.reset > 0) {
        // after a score both lines walk to their ends; then the pull
        g.reset -= dt;
        let ready = true;
        for (const p of P) if (Math.hypot(p.tu - p.u, p.tv - p.v) > 1.5) ready = false;
        if ((ready || g.reset <= 0) && holder >= 0) {
          g.reset = 0;
          const D = teamOf(g, g.off), j = D[(R() * D.length) | 0], q = P[j];
          aim(g, q.u, q.v); pose(P[holder], THROW, 0.4);
          fly(g, q.u, q.v, 1.4, 13, 7, "catch", j);
        }
        return;
      }
      for (let i = 0; i < P.length; i++) {
        const p = P[i];
        if (i === holder || (b.st === FLY && g.f.to === i) || (b.st === LOOSE && g.fetch === i)) continue;
        p.t -= dt;
        if (p.team === g.off) {
          if (p.t <= 0) {
            p.t = 1.5 + R() * 2.5;
            walkTo(p, clamp(du + g.dir * (R() * 24 - 5), -g.FL / 2, g.FL / 2), (R() - 0.5) * g.FW * 0.9, 3 + R() * 2.5);
          }
        } else if (p.man >= 0) {
          const m = P[p.man];
          if (p.man === holder) { p.tu = m.u + g.dir * 1.3; p.tv = m.v + 0.4; p.run = 3; }   // the mark
          else { p.tu = m.u + g.dir * 1.1; p.tv = m.v + 0.8; p.run = Math.max(2, m.run * 0.93); }
        }
      }
      if (holder >= 0) aim(g, P[holder].u + g.dir * 10, P[holder].v);
    },
    release(g, i) {
      const P = g.P, R = g.R, p = P[i];
      if (g.reset > 0) { g.hold = 0.4; return; }
      if (g.score) {
        // the scorers line up on the end they scored at and pull to the others, who attack it
        g.score = false; g.off = 1 - g.off; g.reset = 14; g.hold = 99;
        const goal = g.dir * (g.FL / 2 - g.ez);
        for (const q of P) walkTo(q, q.team === g.off ? -goal : goal, (g.R() - 0.5) * g.FW * 0.8, 3.5);
        hoopAssign(g);
        return;
      }
      // to a teammate, leading them downfield
      let best = -1, bs = -Infinity;
      for (let j = 0; j < P.length; j++) {
        const q = P[j];
        if (j === i || q.team !== g.off) continue;
        const sc = g.dir * (q.tu - p.u) + R() * 15 - Math.abs(q.tv - p.v) * 0.2;
        if (sc > bs) { bs = sc; best = j; }
      }
      const q = P[best], u = clamp(q.tu, -g.FL / 2, g.FL / 2), v = q.tv, d = Math.hypot(u - p.u, v - p.v);
      aim(g, u, v); pose(p, THROW, 0.35);
      fly(g, u, v, 1.3, 9 + R() * 3, 0.5 + d * 0.04, R() < 0.86 ? "catch" : "ground", best, (R() - 0.5) * 0.25 * d);
    },
    arrive(g, kind, to) {
      const R = g.R, P = g.P, b = g.b;
      if (kind === "catch") {
        pose(P[to], REACH, 0.3);
        grab(g, to, 1.2 + R() * 2.8);
        if (g.reset <= 0 && g.dir * P[to].u > g.FL / 2 - g.ez) { g.score = true; g.hold = 2.2; }
        return;
      }
      // a drop or a block: the other team picks it up and attacks the other way
      loose(g, 0, 0, 0.5, nearest(g, b.u, b.v, 1 - g.off));
    },
    picked(g, i) { g.off = g.P[i].team; g.dir = -g.dir; hoopAssign(g); g.hold = 1 + g.R(); },
  };
  function fieldDims(g) {
    const V = g.V;
    g.FL = V.L; g.FW = V.W; g.ez = g.FL * 0.18; g.dir = g.R() < 0.5 ? 1 : -1;
  }

  // ---------------------------------------------------------------- touch football: plays from a line of scrimmage
  const TOUCH = {
    setup(g) {
      const R = g.R;
      fieldDims(g);
      const per = 4 + ((R() * 3) | 0), cols = teamCols(g);
      for (let t = 0; t < 2; t++) for (let k = 0; k < per; k++) addPlayer(g, 0, 0, t, cols[t]);
      g.off = 0; g.los = -g.dir * (g.FL / 2 - g.ez - 12); g.down = 1;
      touchLineUp(g, true);
    },
    think(g, dt) {
      const P = g.P, b = g.b, holder = b.st === HELD ? b.by : -1;
      if (g.phase === "set") {
        g.timer -= dt;
        if (g.timer <= 0 && holder === g.center) {
          // the snap, and everyone goes
          const R = g.R, O = teamOf(g, g.off);
          g.phase = "play";
          fly(g, P[g.qb].u, P[g.qb].v, 1.1, 6, 0.3, "catch", g.qb);
          for (const i of O) if (i !== g.qb) runTo(P[i], clamp(g.los + g.dir * (5 + R() * 18), -g.FL / 2, g.FL / 2), clamp(P[i].v + (R() - 0.5) * 14, -g.FW / 2, g.FW / 2), 3.2);
        }
        return;
      }
      if (g.phase === "play" || g.phase === "run") {
        for (let i = 0; i < P.length; i++) {
          const p = P[i];
          if (p.team === g.off || p.man < 0) continue;
          const m = P[p.man];
          if (p.man === g.qb && g.phase === "play") { p.tu = m.u + g.dir * 1.2; p.tv = m.v; p.run = 2.2; }   // the rush counts to five first
          else { p.tu = m.u + g.dir * 1; p.tv = m.v + 0.6; p.run = Math.max(2, m.run * 0.95); }
        }
      }
    },
    release(g, i) {
      const P = g.P, R = g.R, p = P[i];
      if (g.phase === "set" || g.phase === "dead") { g.hold = 0.5; return; }
      if (g.phase === "play") {
        // the quarterback throws to someone running a route
        const O = teamOf(g, g.off).filter((k) => k !== i && k !== g.center), j = O[(R() * O.length) | 0], q = P[j];
        const d = Math.hypot(q.tu - p.u, q.tv - p.v);
        aim(g, q.tu, q.tv); pose(p, THROW, 0.4);
        fly(g, q.tu, q.tv, 1.3, 13 + R() * 3, 0.9 + d * 0.09, R() < 0.62 ? "catch" : "ground", j);
        return;
      }
      // the runner's touched: the next play starts from here
      const gained = g.dir * (p.u - g.los);
      if (g.dir * p.u > g.FL / 2 - g.ez) touchTurnover(g, true);
      else {
        g.los = clamp(p.u, -g.FL / 2 + g.ez, g.FL / 2 - g.ez);
        g.down = gained >= 10 ? 1 : g.down + 1;
        if (g.down > 4) touchTurnover(g, false);
      }
      touchHandBack(g, i);
    },
    arrive(g, kind, to) {
      const R = g.R, P = g.P, b = g.b;
      if (kind === "catch") {
        if (g.phase === "dead") { grab(g, to, 99); g.phase = "set"; g.timer = 2 + R() * 2; return; }
        if (to === g.qb && g.phase === "play") { grab(g, to, 1.6 + R() * 1.6); return; }   // the snap
        // caught: run with it until touched
        pose(P[to], REACH, 0.3);
        g.phase = "run";
        runTo(P[to], clamp(P[to].u + g.dir * (3 + R() * 9), -g.FL / 2, g.FL / 2), P[to].v + (R() - 0.5) * 4, 1.6);
        grab(g, to, 1.2 + R() * 1.4);
        return;
      }
      // incomplete
      g.down++;
      if (g.down > 4) touchTurnover(g, false);
      loose(g, 0, 0, 0.8, nearest(g, b.u, b.v, g.off));
      g.phase = "dead";
    },
    picked(g, i) { touchHandBack(g, i); },
  };
  function touchTurnover(g, score) {
    g.off = 1 - g.off; g.dir = -g.dir; g.down = 1;
    if (score) g.los = -g.dir * (g.FL / 2 - g.ez - 12);
  }
  // everyone walks back to the line; the ball goes to the center
  function touchHandBack(g, i) {
    g.phase = "dead";
    touchLineUp(g, false);
    if (i === g.center) { grab(g, i, 99); g.phase = "set"; g.timer = 3 + g.R() * 2; return; }
    const c = g.P[g.center];
    fly(g, c.tu, c.tv, 1.1, 7, 1.2, "catch", g.center);
  }
  function touchLineUp(g, place) {
    const P = g.P, R = g.R, d = g.dir, O = teamOf(g, g.off), D = teamOf(g, 1 - g.off);
    g.qb = O[0]; g.center = O[1];
    O.forEach((i, k) => {
      const p = P[i];
      let u, v;
      if (k === 0) { u = g.los - d * 4; v = 0; }
      else if (k === 1) { u = g.los - d * 0.6; v = 0; }
      else { u = g.los - d * (0.6 + (k % 2) * 1.2); v = (k % 2 ? 1 : -1) * (3 + ((k - 2) >> 1) * 5 + R() * 2); }
      walkTo(p, u, clamp(v, -g.FW / 2, g.FW / 2), 2.2);
      p.man = -1;
    });
    D.forEach((i, k) => {
      const p = P[i];
      p.man = O[k % O.length];
      walkTo(p, g.los + d * (p.man === g.qb ? 6 : 2 + R() * 6), clamp(P[p.man].tv + (R() - 0.5) * 2, -g.FW / 2, g.FW / 2), 2.2);
    });
    if (place) {
      for (const p of P) { p.u = p.tu; p.v = p.tv; p.fu = d * (p.team === g.off ? 1 : -1); p.fv = 0; }
      grab(g, g.center, 99); g.phase = "set"; g.timer = 2 + R() * 3;
    }
  }

  const SPORT = { volley: VOLLEY, tennis: TENNIS, pickle: TENNIS, hoops: HOOPS, football: CATCH, frisbee: CATCH, spike: SPIKEBALL, ultimate: ULTI, touch: TOUCH };
  const BALL_OF = { volley: "volley", tennis: "tennis", pickle: "pickle", hoops: "hoops", football: "football", frisbee: "frisbee", spike: "spike", ultimate: "frisbee", touch: "football" };
  const NAMES = { volley: "Volleyball", tennis: "Tennis", pickle: "Pickleball", hoops: "Basketball", football: "Football", frisbee: "Frisbee", spike: "Spikeball", ultimate: "Ultimate", touch: "Touch football" };

  // ================================================================================================ the population
  let near = [], failed = false, tickAt = -1e9, condAt = -1e9;
  // which venues are near the view, which of them should be in use, and their games started or ended
  function manage(force) {
    const now = performance.now();
    if (!force && now - tickAt < 400) return;
    tickAt = now;
    setCamera();
    if (now - condAt > 4000) { readConditions(); condAt = now; }
    const on = app.layerEnabled("people") && SCALE >= SIM_S, M = 0.3 * Math.max(VW, VH);
    const tMin = app.now().getTime() / 60000;
    // a lawn near the view is searched for room the first time (one a tick: the Oval takes a few tens of ms)
    if (on) for (const L of lawns) if (!L.done && onView(L.cx, L.cy, L.rad, M)) { searchLawn(L); break; }
    near = [];
    let changed = false;
    for (const V of venues) {
      if (!onView(V.cx, V.cy, V.rad, M)) {
        if (V.game) { V.game = null; changed = true; }
        V.seen = false;
        continue;
      }
      near.push(V);
      V.p = shareOf(V);
    }
    for (const V of near) {
      const want = on && wanted(V, tMin), seen = SCALE >= MIN_S && onView(V.cx, V.cy, V.rad, 0);
      if (want && !V.game) {
        V.game = newGame(V, slotOf(V, tMin));
        // in plain view it fades in; anywhere else (or just come into range) it's simply there
        if (V.seen && seen && !reduceMQ.matches) { V.game.alpha = 0; V.game.fade = 1; }
        changed = true;
      } else if (!want && V.game) {
        if (seen && !reduceMQ.matches) { if (V.game.fade >= 0) { V.game.fade = -1; changed = true; } }
        else { V.game = null; changed = true; }
      } else if (want && V.game && V.game.fade < 0) V.game.fade = 1;
      V.seen = seen;
    }
    if (changed) app.requestRender("sports");
  }
  function stepAll(dt) {
    if (dt <= 0) return;
    const n = Math.max(1, Math.ceil(dt / 0.05 - 1e-6));
    for (const V of near) {
      const g = V.game;
      if (!g) continue;
      for (let k = 0; k < n && !g.dead; k++) stepGame(g, dt / n);
      if (g.dead) V.game = null;
    }
  }
  function dropAll() { for (const V of venues) V.game = null; near = []; }

  // ================================================================================================ drawing
  const items = [], order = [];
  let nItems = 0, want = 0;
  const PLAYER = 1, BALL = 2, VNET = 3, HOOP = 4, SPIKENET = 5;
  function item(d, t, a, i) {
    let it = items[nItems];
    if (!it) items[nItems] = it = { d: 0, t: 0, a: null, i: 0 };
    it.d = d; it.t = t; it.a = a; it.i = i;
    nItems++;
    order.push(it);
  }
  const byDepth = (p, q) => q.d - p.d;
  const gx = (V, u, v) => V.cx + u * V.ca - v * V.sa, gy = (V, u, v) => V.cy + u * V.sa + v * V.ca;
  const depthOf = (V, u, v) => gx(V, u, v) * D0 + gy(V, u, v) * D1;
  // CSS px of local (u, v) at height z on venue V
  const Q = [0, 0], Q1 = [0, 0], Q2 = [0, 0], Q3 = [0, 0];
  function sxy(V, u, v, z, out) {
    const x = gx(V, u, v), y = gy(V, u, v);
    out[0] = PA * x + PB * y + PE; out[1] = PC * x + PD * y + PF - PK * z;
    return out;
  }

  function draw(ctx) {
    nItems = 0; order.length = 0; want = 0;
    if (failed || !venues.length) return;
    setCamera();
    const s = SCALE, games = app.layerEnabled("people") && s >= MIN_S;
    if (s < GEAR_S && !games) return;
    const fadeS = Math.min(1, (s - MIN_S) / 0.6);
    let anyMoving = false;
    for (const V of near) {
      if (!onView(V.cx, V.cy, V.rad, 4)) continue;
      const vd = V.cx * D0 + V.cy * D1;
      if (s >= GEAR_S) {
        if (V.hoops) { item(depthOf(V, -(V.L / 2 + 0.35), 0), HOOP, V, -1); item(depthOf(V, V.L / 2 + 0.35, 0), HOOP, V, 1); }
        if (V.kind === "sand" || V.kind === "volley") item(vd, VNET, V, 0);
      }
      const g = V.game;
      if (!games || !g || g.alpha * fadeS <= 0.01) continue;
      anyMoving = true;
      // on a volleyball court the net is long: who is in front of it is a matter of which side they're on
      const net = g.sport === "volley", dU = V.ca * D0 + V.sa * D1;
      for (let i = 0; i < g.P.length; i++) {
        const p = g.P[i];
        let d = depthOf(V, p.u, p.v);
        if (net) d = p.u * dU > 0 ? Math.max(d, vd + 0.01) : Math.min(d, vd - 0.01);
        item(d, PLAYER, g, i);
      }
      if (g.b.st !== NONE) {
        let d = depthOf(V, g.b.u, g.b.v);
        if (net) d = g.b.u * dU > 0 ? Math.max(d, vd + 0.01) : Math.min(d, vd - 0.01);
        item(d, BALL, g, 0);
      }
      if (g.sport === "spike") item(vd, SPIKENET, g, 0);
    }
    if (!nItems) return;
    order.sort(byDepth);
    const close = s >= DETAIL_S, clock = performance.now() / 1000;
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const it of order) {
      const V = it.t === PLAYER || it.t === BALL || it.t === SPIKENET ? it.a.V : it.a;
      const a = it.t === HOOP || it.t === VNET ? Math.min(1, (s - GEAR_S) / 0.8) : it.a.alpha * fadeS;
      if (a <= 0.01) continue;
      if (close) {
        // close up: drawn round the outlines of whatever stands in front of it
        const ids = app.scene ? objectsOver(V) : null;
        if (ids && ids.length) drawCut(ctx, it, a, ids);
        else drawItem(ctx, it, a, true);
      } else if (!hiddenItem(it, V, clock)) drawItem(ctx, it, a, false);   // from afar it's either seen or not
    }
    ctx.restore();
    // a ball flies a few pixels a frame at these rates; the players' legs swing about a stride a second
    if (anyMoving && !reduceMQ.matches) want = s >= DETAIL_S ? 24 : s >= 5 ? 15 : 10;
  }

  // ---------------------------------------------------------------- what stands in front
  // The scene objects whose screen box meets the venue's (up to 5 m high, with room round it), in front of it or not:
  // worked out once per turn of the view (in screen metres, so it holds while the view pans and zooms).
  function objectsOver(V) {
    if (V.occR === ROT) return V.occ;
    const o = geo.ROTS[ROT];
    let X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity;
    for (let c = 0; c < 8; c++) {
      const u = c & 1 ? V.ru + 2 : -V.ru - 2, v = c & 2 ? V.rv + 2 : -V.rv - 2, x = gx(V, u, v), y = gy(V, u, v);
      const X = x * o.R[0] + y * o.R[1], Y = -(x * o.D[0] + y * o.D[1]) * SIN_T - (c & 4 ? 5 : 0) * COS_T;
      if (X < X0) X0 = X; if (X > X1) X1 = X; if (Y < Y0) Y0 = Y; if (Y > Y1) Y1 = Y;
    }
    V.occ = app.scene.query(ROT, "objects", X0, Y0, X1, Y1);
    V.occR = ROT;
    return V.occ;
  }
  // Draw an item through a clip that leaves out the outlines (the renderer's own) of the objects among ids standing in
  // front of it: the tiles beneath already show them there.
  const SIL = makeRecorder(), SIL_EXACT = SIL.withAddPath();
  function drawCut(ctx, it, a, ids) {
    const sc = app.scene, S = sc.forRot(ROT), bb = S.objBB, B = sc.B, T = sc.T, tr = data.trees, s = SCALE;
    boxOf(it);
    const X0 = BOX[0], Y0 = BOX[1], X1 = BOX[2], Y1 = BOX[3];
    const mX0 = (X0 - PE) / s, mY0 = (Y0 - PF) / s, mX1 = (X1 - PE) / s, mY1 = (Y1 - PF) / s;
    SIL.reset();
    let n = 0;
    for (let q = 0; q < ids.length; q++) {
      const id = ids[q], o = 4 * id;
      if (bb[o + 2] < mX0 || bb[o] > mX1 || bb[o + 3] < mY0 || bb[o + 1] > mY1) continue;
      if (!sc.inFront(ROT, id, BOX[4], BOX[5], BOX[6])) continue;
      const conifer = id >= B && id < B + T && (tr[5 * (id - B) + 4] & 1);
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
    // the box a little larger than the clip, so its own edges never show
    for (let p = 0; p < SIL.count; p++) if (SIL.meets(p, X0, Y0, X1, Y1)) SIL.cut(ctx, p, X0 - 2, Y0 - 2, X1 + 2, Y1 + 2);
    drawItem(ctx, it, a, true);
    ctx.restore();
  }
  // the screen box an item may cover (CSS px), and the ground point and half-width it stands at, into BOX
  const BOX = [0, 0, 0, 0, 0, 0, 0];
  function box(x0, y0, x1, y1, V, u, v, hw) {
    BOX[0] = x0 - 1; BOX[1] = y0 - 1; BOX[2] = x1 + 1; BOX[3] = y1 + 1; BOX[4] = gx(V, u, v); BOX[5] = gy(V, u, v); BOX[6] = hw;
  }
  let bx0 = 0, by0 = 0, bx1 = 0, by1 = 0;
  function grow(V, u, v, z) {
    sxy(V, u, v, z, Q);
    if (Q[0] < bx0) bx0 = Q[0]; if (Q[0] > bx1) bx1 = Q[0]; if (Q[1] < by0) by0 = Q[1]; if (Q[1] > by1) by1 = Q[1];
  }
  function boxOf(it) {
    const s = SCALE, k = PK;
    bx0 = by0 = Infinity; bx1 = by1 = -Infinity;
    if (it.t === PLAYER) {
      const g = it.a, p = g.P[it.i], pad = (g.sport === "tennis" || g.sport === "pickle" ? 0.9 : 0.6) * s;
      sxy(g.V, p.u, p.v, 0, Q);
      box(Q[0] - pad, Q[1] - (2.25 + p.z) * k, Q[0] + pad, Q[1] + 0.3 * s, g.V, p.u, p.v, 0.45);
    } else if (it.t === BALL) {
      const g = it.a, b = g.b, r = Math.max(1.3, BALLS[g.ball][1] * s * 1.25) * 1.4 + 1;
      sxy(g.V, b.u, b.v, 0, Q);
      box(Q[0] - r, Q[1] - b.z * k - r, Q[0] + r, Q[1] + r, g.V, b.u, b.v, 0.2);
    } else if (it.t === VNET) {
      const V = it.a, half = V.W / 2 + 0.6;
      for (let c = 0; c < 4; c++) grow(V, 0, c & 1 ? half : -half, c & 2 ? 2.6 : 0);
      box(bx0 - 2, by0 - 2, bx1 + 2, by1 + 2, V, 0, 0, half);
    } else if (it.t === HOOP) {
      const V = it.a, side = it.i, up = side * (V.L / 2 + 0.35), ub = side * (V.L / 2 - 1.2), ur = side * (V.L / 2 - 1.6);
      grow(V, up, 0, 0); grow(V, up, 0, 3.4);
      for (let c = 0; c < 4; c++) grow(V, ub, c & 1 ? 0.9 : -0.9, c & 2 ? 3.95 : 2.9);
      grow(V, ur - 0.3, -0.3, 3.05); grow(V, ur + 0.3, 0.3, 2.6);
      box(bx0 - 2, by0 - 2, bx1 + 2, by1 + 2, V, up, 0, 1);
    } else {
      const V = it.a.V, rx = Math.max(1.5, 0.46 * s) + 1;
      sxy(V, 0, 0, 0.3, Q);
      box(Q[0] - rx, Q[1] - rx * SIN_T, Q[0] + rx, Q[1] + rx * SIN_T + 0.3 * k + 1, V, 0, 0, 0.5);
    }
  }
  // from afar: a building or a leafy crown in front of the middle of it (checked every half second or so)
  function hiddenItem(it, V, clock) {
    if (!app.scene) return false;
    if (it.t === HOOP || it.t === VNET || it.t === SPIKENET) {
      if (V.hidR !== ROT) { V.hid = pointHidden(V.cx, V.cy, 2); V.hidR = ROT; }
      return V.hid;
    }
    const o = it.t === PLAYER ? it.a.P[it.i] : it.a.b;
    if (clock >= o.hidT) {
      o.hid = pointHidden(gx(V, o.u, o.v), gy(V, o.u, o.v), it.t === PLAYER ? 1.7 : 0.4);
      o.hidT = clock + 0.45 + Math.random() * 0.2;
    }
    return o.hid;
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
    switch (it.t) {
      case PLAYER: drawPlayer(ctx, it.a, it.a.P[it.i], a, close); break;
      case BALL: drawBall(ctx, it.a, a, close); break;
      case VNET: drawVNet(ctx, it.a, a); break;
      case HOOP: drawHoop(ctx, it.a, it.i, a); break;
      case SPIKENET: drawSpikeNet(ctx, it.a, a); break;
    }
  }

  function drawPlayer(ctx, g, p, a, close) {
    const V = g.V, s = SCALE, k = PK;
    sxy(V, p.u, p.v, 0, Q);
    const px = Q[0], py = Q[1], lift = p.z * k;
    ctx.globalAlpha = a;
    const bw = Math.max(1, 0.46 * s), lw = Math.max(0.6, (close ? 0.16 : 0.17) * s);
    const running = p.mv > 0.3 && p.z <= 0;
    if (!close) {
      // a few pixels: shadow, legs, shirt, head (as life.js draws walkers from afar)
      const hs = Math.max(1, 0.26 * s), sw = running ? Math.sin(p.ph) * 0.16 * s : 0, top = py - lift - 0.86 * k;
      ctx.fillStyle = SHADOW; ctx.globalAlpha = a * 0.22; ctx.fillRect(px - bw * 0.3, py - 0.12 * s, bw * 1.3, 0.3 * s); ctx.globalAlpha = a;
      ctx.fillStyle = p.bare ? p.skin : p.legs;
      ctx.fillRect(px - bw * 0.42 + sw, top, lw, 0.86 * k); ctx.fillRect(px + bw * 0.42 - lw - sw, top, lw, 0.86 * k);
      if (p.bare) { ctx.fillStyle = p.legs; ctx.fillRect(px - bw * 0.5, top, bw, 0.34 * k); }
      ctx.fillStyle = p.col; ctx.fillRect(px - bw / 2, py - lift - 1.42 * k, bw, 0.62 * k);
      if (s >= 5 && (p.pose === REACH || p.pose === SPIKE)) { ctx.fillRect(px - bw * 0.5, py - lift - 2.05 * k, lw, 0.65 * k); if (p.pose === REACH) ctx.fillRect(px + bw * 0.5 - lw, py - lift - 2.05 * k, lw, 0.65 * k); }
      ctx.fillStyle = p.skin; ctx.fillRect(px - hs / 2, py - lift - 1.44 * k - hs, hs, hs);
      return;
    }
    const hx = p.fu * V.ca - p.fv * V.sa, hy = p.fu * V.sa + p.fv * V.ca;   // facing on the ground
    const hsx = PA * hx + PB * hy, hsy = PC * hx + PD * hy;                 // …on screen, px per metre
    const away = hx * D0 + hy * D1 > 0;
    // shadow on the ground (smaller in the air)
    ctx.globalAlpha = a * 0.22; ctx.fillStyle = SHADOW;
    const sr = 0.32 * s * (1 - Math.min(0.35, p.z * 0.6));
    ctx.beginPath(); ctx.ellipse(px + 0.18 * s, py + 0.02 * s, sr, sr * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = a;
    const y0 = py - lift;
    // legs: a stride when running, tucked in the air; shorts over bare legs in the warm
    const sw = running ? Math.sin(p.ph) * 0.15 : 0, lx = hsx * sw, ly = hsy * sw, tuck = p.z > 0.05 ? 0.12 * k : 0;
    const legH = 0.86 * k - tuck;
    ctx.fillStyle = p.bare ? p.skin : p.legs;
    ctx.fillRect(px - bw * 0.45 + lx, y0 + ly - 0.86 * k, lw, legH);
    ctx.fillRect(px + bw * 0.45 - lw - lx, y0 - ly - 0.86 * k, lw, legH);
    if (p.bare) { ctx.fillStyle = p.legs; ctx.fillRect(px - bw * 0.5, y0 - 0.86 * k, bw, 0.36 * k); }
    if (s >= 13) {
      ctx.fillStyle = "#2a2a2e";
      ctx.fillRect(px - bw * 0.45 + lx, y0 + ly - 0.1 * k - tuck, lw * 1.1, 0.1 * k);
      ctx.fillRect(px + bw * 0.45 - lw - lx, y0 - ly - 0.1 * k - tuck, lw * 1.1, 0.1 * k);
    }
    const z0 = 0.8, z1 = 1.44;
    const racket = g.sport === "tennis" || g.sport === "pickle";
    // arms reaching forward show behind the body when seen from behind
    if (away) drawArms(ctx, g, p, px, y0, hsx, hsy, bw, z1, racket);
    ctx.fillStyle = p.col;
    roundRectFill(ctx, px - bw / 2, y0 - z1 * k, bw, (z1 - z0) * k + 0.05 * s, 0.14 * s);
    if (s >= 12) { ctx.fillStyle = "rgba(30,30,40,.18)"; ctx.fillRect(px, y0 - z1 * k + 0.08 * s, bw / 2, (z1 - z0) * k - 0.04 * s); }
    if (!away) drawArms(ctx, g, p, px, y0, hsx, hsy, bw, z1, racket);
    // head and hair
    const hr = 0.13 * s, hzc = z1 + 0.15;
    ctx.fillStyle = p.skin;
    ctx.beginPath(); ctx.arc(px, y0 - hzc * k, hr, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = p.hair;
    ctx.beginPath();
    if (away) ctx.arc(px, y0 - hzc * k, hr * 1.02, 0, Math.PI * 2);
    else ctx.arc(px, y0 - hzc * k - hr * 0.1, hr * 1.02, Math.PI * 1.02, Math.PI * 1.98);
    ctx.fill();
  }
  // Arms by pose, as strokes from the shoulders; a racket or paddle in the playing hand on a tennis court.
  function drawArms(ctx, g, p, px, y0, hsx, hsy, bw, z1, racket) {
    const s = SCALE, k = PK, ps = p.pose;
    if (ps === READY && !racket) return;
    const shY = y0 - (z1 - 0.1) * k, side = p.lefty ? -1 : 1, lx = px - bw * 0.42, rx = px + bw * 0.42;
    // hand positions (CSS px)
    let ax = lx, ay = shY + 0.55 * k, bx = rx, by = shY + 0.55 * k, both = true;
    switch (ps) {
      case REACH: ax = px - 0.12 * s + hsx * 0.1; ay = y0 - 2.05 * k; bx = px + 0.12 * s + hsx * 0.1; by = ay; break;
      case SPIKE: bx = px + side * 0.12 * s + hsx * 0.2; by = y0 - 2.15 * k; both = false; break;
      case THROW: bx = px + side * 0.2 * s - hsx * 0.25; by = y0 - 1.95 * k; ax = px + hsx * 0.3 - side * 0.1 * s; ay = shY + hsy * 0.3 + 0.1 * k; break;
      case BUMP: ax = bx = px + hsx * 0.38; ay = by = y0 - 0.98 * k; break;
      case HOLD: ax = px + hsx * 0.3 - 0.08 * s; bx = px + hsx * 0.3 + 0.08 * s; ay = by = y0 - 1.15 * k + hsy * 0.3; break;
      case DRIBBLE: bx = px + side * bw * 0.6 + hsx * 0.25; by = y0 - 0.95 * k + hsy * 0.25; both = false; break;
      case SWING: bx = px + side * 0.55 * s + hsx * 0.2; by = y0 - 1.05 * k; both = false; break;
      default: bx = px + side * bw * 0.62; by = y0 - 0.95 * k; both = false;   // a racket held at the side
    }
    ctx.strokeStyle = p.bare ? p.skin : p.col; ctx.lineWidth = Math.max(1, 0.11 * s);
    ctx.beginPath();
    ctx.moveTo(side > 0 ? rx : lx, shY); ctx.lineTo(bx, by);
    if (both) { ctx.moveTo(side > 0 ? lx : rx, shY); ctx.lineTo(ax, ay); }
    ctx.stroke();
    if (racket) {
      // the racket (a frame on a handle) or the paddle, out from the hand
      const pk = g.sport === "pickle", dx = ps === SWING ? side * 0.32 * s : side * 0.08 * s, dy = ps === SWING ? -0.05 * k : 0.3 * k;
      ctx.strokeStyle = "#2d2f34"; ctx.lineWidth = Math.max(0.8, 0.05 * s);
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + dx * 0.5, by + dy * 0.5); ctx.stroke();
      ctx.fillStyle = pk ? "#3d5f8a" : "rgba(240,238,230,.55)";
      ctx.beginPath(); ctx.ellipse(bx + dx, by + dy, (pk ? 0.1 : 0.13) * s, (pk ? 0.11 : 0.15) * s, 0, 0, Math.PI * 2); ctx.fill();
      if (!pk) { ctx.strokeStyle = "#b3202a"; ctx.lineWidth = Math.max(0.6, 0.03 * s); ctx.stroke(); }
    }
  }

  function drawBall(ctx, g, a, close) {
    const V = g.V, b = g.b, s = SCALE, [col, r] = BALLS[g.ball];
    sxy(V, b.u, b.v, 0, Q);
    const gxp = Q[0], gyp = Q[1], py = gyp - b.z * PK;
    if (!close && s < 3) return;
    if (close && b.z > 0.05) {
      ctx.globalAlpha = a * 0.2 * Math.max(0.3, 1 - b.z / 6); ctx.fillStyle = SHADOW;
      ctx.beginPath(); ctx.ellipse(gxp, gyp, Math.max(1, r * s * 1.1), Math.max(0.5, r * s * 0.55), 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = a;
    const R = Math.max(close ? 1.3 : 1, r * s * 1.25);
    ctx.fillStyle = col;
    ctx.beginPath();
    if (g.ball === "frisbee") ctx.ellipse(gxp, py, R, R * 0.42, 0, 0, Math.PI * 2);
    else if (g.ball === "football") {
      // pointed along its flight on screen
      const f = g.f, du = f.u1 - f.u0, dv = f.v1 - f.v0, ex = du * V.ca - dv * V.sa, ey = du * V.sa + dv * V.ca;
      const dx = PA * ex + PB * ey, dy = PC * ex + PD * ey;
      ctx.ellipse(gxp, py, R * 1.35, R * 0.85, b.st === FLY ? Math.atan2(dy, dx) : 0, 0, Math.PI * 2);
    } else ctx.arc(gxp, py, R, 0, Math.PI * 2);
    ctx.fill();
    if (close && s >= 12) {
      if (g.ball === "frisbee") { ctx.strokeStyle = "#b3202a"; ctx.lineWidth = Math.max(0.6, 0.025 * s); ctx.stroke(); }
      else if (g.ball === "hoops" || g.ball === "volley") {
        ctx.strokeStyle = g.ball === "hoops" ? "rgba(40,30,25,.6)" : "rgba(60,90,160,.45)"; ctx.lineWidth = Math.max(0.5, 0.02 * s);
        ctx.beginPath(); ctx.moveTo(gxp - R, py); ctx.lineTo(gxp + R, py); ctx.stroke();
      }
    }
  }

  // a volleyball net: two posts, a band of mesh with a white tape along the top
  function drawVNet(ctx, V, a) {
    const s = SCALE, half = V.W / 2 + 0.6, top = 2.43, bot = 1.43;
    ctx.globalAlpha = a;
    ctx.strokeStyle = "#5d6066"; ctx.lineWidth = Math.max(1, 0.1 * s);
    ctx.beginPath();
    for (let sg = -1; sg <= 1; sg += 2) { sxy(V, 0, sg * half, 0, Q); sxy(V, 0, sg * half, 2.55, Q1); ctx.moveTo(Q[0], Q[1]); ctx.lineTo(Q1[0], Q1[1]); }
    ctx.stroke();
    sxy(V, 0, -half, top, Q); sxy(V, 0, half, top, Q1); sxy(V, 0, half, bot, Q2); sxy(V, 0, -half, bot, Q3);
    ctx.fillStyle = "rgba(40,44,48,.2)";
    ctx.beginPath(); ctx.moveTo(Q[0], Q[1]); ctx.lineTo(Q1[0], Q1[1]); ctx.lineTo(Q2[0], Q2[1]); ctx.lineTo(Q3[0], Q3[1]); ctx.fill();
    if (s >= 6) {
      ctx.strokeStyle = "rgba(40,44,48,.35)"; ctx.lineWidth = Math.max(0.5, 0.03 * s);
      ctx.beginPath();
      for (let z = bot + 0.25; z < top - 0.1; z += 0.25) { const u = (z - bot) / (top - bot); ctx.moveTo(Q3[0] + (Q[0] - Q3[0]) * u, Q3[1] + (Q[1] - Q3[1]) * u); ctx.lineTo(Q2[0] + (Q1[0] - Q2[0]) * u, Q2[1] + (Q1[1] - Q2[1]) * u); }
      if (s >= 12) for (let t = 0.05; t < 1; t += 0.05) { ctx.moveTo(Q[0] + (Q1[0] - Q[0]) * t, Q[1] + (Q1[1] - Q[1]) * t); ctx.lineTo(Q3[0] + (Q2[0] - Q3[0]) * t, Q3[1] + (Q2[1] - Q3[1]) * t); }
      ctx.stroke();
    }
    ctx.strokeStyle = "#f4f2ec"; ctx.lineWidth = Math.max(0.8, 0.07 * s);
    ctx.beginPath(); ctx.moveTo(Q[0], Q[1]); ctx.lineTo(Q1[0], Q1[1]); ctx.stroke();
  }

  // a basketball hoop: a post behind the baseline, an arm out to the backboard, the rim (and a net close up)
  function drawHoop(ctx, V, side, a) {
    const s = SCALE, up = side * (V.L / 2 + 0.35), ub = side * (V.L / 2 - 1.2), ur = side * (V.L / 2 - 1.6);
    ctx.globalAlpha = a;
    ctx.strokeStyle = "#55585e"; ctx.lineWidth = Math.max(1, 0.13 * s);
    ctx.beginPath();
    sxy(V, up, 0, 0, Q); ctx.moveTo(Q[0], Q[1]);
    sxy(V, up, 0, 3.35, Q); ctx.lineTo(Q[0], Q[1]);
    sxy(V, ub, 0, 3.35, Q); ctx.lineTo(Q[0], Q[1]);
    ctx.stroke();
    // the backboard
    sxy(V, ub, -0.9, 3.95, Q); sxy(V, ub, 0.9, 3.95, Q1); sxy(V, ub, 0.9, 2.9, Q2); sxy(V, ub, -0.9, 2.9, Q3);
    ctx.fillStyle = "#f4f2ec";
    ctx.beginPath(); ctx.moveTo(Q[0], Q[1]); ctx.lineTo(Q1[0], Q1[1]); ctx.lineTo(Q2[0], Q2[1]); ctx.lineTo(Q3[0], Q3[1]); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#8a8d92"; ctx.lineWidth = Math.max(0.6, 0.04 * s); ctx.stroke();
    if (s >= 6) {
      ctx.strokeStyle = "#c4553a"; ctx.lineWidth = Math.max(0.5, 0.035 * s);
      ctx.beginPath();
      sxy(V, ub, -0.3, 3.5, Q); ctx.moveTo(Q[0], Q[1]); sxy(V, ub, 0.3, 3.5, Q); ctx.lineTo(Q[0], Q[1]);
      sxy(V, ub, 0.3, 3.05, Q); ctx.lineTo(Q[0], Q[1]); sxy(V, ub, -0.3, 3.05, Q); ctx.lineTo(Q[0], Q[1]); ctx.closePath();
      ctx.stroke();
    }
    // the rim, a ring in the horizontal plane
    sxy(V, ur, 0, 3.05, Q);
    const rx = Math.max(1.2, 0.23 * s), ry = rx * SIN_T;
    if (s >= 8) {
      ctx.strokeStyle = "rgba(245,245,240,.75)"; ctx.lineWidth = Math.max(0.5, 0.025 * s);
      ctx.beginPath();
      for (let q = 0; q < 6; q++) { const t = (q / 6) * Math.PI * 2, cx = Math.cos(t), cy = Math.sin(t); ctx.moveTo(Q[0] + cx * rx, Q[1] + cy * ry); ctx.lineTo(Q[0] + cx * rx * 0.6, Q[1] + cy * ry * 0.6 + 0.4 * PK); }
      ctx.stroke();
    }
    ctx.strokeStyle = "#d4562a"; ctx.lineWidth = Math.max(0.8, 0.05 * s);
    ctx.beginPath(); ctx.ellipse(Q[0], Q[1], rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  }

  // a spikeball net: a little round trampoline, black with a yellow rim, on short legs
  function drawSpikeNet(ctx, g, a) {
    const V = g.V, s = SCALE;
    sxy(V, 0, 0, 0.3, Q);
    const rx = Math.max(1.5, 0.46 * s), ry = rx * SIN_T, legH = 0.3 * PK;
    ctx.globalAlpha = a;
    if (s >= 5) {
      ctx.strokeStyle = "#2b2b2e"; ctx.lineWidth = Math.max(0.6, 0.04 * s);
      ctx.beginPath();
      for (let q = 0; q < 5; q++) { const t = (q / 5) * Math.PI * 2 + 0.3, cx = Math.cos(t), cy = Math.sin(t); if (cy < -0.2) continue; ctx.moveTo(Q[0] + cx * rx, Q[1] + cy * ry); ctx.lineTo(Q[0] + cx * rx * 1.05, Q[1] + cy * ry * 1.05 + legH); }
      ctx.stroke();
    }
    ctx.fillStyle = "#2e3034";
    ctx.beginPath(); ctx.ellipse(Q[0], Q[1], rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#f0c419"; ctx.lineWidth = Math.max(0.8, 0.07 * s); ctx.stroke();
  }

  // ================================================================================================ wiring
  app.on("frame", (f) => {
    if (failed) return;
    try {
      manage(false);
      if (!reduceMQ.matches) stepAll(f.dt);
    } catch (e) {
      // a broken game should not spam the console every frame: report once, then rest
      failed = true; dropAll();
      console.error("sports: games stopped", e);
    }
  });
  // with the map asleep (nothing moving on screen), a game that starts in view still has to wake it
  setInterval(() => { if (!failed && !document.hidden) { try { manage(false); } catch (e) { failed = true; console.error("sports: games stopped", e); } } }, 1000);
  // the players are people: they come and go with the walkers' switch
  app.on("layers", (p) => { if (p && p.id === "people") { if (!p.on) dropAll(); tickAt = -1e9; app.requestRender("sports"); } });
  app.on("rotate", () => { for (const V of venues) { V.occR = -1; V.occ = null; V.hidR = -1; } });

  app.addLayer({ id: "courts", z: 34, fps: () => want, draw: (ctx) => draw(ctx) });

  app.sports = {
    get games() { let n = 0; for (const V of near) if (V.game) n++; return n; },
    debug: {
      conditions: C,
      get venues() { return venues.length; },
      // what's on near the view: sport, players, where (for tests: fly there and look)
      list() {
        return near.filter((V) => V.game).map((V) => {
          const [lat, lon] = geo.toLatLon(V.cx, V.cy), g = V.game;
          return { sport: NAMES[g.sport], kind: V.kind, players: g.P.length, lat: +lat.toFixed(6), lon: +lon.toFixed(6), ball: ["none", "held", "flying", "loose"][g.b.st], phase: g.phase || "",
            sig: `${g.b.st}|${g.b.by}|${g.b.st === FLY ? g.f.kind + g.f.to : ""}|${g.phase || ""}|${g.fetch}` };
        });
      },
      // every venue and its share now
      venues() {
        return venues.map((V) => { const [lat, lon] = geo.toLatLon(V.cx, V.cy); return { kind: V.kind, lat: +lat.toFixed(6), lon: +lon.toFixed(6), p: +V.p.toFixed(3), line: V.line, round: V.round }; });
      },
      // run the games on for sec seconds without drawing; any player or ball off its venue, or not a number, is reported
      advance(sec, dt = 0.05) {
        const bad = [];
        for (let t = 0; t < sec; t += dt) {
          stepAll(dt);
          for (const V of near) {
            const g = V.game;
            if (!g) continue;
            for (const p of g.P) if (!Number.isFinite(p.u + p.v + p.z) || Math.abs(p.u) > V.ru + 12 || Math.abs(p.v) > V.rv + 12) bad.push({ sport: g.sport, u: p.u, v: p.v });
            if (!Number.isFinite(g.b.u + g.b.v + g.b.z)) bad.push({ sport: g.sport, ball: true });
          }
          if (bad.length > 20) break;
        }
        return { games: this.list().length, bad };
      },
      // start a game of `sport` on every venue near the view that it can be played on (for tests)
      force(sport) {
        const fits = { touch: ["field"], ultimate: ["field"], hoops: ["full", "half"], volley: ["sand", "volley"], tennis: ["tennis"], pickle: ["tennis"], football: ["lawn"], frisbee: ["lawn"], spike: ["lawn"] }[sport] || [];
        let n = 0;
        for (const V of near) if (fits.includes(V.kind) && (V.kind !== "lawn" || sport === "spike" ? V.kind !== "lawn" || V.round : V.line) && !(V.kind === "full" && V.small)) { V.game = newGame(V, n++, sport); }
        return n;
      },
      searchAll() { for (const L of lawns) if (!L.done) searchLawn(L); return venues.length; },
      // how many venues of each kind are in use now, campus-wide (searched lawns only), and the share expected
      census() {
        readConditions();
        const tMin = app.now().getTime() / 60000, out = {};
        for (const V of venues) V.p = shareOf(V);
        for (const V of venues) {
          const o = (out[V.kind] ||= { venues: 0, busy: 0, expected: 0 });
          o.venues++; o.expected += V.p;
          if (wanted(V, tMin)) o.busy++;
        }
        for (const k in out) out[k].expected = +out[k].expected.toFixed(1);
        return { conditions: { ...C }, kinds: out };
      },
    },
  };
  Object.defineProperty(app.sports, "debug", { enumerable: false });
}

// ------------------------------------------------------------------------------------------------ helpers
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function smooth(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
function segDist(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / L, 0, 1) : 0;
  return Math.hypot(x - ax - dx * t, y - ay - dy * t);
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
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); else ctx.rect(x, y, w, h);
  ctx.fill();
}
function hashInt(a, b) {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}
const hash01 = (a, b) => hashInt(a, b) / 4294967296;
// a small seeded generator (mulberry32): a game's draws repeat for the same venue and hour
function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
