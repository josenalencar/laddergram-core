# What every maneuver does to every arrhythmia — the live EP heart's ledger

The live EP view (`epsim.js`) answers the stimulator, adenosine and a shock. This is the ledger of what each
maneuver *should* do to each arrhythmia — the textbook response, with its source — and what the model does,
measured, with the test that holds it (`test/maneuvers.test.mjs`, `test/epsim.test.mjs`). Sources: Kusumoto,
*Understanding Intracardiac EGMs and ECGs* (2010), chapters 3, 5, 9–12, 14; Abedin, *Essential Cardiac
Electrophysiology* (2013), §5.1–5.6; Josephson for the interval ranges. Anything not in this ledger is not
promised.

The maneuvers, as the stimulator offers them (`pace({ site, s1Ms, n1, s2Ms, s3Ms, s4Ms, sense, continuous })`,
`adenosine()`, `cardiovert()`):

| maneuver | how |
|---|---|
| atrial overdrive pacing | HRA, continuous at S1, or S1 × n |
| atrial extrastimulus (S2) | HRA, S1 × 8 drive then S2 (S3, S4) |
| PAC in tachycardia | HRA, S1 × 1 with `sense`: one stimulus S1 after the sensed atrial beat |
| ventricular overdrive / entrainment | RV apex, S1 × n at 20–40 ms under the tachycardia cycle, with `sense` |
| ventricular extrastimulus (S2) | RV apex, S1 × 8 then S2 |
| PVC when the His is refractory | RV apex, S1 × 1 with `sense`: one stimulus coupled so it lands as the His fires |
| adenosine | the AV node (its pathways and the lower common pathway) blocked both ways for 6 s; the sinus node slowed |
| synchronised shock | every node and path depolarised; re-entrant drivers silenced |

Measurements used below (Abedin 5.5, definitions): **TCL** the tachycardia cycle; **PPI** last stimulus → next
activation of the paced chamber; **SA** last stimulus → next atrial activation; **VA** QRS onset → atrial
activation in tachycardia; **ΔHA** = HA during entrainment − HA in tachycardia; **response on cessation** the
order of A and V after the last stimulus (V-A-V: the tachycardia resumes with the next A conducted to a V;
V-A-A-V: two atrial activations before the next V, an atrial tachycardia).

## The ledger

### Sinus rhythm and AV conduction (`avnodal`: 1st degree, Wenckebach, Mobitz II, 2:1)

| maneuver | textbook | model | test |
|---|---|---|---|
| atrial overdrive | 1:1 with AH lengthening, then Wenckebach at the AV block cycle length, normally 350–500 ms (Kusumoto 3.2–3.5, 4) | 1:1 at 400, Wenckebach from 380 (AVBCL 380) | epsim: atrial pacing at 400 / Wenckebach paced faster |
| atrial S2 | AH lengthens as S2 shortens; below the AV nodal ERP an A without an H (Kusumoto 3.7–3.8, ERP ≈ 330 at 600); atrial ERP below that | S2 400 conducts longer than the drive, 320 longer still, 300 blocks in the node | epsim: the AV node under the stimulator |
| ventricular overdrive | 1:1 retrograde, earliest A on the His catheter (concentric), then VA block at the VA block cycle length (Kusumoto 3.16–3.17) | 1:1 to 450, 2:1 from 400 (VABCL 450); every retrograde A over the fast pathway | epsim: ventricular pacing, retrograde over the fast pathway |
| Wenckebach at rest, paced faster | more block | conduction ratio ≤ 0.6 at 500 | epsim |
| Mobitz II / 2:1 below the His | the ratio is the ladder's, not the rate's (Abedin 4.2) | reproduced as a pattern; pacing does not change it | epsim static replay |
| adenosine | transient AV block; the sinus node slows | no V for the 6 s, sinus slower by 15 % | maneuvers |
| shock | nothing to stop | sinus continues | — |

### Complete AV block (`avb3`)

| maneuver | textbook | model | test |
|---|---|---|---|
| atrial overdrive | no effect on the escape (Kusumoto 4.5) | the escape keeps its cycle | epsim: complete block |
| ventricular pacing | no VA conduction in nodal block; retrograde conduction can survive infranodal block (Abedin 4.2 — *not modelled*: both are drawn without VA conduction) | no retrograde A | — |
| adenosine, shock | nothing to stop; the escape is not a re-entrant driver | the escape continues | maneuvers |

### Typical AVNRT (slow–fast)

