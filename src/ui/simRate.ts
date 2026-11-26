/** Measured sim rate for the slow-motion status (Spec 07 v1.11, INST-16). */

/** Window the rate is averaged over (s of real time). */
const WINDOW_S = 1;
/** Frames longer than this (s) are left out: a hidden tab, not the sim's pace. */
const MAX_FRAME_S = 0.25;

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
}

/** "0.42× real time": two significant figures. */
export function rateText(rate: number): string {
  return `${Number(rate.toPrecision(2))}× real time`;
}
