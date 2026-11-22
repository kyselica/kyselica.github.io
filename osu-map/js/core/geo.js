// Coordinates.
//
//   lat/lon  ──toXY──▶  ground metres (x east, y north, z up) around data.origin
//   ground   ──proj──▶  "screen metres" (X right, Y down) for one of four view rotations: an orthographic camera that looks
//                        down TILT degrees from the horizon. Rotation r looks toward 135° − 90°·r (r=0 looks north-west).
//
// Screen metres are a fixed world-space plane: the view (view.js) maps them to CSS pixels with one scale (px per metre).
// Height only moves a point straight up the screen (by z·cos TILT), so extruding a footprint is a translation.

export function makeGeo(data) {
  const { origin, world } = data;
  const TILT = data.tilt || 30;
  const SIN_T = Math.sin((TILT * Math.PI) / 180), COS_T = Math.cos((TILT * Math.PI) / 180);
  const ROTS = [0, 1, 2, 3].map((r) => {
    const a = ((135 - 90 * r) * Math.PI) / 180;
    return { D: [Math.cos(a), Math.sin(a)], R: [Math.cos(a - Math.PI / 2), Math.sin(a - Math.PI / 2)] };
  });
  const clean = (v) => (Math.abs(v) < 1e-12 ? 0 : v);
  for (const o of ROTS) { o.D = o.D.map(clean); o.R = o.R.map(clean); }

  const geo = {
    TILT, SIN_T, COS_T, ROTS, world, origin,
    /** lat/lon → ground metres [x, y] */
    toXY(lat, lon) { return [(lon - origin.lon) * origin.mLon, (lat - origin.lat) * origin.mLat]; },
    /** ground metres → [lat, lon] */
    toLatLon(x, y) { return [origin.lat + y / origin.mLat, origin.lon + x / origin.mLon]; },
    /** ground (x, y, z) → screen metres [X, Y] for rotation r */
    proj(x, y, z, r) {
      const o = ROTS[r];
      return [x * o.R[0] + y * o.R[1], -((x * o.D[0] + y * o.D[1]) * SIN_T + (z || 0) * COS_T)];
    },
    /** screen metres → ground [x, y] on the plane at height z (default 0) */
    unproj(X, Y, r, z) {
      const o = ROTS[r];
      const u = X, v = (-Y - (z || 0) * COS_T) / SIN_T;
      return [u * o.R[0] + v * o.D[0], u * o.R[1] + v * o.D[1]];
    },
    /** depth of a ground point along the view direction (larger = farther from the viewer) */
    depth(x, y, r) { const o = ROTS[r]; return x * o.D[0] + y * o.D[1]; },
    /** screen-right coordinate of a ground point */
    across(x, y, r) { const o = ROTS[r]; return x * o.R[0] + y * o.R[1]; },
    /** a ground heading in degrees (0 = north, clockwise, as compasses and the bus API use) → screen angle in radians */
    headingToScreen(deg, r) {
      const a = (deg * Math.PI) / 180, dx = Math.sin(a), dy = Math.cos(a);
      const o = ROTS[r];
      return Math.atan2(-(dx * o.D[0] + dy * o.D[1]) * SIN_T, dx * o.R[0] + dy * o.R[1]);
    },
    /** the four corners of the world rectangle, projected (z = 0) */
    worldCorners(r) {
      return [[world.x0, world.y0], [world.x1, world.y0], [world.x1, world.y1], [world.x0, world.y1]].map(([x, y]) => geo.proj(x, y, 0, r));
    },
    /** screen-metre bounding box of the world rectangle */
    worldScreenBox(r) {
      const c = geo.worldCorners(r);
      return [Math.min(...c.map((p) => p[0])), Math.min(...c.map((p) => p[1])), Math.max(...c.map((p) => p[0])), Math.max(...c.map((p) => p[1]))];
    },
  };
  return geo;
}

/** Decode a Google encoded polyline into [[lat, lon], ...] (the bus API's route shapes). */
export function decodePolyline(s, precision = 5) {
  const pts = [], f = Math.pow(10, precision);
  let i = 0, lat = 0, lon = 0;
  while (i < s.length) {
    for (let k = 0; k < 2; k++) {
      let shift = 0, res = 0, b;
      do { b = s.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i < s.length + 1);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    pts.push([lat / f, lon / f]);
  }
  return pts;
}
