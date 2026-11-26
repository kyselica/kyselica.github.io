/* Kyselica Park: the engine.
   Walks the visitor around, keeps the camera on them, and draws the park each frame at a small pixel
   resolution that the browser scales up without smoothing. */
(function () {
  'use strict';
  const Park = window.Park;
  const A = Park.art;

  function start(canvas, hooks) {
    hooks = hooks || {};
    A.build();
    const world = Park.world.build();
    const life = Park.life.create(world);
    const T = world.T, WPX = world.W * T, HPX = world.H * T, S = A.S;
    const g = canvas.getContext('2d');
    const host = canvas.parentElement;
    const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ----- sites: where to stand, what counts as a click on them, where the marker floats ----- */
    const sites = world.sites;
    const tileRect = (x0, y0, x1, y1) => [x0 * T, y0 * T, (x1 + 1) * T, (y1 + 1) * T];
    const extraHits = {
      dd4: [tileRect(19, 1, 31, 13)], teamshow: [tileRect(32, 1, 44, 13)], hollow: [tileRect(53, 29, 62, 36)],
      chess: [tileRect(34, 18, 37, 21)], contact: [tileRect(34, 42, 34, 43)], about: [tileRect(25, 40, 28, 44)], resume: [tileRect(35, 40, 40, 43)],
    };
    const marks = { about: [world.spots.erik.x, world.spots.erik.y - 26], resume: [38 * T, 43 * T + 14 - 68], contact: [34 * T + 8, 43 * T - 6] };
    const order = ['contact', 'about', 'resume'].concat(Object.keys(sites).filter((id) => ['contact', 'about', 'resume'].indexOf(id) < 0));
    for (const id in sites) {
      const s = sites[id];
      s.id = id;
      s.px = { x: s.view[0] * T + 8, y: s.view[1] * T + 10 };
      s.hits = (extraHits[id] || []).slice();
      if (s.rect) s.hits.push(tileRect.apply(null, s.rect));
      if (s.signProp) s.hits.push([s.signProp.x, s.signProp.y, s.signProp.x + s.signProp.img.width, s.signProp.y + s.signProp.img.height]);
      s.mark = marks[id] || [s.signProp.x + s.signProp.img.width / 2, s.signProp.y - 5];
      const f = s.focus || (s.rect ? [(s.rect[0] + s.rect[2] + 1) / 2, (s.rect[1] + s.rect[3] + 1) / 2] : [s.view[0] + 0.5, s.view[1] - 1]);
      s.focusPx = { x: f[0] * T, y: f[1] * T };
    }
    world.solid[world.at(Math.floor(world.spots.erik.x / T), Math.floor(world.spots.erik.y / T))] = 1;

    const marker = A.spr(['yyyyyyy', '.yYyyy.', '..yYy..', '...y...']);
    const pip = A.spr(['.y.', 'yYy', '.y.']);

    /* ----- state ----- */
    const player = { x: world.spots.spawn.x, y: world.spots.spawn.y, dir: 'up', step: 0, moving: false };
    const view = { zoom: 3, bias: 0, w: 0, h: 0, x: 0, y: 0, insetR: 0, insetB: 0, snap: true };
    const keys = new Set();
    let route = null, routeDone = null, goal = null, near = null, focusId = null, hoverId = null;
    let time = 0, lifeTime = 3, last = 0, running = true, ready = false;

    /* ----- sizing: every art pixel is a whole number of device pixels, so the art stays crisp on any screen ----- */
    function resize() {
      const w = host.clientWidth || window.innerWidth, h = host.clientHeight || window.innerHeight;
      const dpr = window.devicePixelRatio || 1;
      const fit = Math.round(Math.min(w / 460, h / 300));
      const css = Math.max(2, Math.min(7, fit + view.bias));
      view.zoom = Math.max(1, Math.round(css * dpr)) / dpr;
      view.w = Math.ceil(w / view.zoom); view.h = Math.ceil(h / view.zoom);
      canvas.width = view.w; canvas.height = view.h;
      canvas.style.width = view.w * view.zoom + 'px'; canvas.style.height = view.h * view.zoom + 'px';
      g.imageSmoothingEnabled = false;
      view.snap = true;
      // resizing a canvas clears it: repaint straight away rather than flash empty until the next frame
      if (ready) { update(0); draw(); }
    }

    /* ----- walking ----- */
    const solidTile = (tx, ty) => !world.inb(tx, ty) || world.solid[world.at(tx, ty)] === 1;
    const solidAt = (x, y) => solidTile(Math.floor(x / T), Math.floor(y / T));
    const blocked = (x, y) => solidAt(x - 4, y - 5) || solidAt(x + 4, y - 5) || solidAt(x - 4, y) || solidAt(x + 4, y);

    function nearestFree(tx, ty) {
      if (!solidTile(tx, ty)) return [tx, ty];
      for (let r = 1; r < 10; r++) {
        let best = null, bd = 1e9;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || solidTile(tx + dx, ty + dy)) continue;
          const d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = [tx + dx, ty + dy]; }
        }
        if (best) return best;
      }
      return null;
    }
    function findPath(sx, sy, tx, ty) {
      const W = world.W, H = world.H, prev = new Int32Array(W * H).fill(-1), queue = [sy * W + sx];
      prev[sy * W + sx] = sy * W + sx;
      const end = ty * W + tx;
      for (let qi = 0; qi < queue.length; qi++) {
        const cur = queue[qi];
        if (cur === end) break;
        const cxn = cur % W, cyn = (cur / W) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cxn + dx, ny = cyn + dy;
          if (solidTile(nx, ny) || prev[ny * W + nx] !== -1) continue;
          if (dx && dy && (solidTile(cxn + dx, cyn) || solidTile(cxn, cyn + dy))) continue;
          prev[ny * W + nx] = cur; queue.push(ny * W + nx);
        }
      }
      if (prev[end] === -1) return null;
      const out = [];
      for (let cur = end; cur !== sy * W + sx; cur = prev[cur]) out.push([cur % W, (cur / W) | 0]);
      return out.reverse();
    }
    function walkTo(tx, ty, done) {
      const target = nearestFree(tx, ty);
      if (!target) return false;
      const sx = Math.floor(player.x / T), sy = Math.floor((player.y - 2) / T);
      const path = findPath(sx, sy, target[0], target[1]);
      if (!path) return false;
      route = path.map(([x, y]) => ({ x: x * T + 8, y: y * T + 10 }));
      routeDone = done || null;
      goal = route.length ? route[route.length - 1] : null;
      if (!route.length) { route = null; if (done) done(); }
      return true;
    }
    function faceSite(s) {
      const tx = s.sign ? s.sign[0] * T + 8 : s.focusPx.x, ty = s.sign ? s.sign[1] * T + 8 : s.focusPx.y;
      const dx = tx - player.x, dy = ty - player.y;
      player.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    }
    function teleport(id) {
      const s = sites[id];
      if (!s) return;
      player.x = s.px.x; player.y = s.px.y; route = null; goal = null; faceSite(s); view.snap = true;
      updateNear();
    }
    function goTo(id, open) {
      const s = sites[id];
      if (!s) return;
      const arrive = () => { faceSite(s); updateNear(); if (open && hooks.onOpen) hooks.onOpen(id); };
      if (Math.hypot(player.x - s.px.x, player.y - s.px.y) < 14) { route = null; goal = null; arrive(); return; }
      if (!walkTo(s.view[0], s.view[1], arrive)) { teleport(id); arrive(); }
    }
    function updateNear() {
      let best = null, bd = 22;
      for (const id in sites) {
        const d = Math.hypot(player.x - sites[id].px.x, player.y - sites[id].px.y);
        if (d < bd) { bd = d; best = id; }
      }
      if (best !== near) { near = best; if (hooks.onNear) hooks.onNear(near); }
    }

    function update(dt) {
      time += dt;
      if (!still) lifeTime += dt;
      const busy = hooks.blocked && hooks.blocked();
      let vx = 0, vy = 0;
      if (!busy) {
        if (keys.has('left')) vx -= 1;
        if (keys.has('right')) vx += 1;
        if (keys.has('up')) vy -= 1;
        if (keys.has('down')) vy += 1;
      }
      const speed = keys.has('run') ? 118 : 78;
      player.moving = false;
      if (vx || vy) {
        route = null; routeDone = null; goal = null;
        const n = Math.hypot(vx, vy), sx = (vx / n) * speed * dt, sy = (vy / n) * speed * dt;
        if (!blocked(player.x + sx, player.y)) player.x += sx;
        if (!blocked(player.x, player.y + sy)) player.y += sy;
        player.dir = Math.abs(vx) >= Math.abs(vy) && vx ? (vx > 0 ? 'right' : 'left') : (vy > 0 ? 'down' : 'up');
        player.moving = true;
      } else if (route) {
        let left = (keys.has('run') ? 150 : 104) * dt;
        while (route && left > 0) {
          const p = route[0], dx = p.x - player.x, dy = p.y - player.y, d = Math.hypot(dx, dy);
          if (d <= left) {
            player.x = p.x; player.y = p.y; left -= d; route.shift();
            if (!route.length) { route = null; goal = null; const done = routeDone; routeDone = null; if (done) done(); }
          } else {
            player.x += (dx / d) * left; player.y += (dy / d) * left;
            player.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
            left = 0;
          }
          player.moving = true;
        }
      }
      player.step = player.moving ? player.step + dt : 0;
      updateNear();
      life.erik.near = near === 'about';
      const ex = player.x - life.erik.x, ey = player.y - life.erik.y;
      life.erik.face = Math.abs(ex) > Math.abs(ey) * 1.4 ? (ex > 0 ? 'right' : 'left') : (ey < 0 ? 'up' : 'down');
      life.update(still ? 0 : dt, lifeTime);

      /* camera: follow the visitor; lean toward the exhibit while its plaque is open */
      const visW = view.w - view.insetR / view.zoom, visH = view.h - view.insetB / view.zoom;
      let tx = player.x, ty = player.y - 10;
      if (focusId && sites[focusId]) { const f = sites[focusId].focusPx; tx = tx * 0.4 + f.x * 0.6; ty = ty * 0.4 + f.y * 0.6; }
      let cxp = tx - visW / 2, cyp = ty - visH / 2;
      cxp = WPX > visW ? Math.max(0, Math.min(WPX - visW, cxp)) : (WPX - visW) / 2;
      cyp = HPX > visH ? Math.max(0, Math.min(HPX - visH, cyp)) : (HPX - visH) / 2;
      if (view.snap || still) { view.x = cxp; view.y = cyp; view.snap = false; }
      else { const k = 1 - Math.exp(-dt * 7); view.x += (cxp - view.x) * k; view.y += (cyp - view.y) * k; }
    }

    /* ----- drawing ----- */
    const items = [];
    const push = (base, a, x, y) => { items.push(typeof a === 'function' ? { base, fn: a } : { base, img: a, x, y }); };
    function draw() {
      const ox = Math.round(view.x), oy = Math.round(view.y);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#86c463'; g.fillRect(0, 0, view.w, view.h);
      g.setTransform(1, 0, 0, 1, -ox, -oy);
      g.drawImage(world.ground, 0, 0);
      life.ground(g, lifeTime);
      A.ellipse(g, Math.round(player.x), Math.round(player.y), 5, 2, 'rgba(36,28,43,0.24)');
      if (goal) {
        const r = 3 + (Math.floor(time * 6) % 3);
        for (let a = 0; a < 6.3; a += 0.4) A.px(g, Math.round(goal.x + Math.cos(a) * r), Math.round(goal.y + Math.sin(a) * r * 0.5), '#ffffff');
      }
      items.length = 0;
      const x1 = ox + view.w, y1 = oy + view.h;
      for (const p of world.props) {
        if (p.x > x1 || p.y > y1 || p.x + p.img.width < ox || p.y + p.img.height < oy) continue;
        items.push(p);
      }
      life.collect(push, lifeTime);
      const frames = S.visitor[player.dir];
      const seq = player.dir === 'up' || player.dir === 'down' ? [1, 0, 2, 0] : [1, 0, 1, 0];
      const img = player.moving ? frames[seq[Math.floor(player.step * 9) % 4]] : frames[0];
      push(player.y, img, Math.round(player.x - img.width / 2), Math.round(player.y - img.height + 1));
      items.sort((a, b) => a.base - b.base);
      for (const it of items) { if (it.fn) it.fn(g); else g.drawImage(it.img, it.x, it.y); }
      life.over(g, lifeTime);
      /* markers: a pip over exhibits not yet read, an arrow over the one in reach */
      const bob = Math.round(Math.sin(time * 5) * 1.5);
      for (const id in sites) {
        const s = sites[id];
        if (id === near) g.drawImage(marker, Math.round(s.mark[0] - marker.width / 2), Math.round(s.mark[1] - marker.height - 1 + bob));
        else if (!(hooks.visited && hooks.visited(id))) g.drawImage(pip, Math.round(s.mark[0] - pip.width / 2), Math.round(s.mark[1] - pip.height + Math.round(Math.sin(time * 2.4 + s.px.x) * 1.2)));
      }
    }
    function frame(now) {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      if (running) { update(dt); draw(); }
      requestAnimationFrame(frame);
    }

    /* ----- input ----- */
    const KEYMAP = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', a: 'left', d: 'right', w: 'up', s: 'down', A: 'left', D: 'right', W: 'up', S: 'down', Shift: 'run' };
    const typing = (e) => { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable); };
    window.addEventListener('keydown', (e) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (hooks.blocked && hooks.blocked()) return;
      const k = KEYMAP[e.key];
      if (k) {
        keys.add(k);
        if (k !== 'run') { e.preventDefault(); if (hooks.onMove) hooks.onMove(); }
        return;
      }
      const onControl = e.target && e.target.closest && e.target.closest('a,button,iframe');
      if ((e.key === 'Enter' || e.key === ' ' || e.key === 'e' || e.key === 'E') && !onControl) {
        if (near && hooks.onOpen) { e.preventDefault(); faceSite(sites[near]); hooks.onOpen(near); }
      }
    });
    window.addEventListener('keyup', (e) => { const k = KEYMAP[e.key]; if (k) keys.delete(k); });
    window.addEventListener('blur', () => keys.clear());

    const toWorld = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) / view.zoom + Math.round(view.x), y: (e.clientY - r.top) / view.zoom + Math.round(view.y) };
    };
    const hit = (p) => {
      for (const id of order) for (const [x0, y0, x1, y1] of sites[id].hits) if (p.x >= x0 && p.x < x1 && p.y >= y0 && p.y < y1) return id;
      return null;
    };
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      const id = hit(toWorld(e));
      if (id !== hoverId) { hoverId = id; canvas.style.cursor = id ? 'pointer' : ''; }
      if (hooks.onHover) hooks.onHover(id, e.clientX, e.clientY);
    });
    canvas.addEventListener('pointerleave', () => { hoverId = null; if (hooks.onHover) hooks.onHover(null); });
    /* two fingers: pinch to zoom the park rather than the page */
    const touches = new Map();
    let pinch = 0, pinched = false;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (touches.size === 1) pinched = false;
      if (touches.size === 2) { const [a, b] = Array.from(touches.values()); pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); pinched = true; }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (touches.size !== 2 || !pinch) return;
      const [a, b] = Array.from(touches.values()), d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (d > pinch * 1.3 || d < pinch / 1.3) { zoomBy(d > pinch ? 1 : -1); pinch = d; if (hooks.onZoom) hooks.onZoom(); }
    });
    const lift = (e) => { touches.delete(e.pointerId); if (touches.size < 2) pinch = 0; };
    canvas.addEventListener('pointerup', lift);
    canvas.addEventListener('pointercancel', lift);
    function zoomBy(d) { view.bias = Math.max(-2, Math.min(3, view.bias + d)); resize(); }

    canvas.addEventListener('click', (e) => {
      if (pinched && e.pointerType !== 'mouse') { pinched = touches.size > 0; return; }
      const p = toWorld(e), id = hit(p);
      if (hooks.onMove) hooks.onMove();
      if (id) goTo(id, true);
      else walkTo(Math.floor(p.x / T), Math.floor(p.y / T));
    });
    window.addEventListener('resize', resize);
    if (window.ResizeObserver) new ResizeObserver(() => { if (Math.ceil(host.clientWidth / view.zoom) !== view.w || Math.ceil(host.clientHeight / view.zoom) !== view.h) resize(); }).observe(host);

    resize();
    ready = true;
    update(0);
    draw();
    requestAnimationFrame((now) => { last = now; requestAnimationFrame(frame); });

    return {
      world, sites, player, life, view,
      goTo, teleport, walkTo,
      near: () => near,
      setFocus(id) { focusId = id; },
      setInset(right, bottom) { view.insetR = right || 0; view.insetB = bottom || 0; },
      zoomBy,
      pause(p) { running = !p; },
      /* the whole park in one picture, for the guide map */
      renderMap(target) {
        const c = A.mk(WPX, HPX), cg = A.cx(c);
        cg.drawImage(world.ground, 0, 0);
        life.ground(cg, lifeTime);
        const all = world.props.slice();
        life.collect((base, a, x, y) => all.push(typeof a === 'function' ? { base, fn: a } : { base, img: a, x, y }), lifeTime);
        all.sort((a, b) => a.base - b.base);
        for (const it of all) { if (it.fn) it.fn(cg); else cg.drawImage(it.img, it.x, it.y); }
        life.over(cg, lifeTime);
        target.width = WPX; target.height = HPX;
        const tg = target.getContext('2d');
        tg.imageSmoothingEnabled = false;
        tg.drawImage(c, 0, 0);
        return { w: WPX, h: HPX };
      },
    };
  }

  Park.start = start;
})();
