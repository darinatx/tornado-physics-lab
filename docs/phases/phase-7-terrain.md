# Phase 7 — Terrain from the Town

Status: Spec review (drafted 2026-11-26). Starts now; Phase 6 has its preliminary sign-off.

## Goal

Ground roughness follows what is actually on the ground. Over open fields the near-ground wind
runs fast; crossing into the neighborhood it slows over a few hundred metres as the houses
take hold; where the tornado flattens the houses, the ground gets smoother and the wind
strengthens again. The ground looks like what it is: fields in open country, mowed lawn in
the neighborhood, concrete in urban areas (once they exist). The main sim has no terrain
setting any more; the structure lab can override it.

## Slices

- **A — Roughness field and the wind:** Spec 17's z₀ grid from cover and buildings (Macdonald),
  β(z₀), the 16-direction upwind fetch, updates as houses fail; `windAt` on a field; debris
  tables by z₀; EF readout at the tornado's centre. Checked by tests and a script that prints
  the field across the town edge for a seed. TERR-01 to TERR-09, TERR-13.
- **B — Ground, panels and lab:** ground cover textures (farmland without section roads, lawn,
  pavement) and the blended town edge; terrain dropdown removed; probe and inspector show
  the local terrain; the lab's Terrain setting and its ground; the Ground roughness layer
  and its legend. Demo below. TERR-10 to TERR-12, TERR-14.
- **C — Validation, in its own session alongside Phase 8** (CLAUDE.md Phase loop step 6):
  `npm run verify`; z₀ against published values for comparable neighborhoods; the
  adjustment length at the town edge against internal-boundary-layer data; damage and EF
  readout for an EF2 and an EF4 preset through town before and after (the town was open
  terrain until now). Findings in `docs/backlog.md`.

## Specs touched

- [17 — Terrain roughness and ground cover](../specs/17-terrain.md): new (TERR-01 to TERR-14)
- [01 — Wind field](../specs/01-wind-field.md): `windAt` on a roughness field (v2.0)
- [04 — Debris](../specs/04-debris.md): per-terrain tables by local z₀
- [05 — City](../specs/05-city.md): ground cover from the layout
- [06 — Rendering](../specs/06-rendering.md): ground by cover, no section roads; roughness layer
- [07 — Instruments](../specs/07-instruments.md): terrain dropdown removed; probe and inspector terrain; Ground roughness checkbox
- [12 — Wind tunnel](../specs/12-wind-tunnel.md): terrain at the target
- [13 — Structure lab](../specs/13-structure-lab.md): Terrain setting; LAB-03 replaced

## Demo checklist

- [ ] Main sim: no terrain control in the panel
- [ ] Ground: fields outside town, mowed lawn across the neighborhood, no roads or section lines,
      no hard seam at the town edge
- [ ] Probe over a field, at the town edge and deep in town: class, z₀ and β change, and β at the
      edge depends on which way the wind blows
- [ ] EF3 preset from the fields into town: the probe's 5 m wind drops as it crosses the edge
      over a few hundred metres, not at once
- [ ] After the core passes, probe the flattened area: z₀ lower, near-ground wind higher than
      in the standing town beside it
- [ ] Lab: Terrain Auto / Open / Suburban / Urban; the ground changes to match (Urban shows
      concrete); the same pass gives less roof wind over Urban than Open; a recorded-wind
      replay locks the setting
- [ ] Ground roughness layer: off to start; turned on, fields read smooth, the town rough, the
      edge a gradient a few hundred metres wide that shifts as the tornado and its wind move
      past; the legend shows the classes
- [ ] With the layer on, the track behind the core fades toward smooth as houses come down
- [ ] In the lab, an override turns the layer uniform; Auto shows the surroundings

## Exit criteria

Preliminary sign-off (lets Phase 8 start; tag `phase-7-prelim`):

- [ ] Spec 17 approved; Specs 01, 04, 05, 06, 07, 12, 13 updated
- [ ] Slice A: TERR-01 to TERR-09, TERR-13 pass
- [ ] Slice B: TERR-10 to TERR-12, TERR-14 pass; demo reviewed by the user
- [ ] `npm run verify:fast` passes
- [ ] Specs updated, simplifications note and retro written
- [ ] User's preliminary sign-off; tag `phase-7-prelim`

Final sign-off (tag `phase-7-done`):

- [ ] Slice C, validation, in its own session; findings in `docs/backlog.md`
- [ ] Every Phase 7 backlog item decided by the user (fix, defer, accept); "fix" items fixed
- [ ] User's final sign-off; tag `phase-7-done`
