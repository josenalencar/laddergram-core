/**
 * Synthetic 12-lead ECGs for the laddergram generator: teaching examples and
 * test fixtures with a KNOWN timeline (every P, F and QRS onset is recorded
 * in metadata.truth).
 *
 * Model: every wave is a sum of Gaussian bumps, each carrying a 3-D dipole
 * direction (x = left, y = inferior, z = anterior). A lead sees the dot
 * product of that vector with its own axis, so morphology is coherent across
 * the twelve leads: a septal vector gives q in I/V6 and r in V1, a terminal
 * rightward-anterior RBBB vector gives R' in V1 and a slurred S in I/V6, the
 * typical-flutter vector gives a negative sawtooth in II/III/aVF. Baseline
 * wander and noise are added with a fixed seed — the same example is the same
 * signal every time.
 *
 * Pure: no DOM. Leads in mV, 500 Hz, 10 s.
 */

export const SYNTH_FS = 500;
const LEADS = ['I', 'II', 'III', 'aVR', 'aVL', 'aVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'];
const unit = (v) => { const n = Math.hypot(...v); return v.map(x => x / n); };
const AXIS = {
    I: [1, 0, 0], II: [0.5, 0.866, 0], III: [-0.5, 0.866, 0],
    aVR: [-0.866, -0.5, 0], aVL: [0.866, -0.5, 0], aVF: [0, 1, 0],
    V1: unit([-0.5, 0.05, 0.85]), V2: unit([-0.15, 0.05, 1]), V3: unit([0.3, 0.1, 0.95]),
    V4: unit([0.6, 0.15, 0.78]), V5: unit([0.85, 0.1, 0.5]), V6: unit([0.97, 0.1, 0.2]),
};

