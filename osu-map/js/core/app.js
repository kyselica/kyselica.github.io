// The app: loads the campus, owns the canvas, the view, the tiles and the frame loop, and hosts the layers.
// See ARCHITECTURE.md for the contract layers are written against.

import { makeGeo } from "./geo.js";
import { Scene } from "./scene.js";
import { Tiles } from "./tiles.js";
import { View } from "./view.js";
import { makeRenderer, PAL, shade } from "./render.js";

export async function createApp({ canvas, dataUrl = "data/campus.json" }) {
  const params = new URLSearchParams(location.search);
  const mobile = matchMedia("(pointer: coarse)").matches || Math.min(screen.width, screen.height) < 700 || params.has("mobile");

  // fetched once as text: parsed here, and the same text handed to the tile workers (no second download)
  const dataText = await fetch(dataUrl).then((r) => { if (!r.ok) throw new Error(`${dataUrl}: ${r.status}`); return r.text(); });
  const data = JSON.parse(dataText);
  const geo = makeGeo(data);
  const scene = new Scene(data, geo);
  const renderer = makeRenderer(scene);
  const ctx = canvas.getContext("2d", { alpha: false });
  const view = new View(canvas, geo);

  // ---------------------------------------------------------------- time (?time=2026-11-22T19:30&speed=60 for testing)
  const realT0 = Date.now();
  const tOverride = params.get("time") ? new Date(params.get("time")).getTime() : NaN;
  // ?speed=0 freezes the clock (so `+x || 1` won't do); anything unparsable runs at 1×
  const sp = params.get("speed") == null || params.get("speed") === "" ? NaN : +params.get("speed");
  const speed = Number.isFinite(sp) ? Math.max(0, sp) : 1;
  const now = () => new Date((Number.isFinite(tOverride) ? tOverride : realT0) + (Date.now() - realT0) * speed);

  // ---------------------------------------------------------------- frame scheduling state (the loop itself is at the end)
  // The map draws on demand: see ARCHITECTURE.md "Frame scheduling". kick() asks for a frame at the next vsync.
  let started = false, inFrame = false, rafId = 0, timerId = 0, timerAt = Infinity;
  // frames drawn and main-thread ms spent in them, cached base-map frames, the fps the layers asked for last, and what
  // woke the loop how often (app.perf, read by tools/cpu.mjs: "why does the map keep drawing?")
  const perf = { frames: 0, ms: 0, fps: 0, cached: 0, why: {} };
  let dirty = true;         // something asked for a frame (drawn at the next vsync, even when asked during a frame)
  let due = 0;              // rAF time before which the next (layer-paced) frame need not be drawn; 0 = asap
  let lingerUntil = 0;      // keep drawing at full rate until then (label fades and the like, after a move or a UI event)
  const LINGER_MS = 700;
  function kick(linger, why) {
    if (why) perf.why[why] = (perf.why[why] || 0) + 1;
    dirty = true; due = 0;
    if (linger) lingerUntil = Math.max(lingerUntil, performance.now() + LINGER_MS);
    if (!inFrame) schedule(0);
  }
  /** make sure a frame is drawn in about `delay` ms (or sooner, if one is already coming sooner) */
  function schedule(delay) {
    if (!started || rafId || document.hidden) return;
    if (delay <= 6) {
      if (timerId) { clearTimeout(timerId); timerId = 0; timerAt = Infinity; }
      rafId = requestAnimationFrame(frame);
      return;
    }
    const at = performance.now() + delay;
    if (timerId) { if (timerAt <= at) return; clearTimeout(timerId); }
    timerAt = at;
    timerId = setTimeout(onTimer, delay - 4);
  }
  function onTimer() { timerId = 0; timerAt = Infinity; if (!rafId && !document.hidden) rafId = requestAnimationFrame(frame); }

  // ---------------------------------------------------------------- events
  // (an event from outside a frame — a click, a card, new data — usually changes what is drawn: it draws a frame;
  // a UI event also keeps drawing for a moment, so whatever fades in or out on it gets to finish)
  const LINGER_EVENTS = new Set(["click", "click-empty", "pick-building", "select-building", "card-open", "card-close", "layers", "theme", "style", "rotate"]);
  // the handler lists are copied on write, so emit can walk the current one while a handler adds or removes handlers
  // (no copy per emit: "frame" is emitted every frame)
  const handlers = {};
  const on = (name, fn) => { handlers[name] = (handlers[name] || []).concat([fn]); return () => off(name, fn); };
  const off = (name, fn) => { const a = handlers[name]; if (a && a.includes(fn)) handlers[name] = a.filter((x) => x !== fn); };
  const emit = (name, payload) => {
    const a = handlers[name];
    if (a) for (let i = 0; i < a.length; i++) { try { a[i](payload); } catch (e) { console.error(`[${name}]`, e); } }
    if (!inFrame && name !== "frame") kick(LINGER_EVENTS.has(name), name);
  };

  // ---------------------------------------------------------------- layers
  const layers = [];
  const enabled = new Map();
  const addLayer = (layer) => {
    layers.push(layer);
    layers.sort((a, b) => a.z - b.z);
    if (!enabled.has(layer.id)) enabled.set(layer.id, layer.enabled !== false);
    return layer;
  };
  const setLayerEnabled = (id, on) => { enabled.set(id, !!on); emit("layers", { id, on: !!on }); kick(true, "layers"); };
  const layerEnabled = (id) => enabled.get(id) !== false;

  // a tile that shows (or stands in) in the view last drawn: draw again (prefetched ones, other turns': nothing to do)
  const tiles = new Tiles({ dataUrl, dataText, scene, mobile, onTile: (key, shows) => { if (shows) kick(false, "tile"); } });
  // the season from the calendar until atmosphere.js knows better (?season= overrides)
  const season = params.get("season") || seasonFor(now());
  tiles.setStyle({ season, snow: params.has("snow") ? +params.get("snow") : 0 });

  const app = {
    data, geo, scene, renderer, view, tiles, canvas, ctx, params, mobile,
    now, on, off, emit, addLayer, setLayerEnabled, layerEnabled, layers,
    PAL, shade,
    get tileStyle() { return tiles.style; },
    setTileStyle(patch) { if (tiles.setStyle(patch)) { emit("style", tiles.style); kick(false, "style"); } },
    /** Draw a frame soon (new data arrived, something highlighted changed…). Cheap to call; calls coalesce. */
    requestRender(why) { kick(false, typeof why === "string" ? why : "requestRender"); },
    /** the most frames per second layers' animations get (movement of the view itself runs at the display's rate) */
    fpsCap: +params.get("fps") > 0 ? Math.min(240, +params.get("fps")) : mobile ? 30 : 60,
    /**
     * TEMPORARY, until every module gives its animated layers an fps(f): what a layer WITHOUT fps() is taken to ask
     * for, by id (a number, or a function (f) → number). Any layer not listed here and without fps() is static.
     */
    legacyFps: {
      buses: 30, cars: 30, people: 30,
      sky: 10,   // cloud shadows drift, the light changes with the clock
      "sky-weather": () => { const w = app.weather; return w && (w.rain > 0.01 || w.snow > 0.01 || w.fog > 0.02 || w.storm) ? 30 : 0; },
    },
    perf,
    /** CSS px of a lat/lon (z metres up) in the current view */
    project(lat, lon, z = 0) { return view.latLonToScreen(lat, lon, z); },
    groundToScreen(x, y, z = 0) { return view.groundToScreen(x, y, z); },
    /**
     * Ids (back to front) of the buildings, trees and lamps that stand in front of ground point (x, y) and overlap
     * rect = [x0, y0, x1, y1] CSS px. opts.buildingsOnly limits it to buildings.
     */
    inFront(x, y, rect, halfW = 0, opts = {}) {
      const r = view.rot;
      const [X0, Y0] = view.fromScreen(rect[0], rect[1]);
      const [X1, Y1] = view.fromScreen(rect[2], rect[3]);
      const ids = scene.query(r, "objects", X0, Y0, X1, Y1);
      const out = [];
      for (const i of ids) if ((!opts.buildingsOnly || i < scene.B) && scene.inFront(r, i, x, y, halfW)) out.push(i);
      return out;
    },
    /** Redraw the buildings, trees and lamps standing in front of ground point (x, y), clipped to rect = [x0, y0, x1, y1] CSS px. Returns how many. */
    occlude(c, x, y, rect, halfW = 0) {
      if (view.s * view.dpr < 0.8) return 0;
      const r = view.rot;
      const ids = app.inFront(x, y, rect, halfW);
      if (!ids.length) return 0;
      c.save();
      c.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      // clip on whole device pixels, so the redrawn objects meet the tile pixels without an anti-aliased seam
      const d = view.dpr, cx0 = Math.floor(rect[0] * d) / d, cy0 = Math.floor(rect[1] * d) / d, cx1 = Math.ceil(rect[2] * d) / d, cy1 = Math.ceil(rect[3] * d) / d;
      c.beginPath(); c.rect(cx0, cy0, cx1 - cx0, cy1 - cy0); c.clip();
      const k = view.s * view.dpr;
      const lod = Math.pow(2, tiles.levelFor(view));
      // (on the base map's pixel grid: the view's offset rounded to whole device pixels, as the tiles are placed)
      renderer.drawObjects(c, r, { k, lod, ox: Math.round((view.X * view.s - view.w / 2) * view.dpr), oy: Math.round((view.Y * view.s - view.h / 2) * view.dpr) }, ids, tiles.style);
      c.restore();
      return ids.length;
    },
    /** index of the building under CSS px (px, py), or -1 */
    pickBuilding(px, py) { const [X, Y] = view.fromScreen(px, py); return scene.pickBuilding(view.rot, X, Y); },
    ui: null,   // filled in by ui.js
    status: { loaded: false, modules: false },
  };
  window.app = app;   // handy in the console, and for tests
  on("modules-ready", () => { app.status.modules = true; });
  view.onWake = () => kick(true, inFrame ? null : "view");

  // ---------------------------------------------------------------- canvas size
  const fit = () => {
    view.resize();
    canvas.width = Math.round(view.w * view.dpr);
    canvas.height = Math.round(view.h * view.dpr);
    view.minS = Math.max(0.06, view.minScaleToFit() * 0.9);
  };
  fit();
  window.addEventListener("resize", fit);

  // ---------------------------------------------------------------- the first view: ?at=lat,lon,metres[,rot] or #lat,lon,metres[,rot], else the Oval
  {
    const m = /(-?\d+\.\d+),(-?\d+\.\d+),(\d+(?:\.\d+)?)m?(?:,(\d))?/.exec(params.get("at") || location.hash.slice(1));
    const ok = m && Math.abs(+m[1] - data.origin.lat) < 0.05 && Math.abs(+m[2] - data.origin.lon) < 0.05;
    // a first visit (no view asked for) opens over the whole campus; ui.js then glides down to the Oval once it's drawn
    const intro = !ok && !params.has("nointro") && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    app.intro = intro;
    const v = ok ? { lat: +m[1], lon: +m[2], m: Math.max(30, Math.min(8000, +m[3])), r: m[4] ? +m[4] : 0 }
      : intro ? { lat: 40.0026, lon: -83.0178, m: mobile ? 3400 : 4600, r: 0 } : { lat: 39.9995, lon: -83.0148, m: mobile ? 420 : 760, r: 0 };
    if (v.r) view.setRotation(v.r);
    view.flyTo({ lat: v.lat, lon: v.lon }, { m: v.m, instant: true });
  }

  // ---------------------------------------------------------------- pointer → layers
  const hitTest = (px, py) => {
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      if (!layerEnabled(L.id) || !L.hit) continue;
      const t = L.hit(px, py);
      if (t) return { layer: L, target: t };
    }
    return null;
  };
  view.on("click", ({ px, py, e }) => {
    const h = hitTest(px, py);
    const ground = view.screenToGround(px, py);
    if (h && h.layer.onClick) { h.layer.onClick(h.target, { px, py, e, ground }); emit("click", { px, py, ground, layer: h.layer.id, target: h.target }); return; }
    const bi = app.pickBuilding(px, py);
    if (bi >= 0) { emit("pick-building", { index: bi, building: data.buildings[bi], px, py }); emit("click", { px, py, ground, building: bi }); return; }
    emit("click", { px, py, ground });
    emit("click-empty", { px, py, ground });
  });
  // a layer's hover look changes only when what is under the pointer does: then a frame is drawn
  let hoverLayer = null, hoverTarget = null;
  view.on("hover", ({ px, py }) => {
    if (px < 0) {
      if (hoverLayer && hoverLayer.onHover) hoverLayer.onHover(null);
      if (hoverLayer) kick(true, "hover");
      hoverLayer = null; hoverTarget = null; canvas.style.cursor = ""; return;
    }
    const h = hitTest(px, py);
    if (hoverLayer && (!h || h.layer !== hoverLayer) && hoverLayer.onHover) hoverLayer.onHover(null);
    const changed = (h ? h.layer : null) !== hoverLayer || (h ? h.target : null) !== hoverTarget;
    hoverLayer = h ? h.layer : null; hoverTarget = h ? h.target : null;
    if (h && h.layer.onHover) h.layer.onHover(h.target, { px, py });
    canvas.style.cursor = h ? "pointer" : "";
    if (changed) kick(true, "hover");
  });
  view.on("change", () => emit("view", view));
  // Turning the camera: keep the old picture on top and fade it out once the new tiles are in. It covers everything
  // (buses and labels too), so it must never hold the map up: any move (drag, zoom, fly-to, another turn) starts the fade
  // at once, and however slow the tiles are it stays opaque no longer than ROT_HOLD ms (stand-ins fill in after that).
  const ROT_HOLD = 1000, ROT_FADE = 350;
  let rotSnap = null;
  view.on("rotate", (r) => {
    try {
      const c = document.createElement("canvas");
      c.width = canvas.width; c.height = canvas.height;
      c.getContext("2d").drawImage(canvas, 0, 0);
      rotSnap = { c, t0: performance.now(), fade: null, at: { X: view.X, Y: view.Y, s: view.s, r } };
    } catch { rotSnap = null; }
    emit("rotate", r);
    setTimeout(() => scene.forRot(r), 50);
  });

  // ---------------------------------------------------------------- the frame
  // Drawn on demand (ARCHITECTURE.md "Frame scheduling"): at the display's rate while the view moves (and for LINGER_MS
  // after), else at the highest rate an enabled layer's fps(f) asks for (capped by app.fpsCap), else not at all until
  // something kicks the loop: input, app.requestRender(), an event, a tile arriving. A hidden tab draws nothing.
  await tiles.init();
  let last = performance.now(), frames = 0, firstComplete = false, lastMoveT = 0, stillFrames = 2;
  const DT_MAX = 0.25;          // f.dt never exceeds this (the first frame after a pause, a slow machine)
  const STILL_MS = 120;         // the view counts as still this long after it last moved (a slow drag isn't "still")
  const bgCol = PAL.bg;
  // one frame object, updated in place (no garbage per frame), f.now too: read them during the frame, copy what you keep
  const f = { t: 0, dt: 0, now: new Date(), view, frame: 0, s: 1, dpr: 1, w: 1, h: 1, moving: false };
  const clockAt = (d) => d.setTime((Number.isFinite(tOverride) ? tOverride : realT0) + (Date.now() - realT0) * speed);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (rafId) cancelAnimationFrame(rafId);
      if (timerId) clearTimeout(timerId);
      rafId = 0; timerId = 0; timerAt = Infinity;
    } else kick(false, "visible");
  });

  // The base map (background, the slab, the tiles) is kept in a canvas the size of the map's and copied 1:1 into place
  // each frame: one cheap blit instead of a background fill, the slab and 10–40 resampled tiles. It is painted with its
  // pixels on a grid fixed to the map (the view's offset rounded to whole device pixels), so that
  //  · while the view only pans, the old picture is copied over by whole pixels and only the strips it uncovers are
  //    painted (no resampling, no blur from the copy);
  //  · a tile that arrives repaints only its own rectangle;
  //  · anything else (a zoom, a turn, a resize, a new style or background colour) paints it all.
  // While the view moves it is painted with cheap (bilinear) resampling; once it holds still, once more at full quality.
  const base = { a: null, ga: null, b: null, gb: null, ok: false, hq: false, offX: 0, offY: 0, s: NaN, rot: -1, dpr: 0, W: 0, H: 0, ver: -1, bg: "", top: "" };
  const clipRects = [];   // device-px rectangles [x, y, w, h]* to repaint this frame (reused)
  const keepBase = params.get("basecache") !== "0";   // ?basecache=0: paint it all every frame (to compare)
  function paintBase(g, still, offX, offY, clip) {
    // paint as if the view sat exactly on the pixel grid (it is at most half a device pixel off)
    const X = view.X, Y = view.Y;
    view.X = (offX / view.dpr + view.w / 2) / view.s; view.Y = (offY / view.dpr + view.h / 2) / view.s;
    g.save();
    try {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
      if (clip) {
        g.beginPath();
        for (let i = 0; i < clipRects.length; i += 4) g.rect(clipRects[i], clipRects[i + 1], clipRects[i + 2], clipRects[i + 3]);
        g.clip();
      }
      g.fillStyle = app.background || bgCol;
      g.fillRect(0, 0, canvas.width, canvas.height);
      drawSlab(g, app, view);
      tiles.beginFrame();
      tiles.draw(g, view, "base", still ? BASE_STILL : BASE_MOVING);
    } finally { g.restore(); view.X = X; view.Y = Y; }
  }
  function sizeBase(which, W, H) {
    let c = base[which];
    if (!c) c = base[which] = document.createElement("canvas");
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; base["g" + which] = null; }
    return base["g" + which] || (base["g" + which] = c.getContext("2d", { alpha: false }));
  }
  function drawBase(still) {
    const W = canvas.width, H = canvas.height, d = view.dpr, s = view.s;
    const bg = app.background || bgCol, top = app.slabTop || PAL.land;
    const offX = Math.round((view.X * s - view.w / 2) * d), offY = Math.round((view.Y * s - view.h / 2) * d);
    const ga = sizeBase("a", W, H);
    const same = keepBase && base.ok && base.s === s && base.rot === view.rot && base.dpr === d && base.W === W && base.H === H &&
      base.ver === tiles.ver && base.bg === bg && base.top === top && !tiles.dirtyAll;
    const dx = base.offX - offX, dy = base.offY - offY;
    clipRects.length = 0;
    if (same) {
      // what needs painting: the strips a pan uncovers, the rectangles of tiles that arrived
      if (dx > 0) clipRects.push(0, 0, dx, H); else if (dx < 0) clipRects.push(W + dx, 0, -dx, H);
      if (dy > 0) clipRects.push(0, 0, W, dy); else if (dy < 0) clipRects.push(0, H + dy, W, -dy);
      const T = tiles.dirty;
      for (let i = 0; i < T.length; i += 4) {
        const x0 = Math.floor(T[i] * s * d) - offX, y0 = Math.floor(T[i + 1] * s * d) - offY;
        const x1 = Math.ceil(T[i + 2] * s * d) - offX + 1, y1 = Math.ceil(T[i + 3] * s * d) - offY + 1;
        if (x1 > 0 && y1 > 0 && x0 < W && y0 < H) clipRects.push(x0, y0, x1 - x0, y1 - y0);
      }
    }
    let area = 0;
    for (let i = 0; i < clipRects.length; i += 4) area += clipRects[i + 2] * clipRects[i + 3];
    if (!same || area > W * H * 0.6 || (still && !base.hq)) {
      paintBase(ga, still, offX, offY, false);
      base.hq = still;
    } else if (clipRects.length) {
      let g = ga;
      if (dx || dy) {
        // copy the old picture over (into the spare canvas, then swap: a canvas can't be copied onto itself cheaply)
        g = sizeBase("b", W, H);
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
        g.drawImage(base.a, dx, dy);
        const c = base.a; base.a = base.b; base.b = c;
        base.ga = g; base.gb = ga;
      }
      paintBase(g, still, offX, offY, true);
      if (!still) base.hq = false;
    } else perf.cached++;
    tiles.dirty.length = 0; tiles.dirtyAll = false;
    base.ok = true; base.offX = offX; base.offY = offY; base.s = s; base.rot = view.rot; base.dpr = d; base.W = W; base.H = H;
    base.ver = tiles.ver; base.bg = bg; base.top = top;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(base.a, 0, 0);
  }

  /** the most frames per second the enabled layers ask for right now (layers without fps(): app.legacyFps, else 0) */
  function layersFps() {
    let want = 0;
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      if (!layerEnabled(L.id)) continue;
      let v = L.fps;
      if (v == null) v = app.legacyFps && app.legacyFps[L.id];
      if (typeof v === "function") {
        try { v = v.call(L, f); } catch (e) { if (!L._fpsErr) { console.error(`layer ${L.id} fps:`, e); L._fpsErr = true; } v = 0; }
      }
      v = +v || 0;
      if (v > want) want = v;
    }
    return want;
  }

  function frame(t) {
    rafId = 0;
    if (document.hidden) return;
    // a layer-paced frame that came round early (rAF runs at the display's rate): wait for the next vsync
    if (!dirty && due && t < due - 7) { rafId = requestAnimationFrame(frame); return; }
    const t0 = performance.now();
    inFrame = true;
    dirty = false;
    const dt = Math.min(DT_MAX, Math.max(0, (t - last) / 1000));
    last = t;
    frames++;
    view.update(dt);
    if (view.moving) { lastMoveT = t0; stillFrames = 0; lingerUntil = Math.max(lingerUntil, t0 + LINGER_MS); }
    else stillFrames++;
    // still: no movement for STILL_MS and for two frames (on a slow machine one frame can outlast STILL_MS mid-drag)
    const still = stillFrames >= 2 && t0 - lastMoveT > STILL_MS;
    f.t = t; f.dt = dt; clockAt(f.now); f.frame = frames; f.s = view.s; f.dpr = view.dpr; f.w = view.w; f.h = view.h; f.moving = !still;
    tiles.still = still;
    emit("frame", f);
    // background, the diorama's sides, then the map
    drawBase(still);
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      if (!L.draw || !layerEnabled(L.id)) continue;
      ctx.save();
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      try { L.draw(ctx, f); } catch (e) { if (!L._err) { console.error(`layer ${L.id}:`, e); L._err = true; } }
      ctx.restore();
    }
    if (rotSnap) {
      const at = rotSnap.at, now = performance.now();
      const moved = view.X !== at.X || view.Y !== at.Y || view.s !== at.s || view.rot !== at.r;
      // let go when the reader moves, when the new turn is fully drawn, or once stand-ins cover every tile (not before
      // ROT_HOLD, and never later than 5 s): fading onto bare holes looks broken
      const age = now - rotSnap.t0;
      if (rotSnap.fade == null && (moved || tiles.complete(view) || (age > ROT_HOLD && !tiles.holes) || age > 5000)) rotSnap.fade = now;
      const a = rotSnap.fade == null ? 1 : 1 - (now - rotSnap.fade) / ROT_FADE;
      if (a <= 0) rotSnap = null;
      else {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = a; ctx.globalCompositeOperation = "source-over";
        ctx.drawImage(rotSnap.c, 0, 0);
        ctx.globalAlpha = 1;
      }
    }
    if (!firstComplete && tiles.complete(view)) {
      firstComplete = true;
      app.status.loaded = true;
      emit("ready", app);
      // the main thread's projected scene (for picking and occlusion), built while idle rather than on first use
      (window.requestIdleCallback || ((fn) => setTimeout(fn, 200)))(() => scene.forRot(view.rot));
      document.body.classList.add("ready");
    }
    inFrame = false;
    // what next: full rate while anything moves (or something asked during this frame), else the layers' pace, else sleep
    const end = performance.now();
    const want = Math.min(app.fpsCap, layersFps());
    perf.fps = want;
    perf.frames++; perf.ms += end - t0;
    if (dirty || !still || rotSnap || view.active() || end < lingerUntil) { due = 0; schedule(0); }
    else if (want > 0) { due = t + 1000 / want; schedule(due - end - 8); }
    else due = 0;
  }
  started = true;
  kick(false, "start");
  return app;
}

