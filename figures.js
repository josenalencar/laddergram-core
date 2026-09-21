/**
 * Figures of "Using Lewis Ladder Diagrams in the Differential Diagnosis of
 * Arrhythmias: A Contemporary Review" (Barreiro … Nunes de Alencar), built
 * with the laddergram system itself: one synthetic tracing per figure, the
 * SAME P and QRS marks under every panel, one mechanism per panel.
 *
 * Tier sets follow the manuscript text; timings follow the tracing (which was
 * chosen so all panels of a figure can explain it — see laddergramSynth.js).
 * Pure: no DOM.
 */
import { makeExample } from './synth.js';
import { resolveParams, suggestVA } from './engine.js';

const WIDTH = { normal: 95, ivcd: 110, lbbb: 160, rbbb: 140, vt: 165, pvc: 170, fusion: 125, paced: 160 };
// Intracardiac brackets on figures (PREMISES.md §5): one beat, and only the interval that tells the panels apart.

// Figure 1 is drawn in the second ladder convention ("Dots on lines", the style of the original hand-made
// figures); Figure 0 shows the same normal beat in both. Every other figure uses classic tiers.
// SP 60 (sinoatrial conduction, normal ~45–125 ms: 40 was below it), PH = PA + AH = 100, HV 40 (PR 140)
const NORMAL = { SACT: 60, PA: 30, HV: 40 };

