/**
 * Laddergram engine — builds a Lewis ladder diagram from surface-ECG timing.
 *
 * Pure: no DOM, no globals, deterministic (the AF f-waves use a fixed seed).
 * Node-testable (test_laddergram.mjs).
 *
 * The idea: the only things the ECG tells us are WHEN the ventricles start
 * (QRS onset, tier V) and WHEN the atria start (P onset, tier A). Everything
 * between them — how long the AV node took, when the His fired, where a
 * blocked P died — is filled in by plausibility: interval arithmetic with
 * physiologic defaults (PA, HV, AH), and a mechanism the user chooses.
 *
 * Ground truth = `beats` + `atrial` (user-editable). The ladder is ALWAYS
 * derived from them; never edit a ladder in place.
 *
 * Geometry convention (what the renderer and the lewis-ladder export read):
 *   every tier is a horizontal BAND; a point is (tier, tMs, frac) where frac
 *   is the vertical position inside the band (0 = top edge, 1 = bottom edge).
 *   Conduction through a tier is a segment (tIn, frac 0) → (tOut, frac 1), so
 *   its slope IS the conduction time. The bottom edge of one tier is the top
 *   edge of the next (A frac 1 ≡ AV frac 0), so segments chain continuously.
 *   Retrograde conduction runs bottom → top with an arrowhead.
 *   The two chambers are instantaneous at this scale: the atrium is a vertical
 *   line at P onset through the A tier, the ventricle a vertical line at QRS
 *   onset through the V tier, on every beat. Conduction between them is drawn
 *   in the tiers in between: the AV band runs from P onset to His activation
 *   (PH, the surface counterpart of AH), His to QRS onset is HV. PA stays in the
 *   interval arithmetic (AH = PR − PA − HV) but has no drawn extent.
 *   Every point sits at the time of the event it stands for (A = P onset,
 *   V = QRS onset, His = QRS onset − HV). The drawing rules, with their
 *   reasons, are listed in PREMISES.md.
 *
 * Optional tiers (the user picks them): AV fast + AV slow (replace AV), His,
 * the bundle branches and the fascicles. The accessory pathway has no tier of
 * its own: it is one straight line labelled "AP" crossing the junction. Parallel
 * structures are stacked bands; the impulse reaches a band that is not the
 * next one down through a thin vertical PASS connector (style 'pass') —
 * "traversed, no delay attributed here". A segment always lives inside one band.
 */

// ─── tiers ──────────────────────────────────────────────────────────────────

/**
 * kind: which ground-truth marker a click on that band edits
 * (atrial → P onsets, ventricular → QRS onsets, both → nearest).
 * group: parallel structures — drawn with a dashed boundary between them.
 */
export const TIER_CATALOG = Object.freeze({
    SN: { label: 'SN', rank: 1, h: 24, kind: 'atrial' },
    A: { label: 'A', rank: 2, h: 42, kind: 'atrial' },
    AV: { label: 'AV', rank: 3, h: 66, kind: 'both' },
    AVf: { label: 'AV fast', rank: 3.1, h: 38, kind: 'both', group: 'av-dual' },
    AVs: { label: 'AV slow', rank: 3.2, h: 38, kind: 'both', group: 'av-dual' },
    His: { label: 'His', rank: 4, h: 34, kind: 'ventricular' },   // tall enough that the HV segment reads as nearly vertical
    RBB: { label: 'RBB', rank: 5, h: 26, kind: 'ventricular', group: 'branches' },
    LBB: { label: 'LBB', rank: 5.5, h: 26, kind: 'ventricular', group: 'branches' },
    LAF: { label: 'LAF', rank: 5.6, h: 22, kind: 'ventricular', group: 'fascicles' },
    LPF: { label: 'LPF', rank: 5.7, h: 22, kind: 'ventricular', group: 'fascicles' },
    V: { label: 'V', rank: 6, h: 42, kind: 'ventricular' },
});
export const DEFAULT_TIERS = Object.freeze(['SN', 'A', 'AV', 'His', 'V']);
/** @deprecated use DEFAULT_TIERS / ladder.tiers */
export const TIERS = DEFAULT_TIERS;

/** His share of HV when the bundle branches are drawn; LBB-trunk share of the rest when fascicles are. */
export const JUNCTION = Object.freeze({ hisShare: 0.35, lbbShare: 0.4, stubMs: 20, stubDepth: 0.4 });
export const CONDUCTIONS = Object.freeze([null, 'RBBB', 'LBBB', 'LAFB', 'LPFB', 'RBBB+LAFB', 'RBBB+LPFB']);

/**
 * Make a tier list legal: known ids, anatomic order, A and V always, AV or the
 * AV fast/slow pair (the pair wins), branches and fascicles as pairs (fascicles
 * need the branches).
 */
export function normalizeTiers(ids) {
    if (!Array.isArray(ids) || !ids.length) return DEFAULT_TIERS.slice();
    const s = new Set(ids.filter(t => Object.prototype.hasOwnProperty.call(TIER_CATALOG, t)));
    s.add('A'); s.add('V');
    if (s.has('AVf') || s.has('AVs')) { s.add('AVf'); s.add('AVs'); s.delete('AV'); }
    else s.add('AV');
    if (s.has('RBB') || s.has('LBB')) { s.add('RBB'); s.add('LBB'); }
    if (s.has('LAF') || s.has('LPF')) {
        if (s.has('LBB')) { s.add('LAF'); s.add('LPF'); } else { s.delete('LAF'); s.delete('LPF'); }
    }
    return [...s].sort((a, b) => TIER_CATALOG[a].rank - TIER_CATALOG[b].rank);
}

function tierContext(list) {
    const idx = Object.fromEntries(list.map((t, i) => [t, i]));
    const has = (t) => Object.prototype.hasOwnProperty.call(idx, t);
    const dual = has('AVf');
    return {
        list, idx, has, dual,
        lvl: (t, f) => idx[t] + f,
        av: dual ? 'AVf' : 'AV',          // where antegrade AV-nodal conduction runs
        avLow: dual ? 'AVs' : 'AV',       // the band touching the His / branches
        hasSN: has('SN'), hasHis: has('His'), hasBB: has('RBB'), hasFasc: has('LAF'),
    };
}

// ─── parameters ─────────────────────────────────────────────────────────────

/** Stamped into every ladder and every export, so a figure can say which engine drew it. */
export const ENGINE_NAME = 'laddergram-core';
export const ENGINE_VERSION = '1.26.0';

/** Sources for the default intervals and plausibility thresholds shown to users. */
export const REFERENCES = {
    josephson: "Josephson ME. Josephson's Clinical Cardiac Electrophysiology: Techniques and Interpretations. 6th ed. Wolters Kluwer; 2021.",
    issa: "Issa ZF, Miller JM, Zipes DP. Clinical Arrhythmology and Electrophysiology: A Companion to Braunwald's Heart Disease. 3rd ed. Elsevier; 2019.",
};

export const DEFAULT_PARAMS = Object.freeze({
    SACT: 60,        // sinoatrial conduction: SN discharge → P onset
    PA: 35,          // intra-atrial: P onset → AV-node entry (high RA → low septum)
    HV: 45,          // His → ventricular onset
    AHmin: 40,       // shortest plausible AV-nodal conduction
    PRmin: 80,       // pairing window: a P conducts to a QRS only if PR ∈ [PRmin, PRmax]
    PRmax: 600,
    VA: 40,          // SVT: QRS onset → retrograde P onset
    apVdelay: 20,    // AVRT: QRS onset → activation of the pathway's ventricular end
    apToAV: 20,      // AVRT: retrograde atrial activation → AV-node entry
    vExit: 40,       // PVC: focus → retrograde exit into the His-Purkinje system
    ectopicVA: null, // PVC / junctional: retrograde VA; null = concealed (no retro P)
    wideQrsMs: 120,  // wide QRS → ventricular (not junctional) origin when unpaired
    fWaveMs: null,   // flutter F–F override; null = fitted from the F waves you mark
    fPhaseMs: null,  // flutter phase override (time of one F wave)
    fibMeanMs: 170,  // AF: mean f–f cycle of the schematic f waves
    concealDepth: 0.5, // how far a concealed retrograde wave penetrates the AV node
    blockDepth: 0.45,  // how far a blocked antegrade wave penetrates the AV node
    blockBelowHis: 0,  // complete block: 0 = in the AV node, 1 = below the His (infra-Hisian)
    jtNodeMs: 25,      // junctional tachycardia: focus → His entry (the focus sits in the node)
    apAnteMs: 50,      // antidromic AVRT: atrial end of the pathway → delta wave (a Kent pathway conducts fast)
    vhMs: 80,          // antidromic AVRT: QRS onset → retrograde His — the slow part: ventricular muscle back to the His–Purkinje system
    hPrimeLead: 70,    // concealed His extrasystole: H′ this long before the P reaches the node
    LRI: null,         // pacing: lower rate interval; null = from the paced cycles you marked
    AVI: null,         // pacing: AV delay (sensed or paced P → paced QRS); null = from your marks
    PVARP: 250,        // pacing: post-ventricular atrial refractory period (the device ignores a P inside it)
    VRP: 250,          // pacing: ventricular refractory period (the device ignores a QRS inside it)
});

/** Labels/units for the params panel. `adv` = hidden under "advanced". */
export const PARAM_INFO = {
    SACT: { kind: 'assumed', needsTier: ['SN'], label: 'SA conduction', unit: 'ms', normal: [45, 125], ref: 'josephson', what: 'sinus-node discharge → P onset: the slope across the SN tier' },
    PA: { kind: 'assumed', label: 'PA (intra-atrial)', unit: 'ms', normal: [25, 55], ref: 'josephson', what: 'P onset → AV-node entry: used to estimate AH (PR − PA − HV); the atrial tier itself is drawn instantaneous, so the AV band spans PA + AH' },
    HV: { kind: 'assumed', needsTier: ['His', 'RBB'], label: 'HV', unit: 'ms', normal: [35, 55], ref: 'josephson', what: 'His → QRS onset: the His line ends this long before the V line' },
    AHmin: { kind: 'assumed', label: 'AH minimum', unit: 'ms', normal: [55, 125], normalOf: 'AH', ref: 'josephson', what: 'the fastest the AV node conducts; a PR shorter than PA + AH min + HV is drawn as pre-excitation' },
    PRmin: { kind: 'pairing', label: 'PR min (pairing)', unit: 'ms', adv: true, what: 'a P closer than this to a QRS is not the one that conducted it' },
    PRmax: { kind: 'pairing', label: 'PR max (pairing)', unit: 'ms', adv: true, what: 'a P further than this from a QRS is not the one that conducted it' },
    VA: { kind: 'clinical', label: 'VA (QRS onset → retro P)', unit: 'ms', threshold: { at: 70, meaning: '≤ 70 ms favours typical AVNRT; > 70 ms allows orthodromic AVRT' }, ref: 'issa', what: 'QRS onset → retrograde P onset: where the returning wave reaches the atrium' },
    apVdelay: { kind: 'assumed', label: 'QRS onset → AP ventricular end', unit: 'ms', adv: true, what: 'QRS onset → the ventricular end of the accessory pathway' },
    apToAV: { kind: 'orphan', label: 'Retro A → AV-node entry', unit: 'ms', adv: true, what: 'retrograde atrial activation → the next entry into the AV node (AH estimate only; the atrium is drawn instantaneous)' },
    vExit: { kind: 'assumed', label: 'PVC focus → His exit', unit: 'ms', adv: true, what: 'ectopic focus → exit into the His–Purkinje system (retrograde)' },
    ectopicVA: { kind: 'clinical', label: 'Ectopic retro VA (empty = concealed)', unit: 'ms', what: 'ectopic QRS onset → retrograde P; empty = the wave dies in the AV node' },
    wideQrsMs: { kind: 'pairing', label: 'Wide QRS from', unit: 'ms', adv: true, what: 'a QRS at least this wide, with no bundle-branch block marked, is drawn as ventricular' },
    fWaveMs: { kind: 'schematic', label: 'F–F override (empty = from your F marks)', unit: 'ms', adv: true, what: 'fixed F–F cycle instead of the one fitted to your F marks' },
    fPhaseMs: { kind: 'schematic', label: 'F phase override (one F at)', unit: 'ms', adv: true, what: 'time of one F wave, to shift the fitted F waves' },
    fibMeanMs: { kind: 'schematic', label: 'Mean f–f cycle', unit: 'ms', what: 'spacing of the schematic f waves' },
    concealDepth: { kind: 'geometry', label: 'Concealed depth (0–1)', unit: '', adv: true, what: 'how far into the AV node a concealed retrograde wave is drawn' },
    blockDepth: { kind: 'geometry', label: 'Block depth (0–1)', unit: '', adv: true, what: 'how far into the AV node a blocked P is drawn' },
    blockBelowHis: { kind: 'assumed', label: 'Block below the His (0 = AV node, 1 = infra-His)', unit: '', what: 'where the block sits: 0 = AV node, 1 = below the His (complete block: ventricular escape; 2:1 or other drops that are not Wenckebach: the His is recorded and the ventricle is not reached)' },
    jtNodeMs: { kind: 'assumed', label: 'Focus → His (in the node)', unit: 'ms', adv: true, what: 'junctional focus → His entry' },
    apAnteMs: { kind: 'assumed', label: 'Pathway conduction (atrial end → delta wave)', unit: 'ms', what: 'atrial end of the pathway → delta wave: the pre-excited descent' },
    vhMs: { kind: 'assumed', needsTier: ['His'], label: 'QRS onset → retrograde His (through ventricular muscle)', unit: 'ms', adv: true, what: 'QRS onset → retrograde His: the slow return through ventricular muscle' },
    hPrimeLead: { kind: 'assumed', label: 'H′ before the P reaches the node', unit: 'ms', what: 'how long before the P reaches the node the hidden H′ fires' },
    LRI: { kind: 'clinical', label: 'Lower rate interval (empty = from your marks)', unit: 'ms', what: 'the longest the device waits before it paces: the paced-to-paced cycle' },
    AVI: { kind: 'clinical', label: 'AV delay (empty = from your marks)', unit: 'ms', what: 'P (sensed or paced) → paced QRS in a dual-chamber device' },
    PVARP: { kind: 'assumed', label: 'PVARP', unit: 'ms', normal: [200, 350], what: 'after each ventricular event the device ignores atrial activity this long (it is not tracked)' },
    VRP: { kind: 'assumed', label: 'VRP', unit: 'ms', normal: [200, 300], what: 'after each ventricular event the device ignores ventricular activity this long' },
};

