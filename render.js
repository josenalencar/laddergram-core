/**
 * Laddergram rendering: the ECG strip on top and the ladder right below it, on ONE canvas, sharing ONE
 * time→x mapping — so a QRS onset on the strip and its dot on tier V are the same x by construction.
 *
 * This is the renderer of both products. The viewer (Dante Laddergram) draws its ladders from the engine's
 * output in tier–time space; the public editor (Lewis Ladder) draws ladders it materialised as points and
 * connections in pixels. Both call `drawFrame`. The drawing is split accordingly: `resolve*` turns
 * tier–time into pixels, `draw*Px` paints pixels. The editor resolves its own elements and hands
 * `drawFrame` groups already in pixels (`groupsPx`); the viewer lets `drawFrame` resolve. Every stroke,
 * every font, every colour is then the same code — a figure in the review article and a figure exported
 * from the editor are made the same way. `test/render-golden.test.mjs` fingerprints what this draws.
 *
 * The canvas is a VIEWPORT: it only ever draws [t0, t0 + visible width]. A 5-min record at 25 mm/s ×
 * 4 px/mm is 30 000 CSS px — past what a browser canvas will allocate. The page puts a wide spacer in a
 * scroll container and redraws on scroll.
 *
 * No state here: every function takes what it draws. No DOM either: a canvas is created only through
 * `createCanvas`, which defaults to the document's when there is one.
 */
import { TIER_CATALOG, DEFAULT_TIERS } from './engine.js';

export const PX_PER_MM = 4;
export const LABEL_W = 60;

/**
 * Publication figures (PREMISES.md §5): a figure is exported for one print size, and the paper speed and
 * gain it states must be true at that size. `scale` = printed mm per canvas mm (0.5: the exported image is
 * printed at half its canvas size, i.e. 609.6 dpi for the 3× PNG). With a print scale set, an export draws
 * ECG-paper boxes of 1 printed mm and tags the tracing with the printed speed and gain; the drawn speed and
 * gain must then be standard values once scaled (STANDARD_SPEEDS, STANDARD_GAINS).
 */
export const PRINT = { scale: null };
export const STANDARD_SPEEDS = [12.5, 25, 50, 75, 100, 150, 200, 300]; // mm/s (200: the intracardiac sweep)
export const STANDARD_GAINS = [5, 10, 15, 20];                         // mm/mV (½, 1, 1½, 2 × standard)
export const printDpi = (scale) => 25.4 * PX_PER_MM * 3 / scale;       // dpi of the 3× PNG at that print scale
const fmtNum = (v) => String(Math.round(v * 100) / 100);
export const tierHeight = (id, catalog = TIER_CATALOG) => catalog[id]?.h ?? 30;
export const tierLabel = (id, catalog = TIER_CATALOG) => catalog[id]?.label ?? id;

// ─── the look ─────────────────────────────────────────────────────────────────
// Named once, so the editor's cheat sheet and the article's legend can say what they mean by "ink".
export const COLORS = Object.freeze({
    INK: '#0f172a',            // trace, paths, dots, names
    MUTED: '#334155',          // captions, footer, tags
    P: '#15803d',              // P-onset marks
    Q: '#1d4ed8',              // QRS-onset marks
    SEL: '#dc2626',            // the selected thing
    BRACKET: '#7c2d12',        // interval brackets: dark brown
    GRID_FINE: '#f6dede',
    GRID_BOLD: '#e8b4b4',
    PAGE: '#ffffff',
    PAPER: '#fffdf8',          // ECG paper behind the tracing
    BAND_ALT: '#f8fafc',       // every other tier band
    TIER_LINE: '#64748b',
    TIER_EDGE_DASHED: '#94a3b8',
    PASS: '#64748b',           // "traversed, no delay attributed here"
    RULE: '#94a3b8',           // the rule between the label column and the drawing
    HOLLOW: '#fff',            // the inside of a measured dot
    EGM_TIMELINE: '#e8ecf2',   // intracardiac channels: a time line every 100 ms
    EGM_TIMELINE_BOLD: '#cbd5e1',  // … and every second
    PERIOD_ERP: 'rgba(217, 119, 6, 0.20)',       // refractory periods (periods.js): certainly refractory
    PERIOD_ERP_EDGE: 'rgba(180, 83, 9, 0.55)',   // … their edge and the hatching of the span in which they recover
    PERIOD_CONCEAL: 'rgba(109, 40, 217, 0.16)',  // left refractory by concealed conduction
    PERIOD_CONCEAL_EDGE: 'rgba(91, 33, 182, 0.50)',
    PERIOD_TIMING: 'rgba(37, 99, 235, 0.13)',      // a pacemaker's own timing (AV delay, PVARP, VRP)
    PERIOD_TIMING_EDGE: 'rgba(29, 78, 216, 0.50)',
});
const INK = COLORS.INK, MUTED = COLORS.MUTED, COL_P = COLORS.P, COL_Q = COLORS.Q, COL_SEL = COLORS.SEL, BRACKET_COL = COLORS.BRACKET;
const GRID_FINE = COLORS.GRID_FINE, GRID_BOLD = COLORS.GRID_BOLD;

export const FONT_FAMILY = '-apple-system, "Segoe UI", sans-serif';
export const FONTS = Object.freeze({
    tier: `600 12px ${FONT_FAMILY}`,
    tierSmall: `600 10px ${FONT_FAMILY}`,
    letter: `700 14px ${FONT_FAMILY}`,
    title: `600 12px ${FONT_FAMILY}`,
    caption: `italic 12px ${FONT_FAMILY}`,
    pathLabel: `600 10px ${FONT_FAMILY}`,
    bracket: `600 11px ${FONT_FAMILY}`,
    footer: `11px ${FONT_FAMILY}`,
    lead: `600 12px ${FONT_FAMILY}`,
    tag: `10px ${FONT_FAMILY}`,
    tagPrint: `600 10px ${FONT_FAMILY}`,
    interval: `10px ${FONT_FAMILY}`,
    egmLetter: `700 11px ${FONT_FAMILY}`,
});

// ─── layout ───────────────────────────────────────────────────────────────────

/**
 * Vertical layout, CSS px from the canvas top. One ladder per group: group 0 is the editable one, the
 * others are stacked interpretations (layers) of the same strip, each with room above it for its title.
 */
export const CAPTION_LINE_H = 15;
/**
 * @param titles        reserve a title row above every ladder (letters / user titles)
 * @param captionLines  per ladder, number of caption lines to reserve under it
 */
export const LINE_GAP = 38;
/**
 * @param style         'bands' (a tier is the space between two lines) or
 *                      'lines' (a tier is a line; the last tier is the last line)
 * @param catalog       what a tier id means (label, height, parallel group); the engine's by default. The
 *                      editor adds its own entries for tiers a user named themselves.
 */
export const BRACKET_ROW_H = 30;
/**
 * The row a ladder's letter and title live in, above its first tier line.
 *
 * It used to be 26 with the words pinned 8 px above the line, which put their descenders within 2 px of
 * the dots drawn ON that line — so on a strip whose first activation is at the very start, the title and
 * the first dot were the same pixels. The words sit at the top of the row now, with the line well clear
 * below them, as the published figures have them.
 */
export const TITLE_ROW_H = 36;
/** Baseline of the letter and title, above the group's first tier line. */
export const TITLE_BASELINE = 18;

/** How many 15 px rows a caption takes: one per 140 characters, at most three. */
export const capLines = (c) => (c ? Math.min(3, Math.ceil(String(c).length / 140)) : 0);

/**
 * The intracardiac block (PREMISES.md §7): one row per channel, a row above the first His channel for the
 * letters A · H · V, and — when the AH and HV are shown — a bracket row right under the last His channel,
 * so the dimension lines sit next to the deflections they measure.
 */
export const EGM_ROW_H = 34;
export const EGM_LETTER_H = 14;
/** Pixels per unit of electrogram amplitude (a near-field deflection peaks at 1). */
export const EGM_GAIN_PX = 13;
/** What each channel is called in the label column. */
export const EGM_CHANNEL_LABELS = Object.freeze({
    HRA: 'HRA', His: 'His', Hisp: 'His p', Hisd: 'His d',
    CS910: 'CS 9-10', CS78: 'CS 7-8', CS56: 'CS 5-6', CS34: 'CS 3-4', CS12: 'CS 1-2',
    RVa: 'RVa', Stim: 'Stim', II: 'II', V1: 'V1',
});
const HIS_CHANNELS = ['His', 'Hisp', 'Hisd'];
/** Room above a block that is not the tracing when it is the first thing on the page. */
const BLOCK_TOP_PAD = 8;

/**
 * The blocks of a frame, top to bottom. Without intracardiac channels a frame is the tracing over the
 * ladder, as it always was; with them the reader chooses the order (a figure is printed the way it is
 * read). Unknown names and repeats are dropped, a missing block goes last.
 */
