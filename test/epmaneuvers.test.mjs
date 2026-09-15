// The maneuvers read back (epmaneuvers.js) and the physiology added for them (epsim.js): bundle branches and
// aberrancy, Coumel's sign, parahisian and apex-versus-base pacing, isoproterenol, the scans, the episode replay,
// and the episode drawn on paper (eplive.js).
//
//   node packages/laddergram-core/test/epmaneuvers.test.mjs
import { makeExample } from '../synth.js';
import { figureMarkers } from '../figures.js';
import { fromReading, createSim, STIM_SITES } from '../epsim.js';
import { interpretLog, scanExtrastimulus, scanDrive, episodeJson, replayEpisode, EPISODE_KIND } from '../epmaneuvers.js';
import { liveChannels, createSampler, drawEpisode, episodeSize } from '../eplive.js';
import { activationDeflections, ventricularSequence } from '../egm.js';
import { makeRecorder } from './mockCanvas.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

function reading(id, mechanism, params = {}, conduction = null) {
    const rec = makeExample(id);
    const { beats, atrial } = figureMarkers(rec);
    if (conduction) for (const b of beats) b.conduction = conduction;
    return { beats, atrial, mechanism, params, tiers: ['A', 'AV', 'His', 'V'], durationMs: rec.metadata.truth.durationMs };
}
const R = {
    sinus: reading('sinus', 'avnodal'), avnrt: reading('avnrt', 'avnrt', { VA: 35 }), avnrtAtyp: reading('svtLongRP', 'avnrt', { VA: 270 }),
    avrt: reading('avrt', 'avrt', { VA: 140 }), pjrt: reading('svtLongRP', 'pjrt', { VA: 270, apVdelay: 35 }), at: reading('svtLongRP', 'at'),
    jt: reading('svtShortRP', 'jt', { VA: 80 }), flutter: reading('flutter21', 'flutter', { fWaveMs: 210, fPhaseMs: 100 }), vt: reading('vtDissociation', 'vt'),
    rbbb: reading('rbbb', 'avnodal', {}, 'RBBB'),
};
const septal = { apSite: 'septal' };
const heart = (input, ep) => createSim(fromReading(input, ep));
const tcl = (s, t0, t1) => { const V = s.activations(t0, t1).filter(a => a.kind === 'V'); const rr = V.slice(1).map((v, i) => v.tMs - V[i].tMs); return rr.length ? rr.reduce((a, b) => a + b) / rr.length : null; };
const log = (s) => interpretLog(s.activations(), { now: s.now });
const lastOf = (s, kind) => log(s).filter(e => e.kind === kind).pop();
const has = (e, re) => !!e && re.test([e.title, ...e.lines, e.verdict ?? ''].join(' | '));

/** A train from `site` at TCL − delta into the running tachycardia; the log entry it produced. */
function train(input, ep, { site = 'RVa', n = 10, delta = 30, output } = {}) {
    const s = heart(input, ep);
    s.runUntil(3000);
    const CL = tcl(s, 1000, 3000);
    s.pace({ site, s1Ms: Math.round(CL - delta), n1: n, sense: true, output });
    s.runUntil(3000 + (n + 2) * CL + 4500);
    return { s, e: lastOf(s, site === 'HRA' ? 'overdrive' : 'entrain') };
}
/** One PVC `dc` ms from the moment the His fires. */
function pvc(input, ep, dc, site = 'RVa') {
    const s0 = heart(input, ep);
    s0.runUntil(3000);
    const CL = tcl(s0, 1000, 3000);
    const acts = s0.activations(1500, 3000);
    const lastV = acts.filter(a => a.kind === 'V').pop(), H = acts.filter(a => a.kind === 'H').pop();
    const c = Math.round(((H.tMs - lastV.tMs) % CL + CL) % CL + dc);
    const s = heart(input, ep);
    s.runUntil(3000);
    s.pace({ site, s1Ms: c, n1: 1, sense: true });
    s.runUntil(8000);
    return { s, e: lastOf(s, 'pvc') };
}

