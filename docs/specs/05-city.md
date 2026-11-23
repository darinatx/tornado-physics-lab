# Spec 05 — City Generation

Status: Approved (v0.5) — Phase 2 scope: a test neighborhood of houses. The full city arrives in Phase 4.

## Purpose

Place buildings in the world, deterministically from a seed.

## Model

Phase 2 scope:

- **Neighborhood:** a suburban street grid covering a 2.6 km × 2.6 km square centered on the
  origin (where every tornado path is centered). Blocks are 200 m × 110 m including 15 m
  streets. Each block has two rows of lots facing the streets, 23 m wide, 8 lots per row.
  About 10% of lots are empty.
- **Houses:** one-story DI 2 houses. Footprint 11–16 m × 9–13 m, wall height 2.8–3.2 m, gable
  roof rising 1.5–2.5 m. Each house faces its street with ±3° jitter. 60% have an attached
  garage door on the front face.
- **Construction classes** are assigned per Spec 03 shares.
- **Lookup:** a 50 m spatial grid answers "which house is at (x, z)?" for the inspector.

## Interface

```ts
// src/sim/city.ts
function generateNeighborhood(seed: number): Neighborhood;
interface Neighborhood {
  buildings: Building[];
  buildingAt(x: number, z: number): Building | null;
}
```

## Parameters

| Name | Unit | Value |
|---|---|---|
| extent | m | 2600 (square) |
| block | m | 200 × 110, including 15 m streets |
| lot width | m | 23 |
| empty-lot share | – | 0.10 |
| garage share | – | 0.60 |

## Acceptance criteria

- **CITY-01**: The same seed produces an identical neighborhood; a different seed produces a
  different one.
- **CITY-02**: No two house footprints overlap, and no house sits in a street.
- **CITY-03**: Construction-class shares are within ±3% of 25 / 55 / 20%.
- **CITY-04**: `buildingAt` returns the house whose footprint contains the point, and null in
  streets.

## Simplifications / out of scope

- Houses only; no trees, cars, power lines or other building types until Phase 4.
- The whole map uses one terrain roughness (Spec 01). A per-zone roughness arrives with the city.

## Changelog

- v0.5: Phase 2 test neighborhood.