const ALWAYS = ['SACT', 'PA', 'HV', 'AHmin', 'PRmin', 'PRmax', 'wideQrsMs', 'concealDepth', 'blockDepth'];
export const MECHANISMS = [
    { id: 'avnodal', label: 'Sinus / AV conduction (1st-degree, Wenckebach, Mobitz II, 2:1)', params: [...ALWAYS, 'ectopicVA', 'blockBelowHis'] },
    { id: 'avb3', label: 'Complete (3rd-degree) AV block', params: [...ALWAYS, 'blockBelowHis'] },
    { id: 'hisExtra', label: 'Concealed His extrasystoles (pseudo AV block)', params: [...ALWAYS, 'hPrimeLead'] },
    { id: 'avnrt', label: 'AVNRT — typical / atypical by VA', params: [...ALWAYS, 'VA'] },
    { id: 'avrt', label: 'Orthodromic AVRT (accessory pathway)', params: [...ALWAYS, 'VA', 'apVdelay'] },
    { id: 'pjrt', label: 'PJRT (orthodromic AVRT over a slow, decremental pathway — long RP)', params: [...ALWAYS, 'VA', 'apVdelay'] },
    { id: 'avrtAnti', label: 'Antidromic AVRT (anterograde over the pathway)', params: [...ALWAYS, 'VA', 'apAnteMs', 'vhMs'] },
    { id: 'at', label: 'Atrial tachycardia (atrial focus)', params: ALWAYS },
    { id: 'jt', label: 'Junctional tachycardia (nodal focus)', params: [...ALWAYS, 'VA', 'jtNodeMs'] },
    { id: 'pvc', label: 'Sinus + ectopic beats (PVC / junctional)', params: [...ALWAYS, 'ectopicVA', 'vExit'] },
    { id: 'vt', label: 'Ventricular tachycardia (AV dissociation, capture beats)', params: [...ALWAYS, 'ectopicVA', 'vExit'] },
    { id: 'afib', label: 'Atrial fibrillation', params: [...ALWAYS, 'fibMeanMs'] },
    { id: 'flutter', label: 'Atrial flutter', params: [...ALWAYS, 'fWaveMs', 'fPhaseMs'] },
    { id: 'paced', label: 'Paced rhythm (VVI, AAI, DDD — from the marks you flag as paced)', params: [...ALWAYS, 'LRI', 'AVI', 'PVARP', 'VRP'], needs: 'pacedMarks' },
];

export const AP_COLOR = '#b45309';
const DEDUP_MS = 40;

// ─── small utilities ────────────────────────────────────────────────────────

const r1 = (t) => Math.round(t * 10) / 10;
const byT = (a, b) => a.tMs - b.tMs;
const byQ = (a, b) => a.qrsOnMs - b.qrsOnMs;
function median(a) {
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const isWide = (b, P) => (b.qrsWidthMs ?? (b.qrsOffMs - b.qrsOnMs)) >= P.wideQrsMs;
/** Ventricular origin: a PVC, or a wide QRS nobody explained with a bundle-branch block. */
const isEctopicLike = (b, P) => b.quality === 'pvc' || (isWide(b, P) && !b.conduction);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(+v)) ? null : +v;

export function resolveParams(params) {
    const P = { ...DEFAULT_PARAMS };
    for (const [k, v] of Object.entries(params || {})) {
        if (!(k in DEFAULT_PARAMS)) continue;
        P[k] = num(v) ?? DEFAULT_PARAMS[k];
    }
    return P;
}

// Deterministic LCG so the AF drawing is identical on every rebuild.
function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// ─── pairing ────────────────────────────────────────────────────────────────

/**
 * Pair each QRS with the P that conducted it: the NEAREST preceding P whose
 * PR falls inside [minLead, PRmax] and that no earlier QRS already claimed.
 * Greedy in QRS order — nearest-preceding is what resolves 2:1 and Wenckebach
 * (the extra P sits too close to, or too far from, the QRS and stays unpaired).
 */
/**
 * A PR shorter than this is not conduction, whatever the rest of the strip says. Pre-excitation can be
 * very short, so this sits below the shortest accessory-pathway PR rather than at the nodal floor.
 */
export const PR_FLOOR_MS = 40;

/**
 * Which P conducted to which QRS.
 *
 * The window [PRmin, PRmax] is a prior about hearts in general, and the strip in front of us is evidence
 * about this one. When most beats agree on a PR, a beat whose only candidate P sits a little outside the
 * general window is far more likely to be the same thing as its neighbours than to be a coincidence — a
 * tracing marked at a PR of 85 ms will have some beats at 75, and drawing those two as blocked while
 * drawing the other fourteen as conducted describes no heart that exists.
 *
 * So: pair with the general window first; then, only if that left a QRS with no P at all, and only if the
 * PRs it did find agree closely with each other, widen the window around what this strip actually does and
 * try once more. The wider pass is kept only when it explains more of the strip.
 */
export function pairAtrialToBeats(beats, atrial, params, { minLeadMs } = {}) {
    const P = resolveParams(params);
    const minLead = minLeadMs ?? P.PRmin;
    const B = beats.slice().sort(byQ), A = atrial.slice().sort(byT);
    const aById = new Map(A.map(a => [a.id, a]));

    // What the reader has said outright is never re-decided: a beat told which P conducted it keeps that P,
    // a beat that says none conducted it is never given one, and a P called blocked conducts nothing.
    const forced = new Map();
    for (const b of B) if (!b.noConductedP && b.pairedAtrialId && aById.has(b.pairedAtrialId)) forced.set(b.id, b.pairedAtrialId);
    const alone = new Set(B.filter(b => b.noConductedP).map(b => b.id));
    // A P named as the one a beat went back up to was activated from below, so it is not available to
    // have conducted anything from above. Reserving it here is what makes that answer mean something.
    const spoken = new Set([
        ...forced.values(),
        ...A.filter(a => a.blockedAt).map(a => a.id),
        ...B.map(b => b.retroAtrialId).filter(id => id && aById.has(id)),
    ]);

    const run = (lo, hi) => {
        const claimed = new Set(spoken);
        const pairs = new Map(forced);
        const unpairedV = [];
        for (const b of B) {
            if (alone.has(b.id)) { unpairedV.push(b); continue; }
            if (pairs.has(b.id)) continue;
            let best = null;
            for (const a of A) {
                if (claimed.has(a.id)) continue;
                const lead = b.qrsOnMs - a.tMs;
                if (lead < lo || lead > hi) continue;
                if (!best || a.tMs > best.tMs) best = a;
            }
            if (!best) { unpairedV.push(b); continue; }
            pairs.set(b.id, best.id);
            claimed.add(best.id);
        }
        return { pairs, unpairedA: A.filter(a => !claimed.has(a.id)), unpairedV };
    };

    const first = run(minLead, P.PRmax);
    // Nothing to rescue, or too little agreement to learn from.
    if (!first.unpairedV.length || first.pairs.size < 3) return first;

    const bById = new Map(B.map(b => [b.id, b]));
    const prs = [...first.pairs].map(([bId, aId]) => bById.get(bId).qrsOnMs - aById.get(aId).tMs);
    const med = median(prs);
    const mad = median(prs.map(x => Math.abs(x - med)));
    // Wenckebach lengthens the PR on purpose, so its PRs do not agree and the window must not move.
    if (!(mad <= Math.max(15, 0.15 * med))) return first;

    const lo = Math.max(PR_FLOOR_MS, Math.min(minLead, med - Math.max(35, 4 * mad)));
    if (lo >= minLead) return first;
    const second = run(lo, P.PRmax);
    return second.pairs.size > first.pairs.size ? second : first;
}

/** RR, PR, AH, HV per beat for a given pairing. */
export function measureIntervals(beats, atrial, pairs, params) {
    const P = resolveParams(params);
    const aById = new Map(atrial.map(a => [a.id, a]));
    const B = beats.slice().sort(byQ);
    return B.map((b, i) => {
        const a = pairs.get(b.id) ? aById.get(pairs.get(b.id)) : null;
        const PR = a ? r1(b.qrsOnMs - a.tMs) : null;
        return {
            beatId: b.id,
            RRms: i > 0 ? r1(b.qrsOnMs - B[i - 1].qrsOnMs) : null,
            PRms: PR,
            AHms: PR != null ? r1(PR - P.PA - (b.params?.HV ?? P.HV)) : null,
            HVms: b.params?.HV ?? P.HV,
            VAms: null,
            conduction: b.conduction ?? null,
            flags: [],
        };
    });
}

// ─── flutter ────────────────────────────────────────────────────────────────

/**
 * F–F cycle and phase from ≥ 2 marked F-wave onsets (they need not be
 * consecutive). The smallest gap between marks is taken as n cycles, n chosen
 * so one cycle lands in the flutter range (160–350 ms); each mark then gets
 * its cycle index and a least-squares line t = phase + k·cycle is fitted
 * (twice, re-indexing with the first estimate).
 * @returns {{cycleMs, phaseMs, n, residualMs, rateBpm}|null}
 */
export function fitFlutter(marks, { minCycle = 160, maxCycle = 350, typical = 250 } = {}) {
    const t = [...new Set((marks || []).map(m => (typeof m === 'number' ? m : m.tMs)).filter(Number.isFinite))]
        .sort((a, b) => a - b);
    if (t.length < 2) return null;
    const gaps = [];
    for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] > 40) gaps.push(t[i] - t[i - 1]);
    if (!gaps.length) return null;
    const g0 = Math.min(...gaps);
    const n = g0 >= minCycle && g0 <= maxCycle ? 1 : Math.max(1, Math.round(g0 / typical));
    let cycle = g0 / n;
    let a = t[0];
    for (let pass = 0; pass < 2; pass++) {
        const k = t.map(x => Math.round((x - t[0]) / cycle));
        if (new Set(k).size < 2) return null;
        const mk = k.reduce((s, v) => s + v, 0) / k.length, mt = t.reduce((s, v) => s + v, 0) / t.length;
        let sxy = 0, sxx = 0;
        k.forEach((kv, i) => { sxy += (kv - mk) * (t[i] - mt); sxx += (kv - mk) ** 2; });
        cycle = sxy / sxx;
        a = mt - cycle * mk;
    }
    const k = t.map(x => Math.round((x - a) / cycle));
    const residualMs = Math.max(...t.map((x, i) => Math.abs(x - (a + k[i] * cycle))));
    return { cycleMs: r1(cycle), phaseMs: r1(a), n: t.length, residualMs: r1(residualMs), rateBpm: Math.round(60000 / cycle) };
}

// ─── the builder ────────────────────────────────────────────────────────────

