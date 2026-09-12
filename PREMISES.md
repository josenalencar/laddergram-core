# Drawing premises of the laddergram engine

The rules every ladder follows, in the generator (`laddergram.html`) and in the Lewis Ladder editor, which
vendors this package. A change to any of them changes a published figure: bump `ENGINE_VERSION`, refresh
the golden figures on purpose, and update this file.

Rules marked **2026-09-11** came from a co-author's review of the review article's figures (Heart Rhythm
submission): every one of them was an error the previous rule produced.

## 1. Time

- **A point sits at the time of the event it stands for, and nowhere else.** A = P onset, V = QRS onset,
  His = QRS onset − HV, SN = P onset − SACT. A dot or a line end that falls 30 ms off its mark on the tracing
  is a wrong statement about that event, even if the rest of the drawing is correct.
- Ground truth is the marks: QRS onsets (tier V) and P onsets (tier A). Everything between them is inferred
  by interval arithmetic (AH = PR − PA − HV) and redrawn from the marks on every change; a ladder is never
  edited in place.
- Default intervals, with normal ranges and sources, are in `engine.js` (`DEFAULT_PARAMS`, `PARAM_INFO`):
  SACT 60, PA 35, HV 45 (normal sinus figure: SACT 60, PA 30, HV 40). Every value a figure shows must sit
  inside its normal range unless the panel is about that value being abnormal (SP 40 was below the SACT range
  and was corrected, 2026-09-11).

## 2. Classic tiers (bands)

- **No standard exists** for what the atrial and ventricular tiers represent (the review article says so);
  these rules are ours, stated so that every figure follows the same one.
- A tier is the space between two lines; conduction through it is a segment from its top to its bottom, and
  the horizontal extent of that segment is the conduction time.
- **Both chambers are instantaneous: the atrium is a vertical line at P onset through the A tier, the
  ventricle a vertical line at QRS onset through the V tier, on every beat** — sinus, retrograde, focal,
  flutter or fibrillatory atrial activity; narrow, aberrant, pre-excited, ventricular focus, escape, capture,
  fusion (**2026-09-11**). Why: the marks on the tracing are onsets, and a chamber's whole activation cannot
  be drawn in its tier without breaking the sequence — the AV node and His are activated while the atria
  still depolarize (a P-long atrial band would put node entry after the end of the P, and a PR shorter than
  P duration + AH + HV would be impossible), and the retrograde exit of a ventricular focus leaves while the
  QRS is still being written. Before this, the atrial band was PA (~35 ms, not measurable on the surface
  ECG) and the V band mixed vertical and QRS-long lines; a co-author read the mix as an error.
- **What happens between the chambers carries all the drawn time**, and every drawn interval is one the
  surface ECG supports: SN → A is SP (assumed), the AV band runs from P onset to His activation (**PH**, the
  surface counterpart of AH — it includes the atrial conduction to the node), His → V is HV. PA stays in the
  interval arithmetic (AH = PR − PA − HV, Wenckebach detection) but has no drawn extent.
- A wide QRS is shown by what widens it: the blocked bundle branch (its own tier), the accessory pathway, the
  ventricular focus.
- A ventricular focus is an asterisk at mid-V at QRS onset; its retrograde exit (and an accessory pathway
  entered from the ventricle, `apVdelay` after QRS onset) leaves from there upward.
- A retrograde P is the same vertical line at its onset, drawn upward (arrow) from the bottom of the A tier;
  the sinus-node invasion leaves its top.
- An accessory pathway connects the atrium and the ventricle at their onsets: orthodromic, from the ventricle
  to the bottom of the A tier at the retrograde P onset, where the next anterograde AV limb starts (the atrial
  conduction from the insertion to the node is part of that AV limb, as in a sinus beat); antidromic, from
  the A tier at the P onset that feeds it to the delta wave — its extent is the whole P-to-delta interval
  (atrial conduction to the insertion plus pathway conduction, which the surface ECG cannot separate).

