// The maneuvers of the EP laboratory, arrhythmia by arrhythmia, against the live heart (epsim.js): the ledger in
// MANEUVERS.md, held. Entrainment from the RV apex (the response on cessation, PPI − TCL, SA − VA, ΔHA), atrial
// overdrive, the PVC delivered when the His is refractory, adenosine, and overdrive termination.
//
//   node packages/laddergram-core/test/maneuvers.test.mjs
import { makeExample } from '../synth.js';
import { figureMarkers } from '../figures.js';
import { fromReading, createSim } from '../epsim.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

function reading(id, mechanism, params = {}) {
    const rec = makeExample(id);
    const { beats, atrial } = figureMarkers(rec);
    return { beats, atrial, mechanism, params, tiers: ['A', 'AV', 'His', 'V'], durationMs: rec.metadata.truth.durationMs };
}
const R = {
    sinus: reading('sinus', 'avnodal'), chb: reading('chb', 'avb3'),
    avnrt: reading('avnrt', 'avnrt', { VA: 35 }), avnrtAtyp: reading('svtLongRP', 'avnrt', { VA: 270 }),
    avrt: reading('avrt', 'avrt', { VA: 140 }), pjrt: reading('svtLongRP', 'pjrt', { VA: 270, apVdelay: 35 }),
    at: reading('svtLongRP', 'at'),
    anti: reading('wideTachy1to1', 'avrtAnti', { VA: 210, vhMs: 110, apAnteMs: 45 }),
    jt: reading('svtShortRP', 'jt', { VA: 80 }),
    flutter: reading('flutter21', 'flutter', { fWaveMs: 210, fPhaseMs: 100 }), af: reading('af', 'afib'),
    vt: reading('vtDissociation', 'vt'),
};
R.avrtSeptal = { ...R.avrt, ep: { apSite: 'septal' } };
const heart = (input) => createSim(fromReading(input, input.ep));
const tcl = (s, t0, t1) => { const V = s.activations(t0, t1).filter(a => a.kind === 'V'); const rr = V.slice(1).map((v, i) => v.tMs - V[i].tMs); return rr.length ? rr.reduce((a, b) => a + b) / rr.length : null; };
const isA = (a) => a.kind === 'A';

/**
 * Entrain from `site` at TCL − delta for n stimuli, from a heart running for 3 s.
 * @returns { CL, entrained, response, ppiMinusTcl, saMinusVa, dHA, firstVA, resumes }
 */
function entrain(input, { site = 'RVa', n = 10, delta = 30 } = {}) {
    const s = heart(input);
    s.runUntil(3000);
    const CL = tcl(s, 1000, 3000);
    const pre = s.activations(1500, 3000);
    const lastV = pre.filter(a => a.kind === 'V').pop();
    const lastA = pre.filter(a => isA(a) && a.tMs > lastV.tMs - 100).pop();
    const preH = pre.filter(a => a.kind === 'H').pop();
    const VA = lastA ? lastA.tMs - lastV.tMs : null;
    const HAsvt = preH && lastA ? lastA.tMs - preH.tMs : null;
    s.pace({ site, s1Ms: Math.round(CL - delta), n1: n, sense: true });
    s.runUntil(3000 + n * CL + 3000);
    const acts = s.activations(3000, 3000 + n * CL + 3000);
    const S = acts.filter(a => a.kind === 'S');
    const last = S[S.length - 1];
    const paced = acts.filter(a => isA(a) && a.tMs > S[Math.max(0, S.length - 4)].tMs && a.tMs <= last.tMs);
    const duringA = paced.length, captured = paced.filter(a => a.origin === 'fast').length;
    const afterA = acts.filter(a => isA(a) && a.tMs > last.tMs - 5).map(a => a.tMs);
    const afterV = acts.filter(a => a.kind === 'V' && a.tMs > last.tMs + 1).map(a => a.tMs);
    // the response on cessation: from the last paced V on (an A landing on the stimulus is the previous beat's)
    const response = acts.filter(a => (isA(a) && a.tMs > last.tMs) || (a.kind === 'V' && a.tMs >= last.tMs - 0.01)).slice(0, 4).map(a => a.kind).join('-');
    const Hpace = acts.find(a => a.kind === 'H' && a.tMs > S[S.length - 2].tMs && a.tMs < last.tMs);
    const Apace = acts.find(a => isA(a) && a.tMs > S[S.length - 2].tMs && a.tMs < last.tMs);
    // after atrial pacing: the last stimulus's own conduction (its H, then V), and the A that follows that V
    const ownH = site === 'HRA' ? acts.find(a => a.kind === 'H' && a.tMs > last.tMs) : null;
    const ownV = ownH ? acts.find(a => a.kind === 'V' && a.tMs > ownH.tMs) : null;
    const firstVA = ownV ? (acts.find(a => isA(a) && a.tMs > ownV.tMs)?.tMs ?? NaN) - ownV.tMs : null;
    return {
        CL, VA, entrained: duringA >= 3, captured: captured >= 3, response,
        ppiMinusTcl: afterV[0] != null ? afterV[0] - last.tMs - CL : null,
        saMinusVa: afterA[0] != null && VA != null ? afterA[0] - last.tMs - VA : null,
        dHA: Hpace && Apace && HAsvt != null ? Apace.tMs - Hpace.tMs - HAsvt : null,
        firstVA, resumes: tcl(s, last.tMs + 500, last.tMs + 3000),
    };
}
const resumesAt = (r) => r.resumes != null && Math.abs(r.resumes - r.CL) <= 5;

