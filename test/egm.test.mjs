// The intracardiac channels of a reading (egm.js, PREMISES.md §7), checked against the synthetic tracings whose
// true P and QRS onsets are known: every deflection is a ladder event plus a fixed anatomical offset, so each
// reading has to produce the activation sequence the electrophysiology textbooks describe for it.
//
//   node packages/laddergram-core/test/egm.test.mjs
import { makeExample } from '../synth.js';
import { figureMarkers } from '../figures.js';
import { DEFAULT_PARAMS } from '../engine.js';
import { toLaddergramJson, fromLaddergramJson, toLewisLadderDiagram } from '../export.js';
import { buildLadder } from '../engine.js';
import {
    egmSchedule, egmSamples, channelsOf, cleanEp, activationDeflections, atrialSequence, ventricularSequence,
    DEFAULT_EP, CATHETER_IDS, EGM_CHANNELS, BLOCK_ORDERS, egmLayoutOptions,
} from '../egm.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

/** A reading on a synthetic tracing: its true marks, a mechanism, parameters and optional per-beat conduction. */
function reading(id, mechanism, params = {}, { conduction = null, ep = DEFAULT_EP, tiers = ['A', 'AV', 'V'] } = {}) {
    const rec = makeExample(id);
    const { beats, atrial } = figureMarkers(rec);
    if (conduction) for (const b of beats) b.conduction = conduction;
    const input = { beats, atrial, mechanism, params, tiers, durationMs: rec.metadata.truth.durationMs };
    return { rec, beats, atrial, input, s: egmSchedule(input, ep) };
}
const on = (s, ch, kind) => s.deflections.filter(d => d.ch === ch && d.kind === kind).map(d => d.tMs);
const acts = (s, kind) => s.activations.filter(a => a.kind === kind);
/** The atrial deflections one activation wrote, by channel. */
const atrialOf = (s, a) => {
    const out = {};
    for (const d of s.deflections) if (d.kind === 'A' && d.tMs >= a.tMs - 15 && d.tMs <= a.tMs + 120 && (out[d.ch] == null)) out[d.ch] = d.tMs;
    return out;
};
const earliest = (seq, chans) => chans.reduce((best, ch) => (seq[ch] < seq[best] ? ch : best), chans[0]);
const ATRIAL_CH = ['HRA', 'His', 'CS910', 'CS78', 'CS56', 'CS34', 'CS12'];
const CS = ['CS910', 'CS78', 'CS56', 'CS34', 'CS12'];

section('sinus rhythm: high RA first, the septum PA later, the coronary sinus proximal to distal');
{
    const { s, beats } = reading('sinus', 'avnodal');
    const A = acts(s, 'A');
    ok('one atrial activation per P, all from the sinus node', A.length === figureMarkers(makeExample('sinus')).atrial.length && A.every(a => a.origin === 'sinus'));
    const a = A[1], seq = atrialOf(s, a);
    ok('the HRA fires 10 ms before the P is inscribed (Kusumoto ch. 2)', seq.HRA === a.tMs - 10, `HRA ${seq.HRA} vs P ${a.tMs}`);
    ok('the His catheter sees the atrium PA after the P onset', seq.His === a.tMs + DEFAULT_PARAMS.PA);
    ok('CS 9-10 → CS 1-2, 10 ms apart', CS.every((ch, i) => i === 0 || seq[ch] - seq[CS[i - 1]] === 10) && seq.CS910 === seq.His + 10);
    ok('HRA is the earliest atrial channel', earliest(seq, ATRIAL_CH) === 'HRA');
    const b = s.beats.find(x => x.beatId === beats[2].id);
    ok('AH = PR − PA − HV (160 − 35 − 45 = 80)', b.AH === 80, `AH ${b.AH}`);
    ok('HV = the reading\'s HV', b.HV === DEFAULT_PARAMS.HV);
    ok('a His deflection HV before every QRS', beats.every(q => on(s, 'His', 'H').some(t => Math.abs(q.qrsOnMs - DEFAULT_PARAMS.HV - t) < 0.2)));
    ok('the RV apex 25 ms after the QRS onset', beats.every(q => on(s, 'RVa', 'V').includes(q.qrsOnMs + 25)));
    ok('the coronary sinus records the ventricle far-field', s.deflections.filter(d => d.kind === 'V' && CS.includes(d.ch)).every(d => d.far && d.amp < 0.5));
    ok('letters A, H, V over every conducted beat', s.letters.filter(l => l.text === 'H').length === beats.length && s.letters.filter(l => l.text === 'A').length === A.length);
    ok('the schedule does not depend on the tiers drawn', JSON.stringify(egmSchedule({ ...reading('sinus', 'avnodal').input, tiers: ['SN', 'A', 'AV', 'His', 'RBB', 'LBB', 'V'] }).deflections)
        === JSON.stringify(s.deflections));
    ok('a changed PA moves the His and CS atrial deflections', (() => {
        const s2 = reading('sinus', 'avnodal', { PA: 50 }).s;
        const q = atrialOf(s2, acts(s2, 'A')[1]);
        return q.His === q.HRA + 60 && q.CS910 === q.HRA + 70;
    })());
}

