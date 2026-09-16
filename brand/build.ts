/**
 * winnower brand marks — the single source for every mark file.
 *
 *   npm run brand
 *
 * Writes, for light and for dark backgrounds:
 *   brand/winnower-mark-on-{light,dark}.svg     bare leaf
 *   brand/winnower-chip-on-{light,dark}.svg     leaf cut out of the turned tile
 *   brand/winnower-lockup-on-{light,dark}.svg   leaf + outlined wordmark
 *   brand/icons/chip-on-{light,dark}-{16,32,48,128}.png   toolbar icons
 *   brand/icons/lockup-popup.svg                          popup header logo
 *   brand/readme/lockup-on-{light,dark}.svg               README logo, ink baked in
 *
 * Nothing below is eyeballed except where it says so. Every angle, gap and
 * margin is derived from the wordmark font or from the leaf's own measured
 * extents, so a change to either regenerates a consistent set.
 *
 * The decisions, in the order they were made:
 *   1. The leaf: a leaf with its tip cut off along a straight line.
 *   2. Tilt: the leaf turns until its straight cut runs parallel to the outer
 *      left stroke of the "w" in Geist Mono Medium (79.04°) — a 34.04° tilt.
 *   3. Lockup height: the icon is centred on the middle of the x-height, so it
 *      reaches the same distance above the letters as below the baseline.
 *   4. Lockup spacing: the gap between the cut and the w equals the gap the
 *      "o" keeps from the second "w" — the letters' own spacing.
 *   5. Chip: a rounded tile turned 10.96° so its right side is parallel to the
 *      cut. In the tile's frame the leaf sits at exactly 45°.
 *   6. Chip spacing: equal gaps on all four sides. The leaf is wider than it is
 *      tall at 45°, so the tile is slightly wider than tall to allow it.
 *   7. Colour: monochrome marks; the underscore is the popup's "on" green.
 *   8. Reversed weights (judged by eye): a leaf drawn
 *      light on dark looks heavier than the same leaf dark on light
 *      (irradiation), so wherever the leaf itself is light it is drawn thinner.
 *   9. 16px: the vein goes and the stem is held at one pixel.
 *  10. Toolbar icons are cropped to the tile's own edges so it fills the icon
 *      like other extensions' icons do (ICON_VIEW).
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import type { Font } from 'fontkit';

const require = createRequire(import.meta.url);
const fontkit = require('fontkit') as typeof import('fontkit');
const FONT_PATH = fileURLToPath(new URL('../node_modules/geist/dist/fonts/geist-mono/GeistMono-Medium.ttf', import.meta.url));
const font = fontkit.openSync(FONT_PATH) as Font; // one .ttf, never a collection
const OUT = new URL('./', import.meta.url);
const ICON_OUT = new URL('./icons/', import.meta.url);
const README_OUT = new URL('./readme/', import.meta.url);

const f3 = (n: number) => Number(n.toFixed(3));
const deg = (r: number) => (r * 180) / Math.PI;

interface Pt {
  x: number;
  y: number;
}

// --- colour, read from the popup so the two cannot drift -------------------------

const POPUP = await readFile(new URL('../src/popup.html', import.meta.url), 'utf8');
function popupToken(name: string): string {
  const m = POPUP.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  if (!m) throw new Error(`src/popup.html has no --${name} hex colour; the brand build reads its palette from there`);
  return m[1].toLowerCase();
}
const ACCENT = popupToken('on'); // the underscore
const INK_DARK = popupToken('bg'); // toolbar icon ink on light toolbars
const INK_LIGHT = popupToken('text'); // toolbar icon ink on dark toolbars

// --- measured from the font ----------------------------------------------------

const XH = font.xHeight; // 532

/** Outer left stroke of "w", as the two ends of its straight outline segment (font units, y-up). */
function outerLeftStrokeOfW() {
  const g = font.glyphForCodePoint(0x77); // "w"
  let cur: Pt = { x: 0, y: 0 }; // every glyph path opens with moveTo
  let best: { a: Pt; b: Pt; len: number } | null = null;
  for (const c of g.path.commands) {
    if (c.command === 'moveTo') cur = { x: c.args[0], y: c.args[1] };
    else if (c.command === 'lineTo') {
      const nxt = { x: c.args[0], y: c.args[1] };
      const len = Math.hypot(nxt.x - cur.x, nxt.y - cur.y);
      const leftish = Math.min(cur.x, nxt.x) < g.advanceWidth / 3;
      const leansBack = (nxt.y - cur.y) * (nxt.x - cur.x) < 0; // "\" in screen terms
      if (leftish && leansBack && (!best || len > best.len)) best = { a: cur, b: nxt, len };
      cur = nxt;
    } else {
      const n = c.args.length;
      if (n >= 2) cur = { x: c.args[n - 2], y: c.args[n - 1] };
    }
  }
  if (!best) throw new Error("no outer-left stroke found in Geist Mono Medium's w");
  const [top, bottom] = best.a.y > best.b.y ? [best.a, best.b] : [best.b, best.a];
  return { top, bottom };
}
const W_EDGE = outerLeftStrokeOfW();
const EDGE_ANGLE = deg(Math.atan2(W_EDGE.top.y - W_EDGE.bottom.y, W_EDGE.bottom.x - W_EDGE.top.x)); // ≈79.04
const K = (W_EDGE.bottom.x - W_EDGE.top.x) / (W_EDGE.top.y - W_EDGE.bottom.y); // horizontal run per unit drop

