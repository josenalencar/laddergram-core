# laddergram-core

The pure (no DOM, no dependencies) engine behind two tools:

- the automatic laddergram generator in the ECG viewer (`laddergram.html`), and
- the guided mode of the Lewis Ladder editor, which vendors these files.

**Ground truth in, ladder out.** `buildLadder({ beats, atrial, mechanism, params, tiers })` takes QRS onsets
(tier V) and P onsets (tier A) and recomputes the whole ladder from plausibility arithmetic
(AH = PR − PA − HV, pairing, Wenckebach / Mobitz II / 2:1, dissociation, re-entry, foci). It never edits a
drawing: change a mark or a parameter and the ladder is rebuilt.

| File | What it holds |
|---|---|
| `engine.js` | `buildLadder`, mechanisms, tiers, default intervals with normal ranges and references, `claims` (notes with a level and a code), stable element keys, `ENGINE_VERSION`. Each entry of `PARAM_INFO` says what kind of value it is — `assumed` (an intracardiac time the surface ECG cannot show), `clinical`, `pairing`, `geometry`, `schematic` — and `needsTier` where it only moves a point when that tier is drawn, so a panel can present them honestly. A beat's own `params` (`HV`, `vExit`, `ectopicVA`) win for that beat alone, in its focus as well as its junction |
| `detect.js` | `detectMarks(signal)`: automatic QRS onsets (ectopic = wide *and* differently shaped) and P onsets in three passes — before each QRS, locked after it (retrograde / blocked 2:1 P) and on their own regular grid (dissociated / blocked P); calibration pulse and saturated tail ignored. Every mark is meant to be checked |
| `rhythm.js` | What the marks say before any ladder is drawn: `measureRhythm` (RR, QRS width, A:V relation, RP / PR), `plausibility` (readings the marks rule out or make unlikely, with the reason), `suggestReading` (a first reading that is never ruled out) — all three take the pairing window the ladder is drawn with (`PRmin` / `PRmax`), so a strip read with a widened window is judged with it, `plausibleParams` (per-mechanism timings, measured from the marks or typical), `continueRhythm` (extend 2–3 marked beats and their P waves to both ends of the strip; one P per position learned from the complete cycles) |
| `export.js` | `layoutLadder` (one ladder → editor points/connections), `toLewisLadderDiagram`, `toLineStyle`, the generator's own JSON |
| `synth.js` | synthetic 12-lead ECGs with a known timeline (teaching examples, test fixtures) |
| `figures.js` | the review article's Figures 0–5 as presets |
| `PREMISES.md` | the drawing rules (time, classic tiers, dots on lines, mechanisms) and why each one holds |

Every ladder carries `engine: { name, version }`; bump `ENGINE_VERSION` (and `package.json`) whenever the
drawing of an existing input changes, and refresh the golden figures on purpose:

```
node test/golden.test.mjs            # compare
node test/golden.test.mjs --update   # accept an intended change
```

A ladder is a reading of the marks, not a diagnosis: intermediate points are inferred by plausibility.
