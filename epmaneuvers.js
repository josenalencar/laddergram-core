/**
 * What the electrophysiologist would write down: the maneuvers of a live heart (epsim.js) read back from its
 * activations — each pacing train, extrastimulus, adenosine and shock turned into the measurements of the
 * laboratory and the conclusion they support (Kusumoto ch. 3, 5; Abedin §5.5–5.6; MANEUVERS.md is the ledger).
 *
 * Also the baseline study run in an instant on a fresh heart from the same reading: the extrastimulus scan
 * (S1 × 8, S2 down by steps — refractory periods, the AH jump, aberrancy, induction) and the incremental pacing
 * scan (the cycle length at which the node blocks, each way), and the episode record: what was asked of a heart,
 * so the same episode can be replayed and shared.
 *
 * Pure: no DOM, no clock.
 */
import { fromReading, createSim, STIM_SITES } from './epsim.js';
import { cleanEp } from './egm.js';

const r0 = (x) => Math.round(x);
const median = (a) => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); return v.length ? (v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
const isA = (a) => a.kind === 'A';
const isV = (a) => a.kind === 'V';
const isH = (a) => a.kind === 'H';
const SITE_NAMES = { HRA: 'the HRA', RVa: 'the RV apex', RVb: 'the RV base (parahisian)' };
const CONCENTRIC = new Set(['fast', 'slow', 'csOs', 'septal', 'apSeptal']);
const RETRO = new Set(['fast', 'slow', 'apLeftLateral', 'apSeptal', 'apRightLateral']);
const ECCENTRIC = { apLeftLateral: 'eccentric, distal CS first — left lateral', apRightLateral: 'eccentric, HRA first — right free wall', leftAtrium: 'eccentric, distal CS first' };

/** The rhythm over a window: cycle (median V–V), whether it is a tachycardia, the VA and the sequence. */
function rhythmOf(acts, t0, t1) {
    const w = acts.filter(a => a.tMs >= t0 && a.tMs <= t1);
    const V = w.filter(isV), A = w.filter(isA), H = w.filter(isH);
    const rr = V.slice(1).map((v, i) => v.tMs - V[i].tMs);
    const CL = median(rr);
    // VA and HA: to an atrium reached from below (the node, a pathway) — a dissociated sinus P is not a VA
    const retro = (x) => RETRO.has(x.origin);
    const va = V.map(v => { const a = A.find(x => retro(x) && x.tMs > v.tMs && x.tMs < v.tMs + (CL ?? 800)); return a ? a.tMs - v.tMs : null; }).filter(x => x != null);
    const ha = H.map(h => { const a = A.find(x => retro(x) && x.tMs > h.tMs && x.tMs < h.tMs + (CL ?? 800)); return a ? a.tMs - h.tMs : null; }).filter(x => x != null);
    const origin = A.length ? A[A.length - 1].origin : null;
    const regular = rr.length >= 3 && rr.every(x => Math.abs(x - CL) <= 20);   // a suppressed focus's first cycles are a little long
    return { CL, tachy: CL != null && CL < 600 && regular, regular, VA: median(va), HA: median(ha), origin, nA: A.length, nV: V.length };
}

const seqText = (origin) => (origin == null ? '' : CONCENTRIC.has(origin) ? (origin === 'fast' ? 'concentric, His A first' : origin === 'apSeptal' ? 'near-concentric, CS ostium first' : 'concentric, CS ostium first') : ECCENTRIC[origin] ?? origin);

/**
 * Read every maneuver out of a heart's activations.
 * @param acts   sim.activations() — everything recorded (S with site/captured/output, A/H/V, adenosine, shock, iso, bbb)
 * @param o      { now, settleMs = 1500 }: a maneuver is read once `settleMs` have passed since its last stimulus
 * @returns [{ tMs, kind, title, lines: [string], verdict?: string }]  oldest first
 */
export function interpretLog(acts, { now = Infinity, settleMs = 1500 } = {}) {
    const out = [];
    const S = acts.filter(a => a.kind === 'S');
    // trains: stimuli from one site less than 2.5 s apart
    const trains = [];
    for (const s of S) {
        const last = trains[trains.length - 1];
        if (last && last.site === s.site && s.tMs - last.S[last.S.length - 1].tMs < 2500) last.S.push(s);
        else trains.push({ site: s.site, S: [s] });
    }
    let prevDrive = null;
    for (const tr of trains) {
        const end = tr.S[tr.S.length - 1].tMs;
        if (now - end < settleMs) continue;
        const e = readTrain(acts, tr, prevDrive);
        if (!e) continue;
        out.push(e);
        prevDrive = e.kind === 'atrialDrive' ? e.drive ?? null : prevDrive;
    }
    for (const a of acts) {
        if (a.kind === 'adenosine' && now - a.tMs >= 8000) out.push(readAdenosine(acts, a));
        else if (a.kind === 'shock' && now - a.tMs >= settleMs) out.push(readShock(acts, a));
        else if (a.kind === 'iso') out.push({ tMs: a.tMs, kind: 'iso', title: 'Isoproterenol', lines: ['refractory periods and cycles shortened for a minute: the sinus rate rises; what would not start may start now'] });
        else if (a.kind === 'bbb') out.push(readBundle(acts, a));
    }
    return out.sort((x, y) => x.tMs - y.tMs);
}

function readTrain(acts, tr, prevDrive) {
    const S = tr.S, first = S[0], last = S[S.length - 1];
    const before = rhythmOf(acts, first.tMs - 3000, first.tMs - 1);
    // after the train: from 600 ms on, so a suppressed focus's first long cycle does not read as termination
    const after = rhythmOf(acts, last.tMs + 600, last.tMs + 4000);
    const cycles = S.slice(1).map((s, i) => s.tMs - S[i].tMs);
    const s1 = median(cycles.slice(0, Math.max(1, cycles.length - 3))) ?? cycles[0] ?? null;
    const base = { tMs: last.tMs, site: tr.site, n: S.length };
    if (tr.site === 'RVb' && S.some(s => s.output === 'high') && S.some(s => s.output !== 'high')) return readParahisian(acts, tr, base);
    if (S.length === 1) return before.tachy ? readPvc(acts, S[0], before, after, base) : readSingle(acts, S[0], before, base);
    if (before.tachy) return tr.site === 'HRA' ? readAtrialOverdrive(acts, tr, before, after, base) : readEntrainment(acts, tr, before, after, base);
    return readDrive(acts, tr, s1, before, after, base, prevDrive);
}

/** A single stimulus into sinus rhythm: does it conduct, and how. */
function readSingle(acts, s, before, base) {
    const nextH = acts.find(a => isH(a) && a.tMs > s.tMs && a.tMs < s.tMs + 600);
    const nextA = acts.find(a => isA(a) && a.tMs > s.tMs && a.tMs < s.tMs + 600);
    const lines = [];
    if (!s.captured) lines.push('not captured: the chamber was refractory');
    else if (s.site === 'HRA') lines.push(nextH ? `conducted: S–H ${r0(nextH.tMs - s.tMs)} ms` : 'blocked in the AV node (an A without an H)');
    else lines.push(nextA ? `retrograde conduction: S–A ${r0(nextA.tMs - s.tMs)} ms (${seqText(nextA.origin)})` : 'no retrograde atrial activation');
    return { ...base, kind: 'single', title: `One stimulus from ${SITE_NAMES[s.site]}`, lines };
}

/** The PVC in a tachycardia: on the His or not, and what it did to the next A (Kusumoto 5.15–5.19). */
function readPvc(acts, s, before, after, base) {
    const CL = before.CL;
    const Hs = acts.filter(a => isH(a) && a.tMs < s.tMs && a.tMs > s.tMs - 2 * CL && !a.retro);
    const lastH = Hs[Hs.length - 1];
    const As = acts.filter(a => isA(a) && a.tMs <= s.tMs && a.tMs > s.tMs - 2 * CL);
    const prevA = As[As.length - 1];
    const nextA = acts.find(a => isA(a) && a.tMs > s.tMs && a.tMs < s.tMs + CL + 250);
    const nextV = acts.find(a => isV(a) && a.tMs > s.tMs + 1 && a.tMs < s.tMs + CL + 250);
    // where the stimulus fell against the His: the last anterograde His, or the one expected a cycle after it
    let hisRel = null;
    if (lastH) { const expected = lastH.tMs + (s.tMs - lastH.tMs > 0.6 * CL ? CL : 0); hisRel = s.tMs - expected; }
    const onHis = hisRel != null && hisRel >= -25 && hisRel <= 50;
    const timing = hisRel == null ? '' : hisRel >= 0 ? `${r0(hisRel)} ms after the His` : `${r0(-hisRel)} ms before the expected His`;
    const lines = [`coupled ${r0(s.tMs - (acts.filter(a => isV(a) && a.tMs < s.tMs).pop()?.tMs ?? s.tMs))} ms, ${timing}${onHis ? ' — the His is refractory' : ''}`];
    let verdict = null;
    const terminated = !after.tachy || (after.CL != null && Math.abs(after.CL - CL) > 20);
    if (!s.captured) { lines.push('not captured: the ventricle was refractory'); return { ...base, kind: 'pvc', title: 'PVC in tachycardia', lines }; }
    if (terminated && !nextA) {
        lines.push('the tachycardia stopped without an atrial activation');
        verdict = 'termination without an A: the AV node (or a pathway) is in the circuit — AVRT or AVNRT, not an atrial tachycardia';
    } else if (terminated && nextA && prevA && Math.abs(nextA.tMs - prevA.tMs - CL) <= 5) {
        lines.push(`the next A came on time (${r0(nextA.tMs - prevA.tMs)} ms), then the tachycardia stopped`);
        verdict = 'termination without reset: excludes an atrial tachycardia (Kusumoto 5.17)';
    } else if (terminated) {
        lines.push('the tachycardia stopped');
        verdict = 'terminated by a ventricular extrastimulus';
    } else if (nextA && prevA) {
        const d = nextA.tMs - prevA.tMs - CL;
        if (d <= -10) {
            lines.push(`the next A advanced by ${r0(-d)} ms, sequence ${seqText(nextA.origin)}`);
            verdict = onHis ? 'the atrium advanced with the His refractory: an accessory pathway is conducting retrogradely — AVRT (or a bystander pathway)' : 'the atrium reset through the ventricle: the PVC reached the circuit (with the His excitable this does not separate AVRT from AVNRT)';
        } else if (d >= 10) {
            lines.push(`the next A delayed by ${r0(d)} ms`);
            verdict = onHis ? 'post-excitation with the His refractory: a decremental accessory pathway (PJRT-like)' : 'the atrium delayed';
        } else {
            lines.push('the next A on time — no reset');
            verdict = onHis ? 'no reset with the His refractory: does not exclude a pathway far from the pacing site (a left lateral one from the apex); against AVRT over a septal pathway' : 'no reset';
        }
    }
    if (nextV && !terminated) lines.push(`tachycardia continues at ${r0(after.CL)} ms`);
    return { ...base, kind: 'pvc', title: 'PVC in tachycardia', lines, verdict };
}

/** A train from the ventricle into a tachycardia: entrainment and the response on cessation (Abedin 5.5). */
function readEntrainment(acts, tr, before, after, base) {
    const S = tr.S, last = S[S.length - 1], CL = before.CL;
    const s1 = median(S.slice(1).map((s, i) => s.tMs - S[i].tMs));
    const lines = [`${S.length} stimuli at ${r0(s1)} ms (tachycardia ${r0(CL)} ms)`];
    const lastFew = S.slice(-4);
    // captured: the atria followed the last stimuli at a fixed interval, with the paced beat's own sequence
    const sa = lastFew.map(s => { const a = acts.find(x => isA(x) && x.tMs > s.tMs && x.tMs < s.tMs + s1); return a ? a.tMs - s.tMs : null; });
    const fixed = sa.every(x => x != null) && Math.max(...sa) - Math.min(...sa) <= 12;
    const aDuring = acts.filter(a => isA(a) && a.tMs > lastFew[0].tMs && a.tMs <= last.tMs).length;
    const dissociated = !fixed && aDuring >= 2;
    let verdict = null;
    const post = acts.filter(a => (isA(a) && a.tMs > last.tMs) || (isV(a) && a.tMs >= last.tMs - 0.01)).slice(0, 4);
    const four = post.map(a => a.kind).join('-');
    const response = four.startsWith('V-A-A') ? four : four.split('-').slice(0, 3).join('-');
    const terminated = !after.tachy || Math.abs(after.CL - CL) > 20;
    if (!fixed) {
        lines.push(dissociated ? 'the atria did not follow the stimuli (VA dissociation during pacing)' : 'the atria were not captured');
        if (terminated) { lines.push('the tachycardia stopped'); verdict = 'terminated by ventricular pacing without atrial capture'; }
        else verdict = dissociated ? 'the tachycardia went on with the atria dissociated from the paced ventricles: the ventricle is not in the circuit — excludes AVRT; an atrial tachycardia or AVNRT' : 'no atrial capture: the maneuver is uninterpretable';
        if (!terminated) lines.push(`continues at ${r0(after.CL)} ms`);
        return { ...base, kind: 'entrain', title: `Ventricular pacing from ${SITE_NAMES[tr.site]} in tachycardia`, lines, verdict };
    }
    lines.push(`the atria followed at S–A ${r0(median(sa))} ms (${seqText(acts.find(x => isA(x) && x.tMs > last.tMs)?.origin ?? before.origin)})`);
    if (terminated) {
        lines.push(`response on cessation ${response || '—'}: the tachycardia stopped`);
        verdict = 'terminated by overdrive pacing';
        return { ...base, kind: 'entrain', title: `Ventricular pacing from ${SITE_NAMES[tr.site]} in tachycardia`, lines, verdict };
    }
    const nextV = post.find(isV) && post.filter(isV)[1] ? post.filter(isV)[1] : acts.find(a => isV(a) && a.tMs > last.tMs + 1);
    const ppi = nextV ? nextV.tMs - last.tMs : null;
    const saMinusVa = before.VA != null ? median(sa) - before.VA : null;
    // ΔHA: HA of the last paced cycle against HA in tachycardia
    const Hp = acts.filter(a => isH(a) && a.tMs > S[S.length - 2].tMs && a.tMs < last.tMs).pop();
    const Ap = Hp ? acts.find(a => isA(a) && a.tMs > Hp.tMs && a.tMs < last.tMs + s1) : null;
    const dHA = Hp && Ap && before.HA != null ? Ap.tMs - Hp.tMs - before.HA : null;
    lines.push(`response on cessation: ${response}`);
    if (ppi != null) lines.push(`PPI − TCL ${r0(ppi - CL)} ms${saMinusVa != null ? ` · SA − VA ${r0(saMinusVa)} ms` : ''}${dHA != null ? ` · ΔHA ${dHA >= 0 ? '+' : ''}${r0(dHA)} ms` : ''}`);
    lines.push(`tachycardia resumes at ${r0(after.CL)} ms`);
    if (response.startsWith('V-A-A-V')) verdict = 'V-A-A-V: an atrial tachycardia';
    else if (response.startsWith('V-A-V')) {
        if (ppi != null && saMinusVa != null) {
            if (ppi - CL > 115 && saMinusVa > 85) verdict = `V-A-V with PPI − TCL ${r0(ppi - CL)} (> 115) and SA − VA ${r0(saMinusVa)} (> 85): the circuit is above the His — AVNRT${dHA != null && dHA > 0 ? ' (ΔHA > 0 agrees)' : ''}; a junctional tachycardia answers the same way — atrial pacing separates them`;
            else if (ppi - CL < 115 && saMinusVa < 85) verdict = `V-A-V with PPI − TCL ${r0(ppi - CL)} (< 115) and SA − VA ${r0(saMinusVa)} (< 85): the ventricle is in the circuit — orthodromic AVRT${dHA != null && dHA < 0 ? ' (ΔHA < 0 agrees)' : ''}`;
            else verdict = `V-A-V; PPI − TCL ${r0(ppi - CL)} and SA − VA ${r0(saMinusVa)} disagree — indeterminate; a decremental pathway or a distant pacing site can do this`;
        } else verdict = 'V-A-V: AVNRT or AVRT (a junctional tachycardia also answers V-A-V, but is not entrained)';
    }
    return { ...base, kind: 'entrain', title: `Ventricular pacing from ${SITE_NAMES[tr.site]} in tachycardia`, lines, verdict };
}

/** A train from the HRA into a tachycardia: entrained and resumed, the first VA after pacing (Abedin Table 5.2). */
function readAtrialOverdrive(acts, tr, before, after, base) {
    const S = tr.S, last = S[S.length - 1], CL = before.CL;
    const s1 = median(S.slice(1).map((s, i) => s.tMs - S[i].tMs));
    const lines = [`${S.length} stimuli at ${r0(s1)} ms (tachycardia ${r0(CL)} ms)`];
    const terminated = !after.tachy || Math.abs(after.CL - CL) > 20;
    const ownH = acts.find(a => isH(a) && !a.retro && a.tMs > last.tMs && a.tMs < last.tMs + 600);
    const ownV = ownH ? acts.find(a => isV(a) && a.tMs > ownH.tMs && a.tMs < ownH.tMs + 200) : null;
    const firstA = ownV ? acts.find(a => isA(a) && a.tMs > ownV.tMs && a.tMs < ownV.tMs + 900) : null;
    const ah = ownH ? ownH.tMs - last.tMs : null;
    if (ah != null) lines.push(`the last paced beat conducted with S–H ${r0(ah)} ms`);
    else lines.push('the last paced beat did not conduct to the His');
    let verdict = null;
    if (terminated) { lines.push('the tachycardia stopped'); verdict = ownH ? 'terminated by atrial overdrive pacing' : 'terminated: the paced atrium blocked in the node and the circuit was not re-entered'; }
    else {
        const firstVA = ownV && firstA ? firstA.tMs - ownV.tMs : null;
        if (firstVA != null) lines.push(`first VA after pacing ${r0(firstVA)} ms (tachycardia VA ${r0(before.VA)} ms)`);
        lines.push(`tachycardia resumes at ${r0(after.CL)} ms`);
        const gapAfter = firstA && ownV ? firstA.tMs - ownV.tMs : null;
        if (firstVA != null && before.VA != null && Math.abs(firstVA - before.VA) <= 15) verdict = 'the first VA after pacing equals the tachycardia\'s: the paced atrial beat itself came back through the circuit — AVNRT or AVRT, not an atrial tachycardia';
        else if (gapAfter != null && gapAfter > before.VA + 40) verdict = 'the atrium returned late after pacing and not through the ventricle: an atrial tachycardia (a suppressed focus resuming) — or a flutter entrained';
        else verdict = 'resumed after atrial pacing';
    }
    return { ...base, kind: 'overdrive', title: 'Atrial overdrive pacing in tachycardia', lines, verdict };
}

/** A drive (S1 × n, S2–S4) into sinus rhythm: conduction of each stimulus, the AH and its jump, refractoriness, induction. */
function readDrive(acts, tr, s1, before, after, base, prevDrive) {
    const S = tr.S, last = S[S.length - 1];
    const site = tr.site, atrial = site === 'HRA';
    const lines = [];
    const per = S.map((s, i) => {
        const nextS = S[i + 1]?.tMs ?? s.tMs + 700;
        const H = acts.find(a => isH(a) && !a.retro === atrial && a.tMs > s.tMs && a.tMs < nextS);
        const V = acts.find(a => isV(a) && a.tMs > s.tMs + (atrial ? 0 : 1) && a.tMs < nextS);
        const A = acts.find(a => isA(a) && a.tMs > s.tMs && a.tMs < nextS);
        return { s, cpl: i ? s.tMs - S[i - 1].tMs : null, H, V, A };
    });
    const drive = per.slice(0, -1).filter(p => p.cpl == null || Math.abs(p.cpl - s1) <= 5);
    const extras = per.filter(p => p.cpl != null && Math.abs(p.cpl - s1) > 5);
    const label = extras.length ? `S1 × ${S.length - extras.length} at ${r0(s1)} ms, ${extras.map((p, i) => `S${i + 2} ${r0(p.cpl)}`).join(', ')}` : `S1 × ${S.length} at ${r0(s1)} ms`;
    lines.push(`from ${SITE_NAMES[site]}: ${label}`);
    const driveAH = median(drive.map(p => (p.H && p.s.captured ? p.H.tMs - p.s.tMs : null)));
    const driveVA = median(drive.map(p => (p.A && p.s.captured ? p.A.tMs - p.s.tMs : null)));
    if (atrial) {
        const blocked = drive.filter(p => p.s.captured && !p.H).length;
        lines.push(driveAH != null ? `drive: S–H ${r0(driveAH)} ms${blocked ? `, ${blocked} of ${drive.length} blocked in the node` : ''}` : drive.length ? 'drive: no conduction to the His' : '');
    } else {
        const blocked = drive.filter(p => p.s.captured && !p.A).length;
        lines.push(driveVA != null ? `drive: S–A ${r0(driveVA)} ms, ${seqText(drive.find(p => p.A)?.A.origin)}${blocked ? `, ${blocked} of ${drive.length} without an A` : ''}` : drive.length ? 'drive: no retrograde conduction' : '');
    }
    let verdict = null;
    let prevAH = driveAH;
    const drv = { s1, s2: extras[0]?.cpl ?? null, sh: null };
    for (const [i, p] of extras.entries()) {
        const tag = `S${i + 2} ${r0(p.cpl)}`;
        if (!p.s.captured) { lines.push(`${tag}: not captured — the ${atrial ? 'atrial' : 'ventricular'} effective refractory period`); break; }
        if (atrial) {
            if (!p.H) { lines.push(`${tag}: A without an H — blocked in the AV node`); break; }
            const ah = p.H.tMs - p.s.tMs;
            const hv = p.V ? p.V.tMs - p.H.tMs : null;
            const aberrant = p.V && (p.V.origin === 'RBBB' || p.V.origin === 'LBBB');
            lines.push(`${tag}: S–H ${r0(ah)} ms${prevAH != null ? ` (${ah - prevAH >= 0 ? '+' : ''}${r0(ah - prevAH)} on the ${i ? 'previous' : 'drive'})` : ''}${hv != null ? `, HV ${r0(hv)}` : ', no V — blocked below the His'}${aberrant ? `, ${p.V.origin} aberrancy` : ''}`);
            if (aberrant) verdict = `${p.V.origin} aberrancy at ${tag}: the ${p.V.origin === 'RBBB' ? 'right' : 'left'} bundle was still refractory`;
            // the AH jump: 50 ms more than at an S2 10–20 ms longer, in the train before this one
            if (i === 0 && prevDrive && prevDrive.sh != null && Math.abs(prevDrive.s1 - s1) <= 5 && prevDrive.s2 - p.cpl >= 5 && prevDrive.s2 - p.cpl <= 25 && ah - prevDrive.sh >= 50) {
                verdict = `AH jump: S–H ${r0(prevDrive.sh)} ms at S2 ${r0(prevDrive.s2)}, ${r0(ah)} ms at S2 ${r0(p.cpl)} (+${r0(ah - prevDrive.sh)}) — dual AV nodal pathways, the fast one refractory and the slow one conducting`;
            }
            if (i === 0) drv.sh = ah;
            prevAH = ah;
        } else {
            if (!p.A) { lines.push(`${tag}: no atrial activation — retrograde block`); break; }
            lines.push(`${tag}: S–A ${r0(p.A.tMs - p.s.tMs)} ms, ${seqText(p.A.origin)}`);
        }
    }
    if (after.tachy) {
        lines.push(`a tachycardia follows at ${r0(after.CL)} ms, VA ${r0(after.VA)} ms, atrium ${seqText(after.origin)}`);
        verdict = (verdict ? verdict + '; ' : '') + 'induced a tachycardia';
    }
    return { ...base, kind: atrial ? 'atrialDrive' : 'ventricularDrive', title: `${atrial ? 'Atrial' : 'Ventricular'} programmed stimulation`, lines: lines.filter(Boolean), verdict, ...(atrial ? { drive: drv } : {}) };
}

/** Parahisian pacing: S–A with and without His capture (Kusumoto 9.18; Abedin 5.6). */
function readParahisian(acts, tr, base) {
    const S = tr.S;
    const per = S.map((s, i) => {
        const nextS = S[i + 1]?.tMs ?? s.tMs + 700;
        const A = acts.find(a => isA(a) && a.tMs > s.tMs && a.tMs < nextS);
        const H = acts.find(a => isH(a) && a.tMs > s.tMs && a.tMs < nextS);
        return { s, sa: A ? A.tMs - s.tMs : null, sh: H ? H.tMs - s.tMs : null, origin: A?.origin };
    });
    const hi = per.filter(p => p.s.output === 'high' && p.s.captured), lo = per.filter(p => p.s.output !== 'high' && p.s.captured);
    const saHi = median(hi.map(p => p.sa)), saLo = median(lo.map(p => p.sa));
    const shHi = median(hi.map(p => p.sh)), shLo = median(lo.map(p => p.sh));
    const lines = [`with His capture: S–A ${saHi != null ? r0(saHi) : '—'} ms, S–H ${shHi != null ? r0(shHi) : '—'} ms`, `without His capture: S–A ${saLo != null ? r0(saLo) : '—'} ms, S–H ${shLo != null ? r0(shLo) : '—'} ms`];
    let verdict = null;
    if (saHi == null && saLo == null) verdict = 'no retrograde conduction either way';
    else if (saHi == null || saLo == null) verdict = 'retrograde conduction only with His capture: over the node; nothing over a pathway';
    else {
        const dSA = saLo - saHi, dSH = shHi != null && shLo != null ? shLo - shHi : null;
        lines.push(`ΔS–A ${dSA >= 0 ? '+' : ''}${r0(dSA)} ms${dSH != null ? `, ΔS–H ${dSH >= 0 ? '+' : ''}${r0(dSH)} ms` : ''} on losing His capture`);
        if (dSA <= 10) verdict = 'S–A unchanged when the His is no longer captured: the atrium is reached over an accessory pathway — an "accessory pathway pattern" (the maneuver reads the septal region; a left lateral pathway can also give a nodal pattern)';
        else if (dSH != null && Math.abs(dSA - dSH) <= 15) verdict = 'S–A lengthens as much as S–H: the atrium is reached through the His and the AV node — a "nodal pattern"; no pathway';
        else verdict = 'S–A lengthens less than S–H: fusion over the node and a pathway';
    }
    return { ...base, kind: 'parahisian', title: 'Parahisian pacing', lines, verdict };
}

function readAdenosine(acts, a) {
    const before = rhythmOf(acts, a.tMs - 3000, a.tMs);
    const win = acts.filter(x => x.tMs > a.tMs && x.tMs <= a.tMs + 6000);
    const A = win.filter(isA), V = win.filter(isV);
    const later = rhythmOf(acts, a.tMs + 8000, a.tMs + 14000);
    const lines = [];
    let verdict = null;
    if (!before.tachy) {
        lines.push(V.length <= 1 ? 'AV block for a few seconds, the sinus node slower' : 'conduction continued');
        return { tMs: a.tMs, kind: 'adenosine', title: 'Adenosine', lines };
    }
    const cont = later.tachy && Math.abs(later.CL - before.CL) <= 20;
    if (!cont) {
        const lastV = acts.filter(x => isV(x) && x.tMs > a.tMs - 1000 && x.tMs < a.tMs + 3000).pop();
        const aAfter = lastV ? acts.find(x => isA(x) && x.tMs > lastV.tMs && x.tMs <= lastV.tMs + 400) : null;
        lines.push(`the tachycardia stopped, ending on ${aAfter ? 'an A' : 'a V'}`);
        verdict = aAfter ? 'terminated ending on an A: block in the AV node with the atrium still reached — an AV node-dependent tachycardia (AVRT, or AVNRT)' : 'terminated: AV node dependent (AVNRT, AVRT), or a triggered focus';
    } else if (A.length >= 6 && V.length <= 2) {
        lines.push(`atrial activity went on (${A.length} A over 6 s) above a ventricular pause`);
        verdict = 'continues with AV block: an atrial tachycardia, flutter or fibrillation — the node is not in the circuit';
    } else if (V.length >= 6 && A.filter(x => !['sinus', 'highRA', 'leftAtrium', 'csOs', 'septal', 'flutter'].includes(x.origin)).length <= 1 && before.VA != null && before.VA < 200) {
        lines.push('the ventricles went on with no retrograde atrial activation (VA block)');
        verdict = 'continues with VA block: a junctional or ventricular tachycardia';
    } else {
        lines.push('continued unchanged');
        verdict = 'no effect: not node dependent (VT, or a focus)';
    }
    return { tMs: a.tMs, kind: 'adenosine', title: 'Adenosine', lines, verdict };
}

function readShock(acts, a) {
    const before = rhythmOf(acts, a.tMs - 3000, a.tMs);
    const after = rhythmOf(acts, a.tMs + 300, a.tMs + 3300);
    const lines = [before.tachy ? `tachycardia at ${r0(before.CL)} ms before` : 'no tachycardia before'];
    let verdict = null;
    if (before.tachy && (!after.tachy || Math.abs(after.CL - before.CL) > 20)) { lines.push(after.CL ? `rhythm after at ${r0(after.CL)} ms` : 'a pause after'); verdict = 'terminated by the shock: a re-entrant rhythm'; }
    else if (before.tachy) { lines.push(`continues at ${r0(after.CL)} ms`); verdict = 'not terminated by the shock: an automatic focus'; }
    return { tMs: a.tMs, kind: 'shock', title: 'Synchronised shock', lines, verdict };
}

function readBundle(acts, a) {
    const before = rhythmOf(acts, a.tMs - 3000, a.tMs);
    const after = rhythmOf(acts, a.tMs + 300, a.tMs + 3300);
    const which = a.RB && a.LB ? 'both bundles' : a.RB ? 'the right bundle' : a.LB ? 'the left bundle' : 'no bundle';
    const lines = [`${which} held blocked`];
    let verdict = null;
    if (before.tachy && after.tachy && before.VA != null && after.VA != null) {
        const dVA = after.VA - before.VA, dCL = after.CL - before.CL;
        lines.push(`VA ${r0(before.VA)} → ${r0(after.VA)} ms, cycle ${r0(before.CL)} → ${r0(after.CL)} ms`);
        if (dVA >= 25) verdict = `VA and cycle length lengthened by ${r0(dVA)} ms with ${which} blocked: the pathway is on that side — Coumel's sign (orthodromic AVRT over a ${a.LB ? 'left' : 'right'}-sided pathway)`;
        else if (Math.abs(dCL) < 10) verdict = 'cycle unchanged with the bundle blocked: the ventricle on that side is not in the circuit (a septal pathway, AVNRT, or the other side)';
    }
    return { tMs: a.tMs, kind: 'bbb', title: 'Bundle branch block', lines, verdict };
}

// ─── the baseline study, in an instant ──────────────────────────────────────

const freshHeart = (input, ep, { seed } = {}) => createSim(fromReading(input, cleanEp(ep) ?? cleanEp({})), seed != null ? { seed } : undefined);

/**
 * The extrastimulus scan: from the reading's rhythm (shocked to its base rhythm first when it is a tachycardia),
 * a drive S1 × n1 with an S2 stepping down from `from` to `to`; each row what the S2 did.
 * @returns { site, s1Ms, rows: [{ s2Ms, captured, sh, hv, sa, origin, blocked: null|'node'|'infra'|'retro'|'erp', aberrant, induced, cl }],
 *            erp: { chamber, node, retro }, jump: { s2Ms, dAH } | null, induced: s2Ms | null }
 */
export function scanExtrastimulus(input, ep, { site = 'HRA', s1Ms = 600, n1 = 8, from = 500, to = 200, step = 10, output = 'low', seed } = {}) {
    const rows = [];
    let jump = null, induced = null, prevSH = null;
    const erp = { chamber: null, node: null, retro: null };
    for (let s2 = from; s2 >= to; s2 -= step) {
        const s = freshHeart(input, ep, { seed });
        s.runUntil(1500);
        if (rhythmOf(s.activations(0, 1500), 0, 1500).tachy) s.cardiovert();   // the study starts from the base rhythm
        s.runUntil(3000);
        const base = rhythmOf(s.activations(1700, 3000), 1700, 3000);
        s.pace({ site, s1Ms, n1, s2Ms: s2, sense: true, output });
        const horizon = 3000 + (n1 + 1) * s1Ms + s2 + 4000;
        s.runUntil(horizon);
        const acts = s.activations(3000, horizon);
        const S = acts.filter(a => a.kind === 'S');
        const last = S[S.length - 1];
        if (!last) break;
        const after = rhythmOf(acts, last.tMs + 600, last.tMs + 3600);
        const win = (pred) => acts.find(a => pred(a) && a.tMs > last.tMs + 0.5 && a.tMs < last.tMs + 700);
        const H = win(a => isH(a) && (site === 'HRA' ? !a.retro : true)), V = win(isV), A = win(isA);
        const row = { s2Ms: s2, captured: !!last.captured, sh: H ? r0(H.tMs - last.tMs) : null, hv: H && V ? r0(V.tMs - H.tMs) : null,
                      sa: A ? r0(A.tMs - last.tMs) : null, origin: A?.origin ?? null, blocked: null, aberrant: V && (V.origin === 'RBBB' || V.origin === 'LBBB') ? V.origin : null,
                      induced: after.tachy && (!base.tachy || Math.abs(after.CL - base.CL) > 20), cl: after.tachy ? r0(after.CL) : null };
        if (!row.captured) { row.blocked = 'erp'; erp.chamber ??= s2; }
        else if (site === 'HRA' && !H) { row.blocked = 'node'; erp.node ??= s2; }
        else if (site === 'HRA' && H && !V) row.blocked = 'infra';
        else if (site !== 'HRA' && !A) { row.blocked = 'retro'; erp.retro ??= s2; }
        if (site === 'HRA' && row.sh != null && prevSH != null && row.sh - prevSH >= 50 && !jump) jump = { s2Ms: s2, dAH: row.sh - prevSH };
        if (row.captured && site === 'HRA' && H) prevSH = row.sh;
        if (row.induced && induced == null) induced = s2;
        rows.push(row);
        if (!row.captured) break;                                    // below the chamber's ERP nothing more is learnt
    }
    return { site, s1Ms, n1, rows, erp, jump, induced };
}

/**
 * Incremental pacing: S1 stepping down from `from` to `to`, twelve beats at each — the cycle length at which the
 * AV node (from the HRA) or the retrograde conduction (from the ventricle) stops following 1:1.
 * @returns { site, rows: [{ s1Ms, ratio, sh | sa, wenckebach, induced }], blockCL, inducedAt }
 */
export function scanDrive(input, ep, { site = 'HRA', from = 600, to = 250, step = 20, n = 12, output = 'low', seed } = {}) {
    const rows = [];
    let blockCL = null, inducedAt = null;
    for (let s1 = from; s1 >= to; s1 -= step) {
        const s = freshHeart(input, ep, { seed });
        s.runUntil(1500);
        if (rhythmOf(s.activations(0, 1500), 0, 1500).tachy) s.cardiovert();
        s.runUntil(3000);
        const base = rhythmOf(s.activations(1700, 3000), 1700, 3000);
        s.pace({ site, s1Ms: s1, n1: n, sense: true, output });
        const horizon = 3000 + (n + 2) * s1 + 4000;
        s.runUntil(horizon);
        const acts = s.activations(3000, horizon);
        const S = acts.filter(a => a.kind === 'S').slice(-6);
        if (S.length < 6) break;
        const after = rhythmOf(acts, S[5].tMs + 600, S[5].tMs + 4000);
        const induced = after.tachy && (!base.tachy || Math.abs(after.CL - base.CL) > 20);
        const conducted = S.map((st, i) => {
            const nextS = S[i + 1]?.tMs ?? st.tMs + s1;
            const x = acts.find(a => (site === 'HRA' ? isH(a) && !a.retro : isA(a)) && a.tMs > st.tMs + 0.5 && a.tMs < nextS + 0.5);
            return x ? x.tMs - st.tMs : null;
        });
        const okN = conducted.filter(x => x != null).length;
        const delays = conducted.filter(x => x != null);
        const row = { s1Ms: s1, ratio: okN / S.length, [site === 'HRA' ? 'sh' : 'sa']: delays.length ? r0(median(delays)) : null,
                      wenckebach: delays.length >= 3 && Math.max(...delays) - Math.min(...delays) >= 15 && okN < S.length, captured: true,
                      induced, cl: induced ? r0(after.CL) : null };
        // a stimulus landing on an echo beat is not captured; only a train mostly lost to refractoriness ends the scan
        row.captured = S.filter(x => x.captured).length >= 4;
        rows.push(row);
        if (okN < S.length && blockCL == null) blockCL = s1;
        if (induced) { inducedAt = s1; break; }                        // the study stops here: a tachycardia is running
        if (okN === 0 || !row.captured) break;
    }
    return { site, rows, blockCL, inducedAt };
}

// ─── the episode ────────────────────────────────────────────────────────────

export const EPISODE_KIND = 'laddergram-ep-episode';

/** Everything needed to replay a live heart: the reading, the settings, the seed and what was asked of it. */
export function episodeJson(sim, { input, ep, title = null, seed = 7 } = {}) {
    return {
        kind: EPISODE_KIND, version: 1, title, savedAt: new Date().toISOString(),
        input: { beats: input.beats, atrial: input.atrial, mechanism: input.mechanism, params: input.params ?? {}, tiers: input.tiers ?? null, durationMs: input.durationMs ?? null },
        ep: cleanEp(ep) ?? cleanEp({}), seed, untilMs: sim.now, actions: sim.actions,
    };
}

/** A heart replaying an episode: the same reading, seed and actions — run it to `untilMs` and it is where it was. */
export function replayEpisode(json, { runToEnd = true } = {}) {
    if (!json || json.kind !== EPISODE_KIND || !json.input) throw new Error('not a laddergram EP episode');
    const spec = fromReading(json.input, json.ep);
    const sim = createSim(spec, { seed: json.seed ?? 7, actions: json.actions ?? [] });
    if (runToEnd && Number.isFinite(json.untilMs)) sim.runUntil(json.untilMs);
    return sim;
}

export { STIM_SITES };