section('the readout of ventricular entrainment (Abedin 5.5)');
{
    const a = train(R.avnrt, null).e;
    ok('typical AVNRT: V-A-V, PPI − TCL > 115, SA − VA > 85, ΔHA > 0 → AVNRT', has(a, /V-A-V/) && has(a, /PPI − TCL 1[2-9]\d/) && has(a, /ΔHA \+/) && /— AVNRT/.test(a.verdict), a?.verdict);
    const b = train(R.avrt, null).e;
    ok('orthodromic AVRT: V-A-V, PPI − TCL < 115, SA − VA < 85 → AVRT', has(b, /V-A-V/) && /orthodromic AVRT/.test(b.verdict), b?.verdict);
    const c = train(R.at, null, { n: 20 }).e;
    ok('atrial tachycardia: V-A-A-V → AT', has(c, /V-A-A-V/) && /atrial tachycardia/.test(c.verdict), c?.verdict);
    const d = train(R.flutter, null).e;
    ok('flutter: VA dissociation during pacing, the tachycardia goes on → excludes AVRT', /dissociated/.test(d.verdict), d?.verdict);
    const e = train(R.jt, null).e;
    ok('junctional tachycardia: reads like AVNRT and says so (the mimic named)', /junctional tachycardia answers the same way/.test(e.verdict), e?.verdict);
    const f = train(R.vt, null, { delta: 30 }).e;
    ok('VT: no atrial capture, the tachycardia goes on', /no atrial capture|dissociated/.test(f.verdict), f?.verdict);
}

section('atrial overdrive and the first VA (Abedin Table 5.2)');
{
    const a = train(R.avnrt, null, { site: 'HRA' }).e;
    ok('AVNRT: the first VA after pacing equals the tachycardia\'s', /first VA after pacing equals/.test(a.verdict), a?.verdict);
    const b = train(R.at, null, { site: 'HRA', n: 12 }).e;
    ok('AT: terminated or returns late — not the tachycardia\'s own VA', !/equals/.test(b.verdict), b?.verdict);
}

section('the PVC read against the His (Kusumoto 5.15–5.19)');
{
    ok('AVRT, septal pathway: a PVC on the His advances the A → accessory pathway', /accessory pathway is conducting/.test(pvc(R.avrt, septal, 0).e.verdict), pvc(R.avrt, septal, 0).e?.verdict);
    ok('AVNRT: a PVC on the His does not reset → against a septal pathway', /no reset with the His refractory/.test(pvc(R.avnrt, null, 0).e.verdict), pvc(R.avnrt, null, 0).e?.verdict);
    ok('AVRT, septal pathway: an early PVC terminates without an A', /termination without an A/.test(pvc(R.avrt, septal, -70).e.verdict), pvc(R.avrt, septal, -70).e?.verdict);
    const t = [-180, -160, -140, -120].map(dc => pvc(R.avnrtAtyp, null, dc).e);
    ok('atypical AVNRT: a very premature PVC gives termination without reset', t.some(e => /termination without reset/.test(e?.verdict ?? '')), t.map(e => e?.verdict).join(' / '));
}

