/* Kyselica Park: everything that moves.
   Each exhibit gets a small actor. An actor may have:
     update(dt, t)        advance its state
     ground(g, t)         paint flat things under everybody (tiles, bugs, shimmer)
     collect(push, t)     hand over standing sprites for depth sorting: push(base, img, x, y) or push(base, drawFn)
     over(g, t)           paint things above everybody (speech bubbles, sparkles) */
(function () {
  'use strict';
  const Park = window.Park;
  const A = Park.art;
  const PAL = A.PAL;
  const TAU = Math.PI * 2;
  const SHADOW = 'rgba(36,28,43,0.2)';

  function create(world) {
    const S = A.S, T = world.T, spots = world.spots;
    const rnd = A.rng(77);
    const actors = [];
    const checks = {};   // facts the tests read back
    const shadow = (g, x, y, rx) => A.ellipse(g, Math.round(x), Math.round(y), rx, Math.max(1, Math.round(rx / 2.6)), SHADOW);
    /* stand a sprite with its feet (bottom centre) at x, y, lifted by `lift` pixels */
    const feet = (push, img, x, y, lift, baseAdj) => push(y + (baseAdj || 0), img, Math.round(x - img.width / 2), Math.round(y - img.height + 1 - (lift || 0)));

    /* ---------- Double Dutch 4s ---------- */
    (function () {
      const c = spots.dd, xL = c.x - 40, xR = c.x + 40, fy = c.y;
      const turnL = S.team[1], turnR = S.team[3], jumpers = [S.erik, S.team[4]];
      const PERIOD = 0.76, R = 15, H0 = 8;
      function rope(g, th, sign, zAxis, color) {
        const cs = Math.cos(th) * sign, sn = Math.sin(th);
        g.fillStyle = color;
        const x0 = xL + 5, x1 = xR - 5, n = x1 - x0;
        for (let i = 0; i <= n; i++) {
          const p = Math.pow(Math.sin((Math.PI * i) / n), 0.7);
          const h = Math.max(0, H0 + R * cs * p), z = zAxis - R * sn * p;
          g.fillRect(x0 + i, Math.round(fy - h + z * 0.5), 1, 1);
        }
      }
      actors.push({
        ground(g) { for (const x of [xL, xR, c.x - 9, c.x + 9]) shadow(g, x, fy, 5); },
        collect(push, t) {
          const th = (t / PERIOD) * TAU, sn = Math.sin(th);
          const fr = sn > 0 ? 0 : 1;
          feet(push, turnL.turnR[fr], xL, fy); feet(push, turnR.turnL[fr], xR, fy);
          // both ropes swing through the same depth, half a turn apart in height
          const depth = -R * sn * 0.5;
          push(fy + depth + 1.6, (g) => rope(g, th, 1, 3, PAL.R));
          push(fy + depth - 1.6, (g) => rope(g, th, -1, -3, PAL.a));
          const hop = Math.max(0, Math.cos(2 * th));
          const act = Math.floor(t / 2.6) % 5;
          const poses = [
            [['down', 3], ['down', 3]], [['handstand', 0], ['down', 3]], [['right', 3], ['left', 3]],
            [['jump', 5], ['handstand', 0]], [['jump', 5], ['jump', 5]],
          ][act];
          jumpers.forEach((j, i) => {
            const [pose, lift] = poses[i];
            const img = Array.isArray(j[pose]) ? j[pose][0] : j[pose];
            feet(push, img, c.x + (i ? 9 : -9), fy, hop * lift);
          });
        },
      });
    })();

    /* ---------- Team Show ---------- */
    (function () {
      const c = spots.show, team = S.team;
      const forms = [
        [[-30, -8], [-10, -8], [10, -8], [30, -8], [-30, 10], [-10, 10], [10, 10], [30, 10]],
        [[0, 16], [-16, 9], [16, 9], [-32, 2], [32, 2], [-48, -5], [48, -5], [0, -10]],
        null, // the ring, computed
        [[-42, 3], [-30, -3], [-18, 3], [-6, -3], [6, 3], [18, -3], [30, 3], [42, -3]],
      ];
      const HOLD = 4.4, MOVE = 1;
      const place = (f, i, t) => {
        if (forms[f]) return forms[f][i];
        const a = (i / 8) * TAU + t * 0.7;
        return [Math.cos(a) * 40, Math.sin(a) * 17 + 2];
      };
      function ownRope(g, x, fy, th, color) {
        const cs = Math.cos(th), sn = Math.sin(th);
        g.fillStyle = color;
        for (let i = 0; i <= 22; i++) {
          const s = i / 22, p = Math.sin(Math.PI * s);
          const h = Math.max(0, 7 + 10 * cs * p), z = -4 * sn * p;
          g.fillRect(Math.round(x - Math.cos(Math.PI * s) * 7), Math.round(fy - h + z), 1, 1);
        }
      }
      actors.push({
        ownRope,
        ground(g, t) {
          const k = Math.floor(t / HOLD) % 4, u = t % HOLD;
          for (let i = 0; i < 8; i++) { const [x, y] = this.pos(i, k, u, t); shadow(g, c.x + x, c.y + y, 5); }
        },
        pos(i, k, u, t) {
          const cur = place(k, i, t);
          if (u >= MOVE) return cur;
          const prev = place((k + 3) % 4, i, t), e = u / MOVE, s = e * e * (3 - 2 * e);
          return [prev[0] + (cur[0] - prev[0]) * s, prev[1] + (cur[1] - prev[1]) * s];
        },
        collect(push, t) {
          const k = Math.floor(t / HOLD) % 4, u = t % HOLD;
          for (let i = 0; i < 8; i++) {
            const [ox, oy] = this.pos(i, k, u, t), x = c.x + ox, y = c.y + oy, m = team[i];
            const color = i % 2 ? '#f5f1e4' : PAL.a;
            if (u < MOVE) {
              // walking to the next formation, rope held low in front
              const prev = place((k + 3) % 4, i, t), cur = place(k, i, t);
              const dir = Math.abs(cur[0] - prev[0]) > Math.abs(cur[1] - prev[1]) ? (cur[0] > prev[0] ? 'right' : 'left') : (cur[1] > prev[1] ? 'down' : 'up');
              feet(push, m[dir][Math.floor(t * 8) % (dir === 'down' || dir === 'up' ? 3 : 2)], x, y);
              push(y + 0.6, (g) => ownRope(g, x, y, Math.PI, color));
              continue;
            }
            if (k === 1 && i % 2 === 0) {
              // double unders: a higher, longer jump and the rope passes under twice while they are in the air
              const ph = ((t + i * 0.05) / 0.9) % 1, air = Math.sin(Math.PI * ph), th = ph * 2 * TAU;
              feet(push, m.rope, x, y, air * 7);
              push(y + (Math.sin(th) < 0 ? 0.6 : -0.6), (g) => ownRope(g, x, y, th, color));
              continue;
            }
            // a canon down the line, everyone together otherwise
            const th = ((t - (k === 3 ? i * 0.09 : 0)) / 0.5) * TAU;
            const air = Math.max(0, -Math.cos(th));
            feet(push, m.rope, x, y, air * air * 3);
            push(y + (Math.sin(th) < 0 ? 0.6 : -0.6), (g) => ownRope(g, x, y, th, color));
          }
        },
      });
    })();
    const ownRope = actors[actors.length - 1].ownRope;

    /* ---------- trophy sparkle and camera flashes in the stands ---------- */
    actors.push({
      over(g, t) {
        const k = Math.floor(t * 3);
        const pts = [[-5, -14], [5, -17], [0, -10], [-6, -8], [6, -11]];
        const [dx, dy] = pts[k % pts.length], x = Math.round(spots.trophy.x + dx), y = Math.round(spots.trophy.y + dy);
        A.rect(g, x - 1, y, 3, 1, PAL.W); A.rect(g, x, y - 1, 1, 3, PAL.W);
        const r = A.rng(Math.floor(t * 5) + 3);
        for (let i = 0; i < 2; i++) {
          if (r() < 0.45) continue;
          const fx = Math.round(spots.crowd.x + 6 + r() * (spots.crowd.w - 12)), fyy = Math.round(spots.crowd.y + 14 + r() * 22);
          A.rect(g, fx - 1, fyy, 3, 1, PAL.W); A.rect(g, fx, fyy - 1, 1, 3, PAL.W);
        }
      },
    });

    /* ---------- fennec foxes ---------- */
    (function () {
      const b = spots.fennec;
      const foxes = [0, 1, 2].map((i) => ({ x: b.x0 + 30 + i * 60, y: b.y0 + 20 + i * 28, tx: 0, ty: 0, wait: 0.5 + i, left: i === 1 }));
      const blockedAt = (x, y) => world.solid[world.at(Math.floor(x / T), Math.floor(y / T))];
      actors.push({
        update(dt) {
          for (const f of foxes) {
            if (f.wait > 0) { f.wait -= dt; if (f.wait <= 0) { do { f.tx = b.x0 + rnd() * (b.x1 - b.x0); f.ty = b.y0 + rnd() * (b.y1 - b.y0); } while (blockedAt(f.tx, f.ty)); } continue; }
            const dx = f.tx - f.x, dy = f.ty - f.y, d = Math.hypot(dx, dy);
            if (d < 1.5) { f.wait = 1 + rnd() * 4; continue; }
            f.x += (dx / d) * 26 * dt; f.y += (dy / d) * 26 * dt; f.left = dx < 0;
          }
        },
        ground(g) { for (const f of foxes) shadow(g, f.x, f.y, 7); },
        collect(push, t) {
          for (const f of foxes) {
            const set = f.left ? S.fennecL : S.fennec;
            feet(push, f.wait > 0 ? set[2] : set[Math.floor(t * 7) % 2], f.x, f.y);
          }
        },
      });
    })();

    /* ---------- pegasus paddock ---------- */
    (function () {
      const e = spots.elite, runner = { x: e.x0, dir: 1 };
      actors.push({
        update(dt) {
          runner.x += runner.dir * 34 * dt;
          if (runner.x > e.x1) runner.dir = -1; else if (runner.x < e.x0) runner.dir = 1;
        },
        lift() {
          let l = 0;
          for (const hx of e.hurdles) { const d = Math.abs(runner.x - hx); if (d < 20) l = Math.max(l, Math.cos((d / 20) * Math.PI / 2) * 15); }
          return l;
        },
        ground(g) { const l = this.lift(); shadow(g, runner.x, e.y, Math.round(11 - l / 4)); shadow(g, e.graze.x, e.graze.y, 11); },
        collect(push, t) {
          const l = this.lift(), set = runner.dir > 0 ? S.pegasusR : S.pegasus;
          const img = set[Math.floor(t * (l > 1 ? 9 : 3)) % 2];
          feet(push, img, runner.x, e.y + (l > 1 ? 0 : Math.floor(t * 6) % 2), l);
          feet(push, S.pegasus[Math.floor(t * 1.2) % 3 === 0 ? 1 : 0], e.graze.x, e.graze.y);
        },
      });
    })();

    /* ---------- NextJump: a speed event, counted by the camera and by a judge ---------- */
    (function () {
      const k = spots.kangaroo, b = spots.board, J = spots.judge;
      const judge = A.person({ hair: '#3a2416', skin: '#e8b98c', shirt: '#f5f1e4', yoke: PAL.R, pants: '#2b2a33', legs: '#2b2a33', shoes: '#241c2b' });
      const JUMP = 0.42, EVENT = 14, REST = 3.5;
      const state = (t) => {
        const c = t % (EVENT + REST), on = c < EVENT;
        return { on, c, count: Math.floor((on ? c : EVENT) / JUMP) };
      };
      const pad3 = (n) => ('00' + n).slice(-3);
      actors.push({
        ground(g) { shadow(g, k.x, k.y, 7); shadow(g, J.x, J.y, 5); },
        collect(push, t) {
          const st = state(t);
          const th = st.on ? (st.c / JUMP) * TAU + Math.PI : Math.PI, air = st.on ? Math.max(0, -Math.cos(th)) : 0;
          feet(push, S.kangaroo[air > 0.2 ? 1 : 0], k.x + 2, k.y, air * air * 4);
          push(k.y + (Math.sin(th) < 0 ? 0.6 : -0.6), (g) => ownRope(g, k.x, k.y - air * air * 2, th, PAL.A));
          feet(push, judge.left[0], J.x, J.y);
          // the scoreboard: the camera's count and the judge's count, side by side
          push(b.y + b.h + 6, (g) => {
            A.rect(g, b.x + 5, b.y + b.h, 2, 6, PAL.K); A.rect(g, b.x + b.w - 7, b.y + b.h, 2, 6, PAL.K);
            A.rect(g, b.x - 1, b.y - 1, b.w + 2, b.h + 2, PAL.k); A.rect(g, b.x, b.y, b.w, b.h, '#1b1720'); A.rect(g, b.x, b.y, b.w, 1, '#4a4354');
            A.text(g, 'AI', b.x + 3, b.y + 3, '#8fe0cf'); A.text(g, pad3(st.count), b.x + b.w - 14, b.y + 3, '#4fd683');
            A.text(g, 'JUDGE', b.x + 3, b.y + 12, '#f6cf94'); A.text(g, pad3(st.count), b.x + b.w - 14, b.y + 12, PAL.y);
            if (!st.on && Math.floor(t * 4) % 2) A.rect(g, b.x + 2, b.y + b.h - 2, b.w - 4, 1, '#4fd683');
          });
        },
        over(g, t) {
          const st = state(t);
          // the recording light on the camera
          if (Math.floor(t * 2) % 2) A.px(g, 56 * T + 14, 22 * T + 0, PAL.R);
          if (!st.on) return;
          // what the model sees: a box around the jumper, and a +1 on every jump
          const x0 = Math.round(k.x - 8), y0 = Math.round(k.y - 26), x1 = Math.round(k.x + 11), y1 = Math.round(k.y + 1), c = '#4fd683';
          for (const [x, y, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) { A.rect(g, Math.min(x, x + dx * 3), y, 4, 1, c); A.rect(g, x, Math.min(y, y + dy * 3), 1, 4, c); }
          const since = st.c % JUMP;
          if (since < 0.3) A.text(g, '+1', x1 + 2, Math.round(y0 - since * 12), '#4fd683');
          // the judge's clicker
          if (since < 0.12) A.px(g, J.x - 5, J.y - 8, PAL.W);
        },
      });
    })();

    /* ---------- bug house ---------- */
    (function () {
      const b = spots.bugs;
      const bugs = [0, 1, 2, 3, 4].map((i) => ({ x: b.x0 + rnd() * (b.x1 - b.x0), y: b.y0 + rnd() * (b.y1 - b.y0), a: rnd() * TAU, img: i % 2 ? S.beetle : S.ladybug, turn: 0 }));
      actors.push({
        update(dt) {
          for (const u of bugs) {
            u.turn -= dt;
            if (u.turn <= 0) { u.a += (rnd() - 0.5) * 2.2; u.turn = 0.4 + rnd() * 1.4; }
            u.x += Math.cos(u.a) * 7 * dt; u.y += Math.sin(u.a) * 5 * dt;
            if (u.x < b.x0 || u.x > b.x1) { u.a = Math.PI - u.a; u.x = Math.max(b.x0, Math.min(b.x1, u.x)); }
            if (u.y < b.y0 || u.y > b.y1) { u.a = -u.a; u.y = Math.max(b.y0, Math.min(b.y1, u.y)); }
          }
        },
        ground(g) {
          for (const u of bugs) {
            g.save(); g.translate(Math.round(u.x), Math.round(u.y)); if (Math.cos(u.a) < 0) g.scale(-1, 1);
            g.drawImage(u.img, -2, -2); g.restore();
          }
        },
      });
    })();

    /* ---------- the heart, and its monitor ---------- */
    (function () {
      const h = spots.heart, m = spots.ecg;
      const wave = [7, 7, 7, 6, 5, 6, 7, 7, 8, 2, 11, 7, 7, 6, 5, 4, 5, 6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7];
      actors.push({
        collect(push, t) {
          const u = t % 1, big = u < 0.1 || (u > 0.22 && u < 0.3);
          const img = S.heart, w = img.width + (big ? 2 : 0), hh = img.height + (big ? 2 : 0);
          push(h.y + 2, (g) => g.drawImage(img, Math.round(h.x - w / 2), Math.round(h.y - 22 - hh / 2 + Math.sin(t * 2) * 1), w, hh));
          push(h.y + 3, S.dome, Math.round(h.x - S.dome.width / 2), Math.round(h.y - 46));
          push(m.y + 40, (g) => {
            const off = Math.floor(t * 16);
            for (let i = 0; i < 26; i++) {
              const y = wave[(i + off) % wave.length];
              A.px(g, m.x + 2 + i, m.y + 2 + y, i > 22 ? '#b6ffd0' : '#4fd683');
            }
          });
        },
      });
    })();

    /* ---------- Small OSU: the buses on the model ---------- */
    (function () {
      const m = spots.mini;
      actors.push({
        collect(push, t) {
          push(35 * T - 1, (g) => {
            const u = (t * 9) % 232, x = u < 116 ? 6 + u : 122 - (u - 116);
            A.rect(g, m.x + Math.round(x) - 1, m.y + 48, 7, 4, PAL.W); A.rect(g, m.x + Math.round(x), m.y + 49, 5, 2, PAL.R);
            const v = (t * 7 + 20) % 84, y = v < 42 ? 13 + v : 55 - (v - 42);
            A.rect(g, m.x + 98, m.y + Math.round(y) - 1, 4, 6, PAL.W); A.rect(g, m.x + 99, m.y + Math.round(y), 2, 4, PAL.R);
          });
        },
      });
    })();

    /* ---------- Make OH/IO: two cars that refuse to crash ---------- */
    (function () {
      const k = spots.track;
      const cars = [{ u: 0.4, v: 1.25, img: S.car[0], brake: 0 }, { u: 2.2, v: 0.95, img: S.car[1], brake: 0 }];
      const pos = (u) => [k.x + k.ax * Math.sin(u), k.y + k.ay * Math.sin(2 * u)];
      const toCross = (u) => Math.PI - (((u % Math.PI) + Math.PI) % Math.PI);
      actors.push({
        update(dt) {
          for (let i = 0; i < 2; i++) {
            const me = cars[i], other = cars[1 - i];
            const mine = toCross(me.u), theirs = toCross(other.u);
            const otherInBox = theirs > Math.PI - 0.2 || theirs < 0.08;
            const yieldNow = mine < 0.62 && mine > 0.12 && (otherInBox || (theirs < mine && theirs < 0.62));
            me.brake += ((yieldNow ? 1 : 0) - me.brake) * Math.min(1, dt * 9);
            me.u += me.v * (1 - 0.94 * me.brake) * dt;
          }
        },
        collect(push) {
          for (const car of cars) {
            const [x, y] = pos(car.u), [x2, y2] = pos(car.u + 0.02);
            const ang = Math.atan2(y2 - y, x2 - x);
            push(y + 3, (g) => {
              g.save(); g.translate(Math.round(x), Math.round(y)); g.rotate(ang);
              g.drawImage(car.img, -Math.round(car.img.width / 2), -Math.round(car.img.height / 2)); g.restore();
              if (car.brake > 0.5) g.drawImage(S.bubbles[1], Math.round(x) - 3, Math.round(y) - 18);
            });
          }
        },
        over(g, t) { if (Math.floor(t * 2) % 2) A.px(g, spots.cam.x + 7, spots.cam.y + 2, PAL.R); },
      });
    })();

    /* ---------- Hack OH/IO: parrots that remember what you told them ---------- */
    (function () {
      const perches = spots.perches;
      const birds = S.parrots.map((set, i) => ({ set, at: i, from: null, to: null, u: 0, left: i % 2 === 0, next: 2 + i * 1.7 }));
      const where = (b) => {
        if (b.to == null) return perches[b.at];
        const p = perches[b.from], q = perches[b.to], s = b.u * b.u * (3 - 2 * b.u);
        return { x: p.x + (q.x - p.x) * s, y: p.y + (q.y - p.y) * s - Math.sin(b.u * Math.PI) * 9 };
      };
      actors.push({
        update(dt) {
          for (const b of birds) {
            if (b.to != null) { b.u += dt / 0.9; if (b.u >= 1) { b.at = b.to; b.to = null; } continue; }
            b.next -= dt;
            if (b.next > 0) continue;
            b.next = 3 + rnd() * 5;
            const taken = new Set(birds.map((o) => (o.to != null ? o.to : o.at)));
            const freeOnes = perches.map((_, i) => i).filter((i) => !taken.has(i));
            if (!freeOnes.length) continue;
            b.from = b.at; b.to = freeOnes[Math.floor(rnd() * freeOnes.length)]; b.u = 0;
            b.left = perches[b.to].x < perches[b.from].x;
          }
        },
        collect(push, t) {
          for (const b of birds) {
            const p = where(b), frames = b.left ? b.set.left : b.set.right;
            const img = b.to != null ? frames[Math.floor(t * 12) % 2] : frames[0];
            push(23 * T + 9, img, Math.round(p.x - img.width / 2), Math.round(p.y - img.height + 2));
          }
        },
        over(g, t) {
          const u = t % 6, who = Math.floor(t / 6) % birds.length;
          const say = (b, bubble) => { if (b.to != null) return; const p = where(b); g.drawImage(bubble, Math.round(p.x - 2), Math.round(p.y - 24)); };
          if (u < 1.6) say(birds[who], S.bubbles[0]);
          else if (u > 2.4 && u < 4.2) say(birds[(who + 1) % birds.length], S.bubbles[u < 3.2 ? 2 : 1]);
          if (u > 1.4 && u < 2.8) A.rect(g, spots.speaker.x - 4, spots.speaker.y + 1, 8, 1, Math.floor(t * 8) % 2 ? '#e9fffb' : PAL.C);
        },
      });
    })();

    /* ---------- Lamp Garden: one solved board, lit bulb by bulb ---------- */
    (function () {
      const L = spots.lamps, N = 4, walls = [[1, 1], [2, 2]], bulbs = [[0, 0], [3, 1], [1, 3]];
      const isWall = (x, y) => walls.some(([a, b]) => a === x && b === y);
      const litBy = (n) => {
        const lit = new Set();
        for (const [bx, by] of bulbs.slice(0, n)) {
          lit.add(bx + ',' + by);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            for (let x = bx + dx, y = by + dy; x >= 0 && y >= 0 && x < N && y < N && !isWall(x, y); x += dx, y += dy) lit.add(x + ',' + y);
          }
        }
        return lit;
      };
      const count = (t) => [0, 1, 2, 3, 3, 3, 3, 0][Math.floor(t / 0.8) % 8];
      actors.push({
        ground(g, t) {
          const n = count(t), lit = litBy(n);
          A.rect(g, L.x - 2, L.y - 2, N * L.cell + 3, N * L.cell + 3, PAL.k);
          for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
            const cxp = L.x + x * L.cell, cyp = L.y + y * L.cell, s = L.cell - 1;
            if (isWall(x, y)) { A.rect(g, cxp, cyp, s, s, '#15111a'); A.rect(g, cxp + 3, cyp + 3, s - 6, s - 6, '#2c2735'); continue; }
            const on = lit.has(x + ',' + y);
            A.rect(g, cxp, cyp, s, s, on ? '#f3d266' : '#4a4855');
            A.rect(g, cxp + 1, cyp + 1, s - 2, s - 2, on ? '#fbe9a2' : '#565362');
          }
        },
        collect(push, t) {
          const n = count(t);
          bulbs.forEach(([x, y], i) => {
            const img = i < n ? S.bulbOn : S.bulb;
            push(L.y + y * L.cell + 12, img, L.x + x * L.cell + 2, L.y + y * L.cell - 1);
          });
        },
      });
    })();

    /* ---------- Plethos: 3x3 level 1 from the game, solved with its shortest solution ----------
       The rule, as in the game: a swipe slides the red head until a wall or the edge stops it. Every numbered tile it
       enters drops by one, and a tile at zero becomes a wall. Clear every tile to solve the level. */
    (function () {
      const P = spots.slide, ROWS = 3, COLS = 3, PITCH = 15, TILE = 13;
      const LEVEL = [1, 0, 0, 2, 2, 2, -1, 1, 2], SOLUTION = 'rdudlrld';   // rows run bottom to top, as in the game's data
      const DIR = { u: [1, 0], d: [-1, 0], l: [0, -1], r: [0, 1] };
      // play the solution once, keeping a frame for every cell the head enters
      const frames = [];
      let cells = LEVEL.slice(), head = [Math.floor(LEVEL.indexOf(-1) / COLS), LEVEL.indexOf(-1) % COLS];
      const open = (r, c) => r >= 0 && c >= 0 && r < ROWS && c < COLS && cells[r * COLS + c] !== 0;
      frames.push({ cells: cells.slice(), head: head.slice(), hold: 0.9 });
      for (const m of SOLUTION) {
        const [dr, dc] = DIR[m];
        while (open(head[0] + dr, head[1] + dc)) {
          head = [head[0] + dr, head[1] + dc];
          const i = head[0] * COLS + head[1];
          if (cells[i] > 0) cells[i] -= 1;
          frames.push({ cells: cells.slice(), head: head.slice(), hold: 0.13 });
        }
        frames[frames.length - 1].hold = 0.42;
      }
      const solved = cells.every((v) => v <= 0);
      frames[frames.length - 1].hold = 2.2;
      frames[frames.length - 1].solved = solved;
      checks.plethosSolved = solved;
      const total = frames.reduce((a, f) => a + f.hold, 0);
      const frameAt = (t) => { let u = t % total; for (const f of frames) { if (u < f.hold) return [f, u]; u -= f.hold; } return [frames[0], 0]; };
      const ACCENT = '#e0533d', INK = '#1d1c1a', SLOT = '#e4dfd5', SURFACE = '#fcfbf8', BG = '#f4f1ea';
      const W = COLS * PITCH + 4, H = ROWS * PITCH + 4;
      actors.push({
        ground(g, t) {
          const [f, u] = frameAt(t);
          A.rect(g, P.x - 1, P.y - 1, W + 2, H + 2, '#cfc8b8'); A.rect(g, P.x, P.y, W, H, BG);
          for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
            const v = f.cells[r * COLS + c], x = P.x + 3 + c * PITCH, y = P.y + 3 + (ROWS - 1 - r) * PITCH;
            const here = f.head[0] === r && f.head[1] === c;
            if (v === 0 || v === -1) {
              A.rect(g, x + 1, y + 1, TILE - 2, TILE - 2, f.solved && u < 0.5 ? '#f6ded6' : SLOT);
              if (v === -1 && !here) { A.rect(g, x + 4, y + 5, 1, 3, '#8f8c86'); A.rect(g, x + 8, y + 5, 1, 3, '#8f8c86'); A.rect(g, x + 5, y + 4, 3, 1, '#8f8c86'); A.rect(g, x + 5, y + 8, 3, 1, '#8f8c86'); }
            } else {
              A.rect(g, x + 1, y + TILE - 1, TILE - 2, 1, '#d6cfbf');
              A.rect(g, x + 1, y, TILE - 2, TILE - 1, SURFACE); A.rect(g, x, y + 1, TILE, TILE - 3, SURFACE);
              A.text(g, String(v), x + 5, y + 4, here ? ACCENT : INK);
            }
            if (here) {
              A.rect(g, x - 1, y, 1, TILE, ACCENT); A.rect(g, x + TILE, y, 1, TILE, ACCENT); A.rect(g, x, y - 1, TILE, 1, ACCENT); A.rect(g, x, y + TILE, TILE, 1, ACCENT);
              if (v <= 0) { A.rect(g, x + 4, y + 4, 5, 5, ACCENT); A.rect(g, x + 5, y + 3, 3, 7, ACCENT); A.rect(g, x + 3, y + 5, 7, 3, ACCENT); }
            }
          }
        },
      });
    })();

    /* ---------- fountain ---------- */
    actors.push({
      collect(push, t) { feet(push, S.fountain[Math.floor(t * 5) % 2], spots.fountain.x, spots.fountain.y); },
    });

    /* ---------- the creek: water, a fire, a frog, a duck, the odd fish ---------- */
    (function () {
      const k = spots.creek, water = [], open = [];
      for (let y = 0; y < world.H; y++) for (let x = 0; x < world.W; x++) {
        if (world.type[world.at(x, y)] !== world.G.WATER) continue;
        water.push([x, y, Math.floor(rnd() * 11), Math.floor(rnd() * 16), Math.floor(rnd() * 5)]);
        if (y < 41) open.push([x, y]);
      }
      const frog = { pad: 0, to: null, u: 0, next: 2 };
      const fish = { x: 0, y: 0, u: 2 };
      const padPos = (i) => ({ x: k.pads[i][0] * T, y: k.pads[i][1] * T });
      actors.push({
        update(dt) {
          if (frog.to != null) { frog.u += dt / 0.5; if (frog.u >= 1) { frog.pad = frog.to; frog.to = null; } }
          else { frog.next -= dt; if (frog.next <= 0) { frog.next = 2.5 + rnd() * 4; frog.to = (frog.pad + 1 + Math.floor(rnd() * (k.pads.length - 1))) % k.pads.length; frog.u = 0; } }
          fish.u += dt;
          if (fish.u > 4.5) { fish.u = 0; const [x, y] = open[Math.floor(rnd() * open.length)]; fish.x = x * T + 8; fish.y = y * T + 9; }
        },
        ground(g, t) {
          const step = Math.floor(t * 3);
          for (const [x, y, ox, oy, ph] of water) {
            const yy = (oy + step) % 16;
            if ((step + ph) % 5 < 3 && yy > 5) A.rect(g, x * T + ox, y * T + yy, 4, 1, '#bfe6f7');
          }
          if (fish.u < 0.9) {
            const ring = Math.round(2 + fish.u * 5);
            for (let a = 0; a < TAU; a += 0.5) A.px(g, Math.round(fish.x + Math.cos(a) * ring), Math.round(fish.y + Math.sin(a) * ring * 0.45), '#dff4fb');
          }
        },
        collect(push, t) {
          feet(push, S.campfire[Math.floor(t * 6) % 2], k.fire.x, k.fire.y);
          const p = padPos(frog.pad);
          let fx = p.x, fyy = p.y, lift = 0;
          if (frog.to != null) { const q = padPos(frog.to); fx = p.x + (q.x - p.x) * frog.u; fyy = p.y + (q.y - p.y) * frog.u; lift = Math.sin(frog.u * Math.PI) * 8; }
          feet(push, S.frog, fx, fyy + 1, lift);
          // a duck paddling up and down the stretch below the bridge
          const d = k.duck, a = t * 0.3, dy = d.y0 + (d.y1 - d.y0) * (0.5 - 0.5 * Math.cos(a)), dx = d.x + Math.sin(a * 2.3) * 3;
          push(dy, (g) => {
            g.save(); g.translate(Math.round(dx), Math.round(dy)); if (Math.cos(a * 2.3) < 0) g.scale(-1, 1);
            g.drawImage(S.duck, -4, -6); g.restore();
            A.rect(g, Math.round(dx) - 5, Math.round(dy) + 1, 10, 1, '#bfe6f7');
          });
          if (fish.u < 0.5) { const img = S.fish; push(fish.y + 2, img, Math.round(fish.x - 3), Math.round(fish.y - 3 - Math.sin((fish.u / 0.5) * Math.PI) * 7)); }
        },
      });
    })();

    /* ---------- Graveshift: Hollow Creek. The dead hunt by light, and they are weak in it. ---------- */
    (function () {
      const Z = spots.grave, gs = S.gs, P = gs.pal;
      const keeper = { x: Z.patrol.x, y: Z.patrol.y, a: 0, cool: 0.6, frame: 0 };
      const LIGHT = 30;
      const dead = [], bolts = [], motes = [];
      const spawn = (z) => {
        // they come up out of the dark, away from the lantern
        let x, y, n = 0;
        do { x = Z.walk.x0 + rnd() * (Z.walk.x1 - Z.walk.x0); y = Z.walk.y0 + rnd() * (Z.walk.y1 - Z.walk.y0); n++; } while (Math.hypot(x - keeper.x, y - keeper.y) < LIGHT + 24 && n < 20);
        Object.assign(z, { x, y, hp: 3, hit: 0, rise: 0.8, step: rnd() * 4, wait: 0 });
      };
      for (let i = 0; i < 5; i++) { const z = {}; spawn(z); z.wait = i * 1.3; dead.push(z); }
      const lamp = () => ({ x: keeper.x + (keeper.left ? -7 : 7), y: keeper.y - 6 });
      actors.push({
        update(dt) {
          // Marlow walks his round
          keeper.a += dt * 0.32;
          const px0 = keeper.x;
          keeper.x = Z.patrol.x + Math.cos(keeper.a) * Z.patrol.rx;
          keeper.y = Z.patrol.y + Math.sin(keeper.a * 2) * Z.patrol.ry;
          keeper.frame += dt * 7; keeper.left = keeper.x < px0;
          const L = lamp();
          for (const z of dead) {
            if (z.wait > 0) { z.wait -= dt; continue; }
            if (z.rise > 0) { z.rise -= dt; continue; }
            if (z.hp <= 0) { z.hit -= dt; if (z.hit <= 0) { spawn(z); z.wait = 1 + rnd() * 2; } continue; }
            const dx = keeper.x - z.x, dy = keeper.y - z.y, d = Math.hypot(dx, dy);
            // slow out in the dark, quicker once they are in the light
            const sp = d < LIGHT ? 11 : 6;
            if (d > 9) { z.x += (dx / d) * sp * dt; z.y += (dy / d) * sp * dt; }
            z.left = dx < 0; z.step += dt * (sp / 3);
            if (z.hit > 0) z.hit -= dt;
          }
          // the crossbow: a bolt at the nearest one in the light
          keeper.cool -= dt;
          if (keeper.cool <= 0) {
            let best = null, bd = LIGHT + 4;
            for (const z of dead) { if (z.wait > 0 || z.rise > 0 || z.hp <= 0) continue; const d = Math.hypot(z.x - L.x, z.y - L.y); if (d < bd) { bd = d; best = z; } }
            if (best) { bolts.push({ x: keeper.x, y: keeper.y - 8, z: best }); keeper.cool = 0.55; } else keeper.cool = 0.15;
          }
          for (let i = bolts.length - 1; i >= 0; i--) {
            const b = bolts[i], tx = b.z.x, ty = b.z.y - 7, dx = tx - b.x, dy = ty - b.y, d = Math.hypot(dx, dy), stepLen = 150 * dt;
            if (d <= stepLen || b.z.hp <= 0) {
              bolts.splice(i, 1);
              if (b.z.hp > 0) {
                b.z.hp -= 1; b.z.hit = 0.12;
                if (b.z.hp <= 0) { b.z.hit = 0.35; for (let m = 0; m < 3; m++) motes.push({ x: b.z.x + (m - 1) * 3, y: b.z.y - 6 - m, life: 0 }); }
              }
              continue;
            }
            b.x += (dx / d) * stepLen; b.y += (dy / d) * stepLen; b.dx = dx / d; b.dy = dy / d;
          }
          // motes of light drift to the lantern and feed it
          for (let i = motes.length - 1; i >= 0; i--) {
            const m = motes[i]; m.life += dt;
            if (m.life < 0.35) { m.y -= dt * 10; continue; }
            const dx = L.x - m.x, dy = L.y - m.y, d = Math.hypot(dx, dy);
            if (d < 3) { motes.splice(i, 1); continue; }
            m.x += (dx / d) * 70 * dt; m.y += (dy / d) * 70 * dt;
          }
        },
        collect(push, t) {
          const kf = gs.marlow[Math.floor(keeper.frame) % 4];
          push(keeper.y, (g) => {
            if (keeper.left) { g.save(); g.translate(Math.round(keeper.x), 0); g.scale(-1, 1); g.drawImage(kf, -8, Math.round(keeper.y - 15)); g.restore(); }
            else g.drawImage(kf, Math.round(keeper.x - 8), Math.round(keeper.y - 15));
          });
          for (const z of dead) {
            if (z.wait > 0) continue;
            const set = z.left ? gs.shamblerL : gs.shambler, img = set[Math.floor(z.step) % 4];
            if (z.rise > 0) {
              // climbing out of the ground
              const show = Math.round(img.height * (1 - z.rise / 0.8));
              push(z.y, (g) => g.drawImage(img, 0, 0, img.width, show, Math.round(z.x - img.width / 2), Math.round(z.y - show + 1), img.width, show));
              continue;
            }
            if (z.hp <= 0) {
              // falls apart into the dark
              if (Math.floor(z.hit * 20) % 2) push(z.y, img, Math.round(z.x - img.width / 2), Math.round(z.y - img.height + 1 + (0.35 - z.hit) * 14));
              continue;
            }
            push(z.y, (g) => {
              g.drawImage(img, Math.round(z.x - img.width / 2), Math.round(z.y - img.height + 1));
              if (z.hit > 0) A.rect(g, Math.round(z.x - 3), Math.round(z.y - 10), 6, 4, P[8]);   // hit flash
            });
          }
          for (const b of bolts) push(b.y + 8, (g) => { A.rect(g, Math.round(b.x), Math.round(b.y), 1, 1, P.v); A.rect(g, Math.round(b.x - (b.dx || 0) * 2), Math.round(b.y - (b.dy || 0) * 2), 1, 1, P.t); });
        },
        over(g, t) {
          // night over the graveyard, with a hole where the lantern shines and smaller ones round the candles
          const w = Z.x1 - Z.x0, h = Z.y1 - Z.y0;
          if (!this.dark || this.dark.width !== w) { this.dark = A.mk(w, h); this.dg = A.cx(this.dark); }
          const dg = this.dg, L = lamp(), flick = Math.floor(t * 6) % 2;
          dg.globalCompositeOperation = 'source-over';
          dg.clearRect(0, 0, w, h);
          // the fence line sits at dusk, the yard inside it at full night
          dg.fillStyle = 'rgba(8, 10, 30, 0.45)'; dg.fillRect(0, 0, w, h);
          dg.fillStyle = 'rgba(8, 10, 30, 0.5)'; dg.fillRect(T - 4, T - 2, w - 2 * T + 8, h - 2 * T + 6);
          dg.fillStyle = 'rgba(5, 6, 15, 0.25)'; dg.fillRect(T, T + 2, w - 2 * T, h - 2 * T - 2);
          dg.globalCompositeOperation = 'destination-out';
          const hole = (x, y, r, a) => { dg.globalAlpha = a; A.disc(dg, Math.round(x - Z.x0), Math.round(y - Z.y0), r, '#000'); };
          hole(L.x, L.y, LIGHT + 6 + flick, 0.35); hole(L.x, L.y, LIGHT + flick, 0.55); hole(L.x, L.y, LIGHT - 8, 1);
          for (const c of Z.candles) { hole(c.x, c.y - 4, 9, 0.4); hole(c.x, c.y - 4, 5, 0.7); }
          hole(Z.pumpkin.x, Z.pumpkin.y - 3, 10, 0.4);
          dg.globalAlpha = 1; dg.globalCompositeOperation = 'source-over';
          g.drawImage(this.dark, Z.x0, Z.y0);
          // warm light from the lantern
          g.globalAlpha = 0.12; A.disc(g, Math.round(L.x), Math.round(L.y), LIGHT - 4, P.o); g.globalAlpha = 1;
          // what glows: candles, the porch pumpkin, the lantern, the eyes of the dead out in the dark
          for (const c of Z.candles) { const img = gs.candle[(flick + Math.round(c.x)) % 2]; g.drawImage(img, Math.round(c.x - 1), Math.round(c.y - img.height + 1)); }
          g.drawImage(gs.pumpkin, Math.round(Z.pumpkin.x - gs.pumpkin.width / 2), Math.round(Z.pumpkin.y - gs.pumpkin.height));
          for (const z of dead) {
            if (z.wait > 0 || z.rise > 0 || z.hp <= 0) continue;
            if (Math.hypot(z.x - L.x, z.y - L.y) < LIGHT - 6) continue;
            const ey = Math.round(z.y - 12);
            const img = (z.left ? gs.shamblerL : gs.shambler)[0];
            const headX = Math.round(z.x - img.width / 2);
            if (z.left) { A.px(g, headX + img.width - 6, ey + 1, P.p); A.px(g, headX + img.width - 8, ey + 1, P.p); }
            else { A.px(g, headX + 5, ey + 1, P.p); A.px(g, headX + 7, ey + 1, P.p); }
          }
          for (const m of motes) { A.px(g, Math.round(m.x), Math.round(m.y), P.e); A.px(g, Math.round(m.x) + 1, Math.round(m.y), P.d); }
          g.drawImage(gs.lantern[flick], Math.round(L.x - 2), Math.round(L.y - 2));
        },
      });
    })();

    /* ---------- butterflies ---------- */
    (function () {
      const homes = [[54, 9], [50, 7], [28, 21], [35, 31], [8, 36], [20, 41], [44, 21], [58, 10], [29, 31]];
      const sets = [S.butterfly, S.butterfly2, S.butterfly3];
      actors.push({
        over(g, t) {
          homes.forEach(([hx, hy], i) => {
            const x = hx * T + Math.sin(t * 0.7 + i * 2.1) * 22 + Math.sin(t * 1.9 + i) * 6;
            const y = hy * T + Math.cos(t * 0.5 + i * 1.3) * 12 + Math.sin(t * 2.3 + i) * 4;
            g.drawImage(sets[i % 3][Math.floor(t * 9 + i) % 2], Math.round(x), Math.round(y));
          });
        },
      });
    })();

    /* ---------- other visitors, strolling the paths ---------- */
    (function () {
      const G = world.G, walk = (x, y) => world.inb(x, y) && !world.solid[world.at(x, y)] && (world.type[world.at(x, y)] === G.PATH || world.type[world.at(x, y)] === G.PLAZA);
      const starts = [[14, 16], [40, 15], [51, 22], [20, 27], [45, 27], [12, 32], [30, 37], [50, 37], [32, 20], [29, 29], [34, 25]];
      const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]], NAMES = ['right', 'left', 'down', 'up'];
      const folk = starts.map(([x, y], i) => ({
        set: A.randomPerson(A.rng(100 + i * 13)), tx: x, ty: y, x: x * T + 8, y: y * T + 10, d: i % 4, nx: x, ny: y,
        speed: 22 + (i % 5) * 4, wait: i * 0.4, off: (i % 3) - 1,
      }));
      const choose = (f) => {
        const opts = [];
        DIRS.forEach(([dx, dy], d) => { if (walk(f.tx + dx, f.ty + dy)) opts.push(d); });
        if (!opts.length) return;
        const back = f.d ^ 1, forward = opts.filter((d) => d !== back);
        let d = forward.length ? forward[Math.floor(rnd() * forward.length)] : back;
        if (forward.indexOf(f.d) >= 0 && rnd() < 0.82) d = f.d;
        f.d = d; f.nx = f.tx + DIRS[d][0]; f.ny = f.ty + DIRS[d][1];
      };
      actors.push({
        update(dt) {
          for (const f of folk) {
            if (f.wait > 0) { f.wait -= dt; continue; }
            const gx = f.nx * T + 8 + f.off * 3, gy = f.ny * T + 10 + f.off * 2, dx = gx - f.x, dy = gy - f.y, d = Math.hypot(dx, dy);
            if (d < 1) { f.tx = f.nx; f.ty = f.ny; if (rnd() < 0.035) f.wait = 1.5 + rnd() * 4; choose(f); continue; }
            f.x += (dx / d) * f.speed * dt; f.y += (dy / d) * f.speed * dt;
          }
        },
        ground(g) { for (const f of folk) shadow(g, f.x, f.y, 4); },
        collect(push, t) {
          for (const f of folk) {
            const frames = f.set[NAMES[f.d]], n = f.d < 2 ? 2 : 3;
            feet(push, f.wait > 0 ? frames[0] : frames[Math.floor(t * 7 + f.speed) % n], f.x, f.y);
          }
        },
      });
    })();

    /* ---------- Erik, at the welcome kiosk ---------- */
    const erik = { x: spots.erik.x, y: spots.erik.y, near: false, face: 'down' };
    actors.push({
      ground(g) { shadow(g, erik.x, erik.y, 5); },
      collect(push, t) {
        const waving = erik.near ? Math.floor(t * 5) % 2 === 0 : t % 6 < 0.9 && Math.floor(t * 6) % 2 === 0;
        feet(push, waving ? S.erik.jump : S.erik[erik.face][0], erik.x, erik.y);
      },
      over(g) { if (erik.near) g.drawImage(S.bubbles[3], Math.round(erik.x - 2), Math.round(erik.y - 30)); },
    });

    return {
      erik, checks,
      update(dt, t) { for (const a of actors) if (a.update) a.update(dt, t); },
      ground(g, t) { for (const a of actors) if (a.ground) a.ground(g, t); },
      collect(push, t) { for (const a of actors) if (a.collect) a.collect(push, t); },
      over(g, t) { for (const a of actors) if (a.over) a.over(g, t); },
    };
  }

  Park.life = { create };
})();
