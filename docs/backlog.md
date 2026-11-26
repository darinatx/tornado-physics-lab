# Backlog

Bugs and suggestions found by validation (see CLAUDE.md, Phase loop step 6). Before a phase's
final gate the user decides each of its items: **fix**, **defer** (to a named phase) or **accept**
(as a documented limitation). Fixing one follows the usual rules: spec change first, tests first.

Severity: **high** (wrong physics the user would see, or a broken project rule such as zero
pass-through), **medium** (measurably off a reference, or a failing validation test), **low**
(polish, cost, suggestions).

## Open

| ID | Phase | Severity | What | Evidence | Suggested fix | Decision |
|---|---|---|---|---|---|---|
| BL-001 | 6 | high | Town debris passes through houses in a 20 s town pass: 2 crossings (one "through wall", one "out through roof"). Breaks the zero pass-through rule. | IMP-19 fails, already at `ce377b7` before the Phase 6 lab work; likely since the glass thresholds changed (Spec 10 v0.15). | Trace the two crossings (`tests/harness/runPassthrough.ts`) as the earlier pass-through fixes were. | (open) |
| BL-002 | 6 | medium | Detail-zone cost over budget: the costliest physics group averages ~21 ms per detail step over a 30-house core passage (budget 16 ms); slow motion in town with a detail spot. | STR-30 fails. | Profile the core passage (`scripts/profile-detail.ts`); light pieces near houses swept against fixed shapes were ~17 ms of ~90 ms per step. Phase 10 (performance) may take it. | (open) |
| BL-003 | 6 | low | IMP-13 times out (300 s) in the full `npm run verify` when the lab's long validation tests run alongside it; passes alone in ~190 s. | Verify run 2026-11-26. | Raise its time limit, or run the long validation files one at a time. | (open) |
| BL-005 | 6 | low | Wind tunnel stage 2 not built: tornado replay, ramp-to-failure fragility curves, reference missile tests by launch, timestep convergence, viewer. | Spec 12, "Stage 2 outline (not yet approved)". | Much of it is now possible in the structure lab; trim the outline to what the lab doesn't cover. | (open) |
| BL-006 | 6 | low | Debris impacts on detailed houses: reference missile tests (IMP-12) are checked on the town model only, not by real launches at detailed houses. | IMP-12 covers component houses. | Run the ASTM / ICC 500 shots at detailed walls and panes in the lab and compare with the published outcomes. | (open) |

## Done

| ID | Phase | What | Decision | Closed by |
|---|---|---|---|---|
| BL-004 | 6 | Detailed house stops short of DI 2 with neighbors and the wind square to the ridge | accept (user, 2026-11-26) | Spec 09 v0.19, Simplifications |
