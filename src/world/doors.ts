import type { ObjRec } from '../formats';
import type { GameData } from '../data/gamedata';
import { CEIL, HU } from './constants';
import type { Level } from './level';
import { W, pushQuad, wallQuad } from './mesh';

// Doors 0x140-0x14f: +8 = open, &7 == 7 secret, &7 == 6 portcullis. A door sits on the tile edge given by fx/fy;
// image = DOORS.GR[doorTex[id & 7]], 32x64 = 0.5 x 1 tile.

export const isDoorOpen = (d: ObjRec): boolean => (d.id & 8) !== 0;
export const isSecretDoor = (d: ObjRec): boolean => (d.id & 7) === 7;

export interface DoorFrame { alongX: boolean; fh: number; pos: number; wall: number; open: boolean; secret: boolean }
/** A door leaf's vertical plane: two ends in tile coords, bottom and top in world units. */
export type DoorPanel = [[number, number], [number, number], number, number];
/** A line in tile coords that blocks movement. */
export type Seg = [[number, number], [number, number]];

export function doorFrame(L: Level, d: ObjRec): DoorFrame {
  const t = L.tileAt(d.tx, d.ty), alongX = (d.hd & 3) === 0; // heading N/S -> plane runs east-west
  const fh = t ? t.h : 12;
  const pos = alongX ? (d.fy === 0 ? 0 : d.fy === 7 ? 1 : (d.fy + 0.5) / 8) : (d.fx === 0 ? 0 : d.fx === 7 ? 1 : (d.fx + 0.5) / 8);
  return { alongX, fh, pos, wall: t ? t.wall : 0, open: isDoorOpen(d), secret: isSecretDoor(d) };
}

export interface DoorsOut { mesh: number[]; segs: Seg[]; panels: Map<ObjRec, DoorPanel> }

/** Door frames, leaves (closed across the gap, or swung open against the hinge) and the segments that block movement. */
export function buildDoors(D: GameData, L: Level): DoorsOut {
  const a: number[] = [], segs: Seg[] = [], panels = new Map<ObjRec, DoorPanel>();
  for (const d of L.doors) {
    const f = doorFrame(L, d);
    const P = (u: number): [number, number] => (f.alongX ? [d.tx + u, d.ty + f.pos] : [d.tx + f.pos, d.ty + 1 - u]);
    const top = f.fh + 4;
    const piece = (u0: number, u1: number, b: number, tp: number, layer: number) => { const p0 = P(u0), p1 = P(u1); wallQuad(a, p0[0], p0[1], p1[0], p1[1], b, b, tp, tp, layer); };
    piece(0, 0.25, f.fh, CEIL, f.wall); piece(0.75, 1, f.fh, CEIL, f.wall);
    if (top < CEIL) piece(0.25, 0.75, top, CEIL, f.wall);
    const dt = f.secret ? f.wall : D.doorBase + Math.min(D.doorImgs.length - 1, L.doorTex[d.id & 7] ?? d.id & 7);
    const s0 = P(0), s1 = P(0.25), s2 = P(0.75), s3 = P(1);
    segs.push([s0, s1], [s2, s3]);
    if (!f.open) {
      const p0 = P(0.25), p1 = P(0.75);
      pushQuad(a, W(p0[0], p0[1], f.fh), W(p1[0], p1[1], f.fh), W(p1[0], p1[1], top), W(p0[0], p0[1], top),
        f.secret ? [[0, 1], [0.5, 1], [0.5, 0], [0, 0]] : [[0, 0.998], [0.498, 0.998], [0.498, 0], [0, 0]], dt);
      segs.push([s1, s2]);
      panels.set(d, [p0, p1, f.fh * HU, top * HU]);
    } else { // swung open against the hinge
      const p0 = P(0.25), n = f.alongX ? [0, 0.5] : [0.5, 0];
      const p1: [number, number] = [p0[0] + n[0]!, p0[1] + n[1]!];
      pushQuad(a, W(p0[0], p0[1], f.fh), W(p1[0], p1[1], f.fh), W(p1[0], p1[1], top), W(p0[0], p0[1], top), [[0, 0.998], [0.498, 0.998], [0.498, 0], [0, 0]], dt);
      panels.set(d, [p0, p1, f.fh * HU, top * HU]);
    }
  }
  return { mesh: a, segs, panels };
}
