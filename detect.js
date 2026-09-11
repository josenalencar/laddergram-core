/**
 * P and QRS onsets from an ECG signal — for the Lewis Ladder editor's "Import ECG" and for the planned
 * image digitizer (image → signal JSON → these marks). Pure: no DOM, no dependencies.
 *
 * Deliberately simple and conservative, because every mark it returns is shown as automatic and is meant
 * to be checked and moved by the user:
 *   - QRS: band-limited derivative energy, adaptive threshold, 250 ms refractory; R = largest deflection
 *     from the local baseline near each energy peak.
 *   - QRS onset/offset: slope threshold on the MEDIAN beat, applied at the same distance from every R
 *     (one consistent fiducial instead of per-beat noise).
 *   - P onset, three passes, all on a narrow band (the signal minus its 100 ms moving average, which keeps
 *     P-sized waves and flattens the T):
 *       1. the dominant deflection in the diastolic window before each QRS, clear of the previous T;
 *       2. deflections locked to the QRS at a fixed offset in most cycles that are not the T — a retrograde
 *          P at a fixed VA, or the blocked P of a 2:1 block;
 *       3. deflections on a regular P–P grid of their own — dissociated or blocked P waves (complete block,
 *          VT with AV dissociation, Wenckebach), found wherever they are not hidden in a QRS.
 *     A P hidden inside a QRS is not found (the ladder draws it from the VA).
 */

const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, p) => { if (!a.length) return 0; const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]; };

/** One-pole high-pass then a moving-average low-pass: baseline wander out, mains and noise damped. */
function condition(x, fs) {
    const n = x.length, y = new Float64Array(n);
    const a = Math.exp(-2 * Math.PI * 0.5 / fs);           // 0.5 Hz high-pass
    let prevX = x[0] || 0, prevY = 0;
    for (let i = 0; i < n; i++) { const v = Number.isFinite(x[i]) ? x[i] : prevX; prevY = a * (prevY + v - prevX); prevX = v; y[i] = prevY; }
    // run it backwards too (zero phase)
    const z = new Float64Array(n);
    prevX = y[n - 1]; prevY = 0;
    for (let i = n - 1; i >= 0; i--) { prevY = a * (prevY + y[i] - prevX); prevX = y[i]; z[i] = prevY; }
    const w = Math.max(1, Math.round(fs * 0.012));          // ~12 ms moving average (≈ 40 Hz low-pass)
    const out = new Float64Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) { acc += z[i]; if (i >= w) acc -= z[i - w]; out[i] = acc / Math.min(i + 1, w); }
    const shift = Math.floor(w / 2);                         // re-centre the moving average
    return Float64Array.from({ length: n }, (_, i) => out[Math.min(n - 1, i + shift)]);
}

function detectR(y, fs) {
    const n = y.length, d = new Float64Array(n);
    for (let i = 1; i < n - 1; i++) d[i] = (y[i + 1] - y[i - 1]) * fs / 2;
    const w = Math.round(fs * 0.1), e = new Float64Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) { acc += d[i] * d[i]; if (i >= w) acc -= d[i - w] * d[i - w]; e[i] = acc / w; }
    // threshold from the typical beat, not the single largest event: the median of 2-s maxima
    // (a calibration pulse or an artefact at one end must not raise it above every QRS)
    const win = Math.round(2 * fs), maxima = [];
    for (let a = 0; a < n; a += win) { let m = 0; for (let i = a; i < Math.min(n, a + win); i++) m = Math.max(m, e[i]); maxima.push(m); }
    const thr = 0.25 * Math.min(pct(e, 0.99), median(maxima) ?? pct(e, 0.99));
    const refr = Math.round(fs * 0.25), half = Math.round(fs * 0.06);
    const R = [];
    let i = 0;
    while (i < n) {
        if (e[i] > thr) {
            let j = i, best = i;
            while (j < n && e[j] > thr) { if (e[j] > e[best]) best = j; j++; }
            // energy leads the wave by ~w/2: R = largest deflection from the local baseline near it
            const lo = Math.max(0, best - w), hi = Math.min(n - 1, best + half);
            const base = median(Array.from(y.subarray(Math.max(0, lo - half), lo)));
            let r = lo;
            for (let k = lo; k <= hi; k++) if (Math.abs(y[k] - (base ?? 0)) > Math.abs(y[r] - (base ?? 0))) r = k;
            if (!R.length || r - R[R.length - 1] > refr) R.push(r);
            i = Math.max(j, r + refr);
        } else i++;
    }
    return { R, d };
}

