# Tornado Sim

A physics-based tornado simulator in the browser. A tornado moves through a procedural town
and destroys it according to wind-engineering physics: a Rankine-type vortex, dynamic
pressure loads on every wall and roof, EF-scale fragility, flying debris with drag and lift,
and debris impacts. Near a spot you pick, houses are simulated member by member (studs,
rafters, sheathing, nails, straps) in a rigid-body engine.

Every result can be traced from what you see on screen back to an equation, a spec and a
test.

## Run it

You need Node.js 22 or later.

```bash
npm install
npm run dev           # the app, at http://localhost:5173
npm run verify:fast   # typecheck + unit tests + spec traceability (seconds)
npm run test          # adds the validation tests: full tornado runs (several minutes)
```

## How it's built

- **Stack:** TypeScript, [Three.js](https://threejs.org) for rendering,
  [Rapier](https://rapier.rs) for the detail-zone rigid bodies, [Vite](https://vite.dev).
- **Specs:** what each subsystem must do, with numbered acceptance criteria, in
  [docs/specs](docs/specs).
- **Roadmap:** the phases and where things stand, in
  [docs/phases/ROADMAP.md](docs/phases/ROADMAP.md).
- **Decisions:** the non-obvious choices, in [docs/decisions](docs/decisions).
- **Working agreement:** [CLAUDE.md](CLAUDE.md).

## Contributing

Bug reports, fixes, better sources and new physics are all welcome. Read
[CONTRIBUTING.md](CONTRIBUTING.md) first: changes start from an approved spec, and tests are
named after its acceptance criteria.

## License

[MIT](LICENSE)
