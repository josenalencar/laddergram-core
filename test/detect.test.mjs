// The detector against synthetic ECGs whose every P and QRS onset is known (synth.js metadata.truth).
import { detectMarks } from '../detect.js';
import { SYNTH_SCENARIOS, makeExample } from '../synth.js';

let pass = 0, fail = 0;
const ok = (name, cond) => cond ? (pass++, console.log('  ok   ' + name)) : (fail++, console.log('  FAIL ' + name));

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
    // every P a reader can see: not inside a QRS, nor in the ST of an ectopic beat (100 ms after its end)
    const W = { normal: 95, pvc: 170, vt: 165, lbbb: 160, rbbb: 140, fusion: 125 };
    const vis = tr.P.filter(p => !tr.QRS.some(q => p.t >= q.t - 10 && p.t <= q.t + (W[q.morph] ?? 95) + (q.morph === 'pvc' || q.morph === 'vt' ? 100 : 0)));
    if (vis.length) {
        const found = vis.filter(p => m.atrial.some(a => Math.abs(a.tMs - p.t) <= 40)).length;
        const need = vis.length <= 5 ? Math.max(0, vis.length - 1) : Math.ceil(0.8 * vis.length);
        ok(`${sc.id}: visible P onsets within 40 ms (${found}/${vis.length}, sinus, blocked, retrograde and dissociated)`, found >= need);
    }
    if (!tr.flutter) {
        const falseP = m.atrial.filter(a => !tr.P.some(p => Math.abs(a.tMs - p.t) <= 60)).length;
        ok(`${sc.id}: at most one false P per 10 s (${falseP})`, falseP <= Math.ceil(tr.durationMs / 10000));
    }
    ok(`${sc.id}: no P inside a detected QRS`, !m.atrial.some(a => m.beats.some(b => a.tMs > b.qrsOnMs + 5 && a.tMs < b.qrsOffMs - 5)));
    if (sc.id === 'pvcBigeminy') {
        const pvcT = tr.QRS.filter(q => q.morph === 'pvc');
        const flagged = m.beats.filter(b => b.quality === 'pvc');
        const right = flagged.filter(b => pvcT.some(q => Math.abs(q.t - b.qrsOnMs) <= 60)).length;
        ok(`pvcBigeminy: PVCs flagged (${right}/${pvcT.length}, ${flagged.length - right} wrong)`, right >= 0.7 * pvcT.length && flagged.length - right <= 1);
    }
}
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
