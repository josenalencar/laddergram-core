# Changelog

## 1.27.1 — 2026-10-04 (plausibility P2.1)

`rankReadings` names a 1st-degree AV block at a measured PR > 200 ms (the definition: PR > 200 ms), with or
without a detector's evidence; P2 required > 210 ms when evidence was passed. The PR must still be measured
(the caller's `evidence.prMs`, else the marks' own), never one the ladder filled in at an averaged PR.

## 1.27.0 — 2026-10-01 (plausibility P2)

The plausibility rules become a versioned component of their own (`PLAUSIBILITY_VERSION`, P1 → P2), stamped
into every ladder (`ladder.engine.plausibility`) and every exported file beside `ENGINE_VERSION`.

**Named readings.** `rhythm.js` `READINGS`: every reading the ladder can be asked to draw, by name. A reading is
a mechanism and, for the subtypes, the parameters and tiers that make the drawing say it:

- AV block: 1st degree, Mobitz I (Wenckebach), Mobitz II (blocked below the His), 2:1, high-grade, complete;
- sinoatrial exit block type I (SA Wenckebach) and type II, drawn on the SN tier;
- atrial flutter with its conduction ratio, ectopic atrial rhythm;
- junctional escape, accelerated idioventricular rhythm, ventricular escape (the junctional and ventricular foci,
  named by their rate), non-sustained VT (a run of ectopic beats among sinus ones);
- AAI, VVI, DDD / VDD pacing, with the new PM tier.

The id of a mechanism's plain reading is the mechanism's own id, so files and menus that only know mechanisms
keep working.

**Ranking.** `rankReadings(beats, atrial, { params, evidence })` ranks every reading: the marks' verdict on its
mechanism first (an excluded mechanism ranks last whatever else is said), P1's suggestion, then what P1 does not
name — `avConduction` (the engine's own Wenckebach / Mobitz II / 2:1 classification, plus runs of blocked P,
dissociation, a long PR; P waves an ectopic beat hides are not AV block), `saConduction` (`sinoatrialPattern`: a
pause of exactly two or three P–P, or one shorter than two P–P after shortening cycles; never on a pause with a
QRS inside it, nor a single pause on a strip with PACs), `flutterConduction` (the F–F fit and the ratio),
`readPacing` (the device's mode, lower rate, AV delay), the rate that names a focus. Optionally a rhythm
detector's `evidence` — the reading it called, alternatives, secondary findings, atrial activity, pacing mode,
segments — adds to the ranking; evidence never excludes, and counts for less on a reading the marks caution
against.

**P1 unchanged without evidence.** `plausibility(beats, atrial, params)` gives exactly the 1.26.1 verdicts
(`test/fixtures/p1-verdicts.json`, every scenario, true and detected marks); with a fourth argument, `evidence`,
it adds the detector's reasons and cautions. `suggestReading` additionally names a slow regular rhythm with no P
marked as a junctional (narrow) or ventricular (wide) focus.

**Engine.**
- `TIER_CATALOG.PM`: the pacemaker's timing row (under V). In the paced reading it draws the device's events
  (AP / AS above, VP / VS below) and the intervals it timed: AV delay, V–A, and in VVI the lower rate interval,
  each labelled once. Other readings leave it empty.
- `readPacing(beats, atrial, params)`: the device read from the marks (the paced reading's own logic, now shared).
- `saBlock` parameter (sinus / AV conduction, needs the SN tier): 1 = SA exit block type I, 2 = type II — the
  sinus node is drawn on its own cycle and the discharge that did not exit stops inside the SN tier.
- `sinoatrialPattern(atrial)`: the SA exit block arithmetic (pauses, basic cycle, sinus discharges).
- Segments: `buildLadder({ …, segments: [{ fromMs, toMs, mechanism, params?, label? }] })` draws a strip read as
  more than one rhythm, each stretch with its own mechanism, a dashed line where it changes; `cleanSegments`.
- `ladder.conduction` exposes the AV conduction pattern the drawing used.
- Flutter fits the F marks a detector placed (`source: 'engine'`) as well as the user's.
- The VT and junctional drawings name themselves by their rate (accelerated idioventricular / ventricular
  escape; accelerated junctional / junctional escape).

**Export.** The generator's JSON keeps a mark's `origin` (paced, capture, fusion — the paced flag was dropped
before), the `segments`, the named `reading`, and the engine stamp.

**Render.** A mark a detector placed (`source: 'engine'`) is drawn with a dashed, half-filled handle.

## 1.26.1 — 2026-09-22

Last release before the changelog; see the Zenodo record for its archive.
