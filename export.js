/**
 * Laddergram exports. Pure: no DOM.
 *
 *  - toLaddergramJson: our own time-based format (re-loadable, keeps the
 *    ground truth: beats + atrial events + mechanism + params).
 *  - toLewisLadderDiagram: the DiagramState of the manual editor at
 *    lewisladder.netlify.app, so a generated diagram can be refined by hand.
 *
 * Lewis-ladder geometry (src/components/Canvas.tsx there): logical canvas
 * 1000 × 500, HORIZONTAL_MARGIN 50, LINE_SPACING 35; tier line i sits at
 * diagramStartY + i·35, diagramStartY = imageHeight + 10 + 30 when a strip
 * image is present (80 without). The strip image is fitted with
 * scale = min(900 / w, 180 / h) and centred, so an image with w/h ≥ 5 spans
 * x = 50 … 950 exactly — which is what lets us place points by time.
 *
 * Line semantics (decided with the author): a named line is the TOP edge of
 * its tier, plus an unnamed line for the bottom edge of V. Several ladders
 * (stacked interpretations of one strip) follow one another, each line
 * tagged with its `group`.
 */
import { TIER_CATALOG, CONDUCTIONS, normalizeTiers, ENGINE_NAME, ENGINE_VERSION } from './engine.js';
import { makeLayout, capLines } from './render.js';

// GROUP_GAP: lewis-ladder adds this much room before every ladder after the first
// (src/lib/ladders.ts lineOffsets) — the two must match or points miss their lines.
// The editor's page: the renderer's own frame (see render.js makeLayout) — a 60 px label column, the strip
// fitted into 940 × 180 from x 60 (a 40 px paper rail when there is none), tiers to x 992, per-tier heights
// from the catalog. `LAYOUT_VERSION` tells the editor these coordinates need no migration.
export const LEWIS = Object.freeze({ W: 1000, X0: 60, X1: 992, STRIP_FIT_W: 940, IMG_MAX_H: 180, NO_IMAGE_STRIP_H: 40, FOOTER: 30, LAYOUT_VERSION: 2 });
export const FORMAT = 'ecgdante-laddergram';
export const FORMAT_VERSION = 2;

const beatOut = (b) => ({ id: b.id, qrsOnMs: b.qrsOnMs, qrsOffMs: b.qrsOffMs, rPeakMs: b.rPeakMs ?? null,
                          quality: b.quality || 'normal', qrsWidthMs: b.qrsWidthMs ?? null, source: b.source || 'auto',
                          conduction: b.conduction ?? null });
const atrialOut = (a) => ({ id: a.id, tMs: a.tMs, source: a.source || 'auto' });

export function toLaddergramJson({ filename = null, lead = null, fs = null, durationMs = null, speed = null,
                                   beats, atrial, mechanism, params, tiers = null, ladder, layers = [], title = '', caption = '', style = 'bands', brackets = null }) {
    return {
        format: FORMAT, version: FORMAT_VERSION, createdAt: new Date().toISOString(),
        source: { filename, lead, fs, durationMs },
        display: { speedMmS: speed },
        mechanism, params, tiers: normalizeTiers(tiers || ladder?.tiers), title: title || '', caption: caption || '', style: cleanStyle(style) || 'bands',
        ...(cleanBrackets(brackets) ? { brackets: cleanBrackets(brackets) } : {}),
        beats: beats.map(beatOut),
        atrial: atrial.map(atrialOut),
        ladder: { tiers: ladder.tiers, events: ladder.events, paths: ladder.paths, intervals: ladder.intervals, notes: ladder.notes },
        // stacked interpretations: ground truth only, ladders are rebuilt on load
        layers: layers.map(l => ({ id: l.id, title: l.title ?? l.label ?? '', caption: l.caption || '', mechanism: l.mechanism, params: l.params || {},
                                   tiers: normalizeTiers(l.tiers), beats: l.beats.map(beatOut), atrial: l.atrial.map(atrialOut),
                                   ...(cleanStyle(l.style) ? { style: l.style } : {}),
                                   ...(cleanBrackets(l.brackets) ? { brackets: cleanBrackets(l.brackets) } : {}) })),
    };
}

