// The detector against synthetic ECGs whose every P and QRS onset is known (synth.js metadata.truth).
import { detectMarks } from '../detect.js';
import { SYNTH_SCENARIOS, makeExample } from '../synth.js';

let pass = 0, fail = 0;
const ok = (name, cond) => cond ? (pass++, console.log('  ok   ' + name)) : (fail++, console.log('  FAIL ' + name));
const SINUS_P = new Set(['sinus', 'avb1', 'rbbb', 'lbbb', 'normalSinus', 'mobitz2', 'twoToOne']);

for (const sc of SYNTH_SCENARIOS) {
    const rec = makeExample(sc.id), tr = rec.metadata.truth;
    const m = detectMarks(rec, { lead: 'II' });
    const truthQ = tr.QRS.filter(q => q.t > 150 && q.t < tr.durationMs - 150);
    const tol = (q) => (q.morph === 'normal' ? 30 : 50);
    const hits = truthQ.filter(q => m.beats.some(b => Math.abs(b.qrsOnMs - q.t) <= tol(q))).length;
    const wide = truthQ.some(q => q.morph !== 'normal');
    const need = Math.floor((wide ? 0.7 : 0.85) * truthQ.length);
    console.log(`\n${sc.id}: ${m.beats.length} QRS found / ${tr.QRS.length} true; ${m.atrial.length} P found / ${tr.P.length} true`);
    ok(`${sc.id}: QRS count within ±1`, Math.abs(m.beats.length - tr.QRS.length) <= 1);
    ok(`${sc.id}: QRS onsets within ${wide ? '30/50' : 30} ms (${hits}/${truthQ.length})`, hits >= need);
    if (SINUS_P.has(sc.id)) {
        const conducted = tr.P.filter(p => tr.QRS.some(q => q.t - p.t > 80 && q.t - p.t < 400));
        const ph = conducted.filter(p => m.atrial.some(a => Math.abs(a.tMs - p.t) <= 40)).length;
        ok(`${sc.id}: conducted P onsets within 40 ms (${ph}/${conducted.length})`, ph >= Math.floor(0.7 * conducted.length));
        const falseP = m.atrial.filter(a => !tr.P.some(p => Math.abs(a.tMs - p.t) <= 60)).length;
        ok(`${sc.id}: at most one P where there is none (${falseP})`, falseP <= 1);
    }
    if (sc.id === 'pvcBigeminy') {
        const pvcT = tr.QRS.filter(q => q.morph === 'pvc');
        const flagged = m.beats.filter(b => b.quality === 'pvc');
        const right = flagged.filter(b => pvcT.some(q => Math.abs(q.t - b.qrsOnMs) <= 60)).length;
        ok(`pvcBigeminy: PVCs flagged (${right}/${pvcT.length}, ${flagged.length - right} wrong)`, right >= 0.7 * pvcT.length && flagged.length - right <= 1);
    }
}
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
