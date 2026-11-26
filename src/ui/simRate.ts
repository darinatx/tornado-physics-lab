/** Measured sim rate for the slow-motion status (Spec 07 v1.12, INST-16). */

/** Window the rate is averaged over (s of real time). */
const WINDOW_S = 1;
/** Frames longer than this (s) are left out: a tab coming back from hidden, not the sim's
 *  pace. Shorter slow frames count (the sim clamps them to 0.25 s, SIM-02, and drops time). */
const MAX_FRAME_S = 1;
/** Real time measured (s) before the sim can count as slow. */
const MIN_MEASURED_S = 0.5;
/** Slow below this fraction of the speed setting. */
const SLOW_FRACTION = 0.95;

export class SimRateMeter {
  private frames: { real: number; sim: number }[] = [];
  private lastSim: number | null = null;
  private realSum = 0;
  private simSum = 0;

  /** One rendered frame: real seconds since the last one, and the sim time now. */
  push(realDt: number, simTime: number): void {
    const prev = this.lastSim;
    this.lastSim = simTime;
    if (prev === null) return;
    if (simTime < prev) {
      this.frames = [];
      this.realSum = this.simSum = 0;
      return;
    }
    if (!(realDt > 0) || realDt > MAX_FRAME_S) return;
    const f = { real: realDt, sim: simTime - prev };
    this.frames.push(f);
    this.realSum += f.real;
    this.simSum += f.sim;
    while (this.frames.length > 1 && this.realSum - this.frames[0]!.real >= WINDOW_S) {
      const old = this.frames.shift()!;
      this.realSum -= old.real;
      this.simSum -= old.sim;
    }
  }

  /** Sim seconds per real second over the last second, or null before any frames. */
  get rate(): number | null {
    return this.frames.length && this.realSum > 0 ? this.simSum / this.realSum : null;
  }

  /** Running slower than the speed setting `timeScale` (never when paused). */
  isSlow(timeScale: number): boolean {
    const r = this.rate;
    return r !== null && timeScale > 0 && this.realSum >= MIN_MEASURED_S && r < SLOW_FRACTION * timeScale;
  }
}

/** "0.42× real time": two significant figures. */
export function rateText(rate: number): string {
  return `${Number(rate.toPrecision(2))}× real time`;
}
