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
- **Nothing a figure writes is written over something else** (**2026-09-14**). A panel's letter and title sit
  in a row of their own, `TITLE_ROW_H` tall, clear of the dots drawn on the first tier line — at 8 px above
  the line their descenders were within 2 px of a dot, so a panel whose first activation is at the very start
  of the strip had its title and its first dot in the same pixels. Two bracket labels that would overlap are
  not centred over each other: the second drops a line. A bracket may carry its own colour and a nudge for its
  label, and a drawn event its own colour, because a reader restyling one element of a figure must not have to
  restyle the rest to keep it legible.

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

## 7. Intracardiac channels (EP view)

- **Every deflection is a ladder event plus a fixed anatomical offset** (`egm.js`). The ladder already says when
  the atrium, the His and the ventricle are activated on every beat and from where; a catheter records that
  activation where it lies, a fixed time later. No other physiology is added, so the EP view can only say what
  the reading says — plausible, not measured, like the intracardiac brackets (§5).
- The His catheter records His activation whether or not the ladder draws a His tier: the schedule is built on
  the reading with the His tier added, and never changes with the tiers drawn.
- Catheters: HRA; His (one bipole, or its proximal and distal pairs — the distal pair 4 ms later, with more His
  and ventricle and less atrium); the coronary sinus decapolar as five bipoles, **CS 9-10 at the ostium to
  CS 1-2 distally**; the RV apex. They are listed in that order, as an EP system lists them.
- Atrial activation, ms after the ladder's atrial line (HisA = the atrial deflection on the His catheter; PA is
  the reading's own). Sources: Kusumoto, *Understanding Intracardiac EGMs and ECGs* (2010) ch. 2, 5, 9–12;
  Abedin, *Essential Cardiac Electrophysiology* (2013) §5.2, 5.5, 5.6; Josephson ch. 2 and 8. Typical values,
  rounded: a teaching model, not a patient.

  | origin | HRA | HisA | CS 9-10 | 7-8 | 5-6 | 3-4 | CS 1-2 |
  |---|---|---|---|---|---|---|---|
  | sinus P, high right atrial (cristal) focus, HRA pacing | −10 | PA | PA+10 | PA+20 | PA+30 | PA+40 | PA+50 |
  | retrograde over the fast pathway (concentric) | 35 | 0 | 10 | 20 | 30 | 40 | 50 |
  | retrograde over the slow pathway; a focus at the ostium | 55 | 30 | 0 | 10 | 20 | 30 | 40 |
  | accessory pathway, left lateral (eccentric); a left atrial focus | 70 | 50 | 40 | 30 | 20 | 10 | 0 |
  | accessory pathway, posteroseptal | 45 | 20 | 0 | 10 | 20 | 30 | 40 |
  | a septal atrial focus | 40 | 0 | 5 | 15 | 25 | 35 | 45 |
  | accessory pathway, right free wall | 0 | 25 | 35 | 45 | 55 | 65 | 75 |
  | typical flutter (counter-clockwise) | 100 | 30 | 0 | 10 | 20 | 30 | 40 |

  The high right atrium fires before the surface P is inscribed (too little tissue yet for the ECG), which is why
  a sinus beat's HRA is at −10. Retrograde over the fast pathway the His atrium leads and the ostium follows
  within 10 ms — which is why the ostium is often the first atrial deflection *seen* in typical AVNRT, the His
  atrium being buried in the ventricular one. Retrograde over the slow pathway (slow–slow and fast–slow AVNRT)
  the ostium leads the His atrium by 30–60 ms. In typical flutter the wave leaves the cavotricuspid isthmus into
  the ostium, climbs the septum to the His region and crosses the left atrium proximal to distal while the
  lateral right atrial wall is the last to be activated, top to bottom.

  Where an atrial focus fires is a setting (high right atrium / crista, the ostium, the left atrium, the septum);
  the P-wave morphology the tracing shows is the reader's clue, the EP view cannot know it.

  A retrograde P goes up the pathway the ladder draws it up: an `ap` line is the pathway (its site is a
  setting — PJRT defaults to posteroseptal, every other reading to left lateral), an `av-retro` line drawn slow
  (wavy, `slow`, or in the AV slow tier) is the slow pathway, any other the fast one.