section('typical AVNRT: retrograde up the fast pathway — concentric, the septum first, VA short');
{
    const { s } = reading('avnrt', 'avnrt', { VA: 35 });
    const retro = acts(s, 'A').filter(a => a.retro);
    ok('every retrograde P goes up the fast pathway', retro.length > 20 && retro.every(a => a.origin === 'fast'));
    const seq = atrialOf(s, retro[3]);
    ok('the His catheter records the earliest atrium', earliest(seq, ATRIAL_CH) === 'His');
    ok('concentric: CS 9-10 before CS 1-2', seq.CS910 < seq.CS12);
    ok('the HRA later than the His', seq.HRA > seq.His);
    ok('VA 35 on every beat', s.beats.filter(b => b.VA != null).every(b => b.VA === 35));
    ok('the long AH is the slow pathway (CL 360 − VA 35 − HV 45 = 280)', s.beats.slice(1).every(b => b.AH === 280));
}

section('atypical AVNRT: retrograde up the slow pathway — the coronary sinus ostium before the His');
{
    const { s } = reading('svtLongRP', 'avnrt', { VA: 270 });
    const retro = acts(s, 'A').filter(a => a.retro);
    ok('long VA → retrograde over the slow pathway', retro.length > 5 && retro.every(a => a.origin === 'slow'));
    const seq = atrialOf(s, retro[2]);
    ok('CS 9-10 is the earliest atrial channel', earliest(seq, ATRIAL_CH) === 'CS910');
    ok('the His atrium follows the ostium by 30 ms (Abedin 5.5: 30–60 ms)', seq.His === seq.CS910 + 30);
}

section('orthodromic AVRT: retrograde up the accessory pathway — eccentric');
{
    const { s } = reading('avrt', 'avrt', { VA: 140 });
    const retro = acts(s, 'A').filter(a => a.retro);
    ok('every retrograde P over the pathway (left lateral by default)', retro.length > 20 && retro.every(a => a.origin === 'apLeftLateral'));
    const seq = atrialOf(s, retro[3]);
    ok('CS 1-2 earliest, the His and the HRA last', earliest(seq, ATRIAL_CH) === 'CS12' && seq.His > seq.CS910 && seq.HRA > seq.His);
    const sep = reading('avrt', 'avrt', { VA: 140 }, { ep: { ...DEFAULT_EP, apSite: 'septal' } }).s;
    ok('a septal pathway: CS 9-10 earliest', earliest(atrialOf(sep, acts(sep, 'A').filter(a => a.retro)[3]), ATRIAL_CH) === 'CS910');
    const rl = reading('avrt', 'avrt', { VA: 140 }, { ep: { ...DEFAULT_EP, apSite: 'rightLateral' } }).s;
    ok('a right lateral pathway: the HRA earliest, CS 1-2 last', (() => { const q = atrialOf(rl, acts(rl, 'A').filter(a => a.retro)[3]); return earliest(q, ATRIAL_CH) === 'HRA' && q.CS12 === Math.max(...ATRIAL_CH.map(c => q[c])); })());
    const pj = reading('svtLongRP', 'pjrt', { VA: 270, apVdelay: 35 }).s;
    ok('PJRT: the automatic site is posteroseptal (CS 9-10 earliest)', pj.apSite === 'septal' && earliest(atrialOf(pj, acts(pj, 'A').filter(a => a.retro)[2]), ATRIAL_CH) === 'CS910');
}