section('parahisian pacing and apex versus base (Kusumoto 9.17–9.19; Abedin 5.6)');
{
    const para = (input, ep) => {
        const s = heart(input, ep);
        s.runUntil(2000);
        if (tcl(s, 500, 2000) < 600) s.cardiovert();
        s.runUntil(3500);
        s.pace({ site: 'RVb', s1Ms: 600, n1: 4, sense: true, output: 'high' });
        s.runUntil(3500 + 5 * 600);
        s.pace({ site: 'RVb', s1Ms: 600, n1: 4, sense: true, output: 'low' });
        s.runUntil(12000);
        return lastOf(s, 'parahisian');
    };
    const n = para(R.sinus, null), p = para(R.avrt, septal);
    ok('no pathway: S–A lengthens with S–H when His capture is lost → nodal pattern', /nodal pattern/.test(n.verdict), n?.verdict);
    ok('septal pathway: S–A unchanged when His capture is lost → accessory pathway pattern', /accessory pathway pattern/.test(p.verdict), p?.verdict);
    ok('with His capture the QRS is written as parahisian, without as a basal paced beat', (() => {
        const s = heart(R.sinus); s.runUntil(2000);
        s.pace({ site: 'RVb', s1Ms: 600, n1: 2, sense: true, output: 'high' }); s.runUntil(4000);
        s.pace({ site: 'RVb', s1Ms: 600, n1: 2, sense: true, output: 'low' }); s.runUntil(6000);
        const o = s.activations(2000, 6000).filter(a => a.kind === 'V' && a.origin !== 'normal').map(a => a.origin);
        return o.includes('paraHis') && o.includes('RVb');
    })());
    const apex = pvc(R.avrt, septal, 0, 'RVa').e, base = pvc(R.avrt, septal, 0, 'RVb').e;
    const adv = (e) => +(e?.lines.find(l => /advanced by/.test(l))?.match(/advanced by (\d+)/)?.[1] ?? 0);
    ok('septal pathway: the same PVC from the base advances the A more than from the apex', adv(base) > adv(apex) + 10, `${adv(base)} vs ${adv(apex)}`);
    ok('the stimulator knows three sites', STIM_SITES.length === 3 && STIM_SITES.includes('RVb'));
    ok('a stimulus at the base writes its artefact on the His catheter', activationDeflections({ kind: 'S', tMs: 0, site: 'RVb' }).some(d => d.ch === 'His'));
    ok('the basal paced beat reaches the apex late, the parahisian one nearly normally', ventricularSequence('RVb').RVa > 40 && ventricularSequence('paraHis').HisV <= 10);
}

section('the bundle branches: aberrancy and Coumel\'s sign (Kusumoto 9.21)');
{
    const s = heart(R.sinus);
    s.runUntil(2000);
    s.pace({ site: 'HRA', s1Ms: 600, n1: 8, s2Ms: 320, sense: true });
    s.runUntil(12000);
    const S = s.activations().filter(a => a.kind === 'S').pop();
    const v2 = s.activations(S.tMs, S.tMs + 600).find(a => a.kind === 'V');
    ok('an early atrial extrastimulus conducts with right bundle branch block aberrancy', v2 && v2.origin === 'RBBB', v2?.origin);
    ok('the readout names the aberrancy', has(lastOf(s, 'atrialDrive'), /RBBB aberrancy/));
    const s2 = heart(R.sinus); s2.runUntil(2000); s2.pace({ site: 'HRA', s1Ms: 600, n1: 8, s2Ms: 400, sense: true }); s2.runUntil(12000);
    const S2 = s2.activations().filter(a => a.kind === 'S').pop();
    ok('a later one conducts normally', s2.activations(S2.tMs, S2.tMs + 600).find(a => a.kind === 'V')?.origin === 'normal');
    ok('a reading with RBBB keeps its RBBB (the gate is closed)', heart(R.rbbb).runUntil(4000).filter(a => a.kind === 'V').every(a => a.origin === 'RBBB'));
    const coumel = (ep, bb) => { const h = heart(R.avrt, ep); h.runUntil(3000); h.setBundleBlock(bb); h.runUntil(8000); return { e: lastOf(h, 'bbb'), h }; };
    const L = coumel(null, { LB: true });
    ok('left lateral AVRT with LBBB: VA and cycle lengthen ≥ 30 ms — Coumel\'s sign', /Coumel/.test(L.e.verdict) && Math.abs(tcl(L.h, 4000, 8000) - 390) <= 15, `${L.e?.verdict} CL ${tcl(L.h, 4000, 8000)}`);
    ok('the QRS is written with LBBB while the bundle is held', L.h.activations(4000, 8000).filter(a => a.kind === 'V').every(a => a.origin === 'LBBB'));
    ok('left lateral AVRT with RBBB: unchanged (the contralateral bundle)', /unchanged/.test(coumel(null, { RB: true }).e.verdict));
    ok('septal AVRT with LBBB: unchanged', /unchanged/.test(coumel(septal, { LB: true }).e.verdict));
    L.h.setBundleBlock({});
    L.h.runUntil(12000);
    ok('released, the tachycardia returns to its cycle', Math.abs(tcl(L.h, 9000, 12000) - 340) <= 5, `${tcl(L.h, 9000, 12000)}`);
}

