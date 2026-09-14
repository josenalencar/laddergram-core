/**
 * The live EP recorder: the channels of a running heart (epsim.js) swept across a black screen in colour,
 * as an EP recording system shows them.
 *
 * A sweep draws at the paper speed chosen (100, 200 or 300 mm/s at 4 px per mm), one pixel column at a
 * time, erasing a narrow band just ahead of the pen and wrapping at the right edge, so the newest beat
 * always writes over the oldest; a tick marks every 100 ms and a taller one every second. Surface lead II
 * and V1 are written from the same activations (P, QRS and T shaped by where each came from), then the
 * intracardiac channels, then the stimulator.
 *
 * Canvas-only, no DOM and no clock: the page owns the animation frame, advances the simulation and calls
 * `drawUntil`. Both products use this file, so the recorder looks the same in either.
 */
import { PX_PER_MM, LABEL_W, EGM_CHANNEL_LABELS } from './render.js';
import { EGM_COLORS, EGM_CHANNELS, channelsOf, deflectionAt, deflectionSpanMs } from './egm.js';

export const LIVE_SURFACE = Object.freeze(['II', 'V1']);

/** The rows of a live screen, top to bottom: the surface leads, the catheters chosen, the stimulator. */
export function liveChannels(ep) {
    return [...LIVE_SURFACE, ...channelsOf(ep), 'Stim'];
}

// ─── the surface ECG of a live heart ────────────────────────────────────────

const G = (t, c, s, a) => a * Math.exp(-0.5 * ((t - c) / s) ** 2);

/** QRS shapes per lead: [ms after onset, σ, mV]. */
const QRS_SHAPES = {
    normal: { II: [[12, 5, -0.1], [38, 9, 1.1], [62, 8, -0.25]], V1: [[18, 6, 0.25], [48, 12, -0.9]] },
    RBBB: { II: [[12, 5, -0.08], [36, 9, 0.9], [60, 9, -0.2], [100, 16, -0.35]], V1: [[16, 6, 0.3], [40, 9, -0.35], [92, 15, 0.8]] },
    LBBB: { II: [[30, 14, 0.7], [95, 20, 0.6]], V1: [[20, 8, 0.1], [70, 25, -1.1]] },
    RV: { II: [[40, 16, 0.9], [110, 22, 0.5]], V1: [[70, 28, -1.2]] },
    LV: { II: [[40, 16, -0.8], [110, 22, -0.3]], V1: [[50, 20, 1.2], [120, 22, 0.4]] },
    pre: { II: [[25, 16, 0.5], [70, 14, 0.9], [105, 14, -0.2]], V1: [[30, 16, 0.4], [80, 16, 0.7]] },
};
const shapeOf = (origin) => (origin?.startsWith('pre') ? 'pre' : QRS_SHAPES[origin] ? origin : 'normal');

/** The surface lead (II or V1) at time t, from the activations around it (mV). */
export function surfaceAt(acts, lead, tMs) {
    let v = 0;
    for (const a of acts) {
        const dt = tMs - a.tMs;
        if (dt < -5 || dt > 700) continue;
        if (a.kind === 'A') {
            if (a.origin === 'flutter') v += lead === 'II' ? G(dt, 90, 38, -0.16) + G(dt, 175, 16, 0.1) : G(dt, 60, 30, 0.08);
            else if (a.origin === 'sinus') v += lead === 'II' ? G(dt, 45, 18, 0.12) : G(dt, 30, 12, 0.07) + G(dt, 65, 14, -0.05);
            else v += lead === 'II' ? G(dt, 45, 20, -0.15) : G(dt, 40, 16, 0.09);
        } else if (a.kind === 'f') {
            v += G(dt, 10, 12, lead === 'V1' ? 0.06 : 0.025);
        } else if (a.kind === 'V') {
            for (const [c, s, amp] of QRS_SHAPES[shapeOf(a.origin)][lead] || []) v += G(dt, c, s, amp);
            const wide = shapeOf(a.origin) !== 'normal';
            v += G(dt, wide ? 300 : 270, 45, lead === 'II' ? (wide ? -0.25 : 0.28) : (wide ? 0.2 : 0.12));
        } else if (a.kind === 'S') {
            v += G(dt, 0.5, 0.6, 0.6) + G(dt, 3, 3, -0.08);
        }
    }
    return v;
}

// ─── sampling ───────────────────────────────────────────────────────────────

function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * Values of every channel over a pixel column, from a running simulation. `prepare` once per frame over the
 * time the frame draws; `column` per channel per column → { min, max, last } in channel units (mV for the
 * surface leads, near-field ≈ 1 for the catheters).
 */
export function createSampler(sim, { seed = 11, noise = 0.012 } = {}) {
    const rnd = lcg(seed);
    let acts = [], byCh = new Map();
    const valueAt = (ch, t) => {
        if (LIVE_SURFACE.includes(ch)) return surfaceAt(acts, ch, t);
        let v = 0;
        for (const d of byCh.get(ch) || []) if (t >= d.tMs - 2 && t <= d.tMs + d.span) v += deflectionAt(d, t);
        return v;
    };
    return {
        prepare(fromMs, toMs) {
            const s = sim.schedule(fromMs - 700, toMs);
            acts = s.activations;
            byCh = new Map();
            for (const d of s.deflections) {
                if (!byCh.has(d.ch)) byCh.set(d.ch, []);
                byCh.get(d.ch).push({ ...d, span: deflectionSpanMs(d) });
            }
        },
        column(ch, t0, t1) {
            const n = Math.max(2, Math.ceil(t1 - t0));
            let min = Infinity, max = -Infinity, last = 0;
            for (let i = 0; i <= n; i++) {
                const v = valueAt(ch, t0 + (t1 - t0) * i / n) + (ch === 'Stim' ? 0 : noise * (rnd() - 0.5) * 2);
                if (v < min) min = v;
                if (v > max) max = v;
                last = v;
            }
            return { min, max, last };
        },
    };
}