/** the calendar's season in central Ohio (leaves mostly gone by the third week of November) */
export function seasonFor(d) {
  const m = d.getMonth() + 1, day = d.getDate();
  if (m === 12 || m <= 2) return "winter";
  if (m === 3) return day < 25 ? "winter" : "spring";
  if (m === 4) return "spring";
  if (m === 5) return day < 10 ? "spring" : "summer";
  if (m <= 9) return "summer";
  if (m === 10) return day < 12 ? "summer" : "autumn";
  return day < 14 ? "autumn" : "late-autumn";   // November
}

const BASE_STILL = { quality: "high", prefetch: true }, BASE_MOVING = { quality: "low", prefetch: false };

// the diorama: the campus as a slab of earth, its two near sides showing
const SLAB_DEPTH = 46;
// strata from the top: turf, topsoil, clay, gravel, bedrock
const STRATA = [[0, 1.2, "#7f9b5a"], [1.2, 7, "#8a6a4c"], [7, 19, "#a27b55"], [19, 31, "#b89671"], [31, SLAB_DEPTH, "#8d8578"]];
const slabGeo = [];   // per rotation, in screen metres (worked out once): { top, hull, faces: [{ pts, col }], edges }
function slabFor(app, r) {
  if (slabGeo[r]) return slabGeo[r];
  const { geo, data } = app;
  const w = data.world;
  const corners = [[w.x0, w.y0], [w.x1, w.y0], [w.x1, w.y1], [w.x0, w.y1]];
  const top = corners.map(([x, y]) => geo.proj(x, y, 0, r));
  const bottom = corners.map(([x, y]) => geo.proj(x, y, -SLAB_DEPTH, r));
  const faces = [], edges = [];
  for (let e = 0; e < 4; e++) {
    const [ax, ay] = corners[e], [bx, by] = corners[(e + 1) % 4];
    // outward normal of a counter-clockwise rectangle edge
    const nx = by - ay, ny = -(bx - ax), L = Math.hypot(nx, ny);
    const nd = (nx / L) * geo.ROTS[r].D[0] + (ny / L) * geo.ROTS[r].D[1];
    if (nd >= 0) continue;
    const nu = (nx / L) * geo.ROTS[r].R[0] + (ny / L) * geo.ROTS[r].R[1];
    const lit = nu < 0;
    for (const [z0, z1, col] of STRATA) {
      const p = [geo.proj(ax, ay, -z0, r), geo.proj(bx, by, -z0, r), geo.proj(bx, by, -z1, r), geo.proj(ax, ay, -z1, r)];
      faces.push({ pts: p.flat(), col: shade(col, lit ? 1 : 0.8) });
    }
    edges.push([...geo.proj(ax, ay, 0, r), ...geo.proj(bx, by, 0, r)]);
  }
  return (slabGeo[r] = { top, hull: convexHull(top.concat(bottom)), faces, edges });
}
function drawSlab(ctx, app, view) {
  const S = slabFor(app, view.rot), s = view.s, d = view.dpr;
  ctx.save();
  // a soft shadow under the slab, unless the slab's top fills the whole viewport (then none of it can show)
  const hw = view.w / 2 / s, hh = view.h / 2 / s;
  const covered = insideConvex(S.top, view.X - hw, view.Y - hh) && insideConvex(S.top, view.X + hw, view.Y - hh) &&
    insideConvex(S.top, view.X + hw, view.Y + hh) && insideConvex(S.top, view.X - hw, view.Y + hh);
  if (!covered) { ctx.setTransform(d, 0, 0, d, 0, 0); drawSlabShadow(ctx, app, view); }
  // the slab itself, in screen metres: under the tiles, it is what shows where a tile is still missing
  ctx.setTransform(d * s, 0, 0, d * s, d * (view.w / 2 - view.X * s), d * (view.h / 2 - view.Y * s));
  const H = S.hull;
  ctx.beginPath();
  ctx.moveTo(H[0][0], H[0][1]); for (let i = 1; i < H.length; i++) ctx.lineTo(H[i][0], H[i][1]); ctx.closePath();
  ctx.fillStyle = app.slabTop || PAL.land;
  ctx.fill();
  for (let i = 0; i < S.faces.length; i++) {
    const p = S.faces[i].pts;
    ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(p[2], p[3]); ctx.lineTo(p[4], p[5]); ctx.lineTo(p[6], p[7]); ctx.closePath();
    ctx.fillStyle = S.faces[i].col;
    ctx.fill();
  }
  // a hairline at the top edge (1 CSS px)
  ctx.strokeStyle = "rgba(40, 30, 20, .35)"; ctx.lineWidth = 1 / s;
  for (let i = 0; i < S.edges.length; i++) {
    const e = S.edges[i];
    ctx.beginPath(); ctx.moveTo(e[0], e[1]); ctx.lineTo(e[2], e[3]); ctx.stroke();
  }
  ctx.restore();
}

