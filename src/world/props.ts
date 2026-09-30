import type { ObjRec } from '../formats';
import type { GameData } from '../data/gamedata';
import { CEILY, objX, objY } from './constants';
import type { Critter } from './creatures';
import type { Level } from './level';
import { propBox, propCyl, pushQuad, type Vec3 } from './mesh';

// Furniture, wall decals and other fixed things. Real furniture comes from UW2.EXE's models; without the executable,
// hand-built stand-ins with the game's own textures take their place.

/** Something the player can point at. */
export interface Pick {
  o: ObjRec;
  /** Centre (world). */
  c: Vec3;
  r: number;
  npc?: boolean;
  prop?: boolean;
  decal?: boolean;
  /** The animated creature behind an NPC pick. */
  crit?: Critter;
  /** Order among the level's props (keeps pick ties stable across static and dynamic rebuilds). */
  ord?: number;
}

/** A model's collision height grid: 1/16-tile cells in model space, lo/hi per cell. */
export interface ModelGrid { x0: number; y0: number; nx: number; ny: number; cs: number; lo: Float32Array; hi: Float32Array; R: number }

/** Plan-view collision shapes in tile coords (x east, y north) with bottom b and top t in world units. */
export type Solid =
  | { kind: 'box'; o: ObjRec; x: number; y: number; hx: number; hz: number; c: number; s: number; b: number; t: number }
  | { kind: 'cyl'; o: ObjRec; x: number; y: number; r: number; b: number; t: number }
  | { kind: 'model'; o: ObjRec; x: number; y: number; c: number; s: number; g: ModelGrid; R: number; b: number };

export const STANDIN_IDS = new Set([0x150, 0x158, 0x15b, 0x15c, 0x15e, 0x160, 0x164, 0x167, 0x169, 0x16e, 0x16f, ...Array.from({ length: 16 }, (_, i) => 0x170 + i)]);
/** Object id -> UW2.EXE model number (Underworld Adventures' uw2 model3d.cfg). */
export const MODEL_OF: Record<number, number> = { 0x150: 3, 0x153: 7, 0x154: 7, 0x155: 6, 0x156: 5, 0x157: 0xb, 0x158: 0x18, 0x159: 9, 0x15a: 0x17, 0x15b: 0x1b, 0x15c: 0x1c, 0x15d: 0x19, 0x15e: 0x1a, 0x15f: 4, 0x160: 0xa, 0x163: 0xd, 0x165: 0x13, 0x167: 0x1d, 0x168: 0x1e, 0x169: 0x1f };
/** Models you walk through: beam, painting, moongate. */
export const NONSOLID = new Set([0x09, 0x0d, 0x17]);
const TX = { wood: 0x22, dark: 0x20, red: 0x5a, cloth: 0xd3, stone: 0xde };

export const isProp = (D: GameData, id: number): boolean =>
  STANDIN_IDS.has(id) || (!!D.models && MODEL_OF[id] != null) || (D.tmoImgs.length > 0 && (id === 0x161 || id === 0x162 || id === 0x166));

/** Props whose look changes in play (levers, switches, buttons): rebuilt with the doors, not with the static scene. */
export const isDynamicProp = (id: number): boolean => id === 0x161 || id === 0x162 || (id >= 0x170 && id < 0x180);

/**
 * Textured model faces take a TMOBJ.GR image chosen by the object's flags. Paintings/gravestones are clear from the
 * images; table/chair/shelf choices are a best reading of the image set, NOT verified.
 */
function modelTex(D: GameData, o: ObjRec, n: number): number {
  if (!D.tmoImgs.length) return -1;
  const b = D.tmoBase, f = o.fl;
  if (n === 0x0d) return b + 42 + Math.min(5, f);
  if (n === 0x13) return b + 28 + (f & 1);
  if (n === 0x18) return b + 30 + (f & 3);
  if (n === 0x1c) return b + 38 + (f & 3);
  if (n === 0x1f) return b + 36;
  return -1;
}

