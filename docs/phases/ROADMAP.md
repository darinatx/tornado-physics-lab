# Roadmap

Each phase ends at a gate: every exit criterion is checked, `npm run verify` passes, the user
signs off, and the commit is tagged `phase-N-done`. See [CLAUDE.md](../../CLAUDE.md) for the loop.

| Phase | Goal | Specs | Status |
|---|---|---|---|
| 1 | Wind field, EF readout, presets, inspect probe, condensation funnel and dust | 01, 06, 07, 08 | Done |
| 2 | Neighborhood of houses with loads, damage, DOD colors and an inspector | 02, 03, 05 (v0.5), 06, 07, 08 | Done |
| 3 | Flying debris from failed parts: drag, lift, tumbling, landing, snagging, debris field | 01, 03, 04, 06, 07, 08 | Done |
| 4 | Component houses: walls, windows, roof sections and rafters fail one by one and become the debris; bearing walls; rubble and a dense debris field. Also the calibrated far-field model and reference for Phase 5 | 02, 03, 04, 06, 07 | Done |
| 5 | **Structural physics detail zone:** member-level framing (studs, plates, rafters, sheathing, siding, windows) with breakable connections (nails, toe-nails, straps, anchor bolts) in a rigid-body engine (Rapier, in a worker) for the 30 houses around a spot the user picks; real toppling, hinging, stacking and collisions; seamless hand-off with the Phase 4 model elsewhere; validated against the DI 2 table | 09, 03, 04, 06 | Done |
| 6 | Debris impacts: momentum/energy-based damage to windows, panels and members (full physics in the detail zone, statistical elsewhere) | 03, 04, 09 | Not started |
| 7 | Building types from the EF scale's damage indicators: apartments, mobile homes, schools, strip malls, big-box stores, shopping malls, low/mid/high-rise offices and skyscrapers, hospitals, churches, warehouses, metal buildings; plus trees, power poles and vehicles | 02, 03, 04, 09 | Not started |
| 8 | Performance: level of detail for distant buildings, profiling, 60 fps check (deferred from Phase 1), detail-zone core passage at real time (deferred from Phase 5) | all | Not started |
| 9 | City generation by settlement type (rural, small town, medium city, large metro, major metro): road networks, zoning, building mix and density, per-zone terrain roughness | 05 | Not started |
| 10 | Visual polish: camera modes (chase, street level), rain and hail, damage-path map, more instruments | 06, 07 | Not started |
| 11 | Saved runs and replay, scenario presets | 07, 08 | Not started |

Status values: Not started → Spec review → Ready to build → In progress → Gate review → Done.

Roadmap revised 2026-11-23 at the user's request (twice): structural-physics detail zone added as
Phase 5 (hybrid: full physics near the camera and path, calibrated component model elsewhere); component houses added before impacts;
building types and settlement-type city generation split into their own phases; performance
moved ahead of large cities.