/** Closest horizontal ink gap between two neighbouring glyphs, across the x-height band. */
function inkGap(pair: string): number {
  const run = font.layout(pair);
  const polys = run.glyphs.map((g) => {
    const out: Pt[][] = [];
    let poly: Pt[] = [], cur: Pt = { x: 0, y: 0 }; // replaced by the opening moveTo
    const push = (p: Pt) => { poly.push(p); cur = p; };
    for (const c of g.path.commands) {
      const a = c.args;
      if (c.command === 'moveTo') { poly = []; out.push(poly); push({ x: a[0], y: a[1] }); }
      else if (c.command === 'lineTo') push({ x: a[0], y: a[1] });
      else if (c.command === 'quadraticCurveTo') {
        const p0 = cur;
        for (let i = 1; i <= 16; i++) { const t = i / 16, u = 1 - t; push({ x: u * u * p0.x + 2 * u * t * a[0] + t * t * a[2], y: u * u * p0.y + 2 * u * t * a[1] + t * t * a[3] }); }
      } else if (c.command === 'bezierCurveTo') {
        const p0 = cur;
        for (let i = 1; i <= 16; i++) { const t = i / 16, u = 1 - t; push({ x: u ** 3 * p0.x + 3 * u * u * t * a[0] + 3 * u * t * t * a[2] + t ** 3 * a[4], y: u ** 3 * p0.y + 3 * u * u * t * a[1] + 3 * u * t * t * a[3] + t ** 3 * a[5] }); }
      }
    }
    return out;
  });
  const inkAt = (ps: Pt[][], y: number) => {
    const xs: number[] = [];
    for (const poly of ps) for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      if ((p.y <= y && q.y > y) || (q.y <= y && p.y > y)) xs.push(p.x + ((y - p.y) * (q.x - p.x)) / (q.y - p.y));
    }
    return xs.length < 2 ? null : { min: Math.min(...xs), max: Math.max(...xs) };
  };
  let best = Infinity;
  for (let y = 4; y < XH; y += 2) {
    const L = inkAt(polys[0], y), R = inkAt(polys[1], y);
    if (L && R) best = Math.min(best, run.positions[0].xAdvance + R.min - L.max);
  }
  return best;
}

// --- the leaf (64 grid) -------------------------------------------------------

const LEAF = {
  body: 'M32 6 C48 16 50 38 32 54 C14 38 16 16 32 6 Z',
  stem: 'M32 53 C31 57 29 60 25.5 62',
  vein: 'M32 50 L33.5 18',
  segs: [
    [{ x: 32, y: 6 }, { x: 48, y: 16 }, { x: 50, y: 38 }, { x: 32, y: 54 }],
    [{ x: 32, y: 54 }, { x: 14, y: 38 }, { x: 16, y: 16 }, { x: 32, y: 6 }],
  ],
  stemPts: [{ x: 32, y: 53 }, { x: 31, y: 57 }, { x: 29, y: 60 }, { x: 25.5, y: 62 }],
  cutAnchor: { x: 36, y: 14 }, // the cut keeps y >= x - 22: a 45° line in the leaf's own frame
  cutDeg: 45,
};
const keep = (p: Pt) => p.y >= p.x - 22;

