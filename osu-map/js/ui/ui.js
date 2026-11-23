// The interface: the bar (search, routes, layers, share, about), the map buttons, cards, the status line, toasts, the URL,
// the loading screen and the first-visit glide. Implements app.ui (ARCHITECTURE.md); other modules call it, so every
// method keeps its contract and only gains optional extras.
//
// The shell is static markup in index.html (so the bar paints before the 8 MB of campus data arrive); this module wires it.

const STORE = "smallosu.";
const OVAL = { lat: 39.9995, lon: -83.0148 };
const WALK_M_PER_MIN = 80;            // a relaxed walking pace, straight line
const FT = 3.28084, SQFT = 10.7639;
const MAX_CARDS = 3;
const TZ = "America/New_York";

// Famous places the OSM data leaves unnamed, and the names people actually say.
const LANDMARKS = [
  { n: "Ohio Stadium", aka: ["the shoe", "horseshoe", "stadium", "football"], lat: 40.0017, lon: -83.0197, type: "Stadium", m: 520 },
];
const ALIASES = {
  "rpac": "Recreation & Physical Activity Center",
  "schott": "Schottenstein Center & Value City Arena", "value city arena": "Schottenstein Center & Value City Arena",
  "thompson library": "William Oxley Thompson Memorial Library", "main library": "William Oxley Thompson Memorial Library",
  "the union": "Ohio Union", "student union": "Ohio Union",
  "st john arena": "Saint John Arena",
  "wexner medical center": "University Hospital", "medical center": "University Hospital", "osu hospital": "University Hospital",
  "the james": "James Cancer Hospital and Solove Research Institute",
  "the wex": "Wexner Center for the Arts",
  "the towers": "Morrill Tower",
  "high st": "North High Street", "lane ave": "West Lane Avenue",
  "library": "William Oxley Thompson Memorial Library", "hospital": "University Hospital",
  "arena": "Schottenstein Center & Value City Arena", "gym": "Recreation & Physical Activity Center", "rec center": "Recreation & Physical Activity Center",
};
const TRY = ["Ohio Stadium", "Thompson Library", "The Oval", "Mirror Lake", "High Street", "Ohio Union"];

const KIND_NAMES = {
  yes: "Building", university: "University building", college: "College building", school: "School", dormitory: "Residence hall",
  apartments: "Apartments", house: "House", detached: "House", semidetached_house: "Semi-detached house", terrace: "Row houses",
  residential: "Residential building", garage: "Garage", garages: "Garages", carport: "Carport", parking: "Parking garage",
  commercial: "Commercial building", retail: "Shops", office: "Offices", hotel: "Hotel", hospital: "Hospital", clinic: "Clinic",
  church: "Church", stadium: "Stadium", grandstand: "Grandstand", sports_centre: "Sports centre", greenhouse: "Greenhouse",
  roof: "Canopy", "roof;yes": "Canopy", industrial: "Industrial building", warehouse: "Warehouse", civic: "Civic building",
  government: "Government building", public: "Public building", kindergarten: "Kindergarten", shed: "Shed",
  service: "Service building", construction: "Under construction", pavilion: "Pavilion", storage_tank: "Storage tank",
  bridge: "Bridge", farm_auxiliary: "Farm building",
  // amenities and shops (POIs and building amenities)
  fast_food: "Fast food", ice_cream: "Ice cream", place_of_worship: "Place of worship", bicycle_rental: "Bike share",
  artwork: "Public art", memorial: "Memorial", cafe: "Café", bar: "Bar", pub: "Pub", restaurant: "Restaurant",
  convenience: "Convenience store", supermarket: "Supermarket", pharmacy: "Pharmacy", library: "Library", museum: "Museum",
  theatre: "Theatre", cinema: "Cinema", fuel: "Gas station", bank: "Bank", atm: "ATM", post_office: "Post office",
  fitness_centre: "Gym", sports_hall: "Sports hall", events_venue: "Events venue", music_school: "Music school",
  park: "Park", garden: "Garden", plaza: "Plaza", water: "Lake", pitch: "Sports field", grass: "Lawn", information: "Information",
};

