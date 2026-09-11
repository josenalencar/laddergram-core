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
    const rr = rrN.length ? rrN : rrAll;
    const RR = median(rr);
    const rrCV = cv(rr);
    const regularity = rr.length < 2 ? 'unknown' : rrCV <= 0.08 ? 'regular' : rrCV >= 0.15 ? 'irregular' : 'variable';
    const widths = B.filter(b => !ectopic(b)).map(width);
    const qrsMs = median(widths.length ? widths : B.map(width));
    const wideShare = n ? B.filter(b => width(b) >= WIDE_QRS_MS).length / n : 0;
    const out = {
        nBeats: n, nP: A.length, RR: round(RR), rate: RR ? Math.round(60000 / RR) : null, rrCV: +rrCV.toFixed(3), regularity,
        qrsMs: round(qrsMs), wide: wideShare >= 0.6, wideShare: +wideShare.toFixed(2), anyEctopic: B.some(ectopic),
        tachy: RR != null && RR < TACHY_RR_MS,
        relation: A.length ? 'unknown' : 'none', RP: null, PR: null, rpClass: null, rpSD: null, pPerCycle: null,
        PP: null, ppCV: null, prFixed: false, prSD: null, dissociated: false, coveredCycles: 0,
    };
    if (A.length >= 2) {
        const pp = A.slice(1).map((a, i) => a.tMs - A[i].tMs);
        out.PP = round(median(pp)); out.ppCV = +cv(pp).toFixed(3);
    }
    if (!A.length || n < 2) return out;

    // P waves per QRS cycle [qrs_k − 20, qrs_{k+1} − 20): a P inside the QRS counts as RP ≈ 0.
    const first = A[0].tMs, last = A[A.length - 1].tMs;
    const cycles = [];
    for (let k = 0; k < n - 1; k++) {
        if (ectopic(B[k]) || ectopic(B[k + 1])) continue;
        const t0 = B[k].qrsOnMs - 20, t1 = B[k + 1].qrsOnMs - 20;
        if (t1 < first - 20 || t0 > last + 20) continue;           // the user did not mark P waves here
        const ps = A.filter(a => a.tMs >= t0 && a.tMs < t1);
        cycles.push({ k, cl: B[k + 1].qrsOnMs - B[k].qrsOnMs, ps: ps.map(a => a.tMs - B[k].qrsOnMs) });
    }
    out.coveredCycles = cycles.length;
    if (!cycles.length) return out;
    const counts = cycles.map(c => c.ps.length);
    out.pPerCycle = +(counts.reduce((s, x) => s + x, 0) / cycles.length).toFixed(2);
    const ones = cycles.filter(c => c.ps.length === 1);

    // PR of the P that conducted each QRS (nearest preceding P in the pairing window)
    const { pairs } = pairAtrialToBeats(B, A, DEFAULT_PARAMS);
    const aT = new Map(A.map(a => [a.id, a.tMs]));
    const prs = B.filter(b => !ectopic(b) && pairs.has(b.id)).map(b => b.qrsOnMs - aT.get(pairs.get(b.id)));
    out.prSD = prs.length >= 2 ? Math.round(sd(prs)) : null;
    out.prFixed = prs.length >= 2 && out.prSD <= 25 && prs.length >= 0.8 * B.filter(b => !ectopic(b)).length;

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
        && (out.relation === 'V>A' || out.relation === 'variable' || (out.prSD != null && out.prSD > 60));
    if (out.dissociated && out.relation === 'variable') out.relation = 'dissociated';
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
    if (rhythm.afib) return { id: 'afib', reason: 'irregularly irregular RR without organised P — detected automatically' };
    const { rhythm: m, verdicts } = plausibility(beats, atrial);
    const ok = (id) => verdicts[id] && verdicts[id].status !== 'excluded';
    const pick = (ids, reason) => { const id = ids.find(ok); return id ? { id, reason } : null; };
    let s = null;
    if (m.tachy && m.wide && !m.anyEctopic) s = pick(['vt'], 'wide-QRS tachycardia — VT until proven otherwise');
    else if (m.tachy && m.regularity === 'irregular' && m.relation !== '1:1') s = pick(['afib'], 'irregular narrow tachycardia without a P before each QRS');
    else if (m.tachy && m.relation === '1:1') {
        s = m.rpClass === 'veryShort' ? pick(['avnrt', 'jt'], `RP ${m.RP} ms ≤ 70: typical AVNRT (orthodromic AVRT is excluded)`)
          : m.rpClass === 'short' ? pick(['avrt', 'at', 'avnrt'], `short RP (${m.RP} ms > 70): orthodromic AVRT favoured — AT and slow–slow AVNRT remain`)
          : pick(['at', 'avnrt', 'pjrt'], `long RP (RP ${m.RP} > PR ${m.PR}): atrial tachycardia, atypical AVNRT or PJRT`);
    } else if (m.tachy && m.relation === 'none' && m.regularity !== 'irregular') {
        s = pick(['avnrt'], 'regular narrow tachycardia with no P visible — likely hidden in the QRS (typical AVNRT); mark a retrograde P if you see one');
    } else if (m.tachy && m.relation === 'A>V') s = pick(['flutter', 'at'], 'more atrial than ventricular activations — flutter or atrial tachycardia with AV block');
    else if (m.dissociated && m.RR && m.PP && m.RR > m.PP) s = pick(['avb3'], 'regular P waves unrelated to a slower QRS — complete AV block?');
    else if (m.anyEctopic) s = pick(['pvc'], 'ectopic beats marked');
    else if (m.relation === 'A>V') s = pick(['avnodal'], 'P waves without a QRS — AV block (Wenckebach, Mobitz II or 2:1)');
    if (!s) s = pick(['avnodal', 'at', 'jt', 'vt'], m.relation === '1:1' || m.relation === 'none' ? 'P before each QRS' : 'sinus / AV conduction');
    return s ?? { id: 'avnodal', reason: 'default reading' };
}

