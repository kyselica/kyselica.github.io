// Real aircraft over campus, from ADS-B (GET api/planes: proxy/planes.mjs in development, functions/api/planes.js on
// Cloudflare Pages). Each aircraft is a small lit model of its real type and size (a Cessna 172 is 8 m long, a 737
// 39 m, a helicopter carries a rotor), drawn at a compressed height above a soft shadow straight below it, dead-reckoned
// between reports along its track (and its turn), with corrections eased in. Navigation lights, beacon and strobes blink
// at night. Click one for its card. ?planes=mock flies synthetic traffic (an approach into CMH, Cessnas from Don Scott
// Field, a medical helicopter landing on the hospital's roof) so the layer can be tested any time; ?planes=404 asks a
// missing endpoint, as a static host without functions would answer.
//
// Layers: "planes-low" (z 45: shadows, then aircraft low enough to hide behind a building — they are drawn with
// occlusion, under the night tint) and "planes" (z 92: everything higher, above labels and weather; all the lights).

const KT = 0.514444, FT = 0.3048, RAD = Math.PI / 180;
const FIELD_FT = 750;                     // the campus's ground, ft above sea level
const POLL_MS = 6000, POLL_IDLE_MS = 10000, POLL_MAX_MS = 60000;
const KEEP_M = 9000;                      // followed while within this far of the slab's edge
const MARGIN0 = 1500, MARGIN1 = 5000;     // over the paper: fully drawn within 1.5 km of the slab, gone by 5 km
const LOST_S = 12, FADE_S = 1.6;          // missing from the feed: flown on by dead reckoning, then faded
const TAU = 1.4, TAU_ALT = 2;             // how fast a correction is eased in (s)
const LOW_Z = 95;                         // below this drawn height an aircraft can hide behind a building (the tallest is 86 m)
const MOCK_EVERY = 5;                     // s between synthetic reports

/** Drawn height (m) for a true height above campus (m): true up to 80 m (a helicopter on a rooftop pad sits on its
 * roof), then logarithmic: 1,000 ft → 180 m, 2,000 ft → 230 m, 5,000 ft → 295 m, 38,000 ft → 435 m. */
export function drawnHeight(agl) { return agl <= 80 ? Math.max(0, agl) : 80 + 70 * Math.log(1 + (agl - 80) / 70); }

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const wrap360 = (d) => ((d % 360) + 360) % 360;
const fin = (v) => typeof v === "number" && Number.isFinite(v);

// ------------------------------------------------------------------------------------------------ aircraft types
// ICAO type → kind, length (m), span (m; a helicopter's rotor diameter), name
const TYPE_TABLE = `
C150 hw 7.3 10.2 Cessna 150|C152 hw 7.3 10.1 Cessna 152|C170 hw 7.6 11 Cessna 170|C172 hw 8.3 11 Cessna 172 Skyhawk|C72R hw 8.3 11 Cessna 172RG Cutlass
C177 hw 8.4 10.8 Cessna Cardinal|C182 hw 8.8 11 Cessna 182 Skylane|C206 hw 8.6 11 Cessna 206 Stationair|C210 hw 8.6 11.2 Cessna 210 Centurion
C208 hw 11.5 15.9 Cessna 208 Caravan|C195 hw 8.2 11 Cessna 195|PA18 hw 6.9 10.7 Piper Super Cub|CH7A hw 6.9 10.2 Champion Citabria|BL8 hw 6.9 10.5 Bellanca Decathlon
P28A lw 7.3 10.7 Piper Cherokee|P28B lw 7.3 10.7 Piper Cherokee|P28R lw 7.5 10.8 Piper Arrow|P28T lw 7.5 10.8 Piper Arrow|PA32 lw 8.4 11 Piper Saratoga
P32R lw 8.4 11 Piper Lance|PA46 lw 8.8 13.1 Piper Malibu|P46T lw 9 13.1 Piper Meridian|SR20 lw 7.9 11.7 Cirrus SR20|SR22 lw 7.9 11.7 Cirrus SR22
S22T lw 7.9 11.7 Cirrus SR22T|DA40 lw 8.1 11.9 Diamond DA40|DV20 lw 7.2 10.9 Diamond DA20|BE33 lw 7.7 10.2 Beechcraft Debonair|BE35 lw 8.1 10.2 Beechcraft Bonanza
BE36 lw 8.4 10.2 Beechcraft Bonanza|M20P lw 7.5 11 Mooney M20|M20T lw 8.2 11 Mooney M20|RV7 lw 6.2 7.7 Van's RV-7|RV8 lw 6.3 7.3 Van's RV-8|RV10 lw 7.4 9.6 Van's RV-10
RV12 lw 6.2 8.2 Van's RV-12|AA5 lw 6.7 9.6 Grumman Tiger|TBM7 lw 10.6 12.8 Daher TBM 700|TBM8 lw 10.7 12.8 Daher TBM 850|TBM9 lw 10.7 12.8 Daher TBM 900
PC12 lw 14.4 16.3 Pilatus PC-12|COL4 lw 7.6 11 Cessna TTx|BE58 tw 9.1 11.5 Beechcraft Baron|BE55 tw 8.5 11.5 Beechcraft Baron|PA34 tw 8.7 11.9 Piper Seneca
PA44 tw 8.4 11.8 Piper Seminole|PA31 tw 10.6 12.4 Piper Navajo|PA23 tw 8.2 11.3 Piper Aztec|DA42 tw 8.6 13.4 Diamond DA42|DA62 tw 9.2 14.6 Diamond DA62
C310 tw 9.7 11.3 Cessna 310|C340 tw 10.5 11.6 Cessna 340|C414 tw 11.1 12.5 Cessna 414|C421 tw 11.1 12.5 Cessna 421|BE9L tw 10.8 15.3 Beechcraft King Air 90
BE20 tt 13.4 16.6 Beechcraft King Air 200|B350 tt 14.2 17.7 Beechcraft King Air 350|BE30 tt 13.4 16.6 Beechcraft King Air 300|BE99 tw 13.6 14 Beechcraft 99
SW4 tw 18.1 17.4 Fairchild Metro|DH8A hp 22.3 25.9 Dash 8-100|DH8D hp 32.8 28.4 Dash 8-400|AT75 hp 27.2 27.1 ATR 72|AT76 hp 27.2 27.1 ATR 72
SF50 bj 9.4 11.8 Cirrus Vision Jet|HDJT bj 13 12.1 HondaJet|E50P bj 12.8 12.3 Embraer Phenom 100|E55P bj 15.6 16.2 Embraer Phenom 300
C510 bj 12.4 13.2 Cessna Citation Mustang|C525 bj 13 14.3 Cessna CitationJet|C25A bj 13 14.4 Cessna Citation CJ2|C25B bj 14.5 15.9 Cessna Citation CJ3
C25C bj 16.3 16.3 Cessna Citation CJ4|C550 bj 14.4 15.9 Cessna Citation II|C560 bj 14.9 16.5 Cessna Citation V|C56X bj 15.8 17.2 Cessna Citation Excel
C680 bj 19.4 19.3 Cessna Citation Sovereign|C68A bj 19.4 22 Cessna Citation Latitude|C700 bj 21.3 21 Cessna Citation Longitude|C750 bj 22 19.4 Cessna Citation X
E545 bj 19.7 20.3 Embraer Legacy 450|E550 bj 20.7 20.2 Embraer Praetor 600|LJ35 bj 14.8 12 Learjet 35|LJ45 bj 17.7 14.6 Learjet 45|LJ60 bj 17.9 13.4 Learjet 60
LJ75 bj 17.7 15.5 Learjet 75|BE40 bj 14.8 13.3 Beechjet 400|H25B bj 15.6 15.7 Hawker 800|CL30 bj 20.9 19.5 Bombardier Challenger 300|CL35 bj 20.9 19.5 Bombardier Challenger 350
CL60 bj 20.9 19.6 Bombardier Challenger 600|GL5T bj 29.5 28.7 Bombardier Global 5000|GLEX bj 30.3 28.7 Bombardier Global Express|GL7T bj 33.8 31.7 Bombardier Global 7500
G280 bj 20.3 19.2 Gulfstream G280|GLF4 bj 26.9 23.7 Gulfstream IV|GLF5 bj 29.4 28.5 Gulfstream V|GLF6 bj 30.4 30.4 Gulfstream G650|GA6C bj 30.4 30.4 Gulfstream G600
F2TH bj 20.2 19.3 Dassault Falcon 2000|FA50 bj 18.5 18.9 Dassault Falcon 50|FA7X bj 23.2 26.2 Dassault Falcon 7X|FA8X bj 24.5 26.3 Dassault Falcon 8X|PC24 bj 16.9 17 Pilatus PC-24
CRJ2 rj 26.8 21.2 Bombardier CRJ200|CRJ7 rj 32.5 23.2 Bombardier CRJ700|CRJ9 rj 36.2 24.9 Bombardier CRJ900|E135 rj 26.3 20 Embraer ERJ 135|E145 rj 29.9 20 Embraer ERJ 145
E45X rj 29.9 20 Embraer ERJ 145XR|B712 rj 37.8 28.5 Boeing 717|MD82 rj 45.1 32.8 McDonnell Douglas MD-82|MD83 rj 45.1 32.8 McDonnell Douglas MD-83|MD88 rj 45.1 32.8 McDonnell Douglas MD-88
E170 nb 29.9 26 Embraer 170|E75S nb 31.7 26 Embraer 175|E75L nb 31.7 28.7 Embraer 175|E190 nb 36.2 28.7 Embraer 190|E195 nb 38.7 28.7 Embraer 195|E290 nb 36.2 33.7 Embraer E190-E2
BCS1 nb 35 35.1 Airbus A220-100|BCS3 nb 38.7 35.1 Airbus A220-300|B736 nb 31.2 34.3 Boeing 737-600|B737 nb 33.6 35.8 Boeing 737-700|B738 nb 39.5 35.8 Boeing 737-800
B739 nb 42.1 35.8 Boeing 737-900|B37M nb 35.6 35.9 Boeing 737 MAX 7|B38M nb 39.5 35.9 Boeing 737 MAX 8|B39M nb 42.2 35.9 Boeing 737 MAX 9|B3XM nb 43.8 35.9 Boeing 737 MAX 10
A318 nb 31.4 34.1 Airbus A318|A319 nb 33.8 35.8 Airbus A319|A320 nb 37.6 35.8 Airbus A320|A321 nb 44.5 35.8 Airbus A321|A19N nb 33.8 35.8 Airbus A319neo
A20N nb 37.6 35.8 Airbus A320neo|A21N nb 44.5 35.8 Airbus A321neo|B752 nb 47.3 38.1 Boeing 757-200|B753 nb 54.4 38.1 Boeing 757-300|B762 wb 48.5 47.6 Boeing 767-200
B763 wb 54.9 47.6 Boeing 767-300|B764 wb 61.4 51.9 Boeing 767-400|B772 wb 63.7 60.9 Boeing 777-200|B77L wb 63.7 64.8 Boeing 777-200LR|B77W wb 73.9 64.8 Boeing 777-300ER
B788 wb 56.7 60.1 Boeing 787-8|B789 wb 62.8 60.1 Boeing 787-9|B78X wb 68.3 60.1 Boeing 787-10|A306 wb 54.1 44.8 Airbus A300|A310 wb 46.7 43.9 Airbus A310
A332 wb 58.8 60.3 Airbus A330-200|A333 wb 63.7 60.3 Airbus A330-300|A339 wb 63.7 64 Airbus A330-900|A359 wb 66.8 64.8 Airbus A350-900|A35K wb 73.8 64.8 Airbus A350-1000
MD11 wb 61.2 51.7 McDonnell Douglas MD-11|B744 q4 70.7 64.4 Boeing 747-400|B748 q4 76.3 68.4 Boeing 747-8|A388 q4 72.7 79.8 Airbus A380|K35R q4 41.5 39.9 Boeing KC-135
C17 hq 53 51.8 Boeing C-17 Globemaster III|C130 hqp 29.8 40.4 Lockheed C-130 Hercules|C30J hqp 34.4 40.4 Lockheed C-130J Hercules
R22 heli 6.3 7.7 Robinson R22|R44 heli 8.9 10.1 Robinson R44|R66 heli 9 10.1 Robinson R66|B06 heli 9.5 10.2 Bell 206 JetRanger|B407 heli 10.6 10.7 Bell 407|B429 heli 11 11 Bell 429
B412 heli 12.9 14 Bell 412|B505 heli 9.6 11.3 Bell 505|EC20 heli 9.2 10.2 Airbus H120|EC30 heli 10.9 10.7 Airbus H130|AS50 heli 10.9 10.7 Airbus AS350|EC35 heli 10.2 10.2 Airbus H135
EC45 heli 11.6 11 Airbus H145|EC55 heli 12.6 12.6 Airbus H155|A109 heli 11.4 11 Leonardo AW109|A119 heli 11.1 10.8 Leonardo AW119|A139 heli 13.8 13.8 Leonardo AW139
A169 heli 12.5 12.1 Leonardo AW169|S76 heli 13.2 13.4 Sikorsky S-76|H60 heli 15.3 16.4 Sikorsky UH-60 Black Hawk|H500 heli 7.6 8 MD 500|EXPL heli 9.9 10.3 MD Explorer`;
const TYPES = new Map();
for (const row of TYPE_TABLE.split(/[|\n]/)) {
  const m = /^\s*(\w+) (\w+) ([\d.]+) ([\d.]+) (.+?)\s*$/.exec(row);
  if (m) TYPES.set(m[1], { kind: m[2], L: +m[3], S: +m[4], name: m[5] });
}
// by ADS-B emitter category, when the type is unknown
const BY_CAT = {
  A1: { kind: "lw", L: 8.4, S: 11, label: "light aircraft" }, A2: { kind: "bj", L: 17, S: 17, label: "small aircraft" },
  A3: { kind: "nb", L: 36, S: 34, label: "airliner" }, A4: { kind: "nb", L: 47, S: 38, label: "large jet" },
  A5: { kind: "wb", L: 64, S: 61, label: "heavy jet" }, A6: { kind: "bj", L: 15, S: 10, label: "high-performance jet" },
  A7: { kind: "heli", L: 11, S: 11, label: "helicopter" }, B1: { kind: "gl", L: 7, S: 16, label: "glider" },
  B2: { kind: "bl", L: 18, S: 18, label: "balloon" }, B4: { kind: "hw", L: 6, S: 9, label: "ultralight" },
  B6: { kind: "lw", L: 3, S: 4, label: "drone" },
};
const CAT_LABEL = { lw: "light aircraft", hw: "light aircraft", tw: "light twin", tt: "turboprop", hp: "turboprop airliner", bj: "business jet", rj: "regional jet", nb: "airliner", wb: "widebody jet", q4: "four-engine jet", hq: "military transport", hqp: "military transport", heli: "helicopter", gl: "glider", bl: "balloon" };