function makeBuilder(mechanism, P, T) {
    const L = { tiers: T.list.slice(), mechanism, params: P, events: [], paths: [], intervals: [], notes: [], claims: [] };
    let ne = 0, np = 0;
    const links = new Set();
    const ev = (tier, tMs, frac, o = {}) => {
        const e = { id: 'e' + (ne++), tier, tMs: r1(tMs), frac, style: o.style || 'dot', dir: o.dir || 'ante',
                    role: o.role || '', beatId: o.beatId ?? null, atrialId: o.atrialId ?? null, source: o.source || 'derived',
                    ...(o.timeHandle ? { timeHandle: o.timeHandle } : {}) };
        L.events.push(e);
        return e;
    };
    const seg = (from, to, o = {}) => {
        const p = { id: 'p' + (np++), beatId: o.beatId ?? null, atrialId: o.atrialId ?? null,
                    from: { tier: from[0], tMs: r1(from[1]), frac: from[2] },
                    to: { tier: to[0], tMs: r1(to[1]), frac: to[2] },
                    style: o.style || 'solid', terminal: o.terminal || 'point', arrow: o.arrow || 'none',
                    curve: o.curve || 0, label: o.label || null, color: o.color || null, role: o.role || '',
                    ...(o.labelAnchor ? { labelAnchor: o.labelAnchor } : {}),
                    ...(o.timeHandle ? { timeHandle: o.timeHandle } : {}) };
        L.paths.push(p);
        return p;
    };
    /** Pass connector: vertical at t between two band positions; nothing when they touch. */
    const link = (t, tierA, fracA, tierB, fracB, o = {}) => {
        if (!T.has(tierA) || !T.has(tierB)) return null;
        const la = T.lvl(tierA, fracA), lb = T.lvl(tierB, fracB);
        if (Math.abs(la - lb) < 1e-6) return null;
        const key = `${r1(t)}|${la}|${lb}`;
        if (links.has(key)) return null;
        links.add(key);
        return seg([tierA, t, fracA], [tierB, t, fracB], { ...o, style: 'pass', role: 'pass' });
    };
    // notes: plain strings (what the viewer lists); claims: the same text with a level and a code, so a
    // UI can badge warnings and link a claim to the elements it concerns
    const note = (s, level = 'info', code = '') => {
        if (L.notes.includes(s)) return;
        L.notes.push(s);
        L.claims.push({ level, code, text: s });
    };
    return { L, ev, seg, link, note, P, T };
}

/** When the wave leaves each junctional level, for a QRS at qrsOn. */
/**
 * Where a beat crosses the junction. A beat may carry timings of its own — an ectopic beat does not
 * conduct through the His–Purkinje system the way the sinus beats around it do — and those win for that
 * beat alone, leaving the rest of the ladder on the ladder's own values.
 */
const beatParams = (B, b) => (b && b.params ? { ...B.P, ...b.params } : B.P);

function junctionTimes(B, qrsOn, own = null) {
    const T = B.T;
    const P = own ? { ...B.P, ...own } : B.P;
    const tHisIn = qrsOn - P.HV;
    const tHb = T.hasBB ? qrsOn - (1 - JUNCTION.hisShare) * P.HV : qrsOn;
    const tLb = T.hasFasc ? tHb + JUNCTION.lbbShare * (qrsOn - tHb) : qrsOn;
    const tAvOut = T.hasHis ? tHisIn : tHb;
    return { tHisIn, tHb, tLb, tAvOut };
}

// Segment builders. Each takes the builder `B` first.

function sinusEntry(B, a, { sn = true, focus = false } = {}) {
    const { P, T } = B;
    if (focus) {
        // an atrial focus: the line starts de novo inside the atrial tier, nothing enters it
        B.ev('A', a.tMs, 0.3, { style: 'asterisk', role: 'focus-atrial', atrialId: a.id, source: a.source || 'auto' });
        B.seg(['A', a.tMs, 0.3], ['A', a.tMs, 1], { atrialId: a.id, role: 'atrium' });
        return;
    }
    if (sn && T.hasSN) {
        // The sinus dot sits one sinoatrial conduction time before the P: dragging it is setting SACT.
        const h = { at: 'from', param: 'SACT', atrialId: a.id };
        B.ev('SN', a.tMs - P.SACT, 0.5, { role: 'sn', atrialId: a.id, timeHandle: h });
        B.seg(['SN', a.tMs - P.SACT, 0.5], ['A', a.tMs, 0], { atrialId: a.id, role: 'sa', timeHandle: h });
    }
    B.ev('A', a.tMs, 0, { role: 'p', atrialId: a.id, source: a.source || 'auto' });
    B.seg(['A', a.tMs, 0], ['A', a.tMs, 1], { atrialId: a.id, role: 'atrium' });
}

/** Antegrade AV-nodal conduction (in AV, or AV fast when the pair is drawn). */
function avConduct(B, tIn, tOut, o = {}) {
    return B.seg([B.T.av, tIn, 0], [B.T.av, tOut, 1], { role: 'av', ...o });
}

function avBlock(B, tIn, depth, o = {}) {
    B.seg([B.T.av, tIn, 0], [B.T.av, tIn + B.P.AHmin, depth ?? B.P.blockDepth],
          { terminal: 'block', role: 'av-block', ...o });
}

/** Retrograde up the AV node (the fast pathway when the pair is drawn), from its bottom at tFrom. */
function avRetro(B, tFrom, tTo, o = {}) {
    const { T } = B;
    const fromFrac = o.fromFrac ?? 1;
    if (T.dual) B.link(tFrom, 'AVs', fromFrac, 'AVf', 1, { beatId: o.beatId });
    B.seg([T.av, tFrom, T.dual ? 1 : fromFrac], [T.av, tTo, 0], { arrow: 'end', role: 'av-retro', beatId: o.beatId, style: o.style, label: o.label });
}

/** Concealed retrograde penetration: a dashed stub from the bottom of the node. */
function avConcealed(B, tFrom, o = {}) {
    const { T, P } = B;
    B.seg([T.avLow, tFrom, 1], [T.avLow, tFrom + 60, 1 - P.concealDepth],
          { style: 'dashed', terminal: 'block', role: 'av-concealed', ...o });
}

function blockStub(B, tier, t, o = {}) {
    B.seg([tier, t, 0], [tier, t + JUNCTION.stubMs, JUNCTION.stubDepth], { terminal: 'block', role: 'bb-block', ...o });
}

const blockedParts = (c) => new Set(c ? String(c).split('+') : []);

/** RBB / LBB (and LAF / LPF) for one beat, from `src` bottom at tHb, per beat.conduction. */
function branches(B, b, J, src) {
    const { T } = B;
    const q = b.qrsOnMs, o = { beatId: b.id };
    const blk = blockedParts(b.conduction);
    B.link(J.tHb, src, 1, 'LBB', 0, o);                 // entry: crosses RBB
    const ends = [];                                    // tiers that conduct all the way to qrsOn
    if (blk.has('RBBB')) blockStub(B, 'RBB', J.tHb, o);
    else { B.seg(['RBB', J.tHb, 0], ['RBB', q, 1], { ...o, role: 'bb' }); ends.push('RBB'); }
    if (blk.has('LBBB')) blockStub(B, 'LBB', J.tHb, o);
    else if (!T.hasFasc) { B.seg(['LBB', J.tHb, 0], ['LBB', q, 1], { ...o, role: 'bb' }); ends.push('LBB'); }
    else {
        B.seg(['LBB', J.tHb, 0], ['LBB', J.tLb, 1], { ...o, role: 'bb' });
        if (blk.has('LAFB')) blockStub(B, 'LAF', J.tLb, o);
        else { B.seg(['LAF', J.tLb, 0], ['LAF', q, 1], { ...o, role: 'bb' }); ends.push('LAF'); }
        B.link(J.tLb, 'LBB', 1, 'LPF', 0, o);
        if (blk.has('LPFB')) blockStub(B, 'LPF', J.tLb, o);
        else { B.seg(['LPF', J.tLb, 0], ['LPF', q, 1], { ...o, role: 'bb' }); ends.push('LPF'); }
    }
    const top = ends.sort((x, y) => T.idx[x] - T.idx[y])[0];
    if (top) B.link(q, top, 1, 'V', 0, o);
}

/** His (if drawn), branches (if drawn), and the vertical V line. `from` = band the wave leaves the AV level by. */
function hisAndV(B, b, { from } = {}) {
    const { T } = B;
    from = from || T.av;
    const J = junctionTimes(B, b.qrsOnMs, b.params);
    if (T.hasHis) {
        B.link(J.tHisIn, from, 1, 'His', 0, { beatId: b.id });
        // Where this segment starts IS the HV, measured back from the QRS onset: an editor can let a
        // reader drag the dot instead of typing the number.
        B.seg(['His', J.tHisIn, 0], ['His', J.tHb, 1],
              { beatId: b.id, role: 'his', timeHandle: { at: 'from', param: 'HV', beatId: b.id } });
    }
    const src = T.hasHis ? 'His' : from;
    if (T.hasBB) branches(B, b, J, src);
    else B.link(b.qrsOnMs, src, 1, 'V', 0, { beatId: b.id });
    vTier(B, b);
}

/**
 * The V tier of a beat: a vertical line at QRS onset, narrow or wide, conducted,
 * aberrant or pre-excited (PREMISES.md: the ventricle is marked by the onset of
 * its activation; a wide QRS is shown by the blocked branch, the pathway or the
 * ventricular focus, not by the V line).
 */
function vTier(B, b) {
    B.ev('V', b.qrsOnMs, 0, { role: 'qrs', beatId: b.id, source: b.source || 'auto' });
    const end = b.qrsOnMs;
    const label = b.origin === 'capture' ? 'capture' : b.origin === 'fusion' ? 'fusion' : null;
    B.seg(['V', b.qrsOnMs, 0], ['V', end, 1], { beatId: b.id, role: 'ventricle', label });
}

function atrialRetro(B, tA, o = {}) {
    B.ev('A', tA, 1, { role: 'p-retro', dir: 'retro', ...o });
    B.seg(['A', tA, 1], ['A', tA, 0], { arrow: 'end', role: 'atrium-retro', ...o });
}

/** Junctional focus (His tier, or low in the AV node when His is hidden). retroTo = retro P time or null. */
function junctionalFocus(B, b, retroTo, { retro = true } = {}) {
    const { T } = B;
    const P = beatParams(B, b);
    const tF = b.qrsOnMs - P.HV;
    const J = junctionTimes(B, b.qrsOnMs, b.params);
    if (T.hasHis) {
        B.ev('His', tF, 0, { style: 'asterisk', role: 'focus-junctional', beatId: b.id });
        hisAndV(B, b, { from: T.avLow });
    } else {
        B.ev(T.avLow, tF, 0.8, { style: 'asterisk', role: 'focus-junctional', beatId: b.id });
        B.seg([T.avLow, tF, 0.8], [T.avLow, J.tAvOut, 1], { beatId: b.id, role: 'junction' });
        hisAndV(B, b, { from: T.avLow });
    }
    if (!retro) return null;
    const fromFrac = T.hasHis ? 1 : 0.8;
    if (retroTo != null) {
        const tA = Math.max(retroTo, tF + 10);
        avRetro(B, tF, tA, { beatId: b.id, fromFrac });
        atrialRetro(B, tA, { beatId: b.id });
        return tA;
    }
    avConcealed(B, tF, { beatId: b.id });
    return null;
}

/** Leave the ventricle at time t: a slant from mid-V (the focus / activation) to the top of V. */
function vExit(B, b, t, role = 'ventricle-retro') {
    B.seg(['V', b.qrsOnMs, 0.5], ['V', t, 0], { beatId: b.id, role });
}

/** Ventricular focus (PVC / ventricular escape). retroTo as above. */
function ventricularFocus(B, b, retroTo, { retro = true } = {}) {
    const { T } = B;
    const P = beatParams(B, b);
    B.ev('V', b.qrsOnMs, 0.5, { style: 'asterisk', role: 'focus-ventricular', beatId: b.id, source: b.source || 'auto' });
    B.seg(['V', b.qrsOnMs, 0.5], ['V', b.qrsOnMs, 1], { beatId: b.id, role: 'ventricle' });
    if (!retro) return null;
    const tExit = b.qrsOnMs + P.vExit;
    vExit(B, b, tExit);
    const upper = T.hasHis ? 'His' : T.avLow;
    let tUp = tExit;                                    // time the wave reaches the bottom of `upper`
    if (T.hasBB) {
        const share = (1 - JUNCTION.hisShare) * P.HV;
        tUp = tExit + share;
        B.seg(['V', tExit, 0], ['RBB', tUp, 0], { beatId: b.id, role: 'bb-retro' });
        B.link(tUp, 'RBB', 0, upper, 1, { beatId: b.id });
    } else B.link(tExit, 'V', 0, upper, 1, { beatId: b.id });
    let tAV = tUp;
    if (T.hasHis) {
        tAV = tExit + P.HV;
        B.seg(['His', tUp, 1], ['His', tAV, 0], { arrow: 'end', beatId: b.id, role: 'his-retro' });
    }
    if (retroTo != null) {
        const tA = Math.max(retroTo, tAV + 10);
        if (retroTo < tAV + 10) B.note(`Ectopic VA ${Math.round(retroTo - b.qrsOnMs)} ms is shorter than the retrograde path (vExit + HV); drawn at the minimum.`, 'warning', 'ectopic-va-short');
        avRetro(B, tAV, tA, { beatId: b.id });
        atrialRetro(B, tA, { beatId: b.id });
        snInvade(B, tA, { beatId: b.id });
        return tA;
    }
    avConcealed(B, tAV, { beatId: b.id });
    return null;
}