section('antidromic AVRT: the ventricle pre-excited from the pathway, the His retrograde after the QRS');
{
    const { s } = reading('wideTachy1to1', 'avrtAnti', { VA: 210, vhMs: 110, apAnteMs: 45 });
    const V = acts(s, 'V');
    ok('every beat pre-excited over a left lateral pathway', V.length > 5 && V.every(v => v.origin === 'preLeftLateral'));
    const v = V[2];
    const vd = Object.fromEntries(s.deflections.filter(d => d.kind === 'V' && d.tMs >= v.tMs && d.tMs < v.tMs + 130).map(d => [d.ch, d.tMs]));
    ok('CS 1-2 the earliest ventricular deflection', vd.CS12 === v.tMs && vd.CS12 < vd.RVa);
    ok('the His is reached after the QRS (VH 110)', s.beats.slice(1, -1).every(b => b.VH === 110 && b.tH == null));
}

section('complete AV block: the atria and the escape rhythm are unrelated');
{
    const { s, beats, atrial } = reading('chb', 'avb3');
    ok('every P an atrial activation, none conducted', acts(s, 'A').length === atrial.length && s.beats.every(b => b.AH == null));
    ok('junctional escape: one His per QRS, HV before it', on(s, 'His', 'H').length === beats.length && s.beats.every(b => b.HV === DEFAULT_PARAMS.HV));
    const w = reading('chbVent', 'avb3');
    ok('ventricular escape: no His at all', on(w.s, 'His', 'H').length === 0);
    ok('ventricular escape from the RV: the RV apex at the QRS onset', w.beats.every(q => on(w.s, 'RVa', 'V').includes(q.qrsOnMs)));
}

section('2:1 and Mobitz II: a blocked P writes an A and nothing below it — unless it dies below the His');
{
    const { s, beats, atrial } = reading('twoToOne', 'avnodal');
    ok('every P recorded', acts(s, 'A').length === atrial.length);
    ok('nodal 2:1: one His per QRS, none for a blocked P', on(s, 'His', 'H').length === beats.length);
    const infra = reading('twoToOne', 'avnodal', { blockBelowHis: 1 });
    ok('infra-His 2:1: a His for every P, a V for every other', on(infra.s, 'His', 'H').length === infra.atrial.length && acts(infra.s, 'V').length === infra.beats.length);
    const m2 = reading('mobitz2', 'avnodal', {}, { conduction: 'RBBB', tiers: ['A', 'AV', 'His', 'RBB', 'LBB', 'V'] });
    ok('Mobitz II: the blocked P still has its His (the block is below it)', on(m2.s, 'His', 'H').length > m2.beats.length);
    ok('RBBB: the RV apex is reached 70 ms after the QRS onset', m2.beats.every(q => on(m2.s, 'RVa', 'V').includes(q.qrsOnMs + 70)));
    const lb = reading('lbbb', 'avnodal', {}, { conduction: 'LBBB', tiers: ['A', 'AV', 'His', 'RBB', 'LBB', 'V'] });
    ok('LBBB: the left ventricle (CS 1-2) 125 ms after the QRS onset', lb.beats.every(q => on(lb.s, 'CS12', 'V').includes(q.qrsOnMs + 125)));
}

