// The frame's blocks in any order (render.js makeLayout, PREMISES.md §7). Two promises are checked: a frame
// without intracardiac channels is laid out exactly as it was before blocks could be reordered (the numbers
// below were recorded from laddergram-core 1.18.0), and with them every one of the six orders stacks the
// tracing, the channels and the ladder without overlap, with zones, markers and labels following them.
//
//   node packages/laddergram-core/test/layout.test.mjs
import { makeLayout, zoneOf, hitTest, makeView, blockOrder, drawFrame, drawEgmBlock, resolveEgmLetters, EGM_ROW_H, EGM_LETTER_H, BRACKET_ROW_H, TITLE_ROW_H } from '../render.js';
import { DEFAULT_TIERS } from '../engine.js';
import { BLOCK_ORDERS, egmLayoutOptions, DEFAULT_EP, egmSamples } from '../egm.js';
import { makeRecorder } from './mockCanvas.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

section('a frame without intracardiac channels is laid out as before (1.18.0)');
{
    const BASE = {
        dflt: { cfg: {}, want: { stripTop: 0, ladderTop: 186, ladderBottom: 394, bottom: 394, height: 424,
                bands: { SN: [186, 210], A: [210, 252], AV: [252, 318], His: [318, 352], V: [352, 394] }, captionTop: 398 } },
        lines: { cfg: { style: 'lines' }, want: { stripTop: 0, ladderTop: 198, ladderBottom: 350, bottom: 360, height: 390,
                 bands: { SN: [198, 236], A: [236, 274], AV: [274, 312], His: [312, 350], V: [350, 350] }, captionTop: 362 } },
        twoTitled: { cfg: { groups: [DEFAULT_TIERS, ['A', 'AV', 'V']], titles: true, captionLines: [1, 2], bracketRows: [true, false], styles: ['bands', 'lines'] },
                     want: { stripTop: 0, ladderTop: 222, ladderBottom: 430, bottom: 665, height: 695,
                             bands: { SN: [222, 246], A: [246, 288], AV: [288, 354], His: [354, 388], V: [388, 430] }, captionTop: 466,
                             g1: { top: 543, bottom: 619, captionTop: 631 } } },
        tall: { cfg: { stripH: 300, gap: 48, footer: 58 }, want: { stripTop: 0, ladderTop: 348, ladderBottom: 556, bottom: 556, height: 614,
                bands: { SN: [348, 372], A: [372, 414], AV: [414, 480], His: [480, 514], V: [514, 556] }, captionTop: 560 } },
    };
    for (const [name, { cfg, want }] of Object.entries(BASE)) {
        const L = makeLayout(cfg);
        const same = L.stripTop === want.stripTop && L.ladderTop === want.ladderTop && L.ladderBottom === want.ladderBottom
            && L.bottom === want.bottom && L.height === want.height && L.groups[0].captionTop === want.captionTop
            && Object.entries(want.bands).every(([t, [a, b]]) => L.bands[t].top === a && L.bands[t].bottom === b)
            && (!want.g1 || (L.groups[1].top === want.g1.top && L.groups[1].bottom === want.g1.bottom && L.groups[1].captionTop === want.g1.captionTop));
        ok(`${name}: the same numbers`, same, JSON.stringify({ stripTop: L.stripTop, ladderTop: L.ladderTop, bottom: L.bottom, height: L.height }));
        ok(`${name}: tracing then ladder, no intracardiac block`, JSON.stringify(L.order) === '["strip","ladder"]' && L.egm === null);
    }
    const L = makeLayout(), Ll = makeLayout({ style: 'lines' });
    ok('zones unchanged (bands)', JSON.stringify([0, 80, 160, 170, 186, 200, 250, 300, 400].map(y => zoneOf(L, y))) === JSON.stringify(['strip', 'strip', 'strip', 'gap', 'SN', 'SN', 'A', 'AV', null]));
    ok('zones unchanged (lines)', JSON.stringify([0, 160, 170, 180, 200, 240, 300].map(y => zoneOf(Ll, y))) === JSON.stringify(['strip', 'strip', 'gap', 'SN', 'SN', 'A', 'His']));
    ok('an order given without channels keeps the two blocks it names', JSON.stringify(makeLayout({ order: ['ladder', 'egm', 'strip'] }).order) === '["ladder","strip"]');
}

section('block order');
{
    ok('the default with channels: tracing, channels, ladder', JSON.stringify(blockOrder(null, true)) === '["strip","egm","ladder"]');
    ok('repeats and unknown names dropped, a missing block goes last', JSON.stringify(blockOrder(['egm', 'egm', 'x', 'ladder'], true)) === '["egm","ladder","strip"]');
}

section('every order stacks the three blocks without overlap');
{
    const egm = egmLayoutOptions(DEFAULT_EP);
    for (const order of BLOCK_ORDERS) {
        const L = makeLayout({ order, egm, titles: true });
        const span = {
            strip: [L.stripTop, L.stripTop + L.stripH],
            egm: [L.egm.top, L.egm.bottom],
            ladder: [L.groups[0].top - TITLE_ROW_H, L.groups[L.groups.length - 1].bottom],
        };
        const seq = order.map(b => span[b]);
        const stacked = seq.every((s, i) => s[0] < s[1] && (i === 0 || s[0] >= seq[i - 1][1]));
        ok(`${order.join(' / ')}: in that order, none overlapping`, stacked, JSON.stringify(span));
        ok(`${order.join(' / ')}: the page ends after the last block`, L.bottom >= seq[2][1] && L.height === L.bottom + 30);
        const first = L.egm.rows[L.egm.channels[0]];
        ok(`${order.join(' / ')}: zones follow the blocks`,
           zoneOf(L, L.stripTop + 5) === 'strip' && zoneOf(L, first.mid) === 'egm' && zoneOf(L, (L.bands.A.top + L.bands.A.bottom) / 2) === 'A');
    }
}

