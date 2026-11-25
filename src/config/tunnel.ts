/**
 * Wind tunnel test harness constants (Spec 12). SI units.
 */
export const TUNNEL = {
  /** Donors stand this far to either side of the target, across the mean wind (m): out of the
   *  flow onto the target and its debris, well inside the detail engine's 100 m stand-in reach. */
  donorOffset: 80,
  /** Record sample rate (Hz). */
  sampleHz: 10,
  /** Height over which the scheduled vertical wind ramps up from zero at the ground (m): air
   *  can't flow through the ground. Spec 01's reference height. */
  wRampHeight: 10,
  /** Core radius the tunnel's wind state reports (m): marks the whole tunnel as in range for
   *  every range check (damage, debris settling, detail zone). Not a physical radius. */
  inRange: 1e6,
  /** Default distance a launch aimed at a surface starts from it, along its normal (m). */
  standoff: 4,
  /** Rubble checked for pass-through once per this many debris steps (60 Hz → 1 s). */
  rubbleEvery: 60,
} as const;