section('flutter and fibrillation');
{
    const fl = reading('flutter21', 'flutter', { fWaveMs: 210, fPhaseMs: 100 });
    const L = buildLadder({ ...fl.input, tiers: ['A', 'AV', 'His', 'V'] });
    const nF = L.events.filter(e => e.role === 'F').length;
    ok('an atrial activation per F wave', acts(fl.s, 'A').length === nF && acts(fl.s, 'A').every(a => a.origin === 'flutter'));
    ok('typical flutter goes up the septum: CS 9-10 before the HRA', (() => { const q = atrialOf(fl.s, acts(fl.s, 'A')[5]); return q.CS910 < q.HRA; })());
    const af = reading('af', 'afib');
    ok('AF: fibrillatory waves on every atrial channel', ['HRA', 'His', 'CS910', 'CS12'].every(ch => af.s.deflections.some(d => d.ch === ch && d.kind === 'f')));
    ok('AF: no A letters, an H and a V per QRS', !af.s.letters.some(l => l.text === 'A') && af.s.letters.filter(l => l.text === 'V').length === af.beats.length);
}

section('ventricular tachycardia with AV dissociation and a capture beat');
{
    const { s, beats } = reading('vtDissociation', 'vt');
    const vt = acts(s, 'V').filter(v => v.origin === 'RV');
    ok('the VT beats arise in the RV: the RV apex first', vt.length > 20 && vt.every(v => on(s, 'RVa', 'V').includes(v.tMs)));
    const cap = beats.find(b => b.origin === 'capture');
    const cb = s.beats.find(b => b.beatId === cap.id);
    ok('the capture beat is conducted: an anterograde His before it', cb.origin === 'normal' && cb.HV === DEFAULT_PARAMS.HV && cb.AH > 0);
    ok('the VT beats reach the His retrogradely', s.beats.filter(b => b.origin === 'RV').every(b => b.VH != null && b.tH == null));
    const lv = reading('vtDissociation', 'vt', {}, { ep: { ...DEFAULT_EP, vOrigin: 'LV' } }).s;
    ok('a left ventricular focus: CS 1-2 first, the RV apex late', acts(lv, 'V').filter(v => v.origin === 'LV').every(v => on(lv, 'CS12', 'V').includes(v.tMs) && on(lv, 'RVa', 'V').includes(v.tMs + 65)));
}

section('concealed His extrasystoles: H′ with no V');
{
    const { s, beats, atrial } = reading('twoToOneIvcd', 'hisExtra', { hPrimeLead: 150 });
    // one H′ before every P that does not conduct (here 5 P, 2 QRS)
    const blocked = atrial.length - beats.length;
    ok('an H′ letter for each concealed His depolarization', s.letters.filter(l => l.text === 'H′').length === blocked,
       `${s.letters.filter(l => l.text === 'H′').length} H′ for ${blocked} blocked P`);
    ok('no V follows an H′', acts(s, 'V').length === beats.length);
}

