// Steam from McCracken Power Plant's stacks.
//
// Soft puffs leave the mouth of every landmark "stack" ornament (McCracken's two brick smokestacks; core/landmarks.js
// buildOrn draws them, so a plume starts exactly at the flue: (x, y) at z1, the flue r1·0.68 across), rise on their own
// warmth, bend downwind (app.weather.windMph, windDir = where the wind comes FROM), grow, thin out and churn slowly.
// How much shows follows the live weather: thick billowing white plumes when it is cold and damp, thin wisps on a mild
// day, next to nothing in summer heat; more in fog and drizzle. ?steam=max forces thick plumes whatever the weather.
//
// Not live data: the plume is drawn from the weather, not seen. Each puff's path is a function of its birth time (a
// wall-clock count, the same for everyone) and a hash of it, so the plume looks the same whenever it comes back into
// view; only the wind is eased in (over ~15 s) so a new reading swings the plume rather than snapping it.
//
// Drawing ("steam", z 83: above the night-lights tiles, so a plume veils lit windows behind it; below vehicle lights):
// a few dozen pre-drawn soft sprites (a lumpy cauliflower puff in a cool shade colour, then a softer highlight shifted
// toward the real sun, and at night a warm underglow from the city's lights; never white at night: this layer is above
// the night tint and grades itself), stamped axis-aligned (a rotated drawImage costs several times more on a CPU canvas)
// into two small low-resolution pictures laid over the map with one scaled blit each: the grown plume (most of the
// pixels) redrawn 0.4-4 times a second and slid along its drift in between, the young jets at the mouths at up to 10
// fps. Between redraws (a pan, a zoom) the pictures are only moved and stretched.
// Nothing on campus is tall enough to stand in front of air 62 m up but the stacks themselves (a point at height z
// behind a thing d metres in front of it is hidden only if the thing is taller than z + 0.58·d), so the only occlusion
// is each stack's own shaft and the front lip of its rim, rubbed out of the puffs behind it.
// Draws only while the "sky" switch ("Real sky & weather") is on. Publishes app.whimsy.steam (0..1, how much plume shows
// on screen). Clicking a plume opens a card about the plant with today's plume forecast; sound cue "hiss" on clicks and
// on the plant's occasional bigger sigh.

const TAU = Math.PI * 2, RAD = Math.PI / 180;
const EPOCH = Date.UTC(2026, 0, 1);   // puff numbers count from here (keeps them small)
const RATE = 3;                       // puffs a second from each stack
const MAXP = 80;                      // puffs drawn per stack at most
const SPR = 96;                       // sprite size, px
const NV = 8;                         // puff shapes
const BUDGET = 50000;                 // pixels in the grown plume's picture at most
const BUDGET_Y = 40000;               // … and in the young jets'
const ZOOM0 = 0.045, ZOOM1 = 0.11;    // CSS px per metre: no plume below the first, all of it from the second
const SIGH = 170;                     // seconds: about this often one stack lets out a bigger breath
const CLIMATE = { winter: 34, spring: 60, summer: 82, autumn: 62, "late-autumn": 46 };
// the light on the steam by sun altitude: alt°, lit r g b, shade r g b (night: dim blue-grey, never white)
const LIGHT = [
  [25, 255, 253, 247, 188, 198, 215],
  [10, 255, 247, 232, 190, 193, 210],
  [4, 255, 230, 194, 198, 186, 196],
  [0, 252, 210, 180, 182, 164, 180],
  [-3, 212, 176, 180, 124, 120, 156],
  [-6, 160, 154, 178, 110, 110, 140],
  [-9, 146, 150, 176, 100, 106, 136],
  [-13, 140, 146, 172, 96, 103, 132],
];
const COMPASS = ["north", "north-north-east", "north-east", "east-north-east", "east", "east-south-east", "south-east", "south-south-east",
  "south", "south-south-west", "south-west", "west-south-west", "west", "west-north-west", "north-west", "north-north-west"];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function hashInt(a, b) {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d); h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}
const hash01 = (a, b) => hashInt(a, b) / 4294967296;
function makeCanvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
const cw = Math.cos, sw = Math.sin;