| maneuver | textbook | model | test |
|---|---|---|---|
| atrial S2 | the AH jumps ≥ 50 ms when S2 reaches the fast pathway's ERP (≈ 340–350 after a 600 drive) and the tachycardia is induced from there (Kusumoto 10.6–10.7; Abedin 5.5) | AH 207 → 276 between S2 350 and 340; induced at 340, 300, 280; not at 350 | epsim: AVNRT |
| atrial overdrive | entrains; on cessation the first VA equals the following ones (Abedin Table 5.2) | entrained at TCL − 30; resumes at its CL; first VA 37 vs 35 | maneuvers |
| PAC in tachycardia | resets when it reaches the circuit | *not modelled at the ostium*: one atrium, so a PAC delivered when the atrium has fired cannot enter the slow pathway alone | — |
| ventricular entrainment | entrains, V-A-V; PPI − TCL > 115; SA − VA > 85; ΔHA > 0 (≈ +31 ± 24); VA(pacing) > VA(SVT) (Abedin 5.5; Michaud 2001; Ho 2008) | V-A-V; PPI − TCL 148; SA − VA 136; ΔHA +51; resumes | maneuvers |
| PVC when the His is refractory | does not reset the atrium (Kusumoto 5.15; Abedin 5.16) | next A on time (Δ 0) at every coupling around the His | maneuvers |
| earlier PVC | resets through the fast pathway; termination without an A is possible but uncommon (Kusumoto 5.19) | resets; never terminated — with VA 35 ms the fast pathway has always recovered by the time the ventricle can be captured again (*not reproduced*) | maneuvers |
| adenosine | terminates | terminates; sinus resumes after the block | maneuvers |
| shock | terminates | sinus at the reading's rate | epsim |
| 2:1 block below the circuit at onset | possible (Kusumoto 10.14; Abedin 5.5) | *not modelled* | — |

### Atypical AVNRT (fast–slow, slow–slow)

| maneuver | textbook | model | test |
|---|---|---|---|
| ventricular entrainment | V-A-V; PPI − TCL > 115 (Abedin Fig. 5.15: 130) | V-A-V; PPI − TCL 153; resumes | maneuvers |
| atrial overdrive | entrains, resumes | resumes at its CL | maneuvers |
| PVC when the His is refractory | no reset | Δ 0 | maneuvers |
| very premature PVC | termination without reset: the A comes on time over the slow pathway, then the node is refractory (Kusumoto 5.17, Fig. 5.19) | terminated without reset at couplings 180–120 ms before the His | maneuvers |
| adenosine, shock | terminate; sinus rhythm does not echo afterwards (every sinus wave enters the slow pathway from above and meets the wave coming back) | terminate; sinus | maneuvers |

### Orthodromic AVRT (`avrt`)

| maneuver | textbook | model | test |
|---|---|---|---|
| atrial S2 | induced when the AH lengthens enough for the pathway to recover (Kusumoto 9.20; Abedin 5.6) | induced at 300, 280, 260, 240; not at ≥ 320 | epsim |
| sinus rhythm | no echo: the concealed pathway is refractory when the ventricle reaches it | no retrograde A after a shock | epsim |
| ventricular entrainment | V-A-V; PPI − TCL < 115 (≈ 0 ± 12 for the apex); ΔHA < 0 (Abedin 5.5) | V-A-V; PPI − TCL 9; resumes | maneuvers |
| atrial overdrive | entrains; first VA equals the following (Abedin Table 5.2) | resumes; first VA 140 | maneuvers |
| PVC when the His is refractory | advances the next A with the same sequence, or terminates without an A — proof of the pathway (Kusumoto 5.16; Abedin 5.6) | A advanced 25–90 ms at couplings from 40 ms before to 20 ms after the His | maneuvers |
| earlier PVC | blocked in the pathway: terminates without an A (Kusumoto 5.18; Abedin 5.6) | terminated without an A at couplings 50–80 ms before the His | maneuvers |
| ventricular pacing, retrograde sequence | eccentric, the same as in tachycardia (Kusumoto 9.16; Abedin 5.22) | left lateral / posteroseptal / right free-wall by the setting | epsim |
| ipsilateral bundle branch block | VA and TCL lengthen ≥ 30 ms — Coumel's sign (Kusumoto 9.21) | *not modelled* (one ventricle) | — |
| adenosine | terminates in the node, ending on an A | terminates; the last activation before the pause is an A | maneuvers |
| shock | terminates | sinus | epsim |

### PJRT (`pjrt`)

| maneuver | textbook | model | test |
|---|---|---|---|
| ventricular entrainment | V-A-V; the decremental pathway lengthens the VA under pacing; PPI − TCL short (Abedin 5.6) | V-A-V; PPI − TCL 51; resumes | maneuvers |
| PVC when the His is refractory | advances the A (or delays it — post-excitation — through the decremental pathway) | advanced 8–66 ms | maneuvers |
| earlier PVC | blocked in the decremental pathway: termination without reset (Kusumoto 5.17) | terminated without reset, couplings 80–140 ms before the His | maneuvers |
| atrial overdrive | resumes; the first VA a little longer over the decremental pathway | resumes; first VA 279 vs 270 | maneuvers |
| adenosine | terminates (the node; the pathway itself is adenosine-sensitive too) | terminates | maneuvers |

