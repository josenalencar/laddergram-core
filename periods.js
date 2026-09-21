/**
 * Refractory periods that explain a block: shaded bars on a ladder, in tier–time.
 *
 * A ladder shows where an impulse stopped; a period shows why. A structure that has just conducted cannot
 * conduct again until it recovers, and the live heart (epsim.js) models exactly that: recovery is counted
 * from the moment a wave FINISHES crossing the structure, and a wave that arrives sooner is blocked. From a
 * strip alone that recovery is known only as a span: the longest recovery after which a P was blocked, and
 * the shortest after which one conducted. The bar says so — solid while the structure was certainly
 * refractory, hatched over the span in which it recovered.
 *
 * Nothing here is measured, and nothing is invented to fill a gap: a period is drawn only when it explains a
 * block the ladder draws. Blocks that recovery does not explain (a fixed ratio at recoveries no shorter than
 * conducted ones — Mobitz II —, complete block) get a sentence instead of a bar.
 *
 * Pure: no DOM. Imports only the engine, so render.js, egm.js and epsim.js may use it without a cycle.
 * PREMISES.md §8.
 */
import { buildLadder, normalizeTiers, resolveParams, DEFAULT_TIERS } from './engine.js';

const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const r0 = (x) => Math.round(x);

/** Which periods to draw: { show: true } (the ones that explain a block) — anything else draws none. */
export const cleanPeriods = (p) => (p && p.show === true ? { show: true } : null);

/**
 * Recovery of one structure along a sequence of arrivals: `seq` is [{ t: arrival, end: when it finished
 * conducting (null if blocked), entry, key }] in time order. Returns the conducted recoveries (samples), the
 * blocked ones (blocks) and, for each block, the conduction whose refractory period it met.
 */
function recoveryOf(seq) {
    const samples = [], blocks = [];
    let last = null;
    for (const s of seq) {
        if (last) {
            const DI = s.t - last.end;
            if (s.end != null) samples.push({ DI, s, after: last });
            else blocks.push({ DI, s, after: last });
        }
        if (s.end != null) last = s;
    }
    return { samples, blocks };
}

/**
 * The periods of a reading.
 * @param input   { beats, atrial, mechanism, params, tiers, durationMs } — as buildLadder takes it
 * @param o.ladder  the ladder already drawn from `input` (built here when absent)
 * @returns { periods: [{ id, tier, t0Ms, t1Ms, t1HiMs, kind: 'erp' | 'conceal' | 'timing', explains }], claims: [{ level, code, text }] }
 *   t0Ms  the wave that makes the structure refractory enters it
 *   t1Ms  certainly refractory until here (the longest recovery that still blocked)
 *   t1HiMs  recovered by here (the shortest recovery that conducted); the span t1–t1Hi is hatched
 */
