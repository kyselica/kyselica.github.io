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
  const speed = Math.max(0, +params.get("speed") || 1);
  const now = () => new Date(Number.isFinite(tOverride) ? tOverride + (Date.now() - realT0) * speed : realT0 + (Date.now() - realT0) * (params.has("speed") ? speed : 1));

  // ---------------------------------------------------------------- events
  const handlers = {};
  const on = (name, fn) => { (handlers[name] || (handlers[name] = [])).push(fn); return () => off(name, fn); };
  const off = (name, fn) => { const a = handlers[name]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } };
  const emit = (name, payload) => { for (const fn of (handlers[name] || []).slice()) { try { fn(payload); } catch (e) { console.error(`[${name}]`, e); } } };

  // ---------------------------------------------------------------- layers
  const layers = [];
  const enabled = new Map();
  const addLayer = (layer) => {
    layers.push(layer);
    layers.sort((a, b) => a.z - b.z);
    if (!enabled.has(layer.id)) enabled.set(layer.id, layer.enabled !== false);
    return layer;
  };
  const setLayerEnabled = (id, on) => { enabled.set(id, !!on); emit("layers", { id, on: !!on }); };
  const layerEnabled = (id) => enabled.get(id) !== false;

  const tiles = new Tiles({ dataUrl, dataText, scene, mobile, onTile: () => {} });
  // the season from the calendar until atmosphere.js knows better (?season= overrides)
  const season = params.get("season") || seasonFor(now());
  tiles.setStyle({ season, snow: params.has("snow") ? +params.get("snow") : 0 });

  const app = {
    data, geo, scene, renderer, view, tiles, canvas, ctx, params, mobile,
    now, on, off, emit, addLayer, setLayerEnabled, layerEnabled, layers,
    PAL, shade,
    get tileStyle() { return tiles.style; },
    setTileStyle(patch) { if (tiles.setStyle(patch)) emit("style", tiles.style); },
    /** CSS px of a lat/lon (z metres up) in the current view */
    project(lat, lon, z = 0) { return view.latLonToScreen(lat, lon, z); },
    groundToScreen(x, y, z = 0) { return view.groundToScreen(x, y, z); },
    /** Redraw the buildings, trees and lamps standing in front of ground point (x, y), clipped to rect = [x0, y0, x1, y1] CSS px. */
    occlude(c, x, y, rect, halfW = 0) {
      if (view.s * view.dpr < 0.8) return 0;
      const r = view.rot;
      const [X0, Y0] = view.fromScreen(rect[0], rect[1]);
      const [X1, Y1] = view.fromScreen(rect[2], rect[3]);
      const ids = scene.query(r, "objects", X0, Y0, X1, Y1).filter((i) => scene.inFront(r, i, x, y, halfW));
      if (!ids.length) return 0;
      c.save();
      c.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      c.beginPath(); c.rect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]); c.clip();
      const k = view.s * view.dpr;
      const lod = Math.pow(2, tiles.levelFor(view));
      renderer.drawObjects(c, r, { k, lod, ox: (view.X * view.s - view.w / 2) * view.dpr, oy: (view.Y * view.s - view.h / 2) * view.dpr }, ids, tiles.style);
      c.restore();
      return ids.length;
    },
    /** index of the building under CSS px (px, py), or -1 */
    pickBuilding(px, py) { const [X, Y] = view.fromScreen(px, py); return scene.pickBuilding(view.rot, X, Y); },
    ui: null,   // filled in by ui.js
    status: { loaded: false },
  };
  window.app = app;   // handy in the console, and for tests

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
    const v = ok ? { lat: +m[1], lon: +m[2], m: Math.max(30, Math.min(8000, +m[3])), r: m[4] ? +m[4] : 0 } : { lat: 39.9995, lon: -83.0148, m: mobile ? 420 : 760, r: 0 };
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
  let hoverLayer = null;
  view.on("hover", ({ px, py }) => {
    if (px < 0) { if (hoverLayer && hoverLayer.onHover) hoverLayer.onHover(null); hoverLayer = null; canvas.style.cursor = ""; return; }
    const h = hitTest(px, py);
    if (hoverLayer && (!h || h.layer !== hoverLayer) && hoverLayer.onHover) hoverLayer.onHover(null);
    hoverLayer = h ? h.layer : null;
    if (h && h.layer.onHover) h.layer.onHover(h.target, { px, py });
    canvas.style.cursor = h ? "pointer" : "";
  });
  view.on("change", () => emit("view", view));
  // turning the camera: keep the old picture on top and fade it out once the new tiles are in
  let rotSnap = null;
  view.on("rotate", (r) => {
    try {
      const c = document.createElement("canvas");
      c.width = canvas.width; c.height = canvas.height;
      c.getContext("2d").drawImage(canvas, 0, 0);
      rotSnap = { c, t0: performance.now(), fade: null };
    } catch { rotSnap = null; }
    emit("rotate", r);
    setTimeout(() => scene.forRot(r), 50);
  });

  // ---------------------------------------------------------------- the frame
  await tiles.init();
  let last = performance.now(), frames = 0, firstComplete = false;
  const bgCol = PAL.bg;
  function frame(t) {
    const dt = Math.min(0.1, (t - last) / 1000);
    last = t;
    frames++;
    view.update(dt);
    tiles.beginFrame();
    const f = { t, dt, now: now(), view, frame: frames, s: view.s, dpr: view.dpr, w: view.w, h: view.h };
    emit("frame", f);
    // background, the diorama's sides, then the map
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = app.background || bgCol;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawSlab(ctx, app, view);
    tiles.draw(ctx, view, "base");
    for (const L of layers) {
      if (!layerEnabled(L.id) || !L.draw) continue;
      ctx.save();
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      try { L.draw(ctx, f); } catch (e) { if (!L._err) { console.error(`layer ${L.id}:`, e); L._err = true; } }
      ctx.restore();
    }
    if (rotSnap) {
      const done = tiles.complete(view);
      if (rotSnap.fade == null && (done || t - rotSnap.t0 > 2500)) rotSnap.fade = t;
      const a = rotSnap.fade == null ? 1 : 1 - (t - rotSnap.fade) / 350;
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
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
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

// the diorama: the campus as a slab of earth, its two near sides showing
function drawSlab(ctx, app, view) {
  const { geo, data } = app;
  const w = data.world, r = view.rot, depth = 46;
  const corners = [[w.x0, w.y0], [w.x1, w.y0], [w.x1, w.y1], [w.x0, w.y1]];
  ctx.save();
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  // a soft shadow under the slab
  const top = corners.map(([x, y]) => view.groundToScreen(x, y, 0));
  ctx.save();
  ctx.shadowColor = "rgba(60, 45, 30, .28)"; ctx.shadowBlur = 40 * Math.min(1, view.s * 4); ctx.shadowOffsetY = 18 * Math.min(1, view.s * 4);
  ctx.beginPath();
  const bottom = corners.map(([x, y]) => view.groundToScreen(x, y, -depth));
  const hull = convexHull(top.concat(bottom));
  ctx.moveTo(hull[0][0], hull[0][1]); for (const p of hull) ctx.lineTo(p[0], p[1]); ctx.closePath();
  ctx.fillStyle = app.slabTop || PAL.land;
  ctx.fill();
  ctx.restore();
  for (let e = 0; e < 4; e++) {
    const [ax, ay] = corners[e], [bx, by] = corners[(e + 1) % 4];
    // outward normal of a counter-clockwise rectangle edge
    const nx = by - ay, ny = -(bx - ax), L = Math.hypot(nx, ny);
    const nd = (nx / L) * geo.ROTS[r].D[0] + (ny / L) * geo.ROTS[r].D[1];
    if (nd >= 0) continue;
    const nu = (nx / L) * geo.ROTS[r].R[0] + (ny / L) * geo.ROTS[r].R[1];
    const lit = nu < 0;
    // strata from the top: turf, topsoil, clay, gravel, bedrock
    const bands = [[0, 1.2, "#7f9b5a"], [1.2, 7, "#8a6a4c"], [7, 19, "#a27b55"], [19, 31, "#b89671"], [31, depth, "#8d8578"]];
    for (const [z0, z1, col] of bands) {
      const p0 = view.groundToScreen(ax, ay, -z0), p1 = view.groundToScreen(bx, by, -z0), p2 = view.groundToScreen(bx, by, -z1), p3 = view.groundToScreen(ax, ay, -z1);
      ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.lineTo(p3[0], p3[1]); ctx.closePath();
      ctx.fillStyle = shade(col, lit ? 1 : 0.8);
      ctx.fill();
    }
    // a hairline at the top edge
    const p0 = view.groundToScreen(ax, ay, 0), p1 = view.groundToScreen(bx, by, 0);
    ctx.strokeStyle = "rgba(40, 30, 20, .35)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
  }
  ctx.restore();
}

function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
