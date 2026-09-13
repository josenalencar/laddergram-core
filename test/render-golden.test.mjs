// The renderer's output, as a fingerprint per figure: every canvas call `drawFrame` makes for Figures 0–5,
// recorded through a context that logs instead of painting, hashed and kept in fixtures/render-golden.json.
// A refactor of the renderer must reproduce every hash; a deliberate change refreshes them with --update.
//
//   node packages/laddergram-core/test/render-golden.test.mjs [--update]
//   RENDER_MODULE=../../../js/laddergramRender.js   (which module to fingerprint; default: the core's render.js)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FIGURES, figurePanels } from '../figures.js';
import { composeStack, layoutForStack, frameGroups } from '../stack.js';
import { makeRecorder } from './mockCanvas.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const R = await import(process.env.RENDER_MODULE ?? '../render.js');
const FIX = join(here, 'fixtures', 'render-golden.json');
const update = process.argv.includes('--update');

function fingerprint(fig) {
    const { rec, panels } = figurePanels(fig);
    const lead = rec.rhythmLead || 'II';
    const sig = rec.rhythmStrip?.[lead] ?? rec.leads[lead];
    const fs = rec.sampleRate;
    const durationMs = sig.length * 1000 / fs;
    const stack = composeStack(panels, { style: panels[0].style, durationMs });
    const { layout } = layoutForStack(stack, { makeLayout: R.makeLayout, style: panels[0].style });
    const view = R.makeView({ speedMmS: 25, t0Ms: 0, gainMmMv: 5 });
    const cssW = Math.ceil(view.labelW + durationMs * view.pxPerMs) + 8;
    const ctx = makeRecorder();
    R.drawFrame(ctx, {
        view, layout, cssW,
        strip: { sig, fs, gaps: null, label: lead },
        beats: panels[0].beats, atrial: panels[0].atrial,
        ...frameGroups(stack),
        selected: null, showIntervals: false, markerLines: false, footerText: null, bare: true,
    });
    const log = ctx.__log;
    // A word written across a tier line is unreadable, so no figure may contain one. The rules are the
    // same ys drawTierGroup strokes; a path label is any fillText made in the path-label font.
    const rules = layout.groups.flatMap((_, g) => R.tierRules(layout, g));
    const onRule = [];
    let font = '';
    for (const [m, a] of log) {
        if (m === '=font') font = a[0];
        else if (m === 'fillText' && font === R.FONTS.pathLabel && rules.some(r => Math.abs(r - a[2]) < 8)) onRule.push(`${a[0]}@${Math.round(a[2])}`);
    }
    return { hash: createHash('sha256').update(JSON.stringify(log)).digest('hex'), calls: log.length, log, onRule };
}

let pass = 0, fail = 0;
const stored = existsSync(FIX) ? JSON.parse(readFileSync(FIX, 'utf8')) : {};
const next = {};
for (const fig of FIGURES) {
    const { hash, calls, log, onRule } = fingerprint(fig);
    if (onRule.length) { fail++; console.error(`  FAIL     ${fig.id}: label on a tier line — ${onRule.join(', ')}`); }
    else pass++;
    next[fig.id] = { hash, calls };
    if (fig.id === 'fig2') next[fig.id].log = log;          // one readable log, so a diff says what moved
    const want = stored[fig.id]?.hash;
    if (update || !want) { pass++; console.log(`  ${update ? 'recorded' : 'new     '} ${fig.id}  ${calls} calls  ${hash.slice(0, 12)}`); continue; }
    if (want === hash) { pass++; console.log(`  ok       ${fig.id}  ${calls} calls`); }
    else {
        fail++;
        console.error(`  FAIL     ${fig.id}: ${calls} calls, hash ${hash.slice(0, 12)} ≠ golden ${want.slice(0, 12)}`);
        if (stored[fig.id]?.log) {
            const a = stored[fig.id].log, b = log;
            const n = Math.min(a.length, b.length);
            for (let i = 0; i < n; i++) if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) { console.error(`    first difference at call ${i}:\n      golden ${JSON.stringify(a[i])}\n      now    ${JSON.stringify(b[i])}`); break; }
            if (a.length !== b.length) console.error(`    ${a.length} calls in the golden, ${b.length} now`);
        }
    }
}
if (update || Object.keys(stored).length === 0) writeFileSync(FIX, JSON.stringify(next, null, 0) + '\n');
console.log(`\n${pass} ok, ${fail} fail${update ? ' (goldens refreshed)' : ''}`);
if (fail) process.exit(1);
