// What the marks say about the rhythm, before any ladder is drawn:
//   measureRhythm     — RR, QRS width, the A:V relation, RP / PR (from P and QRS onsets only)
//   plausibility      — which readings the marks rule out, which are unlikely, and why
//   suggestReading    — a first reading that is never one the marks exclude
//   plausibleParams   — per-mechanism timings: measured from the marks when they can be, typical otherwise
//   continueRhythm    — extend a pattern of 2–3 marked beats (and their P waves) to the end of the strip
//   rankReadings      — every named reading (a mechanism and its subtype: Mobitz I, 2:1, SA block, AIVR, DDD…)
//                       ranked by what the marks show and, when a caller has one, what a rhythm detector found
// Pure functions; the thresholds are the textbook ones (Josephson; Issa, Miller & Zipes).
import { DEFAULT_PARAMS, MECHANISMS, PR_FLOOR_MS, PLAUSIBILITY_VERSION, pairAtrialToBeats, buildLadder, sinoatrialPattern, readPacing, fitFlutter } from './engine.js';

/**
 * The plausibility rules as a versioned component (the engine version moves with every drawing change; these
 * move only when what the rules rule out, or how readings are ranked, changes).
 *   P1  1.26  timing-only rules on the marks: measureRhythm, plausibility (ok / caution / excluded), suggestReading
 *   P2  1.27  named readings (READINGS: AV block subtypes, SA exit block, flutter ratio, junctional escape, AIVR,
 *             ventricular escape, NSVT, AAI / VVI / DDD) ranked by rankReadings from the marks' conduction pattern
 *             (the engine's own Wenckebach / Mobitz II / 2:1 classification, high-grade runs, SA pauses, the F–F
 *             ratio, the device's mode) and, optionally, a rhythm detector's evidence (the reading it called, its
 *             alternatives and secondary findings, flutter / fibrillatory waves, the pacing mode, the stretches of
 *             a strip with more than one rhythm). Evidence never excludes: only the marks rule a reading out.
 *             Without evidence, plausibility's verdicts are exactly P1's.
 *   P3  1.28  the RP rule reads a SURFACE RP (audit of 16/10/2026, see the cut-offs below): orthodromic AVRT is
 *             excluded only under 50 ms (the shortest VA recorded in AVRT), a caution from 50 to 90 ms; typical
 *             AVNRT is favoured up to 90 ms (was: AVRT excluded at ≤ 70 and favoured above 70).
 */
export { PLAUSIBILITY_VERSION };   // defined beside ENGINE_VERSION (engine.js), so every ladder is stamped with both

// The RP / VA cut-offs (P3, audit of 16/10/2026). 70 ms is an INTRACARDIAC number: QRS onset → earliest or septal
// atrial electrogram (Benditt 1979, V-Amin ≤ 61 ms never with a pathway; Knight 2000, septal VA < 70 ms; ESC 2019:
// "in the electrophysiology laboratory, the cut-off of the ventriculoatrial interval is 70 ms"). The marks give the
// SURFACE RP (QRS onset → P onset), which runs later than the septal A; its cut-off is 90 ms (ESC 2019, after
// Letsas 2010; Shi 2025, RP ≤ 90 ms in V1: sensitivity 97 %, specificity 97 % for typical AVNRT). Neither number
// excludes orthodromic AVRT: VA < 70 ms in 13 % of 495 children with AVRT, the shortest 50 ms (Ceresnak 2015), and in
// 8 of 46 adults with a left-sided pathway (Nagashima 2016). Only an RP below the shortest VA ever recorded in AVRT
// rules it out; between that and 90 ms typical AVNRT is favoured and AVRT is unlikely, not excluded.
export const VA_AP_MIN_MS = 70;      // intracardiac VA cut-off (kept as the rpClass boundary 'veryShort')
export const VA_AVRT_FLOOR_MS = 50;  // shortest VA recorded in orthodromic AVRT (Ceresnak 2015): below it, AVRT is excluded
export const RP_AVNRT_SURFACE_MS = 90; // surface RP cut-off: ≤ 90 ms favours typical AVNRT (ESC 2019; Shi 2025)
const RP_CAVEAT = 'surface RP, not the intracardiac VA; the ECG misreads the SVT type in about 1 in 5 (Kalbfleisch 1993) — the EP study decides';
export const WIDE_QRS_MS = 120;
export const TACHY_RR_MS = 600;      // 100 /min

const byQ = (a, b) => a.qrsOnMs - b.qrsOnMs;
const byT = (a, b) => a.tMs - b.tMs;
const round = (x) => (x == null ? null : Math.round(x));
function median(a) {
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function cv(a) {
    if (a.length < 2) return 0;
    const m = a.reduce((s, x) => s + x, 0) / a.length;
    return m ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) / m : 0;
}
const sd = (a) => (a.length < 2 ? 0 : cv(a) * (a.reduce((s, x) => s + x, 0) / a.length));
const width = (b) => b.qrsWidthMs ?? ((b.qrsOffMs ?? b.qrsOnMs + 90) - b.qrsOnMs);
const ectopic = (b) => b.quality === 'pvc';

/**
 * The rhythm as the marks show it. P waves only count where the user marked P waves
 * (cycles outside the marked P span are "not looked at", not "no P").
 * `params` is the pairing window the ladder is drawn with (PRmin / PRmax); without it the
 * defaults are used, so a strip read with a widened window is measured with that window too.
 */
