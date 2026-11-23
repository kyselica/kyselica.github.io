// The camera: where the view is centred (screen metres X, Y), its scale s (CSS px per metre) and rotation (0–3),
// plus every way to move it: drag with a fling, wheel and pinch zoom about the pointer, double-click, keys, fly-tos.
//
// The map draws on demand (see app.js): anything that moves the view, or starts an animation of it (a fly-to, an eased
// zoom, a fling — also when another module sets view.anim or view.zoomTarget itself), calls this.onWake() so a frame
// is drawn. view.active() says whether the view will still move by itself (the loop keeps drawing at full rate).

// The canvas's backing store is capped at PIXEL_BUDGET × min(devicePixelRatio, 2) device pixels (never below 1 device
// pixel per CSS pixel): a full-screen map on a large retina screen fills far fewer pixels at almost no visible cost
// (tiles are soft illustrations, and text and icons are drawn by the layers at the capped ratio still above 1).
// ?dpr=N forces a ratio (testing).
const PIXEL_BUDGET = 2.5e6;

export class View {
  constructor(el, geo) {
    this.el = el;
    this.geo = geo;
    this.X = 0; this.Y = 0; this.s = 1; this.rot = 0;
    this.w = 1; this.h = 1; this.dpr = 1;
    this.minS = 0.1; this.maxS = 16;
    this.vx = 0; this.vy = 0;            // fling velocity, screen metres per second
    this._zoomTarget = null;             // { s, px, py } eased toward by update()  (accessor: view.zoomTarget)
    this._anim = null;                   // fly-to                                  (accessor: view.anim)
    this.onWake = null;                  // set by the app: called whenever the view needs a frame drawn
    this.moving = false;                 // did the view move in the frame being drawn (set by update())
    this.dprRaw = 1;                     // the screen's devicePixelRatio (this.dpr may be capped below it)
    this.listeners = {};
    this.pointers = new Map();
    this.worldBox = geo.worldScreenBox(0);
    this.changed = true;
    this.resize();
    this.attach();
  }

  on(name, fn) { (this.listeners[name] || (this.listeners[name] = [])).push(fn); }
  emit(name, e) { for (const fn of this.listeners[name] || []) fn(e); }

  // a fly-to or an eased zoom set from anywhere (ui.js sets them too) must wake the frame loop
  get anim() { return this._anim; }
  set anim(a) { this._anim = a; if (a) this.wake(); }
  get zoomTarget() { return this._zoomTarget; }
  set zoomTarget(z) { this._zoomTarget = z; if (z) this.wake(); }
  wake() { if (this.onWake) this.onWake(); }
  /** Will the view still move by itself (fly-to, eased zoom, fling), or has it changed since the last frame? */
  active() { return !!(this._anim || this._zoomTarget || ((this.vx || this.vy) && !this.pointers.size) || this.changed); }

  resize() {
    const r = this.el.getBoundingClientRect();
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
    const raw = Math.min(window.devicePixelRatio || 1, 3);
    this.dprRaw = raw;
    const forced = +new URLSearchParams(location.search).get("dpr");
    if (forced > 0) this.dpr = Math.min(4, forced);
    else {
      // cap the backing store; the ratio is rounded to 1/8 so a resize doesn't wobble it
      const cap = Math.sqrt((PIXEL_BUDGET * Math.min(raw, 2)) / (this.w * this.h));
      this.dpr = raw <= 1 ? raw : Math.max(1, Math.min(raw, Math.floor(cap * 8) / 8));
    }
    this.changed = true;
    this.wake();
  }

