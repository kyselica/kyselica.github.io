// Tile pyramid, drawn on demand by a pool of workers (tile-worker.js) and cached as ImageBitmaps.
//
// Level z draws 2^z device pixels per screen metre; a tile is TS×TS device pixels. Two layers exist: "base" (the
// illustration) and "lights" (lit windows and street lamps on transparency, added on top at night by atmosphere.js).
// While a tile is missing, a coarser ancestor (or finer descendants, or a stale version from before a style change)
// stands in. The whole world at level PIN_Z (a handful of tiles) is kept for every rotation, so there is always a
// stand-in, however fast the view zooms out or turns.

import { TS, makeRenderer } from "./render.js";

export const ZMIN = -4, ZMAX = 5;
export const PIN_Z = -3;          // the pinned whole-world level: 4096 screen metres a tile, about 0.6 s of work each
const JOB_TIMEOUT = 20000;        // a worker silent this long on one tile is taken for dead (a tile takes ~0.1–3 s)
const FINER = 4;                  // how many levels finer stand-ins are looked for (a 10× zoom-out is 3.3 levels)
const PREFETCH_TIER = 3;          // requests of this tier and up (the ring round the view, other turns' pins) are prefetch:
const PREFETCH_WORKERS = 1;       // at most this many workers draw them at once, so a still map never loads every core

const NO_OPTS = {};
const NZ = ZMAX - ZMIN + 1;
// index of (layer, r, z) in Tiles.levelN, the count of cached tiles per level: stand-in searches skip empty levels
const lvl = (layer, r, z) => ((layer === "base" ? 0 : 1) * 4 + r) * NZ + (z - ZMIN);
const COMPOSE_OPTS = { quality: "high" };