export function blockOrder(order, hasEgm = false) {
    const known = hasEgm ? ['strip', 'egm', 'ladder'] : ['strip', 'ladder'];
    const list = [];
    for (const b of Array.isArray(order) ? order : []) if (known.includes(b) && !list.includes(b)) list.push(b);
    for (const b of known) if (!list.includes(b)) list.push(b);
    return list;
}

function layoutEgm(top, channels, { letters = true, brackets = false } = {}) {
    let y = top;
    const rows = {};
    let lettersY = null, bracketTop = null;
    const his = channels.filter(c => HIS_CHANNELS.includes(c));
    for (const ch of channels) {
        if (letters && ch === his[0]) { y += EGM_LETTER_H; lettersY = y - 3; }
        rows[ch] = { top: y, bottom: y + EGM_ROW_H, mid: y + EGM_ROW_H / 2 };
        y += EGM_ROW_H;
        if (brackets && ch === his[his.length - 1]) { bracketTop = y; y += BRACKET_ROW_H; }
    }
    return { top, bottom: y, rows, channels: channels.slice(), lettersY, bracketTop };
}

/**
 * @param order  the blocks top to bottom, e.g. ['strip', 'egm', 'ladder'] (blockOrder)
 * @param egm    { channels: string[], letters?: boolean, brackets?: boolean } — the intracardiac block, or null
 */
export function makeLayout({ stripH = 160, gap = 26, groups = [DEFAULT_TIERS], groupGap = 30, footer = 30,
                             titles = false, captionLines = [], style = 'bands', styles = [], bracketRows = [],
                             catalog = TIER_CATALOG, order = null, egm = null } = {}) {
    // one style per ladder (a figure may show both kinds); `style` is the default
    const styleOf = (g) => (styles[g] === 'lines' || styles[g] === 'bands' ? styles[g] : style);
    const channels = egm && Array.isArray(egm.channels) ? egm.channels.filter(c => typeof c === 'string' && c) : [];
    const blocks = blockOrder(order, channels.length > 0);
    let y = 0, stripTop = 0, egmOut = null, out = null;
    blocks.forEach((block, bi) => {
        if (bi > 0) y += gap;
        else if (block !== 'strip') y += BLOCK_TOP_PAD;
        if (block === 'strip') { stripTop = y; y += stripH; return; }
        if (block === 'egm') { egmOut = layoutEgm(y, channels, egm); y = egmOut.bottom; return; }
        y += styleOf(0) === 'lines' ? 12 : 0;
        out = ladderGroups();
    });
    function ladderGroups() { return groups.map((tiers, g) => {
        const st = styleOf(g);
        if (titles) y += g > 0 ? TITLE_ROW_H + 10 : TITLE_ROW_H;   // title row (plus separation from the ladder above)
        else if (g > 0) y += groupGap;
        if (g > 0 && st === 'lines') y += 8;             // room for the dots and asterisks on the first line
        const top = y, bands = {};
        tiers.forEach((t, i) => {
            const h = st === 'lines' ? (i === tiers.length - 1 ? 0 : LINE_GAP) : tierHeight(t, catalog);
            bands[t] = { top: y, bottom: y + h }; y += h;
        });
        const bottom = y;
        let bracketTop = null;
        if (bracketRows[g]) { bracketTop = bottom + (st === 'lines' ? 12 : 6); y = bracketTop + BRACKET_ROW_H; }
        const nCap = captionLines[g] || 0;
        const captionTop = bracketTop != null ? y : bottom + (st === 'lines' ? 12 : 4);   // clear of the dots and asterisks on the V line
        if (nCap) y += nCap * CAPTION_LINE_H + (bracketTop != null ? 8 : st === 'lines' ? 16 : 8);
        else if (st === 'lines') y += 10;
        return { tiers: tiers.slice(), bands, top, bottom, captionTop, captionLines: nCap, style: st, bracketTop };
    }); }
    return { stripTop, stripH, gap, groupGap, groups: out, style: styleOf(0), catalog,
             bands: out[0].bands, tiers: out[0].tiers, ladderTop: out[0].top, ladderBottom: out[0].bottom,
             order: blocks, egm: egmOut,
             bottom: y, height: y + footer };
}

export function yOf(layout, tier, frac, g = 0) {
    const b = layout.groups[g]?.bands[tier];
    return b ? b.top + frac * (b.bottom - b.top) : NaN;
}

/** Is the boundary between two stacked tiers a parallel one (drawn dashed)? */
const parallelEdge = (a, b, catalog = TIER_CATALOG) => !!(catalog[a]?.group && catalog[a].group === catalog[b]?.group);

/** Horizontal mapping. x = labelW + (t − t0)·pxPerMs. */
export function makeView({ speedMmS = 25, t0Ms = 0, labelW = LABEL_W, gainMmMv = 10, gridMs = null } = {}) {
    const pxPerMs = speedMmS * PX_PER_MM / 1000;
    return {
        // gridMs: time of one small square. Real paper = 1000/speed; a "fit to
        // width" display keeps the 25 mm/s meaning (40 ms) and stretches it.
        speedMmS, t0Ms, labelW, pxPerMs, pxPerMm: PX_PER_MM, pxPerMv: gainMmMv * PX_PER_MM,
        gridMs: gridMs ?? 1000 / speedMmS, fit: gridMs != null,
        xOf: (t) => labelW + (t - t0Ms) * pxPerMs,
        tOf: (x) => t0Ms + (x - labelW) / pxPerMs,
    };
}

/** Which zone a y falls in: 'strip', 'egm', 'gap', a tier of the editable ladder, 'layer', or null. */
export function zoneOf(layout, y) {
    const st = layout.stripTop ?? 0, sb = st + layout.stripH;
    if (y >= st && y <= sb) return 'strip';
    const E = layout.egm;
    if (E && y >= E.top && y <= E.bottom) return 'egm';
    // the gap is the space under the tracing, down to whichever block comes next
    const egmBelow = E && E.top > sb ? E.top : Infinity;
    const inGap = (ladderBelow) => { const next = Math.min(ladderBelow, egmBelow); return next < Infinity && y > sb && y < next; };
    if ((layout.groups[0]?.style ?? layout.style) === 'lines') {
        // a tier is its line: the nearest line within half a gap
        let best = null;
        for (const t of layout.tiers) {
            const d = Math.abs(y - layout.bands[t].top);
            if (d <= LINE_GAP / 2 && (!best || d < best.d)) best = { t, d };
        }
        if (best) return best.t;
        if (inGap(layout.ladderTop > sb ? layout.ladderTop - LINE_GAP / 2 : Infinity)) return 'gap';
        if (layout.groups.slice(1).some(g => y >= g.top - layout.groupGap && y <= g.bottom + LINE_GAP / 2)) return 'layer';
        return null;
    }
    for (const t of layout.tiers) {
        const b = layout.bands[t];
        if (y >= b.top && y <= b.bottom) return t;
    }
    if (inGap(layout.ladderTop > sb ? layout.ladderTop : Infinity)) return 'gap';
    if (layout.groups.slice(1).some(g => y >= g.top - layout.groupGap && y <= g.bottom)) return 'layer';
    return null;
}

/**
 * Nearest editable marker to (x, y). Which kinds are eligible depends on the zone: an atrial band → P
 * onsets only; a ventricular band → QRS onsets only; strip / gap / AV bands → either. Layers are read-only.
 */
export function hitTest({ view, layout, beats, atrial }, x, y, tolPx = 7) {
    const zone = zoneOf(layout, y);
    // layers are read-only, and the intracardiac channels are drawn from the reading, not marked
    if (!zone || zone === 'layer' || zone === 'egm') return zone ? { zone } : null;
    const kind = (layout.catalog ?? TIER_CATALOG)[zone]?.kind ?? 'both';
    const wantA = kind !== 'ventricular';
    const wantV = kind !== 'atrial';
    let best = null;
    const consider = (k, id, t) => {
        const d = Math.abs(view.xOf(t) - x);
        if (d <= tolPx && (!best || d < best.d)) best = { kind: k, id, d };
    };
    if (wantA) for (const a of atrial) consider('atrial', a.id, a.tMs);
    if (wantV) for (const b of beats) consider('beat', b.id, b.qrsOnMs);
    return best ? { kind: best.kind, id: best.id, zone } : { zone };
}

// ─── px primitives ────────────────────────────────────────────────────────────