/**
 * Retrograde atrial activation continues into the sinus node and discharges it
 * (resets its cycle) — drawn only when the SN tier is shown.
 */
function snInvade(B, tA, o = {}) {
    const { P, T } = B;
    if (!T.hasSN) return;
    B.seg(['A', tA, 0], ['SN', tA + P.SACT, 0.5], { arrow: 'end', role: 'sn-retro', ...o });
}

/** Retrograde over the accessory pathway: one straight line labelled AP, ventricle → atrium (at the retrograde P onset). */
function apRetro(B, b, tA, { longRP = false } = {}) {
    const t = b.qrsOnMs + B.P.apVdelay;
    vExit(B, b, t, 'v-to-ap');
    B.seg(['V', t, 0], ['A', tA, 1], { label: 'AP', color: AP_COLOR, arrow: 'end', style: longRP ? 'wavy' : 'solid', beatId: b.id, role: 'ap' });
}

function rrStats(beats) {
    const B = beats.slice().sort(byQ);
    const rr = [];
    for (let i = 1; i < B.length; i++) rr.push(B[i].qrsOnMs - B[i - 1].qrsOnMs);
    return { rr, med: median(rr) };
}

// ─── mechanisms ─────────────────────────────────────────────────────────────

/**
 * Sinus / AV conduction. Covers normal conduction, 1st-degree, both types of
 * 2nd-degree and 2:1 WITHOUT separate rules: AH is a per-beat residual
 * (PR − PA − HV) measured from where the P and the QRS really are, so a
 * lengthening AH, a dropped P or a constant-AH drop all fall out of pairing.
 */
function buildAvNodal(B, input, { excludeWide = false, vt = false, atFocus = false } = {}) {
    const { P, T } = B;
    const beats = input.beats.slice().sort(byQ);
    // In VT the delineator's "P onsets" are one per QRS, found in the previous
    // T wave — noise. Only the P waves the user marks count (as in AF).
    const atrial = (vt ? input.atrial.filter(a => a.source === 'user') : input.atrial).slice().sort(byT);
    // In VT the wide beat is the dominant one, so the morphology classifier flags
    // the NARROW capture beat as different — width decides there, relative to the
    // run: a capture measured a little wide (T and P overlap) is still clearly
    // narrower than the VT beats around it.
    const wOf = (b) => b.qrsWidthMs ?? (b.qrsOffMs - b.qrsOnMs);
    const medW = median(beats.map(wOf)) ?? 0;
    const ectopic = vt ? (b) => b.origin !== 'fusion' && b.origin !== 'capture' && isWide(b, P) && !b.conduction && wOf(b) >= 0.85 * medW
                       : (b) => b.quality === 'pvc' || (excludeWide && isWide(b, P) && !b.conduction);

    const { pairs } = pairAtrialToBeats(beats.filter(b => !ectopic(b)), atrial, P);
    const beatOfA = new Map([...pairs].map(([bId, aId]) => [aId, bId]));
    const bById = new Map(beats.map(b => [b.id, b]));

    // Retrograde P of an ectopic beat: claim a marked P near qrsOn + ectopicVA.
    const retroOf = new Map();          // beatId → atrial (or {tMs} if derived)
    const claimedRetro = new Set();
    // A beat the reader has pointed at its own retrograde P: that P is the one it went back up to,
    // whatever the VA parameter would have found, and it is taken before any of them are guessed.
    for (const b of beats) {
        if (!b.retroAtrialId || pairs.has(b.id)) continue;
        const hit = atrial.find(a => a.id === b.retroAtrialId && !beatOfA.has(a.id));
        if (hit) { claimedRetro.add(hit.id); retroOf.set(b.id, hit); }
    }
    // A beat may carry its own retrograde VA: it is drawn with a retro P even when the ladder conceals
    // them, and concealed (its own value empty) even when the ladder draws them.
    for (const b of beats) {
        if (pairs.has(b.id) || retroOf.has(b.id)) continue;
        const va = b.params && 'ectopicVA' in b.params ? b.params.ectopicVA : P.ectopicVA;
        if (va == null) continue;
        const want = b.qrsOnMs + va;
        const hit = atrial.find(a => !beatOfA.has(a.id) && !claimedRetro.has(a.id) && Math.abs(a.tMs - want) <= DEDUP_MS);
        if (hit) { claimedRetro.add(hit.id); retroOf.set(b.id, hit); }
        else retroOf.set(b.id, { tMs: want });
    }

    // AH per conducted P, then the conduction pattern (which decides where a
    // blocked P is drawn: AV node, or His for a Mobitz II pattern).
    const ahOf = new Map();
    for (const [bId, aId] of pairs) {
        const a = atrial.find(x => x.id === aId);
        ahOf.set(aId, bById.get(bId).qrsOnMs - P.HV - (a.tMs + P.PA));
    }
    const AHs = [...ahOf.values()];
    const AHbase = AHs.length ? Math.min(...AHs) : 0;
    const ectopicOnsets = beats.filter(b => !pairs.has(b.id)).map(b => b.qrsOnMs);
    // A P so close to the end that its QRS would fall after the record is not
    // a blocked P — the strip just stops. Enter the node, leave the end open.
    const pairedPR = [...pairs].map(([bId, aId]) => bById.get(bId).qrsOnMs - atrial.find(x => x.id === aId).tMs);
    const reachMs = (pairedPR.length ? Math.max(...pairedPR) : 200) + 40;
    const lastQ = beats.length ? beats[beats.length - 1].qrsOnMs : -Infinity;
    const truncated = new Set(atrial.filter(a => !beatOfA.has(a.id) && !claimedRetro.has(a.id) &&
        a.tMs > lastQ && input.durationMs != null && input.durationMs - a.tMs < reachMs).map(a => a.id));
    // In VT a P before the first QRS belongs to a beat before the strip began (its
    // retrograde P, or a dissociated one): draw the atrial activation only.
    const firstQ = beats.length ? beats[0].qrsOnMs : Infinity;
    const leading = new Set(vt ? atrial.filter(a => !beatOfA.has(a.id) && !claimedRetro.has(a.id) && a.tMs < firstQ).map(a => a.id) : []);

    const pattern = classifyConduction(atrial, beatOfA, ahOf, new Set([...claimedRetro, ...truncated, ...leading]), ectopicOnsets);

    for (const a of atrial) {
        if (claimedRetro.has(a.id)) continue;   // drawn by its ectopic beat
        if (leading.has(a.id)) {
            B.ev('A', a.tMs, 1, { role: 'p-edge', atrialId: a.id, source: a.source || 'auto' });
            B.seg(['A', a.tMs, 1], ['A', a.tMs, 0], { atrialId: a.id, role: 'atrium-edge' });
            continue;
        }
        sinusEntry(B, a, { focus: atFocus });
        const tIn = a.tMs;                      // the atrial tier is instantaneous: the AV band starts at P onset (PH)
        if (truncated.has(a.id)) {
            B.seg([T.av, tIn, 0], [T.av, Math.min(input.durationMs, tIn + P.AHmin), 0.4], { terminal: 'open', atrialId: a.id, role: 'av-open' });
        } else if (beatOfA.has(a.id)) {
            const b = bById.get(beatOfA.get(a.id));
            const AH = ahOf.get(a.id);
            const J = junctionTimes(B, b.qrsOnMs, b.params);
            // Bow only inside a Wenckebach run: a curve says "decremental", and
            // beat-to-beat PR jitter in sinus rhythm is not that.
            const curve = pattern.wenckeRun.has(a.id) && AH - AHbase >= 20 ? r1((AH - AHbase) * 0.15) : 0;
            avConduct(B, tIn, J.tAvOut, { style: AH < P.AHmin ? 'dashed' : 'solid', curve, atrialId: a.id, beatId: b.id });
        } else if (a.blockedAt === 'AV') {
            avBlock(B, tIn, null, { atrialId: a.id });
        } else if (a.blockedAt && AHs.length) {
            // Below the node, where the reader says it stopped: cross with the AH of the conducted beats.
            infraHisBlock(B, a, tIn, tIn + P.PA + median(AHs));
        } else if (a.blockedAt) {
            avBlock(B, tIn, null, { atrialId: a.id });
        } else if (pattern.mobitz2.has(a.id)) {
            // Constant AH, then a drop: the block is infranodal. Cross the AV
            // node normally and die in the His–Purkinje tier (or at the very
            // bottom of the AV junction when His is not drawn).
            const tH = tIn + P.PA + pattern.mobitz2.get(a.id);
            if (T.hasHis) {
                avConduct(B, tIn, tH, { atrialId: a.id });
                B.link(tH, T.av, 1, 'His', 0, { atrialId: a.id });
                B.seg(['His', tH, 0], ['His', tH + P.HV * 0.5, 0.5], { terminal: 'block', atrialId: a.id, role: 'his-block' });
            } else {
                B.seg([T.av, tIn, 0], [T.av, tH, 0.95], { terminal: 'block', atrialId: a.id, role: 'av-block-low' });
            }
        } else if (P.blockBelowHis >= 0.5 && AHs.length) {
            // block placed below the His (2:1 or any drop the user attributes to the His–Purkinje system): the P
            // crosses the node with the AH of the conducted beats, the His is recorded, the ventricle is not reached
            infraHisBlock(B, a, tIn, tIn + P.PA + median(AHs));
        } else {
            avBlock(B, tIn, null, { atrialId: a.id });
        }
    }

    for (const b of beats) {
        if (pairs.has(b.id)) {
            hisAndV(B, b);
            if (b.origin === 'fusion') {
                // the ventricular focus fires while the conducted wavefront is already inside the ventricle:
                // its asterisk sits at the moment it fired (focusDelayMs after QRS onset, from the marks)
                const tF = b.qrsOnMs + (b.focusDelayMs ?? 0);
                B.ev('V', tF, 0.5, { style: 'asterisk', role: 'focus-ventricular', beatId: b.id });
                B.seg(['V', tF, 0.5], ['V', tF, 1], { beatId: b.id, role: 'ventricle-fusion' });
            }
            continue;
        }
        const retroTo = retroOf.has(b.id) ? retroOf.get(b.id).tMs : null;
        if (vt ? ectopic(b) : isEctopicLike(b, P)) ventricularFocus(B, b, retroTo);
        else junctionalFocus(B, b, retroTo);
    }

    B.L.intervals = measureIntervals(beats, atrial, pairs, P);
    for (const iv of B.L.intervals) {
        if (retroOf.has(iv.beatId)) iv.VAms = r1(Math.max(0, retroOf.get(iv.beatId).tMs - bById.get(iv.beatId).qrsOnMs));
    }

    if (vt) { vtNotes(B, beats, atrial, pairs, ectopic); return; }
    if (atFocus) {
        B.note('Atrial tachycardia: every atrial activation starts de novo at the focus (asterisk); no line returns from the ventricle to the atrium — a focus, not a circuit.');
    }

    // Notes — what the drawing is claiming, in words.
    const PRs = B.L.intervals.map(i => i.PRms).filter(x => x != null);
    if (PRs.length && Math.max(...PRs) > 200) B.note(`1st-degree AV delay: PR up to ${Math.round(Math.max(...PRs))} ms (AH absorbs the delay).`);
    const shortPR = B.L.intervals.filter(i => i.AHms != null && i.AHms < P.AHmin);
    if (shortPR.length) B.note(`${shortPR.length} beat(s) with PR shorter than PA + HV + AHmin (${P.PA + P.HV + P.AHmin} ms): pre-excitation or a junctional rhythm? AV segment drawn dashed.`, 'caution', 'pr-short');
    if (pattern.twoToOne) B.note('2:1 AV conduction — the level of block (nodal vs infranodal) cannot be told from the surface ECG; drawn at the AV node.', 'info', 'two-to-one-level');
    if (pattern.wenckebach) B.note(`Progressive AH prolongation before a blocked P (${pattern.wenckebach}×) — Wenckebach (Mobitz I), block drawn in the AV node.`);
    if (pattern.pac) B.note(`${pattern.pac} premature P without a QRS — non-conducted PAC (blocked in the AV node), not AV block.`);
    if (pattern.mobitz2.size) B.note(`Blocked P after a constant AH (${pattern.mobitz2.size}×) — Mobitz II pattern, block drawn ${T.hasHis ? 'below the His' : 'at the bottom of the AV junction'}.`);
    const nOther = pattern.blocked - pattern.explained;
    if (nOther > 0) B.note(`${nOther} P wave(s) without a QRS in the PR window — drawn as blocked in the AV node.`, 'caution', 'p-blocked');
    const unpaired = beats.filter(b => !pairs.has(b.id));
    const nJ = unpaired.filter(b => !isEctopicLike(b, P)).length;
    const nV = unpaired.length - nJ;
    if (nJ) B.note(`${nJ} narrow QRS without a conducting P — drawn as junctional (${T.hasHis ? 'His-tier' : 'AV-junction'} focus). Mark the P or change the mechanism if that is wrong.`, 'caution', 'unpaired-narrow');
    if (nV) B.note(`${nV} wide / ectopic QRS — drawn as ventricular focus${P.ectopicVA != null ? ` with retrograde VA ${P.ectopicVA} ms` : ' with concealed retrograde conduction'}.`);
}