section('samples, channels and settings');
{
    const { s } = reading('normalSinus', 'avnodal', { SACT: 60, PA: 30, HV: 40 });
    const a = egmSamples(s, { seed: 7 }), b = egmSamples(s, { seed: 7 }), c = egmSamples(s, { seed: 8 });
    ok('the same seed gives the same signals', s.channels.every(ch => a.channels[ch].every((v, i) => v === b.channels[ch][i])));
    ok('another seed gives other signals', s.channels.some(ch => a.channels[ch].some((v, i) => v !== c.channels[ch][i])));
    ok('one sample per ms over the strip', a.n === 2400 && a.channels.HRA.length === 2400);
    const peak = Math.max(...a.channels.RVa.map(Math.abs));
    ok('a near-field ventricle peaks near 1 (± the beat-to-beat variation)', peak > 0.85 && peak < 1.2, `peak ${peak}`);
    ok('channels in EP-system order', JSON.stringify(channelsOf(DEFAULT_EP)) === JSON.stringify(['HRA', 'His', 'CS910', 'CS78', 'CS56', 'CS34', 'CS12', 'RVa']));
    ok('His split → His p and His d', JSON.stringify(channelsOf({ ...DEFAULT_EP, hisSplit: true, catheters: ['His', 'RVa'] })) === JSON.stringify(['Hisp', 'Hisd', 'RVa']));
    const hp = on(s, 'Hisp', 'H'), hd = on(s, 'Hisd', 'H');
    ok('the distal His pair is reached 4 ms after the proximal one', hp.length && hp.every((t, i) => hd[i] === t + 4));
    ok('every channel is recordable', EGM_CHANNELS.every(ch => ch === 'Stim' || s.deflections.some(d => d.ch === ch)));
    ok('layout options follow the settings', JSON.stringify(egmLayoutOptions({ catheters: ['HRA'], showLetters: false, showAhHv: false })) === JSON.stringify({ channels: ['HRA'], letters: false, brackets: false }));
    ok('a stimulus writes a spike on Stim and on the paced channel', (() => { const d = activationDeflections({ kind: 'S', tMs: 100, site: 'RVa' }); return d.some(x => x.ch === 'Stim') && d.some(x => x.ch === 'RVa' && x.kind === 'S'); })());
    ok('sequences are complete', ['sinus', 'fast', 'slow', 'apLeftLateral', 'apSeptal', 'apRightLateral', 'flutter'].every(o => ATRIAL_CH.map(c => c === 'His' ? 'HisA' : c).every(k => Number.isFinite(atrialSequence(o)[k])))
        && ['normal', 'RBBB', 'LBBB', 'RV', 'LV', 'preLeftLateral', 'preSeptal', 'preRightLateral'].every(o => ['HisV', 'RVa', ...CS].every(k => Number.isFinite(ventricularSequence(o)[k]))));

    const junk = cleanEp({ catheters: ['CS12', 'nope', 'HRA'], order: ['ladder', 'ladder', 'egm'], speedMmS: 150, apSite: 'x', hisSplit: 'yes', showLetters: false });
    ok('settings: unknown catheters dropped, their own order kept', JSON.stringify(junk.catheters) === JSON.stringify(['HRA', 'CS12']));
    ok('settings: a bad order, speed or site falls back', JSON.stringify(junk.order) === JSON.stringify(BLOCK_ORDERS[0]) && junk.speedMmS === 100 && junk.apSite === 'auto' && junk.hisSplit === false && junk.showLetters === false);
    ok('settings: nothing is not a setting', cleanEp(null) === null && cleanEp('x') === null);
    ok('settings: every catheter by default', JSON.stringify(cleanEp({}).catheters) === JSON.stringify(CATHETER_IDS));

    const rec = makeExample('normalSinus');
    const { beats, atrial } = figureMarkers(rec);
    const ladder = buildLadder({ beats, atrial, mechanism: 'avnodal' });
    const ep = { ...DEFAULT_EP, order: ['egm', 'strip', 'ladder'], catheters: ['His', 'RVa'], speedMmS: 200 };
    const j = fromLaddergramJson(JSON.parse(JSON.stringify(toLaddergramJson({ beats, atrial, mechanism: 'avnodal', params: {}, ladder, ep }))));
    ok('a laddergram file keeps its EP view', JSON.stringify(j.ep) === JSON.stringify(cleanEp(ep)));
    ok('a file without one has none', fromLaddergramJson(JSON.parse(JSON.stringify(toLaddergramJson({ beats, atrial, mechanism: 'avnodal', params: {}, ladder })))).ep === null);
    const lewis = toLewisLadderDiagram(ladder, { tMinMs: 0, tMaxMs: 2400, ep });
    ok('a Lewis Ladder diagram carries it too', JSON.stringify(lewis.ep) === JSON.stringify(cleanEp(ep)) && !('ep' in toLewisLadderDiagram(ladder, { tMinMs: 0, tMaxMs: 2400 })));
}

