// Campus events and game days.
//
// Campus events: the Office of Student Life calendar (GET api/events: proxy/events.mjs in development,
// functions/api/events.js on Cloudflare Pages; data/events.json, written by tools/fetch-events.mjs, on a static host).
// Each event's free-text location ("Ohio Union Maudine Cow Room", "Graves Hall 1187", "Main Oval", "53 W. 11th Ave.") is
// placed on a building, a named area or a point of interest of the map; what can't be placed is listed but not pinned.
// Today's events get a little flag on their building's roof (pulsing gently while they are on); a status chip counts
// them and opens the list; search finds them.
//
// Game days: Ohio State's home games at Ohio Stadium (football) and the Schottenstein Center (men's ice hockey, men's
// and women's basketball), from ESPN's public schedule API (CORS open, called directly). On a game day the venue gets a
// score chip and the status line the score, polled every 30 s while a game is on (ESPN's one-game scoreboard, ~2 KB).
// On the map: tailgate canopies with grills and smoke in the lots round the stadium from about five hours before
// kickoff, streams of fans walking to the venue on the footpaths in the last two hours, the stands filling with colour,
// the band on the field before kickoff and at halftime, light over the field at night, and the exodus after the final.
// Basketball and hockey bring crowds to the arena and a glow round it at night.
//
// Test switches: ?time=2026-11-28T10:30 (the real schedule, the clock simulated: scores are simulated too) ·
// ?gameday=football|hockey|basketball[&gamestate=pre|in|post] (a mock game today, its score changing) · ?events=mock.
//
// Layers: "gameday" (z 36: tents, fans, the crowd in the stands — under the night tint), "gameday-lights" (z 85:
// light over the field, the arena's glow), "events" (z 94: event flags) and "gameday-chip" (z 93: the score over the venue).

const TZ = "America/New_York";
const OSU = "194";
const SCARLET = "#b3202a", GRAY = "#6d6e71";
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/";
const DAY = 86400000, MIN = 60000, HOUR = 3600000;
// ESPN's edge turns headless browsers away (403, no CORS header): tests read the saved schedules instead
const ESPN_BLOCKED = typeof navigator !== "undefined" && /HeadlessChrome/.test(navigator.userAgent || "");

// Ohio State's sports that play on this map. segs: the game as it runs on the clock, [from min, to min, period (0 = a
// break), label]; plen: minutes in a period of play.
const SPORTS = {
  football: { path: "football/college-football", label: "Football", short: "Football", venue: "stadium", plen: 15,
    segs: [[0, 45, 1], [45, 95, 2], [95, 117, 0, "Halftime"], [117, 162, 3], [162, 208, 4]], pname: (p) => `Q${p}` },
  hockey: { path: "hockey/mens-college-hockey", label: "Men's ice hockey", short: "Hockey", venue: "arena", plen: 20,
    segs: [[0, 36, 1], [36, 54, 0, "1st intermission"], [54, 90, 2], [90, 108, 0, "2nd intermission"], [108, 144, 3]], pname: (p) => ["1st", "2nd", "3rd"][p - 1] || "OT" },
  mbb: { path: "basketball/mens-college-basketball", label: "Men's basketball", short: "Basketball", venue: "arena", plen: 20,
    segs: [[0, 52, 1], [52, 70, 0, "Halftime"], [70, 124, 2]], pname: (p) => (p === 1 ? "1st half" : p === 2 ? "2nd half" : "OT") },
  wbb: { path: "basketball/womens-college-basketball", label: "Women's basketball", short: "Basketball", venue: "arena", plen: 10,
    segs: [[0, 26, 1], [26, 52, 2], [52, 67, 0, "Halftime"], [67, 93, 3], [93, 120, 4]], pname: (p) => `Q${p}` },
};
for (const sp of Object.values(SPORTS)) sp.dur = sp.segs[sp.segs.length - 1][1];
// opponents' colours when ESPN's schedule leaves them out (the one-game scoreboard has them)
const TEAM_COLORS = { MICH: "#00274c", MSU: "#18453b", PSU: "#041e42", WIS: "#c5050c", WISC: "#c5050c", MINN: "#7a0019", IOWA: "#ffcd00",
  ILL: "#e84a27", IU: "#990000", PUR: "#ceb888", NU: "#4e2a84", NEB: "#e31937", MD: "#e03a3e", RUTG: "#cc0033", ORE: "#154733",
  UCLA: "#2d68c4", USC: "#990000", WASH: "#4b2e83", ND: "#0c2340", CONN: "#000e2f", AUSD: "#c8102e" };
const TEAM_ALT = { MICH: "#ffcb05", MSU: "#ffffff", PSU: "#ffffff", ND: "#c99700", IOWA: "#000000", PUR: "#000000" };