// Wave templates: [dt from onset (ms), sigma (ms), amplitude (mV), vector].
// P and QRS templates start where their marks are: in lead II every wave leaves the baseline (> 0.04 mV) within
// ~5 ms of its onset mark, so PR/RP measured on a printed lead II agree with the intervals the marks give.
const P_SINUS = [[22, 12, 0.14, unit([0.25, 0.85, 0.45])], [53, 16, 0.1, unit([0.75, 0.45, -0.5])]];
// Retrograde P: low-septal exit, inferior → superior: a clear negative P in II/III/aVF (≈ −0.2 mV), positive in
// aVR and V1 (the pseudo-r′). Larger and broader than a sinus P, as retrograde P waves are on real tracings.
const P_RETRO = [[30, 16, 0.2, unit([-0.1, -0.95, 0.3])], [64, 14, 0.05, unit([-0.1, -0.95, 0.3])]];
const P_PAC = [[34, 15, 0.1, unit([0.35, 0.6, 0.7])], [62, 16, 0.07, unit([0.7, 0.3, -0.4])]];
const QRS = {
    normal: { width: 95, parts: [[14, 6, 0.18, unit([-0.4, 0.1, 0.9])], [44, 11, 1.5, unit([0.55, 0.75, -0.35])], [72, 9, 0.35, unit([-0.2, -0.5, -0.45])]],
              t: [[1, 55, 0.32, unit([0.45, 0.7, 0.35])], [1.12, 35, 0.08, unit([0.45, 0.7, 0.35])]] },
    // The narrow QRS of the review's figures (timeline.visibleOnset): the same beat, but its septal vector has an
    // inferior component, so lead II shows a small q AT the onset mark instead of staying flat for ~18 ms (the
    // printed RP/PR then measure what the text quotes). Opt-in, because the detector's T search is tuned to `normal`.
    normalVisible: { width: 95, parts: [[12, 5, 0.22, unit([-0.4, -0.45, 0.8])], [44, 11, 1.5, unit([0.55, 0.75, -0.35])], [72, 9, 0.35, unit([-0.2, -0.5, -0.45])]],
              t: [[1, 55, 0.32, unit([0.45, 0.7, 0.35])], [1.12, 35, 0.08, unit([0.45, 0.7, 0.35])]] },
    // Nonspecific intraventricular conduction delay, 110 ms: wider than normal but below the 120-ms threshold of
    // bundle branch block (Figure 6 of the review). Fragmented on purpose — q, R, a notch (RsR′, 0.2 mV deep) and
    // a terminal S of 0.5 mV — so the eye reads the width instead of a narrow spike. In lead II the deviation
    // from baseline spans 106 ms of signal starting 4 ms after the mark, which measures ~110 ms with calipers
    // on the printed figure (the drawn line adds a few ms at each end).
    ivcd: { width: 110, parts: [[14, 7, 0.18, unit([-0.3, -0.6, 0.4])], [36, 8, 0.95, unit([0.55, 0.75, -0.35])], [60, 7, 0.35, unit([0.15, 0.3, -0.1])], [78, 8, 0.55, unit([0.4, 0.6, -0.25])], [92, 8.5, 0.62, unit([-0.25, -0.7, -0.3])]],
            t: [[1, 55, 0.3, unit([0.45, 0.7, 0.35])], [1.12, 35, 0.08, unit([0.45, 0.7, 0.35])]] },
    rbbb: { width: 140, parts: [[14, 6, 0.18, unit([-0.4, 0.1, 0.9])], [42, 11, 1.3, unit([0.55, 0.75, -0.35])], [70, 10, 0.3, unit([-0.2, -0.5, -0.45])],
                                [108, 17, 0.6, unit([-0.65, 0.05, 0.75])]],
            t: [[1, 55, 0.28, unit([0.55, 0.6, -0.25])], [1.12, 35, 0.07, unit([0.55, 0.6, -0.25])]] },
    // Wide complexes are wide, not slow: real LBBB / PVC upstrokes are steep, the
    // width comes from a second, delayed component (and PVCs are bigger).
    lbbb: { width: 160, parts: [[14, 8, 0.3, unit([0.6, 0, -0.8])], [52, 15, 1.25, unit([0.8, 0.2, -0.55])], [112, 19, 1.1, unit([0.75, 0.3, -0.6])]],
            t: [[1, 60, 0.36, unit([-0.6, -0.2, 0.7])]] },
    pvc: { width: 170, parts: [[30, 11, 1.1, unit([0.2, 0.9, -0.4])], [78, 18, 1.5, unit([0.3, 0.85, -0.45])], [132, 18, 0.5, unit([-0.2, -0.3, 0.6])]],
           t: [[1, 60, 0.5, unit([-0.3, -0.8, 0.4])]] },
    // Fusion: a conducted and a ventricular wavefront share the ventricles — intermediate width and form
    fusion: { width: 125, parts: [[12, 5, 0.22, unit([-0.4, -0.45, 0.8])], [42, 11, 0.8, unit([0.55, 0.75, -0.35])],
                                  [70, 16, 0.8, unit([-0.45, -0.72, 0.52])], [110, 16, 0.25, unit([0.35, 0.3, -0.55])]],
              t: [[1, 60, 0.3, unit([0.4, 0.7, -0.1])]] },
    // LV-origin VT: RBBB-like, left superior axis (dominant R in V1, negative II/III/aVF)
    vt: { width: 165, parts: [[28, 11, 0.9, unit([-0.35, -0.7, 0.62])], [76, 18, 1.5, unit([-0.45, -0.72, 0.52])], [128, 18, 0.45, unit([0.35, 0.3, -0.55])]],
          t: [[1, 60, 0.45, unit([0.35, 0.7, -0.5])]] },
};

function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const gauss = (rnd) => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

