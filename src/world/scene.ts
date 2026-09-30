import type { ObjRec } from '../formats';
import { CEIL, CORNER_POS, DIRS, OPP_CORNER, SIDE_CORNERS, objX, objY, sideOpen } from './constants';
import { buildDoors, type DoorPanel, type DoorsOut, type Seg } from './doors';
import type { Level } from './level';
import { W, pushQuad, pushTri, wallQuad, type UV, type Vec3 } from './mesh';
import { buildProps, type Pick, type PropsOut, type Solid } from './props';

/** Floors, ceilings and walls: never changes while the level is loaded. */
export function buildWorldMesh(L: Level): number[] {
  const a: number[] = [];
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const t = L.tileAt(x, y)!;
    if (t.type === 0) continue;
    const cp = CORNER_POS.map(([dx, dy]) => [x + dx, y + dy] as [number, number]);
    let tri: number[] | null = null;
    if (t.type === 2) tri = [0, 1, 2]; else if (t.type === 3) tri = [0, 1, 3]; else if (t.type === 4) tri = [1, 2, 3]; else if (t.type === 5) tri = [0, 2, 3];
    const fl = (i: number): Vec3 => W(cp[i]![0], cp[i]![1], t.c[i]!), ce = (i: number): Vec3 => W(cp[i]![0], cp[i]![1], CEIL), uvf = (i: number): UV => [cp[i]![0], -cp[i]![1]];
    if (tri) {
      pushTri(a, tri.map(fl), tri.map(uvf), t.floor);
      pushTri(a, tri.map(ce), tri.map(uvf), L.texmap[32]!);
      const d = t.type === 2 || t.type === 5 ? [0, 2] : [3, 1];
      wallQuad(a, cp[d[0]!]![0], cp[d[0]!]![1], cp[d[1]!]![0], cp[d[1]!]![1], t.h, t.h, CEIL, CEIL, t.wall);
    } else {
      pushQuad(a, fl(0), fl(1), fl(2), fl(3), [0, 1, 2, 3].map(uvf), t.floor);
      pushQuad(a, ce(0), ce(1), ce(2), ce(3), [0, 1, 2, 3].map(uvf), L.texmap[32]!);
    }
    for (let s = 0; s < 4; s++) {
      if (!sideOpen(t.type, s)) continue;
      const [ca, cb] = SIDE_CORNERS[s]!;
      const a0 = t.c[ca]!, a1 = t.c[cb]!;
      const nb = L.tileAt(x + DIRS[s]![0], y + DIRS[s]![1]);
      let t0 = CEIL, t1 = CEIL;
      if (nb && sideOpen(nb.type, (s + 2) & 3)) {
        const [na, nbb] = OPP_CORNER[s]!;
        t0 = Math.max(a0, nb.c[na]!); t1 = Math.max(a1, nb.c[nbb]!);
        if (t0 <= a0 && t1 <= a1) continue;
      }
      wallQuad(a, cp[ca]![0], cp[ca]![1], cp[cb]![0], cp[cb]![1], a0, a1, t0, t1, t.wall);
    }
  }
  return a;
}

/** Billboards for loose objects (and NPCs without animation frames), with their pick targets. */
export function buildObjectSprites(L: Level): { mesh: number[]; picks: Pick[] } {
  const D = L.data, a: number[] = [], picks: Pick[] = [];
  const animated = new Set(L.critters.map(c => c.o));
  for (const o of L.objs) {
    const im = D.objImgs[o.id];
    if (!im || animated.has(o)) continue;
    const npc = o.id >= 0x40 && o.id < 0x80, sc = npc ? 3 : 1;
    const w = (im.w / 64) * sc, h = (im.h / 64) * sc, X = objX(o), Y = objY(o);
    const fh = L.floorAt(X, -Y);
    let wy = o.z / 32;
    if (fh != null && wy < fh) wy = fh;
    const c: Vec3 = [X, wy, -Y], layer = D.objBase + o.id, u = (im.w - 0.02) / 64, v = (im.h - 0.02) / 64;
    const V = [[-w / 2, 0, 0, v], [w / 2, 0, u, v], [w / 2, h, u, 0], [-w / 2, 0, 0, v], [w / 2, h, u, 0], [-w / 2, h, 0, 0]];
    for (const q of V) a.push(c[0], c[1], c[2], q[0]!, q[1]!, q[2]!, q[3]!, layer);
    picks.push({ o, c: [X, wy + h / 2, -Y], r: Math.max(w, h) / 2 + 0.05, npc });
  }
  return { mesh: a, picks };
}

/**
 * Derived, renderable state of a level, split by how often it changes:
 *   world    floors/walls/ceilings                  built once per load
 *   fixed    furniture, models, fixed decals, solids  built once per load (or after a conversation reshapes the level)
 *   dynamic  doors, levers, switches, buttons        rebuilt when one of them changes state
 *   sprites  loose objects                          rebuilt when things are taken, dropped or moved
 * Each part carries a version the renderer compares against what it last uploaded.
 */
export class LevelScene {
  world: number[] = [];
  fixed: PropsOut = { mesh: [], models: [], solids: [], picks: [] };
  dynamic: PropsOut & { doors: DoorsOut } = { mesh: [], models: [], solids: [], picks: [], doors: { mesh: [], segs: [], panels: new Map() } };
  sprites: { mesh: number[]; picks: Pick[] } = { mesh: [], picks: [] };
  readonly version = { world: 0, fixed: 0, dynamic: 0, sprites: 0, critters: 0 };
  private propPicks: Pick[] | null = null;

  constructor(private readonly L: Level) {}

  /** Everything (after load, or when a conversation changed objects in ways we don't track). */
  rebuildAll(): void {
    this.world = buildWorldMesh(this.L); this.version.world++;
    this.rebuildFixed(); this.rebuildSprites(); this.rebuildDynamic();
  }
  rebuildFixed(): void { this.fixed = buildProps(this.L.data, this.L, false); this.propPicks = null; this.version.fixed++; }
  rebuildDynamic(): void {
    const p = buildProps(this.L.data, this.L, true), doors = buildDoors(this.L.data, this.L);
    this.dynamic = { ...p, mesh: [...doors.mesh, ...p.mesh], doors };
    this.propPicks = null; this.version.dynamic++;
  }
  rebuildSprites(): void {
    this.sprites = buildObjectSprites(this.L);
    for (const c of this.L.critters) { // an animated creature's pick follows it (the renderer refreshes the centre each frame)
      const X = objX(c.o), Y = objY(c.o), fh = this.L.floorAt(X, -Y) ?? c.o.z / 32;
      c.pick.c = [X, fh + 0.4, -Y];
    }
    this.version.sprites++;
  }

  get solids(): Solid[] { return this.fixed.solids; }
  get doorSegs(): Seg[] { return this.dynamic.doors.segs; }
  doorPanel(d: ObjRec): DoorPanel | undefined { return this.dynamic.doors.panels.get(d); }

  /** Pick targets in the original's order: creatures, loose objects, then props in level order. */
  picks(): Pick[] {
    if (!this.propPicks) this.propPicks = [...this.fixed.picks, ...this.dynamic.picks].sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));
    return [...this.L.critters.map(c => c.pick), ...this.sprites.picks, ...this.propPicks];
  }
}