const cleanStyle = (st) => (st === 'lines' || st === 'bands' ? st : null);
/** SP/PH/HV annotation: { beatId } or { beat: index }. */
const cleanBrackets = (b) => (b && (typeof b.beatId === 'string' || Number.isInteger(b.beat)) ? (typeof b.beatId === 'string' ? { beatId: b.beatId } : { beat: b.beat }) : null);

function cleanBeats(list) {
    return (list || []).filter(b => b && Number.isFinite(b.qrsOnMs) && Number.isFinite(b.qrsOffMs))
        .map(b => ({ ...b, conduction: CONDUCTIONS.includes(b.conduction) ? b.conduction : null }));
}
const cleanAtrial = (list) => (list || []).filter(a => a && Number.isFinite(a.tMs));

/** Validate + normalise a file written by toLaddergramJson (v1 or v2). Throws on garbage. */
export function fromLaddergramJson(obj) {
    if (!obj || obj.format !== FORMAT) throw new Error('not a laddergram file');
    const layers = (Array.isArray(obj.layers) ? obj.layers : [])
        .filter(l => l && Array.isArray(l.beats))
        .map((l, i) => ({ id: String(l.id || `L${i}`), title: String(l.title ?? l.label ?? ''), caption: String(l.caption || ''), mechanism: l.mechanism || 'avnodal',
                          params: l.params || {}, tiers: normalizeTiers(l.tiers), beats: cleanBeats(l.beats), atrial: cleanAtrial(l.atrial),
                          ...(cleanStyle(l.style) ? { style: l.style } : {}), brackets: cleanBrackets(l.brackets) }));
    return { beats: cleanBeats(obj.beats), atrial: cleanAtrial(obj.atrial), mechanism: obj.mechanism || 'avnodal',
             params: obj.params || {}, tiers: normalizeTiers(obj.tiers), layers, source: obj.source || {},
             title: String(obj.title || ''), caption: String(obj.caption || ''), style: cleanStyle(obj.style) || 'bands',
             brackets: cleanBrackets(obj.brackets) };
}

/** Clip a path to [tMin, tMax] on the time axis; null if nothing is left. `level` maps a point to its continuous height. */
function clipPath(p, tMin, tMax, level) {
    let a = { t: p.from.tMs, g: level(p.from) }, b = { t: p.to.tMs, g: level(p.to) };
    const lo = Math.min(a.t, b.t), hi = Math.max(a.t, b.t);
    if (hi < tMin || lo > tMax) return null;
    const at = (t) => {
        if (b.t === a.t) return { t, g: a.g };
        const u = (t - a.t) / (b.t - a.t);
        return { t, g: a.g + u * (b.g - a.g) };
    };
    let clipped = false;
    const clampEnd = (e) => {
        if (e.t < tMin) { clipped = true; return at(tMin); }
        if (e.t > tMax) { clipped = true; return at(tMax); }
        return e;
    };
    const na = clampEnd(a), nb = clampEnd(b);
    return { a: na, b: nb, clippedEnd: nb !== b, clipped };
}

/**
 * Two drawing conventions for the same ladder:
 *  - 'bands': a tier is the SPACE between two lines; conduction crosses it top
 *    to bottom (slope = conduction time). Needs a closing line under the last tier.
 *  - 'lines': a tier IS a line, events are dots on it, conduction runs from a dot
 *    on one line to a dot on the next. The last tier (V) is the last line.
 * toLineStyle maps a band ladder onto the line convention: everything in the
 * last tier and every SN dot is put on its line, and segments that collapse onto
 * the V line (the V stroke, a PVC's exit along V) disappear. On a line a dot means
 * "this level is activated now", so (PREMISES.md, dots on lines):
 *  - an atrial activation is one dot on the A line at P onset. A retrograde P, which the
 *    bands start at the bottom of the atrial tier, is lifted onto the A line at the same
 *    time; the nodal limb that brought it keeps its AV dot and joins it vertically;
 *  - an accessory pathway connects the atrium and the ventricle: its atrial end is the A dot
 *    of that activation, and it crosses the AV line without a dot;
 *  - a ventricular activation is one dot on the V line at QRS onset: every line leaving the
 *    ventricle (an accessory pathway, a retrograde exit) starts from it;
 *  - an atrial focus sits on the A line.
 */
