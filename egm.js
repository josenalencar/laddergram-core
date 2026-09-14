/**
 * Intracardiac electrograms from a reading: what catheters at the high right atrium, the His bundle, the
 * coronary sinus and the right ventricular apex record for the ladder the reading draws.
 *
 * Nothing here is new physiology. The ladder already says when the atrium, the His and the ventricle are
 * activated on every beat, and from where: a sinus P, a P returning up the fast or the slow pathway or up
 * an accessory pathway, a flutter wave, a conducted, aberrant, pre-excited or ectopic ventricle. A catheter
 * records that activation where it sits, a fixed anatomical time later — the His catheter sees the low
 * septal atrium PA after the P onset, the coronary sinus sees the left atrium proximal to distal, a
 * retrograde wave up the fast pathway reaches the septum first. So every deflection here is a ladder event
 * plus one of the offsets in the tables below, and the tables are the whole model (PREMISES.md §7).
 *
 * The waveforms are drawn, not simulated: a sharp near-field complex where the catheter lies on the tissue
 * that fired, a small blunt far-field one where it does not. The live recorder (epsim.js) turns its own
 * activations into deflections with `activationDeflections`, so a live tracing started from a reading
 * records exactly what the static figure shows.
 *
 * Pure: no DOM. Deterministic: the noise and the beat-to-beat variation of each deflection are seeded.
 */
import { buildLadder, normalizeTiers, resolveParams, DEFAULT_TIERS } from './engine.js';
import { EGM_CHANNEL_LABELS } from './render.js';

// ─── what can be recorded ───────────────────────────────────────────────────

/** The catheters a reader can place, in the order an EP system lists them. */
export const CATHETERS = Object.freeze([
    { id: 'HRA', label: 'HRA', what: 'high right atrium (near the sinus node)' },
    { id: 'His', label: 'His', what: 'His bundle region, at the top of the septal tricuspid annulus' },
    { id: 'CS910', label: 'CS 9-10', what: 'coronary sinus, proximal pair (at the ostium, posteroseptal)' },
    { id: 'CS78', label: 'CS 7-8', what: 'coronary sinus, pair 7-8' },
    { id: 'CS56', label: 'CS 5-6', what: 'coronary sinus, pair 5-6' },
    { id: 'CS34', label: 'CS 3-4', what: 'coronary sinus, pair 3-4' },
    { id: 'CS12', label: 'CS 1-2', what: 'coronary sinus, distal pair (lateral mitral annulus)' },
    { id: 'RVa', label: 'RVa', what: 'right ventricular apex' },
]);
export const CATHETER_IDS = Object.freeze(CATHETERS.map(c => c.id));
export const DEFAULT_CATHETERS = CATHETER_IDS;
/** Every channel a schedule records: the His catheter as one bipole, or as its proximal and distal pairs. */
export const EGM_CHANNELS = Object.freeze(['HRA', 'His', 'Hisp', 'Hisd', 'CS910', 'CS78', 'CS56', 'CS34', 'CS12', 'RVa']);
export const CHANNEL_LABELS = EGM_CHANNEL_LABELS;
const CS = ['CS910', 'CS78', 'CS56', 'CS34', 'CS12'];
const HIS = ['His', 'Hisp', 'Hisd'];

/** Sweep speeds of an EP recording (mm/s). */
export const EP_SPEEDS = Object.freeze([100, 200, 300]);
/** Where an accessory pathway inserts. 'auto': septal for PJRT (a posteroseptal pathway), left lateral otherwise. */
export const AP_SITES = Object.freeze(['auto', 'leftLateral', 'septal', 'rightLateral']);
/** Where a ventricular focus (PVC, VT, ventricular escape) arises. */
export const V_ORIGINS = Object.freeze(['RV', 'LV']);
/** The six orders of the three blocks of a frame, top to bottom. */
export const BLOCK_ORDERS = Object.freeze([
    ['strip', 'egm', 'ladder'], ['strip', 'ladder', 'egm'], ['egm', 'strip', 'ladder'],
    ['egm', 'ladder', 'strip'], ['ladder', 'strip', 'egm'], ['ladder', 'egm', 'strip'],
].map(o => Object.freeze(o)));
export const BLOCK_LABELS = Object.freeze({ strip: 'Surface tracing', egm: 'Intracardiac channels', ladder: 'Ladder' });