/** VT: what the drawing claims — the ventricular rate, the dissociated atria, the captures. */
function vtNotes(B, beats, atrial, pairs, ectopic) {
    const wide = beats.filter(ectopic);
    const rr = [];
    for (let i = 1; i < beats.length; i++) if (ectopic(beats[i]) && ectopic(beats[i - 1])) rr.push(beats[i].qrsOnMs - beats[i - 1].qrsOnMs);
    const vr = median(rr);
    const pp = [];
    for (let i = 1; i < atrial.length; i++) pp.push(atrial[i].tMs - atrial[i - 1].tMs);
    const ar = median(pp);
    const captures = beats.filter(b => pairs.has(b.id) && !ectopic(b)).length;
    B.note(`Ventricular tachycardia: ${wide.length} wide beat(s)${vr ? ` at ${Math.round(60000 / vr)} /min` : ''}, each drawn from a ventricular focus with concealed retrograde conduction into the AV node.`);
    if (atrial.length >= 2) B.note(`AV dissociation: P waves at ${ar ? Math.round(60000 / ar) : '—'} /min march through independently; those that meet the refractory node are blocked there.`);
    else B.note('Automatic P markers are ignored in VT: mark the dissociated P waves (+ P onset, then “Repeat every … ms”) to draw the AV dissociation.', 'info', 'vt-auto-p-ignored');
    const narrowUnpaired = beats.filter(b => !ectopic(b) && !pairs.has(b.id)).length;
    if (narrowUnpaired) B.note(`${narrowUnpaired} narrower beat(s) without a conducting P — capture or fusion? Mark the P that captured it.`, 'caution', 'capture-or-fusion');
    const fusions = beats.filter(b => pairs.has(b.id) && b.origin === 'fusion').length;
    const caps = captures - fusions;
    if (caps > 0) B.note(`${caps} capture beat(s): a sinus P conducted to a narrow QRS — proof of AV dissociation.`);
    if (fusions) B.note(`${fusions} fusion beat(s): a conducted sinus wavefront and the ventricular one converge on the same QRS (intermediate morphology).`);
}

/**
 * Per blocked P: a premature P (blocked PAC), a Wenckebach cycle, a Mobitz II
 * drop, or part of 2:1?
 *  - Premature: the P–P before it is < 80 % of the median P–P. Checked first —
 *    a PAC in the T wave is the commonest blocked P and is none of the others.
 *  - Wenckebach: AH rises monotonically (±5 ms) over ≥ 2 conducted P, by
 *    ≥ 30 ms in total, and the next conducted AH is ≥ 20 ms shorter. Beat-to-
 *    beat PR jitter in sinus rhythm must not read as decremental conduction.
 *  - Mobitz II: constant AH (spread ≤ 15 ms) before, and after if there is one.
 * Blocked P within 500 ms of an ectopic QRS are left alone — concealed
 * retrograde conduction explains them.
 */
function classifyConduction(atrial, beatOfA, ahOf, claimedRetro, ectopicOnsets) {
    const seq = atrial.filter(a => !claimedRetro.has(a.id))
        .map(a => ({ a, cond: beatOfA.has(a.id), ah: ahOf.get(a.id) }));
    const mobitz2 = new Map();
    const wenckeRun = new Set();
    let wenckebach = 0, pac = 0, explained = 0;
    const blockedIdx = [];
    seq.forEach((s, i) => { if (!s.cond) blockedIdx.push(i); });
    const blocked = blockedIdx.length;
    const pp = [];
    for (let i = 1; i < seq.length; i++) pp.push(seq[i].a.tMs - seq[i - 1].a.tMs);
    const medPP = median(pp);
    const premature = (i) => i > 0 && medPP && (seq[i].a.tMs - seq[i - 1].a.tMs) < 0.8 * medPP;

    // 2:1: at least 2 blocked P, every one between two conducted P, regularly
    // spaced (C B C B C …) and none of them premature.
    const twoToOne = blockedIdx.length >= 2 && blockedIdx.every((i, k) =>
        i > 0 && seq[i - 1].cond && (i + 1 >= seq.length || seq[i + 1].cond) &&
        (k === 0 || i - blockedIdx[k - 1] === 2) && !premature(i));
    if (twoToOne) return { mobitz2, wenckeRun, wenckebach: 0, pac: 0, twoToOne: true, blocked, explained: blocked };

    for (const i of blockedIdx) {
        const t = seq[i].a.tMs;
        if (ectopicOnsets.some(q => t >= q - 50 && t - q <= 500)) { explained++; continue; }
        if (premature(i)) { pac++; explained++; continue; }
        const run = [], runIds = [];
        for (let j = i - 1; j >= 0 && seq[j].cond; j--) { run.unshift(seq[j].ah); runIds.unshift(seq[j].a.id); }
        if (run.length < 2) continue;
        const after = seq[i + 1]?.cond ? seq[i + 1].ah : null;
        // longest monotonic tail ending at the block
        let k = run.length - 1;
        while (k > 0 && run[k] - run[k - 1] >= -5) k--;
        const tail = run.slice(k), tailIds = runIds.slice(k);
        const rise = tail[tail.length - 1] - tail[0];
        if (tail.length >= 2 && rise >= 30 && (after == null || after <= tail[tail.length - 1] - 20)) {
            wenckebach++; explained++; tailIds.forEach(id => wenckeRun.add(id));
            continue;
        }
        const spread = Math.max(...run) - Math.min(...run);
        if (spread <= 15 && (after == null || Math.abs(after - median(run)) <= 15)) {
            mobitz2.set(seq[i].a.id, median(run));
            explained++;
        }
    }
    return { mobitz2, wenckeRun, wenckebach, pac, twoToOne: false, blocked, explained };
}

/** A P that crosses the node and the His (H recorded at tH) and dies just below it; without a His tier, low in the node. */
function infraHisBlock(B, a, tIn, tH) {
    const { T } = B;
    if (T.hasHis) {
        avConduct(B, tIn, tH, { atrialId: a.id });
        B.link(tH, T.av, 1, 'His', 0, { atrialId: a.id });
        B.seg(['His', tH, 0], ['His', tH + 15, 1], { atrialId: a.id, role: 'his' });
        B.seg(['V', tH + 15, 0], ['V', tH + 30, 0.18], { terminal: 'block', atrialId: a.id, role: 'his-block' });
    } else B.seg([T.av, tIn, 0], [T.av, tH, 0.95], { terminal: 'block', atrialId: a.id, role: 'av-block-low' });
}

/** Complete AV block: nothing pairs; every P blocks, every QRS is an escape. */
function buildAvb3(B, input) {
    const { P, T } = B;
    const beats = input.beats.slice().sort(byQ);
    const atrial = input.atrial.slice().sort(byT);
    const infra = P.blockBelowHis >= 0.5;
    for (const a of atrial) {
        sinusEntry(B, a);
        const tIn = a.tMs;
        if (!infra) { avBlock(B, tIn, null, { atrialId: a.id }); continue; }
        // infra-Hisian block: the node conducts, the wave dies below the His
        infraHisBlock(B, a, tIn, tIn + P.PA + 2 * P.AHmin);
    }
    let nJ = 0, nV = 0;
    for (const b of beats) {
        if (isEctopicLike(b, P)) { ventricularFocus(B, b, null, { retro: false }); nV++; }
        else { junctionalFocus(B, b, null, { retro: false }); nJ++; }
    }
    B.L.intervals = measureIntervals(beats, atrial, new Map(), P);
    const pp = [];
    for (let i = 1; i < atrial.length; i++) pp.push(atrial[i].tMs - atrial[i - 1].tMs);
    const { med: rr } = rrStats(beats);
    const aRate = median(pp), vRate = rr;
    B.note(`AV dissociation: atrial ${aRate ? Math.round(60000 / aRate) : '—'} /min, ventricular ${vRate ? Math.round(60000 / vRate) : '—'} /min; block drawn ${infra ? 'below the His' : 'in the AV node'}.`);
    if (nJ) B.note(`${nJ} narrow escape beat(s) drawn as junctional (${T.hasHis ? 'His-tier' : 'AV-junction'} focus).`);
    if (nV) B.note(`${nV} wide escape beat(s) drawn as ventricular focus.`);
    if (!atrial.length) B.note('No P waves marked — add them (Add P, then "Repeat every … ms") to show the dissociated atrial rhythm.', 'caution', 'no-p');
}

/** First beat of an SVT: where does the antegrade limb come from? */
function initiatingEntry(B, b0, atrial) {
    const { P } = B;
    const cand = atrial.filter(a => b0.qrsOnMs - a.tMs >= P.PRmin && b0.qrsOnMs - a.tMs <= P.PRmax)
        .sort(byT).pop();
    if (!cand) return null;
    B.ev('A', cand.tMs, 0, { role: 'p', atrialId: cand.id, source: cand.source || 'auto' });
    B.seg(['A', cand.tMs, 0], ['A', cand.tMs, 1], { atrialId: cand.id, role: 'atrium' });
    return cand.tMs;
}

/**
 * AVNRT: the circuit lives INSIDE the AV node — the atria and ventricles are
 * bystanders. Antegrade limb down to the lower turnaround (where the wave
 * leaves the node), retrograde limb back up, reaching the top of the node at
 * QRS onset + VA (= retrograde P onset). The longer limb is the slow pathway
 * (wavy): typical = slow antegrade / fast retrograde; a long VA flips it.
 * With the AV fast / AV slow tiers each limb lives in its own band.
 */
function buildAvnrt(B, input) {
    const { P, T } = B;
    const beats = input.beats.slice().sort(byQ);
    const VA = Math.max(P.VA, 10 - P.HV);
    if (!beats.length) return;
    const { med: rr } = rrStats(beats);
    const tops = beats.map(b => b.qrsOnMs + VA);              // retro P onsets
    const lows = beats.map(b => junctionTimes(B, b.qrsOnMs, b.params).tAvOut);
    const antegrade = beats.map((b, i) => lows[i] - (i > 0 ? tops[i - 1] : NaN));
    const medAnte = median(antegrade.filter(Number.isFinite)) ?? (rr ? rr - VA - P.HV : 250);

    let ntBad = 0;
    beats.forEach((b, i) => {
        const tLow = lows[i];
        let tStart, initiated = false;
        if (i > 0) tStart = tops[i - 1];
        else {
            const e = initiatingEntry(B, b, input.atrial);
            initiated = e != null;
            tStart = e ?? tLow - medAnte;
        }
        const dAnte = tLow - tStart, dRetro = tops[i] - tLow;
        if (dAnte <= 0) ntBad++;
        const slowAnte = dAnte >= dRetro;
        if (!T.dual) {
            B.seg(['AV', tStart, 0], ['AV', tLow, 1],
                  { style: slowAnte ? 'wavy' : 'solid', label: slowAnte ? 'slow' : 'fast', beatId: b.id, role: 'av' });
            hisAndV(B, b);
            B.seg(['AV', tLow, 1], ['AV', tops[i], 0],
                  { style: slowAnte ? 'solid' : 'wavy', label: slowAnte ? 'fast' : 'slow', arrow: 'end', beatId: b.id, role: 'av-retro' });
        } else if (slowAnte) {
            // typical: the fast pathway is refractory to the initiating PAC → down the slow one, up the fast one
            if (initiated) blockStub(B, 'AVf', tStart, { beatId: b.id, role: 'avf-block' });
            B.link(tStart, 'AVf', 0, 'AVs', 0, { beatId: b.id });
            B.seg(['AVs', tStart, 0], ['AVs', tLow, 1], { style: 'wavy', beatId: b.id, role: 'av' });
            hisAndV(B, b, { from: 'AVs' });
            B.link(tLow, 'AVs', 1, 'AVf', 1, { beatId: b.id });
            B.seg(['AVf', tLow, 1], ['AVf', tops[i], 0], { arrow: 'end', beatId: b.id, role: 'av-retro' });
        } else {
            // atypical: down the fast pathway, up the slow one
            B.seg(['AVf', tStart, 0], ['AVf', tLow, 1], { beatId: b.id, role: 'av' });
            hisAndV(B, b, { from: 'AVf' });
            B.seg(['AVs', tLow, 1], ['AVs', tops[i], 0], { style: 'wavy', arrow: 'end', beatId: b.id, role: 'av-retro' });
            B.link(tops[i], 'AVs', 0, 'A', 1, { beatId: b.id });
        }
        atrialRetro(B, tops[i], { beatId: b.id });
    });

    B.L.intervals = measureIntervals(beats, [], new Map(), P).map(iv => ({ ...iv, VAms: VA }));
    const atypical = rr && VA > rr / 2;
    if (atypical) B.note(`VA ${VA} ms > RR/2 (${Math.round(rr / 2)} ms): long RP — atypical (fast–slow) AVNRT; slow limb drawn retrograde.`);
    else if (VA <= 70) B.note(`VA ${VA} ms ≤ 70 ms: typical (slow–fast) AVNRT — retrograde P inside or just after the QRS.`);
    else B.note(`VA ${VA} ms: slow–slow or atypical AVNRT, or AVRT — consider the accessory-pathway mechanism.`, 'caution', 'va-ambiguous');
    if (ntBad) B.note(`${ntBad} beat(s) where VA leaves no time for antegrade conduction before the next QRS — VA too long for this cycle length.`, 'warning', 'va-too-long');
}