// airline / operator by the callsign's ICAO prefix → [name, livery]
const OPERATORS = {
  AAL: ["American Airlines", "aa"], ENY: ["Envoy, as American Eagle", "aa"], JIA: ["PSA, as American Eagle", "aa"], PDT: ["Piedmont, as American Eagle", "aa"],
  RPA: ["Republic Airways", "jet"], DAL: ["Delta Air Lines", "dl"], EDV: ["Endeavor, as Delta Connection", "dl"], UAL: ["United Airlines", "ua"],
  GJS: ["GoJet, as United Express", "ua"], ASH: ["Mesa, as United Express", "ua"], SKW: ["SkyWest Airlines", "jet"], SWA: ["Southwest Airlines", "wn"],
  FDX: ["FedEx", "fx"], UPS: ["UPS Airlines", "ups"], NKS: ["Spirit Airlines", "nk"], JBU: ["JetBlue", "b6"], AAY: ["Allegiant Air", "g4"],
  FFT: ["Frontier Airlines", "f9"], ASA: ["Alaska Airlines", "as"], QXE: ["Horizon Air", "as"], MXY: ["Breeze Airways", "mx"], EJA: ["NetJets", "nj"],
  LXJ: ["Flexjet", "dark"], WUP: ["Wheels Up", "navy"], CKS: ["Kalitta Air", "jet"], ABX: ["ABX Air", "jet"], ATN: ["Air Transport International", "jet"],
  GTI: ["Atlas Air", "jet"], AMF: ["Ameriflight", "jet"], RCH: ["U.S. Air Force", "mil"], CNV: ["U.S. Navy", "mil"], PAT: ["U.S. Army", "mil"],
  OSU: ["Ohio State flight education", "osu"],
};
// [body, side (belly and cheatline), tail, wing, engine]
const LIVERIES = {
  jet: ["#f2f0eb", "#c9ccd2", "#7d8a9c", "#cfd2d6", "#b7bbc1"], aa: ["#dde1e6", "#b9c0c9", "#2e5aa0", "#c8ccd1", "#c4c9cf"],
  dl: ["#f4f3f0", "#1d2f57", "#b5203a", "#c9cbcf", "#1d2f57"], ua: ["#f4f3f0", "#2a4a9a", "#1c3570", "#c9cbcf", "#2a4a9a"],
  wn: ["#3352b5", "#d2362b", "#3352b5", "#c9cbcf", "#e9b83a"], fx: ["#f4f3f0", "#c9ccd2", "#4d1f8c", "#c9cbcf", "#e87722"],
  ups: ["#5b4334", "#4a3529", "#4a3529", "#b7a68e", "#5b4334"], nk: ["#f0cf2a", "#d9b91c", "#f0cf2a", "#c9cbcf", "#3a3a3a"],
  b6: ["#f4f3f0", "#2a4fa0", "#1b2f6b", "#c9cbcf", "#2a4fa0"], g4: ["#f4f3f0", "#c9ccd2", "#e88a2a", "#c9cbcf", "#f4f3f0"],
  f9: ["#f4f3f0", "#2f7a4a", "#2f7a4a", "#c9cbcf", "#f4f3f0"], as: ["#f4f3f0", "#c9ccd2", "#173a63", "#c9cbcf", "#f4f3f0"],
  mx: ["#f4f3f0", "#c9ccd2", "#1f3d8a", "#c9cbcf", "#f4f3f0"], nj: ["#f4f3f0", "#8f99a3", "#f4f3f0", "#d0d2d5", "#c5c9cd"],
  dark: ["#f2f0eb", "#3a3a3a", "#2b2b2b", "#d0d2d5", "#3a3a3a"], navy: ["#f2f0eb", "#1f3560", "#1f3560", "#d0d2d5", "#c5c9cd"],
  mil: ["#8d969c", "#79828a", "#8d969c", "#8a939a", "#6f777e"], osu: ["#f6f4ef", "#b3202a", "#b3202a", "#efede8", "#d8d6d0"],
  med: ["#c8202d", "#a51a25", "#f2efe8", "#c8202d", "#3a3a3a"],
};
const GA_ACCENTS = ["#2f5d8a", "#a8322d", "#3d7a4a", "#c08a2b", "#5b3a6e", "#2b2b2b", "#1f6f8b"];
const HELI_BODIES = ["#2f5d8a", "#c8202d", "#3a3a3a", "#e9e5dc", "#d9a62b", "#2f6b47"];
const MEDICAL = /^(MED|LIFE|CARE|MFLT|AIRMED|STAT|MERCY|EVAC)/;

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function titleCase(s) {
  return String(s).toLowerCase().replace(/\b[a-z][a-z']*/g, (w) => w[0].toUpperCase() + w.slice(1))
    .replace(/\b([A-Za-z]*\d[\w-]*)\b/g, (w) => w.toUpperCase()).replace(/\b(Ii|Iii|Iv)\b/g, (w) => w.toUpperCase());
}

/** Everything about an aircraft that comes from what it is (not where it is) */
function identify(d) {
  const t = d.type && TYPES.get(d.type);
  const cat = d.cat && BY_CAT[d.cat];
  const desc = d.desc ? titleCase(d.desc) : null;
  let spec = t || (desc && /copter|heli|robinson|sikorsky|agusta|bell 2|bell 4|bell 5/i.test(desc) ? BY_CAT.A7 : null) || cat || BY_CAT.A1;
  const fl = (d.flight || "").toUpperCase();
  const pre = /^([A-Z]{3})\d/.exec(fl);
  const op = pre && OPERATORS[pre[1]] || null;
  const heli = spec.kind === "heli";
  const medical = MEDICAL.test(fl) || (heli && /^N\d+(MF|ME|MD)$/.test(fl));
  const hh = hash(d.hex || fl || "x");
  let livery;
  if (medical) livery = LIVERIES.med;
  else if (op) livery = LIVERIES[op[1]];
  else if (/^(hw|lw|tw|tt|gl)$/.test(spec.kind)) { const a = GA_ACCENTS[hh % GA_ACCENTS.length]; livery = ["#f4f2ec", a, a, "#ecebe6", "#d5d3cc"]; }
  else if (heli) { const b = HELI_BODIES[hh % HELI_BODIES.length]; livery = [b, b, b, b, "#3a3a3a"]; }
  else livery = LIVERIES.jet;
  const name = t ? t.name : desc || (d.type ? d.type : null);
  const label = spec.label || CAT_LABEL[spec.kind] || "aircraft";
  return { spec, kind: spec.kind, heli, medical, op: op ? op[0] : null, osu: !!(op && op[1] === "osu"), livery, name, label, phase: (hh % 1000) / 1000 };
}

// ------------------------------------------------------------------------------------------------ shapes
// Built once per (kind, length, span) as Path2Ds in the aircraft's own frame: u forward (nose +), v to the right wing,
// w up, all metres. A part lies in one plane — "h" horizontal at height w, "v" the fin's plane (u, w) at v, "d" a
// prop or rotor disc (v, w) at u — and is drawn with one affine transform, so a model costs a dozen fills.
const KINDS = {   // (a little chunkier than life: a model read at 20 px must still say "aeroplane")
  hw: { wing: "high", eng: "nose", tail: "low", fw: 0.155, wLE: 0.14, wC: 0.21, wT: 0.17, sw: 0.02, fin: 0.17, pr: 0.115 },
  lw: { wing: "low", eng: "nose", tail: "low", fw: 0.155, wLE: 0.13, wC: 0.23, wT: 0.14, sw: 0.04, fin: 0.16, pr: 0.115 },
  tw: { wing: "low", eng: "wing2p", tail: "low", fw: 0.14, wLE: 0.11, wC: 0.22, wT: 0.13, sw: 0.04, fin: 0.17, pr: 0.1, ev: 0.3 },
  tt: { wing: "low", eng: "wing2p", tail: "T", fw: 0.13, wLE: 0.09, wC: 0.2, wT: 0.1, sw: 0.05, fin: 0.17, pr: 0.09, ev: 0.3 },
  hp: { wing: "high", eng: "wing2p", tail: "T", fw: 0.115, wLE: 0.08, wC: 0.12, wT: 0.07, sw: 0.03, fin: 0.17, pr: 0.068, ev: 0.3 },
  hq: { wing: "high", eng: "wing4", tail: "T", fw: 0.135, wLE: 0.09, wC: 0.18, wT: 0.07, sw: 0.25, fin: 0.2 },
  hqp: { wing: "high", eng: "wing4p", tail: "low", fw: 0.15, wLE: 0.13, wC: 0.17, wT: 0.09, sw: 0.04, fin: 0.25, pr: 0.068 },
  bj: { wing: "low", eng: "rear2", tail: "T", fw: 0.135, wLE: 0.01, wC: 0.23, wT: 0.08, sw: 0.32, fin: 0.2 },
  rj: { wing: "low", eng: "rear2", tail: "T", fw: 0.12, wLE: 0.03, wC: 0.23, wT: 0.07, sw: 0.4, fin: 0.2 },
  nb: { wing: "low", eng: "wing2", tail: "low", fw: 0.125, wLE: 0.09, wC: 0.24, wT: 0.065, sw: 0.45, fin: 0.18, ev: 0.32 },
  wb: { wing: "low", eng: "wing2", tail: "low", fw: 0.115, wLE: 0.11, wC: 0.25, wT: 0.055, sw: 0.5, fin: 0.17, ev: 0.33 },
  q4: { wing: "low", eng: "wing4", tail: "low", fw: 0.11, wLE: 0.11, wC: 0.25, wT: 0.055, sw: 0.55, fin: 0.17 },
  gl: { wing: "high", eng: "none", tail: "T", fw: 0.1, wLE: 0.08, wC: 0.11, wT: 0.07, sw: 0.01, fin: 0.17 },
};

/** add a polygon (flat [u, v, …]) to a path, wound counter-clockwise so overlapping polygons fill as a union */
function poly(path, pts) {
  const n = pts.length / 2;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += pts[j * 2] * pts[i * 2 + 1] - pts[i * 2] * pts[j * 2 + 1];
  const at = (i) => (a < 0 ? n - 1 - i : i);
  path.moveTo(pts[at(0) * 2], pts[at(0) * 2 + 1]);
  for (let i = 1; i < n; i++) path.lineTo(pts[at(i) * 2], pts[at(i) * 2 + 1]);
  path.closePath();
}
/** a symmetric outline from its right half ([[u, v]…] nose to tail, v ≥ 0) */
function mirror(right) {
  const out = [];
  for (const [u, v] of right) out.push(u, v);
  for (let i = right.length - 1; i >= 0; i--) if (right[i][1] > 0) out.push(right[i][0], -right[i][1]);
  return out;
}
const flipV = (pts) => pts.map((x, i) => (i % 2 ? -x : x));
function circle(path, cu, cv, r, n = 20) {
  const pts = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts.push(cu + Math.cos(a) * r, cv + Math.sin(a) * r); }
  poly(path, pts);
}

const shapeCache = new Map();
function shapeFor(spec) {
  const key = `${spec.kind}|${spec.L}|${spec.S}`;
  let sh = shapeCache.get(key);
  if (!sh) { sh = spec.kind === "heli" ? buildHeli(spec.L, spec.S) : spec.kind === "bl" ? buildBalloon(spec.L) : buildFixed(KINDS[spec.kind] || KINDS.lw, spec.L, spec.S); shapeCache.set(key, sh); }
  return sh;
}

function newShape(len) { return { parts: [], shadow: new Path2D(), outline: new Path2D(), disc: null, len, lights: {}, rotor: null }; }
function part(sh, plane, fill, pts, o = {}) {
  const path = new Path2D();
  if (Array.isArray(pts[0])) for (const p of pts) poly(path, p); else poly(path, pts);
  sh.parts.push({ plane, fill, path, u: o.u || 0, v: o.v || 0, w: o.w || 0, hl: !!o.hl });
  // the shadow is the union of the parts flagged; the outline the same, less parts far above or below the body
  for (const target of o.shadow ? (o.offBody ? [sh.shadow] : [sh.shadow, sh.outline]) : []) {
    if (Array.isArray(pts[0])) for (const p of pts) poly(target, p); else poly(target, pts);
  }
}

function buildFixed(K, L, S) {
  const sh = newShape(Math.max(L, S));
  const h = L / 2, fw = Math.max(0.9, L * K.fw), r = fw / 2, half = S / 2;
  const jet = /^(wing2|wing4|rear2)$/.test(K.eng);
  const fus = jet
    ? mirror([[h, 0], [h - 0.025 * L, 0.62 * r], [h - 0.06 * L, 0.92 * r], [h - 0.11 * L, r], [-h + 0.24 * L, r], [-h + 0.1 * L, 0.62 * r], [-h + 0.015 * L, 0.22 * r], [-h, 0.08 * r]])
    : mirror([[h, 0], [h - 0.012 * L, 0.5 * r], [h - 0.05 * L, 0.85 * r], [h - 0.16 * L, r], [-0.08 * L, 0.95 * r], [-h + 0.06 * L, 0.3 * r], [-h, 0.22 * r]]);
  const wr = r * 0.85;
  const rootLE = K.wLE * L, rootTE = rootLE - K.wC * L, tipLE = rootLE - K.sw * (half - wr), tipTE = tipLE - K.wT * L;
  const wingR = [rootLE, wr, tipLE, half, tipTE, half, rootTE, wr];
  const wings = [wingR, flipV(wingR)];
  const uLE = (v) => rootLE + (tipLE - rootLE) * (Math.abs(v) - wr) / Math.max(0.1, half - wr);
  const wingW = K.wing === "high" ? r * 0.95 : -r * 0.55;
  // fin (u, w) and the horizontal stabiliser
  const finW0 = 0.3 * fw, finTop = finW0 + K.fin * L;
  const finBF = -h + (jet ? 0.22 : 0.2) * L, finTF = -h + (jet ? 0.07 : 0.09) * L, finTR = -h - (jet ? 0.01 : 0) * L;
  const finPts = [finBF, finW0, -h + 0.01 * L, finW0, finTR, finTop, finTF, finTop];
  const T = K.tail === "T";
  const sHalf = (jet ? 0.19 : 0.16) * S * (T ? 0.8 : 1), sC = (jet ? 0.1 : 0.11) * L;
  const sLE = T ? finTF + 0.01 * L : -h + (jet ? 0.15 : 0.14) * L;
  const sSw = jet ? 0.5 * sHalf : 0.06 * sHalf;
  const stabR = [sLE, 0, sLE - sSw, sHalf, sLE - sSw - sC * 0.55, sHalf, sLE - sC, 0];
  const stab = [stabR, flipV(stabR)];
  const glass = jet
    ? mirror([[h - 0.03 * L, 0], [h - 0.04 * L, 0.55 * r], [h - 0.065 * L, 0.85 * r], [h - 0.075 * L, 0.8 * r], [h - 0.065 * L, 0]])
    : mirror([[h - 0.17 * L, 0], [h - 0.185 * L, 0.7 * r], [h - 0.25 * L, 0.86 * r], [h - 0.27 * L, 0]]);
  const hi = mirror([[h - 0.09 * L, 0], [h - 0.13 * L, 0.3 * r], [-h + 0.26 * L, 0.3 * r], [-h + 0.16 * L, 0]]);
  // engines
  const pods = [], props = [];
  const pod = (v, len, ew, fwd) => { const u0 = uLE(v) + fwd * len, u1 = u0 - len, e = ew / 2; return [u0, v - e * 0.8, u0 - 0.12 * len, v - e, u1, v - e * 0.7, u1, v + e * 0.7, u0 - 0.12 * len, v + e, u0, v + e * 0.8]; };
  if (K.eng === "wing2") { const v = K.ev * half, len = (L > 50 ? 0.1 : 0.12) * L, ew = (L > 50 ? 0.05 : 0.056) * L; pods.push(pod(v, len, ew, 0.6), pod(-v, len, ew, 0.6)); }
  if (K.eng === "wing4") for (const f of [0.36, 0.64]) { const v = f * half, len = 0.085 * L, ew = 0.04 * L; pods.push(pod(v, len, ew, 0.55), pod(-v, len, ew, 0.55)); }
  if (K.eng === "wing2p" || K.eng === "wing4p") {
    for (const f of K.eng === "wing2p" ? [K.ev] : [0.3, 0.6]) {
      for (const sg of [1, -1]) { const v = sg * f * half, len = 0.3 * L * (K.eng === "wing4p" ? 0.6 : 1), ew = 0.085 * L * (K.eng === "wing4p" ? 0.6 : 1); pods.push(pod(v, len, ew, 0.55)); props.push([uLE(v) + 0.55 * len + 0.01 * L, v, wingW + (K.wing === "high" ? -0.25 : 0.15) * r, K.pr * L]); }
    }
  }
  if (K.eng === "nose") props.push([h + 0.01 * L, 0, 0, K.pr * L]);
  const rear = [];
  if (K.eng === "rear2") { const ew = (L > 30 ? 0.065 : 0.075) * L, v = r + 0.62 * ew, u0 = -h + 0.38 * L, u1 = -h + 0.2 * L, e = ew / 2; for (const sg of [1, -1]) rear.push([u0, sg * v - e * 0.85, u0 - 0.05 * L, sg * v - e, u1, sg * v - e * 0.7, u1, sg * v + e * 0.7, u0 - 0.05 * L, sg * v + e, u0, sg * v + e * 0.85]); }

  // draw order: far below → near above (the camera looks down from 30°)
  if (!T) part(sh, "h", "wing", stab, { w: 0.15 * fw, shadow: true });
  part(sh, "h", "side", fus, { w: -0.55 * fw });
  if (pods.length && K.wing === "low" && K.eng !== "wing2p") part(sh, "h", "engine", pods, { w: wingW - 0.7 * r, shadow: true });
  if (K.wing === "low") part(sh, "h", "wing", wings, { w: wingW, shadow: true });
  if (pods.length && K.wing === "low" && K.eng === "wing2p") part(sh, "h", "body", pods, { w: wingW + 0.4 * r, shadow: true });
  part(sh, "h", "body", fus, { shadow: true });
  part(sh, "h", "hi", hi, { w: 0.02, hl: true });
  part(sh, "h", "glass", glass, { w: 0.03 });
  if (rear.length) part(sh, "h", "engine", rear, { w: 0.2 * fw, shadow: true });
  part(sh, "v", "tail", finPts);
  if (T) part(sh, "h", "wing", stab, { w: finTop, shadow: true, offBody: true });
  if (K.wing === "high") {
    if (pods.length) part(sh, "h", "engine", pods, { w: wingW - 0.5 * r, shadow: true });
    part(sh, "h", "wing", wings, { w: wingW, shadow: true });
  }
  sh.props = props;   // [u, v, w, radius]
  const tipU = (tipLE + tipTE) / 2;
  sh.lights = {
    nav: [[tipU, -half, wingW], [tipU, half, wingW]],
    tail: [-h, 0, 0.35 * fw],
    bcn: jet ? [-0.05 * L, 0, r * 1.05] : [finTF - 0.01 * L, 0, finTop],
    land: [h - 0.12 * L, 0, -0.45 * fw],
  };
  return sh;
}

function buildHeli(L, D) {
  const sh = newShape(Math.max(L, D));
  const cw = 0.1 * L;   // the cabin's half width (a little wider than life)
  const cabin = mirror([[0.38 * L, 0], [0.36 * L, 0.42 * cw], [0.3 * L, 0.78 * cw], [0.17 * L, cw], [0, 0.95 * cw], [-0.12 * L, 0.7 * cw], [-0.19 * L, 0.32 * cw]]);
  const boomPts = [-0.15 * L, 0.24 * cw, -0.6 * L, 0.13 * cw, -0.6 * L, -0.13 * cw, -0.15 * L, -0.24 * cw];
  const stabR = [-0.45 * L, 0, -0.46 * L, 0.13 * L, -0.5 * L, 0.13 * L, -0.5 * L, 0];
  const glass = mirror([[0.38 * L, 0], [0.36 * L, 0.42 * cw], [0.3 * L, 0.78 * cw], [0.2 * L, 0.9 * cw], [0.18 * L, 0]]);
  const skid = (sg) => [0.24 * L, sg * 0.12 * L - 0.012 * L, 0.24 * L, sg * 0.12 * L + 0.012 * L, -0.2 * L, sg * 0.12 * L + 0.012 * L, -0.2 * L, sg * 0.12 * L - 0.012 * L];
  const cross = (u) => [u + 0.012 * L, -0.12 * L, u + 0.012 * L, 0.12 * L, u - 0.012 * L, 0.12 * L, u - 0.012 * L, -0.12 * L];
  const finPts = [-0.53 * L, 0, -0.61 * L, 0, -0.65 * L, 0.17 * L, -0.6 * L, 0.17 * L];
  const hi = mirror([[0.3 * L, 0], [0.26 * L, 0.3 * cw], [-0.08 * L, 0.3 * cw], [-0.14 * L, 0]]);
  part(sh, "h", "dark", [skid(1), skid(-1), cross(0.14 * L), cross(-0.1 * L)], { w: -0.17 * L, shadow: true, offBody: true });
  part(sh, "h", "side", cabin, { w: -0.1 * L });
  part(sh, "h", "body", boomPts, { w: 0.02 * L, shadow: true });
  part(sh, "h", "tail", [stabR, flipV(stabR)], { w: 0.03 * L, shadow: true });
  part(sh, "h", "body", cabin, { shadow: true });
  part(sh, "h", "hi", hi, { w: 0.01, hl: true });
  part(sh, "h", "glass", glass, { w: 0.01 });
  part(sh, "v", "tail", finPts);
  sh.tailRotor = [-0.6 * L, 0.05 * L, 0.1 * L, 0.075 * L];   // u, v, w, radius (in the fin's plane)
  sh.rotor = { w: 0.13 * L, r: D / 2, blades: 4 };
  const disc = new Path2D(); circle(disc, 0, 0, D / 2, 28); sh.disc = disc;
  const blade = new Path2D(); poly(blade, [0, -0.025 * D, D / 2, -0.03 * D, D / 2, 0.03 * D, 0, 0.025 * D]); sh.blade = blade;
  sh.lights = { nav: [[-0.475 * L, -0.13 * L, 0.03 * L], [-0.475 * L, 0.13 * L, 0.03 * L]], tail: [-0.64 * L, 0, 0.12 * L], bcn: [-0.62 * L, 0, 0.17 * L], land: [0.3 * L, 0, -0.1 * L] };
  return sh;
}

function buildBalloon(D) {
  const sh = newShape(D);
  const env = new Path2D(); circle(env, 0, 0, D / 2, 24);
  const basket = [0.9, 0.9, -0.9, 0.9, -0.9, -0.9, 0.9, -0.9];
  part(sh, "h", "dark", basket, { w: -0.6 * D, shadow: true, offBody: true });
  sh.parts.push({ plane: "h", fill: "side", path: env, u: 0, v: 0, w: -0.08 * D, hl: false });
  sh.parts.push({ plane: "h", fill: "body", path: env, u: 0, v: 0, w: 0, hl: false });
  const ring = Array.from({ length: 24 }, (_, i) => [Math.cos((i / 24) * Math.PI * 2) * D / 2, Math.sin((i / 24) * Math.PI * 2) * D / 2]).flat();
  poly(sh.shadow, ring); poly(sh.outline, ring);
  part(sh, "h", "tail", mirror([[D * 0.42, 0], [D * 0.3, D * 0.3], [0, D * 0.12], [-D * 0.3, D * 0.3], [-D * 0.42, 0]]), { w: 0.02 });
  sh.lights = { nav: [], tail: null, bcn: null, land: null };
  return sh;
}

// ------------------------------------------------------------------------------------------------ colour
const rgbCache = new Map();
function rgbOf(hex) {
  let c = rgbCache.get(hex);
  if (!c) { const n = parseInt(hex.slice(1), 16); c = [(n >> 16) & 255, (n >> 8) & 255, n & 255]; rgbCache.set(hex, c); }
  return c;
}
// the night tint for what is drawn above the atmosphere's (gentler than the map's: aircraft catch the city's glow)
const NIGHT_MUL = [0.5, 0.54, 0.72];
function paint(hex, f, mul, hz, sky) {
  const c = rgbOf(hex);
  const r = lerp(Math.min(255, c[0] * f) * mul[0], sky[0], hz), g = lerp(Math.min(255, c[1] * f) * mul[1], sky[1], hz), b = lerp(Math.min(255, c[2] * f) * mul[2], sky[2], hz);
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function glowSprite(r, g, b) {
  const c = document.createElement("canvas");
  c.width = c.height = 48;
  const x = c.getContext("2d");
  const gr = x.createRadialGradient(24, 24, 0, 24, 24, 24);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(0.1, `rgba(${r},${g},${b},0.95)`);
  gr.addColorStop(0.3, `rgba(${r},${g},${b},0.38)`);
  gr.addColorStop(0.6, `rgba(${r},${g},${b},0.1)`);
  gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
  x.fillStyle = gr;
  x.fillRect(0, 0, 48, 48);
  return c;
}

// ------------------------------------------------------------------------------------------------ the module
export function init(app) {
  const { geo, view, data } = app;
  const mode = (app.params.get("planes") || "").toLowerCase();
  const MOCK = mode === "mock";
  const API = mode === "404" ? "api/planes-missing" : "api/planes";
  const UI = () => app.ui || null;
  const kick = () => { if (app.requestRender) app.requestRender(); };
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const world = data.world;

  /** @type {Map<string, any>} hex → aircraft */
  const planes = new Map();
  const feed = { state: MOCK ? "mock" : "loading", source: MOCK ? "mock" : null, updated: null, fails: 0 };
  let areaQnh = null;            // hPa, from aircraft that broadcast their altimeter setting
  let sel = null, cardH = null, cardRefs = null, hoverHex = null;
  let want = 0, inView = -1, lastCount = null;
  const low = [], high = [], shadows = [];
  const tmp = { x: 0, y: 0, h: 0, alt: 0 };
  const sprites = { red: glowSprite(255, 70, 60), green: glowSprite(70, 255, 130), white: glowSprite(255, 250, 235) };

  // ---------------------------------------------------------------- where things are
  const outside = (x, y) => Math.max(world.x0 - x, x - world.x1, world.y0 - y, y - world.y1, 0);
  const insideBy = (x, y) => Math.min(x - world.x0, world.x1 - x, y - world.y0, world.y1 - y);

  // rooftops: a grid of building indices, built the first time a low aircraft needs one
  let grid = null;
  const CELL = 80;
  function buildGrid() {
    const nx = Math.ceil((world.x1 - world.x0) / CELL), ny = Math.ceil((world.y1 - world.y0) / CELL);
    const cells = Array.from({ length: nx * ny }, () => []);
    const box = new Float32Array(data.buildings.length * 4);
    data.buildings.forEach((b, i) => {
      if (!b || !(b.h > 2) || !b.p || !b.p[0]) return;
      const ring = b.p[0];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < ring.length; k += 2) { x0 = Math.min(x0, ring[k]); x1 = Math.max(x1, ring[k]); y0 = Math.min(y0, ring[k + 1]); y1 = Math.max(y1, ring[k + 1]); }
      box.set([x0, y0, x1, y1], i * 4);
      const cx0 = clamp(Math.floor((x0 - world.x0) / CELL), 0, nx - 1), cx1 = clamp(Math.floor((x1 - world.x0) / CELL), 0, nx - 1);
      const cy0 = clamp(Math.floor((y0 - world.y0) / CELL), 0, ny - 1), cy1 = clamp(Math.floor((y1 - world.y0) / CELL), 0, ny - 1);
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) cells[cy * nx + cx].push(i);
    });
    grid = { nx, ny, cells, box };
  }
  /** the highest roof (m) over ground point (x, y), 0 if none */
  function roofAt(x, y) {
    if (outside(x, y) > 0) return 0;
    if (!grid) buildGrid();
    const cx = Math.floor((x - world.x0) / CELL), cy = Math.floor((y - world.y0) / CELL);
    if (cx < 0 || cy < 0 || cx >= grid.nx || cy >= grid.ny) return 0;
    let best = 0;
    for (const i of grid.cells[cy * grid.nx + cx]) {
      const b = data.buildings[i], o = i * 4;
      if (b.h <= best || x < grid.box[o] || x > grid.box[o + 2] || y < grid.box[o + 1] || y > grid.box[o + 3]) continue;
      if (app.scene.contains(i, x, y)) best = b.h;
    }
    return best;
  }
  function roofUnder(P) {
    if (!(Math.abs(P.x - P.roofX) <= 3 && Math.abs(P.y - P.roofY) <= 3)) { P.roof = roofAt(P.x, P.y); P.roofX = P.x; P.roofY = P.y; }
    return P.roof;
  }

  // ---------------------------------------------------------------- reports → motion
  function predict(P, t, out) {
    const dt = clamp(t - P.rt, 0, 90);
    const dtt = Math.min(dt, 25);   // a turn is believed for 25 s, then it flies straight
    const h0 = P.h0, om = P.om;
    let x, y;
    if (Math.abs(om) > 0.05) {
      const R = P.v / (om * RAD), a0 = h0 * RAD, a1 = (h0 + om * dtt) * RAD;
      x = P.rx + R * (Math.cos(a0) - Math.cos(a1));
      y = P.ry + R * (Math.sin(a1) - Math.sin(a0));
    } else { x = P.rx + P.v * Math.sin(h0 * RAD) * dtt; y = P.ry + P.v * Math.cos(h0 * RAD) * dtt; }
    const h = h0 + om * dtt, rest = dt - dtt;
    if (rest > 0) { x += P.v * Math.sin(h * RAD) * rest; y += P.v * Math.cos(h * RAD) * rest; }
    out.x = x; out.y = y; out.h = wrap360(h);
    out.alt = P.alt0 == null ? null : Math.max(-200, P.alt0 + (P.vr / 60) * Math.min(dt, 20));
    return out;
  }
  const qnhFix = (ft) => (areaQnh && ft < 18000 ? (areaQnh - 1013.25) * 27.3 : 0);

  function ingest(body, tNow) {
    const skew = MOCK ? 0 : clamp(Date.now() / 1000 - (+body.now || Date.now() / 1000), 0, 10);
    // the area's altimeter setting, from low aircraft that broadcast theirs
    const q = body.aircraft.filter((a) => a && fin(a.qnh) && fin(a.alt) && a.alt < 15000 && a.qnh > 940 && a.qnh < 1070).map((a) => a.qnh).sort((a, b) => a - b);
    if (q.length) areaQnh = q[q.length >> 1];
    const present = new Set();
    for (const a of body.aircraft) {
      if (!a || typeof a.hex !== "string" || !fin(a.lat) || !fin(a.lon)) continue;
      const [x, y] = geo.toXY(a.lat, a.lon);
      if (outside(x, y) > KEEP_M) continue;
      const ground = a.ground === true || (a.alt == null && !fin(a.alt));
      if (ground && outside(x, y) > 0) continue;   // taxiing at an airport off the map
      const age = clamp((+a.seen || 0) + skew, 0, 120);
      if (age > 60) continue;
      present.add(a.hex);
      let P = planes.get(a.hex);
      const tFix = tNow - age;
      const gs = fin(a.gs) ? a.gs : 0;
      let trk = fin(a.track) ? a.track : fin(a.hdg) ? a.hdg : null;
      if (gs < 25 && fin(a.hdg)) trk = a.hdg;   // hovering or taxiing: the nose, not the drift
      const altFt = ground ? null : fin(a.alt) ? a.alt : null;
      if (!P) {
        const id = identify(a);
        P = {
          hex: a.hex, d: a, id, shape: shapeFor(id.spec), born: tNow, lost: 0, last: tNow,
          rx: x, ry: y, rt: tFix, h0: trk ?? 0, v: gs * KT, om: 0, alt0: altFt, vr: fin(a.vr) ? a.vr : 0, ground,
          lastTrk: trk, lastFix: tFix, cx: 0, cy: 0, calt: 0, ct: tNow,
          x, y, hdg: trk ?? 0, bank: 0, agl: 0, zc: 0, alpha: 0, roof: 0, roofX: NaN, roofY: NaN,
          sx: 0, sy: 0, gx: 0, gy: 0, gz: 0, gSince: 0, parked: false, k: 1, vis: false, shVis: false, rHit: 0, depth: 0, low: false, pal: null, palKey: -1,
        };
        planes.set(a.hex, P);
        continue;
      }
      // where it is shown now, before the model changes
      predict(P, tNow, tmp);
      const ec = Math.exp(-(tNow - P.ct) / TAU);
      const dx = tmp.x + P.cx * ec, dy = tmp.y + P.cy * ec;
      const dAlt = tmp.alt == null ? null : tmp.alt + P.calt * Math.exp(-(tNow - P.ct) / TAU_ALT);
      // the turn rate, from how the track changed since the last fix
      const dtr = tFix - P.lastFix;
      if (trk != null && P.lastTrk != null && gs > 30 && dtr > 1.5 && dtr < 40) P.om = clamp(0.4 * P.om + 0.6 * (wrap180(trk - P.lastTrk) / dtr), -6, 6);
      else if (gs <= 30 || dtr >= 40) P.om = 0;
      if (dtr > 0.5) { P.lastTrk = trk; P.lastFix = tFix; }
      if (a.type !== P.d.type || a.flight !== P.d.flight || a.cat !== P.d.cat) { P.id = identify(a); P.shape = shapeFor(P.id.spec); P.palKey = -1; }
      P.d = a; P.last = tNow; P.ground = ground;
      P.rx = x; P.ry = y; P.rt = tFix; P.h0 = trk ?? P.h0; P.v = gs * KT; P.alt0 = altFt; P.vr = fin(a.vr) ? a.vr : 0;
      predict(P, tNow, tmp);
      P.cx = dx - tmp.x; P.cy = dy - tmp.y; P.ct = tNow;
      P.calt = dAlt != null && tmp.alt != null ? clamp(dAlt - tmp.alt, -3000, 3000) : 0;
      if (Math.hypot(P.cx, P.cy) > 1500) { P.cx = P.cy = 0; P.born = tNow; P.hdg = P.h0; }   // a long gap: appear there, don't slide
      if (P.lost) { P.born = tNow - 1.4 * clamp(P.alpha, 0, 1); P.lost = 0; }
    }
    for (const P of planes.values()) if (!present.has(P.hex) && !P.lost) P.lost = tNow;
    if (sel && cardH) fillCard();
    kick();
  }

  // ---------------------------------------------------------------- the frame: motion, projection, what's visible
  let night = 0, overcast = 0;
  const SKY_DAY = [214, 222, 232], SKY_NIGHT = [52, 60, 86];
  function update(f) {
    low.length = 0; high.length = 0; shadows.length = 0;
    if (!app.layerEnabled("planes") || !planes.size) { want = 0; setInView(0); return; }
    const t = f.t / 1000, dt = clamp(f.dt || 0, 0, 0.25);
    const W = app.weather, sky = W && app.layerEnabled("sky");
    night = sky ? clamp(+W.night || 0, 0, 1) : 0;
    overcast = sky ? clamp((+W.cloud || 0) / 100, 0, 1) : 0;
    const s = view.s, r = view.rot, o = geo.ROTS[r], SIN_T = geo.SIN_T, COS_T = geo.COS_T;
    const R0 = o.R[0], R1 = o.R[1], D0 = o.D[0], D1 = o.D[1];
    const cxs = view.w / 2 - view.X * s, cys = view.h / 2 - view.Y * s;
    const minK = app.mobile ? 1.2 : 1;
    let n = 0, maxPx = 0, rotorVis = false, fading = false;
    for (const P of planes.values()) {
      if (P.lost && t - P.lost > LOST_S + FADE_S) { planes.delete(P.hex); if (hoverHex === P.hex) hoverHex = null; if (sel === P.hex) fillCard(); continue; }
      if (!P.lost && t - P.last > 45) P.lost = t;   // the feed stopped (a hidden tab, a network failure)
      predict(P, t, tmp);
      const ec = Math.exp(-(t - P.ct) / TAU);
      P.x = tmp.x + P.cx * ec; P.y = tmp.y + P.cy * ec;
      const kH = 1 - Math.exp(-dt / 0.6);
      P.hdg = wrap360(P.hdg + wrap180(tmp.h - P.hdg) * kH);
      const bankT = P.id.heli ? clamp(P.om * 4, -14, 14) : P.ground ? 0 : clamp(P.om * 8, -32, 32);
      P.bank += (bankT - P.bank) * (1 - Math.exp(-dt / 0.9));
      let agl = 0;
      if (!P.ground && tmp.alt != null) { const ft = tmp.alt + P.calt * Math.exp(-(t - P.ct) / TAU_ALT); agl = Math.max(0, (ft + qnhFix(ft) - FIELD_FT) * FT); }
      if (agl < 140 && P.v < 40 * KT) { const roof = roofUnder(P); if (roof > 0 && agl < roof + 6) agl = roof; }   // on (or settling onto) a roof
      P.agl = agl; P.zc = drawnHeight(agl);
      // on the ground and still for a while: rotor stopped, no beacon or strobes
      if (P.ground && P.v < 0.6) { if (!P.gSince) P.gSince = t; } else P.gSince = 0;
      P.parked = !!P.gSince && t - P.gSince > 25;
      const out = outside(P.x, P.y);
      let a = smooth(0, 1.4, t - P.born) * (1 - smooth(MARGIN0, MARGIN1, out));
      if (P.lost) a *= 1 - smooth(LOST_S, LOST_S + FADE_S, t - P.lost);
      P.alpha = a;
      P.vis = P.shVis = false;
      if (a < 0.01) continue;
      if (a < 0.99) fading = true;
      // drawn size: true size, never smaller than a legible minimum, and smaller with height (distance and haze)
      const hz = 1 / (1 + Math.max(0, agl - 2500) / 7000);
      const len = P.shape.len;
      P.k = Math.max(s * hz, ((20 + 0.32 * len) * minK * lerp(1, 0.6, smooth(3000, 11000, agl))) / len);
      const depth = P.x * D0 + P.y * D1;
      P.sx = (P.x * R0 + P.y * R1) * s + cxs;
      P.sy = -(depth * SIN_T + P.zc * COS_T) * s + cys;
      const rad = len * P.k * 0.6 + 12;
      P.vis = P.sx > -rad && P.sx < view.w + rad && P.sy > -rad && P.sy < view.h + rad;
      P.depth = depth * COS_T - P.zc * SIN_T;
      P.low = P.zc < LOW_Z && out === 0;
      // the shadow, straight below on the ground (or the roof it is over)
      if (out === 0 && insideBy(P.x, P.y) > 0) {
        const gz = P.low || agl < 140 ? roofUnder(P) : 0;
        P.gx = P.sx; P.gy = -(depth * SIN_T + gz * COS_T) * s + cys;
        P.gz = gz;
        P.shVis = P.gx > -rad && P.gx < view.w + rad && P.gy > -rad && P.gy < view.h + rad;
        if (P.shVis) shadows.push(P);
      }
      if (P.vis) (P.low ? low : high).push(P);
      if (P.vis || P.shVis) {
        n++;
        maxPx = Math.max(maxPx, P.v * s);
        if (P.vis && P.id.heli && P.shape.rotor.r * 2 * P.k > 14 && !P.parked) rotorVis = true;
      }
    }
    low.sort(byDepth); high.sort(byDepth);
    setInView(n);
    if (!n) { want = 0; return; }
    // ~2.5 px of movement a frame is smooth enough; far out the models are small and slow: 8–12 fps
    const cap = s < 0.4 ? 12 : s < 1.2 ? 20 : 30;
    let fps = clamp(maxPx / 2.5, 8, cap);
    if (rotorVis) fps = Math.max(fps, Math.min(cap, 20));
    if (fading) fps = Math.max(fps, 12);
    want = reduce.matches ? Math.min(fps, 10) : fps;
  }
  const byDepth = (a, b) => b.depth - a.depth;

  function setInView(n) {
    if (n === inView) return;
    inView = n;
    updateCount();
  }
  function updateCount() {
    const text = !app.layerEnabled("planes") ? "" : feed.state === "unavailable" ? "unavailable" : feed.state === "offline" && !planes.size ? "offline" : inView < 0 ? "" : String(Math.max(0, inView));
    if (text === lastCount) return;
    lastCount = text;
    UI()?.setCount?.("planes", text);
    app.emit("count", { id: "planes", n: text });
  }

  // ---------------------------------------------------------------- drawing
  const M = { FX: 0, FY: 0, RX: 0, RY: 0, UX: 0, UY: 0 };
  /** the aircraft's axes in CSS px per local metre (forward, right wing, up), with its bank */
  function axes(P, k, bankDeg) {
    const r = view.rot, o = geo.ROTS[r], SIN_T = geo.SIN_T, COS_T = geo.COS_T;
    const h = P.hdg * RAD, sh = Math.sin(h), ch = Math.cos(h);
    M.FX = (sh * o.R[0] + ch * o.R[1]) * k; M.FY = -(sh * o.D[0] + ch * o.D[1]) * SIN_T * k;
    const rx = (ch * o.R[0] - sh * o.R[1]) * k, ry = -(ch * o.D[0] - sh * o.D[1]) * SIN_T * k;
    const ux = 0, uy = -COS_T * k;
    const b = bankDeg * RAD, cb = Math.cos(b), sb = Math.sin(b);
    M.RX = rx * cb - ux * sb; M.RY = ry * cb - uy * sb;
    M.UX = ux * cb + rx * sb; M.UY = uy * cb + ry * sb;
    return M;
  }

  function paletteFor(P, tinted, lit, finLit) {
    const n = tinted ? 0 : night;
    const hz = 0.42 * smooth(2000, 10000, P.agl);
    const key = ((n * 40) | 0) * 1e6 + ((hz * 40) | 0) * 1e4 + (clamp((lit - 0.6) * 100, 0, 99) | 0) * 100 + (clamp((finLit - 0.6) * 100, 0, 99) | 0);
    if (P.palKey === key && P.pal) return P.pal;
    const mul = [lerp(1, NIGHT_MUL[0], n), lerp(1, NIGHT_MUL[1], n), lerp(1, NIGHT_MUL[2], n)];
    const skyC = [lerp(SKY_DAY[0], SKY_NIGHT[0], night), lerp(SKY_DAY[1], SKY_NIGHT[1], night), lerp(SKY_DAY[2], SKY_NIGHT[2], night)];
    const [body, side, tail, wing, engine] = P.id.livery;
    P.pal = {
      body: paint(body, lit, mul, hz, skyC), side: paint(side, 0.8, mul, hz, skyC), tail: paint(tail, finLit, mul, hz, skyC),
      wing: paint(wing, lit * 0.97, mul, hz, skyC), engine: paint(engine, 0.92, mul, hz, skyC), hi: paint(body, Math.min(1.25, lit * 1.12) + 0.06, mul, hz, skyC),
      glass: paint("#3d4a5c", 1, mul, hz, skyC), dark: paint("#3a3836", 1, mul, hz, skyC),
    };
    P.palKey = key;
    return P.pal;
  }

  function drawCraft(ctx, P, t, tinted) {
    const dpr = view.dpr, sh = P.shape, k = P.k;
    const m = axes(P, k, P.bank * 1.15);
    const lit = 1 - 0.16 * (m.UX / Math.max(1e-6, Math.hypot(m.UX, m.UY))) * 2;   // tipped toward the light (screen-left): brighter
    // the fin's visible side: lit when it faces left
    const o = geo.ROTS[view.rot], h = P.hdg * RAD;
    const rtD = Math.cos(h) * o.D[0] - Math.sin(h) * o.D[1];
    const rtX = Math.cos(h) * o.R[0] - Math.sin(h) * o.R[1];
    const finLit = 1 - 0.14 * (rtD > 0 ? -rtX : rtX);
    const pal = paletteFor(P, tinted, clamp(lit, 0.75, 1.2), finLit);
    const X = P.sx, Y = P.sy;
    const hiOff = (m.RX > 0 ? -0.3 : 0.3) * (sh.len * 0.01 + 0.4);
    // a soft outline round the silhouette while it is small (white on pale paper needs an edge)
    const lenPx = sh.len * k;
    const ol = 0.42 * (1 - smooth(70, 180, lenPx));
    if (ol > 0.02) {
      ctx.globalAlpha = P.alpha * ol;
      ctx.setTransform(dpr * m.FX, dpr * m.FY, dpr * m.RX, dpr * m.RY, dpr * X, dpr * Y);
      ctx.lineJoin = "round";
      ctx.lineWidth = 2.2 / k;
      if (!tinted && night >= 0.5) ctx.globalAlpha = P.alpha * ol * 0.55;   // at night a faint pale rim instead
      ctx.strokeStyle = tinted || night < 0.5 ? "#2a2420" : "#c8d0ec";
      ctx.stroke(sh.outline);
    }
    ctx.globalAlpha = P.alpha;
    for (const pt of sh.parts) {
      if (pt.plane === "h") {
        const v = pt.hl ? hiOff : 0;
        ctx.setTransform(dpr * m.FX, dpr * m.FY, dpr * m.RX, dpr * m.RY, dpr * (X + pt.w * m.UX + v * m.RX), dpr * (Y + pt.w * m.UY + v * m.RY));
      } else ctx.setTransform(dpr * m.FX, dpr * m.FY, dpr * m.UX, dpr * m.UY, dpr * (X + pt.v * m.RX), dpr * (Y + pt.v * m.RY));
      ctx.fillStyle = pal[pt.fill] || pal.body;
      ctx.fill(pt.path);
    }
    const still = reduce.matches;
    // propellers: a faint disc
    if (sh.props) {
      ctx.fillStyle = tinted || night < 0.5 ? "rgba(60,58,56,.28)" : "rgba(30,32,44,.3)";
      for (const [u, v, w, pr] of sh.props) {
        ctx.setTransform(dpr * m.RX, dpr * m.RY, dpr * m.UX, dpr * m.UY, dpr * (X + u * m.FX + v * m.RX + w * m.UX), dpr * (Y + u * m.FY + v * m.RY + w * m.UY));
        ctx.beginPath(); ctx.arc(0, 0, pr, 0, Math.PI * 2); ctx.fill();
      }
    }
    // rotors
    if (sh.rotor) {
      const parked = P.parked;
      const [tu, tv, tw, tr] = sh.tailRotor;
      ctx.setTransform(dpr * m.FX, dpr * m.FY, dpr * m.UX, dpr * m.UY, dpr * (X + tv * m.RX), dpr * (Y + tv * m.RY));
      ctx.fillStyle = "rgba(50,50,50,.32)";
      ctx.beginPath(); ctx.arc(tu, tw, tr, 0, Math.PI * 2); ctx.fill();
      const rw = sh.rotor.w;
      ctx.setTransform(dpr * m.FX, dpr * m.FY, dpr * m.RX, dpr * m.RY, dpr * (X + rw * m.UX), dpr * (Y + rw * m.UY));
      if (!parked) { ctx.fillStyle = night > 0.5 && !tinted ? "rgba(150,160,190,.16)" : "rgba(40,40,40,.17)"; ctx.fill(sh.disc); }
      const spin = parked || still ? 0.6 : (t * (P.ground ? 2.2 : 3.1) + P.id.phase) * Math.PI * 2 * 0.5;
      ctx.fillStyle = parked ? pal.dark : "rgba(40,40,40,.5)";
      for (let b = 0; b < sh.rotor.blades; b++) { ctx.rotate(b ? (Math.PI * 2) / sh.rotor.blades : spin); ctx.fill(sh.blade); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = pal.dark;
      ctx.beginPath(); ctx.arc(X + rw * m.UX, Y + rw * m.UY, Math.max(1, 0.35 * k), 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawShadow(ctx, P) {
    const dpr = view.dpr, sh = P.shape;
    const m = axes(P, P.k, 0);
    let a = 0.26 * (1 - 0.72 * smooth(0, 2500, P.agl)) * (1 - 0.55 * night) * (1 - 0.45 * overcast);
    a *= P.alpha * smooth(0, 40, insideBy(P.x, P.y));
    if (a < 0.01) return;
    // softness: a wider, fainter pass under a sharper one (higher = softer)
    const spread = 1.08 + 0.12 * smooth(0, 1500, P.agl);
    ctx.fillStyle = "rgb(36,32,52)";
    for (const [f, al] of [[spread, 0.45], [1, 0.62]]) {
      ctx.globalAlpha = a * al;
      ctx.setTransform(dpr * m.FX * f, dpr * m.FY * f, dpr * m.RX * f, dpr * m.RY * f, dpr * P.gx, dpr * P.gy);
      ctx.fill(sh.shadow);
      if (sh.disc && !P.parked) { ctx.globalAlpha = a * al * 0.35; ctx.fill(sh.disc); }
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function bboxOf(P, pad = 4) {
    const rr = P.shape.len * P.k * 0.62 + pad;
    return [P.sx - rr, P.sy - rr, P.sx + rr, P.sy + rr];
  }

  // lights: navigation (red left, green right, white tail; dusk and night), a red beacon, white strobes, landing lights
  function drawLights(ctx, P, t) {
    const L = P.shape.lights;
    if (!L || !L.tail && !(L.nav && L.nav.length)) return;
    const still = reduce.matches, k = P.k, dpr = view.dpr;
    const m = axes(P, k, P.bank * 1.15);
    const X = P.sx, Y = P.sy;
    const navA = smooth(0.08, 0.5, night), core = clamp(k * 0.9, 1.5, 3.4);
    const glow = core * lerp(3.5, 9, night);
    const ph = P.id.phase * 3;
    const occluded = P.low && view.s * view.dpr >= 0.8;
    ctx.globalCompositeOperation = "lighter";
    const dot = (p, spr, alpha, size = glow) => {
      if (!p || alpha <= 0.01) return;
      const x = X + p[0] * m.FX + p[1] * m.RX + p[2] * m.UX, y = Y + p[0] * m.FY + p[1] * m.RY + p[2] * m.UY;
      if (occluded && app.inFront(P.x, P.y, [x - 1, y - 1, x + 1, y + 1], 0, { buildingsOnly: true }).length) return;
      ctx.globalAlpha = Math.min(1, alpha * P.alpha);
      ctx.drawImage(spr, x - size / 2, y - size / 2, size, size);
    };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (navA > 0.01 && L.nav.length) { dot(L.nav[0], sprites.red, navA * 0.95); dot(L.nav[1], sprites.green, navA * 0.95); dot(L.tail, sprites.white, navA * 0.7, glow * 0.8); }
    if (!P.parked) {
      // the beacon: a red flash about once a second; strobes: a double white flash
      const pb = (t + ph) % 1.1, ps = (t + ph * 1.3) % 1.4;
      const bcn = still ? 0.45 : pb < 0.13 ? 1 : 0;
      dot(L.bcn, sprites.red, bcn * lerp(0.75, 1, night), glow * lerp(1.1, 1, night));
      const strobe = still ? 0 : ps < 0.09 || (ps > 0.2 && ps < 0.29) ? 1 : 0;
      if (strobe && L.nav.length) { dot(L.nav[0], sprites.white, 1, glow * 1.25); dot(L.nav[1], sprites.white, 1, glow * 1.25); }
      // landing lights: on below 10,000 ft at night when descending or low; a helicopter's when it's low
      const landOn = night > 0.25 && L.land && P.agl < 3000 && (P.d.vr < -300 || P.agl < 450 || (P.id.heli && P.agl < 600));
      if (landOn) dot(L.land, sprites.white, night * 0.95, glow * 1.6);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  function drawTag(ctx, P, selected) {
    const label = P.d.flight || P.d.reg || "Aircraft";
    const sub = P.ground || P.agl < 3 ? "on the ground" : `${fmtInt(Math.round((P.d.alt ?? 0) / 25) * 25)} ft`;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.font = "600 11.5px Inter, system-ui, sans-serif";
    const w1 = ctx.measureText(label).width;
    ctx.font = "500 10.5px Inter, system-ui, sans-serif";
    const w2 = ctx.measureText(sub).width;
    const w = Math.max(w1, w2) + 14, hgt = 31;
    const rr = P.shape.len * P.k * 0.45 + 8;
    let x = P.sx + rr, y = P.sy - rr - hgt;
    if (x + w > view.w - 4) x = P.sx - rr - w;
    if (y < 4) y = P.sy + rr;
    ctx.globalAlpha = P.alpha;
    ctx.fillStyle = "rgba(251,248,241,.94)";
    ctx.strokeStyle = selected ? "#b3202a" : "rgba(42,38,34,.25)";
    ctx.lineWidth = selected ? 1.5 : 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, hgt, 7); else ctx.rect(x, y, w, hgt);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#2a2622"; ctx.textBaseline = "alphabetic";
    ctx.font = "600 11.5px Inter, system-ui, sans-serif"; ctx.fillText(label, x + 7, y + 13);
    ctx.fillStyle = "#7a7064"; ctx.font = "500 10.5px Inter, system-ui, sans-serif"; ctx.fillText(sub, x + 7, y + 26);
    ctx.globalAlpha = 1;
  }

  function drawSelection(ctx, P, t) {
    const dpr = view.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // a dotted drop line from the aircraft to its shadow, and a ring at its height
    if (P.shVis) {
      ctx.save();
      ctx.setLineDash([2, 4]); ctx.lineCap = "round";
      ctx.strokeStyle = night > 0.5 ? "rgba(255,240,220,.5)" : "rgba(42,38,34,.45)";
      ctx.lineWidth = 1.2; ctx.globalAlpha = P.alpha;
      ctx.beginPath(); ctx.moveTo(P.sx, P.sy + 4); ctx.lineTo(P.gx, P.gy); ctx.stroke();
      ctx.restore();
    }
    const rr = P.shape.len * P.k * 0.62 + 6;
    const pulse = reduce.matches ? 0 : 0.5 + 0.5 * Math.sin(t * 3);
    ctx.globalAlpha = P.alpha;
    ctx.strokeStyle = "#b3202a"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(P.sx, P.sy, rr + pulse * 2, (rr + pulse * 2) * geo.SIN_T, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- layers
  app.addLayer({
    id: "planes-low", z: 45,
    draw(ctx, f) {
      if (!app.layerEnabled("planes") || (!shadows.length && !low.length)) return;
      for (const P of shadows) {
        drawShadow(ctx, P);
        if (P.gz > 0 || view.s >= 0.5) app.occlude(ctx, P.x, P.y, bboxOf(P, 6).map((v, i) => (i % 2 ? v + (P.gy - P.sy) : v)), Math.min(P.shape.len / 2, 10));
      }
      const t = f.t / 1000;
      for (const P of low) {
        drawCraft(ctx, P, t, true);
        app.occlude(ctx, P.x, P.y, bboxOf(P, 6), Math.min(P.shape.len / 2, 8));
      }
    },
  });
  app.addLayer({
    id: "planes", z: 92,
    fps() { return app.layerEnabled("planes") ? want : 0; },
    draw(ctx, f) {
      if (!low.length && !high.length) return;
      const t = f.t / 1000;
      for (const P of high) drawCraft(ctx, P, t, false);
      for (const P of low) drawLights(ctx, P, t);
      for (const P of high) drawLights(ctx, P, t);
      const S = sel && planes.get(sel);
      if (S && S.vis) { drawSelection(ctx, S, t); drawTag(ctx, S, true); }
      const H = hoverHex && hoverHex !== sel && planes.get(hoverHex);
      if (H && H.vis) drawTag(ctx, H, false);
    },
    hit(px, py) {
      const pad = app.mobile ? 22 : 14;
      for (const list of [high, low]) {
        for (let i = list.length - 1; i >= 0; i--) {
          const P = list[i];
          if (P.alpha < 0.3) continue;
          const rr = Math.max(pad, P.shape.len * P.k * 0.5);
          const dx = px - P.sx, dy = py - P.sy;
          if (dx * dx + dy * dy <= rr * rr) return P;
        }
      }
      return null;
    },
    onClick(P) { openCard(P.hex); },
    onHover(P) { const h = P ? P.hex : null; if (h !== hoverHex) { hoverHex = h; kick(); } },
  });
  app.on("frame", update);

  // ---------------------------------------------------------------- the card
  const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
  const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  const SHORT = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const OVAL = geo.toXY(39.9995, -83.0148);
  injectStyle();

  function openCard(hex, opts = {}) {
    const P = planes.get(hex), ui = UI();
    if (!P || !ui || !ui.card) return;
    sel = hex;
    cardRefs = buildCardBody();
    cardH = ui.card({
      id: "plane", title: titleOf(P), subtitle: subtitleOf(P), color: P.id.livery[2] === "#f4f3f0" || P.id.livery[2] === "#f2efe8" ? P.id.livery[1] : P.id.livery[2],
      body: cardRefs.el,
      anchor: () => { const Q = sel && planes.get(sel); return Q && Q.vis ? { x: Q.x, y: Q.y, z: Q.zc, mark: false } : null; },
      onClose: () => { if (sel === hex) sel = null; cardH = null; cardRefs = null; kick(); },
    });
    fillCard();
    if (opts.fly) view.flyTo({ x: P.x, y: P.y, z: P.zc }, { m: clamp(view.metresAcross(), 1500, 4000) });
    kick();
  }
  const titleOf = (P) => P.d.flight || P.d.reg || `Aircraft ${P.hex.toUpperCase()}`;
  function subtitleOf(P) {
    const bits = [P.id.name || cap(P.id.label)];
    if (P.id.op) bits.push(P.id.op);
    else if (P.id.medical) bits.push("medical flight");
    if (MOCK) bits.push("test traffic");
    return bits.join(" · ");
  }
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

  function buildCardBody() {
    const el = document.createElement("div");
    el.className = "pl-card";
    el.innerHTML = `<div class="pl-now"><span class="pl-big pl-alt"></span><span class="pl-big pl-spd"></span><span class="pl-trend"></span></div>` +
      `<dl class="pl-grid"></dl><p class="pl-note" hidden></p><p class="pl-links"></p><p class="pl-src"></p>`;
    return { el, alt: el.querySelector(".pl-alt"), spd: el.querySelector(".pl-spd"), trend: el.querySelector(".pl-trend"), grid: el.querySelector(".pl-grid"), note: el.querySelector(".pl-note"), links: el.querySelector(".pl-links"), src: el.querySelector(".pl-src"), key: "" };
  }

  function fillCard() {
    if (!cardH || !cardRefs) return;
    const P = sel && planes.get(sel);
    const R = cardRefs;
    if (!P) { R.src.textContent = "Signal lost: this aircraft is no longer reporting near campus."; R.src.classList.add("pl-lost"); return; }
    R.src.classList.remove("pl-lost");
    const d = P.d;
    // the big figures
    if (P.ground) { R.alt.textContent = "On the ground"; R.spd.textContent = ""; R.trend.textContent = ""; }
    else {
      R.alt.innerHTML = fin(d.alt) ? `${fmtInt(d.alt)}<small> ft</small>` : "—";
      R.spd.innerHTML = fin(d.gs) ? `${fmtInt(d.gs)}<small> kt</small>` : "";
      const vr = fin(d.vr) ? d.vr : 0;
      R.trend.textContent = vr > 250 ? `climbing ${fmtInt(Math.round(vr / 50) * 50)} ft/min` : vr < -250 ? `descending ${fmtInt(Math.round(-vr / 50) * 50)} ft/min` : "level";
    }
    const rows = [];
    rows.push(["Aircraft", P.id.name ? `${P.id.name}${d.type && P.id.name !== d.type ? ` (${d.type})` : ""}` : cap(P.id.label)]);
    if (P.id.op) rows.push(["Operator", P.id.op]);
    if (!P.ground && fin(d.alt)) {
      const above = Math.max(0, d.alt + qnhFix(d.alt) - FIELD_FT);
      rows.push(["Height", d.alt >= 18000 ? `flight level ${Math.round(d.alt / 100)}, about ${(above / 5280).toFixed(1)} mi up` : `about ${fmtInt(Math.round(above / 50) * 50)} ft above campus`]);
    }
    if (fin(d.gs) && d.gs > 1) rows.push(["Speed", `${fmtInt(d.gs)} kt (${fmtInt(d.gs * 1.15078)} mph)`]);
    const hd = fin(d.track) ? d.track : fin(d.hdg) ? d.hdg : null;
    if (hd != null && (d.gs || 0) > 1) rows.push(["Heading", `${String(Math.round(wrap360(hd)) % 360).padStart(3, "0")}° ${SHORT[Math.round(wrap360(hd) / 22.5) % 16]}`]);
    rows.push(["Where", whereText(P)]);
    if (d.reg) rows.push(["Registration", d.reg]);
    if (d.sq) rows.push(["Squawk", d.em ? `${d.sq} · emergency (${d.em})` : d.sq]);
    const key = JSON.stringify(rows);
    if (key !== R.key) {
      R.key = key;
      R.grid.replaceChildren(...rows.flatMap(([k, v]) => { const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = k; dd.textContent = v; return [dt, dd]; }));
    }
    const note = P.id.osu ? "One of Ohio State's training aircraft, flying from the university's own airport, Don Scott Field (KOSU), north-west of campus."
      : P.id.medical ? "A medical flight. The Wexner Medical Center's helipad is on the University Hospital roof."
      : fin(d.alt) && d.alt < 6000 && hd != null && Math.abs(wrap180(hd - 100)) < 25 && P.x < 9000 && (d.vr || 0) < -200 ? "Lining up to land at John Glenn Columbus International (CMH), 10 km east."
      : fin(d.alt) && d.alt < 6000 && hd != null && Math.abs(wrap180(hd - 280)) < 25 && (d.vr || 0) > 200 ? "Climbing out of John Glenn Columbus International (CMH)."
      : "";
    R.note.hidden = !note; R.note.textContent = note;
    const hexOk = /^[0-9a-f]{6}$/.test(P.hex);
    if (R.links.dataset.hex !== P.hex) {
      R.links.dataset.hex = P.hex;
      R.links.replaceChildren();
      if (hexOk && !MOCK) {
        const a = document.createElement("a");
        a.href = `https://globe.adsb.lol/?icao=${P.hex}`; a.target = "_blank"; a.rel = "noopener noreferrer"; a.className = "pl-link";
        a.textContent = "Follow on adsb.lol ↗";
        R.links.append(a);
      }
    }
    R.links.hidden = !R.links.firstChild;
    sourceLine(P);
    cardH.update({ title: titleOf(P), subtitle: subtitleOf(P) });
  }
  function sourceLine(P) {
    const age = Math.max(0, Math.round(performance.now() / 1000 - P.rt));
    const text = MOCK ? "Synthetic test traffic (?planes=mock)." : `ADS-B from ${feed.source || "the feed"}${feed.stale ? " (delayed)" : ""} · position ${age < 2 ? "just now" : `${age} s old`}.`;
    if (cardRefs.src.textContent !== text) cardRefs.src.textContent = text;
  }
  function whereText(P) {
    const dx = P.x - OVAL[0], dy = P.y - OVAL[1], dist = Math.hypot(dx, dy);
    if (dist < 250) return "right over the Oval";
    const dir = COMPASS[Math.round(wrap360(Math.atan2(dx, dy) / RAD) / 45) % 8];
    const mi = dist / 1609.34;
    return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi ${dir} of the Oval`;
  }

  function injectStyle() {
    if (document.getElementById("pl-style")) return;
    const st = document.createElement("style");
    st.id = "pl-style";
    st.textContent = `
      .pl-card { font: 13px/1.45 "Inter", system-ui, sans-serif; }
      .pl-now { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 14px; margin: 2px 0 8px; }
      .pl-big { font: 500 26px/1 "Fraunces", Georgia, serif; letter-spacing: -0.01em; color: var(--ink, #2a2622); }
      .pl-big small { font: 500 12px/1 "Inter", system-ui, sans-serif; color: var(--mute, #7a7064); letter-spacing: 0; }
      .pl-trend { font: italic 14px/1.2 "Fraunces", Georgia, serif; color: var(--mute, #7a7064); }
      .pl-grid { display: grid; grid-template-columns: auto 1fr; gap: 3px 14px; margin: 0; }
      .pl-grid dt { color: var(--mute, #7a7064); }
      .pl-grid dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
      .pl-note { margin: 9px 0 0; padding: 7px 10px; border-radius: 8px; background: var(--well, #f1ebdd); font-size: 12.5px; }
      .pl-links { margin: 9px 0 0; }
      .pl-link { color: var(--scarlet, #b3202a); font-weight: 600; text-decoration: none; }
      .pl-link:hover, .pl-link:focus-visible { text-decoration: underline; }
      .pl-src { margin: 8px 0 0; font-size: 11px; color: var(--mute, #7a7064); }
      .pl-src.pl-lost { color: var(--scarlet, #b3202a); }
    `;
    document.head.append(st);
  }

  // ---------------------------------------------------------------- search: callsigns, registrations, types
  UI()?.addSearchProvider?.((q) => {
    q = String(q || "").trim().toLowerCase();
    if (q.length < 2 || !app.layerEnabled("planes")) return [];
    const all = /^(planes?|airplanes?|aircraft|flights?|helicopters?|overhead|ads-?b)$/.test(q);
    const out = [];
    for (const P of planes.values()) {
      if (P.lost || P.alpha < 0.05) continue;
      const cs = (P.d.flight || "").toLowerCase(), reg = (P.d.reg || "").toLowerCase(), name = (P.id.name || P.id.label || "").toLowerCase(), op = (P.id.op || "").toLowerCase();
      let score = 0;
      if (all) score = /^heli/.test(q) ? (P.id.heli ? 0.85 : 0) : 0.8;
      else if (cs === q || reg === q) score = 0.97;
      else if (cs.startsWith(q) || reg.startsWith(q)) score = 0.86;
      else if (q.length >= 3 && (name.includes(q) || op.includes(q) || (P.d.type || "").toLowerCase() === q)) score = 0.55;
      if (score) out.push({ label: titleOf(P), sub: `Aircraft · ${P.id.name || cap(P.id.label)} · ${P.ground ? "on the ground" : fin(P.d.alt) ? `${fmtInt(P.d.alt)} ft` : ""}`, kind: "plane", key: `plane:${P.hex}`, score, go: () => openCard(P.hex, { fly: true }) });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 6);
  });

  // ---------------------------------------------------------------- the feed
  let timer = null, busy = false;
  const schedule = (ms) => { clearTimeout(timer); timer = setTimeout(poll, ms); };
  async function poll() {
    timer = null;
    if (busy || feed.state === "unavailable" || !app.layerEnabled("planes") || document.hidden) return;   // resumed by the toggle or the tab
    if (MOCK) { mockReport(); schedule(MOCK_EVERY * 1000); return; }
    busy = true;
    try {
      const opt = { cache: "no-store", headers: { accept: "application/json" } };
      if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opt.signal = AbortSignal.timeout(12000);
      const r = await fetch(API, opt);
      // no such endpoint (a static host without functions), or a host answering with its own page: quietly off
      if (r.status === 404 || r.status === 405 || r.status === 501) return setUnavailable();
      if (!r.ok) throw new Error(`planes: ${r.status}`);
      if (!/json/i.test(r.headers.get("content-type") || "")) return setUnavailable();
      const body = await r.json();
      if (!body || !Array.isArray(body.aircraft)) throw new Error("planes: unexpected answer");
      feed.state = "live"; feed.source = typeof body.source === "string" ? body.source.slice(0, 40) : null; feed.stale = !!body.stale; feed.updated = Date.now(); feed.fails = 0;
      ingest(body, performance.now() / 1000);
      updateCount();
      schedule(inView > 0 || sel ? POLL_MS : POLL_IDLE_MS);
    } catch (e) {
      feed.fails++;
      if (feed.fails >= 2) { feed.state = "offline"; updateCount(); }
      schedule(Math.min(POLL_MAX_MS, POLL_MS * 2 ** Math.min(feed.fails, 4)));
    } finally { busy = false; }
  }
  function setUnavailable() {
    feed.state = "unavailable";
    planes.clear();
    updateCount();
    kick();
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !timer && !busy) poll(); });
  app.on("layers", ({ id, on }) => {
    if (id !== "planes") return;
    if (on) { if (!timer && !busy) poll(); }
    else { clearTimeout(timer); timer = null; if (sel) UI()?.closeCard?.("plane"); hoverHex = null; }
    updateCount();
    kick();
  });
  // A still map draws nothing: once a second, see whether an aircraft has flown into view and wake the map for it.
  setInterval(() => {
    if (document.hidden) return;
    if (cardH && cardRefs && sel && planes.has(sel)) sourceLine(planes.get(sel));   // the card's "position N s old"
    if (inView > 0 || !planes.size || !app.layerEnabled("planes")) return;
    const t = performance.now() / 1000, s = view.s, o = geo.ROTS[view.rot];
    for (const P of planes.values()) {
      if (P.lost) continue;
      predict(P, t, tmp);
      if (outside(tmp.x, tmp.y) > MARGIN1) continue;
      const depth = tmp.x * o.D[0] + tmp.y * o.D[1];
      const sx = (tmp.x * o.R[0] + tmp.y * o.R[1] - view.X) * s + view.w / 2;
      const sy0 = (-(depth * geo.SIN_T) - view.Y) * s + view.h / 2;
      const sy1 = sy0 - drawnHeight(Math.max(0, ((tmp.alt ?? FIELD_FT) - FIELD_FT) * FT)) * geo.COS_T * s;
      const pad = 60;
      if (sx > -pad && sx < view.w + pad && Math.max(sy0, sy1) > -pad && Math.min(sy0, sy1) < view.h + pad) { kick(); return; }
    }
  }, 1000);

  // ---------------------------------------------------------------- ?planes=mock: synthetic traffic
  let mockT0 = performance.now() / 1000;
  let mocks = null;
  function mockReport() {
    if (!mocks) mocks = buildMocks();
    const T = performance.now() / 1000 - mockT0;
    const aircraft = [];
    for (const m of mocks) {
      const st = m.at(T);
      if (!st) continue;
      const [lat, lon] = geo.toLatLon(st.x, st.y);
      aircraft.push({ hex: m.hex, flight: m.flight, reg: m.reg, type: m.type, desc: null, cat: m.cat, lat, lon, alt: st.ground ? null : Math.round(st.ft / 25) * 25, ground: !!st.ground, gs: st.kt, track: st.hdg, hdg: st.hdg, vr: st.vr, qnh: null, sq: m.sq, em: null, seen: 0 });
    }
    feed.state = "mock"; feed.source = "mock";
    ingest({ now: Date.now() / 1000, source: "mock", aircraft }, performance.now() / 1000);
    updateCount();
  }
  function buildMocks() {
    const DT = 0.5;
    /** waypoints [x, y, ft, kt, hold s?] → a sampled flight (speed² eased along each leg: steady acceleration) */
    const fly = (wps, gap = 0, offset = 0) => {
      const S = [];   // x, y, ft, kt, hdg
      let hdg = Math.atan2(wps[1][0] - wps[0][0], wps[1][1] - wps[0][1]) / RAD;
      for (let i = 0; i < wps.length - 1; i++) {
        const [ax, ay, af, ak, hold] = wps[i], [bx, by, bf, bk] = wps[i + 1];
        if (hold) for (let k = 0; k < hold / DT; k++) S.push(ax, ay, af, 0, hdg);
        const L = Math.hypot(bx - ax, by - ay);
        if (L < 1) continue;
        hdg = Math.atan2(bx - ax, by - ay) / RAD;
        for (let d = 0; d < L;) {
          const f = d / L, kt = Math.max(4, Math.sqrt(lerp(ak * ak, bk * bk, f)));
          S.push(ax + (bx - ax) * f, ay + (by - ay) * f, lerp(af, bf, f), kt, hdg);
          d += kt * KT * DT;
        }
      }
      const last = wps[wps.length - 1];
      if (last[4]) for (let k = 0; k < last[4] / DT; k++) S.push(last[0], last[1], last[2], 0, hdg);
      const n = S.length / 5, dur = n * DT + gap;
      return (T) => {
        const tt = (((T + offset) % dur) + dur) % dur, i = Math.floor(tt / DT);
        if (gap && i >= n - 1) return null;   // in the gap: not reporting
        const fr = tt / DT - i, o = (i % n) * 5, p = ((i + 1) % n) * 5;
        const ft = lerp(S[o + 2], S[p + 2], fr);
        const vr = (S[Math.min(n - 1, i + 2) * 5 + 2] - S[Math.max(0, i - 2) * 5 + 2]) / (4 * DT) * 60;
        return { x: lerp(S[o], S[p], fr), y: lerp(S[o + 1], S[p + 1], fr), ft, kt: lerp(S[o + 3], S[p + 3], fr), hdg: wrap360(S[o + 4] + wrap180(S[p + 4] - S[o + 4]) * fr), vr };
      };
    };
    const arc = (cx, cy, r, a0, a1, step, ft0, ft1, kt) => { const out = [], n = Math.max(1, Math.round(Math.abs(a1 - a0) / step)); for (let i = 0; i <= n; i++) { const a = (a0 + ((a1 - a0) * i) / n) * RAD; out.push([cx + Math.sin(a) * r, cy + Math.cos(a) * r, lerp(ft0, ft1, i / n), kt]); } return out; };
    const xy = (lat, lon) => geo.toXY(lat, lon);
    // 1. an airliner on the ILS for runway 10R at CMH: it crosses campus about 1,800 ft up, descending
    const thr = xy(39.9955, -82.905), dir = [Math.sin(93 * RAD), Math.cos(93 * RAD)];
    const onFinal = (d) => [thr[0] - dir[0] * d, thr[1] - dir[1] * d];
    const glide = (d) => Math.min(3000, 863 + d * 0.0524 / FT);
    const approach = fly([[...onFinal(22000), 3000, 180], [...onFinal(14000), glide(14000), 150], [...onFinal(6000), glide(6000), 140], [...onFinal(500), glide(500), 135]], 40, 132);
    // 2. an airliner cruising high over campus, westbound
    const c = [500, 1200], wd = [Math.sin(262 * RAD), Math.cos(262 * RAD)];
    const cruise = fly([[c[0] - wd[0] * 25000, c[1] - wd[1] * 25000, 37000, 450], [c[0] + wd[0] * 25000, c[1] + wd[1] * 25000, 37000, 450]], 60, 91);
    // 3. an Ohio State Cessna circling north-west of campus
    const loop = fly(arc(-1200, 900, 1400, 0, 360, 10, 2600, 2600, 95), 0, 0);
    // 4. another in the traffic pattern at Don Scott Field (runway 27L), touch-and-goes
    const os = xy(40.0798, -83.073), rwyY = os[1], rx0 = os[0] + 1300, rx1 = os[0] - 1300;
    const pattern = fly([
      [rx0, rwyY, 1300, 75], [os[0] + 600, rwyY, 925, 65], [os[0] - 300, rwyY, 925, 60], [rx1, rwyY, 1450, 75],
      ...arc(rx1, rwyY - 500, 500, 270 + 90, 270 - 90, 15, 1500, 1850, 85).slice(1),
      [rx0, rwyY - 1000, 1900, 90],
      ...arc(rx0, rwyY - 500, 500, 180, 0, 15, 1800, 1350, 80).slice(1),
    ], 0, 40);
    // 5. a medical helicopter to the rooftop helipad on University Hospital, and away again
    const pad = xy(39.99511, -83.01819);
    const roofFt = FIELD_FT + roofAt(pad[0], pad[1]) / FT;
    const from = [-3600, 3800], toward = [from[0] - pad[0], from[1] - pad[1]], tl = Math.hypot(...toward);
    const inb = (d) => [pad[0] + (toward[0] / tl) * d, pad[1] + (toward[1] / tl) * d];
    const heli = fly([
      [...from, 1600, 125], [...inb(1300), 1250, 110], [...inb(60), roofFt + 60, 12], [pad[0], pad[1], roofFt + 25, 3, 6],
      [pad[0] + 0.1, pad[1] + 0.1, roofFt, 0, 35], [pad[0] + 0.2, pad[1] + 0.2, roofFt + 40, 3, 4], [pad[0] - 600, pad[1] - 900, roofFt + 400, 90], [-4500, -5600, 1600, 125],
    ], 30, 61);
    const withGround = (fn, gFt) => (T) => { const s = fn(T); if (s && s.ft <= gFt + 1 && s.kt < 1) { s.ground = true; s.vr = 0; } return s; };
    return [
      { hex: "~m0001", flight: "ENY3412", reg: "N401QM", type: "E75L", cat: "A3", sq: "4521", at: approach },
      { hex: "~m0002", flight: "SWA1877", reg: "N8702Q", type: "B38M", cat: "A3", sq: "6105", at: cruise },
      { hex: "~m0003", flight: "OSU21", reg: "N21QM", type: "C172", cat: "A1", sq: "1200", at: loop },
      { hex: "~m0004", flight: "OSU7", reg: "N7QM", type: "C72R", cat: "A1", sq: "1200", at: pattern },
      { hex: "~m0005", flight: "MEDFL21", reg: "N145QM", type: "EC45", cat: "A7", sq: "0321", at: withGround(heli, roofFt) },
    ];
  }

  // ---------------------------------------------------------------- go
  UI()?.registerToggle?.({ id: "planes", label: "Planes overhead", group: "Live", count: "" });
  app.planes = {
    get list() { return [...planes.values()].map((P) => ({ hex: P.hex, flight: P.d.flight, type: P.d.type, alt: P.d.alt, x: P.x, y: P.y, zc: P.zc, sx: P.sx, sy: P.sy, vis: P.vis, shadow: P.shVis, low: P.low, alpha: P.alpha })); },
    get feed() { return { ...feed }; },
    get fps() { return want; },
    open: (hex) => openCard(hex, { fly: true }),
    /** ?planes=mock: jump the synthetic traffic to T seconds */
    seek(T) { if (!MOCK) return; mockT0 = performance.now() / 1000 - T; planes.clear(); mockReport(); },
  };
  poll();
}
