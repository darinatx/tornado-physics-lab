# Backlog

Bugs and suggestions found by validation (see CLAUDE.md, Phase loop step 6). Before a phase's
final gate the user decides each of its items: **fix**, **defer** (to a named phase) or **accept**
(as a documented limitation). Fixing one follows the usual rules: spec change first, tests first.

Severity: **high** (wrong physics the user would see, or a broken project rule such as zero
pass-through), **medium** (measurably off a reference, or a failing validation test), **low**
(polish, cost, suggestions).

Every item says **why** it has its severity: name the rubric clause it meets, with the measured
numbers behind it, and, if it sits near a boundary, why it isn't one level higher or lower.

## Open

| ID | Phase | Severity | Why this severity | What | Evidence | Suggested fix | Decision |
|---|---|---|---|---|---|---|---|
| BL-001 | 6 | high | Breaks a project rule: zero pass-through (high by the rubric). It is also visible: debris goes through walls and out of roofs in a normal town pass, and any crossing means the impact physics is skipped for that piece. | Town debris passes through houses in a 20 s town pass: 2 crossings (one "through wall", one "out through roof"). Breaks the zero pass-through rule. | IMP-19 fails, already at `ce377b7` before the Phase 6 lab work; likely since the glass thresholds changed (Spec 10 v0.15). | Trace the two crossings (`tests/harness/runPassthrough.ts`) as the earlier pass-through fixes were. | (open) |
| BL-002 | 6 | medium | Fails a validation test (STR-30): ~21 ms against a 16 ms budget, ~30% over. Medium, not low, because the user sees it as slow motion and performance matters a lot to this project. Not high: the physics results are correct, only slow. | Detail-zone cost over budget: the costliest physics group averages ~21 ms per detail step over a 30-house core passage (budget 16 ms); slow motion in town with a detail spot. | STR-30 fails. | Profile the core passage (`scripts/profile-detail.ts`); light pieces near houses swept against fixed shapes were ~17 ms of ~90 ms per step. Phase 12 (performance) may take it. | (open) |
| BL-003 | 6 | low | Test tooling only: IMP-13 passes alone (~190 s) and fails only on a time limit under parallel load, so no model result is wrong. Low; it does make `npm run verify` unreliable to read until fixed. | IMP-13 times out (300 s) in the full `npm run verify` when the lab's long validation tests run alongside it; passes alone in ~190 s. | Verify run 2026-11-26. | Raise its time limit, or run the long validation files one at a time. | (open) |
| BL-005 | 6 | low | Planned scope not yet built, not a defect: nothing that exists gives a wrong result, and the outline was never approved. Low (suggestion). | Wind tunnel stage 2 not built: tornado replay, ramp-to-failure fragility curves, reference missile tests by launch, timestep convergence, viewer. | Spec 12, "Stage 2 outline (not yet approved)". | Much of it is now possible in the structure lab; trim the outline to what the lab doesn't cover. | (open) |
| BL-006 | 6 | low | Coverage gap, not a measured error: no result is known to be wrong, but detailed-house impact outcomes are unchecked against published tests. Low; would become medium if the lab shots disagree with the references. | Debris impacts on detailed houses: reference missile tests (IMP-12) are checked on the town model only, not by real launches at detailed houses. | IMP-12 covers component houses. | Run the ASTM / ICC 500 shots at detailed walls and panes in the lab and compare with the published outcomes. | (open) |

## Done

| ID | Phase | What | Decision | Closed by |
|---|---|---|---|---|
| BL-004 | 6 | Detailed house stops short of DI 2 with neighbors and the wind square to the ridge | accept (user, 2026-11-26) | Spec 09 v0.19, Simplifications |