function addBumps(acc, fs, t0, parts) {
    for (const [dt, sigma, amp, vec] of parts) {
        const c = t0 + dt;
        const i0 = Math.max(0, Math.floor((c - 4 * sigma) * fs / 1000)), i1 = Math.min(acc.n - 1, Math.ceil((c + 4 * sigma) * fs / 1000));
        const proj = LEADS.map(l => vec[0] * AXIS[l][0] + vec[1] * AXIS[l][1] + vec[2] * AXIS[l][2]);
        for (let i = i0; i <= i1; i++) {
            const g = amp * Math.exp(-0.5 * ((i * 1000 / fs - c) / sigma) ** 2);
            for (let k = 0; k < 12; k++) acc.leads[LEADS[k]][i] += g * proj[k];
        }
    }
}

/** QT from the preceding RR (Bazett-ish, clamped), for the T-wave position. */
const qtFor = (rr) => Math.max(300, Math.min(460, 400 * Math.sqrt(Math.max(300, rr || 800) / 1000)));

/**
 * Timeline → 12-lead record.
 * timeline = { durationMs, P: [{t, kind}], QRS: [{t, morph}], flutter: {cycleMs, phaseMs} | null, af: bool }
 */
export function synthesizeEcg(timeline, { fs = SYNTH_FS, seed = 7, name = 'synthetic' } = {}) {
    const n = Math.round(timeline.durationMs * fs / 1000);
    const acc = { n, leads: Object.fromEntries(LEADS.map(l => [l, new Float32Array(n)])) };
    const rnd = lcg(seed);
    for (const p of timeline.P || []) addBumps(acc, fs, p.t, p.kind === 'retro' ? P_RETRO : p.kind === 'pac' ? P_PAC : P_SINUS);
    const Q = (timeline.QRS || []).slice().sort((a, b) => a.t - b.t);
    Q.forEach((q, i) => {
        const tpl = (q.morph === 'normal' && timeline.visibleOnset ? QRS.normalVisible : QRS[q.morph]) || QRS.normal;
        addBumps(acc, fs, q.t, tpl.parts);
        const rr = i > 0 ? q.t - Q[i - 1].t : (Q[1] ? Q[1].t - q.t : 800);
        if (timeline.fastT && rr < 700) {
            // tachycardia: repolarisation shortens and the T narrows and shrinks with the cycle, leaving
            // diastole free — where a long-RP P wave shows (QT ≈ 250–300 ms at 130–180 /min)
            // T peak ≈ 190 ms after QRS onset at 167 /min, ≈ 225 ms at 130 /min; a small T ~80 ms wide
            // (σ ≈ 16–20 ms), as on real SVT tracings, so a P in the ST or in diastole stands apart
            const k = rr / 700;
            const tPeak = 0.36 * rr + 60 + (tpl.width - 95) * 0.5;
            addBumps(acc, fs, q.t, tpl.t.map(([f, s, a, v]) => [tPeak * f, s * Math.max(0.3, 0.55 * k), a * Math.max(0.3, 0.6 * k), v]));
        } else {
            const tPeak = qtFor(rr) - 90 + (tpl.width - 95) * 0.5;
            addBumps(acc, fs, q.t, tpl.t.map(([f, s, a, v]) => [tPeak * f, s, a, v]));
        }
    });
    if (timeline.flutter) {
        // typical counter-clockwise flutter: slow descent, quick return → negative sawtooth inferiorly
        const { cycleMs: c, phaseMs } = timeline.flutter;
        const vec = unit([0.1, 0.95, -0.25]);
        for (let t = phaseMs - c * Math.ceil(phaseMs / c); t < timeline.durationMs + c; t += c) {
            addBumps(acc, fs, t, [[0.42 * c, 0.19 * c, -0.2, vec], [0.86 * c, 0.08 * c, 0.12, vec]]);
        }
    }
    if (timeline.af) {
        // fibrillatory waves: three incommensurate 5–7.5 Hz components, slowly amplitude-modulated, largest in V1
        const vec = unit([-0.2, 0.35, 0.9]);
        const proj = LEADS.map(l => vec[0] * AXIS[l][0] + vec[1] * AXIS[l][1] + vec[2] * AXIS[l][2]);
        const comps = [[5.3, rnd() * 6.28], [6.1, rnd() * 6.28], [7.4, rnd() * 6.28]];
        for (let i = 0; i < n; i++) {
            const t = i / fs;
            const env = 0.75 + 0.25 * Math.sin(2 * Math.PI * 0.4 * t + 1.3);
            let v = 0;
            for (const [f, ph] of comps) v += Math.sin(2 * Math.PI * f * t + ph + 0.6 * Math.sin(2 * Math.PI * 0.7 * t));
            v *= 0.022 * env;
            for (let k = 0; k < 12; k++) acc.leads[LEADS[k]][i] += v * proj[k];
        }
    }
    // baseline wander (breathing) + mains-free white noise
    const w1 = rnd() * 6.28, w2 = rnd() * 6.28;
    for (let k = 0; k < 12; k++) {
        const L = acc.leads[LEADS[k]], wa = 0.03 + 0.02 * rnd();
        for (let i = 0; i < n; i++) {
            const t = i / fs;
            L[i] += wa * Math.sin(2 * Math.PI * 0.23 * t + w1 + k * 0.2) + 0.02 * Math.sin(2 * Math.PI * 0.11 * t + w2) + 0.006 * gauss(rnd);
        }
    }
    return { leads: acc.leads, sampleRate: fs, metadata: { sourceFormat: 'synthetic', truth: timeline }, rhythmStrip: null, gaps: null, rhythmGaps: null,
             filename: name };
}