- Ventricular activation, ms after the QRS onset (HisV = the ventricular deflection on the His catheter; the
  coronary sinus records the left ventricle far-field, small and blunt; the HRA a trace of it at +35):

  | origin | HisV | RVa | CS 9-10 | 7-8 | 5-6 | 3-4 | CS 1-2 |
  |---|---|---|---|---|---|---|---|
  | conducted | 15 | 25 | 45 | 52 | 58 | 64 | 70 |
  | RBBB | 15 | 70 | 45 | 52 | 58 | 64 | 70 |
  | LBBB | 20 | 25 | 85 | 95 | 105 | 115 | 125 |
  | RV focus (PVC, VT, escape) | 40 | 0 | 70 | 80 | 90 | 100 | 110 |
  | LV lateral focus | 50 | 65 | 32 | 24 | 16 | 8 | 0 |
  | pre-excited, left lateral pathway | 45 | 55 | 40 | 30 | 20 | 10 | 0 |
  | pre-excited, posteroseptal pathway | 0 | 20 | 10 | 20 | 30 | 40 | 50 |
  | pre-excited, right free-wall pathway | 30 | 15 | 60 | 70 | 80 | 90 | 100 |

  A fusion beat is drawn conducted; where a ventricular focus arises (RV or LV) is a setting.
- The His deflection is where the ladder's His is: the anterograde His, the retrograde His of a ventricular beat
  or of antidromic AVRT (VH), the His a Mobitz II or infra-His block reaches before it stops, and H′ of a
  concealed His extrasystole. A blocked P writes an A and nothing below it.
- Fibrillation: every catheter catches each schematic f wave at its own moment and size; no activation sequence
  and no A letters, because there is none to read.
- **The static figure is black and white, like the ladder**: one trace per channel in ink, a faint time line
  every 100 ms, the letters A · H · V over the His deflections, and AH and HV as dimension lines on one beat
  under the His channel. The waveforms are drawn, not simulated (a sharp near-field complex, a blunt far-field
  one), seeded so the same reading gives the same figure.
- **The reader orders the blocks** — surface tracing, intracardiac channels, ladder — in any of the six orders,
  so a figure is printed the way it will be read. Marker guides run from the tracing to the ladder only where
  nothing lies between them. The EP sweep speeds are 100, 200 and 300 mm/s (200 is a standard speed for this).
- **Where the accessory pathway is, the reader says.** A left lateral pathway activates the coronary sinus
  distal to proximal (eccentric); a posteroseptal one reaches CS 9-10 and the His first, near-concentric — the
  sequence of the node, which the EP view must not fake; a right free-wall one reaches the HRA before the whole
  coronary sinus. The surface tracing rarely settles it, so whenever the reading has a pathway (orthodromic or
  antidromic AVRT, PJRT) the EP settings ask for its site, PJRT proposing posteroseptal and the others left
  lateral.

### 7b. The live heart (`epsim.js`) and the recorder (`eplive.js`)

- **The live view is a network, not a replay.** After Iravanian's network simulator (svtsim.com; CinC 2021),
  written from its description: nodes (sinus node, atrium, His, ventricle, a focus) activate and stay refractory;
  links conduct with a delay that depends on how long they have recovered **since their last conduction
  ended** — `min + span·e^(−(DI − ERP)/τ)`, blocked under ERP. Decremental conduction, Wenckebach, jumps,
  echoes and re-entry follow from those numbers; none is a rule.
- **It starts as the static figure.** `fromReading` fits every path to the reading — PP, PR, AH, HV, VA, CL, the
  circuit or the focus — and seeds the state one cycle before the first beat, so the first seconds of the live
  heart are the static figure activation for activation (within half a millisecond, tested on sinus, first-degree
  block, Wenckebach — the curve is fitted through its periods — 2:1 in the node and below the His, Mobitz II,
  typical and atypical AVNRT, orthodromic and antidromic AVRT, PJRT, junctional and atrial tachycardia, complete
  block with either escape, flutter 2:1 and 4:1, ventricular bigeminy and concealed His extrasystoles).
- What the network cannot derive it takes from the reading, and says so: a Mobitz II ratio (no recovery time
  explains it) is a repeating conduct/block pattern; the captures of VT with AV dissociation are left to the
  network, not scripted.
- **Concealed conduction is modelled where a reading depends on it**: a PVC or a VT beat that does not reach the
  atrium still leaves the node refractory (the compensatory pause, the blocked P waves); an H′ blocks the next P;
  a concealed accessory pathway is entered by every atrial wave, so sinus rhythm does not echo and an atrial
  extrastimulus that lengthens the AV delay is what induces AVRT.
- **Answers the textbooks give, checked** (`epsim.test.mjs`): AV nodal decrement and ERP; 1:1 then Wenckebach
  under atrial pacing; no conduction in complete block; concentric retrograde conduction under RV pacing; AVNRT —
  an AH jump of ≥ 50 ms, induction by S2 in the slow-pathway window only, a V-A-V response after entrainment,
  termination by a shock; AVRT — induction by an atrial S2, eccentric (or septal, or right-sided) retrograde
  activation under RV pacing. **A shock** stops what is re-entrant in the heart (AVNRT, AVRT, flutter,
  fibrillation, VT — a driver in this model, silenced for good) and not an automatic focus (atrial or junctional
  tachycardia), which fires again after its cycle; the sinus node takes over after its own.
