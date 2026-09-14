// The live heart of the EP view (epsim.js) and its recorder (eplive.js), PREMISES.md §7. Three promises:
// a network built from a reading first beats exactly as the static figure draws it; it answers the stimulator
// and a shock the way the textbooks describe for that mechanism; and the sweep writes it on the screen.
//
//   node packages/laddergram-core/test/epsim.test.mjs
import { makeExample } from '../synth.js';
import { figureMarkers } from '../figures.js';
import { egmSchedule, channelsOf, DEFAULT_EP, EGM_COLORS } from '../egm.js';
import { fromReading, createSim, conductionDelay, fitPath } from '../epsim.js';
import { liveChannels, surfaceAt, createSampler, createSweep, LIVE_SURFACE } from '../eplive.js';
import { LABEL_W, PX_PER_MM } from '../render.js';
import { makeRecorder } from './mockCanvas.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

function reading(id, mechanism, params = {}, { conduction = null, tiers = ['A', 'AV', 'V'] } = {}) {
    const rec = makeExample(id);
    const { beats, atrial } = figureMarkers(rec);
    if (conduction) for (const b of beats) b.conduction = conduction;
    return { beats, atrial, mechanism, params, tiers, durationMs: rec.metadata.truth.durationMs };
}
const heart = (input, ep = DEFAULT_EP, seed) => createSim(fromReading(input, ep), seed != null ? { seed } : undefined);
const AHV = (a) => a.kind === 'A' || a.kind === 'H' || a.kind === 'V';
const label = (a) => `${a.kind}${a.prime ? "'" : ''}${a.kind === 'V' ? `(${a.origin})` : ''}@${a.tMs}`;
const rrOf = (acts) => { const V = acts.filter(a => a.kind === 'V'); return V.slice(1).map((v, i) => v.tMs - V[i].tMs); };

/** The static figure's activations and the simulation's over the same time: the first difference, or null. */
function replay(input, ep = DEFAULT_EP, untilMs = Infinity) {
    const spec = fromReading(input, ep);
    const sim = createSim(spec);
    sim.runUntil(input.durationMs);
    const end = Math.min(untilMs, input.durationMs);
    const st = egmSchedule(input, ep).activations.filter(a => AHV(a) && a.tMs >= spec.t0Ms && a.tMs <= end);
    const last = st.length ? st[st.length - 1].tMs + 1 : 0;
    const sa = sim.activations(spec.t0Ms, last).filter(AHV);
    const n = Math.max(st.length, sa.length);
    for (let i = 0; i < n; i++) {
        const a = st[i], b = sa[i];
        if (!a || !b || a.kind !== b.kind || Math.abs(a.tMs - b.tMs) > 0.5 || !!a.prime !== !!b.prime || (a.kind === 'V' && a.origin !== b.origin)) {
            return { diff: `#${i}: static ${a ? label(a) : '—'} vs live ${b ? label(b) : '—'}`, st, sa, sim };
        }
    }
    return { diff: null, st, sa, sim };
}

section('conduction');
{
    const p = fitPath(180, 500, 150);
    ok('a fitted path conducts in the delay it was fitted to', Math.abs(conductionDelay(p, 500) - 180) < 1e-9);
    ok('decremental: the less it has recovered, the slower', conductionDelay(p, 200) > conductionDelay(p, 300) && conductionDelay(p, 300) > conductionDelay(p, 500));
    ok('fully recovered: the floor', Math.abs(conductionDelay(p, 1e6) - p.min) < 1e-9 && p.min > 0);
}

