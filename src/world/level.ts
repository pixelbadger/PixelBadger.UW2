import { decodeLevel, type MoveTrigger, type ObjRec, type Tile } from '../formats';
import type { GameData } from '../data/gamedata';
import { HU } from './constants';
import type { Critter } from './creatures';
import { LevelScene } from './scene';
import { isProp } from './props';

/** What survives leaving a level: its mutable object lists (doors, levers, things taken or dropped). */
export interface LevelSnapshot { objs: ObjRec[]; doors: ObjRec[]; props: ObjRec[] }

/**
 * One loaded level: decoded tiles plus the mutable object lists, creatures and the derived scene (geometry,
 * collision shapes, pick targets). Mutations go through the owning systems, which then mark the scene dirty.
 */
export class Level {
  readonly n: number;
  readonly tiles: Tile[];
  readonly texmap: number[];
  readonly doorTex: number[];
  readonly triggers: Map<number, MoveTrigger>;
  /** Every object on the level as first decoded (writing and gravestones are looked up here). */
  readonly all: ObjRec[];
  objs: ObjRec[];
  doors: ObjRec[];
  props: ObjRec[];
  /** Bridge tops by tile index: they raise the walkable floor. */
  readonly bridges = new Map<number, number>();
  critters: Critter[] = [];
  readonly scene: LevelScene;

  constructor(readonly data: GameData, n: number, snapshot?: LevelSnapshot) {
    const L = data.levels[n];
    if (!L) throw new Error(`There is no level ${n} on this disc.`);
    const d = decodeLevel(L, data.levels[80 + n], n, id => isProp(data, id));
    this.n = n; this.tiles = d.tiles; this.texmap = d.texmap; this.doorTex = d.doorTex; this.triggers = d.triggers; this.all = d.all;
    // changes made earlier (doors, levers, things taken or dropped) replace the pristine lists
    this.objs = snapshot ? snapshot.objs : d.objs;
    this.doors = snapshot ? snapshot.doors : d.doors;
    this.props = snapshot ? snapshot.props : d.props;
    for (const o of d.props) if (o.id === 0x164) this.bridges.set(o.ty * 64 + o.tx, o.z / 32 + 0.03);
    this.scene = new LevelScene(this);
  }

  snapshot(): LevelSnapshot { return { objs: this.objs, doors: this.doors, props: this.props }; }

  tileAt(x: number, y: number): Tile | null { return x < 0 || y < 0 || x > 63 || y > 63 ? null : this.tiles[y * 64 + x]!; }

  /** Floor height at world (x, z), or null inside rock (including the closed half of a diagonal tile). */
  floorAt(wx: number, wz: number): number | null {
    const X = wx, Y = -wz, tx = Math.floor(X), ty = Math.floor(Y);
    const t = this.tileAt(tx, ty);
    if (!t || t.type === 0) return null;
    const fx = X - tx, fy = Y - ty;
    if (t.type === 2 && fx < fy) return null;
    if (t.type === 5 && fx > fy) return null;
    if (t.type === 3 && fx + fy > 1) return null;
    if (t.type === 4 && fx + fy < 1) return null;
    const c = t.c;
    const s = c[0] * (1 - fx) + c[1] * fx, nrt = c[3] * (1 - fx) + c[2] * fx;
    const f = (s * (1 - fy) + nrt * fy) * HU;
    const b = this.bridges.get(ty * 64 + tx);
    return b != null && b > f ? b : f;
  }

  /** Is (x, y) an open tile of this level? */
  open(x: number, y: number): boolean { const t = this.tileAt(x, y); return !!t && t.type !== 0; }
}