/** Collision grid for model n: every triangle sampled into 1/16-tile cells. Cached on the game data. */
export function modelGrid(D: GameData, n: number): ModelGrid {
  const cached = D.cache.grids.get(n) as ModelGrid | undefined;
  if (cached) return cached;
  const M = D.models![n]!, cs = 1 / 16;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const t of M.tris) for (const v of t.p) { x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]); y0 = Math.min(y0, v[1]); y1 = Math.max(y1, v[1]); }
  const nx = Math.max(1, Math.min(256, Math.ceil((x1 - x0) / cs))), ny = Math.max(1, Math.min(256, Math.ceil((y1 - y0) / cs)));
  const lo = new Float32Array(nx * ny).fill(1e9), hi = new Float32Array(nx * ny).fill(-1e9);
  for (const t of M.tris) {
    const [a, b, c] = t.p;
    const z = (v: number[]) => (v[3] ? 9 : v[2]!);
    const ln = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - a[0], c[1] - a[1]), Math.hypot(c[0] - b[0], c[1] - b[1]), Math.abs(z(a) - z(b)) * 0.05);
    const N = Math.min(48, Math.ceil(ln / (cs * 0.5)) + 1);
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N - i; j++) {
      const u = i / N, w = j / N, r = 1 - u - w;
      const x = a[0] * r + b[0] * u + c[0] * w, y = a[1] * r + b[1] * u + c[1] * w, h = z(a) * r + z(b) * u + z(c) * w;
      const k = Math.max(0, Math.min(ny - 1, Math.floor((y - y0) / cs))) * nx + Math.max(0, Math.min(nx - 1, Math.floor((x - x0) / cs)));
      if (h < lo[k]!) lo[k] = h;
      if (h > hi[k]!) hi[k] = h;
    }
  }
  const g: ModelGrid = { x0, y0, nx, ny, cs, lo, hi, R: Math.max(...[[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(q => Math.hypot(q[0]!, q[1]!))) };
  D.cache.grids.set(n, g);
  return g;
}

/** Output of a props pass. */
export interface PropsOut {
  /** Stride-6 geometry (stand-ins, decals, wall texture objects). */
  mesh: number[];
  /** Stride-7 model geometry. */
  models: number[];
  solids: Solid[];
  picks: Pick[];
}

const SHL = [0.42, 0.82, 0.38], SHN = Math.hypot(...SHL);

/**
 * Places model n for object o: heading h turns it clockwise by h*45deg (heading 0 = model +x faces east; checked
 * against 31 chair/table pairs, chairs face their tables). Faces are flat palette colours, shaded per face by a fixed light.
 */
function emitModel(D: GameData, o: ObjRec, ord: number, n: number, X: number, Y: number, f: number | null, out: PropsOut): void {
  const M = D.models![n]!, th = (o.hd * Math.PI) / 4, c = Math.cos(th), s = Math.sin(th);
  let base = o.z / 32;
  if (f != null && base < f) base = f;
  let tl = modelTex(D, o, n), im = tl >= 0 ? D.tmoImgs[tl - D.tmoBase] ?? null : null;
  const W3 = (v: number[]): Vec3 => { const x = X + v[0]! * c + v[1]! * s, y = Y - v[0]! * s + v[1]! * c; return [x, v[3] ? CEILY : base + v[2]!, -y]; };
  let zl = 1e9, zh = -1e9;
  for (const t of M.tris) {
    const p = t.p.map(W3);
    const e1 = [p[1]![0] - p[0]![0], p[1]![1] - p[0]![1], p[1]![2] - p[0]![2]], e2 = [p[2]![0] - p[0]![0], p[2]![1] - p[0]![1], p[2]![2] - p[0]![2]];
    const nn = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!], nl = Math.hypot(...nn) || 1;
    const sh = (1 - Math.abs(nn[0]! * SHL[0]! + nn[1]! * SHL[1]! + nn[2]! * SHL[2]!) / (nl * SHN)) * 1.3;
    let tx = t.tex >= 0 && !!im && !!t.uv;
    let uvs: number[][] | null = t.uv;
    const pim = D.tmoImgs[o.fl & 3];
    if (n === 0x0a && pim) { // pillars: untextured in the model, wrapped here with TMOBJ.GR 0-3 (8x32) by flags
      const alongX = Math.abs(nn[0]! * c - nn[2]! * s) < Math.abs(nn[0]! * s + nn[2]! * c);
      tx = true; tl = D.tmoBase + (o.fl & 3); im = pim;
      uvs = t.p.map((v, k) => [((alongX ? v[0] : v[1]) + 0.0625) / 0.125, 1 - (p[k]![1] - base) / Math.max(0.5, CEILY - base)]);
    }
    for (let k = 0; k < 3; k++) {
      zl = Math.min(zl, p[k]![1]); zh = Math.max(zh, p[k]![1]);
      if (tx && im && uvs) out.models.push(p[k]![0], p[k]![1], p[k]![2], (Math.max(0, Math.min(1, uvs[k]![0]!)) * (im.w - 0.02)) / 64, (Math.max(0, Math.min(1, uvs[k]![1]!)) * (im.h - 0.02)) / 64, tl, sh);
      else out.models.push(p[k]![0], p[k]![1], p[k]![2], ((t.pal & 63) + 0.5) / 64, ((t.pal >> 6) + 0.5) / 64, D.palLayer, sh);
    }
  }
  const g = modelGrid(D, n), mx = g.x0 + (g.nx * g.cs) / 2, my = g.y0 + (g.ny * g.cs) / 2;
  out.picks.push({ o, ord, c: [X + mx * c + my * s, (zl + Math.min(zh, zl + 1.2)) / 2, -(Y - mx * s + my * c)], r: Math.max(0.15, Math.min(0.6, Math.max(g.nx, g.ny) * g.cs * 0.45)), prop: true });
  if (!NONSOLID.has(n)) out.solids.push({ kind: 'model', o, x: X, y: Y, c, s, g, R: g.R, b: base });
}