export const DEFAULT_EP = Object.freeze({
    catheters: DEFAULT_CATHETERS, hisSplit: false, apSite: 'auto', vOrigin: 'RV',
    speedMmS: 100, order: BLOCK_ORDERS[0], showLetters: true, showAhHv: true,
});

/**
 * Colours of the live recorder, on black, as EP recording systems show them: surface leads white and green,
 * the HRA yellow, the His orange, the coronary sinus in blues from its ostium to its distal pair, the RV apex
 * pink, the stimulator white. The static figure is black and white like the ladder.
 */
export const EGM_COLORS = Object.freeze({
    BG: '#05070a', TICK: '#1f2a37', TICK_BOLD: '#3b4a5e', LABEL: '#cbd5e1', PEN: '#f8fafc',
    II: '#f8fafc', V1: '#86efac',
    HRA: '#facc15', His: '#fb923c', Hisp: '#fdba74', Hisd: '#fb923c',
    CS910: '#a5f3fc', CS78: '#67e8f9', CS56: '#22d3ee', CS34: '#38bdf8', CS12: '#60a5fa',
    RVa: '#f472b6', Stim: '#ffffff',
});

/**
 * The settings of the EP view, read back with only what the renderer and the recorder act on. Garbage gives
 * the defaults; a list of catheters keeps only known ones, in their own order.
 */
export function cleanEp(o) {
    if (!o || typeof o !== 'object') return null;
    const order = Array.isArray(o.order) && BLOCK_ORDERS.some(b => b.length === o.order.length && b.every((x, i) => x === o.order[i]))
        ? o.order.slice() : DEFAULT_EP.order.slice();
    return {
        catheters: Array.isArray(o.catheters) ? CATHETER_IDS.filter(id => o.catheters.includes(id)) : DEFAULT_CATHETERS.slice(),
        hisSplit: o.hisSplit === true,
        apSite: AP_SITES.includes(o.apSite) ? o.apSite : 'auto',
        vOrigin: V_ORIGINS.includes(o.vOrigin) ? o.vOrigin : 'RV',
        speedMmS: EP_SPEEDS.includes(+o.speedMmS) ? +o.speedMmS : DEFAULT_EP.speedMmS,
        order,
        showLetters: o.showLetters !== false,
        showAhHv: o.showAhHv !== false,
    };
}

/** The channel rows a setting draws, top to bottom. */
export function channelsOf(ep) {
    const e = cleanEp(ep) ?? cleanEp({});
    const out = [];
    for (const id of CATHETER_IDS) {
        if (!e.catheters.includes(id)) continue;
        if (id === 'His' && e.hisSplit) out.push('Hisp', 'Hisd');
        else out.push(id);
    }
    return out;
}

/** What makeLayout needs to reserve the intracardiac block for these settings. */
export const egmLayoutOptions = (ep) => {
    const e = cleanEp(ep) ?? cleanEp({});
    return { channels: channelsOf(e), letters: e.showLetters, brackets: e.showAhHv };
};

// ─── the model: activation sequences ────────────────────────────────────────

/**
 * Atrial activation, ms after the atrial line of the ladder (the P onset, the retrograde P onset, the F wave).
 * HisA is the atrial deflection on the His catheter. Sources: Josephson (6th ed., ch. 2 and 8); Issa, Miller &
 * Zipes (3rd ed., ch. 4). Typical values, rounded: a teaching model, not a patient.
 */