export function ladderPeriods(input, { ladder = null } = {}) {
    const P = resolveParams(input.params);
    const userTiers = normalizeTiers(input.tiers && input.tiers.length ? input.tiers : DEFAULT_TIERS);
    // Recovery is read on a ladder that has a His tier: the His time is where the AV node's conduction ends.
    const withHis = userTiers.includes('His');
    const L = ladder && withHis ? ladder
        : buildLadder({ beats: input.beats || [], atrial: input.atrial || [], mechanism: input.mechanism, params: input.params,
                        tiers: normalizeTiers([...userTiers, 'His']), durationMs: input.durationMs });
    const out = { periods: [], claims: [] };
    const claim = (code, text) => out.claims.push({ level: 'info', code, text });
    const mech = L.mechanism;
    const avTier = userTiers.includes('AV') ? 'AV' : userTiers.find(t => t === 'AVf' || t === 'AVs') ?? null;
    const byAtrial = (role) => new Map(L.paths.filter(p => p.role === role && p.atrialId != null).map(p => [p.atrialId, p]));
    const ectopy = L.events.some(e => e.role === 'focus-ventricular' || e.role === 'focus-his' || e.role === 'focus-junctional');

    // ── a pacemaker: the device's own timing, not the heart's refractoriness ──
    if (mech === 'paced') {
        const pc = L.pacing;
        if (!pc || !pc.mode) return out;
        const vTimes = L.events.filter(e => e.tier === 'V' && (e.role === 'qrs' || e.role === 'stim-ventricular' || e.role === 'focus-ventricular' || e.role === 'focus-junctional'))
            .map(e => ({ t: e.tMs, key: e.beatId })).sort((a, b) => a.t - b.t);
        const timing = (id, tier, t0, len, explains) => out.periods.push({ id, tier, kind: 'timing', explains, t0Ms: t0, t1Ms: t0 + len, t1HiMs: t0 + len });
        if (pc.mode !== 'AAI' && userTiers.includes('V')) for (const v of vTimes) timing(`vrp-${v.key}`, 'V', v.t, pc.vrpMs, v.key);
        if (pc.mode === 'DDD') {
            for (const v of vTimes) timing(`pvarp-${v.key}`, 'A', v.t, pc.pvarpMs, v.key);
            // the AV delay: from the P the device sensed or paced to the paced QRS
            const aOf = new Map(L.events.filter(e => e.tier === 'A' && e.atrialId != null && (e.role === 'p' || e.role === 'stim-atrial')).map(e => [e.atrialId, e.tMs]));
            const vOf = new Map(L.events.filter(e => e.role === 'stim-ventricular').map(e => [e.beatId, e.tMs]));
            const pairs = [...pc.tracked];
            if (avTier) for (const { atrialId, beatId } of pairs) {
                const t0 = aOf.get(atrialId), t1 = vOf.get(beatId);
                if (t0 != null && t1 != null && t1 > t0) timing(`avi-${beatId}`, avTier, t0, t1 - t0, beatId);
            }
            // paced atrium followed by a paced ventricle: the same delay
            for (const e of L.events.filter(x => x.role === 'stim-atrial')) {
                const v = [...vOf].find(([, t]) => t > e.tMs && t - e.tMs <= 350 && !pairs.some(p => p.atrialId === e.atrialId));
                if (v && avTier) timing(`avi-${v[0]}`, avTier, e.tMs, v[1] - e.tMs, v[0]);
            }
        }
        claim('periods-paced', 'Pacemaker timing, not the heart\'s refractoriness: '
            + [pc.mode !== 'AAI' ? `the ventricular refractory period (VRP ${pc.vrpMs} ms, V tier)` : null,
               pc.mode === 'DDD' ? `the post-ventricular atrial refractory period (PVARP ${pc.pvarpMs} ms, A tier)` : null,
               pc.mode === 'DDD' ? 'the AV delay (AV tier)' : null].filter(Boolean).join(', ')
            + ' after each event. Refractory periods are assumed unless you set them.');
        out.periods = out.periods.filter(p => [p.t0Ms, p.t1Ms].every(Number.isFinite) && p.t1Ms > p.t0Ms).sort((a, b) => a.t0Ms - b.t0Ms);
        return out;
    }

    if (mech === 'avb3') {
        claim('periods-none-complete', 'Complete AV block: no P conducts, so there is no recovery time to draw.');
        return out;
    }

    // ── the AV node, in sinus rhythm with AV block (Wenckebach, 2:1, higher ratios) ──
    if (mech === 'avnodal' && !ectopy && !(P.blockBelowHis >= 0.5)) {
        const av = byAtrial('av'), blk = byAtrial('av-block');
        const ps = L.events.filter(e => e.tier === 'A' && e.role === 'p').sort((a, b) => a.tMs - b.tMs);
        const seq = ps.map(e => {
            const c = av.get(e.atrialId), b = blk.get(e.atrialId);
            if (c) return { key: e.atrialId, t: c.from.tMs, entry: c.from.tMs, end: c.to.tMs };
            if (b) return { key: e.atrialId, t: b.from.tMs, entry: b.from.tMs, end: null };
            return null;
        }).filter(Boolean);
        const { samples, blocks } = recoveryOf(seq);
        if (blocks.length && samples.length) {
            const maxB = Math.max(...blocks.map(b => b.DI)), minC = Math.min(...samples.map(s => s.DI));
            if (maxB < minC && avTier) {
                for (const b of blocks) {
                    out.periods.push({ id: `erp-av-${b.after.key}`, tier: avTier, kind: 'erp', explains: b.s.key,
                                       t0Ms: b.after.entry, t1Ms: b.after.end + maxB, t1HiMs: b.after.end + minC });
                }
                claim('periods-av', `AV node: a P was blocked after ${r0(maxB)} ms of recovery and one conducted after ${r0(minC)} ms, `
                    + 'so its refractory period ends in that span (fitted to this strip, not measured). Shaded: refractory; hatched: recovering.');
            } else if (maxB >= minC) {
                claim('periods-none-pattern', 'The AV block does not follow the recovery times (a P conducted after a shorter recovery than '
                    + 'one that was blocked, as in Mobitz II): no refractory period explains it, and none is drawn.');
            }
        }
    }

    // Mobitz II is drawn as block below the His at a ratio the rate does not explain: a sentence, no bar
    if (mech === 'avnodal' && !ectopy && !(P.blockBelowHis >= 0.5) && L.paths.some(p => p.role === 'his-block')) {
        claim('periods-none-pattern', 'The block below the His does not follow the recovery times (Mobitz II): no refractory period '
            + 'explains it, and none is drawn.');
    }

    // ── below the His (2:1 and higher ratios with every P reaching the His) ──
    if (mech === 'avnodal' && !ectopy && P.blockBelowHis >= 0.5) {
        const his = L.paths.filter(p => p.role === 'his' && p.beatId != null);
        const hb = L.paths.filter(p => p.role === 'his-block');
        const seq = [
            ...his.map(p => ({ key: p.beatId, t: p.from.tMs, entry: p.from.tMs, end: p.to.tMs })),
            ...hb.map(p => ({ key: p.atrialId, t: p.from.tMs, entry: p.from.tMs, end: null })),
        ].sort((a, b) => a.t - b.t);
        const { samples, blocks } = recoveryOf(seq);
        if (blocks.length && samples.length) {
            const maxB = Math.max(...blocks.map(b => b.DI)), minC = Math.min(...samples.map(s => s.DI));
            if (maxB < minC && userTiers.includes('His')) {
                for (const b of blocks) {
                    out.periods.push({ id: `erp-his-${b.after.key}`, tier: 'His', kind: 'erp', explains: b.s.key,
                                       t0Ms: b.after.entry, t1Ms: b.after.end + maxB, t1HiMs: b.after.end + minC });
                }
                claim('periods-his', `Below the His: a wave was blocked after ${r0(maxB)} ms of recovery and one conducted after ${r0(minC)} ms `
                    + '(fitted to this strip, not measured). Shaded: refractory; hatched: recovering.');
            } else if (maxB < minC) {
                claim('periods-need-his', 'The block is below the His: add the His tier to see its refractory period.');
            } else {
                claim('periods-none-pattern', 'The block below the His does not follow the recovery times (Mobitz II): no refractory period is drawn.');
            }
        }
    }

    // ── concealed conduction: a wave that reached no chamber still left the node refractory for the next P ──
    if (avTier) {
        const concealed = L.paths.filter(p => (p.role === 'av-concealed' || p.role === 'hprime-retro') && p.terminal === 'block');
        const av = [...byAtrial('av').values()];
        const blk = [...byAtrial('av-block').values()].sort((a, b) => a.from.tMs - b.from.tMs);
        let any = false;
        for (const c of concealed) {
            const t0 = Math.min(c.from.tMs, c.to.tMs);
            const next = blk.find(b => b.from.tMs > t0);
            if (!next) continue;
            // only if nothing conducted through the node in between: then the concealed wave is what it met
            if (av.some(a => a.from.tMs > t0 && a.from.tMs < next.from.tMs)) continue;
            if (next.from.tMs - t0 > 450) continue;                     // beyond any nodal refractory period: not the reason
            if (out.periods.some(p => p.explains === next.atrialId)) continue;
            out.periods.push({ id: `conceal-${next.atrialId}`, tier: avTier, kind: 'conceal', explains: next.atrialId,
                               t0Ms: t0, t1Ms: next.from.tMs + 20, t1HiMs: next.from.tMs + 20 });
            any = true;
        }
        if (any) claim('periods-conceal', 'AV node: a wave that reached neither chamber (concealed conduction) left it refractory for the next P. '
            + 'The bar runs to that P; how long the node stayed refractory beyond it is not known from the strip.');
    }

    // bars are drawn in time order, never with a negative width
    out.periods = out.periods.filter(p => [p.t0Ms, p.t1Ms, p.t1HiMs].every(Number.isFinite) && p.t1Ms > p.t0Ms)
        .map(p => ({ ...p, t0Ms: r0(p.t0Ms * 10) / 10, t1Ms: r0(p.t1Ms * 10) / 10, t1HiMs: r0(Math.max(p.t1Ms, p.t1HiMs) * 10) / 10 }))
        .sort((a, b) => a.t0Ms - b.t0Ms);
    return out;
}