/**
 * Stroke weights, in the leaf's own 64 grid. Placement (tilt, gaps, centring) is
 * always measured on REGULAR, so the reversed leaf sits in exactly the same spot
 * and only gets lighter.
 *   edge: how far the blade's outline, cut included, is pulled inward.
 */
interface Weights {
  stem: number;
  vein: number;
  edge: number;
}
const REGULAR: Weights = { stem: 3.6, vein: 1.8, edge: 0 };
const REVERSED: Weights = { stem: 3.0, vein: 2.2, edge: 0.3 }; // for a leaf that is light on a dark ground

/** 16px: the vein would be under half a pixel, so it goes; the stem is held at one pixel. */
const at16 = (w: Weights, leafScale: number, gridPerPx: number): Weights => ({ ...w, vein: 0, stem: f3(gridPerPx / leafScale) });

const cubic = (p: Pt[], t: number): Pt => {
  const u = 1 - t;
  return {
    x: u ** 3 * p[0].x + 3 * u * u * t * p[1].x + 3 * u * t * t * p[2].x + t ** 3 * p[3].x,
    y: u ** 3 * p[0].y + 3 * u * u * t * p[1].y + 3 * u * t * t * p[2].y + t ** 3 * p[3].y,
  };
};
const rot = (p: Pt, d: number): Pt => {
  const a = (d * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const x = p.x - 32, y = p.y - 32;
  return { x: 32 + x * c - y * s, y: 32 + x * s + y * c };
};

/** Every point of ink at REGULAR weight: the clipped blade, its straight cut face, and the round-capped stem. */
function leafInk({ withStem = true } = {}) {
  const body: Pt[] = [];
  for (const seg of LEAF.segs) for (let i = 0; i <= 2000; i++) body.push(cubic(seg, i / 2000));
  const pts = body.filter(keep);
  const f = (p: Pt) => p.y - p.x + 22;
  const face: Pt[] = [];
  for (let i = 0; i < body.length - 1; i++) {
    const a = f(body[i]), b = f(body[i + 1]);
    if (a * b < 0) {
      const t = a / (a - b);
      face.push({ x: body[i].x + (body[i + 1].x - body[i].x) * t, y: body[i].y + (body[i + 1].y - body[i].y) * t });
    }
  }
  pts.push(...face);
  const r = REGULAR.stem / 2;
  if (withStem) for (let i = 0; i <= 120; i++) {
    const c = cubic(LEAF.stemPts, i / 120);
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * 2 * Math.PI;
      pts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
    }
  }
  return { pts, face };
}
const bboxOf = (pts: Pt[]) => ({
  minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
  minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)),
});

/** Clip + mask definitions for one leaf, ids namespaced per file so marks can share a page. */
function leafDefs(ns: string, w: Weights): string {
  const shift = f3(w.edge * Math.SQRT2); // perpendicular inset of the 45° cut line
  const knock =
    (w.vein ? `<path d="${LEAF.vein}" stroke="#000" stroke-width="${w.vein}" stroke-linecap="round"/>` : '') +
    (w.edge ? `<path d="${LEAF.body}" fill="none" stroke="#000" stroke-width="${f3(2 * w.edge)}"/>` : '');
  return `<clipPath id="${ns}-cut"><polygon points="-20,${f3(-42 + shift)} 120,${f3(98 + shift)} 120,120 -20,120"/></clipPath>` +
    (knock ? `<mask id="${ns}-vein" maskUnits="userSpaceOnUse" x="-20" y="-20" width="104" height="104"><rect x="-20" y="-20" width="104" height="104" fill="#fff"/>${knock}</mask>` : '');
}
const leafMarkup = (ns: string, w: Weights, colour = 'currentColor') =>
  `<g clip-path="url(#${ns}-cut)"><path d="${LEAF.body}"${w.vein || w.edge ? ` mask="url(#${ns}-vein)"` : ''}/></g>` +
  `<path d="${LEAF.stem}" fill="none" stroke="${colour}" stroke-width="${w.stem}" stroke-linecap="round"/>`;

// --- 2. tilt ---------------------------------------------------------------------

