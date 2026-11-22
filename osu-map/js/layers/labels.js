// Map labels and the building highlight.
//
//   "labels" (z 90): building names over their roofs, big italic names for the campus areas and the neighbourhoods round
//   them, the river's name along its course, street names along the streets up close and shop and café names closer still.
//   Every frame the candidates near the view are placed greedily by priority in screen space (boxes bucketed in a grid);
//   more fit as you zoom in, and each one fades in and out instead of popping. Text is drawn once into a small sprite with
//   its halo and stamped from then on, so a frame costs a few dozen drawImage calls rather than hundreds of strokeTexts.
//   "building-highlight" (z 60): a soft scarlet outline round the building under the pointer and the one whose card is open.
//
// Also: clicking a building label picks the building, a search provider for named buildings, and the "Labels" toggle.
// app.labels exposes a little state for tests (?: app.labels.highlight(i), app.labels.stats).

const SERIF = '"Fraunces", Georgia, "Times New Roman", serif';
const SANS = '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const FADE_S = 0.25;              // label fade in / out
const HL_FADE_S = 0.14;           // highlight fade
const GAP = 3;                    // px between a roof and the bottom of its label
const STREET_MIN_S = 2.5;         // street names from here (main roads a little earlier)
const POI_MIN_S = 6;              // shop and café names from here
const ANCH_STREET = 45;           // m between candidate spots along a street
const ANCH_RIVER = 80;            // m between candidate spots along a river
const CELL = 40, GM = 120;        // collision grid: cell size and margin round the screen, px
const SCARLET = "#b3202a";

// a building's importance → the zoom it may first show at: minS = BUILDING_K / importance
const BUILDING_K = 300;

// kinds
const K_BUILDING = 0, K_AREA = 1, K_STREET = 2, K_CURVE = 3, K_POI = 4;

// The names people know, and how much more they matter than their size suggests.
const LANDMARKS = {
  "Ohio Stadium": 14,
  "William Oxley Thompson Memorial Library": 9,
  "Ohio Union": 7,
  "Lincoln Tower": 5, "Morrill Tower": 5,
  "Schottenstein Center & Value City Arena": 5,
  "Saint John Arena": 4.5,
  "University Hospital": 3.5,
  "James Cancer Hospital and Solove Research Institute": 3.5,
  "Recreation & Physical Activity Center": 4.5,
  "Orton Hall": 6, "University Hall": 5, "Hale Hall": 4, "Mershon Auditorium": 4.5, "Wexner Center for the Arts": 4.5,
  "Hayes Hall": 3.5, "Pomerene Hall": 3, "Knowlton Hall": 2.5, "French Field House": 2.5, "Woody Hayes Athletic Center": 3,
  "Ross Heart Hospital": 2, "Sullivant Hall": 3, "Page Hall": 2.5, "Bricker Hall": 2.5, "Dreese Laboratories": 2,
  "Smith Laboratory": 2, "Biomedical Research Tower": 2, "The Blackwell": 2, "Scott Laboratory": 2, "Hamilton Hall": 2,
  "Jesse Owens Recreation Center North": 1.6, "Jesse Owens Recreation Center South": 1.6, "Fawcett Center for Tomorrow": 2,
  "Covelli Center & Jennings Wrestling Facility": 2, "Enarson Classroom Building": 1.6, "Kennedy Commons": 1.6,
  "Physics Research Building": 1.6, "Celeste Laboratory of Chemistry": 1.6, "Hagerty Hall": 2, "Lazenby Hall": 1.5,
  "Ohio Union South Parking Garage": 0.8, "Ohio Union North Parking Garage": 0.8,
};
// shorter names for the map (the card and search keep the full one)
const SHORT = {
  "William Oxley Thompson Memorial Library": "Thompson Library",
  "Schottenstein Center & Value City Arena": "Schottenstein Center",
  "James Cancer Hospital and Solove Research Institute": "James Cancer Hospital",
  "Recreation & Physical Activity Center": "RPAC",
  "Saint John Arena": "St. John Arena",
  "Wexner Center for the Arts": "Wexner Center",
  "Covelli Center & Jennings Wrestling Facility": "Covelli Center",
  "Fawcett Center for Tomorrow": "Fawcett Center",
  "Jesse Owens Recreation Center North": "Jesse Owens North",
  "Jesse Owens Recreation Center South": "Jesse Owens South",
  "Wexner Medical Center Outpatient Care West Campus": "Outpatient Care West Campus",
};
// the stadium is unnamed in OpenStreetMap's building outline
const UNNAMED = [{ n: "Ohio Stadium", lat: 40.0017, lon: -83.0197 }];

// neighbourhoods round campus (each is dropped if it falls outside the map) and the parts of campus people name
const HOODS = [
  { n: "University District", lat: 39.99815, lon: -83.0003, pri: 6400 },
  { n: "Weinland Park", lat: 39.9907, lon: -83.0003, pri: 6300 },
  { n: "Victorian Village", lat: 39.98636, lon: -83.0099, pri: 6200 },
  { n: "Harrison West", lat: 39.98645, lon: -83.0196, pri: 6200 },
  { n: "Old North Columbus", lat: 40.0114, lon: -83.0040, pri: 6300 },
  { n: "Iuka Ravine", lat: 40.0052, lon: -83.0012, pri: 3000, minS: 0.32, maxS: 2.2, style: "hoodSmall" },
];
const CAMPUS = [
  { n: "West Campus", lat: 40.0026, lon: -83.0385 },
  { n: "North Campus", lat: 40.0057, lon: -83.0126 },
  { n: "South Campus", lat: 39.9956, lon: -83.0109 },
  { n: "Medical Center", lat: 39.99405, lon: -83.0192 },
];

const STYLES = {
  landmark: { font: `italic 600 13.5px ${SERIF}`, lh: 15, ink: "#2b2520", night: "#fbf3e2", halo: 2.6, wrap: 170 },
  building: { font: `italic 500 11.5px ${SERIF}`, lh: 12.5, ink: "#3b332b", night: "#efe6d4", halo: 2.3, wrap: 132 },
  hood: { font: `italic 400 12px ${SERIF}`, lh: 16, ink: "#6f604f", night: "#ddd1bb", halo: 2.4, upper: true, ls: 3, wrap: 170 },
  hoodSmall: { font: `italic 400 10.5px ${SERIF}`, lh: 13, ink: "#76675a", night: "#ddd1bb", halo: 2.2, upper: true, ls: 2.4 },
  campus: { font: `italic 500 17px ${SERIF}`, lh: 19, ink: "#4a3c2f", night: "#f3e8d2", halo: 3, ls: 0.3 },
  lawn: { font: `italic 500 15px ${SERIF}`, lh: 17, ink: "#3d6032", night: "#cfe5b8", halo: 2.6, ls: 0.3 },
  park: { font: `italic 500 11.5px ${SERIF}`, lh: 13, ink: "#43653a", night: "#c2dcab", halo: 2.3, wrap: 120 },
  water: { font: `italic 500 13.5px ${SERIF}`, lh: 15, ink: "#2b6987", night: "#a9d8ec", halo: 2.4, ls: 0.6 },
  river: { font: `italic 500 13.5px ${SERIF}`, lh: 15, ink: "#2b6987", night: "#a9d8ec", halo: 2.3, ls: 2.6 },
  creek: { font: `italic 500 10.5px ${SERIF}`, lh: 12, ink: "#2f6d8a", night: "#a9d8ec", halo: 2, ls: 1.2 },
  street: { font: `600 8.5px ${SANS}`, lh: 10, ink: "#fdfaf3", night: "#ece6d8", halo: 1.8, haloDay: "rgba(74, 77, 84, .66)", haloNight: "rgba(16, 18, 26, .72)", upper: true, ls: 1.3 },
  poi: { font: `500 10px ${SANS}`, lh: 12, ink: "#4e463e", night: "#ede4d3", halo: 2.1, dot: 9 },
};
const HALO_DAY = "rgba(247, 242, 231, .95)", HALO_NIGHT = "rgba(20, 23, 34, .62)";

// which OSM shop/amenity kinds get a name up close, and the colour of their dot
const POI_KIND = {};
for (const k of ["restaurant", "cafe", "fast_food", "ice_cream", "bakery", "pastry", "coffee", "tea", "confectionery", "beverages"]) POI_KIND[k] = ["#c8693c", 100];
for (const k of ["bar", "pub"]) POI_KIND[k] = ["#a0506e", 95];
for (const k of ["clothes", "books", "convenience", "supermarket", "department_store", "gift", "music", "bicycle", "shoes", "electronics", "jewelry", "second_hand", "florist", "art", "toys", "computer", "pharmacy", "chemist", "alcohol", "copyshop", "mobile_phone", "houseware", "pottery", "watches"]) POI_KIND[k] = ["#6f63a6", 80];
for (const k of ["theatre", "cinema", "museum", "gallery", "library", "planetarium", "events_venue"]) POI_KIND[k] = ["#2e7d86", 120];

const STREET_RANK = { motorway: 5, trunk: 5, primary: 4, secondary: 3, tertiary: 2, unclassified: 1.4, residential: 1, living_street: 0.8, pedestrian: 0.8, service: 0.5 };
const CAMPUSY = new Set(["university", "college", "school", "dormitory", "library", "hospital", "clinic", "stadium", "sports_centre", "sports_hall", "civic", "public", "museum", "theatre", "church", "chapel"]);
const KIND_NAME = { university: "University building", college: "College building", dormitory: "Residence hall", hospital: "Hospital", clinic: "Clinic", stadium: "Stadium", sports_centre: "Sports centre", parking: "Parking garage", apartments: "Apartments", library: "Library", church: "Church", commercial: "Commercial building", retail: "Shops", office: "Offices", hotel: "Hotel", civic: "Civic building", school: "School" };