section('the first beats of the live heart are the static figure');
{
    const CASES = [
        ['sinus', 'sinus', 'avnodal'],
        ['first-degree block', 'avb1', 'avnodal'],
        ['Wenckebach (the periods, not only the ratio)', 'wenckebach', 'avnodal'],
        ['2:1 in the node', 'twoToOne', 'avnodal'],
        ['2:1 below the His', 'twoToOne', 'avnodal', { blockBelowHis: 1 }],
        ['Mobitz II with RBBB (the pattern)', 'mobitz2', 'avnodal', {}, { conduction: 'RBBB', tiers: ['A', 'AV', 'His', 'RBB', 'LBB', 'V'] }],
        ['typical AVNRT', 'avnrt', 'avnrt', { VA: 35 }],
        ['atypical AVNRT', 'svtLongRP', 'avnrt', { VA: 270 }],
        ['orthodromic AVRT', 'avrt', 'avrt', { VA: 140 }],
        ['PJRT', 'svtLongRP', 'pjrt', { VA: 270, apVdelay: 35 }],
        ['antidromic AVRT', 'wideTachy1to1', 'avrtAnti', { VA: 210, vhMs: 110, apAnteMs: 45 }],
        ['junctional tachycardia', 'svtShortRP', 'jt', { VA: 80 }],
        ['atrial tachycardia', 'svtShortRP', 'at'],
        ['complete block, junctional escape', 'chb', 'avb3'],
        ['complete block, ventricular escape', 'chbVent', 'avb3'],
        ['flutter 2:1', 'flutter21', 'flutter', { fWaveMs: 210, fPhaseMs: 100 }],
        ['flutter 4:1', 'flutter41', 'flutter', { fWaveMs: 220, fPhaseMs: 150 }],
        ['ventricular bigeminy (the compensatory pause)', 'pvcBigeminy', 'pvc'],
        ['concealed His extrasystoles', 'twoToOneIvcd', 'hisExtra', { hPrimeLead: 150 }],
    ];
    for (const [name, id, mech, params = {}, extra = {}] of CASES) {
        const { diff, st } = replay(reading(id, mech, params, extra));
        ok(`${name}: ${st.length} activations, the same, within half a millisecond`, !diff && st.length > 10, diff ?? '');
    }
    const vt = replay(reading('vtDissociation', 'vt'), DEFAULT_EP, 3450);
    ok('VT with AV dissociation: the same until the first capture (captures are left to the network)', !vt.diff, vt.diff ?? '');
    const septal = replay(reading('avrt', 'avrt', { VA: 140 }), { ...DEFAULT_EP, apSite: 'septal' });
    ok('orthodromic AVRT over a posteroseptal pathway: the same beats, retrograde up the septum',
       !septal.diff && septal.sa.filter(a => a.kind === 'A').every(a => a.origin === 'apSeptal'), septal.diff ?? '');
    const lv = replay(reading('pvcBigeminy', 'pvc'), { ...DEFAULT_EP, vOrigin: 'LV' });
    ok('a PVC set to the LV comes from the LV', !lv.diff && lv.sa.some(a => a.kind === 'V' && a.origin === 'LV'), lv.diff ?? '');
    const af = heart(reading('af', 'afib'));
    af.runUntil(20000);
    const rr = rrOf(af.activations(0, 20000));
    const mean = rr.reduce((x, y) => x + y, 0) / rr.length, sd = Math.sqrt(rr.reduce((x, y) => x + (y - mean) ** 2, 0) / rr.length);
    ok('AF: an irregular ventricular response', rr.length > 15 && sd > 20, `sd ${sd.toFixed(1)} over ${rr.length} RR`);
    ok('AF: fibrillation waves, no organised atrial activation', af.activations(0, 20000).filter(a => a.kind === 'f').length > 50 && !af.activations(0, 20000).some(a => a.kind === 'A'));
}

/** After a drive of S1 × 8 and an S2, the time from S2 to the His (null: blocked), and what followed. */
function extrastimulus(input, s2, { site = 'HRA', s1 = 600, shockFirst = false } = {}) {
    const s = heart(input);
    s.runUntil(2000);
    if (shockFirst) s.cardiovert();
    s.runUntil(4000);
    s.pace({ site, s1Ms: s1, n1: 8, s2Ms: s2 });
    s.runUntil(16000);
    const S = s.activations(4000, 16000).filter(a => a.kind === 'S');
    const last = S[S.length - 1], prev = S[S.length - 2];
    const hAfter = (t) => s.activations(t + 1, t + 700).find(a => a.kind === 'H');
    const h2 = hAfter(last.tMs), h1 = hAfter(prev.tMs);
    return { sim: s, S, sH2: h2 && h2.tMs < last.tMs + 700 ? h2.tMs - last.tMs : null, sH1: h1 ? h1.tMs - prev.tMs : null, rrLate: rrOf(s.activations(12000, 16000)) };
}
const sustained = (rr, cl) => rr.length >= 10 && rr.every(x => Math.abs(x - cl) <= 5);