const TILT = EDGE_ANGLE - LEAF.cutDeg; // ≈34.04

// --- bare mark ------------------------------------------------------------------

const BARE = (() => {
  const bb = bboxOf(leafInk().pts.map((p) => rot(p, TILT)));
  const s = 54 / Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY);
  return { s, tx: 32 - (s * (bb.minX + bb.maxX)) / 2, ty: 32 - (s * (bb.minY + bb.maxY)) / 2 };
})();

function markSvg(w: Weights, ns: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="currentColor" role="img" aria-label="winnower">
  <title>winnower</title>
  <defs>${leafDefs(ns, w)}</defs>
  <g transform="translate(${f3(BARE.tx)} ${f3(BARE.ty)}) scale(${f3(BARE.s)}) rotate(${f3(TILT)} 32 32)">${leafMarkup(ns, w)}</g>
</svg>
`;
}

// --- 5 + 6. chip ------------------------------------------------------------------

const TILE = { x: 8, w: 48, rx: 11, margin: 7 };
const TURN = -(90 - EDGE_ANGLE); // ≈-10.96
const LEAF_IN_TILE = TILT - TURN; // exactly 45° by construction

const CHIP = (() => {
  const ink = leafInk().pts.map((p) => rot(p, LEAF_IN_TILE));
  const bb = bboxOf(ink);
  const s = (TILE.w - 2 * TILE.margin) / (bb.maxX - bb.minX);
  const tileH = s * (bb.maxY - bb.minY) + 2 * TILE.margin;
  const tileY = 32 - tileH / 2;
  const tx = TILE.x + TILE.margin - s * bb.minX;
  const ty = tileY + TILE.margin - s * bb.minY;
  const placed = ink.map((p) => ({ x: tx + s * p.x, y: ty + s * p.y }));
  const gaps = {
    top: Math.min(...placed.map((p) => p.y)) - tileY,
    right: TILE.x + TILE.w - Math.max(...placed.map((p) => p.x)),
    bottom: tileY + tileH - Math.max(...placed.map((p) => p.y)),
    left: Math.min(...placed.map((p) => p.x)) - TILE.x,
  };
  return { s, tx, ty, tileY, tileH, gaps };
})();

/**
 * Toolbar icons are cropped to the turned tile itself, so it fills the icon like
 * other extensions' do instead of sitting in the SVG's 64 grid margin. Measured on
 * the rounded outline: each corner reaches exactly one radius past its arc centre.
 * The crop is square and centred, so the tile touches the edges along its longer side.
 */
const ICON_VIEW = (() => {
  const r = TILE.rx, top = CHIP.tileY, bottom = CHIP.tileY + CHIP.tileH;
  const centres = [[TILE.x + r, top + r], [TILE.x + TILE.w - r, top + r], [TILE.x + r, bottom - r], [TILE.x + TILE.w - r, bottom - r]]
    .map(([x, y]) => rot({ x, y }, TURN));
  const minX = Math.min(...centres.map((c) => c.x)) - r, maxX = Math.max(...centres.map((c) => c.x)) + r;
  const minY = Math.min(...centres.map((c) => c.y)) - r, maxY = Math.max(...centres.map((c) => c.y)) + r;
  const side = Math.max(maxX - minX, maxY - minY);
  const x = (minX + maxX) / 2 - side / 2, y = (minY + maxY) / 2 - side / 2;
  return { x, y, side, w: maxX - minX, h: maxY - minY, box: `${f3(x)} ${f3(y)} ${f3(side)} ${f3(side)}` };
})();

function chipSvg(w: Weights, ns: string, viewBox = '0 0 64 64'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="currentColor" role="img" aria-label="winnower">
  <title>winnower</title>
  <defs>
    ${leafDefs(ns, w)}
    <mask id="${ns}-knockout" maskUnits="userSpaceOnUse" x="-20" y="-20" width="104" height="104">
      <rect x="-20" y="-20" width="104" height="104" fill="#fff"/>
      <g fill="#000" transform="translate(${f3(CHIP.tx)} ${f3(CHIP.ty)}) scale(${f3(CHIP.s)}) rotate(${f3(LEAF_IN_TILE)} 32 32)">${leafMarkup(ns, w, '#000')}</g>
    </mask>
  </defs>
  <g transform="rotate(${f3(TURN)} 32 32)">
    <rect x="${TILE.x}" y="${f3(CHIP.tileY)}" width="${TILE.w}" height="${f3(CHIP.tileH)}" rx="${TILE.rx}" mask="url(#${ns}-knockout)"/>
  </g>
</svg>
`;
}