export function measureRhythm(beats = [], atrial = [], params = null) {
    const B = beats.slice().sort(byQ), A = atrial.slice().sort(byT);
    const n = B.length;
    const rrAll = B.slice(1).map((b, i) => b.qrsOnMs - B[i].qrsOnMs);
    const rrN = B.slice(1).map((b, i) => (!ectopic(b) && !ectopic(B[i]) ? b.qrsOnMs - B[i].qrsOnMs : null)).filter(x => x != null);
    const rr = rrN.length >= 2 ? rrN : rrAll;
    const RR = median(rr);
    // a repeating group (bigeminy, trigeminy) is regular in its groups even though its RR alternates
    const pat = n >= 3 ? beatPattern(B) : null;
    const rrPeriod = pat ? pat.k : null;
    const groupCV = rrPeriod && rrPeriod > 1 && rrAll.length > rrPeriod
        ? cv(rrAll.slice(0, rrAll.length - rrPeriod + 1).map((_, i) => rrAll.slice(i, i + rrPeriod).reduce((a, x) => a + x, 0))) : null;
    const rrCV = groupCV ?? cv(rr);
    // the rate of a repeating group is its mean interval (bigeminy 480 + 1240 ms is 860 ms, not a tachycardia)
    const RRg = groupCV != null ? median(rrAll.slice(0, rrAll.length - rrPeriod + 1).map((_, i) => rrAll.slice(i, i + rrPeriod).reduce((a, x) => a + x, 0))) / rrPeriod : RR;
    const regularity = rr.length < 2 ? 'unknown' : rrCV <= 0.08 ? 'regular' : rrCV >= 0.15 ? 'irregular' : 'variable';
    const qrsMs = median(B.map(width));
    const wideShare = n ? B.filter(b => width(b) >= WIDE_QRS_MS).length / n : 0;
    // a strip where every beat is marked ectopic (VT, a ventricular escape rhythm) is read as its own rhythm
    const ect = B.length && B.every(ectopic) ? () => false : ectopic;
    const out = {
        nBeats: n, nP: A.length, RR: round(RRg), rate: RRg ? Math.round(60000 / RRg) : null, rrCV: +rrCV.toFixed(3), regularity,
        qrsMs: round(qrsMs), wide: wideShare >= 0.6, wideShare: +wideShare.toFixed(2), anyEctopic: B.some(ectopic) && !B.every(ectopic),
        rrPeriod, afVeto: false, pqSweep: null,
        tachy: RRg != null && RRg < TACHY_RR_MS,
        relation: A.length ? 'unknown' : 'none', RP: null, PR: null, rpClass: null, rpSD: null, pPerCycle: null,
        PP: null, ppCV: null, pCoverage: null, prFixed: false, prSD: null, dissociated: false, coveredCycles: 0,
    };
    if (A.length >= 2) {
        // the atrial cycle, tolerant of a missed P (an interval of 2 × PP) or an extra one: the base
        // interval of which most intervals are whole multiples
        const pp = A.slice(1).map((a, i) => a.tMs - A[i].tMs);
        let base = median(pp), bestFit = -1;
        for (const v of pp) {
            if (v < 150) continue;
            const fit = pp.filter(x => { const k = Math.round(x / v); return k >= 1 && k <= 4 && Math.abs(x - k * v) <= 0.12 * v; }).length;
            if (fit > bestFit || (fit === bestFit && v > base)) { bestFit = fit; base = v; }
        }
        const norm = pp.map(x => x / Math.max(1, Math.round(x / base))).filter(x => Math.abs(x - base) <= 0.15 * base);
        base = median(norm.length ? norm : pp);
        out.PP = round(base);
        out.ppCV = norm.length >= Math.max(2, 0.75 * pp.length) ? +cv(norm).toFixed(3) : +cv(pp).toFixed(3);
        // How many of the P waves that cycle predicts between the first and last mark were actually
        // found. The fit above divides every interval by its nearest whole multiple of the base, with no
        // limit on the multiple, so a few scattered deflections always "fit" some base: 5 marks at
        // 1562, 2978, 3704, 7958, 8598 ms read as regular P at 85/min (4254 ms = 6 × 709) on a real
        // tracing, and made a complete block out of it (coverage 0.42). Dissociation needs ≥ 0.6: the synthetic
        // complete blocks, whose P waves partly hide in the QRS and T, reach 0.75-0.83.
        out.pCoverage = +(A.length / (1 + (A[A.length - 1].tMs - A[0].tMs) / base)).toFixed(2);
    }
    out.afVeto = out.anyEctopic || (rrPeriod != null && rrPeriod >= 2) || regularity === 'regular';
    if (!A.length || n < 2) return out;

    // P waves per QRS cycle [qrs_k − 20, qrs_{k+1} − 20): a P inside the QRS counts as RP ≈ 0.
    const first = A[0].tMs, last = A[A.length - 1].tMs;
    const cycles = [];
    for (let k = 0; k < n - 1; k++) {
        if (ect(B[k]) || ect(B[k + 1])) continue;
        const t0 = B[k].qrsOnMs - 20, t1 = B[k + 1].qrsOnMs - 20;
        if (t1 < first - 20 || t0 > last + 20) continue;           // the user did not mark P waves here
        const ps = A.filter(a => a.tMs >= t0 && a.tMs < t1);
        cycles.push({ k, cl: B[k + 1].qrsOnMs - B[k].qrsOnMs, ps: ps.map(a => a.tMs - B[k].qrsOnMs) });
    }
    out.coveredCycles = cycles.length;
    if (!cycles.length) return out;
    // a stray P among many beats says nothing about the P–QRS relation: read it as no P
    if (n >= 6 && A.length < Math.max(2, 0.3 * n)) { out.relation = 'none'; return out; }
    const counts = cycles.map(c => c.ps.length);
    out.pPerCycle = +(counts.reduce((s, x) => s + x, 0) / cycles.length).toFixed(2);
    const ones = cycles.filter(c => c.ps.length === 1);

    // PR of the P that conducted each QRS (nearest preceding P in the pairing window)
    const { pairs } = pairAtrialToBeats(B, A, params ? { ...DEFAULT_PARAMS, ...params } : DEFAULT_PARAMS);
    const aT = new Map(A.map(a => [a.id, a.tMs]));
    const prs = B.filter(b => !ect(b) && pairs.has(b.id)).map(b => b.qrsOnMs - aT.get(pairs.get(b.id)));
    out.prSD = prs.length >= 2 ? Math.round(sd(prs)) : null;
    out.prFixed = prs.length >= 2 && out.prSD <= 25 && prs.length >= 0.8 * B.filter(b => !ect(b)).length;
    // how far the P-to-next-QRS interval wanders, over the P waves followed by a QRS before the next P:
    // in complete block / dissociation it sweeps the whole cycle; in Wenckebach it stays within the PR range
    const dq = [];
    A.forEach((a, i) => {
        const q = B.find(b => b.qrsOnMs > a.tMs + 20);
        const nextP = A[i + 1]?.tMs ?? Infinity;
        if (q && q.qrsOnMs < nextP) dq.push(q.qrsOnMs - a.tMs);
    });
    out.pqSweep = dq.length >= 3 ? Math.round(Math.max(...dq) - Math.min(...dq)) : null;

    if (ones.length >= 0.8 * cycles.length) {
        const rps = ones.map(c => Math.max(0, c.ps[0]));
        out.rpSD = Math.round(sd(rps));
        if (out.rpSD <= 40) {
            out.relation = '1:1';
            out.RP = Math.round(median(rps));
            out.PR = Math.round(median(ones.map(c => c.cl - Math.max(0, c.ps[0]))));
            out.rpClass = out.RP <= VA_AP_MIN_MS ? 'veryShort' : out.RP < out.PR ? 'short' : 'long';
        } else out.relation = 'variable';
    } else if (out.pPerCycle >= 1.5) out.relation = 'A>V';
    else if (out.pPerCycle <= 0.6 && cycles.length >= 3) out.relation = 'V>A';
    else out.relation = 'variable';

    // AV dissociation: regular P waves that keep no fixed relation to the QRS
    out.dissociated = A.length >= 3 && out.ppCV != null && out.ppCV <= 0.12 && out.pCoverage >= 0.6 && !out.prFixed && out.relation !== '1:1'
        && (out.relation === 'V>A' || out.relation === 'variable' || out.relation === 'A>V' || (out.prSD != null && out.prSD > 60))
        && out.pqSweep != null && out.pqSweep >= 0.6 * Math.min(out.PP, RR ?? Infinity);
    if (out.dissociated && out.relation === 'variable') out.relation = 'dissociated';
    // fibrillation has no organised P and an irregular RR: a regular RR, a repeating group, ectopy or
    // organised P waves (regular, or one per QRS) veto an automatic AF call
    out.afVeto = out.anyEctopic || (rrPeriod != null && rrPeriod >= 2) || regularity === 'regular'
        || out.relation === '1:1' || out.dissociated || (A.length >= 3 && out.ppCV != null && out.ppCV <= 0.15)
        || (out.pPerCycle != null && out.pPerCycle >= 0.8 && out.pPerCycle <= 1.3);
    return out;
}

// ─── plausibility ───────────────────────────────────────────────────────────

const AVRT_FAMILY = ['avrt', 'pjrt', 'avrtAnti'];
const SVT_REGULAR = ['avnrt', 'avrt', 'pjrt', 'at', 'jt', 'avrtAnti'];

/**
 * Every mechanism → { status: 'ok' | 'caution' | 'excluded', reasons: [] }, plus the rhythm and a one-line summary.
 * `evidence` (optional, P2): what a rhythm detector found on the tracing (see rankReadings). It only adds reasons
 * and cautions; a reading is excluded by the marks alone. Without it the verdicts are P1's, unchanged.
 */
