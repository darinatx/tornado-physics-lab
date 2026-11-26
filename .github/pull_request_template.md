## What this changes

<!-- One or two sentences. Link the issue: "Closes #12". -->

## Spec and criteria

<!-- Which spec sections and acceptance criteria does this implement or change?
     e.g. Spec 04 v2.1, DEB-31, DEB-32. Write "none" for docs/tooling-only changes. -->

## Checklist

- [ ] The spec sections this implements are `Status: Approved` (or this PR is a spec change left as `Draft`)
- [ ] Tests were written from the acceptance criteria, and each criterion ID is in a test name
- [ ] `npm run verify:fast` passes
- [ ] `npm run test` passes, if `src/core`, `src/sim` or `src/config` changed
- [ ] New constants have a unit and a source comment; SI units inside the sim
- [ ] Randomness uses the seeded RNG; physics uses the fixed timestep
- [ ] Imports still go `ui → render → sim → core`
- [ ] If the code differs from the spec, the spec is updated, version bumped, changelog noted

## Performance

<!-- If this could affect speed: before/after timings on the same machine, and the scene used.
     Write "no effect expected" otherwise. -->

## Screenshots or video

<!-- For anything visible in the app. -->