export function atrialSequence(origin, P = resolveParams({})) {
    const pa = P.PA;
    switch (origin) {
        // from the sinus node (or a high atrial focus, or pacing at the HRA): down the right atrium to the
        // septum PA later, then across the left atrium proximal to distal along the coronary sinus
        case 'sinus': return { HRA: 0, HisA: pa, CS910: pa + 10, CS78: pa + 20, CS56: pa + 30, CS34: pa + 40, CS12: pa + 50 };
        // up the fast pathway: the anterior septum first, concentric (proximal to distal), the HRA late
        case 'fast': return { HisA: 0, CS910: 10, CS78: 20, CS56: 30, CS34: 40, CS12: 50, HRA: 35 };
        // up the slow pathway: the posterior septum, at the coronary sinus ostium, before the His
        case 'slow': return { CS910: 0, CS78: 10, HisA: 15, CS56: 20, CS34: 30, CS12: 40, HRA: 45 };
        // up a left lateral accessory pathway: eccentric, the distal coronary sinus first
        case 'apLeftLateral': return { CS12: 0, CS34: 10, CS56: 20, CS78: 30, CS910: 40, HisA: 50, HRA: 70 };
        // up a posteroseptal pathway: the coronary sinus ostium first, then the septum
        case 'apSeptal': return { CS910: 0, HisA: 5, CS78: 10, CS56: 20, CS34: 30, CS12: 40, HRA: 35 };
        // up a right free-wall pathway: the lateral right atrium first, the coronary sinus last
        case 'apRightLateral': return { HRA: 0, HisA: 25, CS910: 35, CS78: 45, CS56: 55, CS34: 65, CS12: 75 };
        // typical (counter-clockwise) flutter: up the septum — ostium and His first — and down the lateral wall
        case 'flutter': return { CS910: 0, HisA: 10, CS78: 10, CS56: 20, CS34: 30, CS12: 40, HRA: 100 };
        default: return atrialSequence('sinus', P);
    }
}

/**
 * Ventricular activation, ms after the ventricular line (the QRS onset). HisV is the ventricular deflection
 * on the His catheter (the basal septum); the coronary sinus records the left ventricle far-field.
 */
export function ventricularSequence(origin) {
    switch (origin) {
        case 'normal': return { HisV: 15, RVa: 25, CS910: 45, CS78: 52, CS56: 58, CS34: 64, CS12: 70 };
        // right bundle blocked: the RV apex is reached late, across the septum from the left
        case 'RBBB': return { HisV: 15, RVa: 70, CS910: 45, CS78: 52, CS56: 58, CS34: 64, CS12: 70 };
        // left bundle blocked: the left ventricle is reached late, from the right
        case 'LBBB': return { HisV: 20, RVa: 25, CS910: 85, CS78: 95, CS56: 105, CS34: 115, CS12: 125 };
        // a focus at the RV apex
        case 'RV': return { RVa: 0, HisV: 40, CS910: 70, CS78: 80, CS56: 90, CS34: 100, CS12: 110 };
        // a focus on the lateral left ventricle: the distal coronary sinus first
        case 'LV': return { CS12: 0, CS34: 8, CS56: 16, CS78: 24, CS910: 32, HisV: 50, RVa: 65 };
        // pre-excited over an accessory pathway, from where it inserts
        case 'preLeftLateral': return { CS12: 0, CS34: 10, CS56: 20, CS78: 30, CS910: 40, HisV: 45, RVa: 55 };
        case 'preSeptal': return { HisV: 0, CS910: 10, RVa: 20, CS78: 20, CS56: 30, CS34: 40, CS12: 50 };
        case 'preRightLateral': return { RVa: 15, HisV: 30, CS910: 60, CS78: 70, CS56: 80, CS34: 90, CS12: 100 };
        default: return ventricularSequence('normal');
    }
}

const AP_ATRIAL = { leftLateral: 'apLeftLateral', septal: 'apSeptal', rightLateral: 'apRightLateral' };
const AP_VENT = { leftLateral: 'preLeftLateral', septal: 'preSeptal', rightLateral: 'preRightLateral' };

// ─── deflections ────────────────────────────────────────────────────────────

/** Amplitudes (a near-field deflection peaks at 1). The His catheter's proximal pair sees more atrium, its distal pair more His and ventricle. */
const HIS_AMP = {
    A: { His: 0.55, Hisp: 0.8, Hisd: 0.35 },
    H: { His: 0.45, Hisp: 0.3, Hisd: 0.55 },
    V: { His: 0.65, Hisp: 0.4, Hisd: 0.85 },
};
/** The distal His pair is reached this long after the proximal one. */
const HIS_DISTAL_LAG = 4;

