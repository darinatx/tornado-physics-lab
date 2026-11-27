# Tornado Physics Lab

A physics-based tornado simulator that runs in the browser. A tornado moves through a
procedural town, and everything that happens to it comes from wind-engineering physics:
wind loads on each wall and roof, parts failing when the load passes their capacity, the
broken parts flying as debris, and that debris hitting the next house.

The goal is **scientifically grounded and explainable**, not full fluid dynamics. Every broken
window, lifted roof and flying 2×4 can be traced back to a physical quantity you can inspect
(wind speed, pressure, load, capacity), an equation in a spec, and a test that checks it.

## What it simulates

**The tornado.** A parametric 3D wind field covering EF0 to EF5:
- **Rotation:** a modified Rankine vortex, with swirl speeds peaking near the ground where
  the inflow turns upward.
- **Air flow:** inflow in the boundary layer, and one-cell or two-cell updrafts depending on
  the swirl ratio.
- **Motion:** forward motion that makes one side of the path stronger than the other.
- **Pressure:** a pressure drop at the center from cyclostrophic balance.
- **Lifecycle and gusts:** the tornado forms, matures and dissipates, with gusts throughout.

Presets give realistic rope, cone and wedge tornadoes from EF0 to EF5, or you can set
strength, size, forward speed, heading and cloud base yourself.

**The ground.** Ground roughness comes from what's actually there, not one map-wide
setting. The wind runs faster over open fields and slows over neighborhoods, adjusts as it
crosses from one into the other, and speeds up again as houses are flattened. The ground
is drawn to match (fields, lawns, concrete) and keeps damage tracks: lodged crops, scoured
soil, debris gouges.

**Houses and damage.** Houses are built from components: walls, windows, doors, roof
covering, roof deck and rafters. Each has a capacity and fragility drawn from the Enhanced
Fujita scale's damage indicator for one- and two-family homes. Failures cascade:
1. A broken window lets wind into the house.
2. The air pressure inside rises.
3. The roof lifts off.
4. Bearing walls lose their support and fall.

Each house gets a survey-style Degree of Damage and EF rating, the way a National Weather
Service damage survey would rate it.

