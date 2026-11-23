# Tornado Sim — Working Agreement

A physics-based tornado simulator (Three.js + TypeScript + Vite). A tornado moves through a
procedural city; all damage comes from wind-engineering physics that can be inspected and
traced to a spec.

This project uses **spec-driven, phase-gated development**. Read this file before every task.

## Where things live

| Path | What |
|---|---|
| `docs/specs/` | What each subsystem must do. The source of truth. |
| `docs/phases/` | What gets built when, and the exit criteria for each phase. `ROADMAP.md` is the index. |
| `docs/decisions/` | ADRs: short records of non-obvious choices. |
| `src/core/` | Pure physics. No Three.js, no DOM, no unseeded randomness. |
| `src/sim/` | World state, fixed-timestep loop, entity storage. |
| `src/render/` | Three.js. Reads sim state; never writes it. |
| `src/ui/` | Panels, sliders, graphs. |
| `src/config/` | Every tunable constant, with units and a source comment. |
| `tests/unit/` | One file per spec, named after it (e.g. `wind-field.test.ts`). |
| `tests/validation/` | Checks against published reference values (EF DODs, analytic solutions). |

**Dependency rule:** `ui → render → sim → core`. `core` imports nothing outside `core` and `config`.

## The rules

1. **No code without an approved spec.** A spec section must have `Status: Approved` before
   it's implemented. If something isn't covered, write the spec change first.
   **Who approves:** the user has delegated technical and physics decisions to Claude. Choose
   the most physically realistic option that still runs well, record it in the spec's
   "Decisions" section with a one-line reason, and approve it. Don't ask the user physics or
   modeling questions. Ask only about what they want to see or do (look, scope, features).
   The user approves at phase gates by watching the demo.
2. **Acceptance criteria are the contract.** Every criterion has an ID (`WIND-03`). Every ID
   must appear in at least one test name, e.g. `test("WIND-03: ...")`. `npm run trace` enforces this.
3. **Tests first.** Write tests from the acceptance criteria, then implement.
4. **Specs follow reality.** If the implementation has to differ from the spec, update the
   spec in the same change, bump its version, and note why in its changelog.
5. **Units everywhere.** SI units internally (m, s, kg, Pa, m/s). Convert to mph only at the
   UI/EF-scale boundary. Every constant in `src/config` has a unit and a source.
6. **Determinism.** All randomness goes through a seeded RNG. The same seed and inputs give
   the same run.
7. **Fixed physics timestep.** Rendering interpolates; physics never uses frame delta directly.
8. **Phase gates.** Don't start phase N+1 until every exit criterion in phase N is checked
   and the user has signed off. Tag the commit `phase-N-done`.

## Phase loop

1. **Spec**: draft or refine the specs the phase touches, resolve open questions toward
   realism, and approve them (see rule 1).
2. **Plan**: fill in the phase doc (deliverables, exit criteria).
3. **Build**: tests from acceptance criteria, then implementation.
4. **Verify**: `npm run verify` (typecheck + tests + trace), then run the app and walk the demo checklist.
5. **Gate**: update specs to match, write the retro and simplifications note → user watches
   the demo and signs off → tag.

## Commands

- `npm run dev`: start the app
- `npm run test`: unit and validation tests (a few minutes; full tornado runs)
- `npm run test:fast`: unit tests only (seconds), for everyday work
- `npm run trace`: check that every acceptance criterion has a test
- `npm run verify`: everything required for a phase gate