// --- 2 + 3 + 4. lockup ------------------------------------------------------------

const Y0 = 1000, X_TEXT = 1400;
const LOCK = (() => {
  const blade = leafInk({ withStem: false });
  const bladeBB = bboxOf(blade.pts.map((p) => rot(p, TILT)));
  const s = 740 / (bladeBB.maxY - bladeBB.minY);
  const full = bboxOf(leafInk().pts.map((p) => rot(p, TILT)));
  const gap = inkGap('ow');

  // Centre the whole icon on the middle of the x-height, then slide it along its own
  // cut line until the cut sits `gap` units from the w's edge.
  const ty = Y0 - XH / 2 - (s * (full.minY + full.maxY)) / 2;
  const P = rot(LEAF.cutAnchor, TILT);
  const edge = { x: X_TEXT + W_EDGE.top.x, y: Y0 - W_EDGE.top.y };
  const tx = edge.x - edge.y * K - gap - s * P.x + (ty + s * P.y) * K;

  const run = font.layout('winnower_');
  let x = X_TEXT, inkRight = -Infinity, inkTop = Infinity, inkBottom = -Infinity;
  const glyphs = run.glyphs.map((g, i) => {
    const isAccent = i === run.glyphs.length - 1;
    const d = `<path${isAccent ? ` fill="${ACCENT}"` : ''} transform="translate(${x} ${Y0}) scale(1 -1)" d="${g.path.toSVG()}"/>`;
    if (g.bbox.maxX > g.bbox.minX) {
      inkRight = Math.max(inkRight, x + g.bbox.maxX);
      inkTop = Math.min(inkTop, Y0 - g.bbox.maxY);
      inkBottom = Math.max(inkBottom, Y0 - g.bbox.minY);
    }
    x += run.positions[i].xAdvance;
    return d;
  });

  // Checks: the placed cut must be parallel to the w edge, at the measured gap.
  const face = blade.face.map((p) => rot(p, TILT)).map((p) => ({ x: tx + s * p.x, y: ty + s * p.y }));
  const [fa, fb] = face[0].y < face[1].y ? face : [face[1], face[0]];
  const faceAngle = deg(Math.atan2(fb.y - fa.y, fb.x - fa.x));
  const placedGap = edge.x + (fa.y - edge.y) * K - fa.x;

  // Tight to the ink on every side: clear space is a usage rule, not baked into the file.
  const minX = tx + s * full.minX;
  const minY = Math.min(ty + s * full.minY, inkTop);
  const maxY = Math.max(ty + s * full.maxY, inkBottom);
  const viewBox = `${f3(minX)} ${f3(minY)} ${f3(inkRight - minX)} ${f3(maxY - minY)}`;
  return {
    s, tx, ty, glyphs, viewBox, gap, placedGap, faceAngle,
    above: Y0 - (ty + s * full.minY) - XH, below: ty + s * full.maxY - Y0,
  };
})();