const r1 = (t) => Math.round(t * 10) / 10;

/**
 * The deflections one activation writes on every channel.
 * @param act  { kind: 'A'|'f'|'H'|'V'|'S', tMs, origin?, site?, prime?, beatId?, atrialId?, n? }
 *             A: origin in atrialSequence; V: origin in ventricularSequence; f: one fibrillatory wave
 *             (n seeds where each channel catches it); S: a stimulus at site 'HRA' | 'RVa'
 * @returns [{ ch, kind, tMs, amp, far, beatId, atrialId }]
 */
export function activationDeflections(act, P = resolveParams({})) {
    const out = [];
    const meta = { beatId: act.beatId ?? null, atrialId: act.atrialId ?? null };
    const push = (ch, kind, t, amp, far = false, extra = {}) => out.push({ ch, kind, tMs: r1(t), amp, far, ...meta, ...extra });
    const t = act.tMs;
    if (act.kind === 'A') {
        const q = atrialSequence(act.origin, P);
        push('HRA', 'A', t + q.HRA, 1);
        push('His', 'A', t + q.HisA, HIS_AMP.A.His);
        push('Hisp', 'A', t + q.HisA, HIS_AMP.A.Hisp);
        push('Hisd', 'A', t + q.HisA + HIS_DISTAL_LAG, HIS_AMP.A.Hisd);
        for (const ch of CS) push(ch, 'A', t + q[ch], 1);
    } else if (act.kind === 'f') {
        // fibrillation: every catheter catches a wave near this one, at its own moment and size
        const rnd = lcg(0x9e3779b1 ^ Math.round(act.n ?? t));
        const at = (ch, amp) => push(ch, 'f', t + 60 * rnd(), amp * (0.6 + 0.5 * rnd()));
        at('HRA', 0.7); at('His', 0.3); at('Hisp', 0.45); at('Hisd', 0.2);
        for (const ch of CS) at(ch, 0.7);
    } else if (act.kind === 'H') {
        const extra = act.prime ? { prime: true } : {};
        push('His', 'H', t, HIS_AMP.H.His, false, extra);
        push('Hisp', 'H', t, HIS_AMP.H.Hisp, false, extra);
        push('Hisd', 'H', t + HIS_DISTAL_LAG, HIS_AMP.H.Hisd, false, extra);
    } else if (act.kind === 'V') {
        const q = ventricularSequence(act.origin);
        push('HRA', 'V', t + 35, 0.12, true);
        push('His', 'V', t + q.HisV, HIS_AMP.V.His);
        push('Hisp', 'V', t + q.HisV, HIS_AMP.V.Hisp);
        push('Hisd', 'V', t + q.HisV, HIS_AMP.V.Hisd);
        for (const ch of CS) push(ch, 'V', t + q[ch], 0.35, true);
        push('RVa', 'V', t + q.RVa, 1);
    } else if (act.kind === 'S') {
        push('Stim', 'S', t, 1);
        push(act.site === 'RVa' ? 'RVa' : 'HRA', 'S', t, 0.9);
    }
    return out;
}

// ─── the schedule: activations of a ladder ──────────────────────────────────

const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

/**
 * Every chamber and His activation a ladder draws, with where it came from.
 * @returns [{ kind: 'A'|'f'|'H'|'V', tMs, origin, beatId, atrialId, retro?, prime? }] sorted by time
 */