export const FIGURES = [
    {
        id: 'fig0', file: 'LLD_Figure0_normal_ladder_two_styles', scenario: 'normalSinus',
        title: 'Figure 0. The normal ladder diagram and its intervals, drawn in the two conventions',
        panels: [
            { mechanism: 'avnodal', tiers: ['SN', 'A', 'AV', 'His', 'V'], params: NORMAL, style: 'bands', brackets: { beat: 1 },
              title: 'Classic tiers: each level is a band, and a line’s slope across it is the conduction time',
              caption: 'SP: sinus discharge to P onset (sinoatrial conduction, ~60 ms). PH: P onset to His activation (atrium plus AV node, the surface counterpart of the AH, ~100 ms). HV: His to ventricular activation (~40 ms). PR = PH + HV.' },
            { mechanism: 'avnodal', tiers: ['SN', 'A', 'AV', 'His', 'V'], params: NORMAL, style: 'lines', brackets: { beat: 1 },
              title: 'Dots on lines: each level is a line, and a dot is its activation',
              caption: 'The same beats and the same intervals: the segments between two lines carry the conduction times the bands carried above.' },
        ],
    },
    {
        id: 'fig1', file: 'LLD_Figure1_shortRP_narrowQRS_tachycardia', scenario: 'svtShortRP', style: 'lines',
        title: 'Figure 1. Candidate mechanisms of short-RP narrow-QRS tachycardia (same tracing, four readings)',
        panels: [
            { mechanism: 'avnrt', tiers: ['A', 'AV', 'His', 'V'], params: { VA: 80 }, title: 'Typical (slow–fast) AVNRT', brackets: { beat: 1, show: ['VA'] },
              caption: 'Down the slow pathway (shallow), back up the fast one (steep): the loop closes between the AV and His lines; atrium and ventricle are bystanders.' },
            { mechanism: 'avrt', tiers: ['A', 'AV', 'V'], params: { VA: 80, apVdelay: 30 }, title: 'Orthodromic AVRT', brackets: { beat: 1, show: ['VA'] },
              caption: 'Down the node, back up an accessory pathway (AP): the atrium and ventricle are part of the loop.' },
            { mechanism: 'at', tiers: ['A', 'AV', 'His', 'V'], params: {}, brackets: { beat: 1, show: ['PR'] }, title: 'Atrial tachycardia with first-degree AV block',
              caption: 'Every atrial activation starts de novo at the focus; slow nodal conduction (PR {PR} ms).' },
            { mechanism: 'jt', tiers: ['A', 'AV', 'His', 'V'], params: { VA: 80 }, title: 'Junctional tachycardia',
              caption: 'A focus in the node conducts down to the ventricle and up to the atrium at once.' },
        ],
    },
    {
        id: 'fig2', file: 'LLD_Figure2_longRP_narrowQRS_tachycardia', scenario: 'svtLongRP',
        title: 'Figure 2. Candidate mechanisms of long-RP narrow-QRS tachycardia (same tracing, three readings)',
        panels: [
            { mechanism: 'pjrt', tiers: ['A', 'AV', 'His', 'V'], params: { VA: 270, apVdelay: 35 }, brackets: { beat: 1, show: ['VA'] }, title: 'Permanent junctional reciprocating tachycardia',
              caption: 'Orthodromic circuit whose retrograde limb is a concealed, slowly and decrementally conducting pathway (wavy AP).' },
            { mechanism: 'avnrt', tiers: ['A', 'AV', 'His', 'V'], params: { VA: 270 }, brackets: { beat: 1, show: ['VA'] }, title: 'Atypical (fast–slow) AVNRT',
              caption: 'Down the fast pathway (steep), back up the slow one (shallow), both between the AV and His lines: the long RP is retrograde nodal conduction.' },
            { mechanism: 'at', tiers: ['A', 'AV', 'His', 'V'], params: {}, brackets: { beat: 1, show: ['PR'] }, title: 'Atrial tachycardia',
              caption: 'Normal nodal conduction (PR {PR} ms): the late P is a primary atrial focus.' },
        ],
    },
    {
        id: 'fig3', file: 'LLD_Figure3_wideQRS_tachycardia', scenario: 'wideTachy1to1',
        title: 'Figure 3. Candidate mechanisms of wide-QRS tachycardia (same tracing, three readings)',
        panels: [
            { mechanism: 'vt', tiers: ['SN', 'A', 'AV', 'V'], params: { ectopicVA: 210, vExit: 20 }, brackets: { beat: 1, show: ['VA'] }, title: 'Ventricular tachycardia with 1:1 retrograde conduction',
              caption: 'Each cycle starts in the ventricle; the retrograde line crosses the node, captures the atrium and resets the sinus node.' },
            // with LBBB the ventricles are reached over the RBB: HV normal to mildly long (55 ms, upper normal), His still before the QRS
            { mechanism: 'avnrt', tiers: ['A', 'AV', 'His', 'RBB', 'LBB', 'V'], params: { VA: 210, HV: 55 }, conduction: 'LBBB', brackets: { beat: 1, show: ['HV'] },
              title: 'Supraventricular tachycardia with aberrancy (fast–slow AVNRT with LBBB)',
              caption: 'The circuit is nodal; the QRS widens below it: the LBB blocks, the RBB conducts.' },
            { mechanism: 'avrtAnti', tiers: ['A', 'AV', 'His', 'V'], params: { VA: 210, vhMs: 110, apAnteMs: 45 }, title: 'Antidromic AVRT', brackets: { beat: 1, show: ['VH'] },
              caption: 'Down a fast accessory pathway (short P-to-delta, pre-excited QRS); the slow part is the return: ventricular muscle to the His, then the node, to the atrium.' },
        ],
    },
    {
        id: 'fig4', file: 'LLD_Figure4_VT_dissociation_capture_fusion', scenario: 'vtCaptureFusion',
        title: 'Figure 4. Ventricular tachycardia with AV dissociation, a capture beat and a fusion beat',
        panels: [
            { mechanism: 'vt', tiers: ['SN', 'A', 'AV', 'V'], params: { vExit: 20 }, brackets: [{ beat: 3, show: ['PR'] }, { beat: 8, show: ['PR'] }], title: 'VT with AV dissociation',
              caption: 'Sinus P waves march through at their own rate and die in the refractory node; one captures the ventricles (narrow QRS), a later one fuses with a VT beat.' },
        ],
    },
    {
        id: 'fig5', file: 'LLD_Figure5_2to1_AV_block', scenario: 'twoToOneIvcd',
        title: 'Figure 5. Candidate mechanisms of 2:1 AV block (same tracing, three readings)',
        panels: [
            { mechanism: 'avnodal', tiers: ['SN', 'A', 'AV', 'His', 'V'], params: {}, brackets: { beat: 0, show: ['HV'] },
              title: '2:1 AV block in the AV node',
              caption: 'Every other P ends in the nodal tier; the conducted P waves cross the His with a normal HV.' },
            { mechanism: 'avnodal', tiers: ['SN', 'A', 'AV', 'His', 'V'], params: { blockBelowHis: 1, HV: 70 }, brackets: { beat: 0, show: ['HV'] },
              title: '2:1 AV block below the His bundle',
              caption: 'Every P crosses the node and the His; every other one dies below it, and the conducted ones have a long HV.' },
            { mechanism: 'hisExtra', tiers: ['SN', 'A', 'AV', 'His', 'V'], params: { hPrimeLead: 150 }, brackets: { beat: 0, show: ['PR'] },
              title: 'Concealed His extrasystoles (pseudo 2:1 AV block)',
              caption: 'A premature His depolarization (H′), invisible on the ECG, leaves the junction refractory; the two conducted P waves share one PR.' },
        ],
    },
];

