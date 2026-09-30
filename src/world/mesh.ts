import { CEILY, HU } from './constants';

// Vertex arrays for the renderer. Layouts (floats per vertex):
//   6 = position, uv, texture layer (world, props, doors)
//   7 = position, uv, layer, shade (models: the per-face shade is added to the light distance)
//   8 = centre, offset (x right, y up), uv, layer (billboards)
export type Vec3 = [number, number, number];
export type UV = [number, number];

export function pushQuad(a: number[], p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, uv: UV[], layer: number): void {
  const P = [p0, p1, p2, p0, p2, p3], U = [uv[0]!, uv[1]!, uv[2]!, uv[0]!, uv[2]!, uv[3]!];
  for (let k = 0; k < 6; k++) a.push(P[k]![0], P[k]![1], P[k]![2], U[k]![0], U[k]![1], layer);
}

export function pushTri(a: number[], p: Vec3[], uv: UV[], layer: number): void {
  for (let k = 0; k < 3; k++) a.push(p[k]![0], p[k]![1], p[k]![2], uv[k]![0], uv[k]![1], layer);
}

/** Tile coordinates (x east, y north) and height units -> world position. */
export const W = (x: number, y: number, h: number): Vec3 => [x, h * HU, -y];

/** A wall quad from (x0,y0) to (x1,y1), bottom b0/b1 and top t0/t1 in height units; v is measured down from the ceiling. */
export function wallQuad(a: number[], x0: number, y0: number, x1: number, y1: number, b0: number, b1: number, t0: number, t1: number, layer: number): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  pushQuad(a, W(x0, y0, b0), W(x1, y1, b1), W(x1, y1, t1), W(x0, y0, t0),
    [[0, CEILY - b0 * HU], [len, CEILY - b1 * HU], [len, CEILY - t1 * HU], [0, CEILY - t0 * HU]], layer);
}

/** A box: centre (world), size (tile units), yaw about Y; cy is the bottom. */
export function propBox(a: number[], cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, ang: number, layer: number): void {
  const c = Math.cos(ang), s = Math.sin(ang);
  const P = (x: number, y: number, z: number): Vec3 => [cx + x * c - z * s, cy + y, cz + x * s + z * c];
  const x0 = -sx / 2, x1 = sx / 2, z0 = -sz / 2, z1 = sz / 2, y0 = 0, y1 = sy;
  const faces: [Vec3, Vec3, Vec3, Vec3, number, number][] = [
    [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], sx, sz], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], sx, sz],
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], sx, sy], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], sx, sy],
    [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], sz, sy], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], sz, sy]];
  for (const [p0, p1, p2, p3, u, v] of faces) pushQuad(a, P(...p0), P(...p1), P(...p2), P(...p3), [[0, v], [u, v], [u, 0], [0, 0]], layer);
}

export function propCyl(a: number[], cx: number, cy: number, cz: number, r: number, h: number, sides: number, layer: number): void {
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
    const u0 = (i / sides) * 2 * Math.PI * r, u1 = ((i + 1) / sides) * 2 * Math.PI * r;
    const p = (an: number, y: number): Vec3 => [cx + Math.cos(an) * r, cy + y, cz + Math.sin(an) * r];
    pushQuad(a, p(a0, 0), p(a1, 0), p(a1, h), p(a0, h), [[u0, h], [u1, h], [u1, 0], [u0, 0]], layer);
  }
}
