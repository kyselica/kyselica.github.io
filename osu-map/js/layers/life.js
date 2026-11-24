// Simulated life: traffic on the street graph and people on the footpaths.
//
// None of this is live data. Cars and people are a small agent simulation whose numbers follow the campus clock (rush
// hours, class changes, quiet nights, lighter weekends). Only the neighbourhood of the view is simulated: the view plus a
// margin that is kept populated off screen, so panning finds streets already busy instead of watching them fill. Whatever
// has to appear inside the view (after a jump or a zoom) fades in rather than popping. Cars live a few minutes each and
// are replaced off screen, so the mix of busy and quiet streets keeps to the density table instead of drifting.
//
// Cars drive on the right in their lanes, respect one-ways, keep a gap to the car ahead (the Intelligent Driver Model),
// slow for turns, stop at stop signs, yield at unsignalled junctions and obey signals (each cluster of signal nodes runs
// two phases). People walk with a little sideways spread, a few cycle, and the Oval swells at class changes. Both leave
// the map only where the build cut the graph at the slab's edge, and go out of sight inside buildings.
//
// Drawing: little 3D cars back to front (strokes of paint from afar), tiny walkers, and at night beams and lamps in an
// additive layer. Whatever stands in front of a car or a person (a building, a tree, a lamp post, a bridge deck above) is
// left showing by clipping its outline out of the drawing (the tiles beneath already show it), which looks like
// app.occlude but costs a fraction of redrawing it. The outlines come from the renderer itself, so they match the art.

// ------------------------------------------------------------------------------------------------ tables
// road classes: [speed m/s, rank, cars per km per direction at the busiest hour, default width m]
const ROAD = {
  motorway: [29, 9, 40, 12], trunk: [20, 8, 34, 12], primary: [13.4, 7, 42, 13], secondary: [12.5, 6, 34, 11],
  tertiary: [11.2, 5, 24, 9.5], motorway_link: [15, 4, 8, 6.5], trunk_link: [13, 4, 7, 6.5], primary_link: [11, 4, 7, 6.5],
  secondary_link: [10, 4, 7, 6], tertiary_link: [10, 4, 5, 6], unclassified: [9, 3, 7, 7.5], residential: [8.5, 2, 7, 7.5],
  road: [8, 2, 3, 6], living_street: [4.5, 1, 0.8, 6], service: [5.5, 0, 0.7, 5], busway: [0, -1, 0, 7],
};
const MAJOR = new Set(["motorway", "trunk", "primary", "secondary", "tertiary"]);
// path classes: [people per km at the busiest hour, how much walkers like it, how much cyclists like it, width m]
const PATH = {
  pedestrian: [60, 1.2, 0.3, 5], footway: [14, 1, 0.22, 2.2], path: [5, 0.7, 0.5, 1.8], steps: [8, 0.55, 0, 2.4],
  cycleway: [3.5, 0.45, 1, 2.4], track: [2, 0.3, 0.4, 3], corridor: [2, 0.5, 0, 2], bridleway: [1, 0.3, 0.3, 2],
};

// Intelligent Driver Model: max acceleration, comfortable braking, jam gap, time headway
const ACC = 1.5, DEC = 2.4, GAP0 = 2.2, HEADWAY = 1.25;
const SQRT_AB2 = 2 * Math.sqrt(ACC * DEC);
const YELLOW = 4, ALL_RED = 2;

// the renderer's light (see render.js): a face's light is max(0, -(nu·LIGHT_U + nd·LIGHT_V)); shadows fall along SH
const LIGHT_U = -0.85, LIGHT_V = -0.52, SH_U = 0.62, SH_V = 0.36;

// vehicle shapes. Each part is a frustum along the car (metres, forward +): [rearBottom, frontBottom, rearTop, frontTop,
// halfWidthBottom, halfWidthTop, z0, z1, role, group]. Roles: body, cabin (glass sides, roof on top), dark, cargo, bed
// (a flat on the body). Parts of group 0 draw first in order; other groups draw farthest first.
const BODY = 0, CABIN = 1, DARK = 2, CARGO = 3, BED = 4;
const TYPES = [
  { name: "sedan", w: 40, L: 4.6, W: 1.82, H: 1.45, parts: [
    [-1.95, 1.95, -1.95, 1.95, 0.84, 0.84, 0.1, 0.34, DARK, 0], [-2.3, 2.3, -2.24, 2.12, 0.91, 0.89, 0.3, 0.9, BODY, 0],
    [-1.3, 0.9, -1.0, 0.28, 0.84, 0.72, 0.9, 1.45, CABIN, 0]] },
  { name: "hatchback", w: 13, L: 4.1, W: 1.76, H: 1.5, parts: [
    [-1.7, 1.7, -1.7, 1.7, 0.82, 0.82, 0.1, 0.34, DARK, 0], [-2.05, 2.05, -2.0, 1.9, 0.88, 0.86, 0.3, 0.92, BODY, 0],
    [-1.92, 0.78, -1.72, 0.08, 0.83, 0.72, 0.92, 1.5, CABIN, 0]] },
  { name: "SUV", w: 30, L: 4.8, W: 1.96, H: 1.78, parts: [
    [-2.0, 2.0, -2.0, 2.0, 0.9, 0.9, 0.12, 0.44, DARK, 0], [-2.4, 2.4, -2.36, 2.26, 0.98, 0.96, 0.4, 1.08, BODY, 0],
    [-2.24, 1.0, -2.12, 0.42, 0.92, 0.82, 1.08, 1.78, CABIN, 0]] },
  { name: "pickup", w: 9, L: 5.7, W: 2.0, H: 1.88, parts: [
    [-2.4, 2.4, -2.4, 2.4, 0.92, 0.92, 0.14, 0.46, DARK, 0], [-2.85, 2.85, -2.85, 2.7, 1.0, 0.98, 0.42, 1.12, BODY, 0],
    [-2.72, -0.66, -2.72, -0.66, 0.86, 0.86, 1.12, 1.12, BED, 0], [-0.58, 1.18, -0.52, 0.6, 0.93, 0.82, 1.12, 1.88, CABIN, 0]] },
  { name: "van", w: 6, L: 5.2, W: 2.0, H: 2.0, parts: [
    [-2.2, 2.2, -2.2, 2.2, 0.92, 0.92, 0.12, 0.4, DARK, 0], [-2.6, 2.6, -2.6, 2.42, 1.0, 0.98, 0.36, 1.08, BODY, 0],
    [-2.55, 1.55, -2.52, 0.95, 0.97, 0.9, 1.08, 2.0, CABIN, 0]] },
  { name: "delivery truck", w: 2, L: 7.2, W: 2.4, H: 3.3, parts: [
    [-3.1, 3.2, -3.1, 3.2, 1.05, 1.05, 0.12, 0.6, DARK, 0], [-3.6, 1.15, -3.6, 1.15, 1.2, 1.2, 0.6, 3.3, CARGO, 1],
    [1.28, 3.6, 1.28, 3.4, 1.15, 1.12, 0.6, 1.55, BODY, 2], [1.28, 3.4, 1.28, 2.8, 1.12, 1.0, 1.55, 2.6, CABIN, 2]] },
];
const TYPE_W = TYPES.map((t) => t.w);
const TYPE_HALF = Float32Array.from(TYPES.map((t) => t.L / 2));
// paint, weighted like real fleets: white, black, grey and silver lead; a little scarlet for the Buckeyes
const PAINT = [
  ["#ecebe6", 22], ["#34373c", 18], ["#767b80", 14], ["#b9bdc0", 13], ["#3f5f86", 8], ["#a8342e", 8], ["#2c3d57", 3],
  ["#b3202a", 1.6], ["#465f4e", 2], ["#8a7058", 2.2], ["#8fa8bf", 1.4], ["#d29b3f", 0.6], ["#e3ddcc", 2],
];
const GLASS = "#4a5763", DARKCOL = "#2c2e33", CARGOCOL = ["#efece4", "#e8e4da", "#c6ad84", "#d9d6cf"];

// people
const JACKETS = [["#b3202a", 13], ["#6d6e71", 13], ["#2f3036", 14], ["#2f3e5c", 12], ["#4d6a8f", 8], ["#5f6b4a", 6], ["#b59a72", 6],
  ["#e8e0cc", 5], ["#7b2d3a", 5], ["#3f7f86", 4], ["#efeee8", 4], ["#d7833a", 3], ["#5d4a7a", 3]];
const TROUSERS = ["#34445e", "#2b2b30", "#a8946c", "#55585e", "#3b4b6b"];
export const SKIN = ["#f1c9a5", "#e0ac84", "#c68b62", "#8d5a3b", "#5e3a25"];
export const HAIR = ["#2b221c", "#5a3c26", "#a47a4a", "#d8b26a", "#1d1a18", "#6b6b6b"];
const PACKS = ["#2f3a4a", "#4a4f55", "#7a2a2a", "#2e4a3a", "#b3202a", "#1f2226"];
const BIKE = "#3a3d42";
const PACKS_DIM = PACKS.map((h) => shadeHex(h, 0.8));
const JACKETS_DIM = JACKETS.map((j) => shadeHex(j[0], 0.82));
const JACKET_NAMES = ["scarlet", "grey", "charcoal", "navy", "blue", "olive", "tan", "cream", "maroon", "teal", "white", "orange", "purple"];

// dogs on leashes: the share of walkers out with a dog through the day (local hours; mornings and evenings are walk time)
const DOGS_WEEKDAY = [[0, 0.05], [5, 0.05], [6, 0.07], [6.5, 0.12], [7.5, 0.14], [9, 0.1], [10, 0.04], [12, 0.03], [16, 0.035],
  [17, 0.1], [18.5, 0.13], [21, 0.1], [22, 0.06], [24, 0.05]];
const DOGS_WEEKEND = [[0, 0.05], [6, 0.05], [7.5, 0.1], [9, 0.13], [11, 0.08], [13, 0.05], [16, 0.06], [17, 0.1], [18.5, 0.13],
  [21, 0.1], [22, 0.06], [24, 0.05]];
// coats: [name, main, dark (far legs, ears), light (chest, muzzle, tail tip) or null, stripes or null]
const COATS = [
  ["cream", "#ecdcb8", "#cdb68c", null, null],
  ["tan", "#c8935a", "#9f6f40", "#efdcba", null],
  ["brown", "#7f5435", "#5c3c26", null, null],
  ["black", "#3a3532", "#26221f", null, null],
  ["black-and-white", "#3a3532", "#26221f", "#f3eee4", null],
  ["brindle", "#93704a", "#6b4d31", null, "#4e3624"],
  ["grey", "#8e9298", "#6f737a", "#dcdad4", null],
];
// sizes: [body length, height at the back, leg length, head radius, leash, stride, top speed (m/s)]
const DOG_SIZE = [[0.5, 0.3, 0.14, 0.1, 1.5, 0.3, 4.2], [0.72, 0.46, 0.25, 0.125, 1.8, 0.48, 5.2], [0.95, 0.62, 0.36, 0.15, 2.0, 0.66, 5.8]];
const SIZE_NAMES = ["small", "medium", "large"];
// breed-ish looks: size, words for the card, coats allowed, ears (0 floppy, 1 pointy), tail (0 long, 1 curled, 2 stub),
// and proportions (len, leg, fluff: body thickness, snout); knit: short coats that get a sweater in the cold
const BREEDS = [
  { z: 0, d: "a scruffy little terrier-ish thing", coats: [1, 0, 6, 4, 2], ear: 1, tail: 0, knit: 1 },
  { z: 0, d: "a dachshund, or most of one", coats: [2, 1, 3], ear: 0, tail: 0, len: 1.4, leg: 0.6, knit: 1 },
  { z: 0, d: "a corgi-shaped loaf", coats: [1, 1, 5], ear: 1, tail: 2, len: 1.15, leg: 0.62, fluff: 1.15 },
  { z: 0, d: "a pocket-sized fluffball", coats: [0, 6, 3, 1], ear: 1, tail: 1, fluff: 1.3 },
  { z: 0, d: "a pug-adjacent snorter", coats: [0, 3], ear: 0, tail: 1, snout: 0.45, knit: 1 },
  { z: 1, d: "a beagle mix with a nose for business", coats: [1, 4, 2], ear: 0, tail: 0, knit: 1 },
  { z: 1, d: "a spaniel-ish sweetheart", coats: [2, 4, 0], ear: 0, tail: 0, fluff: 1.1 },
  { z: 1, d: "a border collie mix, quietly herding their human", coats: [4, 4, 3], ear: 1, tail: 0, fluff: 1.1 },
  { z: 1, d: "a heeler-ish with places to be", coats: [6, 5], ear: 1, tail: 0 },
  { z: 1, d: "a shiba-ish with opinions", coats: [1, 0, 3], ear: 1, tail: 1 },
  { z: 1, d: "a mutt of mysterious and excellent origin", coats: [0, 1, 2, 3, 4, 5, 6], ear: 0, tail: 0 },
  { z: 1, d: "a boxer-ish goofball", coats: [5, 1], ear: 0, tail: 2, snout: 0.7, knit: 1 },
  { z: 2, d: "a lab mix, mostly appetite", coats: [3, 0, 2], ear: 0, tail: 0 },
  { z: 2, d: "a golden-ish, all feathers and joy", coats: [0, 1], ear: 0, tail: 0, fluff: 1.15 },
  { z: 2, d: "a shepherd mix on patrol", coats: [1, 3], ear: 1, tail: 0 },
  { z: 2, d: "a husky-ish who would prefer it colder", coats: [6, 4], ear: 1, tail: 1, fluff: 1.1 },
  { z: 2, d: "a doodle of some kind", coats: [0, 1, 3, 6], ear: 0, tail: 0, fluff: 1.3 },
  { z: 2, d: "a greyhound-ish, mostly legs", coats: [6, 5, 3], ear: 0, tail: 0, leg: 1.25, fluff: 0.8, len: 1.05, knit: 1 },
];
const BREEDS_BY_SIZE = [0, 1, 2].map((z) => BREEDS.map((b, i) => (b.z === z ? i : -1)).filter((i) => i >= 0));
const LEASHES = ["#b3202a", "#2f3e5c", "#3f7f86", "#d7833a", "#5d4a7a", "#4f7a55", "#c2a04a"];
const SWEATERS = ["#b3202a", "#6d6e71", "#2f3e5c", "#b3202a", "#7b2d3a"];
const DOG_NAMES = ["Biscuit", "Maple", "Pickle", "Waffles", "Juniper", "Mochi", "Rosie", "Otis", "Hazel", "Bean", "Pretzel", "Clover",
  "Nugget", "Ziggy", "Luna", "Murphy", "Penny", "Toast", "Olive", "Gus", "Scout", "Cooper", "Daisy", "Bowie", "Pepper", "Tater Tot",
  "Noodle", "Fig", "Winnie", "Rufus", "Mabel", "Chester", "Peanut", "Sadie", "Moose", "Ginger", "Bruno", "Poppy", "Banjo", "Kona",
  "Dumpling", "Sprout", "Marshmallow", "Pancake", "Buckeye", "Scarlet", "Professor", "Dean", "Rigatoni", "Sir Barksalot", "Cheddar",
  "Wednesday", "Pierogi", "Bagel", "Frankie", "Lulu", "Ollie", "Jellybean", "Zeus", "Taco"];
const DOG_QUIRKS = ["a very serious sit", "greeting every single person, personally", "the zoomies, without warning",
  "carrying sticks that are far too big", "not hearing “come” (selectively)", "a world-class head tilt", "sneezing when excited",
  "ignoring squirrels (mostly)", "leaning on people's legs", "a squeaky toy collection", "stealing socks", "a dignified trot",
  "sitting on feet", "barking at exactly one mailbox"];
const DOG_SCALE = 1.15;   // drawn a little larger than life, as the walkers are, so they read at street zoom

// how busy the streets and paths are through the day (local hours → 0..1)
const CARS_WEEKDAY = [[0, 0.2], [1, 0.1], [2, 0.06], [4, 0.06], [5, 0.15], [6, 0.4], [7, 0.8], [8, 1], [9, 0.75], [10, 0.62], [11.5, 0.68],
  [13, 0.7], [15, 0.75], [16.5, 0.95], [17.5, 1], [18.5, 0.75], [20, 0.5], [22, 0.32], [24, 0.2]];
const CARS_WEEKEND = [[0, 0.25], [1, 0.15], [3, 0.07], [5, 0.06], [7, 0.15], [9, 0.35], [11, 0.55], [13, 0.62], [15, 0.6], [17, 0.55],
  [19, 0.45], [21, 0.35], [23, 0.28], [24, 0.25]];
const PEOPLE_WEEKDAY = [[0, 0.12], [1, 0.06], [2, 0.03], [5, 0.03], [6, 0.08], [7, 0.25], [8, 0.6], [9, 0.75], [12, 0.85], [14, 0.8],
  [16, 0.7], [17, 0.6], [18, 0.5], [20, 0.38], [22, 0.22], [24, 0.12]];
const PEOPLE_WEEKEND = [[0, 0.14], [2, 0.06], [4, 0.02], [7, 0.04], [9, 0.12], [11, 0.3], [14, 0.4], [17, 0.32], [19, 0.28], [22, 0.2], [24, 0.14]];

const OVAL = [39.9995, -83.0148];
const CAR_MIN_S = 0.3;       // cars are simulated and drawn from this scale (px per metre) up…
const FAR_S = 2.2;           // …as strokes of paint below this, as little 3D cars above
const PEOPLE_SIM_S = 1.6;    // people are simulated from here…
const PEOPLE_MIN_S = 2;      // …and drawn from here (as a few batched fills)…
const PEOPLE_DETAIL_S = 10;   // …one by one, shaded and cut round what stands in front, from here
const CAR_LIFE = [60, 180];  // seconds a car is kept before it may be replaced (when out of sight)
const EXIT = 8;              // graph node flag (build-data): where the graph was cut at the slab's edge
// bridge decks as render.js draws them: the deck spreads this far past the road (path) on each side; its railings stand
// about a metre above it and its edge shows a metre below
const DECK_EDGE_ROAD = 1.3, DECK_EDGE_PATH = 0.5, DECK_UP = 1.05, DECK_DOWN = 1.1;