  // ---------------------------------------------------------------- conversions
  toScreen(X, Y) { return [(X - this.X) * this.s + this.w / 2, (Y - this.Y) * this.s + this.h / 2]; }
  fromScreen(px, py) { return [(px - this.w / 2) / this.s + this.X, (py - this.h / 2) / this.s + this.Y]; }
  groundToScreen(x, y, z = 0) { const [X, Y] = this.geo.proj(x, y, z, this.rot); return this.toScreen(X, Y); }
  screenToGround(px, py, z = 0) { const [X, Y] = this.fromScreen(px, py); return this.geo.unproj(X, Y, this.rot, z); }
  latLonToScreen(lat, lon, z = 0) { const [x, y] = this.geo.toXY(lat, lon); return this.groundToScreen(x, y, z); }
  screenToLatLon(px, py) { const [x, y] = this.screenToGround(px, py); return this.geo.toLatLon(x, y); }
  /** ground metres shown across the screen width */
  metresAcross() { return this.w / this.s; }
  /** the ground point at the centre of the screen */
  centreGround() { return this.geo.unproj(this.X, this.Y, this.rot); }

  // ---------------------------------------------------------------- moves
  set(X, Y, s) {
    if (X != null) this.X = X;
    if (Y != null) this.Y = Y;
    if (s != null) this.s = Math.max(this.minS, Math.min(this.maxS, s));
    this.clamp();
    this.changed = true;
    this.wake();
  }
  panBy(dpx, dpy) { this.set(this.X - dpx / this.s, this.Y - dpy / this.s); }
  /** An eased zoom by factor f about a CSS pixel (default: the centre), as the wheel and +/- keys do. */
  zoomBy(f, px = this.w / 2, py = this.h / 2) {
    const base = this.zoomTarget ? this.zoomTarget.s : this.s;
    this.anim = null;
    this.zoomTarget = { s: Math.max(this.minS, Math.min(this.maxS, base * f)), px, py };
  }
  zoomAt(px, py, factor) {
    const s1 = Math.max(this.minS, Math.min(this.maxS, this.s * factor));
    const [X, Y] = this.fromScreen(px, py);
    this.X = X - (px - this.w / 2) / s1;
    this.Y = Y - (py - this.h / 2) / s1;
    this.s = s1;
    this.clamp();
    this.changed = true;
    this.wake();
  }
  /** Look at a ground point or lat/lon; m = metres across the screen (or s = scale). */
  flyTo(target, opts = {}) {
    let x, y;
    if (target.lat != null) [x, y] = this.geo.toXY(target.lat, target.lon);
    else { x = target.x; y = target.y; }
    const [X, Y] = this.geo.proj(x, y, target.z || 0, this.rot);
    let s = opts.s != null ? opts.s : opts.m != null ? this.w / opts.m : this.s;
    s = Math.max(this.minS, Math.min(this.maxS, s));
    // a little lower on the screen than centre, when asked (to leave room for a card above)
    const offY = (opts.offsetY || 0) / s;
    const to = { X, Y: Y - offY, s };
    if (opts.instant || matchMedia("(prefers-reduced-motion: reduce)").matches) { this.anim = null; this.set(to.X, to.Y, to.s); return; }
    const from = { X: this.X, Y: this.Y, s: this.s };
    // zoom out a little on the way when the hop is long (van Wijk-lite)
    const dist = Math.hypot(to.X - from.X, to.Y - from.Y) * Math.min(from.s, to.s);
    const dur = opts.duration ?? Math.min(1800, 500 + Math.sqrt(dist) * 14);
    this.anim = { from, to, t0: performance.now(), dur, bump: Math.min(0.75, dist / 4000) };
    this.vx = this.vy = 0; this.zoomTarget = null;
  }
  setRotation(r) {
    r = ((r % 4) + 4) % 4;
    if (r === this.rot) return;
    const [x, y] = this.centreGround();
    this.rot = r;
    this.worldBox = this.geo.worldScreenBox(r);
    const [X, Y] = this.geo.proj(x, y, 0, r);
    this.X = X; this.Y = Y;
    this.anim = null; this.vx = this.vy = 0;
    this.clamp();
    this.changed = true;
    this.wake();
    this.emit("rotate", r);
  }
  clamp() {
    const b = this.worldBox, m = 60;
    this.X = Math.max(b[0] - m, Math.min(b[2] + m, this.X));
    this.Y = Math.max(b[1] - m, Math.min(b[3] + m, this.Y));
  }
  /** fit the whole campus */
  minScaleToFit() { const b = this.worldBox; return Math.min(this.w / (b[2] - b[0]), this.h / (b[3] - b[1] + 120)) * 0.95; }