export function ladderActivations(L, { apSite = 'leftLateral', vOrigin = 'RV', beats = [] } = {}) {
    const acts = [];
    const beatById = new Map(beats.map(b => [b.id, b]));
    let nf = 0;

    for (const e of L.events) {
        if (e.tier !== 'A') continue;
        const base = { tMs: e.tMs, beatId: e.beatId ?? null, atrialId: e.atrialId ?? null };
        if (e.role === 'p' || e.role === 'p-edge' || e.role === 'focus-atrial') acts.push({ kind: 'A', origin: 'sinus', ...base });
        else if (e.role === 'F') acts.push({ kind: 'A', origin: 'flutter', ...base });
        else if (e.role === 'f') acts.push({ kind: 'f', n: nf++, ...base });
        else if (e.role === 'p-retro') {
            const sameBeat = (p) => e.beatId == null || p.beatId === e.beatId;
            const ap = L.paths.find(p => p.role === 'ap' && p.to.tier === 'A' && near(p.to.tMs, e.tMs) && sameBeat(p));
            const up = ap ? null : L.paths.find(p => p.role === 'av-retro' && near(p.to.tMs, e.tMs) && sameBeat(p));
            const slow = !!up && (up.label === 'slow' || up.style === 'wavy' || up.to.tier === 'AVs');
            acts.push({ kind: 'A', origin: ap ? AP_ATRIAL[apSite] : slow ? 'slow' : 'fast', retro: true, ...base });
        }
    }

    const his = [];
    for (const p of L.paths) {
        if (p.from.tier !== 'His') continue;
        if (p.role === 'his' || p.role === 'his-retro' || (p.role === 'his-block' && p.from.frac === 0)) {
            his.push({ kind: 'H', tMs: p.from.tMs, beatId: p.beatId ?? null, atrialId: p.atrialId ?? null, ...(p.role === 'his-retro' ? { retro: true } : {}) });
        }
    }
    for (const e of L.events) if (e.role === 'focus-his') his.push({ kind: 'H', tMs: e.tMs, beatId: null, atrialId: e.atrialId ?? null, prime: true });
    his.sort((a, b) => a.tMs - b.tMs);
    for (const h of his) {
        const prev = acts.filter(a => a.kind === 'H').pop();
        if (prev && Math.abs(prev.tMs - h.tMs) < 4) continue;          // a junctional focus and its His segment: one His
        acts.push(h);
    }

    const preExcited = new Set(L.paths.filter(p => p.role === 'ap-ante').map(p => p.beatId));
    const conducted = new Set();
    for (const e of L.events) {
        if (e.role !== 'qrs') continue;
        conducted.add(e.beatId);
        const c = String(beatById.get(e.beatId)?.conduction || '');
        const origin = preExcited.has(e.beatId) ? AP_VENT[apSite] : c.includes('RBBB') ? 'RBBB' : c.includes('LBBB') ? 'LBBB' : 'normal';
        acts.push({ kind: 'V', tMs: e.tMs, origin, beatId: e.beatId, atrialId: null });
    }
    // a ventricular focus with no conducted QRS of its own (a fusion beat has both: it is drawn conducted)
    for (const e of L.events) {
        if (e.role === 'focus-ventricular' && !conducted.has(e.beatId)) acts.push({ kind: 'V', tMs: e.tMs, origin: vOrigin, beatId: e.beatId, atrialId: null });
    }
    return acts.sort((a, b) => a.tMs - b.tMs);
}

/** Where the deflection of each kernel peaks, for the letters (computed once, below). */
const KERNEL_PEAK = {};
/**
 * Waveform kernels: [ms after the deflection onset, width σ (ms), relative amplitude]. Each is a sum of
 * Gaussians with alternating signs — a sharp multiphasic near-field complex, a smooth far-field one —
 * normalised so its largest excursion is 1.
 */
export const EGM_KERNELS = (() => {
    const raw = {
        A: [[3, 2.2, 0.45], [9, 2.6, -1], [16, 3, 0.8], [24, 3.5, -0.3]],
        H: [[2, 1.1, 0.5], [5.5, 1.3, -1], [9, 1.5, 0.45]],
        V: [[5, 3, 0.4], [14, 3.6, 1], [25, 4.5, -0.85], [38, 6, 0.3]],
        Afar: [[10, 6, 0.6], [24, 8, -0.35]],
        Vfar: [[14, 9, 0.7], [38, 12, -0.5]],
        f: [[3, 2, 0.6], [8, 2.2, -1], [13, 2.6, 0.45]],
        S: [[0.6, 0.45, 1], [3, 2.5, -0.25]],
    };
    const out = {};
    for (const [k, parts] of Object.entries(raw)) {
        const end = Math.max(...parts.map(([c, s]) => c + 4 * s));
        let peak = 0, at = 0;
        for (let t = -2; t <= end; t += 0.25) {
            const v = parts.reduce((acc, [c, s, a]) => acc + a * Math.exp(-0.5 * ((t - c) / s) ** 2), 0);
            if (Math.abs(v) > peak) { peak = Math.abs(v); at = t; }
        }
        out[k] = Object.freeze({ parts: Object.freeze(parts.map(([c, s, a]) => Object.freeze([c, s, a / peak]))), endMs: end });
        KERNEL_PEAK[k] = at;
    }
    return Object.freeze(out);
})();