/** Ground-truth markers of a figure's tracing — identical under every panel. */
export function figureMarkers(rec) {
    const tr = rec.metadata.truth;
    const beats = tr.QRS.map((q, i) => {
        const w = WIDTH[q.morph] ?? 95;
        return { id: 'b' + i, qrsOnMs: q.t, qrsOffMs: q.t + w, rPeakMs: q.t + 40, qrsWidthMs: w,
                 quality: 'normal', conduction: null, source: 'user',
                 origin: q.capture ? 'capture' : q.fusion ? 'fusion' : q.paced ? 'paced' : undefined,
                 ...(q.focusAt != null ? { focusDelayMs: q.focusAt - q.t } : {}) };
    });
    const atrial = tr.P.map((p, i) => ({ id: 'a' + i, tMs: p.t, source: 'user', ...(p.paced ? { origin: 'paced' } : {}) }));
    return { beats, atrial };
}

/** The panels as the editor holds them: { mechanism, params, tiers, title, caption, style, brackets, beats, atrial }. */
export function figurePanels(fig, rec = makeExample(fig.scenario), markers = null) {
    const { beats, atrial } = markers ? normaliseMarkers(markers) : figureMarkers(rec);
    // Timings come from the marks, not from the preset: on a real tracing the VA of every 1:1 reading
    // is the measured one, and captions quote the measured PR ({VA}, {RP}, {PR}, {CL} placeholders).
    const m = measuredTimings(beats, atrial);
    const fill = (t) => (t == null ? t : String(t).replace(/\{(VA|RP|PR|CL)\}/g, (_, k) => (m[k] != null ? String(m[k]) : '…')));
    const panels = fig.panels.map(p => ({
        mechanism: p.mechanism, params: withMeasuredVA(p.params, m), tiers: p.tiers.slice(), title: fill(p.title), caption: fill(p.caption),
        style: p.style ?? fig.style ?? 'bands',
        brackets: Array.isArray(p.brackets) ? p.brackets.map(x => ({ ...x })) : p.brackets ? { ...p.brackets } : null,
        beats: beats.map(b => ({ ...b, conduction: p.conduction && b.origin == null ? p.conduction : null })),
        atrial: atrial.map(a => ({ ...a })),
    }));
    return { rec, panels };
}

const medianOf = (a) => { if (!a.length) return null; const q = a.slice().sort((x, y) => x - y), h = q.length >> 1; return q.length % 2 ? q[h] : (q[h - 1] + q[h]) / 2; };

