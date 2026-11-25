// Every sim can make heavy debris (Spec 04 v2.0), which needs Rapier loaded first.
import { initRapier } from "../src/sim/structureWorld";

await initRapier();
