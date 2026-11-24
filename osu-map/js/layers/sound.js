// Soundscape: an ambient soundscape and short sound cues, all made on the spot with the Web Audio API (no audio files,
// no network): noise buffers and a few textures generated once, oscillators, filters and envelopes.
//
// Off by default (the "Sound" switch). A browser lets audio start only after a gesture: turning the switch on is one
// (the "layers" event is emitted synchronously from the switch's change handler, so the context is created or resumed
// inside it); when the switch was left on from an earlier visit, sound starts on the first pointer or key press.
// A hidden tab suspends the context; ambient mode (app.ambient: the window unfocused, or nobody has touched the page
// for 2 minutes) halves the volume.
//
// The mix follows the app's state, read by a 4 Hz timer (nothing runs in the map's draw loop, no layer is added):
// birdsong by day (a dawn chorus, sparse at midday, species by season, the odd owl at night), crickets on warm nights
// (chirping at the rate the temperature sets), wind and its gusts (and the leaves it stirs), rain and thunder, a
// distant traffic hum (louder near busy roads; cars passing at street zoom), the crowd at Ohio Stadium on a game day
// (a roar when Ohio State scores), water lapping near Mirror Lake and the Olentangy, and the creatures other modules
// say are on screen (app.whimsy). Close up, local sounds are louder; far out, a faint wash.
//
// app.sound = { cue(name, { x, y }?) → bool, on, state, volume, debug() } — names: squirrel, quack, honk, bark, chirp,
// flock, rustle, crunch, snowball, hiss, pop. A cue at a ground point is panned by where it is on screen and quieter
// off screen. Test switches: ?sound=on (start enabled; still waits for a gesture where the browser requires one),
// ?sound=debug (on, and app.sound._graph exposes the context and buses for measuring; app.sound.debug() always works).

const CUE_NAMES = ["squirrel", "quack", "honk", "bark", "chirp", "flock", "rustle", "crunch", "snowball", "hiss", "pop"];
const TICK_MS = 250;
const GESTURES = ["pointerdown", "pointerup", "keydown", "touchend", "click"];
const MAX_VOICES = { cue: 6, critter: 3, bird: 10, fx: 8 };
const BASE_VOLUME = 0.6;        // the master, before the user's volume and the ambient-mode duck
const OUT_GAIN = 0.62;          // after the limiter (whose make-up gain lifts everything a little): peaks stay < −3 dBFS
const BED_MIN = 0.003;          // a bed quieter than this (≈ −62 dBFS) is not worth running
const LN_FAR = Math.log(0.3), LN_NEAR = Math.log(8);     // view.s (CSS px per metre): whole campus … street level

// cue loudness, so that each peaks about alike (measured on the cue bus: −25…−33 dBFS at a gesture's full strength)
const CUE_GAIN = { squirrel: 0.5, quack: 1.0, honk: 0.85, bark: 0.5, chirp: 0.3, flock: 1.2, rustle: 0.9, crunch: 1.2, snowball: 0.55, hiss: 0.8, pop: 0.42 };

// traffic over the day (Columbus local hour), weekday; weekends are lighter in the morning
const TRAFFIC = [0.16, 0.1, 0.08, 0.08, 0.12, 0.26, 0.5, 0.85, 1, 0.8, 0.7, 0.72, 0.76, 0.72, 0.72, 0.8, 0.95, 1, 0.82, 0.64, 0.52, 0.42, 0.32, 0.22];
// how much each kind of road adds to the hum (per metre of road)
const ROAD_W = { motorway: 1.6, motorway_link: 0.8, trunk: 1.4, trunk_link: 0.7, primary: 1, primary_link: 0.6, secondary: 0.75,
  secondary_link: 0.45, tertiary: 0.45, tertiary_link: 0.3, unclassified: 0.15, residential: 0.12, busway: 0.2, living_street: 0.04, service: 0.02 };
// birds: how lively each season is, and who sings (weights)
const BIRD_SEASON = { spring: 1, summer: 0.8, autumn: 0.45, "late-autumn": 0.3, winter: 0.25 };
const BIRDS = {
  spring: [["robin", 3], ["cardinal", 2], ["sparrow", 2], ["finch", 2], ["chickadee", 1], ["chip", 1]],
  summer: [["robin", 2], ["cardinal", 2], ["sparrow", 2], ["finch", 2], ["chickadee", 1], ["chip", 1]],
  autumn: [["chickadee", 2], ["chip", 3], ["cardinal", 1], ["finch", 1], ["robin", 1]],
  "late-autumn": [["chickadee", 3], ["chip", 3], ["cardinal", 1], ["junco", 1]],
  winter: [["chickadee", 3], ["chip", 3], ["cardinal", 1], ["junco", 2]],
};
const CRICKET_SEASON = { summer: 1, autumn: 0.6, spring: 0.2, "late-autumn": 0, winter: 0 };
const LEAF_SEASON = { spring: 0.6, summer: 0.8, autumn: 1, "late-autumn": 0.7, winter: 0.15 };
const SEASON_TEMP = { spring: 58, summer: 76, autumn: 60, "late-autumn": 44, winter: 30 };
const EMPTY = {};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const rnd = (a, b) => a + Math.random() * (b - a);
const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const weighted = (list) => { let s = 0; for (const e of list) s += e[1]; let r = Math.random() * s; for (const e of list) { r -= e[1]; if (r <= 0) return e[0]; } return list[0][0]; };
/** how many events of a process at `rate` per second fall in dt seconds (0 or 1 mostly; more when the rate is high) */
const due = (rate, dt) => { const m = rate * dt; if (!(m > 0)) return 0; let k = Math.floor(m); if (Math.random() < m - k) k++; return k; };