/** Onset / offset of the QRS on the median beat, as distances from R (samples). */
function qrsBounds(y, d, R, fs) {
    const pre = Math.round(fs * 0.16), post = Math.round(fs * 0.2);
    const beats = R.filter(r => r - pre >= 0 && r + post < y.length);
    if (!beats.length) return { on: Math.round(fs * 0.04), off: Math.round(fs * 0.05) };
    const L = pre + post + 1, med = new Float64Array(L), dm = new Float64Array(L);
    for (let k = 0; k < L; k++) {
        med[k] = median(beats.map(r => y[r - pre + k]));
        dm[k] = median(beats.map(r => Math.abs(d[r - pre + k])));
    }
    const peak = Math.max(...dm);
    const thr = 0.06 * peak;
    const quiet = (k, dir) => [0, 1, 2].every(j => (dm[k + dir * j] ?? 0) < thr);   // 3 flat samples in a row
    let on = pre;
    while (on > 3 && !quiet(on, -1)) on--;
    let off = pre;
    while (off < L - 4 && !quiet(off, 1)) off++;
    return { on: pre - on, off: off - pre };
}

/** Centred moving average over w samples. */
function movAvg(x, w) {
    const n = x.length, c = new Float64Array(n + 1), out = new Float64Array(n), h = Math.floor(w / 2);
    for (let i = 0; i < n; i++) c[i + 1] = c[i] + x[i];
    for (let i = 0; i < n; i++) { const a = Math.max(0, i - h), b = Math.min(n, i + h + 1); out[i] = (c[b] - c[a]) / (b - a); }
    return out;
}

/** Local extrema of |yb| (the largest within ±half samples) above thr, outside the masked samples. */
function extrema(yb, half, thr, mask) {
    const out = [];
    for (let i = half; i < yb.length - half; i++) {
        const v = Math.abs(yb[i]);
        if (v < thr || mask[i]) continue;
        let top = true;
        for (let j = i - half; j <= i + half; j++) if (Math.abs(yb[j]) > v) { top = false; break; }
        if (top) out.push({ i, v: yb[i] });
    }
    return out;
}

/** Onset of a P from its peak on the band signal: back to where it falls under 20 % of the peak. */
function onsetFromPeak(yb, i, fs) {
    const amp = Math.abs(yb[i]), sg = Math.sign(yb[i]), lim = Math.max(0, i - Math.round(0.08 * fs));
    let k = i;
    while (k > lim && sg * yb[k] > 0.2 * amp) k--;
    return k;
}

/** Expected T-peak distance from QRS onset (ms) for a cycle length, as on tracings: QT shortens with rate. */
const tExpectedMs = (rr) => (rr < 700 ? 0.36 * rr + 60 : Math.max(300, Math.min(460, 400 * Math.sqrt(rr / 1000))) - 90);

/**
 * Passes 2 and 3 of the P search (see the header). `Q` = [{ on, off, ect }] per beat, in samples.
 * Returns P onsets in samples.
 */
