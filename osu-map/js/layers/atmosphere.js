// The real sky over campus: the sun where it really is above Columbus and the light it gives (plain day, golden hour,
// dusk, a deep blue night with lit windows and lamp pools), the moon and stars on the paper around the diorama, and the
// live weather from Open-Meteo: cloud shadows drifting with the wind, rain, snow (which also settles on the tiles), fog
// and the odd lightning flash. Publishes app.weather (ARCHITECTURE.md) and emits "weather" when it changes meaningfully.
//
// Layers: "sky" z 80 (cloud shadows, the light grade, stars, moon) · "sky-lights" z 82 (the night-lights tiles) ·
// "sky-weather" z 88 (fog, rain, snow, lightning). One toggle, "sky", switches all three.

const LAT = 40.0, LON = -83.02;
const WX_URL = "https://api.open-meteo.com/v1/forecast?latitude=40.0&longitude=-83.02&current=temperature_2m,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,precipitation,rain,snowfall,snow_depth,is_day,visibility&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York";
const WX_EVERY = 10 * 60e3, WX_RETRY = 2 * 60e3, WX_TIMEOUT = 12e3;
const RAD = Math.PI / 180;
const PARTICLE_CAP = 600;

// ------------------------------------------------------------------------------------------------ small maths
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const num = (v, d) => (v == null || v === "" || typeof v === "boolean" || !Number.isFinite(+v) ? d : +v);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const byte = (v) => Math.max(0, Math.min(255, Math.round(v)));
const hex = (r, g, b) => "#" + ((1 << 24) | (byte(r) << 16) | (byte(g) << 8) | byte(b)).toString(16).slice(1);
const rgba = (r, g, b, a) => `rgba(${byte(r)},${byte(g)},${byte(b)},${Math.max(0, Math.min(1, a)).toFixed(3)})`;

// ------------------------------------------------------------------------------------------------ sun and moon (after SunCalc)
const DAY_MS = 86400000, J2000_MS = Date.UTC(2000, 0, 1, 12), OBLIQ = 23.4397 * RAD;
const sidereal = (d) => RAD * (280.16 + 360.9856235 * d) + RAD * LON;
const PHI = LAT * RAD;

/** Sun's ecliptic longitude → equatorial coordinates (dec, ra), radians. */
function sunEq(d, out) {
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  out.dec = Math.asin(Math.sin(OBLIQ) * Math.sin(L));
  out.ra = Math.atan2(Math.sin(L) * Math.cos(OBLIQ), Math.cos(L));
  return out;
}
function moonEq(d, out) {
  const L = RAD * (218.316 + 13.176396 * d), M = RAD * (134.963 + 13.064993 * d), F = RAD * (93.272 + 13.22935 * d);
  const l = L + RAD * 6.289 * Math.sin(M), b = RAD * 5.128 * Math.sin(F);
  out.dist = 385001 - 20905 * Math.cos(M);
  out.ra = Math.atan2(Math.sin(l) * Math.cos(OBLIQ) - Math.tan(b) * Math.sin(OBLIQ), Math.cos(l));
  out.dec = Math.asin(Math.sin(b) * Math.cos(OBLIQ) + Math.cos(b) * Math.sin(OBLIQ) * Math.sin(l));
  return out;
}
/** equatorial → altitude and compass azimuth (degrees; 0 = north, clockwise) over campus */
function toHorizon(d, eq, out) {
  const H = sidereal(d) - eq.ra;
  out.alt = Math.asin(Math.sin(PHI) * Math.sin(eq.dec) + Math.cos(PHI) * Math.cos(eq.dec) * Math.cos(H)) / RAD;
  out.az = (Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(PHI) - Math.tan(eq.dec) * Math.cos(PHI)) / RAD + 540) % 360;
  return out;
}
const _se = { dec: 0, ra: 0 }, _me = { dec: 0, ra: 0, dist: 0 }, _hz = { alt: 0, az: 0 };
function sunAt(ms, out) { const d = (ms - J2000_MS) / DAY_MS; return toHorizon(d, sunEq(d, _se), out); }
function moonAt(ms, out) {
  const d = (ms - J2000_MS) / DAY_MS;
  moonEq(d, _me); sunEq(d, _se);
  toHorizon(d, _me, out);
  const sdist = 149598000;
  const phi = Math.acos(Math.sin(_se.dec) * Math.sin(_me.dec) + Math.cos(_se.dec) * Math.cos(_me.dec) * Math.cos(_se.ra - _me.ra));
  const inc = Math.atan2(sdist * Math.sin(phi), _me.dist - sdist * Math.cos(phi));
  const ang = Math.atan2(Math.cos(_se.dec) * Math.sin(_se.ra - _me.ra), Math.sin(_se.dec) * Math.cos(_me.dec) - Math.cos(_se.dec) * Math.sin(_me.dec) * Math.cos(_se.ra - _me.ra));
  out.fraction = (1 + Math.cos(inc)) / 2;
  out.phase = 0.5 + (0.5 * inc * (ang < 0 ? -1 : 1)) / Math.PI;   // 0 new · .25 first quarter · .5 full · .75 last quarter
  return out;
}
/** The next sunrise or sunset after ms (the sun's top limb crossing the horizon, refraction included). */
function nextSunEvent(ms) {
  const f = (t) => sunAt(t, _hz).alt + 0.833;
  let a = ms, fa = f(a);
  for (let i = 0; i < 160; i++) {
    const b = a + 10 * 60e3, fb = f(b);
    if ((fa < 0) !== (fb < 0)) {
      let lo = a, hi = b;
      for (let k = 0; k < 14; k++) { const m = (lo + hi) / 2; if ((f(m) < 0) === (fa < 0)) lo = m; else hi = m; }
      return { ms: (lo + hi) / 2, rise: fa < 0 };
    }
    a = b; fa = fb;
  }
  return null;
}
function moonName(p, lit) {
  if (lit > 0.985) return "Full moon";
  if (lit < 0.015) return "New moon";
  const waxing = p < 0.5;
  if (Math.abs(lit - 0.5) < 0.04) return waxing ? "First quarter" : "Last quarter";
  return (waxing ? "Waxing " : "Waning ") + (lit < 0.5 ? "crescent" : "gibbous");
}

// ------------------------------------------------------------------------------------------------ weather vocabulary
// WMO weather codes → short text (by day, by night where they differ)
const WMO = {
  0: ["Sunny", "Clear"], 1: ["Mostly sunny", "Mostly clear"], 2: ["Partly cloudy"], 3: ["Overcast"],
  45: ["Fog"], 48: ["Freezing fog"],
  51: ["Light drizzle"], 53: ["Drizzle"], 55: ["Heavy drizzle"], 56: ["Freezing drizzle"], 57: ["Freezing drizzle"],
  61: ["Light rain"], 63: ["Rain"], 65: ["Heavy rain"], 66: ["Freezing rain"], 67: ["Freezing rain"],
  71: ["Light snow"], 73: ["Snow"], 75: ["Heavy snow"], 77: ["Snow grains"],
  80: ["Light showers"], 81: ["Showers"], 82: ["Heavy showers"], 85: ["Snow showers"], 86: ["Heavy snow showers"],
  95: ["Thunderstorm"], 96: ["Thunderstorm, hail"], 99: ["Thunderstorm, hail"],
};
const RAIN_I = { 51: 0.25, 53: 0.35, 55: 0.5, 56: 0.3, 57: 0.5, 61: 0.4, 63: 0.65, 65: 0.9, 66: 0.45, 67: 0.8, 80: 0.45, 81: 0.7, 82: 1, 95: 0.9, 96: 1, 99: 1 };
const SNOW_I = { 71: 0.35, 73: 0.6, 75: 0.9, 77: 0.3, 85: 0.5, 86: 0.85 };
// ?weather= test presets, shaped like Open-Meteo's "current" block
const PRESETS = {
  clear: { temperature_2m: 52, weather_code: 0, cloud_cover: 3, wind_speed_10m: 6, wind_direction_10m: 240, visibility: 30000 },
  cloudy: { temperature_2m: 47, weather_code: 2, cloud_cover: 58, wind_speed_10m: 11, wind_direction_10m: 250, visibility: 24000 },
  overcast: { temperature_2m: 44, weather_code: 3, cloud_cover: 100, wind_speed_10m: 9, wind_direction_10m: 270, visibility: 16000 },
  rain: { temperature_2m: 46, weather_code: 63, cloud_cover: 100, wind_speed_10m: 13, wind_direction_10m: 230, precipitation: 2.4, rain: 2.4, visibility: 7000 },
  snow: { temperature_2m: 28, weather_code: 73, cloud_cover: 100, wind_speed_10m: 8, wind_direction_10m: 300, precipitation: 0.9, snowfall: 1.3, snow_depth: 0.06, visibility: 2600 },
  fog: { temperature_2m: 41, weather_code: 45, cloud_cover: 100, wind_speed_10m: 3, wind_direction_10m: 190, visibility: 300 },
  storm: { temperature_2m: 63, weather_code: 95, cloud_cover: 100, wind_speed_10m: 22, wind_direction_10m: 245, precipitation: 7, rain: 7, visibility: 4000 },
};
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

