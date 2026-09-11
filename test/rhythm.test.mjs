// Plausibility, per-mechanism timings and "continue to the end", against synthetic ECGs whose every
// P and QRS onset is known (synth.js metadata.truth).
import { SYNTH_SCENARIOS, makeExample } from '../synth.js';
import { buildLadder } from '../engine.js';
import { detectMarks } from '../detect.js';
import { continueRhythm, measureRhythm, plausibility, plausibleParams, suggestReading } from '../rhythm.js';

let pass = 0, fail = 0;
const ok = (name, cond) => cond ? (pass++, console.log('  ok   ' + name)) : (fail++, console.log('  FAIL ' + name));
const W = { normal: 90, pvc: 150, wide: 150, capture: 90, fusion: 120 };
function truthMarks(id) {
    const tr = makeExample(id).metadata.truth;
    const beats = tr.QRS.map((q, i) => ({ id: 'b' + i, qrsOnMs: q.t, qrsOffMs: q.t + (W[q.morph] ?? 140), quality: q.morph === 'pvc' ? 'pvc' : 'normal' }));
    let atrial = tr.P.map((p, i) => ({ id: 'a' + i, tMs: p.t }));
    // flutter: the F-wave onsets are the atrial marks
    if (tr.flutter) { atrial = []; for (let t = tr.flutter.phaseMs; t < tr.durationMs; t += tr.flutter.cycleMs) atrial.push({ id: 'f' + atrial.length, tMs: t }); }
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

{
    // the viewer's case: every QRS detected, P waves marked on the first beats only
    for (const id of ['svtLongRP', 'avrt', 'sinus']) {
        const { tr, beats, atrial } = truthMarks(id);
        const A0 = atrial.filter(a => a.tMs <= beats[2].qrsOnMs + 20);
        const c = continueRhythm(beats, A0, tr.durationMs);
        const hitP = atrial.filter(a => c.atrial.some(x => Math.abs(x.tMs - a.tMs) <= 40)).length;
        ok(`${id}, all QRS known: no QRS added, P ${hitP}/${atrial.length}`, c.added.beats.length === 0 && hitP >= atrial.length - 2);
    }
}

console.log('\nthe suggestion is the scenario\'s reading (ambiguous strips: any reading not excluded)');
const AMBIGUOUS = { svtShortRP: ['avnrt', 'avrt', 'at', 'jt'], svtLongRP: ['pjrt', 'at', 'avnrt'], apparentChb: ['avb3', 'hisExtra', 'avnodal'] };
for (const sc of SYNTH_SCENARIOS) {
    const { tr, beats, atrial } = truthMarks(sc.id);
    const s = suggestReading(beats, atrial, tr.af ? { afib: true } : {});
    if (AMBIGUOUS[sc.id]) ok(`${sc.id}: ${s.id} is one of ${AMBIGUOUS[sc.id].join('/')}`, AMBIGUOUS[sc.id].includes(s.id));
    else ok(`${sc.id}: suggested ${s.id} (expected ${sc.expect})`, s.id === sc.expect);
    if (!tr.af) ok(`${sc.id}: a false automatic AF call is vetoed`, suggestReading(beats, atrial, { afib: true }).id === s.id);
}
ok('wenckebach: not dissociated', !R('wenckebach').dissociated);
ok('chbVent: wide and dissociated', R('chbVent').wide && R('chbVent').dissociated);
ok('pvcBigeminy: regular groups of 2', R('pvcBigeminy').rrPeriod === 2 && R('pvcBigeminy').afVeto);

console.log('\nthe suggestion from the detector alone (drop an ECG, nothing marked)');
for (const sc of SYNTH_SCENARIOS) {
    const rec = makeExample(sc.id), m = detectMarks(rec);
    const s = suggestReading(m.beats, m.atrial, rec.metadata.truth.af ? { afib: true } : {});
    // flutter 2:1 shows one F wave per QRS to the detector (read as AT); the ambiguous strips: any non-excluded reading
    const okSet = { ...AMBIGUOUS, flutter21: ['flutter', 'at'] }[sc.id];
    if (okSet) ok(`${sc.id} (detector): ${s.id} is one of ${okSet.join('/')}`, okSet.includes(s.id));
    else ok(`${sc.id} (detector): suggested ${s.id} (expected ${sc.expect})`, s.id === sc.expect);
}

console.log('\ncontinue: jitter, both directions, groups');
{
    // the reported case: beats 4–7 marked by hand (PR jitter up to 55 ms), then Continue
    const { tr, beats, atrial } = truthMarks('sinus');
    const jit = [0, 55, -50, 45];
    const B0 = beats.slice(3, 7), A0 = B0.map((b, i) => ({ id: 'j' + i, tMs: atrial.find(a => a.tMs < b.qrsOnMs && a.tMs > b.qrsOnMs - 400).tMs + jit[i] }));
    const c = continueRhythm(B0, A0, tr.durationMs, { fromMs: 0 });
    const perBeat = c.beats.map(b => c.atrial.filter(a => a.tMs < b.qrsOnMs - 20 && a.tMs > b.qrsOnMs - 400).length);
    ok(`sinus beats 4–7 with jitter: one P before every QRS (${perBeat.join('')})`, perBeat.every(x => x === 1));
    const hitQ = beats.filter(b => c.beats.some(x => Math.abs(x.qrsOnMs - b.qrsOnMs) <= 30)).length;
    ok(`sinus beats 4–7: all QRS both ways (${hitQ}/${beats.length})`, hitQ >= beats.length - 1);
    ok('sinus beats 4–7: beats added before the first mark', c.added.beats.some(b => b.qrsOnMs < B0[0].qrsOnMs));
    const hitP = atrial.filter(a => c.atrial.some(x => Math.abs(x.tMs - a.tMs) <= 60)).length;
    ok(`sinus beats 4–7: P within 60 ms (${hitP}/${atrial.length})`, hitP >= atrial.length - 1);
}
{
    const { tr, beats, atrial } = truthMarks('svtLongRP');
    const B0 = beats.slice(3, 7), A0 = atrial.filter(a => a.tMs > B0[0].qrsOnMs && a.tMs < B0[3].qrsOnMs + 300);
    const c = continueRhythm(B0, A0, tr.durationMs, { fromMs: 0 });
    const perCycle = c.beats.slice(0, -1).map((b, i) => c.atrial.filter(a => a.tMs >= b.qrsOnMs && a.tMs < c.beats[i + 1].qrsOnMs).length);
    ok(`long RP beats 4–7: exactly one P per cycle (${perCycle.join('')})`, perCycle.every(x => x === 1));
}
{
    const { tr, beats, atrial } = truthMarks('twoToOne');
    const B0 = beats.slice(1, 4), A0 = atrial.filter(a => a.tMs > B0[0].qrsOnMs - 700 && a.tMs < B0[2].qrsOnMs);
    const c = continueRhythm(B0, A0, tr.durationMs, { fromMs: 0 });
    const hitP = atrial.filter(a => c.atrial.some(x => Math.abs(x.tMs - a.tMs) <= 40)).length;
    const extra = c.atrial.filter(x => !atrial.some(a => Math.abs(x.tMs - a.tMs) <= 40)).length;
    ok(`2:1 from beats 2–4: P ${hitP}/${atrial.length}, ${extra} extra`, hitP >= atrial.length - 1 && extra <= 1);
}
{
    const { tr, beats, atrial } = truthMarks('pvcBigeminy');
    const B0 = beats.slice(2, 6), A0 = atrial.filter(a => a.tMs > B0[0].qrsOnMs - 400 && a.tMs < B0[3].qrsOnMs);
    const c = continueRhythm(B0, A0, tr.durationMs, { fromMs: 0 });
    const hitQ = beats.filter(b => c.beats.some(x => Math.abs(x.qrsOnMs - b.qrsOnMs) <= 30 && (x.quality === 'pvc') === (b.quality === 'pvc'))).length;
    ok(`bigeminy from beats 3–6: QRS both ways with the right kind (${hitQ}/${beats.length})`, hitQ >= beats.length - 1);
}
{
    const { tr, beats, atrial } = truthMarks('chb');
    const B0 = beats.slice(1, 4), A0 = atrial.filter(a => a.tMs > B0[0].qrsOnMs - 200 && a.tMs < B0[2].qrsOnMs);
    const c = continueRhythm(B0, A0, tr.durationMs, { fromMs: 0 });
    const hitP = atrial.filter(a => c.atrial.some(x => Math.abs(x.tMs - a.tMs) <= 40)).length;
    ok(`complete block: P at their own rate both ways (${hitP}/${atrial.length})`, hitP >= atrial.length - 1 && c.p?.mode === 'own-rate');
}
{
    // the editor's time axis starts before 0 when the first grid click is not at the left edge
    const { beats, atrial } = truthMarks('sinus');
    const sh = (t) => t - 1200;
    const B0 = beats.slice(3, 6).map(b => ({ ...b, qrsOnMs: sh(b.qrsOnMs), qrsOffMs: sh(b.qrsOffMs) }));
    const A0 = atrial.filter(a => a.tMs > beats[3].qrsOnMs - 400 && a.tMs < beats[5].qrsOnMs).map(a => ({ ...a, tMs: sh(a.tMs) }));
    const c = continueRhythm(B0, A0, 8000, { fromMs: -1200 });
    ok('negative start: continued back to the first beat of the strip', Math.min(...c.beats.map(b => b.qrsOnMs)) < sh(beats[1].qrsOnMs) + 30);
}

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
