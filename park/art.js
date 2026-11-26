/* Kyselica Park: pixel art.
   Every sprite in the park is drawn here in code. There are no image files for the world itself,
   so the whole park is a few kilobytes and stays crisp at any zoom. */
(function () {
  'use strict';
  const Park = (window.Park = window.Park || {});

  /* ---------- palette ---------- */
  const PAL = {
    k: '#241c2b', K: '#4a4354', g: '#7d7887', G: '#b5b1bb', w: '#f5f1e4', W: '#ffffff',
    r: '#ba1f33', R: '#e93323', d: '#7a1626',
    o: '#dd7a34', O: '#f0a556', F: '#f6cf94',
    y: '#f2c94c', Y: '#fbe9a2', z: '#c2922a',
    b: '#4b2e1e', n: '#7a4d2c', N: '#a8743f', t: '#d6b77c', T: '#ecd8a8',
    f: '#2c5d3a', M: '#3f8644', m: '#5fa84c', l: '#8ccb62', L: '#b5e08a',
    u: '#2d5fa3', a: '#4f9fdc', A: '#9bd7f3',
    v: '#1e2c5c', V: '#35488c',
    p: '#e58aa0', P: '#b8456a', x: '#8c2f4d',
    q: '#7b4fa3', Q: '#a986d1',
    s: '#f2c59c', S: '#d99f73', e: '#b0723f', E: '#7d4c28',
    c: '#3fb0a3', C: '#8fe0cf',
  };

  /* ---------- canvas helpers (all hard-edged: no anti-aliasing anywhere) ---------- */
  function mk(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w | 0);
    c.height = Math.max(1, h | 0);
    return c;
  }
  function cx(c) {
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    return g;
  }
  function col(ch) { return PAL[ch] || ch; }
  function rect(g, x, y, w, h, c) { g.fillStyle = col(c); g.fillRect(x | 0, y | 0, w | 0, h | 0); }
  function px(g, x, y, c) { g.fillStyle = col(c); g.fillRect(x | 0, y | 0, 1, 1); }
  function disc(g, x0, y0, r, c) {
    g.fillStyle = col(c);
    for (let dy = -r; dy <= r; dy++) {
      const dx = Math.floor(Math.sqrt(r * r - dy * dy) + 0.35);
      g.fillRect(x0 - dx, y0 + dy, dx * 2 + 1, 1);
    }
  }
  function ellipse(g, x0, y0, rx, ry, c) {
    g.fillStyle = col(c);
    for (let dy = -ry; dy <= ry; dy++) {
      const dx = Math.floor(rx * Math.sqrt(Math.max(0, 1 - (dy * dy) / (ry * ry + 0.01))) + 0.35);
      g.fillRect(x0 - dx, y0 + dy, dx * 2 + 1, 1);
    }
  }
  function line(g, x0, y0, x1, y1, c) {
    g.fillStyle = col(c);
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      g.fillRect(x0, y0, 1, 1);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ASCII rows -> canvas. '.' and ' ' are transparent; other characters look up `map`, then the palette. */
  function rows(art, map) {
    const h = art.length;
    let w = 0;
    for (const r of art) w = Math.max(w, r.length);
    const c = mk(w, h), g = cx(c);
    for (let y = 0; y < h; y++) {
      const r = art[y];
      for (let x = 0; x < r.length; x++) {
        const ch = r[x];
        if (ch === '.' || ch === ' ') continue;
        const v = (map && map[ch]) || PAL[ch];
        if (!v) continue;
        g.fillStyle = v;
        g.fillRect(x, y, 1, 1);
      }
    }
    return c;
  }
  /* One-pixel outline around the opaque shape; the result is 2px wider and taller. */
  function outline(src, color) {
    const w = src.width, h = src.height;
    const out = mk(w + 2, h + 2), g = cx(out);
    const d = cx(src).getImageData(0, 0, w, h).data;
    const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 40;
    g.fillStyle = col(color || 'k');
    for (let y = -1; y <= h; y++) {
      for (let x = -1; x <= w; x++) {
        if (solid(x, y)) continue;
        if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) g.fillRect(x + 1, y + 1, 1, 1);
      }
    }
    g.drawImage(src, 1, 1);
    return out;
  }
  function flipH(src) {
    const c = mk(src.width, src.height), g = cx(c);
    g.translate(src.width, 0); g.scale(-1, 1); g.drawImage(src, 0, 0);
    return c;
  }
  function flipV(src) {
    const c = mk(src.width, src.height), g = cx(c);
    g.translate(0, src.height); g.scale(1, -1); g.drawImage(src, 0, 0);
    return c;
  }
  function spr(art, map, edge) { return outline(rows(art, map), edge); }

  /* ---------- 5px bitmap font for the signs ---------- */
  const GLYPH = {
    A: '010/101/111/101/101', B: '110/101/110/101/110', C: '011/100/100/100/011', D: '110/101/101/101/110',
    E: '111/100/110/100/111', F: '111/100/110/100/100', G: '011/100/101/101/011', H: '101/101/111/101/101',
    I: '1/1/1/1/1', J: '001/001/001/101/010', K: '101/101/110/101/101', L: '100/100/100/100/111',
    M: '10001/11011/10101/10001/10001', N: '1001/1101/1011/1001/1001', O: '010/101/101/101/010',
    P: '110/101/110/100/100', Q: '010/101/101/110/011', R: '110/101/110/101/101', S: '011/100/010/001/110',
    T: '111/010/010/010/010', U: '101/101/101/101/111', V: '101/101/101/101/010',
    W: '10001/10001/10101/11011/10001', X: '101/101/010/101/101', Y: '101/101/010/010/010', Z: '111/001/010/100/111',
    0: '111/101/101/101/111', 1: '01/11/01/01/01', 2: '110/001/010/100/111', 3: '110/001/010/001/110',
    4: '101/101/111/001/001', 5: '111/100/110/001/110', 6: '011/100/110/101/010', 7: '111/001/010/010/010',
    8: '010/101/010/101/010', 9: '010/101/011/001/110',
    ' ': '00/00/00/00/00', '.': '0/0/0/0/1', '!': '1/1/1/0/1', '?': '110/001/010/000/010', '-': '00/00/11/00/00',
    '/': '001/001/010/100/100', ':': '0/1/0/1/0', "'": '1/1/0/0/0', '+': '000/010/111/010/000', '&': '010/101/010/101/011',
    '*': '000/101/010/101/000',
  };
  function textWidth(s) {
    let w = 0;
    for (const ch of String(s).toUpperCase()) w += ((GLYPH[ch] || GLYPH['?']).split('/')[0].length) + 1;
    return Math.max(0, w - 1);
  }
  function text(g, s, x, y, c) {
    g.fillStyle = col(c);
    for (const ch of String(s).toUpperCase()) {
      const gl = (GLYPH[ch] || GLYPH['?']).split('/');
      for (let r = 0; r < 5; r++) for (let i = 0; i < gl[r].length; i++) if (gl[r][i] === '1') g.fillRect(x + i, y + r, 1, 1);
      x += gl[0].length + 1;
    }
    return x;
  }

  /* ---------- people ----------
     Digits are slots, filled per person: H hat/hair-top, 1 hair, 2 skin, 3 shirt, 4 yoke, 5 shorts, 6 legs, 7 shoes, 8 eyes. */
  const HEAD_F = ['...HHHH...', '..HHHHHH..', '.11111111.', '.11222211.', '.12822821.', '..222222..'];
  const HEAD_B = ['...HHHH...', '..HHHHHH..', '.11111111.', '.11111111.', '.11111111.', '..211112..'];
  const HEAD_S = ['...HHHH...', '..HHHHHH..', '..1111111.', '..1112222.', '..1122282.', '...22222..'];
  const BODY_F = ['.34444443.', '.23333332.', '.23333332.', '..555555..', '..555555..'];
  const LEGS = [
    ['..66..66..', '..66..66..', '..77..77..'],
    ['..66..66..', '..66..77..', '..77......'],
    ['..66..66..', '..77..66..', '......77..'],
  ];
  const BODY_S = ['...3443...', '...3233...', '...3233...', '...5555...', '...5555...'];
  const LEGS_S = [
    ['....66....', '....66....', '....777...'],
    ['...66.66..', '..66...6..', '..77...77.'],
  ];
  const PERSON = {
    front: LEGS.map((l) => HEAD_F.concat(BODY_F, l)),
    back: LEGS.map((l) => HEAD_B.concat(BODY_F, l)),
    side: LEGS_S.map((l) => HEAD_S.concat(BODY_S, l)),
    // both arms up, knees tucked: the top of a jump
    jump: ['...HHHH...', '..HHHHHH..', '.11111111.', '2112222112', '2128228212', '3.222222.3', '3344444433',
      '..333333..', '..333333..', '..555555..', '..555555..', '..66..66..', '..77..77..'],
    // arms out to the sides, hands on rope handles
    rope: HEAD_F.concat(['.34444443.', '2233333322', '..333333..', '..555555..', '..555555..'], LEGS[0]),
    // side view, arms forward: turning the long ropes (hands high, hands low)
    turnA: HEAD_S.concat(['...344322.', '...3333...', '...3333...', '...5555...', '...5555...'], LEGS_S[0]),
    turnB: HEAD_S.concat(['...3443...', '...3333...', '...333322.', '...5555...', '...5555...'], LEGS_S[0]),
  };
  function person(c) {
    const map = {
      H: c.hat || c.hair, 1: c.hair, 2: c.skin, 3: c.shirt, 4: c.yoke || c.shirt, 5: c.pants,
      6: c.legs || c.skin, 7: c.shoes || PAL.w, 8: PAL.k,
    };
    const f = (a) => spr(a, map);
    const side = PERSON.side.map(f);
    const jump = f(PERSON.jump);
    const turnA = f(PERSON.turnA), turnB = f(PERSON.turnB);
    return {
      down: PERSON.front.map(f),
      up: PERSON.back.map(f),
      right: [side[0], side[1], side[0], side[1]],
      left: [flipH(side[0]), flipH(side[1]), flipH(side[0]), flipH(side[1])],
      jump, handstand: flipV(jump), rope: f(PERSON.rope),
      turnR: [turnA, turnB], turnL: [flipH(turnA), flipH(turnB)],
    };
  }
  const USA = { shirt: PAL.v, yoke: PAL.W, pants: '#16141c', shoes: PAL.W };
  const HAIRS = ['#3a2416', '#5a3a22', '#1f1a24', '#8a5a2c', '#c9a15a', '#6b3a1e', '#2a1c14'];
  const SKINS = [PAL.s, PAL.s, '#e8b98c', PAL.S, PAL.e, PAL.E, '#f6d3b0'];
  const SHIRTS = [PAL.r, PAL.a, PAL.y, PAL.c, PAL.q, PAL.o, PAL.w, PAL.m, PAL.p, PAL.G, PAL.R, PAL.u];
  const PANTS = [PAL.v, PAL.K, PAL.n, PAL.u, '#2b2a33', PAL.g];
  function randomPerson(r) {
    const pick = (a) => a[Math.floor(r() * a.length)];
    const c = { hair: pick(HAIRS), skin: pick(SKINS), shirt: pick(SHIRTS), pants: pick(PANTS), shoes: r() < 0.5 ? PAL.w : PAL.K };
    if (r() < 0.3) c.hat = pick([PAL.r, PAL.w, PAL.a, PAL.y, PAL.K]);
    if (r() < 0.5) c.legs = c.pants;
    return person(c);
  }

  /* ---------- animals ---------- */
  const FENNEC = [
    ['..........F...F...', '.........FF..FF...', '.........FpF.FpF..', '.........FpFFFpF..', '.........FFFFFFF..',
      '.........FFFFkFFw.', '.b.......FFFFFwwk.', 'bOF..OFFFFFFFwww..', '.OFFFFFFFFFFFww...', '..OFFFFFFFFFFw....',
      '....OFOFFFFFO.....', '....F.F...F.F.....', '....F.F...F.F.....'],
    ['..........F...F...', '.........FF..FF...', '.........FpF.FpF..', '.........FpFFFpF..', '.........FFFFFFF..',
      '.........FFFFkFFw.', '.........FFFFFwwk.', '.bOF.OFFFFFFFwww..', 'bOFFFFFFFFFFFww...', '..OFFFFFFFFFFw....',
      '....OFOFFFFFO.....', '...F...F.F...F....', '..F.....F.....F...'],
    // sitting, ears up
    ['.....F...F........', '....FF..FF........', '....FpF.FpF.......', '....FpFFFpF.......', '....FFFFFFF.......',
      '....FFkFFkFw......', '....FFFFFwwk......', '.....FFFFww.......', '....OFFFFFF.......', '...OFFFFwwFF......',
      '...OFFFFwwFF......', 'bOOOFFF.FF.FF.....', '.bOO.FF.FF.FF.....'],
  ];
  const KANGAROO = [
    ['...O.....O......', '..OO....OO......', '..OpO..OpO......', '..OpOOOOpO......', '..OOOOOOOO......', '..OkOOOOkO......',
      '..OOOYYOOO......', '...OOYkYO.......', '....OOOO........', 'a.OOOOOOOO.a....', 'aOOOYYYYOOOa....', 'a..OYYYYO..a....',
      '...OYYYYO.......', '..OOYYYYOO....o.', '..OOOYYOOO...oo.', '..OOOOOOOO..oo..', '..OOO..OOOooo...', '.OOOO..OOOO.....', '.ooo....ooo.....'],
    ['...O.....O......', '..OO....OO......', '..OpO..OpO......', '..OpOOOOpO......', '..OOOOOOOO......', '..OkOOOOkO......',
      '..OOOYYOOO......', '...OOYkYO.......', 'a...OOOO...a....', 'aOOOOOOOOOOa....', 'a..OYYYYO..a....', '...OYYYYO.......',
      '...OYYYYO.....o.', '..OOYYYYOO...oo.', '..OOOYYOOO..oo..', '..OOOOOOOOooo...', '..OOO..OOO......', '..ooo..ooo......'],
  ];
  const PEGASUS = [
    ['.....................ww.....', '..................wwwwww....', '....w...........wwwwwwwww...', '...www.........wwwGwwwwww...',
      '..wwwwY.......wwwGwwwGwww...', '.wwkwwYY......wwGwwwGwww....', 'wwwwwwwYY....wwwGwwGwww.....', 'wwwwwwwwYY...wwGwwGwww......',
      '.ww..wwwwYY.wwwwwwwww.......', '.....wwwwwwwwwwwwwwwwww.....', '......wwwwwwwRRRRwwwwwwwY...', '......wwwwwwwRRRRwwwwwwwYY..',
      '.......wwwwwwwyyywwwwwww.YY.', '.......wwwwwwwwwwwwwwww..YY.', '........www.ww....www.ww..Y.', '........ww..ww....ww..ww..Y.',
      '........ww..ww....ww..ww....', '........ww..ww....ww..ww....', '........GG..GG....GG..GG....'],
    ['............................', '............................', '....w.......................', '...www......................',
      '..wwwwY.....................', '.wwkwwYY....................', 'wwwwwwwYY.....wwwwwwwwwwww..', 'wwwwwwwwYY..wwwwGwwwGwwwwwww',
      '.ww..wwwwYY.wwwGwwwGwwwGwww.', '.....wwwwwwwwwwwwwwwwwwww...', '......wwwwwwwRRRRwwwwwwwY...', '......wwwwwwwRRRRwwwwwwwYY..',
      '.......wwwwwwwyyywwwwwww.YY.', '.......wwwwwwwwwwwwwwww..YY.', '........www.ww....www.ww..Y.', '........ww..ww....ww..ww..Y.',
      '........ww..ww....ww..ww....', '........ww..ww....ww..ww....', '........GG..GG....GG..GG....'],
  ];
  const PARROT = [
    ['..111...', '.11111..', '.1k111y.', '.11111yy', '.1111...', '11211...', '12211...', '1221....', '.11.....', '.1.1....', '.1......'],
    ['..111...', '.11111..', '.1k111y.', '.11111yy', '21111...', '22111...', '.2211...', '..11....', '.11.....', '.1.1....', '.1......'],
  ];
  function parrot(body, wing) {
    const m = { 1: body, 2: wing };
    const a = spr(PARROT[0], m), b = spr(PARROT[1], m);
    return { right: [a, b], left: [flipH(a), flipH(b)] };
  }
  const LADYBUG = ['.RRR.', 'RkRRk', 'RRkRk', '.RRR.'];
  const BEETLE = ['.ccc.', 'cCcck', 'ccCck', '.ccc.'];
  const BUTTERFLY = [['y.y', 'yky', 'y.y'], ['.y.', 'yky', '.y.']];
  const FROG = ['.m..m.', 'mkmmkm', 'mmmmmm', 'mLLLLm', 'm.mm.m'];
  const FISH = ['..oo.o', '.ookoo', '..oo.o'];
  const DUCK = ['..ww..', '.wkwy.', 'wwww..', 'wwwww.', '.www..'];

  /* ---------- small objects ---------- */
  const HEART = [
    '....aa...xx.....', '...aAa..xPx.....', '...aa..xPPx.....', '..PPPPxPPPxPP...', '.PppppPPpPPppP..', 'PppWppppPppppPP.',
    'PpWpppppppppppPx', 'PpppppppppppppPx', 'PppppppppppppPPx', '.PpppppppppppPx.', '.PPpppppppppPPx.', '..PPpppppppPPx..',
    '...PPpppppPPx...', '....PPpppPPx....', '.....PPpPPx.....', '......PPPx......', '.......Px.......',
  ];
  const TROPHY = [
    '..yyyyyyyyyy..', '.zyYyyyyyyyyz.', 'zzyYyyyyyyyyzz', 'z.yYyyyyyyyy.z', 'z.yYyyyyyyyy.z', 'zzyYyyyyyyyyzz', '.zyyYyyyyyyz..',
    '...yyYyyyyy...', '....yyyyyy....', '.....yyyy.....', '......zz......', '......yy......', '.....yyyy.....', '....zyyyyz....',
    '...GGGGGGGG...', '...GwwwwwwG...', '..GGGGGGGGGG..', '..gGGGGGGGGg..', '..gggggggggg..',
  ];
  const CACTUS = ['...mm....', '...mlm...', 'm..mlm...', 'ml.mlm.m.', 'ml.mlm.lm', 'mllmlm.lm', '.mmmlmllm', '...mlmmm.', '...mlm...', '...mlm...', '...mlm...'];
  const ROCK = ['..GGGG...', '.GGGGGGG.', 'GGGwGGGgg', 'GGGGGGggg', '.gggggggg', '..gggggg.'];
  const ROCK_S = ['.GGG.', 'GGwGg', 'GGGgg', '.ggg.'];
  const BENCH = ['NNNNNNNNNNNNNNNNNN', 'nnnnnnnnnnnnnnnnnn', 'NNNNNNNNNNNNNNNNNN', 'tttttttttttttttttt', 'NNNNNNNNNNNNNNNNNN',
    'nnnnnnnnnnnnnnnnnn', '.K..............K.', '.K..............K.'];
  const LAMP = ['.KKKK.', 'KYYYYK', 'KYWYYK', 'KYYYYK', '.KKKK.', '..KK..', '..KK..', '..KK..', '..KK..', '..KK..', '..KK..', '..KK..', '..KK..',
    '..KK..', '..KK..', '..KK..', '..KK..', '..KK..', '.KKKK.', 'KKKKKK'];
  const STANCHION = ['......yy........', '.....yYyy.......', '......yy........', 'rr....zy......rr', '.rrr..zy....rrr.', '...rrrrrrrrrr...',
    '......zy........', '......zy........', '......zy........', '......zy........', '.....zzyy.......', '....zzzyyy......'];
  const CATTAIL = ['.n...n.', '.n...n.', '.n.n.n.', '.m.n.m.', '.m.n.m.', '.m.m.m.', 'mm.m.mm', '.m.m.m.', '.mmmmm.'];
  const MAILBOX = ['.aaaaaa.', 'aAaaaaau', 'aaaaaRau', 'aaaaaRau', 'aaaaaaau', '.uuuuuu.', '...nn...', '...nn...', '...nn...', '...nn...', '...nn...'];
  const SPEAKER = ['..KKKKKK..', '.KKKKKKKK.', 'KCCCCCCCCK', 'KKKKKKKKKK', 'KgKgKgKgKK', 'KKgKgKgKgK', 'KgKgKgKgKK', 'KKgKgKgKgK', 'KgKgKgKgKK',
    'KKgKgKgKgK', 'KgKgKgKgKK', 'KKKKKKKKKK', '.KKKKKKKK.'];
  const CAMERA = ['KKKKKKKK..', 'KKgGGgKKKK', 'KKgAAgKKKK', 'KKgGGgKKK.', 'KKKKKKKK..', '...gg.....', '...gg.....', '...gg.....', '...gg.....',
    '...gg.....', '...gg.....', '...gg.....', '...gg.....', '...gg.....', '...gg.....', '...gg.....', '...gg.....', '...gg.....',
    '...gg.....', '...gg.....', '...gg.....', '...gg.....', '..gggg....', '.gggggg...'];
  const CAR = ['.kk..kk..', 'RRRRRRRR.', 'RRwkRAARR', 'RRkwRAARR', 'RRRRRRRR.', '.kk..kk..'];
  const BULB = ['.KKKK.', 'KKKKKK', 'KKKKKK', 'KKKKKK', '.KKKK.', '..gg..', '..gg..'];
  const BULB_ON = ['.yyyy.', 'yYWYyy', 'yYYYyy', 'yyyyyy', '.yyyy.', '..gg..', '..gg..'];
  const PAWN = ['.11.', '1111', '.11.', '.11.', '1111', '1111'];
  const KING = ['.1.1.', '11111', '.111.', '.111.', '.111.', '11111', '11111'];
  const ROOK = ['1.1.1', '11111', '.111.', '.111.', '.111.', '11111', '11111'];
  const KNIGHT = ['.11..', '1111.', '11111', '.1111', '.111.', '11111', '11111'];
  const FLAGPOLE = ['G', 'G', 'G', 'G', 'G', 'G', 'G', 'G', 'G', 'G', 'G', 'G', 'G', 'G', 'G', 'G', 'G', 'G', 'G', 'G', 'G', 'G', 'G', 'g'];
  const LOG = ['....nnnnnnnnnnnnnnnnnnnn....', '..nnNNnNNNNnNNNNNnNNNNnNnn..', '.bbnNNNNnNNNNNnNNNNNnNNNNNn.', 'bbkbnNNnNNNNnNNNNNnNNNNnNNNn',
    'bkkkbnnNNNnNNNNNnNNNNnNNNNnn', 'bkkkbnNNnNNNNnNNNNNnNNNNnNnn', 'bbkbnnnnNNNnnNNNnnNNNNnnNnnn', '.bbnnnnnnnnnnnnnnnnnnnnnnnn.',
    '..bbbbbbbbbbbbbbbbbbbbbbbb..'];
  const BURROW = ['......tttttttt......', '....ttTTTTTTTTtt....', '..ttTTTTTTTTTTTTtt..', '.tTTTTTbbbbbbTTTTTt.', 'tTTTTTbkkkkkkbTTTTTt',
    'tTTTTbkkkkkkkkbTTTTt', 'ttTTTbkkkkkkkkbTTTtt', '.tttttttttttttttttt.'];
  const SIGNPOST = ['......nn......', '.wwwwwnnwwww..', 'wwwwwwnnwwwww.', '.wwwwwnnwwww..', '......nn......', '..rrrrnnrrrrr.', '.rrrrrnnrrrrrr',
    '..rrrrnnrrrrr.', '......nn......', '.aaaaannaaaa..', 'aaaaaannaaaaa.', '.aaaaannaaaa..', '......nn......', '......nn......', '......nn......',
    '......nn......', '......nn......', '.....bnnb.....'];
  const PICNIC = ['..NNNNNNNNNNNNNNNN..', '..NtNNNNNNNNNNNNtN..', '..NNNNNNNNNNNNNNNN..', '..nnnnnnnnnnnnnnnn..', '....n..........n....',
    'NNNNnNNNNNNNNNNNnNNN', 'nnnnnnnnnnnnnnnnnnnn', '...n............n...'];

  /* ---------- trees and plants, generated ---------- */
  function tree(seed, opt) {
    opt = opt || {};
    const r = rng(seed);
    const c = mk(30, 36), g = cx(c);
    const dark = opt.dark || PAL.M, mid = opt.mid || PAL.m, lite = opt.lite || PAL.l;
    // trunk
    rect(g, 13, 24, 4, 10, PAL.n); rect(g, 13, 24, 1, 10, PAL.b); rect(g, 16, 27, 1, 3, PAL.N);
    rect(g, 12, 33, 6, 1, PAL.b);
    // canopy: a shadowed mass, a lit mass shifted up-left, then leaf clusters
    const blobs = [[15, 14, 10], [9, 16, 6], [21, 16, 6], [12, 9, 6], [19, 9, 6]];
    for (const [x, y, rr] of blobs) disc(g, x + Math.round(r() * 2 - 1), y, rr, dark);
    for (const [x, y, rr] of blobs) disc(g, x - 1, y - 2, rr - 2, mid);
    for (let i = 0; i < 7; i++) disc(g, 8 + Math.floor(r() * 12), 5 + Math.floor(r() * 11), 1 + Math.floor(r() * 2), lite);
    for (let i = 0; i < 10; i++) px(g, 6 + Math.floor(r() * 18), 8 + Math.floor(r() * 14), dark);
    if (opt.fruit) for (let i = 0; i < 6; i++) {
      const x = 6 + Math.floor(r() * 17), y = 8 + Math.floor(r() * 13);
      rect(g, x, y, 2, 2, opt.fruit); px(g, x, y, opt.fruitLite || opt.fruit);
    }
    return outline(c, opt.edge || PAL.f);
  }
  function pine(seed) {
    const c = mk(22, 34), g = cx(c);
    rect(g, 9, 26, 4, 7, PAL.n); rect(g, 9, 26, 1, 7, PAL.b);
    for (let tier = 0; tier < 4; tier++) {
      const top = 1 + tier * 6, half = 4 + tier * 2;
      for (let i = 0; i < 9; i++) {
        const w = Math.min(half, 1 + Math.floor((i * half) / 8));
        rect(g, 11 - w, top + i, w * 2, 1, i > 6 ? PAL.f : PAL.M);
        if (i < 7 && w > 1) rect(g, 11 - w + 1, top + i, Math.max(1, w - 1), 1, PAL.m);
      }
    }
    return outline(c, PAL.f);
  }
  function bush(seed, flower) {
    const r = rng(seed), c = mk(16, 11), g = cx(c);
    disc(g, 5, 6, 4, PAL.M); disc(g, 10, 6, 4, PAL.M); disc(g, 8, 4, 4, PAL.M);
    disc(g, 5, 5, 3, PAL.m); disc(g, 10, 5, 3, PAL.m); disc(g, 8, 3, 3, PAL.m);
    for (let i = 0; i < 5; i++) px(g, 3 + Math.floor(r() * 10), 2 + Math.floor(r() * 5), flower || PAL.l);
    return outline(c, PAL.f);
  }

  /* ---------- fences ---------- */
  function fenceH() {
    const c = mk(16, 14), g = cx(c);
    rect(g, 0, 5, 16, 2, PAL.N); rect(g, 0, 7, 16, 1, PAL.n);
    rect(g, 0, 9, 16, 2, PAL.N); rect(g, 0, 11, 16, 1, PAL.n);
    rect(g, 6, 1, 4, 13, PAL.N); rect(g, 6, 1, 1, 13, PAL.t); rect(g, 9, 1, 1, 13, PAL.n);
    rect(g, 6, 0, 4, 1, PAL.t); rect(g, 6, 13, 4, 1, PAL.b);
    return c;
  }
  function fenceV() {
    const c = mk(16, 16), g = cx(c);
    rect(g, 7, 0, 2, 16, PAL.N); rect(g, 8, 0, 1, 16, PAL.n);
    rect(g, 6, 3, 4, 9, PAL.N); rect(g, 6, 3, 1, 9, PAL.t); rect(g, 9, 3, 1, 9, PAL.n);
    rect(g, 6, 2, 4, 1, PAL.t); rect(g, 6, 12, 4, 1, PAL.b);
    return c;
  }
  function hedge() {
    const c = mk(16, 16), g = cx(c), r = rng(77);
    rect(g, 0, 2, 16, 13, PAL.M); rect(g, 0, 2, 16, 4, PAL.m); rect(g, 0, 13, 16, 2, PAL.f);
    for (let i = 0; i < 16; i++) px(g, Math.floor(r() * 16), 2 + Math.floor(r() * 11), i % 3 ? PAL.l : PAL.f);
    rect(g, 0, 1, 16, 1, PAL.l);
    return c;
  }
  function wallLow() {
    const c = mk(16, 12), g = cx(c);
    rect(g, 0, 0, 16, 4, PAL.w); rect(g, 0, 4, 16, 7, PAL.G); rect(g, 0, 10, 16, 2, PAL.g);
    rect(g, 7, 4, 1, 6, PAL.g); rect(g, 0, 7, 16, 1, PAL.g); rect(g, 3, 8, 1, 2, PAL.g); rect(g, 12, 8, 1, 2, PAL.g);
    return c;
  }

  /* ---------- signs ---------- */
  function sign(label, opt) {
    opt = opt || {};
    const lines = String(label).split('\n');
    const tw = Math.max.apply(null, lines.map(textWidth));
    const bw = tw + 8, bh = lines.length * 7 + 5;
    const c = mk(bw, bh + 7), g = cx(c);
    rect(g, 3, bh - 1, 2, 8, PAL.n); rect(g, bw - 5, bh - 1, 2, 8, PAL.n);
    rect(g, 0, 0, bw, bh, opt.frame || PAL.n);
    rect(g, 1, 1, bw - 2, bh - 2, opt.face || PAL.w);
    rect(g, 1, bh - 2, bw - 2, 1, opt.shade || PAL.T);
    if (opt.band) rect(g, 1, 1, bw - 2, 2, opt.band);
    lines.forEach((ln, i) => text(g, ln, Math.round((bw - textWidth(ln)) / 2), 3 + i * 7 + (opt.band ? 1 : 0), opt.ink || PAL.k));
    return outline(c, PAL.k);
  }

  /* ---------- buildings ---------- */
  function shingles(g, x, y, w, h, base, dark) {
    rect(g, x, y, w, h, base);
    for (let yy = 0; yy < h; yy += 3) {
      rect(g, x, y + yy + 2, w, 1, dark);
      for (let xx = (yy / 3) % 2 ? 2 : 5; xx < w; xx += 6) px(g, x + xx, y + yy + 1, dark);
    }
  }
  function stripes(g, x, y, w, h, a, b, step) {
    for (let i = 0; i < w; i++) rect(g, x + i, y, 1, h, Math.floor(i / step) % 2 ? a : b);
  }
  function kiosk() {
    const c = mk(50, 54), g = cx(c);
    rect(g, 5, 18, 40, 34, PAL.w); rect(g, 5, 18, 3, 34, PAL.T); rect(g, 42, 18, 3, 34, PAL.t);
    rect(g, 9, 24, 32, 13, PAL.K); rect(g, 9, 24, 32, 2, PAL.k);
    rect(g, 7, 37, 36, 3, PAL.N); rect(g, 7, 40, 36, 1, PAL.n);
    rect(g, 10, 43, 30, 7, PAL.T); text(g, 'WELCOME', 11, 44, PAL.n);
    stripes(g, 1, 10, 48, 9, PAL.M, PAL.w, 4);
    for (let i = 0; i < 48; i += 8) { rect(g, 1 + i, 19, 4, 1, PAL.M); rect(g, 5 + i, 19, 4, 1, PAL.w); }
    rect(g, 1, 9, 48, 1, PAL.f);
    disc(g, 25, 6, 5, PAL.a); rect(g, 25, 3, 1, 1, PAL.W); rect(g, 25, 5, 1, 4, PAL.W); rect(g, 24, 5, 1, 1, PAL.W); rect(g, 24, 8, 3, 1, PAL.W);
    return outline(c, PAL.k);
  }
  function shop() {
    const c = mk(92, 62), g = cx(c);
    shingles(g, 4, 2, 84, 18, PAL.r, PAL.d);
    rect(g, 0, 18, 92, 3, PAL.d);
    rect(g, 6, 21, 80, 39, PAL.w); rect(g, 6, 21, 3, 39, PAL.T); rect(g, 83, 21, 3, 39, PAL.t);
    stripes(g, 8, 24, 76, 8, PAL.R, PAL.w, 4);
    for (let i = 0; i < 72; i += 8) { rect(g, 8 + i, 32, 4, 1, PAL.w); rect(g, 12 + i, 32, 4, 1, PAL.R); }
    // window with things for sale
    rect(g, 12, 36, 34, 18, PAL.n); rect(g, 13, 37, 32, 16, PAL.A); rect(g, 13, 37, 32, 2, PAL.W);
    rect(g, 13, 46, 32, 1, PAL.n);
    rect(g, 16, 41, 4, 5, PAL.w); rect(g, 22, 40, 3, 6, PAL.r); rect(g, 27, 42, 5, 4, PAL.y); rect(g, 34, 40, 3, 6, PAL.a); rect(g, 39, 41, 4, 5, PAL.m);
    rect(g, 16, 48, 5, 5, PAL.q); rect(g, 24, 49, 6, 4, PAL.o); rect(g, 33, 48, 4, 5, PAL.w); rect(g, 39, 49, 4, 4, PAL.c);
    // door
    rect(g, 56, 36, 18, 24, PAL.n); rect(g, 58, 38, 14, 22, PAL.N); rect(g, 60, 40, 10, 9, PAL.A); rect(g, 69, 51, 2, 2, PAL.y);
    // roof sign
    rect(g, 22, 5, 48, 11, PAL.b); rect(g, 23, 6, 46, 9, PAL.w);
    text(g, 'GIFT SHOP', 23 + Math.round((46 - textWidth('GIFT SHOP')) / 2), 8, PAL.r);
    return outline(c, PAL.k);
  }
  function hall() {
    const c = mk(100, 76), g = cx(c);
    // roof and pediment
    rect(g, 2, 10, 96, 12, PAL.g); for (let x = 2; x < 98; x += 5) rect(g, x, 10, 1, 12, PAL.K);
    for (let i = 0; i < 14; i++) rect(g, 50 - 4 - i * 2.4, 6 + i, 8 + i * 4.8, 1, PAL.w);
    for (let i = 3; i < 13; i++) rect(g, 50 - 1 - i * 2, 8 + i, 2 + i * 4, 1, PAL.G);
    disc(g, 50, 16, 2, PAL.r);
    rect(g, 14, 20, 72, 3, PAL.w); rect(g, 14, 23, 72, 1, PAL.G);
    // brick wings
    for (const x0 of [4, 76]) {
      rect(g, x0, 22, 20, 46, PAL.r);
      for (let y = 22; y < 68; y += 4) { rect(g, x0, y + 3, 20, 1, PAL.d); for (let x = (y / 4) % 2 ? 3 : 7; x < 20; x += 8) px(g, x0 + x, y + 1, PAL.d); }
      rect(g, x0 + 5, 30, 10, 13, PAL.w); rect(g, x0 + 6, 31, 8, 11, PAL.A); rect(g, x0 + 9, 31, 2, 11, PAL.w); rect(g, x0 + 6, 36, 8, 1, PAL.w);
      rect(g, x0 + 5, 50, 10, 11, PAL.w); rect(g, x0 + 6, 51, 8, 9, PAL.A); rect(g, x0 + 9, 51, 2, 9, PAL.w);
    }
    // portico
    rect(g, 24, 24, 52, 44, PAL.d);
    rect(g, 41, 40, 18, 28, PAL.b); rect(g, 43, 42, 14, 26, PAL.n); rect(g, 49, 42, 2, 26, PAL.b); rect(g, 43, 42, 14, 5, PAL.A);
    for (const x of [26, 37, 58, 69]) {
      rect(g, x, 24, 6, 44, PAL.w); rect(g, x + 4, 24, 2, 44, PAL.G); rect(g, x - 1, 24, 8, 2, PAL.w); rect(g, x - 1, 66, 8, 2, PAL.G);
    }
    for (const x of [33, 65]) { rect(g, x, 28, 3, 20, PAL.R); rect(g, x, 46, 1, 2, PAL.d); rect(g, x + 2, 46, 1, 2, PAL.d); }
    // steps
    rect(g, 20, 68, 60, 3, PAL.w); rect(g, 16, 71, 68, 3, PAL.G); rect(g, 16, 73, 68, 1, PAL.g);
    rect(g, 4, 68, 16, 4, PAL.g); rect(g, 80, 68, 16, 4, PAL.g);
    return outline(c, PAL.k);
  }
  function greenhouse() {
    const c = mk(82, 58), g = cx(c);
    // arched glass roof
    for (let i = 0; i < 18; i++) {
      const inset = Math.round(18 - Math.sqrt(18 * 18 - (18 - i) * (18 - i)));
      rect(g, 3 + inset, 2 + i, 76 - inset * 2, 1, i < 3 ? PAL.W : PAL.A);
    }
    rect(g, 3, 20, 76, 34, PAL.A);
    // plants inside
    const r = rng(9);
    for (let i = 0; i < 12; i++) disc(g, 8 + Math.floor(r() * 66), 34 + Math.floor(r() * 14), 3 + Math.floor(r() * 3), i % 2 ? PAL.m : PAL.M);
    for (let i = 0; i < 8; i++) px(g, 8 + Math.floor(r() * 66), 30 + Math.floor(r() * 16), i % 2 ? PAL.R : PAL.y);
    // glints
    g.globalAlpha = 0.45; rect(g, 3, 20, 76, 34, PAL.A); g.globalAlpha = 1;
    for (let x = 10; x < 70; x += 22) { line(g, x, 30, x + 6, 24, PAL.W); line(g, x + 3, 32, x + 8, 27, PAL.W); }
    // frame
    for (let x = 3; x <= 79; x += 19) rect(g, x - 1, 8, 2, 46, PAL.w);
    rect(g, 3, 19, 76, 2, PAL.w); rect(g, 3, 36, 76, 1, PAL.w); rect(g, 2, 53, 78, 4, PAL.G); rect(g, 2, 56, 78, 1, PAL.g);
    rect(g, 34, 34, 14, 20, PAL.w); rect(g, 36, 36, 10, 18, PAL.A); rect(g, 40, 36, 2, 18, PAL.w);
    return outline(c, PAL.k);
  }
  /* Stone plinth for the heart, drawn in two parts so the heart can beat between them. */
  function plinth() {
    const c = mk(44, 22), g = cx(c);
    ellipse(g, 22, 13, 21, 8, PAL.g); ellipse(g, 22, 10, 21, 8, PAL.G); ellipse(g, 22, 9, 17, 6, PAL.w);
    ellipse(g, 22, 9, 13, 4, PAL.G);
    return outline(c, PAL.k);
  }
  function dome() {
    const c = mk(44, 46), g = cx(c);
    g.globalAlpha = 0.22; ellipse(g, 22, 24, 19, 21, PAL.A); g.globalAlpha = 1;
    for (let a = 0; a < 360; a += 2) {
      const x = 22 + Math.cos((a * Math.PI) / 180) * 19, y = 24 + Math.sin((a * Math.PI) / 180) * 21;
      if (y < 40) px(g, Math.round(x), Math.round(y), PAL.W);
    }
    line(g, 9, 14, 13, 9, PAL.W); line(g, 8, 18, 9, 16, PAL.W); line(g, 33, 34, 35, 30, PAL.W);
    return c;
  }
  function gate() {
    const label = 'KYSELICA PARK';
    const bw = textWidth(label) + 16;
    const w = bw + 24, c = mk(w, 58), g = cx(c);
    for (const x of [2, w - 14]) {
      rect(g, x, 14, 12, 42, PAL.G); rect(g, x, 14, 3, 42, PAL.w); rect(g, x + 9, 14, 3, 42, PAL.g);
      for (let y = 20; y < 56; y += 7) rect(g, x, y, 12, 1, PAL.g);
      rect(g, x - 2, 12, 16, 3, PAL.w); rect(g, x - 2, 54, 16, 3, PAL.g);
      disc(g, x + 6, 8, 4, PAL.y); px(g, x + 5, 6, PAL.Y);
    }
    rect(g, 10, 15, w - 20, 16, PAL.d); rect(g, 12, 17, w - 24, 12, PAL.r); rect(g, 12, 17, w - 24, 1, PAL.R);
    text(g, label, Math.round((w - textWidth(label)) / 2), 20, PAL.w);
    rect(g, 12, 27, w - 24, 1, PAL.y);
    return outline(c, PAL.k);
  }
  function flag(kind) {
    const c = mk(12, 8), g = cx(c);
    if (kind === 'jp') { rect(g, 0, 0, 12, 8, PAL.W); rect(g, 4, 2, 4, 4, PAL.R); rect(g, 5, 1, 2, 6, PAL.R); rect(g, 3, 3, 6, 2, PAL.R); }
    else if (kind === 'us') {
      for (let y = 0; y < 8; y++) rect(g, 0, y, 12, 1, y % 2 ? PAL.W : PAL.R);
      rect(g, 0, 0, 5, 4, PAL.v); px(g, 1, 1, PAL.W); px(g, 3, 1, PAL.W); px(g, 2, 2, PAL.W);
    } else if (kind === 'scarlet') { rect(g, 0, 0, 12, 8, PAL.r); rect(g, 0, 3, 12, 2, PAL.G); }
    else if (kind === 'elite') { rect(g, 0, 0, 12, 8, PAL.R); rect(g, 3, 2, 6, 1, PAL.w); rect(g, 2, 3, 5, 2, PAL.w); rect(g, 7, 4, 3, 1, PAL.w); }
    else if (kind.length === 1) {
      const sets = { a: [PAL.a, PAL.W, PAL.R], b: [PAL.m, PAL.W, PAL.o], c: [PAL.k, PAL.R, PAL.y], d: [PAL.R, PAL.W, PAL.R], e: [PAL.u, PAL.y, PAL.u], f: [PAL.m, PAL.y, PAL.m] }[kind];
      for (let i = 0; i < 3; i++) rect(g, i * 4, 0, 4, 8, sets[i]);
    }
    else { const p = kind.split('|'); for (let i = 0; i < 3; i++) rect(g, i * 4, 0, 4, 8, p[i]); }
    return c;
  }
  function fountain(frame) {
    const c = mk(48, 44), g = cx(c);
    ellipse(g, 24, 30, 23, 12, PAL.g); ellipse(g, 24, 28, 23, 12, PAL.G); ellipse(g, 24, 27, 20, 10, PAL.w);
    ellipse(g, 24, 28, 19, 9, PAL.a); ellipse(g, 24, 27, 17, 7, '#63b6e6');
    ellipse(g, 24, 26, 6, 3, PAL.G); rect(g, 21, 14, 6, 12, PAL.G); rect(g, 21, 14, 2, 12, PAL.w); rect(g, 25, 14, 1, 12, PAL.g);
    ellipse(g, 24, 14, 9, 3, PAL.g); ellipse(g, 24, 13, 9, 3, PAL.w); ellipse(g, 24, 13, 7, 2, PAL.A);
    // spout and ripples
    const f = frame % 2;
    rect(g, 23, 4 + f, 2, 9 - f, PAL.A); px(g, 23, 3 + f, PAL.W); px(g, 24, 2 + f, PAL.W);
    px(g, 20 - f, 6, PAL.A); px(g, 27 + f, 6, PAL.A); px(g, 18 - f, 9, PAL.W); px(g, 29 + f, 9, PAL.W);
    for (const [x, y] of [[12, 26], [34, 30], [18, 32], [30, 24], [9, 29], [38, 27]]) rect(g, x + (f ? 1 : 0), y, 3, 1, PAL.W);
    for (const x of [14, 33]) rect(g, x, 16 + f, 1, 10 - f, PAL.A);
    return outline(c, PAL.k);
  }
  /* 2:1 isometric box for the miniature campus. */
  function isoBox(g, x, y, w, d, h, top, left, right) {
    // (x, y) is the bottom corner nearest the viewer; w runs up-right, d runs up-left
    for (let i = 0; i < h; i++) {
      for (let a = 0; a < d; a++) px(g, x - a * 2 - 1, y - a - i, left), px(g, x - a * 2 - 2, y - a - i, left);
      for (let a = 0; a < w; a++) px(g, x + a * 2, y - a - i, right), px(g, x + a * 2 + 1, y - a - i, right);
    }
    for (let a = 0; a < d; a++) for (let b = 0; b < w; b++) {
      const tx = x - a * 2 + b * 2, ty = y - h - a - b;
      rect(g, tx - 2, ty, 4, 1, top); rect(g, tx - 1, ty - 1, 2, 1, top);
    }
  }
  function diorama() {
    const W = 132, H = 78, c = mk(W, H), g = cx(c);
    // table
    rect(g, 2, 14, W - 4, 52, PAL.n); rect(g, 2, 60, W - 4, 6, PAL.b);
    rect(g, 6, 66, 6, 10, PAL.b); rect(g, W - 12, 66, 6, 10, PAL.b);
    rect(g, 4, 12, W - 8, 46, '#cfe0a8'); rect(g, 4, 56, W - 8, 2, PAL.m);
    // lawn diamond (the Oval) and paths
    ellipse(g, 62, 36, 22, 10, PAL.l); ellipse(g, 62, 36, 20, 8, '#a5d77c');
    line(g, 42, 36, 82, 36, PAL.T); line(g, 50, 30, 74, 42, PAL.T); line(g, 50, 42, 74, 30, PAL.T);
    // roads
    line(g, 6, 50, 126, 50, PAL.G); line(g, 6, 51, 126, 51, PAL.G); line(g, 100, 13, 100, 56, PAL.G); line(g, 101, 13, 101, 56, PAL.G);
    // buildings: brick with limestone tops
    const brick = [PAL.G, PAL.r, PAL.d], stone = [PAL.w, PAL.T, PAL.t], glass = [PAL.A, PAL.a, PAL.u];
    isoBox(g, 24, 30, 5, 4, 8, ...brick); isoBox(g, 20, 46, 4, 3, 6, ...stone); isoBox(g, 40, 22, 3, 3, 10, ...brick);
    isoBox(g, 84, 26, 4, 4, 7, ...stone); isoBox(g, 92, 44, 3, 3, 12, ...glass); isoBox(g, 118, 30, 3, 3, 16, ...stone);
    isoBox(g, 116, 46, 4, 2, 5, ...brick); isoBox(g, 66, 22, 4, 2, 5, ...brick);
    // little trees
    for (const [x, y] of [[36, 40], [48, 24], [78, 46], [88, 34], [10, 36], [58, 48], [108, 20], [14, 22], [72, 54], [124, 54]]) {
      disc(g, x, y, 2, PAL.M); px(g, x - 1, y - 1, PAL.l);
    }
    return outline(c, PAL.k);
  }
  function perch() {
    const c = mk(54, 50), g = cx(c);
    rect(g, 25, 14, 4, 34, PAL.n); rect(g, 25, 14, 1, 34, PAL.b); rect(g, 22, 47, 10, 2, PAL.b);
    line(g, 26, 30, 8, 22, PAL.n); line(g, 26, 31, 8, 23, PAL.n); line(g, 8, 22, 4, 14, PAL.n);
    line(g, 28, 24, 46, 16, PAL.n); line(g, 28, 25, 46, 17, PAL.n); line(g, 46, 16, 50, 9, PAL.n);
    line(g, 27, 14, 20, 4, PAL.n); line(g, 28, 14, 34, 5, PAL.n);
    line(g, 26, 38, 40, 34, PAL.n); line(g, 26, 39, 40, 35, PAL.n);
    for (const [x, y] of [[4, 13], [50, 8], [20, 3], [34, 4], [41, 33]]) { disc(g, x, y, 2, PAL.m); px(g, x, y - 1, PAL.l); }
    return outline(c, PAL.k);
  }
  /* The Plethos remaster's mark, as a garden monument: a cleared slot, the red head, an ivory tile. */
  function plethosMark() {
    const c = mk(40, 20), g = cx(c);
    rect(g, 2, 13, 36, 5, PAL.G); rect(g, 2, 17, 36, 2, PAL.g); rect(g, 0, 12, 40, 2, PAL.w);
    const tile = (x, y, s, fill, edge) => { rect(g, x + 1, y, s - 2, s, fill); rect(g, x, y + 1, s, s - 2, fill); if (edge) { rect(g, x + 1, y, s - 2, 1, edge); rect(g, x + 1, y + s - 1, s - 2, 1, edge); rect(g, x, y + 1, 1, s - 2, edge); rect(g, x + s - 1, y + 1, 1, s - 2, edge); } };
    tile(3, 3, 9, '#e3ded3');
    tile(14, 1, 12, '#f6ded6', '#e0533d'); disc(g, 19, 6, 2, '#e0533d'); px(g, 20, 7, '#e0533d');
    tile(28, 2, 10, '#fcfbf8', '#d9d3c4'); rect(g, 29, 11, 8, 1, '#cfc8b8');
    return outline(c, PAL.k);
  }
  function arenaWall(wpx) {
    const c = mk(wpx, 60), g = cx(c), r = rng(2025);
    // black curtain with the flags of the nations hung along it
    rect(g, 0, 0, wpx, 14, '#1b1720'); rect(g, 0, 13, wpx, 1, PAL.K);
    const kinds = ['us', 'jp', 'a', 'b', 'c', 'd', 'e', 'jp', 'us', 'f', 'a', 'c', 'b', 'd'];
    for (let x = 10, i = 0; x < wpx - 14; x += 29, i++) g.drawImage(flag(kinds[i % kinds.length]), x, 3);
    // stands with a crowd
    rect(g, 0, 14, wpx, 30, '#2b2a33');
    for (let row = 0; row < 3; row++) {
      rect(g, 0, 22 + row * 8, wpx, 2, PAL.K);
      for (let x = 3 + (row % 2) * 3; x < wpx - 3; x += 6) {
        if (r() < 0.12) continue;
        const sk = SKINS[Math.floor(r() * SKINS.length)], sh = SHIRTS[Math.floor(r() * SHIRTS.length)], hr = HAIRS[Math.floor(r() * HAIRS.length)];
        const y = 15 + row * 8 + (r() < 0.2 ? 1 : 0);
        rect(g, x, y, 3, 1, hr); rect(g, x, y + 1, 3, 2, sk); rect(g, x - 1, y + 3, 5, 4, sh);
      }
    }
    // banner boards
    rect(g, 0, 44, wpx, 14, PAL.W); rect(g, 0, 57, wpx, 3, PAL.G); rect(g, 0, 44, wpx, 1, PAL.G);
    const msg = 'WORLD JUMP ROPE CHAMPIONSHIP 2025', tw = textWidth(msg);
    const n = Math.max(1, Math.floor(wpx / (tw + 40))), seg = wpx / n;
    for (let i = 0; i < n; i++) {
      if (i) rect(g, Math.round(i * seg), 44, 1, 14, PAL.G);
      const x = Math.round(i * seg + (seg - tw - 12) / 2);
      rect(g, x, 48, 4, 4, PAL.R); rect(g, x + 1, 47, 2, 6, PAL.R); rect(g, x - 1, 49, 6, 2, PAL.R);
      text(g, msg, x + 12, 48, i % 2 ? PAL.r : PAL.v);
    }
    return c;
  }


  /* ---------- Graveshift: Hollow Creek ----------
     These are the game's own sprites, copied from its source, on the game's own 32-colour palette.
     '0' is the black outline the game draws into every sprite. */
  const GS = {
    0: '#05060f', 1: '#0b1026', 2: '#141c3a', 3: '#1f2d5c', 4: '#2b4a8c', 5: '#3b7dd8', 6: '#6fc3ff', 7: '#c8f0ff', 8: '#ffffff',
    a: '#0e2a2a', b: '#14524a', c: '#1f8a6d', d: '#4fd39a', e: '#b6f5a8', g: '#3b1a5c', h: '#7a35b8', i: '#ff3d9a', j: '#ffb3d9',
    k: '#3a0d14', l: '#7a1b24', m: '#c8322e', n: '#ff6b3d', o: '#ffa53d', p: '#ffd75e', q: '#fff5b8', s: '#5a3a22', t: '#9a6a3c',
    u: '#d9a86a', v: '#f2dcb0', x: '#56607a', y: '#a8b0c8', z: '#e8ecf5',
  };
  const gsRows = (src) => src.replace(/^\n/, '').split('\n');
  /* paint parts onto a w x h grid; a part is [rows, x, y] */
  function gsComp(w, h, parts) {
    const grid = Array.from({ length: h }, () => Array(w).fill('.'));
    for (const [r, ox, oy] of parts) r.forEach((row, y) => { for (let x = 0; x < row.length; x++) { const ch = row[x], gx = ox + x, gy = oy + y; if (ch !== '.' && ch !== ' ' && gx >= 0 && gy >= 0 && gx < w && gy < h) grid[gy][gx] = ch; } });
    return grid.map((r) => r.join(''));
  }
  /* move an arm (columns x0..x1, rows y0..y1) up or down by dy */
  function gsSwing(r, x0, x1, y0, y1, dy) {
    const grid = r.map((row) => row.split('')), n = y1 - y0 + 1;
    for (let x = x0; x <= x1; x++) {
      const col = r.slice(y0, y1 + 1).map((row) => row[x]);
      for (let i = 0; i < n; i++) { const from = i - dy; grid[y0 + i][x] = from >= 0 && from < n ? col[from] : '.'; }
    }
    return grid.map((row) => row.join(''));
  }
  const GS_LEGS = ['\n...0LL00LL0...\n..0LL0..0LL0..\n..0FF0...0FF0.', '\n....0LLLL0....\n....0LL0L0....\n....0FF0F0....',
    '\n...0LL00LL0...\n...0L0..0LL0..\n..0FF0..0FFF0.', '\n....0LLLL0....\n....0L0LL0....\n....0F0FF0....'];
  // Marlow, the night watchman: peaked cap, moustache, blue uniform, brass buttons
  const GS_MARLOW = '\n....000000....\n...03333330...\n..0334p43330..\n..0000000000..\n...0vvvvvv0...\n...0v0vv0v0...\n...0vsssuv0...\n....0vvvv0....\n...04444440...\n..0454p44540..\n..0v54p445v0..\n..0v0444450v0.\n...03333330...';
  function marlow() {
    const body = gsRows(GS_MARLOW).map((r) => '.' + r + '.');
    const legs = GS_LEGS.map((l) => gsRows(l).map((r) => '.' + r + '.').map((r) => r.replace(/L/g, '3').replace(/F/g, 's')));
    const out = [];
    for (let i = 0; i < 4; i++) {
      const sw = i === 0 ? 1 : i === 2 ? -1 : 0;
      const arms = gsSwing(gsSwing(body, 3, 4, 8, 12, sw), 11, 13, 8, 12, -sw);
      out.push(rows(gsComp(16, 16, [[legs[i], 0, 13], [arms, 0, i % 2]]), GS));
    }
    return out;
  }
  // the Shambler: lurching, arms out
  const SH_HEAD = gsRows('\n.0000.\n0cccc0\n0cp0p0\n0ccllc0\n.0cc00.');
  const SH_TORSO = gsRows('\n.00xx0\n0xxxxx0\n0xxyxx0\n.0xxxx0');
  const SH_HI = gsRows('\n.000\n0bbb0\n00000\ncccc0\n0000');
  const SH_LO = gsRows('\n.000\n0bbb0\n0000\n0ccc0\n.000');
  const SH_LEGS = ['\n.03440..\n0330440.\n030..040\n0cc..0cc', '\n..0440..\n.033440.\n0cc0040.\n....0cc.',
    '\n.04330..\n0440330.\n040..030\n0cc..0cc', '\n..0330..\n.044330.\n0cc0030.\n....0cc.'].map(gsRows);
  function shambler(i) {
    const lo = i % 2 === 1;
    // enemies are outlined in red in the game: red means "this will hurt you"
    return outline(rows(gsComp(10, 13, [[SH_LEGS[i], 1, 9], [SH_TORSO, 1, 5], [lo ? SH_LO : SH_HI, 5, lo ? 5 : 4], [SH_HEAD, lo ? 3 : 2, 0]]), GS), GS.m);
  }
  const GS_DECOR = {
    lantern: ['\n.xx.\n0xx0\n0pq0\n0qp0\n0000', '\n.xx.\n0xx0\n0qq0\n0pq0\n0000'],
    tomb: '\n..00000..\n.0zzzzy0.\n0zzyyyyx0\n0zyyxyyx0\n0zyxxxyx0\n0zyyxyyx0\n0zyyxyyx0\n0zyyyyyx0\n0yyyyyxx0\nc0000000c',
    cross: '\n..000..\n..0z0..\n000zy00\n0zzzzx0\n000zx00\n..0zx0.\n..0zx0.\n.0yyxx0\nc00000c',
    deadtree: '\n....0....0..\n.0..0s..0s..\n0s0.0s.0s0..\n.0s00s0s0...\n..0ssss0..0.\n...0ss0..0s0\n...0ss000s0.\n...0sssss0..\n...0ss00....\n...0ss0.....\n...0ss0.....\n..0ssss0....\n.0s0ss0s0...',
    grave: '\n.0000000000.\n0s00000000s0\n0s00000000s0\n0ss000000ss0\n.0000000000.',
    candle: ['\n.p.\n.q.\n0z0\n0z0\n000', '\n.q.\n.p.\n0z0\n0z0\n000'],
    pumpkin: '\n....0c...\n.000s000.\n0nnoonnn0\n0opnnnpo0\n0npppppn0\n.0nnonn0.\n..00000..',
  };
  const gsSprite = (src) => rows(gsRows(src), GS);
  function ironFence(kind) {
    const c = mk(16, 16), g = cx(c), bar = '#2a2633', hi = '#56607a';
    if (kind === 'v') { rect(g, 7, 0, 2, 16, bar); rect(g, 7, 0, 1, 16, hi); return c; }
    rect(g, 0, 6, 16, 1, bar); rect(g, 0, 13, 16, 2, bar);
    for (let x = 1; x < 16; x += 3) { rect(g, x, 4, 1, 10, bar); px(g, x, 3, hi); px(g, x, 4, hi); }
    rect(g, 0, 13, 16, 1, hi);
    return c;
  }
  function ironGate() {
    const c = mk(32, 22), g = cx(c), bar = '#2a2633', hi = '#56607a';
    for (const x of [0, 29]) { rect(g, x, 2, 3, 20, bar); rect(g, x, 2, 1, 20, hi); rect(g, x - 0, 0, 3, 2, hi); }
    rect(g, 3, 8, 26, 1, bar); rect(g, 3, 18, 26, 2, bar);
    for (let x = 5; x < 29; x += 3) { const top = 6 - Math.round(Math.sin(((x - 3) / 26) * Math.PI) * 4); rect(g, x, top, 1, 18 - top, bar); px(g, x, top - 1, hi); }
    rect(g, 15, 9, 2, 9, bar); disc(g, 16, 13, 2, bar); px(g, 16, 13, hi);
    return outline(c, '#05060f');
  }
  /* a street lamp with the power out */
  const DEAD_LAMP = ['.KKKK.', 'KggggK', 'KgKggK', 'KggggK', '.KKKK.', '..KK..', '..KK..', '..KK..', '..KK..', '..KK..', '..KK..', '..KK..', '..KK..', '..KK..', '.KKKK.', 'KKKKKK'];

  /* ---------- NextJump: the counting camera on its tripod ---------- */
  const TRIPOD = ['KKKKKKK..', 'KgGGgKKK.', 'KgAAgKKKR', 'KgGGgKKK.', 'KKKKKKK..', '...gg....', '..g..g...', '..g..g...', '.g....g..', '.g....g..', 'g......g.'];

  /* ---------- more park furniture ---------- */
  function wallV() {
    const c = mk(16, 16), g = cx(c);
    rect(g, 5, 0, 6, 16, PAL.w); rect(g, 9, 0, 2, 16, PAL.G); rect(g, 5, 7, 6, 1, PAL.G); rect(g, 5, 15, 6, 1, PAL.G);
    return c;
  }
  function hurdle() {
    const c = mk(22, 15), g = cx(c);
    for (const x of [0, 19]) { rect(g, x, 0, 3, 15, PAL.w); rect(g, x + 2, 0, 1, 15, PAL.G); rect(g, x, 0, 3, 1, PAL.R); }
    for (const y of [3, 8]) for (let x = 3; x < 19; x++) rect(g, x, y, 1, 2, Math.floor((x - 3) / 4) % 2 ? PAL.w : PAL.R);
    return outline(c, PAL.k);
  }
  function bridgeRail() {
    const c = mk(48, 9), g = cx(c);
    rect(g, 0, 2, 48, 2, PAL.N); rect(g, 0, 4, 48, 1, PAL.n);
    for (const x of [1, 15, 30, 44]) { rect(g, x, 0, 3, 9, PAL.N); rect(g, x, 0, 1, 9, PAL.t); rect(g, x + 2, 0, 1, 9, PAL.n); }
    return outline(c, PAL.k);
  }
  function campfire(f) {
    const c = mk(12, 13), g = cx(c);
    rect(g, 1, 10, 10, 2, PAL.n); rect(g, 3, 9, 6, 1, PAL.b); px(g, 0, 11, PAL.G); px(g, 11, 11, PAL.G);
    const fl = f ? [[5, 2, 2, 8, PAL.o], [4, 5, 4, 5, PAL.o], [5, 5, 2, 5, PAL.y], [6, 1, 1, 2, PAL.y]]
      : [[5, 3, 2, 7, PAL.o], [4, 6, 5, 4, PAL.o], [5, 6, 2, 4, PAL.y], [4, 2, 1, 2, PAL.y]];
    for (const [x, y, w, h, cc] of fl) rect(g, x, y, w, h, cc);
    return outline(c, PAL.k);
  }
  function lilypad() {
    const c = mk(9, 6), g = cx(c);
    ellipse(g, 4, 3, 4, 2, PAL.M); ellipse(g, 4, 2, 3, 1, PAL.m); px(g, 4, 3, PAL.a); px(g, 5, 3, PAL.a); px(g, 6, 1, PAL.p);
    return c;
  }
  function cone() { return spr(['..o..', '.owo.', '.ooo.', 'owwwo', 'ooooo', 'KKKKK']); }
  function monitor() {
    const c = mk(30, 22), g = cx(c);
    rect(g, 0, 0, 30, 14, PAL.K); rect(g, 1, 1, 28, 12, '#12241c'); rect(g, 13, 14, 4, 6, PAL.g); rect(g, 9, 20, 12, 2, PAL.g);
    return outline(c, PAL.k);
  }
  function bubble(label) {
    const tw = textWidth(label), c = mk(tw + 6, 12), g = cx(c);
    rect(g, 0, 0, tw + 6, 9, PAL.W); rect(g, 3, 9, 3, 1, PAL.W); rect(g, 4, 10, 1, 1, PAL.W);
    text(g, label, 3, 2, PAL.k);
    return outline(c, PAL.k);
  }

  /* ---------- assemble ---------- */
  const S = {};
  function build() {
    S.fennec = FENNEC.map((a) => spr(a));
    S.fennecL = S.fennec.map(flipH);
    S.kangaroo = KANGAROO.map((a) => spr(a));
    S.pegasus = PEGASUS.map((a) => spr(a));
    S.pegasusR = S.pegasus.map(flipH);
    S.parrots = [parrot(PAL.R, PAL.a), parrot(PAL.m, PAL.y), parrot(PAL.a, PAL.y), parrot(PAL.y, PAL.o)];
    S.ladybug = rows(LADYBUG); S.beetle = rows(BEETLE);
    S.butterfly = BUTTERFLY.map((a) => rows(a));
    S.butterfly2 = BUTTERFLY.map((a) => rows(a, { y: PAL.p }));
    S.butterfly3 = BUTTERFLY.map((a) => rows(a, { y: PAL.W }));
    S.frog = spr(FROG); S.fish = rows(FISH); S.duck = spr(DUCK);
    S.heart = spr(HEART, null, PAL.x);
    S.trophy = spr(TROPHY);
    S.cactus = spr(CACTUS, null, PAL.f);
    S.rock = spr(ROCK); S.rockS = spr(ROCK_S);
    S.bench = spr(BENCH); S.lamp = spr(LAMP); S.stanchion = rows(STANCHION);
    S.cattail = rows(CATTAIL); S.mailbox = spr(MAILBOX); S.speaker = spr(SPEAKER); S.camera = spr(CAMERA);
    S.car = [spr(CAR), spr(CAR, { R: PAL.a })];
    S.bulb = spr(BULB); S.bulbOn = spr(BULB_ON, null, PAL.z);
    S.chess = {
      w: [PAWN, ROOK, KNIGHT, KING].map((a) => spr(a, { 1: PAL.w })),
      b: [PAWN, ROOK, KNIGHT, KING].map((a) => spr(a, { 1: PAL.K })),
    };
    S.flagpole = rows(FLAGPOLE);
    S.log = spr(LOG); S.burrow = rows(BURROW); S.signpost = spr(SIGNPOST); S.picnic = spr(PICNIC);
    S.trees = [tree(11), tree(23), tree(37), tree(51)];
    S.buckeye = [tree(5, { fruit: PAL.b, fruitLite: PAL.N, dark: '#3a7a3a', mid: '#58a046', lite: '#86c95c' }), tree(8, { fruit: PAL.b, fruitLite: PAL.N, dark: '#3a7a3a', mid: '#58a046', lite: '#86c95c' })];
    S.blossom = [tree(3, { dark: PAL.P, mid: PAL.p, lite: '#f7c3cf', edge: PAL.x }), tree(4, { dark: PAL.P, mid: PAL.p, lite: '#f7c3cf', edge: PAL.x })];
    S.autumn = [tree(6, { dark: '#b5532f', mid: PAL.o, lite: PAL.y, edge: '#7a3418' })];
    S.pine = [pine(1)];
    S.bush = [bush(1), bush(2, PAL.p), bush(3, PAL.y), bush(4, PAL.W)];
    S.fenceH = fenceH(); S.fenceV = fenceV(); S.hedge = hedge(); S.wallLow = wallLow(); S.wallV = wallV();
    S.hurdle = hurdle(); S.bridgeRail = bridgeRail(); S.campfire = [campfire(0), campfire(1)]; S.lilypad = lilypad();
    S.cone = cone(); S.monitor = monitor();
    S.bubbles = ['?', '!', '...', 'HI', 'OK', '*'].map(bubble);
    S.kiosk = kiosk(); S.shop = shop(); S.hall = hall(); S.greenhouse = greenhouse();
    S.plinth = plinth(); S.dome = dome(); S.gate = gate(); S.diorama = diorama(); S.perch = perch();
    S.plethosMark = plethosMark();
    S.gs = {
      marlow: marlow(), shambler: [0, 1, 2, 3].map(shambler),
      lantern: GS_DECOR.lantern.map(gsSprite), candle: GS_DECOR.candle.map(gsSprite),
      tomb: gsSprite(GS_DECOR.tomb), cross: gsSprite(GS_DECOR.cross), deadtree: gsSprite(GS_DECOR.deadtree),
      grave: gsSprite(GS_DECOR.grave), pumpkin: gsSprite(GS_DECOR.pumpkin),
      fenceH: ironFence('h'), fenceV: ironFence('v'), gate: ironGate(), deadLamp: spr(DEAD_LAMP), pal: GS,
    };
    S.gs.shamblerL = S.gs.shambler.map(flipH);
    S.tripod = spr(TRIPOD);
    S.fountain = [fountain(0), fountain(1)];
    S.flags = { scarlet: flag('scarlet'), elite: flag('elite') };
    S.erik = person(Object.assign({ hair: '#4a2e1c', skin: PAL.s }, USA));
    S.visitor = person({ hair: '#3a2416', hat: PAL.y, skin: PAL.s, shirt: PAL.c, pants: PAL.v, legs: PAL.v, shoes: PAL.w });
    const team = [['#4a2e1c', PAL.s], ['#1f1a24', '#e8b98c'], ['#8a5a2c', PAL.s], ['#1f1a24', PAL.S], ['#3a2416', PAL.s], ['#2a1c14', PAL.e],
      ['#c9a15a', '#f6d3b0'], ['#5a3a22', PAL.s]];
    S.team = team.map(([hair, skin]) => person(Object.assign({ hair, skin }, USA)));
    return S;
  }

  Park.art = {
    PAL, S, build, mk, cx, rect, px, disc, ellipse, line, rng, rows, outline, flipH, flipV, spr, text, textWidth,
    sign, arenaWall, person, randomPerson, tree, isoBox, bubble,
  };
})();
