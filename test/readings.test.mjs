// Named readings and their ranking (plausibility P2, laddergram-core 1.27): every synthetic scenario's reading is
// ranked first on its true marks; evidence ranks but never excludes; without evidence the verdicts are P1's,
// exactly (the rhythm detector's timing gate); the drawings the subtypes need (SA exit block on the SN tier, the
// pacemaker's PM row, a strip in segments) and the file format carrying them.
//
//   node packages/laddergram-core/test/readings.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SYNTH_SCENARIOS, makeExample } from '../synth.js';
import { detectMarks } from '../detect.js';
import { buildLadder, MECHANISMS, TIER_CATALOG, normalizeTiers, sinoatrialPattern, readPacing, PLAUSIBILITY_VERSION } from '../engine.js';
import { plausibility, rankReadings, avConduction, saConduction, flutterConduction, READINGS, READING_FAMILIES, readingOf, suggestReading } from '../rhythm.js';
import { toLaddergramJson, fromLaddergramJson } from '../export.js';
import { FIGURES, figurePanels } from '../figures.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => cond ? (pass++, console.log('  ok   ' + name)) : (fail++, console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')));
const section = (s) => console.log(`\n${s}`);
const W = { normal: 90, pvc: 150, capture: 90, fusion: 120, rbbb: 140, lbbb: 160, paced: 160, vt: 165, ivcd: 110 };
function truthMarks(id) {
    const tr = makeExample(id).metadata.truth;
    const beats = tr.QRS.map((q, i) => ({ id: 'b' + i, qrsOnMs: q.t, qrsOffMs: q.t + (W[q.morph] ?? 140), qrsWidthMs: W[q.morph] ?? 140,
        quality: q.morph === 'pvc' ? 'pvc' : 'normal', ...(q.paced ? { origin: 'paced' } : {}) }));
    let atrial = tr.P.map((p, i) => ({ id: 'a' + i, tMs: p.t, ...(p.paced ? { origin: 'paced' } : {}) }));
    if (tr.flutter) { atrial = []; for (let t = tr.flutter.phaseMs; t < tr.durationMs; t += tr.flutter.cycleMs) atrial.push({ id: 'f' + atrial.length, tMs: t }); }
    return { tr, beats, atrial };
}

section('the catalogue');
ok(`PLAUSIBILITY_VERSION is P2.1 (${PLAUSIBILITY_VERSION})`, PLAUSIBILITY_VERSION === 'P2.1');
ok('every reading draws with a mechanism the engine knows', READINGS.every(r => MECHANISMS.some(m => m.id === r.mechanism)));
ok('every mechanism has its plain reading (id = mechanism id)', MECHANISMS.every(m => readingOf(m.id)?.mechanism === m.id));
ok('every reading is in a family', READINGS.every(r => READING_FAMILIES.includes(r.family)));
ok('reading presets name real parameters and tiers', READINGS.every(r => Object.keys(r.params || {}).every(k => MECHANISMS.find(m => m.id === r.mechanism).params.includes(k))
    && (r.tiers || []).every(t => TIER_CATALOG[t])));
ok('the PM tier exists, under V, and normalizeTiers keeps it', TIER_CATALOG.PM && TIER_CATALOG.PM.rank > TIER_CATALOG.V.rank && normalizeTiers(['A', 'V', 'PM']).at(-1) === 'PM');

section('each scenario ranks its own reading first (true marks)');
// strips whose marks cannot tell the readings apart: any of these
const AMBIGUOUS = { svtShortRP: ['avrt', 'avnrt', 'at', 'jt'], svtZeroRP: ['avnrt', 'jt'], svtLongRP: ['pjrt', 'at', 'avnrt'], wideTachy1to1: ['vt', 'avrtAnti', 'avnrt'] };
const SUBTYPE = { avb1: 'avb1', wenckebach: 'avb2_type1', mobitz2: 'avb2_type2', twoToOne: 'avb2_1', twoToOneNarrow: 'avb2_1', twoToOneIvcd: 'avb2_1',
    vviChb: 'pacedVVI', ddd: 'pacedDDD' };
