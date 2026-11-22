// The camera: where the view is centred (screen metres X, Y), its scale s (CSS px per metre) and rotation (0–3),
// plus every way to move it: drag with a fling, wheel and pinch zoom about the pointer, double-click, keys, fly-tos.

export class View {
  constructor(el, geo) {
    this.el = el;
    this.geo = geo;
    this.X = 0; this.Y = 0; this.s = 1; this.rot = 0;
    this.w = 1; this.h = 1; this.dpr = 1;
    this.minS = 0.1; this.maxS = 16;
    this.vx = 0; this.vy = 0;            // fling velocity, screen metres per second
    this.zoomTarget = null;              // { s, px, py } eased toward by update()
    this.anim = null;                    // fly-to
    this.listeners = {};
    this.pointers = new Map();
    this.worldBox = geo.worldScreenBox(0);
    this.changed = true;
    this.resize();
    this.attach();
  }

  on(name, fn) { (this.listeners[name] || (this.listeners[name] = [])).push(fn); }
  emit(name, e) { for (const fn of this.listeners[name] || []) fn(e); }

  resize() {
    const r = this.el.getBoundingClientRect();
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.changed = true;
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
  }
  panBy(dpx, dpy) { this.set(this.X - dpx / this.s, this.Y - dpy / this.s); }
  zoomAt(px, py, factor) {
    const s1 = Math.max(this.minS, Math.min(this.maxS, this.s * factor));
    const [X, Y] = this.fromScreen(px, py);
    this.X = X - (px - this.w / 2) / s1;
    this.Y = Y - (py - this.h / 2) / s1;
    this.s = s1;
    this.clamp();
    this.changed = true;
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
    if (moved) this.emit("change");
    return moved;
  }

  // ---------------------------------------------------------------- input
  attach() {
    const el = this.el;
    el.style.touchAction = "none";
    let downAt = null, moveTrail = [], pinch = null, lastClick = 0;
    const pos = (e) => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      el.setPointerCapture?.(e.pointerId);
      this.pointers.set(e.pointerId, pos(e));
      this.anim = null; this.zoomTarget = null; this.vx = this.vy = 0;
      if (this.pointers.size === 1) { downAt = { p: pos(e), t: performance.now(), moved: 0 }; moveTrail = [{ p: pos(e), t: performance.now() }]; }
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
        if (downAt) downAt.moved = 999;
      }
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
    const up = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const p = pos(e);
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) pinch = null;
      if (this.pointers.size === 1) {
        // the remaining finger continues as a drag
        const [q] = this.pointers.values();
        moveTrail = [{ p: q, t: performance.now() }];
        return;
      }
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
        }
        this.emit("settle");
      }
      downAt = null;
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
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
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const step = 120;
      if (e.key === "ArrowLeft") this.panBy(step, 0);
      else if (e.key === "ArrowRight") this.panBy(-step, 0);
      else if (e.key === "ArrowUp") this.panBy(0, step);
      else if (e.key === "ArrowDown") this.panBy(0, -step);
      else if (e.key === "+" || e.key === "=") this.zoomTarget = { s: Math.min(this.maxS, this.s * 1.6), px: this.w / 2, py: this.h / 2 };
      else if (e.key === "-" || e.key === "_") this.zoomTarget = { s: Math.max(this.minS, this.s / 1.6), px: this.w / 2, py: this.h / 2 };
      else if (e.key === "q" || e.key === "Q") this.setRotation(this.rot + 1);
      else if (e.key === "e" || e.key === "E") this.setRotation(this.rot - 1);
      else return;
      e.preventDefault();
    });
    window.addEventListener("resize", () => this.resize());
  }
}