section('the intracardiac block');
{
    const L = makeLayout({ order: ['strip', 'egm', 'ladder'], egm: egmLayoutOptions({ ...DEFAULT_EP, hisSplit: true }) });
    const E = L.egm;
    ok('one row per channel', JSON.stringify(E.channels) === JSON.stringify(['HRA', 'Hisp', 'Hisd', 'CS910', 'CS78', 'CS56', 'CS34', 'CS12', 'RVa'])
        && E.channels.every(ch => E.rows[ch].bottom - E.rows[ch].top === EGM_ROW_H));
    ok('the letter row sits right above the first His channel', E.rows.Hisp.top === E.rows.HRA.bottom + EGM_LETTER_H && E.lettersY === E.rows.Hisp.top - 3);
    ok('the bracket row sits right under the last His channel', E.bracketTop === E.rows.Hisd.bottom && E.rows.CS910.top === E.bracketTop + BRACKET_ROW_H);
    ok('the gap under the tracing reaches the channels', zoneOf(L, L.stripTop + L.stripH + 5) === 'gap');
    const view = makeView({ speedMmS: 100 });
    const beats = [{ id: 'b', qrsOnMs: 300 }], atrial = [{ id: 'a', tMs: 150 }];
    ok('no mark is picked in the channels', !hitTest({ view, layout: L, beats, atrial }, view.xOf(300), E.rows.RVa.mid)?.id);
    const noLetters = makeLayout({ egm: egmLayoutOptions({ ...DEFAULT_EP, showLetters: false, showAhHv: false }) }).egm;
    ok('without letters and brackets: no rows for them', noLetters.lettersY === null && noLetters.bracketTop === null
        && noLetters.bottom - noLetters.top === noLetters.channels.length * EGM_ROW_H);
    const lettersOnly = makeLayout({ egm: { channels: ['RVa'], letters: true, brackets: true } }).egm;
    ok('no His channel: no letter row, no bracket row', lettersOnly.lettersY === null && lettersOnly.bracketTop === null);
}

section('the frame follows the tracing wherever it is');
{
    const order = ['egm', 'ladder', 'strip'];
    const L = makeLayout({ order, egm: egmLayoutOptions(DEFAULT_EP) });
    const view = makeView({ speedMmS: 100 });
    const ctx = makeRecorder();
    const strip = { sig: new Float32Array(1000), fs: 500, gaps: null, label: 'II' };
    drawFrame(ctx, { view, layout: L, cssW: 600, strip, beats: [{ id: 'b', qrsOnMs: 400, source: 'user' }], atrial: [{ id: 'a', tMs: 250, source: 'user' }],
                     ladder: null, markerLines: false, bare: true });
    const log = ctx.__log;
    const paper = log.find(([m, a]) => m === 'fillRect' && a[1] === L.stripTop && a[3] === L.stripH);
    ok('the paper is painted at the tracing\'s own place', !!paper, `stripTop ${L.stripTop}`);
    const lead = log.find(([m, a]) => m === 'fillText' && a[0] === 'II');
    ok('the lead name is written beside the tracing', lead && lead[1][2] === L.stripTop + 16);
    const guides = log.filter(([m, a]) => m === 'lineTo' && (a[1] === L.bands.A.top || a[1] === L.bands.V.top));
    ok('no marker guide runs up from a tracing below the ladder', guides.length === 0);
}

section('channels on a strip timed from a grid click (times before zero)');
{
    const L = makeLayout({ egm: { channels: ['HRA'], letters: true, brackets: false } });
    const view = makeView({ speedMmS: 100, t0Ms: -2000 });
    const sch = { channels: ['HRA'], deflections: [{ ch: 'HRA', kind: 'A', tMs: -1500, amp: 1, far: false }], letters: [], beats: [] };
    const ctx = makeRecorder();
    drawEgmBlock(ctx, view, L, { schedule: sch, samples: egmSamples(sch, { t0Ms: -2000, durationMs: 1000 }) }, { x0: view.labelW, x1: view.xOf(1000) });
    const xs = ctx.__log.filter(([m]) => m === 'lineTo').map(([, a]) => a[0]);
    ok('the trace is drawn from the strip\'s own start, not from zero', xs.some(x => x < view.xOf(-1000)) && xs.some(x => x > view.xOf(500)));
    const ys = ctx.__log.filter(([m, a]) => m === 'lineTo' && Math.abs(a[0] - view.xOf(-1480)) < 3).map(([, a]) => a[1]);
    ok('and the deflection before zero is where its time is', Math.max(...ys) - Math.min(...ys) > 6);
}

section('letters too close to read both');
{
    const L = makeLayout({ egm: { channels: ['His'], letters: true, brackets: false } });
    const view = makeView({ speedMmS: 100, t0Ms: 0 });
    const letters = (list) => resolveEgmLetters({ letters: list.map(([text, tMs]) => ({ text, tMs, centerMs: 0 })) }, view, L).map(l => l.text).join('');
    ok('the His letter stays whether A or V comes first', letters([['A', 100], ['H', 110], ['V', 400]]) === 'HV' && letters([['A', 100], ['H', 300], ['V', 310]]) === 'AH');
    ok('A over V when those two collide', letters([['V', 100], ['A', 105]]) === 'A');
    ok('letters far enough apart all stay', letters([['A', 100], ['H', 200], ['V', 300]]) === 'AHV');
}

console.log(`\n${pass} ok, ${fail} fail`);
if (fail) process.exit(1);
