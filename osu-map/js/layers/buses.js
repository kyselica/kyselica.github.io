// Live CABS buses: Ohio State's campus bus system on the map.
//
// Data (no key, CORS open): https://content.osu.edu/v2/bus. The route list and each route's shapes and stops are re-read
// every 30 min (a route's sooner when a bus reports a pattern we lack), and every route's vehicles every ~8 s,
// staggered so requests trickle rather than burst. Polling pauses while the tab is hidden and backs off exponentially
// on errors; a local snapshot stands in for routes and stops when the API is down. ?buses=mock drives synthetic buses
// through the very same ingest pipeline, so everything is testable at any hour.
//
// Units, checked against the live API: pattern "length" and vehicle "distance" are FEET along the pattern (decoded
// polylines measure 1.00–1.02 × length·0.3048), so distances are scaled by each pattern's measured length / length,
// then mapped onto the cleaned line we draw and drive (see dropSpurs).
//
// Layers: "routes" z 10 (route lines on the ground: cached overlay tiles with the buildings and trees that stand on them
// painted back over, so lines run under things like the streets do) · "stops" z 20 · "buses" z 50 (3D buses, back to
// front, each followed by app.occlude) · "bus-lights" z 84 (lit windows and headlights at night) · "bus-tags" z 92
// (far-zoom markers, route pills, hover labels: above the night tint so they stay legible).
// Publishes app.transit (ARCHITECTURE.md) and emits "transit" after every update.

import { decodePolyline } from "../core/geo.js";
import { TS } from "../core/render.js";

const API = "https://content.osu.edu/v2/bus";
const SNAPSHOT = "data/cabs-snapshot.json";
const POLL_MS = 8000;
const LIST_MS = 30 * 60 * 1000;
const STALE_MS = 3 * 60 * 1000, DROP_MS = 10 * 60 * 1000;
const FT = 0.3048, MPH = 0.44704;
const SNAP_M = 40;        // farther than this from its pattern, a bus is off route and placed where it says it is
const AHEAD_M = 120;      // dead reckoning never runs further than this past the last report
const CATCH_M = 150;      // a bus further than this behind its report fades over instead of driving there
const BACK_M = 60, HOLD_M = 25;   // nor does one this far ahead of it reverse (a stopped one: HOLD_M); less, it holds
const QUIET_MS = 25000;   // a fix after this long unlisted (a hidden tab, failing polls) is of unknown age
const LANE = 1.6;         // buses keep right of the route's centre line
const BUS = { L: 12, W: 2.55, H: 2.85, clear: 0.32 };   // a 40-ft transit bus; H is the body above its ground clearance
const MARKER_S = 1.2;     // below this scale a bus is a round route marker
const POLE_S = 1.6;       // below this scale a stop is a dot
const TILE_Z0 = 0;        // overlay tiles from this tile level up; coarser views draw lines directly (cheap there)
const HALO = "rgba(251, 248, 241, .82)";
const BODY = "#f2eee4", ROOF = "#dedad0", GLASS = "#33404a", GLASS_LIT = "#c4a064", TYRE = "#2b2a2c";
const LIGHT_U = -0.85, LIGHT_V = -0.52;   // toward the light in the camera's (right, depth) frame, as render.js
const SH_U = 0.62, SH_V = 0.36;           // a metre of height's shadow, same frame

// ------------------------------------------------------------------------------------------------ small helpers
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cleanText = (s, max = 80) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const angDiff = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;   // a − b in (−180, 180]
const wrapDelta = (dd, len) => { dd %= len; if (dd > len / 2) dd -= len; else if (dd < -len / 2) dd += len; return dd; };
const popcount = (m) => { let c = 0; while (m) { m &= m - 1; c++; } return c; };
function hexColor(c, fallback) {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(c || "").trim());
  if (!m) return fallback;
  const h = m[1].length === 3 ? m[1].replace(/./g, (ch) => ch + ch) : m[1];
  return "#" + h.toLowerCase();
}
const luma = (hex) => { const n = parseInt(hex.slice(1), 16); return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255; };
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