// ------------------------------------------------------------------------------------------------ the light, by sun altitude
// alt° · multiply r g b (0..1) · glow r g b a (screened in from the sun's side) · sky r g b (how the paper around the
// diorama should finally look). Night bottoms out near 40 % brightness: dark and blue, but every street still reads.
const GRADE = [
  [28, 1, 1, 1, 255, 214, 160, 0, 239, 233, 219],
  [14, 1, 0.99, 0.965, 255, 206, 150, 0, 240, 232, 214],
  [7, 1, 0.96, 0.89, 255, 196, 128, 0.16, 243, 228, 203],
  [2.5, 1, 0.885, 0.76, 255, 170, 100, 0.27, 242, 214, 182],
  [-0.8, 0.95, 0.775, 0.75, 255, 148, 108, 0.27, 232, 192, 180],
  [-3.5, 0.77, 0.67, 0.8, 250, 136, 128, 0.19, 168, 150, 186],
  [-6, 0.585, 0.545, 0.74, 210, 128, 168, 0.08, 98, 96, 146],
  [-9, 0.43, 0.465, 0.675, 170, 130, 180, 0, 48, 56, 92],
  [-13, 0.36, 0.415, 0.615, 170, 130, 180, 0, 27, 34, 58],
];

/** WebGL-free fractal value noise that tiles seamlessly, 0..1 */
function tileNoise(N, seed) {
  const out = new Float32Array(N * N);
  const hash = (x, y, o) => {
    let h = (x * 374761393 + y * 668265263 + o * 2147483647 + seed * 1442695041) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const q = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  let amp = 1, total = 0;
  for (let o = 0; o < 5; o++) {
    const P = 5 << o, cell = N / P;
    for (let y = 0; y < N; y++) {
      const fy = y / cell, iy = Math.floor(fy), ty = q(fy - iy);
      for (let x = 0; x < N; x++) {
        const fx = x / cell, ix = Math.floor(fx), tx = q(fx - ix);
        const a = hash(ix % P, iy % P, o), b = hash((ix + 1) % P, iy % P, o);
        const c = hash(ix % P, (iy + 1) % P, o), d = hash((ix + 1) % P, (iy + 1) % P, o);
        out[y * N + x] += amp * lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
      }
    }
    total += amp; amp *= 0.5;
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < out.length; i++) { const v = out[i] / total; out[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) / (hi - lo || 1);
  return out;
}
function inRing(f, x, y) {
  let inside = false;
  for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) {
    const xi = f[i], yi = f[i + 1], xj = f[j], yj = f[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function makeCanvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }

// ================================================================================================ the module
export function init(app) {
  const { view, geo, data } = app;
  const world = data.world;
  const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");
  let calm = reduceMQ.matches;
  if (reduceMQ.addEventListener) reduceMQ.addEventListener("change", (e) => { calm = e.matches; });
  const tileSnowFixed = app.params.has("snow");           // ?snow= wins over the weather
  const preset = PRESETS[(app.params.get("weather") || "").trim().toLowerCase()] || null;
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  const fmtTime = (ms) => clock.format(ms).replace(/\s?([AP])M$/, (m, a) => (a === "A" ? " am" : " pm"));

  // ---------------------------------------------------------------- the published state (one object, mutated in place)
  const W = (app.weather = {
    tempF: null, code: null, text: "", cloud: 0, windMph: 0, windDir: 0, precipMm: 0, snowDepthM: 0, isDay: true,
    sunAlt: 0, sunAz: 180, phase: "day", night: 0,
    // extras: intensities 0..1 the effects use, visibility, the moon, where the data came from
    rain: 0, snow: 0, fog: 0, storm: false, visibilityM: null, snowfallCm: 0,
    moon: { alt: -90, az: 0, fraction: 0, phase: 0, name: "" },
    source: "none", updated: null,
  });
  const sun = { alt: 0, az: 180 };
  let wxVer = 0, wxSig = "";

  // ---------------------------------------------------------------- weather data
  function applyWeather(c, source) {
    const code = Math.round(num(c.weather_code, 0)), tf = num(c.temperature_2m, NaN);
    W.code = WMO[code] ? code : code >= 0 && code < 100 ? code : 0;
    W.tempF = Number.isFinite(tf) && tf > -80 && tf < 140 ? tf : null;
    W.cloud = Math.max(0, Math.min(100, num(c.cloud_cover, W.code >= 3 ? 100 : W.code * 30)));   // percent
    W.windMph = Math.max(0, Math.min(120, num(c.wind_speed_10m, 0)));
    W.windDir = ((num(c.wind_direction_10m, 0) % 360) + 360) % 360;
    W.precipMm = Math.max(0, num(c.precipitation, 0));
    W.snowfallCm = Math.max(0, num(c.snowfall, 0));
    // out-of-range readings count as missing rather than as a blizzard or a pea-souper
    const depth = num(c.snow_depth, 0), vis = num(c.visibility, -1);
    W.snowDepthM = depth > 0 && depth < 4 ? depth : 0;
    W.visibilityM = vis >= 0 && vis < 1e6 ? vis : null;
    const rainMm = Math.max(0, num(c.rain, 0));
    // the code says what kind; the measured amounts catch what the code misses (a shower inside a "cloudy" hour)
    W.rain = RAIN_I[W.code] || (rainMm > 0.05 ? Math.min(1, 0.25 + rainMm / 4) : 0);
    W.snow = SNOW_I[W.code] || (W.snowfallCm > 0.02 ? Math.min(1, 0.3 + W.snowfallCm / 2) : 0);
    if (W.snow && W.rain && !RAIN_I[W.code]) W.rain = 0;
    const visM = W.visibilityM;
    W.fog = Math.max(W.code === 45 ? 0.75 : W.code === 48 ? 0.85 : 0, visM != null && visM < 2000 ? smooth(2000, 250, visM) * 0.9 : 0);
    W.storm = W.code >= 95;
    W.source = source;
    W.updated = new Date();
    updateText();
    updateStatus();   // the "updated" time and tooltip may move even when the weather doesn't
    // only a real change re-grades the light and tells the other modules
    const sig = `${W.code}|${W.tempF == null ? "" : Math.round(W.tempF)}|${Math.round(W.cloud / 4)}|${Math.round(W.windMph)}|${Math.round(W.windDir / 10)}|${W.rain}|${W.snow}|${W.fog.toFixed(2)}|${W.snowDepthM.toFixed(3)}|${source}`;
    if (sig === wxSig) return;
    wxSig = sig;
    wxVer++;
    updateTileSnow();
    app.emit("weather", W);
  }

  let fetchTimer = 0, lastOk = 0, inflight = false, failures = 0;
  const schedule = (ms) => { clearTimeout(fetchTimer); fetchTimer = setTimeout(fetchWeather, ms); };
  async function fetchWeather() {
    if (inflight) return;
    if (document.hidden && lastOk) { schedule(WX_EVERY); return; }   // nobody's looking: catch up on visibilitychange
    inflight = true;
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeout = setTimeout(() => ctl && ctl.abort(), WX_TIMEOUT);
    try {
      const r = await fetch(WX_URL, { signal: ctl ? ctl.signal : undefined, cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!j || typeof j.current !== "object" || !j.current) throw new Error("no current conditions");
      applyWeather(j.current, "live");
      lastOk = Date.now(); failures = 0;
      schedule(WX_EVERY);
    } catch (e) {
      failures++;
      if (failures === 1) console.info("weather unavailable for now:", e && e.message);
      schedule(Math.min(WX_EVERY, WX_RETRY * failures));
    } finally {
      clearTimeout(timeout);
      inflight = false;
    }
  }
  // snow on the tiles: coarse levels with a little hysteresis, because every change redraws every tile
  let tileSnow = num(app.tileStyle && app.tileStyle.snow, 0);
  function updateTileSnow() {
    if (tileSnowFixed) return;
    const depth = W.snowDepthM;
    const settling = W.snow > 0 && (W.tempF == null || W.tempF < 36);
    let lvl = 0;
    if (depth >= 0.025 || (tileSnow >= 0.8 && depth >= 0.015)) lvl = 0.8;
    else if (depth >= 0.005 || settling || (tileSnow >= 0.4 && depth >= 0.002)) lvl = 0.4;
    if (lvl !== tileSnow) { tileSnow = lvl; app.setTileStyle({ snow: lvl }); }
  }

  function updateText() {
    const t = WMO[W.code];
    W.text = W.code == null ? "" : t ? (t[1] && !W.isDay ? t[1] : t[0]) : "";
  }

  // ---------------------------------------------------------------- status line (and a small card from it or from search)
  let statusHtml = "";
  function statusTitle() {
    const parts = [];
    if (W.windMph >= 1) parts.push(`Wind ${Math.round(W.windMph)} mph ${COMPASS[Math.round(W.windDir / 22.5) % 16]}`);
    const ev = nextSunEvent(app.now().getTime());
    if (ev) parts.push(`${ev.rise ? "Sunrise" : "Sunset"} ${fmtTime(ev.ms)}`);
    return parts.join(" · ");
  }
  function updateStatus() {
    if (!app.ui || !app.ui.status) return;
    if (W.code == null) { if (statusHtml) app.ui.status("weather", ""); statusHtml = ""; return; }
    const label = (W.tempF != null ? `${Math.round(W.tempF)}°F · ` : "") + W.text;
    const html = `<span class="wx-st" role="button" tabindex="0" title="${esc(statusTitle())}">${esc(label)}</span>`;
    if (html !== statusHtml) { statusHtml = html; app.ui.status("weather", html); }
    updateCount();
  }
  // the status line is re-rendered by the UI, so listen on the document
  document.addEventListener("click", (e) => { const el = e.target && e.target.closest && e.target.closest(".wx-st"); if (el) openCard(); });
  document.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target && e.target.classList && e.target.classList.contains("wx-st")) { e.preventDefault(); openCard(); } });

  let styleIn = false;
  function injectStyle() {
    if (styleIn) return;
    styleIn = true;
    const st = document.createElement("style");
    st.textContent = `
      .wx-st { cursor: pointer; }
      .wx-st:focus-visible { outline: 2px solid var(--scarlet, #b3202a); outline-offset: 2px; border-radius: 3px; }
      .wx-card { font: 13px/1.45 "Inter", system-ui, sans-serif; }
      .wx-now { display: flex; align-items: baseline; gap: 10px; margin: 2px 0 8px; }
      .wx-temp { font: 500 34px/1 "Fraunces", Georgia, serif; letter-spacing: -0.02em; }
      .wx-cond { font: italic 16px/1.2 "Fraunces", Georgia, serif; opacity: .85; }
      .wx-grid { display: grid; grid-template-columns: auto 1fr; gap: 3px 14px; margin: 0; }
      .wx-grid dt { opacity: .6; }
      .wx-grid dd { margin: 0; }
      .wx-src { margin-top: 8px; font-size: 11px; opacity: .55; }
    `;
    document.head.appendChild(st);
  }
  function cardBody() {
    const el = document.createElement("div");
    el.className = "wx-card";
    const ev = nextSunEvent(app.now().getTime());
    const rows = [];
    if (W.code != null) rows.push(["Wind", W.windMph >= 1 ? `${Math.round(W.windMph)} mph from the ${COMPASS[Math.round(W.windDir / 22.5) % 16]}` : "Calm"]);
    if (W.code != null) rows.push(["Clouds", `${Math.round(W.cloud)} %`]);
    if (W.visibilityM != null && W.visibilityM < 10000) rows.push(["Visibility", `${(W.visibilityM / 1609).toFixed(W.visibilityM < 1609 ? 1 : 0)} mi`]);
    if (W.snowDepthM > 0.004) rows.push(["Snow on the ground", `${Math.max(1, Math.round(W.snowDepthM * 39.37))} in`]);
    if (ev) rows.push([ev.rise ? "Sunrise" : "Sunset", fmtTime(ev.ms)]);
    rows.push(["Sun", `${Math.abs(W.sunAlt).toFixed(0)}° ${W.sunAlt >= 0 ? "high" : "below the horizon"}, ${COMPASS[Math.round(W.sunAz / 22.5) % 16]} · ${W.phase}`]);
    rows.push(["Moon", `${W.moon.name}, ${Math.round(W.moon.fraction * 100)} % lit${W.moon.alt > 0 ? "" : " (down)"}`]);
    const now = W.code == null ? "" : `<div class="wx-now"><span class="wx-temp">${W.tempF != null ? esc(Math.round(W.tempF)) + "°" : ""}</span><span class="wx-cond">${esc(W.text)}</span></div>`;
    el.innerHTML = now + `<dl class="wx-grid">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` +
      `<div class="wx-src">${W.source === "live" ? `Weather: Open-Meteo, ${esc(fmtTime(W.updated.getTime()))}` : W.source === "test" ? "Test weather (?weather=)" : "Live weather unavailable"}</div>`;
    return el;
  }
  function openCard() {
    if (!app.ui || !app.ui.card) return;
    injectStyle();
    app.ui.card({ id: "weather", title: "Sky over campus", subtitle: `Columbus, ${fmtTime(app.now().getTime())}`, body: cardBody(), anchor: null });
  }
  if (app.ui && app.ui.addSearchProvider) {
    const words = /^(weather|sky|sun|sunset|sunrise|moon|forecast|rain|snow|temp|temperature|fog|wind|clouds?)\b/i;
    app.ui.addSearchProvider((q) => {
      if (!words.test(String(q || "").trim())) return [];
      return [{ label: "Weather and sky", sub: W.code != null ? `${W.tempF != null ? Math.round(W.tempF) + "°F · " : ""}${W.text}` : "Sun, moon and light", kind: "weather", score: 0.8, go: openCard }];
    });
  }
  if (app.ui && app.ui.registerToggle) app.ui.registerToggle({ id: "sky", label: "Real sky & weather" });
  function updateCount() { if (app.ui && app.ui.setCount) app.ui.setCount("sky", W.source === "test" ? "test" : W.tempF != null ? `${Math.round(W.tempF)}°F` : ""); }

  // ---------------------------------------------------------------- the sky over time
  const L = {
    mr: 1, mg: 1, mb: 1, mulOn: false, mulVer: 0, vig: 0, tw: 0,
    gr: 255, gg: 200, gb: 140, ga: 0, glowAz: 0, glowVer: 0,
    bg: null, stars: 0, moonA: 0, cloudA: 0, cloudCov: 0, daylight: 1,
    haze: [236, 236, 233], hazeVer: 0,
  };
  const G = new Float64Array(11);
  let lastSkyMs = NaN, lastMoonMs = NaN, lightAlt = NaN, lightWx = -1, lightMoon = NaN, lightSnow = NaN;
  let emittedPhase = "", emittedNight = -1, emittedAlt = -999;

  function gradeAt(alt) {
    const n = GRADE.length;
    if (alt >= GRADE[0][0]) { for (let i = 0; i < 11; i++) G[i] = GRADE[0][i]; return; }
    if (alt <= GRADE[n - 1][0]) { for (let i = 0; i < 11; i++) G[i] = GRADE[n - 1][i]; return; }
    let k = 0;
    while (GRADE[k + 1][0] > alt) k++;
    const a = GRADE[k], b = GRADE[k + 1], t = (a[0] - alt) / (a[0] - b[0]);
    for (let i = 0; i < 11; i++) G[i] = a[i] + (b[i] - a[i]) * t;
  }

  function updateSky(ms) {
    lastSkyMs = ms;
    sunAt(ms, sun);
    W.sunAlt = sun.alt; W.sunAz = sun.az;
    W.night = smooth(1, -8, sun.alt);
    const wasDay = W.isDay;
    W.isDay = sun.alt > -0.833;
    W.phase = sun.alt >= 10 ? "day" : sun.alt >= 0 ? "golden" : sun.alt >= -6 ? (sun.az < 180 ? "dawn" : "dusk") : "night";
    if (!(Math.abs(ms - lastMoonMs) < 60e3)) {
      lastMoonMs = ms;
      moonAt(ms, W.moon);
      W.moon.name = moonName(W.moon.phase, W.moon.fraction);
    }
    if (wasDay !== W.isDay) { updateText(); updateStatus(); }
    if (W.phase !== emittedPhase || Math.abs(W.night - emittedNight) >= 0.04 || Math.abs(W.sunAlt - emittedAlt) >= 1) {
      const quiet = emittedPhase === W.phase || emittedPhase === "";
      emittedPhase = W.phase; emittedNight = W.night; emittedAlt = W.sunAlt;
      app.emit("weather", W);
      if (!quiet) updateStatus();   // the sunrise/sunset in the tooltip rolls over
    }
  }

  // the colours of the light for this sun and weather; only when something actually changed
  function computeLight() {
    const moonUp = W.moon.alt > 0 ? W.moon.fraction * smooth(0, 25, W.moon.alt) : 0;
    const tileSnowNow = num(app.tileStyle && app.tileStyle.snow, 0);
    if (Math.abs(W.sunAlt - lightAlt) < 0.04 && lightWx === wxVer && Math.abs(moonUp - lightMoon) < 0.02 && tileSnowNow === lightSnow) return;
    lightAlt = W.sunAlt; lightWx = wxVer; lightMoon = moonUp; lightSnow = tileSnowNow;
    gradeAt(W.sunAlt);
    const night = W.night, day = 1 - night;
    const cloud = clamp01(W.cloud / 100), over = smooth(0.55, 1, cloud);
    let mr = G[1], mg = G[2], mb = G[3], ga = G[7];
    let sr = G[8], sg = G[9], sb = G[10];
    // overcast: flatten the warm grade toward its own grey and cool it a touch
    const lum = 0.3 * mr + 0.59 * mg + 0.11 * mb, flat = over * 0.6;
    mr = lerp(mr, lum * 0.98, flat); mg = lerp(mg, lum * 0.995, flat); mb = lerp(mb, Math.min(1, lum * 1.03), flat);
    // weather gloom, softer at night when it is dark anyway
    const k = 1 - 0.55 * night;
    const gloom = (amt, r, g, b) => { amt = clamp01(amt) * k; mr *= 1 - amt * (1 - r); mg *= 1 - amt * (1 - g); mb *= 1 - amt * (1 - b); };
    gloom(over, 0.935, 0.945, 0.97);
    gloom(W.rain, 0.86, 0.88, 0.925);
    gloom(W.storm ? 1 : 0, 0.8, 0.82, 0.9);
    gloom(W.snow, 0.97, 0.975, 1);
    gloom(W.fog, 0.97, 0.97, 0.975);
    // a bright moon lifts the night a little; low cloud at night glows with the city's light
    const moon = moonUp * night * (1 - cloud);
    mr += 0.025 * moon; mg += 0.035 * moon; mb += 0.05 * moon;
    // snow on the ground throws the city's light back up: a snowy night is a brighter one
    const snowLift = night * clamp01(tileSnowNow);
    mr += 0.05 * snowLift; mg += 0.055 * snowLift; mb += 0.06 * snowLift;
    const cityGlow = over * night;
    mr = lerp(mr, 0.47, cityGlow * 0.25); mg = lerp(mg, 0.44, cityGlow * 0.25); mb = lerp(mb, 0.52, cityGlow * 0.25);
    ga *= (1 - 0.85 * over) * (1 - 0.8 * W.rain) * (1 - 0.7 * W.fog);
    // the paper around the diorama: greyer under cloud, a warm-brown glow at night under cloud
    const sl = 0.3 * sr + 0.59 * sg + 0.11 * sb;
    sr = lerp(sr, sl, over * 0.55 * day); sg = lerp(sg, sl, over * 0.55 * day); sb = lerp(sb, sl * 1.04, over * 0.55 * day);
    sr = lerp(sr, 62, cityGlow * 0.6); sg = lerp(sg, 55, cityGlow * 0.6); sb = lerp(sb, 66, cityGlow * 0.6);
    // dawn comes up cooler and more pastel than dusk goes down
    const dawn = W.sunAz < 180 ? smooth(6, -2, W.sunAlt) * (1 - night) : 0;
    mr *= 1 - 0.035 * dawn; mb = Math.min(1, mb * (1 + 0.03 * dawn));
    L.mr = Math.min(1, mr); L.mg = Math.min(1, mg); L.mb = Math.min(1, mb);
    // twilight: the far side of the map (the top of the screen, toward the horizon) stays lighter and warmer
    L.tw = smooth(3, -0.5, W.sunAlt) * (1 - smooth(-4.5, -8.5, W.sunAlt)) * (1 - 0.6 * over);
    L.vig = 0.16 * night;
    L.mulOn = L.mr < 0.996 || L.mg < 0.996 || L.mb < 0.996 || L.vig > 0.004 || L.tw > 0.01;
    L.mulVer++;
    // the glow: the low sun's warmth, or at night a faint cool wash from a bright moon
    const moonGlow = 0.07 * moon;
    if (ga >= moonGlow) { L.gr = G[4]; L.gg = lerp(G[5], G[5] + 12, dawn); L.gb = lerp(G[6], G[6] + 30, dawn); L.ga = ga; L.glowAz = W.sunAz; }
    else { L.gr = 190; L.gg = 205; L.gb = 240; L.ga = moonGlow; L.glowAz = W.moon.az; }
    L.glowVer++;
    // the multiply darkens the paper too, so ask for the paper colour that comes out right after it
    L.bg = hex(Math.min(255, sr / L.mr), Math.min(255, sg / L.mg), Math.min(255, sb / L.mb));
    L.stars = smooth(0.45, 0.95, night) * (1 - smooth(0.35, 0.9, cloud)) * (1 - W.fog);
    L.moonA = smooth(0.3, 0.8, night) * (1 - smooth(0.6, 1, cloud) * 0.85) * (1 - W.fog * 0.9);
    // cloud shadows need sunshine to cast them
    L.daylight = smooth(-1, 8, W.sunAlt);
    L.cloudCov = Math.min(0.78, cloud);
    L.cloudA = smooth(0.06, 0.22, cloud) * (1 - 0.55 * over) * L.daylight;
    // the haze colour fog takes on: paper-white by day, dusky rose at twilight, a dim blue-grey glow at night
    const tw = smooth(4, -2, W.sunAlt) * (1 - night);
    L.haze[0] = lerp(lerp(238, 214, tw), 70, night); L.haze[1] = lerp(lerp(237, 196, tw), 76, night); L.haze[2] = lerp(lerp(233, 200, tw), 98, night);
    L.hazeVer++;
  }

  app.on("frame", (f) => {
    const ms = f.now.getTime();
    if (!(Math.abs(ms - lastSkyMs) < 1000)) updateSky(ms);
    computeLight();
    app.background = app.layerEnabled("sky") ? L.bg : null;
  });

  // ---------------------------------------------------------------- drawing helpers
  // Fill the ground the screen shows (clipped to the world) with a repeating pattern laid in ground metres, K metres per
  // texel, shifted by (ox, oy) metres: it then slides over the map consistently as you pan, zoom and rotate. d = pixels
  // per CSS pixel of the target (the dpr for the map canvas, a fraction for the low-res sheets).
  function fillGround(ctx, pattern, K, ox, oy, d) {
    const o = geo.ROTS[view.rot], S = geo.SIN_T, s = view.s, w = view.w, h = view.h;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let c = 0; c < 4; c++) {
      const X = ((c & 1 ? w : 0) - w / 2) / s + view.X, v = -(((c & 2 ? h : 0) - h / 2) / s + view.Y) / S;
      const gx = X * o.R[0] + v * o.D[0], gy = X * o.R[1] + v * o.D[1];
      if (gx < x0) x0 = gx; if (gx > x1) x1 = gx; if (gy < y0) y0 = gy; if (gy > y1) y1 = gy;
    }
    x0 = Math.max(x0, world.x0); y0 = Math.max(y0, world.y0); x1 = Math.min(x1, world.x1); y1 = Math.min(y1, world.y1);
    if (x0 >= x1 || y0 >= y1) return;
    ctx.setTransform(d * s * o.R[0], -d * s * S * o.D[0], d * s * o.R[1], -d * s * S * o.D[1], d * (w / 2 - view.X * s), d * (h / 2 - view.Y * s));
    ctx.transform(K, 0, 0, K, ox, oy);
    ctx.fillStyle = pattern;
    ctx.fillRect((x0 - ox) / K, (y0 - oy) / K, (x1 - x0) / K, (y1 - y0) / K);
    ctx.setTransform(d, 0, 0, d, 0, 0);
  }

  // Is CSS pixel (px, py) on the diorama: its top, its sides, or anything standing up to zHi metres on it? The ground
  // point under a pixel slides along the view direction with height, so solve for the heights that land inside.
  function onSlab(px, py, zLo, zHi, marginM) {
    const o = geo.ROTS[view.rot], S = geo.SIN_T, C = geo.COS_T;
    const X = (px - view.w / 2) / view.s + view.X, v0 = -((py - view.h / 2) / view.s + view.Y) / S;
    const gx = X * o.R[0] + v0 * o.D[0], gy = X * o.R[1] + v0 * o.D[1];
    const kx = (-C / S) * o.D[0], ky = (-C / S) * o.D[1];
    let lo = zLo, hi = zHi;
    if (Math.abs(kx) < 1e-9) { if (gx < world.x0 - marginM || gx > world.x1 + marginM) return false; }
    else { let a = (world.x0 - marginM - gx) / kx, b = (world.x1 + marginM - gx) / kx; if (a > b) { const t = a; a = b; b = t; } if (a > lo) lo = a; if (b < hi) hi = b; }
    if (Math.abs(ky) < 1e-9) { if (gy < world.y0 - marginM || gy > world.y1 + marginM) return false; }
    else { let a = (world.y0 - marginM - gy) / ky, b = (world.y1 + marginM - gy) / ky; if (a > b) { const t = a; a = b; b = t; } if (a > lo) lo = a; if (b < hi) hi = b; }
    return lo <= hi;
  }
  const SLAB_DEPTH = 46;
  // does the diorama fill the whole screen? (it is convex, so the four corners decide)
  const slabCoversScreen = (w, h) => onSlab(0, 0, -SLAB_DEPTH, 120, 0) && onSlab(w, 0, -SLAB_DEPTH, 120, 0) && onSlab(0, h, -SLAB_DEPTH, 120, 0) && onSlab(w, h, -SLAB_DEPTH, 120, 0);

  // ---------------------------------------------------------------- clouds (one small noise texture, scaled way up)
  // 192 texels over 4.8 km: shadows of cumulus a few hundred metres to a kilometre across, many to a map
  const NOISE_N = 192, CLOUD_TILE_M = 4800, FOG_TILE_M = 2400;
  let noise = null, cloudPat = null, cloudPatCov = -1, fogPat = null;
  let cloudOX = 0, cloudOY = 0, fogOX = 0, fogOY = 0;
  function cloudPattern(ctx, cov) {
    const q = Math.round(cov * 20) / 20;
    if (cloudPat && q === cloudPatCov) return cloudPat;
    if (!noise) noise = tileNoise(NOISE_N, 7);
    // the threshold that leaves exactly `q` of the ground in shadow
    const sorted = Float32Array.from(noise).sort();
    const th = sorted[Math.min(sorted.length - 1, Math.floor((1 - q) * sorted.length))];
    const c = makeCanvas(NOISE_N, NOISE_N), g = c.getContext("2d"), img = g.createImageData(NOISE_N, NOISE_N);
    for (let i = 0; i < noise.length; i++) {
      const n = noise[i];
      // a soft but definite edge (real cloud shadows fade over tens of metres), a little denser toward the middle
      const a = smooth(th - 0.018, th + 0.04, n) * (0.7 + 0.3 * smooth(th, th + 0.25, n));
      img.data[4 * i] = 118; img.data[4 * i + 1] = 128; img.data[4 * i + 2] = 162; img.data[4 * i + 3] = byte(a * 150);
    }
    g.putImageData(img, 0, 0);
    cloudPat = ctx.createPattern(c, "repeat");
    cloudPatCov = q;
    return cloudPat;
  }
  function fogPattern(ctx) {
    if (fogPat) return fogPat;
    if (!noise) noise = tileNoise(NOISE_N, 7);
    const c = makeCanvas(NOISE_N, NOISE_N), g = c.getContext("2d"), img = g.createImageData(NOISE_N, NOISE_N);
    for (let i = 0; i < noise.length; i++) {
      // the same noise, read upside down and softer, so fog banks don't echo the cloud shadows
      const n = noise[noise.length - 1 - i];
      img.data[4 * i] = 255; img.data[4 * i + 1] = 255; img.data[4 * i + 2] = 255; img.data[4 * i + 3] = byte(smooth(0.35, 0.8, n) * 255);
    }
    g.putImageData(img, 0, 0);
    return (fogPat = ctx.createPattern(c, "repeat"));
  }
  // where the wind blows the clouds: from windDir, so toward windDir + 180
  const windGround = (out) => { const a = (W.windDir + 180) * RAD; out[0] = Math.sin(a); out[1] = Math.cos(a); return out; };
  const _wg = [0, 0];

  // ---------------------------------------------------------------- fills for the light (rebuilt only when they change)
  let mulFill = null, mulVer = -1, mulW = 0, mulH = 0;
  function getMulFill(ctx, w, h) {
    if (L.mulVer === mulVer && w === mulW && h === mulH) return mulFill;
    mulVer = L.mulVer; mulW = w; mulH = h;
    const { mr, mg, mb, tw, vig } = L;
    const c = hex(mr * 255, mg * 255, mb * 255);
    if (tw < 0.01 && vig < 0.004) return (mulFill = c);
    // one vertical sweep: at twilight the horizon (top) glows warmer and the near edge sinks into blue; at night both
    // edges sink a little, a soft vignette that keeps the eye on the middle
    const g = ctx.createLinearGradient(0, 0, 0, h);
    const tv = 1 - 0.55 * vig, bv = 1 - vig;
    g.addColorStop(0, hex(255 * Math.min(1, mr * (1 + 0.2 * tw)) * tv, 255 * Math.min(1, mg * (1 + 0.1 * tw)) * tv, 255 * Math.min(1, mb * (1 + 0.01 * tw)) * tv));
    g.addColorStop(0.45, c);
    g.addColorStop(1, hex(255 * mr * (1 - 0.16 * tw) * bv, 255 * mg * (1 - 0.12 * tw) * bv, 255 * mb * (1 - 0.03 * tw) * (1 - vig * 0.6)));
    return (mulFill = g);
  }
  let glowFill = null, glowVer = -1, glowW = 0, glowH = 0, glowA = NaN;
  function getGlowFill(ctx, w, h) {
    // the glow comes in from the screen edge that faces the sun (or moon) on the ground
    const a = geo.headingToScreen(L.glowAz, view.rot);
    if (L.glowVer === glowVer && w === glowW && h === glowH && Math.abs(a - glowA) < 0.02) return glowFill;
    glowVer = L.glowVer; glowW = w; glowH = h; glowA = a;
    const R = Math.hypot(w, h) / 2, dx = Math.cos(a), dy = Math.sin(a);
    const g = ctx.createLinearGradient(w / 2 - dx * R * 0.35, h / 2 - dy * R * 0.35, w / 2 + dx * R, h / 2 + dy * R);
    g.addColorStop(0, rgba(L.gr, L.gg, L.gb, 0));
    g.addColorStop(0.55, rgba(L.gr, L.gg, L.gb, L.ga * 0.3));
    g.addColorStop(1, rgba(L.gr, L.gg, L.gb, L.ga));
    return (glowFill = g);
  }

  // ---------------------------------------------------------------- stars and moon, on the paper around the diorama
  const STAR_CELL = 1024, STARS = 240;
  const stars = new Float32Array(STARS * 5);
  {
    let h = 2166136261;
    const rnd = () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
    for (let i = 0; i < STARS; i++) {
      const b = rnd();
      stars[5 * i] = rnd() * STAR_CELL; stars[5 * i + 1] = rnd() * STAR_CELL;
      stars[5 * i + 2] = b > 0.93 ? 1.8 : b > 0.6 ? 1.3 : 0.9;          // size, CSS px
      stars[5 * i + 3] = 0.3 + 0.7 * rnd() * rnd() + (b > 0.93 ? 0.3 : 0); // brightness
      stars[5 * i + 4] = rnd() * Math.PI * 2;                              // twinkle phase
    }
  }
  function drawStars(ctx, f) {
    const w = f.w, h = f.h, t = f.t / 1000, marg = 16 / view.s;
    ctx.fillStyle = "#fffbea";
    for (let cy = 0; cy < h; cy += STAR_CELL) for (let cx = 0; cx < w; cx += STAR_CELL) {
      for (let i = 0; i < STARS; i++) {
        const x = cx + stars[5 * i], y = cy + stars[5 * i + 1];
        if (x > w || y > h) continue;
        if (onSlab(x, y, -SLAB_DEPTH - 30 / view.s, 90, marg)) continue;
        const tw = calm ? 1 : 0.72 + 0.28 * Math.sin(t * (1.3 + (i % 7) * 0.31) + stars[5 * i + 4]);
        const a = L.stars * stars[5 * i + 3] * tw * (1 - 0.55 * (y / h));
        if (a < 0.02) continue;
        ctx.globalAlpha = Math.min(1, a);
        const sz = stars[5 * i + 2];
        ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
      }
    }
    ctx.globalAlpha = 1;
  }
  let halo = null;
  function drawMoon(ctx, f) {
    const m = W.moon;
    if (m.alt < 1 || L.moonA < 0.02) return;
    // in the sky beyond the far edge, left or right by its bearing from where the camera looks
    const looking = (315 + 90 * view.rot) % 360;
    const d = ((m.az - looking + 540) % 360) - 180;
    if (Math.abs(d) > 105) return;
    const w = f.w, h = f.h, r = Math.max(7, Math.min(13, Math.min(w, h) * 0.014));
    const x = w / 2 + Math.sin(d * RAD) * w * 0.36, y = h * (0.3 - 0.2 * clamp01(m.alt / 60)) + r;
    if (onSlab(x, y, -SLAB_DEPTH, 120, (r * 3) / view.s)) return;
    if (!halo) {
      halo = makeCanvas(64, 64);
      const g = halo.getContext("2d"), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, "rgba(235,238,255,.55)"); gr.addColorStop(0.35, "rgba(220,228,255,.16)"); gr.addColorStop(1, "rgba(220,228,255,0)");
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    }
    const a = L.moonA;
    ctx.globalAlpha = a * (0.4 + 0.6 * m.fraction);
    ctx.drawImage(halo, x - r * 5, y - r * 5, r * 10, r * 10);
    ctx.globalAlpha = a;
    // the unlit disc, faintly (earthshine), then the lit part bounded by the limb and the terminator
    ctx.fillStyle = "rgba(150,165,205,.22)";
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    const p = m.phase, k = Math.cos(2 * Math.PI * p);
    if (m.fraction > 0.02) {
      ctx.save();
      ctx.translate(x, y);
      if (p > 0.5) ctx.scale(-1, 1);   // waning: lit on the left (as seen from Ohio)
      ctx.beginPath();
      ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
      ctx.ellipse(0, 0, Math.max(0.01, r * Math.abs(k)), r, 0, Math.PI / 2, -Math.PI / 2, k > 0);
      ctx.fillStyle = "#f6f1de";
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- low-resolution sheets
  // Soft things (the tint with its cloud shadows, fog) are composed at a quarter of the screen's resolution and laid over
  // the map in one stretched blit: far cheaper than sampling a skewed pattern at every pixel, and they're blurry anyway.
  const SHEET_DIV = 4;
  const sheets = {};
  function sheet(id, w, h) {
    const sw = Math.max(8, Math.ceil(w / SHEET_DIV)), sh = Math.max(8, Math.ceil(h / SHEET_DIV));
    let S = sheets[id];
    if (!S) S = sheets[id] = { c: makeCanvas(sw, sh), g: null, w: 0, h: 0 };
    if (S.c.width !== sw || S.c.height !== sh) { S.c.width = sw; S.c.height = sh; }
    if (!S.g) S.g = S.c.getContext("2d");
    S.w = sw; S.h = sh; S.k = sw / w;
    S.g.setTransform(1, 0, 0, 1, 0, 0);
    S.g.globalAlpha = 1;
    S.g.globalCompositeOperation = "source-over";
    return S;
  }

  // ---------------------------------------------------------------- layer: the light (z 80)
  app.addLayer({
    id: "sky", z: 80,
    draw(ctx, f) {
      const w = f.w, h = f.h, dt = calm ? 0 : f.dt;
      if (L.cloudA > 0.01) {
        // cloud shadows sliding over the ground with the wind, composed with the tint in one low-res sheet
        windGround(_wg);
        const sp = Math.max(4, W.windMph * 0.447 * 2.6);   // clouds ride faster winds aloft
        cloudOX = (cloudOX + _wg[0] * sp * dt) % CLOUD_TILE_M; cloudOY = (cloudOY + _wg[1] * sp * dt) % CLOUD_TILE_M;
        const S = sheet("light", w, h), g = S.g;
        g.setTransform(S.k, 0, 0, S.k, 0, 0);
        g.fillStyle = L.mulOn ? getMulFill(ctx, w, h) : "#fff";
        g.fillRect(0, 0, w, h);
        g.globalCompositeOperation = "multiply";
        g.globalAlpha = L.cloudA;
        fillGround(g, cloudPattern(g, L.cloudCov), CLOUD_TILE_M / NOISE_N, cloudOX, cloudOY, S.k);
        ctx.globalCompositeOperation = "multiply";
        ctx.drawImage(S.c, 0, 0, w, h);
      } else if (L.mulOn) {
        ctx.globalCompositeOperation = "multiply";
        ctx.fillStyle = getMulFill(ctx, w, h);
        ctx.fillRect(0, 0, w, h);
      }
      if (L.ga > 0.004) {
        ctx.globalCompositeOperation = "screen";
        ctx.fillStyle = getGlowFill(ctx, w, h);
        ctx.fillRect(0, 0, w, h);
      }
      ctx.globalCompositeOperation = "source-over";
      if ((L.stars > 0.02 || L.moonA > 0.02) && !slabCoversScreen(w, h)) {
        if (L.stars > 0.02) drawStars(ctx, f);
        drawMoon(ctx, f);
      }
    },
  });

  // ---------------------------------------------------------------- the city from afar
  // Zoomed out, the lights tiles carry only pinpoint lamp pools (windows appear once a tile has about a pixel per metre),
  // so the whole-map night would go dark. Instead a texture of streetlit roads and lit buildings, laid in ground metres
  // and added on top, fades in as you zoom out. It is drawn once, a few milliseconds per frame, the first time it's needed.
  const GLOW_CELL = app.mobile ? 7 : 5;   // metres per texel
  const LIT = {
    house: 0.5, detached: 0.5, semidetached_house: 0.5, terrace: 0.55, residential: 0.6, bungalow: 0.5, duplex: 0.5,
    apartments: 0.8, dormitory: 1, university: 0.7, college: 0.7, school: 0.3, library: 0.7, commercial: 0.75, retail: 0.8,
    office: 0.55, hotel: 0.85, hospital: 0.95, clinic: 0.6, church: 0.35, civic: 0.5, public: 0.5, yes: 0.5, parking: 0.4,
    stadium: 0.35, sports_centre: 0.5, train_station: 0.6, transportation: 0.5, industrial: 0.25, warehouse: 0.15,
  };
  const ROAD_GLOW = { motorway: [26, 0.09, 7, 0.2], motorway_link: [16, 0.07, 5, 0.16], primary: [24, 0.1, 7, 0.24], secondary: [22, 0.09, 6, 0.22],
    tertiary: [16, 0.07, 5, 0.17], residential: [12, 0.05, 3.5, 0.12], unclassified: [12, 0.05, 3.5, 0.12], living_street: [10, 0.04, 3, 0.1], busway: [14, 0.06, 4, 0.14], service: [6, 0.03, 2, 0.06] };
  let cityGlow = null;
  function cityGlowJob() {
    const tw = Math.ceil((world.x1 - world.x0) / GLOW_CELL), th = Math.ceil((world.y1 - world.y0) / GLOW_CELL);
    // two sheets: streets and lamps (fine from mid zoom), lit buildings (only from far off, where roofs are specks)
    const glowSheet = () => {
      const c = makeCanvas(tw, th), g = c.getContext("2d");
      g.setTransform(1 / GLOW_CELL, 0, 0, 1 / GLOW_CELL, -world.x0 / GLOW_CELL, -world.y0 / GLOW_CELL);
      g.globalCompositeOperation = "lighter";
      g.lineCap = g.lineJoin = "round";
      return [c, g];
    };
    const [streets, sg] = glowSheet(), [blds, bg] = glowSheet();
    let g = sg;
    const dot = makeCanvas(32, 32), dg = dot.getContext("2d"), rg = dg.createRadialGradient(16, 16, 0, 16, 16, 16);
    rg.addColorStop(0, "rgba(255,206,132,.95)"); rg.addColorStop(0.35, "rgba(255,190,112,.45)"); rg.addColorStop(1, "rgba(255,180,100,0)");
    dg.fillStyle = rg; dg.fillRect(0, 0, 32, 32);
    let stage = 0, i = 0, rk = 0;
    const B = data.buildings, R = data.roads || [], LP = data.lamps || [], RK = Object.keys(ROAD_GLOW);
    const job = { streets, blds, w: tw * GLOW_CELL, h: th * GLOW_CELL, done: false };
    job.step = (budget) => {
      const t0 = performance.now();
      while (!job.done && performance.now() - t0 < budget) {
        if (stage === 0) {
          // streets: a wide faint halo and a brighter core, one road class (one path, two strokes) per step
          const k = RK[rk++], [w1, a1, w2, a2] = ROAD_GLOW[k];
          g.beginPath();
          for (const r of R) {
            if (r.k !== k || r.tn || !r.pts || r.pts.length < 4) continue;
            g.moveTo(r.pts[0], r.pts[1]);
            for (let q = 2; q < r.pts.length; q += 2) g.lineTo(r.pts[q], r.pts[q + 1]);
          }
          g.strokeStyle = `rgba(255,190,112,${a1})`; g.lineWidth = w1; g.stroke();
          g.strokeStyle = `rgba(255,208,140,${a2})`; g.lineWidth = w2; g.stroke();
          if (rk >= RK.length) stage = 1;
        } else if (stage === 1) {
          // lamps: a soft pool and a bright point, the campus's sparkle from afar
          for (let q = 0; q < LP.length; q += 2) {
            g.globalAlpha = 0.5; g.drawImage(dot, LP[q] - 12, LP[q + 1] - 12, 24, 24);
            g.globalAlpha = 0.9; g.drawImage(dot, LP[q] - 5, LP[q + 1] - 5, 10, 10);
          }
          g.globalAlpha = 1;
          stage = 2;
          g = bg;
        } else {
          for (let n = 0; n < 120 && i < B.length; n++, i++) {
            const b = B[i], lit = LIT[b.k];
            const f = b.p && b.p[0];
            if (!lit || !f || f.length < 6) continue;
            let area = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (let q = 0, m = f.length; q < m; q += 2) {
              const ax = f[q], ay = f[q + 1];
              area += ax * f[(q + 3) % m] - f[(q + 2) % m] * ay;
              if (ax < x0) x0 = ax; if (ax > x1) x1 = ax; if (ay < y0) y0 = ay; if (ay > y1) y1 = ay;
            }
            area = Math.abs(area) / 2;
            // a few lit windows scattered over the footprint (not every one: it varies by building), brighter when taller
            let hsh = 0; for (let q = 0; q < b.id.length; q++) hsh = (Math.imul(hsh, 31) + b.id.charCodeAt(q)) | 0;
            const rnd = () => { hsh = (Math.imul(hsh, 1103515245) + 12345) | 0; return ((hsh >>> 8) & 0xffff) / 65536; };
            const a = lit * (0.3 + 0.7 * rnd()) * Math.min(1, 0.4 + (b.h || 6) / 22);
            const nd = Math.max(1, Math.min(14, Math.round(area / 450)));
            const r = Math.max(4.5, Math.min(13, Math.sqrt(area / nd) * 0.55));
            g.globalAlpha = Math.min(1, a * 0.75);
            for (let k = 0; k < nd; k++) {
              let px = (x0 + x1) / 2, py = (y0 + y1) / 2;
              for (let tries = 0; tries < 5; tries++) {
                const tx = x0 + (x1 - x0) * rnd(), ty = y0 + (y1 - y0) * rnd();
                if (inRing(f, tx, ty)) { px = tx; py = ty; break; }
              }
              g.drawImage(dot, px - r, py - r, r * 2, r * 2);
            }
          }
          g.globalAlpha = 1;
          if (i >= B.length) job.done = true;
        }
      }
    };
    return job;
  }
  // The ground sheets, turned once per view rotation into screen-aligned ones, so each frame is a plain scaled blit
  // (a skewed one costs many times more wherever the canvas isn't on the GPU).
  let turned = null;
  function turnedGlow(r) {
    if (turned && turned.r === r) return turned;
    const box = geo.worldScreenBox(r), o = geo.ROTS[r], S = geo.SIN_T, C = GLOW_CELL;
    const tw = Math.ceil((box[2] - box[0]) / C), th = Math.ceil((box[3] - box[1]) / C);
    const make = (old, withBlds) => {
      const c = old && old.width === tw && old.height === th ? old : makeCanvas(tw, th), g = c.getContext("2d");
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, tw, th);
      g.setTransform(o.R[0] / C, (-S * o.D[0]) / C, o.R[1] / C, (-S * o.D[1]) / C, -box[0] / C, -box[1] / C);
      g.globalCompositeOperation = "lighter";
      g.drawImage(cityGlow.streets, world.x0, world.y0, cityGlow.w, cityGlow.h);
      if (withBlds) g.drawImage(cityGlow.blds, world.x0, world.y0, cityGlow.w, cityGlow.h);
      return c;
    };
    turned = { r, streets: make(turned && turned.streets, false), both: make(turned && turned.both, true), X0: box[0], Y0: box[1], w: tw * C, h: th * C };
    return turned;
  }
  function drawCityGlow(ctx, streetsA, bldA) {
    if (!cityGlow) cityGlow = cityGlowJob();
    if (!cityGlow.done) { cityGlow.step(3); return; }   // show it only once it's whole
    const T = turnedGlow(view.rot), s = view.s;
    const dx = (T.X0 - view.X) * s + view.w / 2, dy = (T.Y0 - view.Y) * s + view.h / 2, dw = T.w * s, dh = T.h * s;
    ctx.globalCompositeOperation = "lighter";
    // streets at streetsA and buildings at bldA, from the two sheets (streets alone, streets with buildings)
    if (bldA < 0.01) { ctx.globalAlpha = streetsA; ctx.drawImage(T.streets, dx, dy, dw, dh); }
    else if (bldA >= streetsA - 0.01) { ctx.globalAlpha = streetsA; ctx.drawImage(T.both, dx, dy, dw, dh); }
    else {
      ctx.globalAlpha = bldA; ctx.drawImage(T.both, dx, dy, dw, dh);
      ctx.globalAlpha = streetsA - bldA; ctx.drawImage(T.streets, dx, dy, dw, dh);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  // ---------------------------------------------------------------- layer: night lights (z 82)
  app.addLayer({
    id: "sky-lights", z: 82,
    draw(ctx, f) {
      // the lights tiles are only drawn (and so only rendered) once dusk comes
      if (!app.layerEnabled("sky") || W.night <= 0.02) return;
      const a = Math.min(1, W.night * 1.08), k = f.s * f.dpr;
      // From far off the tiles hold nothing but specks of lamp light, which the city glow already carries: hand over to
      // it there, and the workers needn't render a far-zoom lights layer at all.
      const far = smooth(1.2, 0.45, k), glowReady = !!(cityGlow && cityGlow.done);
      const tilesA = glowReady ? smooth(0.22, 0.4, k) : 1;
      if (tilesA > 0.01) app.tiles.draw(ctx, f.view, "lights", { alpha: a * tilesA, op: "lighter" });
      if (far > 0.01) {
        const g = a * (1 - 0.5 * W.fog);
        drawCityGlow(ctx, g * far, g * smooth(0.42, 0.2, k));
      }
    },
  });

  // ---------------------------------------------------------------- weather particles (screen space, but riding the map)
  const rain = new Float32Array(PARTICLE_CAP * 3);   // x, y, nearness 0..1
  const snow = new Float32Array(PARTICLE_CAP * 4);   // x, y, nearness, phase
  const SPLASHES = 90;
  const splash = new Float32Array(SPLASHES * 3);     // x, y, age (s; < 0 = free)
  splash.fill(-1);
  let rainN = 0, snowN = 0, splashAcc = 0;
  const rainInk = { night: -1, far: "", near: "", splash: "" };
  let panX = NaN, panY = NaN, panRot = -1, panS = 0;
  let flashAt = 0, nextFlash = 0;

  function seed(arr, stride, from, to, w, h) {
    for (let i = from; i < to; i++) {
      arr[stride * i] = Math.random() * w; arr[stride * i + 1] = Math.random() * h; arr[stride * i + 2] = Math.random();
      if (stride > 3) arr[stride * i + 3] = Math.random() * Math.PI * 2;
    }
  }
  // how the map moved on screen since the last frame, so the particles move with it rather than sticking to the glass
  function panDelta(f, out) {
    out[0] = out[1] = 0;
    if (panRot === view.rot && Math.abs(view.s - panS) / panS < 0.5) {
      out[0] = (panX - view.X) * view.s; out[1] = (panY - view.Y) * view.s;
      if (Math.abs(out[0]) > f.w || Math.abs(out[1]) > f.h) out[0] = out[1] = 0;
    }
    panX = view.X; panY = view.Y; panRot = view.rot; panS = view.s;
    return out;
  }
  const _pan = [0, 0];
  // the wind's push on the screen: the ground vector projected (foreshortened up the screen, like everything)
  function windScreen(out) {
    windGround(_wg);
    const o = geo.ROTS[view.rot];
    out[0] = _wg[0] * o.R[0] + _wg[1] * o.R[1];
    out[1] = -(_wg[0] * o.D[0] + _wg[1] * o.D[1]) * geo.SIN_T;
    return out;
  }
  const _ws = [0, 0];

  const FLAKE_R = [1.3, 2, 2.9];

  let hazeFill = null, hazeKey = NaN, hazeVer = -1, hazeH = 0;
  function drawFog(ctx, f) {
    const w = f.w, h = f.h, fog = W.fog;
    const S = sheet("fog", w, h), g = S.g;
    g.clearRect(0, 0, S.w, S.h);
    g.setTransform(S.k, 0, 0, S.k, 0, 0);
    // drifting banks over the ground, recoloured to the haze of the hour
    windGround(_wg);
    const dt = calm ? 0 : f.dt, sp = 1.5 + W.windMph * 0.2;
    fogOX = (fogOX + _wg[0] * sp * dt) % FOG_TILE_M; fogOY = (fogOY + _wg[1] * sp * dt) % FOG_TILE_M;
    const [hr, hg, hb] = L.haze;
    g.globalAlpha = fog * 0.55 * (1 - 0.35 * W.night);
    fillGround(g, fogPattern(g), FOG_TILE_M / NOISE_N, fogOX, fogOY, S.k);
    g.setTransform(S.k, 0, 0, S.k, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-in";
    g.fillStyle = hex(hr, hg, hb);
    g.fillRect(0, 0, w, h);
    // farther air is thicker: more haze up the screen, and more when zoomed out
    g.globalCompositeOperation = "source-over";
    const zf = Math.round(clamp01(Math.log2(view.metresAcross() / 400) / 4) * 20) / 20;
    const key = fog * 1000 + zf;
    if (key !== hazeKey || L.hazeVer !== hazeVer || h !== hazeH) {
      hazeKey = key; hazeVer = L.hazeVer; hazeH = h;
      const top = fog * (0.66 + 0.2 * zf), bot = fog * (0.12 + 0.24 * zf);
      hazeFill = g.createLinearGradient(0, 0, 0, h);
      hazeFill.addColorStop(0, rgba(hr, hg, hb, top));
      hazeFill.addColorStop(0.55, rgba(hr, hg, hb, (top + bot) * 0.45));
      hazeFill.addColorStop(1, rgba(hr, hg, hb, bot));
    }
    g.fillStyle = hazeFill;
    g.fillRect(0, 0, w, h);
    ctx.drawImage(S.c, 0, 0, w, h);
  }

  function drawRain(ctx, f, want) {
    const w = f.w, h = f.h, dt = calm ? 0 : f.dt;
    if (want > rainN) seed(rain, 3, rainN, want, w, h);
    rainN = want;
    windScreen(_ws);
    const slant = Math.min(1, W.windMph / 22) * 0.5;
    let vx = _ws[0] * slant, vy = 1 + _ws[1] * slant;
    const vl = Math.hypot(vx, vy); vx /= vl; vy /= vl;
    const night = W.night;
    if (Math.abs(night - rainInk.night) > 0.01) {
      rainInk.night = night;
      rainInk.far = rgba(lerp(190, 150, night), lerp(204, 170, night), lerp(225, 215, night), lerp(0.38, 0.3, night));
      rainInk.near = rgba(lerp(205, 175, night), lerp(218, 195, night), lerp(236, 235, night), lerp(0.55, 0.42, night));
      rainInk.splash = rgba(lerp(225, 190, night), lerp(235, 205, night), 250, 0.42);
    }
    // far drops: short and faint; near ones: longer, quicker, brighter
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      for (let i = 0; i < rainN; i++) {
        const z = rain[3 * i + 2];
        if ((z < 0.55) !== (pass === 0)) continue;
        let x = rain[3 * i] + _pan[0], y = rain[3 * i + 1] + _pan[1];
        const sp = 620 + 520 * z, len = 7 + 11 * z;
        x += vx * sp * dt; y += vy * sp * dt;
        if (y > h + len) { y -= h + len * 2; x = Math.random() * w; }
        else if (y < -len * 2) y += h + len * 2;
        if (x < -20) x += w + 40; else if (x > w + 20) x -= w + 40;
        rain[3 * i] = x; rain[3 * i + 1] = y;
        ctx.moveTo(x, y); ctx.lineTo(x - vx * len, y - vy * len);
      }
      ctx.lineWidth = pass ? 1.15 : 0.85;
      ctx.strokeStyle = pass ? rainInk.near : rainInk.far;
      ctx.stroke();
    }
    // splashes: tiny rings opening on the ground, a shimmer across the wet campus
    if (!calm) {
      splashAcc += dt * rainN * 0.35;
      let tries = 0;
      while (splashAcc >= 1 && tries++ < 40) {
        splashAcc -= 1;
        for (let j = 0; j < SPLASHES; j++) {
          if (splash[3 * j + 2] >= 0) continue;
          const x = Math.random() * w, y = Math.random() * h;
          if (onSlab(x, y, 0, 0, 0)) { splash[3 * j] = x; splash[3 * j + 1] = y; splash[3 * j + 2] = 0; }
          break;
        }
      }
      if (splashAcc > 1) splashAcc = 0;
    }
    ctx.beginPath();
    for (let j = 0; j < SPLASHES; j++) {
      let age = splash[3 * j + 2];
      if (age < 0) continue;
      age += dt;
      if (age > 0.3 || calm) { splash[3 * j + 2] = -1; continue; }
      splash[3 * j + 2] = age;
      const x = (splash[3 * j] += _pan[0]), y = (splash[3 * j + 1] += _pan[1]);
      const r = 0.8 + age * 11;
      ctx.moveTo(x + r, y);
      ctx.ellipse(x, y, r, r * 0.45, 0, 0, Math.PI * 2);
    }
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = rainInk.splash;
    ctx.stroke();
  }

  function drawSnow(ctx, f, want) {
    const w = f.w, h = f.h, dt = calm ? 0 : f.dt, t = calm ? 0 : f.t / 1000;
    if (want > snowN) seed(snow, 4, snowN, want, w, h);
    snowN = want;
    windScreen(_ws);
    const gust = Math.min(1, W.windMph / 18);
    for (let i = 0; i < snowN; i++) {
      const z = snow[4 * i + 2];
      let x = snow[4 * i] + _pan[0], y = snow[4 * i + 1] + _pan[1];
      const fall = 26 + 50 * z, drift = (12 + 40 * z) * gust;
      x += _ws[0] * drift * dt; y += (fall + _ws[1] * drift) * dt;
      if (y > h + 8) { y -= h + 16; x = Math.random() * w; }
      else if (y < -8) y += h + 16;
      if (x < -24) x += w + 48; else if (x > w + 24) x -= w + 48;
      snow[4 * i] = x; snow[4 * i + 1] = y;
    }
    // small pre-drawn sprites: cheaper to stamp than to rasterize hundreds of arcs, on the GPU or off it
    if (flakeDpr !== f.dpr) { flakeDpr = f.dpr; for (let k = 0; k < FLAKE_R.length; k++) flakes[k] = flakeSprite(FLAKE_R[k], f.dpr); }
    ctx.globalAlpha = W.night > 0.5 ? 0.88 : 1;
    for (let i = 0; i < snowN; i++) {
      const z = snow[4 * i + 2], sp = flakes[z < 0.45 ? 0 : z < 0.85 ? 1 : 2];
      const x = snow[4 * i] + Math.sin(t * (0.7 + 0.5 * z) + snow[4 * i + 3]) * (5 + 9 * z), y = snow[4 * i + 1];
      if (x < -8 || x > w + 8) continue;
      ctx.drawImage(sp.c, x - sp.half, y - sp.half, sp.size, sp.size);
    }
    ctx.globalAlpha = 1;
  }
  const flakes = [];
  let flakeDpr = 0;
  function flakeSprite(r, dpr) {
    const size = Math.ceil(r * 2 + 3), px = Math.ceil(size * dpr), c = makeCanvas(px, px), g = c.getContext("2d");
    g.scale(px / size, px / size);
    const m = size / 2;
    // a faint cool shadow, so a flake still reads over pale plazas and snowy roofs
    g.fillStyle = "rgba(80,95,130,.32)"; g.beginPath(); g.arc(m + 0.45, m + 0.7, r * 1.05, 0, Math.PI * 2); g.fill();
    const gr = g.createRadialGradient(m, m, 0, m, m, r);
    gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.7, "rgba(255,255,255,.94)"); gr.addColorStop(1, "rgba(250,252,255,.4)");
    g.fillStyle = gr; g.beginPath(); g.arc(m, m, r, 0, Math.PI * 2); g.fill();
    return { c, size, half: m };
  }

  function drawLightning(ctx, f) {
    if (!nextFlash) nextFlash = f.t + 2500 + Math.random() * 6000;
    if (f.t >= nextFlash) { flashAt = f.t; nextFlash = f.t + 5000 + Math.random() * 13000; }
    const t = f.t - flashAt;
    // two quick pulses and a fading afterglow
    const a = t < 0 || t > 520 ? 0 : t < 70 ? 1 - t / 110 : t < 120 ? 0.12 : 0.85 * Math.exp(-(t - 120) / 120);
    if (a < 0.01) return;
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = rgba(215, 222, 255, a * 0.5);
    ctx.fillRect(0, 0, f.w, f.h);
    ctx.globalCompositeOperation = "source-over";
  }

  app.addLayer({
    id: "sky-weather", z: 88,
    draw(ctx, f) {
      if (!app.layerEnabled("sky")) { panRot = -1; return; }
      panDelta(f, _pan);
      if (W.fog > 0.02) drawFog(ctx, f);
      // counts follow the screen's area, so a phone carries fewer drops than a desktop
      const area = f.w * f.h;
      const wantRain = Math.min(PARTICLE_CAP, Math.round((area / 1600) * W.rain * (calm ? 0.35 : 1)));
      const wantSnow = Math.min(PARTICLE_CAP, Math.round((area / 1500) * W.snow * (calm ? 0.6 : 1)));
      if (wantRain > 0) drawRain(ctx, f, wantRain); else rainN = 0;
      if (wantSnow > 0) drawSnow(ctx, f, wantSnow); else snowN = 0;
      if (W.storm && !calm) drawLightning(ctx, f);
    },
  });

  // first sky right away, so modules that start after this one can read app.weather.night; then the weather
  updateSky(app.now().getTime());
  computeLight();
  if (preset) applyWeather(preset, "test");
  else {
    fetchWeather();   // not awaited: the modules after this one shouldn't wait on the network
    document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - lastOk > WX_EVERY) fetchWeather(); });
  }
}