function pAfterAndDissociated(y, fs, Q, known, weak = []) {
    const n = y.length, yb = new Float64Array(n), yw = new Float64Array(n);
    const avg = movAvg(y, Math.round(0.1 * fs)), avgW = movAvg(y, Math.round(0.24 * fs));
    for (let i = 0; i < n; i++) { yb[i] = y[i] - avg[i]; yw[i] = y[i] - avgW[i]; }
    // breadth: a P-sized wave keeps most of its height in the narrow band; a broad T loses it
    const narrowness = (i) => Math.abs(yb[i]) / Math.max(1e-6, Math.abs(yw[i]));
    const mask = new Uint8Array(n);
    for (const q of Q) for (let i = Math.max(0, q.on - Math.round(0.02 * fs)); i <= Math.min(n - 1, q.off + Math.round(0.03 * fs)); i++) mask[i] = 1;
    // candidates, without the small opposite lobes the band-pass leaves either side of every wave
    const raw = extrema(yb, Math.round(0.04 * fs), 0.025, mask);
    const cand = raw.filter(c => !raw.some(o => Math.sign(o.v) !== Math.sign(c.v) && Math.abs(o.i - c.i) < 0.12 * fs && Math.abs(c.v) < 0.55 * Math.abs(o.v)));
    const rrs = Q.slice(1).map((q, k) => q.on - Q[k].on);
    const rrMed = median(rrs) ?? fs;
    const tol = Math.round(0.02 * fs);
    const out = [];

    // pass 2 — components locked to the preceding QRS onset: cluster the offsets (same sign) across cycles
    const cycles = Q.slice(0, -1).map((q, k) => ({ q, next: Q[k + 1], c: cand.filter(c => c.i > q.off && c.i < Q[k + 1].on) })).filter(x => !x.q.ect && !x.next.ect);
    const clusters = [];
    for (const cy of cycles) for (const c of cy.c) {
        const off = c.i - cy.q.on;
        const cl = clusters.find(k => Math.sign(k.v) === Math.sign(c.v) && Math.abs(k.off - off) <= tol);
        if (cl) { cl.members.push({ ...c, cy }); cl.off = median(cl.members.map(m => m.i - m.cy.q.on)); cl.v = median(cl.members.map(m => m.v)); }
        else clusters.push({ off, v: c.v, members: [{ ...c, cy }] });
    }
    const N = cycles.length;
    const steady = clusters.filter(k => new Set(k.members.map(m => m.cy)).size >= Math.max(2, 0.6 * N));
    // the T: the broadest steady wave after the QRS; if none is clearly broad (the narrow T of a fast
    // tachycardia), the one nearest where the T is expected
    const tExp = tExpectedMs(rrMed * 1000 / fs) * fs / 1000;
    const early = steady.filter(k => k.off < 0.65 * rrMed);
    for (const k of early) k.narrow = median(k.members.map(m => narrowness(m.i)));
    const broad = early.filter(k => k.narrow < 0.55).sort((a, b) => Math.abs(b.v) / b.narrow - Math.abs(a.v) / a.narrow);
    let T = broad[0] ?? null;
    if (!T) for (const k of early) if (!T || Math.abs(k.off - tExp) < Math.abs(T.off - tExp)) T = k;
    const isT = (k) => k === T
        // the band-pass leaves small opposite lobes either side of the T: not P
        || (T && Math.sign(k.v) !== Math.sign(T.v) && Math.abs(k.off - T.off) < 0.12 * fs && Math.abs(k.v) < 0.7 * Math.abs(T.v));
    // a P is at least half as tall (in the band) as the P waves found before the QRS; lobes and T shoulders are not
    const pRef = known.length ? median(known.map(i => Math.abs(yb[Math.min(n - 1, i + Math.round(0.035 * fs))]))) : null;
    const minP = Math.max(0.035, pRef ? 0.5 * pRef : 0);
    const lockedP = steady.filter(k => !isT(k) && Math.abs(k.v) >= minP);
    for (const k of lockedP) for (const m of k.members) out.push(onsetFromPeak(yb, m.i, fs));

    // pass 3 — P waves on a regular grid of their own, anywhere outside the QRS and off the T of each beat
    const tZone = (c) => T && Q.some(q => !q.ect && Math.sign(c.v) === Math.sign(T.v) && Math.abs(c.i - (q.on + T.off)) < 0.05 * fs);
    const pool = cand.filter(c => !tZone(c) && narrowness(c.i) >= 0.55 && !(T && Q.some(q => Math.abs(c.i - (q.on + T.off)) < 0.12 * fs && Math.sign(c.v) !== Math.sign(T.v) && Math.abs(c.v) < 0.7 * Math.abs(T.v))));
    let best = null;
    for (const a of pool) {
        for (let pp = Math.round(0.24 * fs); pp <= Math.round(1.6 * fs); pp += 2) {
            let hits = 0, slots = 0;
            const matched = [];
            for (let g = a.i - Math.floor(a.i / pp) * pp; g < n; g += pp) {
                if (mask[Math.min(n - 1, Math.max(0, g))]) continue;
                slots++;
                const m = pool.find(c => Math.abs(c.i - g) <= tol && Math.sign(c.v) === Math.sign(a.v) && Math.abs(c.v) >= 0.5 * Math.abs(a.v));
                if (m) { hits++; matched.push(m); }
            }
            if (hits < 4 || hits < 0.5 * slots) continue;
            // one kind of wave: similar heights (f waves of fibrillation are not)
            const amps = matched.map(m => Math.abs(m.v)), mean = amps.reduce((x, y) => x + y, 0) / amps.length;
            const cvA = Math.sqrt(amps.reduce((x, y) => x + (y - mean) ** 2, 0) / amps.length) / mean;
            if (cvA > 0.3) continue;
            if (!best || hits > best.hits || (hits === best.hits && pp > best.pp)) best = { hits, slots, pp, matched };
        }
    }
    if (best) {
        for (const m of best.matched) out.push(onsetFromPeak(yb, m.i, fs));
        // the grid is known: a slot riding on a T still shows as a same-sign wave, if smaller
        const ref = median(best.matched.map(m => Math.abs(m.v))), sg = Math.sign(best.matched[0].v);
        const g0 = best.matched[0].i - Math.floor(best.matched[0].i / best.pp) * best.pp;
        for (let g = g0; g < n; g += best.pp) {
            if (mask[Math.min(n - 1, Math.max(0, g))] || best.matched.some(m => Math.abs(m.i - g) <= tol)) continue;
            const m = raw.find(c => Math.abs(c.i - g) <= tol && Math.sign(c.v) === sg && Math.abs(c.v) >= 0.5 * ref);
            if (m) out.push(onsetFromPeak(yb, m.i, fs));
        }
    }
    // merge with pass 1: keep one P per 60 ms, pass 1 first
    const merged = known.slice();
    for (const i of [...out.sort((a, b) => a - b), ...weak]) if (!merged.some(j => Math.abs(j - i) < 0.06 * fs)) merged.push(i);
    return { onsets: merged.sort((a, b) => a - b), locked: lockedP.length, grid: best ? Math.round(best.pp * 1000 / fs) : null };
}