// ─── scenarios ──────────────────────────────────────────────────────────────

const DUR = 10000;
function sinusTrain({ pp, pr, t0 = 250, morph = 'normal', drop = () => false, prOf = null }) {
    const P = [], QRS = [];
    for (let k = 0, t = t0; t < DUR - 150; k++, t += pp) {
        P.push({ t, kind: 'sinus' });
        if (drop(k)) continue;
        const q = t + (prOf ? prOf(k) : pr);
        if (q < DUR - 120) QRS.push({ t: q, morph });
    }
    return { durationMs: DUR, P, QRS, flutter: null, af: false };
}

/** A regular tachycardia with its (retrograde or not) P at QRS + rp; the P that preceded the first QRS included. */
function tachyTrain({ cl, rp, dur, morph = 'normal', t0 = null }) {
    const P = [], QRS = [];
    let t = t0 ?? (cl - rp + 40);                     // first QRS late enough for its P to fit on the strip
    const p0 = t - (cl - rp);
    if (p0 >= 0) P.push({ t: p0, kind: 'retro' });
    for (; t < dur - 60; t += cl) {
        QRS.push({ t, morph });
        if (t + rp < dur - 40) P.push({ t: t + rp, kind: 'retro' });
    }
    return { durationMs: dur, P, QRS, flutter: null, af: false, fastT: true };
}