## 3. Dots on lines

- A tier is a line; a dot on it means "this level is activated now"; conduction is the segment between two
  dots. V is the last line (no unnamed line after it).
- **One dot per atrial activation, on the A line at P onset.** A retrograde P is lifted from the bottom of
  the A band onto the A line at the same time. The nodal limb that brought it keeps its dot on the AV line,
  at the same time, joined to the A dot by a vertical line with an arrow (**2026-09-11**; before, the A dot
  fell PA after the P onset and the P onset fell on the AV dot). An anterograde P likewise drops vertically
  from its A dot to the AV dot at the same time: the atrium is instantaneous in both conventions.
- **An accessory pathway connects the atrium and the ventricle, not the node.** Its atrial end is the A dot
  of that activation; it crosses the AV line without a dot. In orthodromic AVRT the A dot then drops
  vertically to a single AV dot, which carries on to V, closing the circuit (**2026-09-11**; before, the
  pathway ended on the AV line and the AV and V lines each had two unconnected dots per beat).
- **One dot per ventricular activation, on the V line at QRS onset.** Every line that leaves the ventricle
  (an accessory pathway, the retrograde limb of a ventricular beat) starts from that dot (**2026-09-11**).
- An atrial focus sits on the A line; a junctional focus sits in the lower third of the nodal space.
- A wave blocked just below the His ends in a bar above the V line: a dot on the V line would say the
  ventricles were activated.
- Blocked and open ends get no dot.

## 4. Mechanisms

- Focus: an asterisk with no line entering it; successive beats are not linked. Reentry: a continuous line
  that returns to its point of departure; an echo is one loop.
- AVNRT: the circuit stays inside the AV tier (never through His or V); the longer limb is the slow pathway
  (wavy), so a long VA becomes atypical by itself. Dual pathways, when drawn, are fast/slow lines between the
  AV and His lines.
- The accessory pathway has no tier of its own: one straight line labelled "AP" (wavy when slow and
  decremental, as in PJRT).
- A long RP rules out orthodromic AVRT and typical AVNRT; PJRT is its own mechanism.
- Mobitz II: block drawn in the His. Wenckebach and 2:1: in the AV node. Wenckebach needs a monotonic AH rise
  of ≥30 ms and a post-block AH ≥20 ms shorter; a premature blocked P is a blocked PAC, checked first.
  Curvature (decrement) only inside a Wenckebach cycle.
- A P near the end of the strip whose QRS would fall after it is "open", not blocked.
- Complete AV block: the escape is drawn on the His below a nodal block (junctional) or in the ventricle
  below an infra-His block (ventricular).
- 2:1 AV block (or any drop that is not Wenckebach) is drawn in the node by default; `blockBelowHis: 1` puts
  it below the His: the non-conducted P crosses the node and the His (H recorded) and dies below it, with
  the AH of the conducted beats. A long HV on the conducted beats goes with it (Figure 6B: HV 70).
- Atrial fibrillation f waves are schematic (fixed seed); flutter is fitted to ≥2 marked F waves.

## 4b. Drawing by hand

- The pieces the mechanism rules are built from are exported as `builders` (engine.js): a consumer that
  authors its own paths — the Lewis Ladder editor's "By hand" mode, where the user draws the conduction
  link by link — assembles them instead of copying the geometry. **A hand-drawn ladder therefore obeys
  every premise above by construction**, and a hand panel and an engine panel of one figure land on the
  same pixels. `test/builders.test.mjs` asserts that a sinus beat assembled from the primitives is the
  ladder `buildLadder` draws for the same marks.
- A consumer may pass any `mechanism` name to `makeBuilder` (the editor passes `'hand'`); it is carried
  through to the ladder and means only "who authored these paths".

## 5. Publication figures

- `figures.js` holds the review article's figures as presets; the publication PNG has no footer, and the
  legends are in the article (panel captions are left empty for the export).
