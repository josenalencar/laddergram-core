/**
 * A live heart for the EP view: the reading of a tracing, turned into a small network that keeps beating,
 * answers the stimulator and can be cardioverted.
 *
 * The idea is Iravanian's (svtsim.com; Iravanian S et al., "A Network-based Cardiac Electrophysiology
 * Simulator with Realistic Signal Generation and Response to Pacing Maneuvers", CinC 2021): a heart seen
 * through a few catheters is well described as a graph. Nodes are places that activate and then stay
 * refractory for a while (the sinus node, the atrium, the His, the ventricle, a focus); links are
 * conduction paths whose delay and refractoriness depend on how long they have had to recover since they
 * last conducted. Decremental conduction, block, echoes and re-entry are not programmed as rules: they
 * follow from those two numbers on every path. This file is written from that description; no code of
 * svtsim is used.
 *
 * What is ours is where the network starts: `fromReading` builds it from a ladder, so the live tracing
 * begins as the static figure — the same cycle, PR, AH, HV and VA, the same re-entry circuit or focus, the
 * same sequences (egm.js draws every activation with `activationDeflections`, the mapping the static figure
 * uses). From there the reader paces.
 *
 * A teaching model, not a patient: one atrium, one His, one ventricle; delays and refractory periods are
 * typical values fitted to the reading. Ablation and drugs are not modelled.
 *
 * Pure and deterministic: no DOM, no clock — the page advances the simulation with `step(dtMs)`.
 */
import { resolveParams, buildLadder, normalizeTiers, DEFAULT_TIERS } from './engine.js';
import { activationDeflections, cleanEp, DEFAULT_EP } from './egm.js';

const r1 = (t) => Math.round(t * 10) / 10;
function median(a) {
    const v = a.filter(Number.isFinite);
    if (!v.length) return null;
    const s = v.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const diffs = (t) => t.slice(1).map((x, i) => x - t[i]);
function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// ─── conduction ─────────────────────────────────────────────────────────────

/**
 * A conduction time: `min` when the path has fully recovered, up to `min + span` when it conducts right at
 * the end of its refractory period (DI = erp), decaying with `tau` in between.
 *
 * DI is counted from the moment the previous wave FINISHED crossing the path. That is what makes decremental
 * conduction progressive: a longer delay leaves less time to recover before the next wave, which is delayed
 * longer still, until one arrives inside the refractory period — Wenckebach, from two numbers.
 * @param p   { min, span, tau, erp }
 * @param DI  time since the path finished conducting (ms)
 */
export function conductionDelay(p, DI) {
    return Math.max(0, p.min + (p.span || 0) * Math.exp(-(DI - p.erp) / (p.tau || 100)));
}

/** A decremental path fitted so that its delay is `atMs` when it finished conducting `diMs` earlier. */
export function fitPath(atMs, diMs, erp, { span = 100, tau = 120 } = {}) {
    const e = Math.exp(-(Math.max(diMs, erp) - erp) / tau);
    let sp = span;
    if (atMs - sp * e < 5) sp = Math.max(0, (atMs - 5) / e);
    return { min: atMs - sp * e, span: sp, tau, erp };
}
const fixed = (ms, erp = 0) => ({ min: ms, span: 0, tau: 100, erp });

/**
 * A recovery curve through the (DI, delay) pairs of a Wenckebach period: exactly through the longest
 * recovery and the two shortest (the steps that decide when the period ends), so the network repeats the
 * periods the ladder drew; the floor `min` is solved for, the two-point fit with min just under the
 * shortest delay is the fallback.
 */
function fitRecovery(samples, erp) {
    const pts = [...new Map(samples.map(x => [Math.round(x.DI), x])).values()].sort((x, y) => x.DI - y.DI);
    const a = pts[pts.length - 1], b = pts[0], c = pts[1];
    const dLow = Math.min(...pts.map(x => x.d));
    const through = (m) => ({ min: m, tau: (a.DI - b.DI) / Math.log((b.d - m) / (a.d - m)) });
    if (pts.length >= 3 && c !== a && b.d > c.d && c.d > a.d) {
        const g = (m) => Math.log((a.d - m) / (b.d - m)) / (a.DI - b.DI) - Math.log((c.d - m) / (b.d - m)) / (c.DI - b.DI);
        let lo = 0, hi = dLow - 1e-3;
        if (g(lo) * g(hi) < 0) {
            for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (g(lo) * g(mid) <= 0) hi = mid; else lo = mid; }
            const { min, tau } = through((lo + hi) / 2);
            if (Number.isFinite(tau) && tau > 5) return { min, span: (b.d - min) * Math.exp((b.DI - erp) / tau), tau, erp };
        }
    }
    const min = dLow - 1;
    let { tau } = a.DI > b.DI && a.d > min && b.d > a.d ? through(min) : { tau: 120 };
    if (!(Number.isFinite(tau) && tau > 5)) tau = 120;
    return { min, span: (b.d - min) * Math.exp((b.DI - erp) / tau), tau, erp };
}

