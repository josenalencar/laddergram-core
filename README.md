# laddergram-core

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.22884897.svg)](https://doi.org/10.5281/zenodo.22884897)

The pure (no DOM, no dependencies) engine behind the [Lewis Ladder](https://lewisladder.netlify.app) web
application, which draws Lewis ladder diagrams from P-wave and QRS onsets marked on an electrocardiographic
strip, shows the intracardiac recordings each diagram implies, and runs a network model of conduction that can
be paced. The same engine drives an automatic laddergram reader in the author's own ECG viewer.

**A teaching tool, not a medical device.** A ladder is a reading of the marks, not a diagnosis: the
intermediate points are inferred by interval arithmetic, conduction times the surface ECG does not show take
editable textbook values, and the intracardiac display is schematic and has not been validated against
recorded electrograms.

**Licence.** Source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE.md): free for
teaching, research, and any other noncommercial use by individuals and noncommercial organizations. Commercial
use needs the author's permission — open an issue on this repository to ask. This is not an OSI open-source
licence.

**Citation.** See [`CITATION.cff`](CITATION.cff). Every release is archived on Zenodo: [10.5281/zenodo.22884897](https://doi.org/10.5281/zenodo.22884897) (all versions); version 1.26.0 is [10.5281/zenodo.22884898](https://doi.org/10.5281/zenodo.22884898).

**Tests.** `npm test` runs every suite (Node 20 or later, no dependencies to install).

**Ground truth in, ladder out.** `buildLadder({ beats, atrial, mechanism, params, tiers })` takes QRS onsets
(tier V) and P onsets (tier A) and recomputes the whole ladder from plausibility arithmetic
(AH = PR − PA − HV, pairing, Wenckebach / Mobitz II / 2:1, dissociation, re-entry, foci). It never edits a
drawing: change a mark or a parameter and the ladder is rebuilt.

| File | What it holds |
|---|---|
| `engine.js` | `buildLadder`, the 14 readings (paced rhythm read from the marks flagged `origin: 'paced'`), tiers, default intervals with normal ranges and references, `claims` (notes with a level and a code), stable element keys, `ENGINE_VERSION`. Each entry of `PARAM_INFO` says what kind of value it is — `assumed` (an intracardiac time the surface ECG cannot show), `clinical`, `pairing`, `geometry`, `schematic` — and `needsTier` where it only moves a point when that tier is drawn, so a panel can present them honestly. A beat's own `params` (`HV`, `vExit`, `ectopicVA`) win for that beat alone, in its focus as well as its junction. A path or event whose time is placed by one parameter carries `timeHandle: { at, param, beatId | atrialId }`, so a consumer can offer the dot to be dragged: the value is always **the anchor's time minus the handle's time** |
| `detect.js` | `detectMarks(signal)`: automatic QRS onsets (ectopic = wide *and* differently shaped) and P onsets in three passes — before each QRS, locked after it (retrograde / blocked 2:1 P) and on their own regular grid (dissociated / blocked P); calibration pulse and saturated tail ignored. Every mark is meant to be checked |
| `rhythm.js` | What the marks say before any ladder is drawn: `measureRhythm` (RR, QRS width, A:V relation, RP / PR), `plausibility` (readings the marks rule out or make unlikely, with the reason), `suggestReading` (a first reading that is never ruled out) — all three take the pairing window the ladder is drawn with (`PRmin` / `PRmax`), so a strip read with a widened window is judged with it, `plausibleParams` (per-mechanism timings, measured from the marks or typical), `continueRhythm` (extend 2–3 marked beats and their P waves to both ends of the strip; one P per position learned from the complete cycles) |
| `export.js` | `layoutLadder` (one ladder → editor points/connections, carrying each dot's `timeHandle` where its position IS a parameter), `toLewisLadderDiagram`, `toLineStyle`, the generator's own JSON — which carries the reader's `styleOverrides` and `hiddenKeys` beside the marks, so reopening a file restores the drawing as it was restyled, not only as the engine would build it |
| `render.js` | the canvas renderer both tools draw with, so a figure lands on the same pixels in either: one time→x mapping for the strip and the ladder, `drawFrame`, `makeLayout` (the tracing, the intracardiac channels and the ladder in any order: `blockOrder`, `drawEgmBlock`), `hitTest`, `printDpi`, `STANDARD_SPEEDS` / `STANDARD_GAINS`. `drawFrame` takes either ladders (it resolves them) or `groupsPx` — already-resolved pixels, **the editor's way in**: resolve, restyle or hit-test what you resolved, then draw exactly that |
| `egm.js` | the EP view of a reading: `egmSchedule` turns the ladder's activations into the deflections that catheters at the HRA, the His, the coronary sinus (CS 9-10 … CS 1-2) and the RV apex record — each a ladder event plus a fixed anatomical offset (PREMISES.md §7) — `egmSamples` draws them as signals, `activationDeflections` is the one mapping the live recorder shares, `cleanEp` reads the settings (catheters, His split, coronary sinus proximal- or distal-first, pathway site, atrial focus site, ventricular focus origin, block order, 100/200/300 mm/s) |
| `epsim.js` | the live heart of the EP view: `fromReading` turns a reading into a network of nodes and conduction paths (after Iravanian's network simulator) fitted so its first beats are the static figure; `createSim` runs it — `step(dtMs)`, `pace({ site: HRA | RVa | RVb, s1Ms, n1, s2Ms, s3Ms, s4Ms, sense, continuous, output })`, `cancelPacing`, `adenosine`, `isoproterenol`, `setBundleBlock`, `cardiovert`, `actions` (a replayable log), `schedule(from, to)` (the deflections, through `activationDeflections`). Pure and deterministic; PREMISES.md §7b, and MANEUVERS.md for what every maneuver does to every arrhythmia |
| `eplive.js` | the live recorder: `createSweep` writes the running heart on a black canvas in lab colours at 100/200/300 mm/s (pen sweep, erase band, wrap, time ticks), `createSampler` gives it each pixel column, `surfaceAt` writes surface II and V1 from the activations, `liveChannels` lists the rows. Canvas-only, no DOM, no clock — the page owns the animation frame |
| `epmaneuvers.js` | `interpretLog` (every pacing train, PVC, adenosine, shock, bundle switch read back as the lab's measurements and their conclusion), `scanExtrastimulus` / `scanDrive` (the baseline study in an instant: ERPs, the AH jump, aberrancy, induction, the block cycle lengths), `episodeJson` / `replayEpisode` (an episode saved with its actions and replayed exactly) | Pure; MANEUVERS.md |
| `stack.js` | several ladders under one strip, as both tools compose them: `composeStack` (letters A, B, C…, titles, per-ladder style and brackets), `layoutForStack`, `frameGroups` |
| `periods.js` | `ladderPeriods`: the refractory period that explains each blocked impulse, as a range between the longest recovery after which an impulse was blocked and the shortest after which one conducted; blocks that recovery does not explain get a sentence instead; a paced reading gets the device timing (VRP, PVARP, AV delay). PREMISES.md §8–9 |
| `synth.js` | synthetic 12-lead ECGs with a known timeline (teaching examples, test fixtures), including paced strips |
| `figures.js` | the review article's Figures 0–5 as presets |
| `PREMISES.md` | the drawing rules (time, classic tiers, dots on lines, mechanisms) and why each one holds |

Every ladder carries `engine: { name, version }`; bump `ENGINE_VERSION` (and `package.json`) whenever the
drawing of an existing input changes, and refresh the golden figures on purpose:

```
node test/golden.test.mjs            # compare
node test/golden.test.mjs --update   # accept an intended change
```

A ladder is a reading of the marks, not a diagnosis: intermediate points are inferred by plausibility.
