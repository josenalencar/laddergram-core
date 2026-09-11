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

// GROUP_GAP: lewis-ladder adds this much room before every ladder after the first
// (src/lib/ladders.ts lineOffsets) — the two must match or points miss their lines.
export const LEWIS = Object.freeze({ W: 1000, H: 500, MARGIN: 50, SPACING: 35, TOP: 10, GAP: 30, NO_IMAGE_Y: 80, IMG_MAX_H: 180, GROUP_GAP: 30 });
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
 * the V line (the vertical V stroke, a PVC's exit along V) disappear.
 */
export function toLineStyle(ladder) {
    const tiers = ladder.tiers || [];
    const last = tiers[tiers.length - 1];
    const snap = (pt) => (pt.tier === last || pt.tier === 'SN') ? { ...pt, frac: 0 } : pt;
    const paths = [];
    const blocksOnLast = [];
    for (const p of ladder.paths) {
        const from = snap(p.from), to = snap(p.to);
        const onLast = from.tier === last && to.tier === last;
        if (onLast) {                                             // collapses onto the V line…
            // …but a block there (infra-His block) must stay visible: it moves onto the wave that arrives
            if (p.terminal === 'block') blocksOnLast.push(p);
            continue;
        }
        if (from.tier === to.tier && from.frac === to.frac && from.tMs === to.tMs) continue;
        paths.push({ ...p, from, to });
    }
    const above = tiers[tiers.length - 2];
    for (const b of blocksOnLast) {
        const inc = paths.find(q => q.to.tier === above && q.to.frac === 1 && Math.abs(q.to.tMs - b.from.tMs) < 1
            && (q.atrialId ?? null) === (b.atrialId ?? null) && (q.beatId ?? null) === (b.beatId ?? null));
        if (!inc) continue;
        // stop short of the V line, with the block bar: the wave never reaches the ventricles
        const f = inc.from, t = inc.to, k = 0.85;
        const tIn = f.tier === t.tier ? f.tMs + (t.tMs - f.tMs) * (k - f.frac) / Math.max(1e-6, t.frac - f.frac) : t.tMs;
        inc.to = { ...t, frac: k, tMs: tIn };
        inc.terminal = 'block';
    }
    const events = ladder.events.map(e => snap(e));
    // A dot wherever conduction meets a level line — the defining mark of this convention. A point at
    // the bottom of tier i sits on the line of tier i+1; blocked and open ends get no dot.
    const onLine = (pt) => {
        if (pt.frac === 0) return { tier: pt.tier, tMs: pt.tMs };
        const i = tiers.indexOf(pt.tier);
        return pt.frac === 1 && i >= 0 && i < tiers.length - 1 ? { tier: tiers[i + 1], tMs: pt.tMs } : null;
    };
    const seen = new Set(events.map(e => `${e.tier}|${Math.round(e.tMs)}|${e.frac}`));
    const add = (q, p) => {
        if (!q) return;
        const k = `${q.tier}|${Math.round(q.tMs)}|0`;
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
 * `inferred` (true unless the point is a marked P or QRS onset — those were measured on the ECG).
 */
export function layoutLadder(ladder, o) {
    const { tMinMs, tMaxMs, xOf, yOfLevel, lineIdOfLevel } = o;
    const pid = o.newPointId || ((n) => `p${n}`), cid = o.newConnectionId || ((n) => `c${n}`);
    const points = o.points || [], connections = o.connections || [];
    const byXY = o.dedupe || new Map();
    const idx = Object.fromEntries((ladder.tiers || []).map((t, i) => [t, i]));
    const level = (pt) => (idx[pt.tier] ?? 0) + pt.frac;
    const r10 = (v) => Math.round(v * 10) / 10;
    const pointAt = (t, lv, meta = {}) => {
        const x = r10(xOf(t)), y = r10(yOfLevel(lv));
        const k = `${x}|${y}`;
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
    const measured = (e) => e.role === 'p' || e.role === 'qrs' || (e.role === 'f' && e.source === 'user');
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
        if (p.label) conn.label = p.label.replace(/\n/g, ' ');
        connections.push(conn);
    }
    for (const pt of points) delete pt.fromEvent;
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
                                               marks = null, provenance = null } = {}) {
    if (!(tMaxMs > tMinMs)) throw new Error('empty time range');
    const list0 = Array.isArray(ladders) ? ladders : [{ ladder: ladders }];
    // each ladder may carry its own style (a teaching figure can show both); `style` is the default
    const styleOf = (it) => (it.style === 'lines' || it.style === 'bands' ? it.style : style);
    const list = list0.map(it => ({ ...it, style: styleOf(it), source: it.ladder, ladder: styleOf(it) === 'lines' ? toLineStyle(it.ladder) : it.ladder }));
    const { W, MARGIN, SPACING, TOP, GAP, NO_IMAGE_Y, IMG_MAX_H, GROUP_GAP } = LEWIS;
    const hasImage = !!(backgroundImage && imageWidthPx > 0 && imageHeightPx > 0);
    let startY = NO_IMAGE_Y;
    if (hasImage) {
        const scale = Math.min((W - 2 * MARGIN) / imageWidthPx, IMG_MAX_H / imageHeightPx);
        startY = imageHeightPx * scale + TOP + GAP;
    }
    const xOf = (t) => MARGIN + (t - tMinMs) / (tMaxMs - tMinMs) * (W - 2 * MARGIN);
    // level = line index (fractional between lines); gi = which ladder, for its GROUP_GAP
    const yOfG = (g, gi = 0) => startY + g * SPACING + gi * GROUP_GAP;

    // Lines: each ladder's tiers (+ the closing bottom edge in band style). `base` = index of its first line.
    const lines = [], bases = [];
    list.forEach(({ ladder, style: st }, g) => {
        bases.push(lines.length);
        const tiers = ladder.tiers || [];
        for (const t of st === 'lines' ? tiers : [...tiers, '']) {
            lines.push({ id: `l${lines.length}`, name: t ? (TIER_CATALOG[t]?.label ?? t) : '', y: Math.round(startY + lines.length * SPACING + g * GROUP_GAP), visible: true, group: g });
        }
    });
    const lineIdOfG = (g) => lines[Math.max(0, Math.min(lines.length - 1, Math.round(g)))].id;

    const points = [], connections = [], dedupe = new Map();
    list.forEach(({ ladder }, gi) => {
        layoutLadder(ladder, { tMinMs, tMaxMs, xOf, points, connections, dedupe,
                               yOfLevel: (lv) => yOfG(bases[gi] + lv, gi), lineIdOfLevel: (lv) => lineIdOfG(bases[gi] + lv) });
    });

    const lastY = yOfG(lines.length - 1, list.length - 1);
    const canvasHeight = Math.max(LEWIS.H, Math.round(lastY + 70));
    // Letters, titles and captions: the editor draws them itself (ladderMeta),
    // so they stay attached to their ladder when it is edited.
    const ladderMeta = list.map((it, g) => ({ group: g, letter: it.letter || (list.length > 1 ? String.fromCharCode(65 + g) : ''),
                                              title: String(it.title ?? it.label ?? ''), caption: String(it.caption || ''), style: it.style }));
    const annotations = [];
    const firstNote = list.length === 1 && !ladderMeta[0].caption ? list[0]?.ladder?.notes?.[0] : null;
    if (firstNote) {
        annotations.push({ id: 'a0', x: MARGIN, y: Math.min(canvasHeight - 12, lastY + 28),
                           text: firstNote.slice(0, 140), type: 'text', fontSize: 11, fontColor: '#1e293b' });
    }
    const out = { lines, points, connections, annotations, freeformLines: [], ladderMeta, ladderStyle: list[0]?.style ?? style, canvasHeight,
                  engine: { name: ENGINE_NAME, version: ENGINE_VERSION } };
    if (backgroundImage) {
        out.backgroundImage = backgroundImage;
        out.imageTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
    }
    // Time calibration: the strip image spans [tMin, tMax] across its full width (renderStripImage);
    // without an image the ladders span x = MARGIN … W − MARGIN.
    out.calibration = hasImage
        ? { space: 'image', x0Px: 0, t0Ms: tMinMs, msPerPx: (tMaxMs - tMinMs) / imageWidthPx, method: 'generator', confidence: 'measured' }
        : { space: 'canvas', x0Px: MARGIN, t0Ms: tMinMs, msPerPx: (tMaxMs - tMinMs) / (W - 2 * MARGIN), method: 'schematic', confidence: 'assumed' };
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
                     engineVersion: ENGINE_VERSION, status: r.linked === false ? 'detached' : 'linked' };
        });
    }
    if (provenance) out.provenance = provenance;
    return out;
}
