import type { ObjRec, Tile } from '../formats';
import { CEILY, EYE } from '../world/constants';
import type { Pick } from '../world/props';
import type { Game } from './game';

export type Hit =
  | { kind: 'obj'; sp: Pick }
  | { kind: 'door'; dr: ObjRec }
  | { kind: 'surface'; tex: number; x: number; z: number; tile: Tile };

export const eye = (game: Game): [number, number, number] => [game.pose.x, game.pose.y + EYE, game.pose.z];

/** The view's forward, right and up vectors. */
export function viewBasis(yaw: number, pitch: number): { F: number[]; R: number[]; U: number[] } {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const F = [sy * cp, sp, -cy * cp], R = [cy, 0, sy];
  const U = [R[1]! * F[2]! - R[2]! * F[1]!, R[2]! * F[0]! - R[0]! * F[2]!, R[0]! * F[1]! - R[1]! * F[0]!];
  return { F, R, U };
}

/** What is under screen point (nx, ny) in -1..1: an object, a door leaf, or a wall/floor/ceiling (within 4 tiles). */
export function pick(game: Game, nx: number, ny: number): Hit | null {
  const L = game.L, { aspect: asp, fovY } = game.view, t = Math.tan(fovY / 2);
  const { F, R, U } = viewBasis(game.pose.yaw, game.pose.pitch);
  let d = [0, 1, 2].map(i => F[i]! + R[i]! * nx * t * asp + U[i]! * ny * t);
  const dl = Math.hypot(...d);
  d = d.map(v => v / dl);
  const E = eye(game);
  let wallT = 4, surf: Hit | null = null, lastTile: Tile | null = null;
  for (let s = 0.02; s < 4; s += 0.02) {
    const x = E[0] + d[0]! * s, y = E[1] + d[1]! * s, z = E[2] + d[2]! * s, f = L.floorAt(x, z);
    if (f == null || y < f || y > CEILY) {
      wallT = s;
      const tl = lastTile, here = L.tileAt(Math.floor(x), Math.floor(-z));
      if (tl) surf = { kind: 'surface', tex: f == null ? tl.wall : y > CEILY ? L.texmap[32]! : (here ?? tl).floor, x, z, tile: tl };
      break;
    }
    lastTile = L.tileAt(Math.floor(x), Math.floor(-z));
  }
  let best: Hit | null = null, bt = wallT;
  for (const sp of L.scene.picks()) {
    const v = [sp.c[0] - E[0], sp.c[1] - E[1], sp.c[2] - E[2]], tt = v[0]! * d[0]! + v[1]! * d[1]! + v[2]! * d[2]!;
    if (tt < 0 || tt > bt + 0.2) continue;
    const q = [v[0]! - d[0]! * tt, v[1]! - d[1]! * tt, v[2]! - d[2]! * tt];
    if (Math.hypot(...q) < sp.r) { bt = tt; best = { kind: 'obj', sp }; }
  }
  for (const dr of L.doors) {
    const panel = L.scene.doorPanel(dr);
    if (!panel) continue;
    const [p0, p1, b, tp] = panel; // vertical plane through p0, p1 (tile coords)
    const ax = p0[0], az = -p0[1], bx = p1[0], bz = -p1[1], nx2 = -(bz - az), nz2 = bx - ax, den = d[0]! * nx2 + d[2]! * nz2;
    if (Math.abs(den) < 1e-6) continue;
    const tt = ((ax - E[0]) * nx2 + (az - E[2]) * nz2) / den;
    if (tt < 0 || tt > bt + 0.05) continue;
    const hx = E[0] + d[0]! * tt, hy = E[1] + d[1]! * tt, hz = E[2] + d[2]! * tt;
    const u = ((hx - ax) * (bx - ax) + (hz - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2);
    if (u >= -0.02 && u <= 1.02 && hy >= b && hy <= tp) { bt = tt; best = { kind: 'door', dr }; }
  }
  return best ?? surf;
}