export function init(app) {
  const { data, geo, view } = app;
  const LM = data && data.landmarks;
  if (!LM || !geo || !view) return;
  const SIN_T = geo.SIN_T, COS_T = geo.COS_T;
  const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");
  const MAX = (app.params.get("steam") || "").trim().toLowerCase() === "max";
  app.whimsy = app.whimsy || {};
  app.whimsy.steam = 0;

  // ---------------------------------------------------------------- the stacks
  const owns = (o, b) => (o.on == null ? !b.part : Array.isArray(o.on) ? o.on.includes(b.id) : o.on === b.id);
  const stacks = [];
  for (const key of Object.keys(LM)) {
    const spec = LM[key];
    if (!spec || !Array.isArray(spec.orn)) continue;
    for (const o of spec.orn) {
      if (!o || o.type !== "stack" || !Number.isFinite(o.x) || !Number.isFinite(o.y) || !Number.isFinite(o.z1)) continue;
      const rec = data.buildings.find((b) => b.lm === key && owns(o, b));
      const main = data.buildings.find((b) => b.lm === key && !b.part && b.n) || rec;
      const r1 = o.r1 != null ? o.r1 : o.r0 || 1.5, r0 = o.r0 || r1;
      const z0 = o.z0 != null ? o.z0 : rec ? rec.h : 0;
      const n = stacks.length;
      stacks.push({
        n, key, name: spec.name || (main && main.n) || "Power plant", addr: main && main.a ? main.a : "",
        x: o.x, y: o.y, z: o.z1, z0, r0, r1, flue: r1 * 0.68,
        // its own sway: two slow waves per axis, phases from its number
        ph: [hash01(n, 11) * TAU, hash01(n, 12) * TAU, hash01(n, 13) * TAU, hash01(n, 14) * TAU],
        sx: 0, sy: 0, sd: 0, done: false,   // per render: mouth on screen (screen metres), depth, rubbed out yet
      });
    }
  }
  if (!stacks.length) return;

  // ---------------------------------------------------------------- the weather's say
  const P = { dens: 0, hum: 0, temp: 50, life: 10, peak: 0.5, grow: 1, u: 1, mph: 0 };
  function weather() {
    const W = app.weather || {};
    const season = (app.tileStyle && app.tileStyle.season) || "late-autumn";
    const T = Number.isFinite(W.tempF) ? W.tempF : CLIMATE[season] != null ? CLIMATE[season] : 50;
    // no humidity in the feed: cloud, fog, rain and snow stand in for it (a clear day reads as dry-ish)
    const hum = MAX ? 1 : clamp01(0.36 + 0.26 * clamp01((W.cloud || 0) / 100) + 0.6 * (W.fog || 0) + 0.42 * (W.rain || 0) + 0.34 * (W.snow || 0));
    const cold = smooth(80, 26, T);
    let dens = MAX ? 1 : clamp01(Math.pow(cold, 1.1) * (0.5 + 0.62 * hum));
    if (!MAX) dens = Math.max(dens, 0.05);   // summer heat: a ghost of a wisp, gone a few metres up
    P.dens = dens; P.hum = hum; P.temp = T;
    P.mph = Math.max(0, +W.windMph || 0);
    const u = P.mph * 0.447 * 1.35 + 0.35;   // a little stronger up at the stack's mouth than at 10 m
    P.life = (4 + 30 * Math.pow(dens, 0.9)) / (1 + u / 16);
    P.peak = (0.16 + 0.74 * dens) * lerp(1, 0.72, clamp01(W.night || 0));
    P.grow = 0.7 + 0.6 * dens;
    return u;
  }

  // the wind, eased: where the plume leans (ground m/s, toward where the wind blows)
  let ux = 0, uy = 0, windInit = false;
  function easeWind(dt) {
    const W = app.weather || {};
    const u = weather();
    const a = (((+W.windDir || 0) + 180) % 360) * RAD, tx = Math.sin(a) * u, ty = Math.cos(a) * u;
    if (!windInit) { ux = tx; uy = ty; windInit = true; return; }
    const k = 1 - Math.exp(-dt / 15);
    ux += (tx - ux) * k; uy += (ty - uy) * k;
  }

  // ---------------------------------------------------------------- the light on it
  const LC = { lit: [255, 255, 255], shade: [190, 196, 214], glow: [255, 170, 112], glowA: 0, litA: 0.9, offX: -0.2, offY: -0.2, litK: 0.8, key: "" };
  function light() {
    const W = app.weather || {};
    const alt = Number.isFinite(W.sunAlt) ? W.sunAlt : 30, az = Number.isFinite(W.sunAz) ? W.sunAz : 180;
    const night = clamp01(W.night || 0), day = 1 - night;
    const n = LIGHT.length;
    let i = 0;
    while (i < n - 2 && LIGHT[i + 1][0] > alt) i++;
    const A = LIGHT[i], B = LIGHT[i + 1], t = clamp01((A[0] - alt) / (A[0] - B[0]));
    const lit = LC.lit, sh = LC.shade;
    for (let c = 0; c < 3; c++) { lit[c] = lerp(A[1 + c], B[1 + c], t); sh[c] = lerp(A[4 + c], B[4 + c], t); }
    // overcast, rain, fog: the light goes flat and grey (less contrast, no warm side)
    const grey = Math.max(smooth(55, 100, W.cloud || 0), W.rain || 0, (W.snow || 0) * 0.6, (W.fog || 0) * 0.8) * day;
    const lum = 0.3 * lit[0] + 0.59 * lit[1] + 0.11 * lit[2];
    lit[0] = lerp(lit[0], lum * 0.97, grey * 0.75); lit[1] = lerp(lit[1], lum * 0.975, grey * 0.75); lit[2] = lerp(lit[2], Math.min(255, lum * 1.0), grey * 0.75);
    for (let c = 0; c < 3; c++) sh[c] = lerp(sh[c], lit[c] * 0.8, grey * 0.3);
    // the city's light from below at night, warmer and stronger under low cloud
    LC.glowA = smooth(-1, -9, alt) * (0.3 + 0.15 * clamp01((W.cloud || 0) / 100)) * (1 - 0.4 * (W.fog || 0));
    // the highlight: toward the sun as it falls on the screen; front-lit puffs light up whole, back-lit ones show a rim
    const o = geo.ROTS[view.rot], la = Math.max(alt, 2) * RAD, ca = Math.cos(la), sa = Math.sin(la);
    const gx = Math.sin(az * RAD) * ca, gy = Math.cos(az * RAD) * ca;
    let lx = gx * o.R[0] + gy * o.R[1], ly = -(gx * o.D[0] + gy * o.D[1]) * SIN_T - sa * COS_T;
    // the camera looks along D, 30° down: how much the sun shines from behind the viewer
    const front = -(gx * o.D[0] + gy * o.D[1]) * COS_T + sa * SIN_T;
    let m = Math.hypot(lx, ly);
    if (alt < -2) { lx = -0.25; ly = -1; m = Math.hypot(lx, ly); }   // after dark, the sky's last light from above
    const side = Math.sqrt(clamp01(1 - front * front));
    const off = 0.3 * (1 - 0.65 * grey) * (alt < -2 ? 0.6 : Math.max(0.35, side));
    LC.offX = m > 1e-6 ? (lx / m) * off : 0; LC.offY = m > 1e-6 ? (ly / m) * off : -off;
    LC.litK = 0.74 + 0.16 * Math.max(0, front) + 0.1 * grey;
    LC.litA = lerp(0.95, 0.55, night) * (alt < -2 ? 0.8 : 0.82 + 0.18 * Math.max(0, front));
    const q = (v) => Math.round(v / 3);
    LC.key = `${q(lit[0])},${q(lit[1])},${q(lit[2])},${q(sh[0])},${q(sh[1])},${q(sh[2])}`;
  }

  // ---------------------------------------------------------------- sprites
  // NV lumpy puffs (a white alpha mask each), a soft disc for the highlights and one for the glow; tinted copies
  // re-made only when the light's colours change
  const masks = [], softMasks = [], soft = makeCanvas(SPR, SPR), shadeSpr = [], litSpr = [], glowSpr = makeCanvas(SPR, SPR);
  {
    const r = SPR / 2;
    const blob = (g, x, y, rad, a, edge) => {
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(edge, `rgba(255,255,255,${a})`);
      gr.addColorStop(edge + (1 - edge) * 0.58, `rgba(255,255,255,${a * 0.55})`); gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, TAU); g.fill();
    };
    for (let v = 0; v < NV; v++) {
      for (const edge of [0.62, 0.25]) {
        const c = makeCanvas(SPR, SPR), g = c.getContext("2d");
        blob(g, r, r, r * 0.66, 1, edge);
        const k = 5 + (v & 1);
        for (let j = 0; j < k; j++) {
          const a = (j / k) * TAU + hash01(v, j) * 0.9, d = r * (0.3 + 0.12 * hash01(v, j + 20)), rad = r * (0.36 + 0.14 * hash01(v, j + 40));
          blob(g, r + Math.cos(a) * d, r + Math.sin(a) * d, Math.min(rad, r - d - 1), edge > 0.5 ? 1 : 0.8, edge);
        }
        (edge > 0.5 ? masks : softMasks).push(c);
      }
      shadeSpr.push(makeCanvas(SPR, SPR)); litSpr.push(makeCanvas(SPR, SPR));
    }
    const g = soft.getContext("2d"), gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.42, "rgba(255,255,255,.62)"); gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr; g.fillRect(0, 0, SPR, SPR);
  }
  let tintKey = "";
  function tint(dst, src, rgb) {
    const g = dst.getContext("2d");
    g.globalCompositeOperation = "copy"; g.drawImage(src, 0, 0);
    g.globalCompositeOperation = "source-in";
    g.fillStyle = `rgb(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])})`; g.fillRect(0, 0, SPR, SPR);
    g.globalCompositeOperation = "source-over";
  }
  function sprites() {
    if (tintKey === LC.key) return;
    tintKey = LC.key;
    for (let v = 0; v < NV; v++) { tint(shadeSpr[v], masks[v], LC.shade); tint(litSpr[v], softMasks[v], LC.lit); }
    tint(glowSpr, soft, LC.glow);
  }

  // ---------------------------------------------------------------- the puffs (screen metres for the current turn)
  const CAP = MAXP * stacks.length;
  const PX = new Float64Array(CAP), PY = new Float64Array(CAP), PR = new Float32Array(CAP), PA = new Float32Array(CAP), PG = new Float32Array(CAP);
  const PD = new Float64Array(CAP), PH = new Float32Array(CAP), PT = new Float32Array(CAP), PVX = new Float32Array(CAP), PVY = new Float32Array(CAP);
  const PK = new Uint8Array(CAP), PV = new Uint8Array(CAP), ORD = new Int16Array(CAP), SORD = new Int16Array(stacks.length);
  let np = 0, bx0 = 0, by0 = 0, bx1 = 0, by1 = 0, simRot = -1, simT = -1e9;
  let DVX = 0, DVY = 0;   // how the grown plume drifts across the screen (screen m/s): its picture slides so between redraws

  // the bigger breath: in each SIGH-second window one stack puffs harder for ~3 s (from a hash of the window)
  function sighAt(k, tb) {
    const w = Math.floor(tb / SIGH), t0 = w * SIGH + 20 + hash01(w, 77) * (SIGH - 40);
    if (Math.floor(hash01(w, 78) * stacks.length) !== k) return 0;
    const d = tb - t0;
    return d < 0 || d > 3 ? 0 : Math.sin((d / 3) * Math.PI);
  }

  function simulate(T) {
    const o = geo.ROTS[view.rot], R0 = o.R[0], R1 = o.R[1], D0 = o.D[0], D1 = o.D[1];
    const u = Math.hypot(ux, uy), nx = u > 1e-6 ? -uy / u : -1, ny = u > 1e-6 ? ux / u : 0;
    // Artistic licence: a plume blowing at the camera would slide down the screen over its own stack and read as steam
    // pouring down, so the toward-the-viewer part of its drift is shortened: it always climbs on screen.
    const wR = (ny * R0 - nx * R1), wD = (ny * D0 - nx * D1), wD2 = wD < 0 ? wD * 0.3 : wD;
    const wx = wR * R0 + wD2 * D0, wy = wR * R1 + wD2 * D1;
    const life = P.life, peak = P.peak, grow = P.grow;
    const wb = 2.6 / (1 + u / 3);        // buoyant rise, m/s: bent over and flattened by the wind
    const tu = 1.4, tw = 1.5, tbz = 22;    // s: picking up the wind, the exit jet slowing, the buoyant rise levelling
    np = 0; bx0 = by0 = Infinity; bx1 = by1 = -Infinity;
    for (let k = 0; k < stacks.length; k++) {
      const st = stacks[k];
      st.sx = st.x * R0 + st.y * R1; st.sd = st.x * D0 + st.y * D1; st.sy = -(st.sd * SIN_T + st.z * COS_T);
      const iNow = Math.floor(T * RATE), iOld = Math.floor((T - life) * RATE);
      let cnt = 0;
      for (let i = iNow; i > iOld && cnt < MAXP; i--) {
        const h = hashInt(k * 7919 + 1, i), h1 = (h & 255) / 255, h2 = ((h >>> 8) & 255) / 255, h3 = ((h >>> 16) & 255) / 255, h4 = (h >>> 24) / 255;
        const tb = (i + (hash01(i, k + 5) - 0.5) * 0.7) / RATE, a = T - tb;
        if (a < 0) continue;
        // fewer, bigger puffs downwind (most of the cost is in the big ones): half are gone a sixth of the way, half the
        // rest by a third, half of those by 0.6, one in eight goes the whole way
        let tier = 1;
        if (i & 1) tier = 1 - smooth(life * 0.1, life * 0.2, a);
        else if (i & 2) tier = 1 - smooth(life * 0.26, life * 0.38, a);
        else if (i & 4) tier = 1 - smooth(life * 0.48, life * 0.62, a);
        if (tier < 0.01) continue;
        // the survivors fill in for the ones gone
        const fill = 1 + 0.15 * smooth(life * 0.1, life * 0.2, a) + 0.2 * smooth(life * 0.26, life * 0.38, a) + 0.25 * smooth(life * 0.48, life * 0.62, a);
        const sig = sighAt(k, tb);
        const jit = smooth(0, 2.2, a);
        const along = u * (a - tu * (1 - Math.exp(-a / tu)));
        const rise = 7 * (1 + 0.5 * sig) * tw * (1 - Math.exp(-a / tw)) + wb * tbz * (1 - Math.exp(-a / tbz));
        // the whole plume snakes: each puff keeps the sway it was born into
        const swL = Math.sin(tb * 0.23 + st.ph[0]) * 0.6 + Math.sin(tb * 0.071 + st.ph[1]) * 0.4;
        const swV = Math.sin(tb * 0.17 + st.ph[2]) * 0.6 + Math.sin(tb * 0.053 + st.ph[3]) * 0.4;
        let R = st.flue + grow * (1.3 * Math.sqrt(a) + 0.3 * a + 0.05 * along) * (0.85 + 0.3 * h4) * (1 + 0.35 * sig);
        R *= (0.85 + 0.15 * fill) * (1 + 0.05 * Math.sin(a * 1.1 + h1 * TAU))   // boiling
          * (0.8 + 0.4 * (0.5 + 0.5 * Math.sin(tb * 0.85 + st.ph[0] * 2)));   // and puffing: bulges along the plume
        const lat = swL * a * (0.3 + 0.08 * u) + (h1 - 0.5) * R * 0.55 * jit;
        const up = swV * a * (0.14 + 0.04 * u) + (h2 - 0.5) * R * 0.35 * jit;
        const al = along + (h3 - 0.5) * R * 0.4 * jit;
        const x = st.x + wx * al + nx * lat, y = st.y + wy * al + ny * lat, z = st.z + 0.4 + rise + up;
        const A = peak * smooth(0, 0.35, a) * (1 - smooth(life * 0.45, life, a)) * Math.pow((st.flue + 2) / (R + 2), 0.4) * tier * fill * (1 + 0.25 * sig);
        if (A < 0.004) continue;
        const d = x * D0 + y * D1, X = x * R0 + y * R1, Y = -(d * SIN_T + z * COS_T);
        PX[np] = X; PY[np] = Y; PR[np] = R; PA[np] = Math.min(1, A); PD[np] = d; PH[np] = z - st.z; PG[np] = a;
        PT[np] = 0.45 * Math.sin(a * (0.35 + 0.3 * h3) + h2 * TAU); PK[np] = k; PV[np] = (h >>> 5) & (NV - 1);
        // how much it is drawn out along its way across the screen (as far as the screen's axes allow): the young jet and
        // a fast drift stretch
        const va = u * (1 - Math.exp(-a / tu)), vz = 7 * Math.exp(-a / tw) + wb * Math.exp(-a / tbz);
        const gvx = wx * va, gvy = wy * va, VX = gvx * R0 + gvy * R1, VY = -(gvx * D0 + gvy * D1) * SIN_T - vz * COS_T, vm = Math.hypot(VX, VY);
        const st2 = Math.min(0.75, vm / (R * 0.9 + 2)) * (1 - 0.5 * smooth(life * 0.3, life, a));
        PVX[np] = vm > 1e-6 ? Math.abs(VX / vm) * st2 : 0; PVY[np] = vm > 1e-6 ? Math.abs(VY / vm) * st2 : 0;
        if (X - R < bx0) bx0 = X - R; if (X + R > bx1) bx1 = X + R; if (Y - R < by0) by0 = Y - R; if (Y + R > by1) by1 = Y + R;
        np++; cnt++;
      }
      // the stack's own top stays in the box (it is rubbed out of the puffs behind it)
      if (st.sx - st.r1 < bx0) bx0 = st.sx - st.r1; if (st.sx + st.r1 > bx1) bx1 = st.sx + st.r1;
    }
    // far to near (insertion sort: a hundred-odd items, no allocation)
    for (let i = 0; i < np; i++) {
      const v = i, d = PD[v];
      let j = i - 1;
      while (j >= 0 && PD[ORD[j]] < d) { ORD[j + 1] = ORD[j]; j--; }
      ORD[j + 1] = v;
    }
    for (let i = 0; i < stacks.length; i++) {
      let j = i - 1;
      while (j >= 0 && stacks[SORD[j]].sd < stacks[i].sd) { SORD[j + 1] = SORD[j]; j--; }
      SORD[j + 1] = i;
    }
    // the grown plume's drift (a puff 6 s old: the wind picked up, the jet spent)
    const a6 = 6, va = u * (1 - Math.exp(-a6 / tu)), vz = 7 * Math.exp(-a6 / tw) + wb * Math.exp(-a6 / tbz);
    DVX = (wx * va) * R0 + (wy * va) * R1; DVY = -((wx * va) * D0 + (wy * va) * D1) * SIN_T - vz * COS_T;
    simRot = view.rot; simT = T;
  }

  // a conservative screen-metre box round each stack's plume (from the mouth downwind, as far as it can reach, with
  // room for its rise, its sway and its biggest puffs): is any of it on the screen?
  function mayShow() {
    const o = geo.ROTS[view.rot], s = view.s, hw = view.w / 2 / s, hh = view.h / 2 / s;
    const u = Math.hypot(ux, uy), nx = u > 1e-6 ? -uy / u : -1, ny = u > 1e-6 ? ux / u : 0;
    const wR = ny * o.R[0] - nx * o.R[1], wD = ny * o.D[0] - nx * o.D[1], wD2 = wD < 0 ? wD * 0.3 : wD;
    const reach = u * P.life * 1.1 + 20, pad = 70, rise = 90;
    const ex = reach * wR, ey = -reach * wD2 * SIN_T;
    for (const st of stacks) {
      const X = st.x * o.R[0] + st.y * o.R[1], d = st.x * o.D[0] + st.y * o.D[1], Y = -(d * SIN_T + st.z * COS_T);
      if (Math.max(X, X + ex) + pad < view.X - hw || Math.min(X, X + ex) - pad > view.X + hw) continue;
      if (Math.max(Y, Y + ey) + pad < view.Y - hh || Math.min(Y, Y + ey) - rise * COS_T - pad > view.Y + hh) continue;
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- two pictures
  // The grown plume (puffs older than A0..A1 s: big, soft, slow; most of the pixels) is drawn into a low-resolution
  // picture a few times a second and slid along with its drift in between; the young jet at the mouths (small, quick)
  // into a second, sharper one at the animation's pace. A puff crosses from one to the other by a cross-fade counted on
  // the old picture's clock, so the two always add up.
  const A0 = 1.6, A1 = 2.8;
  function makeBuf() {
    const c = makeCanvas(64, 64);
    return { c, g: c.getContext("2d"), ok: false, X0: 0, Y0: 0, X1: 0, Y1: 0, k: 1, w: 0, h: 0, rot: -1, s: 0, usedW: 0, usedH: 0, T: -1e9, vx: 0, vy: 0, bx0: 0, by0: 0, bx1: 0, by1: 0 };
  }
  const bufO = makeBuf(), bufY = makeBuf();
  // the share of puff j in the old picture (1) or the young one (0)
  const oldShare = (j) => smooth(A0, A1, PG[j] - (simT - bufO.T));
  function render(b, old, dpr) {
    const s = view.s, hw = view.w / 2 / s, hh = view.h / 2 / s, mx = hw * 0.25 + 24 / s, my = hh * 0.25 + 24 / s;
    b.T = simT;   // (first: the old picture's clock is what the shares are counted on)
    // the box of its own puffs
    let qx0 = Infinity, qy0 = Infinity, qx1 = -Infinity, qy1 = -Infinity;
    for (let j = 0; j < np; j++) {
      const w = old ? oldShare(j) : 1 - oldShare(j);
      if (w < 0.01) continue;
      const R = PR[j] * 1.8;
      if (PX[j] - R < qx0) qx0 = PX[j] - R; if (PX[j] + R > qx1) qx1 = PX[j] + R; if (PY[j] - R < qy0) qy0 = PY[j] - R; if (PY[j] + R > qy1) qy1 = PY[j] + R;
    }
    b.bx0 = qx0; b.by0 = qy0; b.bx1 = qx1; b.by1 = qy1; b.rot = view.rot; b.s = s; b.vx = old ? DVX : 0; b.vy = old ? DVY : 0;
    const rx0 = Math.max(qx0, view.X - hw - mx), rx1 = Math.min(qx1, view.X + hw + mx);
    const ry0 = Math.max(qy0, view.Y - hh - my), ry1 = Math.min(qy1, view.Y + hh + my);
    if (rx1 <= rx0 || ry1 <= ry0) { b.ok = false; b.X0 = rx0; b.X1 = rx1; b.Y0 = ry0; b.Y1 = ry1; return; }
    // soft stuff: the old picture at half the screen's resolution once it is a fair size (the stamps' cost goes with
    // its pixels), the young one sharper
    const kb = old ? Math.min(s * (s < 1.2 ? Math.min(dpr, 1.5) : 0.5), Math.sqrt(BUDGET / ((rx1 - rx0) * (ry1 - ry0))))
      : Math.min(s * Math.min(dpr, 1.5) * (s < 2.5 ? 1 : 0.7), Math.sqrt(BUDGET_Y / ((rx1 - rx0) * (ry1 - ry0))));
    const bw = Math.ceil((rx1 - rx0) * kb) + 2, bh = Math.ceil((ry1 - ry0) * kb) + 2;
    const c = b.c, g = b.g;
    if (c.width < bw || c.height < bh) {
      c.width = Math.max(c.width, Math.ceil(bw * 1.2)); c.height = Math.max(c.height, Math.ceil(bh * 1.2));
      b.usedW = b.usedH = 0;
    }
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, Math.max(b.usedW, bw), Math.max(b.usedH, bh));
    b.usedW = bw; b.usedH = bh;
    sprites();
    const X0 = rx0 - 1 / kb, Y0 = ry0 - 1 / kb;
    for (let k = 0; k < stacks.length; k++) stacks[k].done = false;
    let si = 0;
    const offX = LC.offX, offY = LC.offY, litK = LC.litK, litA = LC.litA, glowA = LC.glowA;
    for (let q = 0; q < np; q++) {
      const j = ORD[q];
      // past a stack (nearer than it now): its shaft and the front of its rim hide what came before
      while (si < stacks.length && PD[j] < stacks[SORD[si]].sd - 1.5) { rubOut(b, stacks[SORD[si]], X0, Y0, kb); si++; }
      const share = old ? oldShare(j) : 1 - oldShare(j);
      if (share < 0.01) continue;
      const r = PR[j] * kb, cx = (PX[j] - X0) * kb, cy = (PY[j] - Y0) * kb, A = PA[j] * share;
      if (cx + 2 * r < 0 || cx - 2 * r > bw || cy + 2 * r < 0 || cy - 2 * r > bh) continue;
      // axis-aligned stamps only (a rotated drawImage costs several times more on a CPU canvas)
      const v = PV[j], rx = r * (1 + PVX[j]), ry = r * (1 + PVY[j]);
      g.globalAlpha = A;
      g.drawImage(shadeSpr[v], cx - rx, cy - ry, 2 * rx, 2 * ry);
      if (r < 1.5 || A * litA < 0.03) continue;
      // the lit side, wandering a little round the light's direction as the puff rolls
      const w = PT[j], lx = (offX * cw(w) - offY * sw(w)) * r, ly = (offX * sw(w) + offY * cw(w)) * r;
      g.globalAlpha = A * litA;
      g.drawImage(litSpr[v], cx + lx - rx * litK, cy + ly - ry * litK, 2 * rx * litK, 2 * ry * litK);
      if (glowA > 0.01) {
        // the city's light from below, strongest near the plant's roof
        const ga = A * glowA * Math.exp(-PH[j] / 35);
        if (ga > 0.01) {
          g.globalAlpha = ga;
          g.drawImage(glowSpr, cx - rx * 0.85, cy + 0.36 * ry - ry * 0.7, 1.7 * rx, 1.4 * ry);
        }
      }
    }
    while (si < stacks.length) { rubOut(b, stacks[SORD[si]], X0, Y0, kb); si++; }
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
    b.ok = true; b.X0 = X0; b.Y0 = Y0; b.X1 = rx1; b.Y1 = ry1; b.k = kb; b.w = bw; b.h = bh;
  }
  // the stack's shaft and the front half of its rim, out of what is drawn so far (the steam behind it)
  function rubOut(b, st, X0, Y0, kb) {
    if (st.done) return;
    st.done = true;
    const cx = (st.sx - X0) * kb, cy = (st.sy - Y0) * kb, rf = st.flue * kb, r1 = st.r1 * kb, r0 = st.r0 * kb;
    const foot = cy + (st.z - st.z0) * COS_T * kb;
    if (cx + r0 < 0 || cx - r0 > b.w + 2 || foot < 0 || cy - r1 > b.h + 2) return;
    const g = b.g;
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1;
    g.globalCompositeOperation = "destination-out";
    g.beginPath();
    g.moveTo(cx - r1, cy);
    g.lineTo(cx - rf, cy);
    g.ellipse(cx, cy, rf, rf * SIN_T, 0, Math.PI, 0, true);
    g.lineTo(cx + r1, cy);
    g.lineTo(cx + r0, foot); g.lineTo(cx - r0, foot);
    g.fill();
    g.globalCompositeOperation = "source-over";
  }
  // does picture b need drawing again for this view? (turned, zoomed, or the screen reached past what it holds)
  function stale(b, f, T) {
    if (b.rot !== view.rot || b.T < -1e8) return true;
    const s = f.s;
    if ((!f.moving && Math.abs(b.s - s) > 1e-6 * s) || Math.abs(Math.log(b.s / s)) > 0.4) return true;
    const ox = b.vx * (T - b.T), oy = b.vy * (T - b.T), hw = f.w / 2 / s, hh = f.h / 2 / s;
    const sx0 = view.X - hw - ox, sx1 = view.X + hw - ox, sy0 = view.Y - hh - oy, sy1 = view.Y + hh - oy;
    if (!b.ok) return b.bx1 > sx0 && b.bx0 < sx1 && b.by1 > sy0 && b.by0 < sy1;   // it was off screen: is it on now?
    return (b.bx0 < b.X0 && sx0 < b.X0) || (b.bx1 > b.X1 && sx1 > b.X1) || (b.by0 < b.Y0 && sy0 < b.Y0) || (b.by1 > b.Y1 && sy1 > b.Y1);
  }
  // lay picture b on the map (slid along its drift); → the CSS-px rectangle it covers on screen, into BL
  const BL = [0, 0, 0, 0];
  function blit(ctx, b, f, T, alpha) {
    const s = f.s, k = s / b.k, t = T - b.T;
    const dx = (b.X0 + b.vx * t - view.X) * s + f.w / 2, dy = (b.Y0 + b.vy * t - view.Y) * s + f.h / 2, dw = b.w * k, dh = b.h * k;
    BL[0] = Math.max(0, dx); BL[1] = Math.max(0, dy); BL[2] = Math.min(f.w, dx + dw); BL[3] = Math.min(f.h, dy + dh);
    if (BL[2] <= BL[0] || BL[3] <= BL[1]) return false;
    ctx.globalAlpha = alpha;
    ctx.drawImage(b.c, 0, 0, b.w, b.h, dx, dy, dw, dh);
    return true;
  }

  // ---------------------------------------------------------------- the clock
  let calm = reduceMQ.matches;
  if (reduceMQ.addEventListener) reduceMQ.addEventListener("change", (e) => { calm = e.matches; app.requestRender("steam"); });
  const T_CALM = (Date.now() - EPOCH) / 1000;
  const clock = () => (calm ? T_CALM : (Date.now() - EPOCH) / 1000);

  // ---------------------------------------------------------------- the layer
  let want = 0, vis = 0, lastT = -1, shown = false, zoomA = 0;
  function off() { want = 0; vis = 0; shown = false; app.whimsy.steam = 0; }
  app.addLayer({
    id: "steam", z: 83,
    draw(ctx, f) {
      if (!app.layerEnabled("sky")) { off(); bufO.ok = bufY.ok = false; bufO.T = bufY.T = -1e9; return; }
      const s = f.s;
      zoomA = smooth(ZOOM0, ZOOM1, s);
      easeWind(f.dt);
      if (zoomA <= 0.001 || !mayShow()) { off(); lastT = -1; return; }
      const T = clock();
      // the last count of the puffs put them all well off screen: look again only now and then
      if (!shown && simRot === view.rot && T - simT < 1.5 && T >= simT) {
        const hw = f.w / 2 / s + 30, hh = f.h / 2 / s + 30;
        if (bx1 < view.X - hw || bx0 > view.X + hw || by1 < view.Y - hh || by0 > view.Y + hh) { off(); return; }
      }
      // paces: the young jet moves ~6 m/s; the grown plume's picture is slid every frame and redrawn when its own
      // changes (growth, sway) would add up to a few pixels
      const dpx = Math.hypot(DVX, DVY) * s;
      const rateY = calm ? 0 : Math.max(1, Math.min(10, Math.max(Math.hypot(ux, uy), 6) * s * 0.9));
      const rateO = calm ? 0 : Math.max(0.4, Math.min(4, dpx / 10));
      const reO = stale(bufO, f, T) || simRot !== view.rot || (rateO > 0 && T - bufO.T >= 1 / rateO);
      const reY = reO || stale(bufY, f, T) || (rateY > 0 && T - bufY.T >= 0.92 / rateY);
      if (reY) {
        light();
        simulate(T);
        if (reO) render(bufO, true, f.dpr);
        render(bufY, false, f.dpr);
      }
      // the plant's bigger breath: a hiss when it starts in plain view
      if (lastT > 0 && T > lastT && T - lastT < 5) {
        const w = Math.floor(T / SIGH), t0 = w * SIGH + 20 + hash01(w, 77) * (SIGH - 40);
        if (lastT < t0 && T >= t0 && vis > 0.2 && s >= 1) cue("hiss", stacks[Math.floor(hash01(w, 78) * stacks.length)]);
      }
      lastT = T;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const onO = bufO.ok && blit(ctx, bufO, f, T, zoomA);
      if (onO) { x0 = BL[0]; y0 = BL[1]; x1 = BL[2]; y1 = BL[3]; }
      const onY = bufY.ok && blit(ctx, bufY, f, T, zoomA);
      if (onY) { x0 = Math.min(x0, BL[0]); y0 = Math.min(y0, BL[1]); x1 = Math.max(x1, BL[2]); y1 = Math.max(y1, BL[3]); }
      ctx.globalAlpha = 1;
      shown = onO || onY;
      if (!shown) { off(); return; }
      // how much plume shows: its density and how big it is on screen
      vis = clamp01(P.dens * zoomA * smooth(12, 160, Math.sqrt((x1 - x0) * (y1 - y0))) * 1.2);
      app.whimsy.steam = Math.round(vis * 100) / 100;
      want = Math.max(onY ? rateY : 0, onO && !calm ? Math.max(1, Math.min(10, dpx)) : 0);
    },
    fps() { return app.layerEnabled("sky") && shown ? want : 0; },
    hit(px, py) {
      if (!shown || !np || zoomA < 0.3 || simRot !== view.rot) return null;
      const s = view.s, X = (px - view.w / 2) / s + view.X, Y = (py - view.h / 2) / s + view.Y, pad = (app.mobile ? 14 : 10) / s;
      if (X < bx0 - pad || X > bx1 + pad || Y < by0 - pad || Y > by1 + pad) return null;
      // a puff that shows (not its faint rim), or the mouth a plume leaves
      let best = -1, bd = Infinity;
      for (let j = 0; j < np; j++) {
        if (PA[j] * zoomA < 0.1) continue;
        const rr = PR[j] * 0.78 + pad * 0.6, dx = X - PX[j], dy = Y - PY[j], d = dx * dx + dy * dy;
        if (d <= rr * rr && d < bd) { bd = d; best = PK[j]; }
      }
      if (best >= 0) return stacks[best];
      for (const st of stacks) {
        const dx = X - st.sx, dy = Y - (st.sy - 1.5), r = st.r1 + pad;
        if (dx * dx + dy * dy <= r * r && P.dens > 0.1) return st;
      }
      return null;
    },
    onClick(st) { cue("hiss", st); openCard(st); },
  });

  function cue(name, st) {
    try { if (app.sound && app.sound.cue) app.sound.cue(name, { x: st.x, y: st.y }); } catch (e) { /* sound is optional */ }
  }

  // ---------------------------------------------------------------- the card
  let cardH = null, cardSt = null;
  function forecast() {
    const d = P.dens;
    const word = d > 0.85 ? "Big, billowy and very photogenic" : d > 0.62 ? "Thick and fluffy" : d > 0.4 ? "Steady, modest puffs"
      : d > 0.2 ? "Thin wisps" : d > 0.08 ? "Shy, see-through wisps" : "Barely there";
    const line = d > 0.85 ? "A fine day for steam-spotting." : d > 0.62 ? "Cold air makes the best clouds." : d > 0.4 ? "Mild enough to keep it modest."
      : d > 0.2 ? "It vanishes a few puffs out." : d > 0.08 ? "Too warm for much of a show." : "Too warm for the steam to show off: it is gone almost as soon as it leaves.";
    return { word, line };
  }
  function leanText() {
    const W = app.weather || {};
    const mph = P.mph;
    if (mph < 3) return "rising almost straight up";
    const to = (((+W.windDir || 0) + 180) % 360);
    const dir = COMPASS[Math.round(to / 22.5) % 16];
    return mph > 18 ? `blown nearly flat toward the ${dir}` : `leaning toward the ${dir}`;
  }
  function buildBody(st) {
    const W = app.weather || {};
    const fc = forecast();
    const el = document.createElement("div");
    el.className = "steam-card";
    const pct = Math.round(P.dens * 100);
    const temp = Number.isFinite(W.tempF) ? `${Math.round(W.tempF)}°F` : "";
    const wind = P.mph >= 1 ? `${Math.round(P.mph)} mph` : "calm";
    const breath = P.temp <= 45 ? "You could probably see your own breath out there too." : P.temp <= 55 ? "Your own breath? Maybe, on a damp morning." : "Too warm to see your own breath.";
    el.innerHTML =
      `<p class="steam-kicker">Today's plume forecast</p>` +
      `<p class="steam-big">${esc(fc.word)}</p>` +
      `<div class="steam-meter" role="img" aria-label="Plume-o-meter ${pct} percent"><span style="width:${Math.max(3, pct)}%"></span></div>` +
      `<p class="steam-line">${esc(fc.line)} ${esc(P.dens > 0.08 ? `The plume is ${leanText()}.` : "")}</p>` +
      `<dl class="steam-grid">` +
      (temp ? `<dt>Air</dt><dd>${esc(temp)}</dd>` : "") +
      `<dt>Wind</dt><dd>${esc(wind)}</dd>` +
      `<dt>Breath check</dt><dd>${esc(breath)}</dd>` +
      `</dl>` +
      `<p class="steam-note">${esc(st.name)} is Ohio State's power and heating plant: steam made here travels through pipes under campus to warm the buildings. ` +
      `The white cloud over its stacks is water, condensing into tiny droplets as the warm, damp exhaust meets colder air, the same way your breath turns white on a winter morning. The colder and damper the day, the bigger the cloud.</p>` +
      `<p class="steam-src">${esc(MAX ? "Thick plumes forced on (?steam=max)." : W.source === "test" ? "Drawn from test weather, not seen." : "Drawn from the live temperature and wind, not a camera.")}</p>`;
    return el;
  }
  function openCard(st) {
    const ui = app.ui;
    if (!ui || !ui.card) return;
    injectStyle();
    weather();
    cardSt = st;
    const W = app.weather || {};
    const sub = ["Steam plume", Number.isFinite(W.tempF) ? `${Math.round(W.tempF)}°F` : "", st.addr].filter(Boolean).join(" · ");
    cardH = ui.card({
      id: "steam", title: st.name, subtitle: sub, color: "#a7563f", body: buildBody(st),
      anchor: { x: st.x, y: st.y, z: st.z },
      onClose: () => { cardH = null; cardSt = null; },
    });
  }
  app.on("weather", () => {
    if (!cardH || !cardSt) return;
    weather();
    cardH.update({ body: buildBody(cardSt) });
  });

  function injectStyle() {
    if (document.getElementById("steam-style")) return;
    const st = document.createElement("style");
    st.id = "steam-style";
    st.textContent = `
      .steam-card { font: 13px/1.45 "Inter", system-ui, sans-serif; }
      .steam-kicker { margin: 0; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--mute, #7a7064); }
      .steam-big { margin: 2px 0 7px; font: italic 500 21px/1.15 "Fraunces", Georgia, serif; color: var(--ink, #2a2622); }
      .steam-meter { height: 8px; border-radius: 6px; background: var(--well, #f1ebdd); box-shadow: inset 0 0 0 1px var(--line, #e3dac2); overflow: hidden; }
      .steam-meter span { display: block; height: 100%; border-radius: 6px; background: linear-gradient(90deg, #c9d2df, #f4f1ea 70%, #fffdf8); box-shadow: inset 0 -2px 3px rgba(120, 132, 156, .35); }
      .steam-line { margin: 8px 0 8px; }
      .steam-grid { display: grid; grid-template-columns: auto 1fr; gap: 3px 14px; margin: 0; }
      .steam-grid dt { color: var(--mute, #7a7064); }
      .steam-grid dd { margin: 0; min-width: 0; }
      .steam-note { margin: 9px 0 0; padding: 7px 10px; border-radius: 8px; background: var(--well, #f1ebdd); font-size: 12.5px; }
      .steam-src { margin: 8px 0 0; font-size: 11px; color: var(--mute, #7a7064); }
    `;
    document.head.append(st);
  }

  // first numbers for whoever reads them before a frame
  weather();
}