function lockupSvg(w: Weights, ns: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${LOCK.viewBox}" fill="currentColor" role="img" aria-label="winnower">
  <title>winnower</title>
  <defs>${leafDefs(ns, w)}</defs>
  <g transform="translate(${f3(LOCK.tx)} ${f3(LOCK.ty)}) scale(${f3(LOCK.s)}) rotate(${f3(TILT)} 32 32)">${leafMarkup(ns, w)}</g>
  ${LOCK.glyphs.join('\n  ')}
</svg>
`;
}

// --- write -------------------------------------------------------------------------

// "on-light" / "on-dark" names the background. The leaf is light where it is drawn
// in light ink (bare and lockup on dark) or cut out of a dark tile (chip on light).
const FILES = {
  'winnower-mark-on-light.svg': markSvg(REGULAR, 'wml'),
  'winnower-mark-on-dark.svg': markSvg(REVERSED, 'wmd'),
  'winnower-chip-on-light.svg': chipSvg(REVERSED, 'wcl'),
  'winnower-chip-on-dark.svg': chipSvg(REGULAR, 'wcd'),
  'winnower-lockup-on-light.svg': lockupSvg(REGULAR, 'wll'),
  'winnower-lockup-on-dark.svg': lockupSvg(REVERSED, 'wld'),
};
for (const [name, svg] of Object.entries(FILES)) await writeFile(new URL(name, OUT), svg, 'utf8');

// Toolbar icons. A PNG has no currentColor, so the ink is baked in from the popup palette.
const ICON_SIZES = [16, 32, 48, 128];
const ICONS: Array<{ ground: 'light' | 'dark'; ink: string; weights: Weights }> = [
  { ground: 'light', ink: INK_DARK, weights: REVERSED },
  { ground: 'dark', ink: INK_LIGHT, weights: REGULAR },
];
await mkdir(ICON_OUT, { recursive: true });
const iconReport: Array<{ name: string; bytes: number; tile: number; leaf: number; edgeL: number; edgeR: number }> = [];
for (const icon of ICONS) {
  for (const size of ICON_SIZES) {
    const w = size === 16 ? at16(icon.weights, CHIP.s, ICON_VIEW.side / 16) : icon.weights;
    const svg = chipSvg(w, `i${size}`, ICON_VIEW.box).replaceAll('currentColor', icon.ink);
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render();
    const bytes = png.asPng();
    await writeFile(new URL(`chip-on-${icon.ground}-${size}.png`, ICON_OUT), bytes);
    // Positive check: the tile is opaque ink at a point on the tile, and the leaf is
    // transparent at a point inside the blade — a broken mask fails one or the other.
    const px = png.pixels; // RGBA
    // Grid point → pixel alpha, through the icon crop.
    const at = (x: number, y: number) => {
      const pxX = Math.min(size - 1, Math.floor(((x - ICON_VIEW.x) * size) / ICON_VIEW.side));
      const pxY = Math.min(size - 1, Math.floor(((y - ICON_VIEW.y) * size) / ICON_VIEW.side));
      return px[(pxY * size + pxX) * 4 + 3];
    };
    // Fill: some ink must reach the outermost pixel column on both sides, or the crop left a margin.
    const column = (c: number) => Math.max(...Array.from({ length: size }, (_, row) => px[(row * size + c) * 4 + 3]));
    iconReport.push({
      name: `chip-on-${icon.ground}-${size}.png`, bytes: bytes.length,
      tile: at(13, 32), leaf: at(34, 30), edgeL: column(0), edgeR: column(size - 1),
    });
  }
}

// The popup header's logo. Loaded through <img>, where currentColor has nothing to
// inherit, so the popup's text colour is baked in the same way as the PNG ink.
const POPUP_LOCKUP = lockupSvg(REVERSED, 'wpl').replaceAll('currentColor', INK_LIGHT);
await writeFile(new URL('lockup-popup.svg', ICON_OUT), POPUP_LOCKUP, 'utf8');

// The README logo. GitHub renders README images through <img>, so these have ink baked in
// too; the README picks one with <picture> and prefers-color-scheme. Dark keeps the
// reversed (thinner) leaf, as every light-on-dark mark does.
const README_LOCKUPS = {
  'lockup-on-light.svg': lockupSvg(REGULAR, 'wrl').replaceAll('currentColor', INK_DARK),
  'lockup-on-dark.svg': lockupSvg(REVERSED, 'wrd').replaceAll('currentColor', INK_LIGHT),
};
await mkdir(README_OUT, { recursive: true });
for (const [name, svg] of Object.entries(README_LOCKUPS)) await writeFile(new URL(name, README_OUT), svg, 'utf8');

// --- verify ----------------------------------------------------------------------

const problems: string[] = [];
const near = (a: number, b: number, tol = 0.05) => Math.abs(a - b) <= tol;
if (!near(LOCK.faceAngle, EDGE_ANGLE)) problems.push(`lockup cut at ${LOCK.faceAngle.toFixed(2)}°, not parallel to the w (${EDGE_ANGLE.toFixed(2)}°)`);
if (!near(LOCK.placedGap, LOCK.gap)) problems.push(`lockup gap ${LOCK.placedGap.toFixed(2)}, expected ${LOCK.gap.toFixed(2)}`);
if (!near(LOCK.above, LOCK.below, 0.5)) problems.push(`lockup not centred: ${LOCK.above.toFixed(1)} above vs ${LOCK.below.toFixed(1)} below`);
if (!near(LEAF_IN_TILE, 45)) problems.push(`leaf sits at ${LEAF_IN_TILE.toFixed(2)}° in the tile, expected 45°`);
for (const [side, g] of Object.entries(CHIP.gaps)) if (!near(g, TILE.margin)) problems.push(`chip ${side} gap ${g.toFixed(2)}, expected ${TILE.margin}`);
if (POPUP_LOCKUP.includes('currentColor') || !POPUP_LOCKUP.includes(`fill="${INK_LIGHT}"`)) problems.push('icons/lockup-popup.svg: ink colour not baked in');
for (const [name, svg] of Object.entries(README_LOCKUPS)) {
  const ink = name.includes('light') ? INK_DARK : INK_LIGHT;
  if (svg.includes('currentColor') || !svg.includes(`fill="${ink}"`)) problems.push(`readme/${name}: ink colour not baked in`);
}
const readmeFiles = Object.fromEntries(Object.entries(README_LOCKUPS).map(([n, s]) => [`readme/${n}`, s]));
for (const [name, svg] of Object.entries({ ...FILES, 'icons/lockup-popup.svg': POPUP_LOCKUP, ...readmeFiles })) {
  const refs = [...svg.matchAll(/url\(#([\w-]+)\)/g)].map((m) => m[1]);
  for (const id of new Set(refs)) if (!svg.includes(`id="${id}"`)) problems.push(`${name}: references #${id}, which is not defined`);
}
for (const r of iconReport) {
  if (r.tile < 250) problems.push(`${r.name}: tile not opaque (alpha ${r.tile})`);
  if (r.leaf > 5) problems.push(`${r.name}: leaf not cut out (alpha ${r.leaf})`);
  if (r.edgeL < 20 || r.edgeR < 20) problems.push(`${r.name}: tile does not reach the icon edge (edge alpha ${r.edgeL}/${r.edgeR})`);
}