section('a strip whose time axis starts before zero');
{
    const sch = { channels: ['HRA'], deflections: [{ ch: 'HRA', kind: 'A', tMs: -500, amp: 1, far: false }] };
    const peak = (x, i0, i1) => Math.max(...Array.from(x.slice(i0, i1), Math.abs));
    const from0 = egmSamples(sch, { durationMs: 1000 });
    const early = egmSamples(sch, { t0Ms: -1000, durationMs: 1000 });
    ok('the samples cover the window asked for, from its own start', early.n === 2000 && early.t0Ms === -1000 && from0.t0Ms === 0);
    ok('a deflection before zero is on the signal that starts before zero', peak(early.channels.HRA, 480, 560) > 0.3);
    ok('and nowhere on one that starts at zero', peak(from0.channels.HRA, 0, 1000) < 0.1);
}

section('where an atrial focus fires (a setting), and the order the coronary sinus is listed in');
{
    const first = (site) => { const { s } = reading('svtShortRP', 'at', {}, { ep: { ...DEFAULT_EP, atSite: site } }); const a = acts(s, 'A')[2]; return { origin: a.origin, seq: atrialOf(s, a) }; };
    ok('a high right atrial (cristal) focus: the HRA first, like sinus', (() => { const r = first('highRA'); return r.origin === 'highRA' && earliest(r.seq, ATRIAL_CH) === 'HRA'; })());
    ok('a focus at the coronary sinus ostium: CS 9-10 first, the His atrium 30 ms later', (() => { const r = first('csOs'); return earliest(r.seq, ATRIAL_CH) === 'CS910' && r.seq.His === r.seq.CS910 + 30; })());
    ok('a left atrial focus: CS 1-2 first, the HRA last', (() => { const r = first('leftAtrium'); return earliest(r.seq, ATRIAL_CH) === 'CS12' && r.seq.HRA > r.seq.His; })());
    ok('a septal focus: the His atrium first, the ostium within 5 ms', (() => { const r = first('septal'); return earliest(r.seq, ATRIAL_CH) === 'His' && r.seq.CS910 === r.seq.His + 5; })());
    ok('the default is the high right atrium', cleanEp({}).atSite === 'highRA' && cleanEp({ atSite: 'nowhere' }).atSite === 'highRA');
    ok('the coronary sinus is listed proximal first, or distal first as some labs do', JSON.stringify(channelsOf({ ...DEFAULT_EP, csDistalFirst: true })) === JSON.stringify(['HRA', 'His', 'CS12', 'CS34', 'CS56', 'CS78', 'CS910', 'RVa'])
        && JSON.stringify(channelsOf({ ...DEFAULT_EP, csDistalFirst: true, catheters: ['CS910', 'CS12', 'RVa'] })) === JSON.stringify(['CS12', 'CS910', 'RVa']));
}

section('a posteroseptal pathway is near-concentric; typical flutter climbs the septum');
{
    const { s } = reading('avrt', 'avrt', { VA: 140 }, { ep: { ...DEFAULT_EP, apSite: 'septal' } });
    const q = atrialOf(s, acts(s, 'A').find(a => a.retro));
    ok('posteroseptal: the ostium first, the His atrium 20 ms later, the distal coronary sinus and the HRA late', earliest(q, ATRIAL_CH) === 'CS910' && q.His === q.CS910 + 20 && q.CS12 > q.His && q.HRA > q.His);
    const fl = reading('flutter21', 'flutter', { fWaveMs: 210, fPhaseMs: 100 }).s;
    const f = atrialOf(fl, acts(fl, 'A')[5]);
    ok('flutter: the ostium, then the His region 30 ms up the septum, the HRA last at 100 ms', f.His === f.CS910 + 30 && f.HRA === f.CS910 + 100 && f.CS12 === f.CS910 + 40);
}

console.log(`\n${pass} ok, ${fail} fail`);
if (fail) process.exit(1);
