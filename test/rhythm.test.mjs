// Plausibility, per-mechanism timings and "continue to the end", against synthetic ECGs whose every
// P and QRS onset is known (synth.js metadata.truth).
import { SYNTH_SCENARIOS, makeExample } from '../synth.js';
import { buildLadder } from '../engine.js';
import { continueRhythm, measureRhythm, plausibility, plausibleParams, suggestReading } from '../rhythm.js';

let pass = 0, fail = 0;
const ok = (name, cond) => cond ? (pass++, console.log('  ok   ' + name)) : (fail++, console.log('  FAIL ' + name));
const W = { normal: 90, pvc: 150, wide: 150, capture: 90, fusion: 120 };
function truthMarks(id) {
    const tr = makeExample(id).metadata.truth;
    const beats = tr.QRS.map((q, i) => ({ id: 'b' + i, qrsOnMs: q.t, qrsOffMs: q.t + (W[q.morph] ?? 140), quality: q.morph === 'pvc' ? 'pvc' : 'normal' }));
    const atrial = tr.P.map((p, i) => ({ id: 'a' + i, tMs: p.t }));
    return { tr, beats, atrial };
}

console.log('\nthe true mechanism is never excluded');
for (const sc of SYNTH_SCENARIOS) {
    const { beats, atrial } = truthMarks(sc.id);
    const want = sc.expect;
    const v = plausibility(beats, atrial).verdicts[want];
    ok(`${sc.id}: ${want} is ${v.status}${v.status === 'excluded' ? ' — ' + v.reasons.join('; ') : ''}`, v.status !== 'excluded');
    const s = suggestReading(beats, atrial);
    ok(`${sc.id}: the suggestion (${s.id}) is not excluded`, plausibility(beats, atrial).verdicts[s.id].status !== 'excluded');
}

console.log('\nwhat the RP / PR rule out');
const V = (id) => plausibility(truthMarks(id).beats, truthMarks(id).atrial).verdicts;
const R = (id) => measureRhythm(truthMarks(id).beats, truthMarks(id).atrial);
ok('svtZeroRP: RP ≤ 70', R('svtZeroRP').rpClass === 'veryShort');
ok('svtZeroRP: orthodromic AVRT and PJRT excluded', V('svtZeroRP').avrt.status === 'excluded' && V('svtZeroRP').pjrt.status === 'excluded');
ok('svtZeroRP: suggestion is AVNRT', suggestReading(truthMarks('svtZeroRP').beats, truthMarks('svtZeroRP').atrial).id === 'avnrt');
ok('svtLongRP: long RP', R('svtLongRP').rpClass === 'long');
ok('svtLongRP: orthodromic AVRT excluded, PJRT / AT / AVNRT (atypical) kept',
   V('svtLongRP').avrt.status === 'excluded' && V('svtLongRP').pjrt.status !== 'excluded' && V('svtLongRP').at.status !== 'excluded' && V('svtLongRP').avnrt.status !== 'excluded');
ok('svtLongRP: AVNRT says atypical only', V('svtLongRP').avnrt.reasons.some(r => /atypical/.test(r)));
ok('svtLongRP: suggestion is not AVRT', suggestReading(truthMarks('svtLongRP').beats, truthMarks('svtLongRP').atrial).id !== 'avrt');
ok('avrt (VA 140): short RP, PJRT excluded, AVRT kept', R('avrt').rpClass === 'short' && V('avrt').pjrt.status === 'excluded' && V('avrt').avrt.status !== 'excluded');
ok('vtDissociation: every AVRT excluded', ['avrt', 'pjrt', 'avrtAnti'].every(k => V('vtDissociation')[k].status === 'excluded'));
ok('chb: dissociated, complete block allowed', R('chb').dissociated && V('chb').avb3.status !== 'excluded');
ok('sinus: complete block excluded (fixed PR)', V('sinus').avb3.status === 'excluded');
ok('twoToOne: more P than QRS, AVRT excluded', R('twoToOne').relation === 'A>V' && V('twoToOne').avrt.status === 'excluded');
ok('narrow sinus: antidromic AVRT excluded', V('sinus').avrtAnti.status === 'excluded');
ok('no P marked: nothing excluded by RP', plausibility(truthMarks('avnrt').beats, []).verdicts.avrt.status !== 'excluded');

