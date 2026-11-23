// The campus geometry, projected for one view rotation at a time, with spatial indexes in screen metres.
// Shared by the tile workers (to draw tiles) and the main thread (to pick buildings and to redraw what stands in front of
// a moving bus or car). Nothing here draws.

const CELL = 96;   // grid cell, screen metres

export class Scene {
  constructor(data, geo) {
    this.data = data;
    this.geo = geo;
    const b = data.buildings, t = data.trees, l = data.lamps;
    this.B = b.length; this.T = t.length / 5; this.L = l.length / 2;
    this.N = this.B + this.T + this.L;
    this._rot = [];
  }

  /** object kinds: 0 building, 1 tree, 2 lamp */
  kindOf(i) { return i < this.B ? 0 : i < this.B + this.T ? 1 : 2; }

  /** Projected geometry and indexes for rotation r (built on first use, then cached). */
  forRot(r) {
    if (this._rot[r]) return this._rot[r];
    const { data, geo } = this;
    const { SIN_T, COS_T } = geo;
    const o = geo.ROTS[r];
    const R0 = o.R[0], R1 = o.R[1], D0 = o.D[0], D1 = o.D[1];
    const projRing = (f) => {
      const n = f.length / 2, out = new Float32Array(f.length);
      for (let i = 0; i < n; i++) {
        const x = f[2 * i], y = f[2 * i + 1];
        out[2 * i] = x * R0 + y * R1;
        out[2 * i + 1] = -(x * D0 + y * D1) * SIN_T;
      }
      return out;
    };
    const bbox = (rings, padX = 0, top = 0, bottom = 0) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const f of rings) for (let i = 0; i < f.length; i += 2) {
        if (f[i] < x0) x0 = f[i]; if (f[i] > x1) x1 = f[i];
        if (f[i + 1] < y0) y0 = f[i + 1]; if (f[i + 1] > y1) y1 = f[i + 1];
      }
      return [x0 - padX, y0 - top, x1 + padX, y1 + bottom];
    };
    const S = { r, R: o.R, D: o.D };

    // ground features: projected rings/lines + bbox
    const mk = (list, ringsOf, pad) => list.map((f, i) => {
      const rings = ringsOf(f).map(projRing);
      return { i, rings, bb: bbox(rings, pad(f), pad(f), pad(f)) };
    });
    S.areas = mk(data.areas, (a) => a.p, () => 0);
    S.roads = mk(data.roads, (a) => [a.pts], (a) => a.w);
    S.paths = mk(data.paths, (a) => [a.pts], (a) => a.w);
    S.rails = mk(data.rails, (a) => [a.pts], () => 3);
    S.waterways = mk(data.waterways, (a) => [a.pts], (a) => a.w);
    S.barriers = mk(data.barriers, (a) => [a.pts], () => 2);

    // objects: buildings, trees, lamps
    const N = this.N, B = this.B, T = this.T;
    S.objBB = new Float32Array(N * 4);
    S.objRings = new Array(B);        // building rings projected at z = 0
    S.objV = new Float32Array(N);     // depth of the object's anchor (centroid / base), for front tests
    S.objU = new Float32Array(N);
    S.uv = new Array(B);              // building outer ring as [u, v] pairs
    S.uvRings = new Array(B);         // every ring (outer, then courtyards) as [u, v] pairs, for front tests
    const tr = data.trees, la = data.lamps;
    const toUV = (f) => {
      const uv = new Float32Array(f.length);
      for (let k = 0; k < f.length; k += 2) { uv[k] = f[k] * R0 + f[k + 1] * R1; uv[k + 1] = f[k] * D0 + f[k + 1] * D1; }
      return uv;
    };
    for (let i = 0; i < B; i++) {
      const bd = data.buildings[i];
      if (bd.hidden) { S.objBB.set([1e9, 1e9, -1e9, -1e9], 4 * i); continue; }
      const rings = bd.p.map(projRing);
      S.objRings[i] = rings;
      const bb = bbox([rings[0]], 1, Math.max(bd.h, bd.top || 0) * COS_T + 1, -bd.mh * COS_T + 1);   // top: a landmark's spire/ornament
      S.objBB.set(bb, 4 * i);
      const uvs = bd.p.map(toUV), uv = uvs[0], n = uv.length / 2;
      let su = 0, sv = 0;
      for (let k = 0; k < n; k++) { su += uv[2 * k]; sv += uv[2 * k + 1]; }
      S.uv[i] = uv; S.uvRings[i] = uvs; S.objU[i] = su / n; S.objV[i] = sv / n;
    }
    for (let k = 0; k < T; k++) {
      const i = B + k, x = tr[5 * k], y = tr[5 * k + 1], rad = tr[5 * k + 2], h = tr[5 * k + 3];
      const u = x * R0 + y * R1, v = x * D0 + y * D1, Y = -v * SIN_T;
      S.objU[i] = u; S.objV[i] = v;
      S.objBB.set([u - rad - 0.5, Y - h * COS_T - rad - 0.5, u + rad + 0.5, Y + rad * 0.5 + 0.5], 4 * i);
    }
    for (let k = 0; k < this.L; k++) {
      const i = B + T + k, x = la[2 * k], y = la[2 * k + 1];
      const u = x * R0 + y * R1, v = x * D0 + y * D1, Y = -v * SIN_T;
      S.objU[i] = u; S.objV[i] = v;
      S.objBB.set([u - 1.5, Y - 7 * COS_T - 1.5, u + 1.5, Y + 0.5], 4 * i);
    }
    S.rank = Int32Array.from(data.ranks[r]);

    // grids
    S.grids = {};
    const index = (name, items, bbOf) => {
      const g = new Map();
      items.forEach((it, idx) => {
        const bb = bbOf(it, idx);
        if (!(bb[2] >= bb[0])) return;
        const gx0 = Math.floor(bb[0] / CELL), gx1 = Math.floor(bb[2] / CELL), gy0 = Math.floor(bb[1] / CELL), gy1 = Math.floor(bb[3] / CELL);
        for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
          const k = gx * 65536 + gy;
          let c = g.get(k); if (!c) g.set(k, (c = [])); c.push(idx);
        }
      });
      S.grids[name] = g;
    };
    for (const name of ["areas", "roads", "paths", "rails", "waterways", "barriers"]) index(name, S[name], (it) => it.bb);
    const objIdx = new Array(N);
    for (let i = 0; i < N; i++) objIdx[i] = i;
    index("objects", objIdx, (i) => [S.objBB[4 * i], S.objBB[4 * i + 1], S.objBB[4 * i + 2], S.objBB[4 * i + 3]]);
    S.stamp = { areas: new Uint32Array(S.areas.length), roads: new Uint32Array(S.roads.length), paths: new Uint32Array(S.paths.length), rails: new Uint32Array(S.rails.length), waterways: new Uint32Array(S.waterways.length), barriers: new Uint32Array(S.barriers.length), objects: new Uint32Array(N) };
    S.stampN = 0;
    this._rot[r] = S;
    return S;
  }

  /** Feature indexes of one kind whose screen box meets [X0, Y0, X1, Y1], in data order (objects: in draw order). */
  query(r, name, X0, Y0, X1, Y1) {
    const S = this.forRot(r), g = S.grids[name], st = S.stamp[name];
    const id = ++S.stampN;
    const out = [];
    const gx0 = Math.floor(X0 / CELL), gx1 = Math.floor(X1 / CELL), gy0 = Math.floor(Y0 / CELL), gy1 = Math.floor(Y1 / CELL);
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
      const c = g.get(gx * 65536 + gy);
      if (!c) continue;
      for (const i of c) {
        if (st[i] === id) continue;
        st[i] = id;
        if (name === "objects") {
          const o = 4 * i, b = S.objBB;
          if (b[o + 2] < X0 || b[o] > X1 || b[o + 3] < Y0 || b[o + 1] > Y1) continue;
        } else {
          const bb = S[name][i].bb;
          if (bb[2] < X0 || bb[0] > X1 || bb[3] < Y0 || bb[1] > Y1) continue;
        }
        out.push(i);
      }
    }
    if (name === "objects") out.sort((a, b) => S.rank[a] - S.rank[b]);
    else out.sort((a, b) => a - b);
    return out;
  }

  /** Is object i in front of the ground point (x, y), anywhere across [u - halfW, u + halfW]? */
  inFront(r, i, x, y, halfW = 0) {
    const S = this.forRot(r), o = this.geo.ROTS[r];
    const u = x * o.R[0] + y * o.R[1], v = x * o.D[0] + y * o.D[1];
    const kind = this.kindOf(i);
    if (kind !== 0) {
      const rad = kind === 1 ? this.data.trees[5 * (i - this.B) + 2] : 0.5;
      return S.objV[i] < v - 0.3 && Math.abs(S.objU[i] - u) < rad + halfW;
    }
    const rings = S.uvRings[i];
    if (!rings) return false;
    const bd = this.data.buildings[i], xs = this._xs || (this._xs = []);
    for (const du of halfW > 0 ? [-halfW, 0, halfW] : [0]) {
      const uu = u + du;
      // where the vertical line u = uu crosses the footprint (all rings: an H, a U or a courtyard crosses it 4+ times).
      // Half-open, so a vertex on the line counts once and the crossings pair up into the footprint's spans.
      xs.length = 0;
      for (const uv of rings) {
        const n = uv.length / 2;
        for (let k = 0, j = n - 1; k < n; j = k++) {
          const ua = uv[2 * j], ub = uv[2 * k];
          if ((ua <= uu) !== (ub <= uu)) xs.push(uv[2 * j + 1] + ((uv[2 * k + 1] - uv[2 * j + 1]) * (uu - ua)) / (ub - ua));
        }
      }
      if (!xs.length) continue;
      xs.sort((a, b) => a - b);
      // which span the point is in: on or just behind a span's near wall counts as in it (a door on the camera's side),
      // on its far wall as behind it (a door round the back is hidden by the building)
      let span = -1;
      for (let k = 0; k + 1 < xs.length; k += 2) if (v >= xs[k] - 0.05 && v < xs[k + 1] - 0.05) { span = k; break; }
      if (span > 0) return true;                                 // in a far wing: the near one is in front of it
      if (span === 0) { if (bd.mh > 2.2) return true; continue; }   // under a canopy or a bridge-like part (else indoors)
      if (xs[0] < v) return true;   // part of the footprint (a whole building, or its near wing) is nearer on this line
    }
    return false;
  }

  /** Does building i's footprint (courtyards excluded) contain the ground point (x, y)? E.g. a walker that is indoors. */
  contains(i, x, y) {
    const bd = this.data.buildings[i];
    if (!bd) return false;
    let inside = false;
    for (const f of bd.p) if (pointIn(f, x, y)) inside = !inside;
    return inside;
  }

  /** The front-most building at screen-metre point (X, Y), or -1. */
  pickBuilding(r, X, Y) {
    const S = this.forRot(r), { COS_T } = this.geo;
    const ids = this.query(r, "objects", X - 0.5, Y - 0.5, X + 0.5, Y + 0.5).filter((i) => i < this.B);
    for (let k = ids.length - 1; k >= 0; k--) {
      const i = ids[k], bd = this.data.buildings[i], ring = S.objRings[i][0];
      const top = bd.h * COS_T, bot = bd.mh * COS_T;
      // inside the swept shape between the base and the roof: test the roof, the base, and every wall quad
      if (pointIn(ring, X, Y + top) || pointIn(ring, X, Y + bot)) return i;
      const n = ring.length / 2;
      for (let a = 0, b = n - 1; a < n; b = a++) {
        const x1 = ring[2 * b], y1 = ring[2 * b + 1], x2 = ring[2 * a], y2 = ring[2 * a + 1];
        if (X < Math.min(x1, x2) || X > Math.max(x1, x2)) continue;
        const t = x2 === x1 ? 0.5 : (X - x1) / (x2 - x1);
        const yy = y1 + (y2 - y1) * t;
        if (Y <= yy - bot + 0.01 && Y >= yy - top - 0.01) return i;
      }
    }
    return -1;
  }
}

export function pointIn(f, x, y) {
  let inside = false;
  for (let i = 0, n = f.length, j = n - 2; i < n; j = i, i += 2) {
    const xi = f[i], yi = f[i + 1], xj = f[j], yj = f[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
