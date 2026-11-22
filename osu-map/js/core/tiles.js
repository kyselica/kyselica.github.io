// Tile pyramid, drawn on demand by a pool of workers (tile-worker.js) and cached as ImageBitmaps.
//
// Level z draws 2^z device pixels per screen metre; a tile is TS×TS device pixels. Two layers exist: "base" (the
// illustration) and "lights" (lit windows and street lamps on transparency, added on top at night by atmosphere.js).
// While a tile is missing, a coarser ancestor (or finer children, or a stale version from before a style change) stands in.

import { TS, makeRenderer } from "./render.js";

export const ZMIN = -4, ZMAX = 5;

export class Tiles {
  constructor({ dataUrl, dataText, scene, mobile, onTile }) {
    this.dataUrl = dataUrl;
    this.dataText = dataText || null;
    this.scene = scene;
    this.mobile = mobile;
    this.onTile = onTile || (() => {});
    this.cache = new Map();      // key → { bmp, ver, used }
    this.inflight = new Map();   // key → ver
    this.workers = [];
    this.idle = [];
    this.want = new Map();       // key → { spec, pri }
    this.style = {};
    this.ver = 0;
    this.frame = 0;
    this.max = mobile ? 70 : 160;   // 512² bitmaps are 1 MB each
    this.stats = { rendered: 0, ms: 0, errors: 0 };
    this.mainRenderer = null;    // fallback when workers can't draw
    this.bias = 0.35;            // pick a slightly coarser level than the screen needs: tiles are crisp anyway
  }

  async init() {
    const n = Math.max(1, Math.min(this.mobile ? 2 : 4, (navigator.hardwareConcurrency || 4) - 1));
    const supported = typeof OffscreenCanvas !== "undefined" && !!OffscreenCanvas.prototype.transferToImageBitmap;
    if (supported) {
      try {
        await Promise.race([
          Promise.all(Array.from({ length: n }, () => this.spawn())),
          new Promise((_, no) => setTimeout(() => no(new Error("workers timed out")), 20000)),
        ]);
        return;
      } catch (e) {
        console.warn("tile workers unavailable, drawing on the main thread:", e);
        for (const w of this.workers) w.terminate();
        this.workers = []; this.idle = [];
      }
    }
    this.mainRenderer = makeRenderer(this.scene);
  }

