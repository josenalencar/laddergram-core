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
 *   - P onset: the dominant deflection (either polarity) in the diastolic window before each QRS, clear of
 *     the previous T wave; none when nothing stands out. Retrograde and dissociated P waves are not searched:
 *     mark those by hand.
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
    const thr = 0.25 * pct(e, 0.99);
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
    const i0 = Math.max(0, Math.floor(tMinMs * fs / 1000)), i1 = Math.min(end, Number.isFinite(tMaxMs) ? Math.ceil(tMaxMs * fs / 1000) : end);
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
    const ectopic = span.map(v => v.ms >= 110 && v.ms >= 1.5 * refSpan);
    // QRS onset / offset from the median of the conducted beats, at the same distance from every R
    const { on, off } = qrsBounds(y, d, R.filter((_, k) => !ectopic[k]).length ? R.filter((_, k) => !ectopic[k]) : R, fs);
    const beats = R.map((r, k) => ectopic[k]
        ? { id: `b${k}`, qrsOnMs: ms(span[k].a), qrsOffMs: Math.round((ms(span[k].a) + span[k].ms) * 10) / 10, quality: 'pvc' }
        : { id: `b${k}`, qrsOnMs: ms(Math.max(0, r - on)), qrsOffMs: ms(Math.min(x.length - 1, r + off)), quality: 'normal' });
    // P onsets: dominant deflection in the diastolic window before each QRS
    const atrial = [];
    const qAmp = median(R.map(r => Math.abs(y[r]))) ?? 1;
    R.forEach((r, k) => {
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
        atrial.push({ id: `a${atrial.length}`, tMs: ms(s) });
    });
    if (beats.length < 2) notes.push('Fewer than two QRS complexes found — check the lead and the window.');
    return { lead: name, durationMs: (i1 - i0) * 1000 / fs, beats, atrial, notes };
}
