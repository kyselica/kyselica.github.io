// Entry point: start the core, then each feature module in turn. A module that fails is logged and skipped.
import { createApp } from "./core/app.js";

const MODULES = ["./ui/ui.js", "./layers/buses.js", "./layers/atmosphere.js", "./layers/life.js", "./layers/labels.js", "./layers/planes.js", "./layers/events.js"];

const app = await createApp({ canvas: document.getElementById("map") });
for (const path of MODULES) {
  try {
    const mod = await import(path);
    if (mod.init) await mod.init(app);
  } catch (e) {
    console.error(`module ${path} failed:`, e);
  }
}
app.emit("modules-ready", app);