/**
 * Orthodromic AVRT: down the AV node and His, up an accessory pathway, from
 * the ventricular end (QRS onset + apVdelay) to the atrial end (QRS onset + VA).
 */
function buildAvrt(B, input, { pjrt = false } = {}) {
    const { P } = B;
    const beats = input.beats.slice().sort(byQ);
    if (!beats.length) return;
    const VA = P.VA;
    const { med: rr } = rrStats(beats);
    const tA = beats.map(b => b.qrsOnMs + Math.max(VA, P.apVdelay + 10));
    const lows = beats.map(b => junctionTimes(B, b.qrsOnMs, b.params).tAvOut);
    const ah = beats.map((b, i) => i > 0 ? lows[i] - (tA[i - 1] + P.apToAV) : NaN);
    const medAH = median(ah.filter(Number.isFinite)) ?? 150;
    const longRP = pjrt || (rr && VA > rr / 2);

    beats.forEach((b, i) => {
        const tLow = lows[i];
        // the atrial tier is instantaneous: the anterograde limb leaves the point where the pathway reached the
        // atrium (the conduction from the atrium to the node is part of the AV band, as in a sinus beat)
        const tIn = i > 0 ? tA[i - 1] : (initiatingEntry(B, b, input.atrial) ?? tLow - medAH);
        avConduct(B, tIn, tLow, { beatId: b.id });
        hisAndV(B, b);
        apRetro(B, b, tA[i], { longRP });
        atrialRetro(B, tA[i], { beatId: b.id });
    });
    B.L.intervals = measureIntervals(beats, [], new Map(), P).map(iv => ({ ...iv, VAms: VA }));
    const rpLong = rr && VA > rr / 2;
    if (VA < 70) B.note(`VA ${VA} ms < 70 ms: too short for orthodromic AVRT (the ventricle and the pathway must be activated first) — typical AVNRT is more likely.`, 'warning', 'va-too-short-for-ap');
    else if (pjrt) B.note(`PJRT, VA ${VA} ms: antegrade AV node → His → V, retrograde over a slowly conducting, decremental accessory pathway (drawn wavy).`);
    else B.note(`Orthodromic AVRT, VA ${VA} ms: antegrade AV node → His → V, retrograde over the accessory pathway (AP).`);
    if (pjrt && rr && !rpLong) B.note(`PJRT has a long RP; here VA ${VA} ms ≤ RR/2 (${Math.round(rr / 2)} ms).`, 'caution', 'pjrt-short-rp');
    if (!pjrt && rpLong) B.note(`Long RP (VA ${VA} ms > RR/2): a fast accessory pathway returns early — a long-RP orthodromic tachycardia is PJRT (choose that reading).`, 'warning', 'long-rp-not-avrt');
}

/** Atrial fibrillation: schematic f waves; one conducts per QRS, the rest are concealed. */
function buildAfib(B, input) {
    const { P } = B;
    const beats = input.beats.slice().sort(byQ);
    if (!beats.length) return;
    const rnd = lcg(1234);
    const tEnd = input.durationMs ?? (beats[beats.length - 1].qrsOffMs + 300);
    const t0 = Math.max(0, beats[0].qrsOnMs - 1000);
    const f = [];
    for (let t = t0 + rnd() * P.fibMeanMs; t < tEnd; t += P.fibMeanMs * (0.7 + 0.6 * rnd())) f.push(r1(t));

    const used = new Map();              // f index → beat
    let last = -1;
    for (const b of beats) {
        if (isEctopicLike(b, P)) continue;
        const J = junctionTimes(B, b.qrsOnMs, b.params);
        const latest = J.tAvOut - P.AHmin - P.PA;
        let k = -1;
        for (let i = f.length - 1; i > last; i--) if (f[i] <= latest) { k = i; break; }
        if (k < 0) continue;
        used.set(k, b); last = k;
    }
    const conducted = new Set([...used.values()].map(b => b.id));
    f.forEach((t, i) => {
        B.ev('A', t, 0, { style: 'none', role: 'f' });
        B.seg(['A', t, 0], ['A', t, 1], { role: 'atrium' });
        if (used.has(i)) {
            const b = used.get(i);
            avConduct(B, t, junctionTimes(B, b.qrsOnMs, b.params).tAvOut, { beatId: b.id });
        } else {
            B.seg([B.T.av, t, 0], [B.T.av, t + 30, 0.15 + 0.45 * rnd()],
                  { style: 'dashed', terminal: 'block', role: 'av-concealed' });
        }
    });
    for (const b of beats) {
        if (conducted.has(b.id)) hisAndV(B, b);
        else if (isEctopicLike(b, P)) ventricularFocus(B, b, null);
        else junctionalFocus(B, b, null);
    }
    B.L.intervals = measureIntervals(beats, [], new Map(), P);
    const { med } = rrStats(beats);
    B.note(`Atrial fibrillation: f waves are SCHEMATIC (fixed seed, mean f–f ${P.fibMeanMs} ms) — only the pattern "one conducts, the rest are concealed in the AV node" is meaningful. Ventricular response ${med ? Math.round(60000 / med) : '—'} /min (median RR).`);
}

/**
 * Atrial flutter: regular F waves. The cycle and phase come from the F-wave
 * onsets the user marked (fitFlutter, ≥ 2 marks) unless overridden in the
 * params; each QRS takes the latest F that can reach it through the node.
 */
function buildFlutter(B, input) {
    const { P } = B;
    const beats = input.beats.slice().sort(byQ);
    const atrial = input.atrial.slice().sort(byT);
    const marks = atrial.filter(a => a.source === 'user');
    let cyc, phase, fit = null;
    if (P.fWaveMs != null) {
        cyc = Math.max(120, P.fWaveMs);
        phase = P.fPhaseMs ?? (marks[0] || atrial[0])?.tMs ?? null;
    } else {
        fit = fitFlutter(marks);
        if (fit) { cyc = fit.cycleMs; phase = P.fPhaseMs ?? fit.phaseMs; }
    }
    B.L.flutter = { fit, marks: marks.length, cycleMs: cyc ?? null, phaseMs: phase ?? null };
    if (!cyc || phase == null) {
        for (const b of beats) (isEctopicLike(b, P) ? ventricularFocus(B, b, null, { retro: false }) : hisAndV(B, b));
        B.L.intervals = measureIntervals(beats, [], new Map(), P);
        B.note(`Atrial flutter: mark the onset of at least two F waves (${marks.length} marked) — the cycle and every other F wave are then computed.`, 'caution', 'flutter-marks');
        return;
    }
    const tEnd = input.durationMs ?? ((beats.length ? beats[beats.length - 1].qrsOffMs : phase) + 300);
    const tStart = Math.max(0, (beats.length ? beats[0].qrsOnMs : phase) - 1000);
    let t = phase;
    while (t - cyc >= tStart) t -= cyc;
    const F = [];
    for (let k = 0; t < tEnd; t += cyc, k++) F.push({ id: 'F' + k, tMs: r1(t), source: 'derived' });

    const { pairs } = pairAtrialToBeats(beats.filter(b => !isEctopicLike(b, P)), F, P,
        { minLeadMs: P.PA + P.HV + P.AHmin });
    const beatOfF = new Map([...pairs].map(([b, f]) => [f, b]));
    const bById = new Map(beats.map(b => [b.id, b]));
    for (const f of F) {
        B.ev('A', f.tMs, 0, { role: 'F', atrialId: f.id });
        B.seg(['A', f.tMs, 0], ['A', f.tMs, 1], { atrialId: f.id, role: 'atrium' });
        if (beatOfF.has(f.id)) {
            const b = bById.get(beatOfF.get(f.id));
            avConduct(B, f.tMs, junctionTimes(B, b.qrsOnMs, b.params).tAvOut, { atrialId: f.id, beatId: b.id });
        } else avBlock(B, f.tMs, 0.3, { atrialId: f.id });
    }
    for (const b of beats) {
        if (pairs.has(b.id)) hisAndV(B, b);
        else if (isEctopicLike(b, P)) ventricularFocus(B, b, null);
        else junctionalFocus(B, b, null);
    }
    B.L.intervals = measureIntervals(beats, F, pairs, P);
    const { med } = rrStats(beats);
    const ratio = med ? Math.round(med / cyc) : null;
    const FR = median(B.L.intervals.map(i => i.PRms).filter(x => x != null));
    const src = fit ? `fitted from ${fit.n} marked F waves (max residual ${Math.round(fit.residualMs)} ms)` : 'set in the parameters';
    B.note(`Atrial flutter: F–F ${Math.round(cyc)} ms (${Math.round(60000 / cyc)} /min), ${src}${ratio ? `, ~${ratio}:1 conduction` : ''}${FR ? `, FR ≈ ${Math.round(FR)} ms` : ''}.`);
    if (cyc < 160 || cyc > 350) B.note(`F–F ${Math.round(cyc)} ms is outside the usual flutter range (160–350 ms) — check the marks (consecutive F waves are safest).`, 'warning', 'ff-range');
    if (fit && fit.residualMs > 25) B.note(`Your F marks deviate up to ${Math.round(fit.residualMs)} ms from a regular cycle — move them onto the F onsets.`, 'caution', 'ff-residual');
}


/**
 * Junctional tachycardia: a focus in the AV node (asterisk on the nodal tier)
 * fires each cycle; one line descends to His and ventricle, another ascends
 * to the atrium (retrograde P at QRS onset + VA). Nothing enters the mark and
 * nothing returns to it — a focus, not a circuit.
 */
function buildJt(B, input) {
    const { P, T } = B;
    const beats = input.beats.slice().sort(byQ);
    for (const b of beats) {
        const J = junctionTimes(B, b.qrsOnMs, b.params);
        const tOut = J.tAvOut, tF = tOut - P.jtNodeMs;
        const tier = T.avLow;
        // NH region / lower third of the nodal tier (Fable review; Issa, Miller & Zipes)
        B.ev(tier, tF, 0.7, { style: 'asterisk', role: 'focus-junctional', beatId: b.id });
        B.seg([tier, tF, 0.7], [tier, tOut, 1], { beatId: b.id, role: 'junction' });
        hisAndV(B, b, { from: tier });
        const tA = Math.max(b.qrsOnMs + P.VA, tF + 15);
        if (T.dual) {
            B.link(tF, 'AVs', 0.7, 'AVf', 1, { beatId: b.id });
            B.seg(['AVf', tF, 1], ['AVf', tA, 0], { arrow: 'end', beatId: b.id, role: 'av-retro' });
        } else B.seg([tier, tF, 0.7], [tier, tA, 0], { arrow: 'end', beatId: b.id, role: 'av-retro' });
        atrialRetro(B, tA, { beatId: b.id });
    }
    B.L.intervals = measureIntervals(beats, [], new Map(), P).map(iv => ({ ...iv, VAms: P.VA }));
    B.note(`Junctional tachycardia: each cycle starts de novo at a focus in the AV node, conducting down to the ventricles and up to the atria (VA ${P.VA} ms). With 1:1 retrograde conduction the tracing is the same as a reentrant one — only the absence of closure differs.`);
}

/**
 * Antidromic AVRT: anterograde over the accessory pathway (labelled AP) into
 * the ventricle — pre-excited, wide QRS — and back
 * up the His-Purkinje system and AV node to the atrium (retrograde P at QRS + VA).
 */