- **Every tracing states its paper speed and gain, and both are true at the submitted size** (**2026-09-11**).
  A figure is exported for one print scale (`PRINT.scale` in `js/laddergramRender.js`: printed mm per canvas
  mm; 0.5 → the 3× PNG is saved at 609.6 dpi). The drawn speed and gain, scaled, must be standard values —
  speed 12.5, 25, 50, 75, 100, 150 or 300 mm/s; gain 5, 10, 15 or 20 mm/mV (½, 1, 1½, 2 × standard) —
  or the export refuses. The grid is then ECG paper at that size: 1-mm boxes, bold every 5 mm, so a box is
  1000 / speed ms by 1 / gain mV.
- The tag under the lead name ("25 mm/s", "5 mm/mV") and the legend say the same thing; a journal that
  prints the figure at another size changes both, which is why the legend names the submitted width.
- **Intracardiac values**: a click on a QRS in the generator shows every interval the reading defines for that
  beat, as brackets — SP, PH, HV and PR for a conducted beat; HV for a beat whose His is activated
  anterogradely; VH when the His is reached retrogradely after the QRS; VA when the beat has a retrograde P
  (`intervalBrackets` in `figures.js`). They are the values of the reading — plausible, not measured.
- **On a figure, brackets go on one beat and only where the interval tells the panels apart** (José,
  2026-09-11): Figure 1 SP/PH/HV/PR (the reference ladder); Figure 2 VA in AVNRT and AVRT; Figure 4 HV 55 in
  aberrancy with LBBB (His before the QRS; upper-normal, as LBBB conducts over the RBB) and VH in antidromic AVRT (His after it); Figure 6 HV in nodal (normal) and
  infra-His (long) 2:1 block. The legend says they are assumed values.
- Figures of the Heart Rhythm submission: Figure 1 (real ECG, 2.4 s) 75 mm/s, 10 mm/mV; Figures 2–6
  (synthetic, 4–6 s) 25 mm/s, 5 mm/mV (10 mm/mV would clip the synthetic QRS in the strip).

## 6. Synthetic ECGs

- Every example knows its true P, F and QRS onsets (the detector and the ladders are tested against them).
- **Complete AV block: the atrial and ventricular rates are never in an integer ratio** — 60/30 reads as 2:1
  block. The ratio stays at least 0.2 from any integer (José's example 65/29 = 2.24; the examples use
  92/40 = 2.31, 79/35 = 2.24 and 70/31 = 2.26), so the P waves fall at every point of the cycle and the PR
  never repeats (`test_laddergram_synth.mjs` checks it). Escape rates stay ≥ 31/min: below ~30/min the
  R-peak detector takes P waves for beats.
- **Capture and fusion are arithmetic.** A sinus P captures only if the node has recovered from the last
  retrograde penetration (≥ ~250 ms) *and* its conducted QRS still beats the next ventricular beat, so a
  capture landing X ms before the beat that was due needs a cycle length of at least 250 + PR + X (with
  PR 200 and X 120: 570 ms). Captures and fusions therefore belong to slower ventricular tachycardia —
  `vtCaptureFusion` runs at 103/min with the sinus at 83/min, capture 120 ms early, fusion 40 ms early, and
  every blocked P justified (refractory, or preempted by the next beat). The phase also keeps most of the
  visible P waves detectable (`detect.test.mjs`).
- **Every interval a figure or its legend quotes is bracketed on one beat**, and nothing else is: PR in
  Figures 2C, 3C, 5 (both conducted beats) and 6C; VA in 2A/2B, 3A/3B and 4A; HV in 4B and 6A/6B; VH in 4C.
- A tracing in which every other P conducts with the same PR is a 2:1 block, never "apparent complete block"
  (`twoToOneNarrow`, narrow QRS; the review's Figure 6 uses `twoToOneIvcd`, QRS 110 ms — mildly prolonged,
  below the 120-ms bundle-branch-block threshold, so the nodal and infranodal readings both stay open).