// ─── the sweep ──────────────────────────────────────────────────────────────

const TOP = 8, BOTTOM = 18;

/**
 * A sweep on a 2D context (already scaled to CSS px).
 * @returns { reset(tMs), drawUntil(tMs, sampler), resize(cssW, cssH), setSpeed(mmS), setChannels(list), mark(tMs, kind), penT, rows }
 */
export function createSweep({ ctx, cssW, cssH, channels, speedMmS = 100, labelW = LABEL_W, colors = EGM_COLORS, eraseAheadPx = 14 }) {
    let W = cssW, H = cssH, speed = speedMmS, list = channels.slice();
    let penX = labelW, penT = 0, prevY = {}, marks = [];
    const rowH = () => (H - TOP - BOTTOM) / Math.max(1, list.length);
    const midOf = (i) => TOP + rowH() * (i + 0.5);
    const gainOf = (ch) => rowH() * (LIVE_SURFACE.includes(ch) ? 0.5 : ch === 'Stim' ? 0.3 : 0.42);

    function paintFrame() {
        ctx.fillStyle = colors.BG;
        ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = colors.TICK_BOLD; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(labelW - 0.5, 0); ctx.lineTo(labelW - 0.5, H); ctx.stroke();
        ctx.font = '600 11px -apple-system, "Segoe UI", sans-serif';
        ctx.textAlign = 'right';
        list.forEach((ch, i) => {
            ctx.fillStyle = colors[ch] ?? colors.LABEL;
            ctx.fillText(EGM_CHANNEL_LABELS[ch] ?? ch, labelW - 6, midOf(i) + 4);
        });
        ctx.textAlign = 'left';
    }

    function reset(tMs = penT) {
        penT = tMs; penX = labelW; prevY = {}; marks = [];
        paintFrame();
    }

    function drawUntil(tMs, sampler) {
        const msPerPx = 1000 / (speed * PX_PER_MM);
        if (tMs - penT > 4000) { penT = tMs - 4000; prevY = {}; }     // the page was hidden: do not replay minutes
        const cols = [];
        let x = penX;
        while (penT + msPerPx <= tMs) {
            if (x >= W) { x = labelW; cols.push(null); }                // wrap: the pen goes back to the left edge
            cols.push({ x, t0: penT, t1: penT + msPerPx });
            penT += msPerPx; x += 1;
        }
        const real = cols.filter(Boolean);
        if (!real.length) return;
        sampler.prepare(real[0].t0, real[real.length - 1].t1);

        ctx.fillStyle = colors.BG;
        for (const c of real) ctx.fillRect(c.x, 0, Math.min(eraseAheadPx, W - c.x), H);
        // time ticks along the bottom
        ctx.lineWidth = 1;
        for (const c of real) {
            const k = Math.floor(c.t1 / 100);
            if (k * 100 < c.t0 || k * 100 >= c.t1) continue;
            const bold = k % 10 === 0;
            ctx.strokeStyle = bold ? colors.TICK_BOLD : colors.TICK;
            ctx.beginPath(); ctx.moveTo(c.x + 0.5, H - (bold ? BOTTOM - 2 : 8)); ctx.lineTo(c.x + 0.5, H - 2); ctx.stroke();
        }
        // a shock or a note, where the pen passes it
        for (const m of marks) {
            const c = real.find(cc => m.tMs >= cc.t0 && m.tMs < cc.t1);
            if (!c) continue;
            ctx.strokeStyle = m.kind === 'shock' ? '#ef4444' : colors.PEN;
            ctx.beginPath(); ctx.moveTo(c.x + 0.5, 0); ctx.lineTo(c.x + 0.5, H - BOTTOM); ctx.stroke();
        }
        marks = marks.filter(m => m.tMs >= penT);

        ctx.lineWidth = 1.3; ctx.lineJoin = 'round';
        list.forEach((ch, i) => {
            const mid = midOf(i), g = gainOf(ch);
            ctx.strokeStyle = colors[ch] ?? colors.PEN;
            ctx.beginPath();
            let y = prevY[ch], started = false;
            for (const c of cols) {
                if (!c) { started = false; y = undefined; continue; }
                const v = sampler.column(ch, c.t0, c.t1);
                const yMin = mid - v.max * g, yMax = mid - v.min * g, yLast = mid - v.last * g;
                // start where the pen stopped (the last column ended half a pixel on), or at the edge after a wrap
                if (!started) { ctx.moveTo(y != null ? c.x - 0.5 : c.x, y ?? yLast); started = true; }
                ctx.lineTo(c.x, yMin); ctx.lineTo(c.x, yMax); ctx.lineTo(c.x + 0.5, yLast);
                y = yLast;
            }
            ctx.stroke();
            prevY[ch] = y;
        });
        penX = x;
    }

    reset(0);
    return {
        reset, drawUntil,
        resize(w, h) { W = w; H = h; reset(penT); },
        setSpeed(mmS) { speed = mmS; reset(penT); },
        setChannels(next) { list = next.slice(); reset(penT); },
        mark(tMs, kind = 'note') { marks.push({ tMs, kind }); },
        get penT() { return penT; },
        get channels() { return list.slice(); },
        get speedMmS() { return speed; },
    };
}

export { EGM_COLORS, EGM_CHANNELS };