function buildAvrtAnti(B, input) {
    const { P, T } = B;
    const beats = input.beats.slice().sort(byQ);
    if (!beats.length) return;
    const tA = beats.map(b => b.qrsOnMs + P.VA);
    beats.forEach((b, i) => {
        const q = b.qrsOnMs;
        // The atrial tier is instantaneous, so the pathway line leaves the atrium at the P onset that feeds it
        // (the retrograde P of the previous cycle) and reaches the delta wave: its extent is the P-to-delta
        // interval, i.e. atrial conduction to the pathway's insertion plus pathway conduction, which the
        // surface ECG cannot separate.
        let tAP;
        if (i > 0) tAP = tA[i - 1];
        else { const e = initiatingEntry(B, b, input.atrial); tAP = e ?? q - P.apAnteMs; }
        B.seg(['A', tAP, 1], ['V', q, 0], { label: 'AP', color: AP_COLOR, beatId: b.id, role: 'ap-ante' });
        vTier(B, b);
        const tH = q + P.vhMs;
        let tAV = tH;
        if (T.hasHis) {
            // the slow part of the circuit, drawn: ventricular activation reaches the His–Purkinje system
            // retrogradely and climbs to the His at QRS onset + vhMs — it leaves the V line from mid-band,
            // like the retrograde exit of a ventricular focus
            B.seg(['V', q, 0.5], ['V', tH, 0], { arrow: 'end', beatId: b.id, role: 'v-to-his', label: 'retrograde\nHis–Purkinje', labelAnchor: 'start-below-right' });
            B.link(tH, 'V', 0, 'His', 1, { beatId: b.id });
            tAV = tH + 15;
            B.seg(['His', tH, 1], ['His', tAV, 0], { arrow: 'end', beatId: b.id, role: 'his-retro' });
        } else B.link(tH, 'V', 0, T.avLow, 1, { beatId: b.id });
        if (tA[i] <= tAV + 10) B.note(`VA ${P.VA} ms leaves no time for retrograde conduction through the His and the node.`, 'warning', 'va-no-retro-time');
        avRetro(B, tAV, Math.max(tA[i], tAV + 10), { beatId: b.id });
        atrialRetro(B, tA[i], { beatId: b.id });
    });
    B.L.intervals = measureIntervals(beats, [], new Map(), P).map(iv => ({ ...iv, VAms: P.VA }));
    B.note(`Antidromic AVRT: anterograde over the accessory pathway (maximally pre-excited, wide QRS), retrograde over the His-Purkinje system and AV node (VA ${P.VA} ms). The same circuit as orthodromic AVRT, run the other way.`);
    const { med: rrA } = rrStats(beats);
    if (rrA && rrA - P.VA > 150) B.note(`P-to-delta ${Math.round(rrA - P.VA)} ms: long for a Kent pathway (60–110 ms); an atriofascicular (decremental) pathway fits better.`, 'caution', 'p-delta-long');
}

/**
 * Pseudo AV block by concealed His extrasystoles (Rosen 1970): a premature His
 * depolarization H′, invisible on the surface ECG, penetrates the node
 * retrogradely and the ventricles anterogradely without reaching either, and
 * the next sinus P meets a refractory node. P waves without H′ before them
 * conduct normally (fixed PR).
 */
function buildHisExtra(B, input) {
    const { P, T } = B;
    const beats = input.beats.slice().sort(byQ);
    const atrial = input.atrial.slice().sort(byT);
    const { pairs } = pairAtrialToBeats(beats, atrial, P);
    const beatOfA = new Map([...pairs].map(([bId, aId]) => [aId, bId]));
    const bById = new Map(beats.map(b => [b.id, b]));
    let nH = 0;
    for (const a of atrial) {
        sinusEntry(B, a);
        const tIn = a.tMs;
        if (beatOfA.has(a.id)) {
            const b = bById.get(beatOfA.get(a.id));
            avConduct(B, tIn, junctionTimes(B, b.qrsOnMs, b.params).tAvOut, { atrialId: a.id, beatId: b.id });
            continue;
        }
        const tH = tIn + P.PA - P.hPrimeLead;       // H′ fires hPrimeLead before the P reaches the node
        nH++;
        if (T.hasHis) {
            B.ev('His', tH, 0.5, { style: 'asterisk', role: 'focus-his', atrialId: a.id });
            B.seg(['His', tH, 0.5], ['His', tH + 6, 0], { atrialId: a.id, role: 'hprime-retro' });
            B.seg([T.avLow, tH + 6, 1], [T.avLow, tH + 50, 0.4], { terminal: 'block', atrialId: a.id, role: 'hprime-retro' });
            B.seg(['His', tH, 0.5], ['His', tH + 12, 0.95], { terminal: 'block', atrialId: a.id, role: 'hprime-ante' });
        } else {
            B.ev(T.avLow, tH, 0.9, { style: 'asterisk', role: 'focus-his', atrialId: a.id });
            B.seg([T.avLow, tH, 0.9], [T.avLow, tH + 50, 0.4], { terminal: 'block', atrialId: a.id, role: 'hprime-retro' });
        }
        avBlock(B, tIn, 0.5, { atrialId: a.id });
    }
    for (const b of beats) {
        if (pairs.has(b.id)) hisAndV(B, b);
        else if (isEctopicLike(b, P)) ventricularFocus(B, b, null, { retro: false });
        else junctionalFocus(B, b, null, { retro: false });
    }
    B.L.intervals = measureIntervals(beats, atrial, pairs, P);
    B.note(`Concealed His extrasystoles: ${nH} premature His depolarization(s) H′ — recorded nowhere on the surface ECG — leave the junction refractory, so the next P is blocked; the other P waves conduct with a fixed PR. Pseudo AV block, not infranodal disease.`);
    if (!T.hasHis) B.note('Add the His tier to draw H′ where it arises.', 'caution', 'tier-missing');
}

// ─── pacing ─────────────────────────────────────────────────────────────────

/** A mark the reader says the device made (the stimulus artefact before it). */
export const isPacedMark = (m) => !!m && m.origin === 'paced';
/** How far before a paced QRS a P is looked for as the one the device tracked. */
const AVI_WINDOW_MS = 350;

/**
 * A pacemaker stimulus: its own glyph (a spike), never the focus asterisk — a paced chamber is not a focus
 * the heart made, and a figure has to tell the two apart (PREMISES §9).
 */
function stimulus(B, tier, t, frac, o = {}) {
    return B.ev(tier, t, frac, { style: 'stim', role: tier === 'A' ? 'stim-atrial' : 'stim-ventricular', ...o });
}

/**
 * Paced rhythm. What is paced is declared on the marks (origin: 'paced'); the mode is read from them:
 *   AAI  paced atria, the ventricles conducted;
 *   VVI  paced ventricles, the atria on their own (conducted, blocked or dissociated);
 *   DDD  paced atria and ventricles, or sensed P waves the ventricle follows at a constant AV delay (VAT).
 * A P the paced ventricle follows is not blocked: it enters the node and meets a ventricle already
 * activated — drawn as a dashed, preempted stub. The device's timing (AV delay, PVARP, VRP) is shaded by
 * periods.js; the lower rate interval is stated.
 */
function buildPaced(B, input) {
    const { P, T } = B;
    const beats = input.beats.slice().sort(byQ);
    const atrial = input.atrial.slice().sort(byT);
    const native = beats.filter(b => !isPacedMark(b)), vPaced = beats.filter(isPacedMark);
    const aPacedN = atrial.filter(isPacedMark).length;
    const { pairs } = pairAtrialToBeats(native, atrial, P);
    const beatOfA = new Map([...pairs].map(([bId, aId]) => [aId, bId]));
    const bById = new Map(beats.map(b => [b.id, b]));

    // The P each paced QRS follows, if the device is tracking: the last free P in the window before it, and
    // only when those delays agree — a P that merely happens to precede a VVI beat is not tracked.
    const window = P.AVI != null ? P.AVI + 60 : AVI_WINDOW_MS;
    let trackOf = new Map();                                   // atrialId → paced beat
    for (const b of vPaced) {
        const a = atrial.filter(x => !beatOfA.has(x.id) && !trackOf.has(x.id) && x.tMs <= b.qrsOnMs - 40 && x.tMs >= b.qrsOnMs - window).pop();
        if (a) trackOf.set(a.id, b);
    }
    const avis = [...trackOf].map(([aId, b]) => b.qrsOnMs - atrial.find(x => x.id === aId).tMs);
    const aviSpread = avis.length ? Math.max(...avis) - Math.min(...avis) : 0;
    const tracking = avis.length >= 2 ? aviSpread <= 50 : avis.length === 1 && (vPaced.length === 1 || aPacedN > 0);
    if (!tracking) trackOf = new Map();
    const mode = aPacedN && (vPaced.length || tracking) ? 'DDD' : aPacedN ? 'AAI' : vPaced.length && tracking ? 'DDD' : vPaced.length ? 'VVI' : null;

    for (const a of atrial) {
        if (isPacedMark(a)) {
            stimulus(B, 'A', a.tMs, 0, { atrialId: a.id, source: a.source || 'auto' });
            B.seg(['A', a.tMs, 0], ['A', a.tMs, 1], { atrialId: a.id, role: 'atrium' });
        } else sinusEntry(B, a);
        const tIn = a.tMs;
        if (beatOfA.has(a.id)) {
            const b = bById.get(beatOfA.get(a.id));
            avConduct(B, tIn, junctionTimes(B, b.qrsOnMs, b.params).tAvOut, { atrialId: a.id, beatId: b.id });
        } else if (a.blockedAt === 'His') {
            infraHisBlock(B, a, tIn, tIn + P.PA + 2 * P.AHmin);   // where the reader says it stopped
        } else if (a.blockedAt === 'AV') {
            avBlock(B, tIn, null, { atrialId: a.id });
        } else if (trackOf.has(a.id)) {
            // preempted: the paced ventricle got there first
            B.seg([T.av, tIn, 0], [T.av, tIn + P.AHmin, P.blockDepth], { style: 'dashed', terminal: 'block', atrialId: a.id, beatId: trackOf.get(a.id).id, role: 'av-preempted' });
        } else avBlock(B, tIn, null, { atrialId: a.id });
    }
    for (const b of beats) {
        if (isPacedMark(b)) {
            // the whole ventricle, from the lead: up and down from the stimulus, no retrograde conduction claimed
            stimulus(B, 'V', b.qrsOnMs, 0.5, { beatId: b.id, source: b.source || 'auto' });
            B.seg(['V', b.qrsOnMs, 0.5], ['V', b.qrsOnMs, 1], { beatId: b.id, role: 'ventricle-paced' });
            B.seg(['V', b.qrsOnMs, 0.5], ['V', b.qrsOnMs, 0], { beatId: b.id, role: 'ventricle-paced' });
        } else if (pairs.has(b.id)) hisAndV(B, b);
        else if (isEctopicLike(b, P)) ventricularFocus(B, b, null, { retro: false });
        else junctionalFocus(B, b, null, { retro: false });
    }
    B.L.intervals = measureIntervals(native, atrial, pairs, P);

    // The device's timing, as far as the marks show it.
    const vEvents = beats.map(b => b.qrsOnMs);
    const cyclesOf = (list) => { const d = []; for (let i = 1; i < list.length; i++) if (isPacedMark(list[i]) && isPacedMark(list[i - 1])) d.push((list[i].tMs ?? list[i].qrsOnMs) - (list[i - 1].tMs ?? list[i - 1].qrsOnMs)); return d; };
    // the paced-to-paced cycle is the lower rate only where the device is escaping: under atrial tracking the
    // ventricle follows the sinus rate
    const rateChamber = aPacedN ? atrial : beats;
    const lriMeasured = mode === 'DDD' && !aPacedN ? null : median(cyclesOf(rateChamber));
    const lri = P.LRI ?? lriMeasured;
    const avi = P.AVI ?? (avis.length && tracking ? median(avis) : null);
    B.L.pacing = { mode, lriMs: lri != null ? r1(lri) : null, aviMs: avi != null ? r1(avi) : null, pvarpMs: P.PVARP, vrpMs: P.VRP,
                   tracked: [...trackOf].map(([aId, b]) => ({ atrialId: aId, beatId: b.id })) };

    if (!mode) {
        B.note('No mark is flagged as paced: open the card of a paced P or QRS (the one after the stimulus) and flag it as paced.', 'caution', 'paced-none');
        return;
    }
    const what = { AAI: 'atrial pacing, the ventricles conducted', VVI: 'ventricular pacing, the atria on their own', DDD: aPacedN ? 'dual-chamber pacing' : 'the ventricle paced after each sensed P (atrial tracking)' }[mode];
    B.note(`Pacemaker read from the marks: ${mode} — ${what}.${lri != null ? ` Lower rate interval ${Math.round(lri)} ms (${Math.round(60000 / lri)} /min)${P.LRI == null ? ', from the paced cycles' : ''}.` : ''}`
        + `${avi != null && mode === 'DDD' ? ` AV delay ${Math.round(avi)} ms.` : ''}`
        + `${mode === 'DDD' ? ` PVARP ${P.PVARP} ms and VRP ${P.VRP} ms are assumed.` : mode === 'VVI' ? ` VRP ${P.VRP} ms is assumed.` : ''}`, 'info', 'paced-mode');
    if (P.LRI != null && lriMeasured != null && Math.abs(lriMeasured - P.LRI) > 40) {
        B.note(`The paced cycles on the strip (${Math.round(lriMeasured)} ms) differ from the lower rate interval set (${P.LRI} ms) by more than 40 ms: rate hysteresis, rate response, or a different programmed rate?`, 'caution', 'paced-lri');
    }
    // a paced QRS the device should not have delivered
    for (let i = 1; i < beats.length; i++) {
        const b = beats[i], dt = b.qrsOnMs - vEvents[i - 1];
        if (!isPacedMark(b)) continue;
        if (dt < P.VRP) B.note(`A paced QRS ${Math.round(dt)} ms after the previous QRS, inside the ventricular refractory period: failure to sense, or a mark on the wrong beat?`, 'caution', 'paced-inside-vrp');
        else if (!isPacedMark(beats[i - 1]) && lri != null && mode === 'VVI' && dt < lri - 40) B.note(`A paced QRS ${Math.round(dt)} ms after a sensed QRS, sooner than the lower rate interval (${Math.round(lri)} ms): undersensing?`, 'caution', 'paced-undersense');
    }
    // sensed P waves the device ignored because they fell in PVARP
    if (mode === 'DDD') {
        const ignored = atrial.filter(a => !isPacedMark(a) && !trackOf.has(a.id) && !beatOfA.has(a.id)
            && vEvents.some(q => a.tMs > q && a.tMs - q < P.PVARP));
        if (ignored.length) B.note(`${ignored.length} sensed P wave(s) inside PVARP (${P.PVARP} ms after a QRS): not tracked by the device.`, 'info', 'paced-pvarp');
    }
}

