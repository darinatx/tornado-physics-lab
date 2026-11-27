/**
 * The tornado waits until the user spawns it (Spec 07, INST-17): the sim holds at time 0 (the
 * lifecycle's zero strength: no funnel, no wind) until Spawn; Restart and choosing a preset
 * return to waiting. The chosen sim speed applies once it runs.
 */
export interface SpawnGate {
  readonly waiting: boolean;
  /** Start the run at the chosen speed. */
  spawn(): void;
  /** Back to waiting (after a restart or a new preset). */
  wait(): void;
  /** The speed chosen in the panel; applied now if running, else on spawn. */
  setSpeed(k: number): void;
  /** Called whenever `waiting` changes. */
  onChange?: (waiting: boolean) => void;
}

export function createSpawnGate(sim: { setTimeScale(k: number): void }, speed = 1): SpawnGate {
  let waiting = true;
  let k = speed;
  sim.setTimeScale(0);
  const gate: SpawnGate = {
    get waiting() {
      return waiting;
    },
    spawn() {
      waiting = false;
      sim.setTimeScale(k);
      gate.onChange?.(waiting);
    },
    wait() {
      waiting = true;
      sim.setTimeScale(0);
      gate.onChange?.(waiting);
    },
    setSpeed(s) {
      k = s;
      if (!waiting) sim.setTimeScale(k);
    },
  };
  return gate;
}