  /** Advance flings, eased zooms and fly-tos; returns true if anything moved. */
  update(dt) {
    let moved = this.changed;
    this.changed = false;
    const now = performance.now();
    if (this.anim) {
      const a = this.anim;
      const t = Math.min(1, (now - a.t0) / a.dur);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const ls = Math.log(a.from.s) + (Math.log(a.to.s) - Math.log(a.from.s)) * e - a.bump * Math.sin(Math.PI * e);
      this.X = a.from.X + (a.to.X - a.from.X) * e;
      this.Y = a.from.Y + (a.to.Y - a.from.Y) * e;
      this.s = Math.exp(ls);
      if (t >= 1) { this.anim = null; this.emit("settle"); }
      this.clamp();
      moved = true;
    }
    if (this.zoomTarget) {
      const z = this.zoomTarget;
      const f = 1 - Math.exp(-dt * 16);
      const next = Math.exp(Math.log(this.s) + (Math.log(z.s) - Math.log(this.s)) * f);
      this.zoomAt(z.px, z.py, next / this.s);
      if (Math.abs(Math.log(z.s / this.s)) < 0.002) { this.zoomAt(z.px, z.py, z.s / this.s); this.zoomTarget = null; this.emit("settle"); }
      moved = true;
    }
    if (!this.pointers.size && (this.vx || this.vy)) {
      this.X -= this.vx * dt; this.Y -= this.vy * dt;
      const decay = Math.exp(-dt * 4.2);
      this.vx *= decay; this.vy *= decay;
      if (Math.hypot(this.vx, this.vy) * this.s < 8) { this.vx = this.vy = 0; this.emit("settle"); }
      this.clamp();
      moved = true;
    }
    this.moving = moved;
    if (moved) this.emit("change");
    return moved;
  }