export function drawGrid(ctx, view, x0, x1, y0, y1) {
    const k = view.printScale ?? 1;                  // printed mm per canvas mm: a box is 1 printed mm
    const mmMs = view.printScale ? 1000 / (view.speedMmS * k) : (view.gridMs ?? 1000 / view.speedMmS);
    const boxPx = view.pxPerMm / k;
    const kStart = Math.floor(view.tOf(x0) / mmMs), kEnd = Math.ceil(view.tOf(x1) / mmMs);
    ctx.lineWidth = 1;
    for (let pass = 0; pass < 2; pass++) {          // fine first, bold on top
        ctx.strokeStyle = pass ? GRID_BOLD : GRID_FINE;
        ctx.beginPath();
        for (let k = kStart; k <= kEnd; k++) {
            if ((k % 5 === 0) !== !!pass) continue;
            const x = Math.round(view.xOf(k * mmMs)) + 0.5;
            if (x < x0 || x > x1) continue;
            ctx.moveTo(x, y0); ctx.lineTo(x, y1);
        }
        const mid = (y0 + y1) / 2;
        for (let j = -Math.ceil((mid - y0) / boxPx); j <= Math.ceil((y1 - mid) / boxPx); j++) {
            if ((Math.abs(j) % 5 === 0) !== !!pass) continue;
            const y = Math.round(mid + j * boxPx) + 0.5;
            if (y < y0 || y > y1) continue;
            ctx.moveTo(x0, y); ctx.lineTo(x1, y);
        }
        ctx.stroke();
    }
}

/**
 * The trace, min/max-enveloped per pixel column when there are several samples per pixel (25 mm/s at
 * 500 Hz is 20 samples per px) so no QRS peak is lost.
 */
export function drawTrace(ctx, { sig, fs, gaps }, view, x0, x1, yMid, pxPerMv, color = INK) {
    if (!sig || !sig.length) return;
    const sOf = (x) => view.tOf(x) * fs / 1000;
    const s0 = Math.max(0, Math.floor(sOf(x0))), s1 = Math.min(sig.length - 1, Math.ceil(sOf(x1)));
    if (s1 <= s0) return;
    const pxPerSamp = view.pxPerMs * 1000 / fs;
    ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    const yv = (v) => yMid - v * pxPerMv;
    if (pxPerSamp >= 0.8) {
        for (let s = s0; s <= s1; s++) {
            if (gaps && gaps[s]) { pen = false; continue; }
            const x = view.xOf(s * 1000 / fs), y = yv(sig[s]);
            pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y); pen = true;
        }
    } else {
        let col = Math.floor(view.xOf(s0 * 1000 / fs)), lo = Infinity, hi = -Infinity, first = null, last = null;
        const flush = () => {
            if (first === null) { pen = false; return; }
            pen ? ctx.lineTo(col, yv(first)) : ctx.moveTo(col, yv(first));
            ctx.lineTo(col, yv(hi)); ctx.lineTo(col, yv(lo)); ctx.lineTo(col, yv(last));
            pen = true;
        };
        for (let s = s0; s <= s1; s++) {
            const c = Math.floor(view.xOf(s * 1000 / fs));
            if (c !== col) { flush(); col = c; lo = Infinity; hi = -Infinity; first = null; }
            if (gaps && gaps[s]) { if (first !== null) flush(); first = null; pen = false; continue; }
            const v = sig[s];
            if (first === null) first = v;
            last = v; if (v < lo) lo = v; if (v > hi) hi = v;
        }
        flush();
    }
    ctx.stroke();
}

export function arrowHead(ctx, x, y, ux, uy, size = 7) {
    const a = Math.atan2(uy, ux);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - size * Math.cos(a - Math.PI / 7), y - size * Math.sin(a - Math.PI / 7));
    ctx.lineTo(x - size * Math.cos(a + Math.PI / 7), y - size * Math.sin(a + Math.PI / 7));
    ctx.closePath(); ctx.fill();
}

/** The block bar: the wave stopped here. 14 px, across the direction it was travelling. */
export function drawBlockBarPx(ctx, ex, ey, ux, uy) {
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(ex - uy * 7, ey + ux * 7); ctx.lineTo(ex + uy * 7, ey - ux * 7);
    ctx.stroke();
}

/**
 * One path, in pixels.
 * @param p  { sx, sy, ex, ey, style: 'solid'|'dashed'|'wavy'|'pass', terminal: 'point'|'block'|'open',
 *             arrow: 'none'|'end', curve, color, label, labelAnchor, labelSide, highlight }
 * @param labelled  per-group label bookkeeping: a Set of texts already placed, with `.minX` (labels do not
 *                  run under the tier names) and `.boxes` (what is already occupied)
 */