// The shadow is a 40 px blur of a polygon as big as the slab: drawn straight onto the canvas every frame that costs about
// 16 ms in software Canvas2D. Instead it is drawn once per rotation and scale into a small canvas (at most SHADOW_RES px
// across, in screen metres so a pan only moves it) and stretched into place; a blur loses nothing by being upscaled.
const SHADOW_RES = 1024;
let slabShadow = null;   // { key, c, X0, Y0, W, H } (the canvas covers screen metres X0..X0+W, Y0..Y0+H)
function drawSlabShadow(ctx, app, view) {
  const { geo, data } = app;
  const w = data.world, r = view.rot, s = view.s;
  // canvas shadows ignore the transform: like the slab's original shadow, these are device px
  const f = Math.min(1, s * 4), blur = 40 * f, offY = 18 * f;
  // the scale in steps of ~3 %: the picture is placed exactly, only its blur radius is rounded
  const sq = Math.exp(Math.round(Math.log(s) * 30) / 30);
  const key = `${r}|${sq.toFixed(5)}|${view.dpr}`;
  if (!slabShadow || slabShadow.key !== key) {
    const pts = [];
    for (const z of [0, -SLAB_DEPTH]) for (const [x, y] of [[w.x0, w.y0], [w.x1, w.y0], [w.x1, w.y1], [w.x0, w.y1]]) pts.push(geo.proj(x, y, z, r));
    const hull = convexHull(pts);
    const m = (blur * 2 + offY) / (sq * view.dpr);   // room for the blur, in screen metres
    let X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity;
    for (const [X, Y] of hull) { X0 = Math.min(X0, X); Y0 = Math.min(Y0, Y); X1 = Math.max(X1, X); Y1 = Math.max(Y1, Y); }
    X0 -= m; Y0 -= m; X1 += m; Y1 += m;
    const W = X1 - X0, H = Y1 - Y0;
    const q = Math.min(sq * view.dpr, SHADOW_RES / Math.max(W, H));   // canvas px per screen metre
    const c = slabShadow && slabShadow.c || document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(W * q)); c.height = Math.max(1, Math.ceil(H * q));
    const g = c.getContext("2d");
    g.clearRect(0, 0, c.width, c.height);
    // only the shadow: the shape itself is drawn one canvas-width off to the left and its shadow offset back in
    const k = q / (sq * view.dpr);   // canvas px per device px
    const away = c.width + 64;
    g.shadowColor = "rgba(60, 45, 30, .28)"; g.shadowBlur = blur * k; g.shadowOffsetX = away; g.shadowOffsetY = offY * k;
    g.beginPath();
    hull.forEach(([X, Y], i) => (i ? g.lineTo : g.moveTo).call(g, (X - X0) * q - away, (Y - Y0) * q));
    g.closePath();
    g.fillStyle = "#000";
    g.fill();
    slabShadow = { key, c, X0, Y0, W, H };
  }
  const [px, py] = view.toScreen(slabShadow.X0, slabShadow.Y0);
  ctx.drawImage(slabShadow.c, px, py, slabShadow.W * s, slabShadow.H * s);
}

// is (x, y) inside the convex polygon pts (either winding)?
function insideConvex(pts, x, y) {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c === 0) continue;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  return true;
}

function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