section('the AV node under the stimulator');
{
    const sinus = reading('sinus', 'avnodal');
    const s400 = extrastimulus(sinus, 400), s320 = extrastimulus(sinus, 320), s300 = extrastimulus(sinus, 300);
    ok('an S2 of 400 conducts with a longer delay than the drive (decremental)', s400.sH2 != null && s400.sH2 > s400.sH1 + 20, `${s400.sH1} → ${s400.sH2}`);
    ok('S2 320 still conducts, later again', s320.sH2 != null && s320.sH2 > s400.sH2);
    ok('S2 300 finds the node refractory (AV nodal ERP 300–320 ms at 600)', s300.sH2 == null);
    const fast = heart(sinus);
    fast.runUntil(2000);
    fast.pace({ site: 'HRA', s1Ms: 400, continuous: true });
    fast.runUntil(9000);
    const S = fast.activations(3000, 9000).filter(a => a.kind === 'S'), V = fast.activations(3000, 9400).filter(a => a.kind === 'V');
    ok('atrial pacing at 400: every stimulus captures the atrium and conducts 1:1', S.length > 10 && S.every(x => fast.activations(x.tMs, x.tMs).some(a => a.kind === 'A')) && Math.abs(V.length - S.length) <= 1);
    const w = heart(reading('wenckebach', 'avnodal'));
    w.runUntil(2000);
    w.pace({ site: 'HRA', s1Ms: 500, continuous: true });
    w.runUntil(9000);
    const wS = w.activations(3000, 9000).filter(a => a.kind === 'S').length, wV = w.activations(3000, 9000).filter(a => a.kind === 'V').length;
    ok('a Wenckebach node paced faster blocks more', wV / wS <= 0.6, `${wV}/${wS}`);
    const chb = heart(reading('chb', 'avb3'));
    chb.runUntil(2000);
    const escape = fromReading(reading('chb', 'avb3')).meta.CL;
    chb.pace({ site: 'HRA', s1Ms: 600, continuous: true });
    chb.runUntil(12000);
    ok('complete block: atrial pacing does not reach the ventricle, the escape keeps its rate',
       rrOf(chb.activations(3000, 12000)).every(x => Math.abs(x - escape) <= 1));
    const rv = heart(sinus);
    rv.runUntil(2000);
    rv.pace({ site: 'RVa', s1Ms: 600, continuous: true, sense: false });
    rv.runUntil(7000);
    rv.cancelPacing();
    rv.runUntil(10000);
    const paced = rv.activations(3000, 7000).filter(a => a.kind === 'V' && a.origin === 'RV');
    const retro = rv.activations(3000, 7000).filter(a => a.kind === 'A' && a.origin === 'fast');
    ok('ventricular pacing: retrograde conduction over the fast pathway, a concentric A after every paced beat', paced.length >= 6 && retro.length >= paced.length - 1);
    ok('pacing stopped: no stimulus after, sinus rhythm back', !rv.activations(7010, 10000).some(a => a.kind === 'S') && rv.activations(7600, 10000).some(a => a.kind === 'A' && a.origin === 'sinus'));
}