const AP_ATRIAL = { leftLateral: 'apLeftLateral', septal: 'apSeptal', rightLateral: 'apRightLateral' };
const AP_VENT = { leftLateral: 'preLeftLateral', septal: 'preSeptal', rightLateral: 'preRightLateral' };

// ─── from a reading ─────────────────────────────────────────────────────────

/**
 * The network a reading describes.
 * @param input  { beats, atrial, mechanism, params, tiers, durationMs } — as buildLadder takes it
 * @param ep     the EP settings (cleanEp): the pathway site and the focus origin
 * @returns spec { mechanism, apSite, vOrigin, P, nodes, links, couplers, seeds: { lasts, force }, t0Ms, meta }
 *   seeds.lasts  { [node id]: its previous activation, [link id]: when its previous conduction ended }
 *   seeds.shown  [activation] — seeded activations late enough to be on the recording: written, not conducted
 *   node   { id, kind?: 'A'|'H'|'V', erp, prime?, auto?: { cycleMs, firstMs, jitter?, tag? } }
 *   link   { id, from, to, ante: path|null, retro: path|null, tagTo, tagFrom }
 *   path   { min, span, tau, erp, conceal?: [link id], pattern?: [bool] } — `pattern` conducts or blocks the
 *          waves that reach it in turn, repeating (a Mobitz II ratio, which no recovery time explains)
 *   coupler { node, to, coupling, every, ownTag } — fires `node` `coupling` ms after every `every`-th activation of `to`
 */
