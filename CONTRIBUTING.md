# Contributing to Tornado Physics Lab

Thanks for helping. Tornado Physics Lab is a physics-based tornado simulator: every broken
window and flying 2×4 should be traceable to an equation, a spec and a test. That makes
contributing a little more structured than usual. This page says how it works.

The full working agreement is in [CLAUDE.md](CLAUDE.md). It's written for the AI assistant
that does much of the development, but the rules apply to everyone. Where it says "the user",
read "the maintainer".

## Ground rules

1. **Specs come first.** Every behavior is described in a spec in [docs/specs](docs/specs),
   and code may only implement a spec section marked `Status: Approved`. If what you want
   isn't covered, propose a spec change first (see below).
2. **Tests come from acceptance criteria.** Each criterion has an ID such as `WIND-03`, and
   every ID must appear in a test name: `test("WIND-03: core radius matches ...")`.
   `npm run trace` checks this.
3. **Realism first, then speed.** Physics follows published wind-engineering data, with a
   source for every constant. Among equally realistic models, choose the cheaper one. The
   target is 60 fps on a mid-range laptop.
4. **The sim is deterministic.** All randomness goes through the seeded RNG, and physics runs
   on a fixed timestep. The same seed and inputs must give the same run.
5. **Units are SI.** Meters, seconds, kilograms, pascals, m/s inside the sim; mph only at the
   UI. Every constant in `src/config` has a unit and a source comment.
6. **Imports go one way:** `ui → render → sim → core`. `src/core` is pure physics: no
   Three.js, no DOM.
7. **Nothing passes through a house.** Debris crossing a wall, roof or slab is always a bug.

## Getting started

You need Node.js 22 or later.

```bash
git clone https://github.com/<your-username>/tornado-physics-lab.git
cd tornado-physics-lab
npm install
npm run dev           # the app, at http://localhost:5173
npm run verify:fast   # typecheck + unit tests + traceability (seconds)
```

`npm run test` adds the validation tests: full tornado runs checked against published
reference values. They take several minutes; run them when your change touches physics.

## Ways to contribute

| You want to... | Do this |
|---|---|
| Report a bug | Open a **Bug report** issue. Include the seed, settings and what you saw. |
| Fix a bug | Comment on the issue first, then send a PR with a test that fails before your fix. |
| Add a feature or change the physics | Open a **Feature or spec proposal** issue. Once the direction is agreed, send the spec change as its own PR, then the code. |
| Improve docs, specs or references | Send a PR directly. Citing a better published source is always welcome. |
| Ask a question | Open a Discussion (or an issue if Discussions aren't on). |

Not sure where something fits? Open an issue and ask.

## Proposing a spec change

1. Edit the spec in `docs/specs/`. Add or change acceptance criteria with new IDs (never
   reuse an old ID), bump the spec's version, add a changelog line, and record any modeling
   choice in its **Decisions** section with a one-line reason and a source.
2. Leave the status as `Status: Draft`. The maintainer changes it to `Approved` when the PR
   is accepted. Please don't approve your own spec changes, and don't ask an AI assistant to.
3. Big choices that will be hard to undo get a short ADR in [docs/decisions](docs/decisions).

## Making a change

1. Fork the repo and branch from `main`. Name the branch after what it does, for example
   `fix/roof-uplift-units` or `spec/hail-loads`.
2. Write the tests from the acceptance criteria first, then the code.
3. If the code has to differ from the spec, update the spec in the same PR and say why in its
   changelog.
4. Run `npm run verify:fast`. It must pass. If you touched `src/core`, `src/sim` or
   `src/config`, run `npm run test` too.
5. If your change could affect speed, measure before and after on the same machine and put
   the numbers in the PR. A slowdown over 10% needs an explanation.
6. Bring in anything new on `main` first: `git fetch upstream && git merge upstream/main`
   (where `upstream` is this repo), then run `npm run verify:fast` again. Merge, don't
   rebase, once your branch is pushed.
7. Open a PR against `main` and fill in the template.

**Commits:** one logical change per commit, with a short summary line that says what changed
("Debris: lodged lumber keeps its spin"), not how you got there.

## Reviews

- CI runs `npm run verify:fast` on every PR. It must be green before review.
- The maintainer reviews every PR, and PRs are squash-merged.
- Physics changes are reviewed against their sources, so links to papers, standards or
  damage surveys speed things up a lot.

## How the project moves

Work is organized into phases ([docs/phases/ROADMAP.md](docs/phases/ROADMAP.md)). Each phase
ends with a demo and the maintainer's sign-off, tagged `phase-N-prelim` and later
`phase-N-done`. Problems found by validation are logged in [docs/backlog.md](docs/backlog.md),
and each gets a decision there: fix, defer to a later phase, or accept as a documented
limitation. Picking up a backlog item is a great first contribution. Comment on its issue,
or open one, so two people don't take the same item.

## License

Tornado Physics Lab is [MIT licensed](LICENSE). By sending a pull request, you agree that your
contribution is released under the same license.

## Conduct

Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).