/** Builds the level's props: `dynamic` false = everything fixed; true = levers, switches and buttons only. */
export function buildProps(D: GameData, L: Level, dynamic: boolean): PropsOut {
  const out: PropsOut = { mesh: [], models: [], solids: [], picks: [] }, a = out.mesh;
  L.props.forEach((o, ord) => {
    if (isDynamicProp(o.id) !== dynamic) return;
    const t = L.tileAt(o.tx, o.ty);
    if (!t) return;
    const X = objX(o), Y = objY(o), f = L.floorAt(X, -Y);
    const base = o.id === 0x164 ? o.z / 32 : (f ?? o.z / 32);
    const ang = (-o.hd * Math.PI) / 4, cx = X, cz = -Y, id = o.id;
    const pick = (y: number, r: number) => out.picks.push({ o, ord, c: [cx, base + y, cz], r, prop: true });
    const box = (sx: number, sz: number, b: number, tp: number) => out.solids.push({ kind: 'box', o, x: X, y: Y, hx: sx / 2, hz: sz / 2, c: Math.cos(ang), s: Math.sin(ang), b, t: tp });
    const cyl = (r: number, b: number, tp: number) => out.solids.push({ kind: 'cyl', o, x: X, y: Y, r, b, t: tp });
    const mn = D.models ? MODEL_OF[id] : undefined;
    if (mn !== undefined && D.models![mn] && D.models![mn]!.tris.length) { emitModel(D, o, ord, mn, X, Y, f, out); return; }
    if (!STANDIN_IDS.has(id) && id !== 0x161 && id !== 0x162 && id !== 0x166) return;
    const c = Math.cos(ang), s = Math.sin(ang);
    if (id === 0x158) { // table
      propBox(a, cx, base + 0.3, cz, 0.62, 0.05, 0.62, ang, TX.wood);
      for (const [lx, lz] of [[-0.26, -0.26], [0.26, -0.26], [0.26, 0.26], [-0.26, 0.26]] as const) propBox(a, cx + lx * c - lz * s, base, cz + lx * s + lz * c, 0.05, 0.3, 0.05, ang, TX.dark);
      pick(0.3, 0.35); box(0.62, 0.62, base, base + 0.35);
    } else if (id === 0x150) { // bench
      propBox(a, cx, base + 0.18, cz, 0.7, 0.05, 0.22, ang, TX.wood);
      for (const lx of [-0.3, 0.3]) propBox(a, cx + lx * c, base, cz + lx * s, 0.05, 0.18, 0.2, ang, TX.dark);
      pick(0.18, 0.35); box(0.7, 0.22, base, base + 0.23);
    } else if (id === 0x15c) { // chair
      propBox(a, cx, base + 0.18, cz, 0.24, 0.04, 0.24, ang, TX.wood);
      for (const [lx, lz] of [[-0.1, -0.1], [0.1, -0.1], [0.1, 0.1], [-0.1, 0.1]] as const) propBox(a, cx + lx * c - lz * s, base, cz + lx * s + lz * c, 0.035, 0.18, 0.035, ang, TX.dark);
      propBox(a, cx + 0.11 * s, base + 0.22, cz - 0.11 * c, 0.24, 0.26, 0.035, ang, TX.wood);
      pick(0.2, 0.2); box(0.26, 0.26, base, base + 0.48);
    } else if (id === 0x15e) { propBox(a, cx, base, cz, 0.3, 0.3, 0.3, ang, TX.wood); pick(0.15, 0.2); box(0.3, 0.3, base, base + 0.3); }
    else if (id === 0x15b) { propCyl(a, cx, base, cz, 0.15, 0.38, 10, TX.wood); pick(0.19, 0.2); cyl(0.15, base, base + 0.38); }
    else if (id === 0x167) { propBox(a, cx, base, cz, 0.55, 0.16, 0.95, ang, TX.dark); propBox(a, cx, base + 0.16, cz, 0.5, 0.06, 0.88, ang, TX.red); pick(0.15, 0.45); box(0.55, 0.95, base, base + 0.22); }
    else if (id === 0x169) { propBox(a, cx, o.z / 32, cz, 0.9, 0.04, 0.25, ang, TX.wood); pick(o.z / 32 - base, 0.3); box(0.9, 0.25, o.z / 32, o.z / 32 + 0.04); }
    else if (id === 0x160) { propCyl(a, cx, base, cz, 0.1, CEILY - base, 8, t.wall); pick(0.5, 0.15); cyl(0.1, base, CEILY); }
    else if (id === 0x164) { // bridge
      const bl = o.fl < 2 ? (D.tmoImgs.length ? D.tmoBase + 30 + o.fl : TX.wood) : L.texmap[o.fl - 2 + 48]!;
      propBox(a, o.tx + 0.5, base - 0.06, -(o.ty + 0.5), 1, 0.09, 1, 0, bl);
    } else { // flat things fixed to a wall: texture-map objects, buttons, switches, levers, pull chains, writing
      const an = (o.hd * Math.PI) / 4, nx = Math.sin(an), ny = Math.cos(an), tx = Math.cos(an), ty = -Math.sin(an);
      const full = id === 0x16e || id === 0x16f;
      let layer: number, w: number, h: number, bottom: number, ex: number, ey: number;
      if (full) { layer = L.texmap[o.own]!; w = 1; h = 1; bottom = o.z / 32; ex = o.tx + 0.5 + nx * 0.495; ey = o.ty + 0.5 + ny * 0.495; }
      else {
        const tm = id === 0x161 ? 4 + (o.fl & 7) : id === 0x162 ? 12 + (o.fl & 7) : id === 0x166 ? 20 + (o.fl & 7) : -1; // levers, switches, writing: TMOBJ.GR
        if (tm >= 0) { if (!D.tmoImgs.length) return; layer = D.tmoBase + tm; }
        else { if (!D.tmImgs.length) return; layer = D.tmBase + Math.min(D.tmImgs.length - 1, id - 0x170); }
        w = h = 0.25; bottom = o.z / 32 - 0.125;
        const px = o.fx === 0 ? 0 : o.fx === 7 ? 1 : (o.fx + 0.5) / 8, py = o.fy === 0 ? 0 : o.fy === 7 ? 1 : (o.fy + 0.5) / 8;
        ex = o.tx + px - nx * 0.005; ey = o.ty + py - ny * 0.005;
        if (Math.abs(nx) > 0.5) ex = o.tx + (nx > 0 ? 1 : 0) - nx * 0.005;
        if (Math.abs(ny) > 0.5) ey = o.ty + (ny > 0 ? 1 : 0) - ny * 0.005;
      }
      const p0 = [ex - (tx * w) / 2, ey - (ty * w) / 2], p1 = [ex + (tx * w) / 2, ey + (ty * w) / 2];
      const v = full ? 1 : 15.98 / 64, u = full ? 1 : 15.98 / 64;
      pushQuad(a, [p0[0]!, bottom, -p0[1]!], [p1[0]!, bottom, -p1[1]!], [p1[0]!, bottom + h, -p1[1]!], [p0[0]!, bottom + h, -p0[1]!], [[0, v], [u, v], [u, 0], [0, 0]], layer);
      if (!full) out.picks.push({ o, ord, c: [ex, bottom + h / 2, -ey], r: 0.18, decal: true, prop: true });
    }
  });
  return out;
}
