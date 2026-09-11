// What the marks say about the rhythm, before any ladder is drawn:
//   measureRhythm     — RR, QRS width, the A:V relation, RP / PR (from P and QRS onsets only)
//   plausibility      — which readings the marks rule out, which are unlikely, and why
//   suggestReading    — a first reading that is never one the marks exclude
//   plausibleParams   — per-mechanism timings: measured from the marks when they can be, typical otherwise
//   continueRhythm    — extend a pattern of 2–3 marked beats (and their P waves) to the end of the strip
// Pure functions; the thresholds are the textbook ones (Josephson; Issa, Miller & Zipes).
import { DEFAULT_PARAMS, MECHANISMS, pairAtrialToBeats } from './engine.js';

export const VA_AP_MIN_MS = 70;      // VA ≤ 70 ms: too short for a circuit through the ventricle and a pathway
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
 */
export function measureRhythm(beats = [], atrial = []) {
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
        PP: null, ppCV: null, prFixed: false, prSD: null, dissociated: false, coveredCycles: 0,
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
    const { pairs } = pairAtrialToBeats(B, A, DEFAULT_PARAMS);
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
    out.dissociated = A.length >= 3 && out.ppCV != null && out.ppCV <= 0.12 && !out.prFixed && out.relation !== '1:1'
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

/** Every mechanism → { status: 'ok' | 'caution' | 'excluded', reasons: [] }, plus the rhythm and a one-line summary. */
export function plausibility(beats = [], atrial = []) {
    const m = measureRhythm(beats, atrial);
    const v = Object.fromEntries(MECHANISMS.map(x => [x.id, { status: 'ok', reasons: [] }]));
    const exclude = (ids, why) => ids.forEach(id => { v[id].status = 'excluded'; v[id].reasons.push(why); });
    const caution = (ids, why) => ids.forEach(id => { if (v[id].status !== 'excluded') v[id].status = 'caution'; v[id].reasons.push(why); });

    if (m.nBeats < 2) return { rhythm: m, verdicts: v, summary: 'Mark at least two QRS onsets.' };

    // QRS width
    if (!m.wide) {
        exclude(['avrtAnti'], `narrow QRS (${m.qrsMs} ms): antidromic AVRT is maximally pre-excited, so its QRS is wide`);
        caution(['vt'], `narrow QRS (${m.qrsMs} ms): VT is wide, except fascicular VT (QRS 100–140 ms)`);
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
            exclude(['avrt'], `${rp}: a VA ≤ ${VA_AP_MIN_MS} ms is too short for orthodromic AVRT — the ventricle and the pathway must be activated before the atrium`);
            exclude(['pjrt'], `${rp}: PJRT has a long RP`);
            caution(['at'], `${rp}: an atrial tachycardia would need a PR almost as long as the cycle`);
        } else if (m.rpClass === 'short') {
            exclude(['pjrt'], `${rp}: short RP — PJRT has a long RP`);
            caution(['avnrt'], `${rp}: VA > ${VA_AP_MIN_MS} ms — typical AVNRT unlikely (slow–slow AVNRT possible)`);
        } else if (m.rpClass === 'long') {
            exclude(['avrt'], `${rp}: long RP — a fast accessory pathway returns early (short RP); a long-RP orthodromic tachycardia is PJRT`);
            v.avnrt.reasons.push(`${rp}: long RP — only the atypical (fast–slow) form; typical AVNRT is excluded`);
            caution(['jt'], `${rp}: long RP — junctional tachycardia usually has a short VA`);
        }
        if (m.prFixed) exclude(['avb3'], 'every QRS follows its P at a fixed PR: conduction, not complete block');
        caution(['hisExtra'], 'no P fails to conduct');
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

    return { rhythm: m, verdicts: v, summary: rhythmSummary(m) };
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
export function suggestReading(beats = [], atrial = [], rhythm = {}) {
    const { rhythm: m, verdicts } = plausibility(beats, atrial);
    const ok = (id) => verdicts[id] && verdicts[id].status !== 'excluded';
    const pick = (ids, reason) => { const id = ids.find(ok); return id ? { id, reason } : null; };
    const flutterLike = m.relation !== 'none' && m.nP >= 3 && m.ppCV != null && m.ppCV <= 0.1 && m.PP >= 160 && m.PP <= 350;
    let s = null;
    // an automatic AF call (the viewer's gate) yields to ectopy, a bigeminal pattern or 1:1 P waves
    if (rhythm.afib && !m.afVeto) s = pick(['afib'], 'irregularly irregular RR without organised P — detected automatically');
    else if (m.tachy && m.wide) s = pick(['vt'], 'wide-QRS tachycardia — VT until proven otherwise');
    else if (m.dissociated && m.RR && m.PP && m.RR > m.PP) s = pick(['avb3'], 'regular P waves unrelated to a slower QRS — complete AV block?');
    else if (m.tachy && m.regularity === 'irregular' && m.relation !== '1:1' && !m.afVeto && !flutterLike) s = pick(['afib'], 'irregular narrow tachycardia without a P before each QRS');
    else if (m.tachy && m.relation === '1:1') {
        s = m.rpClass === 'veryShort' ? pick(['avnrt', 'jt'], `RP ${m.RP} ms ≤ 70: typical AVNRT (orthodromic AVRT is excluded)`)
          : m.rpClass === 'short' ? pick(['avrt', 'at', 'avnrt'], `short RP (${m.RP} ms > 70): orthodromic AVRT favoured — AT and slow–slow AVNRT remain`)
          : pick(['at', 'avnrt', 'pjrt'], `long RP (RP ${m.RP} > PR ${m.PR}): atrial tachycardia, atypical AVNRT or PJRT`);
    } else if (m.tachy && (m.relation === 'none' || m.nP < Math.max(2, 0.3 * m.nBeats)) && m.regularity !== 'irregular') {
        s = pick(['avnrt'], 'regular narrow tachycardia with no P visible — likely hidden in the QRS (typical AVNRT); mark a retrograde P if you see one');
    } else if (m.relation === 'A>V' && flutterLike && 60000 / m.PP >= 240) {
        s = pick(['flutter'], `regular atrial waves every ${m.PP} ms (${Math.round(60000 / m.PP)}/min) — atrial flutter with ${Math.round(m.pPerCycle)}:1 conduction`);
    } else if (m.tachy && m.relation === 'A>V') s = pick(['at', 'flutter'], 'more atrial than ventricular activations — atrial tachycardia or flutter with AV block');
    else if (m.anyEctopic) s = pick(['pvc'], 'ectopic beats marked');
    else if (m.regularity === 'irregular' && m.relation === 'none' && m.nBeats >= 6 && !m.afVeto) s = pick(['afib'], 'irregularly irregular RR and no P marked');
    else if (m.relation === 'A>V') s = pick(['avnodal'], 'P waves without a QRS — AV block (Wenckebach, Mobitz II or 2:1)');
    if (!s) s = pick(['avnodal', 'at', 'jt', 'vt'], m.relation === '1:1' || m.relation === 'none' ? 'P before each QRS' : 'sinus / AV conduction');
    return s ?? { id: 'avnodal', reason: 'default reading' };
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
            if (oneToOne) set('VA', m.RP, 'measured', measuredVA + (m.RP <= VA_AP_MIN_MS ? ` — at or below ${VA_AP_MIN_MS} ms, shorter than the usual rules allow for AVRT` : ''));
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