- The stimulator: HRA or RV apex, S1 × n then S2, S3, S4 (each from the stimulus before it), sensing the next beat
  at that site before the first stimulus, or continuous at S1 until stopped. Deterministic: the same reading,
  seed and actions give the same heart (fibrillation draws its cycles from the seed).
- **The maneuvers answer as the textbooks say they should**, and MANEUVERS.md is the ledger — every arrhythmia
  against every maneuver, the expected response with its source, the model's measured response, and the test
  that holds it. The structure that makes the entrainment numbers come out: AVNRT closes in the compact node
  above a lower common pathway (25 ms) to the His, so from the RV apex the circuit is reached through the
  His–Purkinje system and that pathway (PPI − TCL > 115 ms, the His and the atrium activated in series, ΔHA > 0)
  where in AVRT the ventricle is the circuit (PPI − TCL near 0, ΔHA < 0). Two waves entering a pathway from
  opposite ends meet head-on and both die — a paced atrial wave meeting the retrograde limb it overtook, a PVC's
  retrograde penetration meeting the descending wave, a sinus beat's wave down the slow pathway meeting the
  compact node's invasion of it from below (why dual pathways give no double response, and why atypical AVNRT
  does not echo from every sinus beat). The limbs of a circuit are fitted
  gently (a quarter of their delay of decrement, ERP at half their recovery) so pacing 20–40 ms faster than the
  tachycardia entrains it and it resumes; steeper curves made every circuit collapse in three beats. A concealed
  pathway is entered by every atrial wave and left refractory for 80 ms, which is why sinus rhythm does not echo,
  an atrial extrastimulus that lengthens the AH induces AVRT, and a PVC coupled well inside the cycle still
  reaches the atrium through it. Adenosine blocks the node's pathways both ways for six seconds and slows the
  sinus node; an automatic focus is suppressed by every beat that captures it (4 % per beat, up to a third — the
  sinus node's recovery time after pacing, the pause before an atrial or junctional focus resumes) and never
  broken; a re-entrant driver (flutter, VT) is broken by eight captures at a cycle under 92 % of its own. The
  ventricle's refractory period shortens with the rate (65 % of the cycle, 180–250 ms), so a PVC can be coupled
  early enough to be blocked in a pathway or to catch the node refractory — the terminations of Kusumoto 5.17–5.19.
- **The bundle branches are gates** on the way from the His to the ventricle: each has an H–H refractory period
  (400 ms at rest, the right one the longer, always inside the reading's own shortest cycle so the reading is never
  aberrant), a beat that finds one closed is written with that block, and a bundle can be held blocked — which
  lengthens the way round an orthodromic circuit by the septum when the pathway is on that side (Coumel's sign,
  +50 ms). **Paced sites are placed**: from the RV apex the His–Purkinje system is entered in `vExit`, from the base
  25 ms later; a pathway's ventricular end is 25–40 ms from the apex and 0–30 ms from the base by its site — what
  parahisian pacing (high output captures the His itself) and apex-versus-base pacing read. Isoproterenol shortens
  every refractory period and cycle by a fifth for a minute. Every request to the heart is logged with its time, so
  an episode replays exactly.
- **The maneuvers are read back** (epmaneuvers.js) the way the laboratory writes them: each train, PVC, drug and
  shock becomes its measurements (S–A, PPI − TCL, SA − VA, ΔHA, the response on cessation, ΔS–A against ΔS–H) and
  the conclusion the textbooks draw from them, with the known mimics named (a junctional tachycardia answers
  ventricular entrainment like AVNRT). The baseline study runs in an instant on a fresh heart from the same reading.
- A teaching model, not a patient: one atrium, one His, one ventricle; no ablation, no drugs, no atrial or
  ventricular fibrillation induced by pacing.
- **The recorder is in colour on black, as a lab screen**: surface II (white) and V1 (green) written from the
  same activations — P, QRS and T shaped by where each came from (a retrograde P inverted in II, an RV beat wide
  and negative in V1, a pre-excited one slurred) — then the catheters (HRA yellow, His orange, the coronary sinus
  from light to deep blue proximal to distal, RV apex pink) and the stimulus channel. The pen sweeps left to
  right at 100, 200 or 300 mm/s, erasing a narrow band ahead of it and wrapping at the edge, with a tick every
  100 ms and a taller one every second. Every deflection comes from `activationDeflections`, the static figure's
  own mapping.

