// The real sky over campus: the sun where it really is above Columbus and the light it gives (plain day, golden hour,
// dusk, a deep blue night with lit windows and lamp pools), the moon and stars on the paper around the diorama, and the
// live weather from Open-Meteo: cloud shadows drifting with the wind, rain, snow (which also settles on the tiles), fog
// and the odd lightning flash. Publishes app.weather (ARCHITECTURE.md) and emits "weather" when it changes meaningfully.
//
// Layers: "sky" z 80 (cloud shadows, the light grade, stars, moon) · "sky-lights" z 82 (the night-lights tiles) ·
// "sky-clouds" z 86 (cumulus aloft and mist round the diorama, zoomed far out) · "sky-weather" z 88 (fog, rain, snow,
// lightning). One toggle, "sky", switches them all. Each says what frame rate it needs (fps(f), ARCHITECTURE.md
// "Frame scheduling"): nothing while nothing of it moves; the light's slow change with the clock comes by a timer.
// Test switch: ?noclouds hides the clouds aloft.

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
    const raw = num(c.weather_code, NaN), tf = num(c.temperature_2m, NaN), cover = num(c.cloud_cover, NaN);
    const coverOk = cover >= 0 && cover <= 100;
    // A code Open-Meteo doesn't use (or none at all) says nothing about the sky: name it by its cloud cover instead, or
    // not at all (code null, no text). Calling it "Sunny" would be a guess passed off as live weather.
    let code = Number.isFinite(raw) ? Math.round(raw) : NaN;
    if (!WMO[code]) code = coverOk ? (cover < 12.5 ? 0 : cover < 37.5 ? 1 : cover < 87.5 ? 2 : 3) : null;
    W.code = code;
    W.tempF = Number.isFinite(tf) && tf > -80 && tf < 140 ? tf : null;
    W.cloud = coverOk ? cover : code == null ? 0 : code >= 3 ? 100 : code * 30;   // percent
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
    updateTileSnow(); // every reading counts toward its hysteresis, a repeated one too
    // only a real change re-grades the light and tells the other modules
    const sig = `${W.code}|${W.tempF == null ? "" : Math.round(W.tempF)}|${Math.round(W.cloud / 4)}|${Math.round(W.windMph)}|${Math.round(W.windDir / 10)}|${W.rain}|${W.snow}|${W.fog.toFixed(2)}|${W.snowDepthM.toFixed(3)}|${source}`;
    if (sig === wxSig) return;
    wxSig = sig;
    wxVer++;
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
      const cur = j && j.current;
      // an answer without a usable weather code is a failed reading, not a clear sky: keep what we had and retry
      if (!cur || typeof cur !== "object" || Array.isArray(cur)) throw new Error("no current conditions");
      if (!Number.isFinite(num(cur.weather_code, NaN))) throw new Error("no weather code");
      applyWeather(cur, "live");
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
  // Snow on the tiles, in coarse levels, because every change re-renders every tile. Readings are noisy: Open-Meteo's
  // snow depth comes in whole centimetres that flick between 0 and 1, and a flurry's code comes and goes from one
  // reading to the next. So a level goes up at once but comes down only after the lower one has held for LOWER_AFTER
  // readings in a row, each warm enough to melt snow or showing bare ground (cold snow the gauge still sees stays).
  // Falling snow with none yet on the ground settles only once it has kept on for two readings or laid down SETTLE_CM.
  const LOWER_AFTER = 2, SETTLE_CM = 0.2;
  let tileSnow = num(app.tileStyle && app.tileStyle.snow, 0);
  let snowRun = 0, fallenCm = 0, lowerRun = 0, lowerTo = 0;
  function updateTileSnow() {
    if (tileSnowFixed) return;
    const depth = W.snowDepthM, warm = W.tempF != null && W.tempF > 33;
    const snowing = W.snow > 0 && (W.tempF == null || W.tempF < 36);
    snowRun = snowing ? snowRun + 1 : 0;
    fallenCm = snowing ? fallenCm + W.snowfallCm : 0;
    const settling = snowing && (snowRun >= 2 || fallenCm >= SETTLE_CM);
    const want = depth >= 0.025 ? 0.8 : depth >= 0.005 || settling ? 0.4 : 0;
    if (want > tileSnow) { lowerRun = 0; setTileSnow(want); return; }
    if (want === tileSnow || !(warm || depth === 0)) { lowerRun = 0; return; }
    // down only as far as every reading of the run agrees
    lowerTo = lowerRun ? Math.max(lowerTo, want) : want;
    if (++lowerRun >= LOWER_AFTER) { lowerRun = 0; setTileSnow(lowerTo); }
  }
  function setTileSnow(lvl) { tileSnow = lvl; app.setTileStyle({ snow: lvl }); }

  function updateText() {
    const t = WMO[W.code];
    W.text = W.code == null ? "" : t ? (t[1] && !W.isDay ? t[1] : t[0]) : "";
  }
  /** "40°F · Light rain", "40°F" or "Light rain": no dangling separator when a part is missing */
  const wxLabel = () => [W.tempF != null ? `${Math.round(W.tempF)}°F` : "", W.text].filter(Boolean).join(" · ");

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
    const label = wxLabel();
    if (!label) { if (statusHtml) app.ui.status("weather", ""); statusHtml = ""; return; }
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
    const rows = [], have = W.source !== "none";
    if (have) rows.push(["Wind", W.windMph >= 1 ? `${Math.round(W.windMph)} mph from the ${COMPASS[Math.round(W.windDir / 22.5) % 16]}` : "Calm"]);
    if (have) rows.push(["Clouds", `${Math.round(W.cloud)} %`]);
    if (W.visibilityM != null && W.visibilityM < 10000) rows.push(["Visibility", `${(W.visibilityM / 1609).toFixed(W.visibilityM < 1609 ? 1 : 0)} mi`]);
    if (W.snowDepthM > 0.004) rows.push(["Snow on the ground", `${Math.max(1, Math.round(W.snowDepthM * 39.37))} in`]);
    if (ev) rows.push([ev.rise ? "Sunrise" : "Sunset", fmtTime(ev.ms)]);
    rows.push(["Sun", `${Math.abs(W.sunAlt).toFixed(0)}° ${W.sunAlt >= 0 ? "high" : "below the horizon"}, ${COMPASS[Math.round(W.sunAz / 22.5) % 16]} · ${W.phase}`]);
    rows.push(["Moon", `${W.moon.name}, ${Math.round(W.moon.fraction * 100)} % lit${W.moon.alt > 0 ? "" : " (down)"}`]);
    const now = W.tempF == null && !W.text ? "" : `<div class="wx-now"><span class="wx-temp">${W.tempF != null ? esc(Math.round(W.tempF)) + "°" : ""}</span><span class="wx-cond">${esc(W.text)}</span></div>`;
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
      return [{ label: "Weather and sky", sub: wxLabel() || "Sun, moon and light", kind: "weather", score: 0.8, go: openCard }];
    });
  }
  if (app.ui && app.ui.registerToggle) app.ui.registerToggle({ id: "sky", label: "Real sky & weather" });
  function updateCount() { if (app.ui && app.ui.setCount) app.ui.setCount("sky", W.source === "test" ? "test" : W.tempF != null ? `${Math.round(W.tempF)}°F` : ""); }

  // ---------------------------------------------------------------- the sky over time
  const L = {
    mr: 1, mg: 1, mb: 1, mulOn: false, mulVer: 0, vig: 0, tw: 0,
    gr: 255, gg: 200, gb: 140, ga: 0, glowAz: 0, glowVer: 0, moonLift: 0, moonAz: 0,
    bg: null, stars: 0, moonA: 0, cloudA: 0, cloudCov: 0, daylight: 1,
    haze: [236, 236, 233], hazeVer: 0,
    // the clouds aloft (lit tops, shaded undersides) and the mist round the diorama, which lie above the multiply
    clLit: [255, 255, 255], clShade: [206, 214, 230], clA: 1, mist: [250, 248, 242], mistA: 1, cloudVer: 0,
  };
  let lightSig = "";
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

  // the colours of the light for this sun and weather; only when something actually changed (→ true when it did)
  function computeLight() {
    const moonUp = W.moon.alt > 0 ? W.moon.fraction * smooth(0, 25, W.moon.alt) : 0;
    const tileSnowNow = num(app.tileStyle && app.tileStyle.snow, 0);
    if (Math.abs(W.sunAlt - lightAlt) < 0.04 && lightWx === wxVer && Math.abs(moonUp - lightMoon) < 0.02 && tileSnowNow === lightSnow) return false;
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
    // The glow: the low sun's warmth, screened in from its side of the map (none once the sun is 9° down). A bright
    // moon's faint cool wash is folded into the multiply instead (getMulFill): a second full-screen pass all night for
    // a few percent of light isn't worth its cost, and the two fade independently rather than swapping in one frame.
    L.gr = G[4]; L.gg = lerp(G[5], G[5] + 12, dawn); L.gb = lerp(G[6], G[6] + 30, dawn); L.ga = ga; L.glowAz = W.sunAz;
    L.moonLift = 0.07 * moon; L.moonAz = W.moon.az;
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
    // Clouds aloft: sunlit white tops and cool undersides by day, greyer under a lid of overcast or rain, peach and mauve
    // at the ends of the day, and at night dim blue-grey, faintly warmed underneath where the city lights a low deck.
    const grey = Math.max(over, W.rain, W.snow * 0.6);
    const cl = L.clLit, cs = L.clShade;
    cl[0] = lerp(lerp(lerp(255, 232, grey), 255, tw), 74, night); cl[1] = lerp(lerp(lerp(255, 235, grey), 222, tw), 82, night); cl[2] = lerp(lerp(lerp(255, 240, grey), 204, tw), 110, night);
    cs[0] = lerp(lerp(lerp(168, 150, grey), 176, tw), lerp(44, 70, cityGlow), night); cs[1] = lerp(lerp(lerp(180, 158, grey), 150, tw), lerp(50, 60, cityGlow), night); cs[2] = lerp(lerp(lerp(206, 176, grey), 182, tw), lerp(76, 70, cityGlow), night);
    L.clA = lerp(1, 0.62, night) * (1 - 0.45 * W.fog);
    // the mist on the paper: a paler breath of the paper's own colour (as it looks once the multiply is through)
    const pr = sr, pg = sg, pb = sb, lift = lerp(0.55, 0.3, night);
    L.mist[0] = lerp(pr, lerp(255, 120, night), lift); L.mist[1] = lerp(pg, lerp(253, 130, night), lift); L.mist[2] = lerp(pb, lerp(248, 168, night), lift);
    L.mistA = lerp(1, 0.8, night);
    // Only a change you could see bumps the versions the cached fills and sprites key on (the sun moves a little all
    // day, but above 28 degrees and below -13 the light doesn't change at all): no redraws, no rebuilt caches for nothing.
    const sig = [L.mr, L.mg, L.mb, L.tw, L.vig, L.moonLift, L.gr, L.gg, L.gb, L.ga, L.stars, L.moonA, L.cloudA, L.cloudCov, L.clA, L.mistA, L.haze[0], L.haze[1], L.haze[2], cl[0], cl[1], cl[2], cs[0], cs[1], cs[2], L.mist[0], L.mist[1], L.mist[2]]
      .map((v) => Math.round(v * 400)).join() + `|${L.bg}|${Math.round(L.glowAz)}|${Math.round(L.moonAz)}`;
    if (sig === lightSig) return false;
    lightSig = sig;
    L.mulVer++; L.glowVer++; L.hazeVer++; L.cloudVer++;
    return true;
  }

  let viewMoving = false;
  app.on("frame", (f) => {
    viewMoving = f.moving;
    const ms = f.now.getTime();
    if (!(Math.abs(ms - lastSkyMs) < 1000)) updateSky(ms);
    computeLight();
    app.background = app.layerEnabled("sky") ? L.bg : null;
  });
  // The light follows the clock even on a map nobody touches, without a standing frame rate: every few seconds of
  // clock time, see whether the sky has visibly moved on and draw one frame if it has (updateSky's own "weather"
  // emit draws one too). The sun crawls 0.04 degrees in about ten seconds at dusk; ?speed=N runs the check N times faster.
  const SPEED = (() => { const v = app.params.get("speed"); const n = v == null || v === "" ? NaN : +v; return Number.isFinite(n) ? Math.max(0, n) : 1; })();
  if (SPEED > 0) {
    setInterval(() => {
      if (document.hidden || !app.layerEnabled("sky")) return;
      const ms = app.now().getTime();
      if (!(Math.abs(ms - lastSkyMs) < 1000)) updateSky(ms);
      if (computeLight()) app.requestRender("sky");
    }, Math.max(250, Math.min(15000, 12000 / SPEED)));
  }

  // ---------------------------------------------------------------- drawing helpers
  // Fill the ground the screen shows (clipped to the world) with a repeating pattern laid in ground metres, K metres per
  // texel, shifted by (ox, oy) metres: it then slides over the map consistently as you pan, zoom and rotate. d = pixels
  // per CSS pixel of the target (the dpr for the map canvas, a fraction for the low-res sheets). (tx, ty): where the
  // target puts screen-metre (0, 0), in its pixels (default: the view's own centring); pad: CSS px of margin round the
  // screen the target covers too.
  function fillGround(ctx, pattern, K, ox, oy, d, tx = d * (view.w / 2 - view.X * view.s), ty = d * (view.h / 2 - view.Y * view.s), pad = 0) {
    const o = geo.ROTS[view.rot], S = geo.SIN_T, s = view.s, w = view.w, h = view.h;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let c = 0; c < 4; c++) {
      const X = ((c & 1 ? w + pad + 2 : -pad - 2) - w / 2) / s + view.X, v = -(((c & 2 ? h + pad + 2 : -pad - 2) - h / 2) / s + view.Y) / S;
      const gx = X * o.R[0] + v * o.D[0], gy = X * o.R[1] + v * o.D[1];
      if (gx < x0) x0 = gx; if (gx > x1) x1 = gx; if (gy < y0) y0 = gy; if (gy > y1) y1 = gy;
    }
    x0 = Math.max(x0, world.x0); y0 = Math.max(y0, world.y0); x1 = Math.min(x1, world.x1); y1 = Math.min(y1, world.y1);
    if (x0 >= x1 || y0 >= y1) return;
    ctx.setTransform(d * s * o.R[0], -d * s * S * o.D[0], d * s * o.R[1], -d * s * S * o.D[1], tx, ty);
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
  let mulFill = null, mulVer = -1, mulW = 0, mulH = 0, mulR = -1;
  // the moon's wash, per unit of L.moonLift: its pale blue (190, 205, 240), scaled so that over mid-tones the lift
  // matches the screen glow it replaces
  const MOON_WASH = [1.1, 1.2, 1.4];
  function getMulFill(ctx, w, h) {
    const rot = view.rot;
    if (L.mulVer === mulVer && w === mulW && h === mulH && rot === mulR) return mulFill;
    mulVer = L.mulVer; mulW = w; mulH = h; mulR = rot;
    const { mr, mg, mb, tw, vig, moonLift } = L;
    const c = hex(mr * 255, mg * 255, mb * 255);
    // the moon lifts the screen edge on its side: the top (the far side) when it is ahead of the camera, the bottom
    // when behind, half of each when it stands off to one side (the vignette eases there); the middle stays as it is
    let up = 0, dn = 0;
    if (moonLift > 0.002) { const dy = Math.sin(geo.headingToScreen(L.moonAz, rot)); up = moonLift * (1 - dy) / 2; dn = moonLift * (1 + dy) / 2; }
    if (tw < 0.01 && vig < 0.004 && up + dn < 0.002) return (mulFill = c);
    // one vertical sweep: at twilight the horizon (top) glows warmer and the near edge sinks into blue; at night both
    // edges sink a little, a soft vignette that keeps the eye on the middle
    const g = ctx.createLinearGradient(0, 0, 0, h);
    const tv = 1 - 0.55 * vig, bv = 1 - vig;
    g.addColorStop(0, hex(255 * (Math.min(1, mr * (1 + 0.2 * tw)) * tv + up * MOON_WASH[0]), 255 * (Math.min(1, mg * (1 + 0.1 * tw)) * tv + up * MOON_WASH[1]), 255 * (Math.min(1, mb * (1 + 0.01 * tw)) * tv + up * MOON_WASH[2])));
    g.addColorStop(0.45, c);
    g.addColorStop(1, hex(255 * (mr * (1 - 0.16 * tw) * bv + dn * MOON_WASH[0]), 255 * (mg * (1 - 0.12 * tw) * bv + dn * MOON_WASH[1]), 255 * (mb * (1 - 0.03 * tw) * (1 - vig * 0.6) + dn * MOON_WASH[2])));
    return (mulFill = g);
  }
  let glowFill = null, glowVer = -1, glowW = 0, glowH = 0, glowA = NaN;
  function getGlowFill(ctx, w, h) {
    // the glow comes in from the screen edge that faces the sun on the ground
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
  // The page's chrome over the top of the map (the bar, the map buttons), CSS px relative to the canvas: the moon keeps
  // clear of it. Read at most once a second (it moves only on resize or when the bar wraps).
  const chrome = [];
  let chromeAt = -1e9;
  function readChrome() {
    const now = performance.now();
    if (now - chromeAt < 1000) return chrome;
    chromeAt = now;
    chrome.length = 0;
    const rc = app.canvas.getBoundingClientRect();
    for (const el of document.querySelectorAll("#bar, #map-btns")) {
      const q = el.getBoundingClientRect();
      if (q.width >= 1 && q.height >= 1) chrome.push([q.left - rc.left, q.top - rc.top, q.right - rc.left, q.bottom - rc.top]);
    }
    return chrome;
  }
  // Where the moon goes: in the sky beyond the far edge, left or right by its bearing d from where the camera looks, and
  // higher the higher it stands. When that spot falls on the diorama (looking straight toward the moon from far off,
  // the slab's far corner is right there), slide it: up toward the top of the screen first, then step by step away
  // from the middle, until it is on open paper clear of the chrome. Writes [x, y] to out; false if nowhere fits.
  function moonSpot(w, h, r, d, alt, out) {
    const x0 = w / 2 + Math.sin(d * RAD) * w * 0.36, y0 = h * (0.3 - 0.2 * clamp01(alt / 60)) + r;
    // the disc keeps 1.5 radii of paper round it: to the screen's edges, and to the chrome
    const marg = (r * 3) / view.s, pad = r * 1.5, cp = r * 2.5, ui = readChrome();
    const free = (x, y) => {
      for (const q of ui) if (x + cp > q[0] && x - cp < q[2] && y + cp > q[1] && y - cp < q[3]) return false;
      return !onSlab(x, y, -SLAB_DEPTH, 120, marg);
    };
    const dir = x0 >= w / 2 ? 1 : -1;
    for (let x = x0; x >= pad && x <= w - pad; x += dir * r * 2) {
      for (let y = y0; y >= pad; y -= r) if (free(x, y)) { out[0] = x; out[1] = y; return true; }
    }
    return false;
  }
  const _moonXY = [0, 0];
  let halo = null;
  function drawMoon(ctx, f) {
    const m = W.moon;
    if (m.alt < 1 || L.moonA < 0.02) return;
    const looking = (315 + 90 * view.rot) % 360;
    const d = ((m.az - looking + 540) % 360) - 180;
    if (Math.abs(d) > 105) return;   // behind the camera
    const w = f.w, h = f.h, r = Math.max(7, Math.min(13, Math.min(w, h) * 0.014));
    if (!moonSpot(w, h, r, d, m.alt, _moonXY)) return;
    const x = _moonXY[0], y = _moonXY[1];
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

  // ---------------------------------------------------------------- full-resolution caches
  // On a canvas rasterised by the CPU (no GPU: many laptops' browsers, every phone in power saving), the cheapest
  // full-screen pass there is is a canvas blitted 1:1 at a whole-pixel offset: no resampling. A gradient fill costs about
  // twice that, a low-res sheet stretched over the screen three to six times. So passes that hold still between frames
  // are drawn once into canvases of the map's device-pixel size and blitted; the ground-fixed ones (the cloud shadows,
  // the city's glow) carry a margin and are anchored like the core's base map, so a pan or the wind's drift only moves
  // them by whole pixels until the margin runs out.
  function devCanvas(C, Wd, Hd) {
    if (!C.c) { C.c = makeCanvas(Wd, Hd); C.g = C.c.getContext("2d"); }
    else if (C.c.width !== Wd || C.c.height !== Hd) { C.c.width = Wd; C.c.height = Hd; }   // (clears it, resets its state)
    const g = C.g;
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, Wd, Hd);
    return g;
  }
  /** give a cache's memory back (it rebuilds when next needed) */
  function freeCanvas(C) { if (C.c && C.c.width > 1) { C.c.width = 1; C.c.height = 1; } C.ok = false; C.key = ""; }
  // the base map's whole-pixel origin for the view as it is (core/app.js drawBase): device px = screen m · s · dpr − off
  const baseOffX = () => Math.round((view.X * view.s - view.w / 2) * view.dpr);
  const baseOffY = () => Math.round((view.Y * view.s - view.h / 2) * view.dpr);
  /** the diorama's bounding box on the canvas (device px, walls included), clipped to it; false when off screen */
  const _slab = [0, 0, 0, 0];
  function slabRect(Wd, Hd) {
    const b = view.worldBox, k = view.s * view.dpr;
    const x0 = Math.max(0, Math.floor(b[0] * k - baseOffX()) - 2), y0 = Math.max(0, Math.floor(b[1] * k - baseOffY()) - 2);
    const x1 = Math.min(Wd, Math.ceil(b[2] * k - baseOffX()) + 2), y1 = Math.min(Hd, Math.ceil((b[3] + SLAB_DEPTH * geo.COS_T) * k - baseOffY()) + 2);
    if (x1 <= x0 || y1 <= y0) return false;
    _slab[0] = x0; _slab[1] = y0; _slab[2] = x1 - x0; _slab[3] = y1 - y0;
    return _slab;
  }

  /** A screen-fixed fill (the tint's gradient, the low sun's glow) drawn once into a device-pixel canvas. */
  function fillCache(C, ctx, fill) {
    const Wd = ctx.canvas.width, Hd = ctx.canvas.height;
    if (C.ok && C.fill === fill && C.c.width === Wd && C.c.height === Hd) return C.c;
    const g = devCanvas(C, Wd, Hd);
    g.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);   // (the gradients are laid out in CSS px)
    g.fillStyle = fill;
    g.fillRect(0, 0, view.w + 1, view.h + 1);
    g.setTransform(1, 0, 0, 1, 0, 0);
    C.ok = true; C.fill = fill;
    return C.c;
  }
  const tintC = { c: null, g: null, ok: false, fill: null }, glowC = { c: null, g: null, ok: false, fill: null };

  // The cloud shadows (with the tint folded in when it is one flat colour), CSS-px margin SH_PAD round the screen.
  const SH_PAD = 128;
  const shC = { c: null, g: null, ok: false, key: "", offX: 0, offY: 0, s: 0, rot: -1, d: 0, W: 0, H: 0, padD: 0, dx: 0, dy: 0 };
  let cloudDX = 0, cloudDY = 0;   // the shadows' drift, ground metres, unwrapped (cloudOX/OY are it modulo the tile)
  function shadowKey(tint) { return `${L.cloudVer}|${Math.round(L.cloudCov * 20)}|${tint}`; }
  const shSheet = { c: null, g: null };
  function renderShadows(ctx, tint) {
    const d = view.dpr, padD = Math.round(SH_PAD * d), offX = baseOffX(), offY = baseOffY();
    // composed at a quarter of the resolution and stretched once into the cache: sampling the skewed pattern at every
    // pixel of it costs four times as much (a 40 ms hitch every couple of seconds of drift on a slow machine)
    const sw = Math.ceil((ctx.canvas.width + 2 * padD) / SHEET_DIV), sh = Math.ceil((ctx.canvas.height + 2 * padD) / SHEET_DIV);
    const sg = devCanvas(shSheet, sw, sh), q = 1 / SHEET_DIV;
    sg.fillStyle = tint;
    sg.fillRect(0, 0, sw, sh);
    sg.globalCompositeOperation = "multiply";
    sg.globalAlpha = L.cloudA;
    fillGround(sg, cloudPattern(sg, L.cloudCov), CLOUD_TILE_M / NOISE_N, cloudOX, cloudOY, d * q, (padD - offX) * q, (padD - offY) * q, SH_PAD);
    sg.setTransform(1, 0, 0, 1, 0, 0); sg.globalAlpha = 1; sg.globalCompositeOperation = "source-over";
    const g = devCanvas(shC, sw * SHEET_DIV, sh * SHEET_DIV);
    g.globalCompositeOperation = "copy";
    g.drawImage(shSheet.c, 0, 0, sw * SHEET_DIV, sh * SHEET_DIV);
    g.globalCompositeOperation = "source-over";
    Object.assign(shC, { ok: true, key: shadowKey(tint), offX, offY, s: view.s, rot: view.rot, d, W: ctx.canvas.width, H: ctx.canvas.height, padD, dx: cloudDX, dy: cloudDY });
  }
  /**
   * Where a ground-anchored cache C (drawn with the drift at (C.dx, C.dy)) goes now that the drift is at (dx, dy):
   * device px of its top-left, or false when it has to be redrawn (another zoom, turn, size or key, or the margin used up).
   */
  const _at = [0, 0];
  function anchoredAt(C, ctx, dx, dy, key) {
    if (!C.ok || C.s !== view.s || C.rot !== view.rot || C.d !== view.dpr || C.W !== ctx.canvas.width || C.H !== ctx.canvas.height || C.key !== key) return false;
    // the drift since it was drawn, projected (the ground moves the same for every point: one shift)
    const o = geo.ROTS[view.rot], gx = dx - C.dx, gy = dy - C.dy, k = view.s * view.dpr;
    const sx = Math.round((gx * o.R[0] + gy * o.R[1]) * k) + C.offX - baseOffX();
    const sy = Math.round(-(gx * o.D[0] + gy * o.D[1]) * geo.SIN_T * k) + C.offY - baseOffY();
    if (Math.abs(sx) > C.padD || Math.abs(sy) > C.padD) return false;
    _at[0] = sx - C.padD; _at[1] = sy - C.padD;
    return _at;
  }
  const shadowsAt = (ctx, tint) => anchoredAt(shC, ctx, cloudDX, cloudDY, shadowKey(tint));
  // how fast the shadows cross the screen, device px/s (the wind's direction foreshortened like the ground)
  const cloudSpeed = () => Math.max(4, W.windMph * 0.447 * 2.6);   // clouds ride faster winds aloft, m/s
  function driftPx(s, d) {
    windGround(_wg);
    const o = geo.ROTS[view.rot], ax = _wg[0] * o.R[0] + _wg[1] * o.R[1], ay = (_wg[0] * o.D[0] + _wg[1] * o.D[1]) * geo.SIN_T;
    return cloudSpeed() * s * d * Math.sqrt(ax * ax + ay * ay);
  }

  // ---------------------------------------------------------------- layer: the light (z 80)
  app.addLayer({
    id: "sky", z: 80,
    draw(ctx, f) {
      const w = f.w, h = f.h, d = f.dpr, dt = calm ? 0 : f.dt;
      const tint = L.mulOn ? getMulFill(ctx, w, h) : null;   // a colour, a gradient, or nothing to do
      const flat = typeof tint !== "object" || tint === null;
      if (L.cloudA > 0.01) {
        // cloud shadows sliding over the ground with the wind
        windGround(_wg);
        const sp = cloudSpeed();
        cloudDX += _wg[0] * sp * dt; cloudDY += _wg[1] * sp * dt;
        cloudOX = cloudDX % CLOUD_TILE_M; cloudOY = cloudDY % CLOUD_TILE_M;
        const base = flat && tint ? tint : "#fff";
        let at = shadowsAt(ctx, base);
        // mid-zoom, the old way: tint and shadows composed in a low-res sheet and stretched over the screen (a cache
        // drawn now would be stale next frame); otherwise (re)draw the cache, at most once per margin's worth of drift
        if (!at && f.moving && shC.s !== view.s) {
          const S = sheet("light", w, h), g = S.g;
          g.setTransform(S.k, 0, 0, S.k, 0, 0);
          g.fillStyle = tint || "#fff";
          g.fillRect(0, 0, w, h);
          g.globalCompositeOperation = "multiply";
          g.globalAlpha = L.cloudA;
          fillGround(g, cloudPattern(g, L.cloudCov), CLOUD_TILE_M / NOISE_N, cloudOX, cloudOY, S.k);
          ctx.globalCompositeOperation = "multiply";
          ctx.drawImage(S.c, 0, 0, w, h);
        } else {
          if (!at) { renderShadows(ctx, base); at = shadowsAt(ctx, base); }
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalCompositeOperation = "multiply";
          if (!flat) ctx.drawImage(fillCache(tintC, ctx, tint), 0, 0);   // a gradient tint stays put on the screen
          if (at) {
            // with no tint to lay over the paper, only the diorama has anything to darken: blit just its box
            const r = base === "#fff" ? slabRect(ctx.canvas.width, ctx.canvas.height) : null;
            if (r) ctx.drawImage(shC.c, r[0] - at[0], r[1] - at[1], r[2], r[3], r[0], r[1], r[2], r[3]);
            else if (r !== false) ctx.drawImage(shC.c, at[0], at[1]);
          }
          ctx.setTransform(d, 0, 0, d, 0, 0);
        }
      } else {
        if (shC.ok) { freeCanvas(shC); freeCanvas(shSheet); }
        if (tint) {
          ctx.globalCompositeOperation = "multiply";
          if (flat) { ctx.fillStyle = tint; ctx.fillRect(0, 0, w, h); }   // one flat colour: a plain fill is cheapest
          else { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(fillCache(tintC, ctx, tint), 0, 0); ctx.setTransform(d, 0, 0, d, 0, 0); }
        }
      }
      if (flat && tintC.ok) freeCanvas(tintC);
      // the low sun's glow: only around sunrise and sunset (at night the moon's wash rides in the multiply above)
      if (L.ga > 0.004) {
        ctx.globalCompositeOperation = "screen";
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(fillCache(glowC, ctx, getGlowFill(ctx, w, h)), 0, 0);
        ctx.setTransform(d, 0, 0, d, 0, 0);
      } else if (glowC.ok) freeCanvas(glowC);
      ctx.globalCompositeOperation = "source-over";
      if ((L.stars > 0.02 || L.moonA > 0.02) && !slabCoversScreen(w, h)) {
        if (L.stars > 0.02) drawStars(ctx, f);
        drawMoon(ctx, f);
      }
    },
    // Drifting cloud shadows are the only thing here that moves by itself (the light's slow changes come by the
    // timer above; the stars twinkle only in frames drawn anyway). Their edges are soft over tens of metres, so a step
    // of up to 3 device px a frame doesn't show: 0.5–8 fps.
    fps(f) {
      if (calm || !(L.cloudA > 0.01)) return 0;
      const px = driftPx(f.s, f.dpr) / 3;
      return px < 0.02 ? 0 : Math.max(0.5, Math.min(8, px));
    },
  });

  // ---------------------------------------------------------------- the city from afar
  // Far out, a lights tile would carry nothing but specks of lamp light (lit windows stop below 0.5 px/m), so the
  // whole-map night would go dark. Instead a soft texture of the city's light, laid in ground metres and added on top,
  // takes over as you zoom out (the hand-over is in the "sky-lights" layer). Two sheets: the streetlit roads, which the
  // tiles have no counterpart for, and the "spots" (lamps and lit buildings), which stand in for the tiles' lamp pools
  // and windows. It is drawn once, a few milliseconds per frame, the first time it's needed.
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
    const glowSheet = () => {
      const c = makeCanvas(tw, th), g = c.getContext("2d");
      g.setTransform(1 / GLOW_CELL, 0, 0, 1 / GLOW_CELL, -world.x0 / GLOW_CELL, -world.y0 / GLOW_CELL);
      g.globalCompositeOperation = "lighter";
      g.lineCap = g.lineJoin = "round";
      return [c, g];
    };
    const [roads, rdg] = glowSheet(), [spots, spg] = glowSheet();
    let g = rdg;
    const dot = makeCanvas(32, 32), dg = dot.getContext("2d"), rg = dg.createRadialGradient(16, 16, 0, 16, 16, 16);
    rg.addColorStop(0, "rgba(255,206,132,.95)"); rg.addColorStop(0.35, "rgba(255,190,112,.45)"); rg.addColorStop(1, "rgba(255,180,100,0)");
    dg.fillStyle = rg; dg.fillRect(0, 0, 32, 32);
    let stage = 0, i = 0, rk = 0;
    const B = data.buildings, R = data.roads || [], LP = data.lamps || [], RK = Object.keys(ROAD_GLOW);
    const job = { roads, spots, w: tw * GLOW_CELL, h: th * GLOW_CELL, done: false };
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
          if (rk >= RK.length) { stage = 1; g = spg; }
        } else if (stage === 1) {
          // lamps: a soft pool and a bright point, the campus's sparkle from afar
          for (let q = 0; q < LP.length; q += 2) {
            g.globalAlpha = 0.5; g.drawImage(dot, LP[q] - 12, LP[q + 1] - 12, 24, 24);
            g.globalAlpha = 0.9; g.drawImage(dot, LP[q] - 5, LP[q + 1] - 5, 10, 10);
          }
          g.globalAlpha = 1;
          stage = 2;
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
    const make = (old, withSpots) => {
      const c = old && old.width === tw && old.height === th ? old : makeCanvas(tw, th), g = c.getContext("2d");
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, tw, th);
      g.setTransform(o.R[0] / C, (-S * o.D[0]) / C, o.R[1] / C, (-S * o.D[1]) / C, -box[0] / C, -box[1] / C);
      g.globalCompositeOperation = "lighter";
      g.drawImage(cityGlow.roads, world.x0, world.y0, cityGlow.w, cityGlow.h);
      if (withSpots) g.drawImage(cityGlow.spots, world.x0, world.y0, cityGlow.w, cityGlow.h);
      return c;
    };
    turned = { r, roads: make(turned && turned.roads, false), all: make(turned && turned.all, true), X0: box[0], Y0: box[1], w: tw * C, h: th * C };
    return turned;
  }
  // Kept at the view's scale (with a margin, on the base map's pixel grid) once the view is still: a 1:1 blit of the
  // diorama's box instead of a stretched one of the whole sheet. One cache per caller (the lights, the fog's bloom).
  const GLOW_PAD = 128;
  const glowLights = { c: null, g: null, ok: false, key: "", offX: 0, offY: 0, s: 0, rot: -1, d: 0, W: 0, H: 0, padD: 0 };
  const glowFog = { c: null, g: null, ok: false, key: "", offX: 0, offY: 0, s: 0, rot: -1, d: 0, W: 0, H: 0, padD: 0 };
  function glowCached(ctx, C, ratio) {
    const T = turnedGlow(view.rot), s = view.s, d = view.dpr, Wd = ctx.canvas.width, Hd = ctx.canvas.height;
    const key = `${ratio}`;
    let sx = 0, sy = 0;
    const fresh = C.ok && C.s === s && C.rot === view.rot && C.d === d && C.W === Wd && C.H === Hd && C.key === key;
    if (fresh) { sx = C.offX - baseOffX(); sy = C.offY - baseOffY(); }
    if (!fresh || Math.abs(sx) > C.padD || Math.abs(sy) > C.padD) {
      if (viewMoving && !(fresh)) return false;   // mid-zoom: stretch the sheets instead (a cache would be stale next frame)
      const padD = Math.round(GLOW_PAD * d), offX = baseOffX(), offY = baseOffY();
      const g = devCanvas(C, Wd + 2 * padD, Hd + 2 * padD), k = s * d;
      const dx = T.X0 * k - offX + padD, dy = T.Y0 * k - offY + padD, dw = T.w * k, dh = T.h * k;
      g.globalCompositeOperation = "lighter";
      // roads + ratio × spots, from the two sheets (roads alone, roads with spots)
      if (ratio > 0) { g.globalAlpha = ratio; g.drawImage(T.all, dx, dy, dw, dh); }
      if (ratio < 1) { g.globalAlpha = 1 - ratio; g.drawImage(T.roads, dx, dy, dw, dh); }
      g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
      Object.assign(C, { ok: true, key, offX, offY, s, rot: view.rot, d, W: Wd, H: Hd, padD });
      sx = 0; sy = 0;
    }
    const r = slabRect(Wd, Hd);
    if (!r) return true;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(C.c, r[0] - sx + C.padD, r[1] - sy + C.padD, r[2], r[3], r[0], r[1], r[2], r[3]);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    return true;
  }
  /** The city glow, roads at roadsA and spots at spotsA (≤ roadsA), added on top. Builds itself the first time. */
  function drawCityGlow(ctx, roadsA, spotsA, C = glowLights) {
    if (!cityGlow) cityGlow = cityGlowJob();
    if (!cityGlow.done) { cityGlow.step(3); return; }   // show it only once it's whole
    if (roadsA < 0.004) return;
    // the spots' share, quantised so that a slow fade doesn't redraw the cache every frame
    const ratio = Math.round(Math.min(1, Math.max(0, spotsA / roadsA)) * 24) / 24;
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = roadsA;
    const done = glowCached(ctx, C, ratio);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    if (done) return;
    const T = turnedGlow(view.rot), s = view.s;
    const dx = (T.X0 - view.X) * s + view.w / 2, dy = (T.Y0 - view.Y) * s + view.h / 2, dw = T.w * s, dh = T.h * s;
    ctx.globalCompositeOperation = "lighter";
    // from two sheets, roads alone and roads with spots: one blit when the two alphas agree, else two
    if (spotsA < 0.01) { ctx.globalAlpha = roadsA; ctx.drawImage(T.roads, dx, dy, dw, dh); }
    else if (spotsA >= roadsA - 0.01) { ctx.globalAlpha = roadsA; ctx.drawImage(T.all, dx, dy, dw, dh); }
    else {
      ctx.globalAlpha = spotsA; ctx.drawImage(T.all, dx, dy, dw, dh);
      ctx.globalAlpha = roadsA - spotsA; ctx.drawImage(T.roads, dx, dy, dw, dh);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
  const glowReady = () => !!(cityGlow && cityGlow.done);

  // ---------------------------------------------------------------- layer: night lights (z 82)
  // The hand-over between the lights tiles and the city glow, by device px per metre k. A lights tile holds lamp pools
  // at every level and lit windows from 0.5 px/m (each window from 1 px/m, a sparse speckle from 0.5), and tiles.js
  // picks a 0.5 px/m tile for screens down to about 0.32 px/m. Below that a tile would show only specks of lamp light, so
  // there the glow's spots (lamps, lit buildings) take over: they crossfade with the tiles over HAND_LO..HAND_HI, never
  // both at full strength, so a lamp is never lit twice (the tile's pool and the glow's) and the windows never go dark.
  // The glow's streetlit roads have no counterpart in the tiles: they fade in from 1.2 px/m, so the streets read as
  // the city spreads out below you. And the workers needn't render a far-zoom lights layer at all.
  const HAND_LO = 0.26, HAND_HI = 0.38;
  app.addLayer({
    id: "sky-lights", z: 82,
    draw(ctx, f) {
      // the lights tiles are only drawn (and so only rendered) once dusk comes
      if (!app.layerEnabled("sky") || W.night <= 0.02) { if (glowLights.ok) freeCanvas(glowLights); return; }
      const a = Math.min(1, W.night * 1.08), k = f.s * f.dpr;
      const tilesA = glowReady() ? smooth(HAND_LO, HAND_HI, k) : 1;
      if (tilesA > 0.01) app.tiles.draw(ctx, f.view, "lights", { alpha: a * tilesA, op: "lighter" });
      const roadsA = smooth(1.2, 0.45, k);
      if (roadsA <= 0.01 && glowLights.ok) freeCanvas(glowLights);
      if (roadsA > 0.01) {
        const g = a * (1 - 0.5 * W.fog);
        drawCityGlow(ctx, g * roadsA, g * Math.min(roadsA, 1 - tilesA));
      }
    },
    // nothing here moves by itself: the lights come up with the dusk by the clock's timer, and a lights tile that
    // arrives draws its own frame
    fps() { return 0; },
  });

  // ---------------------------------------------------------------- layer: floodlit landmarks (z 81)
  // At night floodlights at their feet wash Lincoln and Morrill Towers' cream piers scarlet. The lights tiles can only
  // add light, and red added to the blue night turns pink, so the paint (landmarks.js uplights) is laid over the night
  // tint here, in its own colours, with everything the map draws in front of a tower rubbed out of it: the objects that
  // come after it in the tiles' draw order, by their silhouettes. One small canvas per tower, redrawn only when the
  // zoom, the turn or the season changes, or a pan brings more of a tower than it holds on screen.
  const UPLIT = app.renderer.uplitIds();
  const upCache = UPLIT.map(() => ({ c: null, g: null, ok: false, key: "", x0: 0, y0: 0, x1: 0, y1: 0 }));
  const UP_PAD = 96;   // device px drawn beyond the screen's edge, so a short pan needn't redraw
  let upStyle = 0;
  app.on("style", () => { upStyle++; });
  function uplitCanvas(C, i, r, k, lod, x0, y0, x1, y1) {
    const g = devCanvas(C, x1 - x0, y1 - y0), cam = { k, lod, ox: x0, oy: y0 }, Sr = app.scene.forRot(r);
    app.renderer.uplights(g, r, cam, i);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = "destination-out";
    g.fillStyle = "#000";
    for (const id of app.scene.query(r, "objects", x0 / k, y0 / k, x1 / k, y1 / k)) {
      if (Sr.rank[id] <= Sr.rank[i] || (id < app.scene.B && data.buildings[id].hidden)) continue;
      g.fill(app.renderer.silhouette(new Path2D(), r, cam, id, app.tileStyle));
    }
    g.globalCompositeOperation = "source-over";
    Object.assign(C, { ok: true, x0, y0, x1, y1 });
  }
  app.addLayer({
    id: "sky-uplights", z: 81,
    draw(ctx) {
      if (!UPLIT.length) return;
      if (!app.layerEnabled("sky") || W.night <= 0.02) { for (const C of upCache) if (C.ok) freeCanvas(C); return; }
      const r = view.rot, bb = app.scene.forRot(r).objBB;
      const k = view.s * view.dpr, lod = Math.pow(2, app.tiles.levelFor(view));
      const offX = baseOffX(), offY = baseOffY(), Wd = ctx.canvas.width, Hd = ctx.canvas.height;
      const key = `${k}|${lod}|${r}|${upStyle}`;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // (eased in later than the windows: half-lit scarlet over the dusk's pale walls reads as pink)
      ctx.globalAlpha = Math.pow(Math.min(1, W.night * 1.08), 1.6);
      for (let n = 0; n < UPLIT.length; n++) {
        const i = UPLIT[n], C = upCache[n];
        // the tower's box (device px on the base map's grid), and the part of it on screen
        const bx0 = Math.floor(bb[4 * i] * k) - 2, by0 = Math.floor(bb[4 * i + 1] * k) - 2;
        const bx1 = Math.ceil(bb[4 * i + 2] * k) + 2, by1 = Math.ceil(bb[4 * i + 3] * k) + 2;
        const sx0 = Math.max(bx0, offX), sy0 = Math.max(by0, offY), sx1 = Math.min(bx1, offX + Wd), sy1 = Math.min(by1, offY + Hd);
        if (sx1 <= sx0 || sy1 <= sy0) continue;
        if (!C.ok || C.key !== key || sx0 < C.x0 || sy0 < C.y0 || sx1 > C.x1 || sy1 > C.y1) {
          C.key = key;
          uplitCanvas(C, i, r, k, lod, Math.max(bx0, offX - UP_PAD), Math.max(by0, offY - UP_PAD), Math.min(bx1, offX + Wd + UP_PAD), Math.min(by1, offY + Hd + UP_PAD));
        }
        ctx.drawImage(C.c, C.x0 - offX, C.y0 - offY);
      }
      // in fog, rain or snow the beams show above the roofs too (in clear air they vanish into the dark)
      const haze = Math.max(W.fog, 0.6 * W.rain, 0.7 * W.snow);
      if (haze > 0.05) {
        const cam = { k, lod, ox: offX, oy: offY }, a = ctx.globalAlpha * Math.min(1, haze * 1.3);
        ctx.globalAlpha = 1;
        for (const i of UPLIT) app.renderer.uplightBeams(ctx, r, cam, i, a);
      }
      ctx.restore();
    },
    // still, like the lights: the dusk brings it up by the clock's timer
    fps() { return 0; },
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
  const FOG_BLOOM = [0.5, 0.75];   // the city glow over the fog, per unit of fog at full night: up close, from afar

  let hazeFill = null, hazeKey = NaN, hazeVer = -1, hazeH = 0;
  // Like the cloud shadows: the drifting banks kept in a device-pixel cache with a margin (anchored on the base map's
  // grid, shifted by the drift and pans), the screen-fixed haze in another; two 1:1 blits a frame instead of a
  // low-res sheet recomposed and stretched over the whole screen (the old way, kept for mid-zoom frames).
  const FOG_PAD = 128;
  const fogC = { c: null, g: null, ok: false, key: "", offX: 0, offY: 0, s: 0, rot: -1, d: 0, W: 0, H: 0, padD: 0, dx: 0, dy: 0 };
  const fogSheet = { c: null, g: null }, hazeC = { c: null, g: null, ok: false, fill: null };
  let fogDX = 0, fogDY = 0;   // the banks' drift, ground metres, unwrapped
  function freeFog() { freeCanvas(fogC); freeCanvas(fogSheet); freeCanvas(hazeC); }
  function drawFog(ctx, f) {
    const w = f.w, h = f.h, d = f.dpr, fog = W.fog;
    // drifting banks over the ground, recoloured to the haze of the hour
    windGround(_wg);
    const dt = calm ? 0 : f.dt, sp = 1.5 + W.windMph * 0.2;
    fogDX += _wg[0] * sp * dt; fogDY += _wg[1] * sp * dt;
    fogOX = fogDX % FOG_TILE_M; fogOY = fogDY % FOG_TILE_M;
    const [hr, hg, hb] = L.haze;
    const bankA = fog * 0.55 * (1 - 0.35 * W.night);
    // farther air is thicker: more haze up the screen, and more when zoomed out
    const zf = Math.round(clamp01(Math.log2(view.metresAcross() / 400) / 4) * 20) / 20;
    const key = fog * 1000 + zf;
    if (key !== hazeKey || L.hazeVer !== hazeVer || h !== hazeH) {
      hazeKey = key; hazeVer = L.hazeVer; hazeH = h;
      const top = fog * (0.66 + 0.2 * zf), bot = fog * (0.12 + 0.24 * zf);
      hazeFill = ctx.createLinearGradient(0, 0, 0, h);
      hazeFill.addColorStop(0, rgba(hr, hg, hb, top));
      hazeFill.addColorStop(0.55, rgba(hr, hg, hb, (top + bot) * 0.45));
      hazeFill.addColorStop(1, rgba(hr, hg, hb, bot));
    }
    const fkey = `${L.hazeVer}|${Math.round(bankA * 400)}`;
    let at = anchoredAt(fogC, ctx, fogDX, fogDY, fkey);
    if (!at && f.moving && fogC.s !== view.s) {
      // mid-zoom: the old way, everything in one low-res sheet stretched over the screen
      const S = sheet("fog", w, h), g = S.g;
      g.clearRect(0, 0, S.w, S.h);
      g.globalAlpha = bankA;
      fillGround(g, fogPattern(g), FOG_TILE_M / NOISE_N, fogOX, fogOY, S.k);
      g.setTransform(S.k, 0, 0, S.k, 0, 0);
      g.globalAlpha = 1;
      g.globalCompositeOperation = "source-in";
      g.fillStyle = hex(hr, hg, hb);
      g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = "source-over";
      g.fillStyle = hazeFill;
      g.fillRect(0, 0, w, h);
      ctx.drawImage(S.c, 0, 0, w, h);
      return;
    }
    if (!at) {
      const padD = Math.round(FOG_PAD * d), offX = baseOffX(), offY = baseOffY();
      const sw = Math.ceil((ctx.canvas.width + 2 * padD) / SHEET_DIV), sh = Math.ceil((ctx.canvas.height + 2 * padD) / SHEET_DIV), q = 1 / SHEET_DIV;
      const sg = devCanvas(fogSheet, sw, sh);
      sg.globalAlpha = bankA;
      fillGround(sg, fogPattern(sg), FOG_TILE_M / NOISE_N, fogOX, fogOY, d * q, (padD - offX) * q, (padD - offY) * q, FOG_PAD);
      sg.setTransform(1, 0, 0, 1, 0, 0);
      sg.globalAlpha = 1;
      sg.globalCompositeOperation = "source-in";
      sg.fillStyle = hex(hr, hg, hb);
      sg.fillRect(0, 0, sw, sh);
      sg.globalCompositeOperation = "source-over";
      const g = devCanvas(fogC, sw * SHEET_DIV, sh * SHEET_DIV);
      g.globalCompositeOperation = "copy";
      g.drawImage(fogSheet.c, 0, 0, sw * SHEET_DIV, sh * SHEET_DIV);
      g.globalCompositeOperation = "source-over";
      Object.assign(fogC, { ok: true, key: fkey, offX, offY, s: view.s, rot: view.rot, d, W: ctx.canvas.width, H: ctx.canvas.height, padD, dx: fogDX, dy: fogDY });
      at = anchoredAt(fogC, ctx, fogDX, fogDY, fkey);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (at) ctx.drawImage(fogC.c, at[0], at[1]);
    ctx.drawImage(fillCache(hazeC, ctx, hazeFill), 0, 0);
    ctx.setTransform(d, 0, 0, d, 0, 0);
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
    if (f.t >= nextFlash) {
      flashAt = f.t; nextFlash = f.t + 5000 + Math.random() * 13000;
      app.emit("lightning", { distance: 600 + Math.random() * 4400 });   // sound.js: thunder follows at the speed of sound
    }
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
      if (glowFog.ok && !(W.fog > 0.02 && W.night > 0.02)) freeCanvas(glowFog);
      if (fogC.ok && !(W.fog > 0.02)) freeFog();
      if (W.fog > 0.02) {
        drawFog(ctx, f);
        // Lights bloom in fog rather than vanish: over the fog sheet, the city glow again (soft already, 5 m texels:
        // up close a broad halo round each lamp and lit street, from afar the city's light seen through the murk)
        if (W.night > 0.02) {
          // a little more from afar, where the glow is all there is of the city's lights
          const b = Math.min(1, W.night * 1.08) * W.fog * lerp(FOG_BLOOM[0], FOG_BLOOM[1], smooth(1.2, 0.3, f.s * f.dpr));
          drawCityGlow(ctx, b, b, glowFog);
        }
      }
      // counts follow the screen's area, so a phone carries fewer drops than a desktop
      const area = f.w * f.h;
      const wantRain = Math.min(PARTICLE_CAP, Math.round((area / 1600) * W.rain * (calm ? 0.35 : 1)));
      const wantSnow = Math.min(PARTICLE_CAP, Math.round((area / 1500) * W.snow * (calm ? 0.6 : 1)));
      if (wantRain > 0) drawRain(ctx, f, wantRain); else rainN = 0;
      if (wantSnow > 0) drawSnow(ctx, f, wantSnow); else snowN = 0;
      if (W.storm && !calm) drawLightning(ctx, f);
    },
    // Rain and snow: 24 fps (a falling streak or a drifting flake needs no more; lightning rides along). Fog alone:
    // its banks drift a pixel or two a frame, from 10 fps up close to one every couple of seconds from afar. With
    // reduced motion nothing here moves by itself.
    fps(f) {
      if (calm || !app.layerEnabled("sky")) return 0;
      if (W.rain > 0.01 || W.snow > 0.01 || W.storm) return 24;
      if (W.fog > 0.02) {
        windGround(_wg);
        const o = geo.ROTS[view.rot], ax = _wg[0] * o.R[0] + _wg[1] * o.R[1], ay = (_wg[0] * o.D[0] + _wg[1] * o.D[1]) * geo.SIN_T;
        const px = (1.5 + W.windMph * 0.2) * f.s * f.dpr * Math.sqrt(ax * ax + ay * ay) / 1.5;
        return Math.max(0.5, Math.min(10, px));
      }
      return 0;
    },
  });

  // ---------------------------------------------------------------- layer: clouds aloft, mist on the paper (z 86)
  // Zoomed far out, a few fair-weather cumulus sail over the diorama with the wind, a few hundred metres up (low, as a
  // model's clouds would be, so each still reads against the ground it shades), and banks of mist lie on the paper round
  // the diorama's foot. More and thicker clouds with the real cloud cover, a few on the clearest day; always
  // translucent, and gone by the time you zoom in past ~1.2 km across. Above the night lights (a cloud veils them),
  // below the weather, the labels and the aircraft. Each cloud is one sprite drawn once for the zoom and the light of
  // the hour, then blitted 1:1 at whole device pixels: cheap enough to drift at a few frames a second.
  const CL_DOMAIN = 20000, CL_N = 130;         // a wrapping field of clouds round the view, metres
  const CL_RIM0 = 7600, CL_RIM1 = 9400;        // faded out toward the field's rim, where a cloud wraps to the far side
  const CL_IN0 = 1150, CL_IN1 = 2300;          // metres across the screen: none below the first, all from the second
  const CL_PAR = 1.1;                          // parallax: nearer the eye than the ground, so they slide a little faster
  const wisps = [];
  {
    let h = 0x2545f491;
    const rnd = () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
    for (let i = 0; i < CL_N; i++) {
      // puffs [x, y, r] in units of the cloud's width: a row along a flat base, bigger toward the middle, and a crown
      const n = 4 + Math.floor(rnd() * 4), puffs = [];
      for (let k = 0; k < n; k++) {
        const t = k / (n - 1) - 0.5, r = 0.11 + 0.07 * rnd() + 0.09 * (1 - Math.abs(t) * 2);
        puffs.push([t * 0.74 + (rnd() - 0.5) * 0.06, -r * 0.5 + (rnd() - 0.5) * 0.04, r]);
      }
      const m = 1 + (rnd() < 0.65 ? 1 : 0);
      for (let k = 0; k < m; k++) puffs.push([(rnd() - 0.5) * 0.36, -0.2 - 0.09 * rnd(), 0.17 + 0.08 * rnd()]);
      wisps.push({
        x: (rnd() - 0.5) * CL_DOMAIN, y: (rnd() - 0.5) * CL_DOMAIN, z: 340 + 280 * rnd(),
        size: 300 + 560 * rnd() * rnd() + 160 * rnd(),   // metres across: mostly modest, the odd big one
        rank: rnd(), a: 0.7 + 0.3 * rnd(), flip: rnd() < 0.5, puffs, c: null, k: 0, ver: -1, ox: 0, oy: 0,
      });
    }
    wisps.sort((a, b) => a.z - b.z);   // (drawn far to near below: lower ones first)
  }
  // soft round puffs, white and in the light of the hour (re-tinted when it changes)
  const PUFF_N = 96;
  let puffW = null, puffSoft = null, puffLit = null, puffLitVer = -1, shadowDisc = null;
  function discs() {
    if (!puffW) {
      puffW = makeCanvas(PUFF_N, PUFF_N);
      const g = puffW.getContext("2d"), r = PUFF_N / 2, gr = g.createRadialGradient(r, r, 0, r, r, r);
      gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.8, "rgba(255,255,255,1)"); gr.addColorStop(0.9, "rgba(255,255,255,.7)"); gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr; g.fillRect(0, 0, PUFF_N, PUFF_N);
      shadowDisc = makeCanvas(PUFF_N, PUFF_N);
      const sg = shadowDisc.getContext("2d"), sr = sg.createRadialGradient(r, r, 0, r, r, r);
      sr.addColorStop(0, "rgba(46,58,92,1)"); sr.addColorStop(0.55, "rgba(46,58,92,.7)"); sr.addColorStop(1, "rgba(46,58,92,0)");
      sg.fillStyle = sr; sg.fillRect(0, 0, PUFF_N, PUFF_N);
      // the highlights' disc is soft all the way out, so overlapping ones blend instead of showing their rims
      puffSoft = makeCanvas(PUFF_N, PUFF_N);
      const hg = puffSoft.getContext("2d"), hr = hg.createRadialGradient(r, r, 0, r, r, r);
      hr.addColorStop(0, "rgba(255,255,255,1)"); hr.addColorStop(0.45, "rgba(255,255,255,.6)"); hr.addColorStop(1, "rgba(255,255,255,0)");
      hg.fillStyle = hr; hg.fillRect(0, 0, PUFF_N, PUFF_N);
      puffLit = makeCanvas(PUFF_N, PUFF_N);
    }
    if (puffLitVer !== L.cloudVer) {
      puffLitVer = L.cloudVer;
      const g = puffLit.getContext("2d");
      g.globalCompositeOperation = "copy"; g.drawImage(puffSoft, 0, 0);
      g.globalCompositeOperation = "source-in"; g.fillStyle = hex(L.clLit[0], L.clLit[1], L.clLit[2]); g.fillRect(0, 0, PUFF_N, PUFF_N);
    }
  }
  /** one cloud's sprite at k device px per metre, in the light of the hour */
  function wispSprite(c, k) {
    discs();
    const Wp = c.size * k, cw = Math.ceil(Wp * 1.22) + 4, ch = Math.ceil(Wp * 0.72) + 4;
    if (!c.c) c.c = makeCanvas(cw, ch);
    else if (c.c.width !== cw || c.c.height !== ch) { c.c.width = cw; c.c.height = ch; }
    const g = c.c.getContext("2d"), ox = cw / 2, oy = Math.round(ch * 0.74);   // (ox, oy): the middle of its flat base
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, cw, ch);
    if (c.flip) { g.translate(cw, 0); g.scale(-1, 1); }
    for (const p of c.puffs) g.drawImage(puffW, ox + (p[0] - p[2]) * Wp, oy + (p[1] - p[2]) * Wp, 2 * p[2] * Wp, 2 * p[2] * Wp);
    g.setTransform(1, 0, 0, 1, 0, 0);
    // the flat base: what hangs below it fades away
    g.globalCompositeOperation = "destination-out";
    const fb = g.createLinearGradient(0, oy - 0.03 * Wp, 0, oy + 0.1 * Wp);
    fb.addColorStop(0, "rgba(0,0,0,0)"); fb.addColorStop(1, "rgba(0,0,0,1)");
    g.fillStyle = fb; g.fillRect(0, oy - 0.03 * Wp, cw, ch);
    // light from the upper left (as on the buildings), shade underneath and to the right
    g.globalCompositeOperation = "source-atop";
    const lit = hex(L.clLit[0], L.clLit[1], L.clLit[2]), shade = hex(L.clShade[0], L.clShade[1], L.clShade[2]);
    const gr = g.createLinearGradient(ox - 0.25 * Wp, oy - 0.42 * Wp, ox + 0.12 * Wp, oy + 0.02 * Wp);
    gr.addColorStop(0, lit); gr.addColorStop(0.5, lit); gr.addColorStop(0.9, shade); gr.addColorStop(1, shade);
    g.fillStyle = gr; g.fillRect(0, 0, cw, ch);
    // the cauliflower tops: each puff lit again on its upper left
    g.globalAlpha = 0.75;
    if (c.flip) { g.translate(cw, 0); g.scale(-1, 1); }
    const left = c.flip ? 1 : -1;   // (in a mirrored sprite the screen's left is the sprite's right)
    for (const p of c.puffs) {
      const r = p[2] * Wp * 0.78;
      g.drawImage(puffLit, ox + p[0] * Wp + left * p[2] * Wp * 0.3 - r, oy + p[1] * Wp - p[2] * Wp * 0.34 - r, 2 * r, 2 * r);
    }
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
    c.k = k; c.ver = L.cloudVer; c.ox = ox; c.oy = oy;
  }
  function freeWisps() { for (const c of wisps) c.c = null; }

  // Mist on the paper: soft banks along the diorama's four sides, lying at the foot of its walls (the paper's level),
  // pushed out so they mostly sit on the paper. Static (they'd only slide along the walls); two shapes, one per run of
  // the sides on screen, three lengths, drawn once per zoom, turn and light.
  const MIST = [];   // [x, y, side (0: along x, 1: along y), size variant, outward normal x, y]
  {
    const step = 1050, out = 360;
    let v = 0;
    for (let x = world.x0 + step * 0.45; x < world.x1 - step * 0.3; x += step) { MIST.push([x, world.y0 - out, 0, v++ % 3, 0, -1]); MIST.push([x + step * 0.5, world.y1 + out, 0, v++ % 3, 0, 1]); }
    for (let y = world.y0 + step * 0.45; y < world.y1 - step * 0.3; y += step) { MIST.push([world.x0 - out, y, 1, v++ % 3, -1, 0]); MIST.push([world.x1 + out, y + step * 0.5, 1, v++ % 3, 1, 0]); }
  }
  const MIST_FAR = 260;   // the far sides' banks lie behind the diorama: further out, so they don't climb onto its top
  const MIST_LEN = [1150, 1500, 1850], MIST_THICK = 0.3;
  const mistSpr = [];   // [side * 3 + variant] → { c, ox, oy }
  let mistK = 0, mistRot = -1, mistVer = -1;
  function mistSprites(k) {
    if (mistK === k && mistRot === view.rot && mistVer === L.cloudVer && mistSpr.length) return;
    discs();
    mistK = k; mistRot = view.rot; mistVer = L.cloudVer;
    const o = geo.ROTS[view.rot], S = geo.SIN_T;
    for (let side = 0; side < 2; side++) for (let v = 0; v < 3; v++) {
      const len = MIST_LEN[v], th = len * MIST_THICK;
      // the ground ellipse (len along the side, th across) through the view's projection, in device px
      const ux = side ? 0 : 1, uy = side ? 1 : 0, nx = uy, ny = ux;
      const a = (ux * o.R[0] + uy * o.R[1]) * k, b = -(ux * o.D[0] + uy * o.D[1]) * S * k;
      const cc = (nx * o.R[0] + ny * o.R[1]) * k, d = -(nx * o.D[0] + ny * o.D[1]) * S * k;
      const hw = Math.abs(a) * len / 2 + Math.abs(cc) * th / 2, hh = Math.abs(b) * len / 2 + Math.abs(d) * th / 2;
      const cw = Math.ceil(hw * 2) + 4, ch = Math.ceil(hh * 2) + 4;
      const sp = mistSpr[side * 3 + v] || (mistSpr[side * 3 + v] = { c: makeCanvas(cw, ch), ox: 0, oy: 0 });
      if (sp.c.width !== cw || sp.c.height !== ch) { sp.c.width = cw; sp.c.height = ch; }
      const g = sp.c.getContext("2d");
      g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
      g.clearRect(0, 0, cw, ch);
      sp.ox = cw / 2; sp.oy = ch / 2;
      g.setTransform(a, b, cc, d, sp.ox, sp.oy);
      // a long soft bank: three overlapping puffs along its length
      for (let q = -1; q <= 1; q++) g.drawImage(puffW, q * len * 0.27 - len * 0.3, -th / 2 - th * 0.1 * Math.abs(q), len * 0.6, th * (1 - 0.2 * Math.abs(q)));
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = "source-in";
      g.fillStyle = hex(L.mist[0], L.mist[1], L.mist[2]);
      g.fillRect(0, 0, cw, ch);
      g.globalCompositeOperation = "source-over";
    }
  }
  function freeMist() { mistSpr.length = 0; mistK = 0; }

  let wispDX = 0, wispDY = 0, cloudsVis = 0, cloudsOn = false;
  const noClouds = app.params.has("noclouds");
  const cloudsWanted = (f) => app.layerEnabled("sky") && !noClouds ? smooth(CL_IN0, CL_IN1, f.w / f.s) : 0;
  app.addLayer({
    id: "sky-clouds", z: 86,
    draw(ctx, f) {
      const vis = cloudsWanted(f);
      cloudsVis = vis;
      if (vis < 0.01) { if (cloudsOn) { cloudsOn = false; freeWisps(); freeMist(); } return; }
      cloudsOn = true;
      const d = f.dpr, s = f.s, k = s * d, dt = calm ? 0 : f.dt;
      // sprites are redrawn for a new zoom only once the view settles; mid-zoom they're stretched
      const still = !f.moving;
      const o = geo.ROTS[view.rot], S = geo.SIN_T, C = geo.COS_T;
      const cover = clamp01(W.cloud / 100);
      const day = L.daylight;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // the mist on the paper first (it lies lowest): whole pixels on the base map's grid, so it holds still as you pan
      const mistA = vis * 0.42 * L.mistA * (0.75 + 0.35 * cover) * (1 - 0.6 * W.fog);
      if (mistA > 0.01) {
        if (still || !mistSpr.length) mistSprites(k);
        const kk = k / mistK, offX = baseOffX(), offY = baseOffY();
        ctx.globalAlpha = mistA;
        for (let i = 0; i < MIST.length; i++) {
          const m = MIST[i], sp = mistSpr[m[2] * 3 + m[3]];
          const far = m[4] * o.D[0] + m[5] * o.D[1] > 0 ? MIST_FAR : 0, mx = m[0] + m[4] * far, my = m[1] + m[5] * far;
          const X = mx * o.R[0] + my * o.R[1], Y = -((mx * o.D[0] + my * o.D[1]) * S - SLAB_DEPTH * C);
          const px = X * k - offX, py = Y * k - offY, cw = sp.c.width * kk, ch = sp.c.height * kk;
          if (px + cw < 0 || px - cw > ctx.canvas.width || py + ch < 0 || py - ch > ctx.canvas.height) continue;
          if (kk === 1) ctx.drawImage(sp.c, Math.round(px - sp.ox), Math.round(py - sp.oy));
          else ctx.drawImage(sp.c, px - sp.ox * kk, py - sp.oy * kk, cw, ch);
        }
      }
      // the clouds: drift with the wind, then each to the copy of the field nearest the middle of the view
      windGround(_wg);
      const sp = cloudSpeed();
      wispDX = (wispDX + _wg[0] * sp * dt) % CL_DOMAIN; wispDY = (wispDY + _wg[1] * sp * dt) % CL_DOMAIN;
      // the ground point at the middle of the screen
      const u = view.X, v = -view.Y / S, cx = u * o.R[0] + v * o.D[0], cy = u * o.R[1] + v * o.D[1];
      const density = 0.24 + 0.76 * cover;
      const base = vis * L.clA * (0.5 + 0.2 * cover);
      const kc = k * CL_PAR, W2 = ctx.canvas.width / 2, H2 = ctx.canvas.height / 2;
      // two passes: by day first their shadows on the ground (all below every cloud), then the clouds
      for (let pass = L.daylight > 0.05 ? 0 : 1; pass < 2; pass++) {
        for (let i = 0; i < wisps.length; i++) {
          const c = wisps[i];
          const pres = smooth(c.rank - 0.07, c.rank + 0.07, density);
          // (a cloud out of sight gives its sprite back: near the zoom they fade in at, on a retina screen, one is MBs)
          if (pres < 0.01) { if (c.c) c.c = null; continue; }
          let x = c.x + wispDX - cx, y = c.y + wispDY - cy;
          x -= CL_DOMAIN * Math.round(x / CL_DOMAIN); y -= CL_DOMAIN * Math.round(y / CL_DOMAIN);
          const rim = smooth(CL_RIM1, CL_RIM0, Math.max(Math.abs(x), Math.abs(y)));
          const a = Math.min(0.62, base * pres * rim * c.a);
          if (a < 0.01) { if (c.c) c.c = null; continue; }
          // its place on the screen (device px), parallax about the middle; the sprite's anchor is its base
          const px = W2 + (x * o.R[0] + y * o.R[1]) * kc, py = H2 - ((x * o.D[0] + y * o.D[1]) * S + c.z * C) * kc;
          const half = c.size * kc * 0.62;
          if (px + half < 0 || px - half > ctx.canvas.width || py + half < -half || py - half > ctx.canvas.height + half) { if (c.c) c.c = null; continue; }
          if (pass === 0) {
            // its shadow on the ground straight beneath it (at the ground's own scale), soft and faint; only on the
            // diorama's top, not the paper far below (faded out as it nears an edge rather than clipped: a clip path
            // costs a mask of the whole slab every frame)
            const wx = x + cx, wy = y + cy;
            const inside = Math.min(wx - world.x0, world.x1 - wx, wy - world.y0, world.y1 - wy);
            const sa = a * 0.3 * L.daylight * smooth(-0.05 * c.size, 0.4 * c.size, inside);
            if (sa < 0.01) continue;
            const gx = W2 + (x * o.R[0] + y * o.R[1]) * k, gy = H2 - (x * o.D[0] + y * o.D[1]) * S * k;
            const sw = c.size * k * 0.95, sh = sw * 0.36;
            ctx.globalAlpha = sa;
            ctx.drawImage(shadowDisc, gx - sw / 2, gy - sh / 2, sw, sh);
            continue;
          }
          if (still && (c.k !== kc || c.ver !== L.cloudVer) || !c.c) wispSprite(c, kc);
          ctx.globalAlpha = a;
          if (c.k === kc) ctx.drawImage(c.c, Math.round(px - c.ox), Math.round(py - c.oy));
          else { const q = kc / c.k; ctx.drawImage(c.c, px - c.ox * q, py - c.oy * q, c.c.width * q, c.c.height * q); }
        }
      }
      ctx.globalAlpha = 1;
      ctx.setTransform(d, 0, 0, d, 0, 0);
    },
    // they drift about a device pixel a frame: a frame or two a second from afar, up to 12 as they fade out
    fps(f) {
      if (calm || cloudsVis < 0.01) return 0;
      const px = driftPx(f.s, f.dpr) * CL_PAR;
      return px < 0.05 ? 0 : Math.max(0.5, Math.min(12, px));
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
