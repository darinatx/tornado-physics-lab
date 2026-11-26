import type { ConstructionClass, Part } from "../../config/buildings";
import type { Vec2, Vec3 } from "../math/vec";

/** Geometry and identity of a house, before components are laid out. */
export interface HouseSpec {
  id: number;
  /** Footprint center (m). */
  x: number;
  z: number;
  /** Rotation about +Y (rad). Local +X is the width axis (the ridge runs along it). */
  yaw: number;
  /** Footprint along local X (m). */
  width: number;
  /** Footprint along local Z (m). */
  depth: number;
  wallHeight: number;
  roofRise: number;
  cls: ConstructionClass;
  /** Face that faces the street (always 3 = local −Z). */
  frontFace: number;
  hasGarage: boolean;
  wallColor: number;
  roofColor: number;
  /** Explicit layouts (Spec 13): this house's layout and capacities come from its own stream
   *  with this seed, not the layout's shared one, so it is the same house whatever else is in
   *  the layout. */
  drawSeed?: number;
}

/** Connection failures of one type in a detailed house (Spec 09; loads in newtons). */
export interface DetailFailureGroup {
  label: string;
  count: number;
  /** Connections of this type in the house (windows for glazing: a pane breaks as one). */
  total: number;
  unit: "connections" | "windows";
  /** First failure: sim time (s), load and capacity (N), roof-height wind (mph). */
  time: number;
  load: number;
  capacity: number;
  mph: number;
}

export interface FailureRecord {
  part: Part;
  /** Index of the component within its list (panel, pane, section, bay, partition, face). */
  index: number;
  /** Sim time of failure (s). */
  time: number;
  /** Net load that caused it (Pa). */
  load: number;
  /** Capacity it exceeded (Pa). */
  capacity: number;
  /** Wind speed at roof height at the time (mph). */
  mph: number;
  /** Wall panels: +1 pushed in (falls inward), −1 pulled out. Roof bays: +1 lifted off,
   *  −1 collapsed because a bearing wall fell. */
  sign: number;
  /** Ground-relative wind at roof height when it failed (m/s). */
  wind: Vec3;
  /** What caused it: the wind (default) or a debris impact (Spec 10). For debris, `load` and
   *  `capacity` are the impact measure and threshold (momentum kg·m/s, energy J, or for an
   *  impulse-loaded panel the net pressure in Pa). */
  cause?: "debris";
  missile?: MissileInfo;
}

/** The piece that caused an impact failure (Spec 10). */
export interface MissileInfo {
  label: string;
  mass: number;
  /** Normal impact speed (m/s). */
  speed: number;
  measure: "momentum" | "energy" | "pressure";
}

/** Surface of a component house hit by debris (Spec 10). */
export type SurfaceKind = "pane" | "garage" | "wall" | "gable" | "roof";

/** One impact waiting for the house's next damage evaluation (Spec 10). */
export interface QueuedImpact {
  surface: SurfaceKind;
  /** Pane, panel (walls, gables, garage: its panel) or roof section index. */
  index: number;
  /** Face 0–3, or 4 for the roof. */
  face: number;
  broke: boolean;
  perforated: boolean;
  sidingTorn: boolean;
  coverTorn: boolean;
  /** Impulse force on the struck component (N); 0 for copies. A roof hit's push is used by
   *  detailed houses only (component uplift checks don't take a downward load). */
  force: number;
  /** Where it hit, house-local (m; y above the ground), when known. */
  at?: Vec3;
  /** The measure and threshold that decided the outcome (for the record). */
  measure: number;
  threshold: number;
  missile: MissileInfo;
}

/** Faces: 0 = +X (end), 1 = +Z (back eave), 2 = −X (end), 3 = −Z (front eave), local. */
export interface WallPanel {
  face: number;
  /** Position along the face (m, from its center). */
  u: number;
  len: number;
  /** Roof column above (eave walls) or the end column (end walls). */
  col: number;
  hasWindow: boolean;
  isGarage: boolean;
  cap: number;
  failed: FailureRecord | null;
}