const kernelOf = (d) => (d.kind === 'A' ? (d.far ? 'Afar' : 'A') : d.kind === 'V' ? (d.far ? 'Vfar' : 'V') : d.kind);

/**
 * The electrograms of a reading.
 * @param input  { beats, atrial, mechanism, params, tiers, durationMs } — the reading, as buildLadder takes it.
 *               The His tier is added for the schedule whatever the tiers drawn: a His catheter records the
 *               His whether or not the ladder shows its tier.
 * @param ep     the EP settings (cleanEp)
 * @returns { durationMs, channels, opts, apSite, activations, deflections, letters, beats }
 *   deflections  [{ ch, kind: 'A'|'H'|'V'|'f'|'S', tMs, amp, far, beatId, atrialId }] — every channel, sorted by time
 *   letters      [{ tMs, centerMs, text: 'A'|'H'|'H′'|'V' }] — over the His deflections
 *   beats        [{ beatId, tV, tH, tHisA, AH, HV, VA, VH, origin }] — per ventricular activation
 */
export function egmSchedule(input, ep = DEFAULT_EP) {
    const opts = cleanEp(ep) ?? cleanEp({});
    const P = resolveParams(input.params);
    const tiers = normalizeTiers([...((input.tiers && input.tiers.length) ? input.tiers : DEFAULT_TIERS), 'His']);
    const beats = input.beats || [];
    const L = buildLadder({ beats, atrial: input.atrial || [], mechanism: input.mechanism, params: input.params, tiers, durationMs: input.durationMs });
    const apSite = opts.apSite === 'auto' ? (L.mechanism === 'pjrt' ? 'septal' : 'leftLateral') : opts.apSite;
    const activations = ladderActivations(L, { apSite, vOrigin: opts.vOrigin, beats });
    const deflections = activations.flatMap(a => activationDeflections(a, P)).sort((a, b) => a.tMs - b.tMs);

    const letters = deflections.filter(d => d.ch === 'His' && (d.kind === 'A' || d.kind === 'H' || d.kind === 'V'))
        .map(d => ({ tMs: d.tMs, centerMs: KERNEL_PEAK[kernelOf(d)] ?? 0, text: d.kind === 'H' && d.prime ? 'H′' : d.kind }));

    const atrialActs = activations.filter(a => a.kind === 'A');
    const out = [];
    for (const v of activations.filter(a => a.kind === 'V')) {
        const b = { beatId: v.beatId, tV: v.tMs, tH: null, tHisA: null, AH: null, HV: null, VA: null, VH: null, origin: v.origin };
        const ante = L.paths.find(p => p.role === 'his' && p.beatId === v.beatId && p.from.tMs <= v.tMs);
        if (ante) { b.tH = ante.from.tMs; b.HV = r1(v.tMs - b.tH); }
        const av = L.paths.find(p => p.role === 'av' && p.beatId === v.beatId);
        const feeding = av && atrialActs.find(a => near(a.tMs, av.from.tMs, 2));
        if (feeding && b.tH != null) {
            b.tHisA = r1(feeding.tMs + atrialSequence(feeding.origin, P).HisA);
            b.AH = r1(b.tH - b.tHisA);
        }
        const retroP = L.events.find(e => e.role === 'p-retro' && e.beatId === v.beatId);
        if (retroP) b.VA = r1(retroP.tMs - v.tMs);
        const retroH = activations.find(a => a.kind === 'H' && a.retro && a.beatId === v.beatId && a.tMs > v.tMs);
        if (retroH) b.VH = r1(retroH.tMs - v.tMs);
        out.push(b);
    }

    return { durationMs: input.durationMs ?? null, channels: channelsOf(opts), opts, apSite, mechanism: L.mechanism,
             activations, deflections, letters, beats: out };
}

