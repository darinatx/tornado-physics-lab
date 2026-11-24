/**
 * Test neighborhood (Spec 05 v0.5): seeded suburban grid of DI 2 houses.
 */
import { CLASS_SHARES } from "../config/buildings";
import type { ConstructionClass } from "../config/buildings";
import { createHouse } from "../core/damage/building";
import type { Building, HouseSpec } from "../core/damage/types";
import { createRng } from "./rng";

export const CITY = {
  extent: 2600,
  blockX: 200,
  blockZ: 110,
  street: 15,
  lotWidth: 23,
  lotsPerRow: 8,
  emptyShare: 0.1,
  garageShare: 0.6,
  cell: 50,
} as const;

const WALL_COLORS = [0xe8e2d4, 0xd9d4c7, 0xcfd6dc, 0xe3d3b8, 0xbfc7b5, 0xd8c7b3, 0xf0ede6];
const ROOF_COLORS = [0x4a4d52, 0x5a4f46, 0x3e4349, 0x6b5a4c, 0x55585e];

export function pickClass(rng: () => number): ConstructionClass {
  const u = rng();
  if (u < CLASS_SHARES.weak) return "weak";
  if (u < CLASS_SHARES.weak + CLASS_SHARES.standard) return "standard";
  return "strong";
}

/** A random house at (x, z) facing the street on its local −Z side when yaw = 0. */
export function randomHouseSpec(
  id: number,
  rng: () => number,
  x = 0,
  z = 0,
  baseYaw = 0,
  cls?: ConstructionClass,
): HouseSpec {
  const pick = <T,>(a: readonly T[]) => a[Math.floor(rng() * a.length)]!;
  return {
    id,
    x,
    z,
    yaw: baseYaw + ((rng() - 0.5) * 6 * Math.PI) / 180,
    width: 11 + rng() * 5,
    depth: 9 + rng() * 4,
    wallHeight: 2.8 + rng() * 0.4,
    roofRise: 1.5 + rng() * 1.0,
    cls: cls ?? pickClass(rng),
    frontFace: 3,
    hasGarage: rng() < CITY.garageShare,
    wallColor: pick(WALL_COLORS),
    roofColor: pick(ROOF_COLORS),
  };
}

export interface Neighborhood {
  readonly buildings: Building[];
  buildingAt(x: number, z: number): Building | null;
}

/**
 * The street row a house is in: the houses on one side of one street within a block (up to
 * 8, all at the same setback). Detail-zone physics groups (Spec 09). Deterministic from the
 * house's position alone.
 */
export function streetRowOf(b: Pick<Building, "x" | "z">): string {
  const block = Math.floor((b.x + CITY.extent / 2) / CITY.blockX);
  return `${block}:${b.z.toFixed(2)}`;
}

export function containsPoint(b: Building, x: number, z: number): boolean {
  const ox = b.shift?.x ?? 0;
  const oz = b.shift?.z ?? 0;
  const dx = x - (b.x + ox);
  const dz = z - (b.z + oz);
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  // Inverse of the yaw rotation: world → local.
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.abs(lx) <= b.width / 2 && Math.abs(lz) <= b.depth / 2;
}

export function generateNeighborhood(seed: number): Neighborhood {
  const rng = createRng(seed ^ 0x9e3779b9);
  const half = CITY.extent / 2;
  const buildings: Building[] = [];
  const innerX = CITY.blockX - CITY.street;
  const innerZ = CITY.blockZ - CITY.street;
  const lotsSpan = CITY.lotsPerRow * CITY.lotWidth;
  const lotMargin = (innerX - lotsSpan) / 2;

  for (let bx = -half; bx + CITY.blockX <= half + 1e-6; bx += CITY.blockX) {
    for (let bz = -half; bz + CITY.blockZ <= half + 1e-6; bz += CITY.blockZ) {
      const x0 = bx + CITY.street / 2 + lotMargin;
      const z0 = bz + CITY.street / 2;
      for (let row = 0; row < 2; row++) {
        // Row 0 faces the street at −Z (yaw 0, front face local −Z); row 1 faces +Z (yaw π).
        const yaw = row === 0 ? 0 : Math.PI;
        for (let i = 0; i < CITY.lotsPerRow; i++) {
          if (rng() < CITY.emptyShare) continue;
          const x = x0 + CITY.lotWidth * (i + 0.5);
          // Set back toward the street: 8 m from the street edge to the house center line.
          const setback = row === 0 ? z0 + 13 : z0 + innerZ - 13;
          const spec = randomHouseSpec(buildings.length, rng, x, setback, yaw);
          buildings.push(createHouse(spec, rng));
        }
      }
    }
  }

  // Spatial grid for lookups.
  const grid = new Map<string, Building[]>();
  const key = (i: number, j: number) => `${i},${j}`;
  for (const b of buildings) {
    const r = Math.hypot(b.width, b.depth) / 2 + 3;
    for (let i = Math.floor((b.x - r) / CITY.cell); i <= Math.floor((b.x + r) / CITY.cell); i++)
      for (let j = Math.floor((b.z - r) / CITY.cell); j <= Math.floor((b.z + r) / CITY.cell); j++) {
        const k = key(i, j);
        const list = grid.get(k);
        if (list) list.push(b);
        else grid.set(k, [b]);
      }
  }

  return {
    buildings,
    buildingAt(x, z) {
      const list = grid.get(key(Math.floor(x / CITY.cell), Math.floor(z / CITY.cell)));
      return list?.find((b) => containsPoint(b, x, z)) ?? null;
    },
  };
}