// ------------------------------------------------------------------------------------------------ small helpers
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const fin = (v) => typeof v === "number" && Number.isFinite(v);
function hash(s) { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let a = seed >>> 0 || 1; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const safeUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === "https:" || x.protocol === "http:" ? x.href : null; } catch { return null; } };
const hexOk = (c) => (typeof c === "string" && /^#?[0-9a-f]{6}$/i.test(c) ? (c[0] === "#" ? c : `#${c}`) : null);

function ringArea(f) { let a = 0; for (let i = 0, n = f.length; i < n; i += 2) { const j = (i + 2) % n; a += f[i] * f[j + 1] - f[j] * f[i + 1]; } return a / 2; }
function ringCentroid(f) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = f.length; i < n; i += 2) { const j = (i + 2) % n, c = f[i] * f[j + 1] - f[j] * f[i + 1]; a += c; cx += (f[i] + f[j]) * c; cy += (f[i + 1] + f[j + 1]) * c; }
  if (Math.abs(a) < 1e-9) { let x = 0, y = 0; const n = f.length / 2; for (let i = 0; i < f.length; i += 2) { x += f[i]; y += f[i + 1]; } return [x / n, y / n]; }
  return [cx / (3 * a), cy / (3 * a)];
}
function inRing(f, x, y) {
  let inside = false;
  for (let i = 0, n = f.length, j = n - 2; i < n; j = i, i += 2) {
    const xi = f[i], yi = f[i + 1], xj = f[j], yj = f[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function ringBox(f) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (let i = 0; i < f.length; i += 2) { if (f[i] < x0) x0 = f[i]; if (f[i] > x1) x1 = f[i]; if (f[i + 1] < y0) y0 = f[i + 1]; if (f[i + 1] > y1) y1 = f[i + 1]; } return [x0, y0, x1, y1]; }
// a point well inside a footprint: its centroid when that is inside, else the middle of the widest chord across it
function insidePoint(f) {
  const c = ringCentroid(f);
  if (inRing(f, c[0], c[1])) return c;
  const [x0, y0, x1, y1] = ringBox(f);
  let best = c, bw = -1;
  for (let k = 1; k < 12; k++) {
    const y = y0 + ((y1 - y0) * k) / 12, xs = [];
    for (let i = 0, n = f.length, j = n - 2; i < n; j = i, i += 2) {
      const yi = f[i + 1], yj = f[j + 1];
      if (yi > y !== yj > y) xs.push(f[i] + ((f[j] - f[i]) * (y - yi)) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    for (let q = 0; q + 1 < xs.length; q += 2) if (xs[q + 1] - xs[q] > bw) { bw = xs[q + 1] - xs[q]; best = [(xs[q] + xs[q + 1]) / 2, y]; }
  }
  return best;
}
// how far along the ray from (cx, cy) the ring is crossed last (−1: never)
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

function distToRing(f, x, y) {
  let best = Infinity;
  for (let i = 0, n = f.length, j = n - 2; i < n; j = i, i += 2) {
    const ax = f[j], ay = f[j + 1], ex = f[i] - ax, ey = f[i + 1] - ay, l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? clamp(((x - ax) * ex + (y - ay) * ey) / l2, 0, 1) : 0;
    const d = Math.hypot(x - ax - ex * t, y - ay - ey * t);
    if (d < best) best = d;
  }
  return best;
}
// convex hull of [x, y] points (monotone chain)
function hull(p) {
  p.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

// ------------------------------------------------------------------------------------------------ time in Columbus
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const wdFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" });
const dateFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" });
const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" });
const dayKey = (d) => dayFmt.format(d);
/** "8 pm", "7:45 am" */
function hm(d) {
  const s = timeFmt.format(d).replace(/\s?([AP])M$/i, (m, ap) => ` ${ap.toLowerCase()}m`);
  return s.replace(":00 ", " ");
}
function hmRange(a, b) {
  if (!b || b <= a) return hm(a);
  const A = hm(a), B = hm(b);
  const ap = A.slice(-2) === B.slice(-2) && dayKey(a) === dayKey(b) ? A.slice(0, -3) : A;
  return `${ap}–${B}`;
}
/** "Today", "Tomorrow", "Wed", "Wed, Dec 2" */
function dayName(d, now) {
  const k = dayKey(d), t = dayKey(now);
  if (k === t) return "Today";
  if (k === dayKey(new Date(now.getTime() + DAY))) return "Tomorrow";
  const diff = (d - now) / DAY;
  return diff > 0 && diff < 6 ? wdFmt.format(d) : dateFmt.format(d);
}

// ------------------------------------------------------------------------------------------------ place names
// Words that say nothing about which building: dropped from both the location and the names
const STOP = new Set(("the of and at for a an in on to by hall bldg building house center centre ctr room rooms rm floor fl level " +
  "lower upper basement suite ste lobby columbus oh ohio43210 usa campus main check schedule see various virtual online zoom tbd tba " +
  "location shared week advance pre registration required area outside inside near front entrance west east north south").split(" "));
// …but these stay in a name ("North Recreation Center", "South Oval"): they only drop from a location's loose words
const KEEP_IN_NAMES = new Set(["north", "south", "east", "west", "main"]);
const ORD = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth",
  "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth"];
const ORDN = new Map(ORD.map((w, i) => [w, i ? `${i}${i % 10 === 1 && i !== 11 ? "st" : i % 10 === 2 && i !== 12 ? "nd" : i % 10 === 3 && i !== 13 ? "rd" : "th"}` : ""]));
const ABBR = { bldg: "building", bld: "building", ctr: "center", cntr: "center", centre: "center", rec: "recreation", lib: "library",
  ave: "avenue", av: "avenue", rd: "road", dr: "drive", blvd: "boulevard", ln: "lane", pl: "place", ct: "court", pkwy: "parkway",
  w: "west", e: "east", n: "north", s: "south", lab: "laboratory", labs: "laboratory", laboratories: "laboratory", hosp: "hospital", aud: "auditorium",
  univ: "university", mt: "mount", theater: "theatre", amphitheater: "amphitheatre" };
/** normalised words of a place name or location, in order */
function words(s) {
  const raw = String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  if (!raw) return [];
  const out = raw.split(" ");
  for (let i = 0; i < out.length; i++) {
    let w = out[i];
    if (w === "st") w = i === 0 ? "saint" : "street";
    w = ABBR[w] || w;
    if (ORDN.has(w) && w) w = ORDN.get(w);
    out[i] = w;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ module
export async function init(app) {
  const { data, geo, view } = app;
  const UI = () => app.ui;
  const params = app.params;
  const B = data.buildings || [];
  const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");
  const reduced = () => reduceMQ.matches;
  const simulated = params.has("time") || params.has("speed");
  const speed = +params.get("speed") || 1;
  const dark = () => document.body && document.body.dataset.ui === "dark";

  injectStyle();

  // ============================================================================================== places
  // Every named building (one per name and neighbourhood: the biggest footprint), named area and point of interest,
  // with the words of its name; plus the short names people use.
  const places = [];
  const byName = new Map();
  const roofOf = (i) => {
    const b = B[i];
    let h = b.h || 0;
    if (b.hidden) {
      // drawn by its parts: the tallest part standing on it
      const f = b.p[0], [x0, y0, x1, y1] = ringBox(f);
      for (let j = 0; j < B.length; j++) {
        const q = B[j];
        if (!q.part || q === b || !q.p || !q.p[0]) continue;
        const qx = q.p[0][0], qy = q.p[0][1];
        if (qx < x0 - 1 || qx > x1 + 1 || qy < y0 - 1 || qy > y1 + 1) continue;
        const [cx, cy] = ringCentroid(q.p[0]);
        if (inRing(f, cx, cy)) h = Math.max(h, q.h || 0);
      }
    }
    return h;
  };
  const CAMPUSY = /university|college|dormitory|stadium|sports_centre|hospital|library|civic|public|museum|theatre|church|arts_centre/;
  function addPlace(p) {
    if (/^(the )?(ohio state( university)?|osu)$/i.test(p.name.trim())) return;   // the whole campus: no place to pin
    p.w = words(p.name);
    p.core = p.w.filter((w) => (!STOP.has(w) || KEEP_IN_NAMES.has(w)) && !/^\d+$/.test(w));
    if (!p.core.length) return;
    p.set = new Set(p.w);
    const key = p.w.join(" ");
    const prev = byName.get(key);
    if (prev && Math.hypot(prev.x - p.x, prev.y - p.y) < 250) { if (p.size > prev.size) Object.assign(prev, p); return; }
    byName.set(key, p);
    places.push(p);
  }
  for (let i = 0; i < B.length; i++) {
    const b = B[i];
    if (!b || !b.p || !b.p[0]) continue;
    const name = b.n || (b.lm === "Ohio Stadium" ? "Ohio Stadium" : null);
    if (!name || (b.part && !b.hidden)) continue;
    const [x, y] = insidePoint(b.p[0]);
    const area = Math.abs(ringArea(b.p[0]));
    const bonus = (CAMPUSY.test(`${b.k} ${b.am || ""}`) || b.lm ? 3 : 0) + Math.min(3, Math.log10(1 + area)) - (b.k === "parking" ? 5 : 0);
    addPlace({ kind: "building", name, i, x, y, z: null, size: area, bonus });
  }
  for (const a of data.areas || []) {
    if (!a || !a.n || !a.p || !a.p[0]) continue;
    // (not the campus, a district or a neighbourhood: a flag in its middle would say nothing)
    const area = Math.abs(ringArea(a.p[0]));
    if (area > 250000 || /^(the )?ohio state university\b/i.test(a.n)) continue;
    const [x, y] = insidePoint(a.p[0]);
    addPlace({ kind: "area", name: a.n, x, y, z: 0, size: area * 0.2, bonus: a.k === "park" || a.k === "plaza" || a.k === "water" ? 2.5 : 0.5 });
  }
  for (const p of data.pois || []) {
    if (!p || !p.n || !fin(p.x)) continue;
    addPlace({ kind: "poi", name: p.n, x: p.x, y: p.y, z: 0, size: 1, bonus: /theatre|library|museum|events_venue|arts|gallery|cinema/.test(p.k) ? 1 : -1 });
  }
  const placeByName = (n) => byName.get(words(n).join(" "));
  // the short names people use → the map's name
  const ALIASES = {
    "rpac": "Recreation & Physical Activity Center", "the union": "Ohio Union", "student union": "Ohio Union",
    "schott": "Schottenstein Center & Value City Arena", "schottenstein center": "Schottenstein Center & Value City Arena",
    "value city arena": "Schottenstein Center & Value City Arena", "thompson library": "William Oxley Thompson Memorial Library",
    "thompson": "William Oxley Thompson Memorial Library", "main library": "William Oxley Thompson Memorial Library",
    "the james": "James Cancer Hospital and Solove Research Institute", "james cancer hospital": "James Cancer Hospital and Solove Research Institute",
    "the wex": "Wexner Center for the Arts", "wexner center": "Wexner Center for the Arts", "north rec": "North Recreation Center",
    "jesse owens north": "Jesse Owens Recreation Center North", "jesse owens south": "Jesse Owens Recreation Center South",
    "jo north": "Jesse Owens Recreation Center North", "jo south": "Jesse Owens Recreation Center South",
    "the shoe": "Ohio Stadium", "horseshoe": "Ohio Stadium", "st john arena": "Saint John Arena", "saint john arena": "Saint John Arena",
    "main oval": "The Oval", "the oval": "The Oval", "student health center": "Wilce Student Health Center",
    "wilce": "Wilce Student Health Center", "wexner medical center": "University Hospital", "university hospital": "University Hospital",
    "mershon": "Mershon Auditorium", "sullivant": "Sullivant Hall", "fisher": "Fisher Hall", "18th ave library": "18th Avenue Library",
  };
  const aliasList = [];
  for (const [k, v] of Object.entries(ALIASES)) { const p = placeByName(v); if (p) aliasList.push({ w: words(k), p }); }
  // token → places whose name has it
  const tokenIndex = new Map();
  for (const p of places) for (const w of new Set(p.core)) { let a = tokenIndex.get(w); if (!a) tokenIndex.set(w, (a = [])); a.push(p); }
  // street addresses: "1385 Neil Avenue" → its building
  const addrIndex = new Map();
  const streetKey = (ws) => ws.filter((w) => !/^(west|east|north|south|columbus|oh|ohio|usa)$/.test(w) && !/^\d{5}$/.test(w)).join(" ");
  for (let i = 0; i < B.length; i++) {
    const b = B[i];
    if (!b || !b.a || !b.p || !b.p[0] || (b.part && !b.hidden)) continue;
    const m = /^\s*([\d,\s-]+?)\s+([A-Za-z].*)$/.exec(b.a);
    if (!m) continue;
    const st = streetKey(words(m[2]));
    const nums = [];
    for (const part of m[1].split(",")) {
      const r = part.trim().split("-").map((v) => +v);
      if (r.length === 2 && fin(r[0]) && fin(r[1]) && r[1] >= r[0] && r[1] - r[0] < 60) for (let n = r[0]; n <= r[1]; n += 2) nums.push(n);
      else if (fin(r[0])) nums.push(r[0]);
    }
    for (const n of nums) {
      const key = `${n} ${st}`;
      if (!addrIndex.has(key)) {
        const [x, y] = insidePoint(b.p[0]);
        addrIndex.set(key, { kind: "building", name: b.n || b.a, i, x, y, z: null, size: Math.abs(ringArea(b.p[0])), bonus: 0, addr: b.a });
      }
    }
  }
  const geoCache = new Map();
  /** a free-text location → a place on the map, or null */
  function geocode(loc) {
    const s = String(loc || "").trim();
    if (!s) return null;
    if (geoCache.has(s)) return geoCache.get(s);
    let res = null;
    if (!/^(various|virtual|online|zoom|tbd|tba|teams|microsoft teams|webex|remote)\b/i.test(s) && !/location (shared|tbd|tba)|registration required/i.test(s)) {
      // a street address
      const am = /(^|[^\d])(\d{1,5})\s+([A-Za-z0-9 .'-]+?)(?:,|\(|$)/.exec(s);
      if (am) res = addrIndex.get(`${+am[2]} ${streetKey(words(am[3]))}`) || null;
      if (!res) res = byWords(s);
    }
    if (res && res.z == null) res.z = res.i != null ? roofOf(res.i) : 0;
    geoCache.set(s, res);
    return res;
  }
  function byWords(s) {
    const L = words(s);
    if (!L.length) return null;
    const pos = new Map();
    L.forEach((w, k) => { if (!pos.has(w)) pos.set(w, k); });
    let best = null, bestScore = -Infinity;
    const consider = (p, score) => { if (score > bestScore || (score === bestScore && p.size > best.size)) { best = p; bestScore = score; } };
    // the short names
    for (const a of aliasList) {
      for (let k = 0; k + a.w.length <= L.length; k++) {
        let ok = true;
        for (let q = 0; q < a.w.length && ok; q++) ok = L[k + q] === a.w[q];
        // (a short name is a sure thing; of two, the one named first: "RPAC/North Rec" → RPAC)
        if (ok) { consider(a.p, 30 + a.w.length * 2 + Math.min(3, a.p.bonus) - k * 4); break; }
      }
    }
    // a whole name inside the location ("Graves Hall 1187", "Lower Level of Ohio Union")
    const seen = new Set();
    for (const w of pos.keys()) {
      const list = tokenIndex.get(w);
      if (!list || list.length > 400) continue;
      for (const p of list) {
        if (seen.has(p)) continue;
        seen.add(p);
        let first = Infinity, ok = true;
        for (const c of p.core) { const k = pos.get(c); if (k == null) { ok = false; break; } if (k < first) first = k; }
        if (ok) consider(p, p.core.length * 10 + p.bonus - first * 0.6);
      }
    }
    // a short form of a name ("Timashev Room 160" → Timashev Family Music Building, "Raney - Bolder Rm" → Raney House)
    const segs = String(s).split(/[\/,;()]|\s[-–—]\s/);
    let at = 0;
    for (const seg of segs) {
      const W = words(seg).filter((w) => !STOP.has(w) && !/^\d+[a-z]?$/.test(w) && w.length > 2);
      if (W.length) {
        const list = tokenIndex.get(W[0]);
        if (list && list.length <= 60) for (const p of list) {
          if (W.every((w) => p.set.has(w))) consider(p, W.length * 6 + p.bonus - at * 0.6 - (p.core.length - W.length) * 0.5);
        }
      }
      at += words(seg).length;
    }
    return bestScore > 5 ? best : null;
  }

  // ============================================================================================== campus events
  const events = { list: [], ok: false, source: "", fetched: null };
  let todayList = [], pins = [], pinKey = "";
  // (no extra request headers or cache modes: anything but a simple GET makes ESPN's CORS preflight fail)
  async function getJSON(url, ms = 15000) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(to); }
  }
  function parseEvents(j) {
    const out = [];
    const list = j && Array.isArray(j.events) ? j.events : [];
    const seen = new Set();
    for (const e of list) {
      if (!e || typeof e !== "object") continue;
      const title = typeof e.title === "string" ? e.title.trim().slice(0, 200) : "";
      const start = new Date(e.start);
      if (!title || !fin(start.getTime())) continue;
      let end = e.end ? new Date(e.end) : null;
      if (!end || !fin(end.getTime()) || end < start) end = new Date(start.getTime() + HOUR);
      const location = typeof e.location === "string" ? e.location.trim().slice(0, 200) : "";
      const key = `${title}|${start.getTime()}|${location}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: hash(key).toString(36), title, start, end, location, place: geocode(location),
        link: safeUrl(e.link), summary: typeof e.summary === "string" ? e.summary.slice(0, 600) : "",
        categories: Array.isArray(e.categories) ? e.categories.filter((c) => typeof c === "string").slice(0, 8) : [],
      });
    }
    out.sort((a, b) => a.start - b.start);
    return out;
  }
  let snapP = null;
  const snapshot = () => (snapP = snapP || getJSON("data/events.json").catch(() => null));
  async function loadEvents() {
    let j = null, source = "";
    if (params.get("events") === "mock") { j = mockEvents(); source = "mock"; }
    else {
      try { j = await getJSON("api/events"); source = "live"; if (!j || !Array.isArray(j.events)) throw new Error("no events"); }
      catch {
        j = await snapshot(); source = "snapshot";
        if (!j || !Array.isArray(j.events)) j = null;
      }
    }
    if (!j) { events.ok = false; refreshEvents(); return; }
    events.list = parseEvents(j);
    events.ok = true; events.source = source; events.fetched = j.fetched ? new Date(j.fetched) : new Date();
    refreshEvents(true);
  }
  // a handful of events round the real clock, for ?events=mock
  function mockEvents() {
    const n = app.now(), at = (h, m = 0) => { const d = new Date(n); d.setHours(h, m, 0, 0); return d.toISOString(); };
    const h = n.getHours();
    return { events: [
      { title: "World Music Showcase", start: at(h - 1), end: at(h + 1), location: "Timashev Room 160", link: "https://activities.osu.edu/", categories: ["Music"], summary: "Ohio State world music ensembles in concert." },
      { title: "Crafting Calm: A Self-Care Crafternoon", start: at(h + 2), end: at(h + 3), location: "Ohio Union Maudine Cow Room", categories: ["Health and Wellness"], summary: "" },
      { title: "H2O Coffee Tent", start: at(h - 2), end: at(h + 2), location: "Main Oval", categories: ["Food"], summary: "Coffee on the Oval." },
      { title: "Who's That Pokemon", start: at(h + 4), end: at(h + 5), location: "Graves Hall 1187", categories: ["Social"], summary: "" },
      { title: "Esports Trading Card Game Night", start: at(h + 5), end: at(h + 7), location: "Esports Arena - Lincoln Tower 210", categories: ["Gaming"], summary: "" },
      { title: "Career Studios Drop-In", start: at(h - 1), end: at(h + 4), location: "Various", categories: [], summary: "" },
    ] };
  }
  const evEnd = (e) => e.end || new Date(e.start.getTime() + HOUR);
  /** recompute today's events and the pins (every half minute, and when the list changes) */
  function refreshEvents(changed = false) {
    const now = app.now(), t = now.getTime(), today = dayKey(now);
    todayList = events.list.filter((e) => evEnd(e).getTime() > t - 30 * MIN && (dayKey(e.start) === today || (e.start.getTime() <= t && evEnd(e).getTime() > t)));
    // one pin per place
    const by = new Map();
    for (const e of todayList) {
      if (!e.place || evEnd(e).getTime() <= t) continue;
      const k = `${Math.round(e.place.x)},${Math.round(e.place.y)}`;
      let p = by.get(k);
      if (!p) by.set(k, (p = { place: e.place, list: [], now: false, next: Infinity }));
      p.list.push(e);
      if (e.start.getTime() <= t) p.now = true;
      p.next = Math.min(p.next, e.start.getTime());
    }
    const next = [...by.values()];
    const key = next.map((p) => `${p.place.x},${p.place.y},${p.now ? 1 : 0},${p.list.length}`).join("|");
    if (key !== pinKey || changed) { pinKey = key; pins = next; app.requestRender("events"); }
    updateEventStatus();
    if (changed) refreshOpenEventCard();
  }
  function updateEventStatus() {
    const ui = UI();
    if (!ui || !ui.status) return;
    if (!app.layerEnabled("events") || !events.ok) { ui.status("events", ""); ui.setCount && ui.setCount("events", ""); return; }
    const t = app.now().getTime();
    const left = todayList.filter((e) => evEnd(e).getTime() > t).length;
    const n = todayList.length;
    ui.setCount && ui.setCount("events", n ? String(n) : "");
    const label = n ? `${n} event${n === 1 ? "" : "s"} today` : "Campus events";
    const title = n ? `${left} still to come or on now · click for the list` : "No campus events today · click for what's coming up";
    ui.status("events", `<button type="button" class="ev-st-btn" data-ev="list" title="${esc(title)}"><span class="ev-st-flag" aria-hidden="true"></span>${esc(label)}</button>`);
  }

  // ---------------------------------------------------------------- pins
  const PIN = [];          // per frame: { p, x, y, top } in CSS px, for hit tests
  let hoverPin = null;
  // The pulse round an event that is on is a CSS animation on a little element over the map, not canvas frames: the
  // map stays idle (no redraws) while it breathes. Drawing the pins only moves the elements along with the map.
  const fx = document.createElement("div");
  fx.className = "ev-fx"; fx.setAttribute("aria-hidden", "true");
  (app.canvas && app.canvas.parentNode ? app.canvas.parentNode : document.body).insertBefore(fx, app.canvas ? app.canvas.nextSibling : null);
  const pulses = new Map();   // pin place name → element
  let pulseSeen = new Set();
  function placePulse(p, x, y, far) {
    const key = p.place.name + p.place.x;
    let el = pulses.get(key);
    if (!el) { el = document.createElement("span"); el.className = "ev-pulse"; el.style.animationDelay = `${-(hash(key) % 2400)}ms`; fx.append(el); pulses.set(key, el); }
    const tr = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) scale(${far ? 0.6 : 1})`;
    if (el._tr !== tr) { el.style.transform = tr; el._tr = tr; }
    if (el.hidden) el.hidden = false;
    pulseSeen.add(key);
  }
  function hidePulses(all) {
    for (const [k, el] of pulses) if ((all || !pulseSeen.has(k)) && !el.hidden) el.hidden = true;
    pulseSeen.clear();
  }
  function drawPins(ctx, f) {
    PIN.length = 0;
    if (!pins.length) { hidePulses(true); return; }
    const s = view.s, w = view.w, h = view.h;
    const far = s < 0.32;
    const pole = far ? 0 : clamp(11 + s * 2.4, 14, 24);
    ctx.save();
    ctx.lineCap = "round";
    // back to front, so nearer flags overlap farther ones
    const r = view.rot, list = pins.slice().sort((a, b) => geo.depth(b.place.x, b.place.y, r) - geo.depth(a.place.x, a.place.y, r));
    for (const p of list) {
      const [gx, gy] = pinSpot(p.place, r);
      const [px, py] = view.groundToScreen(gx, gy, p.place.z || 0);
      if (px < -40 || px > w + 40 || py < -60 || py > h + 40) continue;
      const hot = hoverPin === p;
      PIN.push({ p, x: px, y: py, top: py - pole - 14 });
      // the pulse: a ring on the roof, spreading and fading, while something is on (see placePulse)
      if (p.now) placePulse(p, px, py, far);
      if (far) {
        ctx.beginPath(); ctx.arc(px, py - 3, hot ? 5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = p.now ? SCARLET : "#fbf8f1"; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = p.now ? "#fbf8f1" : SCARLET; ctx.stroke();
        continue;
      }
      // a foot on the roof, the pole, the pennant (waving a little), all with a pale halo so they read on any roof
      ctx.beginPath(); ctx.ellipse(px, py, 3.5, 1.8, 0, 0, Math.PI * 2); ctx.fillStyle = "rgba(40,30,25,.4)"; ctx.fill();
      const top = py - pole - (hot ? 2 : 0);
      const fw = hot ? 16 : 14, fh = hot ? 11 : 10;
      const wave = p.now ? 0.8 : 0.3;
      const flag = () => {
        ctx.beginPath();
        ctx.moveTo(px, top);
        ctx.quadraticCurveTo(px + fw * 0.5, top - 1 + wave, px + fw, top + fh * 0.5 + wave * 0.6);
        ctx.quadraticCurveTo(px + fw * 0.5, top + fh * 0.5 + 1 + wave, px, top + fh);
        ctx.closePath();
      };
      ctx.strokeStyle = "rgba(255,252,245,.85)"; ctx.lineWidth = 3.4;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, top - 1); ctx.stroke();
      flag(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, top - 1);
      ctx.strokeStyle = "#4a4038"; ctx.lineWidth = 1.5; ctx.stroke();
      flag();
      ctx.fillStyle = p.now ? SCARLET : "#fbf8f1"; ctx.fill();
      ctx.strokeStyle = p.now ? "#7d141b" : SCARLET; ctx.lineWidth = 1.2; ctx.stroke();
      if (p.list.length > 1) {
        ctx.font = "600 9px Inter, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = p.now ? "#fff" : SCARLET;
        ctx.fillText(String(p.list.length), px + fw * 0.42, top + fh * 0.5 + 0.5);
      }
      // the time beside it, close up
      if (s >= 1.6 || hot) {
        const txt = p.now ? "now" : hm(new Date(p.next));
        ctx.font = "600 10.5px Inter, system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        const tw = ctx.measureText(txt).width;
        const bx = px + fw + 4, by = top + fh * 0.5;
        ctx.fillStyle = dark() ? "rgba(38,35,32,.9)" : "rgba(251,248,241,.92)";
        roundRect(ctx, bx - 3, by - 7, tw + 6, 14, 4); ctx.fill();
        ctx.fillStyle = p.now ? SCARLET : "#3a352e";
        if (dark()) ctx.fillStyle = p.now ? "#ff8a8f" : "#e6dfd2";
        ctx.fillText(txt, bx, by + 0.5);
      }
    }
    ctx.restore();
    hidePulses(false);
  }
  // Where on its roof a flag stands: off to the right of the middle, where the building's name label isn't (per turn).
  function pinSpot(pl, r) {
    if (pl.i == null) return [pl.x, pl.y];
    pl.spot = pl.spot || [];
    if (pl.spot[r]) return pl.spot[r];
    const f = B[pl.i].p[0], o = geo.ROTS[r];
    let best = -Infinity, bx = pl.x, by = pl.y;
    for (let k = 0; k < f.length; k += 2) { const u = (f[k] - pl.x) * o.R[0] + (f[k + 1] - pl.y) * o.R[1]; if (u > best) { best = u; bx = f[k]; by = f[k + 1]; } }
    let spot = [pl.x, pl.y];
    for (const t of [0.55, 0.4, 0.25]) { const x = pl.x + (bx - pl.x) * t, y = pl.y + (by - pl.y) * t; if (inRing(f, x, y)) { spot = [x, y]; break; } }
    return (pl.spot[r] = spot);
  }
  function hitPin(px, py) {
    for (let k = PIN.length - 1; k >= 0; k--) {
      const q = PIN[k];
      if (px > q.x - 8 && px < q.x + 22 && py > q.top - 4 && py < q.y + 5) return q.p;
    }
    return null;
  }

  // ---------------------------------------------------------------- cards
  let openEventCard = null, eventCardH = null;   // { place|null, ids }
  function eventItemHTML(e, now, withTitle) {
    const on = e.start <= now && evEnd(e) > now;
    const when = `${dayName(e.start, now)} · ${hmRange(e.start, evEnd(e))}`;
    const cats = e.categories.filter((c) => !/^(students|faculty|alumni|general public|parents|graduate)/i.test(c)).slice(0, 4);
    return `<div class="ev-item">` +
      (withTitle ? `<h4 class="ev-t">${esc(e.title)}</h4>` : "") +
      `<div class="ev-when">${on ? `<span class="ev-now">On now</span>` : ""}${esc(when)}</div>` +
      (e.location ? `<div class="ev-loc">${esc(e.location)}</div>` : "") +
      (e.summary ? `<p class="ev-sum">${esc(e.summary.length > 280 ? `${e.summary.slice(0, 270).replace(/\s+\S*$/, "")}…` : e.summary)}</p>` : "") +
      (cats.length ? `<div class="ev-tags">${cats.map((c) => `<span>${esc(c)}</span>`).join("")}</div>` : "") +
      (e.link ? `<a class="ev-link" href="${esc(e.link)}" target="_blank" rel="noopener noreferrer">Event details<span aria-hidden="true"> ↗</span></a>` : "") +
      `</div>`;
  }
  function openPlaceCard(place, list, fly, refresh = false) {
    const ui = UI();
    if (!ui || !ui.card) return;
    const now = app.now();
    list = list.slice().sort((a, b) => a.start - b.start);
    const one = list.length === 1;
    const title = one ? list[0].title : place ? place.name : "Campus events";
    const sub = one ? (place ? place.name : "Place not on the map") : `${list.length} events today`;
    const body = `<div class="ev-card">${list.map((e) => eventItemHTML(e, now, !one)).join("")}` +
      `<p class="ev-src">From the Office of Student Life calendar${events.source === "snapshot" ? " (saved copy)" : events.source === "mock" ? " (test data)" : ""}.</p></div>`;
    if (refresh && eventCardH && eventCardH.open) { eventCardH.update({ title, subtitle: sub, body }); return; }
    openEventCard = { place, ids: list.map((e) => e.id) };
    eventCardH = ui.card({ id: "event", title, subtitle: sub, color: SCARLET, body, anchor: place ? { x: place.x, y: place.y, z: place.z || 0 } : null, onClose: () => { openEventCard = null; eventCardH = null; } });
    if (fly && place && ui.flyTo) ui.flyTo(place.x, place.y, Math.max(260, Math.min(700, view.w / Math.max(0.5, view.s))), { z: place.z || 0 });
  }
  function refreshOpenEventCard() {
    if (!openEventCard) return;
    const list = events.list.filter((e) => openEventCard.ids.includes(e.id));
    if (list.length) openPlaceCard(openEventCard.place, list, false, true);
  }
  function openList() {
    const ui = UI();
    if (!ui || !ui.card) return;
    const now = app.now(), t = now.getTime();
    const rows = [];
    const row = (kind, key, when, title, sub, on) => `<li><button type="button" class="ev-row" data-ev="${kind}" data-key="${esc(key)}">` +
      `<span class="ev-row-when${on ? " on" : ""}">${esc(when)}</span><span class="ev-row-main"><span class="ev-row-t">${esc(title)}</span>` +
      `<span class="ev-row-sub">${esc(sub)}</span></span></button></li>`;
    // home games this week
    const soon = games.filter((g) => g.date.getTime() + (g.sp.dur + 60) * MIN > t && g.date.getTime() - t < 8 * DAY).slice(0, 3);
    if (soon.length) {
      rows.push(`<h4 class="ev-h">Game days</h4><ul class="ev-list">`);
      for (const g of soon) rows.push(row("game", g.id, `${dayName(g.date, now)}`, gameTitle(g), `${g.sp.label} · ${hm(g.date)} · ${g.venueName}`, stateOf(g, now).state === "in"));
      rows.push(`</ul>`);
    }
    if (!events.ok) rows.push(`<p class="ev-empty">The campus calendar can't be reached right now.</p>`);
    else {
      rows.push(`<h4 class="ev-h">Today</h4>`);
      if (!todayList.length) rows.push(`<p class="ev-empty">Nothing on the calendar for the rest of today.</p>`);
      else {
        rows.push(`<ul class="ev-list">`);
        for (const e of todayList) {
          const on = e.start.getTime() <= t && evEnd(e).getTime() > t, over = evEnd(e).getTime() <= t;
          rows.push(row("event", e.id, on ? "Now" : over ? "Ended" : hm(e.start), e.title, e.place ? e.place.name : e.location || "Place to be announced", on));
        }
        rows.push(`</ul>`);
      }
      const later = events.list.filter((e) => e.start.getTime() > t && dayKey(e.start) !== dayKey(now)).slice(0, 14);
      if (later.length) {
        rows.push(`<h4 class="ev-h">Coming up</h4><ul class="ev-list">`);
        for (const e of later) rows.push(row("event", e.id, `${dayName(e.start, now)} ${hm(e.start)}`, e.title, e.place ? e.place.name : e.location || "", false));
        rows.push(`</ul>`);
      }
      rows.push(`<p class="ev-src">From the <a href="https://activities.osu.edu/Events.aspx" target="_blank" rel="noopener noreferrer">Office of Student Life calendar</a>${events.source === "snapshot" ? " (saved copy)" : ""}. Events whose place isn't on the map are listed without a flag.</p>`);
    }
    const n = todayList.length;
    ui.card({ id: "events-list", title: "Campus events", subtitle: `${dateFmt.format(now)} · ${n ? `${n} today` : "none today"}`, color: SCARLET, body: `<div class="ev-card">${rows.join("")}</div>`, anchor: null });
  }
  function openEventById(id) {
    const e = events.list.find((x) => x.id === id);
    if (!e) return;
    openPlaceCard(e.place, [e], true);
  }
  // clicks on the status chip and in the list (their HTML is rebuilt freely, so one listener on the document)
  document.addEventListener("click", (ev) => {
    const b = ev.target && ev.target.closest && ev.target.closest(".ev-st-btn[data-ev], .ev-row[data-ev]");
    if (!b) return;
    const k = b.dataset.ev;
    if (k === "list") openList();
    else if (k === "event") openEventById(b.dataset.key);
    else if (k === "game") { const g = games.find((x) => x.id === b.dataset.key); if (g) openGameCard(g, true); }
  });

  // ---------------------------------------------------------------- search
  function searchEvents(q) {
    const W = words(q).filter((w) => w.length > 1);
    if (!W.length) return [];
    const out = [];
    const now = app.now(), t = now.getTime();
    for (const e of events.list) {
      if (evEnd(e).getTime() < t) continue;
      const tw = words(e.title), hay = new Set([...tw, ...words(e.location), ...e.categories.flatMap(words), ...(e.place ? words(e.place.name) : [])]);
      let hit = 0;
      for (const w of W) if ([...hay].some((h) => h.startsWith(w))) hit++;
      if (hit < W.length) continue;
      const inTitle = W.every((w) => tw.some((h) => h.startsWith(w)));
      const soon = Math.max(0, 1 - (e.start.getTime() - t) / (7 * DAY));
      out.push({ label: e.title, sub: `${dayName(e.start, now)} ${hm(e.start)} · ${e.place ? e.place.name : e.location || "campus"}`, kind: "event",
        score: clamp((inTitle ? 0.5 : 0.32) + soon * 0.15, 0, 0.7), key: `event|${e.id}`, go: () => openPlaceCard(e.place, [e], true) });
      if (out.length >= 6) break;
    }
    if (/^(game|games|football|hockey|basket|score|tailgat|kickoff|michigan|buckeyes|osu)/.test(W[0])) {
      const g = games.find((x) => x.date.getTime() + (x.sp.dur + 90) * MIN > t);
      if (g) out.push({ label: gameTitle(g), sub: `${g.sp.label} · ${dayName(g.date, now)} ${hm(g.date)} · ${g.venueName}`, kind: "event", score: 0.62, key: `game|${g.id}`, go: () => openGameCard(g, true) });
    }
    return out;
  }

  // ============================================================================================== game days
  // the venues on the map
  const findB = (pred) => { for (let i = 0; i < B.length; i++) if (B[i] && B[i].p && B[i].p[0] && pred(B[i])) return i; return -1; };
  const venues = {};
  {
    const si = findB((b) => b.lm === "Ohio Stadium") >= 0 ? findB((b) => b.lm === "Ohio Stadium") : findB((b) => b.k === "stadium" && b.p.length > 1 && Math.abs(ringArea(b.p[0])) > 30000);
    if (si >= 0) {
      const b = B[si], [x, y] = ringCentroid(b.p[0]);
      venues.stadium = { key: "stadium", i: si, name: "Ohio Stadium", x, y, z: b.h || 36, h: b.h || 36 };
    }
    const ai = findB((b) => b.lm === "schott" || /schottenstein center|value city arena/i.test(b.n || ""));
    if (ai >= 0) {
      const b = B[ai], [x, y] = insidePoint(b.p[0]);
      venues.arena = { key: "arena", i: ai, name: "Value City Arena", x, y, z: b.h || 26, h: b.h || 26 };
    }
  }
  const games = [];    // home games on the map, by date
  let gamesState = "loading";
  const gameTitle = (g) => `${g.away.name} at ${g.home.name}`;
  function parseSchedule(j, key) {
    const sp = SPORTS[key], out = [];
    for (const e of (j && j.events) || []) {
      try {
        const c = e.competitions && e.competitions[0];
        if (!c || c.neutralSite) continue;
        const home = c.competitors.find((t) => t.homeAway === "home"), away = c.competitors.find((t) => t.homeAway === "away");
        if (!home || !away || String(home.id) !== OSU) continue;
        const vn = (c.venue && c.venue.fullName) || "";
        const venue = sp.venue === "stadium" ? (/ohio stadium/i.test(vn) ? "stadium" : null) : /schottenstein|value city/i.test(vn) ? "arena" : null;
        if (!venue || !venues[venue]) continue;
        const date = new Date(e.date);
        if (!fin(date.getTime())) continue;
        const team = (t) => ({ id: String(t.id), abbr: String(t.team.abbreviation || "").slice(0, 6), name: String(t.team.location || t.team.shortDisplayName || "").slice(0, 40),
          full: String(t.team.displayName || "").slice(0, 60), color: hexOk(t.team.color) || TEAM_COLORS[t.team.abbreviation] || "#5b6470",
          alt: hexOk(t.team.alternateColor) || TEAM_ALT[t.team.abbreviation] || "#d9d4c8", score: t.score != null ? +(t.score.value ?? t.score) : null });
        const st = c.status && c.status.type ? c.status.type : {};
        const tv = (c.broadcasts || []).map((b) => (b.media && b.media.shortName) || (b.names && b.names[0])).filter(Boolean)[0] || "";
        const link = safeUrl(((e.links || []).find((l) => /^https:\/\/www\.espn\.com\//.test(l.href)) || {}).href);
        const g = { id: String(e.id), key, sp, date, timeValid: e.timeValid !== false, venue, venueName: vn || venues[venue].name,
          home: team(home), away: team(away), tv: String(tv).slice(0, 20), link, state: st.state || "pre", detail: st.shortDetail || st.detail || "",
          live: false, sim: false, endAt: null, polled: 0 };
        g.home.color = SCARLET; g.home.alt = "#a7a9ac";
        out.push(g);
      } catch { /* an odd event: skip it */ }
    }
    return out;
  }
  async function loadGames() {
    const mock = params.get("gameday");
    if (mock && /^(football|hockey|basketball|mbb|wbb)$/.test(mock)) { games.push(mockGame(mock)); gamesState = "ok"; afterGames(); return; }
    // a trimmed copy is kept for a few hours: the schedules are ~35 KB each over the wire
    const CK = "small-osu-games-v1";
    try {
      const c = JSON.parse(localStorage.getItem(CK) || "null");
      // (not on a game day: scores and states move then, and the live poll only covers the hours round a game)
      const gameDay = c && Array.isArray(c.games) && c.games.some((g) => Math.abs(Date.parse(g.date) - Date.now()) < 14 * HOUR);
      if (c && Date.now() - c.t < 6 * HOUR && Array.isArray(c.games) && !gameDay) {
        for (const g of c.games) games.push(Object.assign(g, { sp: SPORTS[g.key], date: new Date(g.date) }));
        gamesState = "ok"; afterGames(); return;
      }
    } catch { /* no storage */ }
    const keys = Object.keys(SPORTS);
    const res = ESPN_BLOCKED ? keys.map(() => ({ status: "rejected" })) : await Promise.allSettled(keys.map((k) => getJSON(`${ESPN}${SPORTS[k].path}/teams/${OSU}/schedule`, 20000)));
    let any = false, live = 0;
    for (let n = 0; n < keys.length; n++) {
      let j = res[n].status === "fulfilled" ? res[n].value : null;
      if (j) live++;
      // ESPN unreachable: the snapshot tools/fetch-events.mjs saved (same shape)
      if (!j) { const snap = await snapshot(); j = snap && snap.games && snap.games[keys[n]]; }
      if (j) { any = true; games.push(...parseSchedule(j, keys[n])); }
    }
    games.sort((a, b) => a.date - b.date);
    gamesState = any ? "ok" : "failed";
    if (live === keys.length) {
      try { localStorage.setItem(CK, JSON.stringify({ t: Date.now(), games: games.map(({ sp, ...g }) => g) })); } catch { /* full or blocked */ }
    }
    afterGames();
  }
  function mockGame(kind) {
    const key = kind === "basketball" ? "mbb" : kind;
    const sp = SPORTS[key], now = app.now();
    const want = params.get("gamestate");
    let K;
    if (want === "pre") K = now.getTime() + 75 * MIN;
    else if (want === "in") K = now.getTime() - (key === "football" ? 70 : 40) * MIN;
    else if (want === "post") K = now.getTime() - (sp.dur + 12) * MIN;
    else { const d = new Date(now); d.setHours(key === "football" ? 12 : 19, 0, 0, 0); K = d.getTime(); }
    const opp = key === "football" ? { abbr: "MICH", name: "Michigan", full: "Michigan Wolverines" } : key === "hockey" ? { abbr: "MSU", name: "Michigan State", full: "Michigan State Spartans" } : { abbr: "PSU", name: "Penn State", full: "Penn State Nittany Lions" };
    const mockFinal = { football: [31, 24], hockey: [4, 2], mbb: [78, 72], wbb: [75, 68] }[key];
    return { id: `mock-${key}`, key, sp, mockFinal, date: new Date(K), timeValid: true, venue: sp.venue, venueName: sp.venue === "stadium" ? "Ohio Stadium" : "Value City Arena",
      home: { id: OSU, abbr: "OSU", name: "Ohio State", full: "Ohio State Buckeyes", color: SCARLET, alt: "#a7a9ac", score: null },
      away: { id: "0", ...opp, color: TEAM_COLORS[opp.abbr] || "#5b6470", alt: TEAM_ALT[opp.abbr] || "#d9d4c8", score: null },
      tv: key === "football" ? "FOX" : "BTN", link: null, state: "pre", detail: "", live: false, sim: true, mock: true, endAt: null, polled: 0 };
  }

  // ---------------------------------------------------------------- the state of a game at a moment
  // From the clock (the game's usual length, its breaks), unless ESPN's live state says otherwise. Scores of a game
  // played on a simulated clock (or a mock game) are simulated: a seeded run of scoring plays.
  const ST = { state: "none", period: 0, clockText: "", detail: "", elapsed: 0, half: false, endAt: 0, sim: false };
  function stateOf(g, now) {
    const t = now.getTime(), K = g.date.getTime(), sp = g.sp;
    const o = ST;
    o.sim = false; o.half = false; o.period = 0; o.clockText = ""; o.elapsed = (t - K) / MIN;
    const realLive = !simulated && !g.mock && g.live;
    if (realLive && g.state === "in") {
      o.state = "in"; o.detail = g.detail; o.period = g.period || 0; o.half = /half|intermission|end of/i.test(g.detail);
      o.endAt = Math.max(K + sp.dur * MIN, t + 10 * MIN);
      return o;
    }
    if (realLive && g.state === "post") {
      o.state = "post"; o.detail = g.detail || "Final"; o.endAt = g.endAt || Math.min(t, K + sp.dur * MIN);
      return o;
    }
    if (!simulated && !g.mock && g.state === "post" && t > K) {
      o.state = "post"; o.detail = g.detail || "Final"; o.endAt = g.endAt || K + sp.dur * MIN;
      return o;
    }
    const el = o.elapsed;
    o.endAt = K + sp.dur * MIN;
    if (el < 0) { o.state = "pre"; o.detail = `${hm(g.date)}${g.tv ? ` · ${g.tv}` : ""}`; return o; }
    if (el >= sp.dur) { o.state = "post"; o.detail = "Final"; o.sim = simulated || !!g.mock; return o; }
    // In play by the clock. On the real clock without live data (ESPN out of reach) the scene still runs from the
    // usual timings, but nothing is made up for the reader: no clock, no score.
    o.state = "in"; o.sim = simulated || !!g.mock;
    for (const [a, b, p, label] of sp.segs) {
      if (el < a || el >= b) continue;
      if (!p) { o.half = true; o.detail = label; o.period = 0; break; }
      o.period = p;
      const left = sp.plen * (1 - (el - a) / (b - a));
      const m = Math.floor(left), s = Math.floor((left - m) * 60);
      o.clockText = `${m}:${String(s).padStart(2, "0")}`;
      o.detail = `${sp.pname(p)} · ${o.clockText}`;
      break;
    }
    if (!o.sim) { o.detail = "In progress"; o.clockText = ""; }
    return o;
  }
  // a seeded run of scoring plays: [minute of the game, home points, away points]*
  const playsCache = new Map();
  function playsOf(g) {
    let P = playsCache.get(g.id);
    if (P) return P;
    const R = rng(hash(g.id) ^ 0x5eed), sp = g.sp;
    P = [];
    const inPlay = sp.segs.filter((s) => s[2]);
    const pick = () => { const sg = inPlay[Math.floor(R() * inPlay.length)]; return sg[0] + R() * (sg[1] - sg[0]); };
    const homeEdge = 0.6;
    const [fh, fa] = g.mockFinal || [g.home.score, g.away.score];
    if (g.mockFinal || (g.state === "post" && fin(fh) && fin(fa))) {
      // Build scoring plays that add up to the example final or the recorded result.
      const split = (total, side) => {
        let left = total;
        const unit = g.key === "football" ? [7, 3, 2] : g.key === "hockey" ? [1] : [2, 3, 2, 1];
        while (left > 0) {
          let u = unit[Math.floor(R() * unit.length)];
          if (g.key === "football" && left % 7 !== 0 && left % 3 === 0) u = 3;
          if (u > left) u = left >= 3 && g.key === "football" ? 3 : left >= 2 && g.key !== "hockey" ? 2 : 1;
          if (g.key === "football" && left - u === 1) u = left;
          P.push(side ? [pick(), 0, u] : [pick(), u, 0]);
          left -= u;
        }
      };
      split(fh, 0); split(fa, 1);
    } else if (g.key === "football") {
      const n = 6 + Math.floor(R() * 6);
      for (let k = 0; k < n; k++) { const pts = R() < 0.72 ? 7 : 3; P.push(R() < homeEdge ? [pick(), pts, 0] : [pick(), 0, pts]); }
    } else if (g.key === "hockey") {
      const n = 3 + Math.floor(R() * 5);
      for (let k = 0; k < n; k++) P.push(R() < homeEdge ? [pick(), 1, 0] : [pick(), 0, 1]);
    } else {
      // a basket every half minute or so of play
      // (about 140 points a game: a basket every minute and a half or so of the game's running time)
      for (const [a, b] of inPlay) for (let m = a + R() * 1.5; m < b; m += 0.9 + R() * 1.4) {
        const pts = R() < 0.3 ? 3 : R() < 0.15 ? 1 : 2;
        P.push(R() < 0.52 ? [m, pts, 0] : [m, 0, pts]);
      }
    }
    P.sort((a, b) => a[0] - b[0]);
    playsCache.set(g.id, P);
    return P;
  }
  /** [home, away], or null before the start (and on the real clock when no score is known). Note: stateOf fills one
   * shared object; scoreOf calls it again for the same game and moment, which leaves the caller's copy as it was. */
  function scoreOf(g, now) {
    const st = stateOf(g, now);
    if (st.state === "pre" || st.state === "none") return null;
    const real = fin(g.home.score) && fin(g.away.score);
    if (!st.sim) return real ? [g.home.score, g.away.score] : null;
    // a game already played, watched on a simulated clock: its real final once it is over
    if (st.state === "post" && g.state === "post" && real) return [g.home.score, g.away.score];
    const el = st.state === "post" ? Infinity : st.elapsed;
    let h = 0, a = 0;
    for (const p of playsOf(g)) { if (p[0] > el) break; h += p[1]; a += p[2]; }
    return [h, a];
  }

  // ---------------------------------------------------------------- live polling (real clock only)
  let pollTimer = 0;
  async function poll() {
    pollTimer = 0;
    const now = app.now(), t = now.getTime();
    let next = 5 * MIN;
    for (const g of games) {
      if (g.mock || simulated) continue;
      const K = g.date.getTime();
      const near = t > K - 3 * HOUR && t < K + (g.sp.dur + 150) * MIN;
      if (!near || (g.state === "post" && g.live)) continue;
      const due = t > K - 20 * MIN && t < K + (g.sp.dur + 120) * MIN;
      if (!due && g.polled) continue;   // before the game: once is enough (colours, TV)
      if (document.hidden && g.polled) { next = Math.min(next, 30000); continue; }
      try {
        const j = await getJSON(`${ESPN}${g.sp.path}/scoreboard/${g.id}`, 12000);
        const c = j && j.competitions && j.competitions[0];
        if (c) {
          const st = c.status || {}, ty = st.type || {};
          const was = g.state;
          g.state = ty.state || g.state; g.detail = ty.shortDetail || ty.detail || g.detail; g.period = +st.period || 0;
          for (const t2 of c.competitors || []) {
            const side = t2.homeAway === "home" ? g.home : t2.homeAway === "away" ? g.away : null;
            if (!side) continue;
            if (t2.score != null && t2.score !== "") side.score = +t2.score;
            if (side !== g.home) { side.color = hexOk(t2.team && t2.team.color) || side.color; side.alt = hexOk(t2.team && t2.team.alternateColor) || side.alt; }
          }
          g.live = g.state === "in" || g.state === "post";
          if (g.state === "post" && was !== "post" && !g.endAt) g.endAt = Date.now() < K + g.sp.dur * MIN ? Date.now() : Math.min(Date.now(), K + (g.sp.dur + 30) * MIN);
          g.polled = Date.now();
          gameChanged();
        }
      } catch { g.polled = g.polled || 1; }
      if (due && g.state !== "post") next = Math.min(next, 30000);
    }
    pollTimer = setTimeout(poll, next);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && pollTimer) { clearTimeout(pollTimer); poll(); } });

  // ---------------------------------------------------------------- which games matter now
  let active = [];     // games whose day it is (one per venue), most relevant first
  let lastGameKey = "";
  function refreshGames() {
    const now = app.now(), t = now.getTime(), today = dayKey(now);
    const byVenue = new Map();
    for (const g of games) {
      const K = g.date.getTime(), st = stateOf(g, now);
      const end = st.endAt || K + g.sp.dur * MIN;
      const on = (dayKey(g.date) === today && t < end + 4 * HOUR) || (t > K - 7 * HOUR && t < end + 3 * HOUR);
      if (!on) continue;
      const rank = st.state === "in" ? 0 : st.state === "pre" ? 1 : 2;
      const cur = byVenue.get(g.venue);
      if (!cur || rank < cur.rank || (rank === cur.rank && Math.abs(K - t) < Math.abs(cur.g.date.getTime() - t))) byVenue.set(g.venue, { g, rank });
    }
    active = [...byVenue.values()].sort((a, b) => a.rank - b.rank).map((v) => v.g);
    gameChanged();
  }
  function gameChanged() {
    const now = app.now();
    const key = active.map((g) => { const s = scoreOf(g, now); const st = stateOf(g, now); return `${g.id}:${st.state}:${st.detail}:${s ? s.join("-") : ""}`; }).join("|");
    if (key === lastGameKey) return;
    lastGameKey = key;
    updateGameStatus();
    chipCache.clear();
    app.requestRender("gameday");
    if (openGame) { const g = games.find((x) => x.id === openGame); if (g) openGameCard(g, false, true); }
  }
  function scoreLine(g, sc, html = true) {
    const A = g.away, H = g.home;
    const e = html ? esc : (s) => s;
    return sc ? `${e(A.abbr)} ${sc[1]}–${sc[0]} ${e(H.abbr)}` : `${e(A.name)} at ${e(H.name)}`;
  }
  function updateGameStatus() {
    const ui = UI();
    if (!ui || !ui.status) return;
    const g = active[0];
    if (!g || !app.layerEnabled("gameday")) { ui.status("game", ""); return; }
    const now = app.now(), st = stateOf(g, now), sc = scoreOf(g, now);
    let html;
    const dot = st.state === "in" ? `<span class="gd-live" aria-hidden="true"></span>` : "";
    if (st.state === "pre") html = `<span class="long">${esc(g.sp.short)}:</span>${esc(g.away.abbr || g.away.name)} at ${esc(g.home.abbr)} <span class="gd-mute">${esc(dayName(g.date, now) === "Today" ? hm(g.date) : `${dayName(g.date, now)} ${hm(g.date)}`)}</span>`;
    else if (st.state === "in") html = `${scoreLine(g, sc)} <span class="gd-mute">${esc(st.detail.replace(" · ", " "))}</span>`;
    else html = `${sc ? scoreLine(g, sc) : esc(gameTitle(g))} <span class="gd-mute">Final</span>`;
    ui.status("game", `<button type="button" class="ev-st-btn gd-st" data-ev="game" data-key="${esc(g.id)}">${dot}${html}</button>`);
  }

  // ---------------------------------------------------------------- the game card
  let openGame = null, gameCardH = null;
  // refresh: patch the open card in place (new score), without opening it again (which would slide the map to it)
  function openGameCard(g, fly, refresh = false) {
    const ui = UI();
    if (!ui || !ui.card) return;
    const now = app.now(), st = stateOf(g, now), sc = scoreOf(g, now);
    const v = venues[g.venue];
    const side = (T, s) => `<div class="gd-team"><span class="gd-sw" style="--c:${esc(T.color)};--c2:${esc(T.alt)}"></span><span class="gd-name">${esc(T.name)}</span><span class="gd-score">${s == null ? "" : esc(s)}</span></div>`;
    const status = st.state === "pre" ? `${dayName(g.date, now)} · ${hm(g.date)}${g.tv ? ` · ${esc(g.tv)}` : ""}` : st.state === "in" ? `<span class="gd-live" aria-hidden="true"></span>${esc(st.detail)}` : "Final";
    const K = g.date.getTime(), t = now.getTime();
    let note = "";
    if (g.key === "football") {
      if (st.state === "pre") note = t < K - 5 * HOUR ? "Tailgates fill the lots round the stadium from about five hours before kickoff." : t < K - 2 * HOUR ? "Tailgates are going in the lots round the stadium; the crowds start heading in about two hours before kickoff." : "Fans are streaming into the Horseshoe.";
      else if (st.state === "in") note = st.half ? "Halftime: the band is on the field." : "The Horseshoe is full.";
      else note = "The crowds are heading home.";
    } else {
      note = st.state === "pre" ? "Fans head to the arena in the hour before the start." : st.state === "in" ? "The arena is full." : "The crowd is heading out.";
    }
    const simNote = st.sim && (simulated || g.mock) ? `<p class="gd-sim">${g.mock ? "A mock game for testing" : "The clock is simulated"}: the score is made up.</p>` : "";
    const body = `<div class="gd-card"><div class="gd-board">${side(g.away, sc ? sc[1] : null)}${side(g.home, sc ? sc[0] : null)}</div>` +
      `<div class="gd-status">${status}</div><p class="gd-note">${esc(note)}</p>${simNote}` +
      (g.link ? `<a class="ev-link" href="${esc(g.link)}" target="_blank" rel="noopener noreferrer">Game page on ESPN<span aria-hidden="true"> ↗</span></a>` : "") +
      `<p class="ev-src">Schedule and scores: ESPN. Unofficial.</p></div>`;
    if (refresh && gameCardH && gameCardH.open && openGame === g.id) { gameCardH.update({ body }); return; }
    openGame = g.id;
    gameCardH = ui.card({ id: "game", title: gameTitle(g), subtitle: `${g.sp.label} · ${g.venueName}`, color: SCARLET, body,
      anchor: v ? { x: v.x, y: v.y, z: v.h } : null, onClose: () => { openGame = null; gameCardH = null; } });
    if (fly && v && ui.flyTo) ui.flyTo(v.x, v.y, g.venue === "stadium" ? 700 : 520, { z: 10 });
  }

  // ---------------------------------------------------------------- the score chip over the venue
  const chipCache = new Map();    // game id → { cv, w, h, key }
  const CHIPS = [];               // per frame: { g, x0, y0, x1, y1 }
  function chipCanvas(g, now) {
    const st = stateOf(g, now), sc = scoreOf(g, now);
    const line2 = st.state === "pre" ? (dayKey(g.date) === dayKey(now) ? `${g.sp.short} · ${hm(g.date)}` : `${dayName(g.date, now)} ${hm(g.date)}`) : st.state === "in" ? st.detail : "Final";
    const key = `${sc ? sc.join("-") : ""}|${line2}|${dark() ? 1 : 0}|${view.dpr}`;
    const c = chipCache.get(g.id);
    if (c && c.key === key) return c;
    const dpr = view.dpr, cv = c ? c.cv : document.createElement("canvas");
    const cx = cv.getContext("2d");
    const F1 = "600 12px Inter, system-ui, sans-serif", F2 = "500 10.5px Inter, system-ui, sans-serif";
    cx.font = F1;
    const parts = sc ? [[g.away, String(sc[1])], [g.home, String(sc[0])]] : [[g.away, ""], [g.home, ""]];
    let w1 = 0;
    for (const [T, s] of parts) w1 += 10 + cx.measureText(T.abbr || T.name).width + (s ? 6 + cx.measureText(s).width : 0) + 10;
    cx.font = F2;
    const w2 = cx.measureText(line2).width;
    const W = Math.ceil(Math.max(w1 + 8, w2 + 20)), H = 38;
    cv.width = Math.ceil((W + 4) * dpr); cv.height = Math.ceil((H + 10) * dpr);
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = dark() ? "#262320" : "#fbf8f1", ink = dark() ? "#f2ecdf" : "#2a2622", mute = dark() ? "#a3998a" : "#685f53", line = dark() ? "#3b352d" : "#e3dac2";
    cx.shadowColor = "rgba(40,30,20,.25)"; cx.shadowBlur = 6; cx.shadowOffsetY = 2;
    cx.fillStyle = bg; roundRect(cx, 2, 2, W, H, 9); cx.fill();
    cx.shadowColor = "transparent";
    cx.strokeStyle = line; cx.lineWidth = 1; roundRect(cx, 2.5, 2.5, W - 1, H - 1, 8.5); cx.stroke();
    // the pointer under it
    cx.beginPath(); cx.moveTo(2 + W / 2 - 5, 2 + H - 0.5); cx.lineTo(2 + W / 2, 2 + H + 6); cx.lineTo(2 + W / 2 + 5, 2 + H - 0.5); cx.fillStyle = bg; cx.fill();
    cx.beginPath(); cx.moveTo(2 + W / 2 - 5, 2 + H); cx.lineTo(2 + W / 2, 2 + H + 6); cx.lineTo(2 + W / 2 + 5, 2 + H); cx.strokeStyle = line; cx.stroke();
    let x = 2 + (W - w1) / 2 + 4;
    cx.textBaseline = "middle"; cx.font = F1;
    for (const [T, s] of parts) {
      cx.fillStyle = T.color; roundRect(cx, x, 9, 6, 10, 2); cx.fill();
      x += 10;
      cx.fillStyle = ink; cx.fillText(T.abbr || T.name, x, 14.5);
      x += cx.measureText(T.abbr || T.name).width;
      if (s) { cx.font = "700 12px Inter, system-ui, sans-serif"; x += 6; cx.fillText(s, x, 14.5); x += cx.measureText(s).width; cx.font = F1; }
      x += 10;
    }
    cx.font = F2; cx.fillStyle = st.state === "in" ? (dark() ? "#ff8a8f" : SCARLET) : mute; cx.textAlign = "center";
    cx.fillText(line2, 2 + W / 2, 29);
    cx.textAlign = "left";
    const out = { cv, w: W + 4, h: H + 10, key };
    chipCache.set(g.id, out);
    return out;
  }
  function drawChips(ctx, f) {
    CHIPS.length = 0;
    if (!active.length) return;
    const now = f.now;
    for (const g of active) {
      const v = venues[g.venue];
      if (!v) continue;
      const st = stateOf(g, now);
      if (st.state === "post" && now.getTime() > st.endAt + 3 * HOUR) continue;
      const [px, py] = view.groundToScreen(v.x, v.y, v.h + 6);
      const c = chipCanvas(g, now);
      const x0 = Math.round(px - c.w / 2), y0 = Math.round(py - c.h - 8 - Math.min(40, view.s * 8));
      if (x0 > view.w || y0 > view.h || x0 + c.w < 0 || y0 + c.h < 0) continue;
      ctx.drawImage(c.cv, x0, y0, c.w, c.h);
      CHIPS.push({ g, x0, y0, x1: x0 + c.w, y1: y0 + c.h });
    }
  }

  // ============================================================================================== the game-day scene
  // Built for a venue the first time a game there needs it (walk-graph routes, the bowl's stands, the tailgate lots),
  // then animated from the game's clock: how many tents stand, how many fans walk in or out, how full the stands are.
  const { SIN_T, COS_T } = geo;
  let PA = 0, PB = 0, PC = 0, PD = 0, PE = 0, PF = 0, PK = 0, D0 = 0, D1 = 0, ROT = 0, SC = 1, VW = 1, VH = 1;
  function camera() {
    const o = geo.ROTS[view.rot], s = view.s;
    ROT = view.rot; SC = s; VW = view.w; VH = view.h; D0 = o.D[0]; D1 = o.D[1];
    PA = s * o.R[0]; PB = s * o.R[1]; PC = -s * SIN_T * o.D[0]; PD = -s * SIN_T * o.D[1];
    PE = VW / 2 - view.X * s; PF = VH / 2 - view.Y * s; PK = s * COS_T;
  }
  const sx = (x, y) => PA * x + PB * y + PE;
  const sy = (x, y, z) => PC * x + PD * y + PF - PK * z;

  // ---------------------------------------------------------------- the footpaths, and the way to a venue from anywhere
  let WG = null;
  function walkGraph() {
    if (WG) return WG;
    const wk = data.walk;
    if (!wk || !wk.nodes || !wk.edges) return (WG = { N: 0 });
    const N = wk.nodes.length / 2, deg = new Int32Array(N + 1);
    for (const e of wk.edges) { deg[e[0]]++; deg[e[1]]++; }
    const adj0 = new Int32Array(N + 1);
    for (let i = 0; i < N; i++) adj0[i + 1] = adj0[i] + deg[i];
    const fill = adj0.slice(0, N), adj = new Int32Array(adj0[N]);
    wk.edges.forEach((e, k) => { adj[fill[e[0]]++] = k; adj[fill[e[1]]++] = k; });
    return (WG = { N, nodes: wk.nodes, edges: wk.edges, adj0, adj });
  }
  // shortest walks to the venue's doors (every footpath node within 30 m outside its outline): next node and edge
  function treeTo(ring, maxD) {
    const G = walkGraph(), N = G.N;
    // (doubles: a float32 copy of a key would compare as smaller than the key itself and stall the search)
    const dist = new Float64Array(N).fill(Infinity), next = new Int32Array(N).fill(-1), via = new Int32Array(N).fill(-1);
    if (!N) return { dist, next, via, gates: [] };
    const [x0, y0, x1, y1] = ringBox(ring), nd = G.nodes, gates = [];
    const hk = [], hn = [];   // a binary heap of (key, node), stale entries skipped
    const push = (k, n) => { let i = hk.length; hk.push(k); hn.push(n); while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= hk[i]) break; [hk[p], hk[i]] = [hk[i], hk[p]]; [hn[p], hn[i]] = [hn[i], hn[p]]; i = p; } };
    const pop = () => {
      const k = hk[0], n = hn[0], lk = hk.pop(), ln = hn.pop();
      if (hk.length) { hk[0] = lk; hn[0] = ln; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < hk.length && hk[l] < hk[m]) m = l; if (r < hk.length && hk[r] < hk[m]) m = r; if (m === i) break; [hk[m], hk[i]] = [hk[i], hk[m]]; [hn[m], hn[i]] = [hn[i], hn[m]]; i = m; } }
      return [k, n];
    };
    for (let i = 0; i < N; i++) {
      const x = nd[2 * i], y = nd[2 * i + 1];
      if (x < x0 - 30 || x > x1 + 30 || y < y0 - 30 || y > y1 + 30 || inRing(ring, x, y)) continue;
      const d = distToRing(ring, x, y);
      if (d < 30) { dist[i] = d; push(d, i); gates.push(i); }
    }
    while (hk.length) {
      const [du, u] = pop();
      if (du > dist[u]) continue;
      if (du > maxD) break;
      for (let q = G.adj0[u]; q < G.adj0[u + 1]; q++) {
        const e = G.edges[G.adj[q]], v = e[0] === u ? e[1] : e[0];
        const nv = du + e[2];
        if (nv < dist[v]) { dist[v] = nv; next[v] = u; via[v] = G.adj[q]; push(nv, v); }
      }
    }
    return { dist, next, via, gates };
  }
  // the walk from node a to the venue as a polyline (and its running length), ending a few metres inside the door
  function routeFrom(T, a, cx, cy) {
    const G = walkGraph(), nd = G.nodes, pts = [nd[2 * a], nd[2 * a + 1]];
    let u = a, guard = 0;
    while (T.next[u] >= 0 && guard++ < 4000) {
      const e = G.edges[T.via[u]], p = e[3];
      if (e[0] === u) for (let q = 2; q < p.length; q += 2) pts.push(p[q], p[q + 1]);
      else for (let q = p.length - 4; q >= 0; q -= 2) pts.push(p[q], p[q + 1]);
      u = T.next[u];
    }
    const lx = pts[pts.length - 2], ly = pts[pts.length - 1], dl = Math.hypot(cx - lx, cy - ly) || 1;
    pts.push(lx + ((cx - lx) / dl) * 7, ly + ((cy - ly) / dl) * 7);
    return withLengths(Float32Array.from(pts));
  }
  function withLengths(P) {
    const n = P.length / 2, cum = new Float32Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(P[2 * i] - P[2 * i - 2], P[2 * i + 1] - P[2 * i - 1]);
    return { P, cum, L: cum[n - 1] };
  }
  function reversed(R) {
    const n = R.P.length / 2, Q = new Float32Array(R.P.length);
    for (let i = 0; i < n; i++) { Q[2 * i] = R.P[2 * (n - 1 - i)]; Q[2 * i + 1] = R.P[2 * (n - 1 - i) + 1]; }
    return withLengths(Q);
  }

  // ---------------------------------------------------------------- the stands of the Horseshoe (as render.js builds them)
  function obbOf(f) {
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
  function buildBowl(v) {
    const b = B[v.i];
    let inner = null, ia = 0;
    for (let q = 1; q < b.p.length; q++) { const a = Math.abs(ringArea(b.p[q])); if (a > ia) { ia = a; inner = b.p[q]; } }
    if (!inner || ia < 400) return null;
    const TAU = Math.PI * 2, outer = b.p[0], [cx, cy] = ringCentroid(inner), N = 112;
    const rin = new Float64Array(N), rout = new Float64Array(N), dx = new Float64Array(N), dy = new Float64Array(N);
    for (let j = 0; j < N; j++) { dx[j] = Math.cos((j / N) * TAU); dy[j] = Math.sin((j / N) * TAU); rin[j] = rayFar(inner, cx, cy, dx[j], dy[j]); rout[j] = rayFar(outer, cx, cy, dx[j], dy[j]); }
    const fillGaps = (arr) => { let good = -1; for (let j = 0; j < N; j++) if (arr[j] > 0) { good = j; break; } if (good < 0) { arr.fill(10); return; } for (let s = 1; s <= N; s++) { const j = (good + s) % N; if (!(arr[j] > 0)) arr[j] = arr[(j + N - 1) % N]; } };
    const smoothRing = (arr, passes) => { const tmp = new Float64Array(N); for (let p = 0; p < passes; p++) { for (let j = 0; j < N; j++) tmp[j] = (arr[(j + N - 1) % N] + 2 * arr[j] + arr[(j + 1) % N]) / 4; arr.set(tmp); } };
    fillGaps(rin); fillGaps(rout); smoothRing(rout, 2); smoothRing(rin, 1);
    for (let j = 0; j < N; j++) if (rout[j] < rin[j] + 10) rout[j] = rin[j] + 10;
    const fo = obbOf(inner), shoe = b.lm === "Ohio Stadium";
    const H = b.h, rim = H - Math.min(5, H * 0.18), zw = Math.min(2.4, rim * 0.12);
    const R1 = new Float64Array(N), Z1 = new Float64Array(N), Z2 = new Float64Array(N), R2 = new Float64Array(N);
    for (let j = 0; j < N; j++) {
      const span = rout[j] - rin[j], side = Math.abs(Math.sin((j / N) * TAU - fo.ang)), rimW = Math.min(5, span * 0.1);
      R1[j] = rin[j] + (span - rimW) * (shoe ? 0.48 : 0.55);
      Z1[j] = zw + (rim - zw) * (shoe ? 0.4 : 0.5);
      const riser = shoe ? 1.4 + 5.2 * side * side : (1 + 1.5 * side * side) * Math.min(1, rim / 20);
      Z2[j] = Math.min(rim - 2, Z1[j] + riser);
      R2[j] = rout[j] - rimW;
    }
    const P = (j, r, z) => [cx + dx[j] * r, cy + dy[j] * r, z];
    // the away end: the upper deck of the closed (south) end
    const ax = Math.cos(fo.ang), ay = Math.sin(fo.ang), nDir = ay >= 0 ? [ax, ay] : [-ax, -ay];
    const quads = [];
    for (let j = 0; j < N; j++) {
      const j2 = (j + 1) % N, mx = (dx[j] + dx[j2]) / 2, my = (dy[j] + dy[j2]) / 2, ml = Math.hypot(mx, my), ux = mx / ml, uy = my / ml;
      const south = ux * -nDir[0] + uy * -nDir[1] > 0.975;
      quads.push({ j, tier: 0, ux, uy, slope: Math.atan2(Z1[j] - zw, R1[j] - rin[j]), pts: [...P(j, rin[j], zw), ...P(j2, rin[j2], zw), ...P(j2, R1[j2], Z1[j2]), ...P(j, R1[j], Z1[j])], away: false });
      quads.push({ j, tier: 1, ux, uy, slope: Math.atan2(rim - Z2[j], R2[j] - R1[j]), pts: [...P(j, R1[j], Z2[j]), ...P(j2, R1[j2], Z2[j2]), ...P(j2, R2[j2], rim), ...P(j, R2[j], rim)], away: shoe && south });
    }
    for (const q of quads) { q.seed = (hash(`${q.j}:${q.tier}`) % 1000) / 1000; q.depth0 = 0; }
    const rimLoop = new Float64Array(N * 3);
    for (let j = 0; j < N; j++) rimLoop.set(P(j, R2[j], rim), 3 * j);
    // what stands up inside the opening: the press box (west side), the scoreboard (south), the rotunda (north)
    const occ = [];
    if (shoe) {
      const box = (x, y, ang, hx, hy, z0, z1) => { const c = Math.cos(ang), s = Math.sin(ang), out = []; for (const [u, w] of [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]) for (const z of [z0, z1]) out.push(x + u * c - w * s, y + u * s + w * c, z); return out; };
      const wDir = -ay > 0 ? [-ay, ax] : [ay, -ax], west = wDir[0] < 0 ? wDir : [-wDir[0], -wDir[1]];
      const rW = rayFar(outer, cx, cy, west[0], west[1]);
      if (rW > 0) {
        const tx = -west[1], ty = west[0], pts = [];
        for (let s = 0; s < 6; s++) {
          const along = -48 + 16 * (s + 0.5), px = cx + west[0] * (rW - 7) + tx * along, py = cy + west[1] * (rW - 7) + ty * along;
          const a = Math.atan2(py - cy, px - cx), jj = ((Math.round((a / TAU) * N) % N) + N) % N, rr = rout[jj] - 6.5;
          pts.push(...box(cx + dx[jj] * rr, cy + dy[jj] * rr, Math.atan2(ty, tx), 8.3, 3.6, rim - 5, H - 0.6));
        }
        occ.push(pts);
      }
      const sDir = [-nDir[0], -nDir[1]], rS = rayFar(outer, cx, cy, sDir[0], sDir[1]);
      if (rS > 0) occ.push(box(cx + sDir[0] * (rS - 4), cy + sDir[1] * (rS - 4), Math.atan2(sDir[0], -sDir[1]), 17, 0.9, rim - 2, H - 0.5));
      const rN = rayFar(outer, cx, cy, nDir[0], nDir[1]);
      if (rN > 0) {
        const rx = cx + nDir[0] * (rN - 6.5), ry = cy + nDir[1] * (rN - 6.5), pts = [];
        for (let k = 0; k < 12; k++) { const a = (k / 12) * TAU; for (const z of [0, rim + 2.6]) pts.push(rx + Math.cos(a) * 9, ry + Math.sin(a) * 9, z); }
        occ.push(pts);
      }
    }
    // the field (the pitch mapped inside the bowl), for the band and the teams
    let field = null;
    for (const a of data.areas || []) {
      if (!a || a.k !== "pitch" || !a.p || !a.p[0]) continue;
      const [fx, fy] = ringCentroid(a.p[0]);
      if (!inRing(inner, fx, fy)) continue;
      const o = obbOf(a.p[0]);
      if (o && o.L > 60) { field = { cx: o.cx, cy: o.cy, ux: Math.cos(o.ang), uy: Math.sin(o.ang), L: Math.min(o.L, 110), W: Math.min(o.W, 49) }; break; }
    }
    if (!field) field = { cx: fo.cx, cy: fo.cy, ux: Math.cos(fo.ang), uy: Math.sin(fo.ang), L: Math.min(fo.L * 0.8, 110), W: Math.min(fo.W * 0.7, 49) };
    return { cx, cy, N, quads, rimLoop, occ, field, rot: [] };
  }
  // the stands seen from rotation r: the seat faces turned to the camera, far to near
  function bowlFaces(bw, r) {
    if (bw.rot[r]) return bw.rot[r];
    const o = geo.ROTS[r], list = [];
    for (const q of bw.quads) {
      const sn = Math.sin(q.slope), cs = Math.cos(q.slope), nx = -q.ux * sn, ny = -q.uy * sn;
      if ((nx * o.D[0] + ny * o.D[1]) * COS_T - cs * SIN_T >= 0) continue;
      let d = 0;
      for (let k = 0; k < 12; k += 3) d += q.pts[k] * o.D[0] + q.pts[k + 1] * o.D[1];
      list.push({ q, depth: d / 4 });
    }
    list.sort((a, b) => b.depth - a.depth);
    return (bw.rot[r] = list.map((x) => x.q));
  }

  // ---------------------------------------------------------------- the crowd's colours
  const FANS = [["#b3202a", 34], ["#9c1b25", 10], ["#c8343c", 6], ["#8d9095", 11], ["#5f6268", 6], ["#efeee8", 8], ["#2a2b30", 10], ["#3b4660", 4], ["#c9c3b5", 3]];
  const FAN_N = FANS.length;   // + 2 slots for the visitors' colours
  const fanCols = FANS.map((c) => c[0]).concat(["#00274c", "#ffcb05"]);
  const fanCum = []; { let s = 0; for (const [, w] of FANS) fanCum.push((s += w)); }
  function pickFan(R, awayShare) {
    if (R() < awayShare) return FAN_N + (R() < 0.6 ? 0 : 1);
    const v = R() * fanCum[fanCum.length - 1];
    for (let i = 0; i < fanCum.length; i++) if (v < fanCum[i]) return i;
    return 0;
  }
  function setAwayColours(g) { fanCols[FAN_N] = g.away.color || "#00274c"; fanCols[FAN_N + 1] = g.away.alt || "#d9d4c8"; }

  // a speckled crowd, for the stands (rebuilt when the zoom moves on by half a pixel per person)
  let crowdPat = null, crowdPatKey = "";
  function crowdPattern(ctx, s, away) {
    const d = clamp(Math.round(0.5 * s * 2) / 2, 1, 4), key = `${d}|${view.dpr}|${fanCols[FAN_N]}|${fanCols[FAN_N + 1]}`;
    if (crowdPat && crowdPatKey === key) return away ? crowdPat.away : crowdPat.home;
    const make = (awayEnd) => {
      const dpr = view.dpr, n = 18, cell = d * 1.2, size = Math.ceil(n * cell);
      const cv = document.createElement("canvas");
      cv.width = Math.ceil(size * dpr); cv.height = Math.ceil(size * dpr);
      const c = cv.getContext("2d");
      c.scale(dpr, dpr);
      c.fillStyle = awayEnd ? "#3a3f4c" : "#6e2328"; c.fillRect(0, 0, size, size);
      const R = rng(awayEnd ? 77 : 11);
      for (let yy = 0; yy < n; yy++) for (let xx = 0; xx < n; xx++) {
        const i = awayEnd ? (R() < 0.75 ? FAN_N + (R() < 0.55 ? 0 : 1) : pickFan(R, 0)) : pickFan(R, 0.015);
        c.fillStyle = fanCols[i];
        c.fillRect(xx * cell + (yy & 1 ? cell * 0.5 : 0) + (R() - 0.5) * cell * 0.3, yy * cell, d, d * 1.15);
      }
      const p = ctx.createPattern(cv, "repeat");
      if (p && p.setTransform && typeof DOMMatrix === "function") p.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, 0, 0]));
      return p;
    };
    crowdPat = { home: make(false), away: make(true) };
    crowdPatKey = key;
    return away ? crowdPat.away : crowdPat.home;
  }

  // ---------------------------------------------------------------- a venue's scene
  const scenes = {};
  // built outside the frames (a few hundred ms of path search and sampling): null until it is ready
  const building = new Set();
  function sceneOf(vk) {
    if (scenes[vk] !== undefined) return scenes[vk];
    if (!building.has(vk)) {
      building.add(vk);
      const go = () => { try { buildScene(vk); } catch (e) { console.warn("[events] scene", e); scenes[vk] = null; } app.requestRender("gameday"); };
      if (typeof requestIdleCallback === "function") requestIdleCallback(go, { timeout: 400 }); else setTimeout(go, 0);
    }
    return null;
  }
  function buildScene(vk) {
    const v = venues[vk];
    if (!v) return (scenes[vk] = null);
    const t0 = performance.now();
    const ring = B[v.i].p[0];
    const S = { v, ring, tree: treeTo(ring, vk === "stadium" ? 1700 : 1300), routes: new Map(), bowl: vk === "stadium" ? buildBowl(v) : null, tents: null, src: null, srcCum: null, glow: null };
    // tailgates: canopies on a loose grid in the lots round the stadium
    if (vk === "stadium") {
      const R = rng(1870), cand = [];
      const lots = (data.areas || []).filter((a) => a && a.k === "parking" && a.p && a.p[0] && Math.abs(ringArea(a.p[0])) > 500);
      for (const a of lots) {
        const [lx, ly] = ringCentroid(a.p[0]);
        const dist = Math.hypot(lx - v.x, ly - v.y);
        if (dist > 1150) continue;
        const keep = dist < 450 ? 0.75 : dist < 750 ? 0.5 : 0.28;
        const [x0, y0, x1, y1] = ringBox(a.p[0]);
        for (let y = y0 + 4; y < y1 - 3; y += 8.5) for (let x = x0 + 4; x < x1 - 3; x += 8.5) {
          if (R() > keep) continue;
          const tx = x + (R() - 0.5) * 3, ty = y + (R() - 0.5) * 3;
          if (!inRing(a.p[0], tx, ty) || inRing(ring, tx, ty)) continue;
          const u = R();
          const col = u < 0.42 ? 0 : u < 0.62 ? 1 : u < 0.8 ? 2 : u < 0.9 ? 3 : 4;
          const n = 2 + Math.floor(R() * 5), ppl = [];
          for (let k = 0; k < n; k++) { const a2 = R() * Math.PI * 2, rr = 2 + R() * 2.4; ppl.push(tx + Math.cos(a2) * rr, ty + Math.sin(a2) * rr, pickFan(R, 0.04)); }
          cand.push({ x: tx, y: ty, col, ppl, grill: R() < 0.32, flag: R() < 0.16, up: R(), down: R(), seed: R() * 10, occR: -1, occ: 0, size: 3 + R() * 0.9, pick: R() * (0.4 + dist / 700) });
        }
      }
      // at most 800, spread over every lot (a random draw favouring the nearer ones, not the first lots in the data)
      cand.sort((a, b) => a.pick - b.pick);
      S.tents = cand.slice(0, 800);
    }
    // where fans walk from: anywhere 200 m – 1.5 km out, most from the lots (the tailgates, the garages) and the streets
    const T = S.tree, G = walkGraph(), nd = G.nodes || [], src = [], cum = [];
    const lotCells = new Set(), CELL = 70, ck = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
    for (const a of data.areas || []) if (a && a.k === "parking" && a.p && a.p[0]) { const [lx, ly] = ringCentroid(a.p[0]); if (Math.hypot(lx - v.x, ly - v.y) < 1700) lotCells.add(ck(lx, ly)); }
    let acc = 0;
    const dMin = vk === "stadium" ? 200 : 120, dMax = vk === "stadium" ? 1400 : 1100;
    for (let i = 0; i < (G.N || 0); i++) {
      const d = T.dist[i];
      if (!(d >= dMin && d <= dMax)) continue;
      const x = nd[2 * i], y = nd[2 * i + 1];
      // more from the lots, and more from nearer (the crowd thickens toward the gates)
      let w = 1.6 - d / dMax;
      for (let a = -1; a <= 1 && w < 2; a++) for (let b = -1; b <= 1; b++) if (lotCells.has(ck(x + a * CELL, y + b * CELL))) { w *= 4; break; }
      src.push(i); cum.push((acc += w));
    }
    S.src = src; S.srcCum = cum;
    S.ms = performance.now() - t0;
    return (scenes[vk] = S);
  }
  function routeOf(S, out, R) {
    if (!S.src.length) return null;
    const v = R() * S.srcCum[S.srcCum.length - 1];
    let lo = 0, hi = S.srcCum.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (S.srcCum[m] < v) lo = m + 1; else hi = m; }
    const a = S.src[lo], key = out ? -1 - a : a;
    let r = S.routes.get(key);
    if (!r) {
      let rin = S.routes.get(a);
      if (!rin) { rin = routeFrom(S.tree, a, S.v.x, S.v.y); S.routes.set(a, rin); }
      r = out ? reversed(rin) : rin;
      if (out) S.routes.set(key, r);
      if (S.routes.size > 1600) S.routes.clear();
    }
    return r.L > 20 ? r : null;
  }

  // ---------------------------------------------------------------- the fans walking (one pool for both venues)
  const CAP = 2400;
  const fR = new Array(CAP), fS = new Float32Array(CAP), fK = new Int32Array(CAP), fV = new Float32Array(CAP), fLat = new Float32Array(CAP);
  const fCol = new Uint8Array(CAP), fX = new Float32Array(CAP), fY = new Float32Array(CAP), fVen = new Uint8Array(CAP), fOut = new Uint8Array(CAP);
  const fOcc = new Uint8Array(CAP), fOccT = new Float32Array(CAP), fPh = new Float32Array(CAP);
  let nFans = 0;
  const VEN = ["stadium", "arena"];
  const fanR = rng(4242);
  function spawn(S, vi, out, seeded) {
    if (nFans >= CAP) return false;
    const r = routeOf(S, out, fanR);
    if (!r) return false;
    const i = nFans++;
    fR[i] = r; fVen[i] = vi; fOut[i] = out ? 1 : 0;
    fS[i] = seeded ? fanR() * r.L * 0.97 : 0; fK[i] = 0;
    fV[i] = 1.15 + fanR() * 0.5; fLat[i] = (fanR() - 0.5) * 3.2; fCol[i] = pickFan(fanR, vi === 0 ? 0.08 : 0.05);
    fOcc[i] = 0; fOccT[i] = 0; fPh[i] = fanR() * 6.28;
    placeFan(i);
    return true;
  }
  function kill(i) {
    const j = --nFans;
    if (i !== j) {
      fR[i] = fR[j]; fS[i] = fS[j]; fK[i] = fK[j]; fV[i] = fV[j]; fLat[i] = fLat[j]; fCol[i] = fCol[j]; fX[i] = fX[j]; fY[i] = fY[j];
      fVen[i] = fVen[j]; fOut[i] = fOut[j]; fOcc[i] = fOcc[j]; fOccT[i] = fOccT[j]; fPh[i] = fPh[j];
    }
    fR[j] = null;
  }
  function placeFan(i) {
    const r = fR[i], cum = r.cum, P = r.P, s = fS[i];
    let k = fK[i];
    const last = cum.length - 2;
    while (k < last && cum[k + 1] < s) k++;
    fK[i] = k;
    const sl = cum[k + 1] - cum[k] || 1, t = (s - cum[k]) / sl;
    const ax = P[2 * k], ay = P[2 * k + 1], bx = P[2 * k + 2], by = P[2 * k + 3];
    const ux = (bx - ax) / sl, uy = (by - ay) / sl;
    // spread across the path, narrowing at the ends (the doors, the cars)
    const w = Math.min(1, s / 25, (r.L - s) / 12);
    fX[i] = ax + (bx - ax) * t - uy * fLat[i] * w;
    fY[i] = ay + (by - ay) * t + ux * fLat[i] * w;
  }
  // fans wanted on the move now: [in, out] for a game
  function walkTargets(g, st, now) {
    const t = now.getTime(), K = g.date.getTime(), m = (t - K) / MIN, end = (st.endAt || K + g.sp.dur * MIN), me = (t - end) / MIN;
    const big = g.key === "football";
    const peakIn = big ? 1600 : 420, peakOut = big ? 1900 : 480;
    const inF = big ? smooth(-150, -70, m) * (1 - smooth(-12, 12, m)) : smooth(-95, -40, m) * (1 - smooth(-6, 10, m));
    const outF = st.state === "post" || me > -12 ? (big ? smooth(-12, 4, me) * (1 - smooth(28, 60, me)) : smooth(-6, 3, me) * (1 - smooth(18, 40, me))) : 0;
    return [Math.round(peakIn * inF), Math.round(peakOut * outF)];
  }

  // ---------------------------------------------------------------- per frame
  const PERF = { step: 0, stands: 0, tents: 0, fans: 0, frames: 0 };
  const sceneNow = { on: false, walkVis: false, smokeVis: false, bandVis: false, waveVis: false, glow: false };
  let simT = 0;
  const counts = [[0, 0], [0, 0]];
  function stepScene(f) {
    sceneNow.on = false;
    if (!app.layerEnabled("gameday") || !active.length) { nFans = 0; for (const vk of VEN) if (scenes[vk]) scenes[vk].live = false; return; }
    const now = f.now, dt = Math.min(0.25, f.dt || 0);
    simT += dt;
    // simulated only near the view, and when people are big enough to see
    const [gx, gy] = view.screenToGround(VW / 2, VH / 2), reach = Math.hypot(VW, VH) / SC / 2 + 400;
    for (let vi = 0; vi < 2; vi++) { counts[vi][0] = 0; counts[vi][1] = 0; }
    for (let i = 0; i < nFans; i++) counts[fVen[i]][fOut[i]]++;
    for (const g of active) {
      const v = venues[g.venue];
      if (!v) continue;
      const vi = VEN.indexOf(g.venue);
      // the scene (stands, tents) whenever the venue may show; the fans only when they are big enough to see
      const inReach = Math.hypot(gx - v.x, gy - v.y) < reach + 1600, near = inReach && SC >= 0.45;
      const S = inReach ? sceneOf(g.venue) : null;
      sceneNow.on = sceneNow.on || near;
      if (!S || !near) { if (scenes[g.venue]) scenes[g.venue].live = false; continue; }
      setAwayColours(g);
      const st = stateOf(g, now), [wi, wo] = walkTargets(g, st, now);
      // On first sight the walks are already under way (placed along their routes, a few hundred a frame so the first
      // look doesn't stall); after that they start at the doors or in the lots.
      if (!S.live) S.seeding = true;
      S.live = true;
      let seeded = false;
      for (let o = 0; o < 2; o++) {
        const want = o ? wo : wi, have = counts[vi][o];
        if (have >= want) continue;
        const n = S.seeding ? Math.min(want - have, 300) : Math.min(want - have, Math.ceil((want / 240) * Math.max(dt, 0.05) * 60));
        for (let k = 0; k < n; k++) if (!spawn(S, vi, !!o, S.seeding)) break;
        if (S.seeding && want - have > 300) seeded = true;
      }
      if (!seeded) S.seeding = false;
    }
    for (const vk of VEN) { const S = scenes[vk]; if (S && !active.some((g) => g.venue === vk)) S.live = false; }
    // walk
    for (let i = nFans - 1; i >= 0; i--) {
      const S = scenes[VEN[fVen[i]]];
      if (!S || !S.live) { kill(i); continue; }
      fS[i] += fV[i] * dt;
      fPh[i] += fV[i] * dt * 5.5;
      if (fS[i] >= fR[i].L) { kill(i); continue; }
      placeFan(i);
    }
  }

  // a building stands in front of ground point (x, y) at body height: hidden
  function hiddenAt(x, y, h) {
    const sc = app.scene, o = geo.ROTS[ROT];
    if (!sc) return false;
    const U = x * o.R[0] + y * o.R[1], Y = -(x * o.D[0] + y * o.D[1]) * SIN_T - h * COS_T;
    const b = sc.pickBuilding(ROT, U, Y);
    return b >= 0 && sc.inFront(ROT, b, x, y, 0);
  }

  // little people, batched by colour (as life.js draws walkers from afar)
  const PX = new Float32Array(CAP + 4096), PY = new Float32Array(CAP + 4096), PCOL = new Uint8Array(CAP + 4096), PPH = new Float32Array(CAP + 4096);
  function drawPeople(ctx, n, s) {
    if (!n) return;
    const k = PK;
    if (s < 1.6) {
      // dots: a stroke of jacket colour with a lighter head
      const w = Math.max(1.3, 0.6 * s), h = Math.max(2, 1.7 * k);
      for (let c = 0; c < fanCols.length; c++) {
        let any = false;
        for (let q = 0; q < n; q++) if (PCOL[q] === c) { if (!any) { ctx.beginPath(); any = true; } ctx.rect(PX[q] - w / 2, PY[q] - h, w, h); }
        if (any) { ctx.fillStyle = fanCols[c]; ctx.fill(); }
      }
      return;
    }
    const bw = Math.max(1, 0.46 * s), lw = Math.max(0.6, 0.17 * s), hs = Math.max(1, 0.26 * s);
    ctx.fillStyle = "rgba(38,50,60,.22)"; ctx.beginPath();
    for (let q = 0; q < n; q++) ctx.rect(PX[q] - bw * 0.3, PY[q] - 0.12 * s, bw * 1.3, 0.3 * s);
    ctx.fill();
    ctx.fillStyle = "#353a46"; ctx.beginPath();
    for (let q = 0; q < n; q++) {
      const sw = Math.sin(PPH[q]) * 0.16 * s, top = PY[q] - 0.86 * k, hgt = 0.86 * k;
      ctx.rect(PX[q] - bw * 0.42 + sw, top, lw, hgt); ctx.rect(PX[q] + bw * 0.42 - lw - sw, top, lw, hgt);
    }
    ctx.fill();
    for (let c = 0; c < fanCols.length; c++) {
      let any = false;
      for (let q = 0; q < n; q++) if (PCOL[q] === c) { if (!any) { ctx.beginPath(); any = true; } ctx.rect(PX[q] - bw / 2, PY[q] - 1.42 * k, bw, 0.62 * k); }
      if (any) { ctx.fillStyle = fanCols[c]; ctx.fill(); }
    }
    ctx.fillStyle = "#d9a882"; ctx.beginPath();
    for (let q = 0; q < n; q++) ctx.rect(PX[q] - hs / 2, PY[q] - 1.44 * k - hs, hs, hs);
    ctx.fill();
  }

  const CXs = new Float64Array(4), CYs = new Float64Array(4);
  const tentCache = { cv: null, key: "", x0: 0, y0: 0, w: 0, h: 0 };
  const SMOKE = ["rgba(236,234,230,.16)", "rgba(236,234,230,.12)", "rgba(236,234,230,.08)"];
  const TENT_COLS = [[SCARLET, "#8e1820"], ["#eceae3", "#c9c5ba"], ["#9a9da2", "#74777c"], ["#2f3440", "#1f232c"], ["#00274c", "#001a33"]];
  function drawScene(ctx, f) {
    sceneNow.walkVis = sceneNow.smokeVis = sceneNow.bandVis = sceneNow.waveVis = false;
    if (!app.layerEnabled("gameday") || !active.length) return;
    camera();
    let t0 = performance.now();
    stepScene(f);
    let t1 = performance.now(); PERF.step += t1 - t0; t0 = t1;
    const now = f.now, s = SC, t = now.getTime();
    for (const g of active) {
      const S = scenes[g.venue];
      if (!S) continue;
      const st = stateOf(g, now);
      if (S.bowl) drawStands(ctx, S, g, st, now);
      t1 = performance.now(); PERF.stands += t1 - t0; t0 = t1;
      if (S.tents) drawTailgates(ctx, S, g, st, t, f);
      t1 = performance.now(); PERF.tents += t1 - t0; t0 = t1;
    }
    PERF.frames++;
    // the fans walking, back to front
    if (nFans && s >= 0.5) {
      let n = 0;
      const m = 4;
      for (let i = 0; i < nFans; i++) {
        const x = fX[i], y = fY[i], px = sx(x, y), py = sy(x, y, 0);
        if (px < -m || px > VW + m || py < -m || py > VH + 2 * PK + m) continue;
        if (s >= 0.6) {
          if (simT >= fOccT[i]) { fOcc[i] = hiddenAt(x, y, 0.9) ? 1 : 0; fOccT[i] = simT + 0.4 + fanR() * 0.25; }
          if (fOcc[i]) continue;
        }
        // fade at the ends of the walk
        PX[n] = px; PY[n] = py; PCOL[n] = fCol[i]; PPH[n] = fPh[i]; n++;
      }
      if (n) { sceneNow.walkVis = true; drawPeople(ctx, n, s); }
    }
    PERF.fans += performance.now() - t0;
  }

  // ---------------------------------------------------------------- the stands
  function bowlFill(g, st, now) {
    const t = now.getTime(), K = g.date.getTime(), m = (t - K) / MIN;
    if (st.state === "post") { const me = (t - st.endAt) / MIN; return 1 - smooth(-5, 45, me); }
    return smooth(-110, -8, m);
  }
  function drawStands(ctx, S, g, st, now) {
    const fill = bowlFill(g, st, now);
    if (fill <= 0.01) return;
    const bw = S.bowl, s = SC;
    // on screen?
    const cxp = sx(bw.cx, bw.cy), cyp = sy(bw.cx, bw.cy, 15), rad = 170 * s;
    if (cxp + rad < 0 || cxp - rad > VW || cyp + rad < 0 || cyp - rad > VH) return;
    ctx.save();
    // inside the opening of the bowl…
    ctx.beginPath();
    const L = bw.rimLoop;
    for (let j = 0; j < bw.N; j++) { const x = sx(L[3 * j], L[3 * j + 1]), y = sy(L[3 * j], L[3 * j + 1], L[3 * j + 2]); if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.closePath(); ctx.clip();
    // …less what stands up in it
    for (const pts of bw.occ) {
      const hp = [];
      for (let k = 0; k < pts.length; k += 3) hp.push([sx(pts[k], pts[k + 1]), sy(pts[k], pts[k + 1], pts[k + 2])]);
      const h = hull(hp);
      ctx.beginPath(); ctx.rect(-50, -50, VW + 100, VH + 100);
      h.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath(); ctx.clip("evenodd");
    }
    const faces = bowlFaces(bw, ROT);
    const home = crowdPattern(ctx, s, false), away = crowdPattern(ctx, s, true);
    const waveOn = st.state === "in" && !st.half && !reduced() && s >= 0.5;
    const wavePos = waveOn ? ((simT / 26) % 1) * bw.N : -99;
    ctx.globalAlpha = 0.93;
    for (let pass = 0; pass < 2; pass++) {
      ctx.fillStyle = pass ? away : home;
      ctx.beginPath();
      let any = false;
      for (const q of faces) {
        if (q.away !== !!pass || q.seed > fill * 1.04) continue;
        const p = q.pts;
        ctx.moveTo(sx(p[0], p[1]), sy(p[0], p[1], p[2]));
        for (let k = 3; k < 12; k += 3) ctx.lineTo(sx(p[k], p[k + 1]), sy(p[k], p[k + 1], p[k + 2]));
        ctx.closePath();
        any = true;
      }
      if (any) ctx.fill();
    }
    ctx.globalAlpha = 1;
    // the wave: a band of raised arms running round the stands
    if (waveOn && fill > 0.6) {
      ctx.fillStyle = "rgba(255,240,228,.2)"; ctx.beginPath();
      for (const q of faces) {
        const dj = Math.abs(((q.j - wavePos + bw.N * 1.5) % bw.N) - bw.N / 2);
        if (dj > 1.6) continue;
        const p = q.pts;
        ctx.moveTo(sx(p[0], p[1]), sy(p[0], p[1], p[2]));
        for (let k = 3; k < 12; k += 3) ctx.lineTo(sx(p[k], p[k + 1]), sy(p[k], p[k + 1], p[k + 2]));
        ctx.closePath();
      }
      ctx.fill();
      sceneNow.waveVis = true;
    }
    ctx.restore();
    drawField(ctx, S, g, st, now);
  }

  // the band before kickoff and at halftime; the teams at the line of scrimmage
  function drawField(ctx, S, g, st, now) {
    const s = SC, F = S.bowl.field;
    if (s < 0.9) return;
    const t = now.getTime(), K = g.date.getTime(), m = (t - K) / MIN;
    const band = (st.state === "pre" && m > -24 && m < -5) || (st.state === "in" && st.half);
    const play = st.state === "in" && !st.half;
    if (!band && !play) return;
    const ux = F.ux, uy = F.uy, vx = -uy, vy = ux;
    const at = (u, v) => [F.cx + ux * u + vx * v, F.cy + uy * u + vy * v];
    if (band) {
      // a block of 12 across and 16 deep, marching down the field and back
      const T = reduced() ? 0.25 : simT * 0.012 + (hash(g.id) % 100) / 100, tri = Math.abs(((T % 1) * 2) - 1);
      const u0 = -F.L * 0.32 + tri * F.L * 0.64;
      const d = Math.max(1, 0.5 * s), k = PK;
      ctx.fillStyle = "#1d1f2b"; ctx.beginPath();
      const step = reduced() ? 0 : Math.sin(simT * 6) * 0.15;
      for (let a = 0; a < 16; a++) for (let b = 0; b < 12; b++) {
        const [x, y] = at(u0 + (a - 7.5) * 1.6 + (b & 1 ? step : -step), (b - 5.5) * 1.6);
        ctx.rect(sx(x, y) - d / 2, sy(x, y, 0) - 1.7 * k, d, 1.7 * k);
      }
      ctx.fill();
      if (s >= 2) {
        ctx.fillStyle = "#f4f1ea"; ctx.beginPath();
        for (let a = 0; a < 16; a++) for (let b = 0; b < 12; b++) { const [x, y] = at(u0 + (a - 7.5) * 1.6 + (b & 1 ? step : -step), (b - 5.5) * 1.6); ctx.rect(sx(x, y) - d / 2, sy(x, y, 0) - 1.35 * k, d, 0.18 * k); }
        ctx.fill();
        ctx.fillStyle = SCARLET; ctx.beginPath();
        for (let a = 0; a < 16; a++) for (let b = 0; b < 12; b++) { const [x, y] = at(u0 + (a - 7.5) * 1.6 + (b & 1 ? step : -step), (b - 5.5) * 1.6); ctx.rect(sx(x, y) - d * 0.3, sy(x, y, 0) - 2 * k, d * 0.6, 0.3 * k); }
        ctx.fill();
      }
      if (!reduced()) sceneNow.bandVis = true;
    }
    if (play && g.key === "football") {
      // the line of scrimmage drifts up and down the field with the game
      const el = (t - K) / MIN, line = Math.sin(el * 0.21 + (hash(g.id) % 7)) * F.L * 0.33;
      const snap = reduced() ? 0 : (simT % 9) / 9, burst = snap < 0.35 ? snap / 0.35 : 1 - (snap - 0.35) / 0.65;
      const d = Math.max(1, 0.55 * s), k = PK;
      for (let side = 0; side < 2; side++) {
        ctx.fillStyle = side ? "#f2f0ea" : SCARLET; ctx.beginPath();
        for (let p = 0; p < 11; p++) {
          const v = (p - 5) * 2.2 * (p < 7 ? 1 : 1.9), u = line + (side ? 1.6 : -1.6) * (1 + (p >= 7 ? 2.5 : 0)) + (side ? 1 : -1) * burst * (p % 3) * 0.8;
          const [x, y] = at(u, v);
          ctx.rect(sx(x, y) - d / 2, sy(x, y, 0) - 1.8 * k, d, 1.8 * k);
        }
        ctx.fill();
      }
      if (!reduced()) sceneNow.bandVis = true;
    }
  }

  // ---------------------------------------------------------------- the tailgates
  function drawTailgates(ctx, S, g, st, t, f) {
    const K = g.date.getTime(), end = st.endAt || K + g.sp.dur * MIN;
    const h = (t - K) / HOUR, he = (t - end) / HOUR;
    // canopies go up from six hours before kickoff, come down within two hours of the final
    const upAt = (u) => -6 + u * 1.8, downAt = (u) => 0.6 + u * 1.6;
    if (h < -6 || he > 2.3) return;
    // people at the tents: all of them before the game, a few during it, most of them again after
    const share = st.state === "pre" ? smooth(-6, -4.5, h) * (1 - smooth(-1.2, -0.2, h) * 0.85) : st.state === "in" ? 0.12 : 0.15 + 0.5 * smooth(0, 0.3, he) * (1 - smooth(1, 2, he));
    const s = SC, list = S.tents, m = 12;
    if (ROT !== S.tentRot) { for (const T of list) T.occR = -1; S.tentRot = ROT; }
    const ex = PA, ey = PC, fx = PB, fy = PD, k = PK;
    const shown = [];
    for (const T of list) {
      if (h < upAt(T.up) || he > downAt(T.down)) continue;
      const px = sx(T.x, T.y), py = sy(T.x, T.y, 0);
      if (px < -m || px > VW + m || py < -m - 4 * k || py > VH + m) continue;
      if (T.occR !== ROT) { T.occ = s >= 0.4 && hiddenAt(T.x, T.y, 1.5) ? 1 : 0; T.occR = ROT; }
      if (T.occ) continue;
      shown.push(T);
    }
    if (!shown.length) return;
    // From afar, or while the view moves: specks of canopy colour. Close and still: the full picture (canopies, people,
    // flags, grills), drawn once into a cache for this view and copied while only the smoke moves.
    if (s < 0.9 || f.moving) { tentSpecks(ctx, shown, s); return; }
    const key = `${view.X},${view.Y},${s},${ROT},${VW},${VH},${view.dpr},${shown.length},${Math.round(share * 24)}`;
    if (tentCache.key !== key) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const T of shown) { const px = sx(T.x, T.y), py = sy(T.x, T.y, 0); if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
      const pad = 8 * s + 4, top = 7 * PK + 4;
      x0 = Math.max(0, Math.floor(x0 - pad)); x1 = Math.min(VW, Math.ceil(x1 + pad)); y0 = Math.max(0, Math.floor(y0 - top)); y1 = Math.min(VH, Math.ceil(y1 + pad));
      const d = view.dpr, cw = Math.max(1, Math.ceil((x1 - x0) * d)), ch = Math.max(1, Math.ceil((y1 - y0) * d));
      if (!tentCache.cv) tentCache.cv = document.createElement("canvas");
      const cv = tentCache.cv;
      if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; } else cv.getContext("2d").clearRect(0, 0, cw, ch);
      const c2 = cv.getContext("2d");
      c2.setTransform(d, 0, 0, d, -x0 * d, -y0 * d);
      tentsFull(c2, shown, share, s);
      Object.assign(tentCache, { key, x0, y0, w: x1 - x0, h: y1 - y0 });
    }
    if (tentCache.w > 0 && tentCache.h > 0) ctx.drawImage(tentCache.cv, tentCache.x0, tentCache.y0, tentCache.w, tentCache.h);
    if (s >= 1.4) {
      const cooking = st.state === "pre" || (st.state === "post" && he < 1.5) || (st.state === "in" && h < 0.3);
      if (cooking && !reduced()) {
        const wd = ((app.weather && app.weather.windDir) || 250) * Math.PI / 180, wx = -Math.sin(wd), wy = -Math.cos(wd);
        // three puffs a grill, each a third of the way up its rise (older puffs are bigger and fainter)
        for (let ph = 0; ph < 3; ph++) {
          ctx.beginPath();
          let any = false;
          for (const T of shown) {
            if (!T.grill) continue;
            const p = (simT * 0.16 + T.seed + ph / 3) % 1;
            const x = T.x - T.size * 0.75 + wx * p * 4, y = T.y + T.size * 0.4 + wy * p * 4, r = (0.35 + p * 1.3) * s;
            const X = sx(x, y), Y = sy(x, y, 1.9 + p * 6.5);
            ctx.moveTo(X + r, Y); ctx.arc(X, Y, r, 0, Math.PI * 2);
            any = true;
          }
          if (!any) break;
          ctx.fillStyle = SMOKE[ph];
          ctx.fill();
          sceneNow.smokeVis = true;
        }
      }
    }
  }
  function tentSpecks(ctx, shown, s) {
    const w = Math.max(1.2, 3 * s);
    for (let c = 0; c < TENT_COLS.length; c++) {
      ctx.beginPath();
      let any = false;
      for (const T of shown) if (T.col === c) { any = true; ctx.rect(sx(T.x, T.y) - w / 2, sy(T.x, T.y, 2.4) - w * 0.35, w, w * 0.7); }
      if (any) { ctx.fillStyle = TENT_COLS[c][0]; ctx.fill(); }
    }
  }
  function tentsFull(ctx, shown, share, s) {
    const ex = PA, ey = PC, fx = PB, fy = PD, k = PK;
    // shadows on the asphalt
    ctx.fillStyle = "rgba(30,35,45,.18)"; ctx.beginPath();
    for (const T of shown) {
      const hs = T.size / 2, ox = 0.9, oy = -0.6;
      quadPath(ctx, T.x + ox, T.y + oy, hs, 0, ex, ey, fx, fy);
    }
    ctx.fill();
    // the people round them, and the grills
    let n = 0;
    for (const T of shown) {
      const np = T.ppl.length / 3, keep = Math.min(np, Math.round(np * share + 0.3));
      for (let q = 0; q < keep; q++) {
        const x = T.ppl[3 * q], y = T.ppl[3 * q + 1];
        PX[n] = sx(x, y); PY[n] = sy(x, y, 0); PCOL[n] = T.ppl[3 * q + 2]; PPH[n] = 0; n++;
      }
      if (n > PX.length - 16) break;
    }
    // legs on the near side of each canopy, then its valance and roof (a low pyramid)
    if (s >= 2.5) {
      ctx.strokeStyle = "#5b5e64"; ctx.lineWidth = Math.max(0.6, 0.06 * s); ctx.beginPath();
      for (const T of shown) {
        const hs = T.size / 2;
        for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const x = T.x + a * hs, y = T.y + b * hs;
          ctx.moveTo(sx(x, y), sy(x, y, 0)); ctx.lineTo(sx(x, y), sy(x, y, 2.3));
        }
      }
      ctx.stroke();
    }
    drawPeople(ctx, n, s);
    for (let c = 0; c < TENT_COLS.length; c++) {
      const [top, side] = TENT_COLS[c];
      // valance: the canopy's skirt on its two near sides (the corner nearest the camera is the lowest on screen)
      ctx.fillStyle = side; ctx.beginPath();
      let any = false;
      for (const T of shown) {
        if (T.col !== c) continue;
        any = true;
        const hs = T.size / 2, x = T.x, y = T.y, up = 0.35 * k;
        for (let e = 0; e < 4; e++) { const a = e === 1 || e === 2 ? 1 : -1, b = e >= 2 ? 1 : -1; CXs[e] = sx(x + a * hs, y + b * hs); CYs[e] = sy(x + a * hs, y + b * hs, 2.2); }
        let nb = 0;
        for (let e = 1; e < 4; e++) if (CYs[e] > CYs[nb]) nb = e;
        const l = (nb + 3) % 4, r = (nb + 1) % 4;
        ctx.moveTo(CXs[l], CYs[l] - up); ctx.lineTo(CXs[nb], CYs[nb] - up); ctx.lineTo(CXs[r], CYs[r] - up);
        ctx.lineTo(CXs[r], CYs[r]); ctx.lineTo(CXs[nb], CYs[nb]); ctx.lineTo(CXs[l], CYs[l]); ctx.closePath();
      }
      if (!any) continue;
      ctx.fill();
      // the roof: lit half and shaded half
      for (let half = 0; half < 2; half++) {
        ctx.fillStyle = half ? side : top; ctx.beginPath();
        for (const T of shown) {
          if (T.col !== c) continue;
          const hs = T.size / 2, x = T.x, y = T.y, zt = 2.55, zp = 3.15;
          const pxp = sx(x, y), pyp = sy(x, y, zp);
          // the four eave corners, in screen order round the peak
          const cx = [sx(x - hs, y - hs), sx(x + hs, y - hs), sx(x + hs, y + hs), sx(x - hs, y + hs)];
          const cy = [sy(x - hs, y - hs, zt), sy(x + hs, y - hs, zt), sy(x + hs, y + hs, zt), sy(x - hs, y + hs, zt)];
          for (let e = 0; e < 4; e++) {
            const e2 = (e + 1) % 4, mxp = (cx[e] + cx[e2]) / 2;
            const lit = mxp <= pxp;   // light comes from screen-left
            if (lit === !!half) continue;
            ctx.moveTo(pxp, pyp); ctx.lineTo(cx[e], cy[e]); ctx.lineTo(cx[e2], cy[e2]); ctx.closePath();
          }
        }
        ctx.fill();
      }
      // the ridges and eaves, a shade paler: a canopy reads as a tent among the cars
      if (s >= 1.6) {
        ctx.strokeStyle = c === 1 ? "rgba(150,140,120,.55)" : "rgba(255,255,255,.4)"; ctx.lineWidth = Math.max(0.5, 0.08 * s); ctx.beginPath();
        for (const T of shown) {
          if (T.col !== c) continue;
          const hs = T.size / 2, x = T.x, y = T.y, pxp = sx(x, y), pyp = sy(x, y, 3.15);
          for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { ctx.moveTo(pxp, pyp); ctx.lineTo(sx(x + a * hs, y + b * hs), sy(x + a * hs, y + b * hs, 2.55)); }
        }
        ctx.stroke();
      }
    }
    // flags on poles, and grills with smoke
    if (s >= 1.4) {
      ctx.strokeStyle = "#6b6e74"; ctx.lineWidth = Math.max(0.7, 0.07 * s); ctx.beginPath();
      for (const T of shown) if (T.flag) { const x = T.x + T.size * 0.6, y = T.y; ctx.moveTo(sx(x, y), sy(x, y, 0)); ctx.lineTo(sx(x, y), sy(x, y, 6)); }
      ctx.stroke();
      const wv = reduced() ? 0 : Math.sin(simT * 2.2);
      for (let c = 0; c < 2; c++) {
        ctx.fillStyle = c ? "#a7a9ac" : SCARLET; ctx.beginPath();
        for (const T of shown) {
          if (!T.flag) continue;
          const x = T.x + T.size * 0.6, y = T.y, X = sx(x, y), Y = sy(x, y, 6), fw = 1.6 * s, fh = 1.0 * k;
          if (c === 0) { ctx.moveTo(X, Y); ctx.lineTo(X + fw, Y + wv * 0.1 * s); ctx.lineTo(X + fw, Y + fh + wv * 0.1 * s); ctx.lineTo(X, Y + fh); ctx.closePath(); }
          else { ctx.rect(X + fw * 0.35, Y + fh * 0.1, fw * 0.3, fh * 0.8); }
        }
        ctx.fill();
      }
      // grills: a dark box; the smoke rises and leans with the wind
      ctx.fillStyle = "#2c2c30"; ctx.beginPath();
      for (const T of shown) if (T.grill) { const x = T.x - T.size * 0.75, y = T.y + T.size * 0.4; ctx.rect(sx(x, y) - 0.4 * s, sy(x, y, 1.0), 0.8 * s, 0.9 * k); }
      ctx.fill();
    }
  }
  function quadPath(ctx, x, y, hs, z, ex, ey, fx, fy) {
    const X = sx(x, y), Y = sy(x, y, z);
    ctx.moveTo(X - ex * hs - fx * hs, Y - ey * hs - fy * hs); ctx.lineTo(X + ex * hs - fx * hs, Y + ey * hs - fy * hs);
    ctx.lineTo(X + ex * hs + fx * hs, Y + ey * hs + fy * hs); ctx.lineTo(X - ex * hs + fx * hs, Y - ey * hs + fy * hs); ctx.closePath();
  }

  // ---------------------------------------------------------------- light over the field at night, the arena's glow
  let glowSprite = null;
  function sprite() {
    if (glowSprite) return glowSprite;
    const cv = document.createElement("canvas");
    cv.width = cv.height = 128;
    const c = cv.getContext("2d"), gr = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, "rgba(255,248,228,1)"); gr.addColorStop(0.45, "rgba(255,240,205,.45)"); gr.addColorStop(1, "rgba(255,230,190,0)");
    c.fillStyle = gr; c.fillRect(0, 0, 128, 128);
    return (glowSprite = cv);
  }
  function drawLights(ctx, f) {
    sceneNow.glow = false;
    if (!app.layerEnabled("gameday") || !active.length) return;
    const W = app.weather, night = W && W.source !== "none" && fin(W.night) ? W.night : (() => { const h = +hourFmt.format(f.now); return h < 7 || h >= 18 ? 1 : h >= 17 ? 0.5 : 0; })();
    if (night < 0.08) return;
    camera();
    const now = f.now, t = now.getTime();
    for (const g of active) {
      const v = venues[g.venue];
      if (!v) continue;
      const st = stateOf(g, now), K = g.date.getTime();
      const on = (st.state === "pre" && t > K - 100 * MIN) || st.state === "in" || (st.state === "post" && t < st.endAt + 50 * MIN);
      if (!on) continue;
      const S = scenes[g.venue];
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      if (g.venue === "stadium" && S && S.bowl) {
        // the field under the lights, and the stands round it
        const F = S.bowl.field, X = sx(F.cx, F.cy), Y = sy(F.cx, F.cy, 4), rw = 120 * SC, rh = rw * SIN_T * 1.3;
        if (X + rw > 0 && X - rw < VW && Y + rh > 0 && Y - rh < VH) { ctx.globalAlpha = 0.5 * night; ctx.drawImage(sprite(), X - rw, Y - rh, rw * 2, rh * 2); sceneNow.glow = true; }
      } else if (S) {
        // light spilling from the doors onto the plaza, and a faint warmth round the building
        const nd = walkGraph().nodes, X = sx(v.x, v.y), Y = sy(v.x, v.y, 0), rw = 150 * SC, rh = rw * SIN_T;
        if (X + rw > 0 && X - rw < VW && Y + rh > 0 && Y - rh < VH) {
          ctx.globalAlpha = 0.14 * night; ctx.drawImage(sprite(), X - rw, Y - rh, rw * 2, rh * 2);
          ctx.globalAlpha = 0.55 * night;
          const r2 = 16 * SC;
          // (only the doors on this side: the ones behind the building are out of sight)
          S.gateVis = S.gateVis || [];
          if (!S.gateVis[ROT]) S.gateVis[ROT] = S.tree.gates.filter((gi) => !hiddenAt(nd[2 * gi], nd[2 * gi + 1], 0.3));
          for (const gi of S.gateVis[ROT]) { const gx = nd[2 * gi], gy = nd[2 * gi + 1], GX = sx(gx, gy), GY = sy(gx, gy, 0); ctx.drawImage(sprite(), GX - r2, GY - r2 * SIN_T, r2 * 2, r2 * 2 * SIN_T); }
          sceneNow.glow = true;
        }
      }
      ctx.restore();
    }
  }

  // ============================================================================================== layers
  app.addLayer({
    id: "events", z: 94,
    draw: (ctx, f) => drawPins(ctx, f),
    fps: () => 0,   // nothing on the canvas moves: the pulse is CSS
    hit: (px, py) => hitPin(px, py),
    onHover: (p) => { hoverPin = p || null; },   // (the core sets the pointer cursor and draws a frame on a change)
    onClick: (p) => openPlaceCard(p.place, p.list, false),
  });
  app.addLayer({
    id: "gameday-chip", z: 93,
    draw: (ctx, f) => { if (app.layerEnabled("gameday")) drawChips(ctx, f); },
    hit: (px, py) => { if (!app.layerEnabled("gameday")) return null; for (const c of CHIPS) if (px >= c.x0 && px <= c.x1 && py >= c.y0 && py <= c.y1) return c.g; return null; },
    onClick: (g) => openGameCard(g, false),
  });
  app.addLayer({
    id: "gameday", z: 36,
    draw: (ctx, f) => drawScene(ctx, f),
    // Fans walk ~1.4 m/s: half a pixel a frame looks smooth, so 6 fps from afar (3 px/s at the default zoom) up to 24
    // close up. Smoke, the band, the wave: 8. Nothing moving on screen: 0.
    fps: () => {
      if (!app.layerEnabled("gameday") || !sceneNow.on) return 0;
      let w = 0;
      if (sceneNow.walkVis) w = clamp(Math.round(3 * SC), 6, 24);
      if (sceneNow.smokeVis || sceneNow.waveVis || sceneNow.bandVis) w = Math.max(w, 8);
      return w;
    },
  });
  app.addLayer({ id: "gameday-lights", z: 85, draw: (ctx, f) => drawLights(ctx, f) });

  // ============================================================================================== wiring
  const ui = UI();
  if (ui) {
    ui.registerToggle && ui.registerToggle({ id: "events", label: "Campus events", group: "Live", count: "" });
    ui.registerToggle && ui.registerToggle({ id: "gameday", label: "Game day", group: "Live" });
    ui.addSearchProvider && ui.addSearchProvider((q) => { try { return searchEvents(q); } catch (e) { console.warn("[events] search", e); return []; } });
  }
  app.on("layers", (p) => {
    if (!p) return;
    if (p.id === "events") { updateEventStatus(); if (!p.on) { UI()?.closeCard?.("event"); hidePulses(true); } }
    if (p.id === "gameday") { updateGameStatus(); if (!p.on) UI()?.closeCard?.("game"); }
  });
  app.on("theme", () => { chipCache.clear(); });
  const tickMs = simulated && speed > 1 ? Math.max(1000, 30000 / speed) : 30000;
  setInterval(() => { refreshEvents(); refreshGames(); }, tickMs);
  // scores of a simulated game change between ticks: look every few seconds while one is on
  setInterval(() => { if (active.some((g) => g.mock || simulated)) gameChanged(); }, 5000);
  function afterGames() { refreshGames(); if (!simulated && !ESPN_BLOCKED && games.some((g) => !g.mock)) poll(); }

  app.events = {
    get list() { return events.list.map(({ place, ...e }) => ({ ...e, place: place ? place.name : null })); },
    get today() { return todayList.map((e) => e.title); },
    get pins() { return pins.map((p) => ({ place: p.place.name, n: p.list.length, now: p.now })); },
    get games() { return games.map((g) => ({ id: g.id, sport: g.key, date: g.date, title: gameTitle(g), venue: g.venue, state: stateOf(g, app.now()).state, score: scoreOf(g, app.now()) })); },
    get active() { return active.map((g) => g.id); },
    geocode: (s) => { const p = geocode(s); return p ? { name: p.name, kind: p.kind, x: Math.round(p.x), y: Math.round(p.y) } : null; },
    get debug() {
      const sc = {};
      for (const [k, S] of Object.entries(scenes)) if (S) sc[k] = { live: !!S.live, ms: Math.round(S.ms), gates: S.tree.gates.length, src: S.src.length, tents: S.tents ? S.tents.length : 0, routes: S.routes.size };
      const F = Math.max(1, PERF.frames), ms = Object.fromEntries(Object.entries(PERF).filter(([k]) => k !== "frames").map(([k, v]) => [k, +(v / F).toFixed(2)]));
      return { schedules: gamesState, fans: nFans, scenes: sc, now: { ...sceneNow }, msPerFrame: ms, frames: PERF.frames };
    },
    openEvent: (id) => openEventById(id),
    openList, openGame: (id) => { const g = games.find((x) => x.id === id) || active[0]; if (g) openGameCard(g, true); },
  };

  // go: the calendar now, the schedules a moment later (the map's tiles come first)
  loadEvents();
  setInterval(loadEvents, 30 * MIN);
  setTimeout(() => { loadGames().catch((e) => { console.warn("[events] schedules", e); gamesState = "failed"; }); }, 600);
}