export function drawPathPx(ctx, p, labelled) {
    const { sx, sy, ex, ey, highlight } = p;
    if (p.style === 'pass') {
        // "traversed, no delay attributed here": thin, quiet, no ends
        ctx.save();
        ctx.strokeStyle = highlight ? COL_SEL : COLORS.PASS; ctx.globalAlpha = highlight ? 0.9 : 0.75; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
        ctx.restore();
        return;
    }
    const dx = ex - sx, dy = ey - sy, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const color = highlight ? COL_SEL : (p.color || INK);
    ctx.strokeStyle = color; ctx.fillStyle = color;
    // 'dotted' and 'bold' are the author's emphasis, nothing more (PREMISES §3): dotted is round dots, clearly
    // unlike the dash that means concealed conduction; bold is a heavier solid line
    ctx.lineWidth = highlight ? 2.4 : p.style === 'bold' ? 2.8 : 1.6; ctx.lineCap = 'round';
    ctx.setLineDash(p.style === 'dashed' ? [4, 3] : p.style === 'dotted' ? [0.1, 3.4] : []);
    const curved = p.style !== 'wavy' && Math.abs(p.curve || 0) > 0.01;
    const cx = (sx + ex) / 2 + nx * (p.curve || 0), cy = (sy + ey) / 2 + ny * (p.curve || 0);
    ctx.beginPath();
    if (p.style === 'wavy') {
        const cycles = Math.max(2, Math.round(len / 9)), steps = cycles * 10, amp = 2.4;
        for (let i = 0; i <= steps; i++) {
            const u = i / steps, off = Math.sin(u * cycles * 2 * Math.PI) * amp;
            const x = sx + dx * u + nx * off, y = sy + dy * u + ny * off;
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
    } else {
        ctx.moveTo(sx, sy);
        curved ? ctx.quadraticCurveTo(cx, cy, ex, ey) : ctx.lineTo(ex, ey);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // end direction (tangent at the end)
    let ux = curved ? ex - cx : dx, uy = curved ? ey - cy : dy;
    const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
    if (p.terminal === 'block') drawBlockBarPx(ctx, ex, ey, ux, uy);
    if (p.arrow === 'end') arrowHead(ctx, ex, ey, ux, uy);
    // Each label (slow / fast / AP) once per frame — on every beat it is noise.
    // …and on a path that is wholly on screen (not clipped under the label column)
    if (p.label && !labelled.has(p.label) && Math.hypot(ex - sx, ey - sy) > 14 && Math.min(sx, ex) > (labelled.minX ?? -Infinity)) {
        ctx.font = FONTS.pathLabel;
        ctx.fillStyle = color;
        const [ldx, ldy] = p.labelOffset || [0, 0];       // the editor lets a label be dragged; the offset rides on the placement
        if (p.labelAnchor === 'end-right' || p.labelAnchor === 'start-below-right') {
            // short lines of text: just right of where the path ends, or right of and below where it starts
            // (the free corner between a vertical V line and the path leaving it)
            labelled.add(p.label);
            ctx.textAlign = 'left';
            let [lx, ly] = p.labelAnchor === 'end-right' ? [ex + 5 + ldx, ey + 11 + ldy] : [sx + 4 + ldx, sy + 10 + ldy];
            const lines = p.label.split('\n'), w = Math.max(...lines.map(l => ctx.measureText(l).width));
            labelled.boxes = labelled.boxes || [];
            labelled.ids = labelled.ids || [];
            // Anchored text claimed its space without ever checking it. Nudge it down a line at a time
            // until it clears the tier lines and the labels already placed, then give up gracefully.
            const boxAt = (y) => [lx - 2, y - 9, lx + w + 2, y + lines.length * 11];
            const clash = (b) => labelled.boxes.some(q => b[0] < q[2] && q[0] < b[2] && b[1] < q[3] && q[1] < b[3])
                || (labelled.rules || []).some(r => r > b[1] - 1 && r < b[3] + 1);
            for (let k = 0; k < 3 && clash(boxAt(ly)); k++) ly += 11;
            labelled.boxes.push(boxAt(ly));
            labelled.ids.push(p.id ?? null);
            p.label.split('\n').forEach((ln, i) => ctx.fillText(ln, lx, ly + i * 11));
            return;
        }
        // Clear of the line it labels, of the tier lines, of the tier names and of the other labels: half
        // the text width more when the segment is steep, then either side, then along the path. A word that
        // sits on a tier line is unreadable, so the tier lines are obstacles like anything else — but the
        // last resort is still to draw it somewhere rather than to drop it in silence.
        const tw = ctx.measureText(p.label).width;
        const off0 = 9 + (tw / 2) * Math.abs(dy) / len;
        labelled.boxes = labelled.boxes || [];
        labelled.ids = labelled.ids || [];
        const rules = labelled.rules || [];
        const hits = (b) => labelled.boxes.some(q => b[0] < q[2] && q[0] < b[2] && b[1] < q[3] && q[1] < b[3]);
        const onRule = (b) => rules.some(y => y > b[1] - 1 && y < b[3] + 1);
        let mx, my, box = null, fallback = null;
        // along the path first at its middle, then either side of the thirds: a label pushed along the
        // line still reads as belonging to it, where one pushed far off it does not
        for (const at of [0.5, 0.34, 0.66]) {
            for (const side of [p.labelSide ?? 1, -(p.labelSide ?? 1)]) {
                const x = sx + dx * at + nx * off0 * side + ldx, y = sy + dy * at + ny * off0 * side + ldy;
                const b = [x - tw / 2 - 2, y - 7, x + tw / 2 + 2, y + 7];
                if (x - tw / 2 < (labelled.minX ?? -Infinity) - 8) continue;
                if (!fallback) { fallback = { mx: x, my: y, box: b }; }
                if (hits(b) || onRule(b)) continue;
                mx = x; my = y; box = b; break;
            }
            if (box) break;
        }
        if (!box && fallback) ({ mx, my, box } = fallback);
        if (!box) return;
        labelled.boxes.push(box);
        labelled.ids.push(p.id ?? null);
        labelled.add(p.label);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(p.label, mx, my);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
}

export function drawAsterisk(ctx, x, y, r = 5.5) {
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
        const a = k * Math.PI / 3 + Math.PI / 2;
        ctx.moveTo(x - r * Math.cos(a), y - r * Math.sin(a));
        ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
    }
    ctx.stroke();
}

/**
 * One event, in pixels: a dot (hollow when the tracing fixes it — a measured onset — filled when it is
 * inferred), an asterisk for a focus, or nothing.
 * @param e  { x, y, style: 'dot'|'asterisk'|'stim'|'none', hollow, highlight }
 */
/**
 * A pacemaker stimulus: a spike with a zig-zag, centred on the moment it fired — not a dot (an activation
 * the heart made) and not an asterisk (a focus). PREMISES §9.
 */
export function drawStimulus(ctx, x, y, h = 7) {
    ctx.save();
    ctx.lineWidth = 1.6; ctx.lineJoin = 'miter'; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x + 2.5, y - h); ctx.lineTo(x - 2.5, y + 0.8); ctx.lineTo(x + 2.5, y - 0.8); ctx.lineTo(x - 2.5, y + h);
    ctx.stroke();
    ctx.restore();
}

export function drawEventPx(ctx, e) {
    if (e.style === 'none') return;
    // A dot may carry its own colour, as a path does. Selection still wins: what is highlighted has to
    // look highlighted whatever colour the reader gave it.
    ctx.strokeStyle = ctx.fillStyle = e.highlight ? COL_SEL : (e.color || INK);
    if (e.style === 'asterisk') { drawAsterisk(ctx, e.x, e.y); return; }
    if (e.style === 'stim') { drawStimulus(ctx, e.x, e.y); return; }
    ctx.beginPath(); ctx.arc(e.x, e.y, 3.3, 0, Math.PI * 2);
    if (e.hollow) { ctx.fillStyle = COLORS.HOLLOW; ctx.fill(); ctx.lineWidth = 1.6; ctx.stroke(); }
    else ctx.fill();
}

export function text(ctx, s, x, y, { color = MUTED, font = FONTS.footer, align = 'center' } = {}) {
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align;
    ctx.fillText(s, x, y);
    ctx.textAlign = 'left';
}

/** Word-wrap `s` into at most `max` lines of width ≤ w (canvas font must be set). */
export function wrapLines(ctx, s, w, max) {
    const words = String(s).split(/\s+/).filter(Boolean), lines = [];
    let cur = '';
    for (const wd of words) {
        const next = cur ? cur + ' ' + wd : wd;
        if (ctx.measureText(next).width <= w || !cur) cur = next;
        else { lines.push(cur); cur = wd; if (lines.length === max) break; }
    }
    if (lines.length < max && cur) lines.push(cur);
    if (lines.length === max && words.join(' ').length > lines.join(' ').length) lines[max - 1] = lines[max - 1].replace(/\s*\S*$/, ' …');
    return lines;
}

/** The y of every line this group draws across the page: what a label must not be written on top of. */
export function tierRules(layout, g) {
    const G = layout.groups[g];
    if (!G) return [];
    const lineStyle = (G.style ?? layout.style) === 'lines';
    const ys = G.tiers.map(t => G.bands[t].top);
    if (!lineStyle) ys.push(G.bottom);
    return ys;
}

/**
 * The frame of one ladder: its bands or lines, the closing line, its letter and title above, its caption
 * below. Nothing of the ladder itself.
 */
export function drawTierGroup(ctx, layout, g, { x0, x1, letter = null, title = null, caption = null } = {}) {
    const G = layout.groups[g];
    if (!G) return;
    const catalog = layout.catalog ?? TIER_CATALOG;
    const lineStyle = (G.style ?? layout.style) === 'lines';
    if (!lineStyle) G.tiers.forEach((t, i) => {
        const b = G.bands[t];
        ctx.fillStyle = i % 2 ? COLORS.BAND_ALT : COLORS.PAGE;
        ctx.fillRect(x0, b.top, x1 - x0, b.bottom - b.top);
    });
    ctx.lineWidth = 1;
    if (lineStyle) {
        ctx.strokeStyle = COLORS.TIER_LINE;
        for (const t of G.tiers) { const y = Math.round(G.bands[t].top) + 0.5; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); }
    } else G.tiers.forEach((t, i) => {
        const y = Math.round(G.bands[t].top) + 0.5;
        const dashed = i > 0 && parallelEdge(G.tiers[i - 1], t, catalog);
        ctx.strokeStyle = dashed ? COLORS.TIER_EDGE_DASHED : COLORS.TIER_LINE;
        ctx.setLineDash(dashed ? [3, 3] : []);
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.strokeStyle = COLORS.TIER_LINE;
    if (!lineStyle) {
        const yb = Math.round(G.bottom) + 0.5;
        ctx.beginPath(); ctx.moveTo(x0, yb); ctx.lineTo(x1, yb); ctx.stroke();
    }
    if (letter || title) {
        let x = x0 + 6;
        if (letter) {
            ctx.font = FONTS.letter;
            text(ctx, letter, x, G.top - TITLE_BASELINE, { align: 'left', color: INK, font: ctx.font });
            x += ctx.measureText(letter).width + 8;
        }
        if (title) text(ctx, title, x, G.top - TITLE_BASELINE, { align: 'left', color: INK, font: FONTS.title });
    }
    if (caption && G.captionLines) {
        ctx.font = FONTS.caption;
        const lines = wrapLines(ctx, caption, Math.max(120, x1 - x0 - 12), G.captionLines);
        lines.forEach((ln, i) => text(ctx, ln, x0 + 6, G.captionTop + 11 + i * CAPTION_LINE_H, { align: 'left', color: MUTED, font: ctx.font }));
    }
}

// ─── tier–time → px ───────────────────────────────────────────────────────────

/**
 * A ladder's paths and events, in pixels, ready for drawResolvedGroup. This is where the viewer's
 * tier–time geometry meets the canvas; the editor builds the same shape from its own elements.
 */
export function resolveGroup(ladder, view, layout, g, { selected = null, visible, x0, x1 } = {}) {
    const G = layout.groups[g];
    if (!G || !ladder) return { paths: [], events: [] };
    const selId = selected?.id;
    const hot = (p) => !!(selId && (p.beatId === selId || p.atrialId === selId));
    const paths = [];
    for (const p of ladder.paths) {
        if (!visible(p.from.tMs) && !visible(p.to.tMs) &&
            !(view.xOf(Math.min(p.from.tMs, p.to.tMs)) < x0 && view.xOf(Math.max(p.from.tMs, p.to.tMs)) > x1)) continue;
        if (!G.bands[p.from.tier] || !G.bands[p.to.tier]) continue;
        paths.push({
            sx: view.xOf(p.from.tMs), sy: yOf(layout, p.from.tier, p.from.frac, g),
            ex: view.xOf(p.to.tMs), ey: yOf(layout, p.to.tier, p.to.frac, g),
            style: p.style, terminal: p.terminal, arrow: p.arrow, curve: p.curve, color: p.color,
            label: p.label, labelAnchor: p.labelAnchor, labelSide: p.labelSide, highlight: hot(p),
        });
    }
    const events = [];
    for (const e of ladder.events) {
        if (e.style === 'none' || !visible(e.tMs) || !G.bands[e.tier]) continue;
        events.push({
            x: view.xOf(e.tMs), y: yOf(layout, e.tier, e.frac, g),
            style: e.style === 'asterisk' || e.style === 'stim' ? e.style : 'dot',
            // Open = measured on the tracing, filled = inferred. The engine says which by where the mark
            // came from; a reader restyling one dot says it outright, and a colour travels the same way.
            hollow: e.hollow != null ? !!e.hollow : e.source === 'user',
            highlight: !!(selId && (e.beatId === selId || e.atrialId === selId)),
            ...(e.color ? { color: e.color } : {}),
        });
    }
    return { paths, events };
}

/** Paths first, then events, so dots sit on top of lines. Labels are placed as the paths are drawn. */
export function drawResolvedGroup(ctx, resolved, { x0, rules = [] } = {}) {
    const labelled = new Set();
    labelled.minX = x0 + 12;
    labelled.rules = rules;                     // the tier lines of this group: a label never sits on one
    labelled.ids = [];                          // which path each placed label belongs to, box for box
    for (const p of resolved.paths) drawPathPx(ctx, p, labelled);
    for (const e of resolved.events) drawEventPx(ctx, e);
    return labelled;
}

/**
 * Dimension lines for a teaching figure, in tier–time: each bracket spans [t0, t1] on the ladder's
 * bracket row (or, row 'strip', in the gap under the tracing), with dotted guides up to the ladder points
 * it measures. { t0, t1, label, at0, at1 } where at = { tier, frac } names the point a guide starts from.
 */
export function resolveBrackets(brackets, view, layout, g) {
    const G = layout.groups[g];
    const out = [];
    const rowBrackets = brackets.filter(b => b.row !== 'strip');
    for (const b of brackets) {
        const onStrip = b.row === 'strip';
        if (!onStrip && G.bracketTop == null) continue;
        const y = onStrip ? (layout.stripTop ?? 0) + layout.stripH + 8 : G.bracketTop + 8;
        const xa = view.xOf(b.t0), xb = view.xOf(b.t1);
        const guides = [];
        for (const [x, at] of [[xa, b.at0], [xb, b.at1]]) {
            if (!at) continue;
            const y0 = at.tier === 'strip' ? (layout.stripTop ?? 0) + layout.stripH * 0.58 : yOf(layout, at.tier, at.frac ?? 0, g);
            if (!Number.isFinite(y0)) continue;
            guides.push({ x, y0 });
        }
        const k = rowBrackets.indexOf(b), last = rowBrackets.length - 1;
        // A bracket on a figure is a drawn element like any other: the reader may recolour it, retype it
        // and move its label off a collision. What they have not touched keeps the house style.
        out.push({ xa, xb, y: y + (b.dy || 0), guides, label: b.label, onStrip, first: k === 0, interior: k > 0 && k < last,
                   ...(b.color ? { color: b.color } : {}), ...(b.labelDx ? { labelDx: b.labelDx } : {}), ...(b.labelDy ? { labelDy: b.labelDy } : {}) });
    }
    return out;
}

/**
 * Refractory periods (periods.js) in pixels: one box per period inside its tier's band — in the 'lines' style
 * the band is the strip between the tier's line and the next one, where the ladder draws that level's
 * conduction. { x0, x1, x1Hi, y0, y1, kind }. A period whose tier the group does not have is left out.
 */
export function resolvePeriods(periods, view, layout, g) {
    const G = layout.groups[g];
    const out = [];
    if (!G || !periods?.length) return out;
    for (const p of periods) {
        const b = G.bands[p.tier];
        if (!b || !(b.bottom > b.top)) continue;
        const x0 = view.xOf(p.t0Ms), x1 = view.xOf(p.t1Ms), x1Hi = view.xOf(p.t1HiMs ?? p.t1Ms);
        if (![x0, x1, x1Hi].every(Number.isFinite)) continue;
        out.push({ x0, x1, x1Hi: Math.max(x1, x1Hi), y0: b.top + 2, y1: b.bottom - 2, kind: p.kind });
    }
    return out;
}

/**
 * Periods behind the ladder: a tinted box while the structure is certainly refractory, hatching over the span
 * in which it recovers. Painted before the paths, so a line through a period is never covered; no text of its
 * own (the legend and the notes say what the shading means), so nothing is written over anything else.
 */
export function drawPeriodsPx(ctx, list) {
    if (!list?.length) return;
    ctx.save();
    for (const r of list) {
        const fill = r.kind === 'conceal' ? COLORS.PERIOD_CONCEAL : r.kind === 'timing' ? COLORS.PERIOD_TIMING : COLORS.PERIOD_ERP;
        const edge = r.kind === 'conceal' ? COLORS.PERIOD_CONCEAL_EDGE : r.kind === 'timing' ? COLORS.PERIOD_TIMING_EDGE : COLORS.PERIOD_ERP_EDGE;
        const h = r.y1 - r.y0;
        ctx.fillStyle = fill;
        ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, h);
        ctx.strokeStyle = edge;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(r.x0 + 0.5, r.y0); ctx.lineTo(r.x0 + 0.5, r.y1); ctx.stroke();
        if (r.x1Hi > r.x1 + 1) {
            // the span in which it recovers: hatched, clipped to its box
            ctx.save();
            ctx.beginPath(); ctx.rect(r.x1, r.y0, r.x1Hi - r.x1, h); ctx.clip();
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            for (let x = r.x1 - h; x < r.x1Hi; x += 6) { ctx.moveTo(x, r.y1); ctx.lineTo(x + h, r.y0); }
            ctx.stroke();
            ctx.restore();
            ctx.setLineDash([2, 2]);
            ctx.beginPath(); ctx.moveTo(r.x1Hi - 0.5, r.y0); ctx.lineTo(r.x1Hi - 0.5, r.y1); ctx.stroke();
            ctx.setLineDash([]);
        }
    }
    ctx.restore();
}

/**
 * The brackets of one ladder, in pixels: guides, the dimension line with inward arrowheads, the label.
 * Returns the box each label was drawn in, so an editor can let the reader take hold of it.
 */
export function drawBracketsPx(ctx, list) {
    const boxes = [];
    if (!list.length) return boxes;
    const font = FONTS.bracket;
    ctx.font = font;
    // Where a label has already been written on this row. Two brackets of the same beat sit side by side
    // and their labels are wider than the spans they belong to, so without this the words print on top of
    // each other -- which is what "HV 43" and "VA 69" did to one another on a figure with three beats
    // measured. A label that would collide drops to the next line rather than being centred over the mess.
    const written = [];
    const collides = (b) => written.some(w => b[0] < w[2] + 3 && b[2] > w[0] - 3 && b[1] < w[3] + 2 && b[3] > w[1] - 2);
    const LINE = 12;
    for (let i = 0; i < list.length; i++) {
        const b = list[i];
        const { xa, xb, y } = b;
        const col = b.color || BRACKET_COL;
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
        // guides
        ctx.setLineDash([2, 2]);
        for (const gd of b.guides) {
            ctx.beginPath(); ctx.moveTo(Math.round(gd.x) + 0.5, gd.y0); ctx.lineTo(Math.round(gd.x) + 0.5, y); ctx.stroke();
        }
        ctx.setLineDash([]);
        // the dimension line with inward arrowheads
        ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xb, y); ctx.stroke();
        const head = (x, dir) => { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + dir * 5, y - 3); ctx.lineTo(x + dir * 5, y + 3); ctx.closePath(); ctx.fill(); };
        if (xb - xa > 14) { head(xa, 1); head(xb, -1); }
        ctx.beginPath(); ctx.moveTo(xa, y - 4); ctx.lineTo(xa, y + 4); ctx.moveTo(xb, y - 4); ctx.lineTo(xb, y + 4); ctx.stroke();
        // the label sits under its bracket when it fits; a short bracket at either end of the row puts
        // it outside (left of the first, right of the last) so neighbouring labels never collide
        if (!b.label) continue;
        const w = ctx.measureText(b.label).width;
        const dx = b.labelDx || 0, dy = b.labelDy || 0;
        let lx, ly, align;
        if (w + 6 <= xb - xa || b.onStrip || b.interior) { lx = (xa + xb) / 2 + dx; ly = y + 15 + dy; align = 'center'; }
        else if (b.first) { lx = xa - 6 + dx; ly = y + 4 + dy; align = 'right'; }
        else { lx = xb + 6 + dx; ly = y + 4 + dy; align = 'left'; }
        const x0 = align === 'center' ? lx - w / 2 : align === 'right' ? lx - w : lx;
        let box = [x0 - 2, ly - 11, x0 + w + 2, ly + 3];
        for (let row = 0; row < 3 && collides(box); row++) {
            ly += LINE;
            box = [box[0], box[1] + LINE, box[2], box[3] + LINE];
        }
        text(ctx, b.label, lx, ly, { font, color: col, align });
        written.push(box);
        boxes.push({ i, box });
    }
    return boxes;
}

