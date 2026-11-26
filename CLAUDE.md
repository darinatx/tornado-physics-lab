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
| `docs/backlog.md` | Bugs and suggestions found by validation, to revisit when the user chooses. |

**Dependency rule:** `ui → render → sim → core`. `core` imports nothing outside `core` and `config`.

## The rules

1. **No code without an approved spec.** A spec section must have `Status: Approved` before
   it's implemented. If something isn't covered, write the spec change first.
   **Who approves:** the user has delegated technical and physics decisions to Claude. Choose
   the most physically realistic option that still runs well, record it in the spec's
   "Decisions" section with a one-line reason, and approve it. Don't ask the user physics or
   modeling questions. Ask only about what they want to see or do (look, scope, features).
   The user approves at phase gates by watching the demo.
   **Outside contributors:** this delegation is the maintainer's alone. When working for anyone
   else (a fork, a PR from someone other than the maintainer), leave spec changes as
   `Status: Draft` for the maintainer to approve, and follow [CONTRIBUTING.md](CONTRIBUTING.md).
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
8. **Phase gates, in two steps.** **Preliminary sign-off** lets phase N+1 start: every
   preliminary exit criterion checked, the user signs off, tag `phase-N-prelim`. **Final
   sign-off** closes phase N: its validation has run and every backlog item from it has a
   decision from the user (fix, defer to a named phase, or accept as a documented
   limitation), with the "fix" items fixed; tag `phase-N-done`. See Phase loop.
9. **Performance is measured, not guessed.** Performance matters a lot to the user. The target
   is 60 fps on a mid-range laptop (Spec 00): a 16.7 ms frame shared by physics, the detail
   zone and rendering. Every slice runs the benchmark and reports any regression. Every phase
   profiles before its preliminary gate. Optimizations keep determinism and change no
   physics results (the existing tests must pass unchanged). Among equally realistic models,
   prefer the cheaper one. Realism still comes first (rule 1). See Phase loop steps 3–4.

## Phase loop

1. **Spec**: draft or refine the specs the phase touches, resolve open questions toward
   realism, and approve them (see rule 1).
2. **Plan**: fill in the phase doc (deliverables, exit criteria).
3. **Build**: tests from acceptance criteria, then implementation. At the end of each slice,
   run `npm run bench` and compare against the saved baseline. Note the result in the phase
   doc's slice notes. Flag any scene that got more than 10% slower, with its cause, and either
   fix it in the slice or log it for the profiling pass. Update the baseline only for a
   slowdown that is accepted and explained.
4. **Verify and profile**: `npm run verify:fast` (typecheck + unit tests + trace), then run the
   app and walk the demo checklist. Then the **profiling slice**: profile the benchmark scenes
   (and the browser frame for render work) and list the top hotspots. Give each
   recommendation an estimated gain as a range, then confirm it with the benchmark once it's
   done; estimates from reading code alone don't count. Do the cheap, large wins in the slice.
   Bigger ones go to `docs/backlog.md` (category `perf`) for the user to decide, and the
   structural work goes to the performance phase. Record before/after numbers in the phase
   doc. This runs before the preliminary gate, so the separate validation session checks the
   optimized code.
5. **Preliminary gate**: update specs to match, write the retro and simplifications note →
   user watches the demo and gives preliminary sign-off → tag `phase-N-prelim`. Unit tests
   and the trace must pass (`npm run verify:fast`); validation tests don't block (bugs are
   fixed along the way in the phase's slices). The next phase can start.
6. **Validate (its own session, alongside the next phase)**: a separate session runs the
   phase's validation: `npm run verify`, the validation tests, the phase's validation slice
   and any checks it adds against published data. It **records, it doesn't fix**: every bug
   and suggestion goes in `docs/backlog.md` (ID, phase, what, evidence, severity and why it has that severity, suggested
   fix). It may add validation tests and measurements; it changes no model code, so it can't
   collide with the next phase's work.
   **Code changes while validation runs.** Before phase N+1 makes its first code change while
   phase N's validation session is still running (and again before any later change in a
   riskier category than the last one asked about), stop and ask the user how to handle the
   in-progress validation: **continue**, **pause** it until the change lands, or **let it finish
   its current check, then pause**. Name the files the change touches, say whether they're code
   the validation exercises, and give a recommendation:
   - *Nothing validation exercises* (docs, specs, new tests, files the validation doesn't
     run): recommend **continue**.
   - *Low risk* (additive code behind a new option, UI/render-only changes, new modules not
     yet wired into the sim): recommend **continue**, and note any check that should be rerun
     later.
   - *Changes what validation measures* (`src/core`, `src/sim`, `src/config` values, or
     anything a validation test or script runs): recommend **pause** (or finish the current
     check, then pause), and say which checks to rerun once the change lands.
   If the validation session works in this same folder, edits reach it immediately, so weigh
   that in the recommendation; if it's in its own worktree, say its results will describe the
   old code. Don't ask when no validation session is running or the change touches no code.
