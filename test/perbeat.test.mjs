// A beat may carry timings of its own. They must reach the drawing — the focus as well as the His —
// and they must decide that beat's retrograde conduction on their own, whatever the ladder does.
import { buildLadder } from '../engine.js';

let pass = 0, fail = 0;
const ok = (name, cond) => cond ? (pass++, console.log('  ok   ' + name)) : (fail++, console.log('  FAIL ' + name));

const sinus = (n, rr = 900, pr = 160) => ({
    beats: Array.from({ length: n }, (_, i) => ({ id: 'b' + i, qrsOnMs: 500 + i * rr, qrsOffMs: 500 + i * rr + 90, quality: 'normal' })),
    atrial: Array.from({ length: n }, (_, i) => ({ id: 'a' + i, tMs: 500 + i * rr - pr })),
});
const retroOf = (L, beatId) => L.events.find(e => e.role === 'p-retro' && e.beatId === beatId);

console.log('\nretrograde conduction of one beat');
{
    // A PVC among sinus beats, the ladder concealing every retrograde wave.
    const { beats, atrial } = sinus(4);
    const pvc = { id: 'pvc1', qrsOnMs: 500 + 2 * 900 + 400, qrsOffMs: 500 + 2 * 900 + 400 + 160, quality: 'pvc' };
    const all = [...beats, pvc].sort((a, b) => a.qrsOnMs - b.qrsOnMs);
    const plain = buildLadder({ beats: all, atrial, mechanism: 'pvc', params: { ectopicVA: null }, durationMs: 5000 });
    ok('ladder conceals: no retrograde P', !retroOf(plain, 'pvc1'));

    const own = buildLadder({
        beats: all.map(b => (b.id === 'pvc1' ? { ...b, params: { ectopicVA: 160 } } : b)),
        atrial, mechanism: 'pvc', params: { ectopicVA: null }, durationMs: 5000,
    });
    const ev = retroOf(own, 'pvc1');
    ok('the beat’s own VA draws its retrograde P even when the ladder conceals', !!ev && Math.abs(ev.tMs - (pvc.qrsOnMs + 160)) <= 1);
    ok('no other beat gained one', own.events.filter(e => e.role === 'p-retro').length === 1);
}
{
    // The other way: the ladder draws them, this beat does not.
    const { beats, atrial } = sinus(4);
    const pvc = { id: 'pvc1', qrsOnMs: 500 + 2 * 900 + 400, qrsOffMs: 500 + 2 * 900 + 400 + 160, quality: 'pvc' };
    const all = [...beats, pvc].sort((a, b) => a.qrsOnMs - b.qrsOnMs);
    const drawn = buildLadder({ beats: all, atrial, mechanism: 'pvc', params: { ectopicVA: 160 }, durationMs: 5000 });
    ok('ladder draws them: a retrograde P', !!retroOf(drawn, 'pvc1'));
    const own = buildLadder({
        beats: all.map(b => (b.id === 'pvc1' ? { ...b, params: { ectopicVA: null } } : b)),
        atrial, mechanism: 'pvc', params: { ectopicVA: 160 }, durationMs: 5000,
    });
    ok('the beat’s own empty VA conceals it', !retroOf(own, 'pvc1'));
    ok('and it is drawn concealed instead', own.paths.some(p => p.beatId === 'pvc1' && p.role === 'av-concealed'));
}

console.log('\nthe focus of a beat with its own timings');
{
    // Complete block with a narrow escape: the junctional focus sits HV before the QRS.
    const beats = [0, 1400, 2800, 4200].map((t, i) => ({ id: 'b' + i, qrsOnMs: t, qrsOffMs: t + 90, quality: 'normal' }));
    const atrial = Array.from({ length: 6 }, (_, i) => ({ id: 'a' + i, tMs: 200 + i * 800 }));
    const own = beats.map(b => (b.id === 'b2' ? { ...b, params: { HV: 80 } } : b));
    const L = buildLadder({ beats: own, atrial, mechanism: 'avb3', params: { HV: 45, blockBelowHis: 0 }, durationMs: 5200 });
    const foc = (id) => L.events.find(e => e.role === 'focus-junctional' && e.beatId === id);
    ok('a beat with its own HV moves its junctional focus', !!foc('b2') && Math.abs(foc('b2').tMs - (2800 - 80)) <= 1);
    ok('the other beats keep the ladder’s HV', !!foc('b1') && Math.abs(foc('b1').tMs - (1400 - 45)) <= 1);
}
{
    // A ventricular focus: its own vExit and HV set where the retrograde climb starts and ends.
    const { beats, atrial } = sinus(4);
    const pvc = { id: 'pvc1', qrsOnMs: 500 + 2 * 900 + 400, qrsOffMs: 500 + 2 * 900 + 400 + 160, quality: 'pvc', params: { vExit: 90, HV: 70 } };
    const all = [...beats, pvc].sort((a, b) => a.qrsOnMs - b.qrsOnMs);
    const L = buildLadder({ beats: all, atrial, mechanism: 'pvc', params: { ectopicVA: null, vExit: 40, HV: 45 }, durationMs: 5000 });
    const his = L.paths.find(p => p.beatId === 'pvc1' && p.role === 'his-retro');
    ok('its own vExit and HV carry the retrograde climb', !!his && Math.abs(his.to.tMs - (pvc.qrsOnMs + 90 + 70)) <= 1);
}

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