export function fromReading(input, ep = DEFAULT_EP) {
    const opts = cleanEp(ep) ?? cleanEp({});
    const P = resolveParams(input.params);
    const beats = (input.beats || []).slice().sort((a, b) => a.qrsOnMs - b.qrsOnMs);
    const atrial = (input.atrial || []).slice().sort((a, b) => a.tMs - b.tMs);
    const tiers = normalizeTiers([...((input.tiers && input.tiers.length) ? input.tiers : DEFAULT_TIERS), 'His']);
    const L = buildLadder({ beats, atrial, mechanism: input.mechanism, params: input.params, tiers, durationMs: input.durationMs });
    const mech = L.mechanism;
    const apSite = opts.apSite === 'auto' ? (mech === 'pjrt' ? 'septal' : 'leftLateral') : opts.apSite;
    const vOrigin = opts.vOrigin, atSite = opts.atSite;

    const q = beats.map(b => b.qrsOnMs);
    const q0 = q.length ? q[0] : 400;
    const CL = median(diffs(q)) ?? 800;
    const sinusP = L.events.filter(e => e.tier === 'A' && (e.role === 'p' || e.role === 'p-edge')).map(e => e.tMs).sort((a, b) => a - b);
    const PP = median(diffs(sinusP)) ?? 800;
    const p0 = sinusP.length ? sinusP[0] : 200;
    const PR = median(L.intervals.map(i => i.PRms).filter(x => x != null)) ?? (P.PA + 80 + P.HV);
    const qrsBeats = new Set(L.events.filter(e => e.role === 'qrs').map(e => e.beatId));
    const conds = beats.filter(b => qrsBeats.has(b.id)).map(b => String(b.conduction || ''));
    const nR = conds.filter(c => c.includes('RBBB')).length, nL = conds.filter(c => c.includes('LBBB')).length;
    const vTag = nR > conds.length / 2 ? 'RBBB' : nL > conds.length / 2 ? 'LBBB' : 'normal';
    const VA = P.VA, HV = P.HV;

    const nodes = [], links = [], couplers = [], lasts = {}, force = [], shown = [];
    const node = (id, o = {}) => { nodes.push({ id, erp: 0, ...o }); };
    const link = (id, from, to, o = {}) => { links.push({ id, from, to, ante: o.ante ?? null, retro: o.retro ?? null, tagTo: o.tagTo ?? null, tagFrom: o.tagFrom ?? null }); };
    const byId = (id) => nodes.find(n => n.id === id) || links.find(l => l.id === id);

    // The chambers and the sinus node, as every reading has them.
    node('SN', { erp: 150, auto: { cycleMs: PP, firstMs: p0 - P.SACT } });
    node('A', { kind: 'A', erp: mech === 'afib' ? 80 : 200 });
    node('H', { kind: 'H', erp: 250 });
    node('V', { kind: 'V', erp: 250 });
    const AH = PR - HV;                                                  // P onset → His: the delay of the AV path (PA + AH)
    // AV nodal refractoriness counted from the end of the last conduction: a quarter of the recovery the rhythm
    // gives it, 150–250 ms (a coupling ERP of ~300–400 ms at usual rates), and always shorter than that recovery
    const nodalErp = (di) => Math.min(0.8 * di, Math.max(150, Math.min(250, 0.25 * di)));
    link('sa', 'SN', 'A', { ante: fixed(P.SACT), retro: fixed(P.SACT), tagTo: 'sinus' });
    link('fast', 'A', 'H', { ante: fitPath(AH, PP - AH, nodalErp(PP - AH)), retro: fitPath(110, 600, 300, { span: 60 }), tagFrom: 'fast' });
    link('hv', 'H', 'V', { ante: fixed(HV), retro: fixed(P.vExit), tagTo: vTag, tagFrom: 'retro' });
    const fast = byId('fast'), hv = byId('hv'), sn = byId('SN');
    // A ventricular beat that does not reach the atrium still penetrates the node, and leaves it refractory
    // for the next P (the compensatory pause of a PVC; the blocked P waves of VT).
    const concealedRetro = () => ({ ...fitPath(110, 600, 300, { span: 60 }), conceal: ['fast'] });

    // The steady state before the first beat: every node activated, and every path finished conducting, one
    // cycle earlier — so the first beat is drawn with the delays of the ones after it.
    const sinusSeeds = (prevP = p0 - PP) => Object.assign(lasts, {
        SN: prevP - P.SACT, sa: prevP, A: prevP, fast: prevP + AH, H: prevP + AH, hv: prevP + PR, V: prevP + PR,
    });

    switch (mech) {
        case 'avnrt': {
            sn.auto.firstMs = q0 + PP;                                   // overdriven by the tachycardia
            const ante = CL - VA - HV, back = VA + HV;
            const typical = ante >= back;
            link('slow', 'A', 'H', { tagFrom: 'slow' });
            const slow = byId('slow');
            const H0 = q0 - HV, Aprev = q0 + VA - CL;
            if (typical) {
                // down the slow pathway, up the fast one: at every retrograde P the fast pathway has only just
                // finished conducting and refuses; the slow one has recovered and takes the wave down again
                slow.ante = fitPath(ante, back, 0.6 * back);
                fast.retro = fitPath(back, ante, 0.75 * ante, { span: 40 });
                fast.ante = fitPath(P.PA + 80, 800, 0.75 * ante);
                Object.assign(lasts, { slow: H0, fast: Aprev });
            } else {
                // atypical: down the fast pathway, up the slow one
                fast.ante = fitPath(ante, back, 0.6 * back);
                slow.retro = fitPath(back, ante, 0.75 * ante, { span: 40 });
                fast.retro = null;
                Object.assign(lasts, { fast: H0, slow: Aprev });
            }
            Object.assign(lasts, { A: Aprev, H: H0 - CL, V: q0 - CL, hv: q0 - CL });
            shown.push({ kind: 'A', tMs: Aprev, origin: typical ? 'fast' : 'slow' });
            force.push({ node: 'H', tMs: H0, via: typical ? 'slow' : 'fast' });
            break;
        }
        case 'avrt': case 'pjrt': {
            sn.auto.firstMs = q0 + PP;
            const ante = CL - VA - HV;
            fast.ante = fitPath(ante, VA + HV, Math.max(20, 0.75 * (VA + HV)));
            fast.retro = null;                                           // the node is refractory behind every beat
            const apRetro = fitPath(VA, CL - VA, 0.75 * (CL - VA), mech === 'pjrt' ? { span: 150, tau: 200 } : { span: 0 });
            link('ap', 'A', 'V', { retro: apRetro, tagFrom: AP_ATRIAL[apSite] });
            {
                // A concealed pathway still takes the atrial wave in, and blocks it at the ventricular end: after a
                // sinus beat it is still refractory when the ventricle reaches it, so sinus rhythm does not echo.
                // An atrial extrastimulus that lengthens the AV delay gives it time to recover — the induction.
                const pen = 30;
                const sinusPR = conductionDelay(fast.ante, 1000) + HV;
                apRetro.erp = Math.min(CL - VA - 5, Math.max(apRetro.erp, sinusPR - pen + 20));
                byId('ap').ante = { ...fixed(pen), conceal: [] };
            }
            const H0 = q0 - HV, Aprev = q0 + VA - CL;
            Object.assign(lasts, { A: Aprev, H: H0 - CL, V: q0 - CL, hv: q0 - CL, fast: H0, ap: Aprev });
            shown.push({ kind: 'A', tMs: Aprev, origin: AP_ATRIAL[apSite] });
            force.push({ node: 'H', tMs: H0, via: 'fast' });
            break;
        }
        case 'avrtAnti': {
            sn.auto.firstMs = q0 + PP;
            link('ap', 'A', 'V', { ante: fitPath(CL - VA, VA, 0.75 * VA, { span: 0 }), tagTo: AP_VENT[apSite] });
            hv.retro = fixed(P.vhMs);
            const back = Math.max(10, VA - P.vhMs);
            fast.retro = fitPath(back, CL - back, 0.75 * (CL - back), { span: 0 });
            const Aprev = q0 + VA - CL;
            Object.assign(lasts, { A: Aprev, V: q0 - CL, H: q0 + P.vhMs - CL, ap: q0, hv: q0 + P.vhMs - CL, fast: Aprev });
            shown.push({ kind: 'A', tMs: Aprev, origin: 'fast' });
            force.push({ node: 'V', tMs: q0, via: 'ap', tag: AP_VENT[apSite] });
            break;
        }
        case 'jt': {
            sn.auto.firstMs = q0 + PP;
            node('FH', { erp: 150, auto: { cycleMs: CL, firstMs: q0 - HV } });
            link('fh', 'FH', 'H', { ante: fixed(0), retro: fixed(0) });
            const back = VA + HV;
            fast.retro = fitPath(back, CL - back, 0.75 * (CL - back), { span: 0 });
            Object.assign(lasts, { H: q0 - HV - CL, V: q0 - CL, hv: q0 - CL, fast: q0 + VA - CL, A: q0 + VA - CL });
            shown.push({ kind: 'A', tMs: q0 + VA - CL, origin: 'fast' });
            break;
        }
        case 'at': {
            const focus = L.events.filter(e => e.role === 'focus-atrial').map(e => e.tMs).sort((a, b) => a - b);
            const cyc = median(diffs(focus)) ?? PP, f0 = focus[0] ?? p0;
            sn.auto = { cycleMs: Math.max(cyc * 1.4, 700), firstMs: f0 + Math.max(cyc * 1.4, 700) };
            node('FA', { erp: 150, auto: { cycleMs: cyc, firstMs: f0 } });
            link('fa', 'FA', 'A', { ante: fixed(0), retro: fixed(0), tagTo: atSite });
            fast.ante = fitPath(AH, cyc - AH, nodalErp(cyc - AH));
            const prev = f0 - cyc;
            Object.assign(lasts, { A: prev, fast: prev + AH, H: prev + AH, hv: prev + PR, V: prev + PR });
            break;
        }
        case 'afib': {
            sn.auto.firstMs = null;                                      // silent under fibrillation; it takes over after a shock
            const f0 = L.events.find(e => e.role === 'f')?.tMs ?? 0;
            node('FA', { erp: 60, auto: { cycleMs: P.fibMeanMs, firstMs: f0, jitter: 0.3, shockable: true } });
            link('fa', 'FA', 'A', { ante: fixed(0), retro: fixed(0), tagTo: 'af' });
            const d = P.PA + 80;
            fast.ante = fitPath(d, Math.max(100, CL - d), Math.max(150, CL - d - 85));
            break;
        }
        case 'flutter': {
            sn.auto.firstMs = null;
            const F = L.events.filter(e => e.role === 'F').map(e => e.tMs).sort((a, b) => a - b);
            const FF = L.flutter?.cycleMs ?? median(diffs(F)) ?? 220;
            const k = Math.max(1, Math.round(CL / FF));
            node('FA', { erp: 100, auto: { cycleMs: FF, firstMs: F[0] ?? 0, shockable: true } });
            link('fa', 'FA', 'A', { ante: fixed(0), retro: fixed(0), tagTo: 'flutter' });
            const FR = median(L.intervals.map(i => i.PRms).filter(x => x != null)) ?? (P.PA + 150 + HV);
            const d = FR - HV;
            const erp = k >= 2 ? Math.max(20, (k - 0.5) * FF - d) : Math.max(20, 0.6 * (FF - d));
            fast.ante = fitPath(d, Math.max(erp, k * FF - d), erp);
            const firstAv = L.paths.filter(p => p.role === 'av').map(p => p.from.tMs).sort((a, b) => a - b)[0];
            if (firstAv != null) {
                const prev = firstAv - k * FF;
                Object.assign(lasts, { A: (F[0] ?? 0) - FF, fast: prev + d, H: prev + d, hv: prev + FR, V: prev + FR });
            }
            break;
        }
        case 'avb3': {
            sinusSeeds();
            const infra = P.blockBelowHis >= 0.5;
            if (infra) hv.ante = null; else fast.ante = null;
            fast.retro = null;
            const wide = L.events.some(e => e.role === 'focus-ventricular');
            if (wide) {
                node('FV', { erp: 150, auto: { cycleMs: CL, firstMs: q0 } });
                link('fv', 'FV', 'V', { ante: fixed(0), retro: fixed(0), tagTo: vOrigin });
                hv.retro = null;
            } else {
                node('FH', { erp: 150, auto: { cycleMs: CL, firstMs: q0 - HV } });
                link('fh', 'FH', 'H', { ante: fixed(0), retro: fixed(0) });
            }
            Object.assign(lasts, { V: q0 - CL, H: q0 - HV - CL, hv: q0 - CL });
            break;
        }
        case 'vt': {
            const focus = L.events.filter(e => e.role === 'focus-ventricular').map(e => ({ t: e.tMs, id: e.beatId })).sort((a, b) => a.t - b.t);
            const ids = beats.map(b => b.id);
            const vtRR = median(focus.slice(1).map((f, i) => (ids.indexOf(f.id) === ids.indexOf(focus[i].id) + 1 ? f.t - focus[i].t : NaN))) ?? CL;
            const first = focus[0]?.t ?? q0;
            node('FV', { erp: 150, auto: { cycleMs: vtRR, firstMs: first, shockable: true } });
            link('fv', 'FV', 'V', { ante: fixed(0), retro: fixed(0), tagTo: vOrigin });
            const back = P.ectopicVA != null ? Math.max(10, P.ectopicVA - P.vExit) : null;
            fast.retro = back != null ? fitPath(back, Math.max(50, vtRR - back), 0.6 * Math.max(50, vtRR - back), { span: 0 }) : concealedRetro();
            if (sinusP.length) sinusSeeds();
            else sn.auto.firstMs = null;
            Object.assign(lasts, { V: first - vtRR, hv: first - vtRR });
            break;
        }
        default: {                                                       // avnodal, pvc, hisExtra
            sinusSeeds();
            const ectopy = L.events.some(e => e.role === 'focus-ventricular' || e.role === 'focus-his' || e.role === 'focus-junctional');
            if (P.ectopicVA == null && (mech === 'pvc' || mech === 'hisExtra')) fast.retro = concealedRetro();
            const pvc = L.events.filter(e => e.role === 'focus-ventricular' && !qrsBeats.has(e.beatId)).map(e => e.tMs).sort((a, b) => a - b);
            const hPrime = L.events.filter(e => e.role === 'focus-his').map(e => e.tMs).sort((a, b) => a - b);
            // Every P in order: the AV delay the ladder gave it (none when blocked in the node), whether it went on
            // below the His, and how long the node had recovered when it arrived — counting the waves a PVC or an
            // H′ sent into the node in between. The conduction pattern the network has to reproduce.
            const pathOf = (role, atrialId) => L.paths.find(pp => pp.role === role && pp.atrialId === atrialId);
            const seqP = L.events.filter(e => e.tier === 'A' && e.role === 'p').sort((a, b) => a.tMs - b.tMs).map(e => {
                const av = pathOf('av', e.atrialId);
                return { t: e.tMs, d: av ? av.to.tMs - av.from.tMs : null, hisBlock: !!pathOf('his-block', e.atrialId) };
            });
            const walk = [...seqP.map(x => ({ t: x.t, p: x })), ...pvc.map(t => ({ t, pvc: true })), ...hPrime.map(t => ({ t, hp: true }))].sort((a, b) => a.t - b.t);
            const samples = [], blocks = [];
            let end = null, lastH = -1e9;
            for (const w of walk) {
                if (w.p) {
                    if (end != null) (w.p.d != null ? samples : blocks).push({ DI: w.t - end, d: w.p.d });
                    if (w.p.d != null) { end = w.t + w.p.d; lastH = end; }
                } else if (w.pvc) {
                    const hT = w.t + P.vExit;
                    if (fast.retro && hT - lastH >= 250 && end != null && hT >= end && hT - end >= fast.retro.erp) {
                        end = hT + conductionDelay(fast.retro, hT - end); lastH = hT;
                    }
                } else if (w.hp && end != null) end = Math.max(end, w.t);
            }
            const steadyDI = median(samples.map(x => x.DI));
            if (steadyDI != null) {
                fast.ante = fitPath(AH, steadyDI, nodalErp(steadyDI));
                if (seqP[0]?.d != null) lasts.fast = seqP[0].t - steadyDI;
            }
            const periodic = (bits) => {
                // the shortest repeating unit of a conduct/block sequence (the sequence itself when none repeats)
                for (let k = 1; k <= bits.length; k++) if (bits.every((b, i) => i < k || b === bits[i - k])) return bits.slice(0, k);
                return bits;
            };
            if (mech === 'avnodal' && !ectopy && P.blockBelowHis < 0.5 && blocks.length && samples.length >= 2) {
                const ds = samples.map(x => x.d);
                const minC = Math.min(...samples.map(x => x.DI)), maxB = Math.max(...blocks.map(x => x.DI));
                if (maxB < minC) {
                    const erp = (maxB + minC) / 2;
                    if (Math.max(...ds) - Math.min(...ds) >= 30) {
                        // Wenckebach: the delay grows as the recovery shortens, until a P meets a refractory node
                        fast.ante = fitRecovery(samples, erp);
                    } else {
                        // a fixed ratio (2:1 …) with a constant delay: refractoriness alone
                        fast.ante = { ...fixed(median(ds)), erp };
                    }
                    // the first P: whatever recovery gives it the delay the ladder drew (or blocks it, if it did)
                    const s0 = seqP[0], f = fast.ante;
                    let DI0 = maxB;
                    if (s0.d != null) {
                        const x = s0.d - f.min;
                        DI0 = f.span > 0 && x > 0 ? Math.max(erp, f.erp - f.tau * Math.log(x / f.span)) : minC;
                    }
                    lasts.fast = s0.t - DI0;
                } else {
                    // blocks at recoveries no shorter than conducted ones (Mobitz II in the node): the pattern itself
                    fast.ante = { ...fast.ante, pattern: periodic(seqP.map(x => x.d != null)) };
                }
            }
            const nV = L.events.filter(e => e.role === 'qrs').length;
            if (mech === 'avnodal' && !ectopy && P.blockBelowHis >= 0.5 && nV && sinusP.length / nV >= 1.8) {
                // block below the His: every P reaches the His, and every other one stops there
                hv.ante = { ...fixed(HV), erp: 1.5 * PP - HV };
                const firstConducts = L.paths.some(pp => pp.role === 'his' && pp.beatId != null && Math.abs(pp.from.tMs - (p0 + AH)) < 2);
                lasts.hv = firstConducts ? p0 + PR - 2 * PP : p0 + PR - PP;
            } else if (mech === 'avnodal' && !ectopy && seqP.some(x => x.hisBlock)) {
                // block below the His at a ratio the rate does not explain (Mobitz II): the pattern the ladder drew
                hv.ante = { ...hv.ante, pattern: periodic(seqP.filter(x => x.d != null).map(x => !x.hisBlock)) };
            }
            if (mech === 'pvc' && pvc.length) {
                const sinusQ = q.filter(t => !pvc.includes(t));
                const coupling = median(pvc.map(t => t - Math.max(-Infinity, ...sinusQ.filter(x => x < t))).filter(Number.isFinite)) ?? 450;
                const every = Math.max(1, Math.round(median(pvc.slice(1).map((t, i) => sinusQ.filter(x => x > pvc[i] && x < t).length)) ?? 1));
                node('FV', { erp: 150 });
                link('fv', 'FV', 'V', { ante: fixed(0), tagTo: vOrigin });
                couplers.push({ node: 'FV', to: 'V', coupling, every, ownTag: vOrigin });
            }
            if (mech === 'hisExtra' && hPrime.length) {
                const coupling = median(hPrime.map(t => t - Math.max(-Infinity, ...q.filter(x => x < t))).filter(Number.isFinite)) ?? 450;
                node('Hx', { kind: 'H', prime: true, erp: 150 });
                // H′ reaches neither chamber: it leaves the node behind it refractory, and the next P is blocked
                link('hx', 'Hx', 'H', { ante: { ...fixed(0), conceal: ['fast'] } });
                couplers.push({ node: 'Hx', to: 'V', coupling, every: 1, ownTag: null });
                if (hPrime[0] < q0) force.push({ node: 'Hx', tMs: hPrime[0] });
            }
        }
    }

    const firsts = [...nodes.map(n => n.auto?.firstMs).filter(Number.isFinite), ...force.map(f => f.tMs), 0];
    const t0Ms = Math.min(...firsts) - 5;
    return {
        mechanism: mech, apSite, vOrigin, atSite, P: { ...P }, nodes, links, couplers,
        // the tail of the cycle before the first beat, when the ladder already draws it
        seeds: { lasts, force, shown: shown.filter(a => a.tMs >= t0Ms && L.events.some(e => e.tier === 'A' && Math.abs(e.tMs - a.tMs) < 1)).map(a => ({ ...a, tMs: r1(a.tMs) })) }, t0Ms,
        durationMs: input.durationMs ?? null,
        meta: { CL, PP, PR, VA, HV, vTag },
    };
}