// ─── samples ────────────────────────────────────────────────────────────────

function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const gauss = (rnd) => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

/** One kernel added into a signal at `tMs`, `amp` high, `stretch` wide. */
export function addKernel(x, fs, tMs, kernel, amp, stretch = 1) {
    const k = EGM_KERNELS[kernel];
    if (!k) return;
    const i0 = Math.max(0, Math.floor((tMs - 2) * fs / 1000));
    const i1 = Math.min(x.length - 1, Math.ceil((tMs + k.endMs * stretch) * fs / 1000));
    for (let i = i0; i <= i1; i++) {
        const t = (i * 1000 / fs - tMs) / stretch;
        let v = 0;
        for (const [c, s, a] of k.parts) v += a * Math.exp(-0.5 * ((t - c) / s) ** 2);
        x[i] += amp * v;
    }
}

/** The value of one deflection's waveform at time t (the live recorder evaluates columns, not arrays). */
export function deflectionAt(d, tMs, { seed = 7 } = {}) {
    const k = EGM_KERNELS[kernelOf(d)];
    if (!k) return 0;
    const { amp, stretch } = jitterOf(d, seed);
    const t = (tMs - d.tMs) / stretch;
    if (t < -2 || t > k.endMs) return 0;
    let v = 0;
    for (const [c, s, a] of k.parts) v += a * Math.exp(-0.5 * ((t - c) / s) ** 2);
    return d.amp * amp * v;
}
/** How long a deflection lasts, for the recorder's look-up window. */
export const deflectionSpanMs = (d) => (EGM_KERNELS[kernelOf(d)]?.endMs ?? 0) * 1.08 + 2;

/** No two beats are drawn identical: each deflection is a little taller or shorter, wider or narrower. */
function jitterOf(d, seed) {
    const ci = EGM_CHANNELS.indexOf(d.ch) + 1;
    const rnd = lcg((Math.imul(seed, 2654435761) ^ Math.imul(Math.round(d.tMs * 10), 40503) ^ Math.imul(ci, 977)) >>> 0);
    rnd();
    return { amp: 0.92 + 0.16 * rnd(), stretch: 0.94 + 0.12 * rnd() };
}

/**
 * The schedule as signals: one Float32Array per channel, `fs` samples per second from `t0Ms` to `durationMs`
 * (sample 0 is at t0Ms — a strip whose time axis was set on a grid click has times before zero), with a little
 * seeded noise and baseline drift. The same schedule, window and seed give the same arrays.
 */
export function egmSamples(schedule, { fs = 1000, durationMs = schedule?.durationMs, t0Ms = 0, seed = 7, channels = schedule?.channels } = {}) {
    const n = Math.max(0, Math.round(((durationMs || 0) - t0Ms) * fs / 1000));
    const list = (channels || []).filter(ch => EGM_CHANNELS.includes(ch));
    const out = {};
    list.forEach((ch, ci) => {
        const rnd = lcg((Math.imul(seed, 7919) + ci * 104729) >>> 0);
        const ph = rnd() * 2 * Math.PI;
        const x = new Float32Array(n);
        for (let i = 0; i < n; i++) x[i] = 0.018 * gauss(rnd) + 0.02 * Math.sin(2 * Math.PI * 0.3 * i / fs + ph);
        out[ch] = x;
    });
    for (const d of schedule?.deflections || []) {
        const x = out[d.ch];
        if (!x) continue;
        const { amp, stretch } = jitterOf(d, seed);
        addKernel(x, fs, d.tMs - t0Ms, kernelOf(d), d.amp * amp, stretch);
    }
    return { fs, n, t0Ms, durationMs: durationMs ?? null, channels: out };
}