  // ---------------------------------------------------------------- input
  attach() {
    const el = this.el;
    el.style.touchAction = "none";
    let downAt = null, moveTrail = [], pinch = null, lastClick = 0;
    const pos = (e) => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    // The pinch baseline (finger distance and midpoint) is taken from whichever two pointers are down whenever exactly two
    // are: when the second lands, and when a third lifts (else the next move compares against fingers that have changed).
    // With three or more down the map holds still.
    const resetPinch = () => {
      if (this.pointers.size !== 2) { pinch = null; return; }
      const [a, b] = [...this.pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    };
    // the one finger left after a pinch carries on as a drag, from where it is now
    const resumeDrag = () => { const [q] = this.pointers.values(); moveTrail = [{ p: q, t: performance.now() }]; };
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      el.setPointerCapture?.(e.pointerId);
      this.pointers.set(e.pointerId, pos(e));
      this.anim = null; this.zoomTarget = null; this.vx = this.vy = 0;
      if (this.pointers.size === 1) { downAt = { p: pos(e), t: performance.now(), moved: 0 }; moveTrail = [{ p: pos(e), t: performance.now() }]; }
      else if (downAt) downAt.moved = 999;   // a second finger: never a tap
      resetPinch();
      el.classList.add("dragging");
    });
    el.addEventListener("pointermove", (e) => {
      const p = pos(e);
      if (!this.pointers.has(e.pointerId)) { this.emit("hover", { px: p[0], py: p[1], e }); return; }
      const prev = this.pointers.get(e.pointerId);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 1) {
        this.panBy(p[0] - prev[0], p[1] - prev[1]);
        if (downAt) downAt.moved += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
        moveTrail.push({ p, t: performance.now() });
        if (moveTrail.length > 8) moveTrail.shift();
      } else if (this.pointers.size === 2 && pinch) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]), c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        this.panBy(c[0] - pinch.c[0], c[1] - pinch.c[1]);
        if (pinch.d > 0) this.zoomAt(c[0], c[1], d / pinch.d);
        pinch = { d, c };
      }
    });
    // A cancelled pointer (the OS took the gesture: an edge swipe, an alert, palm rejection, a lost capture) is forgotten:
    // no tap, no double-tap zoom, no fling.
    const cancel = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      resetPinch();
      if (this.pointers.size === 1) { resumeDrag(); return; }
      if (this.pointers.size) return;
      downAt = null; moveTrail = []; lastClick = 0;
      el.classList.remove("dragging");
      this.emit("settle");
    };
    const up = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const p = pos(e);
      this.pointers.delete(e.pointerId);
      resetPinch();
      if (this.pointers.size === 1) { resumeDrag(); return; }
      if (this.pointers.size) return;   // still two or more fingers down
      el.classList.remove("dragging");
      if (downAt && downAt.moved < 6 && performance.now() - downAt.t < 500) {
        const now = performance.now();
        if (now - lastClick < 320) { this.zoomTarget = { s: Math.min(this.maxS, this.s * 2), px: p[0], py: p[1] }; lastClick = 0; }
        else { lastClick = now; this.emit("click", { px: p[0], py: p[1], e }); }
      } else if (moveTrail.length >= 2) {
        // fling: velocity over the last ~100 ms
        const last = moveTrail[moveTrail.length - 1];
        let first = moveTrail[0];
        for (const m of moveTrail) if (last.t - m.t <= 100) { first = m; break; }
        const dt = (last.t - first.t) / 1000;
        if (dt > 0.008 && performance.now() - last.t < 80) {
          this.vx = (last.p[0] - first.p[0]) / dt / this.s;
          this.vy = (last.p[1] - first.p[1]) / dt / this.s;
          const sp = Math.hypot(this.vx, this.vy) * this.s;
          if (sp > 4000) { this.vx *= 4000 / sp; this.vy *= 4000 / sp; }
          this.wake();
        }
        this.emit("settle");
      }
      downAt = null;
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", cancel);
    // capture lost without a pointerup (pointerup releases capture first, and has already removed the pointer by then)
    el.addEventListener("lostpointercapture", cancel);
    el.addEventListener("pointerleave", (e) => { if (!this.pointers.size) this.emit("hover", { px: -1, py: -1, e }); });
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      const [px, py] = pos(e);
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.6 && e.deltaMode === 0) {
        // two-finger trackpad scroll sideways: pan
        this.panBy(-e.deltaX, -e.deltaY);
        return;
      }
      const f = Math.exp(-dy * (e.ctrlKey ? 0.012 : 0.0022));
      const base = this.zoomTarget ? this.zoomTarget.s : this.s;
      this.zoomTarget = { s: Math.max(this.minS, Math.min(this.maxS, base * f)), px, py };
      this.anim = null;
    }, { passive: false });
    window.addEventListener("keydown", (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      // Map keys only when nothing else wants them: not while typing, and not with focus in a card, a panel or a dialog,
      // where the arrows scroll the card or move between items (and must not drag the map under it as well).
      const t = e.target;
      if (t && t.closest && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable ||
        t.closest(".card, .cards, .panel, [role=dialog], [role=listbox], [role=menu]"))) return;
      const step = 120;
      if (e.key === "ArrowLeft") this.panBy(step, 0);
      else if (e.key === "ArrowRight") this.panBy(-step, 0);
      else if (e.key === "ArrowUp") this.panBy(0, step);
      else if (e.key === "ArrowDown") this.panBy(0, -step);
      else if (e.key === "+" || e.key === "=") this.zoomBy(1.6);
      else if (e.key === "-" || e.key === "_") this.zoomBy(1 / 1.6);
      else if (e.key === "q" || e.key === "Q") this.setRotation(this.rot + 1);
      else if (e.key === "e" || e.key === "E") this.setRotation(this.rot - 1);
      else return;
      e.preventDefault();
    });
    window.addEventListener("resize", () => this.resize());
  }
}