// ------------------------------------------------------------------------------------------------ small helpers
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const icon = (name, cls = "") => `<svg class="ico ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const humanise = (k) => KIND_NAMES[k] || cap(String(k || "building").replace(/[_;]+/g, " ").trim());
const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const motionMQ = matchMedia("(prefers-reduced-motion: reduce)");
const reducedMotion = () => motionMQ.matches;     // read every frame by the map marks, so the query is made once

const store = {
  get(k, d) { try { const v = localStorage.getItem(STORE + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(STORE + k, JSON.stringify(v)); } catch { /* private mode: choices just aren't remembered */ } },
};

/** A colour from an API, only if it is plainly a colour (it ends up inside a style attribute). */
function safeColor(c) {
  if (typeof c !== "string") return null;
  c = c.trim();
  if (/^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c)) return c[0] === "#" ? c : "#" + c;
  if (/^(rgb|hsl)a?\([\d\s.,%/]+\)$/i.test(c)) return c;
  return null;
}
/** ink or white, whichever reads better on a hex background */
function textOn(hex) {
  const m = /^#([0-9a-f]{6})/i.exec(hex || "");
  if (!m) return "#fff";
  const n = parseInt(m[1], 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 165 ? "#2a2622" : "#fff";
}

function ringCentroid(f) {
  let sx = 0, sy = 0;
  const n = f.length / 2;
  for (let i = 0; i < f.length; i += 2) { sx += f[i]; sy += f[i + 1]; }
  return [sx / n, sy / n];
}
function ringArea(f) {
  let a = 0;
  for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) a += (f[j] + f[i]) * (f[j + 1] - f[i + 1]);
  return Math.abs(a / 2);
}
function ringBox(f) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < f.length; i += 2) { const x = f[i], y = f[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}
function inRing(f, x, y) {
  let c = false;
  for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) {
    const xi = f[i], yi = f[i + 1], xj = f[j], yj = f[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/**
 * How well a normalised name answers a normalised query (0 = not at all). A query that ends on a word boundary ("bus" in
 * "bus testing facility") beats one that stops mid-word ("bus" in "busch house"), which is most likely a different word.
 */
function textScore(qn, qt, name) {
  if (!name) return 0;
  if (name === qn) return 100;
  const midWord = (end) => (end < name.length && name[end] !== " " ? 10 : 0);
  if (name.startsWith(qn)) return 86 - Math.min(14, (name.length - qn.length) * 0.25) - midWord(qn.length);
  const at = name.indexOf(" " + qn);
  if (at >= 0) return 72 - Math.min(10, at * 0.25) - Math.min(8, (name.length - qn.length) * 0.12) - midWord(at + 1 + qn.length);
  if (qt.length > 1 && qt.every((t) => name.startsWith(t) || name.includes(" " + t))) return 60 - Math.min(10, name.length * 0.1);
  if (qn.length >= 3 && name.includes(qn)) return 36;
  return 0;
}

// ================================================================================================================
export function init(app) {
  const { view, geo, data } = app;
  const $ = (id) => document.getElementById(id);
  const phoneMQ = matchMedia("(max-width: 640px)");
  const isPhone = () => phoneMQ.matches;
  const body = document.body;

  // a page built without the shell still gets working cards, status and toasts
  const ensure = (id, cls) => $(id) || Object.assign(document.body.appendChild(document.createElement("div")), { id, className: cls });
  const cardsEl = ensure("cards", "cards"), statusEl = ensure("status", "status"), toastsEl = ensure("toasts", "toasts");

  // scratch for ground → screen without allocating in draw loops
  const P = [0, 0];
  const g2s = (x, y, z) => {
    const o = geo.ROTS[view.rot];
    const X = x * o.R[0] + y * o.R[1], Y = -((x * o.D[0] + y * o.D[1]) * geo.SIN_T + (z || 0) * geo.COS_T);
    P[0] = (X - view.X) * view.s + view.w / 2;
    P[1] = (Y - view.Y) * view.s + view.h / 2;
    return P;
  };
  /** fly so ground (x, y) ends up in the open part of the screen (above a bottom sheet on phones) */
  const flyToGround = (x, y, m, opts = {}) => {
    const s = m ? view.w / m : view.s;
    view.flyTo({ x, y, z: opts.z || 0 }, { s, offsetY: isPhone() ? -view.h * 0.2 : 0, duration: opts.duration });
  };

  // ============================================================================================== cards
  const cards = new Map();               // id → handle
  let cardSeq = 0, cardRect = null, cardsDirty = true;

  // Focus. A card opened from the keyboard (Enter on a search result, a route, a nearby stop) takes focus on its title,
  // so it is announced and can be read and closed at once; closing it from the keyboard hands focus back to where the
  // reader came from. Pointer readers are left alone: their focus never jumps.
  let keyAt = -Infinity, focusOrigin = null;
  window.addEventListener("keydown", (e) => { if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) keyAt = performance.now(); }, true);
  document.addEventListener("pointerdown", () => { keyAt = -Infinity; }, true);
  const fromKeyboard = () => performance.now() - keyAt < 1000;
  const canFocus = (el) => !!el && el.isConnected && !el.closest(".closing, [hidden]") && el.getClientRects().length > 0;
  function handBackFocus(h) {
    if (canFocus(h._origin)) { focusQuietly(h._origin); return; }
    const t = topCard();
    if (t) { t.titleEl.focus({ preventScroll: true }); return; }
    focusQuietly(isPhone() ? $("btn-search") : qEl);
  }

  function oldestCard() {
    const els = cardsEl.children;
    for (let i = els.length - 1; i >= 0; i--) { const h = els[i]._handle; if (h && cards.get(h.id) === h) return h; }
    return cards.values().next().value;
  }
  function topCard() {
    for (const el of cardsEl.children) if (!el.classList.contains("closing") && el._handle) return el._handle;
    return null;
  }
  function anchorOf(h) {
    let a = h && h._st.anchor;
    if (typeof a === "function") { try { a = a(); } catch { a = null; } }
    return a && Number.isFinite(a.x) && Number.isFinite(a.y) ? a : null;
  }

  function makeCard(id) {
    const el = document.createElement("section");
    const tid = `card-t-${++cardSeq}`;
    el.className = "card";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-labelledby", tid);
    el.innerHTML = `<div class="card-grip" aria-hidden="true"></div><header class="card-head"><span class="card-chip" hidden></span>` +
      `<div class="card-titles"><h2 class="card-title" id="${tid}" tabindex="-1"></h2><p class="card-sub"></p></div>` +
      `<button class="card-x" type="button" aria-label="Close">${icon("close")}</button></header><div class="card-body"></div>`;
    const titleEl = el.querySelector(".card-title"), subEl = el.querySelector(".card-sub"), chipEl = el.querySelector(".card-chip");
    const bodyEl = el.querySelector(".card-body");
    const st = { title: null, subtitle: null, color: null, body: null, anchor: null, onClose: null };

    const setBody = (b) => {
      if (b == null || b === "") { if (st.body !== "") { bodyEl.replaceChildren(); st.body = ""; } return; }
      if (typeof b === "string") { if (b !== st.body) { bodyEl.innerHTML = b; st.body = b; } return; }
      if (b instanceof Node) {
        if (b.nodeType === 11 && !b.firstChild) return;      // a fragment already spent on an earlier update
        if (!(bodyEl.childNodes.length === 1 && bodyEl.firstChild === b)) bodyEl.replaceChildren(b);
        st.body = b;
        return;
      }
      bodyEl.textContent = String(b); st.body = null;
    };
    // full: card() called again for this id (unspecified fields reset); otherwise update() patches
    const apply = (o, full) => {
      if (full || "title" in o) { const t = o.title == null ? "" : String(o.title); if (t !== st.title) { st.title = t; titleEl.textContent = t; } }
      if (full || "subtitle" in o) { const s = o.subtitle == null ? "" : String(o.subtitle); if (s !== st.subtitle) { st.subtitle = s; subEl.textContent = s; } }
      if (full || "color" in o) {
        const c = safeColor(o.color);
        if (c !== st.color) {
          st.color = c;
          el.classList.toggle("has-color", !!c);
          chipEl.hidden = !c;
          if (c) el.style.setProperty("--card-c", c); else el.style.removeProperty("--card-c");
        }
      }
      if (full || "body" in o) setBody(o.body);
      if (full || "anchor" in o) st.anchor = o.anchor || null;
      if (full || "onClose" in o) st.onClose = typeof o.onClose === "function" ? o.onClose : null;
    };

    const headEl = el.querySelector(".card-head");
    const h = {
      id, el, titleEl,
      get anchor() { return st.anchor; },
      get open() { return cards.get(id) === h; },
      update(next) {
        if (!h.open || next == null) return h;
        if (typeof next === "string" || next instanceof Node) apply({ body: next }, false);
        else { apply(next, false); if ("title" in next || "subtitle" in next) measureFold(h); }
        cardsDirty = true;
        return h;
      },
      close() { closeHandle(h); },
      _st: st, _apply: apply, _head: headEl, _origin: null,
    };
    el._handle = h;
    el.querySelector(".card-x").addEventListener("click", () => h.close());
    // desktop: an older card squeezed down to its header comes back to the top of the stack when its header is clicked
    headEl.addEventListener("click", (e) => {
      if (isPhone() || e.target.closest("button, a") || cardsEl.firstElementChild === el || !h.open) return;
      cardsEl.prepend(el);
      cardsDirty = true;
      revealAnchor(h);
    });
    el.addEventListener("animationend", () => { cardsDirty = true; });
    attachSheetDrag(h);
    return h;
  }

  function card(opts = {}) {
    if (!opts || typeof opts !== "object") opts = {};
    const id = String(opts.id || "card");
    let h = cards.get(id);
    const fresh = !h;
    if (fresh) { h = makeCard(id); cards.set(id, h); }
    h._apply(opts, true);
    // newest first: the top of the stack on desktop, the visible sheet on phones (moving a node doesn't repaint its content)
    if (cardsEl.firstChild !== h.el) cardsEl.prepend(h.el);
    if (fresh) h.el.classList.remove("full");
    while (cards.size > MAX_CARDS) closeHandle(oldestCard());
    measureFold(h);
    cardsDirty = true;
    if (fromKeyboard()) {
      const was = document.activeElement;
      // reopening a card from inside itself (a bus picked on a stop's card) keeps where the reader first came from
      h._origin = focusOrigin || (was && was !== body && !h.el.contains(was) ? was : h._origin);
      h.titleEl.focus({ preventScroll: true });
    }
    app.emit("card-open", id);
    revealAnchor(h);
    return h;
  }
  /** an older card shrinks no lower than its header (see .card + .card in app.css) */
  function measureFold(h) {
    const hh = h._head.offsetHeight;
    if (hh) h.el.style.setProperty("--fold-h", `${hh + 2}px`);
  }

  function closeHandle(h) {
    if (!h || cards.get(h.id) !== h) return;
    cards.delete(h.id);
    const el = h.el;
    const hadFocus = el.contains(document.activeElement);
    if (reducedMotion() || !el.isConnected) el.remove();
    else {
      el.classList.add("closing");
      setTimeout(() => el.remove(), 240);
    }
    if (hadFocus && fromKeyboard()) handBackFocus(h);
    cardsDirty = true;
    try { if (h._st.onClose) h._st.onClose(); } catch (e) { console.error("[ui] card onClose", e); }
    app.emit("card-close", h.id);
  }
  function closeCard(id) {
    if (id == null) { for (const h of [...cards.values()]) closeHandle(h); return; }
    closeHandle(cards.get(String(id)));
  }

  /** If the thing a card is about sits under the card (or under the sheet on a phone), slide the map so it shows. */
  function revealAnchor(h) {
    const a = anchorOf(h);
    if (!a || view.anim) return;    // a fly-to is already heading somewhere sensible
    requestAnimationFrame(() => {
      if (!h.open || view.anim) return;
      const r = h.el.getBoundingClientRect();
      g2s(a.x, a.y, a.z || 0);
      const px = P[0], py = P[1];
      let dx = 0, dy = 0;
      if (isPhone()) {
        // where the sheet will rest once its slide-in ends (offsetHeight ignores the animation's transform)
        const top = $("bar") ? $("bar").getBoundingClientRect().bottom + 12 : 60;
        const bottom = window.innerHeight - h.el.offsetHeight - 18;
        if (py > bottom || py < top) dy = py - (top + Math.max(40, bottom - top) * 0.5);
        if (px < 20 || px > view.w - 20) dx = px - view.w / 2;
      } else {
        const covered = px > r.left - 30 && px < r.right + 30 && py > r.top - 30 && py < r.bottom + 30;
        const off = px < 0 || px > view.w || py < 0 || py > view.h;
        if (covered || off) { dx = px - (r.right + (view.w - r.right) * 0.45); dy = off ? py - view.h * 0.5 : 0; }
      }
      if (Math.abs(dx) + Math.abs(dy) < 2) return;
      const [gx, gy] = view.screenToGround(view.w / 2 + dx, view.h / 2 + dy);
      view.flyTo({ x: gx, y: gy }, { s: view.s, duration: 650 });
    });
  }

  /** Phones: the card is a bottom sheet; drag the grip down to dismiss, up to expand. */
  function attachSheetDrag(h) {
    const el = h.el;
    el.addEventListener("pointerdown", (e) => {
      if (!isPhone() || (e.pointerType === "mouse" && e.button !== 0)) return;
      const onGrip = !!e.target.closest(".card-grip");
      if (!onGrip && (!e.target.closest(".card-head") || e.target.closest("button, a, input"))) return;
      const y0 = e.clientY;
      let dy = 0, lastY = y0, lastT = performance.now(), vy = 0;
      try { el.setPointerCapture(e.pointerId); } catch { /* the pointer may already be gone */ }
      el.classList.add("dragging");
      const move = (ev) => {
        const now = performance.now();
        dy = ev.clientY - y0;
        // velocity over at least a few ms, so one coalesced jump doesn't read as a fling
        if (now - lastT >= 12) { vy = (ev.clientY - lastY) / (now - lastT); lastY = ev.clientY; lastT = now; }
        el.style.transform = `translateY(${dy > 0 ? dy : dy * 0.3}px)`;
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        el.classList.remove("dragging");
        const full = el.classList.contains("full");
        if ((dy > 90 || vy > 0.7) && !(full && dy < 260 && vy < 1.4)) {
          el.style.transition = "transform .2s ease-in";
          el.style.transform = "translateY(110%)";
          h.close();
          return;
        }
        el.style.transition = "transform .22s cubic-bezier(.2,.8,.3,1)";
        el.style.transform = "";
        setTimeout(() => { el.style.transition = ""; }, 240);
        if (dy > 60 || vy > 0.5) el.classList.remove("full");
        else if (dy < -40 || vy < -0.5) el.classList.add("full");
        else if (onGrip && Math.abs(dy) < 5) el.classList.toggle("full");
        cardsDirty = true;
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
  }

  // ============================================================================================== toasts
  function toast(text, ms = 2200) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = String(text ?? "");
    toastsEl.append(t);
    while (toastsEl.children.length > 3) toastsEl.firstElementChild.remove();
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 280); }, Math.max(800, +ms || 2200));
  }

  // ============================================================================================== status line
  const STATUS_ORDER = ["clock", "weather", "buses"];
  const statusParts = new Map();         // key → span
  let statusSeq = 0;
  function status(key, html) {
    key = String(key);
    let sp = statusParts.get(key);
    if (html == null || html === "") { if (sp) { sp.remove(); statusParts.delete(key); } return; }
    if (!sp) {
      sp = document.createElement("span");
      sp.className = `st st-${key.replace(/[^a-z0-9_-]/gi, "")}`;
      const i = STATUS_ORDER.indexOf(key);
      sp._rank = i >= 0 ? i : 100 + ++statusSeq;
      const next = [...statusEl.children].find((c) => c._rank > sp._rank);
      statusEl.insertBefore(sp, next || null);
      statusParts.set(key, sp);
    }
    html = String(html);
    if (sp._html !== html) { sp.innerHTML = html; sp._html = html; }
  }

  // the clock, in Columbus whatever the reader's time zone
  const clockFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit" });
  const simulated = app.params.has("time") || app.params.has("speed");
  let clockText = "";
  const tickClock = () => {
    let wd = "", hr = "", mi = "", dp = "";
    for (const p of clockFmt.formatToParts(app.now())) {
      if (p.type === "weekday") wd = p.value; else if (p.type === "hour") hr = p.value;
      else if (p.type === "minute") mi = p.value; else if (p.type === "dayPeriod") dp = p.value.toLowerCase();
    }
    const html = `<span class="day">${wd}</span> ${hr}:${mi} ${dp}`;
    if (html === clockText) return;
    clockText = html;
    status("clock", html);
    const sp = statusParts.get("clock");
    if (sp && !sp._init) {
      sp._init = true;
      sp.classList.toggle("sim", simulated);
      sp.title = simulated ? "Simulated time in Columbus" : "Time in Columbus";
    }
  };
  tickClock();
  setInterval(tickClock, simulated && +app.params.get("speed") > 30 ? 250 : 1000);

  // ============================================================================================== layers panel
  const toggles = new Map();             // id → { row, input, countEl, labelEl }
  const groups = new Map();              // name → section element
  const savedLayers = store.get("layers", {}) || {};
  const groupsEl = $("layer-groups");

  function registerToggle({ id, label, group = "Map", count = "", defaultOn = true } = {}) {
    if (!id) return;
    let t = toggles.get(id);
    if (!t) {
      if (groupsEl && !groups.size) groupsEl.replaceChildren();
      let sec = groups.get(group);
      if (!sec && groupsEl) {
        sec = document.createElement("section");
        sec.className = "lg";
        sec.innerHTML = `<h3></h3>`;
        sec.firstChild.textContent = group;
        groupsEl.append(sec);
        groups.set(group, sec);
      }
      const row = document.createElement("label");
      row.className = "tg";
      row.innerHTML = `<input type="checkbox" role="switch"><span class="tg-sw" aria-hidden="true"></span><span class="tg-label"></span><span class="tg-count"></span>`;
      const input = row.querySelector("input");
      input.addEventListener("change", () => {
        app.setLayerEnabled(id, input.checked);
        savedLayers[id] = input.checked;
        store.set("layers", savedLayers);
      });
      t = { row, input, countEl: row.querySelector(".tg-count"), labelEl: row.querySelector(".tg-label") };
      toggles.set(id, t);
      if (sec) sec.append(row);
    }
    t.labelEl.textContent = label || id;
    const want = Object.prototype.hasOwnProperty.call(savedLayers, id) ? !!savedLayers[id] : defaultOn !== false;
    if (app.layerEnabled(id) !== want) app.setLayerEnabled(id, want);
    t.input.checked = want;
    if (count !== "" && count != null) setCount(id, count);
  }
  function setCount(id, text) {
    const t = toggles.get(id);
    if (!t) return;
    const s = text == null ? "" : typeof text === "number" ? fmtInt(text) : String(text);
    if (t.countEl.textContent !== s) t.countEl.textContent = s;
  }
  app.on("layers", (p) => { const t = p && toggles.get(p.id); if (t && t.input.checked !== !!p.on) t.input.checked = !!p.on; });
  app.on("count", (p) => { if (p && p.id != null) setCount(p.id, p.n); });

  // ============================================================================================== routes panel
  const routesPanel = $("panel-routes"), routesBadge = $("routes-badge");
  const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });

  const routeList = () => { const t = app.transit; return t && Array.isArray(t.routes) ? t.routes : []; };
  const routeByCode = (code) => routeList().find((r) => r && r.code === code);
  function vehicleCounts() {
    const m = new Map(), t = app.transit;
    if (t && Array.isArray(t.vehicles)) for (const v of t.vehicles) if (v && v.routeCode != null) m.set(v.routeCode, (m.get(v.routeCode) || 0) + 1);
    return m;
  }
  const routeChip = (r, code, cls = "ui-rc") => {
    const c = (r && safeColor(r.color)) || "#6d6e71";
    return `<span class="${cls}" style="--c:${c};--fg:${textOn(c)}">${esc(code)}</span>`;
  };

  function renderRoutes() {
    if (!routesPanel) return;
    const t = app.transit;
    const routes = routeList().filter((r) => r && r.code != null);
    const counts = vehicleCounts();
    const running = [...counts.values()].reduce((a, b) => a + b, 0);
    const live = !!(t && t.ok), mock = !!(t && t.mock);
    // ?buses=mock is synthetic: no pulsing "live" tag, and no feed time (it would be wall-clock beside a simulated clock)
    const upd = !mock && t && t.updated instanceof Date && !isNaN(t.updated) ? `updated ${timeFmt.format(t.updated).toLowerCase()}` : "";
    const tag = mock ? "Mock" : live ? "Live" : "Offline";
    let html = `<div class="panel-head"><h2>Campus buses</h2>${t ? `<span class="live-tag${live && !mock ? "" : " off"}">${tag}</span>` : ""}<p>${esc(upd)}</p></div>`;
    if (!t) html += `<p class="panel-empty">Waiting for the bus feed…</p>`;
    else if (!routes.length) html += `<p class="panel-empty">${live ? "No routes are listed right now." : "Couldn't reach the CABS feed just now. It will try again shortly."}</p>`;
    else {
      const sorted = routes.slice().sort((a, b) => (counts.get(b.code) || 0) - (counts.get(a.code) || 0) || String(a.name || a.code).localeCompare(String(b.name || b.code)));
      html += `<ul class="rt-list">` + sorted.map((r) => {
        const n = counts.get(r.code) || 0, c = safeColor(r.color) || "#6d6e71";
        return `<li><button type="button" class="rt${n ? "" : " idle"}" data-code="${esc(r.code)}" style="--c:${c};--fg:${textOn(c)}" aria-label="${esc(r.name || r.code)}: ${n ? `${n} bus${n > 1 ? "es" : ""} running` : "not running now"}. Show on the map.">` +
          `<span class="rt-code">${esc(r.code)}</span><span class="rt-name">${esc(r.name || r.code)}</span>` +
          `<span class="rt-n">${n ? `<span class="dot"></span>${n} bus${n > 1 ? "es" : ""}` : "not running"}</span></button></li>`;
      }).join("") + `</ul>`;
      html += `<p class="panel-foot">${running ? `${running} bus${running > 1 ? "es" : ""} on the road now.` : "No buses are running right now."} Evenings and weekends only a route or two run. Data: <a href="https://ttm.osu.edu/cabs" target="_blank" rel="noopener">Ohio State CABS</a>.</p>`;
    }
    const focusCode = document.activeElement && routesPanel.contains(document.activeElement) ? document.activeElement.dataset.code : null;
    routesPanel.innerHTML = html;
    if (focusCode != null) { const b = [...routesPanel.querySelectorAll(".rt")].find((x) => x.dataset.code === focusCode); if (b) b.focus(); }
  }
  routesPanel && routesPanel.addEventListener("click", (e) => {
    const b = e.target.closest(".rt");
    if (!b) return;
    // close first: from the keyboard (detail 0) focus goes back to the Routes button, which the route's card then
    // remembers as the place to return to
    closePanel(e.detail === 0);
    flyToRoute(b.dataset.code);
  });
  function flyToRoute(code) {
    const t = app.transit;
    if (t && typeof t.flyToRoute === "function") { try { t.flyToRoute(code); return; } catch (e) { console.warn("[ui] flyToRoute", e); } }
    // no helper: frame the route's shape ourselves
    const r = routeByCode(code);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of (r && r.patterns) || []) for (const [lat, lon] of p.pts || []) {
      const [x, y] = geo.toXY(lat, lon);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    if (x0 < x1) flyToGround((x0 + x1) / 2, (y0 + y1) / 2, clamp(Math.max(x1 - x0, y1 - y0) * 1.5, 600, 7000));
  }
  function updateBadge() {
    if (!routesBadge) return;
    let n = 0;
    for (const v of vehicleCounts().values()) n += v;
    const s = n ? String(n) : "";
    if (routesBadge.textContent !== s) { routesBadge.textContent = s; routesBadge.hidden = !n; }
  }
  app.on("transit", () => {
    updateBadge();
    if (openPanelName === "routes") renderRoutes();
    refreshNearStops();
  });

  // ============================================================================================== panels (routes, layers)
  const panels = {
    routes: { btn: $("btn-routes"), panel: routesPanel, render: renderRoutes },
    layers: { btn: $("btn-layers"), panel: $("panel-layers"), render: null },
  };
  let openPanelName = null;
  function placePanel(p, anchorEl) {
    if (isPhone()) { p.style.left = ""; return; }
    const r = anchorEl.getBoundingClientRect();
    const w = p.offsetWidth || 330;
    p.style.left = `${clamp(r.left - 6, 10, window.innerWidth - w - 58)}px`;
  }
  function openPanel(name, viaKeyboard = false) {
    const p = panels[name];
    if (!p || !p.panel || !p.btn) return;
    closeSearch();
    if (openPanelName && openPanelName !== name) closePanel();
    if (p.render) p.render();
    p.panel.hidden = false;
    p.btn.setAttribute("aria-expanded", "true");
    placePanel(p.panel, p.btn);
    openPanelName = name;
    if (viaKeyboard) { const f = p.panel.querySelector("button, input, a[href]"); if (f) f.focus(); }
  }
  function closePanel(returnFocus = false) {
    if (!openPanelName) return;
    const p = panels[openPanelName];
    openPanelName = null;
    p.panel.hidden = true;
    p.btn.setAttribute("aria-expanded", "false");
    if (returnFocus) p.btn.focus();
  }
  for (const [name, p] of Object.entries(panels)) {
    if (!p.btn) continue;
    // e.detail is 0 for a keyboard "click": then focus moves into the panel
    p.btn.addEventListener("click", (e) => (openPanelName === name ? closePanel() : openPanel(name, e.detail === 0)));
  }

  // ============================================================================================== search
  const providers = [];
  const qEl = $("search-q"), searchPanel = $("search-panel"), resultsEl = $("search-results"), hintEl = $("search-hint");
  const searchTool = qEl && qEl.closest(".tool-search");
  let results = [], active = -1, searchOpen = false;

  function search(q) {
    const raw = String(q ?? "").trim();
    if (!raw) return [];
    const all = [];
    for (const fn of providers) {
      try { const r = fn(raw); if (Array.isArray(r)) for (const it of r) if (it && it.label && typeof it.go === "function") all.push(it); } catch (e) { console.warn("[ui] search provider", e); }
    }
    all.sort((a, b) => (+b.score || 0) - (+a.score || 0));
    // several modules may know the same place (labels.js names buildings too): keep the best of each label + kind,
    // borrowing a position from a dropped twin when the kept one has none
    const seen = new Map(), out = [];
    for (const it of all) {
      const k = String(it.key || `${it.label}|${it.kind || ""}`).toLowerCase();
      const kept = seen.get(k);
      if (kept) { if (!Number.isFinite(kept.x) && Number.isFinite(it.x)) { kept.x = it.x; kept.y = it.y; } continue; }
      const copy = { ...it };
      seen.set(k, copy);
      out.push(copy);
    }
    return tellApart(out);
  }

  /**
   * Same-named results (five Starbucks, two wings of University Hospital) would read identically: give each its distance
   * and direction from the middle of the view and, when it has no address, the street it is on, and list them nearest
   * first in the slot of the best-ranked one. Only results that carry a ground position (optional x, y) take part.
   */
  const COMPASS8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  function tellApart(list) {
    const groups = new Map();
    for (const it of list) {
      if (!Number.isFinite(it.x) || !Number.isFinite(it.y)) continue;
      const k = String(it.label).toLowerCase();
      (groups.get(k) || groups.set(k, []).get(k)).push(it);
    }
    const [vx, vy] = view.centreGround();
    let changed = false;
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      changed = true;
      for (const it of g) {
        const dx = it.x - vx, dy = it.y - vy, d = Math.hypot(dx, dy);
        const dist = d < 300 ? `${fmtInt(Math.round((d * FT) / 50) * 50)} ft` : `${(d / 1609.34).toFixed(1)} mi`;
        const away = d < 60 ? "here" : `${dist} ${COMPASS8[Math.round(((Math.atan2(dx, dy) * 180) / Math.PI + 360) / 45) % 8]}`;
        it._d = d;
        // what tells them apart goes first, so a narrow screen's ellipsis cuts the shared part
        it.sub = [away, it.addr ? "" : streetNear(it.x, it.y), it.sub].filter(Boolean).join(" · ");
      }
      g.sort((a, b) => a._d - b._d);
    }
    if (!changed) return list;
    const out = [], placed = new Set();
    for (const it of list) {
      const g = Number.isFinite(it._d) ? groups.get(String(it.label).toLowerCase()) : null;
      if (!g) { out.push(it); continue; }
      if (placed.has(g)) continue;
      placed.add(g);
      out.push(...g);
    }
    return out;
  }
  /** the name of the street nearest ground (x, y), within a block, or "" */
  const streetCache = new Map();
  let namedRoads = null;                 // [{ n, pts, bb }], built on first use
  function streetNear(x, y) {
    const ck = `${Math.round(x)},${Math.round(y)}`;
    if (streetCache.has(ck)) return streetCache.get(ck);
    if (!namedRoads) namedRoads = (data.roads || []).filter((r) => r && r.n && r.pts && r.pts.length >= 4).map((r) => ({ n: r.n, pts: r.pts, bb: ringBox(r.pts) }));
    let best = 90, name = "";
    for (const r of namedRoads) {
      if (x < r.bb[0] - best || x > r.bb[2] + best || y < r.bb[1] - best || y > r.bb[3] + best) continue;
      const f = r.pts;
      for (let k = 2; k < f.length; k += 2) {
        const ax = f[k - 2], ay = f[k - 1], bx = f[k] - ax, by = f[k + 1] - ay;
        const L = bx * bx + by * by, t = L ? clamp(((x - ax) * bx + (y - ay) * by) / L, 0, 1) : 0;
        const d = Math.hypot(x - ax - bx * t, y - ay - by * t);
        if (d < best) { best = d; name = r.n; }
      }
    }
    streetCache.set(ck, name);
    return name;
  }

  const KIND_ICON = { building: "building", landmark: "building", street: "street", road: "street", place: "place", poi: "place", park: "park", area: "park", stop: "stop", route: "bus", bus: "bus", vehicle: "bus", weather: "sun", sky: "sun" };
  function highlight(label, raw) {
    const L = String(label), i = raw ? L.toLowerCase().indexOf(raw.toLowerCase()) : -1;
    if (i < 0) return esc(L);
    return esc(L.slice(0, i)) + "<mark>" + esc(L.slice(i, i + raw.length)) + "</mark>" + esc(L.slice(i + raw.length));
  }
  // the hint and the "Try" chips sit beside the listbox, not in it: a listbox may hold only options
  const setHint = (html) => { if (hintEl) hintEl.innerHTML = html; };
  function renderResults() {
    if (!resultsEl) return;
    const raw = qEl.value.trim();
    active = -1;
    qEl.removeAttribute("aria-activedescendant");
    if (!raw) {
      results = [];
      resultsEl.replaceChildren();
      setHint(`<p class="res-hint">Buildings, streets, places, bus stops and routes. Try:</p>` +
        `<div class="res-try">${TRY.map((t) => `<button type="button" class="chip-btn" data-try="${esc(t)}">${esc(t)}</button>`).join("")}</div>`);
      return;
    }
    results = search(raw).slice(0, 9);
    if (!results.length) { resultsEl.replaceChildren(); setHint(`<p class="res-hint" role="status">Nothing on the map matches “${esc(raw)}”.</p>`); return; }
    setHint("");
    resultsEl.innerHTML = results.map((r, i) => {
      const kind = String(r.kind || "place"), c = safeColor(r.color);
      const tint = c ? ` tinted" style="--c:${c};--fg:${textOn(c)}` : "";
      return `<li class="res" role="option" id="res-${i}" data-i="${i}" aria-selected="false"><span class="res-ico${tint}">${icon(KIND_ICON[kind] || "place")}</span>` +
        `<span class="res-text"><span class="res-label">${highlight(r.label, raw)}</span>${r.sub ? `<span class="res-sub">${esc(r.sub)}</span>` : ""}</span>` +
        `<span class="res-kind">${esc(kind)}</span></li>`;
    }).join("");
    setActive(0);
  }
  function setActive(i) {
    const items = resultsEl.querySelectorAll(".res");
    if (!items.length) { active = -1; return; }
    active = (i + items.length) % items.length;
    items.forEach((li, k) => li.setAttribute("aria-selected", k === active ? "true" : "false"));
    qEl.setAttribute("aria-activedescendant", `res-${active}`);
    items[active].scrollIntoView({ block: "nearest" });
  }
  function choose(i) {
    const r = results[i];
    if (!r) return;
    qEl.value = r.label;
    // a card this opens from the keyboard hands focus back here when it closes (on phones the field itself goes away)
    focusOrigin = isPhone() ? $("btn-search") : qEl;
    closeSearch(true);
    try { r.go(); } catch (e) { console.warn("[ui] search result", e); }
    focusOrigin = null;
  }
  function openSearch() {
    if (!qEl || searchOpen) return;
    closePanel();
    searchOpen = true;
    body.classList.add("searching");
    searchPanel.hidden = false;
    qEl.setAttribute("aria-expanded", "true");
    if (!isPhone()) placePanel(searchPanel, qEl.closest(".search"));
    renderResults();
  }
  function closeSearch(blur = true) {
    if (!searchOpen) return;
    searchOpen = false;
    body.classList.remove("searching");
    searchPanel.hidden = true;
    qEl.setAttribute("aria-expanded", "false");
    qEl.removeAttribute("aria-activedescendant");
    if (blur && document.activeElement === qEl) qEl.blur();
  }
  function focusSearch() {
    if (!qEl) return;
    openSearch();
    qEl.focus();
    qEl.select();
  }
  /** Esc in search: close the list but keep the reader in the field (on phones the field goes away: its button instead). */
  function escapeSearch() {
    closeSearch(false);
    if (isPhone()) focusQuietly($("btn-search"));
    else if (document.activeElement !== qEl) focusQuietly(qEl);
  }
  /** Focus without the side effects of a reader's focus (the search field opening its list). */
  let quietFocus = false;
  function focusQuietly(el) {
    if (!el) return;
    quietFocus = true;
    try { el.focus({ preventScroll: true }); } finally { quietFocus = false; }
  }
  if (qEl) {
    qEl.addEventListener("focus", () => { if (!quietFocus) openSearch(); qEl.select(); });
    // the field can hold focus with its list closed (after Esc, or when a card hands focus back): a click reopens it
    qEl.addEventListener("click", () => { if (!searchOpen) openSearch(); });
    // typing into a field whose list was closed with Esc opens it again
    qEl.addEventListener("input", () => (searchOpen ? renderResults() : openSearch()));
    qEl.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { if (!searchOpen) openSearch(); setActive(active + 1); e.preventDefault(); }
      else if (e.key === "ArrowUp") { setActive(active - 1); e.preventDefault(); }
      else if (e.key === "Enter") { if (!searchOpen) openSearch(); choose(active >= 0 ? active : 0); e.preventDefault(); }
      // a second Esc (the list already closed) goes on to the page: it closes the top card
      else if (e.key === "Escape" && searchOpen) { escapeSearch(); e.preventDefault(); e.stopPropagation(); }
    });
    // pointerdown + preventDefault keeps focus in the field, so the list doesn't close before the click lands
    searchPanel.addEventListener("pointerdown", (e) => { if (e.target.closest(".res, .chip-btn")) e.preventDefault(); });
    searchPanel.addEventListener("click", (e) => {
      const tr = e.target.closest("[data-try]");
      if (tr) { qEl.value = tr.dataset.try; renderResults(); qEl.focus(); return; }
      const li = e.target.closest(".res");
      if (li) choose(+li.dataset.i);
    });
    resultsEl.addEventListener("pointermove", (e) => { const li = e.target.closest(".res"); if (li && +li.dataset.i !== active) setActive(+li.dataset.i); });
    $("btn-search") && $("btn-search").addEventListener("click", focusSearch);
    searchTool.querySelector(".search-cancel").addEventListener("click", () => { closeSearch(true); focusQuietly($("btn-search")); });
    // the long placeholder fits the wide field and the phone's full-width one; the icons-only bar gets the short one
    const midMQ = matchMedia("(min-width: 641px) and (max-width: 1060px)");
    const longPh = qEl.placeholder, shortPh = qEl.dataset.short || longPh;
    const fitPlaceholder = () => { qEl.placeholder = midMQ.matches ? shortPh : longPh; };
    fitPlaceholder();
    midMQ.addEventListener?.("change", fitPlaceholder);
  }

  // ---------------------------------------------------------------- the UI's own search index: buildings, streets, places
  let index = null;
  const named = [];                      // named buildings (hidden ones too: their footprints name the parts drawn inside)
  function buildIndex() {
    index = [];
    const B = data.buildings || [];
    // buildings, merged when one name covers several footprints nearby (a hospital's wings)
    const byName = new Map();
    const oval = geo.toXY(OVAL.lat, OVAL.lon);
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      if (!b || !b.p || !b.p[0]) continue;
      if (b.n) named.push(i);
      if (!b.n || (b.part && !b.hidden)) continue;
      const [cx, cy] = ringCentroid(b.p[0]);
      const area = ringArea(b.p[0]);
      const key = norm(b.n);
      let list = byName.get(key);
      if (!list) byName.set(key, (list = []));
      const near = list.find((e) => Math.hypot(e.cx - cx, e.cy - cy) < 160);
      if (near) { if (area > near.area) Object.assign(near, { i, cx, cy, area }); continue; }
      list.push({ i, cx, cy, area });
    }
    for (const list of byName.values()) {
      list.sort((a, b) => b.area - a.area);
      // a wing drawn as its own footprint usually carries no address: it shares the building's
      const listAddr = list.map((e) => B[e.i].a).find(Boolean);
      list.forEach((e, k) => {
        const b = B[e.i];
        const type = b.am ? humanise(b.am) : humanise(b.k);
        const addr = b.a || listAddr;
        // bigger, more campus-like and nearer the Oval ranks higher among equally good name matches
        const big = Math.min(8, Math.log10(1 + e.area) * 1.8);
        const campusy = /university|college|dormitory|stadium|sports|hospital|library|civic|public|museum|theatre/.test(`${b.k} ${b.am || ""}`) ? 4 : 0;
        const central = Math.max(0, 4 - Math.hypot(e.cx - oval[0], e.cy - oval[1]) / 400);
        index.push({
          label: b.n, n: norm(b.n), kind: "building", sub: addr ? `${type} · ${addr}` : type, bonus: 1 + big + campusy + central, x: e.cx, y: e.cy, addr: !!addr,
          key: k ? `${b.n}|building|${Math.round(e.cx)},${Math.round(e.cy)}` : null,
          go: () => { flyToGround(e.cx, e.cy, clamp(Math.sqrt(e.area) * 6, 240, 900), { z: b.h * 0.5 }); showBuilding(e.i, { pin: true }); },
        });
      });
    }
    // the short names people use; a building people have a nickname for is a famous one, whatever OSM calls its type
    const byLabel = new Map();
    for (const it of index) if (!byLabel.has(it.label)) byLabel.set(it.label, it);
    for (const [alias, name] of Object.entries(ALIASES)) {
      const it = byLabel.get(name);
      if (!it) continue;
      if (!it.alt) { it.alt = []; it.bonus += 6; }
      it.alt.push(norm(alias));
    }
    // landmarks the data leaves unnamed
    for (const L of LANDMARKS) {
      const [x, y] = geo.toXY(L.lat, L.lon);
      L.x = x; L.y = y;
      L.bi = B.findIndex((b) => b && b.p && b.p[0] && !b.n && inRing(b.p[0], x, y));
      index.push({
        label: L.n, n: norm(L.n), alt: L.aka.map(norm), kind: "building", sub: L.type, bonus: 14, x, y,
        go: () => { flyToGround(x, y, L.m, { z: 10 }); if (L.bi >= 0) showBuilding(L.bi, { pin: true }); else showPlace({ name: L.n, type: L.type, x, y }); },
      });
    }
    // named areas: the Oval, Mirror Lake, quads, parks
    const seenArea = new Map();
    for (const a of data.areas || []) {
      if (!a || !a.n || !a.p || !a.p[0]) continue;
      const [cx, cy] = ringCentroid(a.p[0]);
      const k = norm(a.n);
      const prev = seenArea.get(k);
      if (prev && Math.hypot(prev.x - cx, prev.y - cy) < 300) continue;
      seenArea.set(k, { x: cx, y: cy });
      const bb = ringBox(a.p[0]), ext = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
      const type = humanise(a.k);
      index.push({
        label: a.n, n: k, kind: a.k === "plaza" ? "place" : "park", sub: type, bonus: a.k === "park" || a.k === "water" ? 6 : 3, x: cx, y: cy,
        key: prev ? `${a.n}|area|${Math.round(cx)}` : null,
        go: () => { flyToGround(cx, cy, clamp(ext * 2.4, 280, 2400)); showPlace({ name: a.n, type, x: cx, y: cy, acres: ringArea(a.p[0]) / 4046.86 }); },
      });
    }
    // points of interest (skipping ones that merely repeat a named building on the same spot)
    const bNear = (n, x, y) => { const L = byName.get(n); return L && L.some((e) => Math.hypot(e.cx - x, e.cy - y) < 60); };
    for (const p of data.pois || []) {
      if (!p || !p.n || !Number.isFinite(p.x)) continue;
      const k = norm(p.n);
      if (bNear(k, p.x, p.y)) continue;
      const type = humanise(p.k) + (p.cu ? ` · ${cap(String(p.cu).split(";")[0].replace(/_/g, " "))}` : "");
      index.push({
        label: p.n, n: k, kind: "place", sub: type, bonus: /library|museum|theatre|memorial|artwork/.test(p.k) ? 2 : 0, x: p.x, y: p.y,
        key: `${p.n}|place|${Math.round(p.x)},${Math.round(p.y)}`,
        go: () => { flyToGround(p.x, p.y, 260); showPlace({ name: p.n, type, x: p.x, y: p.y, poi: true }); },
      });
    }
    // streets: every segment that shares a name, highlighted together
    const streets = new Map();
    (data.roads || []).forEach((r, i) => {
      if (!r || !r.n || !r.pts || r.pts.length < 4) return;
      let s = streets.get(r.n);
      if (!s) streets.set(r.n, (s = { name: r.n, ids: [], len: 0, bb: [Infinity, Infinity, -Infinity, -Infinity], rank: 0 }));
      s.ids.push(i);
      const f = r.pts;
      for (let k = 0; k < f.length; k += 2) {
        if (k) s.len += Math.hypot(f[k] - f[k - 2], f[k + 1] - f[k - 1]);
        s.bb[0] = Math.min(s.bb[0], f[k]); s.bb[1] = Math.min(s.bb[1], f[k + 1]); s.bb[2] = Math.max(s.bb[2], f[k]); s.bb[3] = Math.max(s.bb[3], f[k + 1]);
      }
      s.rank = Math.max(s.rank, { motorway: 4, primary: 4, secondary: 3, tertiary: 2, residential: 1 }[r.k] || 0);
    });
    for (const s of streets.values()) {
      const kind = s.rank >= 3 ? "Main road" : "Street";
      const len = s.len > 1609 ? `${(s.len / 1609.34).toFixed(1)} mi` : `${fmtInt(Math.round((s.len * FT) / 10) * 10)} ft`;
      // "Lane Avenue" should find West Lane Avenue: match the name without its compass word too
      const n = norm(s.name), bare = s.rank ? n.replace(/^(north|south|east|west) /, "") : n;
      index.push({ label: s.name, n, alt: bare !== n ? [bare] : null, kind: "street", sub: `${kind} · ${len} on the map`, bonus: s.rank * 3.5, go: () => showStreet(s, kind, len) });
    }
  }
  function searchLocal(raw) {
    if (!index) buildIndex();
    const qn = norm(raw);
    if (!qn) return [];
    const qt = qn.split(" ");
    const out = [];
    for (const it of index) {
      let sc = textScore(qn, qt, it.n);
      if (it.alt) for (const a of it.alt) sc = Math.max(sc, textScore(qn, qt, a) - 3);
      if (it.n.startsWith("the ")) sc = Math.max(sc, textScore(qn, qt, it.n.slice(4)) - 1);
      // the other modules score 0..1, so ours are scaled onto the same range
      if (sc > 0) out.push({ label: it.label, sub: it.sub, kind: it.kind, key: it.key || undefined, x: it.x, y: it.y, addr: it.addr, score: Math.min(1, (sc + it.bonus) / 110), go: it.go });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 14);
  }
  providers.push(searchLocal);

  // ============================================================================================== building, place and street cards
  let pin = null;                        // { x, y, z, t0, card }
  let street = null;                     // { s, t0 }
  const nearTargets = new Map();         // card id → { x, y, el, sig }

  function buildingInfo(i) {
    const B = data.buildings, b = B[i];
    if (!index) buildIndex();
    const ring = b.p[0];
    const [cx, cy] = ringCentroid(ring);
    let name = b.n || null, parent = null;
    if (!name) {
      for (const L of LANDMARKS) if (L.x != null && inRing(ring, L.x, L.y)) { name = L.n; parent = { k: null, type: L.type }; break; }
    }
    if (!name) {
      // a building part (or an unnamed wing) inside a named footprint takes that building's name
      let best = -1, bestA = Infinity;
      for (const j of named) {
        if (j === i) continue;
        const r = B[j].p[0], bb = B[j]._bb || (B[j]._bb = ringBox(r));
        if (cx < bb[0] || cx > bb[2] || cy < bb[1] || cy > bb[3] || !inRing(r, cx, cy)) continue;
        const a = B[j]._area || (B[j]._area = ringArea(r));
        if (a < bestA) { bestA = a; best = j; }
      }
      if (best >= 0) { parent = B[best]; name = parent.n; }
    }
    const src = parent && parent.p ? parent : b;
    const type = parent && parent.type ? parent.type : src.am ? humanise(src.am) : humanise(src.k === "yes" && b.k !== "yes" ? b.k : src.k);
    // a clicked wing stands for the whole named building: its footprint, its tallest point
    const whole = parent && parent.p ? parent : null;
    return {
      name, type, cx, cy, h: b.h || 0,
      addr: b.a || (parent && parent.a) || null,
      floors: whole ? Math.max(b.lv || 0, whole.lv || 0) || null : b.lv || null,
      year: b.y || (parent && parent.y) || null,
      tallest: whole ? Math.max(b.h || 0, whole.h || 0) : b.h || 0,
      area: whole ? ringArea(whole.p[0]) : ringArea(ring),
    };
  }

  function statsHtml(info) {
    const st = [];
    if (info.floors) st.push([String(Math.round(info.floors)), info.floors == 1 ? "floor" : "floors"]);
    if (info.tallest) st.push([`${fmtInt(info.tallest * FT)} ft`, "tall"]);
    if (info.year) st.push([String(info.year), "built"]);
    if (st.length < 3 && info.area > 30) st.push([info.area * SQFT >= 100000 ? `${(info.area * SQFT / 1000).toFixed(0)}k` : fmtInt(info.area * SQFT), "sq ft footprint"]);
    return `<div class="ui-stats">${st.map(([v, l]) => `<div class="ui-stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join("")}</div>`;
  }

  /** Body for "nearest stops", filled now and again whenever the bus data changes. */
  function nearBlock(cardId, x, y) {
    const wrap = document.createElement("div");
    wrap.className = "ui-near";
    nearTargets.set(cardId, { x, y, el: wrap, sig: null });
    fillNear(nearTargets.get(cardId));
    wrap.addEventListener("click", (e) => {
      const b = e.target.closest("[data-stop]");
      if (!b) return;
      const t = app.transit;
      if (t && typeof t.openStop === "function") { try { t.openStop(b.dataset.stop); } catch (err) { console.warn("[ui] openStop", err); } }
    });
    return wrap;
  }
  function nearestStops(x, y, n) {
    const t = app.transit, stops = t && t.stops;
    if (!stops) return null;
    const list = stops instanceof Map ? stops.values() : Array.isArray(stops) ? stops : Object.values(stops);
    const best = [];
    for (const s of list) {
      if (!s || !Number.isFinite(+s.lat) || !Number.isFinite(+s.lon)) continue;
      const [sx, sy] = geo.toXY(+s.lat, +s.lon);
      const d = Math.hypot(sx - x, sy - y);
      if (best.length === n && d >= best[n - 1].d) continue;
      best.push({ s, d });
      best.sort((a, b) => a.d - b.d);
      if (best.length > n) best.pop();
    }
    return best;
  }
  function fillNear(nt) {
    const near = nearestStops(nt.x, nt.y, 3);
    const sig = near ? near.map((e) => `${e.s.id}:${(e.s.routes || []).join(",")}`).join("|") + `|${routeList().length}` : String(!!app.transit);
    if (sig === nt.sig) return;
    nt.sig = sig;
    let html = `<h3 class="ui-h">Nearest bus stops</h3>`;
    if (!near) html += `<p class="ui-note">Bus stops appear once the CABS feed loads.</p>`;
    else if (!near.length) html += `<p class="ui-note">No bus stops are known right now.</p>`;
    else {
      html += `<ul class="ui-stops">` + near.map(({ s, d }) => {
        const min = Math.max(1, Math.round(d / WALK_M_PER_MIN));
        const chips = (Array.isArray(s.routes) ? s.routes : []).slice(0, 6).map((code) => routeChip(routeByCode(code), code)).join("");
        return `<li><button type="button" class="ui-stop" data-stop="${esc(s.id)}" aria-label="${esc(s.name || "Bus stop")}, ${min} minute walk"><span><span class="ui-stop-name">${esc(s.name || "Bus stop")}</span>` +
          (chips ? `<span class="ui-stop-routes">${chips}</span>` : "") + `</span><span class="ui-walk">${icon("walk")}${min} min</span></button></li>`;
      }).join("") + `</ul>`;
    }
    nt.el.innerHTML = html;
  }
  function refreshNearStops() {
    for (const [id, nt] of nearTargets) { if (!cards.has(id)) nearTargets.delete(id); else fillNear(nt); }
  }

  function showBuilding(i, opts = {}) {
    const b = data.buildings && data.buildings[i];
    if (!b || !b.p || !b.p[0]) return null;
    const info = buildingInfo(i);
    const title = info.name || info.addr || info.type;
    const subtitle = info.name ? info.type : info.addr ? info.type : "";
    const wrap = document.createElement("div");
    wrap.innerHTML = statsHtml(info) + (info.name && info.addr ? `<p class="ui-line">${icon("place")}<span>${esc(info.addr)}</span></p>` : "");
    wrap.append(nearBlock("building", info.cx, info.cy));
    if (opts.pin) setPin(info.cx, info.cy, info.h, "building"); else if (pin && pin.card === "building") pin = null;
    const h = card({
      id: "building", title, subtitle, body: wrap, anchor: { x: info.cx, y: info.cy, z: info.h },
      onClose: () => { app.emit("select-building", { index: -1 }); if (pin && pin.card === "building") pin = null; },
    });
    app.emit("select-building", { index: i });
    return h;
  }
  function showPlace({ name, type, x, y, poi, acres }) {
    const wrap = document.createElement("div");
    let inside = "";
    if (poi) {
      for (const j of named) {
        const r = data.buildings[j].p[0], bb = data.buildings[j]._bb || (data.buildings[j]._bb = ringBox(r));
        if (x >= bb[0] && x <= bb[2] && y >= bb[1] && y <= bb[3] && inRing(r, x, y)) { inside = data.buildings[j].n; break; }
      }
    }
    wrap.innerHTML = (acres > 0.05 ? `<div class="ui-stats"><div class="ui-stat"><b>${acres >= 10 ? fmtInt(acres) : acres.toFixed(1)}</b><span>acres</span></div><div class="ui-stat"><b>${fmtInt(acres * 4046.86 * SQFT)}</b><span>sq ft</span></div></div>` : "") +
      (inside ? `<p class="ui-line">${icon("building")}<span>In ${esc(inside)}</span></p>` : "");
    wrap.append(nearBlock("place", x, y));
    setPin(x, y, 0, "place");
    return card({ id: "place", title: name, subtitle: type, body: wrap, anchor: { x, y, z: 0 }, onClose: () => { if (pin && pin.card === "place") pin = null; } });
  }
  function showStreet(s, kind, len) {
    // long streets cross the whole map: look at the stretch nearest where the reader is (or the Oval), not all of it
    const ext = Math.max(s.bb[2] - s.bb[0], s.bb[3] - s.bb[1]);
    const [vx, vy] = view.centreGround(), oval = geo.toXY(OVAL.lat, OVAL.lon);
    const nearest = (tx, ty) => {
      let best = Infinity, bx = 0, by = 0;
      for (const i of s.ids) {
        const f = data.roads[i].pts;
        for (let k = 0; k < f.length; k += 2) { const d = Math.hypot(f[k] - tx, f[k + 1] - ty); if (d < best) { best = d; bx = f[k]; by = f[k + 1]; } }
      }
      return [bx, by, best];
    };
    let [cx, cy, d] = nearest(vx, vy);
    if (d > 1200) [cx, cy] = nearest(oval[0], oval[1]);
    if (ext < 1400) { cx = (s.bb[0] + s.bb[2]) / 2; cy = (s.bb[1] + s.bb[3]) / 2; }
    flyToGround(cx, cy, clamp(ext * 1.25, 380, 1500));
    street = { s, t0: performance.now() };
    const wrap = document.createElement("div");
    wrap.innerHTML = `<p class="ui-note">Highlighted on the map, ${esc(len)} of it within the area drawn here.</p>`;
    wrap.append(nearBlock("street", cx, cy));
    card({ id: "street", title: s.name, subtitle: kind, body: wrap, anchor: null, onClose: () => { street = null; } });
  }
  function setPin(x, y, z = 0, cardId = null) { pin = x == null ? null : { x, y, z, t0: performance.now(), card: cardId }; }

  app.on("pick-building", (p) => { if (p && p.index >= 0) showBuilding(p.index); });
  app.on("click-empty", () => { closeCard(); closePanel(); closeSearch(); });

  // ---------------------------------------------------------------- what the UI draws on the map: the search pin, the card's leader
  const DROP = 0.55, LEADER_DASH = [1.5, 4];
  app.addLayer({
    id: "ui-highlight", z: 60,
    draw(ctx) {
      if (!street) return;
      const s = view.s, o = geo.ROTS[view.rot], S = geo.SIN_T, d = view.dpr;
      const a = reducedMotion() ? 1 : Math.min(1, (performance.now() - street.t0) / 400);
      // ground metres straight onto the screen (see render.js setWorld): widths foreshorten like the roads themselves
      ctx.setTransform(d * s * o.R[0], -d * s * S * o.D[0], d * s * o.R[1], -d * s * S * o.D[1], d * (view.w / 2 - view.X * s), d * (view.h / 2 - view.Y * s));
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.strokeStyle = "#b3202a";
      for (let pass = 0; pass < 2; pass++) {
        ctx.globalAlpha = (pass ? 0.55 : 0.2) * a;
        for (const i of street.s.ids) {
          const r = data.roads[i], f = r.pts;
          ctx.lineWidth = pass ? Math.max(2, r.w * 0.35) : r.w + 9;
          ctx.beginPath();
          ctx.moveTo(f[0], f[1]);
          for (let k = 2; k < f.length; k += 2) ctx.lineTo(f[k], f[k + 1]);
          ctx.stroke();
        }
      }
    },
  });
  // Cards whose layer already marks the thing on the map (buses.js rings the selected bus or stop and labels it with a
  // route pill right at the anchor): only the leader is drawn, and it stops short so the pill stays readable.
  const SELF_MARKED = new Set(["transit"]);
  const LEADER_GAP = 18;
  app.addLayer({
    id: "ui-marks", z: 95,
    draw(ctx, f) {
      const top = cards.size ? topCard() : null;
      const a = top ? anchorOf(top) : null;
      if (!pin && !a) return;
      const still = reducedMotion();
      if (a && !(pin && pin.card === top.id)) drawAnchor(ctx, a, top, f.t, still);
      if (pin) drawPin(ctx, still);
    },
  });
  function drawAnchor(ctx, a, top, t, still) {
    g2s(a.x, a.y, a.z || 0);
    const ax = P[0], ay = P[1];
    if (ax < -30 || ay < -30 || ax > view.w + 30 || ay > view.h + 30) return;
    const marked = SELF_MARKED.has(top.id) || a.mark === false;
    if (!isPhone()) {
      if (cardsDirty || !cardRect) { cardRect = top.el.getBoundingClientRect(); cardsDirty = false; }
      const r = cardRect;
      const ex = marked ? ax - LEADER_GAP : ax;
      if (ex > r.right + 36) {
        // a dotted leader from the card's edge, level with the anchor where it can be
        const x0 = r.right + 2, y0 = clamp(ay, r.top + 26, r.bottom - 20), mx = (x0 + ex) / 2;
        ctx.save();
        ctx.setLineDash(LEADER_DASH);
        ctx.lineCap = "round";
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = "rgba(42, 38, 34, .55)";
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.bezierCurveTo(mx, y0, mx, ay, ex, ay);
        ctx.stroke();
        ctx.restore();
      }
    }
    if (marked) return;
    // the marker: a soft pulse, then a ring
    if (!still) {
      const ph = ((t / 1600) % 1);
      ctx.beginPath();
      ctx.arc(ax, ay, 5 + ph * 12, 0, Math.PI * 2);
      ctx.globalAlpha = 0.45 * (1 - ph);
      ctx.strokeStyle = "#b3202a";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.arc(ax, ay, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = "#fbf8f1";
    ctx.fill();
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = "#b3202a";
    ctx.stroke();
  }
  const TIP_A0 = Math.PI / 2 + Math.acos(7.5 / 17), TIP_A1 = Math.PI / 2 - Math.acos(7.5 / 17) + Math.PI * 2;
  function drawPin(ctx, still) {
    g2s(pin.x, pin.y, pin.z);
    const px = P[0], py = P[1];
    if (px < -30 || py < -10 || px > view.w + 30 || py > view.h + 40) return;
    const k = still ? 1 : Math.min(1, (performance.now() - pin.t0) / 1000 / DROP);
    // fall, then a small bounce (easeOutBounce, gentle)
    const e = k < 0.7 ? (k / 0.7) ** 2 : 1 - Math.sin(((k - 0.7) / 0.3) * Math.PI) * 0.12;
    const lift = (1 - e) * 46;
    ctx.beginPath();
    ctx.ellipse(px + 1, py, 6.5 * (0.5 + 0.5 * e), 2.6 * (0.5 + 0.5 * e), 0, 0, Math.PI * 2);
    ctx.globalAlpha = 0.28 * e;
    ctx.fillStyle = "#281c12";
    ctx.fill();
    ctx.globalAlpha = 1;
    const y = py - lift, cy = y - 17;
    ctx.beginPath();
    ctx.moveTo(px, y);
    ctx.arc(px, cy, 7.5, TIP_A0, TIP_A1, false);
    ctx.closePath();
    ctx.fillStyle = "#b3202a";
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = "#fbf8f1";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, cy, 2.8, 0, Math.PI * 2);
    ctx.fillStyle = "#fbf8f1";
    ctx.fill();
  }

  // ============================================================================================== map buttons
  function zoomBy(f) {
    const base = view.zoomTarget ? view.zoomTarget.s : view.s;
    const s = clamp(base * f, view.minS, view.maxS);
    view.anim = null;
    if (reducedMotion()) { view.zoomAt(view.w / 2, view.h / 2, s / view.s); return; }
    view.zoomTarget = { s, px: view.w / 2, py: view.h / 2 };
  }
  const btn = (id, fn) => { const b = $(id); if (b) b.addEventListener("click", fn); return b; };
  const zin = btn("btn-zoom-in", () => zoomBy(1.6));
  const zout = btn("btn-zoom-out", () => zoomBy(1 / 1.6));
  // rotation +1 turns the camera clockwise, so the map itself appears to turn anticlockwise (the Q key)
  btn("btn-rot-l", () => view.setRotation(view.rot + 1));
  btn("btn-rot-r", () => view.setRotation(view.rot - 1));
  let zinOff = null, zoutOff = null;
  const syncZoomButtons = () => {
    const s = view.zoomTarget ? view.zoomTarget.s : view.s;
    const a = s >= view.maxS * 0.999, b = s <= view.minS * 1.001;
    if (a !== zinOff && zin) { zinOff = a; zin.setAttribute("aria-disabled", String(a)); }
    if (b !== zoutOff && zout) { zoutOff = b; zout.setAttribute("aria-disabled", String(b)); }
  };

  // theme
  const themeBtn = $("btn-theme");
  const meta = document.querySelector('meta[name="theme-color"]');
  function setTheme(t, save) {
    body.dataset.ui = t;
    if (themeBtn) {
      // the label, the tooltip and the icon all name what a press will do; aria-pressed as well would read backwards
      const l = t === "dark" ? "Light panels" : "Dark panels";
      themeBtn.setAttribute("aria-label", l);
      themeBtn.dataset.tip = l;
    }
    if (meta) meta.content = t === "dark" ? "#1c1a17" : "#f3eee2";
    if (save) { try { localStorage.setItem(STORE + "ui", t); } catch { /* not remembered */ } }
    cardsDirty = true;
    app.emit("theme", t);
  }
  setTheme(body.dataset.ui === "dark" ? "dark" : "light", false);
  themeBtn && themeBtn.addEventListener("click", () => setTheme(body.dataset.ui === "dark" ? "light" : "dark", true));

  // full screen, where the browser allows it (not iPhone Safari)
  const fsBtn = $("btn-fs");
  if (!document.fullscreenEnabled || !document.documentElement.requestFullscreen) { const g = $("fs-group"); if (g) g.hidden = true; }
  else if (fsBtn) {
    fsBtn.addEventListener("click", () => {
      const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen({ navigationUI: "hide" });
      if (p && p.catch) p.catch(() => toast("Full screen isn't available here"));
    });
    document.addEventListener("fullscreenchange", () => {
      const on = !!document.fullscreenElement;
      fsBtn.classList.toggle("on", on);       // swaps the icon; the label names the action, as the theme button's does
      fsBtn.setAttribute("aria-label", on ? "Leave full screen" : "Full screen");
      fsBtn.dataset.tip = on ? "Leave full screen" : "Full screen";
    });
  }

  // the brand is the way home
  const brand = document.querySelector(".bar .brand");
  brand && brand.addEventListener("click", (e) => {
    e.preventDefault();
    closeCard();
    if (view.rot) view.setRotation(0);
    view.flyTo(OVAL, { m: app.mobile ? 420 : 760 });
  });

  // ============================================================================================== share and the URL
  function viewParts() {
    const [x, y] = view.centreGround();
    const [lat, lon] = geo.toLatLon(x, y);
    return `${lat.toFixed(5)},${lon.toFixed(5)},${Math.round(clamp(view.metresAcross(), 30, 8000))},${view.rot}`;
  }
  async function copyText(text) {
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall through */ }
    try {
      const ta = Object.assign(document.createElement("textarea"), { value: text });
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }
  btn("btn-share", async () => {
    const url = `${location.origin}${location.pathname}?at=${viewParts()}`;
    if (await copyText(url)) toast("Link copied");
    else window.prompt("Copy this link to share the view:", url);
  });

  // keep #lat,lon,m,r current so a reload (or a copied address bar) lands on the same view
  let hashDirty = false, lastViewChange = 0, hashOn = false, lastHash = location.hash.slice(1);
  app.on("view", () => { hashDirty = true; lastViewChange = performance.now(); syncZoomButtons(); });
  setInterval(() => {
    if (!hashOn || !hashDirty || view.anim || performance.now() - lastViewChange < 450) return;
    hashDirty = false;
    const h = viewParts();
    carryView(h);
    if (h === lastHash) return;
    lastHash = h;
    const sp = new URLSearchParams(location.search);
    sp.delete("at");          // ?at= wins over the hash on load, so it must not linger once the view has moved
    const qs = sp.toString();
    try { history.replaceState(history.state, "", `${location.pathname}${qs ? "?" + qs : ""}#${h}`); } catch { /* sandboxed */ }
  }, 250);
  // the About page's links back to the map carry this view in the hash, so returning lands here, not on the intro
  function carryView(h) { for (const a of aboutLinks) a.setAttribute("href", `about.html#${h}`); }
  const aboutLinks = [...document.querySelectorAll('a[href^="about.html"]')];
  window.addEventListener("hashchange", () => {
    const m = /^(-?\d+\.\d+),(-?\d+\.\d+),(\d+(?:\.\d+)?)(?:,(\d))?/.exec(location.hash.slice(1));
    if (!m || location.hash.slice(1) === lastHash) return;
    lastHash = location.hash.slice(1);
    if (m[4] != null) view.setRotation(+m[4]);
    view.flyTo({ lat: +m[1], lon: +m[2] }, { m: clamp(+m[3], 30, 8000) });
  });

  // ============================================================================================== keyboard
  window.addEventListener("keydown", (e) => {
    const typing = e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable);
    if ((e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) || ((e.metaKey || e.ctrlKey) && (e.key || "").toLowerCase() === "k")) {
      e.preventDefault();
      focusSearch();
      return;
    }
    if (e.key !== "Escape") return;
    if (searchOpen) { escapeSearch(); return; }
    if (openPanelName) { closePanel(true); return; }
    const t = topCard();
    if (t) { t.close(); e.preventDefault(); }
  });
  document.addEventListener("pointerdown", (e) => {
    if (searchOpen && searchTool && !searchTool.contains(e.target)) closeSearch(true);
    if (openPanelName) {
      const p = panels[openPanelName];
      if (!p.panel.contains(e.target) && !p.btn.contains(e.target)) closePanel();
    }
  }, true);
  window.addEventListener("resize", () => {
    cardsDirty = true;
    if (openPanelName) placePanel(panels[openPanelName].panel, panels[openPanelName].btn);
    if (searchOpen && !isPhone()) placePanel(searchPanel, qEl.closest(".search"));
  });

  // ============================================================================================== loading and the first glide
  // Core opens a first visit (no view in the URL) over the whole campus and says so in app.intro; once that overview is
  // drawn we glide down to the Oval, unless the reader has already set off somewhere: the search box, the buttons and
  // the keys all work while the map is still drawing.
  const loading = $("loading");
  let intro = app.intro && !reducedMotion() ? "waiting" : "off";     // waiting → gliding → off
  let introAnim = null;
  const overview = { X: view.X, Y: view.Y, s: view.s, rot: view.rot };
  const stopIntro = () => {
    // a key or a tap in the middle of the glide leaves the view where it is (the glide owns view.anim until then)
    if (intro === "gliding" && view.anim === introAnim) view.anim = null;
    intro = "off";
  };
  if (intro !== "off") {
    app.canvas.addEventListener("pointerdown", stopIntro, { once: true });
    app.canvas.addEventListener("wheel", stopIntro, { once: true, passive: true });
    app.on("card-open", stopIntro);
    window.addEventListener("hashchange", stopIntro, { once: true });
    window.addEventListener("keydown", (e) => {
      const typing = e.target && (e.target.tagName === "INPUT" || e.target.isContentEditable);
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && /^(Arrow\w+|[-+=_qQeE])$/.test(e.key)) stopIntro();
    }, true);
  }
  // anything else that moved the view (a route, the zoom or turn buttons, the brand link) shows up as a view that has
  // left the overview core set
  const leftOverview = () => view.rot !== overview.rot || Math.abs(view.s / overview.s - 1) > 1e-3 ||
    Math.hypot(view.X - overview.X, view.Y - overview.Y) * view.s > 2;
  function startIntro() {
    if (intro !== "waiting" || cards.size || leftOverview()) { intro = "off"; return; }
    view.flyTo(OVAL, { m: app.mobile ? 420 : 760, duration: 3400 });
    introAnim = view.anim;
    intro = "gliding";
  }
  let readyDone = false;
  const onReady = () => {
    if (readyDone) return;
    readyDone = true;
    setTimeout(() => { if (loading) loading.hidden = true; }, 700);
    hashOn = true;
    carryView(viewParts());      // the view may never move (a reload of a shared link), and About should still lead back
    // build the search index while the reader is still looking, so the first keystroke answers at once
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
    idle(() => { if (!index) buildIndex(); }, { timeout: 5000 });
    // a beat for the loading screen to fade; if ui.js arrived after the first full frame this still glides
    if (intro === "waiting") setTimeout(startIntro, 350);
  };
  if (app.status && app.status.loaded) onReady(); else app.on("ready", onReady);
  // never leave the reader behind a drawing screen if the map is merely slow
  setTimeout(() => { if (!body.classList.contains("ready")) { body.classList.add("ready"); onReady(); } }, 45000);

  // ============================================================================================== app.ui
  const ui = {
    card, closeCard, toast, status, registerToggle, setCount,
    addSearchProvider(fn) { if (typeof fn === "function") providers.push(fn); },
    search,
    // extras (optional for other modules)
    showBuilding,
    openPanel: (name) => openPanel(name), closePanel: () => closePanel(),
    focusSearch,
    pin: (p) => setPin(p ? p.x : null, p && p.y, p && p.z),
    flyTo: flyToGround,
    get theme() { return body.dataset.ui; },
  };
  app.ui = ui;
  body.classList.add("ui-on");
  updateBadge();
  syncZoomButtons();
  return ui;
}