/** One PVC from the RV apex coupled `dc` ms from the moment the His fires; the shift of the next A against the cycle. */
function pvcNearHis(input, dc, site = 'RVa') {
    const s0 = heart(input);
    s0.runUntil(3000);
    const CL = tcl(s0, 1000, 3000);
    const acts = s0.activations(1500, 3000);
    const lastV = acts.filter(a => a.kind === 'V').pop();
    const H = acts.filter(a => a.kind === 'H').pop();
    const hAfterV = ((H.tMs - lastV.tMs) % CL + CL) % CL;
    const c = Math.round(hAfterV + dc);
    const s = heart(input);
    s.runUntil(3000);
    s.pace({ site, s1Ms: c, n1: 1, sense: true });
    s.runUntil(6000);
    const S = s.activations(3000, 6000).filter(a => a.kind === 'S')[0];
    const prevA = s.activations(S.tMs - CL - 50, S.tMs).filter(isA).pop();
    const nextA = s.activations(S.tMs + 1, S.tMs + CL + 200).filter(isA)[0];
    const later = tcl(s, S.tMs + 800, S.tMs + 3000);
    return { shift: prevA && nextA ? nextA.tMs - prevA.tMs - CL : null, noA: !nextA, terminated: later == null || Math.abs(later - CL) > 20 };
}

function adenosine(input) {
    const s = heart(input);
    s.runUntil(3000);
    s.adenosine();
    s.runUntil(20000);
    const win = s.activations(3000, 9000);
    return {
        A: win.filter(a => isA(a) || a.kind === 'f').length, V: win.filter(a => a.kind === 'V').length,
        // the last tachycardia beat: the V before the first pause of the ventricles; did an A follow it?
        endsOnA: (() => { const w = s.activations(2000, 9000); const V = w.filter(a => a.kind === 'V'); const v = V.find((x, j) => (V[j + 1]?.tMs ?? 9000) - x.tMs > 1500); return !!v && w.some(a => isA(a) && a.tMs > v.tMs && a.tMs <= v.tMs + 400); })(),
        later: tcl(s, 14000, 20000), sinusLater: s.activations(14000, 20000).some(a => a.origin === 'sinus'),
        preExcitedLater: s.activations(14000, 20000).filter(a => a.kind === 'V').every(a => String(a.origin).startsWith('pre')),
    };
}