export interface Pane {
  panel: number;
  cap: number;
  failed: FailureRecord | null;
}

export interface RoofSection {
  col: number;
  /** −1 = front slope (−Z), +1 = back slope (+Z). */
  slope: -1 | 1;
  /** 0 = eave row, 1 = ridge row. */
  row: 0 | 1;
  edge: boolean;
  /** Plan area (m², cached). */
  area: number;
  coverCap: number;
  deckCap: number;
  cover: FailureRecord | null;
  deck: FailureRecord | null;
}

export interface Simple {
  cap: number;
  failed: FailureRecord | null;
}

export interface Building extends HouseSpec {
  /** Mean roof height, where wind is sampled (m). */
  readonly roofHeight: number;
  /** Roof columns along the width; end-wall panels per side. */
  readonly nx: number;
  readonly ne: number;
  readonly panels: WallPanel[];
  readonly panes: Pane[];
  /** Garage door (on a front-wall panel), or null. */
  readonly garage: (Simple & { panel: number }) | null;
  /** Siding layer on each wall panel (same index as `panels`). */
  readonly siding: Simple[];
  readonly sections: RoofSection[];
  readonly bays: Simple[];
  /** For each roof bay: its front and back eave panels with their same-wall neighbors, and
   *  (end bays) the gable end wall's panels. */
  readonly bayWalls: { eave: { under: number; neighbors: number[] }[]; gable: number[] }[];
  /** For each wall panel, the perpendicular wall's panel at the same corner, or −1. */
  readonly cornerPartner: number[];
  readonly partitions: Simple[];
  /** Small interior core room (closet/bath): the last thing standing. */
  readonly coreRoom: Simple;
  readonly anchorage: Simple;
  readonly sweep: Simple;
  /** Internal pressure deficit lagging the outside (Pa). */
  deficitIn: number;
  /** Peak wind speed experienced at roof height (mph). */
  peakMph: number;
  /** Closest approach to the tornado's core edge: min over steps of (distance to the axis −
   *  R_max) (m, negative inside the core; +∞ before any) (Spec 03 v2.2, DMG-14). */
  closestEdge: number;
  /** Current degree of damage (0–10). */
  dod: number;
  /** Offset after shifting off the foundation (m). */
  shift: Vec2 | null;
  /** Increases whenever this house's damage changes (for rendering). */
  rev: number;
  /** Cached world-space outward face normals (yaw is fixed). */
  readonly normals: Vec2[];
  /** Any opening has failed (cached). */
  breached: boolean;
  /** Smallest capacity among intact components (Pa), for skipping calm evaluations. */
  minCap: number;
  /** Debris impacts waiting for the next damage evaluation (Spec 10). */
  impacts: QueuedImpact[];
  /** Siding stripped by debris per wall panel (m²), and shingles torn off per roof section. */
  sidingLost: number[];
  coverLost: number[];
  /** Perforation holes (m²) per face 0–3, and the roof at index 4 (Spec 10). */
  holes: number[];
  /** Inward impulse pressure on each wall panel, and on the garage door, this evaluation (Pa). */
  impactPa: number[];
  garageImpactPa: number;
  /** Largest impact on each panel this evaluation (for the record), or null. */
  impactBy: (MissileInfo | null)[];
  /** A detailed house's stand-in for town debris (Spec 10 v0.7): its standing walls and roof
   *  as of a fixed lag behind the detail physics. */
  standIn?: Building;
  /** Set on a stand-in: the detailed house it stands for (its id). */
  standInFor?: number;
  /** In the structural detail zone (Spec 09): the component model leaves it alone. */
  detail?: boolean;
  /** Connection failures in the detail zone, grouped by connection type (Spec 09), in order. */
  detailFailures?: DetailFailureGroup[];
}