section('AVNRT');
{
    const input = reading('avnrt', 'avnrt', { VA: 35 });
    const CL = fromReading(input).meta.CL;
    const s350 = extrastimulus(input, 350, { shockFirst: true }), s330 = extrastimulus(input, 330, { shockFirst: true });
    ok('dual pathways: the AH jumps by 50 ms or more between S2 350 and 330', s350.sH2 != null && s330.sH2 != null && s330.sH2 - s350.sH2 >= 50, `${s350.sH2} → ${s330.sH2}`);
    for (const s2 of [300, 280]) ok(`S2 ${s2} (down the slow pathway): AVNRT induced and sustained at its CL (${CL} ms)`, sustained(extrastimulus(input, s2, { shockFirst: true }).rrLate, CL));
    ok('S2 340 (the fast pathway still conducts): no tachycardia', !sustained(extrastimulus(input, 340, { shockFirst: true }).rrLate, CL));
    ok('S2 220 (both pathways refractory): no tachycardia', !sustained(extrastimulus(input, 220, { shockFirst: true }).rrLate, CL));
    const shock = heart(input);
    shock.runUntil(3000);
    const acts = shock.step(0);
    shock.cardiovert();
    shock.runUntil(9000);
    const after = shock.activations(3001, 9000);
    ok('a shock ends it: sinus rhythm at the reading\'s own rate, no retrograde P', acts.length === 0 && after.some(a => a.kind === 'A')
       && !after.some(a => a.kind === 'A' && a.origin !== 'sinus') && rrOf(after).slice(1).every(x => Math.abs(x - fromReading(input).meta.PP) <= 1));
    ok('the shock is on the record', shock.activations(2999, 3001).some(a => a.kind === 'shock'));
    const ent = heart(input);
    ent.runUntil(3000);
    ent.pace({ site: 'RVa', s1Ms: 320, n1: 10 });
    ent.runUntil(12000);
    const S = ent.activations(3000, 12000).filter(a => a.kind === 'S');
    const retro = ent.activations(S[0].tMs, S[S.length - 1].tMs + 150).filter(a => a.kind === 'A');
    ok('RV pacing faster than the tachycardia: the atrium follows the pacing, retrograde over the fast pathway',
       S.length === 10 && retro.length >= 9 && retro.every(a => a.origin === 'fast'));
    ok('pacing stopped: the tachycardia goes on at its CL (a V-A-V response)', sustained(rrOf(ent.activations(S[S.length - 1].tMs + 1500, 12000)).concat(rrOf(ent.activations(8000, 12000))).slice(0, 10), CL));
}

section('orthodromic AVRT');
{
    const input = reading('avrt', 'avrt', { VA: 140 });
    const CL = fromReading(input).meta.CL;
    const s = heart(input);
    s.runUntil(3000);
    s.cardiovert();
    s.runUntil(12000);
    ok('after a shock, sinus beats do not echo up the pathway', !s.activations(3001, 12000).some(a => a.kind === 'A' && a.origin !== 'sinus'));
    ok('an atrial S2 that lengthens the AV delay (300) induces it', sustained(extrastimulus(input, 300, { shockFirst: true }).rrLate, CL));
    ok('an atrial S2 of 400 does not', !sustained(extrastimulus(input, 400, { shockFirst: true }).rrLate, CL));
    for (const [site, origin] of [['leftLateral', 'apLeftLateral'], ['septal', 'apSeptal'], ['rightLateral', 'apRightLateral']]) {
        const rv = heart(input, { ...DEFAULT_EP, apSite: site });
        rv.runUntil(3000);
        rv.cardiovert();
        rv.runUntil(4000);
        rv.pace({ site: 'RVa', s1Ms: 600, continuous: true });
        rv.runUntil(9000);
        const S = rv.activations(4000, 9000).filter(a => a.kind === 'S');
        const A = rv.activations(S[1].tMs, 9000).filter(a => a.kind === 'A');
        ok(`ventricular pacing: retrograde up the ${site} pathway`, A.length >= 5 && A.every(a => a.origin === origin), A.map(a => a.origin).join(','));
    }
}