// ─── the simulation ─────────────────────────────────────────────────────────

const CHAMBER_OF_SITE = { HRA: 'A', RVa: 'V' };
const KEEP_MS = 60000;

/**
 * Run a network.
 * @returns sim {
 *   now, spec,
 *   step(dtMs) → activations recorded in that step: [{ kind: 'A'|'f'|'H'|'V'|'S'|'shock', tMs, origin?, retro?, prime?, site?, n? }]
 *   runUntil(tMs), activations(fromMs, toMs), schedule(fromMs, toMs) → { activations, deflections },
 *   pace({ site: 'HRA'|'RVa', s1Ms, n1, s2Ms, s3Ms, s4Ms, sense, continuous }), cancelPacing(), pacing,
 *   cardiovert()
 * }
 */
export function createSim(spec, { seed = 7 } = {}) {
    const rnd = lcg(seed);
    const nodes = new Map(spec.nodes.map(n => [n.id, { ...n, auto: n.auto ? { ...n.auto } : null, last: -1e9, gen: 0, links: [] }]));
    const links = new Map(spec.links.map(l => [l.id, { ...l, busyUntil: -1e9, waves: 0 }]));
    for (const l of links.values()) {
        nodes.get(l.from)?.links.push(l);
        nodes.get(l.to)?.links.push(l);
    }
    const couplers = (spec.couplers || []).map(c => ({ ...c, count: 0 }));
    for (const [id, t] of Object.entries(spec.seeds?.lasts || {})) {
        if (!Number.isFinite(t)) continue;
        if (nodes.has(id)) nodes.get(id).last = t;
        else if (links.has(id)) links.get(id).busyUntil = t;
    }

    let queue = [], seq = 0, now = spec.t0Ms ?? 0, fCount = 0;
    let pacer = null, paceGen = 0;
    const history = [];
    let collected = null;
    const push = (ev) => {
        ev.seq = seq++;
        let lo = 0, hi = queue.length;
        while (lo < hi) { const m = (lo + hi) >> 1; const e = queue[m]; if (e.t < ev.t || (e.t === ev.t && e.seq < ev.seq)) lo = m + 1; else hi = m; }
        queue.splice(lo, 0, ev);
    };
    const cycleOf = (n) => n.auto.cycleMs * (n.auto.jitter ? 1 - n.auto.jitter + 2 * n.auto.jitter * rnd() : 1);
    const schedAuto = (n, t) => { n.gen++; push({ t, type: 'auto', node: n.id, gen: n.gen }); };

    for (const n of nodes.values()) if (n.auto && Number.isFinite(n.auto.firstMs)) schedAuto(n, n.auto.firstMs);
    for (const f of spec.seeds?.force || []) push({ t: f.tMs, type: 'force', node: f.node, via: f.via ?? null, tag: f.tag ?? null });
    for (const a of spec.seeds?.shown || []) push({ t: a.tMs, type: 'shown', act: a });

    function record(act) {
        history.push(act);
        if (collected) collected.push(act);
        if (pacer?.waiting && act.kind === CHAMBER_OF_SITE[pacer.site]) {
            pacer.waiting = false;
            push({ t: act.tMs + pacer.s1Ms, type: 'stim', gen: pacer.gen });
        }
    }

    function activate(n, t, viaId, tag) {
        if (t - n.last < n.erp) return false;
        n.last = t;
        if (n.kind) {
            const kind = n.kind === 'A' && tag === 'af' ? 'f' : n.kind;
            const act = { kind, tMs: r1(t) };
            if (kind === 'A') act.origin = tag || 'sinus';
            else if (kind === 'V') act.origin = tag || 'normal';
            else if (kind === 'H') { if (tag === 'retro') act.retro = true; if (n.prime) act.prime = true; }
            else if (kind === 'f') act.n = fCount++;
            record(act);
        }
        if (n.auto && Number.isFinite(n.auto.cycleMs) && !n.silenced) schedAuto(n, t + cycleOf(n));
        for (const c of couplers) {
            if (c.to !== n.id || (c.ownTag != null && tag === c.ownTag)) continue;
            if (++c.count % c.every === 0) push({ t: t + c.coupling, type: 'coupled', node: c.node });
        }
        for (const l of n.links) if (l.id !== viaId) conduct(l, n, t);
        return true;
    }

    function conduct(l, from, t) {
        const forward = from.id === l.from;
        const p = forward ? l.ante : l.retro;
        if (!p || t < l.busyUntil) return;                          // still carrying the last wave: a collision
        const DI = t - l.busyUntil;
        if (DI < p.erp) return;
        if (p.pattern && !p.pattern[l.waves++ % p.pattern.length]) return;
        const delay = conductionDelay(p, DI);
        l.busyUntil = t + delay;
        if (p.conceal) {
            for (const id of p.conceal) { const k = links.get(id); if (k) k.busyUntil = Math.max(k.busyUntil, t + delay); }
            return;
        }
        push({ t: t + delay, type: 'arrive', node: forward ? l.to : l.from, via: l.id, tag: forward ? l.tagTo : l.tagFrom });
    }

    function handle(ev) {
        if (ev.type === 'auto') {
            const n = nodes.get(ev.node);
            if (!n || ev.gen !== n.gen || n.silenced) return;
            if (!activate(n, ev.t, null, n.auto?.tag ?? null)) schedAuto(n, ev.t + cycleOf(n));
        } else if (ev.type === 'arrive' || ev.type === 'force') {
            const n = nodes.get(ev.node);
            if (!n) return;
            if (ev.type === 'force') n.last = Math.min(n.last, ev.t - n.erp - 1);
            activate(n, ev.t, ev.via, ev.tag);
        } else if (ev.type === 'shown') {
            record({ ...ev.act });
        } else if (ev.type === 'coupled') {
            const n = nodes.get(ev.node);
            if (n) activate(n, ev.t, null, null);
        } else if (ev.type === 'stim') {
            if (!pacer || ev.gen !== pacer.gen) return;
            record({ kind: 'S', tMs: r1(ev.t), site: pacer.site });
            const chamber = nodes.get(CHAMBER_OF_SITE[pacer.site]);
            activate(chamber, ev.t, null, pacer.site === 'HRA' ? 'sinus' : 'RV');
            if (pacer.continuous) push({ t: ev.t + pacer.s1Ms, type: 'stim', gen: pacer.gen });
            else if (pacer.i < pacer.intervals.length) push({ t: ev.t + pacer.intervals[pacer.i++], type: 'stim', gen: pacer.gen });
            else pacer = null;
        }
    }

    function step(dtMs) {
        const until = now + Math.max(0, dtMs);
        const out = [];
        collected = out;
        while (queue.length && queue[0].t <= until) {
            const ev = queue.shift();
            now = ev.t;
            handle(ev);
        }
        now = until;
        collected = null;
        if (history.length && history[0].tMs < now - KEEP_MS) {
            const cut = history.findIndex(a => a.tMs >= now - KEEP_MS);
            history.splice(0, cut < 0 ? history.length : cut);
        }
        return out;
    }

    function cancelPacing() { pacer = null; }

    /**
     * The stimulator: S1 × n1 then S2, S3, S4 (each measured from the stimulus before it), from the HRA or the
     * RV apex. With `sense`, the first stimulus comes S1 after the next beat sensed at that site; `continuous`
     * paces at S1 until stopped.
     */
    function pace({ site = 'HRA', s1Ms = 600, n1 = 8, s2Ms = null, s3Ms = null, s4Ms = null, sense = true, continuous = false } = {}) {
        if (!CHAMBER_OF_SITE[site] || !(s1Ms >= 150)) throw new Error('pace: a site (HRA or RVa) and an S1 of at least 150 ms');
        const extra = [s2Ms, s3Ms, s4Ms].filter(v => Number.isFinite(v) && v > 0);
        pacer = { site, s1Ms, continuous: !!continuous, gen: ++paceGen, waiting: !!sense, i: 0,
                  intervals: [...Array(Math.max(0, Math.round(n1) - 1)).fill(s1Ms), ...extra] };
        if (!sense) push({ t: now + 10, type: 'stim', gen: pacer.gen });
    }

    /**
     * A synchronised shock: every node and path depolarised at once. Re-entry stops (no path is left to carry
     * it), and so do the rhythms this model draws as a driver but that are re-entrant in the heart —
     * fibrillation, flutter, ventricular tachycardia (`shockable`); an automatic focus fires again after its
     * cycle, and the sinus node takes over after its own. A shocked driver stays silent: no later beat restarts it.
     */
    function cardiovert() {
        const t = now;
        record({ kind: 'shock', tMs: r1(t) });
        queue = queue.filter(e => e.type === 'auto');
        pacer = null;
        for (const n of nodes.values()) {
            n.last = t;
            if (!n.auto || !Number.isFinite(n.auto.cycleMs)) continue;
            if (n.auto.shockable) { n.gen++; n.silenced = true; }        // the circuit is gone: nothing restarts it
            else schedAuto(n, t + cycleOf(n));
        }
        for (const l of links.values()) l.busyUntil = t;
    }

    return {
        spec,
        get now() { return now; },
        get pacing() { return pacer ? { site: pacer.site, waiting: pacer.waiting, continuous: pacer.continuous } : null; },
        step,
        runUntil(tMs) { if (tMs > now) step(tMs - now); return history; },
        activations(fromMs = -Infinity, toMs = Infinity) { return history.filter(a => a.tMs >= fromMs && a.tMs <= toMs); },
        /** The deflections of what happened in [fromMs, toMs], for egmSamples-style drawing or the sweep. */
        schedule(fromMs, toMs) {
            const acts = history.filter(a => a.tMs >= fromMs - 200 && a.tMs <= toMs);
            return { activations: acts, deflections: acts.flatMap(a => activationDeflections(a, spec.P)).sort((a, b) => a.tMs - b.tMs) };
        },
        pace, cancelPacing, cardiovert,
    };
}