for (const sc of SYNTH_SCENARIOS) {
    const { beats, atrial } = truthMarks(sc.id);
    const want = AMBIGUOUS[sc.id] || [sc.reading || SUBTYPE[sc.id] || sc.expect];
    const r = rankReadings(beats, atrial);
    ok(`${sc.id}: ${r.top.id} (${r.top.label}) is one of ${want.join('/')}`, want.includes(r.top.id), r.ranked.slice(0, 3).map(x => `${x.id} ${x.score}`).join(', '));
    ok(`${sc.id}: the top reading's mechanism is not excluded`, r.top.status !== 'excluded');
}

section('labels carry what the marks measured');
{
    const w = rankReadings(truthMarks('wenckebach').beats, truthMarks('wenckebach').atrial);
    ok(`Wenckebach names its ratio (${w.top.label})`, /4:3/.test(w.top.label));
    const f = rankReadings(truthMarks('flutter41').beats, truthMarks('flutter41').atrial);
    ok(`flutter names its conduction ratio (${f.top.label})`, /4:1/.test(f.top.label));
    const h = rankReadings(truthMarks('highGrade').beats, truthMarks('highGrade').atrial);
    ok(`high-grade block names its ratio (${h.top.label})`, /3:1/.test(h.top.label));
}

section('the conduction patterns, one by one');
{
    const k = (id) => avConduction(truthMarks(id).beats, truthMarks(id).atrial).kind;
    ok('sinus: normal', k('sinus') === 'normal');
    ok('avb1: 1st degree', k('avb1') === 'avb1');
    ok('wenckebach', k('wenckebach') === 'wenckebach');
    ok('mobitz II', k('mobitz2') === 'mobitz2');
    ok('2:1, also on the short figure strips that start on a blocked P', k('twoToOne') === '2:1' && k('twoToOneNarrow') === '2:1' && k('twoToOneIvcd') === '2:1');
    ok('high grade (3:1)', k('highGrade') === 'high-grade');
    ok('complete block', k('chb') === 'complete' && k('chbDissociated') === 'complete');
    ok('the P a PVC hides are not AV block (bigeminy, NSVT)', k('pvcBigeminy') === 'normal' && k('nsvt') === 'normal');
    ok('flutter waves are not P waves the node blocks one by one', k('flutter41') === null);
    ok('a blocked PAC is not AV block', k('pacs') === 'normal');
    const sa = (id) => saConduction(truthMarks(id).beats, truthMarks(id).atrial).kind;
    ok('SA exit block type II: the pause is two P–P', sa('saBlockII') === 'sab2_type2');
    ok('SA exit block type I: the pause is less than two P–P, the P–P shorten before it', sa('saBlockI') === 'sab2_type1');
    ok('no SA block on sinus, on PACs (a hidden blocked PAC looks the same), nor where a run of PVCs fills the pause',
       !sa('sinus') && !sa('pacs') && !sa('nsvt') && !sa('pvcBigeminy'));
    const fl = flutterConduction(truthMarks('flutter21').beats, truthMarks('flutter21').atrial);
    ok(`flutter 2:1: F–F 210, 2:1 (${fl.cycleMs}, ${fl.ratio})`, Math.abs(fl.cycleMs - 210) <= 3 && fl.ratio === '2:1');
    ok('pacing modes from the paced marks', readPacing(truthMarks('vviChb').beats, truthMarks('vviChb').atrial).mode === 'VVI'
        && readPacing(truthMarks('ddd').beats, truthMarks('ddd').atrial).mode === 'DDD' && readPacing(truthMarks('aai').beats, truthMarks('aai').atrial).mode === 'AAI');
}

section('without evidence the verdicts are P1\'s, exactly (the rhythm detector\'s gate)');
{
    const here = dirname(fileURLToPath(import.meta.url));
    const P1 = JSON.parse(readFileSync(join(here, 'fixtures', 'p1-verdicts.json'), 'utf8'));
    const pick = (v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, [x.status, ...x.reasons]]));
    let same = 0, n = 0, diff = [];
    for (const sc of SYNTH_SCENARIOS) {
        const { beats, atrial } = truthMarks(sc.id);
        n++; if (JSON.stringify(pick(plausibility(beats, atrial).verdicts)) === JSON.stringify(P1.truth[sc.id])) same++; else diff.push(sc.id);
        const m = detectMarks(makeExample(sc.id));
        n++; if (JSON.stringify(pick(plausibility(m.beats, m.atrial).verdicts)) === JSON.stringify(P1.detected[sc.id])) same++; else diff.push(sc.id + ' (detected)');
    }
    ok(`${same}/${n} verdict sets identical to laddergram-core 1.26.1`, same === n, diff.join(', '));
}

