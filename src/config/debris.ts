/**
 * Debris constants (Spec 04). Sizes in m, masses in kg.
 * Tumble-averaged aerodynamics (Wills, Lee & Wyatt 2002; Tachikawa 1983):
 *   sheets & rods: C_D·A = 0.7·L·W; sheets also C_L·A = 0.2·L·W; compact: C_D·A = 0.8·L·W.
 */
import type { Part } from "./buildings";

export type DebrisFamily = "sheet" | "rod" | "compact";

export interface DebrisKindDef {
  label: string;
  family: DebrisFamily;
  /** Length, width, thickness (m). */
  dims: readonly [number, number, number];
  mass: number;
  /** Drag coefficient × reference area (m²). */
  cda: number;
  /** Lift coefficient × reference area (m²); 0 for non-lifting pieces. */
  cla: number;
  /** Autorotation: ω = spinRate · |v_rel| / L. */
  spinRate: number;
}

export const sheet = (label: string, L: number, W: number, T: number, mass: number): DebrisKindDef => ({
  label, family: "sheet", dims: [L, W, T], mass, cda: 0.7 * L * W, cla: 0.2 * L * W, spinRate: 0.6,
});
export const rod = (label: string, L: number, W: number, T: number, mass: number): DebrisKindDef => ({
  label, family: "rod", dims: [L, W, T], mass, cda: 0.7 * L * W, cla: 0, spinRate: 0.4,
});
export const compact = (label: string, L: number, W: number, T: number, mass: number): DebrisKindDef => ({
  label, family: "compact", dims: [L, W, T], mass, cda: 0.8 * L * W, cla: 0, spinRate: 0.3,
});

export const DEBRIS_KINDS = {
  shingle: sheet("Shingle", 1.0, 0.33, 0.005, 1.0),
  siding: sheet("Siding strip", 3.8, 0.25, 0.003, 1.5),
  osb: sheet("OSB sheathing", 2.4, 1.2, 0.012, 16),
  garagePanel: sheet("Garage door panel", 2.4, 0.55, 0.04, 12),
  rafter: rod("Rafter (2×6)", 3.6, 0.14, 0.04, 8),
  stud: rod("Stud (2×4)", 2.4, 0.09, 0.04, 4.5),
  glass: compact("Glass shard", 0.15, 0.15, 0.005, 0.25),
  chunk: compact("Wall chunk", 0.5, 0.5, 0.15, 18),
  // Component-shaped pieces (Phase 4): size and mass come from the failed component.
  wallPanel: sheet("Wall panel", 4, 2.9, 0.15, 290),
  roofPanel: sheet("Roof section", 4, 3.5, 0.25, 250),
  deckSheet: sheet("Roof deck section", 4, 1.8, 0.05, 70),
  garageDoor: sheet("Garage door", 4.9, 2.2, 0.05, 130),
} as const satisfies Record<string, DebrisKindDef>;

export type DebrisKind = keyof typeof DEBRIS_KINDS;

/** Full-size component pieces: never drawn enlarged (they're already big and visible). */
export const COMPONENT_KINDS: ReadonlySet<DebrisKind> = new Set(["wallPanel", "roofPanel", "deckSheet", "garageDoor"]);

/**
 * Representative pieces released per failure (Spec 04 v1.4). Component-shaped pieces (wall
 * panels, roof sections, deck sections, garage doors) are added by the debris field itself.
 */
export const SPAWN_TABLE: Record<Part, [DebrisKind, number][]> = {
  siding: [["siding", 1]],
  roofCover: [["shingle", 2]],
  window: [["glass", 2]],
  garage: [],
  roofDeck: [],
  anchorage: [],
  roofBay: [],
  wallPanel: [],
  partition: [["stud", 2], ["chunk", 2]],
  coreRoom: [["stud", 2], ["chunk", 3]],
  sweep: [["stud", 4], ["chunk", 6]],
};

export const DEBRIS = {
  /** Maximum active (simulated) pieces at once. */
  cap: 3000,
  /**
   * Maximum pieces kept in the permanent debris field. Resting pieces away from the tornado
   * move here: drawn, never simulated again, never recycled (unless this fills).
   */
  settledCap: 150000,
  /** Sliding (kinetic) friction coefficient. */
  friction: 0.5,
  /**
   * Holding (static) coefficient for landed debris: pieces snag on grass, crops, fences and
   * other debris, so starting them moving takes more than keeping them moving.
   */
  holdFriction: 1.2,
  /**
   * Mean sliding distance before a piece snags on an obstacle (m), by terrain. A snagged
   * piece is pinned against the obstacle by the wind: it's released only when the wind
   * swings around to pull it back the way it came (and drag beats the holding friction), or
   * when the wind lifts it over.
   */
  snagDistance: { open: 30, suburban: 15, urban: 8 },
  /**
   * Rough ground (Spec 04 v1.7): mean distance a sliding piece travels between bumps (clods,
   * furrows, tufts, ruts, curbs, other debris), and the steepest bump (ramp slope tan θ).
   */
  bumpSpacing: { open: 1, suburban: 1.5, urban: 2 },
  bumpMaxSlope: 0.4,
  /**
   * A piece starts tumbling (autorotating) only when its lowest point is this many of its own
   * lengths above the ground; lower down it keeps its attitude (Spec 04 v1.7).
   */
  tumbleClearance: 0.5,
  /** Pieces longer than a bump (m) pivot over it on their trailing edge. */
  bumpLength: 1,
  /**
   * Resting pieces farther than this many R_max from the tornado move to the permanent
   * debris field; ground-level wind out there can no longer move them.
   */
  settleRangeRmax: 3,
  /** Bounce restitution on landing (only above minBounceSpeed). */
  restitution: 0.2,
  minBounceSpeed: 2,
  /** Below this horizontal speed (m/s), a held piece comes to rest. */
  restSpeed: 0.2,
  /** Pieces beyond this |x| or |z| (m) leave the map. */
  mapHalf: 6000,
  /** Debris is stepped every N physics steps (60 Hz at dt = 1/120). */
  stepInterval: 2,
  /** Height at which resting pieces sample the wind (m). */
  restSampleHeight: 0.2,
} as const;

