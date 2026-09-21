// Line styles: dotted and bold are cosmetic (PREMISES §3) and must not look like dashed, which means something.
//
//   node packages/laddergram-core/test/styles.test.mjs
import { drawPathPx } from '../render.js';
import { makeRecorder } from './mockCanvas.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } };
const draw = (style) => {
    const ctx = makeRecorder();
    drawPathPx(ctx, { sx: 0, sy: 0, ex: 100, ey: 40, style, terminal: 'point', arrow: 'none' }, new Set());
    const log = ctx.__log;
    return { dash: (log.find(c => c[0] === 'setLineDash') || [, [[]]])[1][0], width: (log.find(c => c[0] === '=lineWidth') || [, [0]])[1][0] };
};
const solid = draw('solid'), dashed = draw('dashed'), dotted = draw('dotted'), bold = draw('bold');
ok('dotted is a dot pattern, not the dash', dotted.dash.length === 2 && dotted.dash[0] < 1 && JSON.stringify(dotted.dash) !== JSON.stringify(dashed.dash), JSON.stringify(dotted.dash));
ok('bold is solid and heavier', bold.dash.length === 0 && bold.width > solid.width);
ok('solid and dashed are unchanged', solid.width === 1.6 && JSON.stringify(dashed.dash) === '[4,3]');
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
