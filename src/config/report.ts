/** Storm report constants (Spec 16). */
import { DAMAGE_STEP_INTERVAL } from "./buildings";
import { MS_PER_MPH } from "./units";

export const REPORT = {
  /** Track sample interval (s, sim time). Enough for the timeline; a 10 min run is 600 samples. */
  trackInterval: 1,
  /** Swath cell size (m): about a house width, so each house has its own cell. */
  cell: 10,
  /** Swath tile side (cells): 16 × 16 cells (160 m), so the grid stays sparse. */
  tile: 16,
  /** Swath and building samples every this many physics steps: the damage rate (Spec 03, 30 Hz). */
  sampleEvery: DAMAGE_STEP_INTERVAL,
  /** Beyond 1.5·R_max sample every 4th pass, beyond 3·R_max every 8th (Spec 19's scheme): a
   *  cell's peak comes at its closest approach, where its distance changes slowly. */
  outerEvery: 4,
  farEvery: 8,
  /** Swath threshold (m/s): EF0's lower bound, 65 mph. */
  threshold: 65 * MS_PER_MPH,
  /** Height of the true wind (m): the EF scale's 10 m. */
  height: 10,
  /** Smallest β the wind can feel (Spec 17 clamp), for the upper bound on the 10 m wind. */
  betaMin: 0.08,
  /** Ring width for the upper-bound table (m). */
  ring: 2,
  /** Survey section length along the track (m): about two lots. */
  section: 50,
  /** Houses in the failure sequences (keeps the section readable). */
  failureHouses: 10,
  /** Contour margin (m) around the outermost points of a section, so every point lies strictly
   *  inside its contour (half a swath cell). */
  contourMargin: 5,
} as const;

/** Compass points for positions from the town center. */
export const COMPASS16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"] as const;