**Structural detail zone.** Around a spot you pick, 30 houses are simulated member by member
(studs, plates, rafters, sheathing, siding, windows) in a rigid-body engine
([Rapier](https://rapier.rs), running in web workers). They're held together by breakable
connections such as nails, toe-nails, hurricane straps and anchor bolts. Nothing is
scripted: connections break when they're loaded past their strength, and whatever comes
loose topples, hinges, tumbles and collides on its own. Houses outside the zone use the
calibrated component model, and each house switches between the two without a visible jump.

**Debris.** Failed parts become flying pieces with real mass, size and aerodynamics. They
feel drag and lift, tumble and spin, scatter on turbulence, land, slide and get snagged.
Heavy pieces are rigid bodies. The debris field they leave behind can be surveyed.

**Impacts.** Debris hits the houses it meets. Damage depends on the impact's momentum and
energy compared with test values for each kind of surface. Debris can:
- break windows, which lets the wind in;
- punch through walls and roofs;
- strip siding and shingles;
- lodge 2×4s in walls;
- knock walls over (heavy pieces).

Debris never passes through a standing house, and the tests check this.

## Instruments

- **Inspect probe:** hover anywhere to read the wind:
  - speed in mph and m/s, its EF rating, and the direction it blows from;
  - its parts: around the tornado, inward or outward, up or down;
  - the air pressure and how far it has dropped;
  - the wind pressure on a surface (q = ½ρV²);
  - the local ground roughness;
  - your distance from the core.
- **Pinned probes:** pin up to four spots to graph wind speed and air pressure over the
  whole run, like a barometer as the tornado passes.
- **Building inspector:** pin a house to see:
  - its damage rating and wind history;
  - every part type that failed, in order, with the wind speed, load and capacity at the
    first failure;
  - for houses in the detail zone, which connections broke and the force in each.
- **Structure lab:** a close-up bench for a few houses, using the same physics and renderer
  as the town. Watch them come apart, inspect any member, set the ground roughness, and fire
  debris at them with a launcher. Open it from the panel, or with `?lab` in the URL.
- **Wind tunnel:** one house in a scripted wind, hit by known debris, using exactly the
  town's code. Runs in seconds from the command line (`npm run tunnel`), so problems can
  be traced to one piece, one surface and one model.

## Run it

You need Node.js 22 or later.

```bash
git clone https://github.com/darinatx/tornado-physics-lab.git
cd tornado-physics-lab
npm install
npm run dev           # the app, at http://localhost:5173
```

The town opens in calm air. Pick a preset and press **🌪 Spawn tornado**. To watch houses come apart member by member, press **📍 Pick detail spot** and click the ground to
put the structural detail zone there.

```bash
npm run verify:fast   # typecheck + unit tests + spec traceability (seconds)
npm run test          # adds the validation tests: full tornado runs (several minutes)
```

## How it's built

**Stack:** TypeScript, [Three.js](https://threejs.org) for rendering, Rapier for rigid
bodies, [Vite](https://vite.dev) for the dev server and build.

**Layers.** Imports only go downward: `ui → render → sim → core`.

| Folder | What's in it |
|---|---|
| `src/core` | Pure physics: wind, loads, damage, debris, impacts, terrain. No Three.js, no DOM. |
| `src/sim` | World state, the fixed-timestep loop, entity storage, the detail-zone workers |
| `src/render` | Three.js. Reads the sim state, never writes it. |
| `src/ui` | Panels, sliders, probes, graphs |
| `src/config` | Every tunable constant, with its unit and source |

**Physics rules**
- **SI units:** mph only at the display.
- **Fixed timestep:** physics never uses the frame time; rendering interpolates between
  steps.
- **Deterministic:** all randomness is seeded, so the same seed and settings give the same
  run.

**Spec-driven.** Each subsystem has a spec in [docs/specs](docs/specs) with its equations,
parameters, numbered acceptance criteria and the reasoning behind its modeling choices.
Every criterion ID (for example `WIND-03`) appears in a test name, and `npm run trace` fails
if one is missing. Validation tests check results against published references, among them:
- the EF scale's damage indicators;
- ASCE 7-22 wind loads;
- ASTM E1996, ICC 500 and FEMA P-361 debris impact tests;
- the NDS for wood connection strengths;
- wind tunnel and tornado-simulator studies (Haan, Sarkar and colleagues, Tachikawa).

## Status and roadmap

Development runs in phases, each ending with a demo and a sign-off. Phases 1–6 are done:
- the wind field and instruments;
- houses with loads and damage;
- flying debris;
- component houses;
- the structural detail zone;
- debris impacts, with the wind tunnel and structure lab.

Phase 7, terrain worked out from the town, has its preliminary sign-off and is being validated. Up next:
- **Storm report:** an NWS-style damage survey and an engineering assessment, produced at
  the end of a run.
- **Richer houses and trees:** trusses, porches, chimneys, room contents, and trees that
  snap and uproot.
- **The parent supercell:** wall cloud, rain and hail curtains, a radar view with the hook
  echo, and multi-vortex tornadoes.
- **More building types:** from mobile homes to skyscrapers.
- **Performance work, city generation, replay.**

The full plan is in [docs/phases/ROADMAP.md](docs/phases/ROADMAP.md). The non-obvious design
choices are recorded in [docs/decisions](docs/decisions).

**Not a forecasting tool.** It doesn't predict real storms, and it isn't a substitute for
engineering design or safety guidance.

## Contributing

Bug reports, fixes, better sources and new physics are all welcome. Read
[CONTRIBUTING.md](CONTRIBUTING.md) first: changes start from an approved spec, and tests are
named after its acceptance criteria. The project's working agreement is in
[CLAUDE.md](CLAUDE.md).

## License

[MIT](LICENSE)