export function plausibility(beats = [], atrial = [], params = null, evidence = null) {
    const m = measureRhythm(beats, atrial, params);
    const v = Object.fromEntries(MECHANISMS.map(x => [x.id, { status: 'ok', reasons: [] }]));
    const exclude = (ids, why) => ids.forEach(id => { v[id].status = 'excluded'; v[id].reasons.push(why); });
    const caution = (ids, why) => ids.forEach(id => { if (v[id].status !== 'excluded') v[id].status = 'caution'; v[id].reasons.push(why); });

    // Pacing is a fact of the tracing, stated on the marks: without a paced mark there is nothing for the paced
    // reading to draw; with one, every other reading would draw the paced beats as the heart's own.
    const pacedMarks = beats.filter(b => b && b.origin === 'paced').length + atrial.filter(a => a && a.origin === 'paced').length;
    if (!pacedMarks) exclude(['paced'], 'no mark is flagged as paced (open the card of the P or QRS after a stimulus and flag it)');
    else caution(MECHANISMS.map(x => x.id).filter(id => id !== 'paced'), `${pacedMarks} mark(s) flagged as paced: only the paced reading draws the device's stimuli`);

    if (m.nBeats < 2) return { rhythm: m, verdicts: v, summary: 'Mark at least two QRS onsets.' };

    // QRS width
    if (!m.wide) {
        exclude(['avrtAnti'], `narrow QRS (${m.qrsMs} ms): antidromic AVRT is maximally pre-excited, so its QRS is wide`);
        caution(['vt'], `narrow QRS (${m.qrsMs} ms): VT is wide; even fascicular VT, the narrowest, is usually 100–140 ms`);
    }
    if (!m.anyEctopic && !m.wide) caution(['pvc'], 'no beat is marked ectopic (select a QRS and tick "Ectopic")');

    // rate and regularity
    if (!m.tachy && m.RR) caution(['avnrt', 'avrt', 'pjrt', 'avrtAnti', 'at', 'vt'], `rate ${m.rate}/min: not a tachycardia`);
    if (m.regularity === 'irregular') caution(['avnrt', 'avrt', 'pjrt', 'jt', 'avrtAnti'], `irregular RR (CV ${Math.round(m.rrCV * 100)} %): re-entry through the AV node or a pathway is regular`);
    if (m.regularity === 'regular' && m.nBeats >= 5) caution(['afib'], 'regular RR: fibrillation conducts irregularly (a regular RR in AF means complete AV block)');

    // the A:V relation
    if (m.relation === 'none') {
        caution(['avb3', 'hisExtra', 'flutter'], 'no P waves marked');
    } else if (m.relation === '1:1') {
        const rp = `RP ${m.RP} ms, PR ${m.PR} ms`;
        if (m.rpClass === 'veryShort') {
            if (m.RP < VA_AVRT_FLOOR_MS) exclude(['avrt'], `${rp}: an RP under ${VA_AVRT_FLOOR_MS} ms is shorter than any VA recorded in orthodromic AVRT (${VA_AVRT_FLOOR_MS} ms; Ceresnak 2015) — the ventricle and the pathway must be activated before the atrium`);
            else caution(['avrt'], `${rp}: orthodromic AVRT unlikely, not excluded — VA < ${VA_AP_MIN_MS} ms occurs in AVRT (13 % of children, Ceresnak 2015; left-sided pathways in adults, Nagashima 2016)`);
            exclude(['pjrt'], `${rp}: PJRT has a long RP`);
            caution(['at'], `${rp}: an atrial tachycardia would need a PR almost as long as the cycle`);
        } else if (m.rpClass === 'short') {
            exclude(['pjrt'], `${rp}: short RP — PJRT has a long RP`);
            if (m.RP <= RP_AVNRT_SURFACE_MS) caution(['avrt'], `${rp}: RP ≤ ${RP_AVNRT_SURFACE_MS} ms on the surface ECG favours typical AVNRT (ESC 2019; Shi 2025) — orthodromic AVRT unlikely, not excluded`);
            else caution(['avnrt'], `${rp}: RP > ${RP_AVNRT_SURFACE_MS} ms on the surface ECG — typical AVNRT unlikely (slow–slow AVNRT possible)`);
        } else if (m.rpClass === 'long') {
            exclude(['avrt'], `${rp}: long RP — a fast accessory pathway returns early (short RP); a long-RP orthodromic tachycardia is PJRT`);
            v.avnrt.reasons.push(`${rp}: long RP — only the atypical (fast–slow) form; typical AVNRT is excluded`);
            caution(['jt'], `${rp}: long RP — junctional tachycardia usually has a short VA`);
        }
        if (m.prFixed) exclude(['avb3'], 'every QRS follows its P at a fixed PR: conduction, not complete block');
        caution(['hisExtra'], 'no P fails to conduct');
        // a P before every QRS is not fibrillation; a fast sinus rhythm conducts with a short PR (the AV node is
        // under the same sympathetic drive), so a long PR at a tachycardia rate is a P that belongs to the previous QRS
        exclude(['afib'], `a P before each QRS (1:1): atrial fibrillation has no discrete P waves`);
        if (m.tachy && m.PR != null && m.PR >= 250) caution(['avnodal'], `${rp} at ${m.rate}/min: a sinus tachycardia this fast conducts with a short PR — a P this far from the next QRS is more likely a retrograde P or an ectopic atrial rhythm (P-wave axis is not evaluated)`);
    } else if (m.relation === 'A>V') {
        exclude(AVRT_FAMILY, `more P than QRS (${m.pPerCycle} per cycle): AVRT needs 1:1 — the atrium and the ventricle are both in the circuit`);
        caution(['avnrt'], `more P than QRS: AVNRT with block below the circuit is rare`);
        caution(['jt'], 'more P than QRS');
    } else if (m.relation === 'V>A' || m.relation === 'dissociated') {
        const why = m.relation === 'V>A' ? `more QRS than P (${m.pPerCycle} per cycle)` : 'P waves march through without a fixed relation to the QRS (AV dissociation)';
        exclude(AVRT_FAMILY, `${why}: AVRT needs 1:1 — the atrium and the ventricle are both in the circuit`);
        if (m.relation === 'V>A') exclude(['at', 'flutter'], `${why}: in an atrial tachycardia every QRS has an atrial activation before it`);
        else caution(['at'], why);
        caution(['avnrt'], `${why}: AVNRT with retrograde block is rare`);
        if (!m.dissociated) caution(['avb3'], 'the P waves are not regular');
    } else if (m.relation === 'variable') {
        caution(['avrt', 'pjrt'], 'the RP changes from beat to beat: AVRT keeps a fixed VA');
    }
    if (m.relation !== 'none' && m.nP >= 2 && m.PP && (m.PP < 160 || m.PP > 350)) caution(['flutter'], `P–P ${m.PP} ms: flutter waves come every 160–350 ms`);
    if (m.relation !== 'none' && m.nP < 2) caution(['flutter'], 'mark at least two F waves');
    if (m.dissociated && m.PP && m.RR && m.PP >= m.RR) caution(['avb3'], 'the ventricles are not slower than the atria');
    // the escape of complete block: junctional 40–60 /min with a narrow QRS, ventricular 20–40 /min and wide
    if (m.relation === 'dissociated' && m.rate) {
        if (!m.wide && m.rate > 60) caution(['avb3'], `narrow QRS at ${m.rate}/min: faster than a junctional escape (40–60 /min) — an accelerated junctional rhythm with AV dissociation, rather than block?`);
        if (m.wide && m.rate > 50) caution(['avb3'], `wide QRS at ${m.rate}/min: faster than a ventricular escape (20–40 /min) — an accelerated idioventricular rhythm or VT with AV dissociation?`);
    }
    // a focal atrial tachycardia is under 240 /min; faster regular atrial activity is flutter
    if (m.relation !== 'none' && m.nP >= 3 && m.PP && m.PP < 250 && m.ppCV != null && m.ppCV <= 0.1) caution(['at'], `atrial rate ${Math.round(60000 / m.PP)}/min: a focal atrial tachycardia is under 240 /min — regular atrial activity this fast is flutter`);
    if (evidence) evidenceReasons(evidence, v, caution);

    return { rhythm: m, verdicts: v, summary: rhythmSummary(m) };
}

/** P2: what the detector saw, said against the readings it bears on — reasons and cautions, never an exclusion. */
function evidenceReasons(ev, v, caution) {
    const src = ev.source ? `rhythm detector ${ev.source}` : 'rhythm detector';
    const say = (ids, why) => ids.forEach(id => { if (v[id] && !v[id].reasons.includes(why)) v[id].reasons.push(why); });
    const at = ev.atrial || {};
    if (at.kind === 'flutter') caution(['afib'], `${src}: regular F waves${at.cycleMs ? ` every ${Math.round(at.cycleMs)} ms (${Math.round(60000 / at.cycleMs)}/min)` : ''} — organised atrial activity, not fibrillation`);
    if (at.kind === 'fib') caution(['flutter', 'at'], `${src}: fibrillatory atrial waves${at.cycleMs ? ` (cycle ~${Math.round(at.cycleMs)} ms)` : ''} — no organised atrial rhythm`);
    if (at.kind === 'sinus') caution(['afib'], `${src}: a sinus P at a steady PR — organised atrial activity, not fibrillation`);
    if (ev.pacing && ev.pacing.mode) say(['paced'], `${src}: ${ev.pacing.mode} pacemaker${ev.pacing.lriMs ? `, lower rate ${Math.round(60000 / ev.pacing.lriMs)}/min` : ''} — accept its stimulus marks to draw it`);
    const r = ev.reading && readingOf(ev.reading);
    if (r) say([r.mechanism], `${src}: ${ev.label || r.label}${ev.confidence ? ` (${ev.confidence} confidence)` : ''}`);
}

export function rhythmSummary(m) {
    if (m.nBeats < 2) return 'Mark at least two QRS onsets.';
    const parts = [`${m.regularity === 'unknown' ? '' : m.regularity + ' '}${m.wide ? 'wide' : 'narrow'}-QRS rhythm, ${m.rate}/min`];
    if (m.relation === 'none') parts.push('no P marked');
    else if (m.relation === '1:1' && !m.tachy) parts.push(`a P before each QRS, PR ${m.PR} ms`);
    else if (m.relation === '1:1') parts.push(`1:1, RP ${m.RP} / PR ${m.PR} ms (${{ veryShort: 'RP ≤ 70 ms', short: 'short RP', long: 'long RP' }[m.rpClass]})`);
    else if (m.relation === 'A>V') parts.push(`more P than QRS (${m.pPerCycle}:1)`);
    else if (m.relation === 'V>A') parts.push('more QRS than P');
    else if (m.relation === 'dissociated') parts.push('AV dissociation');
    else if (m.relation === 'variable') parts.push('variable P–QRS relation');
    return parts.join(' · ');
}

/**
 * A first reading for the marks — never one they exclude. Rate, width and the RP / PR decide it;
 * `rhythm.afib` (the viewer's automatic AF gate) wins.
 */
export function suggestReading(beats = [], atrial = [], rhythm = {}, params = null) {
    const { rhythm: m, verdicts } = plausibility(beats, atrial, params);
    const ok = (id) => verdicts[id] && verdicts[id].status !== 'excluded';
    const pick = (ids, reason) => { const id = ids.find(ok); return id ? { id, reason } : null; };
    const flutterLike = m.relation !== 'none' && m.nP >= 3 && m.ppCV != null && m.ppCV <= 0.1 && m.PP >= 160 && m.PP <= 350;
    let s = null;
    const paced = beats.some(b => b && b.origin === 'paced') || atrial.some(a => a && a.origin === 'paced');
    if (paced) return pick(['paced'], 'marks flagged as paced: a paced rhythm') ?? { id: 'avnodal', reason: 'default reading' };
    // an automatic AF call (the viewer's gate) yields to ectopy, a bigeminal pattern or 1:1 P waves
    if (rhythm.afib && !m.afVeto) s = pick(['afib'], 'irregularly irregular RR without organised P — detected automatically');
    else if (m.tachy && m.wide) s = pick(['vt'], 'wide-QRS tachycardia — VT until proven otherwise');
    else if (m.dissociated && m.RR && m.PP && m.RR > m.PP) s = pick(['avb3'], 'regular P waves unrelated to a slower QRS — complete AV block?');
    else if (m.tachy && m.regularity === 'irregular' && m.relation !== '1:1' && !m.afVeto && !flutterLike) s = pick(['afib'], 'irregular narrow tachycardia without a P before each QRS');
    else if (m.tachy && m.relation === '1:1') {
        const avrtLeft = m.RP < VA_AVRT_FLOOR_MS ? `orthodromic AVRT is excluded (RP < ${VA_AVRT_FLOOR_MS} ms)` : 'orthodromic AVRT unlikely, not excluded';
        s = m.rpClass !== 'long' && m.RP <= RP_AVNRT_SURFACE_MS ? pick(['avnrt', 'jt'], `RP ${m.RP} ms ≤ ${RP_AVNRT_SURFACE_MS}: typical AVNRT favoured (ESC 2019; Shi 2025); ${avrtLeft} — ${RP_CAVEAT}`)
          : m.rpClass === 'short' ? pick(['avrt', 'at', 'avnrt'], `short RP (${m.RP} ms > ${RP_AVNRT_SURFACE_MS}): orthodromic AVRT favoured — AT and slow–slow AVNRT remain — ${RP_CAVEAT}`)
          : pick(['at', 'avnrt', 'pjrt'], `long RP (RP ${m.RP} > PR ${m.PR}): atrial tachycardia, atypical AVNRT or PJRT`);
    } else if (m.tachy && (m.relation === 'none' || m.nP < Math.max(2, 0.3 * m.nBeats)) && m.regularity !== 'irregular') {
        s = pick(['avnrt'], 'regular narrow tachycardia with no P visible — likely hidden in the QRS (typical AVNRT); mark a retrograde P if you see one');
    } else if (m.relation === 'A>V' && flutterLike && 60000 / m.PP >= 240) {
        s = pick(['flutter'], `regular atrial waves every ${m.PP} ms (${Math.round(60000 / m.PP)}/min) — atrial flutter with ${Math.round(m.pPerCycle)}:1 conduction`);
    } else if (m.tachy && m.relation === 'A>V') s = pick(['at', 'flutter'], 'more atrial than ventricular activations — atrial tachycardia or flutter with AV block');
    else if (m.anyEctopic) s = pick(['pvc'], 'ectopic beats marked');
    else if (m.regularity === 'irregular' && m.relation === 'none' && m.nBeats >= 6 && !m.afVeto) s = pick(['afib'], 'irregularly irregular RR and no P marked');
    else if (m.relation === 'A>V') s = pick(['avnodal'], 'P waves without a QRS — AV block (Wenckebach, Mobitz II or 2:1)');
    // P2: a slow, regular rhythm of several beats with no P marked at all is a focus below the atria, named by its QRS
    else if (!atrial.length && m.nBeats >= 4 && !m.tachy && m.regularity === 'regular') {
        s = m.wide ? pick(['vt'], `a regular wide rhythm at ${m.rate}/min with no P marked — a ventricular focus (${m.rate >= 50 ? 'accelerated idioventricular rhythm' : 'ventricular escape'}); mark the P waves if there are any`)
                   : pick(['jt'], `a regular narrow rhythm at ${m.rate}/min with no P marked — a junctional focus (${m.rate <= 60 ? 'junctional escape' : 'accelerated junctional rhythm'}); mark the P waves if there are any`);
    }
    if (!s) s = pick(['avnodal', 'at', 'jt', 'vt'], m.relation === '1:1' || m.relation === 'none' ? 'P before each QRS' : 'sinus / AV conduction');
    return s ?? { id: 'avnodal', reason: 'default reading' };
}