### Antidromic AVRT (`avrtAnti`)

| maneuver | textbook | model | test |
|---|---|---|---|
| ventricular entrainment | V-A-V; the ventricle is in the circuit (Abedin 5.6) | V-A-V; PPI − TCL 1; resumes | maneuvers |
| atrial overdrive | entrains through the pathway; the QRS stays pre-excited | resumes | maneuvers |
| adenosine | terminates in the retrograde node; sinus beats then conduct pre-excited over the pathway | terminates; sinus with pre-excited QRS | maneuvers |
| shock | terminates | sinus, pre-excited | epsim |

### Junctional tachycardia, automatic (`jt`)

| maneuver | textbook | model | test |
|---|---|---|---|
| atrial or ventricular pacing | not entrained, not terminated; overdrive suppression only (Abedin 5.4) | resumes after pacing with a longer first cycle; no termination | maneuvers |
| PVC when the His is refractory | no reset | Δ 0 | maneuvers |
| adenosine | VA block, the focus goes on (Abedin 5.4) | V continue, A stop for the 6 s | maneuvers |
| shock | not a re-entrant driver: goes on | continues | epsim |

### Focal atrial tachycardia (`at`)

| maneuver | textbook | model | test |
|---|---|---|---|
| ventricular pacing | if the atrium is captured, V-A-A-V on cessation; AV block does not stop it (Kusumoto 5.19; Abedin 5.2) | while the paced V falls inside the AH the two waves meet in the node and neither gets through; pacing 30 ms faster drifts ahead of the focus, the atrium is captured, and cessation gives V-A-A-V after the pause of the suppressed focus | maneuvers |
| atrial overdrive | an automatic focus is suppressed and resumes after a pause; the first VA after pacing is not the tachycardia's (Abedin Table 5.2; Kusumoto 11) | resumes; first return cycle 370 vs 360 and lengthening with more captures | maneuvers |
| PVC when the His is refractory | cannot reach it | Δ 0 | maneuvers |
| very premature PVC | cannot terminate it without resetting the atrium (Kusumoto 5.17) | continues | maneuvers |
| adenosine | AV block, the tachycardia continues (automatic; a triggered focus would stop — *not modelled*) | A continue, V pause | maneuvers |
| shock | an automatic focus is not stopped | continues | epsim |

### Atrial flutter (`flutter`)

| maneuver | textbook | model | test |
|---|---|---|---|
| atrial overdrive | entrained; rapid pacing at the isthmus can terminate it (Kusumoto 12.7–12.8; Abedin 5.1) | entrained; broken after 8 captures at ≤ 92 % of the flutter cycle | maneuvers |
| ventricular pacing | VA block; the flutter goes on | V-A-A-A; continues | maneuvers |
| adenosine | AV block, flutter waves march on | A continue, V pause | maneuvers |
| shock | terminates | sinus | epsim |
| entrainment mapping (PPI at the isthmus) | *not modelled*: one atrium | — |

### Atrial fibrillation (`afib`)

| maneuver | textbook | model | test |
|---|---|---|---|
| pacing | not pace-terminable | continues | maneuvers |
| adenosine | AV block, fibrillation goes on | f waves continue, V pause | maneuvers |
| shock | terminates | sinus | epsim |

### Ventricular tachycardia (`vt`)

| maneuver | textbook | model | test |
|---|---|---|---|
| ventricular overdrive | entrained at a little under the cycle, resumes; pace-terminated when faster (Kusumoto 14.6); may accelerate (*not modelled*) | resumes at TCL − 30 × 10; broken after 8 captures at ≤ 92 % | maneuvers |
| atrial pacing | AV dissociation; a capture or fusion when the timing allows | dissociated; captures left to the network | epsim |
| adenosine | no effect (except idiopathic outflow VT — *not modelled*) | continues | maneuvers |
| shock | terminates | sinus | epsim |

### Sinus rhythm with PVCs, concealed His extrasystoles

The compensatory pause of a PVC and the P blocked behind an H′ are concealed conduction into the node
(PREMISES §7b); the stimulator does what it does to sinus rhythm. Not separately tested.

## Not modelled — say so, do not fake it

Termination of typical AVNRT by a PVC (see above); parahisian pacing and differential (apex vs base) RV pacing (one ventricle); Coumel's sign (no bundle
branches in the network); a PAC placed at the ostium when the atrium has fired (one atrium); entrainment
mapping of flutter or VT by site; the two-for-one response; retrograde Wenckebach in the node; VT
acceleration or degeneration under pacing; triggered activity (adenosine-sensitive AT); isoproterenol;
retrograde conduction surviving infranodal block; 2:1 block below an AVNRT circuit.
