// Paced rhythms (the 'paced' reading): the mode is read from the marks flagged paced, a stimulus is its own glyph
// (never the focus asterisk, never a second dot on the V line), and the device's timing is stated, not invented.
//
//   node packages/laddergram-core/test/paced.test.mjs
import { makeExample } from '../synth.js';
import { figureMarkers } from '../figures.js';
import { buildLadder } from '../engine.js';
import { plausibility, suggestReading } from '../rhythm.js';
import { layoutLadder, toLineStyle } from '../export.js';
import { drawEventPx } from '../render.js';
import { ladderActivations } from '../egm.js';
import { makeRecorder } from './mockCanvas.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log(`\n${s}`);
const reading = (id, params = {}, tiers = ['SN', 'A', 'AV', 'His', 'V']) => {
    const rec = makeExample(id);
    const { beats, atrial } = figureMarkers(rec);
    return { beats, atrial, mechanism: 'paced', params, tiers, durationMs: rec.metadata.truth.durationMs };
};
const codes = (L) => L.claims.map(c => c.code);

section('VVI in complete AV block');
{
    const input = reading('vviChb');
    const L = buildLadder(input);
    ok('read as VVI, lower rate 1000 ms from the paced cycles', L.pacing.mode === 'VVI' && L.pacing.lriMs === 1000, JSON.stringify(L.pacing));
    const stims = L.events.filter(e => e.style === 'stim');
    ok('one ventricular stimulus per paced QRS, and no other glyph for them', stims.length === input.beats.length && stims.every(e => e.role === 'stim-ventricular' && e.tier === 'V'));
    ok('no asterisk: a paced beat is not a focus', !L.events.some(e => e.style === 'asterisk'));
    ok('no QRS dot beside the stimulus (one mark per activation on the V line)', !L.events.some(e => e.role === 'qrs'));
    ok('every P is blocked (the device does not track in VVI)', input.atrial.every(a => L.paths.some(p => p.atrialId === a.id && p.role === 'av-block')));
    ok('no P is drawn as preempted', !L.paths.some(p => p.role === 'av-preempted'));
    ok('the sentence names the mode and the assumption', codes(L).includes('paced-mode') && /VVI/.test(L.notes[0]) && /VRP 250 ms is assumed/.test(L.notes[0]));
}

section('DDD: tracking, then both chambers paced');
{
    const input = reading('ddd');
    const L = buildLadder(input);
    ok('read as DDD with an AV delay of 160 ms', L.pacing.mode === 'DDD' && L.pacing.aviMs === 160, JSON.stringify(L.pacing));
    ok('the lower rate comes from the paced atrial cycles (1000 ms)', L.pacing.lriMs === 1000);
    ok('every P the ventricle follows is preempted, not blocked', L.pacing.tracked.length === input.beats.length
       && L.pacing.tracked.every(t => L.paths.some(p => p.atrialId === t.atrialId && p.role === 'av-preempted' && p.style === 'dashed'))
       && !L.paths.some(p => p.role === 'av-block'));
    const aStims = L.events.filter(e => e.role === 'stim-atrial');
    ok('a stimulus on each paced atrium, at the top of the A tier', aStims.length === input.atrial.filter(a => a.origin === 'paced').length && aStims.every(e => e.tier === 'A' && e.frac === 0));
    ok('the sensed P waves keep their sinus-node line', L.paths.filter(p => p.role === 'sa').length === input.atrial.filter(a => a.origin !== 'paced').length);
}

section('DDD tracking only: the V–V cycle is the sinus rate, not the lower rate');
{
    const atrial = [0, 1, 2, 3].map(i => ({ id: 'a' + i, tMs: 200 + i * 800 }));
    const beats = atrial.map((a, i) => ({ id: 'b' + i, qrsOnMs: a.tMs + 150, qrsOffMs: a.tMs + 310, origin: 'paced' }));
    const L = buildLadder({ beats, atrial, mechanism: 'paced', durationMs: 3400 });
    ok('mode DDD, AV delay 150, no lower rate claimed', L.pacing.mode === 'DDD' && L.pacing.aviMs === 150 && L.pacing.lriMs === null);
}