// ─── named readings (P2) ────────────────────────────────────────────────────

/** The families the readings group by, in the order a reader thinks about them. */
export const READING_FAMILIES = ['Sinus & AV conduction', 'AV block', 'Narrow-QRS tachycardia', 'Wide-QRS tachycardia',
    'Atrial arrhythmias', 'Escape & accelerated rhythms', 'Pacemaker'];

/**
 * Every reading the ladder can be asked to draw, by name. A reading is a MECHANISM (what the engine draws) and,
 * for the subtypes, the parameters and tiers that make the drawing say it: Mobitz II drops below the His, SA
 * exit block puts the blocked discharge on the SN tier, a pacemaker gets its timing row. The id of the plain
 * reading of a mechanism is the mechanism's own id, so a file or a menu that only knows mechanisms still works.
 */
const RD = (id, mechanism, label, family, extra = {}) => Object.freeze({ id, mechanism, label, family, ...extra });
export const READINGS = Object.freeze([
    RD('avnodal', 'avnodal', 'Sinus / AV conduction', 'Sinus & AV conduction'),
    RD('sab2_type1', 'avnodal', '2nd-degree SA exit block, type I (SA Wenckebach)', 'Sinus & AV conduction', { params: { saBlock: 1 }, tiers: ['SN'] }),
    RD('sab2_type2', 'avnodal', '2nd-degree SA exit block, type II', 'Sinus & AV conduction', { params: { saBlock: 2 }, tiers: ['SN'] }),
    RD('pvc', 'pvc', 'Sinus + ectopic beats', 'Sinus & AV conduction'),
    RD('avb1', 'avnodal', '1st-degree AV block', 'AV block'),
    RD('avb2_type1', 'avnodal', '2nd-degree AV block, Mobitz I (Wenckebach)', 'AV block'),
    RD('avb2_type2', 'avnodal', '2nd-degree AV block, Mobitz II', 'AV block', { params: { blockBelowHis: 1 }, tiers: ['His'] }),
    RD('avb2_1', 'avnodal', '2:1 AV block', 'AV block'),
    RD('avb_high', 'avnodal', 'High-grade (advanced) AV block', 'AV block'),
    RD('avb3', 'avb3', 'Complete (3rd-degree) AV block', 'AV block'),
    RD('hisExtra', 'hisExtra', 'Concealed His extrasystoles (pseudo AV block)', 'AV block'),
    RD('avnrt', 'avnrt', 'AVNRT', 'Narrow-QRS tachycardia'),
    RD('avrt', 'avrt', 'Orthodromic AVRT', 'Narrow-QRS tachycardia'),
    RD('pjrt', 'pjrt', 'PJRT', 'Narrow-QRS tachycardia'),
    RD('at', 'at', 'Atrial tachycardia', 'Narrow-QRS tachycardia'),
    RD('jt', 'jt', 'Junctional tachycardia', 'Narrow-QRS tachycardia'),
    RD('vt', 'vt', 'Ventricular tachycardia', 'Wide-QRS tachycardia'),
    RD('nsvt', 'pvc', 'Non-sustained ventricular tachycardia', 'Wide-QRS tachycardia'),
    RD('avrtAnti', 'avrtAnti', 'Antidromic AVRT', 'Wide-QRS tachycardia'),
    RD('afib', 'afib', 'Atrial fibrillation', 'Atrial arrhythmias'),
    RD('flutter', 'flutter', 'Atrial flutter', 'Atrial arrhythmias'),
    RD('ectopicAtrial', 'at', 'Ectopic atrial rhythm', 'Atrial arrhythmias'),
    RD('junctionalEscape', 'jt', 'Junctional escape rhythm', 'Escape & accelerated rhythms'),
    RD('aivr', 'vt', 'Accelerated idioventricular rhythm', 'Escape & accelerated rhythms'),
    RD('vEscape', 'vt', 'Ventricular escape rhythm', 'Escape & accelerated rhythms'),
    RD('paced', 'paced', 'Paced rhythm', 'Pacemaker'),
    RD('pacedAAI', 'paced', 'Atrial pacing (AAI)', 'Pacemaker', { tiers: ['PM'] }),
    RD('pacedVVI', 'paced', 'Ventricular pacing (VVI)', 'Pacemaker', { tiers: ['PM'] }),
    RD('pacedDDD', 'paced', 'Dual-chamber pacing (DDD / VDD)', 'Pacemaker', { tiers: ['PM'] }),
]);
const READING_BY_ID = new Map(READINGS.map(r => [r.id, r]));
/** The reading with this id, or null. */
export const readingOf = (id) => READING_BY_ID.get(id) || null;

/**
 * The P → QRS conduction pattern of the marks, as the engine classifies it when it draws sinus / AV conduction
 * (classifyConduction: Wenckebach = AH rising ≥ 30 ms over ≥ 2 conducted P before the drop; Mobitz II = constant
 * AH around the drop; 2:1 = conducted and blocked P alternating; a premature blocked P is a PAC, not block),
 * plus what the engine does not name: a run of ≥ 2 blocked P on the atrial schedule (high-grade block),
 * P waves marching through (complete block), a long PR on every beat (1st degree).
 * @returns {{ kind: 'normal'|'avb1'|'wenckebach'|'mobitz2'|'2:1'|'high-grade'|'complete'|'blocked'|null, ratio, prMs, blocked, why }}
 */
