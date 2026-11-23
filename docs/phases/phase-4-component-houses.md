# Phase 4 — Component Houses

Status: Done (signed off 2026-11-23)

## Goal

Houses built from real components (wall panels, windows, garage door, roof sections with
covering and deck, rafters, partitions, slab) that fail one at a time under their own loads.
Each failed component leaves the house as the debris or rubble you see. Shifted, leveled and
swept-off-foundation houses look clearly different, and the debris field holds most of each
destroyed house's material.

Also in this phase (found during Phase 3 review): turbulent debris dispersion (DEB-13), the
strength cap with a hypothetical range to ~400 mph (WIND-21, INST-11).

## Specs touched

- [02 — Loads](../specs/02-loads.md) v2.0: LOAD-06
- [03 — Damage](../specs/03-damage.md) v2.0: DMG-01 to DMG-13
- [04 — Debris](../specs/04-debris.md) v1.4: DEB-06, DEB-13 to DEB-17
- [06 — Rendering](../specs/06-rendering.md) v1.5: REND-08
- [07 — Instruments](../specs/07-instruments.md) v1.7: INST-08, INST-11
- [01 — Wind](../specs/01-wind-field.md) v1.7: WIND-21

## Exit criteria (all required)

- [x] All tests pass; `npm run verify` passes (91 tests, 90 criteria)
- [x] DI 2 calibration holds with component houses: all ten DODs within ~3% in tornado passes
      (Kaplan–Meier medians), inside the DOD bounds in steady wind (DMG-04, DMG-09)
- [x] Demo: roof covering peels in patches, then deck sections, then bays; windows break
      individually; walls fall in or out with the wind
- [x] Demo: shifted, leveled and swept houses are clearly different (offset house; sill plates
      on a leveled slab; bare slab with anchor bolts when swept)
- [x] Demo: destroyed houses leave rubble; mass ledger balances exactly; a median 35%+ of each
      destroyed house's envelope mass stays within 50 m (DEB-16)
- [x] No roof stands over missing bearing walls (0 in a full EF4 run; DMG-13)
- [x] Real-time cost: ~190 ms per simulated second (~19% of a core at 1×), accepted at sign-off;
      the detail-zone phase moves physics to a worker
- [x] Specs updated (02 v2.0, 03 v2.0, 04 v1.4, 06 v1.5, 07 v1.7, 01 v1.7)
- [x] Simplifications note and retro written
- [x] User sign-off; commit tagged `phase-4-done`

## Simplifications note

- Rule-based structural behavior: components fail by calibrated capacity against code-style
  loads, not by simulated connections and member forces. That's the next phase (detail zone).
- One-story gable houses; about 60 components each (panels ~4 m wide, roof sections ~4 m).
- Falling and toppling are simplified: a failed wall panel either drops flat beside its base
  or flies; there's no hinged toppling or stacking.
- Only the building envelope has mass; floors and contents aren't modeled.
- Garage doors and roof deck use fixed engineering strengths; everything else is calibrated.

## Retro

The user's visual review drove most of this phase, and each report traced to a real physics gap:
- Debris landing in a line → missing turbulence (DEB-13).
- Hardly any debris left → collapsed houses left no rubble (component rubble, DEB-14–16).
- One panel landing as several → a display shortcut (copies) that misrepresented reality; removed.
- Walls not looking stripped → siding was per face, and the damage tint hid it; now per panel.
- Roof parts "just coming off" → no launch from the uplift that broke them (DEB-17).
- Walls looking bigger off the house → the ×3 display enlargement; now never applied to
  components and off by default.
- Pieces clipping into the ground → contact at the center, not the lowest corner.
- Roofs over missing walls → no bearing-wall rule (DMG-13), and the calm-wind shortcut must
  never skip gravity.

Calibration lessons: censored data needs a Kaplan–Meier median; open houses need free-standing
wall loads; corners, top plates and a small interior core room are what make the DOD 7–9
progression come out right; parts reached through another path (garage, deck) must not be
calibrated against that DOD.
