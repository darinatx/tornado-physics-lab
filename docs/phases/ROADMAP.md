# Roadmap

Each phase ends at a gate: every exit criterion is checked, `npm run verify` passes, the user
signs off, and the commit is tagged `phase-N-done`. See [CLAUDE.md](../../CLAUDE.md) for the loop.

| Phase | Goal | Specs | Status |
|---|---|---|---|
| 1 | Wind field, EF readout, presets, inspect probe, condensation funnel and dust | 01, 06, 07, 08 | Done |
| 2 | Neighborhood of houses with loads, damage, DOD colors and an inspector | 02, 03, 05 (v0.5), 06, 07, 08 | Done |
| 3 | Flying debris from failed parts: drag, lift, tumbling, landing, snagging, debris field | 01, 03, 04, 06, 07, 08 | Done |
| 4 | Component houses: walls, windows, roof sections and rafters fail one by one and become the debris; shifted, leveled and swept-off-foundation houses are clearly different; DOD judged from what's missing | 03, 04, 06 | Not started |
| 5 | Debris impacts: flying pieces break the specific windows and panels they hit (recalibrate windows) | 03, 04 | Not started |
| 6 | Building types from the EF scale's damage indicators: apartments, mobile homes, schools, strip malls, big-box stores, shopping malls, low/mid/high-rise offices and skyscrapers, hospitals, churches, warehouses, metal buildings; plus trees, power poles and vehicles. Stadiums modeled from the long-span-roof indicators. | 02, 03, 04, new | Not started |
| 7 | Performance: physics in a background worker, level of detail for distant buildings, 60 fps check (deferred from Phase 1) | all | Not started |
| 8 | City generation by settlement type (rural, small town, medium city, large metro, major metro): road networks, zoning, realistic building mix and density, per-zone terrain roughness | 05 | Not started |
| 9 | Visual polish: camera modes (chase, street level), rain and hail, damage-path map, more instruments | 06, 07 | Not started |
| 10 | Saved runs and replay, scenario presets | 07, 08 | Not started |

Status values: Not started → Spec review → Ready to build → In progress → Gate review → Done.

Roadmap revised 2026-11-23 at the user's request: component houses added before impacts;
building types and settlement-type city generation split into their own phases; performance
moved ahead of large cities.