export function avConduction(beats = [], atrial = [], params = null) {
    const B = beats.filter(b => b && b.origin !== 'paced'), A = atrial.filter(a => a && a.origin !== 'paced');
    const out = { kind: null, ratio: null, prMs: null, blocked: 0, why: '' };
    if (B.length < 2 || A.length < 2) { out.why = 'not enough marks'; return out; }
    const m = measureRhythm(B, A, params);
    // a regular atrial rhythm this fast is flutter: its F waves are not P waves the node blocks one by one
    if (m.PP != null && m.PP < 350 && m.ppCV != null && m.ppCV <= 0.12) { out.why = 'atrial activity faster than 170/min'; return out; }
    const L = buildLadder({ beats: B, atrial: A, mechanism: 'avnodal', params, tiers: ['A', 'AV', 'His', 'V'] });
    const c = L.conduction || {};
    const prs = L.intervals.map(i => i.PRms).filter(x => x != null);
    out.prMs = prs.length ? Math.round(median(prs)) : null;
    // P by P: conducted, blocked, or neither (the strip ended, or an ectopic beat explains it — a P inside or just
    // after a ventricular extrasystole meets a refractory node: concealed conduction, not AV block)
    const ectopicQ = B.filter(b => b.quality === 'pvc').map(b => b.qrsOnMs);
    const conducted = new Set(L.paths.filter(p => p.role === 'av' && p.atrialId && p.beatId).map(p => p.atrialId));
    const blockedIds = new Set(L.paths.filter(p => /^(av-block|av-block-low|his-block)$/.test(p.role) && p.atrialId).map(p => p.atrialId));
    const seq = A.slice().sort(byT).map(a => ({ a, s: conducted.has(a.id) ? 'C' : blockedIds.has(a.id) && !ectopicQ.some(q => a.tMs >= q - 50 && a.tMs - q <= 500) ? 'B' : null }))
        .filter(x => x.s);
    // a P after the last QRS may have lost its QRS to the end of the strip, not to the node
    const lastQ = Math.max(...B.map(b => b.qrsOnMs));
    while (seq.length && seq[seq.length - 1].s === 'B' && seq[seq.length - 1].a.tMs > lastQ) seq.pop();
    out.blocked = seq.filter(x => x.s === 'B').length - (c.pac || 0);
    if (m.dissociated && m.RR && m.PP && m.RR > 1.1 * m.PP) {
        out.kind = 'complete';
        out.why = `P waves at ${Math.round(60000 / m.PP)}/min march through slower QRS (${m.rate}/min) at every PR`;
        return out;
    }
    if (out.blocked <= 0) {
        // nothing blocked that the node is to blame for
        if (m.relation === '1:1' || (m.relation !== 'none' && prs.length >= 0.8 * B.filter(b => b.quality !== 'pvc').length) || m.anyEctopic) {
            out.kind = out.prMs != null && out.prMs > 200 && !m.tachy ? 'avb1' : 'normal';
            out.why = out.kind === 'avb1' ? `every P conducts, PR ${out.prMs} ms (> 200)` : `every P conducts${out.prMs != null ? `, PR ${out.prMs} ms` : ''}`;
        }
        out.blocked = 0;
        return out;
    }
    // 2:1: conducted and blocked P alternate (the engine's own rule wants a conducted P on both sides of every
    // blocked one; a strip that starts or ends on a blocked P is 2:1 too)
    const str = seq.map(x => x.s).join('');
    if (str.length >= 4 && !/CC|BB/.test(str) && (str.match(/B/g) || []).length >= 2 && (str.match(/C/g) || []).length >= 2) {
        out.kind = '2:1'; out.ratio = '2:1'; out.why = `every other P conducts (PR ${out.prMs} ms), the other is blocked`; return out;
    }
    if (c.twoToOne) { out.kind = '2:1'; out.ratio = '2:1'; out.why = `every other P conducts (PR ${out.prMs} ms), the other is blocked`; return out; }
    // runs of blocked P between two conducted ones (a run at either end of the strip may be cut short by it)
    const inner = str.replace(/^B+|B+$/g, '');
    const runB = Math.max(0, ...((inner.match(/B+/g) || str.match(/B+/g) || []).map(x => x.length)));
    if (runB >= 2 && runB <= 5 && m.relation === 'A>V' && (str.match(/C/g) || []).length >= 2) {
        out.kind = 'high-grade'; out.ratio = `${runB + 1}:1`;
        out.why = `${runB} consecutive P waves blocked on the atrial schedule`;
        return out;
    }
    if (c.wenckebach && c.wenckebach >= (c.mobitz2 || 0)) {
        out.kind = 'wenckebach'; out.ratio = groupRatio(L, A);
        out.why = `the PR lengthens before each blocked P (${c.wenckebach}×) and shortens after it`;
        return out;
    }
    if (c.mobitz2) { out.kind = 'mobitz2'; out.ratio = groupRatio(L, A); out.why = `a P blocked after a constant PR (${c.mobitz2}×)`; return out; }
    out.kind = 'blocked'; out.why = `${out.blocked} P wave(s) without a QRS, no pattern`;
    return out;
}

/** "n+1:n" — the commonest group of conducted P between two blocked ones. */
function groupRatio(L, A) {
    const conducted = new Set(L.paths.filter(p => p.role === 'av' && p.atrialId && p.beatId).map(p => p.atrialId));
    const runs = []; let run = 0;
    for (const a of A.slice().sort(byT)) { if (conducted.has(a.id)) run++; else { if (run) runs.push(run); run = 0; } }
    if (!runs.length) return null;
    const freq = new Map(); for (const r of runs) freq.set(r, (freq.get(r) || 0) + 1);
    const k = [...freq].sort((x, y) => y[1] - x[1] || y[0] - x[0])[0][0];
    return `${k + 1}:${k}`;
}

/**
 * Second-degree sinoatrial exit block from the P marks (sinoatrialPattern in the engine): only where every P
 * conducts — a P missing because the AV node or a mark failed is something else.
 * @returns {{ kind: 'sab2_type1'|'sab2_type2'|null, basicMs, pauses, why }}
 */
export function saConduction(beats = [], atrial = [], params = null) {
    const A = atrial.filter(a => a && a.origin !== 'paced');
    const out = { kind: null, basicMs: null, pauses: [], why: '' };
    if (A.length < 5 || beats.length < 4) return out;
    const m = measureRhythm(beats, A, params);
    if (!(m.relation === '1:1' || m.prFixed) || m.tachy) return out;
    const sa = sinoatrialPattern(A);
    if (!sa || !sa.kind) return out;
    // nothing inside the pause: a QRS there (an extrasystole, a run, an escape) hid a P or reset the node
    const As = A.filter(a => a.origin !== 'paced').slice().sort(byT), pr = m.PR ?? 200;
    for (const p of sa.pauses) {
        const lo = As[p.i].tMs + pr + 80, hi = As[p.i + 1].tMs - 40;
        if (beats.some(b => b.qrsOnMs > lo && b.qrsOnMs < hi)) return out;
    }
    return { kind: sa.kind === 2 ? 'sab2_type2' : 'sab2_type1', basicMs: sa.basicMs, pauses: sa.pauses, why: sa.why };
}

/** Flutter's conduction: the F–F cycle fitted to the F marks and how many F waves per QRS. */
export function flutterConduction(beats = [], atrial = []) {
    const out = { cycleMs: null, ratio: null, fixed: false };
    const fit = atrial.length >= 2 ? fitFlutter(atrial) : null;
    if (!fit || !(fit.cycleMs >= 160 && fit.cycleMs <= 350)) return out;
    out.cycleMs = Math.round(fit.cycleMs);
    const Q = beats.filter(b => b.quality !== 'pvc').map(b => b.qrsOnMs).sort((a, b) => a - b);
    const ks = Q.slice(1).map((q, i) => Math.round((q - Q[i]) / fit.cycleMs)).filter(k => k >= 1);
    if (!ks.length) return out;
    const freq = new Map(); for (const k of ks) freq.set(k, (freq.get(k) || 0) + 1);
    const [k, n] = [...freq].sort((x, y) => y[1] - x[1])[0];
    out.fixed = n >= 0.8 * ks.length;
    out.ratio = out.fixed ? `${k}:1` : 'variable';
    return out;
}

const WEIGHT = { high: 1, medium: 0.75, low: 0.5 };
/**
 * Every named reading, ranked (P2). What the marks show comes first: their verdict on the reading's mechanism
 * (an excluded mechanism ranks last whatever else is said), P1's suggestion, and the patterns P1 does not name —
 * the AV conduction pattern, SA pauses, the flutter ratio, the device's mode, the rate that names an escape or
 * accelerated rhythm, a run of ectopic beats. A subtype starts below its plain reading and passes it only on
 * evidence of its own. Then, when the caller has one, a rhythm detector's evidence:
 *   evidence = { source, reading, label, confidence: 'high'|'medium'|'low', alternatives: [readingId], secondary: [readingId],
 *                atrial: { kind: 'sinus'|'ectopic'|'retro'|'flutter'|'fib'|'none', cycleMs }, pacing: { mode, lriMs, aviMs },
 *                segments: [{ fromMs, toMs, reading }] }
 * — reading ids are READINGS ids.
 * @returns {{ ranked: [{ id, mechanism, label, family, score, status, reasons, params?, tiers? }], top, rhythm, verdicts,
 *             conduction, sa, flutter, pacing, summary }}
 */