section('what a shock stops, and what it does not');
{
    for (const [name, id, mech, params, ch] of [
        ['atrial flutter', 'flutter21', 'flutter', { fWaveMs: 210, fPhaseMs: 100 }, (a) => a.kind === 'A' && a.origin === 'flutter'],
        ['atrial fibrillation', 'af', 'afib', {}, (a) => a.kind === 'f'],
        ['ventricular tachycardia', 'vtDissociation', 'vt', {}, (a) => a.kind === 'V' && a.origin === 'RV'],
    ]) {
        const s = heart(reading(id, mech, params));
        s.runUntil(3000);
        s.cardiovert();
        s.runUntil(15000);
        const after = s.activations(3001, 15000);
        ok(`${name}: stopped for good, sinus rhythm after`, !after.some(ch) && after.filter(a => a.kind === 'A' && a.origin === 'sinus').length >= 8
           && after.filter(a => a.kind === 'V').every(a => a.origin === 'normal'));
    }
    const at = reading('svtShortRP', 'at');
    const s = heart(at);
    s.runUntil(3000);
    s.cardiovert();
    s.runUntil(9000);
    const A = s.activations(3001, 9000).filter(a => a.kind === 'A');
    const cyc = A.slice(1).map((a, i) => a.tMs - A[i].tMs);
    ok('an automatic atrial tachycardia survives a shock', A.length >= 10 && cyc.every(x => Math.abs(x - cyc[0]) <= 1) && cyc[0] < 500, `cycles ${cyc.slice(0, 4)}`);
    const jt = heart(reading('svtShortRP', 'jt', { VA: 80 }));
    jt.runUntil(3000);
    jt.cardiovert();
    jt.runUntil(9000);
    ok('so does a junctional tachycardia', rrOf(jt.activations(3500, 9000)).every(x => Math.abs(x - fromReading(reading('svtShortRP', 'jt', { VA: 80 })).meta.CL) <= 1));
}

section('the stimulator');
{
    const sinus = reading('sinus', 'avnodal');
    const s = heart(sinus);
    s.runUntil(1000);
    s.pace({ site: 'HRA', s1Ms: 500, n1: 4, s2Ms: 350, s3Ms: 300 });
    ok('sensing: nothing until a beat is sensed', s.pacing?.waiting === true);
    s.runUntil(8000);
    const S = s.activations(0, 8000).filter(a => a.kind === 'S');
    const firstA = s.activations(1000, 8000).find(a => a.kind === 'A');
    ok('the drive starts S1 after the atrial beat it sensed', S.length === 6 && Math.abs(S[0].tMs - (firstA.tMs + 500)) < 0.2);
    ok('S1 × 4, then S2 350 and S3 300', JSON.stringify(S.slice(1).map((x, i) => Math.round(x.tMs - S[i].tMs))) === '[500,500,500,350,300]');
    ok('a train ends by itself', s.pacing === null);
    let threw = 0;
    for (const bad of [{ site: 'LV' }, { site: 'HRA', s1Ms: 100 }]) { try { s.pace(bad); } catch { threw++; } }
    ok('an unknown site or an S1 under 150 ms is refused', threw === 2);
    const c = heart(sinus);
    c.runUntil(1000);
    c.pace({ site: 'HRA', s1Ms: 500, continuous: true, sense: false });
    c.runUntil(3000);
    c.cancelPacing();
    c.runUntil(6000);
    ok('continuous pacing runs until stopped', c.activations(1000, 3000).filter(a => a.kind === 'S').length === 4 && !c.activations(3001, 6000).some(a => a.kind === 'S'));
    const st = heart(sinus);
    const got = [];
    for (let t = 0; t < 5000; t += 16) got.push(...st.step(16));
    ok('step returns what happened in it, and only that', JSON.stringify(got) === JSON.stringify(st.activations(-Infinity, Infinity)) && Math.abs(st.now - (fromReading(sinus).t0Ms + 16 * 313)) < 1e-6);
}

section('determinism');
{
    const run = (input, seed) => { const s = heart(input, DEFAULT_EP, seed); s.runUntil(4000); s.pace({ site: 'RVa', s1Ms: 400, n1: 6, s2Ms: 300 }); s.runUntil(15000); s.cardiovert(); s.runUntil(20000); return JSON.stringify(s.activations()); };
    const af = reading('af', 'afib'), avnrt = reading('avnrt', 'avnrt', { VA: 35 });
    ok('the same reading, seed and actions: the same heart', run(avnrt, 3) === run(avnrt, 3) && run(af, 3) === run(af, 3));
    ok('AF with another seed: another fibrillation', run(af, 3) !== run(af, 4));
}