/**
 * One ladder (group g of the layout): frame, paths, events, intervals, brackets — from the engine's
 * tier–time output. Group 0 is the editable ladder (selection highlight, intervals); others are read-only
 * layers with their title above.
 */
export function drawLadderGroup(ctx, view, layout, g, ladder, { selected = null, showIntervals = false, x0, x1, visible, title = null, letter = null, caption = null, beats = [], atrial = [], brackets = null, frameDrawn = false } = {}) {
    const G = layout.groups[g];
    if (!G) return;
    // The caller may have drawn every frame already, so that no group's band fill lands on the group
    // above's text. Left alone it draws its own, as it always did.
    if (!frameDrawn) drawTierGroup(ctx, layout, g, { x0, x1, letter, title, caption });
    if (!ladder) return;
    drawResolvedGroup(ctx, resolveGroup(ladder, view, layout, g, { selected, visible, x0, x1 }), { x0, rules: tierRules(layout, g) });
    // a beat carrying the PR bracket does not also get the plain PR text
    const bracketQ = (brackets || []).filter(b => b.row === 'strip').map(b => b.t1);
    if (showIntervals) drawIntervals(ctx, view, layout, ladder, beats, atrial, visible, bracketQ);
    if (brackets?.length) drawBracketsPx(ctx, resolveBrackets(brackets, view, layout, g));
}

