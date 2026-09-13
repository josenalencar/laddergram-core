// A dot whose position IS a parameter says so, so an editor can let a reader drag it instead of typing
// the number. The rule is one: the value is the anchor's time minus the handle's time.
import { buildLadder, DEFAULT_PARAMS } from '../engine.js';
import { layoutLadder } from '../export.js';

let pass = 0, fail = 0;
const ok = (name, cond) => cond ? (pass++, console.log('  ok   ' + name)) : (fail++, console.log('  FAIL ' + name));

const strip = (params = {}) => {
    const beats = [0, 900, 1800].map((t, i) => ({ id: 'b' + i, qrsOnMs: t + 300, qrsOffMs: t + 390, quality: 'normal' }));
    const atrial = [0, 900, 1800].map((t, i) => ({ id: 'a' + i, tMs: t + 140 }));
    return { beats, atrial, L: buildLadder({ beats, atrial, mechanism: 'avnodal', params, tiers: ['SN', 'A', 'AV', 'His', 'V'], durationMs: 3000 }) };
};
const laidOut = (L) => {
    let n = 0, c = 0;
    return layoutLadder(L, { tMinMs: 0, tMaxMs: 3000, xOf: t => t, yOfLevel: lv => lv * 30, lineIdOfLevel: lv => 'L' + Math.round(lv),
                             newPointId: () => 'p' + (n++), newConnectionId: () => 'c' + (c++), points: [], connections: [] });
};

console.log('\nthe dots that stand for a timing');
{
    const { beats, atrial, L } = strip();
    const pts = laidOut(L).points.filter(p => p.timeHandle);
    const hv = pts.filter(p => p.timeHandle.param === 'HV');
    const sact = pts.filter(p => p.timeHandle.param === 'SACT');
    ok(`one His dot per beat (${hv.length}/${beats.length})`, hv.length === beats.length);
    ok(`one sinus dot per P (${sact.length}/${atrial.length})`, sact.length === atrial.length);
    // The one rule: value = anchor time − handle time.
    const beatOf = (id) => beats.find(b => b.id === id);
    ok('every His dot is HV before its QRS onset', hv.every(p => Math.abs((beatOf(p.timeHandle.beatId).qrsOnMs - p.x) - DEFAULT_PARAMS.HV) <= 1));
    const atrialOf = (id) => atrial.find(a => a.id === id);
    ok('every sinus dot is SACT before its P', sact.every(p => Math.abs((atrialOf(p.timeHandle.atrialId).tMs - p.x) - DEFAULT_PARAMS.SACT) <= 1));
    ok('each handle names the mark it is measured from', hv.every(p => !!p.timeHandle.beatId) && sact.every(p => !!p.timeHandle.atrialId));
}
{
    // Change the parameter and the dot moves by exactly that much: the rule holds, so the drag inverts.
    const { beats, L } = strip({ HV: 70 });
    const hv = laidOut(L).points.filter(p => p.timeHandle?.param === 'HV');
    ok('a longer HV moves every His dot earlier by the same amount',
       hv.every(p => Math.abs((beats.find(b => b.id === p.timeHandle.beatId).qrsOnMs - p.x) - 70) <= 1));
}
{
    // A beat with its own HV: its dot moves, its neighbours' do not.
    const beats = [0, 900, 1800].map((t, i) => ({ id: 'b' + i, qrsOnMs: t + 300, qrsOffMs: t + 390, quality: 'normal' }));
    const atrial = [0, 900, 1800].map((t, i) => ({ id: 'a' + i, tMs: t + 140 }));
    const own = beats.map(b => (b.id === 'b1' ? { ...b, params: { HV: 90 } } : b));
    const L = buildLadder({ beats: own, atrial, mechanism: 'avnodal', tiers: ['SN', 'A', 'AV', 'His', 'V'], durationMs: 3000 });
    const at = (id) => laidOut(L).points.find(p => p.timeHandle?.param === 'HV' && p.timeHandle.beatId === id);
    ok('a beat with its own HV places its own dot', Math.abs((1200 - at('b1').x) - 90) <= 1);
    ok('its neighbours keep the ladder’s', Math.abs((300 - at('b0').x) - DEFAULT_PARAMS.HV) <= 1);
}
{
    // No His tier, no His dot to drag; no sinus tier, no sinus dot.
    const beats = [0, 900].map((t, i) => ({ id: 'b' + i, qrsOnMs: t + 300, qrsOffMs: t + 390, quality: 'normal' }));
    const atrial = [0, 900].map((t, i) => ({ id: 'a' + i, tMs: t + 140 }));
    const L = buildLadder({ beats, atrial, mechanism: 'avnodal', tiers: ['A', 'AV', 'V'], durationMs: 2000 });
    const pts = laidOut(L).points.filter(p => p.timeHandle);
    ok('a ladder without those tiers offers no handle', pts.length === 0);
}
{
    // A dot clipped off the start of the strip is not a handle: it is not where the timing is.
    const beats = [{ id: 'b0', qrsOnMs: 30, qrsOffMs: 120, quality: 'normal' }];
    const atrial = [{ id: 'a0', tMs: 10 }];
    const L = buildLadder({ beats, atrial, mechanism: 'avnodal', tiers: ['SN', 'A', 'AV', 'His', 'V'], durationMs: 2000 });
    let n = 0, c = 0;
    const out = layoutLadder(L, { tMinMs: 0, tMaxMs: 2000, xOf: t => t, yOfLevel: lv => lv * 30, lineIdOfLevel: lv => 'L' + Math.round(lv),
                                  newPointId: () => 'p' + (n++), newConnectionId: () => 'c' + (c++), points: [], connections: [] });
    ok('a clipped sinus dot carries no handle', !out.points.some(p => p.timeHandle?.param === 'SACT'));
}

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
