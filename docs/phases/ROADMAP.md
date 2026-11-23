# Roadmap

Each phase ends at a gate: every exit criterion is checked, `npm run verify` passes, the user
signs off, and the commit is tagged `phase-N-done`. See [CLAUDE.md](../../CLAUDE.md) for the loop.

| Phase | Goal | Specs | Status |
|---|---|---|---|
| 1 | Wind field, EF readout, presets, inspect probe, condensation funnel and dust | 01, 06, 07, 08 | Done |
| 2 | Neighborhood of houses with loads, damage, DOD colors and an inspector | 02, 03, 05 (v0.5), 06, 07, 08 | Done |
| 3 | Fragmentation, rigid-body debris, drag and lift | 04 | Not started |
| 4 | Full city generation, trees and cars, debris impacts | 05, 04 (impacts) | Not started |
| 5 | Visual polish (lighting, rain/hail, camera modes), damage-swath map, more instruments | 06, 07 | Not started |
| 6 | Performance pass, presets, seeded replay | all | Not started |

Status values: Not started → Spec review → Ready to build → In progress → Gate review → Done.