// ─── markers ──────────────────────────────────────────────────────────────────

/**
 * The P and QRS onsets on the strip, in pixels: which x, which colour, whether the user placed it, and the
 * tier top the guide runs down to.
 */
export function resolveMarkers({ beats = [], atrial = [] }, view, layout, { selected = null, visible = () => true } = {}) {
    const isSel = (kind, id) => !!(selected && selected.kind === kind && selected.id === id);
    const out = [];
    for (const a of atrial) if (visible(a.tMs)) out.push({ x: Math.round(view.xOf(a.tMs)) + 0.5, color: COL_P, sel: isSel('atrial', a.id), user: a.source === 'user', tierTop: layout.bands.A.top });
    for (const b of beats) if (visible(b.qrsOnMs)) out.push({ x: Math.round(view.xOf(b.qrsOnMs)) + 0.5, color: COL_Q, sel: isSel('beat', b.id), user: b.source === 'user', tierTop: layout.bands.V.top });
    return out;
}

/**
 * One marker: a line (or tick) over the tracing, a dashed guide down to its tier, the handle at the foot.
 * @param strip  the strip's height (a strip at the top of the page), or { top, h, guide } — `guide: false`
 *               when something else is drawn between the tracing and the ladder (the intracardiac channels)
 *               or the ladder sits above the tracing: a guide would then run across it
 */
export function drawMarkerPx(ctx, m, strip, markerLines) {
    const top = typeof strip === 'number' ? 0 : (strip?.top ?? 0);
    const stripH = typeof strip === 'number' ? strip : strip.h;
    const guide = typeof strip === 'number' ? true : strip.guide !== false;
    // dy drops a handle into a second row. A P onset and a QRS onset can fall at the same millisecond on a
    // fast rhythm, and two triangles at one x are one triangle: neither can be seen or aimed at.
    const { x, color, sel, user, tierTop, dy = 0 } = m;
    const bottom = top + stripH;
    const foot = bottom + dy;
    ctx.strokeStyle = sel ? COL_SEL : color;
    ctx.globalAlpha = sel ? 1 : 0.55;
    ctx.lineWidth = sel ? 2.2 : 1.2;
    // full line across the tracing (editing), or — figures — only a short tick above the handle
    ctx.beginPath(); ctx.moveTo(x, markerLines || sel ? top : bottom - 16); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.globalAlpha = 0.35; ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
    if (guide) { ctx.beginPath(); ctx.moveTo(x, bottom); ctx.lineTo(x, tierTop); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // handle at the strip foot: filled = auto, hollow = user
    ctx.fillStyle = sel ? COL_SEL : color;
    ctx.beginPath(); ctx.moveTo(x, foot - 9); ctx.lineTo(x - 5, foot); ctx.lineTo(x + 5, foot); ctx.closePath();
    if (user) { ctx.fillStyle = COLORS.HOLLOW; ctx.fill(); ctx.strokeStyle = sel ? COL_SEL : color; ctx.lineWidth = 1.5; ctx.stroke(); }
    else ctx.fill();
}

// ─── the label column and the footer ──────────────────────────────────────────

/**
 * The white column at the left with the rule, the lead name, and the tag lines under it. `top` is where the
 * tracing starts: the lead name and its speed and gain are written beside it, wherever it is on the page.
 */
export function drawLabelColumn(ctx, x0, H, bottom, { lead = '', tags = [], top = 0 } = {}) {
    ctx.fillStyle = COLORS.PAGE; ctx.fillRect(0, 0, x0, H);
    ctx.strokeStyle = COLORS.RULE; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0 - 0.5, 0); ctx.lineTo(x0 - 0.5, bottom); ctx.stroke();
    text(ctx, lead || '', 6, top + 16, { color: INK, font: FONTS.lead, align: 'left' });
    for (const t of tags) text(ctx, t.text, 6, top + t.y, { align: 'left', font: t.font, ...(t.color ? { color: t.color } : {}) });
}

/** Every tier's name, right-aligned against the rule, for every group. */
export function drawTierLabels(ctx, layout, x0) {
    const catalog = layout.catalog ?? TIER_CATALOG;
    for (const G of layout.groups) {
        for (const t of G.tiers) {
            const b = G.bands[t], lab = tierLabel(t, catalog);
            const lines = (G.style ?? layout.style) === 'lines';
            const small = lab.length > 4 || (!lines && b.bottom - b.top < 24);
            const y = lines ? b.top + 4 : (b.top + b.bottom) / 2 + 4;       // on the line, or in the middle of the band
            text(ctx, lab, x0 - 6, y, { color: INK, font: small ? FONTS.tierSmall : FONTS.tier, align: 'right' });
        }
    }
}

// ─── intracardiac channels ────────────────────────────────────────────────────

const LETTER_RANK = { H: 0, 'H′': 0, A: 1, V: 2 };

/**
 * The letters A · H · V over the His deflections, in pixels. Two letters closer than 9 px are not both
 * readable, so one is left out — always by the same rule, whatever comes first on the screen: the His letter
 * stays (it is what the His catheter is there for), then A, then V.
 * @param schedule  egmSchedule() (egm.js): { letters: [{ tMs, centerMs, text }] }
 */
export function resolveEgmLetters(schedule, view, layout, { x0 = -Infinity, x1 = Infinity } = {}) {
    const E = layout.egm;
    if (!E || E.lettersY == null || !schedule?.letters) return [];
    const onScreen = [];
    for (const l of schedule.letters) {
        const x = view.xOf(l.tMs + (l.centerMs || 0));
        if (x >= x0 + 4 && x <= x1 - 4) onScreen.push({ x, text: l.text });
    }
    const kept = [];
    for (const c of onScreen.slice().sort((a, b) => (LETTER_RANK[a.text] ?? 3) - (LETTER_RANK[b.text] ?? 3) || a.x - b.x)) {
        if (kept.every(k => Math.abs(k.x - c.x) >= 9)) kept.push(c);
    }
    return kept.sort((a, b) => a.x - b.x).map(c => ({ x: c.x, y: E.lettersY, text: c.text }));
}

/**
 * AH and HV on one beat, as dimension lines under the His channel: the beat asked for, or the first one on
 * screen whose atrial deflection on the His catheter, His deflection and ventricular onset the reading
 * places. Values of the reading — plausible, not measured (PREMISES.md §5).
 */
export function resolveEgmBrackets(schedule, view, layout, { beatId = null, x0 = -Infinity, x1 = Infinity } = {}) {
    const E = layout.egm;
    if (!E || E.bracketTop == null || !schedule?.beats?.length) return [];
    const row = E.rows.Hisd || E.rows.His || E.rows.Hisp;
    if (!row) return [];
    const measurable = schedule.beats.filter(b => b.tHisA != null && b.tH != null && b.tV != null);
    const onScreen = (b) => view.xOf(b.tHisA) >= x0 + 30 && view.xOf(b.tV) <= x1 - 30;
    const b = (beatId != null ? measurable.find(x => x.beatId === beatId) : null) || measurable.find(onScreen);
    if (!b) return [];
    const y = E.bracketTop + 8;
    const xa = view.xOf(b.tHisA), xh = view.xOf(b.tH), xv = view.xOf(b.tV);
    return [
        { xa, xb: xh, y, guides: [{ x: xa, y0: row.mid }, { x: xh, y0: row.mid }], label: `AH ${Math.round(b.AH)}`, onStrip: false, first: true, interior: false },
        { xa: xh, xb: xv, y, guides: [{ x: xv, y0: row.mid }], label: `HV ${Math.round(b.HV)}`, onStrip: false, first: false, interior: false },
    ];
}