export function toLineStyle(ladder) {
    const tiers = ladder.tiers || [];
    const last = tiers[tiers.length - 1];
    const belowA = tiers[tiers.indexOf('A') + 1];
    const aboveV = tiers[tiers.length - 2];
    const near = (a, b) => Math.abs(a - b) <= 0.6;
    const ptKey = (q) => `${q.tier}|${Math.round(q.tMs * 10)}|${q.frac}`;

    // atrial activations entered from below: their dot goes on the A line at P onset
    const retroP = ladder.events.filter(e => e.tier === 'A' && e.frac === 1 && (e.role === 'p-retro' || e.role === 'p-edge'));
    const climbs = new Set(['atrium-retro', 'atrium-edge']);
    const moved = new Map();                                       // point key → point on its line
    for (const e of retroP) moved.set(ptKey(e), { tier: 'A', tMs: e.tMs, frac: 0 });
    for (const p of ladder.paths) {
        // the top of the band's atrial climb is the same activation: lines leaving it start at P onset
        if (climbs.has(p.role)) moved.set(ptKey(p.to), { tier: 'A', tMs: p.from.tMs, frac: 0 });
    }
    for (const e of ladder.events) {
        if (e.tier === 'A' && e.style === 'asterisk' && e.frac > 0 && e.frac < 1) moved.set(ptKey(e), { tier: 'A', tMs: e.tMs, frac: 0 });
    }
    // atrial onsets (P, retrograde P, focus) for the atrial end of an accessory pathway
    const aOnsets = ladder.events.filter(e => e.tier === 'A' && e.style !== 'none').map(e => e.tMs).sort((a, b) => a - b);
    const onsetAtOrBefore = (t) => { let best = null; for (const x of aOnsets) if (x <= t + 0.6) best = x; return best ?? t; };
    // ventricular onsets per beat (the QRS dot; for a pure focus, its asterisk)
    const qOn = new Map();
    for (const e of ladder.events) if (e.tier === last && e.role === 'focus-ventricular' && e.beatId != null) qOn.set(e.beatId, e.tMs);
    for (const e of ladder.events) if (e.tier === last && e.role === 'qrs' && e.beatId != null) qOn.set(e.beatId, e.tMs);
    const onVLine = (q) => q.tier === last || (q.tier === aboveV && q.frac === 1);

    const apAnteFrom = new Set(ladder.paths.filter(p => p.role === 'ap-ante').map(p => ptKey(p.from)));
    const snap = (pt) => (pt.tier === last || pt.tier === 'SN') ? { ...pt, frac: 0 } : pt;
    const move = (pt) => moved.get(ptKey(pt)) ?? pt;
    const paths = [];
    const dropped = [];
    for (let p of ladder.paths) {
        if (climbs.has(p.role)) continue;                           // replaced by the A dot itself
        if (p.role === 'atrium' && apAnteFrom.has(ptKey(p.to))) continue;   // atrial spread to the pathway: the AP starts at the A dot
        let from = move(p.from), to = move(p.to);
        // the atrial end of an orthodromic pathway is also where the atrium descends to the node: label on the left
        if (p.role === 'ap') { to = { tier: 'A', tMs: onsetAtOrBefore(to.tMs), frac: 0 }; p = { ...p, labelSide: -1 }; }
        if (p.role === 'ap-ante') from = { tier: 'A', tMs: onsetAtOrBefore(from.tMs), frac: 0 };
        // one ventricular dot per beat: a line leaving the ventricle starts at QRS onset
        if (p.style !== 'pass' && onVLine(from) && !onVLine(to) && qOn.has(p.beatId)) from = { tier: last, tMs: qOn.get(p.beatId), frac: 0 };
        from = snap(from); to = snap(to);
        const onLast = from.tier === last && to.tier === last;
        if (onLast) { dropped.push(p); continue; }                // collapses onto the V line
        if (from.tier === to.tier && from.frac === to.frac && near(from.tMs, to.tMs)) continue;
        if (from.tier === 'A' && to.tier === 'A' && from.frac === 0 && to.frac === 0) continue;   // along the A line
        paths.push({ ...p, from, to });
    }
    // the nodal limb of a retrograde P ends on the AV line: it keeps its AV dot, joined vertically to the A dot.
    // When the atrium was reached over a pathway instead, the next anterograde limb leaves the AV dot below the
    // A dot: the same vertical, downwards (the atrium is instantaneous in both conventions).
    for (const e of retroP) {
        if (!belowA) break;
        const mk = (ref, from, to, arrow, role) => paths.push({ id: `${ref.id}-${role}`, beatId: ref.beatId, atrialId: ref.atrialId ?? null,
            from, to, style: 'solid', terminal: 'point', arrow, curve: 0, label: null, color: null, role,
            key: `p|${role}|${ref.beatId ?? ''}|${Math.round(e.tMs)}` });
        const onAV = { tier: belowA, tMs: e.tMs, frac: 0 }, onA = { tier: 'A', tMs: e.tMs, frac: 0 };
        const lim = paths.find(p => p.style !== 'pass' && p.to.tier === belowA && p.to.frac === 0 && near(p.to.tMs, e.tMs));
        const ante = paths.find(p => p.style !== 'pass' && p.from.tier === belowA && p.from.frac === 0 && near(p.from.tMs, e.tMs));
        if (lim) mk(lim, onAV, onA, 'end', 'av-to-atrium');
        else if (ante) mk(ante, onA, onAV, 'none', 'atrium-to-av');
    }
    // a block that collapsed onto the V line (infra-His block) must stay visible and must not leave a dot on the V
    // line: it moves onto the wave that arrives, which stops short of the V line with the block bar (1.4.2)
    for (const b of dropped) {
        if (b.terminal !== 'block') continue;
        const inc = paths.find(q => q.to.tier === aboveV && q.to.frac === 1 && Math.abs(q.to.tMs - b.from.tMs) < 1
            && (q.atrialId ?? null) === (b.atrialId ?? null) && (q.beatId ?? null) === (b.beatId ?? null));
        if (!inc) continue;
        const f = inc.from, t = inc.to, k = 0.85;
        const tIn = f.tier === t.tier ? f.tMs + (t.tMs - f.tMs) * (k - f.frac) / Math.max(1e-6, t.frac - f.frac) : t.tMs;
        inc.to = { ...t, frac: k, tMs: tIn };
        inc.terminal = 'block';
    }
    const events = ladder.events.map(e => {
        let q = snap(move(e));
        if (q.tier === last && e.role === 'focus-ventricular' && qOn.has(e.beatId)) q = { ...q, tMs: qOn.get(e.beatId) };
        return q === e ? e : { ...e, tier: q.tier, tMs: q.tMs, frac: q.frac };
    });
    // A dot wherever conduction meets a level line — the defining mark of this convention. A point at
    // the bottom of tier i sits on the line of tier i+1; blocked and open ends get no dot.
    const onLine = (pt) => {
        if (pt.frac === 0) return { tier: pt.tier, tMs: pt.tMs };
        const i = tiers.indexOf(pt.tier);
        return pt.frac === 1 && i >= 0 && i < tiers.length - 1 ? { tier: tiers[i + 1], tMs: pt.tMs } : null;
    };
    const lineKey = (q) => `${q.tier}|${Math.round(q.tMs)}`;
    const seen = new Set(events.map(e => onLine(e)).filter(Boolean).map(lineKey));
    const add = (q, p) => {
        if (!q) return;
        const k = lineKey(q);
        if (seen.has(k)) return;
        seen.add(k);
        events.push({ tier: q.tier, tMs: q.tMs, frac: 0, role: 'junction-dot', beatId: p.beatId, atrialId: p.atrialId,
                      key: `e|junction-dot|${p.key ?? ''}|${q.tier}` });
    };
    for (const p of paths) {
        if (p.style === 'pass') continue;
        add(onLine(p.from), p);
        if (p.terminal !== 'block' && p.terminal !== 'open') add(onLine(p.to), p);
    }
    return { ...ladder, paths, events, style: 'lines' };
}

