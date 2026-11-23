# ADR 0001 — Spec-driven, phase-gated development

Date: 2026-11-23
Status: Accepted

## Context

The simulator combines several coupled physical models (wind, loads, damage, debris). Without
explicit contracts, "realistic" quickly drifts into tuning numbers until it looks right, and
nobody can say why a building failed.

## Decision

- Each subsystem has a spec in `docs/specs/` with its equations, interface, parameters and
  numbered acceptance criteria.
- Work is split into phases (`docs/phases/`), each with exit criteria and a user sign-off.
- Every acceptance criterion ID must appear in a test name; `scripts/check-trace.ts` enforces
  this for Approved specs.
- Physics (`src/core`) is pure and renderer-free; imports go one way: ui → render → sim → core.

## Consequences

- Slower start, since specs come before code, but damage outcomes can be explained and tested.
- Specs must be kept current; drift is caught at each phase gate.
- Changing the stack later (e.g. a different renderer) only touches `render/` and `ui/`.

## Also decided

- Stack: TypeScript, Vite, Three.js, Vitest. A physics engine (Rapier or cannon-es) gets its
  own ADR in Phase 3.
