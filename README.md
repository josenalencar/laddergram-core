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
| `engine.js` | `buildLadder`, mechanisms, tiers, default intervals with normal ranges and references, `claims` (notes with a level and a code), stable element keys, `ENGINE_VERSION` |
| `export.js` | `layoutLadder` (one ladder → editor points/connections), `toLewisLadderDiagram`, `toLineStyle`, the generator's own JSON |
| `synth.js` | synthetic 12-lead ECGs with a known timeline (teaching examples, test fixtures) |
| `figures.js` | the review article's Figures 0–5 as presets |

Every ladder carries `engine: { name, version }`; bump `ENGINE_VERSION` (and `package.json`) whenever the
drawing of an existing input changes, and refresh the golden figures on purpose:

```
node test/golden.test.mjs            # compare
node test/golden.test.mjs --update   # accept an intended change
```

A ladder is a reading of the marks, not a diagnosis: intermediate points are inferred by plausibility.
