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
| 6 | Debris impacts: momentum/energy-based damage to windows, panels and members (full physics in the detail zone, statistical elsewhere); wind tunnel; structure lab rebuilt on the real sim with the main renderer and a debris launcher | 03, 04, 09, 10, 12, 13 | In progress |
| 7 | **Storm report:** a Stop & Report control that ends the run and produces a damage survey like an NWS one (summary block, narrative, track map with EF contours, survey points rated by the EF method from DI/DOD with the survey's blind spots) plus an engineering assessment (intensity timeline, failure sequences, debris, statistics, methods and reproducibility); a one-page summary; the sim's true peak wind beside each survey rating; print to PDF and JSON/CSV export | 03, 07, 16 | Spec review |
| 8 | **Richer houses and trees:** detail level 2 houses (truss roofs, porches, chimneys, brick veneer, gutters, fences, HVAC condensers) and room-by-room contents (cabinets, appliances, furniture, mattresses), with matching debris and ambient small missiles in the component model; trees on every lot that lose limbs, snap and uproot, fall on houses and record the wind in their fall pattern; validated against DI 2 and DI 27/28 | 03, 04, 05, 06, 09, 14, 15 | Spec review |
| 9 | **Storm structure:** a kinematic model of the parent supercell (tilted rotating updraft and mesocyclone, rear- and forward-flank downdrafts, inflow, precipitation field) that drives the visuals: volumetric wall cloud, tail cloud, inflow bands, updraft tower, anvil and overshooting top, rain and hail curtains, clear slot and rain-wrapping; a radar view (reflectivity with the hook echo, velocity couplet); supercell presets (low-precipitation, classic, high-precipitation); RFD winds near the ground; storm-driven tornado track and lifecycle (formation, mature, rope-out on occlusion); multi-vortex mode (suction vortices orbiting the core at high swirl ratio) | 01, 06, 07, 11 | Not started |
| 10 | Building types from the EF scale's damage indicators: apartments, mobile homes, schools, strip malls, big-box stores, shopping malls, low/mid/high-rise offices and skyscrapers, hospitals, churches, warehouses, metal buildings; plus power poles and vehicles | 02, 03, 04, 09 | Not started |
| 11 | Performance: level of detail for distant buildings, volumetric-cloud cost, profiling, 60 fps check (deferred from Phase 1), detail-zone core passage at real time (deferred from Phase 5) | all | Not started |
| 12 | City generation by settlement type (rural, small town, medium city, large metro, major metro): road networks with seeded town and street names (used by the storm report), zoning, building mix and density, per-zone terrain roughness | 05 | Not started |
| 13 | Visual polish: camera modes (chase, street level), damage-path map, more instruments | 06, 07 | Not started |
| 14 | Saved runs and replay, scenario presets | 07, 08 | Not started |

Status values: Not started → Spec review → Ready to build → In progress → Gate review → Done.

Roadmap revised 2026-11-23 at the user's request (twice): structural-physics detail zone added as
Phase 5 (hybrid: full physics near the camera and path, calibrated component model elsewhere); component houses added before impacts;
building types and settlement-type city generation split into their own phases; performance
moved ahead of large cities.

Roadmap revised 2026-11-24 at the user's request: storm structure (parent supercell, clouds,
hook echo, supercell types) added as Phase 7, after impacts and ahead of performance so the
Phase 9 pass profiles the volumetric clouds. Rain and hail moved there from visual polish,
since precipitation is what separates the supercell types. Later phases renumbered.

Roadmap revised 2026-11-25 at the user's request: multi-vortex mode (suction vortices, planned
in Spec 01 as WIND-2x) added to Phase 7, alongside the tornado lifecycle.

Roadmap revised 2026-11-25 at the user's request: the structure lab rebuilt on the real sim
(Spec 13) added to Phase 6; richer houses (Spec 14) and trees (Spec 15) added as Phase 7, so
the lab can show them at full detail. Trees moved there from building types. Later phases
renumbered (storm structure is now Phase 8).

Roadmap revised 2026-11-26 at the user's request: a storm report (Spec 16) added as Phase 7,
right after impacts, so every later phase writes its results into the report. Later phases
renumbered (richer houses and trees is now Phase 8, storm structure Phase 9).
