// Refractory periods (periods.js): a bar is drawn only where it explains a block, it never covers a conducted
// wave other than the one that made the structure refractory, and it agrees with the live heart (epsim.js),
// which models the same recovery.
//
//   node packages/laddergram-core/test/periods.test.mjs
import { SYNTH_SCENARIOS, makeExample } from '../synth.js';
import { figureMarkers } from '../figures.js';
import { MECHANISMS, buildLadder } from '../engine.js';
import { ladderPeriods, cleanPeriods } from '../periods.js';
import { fromReading, createSim } from '../epsim.js';
import { composeStack, frameGroups } from '../stack.js';
import { makeLayout, makeView, resolvePeriods, drawFrame } from '../render.js';
import { makeRecorder } from './mockCanvas.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log(`\n${s}`);
const TIERS = ['SN', 'A', 'AV', 'His', 'V'];
const reading = (id, mechanism, params = {}, tiers = TIERS) => {
    const rec = makeExample(id);
    const { beats, atrial } = figureMarkers(rec);
    return { beats, atrial, mechanism, params, tiers, durationMs: rec.metadata.truth.durationMs };
};

section('every scenario × every mechanism: well-formed, and every bar explains a block');
{
    let n = 0, bad = [], unexplained = [], covering = [];
    for (const sc of SYNTH_SCENARIOS) for (const { id: mech } of MECHANISMS) {
        const input = reading(sc.id, mech);
        let r;
        try { r = ladderPeriods(input); } catch (e) { bad.push(`${sc.id}/${mech} threw ${e.message}`); continue; }
        n++;
        const L = buildLadder(input);
        for (const p of r.periods) {
            if (p.kind === 'timing') {                   // a device's timing: it explains no block, and is only the paced reading's
                if (mech !== 'paced' || !(p.t1Ms > p.t0Ms)) bad.push(`${sc.id}/${mech} ${p.id}`);
                continue;
            }
            if (![p.t0Ms, p.t1Ms, p.t1HiMs].every(Number.isFinite) || !(p.t1Ms > p.t0Ms) || p.t1HiMs < p.t1Ms) bad.push(`${sc.id}/${mech} ${p.id}`);
            // the block it explains: a P blocked in the node (or below the His) that arrives inside the bar
            const blocked = L.paths.find(q => q.terminal === 'block' && q.atrialId === p.explains && (q.role === 'av-block' || q.role === 'his-block'));
            if (!blocked || blocked.from.tMs < p.t0Ms - 0.5 || blocked.from.tMs > p.t1HiMs + 0.5) unexplained.push(`${sc.id}/${mech} ${p.id}`);
            // no conducted wave of the same structure enters inside the bar, except the one that owns it
            if (p.kind === 'erp') {
                const role = p.tier === 'His' ? 'his' : 'av';
                const inside = L.paths.filter(q => q.role === role && q.from.tMs > p.t0Ms + 0.5 && q.from.tMs < p.t1Ms - 0.5);
                if (inside.length) covering.push(`${sc.id}/${mech} ${p.id} covers ${inside.length}`);
            }
        }
    }
    ok(`${n} readings: no throw, finite bars in time order`, !bad.length, bad.slice(0, 5).join('; '));
    ok('every bar explains a blocked wave that arrives inside it', !unexplained.length, unexplained.slice(0, 5).join('; '));
    ok('no refractory bar covers a wave that conducted through the same structure', !covering.length, covering.slice(0, 5).join('; '));
}