section('entrainment from the RV apex (Abedin 5.5–5.6; Michaud 2001; Ho 2008)');
{
    const e = { avnrt: entrain(R.avnrt), avnrtAtyp: entrain(R.avnrtAtyp), avrt: entrain(R.avrt), pjrt: entrain(R.pjrt), anti: entrain(R.anti) };
    for (const [k, r] of Object.entries(e)) {
        ok(`${k}: entrained at TCL − 30, resumes at its cycle after a V-A-V response`, r.entrained && resumesAt(r) && r.response.startsWith('V-A-V'), `${r.response} resumes ${r.resumes} vs ${r.CL}`);
    }
    ok('typical AVNRT: PPI − TCL > 115 ms (the circuit is above the His, reached through the lower common pathway)', e.avnrt.ppiMinusTcl > 115, `${e.avnrt.ppiMinusTcl}`);
    ok('typical AVNRT: SA − VA > 85 ms', e.avnrt.saMinusVa > 85, `${e.avnrt.saMinusVa}`);
    ok('typical AVNRT: ΔHA > 0 (His and atrium in series under pacing, in parallel in tachycardia)', e.avnrt.dHA > 0, `${e.avnrt.dHA}`);
    ok('atypical AVNRT: PPI − TCL > 115 ms', e.avnrtAtyp.ppiMinusTcl > 115, `${e.avnrtAtyp.ppiMinusTcl}`);
    ok('orthodromic AVRT: PPI − TCL < 60 ms (the ventricle is in the circuit)', e.avrt.ppiMinusTcl != null && e.avrt.ppiMinusTcl < 60, `${e.avrt.ppiMinusTcl}`);
    ok('PJRT: PPI − TCL < 115 ms', e.pjrt.ppiMinusTcl != null && e.pjrt.ppiMinusTcl < 115, `${e.pjrt.ppiMinusTcl}`);
    ok('antidromic AVRT: PPI − TCL < 60 ms', e.anti.ppiMinusTcl != null && e.anti.ppiMinusTcl < 60, `${e.anti.ppiMinusTcl}`);
    // paced until the ventricle has drifted far enough ahead of the focus for the retrograde wave to reach the
    // atrium before it fires — until then the two waves meet in the node and neither gets through
    const at = entrain(R.at, { delta: 30, n: 20 });
    ok('atrial tachycardia: the atrium captured retrogradely once pacing has drifted ahead of the focus, V-A-A-V on cessation, the tachycardia back after the pause of a suppressed focus', at.captured && at.response.startsWith('V-A-A-V') && at.resumes != null && Math.abs(at.resumes - at.CL) <= 12, `${at.response} captured ${at.captured} resumes ${at.resumes}`);
    const fl = entrain(R.flutter);
    ok('flutter: VA block under ventricular pacing, the flutter goes on', fl.response.startsWith('V-A-A') && resumesAt(fl), `${fl.response}`);
    const jt = entrain(R.jt);
    ok('junctional tachycardia: not terminated by ventricular pacing', resumesAt(jt), `${jt.resumes}`);
}

section('atrial overdrive pacing (Abedin Table 5.2)');
{
    for (const [k, va, tol] of [['avnrt', 35, 8], ['avrt', 140, 8], ['pjrt', 270, 15], ['anti', 210, 8]]) {
        const r = entrain(R[k], { site: 'HRA' });
        ok(`${k}: entrained and resumes; the first VA after pacing is the tachycardia's own (${va}${tol > 8 ? ', a little longer over the decremental pathway' : ''})`, r.entrained && resumesAt(r) && Math.abs(r.firstVA - va) <= tol, `first VA ${r.firstVA}, resumes ${r.resumes}`);
    }
    const atyp = entrain(R.avnrtAtyp, { site: 'HRA' });
    ok('atypical AVNRT: resumes after atrial overdrive', resumesAt(atyp));
    const at = entrain(R.at, { site: 'HRA', n: 12 });
    ok('atrial tachycardia: suppressed, resumes after a longer first cycle (the first VA is not the tachycardia\'s)', at.resumes != null && Math.abs(at.resumes - at.CL) <= 12 && at.firstVA > at.CL - 200 + 8, `first VA ${at.firstVA}, CL ${at.CL}, resumes ${at.resumes}`);
    const jt = entrain(R.jt, { site: 'HRA' });
    ok('junctional tachycardia: not terminated by atrial pacing', jt.resumes != null && Math.abs(jt.resumes - jt.CL) <= 12);
}

