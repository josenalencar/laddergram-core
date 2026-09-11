// Golden figures: the structure of every panel of the article's Figures 0–5, as the engine draws it
// today. Any change in engine behaviour shows up here as a diff a cardiologist can review, not as a
// silently different figure. After an intended change: node packages/laddergram-core/test/golden.test.mjs --update
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildLadder, ENGINE_VERSION } from '../engine.js';
import { FIGURES, figurePanels } from '../figures.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, 'fixtures', 'figures.json');
const r = (t) => Math.round(t);
const at = (q) => `${q.tier}${q.frac === 0 ? '' : '@' + Math.round(q.frac * 100) / 100}`;

function summary() {
    const out = {};
    for (const fig of FIGURES) {
        const { rec, panels } = figurePanels(fig);
        out[fig.id] = panels.map(p => {
            const L = buildLadder({ ...p, durationMs: rec.metadata.truth.durationMs });
            return {
                mechanism: p.mechanism, tiers: L.tiers,
                paths: L.paths.map(q => `${q.role}|${at(q.from)}→${at(q.to)}|${r(q.from.tMs)}→${r(q.to.tMs)}|${q.style}|${q.terminal}|${q.arrow}`),
                events: L.events.map(e => `${e.role}|${at(e)}|${r(e.tMs)}|${e.style}`),
                claims: L.claims.map(c => `${c.level}|${c.code}`),
            };
        });
    }
    return out;
}

const now = summary();
if (process.argv.includes('--update') || !existsSync(FIX)) {
    writeFileSync(FIX, JSON.stringify({ engine: ENGINE_VERSION, figures: now }, null, 1) + '\n');
    console.log(`golden figures written (${Object.keys(now).length} figures, engine ${ENGINE_VERSION})`);
    process.exit(0);
}
const saved = JSON.parse(readFileSync(FIX, 'utf8')).figures;
let fail = 0, pass = 0;
for (const [id, panels] of Object.entries(now)) {
    panels.forEach((p, i) => {
        const s = saved[id]?.[i];
        const same = s && JSON.stringify(s) === JSON.stringify(p);
        if (same) { pass++; return; }
        fail++;
        console.log(`  FAIL ${id} panel ${'ABCD'[i]} (${p.mechanism}) differs from the golden figure`);
        if (s) for (const k of ['tiers', 'paths', 'events', 'claims']) {
            const a = s[k] || [], b = p[k] || [];
            const gone = a.filter(x => !b.includes(x)).slice(0, 4), added = b.filter(x => !a.includes(x)).slice(0, 4);
            if (gone.length || added.length) console.log(`       ${k}: −${JSON.stringify(gone)} +${JSON.stringify(added)}`);
        }
    });
}
console.log(`${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