/** Median RR, and — when one P follows every QRS (1:1) — the VA / RP and the PR that closes the cycle. */
export function measuredTimings(beats, atrial) {
    const B = beats.slice().sort((a, b) => a.qrsOnMs - b.qrsOnMs);
    const CL = medianOf(B.slice(1).map((b, i) => b.qrsOnMs - B[i].qrsOnMs));
    const va = suggestVA(B, atrial);
    const oneToOne = va && va.n >= 0.6 * B.length && Math.abs(atrial.length - B.length) <= 2;
    const VA = oneToOne ? va.VA : null;
    return { CL: CL != null ? Math.round(CL) : null, VA, RP: VA, PR: VA != null && CL != null ? Math.round(CL - VA) : null };
}

/** A preset's VA (and a VT's ectopic VA) replaced by the measured one when the tracing has it. */
function withMeasuredVA(params, m) {
    const out = { ...params };
    if (m.VA == null) return out;
    if ('VA' in out) out.VA = m.VA;
    if ('ectopicVA' in out) out.ectopicVA = m.VA;
    return out;
}

/**
 * Marks for a real tracing (the article prefers real ECGs; the site keeps the synthetic ones):
 * { beats: [{ qrsOnMs, qrsOffMs, origin? }], atrial: [{ tMs }] } → the editor's beat / atrial objects.
 */
export function normaliseMarkers({ beats = [], atrial = [] }) {
    const B = beats.slice().sort((a, b) => a.qrsOnMs - b.qrsOnMs).map((b, i) => {
        const w = Math.round((b.qrsOffMs ?? b.qrsOnMs + 95) - b.qrsOnMs);
        return { id: 'b' + i, qrsOnMs: b.qrsOnMs, qrsOffMs: b.qrsOnMs + w, rPeakMs: b.rPeakMs ?? b.qrsOnMs + 40, qrsWidthMs: w,
                 quality: 'normal', conduction: null, source: 'user', origin: b.origin === 'capture' || b.origin === 'fusion' ? b.origin : undefined,
                 ...(b.focusDelayMs != null ? { focusDelayMs: b.focusDelayMs } : {}) };
    });
    const A = atrial.slice().sort((a, b) => a.tMs - b.tMs).map((a, i) => ({ id: 'a' + i, tMs: a.tMs, source: 'user' }));
    return { beats: B, atrial: A };
}

/** A time window of a record and its marks, re-based to 0 (a figure shows a few seconds of a 10 s ECG). */
export function cropRecord(rec, markers, { tMinMs, tMaxMs }) {
    const fs = rec.sampleRate, i0 = Math.max(0, Math.round(tMinMs * fs / 1000));
    const n = Math.round((tMaxMs - tMinMs) * fs / 1000);
    const leads = Object.fromEntries(Object.entries(rec.leads).map(([k, v]) => [k, v.slice(i0, i0 + n)]));
    const inside = (t) => t >= tMinMs && t <= tMaxMs;
    const m = markers && {
        beats: (markers.beats || []).filter(b => inside(b.qrsOnMs)).map(b => ({ ...b, qrsOnMs: b.qrsOnMs - tMinMs, qrsOffMs: (b.qrsOffMs ?? b.qrsOnMs + 95) - tMinMs,
                                                                               ...(b.rPeakMs != null ? { rPeakMs: b.rPeakMs - tMinMs } : {}) })),
        atrial: (markers.atrial || []).filter(a => inside(a.tMs)).map(a => ({ ...a, tMs: a.tMs - tMinMs })),
    };
    return { rec: { ...rec, leads, rhythmStrip: null, metadata: { ...(rec.metadata || {}), window: { tMinMs, tMaxMs } } }, markers: m };
}