section('what is drawn, reading by reading');
{
    const av21 = ladderPeriods(reading('twoToOneIvcd', 'avnodal'));
    ok('2:1 in the AV node: one bar per blocked P, in the AV tier', av21.periods.length === 2 && av21.periods.every(p => p.tier === 'AV' && p.kind === 'erp'), JSON.stringify(av21.periods.map(p => p.tier)));
    ok('… with the recovery span stated as a span', av21.claims.some(c => c.code === 'periods-av' && /blocked after \d+ ms/.test(c.text) && /conducted after \d+ ms/.test(c.text)));
    const his21 = ladderPeriods(reading('twoToOneIvcd', 'avnodal', { blockBelowHis: 1, HV: 70 }));
    ok('2:1 below the His: bars in the His tier', his21.periods.length === 2 && his21.periods.every(p => p.tier === 'His'));
    const noHis = ladderPeriods(reading('twoToOneIvcd', 'avnodal', { blockBelowHis: 1, HV: 70 }, ['SN', 'A', 'AV', 'V']));
    ok('… and without a His tier: no bar, a sentence', !noHis.periods.length && noHis.claims.some(c => c.code === 'periods-need-his'));
    const wb = ladderPeriods(reading('wenckebach', 'avnodal'));
    ok('Wenckebach: a bar at each dropped P, hatched over the recovery span', wb.periods.length >= 2 && wb.periods.every(p => p.t1HiMs > p.t1Ms));
    const m2 = ladderPeriods(reading('mobitz2', 'avnodal'));
    ok('Mobitz II: no bar — recovery does not explain it — and a sentence says so', !m2.periods.length && m2.claims.some(c => c.code === 'periods-none-pattern'));
    const chb = ladderPeriods(reading('chb', 'avb3'));
    ok('complete block: no bar, a sentence', !chb.periods.length && chb.claims.some(c => c.code === 'periods-none-complete'));
    const hx = ladderPeriods(reading('twoToOneIvcd', 'hisExtra', { hPrimeLead: 150 }));
    ok('concealed His extrasystoles: concealment bars running to the blocked P', hx.periods.length >= 2 && hx.periods.every(p => p.kind === 'conceal'));
    const sinus = ladderPeriods(reading('sinus', 'avnodal'));
    ok('sinus rhythm with every P conducted: nothing to explain, nothing drawn', !sinus.periods.length && !sinus.claims.length);
    ok('cleanPeriods keeps { show: true } and drops anything else', cleanPeriods({ show: true })?.show === true && cleanPeriods({ show: 'yes' }) === null && cleanPeriods(null) === null);
}

section('a pacemaker: its timing, not refractoriness');
{
    const vvi = ladderPeriods(reading('vviChb', 'paced'));
    ok('VVI: a VRP bar in the V tier after each ventricular event, nothing else', vvi.periods.length > 0 && vvi.periods.every(p => p.kind === 'timing' && p.tier === 'V' && p.t1Ms - p.t0Ms === 250));
    ok('… and a sentence that it is the device\'s timing', vvi.claims.some(c => c.code === 'periods-paced' && /VRP 250/.test(c.text) && !/PVARP/.test(c.text)));
    const ddd = ladderPeriods(reading('ddd', 'paced'));
    const tiers = new Set(ddd.periods.map(p => p.tier));
    ok('DDD: VRP (V), PVARP (A) and the AV delay (AV)', tiers.has('V') && tiers.has('A') && tiers.has('AV'));
    const avi = ddd.periods.filter(p => p.tier === 'AV');
    ok('… the AV delay is 160 ms, tracked and paced alike', avi.length >= 8 && avi.every(p => Math.abs(p.t1Ms - p.t0Ms - 160) <= 1), avi.map(p => p.t1Ms - p.t0Ms).join(','));
    const none = ladderPeriods(reading('sinus', 'paced'));
    ok('no paced mark: no timing drawn', !none.periods.length);
}