section('the live recorder');
{
    ok('the screen: II, V1, the catheters chosen, the stimulator', JSON.stringify(liveChannels(DEFAULT_EP)) === JSON.stringify([...LIVE_SURFACE, ...channelsOf(DEFAULT_EP), 'Stim'])
       && JSON.stringify(liveChannels({ ...DEFAULT_EP, catheters: ['His'], hisSplit: true })) === '["II","V1","Hisp","Hisd","Stim"]');
    const V = [{ kind: 'V', tMs: 0, origin: 'normal' }];
    ok('a conducted QRS: upright in II, negative in V1', surfaceAt(V, 'II', 38) > 0.8 && surfaceAt(V, 'V1', 48) < -0.6);
    ok('an RV beat: wide and negative in V1; an LV beat: positive in V1', surfaceAt([{ kind: 'V', tMs: 0, origin: 'RV' }], 'V1', 70) < -0.8 && surfaceAt([{ kind: 'V', tMs: 0, origin: 'LV' }], 'V1', 50) > 0.8);
    ok('a sinus P is upright in II, a retrograde one inverted', surfaceAt([{ kind: 'A', tMs: 0, origin: 'sinus' }], 'II', 45) > 0.08 && surfaceAt([{ kind: 'A', tMs: 0, origin: 'fast' }], 'II', 45) < -0.1);
    ok('the baseline between beats is flat', Math.abs(surfaceAt(V, 'II', -200)) < 1e-9 && Math.abs(surfaceAt(V, 'II', 750)) < 1e-9);

    const sim = heart(reading('sinus', 'avnodal'));
    sim.runUntil(4000);
    const sampler = createSampler(sim);
    const a = sim.activations(1000, 4000).find(x => x.kind === 'A');
    sampler.prepare(a.tMs - 300, a.tMs + 300);
    const onA = sampler.column('HRA', a.tMs - 2, a.tMs + 30), quiet = sampler.column('HRA', a.tMs - 250, a.tMs - 200);
    ok('the HRA channel deflects at the atrial activation and is quiet before it', onA.max - onA.min > 0.3 && quiet.max - quiet.min < 0.06, `${(onA.max - onA.min).toFixed(3)} vs ${(quiet.max - quiet.min).toFixed(3)}`);
    ok('a column reports its range and its last value', onA.min <= onA.last && onA.last <= onA.max);

    const ctx = makeRecorder();
    const W = 600, H = 400;
    const channels = liveChannels(DEFAULT_EP);
    const sweep = createSweep({ ctx, cssW: W, cssH: H, channels, speedMmS: 100 });
    const live = heart(reading('sinus', 'avnodal'));
    const t0 = live.now;
    sweep.reset(t0);
    const log = ctx.__log;
    const mark = log.length;
    for (let t = 0; t < 2000; t += 16) { live.step(16); sweep.drawUntil(live.now, createSampler(live)); }
    const msPerPx = 1000 / (100 * PX_PER_MM);
    ok('the pen keeps up with the heart, to a pixel', Math.abs(sweep.penT - live.now) < msPerPx, `${sweep.penT} vs ${live.now}`);
    const erases = log.slice(mark).filter(([m, x]) => m === 'fillRect' && x[1] === 0 && x[3] === H && x[0] === LABEL_W);
    ok('at 100 mm/s a 600-px screen wraps: the pen goes back to the left edge', erases.length >= 2, `${erases.length}`);
    ok('an erase band runs ahead of the pen', log.slice(mark).some(([m, x]) => m === 'fillRect' && x[2] === 14 && x[3] === H));
    const strokes = new Set(log.slice(mark).filter(([m]) => m === '=strokeStyle').map(([, x]) => x[0]));
    ok('every channel in its own colour', channels.every(ch => strokes.has(EGM_COLORS[ch])));
    sweep.setSpeed(300);
    ok('changing the speed starts a clean screen', sweep.speedMmS === 300 && log[log.length - 1][0] !== 'lineTo');
    const before = sweep.penT;
    sweep.drawUntil(before + 60000, createSampler(live));
    ok('a hidden page does not replay minutes', Math.abs(sweep.penT - (before + 60000)) < 1);
}

console.log(`\n${pass} ok, ${fail} fail`);
if (fail) process.exit(1);