section('evidence ranks, never excludes');
{
    const { beats, atrial } = truthMarks('sinus');
    const base = plausibility(beats, atrial).verdicts;
    // a detector that calls flutter with high confidence on a plain sinus strip
    const ev = { source: 'T', reading: 'flutter', confidence: 'high', atrial: { kind: 'flutter', cycleMs: 220 }, alternatives: ['afib'], secondary: [] };
    const withEv = plausibility(beats, atrial, null, ev).verdicts;
    ok('no status changes from ok to excluded', Object.keys(base).every(k => base[k].status === 'excluded' || withEv[k].status !== 'excluded'));
    ok('the reason is stated on the reading it bears on', withEv.flutter.reasons.some(r => /rhythm detector T/.test(r)) && withEv.afib.reasons.some(r => /F waves/.test(r)));
    const r = rankReadings(beats, atrial, { evidence: ev });
    ok(`the marks still win on a strip they read clearly (${r.top.id})`, r.top.id === 'avnodal');
    // the 1:1 sinus marks exclude AF; no evidence brings it back to first place
    const r2 = rankReadings(beats, atrial, { evidence: { reading: 'afib', confidence: 'high', atrial: { kind: 'fib' } } });
    ok('an excluded reading ranks after every non-excluded one, whatever the evidence', r2.ranked.findIndex(x => x.id === 'afib') > r2.ranked.findIndex(x => x.status !== 'excluded' && x.id !== 'afib'));
    // the detector names the subtype the marks also show: it wins
    const w = truthMarks('saBlockII');
    const r3 = rankReadings(w.beats, w.atrial, { evidence: { reading: 'avnodal', confidence: 'high', secondary: ['sab2_type2'] } });
    ok(`a secondary finding the marks agree with ranks first (${r3.top.id})`, r3.top.id === 'sab2_type2');
    // a confident plain-sinus call damps an AV-block subtype the marks alone suggest
    const a1 = truthMarks('avb1');
    const r4 = rankReadings(a1.beats, a1.atrial, { evidence: { reading: 'avnodal', confidence: 'high', secondary: [] } });
    const r5 = rankReadings(a1.beats, a1.atrial, { evidence: { reading: 'avnodal', confidence: 'high', secondary: ['avb1'], prMs: 300 } });
    ok(`1st-degree: the detector's silence keeps the plain reading (${r4.top.id}); its call names it (${r5.top.id})`, r4.top.id === 'avnodal' && r5.top.id === 'avb1');
    const r5b = rankReadings(a1.beats, a1.atrial, { evidence: { reading: 'avnodal', confidence: 'high', secondary: ['avb1'], prMs: 172 } });
    const r5c = rankReadings(a1.beats, a1.atrial, { evidence: { reading: 'avnodal', confidence: 'high', secondary: ['avb1'], prMs: 200 } });
    const r5c2 = rankReadings(a1.beats, a1.atrial, { evidence: { reading: 'avnodal', confidence: 'high', secondary: ['avb1'], prMs: 204 } });
    ok(`1st-degree needs a measured PR > 200: not at a measured PQ of 172 (${r5b.top.id}) nor 200 (${r5c.top.id}), whatever the marks or the detector say; named at 204 (${r5c2.top.id})`, r5b.top.id === 'avnodal' && r5c.top.id === 'avnodal' && r5c2.top.id === 'avb1');
    const lb = truthMarks('lbbb');
    const r5d = rankReadings(lb.beats, lb.atrial, { evidence: { reading: 'aivr', confidence: 'high', prMs: 180, atrial: { kind: null } } });
    ok(`a wide QRS after each P at a steady PR is conducted (bundle-branch block), even against an AIVR call (${r5d.top.id})`, r5d.top.id === 'avnodal');
    const vt1 = truthMarks('wideTachy1to1');
    const r5e = rankReadings(vt1.beats, vt1.atrial, { evidence: { reading: 'vt', confidence: 'high', prMs: 130, atrial: { kind: 'retro' } } });
    ok(`…but not a retrograde P 1:1 with a wide tachycardia (${r5e.top.id})`, r5e.top.id === 'vt');
    // paced marks: the device's mode; a pacing call without paced marks cannot draw it
    const v = truthMarks('vviChb');
    const unflagged = { beats: v.beats.map(({ origin, ...b }) => b), atrial: v.atrial };
    const r6 = rankReadings(unflagged.beats, unflagged.atrial, { evidence: { reading: 'pacedVVI', confidence: 'high', pacing: { mode: 'VVI' } } });
    ok(`a VVI call without a paced mark is not the reading drawn (${r6.top.id}); the reason says why`, !/^paced/.test(r6.top.id)
        && plausibility(unflagged.beats, unflagged.atrial, null, { pacing: { mode: 'VVI' } }).verdicts.paced.reasons.some(x => /accept its stimulus marks/.test(x)));
}