/**
 * Drag on a piece lying or sliding on the ground (Spec 04 v1.8): blunt-body C_D on the area its
 * box shows the flow, plus skin friction on its top face (flat plate along the flow).
 */
export const GROUND_DRAG = { cd: 1.2, skin: 0.05 } as const;

/**
 * Turbulent dispersion (Spec 04 v1.3). The wind field is a smooth mean flow; real near-ground
 * wind gusts by 15–40% depending on terrain. Each flying piece feels its own gust, a
 * first-order (Ornstein–Uhlenbeck) random process, so debris from one house fans out instead
 * of following one streamline.
 */
export const TURBULENCE = {
  /** Turbulence intensity σ_u / U by terrain (typical near-ground values). */
  intensity: { open: 0.2, suburban: 0.3, urban: 0.4 },
  /** Vertical gust σ as a fraction of the horizontal σ. */
  verticalRatio: 0.5,
  /** Gust correlation time (s). */
  timeScale: 2,
  /** Tumbling sheets' lift is rolled up to ± this angle (rad) about the relative wind. */
  maxLiftRoll: Math.PI / 2,
} as const;

/**
 * Settled flying debris could be drawn as several jittered copies (by `represents`). Set to 1:
 * copies made one landing piece look like several, and component rubble now supplies the
 * real density (Spec 04 v1.4).
 */
export const SETTLED_COPIES_MAX = 1;

export const DEBRIS_COLORS: Partial<Record<DebrisKind, number>> = {
  osb: 0xb8935a,
  garagePanel: 0xe6e2da,
  rafter: 0xc9a36b,
  stud: 0xc9a36b,
  glass: 0x9fc4d8,
  chunk: 0x8f8a82,
};

/**
 * Heavy pieces as rigid bodies (Spec 04 v2.0): pieces of at least `minKg` standing for one real
 * object move in the heavy-debris world (Rapier) instead of the point model.
 */
export const HEAVY = {
  /** kg; the detail zone's own cutoff between rigid and light pieces (DETAIL.lightKg). */
  minKg: 40,
  /** Contact friction with the ground, slabs, houses and each other (as Spec 09's members). */
  friction: 0.6,
  /** Bounce on landing: wood and drywall panels hardly bounce. */
  restitution: 0.1,
  /** s: no contact with its own house's walls and roof it overlaps while it tears away. */
  separationS: 0.5,
  /** m: overlaps are judged with the piece this much smaller at its edges (touching neighbors
   *  aren't overlaps). */
  edgeShrink: 0.1,
  /** m: look-ahead of Rapier's soft CCD (Spec 10: as the detail zone's loose bodies). */
  softCcd: 0.5,
  /** …and at least this many times how far the body can move in a step (as the detail zone). */
  ccdMargin: 2,
  /** Contact solver iterations (Rapier's default). Thin sheets landing hard sank a few cm until
   *  full CCD went on for bodies moving more than half their thickness a step; 8 didn't help. */
  solverIterations: 4,
  /** m: a body's lowest corner sunk more than this into the ground or a slab is set back on it. */
  sinkTolerance: 0.005,
  /** m: houses within this distance of a moving body (beyond its footprint) are built as
   *  colliders; a sleeping body keeps only those within restReach (what it lies on or against). */
  houseReach: 10,
  restReach: 2,
  /** m: above this a body meets no house (roofs are below ~7 m): none are built for it. */
  highY: 10,
  /** Debris steps a built house is kept after nothing wants it (moving in and out rebuilt it). */
  keepHouseSteps: 60,
  /** Hits below this many times the body's weight are resting contact, not impacts. */
  hitWeights: 3,
  /** A sleeping body is checked against the wind every this many debris steps (and the houses
   *  around the bodies are updated every step). */
  wakeEvery: 6,
  /** s: a body asleep this long, once the tornado has passed it (behind its center, beyond
   *  retireRmax·R_max), is retired to the permanent debris field: the wind behind the core
   *  falls off, and a heavy piece that settled there stays (cost: Phase 6 profile). */
  retireAfterS: 2,
  retireRmax: 1.5,
  /** Most bodies in the world at once: past this the longest-resting sleepers are retired,
   *  then the slowest pieces creeping on the ground (below creepSpeed m/s, under creepY m). */
  maxBodies: 400,
  creepSpeed: 3,
  creepY: 1,
  /** The heavy-debris world steps every this many debris steps (1: 60 Hz). At 30 Hz contacts
   *  went soft: thin sheets landing hard sank 2–40 cm into the ground and slabs. */
  stepEvery: 1,
} as const;