console.log('\ntimings per mechanism');
{
    const { beats, atrial } = truthMarks('svtLongRP');
    const m = R('svtLongRP');
    ok(`PJRT VA = measured RP (${m.RP})`, plausibleParams('pjrt', beats, atrial).params.VA === m.RP && plausibleParams('pjrt', beats, atrial).source.VA === 'measured');
    ok('AVNRT VA = measured RP', plausibleParams('avnrt', beats, atrial).params.VA === m.RP);
    const L = buildLadder({ beats, atrial, mechanism: 'pjrt', params: plausibleParams('pjrt', beats, atrial).params });
    ok('PJRT drawn with the measured VA: no warning', !L.claims.some(c => c.level === 'warning'));
    const L2 = buildLadder({ beats, atrial, mechanism: 'avrt', params: plausibleParams('avrt', beats, atrial).params });
    ok('orthodromic AVRT on a long RP says so', L2.claims.some(c => c.code === 'long-rp-not-avrt'));
    const noP = plausibleParams('avrt', beats, []);
    ok('AVRT without P: a typical VA (> 70), marked typical', noP.params.VA > 70 && noP.source.VA === 'typical');
    ok('AVNRT without P: VA ≤ 70', plausibleParams('avnrt', beats, []).params.VA <= 70);
}
{
    const a = truthMarks('chbVent'), b = truthMarks('chb');
    ok('complete block, wide escape → below the His', plausibleParams('avb3', a.beats, a.atrial).params.blockBelowHis === 1);
    ok('complete block, narrow escape → AV node', plausibleParams('avb3', b.beats, b.atrial).params.blockBelowHis === 0);
    const w = truthMarks('wideTachy1to1');
    ok('VT with 1:1 retrograde P: ectopic VA measured', plausibleParams('vt', w.beats, w.atrial).params.ectopicVA === R('wideTachy1to1').RP);
    const d = truthMarks('vtDissociation');
    ok('VT with dissociation: no retrograde VA', plausibleParams('vt', d.beats, d.atrial).params.ectopicVA === null);
}

console.log('\ncontinue to the end, from the first three beats');
for (const id of ['sinus', 'avb1', 'normalSinus', 'avnrt', 'avrt', 'svtShortRP', 'svtLongRP', 'twoToOne', 'chb', 'pvcBigeminy', 'flutter21']) {
    const { tr, beats, atrial } = truthMarks(id);
    const bigem = id === 'pvcBigeminy';
    const nB = bigem ? 4 : 3;
    const B0 = beats.slice(0, nB), end = B0[nB - 1].qrsOnMs + (id === 'chb' ? 2000 : 0);
    const A0 = atrial.filter(a => a.tMs <= (id === 'chb' ? end : B0[nB - 1].qrsOnMs + 20));
    const c = continueRhythm(B0, A0, tr.durationMs);
    const hitQ = beats.filter(b => b.qrsOnMs < tr.durationMs - 50).filter(b => c.beats.some(x => Math.abs(x.qrsOnMs - b.qrsOnMs) <= 30 && (x.quality === 'pvc') === (b.quality === 'pvc'))).length;
    const needQ = beats.filter(b => b.qrsOnMs < tr.durationMs - 50).length;
    const extraQ = c.beats.filter(x => !beats.some(b => Math.abs(x.qrsOnMs - b.qrsOnMs) <= 30)).length;
    const hitP = atrial.filter(a => c.atrial.some(x => Math.abs(x.tMs - a.tMs) <= 40)).length;
    const extraP = c.atrial.filter(x => !atrial.some(a => Math.abs(x.tMs - a.tMs) <= 40)).length;
    console.log(`  ${id}: ${c.message}`);
    ok(`${id}: QRS ${hitQ}/${needQ}, ${extraQ} extra`, hitQ >= needQ - 1 && extraQ <= 1);
    ok(`${id}: P ${hitP}/${atrial.length}, ${extraP} extra`, hitP >= atrial.length - 2 && extraP <= 1);
}
{
    const { tr, beats } = truthMarks('af');
    const c = continueRhythm(beats.slice(0, 8), [], tr.durationMs);   // its first five RR happen to be near-regular
    ok('af: an irregular RR is not continued', c.added.beats.length === 0 && /irregular/.test(c.message));
    const one = continueRhythm(beats.slice(0, 1), [], 5000);
    ok('one QRS: nothing added, says why', one.added.beats.length === 0 && one.message.length > 0);
}

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
