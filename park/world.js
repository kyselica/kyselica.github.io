/* Kyselica Park: the map.
   The park is 64 x 48 tiles of 16px. This file lays out the paths, enclosures and scenery, paints the ground
   once into a canvas, and lists every standing object ("prop") so the game can depth-sort them with the visitors. */
(function () {
  'use strict';
  const Park = window.Park;
  const A = Park.art;
  const PAL = A.PAL;
  const T = 16, W = 64, H = 48;
  const G = { GRASS: 0, PATH: 1, PLAZA: 2, WATER: 3, SAND: 4, WOOD: 5, EARTH: 6, MEADOW: 7, SLATE: 8, STONE: 9, BRIDGE: 10, LAWN: 11, NIGHT: 12 };

  /* Where each exhibit sits. `rect` is the fenced enclosure in tiles (inclusive), `sign` the tile its sign stands on,
     `view` the tile a visitor reads it from, `focus` the point (in tiles) the camera favours while its plaque is open. */
  const SITES = {
    dd4: { sign: [25, 14], view: [25, 15], focus: [25.5, 8.5], label: 'DOUBLE DUTCH 4S', zone: 'champions' },
    teamshow: { sign: [38, 14], view: [38, 15], focus: [38.5, 8.5], label: 'TEAM SHOW', zone: 'champions' },
    fennec: { rect: [2, 4, 16, 13], sign: [9, 14], view: [9, 15], label: 'FENNEC\nENGINEERING', zone: 'career', fence: 'wood', ground: G.SAND },
    gmi: { rect: [0, 17, 8, 24], sign: [9, 21], view: [10, 22], label: 'GMI\nBUG HOUSE', zone: 'career', fence: 'hedge', ground: G.LAWN },
    elite: { rect: [47, 4, 61, 13], sign: [54, 14], view: [54, 15], label: 'ELITE JUMPS', zone: 'apps', fence: 'wood', ground: G.MEADOW },
    nextjump: { rect: [55, 17, 62, 25], sign: [54, 21], view: [53, 22], label: 'NEXTJUMP', zone: 'apps', fence: 'wood', ground: G.EARTH },
    hollow: { rect: [44, 41, 62, 47], gate: [51, 52], sign: [49, 40], view: [51, 40], focus: [53, 43.5], label: 'HOLLOW\nCREEK', zone: 'apps', fence: 'iron', ground: G.NIGHT },
    osu: { rect: [0, 28, 8, 38], sign: [9, 33], view: [10, 34], label: 'BUCKEYE\nGROVE', zone: 'school', fence: 'wall', ground: G.LAWN },
    smallosu: { rect: [14, 29, 23, 35], sign: [18, 36], view: [18, 37], label: 'SMALL OSU', zone: 'school', fence: 'wall', ground: G.STONE },
    capstone: { rect: [26, 32, 29, 35], sign: [26, 36], view: [27, 37], label: 'HEART\nHOUSE', zone: 'school', ground: G.STONE },
    make: { rect: [14, 18, 23, 24], sign: [18, 25], view: [18, 26], label: 'MAKE OH/IO', zone: 'hack', fence: 'wood', ground: G.GRASS },
    hack: { rect: [40, 18, 49, 24], sign: [44, 25], view: [44, 26], label: 'HACK OH/IO', zone: 'hack', fence: 'wood', ground: G.GRASS },
    asmol: { rect: [37, 29, 42, 35], sign: [39, 36], view: [39, 37], label: 'LAMP\nGARDEN', zone: 'games', fence: 'hedge', ground: G.SLATE },
    plethos: { rect: [44, 29, 49, 35], sign: [46, 36], view: [46, 37], label: 'PLETHOS', zone: 'games', fence: 'hedge', ground: G.STONE },
    chess: { sign: [37, 22], view: [36, 23], focus: [36, 20], label: 'PARK CHESS', zone: 'gate' },
    about: { view: [27, 45], focus: [27, 43], zone: 'gate' },
    resume: { view: [38, 44], focus: [38, 42], zone: 'gate' },
    contact: { view: [34, 44], focus: [34, 43], zone: 'gate' },
  };
  const ZONES = {
    champions: { name: 'Champions Court', color: PAL.y },
    career: { name: 'Career Canyon', color: PAL.a },
    apps: { name: 'App Outback', color: PAL.R },
    school: { name: 'Buckeye Corner', color: PAL.m },
    hack: { name: "Maker's Yard", color: PAL.c },
    games: { name: 'Puzzle Gardens', color: PAL.Q },
    gate: { name: 'Front Gate', color: PAL.N },
  };
  const ARENA = [19, 1, 44, 13];

  function build() {
    const S = A.S;
    const type = new Uint8Array(W * H), solid = new Uint8Array(W * H), keep = new Uint8Array(W * H);
    const props = [];
    const at = (x, y) => y * W + x;
    const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
    const fill = (x0, y0, x1, y1, t) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inb(x, y)) type[at(x, y)] = t; };
    const block = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inb(x, y)) solid[at(x, y)] = 1; };
    const reserve = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inb(x, y)) keep[at(x, y)] = 1; };
    const prop = (img, x, y, base) => { const p = { img, x: Math.round(x), y: Math.round(y), base: base == null ? Math.round(y) + img.height : base }; props.push(p); return p; };
    /* stand a sprite with its bottom-centre at a pixel position */
    const stand = (img, cxp, by, baseAdj) => prop(img, cxp - img.width / 2, by - img.height, by + (baseAdj || 0));
    const standTile = (img, tx, ty, opt) => { opt = opt || {}; if (!opt.soft) solid[at(tx, ty)] = 1; keep[at(tx, ty)] = 1; return stand(img, tx * T + 8 + (opt.dx || 0), ty * T + 15 + (opt.dy || 0)); };

    /* ----- paths ----- */
    fill(31, 38, 32, 47, G.PATH);      // entrance avenue
    fill(11, 15, 52, 16, G.PATH);      // the loop
    fill(11, 37, 52, 38, G.PATH);
    fill(11, 15, 12, 38, G.PATH);
    fill(51, 15, 52, 38, G.PATH);
    fill(11, 26, 52, 27, G.PATH);      // cross avenues
    fill(31, 14, 32, 38, G.PATH);
    fill(27, 23, 36, 30, G.PLAZA);     // central plaza
    fill(24, 44, 40, 45, G.PATH);      // lane past the kiosk and the gift shop
    fill(29, 44, 34, 46, G.PATH); fill(30, 47, 33, 47, G.PATH);   // entry court
    fill(53, 33, 62, 34, G.PATH);      // spur over the footbridge
    fill(51, 39, 52, 40, G.PATH);      // down to the graveyard gate
    fill(9, 21, 10, 22, G.PATH); fill(9, 33, 10, 34, G.PATH); fill(53, 21, 54, 22, G.PATH);   // short walks up to the side exhibits

    /* ----- enclosures ----- */
    for (const id in SITES) {
      const s = SITES[id];
      if (!s.rect) continue;
      const [x0, y0, x1, y1] = s.rect;
      fill(x0, y0, x1, y1, s.ground);
      reserve(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
    }
    /* ----- the creek: down the east side, under the footbridge and through the graveyard ----- */
    const creek = [[58, 27], [58, 28], [58, 29], [58, 30], [57, 31], [57, 32], [57, 33], [57, 34], [57, 35], [57, 36], [58, 37], [58, 38], [58, 39], [58, 40],
      [58, 41], [58, 42], [59, 43], [59, 44], [59, 45], [59, 46], [59, 47]];
    for (const [x, y] of creek) fill(x, y, x + 1, y, G.WATER);
    fill(56, 33, 59, 34, G.BRIDGE);
    fill(ARENA[0], 4, ARENA[2], 13, G.WOOD);
    fill(ARENA[0], 1, ARENA[2], 3, G.SLATE);
    reserve(ARENA[0] - 1, 0, ARENA[2] + 1, 14);
    fill(34, 18, 37, 21, G.STONE); reserve(33, 17, 38, 22);     // chess board
    reserve(53, 26, 63, 40);                                    // creek side is planted by hand
    reserve(23, 39, 41, 47);                                    // front gate

    /* ----- fences ----- */
    const half = (img, left) => { const c = A.mk(img.width, img.height), g = A.cx(c); g.drawImage(img, left ? 6 : 0, 0, 10, img.height, left ? 6 : 0, 0, 10, img.height); return c; };
    const styles = {
      wood: { h: S.fenceH, v: S.fenceV, cl: half(S.fenceH, true), cr: half(S.fenceH, false) },
      hedge: { h: S.hedge, v: S.hedge, cl: S.hedge, cr: S.hedge },
      wall: { h: S.wallLow, v: S.wallV, cl: S.wallLow, cr: S.wallLow },
      iron: { h: S.gs.fenceH, v: S.gs.fenceV, cl: S.gs.fenceH, cr: S.gs.fenceH },
    };
    const fencePiece = (img, x, y) => { solid[at(x, y)] = 1; prop(img, x * T, y * T + T - img.height, y * T + T - 2); };
    function fence(rect, name, gateAt) {
      const st = styles[name], [x0, y0, x1, y1] = rect;
      for (let x = x0; x <= x1; x++) for (const y of [y0, y1]) {
        if (gateAt && y === y0 && x >= gateAt[0] && x <= gateAt[1]) continue;
        fencePiece(x === x0 ? st.cl : x === x1 ? st.cr : st.h, x, y);
      }
      for (let y = y0 + 1; y < y1; y++) for (const x of [x0, x1]) fencePiece(st.v, x, y);
    }
    for (const id in SITES) if (SITES[id].fence) fence(SITES[id].rect, SITES[id].fence, SITES[id].gate);
    /* the graveyard gate: shut, and it stays shut */
    {
      const s = SITES.hollow, gx = s.gate[0], gy = s.rect[1];
      prop(S.gs.gate, gx * T, gy * T + T - S.gs.gate.height, gy * T + T - 1);
      block(s.gate[0], gy, s.gate[1], gy);
    }

    /* Nothing a visitor can see standing up can be walked through: mark the tiles under the bottom of a prop solid.
       `inset` trims the sprite's sides so a sliver of overhang doesn't block a whole tile. */
    const footprint = (p, inset) => {
      inset = inset == null ? 3 : inset;
      const ty = Math.floor((p.base - 2) / T), xa = p.x + inset, xb = p.x + p.img.width - inset;
      for (let tx = Math.floor(xa / T); tx <= Math.floor((xb - 1) / T); tx++) {
        const overlap = Math.min(xb, (tx + 1) * T) - Math.max(xa, tx * T);
        if (overlap >= 4 && inb(tx, ty)) { solid[at(tx, ty)] = 1; keep[at(tx, ty)] = 1; }
      }
    };

    /* ----- signs ----- */
    for (const id in SITES) {
      const s = SITES[id];
      reserve(s.view[0] - 1, s.view[1] - 1, s.view[0] + 1, s.view[1] + 1);
      if (!s.sign) continue;
      reserve(s.sign[0] - 2, s.sign[1] - 1, s.sign[0] + 2, s.sign[1] + 1);
      s.signProp = standTile(A.sign(s.label, { band: ZONES[s.zone].color }), s.sign[0], s.sign[1]);
      footprint(s.signProp, 2);
    }

    /* =====================================================================
       Exhibit furniture
       ===================================================================== */
    const spots = {};

    /* Champions Court: stands, banner boards, two courts, the trophy */
    {
      const [x0, , x1] = ARENA, wpx = (x1 - x0 + 1) * T;
      prop(A.arenaWall(wpx), x0 * T, 4 * T - 60, 4 * T);
      block(x0, 1, x1, 3);
      for (let y = 4; y <= 12; y++) for (const x of [x0, x1]) fencePiece(S.wallV, x, y);
      for (let x = x0; x <= x1; x++) { if (x === 31 || x === 32) continue; fencePiece(S.stanchion, x, 13); }
      block(31, 13, 32, 13);
      stand(S.trophy, 32 * T, 13 * T + 14);
      spots.dd = { x: 25.5 * T, y: 9 * T };
      spots.show = { x: 38.5 * T, y: 9 * T };
      spots.trophy = { x: 32 * T, y: 13 * T - 6 };
      spots.crowd = { x: x0 * T, y: 4 * T - 60, w: wpx };
    }

    /* Fennec Engineering: a dune enclosure */
    {
      prop(S.burrow, 4 * T, 5 * T + 6, 6 * T + 4); block(4, 5, 4, 5);
      stand(S.cactus, 14 * T + 4, 7 * T + 4); stand(S.cactus, 6 * T, 12 * T + 2); stand(S.cactus, 11 * T + 6, 6 * T + 2);
      stand(S.rock, 12 * T, 11 * T + 8); stand(S.rockS, 8 * T + 4, 8 * T); stand(S.rockS, 14 * T, 10 * T + 4); stand(S.rock, 5 * T + 6, 9 * T + 10);
      spots.fennec = { x0: 3 * T + 8, y0: 6 * T + 8, x1: 15 * T + 8, y1: 12 * T + 8 };
    }

    /* GMI: the bug house */
    {
      stand(S.greenhouse, 4.5 * T, 21 * T + 12); block(2, 18, 6, 21);
      stand(S.bush[1], 1.6 * T, 23 * T + 10); stand(S.bush[2], 7.3 * T, 23 * T + 10);
      spots.bugs = { x0: 1 * T + 4, y0: 22 * T + 2, x1: 8 * T - 4, y1: 23 * T + 12 };
    }

    /* Elite Jumps: the pegasus paddock, with show-jumping hurdles */
    {
      for (const hx of [51, 57]) stand(S.hurdle, hx * T + 8, 9 * T + 10);
      for (const [fx, fy] of [[48.6, 6], [60.4, 6]]) { stand(S.flagpole, fx * T, fy * T + 8); prop(S.flags.elite, fx * T + 1, fy * T + 8 - 24, fy * T + 8); }
      stand(S.bush[3], 49 * T, 12 * T + 4); stand(S.bush[1], 59.5 * T, 12 * T + 6); stand(S.bush[3], 54.5 * T, 6 * T + 4);
      spots.elite = { x0: 48 * T + 16, x1: 60 * T, y: 10 * T + 4, hurdles: [51 * T + 8, 57 * T + 8], graze: { x: 55.5 * T, y: 7 * T + 4 } };
    }

    /* NextJump: a competition floor. The kangaroo jumps on the mat, a camera counts, a judge counts, the board shows both. */
    {
      spots.kangaroo = { x: 59 * T, y: 22 * T + 10 };
      spots.mat = { x: 59 * T - 26, y: 22 * T - 6, w: 52, h: 26 };
      spots.board = { x: 59 * T - 25, y: 18 * T + 12, w: 50, h: 21 };
      stand(S.tripod, 56 * T + 10, 22 * T + 10);
      spots.judge = { x: 61 * T + 2, y: 22 * T + 12 };
      stand(S.rockS, 61.3 * T, 24 * T + 8); stand(S.rockS, 56.4 * T, 24 * T + 6);
    }

    /* The creek: the footbridge, a hollow log, a camp on the far bank */
    {
      prop(S.bridgeRail, 56 * T + 8, 33 * T - 8, 33 * T + 1);
      prop(S.bridgeRail, 56 * T + 8, 35 * T - 7, 35 * T + 3);
      stand(S.log, 54 * T - 2, 31 * T + 8); block(53, 31, 54, 31);
      for (const [x, y] of [[56.4, 30.6], [59.6, 31.5], [56.3, 36.5], [59.8, 37.6], [59.6, 28.6], [60.4, 39.6], [57.4, 39.3]]) stand(S.cattail, x * T, y * T + 6);
      stand(S.pine[0], 61.5 * T, 31 * T + 4); block(61, 30, 61, 30);
      stand(S.pine[0], 62.6 * T, 37 * T); stand(S.pine[0], 55 * T, 38.5 * T); block(54, 38, 55, 38); block(62, 36, 62, 36);
      stand(S.pine[0], 62.4 * T, 28.4 * T); stand(S.pine[0], 54.4 * T, 28 * T);
      stand(S.rock, 58.5 * T + 8, 27 * T + 4); stand(S.rockS, 57.6 * T, 27 * T + 8); block(58, 26, 59, 26);
      stand(S.bench, 61 * T + 8, 36 * T + 4); block(61, 35, 62, 35);
      stand(S.rockS, 61.2 * T, 39.8 * T);
      spots.creek = { fire: { x: 61 * T + 4, y: 32 * T + 6 }, pads: [[58.6, 28.7], [59.3, 30.4], [57.6, 36.1], [58.4, 31.9]], duck: { x: 58 * T, y0: 36.6 * T, y1: 40.4 * T } };
      block(60, 31, 61, 31);
    }

    /* Graveshift: Hollow Creek. A graveyard after dark: Marlow on the night shift with his lantern, the dead coming for the light. */
    {
      const gs = S.gs;
      for (const [img, x, y] of [[gs.tomb, 47, 43.5], [gs.tomb, 54.6, 43.1], [gs.cross, 49.3, 46.2], [gs.cross, 52.8, 46.6], [gs.cross, 56.5, 42.9],
        [gs.tomb, 61.3, 46.3], [gs.deadtree, 45.8, 44.1], [gs.deadtree, 61, 43.2], [gs.pumpkin, 54.2, 46.6], [gs.deadLamp, 46.2, 46.6], [gs.cross, 50.5, 43.3]]) stand(img, x * T, y * T);
      for (const [x, y] of [[48.1, 46.4], [56.2, 45.6], [51.3, 44.7]]) prop(gs.grave, x * T - 6, y * T - 5, y * T - 8);
      spots.grave = {
        x0: 44 * T, y0: 41 * T, x1: 63 * T, y1: 48 * T,
        walk: { x0: 45.6 * T, x1: 57.4 * T, y0: 42.7 * T, y1: 46.7 * T },
        patrol: { x: 51.4 * T, y: 44.9 * T, rx: 64, ry: 14 },
        candles: [[48.6, 44.4], [55.6, 44.5], [61.6, 44.9], [53.2, 42.8]].map(([x, y]) => ({ x: x * T, y: y * T })),
        pumpkin: { x: 54.2 * T, y: 46.6 * T },
      };
    }

    /* Buckeye Grove: the hall and its buckeye trees */
    {
      stand(S.hall, 4.5 * T, 33 * T + 6); block(1, 29, 7, 32);
      stand(S.buckeye[0], 2 * T + 6, 37 * T + 6); stand(S.buckeye[1], 6.5 * T + 4, 37 * T + 8);
      for (const [fx, fy] of [[1.7, 34.6], [7.3, 34.6]]) { stand(S.flagpole, fx * T, fy * T + 8); prop(S.flags.scarlet, fx * T + 1, fy * T + 8 - 24, fy * T + 8); }
    }

    /* Small OSU: the miniature campus on its table */
    {
      const dx = 19 * T - S.diorama.width / 2, dy = 30 * T + 2;
      prop(S.diorama, dx, dy, 35 * T - 2);
      spots.mini = { x: dx + 1, y: dy + 1 };
    }

    /* Heart House */
    {
      stand(S.plinth, 28 * T, 35 * T + 2, -10); block(27, 33, 28, 34);
      spots.heart = { x: 28 * T, y: 34 * T + 6 };
      stand(S.monitor, 29 * T + 6, 33 * T + 6, -2);
      spots.ecg = { x: 29 * T + 6 - 14, y: 33 * T + 6 - 21 };
    }

    /* Make OH/IO: the test track */
    {
      spots.track = { x: 19 * T, y: 21.5 * T + 2, ax: 50, ay: 25 };
      stand(S.camera, 15 * T + 8, 20 * T); stand(S.cone, 22 * T + 6, 19 * T + 8); stand(S.cone, 15 * T + 12, 23 * T + 10); stand(S.cone, 22 * T + 4, 23 * T + 12);
      spots.cam = { x: 15 * T + 3, y: 20 * T - 23 };
    }

    /* Hack OH/IO: the echo aviary */
    {
      const bx = 45 * T, by = 23 * T + 8;
      stand(S.perch, bx, by);
      const px0 = bx - S.perch.width / 2, py0 = by - S.perch.height;
      spots.perches = [[5, 12], [51, 7], [21, 2], [35, 3], [42, 32], [14, 23], [38, 19]].map(([x, y]) => ({ x: px0 + x, y: py0 + y }));
      stand(S.speaker, 42 * T, 23 * T + 6);
      spots.speaker = { x: 42 * T, y: 23 * T + 6 - 12 };
      stand(S.bush[0], 48 * T, 23 * T + 10); stand(S.bush[2], 41.6 * T, 20 * T);
    }

    /* Lamp Garden (A Simple Matter of Light) and Plethos */
    {
      spots.lamps = { x: 38 * T + 4, y: 30 * T + 10, cell: 14 };
      spots.slide = { x: 47 * T - 24, y: 30 * T + 1 };
      stand(S.plethosMark, 47 * T, 35 * T - 1);
      stand(S.bush[3], 45 * T + 2, 34 * T + 12); stand(S.bush[1], 48 * T + 12, 34 * T + 12);
    }

    /* Plaza: fountain, chess lawn, benches */
    {
      spots.fountain = { x: 32 * T, y: 27 * T + 12 };
      block(30, 26, 33, 27);
      const pieces = [['b', 1, 0, 0], ['b', 2, 1, 0], ['b', 3, 4, 0], ['b', 0, 2, 1], ['b', 0, 5, 1], ['b', 0, 6, 2], ['w', 0, 1, 5], ['w', 0, 3, 4],
        ['w', 0, 6, 6], ['w', 2, 5, 5], ['w', 3, 4, 7], ['w', 1, 7, 7], ['b', 2, 6, 3], ['w', 1, 0, 7]];
      for (const [side, kind, cxn, cyn] of pieces) stand(S.chess[side][kind], 34 * T + cxn * 8 + 4, 18 * T + cyn * 8 + 7);
      for (const [bx, by] of [[28.5, 23.8], [35.5, 23.8], [28.5, 30.4], [35.5, 30.4]]) footprint(stand(S.bench, bx * T, by * T));
      for (const [lx, ly] of [[26.5, 22.6], [26.5, 31.6], [37.5, 31.6]]) footprint(stand(S.lamp, lx * T, ly * T), 1);
      block(34, 18, 37, 21);
      stand(S.signpost, 30 * T + 4, 25 * T + 4); block(29, 24, 29, 24);
      stand(S.picnic, 27 * T, 20 * T); stand(S.picnic, 27 * T, 22 * T - 2); block(26, 19, 27, 19); block(26, 21, 27, 21);
      reserve(25, 17, 30, 22);
      stand(S.blossom[0], 29.5 * T, 19 * T + 8); block(29, 18, 29, 19);
      stand(S.blossom[1], 25 * T, 21 * T + 12); block(24, 21, 25, 21);
    }

    /* Front gate: the arch, the welcome kiosk, the gift shop, the mailbox */
    {
      stand(S.gate, 32 * T, 47 * T + 15, 0); block(29, 47, 29, 47); block(34, 47, 34, 47);
      stand(S.kiosk, 26.5 * T, 43 * T + 14); block(25, 41, 27, 43);
      stand(S.shop, 38 * T, 43 * T + 14); block(35, 41, 40, 43);
      standTile(S.mailbox, 34, 43, { dy: -1 });
      footprint(stand(S.bush[1], 29.5 * T, 47 * T + 2)); footprint(stand(S.bush[2], 34.6 * T, 47 * T + 2));
      spots.erik = { x: 28.5 * T + 2, y: 44 * T + 4 };
      spots.spawn = { x: 32 * T, y: 43 * T + 10 };
      for (const lx of [30, 33]) standTile(S.lamp, lx, 42);
    }

    /* benches and lamps along the loop */
    for (const [bx, by] of [[20, 14], [44, 14], [15, 39], [22, 39], [43, 39], [49, 14], [14, 14]]) {
      footprint(stand(S.bench, bx * T + 8, by * T + 12)); solid[at(bx, by)] = 1; keep[at(bx, by)] = 1; keep[at(bx + 1, by)] = 1; keep[at(bx - 1, by)] = 1;
    }
    for (const [lx, ly] of [[13, 14], [50, 14], [10, 39], [53, 39], [17, 14], [46, 14], [30, 39], [33, 39], [10, 25], [53, 28]]) {
      if (!solid[at(lx, ly)] && type[at(lx, ly)] === G.GRASS) standTile(S.lamp, lx, ly);
    }

    /* ----- trees: a planted border, then scattered groves on whatever grass is left ----- */
    const r = A.rng(20260525);
    const nearPath = (x, y) => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!inb(x + dx, y + dy)) continue;
        const t = type[at(x + dx, y + dy)];
        if (t !== G.GRASS) return true;
      }
      return false;
    };
    const free = (x, y) => inb(x, y) && type[at(x, y)] === G.GRASS && !solid[at(x, y)] && !keep[at(x, y)] && !nearPath(x, y);
    const plant = (x, y) => {
      let img;
      const k = r();
      if (x < 12 && y > 26) img = k < 0.6 ? S.buckeye[k < 0.3 ? 0 : 1] : S.trees[Math.floor(k * 40) % 4];
      else if (x > 52 && y > 14) img = k < 0.55 ? S.pine[0] : S.trees[Math.floor(k * 40) % 4];
      else if (y > 27 && x > 32 && x < 52) img = k < 0.35 ? S.blossom[k < 0.18 ? 0 : 1] : S.trees[Math.floor(k * 40) % 4];
      else img = k < 0.08 ? S.autumn[0] : k < 0.2 ? S.pine[0] : S.trees[Math.floor(k * 40) % 4];
      stand(img, x * T + 8 + Math.round(r() * 4 - 2), y * T + 14);
      solid[at(x, y)] = 1; keep[at(x, y)] = 1;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (inb(x + dx, y + dy)) keep[at(x + dx, y + dy)] = 1;
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      if (free(x, y) && r() < (edge ? 0.75 : 0.2)) plant(x, y);
    }
    for (let i = 0; i < 46; i++) {
      const x = Math.floor(r() * W), y = Math.floor(r() * H);
      if (free(x, y)) { stand(S.bush[Math.floor(r() * 4)], x * T + 8, y * T + 13); keep[at(x, y)] = 1; solid[at(x, y)] = 1; }
    }

    /* water is not for walking, the bridge is */
    for (let i = 0; i < W * H; i++) if (type[i] === G.WATER) solid[i] = 1;

    const ground = paintGround(type, r, spots);
    return { T, W, H, G, type, solid, props, ground, spots, sites: SITES, zones: ZONES, at, inb };
  }

  /* =====================================================================
     Ground: painted once
     ===================================================================== */
  const BASE = {
    [G.GRASS]: ['#86c463', '#76b858', '#9bd375'],
    [G.LAWN]: ['#8fcd6b', '#82c260', '#a2d97c'],
    [G.MEADOW]: ['#97d273', '#84c463', '#aede87'],
    [G.PATH]: ['#e7d09d', '#d8bd85', '#f2e1b8', '#bf9f69'],
    [G.PLAZA]: ['#dad5c6', '#c5bfae', '#e8e4d8', '#a9a393'],
    [G.WATER]: ['#58b3e0', '#479fd0', '#8ad2f2', '#3384b8'],
    [G.SAND]: ['#f1ddaf', '#e2c88e', '#f8ebc8', '#c9ab70'],
    [G.WOOD]: ['#e7bf82', '#dfb373', '#edc98f', '#b98a4d'],
    [G.EARTH]: ['#dc9463', '#c97d4e', '#e9ad7f', '#a8623a'],
    [G.SLATE]: ['#3d3b47', '#33313c', '#4a4855', '#241c2b'],
    [G.STONE]: ['#d2cdbf', '#bcb6a5', '#e2ded2', '#9c9686'],
    [G.BRIDGE]: ['#a8743f', '#8f6033', '#be8a52', '#4b2e1e'],
    [G.NIGHT]: ['#2c4436', '#243a2e', '#37533f', '#5a3a22'],
  };
  const SOFT = new Set([G.GRASS, G.LAWN, G.MEADOW]);

  function paintGround(type, r0, spots) {
    const c = A.mk(W * T, H * T), g = A.cx(c);
    const rect = A.rect, px = A.px;
    const tAt = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? G.GRASS : type[y * W + x]);
    const r = A.rng(4242);
    for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
      const t = tAt(tx, ty), b = BASE[t], x = tx * T, y = ty * T;
      rect(g, x, y, T, T, b[0]);
      if (t === G.GRASS || t === G.MEADOW) {
        for (let i = 0; i < 5; i++) px(g, x + Math.floor(r() * T), y + Math.floor(r() * T), b[1]);
        for (let i = 0; i < 2; i++) px(g, x + Math.floor(r() * T), y + Math.floor(r() * T), b[2]);
        if (r() < 0.3) { const ox = x + 2 + Math.floor(r() * 11), oy = y + 3 + Math.floor(r() * 10); px(g, ox, oy, b[1]); px(g, ox + 1, oy - 1, b[1]); px(g, ox + 2, oy, b[1]); }
        const fl = t === G.MEADOW ? 0.5 : 0.07;
        if (r() < fl) {
          const ox = x + 2 + Math.floor(r() * 12), oy = y + 2 + Math.floor(r() * 12);
          const cc = ['#ffffff', PAL.y, PAL.p, '#ffffff', PAL.Q][Math.floor(r() * 5)];
          px(g, ox, oy, cc); px(g, ox + 1, oy, cc); px(g, ox, oy + 1, cc); px(g, ox + 1, oy + 1, cc); px(g, ox, oy, PAL.Y);
        }
      } else if (t === G.LAWN) {
        if ((tx + ty) % 2) rect(g, x, y, T, T, b[1]);
        for (let i = 0; i < 3; i++) px(g, x + Math.floor(r() * T), y + Math.floor(r() * T), b[2]);
      } else if (t === G.PATH || t === G.SAND || t === G.EARTH) {
        for (let i = 0; i < 6; i++) px(g, x + Math.floor(r() * T), y + Math.floor(r() * T), b[1]);
        for (let i = 0; i < 4; i++) px(g, x + Math.floor(r() * T), y + Math.floor(r() * T), b[2]);
        if (t === G.SAND && r() < 0.55) { const ox = x + Math.floor(r() * 8), oy = y + 2 + Math.floor(r() * 12); rect(g, ox, oy, 5 + Math.floor(r() * 4), 1, b[1]); rect(g, ox + 2, oy + 1, 3, 1, b[2]); }
        if (t === G.EARTH && r() < 0.3) { const ox = x + 2 + Math.floor(r() * 10), oy = y + 4 + Math.floor(r() * 9); px(g, ox, oy, '#b7a04a'); px(g, ox + 1, oy - 1, '#b7a04a'); px(g, ox + 2, oy, '#b7a04a'); px(g, ox + 1, oy - 2, '#cdb85c'); }
      } else if (t === G.PLAZA || t === G.STONE) {
        rect(g, x, y + 7, T, 1, b[1]); rect(g, x, y + 15, T, 1, b[1]);
        rect(g, x + (ty % 2 ? 3 : 11), y, 1, 7, b[1]); rect(g, x + (ty % 2 ? 11 : 3), y + 8, 1, 7, b[1]);
        for (let i = 0; i < 3; i++) px(g, x + Math.floor(r() * T), y + Math.floor(r() * T), b[2]);
      } else if (t === G.WOOD) {
        for (let i = 0; i < 4; i++) {
          rect(g, x, y + i * 4, T, 4, (i + ty * 4) % 3 === 0 ? b[1] : (i + tx) % 4 === 1 ? b[2] : b[0]);
          rect(g, x, y + i * 4 + 3, T, 1, '#d3a565');
          const jx = ((i * 7 + tx * 5 + ty * 3) % 16); px(g, x + jx, y + i * 4, b[3]); px(g, x + jx, y + i * 4 + 1, b[3]); px(g, x + jx, y + i * 4 + 2, b[3]);
        }
      } else if (t === G.WATER) {
        for (let i = 0; i < 3; i++) { const ox = x + Math.floor(r() * 12), oy = y + Math.floor(r() * T); rect(g, ox, oy, 3, 1, b[1]); }
      } else if (t === G.NIGHT) {
        for (let i = 0; i < 6; i++) px(g, x + Math.floor(r() * T), y + Math.floor(r() * T), b[1]);
        for (let i = 0; i < 3; i++) px(g, x + Math.floor(r() * T), y + Math.floor(r() * T), b[2]);
        if (r() < 0.35) { const ox = x + Math.floor(r() * 9), oy = y + 3 + Math.floor(r() * 10); rect(g, ox, oy, 4 + Math.floor(r() * 4), 2, '#3a3226'); }
        if (r() < 0.25) { const ox = x + 2 + Math.floor(r() * 11), oy = y + 3 + Math.floor(r() * 10); px(g, ox, oy, b[2]); px(g, ox + 1, oy - 1, b[2]); px(g, ox + 2, oy, b[2]); }
      } else if (t === G.SLATE) {
        for (let i = 0; i < 4; i++) px(g, x + Math.floor(r() * T), y + Math.floor(r() * T), b[2]);
      } else if (t === G.BRIDGE) {
        for (let i = 0; i < T; i += 4) { rect(g, x + i, y, 1, T, b[1]); rect(g, x + i + 1, y, 1, T, b[2]); }
        px(g, x + 2, y + 2, b[3]); px(g, x + 10, y + 13, b[3]);
      }
    }
    /* edges: hard surfaces get a rim against grass, water gets a bank */
    for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
      const t = tAt(tx, ty), b = BASE[t], x = tx * T, y = ty * T;
      const up = tAt(tx, ty - 1), dn = tAt(tx, ty + 1), lf = tAt(tx - 1, ty), rt = tAt(tx + 1, ty);
      if (t === G.WATER) {
        const land = (n) => n !== G.WATER && n !== G.BRIDGE;
        const night = [up, dn, lf, rt].indexOf(G.NIGHT) >= 0;
        const bank = night ? '#1f3027' : '#5d8f47';
        if (land(up)) { rect(g, x, y, T, 2, bank); rect(g, x, y + 2, T, 2, '#7a5a3a'); rect(g, x, y + 4, T, 1, b[3]); rect(g, x, y + 5, T, 1, '#dff4fb'); }
        if (land(dn)) { rect(g, x, y + T - 1, T, 1, b[3]); rect(g, x, y + T - 2, T, 1, b[2]); }
        if (land(lf)) { rect(g, x, y, 1, T, b[3]); rect(g, x + 1, y + (land(up) ? 5 : 0), 1, T - (land(up) ? 5 : 0), b[2]); }
        if (land(rt)) { rect(g, x + T - 1, y, 1, T, b[3]); rect(g, x + T - 2, y + (land(up) ? 5 : 0), 1, T - (land(up) ? 5 : 0), b[2]); }
        const gc = night ? BASE[G.NIGHT][0] : BASE[G.GRASS][0];
        const round = (cxp, cyp, sx, sy, n) => {
          for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) px(g, cxp + sx * i, cyp + sy * j, i + j === n - 1 ? bank : gc);
        };
        if (land(up) && land(lf)) round(x, y, 1, 1, 5);
        if (land(up) && land(rt)) round(x + T - 1, y, -1, 1, 5);
        if (land(dn) && land(lf)) round(x, y + T - 1, 1, -1, 4);
        if (land(dn) && land(rt)) round(x + T - 1, y + T - 1, -1, -1, 4);
        continue;
      }
      if (SOFT.has(t) || t === G.NIGHT) continue;
      const rim = (n) => n !== t && !(t === G.BRIDGE && n === G.PATH) && !(t === G.PATH && n === G.BRIDGE) && !(t === G.PATH && n === G.PLAZA) && !(t === G.PLAZA && n === G.PATH);
      const u = rim(up), d = rim(dn), l = rim(lf), rr = rim(rt);
      if (u) rect(g, x, y, T, 1, b[3]);
      if (d) rect(g, x, y + T - 1, T, 1, b[3]);
      if (l) rect(g, x, y, 1, T, b[3]);
      if (rr) rect(g, x + T - 1, y, 1, T, b[3]);
      /* round the outside corners of paths */
      if (t === G.PATH || t === G.PLAZA) {
        const gc = BASE[G.GRASS][0];
        const corner = (cxp, cyp, sx, sy) => { px(g, cxp, cyp, gc); px(g, cxp + sx, cyp, gc); px(g, cxp, cyp + sy, gc); px(g, cxp + sx, cyp + sy, b[3]); px(g, cxp + sx * 2, cyp, b[3]); px(g, cxp, cyp + sy * 2, b[3]); };
        if (u && l && SOFT.has(up) && SOFT.has(lf)) corner(x, y, 1, 1);
        if (u && rr && SOFT.has(up) && SOFT.has(rt)) corner(x + T - 1, y, -1, 1);
        if (d && l && SOFT.has(dn) && SOFT.has(lf)) corner(x, y + T - 1, 1, -1);
        if (d && rr && SOFT.has(dn) && SOFT.has(rt)) corner(x + T - 1, y + T - 1, -1, -1);
      }
    }

    /* ----- decals ----- */
    const line = A.line, ellipse = A.ellipse;
    const cream = '#fbf6e6';
    // the two courts
    for (const [x0, x1] of [[20, 30], [33, 43]]) {
      const ax = x0 * T + 6, bx = (x1 + 1) * T - 7, ay = 5 * T + 2, by = 12 * T + 12;
      rect(g, ax, ay, bx - ax, 1, cream); rect(g, ax, by, bx - ax + 1, 1, cream); rect(g, ax, ay, 1, by - ay, cream); rect(g, bx, ay, 1, by - ay, cream);
    }
    // centre circle with a red sun, as on the championship floor
    {
      const cxp = 38.5 * T, cyp = 9 * T;
      for (let a = 0; a < 360; a += 1) px(g, Math.round(cxp + Math.cos(a * Math.PI / 180) * 44), Math.round(cyp + Math.sin(a * Math.PI / 180) * 22), '#b98a4d');
      ellipse(g, cxp, cyp, 13, 7, PAL.R); ellipse(g, cxp, cyp - 1, 12, 6, '#f04a3a');
    }
    // test track: a figure of eight
    {
      const k = spots.track;
      const pt = (u) => [k.x + k.ax * Math.sin(u), k.y + k.ay * Math.sin(2 * u)];
      for (let u = 0; u < Math.PI * 2; u += 0.004) { const [x, y] = pt(u); ellipse(g, Math.round(x), Math.round(y), 7, 6, '#4a4354'); }
      for (let u = 0; u < Math.PI * 2; u += 0.004) { const [x, y] = pt(u); ellipse(g, Math.round(x), Math.round(y), 6, 5, '#5d5868'); }
      for (let u = 0, i = 0; u < Math.PI * 2; u += 0.03, i++) { if (i % 4 > 1) continue; const [x, y] = pt(u); px(g, Math.round(x), Math.round(y), cream); }
    }
    // chess board
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) rect(g, 34 * T + i * 8, 18 * T + j * 8, 8, 8, (i + j) % 2 ? '#6b6570' : '#f1ecdf');
    rect(g, 34 * T - 1, 18 * T - 1, 66, 1, PAL.k); rect(g, 34 * T - 1, 22 * T, 66, 1, PAL.k); rect(g, 34 * T - 1, 18 * T - 1, 1, 66, PAL.k); rect(g, 38 * T, 18 * T - 1, 1, 66, PAL.k);
    // dunes in the fennec enclosure
    for (const [x, y, w] of [[5, 8, 40], [9, 10.5, 54], [3.5, 11.6, 30], [10, 5.6, 36]]) {
      for (let i = 0; i < w; i++) { const yy = Math.round(y * T - Math.sin((i / w) * Math.PI) * 4); px(g, x * T + i, yy, '#d9bc80'); px(g, x * T + i, yy + 1, '#f8ebc8'); }
    }
    // the competition mat in the NextJump yard
    {
      const m = spots.mat;
      rect(g, m.x, m.y, m.w, m.h, '#2d5fa3'); rect(g, m.x, m.y + m.h - 1, m.w, 1, '#1e2c5c');
      rect(g, m.x + 2, m.y + 2, m.w - 4, 1, cream); rect(g, m.x + 2, m.y + m.h - 4, m.w - 4, 1, cream);
      rect(g, m.x + 2, m.y + 2, 1, m.h - 5, cream); rect(g, m.x + m.w - 3, m.y + 2, 1, m.h - 5, cream);
      rect(g, m.x + 5, m.y + 5, 9, 3, '#e93323'); rect(g, m.x + 6, m.y + 6, 7, 1, cream);
    }
    // lily pads
    for (const [x, y] of spots.creek.pads) g.drawImage(A.S.lilypad, Math.round(x * T - 4), Math.round(y * T - 3));
    // flower beds around the plaza
    for (const [x0, y0, w, h] of [[27, 22, 4, 1], [33, 22, 3, 1], [27, 31, 4, 1], [33, 31, 4, 1]]) {
      rect(g, x0 * T, y0 * T + 4, w * T, h * T - 6, '#6f4a2b'); rect(g, x0 * T, y0 * T + 4, w * T, 1, PAL.b);
      for (let i = 0; i < w * 5; i++) { const fx = x0 * T + 2 + i * 3 + Math.floor(r() * 2), fy = y0 * T + 6 + Math.floor(r() * 6); const cc = [PAL.R, PAL.y, PAL.p, PAL.W, PAL.Q][i % 5]; rect(g, fx, fy, 2, 2, cc); px(g, fx, fy + 2, PAL.M); }
    }
    return c;
  }

  Park.world = { T, W, H, G, SITES, ZONES, build };
})();
