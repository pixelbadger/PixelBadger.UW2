import { BODY, CEILY, CRAD, CBODY, RAD, STEP } from './constants';
import type { Level } from './level';
import type { Solid } from './props';

// Collision against the level: floors (Level.floorAt), props (solids), doors (segments) and creatures.
// Stand-in boxes/cylinders collide by shape; real models through a 1/16-tile height grid (lo/hi per cell).

/** Does a disc of radius r at (X, Y) overlap a box or cylinder solid in plan view? */
export function solidHit(s: Solid, X: number, Y: number, r: number): boolean {
  const dx = X - s.x, dy = Y - s.y;
  if (s.kind === 'cyl') return dx * dx + dy * dy < (s.r + r) * (s.r + r);
  if (s.kind !== 'box') return false;
  const lx = dx * s.c - dy * s.s, lz = -dx * s.s - dy * s.c; // inverse of propBox's rotation, with y = -z
  const qx = Math.max(-s.hx, Math.min(s.hx, lx)), qz = Math.max(-s.hz, Math.min(s.hz, lz));
  const ex = lx - qx, ez = lz - qz;
  return ex * ex + ez * ez < r * r;
}

/** Calls fn(bottom, top) for each model grid cell under the disc; stops and returns true when fn does. */
export function cellsOf(s: Extract<Solid, { kind: 'model' }>, X: number, Y: number, r: number, fn: (lo: number, hi: number) => boolean | void): boolean {
  const dx = X - s.x, dy = Y - s.y;
  if (dx * dx + dy * dy > (s.R + r) * (s.R + r)) return false;
  const g = s.g, lx = dx * s.c - dy * s.s, ly = dx * s.s + dy * s.c, cs = g.cs; // inverse of the model -> tile rotation
  const i0 = Math.max(0, Math.floor((lx - r - g.x0) / cs)), i1 = Math.min(g.nx - 1, Math.floor((lx + r - g.x0) / cs));
  const j0 = Math.max(0, Math.floor((ly - r - g.y0) / cs)), j1 = Math.min(g.ny - 1, Math.floor((ly + r - g.y0) / cs));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const k = j * g.nx + i;
    if (g.hi[k]! < -1e8) continue;
    const cx = Math.max(g.x0 + i * cs, Math.min(g.x0 + (i + 1) * cs, lx)), cy = Math.max(g.y0 + j * cs, Math.min(g.y0 + (j + 1) * cs, ly));
    if ((cx - lx) * (cx - lx) + (cy - ly) * (cy - ly) >= r * r) continue;
    if (fn(s.b + g.lo[k]!, Math.min(CEILY, s.b + g.hi[k]!))) return true;
  }
  return false;
}

/** Highest thing you can stand on at (X, Y) for a body whose feet are at `feet`: the floor, or a prop top within a step. */
export function supportAt(L: Level, X: number, Y: number, feet: number): number | null {
  let f = L.floorAt(X, -Y);
  if (f == null) return null;
  const lim = feet + STEP + 1e-4;
  for (const s of L.scene.solids) {
    if (s.kind === 'model') cellsOf(s, X, Y, 0.06, (_lo, hi) => { if (hi > f! && hi <= lim) f = hi; });
    else if (s.t > f && s.t <= lim && solidHit(s, X, Y, 0.06)) f = s.t;
  }
  return f;
}

/** A prop the body (radius r, height h) would walk into rather than step onto. */
export function solidBlocks(L: Level, X: number, Y: number, r: number, feet: number, h: number): Solid | null {
  for (const s of L.scene.solids) {
    if (s.kind === 'model') { if (cellsOf(s, X, Y, r, (lo, hi) => lo < feet + h && hi > feet + STEP + 1e-4)) return s; }
    else if (s.b < feet + h && s.t > feet + STEP + 1e-4 && solidHit(s, X, Y, r)) return s;
  }
  return null;
}

/** Distance from (X, Y) to a segment. */
export function segDist(p: [number, number], q: [number, number], X: number, Y: number): number {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  let t = ((X - p[0]) * dx + (Y - p[1]) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(X - (p[0] + t * dx), Y - (p[1] + t * dy));
}

/** Would the player's body at world (x, z) with feet at `feet` hit anything? */
export function playerBlocked(L: Level, x: number, z: number, feet: number): boolean {
  for (let k = 0; k < 9; k++) {
    const a = (k * Math.PI) / 4, r = k === 8 ? 0 : RAD;
    const f = L.floorAt(x + Math.cos(a) * r, z + Math.sin(a) * r);
    if (f == null || f > feet + STEP || f > CEILY - 0.7) return true;
  }
  const X = x, Y = -z;
  if (solidBlocks(L, X, Y, RAD, feet, BODY)) return true;
  for (const c of L.critters) { const h = c.h ?? feet; if (h < feet + BODY && h + CBODY > feet + STEP && Math.hypot(c.x - X, c.y - Y) < RAD + CRAD) return true; }
  for (const [p, q] of L.scene.doorSegs) if (segDist(p, q, X, Y) < RAD) return true;
  return false;
}