export function rankReadings(beats = [], atrial = [], { params = null, evidence = null } = {}) {
    const ev = evidence || null;
    const { rhythm: m, verdicts: V, summary } = plausibility(beats, atrial, params, ev);
    const score = {}, why = {};
    for (const r of READINGS) {
        const st = V[r.mechanism]?.status ?? 'ok';
        score[r.id] = (st === 'caution' ? 0.3 : 1) - (r.id === r.mechanism ? 0 : 0.6);
        why[r.id] = [];
    }
    const add = (id, pts, reason) => { if (score[id] == null || !pts) return; score[id] += pts; if (reason && !why[id].includes(reason)) why[id].push(reason); };
    const fam = (ids, pts, reason) => ids.forEach(id => add(id, pts, reason));
    // support for a mechanism's plain reading supports its subtypes too (a 2:1 block IS sinus / AV conduction), a
    // little less: a subtype then passes its plain reading only on evidence of its own
    const addMech = (id, pts, reason) => {
        add(id, pts, reason);
        const r = readingOf(id);
        if (r && r.id === r.mechanism) for (const x of READINGS) if (x.mechanism === r.mechanism && x.id !== r.id) add(x.id, 0.8 * pts, null);
    };

    // P1's suggestion, as a prior on its plain reading
    const p1 = m.nBeats >= 2 ? suggestReading(beats, atrial, { afib: !!ev && (ev.atrial?.kind === 'fib' || ev.reading === 'afib') }, params) : null;
    // ectopic beats flagged on the marks, which a detector with a validated extrasystole rule did not confirm (the
    // marks' own ectopic flag over-calls on real tracings): the prior goes to sinus conduction, not to ectopy
    const unconfirmedEctopy = p1 && p1.id === 'pvc' && ev && !(ev.secondary || []).includes('pvc') && !['pvc', 'nsvt'].includes(ev.reading);
    if (p1 && !unconfirmedEctopy) addMech(p1.id, 2, p1.reason);
    else if (p1) addMech('avnodal', 2, `${p1.reason}, but the rhythm detector finds no extrasystole: sinus conduction`);

    // the device, from the marks flagged paced
    const pacedMarks = beats.some(b => b && b.origin === 'paced') || atrial.some(a => a && a.origin === 'paced');
    const pace = pacedMarks ? readPacing(beats, atrial, params) : null;
    if (pace && pace.mode) add({ AAI: 'pacedAAI', VVI: 'pacedVVI', DDD: 'pacedDDD' }[pace.mode], 6,
        `${pace.mode} from the paced marks${pace.lriMs ? `, lower rate ${Math.round(60000 / pace.lriMs)}/min` : ''}${pace.aviMs && pace.mode === 'DDD' ? `, AV delay ${Math.round(pace.aviMs)} ms` : ''}`);

    // AV conduction and SA exit (sinus rhythm only: a tachycardia's P–QRS is the circuit's)
    const cond = !pacedMarks && !m.tachy ? avConduction(beats, atrial, params) : { kind: null };
    const AVK = { 'avb1': ['avb1', 3], 'wenckebach': ['avb2_type1', 3.5], 'mobitz2': ['avb2_type2', 3.5], '2:1': ['avb2_1', 3.5], 'high-grade': ['avb_high', 3.5], 'complete': ['avb3', 2.5] };
    // A detector that reads AV block itself and called this strip plain sinus, with some confidence, is evidence
    // against the block the marks suggest (its P marks are the same ones, read with more checks): the marks' pattern
    // then counts for less, and the subtype needs the detector to name it.
    const sinusCall = ev && ev.reading === 'avnodal' && (ev.confidence === 'high' || ev.confidence === 'medium')
        && !(ev.secondary || []).includes(AVK[cond.kind]?.[0]) && ev.avBlockRules !== false;
    // A 1st-degree block is named on a MEASURED PR: the caller's (evidence.prMs: the engine's adjudicated PQ, what
    // the report rules read) when it has one, else the marks' own. Never on P the ladder placed at an averaged PR.
    // Above 200 ms (P2.1, José's definition: 1st-degree AV block = PR > 200 ms; P2 used 210 with evidence).
    const prMeasured = ev ? ev.prMs ?? null : cond.prMs;
    const avb1Ok = prMeasured != null && prMeasured > 200;
    if (AVK[cond.kind] && (cond.kind !== 'avb1' || avb1Ok)) add(AVK[cond.kind][0], sinusCall && cond.kind !== 'complete' ? 1.5 : AVK[cond.kind][1], `${cond.why}${cond.ratio ? ` (${cond.ratio})` : ''}`);
    if (!avb1Ok) add('avb1', -3, null);
    const sa = !pacedMarks && (cond.kind === 'normal' || cond.kind === 'avb1') ? saConduction(beats, atrial, params) : { kind: null };
    if (sa.kind) add(sa.kind, 3.5, sa.why);

    // flutter: its ratio names it
    const fl = m.nP >= 2 ? flutterConduction(beats, atrial) : { ratio: null };

    // the rate names what a focus does: tachycardia, accelerated, escape
    const rate = m.rate;
    const allEctopic = beats.length >= 3 && beats.every(b => b.quality === 'pvc' || ((b.qrsWidthMs ?? (b.qrsOffMs - b.qrsOnMs)) >= WIDE_QRS_MS && !b.conduction));
    // A wide QRS after a P at a steady PR, 1:1, is conducted (a bundle-branch block), not idioventricular: AIVR, an
    // escape or VT need AV dissociation or no P before each QRS. With a detector, the PR must be one the engine
    // measured and the P not retrograde (a VT with 1:1 retrograde conduction also reads 1:1); a tachycardia over
    // 150/min stays open. Marks alone: below 100/min.
    const prOk = (x) => x != null && x >= 80 && x <= 300;
    const wideConducted = m.wide && m.relation === '1:1' && m.prFixed && prOk(m.PR) && rate != null
        && (ev ? prOk(ev.prMs) && Math.abs(ev.prMs - m.PR) <= 60 && ev.atrial?.kind !== 'retro' && rate <= 150 : !m.tachy);
    if (wideConducted) {
        fam(['vt', 'aivr', 'vEscape', 'junctionalEscape'], -6, null);
        addMech('avnodal', 3, `a wide QRS after each P at a steady PR (${m.PR} ms${ev?.prMs ? `, measured PQ ${ev.prMs} ms` : ''}): conducted with a bundle-branch block, not a ventricular rhythm`);
    }
    // no P marked at all on a strip of several beats: nothing for sinus conduction to draw
    if (!atrial.length && m.nBeats >= 4 && !m.tachy) add('avnodal', -1.5, null);
    if (rate != null && !wideConducted && m.relation !== '1:1' && (allEctopic || (m.wide && (m.relation === 'none' || m.relation === 'dissociated' || m.relation === 'V>A')))) {
        const id = rate > 100 ? 'vt' : rate >= 50 ? 'aivr' : 'vEscape';
        fam(['vt', 'aivr', 'vEscape'].filter(x => x !== id), -1);
        add(id, rate > 100 ? 0.5 : 2.5, `a wide, ventricular rhythm at ${rate}/min${rate > 100 ? '' : rate >= 50 ? ' (50–100: accelerated idioventricular)' : ' (< 50: ventricular escape)'}`);
    }
    if (rate != null && !m.wide && !m.tachy && (m.relation === 'none' || m.relation === 'V>A' || m.relation === 'dissociated' || (m.relation === '1:1' && m.rpClass === 'veryShort'))) {
        const id = rate <= 60 ? 'junctionalEscape' : 'jt';
        add(id === 'jt' ? 'junctionalEscape' : 'jt', -1);
        add(id, id === 'jt' ? 0.5 : 2.5, `a narrow QRS at ${rate}/min without a P before it${rate <= 60 ? ' (≤ 60: a junctional escape)' : ' (an accelerated junctional rhythm)'}`);
    }
    if (rate != null && !m.tachy && m.relation === '1:1' && m.rpClass === 'long' && (V.at?.status !== 'excluded')) add('ectopicAtrial', 0.2);

    // a run of ≥ 3 ectopic beats faster than 100/min among conducted ones: non-sustained VT
    const Bs = beats.slice().sort(byQ);
    let run = 0, best = 0, runRate = null;
    for (let i = 0; i < Bs.length; i++) {
        run = Bs[i].quality === 'pvc' ? run + 1 : 0;
        if (run >= 3 && run > best) { best = run; const rr = Bs[i].qrsOnMs - Bs[i - 1].qrsOnMs; runRate = Math.round(60000 / rr); }
    }
    if (best >= 3 && Bs.some(b => b.quality !== 'pvc') && runRate > 100) add('nsvt', 3.5, `a run of ${best} ectopic beats at ~${runRate}/min among conducted beats`);

    // the detector's evidence. For a reading whose mechanism the marks caution against, it counts for less: the
    // marks are the ground truth the ladder is drawn from (a rate caution does not count against the readings the
    // rate itself names: an escape, an accelerated or an ectopic atrial rhythm is not a tachycardia by definition)
    if (ev) {
        const RATE_NAMED = new Set(['aivr', 'vEscape', 'junctionalEscape', 'ectopicAtrial', 'jt']);
        const damp = (id) => {
            const r = readingOf(id), v = r && V[r.mechanism];
            if (!v || v.status !== 'caution') return 1;
            const own = v.reasons.filter(x => !/^rhythm detector/.test(x));        // the marks' cautions, not the evidence's own reasons
            return RATE_NAMED.has(id) && own.every(x => /not a tachycardia/.test(x)) ? 1 : 0.4;
        };
        const add0 = add, addMech0 = addMech;
        const addE = (id, pts, reason) => add0(id, pts * damp(id), reason);
        const addMechE = (id, pts, reason) => { const k = damp(id); addMech0(id, pts * k, reason); };
        const w = WEIGHT[ev.confidence] ?? 0.6, src = ev.source ? `rhythm detector ${ev.source}` : 'rhythm detector';
        if (ev.reading) addMechE(ev.reading, 3.5 * w, `${src}: ${ev.label || readingOf(ev.reading)?.label || ev.reading} (${ev.confidence || '?'} confidence)`);
        (ev.alternatives || []).forEach((id, i) => addMechE(id, Math.max(0.3, 1.2 - 0.4 * i) * w, `${src}: an alternative`));
        (ev.secondary || []).forEach(id => { if (id !== 'avb1' || avb1Ok) addE(id, 3, `${src}: ${readingOf(id)?.label || id}`); });
        const k = ev.atrial?.kind;
        if (k === 'flutter') addE('flutter', 2, `${src}: regular F waves${ev.atrial.cycleMs ? ` every ${Math.round(ev.atrial.cycleMs)} ms` : ''}`);
        if (k === 'fib') addE('afib', 2, `${src}: fibrillatory atrial waves`);
        if (ev.pacing?.mode) addE({ AAI: 'pacedAAI', VVI: 'pacedVVI', DDD: 'pacedDDD', VDD: 'pacedDDD', DDI: 'pacedDDD' }[ev.pacing.mode] || 'paced', 2, `${src}: ${ev.pacing.mode} pacemaker`);
    }

    const order = new Map(READINGS.map((r, i) => [r.id, i]));
    const ranked = READINGS.map(r => {
        const v = V[r.mechanism] || { status: 'ok', reasons: [] };
        const label = r.id === 'flutter' && fl.ratio ? `Atrial flutter, ${fl.ratio === 'variable' ? 'variable conduction' : fl.ratio}`
            : (r.id === 'avb2_type1' || r.id === 'avb2_type2' || r.id === 'avb_high') && cond.ratio && AVK[cond.kind]?.[0] === r.id ? `${r.label}, ${cond.ratio}`
            : r.id === 'jt' && rate != null && rate <= 100 && !m.tachy ? 'Accelerated junctional rhythm' : r.label;
        return { ...r, label, score: +score[r.id].toFixed(2), status: v.status, reasons: [...new Set([...why[r.id], ...v.reasons])] };
    }).sort((a, b) => (a.status === 'excluded') - (b.status === 'excluded') || b.score - a.score || order.get(a.id) - order.get(b.id));
    return { ranked, top: ranked[0], rhythm: m, verdicts: V, conduction: cond, sa, flutter: fl, pacing: pace ? { mode: pace.mode, lriMs: pace.lriMs, aviMs: pace.aviMs } : null, summary };
}