console.log('');
console.log(`  w outer-left edge  (${W_EDGE.top.x},${W_EDGE.top.y}) → (${W_EDGE.bottom.x},${W_EDGE.bottom.y}), ${EDGE_ANGLE.toFixed(2)}°`);
console.log(`  leaf tilt          ${TILT.toFixed(2)}°`);
console.log(`  lockup             cut ${LOCK.faceAngle.toFixed(2)}°, gap ${LOCK.placedGap.toFixed(2)} (o→w ${LOCK.gap.toFixed(2)}), ${LOCK.above.toFixed(1)} above / ${LOCK.below.toFixed(1)} below`);
console.log(`  chip               turn ${TURN.toFixed(2)}°, leaf ${LEAF_IN_TILE.toFixed(2)}° in tile, gaps ${Object.values(CHIP.gaps).map((g) => g.toFixed(2)).join(' / ')}, tile 48 × ${CHIP.tileH.toFixed(2)}`);
console.log(`  weights            regular stem ${REGULAR.stem} vein ${REGULAR.vein} · reversed stem ${REVERSED.stem} vein ${REVERSED.vein} edge −${REVERSED.edge} · 16px stem ${at16(REGULAR, CHIP.s, ICON_VIEW.side / 16).stem}, no vein`);
console.log(`  icon crop          tile ${ICON_VIEW.w.toFixed(2)} × ${ICON_VIEW.h.toFixed(2)} in a ${ICON_VIEW.side.toFixed(2)} square (was 64): ${(64 / ICON_VIEW.side).toFixed(2)}× larger`);
console.log(`  colour (popup)     underscore ${ACCENT} · icon ink ${INK_DARK} on light, ${INK_LIGHT} on dark`);
console.log('');
if (problems.length) {
  console.error('PROBLEMS:');
  for (const p of problems) console.error(`  ! ${p}`);
  process.exitCode = 1;
} else {
  console.log(`✓ ${Object.keys(FILES).length} SVGs in brand/; ${iconReport.length} PNGs + lockup-popup.svg in brand/icons/; 2 README lockups in brand/readme/ (tile opaque, leaf cut out, tile reaches the edge in every PNG)`);
}