/**
 * The intracardiac channels under the page's one time axis: time lines every 100 ms (every second when
 * 100 ms is too narrow to be worth a line), one trace per channel in ink, the letters over the His
 * deflections and the AH / HV brackets. Nothing is drawn when the layout has no intracardiac block.
 * @param egm  { schedule, samples: { fs, t0Ms?, channels: { [ch]: Float32Array } }, showLetters, showAhHv, bracketBeatId }
 * @returns the bracket label boxes, as drawBracketsPx returns them
 */
export function drawEgmBlock(ctx, view, layout, egm, { x0, x1 }) {
    const E = layout.egm;
    if (!E || !egm?.samples) return [];
    const step = Math.abs(view.xOf(100) - view.xOf(0)) >= 12 ? 100 : 1000;
    const tA = view.tOf(x0), tB = view.tOf(x1);
    ctx.lineWidth = 1;
    for (const bold of [false, true]) {
        ctx.strokeStyle = bold ? COLORS.EGM_TIMELINE_BOLD : COLORS.EGM_TIMELINE;
        ctx.beginPath();
        for (let t = Math.ceil(tA / step) * step; t <= tB; t += step) {
            if ((t % 1000 === 0) !== bold) continue;
            const x = Math.round(view.xOf(t)) + 0.5;
            ctx.moveTo(x, E.top); ctx.lineTo(x, E.bottom);
        }
        ctx.stroke();
    }
    const { fs } = egm.samples;
    // the samples start at their own t0 (a strip timed from a grid click has times before zero)
    const t0 = egm.samples.t0Ms || 0;
    const sampleView = t0 ? { ...view, xOf: (t) => view.xOf(t + t0), tOf: (x) => view.tOf(x) - t0 } : view;
    for (const ch of E.channels) {
        const sig = egm.samples.channels?.[ch];
        if (sig) drawTrace(ctx, { sig, fs, gaps: null }, sampleView, x0, x1, E.rows[ch].mid, EGM_GAIN_PX, INK);
    }
    if (egm.showLetters !== false) {
        for (const l of resolveEgmLetters(egm.schedule, view, layout, { x0, x1 })) text(ctx, l.text, l.x, l.y, { color: INK, font: FONTS.egmLetter });
    }
    return egm.showAhHv ? drawBracketsPx(ctx, resolveEgmBrackets(egm.schedule, view, layout, { beatId: egm.bracketBeatId ?? null, x0, x1 })) : [];
}

/** Every channel's name, right-aligned against the rule, beside its trace. */
export function drawEgmLabels(ctx, layout, x0) {
    const E = layout.egm;
    if (!E) return;
    for (const ch of E.channels) {
        const lab = EGM_CHANNEL_LABELS[ch] ?? ch;
        text(ctx, lab, x0 - 6, E.rows[ch].mid + 4, { color: INK, font: lab.length > 4 ? FONTS.tierSmall : FONTS.tier, align: 'right' });
    }
}

/** The footer lines, 14 px apart, starting 20 px under the last ladder. */
export function drawFooter(ctx, x0, bottom, lines) {
    lines.forEach((ln, i) => { if (ln) text(ctx, ln, x0, bottom + 20 + i * 14, { align: 'left', color: MUTED }); });
}

// ─── the frame ────────────────────────────────────────────────────────────────

/**
 * Draw one frame.
 * @param ctx      2D context already scaled to CSS px
 * @param o.view   makeView()
 * @param o.layout makeLayout() — group 0 = o.ladder, groups 1… = o.layers
 * @param o.cssW   canvas CSS width
 * @param o.strip  { sig: detrended Float32Array (mV), fs, gaps, label }
 * @param o.beats / o.atrial  ground-truth markers
 * @param o.ladder buildLadder() output
 * @param o.layers [{ label, ladder }] stacked read-only interpretations
 * @param o.selected {kind,id} | null
 * @param o.showIntervals boolean
 *
 * The editor's way in:
 * @param o.groupsPx    [{ resolved: { paths, events }, letter, title, caption, bracketsPx }] — one per
 *                      layout group, already in pixels; when given, o.ladder / o.layers are not read
 * @param o.paintStrip  (ctx, { x0, x1, stripH }) => void — replaces paper + grid + trace (an image, say)
 * @param o.markersPx   [{ x, color, sel, user, tierTop }] — replaces the markers resolved from beats/atrial
 * @param o.footerLines string[] — several footer lines (o.footerText is the one-line shorthand)
 * @param o.lead        the lead name in the label column (o.strip.label otherwise)
 * @param o.tags        [{ text, y, font, color? }] — the lines under the lead name (speed, gain), when the
 *                      caller knows them; otherwise they follow o.bare and o.view.printScale as before
 * @param o.xEnd        where the ladder ends, when that is not the page's right edge (a strip that does
 *                      not fill the width): tiers, paper and the clip stop there
 * @param o.egm         { schedule, samples, showLetters, showAhHv, bracketBeatId } — the intracardiac channels,
 *                      drawn in the layout's egm block (makeLayout({ egm })); both products pass the same object
 * @returns { labels: Set[], brackets: [{ g, i, box }] }  what was placed, for hit-testing
 */
export function drawFrame(ctx, o) {
    const { view, layout, cssW, strip, beats = [], atrial = [], ladder, layers = [], selected = null,
            showIntervals = true, markerLines = true, footerText = null, current = {}, bare = false,
            groupsPx = null, paintStrip = null, markersPx = null, footerLines = null, lead = null, tags = null,
            xEnd = null, egm = null } = o;
    const H = layout.height;
    // Where the ladder ends. Normally the page's right edge; an editor whose strip does not fill the page
    // passes the strip's own edge, so tiers, paper and marks stop where the tracing stops rather than
    // running on over blank paper.
    const x0 = view.labelW, x1 = Math.min(cssW, xEnd ?? cssW);
    const stripTop = layout.stripTop ?? 0, stripBottom = stripTop + layout.stripH;
    ctx.save();
    ctx.fillStyle = COLORS.PAGE; ctx.fillRect(0, 0, cssW, H);
    if (paintStrip) paintStrip(ctx, { x0, x1, stripH: layout.stripH, stripTop });
    else {
        ctx.fillStyle = COLORS.PAPER; ctx.fillRect(x0, stripTop, x1 - x0, layout.stripH);
        drawGrid(ctx, view, x0, x1, stripTop, stripBottom);
        ctx.save();
        ctx.beginPath(); ctx.rect(x0, stripTop, x1 - x0, layout.stripH); ctx.clip();
        drawTrace(ctx, strip, view, x0, x1, stripTop + layout.stripH * 0.58, view.pxPerMv);
        ctx.restore();
    }

    const visible = (t) => { const x = view.xOf(t); return x >= x0 - 20 && x <= x1 + 20; };

    ctx.save();
    ctx.beginPath(); ctx.rect(x0, 0, x1 - x0, H); ctx.clip();
    // A guide runs from the tracing down to the ladder, so only where nothing else sits between the two.
    const E = layout.egm;
    const guideTo = (tierTop) => tierTop >= stripBottom && !(E && E.top >= stripBottom && E.bottom <= tierTop);
    for (const m of markersPx ?? resolveMarkers({ beats, atrial }, view, layout, { selected, visible })) {
        drawMarkerPx(ctx, m, { top: stripTop, h: layout.stripH, guide: guideTo(m.tierTop) }, markerLines);
    }
    if (egm && E) drawEgmBlock(ctx, view, layout, egm, { x0, x1 });

    const placed = [];
    // Where each bracket's label landed, so an editor can let the reader take hold of it.
    const bracketBoxes = [];
    if (groupsPx) {
        // Frames for every ladder first, then the ladders themselves: a caption or a label that hangs below
        // its own group used to be painted over by the next group's band fill.
        groupsPx.forEach((G, g) => drawTierGroup(ctx, layout, g, { x0, x1, letter: G.letter, title: G.title, caption: G.caption }));
        // periods behind every ladder, over its frame
        groupsPx.forEach((G) => { if (G.periodsPx?.length) drawPeriodsPx(ctx, G.periodsPx); });
        groupsPx.forEach((G, g) => {
            placed.push(drawResolvedGroup(ctx, G.resolved ?? { paths: [], events: [] }, { x0, rules: tierRules(layout, g) }));
            if (G.bracketsPx?.length) for (const r of drawBracketsPx(ctx, G.bracketsPx)) bracketBoxes.push({ g, i: r.i, box: r.box });
        });
    } else {
        const common = { x0, x1, visible, beats, atrial, frameDrawn: true };
        // Same order as the groupsPx branch above: every frame, then every ladder.
        drawTierGroup(ctx, layout, 0, { x0, x1, letter: current.letter ?? null, title: current.title ?? null, caption: current.caption ?? null });
        layers.forEach((l, i) => drawTierGroup(ctx, layout, i + 1, { x0, x1, letter: l.letter ?? null, title: l.title ?? l.label ?? null, caption: l.caption ?? null }));
        if (current.periods?.length) drawPeriodsPx(ctx, resolvePeriods(current.periods, view, layout, 0));
        layers.forEach((l, i) => { if (l.periods?.length) drawPeriodsPx(ctx, resolvePeriods(l.periods, view, layout, i + 1)); });
        drawLadderGroup(ctx, view, layout, 0, ladder, { ...common, selected, showIntervals, title: current.title, letter: current.letter, caption: current.caption, brackets: current.brackets });
        layers.forEach((l, i) => drawLadderGroup(ctx, view, layout, i + 1, l.ladder, { ...common, title: l.title ?? l.label, letter: l.letter, caption: l.caption, brackets: l.brackets }));
    }
    ctx.restore();

    // Label column last, so nothing scrolls under the names.
    let tagLines = tags;
    if (!tagLines) {
        tagLines = [];
        if (!bare) tagLines.push({ text: view.fit ? 'fit' : `${view.speedMmS} mm/s`, y: 32, font: FONTS.tag });
        else if (view.printScale) {
            // a publication figure states the speed and gain that are true at its print size
            tagLines.push({ text: `${fmtNum(view.speedMmS * view.printScale)} mm/s`, y: 32, font: FONTS.tagPrint, color: INK });
            tagLines.push({ text: `${fmtNum(view.pxPerMv / view.pxPerMm * view.printScale)} mm/mV`, y: 45, font: FONTS.tagPrint, color: INK });
        }
    }
    drawLabelColumn(ctx, x0, H, layout.bottom, { lead: lead ?? strip?.label ?? '', tags: tagLines, top: stripTop });
    drawTierLabels(ctx, layout, x0);
    if (egm && layout.egm) drawEgmLabels(ctx, layout, x0);
    const foot = footerLines ?? (footerText ? [footerText] : []);
    if (foot.length) drawFooter(ctx, x0, layout.bottom, foot);
    ctx.restore();
    return { labels: placed, brackets: bracketBoxes };
}