// ------------------------------------------------------------------------------------------------ the module
export function init(app) {
  const { data, geo, view, renderer } = app;
  if (!data || !data.drive || !data.drive.edges || !data.drive.edges.length) return;
  const { SIN_T, COS_T } = geo;
  const world = data.world;
  const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");
  const CAR_CAP = app.mobile ? 300 : 700;
  const PEOPLE_CAP = app.mobile ? 380 : 900;
  // ?dogs=many: a large share of walkers out with a dog, whatever the hour and the weather (for screenshots and tests)
  const DOGS_MANY = (app.params.get("dogs") || "").trim().toLowerCase() === "many";

  // ---------------------------------------------------------------- networks
  const R = buildNet(data.drive, true, world);
  prepareDrive(R);
  buildSignals(R);
  const Wk = data.walk && data.walk.edges && data.walk.edges.length ? buildNet(data.walk, false, world) : null;

  // spawn pieces: every ~25 m of street (or path) with the number of cars (people) it holds at the busiest hour
  const [ovalX, ovalY] = geo.toXY(OVAL[0], OVAL[1]);
  const carPieces = buildPieces(R, 25, world, (e) => {
    const cls = R.eCls[e], dens = ROAD_INFO[cls][2];
    const dirs = (R.lOk[2 * e] ? 1 : 0) + (R.lOk[2 * e + 1] ? 1 : 0);
    return R.eTn[e] || !dirs ? null : [dens * dirs / 1000, 0];
  });
  const walkPieces = Wk ? buildPieces(Wk, 20, world, (e, x, y) => {
    const dens = PATH_INFO[Wk.eCls[e]][0] / 1000;
    // the campus is busier than the neighbourhoods round it; the core round the Oval swells at class changes
    const d2 = (x - ovalX) ** 2 + (y - ovalY) ** 2;
    const campus = 0.3 + 0.7 * Math.exp(-d2 / (1300 * 1300));
    const core = 3.2 * Math.exp(-d2 / (420 * 420));
    return [dens * campus, dens * core];
  }) : null;
  const carSampler = makeSampler(carPieces), walkSampler = walkPieces ? makeSampler(walkPieces) : null;

  // ---------------------------------------------------------------- the slab's edge, buildings, bridge decks
  // how far a ground point lies outside the slab (≤ 0 on it); the graphs of older data run on past the edge
  const offSlab = (x, y) => Math.max(world.x0 - x, x - world.x1, world.y0 - y, y - world.y1);
  // a dead end on the slab's edge, where traffic comes onto the map and leaves it
  const isExit = (net, n) => { const d = offSlab(net.nx[n], net.ny[n]); return net.nEdge[n] && net.deg[n] === 1 && d > -8 && d < 1; };
  const solids = makeSolids(data.buildings);
  const decks = makeDecks(data);
  // How much of something at s along link l shows: 1 in the open, 0 inside a building, fading over `fade` metres before
  // the wall (seen from behind, the building hides the approach anyway; from in front, it is a doorway).
  function outdoors(net, l, s, fade) {
    const rs = insideOf(net, l >> 1, solids);
    if (!rs) return 1;
    const se = l & 1 ? net.eLen[l >> 1] - s : s;
    let v = 1;
    for (let k = 0; k < rs.length; k += 2) {
      const d = se < rs[k] ? rs[k] - se : se > rs[k + 1] ? se - rs[k + 1] : 0;
      if (d < fade) v = Math.min(v, d / fade);
    }
    return v;
  }

  // ---------------------------------------------------------------- per-frame camera (CSS px from ground metres)
  // px = PA·x + PB·y + PE,  py = PC·x + PD·y + PF − PK·z
  let PA = 0, PB = 0, PC = 0, PD = 0, PE = 0, PF = 0, PK = 0, VW = 1, VH = 1, SCALE = 1, ROT = 0;
  let D0 = 0, D1 = 0, U0 = 0, U1 = 0;
  // Regions are rectangles in the camera's own ground frame (u across the screen, v into it), so they hug the view
  // whatever the rotation; x0…y1 is their bounding box on the ground, for the spawn grid.
  const newRegion = () => ({ u0: 0, u1: 0, v0: 0, v1: 0, x0: 0, y0: 0, x1: 0, y1: 0, U0: 0, U1: 0, D0: 0, D1: 0 });
  const region = newRegion();
  // the same camera for renderer.silhouette (CSS px = X·k − ox), and the tiles' level of detail, so outlines match them
  const CAM = { k: 1, lod: 1, ox: 0, oy: 0 };
  function setCamera() {
    const o = geo.ROTS[view.rot], s = view.s;
    ROT = view.rot; SCALE = s; VW = view.w; VH = view.h;
    U0 = o.R[0]; U1 = o.R[1]; D0 = o.D[0]; D1 = o.D[1];
    PA = s * U0; PB = s * U1; PC = -s * SIN_T * D0; PD = -s * SIN_T * D1;
    PE = VW / 2 - view.X * s; PF = VH / 2 - view.Y * s; PK = s * COS_T;
    CAM.k = s; CAM.ox = -PE; CAM.oy = -PF;
    CAM.lod = app.tiles && app.tiles.levelFor ? Math.pow(2, app.tiles.levelFor(view)) : s * view.dpr;
  }
  // the ground under the screen: u from the screen's left to right edge, v from its bottom to its top edge (plus a
  // strip beyond the top, where tall things standing past the edge still show)
  function screenRegion(out) {
    const s = SCALE;
    out.u0 = view.X - VW / 2 / s; out.u1 = view.X + VW / 2 / s;
    out.v0 = -(view.Y + VH / 2 / s) / SIN_T; out.v1 = -(view.Y - VH / 2 / s) / SIN_T + 8;
    return finishRegion(out);
  }
  function expandRegion(out, b, margin) {
    out.u0 = b.u0 - margin; out.u1 = b.u1 + margin; out.v0 = b.v0 - margin; out.v1 = b.v1 + margin;
    return finishRegion(out);
  }
  function finishRegion(out) {
    out.U0 = U0; out.U1 = U1; out.D0 = D0; out.D1 = D1;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < 4; k++) {
      const u = k & 1 ? out.u1 : out.u0, v = k & 2 ? out.v1 : out.v0;
      const x = u * U0 + v * D0, y = u * U1 + v * D1;   // (u, v) → ground: R and D are orthonormal
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    out.x0 = Math.max(world.x0, x0); out.x1 = Math.min(world.x1, x1); out.y0 = Math.max(world.y0, y0); out.y1 = Math.min(world.y1, y1);
    return out;
  }
  function inRegion(b, x, y, extra) {
    const u = x * U0 + y * U1, v = x * D0 + y * D1;
    return u >= b.u0 - extra && u <= b.u1 + extra && v >= b.v0 - extra && v <= b.v1 + extra;
  }
  // how far beyond the view the margin reaches: a quarter of the view, within limits
  const marginFor = (b, k, lo, hi) => Math.max(lo, Math.min(hi, k * Math.max(b.u1 - b.u0, b.v1 - b.v0)));

  // ---------------------------------------------------------------- clock
  let simT = 0;                      // seconds of simulation (real time: the cars do not race when ?speed= is set)
  let clockAt = -1e9, carFactor = 0.5, peopleFactor = 0.3, classChange = 0, night = 0, weatherSlow = 1, cyclistShare = 1;
  let dogShare = 0.05, dogHour = 12, dogCold = false;
  function readClock() {
    const now = app.now();
    const t = localTime(now);
    const weekend = t.dow === 0 || t.dow === 6;
    carFactor = curve(weekend ? CARS_WEEKEND : CARS_WEEKDAY, t.h);
    peopleFactor = curve(weekend ? PEOPLE_WEEKEND : PEOPLE_WEEKDAY, t.h);
    dogHour = t.h;
    {
      // fewer dogs out in heavy rain or a storm; a little rain or snow hardly stops them
      const w = app.weather || {}, wet = +w.rain || 0;
      dogShare = DOGS_MANY ? 0.5 : curve(weekend ? DOGS_WEEKEND : DOGS_WEEKDAY, t.h) * (w.storm || wet >= 0.7 ? 0.25 : wet > 0.3 ? 0.6 : 1);
      // sweater weather: the live reading, else the season
      const season = (app.tileStyle && app.tileStyle.season) || "";
      dogCold = Number.isFinite(w.tempF) && w.source !== "none" ? w.tempF < 46 : season === "winter" || season === "late-autumn";
    }
    // class changes: the paths fill from ~:50 to ~:10 past the hour on teaching days
    classChange = 0;
    if (!weekend && t.h >= 7.8 && t.h < 18.3) {
      const m = (t.h % 1) * 60;
      const bump = m >= 48 ? (m - 48) / 12 : m < 12 ? 1 - m / 12 : 0;
      classChange = 2.2 * Math.sin((Math.PI / 2) * Math.min(1, bump * 1.4));
    }
    // weather: rain and snow thin the paths and slow the streets
    const wx = app.weather || {};
    const code = +wx.code || 0;
    const wet = (code >= 51 && code <= 67) || (code >= 80 && code <= 82), snowy = (code >= 71 && code <= 77) || code === 85 || code === 86, storm = code >= 95;
    weatherSlow = snowy ? 0.8 : wet || storm ? 0.9 : 1;
    peopleFactor *= storm ? 0.35 : wet || snowy ? 0.55 : 1;
    cyclistShare = wet || snowy || storm ? 0.25 : 1;
    const n = Number.isFinite(wx.night) ? wx.night : nightFromSun(sunAltitude(now, data.origin.lat, data.origin.lon));
    const murk = code === 45 || code === 48 || storm || code === 65 || code === 75 || code === 82 ? 0.35 : 0;
    // with "Real sky & weather" off the map is drawn in daylight, where beams and lamps would only be white smudges
    night = app.layerEnabled("sky") ? Math.max(0, Math.min(1, Math.max(n, murk))) : 0;
  }
  // a switched layer (the sky) takes effect at once, not at the next once-a-second reading
  app.on("layers", () => { clockAt = -1e9; });

  // ================================================================================================ cars
  const CAP = 1024;
  const cLink = new Int32Array(CAP), cNext = new Int32Array(CAP), cPrev = new Int32Array(CAP);
  const cLane = new Uint8Array(CAP), cNextLane = new Uint8Array(CAP), cWant = new Int8Array(CAP);
  const cS = new Float32Array(CAP), cV = new Float32Array(CAP), cA = new Float32Array(CAP), cSpd = new Float32Array(CAP);
  const cOff = new Float32Array(CAP), cPrevOff = new Float32Array(CAP);
  const cType = new Uint8Array(CAP), cCol = new Uint8Array(CAP), cCargo = new Uint8Array(CAP);
  const cStopT = new Float32Array(CAP), cStopDone = new Uint8Array(CAP), cGo = new Uint8Array(CAP), cWait = new Float32Array(CAP);
  // cAlpha: fading in or out of the population; cShow: how much of the car is drawn (cAlpha, less where it goes into a
  // building or off the slab); cLife: seconds left before it may be replaced
  const cAlpha = new Float32Array(CAP), cFade = new Int8Array(CAP), cDead = new Uint8Array(CAP), cShow = new Float32Array(CAP), cLife = new Float32Array(CAP);
  const cX = new Float32Array(CAP), cY = new Float32Array(CAP), cHx = new Float32Array(CAP), cHy = new Float32Array(CAP);
  const cOccT = new Float32Array(CAP), cOcc = new Uint8Array(CAP), cBeamT = new Float32Array(CAP), cBeam = new Uint8Array(CAP), cKey = new Int32Array(CAP);
  const CAR_FIELDS = [cLink, cNext, cPrev, cLane, cNextLane, cWant, cS, cV, cA, cSpd, cOff, cPrevOff, cType, cCol, cCargo,
    cStopT, cStopDone, cGo, cWait, cAlpha, cFade, cDead, cShow, cLife, cX, cY, cHx, cHy, cOccT, cOcc, cBeamT, cBeam];
  let nCars = 0;
  const order = new Int32Array(CAP);
  const byKeyThenS = (a, b) => cKey[a] - cKey[b] || cS[a] - cS[b];
  // per-link tables rebuilt each frame (only the touched entries are reset)
  const firstOn = new Int32Array(R.LK).fill(-1), lastOn = new Int32Array(R.LK).fill(-1);
  const grpStart = new Int32Array(R.LK * 8).fill(-1), grpEnd = new Int32Array(R.LK * 8);
  const touchedL = new Int32Array(CAP), touchedK = new Int32Array(CAP);
  let nTouchedL = 0, nTouchedK = 0;
  // junction claims at unsignalled junctions: who is crossing, until when, along which axis
  const claimT = new Float32Array(R.N), claimAx = new Float32Array(R.N), claimLink = new Int32Array(R.N).fill(-1);

  const paintCum = cumulative(PAINT.map((p) => p[1])), typeCum = cumulative(TYPE_W);
  const PAINT_RAMPS = PAINT.map((p) => ramp(p[0])), GLASS_RAMP = ramp(GLASS), DARK_RAMP = ramp(DARKCOL);
  const CARGO_RAMPS = CARGOCOL.map(ramp);
  const WHITE = 0;

  function clearCars() { nCars = 0; }

  // the last car takes the place of the removed one (with its cached occluders)
  function removeCarAt(i) {
    const j = --nCars;
    if (i === j) return;
    for (let f = 0; f < CAR_FIELDS.length; f++) CAR_FIELDS[f][i] = CAR_FIELDS[f][j];
    carCand.copyWithin(i * CAND_STRIDE, j * CAND_STRIDE, (j + 1) * CAND_STRIDE);
  }

  // a car of type t on link l at s, in lane; returns its index or -1 when the spot is taken
  function spawnCar(l, s, fadeIn, lane, t) {
    if (nCars >= CAP - 1) return -1;
    // keep clear of the cars already on this link (any lane: they may be changing lanes)
    for (let j = 0; j < nCars; j++) if (cLink[j] === l && Math.abs(cS[j] - s) < 11) return -1;
    const i = nCars++;
    cType[i] = t;
    // vans and trucks are mostly white; everything else follows the fleet
    cCol[i] = (t >= 4 && Math.random() < 0.55) ? WHITE : pickCum(paintCum);
    cCargo[i] = (Math.random() * CARGOCOL.length) | 0;
    cLink[i] = l; cS[i] = s; cLane[i] = lane; cOff[i] = laneOff(l, lane); cPrev[i] = -1; cPrevOff[i] = cOff[i];
    cSpd[i] = 0.88 + Math.random() * 0.22;
    cV[i] = ROAD_INFO[R.eCls[l >> 1]][0] * cSpd[i] * 0.7; cA[i] = 0;
    cStopT[i] = 0; cStopDone[i] = 0; cGo[i] = 0; cWait[i] = 0; cDead[i] = 0; cOccT[i] = 0; cOcc[i] = 0; cBeamT[i] = 0; cBeam[i] = 0;
    cAlpha[i] = fadeIn ? 0 : 1; cFade[i] = fadeIn ? 1 : 0; cShow[i] = cAlpha[i];
    cLife[i] = CAR_LIFE[0] + Math.random() * (CAR_LIFE[1] - CAR_LIFE[0]);
    planAhead(i);
    carPose(i);
    cHx[i] = TX; cHy[i] = TY;
    cX[i] = PX; cY[i] = PY;
    return i;
  }

  // choose the link after this one, the lane wanted for it, and the lane to arrive in
  function planAhead(i) {
    const l = cLink[i];
    const m = chooseNextCar(l);
    cNext[i] = m;
    cWant[i] = -1;
    if (m < 0) { cNextLane[i] = 0; return; }
    const want = turnLane(l, m, cLane[i]);
    if (want !== cLane[i] && R.eLen[l >> 1] > 30) cWant[i] = want;
    cNextLane[i] = entryLane(l, m, want);
  }

  function chooseNextCar(l) {
    const n = R.lTo[l], a0 = R.outStart[n], a1 = R.outStart[n + 1];
    const hx = R.lHx1[l], hy = R.lHy1[l], din = Math.max(0.1, ROAD_INFO[R.eCls[l >> 1]][2]);
    let tot = 0;
    for (let k = a0; k < a1; k++) {
      const m = R.outList[k];
      let w = 0;
      if (R.lOk[m] && (m >> 1) !== (l >> 1)) {
        const c = hx * R.lHx0[m] + hy * R.lHy0[m];
        w = c > 0.8 ? 1 : c > -0.3 ? 0.34 : 0.05;
        // traffic shares out as the density table has the streets (the spawner's mix): busy roads draw more, side
        // streets and service roads less. Leaning any harder toward the big roads piles every car onto High Street.
        w *= Math.max(0.05, Math.min(1.5, ROAD_INFO[R.eCls[m >> 1]][2] / din));
      }
      WEIGHTS[k - a0] = w; tot += w;
    }
    if (tot <= 0) {
      // a dead end: turn round, unless this is the edge of the map (then the car drives off it)
      if (R.nEdge[n]) return -1;
      return R.lOk[l ^ 1] ? l ^ 1 : -1;
    }
    let r = Math.random() * tot;
    for (let k = a0; k < a1; k++) { r -= WEIGHTS[k - a0]; if (r <= 0 && WEIGHTS[k - a0] > 0) return R.outList[k]; }
    for (let k = a1 - 1; k >= a0; k--) if (WEIGHTS[k - a0] > 0) return R.outList[k];
    return -1;
  }

  // which lane of l a car wants for turning into m (0 = the kerb lane)
  function turnLane(l, m, cur) {
    const nl = R.lNl[l];
    if (nl <= 1) return 0;
    const dot = R.lHx1[l] * R.lHx0[m] + R.lHy1[l] * R.lHy0[m];
    if (dot > 0.7) return Math.min(cur, nl - 1);
    const cross = R.lHx1[l] * R.lHy0[m] - R.lHy1[l] * R.lHx0[m];
    return cross < 0 ? 0 : nl - 1;
  }
  // which lane of m a car arrives in from l: the nearest one after a turn, the same one going straight
  function entryLane(l, m, laneOnL) {
    const nl = R.lNl[m];
    if (nl <= 1) return 0;
    const dot = R.lHx1[l] * R.lHx0[m] + R.lHy1[l] * R.lHy0[m];
    if (dot > 0.7) return Math.min(laneOnL, nl - 1);
    const cross = R.lHx1[l] * R.lHy0[m] - R.lHy1[l] * R.lHx0[m];
    return cross < 0 ? 0 : nl - 1;
  }
  const laneOff = (l, lane) => R.lOff[l * 8 + Math.min(lane, R.lNl[l] - 1)];

  // ---------------------------------------------------------------- pose: on a link, or on the curve through a junction
  let PX = 0, PY = 0, TX = 1, TY = 0;
  function linkPoint(net, l, s, off) {
    const e = l >> 1, rev = l & 1, pts = net.ePts[e], cum = net.eCum[e], nrm = net.eNrm[e], L = net.eLen[e];
    let se = rev ? L - s : s;
    if (se < 0) se = 0; else if (se > L) se = L;
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= se) lo = m; else hi = m; }
    const seg = cum[hi] - cum[lo];
    const t = seg > 0 ? (se - cum[lo]) / seg : 0;
    // offsets are to the right of travel; the stored normals point left of the polyline's own direction
    const d = rev ? off : -off;
    const ax = pts[2 * lo] + nrm[2 * lo] * d, ay = pts[2 * lo + 1] + nrm[2 * lo + 1] * d;
    const bx = pts[2 * hi] + nrm[2 * hi] * d, by = pts[2 * hi + 1] + nrm[2 * hi + 1] * d;
    PX = ax + (bx - ax) * t; PY = ay + (by - ay) * t;
    // the direction of travel (left as it was on a degenerate, zero-length piece)
    const tx = bx - ax, ty = by - ay, n = Math.hypot(tx, ty);
    if (n > 1e-6) { TX = (rev ? -tx : tx) / n; TY = (rev ? -ty : ty) / n; }
  }
  // a quadratic curve from link a (offset oa) through its end node into link b (offset ob); u in 0..1
  function junctionPoint(a, oa, b, ob, u) {
    const ra = R.lR1[a], rb = R.lR0[b], n = R.lTo[a];
    linkPoint(R, a, R.eLen[a >> 1] - ra, oa); const p0x = PX, p0y = PY;
    linkPoint(R, b, rb, ob); const p2x = PX, p2y = PY;
    // control point: where the two offset lines meet (a mitre at the node), tamed for sharp turns
    const nix = R.lHy1[a], niy = -R.lHx1[a], nox = R.lHy0[b], noy = -R.lHx0[b];
    const den = Math.max(0.35, 1 + nix * nox + niy * noy);
    const cx = R.nx[n] + (nix * oa + nox * ob) / den, cy = R.ny[n] + (niy * oa + noy * ob) / den;
    const mu = 1 - u;
    PX = mu * mu * p0x + 2 * mu * u * cx + u * u * p2x;
    PY = mu * mu * p0y + 2 * mu * u * cy + u * u * p2y;
    let tx = mu * (cx - p0x) + u * (p2x - cx), ty = mu * (cy - p0y) + u * (p2y - cy);
    const m = Math.hypot(tx, ty);
    if (m > 1e-6) { TX = tx / m; TY = ty / m; }
  }
  function carPose(i) {
    const l = cLink[i], s = cS[i], L = R.eLen[l >> 1];
    const p = cPrev[i], m = cNext[i];
    if (p >= 0 && s < R.lR0[l]) {
      const ra = R.lR1[p], rb = R.lR0[l];
      junctionPoint(p, cPrevOff[i], l, cOff[i], (ra + s) / (ra + rb));
    } else if (m >= 0 && s > L - R.lR1[l]) {
      const ra = R.lR1[l], rb = R.lR0[m];
      junctionPoint(l, cOff[i], m, laneOff(m, cNextLane[i]), (s - (L - ra)) / (ra + rb));
    } else linkPoint(R, l, s, cOff[i]);
  }

  // ---------------------------------------------------------------- signals
  function sigState(c, ph) {
    const g0 = R.sG0[c], g1 = R.sG1[c], cyc = g0 + g1 + 2 * (YELLOW + ALL_RED);
    let t = (simT + R.sOff[c]) % cyc;
    if (ph === 0) return t < g0 ? 0 : t < g0 + YELLOW ? 1 : 2;
    t -= g0 + YELLOW + ALL_RED;
    return t >= 0 && t < g1 ? 0 : t >= g1 && t < g1 + YELLOW ? 1 : 2;
  }
  const axisConflict = (a, b) => { let d = Math.abs(a - b) % Math.PI; if (d > Math.PI / 2) d = Math.PI - d; return d > 0.5; };

  // cars coming up to junction n on a crossing road, soon (gap acceptance for the minor road)
  function crossTrafficNear(n, l) {
    const ax = R.lAxis[l];
    for (let k = R.outStart[n]; k < R.outStart[n + 1]; k++) {
      const a = R.outList[k] ^ 1;
      if (a === l || !R.lOk[a] || !axisConflict(R.lAxis[a], ax)) continue;
      const j = lastOn[a];
      if (j < 0) continue;
      const d = R.eLen[a >> 1] - cS[j], v = cV[j];
      if (d < 50 && v > 1.5 && d / v < 3.4) return true;
    }
    return false;
  }

  // how far ahead this car must stop (front bumper to the stop line), or Infinity to carry on
  function stopLine(i, l, dS, v, dt) {
    // signals
    const c = R.lSig[l];
    if (c >= 0 && !cGo[i]) {
      const st = sigState(c, R.lPh[l]);
      if (st === 2) { if (dS > (v * v) / 14 - 0.5) return dS; cGo[i] = 1; }
      else if (st === 1) { if (dS > (v * v) / 6.8) return dS; cGo[i] = 1; }
    }
    // stop signs: a full stop, then on
    if (R.lStop[l] && !cStopDone[i]) {
      if (v < 0.5 && dS < 3) { cStopT[i] += dt; if (cStopT[i] > 1.5) cStopDone[i] = 1; }
      if (!cStopDone[i]) return dS;
    }
    const n = R.lTo[l], next = cNext[i];
    // do not block the junction when the street beyond is backed up
    if (next >= 0 && R.deg[n] >= 3 && dS > 0.3) {
      const j = firstOn[next];
      if (j >= 0 && cS[j] - TYPE_HALF[cType[j]] < 2 * TYPE_HALF[cType[i]] + 2.5 && cV[j] < 1.5 && j !== i) return dS;
    }
    // unsignalled junctions: wait for whoever is crossing, and on the minor road for cross traffic
    if (R.nJ[n] && dS < Math.max(5, v * 1.8 + 3)) {
      let blocked = false;
      if (cWait[i] < 7) {
        if (claimT[n] > simT && claimLink[n] !== l && axisConflict(claimAx[n], R.lAxis[l])) blocked = true;
        else if (!R.lPri[l] && crossTrafficNear(n, l)) blocked = true;
      }
      if (blocked && dS > (v * v) / 10 - 0.3) return dS;
      claimT[n] = Math.max(claimT[n], simT + 1.2 + (Math.max(0, dS) + R.lR1[l]) / Math.max(v, 3));
      claimAx[n] = R.lAxis[l]; claimLink[n] = l;
    }
    return Infinity;
  }

  // ---------------------------------------------------------------- the traffic step
  function stepCars(dt) {
    // order by link, lane, position: the car ahead in a lane is the next one in this order
    for (let k = 0; k < nTouchedL; k++) { firstOn[touchedL[k]] = -1; lastOn[touchedL[k]] = -1; }
    for (let k = 0; k < nTouchedK; k++) grpStart[touchedK[k]] = -1;
    nTouchedL = 0; nTouchedK = 0;
    for (let i = 0; i < nCars; i++) { order[i] = i; cKey[i] = cLink[i] * 8 + cLane[i]; }
    const ord = order.subarray(0, nCars);
    ord.sort(byKeyThenS);
    for (let k = 0; k < nCars; k++) {
      const i = order[k], l = cLink[i], key = cKey[i];
      if (firstOn[l] < 0) { firstOn[l] = i; lastOn[l] = i; touchedL[nTouchedL++] = l; }
      else { if (cS[i] < cS[firstOn[l]]) firstOn[l] = i; if (cS[i] > cS[lastOn[l]]) lastOn[l] = i; }
      if (grpStart[key] < 0) { grpStart[key] = k; touchedK[nTouchedK++] = key; }
      grpEnd[key] = k + 1;
    }

    // accelerations (all from the same snapshot), then moves
    for (let k = 0; k < nCars; k++) {
      const i = order[k], l = cLink[i], e = l >> 1, L = R.eLen[e], s = cS[i], v = cV[i], half = TYPE_HALF[cType[i]];
      let v0 = ROAD_INFO[R.eCls[e]][0] * cSpd[i] * weatherSlow;
      const m = cNext[i];
      if (m >= 0) {
        // slow for the turn ahead
        const c = R.lHx1[l] * R.lHx0[m] + R.lHy1[l] * R.lHy0[m];
        if (c < 0.94) {
          const vt = 2.6 + 6.4 * Math.pow(Math.max(0, c), 0.7);
          const dn = Math.max(0, L - s - R.lR1[l] * 0.5);
          v0 = Math.min(v0, Math.sqrt(vt * vt + 3.2 * dn));
        }
      }
      // the car ahead: in this lane, else the last one into the next link
      let gap = Infinity, vl = 0;
      const j = k + 1 < nCars ? order[k + 1] : -1;
      if (j >= 0 && cKey[j] === cKey[i]) { gap = cS[j] - s - half - TYPE_HALF[cType[j]]; vl = cV[j]; }
      else if (m >= 0) {
        const f = firstOn[m];
        if (f >= 0 && f !== i) { gap = L - s + cS[f] - half - TYPE_HALF[cType[f]]; vl = cV[f]; }
      }
      const dS = L - R.lSB[l] - s - half;
      const stop = dS > -0.5 && dS < 90 ? stopLine(i, l, dS, v, dt) : Infinity;
      let a = ACC * (1 - Math.pow(v / Math.max(v0, 0.5), 4));
      if (gap < 200) { const ss = GAP0 + Math.max(0, v * HEADWAY + (v * (v - vl)) / SQRT_AB2); a -= ACC * (ss / Math.max(gap, 0.2)) ** 2; }
      if (stop < 200) { const ss = 0.6 + Math.max(0, v * HEADWAY + (v * v) / SQRT_AB2); a = Math.min(a, ACC * (1 - (ss / Math.max(stop, 0.05)) ** 2)); }
      if (a < -9) a = -9;
      cA[i] = a;
      // never into the car ahead, never over a line we mean to stop at
      let v1 = v + a * dt;
      if (v1 < 0) v1 = 0;
      let ds = ((v + v1) / 2) * dt;
      const lim = Math.min(gap - 0.3, stop + 0.05);
      if (ds > lim) { ds = Math.max(0, lim); v1 = Math.min(v1, ds / dt); }
      cS[i] = s + ds; cV[i] = v1;
      // a little impatience, which settles stand-offs at junctions; a long jam clears itself
      if (v1 < 0.5) cWait[i] += dt; else if (v1 > 3) cWait[i] = 0;
      if (cWait[i] > 80 && !(R.lSig[l] >= 0 && stop < Infinity)) cFade[i] = -1;
    }

    for (let i = 0; i < nCars; i++) {
      let l = cLink[i];
      // lanes: move over when there is room, then drift across
      if (cWant[i] >= 0) {
        const L = R.eLen[l >> 1], s = cS[i];
        if (s > R.lR0[l] + 2 && s < L - R.lR1[l] - 12) {
          const want = cWant[i], key = l * 8 + want;
          let free = true;
          if (grpStart[key] >= 0) for (let k = grpStart[key]; k < grpEnd[key]; k++) { const j = order[k]; if (Math.abs(cS[j] - s) < 10) { free = false; break; } }
          if (free) { cLane[i] = want; cWant[i] = -1; }
        } else if (s >= L - R.lR1[l] - 12) cWant[i] = -1;
      }
      {
        const L = R.eLen[l >> 1], s = cS[i], target = laneOff(l, cLane[i]);
        if (cOff[i] !== target && s > R.lR0[l] && s < L - R.lR1[l]) {
          const d = target - cOff[i], step = 1.3 * dt;
          cOff[i] = Math.abs(d) <= step ? target : cOff[i] + Math.sign(d) * step;
        }
      }
      // over the end of the link: into the next one
      let guard = 4;
      while (cS[i] >= R.eLen[l >> 1] && guard-- > 0) {
        const m = cNext[i];
        if (m < 0) { cDead[i] = 1; break; }
        cS[i] -= R.eLen[l >> 1];
        cPrev[i] = l; cPrevOff[i] = cOff[i];
        cLink[i] = l = m;
        cLane[i] = Math.min(cNextLane[i], R.lNl[m] - 1); cOff[i] = laneOff(m, cLane[i]);
        cStopDone[i] = 0; cStopT[i] = 0; cGo[i] = 0;
        planAhead(i);
      }
      // keep the junction claimed while crossing it
      const n0 = R.lTo[l];
      if (R.nJ[n0] && R.eLen[l >> 1] - cS[i] < R.lSB[l] + TYPE_HALF[cType[i]]) claimT[n0] = Math.max(claimT[n0], simT + 0.5);
      if (cPrev[i] >= 0 && cS[i] < R.lR0[l] + TYPE_HALF[cType[i]]) { const n1 = R.lFrom[l]; if (R.nJ[n1]) claimT[n1] = Math.max(claimT[n1], simT + 0.5); }
      // fades
      if (cFade[i] > 0) { cAlpha[i] += dt / 0.8; if (cAlpha[i] >= 1) { cAlpha[i] = 1; cFade[i] = 0; } }
      else if (cFade[i] < 0) { cAlpha[i] -= dt / 0.8; if (cAlpha[i] <= 0) cDead[i] = 1; }
      if (cNext[i] < 0) {
        // leaving the map or the street: fade over the last few metres
        const left = R.eLen[l >> 1] - cS[i];
        if (left < 10) cAlpha[i] = Math.min(cAlpha[i], left / 10);
      }
      if (cDead[i]) continue;
      cLife[i] -= dt;
      // where it is now; the heading follows the path over about a metre of travel, like a car
      carPose(i);
      // off the slab (older data runs the streets on past its edge) it fades within a few metres and is gone; into a
      // building (a garage, a drive under a block) it fades out over about its own length before the wall
      const out = offSlab(PX, PY);
      if (out >= 3) { cDead[i] = 1; continue; }
      cShow[i] = cAlpha[i] * (out > 0 ? 1 - out / 3 : 1) * outdoors(R, l, cS[i], TYPE_HALF[cType[i]] + 1);
      cX[i] = PX; cY[i] = PY;
      const k = 1 - Math.exp(-(cV[i] * dt) / 1.1);
      let hx = cHx[i] + (TX - cHx[i]) * k, hy = cHy[i] + (TY - cHy[i]) * k;
      const hn = Math.hypot(hx, hy);
      if (hn > 1e-4) { hx /= hn; hy /= hn; } else { hx = TX; hy = TY; }
      cHx[i] = hx; cHy[i] = hy;
    }
  }

  // ---------------------------------------------------------------- population: keep the region near its target
  const carRegion = newRegion();
  let carTarget = 0;
  // before the map is first shown, the streets fill at once; afterwards anything appearing in view fades in
  const instantFill = () => !app.status || !app.status.loaded;
  // is ground point (x, y) on screen, or within m px of it (more above, where tall things stand up into view)?
  function onScreen(x, y, m) {
    const px = PA * x + PB * y + PE, py = PC * x + PD * y + PF;
    return px > -m && px < VW + m && py > -m - 30 && py < VH + m;
  }
  // how far off screen a car of type t must be to be wholly out of sight: its half length and its height, in pixels
  const carMargin = (t) => 30 + (TYPE_HALF[t] + TYPES[t].H) * SCALE;
  function manageCars() {
    // the region: what is on screen plus a margin that is kept busy off screen
    expandRegion(carRegion, region, marginFor(region, 0.25, 70, 320));
    carSampler.update(carRegion, 1, 0);
    carTarget = Math.min(CAR_CAP, Math.round(carSampler.total * carFactor));
    const far = SCALE < FAR_S;
    for (let i = 0; i < nCars; i++) {
      if (cDead[i]) continue;
      // leave the region (with a little hysteresis) and you are gone
      if (!inRegion(carRegion, cX[i], cY[i], 50)) { cDead[i] = 1; continue; }
      // A car whose time is up is replaced by the spawner, which places cars by the density table: without this, the
      // mix drifts to wherever routing gathers cars (the big roads, their queues) and the side streets empty. Out of
      // sight it simply goes; in view it carries on until it leaves, except from afar, where a stroke of paint fading
      // out goes unnoticed (else a view that holds most of the region would never be renewed).
      if (cLife[i] < 0) {
        if (!onScreen(cX[i], cY[i], carMargin(cType[i]))) cDead[i] = 1;
        else if (far && cLife[i] < -60 && cFade[i] === 0) cFade[i] = -1;
      }
    }
    // too many (the clock moved on, or the view zoomed out): retire some, off screen first
    let excess = nCars - Math.round(carTarget * 1.15) - 2;
    for (let tries = 0; excess > 0 && tries < 12; tries++) {
      const i = (Math.random() * nCars) | 0;
      if (cDead[i]) continue;
      if (!onScreen(cX[i], cY[i], carMargin(cType[i]))) { cDead[i] = 1; excess--; }
      else if (cFade[i] === 0 && excess > nCars * 0.2) { cFade[i] = -1; excess--; }
    }
    for (let i = nCars - 1; i >= 0; i--) if (cDead[i]) removeCarAt(i);
    // too few: spawn, off screen unless the view just jumped (then fade in)
    const deficit = carTarget - nCars;
    if (deficit <= 0 || carSampler.total <= 0) return;
    const instant = instantFill(), jump = instant || deficit > carTarget * 0.25;
    const want = jump ? Math.min(deficit, instant ? deficit : 60) : Math.min(deficit, 4);
    let made = 0;
    for (let tries = 0; made < want && tries < want * 4; tries++) {
      const p = carSampler.sample();
      if (p < 0) break;
      const e = carPieces.pE[p];
      const se = carPieces.pS[p] + (Math.random() - 0.5) * carPieces.pLen[p];
      const fwd = R.lOk[2 * e], bwd = R.lOk[2 * e + 1];
      if (!fwd && !bwd) continue;
      let dir = fwd && bwd ? (Math.random() < 0.5 ? 0 : 1) : fwd ? 0 : 1;
      const L = R.eLen[e];
      let s = Math.max(0.5, Math.min(L - 0.5, dir ? L - se : se));
      // the car itself, chosen first, so the test below sees where it would really stand and how big it is
      const t = pickCum(typeCum);
      let lane = (Math.random() * R.lNl[2 * e + dir]) | 0;
      linkPoint(R, 2 * e + dir, s, laneOff(2 * e + dir, lane));
      if (offSlab(PX, PY) > -1) continue;
      // seen: inside the view, and not inside a building
      let vis = onScreen(PX, PY, carMargin(t)) && outdoors(R, 2 * e + dir, s, TYPE_HALF[t] + 1) > 0;
      if (vis && !jump) {
        // in plain view, cars only come in where the streets leave the map, driving onto it
        if (fwd && isExit(R, R.eA[e])) { dir = 0; s = 0.5; }
        else if (bwd && isExit(R, R.eB[e])) { dir = 1; s = 0.5; }
        else continue;
        lane = Math.min(lane, R.lNl[2 * e + dir] - 1);
      }
      if (spawnCar(2 * e + dir, s, vis && !instant, lane, t) >= 0) { made++; if (vis) stats.carsInView++; }
    }
  }

  // ================================================================================================ people
  const PCAP = 1200;
  const pLink = new Int32Array(PCAP), pNext = new Int32Array(PCAP);
  const pS = new Float32Array(PCAP), pV = new Float32Array(PCAP), pOff = new Float32Array(PCAP), pOffT = new Float32Array(PCAP), pWander = new Float32Array(PCAP);
  // pAlpha: fading in or out of the population; pShow: how much is drawn (less going indoors or off the slab)
  const pPhase = new Float32Array(PCAP), pAlpha = new Float32Array(PCAP), pFade = new Int8Array(PCAP), pDead = new Uint8Array(PCAP), pShow = new Float32Array(PCAP);
  const pJacket = new Uint8Array(PCAP), pLegs = new Uint8Array(PCAP), pSkin = new Uint8Array(PCAP), pHair = new Uint8Array(PCAP), pPack = new Int8Array(PCAP), pBike = new Uint8Array(PCAP);
  const pX = new Float32Array(PCAP), pY = new Float32Array(PCAP), pHx = new Float32Array(PCAP), pHy = new Float32Array(PCAP);
  const pBX = new Float32Array(PCAP), pBY = new Float32Array(PCAP), pOccT = new Float32Array(PCAP), pOcc = new Uint8Array(PCAP);
  // a walker's dog (one at most): pDog says there is one; pGo is how much of their pace the walker keeps (1 for everyone
  // else; a dog walker stops for a sniff or a game of fetch). The dog: who it is (an id for its card, a seed for its
  // looks and story), where it is and how it moves, what it is up to (dMode, for dT more seconds), and the ball.
  const pDog = new Uint8Array(PCAP), pGo = new Float32Array(PCAP).fill(1);
  const dId = new Uint32Array(PCAP), dSeed = new Uint32Array(PCAP), dBreed = new Uint8Array(PCAP), dCoat = new Uint8Array(PCAP), dLeash = new Uint8Array(PCAP), dKnit = new Int8Array(PCAP);
  const dX = new Float32Array(PCAP), dY = new Float32Array(PCAP), dVx = new Float32Array(PCAP), dVy = new Float32Array(PCAP), dHx = new Float32Array(PCAP), dHy = new Float32Array(PCAP);
  const dPhase = new Float32Array(PCAP), dWag = new Float32Array(PCAP), dHead = new Float32Array(PCAP), dShow = new Float32Array(PCAP);
  const dMode = new Uint8Array(PCAP), dT = new Float32Array(PCAP), dCool = new Float32Array(PCAP), dFetchT = new Float32Array(PCAP), dSide = new Int8Array(PCAP);
  const dFwd = new Float32Array(PCAP), dLat = new Float32Array(PCAP), dTx = new Float32Array(PCAP), dTy = new Float32Array(PCAP), dWhat = new Uint8Array(PCAP);
  const dLamps = new Uint16Array(PCAP), dTrees = new Uint16Array(PCAP), dThrows = new Uint8Array(PCAP), dHand = new Int8Array(PCAP);
  const bX = new Float32Array(PCAP), bY = new Float32Array(PCAP), bZ = new Float32Array(PCAP), bX0 = new Float32Array(PCAP), bY0 = new Float32Array(PCAP);
  const bT = new Float32Array(PCAP), bDur = new Float32Array(PCAP), bState = new Uint8Array(PCAP);
  const dOccT = new Float32Array(PCAP), dOcc = new Uint8Array(PCAP), dUnder = new Uint8Array(PCAP);
  const P_FIELDS = [pLink, pNext, pS, pV, pOff, pOffT, pWander, pPhase, pAlpha, pFade, pDead, pShow, pJacket, pLegs, pSkin, pHair, pPack, pBike, pX, pY, pHx, pHy, pBX, pBY, pOccT, pOcc,
    pDog, pGo, dId, dSeed, dBreed, dCoat, dLeash, dKnit, dX, dY, dVx, dVy, dHx, dHy, dPhase, dWag, dHead, dShow, dMode, dT, dCool, dFetchT, dSide, dFwd, dLat, dTx, dTy, dWhat,
    dLamps, dTrees, dThrows, dHand, bX, bY, bZ, bX0, bY0, bT, bDur, bState, dOccT, dOcc, dUnder];
  let nPeople = 0, peopleTarget = 0;
  const jacketCum = cumulative(JACKETS.map((j) => j[1]));
  const peopleRegion = newRegion();

  function removePersonAt(i) {
    const j = --nPeople;
    if (i === j) return;
    for (let f = 0; f < P_FIELDS.length; f++) P_FIELDS[f][i] = P_FIELDS[f][j];
    personCand.copyWithin(i * CAND_STRIDE, j * CAND_STRIDE, (j + 1) * CAND_STRIDE);
    if (pDog[i]) dogCand.copyWithin(i * CAND_STRIDE, j * CAND_STRIDE, (j + 1) * CAND_STRIDE);
  }
  function pathHalf(l) { return PATH_INFO[Wk.eCls[l >> 1]][3] / 2; }
  function newOffset(i, l) {
    const h = pathHalf(l);
    // keep a little to the right, spread across the path so people do not walk single file
    if (pBike[i]) return clearOfWalls(l, h * 0.45);
    const spread = Math.max(0.2, h - 0.35);
    return clearOfWalls(l, Math.max(-spread, Math.min(spread, h * 0.22 + (Math.random() - 0.5) * 2 * spread * 0.85)));
  }
  // an offset (to the right of travel on link l) moved back out of any wall beside the path (see sideOf)
  function clearOfWalls(l, off) {
    const r = sideOf(Wk, l >> 1, solids, pathHalf(l));
    if (!r) return off;
    // sideOf measures along the edge's left normal: off = d going backwards along the edge, −d going forwards
    return l & 1 ? Math.max(r[0], Math.min(r[1], off)) : Math.max(-r[1], Math.min(-r[0], off));
  }
  function spawnPerson(l, s, fadeIn, bike) {
    if (nPeople >= PCAP - 1) return -1;
    const i = nPeople++;
    pLink[i] = l; pS[i] = s; pBike[i] = bike ? 1 : 0;
    pV[i] = bike ? 3.8 + Math.random() * 2.2 : 1.1 + Math.random() * 0.45;
    pOff[i] = pOffT[i] = newOffset(i, l); pWander[i] = 3 + Math.random() * 8;
    pPhase[i] = Math.random() * 6.28;
    pJacket[i] = pickCum(jacketCum); pLegs[i] = (Math.random() * TROUSERS.length) | 0;
    pSkin[i] = (Math.random() * SKIN.length) | 0; pHair[i] = (Math.random() * HAIR.length) | 0;
    pPack[i] = Math.random() < 0.55 ? (Math.random() * PACKS.length) | 0 : -1;
    pAlpha[i] = fadeIn ? 0 : 1; pFade[i] = fadeIn ? 1 : 0; pDead[i] = 0; pOccT[i] = 0; pOcc[i] = 0;
    pNext[i] = chooseNextWalk(l, pBike[i]);
    linkPoint(Wk, l, s, pOff[i]);
    pX[i] = pBX[i] = PX; pY[i] = pBY[i] = PY; pHx[i] = TX; pHy[i] = TY;
    pShow[i] = pAlpha[i] * outdoors(Wk, l, s, 1.2);
    // some walkers are out with a dog: more of them in the neighbourhoods than in the middle of campus
    pGo[i] = 1; pDog[i] = 0;
    if (!bike) {
      const d2 = (PX - ovalX) ** 2 + (PY - ovalY) ** 2;
      if (Math.random() < dogShare * (DOGS_MANY ? 1 : 0.5 + 0.9 * (1 - Math.exp(-d2 / (450 * 450))))) addDog(i);
    }
    return i;
  }
  // a dog for walker i, its looks and habits drawn from its seed, placed beside them
  let nextDogId = 1;
  function addDog(i) {
    const seed = (Math.random() * 4294967296) >>> 0, r = (k) => hashSeed(seed, k);
    const zr = r(1), size = zr < 0.32 ? 0 : zr < 0.72 ? 1 : 2, list = BREEDS_BY_SIZE[size];
    const b = list[Math.floor(r(2) * list.length)], B = BREEDS[b];
    pDog[i] = 1; dId[i] = nextDogId++; dSeed[i] = seed; dBreed[i] = b;
    dCoat[i] = B.coats[Math.floor(r(3) * B.coats.length)]; dLeash[i] = Math.floor(r(4) * LEASHES.length);
    dKnit[i] = B.knit && r(13) < 0.7 ? Math.floor(r(14) * SWEATERS.length) : -1;
    dFwd[i] = 0.15 + r(5) * 0.85; dLat[i] = 0.5 + r(6) * 0.3; dSide[i] = r(7) < 0.5 ? -1 : 1;
    // dog walkers stroll
    pV[i] = 0.95 + Math.random() * 0.35;
    dMode[i] = TROT; dT[i] = 1 + Math.random() * 2; dCool[i] = Math.random() * 4; dFetchT[i] = 5 + Math.random() * 20;
    dLamps[i] = 0; dTrees[i] = 0; dThrows[i] = 0; bState[i] = 0; dHand[i] = 0; dWhat[i] = 0;
    dPhase[i] = Math.random() * 6.28; dWag[i] = Math.random() * 6.28; dHead[i] = 0; dOccT[i] = 0; dOcc[i] = 0; dUnder[i] = 0;
    dogTarget(i, dFwd[i], dSide[i] * dLat[i]);
    dX[i] = PX; dY[i] = PY; dVx[i] = 0; dVy[i] = 0; dHx[i] = pHx[i]; dHy[i] = pHy[i];
    dShow[i] = pShow[i];
  }
  function chooseNextWalk(l, bike) {
    const n = Wk.lTo[l], a0 = Wk.outStart[n], a1 = Wk.outStart[n + 1];
    const hx = Wk.lHx1[l], hy = Wk.lHy1[l];
    let tot = 0;
    for (let k = a0; k < a1; k++) {
      const m = Wk.outList[k];
      let w = 0;
      if ((m >> 1) !== (l >> 1)) {
        const c = hx * Wk.lHx0[m] + hy * Wk.lHy0[m];
        w = (c > 0.7 ? 1 : c > -0.2 ? 0.55 : 0.18) * PATH_INFO[Wk.eCls[m >> 1]][bike ? 2 : 1];
      }
      WEIGHTS[k - a0] = w; tot += w;
    }
    if (tot <= 0) {
      // a dead end is usually a door: most walk in; at the map's edge everyone walks off
      if (Wk.nEdge[n] || (!bike && Math.random() < 0.75)) return -1;
      return l ^ 1;
    }
    let r = Math.random() * tot;
    for (let k = a0; k < a1; k++) { r -= WEIGHTS[k - a0]; if (r <= 0 && WEIGHTS[k - a0] > 0) return Wk.outList[k]; }
    return -1;
  }
  function stepPeople(dt) {
    const still = reduceMQ.matches;
    for (let i = 0; i < nPeople; i++) {
      let l = pLink[i];
      const slow = Wk.eCls[l >> 1] === STEPS_CLS ? 0.8 : 1;
      const ds = pV[i] * slow * pGo[i] * dt;
      pS[i] += ds;
      if (!still) pPhase[i] += ds * (pBike[i] ? 1.3 : 4.6);
      // a dog walker standing still (waiting for a sniff, throwing a ball) brings their feet together
      if (pGo[i] < 0.5) { const st = Math.round(pPhase[i] / Math.PI) * Math.PI; pPhase[i] += (st - pPhase[i]) * Math.min(1, dt * 6); }
      // drift across the path now and then
      pWander[i] -= dt;
      if (pWander[i] < 0) { pWander[i] = 4 + Math.random() * 9; pOffT[i] = newOffset(i, l); }
      const d = pOffT[i] - pOff[i], st = 0.22 * dt * pGo[i];
      pOff[i] += Math.abs(d) < st ? d : Math.sign(d) * st;
      let guard = 6;
      while (pS[i] >= Wk.eLen[l >> 1] && guard-- > 0) {
        const m = pNext[i];
        if (m < 0) { pDead[i] = 1; break; }
        pS[i] -= Wk.eLen[l >> 1];
        // blend from where they were, so a change of path is a step, not a jump
        pBX[i] = pX[i]; pBY[i] = pY[i];
        pLink[i] = l = m;
        const h = pathHalf(l) - 0.25;
        if (Math.abs(pOff[i]) > h) pOff[i] = pOffT[i] = Math.sign(pOff[i]) * Math.max(0, h);
        pOff[i] = clearOfWalls(l, pOff[i]); pOffT[i] = clearOfWalls(l, pOffT[i]);
        pNext[i] = chooseNextWalk(l, pBike[i]);
      }
      if (pFade[i] > 0) { pAlpha[i] += dt / 0.7; if (pAlpha[i] >= 1) { pAlpha[i] = 1; pFade[i] = 0; } }
      else if (pFade[i] < 0) { pAlpha[i] -= dt / 0.7; if (pAlpha[i] <= 0) pDead[i] = 1; }
      if (pNext[i] < 0) { const left = Wk.eLen[l >> 1] - pS[i]; if (left < 1.6) pAlpha[i] = Math.min(pAlpha[i], left / 1.6); }
      if (pDead[i]) continue;
      linkPoint(Wk, l, pS[i], pOff[i]);
      const b = Math.min(1, pS[i] / 1.6);
      if (b < 1) { const w = b * b * (3 - 2 * b); PX = pBX[i] + (PX - pBX[i]) * w; PY = pBY[i] + (PY - pBY[i]) * w; }
      // Footways run on through buildings (corridors, arcades, a path mapped across a block): indoors nobody shows, and
      // they fade out a step before the wall. Off the slab's edge (older data) they fade within a couple of metres.
      const out = offSlab(PX, PY);
      if (out >= 1.5) { pDead[i] = 1; continue; }
      pShow[i] = pAlpha[i] * (out > 0 ? 1 - out / 1.5 : 1) * outdoors(Wk, l, pS[i], 1.2);
      pX[i] = PX; pY[i] = PY;
      const k = 1 - Math.exp(-ds / 0.6);
      let hx = pHx[i] + (TX - pHx[i]) * k, hy = pHy[i] + (TY - pHy[i]) * k;
      const hn = Math.hypot(hx, hy);
      if (hn > 1e-4) { pHx[i] = hx / hn; pHy[i] = hy / hn; }
    }
  }
  function managePeople() {
    expandRegion(peopleRegion, region, marginFor(region, 0.16, 25, 120));
    // the core round the Oval is always the busiest part, and swells further at class changes
    walkSampler.update(peopleRegion, 1, 0.5 + classChange);
    peopleTarget = Math.min(PEOPLE_CAP, Math.round(walkSampler.total * peopleFactor));
    for (let i = 0; i < nPeople; i++) if (!inRegion(peopleRegion, pX[i], pY[i], 25)) pDead[i] = 1;
    // wholly out of sight: a little beyond the edge, and a person's height above it
    const margin = 20 + 2 * PK;
    let excess = nPeople - Math.round(peopleTarget * 1.15) - 2;
    for (let tries = 0; excess > 0 && tries < 12; tries++) {
      const i = (Math.random() * nPeople) | 0;
      if (pDead[i]) continue;
      if (!onScreen(pX[i], pY[i], margin) || pShow[i] <= 0) { pDead[i] = 1; excess--; }
      else if (pFade[i] === 0 && excess > nPeople * 0.2) { pFade[i] = -1; excess--; }
    }
    for (let i = nPeople - 1; i >= 0; i--) if (pDead[i]) removePersonAt(i);
    const deficit = peopleTarget - nPeople;
    if (deficit <= 0 || walkSampler.total <= 0) return;
    const instant = instantFill(), jump = instant || deficit > peopleTarget * 0.25;
    const want = jump ? Math.min(deficit, instant ? deficit : 50) : Math.min(deficit, 3);
    let made = 0;
    for (let tries = 0; made < want && tries < want * 4; tries++) {
      const p = walkSampler.sample();
      if (p < 0) break;
      const e = walkPieces.pE[p], L = Wk.eLen[e];
      // cyclists: half of those on cycleways, and a few on the campus paths
      const cls = Wk.eCls[e];
      const bike = Math.random() < (cls === CYCLE_CLS ? 0.5 : cls === STEPS_CLS ? 0 : 0.035) * cyclistShare;
      let dir = Math.random() < 0.5 ? 0 : 1;
      let s = pieceS(walkPieces, p, L, dir);
      linkPoint(Wk, 2 * e + dir, s, 0);
      if (offSlab(PX, PY) > -0.5) continue;
      // seen: inside the view and not indoors (someone appearing inside a building just walks out of its door)
      let vis = onScreen(PX, PY, margin) && outdoors(Wk, 2 * e + dir, s, 1.2) > 0;
      if (vis && !jump) {
        // in plain view, people only come out of doors: the dead end of a path into a building
        if (Wk.deg[Wk.eA[e]] === 1) { dir = 0; s = 0.2; }
        else if (Wk.deg[Wk.eB[e]] === 1) { dir = 1; s = 0.2; }
        else continue;
      }
      if (spawnPerson(2 * e + dir, s, vis && !instant, bike) >= 0) { made++; if (vis) stats.peopleInView++; }
    }
  }
  function pieceS(P, p, L, dir) {
    const se = Math.max(0.3, Math.min(L - 0.3, P.pS[p] + (Math.random() - 0.5) * P.pLen[p]));
    return dir ? L - se : se;
  }

  // ================================================================================================ dogs
  // A dog trots beside its walker or a little ahead (its own habit, on the side it likes), following the bends of the
  // path; the leash keeps it within reach. Every second or two it may find a lamp post or a tree trunk by the path and go
  // and sniff it (the walker waits once the leash runs out), tug ahead for a few seconds, or trot back round behind its
  // human to the other side. On a path along open lawn its human may stop and throw a ball for it a few times.
  const TROT = 0, SNIFF_GO = 1, SNIFF = 2, TUG = 3, BACK = 4, F_WIND = 5, F_CHASE = 6, F_GET = 7, F_RETURN = 8, F_DROP = 9;
  const FETCH_SHARE = DOGS_MANY ? 0.35 : 0.14;
  // lamp posts and tree trunks, binned for the dogs' noses (one list: lamps first, then trees)
  const lampsArr = data.lamps || [], treesArr = data.trees || [];
  const nLampPts = lampsArr.length >> 1, nTreePts = (treesArr.length / 5) | 0;
  const SN_CELL = 12, SN_GW = Math.ceil((world.x1 - world.x0) / SN_CELL) + 1, SN_GH = Math.ceil((world.y1 - world.y0) / SN_CELL) + 1;
  const snStart = new Int32Array(SN_GW * SN_GH + 1), snList = new Int32Array(nLampPts + nTreePts);
  const snCell = (x, y) => {
    const gx = Math.floor((x - world.x0) / SN_CELL), gy = Math.floor((y - world.y0) / SN_CELL);
    return gx < 0 || gy < 0 || gx >= SN_GW || gy >= SN_GH ? -1 : gy * SN_GW + gx;
  };
  {
    const cellOf = new Int32Array(nLampPts + nTreePts);
    for (let k = 0; k < cellOf.length; k++) {
      const t = k - nLampPts;
      const c = k < nLampPts ? snCell(lampsArr[2 * k], lampsArr[2 * k + 1]) : snCell(treesArr[5 * t], treesArr[5 * t + 1]);
      cellOf[k] = c;
      if (c >= 0) snStart[c + 1]++;
    }
    for (let c = 0; c < SN_GW * SN_GH; c++) snStart[c + 1] += snStart[c];
    const fill = snStart.slice(0, SN_GW * SN_GH);
    for (let k = 0; k < cellOf.length; k++) if (cellOf[k] >= 0) snList[fill[cellOf[k]]++] = k;
  }
  // The lamp post or tree trunk nearest (px, py) within rad metres that is ahead of the walker at (wx, wy) going (hx, hy)
  // and no farther to the side than reach: 1 a lamp post, 2 a tree, 0 none (when within is set: any at all, anywhere
  // round (px, py)). Where it stands and how thick it is go in SN.
  const SN = { x: 0, y: 0, r: 0 };
  function sniffNear(px, py, rad, wx, wy, hx, hy, reach, any = false) {
    const gx0 = Math.max(0, Math.floor((px - rad - world.x0) / SN_CELL)), gx1 = Math.min(SN_GW - 1, Math.floor((px + rad - world.x0) / SN_CELL));
    const gy0 = Math.max(0, Math.floor((py - rad - world.y0) / SN_CELL)), gy1 = Math.min(SN_GH - 1, Math.floor((py + rad - world.y0) / SN_CELL));
    let best = 0, bd = rad * rad;
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
      const c = gy * SN_GW + gx;
      for (let q = snStart[c]; q < snStart[c + 1]; q++) {
        const k = snList[q], t = k - nLampPts;
        const x = k < nLampPts ? lampsArr[2 * k] : treesArr[5 * t], y = k < nLampPts ? lampsArr[2 * k + 1] : treesArr[5 * t + 1];
        const d2 = (x - px) ** 2 + (y - py) ** 2;
        if (d2 >= bd) continue;
        if (any) return 1;
        const ax = x - wx, ay = y - wy;
        if (ax * hx + ay * hy < -0.2 || Math.abs(ax * hy - ay * hx) > reach) continue;
        bd = d2; best = k < nLampPts ? 1 : 2; SN.x = x; SN.y = y;
        SN.r = k < nLampPts ? 0.09 : 0.12 + Math.min(0.16, treesArr[5 * t + 3] * 0.012);
      }
    }
    return best;
  }
  // the point ahead metres along walker i's way (into the next path when it turns), lat metres to the right of their line,
  // into PX, PY; never inside a wall (the dog crosses to the walker's line instead)
  function dogTarget(i, ahead, lat) {
    let l = pLink[i], s = pS[i] + ahead;
    const L = Wk.eLen[l >> 1];
    if (s > L && pNext[i] >= 0) { s -= L; l = pNext[i]; }
    linkPoint(Wk, l, s, pOff[i] + lat);
    if (insideSolid(solids, PX, PY)) linkPoint(Wk, l, s, pOff[i]);
  }
  function turnWalker(i, ux, uy, dt) {
    const k = 1 - Math.exp(-dt * 5);
    let hx = pHx[i] + (ux - pHx[i]) * k, hy = pHy[i] + (uy - pHy[i]) * k;
    const n = Math.hypot(hx, hy);
    if (n > 1e-4) { pHx[i] = hx / n; pHy[i] = hy / n; }
  }

  // ---------------------------------------------------------------- open lawn (for a game of fetch)
  // Lawns (grass, parks, meadows) less whatever else is mapped on them (water, plazas, car parks, beds, courts, pitches…),
  // buildings, tree trunks and lamp posts, and the roads: binned on first use.
  const LAWN_K = new Set(["grass", "park", "meadow"]);
  const BLOCK_K = new Set(["water", "plaza", "parking", "garden", "flower", "court", "pitch", "pool", "stall", "road", "bridge", "sand", "scrub", "wood", "track"]);
  let lawnG = null, roadG = null;
  function lawnGrid() {
    if (lawnG) return lawnG;
    const CELL = 50, grid = new Map(), areas = data.areas || [], bb = new Float32Array(areas.length * 4), lawn = new Uint8Array(areas.length);
    for (let i = 0; i < areas.length; i++) {
      const a = areas[i], isLawn = LAWN_K.has(a.k);
      if ((!isLawn && !BLOCK_K.has(a.k)) || !a.p || !a.p[0] || a.p[0].length < 6) continue;
      const f = a.p[0];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < f.length; k += 2) { if (f[k] < x0) x0 = f[k]; if (f[k] > x1) x1 = f[k]; if (f[k + 1] < y0) y0 = f[k + 1]; if (f[k + 1] > y1) y1 = f[k + 1]; }
      bb[4 * i] = x0; bb[4 * i + 1] = y0; bb[4 * i + 2] = x1; bb[4 * i + 3] = y1; lawn[i] = isLawn ? 1 : 0;
      for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
        const key = gx * 65536 + gy;
        let c = grid.get(key); if (!c) grid.set(key, (c = [])); c.push(i);
      }
    }
    return (lawnG = { CELL, grid, bb, lawn, areas });
  }
  function onLawn(x, y) {
    const G = lawnGrid(), c = G.grid.get(Math.floor(x / G.CELL) * 65536 + Math.floor(y / G.CELL));
    if (!c) return false;
    let on = false;
    for (let q = 0; q < c.length; q++) {
      const i = c[q], b = 4 * i;
      if (x < G.bb[b] || x > G.bb[b + 2] || y < G.bb[b + 1] || y > G.bb[b + 3]) continue;
      const p = G.areas[i].p;
      let inside = false;
      for (let h = 0; h < p.length; h++) if (ringHas(p[h], x, y)) inside = !inside;
      if (!inside) continue;
      if (!G.lawn[i]) return false;
      on = true;
    }
    return on;
  }
  function nearRoad(x, y, pad) {
    if (!roadG) {
      const CELL = 25, grid = new Map();
      for (let e = 0; e < R.E; e++) {
        if (R.eTn[e]) continue;
        const p = R.ePts[e], m = R.eW[e] / 2 + 4;
        for (let s = 0; s + 3 < p.length; s += 2) {
          const x0 = Math.min(p[s], p[s + 2]) - m, x1 = Math.max(p[s], p[s + 2]) + m, y0 = Math.min(p[s + 1], p[s + 3]) - m, y1 = Math.max(p[s + 1], p[s + 3]) + m;
          for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
            const key = gx * 65536 + gy;
            let c = grid.get(key); if (!c) grid.set(key, (c = [])); c.push(e, s);
          }
        }
      }
      roadG = { CELL, grid };
    }
    const c = roadG.grid.get(Math.floor(x / roadG.CELL) * 65536 + Math.floor(y / roadG.CELL));
    if (c) for (let q = 0; q < c.length; q += 2) {
      const e = c[q], s = c[q + 1], p = R.ePts[e];
      if (segDist(x, y, p[s], p[s + 1], p[s + 2] - p[s], p[s + 3] - p[s + 1]) <= R.eW[e] / 2 + pad) return true;
    }
    return false;
  }
  const openLawn = (x, y) => offSlab(x, y) < -3 && onLawn(x, y) && !insideSolid(solids, x, y) && !sniffNear(x, y, 1.4, 0, 0, 0, 0, 0, true) && !nearRoad(x, y, 2.5);
  // Room beside walker i to throw a ball: a landing spot 6–11 m off the path (into dTx, dTy) with open lawn all the way.
  function fetchSpot(i) {
    const cls = Wk.eCls[pLink[i] >> 1];
    if (cls !== FOOT_CLS && cls !== PATHW_CLS && cls !== PED_CLS) return false;
    linkPoint(Wk, pLink[i], pS[i], pOff[i]);
    const tx = TX, ty = TY, wx = pX[i], wy = pY[i], first = Math.random() < 0.5 ? 1 : -1;
    for (let k = 0; k < 2; k++) {
      const side = k ? -first : first, a = (Math.random() - 0.5) * 0.7, c = Math.cos(a), sn = Math.sin(a);
      const ux = ty * side, uy = -tx * side, vx = ux * c - uy * sn, vy = ux * sn + uy * c;
      const dist = 6 + Math.random() * 5;
      let ok = true;
      for (let d = 1.6; d <= dist + 1.5 && ok; d += 1.4) ok = openLawn(wx + vx * d, wy + vy * d);
      if (ok) { dTx[i] = wx + vx * dist; dTy[i] = wy + vy * dist; return true; }
    }
    return false;
  }

  // ---------------------------------------------------------------- the step
  let barkAt = -1e9;   // when a dog last barked for its ball (a cue for the soundscape, now and then)
  function stepDogs(dt) {
    if (dt <= 0) return;
    const still = reduceMQ.matches, kA = 1 - Math.exp(-dt * 7), kH = 1 - Math.exp(-dt * 9);
    for (let i = 0; i < nPeople; i++) {
      if (!pDog[i] || pDead[i]) continue;
      const B = BREEDS[dBreed[i]], Z = DOG_SIZE[B.z], leash = Z[4], half = Z[0] * (B.len || 1) * DOG_SCALE * 0.5;
      const wx = pX[i], wy = pY[i], hx = pHx[i], hy = pHy[i], wv = pV[i] * pGo[i];
      let m = dMode[i];
      dT[i] -= dt; dCool[i] -= dt; dFetchT[i] -= dt;
      // trotting along: every second or two, something new may catch its attention
      if (m === TROT && dT[i] <= 0) {
        dT[i] = 1.2 + Math.random() * 1.6;
        const r = Math.random();
        let what = 0;
        if (dCool[i] <= 0 && (what = sniffNear(wx + hx * 1.4, wy + hy * 1.4, 2.4, wx, wy, hx, hy, leash * 0.85)) && Math.random() < 0.65) {
          // nose to the post, from the walker's side of it (bX0, bY0: what it sniffs, while no ball is out)
          let ux = wx - SN.x, uy = wy - SN.y;
          const un = Math.hypot(ux, uy) || 1; ux /= un; uy /= un;
          dTx[i] = SN.x + ux * (SN.r + half + 0.02); dTy[i] = SN.y + uy * (SN.r + half + 0.02);
          bX0[i] = SN.x; bY0[i] = SN.y; dWhat[i] = what;
          m = SNIFF_GO; dT[i] = 3;
        } else if (dCool[i] <= 0 && r < 0.05) {
          // the grass by the path, for reasons of its own
          dTx[i] = dX[i] + dHx[i] * 0.25; dTy[i] = dY[i] + dHy[i] * 0.25;
          bX0[i] = dX[i] + dHx[i] * (half + 0.3); bY0[i] = dY[i] + dHy[i] * (half + 0.3); dWhat[i] = 0;
          m = SNIFF_GO; dT[i] = 1.5;
        } else if (r < 0.1) { m = TUG; dT[i] = 1.4 + Math.random() * 1.8; }
        else if (r < 0.17) { m = BACK; dT[i] = 2.4; }
        else if (dFetchT[i] <= 0 && r < 0.17 + FETCH_SHARE) {
          if (fetchSpot(i)) {
            m = F_WIND; dT[i] = 0.9; dThrows[i] = 2 + Math.floor(Math.random() * 3); bState[i] = 1;
            if (simT - barkAt > 20 && SCALE >= 5 && onScreen(dX[i], dY[i], 0)) { barkAt = simT; cue("bark", dX[i], dY[i]); }
          } else dFetchT[i] = 6 + Math.random() * 10;   // no open lawn here: look again further on
        } else if (r > 0.92) dFwd[i] = 0.15 + Math.random() * 0.85;   // a change of pace
      }
      let tx = dX[i], ty = dY[i], vmax = 2.4, fx = 0, fy = 0, go = 1, leashed = true, head = 0, wag = 9;
      let faceX = 0, faceY = 0;
      switch (m) {
        case TROT: case TUG: {
          dogTarget(i, m === TUG ? leash * 0.95 : dFwd[i], dSide[i] * (m === TUG ? 0.3 : dLat[i]));
          tx = PX; ty = PY; fx = hx * wv; fy = hy * wv; vmax = m === TUG ? 2.8 : 2.2; wag = m === TUG ? 7 : 10;
          if (m === TUG && dT[i] <= 0) { m = TROT; dT[i] = 1 + Math.random(); }
          break;
        }
        case BACK: {
          // round behind its human, to the other side
          tx = wx - hx * 0.45; ty = wy - hy * 0.45; fx = hx * wv; fy = hy * wv; wag = 12;
          if (dT[i] <= 0 || Math.hypot(tx - dX[i], ty - dY[i]) < 0.25) { dSide[i] = -dSide[i]; m = TROT; dT[i] = 1.5 + Math.random(); }
          break;
        }
        case SNIFF_GO: case SNIFF: {
          tx = dTx[i]; ty = dTy[i]; head = m === SNIFF ? 1 : 0; wag = m === SNIFF ? 3.5 : 11;
          faceX = bX0[i] - dX[i]; faceY = bY0[i] - dY[i];
          // the walker waits once the leash runs out (unless the dog is out ahead, where they are going anyway)
          const ax = dX[i] - wx, ay = dY[i] - wy;
          if (Math.hypot(ax, ay) > leash * 0.7 && ax * hx + ay * hy < leash * 0.5) go = 0;
          if (m === SNIFF_GO && Math.hypot(tx - dX[i], ty - dY[i]) < 0.1) { m = SNIFF; dT[i] = (Math.random() < 0.15 ? 5 : 1.8) + Math.random() * 3; }
          else if (dT[i] <= 0) {
            if (m === SNIFF) { if (dWhat[i] === 1) dLamps[i]++; else if (dWhat[i] === 2) dTrees[i]++; }
            m = TROT; dT[i] = 1 + Math.random() * 1.5; dCool[i] = 4 + Math.random() * 9;
          }
          break;
        }
        case F_WIND: {
          // its human turns to the lawn and winds up; the dog waits in front of them, quivering
          go = 0; leashed = false; wag = 16;
          let ux = dTx[i] - wx, uy = dTy[i] - wy;
          const un = Math.hypot(ux, uy) || 1; ux /= un; uy /= un;
          tx = wx + ux * (0.7 + half); ty = wy + uy * (0.7 + half); vmax = 2;
          faceX = ux; faceY = uy;
          turnWalker(i, ux, uy, dt);
          if (dT[i] <= 0) { bState[i] = 2; bX0[i] = wx; bY0[i] = wy; bT[i] = 0; bDur[i] = 0.35 + un / 11; bX[i] = wx; bY[i] = wy; bZ[i] = 1.7; m = F_CHASE; }
          break;
        }
        case F_CHASE: {
          go = 0; leashed = false; wag = 14; vmax = Z[6];
          let ux = dTx[i] - dX[i], uy = dTy[i] - dY[i];
          const un = Math.hypot(ux, uy);
          if (un > 1e-3) { ux /= un; uy /= un; }
          tx = dTx[i] - ux * half; ty = dTy[i] - uy * half;
          if (bState[i] === 3 && un < half + 0.15) { m = F_GET; dT[i] = 0.45; }
          break;
        }
        case F_GET: {
          go = 0; leashed = false; head = 1; wag = 14;
          faceX = dTx[i] - dX[i]; faceY = dTy[i] - dY[i];
          if (dT[i] <= 0) { bState[i] = 4; m = F_RETURN; }
          break;
        }
        case F_RETURN: {
          go = 0; leashed = false; wag = 16; vmax = Z[6] * 0.7;
          const ux = dX[i] - wx, uy = dY[i] - wy, un = Math.hypot(ux, uy) || 1;
          tx = wx + (ux / un) * (0.4 + half); ty = wy + (uy / un) * (0.4 + half);
          if (Math.hypot(tx - dX[i], ty - dY[i]) < 0.15) {
            m = F_DROP; dT[i] = 0.9; bState[i] = 3;
            bX[i] = dX[i] + dHx[i] * (half + 0.12); bY[i] = dY[i] + dHy[i] * (half + 0.12); bZ[i] = 0;
          }
          break;
        }
        case F_DROP: {
          go = 0; leashed = false; wag = 18;
          faceX = wx - dX[i]; faceY = wy - dY[i];
          if (dT[i] <= 0) {
            if (--dThrows[i] > 0 && fetchSpot(i)) { m = F_WIND; dT[i] = 0.8; bState[i] = 1; }
            else { m = TROT; bState[i] = 0; dT[i] = 1.5; dCool[i] = 3; dFetchT[i] = 60 + Math.random() * 90; }
          }
          break;
        }
      }
      // the ball in the air
      if (bState[i] === 2) {
        bT[i] += dt;
        const u = Math.min(1, bT[i] / bDur[i]), dist = Math.hypot(dTx[i] - bX0[i], dTy[i] - bY0[i]);
        bX[i] = bX0[i] + (dTx[i] - bX0[i]) * u; bY[i] = bY0[i] + (dTy[i] - bY0[i]) * u;
        bZ[i] = 1.7 * (1 - u) + 4 * (0.8 + dist * 0.16) * u * (1 - u);
        if (u >= 1) { bState[i] = 3; bZ[i] = 0; }
      }
      // move: toward the target, carried along at the walker's pace, never faster than it can run; the leash holds it
      const ex = tx - dX[i], ey = ty - dY[i];
      let vx = fx + ex * 2.6, vy = fy + ey * 2.6;
      const vn = Math.hypot(vx, vy);
      if (vn > vmax) { vx *= vmax / vn; vy *= vmax / vn; }
      dVx[i] += (vx - dVx[i]) * kA; dVy[i] += (vy - dVy[i]) * kA;
      let nx = dX[i] + dVx[i] * dt, ny = dY[i] + dVy[i] * dt;
      if (leashed) {
        const lx = nx - wx, ly = ny - wy, ld = Math.hypot(lx, ly);
        if (ld > leash) { nx = wx + (lx / ld) * leash; ny = wy + (ly / ld) * leash; }
      }
      const moved = Math.hypot(nx - dX[i], ny - dY[i]);
      dX[i] = nx; dY[i] = ny;
      // it faces the way it goes; standing, what it is about
      let ox = 0, oy = 0;
      if (moved > 0.15 * dt) { ox = dVx[i]; oy = dVy[i]; } else if (faceX || faceY) { ox = faceX; oy = faceY; }
      if (ox || oy) {
        const on = Math.hypot(ox, oy);
        let qx = dHx[i] + (ox / on - dHx[i]) * kH, qy = dHy[i] + (oy / on - dHy[i]) * kH;
        const qn = Math.hypot(qx, qy);
        if (qn > 1e-4) { dHx[i] = qx / qn; dHy[i] = qy / qn; }
      }
      if (!still) { dPhase[i] += (moved / Z[5]) * Math.PI * 2; dWag[i] += dt * wag; }
      dHead[i] += (head - dHead[i]) * Math.min(1, dt * 6);
      pGo[i] += (go - pGo[i]) * Math.min(1, dt * (go ? 2.5 : 6));
      dMode[i] = m;
      // seen as much as its walker is, and gone indoors (or off the slab) where the path goes
      const l = pLink[i], L = Wk.eLen[l >> 1];
      const along = leashed ? Math.max(0, Math.min(L, pS[i] + (dX[i] - wx) * hx + (dY[i] - wy) * hy)) : pS[i];
      const out = offSlab(dX[i], dY[i]);
      dShow[i] = out >= 1.5 ? 0 : pAlpha[i] * (out > 0 ? 1 - out / 1.5 : 1) * outdoors(Wk, l, along, 1.2);
    }
  }
  function cue(name, x, y) {
    try { if (app.sound && app.sound.cue) app.sound.cue(name, { x, y }); } catch { /* no sound: no matter */ }
  }

  // ================================================================================================ drawing
  // cached occluder candidates: CAND_N per object after a count slot
  const CAND_N = 7, CAND_STRIDE = CAND_N + 1;
  const carCand = new Int32Array(CAP * CAND_STRIDE).fill(-1), personCand = new Int32Array(PCAP * CAND_STRIDE).fill(-1);
  const dogCand = new Int32Array(PCAP * CAND_STRIDE).fill(-1);
  const vis = new Int32Array(CAP), visDepth = new Float32Array(CAP), cUnder = new Uint8Array(CAP);   // per frame, for those in view
  let nVis = 0, lastFar = false;
  const byDepth = (a, b) => visDepth[b] - visDepth[a];
  const Q = new Float64Array(16);   // projected corners of one part
  const OCC_RECT = [0, 0, 0, 0];

  // What stands between the camera and something h metres tall at ground point (x, y), anywhere it can get to in the
  // next half second (pad metres)? 0: nothing; 1: something (redraw it over the object); 2: a building hides it entirely
  // (skip it). Worked out in screen metres, so it holds while the view pans and zooms; callers cache it briefly.
  // Lamp posts are a pixel or two wide: they count only when asked (lamps), so that a walker passing one is not cut.
  // The candidates found (things in front anywhere within reach) are kept in cand[at…] (count in cand[at − 1], −1 when
  // there were too many to keep), so the per-frame clip only re-checks them instead of searching the scene again.
  function occlusionOf(x, y, half, h, pad, lamps = true, cand = null, at = 0) {
    const r = ROT, o = geo.ROTS[r], sc = app.scene, firstLamp = sc.B + sc.T;
    const U = x * o.R[0] + y * o.R[1], Y = -(x * o.D[0] + y * o.D[1]) * SIN_T, hw = half + pad;
    const X0 = U - hw, X1 = U + hw, Y0 = Y - h * COS_T - hw * SIN_T, Y1 = Y + hw * SIN_T;
    const ids = sc.query(r, "objects", X0, Y0, X1, Y1);
    let n = 0;
    for (let k = 0; k < ids.length; k++) {
      if (!(lamps || ids[k] < firstLamp) || !sc.inFront(r, ids[k], x, y, hw)) continue;
      if (cand && n < CAND_N) cand[at + n] = ids[k];
      n++;
      if (!cand) break;
    }
    if (cand) cand[at - 1] = n <= CAND_N ? n : -1;
    if (!n) return 0;
    // hidden when the box's corners, middle and top are all on buildings standing in front
    for (let k = 0; k < 6; k++) {
      const px = k === 4 || k === 5 ? U : k & 1 ? X1 : X0, py = k === 4 ? (Y0 + Y1) / 2 : k === 5 ? Y0 : k & 2 ? Y1 : Y0;
      const b = sc.pickBuilding(r, px, py);
      if (b < 0 || !sc.inFront(r, b, x, y, 0)) return 1;
    }
    return 2;
  }

  // From afar a car is a few pixels: it is either seen or hidden, by whether the middle of it is behind a building or
  // a leafy canopy standing in front. 0: seen, 2: hidden.
  function pointOcclusionOf(x, y, h) {
    const r = ROT, o = geo.ROTS[r], sc = app.scene;
    const U = x * o.R[0] + y * o.R[1], Y = -(x * o.D[0] + y * o.D[1]) * SIN_T - h * 0.5 * COS_T;
    const b = sc.pickBuilding(r, U, Y);
    if (b >= 0 && sc.inFront(r, b, x, y, 0)) return 2;
    const ids = sc.query(r, "objects", U - 0.5, Y - 0.5, U + 0.5, Y + 0.5), B = sc.B, T = sc.T, tr = data.trees;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k];
      if (id < B || id >= B + T) continue;
      const t = id - B, tx = tr[5 * t], ty = tr[5 * t + 1], rad = tr[5 * t + 2], th = tr[5 * t + 3];
      if (renderer.treeBare(t, app.tileStyle)) continue;   // bare twigs hide nothing
      if (!sc.inFront(r, id, x, y, 0)) continue;
      const cu = tx * o.R[0] + ty * o.R[1], cv = -(tx * o.D[0] + ty * o.D[1]) * SIN_T - Math.max(th - rad, th * 0.55) * COS_T;
      if ((U - cu) ** 2 + (Y - cv) ** 2 < rad * rad) return 2;
    }
    return 0;
  }

  // Occlusion by clipping. app.occlude would redraw every building and tree in front of a car (whole buildings, windows
  // and all: costly, and once per car). The tiles under us already show those objects correctly, so instead the car is
  // drawn through a clip that leaves out the outline of each thing standing in front of it: the map shows through
  // there. The outlines are the renderer's own (renderer.silhouette: walls, roofs and rooftop plant, crowns, trunks,
  // lamp posts, as the tiles paint them at this level of detail), plus the bridge decks overhead. Each piece of an outline
  // is a simple shape, so "the box minus this piece" is an even-odd path, and successive clips intersect. Same picture,
  // a small fraction of the work.
  const FRONT = new Int32Array(256);
  // The scene objects standing in front of ground point (x, y) (halfW metres across) that may cross rect, into FRONT;
  // returns how many. cand/at: the object's cached candidates (see occlusionOf), re-checked against where it is now;
  // else a fresh search.
  function frontOf(x, y, halfW, rect, lamps = true, cand = null, at = 0) {
    const sc = app.scene, r = ROT, s = SCALE, firstLamp = sc.B + sc.T;
    let n = 0;
    if (cand && cand[at - 1] >= 0) {
      for (let k = 0; k < cand[at - 1]; k++) if (sc.inFront(r, cand[at + k], x, y, halfW)) FRONT[n++] = cand[at + k];
    } else {
      const ids = sc.query(r, "objects", (rect[0] - PE) / s, (rect[1] - PF) / s, (rect[2] - PE) / s, (rect[3] - PF) / s);
      for (let k = 0; k < ids.length && n < FRONT.length; k++) if ((lamps || ids[k] < firstLamp) && sc.inFront(r, ids[k], x, y, halfW)) FRONT[n++] = ids[k];
    }
    return n;
  }
  // renderer.silhouette appends outlines as overlapping pieces, meant for one nonzero fill; a clip-out takes them one at a
  // time, so it is handed this recorder in place of a path. Crowns of leafy trees are unions of circles, which no single
  // even-odd cut can take away: without addPath the renderer gives their bounding circle instead. A conifer's outline is
  // one polygon, so its recorder takes addPath and gets the exact shape.
  const SIL = makeRecorder(), SIL_EXACT = SIL.withAddPath();
  // Draw drawFn(ctx, arg) inside rect, less the outlines of the nF scene objects in FRONT and of the nD decks in
  // DECK_HIT (their parts within reach metres of ground point (x, y)).
  function drawCut(ctx, rect, nF, nD, x, y, reach, drawFn, arg) {
    const X0 = rect[0], Y0 = rect[1], X1 = rect[2], Y1 = rect[3];
    const B = app.scene.B, T = app.scene.T, tr = data.trees;
    SIL.reset();
    for (let q = 0; q < nD; q++) deckOutline(SIL, DECK_HIT[q], x, y, reach);
    for (let q = 0; q < nF; q++) {
      const id = FRONT[q], conifer = id >= B && id < B + T && (tr[5 * (id - B) + 4] & 1);
      renderer.silhouette(conifer ? SIL_EXACT : SIL, ROT, CAM, id, app.tileStyle);
    }
    SIL.closePath();
    let cuts = 0;
    for (let p = 0; p < SIL.count; p++) if (SIL.meets(p, X0, Y0, X1, Y1)) cuts++;
    if (!cuts) { drawFn(ctx, arg); return; }
    ctx.save();
    ctx.beginPath(); ctx.rect(X0, Y0, X1 - X0, Y1 - Y0); ctx.clip();
    // the box a little larger than the clip, so its own edges never show
    for (let p = 0; p < SIL.count; p++) if (SIL.meets(p, X0, Y0, X1, Y1)) SIL.cut(ctx, p, X0 - 2, Y0 - 2, X1 + 2, Y1 + 2);
    drawFn(ctx, arg);
    ctx.restore();
  }

  // ---------------------------------------------------------------- bridge decks overhead
  // A road under a bridge is drawn in the tiles beneath the deck, but cars and people are drawn over the tiles: under a
  // deck they are cut round its outline, and from afar (a point test) they are simply hidden.
  const DECK_HIT = new Int32Array(16);
  // The decks over ground point (x, y), within reach metres of it, among those the edges of links l0…l2 pass under (the
  // link it is on, and the ones before and after it: a crossing just past a junction is on the neighbouring edge). Fills
  // DECK_HIT; returns how many.
  function decksAbove(net, l0, l1, l2, x, y, reach) {
    let n = 0;
    for (let k = 0; k < 3; k++) {
      const l = k === 0 ? l0 : k === 1 ? l1 : l2;
      if (l < 0) continue;
      const u = decksOver(net, l >> 1, decks);
      if (!u) continue;
      for (let j = 0; j < u.length && n < DECK_HIT.length; j++) {
        const id = u[j];
        let seen = false;
        for (let q = 0; q < n && !seen; q++) seen = DECK_HIT[q] === id;
        if (!seen && deckNear(id, x, y, reach)) DECK_HIT[n++] = id;
      }
    }
    return n;
  }
  function deckNear(id, x, y, reach) {
    const it = decks.items[id], p = it.pts;
    for (let s = 0; s + 3 < p.length; s += 2) if (segDist(x, y, p[s], p[s + 1], p[s + 2] - p[s], p[s + 3] - p[s + 1]) <= it.hw + reach) return true;
    return false;
  }
  // The deck's outline near (x, y) as the renderer paints it, in CSS px: each segment's strip, from its edge a metre below
  // up to its railings a metre above (a strip swept straight up the screen: the hull of its corners at both heights),
  // half a metre longer at each end so the pieces overlap at the bends.
  const HULL_IN = new Float64Array(16), HULL = new Float64Array(20);
  function deckOutline(rec, id, x, y, reach) {
    const it = decks.items[id], p = it.pts, hw = it.hw, up = DECK_UP * PK, dn = DECK_DOWN * PK;
    for (let s = 0; s + 3 < p.length; s += 2) {
      const ax = p[s], ay = p[s + 1], dx = p[s + 2] - ax, dy = p[s + 3] - ay, L = Math.hypot(dx, dy);
      if (L < 1e-6 || segDist(x, y, ax, ay, dx, dy) > hw + reach) continue;
      const ux = dx / L, uy = dy / L, nx = -uy * hw, ny = ux * hw;
      const bx = ax - ux * 0.5, by = ay - uy * 0.5, ex = ax + dx + ux * 0.5, ey = ay + dy + uy * 0.5;
      for (let c = 0; c < 4; c++) {
        const gx = (c === 0 || c === 3 ? bx : ex) + (c < 2 ? -nx : nx), gy = (c === 0 || c === 3 ? by : ey) + (c < 2 ? -ny : ny);
        const px = PA * gx + PB * gy + PE, py = PC * gx + PD * gy + PF;
        HULL_IN[4 * c] = px; HULL_IN[4 * c + 1] = py - up; HULL_IN[4 * c + 2] = px; HULL_IN[4 * c + 3] = py + dn;
      }
      const m = hull(HULL_IN, 8, HULL);
      rec.moveTo(HULL[0], HULL[1]);
      for (let q = 1; q < m; q++) rec.lineTo(HULL[2 * q], HULL[2 * q + 1]);
      rec.closePath();
    }
  }

  function drawCars(ctx) {
    nVis = 0;
    if (SCALE < CAR_MIN_S || !nCars) return;
    const t0 = performance.now();
    const m = Math.max(12, 8 * SCALE);
    for (let i = 0; i < nCars; i++) {
      if (R.eTn[cLink[i] >> 1] || cShow[i] <= 0.01) continue;   // in a tunnel, indoors, or not faded in yet
      const x = cX[i], y = cY[i];
      const px = PA * x + PB * y + PE, py = PC * x + PD * y + PF;
      if (px < -m || px > VW + m || py < -m - 4 * PK || py > VH + m) continue;
      vis[nVis++] = i;
      visDepth[i] = x * D0 + y * D1;
      // right under a bridge deck (from afar a car is either seen or not: this hides it there)
      cUnder[i] = decksAbove(R, cLink[i], cNext[i], cPrev[i], x, y, 0) > 0 ? 1 : 0;
    }
    vis.subarray(0, nVis).sort(byDepth);
    const s = SCALE;
    // what stands in front of each car: worked out every ~0.4 s (it holds while the view pans and zooms)
    const occlude = !!app.scene, far = s < FAR_S;
    if (far !== lastFar) { cOccT.fill(0); cBeamT.fill(0); lastFar = far; }
    if (occlude) for (let k = 0; k < nVis; k++) {
      const i = vis[k];
      if (simT < cOccT[i]) continue;
      cOcc[i] = far ? pointOcclusionOf(cX[i], cY[i], TYPES[cType[i]].H) : occlusionOf(cX[i], cY[i], TYPE_HALF[cType[i]], TYPES[cType[i]].H, 1 + cV[i] * 0.5, true, carCand, i * CAND_STRIDE + 1);
      cOccT[i] = simT + 0.35 + Math.random() * 0.1;
    }
    if (s < FAR_S) { drawCarsFar(ctx, s); perf.carDraw += performance.now() - t0; return; }
    for (let k = 0; k < nVis; k++) {
      const i = vis[k];
      if (occlude && cOcc[i] === 2) continue;   // behind a building: nothing of it shows
      const half = TYPE_HALF[cType[i]], rect = carRect(i);
      const nD = decksAbove(R, cLink[i], cNext[i], cPrev[i], cX[i], cY[i], half + 1);
      const nF = occlude && cOcc[i] === 1 ? frontOf(cX[i], cY[i], half, rect, true, carCand, i * CAND_STRIDE + 1) : 0;
      if (nF || nD) drawCut(ctx, rect, nF, nD, cX[i], cY[i], half + 1, drawCarAlpha, i);
      else drawCarAlpha(ctx, i);
    }
    ctx.globalAlpha = 1;
    perf.carDraw += performance.now() - t0;
  }

  // From afar a car is a short stroke of its paint, a little larger than life so the streets read as busy; one path
  // per paint for all of them (they are a few pixels long: their order does not show). Cars fading in or out are drawn
  // one by one after them, each at its own alpha.
  const farBucket = new Int32Array(CAP), farStart = new Int32Array(PAINT.length + 1), farFill = new Int32Array(PAINT.length);
  const FAR_SOLID = 0.99;
  const farSeen = (i) => cOcc[i] === 0 && !cUnder[i];
  function drawCarsFar(ctx, s) {
    farStart.fill(0);
    const inBatch = (i) => cShow[i] >= FAR_SOLID && farSeen(i);
    for (let k = 0; k < nVis; k++) if (inBatch(vis[k])) farStart[cCol[vis[k]] + 1]++;
    for (let c = 0; c < PAINT.length; c++) farStart[c + 1] += farStart[c];
    for (let c = 0; c < PAINT.length; c++) farFill[c] = farStart[c];
    for (let k = 0; k < nVis; k++) { const i = vis[k]; if (inBatch(i)) farBucket[farFill[cCol[i]]++] = i; }
    const minLen = s < 0.6 ? 3 : 5.2;
    const shadowW = Math.max(s < 0.6 ? 1.9 : 3, 2 * s), paintW = Math.max(s < 0.6 ? 1.5 : 2.4, 1.8 * s);
    ctx.lineCap = "butt";
    // a soft shadow line first, so pale cars still read against pale roads
    ctx.lineWidth = shadowW;
    ctx.strokeStyle = "rgba(38,50,60,.28)";
    ctx.beginPath();
    for (let q = 0; q < farStart[PAINT.length]; q++) farSegment(ctx, farBucket[q], minLen, 0.6, 0.5);
    ctx.stroke();
    ctx.lineWidth = paintW;
    for (let c = 0; c < PAINT.length; c++) {
      if (farStart[c + 1] === farStart[c]) continue;
      ctx.strokeStyle = PAINT_RAMPS[c][13];
      ctx.beginPath();
      for (let q = farStart[c]; q < farStart[c + 1]; q++) farSegment(ctx, farBucket[q], minLen, 0, -0.7);
      ctx.stroke();
    }
    for (let k = 0; k < nVis; k++) {
      const i = vis[k];
      if (cShow[i] >= FAR_SOLID || !farSeen(i)) continue;
      ctx.globalAlpha = cShow[i];
      ctx.lineWidth = shadowW; ctx.strokeStyle = "rgba(38,50,60,.28)";
      ctx.beginPath(); farSegment(ctx, i, minLen, 0.6, 0.5); ctx.stroke();
      ctx.lineWidth = paintW; ctx.strokeStyle = PAINT_RAMPS[cCol[i]][13];
      ctx.beginPath(); farSegment(ctx, i, minLen, 0, -0.7); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function farSegment(ctx, i, minLen, dx, dz) {
    const T = TYPES[cType[i]];
    let hx = (PA * cHx[i] + PB * cHy[i]) * T.L, hy = (PC * cHx[i] + PD * cHy[i]) * T.L;
    const len = Math.hypot(hx, hy);
    if (len < minLen) { const k = minLen / Math.max(0.01, len); hx *= k; hy *= k; }
    const px = PA * cX[i] + PB * cY[i] + PE + dx, py = PC * cX[i] + PD * cY[i] + PF + dz;
    ctx.moveTo(px - hx / 2, py - hy / 2); ctx.lineTo(px + hx / 2, py + hy / 2);
  }

  function drawCarAlpha(c, i) { c.globalAlpha = cShow[i]; drawCar(c, i, SCALE); c.globalAlpha = 1; }

  // the car's screen box (CSS px), for clipping the redraw of what stands in front of it
  function carRect(i) {
    const half = TYPE_HALF[cType[i]], t = TYPES[cType[i]];
    const px = PA * cX[i] + PB * cY[i] + PE, py = PC * cX[i] + PD * cY[i] + PF;
    const rx = half * SCALE + 2, up = t.H * PK + half * SCALE * SIN_T + 2, dn = half * SCALE * SIN_T + 2;
    OCC_RECT[0] = px - rx; OCC_RECT[1] = py - up; OCC_RECT[2] = px + rx; OCC_RECT[3] = py + dn;
    return OCC_RECT;
  }

  function drawCar(ctx, i, s) {
    const T = TYPES[cType[i]];
    const fx = cHx[i], fy = cHy[i], rx = fy, ry = -fx;             // forward and right, in ground metres
    const cx = PA * cX[i] + PB * cY[i] + PE, cy = PC * cX[i] + PD * cY[i] + PF;
    const Fx = PA * fx + PB * fy, Fy = PC * fx + PD * fy, Rx = PA * rx + PB * ry, Ry = PC * rx + PD * ry;
    const fd = fx * D0 + fy * D1, fu = fx * U0 + fy * U1, rd = rx * D0 + ry * D1, ru = rx * U0 + ry * U1;
    const paint = PAINT_RAMPS[cCol[i]];
    // a soft shadow, cast the same way as the buildings'
    {
      const hs = T.H * 0.5, sx = (SH_U * U0 + SH_V * D0) * hs, sy = (SH_U * U1 + SH_V * D1) * hs;
      const ox = cx + PA * sx + PB * sy, oy = cy + PC * sx + PD * sy;
      const a = T.L / 2 + 0.15, b = T.W / 2 + 0.12;
      ctx.fillStyle = "rgba(38,50,60,.24)";
      ctx.beginPath();
      ctx.moveTo(ox + Fx * a + Rx * b, oy + Fy * a + Ry * b); ctx.lineTo(ox + Fx * a - Rx * b, oy + Fy * a - Ry * b);
      ctx.lineTo(ox - Fx * a - Rx * b, oy - Fy * a - Ry * b); ctx.lineTo(ox - Fx * a + Rx * b, oy - Fy * a + Ry * b);
      ctx.closePath(); ctx.fill();
    }
    const parts = T.parts, np = parts.length;
    const detail = s >= 3;
    // group 0 first in order, then the other groups farthest first (only the truck has them)
    if (np === 4 && parts[1][9] === 1) {
      if (detail) underbody(ctx, parts[0], cx, cy, Fx, Fy, Rx, Ry, fd, rd);
      const cargoFirst = ((parts[1][0] + parts[1][1]) / 2) * fd > ((parts[2][0] + parts[2][1]) / 2) * fd;
      if (cargoFirst) drawPart(ctx, parts[1], i, cx, cy, Fx, Fy, Rx, Ry, fd, fu, rd, ru, paint, detail);
      drawPart(ctx, parts[2], i, cx, cy, Fx, Fy, Rx, Ry, fd, fu, rd, ru, paint, detail);
      drawPart(ctx, parts[3], i, cx, cy, Fx, Fy, Rx, Ry, fd, fu, rd, ru, paint, detail);
      if (!cargoFirst) drawPart(ctx, parts[1], i, cx, cy, Fx, Fy, Rx, Ry, fd, fu, rd, ru, paint, detail);
    } else {
      for (let p = 0; p < np; p++) {
        if (parts[p][8] === DARK) { if (detail) underbody(ctx, parts[p], cx, cy, Fx, Fy, Rx, Ry, fd, rd); continue; }
        drawPart(ctx, parts[p], i, cx, cy, Fx, Fy, Rx, Ry, fd, fu, rd, ru, paint, detail);
      }
    }
    // lamps on the nose and tail, when close enough to see them
    if (s >= 4.5) {
      const body = parts[1][8] === BODY ? parts[1] : parts[2];
      const zl = body[6] + (body[7] - body[6]) * 0.55, zh = zl + 0.16;
      const braking = cA[i] < -0.6 || cV[i] < 0.3;
      if (fd < 0) lampPair(ctx, cx, cy, Fx, Fy, Rx, Ry, body[1] + 0.01, body[4], zl, zh, "#f6f1e1");
      else lampPair(ctx, cx, cy, Fx, Fy, Rx, Ry, -T.L / 2 - 0.01, T.W / 2, zl, zh, braking ? "#ff4a3a" : "#b9312b");
    }
  }

  // wheels and the shadow under the sills: the two camera-facing sides of a dark box, one fill
  function underbody(ctx, P, cx, cy, Fx, Fy, Rx, Ry, fd, rd) {
    const a0 = P[0], a1 = P[1], w = P[4], zb = PK * P[6], zt = PK * P[7];
    const ea = fd < 0 ? a1 : a0, ew = rd < 0 ? w : -w;
    ctx.fillStyle = DARKCOL;
    ctx.beginPath();
    // the end face (front or back, whichever we see) and the side face
    ctx.moveTo(cx + Fx * ea - Rx * w, cy + Fy * ea - Ry * w - zb); ctx.lineTo(cx + Fx * ea + Rx * w, cy + Fy * ea + Ry * w - zb);
    ctx.lineTo(cx + Fx * ea + Rx * w, cy + Fy * ea + Ry * w - zt); ctx.lineTo(cx + Fx * ea - Rx * w, cy + Fy * ea - Ry * w - zt); ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx + Fx * a0 + Rx * ew, cy + Fy * a0 + Ry * ew - zb); ctx.lineTo(cx + Fx * a1 + Rx * ew, cy + Fy * a1 + Ry * ew - zb);
    ctx.lineTo(cx + Fx * a1 + Rx * ew, cy + Fy * a1 + Ry * ew - zt); ctx.lineTo(cx + Fx * a0 + Rx * ew, cy + Fy * a0 + Ry * ew - zt); ctx.closePath();
    ctx.fill();
  }

  function lampPair(ctx, cx, cy, Fx, Fy, Rx, Ry, a, w, z0, z1, col) {
    ctx.fillStyle = col;
    ctx.beginPath();
    for (let side = -1; side <= 1; side += 2) {
      const c0 = side * (w - 0.08), c1 = side * (w - 0.42);
      ctx.moveTo(cx + Fx * a + Rx * c0, cy + Fy * a + Ry * c0 - PK * z0);
      ctx.lineTo(cx + Fx * a + Rx * c1, cy + Fy * a + Ry * c1 - PK * z0);
      ctx.lineTo(cx + Fx * a + Rx * c1, cy + Fy * a + Ry * c1 - PK * z1);
      ctx.lineTo(cx + Fx * a + Rx * c0, cy + Fy * a + Ry * c0 - PK * z1);
      ctx.closePath();
    }
    ctx.fill();
  }

  // one frustum of a car: its camera-facing sides, then its top
  function drawPart(ctx, P, i, cx, cy, Fx, Fy, Rx, Ry, fd, fu, rd, ru, paint, detail) {
    const r0 = P[0], f0 = P[1], r1 = P[2], f1 = P[3], w0 = P[4], w1 = P[5], z0 = P[6], z1 = P[7], role = P[8];
    const sideRamp = role === BODY ? paint : role === CABIN ? GLASS_RAMP : role === DARK ? DARK_RAMP : role === CARGO ? CARGO_RAMPS[cCargo[i]] : paint;
    const topRamp = role === CABIN || role === BED ? paint : sideRamp;
    // corners: 0 rear-left, 1 front-left, 2 front-right, 3 rear-right; 4–7 the same on top
    const zb = PK * z0, zt = PK * z1;
    Q[0] = cx + Fx * r0 - Rx * w0; Q[1] = cy + Fy * r0 - Ry * w0 - zb;
    Q[2] = cx + Fx * f0 - Rx * w0; Q[3] = cy + Fy * f0 - Ry * w0 - zb;
    Q[4] = cx + Fx * f0 + Rx * w0; Q[5] = cy + Fy * f0 + Ry * w0 - zb;
    Q[6] = cx + Fx * r0 + Rx * w0; Q[7] = cy + Fy * r0 + Ry * w0 - zb;
    Q[8] = cx + Fx * r1 - Rx * w1; Q[9] = cy + Fy * r1 - Ry * w1 - zt;
    Q[10] = cx + Fx * f1 - Rx * w1; Q[11] = cy + Fy * f1 - Ry * w1 - zt;
    Q[12] = cx + Fx * f1 + Rx * w1; Q[13] = cy + Fy * f1 + Ry * w1 - zt;
    Q[14] = cx + Fx * r1 + Rx * w1; Q[15] = cy + Fy * r1 + Ry * w1 - zt;
    if (role !== BED && z1 > z0) {
      const hgt = z1 - z0;
      const sF = (f0 - f1) / hgt, sR = (r1 - r0) / hgt, sS = (w0 - w1) / hgt;
      // a face shows when its (tilted) normal points back at the camera
      if (fd * COS_T - sF * SIN_T < 0) face(ctx, 1, 2, 6, 5, sideRamp, fu, fd, sF);
      if (-fd * COS_T - sR * SIN_T < 0) face(ctx, 3, 0, 4, 7, sideRamp, -fu, -fd, sR);
      if (rd * COS_T - sS * SIN_T < 0) face(ctx, 2, 3, 7, 6, sideRamp, ru, rd, sS);
      if (-rd * COS_T - sS * SIN_T < 0) face(ctx, 0, 1, 5, 4, sideRamp, -ru, -rd, sS);
    }
    ctx.fillStyle = topRamp[role === BED ? 6 : role === CABIN ? 15 : 14];
    ctx.beginPath();
    ctx.moveTo(Q[8], Q[9]); ctx.lineTo(Q[10], Q[11]); ctx.lineTo(Q[12], Q[13]); ctx.lineTo(Q[14], Q[15]);
    ctx.closePath(); ctx.fill();
  }
  function face(ctx, a, b, c, d, rampArr, nu, nd, tilt) {
    const light = Math.max(0, -(nu * LIGHT_U + nd * LIGHT_V));
    const f = 0.72 + 0.3 * light + 0.16 * Math.min(1, tilt);
    ctx.fillStyle = rampArr[Math.max(0, Math.min(RAMP_N - 1, Math.round((f - RAMP_0) / RAMP_STEP)))];
    ctx.beginPath();
    ctx.moveTo(Q[2 * a], Q[2 * a + 1]); ctx.lineTo(Q[2 * b], Q[2 * b + 1]); ctx.lineTo(Q[2 * c], Q[2 * c + 1]); ctx.lineTo(Q[2 * d], Q[2 * d + 1]);
    ctx.closePath(); ctx.fill();
  }

  // ---------------------------------------------------------------- vehicle lights (additive, over the night tint)
  const sprites = makeSprites();
  function drawCarLights(ctx) {
    if (night < 0.04 || !nVis || SCALE < CAR_MIN_S || !sprites) return;
    const t0 = performance.now();
    const s = SCALE, k = night;
    ctx.globalCompositeOperation = "lighter";
    if (s < FAR_S) {
      // from afar: a warm point at the nose of each car and a red one at its tail, as a soft halo and a bright core;
      // all cars in four fills, then those fading in or out one by one at their own alpha
      for (let pass = 0; pass < 4; pass++) {
        const head = pass < 2, halo = !(pass & 1);
        if (halo && s < 0.8) continue;   // too far for a halo to read
        const r = (halo ? 2.6 : 1.1) * Math.max(1, s * 0.9) * (head ? 1 : 0.75), base = k * (halo ? 0.28 : 0.85);
        ctx.globalAlpha = base;
        ctx.fillStyle = head ? "rgb(255,232,180)" : "rgb(255,70,55)";
        ctx.beginPath();
        for (let q = 0; q < nVis; q++) { const i = vis[q]; if (cShow[i] >= FAR_SOLID && farSeen(i)) farLight(ctx, i, head, halo, r, s); }
        ctx.fill();
        for (let q = 0; q < nVis; q++) {
          const i = vis[q];
          if (cShow[i] >= FAR_SOLID || !farSeen(i)) continue;
          ctx.globalAlpha = base * cShow[i];
          ctx.beginPath(); farLight(ctx, i, head, halo, r, s); ctx.fill();
        }
      }
    } else {
      // near: a beam on the road ahead and the lamps themselves, each cut round whatever stands in front of it and
      // the bridge decks above
      for (let q = 0; q < nVis; q++) {
        const i = vis[q];
        if (cOcc[i] === 2) continue;
        const half = TYPE_HALF[cType[i]];
        // the beam's middle, about ten metres ahead
        const bx = cX[i] + cHx[i] * (half + 9), by = cY[i] + cHy[i] * (half + 9);
        if (simT >= cBeamT[i]) {
          cBeam[i] = occlusionOf(bx, by, 10, 0.3, 1 + cV[i] * 0.5);
          cBeamT[i] = simT + 0.35 + Math.random() * 0.1;
        }
        if (cBeam[i] !== 2) {
          const nD = decksAbove(R, cLink[i], cNext[i], -1, bx, by, 10);
          if (cBeam[i] === 0 && !nD) drawBeam(ctx, i);
          else { const rect = beamRect(i); drawCut(ctx, rect, cBeam[i] === 1 ? frontOf(bx, by, 10, rect) : 0, nD, bx, by, 10, drawBeam, i); }
        }
        const rect = carRect(i);
        const nD = decksAbove(R, cLink[i], cNext[i], cPrev[i], cX[i], cY[i], half + 1);
        const nF = cOcc[i] === 1 ? frontOf(cX[i], cY[i], half, rect, true, carCand, i * CAND_STRIDE + 1) : 0;
        if (nF || nD) drawCut(ctx, rect, nF, nD, cX[i], cY[i], half + 1, drawLamps, i);
        else drawLamps(ctx, i);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    perf.lightDraw += performance.now() - t0;
  }
  // a far car's head- or tail-light, added to the current path: halos are soft discs; the bright cores are a pixel or
  // two, where a square looks the same and costs less
  function farLight(ctx, i, head, halo, r, s) {
    const T = TYPES[cType[i]], f = (head ? 0.5 : -0.5) * Math.max(T.L, 4.4 / Math.max(s, 0.3));
    const px = PA * (cX[i] + cHx[i] * f) + PB * (cY[i] + cHy[i] * f) + PE, py = PC * (cX[i] + cHx[i] * f) + PD * (cY[i] + cHy[i] * f) + PF - 0.7;
    if (halo) { ctx.moveTo(px + r, py); ctx.arc(px, py, r, 0, Math.PI * 2); } else ctx.rect(px - r, py - r, 2 * r, 2 * r);
  }

  // the beam, drawn in the car's own ground frame (x forward, y to the right, metres) so it lies flat on the road
  function drawBeam(ctx, i) {
    const dpr = view.dpr, half = TYPE_HALF[cType[i]], fx = cHx[i], fy = cHy[i], rx = fy, ry = -fx;
    const m11 = PA * fx + PB * fy, m21 = PC * fx + PD * fy, m12 = PA * rx + PB * ry, m22 = PC * rx + PD * ry;
    const tx = PA * cX[i] + PB * cY[i] + PE, ty = PC * cX[i] + PD * cY[i] + PF;
    ctx.setTransform(dpr * m11, dpr * m21, dpr * m12, dpr * m22, dpr * tx, dpr * ty);
    ctx.globalAlpha = cShow[i] * night * 0.9;
    ctx.drawImage(sprites.cone, half - 0.4, -4.5, 19, 9);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function beamRect(i) {
    const half = TYPE_HALF[cType[i]], fx = cHx[i], fy = cHy[i], rx = fy, ry = -fx;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < 4; k++) {
      const a = k & 1 ? half + 19 : half - 0.4, c = k & 2 ? 4.5 : -4.5;
      const x = cX[i] + fx * a + rx * c, y = cY[i] + fy * a + ry * c;
      const px = PA * x + PB * y + PE, py = PC * x + PD * y + PF;
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
    }
    OCC_RECT[0] = x0 - 1; OCC_RECT[1] = y0 - 1; OCC_RECT[2] = x1 + 1; OCC_RECT[3] = y1 + 1;
    return OCC_RECT;
  }
  // lamps: warm white at the nose, red at the tail (brighter when braking or stopped)
  function drawLamps(ctx, i) {
    const s = SCALE, T = TYPES[cType[i]], half = T.L / 2, hw = T.W / 2;
    const fx = cHx[i], fy = cHy[i], rx = fy, ry = -fx;
    const cx = PA * cX[i] + PB * cY[i] + PE, cy = PC * cX[i] + PD * cY[i] + PF;
    const Fx = PA * fx + PB * fy, Fy = PC * fx + PD * fy, Rx = PA * rx + PB * ry, Ry = PC * rx + PD * ry;
    const z = PK * 0.7, rh = Math.max(1.2, 0.55 * s), rt = Math.max(1, 0.42 * s);
    const a = cShow[i] * night, braking = cA[i] < -0.6 || cV[i] < 0.3;
    ctx.globalAlpha = a;
    for (let side = -1; side <= 1; side += 2) {
      const c = side * (hw - 0.3);
      ctx.drawImage(sprites.head, cx + Fx * half + Rx * c - rh, cy + Fy * half + Ry * c - z - rh, 2 * rh, 2 * rh);
    }
    ctx.globalAlpha = a * (braking ? 1 : 0.6);
    for (let side = -1; side <= 1; side += 2) {
      const c = side * (hw - 0.3);
      ctx.drawImage(sprites.tail, cx - Fx * half + Rx * c - rt, cy - Fy * half + Ry * c - z - rt, 2 * rt, 2 * rt);
    }
  }

  // ---------------------------------------------------------------- people
  // pVis holds people (i), and close up also dogs (PCAP + i) and balls (2·PCAP + i), to be drawn back to front together
  const pVis = new Int32Array(3 * PCAP), pDepth = new Float32Array(3 * PCAP), pUnder = new Uint8Array(PCAP);   // per frame, for those in view
  let nPVis = 0, lastSmall = true;
  const byPDepth = (a, b) => pDepth[b] - pDepth[a];
  const bucket = new Int32Array(PCAP), bucketStart = new Int32Array(JACKETS.length + 1), bucketFill = new Int32Array(JACKETS.length);
  // dogs in view this frame; where each dog walker's hand is (CSS px); where the dogs and their walkers were drawn, for hit()
  const dVis = new Int32Array(PCAP), handX = new Float32Array(PCAP), handY = new Float32Array(PCAP);
  const hitId = new Uint32Array(PCAP), hitX = new Float32Array(PCAP), hitY = new Float32Array(PCAP), hitWX = new Float32Array(PCAP), hitWY = new Float32Array(PCAP);
  let nDVis = 0, nHit = 0, dogsSeen = 0;
  // the dogs on screen, for the soundscape (app.whimsy is shared by the whimsical layers: written, never replaced)
  const publishDogs = (n) => { const W = app.whimsy || (app.whimsy = {}); if (W.dogs !== n) W.dogs = n; };
  publishDogs(0);
  function drawPeople(ctx) {
    nPVis = 0; nDVis = 0; nHit = 0; dogsSeen = 0;
    if (!Wk || SCALE < PEOPLE_MIN_S || !nPeople) { publishDogs(0); return; }
    const t0 = performance.now();
    const s = SCALE, m = 6 * s;
    for (let i = 0; i < nPeople; i++) {
      if (pShow[i] <= 0.01) continue;   // indoors, or not faded in yet
      const px = PA * pX[i] + PB * pY[i] + PE, py = PC * pX[i] + PD * pY[i] + PF;
      if (px < -m || px > VW + m || py < -m || py > VH + m) continue;
      pVis[nPVis++] = i;
      pDepth[i] = pX[i] * D0 + pY[i] * D1;
      pUnder[i] = decksAbove(Wk, pLink[i], pNext[i], -1, pX[i], pY[i], 0) > 0 ? 1 : 0;   // right under a bridge deck
    }
    // what stands in front of each person, every half second or so: small ones are seen or hidden by a point test,
    // close ones also get partial cut-outs
    const small = s < PEOPLE_DETAIL_S;
    if (small !== lastSmall) { pOccT.fill(0); dOccT.fill(0); lastSmall = small; }
    if (app.scene) for (let q = 0; q < nPVis; q++) {
      const i = pVis[q];
      if (simT < pOccT[i]) continue;
      pOcc[i] = small ? pointOcclusionOf(pX[i], pY[i], 1.7) : occlusionOf(pX[i], pY[i], pBike[i] ? 0.9 : 0.4, 1.8, 0.9, s >= 12, personCand, i * CAND_STRIDE + 1);
      pOccT[i] = simT + 0.45 + Math.random() * 0.2;
    }
    findDogs(s, small, m);
    publishDogs(dogsSeen);
    // fade in near the threshold scale, so people do not snap into being
    const fadeS = Math.min(1, (s - PEOPLE_MIN_S) / 0.6);
    if (small) {
      // the batches below draw whoever is in view and not hidden
      let n = 0;
      for (let q = 0; q < nPVis; q++) { const i = pVis[q]; if (pOcc[i] !== 2 && !pUnder[i] && pShow[i] > 0.35) pVis[n++] = i; }
      nPVis = n;
      drawPeopleBatched(ctx, s, fadeS);
      if (nDVis) drawDogsBatched(ctx, s, fadeS);
    } else {
      // dogs (and balls in play) join the walkers, back to front
      let n = nPVis;
      for (let q = 0; q < nDVis; q++) {
        const i = dVis[q];
        pVis[n++] = PCAP + i; pDepth[PCAP + i] = dX[i] * D0 + dY[i] * D1;
        if (bState[i] === 2 || bState[i] === 3) { pVis[n++] = 2 * PCAP + i; pDepth[2 * PCAP + i] = bX[i] * D0 + bY[i] * D1; }
      }
      nPVis = n;
      drawPeopleDetailed(ctx, s);
    }
    perf.peopleDraw += performance.now() - t0;
  }

  // The dogs in view (into dVis), what stands in front of each, and where their walkers hold the leash.
  function findDogs(s, small, m) {
    const k = PK;
    for (let i = 0; i < nPeople; i++) {
      if (!pDog[i]) continue;
      const wpx = PA * pX[i] + PB * pY[i] + PE, wpy = PC * pX[i] + PD * pY[i] + PF;
      const dpx = PA * dX[i] + PB * dY[i] + PE, dpy = PC * dX[i] + PD * dY[i] + PF;
      // the hand on the dog's side (on the lawn's side for a throw), raised to throw
      let side = dHand[i] || (dpx >= wpx ? 1 : -1);
      const md = dMode[i];
      const ref = md === F_WIND ? PA * dTx[i] + PB * dTy[i] + PE : dpx;
      if (ref > wpx + 0.25 * s) side = 1; else if (ref < wpx - 0.25 * s) side = -1;
      dHand[i] = side;
      const up = md === F_WIND;
      handX[i] = wpx + side * 0.46 * s * (up ? 0.42 : 0.64); handY[i] = wpy - (up ? 1.74 : 0.9) * k;
      if (dShow[i] <= 0.01 || (pShow[i] <= 0.01 && md < F_WIND)) continue;
      if (dpx < -m || dpx > VW + m || dpy < -m || dpy > VH + m) continue;
      dVis[nDVis++] = i;
      dUnder[i] = decksAbove(Wk, pLink[i], pNext[i], -1, dX[i], dY[i], 0) > 0 ? 1 : 0;
      if (app.scene && simT >= dOccT[i]) {
        dOcc[i] = small ? pointOcclusionOf(dX[i], dY[i], 0.5) : occlusionOf(dX[i], dY[i], 0.6, 0.9, 0.9, s >= 12, dogCand, i * CAND_STRIDE + 1);
        dOccT[i] = simT + 0.4 + Math.random() * 0.2;
      }
      if (dOcc[i] === 2 || (small && dUnder[i])) continue;
      // seen: count it, and remember where it is for a click
      dogsSeen++;
      const hz = (DOG_SIZE[BREEDS[dBreed[i]].z][1] * 0.75) * DOG_SCALE;
      hitId[nHit] = dId[i]; hitX[nHit] = dpx; hitY[nHit] = dpy - hz * k; hitWX[nHit] = wpx; hitWY[nHit] = wpy - 1.1 * k;
      nHit++;
    }
  }

  // small: everyone at once, a few fills per colour (they are a few pixels tall; their order hardly shows)
  function drawPeopleBatched(ctx, s, fade) {
    const k = PK, bw = Math.max(1, 0.46 * s), lw = Math.max(0.6, 0.17 * s), hs = Math.max(1, 0.26 * s);
    ctx.globalAlpha = fade;
    // shadows
    ctx.fillStyle = "rgba(38,50,60,.22)";
    ctx.beginPath();
    for (let q = 0; q < nPVis; q++) {
      const i = pVis[q];
      const px = PA * pX[i] + PB * pY[i] + PE, py = PC * pX[i] + PD * pY[i] + PF;
      ctx.rect(px - bw * 0.3, py - 0.12 * s, bw * 1.3, 0.3 * s);
    }
    ctx.fill();
    // bikes
    ctx.strokeStyle = BIKE; ctx.lineWidth = Math.max(0.8, 0.12 * s); ctx.beginPath();
    for (let q = 0; q < nPVis; q++) {
      const i = pVis[q];
      if (!pBike[i]) continue;
      const px = PA * pX[i] + PB * pY[i] + PE, py = PC * pX[i] + PD * pY[i] + PF;
      const fx = (PA * pHx[i] + PB * pHy[i]) * 0.85, fy = (PC * pHx[i] + PD * pHy[i]) * 0.85;
      ctx.moveTo(px - fx, py - fy - 0.35 * k); ctx.lineTo(px + fx, py + fy - 0.35 * k);
    }
    ctx.stroke();
    // legs
    ctx.fillStyle = "#3a3f4b"; ctx.beginPath();
    for (let q = 0; q < nPVis; q++) {
      const i = pVis[q];
      const px = PA * pX[i] + PB * pY[i] + PE, py = PC * pX[i] + PD * pY[i] + PF;
      const sw = pBike[i] ? 0 : Math.sin(pPhase[i]) * 0.16 * s;
      const top = py - (pBike[i] ? 1.05 : 0.86) * k, hgt = (pBike[i] ? 0.6 : 0.86) * k;
      ctx.rect(px - bw * 0.42 + sw, top, lw, hgt);
      ctx.rect(px + bw * 0.42 - lw - sw, top, lw, hgt);
    }
    ctx.fill();
    // backpacks
    ctx.fillStyle = "#353a44"; ctx.beginPath();
    for (let q = 0; q < nPVis; q++) {
      const i = pVis[q];
      if (pPack[i] < 0) continue;
      const px = PA * pX[i] + PB * pY[i] + PE, py = PC * pX[i] + PD * pY[i] + PF;
      const bx = -(PA * pHx[i] + PB * pHy[i]) * 0.2;
      ctx.rect(px + bx - bw * 0.42, py - (pBike[i] ? 1.6 : 1.42) * k, bw * 0.84, 0.48 * k);
    }
    ctx.fill();
    // bodies, by jacket colour
    bucketStart.fill(0);
    for (let q = 0; q < nPVis; q++) bucketStart[pJacket[pVis[q]] + 1]++;
    for (let c = 0; c < JACKETS.length; c++) bucketStart[c + 1] += bucketStart[c];
    for (let c = 0; c < JACKETS.length; c++) bucketFill[c] = bucketStart[c];
    for (let q = 0; q < nPVis; q++) { const i = pVis[q]; bucket[bucketFill[pJacket[i]]++] = i; }
    for (let c = 0; c < JACKETS.length; c++) {
      if (bucketStart[c + 1] === bucketStart[c]) continue;
      ctx.fillStyle = JACKETS[c][0]; ctx.beginPath();
      for (let q = bucketStart[c]; q < bucketStart[c + 1]; q++) {
        const i = bucket[q];
        const px = PA * pX[i] + PB * pY[i] + PE, py = PC * pX[i] + PD * pY[i] + PF;
        const z0 = pBike[i] ? 1.0 : 0.8;
        ctx.rect(px - bw / 2, py - (z0 + 0.62) * k, bw, 0.62 * k);
      }
      ctx.fill();
    }
    // heads
    ctx.fillStyle = "#d9a882"; ctx.beginPath();
    for (let q = 0; q < nPVis; q++) {
      const i = pVis[q];
      const px = PA * pX[i] + PB * pY[i] + PE, py = PC * pX[i] + PD * pY[i] + PF;
      const z = pBike[i] ? 1.62 : 1.44;
      ctx.rect(px - hs / 2, py - z * k - hs, hs, hs);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function backpack(ctx, col, x, y, bw, z1, k, s) {
    ctx.fillStyle = col;
    if (s >= 10) roundRect(ctx, x - bw * 0.42, y - (z1 - 0.06) * k, bw * 0.84, 0.5 * k, 0.12 * s);
    else ctx.fillRect(x - bw * 0.42, y - (z1 - 0.06) * k, bw * 0.84, 0.5 * k);
  }

  // close: one by one, back to front, with jackets shaded, hair, packs and bikes; hidden behind what stands in front
  function drawPeopleDetailed(ctx, s) {
    pVis.subarray(0, nPVis).sort(byPDepth);
    const k = PK;
    const occlude = !!app.scene;
    // shadows lie on the ground under everyone: all of them in one fill
    ctx.fillStyle = "rgba(38,50,60,.22)";
    ctx.beginPath();
    for (let q = 0; q < nPVis; q++) {
      const i = pVis[q];
      if (i >= PCAP) { if (i < 2 * PCAP) dogShadow(ctx, i - PCAP, s); continue; }
      if (pOcc[i] === 2 || pUnder[i] || pShow[i] < 0.3) continue;
      const px = PA * pX[i] + PB * pY[i] + PE + 0.18 * s, py = PC * pX[i] + PD * pY[i] + PF + 0.02 * s, rx = (pBike[i] ? 0.75 : 0.32) * s;
      ctx.moveTo(px + rx, py); ctx.ellipse(px, py, rx, 0.16 * s, 0, 0, Math.PI * 2);
    }
    ctx.fill();
    for (let q = 0; q < nPVis; q++) {
      const i = pVis[q];
      if (i >= PCAP) { if (i >= 2 * PCAP) drawBallItem(ctx, i - 2 * PCAP); else drawDogItem(ctx, i - PCAP); continue; }
      const px = PA * pX[i] + PB * pY[i] + PE, py = PC * pX[i] + PD * pY[i] + PF;
      const bike = pBike[i];
      if (occlude && pOcc[i] === 2) continue;
      const nD = decksAbove(Wk, pLink[i], pNext[i], -1, pX[i], pY[i], 1);
      if ((occlude && pOcc[i] === 1) || nD) {
        OCC_RECT[0] = px - (bike ? 1.2 : 0.55) * s - 1; OCC_RECT[1] = py - 2 * k - 1; OCC_RECT[2] = px + (bike ? 1.2 : 0.55) * s + 1; OCC_RECT[3] = py + 0.4 * s + 1;
        const nF = occlude && pOcc[i] === 1 ? frontOf(pX[i], pY[i], bike ? 0.9 : 0.35, OCC_RECT, s >= 12, personCand, i * CAND_STRIDE + 1) : 0;
        drawCut(ctx, OCC_RECT, nF, nD, pX[i], pY[i], 1, drawPersonAt, i);
      } else drawPersonAt(ctx, i);
    }
    ctx.globalAlpha = 1;
  }
  // one person, close up: shadow, legs (or a bike), backpack, jacket shaded on one side, head and hair
  function drawPersonAt(ctx, i) {
    {
      const s = SCALE, k = PK;
      const px = PA * pX[i] + PB * pY[i] + PE, py = PC * pX[i] + PD * pY[i] + PF;
      const hx = pHx[i], hy = pHy[i];
      const hsx = PA * hx + PB * hy, hsy = PC * hx + PD * hy;          // heading on screen, px per metre
      const away = hx * D0 + hy * D1 > 0;                              // walking away from the camera: we see the back
      const bike = pBike[i];
      ctx.globalAlpha = pShow[i];
      const bw = 0.46 * s, lw = 0.16 * s;
      const jacket = JACKETS[pJacket[i]][0];
      if (bike) {
        // the bike: two wheels and a frame along the heading
        const fx = hsx * 0.55, fy = hsy * 0.55, wr = 0.33;
        ctx.strokeStyle = BIKE; ctx.lineWidth = Math.max(1, 0.07 * s);
        ctx.beginPath();
        ctx.ellipse(px - fx, py - fy - wr * k, wr * s * Math.max(0.25, Math.abs(hsx) / s), wr * k, 0, 0, Math.PI * 2);
        ctx.moveTo(px + fx + wr * s * Math.max(0.25, Math.abs(hsx) / s), py + fy - wr * k);
        ctx.ellipse(px + fx, py + fy - wr * k, wr * s * Math.max(0.25, Math.abs(hsx) / s), wr * k, 0, 0, Math.PI * 2);
        ctx.moveTo(px - fx, py - fy - wr * k); ctx.lineTo(px, py - 0.9 * k); ctx.lineTo(px + fx * 0.9, py + fy * 0.9 - 1.0 * k); ctx.lineTo(px + fx, py + fy - wr * k);
        ctx.stroke();
        // legs pedalling
        const ph = pPhase[i] * 3.5;
        ctx.fillStyle = TROUSERS[pLegs[i]];
        ctx.fillRect(px - lw - 0.05 * s, py - (0.95 - 0.18 * Math.sin(ph)) * k, lw, (0.5 + 0.18 * Math.sin(ph)) * k);
        ctx.fillRect(px + 0.05 * s, py - (0.95 + 0.18 * Math.sin(ph)) * k, lw, (0.5 - 0.18 * Math.sin(ph)) * k);
      } else {
        // legs, swinging with the stride
        const sw = Math.sin(pPhase[i]) * 0.14;
        const lx = hsx * sw, ly = hsy * sw;
        ctx.fillStyle = TROUSERS[pLegs[i]];
        ctx.fillRect(px - bw * 0.45 + lx, py + ly - 0.86 * k, lw, 0.86 * k);
        ctx.fillRect(px + bw * 0.45 - lw - lx, py - ly - 0.86 * k, lw, 0.86 * k);
        if (s >= 10) {
          ctx.fillStyle = "#2a2a2e";
          ctx.fillRect(px - bw * 0.45 + lx, py + ly - 0.1 * k, lw * 1.1, 0.1 * k);
          ctx.fillRect(px + bw * 0.45 - lw - lx, py - ly - 0.1 * k, lw * 1.1, 0.1 * k);
        }
      }
      const z0 = bike ? 0.98 : 0.8, z1 = z0 + 0.64;
      const lean = bike ? 0.18 : 0;
      const bx = px + hsx * lean, by = py + hsy * lean;
      // the backpack shows behind the body when they face us, over it when they walk away
      const pack = pPack[i];
      if (!away && pack >= 0) backpack(ctx, PACKS_DIM[pack], bx - hsx * 0.2, by - hsy * 0.2, bw, z1, k, s);
      // body: lit on one side, in shade on the other
      ctx.fillStyle = jacket;
      if (s >= 10) roundRect(ctx, bx - bw / 2, by - z1 * k, bw, (z1 - z0) * k + 0.05 * s, 0.14 * s);
      else ctx.fillRect(bx - bw / 2, by - z1 * k, bw, (z1 - z0) * k + 0.05 * s);
      if (s >= 12) {
        ctx.fillStyle = "rgba(30,30,40,.18)";
        ctx.fillRect(bx, by - z1 * k + 0.08 * s, bw / 2, (z1 - z0) * k - 0.04 * s);
      }
      if (away && pack >= 0) backpack(ctx, PACKS[pack], bx - hsx * 0.2, by - hsy * 0.2, bw, z1, k, s);
      if (pDog[i]) leashArm(ctx, i, bx, by, bw, z1, k, s);
      // head and hair
      const hr = 0.13 * s, hzc = z1 + 0.15;
      ctx.fillStyle = SKIN[pSkin[i]];
      ctx.beginPath(); ctx.arc(bx, by - hzc * k, hr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = HAIR[pHair[i]];
      ctx.beginPath();
      if (away) ctx.arc(bx, by - hzc * k, hr * 1.02, 0, Math.PI * 2);
      else ctx.arc(bx, by - hzc * k - hr * 0.1, hr * 1.02, Math.PI * 1.02, Math.PI * 1.98);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- dogs
  const BALL_COL = "#d9e04f", NOSE = "#2a2622";
  // a dog walker's arm reaching to the leash (or up, to throw); off the leash, the leash hangs from their hand
  function leashArm(ctx, i, bx, by, bw, z1, k, s) {
    const side = dHand[i] || 1, md = dMode[i], hx = handX[i], hy = handY[i];
    ctx.lineCap = "round";
    ctx.strokeStyle = JACKETS_DIM[pJacket[i]]; ctx.lineWidth = Math.max(1, 0.12 * s);
    ctx.beginPath(); ctx.moveTo(bx + side * bw * 0.34, by - (z1 - 0.1) * k); ctx.lineTo(hx, hy); ctx.stroke();
    ctx.fillStyle = SKIN[pSkin[i]];
    ctx.beginPath(); ctx.arc(hx, hy, Math.max(0.8, 0.06 * s), 0, Math.PI * 2); ctx.fill();
    if (md === F_WIND) {
      if (bState[i] === 1) { ctx.fillStyle = BALL_COL; ctx.beginPath(); ctx.arc(hx, hy - 0.05 * s, Math.max(1.2, 0.07 * s), 0, Math.PI * 2); ctx.fill(); }
    } else if (md > F_WIND) {
      ctx.strokeStyle = LEASHES[dLeash[i]]; ctx.lineWidth = Math.max(0.8, 0.045 * s);
      ctx.beginPath(); ctx.moveTo(hx, hy);
      ctx.quadraticCurveTo(hx + side * 0.16 * s, hy + 0.32 * k, hx + side * 0.06 * s, hy + 0.55 * k);
      ctx.stroke();
    }
  }
  // the leash, from the walker's hand to the collar (cx, cy), sagging as much as it is slack
  function drawLeash(ctx, i, cx, cy) {
    const s = SCALE, Z = DOG_SIZE[BREEDS[dBreed[i]].z];
    const slack = Math.max(0, Z[4] - Math.hypot(dX[i] - pX[i], dY[i] - pY[i]) - 0.1);
    const hx = handX[i], hy = handY[i];
    ctx.strokeStyle = LEASHES[dLeash[i]]; ctx.lineWidth = Math.max(0.8, 0.045 * s);
    ctx.beginPath(); ctx.moveTo(hx, hy);
    ctx.quadraticCurveTo((hx + cx) / 2, (hy + cy) / 2 + Math.min(0.9, slack * 1.1) * PK, cx, cy);
    ctx.stroke();
  }
  // the dog's screen box (CSS px), with its leash, into OCC_RECT
  function dogRect(i) {
    const s = SCALE, k = PK, px = PA * dX[i] + PB * dY[i] + PE, py = PC * dX[i] + PD * dY[i] + PF;
    let x0 = px - 1.05 * s - 2, x1 = px + 1.05 * s + 2, y0 = py - 1.2 * k - 2, y1 = py + 0.45 * s + 2;
    if (dMode[i] < F_WIND) {
      const hx = handX[i], hy = handY[i];
      if (hx - 2 < x0) x0 = hx - 2; if (hx + 2 > x1) x1 = hx + 2; if (hy - 2 < y0) y0 = hy - 2; if (hy + 0.9 * k > y1) y1 = hy + 0.9 * k;
    }
    OCC_RECT[0] = x0; OCC_RECT[1] = y0; OCC_RECT[2] = x1; OCC_RECT[3] = y1;
    return OCC_RECT;
  }
  function drawDogItem(ctx, i) {
    if (dOcc[i] === 2 || dShow[i] < 0.02) return;
    const nD = decksAbove(Wk, pLink[i], pNext[i], -1, dX[i], dY[i], 1);
    if (dOcc[i] === 1 || nD) {
      dogRect(i);
      const nF = dOcc[i] === 1 ? frontOf(dX[i], dY[i], 0.6, OCC_RECT, SCALE >= 12, dogCand, i * CAND_STRIDE + 1) : 0;
      drawCut(ctx, OCC_RECT, nF, nD, dX[i], dY[i], 1.5, drawDogAt, i);
    } else drawDogAt(ctx, i);
    ctx.globalAlpha = 1;
  }
  function drawBallItem(ctx, i) {
    if (app.scene && pointOcclusionOf(bX[i], bY[i], 2 * bZ[i] + 0.1) === 2) return;
    const s = SCALE, k = PK, px = PA * bX[i] + PB * bY[i] + PE, py = PC * bX[i] + PD * bY[i] + PF, r = Math.max(1.2, 0.07 * s);
    ctx.globalAlpha = dShow[i];
    ctx.fillStyle = "rgba(38,50,60,.22)";
    ctx.beginPath(); ctx.ellipse(px, py, r, r * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = BALL_COL;
    ctx.beginPath(); ctx.arc(px, py - bZ[i] * k - r * 0.6, r, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  // One dog, close up, in the walkers' soft style: a rounded body along its heading, four legs trotting in diagonal pairs
  // (the far ones in shade), a head on a neck (lowered to sniff), a snout, ears that flop or stand, and a tail that wags;
  // its coat's markings, and in the cold a little sweater on the short-haired ones. Everything in its coat's colour is one
  // fill of rounded capsules (they are all one colour, so their order cannot show), the shaded far legs and ear another;
  // the leash goes before or after it, by where the walker is. Its shadow is drawn with the walkers' (dogShadow).
  const DG = { px: 0, py: 0, fx: 0, fy: 0, rx: 0, ry: 0, L: 0, leg: 0, th: 0, hr: 0, zc: 0, near: 1, away: false, hx: 0, hy: 0, sx: 0, sy: 0 };
  const HALF_PI = Math.PI / 2, TAU = Math.PI * 2;
  // a capsule (a fat round-ended line) from (x0, y0) to (x1, y1), r wide each side, added to the current path; every one
  // runs clockwise, so overlapping ones fill as a union
  function capsule(ctx, x0, y0, x1, y1, r) {
    const a = Math.atan2(y1 - y0, x1 - x0);
    ctx.moveTo(x0 + Math.cos(a + HALF_PI) * r, y0 + Math.sin(a + HALF_PI) * r);
    ctx.arc(x0, y0, r, a + HALF_PI, a + 3 * HALF_PI);
    ctx.arc(x1, y1, r, a - HALF_PI, a + HALF_PI);
  }
  function disc(ctx, x, y, r) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU); }
  function dogShape(i) {
    const s = SCALE, g = DOG_SCALE, B = BREEDS[dBreed[i]], Z = DOG_SIZE[B.z];
    const hx = dHx[i], hy = dHy[i];
    DG.L = Z[0] * (B.len || 1) * g; DG.leg = Z[2] * (B.leg || 1) * g; DG.th = (Z[1] - Z[2]) * (B.fluff || 1) * g;
    DG.hr = Z[3] * g * ((B.fluff || 1) > 1.2 ? 1.12 : 1); DG.zc = DG.leg + DG.th * 0.5;
    DG.px = PA * dX[i] + PB * dY[i] + PE; DG.py = PC * dX[i] + PD * dY[i] + PF;
    DG.fx = PA * hx + PB * hy; DG.fy = PC * hx + PD * hy; DG.rx = PA * hy - PB * hx; DG.ry = PC * hy - PD * hx;
    DG.away = hx * D0 + hy * D1 > 0;
    DG.near = hy * D0 - hx * D1 > 0 ? -1 : 1;   // its right side is the far one when it lies deeper
    return s;
  }
  function dogShadow(ctx, i, s) {
    if (dOcc[i] === 2 || dUnder[i] || dShow[i] < 0.3) return;
    dogShape(i);
    const { px, py, fx, fy, rx, ry, L, th } = DG;
    const a = Math.max(0.16 * s, Math.hypot(fx, fy) * L * 0.55), b = Math.max(0.07 * s, Math.hypot(rx, ry) * th * 0.5), ang = Math.atan2(fy, fx);
    const cx = px + 0.08 * s, cy = py + 0.02 * s;
    ctx.moveTo(cx + Math.cos(ang) * a, cy + Math.sin(ang) * a);
    ctx.ellipse(cx, cy, a, b, ang, 0, TAU);
  }
  function drawDogAt(ctx, i) {
    const s = dogShape(i), k = PK, B = BREEDS[dBreed[i]], Z = DOG_SIZE[B.z], C = COATS[dCoat[i]];
    const { px, py, fx, fy, rx, ry, L, th, zc, hr, near, away } = DG;
    const leashed = dMode[i] < F_WIND;
    ctx.globalAlpha = dShow[i];
    // the collar, where the leash clips on
    const nkx = px + fx * L * 0.36, nky = py + fy * L * 0.36 - (zc + th * 0.3) * k;
    const walkerFar = pX[i] * D0 + pY[i] * D1 > dX[i] * D0 + dY[i] * D1;
    if (leashed && walkerFar) drawLeash(ctx, i, nkx, nky);
    // the head: out in front, lowered to sniff
    const dn = dHead[i];
    const along = L * 0.4 + hr * (0.35 + dn * 0.55), zh = (zc + th * 0.45 + hr * 0.55) * (1 - dn) + hr * 1.05 * dn;
    const hx = px + fx * along, hy = py + fy * along - zh * k;
    const sl = hr * 1.05 * (B.snout || 1), sx = hx + fx * sl, sy = hy + fy * sl + (0.25 + dn * 0.55) * hr * k;
    DG.hx = hx; DG.hy = hy; DG.sx = sx; DG.sy = sy;
    // the far legs and the far ear, in shade
    ctx.fillStyle = C[2];
    ctx.beginPath();
    dogLegs(ctx, i, Z, B, -near);
    dogEar(ctx, B, -near);
    ctx.fill();
    if (!away) dogTail(ctx, i, B, C, Z);
    // everything in its coat's colour
    const muzzle = dCoat[i] === 4;
    ctx.fillStyle = C[1];
    ctx.beginPath();
    capsule(ctx, px - fx * L * 0.34, py - fy * L * 0.34 - zc * k, px + fx * L * 0.34, py + fy * L * 0.34 - zc * k, Math.max(0.8, th * s * 0.52));
    capsule(ctx, px + fx * L * 0.3, py + fy * L * 0.3 - (zc + th * 0.1) * k, hx, hy, Math.max(0.7, th * s * 0.39));
    disc(ctx, hx, hy, hr * s);
    if (!muzzle) capsule(ctx, hx, hy + hr * 0.1 * k, sx, sy, Math.max(0.6, hr * s * 0.47));
    dogLegs(ctx, i, Z, B, near);
    ctx.fill();
    // markings: brindle stripes, a pale chest, a white muzzle
    if (C[4]) {
      ctx.fillStyle = C[4];
      ctx.beginPath();
      for (let q = -1; q <= 1; q++) {
        const x = px + fx * L * 0.2 * q, y = py + fy * L * 0.2 * q;
        capsule(ctx, x, y - (zc + th * 0.38) * k, x + fx * 0.04, y - (zc - th * 0.1) * k, Math.max(0.35, th * 0.07 * s));
      }
      ctx.fill();
    }
    if (C[3] && (!away || Math.abs(fx) > 0.4 * s)) {
      ctx.fillStyle = C[3];
      ctx.beginPath();
      disc(ctx, px + fx * L * 0.36, py + fy * L * 0.36 - (zc - th * 0.12) * k, th * 0.28 * s);
      if (muzzle) capsule(ctx, hx, hy + hr * 0.1 * k, sx, sy, Math.max(0.6, hr * s * 0.47));
      ctx.fill();
    }
    // a sweater, when it is cold out
    if (dKnit[i] >= 0 && dogCold) {
      ctx.fillStyle = SWEATERS[dKnit[i]];
      ctx.beginPath(); capsule(ctx, px - fx * L * 0.1, py - fy * L * 0.1 - zc * k, px + fx * L * 0.24, py + fy * L * 0.24 - zc * k, th * s * 0.57); ctx.fill();
    }
    // soft shade under the belly
    ctx.fillStyle = "rgba(30,28,36,.13)";
    ctx.beginPath();
    capsule(ctx, px - fx * L * 0.3, py - fy * L * 0.3 - (zc - th * 0.3) * k, px + fx * L * 0.3, py + fy * L * 0.3 - (zc - th * 0.3) * k, th * s * 0.21);
    ctx.fill();
    if (away) dogTail(ctx, i, B, C, Z);
    // the near ear; the nose and an eye, facing us
    ctx.fillStyle = C[2];
    ctx.beginPath(); dogEar(ctx, B, near); ctx.fill();
    if (!away || s >= 14 && Math.abs(fx) > 0.35 * s) {
      ctx.fillStyle = NOSE;
      ctx.beginPath();
      if (!away) disc(ctx, sx + fx * hr * 0.3, sy - hr * 0.05 * k, Math.max(0.6, hr * 0.26 * s));
      if (s >= 14 && Math.abs(fx) > 0.35 * s) disc(ctx, hx + fx * hr * 0.3 + rx * near * hr * 0.4, hy + fy * hr * 0.3 + ry * near * hr * 0.4 - hr * 0.2 * k, Math.max(0.55, hr * 0.15 * s));
      ctx.fill();
    }
    if (bState[i] === 4) {
      ctx.fillStyle = BALL_COL;
      ctx.beginPath(); disc(ctx, sx + fx * hr * 0.2, sy, Math.max(1.2, 0.07 * s)); ctx.fill();
    }
    if (leashed && !walkerFar) drawLeash(ctx, i, nkx, nky);
    ctx.globalAlpha = 1;
  }
  // a pair of legs (front and back on one side), trotting in diagonal pairs, added to the current path
  function dogLegs(ctx, i, Z, B, side) {
    const s = SCALE, k = PK, { px, py, fx, fy, rx, ry, L, th, zc } = DG;
    const amp = Math.min(1, Math.hypot(dVx[i], dVy[i]) / 0.5), swing = Z[5] * 0.22 * DOG_SCALE * amp, lift = 0.06 * DOG_SCALE * amp;
    const r = Math.max(0.5, Z[3] * 0.25 * DOG_SCALE * (B.leg > 1 ? 0.8 : 1) * s);
    for (let e = 0; e < 2; e++) {
      const at = e ? L * 0.3 : -L * 0.28, across = side * th * 0.26;
      const ph = dPhase[i] + ((e + (side > 0 ? 1 : 0)) & 1 ? Math.PI : 0);
      const a = Math.sin(ph) * swing, up = Math.max(0, Math.cos(ph)) * lift;
      const tx = px + fx * at + rx * across, ty = py + fy * at + ry * across;
      capsule(ctx, tx, ty - zc * k, tx + fx * a, ty + fy * a - up * k - r * 0.6, r);
    }
  }
  function dogTail(ctx, i, B, C, Z) {
    const s = SCALE, k = PK, { px, py, fx, fy, rx, ry, L, th, zc } = DG;
    const tl = L * (B.tail === 2 ? 0.16 : B.tail === 1 ? 0.3 : 0.44), w = Math.sin(dWag[i]);
    const bx = px - fx * L * 0.4, by = py - fy * L * 0.4 - (zc + th * 0.3) * k;
    ctx.lineCap = "round";
    ctx.strokeStyle = C[1]; ctx.lineWidth = Math.max(1, Z[3] * 0.42 * DOG_SCALE * (B.fluff || 1) * s);
    ctx.beginPath(); ctx.moveTo(bx, by);
    if (B.tail === 1) {
      // curled up over the back
      ctx.quadraticCurveTo(bx - fx * tl * 0.4 + rx * w * tl * 0.1, by - fy * tl * 0.4 + ry * w * tl * 0.1 - tl * 0.75 * k, bx + fx * tl * 0.25 + rx * w * tl * 0.15, by + fy * tl * 0.25 + ry * w * tl * 0.15 - tl * 0.55 * k);
    } else {
      const ex = bx - fx * tl * 0.55 + rx * w * tl * 0.55, ey = by - fy * tl * 0.55 + ry * w * tl * 0.55 - tl * 0.7 * k;
      ctx.quadraticCurveTo(bx - fx * tl * 0.6, by - fy * tl * 0.6 - tl * 0.08 * k, ex, ey);
    }
    ctx.stroke();
  }
  // one ear, on side (±1 to the dog's right), added to the current path: floppy ones hang at the side of the head,
  // pointed ones stand up
  function dogEar(ctx, B, side) {
    const s = SCALE, k = PK, { fx, fy, rx, ry, hx, hy, hr } = DG;
    const ox = hx + rx * side * hr * 0.72, oy = hy + ry * side * hr * 0.72;
    if (B.ear) {
      ctx.moveTo(hx + rx * side * hr * 0.3, hy + ry * side * hr * 0.3 - hr * 0.55 * k);
      ctx.lineTo(ox, oy - hr * 0.35 * k);
      ctx.lineTo(hx + rx * side * hr * 0.6 - fx * hr * 0.12, hy + ry * side * hr * 0.6 - fy * hr * 0.12 - hr * 1.35 * k);
    } else {
      const ex = ox - fx * hr * 0.1, ey = oy - fy * hr * 0.1 + hr * 0.3 * k;
      ctx.moveTo(ex + hr * 0.36 * s, ey);
      ctx.ellipse(ex, ey, hr * 0.36 * s, hr * 0.62 * s, 0, 0, TAU);
    }
  }

  // From afar (a few pixels each): the leashes in one stroke, the legs in another, and per coat a fill of bodies and heads.
  function drawDogsBatched(ctx, s, fade) {
    const k = PK, g = DOG_SCALE;
    ctx.globalAlpha = fade; ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(78,58,50,.8)"; ctx.lineWidth = Math.max(0.6, 0.05 * s);
    ctx.beginPath();
    for (let q = 0; q < nDVis; q++) {
      const i = dVis[q];
      if (dOcc[i] === 2 || dUnder[i] || dMode[i] >= F_WIND) continue;
      const B = BREEDS[dBreed[i]], Z = DOG_SIZE[B.z], L = Z[0] * (B.len || 1) * g, z = (Z[1] - (Z[1] - Z[2]) * 0.2) * g;
      const fx = PA * dHx[i] + PB * dHy[i], fy = PC * dHx[i] + PD * dHy[i];
      ctx.moveTo(handX[i], handY[i]);
      ctx.lineTo(PA * dX[i] + PB * dY[i] + PE + fx * L * 0.36, PC * dX[i] + PD * dY[i] + PF + fy * L * 0.36 - z * k);
    }
    ctx.stroke();
    if (s >= 4) {
      ctx.strokeStyle = "#5a4c42"; ctx.lineWidth = Math.max(0.7, 0.07 * g * s);
      ctx.beginPath();
      for (let q = 0; q < nDVis; q++) {
        const i = dVis[q];
        if (dOcc[i] === 2 || dUnder[i]) continue;
        const B = BREEDS[dBreed[i]], Z = DOG_SIZE[B.z], L = Z[0] * (B.len || 1) * g, zc = Z[2] * (B.leg || 1) * g + (Z[1] - Z[2]) * 0.5 * g;
        const px = PA * dX[i] + PB * dY[i] + PE, py = PC * dX[i] + PD * dY[i] + PF, fx = PA * dHx[i] + PB * dHy[i], fy = PC * dHx[i] + PD * dHy[i];
        const sw = Math.sin(dPhase[i]) * Z[5] * 0.2 * g * Math.min(1, Math.hypot(dVx[i], dVy[i]) / 0.5);
        ctx.moveTo(px + fx * L * 0.3, py + fy * L * 0.3 - zc * k); ctx.lineTo(px + fx * (L * 0.3 + sw), py + fy * (L * 0.3 + sw));
        ctx.moveTo(px - fx * L * 0.28, py - fy * L * 0.28 - zc * k); ctx.lineTo(px - fx * (L * 0.28 + sw), py - fy * (L * 0.28 + sw));
      }
      ctx.stroke();
    }
    for (let c = 0; c < COATS.length; c++) {
      let any = false;
      for (let q = 0; q < nDVis; q++) {
        const i = dVis[q];
        if (dCoat[i] !== c || dOcc[i] === 2 || dUnder[i]) continue;
        if (!any) { ctx.fillStyle = COATS[c][1]; ctx.beginPath(); any = true; }
        const B = BREEDS[dBreed[i]], Z = DOG_SIZE[B.z];
        const L = Z[0] * (B.len || 1) * g, th = (Z[1] - Z[2]) * (B.fluff || 1) * g, zc = Z[2] * (B.leg || 1) * g + th * 0.5;
        const px = PA * dX[i] + PB * dY[i] + PE, py = PC * dX[i] + PD * dY[i] + PF, fx = PA * dHx[i] + PB * dHy[i], fy = PC * dHx[i] + PD * dHy[i];
        capsule(ctx, px - fx * L * 0.34, py - fy * L * 0.34 - zc * k, px + fx * L * 0.34, py + fy * L * 0.34 - zc * k, Math.max(0.7, th * s * 0.52));
        const dn = dHead[i], zh = (zc + th * 0.45) * (1 - dn) + Z[3] * g * dn;
        disc(ctx, px + fx * L * 0.48, py + fy * L * 0.48 - zh * k, Math.max(0.8, Z[3] * g * s));
      }
      if (any) ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ================================================================================================ wiring
  const perf = { sim: 0, carDraw: 0, lightDraw: 0, peopleDraw: 0, frames: 0 };
  const stats = { carsInView: 0, peopleInView: 0 };   // spawns that had to appear inside the view (fading in)
  const life = { cars: 0, people: 0, perf, debug: { get nCars() { return nCars; }, get nPeople() { return nPeople; }, get carTarget() { return carTarget; }, get peopleTarget() { return peopleTarget; }, get night() { return night; }, get factors() { return { carFactor, peopleFactor, classChange }; }, stats,
    // a snapshot for tests: what the cars are doing and where
    state() {
      let bikes = 0;
      for (let i = 0; i < nPeople; i++) bikes += pBike[i];
      const byCls = {}, out = { people: nPeople, cyclists: bikes, n: nCars, inView: 0, moving: 0, stopped: 0, waitingRed: 0, byCls, target: carTarget, region: { ...carRegion }, signals: R.nClusters };
      for (let i = 0; i < nCars; i++) {
        const name = ROAD_NAMES[R.eCls[cLink[i] >> 1]];
        byCls[name] = (byCls[name] || 0) + 1;
        if (onScreen(cX[i], cY[i], 0)) out.inView++;
        if (cV[i] > 1) out.moving++; else out.stopped++;
        const l = cLink[i];
        if (R.lSig[l] >= 0 && sigState(R.lSig[l], R.lPh[l]) === 2 && cV[i] < 0.5) out.waitingRed++;
      }
      return out;
    },
    // run the simulation on for sec seconds without drawing (for tests of how the traffic settles)
    advance(sec, dt = 0.1) { for (let t = 0; t < sec; t += dt) stepSim(dt); return this.state(); },
    // where a cyclist is (for tests: fly there and look)
    cyclist() { for (let i = 0; i < nPeople; i++) if (pBike[i]) return geo.toLatLon(pX[i], pY[i]); return null; },
    // the dogs out now (for tests: fly to one, open its card): id, where, what it is up to
    dogs() {
      const out = [];
      for (let i = 0; i < nPeople; i++) if (pDog[i]) out.push({ id: dId[i], ...latLonOf(dX[i], dY[i]), mode: dMode[i], size: BREEDS[dBreed[i]].z, breed: dBreed[i], coat: COATS[dCoat[i]][0], shown: +dShow[i].toFixed(2), occ: dOcc[i], go: +pGo[i].toFixed(2) });
      return out;
    },
    openDog(id) { openDogCard(id); },
    // every approach to the junctions near a lat/lon: its controls, and the cars on it
    approaches(lat, lon, rad = 30) {
      const [x, y] = geo.toXY(lat, lon), out = [];
      for (let l = 0; l < R.LK; l++) {
        const n = R.lTo[l];
        if (!R.lOk[l] || Math.hypot(R.nx[n] - x, R.ny[n] - y) > rad) continue;
        const cars = [];
        for (let i = 0; i < nCars; i++) if (cLink[i] === l) cars.push({ toLine: +(R.eLen[l >> 1] - R.lSB[l] - cS[i] - TYPE_HALF[cType[i]]).toFixed(1), v: +cV[i].toFixed(2), stopped: cStopDone[i] });
        out.push({ link: l, node: n, stop: R.lStop[l], pri: R.lPri[l], junction: R.nJ[n], sig: R.lSig[l], cls: ROAD_NAMES[R.eCls[l >> 1]], cars });
      }
      return out;
    },
    // the signals near a lat/lon: each approach's phase and light, and the cars queued on it
    signalsNear(lat, lon, rad = 80) {
      const [x, y] = geo.toXY(lat, lon), out = [];
      for (let l = 0; l < R.LK; l++) {
        const c = R.lSig[l];
        if (c < 0) continue;
        const n = R.lTo[l];
        if (Math.hypot(R.nx[n] - x, R.ny[n] - y) > rad) continue;
        const cars = [];
        for (let i = 0; i < nCars; i++) if (cLink[i] === l) cars.push({ toLine: +(R.eLen[l >> 1] - R.lSB[l] - cS[i] - TYPE_HALF[cType[i]]).toFixed(1), v: +cV[i].toFixed(1), lane: cLane[i] });
        out.push({ link: l, cluster: c, phase: R.lPh[l], light: ["green", "yellow", "red"][sigState(c, R.lPh[l])], heading: Math.round(Math.atan2(R.lHx1[l], R.lHy1[l]) * 180 / Math.PI), lanes: R.lNl[l], stopBack: +R.lSB[l].toFixed(1), cars });
      }
      return out;
    } } };
  function latLonOf(x, y) { const p = geo.toLatLon(x, y); return Array.isArray(p) ? { lat: p[0], lon: p[1] } : p; }
  Object.defineProperty(life, "perf", { enumerable: false });
  Object.defineProperty(life, "debug", { enumerable: false });
  app.life = life;

  // ---------------------------------------------------------------- a dog's card
  // A click on a dog (or on the human at the other end of its leash) opens its card: its name, what it looks like it
  // might be, a rating, how many lamp posts it has sniffed today, and what it is up to, live. All of it comes from the
  // dog's seed and the simulation: nothing here is about a real dog.
  function hitDog(px, py) {
    if (!nHit || SCALE < PEOPLE_MIN_S) return null;
    const s = SCALE, r = Math.max(app.mobile ? 16 : 10, 0.7 * s), wr = Math.max(app.mobile ? 10 : 6, 0.32 * s), wh = Math.max(10, 0.85 * PK);
    let best = 0, bd = r * r;
    for (let q = 0; q < nHit; q++) {
      const d2 = (px - hitX[q]) ** 2 + (py - hitY[q]) ** 2;
      if (d2 < bd) { bd = d2; best = hitId[q]; }
    }
    if (best) return best;
    for (let q = 0; q < nHit; q++) if (Math.abs(px - hitWX[q]) <= wr && Math.abs(py - hitWY[q]) <= wh) return hitId[q];
    return null;
  }
  const dogCard = { id: 0, i: -1, h: null, el: null, now: null, sniffs: null, at: 0, key: "" };
  function findDog(id) {
    const j = dogCard.i;
    if (j >= 0 && j < nPeople && pDog[j] && dId[j] === id) return j;
    for (let i = 0; i < nPeople; i++) if (pDog[i] && dId[i] === id) return (dogCard.i = i);
    return -1;
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  function dogFacts(i) {
    const seed = dSeed[i], r = (k) => hashSeed(seed, k), B = BREEDS[dBreed[i]], C = COATS[dCoat[i]];
    // the day so far: a dog out since breakfast has been past plenty of posts already
    const hours = dogHour < 5 ? 18 : Math.max(0.5, Math.min(16, dogHour - 6));
    return {
      name: DOG_NAMES[Math.floor(r(8) * DOG_NAMES.length)],
      what: `${B.d[0].toUpperCase()}${B.d.slice(1)}`,
      looks: `${SIZE_NAMES[B.z]}, ${C[0]}`,
      score: 10 + Math.floor(Math.pow(r(9), 1.8) * 5),
      quirk: DOG_QUIRKS[Math.floor(r(10) * DOG_QUIRKS.length)],
      lamps: 1 + Math.floor(r(11) * 1.6 * hours) + dLamps[i],
      trees: Math.floor(r(12) * 2 * hours) + dTrees[i],
      coat: C[1],
    };
  }
  function nowText(i) {
    const m = dMode[i], w = dWhat[i], waiting = pGo[i] < 0.3;
    switch (m) {
      case SNIFF_GO: return w === 1 ? "Heading for a lamp post, with purpose" : w === 2 ? "Making a beeline for a tree" : "Something in the grass needs checking";
      case SNIFF: return (w === 1 ? "Sniffing a lamp post very thoroughly" : w === 2 ? "Reading the news at the foot of a tree" : "Sniffing the grass. Important grass.") + (waiting ? ", while their human waits" : "");
      case TUG: return "Tugging ahead (there might be a squirrel)";
      case BACK: return "Checking in with their human";
      case F_WIND: return "Waiting for the throw, extremely ready";
      case F_CHASE: return bState[i] === 2 ? "Chasing the ball, flat out" : "Closing in on the ball";
      case F_GET: return "Got it!";
      case F_RETURN: return "Bringing the ball back, proudly";
      case F_DROP: return dThrows[i] > 1 ? "Dropping the ball for another throw" : "One more? (No: on with the walk)";
      default: return pGo[i] < 0.3 ? "Standing about, tail going" : "Trotting along, tail going";
    }
  }
  function moodLine() {
    const w = app.weather || {}, st = app.tileStyle || {};
    if ((st.snow || 0) > 0.2 || (w.snowDepthM || 0) > 0.02 || (w.snow || 0) > 0.2) return "Opinion of the snow: delighted";
    if ((w.rain || 0) > 0.2) return "Opinion of the rain: low";
    if (night > 0.6) return "Favourite thing tonight: the smells, which are better in the dark";
    const season = st.season || "";
    return season === "summer" ? "Favourite thing today: shade, then the water bowl" : season === "spring" ? "Favourite thing today: puddles (sorry)"
      : season === "winter" ? "Favourite thing today: the cold air, the warm radiator after" : "Favourite thing today: crunchy leaves";
  }
  function openDogCard(id) {
    const i = findDog(id);
    if (i < 0 || !app.ui || !app.ui.card) return;
    cue("bark", dX[i], dY[i]);
    injectDogStyle();
    const F = dogFacts(i);
    const el = document.createElement("div");
    el.className = "life-dog";
    el.innerHTML = `<div class="life-dog-rate"><span class="life-dog-score"></span><span class="life-dog-good">Good dog</span></div>` +
      `<p class="life-dog-now"></p><ul class="life-dog-facts"><li class="life-dog-sniffs"></li><li class="life-dog-with"></li><li class="life-dog-quirk"></li>` +
      `<li class="life-dog-mood"></li><li class="life-dog-knit" hidden></li></ul><p class="life-dog-src">Simulated, like everyone on this map. Still a very good dog.</p>`;
    el.querySelector(".life-dog-score").textContent = `${F.score}/10`;
    el.querySelector(".life-dog-with").textContent = `Out with: their human, in a ${JACKET_NAMES[pJacket[i]] || "warm"} jacket`;
    el.querySelector(".life-dog-quirk").textContent = `Known for: ${F.quirk}`;
    el.querySelector(".life-dog-mood").textContent = moodLine();
    const knit = el.querySelector(".life-dog-knit");
    if (dKnit[i] >= 0 && dogCold) {
      const t = app.weather && Number.isFinite(app.weather.tempF) && app.weather.source !== "none" ? ` (it's ${Math.round(app.weather.tempF)}°F)` : "";
      knit.hidden = false; knit.textContent = `Wearing: a little sweater${t}`;
    }
    dogCard.id = id; dogCard.el = el; dogCard.now = el.querySelector(".life-dog-now"); dogCard.sniffs = el.querySelector(".life-dog-sniffs"); dogCard.key = "";
    const h = app.ui.card({
      id: "dog", title: F.name, subtitle: `${F.what} · ${F.looks}`, color: F.coat, body: el,
      anchor: () => {
        const j = dogCard.id === id ? findDog(id) : -1;
        if (j < 0 || dShow[j] < 0.05) return null;
        return { x: dX[j], y: dY[j], z: DOG_SIZE[BREEDS[dBreed[j]].z][1] * DOG_SCALE + 0.9 };
      },
      onClose: () => { if (dogCard.id === id) { dogCard.h = null; dogCard.id = 0; } },
    });
    dogCard.h = h;
    fillDogCard();
  }
  function fillDogCard() {
    const H = dogCard;
    if (!H.h || !H.h.open) { H.h = null; return; }
    const i = findDog(H.id);
    let now, sn;
    if (i < 0) { now = "Gone round the corner, or indoors. Still a very good dog."; sn = H.sniffs.textContent; }
    else {
      const F = dogFacts(i);
      now = `Now: ${nowText(i)}`;
      sn = `Has sniffed ${plural(F.lamps, "lamp post", "lamp posts")} and ${plural(F.trees, "tree", "trees")} today`;
    }
    if (now + sn === H.key) return;
    H.key = now + sn;
    H.now.textContent = now; H.sniffs.textContent = sn;
  }
  function injectDogStyle() {
    if (document.getElementById("life-dog-style")) return;
    const st = document.createElement("style");
    st.id = "life-dog-style";
    st.textContent = `
      .life-dog { font: 13px/1.45 "Inter", system-ui, sans-serif; }
      .life-dog-rate { display: flex; align-items: baseline; gap: 10px; margin: 2px 0 6px; }
      .life-dog-score { font: 500 28px/1 "Fraunces", Georgia, serif; color: var(--scarlet, #b3202a); letter-spacing: -0.01em; }
      .life-dog-good { font: italic 15px/1.2 "Fraunces", Georgia, serif; color: var(--mute, #7a7064); }
      .life-dog-now { margin: 0 0 8px; padding: 6px 10px; border-radius: 8px; background: var(--well, #f1ebdd); font-size: 12.5px; }
      .life-dog-facts { margin: 0; padding: 0; list-style: none; display: grid; gap: 3px; }
      .life-dog-facts li::before { content: "\\2022"; color: var(--line, #e3dac2); margin-right: 7px; }
      .life-dog-src { margin: 8px 0 0; font-size: 11px; color: var(--mute, #7a7064); }
    `;
    document.head.append(st);
  }

  // ---------------------------------------------------------------- stepping and pace
  // The simulation steps in every map frame, by the time since its last step. The map only draws while something moves
  // on screen, so between frames a 4 Hz timer carries the traffic on (lights change, queues pull away, cars drive in
  // from the margin) and wakes the map when something on screen starts to move.
  let failed = false, lastSimAt = performance.now();
  function step(maxDt) {
    if (failed) return;
    const now = performance.now(), dt = Math.min(maxDt, Math.max(0, (now - lastSimAt) / 1000));
    lastSimAt = now;
    try { stepSim(dt); } catch (e) {
      // a broken simulation should not spam the console every frame: report once, then rest
      failed = true; nCars = 0; nPeople = 0;
      console.error("life: simulation stopped", e);
    }
  }
  app.on("frame", () => step(0.25));
  let askCars = 0, askPeople = 0;   // what the layers last asked for (0: the map may be asleep)
  setInterval(() => {
    if (failed || document.hidden || performance.now() - lastSimAt < 200) return;   // frames are coming: they step it
    const carsOn = app.layerEnabled("cars"), peopleOn = app.layerEnabled("people");
    if (!carsOn && !peopleOn && !nCars && !nPeople) return;
    step(0.5);
    if ((carsOn && askCars === 0 && carsWant() > 0) || (peopleOn && askPeople === 0 && peopleWant() > 0)) app.requestRender("life");
  }, 250);
  // Frames per second for a step of about STEP px a frame by the fastest car (person) on screen, within limits, and
  // enough for a fade in or out to look smooth; 0 when nothing of the layer on screen moves.
  const STEP = 2;
  function carsWant() {
    if (failed || !nCars || SCALE < CAR_MIN_S) return 0;
    const m = Math.max(12, 8 * SCALE);
    let v = 0, fade = false;
    for (let i = 0; i < nCars; i++) {
      if ((cShow[i] <= 0.01 && cFade[i] <= 0) || R.eTn[cLink[i] >> 1]) continue;
      const px = PA * cX[i] + PB * cY[i] + PE, py = PC * cX[i] + PD * cY[i] + PF;
      if (px < -m || px > VW + m || py < -m - 4 * PK || py > VH + m) continue;
      if (cV[i] > v) v = cV[i];
      if (cFade[i] !== 0) fade = true;
    }
    const pxps = v * SCALE;
    // (far out the cars are specks a few px/s: a step of up to STEP px at 4 fps is as smooth as the eye can tell there)
    let want = pxps > 0.4 ? Math.min(30, Math.max(SCALE >= 2 ? 8 : 4, pxps / STEP)) : 0;
    if (fade && want < 8) want = 8;
    return want;
  }
  function peopleWant() {
    if (failed || !Wk || !nPeople || SCALE < PEOPLE_MIN_S) return 0;
    const m = 6 * SCALE;
    let v = 0, fade = false;
    for (let i = 0; i < nPeople; i++) {
      if (pShow[i] <= 0.01 && pFade[i] <= 0) continue;
      const px = PA * pX[i] + PB * pY[i] + PE, py = PC * pX[i] + PD * pY[i] + PF;
      if (px < -m || px > VW + m || py < -m || py > VH + m) continue;
      if (pV[i] > v) v = pV[i];
      if (pFade[i] !== 0) fade = true;
      if (pDog[i]) { const dv = Math.hypot(dVx[i], dVy[i]); if (dv > v) v = dv; }
    }
    const pxps = v * SCALE;
    // close up their legs swing (about a stride a second): that wants 15 frames a second to read as walking
    let want = pxps > 0.4 ? Math.min(30, Math.max(SCALE >= PEOPLE_DETAIL_S ? 15 : 6, pxps / STEP)) : 0;
    if (fade && want < 8) want = 8;
    return want;
  }
  function stepSim(dt) {
    const t0 = performance.now();
    setCamera();
    if (simT - clockAt > 1 || clockAt < 0) { clockAt = simT; readClock(); }
    const carsOn = app.layerEnabled("cars"), peopleOn = app.layerEnabled("people");
    simT += dt;
    screenRegion(region);
    if (carsOn && SCALE >= CAR_MIN_S) {
      manageCars();
      // big steps are split so that following and stopping stay smooth
      const n = Math.max(1, Math.ceil(dt / 0.05 - 1e-6));
      for (let k = 0; k < n; k++) stepCars(dt / n);
    } else if (!carsOn && nCars) clearCars();
    if (Wk && peopleOn && SCALE >= PEOPLE_SIM_S) {
      managePeople();
      stepPeople(dt);
      stepDogs(dt);
    } else if (nPeople && (!peopleOn || SCALE < PEOPLE_SIM_S * 0.8)) nPeople = 0;
    if (!peopleOn) publishDogs(0);
    if (dogCard.h && simT - dogCard.at > 0.4) { dogCard.at = simT; fillDogCard(); }
    // the counts are published for whoever wants them; the toggles keep saying "simulated" (no count events: these
    // are not real cars and people, and their number depends on how much of the map is near the view)
    life.cars = nCars; life.people = nPeople;
    perf.sim += performance.now() - t0;
    perf.frames++;
  }
  app.on("rotate", () => { cOccT.fill(0); cBeamT.fill(0); pOccT.fill(0); dOccT.fill(0); });

  app.addLayer({ id: "cars", z: 30, fps: () => (askCars = carsWant()), draw: (ctx) => drawCars(ctx) });
  app.addLayer({ id: "people", z: 35, fps: () => (askPeople = peopleWant()), draw: (ctx) => drawPeople(ctx), hit: hitDog, onClick: (id) => openDogCard(id) });
  // the lamps and beams move with the cars, whose layer asks for the frames
  app.addLayer({ id: "cars-lights", z: 84, fps: 0, draw: (ctx) => { if (app.layerEnabled("cars")) drawCarLights(ctx); } });

  if (app.ui && app.ui.registerToggle) {
    app.ui.registerToggle({ id: "cars", label: "Traffic", count: "simulated" });
    app.ui.registerToggle({ id: "people", label: "People", count: "simulated" });
  }
}

// ------------------------------------------------------------------------------------------------ networks
const ROAD_NAMES = Object.keys(ROAD), PATH_NAMES = Object.keys(PATH);
const ROAD_INFO = ROAD_NAMES.map((k) => ROAD[k]), PATH_INFO = PATH_NAMES.map((k) => PATH[k]);
const STEPS_CLS = PATH_NAMES.indexOf("steps"), CYCLE_CLS = PATH_NAMES.indexOf("cycleway");
const FOOT_CLS = PATH_NAMES.indexOf("footway"), PATHW_CLS = PATH_NAMES.indexOf("path"), PED_CLS = PATH_NAMES.indexOf("pedestrian");
const WEIGHTS = new Float64Array(64);

// The graph as typed arrays. Each edge gives two links (2e: a→b, 2e+1: b→a); a link has lanes with offsets to the right
// of travel (lane 0 = the kerb lane), headings at both ends, and the out-links of its end node via outStart/outList.
function buildNet(g, drive, world) {
  const N = g.nodes.length / 2, E = g.edges.length, LK = 2 * E;
  const names = drive ? ROAD_NAMES : PATH_NAMES, fallback = drive ? ROAD_NAMES.indexOf("road") : PATH_NAMES.indexOf("footway");
  const net = { drive, N, E, LK };
  const nx = (net.nx = new Float64Array(N)), ny = (net.ny = new Float64Array(N));
  for (let i = 0; i < N; i++) { nx[i] = g.nodes[2 * i]; ny[i] = g.nodes[2 * i + 1]; }
  net.flags = new Uint8Array(N);
  if (g.flags) for (let i = 0; i < N; i++) net.flags[i] = g.flags[i] | 0;
  net.deg = new Int32Array(N);
  net.eA = new Int32Array(E); net.eB = new Int32Array(E); net.eLen = new Float64Array(E); net.eCls = new Uint8Array(E);
  net.eW = new Float32Array(E); net.eTn = new Uint8Array(E);
  net.ePts = new Array(E); net.eCum = new Array(E); net.eNrm = new Array(E);
  net.lOk = new Uint8Array(LK); net.lNl = new Uint8Array(LK).fill(1); net.lOff = new Float32Array(LK * 8);
  net.lFrom = new Int32Array(LK); net.lTo = new Int32Array(LK);
  net.lHx0 = new Float32Array(LK); net.lHy0 = new Float32Array(LK); net.lHx1 = new Float32Array(LK); net.lHy1 = new Float32Array(LK);
  for (let e = 0; e < E; e++) {
    const ed = g.edges[e], a = ed[0] | 0, b = ed[1] | 0;
    let raw = ed[3];
    if (!raw || raw.length < 4) raw = [nx[a], ny[a], nx[b], ny[b]];
    const pts = Float64Array.from(raw), n = pts.length / 2;
    const cum = new Float64Array(n);
    for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(pts[2 * k] - pts[2 * k - 2], pts[2 * k + 1] - pts[2 * k - 1]);
    // vertex normals (left of the polyline), averaged over the neighbours as the renderer offsets its lane lines
    const nrm = new Float32Array(2 * n);
    let lx = 0, ly = 1;
    for (let k = 0; k < n; k++) {
      const p = Math.max(0, k - 1), q = Math.min(n - 1, k + 1);
      let vx = -(pts[2 * q + 1] - pts[2 * p + 1]), vy = pts[2 * q] - pts[2 * p];
      const m = Math.hypot(vx, vy);
      if (m > 1e-6) { vx /= m; vy /= m; lx = vx; ly = vy; } else { vx = lx; vy = ly; }
      nrm[2 * k] = vx; nrm[2 * k + 1] = vy;
    }
    net.eA[e] = a; net.eB[e] = b; net.deg[a]++; net.deg[b]++;
    net.ePts[e] = pts; net.eCum[e] = cum; net.eNrm[e] = nrm; net.eLen[e] = Math.max(0.05, cum[n - 1]);
    let cls = names.indexOf(ed[4]);
    if (cls < 0) cls = fallback;
    net.eCls[e] = cls;
    net.lFrom[2 * e] = a; net.lTo[2 * e] = b; net.lFrom[2 * e + 1] = b; net.lTo[2 * e + 1] = a;
    if (drive) {
      const k = ed[4], ow = ed[5] | 0, ln = ed[6] | 0;
      net.eTn[e] = ed[7] ? 1 : 0;
      // width and lanes exactly as the build and the renderer derive them, so cars sit in the painted lanes
      const w = ln ? Math.max(ln * 3.4 + (k === "service" ? 0 : 1.5), 4) : ROAD_INFO[cls][3];
      net.eW[e] = w;
      const lanesR = ln || (MAJOR.has(k) ? (ow ? 2 : 4) : ow ? 1 : 2);
      const lw = (w - 1) / lanesR;
      for (let d = 0; d < 2; d++) {
        const l = 2 * e + d;
        net.lOk[l] = k !== "busway" && (ow === 0 || (ow === 1 && d === 0) || (ow === -1 && d === 1)) ? 1 : 0;
        const offs = [];
        if (ow) {
          for (let i = 0; i < Math.min(8, lanesR); i++) { const left = -w / 2 + 0.5 + (i + 0.5) * lw; offs.push(d === 0 ? -left : left); }
        } else {
          const per = Math.max(1, Math.floor(lanesR / 2));
          if (per === 1) offs.push(Math.max(lw * 0.5, w * 0.25));
          else for (let i = 0; i < Math.min(8, per); i++) offs.push((i + 0.5) * lw);
        }
        offs.sort((p, q) => q - p);
        net.lNl[l] = offs.length;
        for (let i = 0; i < offs.length; i++) net.lOff[8 * l + i] = offs[i];
      }
    } else {
      net.eW[e] = PATH_INFO[cls][3];
      net.lOk[2 * e] = net.lOk[2 * e + 1] = 1;
    }
  }
  // headings at the ends of each link, measured over a few metres so a kink at the very end does not mislead
  const tmp = [0, 0];
  const at = (e, se) => {
    const pts = net.ePts[e], cum = net.eCum[e];
    let k = 1;
    while (k < cum.length - 1 && cum[k] < se) k++;
    const seg = cum[k] - cum[k - 1], t = seg > 0 ? Math.max(0, Math.min(1, (se - cum[k - 1]) / seg)) : 0;
    tmp[0] = pts[2 * k - 2] + (pts[2 * k] - pts[2 * k - 2]) * t; tmp[1] = pts[2 * k - 1] + (pts[2 * k + 1] - pts[2 * k - 1]) * t;
    return tmp;
  };
  for (let e = 0; e < E; e++) {
    const L = net.eLen[e], d = Math.min(4, L / 2), pts = net.ePts[e], n = pts.length / 2;
    let [x, y] = at(e, d);
    let sx = x - pts[0], sy = y - pts[1], m = Math.hypot(sx, sy) || 1; sx /= m; sy /= m;
    [x, y] = at(e, L - d);
    let ex = pts[2 * n - 2] - x, ey = pts[2 * n - 1] - y; m = Math.hypot(ex, ey) || 1; ex /= m; ey /= m;
    net.lHx0[2 * e] = sx; net.lHy0[2 * e] = sy; net.lHx1[2 * e] = ex; net.lHy1[2 * e] = ey;
    net.lHx0[2 * e + 1] = -ex; net.lHy0[2 * e + 1] = -ey; net.lHx1[2 * e + 1] = -sx; net.lHy1[2 * e + 1] = -sy;
  }
  // links leaving each node
  net.outStart = new Int32Array(N + 1);
  for (let l = 0; l < LK; l++) net.outStart[net.lFrom[l] + 1]++;
  for (let i = 0; i < N; i++) net.outStart[i + 1] += net.outStart[i];
  net.outList = new Int32Array(LK);
  const fill = net.outStart.slice(0, N);
  for (let l = 0; l < LK; l++) net.outList[fill[net.lFrom[l]]++] = l;
  // where traffic leaves the map instead of turning round: the nodes where the build cut the graph at the slab's edge
  // (flag EXIT); data from before that mark has none, and then any node near the edge stands in
  net.nEdge = new Uint8Array(N);
  let exits = 0;
  for (let i = 0; i < N; i++) if (net.flags[i] & EXIT) { net.nEdge[i] = 1; exits++; }
  if (!exits) for (let i = 0; i < N; i++) if (nx[i] - world.x0 < 70 || world.x1 - nx[i] < 70 || ny[i] - world.y0 < 70 || world.y1 - ny[i] < 70) net.nEdge[i] = 1;
  net.exits = exits;
  // filled lazily (see insideOf, decksOver, sideOf): per edge, the stretches inside buildings, the bridge decks above it,
  // and how far to each side it is clear of walls
  net.inside = new Array(E); net.under = new Array(E); net.side = new Array(E);
  return net;
}

// ------------------------------------------------------------------------------------------------ buildings and bridges
// Buildings standing on the ground, binned by bounding box: a street or path running inside one is drawn under it, so
// whoever is there is out of sight. (Raised ones, mh > 2.2, are canopies and bridges: app.scene.inFront deals with them.)
function makeSolids(buildings) {
  const CELL = 50, grid = new Map(), bb = new Float32Array(buildings.length * 4);
  buildings.forEach((b, i) => {
    if (b.hidden || (b.mh || 0) > 2.2 || !b.p || !b.p[0] || b.p[0].length < 6) return;
    const f = b.p[0];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < f.length; k += 2) { if (f[k] < x0) x0 = f[k]; if (f[k] > x1) x1 = f[k]; if (f[k + 1] < y0) y0 = f[k + 1]; if (f[k + 1] > y1) y1 = f[k + 1]; }
    bb[4 * i] = x0; bb[4 * i + 1] = y0; bb[4 * i + 2] = x1; bb[4 * i + 3] = y1;
    for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
      const key = gx * 65536 + gy;
      let c = grid.get(key); if (!c) grid.set(key, (c = [])); c.push(i);
    }
  });
  return { CELL, grid, buildings, bb };
}
function insideSolid(S, x, y) {
  const c = S.grid.get(Math.floor(x / S.CELL) * 65536 + Math.floor(y / S.CELL));
  if (!c) return false;
  const bb = S.bb;
  for (const i of c) {
    if (x < bb[4 * i] || x > bb[4 * i + 2] || y < bb[4 * i + 1] || y > bb[4 * i + 3]) continue;
    const p = S.buildings[i].p;
    if (!ringHas(p[0], x, y)) continue;
    let hole = false;
    for (let h = 1; h < p.length && !hole; h++) hole = ringHas(p[h], x, y);   // a courtyard is outdoors
    if (!hole) return true;
  }
  return false;
}
function ringHas(f, x, y) {
  let inside = false;
  for (let i = 0, n = f.length, j = n - 2; i < n; j = i, i += 2) {
    const xi = f[i], yi = f[i + 1], xj = f[j], yj = f[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// The stretches of edge e that run inside a building, as [from, to, …] metres from its first node (null: none). Sampled
// every metre, the first time anyone goes that way.
function insideOf(net, e, S) {
  let r = net.inside[e];
  if (r !== undefined) return r;
  r = null;
  const pts = net.ePts[e], cum = net.eCum[e], L = net.eLen[e];
  const n = Math.max(1, Math.ceil(L)), step = L / n;
  let q = 1, from = -1;
  for (let k = 0; k <= n; k++) {
    const se = k < n ? (k + 0.5) * step : Infinity;
    let inside = false;
    if (k < n) {
      while (q < cum.length - 1 && cum[q] < se) q++;
      const seg = cum[q] - cum[q - 1], t = seg > 0 ? (se - cum[q - 1]) / seg : 0;
      inside = insideSolid(S, pts[2 * q - 2] + (pts[2 * q] - pts[2 * q - 2]) * t, pts[2 * q - 1] + (pts[2 * q + 1] - pts[2 * q - 1]) * t);
    }
    if (inside && from < 0) from = k * step;
    else if (!inside && from >= 0) { (r || (r = [])).push(from, Math.min(L, k * step)); from = -1; }
  }
  net.inside[e] = r ? Float32Array.from(r) : null;
  return net.inside[e];
}
// How far to either side of edge e's line one can go without walking into a building (with room for a body): [lo, hi]
// along the line's left normal, within ±reach, or null when nothing is in the way. Paths often hug a wall: without this
// the spread across the path puts walkers inside it, where they show on the wall or roof. Sampled every two metres,
// ends included, leaving out the stretches that run indoors.
function sideOf(net, e, S, reach) {
  let r = net.side[e];
  if (r !== undefined) return r;
  const pts = net.ePts[e], cum = net.eCum[e], nrm = net.eNrm[e], L = net.eLen[e], rs = insideOf(net, e, S);
  const n = Math.max(1, Math.ceil(L / 2)), BODY = 0.3;
  let lo = -reach, hi = reach, q = 1;
  for (let k = 0; k <= n; k++) {
    const se = k * (L / n);
    let indoors = false;
    if (rs) for (let j = 0; j < rs.length; j += 2) if (se > rs[j] - 1 && se < rs[j + 1] + 1) indoors = true;
    if (indoors) continue;
    while (q < cum.length - 1 && cum[q] < se) q++;
    const seg = cum[q] - cum[q - 1], t = seg > 0 ? (se - cum[q - 1]) / seg : 0;
    const x = pts[2 * q - 2] + (pts[2 * q] - pts[2 * q - 2]) * t, y = pts[2 * q - 1] + (pts[2 * q + 1] - pts[2 * q - 1]) * t;
    const nx = nrm[2 * q - 2] + (nrm[2 * q] - nrm[2 * q - 2]) * t, ny = nrm[2 * q - 1] + (nrm[2 * q + 1] - nrm[2 * q - 1]) * t;
    while (hi > -reach && insideSolid(S, x + nx * (hi + BODY), y + ny * (hi + BODY))) hi -= 0.25;
    while (lo < reach && insideSolid(S, x + nx * (lo - BODY), y + ny * (lo - BODY))) lo += 0.25;
  }
  if (lo > hi) lo = hi = (lo + hi) / 2;
  r = lo > -reach || hi < reach ? Float32Array.of(lo, hi) : null;
  net.side[e] = r;
  return r;
}

// Bridge decks (roads and paths on bridges), as the renderer draws them, with their segments binned on the ground.
function makeDecks(data) {
  const items = [], CELL = 50, grid = new Map();
  const add = (f, hw) => {
    if (!f.br || f.tn || !f.pts || f.pts.length < 4) return;
    const it = items.length, pts = f.pts;
    items.push({ pts, hw, ly: f.ly != null ? f.ly : 1 });   // a bridge without a layer is taken to be on layer 1
    for (let s = 0; s + 3 < pts.length; s += 2) {
      const x0 = Math.min(pts[s], pts[s + 2]) - hw, x1 = Math.max(pts[s], pts[s + 2]) + hw;
      const y0 = Math.min(pts[s + 1], pts[s + 3]) - hw, y1 = Math.max(pts[s + 1], pts[s + 3]) + hw;
      for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
        const key = gx * 65536 + gy;
        let c = grid.get(key); if (!c) grid.set(key, (c = [])); c.push(it, s >> 1);
      }
    }
  };
  for (const r of data.roads || []) add(r, r.w / 2 + DECK_EDGE_ROAD);
  for (const p of data.paths || []) add(p, p.w / 2 + DECK_EDGE_PATH);
  return { items, CELL, grid };
}
// The highest layer among the decks (other than skip) that run along direction (ux, uy) through ground point (x, y):
// the bridge, if any, that something going that way there is on. -Infinity when none.
function deckAlong(D, x, y, ux, uy, skip) {
  const c = D.grid.get(Math.floor(x / D.CELL) * 65536 + Math.floor(y / D.CELL));
  let best = -Infinity;
  if (c) for (let k = 0; k < c.length; k += 2) {
    const it = D.items[c[k]];
    if (c[k] === skip || it.ly <= best) continue;
    const p = it.pts, s = 2 * c[k + 1], ax = p[s], ay = p[s + 1], dx = p[s + 2] - ax, dy = p[s + 3] - ay, L = Math.hypot(dx, dy);
    if (L < 1e-6 || Math.abs(dx * uy - dy * ux) > 0.35 * L) continue;   // not running the same way
    if (segDist(x, y, ax, ay, dx, dy) <= it.hw) best = it.ly;
  }
  return best;
}
function segDist(x, y, ax, ay, dx, dy) {
  const L2 = dx * dx + dy * dy, t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
  return Math.hypot(ax + dx * t - x, ay + dy * t - y);
}
// The decks edge e passes under (indices into D.items), or null: decks it crosses on the ground, unless it is on a bridge
// itself there (a deck running along it) on the same layer or higher. Where it ends on the deck's line it joins that
// bridge rather than passing under it: so when another edge at that node runs along the deck.
function decksOver(net, e, D) {
  let u = net.under[e];
  if (u !== undefined) return u;
  u = null;
  const pts = net.ePts[e], np = pts.length / 2, CELL = D.CELL;
  for (let k = 1; k < np && D.items.length; k++) {
    const ax = pts[2 * k - 2], ay = pts[2 * k - 1], dx = pts[2 * k] - ax, dy = pts[2 * k + 1] - ay, len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    for (let gx = Math.floor(Math.min(ax, ax + dx) / CELL); gx <= Math.floor(Math.max(ax, ax + dx) / CELL); gx++) {
      for (let gy = Math.floor(Math.min(ay, ay + dy) / CELL); gy <= Math.floor(Math.max(ay, ay + dy) / CELL); gy++) {
        const c = D.grid.get(gx * 65536 + gy);
        if (!c) continue;
        for (let j = 0; j < c.length; j += 2) {
          const id = c[j];
          if (u && u.includes(id)) continue;
          const it = D.items[id], p = it.pts, s = 2 * c[j + 1];
          const cx = p[s], cy = p[s + 1], fx = p[s + 2] - cx, fy = p[s + 3] - cy, flen = Math.hypot(fx, fy);
          const den = dx * fy - dy * fx;
          if (Math.abs(den) < 0.3 * len * flen) continue;            // (nearly) parallel: no crossing
          const t = ((cx - ax) * fy - (cy - ay) * fx) / den, w = ((cx - ax) * dy - (cy - ay) * dx) / den;
          if (t < 0 || t > 1 || w < 0 || w > 1) continue;
          const px = ax + dx * t, py = ay + dy * t;
          if (deckAlong(D, px, py, dx / len, dy / len, id) >= it.ly) continue;   // on a bridge as high or higher
          const atEnd = (k === 1 && t * len < 1) ? net.eA[e] : (k === np - 1 && (1 - t) * len < 1) ? net.eB[e] : -1;
          if (atEnd >= 0 && joinsDeck(net, atEnd, D, id, px, py)) continue;
          (u || (u = [])).push(id);
        }
      }
    }
  }
  net.under[e] = u;
  return u;
}
function joinsDeck(net, n, D, id, x, y) {
  const it = D.items[id], p = it.pts;
  for (let k = net.outStart[n]; k < net.outStart[n + 1]; k++) {
    const m = net.outList[k], ux = net.lHx0[m], uy = net.lHy0[m];
    for (let s = 0; s + 3 < p.length; s += 2) {
      const ax = p[s], ay = p[s + 1], dx = p[s + 2] - ax, dy = p[s + 3] - ay, L = Math.hypot(dx, dy);
      if (L > 1e-6 && Math.abs(dx * uy - dy * ux) <= 0.35 * L && segDist(x, y, ax, ay, dx, dy) <= it.hw) return true;
    }
  }
  return false;
}

// Stop lines, junction curve radii, right of way and stop signs, from the shape of each junction.
function prepareDrive(R) {
  const { N, LK } = R;
  R.lSB = new Float32Array(LK); R.lR0 = new Float32Array(LK); R.lR1 = new Float32Array(LK);
  R.lAxis = new Float32Array(LK); R.lStop = new Uint8Array(LK); R.lPri = new Uint8Array(LK);
  R.nJ = new Uint8Array(N);
  const rank = (l) => ROAD_INFO[R.eCls[l >> 1]][1];
  const maxRank = new Int8Array(N).fill(-9), minRank = new Int8Array(N).fill(99);
  for (let l = 0; l < LK; l++) { const n = R.lTo[l], r = rank(l); if (r > maxRank[n]) maxRank[n] = r; if (r < minRank[n]) minRank[n] = r; }
  for (let l = 0; l < LK; l++) {
    const n = R.lTo[l], L = R.eLen[l >> 1], hx = R.lHx1[l], hy = R.lHy1[l];
    let sb, r1;
    if (R.deg[n] >= 3) {
      // stop short of the kerb of the widest road crossing here
      sb = 1.5;
      for (let k = R.outStart[n]; k < R.outStart[n + 1]; k++) {
        const m = R.outList[k];
        if ((m >> 1) === (l >> 1)) continue;
        const sin = Math.abs(hx * R.lHy0[m] - hy * R.lHx0[m]);
        if (sin < 0.45) continue;
        sb = Math.max(sb, R.eW[m >> 1] / 2 / sin + 0.6);
      }
      sb = Math.min(sb, 14, 0.45 * L);
      r1 = Math.min(Math.max(3, Math.min(10, sb + 0.8)), 0.42 * L);
    } else {
      sb = Math.min(1.2, 0.3 * L);
      r1 = Math.min(4, 0.42 * L);
    }
    R.lSB[l] = sb; R.lR1[l] = r1;
    let ang = Math.atan2(hy, hx);
    if (ang < 0) ang += Math.PI;
    R.lAxis[l] = ang % Math.PI;
  }
  for (let l = 0; l < LK; l++) R.lR0[l] = R.lR1[l ^ 1];
  for (let l = 0; l < LK; l++) {
    const n = R.lTo[l];
    if (R.flags[n] & 2) {
      if (R.deg[n] >= 3) R.lStop[l] = rank(l) < maxRank[n] || maxRank[n] === minRank[n] ? 1 : 0;
      else {
        // a stop sign on the approach: only the way into the junction stops
        let m = -1;
        for (let k = R.outStart[n]; k < R.outStart[n + 1]; k++) if ((R.outList[k] >> 1) !== (l >> 1)) { m = R.outList[k]; break; }
        const ahead = m >= 0 && R.deg[R.lTo[m]] >= 3 && R.eLen[m >> 1] < 45;
        const behind = R.deg[R.lFrom[l]] >= 3 && R.eLen[l >> 1] < 45;
        R.lStop[l] = ahead || !behind ? 1 : 0;
      }
    }
    R.lPri[l] = rank(l) >= maxRank[n] && !R.lStop[l] ? 1 : 0;
  }
  for (let n = 0; n < N; n++) R.nJ[n] = R.deg[n] >= 3 ? 1 : 0;
}

// Signal clusters: signal nodes within ~30 m of each other run one controller with two phases, chosen by the bearing of
// each approach against the cluster's main road. Junction nodes inside a cluster are governed by it (no yielding).
function buildSignals(R) {
  const { N, LK } = R;
  const sig = [];
  for (let n = 0; n < N; n++) if (R.flags[n] & 1) sig.push(n);
  const par = sig.map((_, i) => i);
  const find = (i) => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
  for (let i = 0; i < sig.length; i++) for (let j = i + 1; j < sig.length; j++) {
    if (Math.hypot(R.nx[sig[i]] - R.nx[sig[j]], R.ny[sig[i]] - R.ny[sig[j]]) < 32) par[find(i)] = find(j);
  }
  const id = new Map();
  R.nSig = new Int32Array(N).fill(-1);
  sig.forEach((n, i) => { const r = find(i); if (!id.has(r)) id.set(r, id.size); R.nSig[n] = id.get(r); });
  const C = id.size;
  const cx = new Float64Array(C), cy = new Float64Array(C), cn = new Int32Array(C);
  for (const n of sig) { const c = R.nSig[n]; cx[c] += R.nx[n]; cy[c] += R.ny[n]; cn[c]++; }
  for (let c = 0; c < C; c++) { cx[c] /= cn[c]; cy[c] /= cn[c]; }
  // junctions inside a signalled intersection follow its lights
  const inCluster = new Int32Array(N).fill(-1);
  for (let n = 0; n < N; n++) {
    if (R.nSig[n] >= 0) { inCluster[n] = R.nSig[n]; continue; }
    if (R.deg[n] < 3) continue;
    for (const s of sig) if (Math.hypot(R.nx[n] - R.nx[s], R.ny[n] - R.ny[s]) < 24) { inCluster[n] = R.nSig[s]; break; }
  }
  for (let n = 0; n < N; n++) if (inCluster[n] >= 0) R.nJ[n] = 0;
  // the main axis of each cluster: the biggest road arriving at it
  const best = new Float64Array(C).fill(-1), axis = new Float32Array(C);
  for (let l = 0; l < LK; l++) {
    const n = R.lTo[l], c = R.nSig[n];
    if (c < 0 || !R.lOk[l]) continue;
    const score = ROAD_INFO[R.eCls[l >> 1]][1] * 1000 + Math.min(999, R.eLen[l >> 1]);
    if (score > best[c]) { best[c] = score; axis[c] = R.lAxis[l]; }
  }
  R.lSig = new Int32Array(LK).fill(-1); R.lPh = new Uint8Array(LK);
  const two = new Uint8Array(C);
  for (let l = 0; l < LK; l++) {
    const n = R.lTo[l], c = R.nSig[n];
    if (c < 0 || !R.lOk[l]) continue;
    // a short link inside the intersection: the car is already through the lights
    if (inCluster[R.lFrom[l]] === c && R.eLen[l >> 1] < 45) continue;
    let d = Math.abs(R.lAxis[l] - axis[c]) % Math.PI;
    if (d > Math.PI / 2) d = Math.PI - d;
    R.lSig[l] = c; R.lPh[l] = d < Math.PI / 4 ? 0 : 1;
    if (R.lPh[l]) two[c] = 1;
  }
  // timings: green 25–35 s on the main road, 22–30 s across, staggered; a lone pedestrian signal mostly shows green
  R.sG0 = new Float32Array(C); R.sG1 = new Float32Array(C); R.sOff = new Float32Array(C);
  for (let c = 0; c < C; c++) {
    const h1 = hash2(cx[c], cy[c]), h2 = hash2(cy[c] + 7.1, cx[c] - 3.3), h3 = hash2(cx[c] * 0.37 + 11, cy[c] * 0.61 - 5);
    R.sG0[c] = two[c] ? 25 + 10 * h1 : 38 + 10 * h1;
    R.sG1[c] = two[c] ? 22 + 8 * h2 : 10;
    R.sOff[c] = h3 * (R.sG0[c] + R.sG1[c] + 2 * (YELLOW + ALL_RED));
  }
  R.nClusters = C;
}

// Spawn pieces: short stretches of each edge, binned in a ground grid, each with two weights (wA + wB·k at sample time).
function buildPieces(net, step, world, weigh) {
  const pE = [], pS = [], pLen = [], pX = [], pY = [], wA = [], wB = [], cell = [];
  const CELL = 100, GW = Math.ceil((world.x1 - world.x0) / CELL) + 1, GH = Math.ceil((world.y1 - world.y0) / CELL) + 1;
  for (let e = 0; e < net.E; e++) {
    const L = net.eLen[e], n = Math.max(1, Math.round(L / step)), len = L / n;
    const pts = net.ePts[e], cum = net.eCum[e];
    for (let k = 0; k < n; k++) {
      const se = (k + 0.5) * len;
      let q = 1;
      while (q < cum.length - 1 && cum[q] < se) q++;
      const seg = cum[q] - cum[q - 1], t = seg > 0 ? (se - cum[q - 1]) / seg : 0;
      const x = pts[2 * q - 2] + (pts[2 * q] - pts[2 * q - 2]) * t, y = pts[2 * q - 1] + (pts[2 * q + 1] - pts[2 * q - 1]) * t;
      // only on the slab (older data runs the graphs on past its edge)
      if (x < world.x0 + 2 || x > world.x1 - 2 || y < world.y0 + 2 || y > world.y1 - 2) continue;
      const w = weigh(e, x, y);
      if (!w || w[0] + w[1] <= 0) continue;
      const gx = Math.max(0, Math.min(GW - 1, Math.floor((x - world.x0) / CELL))), gy = Math.max(0, Math.min(GH - 1, Math.floor((y - world.y0) / CELL)));
      pE.push(e); pS.push(se); pLen.push(len); pX.push(x); pY.push(y); wA.push(w[0] * len); wB.push(w[1] * len); cell.push(gy * GW + gx);
    }
  }
  const NP = pE.length;
  const cellStart = new Int32Array(GW * GH + 1);
  for (let p = 0; p < NP; p++) cellStart[cell[p] + 1]++;
  for (let c = 0; c < GW * GH; c++) cellStart[c + 1] += cellStart[c];
  const cellList = new Int32Array(NP), fill = cellStart.slice(0, GW * GH);
  for (let p = 0; p < NP; p++) cellList[fill[cell[p]]++] = p;
  return { NP, pE: Int32Array.from(pE), pS: Float32Array.from(pS), pLen: Float32Array.from(pLen), pX: Float32Array.from(pX), pY: Float32Array.from(pY), wA: Float32Array.from(wA), wB: Float32Array.from(wB), cellStart, cellList, CELL, GW, GH, world };
}

// Weighted sampling of the pieces inside a ground box; rebuilt only when the box's cells or the weights change.
function makeSampler(P) {
  const list = new Int32Array(P.NP), pref = new Float64Array(P.NP);
  let n = 0, key = "";
  const S = {
    total: 0,
    // b: a region (see init) — the pieces inside its rectangle, in the camera's ground frame
    update(b, kA, kB) {
      const gx0 = Math.max(0, Math.floor((b.x0 - P.world.x0) / P.CELL)), gx1 = Math.min(P.GW - 1, Math.floor((b.x1 - P.world.x0) / P.CELL));
      const gy0 = Math.max(0, Math.floor((b.y0 - P.world.y0) / P.CELL)), gy1 = Math.min(P.GH - 1, Math.floor((b.y1 - P.world.y0) / P.CELL));
      const q5 = (v) => Math.round(v / 20);
      const k = `${q5(b.u0)},${q5(b.u1)},${q5(b.v0)},${q5(b.v1)},${b.D0.toFixed(3)},${b.D1.toFixed(3)},${kA.toFixed(2)},${kB.toFixed(2)}`;
      if (k === key) return;
      key = k; n = 0;
      let tot = 0;
      for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
        const c = gy * P.GW + gx;
        for (let q = P.cellStart[c]; q < P.cellStart[c + 1]; q++) {
          const p = P.cellList[q], x = P.pX[p], y = P.pY[p];
          const u = x * b.U0 + y * b.U1, v = x * b.D0 + y * b.D1;
          if (u < b.u0 || u > b.u1 || v < b.v0 || v > b.v1) continue;
          tot += P.wA[p] * kA + P.wB[p] * kB;
          list[n] = p; pref[n] = tot; n++;
        }
      }
      S.total = tot;
    },
    sample() {
      if (!n || S.total <= 0) return -1;
      const r = Math.random() * S.total;
      let lo = 0, hi = n - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (pref[m] < r) lo = m + 1; else hi = m; }
      return list[lo];
    },
  };
  return S;
}

// ------------------------------------------------------------------------------------------------ helpers
// A stand-in for a path (see drawCut) that keeps each closed piece apart: its commands (code and four numbers: 0 move,
// 1 line, 2 circle, 3 ellipse) and its bounds, so that one piece can be replayed as "a box minus this shape". Only what
// renderer.silhouette uses is implemented: full circles and unrotated ellipses.
export function makeRecorder() {
  let ops = new Float64Array(2048), n = 0, info = new Float64Array(6 * 64);   // per piece: first op, end, x0, y0, x1, y1
  const paths = [], mats = [];      // pieces added whole with addPath (their first op is -1 - their index here)
  let open = false;
  const rec = { count: 0 };
  function start(first) {
    if (6 * (rec.count + 1) > info.length) { const o = new Float64Array(info.length * 2); o.set(info); info = o; }
    const b = 6 * rec.count++;
    info[b] = first; info[b + 1] = n; info[b + 2] = info[b + 3] = Infinity; info[b + 4] = info[b + 5] = -Infinity;
  }
  function grow(x0, y0, x1, y1) {
    const b = 6 * (rec.count - 1);
    if (x0 < info[b + 2]) info[b + 2] = x0; if (y0 < info[b + 3]) info[b + 3] = y0;
    if (x1 > info[b + 4]) info[b + 4] = x1; if (y1 > info[b + 5]) info[b + 5] = y1;
  }
  function op(code, a, b, c, d) {
    if (!open) { start(n); open = true; }
    if (n + 5 > ops.length) { const o = new Float64Array(ops.length * 2); o.set(ops); ops = o; }
    ops[n++] = code; ops[n++] = a; ops[n++] = b; ops[n++] = c; ops[n++] = d;
    info[6 * (rec.count - 1) + 1] = n;
  }
  rec.reset = () => { n = 0; rec.count = 0; open = false; paths.length = 0; mats.length = 0; };
  rec.moveTo = (x, y) => { open = false; op(0, x, y, 0, 0); grow(x, y, x, y); };
  rec.lineTo = (x, y) => { op(1, x, y, 0, 0); grow(x, y, x, y); };
  rec.closePath = () => { open = false; };
  rec.arc = (x, y, r) => { op(2, x, y, r, r); grow(x - r, y - r, x + r, y + r); };
  rec.ellipse = (x, y, rx, ry) => { op(3, x, y, rx, ry); grow(x - rx, y - ry, x + rx, y + ry); };
  rec.meets = (p, X0, Y0, X1, Y1) => { const b = 6 * p; return info[b + 4] >= X0 && info[b + 2] <= X1 && info[b + 5] >= Y0 && info[b + 3] <= Y1; };
  // clip ctx to the box [X0, Y0, X1, Y1] minus piece p
  rec.cut = (ctx, p, X0, Y0, X1, Y1) => {
    const b = 6 * p, first = info[b];
    if (first < 0) {
      const path = new Path2D();
      path.rect(X0, Y0, X1 - X0, Y1 - Y0); path.addPath(paths[-1 - first], mats[-1 - first]);
      ctx.clip(path, "evenodd");
      return;
    }
    ctx.beginPath(); ctx.rect(X0, Y0, X1 - X0, Y1 - Y0);
    for (let k = first, end = info[b + 1]; k < end; k += 5) {
      const c = ops[k], x = ops[k + 1], y = ops[k + 2];
      if (c === 0) ctx.moveTo(x, y);
      else if (c === 1) ctx.lineTo(x, y);
      else if (c === 2) { ctx.moveTo(x + ops[k + 3], y); ctx.arc(x, y, ops[k + 3], 0, Math.PI * 2); }
      else { ctx.moveTo(x + ops[k + 3], y); ctx.ellipse(x, y, ops[k + 3], ops[k + 4], 0, 0, Math.PI * 2); }
    }
    ctx.closePath();
    ctx.clip("evenodd");
  };
  // the same recorder, also taking addPath: the whole path (under matrix m) as one piece, bounded by its unit box mapped
  // through m with some room to spare (the renderer's templates lie within ±1.2)
  rec.withAddPath = () => Object.assign(Object.create(rec), {
    addPath(path, m) {
      open = false;
      start(-1 - paths.length); paths.push(path); mats.push(m);
      for (let c = 0; c < 4; c++) {
        const u = c & 1 ? 1.2 : -1.2, v = c & 2 ? 1.2 : -1.2, x = m.a * u + m.c * v + m.e, y = m.b * u + m.d * v + m.f;
        grow(x, y, x, y);
      }
    },
  });
  return rec;
}
// the convex hull of the first n points (flat x, y pairs) of P, into out; returns its number of points
const HULL_IDX = new Int32Array(16), HULL_CH = new Int32Array(32);
function hull(P, n, out) {
  for (let i = 0; i < n; i++) {
    let j = i;
    while (j > 0 && (P[2 * HULL_IDX[j - 1]] > P[2 * i] || (P[2 * HULL_IDX[j - 1]] === P[2 * i] && P[2 * HULL_IDX[j - 1] + 1] > P[2 * i + 1]))) { HULL_IDX[j] = HULL_IDX[j - 1]; j--; }
    HULL_IDX[j] = i;
  }
  const cross = (o, a, b) => (P[2 * a] - P[2 * o]) * (P[2 * b + 1] - P[2 * o + 1]) - (P[2 * a + 1] - P[2 * o + 1]) * (P[2 * b] - P[2 * o]);
  let k = 0;
  for (let i = 0; i < n; i++) { const q = HULL_IDX[i]; while (k >= 2 && cross(HULL_CH[k - 2], HULL_CH[k - 1], q) <= 0) k--; HULL_CH[k++] = q; }
  for (let i = n - 2, lo = k + 1; i >= 0; i--) { const q = HULL_IDX[i]; while (k >= lo && cross(HULL_CH[k - 2], HULL_CH[k - 1], q) <= 0) k--; HULL_CH[k++] = q; }
  k--;   // the first point comes round again at the end
  for (let i = 0; i < k; i++) { out[2 * i] = P[2 * HULL_CH[i]]; out[2 * i + 1] = P[2 * HULL_CH[i] + 1]; }
  return k;
}
// a number in [0, 1) from a seed and a key: a dog's looks and story all come from its seed
function hashSeed(seed, k) {
  let h = Math.imul(seed ^ Math.imul(k + 1, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function hash2(x, y) {
  let h = Math.imul((x * 100) | 0, 374761393) ^ Math.imul((y * 100) | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function cumulative(ws) { const out = new Float64Array(ws.length); let t = 0; ws.forEach((w, i) => { t += w; out[i] = t; }); return out; }
function pickCum(cum) { const r = Math.random() * cum[cum.length - 1]; for (let i = 0; i < cum.length; i++) if (r < cum[i]) return i; return cum.length - 1; }
export function curve(knots, h) {
  for (let i = 1; i < knots.length; i++) if (h <= knots[i][0]) {
    const [h0, v0] = knots[i - 1], [h1, v1] = knots[i];
    return v0 + ((v1 - v0) * (h - h0)) / (h1 - h0 || 1);
  }
  return knots[knots.length - 1][1];
}
// the campus's own wall clock, whatever the visitor's time zone
const TZ_FMT = (() => { try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", hour: "numeric", minute: "numeric", second: "numeric" }); } catch { return null; } })();
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export function localTime(d) {
  if (TZ_FMT) {
    const parts = TZ_FMT.formatToParts(d);
    let h = 0, m = 0, s = 0, dow = d.getDay();
    for (const p of parts) {
      if (p.type === "hour") h = +p.value % 24; else if (p.type === "minute") m = +p.value; else if (p.type === "second") s = +p.value;
      else if (p.type === "weekday" && p.value in DOW) dow = DOW[p.value];
    }
    return { h: h + m / 60 + s / 3600, dow };
  }
  return { h: d.getHours() + d.getMinutes() / 60, dow: d.getDay() };
}
// the sun's altitude (degrees) for a moment and place: a low-precision almanac, plenty for "is it dark?"
function sunAltitude(date, lat, lon) {
  const rad = Math.PI / 180, d = date.getTime() / 86400000 - 10957.5;
  const g = (357.529 + 0.98560028 * d) * rad, q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad, e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = (gmst * 15 + lon) * rad - ra;
  return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha)) / rad;
}
function nightFromSun(alt) { const t = Math.max(0, Math.min(1, (2 - alt) / 9)); return t * t * (3 - 2 * t); }

// colour ramps: one paint in 20 shades, so a face's light picks a ready-made string (no per-frame string building)
const RAMP_N = 20, RAMP_0 = 0.5, RAMP_STEP = 0.04;
function ramp(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const out = [];
  for (let k = 0; k < RAMP_N; k++) {
    const f = RAMP_0 + k * RAMP_STEP;
    // above 1, mix toward white rather than clipping, so light paints stay soft
    const c = (v) => Math.round(f <= 1 ? v * f : v + (255 - v) * (f - 1) * 0.9);
    out.push(`rgb(${c(r)},${c(g)},${c(b)})`);
  }
  return out;
}
function shadeHex(hex, f) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${Math.round(r * f)},${Math.round(g * f)},${Math.round(b * f)})`;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); else ctx.rect(x, y, w, h);
  ctx.fill();
}
// soft glows for the lights layer: a beam (drawn in a car's ground frame), a headlamp, a tail lamp
function makeSprites() {
  const mk = (w, h) => (typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h }));
  try {
    const cone = mk(128, 64), g = cone.getContext("2d");
    // a beam fanning out ahead: brightest near the car, fading with distance and toward its edges
    g.save(); g.scale(1, 0.5);
    const gr = g.createRadialGradient(0, 64, 4, 0, 64, 128);
    gr.addColorStop(0, "rgba(255,238,200,.75)"); gr.addColorStop(0.45, "rgba(255,228,175,.3)"); gr.addColorStop(1, "rgba(255,220,160,0)");
    g.fillStyle = gr; g.beginPath(); g.moveTo(0, 52); g.lineTo(128, 0); g.lineTo(128, 128); g.lineTo(0, 76); g.closePath(); g.fill();
    g.restore();
    const dot = (inner, outer) => {
      const c = mk(32, 32), x = c.getContext("2d");
      const r = x.createRadialGradient(16, 16, 0, 16, 16, 16);
      r.addColorStop(0, inner); r.addColorStop(0.35, outer); r.addColorStop(1, "rgba(0,0,0,0)");
      x.fillStyle = r; x.fillRect(0, 0, 32, 32);
      return c;
    };
    return { cone, head: dot("rgba(255,250,230,1)", "rgba(255,226,170,.45)"), tail: dot("rgba(255,120,100,1)", "rgba(230,40,30,.45)") };
  } catch { return null; }
}