/**
 * @param rec  { leads: { [name]: number[] | Float32Array }, sampleRate } (or { signal, fs })
 * @param o.lead          lead to read (default II, else the first lead)
 * @param o.tMinMs/tMaxMs window to search (default: the whole record)
 * @returns { lead, durationMs, beats: [{ id, qrsOnMs, qrsOffMs, quality }], atrial: [{ id, tMs }], notes }
 */
export function detectMarks(rec, { lead = 'II', tMinMs = 0, tMaxMs = Infinity } = {}) {
    const fs = rec.sampleRate ?? rec.fs;
    const leads = rec.leads ?? (rec.signal ? { [lead]: rec.signal } : {});
    const name = leads[lead] ? lead : Object.keys(leads)[0];
    const raw = leads[name];
    if (!raw || !(fs > 0)) throw new Error('No signal: expected { leads: { II: [...] }, sampleRate }.');
    // drop a saturated tail (capture artefact: the last samples pinned at the rail)
    let end = raw.length;
    while (end > 0 && Math.abs(raw[end - 1]) >= 3.3) end--;
    if (end < raw.length) end = Math.max(0, end - Math.round(0.06 * fs));   // and the edge that led to it
    // a calibration pulse at the start (a 1 mV square: a step that stays flat for ≥ 40 ms) is not a beat
    let start = 0;
    for (let i = 1; i < Math.min(raw.length, Math.round(0.6 * fs)); i++) {
        const v = raw[i], flat = Math.round(0.04 * fs);
        if (Math.abs(v - raw[0]) >= 0.5 && i + flat < raw.length) {
            let ok = true;
            for (let k = i; k < i + flat; k++) if (Math.abs(raw[k] - v) > 0.05) { ok = false; break; }
            if (ok) { let k = i + flat; while (k < raw.length && Math.abs(raw[k] - v) <= 0.05) k++; start = k + Math.round(0.04 * fs); }
            break;
        }
    }
    const i0 = Math.max(start, Math.floor(tMinMs * fs / 1000)), i1 = Math.min(end, Number.isFinite(tMaxMs) ? Math.ceil(tMaxMs * fs / 1000) : end);
    const x = Float64Array.from(raw.slice(i0, i1));
    const ms = (i) => Math.round(((i + i0) * 1000 / fs) * 10) / 10;
    const notes = [];
    if (x.length < fs) return { lead: name, durationMs: (i1 - i0) * 1000 / fs, beats: [], atrial: [], notes: ['Less than one second of signal.'] };
    const y = condition(x, fs);
    const { R, d } = detectR(y, fs);
    // Ectopy first: the span over which a beat's own slope stays above 15 % of its peak slope. Wide, slow
    // ventricular complexes span about twice what a conducted beat does. Reference = the conducted beats,
    // the lower quartile (in bigeminy half the beats are ectopic).
    const span = R.map(r => {
        const lo = Math.max(1, r - Math.round(fs * 0.1)), hi = Math.min(d.length - 1, r + Math.round(fs * 0.16));
        let mx = 0;
        for (let i = lo; i < hi; i++) mx = Math.max(mx, Math.abs(d[i]));
        let a = -1, b = -1;
        for (let i = lo; i < hi; i++) if (Math.abs(d[i]) > 0.15 * mx) { if (a < 0) a = i; b = i; }
        return { ms: a < 0 ? 0 : (b - a) * 1000 / fs, a };
    });
    const refSpan = pct(span.map(v => v.ms), 0.25);
    // a beat cut by either end of the record cannot be judged wide
    const cut = (r) => r < Math.round(0.1 * fs) || r > y.length - 1 - Math.round(0.16 * fs);
    // …and a PVC looks different from the conducted beats: correlation with the median of the narrow beats
    const pre = Math.round(0.1 * fs), post = Math.round(0.2 * fs);
    const seg = (r) => Array.from(y.subarray(Math.max(0, r - pre), Math.min(y.length, r + post)));
    const narrowR = R.filter((r, k) => !cut(r) && span[k].ms <= refSpan * 1.2);
    const tpl = narrowR.length >= 3 ? Array.from({ length: pre + post }, (_, i) => median(narrowR.map(r => y[r - pre + i] ?? 0))) : null;
    const corr = (a, b) => {
        const m = Math.min(a.length, b.length); if (m < 10) return 1;
        let sa = 0, sb = 0; for (let i = 0; i < m; i++) { sa += a[i]; sb += b[i]; }
        const ma = sa / m, mb = sb / m; let num = 0, da = 0, db = 0;
        for (let i = 0; i < m; i++) { const x1 = a[i] - ma, x2 = b[i] - mb; num += x1 * x2; da += x1 * x1; db += x2 * x2; }
        return num / Math.sqrt(da * db || 1);
    };
    const ectopic = span.map((v, k) => !cut(R[k]) && v.ms >= 110 && v.ms >= 1.5 * refSpan && (!tpl || corr(seg(R[k]), tpl) < 0.85));
    // QRS onset / offset from the median of the conducted beats, at the same distance from every R
    const { on, off } = qrsBounds(y, d, R.filter((_, k) => !ectopic[k]).length ? R.filter((_, k) => !ectopic[k]) : R, fs);
    const beats = R.map((r, k) => ectopic[k]
        ? { id: `b${k}`, qrsOnMs: ms(span[k].a), qrsOffMs: Math.round((ms(span[k].a) + span[k].ms) * 10) / 10, quality: 'pvc' }
        : { id: `b${k}`, qrsOnMs: ms(Math.max(0, r - on)), qrsOffMs: ms(Math.min(x.length - 1, r + off)), quality: 'normal' });
    // P onsets, pass 1: dominant deflection in the diastolic window before each QRS
    const pass1 = [];
    const qAmp = median(R.map(r => Math.abs(y[r]))) ?? 1;
    R.forEach((r, k) => {
        if (ectopic[k]) return;                                   // an ectopic beat has no P of its own before it
        const qOn = r - on;
        const prevR = k > 0 ? R[k - 1] : null;
        const rr = prevR != null ? r - prevR : Math.round(fs * 0.8);
        const tEnd = prevR != null ? prevR + Math.round(Math.max(0.28 * fs, 0.55 * rr)) : 0;   // clear of the previous T
        const lo = Math.max(tEnd, qOn - Math.round(fs * 0.3)), hi = qOn - Math.round(fs * 0.04);
        if (hi - lo < fs * 0.06) return;
        // reference level: the median of the window (the P occupies a minority of it)
        const base = median(Array.from(y.subarray(lo, hi + 1))) ?? 0;
        let e = lo;
        for (let i = lo; i <= hi; i++) if (Math.abs(y[i] - base) > Math.abs(y[e] - base)) e = i;
        const amp = Math.abs(y[e] - base);
        if (amp < 0.04 || amp < 0.05 * qAmp) return;
        // walk back to where the deflection starts; it may begin a little before the window
        const floor = Math.max(tEnd, lo - Math.round(fs * 0.06));
        let s = e;
        while (s > floor && Math.abs(y[s] - base) > 0.2 * amp) s--;
        // an onset stopped by the edge of the window is a wave that began earlier (a retrograde P): let pass 2 place it
        pass1.push({ i: s, clamped: s <= floor });
    });
    // passes 2 and 3: P waves locked after the QRS (retrograde, blocked 2:1) and P waves on their own grid
    const Q = R.map((r, k) => ectopic[k]
        ? { on: span[k].a, off: span[k].a + Math.round(span[k].ms * fs / 1000), ect: true }
        : { on: Math.max(0, r - on), off: Math.min(x.length - 1, r + off), ect: false });
    const firm = pass1.filter(p => !p.clamped).map(p => p.i);
    const more = Q.length >= 2 ? pAfterAndDissociated(y, fs, Q, firm, pass1.filter(p => p.clamped).map(p => p.i))
        : { onsets: pass1.map(p => p.i), locked: 0, grid: null };
    if (more.locked) notes.push(`${more.locked} P position(s) locked to the QRS (retrograde or blocked P).`);
    if (more.grid) notes.push(`P waves on their own grid every ${more.grid} ms.`);
    const atrial = more.onsets.map((i, k) => ({ id: `a${k}`, tMs: ms(i) }));
    if (beats.length < 2) notes.push('Fewer than two QRS complexes found — check the lead and the window.');
    return { lead: name, durationMs: (i1 - i0) * 1000 / fs, beats, atrial, notes };
}