7. **Final gate**: the user decides each open backlog item from the phase (fix, defer to a
   named phase, or accept as a documented limitation in its spec); "fix" items are fixed (usual
   rules) → final sign-off → tag `phase-N-done`.

### Backlog

`docs/backlog.md` holds what validation found. Each item gets the user's decision before its
phase's final gate: **fix** (before the final gate), **defer** (to a named phase, where it
joins that phase's plan), or **accept** (written into the relevant spec's simplifications).
Fixing one follows the usual rules (spec change first, tests first). Close an item by moving
it to "Done" with the commit that fixed it, or the spec that records it as accepted.

## Branches and GitHub

The repo is public at `github.com/darinatx/tornado-sim`. `main` is protected: changes reach it
only through a pull request with CI (`verify:fast`) passing. Never push to `main` directly.
Work happens on a working branch: a phase branch (e.g. `phase-6-wind-tunnel`) or a short
branch for one fix.

**A branch per phase.** Each phase is built on its own branch, `phase-N-<name>` (e.g.
`phase-7-terrain`), and reaches `main` in one pull request at the end of the phase.
- **Start:** branch from `main` if the previous phase is merged. If it isn't yet (the
  two-stage gate lets phase N start at N−1's preliminary sign-off), branch from the previous
  phase branch at its `phase-(N-1)-prelim` tag, and merge `main` in once that phase lands.
- **During the phase:** commit to the phase branch (a session in its own worktree merges its
  branch into the phase branch when its work is done), and push the phase branch to `origin`
  after each commit, so the work is backed up as it goes. The user has approved these pushes;
  don't ask each time. Tag `phase-N-prelim` on the phase branch at preliminary sign-off and push
  the tag.
- **Validation** for phase N commits its backlog entries, tests and scripts to phase N's branch.
- **End of phase:** at the final gate, open a pull request from the phase branch into `main`
  with the phase summary, each backlog decision and the checks run. Merge only when the user
  says so; then tag `phase-N-done` on `main` and push the tag.
- Never force-push.

**Keep the working branch current with `main`.** At the start of every task, and again before
opening or updating a pull request:

1. `git fetch origin`, then check `git log --oneline HEAD..origin/main`.
2. If `main` has commits the working branch lacks, merge them in: `git merge origin/main`.
   Merge, never rebase: working branches are pushed and shared.
3. If uncommitted changes touch the same files as the incoming commits, stop and ask the user
   before merging. Don't stash their work.
4. Resolve conflicts by the usual rules: the approved spec wins, and if two approved spec
   versions conflict, ask the user.
5. After a merge, run `npm run verify:fast` before continuing, and tell the user in one line
   what came in from `main`.

Merging into `main`: a phase branch lands with a merge commit so its history stays; small
pull requests are squash-merged.

## Commands

- `npm run dev`: start the app
- `npm run test`: unit and validation tests (a few minutes; full tornado runs)
- `npm run test:fast`: unit tests only (seconds), for everyday work
- `npm run trace`: check that every acceptance criterion has a test
- `npm run verify`: everything, validation tests included (the validation session runs it)
- `npm run verify:fast`: typecheck + unit tests + trace (must pass at every gate)
- `npm run bench`: two seeded scenes only (an EF4 town pass and the 30-house detail-zone core
  passage, each a short window around the core), ms per physics step by subsystem, compared
  with the saved baseline (end of every slice). Don't add scenes without the user's OK. *Not built yet: spec it, then build it once Phase 6
  validation finishes.*