// ─── timings per mechanism ──────────────────────────────────────────────────

/** The VA after ectopic (PVC-marked or wide) beats, when the user marked a P right after them. */
function ectopicRetroVA(B, A) {
    const vas = [];
    B.forEach((b, i) => {
        if (!(ectopic(b) || width(b) >= WIDE_QRS_MS)) return;
        const next = B[i + 1]?.qrsOnMs ?? Infinity;
        const p = A.find(a => a.tMs >= b.qrsOnMs + 20 && a.tMs < Math.min(next, b.qrsOnMs + 450));
        if (p) vas.push(p.tMs - b.qrsOnMs);
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
            if (oneToOne) set('VA', Math.max(m.RP, VA_AP_MIN_MS + 10), 'measured', measuredVA + (m.RP <= VA_AP_MIN_MS ? ' — raised to the shortest VA an AVRT can have' : ''));
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
            const e = ectopicRetroVA(B, A);
            if (e) set('ectopicVA', e.VA, 'measured', `a P right after ${e.n} ectopic beat(s): retrograde VA from your marks`);
            else if (B.some(b => ectopic(b) || width(b) >= WIDE_QRS_MS)) set('ectopicVA', null, 'typical', 'no P right after the ectopic beats: the retrograde wave is concealed in the AV node');
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
            return { k, rrOfInterval: (i) => slot[i % k] };
        }
    }
    return null;
}

/**
 * "Continue to the end": after two or three marked beats, repeat what they show until `untilMs`.
 * QRS: the marked RR (or the repeating group — bigeminy, 3:2) goes on; an irregular RR is not continued.
 * P: each P keeps its place in the cycle (1:1, 2:1, retrograde P) — or, when the P waves are regular but
 * unrelated to the QRS (AV dissociation, flutter with variable block), they go on at their own P–P.
 * Returns the full mark lists plus what was added and a sentence saying how.
 */