// ─── timings per mechanism ──────────────────────────────────────────────────

/**
 * The VA after ectopic (PVC-marked or wide) beats, when the user marked a P right after them — unless that
 * P keeps the sinus P–P: then it is the sinus P, blocked by the ectopic beat (a compensatory pause), not a
 * retrograde one.
 */
function ectopicRetroVA(B, A, PP) {
    const vas = [];
    const onSinusGrid = (p) => {
        if (!PP) return false;
        const prev = A.filter(a => a.tMs < p.tMs - 100).pop();
        if (!prev) return false;
        const k = Math.round((p.tMs - prev.tMs) / PP);
        return k >= 1 && Math.abs(p.tMs - prev.tMs - k * PP) <= 0.12 * PP;
    };
    B.forEach((b, i) => {
        if (!(ectopic(b) || width(b) >= WIDE_QRS_MS)) return;
        const next = B[i + 1]?.qrsOnMs ?? Infinity;
        const p = A.find(a => a.tMs >= b.qrsOnMs + 20 && a.tMs < Math.min(next, b.qrsOnMs + 450));
        if (p && !onSinusGrid(p)) vas.push(p.tMs - b.qrsOnMs);
    });
    return vas.length ? { VA: Math.round(median(vas)), n: vas.length } : null;
}

/**
 * The timings a mechanism is drawn with, filled in for THESE marks: `params` (only the keys that differ
 * from the engine defaults or were measured), `source[k]` ∈ 'measured' | 'typical', `why[k]` in words.
 * An editor keeps the user's own values on top of these, and recomputes these when the marks change.
 */
export function plausibleParams(mechanism, beats = [], atrial = []) {
    const B = beats.slice().sort(byQ), A = atrial.slice().sort(byT);
    const m = measureRhythm(B, A);
    const params = {}, source = {}, why = {};
    const set = (k, val, src, text) => { params[k] = val; source[k] = src; why[k] = text; };
    const cl = m.RR;
    const oneToOne = m.relation === '1:1';
    const measuredVA = oneToOne ? `RP from your marks (median of the cycles with one P)` : null;

    switch (mechanism) {
        case 'avnrt':
            if (oneToOne) set('VA', m.RP, 'measured', measuredVA);
            else set('VA', 30, 'typical', 'typical AVNRT: the retrograde P hides in the end of the QRS (pseudo r′ / pseudo S)');
            break;
        case 'avrt':
            if (oneToOne) set('VA', m.RP, 'measured', measuredVA + (m.RP < VA_AVRT_FLOOR_MS ? ` — under ${VA_AVRT_FLOOR_MS} ms, shorter than any VA recorded in AVRT` : m.RP <= RP_AVNRT_SURFACE_MS ? ` — ≤ ${RP_AVNRT_SURFACE_MS} ms favours typical AVNRT; AVRT this short is unusual but recorded` : ''));
            else set('VA', cl ? Math.min(140, Math.round(0.35 * cl)) : 110, 'typical', 'orthodromic AVRT: the retrograde P sits in the ST segment (VA about 100–150 ms)');
            break;
        case 'pjrt':
            if (oneToOne) set('VA', m.RP, 'measured', measuredVA);
            else set('VA', cl ? Math.round(0.6 * cl) : 300, 'typical', 'PJRT: long RP — the retrograde P falls past mid-cycle');
            set('apVdelay', 35, 'typical', 'the slow pathway is usually posteroseptal: reached a little later');
            break;
        case 'jt':
            if (oneToOne) set('VA', m.RP, 'measured', measuredVA);
            else set('VA', 20, 'typical', 'junctional tachycardia: the retrograde P is near the QRS (often just after it)');
            break;
        case 'avrtAnti':
            if (oneToOne) set('VA', m.RP, 'measured', measuredVA);
            else set('VA', cl ? Math.round(0.5 * cl) : 200, 'typical', 'antidromic AVRT: the return up the His–Purkinje system and the node is long');
            // the pre-excited descent is what is left of the cycle once the return is accounted for
            if (oneToOne && cl && m.RP != null) set('apAnteMs', Math.max(30, Math.round(cl - m.RP)), 'measured', 'atrial end of the pathway → delta wave, from your marks (cycle − RP)');
            break;
        case 'vt': {
            const e = oneToOne ? { VA: m.RP, n: m.coveredCycles } : null;
            if (e) set('ectopicVA', e.VA, 'measured', 'every QRS is followed by a P: 1:1 retrograde conduction, VA from your marks');
            else set('ectopicVA', null, 'typical', m.relation === 'none' ? 'no P marked: drawn without retrograde conduction' : 'the P waves are not locked to the QRS: AV dissociation, no retrograde P');
            break;
        }
        case 'pvc':
        case 'avnodal': {
            const e = ectopicRetroVA(B, A, m.ppCV != null && m.ppCV <= 0.12 ? m.PP : null);
            if (e) set('ectopicVA', e.VA, 'measured', `a P right after ${e.n} ectopic beat(s): retrograde VA from your marks`);
            else if (B.some(b => ectopic(b) || width(b) >= WIDE_QRS_MS)) set('ectopicVA', null, 'typical', 'no retrograde P after the ectopic beats (a P on the sinus rhythm is the sinus P, blocked): the retrograde wave is concealed in the AV node');
            break;
        }
        case 'avb3': {
            const w = m.qrsMs ?? 90;
            if (w >= WIDE_QRS_MS) set('blockBelowHis', 1, 'measured', `wide escape (${w} ms): block below the His, ventricular escape — or mark the escape as LBBB/RBBB for a junctional escape with a bundle-branch block`);
            else set('blockBelowHis', 0, 'measured', `narrow escape (${w} ms): block in the AV node, junctional escape`);
            break;
        }
        case 'flutter':
            if (m.PP) set('fWaveMs', null, m.nP >= 2 ? 'measured' : 'typical', m.nP >= 2 ? `fitted to your ${m.nP} F marks (P–P ${m.PP} ms)` : 'mark at least two F waves');
            break;
        default: break;
    }
    // A long first-degree block: widen the pairing window so the P still conducts
    const { pairs } = pairAtrialToBeats(B, A, { ...DEFAULT_PARAMS, PRmax: 1000 });
    const aT = new Map(A.map(a => [a.id, a.tMs]));
    const maxPR = Math.max(0, ...B.filter(b => pairs.has(b.id)).map(b => b.qrsOnMs - aT.get(pairs.get(b.id))));
    if ((mechanism === 'avnodal' || mechanism === 'pvc' || mechanism === 'at') && maxPR > DEFAULT_PARAMS.PRmax - 50 && cl && maxPR < cl) {
        set('PRmax', Math.ceil((maxPR + 50) / 10) * 10, 'measured', `your longest PR is ${Math.round(maxPR)} ms`);
    }
    // A short PR (pre-excitation, a low atrial focus): narrow the window the other way, so the P that
    // conducts is still read as the one that conducts.
    const prs = B.filter(b => !ectopic(b) && pairs.has(b.id)).map(b => b.qrsOnMs - aT.get(pairs.get(b.id))).filter(x => x >= PR_FLOOR_MS);
    const minPR = prs.length ? Math.min(...prs) : null;
    if ((mechanism === 'avnodal' || mechanism === 'pvc' || mechanism === 'at') && minPR != null && minPR < DEFAULT_PARAMS.PRmin + 20) {
        set('PRmin', Math.max(PR_FLOOR_MS, Math.floor((minPR - 20) / 10) * 10), 'measured', `your shortest PR is ${Math.round(minPR)} ms`);
    }
    return { params, source, why, rhythm: m };
}

// ─── continue the rhythm to the end ─────────────────────────────────────────

const DEDUP_MS = 40;
const close = (x, y) => Math.abs(x - y) <= Math.max(40, 0.08 * Math.max(x, y));
const mod = (i, k) => ((i % k) + k) % k;

/** The shortest repeating unit of the marked beats (1 = every beat alike; 2 = bigeminy …), or null. */
function beatPattern(B) {
    const n = B.length, rr = B.slice(1).map((b, i) => b.qrsOnMs - B[i].qrsOnMs), q = B.map(ectopic);
    if (n < 2) return null;
    for (let k = 1; k <= Math.min(4, n - 1); k++) {
        let ok = true, verified = 0;
        for (let i = 0; i + k < n && ok; i++) if (q[i] !== q[i + k]) ok = false;
        for (let i = 0; i + k < rr.length && ok; i++) { if (!close(rr[i], rr[i + k])) ok = false; verified++; }
        if (k === 1 && ok && rr.length >= 2 && Math.max(...rr) / Math.min(...rr) > 1.15) ok = false;
        if (!ok) continue;
        const unit = q.slice(-k);
        if (k === 1 || verified >= 1 || (unit.some(Boolean) && unit.some(x => !x))) {
            const slot = Array.from({ length: k }, (_, s) => median(rr.filter((_, i) => i % k === s)));
            return { k, rrOfInterval: (i) => slot[mod(i, k)] };
        }
    }
    return null;
}