section('AAI: the atrium paced, the ventricles conducted');
{
    const atrial = [0, 1, 2, 3].map(i => ({ id: 'a' + i, tMs: 200 + i * 900, origin: 'paced' }));
    const beats = atrial.map((a, i) => ({ id: 'b' + i, qrsOnMs: a.tMs + 190, qrsOffMs: a.tMs + 280 }));
    const L = buildLadder({ beats, atrial, mechanism: 'paced', durationMs: 3800 });
    ok('mode AAI, lower rate 900 ms', L.pacing.mode === 'AAI' && L.pacing.lriMs === 900);
    ok('each paced P conducts through the node to its own QRS', atrial.every(a => L.paths.some(p => p.atrialId === a.id && p.role === 'av')));
    ok('the ventricles keep their QRS dot (they are not paced)', L.events.filter(e => e.role === 'qrs').length === 4);
}

section('what the device should not have done, said as a caution');
{
    const beats = [0, 1, 2, 3].map(i => ({ id: 'b' + i, qrsOnMs: 500 + i * 1000, qrsOffMs: 660 + i * 1000, origin: 'paced' }));
    const early = [...beats, { id: 'bx', qrsOnMs: 2700, qrsOffMs: 2860, origin: 'paced' }];
    const L = buildLadder({ beats: early, atrial: [], mechanism: 'paced', durationMs: 4500 });
    ok('a paced QRS 200 ms after the previous one: inside VRP', codes(L).includes('paced-inside-vrp'));
    const native = [...beats.slice(0, 2), { id: 'bn', qrsOnMs: 2100, qrsOffMs: 2190 }, { id: 'b3', qrsOnMs: 2500, qrsOffMs: 2660, origin: 'paced' }];
    ok('a paced QRS 400 ms after a sensed one in VVI: undersensing', codes(buildLadder({ beats: native, atrial: [], mechanism: 'paced', durationMs: 4000 })).includes('paced-undersense'));
    ok('a lower rate set 200 ms away from the paced cycles: a caution', codes(buildLadder({ beats, atrial: [], mechanism: 'paced', params: { LRI: 800 }, durationMs: 4500 })).includes('paced-lri'));
    ok('no paced mark: the reading says what to flag', codes(buildLadder({ ...reading('sinus'), beats: figureMarkers(makeExample('sinus')).beats })).includes('paced-none'));
}

section('the rules: paced only with paced marks, and suggested with them');
{
    const { beats, atrial } = reading('vviChb');
    ok('with paced marks: suggested', suggestReading(beats, atrial).id === 'paced');
    ok('… and every other reading carries a caution', plausibility(beats, atrial).verdicts.avb3.status === 'caution');
    const plain = beats.map(({ origin, ...b }) => b);
    ok('without them: excluded', plausibility(plain, atrial).verdicts.paced.status === 'excluded');
}

section('drawn, exported and read as electrograms');
{
    const ctx = makeRecorder();
    drawEventPx(ctx, { x: 100, y: 50, style: 'stim' });
    ok('the stimulus glyph is a stroked spike, not a dot', !ctx.__log.some(c => c[0] === 'arc') && ctx.__log.filter(c => c[0] === 'lineTo').length === 3);
    const L = buildLadder(reading('ddd'));
    const idx = Object.fromEntries(L.tiers.map((t, i) => [t, i]));
    const lay = layoutLadder(toLineStyle(L), { tMinMs: 0, tMaxMs: 10000, xOf: (t) => t / 10, yOfLevel: (lv) => lv * 40, lineIdOfLevel: (lv) => `line-${Math.round(lv)}` });
    void idx;
    const stimPts = lay.points.filter(p => p.pointStyle === 'stim');
    ok('the editor gets its points with pointStyle "stim"', stimPts.length === L.events.filter(e => e.style === 'stim').length, `${stimPts.length}`);
    const acts = ladderActivations(L, { beats: reading('ddd').beats });
    ok('EP view: each paced QRS is a ventricular activation from the RV apex', acts.filter(a => a.kind === 'V' && a.paced && a.origin === 'RV').length === reading('ddd').beats.length);
    ok('… and each paced atrium one from the high right atrium', acts.filter(a => a.kind === 'A' && a.paced && a.origin === 'highRA').length === reading('ddd').atrial.filter(a => a.origin === 'paced').length);
}

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
