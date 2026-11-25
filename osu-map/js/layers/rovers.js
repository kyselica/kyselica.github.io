// Outdoor pickup and handoff points, snapped to the current walk graph at startup.
const STOPS = {
  "Mirror Lake Eatery": [39.997672, -83.014733],
  "Union Market": [39.997927, -83.009366],
  "Curl Market": [40.004076, -83.010923],
  "Thompson Library": [39.999338, -83.014197],
  "Orton Hall": [39.998627, -83.012017],
  "Park-Stradley Hall": [39.996215, -83.010898],
  "Drackett Tower": [40.005319, -83.013552],
};
const TRIPS = [
  ["Mirror Lake Eatery", "Thompson Library"], ["Mirror Lake Eatery", "Park-Stradley Hall"],
  ["Union Market", "Thompson Library"], ["Union Market", "Orton Hall"],
  ["Curl Market", "Thompson Library"], ["Curl Market", "Drackett Tower"],
];

// A* runs once per trip. Save directed links so movement and bridge occlusion use the same geometry as pedestrians.
function sidewalkRoute(net, start, end, passable) {
  if (start < 0 || end < 0 || start === end) return [];
  const cost = new Float64Array(net.N).fill(Infinity), via = new Int32Array(net.N);
  const open = new Map([[start, 0]]);
  cost[start] = 0;
  while (open.size) {
    let node = -1, best = Infinity;
    for (const [candidate, score] of open) if (score < best) { node = candidate; best = score; }
    if (node === end) {
      const links = [];
      while (node !== start) { const link = via[node]; links.push(link); node = net.lFrom[link]; }
      return links.reverse();
    }
    open.delete(node);
    for (let i = net.outStart[node]; i < net.outStart[node + 1]; i++) {
      const link = net.outList[i], edge = link >> 1, next = net.lTo[link];
      const distance = cost[node] + net.eLen[edge];
      if (distance >= cost[next] || !passable(edge)) continue;
      via[next] = link; cost[next] = distance;
      open.set(next, distance + Math.hypot(net.nx[end] - net.nx[next], net.ny[end] - net.ny[next]));
    }
  }
  return [];
}

export function makeRovers(net, geo, passable) {
  const nodes = {};
  for (const [name, point] of Object.entries(STOPS)) {
    const [x, y] = geo.toXY(...point);
    let nearest = -1, best = 20 ** 2;
    for (let n = 0; n < net.N; n++) {
      const d = (net.nx[n] - x) ** 2 + (net.ny[n] - y) ** 2;
      if (d < best && net.outList.subarray(net.outStart[n], net.outStart[n + 1]).some(l => passable(l >> 1))) {
        nearest = n; best = d;
      }
    }
    nodes[name] = nearest;
  }
  const fleet = [];
  for (const [pickup, dropoff] of TRIPS) {
    const links = sidewalkRoute(net, nodes[pickup], nodes[dropoff], passable);
    if (!links.length) continue;
    let length = 0;
    const ends = links.map(l => (length += net.eLen[l >> 1]));
    const route = { pickup, dropoff, links, ends, length };
    const count = Math.max(2, Math.round(length / 120));
    for (let i = 0; i < count; i++) {
      const speed = 1.45 + 0.08 * (fleet.length % 5);  // walking pace, up to about 4 mph
      const legTime = length / speed + 20;             // wait at each end for loading or collection
      const offset = 2 * legTime * (i + 0.18) / count;
      fleet.push({ route, speed, legTime, offset, link: 0, s: 0, x: 0, y: 0, hx: 1, hy: 0, moving: false });
    }
  }
  return fleet;
}

// Distance along the route is analytic, so panning back to a neighbourhood finds the same robots farther along.
export function locateRover(rover, time) {
  const { route, speed, legTime } = rover;
  const phase = (time + rover.offset) % (2 * legTime), returning = phase >= legTime;
  const travelled = (phase % legTime) * speed;
  rover.moving = travelled < route.length;
  const distance = Math.min(travelled, route.length);
  const along = returning ? route.length - distance : distance;
  let lo = 0, hi = route.ends.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (along > route.ends[mid]) lo = mid + 1; else hi = mid;
  }
  rover.link = route.links[lo] ^ Number(returning);
  rover.s = returning ? route.ends[lo] - along : along - (lo ? route.ends[lo - 1] : 0);
}