section('isoproterenol');
{
    const s = heart(R.sinus);
    s.runUntil(3000);
    const before = tcl(s, 0, 3000);
    s.isoproterenol();
    s.runUntil(9000);
    ok('the sinus rate rises by about a fifth', Math.abs(tcl(s, 4000, 9000) / before - 0.8) < 0.03, `${before} → ${tcl(s, 4000, 9000)}`);
    ok('the log records it', log(s).some(e => e.kind === 'iso'));
    s.runUntil(70000);
    ok('and it wears off after a minute', Math.abs(tcl(s, 66000, 70000) - before) <= 5, `${tcl(s, 66000, 70000)}`);
}

section('adenosine and the shock, read back');
{
    const aden = (k) => { const s = heart(R[k]); s.runUntil(3000); s.adenosine(); s.runUntil(20000); return lastOf(s, 'adenosine'); };
    ok('AVRT: terminated ending on an A → node dependent', /ending on an A/.test(aden('avrt').verdict));
    ok('AT: continues with AV block → node independent', /continues with AV block/.test(aden('at').verdict));
    ok('JT: continues with VA block', /VA block/.test(aden('jt').verdict));
    ok('VT: no effect', /no effect/.test(aden('vt').verdict));
    const s = heart(R.avnrt); s.runUntil(3000); s.cardiovert(); s.runUntil(8000);
    ok('a shock that ends a tachycardia is read as re-entry stopped', /terminated by the shock/.test(lastOf(s, 'shock').verdict));
}

section('the baseline study in an instant');
{
    const a = scanExtrastimulus(R.avnrt, null, { from: 420, to: 200, step: 20 });
    ok('AVNRT: the S2 scan finds the AH jump and the coupling that induces the tachycardia', a.jump && a.jump.dAH >= 50 && a.induced != null && a.induced <= a.jump.s2Ms, JSON.stringify({ jump: a.jump, induced: a.induced }));
    ok('and the AV nodal ERP below it', a.erp.node != null && a.erp.node < a.jump.s2Ms, JSON.stringify(a.erp));
    const n = scanExtrastimulus(R.sinus, null, { from: 420, to: 200, step: 20 });
    ok('a normal node: no jump, an ERP around 300', !n.jump && n.erp.node >= 280 && n.erp.node <= 320, JSON.stringify(n.erp));
    const v = scanExtrastimulus(R.sinus, null, { site: 'RVa', from: 400, to: 200, step: 20 });
    ok('from the ventricle: retrograde block and the ventricular ERP', v.erp.retro != null && v.erp.chamber != null && v.erp.chamber < v.erp.retro, JSON.stringify(v.erp));
    const d = scanDrive(R.sinus, null);
    ok('incremental atrial pacing: Wenckebach around 380 ms', d.blockCL != null && Math.abs(d.blockCL - 380) <= 20 && d.rows.some(r => r.wenckebach), `${d.blockCL}`);
    const dv = scanDrive(R.sinus, null, { site: 'RVa' });
    ok('incremental ventricular pacing: VA block around 460 ms', dv.blockCL != null && Math.abs(dv.blockCL - 460) <= 20, `${dv.blockCL}`);
    const r = scanExtrastimulus(R.avrt, null, { from: 400, to: 220, step: 20 });
    ok('AVRT: induced over a window of couplings, no jump', r.induced != null && !r.jump && r.rows.filter(x => x.induced).length >= 3, `${r.induced}`);
}