const RULES = {
    avnodal: (B, input) => buildAvNodal(B, input),
    pvc: (B, input) => buildAvNodal(B, input, { excludeWide: true }),
    vt: (B, input) => buildAvNodal(B, input, { excludeWide: true, vt: true }),
    at: (B, input) => buildAvNodal(B, input, { atFocus: true }),
    jt: buildJt,
    avrtAnti: buildAvrtAnti,
    hisExtra: buildHisExtra,
    avb3: buildAvb3,
    avnrt: buildAvnrt,
    avrt: (B, input) => buildAvrt(B, input),
    pjrt: (B, input) => buildAvrt(B, input, { pjrt: true }),
    afib: buildAfib,
    flutter: buildFlutter,
    paced: buildPaced,
};

/** Notes about per-beat bundle-branch conduction, for every mechanism. */
function conductionNotes(B, beats) {
    const { T, P } = B;
    const marked = beats.filter(b => b.conduction);
    const ventricular = new Set(B.L.events.filter(e => e.role === 'focus-ventricular').map(e => e.beatId));
    const supra = beats.filter(b => !ventricular.has(b.id));
    if (marked.length) {
        const kinds = [...new Set(marked.map(b => b.conduction))].join(', ');
        if (!T.hasBB) B.note(`${marked.length} beat(s) marked ${kinds} — add the bundle-branch tiers to draw the block.`, 'caution', 'tier-missing');
        else if (!T.hasFasc && marked.some(b => /LAFB|LPFB/.test(b.conduction))) B.note('Fascicular block marked but the fascicle tiers are hidden — add them to draw it.', 'caution', 'tier-missing');
        if (marked.length < supra.length) B.note(`Aberrant conduction on ${marked.length} of ${supra.length} supraventricular beat(s) (${kinds}).`);
        else B.note(`Bundle-branch conduction on every supraventricular beat: ${kinds}.`);
    }
    if (T.hasBB) {
        const wideUnmarked = supra.filter(b => isWide(b, P) && !b.conduction);
        if (wideUnmarked.length) B.note(`${wideUnmarked.length} wide QRS without a marked bundle-branch block — select the QRS and set its conduction.`, 'caution', 'wide-unmarked');
    }
}

/**
 * Build the ladder.
 * @param {{beats:object[], atrial:object[], mechanism:string, params?:object, tiers?:string[], durationMs?:number}} input
 */
export function buildLadder(input) {
    const mechanism = RULES[input.mechanism] ? input.mechanism : 'avnodal';
    const P = resolveParams(input.params);
    const T = tierContext(normalizeTiers(input.tiers));
    const B = makeBuilder(mechanism, P, T);
    const beats = input.beats || [];
    RULES[mechanism](B, { beats, atrial: input.atrial || [], durationMs: input.durationMs });
    if (input.mechanism && !RULES[input.mechanism]) {
        // a reading from a newer engine: say so, rather than pass sinus rhythm off as that reading
        B.L.unknownMechanism = String(input.mechanism);
        B.note(`This engine (${ENGINE_VERSION}) does not know the reading "${input.mechanism}": it is drawn as sinus / AV conduction. `
            + 'Open it in an up-to-date version.', 'caution', 'unknown-mechanism');
    }
    conductionNotes(B, beats);
    assignKeys(B.L);
    B.L.engine = { name: ENGINE_NAME, version: ENGINE_VERSION };
    return B.L;
}

/**
 * Stable keys: the same role on the same beat / P in the same tier position gets the same key on every
 * rebuild (ids are positional and are not). An editor keys its overrides (hide, recolour) on them.
 */
export function assignKeys(L) {
    const seen = new Map();
    const k = (base) => { const n = seen.get(base) || 0; seen.set(base, n + 1); return n ? `${base}#${n}` : base; };
    for (const p of L.paths) p.key = k(`p|${p.role}|${p.beatId ?? ''}|${p.atrialId ?? ''}|${p.from.tier}${p.from.frac}-${p.to.tier}${p.to.frac}`);
    for (const e of L.events) e.key = k(`e|${e.role}|${e.beatId ?? ''}|${e.atrialId ?? ''}|${e.tier}${e.frac}`);
    return L;
}

// ─── helpers for the page ───────────────────────────────────────────────────

/**
 * Rough mechanism guess to pre-select the dropdown. Deliberately simple and
 * honest about it: the delineator finds "a P" before almost every QRS (often
 * in the previous T wave), so P detection cannot separate a tachycardia's
 * mechanism — rate, width and regularity do most of the work here.
 */
export function suggestMechanism(beats, atrial, rhythm = {}) {
    if (rhythm.afib) return { id: 'afib', reason: 'irregularly irregular RR without organised P — detected automatically' };
    const { rr, med } = rrStats(beats);
    const cv = rr.length > 2 && med ? Math.sqrt(rr.reduce((s, x) => s + (x - med) ** 2, 0) / (rr.length - 1)) / med : 1;
    const wideShare = beats.length ? beats.filter(b => isWide(b, DEFAULT_PARAMS) && !b.conduction).length / beats.length : 0;
    if (med && med < 600 && wideShare >= 0.6) return { id: 'vt', reason: 'wide-QRS tachycardia — VT until proven otherwise (change it if every QRS has its own P)' };
    if (med && med < 430 && cv < 0.08) return { id: 'avnrt', reason: 'regular narrow tachycardia > 140 /min — AVNRT or AVRT: mark a retrograde P or type the VA' };
    if (beats.some(b => b.quality === 'pvc')) return { id: 'pvc', reason: 'ectopic (PVC) beats detected' };
    const { pairs, unpairedA } = pairAtrialToBeats(beats, atrial, DEFAULT_PARAMS);
    const aT = new Map(atrial.map(a => [a.id, a.tMs]));
    const prs = beats.filter(b => pairs.has(b.id)).map(b => b.qrsOnMs - aT.get(pairs.get(b.id)));
    const mPR = median(prs) ?? 0;
    const sdPR = prs.length > 2 ? Math.sqrt(prs.reduce((s, x) => s + (x - mPR) ** 2, 0) / (prs.length - 1)) : 0;
    if (med && med > 1000 && cv < 0.1 && sdPR > 60) return { id: 'avb3', reason: 'slow regular QRS with a wandering PR — complete AV block? Mark the P waves (Repeat every … ms)' };
    if (atrial.length >= 4 && unpairedA.length >= atrial.length * 0.4) return { id: 'avnodal', reason: 'many P waves without a QRS — AV block (try 3rd-degree if PR varies at random)' };
    return { id: 'avnodal', reason: 'P before each QRS' };
}

/**
 * VA suggested by P waves the user marked AFTER a QRS: median of
 * (P onset − onset of the preceding QRS), for P within the first 60 % of the cycle.
 */
export function suggestVA(beats, atrial) {
    const B = beats.slice().sort(byQ);
    const vas = [];
    for (const a of atrial) {
        let k = -1;
        for (let i = 0; i < B.length; i++) if (B[i].qrsOnMs <= a.tMs + 20) k = i;
        if (k < 0) continue;
        const next = B[k + 1];
        const cycle = next ? next.qrsOnMs - B[k].qrsOnMs : null;
        const va = a.tMs - B[k].qrsOnMs;
        if (va >= -20 && (!cycle || va <= 0.7 * cycle)) vas.push(va);   // long-RP P waves reach ~70 % of the cycle
    }
    return vas.length ? { VA: Math.round(median(vas)), n: vas.length } : null;
}

function withEvent(list, tMs, idPrefix) {
    if (list.some(a => Math.abs(a.tMs - tMs) < DEDUP_MS)) return false;
    let id = `${idPrefix}${Math.round(tMs)}`;
    while (list.some(a => a.id === id)) id += '_';
    list.push({ id, tMs: r1(tMs), source: 'user' });
    return true;
}

/**
 * "Repeat on following beats": take the anchor P's offset to its nearest QRS
 * onset and add a P at the same offset on every later beat of the same kind
 * (ectopic vs not). Covers a retrograde P after each QRS, or a P the
 * delineator missed on every beat. Never duplicates within 40 ms.
 */
export function repeatRelative(atrial, beats, anchor, { durationMs = Infinity } = {}) {
    const B = beats.slice().sort(byQ);
    if (!B.length) return atrial.slice();
    const ref = B.reduce((best, b) => Math.abs(b.qrsOnMs - anchor.tMs) < Math.abs(best.qrsOnMs - anchor.tMs) ? b : best);
    const offset = anchor.tMs - ref.qrsOnMs;
    const kind = (b) => b.quality === 'pvc';
    const out = atrial.slice();
    for (const b of B) {
        if (b.qrsOnMs <= ref.qrsOnMs || kind(b) !== kind(ref)) continue;
        const t = b.qrsOnMs + offset;
        if (t < 0 || t > durationMs) continue;
        withEvent(out, t, 'u');
    }
    return out.sort(byT);
}

/** "Repeat every N ms": P at anchor + k·cycle (forward; backward too if asked). */
export function repeatAtInterval(atrial, anchor, cycleMs, untilMs, { backward = false } = {}) {
    const out = atrial.slice();
    if (!(cycleMs >= 100)) return out.sort(byT);
    for (let t = anchor.tMs + cycleMs; t <= untilMs; t += cycleMs) withEvent(out, t, 'u');
    if (backward) for (let t = anchor.tMs - cycleMs; t >= 0; t -= cycleMs) withEvent(out, t, 'u');
    return out.sort(byT);
}

/**
 * ⌘/Ctrl-drag: which markers move together with the grabbed one — every P
 * onset, or every QRS onset of the same class (normal vs ectopic).
 */
export function sameKindIds(kind, id, beats, atrial) {
    if (kind === 'atrial') return atrial.map(a => a.id);
    const ref = beats.find(b => b.id === id);
    if (!ref) return [];
    const cls = (b) => b.quality === 'pvc';
    return beats.filter(b => cls(b) === cls(ref)).map(b => b.id);
}

// ─── builder primitives ─────────────────────────────────────────────────────

/**
 * The pieces the mechanism rules above are built from, for a consumer that authors its own paths
 * instead of choosing a mechanism — the Lewis Ladder editor's "By hand" mode, where the user draws
 * the conduction link by link.
 *
 * They are exported rather than copied so that a hand-drawn ladder and an engine-drawn one obey the
 * same premises (PREMISES.md) and land on the same pixels: a chamber is instantaneous at its onset,
 * the AV band runs from P onset to the His, the pathway crosses the AV line without a dot. A copy in
 * the consumer would drift from this file the first time a premise changed, and the drift would show
 * up as two panels of one figure disagreeing.
 *
 * This is public API: changing a signature here is a breaking change for that consumer.
 *
 * Typical use — one beat conducted from a P through the node:
 *
 *     const T = builders.tierContext(normalizeTiers(['A', 'AV', 'His', 'V']));
 *     const B = builders.makeBuilder('hand', resolveParams({}), T);
 *     builders.sinusEntry(B, atrialMark, { sn: false });
 *     builders.avConduct(B, atrialMark.tMs, builders.junctionTimes(B, beat.qrsOnMs).tAvOut,
 *                        { atrialId: atrialMark.id, beatId: beat.id });
 *     builders.hisAndV(B, beat);
 *     const ladder = B.L;      // { tiers, mechanism, params, events, paths, intervals, notes, claims }
 */
export const builders = Object.freeze({
    // context and the builder itself
    tierContext, makeBuilder, junctionTimes,
    // atrium
    sinusEntry, atrialRetro, snInvade,
    // AV node
    avConduct, avBlock, avRetro, avConcealed,
    // below the node
    hisAndV, branches, blockStub, vTier, vExit,
    // foci and pathways
    junctionalFocus, ventricularFocus, apRetro,
});