// ------------------------------------------------------------------------------------------------ geometry helpers
function ringArea(f) {
  let a = 0;
  for (let i = 0, n = f.length, j = n - 2; i < n; j = i, i += 2) a += f[j] * f[i + 1] - f[i] * f[j + 1];
  return a / 2;
}
function pointInRing(f, x, y) {
  let inside = false;
  for (let i = 0, n = f.length, j = n - 2; i < n; j = i, i += 2) {
    const xi = f[i], yi = f[i + 1], xj = f[j], yj = f[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function ringBox(f) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < f.length; i += 2) { const x = f[i], y = f[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}
/** A point inside the ring for its label: the centroid, or for an L or a U the middle of the widest span through it. */
function interiorPoint(f) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = f.length, j = n - 2; i < n; j = i, i += 2) {
    const cr = f[j] * f[i + 1] - f[i] * f[j + 1];
    a += cr; cx += (f[j] + f[i]) * cr; cy += (f[j + 1] + f[i + 1]) * cr;
  }
  if (Math.abs(a) < 1e-6) {
    cx = 0; cy = 0;
    for (let i = 0; i < f.length; i += 2) { cx += f[i]; cy += f[i + 1]; }
    return [cx / (f.length / 2), cy / (f.length / 2)];
  }
  cx /= 3 * a; cy /= 3 * a;
  if (pointInRing(f, cx, cy)) return [cx, cy];
  const xs = [];
  for (let i = 0, n = f.length, j = n - 2; i < n; j = i, i += 2) {
    const yi = f[i + 1], yj = f[j + 1];
    if (yi > cy !== yj > cy) xs.push(f[i] + ((cy - yi) * (f[j] - f[i])) / (yj - yi));
  }
  xs.sort((p, q) => p - q);
  let best = -1, bx = cx;
  for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1] - xs[k] > best) { best = xs[k + 1] - xs[k]; bx = (xs[k] + xs[k + 1]) / 2; }
  return [bx, cy];
}
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Join line features that share a name and an end point into longer chains, so a label can run across a way boundary. */
function buildChains(items) {
  const byName = new Map();
  for (const it of items) { let g = byName.get(it.n); if (!g) byName.set(it.n, (g = [])); g.push(it); }
  const key = (x, y) => Math.round(x * 2) + "," + Math.round(y * 2);
  const chains = [];
  for (const [name, ways] of byName) {
    const ends = new Map();
    const addEnd = (k, w) => { let a = ends.get(k); if (!a) ends.set(k, (a = [])); a.push(w); };
    for (const w of ways) { const f = w.pts, n = f.length; addEnd(key(f[0], f[1]), w); addEnd(key(f[n - 2], f[n - 1]), w); }
    const used = new Set();
    // the next way at an end: the one that carries on straightest
    const next = (x, y, dx, dy) => {
      let best = null, bestDot = -0.3;
      for (const w of ends.get(key(x, y)) || []) {
        if (used.has(w)) continue;
        const f = w.pts, n = f.length, atStart = key(f[0], f[1]) === key(x, y);
        const ex = atStart ? f[2] - f[0] : f[n - 4] - f[n - 2], ey = atStart ? f[3] - f[1] : f[n - 3] - f[n - 1];
        const L = Math.hypot(ex, ey) * Math.hypot(dx, dy) || 1;
        const dot = (ex * dx + ey * dy) / L;
        if (dot > bestDot) { bestDot = dot; best = { w, atStart }; }
      }
      return best;
    };
    for (const w0 of ways) {
      if (used.has(w0)) continue;
      used.add(w0);
      let pts = Array.from(w0.pts), rank = w0.rank;
      for (let guard = 0; guard < 400; guard++) {
        const n = pts.length;
        const nx = next(pts[n - 2], pts[n - 1], pts[n - 2] - pts[n - 4], pts[n - 1] - pts[n - 3]);
        if (!nx) break;
        used.add(nx.w);
        const f = Array.from(nx.w.pts);
        if (!nx.atStart) for (let i = 0, j = f.length - 2; i < j; i += 2, j -= 2) { [f[i], f[j]] = [f[j], f[i]]; [f[i + 1], f[j + 1]] = [f[j + 1], f[i + 1]]; }
        pts = pts.concat(f.slice(2));
        rank = Math.max(rank, nx.w.rank);
      }
      for (let guard = 0; guard < 400; guard++) {
        const nx = next(pts[0], pts[1], pts[0] - pts[2], pts[1] - pts[3]);
        if (!nx) break;
        used.add(nx.w);
        const f = Array.from(nx.w.pts);
        if (nx.atStart) for (let i = 0, j = f.length - 2; i < j; i += 2, j -= 2) { [f[i], f[j]] = [f[j], f[i]]; [f[i + 1], f[j + 1]] = [f[j + 1], f[i + 1]]; }
        pts = f.slice(0, -2).concat(pts);
        rank = Math.max(rank, nx.w.rank);
      }
      const g = new Float64Array(pts);
      const cum = new Float64Array(g.length / 2);
      for (let i = 1; i < cum.length; i++) cum[i] = cum[i - 1] + Math.hypot(g[2 * i] - g[2 * i - 2], g[2 * i + 1] - g[2 * i - 1]);
      chains.push({ name, rank, g, cum, len: cum[cum.length - 1], rot: [null, null, null, null] });
    }
  }
  return chains;
}