export function init(app) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const mode = (app.params.get("sound") || "").trim().toLowerCase();
  const FORCE = /^(on|1|true|yes|debug)$/.test(mode);
  const DEBUG = mode === "debug";
  const ID = "sound";

  if (!AC) {
    app.sound = { cue: () => false, get on() { return false; }, state: "unsupported", volume: 0, debug: () => ({ state: "unsupported" }) };
    return;
  }

  // ---------------------------------------------------------------- the switch
  if (app.ui && app.ui.registerToggle) app.ui.registerToggle({ id: ID, label: "Sound", defaultOn: false });
  else app.setLayerEnabled(ID, false);
  if (FORCE && !app.layerEnabled(ID)) app.setLayerEnabled(ID, true);   // not saved: the switch's own handler saves
  let wanted = app.layerEnabled(ID);

  let ctx = null, G = null, grids = null, timer = 0, offTimer = 0, armed = false, lastTick = 0, tickN = 0, tickErr = false;
  let volume = 1;
  const live = { cue: 0, critter: 0, bird: 0, fx: 0, nodes: 0, made: 0 };
  const perf = { ticks: 0, ms: 0, max: 0, buildMs: 0, gridMs: 0 };
  const mix = {};            // the latest levels, for debug()
  const ua = navigator.userActivation;
  const mayStart = () => !ua || ua.isActive || ua.hasBeenActive;

  // ---------------------------------------------------------------- starting and stopping
  function create() {
    // ambience: bigger buffers, fewer wake-ups (a cue may start a few tens of ms later)
    try { ctx = new AC({ latencyHint: "playback" }); } catch { try { ctx = new AC(); } catch (e) { console.warn("[sound] no audio:", e); ctx = null; return; } }
    ctx.onstatechange = onState;
  }
  function start() {
    clearTimeout(offTimer); offTimer = 0;
    if (!wanted || document.hidden) return;
    if (!ctx && (FORCE || mayStart())) create();
    if (!ctx) { arm(); return; }
    if (ctx.state === "running") onRunning();
    else {
      const p = ctx.resume();
      if (p && p.catch) p.catch(() => {});
      if (ctx.state !== "running") arm();
    }
  }
  function onState() {
    if (!ctx) return;
    if (ctx.state === "running") {
      if (document.hidden || (!wanted && !offTimer)) { ctx.suspend(); return; }
      if (wanted) onRunning();
    } else {
      stopTimer();
      if (wanted && !document.hidden && ctx.state !== "closed") arm();
    }
  }
  function onRunning() {
    disarm();
    if (!G) {
      try { build(); } catch (e) { console.error("[sound] could not build the mix:", e); return; }
    }
    if (!timer) {
      lastTick = performance.now();
      tick();
      timer = setInterval(tick, TICK_MS);
    }
  }
  function stop() {
    disarm(); stopTimer();
    if (!ctx || ctx.state !== "running") return;
    if (G) fadeMaster(0, 0.08);
    clearTimeout(offTimer);
    offTimer = setTimeout(() => { offTimer = 0; if (!wanted && ctx.state === "running") ctx.suspend(); }, 450);
  }
  function stopTimer() { if (timer) { clearInterval(timer); timer = 0; } }
  function fadeMaster(v, tc) {
    const p = G.master.gain, t = ctx.currentTime;
    if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t); else { p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); }
    p.setTargetAtTime(v, t, tc);
    p._sv = v;
  }
  // until a gesture lets the context run
  function arm() {
    if (armed) return;
    armed = true;
    for (const e of GESTURES) window.addEventListener(e, onGesture, { capture: true, passive: true });
  }
  function disarm() {
    if (!armed) return;
    armed = false;
    for (const e of GESTURES) window.removeEventListener(e, onGesture, { capture: true });
  }
  function onGesture() {
    if (!wanted || document.hidden) { disarm(); return; }
    if (!ctx) create();
    if (!ctx) { disarm(); return; }
    if (ctx.state === "running") onRunning();
    else { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); }
  }

  app.on("layers", (p) => {
    if (!p || p.id !== ID || !!p.on === wanted) return;
    wanted = !!p.on;
    if (wanted) start(); else stop();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopTimer(); disarm();
      if (ctx && ctx.state === "running") {
        if (G) fadeMaster(0, 0.03);
        clearTimeout(offTimer);
        offTimer = setTimeout(() => { offTimer = 0; if (document.hidden && ctx.state === "running") ctx.suspend(); }, 120);
      }
    } else if (wanted) start();
  });
  // the lightning flash, if the sky ever tells (atmosphere.js may emit "lightning"): thunder follows it
  let lightningSeen = -1e9;
  app.on("lightning", (p) => {
    if (!G || !ctx || ctx.state !== "running") return;
    lightningSeen = ctx.currentTime;
    const d = p && Number.isFinite(p.distance) ? p.distance : rnd(400, 4000);
    thunder(ctx.currentTime + 0.05 + d / 343, clamp(1 - d / 5000, 0.15, 1));
  });

  // ---------------------------------------------------------------- node helpers
  const gainN = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const filt = (type, f, Q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (Q != null) b.Q.value = Q; return b; };
  const panN = (p) => { if (!ctx.createStereoPanner) return gainN(1); const n = ctx.createStereoPanner(); n.pan.value = clamp(p, -1, 1); return n; };
  const oscN = (type, f) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; return o; };
  const loopN = (buf, rate = 1) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; return s; };
  /** move a param smoothly toward v (skipped when it is already headed there: the timer calls this 4 times a second) */
  function setp(param, v, tc) {
    const last = param._sv;
    if (last !== undefined && Math.abs(v - last) <= 1e-5 + Math.abs(last) * 0.015) return;
    param._sv = v;
    param.setTargetAtTime(v, ctx.currentTime, tc);
  }

  // ---------------------------------------------------------------- generated buffers
  const bufs = {};
  /**
   * A looping AudioBuffer filled by fill(data, rate) — n + a little more samples, folded into a seamless loop. Made at
   * 24 kHz (these are noises and textures: nothing above 12 kHz is missed, and it is half the work); a second channel
   * is the first one half a loop later (as good as independent for noise, and no second fill).
   */
  function texture(seconds, channels, fill, { rate = 24000, rms = 0.2, peak = 1.6 } = {}) {
    const n = Math.round(seconds * rate), xf = Math.round(0.06 * rate);
    const b = ctx.createBuffer(channels, n, rate), tmp = new Float32Array(n + xf);
    fill(tmp, rate);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = tmp[i];
    // the loop's end runs on into its start: an equal-power crossfade of the extra samples into the first ones
    for (let i = 0; i < xf; i++) { const a = i / xf; d[i] = tmp[i] * Math.sqrt(a) + tmp[n + i] * Math.sqrt(1 - a); }
    if (rms) {
      let s = 0, pk = 0;
      for (let i = 0; i < n; i++) { s += d[i] * d[i]; const a = Math.abs(d[i]); if (a > pk) pk = a; }
      const k = Math.min(rms / (Math.sqrt(s / n) || 1), peak / (pk || 1));
      for (let i = 0; i < n; i++) d[i] *= k;
    }
    if (channels > 1) { const r = b.getChannelData(1), h = n >> 1; r.set(d.subarray(h)); r.set(d.subarray(0, h), n - h); }
    return b;
  }
  const FILLS = {
    white(d) { for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; },
    pink(d) {   // Paul Kellet's filter
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
      }
    },
    brown(d) { let y = 0; for (let i = 0; i < d.length; i++) { y = (y + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = y; } },
    // raindrops: short ticks and splashes, scattered
    patter(d, rate) {
      const n = Math.round((d.length / rate) * 260);
      for (let k = 0; k < n; k++) {
        const at = Math.floor(Math.random() * (d.length - rate * 0.02)), a = 0.15 + 0.85 * Math.random() ** 3;
        const L = rate * rnd(0.0015, 0.006), f = rnd(1800, 6500) / rate * Math.PI * 2, ph = Math.random() * 6;
        const k = Math.exp(-1 / L), cr = Math.cos(f), sr = Math.sin(f);
        let e = a, c = Math.cos(ph), sn = Math.sin(ph);
        for (let i = 0; i < L * 4; i++) { d[at + i] += e * (0.6 * (Math.random() * 2 - 1) + 0.5 * sn); e *= k; const c2 = c * cr - sn * sr; sn = sn * cr + c * sr; c = c2; }
      }
    },
    // dry leaves: crackles in bursts that come and go
    rustle(d, rate) {
      const T = d.length / rate, w1 = rnd(0.3, 0.6), w2 = rnd(0.7, 1.3), p1 = Math.random() * 6, p2 = Math.random() * 6;
      let t = 0;
      while (t < T) {
        const dens = Math.max(0, 0.55 * Math.sin(p1 + t * w1 * 6.283) + 0.45 * Math.sin(p2 + t * w2 * 6.283) + 0.15);
        t += 1 / (30 + 900 * dens * dens) * rnd(0.4, 1.6);
        const at = Math.floor(t * rate), a = (0.2 + 0.8 * Math.random() ** 2) * (0.3 + dens), L = rate * rnd(0.0004, 0.003);
        const k = Math.exp(-1 / L);
        let e = a;
        for (let i = 0; i < L * 4 && at + i < d.length; i++) { d[at + i] += e * (Math.random() * 2 - 1); e *= k; }
      }
    },
    // a crowd's syllables (a control signal 0..1): talkers that speak in bursts and pause
    babble(d, rate) {
      const T = d.length / rate;
      for (let k = 0; k < 14; k++) {
        let t = Math.random() * 0.5;
        while (t < T) {
          const words = 2 + Math.floor(Math.random() * 6);
          for (let w = 0; w < words && t < T; w++) {
            const L = rnd(0.07, 0.2), a = rnd(0.4, 1), at = Math.floor(t * rate), m = Math.floor(L * rate);
            for (let i = 0; i < m && at + i < d.length; i++) { const u = i / m, b = 4 * u * (1 - u); d[at + i] += a * b * b; }
            t += L + rnd(0.02, 0.09);
          }
          t += rnd(0.2, 1.1);
        }
      }
      let mx = 0; for (let i = 0; i < d.length; i++) mx = Math.max(mx, d[i]);
      for (let i = 0; i < d.length; i++) d[i] /= mx || 1;
    },
    // a field cricket's song at 2 chirps a second: each chirp 3–5 pulses of trill (a control signal 0..1)
    cricket(d, rate) {
      const T = d.length / rate;
      for (let t = rnd(0, 0.2); t < T; t += 0.5 * rnd(0.93, 1.07)) {
        const pulses = 3 + Math.floor(Math.random() * 3), a = rnd(0.75, 1);
        for (let p = 0; p < pulses; p++) {
          const at = Math.floor((t + p / 32) * rate), m = Math.floor(rate * 0.019);
          for (let i = 0; i < m && at + i < d.length; i++) { const u = i / m, b = 4 * u * (1 - u); d[at + i] = a * b * b; }
        }
      }
    },
  };
  function buf(name) {
    if (bufs[name]) return bufs[name];
    const CTRL = { rms: 0, rate: 8000 };     // control signals: slow, so a low rate
    const spec = {
      white: [3, 2, {}], pink: [4, 2, {}], brown: [4, 2, {}], patter: [3, 2, { peak: 2.2 }], rustle: [4, 2, { peak: 2.2 }],
      babble: [6, 1, CTRL], cricket: [4, 1, CTRL],
    }[name];
    return (bufs[name] = texture(spec[0], spec[1], FILLS[name], spec[2]));
  }
  function impulse(sec) {
    const sr = ctx.sampleRate, n = Math.round(sec * sr), b = ctx.createBuffer(2, n, sr), pre = Math.round(0.014 * sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      const k = Math.exp(-1 / (0.2 * sr)), m = n - pre;
      let y = 0, e = 1;
      for (let i = pre; i < n; i++) {
        const a = 0.8 - 0.72 * (i - pre) / m;   // the tail darkens as it dies
        y += a * ((Math.random() * 2 - 1) - y);
        d[i] = y * e; e *= k;
      }
    }
    return b;
  }

  // ---------------------------------------------------------------- the graph
  // master → limiter → out → speakers. Into the master: the ambience buses, the cue bus, the reverb's return.
  const BUSES = ["wind", "leaves", "rain", "thunder", "traffic", "cars", "crowd", "water", "crickets", "steam", "birds", "critters", "cues"];
  function build() {
    const t0 = performance.now();
    G = { bus: {}, beds: {} };
    G.out = gainN(OUT_GAIN);
    G.limiter = ctx.createDynamicsCompressor();
    const L = G.limiter;
    L.threshold.value = -10; L.knee.value = 6; L.ratio.value = 12; L.attack.value = 0.004; L.release.value = 0.3;
    G.master = gainN(0);
    G.master.connect(L); L.connect(G.out); G.out.connect(ctx.destination);
    G.verb = ctx.createConvolver();      // its impulse comes a moment later (below); fed in mono: half the convolving
    G.verb.channelCount = 1; G.verb.channelCountMode = "explicit";
    G.verbRet = gainN(0.3);
    G.verb.connect(G.verbRet); G.verbRet.connect(G.master);
    const SENDS = { birds: 0.55, critters: 0.35, cues: 0.25, thunder: 0.5, crowd: 0.12 };
    for (const name of BUSES) {
      const g = gainN(1);
      if (name === "birds") { G.birdTop = filt("lowpass", 7000, 0.4); g.connect(G.birdTop); G.birdTop.connect(G.master); }   // tame the brightest whistles
      else g.connect(G.master);
      if (SENDS[name]) { const s = gainN(SENDS[name]); g.connect(s); s.connect(G.verb); }
      G.bus[name] = g;
    }
    // birds near (bright) and far (dull, more reverb)
    G.birdNear = gainN(1); G.birdNear.connect(G.bus.birds);
    G.birdFar = gainN(0.6); G.birdFarLp = filt("lowpass", 2600, 0.5);
    G.birdFar.connect(G.birdFarLp); G.birdFarLp.connect(G.bus.birds);
    { const s = gainN(0.5); G.birdFarLp.connect(s); s.connect(G.verb); }
    for (const [name, b] of Object.entries(BEDS)) G.beds[name] = bed(name, G.bus[b.bus], b.build);
    for (const n of ["white", "pink", "brown"]) buf(n);
    perf.buildMs = performance.now() - t0;
    // the map's features near the view, and the textures most likely needed next, when the page has a moment
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 300));
    idle(() => {
      if (!G.verb.buffer) G.verb.buffer = impulse(0.7);
      const t1 = performance.now();
      try { grids = buildGrids(); } catch (e) { console.warn("[sound] no map features:", e); grids = null; }
      perf.gridMs = performance.now() - t1;
      L.R = 0;
      idle(() => { buf("rustle"); buf("patter"); }, { timeout: 3000 });
    }, { timeout: 1500 });
  }

  // A bed: a continuous sound (its sources built when it is first heard, taken down after a while silent).
  function bed(name, dest, buildFn) {
    const B = { name, out: gainN(0), live: null, quietAt: 0, level: 0 };
    B.out.connect(dest);
    B.set = (lv, tc = 0.8) => {
      const t = ctx.currentTime;
      if (lv > BED_MIN) { if (!B.live) { B.live = buildFn(B.out); live.nodes += B.live.nodes.length; } B.quietAt = 0; }
      else if (B.live) {
        if (!B.quietAt) B.quietAt = t;
        else if (t - B.quietAt > 6) {
          for (const s of B.live.srcs) { try { s.stop(); } catch { /* not started */ } }
          for (const n of B.live.nodes) n.disconnect();
          live.nodes -= B.live.nodes.length;
          B.live = null;
        }
      }
      if (lv <= BED_MIN) lv = 0;
      B.level = lv;
      setp(B.out.gain, lv, tc);
    };
    return B;
  }
  /** start a looped source somewhere in its buffer */
  const startLoop = (s) => { s.start(ctx.currentTime, Math.random() * s.buffer.duration); return s; };
  const lfo = (f, depth, param) => { const o = oscN("sine", f), g = gainN(depth); o.connect(g); g.connect(param); o.start(ctx.currentTime + Math.random() * 0.5); return [o, g]; };

  const BEDS = {
    // wind: pink noise through a low-pass that opens in gusts; at high speed, a breathy whistle above it
    wind: { bus: "wind", build(out) {
      const src = startLoop(loopN(buf("pink"), 0.97)), lp = filt("lowpass", 500, 0.5), gust = gainN(1);
      const hi = startLoop(loopN(buf("white"), 1.01)), bp = filt("bandpass", 1500, 0.9), hg = gainN(0);
      src.connect(lp); lp.connect(gust); hi.connect(bp); bp.connect(hg); hg.connect(gust); gust.connect(out);
      return { srcs: [src, hi], nodes: [src, lp, gust, hi, bp, hg], lp, gust, hg, bp };
    } },
    // leaves stirring: crackly rustle through a high-pass, swelling with the gusts
    leaves: { bus: "leaves", build(out) {
      const src = startLoop(loopN(buf("rustle"), rnd(0.95, 1.05))), hp = filt("highpass", 1700, 0.6), gust = gainN(1);
      src.connect(hp); hp.connect(gust); gust.connect(out);
      return { srcs: [src], nodes: [src, hp, gust], gust };
    } },
    // rain: a high hiss, a soft body, and close up the patter of drops
    rain: { bus: "rain", build(out) {
      const w = startLoop(loopN(buf("white"), 0.93)), hp = filt("highpass", 1400, 0.5), lp = filt("lowpass", 7500, 0.5), hiss = gainN(0.55);
      const p = startLoop(loopN(buf("pink"), 1.06)), bp = filt("bandpass", 700, 0.45), body = gainN(0.6);
      const pt = startLoop(loopN(buf("patter"), 1)), php = filt("highpass", 900, 0.5), patter = gainN(0.3);
      w.connect(hp); hp.connect(lp); lp.connect(hiss); hiss.connect(out);
      p.connect(bp); bp.connect(body); body.connect(out);
      pt.connect(php); php.connect(patter); patter.connect(out);
      return { srcs: [w, p, pt], nodes: [w, hp, lp, hiss, p, bp, body, pt, php, patter], hiss, body, patter };
    } },
    // traffic: a low hum, the tyres' roar above it, a wet hiss on wet roads
    traffic: { bus: "traffic", build(out) {
      const b = startLoop(loopN(buf("brown"), 1)), lp = filt("lowpass", 230, 0.6), hum = gainN(1);
      const p = startLoop(loopN(buf("pink"), 0.9)), bp = filt("bandpass", 850, 0.5), roar = gainN(0.3);
      const w = startLoop(loopN(buf("white"), 1.03)), wbp = filt("bandpass", 3200, 0.7), wet = gainN(0);
      b.connect(lp); lp.connect(hum); hum.connect(out);
      p.connect(bp); bp.connect(roar); roar.connect(out);
      w.connect(wbp); wbp.connect(wet); wet.connect(out);
      return { srcs: [b, p, w], nodes: [b, lp, hum, p, bp, roar, w, wbp, wet], roar, wet };
    } },
    // the crowd: a roar (two broad bands that surge) and a murmur of voices (noise gated by babbling syllables)
    crowd: { bus: "crowd", build(out) {
      const p = startLoop(loopN(buf("pink"), 1.04)), b1 = filt("bandpass", 650, 0.7), b2 = filt("bandpass", 1600, 1), b2g = gainN(0.55);
      const roar = gainN(0), surge = gainN(1), swell = gainN(1);
      p.connect(b1); p.connect(b2); b2.connect(b2g); b1.connect(roar); b2g.connect(roar); roar.connect(surge); surge.connect(swell); swell.connect(out);
      const m = startLoop(loopN(buf("pink"), 0.96)), f1 = filt("bandpass", 520, 1.6), f2 = filt("bandpass", 1450, 2.2), f2g = gainN(0.6);
      const vca = gainN(0), ctl = startLoop(loopN(buf("babble"), 1)), ctlG = gainN(1), murmur = gainN(0);
      m.connect(f1); m.connect(f2); f2.connect(f2g); f1.connect(vca); f2g.connect(vca); ctl.connect(ctlG); ctlG.connect(vca.gain);
      vca.connect(murmur); murmur.connect(out);
      return { srcs: [p, m, ctl], nodes: [p, b1, b2, b2g, roar, surge, swell, m, f1, f2, f2g, vca, ctl, ctlG, murmur], roar, surge, swell, murmur };
    } },
    // an arena's crowd, through its walls
    arena: { bus: "crowd", build(out) {
      const p = startLoop(loopN(buf("pink"), 1.1)), lp = filt("lowpass", 380, 0.6), surge = gainN(1);
      p.connect(lp); lp.connect(surge); surge.connect(out);
      return { srcs: [p], nodes: [p, lp, surge], surge };
    } },
    // water lapping: two bands of noise, each swelling and ebbing at its own slow pace, and a brighter trickle
    water: { bus: "water", build(out) {
      const p = startLoop(loopN(buf("pink"), 0.92)), w = startLoop(loopN(buf("white"), 0.97));
      const b1 = filt("bandpass", 380, 1.1), v1 = gainN(0.5), b2 = filt("bandpass", 950, 1.6), v2 = gainN(0.35);
      const b3 = filt("bandpass", 2600, 2.2), v3 = gainN(0.06);
      p.connect(b1); b1.connect(v1); v1.connect(out);
      p.connect(b2); b2.connect(v2); v2.connect(out);
      w.connect(b3); b3.connect(v3); v3.connect(out);
      const l1 = lfo(rnd(0.15, 0.2), 0.45, v1.gain), l2 = lfo(rnd(0.27, 0.33), 0.3, v2.gain), l3 = lfo(rnd(0.6, 0.8), 0.05, v3.gain);
      const l4 = lfo(rnd(0.09, 0.12), 120, b2.frequency);
      return { srcs: [p, w, l1[0], l2[0], l3[0], l4[0]], nodes: [p, w, b1, v1, b2, v2, b3, v3, ...l1, ...l2, ...l3, ...l4] };
    } },
    // crickets: a few singers, each a tone gated by its chirp pattern (played faster when it is warmer)
    crickets: { bus: "crickets", build(out) {
      const srcs = [], nodes = [], ctls = [];
      for (let k = 0; k < 4; k++) {
        const o = oscN("sine", rnd(3300, 4700)), vca = gainN(0), ctl = loopN(buf("cricket"), 1), cg = gainN(k < 2 ? 1 : 0.45), pn = panN(rnd(-0.8, 0.8));
        o.connect(vca); ctl.connect(cg); cg.connect(vca.gain); vca.connect(pn); pn.connect(out);
        o.start(); startLoop(ctl);
        srcs.push(o, ctl); nodes.push(o, vca, ctl, cg, pn); ctls.push(ctl);
      }
      return { srcs, nodes, ctls };
    } },
    // steam from vents and stacks: a faint, soft hiss
    steam: { bus: "steam", build(out) {
      const w = startLoop(loopN(buf("white"), 0.9)), bp = filt("bandpass", 4200, 0.7), lp = filt("lowpass", 6500, 0.5);
      w.connect(bp); bp.connect(lp); lp.connect(out);
      return { srcs: [w], nodes: [w, bp, lp] };
    } },
  };

  // ---------------------------------------------------------------- voices (cues, birds, thunder, passing cars)
  class Voice {
    constructor(kind, dest, pan, t0) {
      this.kind = kind; this.t0 = t0; this.end = t0; this.nodes = []; this.srcs = [];
      this.out = this.add(gainN(1));
      this.pan = this.add(panN(pan));
      this.out.connect(this.pan); this.pan.connect(dest);
    }
    add(n) { this.nodes.push(n); return n; }
    gain(v) { return this.add(gainN(v)); }
    filt(type, f, Q) { return this.add(filt(type, f, Q)); }
    osc(type, f, at = this.t0) { const o = this.add(oscN(type, f)); this.srcs.push([o, at, 0]); return o; }
    noise(name, at = this.t0, rate = 1) { const s = this.add(loopN(buf(name), rate)); this.srcs.push([s, at, Math.random() * s.buffer.duration]); return s; }
    play() {
      if (!this.srcs.length) { for (const n of this.nodes) n.disconnect(); return false; }
      const end = this.end + 0.05;
      for (const [s, at, off] of this.srcs) { s.start(at, off); s.stop(end); }
      live[this.kind]++; live.nodes += this.nodes.length; live.made++;
      this.srcs[0][0].onended = () => {
        for (const n of this.nodes) n.disconnect();
        live[this.kind]--; live.nodes -= this.nodes.length;
      };
      return true;
    }
  }
  const voice = (kind, dest, pan, t0) => (live[kind] >= MAX_VOICES[kind] ? null : new Voice(kind, dest, pan, t0));
  // an envelope blip on a gain param: rise in a, hold h, fall with time constant r
  function blip(p, t, a, h, r, peak) {
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + a);
    if (h > 0) p.setValueAtTime(peak, t + a + h);
    p.setTargetAtTime(0, t + a + h, r);
  }

  // A bird's phrase, on one oscillator: note(f0, f1, dur, amp) glides f0 → f1.
  function birdSong(v, kind, k) {
    const o = v.osc("sine", 3000), g = v.gain(0), F = o.frequency, A = g.gain;
    o.connect(g); g.connect(v.out);
    let t = v.t0 + 0.01;
    const note = (f0, f1, dur, amp = 1, att = 0.012) => {
      F.setValueAtTime(f0, t); F.exponentialRampToValueAtTime(f1, t + dur);
      A.setValueAtTime(0, t); A.linearRampToValueAtTime(amp * k, t + Math.min(att, dur * 0.3));
      A.setValueAtTime(amp * k, t + dur * 0.7); A.linearRampToValueAtTime(0, t + dur);
      t += dur;
    };
    const warble = (f, dur, amp = 1) => {     // up and down within one note
      F.setValueAtTime(f, t); F.linearRampToValueAtTime(f * rnd(1.15, 1.3), t + dur * 0.35); F.linearRampToValueAtTime(f * rnd(0.85, 0.95), t + dur);
      A.setValueAtTime(0, t); A.linearRampToValueAtTime(amp * k, t + 0.015); A.setValueAtTime(amp * k, t + dur * 0.75); A.linearRampToValueAtTime(0, t + dur);
      t += dur;
    };
    const gap = (d) => { t += d; };
    const p = rnd(0.94, 1.06);   // each bird its own pitch
    switch (kind) {
      case "chickadee":        // "fee-bee" (sometimes "fee-bee-ee")
        note(4050 * p, 3950 * p, 0.27, 0.9, 0.04); gap(0.05); note(3450 * p, 3380 * p, 0.28, 0.75, 0.03);
        if (Math.random() < 0.3) { gap(0.03); note(3420 * p, 3360 * p, 0.16, 0.6, 0.02); }
        break;
      case "cardinal": {       // "cheer cheer cheer" down-slurs, or "birdie birdie" up-slurs
        const up = Math.random() < 0.35, n = 3 + Math.floor(Math.random() * 4);
        for (let i = 0; i < n; i++) { if (up) note(2100 * p, 3700 * p, 0.12, 0.8); else note(4300 * p, 1900 * p, 0.17, 0.85, 0.01); gap(up ? 0.08 : 0.07); }
        break;
      }
      case "robin": {          // caroling: phrases of warbled notes
        const n = 3 + Math.floor(Math.random() * 4);
        for (let i = 0; i < n; i++) { warble(rnd(2000, 2900) * p, rnd(0.13, 0.21), rnd(0.6, 1)); gap(rnd(0.05, 0.12)); }
        break;
      }
      case "sparrow": {        // a few clear notes, then a trill
        for (let i = 0; i < 2 + (Math.random() < 0.5); i++) { note(2900 * p, 3100 * p, 0.1, 0.8); gap(0.11); }
        const f = rnd(3800, 4600) * p, n = 7 + Math.floor(Math.random() * 6);
        for (let i = 0; i < n; i++) { note(f * (1 - i * 0.012), f * 0.82 * (1 - i * 0.012), 0.04, 0.65, 0.005); gap(0.018); }
        note(2600 * p, 2300 * p, 0.12, 0.5);
        break;
      }
      case "junco": {          // an even, musical trill
        const f = rnd(4200, 5000) * p, n = 10 + Math.floor(Math.random() * 8);
        for (let i = 0; i < n; i++) { note(f, f * 0.86, 0.045, 0.7, 0.005); gap(0.016); }
        break;
      }
      case "finch": {          // a jumbled warble
        const n = 7 + Math.floor(Math.random() * 6);
        for (let i = 0; i < n; i++) { const f = rnd(2600, 4800) * p; note(f, f * rnd(0.8, 1.25), rnd(0.05, 0.08), rnd(0.5, 0.9), 0.006); }
        break;
      }
      case "chip":             // a single call note or two
        note(5200 * p, 3900 * p, 0.03, 0.7, 0.004);
        if (Math.random() < 0.4) { gap(rnd(0.25, 0.5)); note(5200 * p, 3900 * p, 0.03, 0.6, 0.004); }
        break;
      case "owl":              // a great horned owl, far off: hoo h'hoo — hoo — hoo
        note(390 * p, 370 * p, 0.32, 0.8, 0.06); gap(0.12); note(410 * p, 395 * p, 0.1, 0.6, 0.03); note(420 * p, 385 * p, 0.3, 0.9, 0.04);
        gap(0.35); note(385 * p, 360 * p, 0.3, 0.75, 0.05); gap(0.3); note(380 * p, 350 * p, 0.42, 0.7, 0.06);
        break;
      default:                 // "chirp": the cue — a bright chip-chirrup
        note(3100 * p, 4700 * p, 0.055, 0.9, 0.006); gap(0.035); note(3500 * p, 5300 * p, 0.075, 1, 0.006);
        if (Math.random() < 0.5) { gap(0.03); note(4800 * p, 3600 * p, 0.05, 0.6, 0.005); }
    }
    v.end = t + 0.02;
  }

  const snowy = () => (app.tileStyle && app.tileStyle.snow > 0.25) || num(app.weather && app.weather.snowDepthM, 0) > 0.01;

  // The cues: short, soft sounds. k is the loudness (1 ≈ a peak of −20 dBFS before the master).
  const CUES = {
    squirrel(v, k) {          // a chitter: quick "chuk"s
      const tri = v.osc("triangle", 1500), nz = v.noise("white"), nzG = v.gain(0.3), env = v.gain(0), bp = v.filt("bandpass", 1900, 1.4);
      tri.connect(env); nz.connect(nzG); nzG.connect(env); env.connect(bp); bp.connect(v.out);
      const n = 5 + Math.floor(Math.random() * 5), rate = rnd(12, 16), p = rnd(0.9, 1.1);
      let t = v.t0;
      for (let i = 0; i < n; i++) {
        const f = rnd(1450, 1850) * p * (1 - i * 0.015);
        tri.frequency.setValueAtTime(f, t); tri.frequency.exponentialRampToValueAtTime(f * 0.62, t + 0.035);
        blip(env.gain, t, 0.004, 0.006, 0.012, k * (i ? rnd(0.55, 1) : 1));
        t += rnd(0.85, 1.15) / rate;
      }
      v.end = t + 0.08;
    },
    quack(v, k) {             // a duck: a nasal, buzzy "quack", once to three times
      const saw = v.osc("sawtooth", 320), f1 = v.filt("bandpass", 1050, 3.2), f2 = v.filt("bandpass", 2300, 5), f2g = v.gain(0.6);
      const env = v.gain(0), am = v.osc("sine", rnd(42, 55)), amG = v.gain(0.25), amV = v.gain(0.75), lp = v.filt("lowpass", 3000, 0.6);
      saw.connect(f1); saw.connect(f2); f2.connect(f2g); f1.connect(env); f2g.connect(env); env.connect(amV); amV.connect(lp); lp.connect(v.out);
      am.connect(amG); amG.connect(amV.gain);
      const n = 1 + (Math.random() < 0.55) + (Math.random() < 0.2), p = rnd(0.9, 1.12), F = saw.frequency;
      let t = v.t0;
      for (let i = 0; i < n; i++) {
        const d = rnd(0.15, 0.21), fb = rnd(300, 350) * p;
        F.setValueAtTime(fb * 0.9, t); F.linearRampToValueAtTime(fb * 1.08, t + d * 0.3); F.linearRampToValueAtTime(fb * 0.82, t + d);
        blip(env.gain, t, 0.02, d * 0.55, 0.03, k * (i ? 0.85 : 1));
        t += d + rnd(0.09, 0.16);
      }
      v.end = t + 0.1;
    },
    honk(v, k) {              // a goose: "a-HONK", once or twice
      const saw = v.osc("sawtooth", 300), f1 = v.filt("bandpass", 820, 2.6), f2 = v.filt("bandpass", 1650, 4), f2g = v.gain(0.55);
      const env = v.gain(0), lp = v.filt("lowpass", 2400, 0.6), vib = v.osc("sine", 7), vibG = v.gain(6);
      saw.connect(f1); saw.connect(f2); f2.connect(f2g); f1.connect(env); f2g.connect(env); env.connect(lp); lp.connect(v.out);
      vib.connect(vibG); vibG.connect(saw.frequency);
      const n = 1 + (Math.random() < 0.45), p = rnd(0.92, 1.08), F = saw.frequency;
      let t = v.t0;
      for (let i = 0; i < n; i++) {
        F.setValueAtTime(270 * p, t); F.linearRampToValueAtTime(300 * p, t + 0.05); F.setValueAtTime(430 * p, t + 0.07);
        F.linearRampToValueAtTime(370 * p, t + 0.3);
        blip(env.gain, t, 0.025, 0.2, 0.035, k);
        t += 0.32 + rnd(0.12, 0.25);
      }
      v.end = t + 0.1;
    },
    bark(v, k) {              // a small dog: a yip or two
      const saw = v.osc("sawtooth", 560), fm = v.filt("bandpass", 1300, 1.3), nz = v.noise("white"), nbp = v.filt("bandpass", 1700, 0.8), ng = v.gain(0.5);
      const env = v.gain(0), lp = v.filt("lowpass", 2800, 0.6);
      saw.connect(fm); fm.connect(env); nz.connect(nbp); nbp.connect(ng); ng.connect(env); env.connect(lp); lp.connect(v.out);
      const n = 1 + (Math.random() < 0.6) + (Math.random() < 0.2), p = rnd(0.88, 1.15), F = saw.frequency;
      let t = v.t0;
      for (let i = 0; i < n; i++) {
        F.setValueAtTime(500 * p, t); F.linearRampToValueAtTime(820 * p, t + 0.022); F.exponentialRampToValueAtTime(420 * p, t + 0.12);
        blip(env.gain, t, 0.006, 0.03, 0.035, k * (i ? 0.85 : 1));
        t += rnd(0.17, 0.26);
      }
      v.end = t + 0.12;
    },
    chirp(v, k) { birdSong(v, "chirp", k); },
    flock(v, k) {             // a flock taking off: wingbeats, two layers out of step, sweeping past
      const nz = v.noise("pink"), b1 = v.filt("bandpass", 650, 0.8), b2 = v.filt("bandpass", 1100, 0.9), e1 = v.gain(0), e2 = v.gain(0), lp = v.filt("lowpass", 2200, 0.5);
      nz.connect(b1); nz.connect(b2); b1.connect(e1); b2.connect(e2); e1.connect(lp); e2.connect(lp); lp.connect(v.out);
      const n = 16 + Math.floor(Math.random() * 10), dur = n / 13;
      for (const [e, r0, off] of [[e1.gain, rnd(11, 13), 0], [e2.gain, rnd(13, 16), 0.04]]) {
        let t = v.t0 + off;
        for (let i = 0; i < n; i++) {
          const a = k * smooth(-1, 4, i) * (1 - smooth(n * 0.4, n, i) * 0.9) * rnd(0.7, 1);
          blip(e, t, 0.012, 0.004, 0.02, a);
          t += (1 / r0) * rnd(0.85, 1.15) * (1 - 0.15 * i / n);
        }
      }
      if (v.pan.pan) { const p0 = v.pan.pan.value; v.pan.pan.setValueAtTime(clamp(p0 - 0.35, -1, 1), v.t0); v.pan.pan.linearRampToValueAtTime(clamp(p0 + 0.35, -1, 1), v.t0 + dur); }
      v.end = v.t0 + dur + 0.15;
    },
    rustle(v, k) {            // leaves: a crackly swell
      const nz = v.noise("rustle", v.t0, rnd(0.9, 1.15)), hp = v.filt("highpass", 1800, 0.6), env = v.gain(0);
      nz.connect(hp); hp.connect(env); env.connect(v.out);
      const d = rnd(0.35, 0.6), E = env.gain, t = v.t0;
      E.setValueAtTime(0, t); E.linearRampToValueAtTime(k, t + 0.06);
      for (let x = 0.1; x < d; x += 0.05) E.linearRampToValueAtTime(k * rnd(0.45, 1), t + x);
      E.setTargetAtTime(0, t + d, 0.06);
      v.end = t + d + 0.3;
    },
    crunch(v, k) {            // a step in dry leaves, or in snow
      const snow = snowy(), nz = v.noise(snow ? "white" : "rustle", v.t0, snow ? 1 : 1.3);
      const bp = v.filt("bandpass", snow ? 1150 : 2600, snow ? 1.3 : 0.6), env = v.gain(0);
      nz.connect(bp); bp.connect(env); env.connect(v.out);
      const steps = 1 + (Math.random() < 0.5);
      let t = v.t0;
      for (let s = 0; s < steps; s++) {
        const d = rnd(0.11, 0.17), E = env.gain;
        E.setValueAtTime(0, t);
        // a crunch is many small cracks: a jagged envelope
        for (let x = 0; x < d; x += 0.012) E.linearRampToValueAtTime(k * (snow ? 0.8 : 1) * rnd(0.35, 1) * (1 - 0.5 * x / d), t + x + 0.006);
        E.setTargetAtTime(0, t + d, 0.02);
        t += d + rnd(0.28, 0.4);
      }
      v.end = t;
    },
    snowball(v, k) {          // a soft thump and a puff of powder
      const o = v.osc("sine", 140), og = v.gain(0), nz = v.noise("pink"), lp = v.filt("lowpass", 900, 0.6), ng = v.gain(0);
      const w = v.noise("white"), hp = v.filt("bandpass", 3200, 0.8), wg = v.gain(0);
      o.connect(og); og.connect(v.out); nz.connect(lp); lp.connect(ng); ng.connect(v.out); w.connect(hp); hp.connect(wg); wg.connect(v.out);
      const t = v.t0;
      o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(55, t + 0.12);
      blip(og.gain, t, 0.003, 0.01, 0.04, k);
      blip(ng.gain, t, 0.004, 0.02, 0.05, k * 0.8);
      blip(wg.gain, t + 0.01, 0.01, 0.02, 0.04, k * 0.15);
      v.end = t + 0.4;
    },
    hiss(v, k) {              // a breath of steam
      const nz = v.noise("white"), bp = v.filt("bandpass", 4200, 0.7), lp = v.filt("lowpass", 7000, 0.5), env = v.gain(0);
      nz.connect(bp); bp.connect(lp); lp.connect(env); env.connect(v.out);
      const d = rnd(0.25, 0.45);
      blip(env.gain, v.t0, 0.06, d, 0.12, k);
      v.end = v.t0 + 0.06 + d + 0.6;
    },
    pop(v, k) {               // a soft "bloop"
      const o = v.osc("sine", 900), og = v.gain(0), w = v.noise("white"), hp = v.filt("highpass", 2500, 0.7), wg = v.gain(0);
      o.connect(og); og.connect(v.out); w.connect(hp); hp.connect(wg); wg.connect(v.out);
      const t = v.t0, p = rnd(0.85, 1.2);
      o.frequency.setValueAtTime(950 * p, t); o.frequency.exponentialRampToValueAtTime(230 * p, t + 0.05);
      blip(og.gain, t, 0.002, 0.005, 0.03, k);
      blip(wg.gain, t, 0.001, 0.002, 0.004, k * 0.2);
      v.end = t + 0.25;
    },
  };

  // A user cue: panned by where it is on screen, quieter off screen and when repeated in a burst.
  const lastCue = {}, recent = [];
  function cue(name, pos) {
    if (!wanted || !ctx || ctx.state !== "running" || !G || document.hidden) return false;
    const fn = CUES[name];
    if (!fn) return false;
    const now = ctx.currentTime;
    if (now - (lastCue[name] || -1) < 0.07) return false;
    let pan = rnd(-0.15, 0.15), g = 1;
    const v = app.view;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      const [px, py] = v.groundToScreen(pos.x, pos.y, num(pos.z, 0));
      pan = clamp((px - v.w / 2) / (v.w / 2), -1, 1) * 0.75;
      const off = Math.max(0, -px, px - v.w, -py, py - v.h);
      g = 1 / (1 + (off / (0.25 * Math.max(300, v.w))) ** 2);
    }
    while (recent.length && now - recent[0] > 1.5) recent.shift();
    g /= 1 + 0.12 * recent.length;
    if (g < 0.02) return false;
    const vo = voice("cue", G.bus.cues, pan, now + 0.005);
    if (!vo) return false;
    lastCue[name] = now; recent.push(now);
    fn(vo, CUE_GAIN[name] * g * 0.1 * rnd(0.85, 1.05));
    return vo.play();
  }
  // a creature in the scene (app.whimsy says it is on screen): quieter, somewhere about
  function critter(name, t, g = 1) {
    const vo = voice("critter", G.bus.critters, rnd(-0.75, 0.75), t);
    if (!vo) return;
    CUES[name](vo, CUE_GAIN[name] * 0.1 * g * rnd(0.4, 0.75));
    vo.play();
  }
  function bird(t, kind, near, close) {
    const vo = voice("bird", near ? G.birdNear : G.birdFar, near ? rnd(-0.7, 0.7) : rnd(-0.95, 0.95), t);
    if (!vo) return;
    birdSong(vo, kind, (kind === "owl" ? 0.14 : 0.125) * rnd(0.35, 1) ** 1.5 * (near ? 1 : 0.6) * lerp(0.6, 1, close));
    vo.play();
  }
  // thunder: (close: a crack, then) a long rumble that rolls and dies away
  function thunder(t, near) {
    const vo = voice("fx", G.bus.thunder, rnd(-0.6, 0.6), t);
    if (!vo) return;
    const nz = vo.noise("brown"), lp = vo.filt("lowpass", 900, 0.5), env = vo.gain(0);
    nz.connect(lp); lp.connect(env); env.connect(vo.out);
    const dur = rnd(3.5, 7), E = env.gain, k = 1.6 * lerp(0.4, 1, near);
    lp.frequency.setValueAtTime(near > 0.6 ? 1400 : 600, t); lp.frequency.setTargetAtTime(170, t + 0.15, dur / 4);
    E.setValueAtTime(0, t); E.linearRampToValueAtTime(k * (near > 0.6 ? 1 : 0.6), t + (near > 0.6 ? 0.04 : rnd(0.4, 1)));
    for (let x = 0.3; x < dur; x += rnd(0.25, 0.6)) E.setTargetAtTime(k * rnd(0.3, 1) * Math.exp(-x / (dur * 0.45)), t + x, 0.12);
    E.setTargetAtTime(0, t + dur, 0.5);
    if (near > 0.6) {
      const w = vo.noise("white"), hp = vo.filt("highpass", 1200, 0.5), cg = vo.gain(0);
      w.connect(hp); hp.connect(cg); cg.connect(vo.out);
      blip(cg.gain, t, 0.003, 0.03, 0.08, k * 0.35 * near);
    }
    vo.end = t + dur + 2.5;
    vo.play();
  }
  // a car going by: tyre noise that rises and falls, its pitch dropping as it passes, across the stereo
  function passBy(t, k, wet) {
    const dir = Math.random() < 0.5 ? -1 : 1;
    const vo = voice("fx", G.bus.cars, -0.7 * dir, t);
    if (!vo) return;
    const nz = vo.noise("pink"), bp = vo.filt("bandpass", 700, 0.7), env = vo.gain(0);
    nz.connect(bp); bp.connect(env); env.connect(vo.out);
    const up = rnd(1.1, 2), down = rnd(1.2, 2.2), mid = t + up;
    bp.frequency.setValueAtTime(600, t); bp.frequency.linearRampToValueAtTime(950, mid); bp.frequency.linearRampToValueAtTime(480, mid + down);
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(k * 0.25, t + up * 0.6); env.gain.linearRampToValueAtTime(k, mid);
    env.gain.setTargetAtTime(0, mid, down / 3);
    if (wet > 0.05) {
      const w = vo.noise("white"), wb = vo.filt("bandpass", 3500, 0.8), wg = vo.gain(0);
      w.connect(wb); wb.connect(wg); wg.connect(vo.out);
      wg.gain.setValueAtTime(0, t); wg.gain.linearRampToValueAtTime(k * 0.7 * wet, mid); wg.gain.setTargetAtTime(0, mid, down / 3);
    }
    if (vo.pan.pan) { vo.pan.pan.setValueAtTime(-0.7 * dir, t); vo.pan.pan.linearRampToValueAtTime(0.7 * dir, mid + down * 0.8); }
    vo.end = mid + down * 1.6;
    vo.play();
  }
  // a drop or a fish: a tiny rising "plip"
  function plip(t, k) {
    const vo = voice("fx", G.beds.water.out, rnd(-0.6, 0.6), t);
    if (!vo) return;
    const o = vo.osc("sine", 600), g = vo.gain(0);
    o.connect(g); g.connect(vo.out);
    const f = rnd(500, 900);
    o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * rnd(1.8, 2.6), t + 0.05);
    blip(g.gain, t, 0.003, 0.01, 0.02, k);
    vo.end = t + 0.15;
    vo.play();
  }

  // ---------------------------------------------------------------- what is near the view
  // A 40 m grid of the map's features, built once: road (metres of road × how busy that kind is), water, trees.
  function buildGrids() {
    const D = app.data, Wd = D.world, C = 40, x0 = Wd.x0, y0 = Wd.y0;
    const nx = Math.ceil((Wd.x1 - x0) / C), ny = Math.ceil((Wd.y1 - y0) / C);
    const road = new Float32Array(nx * ny), water = new Float32Array(nx * ny), trees = new Float32Array(nx * ny);
    const cell = (x, y) => { const i = Math.floor((x - x0) / C), j = Math.floor((y - y0) / C); return i < 0 || j < 0 || i >= nx || j >= ny ? -1 : j * nx + i; };
    const along = (pts, step, fn) => {
      for (let k = 2; k < pts.length; k += 2) {
        const ax = pts[k - 2], ay = pts[k - 1], bx = pts[k], by = pts[k + 1], len = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(len / step));
        for (let m = 0; m < n; m++) { const c = cell(ax + (bx - ax) * (m + 0.5) / n, ay + (by - ay) * (m + 0.5) / n); if (c >= 0) fn(c, len / n); }
      }
    };
    for (const r of D.roads || []) {
      let w = ROAD_W[r.k] || 0;
      if (!w || !r.pts) continue;
      if (r.tn) w *= 0.25;
      along(r.pts, 10, (c, l) => { road[c] += w * l; });
    }
    for (const a of D.areas || []) {
      if (a.k !== "water" || !a.p) continue;
      // fill by scanlines through the cells' centres (even-odd over all rings: islands stay dry)
      let ymin = Infinity, ymax = -Infinity;
      for (const ring of a.p) for (let k = 1; k < ring.length; k += 2) { ymin = Math.min(ymin, ring[k]); ymax = Math.max(ymax, ring[k]); }
      const j0 = Math.max(0, Math.floor((ymin - y0) / C)), j1 = Math.min(ny - 1, Math.floor((ymax - y0) / C));
      const xs = [];
      for (let j = j0; j <= j1; j++) {
        const y = y0 + (j + 0.5) * C;
        xs.length = 0;
        for (const ring of a.p) {
          const n = ring.length;
          for (let k = 0; k < n; k += 2) {
            const ax = ring[k], ay = ring[k + 1], bx = ring[(k + 2) % n], by = ring[(k + 3) % n];
            if ((ay > y) !== (by > y)) xs.push(ax + (y - ay) * (bx - ax) / (by - ay));
          }
        }
        xs.sort((p, q) => p - q);
        for (let m = 0; m + 1 < xs.length; m += 2) {
          const i0 = Math.max(0, Math.ceil((xs[m] - x0) / C - 0.5)), i1 = Math.min(nx - 1, Math.floor((xs[m + 1] - x0) / C - 0.5));
          for (let i = i0; i <= i1; i++) water[j * nx + i] = 1;
        }
      }
      // shores and ponds smaller than a cell
      for (const ring of a.p) for (let k = 0; k < ring.length; k += 2) { const c = cell(ring[k], ring[k + 1]); if (c >= 0) water[c] = Math.max(water[c], 0.7); }
    }
    for (const w of D.waterways || []) {
      if (!w.pts) continue;
      const v = w.k === "river" ? 1 : 0.45;
      along(w.pts, 15, (c) => { water[c] = Math.max(water[c], v); });
    }
    const T = D.trees || [];
    for (let k = 0; k + 1 < T.length; k += 5) { const c = cell(T[k], T[k + 1]); if (c >= 0) trees[c]++; }
    // the venues
    const centre = (b) => { const r = b.p[0]; let x = 0, y = 0; for (let k = 0; k < r.length; k += 2) { x += r[k]; y += r[k + 1]; } return { x: x / (r.length / 2), y: y / (r.length / 2) }; };
    const B = D.buildings || [];
    const st = B.find((b) => b && b.lm === "Ohio Stadium" && b.p && b.p[0]);
    const ar = B.find((b) => b && b.lm === "schott" && b.p && b.p[0]);
    return { C, x0, y0, nx, ny, road, water, trees, stadium: st ? centre(st) : null, arena: ar ? centre(ar) : null };
  }
  const L = { cx: NaN, cy: NaN, R: 0, close: 0, wash: 0, road: 0, water: 0, leafy: 0.3, stadium: 0, arena: 0, dStadium: Infinity };
  function listen() {
    const v = app.view, s = v.s;
    const [cx, cy] = v.centreGround();
    L.close = smooth(0, 1, (Math.log(s) - LN_FAR) / (LN_NEAR - LN_FAR));
    L.wash = lerp(0.55, 1, L.close);
    const R = clamp((0.3 * Math.hypot(v.w, v.h)) / s, 40, 1600);
    if (!grids) return;
    if (Math.abs(cx - L.cx) > R * 0.08 || Math.abs(cy - L.cy) > R * 0.08 || Math.abs(R - L.R) > L.R * 0.05 || !(L.R > 0)) {
      L.cx = cx; L.cy = cy; L.R = R;
      const g = grids, C = g.C, step = Math.max(1, Math.ceil((2 * R) / C / 48));
      const d0 = Math.max(30, 0.45 * R), wd0 = Math.max(25, 0.3 * R);
      const i0 = Math.max(0, Math.floor((cx - R - g.x0) / C)), i1 = Math.min(g.nx - 1, Math.floor((cx + R - g.x0) / C));
      const j0 = Math.max(0, Math.floor((cy - R - g.y0) / C)), j1 = Math.min(g.ny - 1, Math.floor((cy + R - g.y0) / C));
      let rs = 0, ts = 0, tw = 0, wm = 0;
      for (let j = j0; j <= j1; j += step) {
        const y = g.y0 + (j + 0.5) * C;
        for (let i = i0; i <= i1; i += step) {
          const x = g.x0 + (i + 0.5) * C, d = Math.hypot(x - cx, y - cy);
          if (d > R + C) continue;
          const k = j * g.nx + i, f = 1 / (1 + (d / d0) ** 2);
          rs += g.road[k] * f; ts += g.trees[k] * f; tw += f;
          const w = g.water[k];
          if (w) { const fw = w / (1 + (Math.max(0, d - C * 0.5) / wd0) ** 2); if (fw > wm) wm = fw; }
        }
      }
      rs *= step * step;
      L.road = 1 - Math.exp(-(1.2 * rs) / R);
      L.leafy = tw ? 1 - Math.exp(-(ts / tw) / 5) : 0.3;
      L.water = wm;
    }
    const near = (p, d0) => { if (!p) return [0, Infinity]; const d = Math.hypot(p.x - cx, p.y - cy); return [1 / (1 + (d / d0) ** 2), d]; };
    [L.stadium, L.dStadium] = near(grids.stadium, 350);
    L.arena = near(grids.arena, 150)[0];
  }

  // the Columbus clock (traffic follows it)
  const FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "numeric", minute: "numeric", weekday: "short" });
  const clk = { h: 12, weekend: false, at: -1 };
  function readClock() {
    const now = app.now(), ms = now.getTime();
    if (Math.abs(ms - clk.at) < 30000) return clk;
    clk.at = ms;
    let h = 12, m = 0, wd = "";
    for (const p of FMT.formatToParts(now)) { if (p.type === "hour") h = +p.value; else if (p.type === "minute") m = +p.value; else if (p.type === "weekday") wd = p.value; }
    clk.h = (h % 24) + m / 60; clk.weekend = wd === "Sat" || wd === "Sun";
    return clk;
  }
  function trafficNow() {
    const h = clk.h, a = TRAFFIC[Math.floor(h) % 24], b = TRAFFIC[(Math.floor(h) + 1) % 24], v = lerp(a, b, h % 1);
    return clk.weekend && h < 11 ? v * 0.6 : clk.weekend ? v * 0.85 : v;
  }

  // the game today (events.js), read every couple of seconds
  const game = { stadium: null, arena: null, at: -1e9, scores: new Map() };
  let swellQueue = 0;
  function readGames(t) {
    if (t - game.at < 2) return;
    game.at = t;
    game.stadium = game.arena = null;
    const ev = app.events;
    if (!ev || !app.layerEnabled("gameday")) return;
    let act, games;
    try { act = ev.active; if (!act || !act.length) return; games = ev.games; } catch { return; }
    const nowMs = app.now().getTime();
    for (const id of act) {
      const g = games.find((x) => x.id === id);
      if (!g || (g.venue !== "stadium" && g.venue !== "arena")) continue;
      const toStart = g.date ? (new Date(g.date).getTime() - nowMs) / 60000 : 0;
      game[g.venue] = { state: g.state, sport: g.sport, toStart };
      // Ohio State is the home side at both venues: their score is a roar, the visitors' a hush
      const sc = Array.isArray(g.score) ? g.score : null, was = game.scores.get(id);
      if (sc && was && g.state === "in") { if (sc[0] > was[0]) swellQueue = 1; else if (sc[1] > was[1]) swellQueue = -1; }
      if (sc) game.scores.set(id, sc.slice());
    }
  }

  // ---------------------------------------------------------------- the mix, 4 times a second
  const gust = { next: 0, level: 0 };
  let thunderNext = 0, flockWas = 0, critterNext = 0;
  function tick() {
    if (!ctx || ctx.state !== "running" || !G) { stopTimer(); return; }
    const t0 = performance.now(), dt = clamp((t0 - lastTick) / 1000, 0.05, 1);
    lastTick = t0; tickN++;
    try { update(dt); } catch (e) { if (!tickErr) { tickErr = true; console.error("[sound]", e); } }
    const ms = performance.now() - t0;
    perf.ms += ms; perf.ticks++; if (ms > perf.max) perf.max = ms;
  }

  function update(dt) {
    const t = ctx.currentTime, W = app.weather || EMPTY, wh = app.whimsy || EMPTY, B = G.beds;
    listen();
    readClock();
    const { close, wash } = L;
    const season = (app.tileStyle && app.tileStyle.season) || "summer";
    const night = clamp(num(W.night, clk.h < 6 || clk.h > 20 ? 1 : 0), 0, 1);
    const sunAlt = num(W.sunAlt, 30), morning = num(W.sunAz, clk.h < 12 ? 90 : 270) < 180;
    const rain = clamp(num(W.rain, 0), 0, 1), snow = clamp(num(W.snow, 0), 0, 1), fog = clamp(num(W.fog, 0), 0, 1), storm = !!W.storm;
    const wind = clamp(num(W.windMph, 5), 0, 80), tempF = num(W.tempF, SEASON_TEMP[season] || 55);
    const wet = Math.max(rain, snow * 0.5, num(W.snowDepthM, 0) > 0.01 ? 0.5 : 0);

    // the master: the user's volume, halved in ambient mode
    setp(G.master.gain, BASE_VOLUME * volume * (app.ambient ? 0.5 : 1), 0.6);
    mix.master = G.master.gain._sv;

    // wind, and the gusts that open its filter and stir the leaves
    const gusty = smooth(3, 25, wind);
    const windL = 0.22 * clamp((wind - 1) / 30, 0, 1) ** 0.8 * lerp(0.75, 1, wash);
    B.wind.set(windL, 1.2);
    const leafL = 0.09 * close * clamp(L.leafy * (LEAF_SEASON[season] || 0.5) * smooth(3, 22, wind) + 0.8 * num(wh.leaves, 0), 0, 1.2);
    B.leaves.set(leafL, 1);
    const wl = B.wind.live, ll = B.leaves.live;
    if (wl) {
      setp(wl.lp.frequency, 280 + 900 * smooth(0, 35, wind), 1.5);
      setp(wl.hg.gain, 0.5 * smooth(14, 35, wind), 1.5);
    }
    if (t >= gust.next && (wl || ll)) {
      const peak = rnd(0.3, 1) * gusty, rise = rnd(0.8, 2.2), fall = rnd(2, 5);
      for (const p of [wl && wl.gust.gain, ll && ll.gust.gain]) {
        if (!p) continue;
        p.setTargetAtTime(1 + 1.3 * peak, t, rise / 3); p.setTargetAtTime(rnd(0.75, 1), t + rise, fall / 3);
      }
      if (wl) { const f = wl.lp.frequency._sv || 600; wl.lp.frequency.setTargetAtTime(f * (1 + 0.9 * peak), t, rise / 3); wl.lp.frequency.setTargetAtTime(f, t + rise, fall / 3); }
      gust.level = peak;
      gust.next = t + rise + fall * 0.5 + rnd(2, 9) * (1.4 - gusty);
    }

    // rain (and close up, the patter of drops); thunder in a storm
    const rainL = 0.42 * rain ** 0.7 * wash * (storm ? 1.1 : 1);
    B.rain.set(rainL, 1.5);
    if (B.rain.live) { setp(B.rain.live.patter.gain, 0.1 + 0.6 * close, 1); setp(B.rain.live.body.gain, storm ? 0.9 : 0.6, 2); }
    const thunderOwn = storm && t - lightningSeen > 60;
    if (!thunderOwn) thunderNext = 0;
    else if (!thunderNext) thunderNext = t + rnd(3, 10);
    else if (t >= thunderNext) { thunder(t + rnd(0, 0.25), Math.random() ** 1.5); thunderNext = t + rnd(9, 28); }
    setp(G.bus.thunder.gain, wash, 1);
    mix.thunderIn = thunderNext ? +(thunderNext - t).toFixed(1) : null;

    // traffic: the city's hum, more near busy roads; cars going by at street zoom
    const tr = trafficNow();
    const trafL = 0.15 * tr * (0.3 + 0.7 * L.road * lerp(0.5, 1, close)) * (1 - 0.35 * snow) * wash;
    B.traffic.set(trafL, 2);
    if (B.traffic.live) { setp(B.traffic.live.roar.gain, 0.2 + 0.6 * L.road * close, 2); setp(B.traffic.live.wet.gain, 0.5 * wet, 3); }
    const cars = app.layerEnabled("cars") ? num(app.life && app.life.cars, 0) : 0;
    const passRate = Math.min(0.45, 0.012 * cars) * smooth(0.4, 0.75, close) * (0.3 + 0.7 * L.road);
    for (let k = due(passRate, dt); k > 0; k--) passBy(t + rnd(0.02, 0.25), 0.18 * rnd(0.5, 1) * (0.4 + 0.6 * L.road), wet);
    setp(G.bus.cars.gain, 1 - 0.4 * snow, 1);
    mix.carsPerS = +passRate.toFixed(2);

    // a game: the crowd at Ohio Stadium (a roar in play, a murmur before and after); an arena's, through its walls
    readGames(t);
    const sg = game.stadium;
    let roar = 0, murmur = 0;
    if (sg) {
      if (sg.state === "in") { roar = 1; murmur = 0.4; }
      else if (sg.state === "pre") { murmur = sg.toStart < 120 ? 1 : 0.6; roar = sg.toStart < 25 ? 0.35 : 0; }
      else if (sg.state === "post") { murmur = 0.6; }
    }
    const crowdL = (roar || murmur) ? 0.9 * (0.07 + 0.93 * L.stadium) * lerp(0.35, 1, close) : 0;
    B.crowd.set(crowdL, 1.5);
    const cl = B.crowd.live;
    if (cl) {
      setp(cl.roar.gain, roar, 2); setp(cl.murmur.gain, murmur * 0.8 * (0.3 + 0.7 * close), 2);
      if (Math.random() < dt / 2.5) cl.surge.gain.setTargetAtTime(rnd(0.65, 1.25), t, rnd(0.5, 1.5));    // the crowd surges and settles
      if (swellQueue && roar) {
        const S = cl.swell.gain;
        if (swellQueue > 0) { S.setTargetAtTime(2.4, t, 0.35); S.setTargetAtTime(1.5, t + 2.5, 1); S.setTargetAtTime(1, t + 6, 2); }
        else { S.setTargetAtTime(0.55, t, 0.5); S.setTargetAtTime(1, t + 3, 1.5); }
      }
    }
    swellQueue = 0;
    const ag = game.arena;
    B.arena.set(ag && ag.state === "in" ? 0.3 * L.arena * close : 0, 1.5);
    if (B.arena.live && Math.random() < dt / 3) B.arena.live.surge.gain.setTargetAtTime(rnd(0.6, 1.3), t, 0.8);
    mix.game = sg ? `stadium ${sg.state}` : ag ? `arena ${ag.state}` : "";

    // water: lapping near the lake and the river, close up (quieter when it is frozen-cold)
    const waterL = 0.32 * L.water * smooth(0.3, 0.85, close) * (tempF < 26 ? 0.35 : 1) * (1 - 0.5 * rain);
    B.water.set(waterL, 1.2);
    for (let k = due(1.5 * waterL, dt); k > 0; k--) plip(t + rnd(0.02, 0.25), 0.1 * rnd(0.3, 1));

    // crickets on warm nights, chirping as fast as the temperature says (Dolbear: chirps a minute = 4·°F − 160)
    const crickL = 0.05 * smooth(0.25, 0.8, night) * (CRICKET_SEASON[season] || 0) * smooth(55, 66, tempF) * (1 - 0.85 * rain) * (1 - 0.6 * smooth(10, 25, wind)) * lerp(0.55, 1, close);
    B.crickets.set(crickL, 2);
    if (B.crickets.live) { const r = clamp((4 * tempF - 160) / 60, 0.7, 3.2) / 2; B.crickets.live.ctls.forEach((c, i) => setp(c.playbackRate, r * (1 + (i - 1.5) * 0.04), 3)); }

    // steam's faint hiss
    B.steam.set(0.045 * clamp(num(wh.steam, 0), 0, 1) * lerp(0.3, 1, close), 1);

    // birds: a dawn chorus, sparse at midday, a little evening song; species by season; none at night but an owl
    let act;
    if (morning) act = sunAlt < -9 ? 0 : sunAlt < -3 ? 0.7 * smooth(-9, -3, sunAlt) : sunAlt < 8 ? lerp(0.7, 1, smooth(-3, 2, sunAlt)) : lerp(1, 0.22, smooth(8, 35, sunAlt));
    else act = sunAlt < -5 ? 0 : sunAlt < 8 ? 0.4 * smooth(-5, 2, sunAlt) + 0.05 : lerp(0.4, 0.22, smooth(8, 25, sunAlt));
    const wxB = (1 - 0.9 * rain) * (storm ? 0 : 1) * (1 - 0.5 * snow) * (1 - 0.3 * fog) * (1 - 0.6 * smooth(15, 35, wind)) * (tempF < 15 ? 0.5 : 1);
    const birdRate = 2.4 * act * (BIRD_SEASON[season] || 0.5) * wxB * (0.35 + 0.65 * L.leafy) * lerp(0.45, 1, close);
    const pNear = (0.15 + 0.55 * close) * (0.4 + 0.6 * L.leafy);
    const species = BIRDS[season] || BIRDS.summer;
    for (let k = due(birdRate, dt); k > 0; k--) bird(t + rnd(0.02, 0.25), weighted(species), Math.random() < pNear, close);
    const owlRate = night > 0.9 && rain < 0.1 && wind < 18 ? (1 / 55) * (0.3 + 0.7 * L.leafy) * lerp(0.5, 1, close) : 0;
    if (due(owlRate, dt)) bird(t + 0.1, "owl", false, close);
    mix.birdsPerS = +birdRate.toFixed(2);

    // the creatures on screen (app.whimsy, from the other modules), now and then
    const fl = clamp(num(wh.flock, 0), 0, 1);
    if (fl > 0.25 && flockWas <= 0.25) critter("flock", t + 0.05, 1);    // a flock lifting off
    flockWas = fl;
    const rates = [
      ["quack", 0.045 * Math.min(6, num(wh.waterfowl, 0))],
      ["honk", 0.012 * Math.min(6, num(wh.waterfowl, 0))],
      ["squirrel", 0.03 * Math.min(5, num(wh.squirrels, 0))],
      ["bark", 0.022 * Math.min(4, num(wh.dogs, 0))],
      ["flock", fl > 0.5 ? 0.06 * fl : 0],
      ["rustle", 0.06 * clamp(num(wh.leaves, 0), 0, 1)],
      ["hiss", 0.02 * clamp(num(wh.steam, 0), 0, 1)],
      ["snowball", 0.04 * Math.min(5, num(wh.snowday, 0))],
      ["crunch", 0.03 * Math.min(5, num(wh.snowday, 0))],
    ];
    let total = 0;
    for (const r of rates) total += r[1];
    const critL = lerp(0.5, 1, close);
    if (total > 0 && t >= critterNext && due(total, dt)) {
      let r = Math.random() * total;
      for (const [name, rate] of rates) { r -= rate; if (r <= 0) { critter(name, t + rnd(0.02, 0.25), critL); break; } }
      critterNext = t + 1.2;
    }
    mix.crittersPerS = +total.toFixed(3);

    Object.assign(mix, {
      close: +close.toFixed(2), road: +L.road.toFixed(2), water: +L.water.toFixed(2), leafy: +L.leafy.toFixed(2), stadium: +L.stadium.toFixed(2),
      season, wind: +B.wind.level.toFixed(3), leaves: +B.leaves.level.toFixed(3), rain: +B.rain.level.toFixed(3), traffic: +B.traffic.level.toFixed(3),
      crowd: +B.crowd.level.toFixed(3), arena: +B.arena.level.toFixed(3), lapping: +B.water.level.toFixed(3), crickets: +B.crickets.level.toFixed(3),
      steam: +B.steam.level.toFixed(3),
    });
  }

  function summary() {
    const m = mix;
    return `master ${(m.master || 0).toFixed(2)} · zoom ${m.close} · wind ${m.wind} leaves ${m.leaves} rain ${m.rain} traffic ${m.traffic} cars/s ${m.carsPerS} ` +
      `crowd ${m.crowd}${m.game ? ` (${m.game})` : ""} water ${m.lapping} crickets ${m.crickets} steam ${m.steam} birds/s ${m.birdsPerS} critters/s ${m.crittersPerS}` +
      ` · voices ${live.cue + live.critter + live.bird + live.fx} nodes ${live.nodes}`;
  }

  // ---------------------------------------------------------------- the API
  app.sound = {
    /** play a short sound: one of CUE_NAMES, at ground point { x, y } (metres) if given. False when sound is off. */
    cue,
    /** sound is switched on and playing */
    get on() { return !!(wanted && ctx && ctx.state === "running" && !document.hidden); },
    /** "off" | "waiting" (for a gesture, or the tab to show) | "running" */
    get state() { return !wanted ? "off" : ctx && ctx.state === "running" && !document.hidden ? "running" : "waiting"; },
    get volume() { return volume; },
    set volume(v) { volume = clamp(+v || 0, 0, 1.5); if (timer) tick(); },
    cues: CUE_NAMES.slice(),
    debug() {
      return { state: app.sound.state, ctx: ctx ? ctx.state : null, sampleRate: ctx ? ctx.sampleRate : null, mix: { ...mix },
        voices: { cue: live.cue, critter: live.critter, bird: live.bird, fx: live.fx }, nodes: live.nodes, voicesMade: live.made,
        beds: G ? Object.fromEntries(Object.entries(G.beds).map(([k, b]) => [k, b.live ? "on" : "off"])) : {},
        ticks: perf.ticks, msTotal: +perf.ms.toFixed(2), msMax: +perf.max.toFixed(2), msPerTick: perf.ticks ? +(perf.ms / perf.ticks).toFixed(3) : 0,
        buildMs: +perf.buildMs.toFixed(1), gridMs: +perf.gridMs.toFixed(1), summary: G ? summary() : "" };
    },
  };
  // ?sound=debug: the context and the buses too (tap any bus's output with an AnalyserNode to measure it)
  if (DEBUG) Object.defineProperty(app.sound, "_graph", { enumerable: false, get: () => (G ? { ctx, bus: G.bus, master: G.master, out: G.out, beds: G.beds, verbRet: G.verbRet, limiter: G.limiter } : { ctx }) });

  if (wanted) start();
}