export function init(app) {
  const { geo, view } = app;
  const { SIN_T, COS_T } = geo;
  const UI = () => app.ui || null;
  // The map is a slab cut out of the city; a route that runs off it (AIR goes to the airport) is drawn up to its edge,
  // and its buses and stops out there are not drawn at all.
  const W = app.data.world;
  const offSlab = (x, y) => (W ? Math.max(W.x0 - x, x - W.x1, W.y0 - y, y - W.y1) : -1);
  // ?buses=mock: synthetic buses; ?buses=mock-nospeed: the shuttle sends no speed or heading, as it once did
  const mockMode = /^mock(-nospeed)?$/i.test(app.params.get("buses") || "");
  const mockNoSpeed = mockMode && /nospeed/i.test(app.params.get("buses"));
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  linkCss();

  // ------------------------------------------------------------------------------------------------ state
  const routes = [];                 // public, in API order: { code, name, color, darkColor, patterns, stops, … }
  const routeBy = new Map();
  const stops = new Map();           // id → { id, name, lat, lon, routes: [codes], x, y }
  let stopList = [], slabStops = [];   // every stop (for search), and those on the slab (drawn)
  const vehicles = [];               // public: one stable object per bus
  const tracks = new Map();          // id → the bus's motion model (pub is its public object)
  let geomVer = 0;
  let skew = 0, skewSet = false;     // server clock − ours, from the API's lastModified
  const serverNow = () => Date.now() + skew;

  // scratch points (no allocation in the per-frame paths)
  const P = { x: 0, y: 0, tx: 1, ty: 0 }, A = { x: 0, y: 0, tx: 1, ty: 0 }, B = { x: 0, y: 0, tx: 1, ty: 0 }, Q = { d: 0, dist: 0 };

  // the per-frame affine map ground (x, y, z) → CSS px: px = a·x + b·y + c, py = d·x + e·y + f + zf·z
  const cam = { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0, zf: -1, s: 1, r: 0, w: 1, h: 1, dpr: 1, R0: 1, R1: 0, D0: 0, D1: 1 };
  function setCam() {
    const o = geo.ROTS[view.rot], s = view.s;
    cam.R0 = o.R[0]; cam.R1 = o.R[1]; cam.D0 = o.D[0]; cam.D1 = o.D[1];
    cam.a = s * o.R[0]; cam.b = s * o.R[1]; cam.c = view.w / 2 - s * view.X;
    cam.d = -s * SIN_T * o.D[0]; cam.e = -s * SIN_T * o.D[1]; cam.f = view.h / 2 - s * view.Y;
    cam.zf = -s * COS_T; cam.s = s; cam.r = view.rot; cam.w = view.w; cam.h = view.h; cam.dpr = view.dpr;
  }
  // the ground transform on a context (draw in metres, like render.js setWorld)
  const groundXform = (ctx) => { const k = cam.dpr; ctx.setTransform(k * cam.a, k * cam.d, k * cam.b, k * cam.e, k * cam.c, k * cam.f); };
  // the ground box seen on screen (with a margin), for culling
  function viewGroundBox(margin) {
    const s = view.s, X0 = view.X - view.w / 2 / s, X1 = view.X + view.w / 2 / s, Y0 = view.Y - view.h / 2 / s, Y1 = view.Y + view.h / 2 / s;
    return groundBoxOf(view.rot, X0, Y0, X1, Y1, margin);
  }
  function groundBoxOf(r, X0, Y0, X1, Y1, margin) {
    const c = [geo.unproj(X0, Y0, r, 0), geo.unproj(X1, Y0, r, 0), geo.unproj(X1, Y1, r, 0), geo.unproj(X0, Y1, r, 0)];
    return [Math.min(c[0][0], c[1][0], c[2][0], c[3][0]) - margin, Math.min(c[0][1], c[1][1], c[2][1], c[3][1]) - margin,
      Math.max(c[0][0], c[1][0], c[2][0], c[3][0]) + margin, Math.max(c[0][1], c[1][1], c[2][1], c[3][1]) + margin];
  }
  const boxesMeet = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

  // shaded colours, cached per base colour (a face's light is quantised to 1/40)
  const toneCache = new Map();
  function tone(hex, f) {
    let arr = toneCache.get(hex);
    if (!arr) { arr = new Array(64); toneCache.set(hex, arr); }
    const q = clamp(Math.round(f * 40), 0, 63);
    return arr[q] || (arr[q] = app.shade(hex, q / 40));
  }

  // ------------------------------------------------------------------------------------------------ patterns
  // CABS polylines often run a few metres out to a stop and straight back (63 such reversals of 3–18 m across the
  // network). Drawn with a side offset a reversal flares into a big arrowhead, and driven it makes the bus shuffle
  // sideways and back, so a vertex where the line turns back on itself with both legs short is dropped, repeatedly
  // (nested out-and-backs fold away too), and so is a vertex left within a metre of the one before. Longer reversals,
  // a real turnaround at the end of a street, stay.
  const SPUR_M = 40, SPUR_COS = -0.866;   // both legs shorter than this, and a turn sharper than 150°
  function dropSpurs(xs) {
    let idx = Array.from({ length: xs.length / 2 }, (_, i) => i);
    for (let changed = true; changed && idx.length > 2;) {
      changed = false;
      const out = [idx[0]];
      for (let k = 1; k < idx.length - 1; k++) {
        const a = out[out.length - 1], b = idx[k], c = idx[k + 1];
        const ax = xs[2 * b] - xs[2 * a], ay = xs[2 * b + 1] - xs[2 * a + 1], bx = xs[2 * c] - xs[2 * b], by = xs[2 * c + 1] - xs[2 * b + 1];
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        if (la < 1 || (la < SPUR_M && lb < SPUR_M && ax * bx + ay * by < SPUR_COS * la * lb)) { changed = true; continue; }
        out.push(b);
      }
      const last = idx[idx.length - 1], prev = out[out.length - 1];
      if (out.length > 1 && Math.hypot(xs[2 * last] - xs[2 * prev], xs[2 * last + 1] - xs[2 * prev + 1]) < 1) { out.pop(); changed = true; }
      out.push(last);
      idx = out;
    }
    return idx;
  }
  // piecewise-linear map of v from the breakpoints src to dst (both ascending), carried on 1:1 past either end
  function remap(src, dst, v) {
    const n = src.length;
    if (v <= src[0]) return dst[0] + (v - src[0]);
    if (v >= src[n - 1]) return dst[n - 1] + (v - src[n - 1]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (src[m] <= v) lo = m; else hi = m; }
    const L = src[hi] - src[lo];
    return dst[lo] + (L > 0 ? ((v - src[lo]) / L) * (dst[hi] - dst[lo]) : 0);
  }
  /** metres along the drawn pattern for the API's "distance" (feet along its raw polyline), and back */
  const fromFeet = (p, ft) => remap(p.rawCum, p.cum, ft * p.scale);
  const toFeet = (p, d) => remap(p.cum, p.rawCum, d) / p.scale;

  function makePattern(raw, route) {
    const enc = raw && typeof raw.encodedPolyline === "string" ? raw.encodedPolyline : "";
    if (!enc) return null;
    let pts;
    try { pts = decodePolyline(enc); } catch { return null; }
    const ll0 = [], xs = [];
    for (const [lat, lon] of pts) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat - geo.origin.lat) > 0.3 || Math.abs(lon - geo.origin.lon) > 0.3) continue;
      const [x, y] = geo.toXY(lat, lon), n = xs.length;
      if (n && Math.hypot(x - xs[n - 2], y - xs[n - 1]) < 0.3) continue;
      ll0.push([lat, lon]); xs.push(x, y);
    }
    if (xs.length < 4) return null;
    // the raw polyline's own length, which the API's distances are measured along
    const rawAt = [0];
    let rawLen = 0;
    for (let i = 2; i < xs.length; i += 2) rawAt.push(rawLen += Math.hypot(xs[i] - xs[i - 2], xs[i + 1] - xs[i - 1]));
    // A loop: the ends meet, or the API calls it circular. The WMC shuttle's polyline is sometimes served ~180 m short
    // of closing on itself; left open, a stretch of its line would be missing and a bus would stop at the end and
    // reappear at the start, so the loop is closed: along the streets that join the two ends (a straight leg would cut
    // up to 60 m across the hospital blocks), else straight. The API's distances never reach into the added leg.
    const k = xs.length;
    const gap = Math.hypot(xs[0] - xs[k - 2], xs[1] - xs[k - 1]);
    const circular = /circ|loop/i.test(String(raw.direction || ""));
    const closed = gap < 30 || (circular && gap < 600);
    const patched = closed && gap >= 30;
    if (closed && gap >= 1) {
      const leg = patched ? streetLeg(xs) : null;
      const add = leg ? [...leg, xs[0], xs[1]] : [xs[0], xs[1]];
      for (let i = 0; i < add.length; i += 2) {
        const n = xs.length;
        rawAt.push(rawAt[rawAt.length - 1] + Math.hypot(add[i] - xs[n - 2], add[i + 1] - xs[n - 1]));
        xs.push(add[i], add[i + 1]); ll0.push(geo.toLatLon(add[i], add[i + 1]));
      }
    }
    const keep = dropSpurs(xs);
    const ll = keep.map((i) => ll0[i]), xyL = [], rawL = [];
    for (const i of keep) { xyL.push(xs[2 * i], xs[2 * i + 1]); rawL.push(rawAt[i]); }
    const n = xyL.length / 2;
    if (n < 2) return null;
    const xy = Float64Array.from(xyL), cum = new Float64Array(n), rawCum = Float64Array.from(rawL);
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      if (i) cum[i] = cum[i - 1] + Math.hypot(xy[2 * i] - xy[2 * i - 2], xy[2 * i + 1] - xy[2 * i - 1]);
      bbox[0] = Math.min(bbox[0], xy[2 * i]); bbox[1] = Math.min(bbox[1], xy[2 * i + 1]);
      bbox[2] = Math.max(bbox[2], xy[2 * i]); bbox[3] = Math.max(bbox[3], xy[2 * i + 1]);
    }
    const len = cum[n - 1];
    if (len < 20) return null;
    const lengthFt = +raw.length;
    // reported feet → metres along the raw polyline; a nonsense length (WMC says 1) falls back to plain feet
    const scale = lengthFt > 0 && Math.abs(rawLen / FT / lengthFt - 1) < 0.2 ? rawLen / lengthFt : FT;
    return { id: cleanText(raw.id, 24), direction: cleanText(raw.direction, 20), pts: ll, xy, cum, rawCum, n, len, lengthFt: lengthFt > 1 ? lengthFt : rawLen / FT, scale, closed, patched, bbox, route, stopsAlong: [], slow: [], rs: null, dest: "" };
  }

  // The way along the street graph from the end of an unclosed loop xs (flat x, y) back to its start, as flat x, y
  // points: the shortest (one-way rules aside: it only draws a missing piece), joining the streets ahead of the line's
  // end and leaving them before the line's start so neither join doubles back. Null when no junction is near both
  // ends, or the way round is long.
  let driveAdj = null;
  function streetLeg(xs) {
    const G = app.data && app.data.drive;
    if (!G || !Array.isArray(G.edges) || !G.nodes) return null;
    const N = G.nodes.length / 2, k = xs.length;
    if (!driveAdj) {
      driveAdj = Array.from({ length: N }, () => []);
      G.edges.forEach((e, i) => { if (e[0] < N && e[1] < N) { driveAdj[e[0]].push(i); driveAdj[e[1]].push(i); } });
    }
    const x0 = xs[k - 2], y0 = xs[k - 1], x1 = xs[0], y1 = xs[1];
    // the line's heading as it ends and as it starts
    const ex = x0 - xs[k - 4], ey = y0 - xs[k - 3], el = Math.hypot(ex, ey) || 1;
    const sx = xs[2] - x1, sy = xs[3] - y1, sl = Math.hypot(sx, sy) || 1;
    // the nearest junction within 80 m (the graph only has nodes where streets meet) that is not behind (sign +1), or
    // not ahead of (sign −1), the point along (dx, dy)
    const nearest = (x, y, dx, dy, sign) => {
      let best = 80 * 80, at = -1;
      for (let i = 0; i < N; i++) {
        const nx = G.nodes[2 * i] - x, ny = G.nodes[2 * i + 1] - y, d2 = nx * nx + ny * ny;
        if (d2 < best && sign * (nx * dx + ny * dy) >= -3) { best = d2; at = i; }
      }
      return at;
    };
    const a = nearest(x0, y0, ex / el, ey / el, 1), b = nearest(x1, y1, sx / sl, sy / sl, -1);
    if (a < 0 || b < 0) return null;
    // Dijkstra, with a small binary heap of [cost, node]
    const dist = new Float64Array(N).fill(Infinity), via = new Int32Array(N).fill(-1), heap = [[0, a]];
    dist[a] = 0;
    const push = (c, i) => { heap.push([c, i]); let j = heap.length - 1; while (j > 0) { const p = (j - 1) >> 1; if (heap[p][0] <= heap[j][0]) break; [heap[p], heap[j]] = [heap[j], heap[p]]; j = p; } };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (let j = 0; ;) {
          const l = 2 * j + 1, r = l + 1;
          let m = j;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === j) break;
          [heap[m], heap[j]] = [heap[j], heap[m]]; j = m;
        }
      }
      return top;
    };
    const limit = 3 * Math.hypot(x1 - x0, y1 - y0) + 150;
    while (heap.length) {
      const [c, i] = pop();
      if (c > dist[i]) continue;
      if (i === b || c > limit) break;
      for (const ei of driveAdj[i]) {
        const e = G.edges[ei], j = e[0] === i ? e[1] : e[0], nc = c + (+e[2] || 0);
        if (nc < dist[j]) { dist[j] = nc; via[j] = ei; push(nc, j); }
      }
    }
    if (!(dist[b] <= limit)) return null;
    // walk back from b, laying each edge's own points in the direction of travel
    const legs = [];
    for (let i = b; i !== a;) {
      const e = G.edges[via[i]], pts = e[3], from = e[0] === i ? e[1] : e[0];
      const seg = [];
      for (let q = 0; q < pts.length; q += 2) seg.push(pts[q], pts[q + 1]);
      if (e[0] !== from) { const rev = []; for (let q = seg.length - 2; q >= 0; q -= 2) rev.push(seg[q], seg[q + 1]); legs.unshift(rev); } else legs.unshift(seg);
      i = from;
    }
    const out = [];
    for (const s of legs) for (let q = 0; q < s.length; q += 2) {
      const n = out.length;
      if (n && Math.hypot(s[q] - out[n - 2], s[q + 1] - out[n - 1]) < 1) continue;
      out.push(s[q], s[q + 1]);
    }
    return out.length ? out : null;
  }

  /** the point d metres along pattern p (wrapping round a loop) and the direction of travel there */
  function pointAt(p, d, out) {
    const { cum, xy, n, len } = p;
    if (p.closed) d = ((d % len) + len) % len; else d = d < 0 ? 0 : d > len ? len : d;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
    const L = cum[hi] - cum[lo], t = L > 0 ? (d - cum[lo]) / L : 0;
    const ax = xy[2 * lo], ay = xy[2 * lo + 1], bx = xy[2 * hi], by = xy[2 * hi + 1];
    out.x = ax + (bx - ax) * t; out.y = ay + (by - ay) * t;
    if (L > 0) { out.tx = (bx - ax) / L; out.ty = (by - ay) / L; }
    return out;
  }

  /** nearest point of pattern p to (x, y); with a hint (metres along) a near-equal match close to it wins, so a bus on
   *  a street the route uses twice stays on the pass it is actually making */
  function projectOn(p, x, y, hint, out) {
    const { xy, cum, n } = p;
    let best = Infinity, bestD = 0, near = Infinity, nearD = 0;
    const useHint = Number.isFinite(hint);
    for (let i = 0; i < n - 1; i++) {
      const ax = xy[2 * i], ay = xy[2 * i + 1], dx = xy[2 * i + 2] - ax, dy = xy[2 * i + 3] - ay;
      const L2 = dx * dx + dy * dy;
      let t = L2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + dx * t - x, ey = ay + dy * t - y, d2 = ex * ex + ey * ey;
      const along = cum[i] + Math.sqrt(L2) * t;
      if (d2 < best) { best = d2; bestD = along; }
      if (useHint) {
        let g = along - hint;
        if (p.closed) g = wrapDelta(g, p.len);
        if (g > -150 && g < 600 && d2 < near) { near = d2; nearD = along; }
      }
    }
    best = Math.sqrt(best);
    if (useHint && near < Infinity && Math.sqrt(near) < best + 15) { out.d = nearD; out.dist = Math.sqrt(near); }
    else { out.d = bestD; out.dist = best; }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ routes and stops
  function ensureRoute(code) {
    let r = routeBy.get(code);
    if (!r) {
      r = { code, name: code, color: "#6d6e71", darkColor: "#9b9c9f", service: "", patterns: [], stops: [], idx: routes.length, ink: "#fff", detail: "" };
      routeBy.set(code, r);
      routes.push(r);
    }
    return r;
  }
  function applyRouteInfo(r, raw) {
    r.name = cleanText(raw.name, 60) || r.code;
    r.color = hexColor(raw.color, r.color);
    r.darkColor = hexColor(raw.darkColor, r.color);
    r.service = cleanText(raw.service, 16);
    r.ink = luma(r.color) > 0.62 ? "#2a2622" : "#ffffff";
  }
  function applyRouteDetail(r, data, source) {
    // details are re-read during service; an unchanged answer leaves everything (and the cached line tiles) alone
    const sig = JSON.stringify([data.patterns, data.stops]);
    if (source === "api" && r.detail === "api" && sig === r.sig) return;
    r.sig = sig;
    // a loop we had whole is kept over a later answer that comes back cut short (the API alternates between the two)
    const pats = (Array.isArray(data.patterns) ? data.patterns : []).map((raw) => {
      const p = makePattern(raw, r);
      return (p && p.patched && r.patterns.find((o) => o.id === p.id && !o.patched)) || p;
    }).filter(Boolean);
    if (pats.length) r.patterns = pats;
    const ids = [];
    for (const s of Array.isArray(data.stops) ? data.stops : []) {
      const id = cleanText(s && s.id, 64), lat = +(s && s.latitude), lon = +(s && s.longitude);
      if (!id || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat - geo.origin.lat) > 0.3 || Math.abs(lon - geo.origin.lon) > 0.3) continue;
      if (!ids.includes(id)) ids.push(id);
      const [x, y] = geo.toXY(lat, lon);
      const st = stops.get(id);
      const name = cleanText(s.name, 80) || "Bus stop";
      if (st) Object.assign(st, { name, lat, lon, x, y });
      else stops.set(id, { id, name, lat, lon, routes: [], x, y, px: 0, py: 0, depth: 0 });
    }
    if (ids.length || source === "api") r.stops = ids;
    r.detail = source;
    scheduleRebuild();
  }

  // everything derived from the set of routes: who serves each stop, stops along each pattern, the route-line offsets
  let rebuildTimer = 0;
  function scheduleRebuild() { if (!rebuildTimer) rebuildTimer = setTimeout(rebuild, 30); }
  function rebuild() {
    rebuildTimer = 0;
    routes.forEach((r, i) => (r.idx = i));
    for (const st of stops.values()) st.routes = [];
    for (const r of routes) for (const id of r.stops) { const st = stops.get(id); if (st && !st.routes.includes(r.code)) st.routes.push(r.code); }
    for (const [id, st] of stops) if (!st.routes.length) stops.delete(id);
    stopList = [...stops.values()];
    slabStops = stopList.filter((st) => offSlab(st.x, st.y) <= 0);
    for (const r of routes) placeStops(r);
    buildCorridors();
    geomVer++;
    OT.ver++;
    levels.clear();
    OT.cover.clear();
    if (mockMode) for (const r of routes) mockFor(r);
    publish();
  }

  function placeStops(r) {
    for (const p of r.patterns) {
      const list = [];
      for (const id of r.stops) {
        const st = stops.get(id);
        if (!st) continue;
        projectOn(p, st.x, st.y, NaN, Q);
        if (Q.dist > 32) continue;
        pointAt(p, Q.d, P);
        // stops sit at the kerb on the right of travel: a stop across a two-way street belongs to the other direction
        const left = P.tx * (st.y - P.y) - P.ty * (st.x - P.x);
        if (Q.dist > 9 && left > 0) continue;
        list.push({ id, d: Q.d });
      }
      list.sort((a, b) => a.d - b.d);
      p.stopsAlong = list;
      p.dest = list.length ? (stops.get(list[list.length - 1].id) || {}).name || r.name : r.name;
      // where a simulated bus slows: stops, sharp corners, the end of the line
      const slow = list.map((s) => ({ d: s.d, v: 0, dwell: 1 }));
      for (let i = 1; i < p.n - 1; i++) {
        const ax = p.xy[2 * i] - p.xy[2 * i - 2], ay = p.xy[2 * i + 1] - p.xy[2 * i - 1];
        const bx = p.xy[2 * i + 2] - p.xy[2 * i], by = p.xy[2 * i + 3] - p.xy[2 * i + 1];
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        if (la < 4 || lb < 4) continue;
        const turn = Math.acos(clamp((ax * bx + ay * by) / (la * lb), -1, 1));
        if (turn > 0.75) slow.push({ d: p.cum[i], v: turn > 1.3 ? 3.6 : 5.2, dwell: 0 });
      }
      if (!p.closed) slow.push({ d: p.len - 1, v: 0, dwell: 0 });
      slow.sort((a, b) => a.d - b.d);
      p.slow = slow;
    }
  }

  // Route lines that share a street sit side by side. Each pattern is resampled every 8 m; at each sample the routes
  // running parallel within 7 m are found, and this route takes its slot (in route order) across that bundle. "Across"
  // is measured against one reference axis for the whole network, chosen as the heading its streets use least, so both
  // directions of a street agree on which side is which and a bundle only ever swaps sides on that rare heading.
  // Smoothing turns the slot changes where routes join and leave into gentle merges.
  function buildCorridors() {
    const items = [];
    routes.forEach((r, ri) => { for (const p of r.patterns) items.push({ p, ri }); });
    const STEP = 8, CELL = 10, NEAR2 = 7 * 7;
    for (const it of items) {
      const p = it.p, xs = [], ys = [], dxs = [], dys = [];
      for (let i = 0; i < p.n - 1; i++) {
        const ax = p.xy[2 * i], ay = p.xy[2 * i + 1], bx = p.xy[2 * i + 2], by = p.xy[2 * i + 3];
        const L = Math.hypot(bx - ax, by - ay) || 1, k = Math.max(1, Math.ceil(L / STEP));
        for (let j = 0; j < k; j++) { xs.push(ax + ((bx - ax) * j) / k); ys.push(ay + ((by - ay) * j) / k); dxs.push((bx - ax) / L); dys.push((by - ay) / L); }
      }
      xs.push(p.xy[2 * p.n - 2]); ys.push(p.xy[2 * p.n - 1]); dxs.push(dxs[dxs.length - 1]); dys.push(dys[dys.length - 1]);
      it.rs = { x: Float64Array.from(xs), y: Float64Array.from(ys), dx: Float64Array.from(dxs), dy: Float64Array.from(dys), off: new Float32Array(xs.length), m: xs.length };
    }
    // the reference axis: the least-used street heading (5° bins, modulo 180°)
    const hist = new Float64Array(36);
    for (const it of items) for (let i = 0; i < it.p.n - 1; i++) {
      const dx = it.p.xy[2 * i + 2] - it.p.xy[2 * i], dy = it.p.xy[2 * i + 3] - it.p.xy[2 * i + 1];
      const a = ((Math.atan2(dy, dx) % Math.PI) + Math.PI) % Math.PI;
      hist[Math.min(35, Math.floor(a / (Math.PI / 36)))] += Math.hypot(dx, dy);
    }
    let bin = 0, low = Infinity;
    for (let b = 0; b < 36; b++) { const v = hist[(b + 35) % 36] + 2 * hist[b] + hist[(b + 1) % 36]; if (v < low) { low = v; bin = b; } }
    const ax = Math.cos((bin + 0.5) * (Math.PI / 36)), ay = Math.sin((bin + 0.5) * (Math.PI / 36));
    const grid = new Map();
    const cell = (x, y) => (Math.floor(x / CELL) + 2048) * 4096 + (Math.floor(y / CELL) + 2048);
    items.forEach((it, gp) => {
      for (let i = 0; i < it.rs.m; i++) {
        const k = cell(it.rs.x[i], it.rs.y[i]);
        let c = grid.get(k);
        if (!c) grid.set(k, (c = []));
        c.push(gp * 65536 + i);
      }
    });
    items.forEach((it, gp) => {
      const rs = it.rs;
      for (let i = 0; i < rs.m; i++) {
        const x = rs.x[i], y = rs.y[i], dx = rs.dx[i], dy = rs.dy[i];
        let mask = 1 << it.ri;
        const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
        for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const c = grid.get((gx + 2048) * 4096 + (gy + 2048));
          if (!c) continue;
          for (const e of c) {
            const g2 = Math.floor(e / 65536);
            if (g2 === gp) continue;
            const j = e - g2 * 65536, o = items[g2].rs;
            const ex = o.x[j] - x, ey = o.y[j] - y;
            if (ex * ex + ey * ey > NEAR2) continue;
            const dot = dx * o.dx[j] + dy * o.dy[j];
            if (Math.abs(dot) < 0.8) continue;
            mask |= 1 << items[g2].ri;
          }
        }
        const n = popcount(mask), slot = popcount(mask & ((1 << it.ri) - 1));
        rs.off[i] = (slot - (n - 1) / 2) * (ax * dy - ay * dx >= 0 ? 1 : -1);
      }
      for (let pass = 0; pass < 2; pass++) rs.off = boxSmooth(rs.off, 4);
      it.p.rs = rs;
    });
  }
  function boxSmooth(a, r) {
    const n = a.length, out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) { s += a[j]; c++; }
      out[i] = s / c;
    }
    return out;
  }
  /** a pattern's line moved to its slot (sp metres per slot), simplified to tol metres */
  function offsetLine(rs, sp, tol) {
    const m = rs.m, tmp = new Float64Array(2 * m);
    for (let i = 0; i < m; i++) {
      const o = rs.off[i] * sp;
      let nx = -rs.dy[i], ny = rs.dx[i];
      // mitre with the previous direction so the offset line keeps its distance round corners; past a right angle the
      // mitre point runs out along the line (to twice the offset at a hairpin) and draws a spike, so a sharp turn
      // keeps its plain normal and the round line joins cover the corner
      if (i > 0 && o !== 0 && rs.dx[i] * rs.dx[i - 1] + rs.dy[i] * rs.dy[i - 1] > 0) {
        let mx = nx - rs.dy[i - 1], my = ny + rs.dx[i - 1];
        const ml = Math.hypot(mx, my);
        if (ml > 1e-6) { mx /= ml; my /= ml; const f = 1 / Math.max(0.7, mx * nx + my * ny); nx = mx * f; ny = my * f; }
      }
      tmp[2 * i] = rs.x[i] + nx * o; tmp[2 * i + 1] = rs.y[i] + ny * o;
    }
    return simplify(tmp, tol);
  }
  function simplify(a, tol) {
    const n = a.length / 2;
    if (n <= 2) return Float32Array.from(a);
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const stack = [0, n - 1], t2 = tol * tol;
    while (stack.length) {
      const j = stack.pop(), i = stack.pop();
      const ax = a[2 * i], ay = a[2 * i + 1], dx = a[2 * j] - ax, dy = a[2 * j + 1] - ay, L2 = dx * dx + dy * dy;
      let md = 0, mi = -1;
      for (let k = i + 1; k < j; k++) {
        let t = L2 > 0 ? ((a[2 * k] - ax) * dx + (a[2 * k + 1] - ay) * dy) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + dx * t - a[2 * k], ey = ay + dy * t - a[2 * k + 1], d2 = ex * ex + ey * ey;
        if (d2 > md) { md = d2; mi = k; }
      }
      if (md > t2) { keep[mi] = 1; stack.push(i, mi, mi, j); }
    }
    let c = 0;
    for (let i = 0; i < n; i++) c += keep[i];
    const out = new Float32Array(2 * c);
    for (let i = 0, o = 0; i < n; i++) if (keep[i]) { out[o++] = a[2 * i]; out[o++] = a[2 * i + 1]; }
    return out;
  }

  // Line widths and slot spacing for one tile level (k device px per screen metre): about 3 m on the ground at the
  // middle zooms, slimmer up close so a bundle of routes doesn't swallow the street and its buses, and never thinner
  // than ~2.7 px far out, so the whole network stays readable.
  const levels = new Map();
  function level(z) {
    const key = z + "@" + view.dpr;
    let L = levels.get(key);
    if (L && L.ver === geomVer) return L;
    const k = Math.pow(2, z), px = view.dpr, sk = k / px;   // sk: CSS px per metre the tile is drawn for
    const w = Math.max(1.3, 2.7 * Math.pow(3 / sk, 0.45), 2.7 / sk);
    L = { ver: geomVer, z, k, w, halo: w + Math.max(0.9, 2.3 / sk), sp: w * 1.12, lines: new Map(), box: new Map() };
    const tol = Math.max(0.15, (0.35 * px) / k);
    for (const r of routes) for (const p of r.patterns) {
      if (!p.rs) continue;
      const ln = offsetLine(p.rs, L.sp, tol);
      const bb = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < ln.length; i += 2) { bb[0] = Math.min(bb[0], ln[i]); bb[1] = Math.min(bb[1], ln[i + 1]); bb[2] = Math.max(bb[2], ln[i]); bb[3] = Math.max(bb[3], ln[i + 1]); }
      bb[0] -= L.halo; bb[1] -= L.halo; bb[2] += L.halo; bb[3] += L.halo;
      L.lines.set(p, ln); L.box.set(p, bb);
    }
    levels.set(key, L);
    return L;
  }

  // ------------------------------------------------------------------------------------------------ network
  const net = { list: { next: 0, fails: 0, busy: false }, per: new Map(), lastOk: 0, fails: 0, started: Date.now(), hiddenAt: 0, resumedAt: 0, listOk: false };
  const routeNet = (code) => { let s = net.per.get(code); if (!s) net.per.set(code, (s = { vNext: 0, vFails: 0, vBusy: false, dNext: 0, dLast: 0, dFails: 0, dBusy: false })); return s; };
  const backoff = (base, fails, max) => Math.min(max, base * Math.pow(2, Math.min(fails, 6))) * (0.8 + Math.random() * 0.4);

  async function getJSON(url, ms = 10000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      const res = await fetch(url, { signal: ac.signal, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (!j || typeof j !== "object" || !j.data || typeof j.data !== "object" || (j.status && j.status !== "success")) throw new Error("unexpected payload");
      return j;
    } finally { clearTimeout(timer); }
  }

  async function loadSnapshot() {
    try {
      const j = await fetch(SNAPSHOT).then((r) => (r.ok ? r.json() : null));
      const list = j && Array.isArray(j.routes) ? j.routes : [];
      for (const raw of list) {
        const code = cleanText(raw && raw.code, 10).toUpperCase();
        if (!code) continue;
        // the live API wins: only fill routes it has not described yet
        if (net.listOk && !routeBy.has(code)) continue;
        const r = ensureRoute(code);
        if (!r.detail || r.detail === "snapshot") { if (!net.listOk) applyRouteInfo(r, raw); applyRouteDetail(r, raw, "snapshot"); }
      }
    } catch { /* no snapshot: the API alone will have to do */ }
  }

  async function loadList() {
    net.list.busy = true;
    try {
      const j = await getJSON(`${API}/routes`);
      const list = (Array.isArray(j.data.routes) ? j.data.routes : []).filter((r) => r && cleanText(r.code, 10));
      if (!list.length) throw new Error("no routes");
      const keep = new Set();
      for (const raw of list) {
        const code = cleanText(raw.code, 10).toUpperCase();
        keep.add(code);
        applyRouteInfo(ensureRoute(code), raw);
      }
      // the API's order, and routes it no longer lists retire
      const next = [...keep].map((c) => routeBy.get(c));
      for (const r of routes) if (!keep.has(r.code)) routeBy.delete(r.code);
      routes.length = 0; routes.push(...next);
      net.listOk = true; net.list.fails = 0; net.list.next = Date.now() + LIST_MS;
      scheduleRebuild();
    } catch {
      net.list.fails++;
      net.list.next = Date.now() + backoff(15000, net.list.fails, 10 * 60000);
    } finally { net.list.busy = false; }
  }

  // A route's shapes and stops: read once, then again with every list refresh, and sooner (at most every 2 min) when
  // a bus reports a pattern we have not got — the API adds patterns during service ("Last Pick Up At …").
  const DETAIL_SOON_MS = 2 * 60 * 1000;
  function wantDetail(r) {
    const s = routeNet(r.code);
    s.dNext = Math.min(s.dNext, Math.max(Date.now(), s.dLast + DETAIL_SOON_MS));
  }
  async function loadDetail(r, s) {
    s.dBusy = true;
    s.dLast = Date.now();
    try {
      const j = await getJSON(`${API}/routes/${encodeURIComponent(r.code)}`);
      applyRouteDetail(r, j.data, "api");
      s.dFails = 0;
      s.dNext = Date.now() + LIST_MS;
    } catch {
      s.dFails++;
      s.dNext = Date.now() + backoff(10000, s.dFails, 10 * 60000);
    } finally { s.dBusy = false; }
  }

  // each route's poll keeps its own phase in the 8-s cycle, so the requests are spread evenly
  function nextSlot(r) {
    const n = Math.max(1, routes.length), phase = ((r.idx % n) / n) * POLL_MS, now = Date.now();
    let t = now - ((now - phase) % POLL_MS) + POLL_MS;
    if (t - now < POLL_MS * 0.5) t += POLL_MS;
    return t;
  }

  async function pollVehicles(r, s) {
    s.vBusy = true;
    let ok = false;
    try {
      let list;
      if (mockMode) list = mockReport(r);
      else {
        const j = await getJSON(`${API}/routes/${encodeURIComponent(r.code)}/vehicles`);
        list = Array.isArray(j.data.vehicles) ? j.data.vehicles : [];
        const lm = Date.parse(j.lastModified);
        if (Number.isFinite(lm)) {
          const sk = clamp(lm - Date.now(), -864e5, 864e5);
          skew = skewSet ? skew * 0.8 + sk * 0.2 : sk;
          skewSet = true;
        }
      }
      if (routeBy.get(r.code) === r) sweep(r, ingest(r, list));
      s.vFails = 0; net.lastOk = Date.now(); net.fails = 0;
      s.vNext = nextSlot(r);
      ok = true;
    } catch {
      s.vFails++; net.fails++;
      s.vNext = Date.now() + backoff(POLL_MS, s.vFails, 120000);
    } finally {
      s.vBusy = false;
      publish(ok);
    }
  }

  function tick() {
    if (document.hidden) return;
    idleStep();
    const t = Date.now();
    if (!net.list.busy && t >= net.list.next) loadList();
    routes.forEach((r, i) => {
      const s = routeNet(r.code);
      if (!s.vNext) s.vNext = t + 400 + i * 260;   // the first round comes quickly, then settles into its phase
      if (!s.dBusy && t >= s.dNext) loadDetail(r, s);
      if (!s.vBusy && t >= s.vNext) pollVehicles(r, s);
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { net.hiddenAt = Date.now(); return; }
    // we chose not to look while hidden: that time does not count against the buses' freshness, but every bus has to
    // be confirmed by the next good poll of its route, or it fades out (service may have ended meanwhile)
    const away = net.hiddenAt ? Date.now() - net.hiddenAt : 0;
    for (const T of tracks.values()) { T.seen += away; T.unconfirmed = true; }
    net.resumedAt = Date.now();
    let i = 0;
    for (const s of net.per.values()) if (!s.vBusy) s.vNext = Date.now() + 150 + i++ * 200;
  });

  // ------------------------------------------------------------------------------------------------ vehicles
  function makeTrack(id) {
    return {
      id, route: null, key: "", service: "", mph: 0, dest: "", delayed: false, preds: [], updMs: 0, seen: 0, apiHeading: NaN,
      src: null, listedAt: 0, miss: 0, unconfirmed: false, goneAt: 0,   // which route's poll lists it, and when it last did
      fixAt: 0, vObs: NaN,           // when its position last changed (our clock), and its speed between the last two fixes
      mode: 0,                       // 0 not placed · 1 on its pattern · 2 off route
      pat: null, shownD: 0, tgtD: 0, repD: 0, capD: 0, v: 0, vT: 0,
      offD: 0, offDV: 0, offX: 0, offY: 0, offXV: 0, offYV: 0, w: 3,   // the decaying correction (critically damped)
      repPat: null, repRaw: 0, repAt: 0, repX: 0, repY: 0,
      bx: 0, by: 0, x: 0, y: 0, fx: 0, fy: 1, hdg: 0, hdgT: 0, lane: 0,
      appear: 0, alpha: 1, stale: false, age: 0, mv: 0, fadeV: 0,   // mv, fadeV: m/s moved and fade/s over the last step
      sx: 0, sy: 0, depth: 0, bb0: 0, bb1: 0, bb2: 0, bb3: 0, hw: 0, occ: 0, occB: false, drawn: false,
      pl: [0, 0, 0, 0], plF: -1,     // the route pill's box (CSS px) and the frame it was drawn in
      pub: { id, routeCode: "", lat: 0, lon: 0, heading: 0, destination: "", predictions: [], updated: null, speed: 0, x: 0, y: 0, stale: false, delayed: false },
    };
  }

  function parseUpdated(u, fallback) {
    let ms = NaN;
    if (typeof u === "number" || /^\d+(\.\d+)?$/.test(String(u || "").trim())) { const n = +u; ms = n > 1e12 ? n : n * 1000; }
    else if (u) ms = Date.parse(u);
    if (!Number.isFinite(ms) || ms > fallback + 120000) return fallback;
    return ms;
  }
  function cleanPreds(list, fallbackRoute) {
    if (!Array.isArray(list)) return [];
    const now = serverNow(), out = [];
    for (const p of list) {
      if (!p || typeof p !== "object") continue;
      const stopId = cleanText(p.stopId, 64);
      if (!stopId) continue;
      let at = Date.parse(p.predictionTime);
      const tta = +p.timeToArrivalInSeconds;
      if (!Number.isFinite(at) && Number.isFinite(tta)) { const sys = Date.parse(p.systemTime); at = (Number.isFinite(sys) ? sys : now) + tta * 1000; }
      if (!Number.isFinite(at) || at < now - 5 * 60000 || at > now + 3 * 3600000) continue;
      out.push({ stopId, stopName: cleanText(p.stopName, 80), routeCode: cleanText(p.routeCode, 10).toUpperCase() || fallbackRoute, dest: cleanText(p.destination, 80), at, delayed: !!p.isDelayed, due: /due/i.test(String(p.predictionCountdown || "")) });
    }
    out.sort((a, b) => a.at - b.at);
    return out;
  }

  // one successful poll of a route: returns the ids it listed
  function ingest(route, list) {
    const nowP = performance.now(), nowD = Date.now(), sNow = serverNow(), ids = new Set();
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const lat = +raw.latitude, lon = +raw.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat - geo.origin.lat) > 0.3 || Math.abs(lon - geo.origin.lon) > 0.3) continue;
      const id = cleanText(raw.id ?? raw.bus_id, 40);
      if (!id) continue;
      ids.add(id);
      const r = routeBy.get(cleanText(raw.routeCode, 10).toUpperCase()) || route;
      let T = tracks.get(id);
      if (!T) { T = makeTrack(id); tracks.set(id, T); }
      // after a silence (a hidden tab, polls failing) the bus may be anywhere: a big correction then fades it over
      // rather than racing it there
      T.quiet = T.listedAt > 0 && nowP - T.listedAt > QUIET_MS;
      T.listedAt = nowP; T.src = route; T.miss = 0; T.unconfirmed = false;
      T.goneAt = 0;   // back in the feed (a layover, a glitch): it simply carries on
      T.route = r;
      T.seen = nowD;
      T.service = cleanText(raw.service, 16) || r.service;
      T.updMs = parseUpdated(raw.updated, sNow);
      T.mph = clamp(+raw.speed || 0, 0, 75);
      T.dest = cleanText(raw.destination, 80);
      T.delayed = !!raw.delayed;
      T.preds = cleanPreds(raw.predictions, r.code);
      T.apiHeading = Number.isFinite(+raw.heading) ? ((+raw.heading % 360) + 360) % 360 : NaN;
      const key = `${lat.toFixed(6)},${lon.toFixed(6)},${raw.distance},${raw.patternId}`;
      const double = T.service === "double";
      if (key !== T.key) {
        T.key = key;
        T.fixAt = nowD;
        place(T, r, raw, lat, lon, nowP, double);
      } else if (double ? nowD - T.fixAt > 20000 : T.mph < 0.5) {
        // same fix, but it now says it has stopped (or the shuttle, which may send no speed, has not moved for a
        // while): slow down where we are rather than jump
        T.vT = 0;
      }
      const pub = T.pub;
      pub.routeCode = r.code; pub.lat = lat; pub.lon = lon; pub.destination = T.dest; pub.speed = T.mph; pub.delayed = T.delayed;
      pub.predictions = Array.isArray(raw.predictions) ? raw.predictions : [];
      pub.updated = new Date(T.updMs);
    }
    return ids;
  }
  // The buses a good poll of their route left out. Two misses in a row (one, for a bus not yet confirmed since the
  // tab came back) mean it has left service: it stops counting at once and fades out. A bus whose route's polls are
  // failing is left to the 3- and 10-minute freshness timers instead.
  function sweep(route, ids) {
    for (const T of tracks.values()) {
      if (T.src !== route || ids.has(T.id) || T.goneAt) continue;
      if (++T.miss >= 2 || T.unconfirmed) markGone(T);
    }
  }
  function markGone(T) {
    if (T.goneAt) return;
    T.goneAt = Date.now();
    T.stale = true; T.preds = [];
    T.pub.stale = true; T.pub.predictions = [];
  }

  function place(T, r, raw, lat, lon, nowP, double) {
    const [x, y] = geo.toXY(lat, lon);
    let pat = null, d = 0;
    if (r && r.patterns.length) {
      const pid = cleanText(raw.patternId, 24);
      const byId = pid ? r.patterns.find((p) => p.id === pid) : null;
      if (pid && !byId && !mockMode) wantDetail(r);   // a pattern added since we read the route
      const distFt = +raw.distance;
      if (byId && distFt > 0 && distFt <= byId.lengthFt * 1.05 + 150) {
        const dd = fromFeet(byId, distFt);
        pointAt(byId, dd, P);
        if (Math.hypot(P.x - x, P.y - y) <= SNAP_M) { pat = byId; d = dd; }
      }
      if (!pat) {
        // no usable distance: project the fix onto its own pattern, else onto any of the route's
        const hit = snapTo(T, byId ? [byId] : r.patterns, x, y) || (byId ? snapTo(T, r.patterns, x, y) : null);
        if (hit) { pat = hit.p; d = hit.d; }
      }
    }
    // the shuttle ("double" service) has sent speed 0 for "unknown": only trust it when it says it is moving
    retarget(T, pat, d, x, y, double && T.mph < 0.5 ? NaN : T.mph * MPH, nowP, double);
  }
  function snapTo(T, list, x, y) {
    let bp = null, bd = 0, bdist = Infinity, bscore = Infinity;
    for (const p of list) {
      projectOn(p, x, y, T.pat === p ? T.shownD : NaN, Q);
      const score = Q.dist - (T.pat === p ? 8 : 0);   // stay on the pattern it is on when two are about as near
      if (score < bscore) { bscore = score; bp = p; bd = Q.d; bdist = Q.dist; }
    }
    return bp && bdist <= SNAP_M ? { p: bp, d: bd } : null;
  }

  // A new report: the bus is to be at (pat, d). Its shown position stays put; the gap becomes an offset that a critically
  // damped spring takes to zero, starting from the bus's current velocity, so it never jumps and never jerks.
  function retarget(T, pat, d, x, y, vRep, nowP, double) {
    // speed from successive fixes: the API's speed is a snapshot, and the double-deck shuttle sends none
    let vObs = NaN;
    if (pat && T.repPat === pat && T.repAt > 0) {
      const dt = (nowP - T.repAt) / 1000;
      let dd = d - T.repRaw;
      if (pat.closed) dd = wrapDelta(dd, pat.len);
      if (dt > 3 && dt < 120 && dd > -15) vObs = Math.max(0, dd) / dt;
    }
    // Dead reckoning speed. The API's speed is the moment of the fix: a bus braking for a stop or a light still says
    // 8 m/s, and running on at that overshoots. The average since the last fix is the better guide, so it bounds the
    // reported speed; a bus that has just pulled away (slow average, brisk now) still gets half its reported speed.
    let vT;
    if (Number.isFinite(vRep)) vT = vRep < 0.4 ? 0 : Number.isFinite(vObs) ? Math.min(vRep, Math.max(1.15 * vObs, 0.5 * vRep)) : vRep;
    else vT = Number.isFinite(vObs) ? vObs * 0.9 : 0;
    T.vObs = vObs;
    const movedX = x - T.repX, movedY = y - T.repY;
    const hadFix = T.repAt > 0;
    T.repPat = pat; T.repRaw = d; T.repAt = nowP; T.repX = x; T.repY = y;

    // headings for buses off their line: the API's, else from how it moved, else keep
    const trusted = Number.isFinite(T.apiHeading) && (T.mph > 0.5 || T.apiHeading !== 0);
    if (trusted) T.hdgT = T.apiHeading;
    else if (hadFix && Math.hypot(movedX, movedY) > 4) T.hdgT = (Math.atan2(movedX, movedY) * 180) / Math.PI;

    const curV = T.mode === 1 ? T.v * capFactor(T) : 0;      // the target's current speed
    if (T.mode === 0) {
      T.v = T.vT = clamp(vT, 0, 20);
      if (pat) { T.mode = 1; T.pat = pat; T.shownD = T.tgtD = T.repD = d; T.capD = capAt(pat, d); }
      else { T.mode = 2; T.pat = null; if (!trusted) T.hdgT = roadHeading(x, y, T.hdgT); T.hdg = T.hdgT; }
      T.offD = T.offDV = T.offX = T.offY = T.offXV = T.offYV = 0;
      T.appear = 0;
      updateTrack(T, 0, nowP);
      return;
    }
    const shownBX = T.bx, shownBY = T.by;   // where the bus is drawn (before its lane offset)
    const vNow = T.mode === 1 ? curV + T.offDV : 0;
    T.vT = clamp(vT, 0, 20);
    const stopped = T.vT <= 1, far = Math.hypot(shownBX - x, shownBY - y);
    if (pat) {
      // how far the report is ahead of the drawn bus along the pattern (negative: behind it), when that is known
      let delta = NaN;
      const same = T.mode === 1 && T.pat === pat;
      // (on a new pattern, where the drawn bus lies on it near the report: a terminus loop can pass it twice)
      if (!same) projectOn(pat, shownBX, shownBY, d, Q);
      const base = same ? T.shownD : Q.dist < 25 ? Q.d : NaN;
      if (Number.isFinite(base)) { delta = d - base; if (pat.closed) delta = wrapDelta(delta, pat.len); }
      if (fadeOver(T, Number.isFinite(delta) ? delta : far, stopped)) return jumpTo(T, pat, d);
      // A stopped bus reported a little behind where it is drawn (dead reckoning ran on as it pulled in): it stays
      // where it is. Backing a bus up the street reads far worse than being a few metres out.
      if (delta < 0 && stopped) delta = 0;
      if (same) T.repD = T.shownD + delta;
      else {
        // a new pattern (the end of the line, or back on route): carry on from where the bus is drawn
        T.pat = pat; T.mode = 1;
        if (Number.isFinite(delta)) { T.shownD = base; T.repD = base + delta; pointAt(pat, base, P); }
        else { T.shownD = T.repD = d; pointAt(pat, d, P); }
        setXYOffset(T, shownBX - P.x, shownBY - P.y);
      }
      T.tgtD = T.repD;
      T.capD = capAt(pat, T.repD);
      T.offD = T.shownD - T.repD;
      // keep the drawn velocity continuous: what the old target and offset were doing, the new pair carries on
      T.v = Math.max(T.v, 0);
      T.offDV = vNow - T.v * capFactor(T);
      const gap = Math.max(Math.abs(T.offD), Math.hypot(T.offX, T.offY));
      // A critically damped correction of size g over Tc seconds peaks at ~1.73·g/Tc relative to the target, so Tc
      // grows with the gap: small corrections settle in ~1.5 s and a catch-up never runs more than ~20 m/s faster
      // than the bus. A bus ahead of its report is held where it is (updateTrack) and eases on as the report passes.
      T.w = 4.7 / (T.offD > 1 ? clamp(T.offD / 4, 2, 12) : Math.max(1.5, gap / 11.5));
    } else {
      if (fadeOver(T, far, false)) return jumpTo(T, null, 0, x, y);
      T.mode = 2; T.pat = null;
      T.offD = T.offDV = 0;
      setXYOffset(T, shownBX - x, shownBY - y);
      T.w = 4.7 / Math.max(1.5, far / 11.5);
    }
  }
  // Is a correction of `ahead` metres (the report less the drawn bus; negative: behind it) better faded over than
  // driven? Driving suits the usual few tens of metres; a big catch-up would race across campus, a correction after a
  // silence is of unknown age, and a stopped bus should not reverse more than a couple of bus lengths.
  function fadeOver(T, ahead, stopped) {
    return ahead > CATCH_M || ahead < -BACK_M || (stopped && ahead < -HOLD_M) || (T.quiet && Math.abs(ahead) > 40);
  }
  function setXYOffset(T, ox, oy) { T.offX = ox; T.offY = oy; T.offXV = 0; T.offYV = 0; }
  // far off: fade in at the new place rather than drive there
  function jumpTo(T, pat, d, x, y) {
    T.offD = T.offDV = T.offX = T.offY = T.offXV = T.offYV = 0;
    if (pat) { T.mode = 1; T.pat = pat; T.shownD = T.tgtD = T.repD = d; T.capD = capAt(pat, d); }
    else { T.mode = 2; T.pat = null; T.repX = x; T.repY = y; }
    T.v = T.vT;
    T.appear = 0;
  }
  // dead reckoning eases off as it nears its cap, so the bus coasts to a stop instead of hitting a wall
  const capFactor = (T) => clamp((T.capD - T.tgtD) / 30, 0, 1);
  // How far dead reckoning may run from a report at d: up to AHEAD_M, but no further than the next stop, since a bus
  // usually stops there. If it didn't, the next report has it catch up; that reads better than backing out of a stop.
  // Any stop still ahead counts, however close: a bus reported a few metres short of a stop is pulling into it.
  function capAt(p, d) {
    let cap = d + AHEAD_M;
    const list = p.stopsAlong;
    if (!list.length) return cap;
    const dd = p.closed ? ((d % p.len) + p.len) % p.len : d;
    let next = -1;
    for (const s of list) if (s.d > dd + 1) { next = s.d - dd; break; }
    if (next < 0 && p.closed) next = list[0].d + p.len - dd;
    if (next > 0) cap = Math.min(cap, d + next + 4);
    return cap;
  }

  // a parked bus with no heading lines up with the nearest road
  function roadHeading(x, y, fallback) {
    let best = 18 * 18, h = fallback;
    for (const rd of app.data.roads || []) {
      const f = rd.pts;
      if (!f || f.length < 4) continue;
      for (let i = 0; i + 3 < f.length; i += 2) {
        const ax = f[i], ay = f[i + 1], dx = f[i + 2] - ax, dy = f[i + 3] - ay;
        if (Math.abs(ax - x) > 300 || Math.abs(ay - y) > 300) continue;
        const L2 = dx * dx + dy * dy;
        if (!L2) continue;
        const t = clamp(((x - ax) * dx + (y - ay) * dy) / L2, 0, 1);
        const ex = ax + dx * t - x, ey = ay + dy * t - y, d2 = ex * ex + ey * ey;
        if (d2 < best) { best = d2; h = (Math.atan2(dx, dy) * 180) / Math.PI; }
      }
    }
    return h;
  }

  function updateTrack(T, dt, nowP) {
    const w = T.w, k1 = -w * w, k2 = -2 * w;
    if (T.mode === 1) {
      const p = T.pat;
      T.v += (T.vT - T.v) * (1 - Math.exp(-dt / 0.9));
      const vEff = T.v * capFactor(T);
      T.tgtD += vEff * dt;
      if (!p.closed && T.tgtD > p.len) T.tgtD = p.len;
      // the correction spring
      T.offDV += (k1 * T.offD + k2 * T.offDV) * dt;
      T.offD += T.offDV * dt;
      let sd = T.tgtD + T.offD;
      // a bus never backs up: it waits for its report to catch up with it (a report far behind it was faded over,
      // and one a little behind a stopped bus was taken as where it is: see retarget). This also covers a bus that
      // was ahead of its report when a repeat of the same fix said it had stopped.
      if (sd < T.shownD && dt > 0) { sd = T.shownD; T.offD = sd - T.tgtD; T.offDV = -vEff; }
      if (!p.closed) sd = clamp(sd, 0, p.len);
      T.shownD = sd;
      pointAt(p, sd, P);
      pointAt(p, sd - BUS.L * 0.43, A);
      pointAt(p, sd + BUS.L * 0.43, B);
      let fx = B.x - A.x, fy = B.y - A.y;
      const fl = Math.hypot(fx, fy);
      if (fl > 0.5) { fx /= fl; fy /= fl; } else { fx = P.tx; fy = P.ty; }
      // the body follows the line's bends exactly; a sudden turn (a U-turn where one pattern hands over to the next)
      // swings round over a moment instead, and the lane offset swings with it
      const hT = (Math.atan2(fx, fy) * 180) / Math.PI, dh = angDiff(hT, T.hdg);
      if (dt <= 0 || Math.abs(dh) < 25 || T.appear < 0.15) T.hdg = hT;
      else { T.hdg = (T.hdg + dh * (1 - Math.exp(-dt * 4.5))) % 360; const a = (T.hdg * Math.PI) / 180; fx = Math.sin(a); fy = Math.cos(a); }
      T.fx = fx; T.fy = fy;
      T.offXV += (k1 * T.offX + k2 * T.offXV) * dt; T.offX += T.offXV * dt;
      T.offYV += (k1 * T.offY + k2 * T.offYV) * dt; T.offY += T.offYV * dt;
      T.bx = P.x + T.offX; T.by = P.y + T.offY;
    } else if (T.mode === 2) {
      T.offXV += (k1 * T.offX + k2 * T.offXV) * dt; T.offX += T.offXV * dt;
      T.offYV += (k1 * T.offY + k2 * T.offYV) * dt; T.offY += T.offYV * dt;
      T.bx = T.repX + T.offX; T.by = T.repY + T.offY;
      T.hdg = (T.hdg + angDiff(T.hdgT, T.hdg) * (dt > 0 && T.appear >= 0.15 ? 1 - Math.exp(-dt * 3) : 1)) % 360;
      const a = (T.hdg * Math.PI) / 180;
      T.fx = Math.sin(a); T.fy = Math.cos(a);
    } else return;
    T.lane += ((T.mode === 1 ? LANE : 0) - T.lane) * (dt > 0 ? 1 - Math.exp(-dt * 2) : 1);
    T.x = T.bx + T.fy * T.lane; T.y = T.by - T.fx * T.lane;
    T.appear = Math.min(1, T.appear + dt / 0.8);
    // freshness: since the API last listed it, and since the bus itself last reported (just back from a hidden tab,
    // give the first polls a moment before calling anything stale). A bus the feed has dropped fades right out.
    let age = Math.max(Date.now() - T.seen, serverNow() - T.updMs);
    if (Date.now() - net.resumedAt < 20000) age = Math.min(age, STALE_MS - 1);
    T.age = age;
    T.stale = !!T.goneAt || age > STALE_MS;
    const alpha = T.goneAt ? 0 : age < STALE_MS ? 1 : age < STALE_MS + 60000 ? 1 - (0.65 * (age - STALE_MS)) / 60000 : age < DROP_MS - 20000 ? 0.35 : Math.max(0, (0.35 * (DROP_MS - age)) / 20000);
    // eased, so a step (the end of the resume grace, a bus dropped) is a fade rather than a pop
    T.alpha += (alpha - T.alpha) * (dt > 0 ? 1 - Math.exp(-dt / 0.6) : 1);
    const pub = T.pub;
    pub.x = T.x; pub.y = T.y; pub.heading = Math.round(((T.hdg % 360) + 360) % 360); pub.stale = T.stale;
  }

  // ------------------------------------------------------------------------------------------------ publishing
  let lastStatus = "", lastCount = -1;
  const liveCount = () => { let n = 0; for (const T of tracks.values()) if (!T.stale && T.mode) n++; return n; };
  function publish(changedData) {
    // the public list is the buses running now; stale ones still fade out on the map but are no longer counted
    vehicles.length = 0;
    for (const T of tracks.values()) if (T.mode && !T.stale) vehicles.push(T.pub);
    transit.updated = net.lastOk ? new Date(net.lastOk) : null;
    transit.ok = mockMode || (net.lastOk > 0 && Date.now() - net.lastOk < 150000);
    const n = liveCount();
    if (n !== lastCount) { lastCount = n; UI()?.setCount?.("buses", n ? String(n) : ""); app.emit("count", { id: "buses", n }); }
    updateStatus(n);
    emitTransit();
    if (changedData !== false) refreshCard();
  }
  // "transit" tells the UI (badges, the routes panel, nearby stops) that bus data changed. Every route's poll publishes,
  // so the event is coalesced: it goes out with the next map frame when frames are being drawn anyway (an event emitted
  // during a frame wakes nothing), else within TRANSIT_MS on its own (which draws one frame).
  const TRANSIT_MS = 1500;
  let transitDue = false, transitTimer = 0;
  function emitTransit() {
    transitDue = true;
    if (!transitTimer) transitTimer = setTimeout(flushTransit, TRANSIT_MS);
  }
  function flushTransit() {
    if (transitTimer) { clearTimeout(transitTimer); transitTimer = 0; }
    if (!transitDue) return;
    transitDue = false;
    app.emit("transit", transit);
  }
  function updateStatus(n = liveCount()) {
    const dot = (cls) => `<span class="bus-live ${cls}" aria-hidden="true"></span>`;
    const running = n ? `${n} bus${n === 1 ? "" : "es"} running` : "No buses running right now";
    let html;
    if (mockMode) html = `${dot("on")}${running} (mock)`;
    else if (transit.ok) html = `${dot(n ? "on" : "")}${running}`;
    else if (net.fails > 0 && (Date.now() - net.started > 12000 || net.fails >= routes.length)) html = `${dot("off")}Bus data unavailable`;
    else html = `${dot("")}Loading buses…`;
    if (html !== lastStatus) { lastStatus = html; UI()?.status?.("buses", html); }
  }

  // ------------------------------------------------------------------------------------------------ mock buses
  // Synthetic buses that drive every pattern at city-bus pace: they pull away gently, slow for corners, stop at their
  // stops for a quarter of a minute and lay over at the end of the line. A route with a single one-way pattern has its
  // buses run back to the start out of service, gone from the feed meanwhile, as the real ones do. Reports come out in
  // the API's own shape (the shuttle's too: no pattern, distance or predictions, epoch-second timestamps).
  const mock = new Map();   // code → { list, t, pats }
  function mockFor(r) {
    if (!r.patterns.length) return null;
    let m = mock.get(r.code);
    if (m && m.pats === r.patterns) return m;
    if (m) {
      // fresher shapes arrived: carry each bus over to the same pattern, so nothing jumps
      for (const b of m.list) {
        const id = m.pats[b.pi] && m.pats[b.pi].id, pi = r.patterns.findIndex((p) => p.id === id);
        b.pi = pi >= 0 ? pi : 0;
        b.d = clamp(b.d, 0, r.patterns[b.pi].len - 2);
        b.si = firstSlow(r.patterns[b.pi], b.d);
      }
      m.pats = r.patterns;
      return m;
    }
    const rand = rng(hashStr(r.code) + 7);
    const n = 2 + (hashStr(r.code) % 2);
    // ids by the order routes first got buses, which never changes: by route index, a route the live list puts in
    // front (AIR) would take ids another route's buses already have
    const base = 7000 + mock.size * 10;
    const cycle = r.patterns.reduce((s, p) => s + p.len, 0);
    const list = [];
    for (let i = 0; i < n; i++) {
      let pos = ((i + 0.2 + rand() * 0.5) / n) * cycle, pi = 0;
      while (pi < r.patterns.length - 1 && pos > r.patterns[pi].len) pos -= r.patterns[pi++].len;
      list.push({ id: String(base + i + 1), pi, d: Math.min(pos, r.patterns[pi].len - 5), v: 4, dwell: 0, away: 0, si: 0, cruise: 8.4 + rand() * 2.6, late: rand() < 0.18, rand });
    }
    for (const b of list) b.si = firstSlow(r.patterns[b.pi], b.d);
    m = { list, t: performance.now(), pats: r.patterns };
    mock.set(r.code, m);
    return m;
  }
  const firstSlow = (p, d) => { let i = 0; while (i < p.slow.length && p.slow[i].d < d + 0.5) i++; return i; };
  function mockStep(r, b, dt) {
    let p = r.patterns[b.pi];
    if (b.away > 0) { b.away -= dt; return; }
    if (b.dwell > 0) { b.dwell -= dt; b.v = 0; return; }
    let vmax = b.cruise;
    for (let j = b.si; j < p.slow.length; j++) {
      const sp = p.slow[j], gap = sp.d - b.d;
      if (gap > 160) break;
      vmax = Math.min(vmax, Math.sqrt(sp.v * sp.v + 2 * 1.15 * Math.max(0, gap - 2)));
    }
    b.v = b.v < vmax ? Math.min(vmax, b.v + 1.05 * dt) : vmax;
    b.d += b.v * dt;
    while (b.si < p.slow.length && p.slow[b.si].d - b.d < 2.5) {
      const sp = p.slow[b.si];
      if (sp.v === 0 && b.v < 1.4) { if (sp.dwell) b.dwell = 9 + b.rand() * 16; b.v = 0; b.si++; break; }
      if (sp.v > 0 && sp.d < b.d) { b.si++; continue; }
      break;
    }
    if (b.d >= p.len - 1.5) {
      // the end of the pattern: lay over, then start the next one; at the end of a lone one-way pattern, drive back
      // to its start out of service first
      if (r.patterns.length === 1 && !p.closed) b.away = 30 + p.len / 11;
      b.pi = (b.pi + 1) % r.patterns.length; p = r.patterns[b.pi];
      b.d = 0; b.si = firstSlow(p, 0); b.dwell = 12 + b.rand() * 14; b.v = 0;
    }
  }
  function mockAdvance(r, m) {
    const now = performance.now();
    let dt = (now - m.t) / 1000;
    m.t = now;
    if (dt > 600) dt = 600;   // back from a long absence: skip ahead roughly
    for (const b of m.list) for (let t = dt; t > 0; t -= 0.25) mockStep(r, b, Math.min(0.25, t));
  }
  function mockReport(r) {
    const m = mockFor(r);
    if (!m) return [];
    mockAdvance(r, m);
    const now = Date.now(), out = [];
    const double = r.service === "double";
    for (const b of m.list) {
      if (b.away > 0) continue;   // out of service, on its way back to the start
      const p = r.patterns[b.pi];
      pointAt(p, b.d, P);
      const jitter = () => (b.rand() - 0.5) * 4;
      const [lat, lon] = geo.toLatLon(P.x + jitter(), P.y + jitter());
      const blind = double && mockNoSpeed;
      const v = {
        routeCode: r.code, id: b.id, bus_id: `mock-${b.id}`, service: r.service || "clever", lastStop: "",
        latitude: lat, longitude: lon, delayed: b.late,
        destination: double ? "" : p.dest, patternId: double ? "" : p.id,
        distance: double ? 0 : Math.round(toFeet(p, b.d)), heading: blind ? 0 : Math.round(((Math.atan2(P.tx, P.ty) * 180) / Math.PI + 360) % 360),
        speed: blind ? 0 : Math.round(b.v / MPH), updated: double ? String(Math.floor(now / 1000)) : new Date(Math.floor(now / 60000) * 60000).toISOString(),
      };
      if (!double) v.predictions = mockPredictions(r, b, now);
      out.push(v);
    }
    return out;
  }
  function mockPredictions(r, b, now) {
    const out = [];
    let pi = b.pi, from = b.d, t = Math.max(0, b.dwell) + (b.late ? 120 : 0), feet = 0;
    for (let lap = 0; lap < 3 && out.length < 8; lap++) {
      const p = r.patterns[pi];
      for (const s of p.stopsAlong) {
        if (s.d <= from + 3) continue;
        const run = s.d - from;
        t += run / 7.2 + 14; feet += run / FT; from = s.d;
        const st = stops.get(s.id);
        if (!st) continue;
        const when = now + t * 1000;
        out.push({
          routeCode: r.code, routeColor: r.color, darkColor: r.darkColor, stopId: s.id, stopName: st.name, destination: p.dest, vehicleId: b.id, type: "arrival",
          isDelayed: b.late, timeToArrivalInSeconds: Math.round(t), predictionCountdown: t < 60 ? "DUE" : String(Math.round(t / 60)),
          predictionTime: new Date(when).toISOString(), systemTime: new Date(now).toISOString(), vehicleDistanceInFeet: Math.round(feet),
        });
        if (out.length >= 8 || t > 1800) return out;
      }
      if (!p.closed && r.patterns.length < 2) break;
      t += p.closed ? 0 : 20; feet += (p.len - from) / FT; from = 0; pi = (pi + 1) % r.patterns.length;
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ ETAs
  function etaText(ms, due) {
    const s = (ms - serverNow()) / 1000;
    if (s <= 60 || due) return "Due";
    return `${Math.round(s / 60)} min`;
  }
  // a bus that sends no predictions (the medical-centre shuttle): estimate from where it is along its loop
  function estimates(T, maxN = 6) {
    if (T.mode !== 1 || !T.pat || T.stale) return [];
    const p = T.pat, out = [];
    let t = 0, n = 0;
    const d0 = p.closed ? ((T.shownD % p.len) + p.len) % p.len : T.shownD;
    const list = p.stopsAlong;
    for (let lap = 0; lap < (p.closed ? 2 : 1) && out.length < maxN; lap++) {
      for (const s of list) {
        const ahead = s.d + lap * p.len - d0;
        if (ahead < 8) continue;
        t = ahead / 6.2 + 15 * n++;
        const st = stops.get(s.id);
        if (st) out.push({ stopId: s.id, stopName: st.name, routeCode: T.route.code, dest: T.dest, at: serverNow() + t * 1000, delayed: false, est: true });
        if (out.length >= maxN) break;
      }
    }
    return out;
  }
  function nextStopsOf(T) {
    const seen = new Set(), out = [];
    const now = serverNow();
    for (const p of T.preds) {
      if (p.at < now - 30000 || seen.has(p.stopId)) continue;
      seen.add(p.stopId); out.push(p);
      if (out.length >= 6) break;
    }
    return out.length ? out : estimates(T);
  }
  function departuresAt(stopId) {
    const out = [], now = serverNow();
    for (const T of tracks.values()) {
      if (!T.mode || T.stale) continue;
      let best = null;
      for (const p of T.preds) if (p.stopId === stopId && p.at > now - 30000 && (!best || p.at < best.at)) best = p;
      if (!best && !T.preds.length) best = estimates(T, 12).find((e) => e.stopId === stopId) || null;
      if (best) out.push({ T, route: routeBy.get(best.routeCode) || T.route, dest: best.dest || T.dest || (T.route && T.route.name) || "", at: best.at, delayed: best.delayed || T.delayed, due: best.due, est: !!best.est });
    }
    out.sort((a, b) => a.at - b.at);
    return out.slice(0, 8);
  }

  // ------------------------------------------------------------------------------------------------ selection, follow
  const sel = { kind: null, id: null };
  const hover = { kind: null, id: null, px: 0, py: 0 };
  const follow = { id: null, phase: "", lastX: 0, lastY: 0, lastS: 0 };
  function selectedRoute() {
    if (sel.kind === "route") return sel.id;
    if (sel.kind === "bus") { const T = tracks.get(sel.id); return T && T.route ? T.route.code : null; }
    if (follow.id) { const T = tracks.get(follow.id); return T && T.route ? T.route.code : null; }
    return null;
  }
  function setFollow(id) {
    const T = id != null ? tracks.get(String(id)) : null;
    if (!T) { if (follow.id) { follow.id = null; refreshCard(); } return; }
    follow.id = T.id;
    follow.phase = "fly";
    view.flyTo({ x: T.x, y: T.y, z: 1.5 }, { m: Math.min(view.metresAcross(), app.mobile ? 320 : 520), offsetY: app.mobile ? -view.h * 0.2 : 0 });
    refreshCard();
  }
  function followStep(dt) {
    if (!follow.id) return;
    const T = tracks.get(follow.id);
    if (!T || !T.mode || T.goneAt) { follow.id = null; UI()?.toast?.("That bus has left service"); refreshCard(); return; }
    if (view.pointers.size) { follow.id = null; refreshCard(); return; }   // the user took the map
    if (view.anim) return;                                                 // still flying there
    if (follow.phase === "track" && view.s === follow.lastS && (Math.abs(view.X - follow.lastX) > 0.01 || Math.abs(view.Y - follow.lastY) > 0.01)) {
      follow.id = null; refreshCard(); return;                             // moved by keys or a fling
    }
    follow.phase = "track";
    const o = geo.ROTS[view.rot];
    const X = T.x * o.R[0] + T.y * o.R[1], Y = -(T.x * o.D[0] + T.y * o.D[1]) * SIN_T - 1.5 * COS_T + (app.mobile ? (view.h * 0.2) / view.s : 0);
    const k = 1 - Math.exp(-Math.min(dt, 0.1) * 3.2);
    // a step under a twentieth of a pixel is no move: with the bus stopped, the view comes to rest (and the map sleeps)
    if (Math.max(Math.abs(X - view.X), Math.abs(Y - view.Y)) * k * view.s > 0.05) view.set(view.X + (X - view.X) * k, view.Y + (Y - view.Y) * k);
    follow.lastX = view.X; follow.lastY = view.Y; follow.lastS = view.s;
  }
  // Turning the camera moves the view's screen coordinates at a stroke (same ground point, new projection), which the
  // check above would take for a pan: the next step starts afresh instead.
  app.on("rotate", () => { if (follow.id) follow.phase = "fly"; });

  // ------------------------------------------------------------------------------------------------ simulation and pace
  // The buses' motion is integrated in every map frame. The map only draws while something moves on screen, so between
  // frames the network tick (4 Hz) carries the motion on, and wakes the map when a bus on screen starts to move (or
  // drives into view). Steps are split to ≤ 0.1 s: the correction springs are integrated explicitly.
  let lastSimAt = performance.now();
  function simulate(nowP) {
    const span = Math.min(1, Math.max(0, (nowP - lastSimAt) / 1000));
    lastSimAt = nowP;
    if (span <= 0) return;
    const n = Math.ceil(span / 0.1), dt = span / n;
    let dropped = false;
    for (const [id, T] of tracks) {
      const wasStale = T.stale, x0 = T.x, y0 = T.y, h0 = T.hdg, a0 = T.alpha * T.appear;
      for (let k = 0; k < n; k++) updateTrack(T, dt, nowP);
      // how fast it changes on screen: metres per second moved (a turn counts its nose's swing), and fade per second
      T.mv = T.mode ? (Math.hypot(T.x - x0, T.y - y0) + Math.abs(angDiff(T.hdg, h0)) * (Math.PI / 180) * BUS.L * 0.5) / span : 0;
      T.fadeV = Math.abs(T.alpha * T.appear - a0) / span;
      if (T.stale !== wasStale && T.mode) dropped = true;
      if ((T.goneAt || T.age > DROP_MS) && T.alpha < 0.02) {
        tracks.delete(id); dropped = true;
        if (sel.kind === "bus" && sel.id === id) UI()?.closeCard?.("transit");
      }
    }
    if (dropped) publish(false);
  }
  // Frames per second the buses need right now: enough for a step of about BUS_STEP px between frames for the fastest
  // bus on screen (3D buses at least 8, far-out markers at least 3, at most 30), more while one fades in or out, 12 for
  // the selected bus's breathing halo; 0 when none on screen changes.
  const BUS_STEP = 1.5;
  let lastAsk = 0;
  function busesWant() {
    if (!tracks.size || !app.layerEnabled("buses")) return 0;
    setCam();
    const s = cam.s, big = s >= MARKER_S, m = 40 + BUS.L * s;
    let pxps = 0, fade = false, halo = false;
    for (const T of tracks.values()) {
      if (!T.mode || (T.alpha * T.appear <= 0.01 && T.fadeV < 0.01) || offSlab(T.x, T.y) > 0) continue;
      const sx = cam.a * T.x + cam.b * T.y + cam.c, sy = cam.d * T.x + cam.e * T.y + cam.f;
      if (sx < -m || sx > cam.w + m || sy < -m || sy > cam.h + m) continue;
      const v = T.mv * s;
      if (v > pxps) pxps = v;
      if (T.fadeV > 0.02) fade = true;
      if (big && isHi(T) && s > 0.8) halo = true;
    }
    let want = pxps > 0.4 ? clamp(pxps / BUS_STEP, big ? 8 : 3, 30) : 0;
    if (fade) want = Math.max(want, big ? 15 : 8);
    if (halo && !reduceMotion.matches) want = Math.max(want, 12);
    return want;
  }
  // between frames (from the network tick): carry the motion on; wake the map if the buses now need frames
  function idleStep() {
    const nowP = performance.now();
    if (nowP - lastSimAt < 200) return;   // frames are coming: they do it
    simulate(nowP);
    if (lastAsk === 0 && busesWant() > 0) app.requestRender("buses");
  }

  // ------------------------------------------------------------------------------------------------ frame
  const perf = { ms: 0, n: 0 };
  app.on("frame", (f) => {
    const t0 = performance.now();
    simulate(t0);
    followStep(f.dt);
    if (card && card.anchor && card.kind === "bus") { const T = tracks.get(card.id); if (T) { card.anchor.x = T.x; card.anchor.y = T.y; } }
    if (transitDue) flushTransit();
    perf.ms += performance.now() - t0;
  });

  // ------------------------------------------------------------------------------------------------ overlay tiles for route lines
  // Route lines belong on the ground, under the buildings and trees in front of the street. That is a tile's worth of
  // painting, so it is done like one: per tile (the base tiles' own grid and level), the lines, then every object that
  // touches them drawn with "destination-out", which erases the line wherever something stands on it. A tile so holds
  // just the visible line, and can be laid over the map at any layer: at night a second set in the routes' dark-mode
  // colours lifts the lines above the night tint. Stop poles are static too, so they go in the same tiles, each followed
  // by the objects standing in front of it, erased the same way. Tiles render a few at a time between frames; until one
  // is ready its parent stands in, else the lines and poles are drawn directly (unoccluded).
  const OT = { cache: new Map(), want: new Map(), pool: [], cover: new Map(), ver: 1, gen: 0, timer: 0, frame: 0, max: app.mobile ? 22 : 44, ms: 0, n: 0, exact: true };
  const newCanvas = () => (typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(TS, TS) : Object.assign(document.createElement("canvas"), { width: TS, height: TS }));
  app.on("style", () => { OT.ver++; });
  let lastDpr = view.dpr;
  window.addEventListener("resize", () => { if (view.dpr !== lastDpr) { lastDpr = view.dpr; OT.ver++; } });
  const tileKey = (set, dark, lines, poles, r, z, tx, ty) => `${set}${dark ? "|n" : ""}${lines ? "|L" : ""}${poles ? "|P" : ""}/${r}/${z}/${tx}/${ty}`;
  const stopsOf = (set) => (set === "*" ? slabStops : slabStops.filter((st) => st.routes.includes(set)));

  function strokeRoutes(g, set, L, box, dark) {
    g.lineJoin = "round"; g.lineCap = "round";
    let any = false;
    g.save();
    if (W) { g.beginPath(); g.rect(W.x0, W.y0, W.x1 - W.x0, W.y1 - W.y0); g.clip(); }
    g.beginPath();
    for (const r of routes) {
      if (set !== "*" && r.code !== set) continue;
      for (const p of r.patterns) { const ln = L.lines.get(p); if (ln && boxesMeet(L.box.get(p), box)) { linePath(g, ln); any = true; } }
    }
    if (!any) { g.restore(); return; }
    g.strokeStyle = HALO; g.lineWidth = L.halo; g.stroke();
    for (let i = routes.length - 1; i >= 0; i--) {
      const r = routes[i];
      if (set !== "*" && r.code !== set) continue;
      g.beginPath();
      let has = false;
      for (const p of r.patterns) { const ln = L.lines.get(p); if (ln && boxesMeet(L.box.get(p), box)) { linePath(g, ln); has = true; } }
      if (!has) continue;
      g.strokeStyle = dark ? r.darkColor : r.color; g.lineWidth = L.w; g.stroke();
    }
    g.restore();
  }
  function linePath(g, ln) { g.moveTo(ln[0], ln[1]); for (let i = 2; i < ln.length; i += 2) g.lineTo(ln[i], ln[i + 1]); }

  // which tiles of a level hold any line (or stop pole) of the set
  function coverage(set, r, L, lines, poles) {
    const key = `${set}/${r}/${L.z}/${view.dpr}/${lines}/${poles}`;
    let c = OT.cover.get(key);
    if (c && c.ver === L.ver) return c.tiles;
    const tiles = new Set(), k = L.k, o = geo.ROTS[r], m = L.halo / 2 + 1, step = TS / k / 3;
    if (poles) {
      const sRef = k / view.dpr, up = (poleTop(sRef) + 6) / sRef, side = (signSize(sRef) + 8) / sRef;
      for (const st of stopsOf(set)) {
        const X = st.x * o.R[0] + st.y * o.R[1], Y = -(st.x * o.D[0] + st.y * o.D[1]) * SIN_T;
        for (let tx = Math.floor(((X - side) * k) / TS); tx <= Math.floor(((X + side) * k) / TS); tx++)
          for (let ty = Math.floor(((Y - up) * k) / TS); ty <= Math.floor(((Y + 4 / sRef) * k) / TS); ty++) tiles.add(tx * 65536 + ty);
      }
    }
    if (lines) for (const rt of routes) {
      if (set !== "*" && rt.code !== set) continue;
      for (const p of rt.patterns) {
        const ln = L.lines.get(p);
        if (!ln) continue;
        for (let i = 0; i + 3 < ln.length; i += 2) {
          const ax = ln[i] * o.R[0] + ln[i + 1] * o.R[1], ay = -(ln[i] * o.D[0] + ln[i + 1] * o.D[1]) * SIN_T;
          const bx = ln[i + 2] * o.R[0] + ln[i + 3] * o.R[1], by = -(ln[i + 2] * o.D[0] + ln[i + 3] * o.D[1]) * SIN_T;
          const pieces = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
          for (let q = 0; q <= pieces; q++) {
            const X = ax + ((bx - ax) * q) / pieces, Y = ay + ((by - ay) * q) / pieces;
            const tx0 = Math.floor(((X - m) * k) / TS), tx1 = Math.floor(((X + m) * k) / TS), ty0 = Math.floor(((Y - m) * k) / TS), ty1 = Math.floor(((Y + m) * k) / TS);
            for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) tiles.add(tx * 65536 + ty);
          }
        }
      }
    }
    OT.cover.set(key, { ver: L.ver, tiles });
    return tiles;
  }

  function renderTile({ set, dark, lines, poles, r, z, tx, ty }) {
    const t0 = performance.now();
    // occluders only rub out, so only their silhouettes matter: a detail level below windows and roof clutter
    // (render.js adds those from 2 px/m) draws the same outlines for a fraction of the work
    const L = level(z), k = L.k, ox = tx * TS, oy = ty * TS, cam0 = { k, lod: Math.min(k, 1.9), ox, oy };
    const c = OT.pool.pop() || newCanvas();
    const g = c.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, TS, TS);
    const o = geo.ROTS[r];
    const X0 = ox / k, Y0 = oy / k, X1 = (ox + TS) / k, Y1 = (oy + TS) / k;
    if (lines) {
      g.setTransform(k * o.R[0], -k * SIN_T * o.D[0], k * o.R[1], -k * SIN_T * o.D[1], -ox, -oy);
      strokeRoutes(g, set, L, groundBoxOf(r, X0, Y0, X1, Y1, L.halo), dark);
      // everything standing on the lines rubs them out
      const ids = occludersOf(set, r, L, X0, Y0, X1, Y1);
      if (ids.length) {
        g.globalCompositeOperation = "destination-out";
        app.renderer.drawObjects(g, r, cam0, ids, app.tileStyle);
        g.globalCompositeOperation = "source-over";
      }
    }
    if (poles) {
      // far stops first; each is then rubbed out by whatever stands in front of it
      const dpr = view.dpr, sRef = k / dpr, sc = app.scene;
      const list = [];
      for (const st of stopsOf(set)) {
        const X = st.x * o.R[0] + st.y * o.R[1], Y = -(st.x * o.D[0] + st.y * o.D[1]) * SIN_T;
        if (X < X0 - 30 / sRef || X > X1 + 30 / sRef || Y < Y0 - 4 / sRef || Y > Y1 + (poleTop(sRef) + 10) / sRef) continue;
        list.push({ st, X, Y, depth: st.x * o.D[0] + st.y * o.D[1] });
      }
      list.sort((a, b) => b.depth - a.depth);
      for (const { st, X, Y } of list) {
        const px = (X * k - ox) / dpr, py = (Y * k - oy) / dpr;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        const box = paintStop(g, st, px, py, sRef, dark, false);
        const ids = sc.query(r, "objects", X + (box[0] - px) / sRef, Y + (box[1] - py) / sRef, X + (box[2] - px) / sRef, Y + (box[3] - py) / sRef)
          .filter((i) => sc.inFront(r, i, st.x, st.y, 0.6));
        if (ids.length) {
          g.globalCompositeOperation = "destination-out";
          app.renderer.drawObjects(g, r, cam0, ids, app.tileStyle);
          g.globalCompositeOperation = "source-over";
        }
      }
    }
    OT.ms += performance.now() - t0; OT.n++;
    return c;
  }
  function occludersOf(set, r, L, X0, Y0, X1, Y1) {
    const o = geo.ROTS[r], m = L.halo / 2 + 0.5, found = new Set();
    for (const rt of routes) {
      if (set !== "*" && rt.code !== set) continue;
      for (const p of rt.patterns) {
        const ln = L.lines.get(p);
        if (!ln) continue;
        for (let i = 0; i + 3 < ln.length; i += 2) {
          const ax = ln[i] * o.R[0] + ln[i + 1] * o.R[1], ay = -(ln[i] * o.D[0] + ln[i + 1] * o.D[1]) * SIN_T;
          const bx = ln[i + 2] * o.R[0] + ln[i + 3] * o.R[1], by = -(ln[i + 2] * o.D[0] + ln[i + 3] * o.D[1]) * SIN_T;
          if (Math.max(ax, bx) + m < X0 || Math.min(ax, bx) - m > X1 || Math.max(ay, by) + m < Y0 || Math.min(ay, by) - m > Y1) continue;
          const pieces = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 8));
          for (let q = 0; q < pieces; q++) {
            const xa = ax + ((bx - ax) * q) / pieces, ya = ay + ((by - ay) * q) / pieces;
            const xb = ax + ((bx - ax) * (q + 1)) / pieces, yb = ay + ((by - ay) * (q + 1)) / pieces;
            const qx0 = Math.max(X0, Math.min(xa, xb) - m), qx1 = Math.min(X1, Math.max(xa, xb) + m);
            const qy0 = Math.max(Y0, Math.min(ya, yb) - m), qy1 = Math.min(Y1, Math.max(ya, yb) + m);
            if (qx0 > qx1 || qy0 > qy1) continue;
            for (const id of app.scene.query(r, "objects", qx0, qy0, qx1, qy1)) found.add(id);
          }
        }
      }
    }
    const ids = [...found];
    const rank = app.scene.forRot(r).rank;
    ids.sort((a, b) => rank[a] - rank[b]);
    return ids;
  }
  function wantTile(key, spec, pri) {
    const cur = OT.want.get(key);
    if (!cur || cur.pri > pri) OT.want.set(key, { ...spec, pri, frame: OT.frame });
    else cur.frame = OT.frame;
  }
  function pumpTiles() {
    if (OT.timer || !OT.want.size) return;
    OT.timer = setTimeout(() => {
      OT.timer = 0;
      const t0 = performance.now();
      let made = false;
      // a few milliseconds of painting between frames, nearest the centre first
      while (OT.want.size && performance.now() - t0 < 7) {
        let best = null, bk = null;
        for (const [key, w] of OT.want) {
          if (OT.frame - w.frame > 2) { OT.want.delete(key); continue; }
          if (!best || w.pri < best.pri) { best = w; bk = key; }
        }
        if (!best) break;
        OT.want.delete(bk);
        const ver = OT.ver;
        const c = renderTile(best);
        const old = OT.cache.get(bk);
        if (old && old.c !== c) OT.pool.push(old.c);
        OT.cache.set(bk, { c, ver, used: OT.frame });
        OT.gen++;
        made = true;
        evictTiles();
      }
      if (OT.want.size) pumpTiles();
      // the map only draws when asked: show what just came in (each batch is wanted by the view, so it shows)
      if (made) app.requestRender("bus-tiles");
    }, 0);
  }
  function evictTiles() {
    if (OT.cache.size <= OT.max) return;
    const items = [...OT.cache.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [key, e] of items) {
      if (OT.cache.size <= OT.max || e.used >= OT.frame - 1) break;
      OT.cache.delete(key);
      if (OT.pool.length < 6) OT.pool.push(e.c);
    }
  }

  // draw one set's lines and/or stop poles: cached tiles where ready, stand-ins elsewhere
  function drawRouteSet(ctx, set, alpha, dark, lines, poles) {
    const z = app.tiles.levelFor(view);
    const L = level(z);
    ctx.globalAlpha = alpha;
    if (z < TILE_Z0) {
      if (lines) { groundXform(ctx); strokeRoutes(ctx, set, L, viewGroundBox(L.halo), dark); bbAdd(-1e9, -1e9, 1e9, 1e9); }
      return;
    }
    const k = L.k, s = view.s, dpr = view.dpr, r = view.rot;
    const cover = coverage(set, r, L, lines, poles);
    const X0 = view.X - view.w / 2 / s, X1 = view.X + view.w / 2 / s, Y0 = view.Y - view.h / 2 / s, Y1 = view.Y + view.h / 2 / s;
    const tx0 = Math.floor((X0 * k) / TS), tx1 = Math.floor((X1 * k) / TS), ty0 = Math.floor((Y0 * k) / TS), ty1 = Math.floor((Y1 * k) / TS);
    const edgeX = (X) => Math.round(((X - view.X) * s + view.w / 2) * dpr);
    const edgeY = (Y) => Math.round(((Y - view.Y) * s + view.h / 2) * dpr);
    const cx = (X0 + X1) / 2, cy = (Y0 + Y1) / 2;
    let missing = null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      if (!cover.has(tx * 65536 + ty)) continue;
      const key = tileKey(set, dark, lines, poles, r, z, tx, ty);
      const dx0 = edgeX((tx * TS) / k), dx1 = edgeX(((tx + 1) * TS) / k), dy0 = edgeY((ty * TS) / k), dy1 = edgeY(((ty + 1) * TS) / k);
      const e = OT.cache.get(key);
      const dist = Math.hypot(((tx + 0.5) * TS) / k - cx, ((ty + 0.5) * TS) / k - cy) * k;
      bbAdd(dx0, dy0, dx1, dy1);
      if (e) {
        e.used = OT.frame;
        ctx.drawImage(e.c, dx0, dy0, dx1 - dx0, dy1 - dy0);
        if (e.ver !== OT.ver) { wantTile(key, { set, dark, lines, poles, r, z, tx, ty }, 1e9 + dist); OT.exact = false; }
        continue;
      }
      wantTile(key, { set, dark, lines, poles, r, z, tx, ty }, dist);
      OT.exact = false;   // a stand-in: the picture is not final
      // the parent tile, scaled, if we have it
      const pe = OT.cache.get(tileKey(set, dark, lines, poles, r, z - 1, tx >> 1, ty >> 1));
      if (pe && z - 1 >= TILE_Z0) {
        pe.used = OT.frame;
        const sub = TS / 2;
        ctx.drawImage(pe.c, (tx & 1) * sub, (ty & 1) * sub, sub, sub, dx0, dy0, dx1 - dx0, dy1 - dy0);
        continue;
      }
      (missing || (missing = [])).push(dx0, dy0, dx1 - dx0, dy1 - dy0);
    }
    if (missing) {
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < missing.length; i += 4) ctx.rect(missing[i], missing[i + 1], missing[i + 2], missing[i + 3]);
      ctx.clip();
      if (lines) { groundXform(ctx); strokeRoutes(ctx, set, L, viewGroundBox(L.halo), dark); }
      if (poles) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const list = stopsOf(set).filter((st) => st.vis).sort((a, b) => b.depth - a.depth);
        for (const st of list) paintStop(ctx, st, st.px, st.py, s, dark, false);
      }
      ctx.restore();
    }
    pumpTiles();
  }

  // ------------------------------------------------------------------------------------------------ layer: route lines
  // all routes, or the selected one bright over the rest dimmed
  function drawRoutes(ctx, alpha, dark, lines, poles) {
    if (alpha < 0.01 || (!lines && !poles)) return;
    const hi = selectedRoute();
    if (hi && routeBy.has(hi)) {
      drawRouteSet(ctx, "*", 0.28 * alpha, dark, lines, poles);
      drawRouteSet(ctx, hi, alpha, dark, lines, poles);
    } else drawRouteSet(ctx, "*", alpha, dark, lines, poles);
    ctx.globalAlpha = 1;
  }
  // lines, and the stop poles when they are on and near enough to be poles
  function drawGround(ctx, lines, f) {
    const poles = app.layerEnabled("stops") && view.s >= POLE_S && stopList.length > 0;
    projectStops();
    if (!lines && !poles) return;
    // after dark the routes' own dark-mode colours (lighter) take over, so the lines survive the night tint while
    // everything that drives over them still covers them. Laid over the day set they cross-fade through dusk; once
    // they are opaque the day set beneath would be hidden, so it is not drawn (nor are its tiles rendered). The blend
    // moves in 64ths, so a still picture is not recomposed for every imperceptible step of dusk.
    const night = nightLevel(), a = night > 0.05 ? Math.round(Math.min(1, night * 1.1) * 64) / 64 : 0;
    const hi = selectedRoute(), W = app.canvas.width, H = app.canvas.height, K = RC.k;
    if (RC.c && K.X === view.X && K.Y === view.Y && K.s === view.s && K.rot === view.rot && K.W === W && K.H === H && K.dpr === view.dpr &&
      K.ver === OT.ver && K.gen === OT.gen && K.geom === geomVer && K.hi === hi && K.lines === lines && K.poles === poles && K.a === a) {
      blitGround(ctx);
      return;
    }
    K.X = NaN;
    if (f.moving || !W || !H) { paintGround(ctx, lines, poles, a); return; }
    // a still view: compose once, then copy (also this frame)
    if (!RC.c || RC.c.width !== W || RC.c.height !== H) {
      RC.c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(W, H) : Object.assign(document.createElement("canvas"), { width: W, height: H });
      RC.g = RC.c.getContext("2d");
    }
    const g = RC.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, W, H);
    g.imageSmoothingQuality = ctx.imageSmoothingQuality;
    OT.exact = true;
    const B = RC.bb;
    B[0] = B[1] = Infinity; B[2] = B[3] = -Infinity;
    paintGround(g, lines, poles, a);
    // the part painted, on whole pixels inside the canvas (empty: x0 ≥ x1)
    B[0] = Math.max(0, Math.floor(B[0])); B[1] = Math.max(0, Math.floor(B[1])); B[2] = Math.min(W, Math.ceil(B[2])); B[3] = Math.min(H, Math.ceil(B[3]));
    // only a picture made of final tiles is kept (until then each arriving batch draws a frame and recomposes)
    if (OT.exact) {
      K.X = view.X; K.Y = view.Y; K.s = view.s; K.rot = view.rot; K.W = W; K.H = H; K.dpr = view.dpr;
      K.ver = OT.ver; K.gen = OT.gen; K.geom = geomVer; K.hi = hi; K.lines = lines; K.poles = poles; K.a = a;
    }
    blitGround(ctx);
  }
  function blitGround(ctx) {
    const B = RC.bb, w = B[2] - B[0], h = B[3] - B[1];
    if (w <= 0 || h <= 0) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(RC.c, B[0], B[1], w, h, B[0], B[1], w, h);
  }
  // grow the box of what the composition holds (device px); drawing straight onto the map, it is not needed
  function bbAdd(x0, y0, x1, y1) {
    const B = RC.bb;
    if (x0 < B[0]) B[0] = x0; if (y0 < B[1]) B[1] = y0; if (x1 > B[2]) B[2] = x1; if (y1 > B[3]) B[3] = y1;
  }
  function paintGround(ctx, lines, poles, a) {
    if (a < 0.999) drawRoutes(ctx, 1, false, lines, poles);
    if (a > 0) drawRoutes(ctx, a, true, lines, poles);
  }
  // A still view's lines and poles are composed once into a canvas the size of the map and copied 1:1 in the frames after
  // (scaling a screenful of overlay tiles, or stroking every route from afar, costs 10–20 ms a frame on a canvas without
  // a GPU; the copy about 1). While the view moves they are drawn straight onto the map.
  const RC = { c: null, g: null, bb: [0, 0, 0, 0], k: { X: NaN, Y: 0, s: 0, rot: 0, W: 0, H: 0, dpr: 0, ver: 0, gen: 0, geom: 0, hi: null, lines: false, poles: false, a: 0 } };
  app.on("layers", () => { if (!app.layerEnabled("routes") && !app.layerEnabled("stops")) { RC.c = RC.g = null; RC.k.X = NaN; } });
  app.addLayer({
    id: "routes", z: 10,
    fps: 0,   // still: what moves over the lines (buses) asks for its own frames
    draw(ctx, f) {
      OT.frame = f.frame;
      if (!routes.length || !geomVer) return;
      setCam();
      drawGround(ctx, true, f);
    },
    hit(px, py) {
      if (!geomVer || view.s < 0.25) return null;
      const [gx, gy] = view.screenToGround(px, py);
      if (offSlab(gx, gy) > 0) return null;   // lines are not drawn off the map
      setCam();
      const L = level(app.tiles.levelFor(view));
      const tol = Math.max(app.mobile ? 9 : 5, (L.w * view.s) / 2 + 2);
      let best = tol * tol, code = null;
      for (const r of routes) for (const p of r.patterns) {
        const ln = L.lines.get(p);
        if (!ln) continue;
        let ax = cam.a * ln[0] + cam.b * ln[1] + cam.c, ay = cam.d * ln[0] + cam.e * ln[1] + cam.f;
        for (let i = 2; i < ln.length; i += 2) {
          const bx = cam.a * ln[i] + cam.b * ln[i + 1] + cam.c, by = cam.d * ln[i] + cam.e * ln[i + 1] + cam.f;
          const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
          const t = L2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / L2, 0, 1) : 0;
          const ex = ax + dx * t - px, ey = ay + dy * t - py, d2 = ex * ex + ey * ey;
          if (d2 < best) { best = d2; code = r.code; }
          ax = bx; ay = by;
        }
      }
      // a line runs under the buildings: whatever building is at the pixel wins the click
      if (!code || app.pickBuilding(px, py) >= 0) return null;
      return { kind: "route", code };
    },
    onClick(t) { openRoute(t.code, { fly: false }); },
    onHover(t, e) { setHover(t ? "route" : null, t && t.code, e); },
  });

  // ------------------------------------------------------------------------------------------------ layer: stops
  const visStops = [];
  app.addLayer({
    id: "stops", z: 20,
    fps: 0,
    draw(ctx, f) {
      OT.frame = f.frame;
      if (!stopList.length) return;
      setCam();
      if (cam.s < POLE_S) { projectStops(); for (const st of visStops) drawStopDot(ctx, st); return; }
      // the poles live in the route tiles; with the route lines switched off, draw those tiles here
      if (!app.layerEnabled("routes")) drawGround(ctx, false, f);
      // the selected stop stands out: drawn again, a size up, over its tile
      const st = sel.kind === "stop" && stops.get(sel.id);
      if (st && st.vis) {
        ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
        // the ring lies on the ground round the pole: whatever stands in front of it covers it, as it covers the pole
        const rx = Math.max(10, cam.s * 2.2), ry = Math.max(5, cam.s * 1.1);
        ctx.strokeStyle = "rgba(179, 32, 42, .9)"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(st.px, st.py, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
        app.occlude(ctx, st.x, st.y, [st.px - rx - 2, st.py - ry - 2, st.px + rx + 2, st.py + ry + 2], rx / cam.s);
        const box = paintStop(ctx, st, st.px, st.py, cam.s, false, true);
        app.occlude(ctx, st.x, st.y, box, 0.6);
      }
    },
    hit(px, py) {
      const R = app.mobile ? 22 : 13, poles = view.s >= POLE_S;
      let best = R * R, id = null;
      for (const st of visStops) {
        const top = poles ? poleTop(view.s) : 0;
        const dx = px - st.px, dy = py - clamp(py, st.py - top - 6, st.py + 2);
        const d2 = dx * dx + dy * dy;
        // a pole behind a building is rubbed out of the line tiles: there the building takes the click
        if (d2 < best && !(poles && behindBuilding(st.x, st.y, 0.6, px, py))) { best = d2; id = st.id; }
      }
      return id ? { kind: "stop", id } : null;
    },
    onClick(t) { openStop(t.id, { fly: false }); },
    onHover(t, e) { setHover(t ? "stop" : null, t && t.id, e); },
  });
  // which stops are on screen, where (the same frame's projection serves dots, tiles' fallbacks and hits)
  let projFrame = -1;
  function projectStops() {
    if (projFrame === OT.frame && visStops.length) return;
    projFrame = OT.frame;
    const hi = selectedRoute(), showAll = cam.s >= 0.32;
    visStops.length = 0;
    for (const st of stopList) st.vis = false;
    for (const st of slabStops) {
      const onHi = hi ? st.routes.includes(hi) : false;
      if (!showAll && !onHi && !(sel.kind === "stop" && sel.id === st.id)) continue;
      const px = cam.a * st.x + cam.b * st.y + cam.c, py = cam.d * st.x + cam.e * st.y + cam.f;
      if (px < -30 || px > cam.w + 30 || py < -10 || py > cam.h + 60) continue;
      st.px = px; st.py = py; st.depth = st.x * cam.D0 + st.y * cam.D1; st.dim = !!hi && !onHi; st.vis = true;
      visStops.push(st);
    }
  }
  const poleTop = (s) => Math.max(11, 2.7 * s * COS_T) + signSize(s) * 1.15;
  const signSize = (s) => clamp(s * 1.2, 7.5, 16);

  function drawStopDot(ctx, st) {
    const big = (sel.kind === "stop" && sel.id === st.id) || (hover.kind === "stop" && hover.id === st.id);
    const r = (view.s < 0.7 ? 2.3 : 3.1) + (app.mobile ? 0.5 : 0) + (big ? 1.2 : 0);
    ctx.globalAlpha = st.dim ? 0.4 : 1;
    ctx.beginPath(); ctx.arc(st.px, st.py, r, 0, Math.PI * 2);
    ctx.fillStyle = "#fbf8f1"; ctx.fill();
    const n = st.routes.length;
    ctx.lineWidth = r < 3 ? 1.4 : 1.7;
    for (let i = 0; i < n; i++) {
      const rt = routeBy.get(st.routes[i]);
      ctx.beginPath();
      ctx.arc(st.px, st.py, r, -Math.PI / 2 + (i / n) * Math.PI * 2, -Math.PI / 2 + ((i + 1) / n) * Math.PI * 2);
      ctx.strokeStyle = rt ? rt.color : "#6d6e71"; ctx.stroke();
    }
    if (sel.kind === "stop" && sel.id === st.id) {
      ctx.beginPath(); ctx.arc(st.px, st.py, r + 3, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(179, 32, 42, .85)"; ctx.lineWidth = 1.5; ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // a stop: a pole with a plate showing the colours of the routes that call there. Sizes are CSS px for scale s;
  // returns the box it covers, for occlusion.
  function paintStop(ctx, st, px, py, s, dark, big) {
    const hpx = Math.max(11, 2.7 * s * COS_T);
    const sw = signSize(s) * (big ? 1.2 : 1), sh = sw * 1.15;
    const pw = clamp(s * 0.11, 1.2, 2.4);
    ctx.fillStyle = "rgba(38, 50, 60, .2)";
    ctx.beginPath(); ctx.ellipse(px + sw * 0.3, py + 0.5, sw * 0.55, sw * 0.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#575b61";
    ctx.fillRect(px - pw / 2, py - hpx, pw, hpx);
    ctx.fillStyle = "#7b8087";
    ctx.fillRect(px - pw / 2, py - hpx, pw * 0.4, hpx);
    const x0 = px - sw / 2, y0 = py - hpx - sh * 0.85, rr = Math.min(2.5, sw * 0.18);
    ctx.fillStyle = "rgba(38, 30, 22, .25)";
    roundRectPath(ctx, x0 + 0.8, y0 + 1.2, sw, sh, rr); ctx.fill();
    ctx.fillStyle = "#fbf8f1";
    roundRectPath(ctx, x0, y0, sw, sh, rr); ctx.fill();
    const n = Math.min(4, st.routes.length), pad = Math.max(1, sw * 0.12);
    const bw = (sw - pad * 2) / Math.max(1, n), by0 = y0 + sh * 0.36, bh = sh - sh * 0.36 - pad;
    for (let i = 0; i < n; i++) {
      const rt = routeBy.get(st.routes[i]);
      ctx.fillStyle = rt ? (dark ? rt.darkColor : rt.color) : "#6d6e71";
      ctx.fillRect(x0 + pad + i * bw, by0, bw + 0.3, bh);
    }
    // the dark header band of a bus-stop plate
    ctx.fillStyle = "#2a2622";
    ctx.fillRect(x0 + pad, y0 + pad, sw - pad * 2, Math.max(1, sh * 0.36 - pad * 1.6));
    return [x0 - 2, y0 - 2, x0 + sw + 3, py + 3];
  }
  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  // ------------------------------------------------------------------------------------------------ layer: buses
  const visBuses = [];
  let drawnFrame = -1, tagFrame = -1;   // the frames the buses and their tags were last drawn in
  function collectBuses() {
    visBuses.length = 0;
    const m = 40 + BUS.L * cam.s;
    for (const T of tracks.values()) {
      T.drawn = false;
      if (!T.mode || T.alpha * T.appear <= 0.01 || offSlab(T.x, T.y) > 0) continue;
      const sx = cam.a * T.x + cam.b * T.y + cam.c, sy = cam.d * T.x + cam.e * T.y + cam.f;
      if (sx < -m || sx > cam.w + m || sy < -m || sy > cam.h + m) continue;
      T.sx = sx; T.sy = sy; T.depth = T.x * cam.D0 + T.y * cam.D1;
      visBuses.push(T);
    }
    visBuses.sort(byDepthDesc);
  }
  const byDepthDesc = (a, b) => b.depth - a.depth;
  const OCC = [0, 0, 0, 0], FRONT_OPTS = { buildingsOnly: true };   // scratch (no allocation per frame)
  const isHi = (T) => (sel.kind === "bus" && sel.id === T.id) || follow.id === T.id;

  app.addLayer({
    id: "buses", z: 50,
    // after each frame: what the buses on screen need (see busesWant); the tags and lights move with them
    fps() { lastAsk = busesWant(); return lastAsk; },
    draw(ctx, f) {
      const t0 = performance.now();
      setCam();
      collectBuses();
      drawnFrame = f.frame;
      if (cam.s >= MARKER_S) {
        const night = nightLevel();
        for (const T of visBuses) {
          if (isHi(T)) {
            // the halo lies on the ground: what stands in front of it covers it (before the bus is drawn over both)
            const R = drawHalo(ctx, T, f.t), rx = R * cam.s + 2, ry = R * cam.s * SIN_T + 2;
            ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
            ctx.globalAlpha = 1;
            OCC[0] = T.sx - rx; OCC[1] = T.sy - ry; OCC[2] = T.sx + rx; OCC[3] = T.sy + ry;
            app.occlude(ctx, T.x, T.y, OCC, R);
          }
          drawBus(ctx, T, night);
          T.drawn = true;
          ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
          ctx.globalAlpha = 1;
          const hw = 0.5 * (BUS.L * Math.abs(T.fx * cam.R0 + T.fy * cam.R1) + BUS.W * Math.abs(T.fy * cam.R0 - T.fx * cam.R1));
          T.hw = hw;
          OCC[0] = T.bb0 - 1; OCC[1] = T.bb1 - 1; OCC[2] = T.bb2 + 1; OCC[3] = T.bb3 + 1;
          T.occ = app.occlude(ctx, T.x, T.y, OCC, hw);
          // the night glow (drawn above the tint, so not occluded) is held back only where a building is in front
          T.occB = night > 0.05 && T.occ > 0 && buildingInFront(T, hw);
        }
      } else for (const T of visBuses) { T.bb0 = T.sx - 10; T.bb1 = T.sy - 10; T.bb2 = T.sx + 10; T.bb3 = T.sy + 10; T.occ = 0; }
      perf.ms += performance.now() - t0; perf.n++;
    },
    hit(px, py) {
      const pad = app.mobile ? 10 : 4, R = (app.mobile ? 12 : 10) + pad;
      if (view.s < MARKER_S) {
        // far out a bus is a marker drawn over everything
        for (let i = visBuses.length - 1; i >= 0; i--) {
          const T = visBuses[i];
          if (!T.goneAt && (px - T.sx) ** 2 + (py - T.sy) ** 2 < R * R) return { kind: "bus", id: T.id };
        }
        return null;
      }
      // the route pills float above everything (and above a bus hidden behind a building): they are tried first,
      // in drawing order reversed, so the pill on top wins
      for (let i = visBuses.length - 1; i >= 0; i--) {
        const T = visBuses[i], b = T.pl;
        if (!T.goneAt && T.plF === tagFrame && px >= b[0] - pad && px <= b[2] + pad && py >= b[1] - pad && py <= b[3] + pad) return { kind: "bus", id: T.id };
      }
      // then the buses themselves, nearest first; where a building stands in front of one, the building takes the click
      for (let i = visBuses.length - 1; i >= 0; i--) {
        const T = visBuses[i];
        if (T.goneAt || !T.drawn || px < T.bb0 - pad || px > T.bb2 + pad || py < T.bb1 - pad || py > T.bb3 + pad) continue;
        if (T.occ > 0 && behindBuilding(T.x, T.y, T.hw, px, py)) continue;
        return { kind: "bus", id: T.id };
      }
      return null;
    },
    onClick(t) { openVehicle(t.id, { fly: false }); },
    onHover(t, e) { setHover(t ? "bus" : null, t && t.id, e); },
  });

  const buildingInFront = (T, hw) => { OCC[0] = T.bb0; OCC[1] = T.bb1; OCC[2] = T.bb2; OCC[3] = T.bb3; return app.inFront(T.x, T.y, OCC, hw, FRONT_OPTS).length > 0; };
  /** is the pixel (px, py) on a building that stands in front of ground point (x, y)? Then the building is what shows
   *  there, and it should take the click. */
  function behindBuilding(x, y, hw, px, py) {
    const b = app.pickBuilding(px, py);
    return b >= 0 && app.inFront(x, y, [px - 1, py - 1, px + 1, py + 1], hw, { buildingsOnly: true }).includes(b);
  }
  // night as the sky layer sees it; with "Real sky & weather" switched off the map is in daylight, so buses are too
  function nightLevel() { if (!app.layerEnabled("sky")) return 0; const W = app.weather; return W && Number.isFinite(W.night) ? clamp(W.night, 0, 1) : 0; }

  // a soft pool of light on the ground round the selected or followed bus, ringed in its route colour
  const ringCol = new Map();   // route colour → the ring's rgba
  function drawHalo(ctx, T, t) {
    const pulse = reduceMotion.matches ? 1 : 1 + 0.06 * Math.sin(t / 420);
    groundXform(ctx);
    const col = T.route ? T.route.color : "#b3202a", R = 10.5 * pulse;
    if (SPR.halo) ctx.drawImage(SPR.halo, T.x - R, T.y - R, 2 * R, 2 * R);
    let ring = ringCol.get(col);
    if (!ring) ringCol.set(col, (ring = rgba(col, 0.55)));
    ctx.strokeStyle = ring; ctx.lineWidth = Math.max(0.35, 1.6 / cam.s);
    ctx.beginPath(); ctx.arc(T.x, T.y, R * 0.86, 0, Math.PI * 2); ctx.stroke();
    return R;
  }
  // light sprites, drawn once: the halo's pool (a disc of radius 1 in a 2 × 2 square) and a headlight pool on the road
  // (u forward 0…BEAM.L m, v across ±BEAM.W m, as BEAM.px px per metre), both laid on the ground by the transform
  const BEAM = { L: 22, W: 4.5, px: 8 };
  const SPR = (() => {
    const mk = (w, h) => (typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h }));
    try {
      const halo = mk(128, 128), h = halo.getContext("2d");
      const g = h.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, "rgba(255, 250, 235, .7)"); g.addColorStop(0.62, "rgba(255, 250, 235, .35)"); g.addColorStop(1, "rgba(255, 250, 235, 0)");
      h.fillStyle = g; h.beginPath(); h.arc(64, 64, 64, 0, Math.PI * 2); h.fill();
      const k = BEAM.px, bw = Math.round(BEAM.L * k), bh = Math.round(2 * BEAM.W * k);
      const beam = mk(bw, bh), b = beam.getContext("2d");
      const lg = b.createLinearGradient(0, 0, bw, 0);
      lg.addColorStop(0, "rgba(255, 224, 165, .5)"); lg.addColorStop(1, "rgba(255, 224, 165, 0)");
      b.fillStyle = lg;
      const c = bh / 2, hw = (BUS.W / 2) * k;
      b.beginPath(); b.moveTo(0, c - hw); b.lineTo(0, c + hw); b.lineTo(bw, bh); b.lineTo(bw, 0); b.closePath(); b.fill();
      return { halo, beam };
    } catch { return {}; }
  })();

  // The bus: a box 12 × 2.55 × 2.85 m on 0.32 m of clearance. Each visible face is drawn in its own flat frame (u along
  // the face, h up it) by putting the face's projection into the canvas transform — the view is affine, so rectangles
  // and circles drawn there land exactly on the face, wheels become ellipses, and nothing allocates.
  const SF = [-1, -1, 1, 1], SR = [-1, 1, 1, -1];   // footprint corners, counter-clockwise: rear-left, rear-right, front-right, front-left
  let nightNow = 0;
  function drawBus(ctx, T, night) {
    nightNow = night;
    const dpr = cam.dpr, s = cam.s;
    const fx = T.fx, fy = T.fy, rx = fy, ry = -fx;
    const hl = BUS.L / 2, hw = BUS.W / 2, H = BUS.H, cl = BUS.clear;
    const Fx = cam.a * fx + cam.b * fy, Fy = cam.d * fx + cam.e * fy;   // screen px per metre forward
    const Rx = cam.a * rx + cam.b * ry, Ry = cam.d * rx + cam.e * ry;   // … per metre to the bus's right
    const zf = cam.zf;
    const Cx = T.sx, Cy = T.sy;
    const col = T.route ? T.route.color : "#6d6e71";
    const detail = s >= 2.4, fine = s >= 5.5;
    ctx.globalAlpha = T.alpha * T.appear;

    // screen box (for occlusion and hits)
    const ex = Math.abs(Fx * hl) + Math.abs(Rx * hw), ey = Math.abs(Fy * hl) + Math.abs(Ry * hw);
    T.bb0 = Cx - ex; T.bb2 = Cx + ex; T.bb1 = Cy - ey + zf * (cl + H + 0.2); T.bb3 = Cy + ey + 1;

    // shadow: the footprint swept along the sun's shadow vector (a hexagon), and a darker contact patch
    groundXform(ctx);
    const gx = (cl + H) * (SH_U * cam.R0 + SH_V * cam.D0), gy = (cl + H) * (SH_U * cam.R1 + SH_V * cam.D1);
    const gf = fx * gx + fy * gy, gr = rx * gx + ry * gy;
    const nd0 = -gf, nd1 = gr, nd2 = gf, nd3 = -gr;   // edge normals · shadow vector, edges e0..e3 from corner i to i+1
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const px = T.x + fx * hl * SF[i] + rx * hw * SR[i], py = T.y + fy * hl * SF[i] + ry * hw * SR[i];
      const prev = i === 0 ? nd3 : i === 1 ? nd0 : i === 2 ? nd1 : nd2, next = i === 0 ? nd0 : i === 1 ? nd1 : i === 2 ? nd2 : nd3;
      const a = prev > 0, b = next > 0;
      if (!a && !b) ctx.lineTo(px, py);
      else if (a && b) ctx.lineTo(px + gx, py + gy);
      else if (!a && b) { ctx.lineTo(px, py); ctx.lineTo(px + gx, py + gy); }
      else { ctx.lineTo(px + gx, py + gy); ctx.lineTo(px, py); }
    }
    ctx.closePath();
    ctx.fillStyle = `rgba(38, 50, 60, ${0.2 * (1 - 0.7 * night)})`;
    ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < 4; i++) ctx.lineTo(T.x + fx * (hl + 0.15) * SF[i] + rx * (hw + 0.2) * SR[i], T.y + fy * (hl + 0.15) * SF[i] + ry * (hw + 0.2) * SR[i]);
    ctx.closePath();
    ctx.fillStyle = "rgba(30, 28, 25, .22)";
    ctx.fill();

    // which faces look at us, and how they are lit
    const fd = fx * cam.D0 + fy * cam.D1, rd = rx * cam.D0 + ry * cam.D1;
    const fu = fx * cam.R0 + fy * cam.R1, ru = rx * cam.R0 + ry * cam.R1;
    const lit = (nu, ndv) => 0.72 + 0.34 * Math.max(0, -(nu * LIGHT_U + ndv * LIGHT_V));
    if (Math.abs(rd) > 0.015) {
      const sg = rd < 0 ? 1 : -1;
      const ox = Cx + Rx * hw * sg - Fx * hl, oy = Cy + Ry * hw * sg - Fy * hl + zf * cl;
      ctx.setTransform(dpr * Fx, dpr * Fy, 0, dpr * zf, dpr * ox, dpr * oy);
      sideFace(ctx, lit(ru * sg, rd * sg), col, sg > 0, detail, fine);
    }
    if (Math.abs(fd) > 0.015) {
      const front = fd < 0, sg = front ? 1 : -1;
      const ox = Cx + Fx * hl * sg - Rx * hw, oy = Cy + Fy * hl * sg - Ry * hw + zf * cl;
      ctx.setTransform(dpr * Rx, dpr * Ry, 0, dpr * zf, dpr * ox, dpr * oy);
      endFace(ctx, lit(fu * sg, fd * sg), col, front, detail);
    }
    // the roof
    ctx.setTransform(dpr * Fx, dpr * Fy, dpr * Rx, dpr * Ry, dpr * Cx, dpr * (Cy + zf * (cl + H)));
    roofFace(ctx, col, detail);
  }

  function sideFace(ctx, f, col, curbSide, detail, fine) {
    const L = BUS.L, H = BUS.H;
    ctx.fillStyle = tone(BODY, f); ctx.fillRect(0, 0, L, H);
    ctx.fillStyle = tone(BODY, f * 0.8); ctx.fillRect(0, 0, L, 0.26);           // the dark sill along the bottom
    ctx.fillStyle = tone(col, f); ctx.fillRect(0, 0.6, L, 0.36);                 // the route's colour band
    ctx.fillStyle = tone(nightNow > 0.3 ? GLASS_LIT : GLASS, 0.8 + f * 0.25);
    ctx.fillRect(0.5, 1.2, L - 1.0, 1.12);                                       // the window band (lit inside after dark)
    if (detail) {
      ctx.fillStyle = tone(col, f * 1.05); ctx.fillRect(0.5, H - 0.22, L - 1.0, 0.12);   // a thin stripe under the roof line
      if (fine) {
        ctx.fillStyle = tone(BODY, f * 0.96);
        for (let u = 1.9; u < L - 1.4; u += 1.45) ctx.fillRect(u, 1.2, 0.12, 1.12);       // window pillars
      }
      if (curbSide) {
        // doors on the kerb side: front and centre
        ctx.fillStyle = tone(GLASS, 0.7 + f * 0.2);
        ctx.fillRect(L - 1.75, 0.24, 1.1, 2.1);
        ctx.fillRect(5.1, 0.24, 1.15, 2.1);
        if (fine) { ctx.fillStyle = tone(BODY, f * 0.9); ctx.fillRect(L - 1.22, 0.24, 0.05, 2.1); ctx.fillRect(5.65, 0.24, 0.05, 2.1); }
      }
      // wheels in their arches
      for (const u of [2.5, L - 2.65]) {
        ctx.fillStyle = tone(BODY, f * 0.55);
        ctx.beginPath(); ctx.arc(u, 0, 0.66, 0, Math.PI); ctx.fill();
        ctx.fillStyle = TYRE;
        ctx.beginPath(); ctx.arc(u, 0.18, 0.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#9a9894";
        ctx.beginPath(); ctx.arc(u, 0.18, 0.2, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  function endFace(ctx, f, col, front, detail) {
    const W = BUS.W, H = BUS.H;
    ctx.fillStyle = tone(BODY, f); ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = tone(col, f); ctx.fillRect(0, 0.6, W, 0.36);
    ctx.fillStyle = tone("#4a4a4a", f); ctx.fillRect(0, 0, W, 0.24);   // bumper
    if (front) {
      ctx.fillStyle = tone(GLASS, 0.82 + f * 0.25);
      ctx.fillRect(0.1, 1.0, W - 0.2, 1.42);                         // windscreen
      ctx.fillStyle = "#ffbf4d";
      ctx.fillRect(0.28, 2.5, W - 0.56, 0.24);                        // the lit destination sign
      if (detail) {
        ctx.fillStyle = "rgba(255, 255, 255, .16)";
        ctx.beginPath(); ctx.moveTo(0.4, 1.05); ctx.lineTo(0.95, 1.05); ctx.lineTo(0.55, 2.38); ctx.lineTo(0.15, 2.38); ctx.fill();
        ctx.fillStyle = "#fff6dc";
        ctx.fillRect(0.14, 0.34, 0.38, 0.16); ctx.fillRect(W - 0.52, 0.34, 0.38, 0.16);   // headlamps
      }
    } else {
      ctx.fillStyle = tone(GLASS, 0.85 + f * 0.2);
      ctx.fillRect(0.35, 1.65, W - 0.7, 0.72);                        // rear window
      ctx.fillStyle = "#c8312c";
      ctx.fillRect(0.1, 0.36, 0.26, 0.5); ctx.fillRect(W - 0.36, 0.36, 0.26, 0.5);   // tail lamps
    }
  }
  function roofFace(ctx, col, detail) {
    const hl = BUS.L / 2, hw = BUS.W / 2;
    ctx.fillStyle = tone(ROOF, 1.04);
    roundRectPath(ctx, -hl, -hw, BUS.L, BUS.W, 0.4); ctx.fill();
    ctx.fillStyle = tone(col, 1.08);
    ctx.fillRect(-hl + 0.45, -0.2, BUS.L - 0.9, 0.4);                  // the roof stripe
    if (detail) {
      ctx.fillStyle = tone(ROOF, 0.86);
      roundRectPath(ctx, -hl + 1.2, -0.85, 2.6, 1.7, 0.2); ctx.fill();   // air conditioning pod
      ctx.fillStyle = tone(ROOF, 0.95);
      ctx.fillRect(-hl + 1.45, -0.6, 2.1, 1.2);
      ctx.fillStyle = tone(ROOF, 0.9);
      ctx.fillRect(hl - 2.2, -0.45, 0.9, 0.9);                            // roof hatch
    }
  }

  // ------------------------------------------------------------------------------------------------ layer: lights (night)
  app.addLayer({
    id: "bus-lights", z: 84,
    fps: 0,   // drawn with the buses, at their pace
    draw(ctx) {
      const night = nightLevel();
      if (night < 0.05) return;
      if (!app.layerEnabled("buses") || cam.s < MARKER_S || drawnFrame < 0) return;
      ctx.globalCompositeOperation = "lighter";
      const dpr = cam.dpr;
      for (const T of visBuses) {
        if (!T.drawn) continue;
        const a = night * T.alpha * T.appear * (T.occB ? 0.3 : 1);
        if (a < 0.02) continue;
        const fx = T.fx, fy = T.fy, rx = fy, ry = -fx, hl = BUS.L / 2, hw = BUS.W / 2;
        // headlight pools on the road ahead: the sprite laid in the bus's ground frame (u ahead, v across)
        if (SPR.beam) {
          groundXform(ctx);
          ctx.transform(fx, fy, rx, ry, T.x + fx * hl, T.y + fy * hl);
          ctx.globalAlpha = a;
          ctx.drawImage(SPR.beam, 0, -BEAM.W, BEAM.L, 2 * BEAM.W);
          ctx.globalAlpha = 1;
        }
        // lit windows, the sign, the tail lamps
        const Fx = cam.a * fx + cam.b * fy, Fy = cam.d * fx + cam.e * fy, Rx = cam.a * rx + cam.b * ry, Ry = cam.d * rx + cam.e * ry, zf = cam.zf;
        const rd = rx * cam.D0 + ry * cam.D1, fd = fx * cam.D0 + fy * cam.D1;
        if (Math.abs(rd) > 0.015 && !T.occB) {
          const sg = rd < 0 ? 1 : -1;
          ctx.setTransform(dpr * Fx, dpr * Fy, 0, dpr * zf, dpr * (T.sx + Rx * hw * sg - Fx * hl), dpr * (T.sy + Ry * hw * sg - Fy * hl + zf * BUS.clear));
          ctx.fillStyle = "rgb(255, 196, 112)"; ctx.globalAlpha = 0.78 * a;
          ctx.fillRect(0.5, 1.2, BUS.L - 1.0, 1.12);
        }
        if (Math.abs(fd) > 0.015) {
          const front = fd < 0, sg = front ? 1 : -1;
          ctx.setTransform(dpr * Rx, dpr * Ry, 0, dpr * zf, dpr * (T.sx + Fx * hl * sg - Rx * hw), dpr * (T.sy + Fy * hl * sg - Ry * hw + zf * BUS.clear));
          if (front) { ctx.fillStyle = "rgb(255, 180, 70)"; ctx.globalAlpha = 0.8 * a; ctx.fillRect(0.28, 2.5, BUS.W - 0.56, 0.24); ctx.fillStyle = "rgb(255, 245, 215)"; ctx.globalAlpha = a; ctx.fillRect(0.14, 0.34, 0.38, 0.16); ctx.fillRect(BUS.W - 0.52, 0.34, 0.38, 0.16); }
          else { ctx.fillStyle = "rgb(255, 60, 40)"; ctx.globalAlpha = 0.8 * a; ctx.fillRect(0.1, 0.36, 0.26, 0.5); ctx.fillRect(BUS.W - 0.36, 0.36, 0.26, 0.5); }
        }
        ctx.globalAlpha = 1;
      }
      ctx.globalCompositeOperation = "source-over";
    },
  });

  // ------------------------------------------------------------------------------------------------ layer: tags (markers, pills, labels)
  const textW = new Map();   // font → text → width
  function measure(ctx, font, text) {
    let m = textW.get(font);
    if (!m) textW.set(font, (m = new Map()));
    let w = m.get(text);
    if (w == null) { if (m.size > 500) m.clear(); ctx.font = font; w = ctx.measureText(text).width; m.set(text, w); }
    return w;
  }
  const MARKER_FONT = ["700 8px Inter, system-ui, sans-serif", "700 6.6px Inter, system-ui, sans-serif"];
  app.addLayer({
    id: "bus-tags", z: 92,
    fps: 0,   // markers and pills move with the buses (their layer asks for the frames); labels are still
    draw(ctx, f) {
      setCam();
      const s = cam.s;
      // hovered or selected stop: its name
      if (app.layerEnabled("stops")) {
        const a = sel.kind === "stop" ? sel.id : null, b = hover.kind === "stop" ? hover.id : null;
        if (a) stopLabel(ctx, a);
        if (b && b !== a) stopLabel(ctx, b);
      }
      tagFrame = f.frame;
      if (app.layerEnabled("buses") && drawnFrame === f.frame) {
        if (s < MARKER_S) { const hr = selectedRoute(); for (const T of visBuses) drawMarker(ctx, T, hr); }
        else for (const T of visBuses) {
          const hov = hover.kind === "bus" && hover.id === T.id;
          if (s < 5 || hov || isHi(T)) { drawPill(ctx, T, hov); T.plF = f.frame; }
        }
      }
      if (hover.kind === "route" && app.layerEnabled("routes")) {
        const r = routeBy.get(hover.id);
        if (r) label(ctx, hover.px, hover.py - 14, `${r.code} · ${r.name}`, r);
      }
    },
  });

  function stopLabel(ctx, id) {
    const st = stops.get(id);
    if (!st) return;
    const px = cam.a * st.x + cam.b * st.y + cam.c, py = cam.d * st.x + cam.e * st.y + cam.f;
    if (px < -50 || px > cam.w + 50 || py < -20 || py > cam.h + 80) return;
    label(ctx, px, py - (cam.s >= POLE_S ? poleTop(cam.s) : 5) - 6, st.name, null);
  }
  function label(ctx, x, y, text, route) {
    const font = '600 12px Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
    const tw = measure(ctx, font, text), chip = route ? 9 : 0;
    const w = tw + 16 + chip, h = 22;
    let x0 = clamp(x - w / 2, 6, cam.w - w - 6);
    const y0 = clamp(y - h, 6, cam.h - h - 6);
    ctx.save();
    ctx.shadowColor = "rgba(60, 40, 20, .28)"; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
    ctx.fillStyle = "rgba(251, 248, 241, .96)";
    roundRectPath(ctx, x0, y0, w, h, 7); ctx.fill();
    ctx.restore();
    if (route) { ctx.fillStyle = route.color; ctx.beginPath(); ctx.arc(x0 + 11, y0 + h / 2, 4, 0, Math.PI * 2); ctx.fill(); x0 += chip; }
    ctx.font = font; ctx.fillStyle = "#2a2622"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(text, x0 + 8, y0 + h / 2 + 0.5);
  }

  function drawMarker(ctx, T, hiRoute) {
    const R = (app.mobile ? 8.5 : 7.5) + (isHi(T) ? 1.5 : 0);
    const route = T.route, col = route ? route.color : "#6d6e71";
    const x = T.sx, y = T.sy;
    ctx.globalAlpha = T.alpha * T.appear * (hiRoute && route && route.code !== hiRoute ? 0.45 : 1);
    if (isHi(T)) {
      ctx.fillStyle = rgba(col, 0.25);
      ctx.beginPath(); ctx.arc(x, y, R + 7, 0, Math.PI * 2); ctx.fill();
    }
    // heading nub
    const Fx = cam.a * T.fx + cam.b * T.fy, Fy = cam.d * T.fx + cam.e * T.fy, ang = Math.atan2(Fy, Fx);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(ang) * (R + 4.5), y + Math.sin(ang) * (R + 4.5));
    ctx.lineTo(x + Math.cos(ang + 0.62) * (R - 0.5), y + Math.sin(ang + 0.62) * (R - 0.5));
    ctx.lineTo(x + Math.cos(ang - 0.62) * (R - 0.5), y + Math.sin(ang - 0.62) * (R - 0.5));
    ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(x, y + 1.2, R, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(40, 28, 18, .25)"; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
    ctx.lineWidth = 1.6; ctx.strokeStyle = "#fbf8f1"; ctx.stroke();
    const code = route ? route.code : "?";
    const font = MARKER_FONT[code.length <= 2 ? 0 : 1];
    ctx.font = font; ctx.fillStyle = route ? route.ink : "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const tw = measure(ctx, font, code), maxW = R * 2 - 3;
    if (tw > maxW) { ctx.save(); ctx.translate(x, y + 0.4); ctx.scale(maxW / tw, 1); ctx.fillText(code, 0, 0); ctx.restore(); }
    else ctx.fillText(code, x, y + 0.4);
    ctx.globalAlpha = 1;
  }

  function drawPill(ctx, T, hov) {
    const route = T.route, col = route ? route.color : "#6d6e71";
    const text = hov && T.dest ? `${route ? route.code : "Bus"} · ${T.dest}` : route ? route.code : "Bus";
    const font = '650 10px Inter, system-ui, sans-serif';
    const tw = measure(ctx, font, text), w = tw + 10, h = 15;
    const x = T.sx, y = T.bb1 - 6;
    T.pl[0] = x - w / 2; T.pl[1] = y - h; T.pl[2] = x + w / 2; T.pl[3] = y + 3.5;   // for hits
    ctx.globalAlpha = T.alpha * T.appear * (T.occ && !hov && !isHi(T) ? 0.75 : 1);
    ctx.fillStyle = "rgba(40, 28, 18, .22)";
    roundRectPath(ctx, x - w / 2, y - h + 1.2, w, h, 7.5); ctx.fill();
    ctx.fillStyle = col;
    roundRectPath(ctx, x - w / 2, y - h, w, h, 7.5); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - 3.5, y - 0.5); ctx.lineTo(x + 3.5, y - 0.5); ctx.lineTo(x, y + 3.5); ctx.closePath(); ctx.fill();
    ctx.font = font; ctx.fillStyle = route ? route.ink : "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, x, y - h / 2 + 0.5);
    ctx.globalAlpha = 1;
  }

  function setHover(kind, id, e) {
    hover.kind = kind; hover.id = id;
    if (e && Number.isFinite(e.px)) { hover.px = e.px; hover.py = e.py; }
  }

  // ------------------------------------------------------------------------------------------------ cards
  let card = null;   // { kind, id, h, body, html, token, anchor }
  function showCard(kind, id, { title, subtitle, color, anchor }) {
    const ui = UI();
    if (!ui || !ui.card) return;
    // following lives on the followed bus's card: showing anything else in its place lets go of the bus
    if (follow.id && !(kind === "bus" && id === follow.id)) setFollow(null);
    const body = document.createElement("div");
    body.className = `bus-card bus-card-${kind}`;
    body.addEventListener("click", onCardClick);
    const token = {};
    const h = ui.card({
      id: "transit", title, subtitle, color, body, anchor,
      onClose: () => {
        if (!card || card.token !== token) return;
        card = null;
        sel.kind = sel.id = null;
        // …and so does closing it: otherwise the camera stays locked to a bus with nothing on screen to say so
        if (follow.id) setFollow(null);
      },
    });
    card = { kind, id, h, body, html: "", token, anchor };
    sel.kind = kind; sel.id = id;
    renderCard();
  }
  function refreshCard() { if (card) renderCard(); }
  setInterval(refreshCard, 5000);   // countdowns tick on between polls

  function renderCard() {
    const c = card;
    let html = "";
    if (c.kind === "stop") html = stopHtml(c.id);
    else if (c.kind === "bus") html = busHtml(c.id);
    else if (c.kind === "route") html = routeHtml(c.id);
    if (html === c.html) return;
    // The body is rebuilt as the times tick; a keyboard (or screen-reader) user keeps their place: the button that had
    // focus is found again by what it points at and focused anew.
    const a = document.activeElement, focusSel = a && a !== c.body && c.body.contains(a) ? focusKey(a) : null;
    c.html = html; c.body.innerHTML = html;
    if (focusSel) c.body.querySelector(focusSel)?.focus({ preventScroll: true });
  }
  function focusKey(el) {
    for (const k of ["act", "vehicle", "stop", "route"]) {
      const v = el.dataset && el.dataset[k];
      if (v != null) return `[data-${k}="${CSS.escape(v)}"]`;
    }
    return null;
  }
  const chip = (r, tag = "span", extra = "") => r ? `<${tag} class="bus-chip" style="--c:${r.color};--i:${r.ink}"${extra}>${esc(r.code)}</${tag}>` : "";

  function stopHtml(id) {
    const st = stops.get(id);
    if (!st) return `<p class="bus-none">This stop is no longer served.</p>`;
    const served = st.routes.map((c) => routeBy.get(c)).filter(Boolean);
    const deps = departuresAt(id);
    let rows = "";
    for (const d of deps) {
      const eta = etaText(d.at, d.due);
      const etaHtml = eta === "Due" ? `<b class="bus-due">Due</b>` : `<b>${esc(eta.replace(" min", ""))}<small>min</small></b>`;
      rows += `<li><button type="button" data-vehicle="${esc(d.T.id)}" class="bus-dep">${chip(d.route)}<span class="bus-dest">${esc(d.dest || (d.route && d.route.name) || "")}${d.delayed ? ` <em class="bus-late">Delayed</em>` : ""}</span><span class="bus-eta">${d.est ? "<i>~</i>" : ""}${etaHtml}</span></button></li>`;
    }
    const empty = !transit.ok && !mockMode ? "Live times are unavailable right now" : liveCount() ? "No buses due" : "No buses running right now";
    return `<div class="bus-served"><span>Served by</span>${served.map((r) => chip(r, "button", ` type="button" data-route="${esc(r.code)}" title="${esc(r.name)}"`)).join("")}</div>
      <div class="bus-board"><div class="bus-board-head"><span>Next buses</span><span class="${transit.ok ? "" : "off"}">${mockMode ? "mock" : transit.ok ? "live" : "offline"}</span></div>${rows ? `<ol>${rows}</ol>` : `<p class="bus-none">${empty}</p>`}</div>
      ${deps.some((d) => d.est) ? `<p class="bus-foot">~ estimated from the bus's position</p>` : ""}`;
  }

  function busHtml(id) {
    const T = tracks.get(id);
    if (!T || !T.mode || T.goneAt) return `<p class="bus-none">This bus has left service.</p>`;
    const r = T.route;
    // A speed of 1 mph is GPS jitter. The shuttle may send no speed at all: it is "on its loop" only while it is on
    // its pattern and its fixes show it moving; parked off its loop it is parked.
    const rolling = T.mode === 1 && T.vObs > 0.7 && Date.now() - T.fixAt < 30000;
    const moving = T.mph >= 1.5 ? `${Math.round(T.mph)} mph` : T.service === "double" && rolling ? "On its loop" : T.mode === 2 ? "Parked" : "Stopped";
    // The feed's "updated" can be cut to the minute (and lag it): a fix whose position changed moments ago, or one
    // stamped within the last minute and a half, is "just now"
    const age = Math.max(0, Math.min(serverNow() - T.updMs, T.fixAt ? Date.now() - T.fixAt : Infinity));
    const fresh = T.stale ? "No recent signal" : age < 90000 ? "Updated just now" : `Updated ${Math.floor(age / 60000)} min ago`;
    const next = nextStopsOf(T);
    let rows = "";
    for (const p of next) {
      const eta = etaText(p.at, p.due);
      rows += `<li><button type="button" data-stop="${esc(p.stopId)}"><i style="--c:${r ? r.color : "#6d6e71"};--cd:${r ? r.darkColor : "#9b9c9f"}"></i><span>${esc(p.stopName || (stops.get(p.stopId) || {}).name || "Stop")}</span><b>${p.est ? "~" : ""}${esc(eta)}</b></button></li>`;
    }
    const following = follow.id === T.id;
    // where it is going: its destination sign, else (the shuttle sends none, and its name is the card's title) the
    // next stop, else just that it is a loop
    const to = T.dest ? `to <b>${esc(T.dest)}</b>` : next.length ? `next stop <b>${esc(next[0].stopName || (stops.get(next[0].stopId) || {}).name || "")}</b>`
      : r && r.patterns.some((p) => p.closed) ? "Loop service" : "In service";
    return `<div class="bus-hero">${chip(r)}<span class="bus-to">${to}</span></div>
      <div class="bus-facts"><span>${esc(moving)}</span><span>${esc(fresh)}</span>${T.delayed ? `<span class="bus-late">Delayed</span>` : ""}</div>
      ${rows ? `<div class="bus-sec">Next stops</div><ol class="bus-next">${rows}</ol>` : `<p class="bus-none">No upcoming stops reported</p>`}
      <div class="bus-actions"><button type="button" class="bus-btn${following ? " on" : ""}" data-act="follow" aria-pressed="${following}">${following ? "Following" : "Follow"}</button>${r ? `<button type="button" class="bus-btn" data-route="${esc(r.code)}">Route</button>` : ""}</div>`;
  }

  function routeHtml(code) {
    const r = routeBy.get(code);
    if (!r) return `<p class="bus-none">This route is not running.</p>`;
    const buses = [...tracks.values()].filter((T) => T.mode && !T.stale && T.route === r);
    // which stop each running bus comes to next
    const coming = new Map();
    for (const T of buses) {
      const n = nextStopsOf(T)[0];
      if (n && !coming.has(n.stopId)) coming.set(n.stopId, n);
    }
    let rows = "";
    for (const id of r.stops) {
      const st = stops.get(id);
      if (!st) continue;
      const c = coming.get(id);
      rows += `<li><button type="button" data-stop="${esc(id)}"><i></i><span>${esc(st.name)}</span>${c ? `<em class="bus-here">bus · ${esc(etaText(c.at, c.due).toLowerCase())}</em>` : ""}</button></li>`;
    }
    const n = buses.length;
    return `<div class="bus-route-top">${chip(r)}<span>${n ? `${n} bus${n === 1 ? "" : "es"} running` : "No buses running right now"}${mockMode ? " (mock)" : ""}</span></div>
      ${rows ? `<ol class="bus-strip" style="--c:${r.color};--cd:${r.darkColor}">${rows}</ol>` : `<p class="bus-none">No stops listed</p>`}`;
  }

  function onCardClick(e) {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.act === "follow") { if (card && card.kind === "bus") setFollow(follow.id === card.id ? null : card.id); return; }
    if (t.dataset.vehicle) return openVehicle(t.dataset.vehicle, { fly: true });
    if (t.dataset.stop) return openStop(t.dataset.stop, { fly: true });
    if (t.dataset.route) return flyToRoute(t.dataset.route);
  }

  // ------------------------------------------------------------------------------------------------ opening things
  function onScreen(x, y, margin = 40) {
    const [px, py] = view.groundToScreen(x, y, 0);
    return px > margin && px < view.w - margin && py > margin && py < view.h - margin;
  }
  function openStop(id, { fly = true } = {}) {
    const st = stops.get(String(id));
    if (!st) { UI()?.toast?.("That stop isn't on any running route"); return false; }
    const served = st.routes.map((c) => routeBy.get(c)).filter(Boolean);
    showCard("stop", st.id, { title: st.name, subtitle: `Bus stop · ${served.map((r) => r.code).join(", ")}`, color: served.length === 1 ? served[0].color : "#b3202a", anchor: { x: st.x, y: st.y, z: 5 } });
    if (fly && (!onScreen(st.x, st.y, 80) || view.s < 1.4)) view.flyTo({ x: st.x, y: st.y }, { m: Math.min(view.metresAcross(), app.mobile ? 300 : 460), offsetY: app.mobile ? -view.h * 0.2 : 0 });
    return true;
  }
  function openVehicle(id, { fly = true } = {}) {
    const T = tracks.get(String(id));
    if (!T || !T.mode || T.goneAt) { UI()?.toast?.("That bus isn't running right now"); return false; }
    const r = T.route;
    showCard("bus", T.id, { title: r ? r.name : "Bus", subtitle: `Bus ${T.id}${mockMode ? " · mock" : ""}`, color: r ? r.color : null, anchor: { x: T.x, y: T.y, z: 7 } });
    if (fly && (!onScreen(T.x, T.y, 80) || view.s < 1.2)) view.flyTo({ x: T.x, y: T.y }, { m: Math.min(view.metresAcross(), app.mobile ? 320 : 520), offsetY: app.mobile ? -view.h * 0.2 : 0 });
    return true;
  }
  function openRoute(code, { fly = true } = {}) {
    const r = routeBy.get(String(code || "").toUpperCase());
    if (!r) { UI()?.toast?.("That route isn't running"); return false; }
    showCard("route", r.code, { title: r.name, subtitle: `Route ${r.code} · ${r.stops.length} stops`, color: r.color, anchor: null });
    if (fly) fitRoute(r);
    return true;
  }
  function flyToRoute(code) { return openRoute(code, { fly: true }); }

  // fit the camera to a route, leaving room for the card (left on desktop, a bottom sheet on phones)
  function fitRoute(r) {
    const o = geo.ROTS[view.rot];
    let X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity;
    for (const p of r.patterns) for (let i = 0; i < p.n; i++) {
      const x = p.xy[2 * i], y = p.xy[2 * i + 1];
      if (offSlab(x, y) > 0) continue;   // the part of the route on the map
      const X = x * o.R[0] + y * o.R[1], Y = -(x * o.D[0] + y * o.D[1]) * SIN_T;
      if (X < X0) X0 = X; if (X > X1) X1 = X; if (Y < Y0) Y0 = Y; if (Y > Y1) Y1 = Y;
    }
    if (!(X1 > X0)) return;
    // keep clear of the map buttons down the right and the bar along the top, measured (they differ on phones)
    const canvasBox = app.canvas.getBoundingClientRect();
    const btns = document.getElementById("map-btns")?.getBoundingClientRect(), bar = document.getElementById("bar")?.getBoundingClientRect();
    const padR = btns && btns.width > 0 ? Math.max(30, canvasBox.right - btns.left + 12) : 30;
    const padT = Math.max(app.mobile ? 70 : 80, bar && bar.height > 0 ? bar.bottom - canvasBox.top + 16 : 0);
    const padL = app.mobile ? 20 : Math.min(380, view.w * 0.35), padB = app.mobile ? view.h * 0.46 : 50;
    const availW = Math.max(120, view.w - padL - padR), availH = Math.max(120, view.h - padT - padB);
    const s = clamp(Math.min(availW / (X1 - X0), availH / (Y1 - Y0)), view.minS, 6);
    // the route's centre goes to the centre of the free area
    const cX = (X0 + X1) / 2 - ((padL - padR) / 2) / s, cY = (Y0 + Y1) / 2 - ((padT - padB) / 2) / s;
    const [gx, gy] = geo.unproj(cX, cY, view.rot, 0);
    view.flyTo({ x: gx, y: gy }, { s });
  }

  // ------------------------------------------------------------------------------------------------ public api, toggles, search
  const transit = {
    routes, stops, vehicles, updated: null, ok: mockMode,
    mock: mockMode,
    flyToRoute, openStop, openVehicle, openRoute,
    follow: setFollow,
    departures: (id) => departuresAt(String(id)).map((d) => ({ routeCode: d.route ? d.route.code : "", vehicleId: d.T.id, destination: d.dest, at: new Date(d.at), delayed: d.delayed, estimated: d.est })),
    debug: (id) => { const T = tracks.get(String(id)); return T && { capD: T.capD, w: T.w, offDV: T.offDV, mode: T.mode, occ: T.occ, drawn: T.drawn, shownD: T.shownD, tgtD: T.tgtD, repD: T.repD, offD: T.offD, v: T.v, vT: T.vT, alpha: T.alpha, appear: T.appear, age: T.age, gone: !!T.goneAt, pat: T.pat && T.pat.id }; },
    perf: () => ({ frameMs: perf.n ? perf.ms / perf.n : 0, tiles: OT.n, tileMs: OT.n ? OT.ms / OT.n : 0, cached: OT.cache.size }),
    resetPerf: () => { perf.ms = perf.n = 0; OT.ms = OT.n = 0; },
  };
  app.transit = transit;

  const ui = UI();
  if (ui) {
    ui.registerToggle?.({ id: "buses", label: "Buses", group: "Live", count: "" });
    ui.registerToggle?.({ id: "routes", label: "Route lines", group: "Live" });
    ui.registerToggle?.({ id: "stops", label: "Bus stops", group: "Live" });
    ui.addSearchProvider?.(searchTransit);
  }
  // a toggle that turns the buses off also lets go of the one being followed
  app.on("layers", ({ id, on }) => { if (id === "buses" && !on && follow.id) setFollow(null); });

  function searchTransit(q) {
    q = String(q || "").trim().toLowerCase();
    if (!q) return [];
    const out = [];
    const wantsAll = /^(bus|buses|route|routes|cabs|shuttle)s?$/.test(q);
    for (const r of routes) {
      const code = r.code.toLowerCase(), name = r.name.toLowerCase();
      let score = 0;
      if (wantsAll) score = 0.9;   // "bus", "routes": the routes themselves, above names that merely start with "bus"
      else if (code === q) score = 0.97;
      else if (name.startsWith(q)) score = 0.88;
      else if (name.split(/\s+/).some((w) => w.startsWith(q))) score = 0.7;
      else if (q.length >= 3 && name.includes(q)) score = 0.55;
      if (score) out.push({ label: `${r.name}`, sub: `Bus route ${r.code} · ${r.stops.length} stops`, kind: "route", color: r.color, score, go: () => flyToRoute(r.code) });
    }
    if (q.length >= 2 && !wantsAll) {
      for (const st of stopList) {
        const name = st.name.toLowerCase();
        let score = 0;
        if (name === q) score = 0.9;
        else if (name.startsWith(q)) score = 0.78;
        else if (name.split(/[\s(/-]+/).some((w) => w.startsWith(q))) score = 0.62;
        else if (q.length >= 3 && name.includes(q)) score = 0.45;
        if (score) out.push({ label: st.name, sub: `Bus stop · ${st.routes.join(", ")}`, kind: "stop", score, go: () => openStop(st.id, { fly: true }) });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 8);
  }

  // ------------------------------------------------------------------------------------------------ go
  updateStatus(0);
  loadSnapshot();
  tick();
  setInterval(tick, 250);
}

function linkCss() {
  if (document.querySelector("link[data-buses-css]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = new URL("../../css/buses.css", import.meta.url).href;
  l.dataset.busesCss = "";
  document.head.appendChild(l);
}