export function continueRhythm(beats = [], atrial = [], untilMs = Infinity) {
    const B = beats.slice().sort(byQ), A = atrial.slice().sort(byT);
    const res = { beats: B.slice(), atrial: A.slice(), added: { beats: [], atrial: [] }, qrs: null, p: null, message: '' };
    if (B.length < 2 && A.length < 2) { res.message = 'Mark at least two QRS onsets (and the P waves of those beats) first.'; return res; }
    const msgs = [];

    // QRS
    const pat = B.length >= 2 ? beatPattern(B) : null;
    const all = B.slice();
    if (pat) {
        const n = B.length;
        const widthOf = (ect) => median(B.filter(b => ectopic(b) === ect).map(width)) ?? 90;
        for (let j = n; ; j++) {
            const t = all[j - 1].qrsOnMs + pat.rrOfInterval(j - 1);
            if (!(t + 40 <= untilMs)) break;
            const src = all[j - pat.k];
            const w = widthOf(ectopic(src));
            const nb = { id: `c${Math.round(t)}`, qrsOnMs: Math.round(t * 10) / 10, qrsOffMs: Math.round((t + w) * 10) / 10, qrsWidthMs: Math.round(w),
                         rPeakMs: Math.round(t + 40), quality: src.quality === 'pvc' ? 'pvc' : 'normal', source: 'user' };
            all.push(nb); res.added.beats.push(nb);
        }
        res.qrs = { k: pat.k, RR: Math.round(pat.rrOfInterval(n - 1)) };
        if (res.added.beats.length) msgs.push(`${res.added.beats.length} QRS ${pat.k === 1 ? `every ${res.qrs.RR} ms` : `repeating your group of ${pat.k} beats`}`);
    } else if (B.length >= 2) msgs.push('the RR is irregular, so the QRS were not continued — mark them (or import the signal)');

    // P
    const withP = (t) => {
        if (!(t >= 0 && t <= untilMs)) return;
        if (res.atrial.some(a => Math.abs(a.tMs - t) < DEDUP_MS)) return;
        const na = { id: `c${Math.round(t)}`, tMs: Math.round(t * 10) / 10, source: 'user' };
        res.atrial.push(na); res.added.atrial.push(na);
    };
    if (A.length) {
        const pp = A.slice(1).map((a, i) => a.tMs - A[i].tMs);
        const ppMed = median(pp);
        const ppRegular = pp.length >= 1 && pp.every(x => Math.abs(x - ppMed) <= Math.max(30, 0.08 * ppMed));
        const unit = pat ? Array.from({ length: pat.k }, (_, s) => pat.rrOfInterval(s)).reduce((s, x) => s + x, 0) : null;
        const near = (r) => r >= 0.9 && Math.abs(r - Math.round(r)) <= 0.06;
        const locked = pat && (!ppRegular || A.length < 2 || near(unit / ppMed) || near(ppMed / unit));
        if (locked) {
            // each P keeps its place in the cycle of the beat before it (the P before the first QRS: in the virtual cycle before)
            const k = pat.k;
            const anchorOf = (t) => { let i = -1; for (let j = 0; j < B.length; j++) if (B[j].qrsOnMs <= t + 20) i = j; return i; };
            const clusters = Array.from({ length: k }, () => []);
            let maxIdx = -1;
            for (const a of A) {
                let i = anchorOf(a.tMs), off;
                if (i < 0) { i = -1; off = a.tMs - (B[0].qrsOnMs - pat.rrOfInterval(((-1 % k) + k) % k)); }
                else off = a.tMs - B[i].qrsOnMs;
                maxIdx = Math.max(maxIdx, i);
                const s = ((i % k) + k) % k;
                const c = clusters[s].find(c => Math.abs(median(c) - off) <= DEDUP_MS);
                if (c) c.push(off); else clusters[s].push([off]);
            }
            for (let j = Math.max(0, maxIdx + 1); j < all.length; j++) {
                for (const c of clusters[j % k]) withP(all[j].qrsOnMs + median(c));
            }
            res.p = { mode: 'locked' };
            if (res.added.atrial.length) msgs.push(`${res.added.atrial.length} P at the same place in each cycle`);
        } else if (ppRegular && A.length >= 2) {
            for (let t = A[A.length - 1].tMs + ppMed; t <= untilMs; t += ppMed) withP(t);
            res.p = { mode: 'own-rate', PP: Math.round(ppMed) };
            if (res.added.atrial.length) msgs.push(`${res.added.atrial.length} P every ${Math.round(ppMed)} ms, at their own rate (not tied to the QRS)`);
        } else msgs.push('the P waves are irregular and not tied to the QRS, so they were not continued');
    }
    res.beats = all;
    res.atrial.sort(byT);
    res.message = res.added.beats.length + res.added.atrial.length
        ? `Continued: ${msgs.join('; ')}.` : msgs.length ? `Nothing added: ${msgs.join('; ')}.` : 'Nothing to add — the marks already reach the end.';
    return res;
}