section('the episode: saved, replayed, drawn');
{
    const s = heart(R.avnrt);
    s.runUntil(2000);
    s.pace({ site: 'RVa', s1Ms: 330, n1: 10, sense: true });
    s.runUntil(7000);
    s.adenosine();
    s.runUntil(12000);
    s.setBundleBlock({ LB: true });
    s.isoproterenol();
    s.runUntil(14000);
    const j = JSON.parse(JSON.stringify(episodeJson(s, { input: R.avnrt, ep: null, title: 'AVNRT study' })));
    ok('the episode carries the reading, the settings, the seed and every action', j.kind === EPISODE_KIND && j.actions.length === 4 && j.input.beats.length && j.ep.catheters.length && j.untilMs === 14000);
    const s2 = replayEpisode(j);
    const a = s.activations(), b = s2.activations();
    ok('replayed, it is the same heart activation for activation', a.length === b.length && a.every((x, i) => x.kind === b[i].kind && x.tMs === b[i].tMs && x.origin === b[i].origin), `${a.length} vs ${b.length}`);
    ok('and reads the same maneuvers', JSON.stringify(log(s)) === JSON.stringify(log(s2)));
    let threw = false;
    try { replayEpisode({ kind: 'x' }); } catch { threw = true; }
    ok('garbage is refused', threw);
    const channels = liveChannels(null);
    const size = episodeSize({ fromMs: 1000, toMs: 6000, channels, speedMmS: 100, logLines: 2 });
    const ctx = makeRecorder();
    const out = drawEpisode(ctx, { sim: s, fromMs: 1000, toMs: 6000, channels, speedMmS: 100, title: 'AVNRT', log: ['a', 'b'] });
    ok('the strip is drawn at the sweep speed: 5 s at 100 mm/s is 2000 px plus the label column', out.w === size.w && size.w >= 2000 && ctx.__log.filter(c => c[0] === 'stroke').length >= channels.length, `${out.w}`);
}

section('every reading under every mechanism, marks jittered: a heart that runs, and never runs away');
{
    // The readings come from real tracings once the marks and the mechanism are settled; whatever the marks, the
    // network must build, keep time, answer the stimulator and the drugs, and never throw or explode.
    const { SYNTH_SCENARIOS } = await import('../synth.js');
    const { MECHANISMS } = await import('../engine.js');
    const lcg = (seed) => { let x = seed >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; };
    let built = 0, bad = [];
    for (const sc of SYNTH_SCENARIOS) {
        const rec = makeExample(sc.id);
        const base = figureMarkers(rec);
        for (const m of MECHANISMS) {
            for (const jitter of [0, 15]) {
                const rnd = lcg(sc.id.length * 131 + m.id.length);
                const beats = base.beats.map(b => ({ ...b, qrsOnMs: b.qrsOnMs + (jitter ? Math.round((rnd() - 0.5) * 2 * jitter) : 0) }));
                const atrial = base.atrial.filter((a, i) => !(jitter && i === 2)).map(a => ({ ...a, tMs: a.tMs + (jitter ? Math.round((rnd() - 0.5) * 2 * jitter) : 0) }));
                const input = { beats, atrial, mechanism: m.id, params: {}, tiers: ['A', 'AV', 'His', 'V'], durationMs: rec.metadata.truth.durationMs };
                try {
                    const s = createSim(fromReading(input));
                    s.runUntil(8000);
                    s.pace({ site: 'HRA', s1Ms: 500, n1: 6, s2Ms: 300, sense: true });
                    s.runUntil(14000);
                    s.pace({ site: 'RVa', s1Ms: 400, n1: 6, sense: true });
                    s.runUntil(20000);
                    s.adenosine(); s.runUntil(24000);
                    s.isoproterenol(); s.runUntil(28000);
                    s.pace({ site: 'RVb', s1Ms: 600, n1: 3, sense: true, output: 'high' });
                    s.runUntil(31000);
                    s.cardiovert(); s.runUntil(36000);
                    const acts = s.activations();
                    const t = acts.map(a => a.tMs);
                    const monotone = t.every((x, i) => Number.isFinite(x) && (!i || x >= t[i - 1] - 0.01));
                    const perSecond = acts.filter(a => a.kind === 'V').length / 36;
                    interpretLog(acts, { now: s.now });
                    if (!monotone || perSecond > 6 || acts.length > 2000) bad.push(`${sc.id}/${m.id}${jitter ? '~' : ''}: ${monotone ? '' : 'time not monotone '}${perSecond.toFixed(1)} V/s ${acts.length} acts`);
                    built++;
                } catch (err) { bad.push(`${sc.id}/${m.id}${jitter ? '~' : ''}: ${err.message}`); }
            }
        }
    }
    ok(`${built} hearts built and driven (${SYNTH_SCENARIOS.length} readings × ${MECHANISMS.length} mechanisms × exact and jittered marks), none threw or ran away`, bad.length === 0, bad.slice(0, 6).join(' | '));
}

console.log(`\n${pass} ok, ${fail} fail`);
if (fail) process.exit(1);