/**
 * Where the P waves sit in each cycle, learned from the cycles the user marked completely.
 * A cycle runs from one QRS onset (the anchor) to the next (−20 ms, so a P hidden in the QRS belongs
 * to the cycle it starts). Per slot of the beat pattern, the usual number of P per cycle (the mode)
 * wins; cycles with another count are ignored, never turned into extra P. Each position is kept either
 * from the start of the cycle (a retrograde P: fixed RP) or from its end (a conducted P: fixed PR),
 * whichever varies less across the marked cycles — so hand-clicked jitter makes one P, not two.
 */
function pPattern(cycles, k, tolOf) {
    const bySlot = Array.from({ length: k }, () => []);
    for (const c of cycles) bySlot[mod(c.slot, k)].push(c);
    return bySlot.map((cs, s) => {
        if (!cs.length) return [];
        const freq = new Map();
        for (const c of cs) freq.set(c.ps.length, (freq.get(c.ps.length) || 0) + 1);
        const mode = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
        const use = cs.filter(c => c.ps.length === mode);
        const pos = [];
        for (let i = 0; i < mode; i++) {
            const fromStart = use.map(c => c.ps[i] - c.start), fromEnd = use.map(c => c.end - c.ps[i]);
            const spread = (a) => { const m = median(a); return median(a.map(x => Math.abs(x - m))); };
            pos.push(spread(fromEnd) < spread(fromStart) ? { ref: 'end', off: median(fromEnd) } : { ref: 'start', off: median(fromStart) });
        }
        // two positions that land on the same place are one P
        const tol = tolOf(s);
        return pos.filter((p, i) => !pos.slice(0, i).some(q => q.ref === p.ref && Math.abs(q.off - p.off) < tol));
    });
}

/**
 * "Continue to the end": after two or three marked beats, repeat what they show to both ends of the strip
 * (`fromMs` … `untilMs`; in the editor the time before the first grid click is negative).
 * QRS: the marked RR (or the repeating group — bigeminy, 3:2) goes on; an irregular RR is not continued.
 * P: each P keeps its place in the cycle (1:1, 2:1, retrograde P) — or, when the P waves are regular but
 * unrelated to the QRS (AV dissociation, flutter with variable block), they go on at their own P–P.
 * Returns the full mark lists plus what was added and a sentence saying how.
 */
export function continueRhythm(beats = [], atrial = [], untilMs = Infinity, { fromMs = 0 } = {}) {
    const B = beats.slice().sort(byQ), A = atrial.slice().sort(byT);
    const res = { beats: B.slice(), atrial: A.slice(), added: { beats: [], atrial: [] }, qrs: null, p: null, message: '' };
    if (B.length < 2 && A.length < 2) { res.message = 'Mark at least two QRS onsets (and the P waves of those beats) first.'; return res; }
    const msgs = [];
    const r1 = (t) => Math.round(t * 10) / 10;

    // QRS — `all` holds every beat with its index in the pattern (0 = the first marked beat)
    const pat = B.length >= 2 ? beatPattern(B) : null;
    const rrMed = median(B.slice(1).map((b, i) => b.qrsOnMs - B[i].qrsOnMs));
    const reachesEnd = B.length >= 2 && B[B.length - 1].qrsOnMs + 1.5 * rrMed >= untilMs;
    const reachesStart = B.length >= 2 && B[0].qrsOnMs - 1.5 * rrMed <= fromMs;
    const k = pat ? pat.k : 1;
    const rrOf = pat ? pat.rrOfInterval : () => rrMed;
    let all = B.map((b, i) => ({ b, idx: i }));
    let before = 0;
    if (pat) {
        const n = B.length;
        const widthOf = (ect) => median(B.filter(b => ectopic(b) === ect).map(width)) ?? 90;
        const make = (t, idx) => {
            const src = B[mod(idx, k)];
            const w = widthOf(ectopic(src));
            const nb = { id: `c${Math.round(t)}`, qrsOnMs: r1(t), qrsOffMs: r1(t + w), qrsWidthMs: Math.round(w),
                         rPeakMs: Math.round(t + 40), quality: src.quality === 'pvc' ? 'pvc' : 'normal', source: 'user' };
            res.added.beats.push(nb);
            return { b: nb, idx };
        };
        for (let idx = n; ; idx++) {
            const t = all[all.length - 1].b.qrsOnMs + rrOf(idx - 1);
            if (!(t + 40 <= untilMs)) break;
            all.push(make(t, idx));
        }
        for (let idx = -1; ; idx--) {
            const t = all[0].b.qrsOnMs - rrOf(idx);
            if (!(t >= fromMs)) break;
            all.unshift(make(t, idx));
            before++;
        }
        res.qrs = { k, RR: Math.round(rrOf(n - 1)) };
        const nq = res.added.beats.length;
        if (nq) msgs.push(`${nq} QRS ${k === 1 ? `every ${res.qrs.RR} ms` : `repeating your group of ${k} beats`}${before ? ` (${before} before your first beat)` : ''}`);
    } else if (B.length >= 2 && !(reachesEnd && reachesStart)) {
        msgs.push('the RR is irregular, so the QRS were not continued — mark them (or let the beats be found for you)');
    }

    // P
    const tolOf = (s) => Math.max(60, 0.12 * (rrOf(s) || rrMed || 800));
    const withP = (t, tol) => {
        if (!(t >= fromMs && t <= untilMs)) return;
        if (res.atrial.some(a => Math.abs(a.tMs - t) < tol)) return;
        const na = { id: `c${Math.round(t)}`, tMs: r1(t), source: 'user' };
        res.atrial.push(na); res.added.atrial.push(na);
    };
    if (A.length) {
        const pp = A.slice(1).map((a, i) => a.tMs - A[i].tMs);
        const ppMed = median(pp);
        const ppRegular = pp.length >= 1 && pp.every(x => Math.abs(x - ppMed) <= Math.max(30, 0.08 * ppMed));
        const unit = pat ? Array.from({ length: k }, (_, s) => rrOf(s)).reduce((s, x) => s + x, 0) : rrMed;
        const near = (r) => r >= 0.9 && Math.abs(r - Math.round(r)) <= 0.06;
        const lockable = !!pat || (reachesEnd && reachesStart);
        const locked = lockable && B.length >= 2 && (!ppRegular || A.length < 2 || near(unit / ppMed) || near(ppMed / unit));
        if (locked) {
            // The cycles the user marked. A cycle is complete when it lies inside the span of the marked P waves
            // (± half a cycle): edge cycles the user only half marked would otherwise vote for the wrong count.
            const firstP = A[0].tMs, lastP = A[A.length - 1].tMs;
            const cand = [];
            for (let j = -1; j < B.length; j++) {
                const start = j === -1 ? B[0].qrsOnMs - rrOf(-1) : B[j].qrsOnMs;
                const end = j + 1 < B.length ? B[j + 1].qrsOnMs : start + rrOf(j);
                const lo = start - 20, hi = end - 20, half = 0.5 * (end - start);
                const ps = A.filter(a => a.tMs >= lo && a.tMs < hi).map(a => a.tMs);
                if (!ps.length && (hi < firstP - 20 || lo > lastP + 20)) continue;     // no P were marked around here
                if (!ps.length && (j === -1 || j === B.length - 1)) continue;          // open ends: nothing to learn
                cand.push({ slot: j, start, end, ps, complete: lo >= firstP - half && hi <= lastP + half });
            }
            const full = cand.filter(c => c.complete);
            const cycles = full.length ? full : cand.filter(c => c.ps.length);
            const pattern = pPattern(cycles, k, tolOf);
            // every cycle of the strip, marked beats and continued ones, and the one before the first beat
            // (the open cycles before the first beat and after the last are only known when the RR is continued)
            const anchors = all.map((x, i) => ({ start: x.b.qrsOnMs, end: all[i + 1] ? all[i + 1].b.qrsOnMs : x.b.qrsOnMs + rrOf(x.idx), slot: x.idx, open: !all[i + 1] }));
            anchors.unshift({ start: all[0].b.qrsOnMs - rrOf(all[0].idx - 1), end: all[0].b.qrsOnMs, slot: all[0].idx - 1, open: true });
            if (!pat) for (let i = anchors.length - 1; i >= 0; i--) if (anchors[i].open) anchors.splice(i, 1);
            for (const c of anchors) {
                const s = mod(c.slot, k);
                for (const p of pattern[s]) {
                    const t = p.ref === 'start' ? c.start + p.off : c.end - p.off;
                    if (t < c.start - 20 || t >= c.end - 20 + 1e-6) continue;
                    withP(t, tolOf(s));
                }
            }
            res.p = { mode: 'locked' };
            if (res.added.atrial.length) msgs.push(`${res.added.atrial.length} P at the same place in each cycle`);
        } else if (ppRegular && A.length >= 2) {
            const tol = Math.min(DEDUP_MS, 0.25 * ppMed);
            for (let t = A[A.length - 1].tMs + ppMed; t <= untilMs; t += ppMed) withP(t, tol);
            for (let t = A[0].tMs - ppMed; t >= fromMs; t -= ppMed) withP(t, tol);
            res.p = { mode: 'own-rate', PP: Math.round(ppMed) };
            if (res.added.atrial.length) msgs.push(`${res.added.atrial.length} P every ${Math.round(ppMed)} ms, at their own rate (not tied to the QRS)`);
        } else msgs.push('the P waves are irregular and not tied to the QRS, so they were not continued');
    }
    res.beats = all.map(x => x.b);
    res.atrial.sort(byT);
    res.message = res.added.beats.length + res.added.atrial.length
        ? `Continued: ${msgs.join('; ')}.` : msgs.length ? `Nothing added: ${msgs.join('; ')}.` : 'Nothing to add — the marks already reach both ends.';
    return res;
}