  spawn() {
    return new Promise((ok, no) => {
      const w = new Worker(new URL("./tile-worker.js", import.meta.url), { type: "module" });
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === "ready") { this.workers.push(w); this.idle.push(w); ok(); this.pump(); }
        else if (m.type === "tile") this.receive(w, m.id, m.bitmap, m.ms);
        else if (m.type === "error") {
          this.stats.errors++;
          console.error("tile worker:", m.message);
          if (m.id) { this.inflight.delete(m.id.slice(0, m.id.lastIndexOf("@"))); this.idle.push(w); this.pump(); }
          else no(new Error(m.message));
        }
      };
      w.onerror = (e) => no(e);
      w.postMessage({ type: "init", url: new URL(this.dataUrl, location.href).href, text: this.dataText });
    });
  }

  receive(w, id, bitmap, ms) {
    const at = id.lastIndexOf("@"), key = id.slice(0, at), ver = +id.slice(at + 1);
    if (this.inflight.get(key) === ver) this.inflight.delete(key);
    this.idle.push(w);
    const old = this.cache.get(key);
    if (old && old.ver > ver) { if (bitmap.close) bitmap.close(); }   // a newer version already arrived
    else {
      if (old && old.bmp !== bitmap && old.bmp.close) old.bmp.close();
      this.cache.set(key, { bmp: bitmap, ver, used: this.frame });
      this.stats.rendered++; this.stats.ms += ms || 0;
      this.evict();
      this.onTile(key);
    }
    this.pump();
  }

  /** Call once per animation frame, before drawing. */
  beginFrame() { this.frame++; }

  /** Merge into the style tiles are drawn with (season, snow, …); bumps the version so tiles redraw. */
  setStyle(patch) {
    const next = { ...this.style, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.style)) return false;
    this.style = next;
    this.ver++;
    return true;
  }

  levelFor(view) {
    const need = view.s * view.dpr;
    return Math.max(ZMIN, Math.min(ZMAX, Math.ceil(Math.log2(need) - this.bias)));
  }

  /**
   * Draw one layer of tiles for the view into ctx (any transform; this sets its own).
   * opts: { alpha, op } for the lights layer.
   */
  draw(ctx, view, layer = "base", opts = {}) {
    const z = this.levelFor(view);
    const k = Math.pow(2, z);
    const r = view.rot;
    const s = view.s, dpr = view.dpr;
    // visible screen-metre rectangle
    const X0 = view.X - view.w / 2 / s, X1 = view.X + view.w / 2 / s, Y0 = view.Y - view.h / 2 / s, Y1 = view.Y + view.h / 2 / s;
    // clip to the world's screen box (with room for tall buildings at the back edge)
    const wb = view.worldBox;
    const tx0 = Math.floor((Math.max(X0, wb[0] - 20) * k) / TS), tx1 = Math.floor((Math.min(X1, wb[2] + 20) * k) / TS);
    const ty0 = Math.floor((Math.max(Y0, wb[1] - 160) * k) / TS), ty1 = Math.floor((Math.min(Y1, wb[3] + 20) * k) / TS);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
    if (opts.op) ctx.globalCompositeOperation = opts.op;
    const edgeX = (X) => Math.round(((X - view.X) * s + view.w / 2) * dpr);
    const edgeY = (Y) => Math.round(((Y - view.Y) * s + view.h / 2) * dpr);
    const cx = (X0 + X1) / 2, cy = (Y0 + Y1) / 2;
    let missing = 0;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const key = this.key(layer, r, z, tx, ty);
      const dx0 = edgeX((tx * TS) / k), dx1 = edgeX(((tx + 1) * TS) / k), dy0 = edgeY((ty * TS) / k), dy1 = edgeY(((ty + 1) * TS) / k);
      const e = this.cache.get(key);
      if (e) {
        e.used = this.frame;
        ctx.drawImage(e.bmp, dx0, dy0, dx1 - dx0, dy1 - dy0);
        if (e.ver !== this.ver) this.request(layer, r, z, tx, ty, cx, cy, k, 1);
        continue;
      }
      missing++;
      this.request(layer, r, z, tx, ty, cx, cy, k, 0);
      // stand-ins: an ancestor's corner, else the four children
      let drawn = false;
      for (let up = 1; up <= 4 && !drawn; up++) {
        const f = 1 << up, ptx = Math.floor(tx / f), pty = Math.floor(ty / f);
        const pe = this.cache.get(this.key(layer, r, z - up, ptx, pty));
        if (!pe) continue;
        pe.used = this.frame;
        const sub = TS / f, sx = (tx - ptx * f) * sub, sy = (ty - pty * f) * sub;
        ctx.drawImage(pe.bmp, sx, sy, sub, sub, dx0, dy0, dx1 - dx0, dy1 - dy0);
        drawn = true;
      }
      if (!drawn && z + 1 <= ZMAX) {
        for (let q = 0; q < 4; q++) {
          const ce = this.cache.get(this.key(layer, r, z + 1, tx * 2 + (q & 1), ty * 2 + (q >> 1)));
          if (!ce) continue;
          ce.used = this.frame;
          const hx = (dx0 + dx1) / 2, hy = (dy0 + dy1) / 2;
          const ax = q & 1 ? hx : dx0, ay = q >> 1 ? hy : dy0;
          ctx.drawImage(ce.bmp, ax, ay, (q & 1 ? dx1 : hx) - ax, (q >> 1 ? dy1 : hy) - ay);
        }
      }
    }
    ctx.restore();
    // prefetch: the ring just outside the view, at this level
    if (!missing && layer === "base") {
      for (let ty = ty0 - 1; ty <= ty1 + 1; ty++) for (let tx = tx0 - 1; tx <= tx1 + 1; tx++) {
        if (ty >= ty0 && ty <= ty1 && tx >= tx0 && tx <= tx1) continue;
        if (!this.cache.has(this.key(layer, r, z, tx, ty))) this.request(layer, r, z, tx, ty, cx, cy, k, 3);
      }
    }
    this.pump();
    return missing;
  }

  key(layer, r, z, tx, ty) { return `${layer}/${r}/${z}/${tx}/${ty}`; }

  request(layer, r, z, tx, ty, cx, cy, k, tier) {
    const key = this.key(layer, r, z, tx, ty);
    if (this.inflight.get(key) === this.ver) return;
    const mx = ((tx + 0.5) * TS) / k, my = ((ty + 0.5) * TS) / k;
    const pri = tier * 1e9 + (layer === "base" ? 0 : 5e8) + Math.hypot(mx - cx, my - cy) * k;
    const cur = this.want.get(key);
    if (!cur || cur.pri > pri) this.want.set(key, { spec: { layer, r, z, tx, ty }, pri, frame: this.frame });
  }

  pump() {
    // forget wishes from frames long gone
    for (const [key, w] of this.want) if (this.frame - w.frame > 2) this.want.delete(key);
    if (!this.want.size) return;
    if (this.mainRenderer) return this.pumpMain();
    while (this.idle.length && this.want.size) {
      let best = null, bk = null;
      for (const [key, w] of this.want) if (!best || w.pri < best.pri) { best = w; bk = key; }
      this.want.delete(bk);
      const w = this.idle.pop();
      this.inflight.set(bk, this.ver);
      w.postMessage({ type: "tile", id: bk + "@" + this.ver, ...best.spec, style: this.style });
    }
  }

  pumpMain() {
    // no workers: draw one tile per call, on this thread
    if (this._busy) return;
    this._busy = true;
    setTimeout(() => {
      this._busy = false;
      let best = null, bk = null;
      for (const [key, w] of this.want) if (!best || w.pri < best.pri) { best = w; bk = key; }
      if (!best) return;
      this.want.delete(bk);
      const c = document.createElement("canvas");
      c.width = c.height = TS;
      const t0 = performance.now();
      this.mainRenderer.renderTile(c.getContext("2d"), best.spec.r, best.spec.z, best.spec.tx, best.spec.ty, this.style, best.spec.layer);
      const old = this.cache.get(bk);
      this.cache.set(bk, { bmp: c, ver: this.ver, used: this.frame });
      if (old && old.bmp.close) old.bmp.close();
      this.stats.rendered++; this.stats.ms += performance.now() - t0;
      this.evict();
      this.onTile(bk);
      this.pump();
    }, 0);
  }

  evict() {
    if (this.cache.size <= this.max) return;
    const items = [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used);
    for (let i = 0; i < items.length && this.cache.size > this.max; i++) {
      const [key, e] = items[i];
      if (e.used >= this.frame - 1) break;
      if (e.bmp.close) e.bmp.close();
      this.cache.delete(key);
    }
  }

  /** Drop everything (e.g. after a rotation the old tiles are useless). */
  clear(layer) {
    for (const [key, e] of this.cache) if (!layer || key.startsWith(layer + "/")) { if (e.bmp.close) e.bmp.close(); this.cache.delete(key); }
  }

  /** True when every tile of the base layer in view is current. */
  complete(view) {
    const z = this.levelFor(view), k = Math.pow(2, z), s = view.s;
    const X0 = view.X - view.w / 2 / s, X1 = view.X + view.w / 2 / s, Y0 = view.Y - view.h / 2 / s, Y1 = view.Y + view.h / 2 / s;
    const wb = view.worldBox;
    const tx0 = Math.floor((Math.max(X0, wb[0] - 20) * k) / TS), tx1 = Math.floor((Math.min(X1, wb[2] + 20) * k) / TS);
    const ty0 = Math.floor((Math.max(Y0, wb[1] - 160) * k) / TS), ty1 = Math.floor((Math.min(Y1, wb[3] + 20) * k) / TS);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const e = this.cache.get(this.key("base", view.rot, z, tx, ty));
      if (!e || e.ver !== this.ver) return false;
    }
    return true;
  }
}