section('the suggestion (P1 + slow rhythms with no P)');
ok('junctional escape: jt', suggestReading(truthMarks('junctionalEscape').beats, []).id === 'jt');
ok('AIVR: vt', suggestReading(truthMarks('aivr').beats, []).id === 'vt');
ok('a sinus strip with its P marked is still sinus', suggestReading(truthMarks('sinus').beats, truthMarks('sinus').atrial).id === 'avnodal');

section('SA exit block on the SN tier');
{
    const { beats, atrial, tr } = truthMarks('saBlockII');
    const L = buildLadder({ beats, atrial, mechanism: 'avnodal', params: { saBlock: 2 }, tiers: ['SN', 'A', 'AV', 'His', 'V'], durationMs: tr.durationMs });
    const blocked = L.events.filter(e => e.role === 'sn-blocked');
    ok(`type II: one blocked discharge, at the missing P minus the SA time (${blocked.map(e => e.tMs)})`, blocked.length === 1 && Math.abs(blocked[0].tMs - (300 + 5 * 860 - 60)) <= 15);
    ok('drawn as a line that stops inside the SN tier', L.paths.some(p => p.role === 'sa-block' && p.terminal === 'block' && p.from.tier === 'SN' && p.to.tier === 'SN'));
    ok('the claim names it', L.claims.some(c => c.code === 'sa-block' && /type II/.test(c.text)));
    const t1 = truthMarks('saBlockI');
    const L1 = buildLadder({ beats: t1.beats, atrial: t1.atrial, mechanism: 'avnodal', params: { saBlock: 1 }, tiers: ['SN', 'A', 'AV', 'His', 'V'], durationMs: t1.tr.durationMs });
    const sa = L1.paths.filter(p => p.role === 'sa').map(p => p.to.tMs - p.from.tMs);
    ok(`type I: the SA conduction grows through each group (${sa.slice(0, 3).map(Math.round)})`, sa[1] > sa[0] + 30 && sa[2] > sa[1]);
    ok('type I: a blocked discharge after each group', L1.events.filter(e => e.role === 'sn-blocked').length === 2);
    const sp = sinoatrialPattern(t1.atrial);
    ok(`the sinus cycle that makes each group whole is 860 ms (${sp.basicMs}, discharges ${[...sp.snOf.values()].slice(0, 3).map(Math.round)})`,
       [...sp.snOf.values()].slice(1, 3).every((t, i) => Math.abs(t - [...sp.snOf.values()][i] - 860) <= 2));
    const plain = buildLadder({ beats, atrial, mechanism: 'avnodal', tiers: ['SN', 'A', 'AV', 'His', 'V'], durationMs: tr.durationMs });
    ok('without the parameter nothing changes', !plain.events.some(e => e.role === 'sn-blocked'));
}