// ------------------------------------------------------------------------------------------------ drawing helpers
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r); ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r); ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
}

function injectStyle() {
  if (document.getElementById("ev-style")) return;
  const st = document.createElement("style");
  st.id = "ev-style";
  st.textContent = `
.ev-fx { position: fixed; inset: 0; pointer-events: none; overflow: hidden; contain: strict; }
.ev-pulse { position: absolute; left: 0; top: 0; width: 0; height: 0; will-change: transform; }
.ev-pulse::before { content: ""; position: absolute; left: -17px; top: -8.5px; width: 34px; height: 17px; box-sizing: border-box; border-radius: 50%;
  border: 1.8px solid rgba(179,32,42,.75); animation: ev-ring 2.4s cubic-bezier(.2,.6,.35,1) infinite; animation-delay: inherit; }
@keyframes ev-ring { 0% { transform: scale(.25); opacity: 0; } 12% { opacity: .9; } 100% { transform: scale(1); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .ev-pulse::before { animation: none; transform: scale(.7); opacity: .55; } }
.ev-st-btn { all: unset; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; border-radius: 999px; padding: 3px 2px; color: inherit; }
.ev-st-btn:hover { color: var(--scarlet); }
.ev-st-btn:focus-visible { outline: 2px solid var(--scarlet); outline-offset: 2px; }
.ev-st-flag { width: 8px; height: 10px; border-left: 1.5px solid currentColor; position: relative; opacity: .8; }
.ev-st-flag::after { content: ""; position: absolute; left: 0; top: 0; border-left: 7px solid var(--scarlet); border-top: 3px solid transparent; border-bottom: 3px solid transparent; }
.gd-mute { color: var(--mute); font-weight: 500; }
.gd-live { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--scarlet); box-shadow: 0 0 0 0 rgba(179,32,42,.5); animation: gd-pulse 2s infinite; }
@keyframes gd-pulse { 0% { box-shadow: 0 0 0 0 rgba(179,32,42,.45); } 70% { box-shadow: 0 0 0 6px rgba(179,32,42,0); } 100% { box-shadow: 0 0 0 0 rgba(179,32,42,0); } }
@media (prefers-reduced-motion: reduce) { .gd-live { animation: none; } }
.ev-card { display: flex; flex-direction: column; gap: 4px; }
.ev-item + .ev-item { border-top: 1px solid var(--line); padding-top: 9px; margin-top: 5px; }
.ev-t { margin: 0 0 2px; font: 600 15px/1.3 var(--serif, Georgia, serif); color: var(--ink); }
.ev-when { font-weight: 600; color: var(--ink); font-size: 13px; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.ev-now { font: 600 10.5px/1 var(--sans, sans-serif); text-transform: uppercase; letter-spacing: .06em; color: #fff; background: var(--scarlet); padding: 3px 6px 2px; border-radius: 999px; }
.ev-loc { color: var(--mute); font-size: 12.5px; }
.ev-sum { margin: 6px 0; color: var(--text); font-size: 13px; overflow-wrap: anywhere; }
.ev-tags { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 6px; }
.ev-tags span { font-size: 11px; padding: 2px 7px; border-radius: 999px; background: color-mix(in srgb, var(--line) 55%, transparent); color: var(--mute); }
.ev-link { display: inline-block; margin-top: 2px; color: var(--scarlet); font-weight: 600; font-size: 13px; text-decoration: none; }
.ev-link:hover { text-decoration: underline; }
.ev-src { margin: 10px 0 0; color: var(--mute); font-size: 11.5px; }
.ev-src a { color: inherit; }
.ev-h { margin: 8px 0 4px; font: 600 11px/1 var(--sans, sans-serif); text-transform: uppercase; letter-spacing: .07em; color: var(--mute); }
.ev-list { list-style: none; margin: 0; padding: 0; }
.ev-row { all: unset; box-sizing: border-box; width: 100%; display: flex; gap: 10px; padding: 6px 6px; border-radius: 8px; cursor: pointer; align-items: baseline; }
.ev-row:hover, .ev-row:focus-visible { background: color-mix(in srgb, var(--line) 45%, transparent); }
.ev-row:focus-visible { outline: 2px solid var(--scarlet); outline-offset: -2px; }
.ev-row-when { flex: none; width: 74px; font: 600 12px/1.35 var(--sans, sans-serif); color: var(--mute); font-variant-numeric: tabular-nums; }
.ev-row-when.on { color: var(--scarlet); }
.ev-row-main { min-width: 0; display: flex; flex-direction: column; }
.ev-row-t { color: var(--ink); font-weight: 600; font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }
.ev-row-sub { color: var(--mute); font-size: 12px; line-height: 1.35; overflow-wrap: anywhere; }
.ev-empty { color: var(--mute); font-size: 13px; margin: 2px 0 6px; }
.gd-board { display: flex; flex-direction: column; gap: 6px; margin: 2px 0 8px; }
.gd-team { display: flex; align-items: center; gap: 9px; font: 600 15px/1.2 var(--sans, sans-serif); color: var(--ink); }
.gd-sw { width: 12px; height: 16px; border-radius: 3px; background: linear-gradient(90deg, var(--c) 0 62%, var(--c2) 62%); box-shadow: inset 0 0 0 1px rgba(0,0,0,.12); }
.gd-name { flex: 1; }
.gd-score { font: 700 20px/1 var(--sans, sans-serif); font-variant-numeric: tabular-nums; min-width: 2ch; text-align: right; }
.gd-status { display: flex; align-items: center; gap: 7px; font-weight: 600; color: var(--scarlet); font-size: 13px; }
.gd-note { margin: 6px 0; color: var(--text); font-size: 13px; }
.gd-sim { margin: 4px 0; color: var(--mute); font-size: 12px; font-style: italic; }
`;
  document.head.append(st);
}
