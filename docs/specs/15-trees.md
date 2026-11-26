# Spec 15 — Trees

Status: Draft (v0.1) — scope for user review. Values marked *to source* are technical and are
settled (with a cited source) before approval.

## Purpose

Trees are in nearly every damage survey: limbs, snapped trunks and uprooted trees are the
first damage a tornado does, a large source of small and heavy debris, and they fall on
houses. Their fall directions record the wind (treefall patterns are a standard way to
reconstruct a tornado's flow). This spec adds trees to the town, the detail zone and the lab,
loaded and broken by the same wind as everything else.

## Model

### Placement

- **Town:** seeded per lot: 0–2 front-yard trees and 1–3 backyard trees, plus street trees
  every 15 m on 50% of streets, kept clear of footprints, slabs and streets. Counts *to source*
  from suburban canopy surveys (USDA Forest Service urban tree inventories).
- **Lab:** the same rule on the lab's lots.
- **Types:** hardwood (oak, maple: wide crown) and softwood (pine: narrow, tall), 60/40.
  Height H 8–22 m, trunk diameter at breast height (DBH) 0.2–0.7 m, crown size from H by
  allometry (*to source*: published urban-tree allometry). Green wood density, stem form
  factor, modulus of rupture (MOR) and elasticity by type from the USDA Wood Handbook.

### Wind load

- **Crown drag**, at the crown's center of pressure height z_c:
  F = ½ ρ C_D A_c(U) U(z_c)², with **reconfiguration**: above U_r, the crown streamlines and
  loses leaves and twigs, so C_D·A_c falls as (U / U_r)^(−b) (Vogel exponent, b ≈ 0.5–1.0 by
  type; *to source*: Mayhead 1973; Vollsinger et al. 2005).
- **Stem drag** on the trunk, C_D 1.0 on its projected area, along the Spec 01 profile.
- **Moment at the base:** M = F_crown·z_c + ∫ stem drag·z dz, plus the P-Δ moment of the
  crown and stem weight on the lean the bending gives (quasi-static: δ from F, E and the
  stem's section).
- The wind is the Spec 01 field at the tree (tornado or tunnel flow) for the sim's terrain;
  trees don't change the terrain class (suburban roughness already includes them).

### Failure

Checked every damage step, by whichever comes first:

| Mode | When | Result |
|---|---|---|
| **Small limbs** (DI 27/28 DOD 1) | per-tree fragility on crown wind, *to source* (DI 27/28 expected values) | twigs and small branches as debris; crown area −15% |
| **Large branches** (DOD 2) | branch base moment > its MOR section capacity, 3–5 branches per tree | branches as debris; crown area −30% each lost share |
| **Uprooting** (DOD 3) | M > anchorage C_reg × stem mass (*to source*: Peltola et al. 1999; Nicoll et al. 2006; ~100–200 N·m/kg) | the tree rotates about the root plate's edge and falls along the wind at failure, as a rigid body |
| **Trunk snap** (DOD 4) | max bending stress M·y/I > MOR at the weakest height (a seeded defect factor 0.7–1.0) | the top falls or flies as a rigid body; the stub stays |
| **Debarked, stubs only** (DOD 5) | not simulated (sandblasting by small debris); shown on stubs past the DOD 5 expected wind | view only, recorded as DOD 5 |

- Mode follows from the numbers: a big shallow-rooted tree uproots and a slender one snaps.
  Virot et al. (2016) found trunks break at ~42 m/s nearly regardless of size. TREE-05 checks
  that the model gives that independence.
- **Fall direction** is the wind direction at the tree at the moment it fails, so the pattern
  of fallen trees records the vortex flow (convergence and the swirl's asymmetry).

### Debris

- **Town:** new Spec 04 kinds: twig (small missile), branch (rod, 2–4 m), limb (heavy rod),
  trunk top and uprooted tree (heavy debris, Spec 04 v2 rigid bodies). Twigs and branches are
  much of the ambient small-missile environment in a real storm.
- **Detail zone and lab:** fallen trees and tops are Rapier compound bodies (trunk cylinder
  segments + a crown box at the crown's real, low bulk density), so a tree falling on a house
  loads its roof members through contact. Branches hand off as light pieces (< 40 kg).
- Impacts on houses by Spec 10 (component) and Rapier contact (detailed).

### Rendering

Trunk and crown in low-poly. The crown thins as branches go, broken trunks show stubs, and
uprooted trees show the root plate. Standing trees lean by their computed deflection (the
physics value, no added sway). Damage colors (Spec 06) cover trees by their DOD.

## Parameters

In `src/config/trees.ts`, each with unit and source.

## Acceptance criteria

- **TREE-01**: Placement: trees are seeded, never inside a footprint, slab or street, and lot
  counts match the configured ranges across seeds.
- **TREE-02**: Load: crown drag follows ½ρC_D A U² below U_r and the reconfiguration power
  above it; the base moment equals the sum of crown, stem and P-Δ moments (analytic check).
- **TREE-03**: Each mode fails exactly when its load passes its capacity (uprooting at
  M = C_reg × stem mass, snapping at M·y/I = MOR × defect).
- **TREE-04**: DI 27/28: across seeds, the wind at each DOD's first occurrence matches the EF
  scale's expected values for hardwood and softwood trees within ±15% (*to source*: WSEC 2006
  DI 27/28 table).
- **TREE-05**: Size independence: trunk snap wind varies by less than ±15% across the height
  range, consistent with Virot et al. (2016).
- **TREE-06**: Treefall: a fallen tree's direction equals the wind direction at its failure;
  in a preset pass the pattern converges toward the track and matches the pattern the same
  Spec 01 field gives analytically (treefall method of Holland et al. 2006).
- **TREE-07**: Debris: limbs, tops and uprooted trees enter the debris field with the tree's
  mass (DEB-16 ledger balances); a tree falling onto a detailed house loads its roof members
  by contact.
- **TREE-08**: Zero pass-through for trees and tree debris against houses and slabs.
- **TREE-09**: Determinism: same seed and inputs → same trees, failures and falls.
- **TREE-10**: Cost: town tree checks fit the damage step budget (measured; town at the same
  speed within 10%).

## Simplifications / out of scope

- Quasi-static: no tree sway dynamics or resonance (gust periods ≪ tree period at tornado
  speeds are left out; *to check* against a dynamic model in validation).
- Trees don't shelter houses or change the local wind.
- Debarking is not simulated (DOD 5 is recorded by wind, not by debris).
- No soil moisture (uprooting capacity is for average soil).

## Changelog

- v0.1: draft at the user's request (2026-11-25): trees for the town, detail zone and lab.