section('a PVC delivered when the His is refractory (Kusumoto 5.15–5.16; Abedin 5.16, 5.23)');
{
    const shifts = (k, dcs = [-20, 0, 10, 20], site) => dcs.map(dc => pvcNearHis(R[k], dc, site).shift);
    // from the RV apex a septal pathway is near enough: a PVC on the His pulls the atrium in; a left lateral one
    // is far, so only a PVC ahead of the His does — why the base, or the left ventricle, is paced for left-sided
    // pathways (Kusumoto 9.17–9.19)
    ok('orthodromic AVRT, septal pathway: the next atrial activation is advanced by a PVC on the His (−20, 0, +10 ms)', shifts('avrtSeptal', [-20, 0, 10]).every(x => x != null && x <= -10), `${shifts('avrtSeptal')}`);
    ok('orthodromic AVRT, septal pathway: the same PVC from the RV base advances it more than from the apex (differential pacing)', shifts('avrtSeptal', [0], 'RVb')[0] < shifts('avrtSeptal', [0])[0] - 15, `${shifts('avrtSeptal', [0], 'RVb')} vs ${shifts('avrtSeptal', [0])}`);
    ok('orthodromic AVRT, left lateral pathway: advanced by a PVC ahead of the His, not by one on it from the apex — the pathway is far', shifts('avrt', [-20]).every(x => x != null && x <= -15) && shifts('avrt', [0, 20]).every(x => x != null && x > -15 && x <= 15), `${shifts('avrt')}`);
    ok('PJRT: advanced at or before the His; a late one is delayed instead — post-excitation over the decremental pathway (Abedin 5.6)', shifts('pjrt', [-20, 0]).every(x => x != null && x <= -5) && shifts('pjrt', [20]).every(x => x != null && x > 0), `${shifts('pjrt')}`);
    for (const k of ['avnrt', 'avnrtAtyp', 'jt', 'at']) ok(`${k}: the atrium is not reset`, shifts(k).every(x => x != null && Math.abs(x) < 1), `${shifts(k)}`);
    const early = (k, dcs) => dcs.map(dc => ({ dc, ...pvcNearHis(R[k], dc) }));
    ok('typical AVNRT: an earlier PVC reaching the circuit only resets it (with VA 35 ms the fast pathway has always recovered) — never terminated',
        early('avnrt', [-140, -120, -100, -80, -60, -40]).every(r => !r.terminated));
    // Kusumoto 5.17–5.19: termination without reset — the atrium comes on time, then the circuit is found refractory
    const atyp = early('avnrtAtyp', [-180, -160, -140, -120, -100]);
    ok('atypical AVNRT: a very premature PVC terminates it without reset (the last A on time, no reset, then nothing)', atyp.some(r => r.terminated && Math.abs(r.shift) < 1), atyp.map(r => `${r.dc}:${r.shift}${r.terminated ? 'T' : ''}`).join(' '));
    const pj = early('pjrt', [-140, -120, -100, -80]);
    ok('PJRT: a premature PVC blocked in the decremental pathway terminates it without reset', pj.some(r => r.terminated && Math.abs(r.shift) < 1), pj.map(r => `${r.dc}:${r.shift}${r.terminated ? 'T' : ''}`).join(' '));
    const av = early('avrt', [-80, -70, -60, -50]);
    ok('orthodromic AVRT: an earlier PVC blocked in the pathway terminates it without an A (Abedin 5.6)', av.some(r => r.terminated && r.noA), av.map(r => `${r.dc}:${r.shift ?? 'noA'}${r.terminated ? 'T' : ''}`).join(' '));
}