/**
 * The measured intervals, written on the figure. `rrY` and `gapY` say where the two rows go: above the
 * strip and in the gap beneath it, which is right for a drawn tracing with headroom above the trace. A
 * consumer whose strip is a photograph of ECG paper has no headroom — nothing may be written over the
 * reader's own tracing — and passes both rows into a gap it has made taller.
 */
export function drawIntervals(ctx, view, layout, ladder, beats, atrial, visible, skipPrAt = [], o = {}) {
    const bById = new Map(beats.map(b => [b.id, b]));
    const font = FONTS.interval;
    const stripTop = layout.stripTop ?? 0;
    const rrY = o.rrY ?? stripTop + 12;
    const gapY = o.gapY ?? (stripTop + layout.stripH + layout.gap / 2 + 4);
    for (const iv of ladder.intervals) {
        const b = bById.get(iv.beatId);
        if (!b || !visible(b.qrsOnMs)) continue;
        if (iv.RRms != null) {
            text(ctx, `${Math.round(iv.RRms)}`, view.xOf(b.qrsOnMs - iv.RRms / 2), rrY, { font, color: COL_Q });
        }
        if (iv.PRms != null && !skipPrAt.some(t => Math.abs(t - b.qrsOnMs) < 1)) {
            text(ctx, `${ladder.mechanism === 'flutter' ? 'FR' : 'PR'} ${Math.round(iv.PRms)}`, view.xOf(b.qrsOnMs - iv.PRms / 2), gapY, { font, color: COL_P });
        }
        if (iv.VAms != null) {
            text(ctx, `VA ${Math.round(iv.VAms)}`, view.xOf(b.qrsOnMs + iv.VAms / 2), gapY, { font, color: MUTED });
        }
    }
    // AH next to each conducted AV segment
    if (ladder.mechanism === 'avnrt' || ladder.mechanism === 'avrt') return;   // AH there is a derived residual, not a measurement
    for (const p of ladder.paths) {
        if (p.role !== 'av' || !visible(p.to.tMs)) continue;
        const ah = p.to.tMs - p.from.tMs;
        const y = (yOf(layout, p.to.tier, 0) + yOf(layout, p.to.tier, 1)) / 2 + 3;
        text(ctx, `${Math.round(ah)}`, view.xOf(p.to.tMs) + 4, y, { font, color: MUTED, align: 'left' });
    }
}

// ─── off-screen rendering ─────────────────────────────────────────────────────

/** A canvas from the document, when there is one. Tests and node callers pass their own. */
const defaultCreateCanvas = (w, h) => {
    if (typeof document === 'undefined') throw new Error('renderRange: no document — pass createCanvas');
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    return cv;
};

/**
 * Off-screen render of a time range (PNG export).
 * @returns a canvas at `scale`× the CSS size.
 */
export function renderRange(o, { tMinMs, tMaxMs, scale = 3, speedMmS, gainMmMv, gridMs = null, footerText, bare = false, printScale = PRINT.scale, cssW = null, createCanvas = defaultCreateCanvas } = {}) {
    const view = makeView({ speedMmS, t0Ms: tMinMs, gainMmMv, gridMs });
    if (printScale && bare) {
        const sp = speedMmS * printScale, g = gainMmMv * printScale;
        if (!STANDARD_SPEEDS.some(v => Math.abs(v - sp) < 1e-6) || !STANDARD_GAINS.some(v => Math.abs(v - g) < 1e-6))
            throw new Error(`publication figure at ${fmtNum(sp)} mm/s, ${fmtNum(g)} mm/mV: not a standard speed and gain (print scale ${printScale})`);
        view.printScale = printScale;
    }
    const w = cssW ?? Math.ceil(view.labelW + (tMaxMs - tMinMs) * view.pxPerMs) + 8;
    const layout = o.layout;
    const cv = createCanvas(Math.round(w * scale), Math.round(layout.height * scale));
    const ctx = cv.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawFrame(ctx, { ...o, view, cssW: w, selected: null, footerText, bare });
    return cv;
}

/**
 * Strip-only image for the lewis-ladder background: [tMin, tMax] across `widthPx`, plus `overhangPx` of
 * paper beyond it, at `scale`× so the grid and the trace rasterise exactly as the viewer's own frame does.
 * `pxPerMv` is the real gain (mm/mV × PX_PER_MM); without it the amplitude is fitted to the height, which
 * makes a backdrop, not a measurement. The canvas returned carries `timeWidthPx` — the width the time span
 * maps to — for the calibration the editor writes.
 */
export function renderStripImage({ sig, fs, gaps }, { tMinMs, tMaxMs, widthPx = 1800, heightPx = 300, scale = 1, pxPerMv = null, overhangPx = 0, createCanvas = defaultCreateCanvas } = {}) {
    if (scale === 1 && pxPerMv == null) heightPx = Math.min(heightPx, Math.floor(widthPx / 5.2));
    const totalW = widthPx + overhangPx;
    const cv = createCanvas(Math.round(totalW * scale), Math.round(heightPx * scale));
    const ctx = cv.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const pxPerMs = widthPx / (tMaxMs - tMinMs);
    const speed = pxPerMs * 1000 / PX_PER_MM;           // pretend paper speed so the grid is 1 mm
    const view = { ...makeView({ speedMmS: speed, t0Ms: tMinMs, labelW: 0 }) };
    view.pxPerMm = pxPerMs * 40;                         // 1 mm = 40 ms at 25 mm/s
    view.speedMmS = 25; view.gridMs = 40;
    view.xOf = (t) => (t - tMinMs) * pxPerMs;
    view.tOf = (x) => tMinMs + x / pxPerMs;
    view.pxPerMs = pxPerMs;
    ctx.fillStyle = COLORS.PAPER; ctx.fillRect(0, 0, totalW, heightPx);
    drawGrid(ctx, view, 0, totalW, 0, heightPx);
    let gain = pxPerMv;
    if (gain == null) {
        // amplitude fit: 99.5th percentile of |v| in range → 42 % of the height
        const s0 = Math.max(0, Math.floor(tMinMs * fs / 1000)), s1 = Math.min(sig.length - 1, Math.ceil(tMaxMs * fs / 1000));
        const mags = [];
        for (let s = s0; s <= s1; s += 2) if (!(gaps && gaps[s])) mags.push(Math.abs(sig[s]));
        mags.sort((a, b) => a - b);
        const p995 = mags.length ? mags[Math.floor(mags.length * 0.995)] || 1 : 1;
        gain = Math.min(10 * view.pxPerMm, 0.42 * heightPx / Math.max(p995, 0.2));
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, totalW, heightPx); ctx.clip();
    drawTrace(ctx, { sig, fs, gaps }, view, 0, totalW, heightPx * 0.58, gain);
    ctx.restore();
    cv.timeWidthPx = Math.round(widthPx * scale);
    return cv;
}