section('the pacemaker row');
{
    for (const id of ['vviChb', 'ddd', 'aai']) {
        const { beats, atrial, tr } = truthMarks(id);
        const L = buildLadder({ beats, atrial, mechanism: 'paced', tiers: ['A', 'AV', 'V', 'PM'], durationMs: tr.durationMs });
        const pm = L.events.filter(e => e.tier === 'PM'), pmPaths = L.paths.filter(p => p.from.tier === 'PM');
        const stims = pm.filter(e => e.style === 'stim').length, flagged = beats.filter(b => b.origin === 'paced').length + atrial.filter(a => a.origin === 'paced').length;
        ok(`${id}: one PM stimulus per paced mark (${stims}/${flagged})`, stims === flagged);
        const kinds = new Set(pmPaths.map(p => p.role));
        const want = { vviChb: ['pm-lri'], ddd: ['pm-avi', 'pm-va'], aai: ['pm-va'] }[id];
        ok(`${id}: the device's intervals (${[...kinds].join(', ')}), each labelled once`, want.every(k => kinds.has(k)) && want.every(k => pmPaths.filter(p => p.role === k && p.label).length === 1));
    }
    const { beats, atrial } = truthMarks('sinus');
    ok('the PM tier stays empty in other readings', !buildLadder({ beats, atrial, mechanism: 'avnodal', tiers: ['A', 'AV', 'V', 'PM'] }).events.some(e => e.tier === 'PM'));
    const { beats: vb, atrial: va } = truthMarks('vviChb');
    const plainPaced = buildLadder({ beats: vb, atrial: va, mechanism: 'paced', tiers: ['A', 'AV', 'V'] });
    ok('without the PM tier the paced drawing is unchanged (stimuli on A and V only)', !plainPaced.events.some(e => e.tier === 'PM') && plainPaced.events.some(e => e.style === 'stim'));
}

section('a strip in segments');
{
    const { beats, atrial, tr } = truthMarks('nsvt');
    const segs = [{ fromMs: 0, toMs: 3300, mechanism: 'avnodal', label: 'Sinus' }, { fromMs: 3300, toMs: 5000, mechanism: 'vt', label: 'NSVT' }, { fromMs: 5000, toMs: tr.durationMs, mechanism: 'avnodal', label: 'Sinus' }];
    const L = buildLadder({ beats, atrial, mechanism: 'avnodal', segments: segs, durationMs: tr.durationMs });
    const cuts = L.paths.filter(p => p.role === 'segment-cut');
    ok(`two cuts, at 3300 and 5000 ms (${cuts.map(p => p.from.tMs)})`, cuts.length === 2 && cuts[0].from.tMs === 3300 && cuts[1].from.tMs === 5000);
    ok('the run is drawn from a ventricular focus, the sinus beats conducted', L.events.filter(e => e.role === 'focus-ventricular').length === 4 && L.paths.filter(p => p.role === 'av' && p.beatId).length >= 8);
    ok('the notes say which stretch each claim is about', L.claims[0].code === 'segments' && L.notes.some(n => /^NSVT \(3\.3–5 s\)/.test(n)));
    ok('unique ids and keys', new Set(L.paths.map(p => p.id)).size === L.paths.length && new Set(L.events.map(e => e.key)).size === L.events.length);
    ok('one segment is no segmentation', buildLadder({ beats, atrial, mechanism: 'avnodal', segments: [segs[0]] }).paths.every(p => p.role !== 'segment-cut'));
    const j = fromLaddergramJson(JSON.parse(JSON.stringify(toLaddergramJson({ beats: beats.map(b => ({ ...b, origin: 'paced' })), atrial, mechanism: 'avnodal', params: {}, ladder: L, segments: segs, reading: 'nsvt' }))));
    ok('the file keeps the segments, the reading and the paced flag', j.segments?.length === 3 && j.reading === 'nsvt' && j.beats.every(b => b.origin === 'paced'));
    ok('the file is stamped with the engine and the plausibility version', JSON.parse(JSON.stringify(toLaddergramJson({ beats, atrial, mechanism: 'avnodal', params: {}, ladder: L }))).engine?.plausibility === PLAUSIBILITY_VERSION);
}

section('the manuscript figures are untouched');
{
    let n = 0, okN = 0;
    for (const fig of FIGURES) for (const p of figurePanels(fig).panels) {
        n++;
        const L = buildLadder({ ...p, durationMs: 10000 });
        if (!L.events.some(e => e.role === 'sn-blocked' || e.tier === 'PM') && !L.paths.some(p => p.role === 'segment-cut')) okN++;
    }
    ok(`${okN}/${n} panels draw nothing new (golden.test.mjs holds their exact shape)`, okN === n);
}

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