/** Height (frac) at which the drawn ladder has a point on `tier` at time t — so guides start on the dot. */
function fracAt(ladder, tier, t) {
    for (const e of ladder.events) if (e.tier === tier && Math.abs(e.tMs - t) <= 1) return e.frac;
    for (const p of ladder.paths) for (const q of [p.from, p.to]) if (q.tier === tier && Math.abs(q.tMs - t) <= 1) return q.frac;
    return 0;
}

/**
 * Intracardiac interval brackets on one beat, as the drawn ladder has them: SP (sinus discharge → P onset),
 * PH (P onset → His) and HV (His → QRS onset) for a beat with an anterograde His, VH (QRS onset → His) when
 * the His is reached retrogradely after the QRS, VA (QRS onset → retrograde P onset) when the beat has a
 * retrograde P; PR under the tracing for a conducted beat. Values are those of the reading (plausible, not
 * measured). A click on a QRS shows all of them; a figure lists the ones that discriminate (`show`).
 * @param panel   { beats, atrial, params, tiers }
 * @param ladder  the ladder as drawn (after the style conversion, so guides start on the dots)
 * @param spec    { beatId } or { beat: index into the QRS list }, optional show: ['SP','PH','HV','VH','VA','PR']
 */
export function intervalBrackets(panel, ladder, spec) {
    if (!spec || !ladder) return null;
    if (Array.isArray(spec)) {                                  // more than one measured beat (Figure 5)
        const all = spec.flatMap(x => intervalBrackets(panel, ladder, x) || []);
        return all.length ? all : null;
    }
    const beats = panel.beats.slice().sort((a, b) => a.qrsOnMs - b.qrsOnMs);
    const b = spec.beatId != null ? beats.find(x => x.id === spec.beatId) : beats[spec.beat ?? 0];
    if (!b) return null;
    const P = resolveParams(panel.params);
    const q = b.qrsOnMs;
    const has = (t) => (ladder.tiers || []).includes(t);
    const r = Math.round;
    const out = [];
    const iv = ladder.intervals?.find(i => i.beatId === b.id);
    const conducted = iv && iv.PRms != null;
    const his = ladder.paths.find(p => p.beatId === b.id && p.role === 'his');
    const tH = his ? his.from.tMs : conducted ? q - P.HV : null;
    if (conducted) {
        const tP = q - iv.PRms, tSN = tP - P.SACT;
        if (has('SN')) out.push({ t0: tSN, t1: tP, label: `SP ${r(P.SACT)}`, at0: { tier: 'SN', frac: fracAt(ladder, 'SN', tSN) }, at1: { tier: 'A', frac: 0 } });
        if (has('His') && tH != null) out.push({ t0: tP, t1: tH, label: `PH ${r(tH - tP)}`, at0: { tier: 'A', frac: 0 }, at1: { tier: 'His', frac: 0 } });
    }
    if (has('His') && tH != null && tH < q) out.push({ t0: tH, t1: q, label: `HV ${r(q - tH)}`, at0: { tier: 'His', frac: 0 }, at1: { tier: 'V', frac: 0 } });
    const hr = ladder.paths.find(p => p.beatId === b.id && p.role === 'his-retro' && p.from.tier === 'His' && p.from.tMs > q);
    if (hr) out.push({ t0: q, t1: hr.from.tMs, label: `VH ${r(hr.from.tMs - q)}`, at0: { tier: 'V', frac: 0 }, at1: { tier: 'His', frac: hr.from.frac } });
    const pr = ladder.events.find(e => e.beatId === b.id && e.role === 'p-retro');
    if (pr) out.push({ t0: q, t1: pr.tMs, label: `VA ${r(pr.tMs - q)}`, at0: { tier: 'V', frac: 0 }, at1: { tier: 'A', frac: pr.frac } });
    if (conducted) out.push({ t0: q - iv.PRms, t1: q, label: `PR ${r(iv.PRms)}`, row: 'strip' });
    const shown = spec.show ? out.filter(x => spec.show.includes(x.label.split(' ')[0])) : out;
    return shown.length ? shown : null;
}