/**
 * One ladder → the Lewis Ladder editor's points and connections, in canvas coordinates.
 * Shared by toLewisLadderDiagram and by the editor's guided mode, so both put every engine element
 * on exactly the same spot.
 *
 *  o.tMinMs / tMaxMs      the visible time window; paths are clipped to it (a clipped end stays open)
 *  o.xOf(t)               time → canvas x
 *  o.yOfLevel(level)      continuous level inside this ladder (tier index + frac) → canvas y
 *  o.lineIdOfLevel(level) the line a point at that level belongs to
 *  o.newPointId(n) / o.newConnectionId(n)   id factories (default p0…, c0…)
 *  o.points / o.connections / o.dedupe      arrays / Map to append to (lets several ladders share numbering)
 *
 * Every element keeps what the engine knew: `key` (stable across rebuilds), `role`, and for points
 * `inferred` (false only for an event the tracing fixes — one whose mark the user placed — as the renderer
 * draws it: hollow when `source === 'user'`, filled otherwise). A point that is only the end of a path,
 * not an event, gets `pointStyle: 'none'`: the renderer draws dots at events only.
 */
export function layoutLadder(ladder, o) {
    const { tMinMs, tMaxMs, xOf, yOfLevel, lineIdOfLevel } = o;
    const pid = o.newPointId || ((n) => `p${n}`), cid = o.newConnectionId || ((n) => `c${n}`);
    const points = o.points || [], connections = o.connections || [];
    const byXY = o.dedupe || new Map();
    const idx = Object.fromEntries((ladder.tiers || []).map((t, i) => [t, i]));
    const level = (pt) => (idx[pt.tier] ?? 0) + pt.frac;
    // Two paths meeting at the same place share one point: the same place to a tenth of a pixel. The point
    // itself keeps the full precision, so the editor draws it exactly where the renderer draws the figure.
    const r10 = (v) => Math.round(v * 10) / 10;
    const pointAt = (t, lv, meta = {}) => {
        const x = xOf(t), y = yOfLevel(lv);
        const k = `${r10(x)}|${r10(y)}`;
        const found = byXY.get(k);
        if (found) {
            if (meta.asterisk) found.pointStyle = 'asterisk';
            if (meta.measured) found.inferred = false;
            if (meta.fromEvent && !found.fromEvent) { found.key = meta.key; found.role = meta.role; found.fromEvent = true; }
            return found.id;
        }
        const pt = { id: pid(points.length), x, y, lineId: lineIdOfLevel(lv), type: 'point',
                     ...(meta.asterisk ? { pointStyle: 'asterisk' } : {}), origin: 'engine',
                     key: meta.key, role: meta.role, inferred: !meta.measured, fromEvent: !!meta.fromEvent };
        points.push(pt);
        byXY.set(k, pt);
        return pt.id;
    };
    const inWindow = (t) => t >= tMinMs && t <= tMaxMs;
    const measured = (e) => e.source === 'user';
    // Events first, so a point that is also an event carries the event's key and role (handles use them).
    for (const e of ladder.events) {
        if (e.style === 'none' || !inWindow(e.tMs)) continue;
        pointAt(e.tMs, level(e), { asterisk: e.style === 'asterisk', measured: measured(e), key: e.key, role: e.role, fromEvent: true });
    }
    for (const p of ladder.paths) {
        const c = clipPath(p, tMinMs, tMaxMs, level);
        if (!c) continue;
        const startPoint = pointAt(c.a.t, c.a.g, { key: p.key && `${p.key}:a`, role: p.role });
        const endPoint = pointAt(c.b.t, c.b.g, { key: p.key && `${p.key}:b`, role: p.role });
        if (startPoint === endPoint) continue;
        const pass = p.style === 'pass';
        const conn = { id: cid(connections.length), startPoint, endPoint, style: pass ? 'dashed' : (p.style || 'solid'),
                       origin: 'engine', key: p.key, role: p.role };
        // A clipped end is not where conduction stopped — leave it open.
        conn.endTerminal = c.clippedEnd ? 'open' : (p.terminal === 'block' ? 'block' : 'point');
        if (p.arrow === 'end' && !c.clippedEnd) conn.arrowHead = 'end';
        if (p.curve && !c.clipped) conn.curve = p.curve;
        if (pass) conn.color = '#94a3b8';
        else if (p.color) conn.color = p.color;
        if (p.label) conn.label = p.label;
        if (p.labelAnchor) conn.labelAnchor = p.labelAnchor;
        if (p.labelSide != null) conn.labelSide = p.labelSide;
        connections.push(conn);
    }
    for (const pt of points) { if (!pt.fromEvent && !pt.pointStyle) pt.pointStyle = 'none'; delete pt.fromEvent; }
    return { points, connections };
}