export class Tiles {
  constructor({ dataUrl, dataText, scene, mobile, onTile }) {
    this.dataUrl = dataUrl;
    this.dataText = dataText || null;
    this.scene = scene;
    this.mobile = mobile;
    this.onTile = onTile || (() => {});   // (key, shows): shows = it is in (or stands in for) the view last drawn
    this.cache = new Map();      // key → { bmp, ver, used }
    this.inflight = new Map();   // key → ver
    this.failed = new Map();     // key → { n, until }: tiles that threw while drawing, retried after a growing pause
    this.pinned = new Set();     // keys of the whole-world tiles that are never evicted
    this.workers = [];
    this.idle = [];
    this.want = new Map();       // key → { spec, pri }
    this.style = {};
    this.ver = 0;
    this.frame = 0;
    this.max = mobile ? 70 : 160;   // 512² bitmaps are 1 MB each; the cache grows past this only for what is on screen
    this.touched = 0;            // tiles drawn this frame (shown or standing in), and in the last whole frame
    this.touchedPrev = 0;
    this.respawnDelay = 1000;
    this.stats = { rendered: 0, ms: 0, errors: 0, lostWorkers: 0 };
    this.mainRenderer = null;    // fallback when workers can't draw
    this.bias = 0.35;            // pick a slightly coarser level than the screen needs: tiles are crisp anyway
    this.gens = { base: 0, lights: 0 };   // bumped when a tile that shows in the view arrives (cached pictures are stale)
    this.levelN = new Int32Array(2 * 4 * NZ);   // cached tiles per (layer, rotation, level)
    this.dirty = [];             // screen-metre boxes [X0, Y0, X1, Y1]* of base tiles arrived since the core last looked
    this.dirtyAll = false;
    this.shown = {};             // layer → { r, z, X0, Y0, X1, Y1, missing }: the screen-metre box last drawn, at level z
    this.comp = {};              // layer → composed picture of the view (layers other than base; see draw())
    this._wd = 0;                // the watchdog's timer while any tile is in flight
    this.box = [0, 0, 0, 0];     // device-px box of the tile rectangles the last drawTiles covered
    this.still = true;           // set by the core each frame: the view has held still for a moment (f.moving false)
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
      w.job = null;   // { key, ver, t } while a tile is being drawn
      let ready = false;
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === "ready") { ready = true; this.workers.push(w); this.idle.push(w); ok(); this.pump(); }
        else if (m.type === "tile") this.receive(w, m.id, m.bitmap, m.ms);
        else if (m.type === "error") {
          if (m.id) this.jobFailed(w, m.id, m.message);
          else if (!ready) { w.terminate(); no(new Error(m.message)); }
        }
      };
      // after start-up these stay live: a worker that dies mid-tile must not leave that tile in flight for ever
      w.onerror = (e) => { if (!ready) { w.terminate(); no(e); } else this.lose(w, (e && e.message) || "error"); };
      w.onmessageerror = () => { if (ready) this.lose(w, "unreadable message"); };
      w.postMessage({ type: "init", url: new URL(this.dataUrl, location.href).href, text: this.dataText });
    });
  }

  /** A worker crashed or hung: drop it, forget its tile (with a pause before that tile is tried again), start another. */
  lose(w, why) {
    if (w.lost) return;
    w.lost = true;
    this.stats.lostWorkers++;
    console.warn(`tile worker lost (${why}); starting another`);
    try { w.terminate(); } catch {}
    this.workers = this.workers.filter((x) => x !== w);
    this.idle = this.idle.filter((x) => x !== w);
    if (w.job) { this.settle(w.job.key, w.job.ver); this.noteFailure(w.job.key, why, false); w.job = null; }
    // replace it, waiting longer each time in a row a replacement fails to start
    setTimeout(() => {
      Promise.race([this.spawn(), new Promise((_, no) => setTimeout(() => no(new Error("timed out")), 20000))])
        .then(() => { this.respawnDelay = 1000; })
        .catch((e) => {
          this.respawnDelay = Math.min(60000, this.respawnDelay * 2);
          console.warn("tile worker failed to start:", e);
          if (!this.workers.length && !this.mainRenderer) this.mainRenderer = makeRenderer(this.scene);
          this.pump();
        });
    }, this.respawnDelay);
    this.pump();
  }

  /** keep levelN in step with the cache: d = +1 when key is added, -1 when it is dropped */
  countLevel(key, d) {
    const a = key.indexOf("/"), b = key.indexOf("/", a + 1), c = key.indexOf("/", b + 1);
    const z = +key.slice(b + 1, c);
    if (z >= ZMIN && z <= ZMAX) this.levelN[lvl(key.slice(0, a), +key.slice(a + 1, b), z)] += d;
  }

  /** The tile `key` at version `ver` is no longer in flight (if a newer version is, leave that be). */
  settle(key, ver) { if (this.inflight.get(key) === ver) this.inflight.delete(key); }

  /** Remember that `key` failed; it is not asked for again for 1 s, 2 s, 4 s … up to a minute. Logged once per key. */
  noteFailure(key, message, log = true) {
    const f = this.failed.get(key);
    const n = f ? f.n + 1 : 0;
    this.failed.set(key, { n, until: performance.now() + Math.min(60000, 1000 * 2 ** n) });
    if (log && !f) console.error(`tile ${key} failed:`, message);
  }

  jobFailed(w, id, message) {
    const at = id.lastIndexOf("@"), key = id.slice(0, at), ver = +id.slice(at + 1);
    this.stats.errors++;
    this.settle(key, ver);
    this.noteFailure(key, message);
    w.job = null;
    if (!w.lost) this.idle.push(w);
    this.pump();
  }

  receive(w, id, bitmap, ms) {
    const at = id.lastIndexOf("@"), key = id.slice(0, at), ver = +id.slice(at + 1);
    this.settle(key, ver);
    this.failed.delete(key);
    w.job = null;
    if (!w.lost) this.idle.push(w);
    const old = this.cache.get(key);
    if (old && old.ver > ver) { if (bitmap.close) bitmap.close(); }   // a newer version already arrived
    else {
      if (old && old.bmp !== bitmap && old.bmp.close) old.bmp.close();
      if (!old) this.countLevel(key, 1);
      this.cache.set(key, { bmp: bitmap, ver, used: this.frame });
      this.stats.rendered++; this.stats.ms += ms || 0;
      this.evict();
      this.arrived(key);
    }
    this.pump();
  }

  /** A tile is in: if it shows in (or stands in for part of) the view last drawn, bump its layer's generation and say so. */
  arrived(key) {
    const p = key.split("/"), layer = p[0], r = +p[1], z = +p[2], tx = +p[3], ty = +p[4];
    const v = this.shown[layer], k = Math.pow(2, z);
    // (a tile of another level only matters while some tile of the drawn level is missing: it may stand in for it)
    const shows = !!v && v.r === r && (z === v.z || v.missing > 0) &&
      (tx + 1) * TS / k > v.X0 && tx * TS / k < v.X1 && (ty + 1) * TS / k > v.Y0 && ty * TS / k < v.Y1;
    if (shows && layer in this.gens) this.gens[layer]++;
    // the base map the core keeps only needs this tile's own rectangle painted again (whatever it stands in for lies
    // inside it): its box in screen metres, until the core has used them (too many: the core paints everything)
    if (shows && layer === "base") {
      if (this.dirty.length < 64) this.dirty.push(tx * TS / k, ty * TS / k, (tx + 1) * TS / k, (ty + 1) * TS / k);
      else this.dirtyAll = true;
    }
    this.onTile(key, shows);
  }

  /** Call before drawing the base layer (the frame counter ages wishes and orders evictions). */
  beginFrame() {
    this.frame++;
    this.touchedPrev = this.touched;
    this.touched = 0;
    // composed pictures not drawn for a while (the lights by day) give their memory back
    for (const layer in this.comp) {
      const c = this.comp[layer];
      if (c.c && this.frame - c.used > 600) { c.c.width = c.c.height = 0; c.c = null; c.g = null; }
    }
  }

  /** The watchdog, running only while tiles are in flight: a worker that has sat on one tile far too long has hung. */
  watch() {
    if (this._wd) return;
    this._wd = setInterval(() => {
      const now = performance.now();
      let busy = false;
      for (const w of this.workers.slice()) {
        if (!w.job) continue;
        busy = true;
        if (now - w.job.t > JOB_TIMEOUT) this.lose(w, "no answer in " + JOB_TIMEOUT / 1000 + " s");
      }
      if (!busy) { clearInterval(this._wd); this._wd = 0; }
    }, 2000);
  }

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

  /** Tile range [tx0, ty0, tx1, ty1] at scale k covering screen-metre box X0..Y1, cut to the world (with room for tall buildings at the back). */
  range(wb, k, X0, Y0, X1, Y1) {
    return [
      Math.floor((Math.max(X0, wb[0] - 20) * k) / TS), Math.floor((Math.max(Y0, wb[1] - 160) * k) / TS),
      Math.floor((Math.min(X1, wb[2] + 20) * k) / TS), Math.floor((Math.min(Y1, wb[3] + 20) * k) / TS),
    ];
  }

  /** Keys of the whole-world tiles at PIN_Z for rotation r (fixed for the session, so worked out once). */
  pinKeys(r) {
    const memo = this._pinKeys || (this._pinKeys = []);
    if (memo[r]) return memo[r];
    const wb = this.scene.geo.worldScreenBox(r), k = Math.pow(2, PIN_Z);
    const [tx0, ty0, tx1, ty1] = this.range(wb, k, -Infinity, -Infinity, Infinity, Infinity);
    const out = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) out.push([tx, ty, this.key("base", r, PIN_Z, tx, ty)]);
    return (memo[r] = out);
  }

  /** Ask for rotation r's whole-world tiles (tier: how urgent) and keep them. On a phone only the current turn's are kept. */
  requestPins(r, tier, cx, cy) {
    const k = Math.pow(2, PIN_Z);
    for (const [tx, ty, key] of this.pinKeys(r)) {
      this.pinned.add(key);
      const e = this.cache.get(key);
      if (!e) this.request("base", r, PIN_Z, tx, ty, cx, cy, k, tier);
      else if (e.ver !== this.ver && r === this._pinRot) this.request("base", r, PIN_Z, tx, ty, cx, cy, k, 4);
    }
  }

  /**
   * Draw one layer of tiles for the view into ctx (any transform; this sets its own).
   * opts: { alpha, op } for the lights layer; { quality: "high"|"medium"|"low", prefetch } (the core, for the base).
   * Layers other than base are composed once into a picture of the view while it holds still (tiles.still) and
   * that is copied into place: one blit with alpha/op instead of every tile (opts.cache === false: always tile by tile).
   */
  draw(ctx, view, layer = "base", opts = NO_OPTS) {
    if (layer !== "base" && opts.cache !== false && this.still) return this.drawComposed(ctx, view, layer, opts);
    return this.drawTiles(ctx, view, layer, opts);
  }

  drawComposed(ctx, view, layer, opts) {
    const W = Math.round(view.w * view.dpr), H = Math.round(view.h * view.dpr);
    const c = this.comp[layer] || (this.comp[layer] = { c: null, g: null, X: NaN, Y: NaN, s: NaN, rot: -1, W: 0, H: 0, ver: -1, gen: -1, missing: 0, used: 0 });
    c.used = this.frame;
    const gen = this.gens[layer] || 0;
    if (!c.c || c.X !== view.X || c.Y !== view.Y || c.s !== view.s || c.rot !== view.rot || c.W !== W || c.H !== H || c.ver !== this.ver || c.gen !== gen) {
      if (!c.c) c.c = document.createElement("canvas");
      if (c.c.width !== W || c.c.height !== H) { c.c.width = W; c.c.height = H; c.g = null; }
      if (!c.g) c.g = c.c.getContext("2d");
      c.g.setTransform(1, 0, 0, 1, 0, 0);
      c.g.clearRect(0, 0, W, H);
      this._missList = c.missList || (c.missList = []);
      c.missList.length = 0;
      c.missing = this.drawTiles(c.g, view, layer, COMPOSE_OPTS);
      this._missList = null;
      c.X = view.X; c.Y = view.Y; c.s = view.s; c.rot = view.rot; c.W = W; c.H = H; c.ver = this.ver; c.gen = gen;
      // only the part tiles cover is copied back (a composite op costs per pixel, transparent ones too)
      const B = this.box;
      c.x0 = Math.max(0, B[0]); c.y0 = Math.max(0, B[1]); c.x1 = Math.min(W, B[2]); c.y1 = Math.min(H, B[3]);
    }
    else if (c.missing > 0) {
      // The picture is reused while tiles of it are still missing: keep wishing for them, or a wish dropped while the
      // workers were busy (pump forgets wishes after 2 frames) is never made again and the layer stays half drawn
      // until the view moves. Their arrival bumps the layer's generation and the picture is composed again.
      const L = c.missList;
      for (let i = 0; i < L.length; i += 6) {
        const e = this.cache.get(this.key(layer, c.rot, L[i], L[i + 1], L[i + 2]));
        if (!e || e.ver !== this.ver) this.request(layer, c.rot, L[i], L[i + 1], L[i + 2], L[i + 3], L[i + 4], L[i + 5], 0);
      }
      this.pump();
    }
    if (c.x1 > c.x0 && c.y1 > c.y0) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = opts.alpha != null ? opts.alpha : 1;
      ctx.globalCompositeOperation = opts.op || "source-over";
      const w = c.x1 - c.x0, h = c.y1 - c.y0;
      ctx.drawImage(c.c, c.x0, c.y0, w, h, c.x0, c.y0, w, h);
      ctx.restore();
    }
    return c.missing;
  }

  drawTiles(ctx, view, layer, opts) {
    const z = this.levelFor(view);
    const k = Math.pow(2, z);
    const r = view.rot;
    const s = view.s, dpr = view.dpr;
    // visible screen-metre rectangle
    const X0 = view.X - view.w / 2 / s, X1 = view.X + view.w / 2 / s, Y0 = view.Y - view.h / 2 / s, Y1 = view.Y + view.h / 2 / s;
    const [tx0, ty0, tx1, ty1] = this.range(view.worldBox, k, X0, Y0, X1, Y1);
    const sh = this.shown[layer] || (this.shown[layer] = { r: 0, z: 0, X0: 0, Y0: 0, X1: 0, Y1: 0, missing: 0 });
    sh.r = r; sh.z = z; sh.X0 = X0; sh.Y0 = Y0; sh.X1 = X1; sh.Y1 = Y1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // resampling: "high" (mipmaps/bicubic) costs 2–3× "low" (bilinear) on a CPU canvas, and can't be told apart while
    // the map moves; the core asks for high only when it draws the still picture it then keeps
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = opts.quality || (this.still ? "high" : "low");
    if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
    if (opts.op) ctx.globalCompositeOperation = opts.op;
    // tile edges on whole device pixels of a grid fixed to the map (the view's offset rounded, as the core's kept base
    // map is): neighbours meet without a seam, and every layer of tiles lines up with the base map to the pixel
    const offX = Math.round((view.X * s - view.w / 2) * dpr), offY = Math.round((view.Y * s - view.h / 2) * dpr), kd = s * dpr / k;
    const cx = (X0 + X1) / 2, cy = (Y0 + Y1) / 2;
    const maxUp = Math.max(4, z - PIN_Z);   // far enough up to reach the pinned level
    // how many levels finer to look for stand-ins: none past the last level that has any tile cached
    let finer = 0;
    for (let d = 1; d <= FINER && z + d <= ZMAX; d++) if (this.levelN[lvl(layer, r, z + d)]) finer = d;
    let missing = 0, holes = 0;   // holes: tiles with no stand-in at all (bare background shows)
    const box = this.box;         // device px covered by the tiles drawn
    box[0] = box[1] = Infinity; box[2] = box[3] = -Infinity;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const key = this.key(layer, r, z, tx, ty);
      const dx0 = Math.round(tx * TS * kd) - offX, dx1 = Math.round((tx + 1) * TS * kd) - offX;
      const dy0 = Math.round(ty * TS * kd) - offY, dy1 = Math.round((ty + 1) * TS * kd) - offY;
      if (dx0 < box[0]) box[0] = dx0; if (dy0 < box[1]) box[1] = dy0; if (dx1 > box[2]) box[2] = dx1; if (dy1 > box[3]) box[3] = dy1;
      const e = this.cache.get(key);
      if (e) {
        e.used = this.frame; this.touched++;
        ctx.drawImage(e.bmp, dx0, dy0, dx1 - dx0, dy1 - dy0);
        if (e.ver !== this.ver) this.request(layer, r, z, tx, ty, cx, cy, k, 1);
        continue;
      }
      missing++;
      this.request(layer, r, z, tx, ty, cx, cy, k, 0);
      if (this._missList) this._missList.push(z, tx, ty, cx, cy, k);
      // stand-ins: an ancestor's corner (up to the pinned level), else finer tiles, each quarter from the nearest level
      let drawn = false;
      for (let up = 1; up <= maxUp && !drawn && z - up >= ZMIN; up++) {
        if (!this.levelN[lvl(layer, r, z - up)]) continue;
        const f = 1 << up, ptx = Math.floor(tx / f), pty = Math.floor(ty / f);
        const pe = this.cache.get(this.key(layer, r, z - up, ptx, pty));
        if (!pe) continue;
        pe.used = this.frame; this.touched++;
        const sub = TS / f, sx = (tx - ptx * f) * sub, sy = (ty - pty * f) * sub;
        ctx.drawImage(pe.bmp, sx, sy, sub, sub, dx0, dy0, dx1 - dx0, dy1 - dy0);
        drawn = true;
      }
      if (!drawn && !(finer && this.drawFiner(ctx, layer, r, z, tx, ty, dx0, dy0, dx1, dy1, finer))) holes++;
    }
    ctx.restore();
    sh.missing = missing;
    if (layer === "base") this.holes = holes;
    if (layer === "base") {
      // the whole world for this turn, as soon as the screen is filled; on a desktop, the other three turns' too
      if (this._pinRot !== r) {
        this._pinRot = r;
        if (this.mobile) this.pinned.clear();
      }
      // (prefetch only for a still view: while it moves, the workers are busy enough with what is on screen)
      if (!missing && opts.prefetch !== false && this.still) {
        this.requestPins(r, 2, cx, cy);
        // prefetch the ring just outside the view: keep (touch) the ring tiles already cached, so a full cache doesn't
        // evict them and draw them again for ever; fetch new ones only while that fits under the cache's size
        const ring = [];
        for (let ty = ty0 - 1; ty <= ty1 + 1; ty++) for (let tx = tx0 - 1; tx <= tx1 + 1; tx++) {
          if (ty >= ty0 && ty <= ty1 && tx >= tx0 && tx <= tx1) continue;
          const e = this.cache.get(this.key(layer, r, z, tx, ty));
          if (e) { e.used = this.frame; this.touched++; } else ring.push([tx, ty]);
        }
        if (this.cache.size + ring.length <= this.max) for (const [tx, ty] of ring) this.request(layer, r, z, tx, ty, cx, cy, k, 3);
        if (!this.mobile) for (let r2 = 0; r2 < 4; r2++) if (r2 !== r) this.requestPins(r2, 4, cx, cy);
      }
    }
    this.pump();
    return missing;
  }

  /** Fill a missing tile's rectangle from cached finer tiles, each quarter from the first finer level that has it. */
  drawFiner(ctx, layer, r, z, tx, ty, x0, y0, x1, y1, depth) {
    if (z + 1 > ZMAX) return 0;
    const hx = (x0 + x1) / 2, hy = (y0 + y1) / 2;
    let n = 0;   // how many pieces were drawn
    for (let q = 0; q < 4; q++) {
      const cx = tx * 2 + (q & 1), cy = ty * 2 + (q >> 1);
      const ax = q & 1 ? hx : x0, ay = q >> 1 ? hy : y0, bx = q & 1 ? x1 : hx, by = q >> 1 ? y1 : hy;
      const ce = this.levelN[lvl(layer, r, z + 1)] ? this.cache.get(this.key(layer, r, z + 1, cx, cy)) : undefined;
      if (ce) { ce.used = this.frame; this.touched++; ctx.drawImage(ce.bmp, ax, ay, bx - ax, by - ay); n++; }
      else if (depth > 1) n += this.drawFiner(ctx, layer, r, z + 1, cx, cy, ax, ay, bx, by, depth - 1);
    }
    return n;
  }

  key(layer, r, z, tx, ty) { return `${layer}/${r}/${z}/${tx}/${ty}`; }

  request(layer, r, z, tx, ty, cx, cy, k, tier) {
    const key = this.key(layer, r, z, tx, ty);
    if (this.inflight.get(key) === this.ver) return;
    const f = this.failed.get(key);
    if (f && f.until > performance.now()) return;   // it failed a moment ago: wait before trying again
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
      const pre = best.pri >= PREFETCH_TIER * 1e9;
      if (pre) {
        let n = 0;
        for (const w of this.workers) if (w.job && w.job.pre) n++;
        if (n >= PREFETCH_WORKERS) return;   // the rest waits for that one (a tile on screen still goes first)
      }
      this.want.delete(bk);
      const w = this.idle.pop();
      this.inflight.set(bk, this.ver);
      w.job = { key: bk, ver: this.ver, t: performance.now(), pre };
      w.postMessage({ type: "tile", id: bk + "@" + this.ver, ...best.spec, style: this.style });
      this.watch();
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
      try {
        this.mainRenderer.renderTile(c.getContext("2d"), best.spec.r, best.spec.z, best.spec.tx, best.spec.ty, this.style, best.spec.layer);
      } catch (e) {
        this.stats.errors++;
        this.noteFailure(bk, e);
        this.pump();
        return;
      }
      const old = this.cache.get(bk);
      if (!old) this.countLevel(bk, 1);
      this.cache.set(bk, { bmp: c, ver: this.ver, used: this.frame });
      this.failed.delete(bk);
      if (old && old.bmp.close) old.bmp.close();
      this.stats.rendered++; this.stats.ms += performance.now() - t0;
      this.evict();
      this.arrived(bk);
      this.pump();
    }, 0);
  }

  evict() {
    // never below what the last frame needed, so the tiles on screen always fit
    const cap = Math.max(this.max, Math.ceil(Math.max(this.touched, this.touchedPrev) * 1.25));
    if (this.cache.size <= cap) return;
    const items = [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used);
    for (let i = 0; i < items.length && this.cache.size > cap; i++) {
      const [key, e] = items[i];
      if (e.used >= this.frame - 1) break;
      if (this.pinned.has(key)) continue;
      if (e.bmp.close) e.bmp.close();
      this.cache.delete(key);
      this.countLevel(key, -1);
    }
  }

  /** Drop everything (e.g. after a rotation the old tiles are useless). */
  clear(layer) {
    for (const [key, e] of this.cache) if (!layer || key.startsWith(layer + "/")) { if (e.bmp.close) e.bmp.close(); this.cache.delete(key); this.countLevel(key, -1); }
  }

  /**
   * True when every tile in view is current: of the base layer, and of each other tiled layer drawn in the last
   * frames (the night lights), unless layers names the ones to check.
   */
  complete(view, layers) {
    const z = this.levelFor(view), k = Math.pow(2, z), s = view.s;
    const X0 = view.X - view.w / 2 / s, X1 = view.X + view.w / 2 / s, Y0 = view.Y - view.h / 2 / s, Y1 = view.Y + view.h / 2 / s;
    const [tx0, ty0, tx1, ty1] = this.range(view.worldBox, k, X0, Y0, X1, Y1);
    if (!layers) {
      layers = ["base"];
      for (const layer in this.comp) { const c = this.comp[layer]; if (c.c && this.frame - c.used <= 2) layers.push(layer); }
    }
    for (const layer of layers) for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const e = this.cache.get(this.key(layer, view.rot, z, tx, ty));
      if (!e || e.ver !== this.ver) return false;
    }
    return true;
  }
}