section('adenosine (Kusumoto 5.23, 6.9; Abedin 5.4)');
{
    for (const k of ['avnrt', 'avnrtAtyp', 'avrt', 'pjrt', 'anti']) {
        const r = adenosine(R[k]);
        ok(`${k}: terminated; sinus rhythm later`, r.later != null && r.later > 700 && r.sinusLater, `later CL ${r.later}`);
    }
    ok('orthodromic AVRT ends on an A (block in the node, the last beat still reaching the atrium over the pathway)', adenosine(R.avrt).endsOnA);
    ok('antidromic AVRT: sinus beats conduct pre-excited afterwards', adenosine(R.anti).preExcitedLater);
    for (const [k, cl] of [['at', 460], ['flutter', 420], ['vt', 400], ['jt', 360]]) {
        const r = adenosine(R[k]);
        ok(`${k}: goes on (${k === 'vt' ? 'no node in the circuit' : k === 'jt' ? 'VA block, the focus fires on' : 'AV block, the atrium marches on'})`, r.later != null && Math.abs(r.later - cl) <= 5, `later CL ${r.later}`);
    }
    ok('AT and flutter: a ventricular pause with the atria going on', adenosine(R.at).V <= 2 && adenosine(R.at).A >= 12 && adenosine(R.flutter).V <= 2 && adenosine(R.flutter).A >= 20);
    ok('junctional tachycardia: the ventricles go on, the atria stop', adenosine(R.jt).V >= 12 && adenosine(R.jt).A <= 8);
    ok('AF: the f waves go on above a pause', adenosine(R.af).A >= 20 && adenosine(R.af).V <= 2);
    ok('sinus rhythm: AV block for the duration, the sinus node slower', adenosine(R.sinus).V <= 1 && adenosine(R.sinus).A >= 5);
}

section('overdrive pacing: a re-entrant driver is broken, an automatic focus only suppressed (Kusumoto 14.6; Abedin 5.1–5.2)');
{
    const overdrive = (k, site, frac, driver) => {
        const spec = fromReading(R[k]); const s = createSim(spec); s.runUntil(3000);
        const base = spec.nodes.find(n => n.auto && n.id !== 'SN')?.auto.cycleMs ?? tcl(s, 1000, 3000);
        s.pace({ site, s1Ms: Math.max(150, Math.round(base * frac)), n1: 12, sense: k !== 'af' });
        s.runUntil(3000 + 12 * base + 6000);
        const S = s.activations(3000, 40000).filter(a => a.kind === 'S'); const last = S[S.length - 1];
        const post = s.activations(last.tMs + 1, last.tMs + 6000);
        return { driver: post.filter(driver).length, sinus: post.filter(a => a.origin === 'sinus').length };
    };
    const fl = overdrive('flutter', 'HRA', 0.85, a => a.origin === 'flutter');
    ok('flutter: broken by atrial pacing at 85 % of its cycle, sinus rhythm after', fl.driver === 0 && fl.sinus >= 5, JSON.stringify(fl));
    const vt = overdrive('vt', 'RVa', 0.88, a => a.kind === 'V' && a.origin === 'RV');
    ok('VT: broken by ventricular pacing at 88 % of its cycle, sinus rhythm after', vt.driver === 0 && vt.sinus >= 5, JSON.stringify(vt));
    const vtSlow = entrain(R.vt, { delta: 30 });
    ok('VT: at 30 ms under its cycle it is entrained and resumes', resumesAt(vtSlow), `${vtSlow.resumes}`);
    const at = overdrive('at', 'HRA', 0.85, a => a.origin === 'highRA');
    ok('atrial tachycardia: not broken, resumes', at.driver >= 10, JSON.stringify(at));
    const jt = overdrive('jt', 'HRA', 0.85, a => a.kind === 'H');
    ok('junctional tachycardia: not broken', jt.driver >= 10, JSON.stringify(jt));
    const af = overdrive('af', 'HRA', 0.9, a => a.kind === 'f');
    ok('atrial fibrillation: not pace-terminable', af.driver >= 20, JSON.stringify(af));
}

console.log(`\n${pass} ok, ${fail} fail`);
if (fail) process.exit(1);
