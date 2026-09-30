// World scale: 1 tile = 1.0, 64 texels per tile, height unit 0.25, ceiling at 4.0. Tile y = 0 is south; world z = -tileY.

/** One floor-height unit in world units. */
export const HU = 0.25;
/** Ceiling height in units (4 tiles). */
export const CEIL = 16;
export const CEILY = CEIL * HU;
/** Eye height, body radius, climbable step, body height. */
export const EYE = 0.62, RAD = 0.2, STEP = 0.3, BODY = 0.75;
/** Creature radius and height. */
export const CRAD = 0.16, CBODY = 0.8;
export const JUMPV = 3.2, GRAVITY = 9;
/** Creature sprites: world units per pixel. Object sprites use 1/64. */
export const CPX = 1 / 80;

/** N, E, S, W as corner indices (0 sw, 1 se, 2 ne, 3 nw). */
export const SIDE_CORNERS: [number, number][] = [[3, 2], [2, 1], [1, 0], [0, 3]];
export const CORNER_POS: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
/** Neighbour corner indices matching SIDE_CORNERS[s]. */
export const OPP_CORNER: [number, number][] = [[0, 1], [3, 0], [2, 3], [1, 2]];
export const DIRS: [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0]];

/** Is side s (0 N, 1 E, 2 S, 3 W) of a tile of this type open? */
export function sideOpen(type: number, s: number): boolean {
  if (type === 0) return false;
  if (type === 2) return s === 1 || s === 2;
  if (type === 3) return s === 2 || s === 3;
  if (type === 4) return s === 0 || s === 1;
  if (type === 5) return s === 0 || s === 3;
  return true;
}

/** Centre of an object's position within its tile (fx/fy are eighths). */
export const objX = (o: { tx: number; fx: number }): number => o.tx + (o.fx + 0.5) / 8;
export const objY = (o: { ty: number; fy: number }): number => o.ty + (o.fy + 0.5) / 8;