section('the live heart blocks where the bars are (epsim.js models the same recovery)');
{
    for (const [id, mech, params] of [['twoToOneIvcd', 'avnodal', {}], ['twoToOneNarrow', 'avnodal', {}], ['twoToOne', 'avnodal', {}],
                                      ['wenckebach', 'avnodal', {}], ['twoToOneIvcd', 'avnodal', { blockBelowHis: 1, HV: 70 }]]) {
        const input = reading(id, mech, params);
        const { periods } = ladderPeriods(input);
        const s = createSim(fromReading(input));
        s.runUntil(input.durationMs);
        const acts = s.activations(0, input.durationMs);
        const A = acts.filter(a => a.kind === 'A').map(a => a.tMs), H = acts.filter(a => a.kind === 'H').map(a => a.tMs);
        const V = acts.filter(a => a.kind === 'V').map(a => a.tMs);
        const lastQ = Math.max(...input.beats.map(b => b.qrsOnMs));
        const infra = params.blockBelowHis >= 0.5;
        // a live block: in the node, a P with no His before the next P; below the His, a His with no V after it
        const blocked = infra
            ? H.filter((t, i) => !V.some(v => v > t && v < (H[i + 1] ?? Infinity)))
            : A.filter((t, i) => !H.some(h => h > t && h < (A[i + 1] ?? Infinity)));
        // judged between the first conducted wave (a block before it met a conduction from before the strip, which
        // the ladder cannot show) and the last QRS (beyond it the ladder cuts the strip)
        const firstConducted = infra ? Math.min(...H.filter(t => !blocked.includes(t))) : Math.min(...A.filter(t => !blocked.includes(t)));
        const judged = blocked.filter(t => t > firstConducted && t < lastQ);
        const outside = judged.filter(t => !periods.some(p => t >= p.t0Ms - 60 && t <= p.t1HiMs + 60));
        ok(`${id} ${mech}${infra ? ' (below the His)' : ''}: ${judged.length} live blocks, all inside a static bar`, judged.length > 0 && !outside.length,
           `outside: ${outside.map(Math.round)}; bars ${periods.map(p => `${Math.round(p.t0Ms)}–${Math.round(p.t1HiMs)}`)}`);
    }
}

section('drawn behind the ladder, only when asked for');
{
    const input = reading('twoToOneIvcd', 'avnodal');
    const off = composeStack([{ ...input }], { durationMs: input.durationMs });
    const on = composeStack([{ ...input, periods: { show: true } }], { durationMs: input.durationMs });
    ok('without periods.show the stack carries none', off[0].periodList === null && frameGroups(off).current.periods === null);
    ok('with periods.show the stack carries the bars to the frame', frameGroups(on).current.periods?.length === 2);
    const layout = makeLayout({ groups: [input.tiers] });
    const view = makeView({ speedMmS: 25, t0Ms: 0 });
    const px = resolvePeriods(frameGroups(on).current.periods, view, layout, 0);
    ok('resolved into the AV band of the ladder', px.length === 2 && px.every(r => r.y0 >= layout.groups[0].bands.AV.top && r.y1 <= layout.groups[0].bands.AV.bottom));
    const draw = (fg) => {
        const ctx = makeRecorder();
        drawFrame(ctx, { view, layout, cssW: 1000, strip: { sig: new Float32Array(10), fs: 500, gaps: null }, beats: input.beats, atrial: input.atrial, ...fg });
        return ctx.__log;
    };
    const logOff = draw(frameGroups(off)), logOn = draw(frameGroups(on));
    const fills = (log) => log.filter(c => c[0] === 'fillRect').length;
    ok('the frame with periods paints two more boxes, and the one without is unchanged by the feature', fills(logOn) === fills(logOff) + 2, `${fills(logOff)} → ${fills(logOn)}`);

    const firstPeriod = logOn.findIndex(c => c[0] === '=fillStyle' && String(c[1][0]).startsWith('rgba(217, 119, 6'));
    ok('the bars are painted before the first conduction line of the ladder', firstPeriod >= 0 && firstPeriod < logOn.findIndex((c, i) => i > firstPeriod && c[0] === 'stroke'), `${firstPeriod}`);
}

section('a reading this engine does not know is not passed off as sinus rhythm');
{
    const L = buildLadder({ ...reading('sinus', 'avnodal'), mechanism: 'someday' });
    ok('unknownMechanism is kept and a caution says so', L.unknownMechanism === 'someday' && L.claims.some(c => c.code === 'unknown-mechanism' && c.level === 'caution'));
    ok('a known one has no such caution', !buildLadder(reading('sinus', 'avnodal')).claims.some(c => c.code === 'unknown-mechanism'));
}

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
