// The builder primitives are public API (engine.js, `builders`): the Lewis Ladder editor's "By hand"
// mode authors its own paths with them, so that a hand-drawn ladder and an engine-drawn one obey the
// same premises and land on the same pixels. These tests hold that contract from the outside — if a
// signature changes, or a piece stops being exported, the consumer breaks and this says so first.
import { builders, buildLadder, normalizeTiers, resolveParams, JUNCTION } from '../engine.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  FAIL', msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const EXPECTED = [
    'tierContext', 'makeBuilder', 'junctionTimes',
    'sinusEntry', 'atrialRetro', 'snInvade',
    'avConduct', 'avBlock', 'avRetro', 'avConcealed',
    'hisAndV', 'branches', 'blockStub', 'vTier', 'vExit',
    'junctionalFocus', 'ventricularFocus', 'apRetro',
];

console.log('builders: the pieces a consumer draws with');
for (const name of EXPECTED) ok(typeof builders[name] === 'function', `builders.${name} is exported`);
ok(Object.isFrozen(builders), 'builders is frozen');
ok(JUNCTION.hisShare > 0 && JUNCTION.stubMs > 0, 'JUNCTION is exported for consumers that place their own stubs');

// A ladder assembled by hand from the primitives is the ladder the engine draws for the same rhythm.
// This is the whole point of exporting them, so it is the test that matters.
console.log('builders: a hand-assembled sinus beat equals the engine drawing');
{
    const tiers = normalizeTiers(['SN', 'A', 'AV', 'His', 'V']);
    const atrial = [{ id: 'a0', tMs: 200, source: 'user' }, { id: 'a1', tMs: 1000, source: 'user' }];
    const beats = [
        { id: 'b0', qrsOnMs: 360, qrsOffMs: 450, source: 'user' },
        { id: 'b1', qrsOnMs: 1160, qrsOffMs: 1250, source: 'user' },
    ];
    const params = resolveParams({});

    const T = builders.tierContext(tiers);
    const B = builders.makeBuilder('hand', params, T);
    for (const a of atrial) builders.sinusEntry(B, a, { sn: true });
    beats.forEach((b, i) => {
        const J = builders.junctionTimes(B, b.qrsOnMs);
        builders.avConduct(B, atrial[i].tMs, J.tAvOut, { atrialId: atrial[i].id, beatId: b.id });
        builders.hisAndV(B, b);
    });

    const engine = buildLadder({ beats, atrial, mechanism: 'avnodal', tiers, durationMs: 1600 });
    const shape = (L) => ({
        paths: L.paths.map(p => `${p.role}|${p.from.tier}@${p.from.frac}→${p.to.tier}@${p.to.frac}|${Math.round(p.from.tMs)}→${Math.round(p.to.tMs)}`).sort(),
        events: L.events.map(e => `${e.role}|${e.tier}@${e.frac}|${Math.round(e.tMs)}`).sort(),
    });
    const hand = shape(B.L), auto = shape(engine);
    eq(JSON.stringify(hand.events), JSON.stringify(auto.events), 'every event lands where the engine puts it');
    eq(JSON.stringify(hand.paths), JSON.stringify(auto.paths), 'every path lands where the engine puts it');
    eq(B.L.mechanism, 'hand', 'the builder keeps the mechanism name it was given');
    ok(B.L.tiers.length === tiers.length, 'the ladder carries the tiers it was built with');
}

console.log(`\n${pass} ok, ${fail} fail`);
if (fail) process.exit(1);
