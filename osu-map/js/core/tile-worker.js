// A tile renderer running off the main thread. Messages:
//   in:  { type: "init", url }                         → loads the campus data
//        { type: "tile", id, r, z, tx, ty, style, layer } → renders one tile
//   out: { type: "ready" } | { type: "tile", id, bitmap, ms } | { type: "error", id, message }
import { makeGeo } from "./geo.js";
import { Scene } from "./scene.js";
import { makeRenderer, TS } from "./render.js";

let renderer = null, canvas = null, ctx = null;
const queue = [];

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") {
    try {
      const data = m.text ? JSON.parse(m.text) : await fetch(m.url).then((r) => r.json());
      const geo = makeGeo(data);
      const scene = new Scene(data, geo);
      renderer = makeRenderer(scene);
      canvas = new OffscreenCanvas(TS, TS);
      ctx = canvas.getContext("2d");
      self.postMessage({ type: "ready" });
      while (queue.length) render(queue.shift());
    } catch (err) {
      self.postMessage({ type: "error", message: String(err && err.stack || err) });
    }
    return;
  }
  if (m.type === "tile") {
    if (!renderer) queue.push(m);
    else render(m);
  }
};

function render(m) {
  const t0 = performance.now();
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, TS, TS);
    renderer.renderTile(ctx, m.r, m.z, m.tx, m.ty, m.style || {}, m.layer || "base");
    const bitmap = canvas.transferToImageBitmap();
    self.postMessage({ type: "tile", id: m.id, bitmap, ms: performance.now() - t0 }, [bitmap]);
  } catch (err) {
    self.postMessage({ type: "error", id: m.id, message: String(err && err.stack || err) });
  }
}