export function openRoverCard(app, rover) {
  const gallery = "https://alumnimagazine.osu.edu/story/fetch-rover-fetch";
  // A thumbnail of the gallery's own social preview. The full photographs stay with the publisher.
  return app.ui?.card({
    id: "rover", title: "Food delivery robot",
    subtitle: `Simulated route · ${rover.route.pickup} ↔ ${rover.route.dropoff}`, anchor: rover,
    body: `<a class="rover-photo" href="${gallery}" target="_blank" rel="noopener noreferrer"><figure>
      <img src="images/osu-rover-gallery.webp" width="480" height="270" alt="An Avride robot shows heart-shaped eyes on an Ohio State sidewalk.">
      <figcaption>Photo by Jodi Miller for Ohio State Alumni Magazine. © The Ohio State University.</figcaption></figure></a>`,
  });
}

// The six-wheel Avride model in Jodi Miller's OSU photos. Each panel is painted in its own plane,
// so the face display only shows when the front is turned toward the viewer.
export function drawRover(ctx, px, py, size, across, depth, sinTilt, cosTilt) {
  const fx = across, fy = -depth * sinTilt, rx = -depth, ry = -across * sinTilt;
  const nearSide = across > 0 ? -1 : 1, end = depth < 0 ? 1 : -1;
  ctx.save();
  ctx.translate(px, py);
  ctx.scale(size, size);
  function oval(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.ellipse(x, y, w, h, 0, 0, 2 * Math.PI); ctx.fill();
  }
  function panel(x, y, w, h, radius, color) {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); ctx.fill();
  }
  function wheels(side) {
    for (const f of [-0.41, 0, 0.41]) {
      const x = f * fx + side * 0.36 * rx, y = f * fy + side * 0.36 * ry - 0.15 * cosTilt;
      const w = 0.08 + 0.09 * Math.abs(fx);
      oval(x, y, w, 0.16, "#302f30");
      if (size > 9) oval(x, y, w * 0.48, 0.078, "#686867");
    }
  }
  oval(0.06, 0.03, 0.50 + 0.12 * Math.abs(fx), 0.23, "rgba(45,43,42,.22)");
  wheels(-nearSide);
  oval(0, -0.22 * cosTilt, 0.38 + 0.13 * Math.abs(fx), 0.15, "#363638");
  wheels(nearSide);

  // The white cargo box, with a scarlet side light and a dark screen inset at the nose.
  ctx.save();
  ctx.transform(fx, fy, 0, -cosTilt, nearSide * 0.35 * rx, nearSide * 0.35 * ry);
  panel(-0.58, 0.24, 1.16, 0.54, 0.065, "#d5d4ce");
  panel(-0.53, 0.64, 1.03, 0.043, 0.018, "#cb534c");
  ctx.restore();
  ctx.save();
  ctx.transform(rx, ry, 0, -cosTilt, end * 0.58 * fx, end * 0.58 * fy);
  panel(-0.35, 0.24, 0.70, 0.54, 0.065, "#e7e5dd");
  if (end === 1) {
    panel(-0.285, 0.34, 0.57, 0.34, 0.05, "#272b30");
    for (const r of [-0.115, 0.115]) {
      ctx.fillStyle = "#fff5d6";
      ctx.beginPath(); ctx.moveTo(r - 0.064, 0.45); ctx.lineTo(r, 0.565); ctx.lineTo(r + 0.064, 0.45); ctx.fill();
    }
  } else panel(-0.20, 0.57, 0.40, 0.07, 0.035, "#524f4e");
  ctx.restore();
  ctx.save();
  ctx.transform(fx, fy, rx, ry, 0, -0.78 * cosTilt);
  panel(-0.58, -0.35, 1.16, 0.70, 0.07, "#faf8ef");
  panel(-0.50, -0.30, 0.73, 0.60, 0.07, "#e5e2d9");
  ctx.restore();

  const sensorX = 0.33 * fx, sensorY = 0.33 * fy - 0.87 * cosTilt;
  ctx.fillStyle = "#373a3c"; ctx.fillRect(sensorX - 0.09, sensorY, 0.18, 0.09);
  oval(sensorX, sensorY, 0.09, 0.045, "#66696a");
  const mastX = -0.42 * fx + 0.21 * rx, mastY = -0.42 * fy + 0.21 * ry;
  ctx.fillStyle = "#555453"; ctx.fillRect(mastX - 0.018, mastY - 1.52 * cosTilt, 0.036, 0.76 * cosTilt);
  ctx.fillStyle = "#ca302f";
  ctx.beginPath(); ctx.moveTo(mastX - 0.025, mastY - 1.56 * cosTilt);
  ctx.lineTo(mastX + 0.17, mastY - 1.60 * cosTilt); ctx.lineTo(mastX + 0.13, mastY - 1.30 * cosTilt);
  ctx.lineTo(mastX, mastY - 1.24 * cosTilt); ctx.fill();
  ctx.restore();
}