export const SYNTH_SCENARIOS = [
    { id: 'sinus', label: 'Sinus rhythm, 72 /min', expect: 'avnodal', hint: 'P before every QRS, PR 160 ms.',
      timeline: () => sinusTrain({ pp: 833, pr: 160 }) },
    { id: 'avb1', label: '1st-degree AV block (PR 300)', expect: 'avnodal', hint: 'Long AH absorbs the delay.',
      timeline: () => sinusTrain({ pp: 900, pr: 300 }) },
    { id: 'wenckebach', label: '2nd-degree AV block, Wenckebach 4:3', expect: 'avnodal',
      hint: 'The blocked P waves are not delineated: mark one and use “Repeat every 760 ms”.',
      timeline: () => sinusTrain({ pp: 760, t0: 200, drop: k => k % 4 === 3, prOf: k => [170, 250, 300][k % 4] }) },
    { id: 'mobitz2', label: '2nd-degree AV block, Mobitz II 3:2 with RBBB', expect: 'avnodal',
      hint: 'Constant PR, then a drop — block below the His. Add the bundle-branch tiers and mark RBBB.',
      timeline: () => sinusTrain({ pp: 800, pr: 190, morph: 'rbbb', drop: k => k % 3 === 2 }) },
    { id: 'twoToOne', label: '2:1 AV block', expect: 'avnodal', hint: 'Every other P conducts; mark the blocked ones.',
      timeline: () => sinusTrain({ pp: 640, pr: 200, drop: k => k % 2 === 1 }) },
    { id: 'chb', label: 'Complete AV block, junctional escape', expect: 'avb3', hint: 'Atria 92 /min, ventricles 40 /min (ratio 2.31, not an integer): no relation.',
      timeline: () => {
          const P = [], QRS = [];
          for (let t = 180; t < DUR - 150; t += 650) P.push({ t, kind: 'sinus' });
          for (let t = 640; t < DUR - 150; t += 1500) QRS.push({ t, morph: 'normal' });
          return { durationMs: DUR, P, QRS, flutter: null, af: false };
      } },
    { id: 'chbVent', label: 'Complete AV block, ventricular escape', expect: 'avb3', hint: 'Wide escape 35 /min.',
      timeline: () => {
          const P = [], QRS = [];
          for (let t = 250; t < DUR - 150; t += 760) P.push({ t, kind: 'sinus' });
          for (let t = 900; t < DUR - 200; t += 1700) QRS.push({ t, morph: 'pvc' });
          return { durationMs: DUR, P, QRS, flutter: null, af: false };
      } },
    { id: 'avnrt', label: 'Typical AVNRT, 167 /min', expect: 'avnrt', hint: 'Retrograde P at the end of the QRS (pseudo-r′ in V1): VA ≈ 35 ms.',
      timeline: () => {
          const P = [], QRS = [];
          for (let t = 200; t < DUR - 150; t += 360) { QRS.push({ t, morph: 'normal' }); P.push({ t: t + 35, kind: 'retro' }); }
          return { durationMs: DUR, P, QRS, flutter: null, af: false, fastT: true };
      } },
    { id: 'avrt', label: 'Orthodromic AVRT, 176 /min', expect: 'avrt', hint: 'Retrograde P in the ST segment: VA ≈ 140 ms.',
      timeline: () => {
          const P = [], QRS = [];
          for (let t = 200; t < DUR - 250; t += 340) { QRS.push({ t, morph: 'normal' }); P.push({ t: t + 140, kind: 'retro' }); }
          return { durationMs: DUR, P, QRS, flutter: null, af: false };
      } },
    { id: 'flutter21', label: 'Atrial flutter 2:1', expect: 'flutter', hint: 'F–F 210 ms (typical flutter, ~285 /min). Declare flutter and click two F-wave onsets.',
      timeline: () => {
          const QRS = [];
          for (let k = 1; 100 + k * 210 + 260 < DUR - 150; k += 2) QRS.push({ t: 100 + k * 210 + 260, morph: 'normal' });
          return { durationMs: DUR, P: [], QRS, flutter: { cycleMs: 210, phaseMs: 100 }, af: false };
      } },
    { id: 'flutter41', label: 'Atrial flutter 4:1', expect: 'flutter', hint: 'F–F 220 ms, one QRS every four F waves.',
      timeline: () => {
          const QRS = [];
          for (let k = 2; 150 + k * 220 + 280 < DUR - 150; k += 4) QRS.push({ t: 150 + k * 220 + 280, morph: 'normal' });
          return { durationMs: DUR, P: [], QRS, flutter: { cycleMs: 220, phaseMs: 150 }, af: false };
      } },
    { id: 'af', label: 'Atrial fibrillation', expect: 'afib', hint: 'Irregularly irregular RR, no P — detected automatically.',
      timeline: () => {
          const r = lcg(99), QRS = [];
          for (let t = 300; t < DUR - 200; t += 430 + 650 * r() * r() + 150 * r()) QRS.push({ t, morph: 'normal' });
          return { durationMs: DUR, P: [], QRS, flutter: null, af: true };
      } },
    { id: 'pvcBigeminy', label: 'Sinus with ventricular bigeminy', expect: 'pvc', hint: 'Sinus P inside the PVC is blocked; compensatory pause.',
      timeline: () => {
          const P = [], QRS = [];
          const pp = 860, pr = 160;
          for (let k = 0, t = 250; t < DUR - 150; k++, t += pp) {
              P.push({ t, kind: 'sinus' });
              if (k % 2 === 0) QRS.push({ t: t + pr, morph: 'normal' });
              else QRS.push({ t: t - pp + pr + 480, morph: 'pvc' });   // coupled 480 ms, sinus P falls inside it
          }
          return { durationMs: DUR, P, QRS: QRS.filter(q => q.t < DUR - 200), flutter: null, af: false };
      } },
    { id: 'vtDissociation', label: 'Ventricular tachycardia, AV dissociation and a capture beat', expect: 'vt',
      hint: 'Wide QRS at 150 /min; sinus P waves at 76 /min march through. One P arrives when the node has recovered and captures the ventricles (narrow beat). Mark one P and use “Repeat every 790 ms”.',
      timeline: () => {
          const P = [], QRS = [];
          const vt = 400, pp = 790, pr = 165;
          for (let t = 330; t < DUR - 150; t += pp) P.push({ t, kind: 'sinus' });
          // the capture: the first sinus P (after the 3rd s) whose PR lands 30–70 % through a VT cycle
          let q = 200, captured = false;
          while (q < DUR - 200) {
              const next = q + vt;
              const cap = !captured && q > 3000 && P.find(p => p.t + pr > q + 0.3 * vt && p.t + pr < q + 0.7 * vt);
              if (cap) {
                  QRS.push({ t: q, morph: 'vt' });
                  QRS.push({ t: cap.t + pr, morph: 'normal', capture: true });
                  captured = true;
                  q = cap.t + pr + vt + 20;           // the capture resets the VT circuit
                  continue;
              }
              QRS.push({ t: q, morph: 'vt' });
              q = next;
          }
          return { durationMs: DUR, P, QRS: QRS.filter(x => x.t < DUR - 200), flutter: null, af: false };
      } },
    // ── tracings shared by the manuscript figures (timings: Fable review, Josephson; Issa, Miller & Zipes).
    // Short strips (a figure, not a Holter), a P before the first QRS (the one that conducted it) and QRS
    // complexes to the very end, so no reading has to invent an orphan first beat or a blocked last P.
    { id: 'svtZeroRP', label: 'Narrow-QRS tachycardia, RP ≈ 0 (P hidden in the QRS)', expect: 'avnrt',
      hint: 'CL 360 ms; the retrograde P starts with the QRS and is buried in it — no P is visible. Typical AVNRT or junctional tachycardia: set VA ≈ 0 by hand.',
      timeline: () => tachyTrain({ cl: 360, rp: 0, dur: 4200 }) },
    { id: 'svtShortRP', label: 'Short-RP narrow-QRS tachycardia (RP 80 ms)', expect: 'avnrt',
      hint: 'CL 360 ms, RP 80, PR 280: the retrograde P is the notch just after the QRS (pseudo-S in II, pseudo-r′ in V1). Compatible with AVNRT, orthodromic AVRT, atrial tachycardia with 1st-degree block and junctional tachycardia.',
      timeline: () => ({ ...tachyTrain({ cl: 360, rp: 80, dur: 4200 }), visibleOnset: true }) },
    { id: 'svtLongRP', label: 'Long-RP narrow-QRS tachycardia (RP 270 ms)', expect: 'pjrt',
      hint: 'CL 460 ms (130 /min), RP 270, PR 190: a deep negative P in II/III/aVF in diastole, right after a small T. Compatible with PJRT, fast–slow AVNRT and atrial tachycardia.',
      timeline: () => ({ ...tachyTrain({ cl: 460, rp: 270, dur: 5000 }), visibleOnset: true }) },
    { id: 'wideTachy1to1', label: 'Wide-QRS tachycardia with 1:1 VA (RP 210 ms)', expect: 'vt',
      hint: 'CL 340 ms, QRS ~150 ms with LBBB form, retrograde P 210 ms after QRS onset (P-to-QRS 130 ms) — VT with 1:1 VA, fast–slow AVNRT with LBBB, or antidromic AVRT over a fast pathway.',
      timeline: () => tachyTrain({ cl: 340, rp: 210, dur: 4000, morph: 'lbbb' }) },
    // Capture and fusion are arithmetic, not luck: a sinus P captures only if the node has recovered from the
    // last retrograde penetration (≥ ~250 ms) AND its conducted QRS still beats the next VT beat. With PR 200
    // that needs a VT cycle ≥ 250 + 200 + 120 = 570 ms, which is why captures belong to slower VT. Here:
    // VT 580 ms (103 /min), sinus 720 ms (83 /min); the capture lands 120 ms before the beat that was due
    // (P 1580 + PR 200 = 1780, due 1900; 260 ms of recovery) and resets the focus; the fusion lands 40 ms
    // before it (P 4460 + PR 180 = 4640, focus fires 4680). Every other P is either refractory (120, 80,
    // 220 ms after a ventricular beat) or preempted by the next one; the phase also keeps 3 of the 4 P waves
    // that a reader can see detectable (detect.test.mjs).
    { id: 'vtCaptureFusion', label: 'VT with AV dissociation, a capture and a fusion beat', expect: 'vt',
      hint: 'VT CL 580 ms (103 /min), sinus 83 /min dissociated; a P 260 ms after a VT beat captures (PR 200) 120 ms before the beat that was due and resets the focus; a later one fuses 40 ms before the next (PR 180).',
      timeline: () => {
          const P = [140, 860, 1580, 2300, 3020, 3740, 4460, 5180].map(t => ({ t, kind: 'sinus' }));
          const QRS = [];
          for (const t of [160, 740, 1320]) QRS.push({ t, morph: 'vt' });
          QRS.push({ t: 1780, morph: 'normal', capture: true });                    // P 1580, PR 200; the focus is reset
          for (const t of [2360, 2940, 3520, 4100]) QRS.push({ t, morph: 'vt' });
          QRS.push({ t: 4640, morph: 'fusion', fusion: true, focusAt: 4680 });      // P 4460, PR 180; focus 40 ms later
          for (const t of [5260, 5840]) QRS.push({ t, morph: 'vt' });
          return { durationMs: 6000, P, QRS, flutter: null, af: false, visibleOnset: true };
      } },
    { id: 'twoToOneNarrow', label: '2:1 AV block, narrow QRS (sinus 75 /min, PR 220)', expect: 'avnodal',
      hint: 'Sinus 75 /min; every other P conducts, both with PR 220 and a narrow QRS — 2:1 block in the AV node or below the His, or concealed His extrasystoles (pseudo-block).',
      timeline: () => {
          const P = [], QRS = [];
          for (let t = 300; t < 4000; t += 800) P.push({ t, kind: 'sinus' });
          QRS.push({ t: 1100 + 220, morph: 'normal' }, { t: 2700 + 220, morph: 'normal' });
          return { durationMs: 4200, P, QRS, flutter: null, af: false };
      } },
    // Complete AV block: the atrial and ventricular rates are never in an integer ratio (60/30 reads as 2:1),
    // so the P waves march through the escape rhythm at every PR (PREMISES.md §6). 70/31 = 2.26. (Below
    // ~30 /min the R-peak detector starts taking P waves for beats, so the escape stays at 31.)
    // Figure 6 of the review: the same 2:1 block with a QRS of 110 ms — mildly prolonged, not a bundle branch
    // block — so the nodal and the infranodal readings both stay open.
    { id: 'twoToOneIvcd', label: '2:1 AV block, QRS 110 ms (sinus 75 /min, PR 220)', expect: 'avnodal',
      hint: 'Sinus 75 /min; every other P conducts with PR 220 and a QRS of 110 ms — 2:1 block in the AV node or below the His, or concealed His extrasystoles (pseudo-block).',
      timeline: () => {
          const P = [], QRS = [];
          for (let t = 300; t < 4000; t += 800) P.push({ t, kind: 'sinus' });
          QRS.push({ t: 1100 + 220, morph: 'ivcd' }, { t: 2700 + 220, morph: 'ivcd' });
          return { durationMs: 4200, P, QRS, flutter: null, af: false };
      } },
    { id: 'chbDissociated', label: 'Complete AV block, atria 70 /min, ventricular escape 31 /min', expect: 'avb3',
      hint: 'P every 857 ms, wide escape every 1935 ms (ratio 2.26, not an integer): the P waves fall at every point of the cycle — no P–QRS relation.',
      timeline: () => {
          const P = [], QRS = [];
          for (let t = 250; t < DUR - 150; t += 60000 / 70) P.push({ t: Math.round(t), kind: 'sinus' });
          for (let t = 800; t < DUR - 250; t += 60000 / 31) QRS.push({ t: Math.round(t), morph: 'pvc' });
          return { durationMs: DUR, P, QRS, flutter: null, af: false };
      } },
    { id: 'normalSinus', label: 'Normal sinus rhythm, 75 /min (PR 140)', expect: 'avnodal',
      hint: 'PP 800 ms, PR 140 ms: SP 60, PH 100 (atrium 30 + AV node 70), HV 40 — the reference ladder of the manuscript.',
      timeline: () => {
          const P = [], QRS = [];
          for (let t = 200; t < 2400; t += 800) { P.push({ t, kind: 'sinus' }); QRS.push({ t: t + 140, morph: 'normal' }); }
          return { durationMs: 2400, P, QRS, flutter: null, af: false };
      } },
    { id: 'rbbb', label: 'Sinus rhythm with RBBB', expect: 'avnodal', hint: 'Add the bundle-branch tiers and set every beat to RBBB.',
      timeline: () => sinusTrain({ pp: 850, pr: 170, morph: 'rbbb' }) },
    { id: 'lbbb', label: 'Sinus rhythm with LBBB', expect: 'avnodal', hint: 'Add the bundle-branch tiers and set every beat to LBBB.',
      timeline: () => sinusTrain({ pp: 880, pr: 180, morph: 'lbbb' }) },
    { id: 'pacs', label: 'Blocked PAC and a PAC with aberrancy', expect: 'avnodal',
      hint: 'A premature P in the T wave blocks; a later one conducts with RBBB aberrancy.',
      timeline: () => {
          const P = [], QRS = [];
          const pp = 850, pr = 165;
          let t = 250;
          const push = (tp, kind, morph, prx = pr) => { P.push({ t: tp, kind }); if (morph) QRS.push({ t: tp + prx, morph }); };
          push(t, 'sinus', 'normal'); t += pp;
          push(t, 'sinus', 'normal');
          const pac1 = t + pr + 300; push(pac1, 'pac', null);                // blocked PAC in the T wave
          t = pac1 + 1000;                                                    // sinus reset
          push(t, 'sinus', 'normal'); t += pp;
          push(t, 'sinus', 'normal');
          const pac2 = t + 480; push(pac2, 'pac', 'rbbb', 190);              // conducted with RBBB aberrancy
          t = pac2 + 1000;
          while (t < DUR - 250) { push(t, 'sinus', 'normal'); t += pp; }
          return { durationMs: DUR, P, QRS: QRS.filter(q => q.t < DUR - 200), flutter: null, af: false };
      } },
];

/** A ready-to-load record for one scenario. */
export function makeExample(id, { seed = 7 } = {}) {
    const sc = SYNTH_SCENARIOS.find(s => s.id === id);
    if (!sc) throw new Error(`unknown example ${id}`);
    const rec = synthesizeEcg(sc.timeline(), { seed, name: `synthetic — ${sc.label}` });
    rec.metadata.example = { id: sc.id, label: sc.label, expect: sc.expect, hint: sc.hint };
    return rec;
}