// ================================================================================================================
export function init(app) {
  const { data, geo, view, canvas } = app;
  const B = data.buildings || [];
  const W0 = data.world;
  const COS_T = geo.COS_T;
  const motionMQ = matchMedia("(prefers-reduced-motion: reduce)");
  const inWorld = (x, y, m = 0) => x >= W0.x0 + m && x <= W0.x1 - m && y >= W0.y0 + m && y <= W0.y1 - m;

  // ---------------------------------------------------------------- buildings drawn by their parts
  // An outline whose parts are drawn instead ("hidden") still carries the name; its parts are the building people see.
  const partOf = new Int32Array(B.length).fill(-1);
  const members = new Map();         // hidden outline → the drawn parts inside it
  const absArea = new Float32Array(B.length);
  {
    const cell = 64, grid = new Map(), ccx = new Float32Array(B.length), ccy = new Float32Array(B.length);
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      if (!b || !b.p || !b.p[0] || b.p[0].length < 6) continue;
      const f = b.p[0];
      absArea[i] = Math.abs(ringArea(f));
      if (b.hidden) continue;
      let sx = 0, sy = 0;
      for (let k = 0; k < f.length; k += 2) { sx += f[k]; sy += f[k + 1]; }
      ccx[i] = sx / (f.length / 2); ccy[i] = sy / (f.length / 2);
      const k = Math.floor(ccx[i] / cell) * 65536 + Math.floor(ccy[i] / cell);
      let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i);
    }
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      if (!b || !b.hidden || !b.p || !b.p[0] || b.p[0].length < 6) continue;
      const f = b.p[0], bb = ringBox(f), list = [];
      for (let gx = Math.floor(bb[0] / cell); gx <= Math.floor(bb[2] / cell); gx++) {
        for (let gy = Math.floor(bb[1] / cell); gy <= Math.floor(bb[3] / cell); gy++) {
          for (const j of grid.get(gx * 65536 + gy) || []) {
            if (ccx[j] < bb[0] || ccx[j] > bb[2] || ccy[j] < bb[1] || ccy[j] > bb[3] || !pointInRing(f, ccx[j], ccy[j])) continue;
            list.push(j);
            if (partOf[j] < 0 || absArea[i] < absArea[partOf[j]]) partOf[j] = i;
          }
        }
      }
      members.set(i, list);
    }
    // the outline a part belongs to is its smallest: keep each member list consistent with that
    for (const [i, list] of members) members.set(i, list.filter((j) => partOf[j] === i));
  }
  /** the building a click or hover on building i stands for (an outline, for a part drawn inside one) */
  const rootOf = (i) => (i < 0 || !B[i] ? -1 : B[i].hidden ? i : partOf[i] >= 0 ? partOf[i] : i);

  // ---------------------------------------------------------------- candidates
  const cands = [];
  const statics = [], streets = [], curves = [], pois = [];
  function cand(kind, text, x, y, z, style, pri, minS, maxS) {
    const st = STYLES[style];
    const c = {
      id: cands.length, kind, text: st.upper ? text.toUpperCase() : text, name: text, x, y, z, st, pri, minS, maxS,
      bi: -1, chain: null, seg: 0, t: 0, ai: 0, col: null, glyphs: null,
      a: 0, on: false, stamp: 0, k: 0, X: 0, Y: 0, ang: 0,
      lines: null, w: 0, h: 0, mGen: -1, gw: null,
      ox: 0, oy: 0, bx0: 0, by0: 0, bx1: 0, by1: 0, gX: null, gY: null, gA: null, gn: 0,
      spr: null, sprN: null, gD: -1, gN: -1, used: 0,
    };
    cands.push(c);
    return c;
  }

  // buildings: one label per name and place (a hospital's two wings share one), the biggest footprint carrying it
  const buildingCand = new Map();     // building index → its label
  const searchIndex = [];
  {
    const groups = new Map();
    const consider = (i, name) => {
      const b = B[i];
      const f = b.p[0];
      const [ix, iy] = interiorPoint(f);
      let h = b.h || 0;
      if (b.hidden) for (const j of members.get(i) || []) h = Math.max(h, B[j].h || 0);
      const key = norm(name);
      let list = groups.get(key);
      if (!list) groups.set(key, (list = []));
      const near = list.find((e) => Math.hypot(e.x - ix, e.y - iy) < 250);
      const e = { i, name, x: ix, y: iy, h, A: absArea[i] };
      if (near) { if (e.A > near.A) Object.assign(near, e); return; }
      list.push(e);
    };
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      if (!b || !b.n || !b.p || !b.p[0] || b.p[0].length < 6) continue;
      const name = String(b.n).trim();
      if (name.length < 3 || /^[\d\s\-–#.]+$/.test(name)) continue;            // flat numbers, not names
      if (!b.hidden && partOf[i] >= 0 && B[partOf[i]].n) continue;               // a named part of a named building
      consider(i, name);
    }
    // landmarks the data leaves unnamed
    for (const u of UNNAMED) {
      const [x, y] = geo.toXY(u.lat, u.lon);
      let best = -1;
      for (let i = 0; i < B.length; i++) {
        const b = B[i];
        if (!b || b.n || !b.p || !b.p[0] || b.p[0].length < 6 || (best >= 0 && absArea[i] <= absArea[best])) continue;
        const bb = ringBox(b.p[0]);
        if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3] || !pointInRing(b.p[0], x, y)) continue;
        best = i;
      }
      if (best >= 0 && !groups.has(norm(u.n))) consider(best, u.n);
    }
    for (const list of groups.values()) {
      for (const e of list) {
        const b = B[e.i];
        if (!inWorld(e.x, e.y, 5)) continue;
        const boost = LANDMARKS[e.name] || 1;
        const kindK = CAMPUSY.has(b.k) ? 1.3 : b.k === "parking" ? 0.7 : b.k === "apartments" ? 0.85 : b.k === "house" || b.k === "garage" ? 0.6 : 1;
        const imp = Math.sqrt(e.A * Math.max(4, e.h)) * kindK * boost * (app.mobile ? 0.8 : 1);
        const minS = clamp(BUILDING_K / imp, boost >= 4 ? 0.1 : 0.32, 14);
        const label = SHORT[e.name] || e.name;
        const c = cand(K_BUILDING, label, e.x, e.y, e.h, boost >= 4 ? "landmark" : "building", imp, minS, Infinity);
        c.bi = e.i;
        statics.push(c);
        buildingCand.set(e.i, c);
        const kind = KIND_NAME[b.k] || (b.k === "yes" ? "Building" : String(b.k || "building").replace(/_/g, " ").replace(/^./, (m) => m.toUpperCase()));
        const n = norm(e.name), sn = SHORT[e.name] ? norm(SHORT[e.name]) : null;
        searchIndex.push({
          name: e.name, n, words: n.split(" "), sn, snWords: sn ? sn.split(" ") : null, bi: e.i, x: e.x, y: e.y, h: e.h, A: e.A, boost,
          campusy: CAMPUSY.has(b.k), sub: (boost >= 4 ? "Landmark · " : "") + kind + (b.a ? ` · ${b.a}` : ""),
        });
      }
    }
  }

  // named areas: the Oval, Mirror Lake, parks and fields
  {
    const best = new Map();
    for (const a of data.areas || []) {
      if (!a || !a.n || !a.p || !a.p[0] || a.p[0].length < 6) continue;
      const k = a.k;
      if (!["park", "garden", "pitch", "grass", "water"].includes(k)) continue;
      const A = Math.abs(ringArea(a.p[0]));
      const key = norm(a.n);
      const [x, y] = interiorPoint(a.p[0]);
      const prev = best.get(key);
      if (prev && Math.hypot(prev.x - x, prev.y - y) < 450) { if (A > prev.A) Object.assign(prev, { A, x, y, k }); continue; }
      best.set(prev ? key + "#" + Math.round(x) : key, { n: String(a.n).trim(), A, x, y, k });
    }
    for (const e of best.values()) {
      if (!inWorld(e.x, e.y, 10)) continue;
      const d = Math.sqrt(e.A);
      if (e.n === "The Oval") statics.push(cand(K_AREA, e.n, e.x, e.y, 0, "lawn", 8000, 0.2, 9));
      else if (e.n === "Mirror Lake") statics.push(cand(K_AREA, e.n, e.x, e.y, 0, "water", 4200, 0.5, Infinity));
      else if (e.k === "water") { if (e.A > 1500) statics.push(cand(K_AREA, e.n, e.x, e.y, 0, "water", 300 + d * 2, clamp(70 / d, 0.8, 6), Infinity)); }
      else if (e.A > 2500) {
        const minS = clamp(80 / d, e.k === "pitch" || e.k === "grass" ? 1.4 : 0.55, 6);
        statics.push(cand(K_AREA, e.n, e.x, e.y, 0, "park", 250 + d * 2.2, minS, Infinity));
      }
    }
  }

  // neighbourhoods and the parts of campus
  for (const h of HOODS) {
    const [x, y] = geo.toXY(h.lat, h.lon);
    if (!inWorld(x, y, 30)) continue;
    statics.push(cand(K_AREA, h.n, x, y, 0, h.style || "hood", h.pri, h.minS || 0, h.maxS || 1.05));
  }
  for (const h of CAMPUS) {
    const [x, y] = geo.toXY(h.lat, h.lon);
    if (!inWorld(x, y, 30)) continue;
    statics.push(cand(K_AREA, h.n, x, y, 0, "campus", 7000, 0.12, 1.45));
  }

  // rivers and creeks: the name follows the water
  {
    const items = [];
    for (const w of data.waterways || []) if (w && w.n && w.pts && w.pts.length >= 4) items.push({ n: String(w.n).trim(), pts: w.pts, rank: w.n === "Olentangy River" ? 2 : 1 });
    for (const ch of buildChains(items)) {
      const river = ch.rank >= 2;
      if (ch.len < (river ? 300 : 200)) continue;
      const step = river ? ANCH_RIVER : ANCH_STREET;
      let ai = 0;
      for (let at = step / 2; at < ch.len; at += step) {
        const [x, y, seg, t] = alongChain(ch, at);
        if (!inWorld(x, y, 20)) continue;
        const c = cand(K_CURVE, ch.name, x, y, 0, river ? "river" : "creek", river ? 9000 : 450, river ? 0.12 : 2.5, Infinity);
        c.chain = ch; c.seg = seg; c.t = t; c.ai = ai++;
        curves.push(c);
      }
    }
  }

  // streets: candidate spots every ANCH_STREET metres along every named street
  {
    const items = [];
    for (const r of data.roads || []) {
      if (!r || !r.n || !r.pts || r.pts.length < 4 || r.tn) continue;
      const rank = STREET_RANK[r.k];
      if (rank == null) continue;
      items.push({ n: String(r.n).trim(), pts: r.pts, rank });
    }
    for (const ch of buildChains(items)) {
      if (ch.len < (ch.rank <= 0.5 ? 120 : 70)) continue;
      let ai = 0;
      for (let at = ANCH_STREET / 2; at < ch.len; at += ANCH_STREET) {
        const [x, y, seg, t] = alongChain(ch, at);
        if (!inWorld(x, y, 10)) { ai++; continue; }
        const minS = ch.rank >= 3 ? 2 : ch.rank <= 0.5 ? 4 : STREET_MIN_S;
        const c = cand(K_STREET, ch.name, x, y, 0, "street", 150 + ch.rank * 380, minS, Infinity);
        c.chain = ch; c.seg = seg; c.t = t; c.ai = ai++;
        streets.push(c);
      }
    }
  }

  // shops, cafés and restaurants (not the ones that only repeat a labelled building's name)
  {
    const seen = [];
    const bByName = new Map();
    for (const c of buildingCand.values()) bByName.set(norm(c.name), c);
    for (const p of data.pois || []) {
      if (!p || !p.n || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const kind = POI_KIND[p.k];
      if (!kind || !inWorld(p.x, p.y, 5)) continue;
      const name = String(p.n).trim();
      if (name.length < 2) continue;
      const bc = bByName.get(norm(name));
      if (bc && Math.hypot(bc.x - p.x, bc.y - p.y) < 90) continue;
      if (seen.some((q) => q.n === name && Math.hypot(q.x - p.x, q.y - p.y) < 40)) continue;
      seen.push({ n: name, x: p.x, y: p.y });
      const c = cand(K_POI, name, p.x, p.y, 0, "poi", kind[1], POI_MIN_S, Infinity);
      c.col = kind[0];
      c.z = -1;   // the height of the roof it sits under, found the first time it is needed
      pois.push(c);
    }
  }

  /** ground point at arc length `at` along a chain → [x, y, segment, t] */
  function alongChain(ch, at) {
    const cum = ch.cum, g = ch.g;
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= at) lo = m; else hi = m; }
    const L = cum[lo + 1] - cum[lo], t = L > 0 ? (at - cum[lo]) / L : 0;
    return [g[2 * lo] + (g[2 * lo + 2] - g[2 * lo]) * t, g[2 * lo + 1] + (g[2 * lo + 3] - g[2 * lo + 1]) * t, lo, t];
  }

  // work that can wait for a quiet moment (but not forever: a busy page may never have one)
  const idle = (fn) => (window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 200));

  // a POI sits on the roof of the building it is in (so it reads as being in that building, not under it)
  let roofGrid = null;
  function roofAt(x, y) {
    buildRoofGrid();
    let h = 0;
    for (const i of roofGrid.get(Math.floor(x / 50) * 65536 + Math.floor(y / 50)) || []) if ((B[i].h || 0) > h && pointInRing(B[i].p[0], x, y)) h = B[i].h || 0;
    return h;
  }
  // a grid of every building, ~10 ms: made while the page is idle after the first full map, not on the first close zoom
  function buildRoofGrid() {
    if (!roofGrid) {
      roofGrid = new Map();
      for (let i = 0; i < B.length; i++) {
        const b = B[i];
        if (!b || b.hidden || !b.p || !b.p[0] || b.p[0].length < 6) continue;
        const bb = ringBox(b.p[0]);
        for (let gx = Math.floor(bb[0] / 50); gx <= Math.floor(bb[2] / 50); gx++) for (let gy = Math.floor(bb[1] / 50); gy <= Math.floor(bb[3] / 50); gy++) {
          const k = gx * 65536 + gy;
          let a = roofGrid.get(k); if (!a) roofGrid.set(k, (a = [])); a.push(i);
        }
      }
    }
  }
  {
    const warm = () => idle(() => { buildRoofGrid(); readyScene(view.rot); idle(() => { for (let r = 0; r < 4; r++) ensureRot(r); }); });
    if (app.status && app.status.loaded) warm(); else app.on("ready", warm);
  }

  // ---------------------------------------------------------------- per-rotation projections (screen metres)
  const projX = [null, null, null, null], projY = [null, null, null, null];
  function ensureRot(r) {
    if (projX[r]) return;
    const X = new Float32Array(cands.length), Y = new Float32Array(cands.length);
    for (const c of cands) { const p = geo.proj(c.x, c.y, Math.max(0, c.z), r); X[c.id] = p[0]; Y[c.id] = p[1]; }
    projX[r] = X; projY[r] = Y;
  }
  function chainRot(ch, r) {
    let R = ch.rot[r];
    if (R) return R;
    const n = ch.g.length / 2, sx = new Float32Array(2 * n), sl = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = geo.proj(ch.g[2 * i], ch.g[2 * i + 1], 0, r);
      sx[2 * i] = p[0]; sx[2 * i + 1] = p[1];
      if (i) sl[i] = sl[i - 1] + Math.hypot(sx[2 * i] - sx[2 * i - 2], sx[2 * i + 1] - sx[2 * i - 1]);
    }
    return (ch.rot[r] = { sx, sl, total: sl[n - 1] });
  }
  // the point at screen arc length L along a projected chain (scratch result, no allocation)
  const PT = { x: 0, y: 0, seg: 0, t: 0 };
  function pointAt(R, L) {
    const sl = R.sl, sx = R.sx;
    let lo = 0, hi = sl.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (sl[m] <= L) lo = m; else hi = m; }
    const d = sl[lo + 1] - sl[lo], t = d > 0 ? clamp((L - sl[lo]) / d, 0, 1) : 0;
    PT.x = sx[2 * lo] + (sx[2 * lo + 2] - sx[2 * lo]) * t;
    PT.y = sx[2 * lo + 1] + (sx[2 * lo + 3] - sx[2 * lo + 1]) * t;
    PT.seg = lo; PT.t = t;
  }

  // Is the street at this spot hidden behind a building standing in front of it? Sampled every VIS_STEP metres along a
  // chain, per view rotation, worked out the first time a label wants that stretch (a few each placement at most) and
  // kept: it doesn't change with zoom. A street name over a roof would read as the roof's.
  const VIS_STEP = 8;
  const sceneState = [0, 0, 0, 0];   // the main thread's projected scene for each rotation: 0 not asked, 1 coming, 2 there
  let visBudget = 0, visDeferred = false;
  function readyScene(r) {
    if (sceneState[r]) return;
    sceneState[r] = 1;
    // it is built once (by the app too, after the first full map and after each turn), ~100 ms: never mid-gesture
    idle(() => { app.scene.forRot(r); sceneState[r] = 2; dirty = true; });
  }
  /** 0 visible, 1 hidden, -1 not worked out yet (out of this placement's budget) */
  function spotHidden(ch, r, k) {
    const R = ch.rot[r];
    if (!R.vis) R.vis = new Int8Array(Math.floor(ch.len / VIS_STEP) + 2).fill(-1);
    if (R.vis[k] >= 0) return R.vis[k];
    if (visBudget <= 0) { visDeferred = true; return -1; }
    visBudget--;
    // the ground point k·VIS_STEP metres along the chain, on screen (z = 0)
    const at = Math.min(ch.len, k * VIS_STEP), cum = ch.cum, g = ch.g;
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= at) lo = m; else hi = m; }
    const d = cum[lo + 1] - cum[lo], t = d > 0 ? (at - cum[lo]) / d : 0;
    const X = R.sx[2 * lo] + (R.sx[2 * lo + 2] - R.sx[2 * lo]) * t, Y = R.sx[2 * lo + 1] + (R.sx[2 * lo + 3] - R.sx[2 * lo + 1]) * t;
    // nothing behind a point on the ground can be drawn over it: any building there stands in front (or over it)
    return (R.vis[k] = app.scene.pickBuilding(r, X, Y) >= 0 ? 1 : 0);
  }
  /** is too much of the street between ground arcs g0 and g1 hidden for a label? (yes, too, while not yet known) */
  function stretchHidden(ch, r, g0, g1) {
    if (sceneState[r] !== 2) { readyScene(r); return false; }
    if (g0 > g1) { const q = g0; g0 = g1; g1 = q; }
    // the middle must show; a house's eave over one end of the name is fine
    const k0 = Math.max(0, Math.round(g0 / VIS_STEP)), k1 = Math.min(Math.floor(ch.len / VIS_STEP) + 1, Math.round(g1 / VIS_STEP));
    const km = Math.round((k0 + k1) / 2);
    let hidden = 0;
    const mid = spotHidden(ch, r, km);
    if (mid !== 0) return true;
    for (let k = k0; k <= k1; k++) {
      if (k === km) continue;
      const v = spotHidden(ch, r, k);
      if (v < 0) return true;
      hidden += v;
    }
    return hidden > Math.max(0, (k1 - k0 + 1) * 0.25);
  }

  // ---------------------------------------------------------------- text: measuring, sprites
  const LS_OK = typeof CanvasRenderingContext2D !== "undefined" && "letterSpacing" in CanvasRenderingContext2D.prototype;
  const mctx = document.createElement("canvas").getContext("2d");
  let gen = 0;                       // bumped when fonts arrive or the pixel ratio changes: widths and sprites are redone
  let sprDpr = view.dpr;
  const setFont = (g, st) => { g.font = st.font; if (LS_OK) g.letterSpacing = (st.ls || 0) + "px"; };
  // without canvas letter-spacing, thin spaces stand in for it
  const spaced = (st, t) => (!LS_OK && st.ls ? Array.from(t).join(st.ls >= 2 ? "\u2009" : "\u200A") : t);
  const textW = (st, t) => mctx.measureText(spaced(st, t)).width - (LS_OK && st.ls ? st.ls : 0);

  function measure(c) {
    if (c.mGen === gen) return;
    c.mGen = gen;
    const st = c.st;
    setFont(mctx, st);
    let lines = [c.text], w = textW(st, c.text);
    if (st.wrap && w > st.wrap && c.text.includes(" ")) {
      // two balanced lines, broken at the space that evens them best
      const words = c.text.split(" ");
      let bestW = Infinity, best = null;
      for (let i = 1; i < words.length; i++) {
        const a = words.slice(0, i).join(" "), b = words.slice(i).join(" ");
        const m = Math.max(textW(st, a), textW(st, b));
        if (m < bestW) { bestW = m; best = [a, b]; }
      }
      if (best) { lines = best; w = bestW; }
    }
    c.lines = lines;
    c.w = Math.ceil(w);
    c.h = Math.ceil(lines.length * st.lh);
    if (c.kind === K_CURVE) {
      // per-glyph advances, for setting the name along a curve
      const g = Array.from(c.text);
      c.gw = new Float32Array(g.length);
      c.glyphs = g;
      let tot = 0;
      for (let i = 0; i < g.length; i++) { c.gw[i] = mctx.measureText(g[i]).width + (LS_OK ? st.ls || 0 : (st.ls || 0) * 0.9); tot += c.gw[i]; }
      c.w = Math.ceil(tot);
      c.gn = g.length;
      if (!c.gX) { c.gX = new Float32Array(g.length); c.gY = new Float32Array(g.length); c.gA = new Float32Array(g.length); }
    }
  }

  let sprites = 0, budgetEnd = 0;
  const live = new Set();            // candidates holding sprites
  function paintText(g, st, t, x, y, night) {
    const halo = night ? st.haloNight || HALO_NIGHT : st.haloDay || HALO_DAY;
    // a soft outer halo, then a firmer one close to the letters, then the ink
    g.strokeStyle = halo;
    g.globalAlpha = 0.6;
    g.lineWidth = st.halo * 2 + 1.6;
    g.shadowColor = halo; g.shadowBlur = 3 * sprDpr;
    g.strokeText(t, x, y);
    g.shadowBlur = 0; g.shadowColor = "transparent";
    // by night the halo is a dark shadow under light letters: thinner, or it swallows them
    g.globalAlpha = 1;
    g.lineWidth = st.halo * (night ? 1.15 : 1.5);
    g.strokeText(t, x, y);
    g.fillStyle = night ? st.night : st.ink;
    g.fillText(t, x, y);
  }
  function newCanvas(w, h) {
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.ceil(w * sprDpr)); cv.height = Math.max(1, Math.ceil(h * sprDpr));
    const g = cv.getContext("2d");
    g.scale(sprDpr, sprDpr);
    g.lineJoin = "round"; g.miterLimit = 2;
    return { cv, g, w: cv.width / sprDpr, h: cv.height / sprDpr };
  }
  function makeSprite(c, night) {
    const st = c.st, pad = Math.ceil(st.halo + 3), dot = st.dot || 0;
    const s = newCanvas(c.w + dot + 2 * pad, c.h + 2 * pad), g = s.g;
    setFont(g, st);
    g.textBaseline = "middle";
    g.textAlign = dot ? "left" : "center";
    const lsFix = LS_OK && st.ls ? st.ls / 2 : 0;   // canvas letter-spacing trails the last letter: re-centre
    for (let i = 0; i < c.lines.length; i++) {
      const x = dot ? pad + dot : pad + c.w / 2 + lsFix, y = pad + st.lh * (i + 0.5) + 0.5;
      paintText(g, st, spaced(st, c.lines[i]), x, y, night);
    }
    if (dot) {
      g.beginPath(); g.arc(pad + 3.5, pad + c.h / 2, 2.7, 0, Math.PI * 2);
      g.fillStyle = night ? HALO_NIGHT : HALO_DAY; g.globalAlpha = 0.9; g.lineWidth = 3; g.strokeStyle = g.fillStyle; g.stroke();
      g.globalAlpha = 1; g.fillStyle = c.col; g.fill();
    }
    s.pad = pad;
    return s;
  }
  // glyphs for names set along a curve: one sprite per letter and style
  const glyphCache = new Map();
  function glyphSprite(st, ch, night) {
    const key = st.font + "|" + ch + "|" + (night ? 1 : 0) + "|" + gen;
    let s = glyphCache.get(key);
    if (s || performance.now() > budgetEnd) return s || null;
    setFont(mctx, st);
    const w = mctx.measureText(ch).width, pad = Math.ceil(st.halo + 3);
    s = newCanvas(w + 2 * pad, st.lh + 2 * pad);
    if (LS_OK) s.g.letterSpacing = "0px";
    s.g.font = st.font; s.g.textBaseline = "middle"; s.g.textAlign = "center";
    paintText(s.g, st, ch, s.w / 2, s.h / 2 + 0.5, night);
    if (glyphCache.size > 400) glyphCache.clear();
    glyphCache.set(key, s);
    return s;
  }
  /** the sprite for a label in one palette; made within this frame's budget, or the stale one meanwhile */
  function spriteOf(c, night) {
    const cur = night ? c.sprN : c.spr;
    if (cur && (night ? c.gN : c.gD) === gen) return cur;
    if (performance.now() > budgetEnd) return cur;
    measure(c);
    const s = makeSprite(c, night);
    if (night) { c.sprN = s; c.gN = gen; } else { c.spr = s; c.gD = gen; }
    if (!cur) sprites++;
    live.add(c);
    return s;
  }
  // forget the sprites of labels not shown for a while (a long session would otherwise keep thousands)
  function trimSprites(frame) {
    if (live.size < 500) return;
    for (const c of live) {
      if (frame - c.used < 900) continue;
      c.spr = c.sprN = null; c.gD = c.gN = -1;
      live.delete(c);
    }
    sprites = live.size;
  }
  function invalidateText() { gen++; dirty = true; }
  if (document.fonts) {
    const want = [`italic 500 12px Fraunces`, `italic 600 12px Fraunces`, `italic 400 12px Fraunces`, `500 10px Inter`, `600 10px Inter`];
    Promise.all(want.map((f) => document.fonts.load(f).catch(() => null))).then(invalidateText, () => {});
    document.fonts.addEventListener?.("loadingdone", invalidateText);
  }

  // ---------------------------------------------------------------- collision grid (screen px)
  let gCols = 0, gRows = 0, gN = 0;
  const gCells = [], gUsed = [];
  let gBox = new Float32Array(4 * 1024);
  const TB = new Float32Array(4 * 96);
  let tbN = 0;
  function gridReset(W, H) {
    for (let i = 0; i < gUsed.length; i++) gCells[gUsed[i]].length = 0;
    gUsed.length = 0; gN = 0;
    gCols = Math.ceil((W + 2 * GM) / CELL) + 1; gRows = Math.ceil((H + 2 * GM) / CELL) + 1;
    while (gCells.length < gCols * gRows) gCells.push([]);
  }
  const cellX = (x) => clamp(Math.floor((x + GM) / CELL), 0, gCols - 1);
  const cellY = (y) => clamp(Math.floor((y + GM) / CELL), 0, gRows - 1);
  function gridHit(x0, y0, x1, y1) {
    const cx1 = cellX(x1), cy1 = cellY(y1);
    for (let cy = cellY(y0); cy <= cy1; cy++) for (let cx = cellX(x0); cx <= cx1; cx++) {
      const cell = gCells[cy * gCols + cx];
      for (let k = 0; k < cell.length; k++) {
        const o = 4 * cell[k];
        if (x0 < gBox[o + 2] && x1 > gBox[o] && y0 < gBox[o + 3] && y1 > gBox[o + 1]) return true;
      }
    }
    return false;
  }
  function gridAdd(x0, y0, x1, y1) {
    if (4 * gN + 4 > gBox.length) { const nb = new Float32Array(gBox.length * 2); nb.set(gBox); gBox = nb; }
    const o = 4 * gN;
    gBox[o] = x0; gBox[o + 1] = y0; gBox[o + 2] = x1; gBox[o + 3] = y1;
    const cx1 = cellX(x1), cy1 = cellY(y1);
    for (let cy = cellY(y0); cy <= cy1; cy++) for (let cx = cellX(x0); cx <= cx1; cx++) {
      const idx = cy * gCols + cx, cell = gCells[idx];
      if (!cell.length) gUsed.push(idx);
      cell.push(gN);
    }
    gN++;
  }
  const tbPush = (x0, y0, x1, y1) => { if (tbN < 96) { const o = 4 * tbN++; TB[o] = x0; TB[o + 1] = y0; TB[o + 2] = x1; TB[o + 3] = y1; } };

  // ---------------------------------------------------------------- layout of one candidate (fills TB with its boxes)
  const placedStreets = [];          // { name, x, y } this placement, to keep one label per street per stretch of screen
  let placedN = 0;
  function streetClash(name, x, y, minD) {
    for (let i = 0; i < placedN; i++) {
      const p = placedStreets[i];
      if (p.name === name && Math.abs(p.x - x) < minD && Math.abs(p.y - y) < minD && Math.hypot(p.x - x, p.y - y) < minD) return true;
    }
    return false;
  }
  function notePlaced(name, x, y) {
    if (placedN === placedStreets.length) placedStreets.push({ name: "", x: 0, y: 0 });
    const p = placedStreets[placedN++];
    p.name = name; p.x = x; p.y = y;
  }

  function layout(c, s, r, W2, H2) {
    tbN = 0;
    measure(c);
    const vX = view.X, vY = view.Y;
    if (c.kind === K_STREET) return layoutStreet(c, s, r, W2, H2);
    if (c.kind === K_CURVE) return layoutCurve(c, s, r, W2, H2);
    c.X = projX[r][c.id]; c.Y = projY[r][c.id];
    if (c.kind === K_POI) {
      if (c.z < 0) {
        c.z = roofAt(c.x, c.y);
        for (let q = 0; q < 4; q++) if (projX[q]) { const p = geo.proj(c.x, c.y, c.z, q); projX[q][c.id] = p[0]; projY[q][c.id] = p[1]; }
        c.X = projX[r][c.id]; c.Y = projY[r][c.id];
      }
    }
    const px = (c.X - vX) * s + W2, py = (c.Y - vY) * s + H2;
    const pad = Math.ceil(c.st.halo + 3);
    if (c.kind === K_BUILDING) {
      let lift = GAP;
      if (c.bi === selRoot) lift += 13;    // clear of the card's marker on the roof
      c.bx0 = -c.w / 2; c.bx1 = c.w / 2; c.by1 = -lift; c.by0 = -lift - c.h;
      c.ox = c.bx0 - pad; c.oy = c.by0 - pad;
      tbPush(px + c.bx0 - 3, py + c.by0 - 1, px + c.bx1 + 3, py + c.by1 + 1);
    } else if (c.kind === K_POI) {
      const dot = c.st.dot;
      c.bx0 = -4; c.bx1 = dot - 3.5 + c.w; c.by0 = -c.h / 2; c.by1 = c.h / 2;
      c.ox = -pad - 3.5; c.oy = -pad - c.h / 2;
      tbPush(px + c.bx0 - 2, py + c.by0 - 1, px + c.bx1 + 2, py + c.by1 + 1);
    } else {
      c.bx0 = -c.w / 2; c.bx1 = c.w / 2; c.by0 = -c.h / 2; c.by1 = c.h / 2;
      c.ox = c.bx0 - pad; c.oy = c.by0 - pad;
      tbPush(px + c.bx0 - 5, py + c.by0 - 2, px + c.bx1 + 5, py + c.by1 + 2);
    }
    return true;
  }

  // A street name runs straight along the street, centred on it: it needs a straight enough stretch as long as itself.
  function layoutStreet(c, s, r, W2, H2) {
    const R = chainRot(c.chain, r);
    const L = R.sl[c.seg] + (R.sl[c.seg + 1] - R.sl[c.seg]) * c.t;
    const half = (c.w / 2 + 8) / s;
    if (L - half < 0 || L + half > R.total) return false;
    pointAt(R, L - half);
    const ax = PT.x, ay = PT.y, sa = PT.seg, ta = PT.t;
    pointAt(R, L + half);
    const bx = PT.x, by = PT.y, sb = PT.seg, tb = PT.t;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    if (len * s < c.w) return false;                         // folds back on itself
    for (let k = sa + 1; k <= sb; k++) {
      const vx = R.sx[2 * k] - ax, vy = R.sx[2 * k + 1] - ay;
      if (Math.abs(vx * dy - vy * dx) / len * s > 2.2) return false;
    }
    // the projection is affine, so a segment's screen fraction is its ground fraction too
    const cum = c.chain.cum;
    if (stretchHidden(c.chain, r, cum[sa] + (cum[sa + 1] - cum[sa]) * ta, cum[sb] + (cum[sb + 1] - cum[sb]) * tb)) return false;
    let ang = Math.atan2(dy, dx);
    if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
    c.X = (ax + bx) / 2; c.Y = (ay + by) / 2; c.ang = ang;
    const px = (c.X - view.X) * s + W2, py = (c.Y - view.Y) * s + H2;
    if (streetClash(c.name, px, py, 300 + c.w)) return false;
    // the label as a string of small boxes along its slant (one big box would block everything round a diagonal)
    const co = Math.cos(ang), si = Math.sin(ang), n = Math.max(1, Math.ceil(c.w / 16)), seg = c.w / n;
    const hw = seg / 2 + 1, hh = c.st.lh / 2 + 2;
    const ex = hw * Math.abs(co) + hh * Math.abs(si), ey = hw * Math.abs(si) + hh * Math.abs(co);
    for (let i = 0; i < n; i++) {
      const o = -c.w / 2 + (i + 0.5) * seg, cx = px + co * o, cy = py + si * o;
      tbPush(cx - ex, cy - ey, cx + ex, cy + ey);
    }
    return true;
  }

  // A river's name is set letter by letter along its bends, reading left to right.
  const GX = new Float32Array(64), GY = new Float32Array(64), GA = new Float32Array(64);
  function layoutCurve(c, s, r, W2, H2) {
    if (c.gn > 64) return false;
    const R = chainRot(c.chain, r);
    const L = R.sl[c.seg] + (R.sl[c.seg + 1] - R.sl[c.seg]) * c.t;
    const half = c.w / 2 / s;
    if (L - half < 0 || L + half > R.total) return false;
    pointAt(R, L - half);
    const x0 = PT.x;
    pointAt(R, L + half);
    const dir = PT.x >= x0 ? 1 : -1;
    let pos = L - dir * half, prevA = NaN, turn = 0;
    // each letter turns with the water over a window a little wider than itself, so small wiggles don't shake the text
    const d = 12 / s;
    for (let i = 0; i < c.gn; i++) {
      const gw = c.gw[i] / s, mid = pos + dir * gw / 2;
      pointAt(R, mid - d); const ax = PT.x, ay = PT.y;
      pointAt(R, mid + d); const bx = PT.x, by = PT.y;
      pointAt(R, mid);
      let ang = Math.atan2((by - ay) * dir, (bx - ax) * dir);
      if (Math.abs(ang) > 1.35) return false;              // too steep to read
      if (prevA === prevA) {
        let da = ang - prevA;
        if (da > Math.PI) da -= 2 * Math.PI; else if (da < -Math.PI) da += 2 * Math.PI;
        if (Math.abs(da) > 0.5) return false;               // a kink: letters would collide
        turn += da;
      }
      prevA = ang;
      GX[i] = PT.x; GY[i] = PT.y; GA[i] = ang;
      pos += dir * gw;
    }
    if (Math.abs(turn) > 1.4) return false;
    const mi = c.gn >> 1;
    const px = (GX[mi] - view.X) * s + W2, py = (GY[mi] - view.Y) * s + H2;
    if (streetClash(c.name, px, py, 420 + c.w)) return false;
    // it fits: only now replace the letters' places (a label fading out keeps the shape it had)
    c.gX.set(GX.subarray(0, c.gn)); c.gY.set(GY.subarray(0, c.gn)); c.gA.set(GA.subarray(0, c.gn));
    c.X = GX[mi]; c.Y = GY[mi];
    const hh = c.st.lh / 2 + 1;
    for (let i = 0; i < c.gn; i++) {
      const gx = (c.gX[i] - view.X) * s + W2, gy = (c.gY[i] - view.Y) * s + H2, e = Math.max(c.gw[i] / 2, hh);
      tbPush(gx - e, gy - e, gx + e, gy + e);
    }
    return true;
  }

  // ---------------------------------------------------------------- placement
  let vis = [], visPrev = [];
  let stamp = 0, dirty = true;
  let lastX = NaN, lastY = NaN, lastS = NaN, lastR = -1, lastW = 0, lastH = 0, lastPlace = -1e9;
  const byK = (a, b) => b.k - a.k;
  let trace = null;
  const stats = { placeMs: 0, drawMs: 0, hlMs: 0, shown: 0, considered: 0, sprites: 0, frames: 0 };

  const chrome = [];
  let chromeT = -1e9;
  function readChrome(t) {
    chromeT = t;
    chrome.length = 0;
    const rc = canvas.getBoundingClientRect();
    for (const el of document.querySelectorAll("#bar, #map-btns, #status, #credits, #cards > .card")) {
      const q = el.getBoundingClientRect();
      if (q.width < 1 || q.height < 1) continue;
      chrome.push([q.left - rc.left - 4, q.top - rc.top - 4, q.right - rc.left + 4, q.bottom - rc.top + 4]);
    }
  }
  const chromeSoon = () => { chromeT = -1e9; setTimeout(() => { chromeT = -1e9; dirty = true; }, 320); };
  window.addEventListener("resize", chromeSoon);

  function gather(list, s, r, X0, Y0, X1, Y1, stepFor) {
    const PX = projX[r], PY = projY[r];
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (s < c.minS * 0.8 || s > c.maxS * 1.25) continue;
      if (stepFor && !c.on && c.a <= 0 && c.ai % stepFor(c) !== 0) continue;
      const X = PX[c.id], Y = PY[c.id];
      if (X < X0 || X > X1 || Y < Y0 || Y > Y1) continue;
      c.stamp = stamp;
      vis.push(c);
    }
  }
  // along a street, a spot every so many metres is tried: fewer as you zoom out, always on the same metre marks
  let streetStep = 1, curveStep = 1;
  const stepStreet = () => streetStep, stepCurve = () => curveStep;

  function place(t) {
    const t0 = performance.now();
    const s = view.s, r = view.rot, W = view.w, H = view.h, W2 = W / 2, H2 = H / 2;
    ensureRot(r);
    stamp++;
    const tmp = visPrev; visPrev = vis; vis = tmp; vis.length = 0;
    // anchors may sit a little off screen (labels hang off them); cull a margin's worth beyond the edges
    const M = 50;
    const X0 = view.X - (W2 + M) / s, X1 = view.X + (W2 + M) / s, Y0 = view.Y - (H2 + M) / s, Y1 = view.Y + (H2 + M) / s;
    gather(statics, s, r, X0, Y0, X1, Y1, null);
    curveStep = 1 << Math.max(0, Math.round(Math.log2(Math.max(1, 110 / s / ANCH_RIVER))));
    gather(curves, s, r, X0, Y0, X1, Y1, stepCurve);
    if (s >= 2 * 0.8) {
      streetStep = 1 << Math.max(0, Math.round(Math.log2(Math.max(1, 260 / s / ANCH_STREET))));
      gather(streets, s, r, X0, Y0, X1, Y1, stepStreet);
    }
    if (s >= POI_MIN_S * 0.8) gather(pois, s, r, X0, Y0, X1, Y1, null);
    // what dropped out of view stops at once (it is off screen anyway)
    for (let i = 0; i < visPrev.length; i++) { const c = visPrev[i]; if (c.stamp !== stamp) { c.a = 0; c.on = false; } }
    // by priority, with a bonus for what already shows, so labels hold their place as the view moves
    const cx = W2, cy = H2;
    for (let i = 0; i < vis.length; i++) {
      const c = vis[i];
      let k = c.pri * (c.on ? 1.35 : 1);
      if (c.kind === K_STREET || c.kind === K_CURVE || c.kind === K_POI) {
        // among equals, the ones nearer the middle of the screen first
        const px = (projX[r][c.id] - view.X) * s + cx, py = (projY[r][c.id] - view.Y) * s + cy;
        k -= (Math.abs(px - cx) + Math.abs(py - cy)) * 0.02;
      }
      c.k = k;
    }
    vis.sort(byK);
    gridReset(W, H);
    // the bar, the map buttons, the status line and open cards sit over the map: no labels under them
    if (t - chromeT > 1000) readChrome(t);
    for (const q of chrome) gridAdd(q[0], q[1], q[2], q[3]);
    placedN = 0;
    visBudget = 48; visDeferred = false;
    let shown = 0;
    for (let i = 0; i < vis.length; i++) {
      const c = vis[i];
      if (s < c.minS || s > c.maxS || !layout(c, s, r, W2, H2)) { c.on = false; continue; }
      let hit = false;
      // whole labels only: one cut by the screen's edge waits until it is all in view
      for (let b = 0; b < tbN && !hit; b++) { const o = 4 * b; hit = TB[o] < -2 || TB[o + 1] < -2 || TB[o + 2] > W + 2 || TB[o + 3] > H + 2; }
      for (let b = 0; b < tbN && !hit; b++) { const o = 4 * b; hit = gridHit(TB[o], TB[o + 1], TB[o + 2], TB[o + 3]); }
      if (hit) { c.on = false; continue; }
      for (let b = 0; b < tbN; b++) { const o = 4 * b; gridAdd(TB[o], TB[o + 1], TB[o + 2], TB[o + 3]); }
      if (c.kind === K_STREET || c.kind === K_CURVE) notePlaced(c.name, (c.X - view.X) * s + W2, (c.Y - view.Y) * s + H2);
      c.on = true;
      shown++;
    }
    lastX = view.X; lastY = view.Y; lastS = s; lastR = r; lastW = W; lastH = H; lastPlace = t;
    dirty = visDeferred;             // some streets wait on their visibility: place again next frame
    stats.shown = shown; stats.considered = vis.length;
    stats.placeMs = stats.placeMs * 0.9 + (performance.now() - t0) * 0.1;
  }

  // ---------------------------------------------------------------- drawing
  let paletteMix = -1;               // 0 day palette … 1 night palette, eased
  const nightK = () => (app.weather && app.layerEnabled("sky") ? clamp(+app.weather.night || 0, 0, 1) : 0);
  function nightTarget() {
    const w = app.weather;
    if (!w || !app.layerEnabled("sky")) return 0;
    const n = +w.night || 0;
    // a little hysteresis so a night value hovering at the threshold doesn't flip the palette back and forth
    return paletteMix >= 0.5 ? (n > 0.4 ? 1 : 0) : (n > 0.55 ? 1 : 0);
  }

  function drawOne(ctx, c, alpha, night, s, W2, H2, dpr) {
    const vX = view.X, vY = view.Y;
    if (c.kind === K_CURVE) {
      for (let i = 0; i < c.gn; i++) {
        const g = glyphSprite(c.st, c.glyphs[i], night);
        if (!g) return false;
        const px = (c.gX[i] - vX) * s + W2, py = (c.gY[i] - vY) * s + H2;
        const co = Math.cos(c.gA[i]) * dpr, si = Math.sin(c.gA[i]) * dpr;
        ctx.globalAlpha = alpha;
        ctx.setTransform(co, si, -si, co, px * dpr, py * dpr);
        ctx.drawImage(g.cv, -g.w / 2, -g.h / 2, g.w, g.h);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return true;
    }
    const spr = spriteOf(c, night);
    if (!spr) return false;
    const px = (c.X - vX) * s + W2, py = (c.Y - vY) * s + H2;
    ctx.globalAlpha = alpha;
    if (c.kind === K_STREET) {
      const co = Math.cos(c.ang) * dpr, si = Math.sin(c.ang) * dpr;
      ctx.setTransform(co, si, -si, co, px * dpr, py * dpr);
      ctx.drawImage(spr.cv, -spr.w / 2, -spr.h / 2, spr.w, spr.h);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    } else {
      // whole device pixels keep the small text crisp
      const x = Math.round((px + c.ox) * dpr) / dpr, y = Math.round((py + c.oy) * dpr) / dpr;
      ctx.drawImage(spr.cv, x, y, spr.w, spr.h);
    }
    return true;
  }

  function drawLabels(ctx, f) {
    const t0 = performance.now();
    if (view.dpr !== sprDpr) { sprDpr = view.dpr; gen++; dirty = true; }
    const moved = view.X !== lastX || view.Y !== lastY;
    const zoomed = view.s !== lastS || view.rot !== lastR || view.w !== lastW || view.h !== lastH;
    // a pan keeps every label's place relative to the others: re-place now and then (for labels coming in at the edges)
    if (dirty || zoomed || (moved && f.t - lastPlace > 110)) place(f.t);
    const t1 = performance.now();
    budgetEnd = t0 + 2.5;            // new sprites per frame: a zoom that reveals many labels spreads them over frames
    const made0 = sprites;
    const step = motionMQ.matches ? 1 : f.dt / FADE_S;
    const want = nightTarget();
    if (paletteMix < 0) paletteMix = want;
    paletteMix = want > paletteMix ? Math.min(want, paletteMix + f.dt / 0.6) : Math.max(want, paletteMix - f.dt / 0.6);
    const s = view.s, W2 = view.w / 2, H2 = view.h / 2, dpr = view.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    // lowest priority first, so the important ones sit on top while others fade
    for (let i = vis.length - 1; i >= 0; i--) {
      const c = vis[i];
      if (!c.on && c.a <= 0) continue;
      const target = c.on ? 1 : 0;
      const a1 = target > c.a ? Math.min(1, c.a + step) : Math.max(0, c.a - step);
      if (a1 <= 0) { c.a = 0; continue; }
      const e = a1 * a1 * (3 - 2 * a1);
      let ok = true;
      if (paletteMix < 0.999) ok = drawOne(ctx, c, e * (1 - paletteMix), false, s, W2, H2, dpr) && ok;
      if (paletteMix > 0.001) ok = drawOne(ctx, c, e * paletteMix, true, s, W2, H2, dpr) && ok;
      // a label whose sprite isn't made yet waits at the start of its fade
      c.a = ok || c.a > 0 ? a1 : 0;
      c.used = f.frame;
    }
    ctx.globalAlpha = 1;
    if ((f.frame & 255) === 0) trimSprites(f.frame);
    stats.sprites = live.size; stats.palette = paletteMix;
    const t2 = performance.now();
    stats.drawMs = stats.drawMs * 0.9 + (t2 - t0) * 0.1;
    stats.frames++;
    if (trace) trace.push([+(t1 - t0).toFixed(3), +(t2 - t1).toFixed(3), sprites - made0, vis.length]);
  }

  function labelAt(px, py) {
    const s = view.s, W2 = view.w / 2, H2 = view.h / 2;
    for (let i = 0; i < vis.length; i++) {
      const c = vis[i];
      if (c.kind !== K_BUILDING || !c.on || c.a < 0.3) continue;
      const x = (c.X - view.X) * s + W2, y = (c.Y - view.Y) * s + H2;
      if (px >= x + c.bx0 - 3 && px <= x + c.bx1 + 3 && py >= y + c.by0 - 2 && py <= y + c.by1 + 2) return c;
    }
    return null;
  }

  const labelLayer = app.addLayer({
    id: "labels", z: 90,
    draw: drawLabels,
    hit: (px, py) => labelAt(px, py),
    onClick: (c, e) => {
      if (!c || c.bi < 0) return;
      app.emit("pick-building", { index: c.bi, building: B[c.bi], px: e ? e.px : 0, py: e ? e.py : 0 });
    },
  });

  // ---------------------------------------------------------------- the building highlight
  let selRoot = -1;
  const marks = [];                  // { root, sel, a, want }
  function setMark(sel, root) {
    for (const m of marks) if (m.sel === sel && m.root !== root) m.want = false;
    if (root < 0 || !B[root]) return;
    let m = null;
    for (const q of marks) if (q.sel === sel && q.root === root) m = q;
    if (!m) marks.push((m = { root, sel, a: 0, want: true, cv: null, img: null }));
    m.want = true;
  }
  function select(i) {
    const root = rootOf(i);
    if (root === selRoot) return;
    selRoot = root;
    setMark(true, root);
    dirty = true;
  }

  // the outline of building i (or the parts of a building drawn by its parts) for rotation r, in screen metres
  const hlCache = new Map();
  function hlShape(root, r) {
    const key = root * 4 + r;
    let sh = hlCache.get(key);
    if (sh) return sh;
    const S = app.scene.forRot(r);
    const ids = B[root].hidden ? (members.get(root) || []) : [root];
    const path = new Path2D();
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    const ext = (X, Y) => { if (X < bb[0]) bb[0] = X; if (X > bb[2]) bb[2] = X; if (Y < bb[1]) bb[1] = Y; if (Y > bb[3]) bb[3] = Y; };
    const o = geo.ROTS[r];
    // every subpath wound the same way, so the soft fill covers overlaps once (nonzero)
    const poly = (pts, hole) => {
      let a = 0;
      for (let i = 0, n = pts.length, j = n - 2; i < n; j = i, i += 2) a += pts[j] * pts[i + 1] - pts[i] * pts[j + 1];
      const rev = (a < 0) !== !!hole;
      const n = pts.length / 2;
      for (let k = 0; k < n; k++) {
        const q = rev ? n - 1 - k : k, X = pts[2 * q], Y = pts[2 * q + 1];
        if (k) path.lineTo(X, Y); else path.moveTo(X, Y);
        ext(X, Y);
      }
      path.closePath();
    };
    for (const i of ids) {
      const b = B[i], rings = S.objRings[i];
      if (!b || !rings) continue;
      const pitched = b.roof && b.roof !== "flat" && b.obb;
      const he = pitched ? b.h - (b.rh || 0) : b.h;
      const top = he * COS_T, bot = (b.mh || 0) * COS_T;
      if (pitched) {
        // a pitched roof: the outline of base, eaves and ridge together (houses are near enough convex)
        const [cx, cy, ang, L, Wd] = b.obb;
        const lx = Math.cos(ang), ly = Math.sin(ang), wx = -ly, wy = lx, hl = L / 2 + 0.35, hw = Wd / 2 + 0.35;
        const shape = b.roof === "hipped" || b.roof === "half-hipped" || b.roof === "mansard" ? "hipped" : b.roof === "pyramidal" ? "pyramidal" : "gabled";
        const rh = shape === "gabled" ? hl : shape === "hipped" ? Math.max(0, L / 2 - Wd / 2) : 0;
        const pts = [];
        const f = rings[0];
        for (let k = 0; k < f.length; k += 2) pts.push([f[k], f[k + 1] - bot]);
        for (const [al, ac, z] of [[-hl, -hw, he], [hl, -hw, he], [hl, hw, he], [-hl, hw, he], [-rh, 0, b.h], [rh, 0, b.h]]) pts.push(geo.proj(cx + lx * al + wx * ac, cy + ly * al + wy * ac, z, r));
        const hull = convexHull(pts), flat = [];
        for (const p of hull) flat.push(p[0], p[1]);
        if (flat.length >= 6) poly(flat, false);
        const r0 = geo.proj(cx - lx * rh, cy - ly * rh, b.h, r), r1 = geo.proj(cx + lx * rh, cy + ly * rh, b.h, r);
        if (rh > 0.2) { path.moveTo(r0[0], r0[1]); path.lineTo(r1[0], r1[1]); }
        continue;
      }
      // the roof, then each wall that faces the camera
      rings.forEach((f, ri) => {
        const roof = new Float32Array(f.length);
        for (let k = 0; k < f.length; k += 2) { roof[k] = f[k]; roof[k + 1] = f[k + 1] - top; }
        poly(roof, ri > 0);
        const g = b.p[ri], n = g.length / 2;
        for (let a = 0, c = n - 1; a < n; c = a++) {
          const dx = g[2 * a] - g[2 * c], dy = g[2 * a + 1] - g[2 * c + 1], L = Math.hypot(dx, dy);
          if (L < 0.05) continue;
          if ((dy / L) * o.D[0] + (-dx / L) * o.D[1] >= -0.001) continue;   // faces away
          const x1 = f[2 * c], y1 = f[2 * c + 1], x2 = f[2 * a], y2 = f[2 * a + 1];
          poly([x1, y1 - bot, x2, y2 - bot, x2, y2 - top, x1, y1 - top], false);
        }
      });
    }
    sh = { path, bb };
    if (hlCache.size > 160) hlCache.clear();
    hlCache.set(key, sh);
    return sh;
  }

  // A mark is drawn into its own small canvas at the current scale: the outline can then be the shape's outer edge only,
  // with the glow outside it, and while the map pans (or zooms, scaled) it is one drawImage a frame. Redone when the
  // zoom settles, the view turns, or the part of a big building near the screen moves past what was drawn.
  function renderMark(m, s, dpr, need) {
    const sh = hlShape(m.root, view.rot);
    // device resolution, unless that would be a huge canvas (a big building up close on a big screen): then coarser
    const cw = (need[2] - need[0]) * s, ch = (need[3] - need[1]) * s;
    const k = Math.min(dpr, 2, Math.sqrt(4e6 / Math.max(1, cw * ch)));
    const w = Math.ceil(cw * k), h = Math.ceil(ch * k);
    if (w < 1 || h < 1) { m.img = null; return; }
    if (!m.cv) m.cv = document.createElement("canvas");
    if (m.cv.width !== w || m.cv.height !== h) { m.cv.width = w; m.cv.height = h; }
    const g = m.cv.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
    g.clearRect(0, 0, w, h);
    g.setTransform(k * s, 0, 0, k * s, -need[0] * s * k, -need[1] * s * k);
    g.lineJoin = "round"; g.lineCap = "round";
    // the night tint (drawn over this layer) darkens everything under it: a brighter red keeps the outline visible
    const nk = nightK(), cr = Math.round(179 + 76 * nk), cg = Math.round(32 + 60 * nk), cb = Math.round(42 + 58 * nk);
    const col = `rgb(${cr}, ${cg}, ${cb})`;
    g.strokeStyle = col; g.fillStyle = col;
    // the outline and a soft glow beyond it: wide faint strokes and a firm one over every edge, then everything inside
    // the shape cleared, which leaves only their outer halves (wide strokes rather than a shadow blur, which on a
    // screen-sized canvas costs tens of milliseconds without a GPU)
    g.globalAlpha = m.sel ? 0.1 : 0.08; g.lineWidth = 16 / s; g.stroke(sh.path);
    g.globalAlpha = m.sel ? 0.16 : 0.12; g.lineWidth = 9 / s; g.stroke(sh.path);
    g.globalAlpha = 1; g.lineWidth = (m.sel ? 4.2 : 3.4) / s; g.stroke(sh.path);
    g.globalCompositeOperation = "destination-out";
    g.fill(sh.path);
    // a faint scarlet wash over the building, its own edges traced lightly
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = (m.sel ? 0.15 : 0.1) * (1 + nk);
    g.fill(sh.path);
    g.globalAlpha = m.sel ? 0.4 : 0.3;
    g.lineWidth = 1 / s;
    g.stroke(sh.path);
    m.img = { X0: need[0], Y0: need[1], X1: need[2], Y1: need[3], s, rot: view.rot, root: m.root, nk };
  }
  const NEED = [0, 0, 0, 0];
  let prevFrameS = NaN;
  function drawMark(ctx, m, s, dpr) {
    if (!app.scene) return;
    const sh = hlShape(m.root, view.rot);
    const W2 = view.w / 2, H2 = view.h / 2;
    // the part of the shape on screen (its glow, a few px beyond, may be clipped for a moment while zooming out)
    const vx0 = view.X - W2 / s, vx1 = view.X + W2 / s, vy0 = view.Y - H2 / s, vy1 = view.Y + H2 / s;
    NEED[0] = Math.max(sh.bb[0], vx0); NEED[2] = Math.min(sh.bb[2], vx1);
    NEED[1] = Math.max(sh.bb[1], vy0); NEED[3] = Math.min(sh.bb[3], vy1);
    if (NEED[2] <= NEED[0] - 20 / s || NEED[3] <= NEED[1] - 20 / s) return;        // off screen, glow and all
    const img = m.img;
    const settled = s === prevFrameS;
    const stale = !img || img.rot !== view.rot || img.root !== m.root || (img.s !== s && settled) || Math.abs(Math.log(img.s / s)) > 0.35 ||
      Math.abs(img.nk - nightK()) > 0.15 ||
      NEED[0] < img.X0 - 1e-6 || NEED[1] < img.Y0 - 1e-6 || NEED[2] > img.X1 + 1e-6 || NEED[3] > img.Y1 + 1e-6;
    if (stale) {
      // the glow's room round the shape, and a margin beyond the screen so a pan doesn't redo it every frame
      const pad = 20 / s, more = 200 / s;
      const need = [Math.max(sh.bb[0] - pad, vx0 - more), Math.max(sh.bb[1] - pad, vy0 - more), Math.min(sh.bb[2] + pad, vx1 + more), Math.min(sh.bb[3] + pad, vy1 + more)];
      renderMark(m, s, dpr, need);
    }
    if (!m.img) return;
    const q = m.img, a = m.a * m.a * (3 - 2 * m.a);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = a;
    ctx.drawImage(m.cv, (q.X0 - view.X) * s + W2, (q.Y0 - view.Y) * s + H2, (q.X1 - q.X0) * s, (q.Y1 - q.Y0) * s);
  }

  // pointer: hover is resolved once a frame at most, from the last position seen
  const ptr = { x: 0, y: 0, inside: false, dirty: false };
  let hoverRoot = -1, cursorSet = false, hvX = NaN, hvY = NaN, hvS = NaN, hvR = -1;
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;                 // no hover on touch screens
    const rc = canvas.getBoundingClientRect();
    ptr.x = e.clientX - rc.left; ptr.y = e.clientY - rc.top; ptr.inside = true; ptr.dirty = true;
  }, { passive: true });
  canvas.addEventListener("pointerleave", () => { ptr.inside = false; ptr.dirty = true; });
  canvas.addEventListener("pointerdown", () => { ptr.dirty = true; });

  function otherLayerHit(px, py) {
    for (const L of app.layers) {
      if (L === labelLayer || L === hlLayer || !L.hit || !app.layerEnabled(L.id)) continue;
      try { if (L.hit(px, py)) return true; } catch { /* their problem, not the highlight's */ }
    }
    return false;
  }
  function resolveHover() {
    const dragging = view.pointers && view.pointers.size > 0;
    let root = -1, other = false;
    if (ptr.inside && !dragging && app.status && app.status.loaded) {
      const lb = app.layerEnabled("labels") ? labelAt(ptr.x, ptr.y) : null;
      // a label names its building; a bus or a stop in front of a building is what the pointer is on, not the building
      if (lb) root = rootOf(lb.bi);
      else if (!(other = otherLayerHit(ptr.x, ptr.y))) root = rootOf(app.pickBuilding(ptr.x, ptr.y));
    }
    if (root !== hoverRoot) { hoverRoot = root; setMark(false, root); }
    // the app clears the cursor on every move that finds nothing of a layer's under it: buildings are clickable too
    if (root >= 0) { canvas.style.cursor = "pointer"; cursorSet = true; }
    else if (cursorSet) { if (!other) canvas.style.cursor = ""; cursorSet = false; }
  }

  const hlLayer = app.addLayer({
    id: "building-highlight", z: 60,
    draw(ctx, f) {
      const t0 = performance.now();
      const vmoved = view.X !== hvX || view.Y !== hvY || view.s !== hvS || view.rot !== hvR;
      if (ptr.dirty || (vmoved && ptr.inside)) {
        ptr.dirty = false; hvX = view.X; hvY = view.Y; hvS = view.s; hvR = view.rot;
        resolveHover();
      }
      if (!marks.length) return;
      const step = motionMQ.matches ? 1 : f.dt / HL_FADE_S;
      const s = view.s, dpr = view.dpr;
      for (let i = marks.length - 1; i >= 0; i--) {
        const m = marks[i];
        m.a = m.want ? Math.min(1, m.a + step) : Math.max(0, m.a - step);
        if (m.a <= 0 && !m.want) marks.splice(i, 1);
      }
      // hover first, the open card's building over it; a building both hovered and open is drawn once, as open
      for (const m of marks) if (!m.sel && m.a > 0 && !(m.root === selRoot && m.want)) drawMark(ctx, m, s, dpr);
      for (const m of marks) if (m.sel && m.a > 0) drawMark(ctx, m, s, dpr);
      ctx.globalAlpha = 1;
      prevFrameS = s;
      stats.hlMs = stats.hlMs * 0.9 + (performance.now() - t0) * 0.1;
    },
  });

  app.on("pick-building", (p) => { if (p && p.index >= 0) select(p.index); });
  app.on("select-building", (p) => { if (p) select(p.index == null ? -1 : p.index); });
  app.on("card-close", (id) => { if (id === "building") select(-1); chromeSoon(); });
  app.on("card-open", chromeSoon);
  app.on("rotate", () => {
    // everything moves: start the labels afresh (the old picture fades over them meanwhile)
    for (const c of vis) { c.a = 0; c.on = false; }
    dirty = true;
  });
  app.on("layers", (p) => {
    if (p && p.id === "labels") { for (const c of vis) { c.a = 0; c.on = false; } dirty = true; }
    if (p && p.id === "sky") dirty = true;
  });

  // ---------------------------------------------------------------- search: named buildings
  function matchScore(qn, qt, n, words) {
    if (!n) return 0;
    if (n === qn) return 1;
    if (n.startsWith(qn)) return 0.9 - Math.min(0.1, (n.length - qn.length) * 0.004);
    if (n.includes(" " + qn)) return 0.78 - Math.min(0.1, (n.length - qn.length) * 0.003);
    // every word typed starts a word of the name, in any order
    for (const t of qt) { let ok = false; for (const w of words) if (w.startsWith(t)) { ok = true; break; } if (!ok) return 0; }
    return 0.64;
  }
  function searchBuildings(raw) {
    const qn = norm(raw);
    if (qn.length < 2) return [];
    const qt = qn.split(" ");
    const out = [];
    for (const e of searchIndex) {
      let m = matchScore(qn, qt, e.n, e.words);
      if (e.sn) m = Math.max(m, matchScore(qn, qt, e.sn, e.snWords) - 0.02);
      if (!m) continue;
      const land = Math.min(1, (e.boost - 1) / 8), size = Math.min(1, Math.log10(1 + e.A) / 4.5);
      const score = 0.46 * m + 0.26 * land + 0.1 * size + (e.campusy ? 0.06 : 0);
      out.push({
        label: e.name, sub: e.sub, kind: "building", score,
        go: () => {
          const phone = view.w < 640;
          view.flyTo({ x: e.x, y: e.y, z: e.h * 0.5 }, { m: clamp(Math.sqrt(e.A) * 6, 240, 900), offsetY: phone ? -view.h * 0.2 : 0 });
          app.emit("pick-building", { index: e.bi, building: B[e.bi], px: view.w / 2, py: view.h / 2 });
        },
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 8);
  }

  if (app.ui) {
    app.ui.registerToggle?.({ id: "labels", label: "Labels" });
    app.ui.addSearchProvider?.(searchBuildings);
  }

  // for tests and the console
  app.labels = {
    stats,
    counts: { buildings: buildingCand.size, areas: statics.length - buildingCand.size, streets: streets.length, curves: curves.length, pois: pois.length },
    highlight(i) { select(i); },
    hover(i) { hoverRoot = rootOf(i); setMark(false, hoverRoot); },
    shown() { return vis.filter((c) => c.on).map((c) => c.text); },
    /** on-screen building labels: [{ text, index, x, y }] (box centres, CSS px) */
    boxes() {
      const s = view.s, W2 = view.w / 2, H2 = view.h / 2;
      return vis.filter((c) => c.on && c.kind === K_BUILDING).map((c) => {
        const x = (c.X - view.X) * s + W2, y = (c.Y - view.Y) * s + H2;
        return { text: c.text, index: c.bi, x: x + (c.bx0 + c.bx1) / 2, y: y + (c.by0 + c.by1) / 2 };
      });
    },
    search: searchBuildings,
    trace(on) { const t = trace; trace = on ? [] : null; return t; },
    sceneState,
    /** average ms of a full placement at the current view, over n runs (robust to a busy machine: take the min of batches) */
    bench(n = 20) {
      let best = Infinity;
      for (let b = 0; b < 5; b++) { const t = performance.now(); for (let i = 0; i < n; i++) place(lastPlace); best = Math.min(best, (performance.now() - t) / n); }
      return best;
    },
  };
}
