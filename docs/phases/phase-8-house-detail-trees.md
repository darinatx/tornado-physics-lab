# Phase 8 — Richer Houses and Trees

Status: Spec review (drafted 2026-11-25; renumbered from Phase 7 on 2026-11-26)

## Goal

Houses that look and fail like furnished real houses: truss roofs, porches, chimneys, brick
veneer, gutters, fences and condensers, and the contents inside (cabinets, appliances,
furniture, mattresses). Trees on every lot that lose limbs, snap and uproot, fall on houses,
and record the wind in their fall pattern. In the lab at full detail, in the town's detail zone
when the budget allows, and as matching debris in the component model everywhere else.

## Slices

- **A — Components:** Spec 14 structural components (trusses, porch, chimney, brick veneer,
  gutters, condenser, fence) in the detailed model; the matching Spec 03 parts and Spec 04
  debris in the component model. Demo: the lab, EF2–EF3 passes, porch and chimney first.
- **B — Contents:** Spec 14 contents room by room; contents and fines as town debris. Demo:
  the lab with cutaway; furniture sliding and mattresses flying once walls open.
- **C — Trees:** Spec 15 in the town, detail zone and lab. Demo: a town pass with the treefall
  pattern; trees on houses in the lab.
- **D — Validation and cost:** DI 2 at level 2 (HSE-09), DI 27/28 (TREE-04), alignment
  (HSE-10), zero pass-through, cost (HSE-13, TREE-10); decide the town detail zone's level.

## Specs touched

- [14 — House detail level 2](../specs/14-house-detail.md): new (HSE-01 to HSE-13)
- [15 — Trees](../specs/15-trees.md): new (TREE-01 to TREE-10)
- [09 — Structure](../specs/09-structure.md): detail levels, new member kinds
- [03 — Damage](../specs/03-damage.md), [04 — Debris](../specs/04-debris.md): new parts, kinds and fines
- [05 — City](../specs/05-city.md): tree placement
- [06 — Rendering](../specs/06-rendering.md): contents, brick, trees

## Exit criteria (whole phase)

- [ ] Specs 14 and 15 approved (scope agreed by the user; every *to source* value sourced)
- [ ] Slice A: HSE-01 to HSE-05 pass; demo reviewed by the user
- [ ] Slice B: HSE-06 to HSE-08, HSE-11 pass; demo reviewed
- [ ] Slice C: TREE-01 to TREE-10 pass; demo reviewed
- [ ] Slice D: HSE-09, HSE-10, HSE-12, HSE-13 pass; town detail-zone level decided by measurement
- [ ] All tests pass; `npm run verify` passes
- [ ] Specs updated, simplifications note and retro written
- [ ] User sign-off; commit tagged `phase-8-done`