/**
 * @param ladders  one buildLadder() output, or [{ ladder, letter, title, caption, style, recipe }] for stacked ladders
 *                 (recipe = { mechanism, params, tiers, beatOverrides, linked } — what the editor needs to rebuild it)
 * @param opts.tMinMs / tMaxMs      the time range the export covers
 * @param opts.style                'bands' (tier = space between lines) or 'lines' (tier = line)
 * @param opts.backgroundImage      data URL of the strip image (optional)
 * @param opts.imageWidthPx / imageHeightPx  its pixel size (needed to predict lewis' layout)
 * @param opts.marks                { beats, atrial } — the ground truth, so the editor can keep the ladders live
 * @param opts.provenance           { kind, source, licence, deidentified, lead, speedMmS, gainMmMv, note }
 */
export function toLewisLadderDiagram(ladders, { tMinMs, tMaxMs, style = 'bands', backgroundImage = null, imageWidthPx = 0, imageHeightPx = 0,
                                               timeWidthPx = imageWidthPx, marks = null, provenance = null } = {}) {
    if (!(tMaxMs > tMinMs)) throw new Error('empty time range');
    const list0 = Array.isArray(ladders) ? ladders : [{ ladder: ladders }];
    // each ladder may carry its own style (a teaching figure can show both); `style` is the default
    const styleOf = (it) => (it.style === 'lines' || it.style === 'bands' ? it.style : style);
    const list = list0.map(it => ({ ...it, style: styleOf(it), source: it.ladder, ladder: styleOf(it) === 'lines' ? toLineStyle(it.ladder) : it.ladder }));
    const { X0, X1, STRIP_FIT_W, IMG_MAX_H, NO_IMAGE_STRIP_H, FOOTER } = LEWIS;
    const hasImage = !!(backgroundImage && imageWidthPx > 0 && imageHeightPx > 0);
    // The strip as the editor fits it; the time axis runs over `timeWidthPx` of its pixels.
    const imgScale = hasImage ? Math.min(STRIP_FIT_W / imageWidthPx, IMG_MAX_H / imageHeightPx) : 0;
    const stripH = hasImage ? imageHeightPx * imgScale : NO_IMAGE_STRIP_H;
    // the same arithmetic as the editor's xOfTime (x0 + (t − t0) / msPerPx, then the image's scale), so the two agree bit for bit
    const msPerPx = (tMaxMs - tMinMs) / (hasImage ? timeWidthPx : X1 - X0);
    const xOf = (t) => (hasImage ? X0 + (0 + (t - tMinMs) / msPerPx) * imgScale : X0 + (t - tMinMs) / msPerPx);

    // Letters, titles and captions: the editor draws them itself (ladderMeta),
    // so they stay attached to their ladder when it is edited.
    const ladderMeta = list.map((it, g) => ({ group: g, letter: it.letter || (list.length > 1 ? String.fromCharCode(65 + g) : ''),
                                              title: String(it.title ?? it.label ?? ''), caption: String(it.caption || ''), style: it.style }));
    // The frame, exactly as the editor builds it from these lines and this meta (brackets are derived there).
    const layout = makeLayout({
        stripH, groups: list.map(({ ladder }) => (ladder.tiers?.length ? ladder.tiers : ['A'])),
        titles: ladderMeta.some(m => m.letter || m.title), captionLines: ladderMeta.map(m => capLines(m.caption)),
        style: list[0]?.style ?? style, styles: list.map(it => it.style), bracketRows: list.map(() => false), footer: FOOTER,
    });

    // Lines: each ladder's tiers (+ the closing bottom edge in band style), at the top of their band.
    const lines = [];
    list.forEach(({ ladder, style: st }, g) => {
        const G = layout.groups[g];
        const tiers = ladder.tiers || [];
        for (const t of st === 'lines' ? tiers : [...tiers, '']) {
            lines.push({ id: `l${lines.length}`, name: t ? (TIER_CATALOG[t]?.label ?? t) : '', y: t ? G.bands[t].top : G.bottom, visible: true, group: g });
        }
    });
    // level = line index within the ladder (fractional between lines), as the editor reads it back
    const levels = (gi) => lines.filter(l => l.group === gi);
    const yOfLevel = (gi, lv) => {
        const ys = levels(gi);
        const i = Math.max(0, Math.min(ys.length - 1, Math.floor(lv)));
        const f = lv - i, y0 = ys[i].y, y1 = ys[i + 1]?.y ?? y0;
        return y0 + f * (y1 - y0);
    };
    const lineIdOfLevel = (gi, lv) => { const ys = levels(gi); return ys[Math.max(0, Math.min(ys.length - 1, Math.round(lv)))].id; };

    const points = [], connections = [], dedupe = new Map();
    list.forEach(({ ladder }, gi) => {
        layoutLadder(ladder, { tMinMs, tMaxMs, xOf, points, connections, dedupe,
                               yOfLevel: (lv) => yOfLevel(gi, lv), lineIdOfLevel: (lv) => lineIdOfLevel(gi, lv) });
    });

    const lastY = layout.groups[layout.groups.length - 1].bottom;
    const canvasHeight = Math.round(layout.height);
    const annotations = [];
    const firstNote = list.length === 1 && !ladderMeta[0].caption ? list[0]?.ladder?.notes?.[0] : null;
    if (firstNote) {
        annotations.push({ id: 'a0', x: X0, y: lastY + 28,
                           text: firstNote.slice(0, 140), type: 'text', fontSize: 11, fontColor: '#1e293b' });
    }
    const out = { lines, points, connections, annotations, freeformLines: [], ladderMeta, ladderStyle: list[0]?.style ?? style, canvasHeight,
                  layoutVersion: LEWIS.LAYOUT_VERSION, engine: { name: ENGINE_NAME, version: ENGINE_VERSION } };
    if (backgroundImage) {
        out.backgroundImage = backgroundImage;
        out.imageTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
    }
    // Time calibration: the strip image spans [tMin, tMax] across `timeWidthPx` of its pixels (renderStripImage);
    // without an image the ladders span x = X0 … X1.
    out.calibration = hasImage
        ? { space: 'image', x0Px: 0, t0Ms: tMinMs, msPerPx: (tMaxMs - tMinMs) / timeWidthPx, method: 'generator', confidence: 'measured' }
        : { space: 'canvas', x0Px: X0, t0Ms: tMinMs, msPerPx: (tMaxMs - tMinMs) / (X1 - X0), method: 'schematic', confidence: 'assumed' };
    if (hasImage) out.imageSize = { w: imageWidthPx, h: imageHeightPx };
    if (marks) {
        out.marks = {
            beats: (marks.beats || []).map(b => ({ id: String(b.id), qrsOnMs: b.qrsOnMs, qrsOffMs: b.qrsOffMs ?? b.qrsOnMs + 95,
                                                   quality: b.quality === 'pvc' ? 'pvc' : 'normal', source: b.source === 'user' ? 'user' : 'imported',
                                                   ...(b.origin === 'capture' || b.origin === 'fusion' ? { origin: b.origin } : {}) })),
            atrial: (marks.atrial || []).map(a => ({ id: String(a.id), tMs: a.tMs, source: a.source === 'user' ? 'user' : 'imported' })),
            durationMs: tMaxMs - tMinMs,
        };
        // A recipe per ladder, so the editor rebuilds it from the marks instead of freezing the drawing.
        out.guided = list.map((it, g) => {
            const r = it.recipe || {};
            const src = it.source || {};
            return { group: g, mechanism: r.mechanism || src.mechanism || 'avnodal', params: r.params || {}, tiers: r.tiers || src.tiers || [],
                     ...(r.beatOverrides && Object.keys(r.beatOverrides).length ? { beatOverrides: r.beatOverrides } : {}),
                     ...(r.brackets ? { brackets: r.brackets } : {}),
                     engineVersion: ENGINE_VERSION, status: r.linked === false ? 'detached' : 'linked' };
        });
    }
    if (provenance) out.provenance = provenance;
    return out;
}
