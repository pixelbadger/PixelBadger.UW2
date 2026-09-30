import { readCritAnims, readCritPage, type CritFrame, type ObjRec } from '../formats';
import type { GameData } from '../data/gamedata';
import type { Rng } from '../core/rng';
import { CBODY, CPX, CRAD, STEP, objX, objY } from './constants';
import { segDist, solidBlocks, supportAt } from './collision';
import type { Level } from './level';
import type { Pick } from './props';

// Creatures: CRIT sprites (AS.AN picks a critter file and aux palette per NPC id 0x40-0x7f; CR.AN holds 64 animations
// per critter; animation group g at anims g*8..g*8+7 by view direction: 0 idle, 1 walk, 2 combat idle, 3-5 the three
// melee attacks, 6 spell/ranged attack, 7 death). The AI here is a stand-in: amble near the post; a creature the game
// calls hostile closes in and fights (the rules live in game/combat.ts, reached through CritterCtx).

export interface CritSet { key: number; frames: (CritFrame | null)[]; anims: number[][] }

export interface Critter {
  o: ObjRec;
  set: CritSet;
  phase: number;
  /** Position in tile coords (x east, y north), home post, heading (radians, 0 = north, clockwise). */
  x: number; y: number; hx: number; hy: number; ang: number;
  /** Feet height. */
  h: number;
  wait: number;
  tx: number | null; ty: number | null;
  walking: boolean;
  /** A conversation's set_sequence: CR.AN group g, frame f (unverified). */
  seq?: { g: number; f: number };
  /** An animation played once: attack (group 3-5, n = attack 0-2), spell (group 6, n = -1) or death (group 7). */
  act?: { g: number; f: number; t: number; n: number; struck?: boolean };
  /** Dying: the death animation is playing; the game removes the creature when it ends. */
  dying?: boolean;
  /** Attack build-up, 0-15 (the original's swing charge index). */
  swing?: number;
  /** Seconds to the next combat decision; paralysed for this many seconds. */
  aiT?: number;
  para?: number;
  pick: Pick & { crit: Critter };
}

export interface CritterAtlas { AW: number; AH: number; px: Uint8Array; rects: Map<number, [number, number]> }

/** The critter file and aux palette for NPC id, or null (255 = none, or the file is missing). */
export function critterOf(D: GameData, id: number): { num: number; aux: number; key: number } | null {
  const c = D.crit;
  if (!c) return null;
  const k = id - 0x40, num = c.as[k * 2], aux = c.as[k * 2 + 1];
  if (num === undefined || aux === undefined || num === 255) return null;
  const o = num.toString(8).padStart(2, '0');
  if (!c.files[`CRIT/CR${o}.00`]) return null;
  return { num, aux, key: num * 4 + aux };
}

/** All frames (pages merged into the global frame-index space) and animations of one critter + palette. Cached. */
export function critFrames(D: GameData, num: number, aux: number): CritSet {
  const c = D.crit!, key = num * 4 + aux;
  const hit = D.cache.critSets.get(key) as CritSet | undefined;
  if (hit) return hit;
  const o = num.toString(8).padStart(2, '0'), frames: (CritFrame | null)[] = [];
  for (let p = 0; p < 10; p++) {
    const b = c.files[`CRIT/CR${o}.${String(p).padStart(2, '0')}`];
    if (!b) break;
    readCritPage(b, aux).forEach((f, i) => { if (f && !frames[i]) frames[i] = f; });
  }
  const r: CritSet = { key, frames, anims: readCritAnims(c.an, num, f => !!frames[f]) };
  D.cache.critSets.set(key, r);
  return r;
}

/** Creates the level's animated creatures and shelf-packs every frame they use into one atlas. */
export function buildCritters(L: Level, rng: Rng): CritterAtlas | null {
  const D = L.data;
  L.critters = [];
  if (!D.crit) return null;
  const sets = new Map<number, CritSet>();
  for (const o of L.objs) {
    if (o.id < 0x40 || o.id >= 0x80) continue;
    const ci = critterOf(D, o.id);
    if (!ci) continue;
    if (!sets.has(ci.key)) sets.set(ci.key, critFrames(D, ci.num, ci.aux));
    const X = objX(o), Y = objY(o);
    const c = { o, set: sets.get(ci.key)!, phase: rng() * 10, x: X, y: Y, hx: X, hy: Y, ang: (o.hd * Math.PI) / 4, h: o.z / 32, wait: 1 + rng() * 4, tx: null, ty: null, walking: false } as unknown as Critter;
    c.pick = { o, c: [X, 0, -Y], r: 0.35, npc: true, crit: c };
    L.critters.push(c);
  }
  const AW = 1024;
  let x = 0, y = 0, rowH = 0;
  const rects = new Map<number, [number, number]>(), items: [number, number, CritFrame, number, number][] = [];
  for (const [key, set] of sets) set.frames.forEach((f, i) => {
    if (!f) return;
    if (x + f.w + 1 > AW) { x = 0; y += rowH + 1; rowH = 0; }
    items.push([key, i, f, x, y]); x += f.w + 1; rowH = Math.max(rowH, f.h);
  });
  const AH = Math.max(1, Math.min(8192, y + rowH + 1)), px = new Uint8Array(AW * AH);
  for (const [key, i, f, ax, ay] of items) {
    if (ay + f.h > AH) continue;
    for (let r = 0; r < f.h; r++) px.set(f.px.subarray(r * f.w, r * f.w + f.w), (ay + r) * AW + ax);
    rects.set(key * 1000 + i, [ax, ay]);
  }
  return { AW, AH, px, rects };
}

/** Puts each creature on whatever is under it (a table, a bed) now that props are solid. */
export function settleCritters(L: Level): void {
  for (const c of L.critters) { const fl = L.floorAt(c.x, -c.y); c.h = supportAt(L, c.x, c.y, Math.max(fl ?? 0, c.o.z / 32)) ?? c.o.z / 32; }
}

/** The frame to show for a creature seen from (camX, camY) at time t (seconds), or null. */
export function critterFrame(c: Critter, camX: number, camY: number, time: number): { f: CritFrame; fi: number } | null {
  const rel = Math.round((Math.atan2(camX - c.x, camY - c.y) - c.ang) / (Math.PI / 4));
  const dir = (((4 - rel) % 8) + 8) % 8; // 4 = facing the viewer
  const A = c.set.anims;
  if (c.act) {
    const l = A[c.act.g * 8 + dir]?.length ? A[c.act.g * 8 + dir]! : A[c.act.g * 8 + 4]?.length ? A[c.act.g * 8 + 4]! : A[dir]?.length ? A[dir]! : A[4];
    if (!l || !l.length) return null;
    const fi = l[Math.min(c.act.f, l.length - 1)]!, f = c.set.frames[fi];
    return f ? { f, fi } : null;
  }
  const seqList = c.seq ? A[c.seq.g * 8 + dir] : undefined;
  let list = c.seq ? seqList : c.walking ? A[8 + dir] : A[dir];
  if (!list || !list.length) list = A[dir];
  if (!list || !list.length) list = A[4];
  if (!list || !list.length) return null;
  const fi = c.seq && list === seqList ? list[c.seq.f % list.length]! : list[Math.floor(time * 5 + c.phase) % list.length]!;
  const f = c.set.frames[fi];
  return f ? { f, fi } : null;
}

export interface CritterCtx {
  rng: Rng;
  /** Player position in tile coords. */
  px: number; py: number;
  /** Is this creature fighting the Avatar? (The game may turn it hostile here: it saw the Avatar.) */
  hostile(c: Critter, dist: number): boolean;
  /** Which melee attack (0-2) to make, or -1 to cast/shoot instead (checked when out of reach too). */
  pickAttack(c: Critter, dist: number): number;
  /** The attack animation reached its striking frame: n = attack 0-2, or -1 for a spell or missile. */
  onStrike(c: Critter, n: number): void;
  /** The death animation ended. */
  onDead(c: Critter): void;
}

/** Seconds per frame of a one-shot animation; the frame a melee attack lands on (UW2: 3, or the last if shorter). */
export const ACT_FRAME = 0.15, HIT_FRAME = 3;
/** Distance (tiles, centre to centre) at which a creature strikes. */
export const MELEE_REACH = 0.85;

/** Frames in animation group g as seen from the front (at least 1). */
export function actLength(c: Critter, g: number): number {
  const A = c.set.anims;
  return Math.max(1, A[g * 8 + 4]?.length || A[g * 8]?.length || 1);
}

/** Starts a one-shot animation. */
export function startAct(c: Critter, g: number, n = 0): void { c.act = { g, f: 0, t: 0, n }; c.walking = false; }

function stepAct(c: Critter, dt: number, ctx: CritterCtx): void {
  const a = c.act!, len = actLength(c, a.g);
  a.t += dt;
  while (a.t >= ACT_FRAME && c.act === a) {
    a.t -= ACT_FRAME; a.f++;
    if (a.g >= 3 && a.g <= 6 && !a.struck && (a.f === HIT_FRAME || (len - 1 < HIT_FRAME && a.f >= len - 1))) { a.struck = true; ctx.onStrike(c, a.n); }
    if (a.f >= len) {
      if (a.g === 7) { a.f = len - 1; ctx.onDead(c); return; }
      c.act = undefined;
    }
  }
}

function critterFree(L: Level, c: Critter, x: number, y: number, ctx: CritterCtx): boolean {
  const f = supportAt(L, x, y, c.h);
  if (f == null || Math.abs(f - c.h) > STEP) return false;
  if (solidBlocks(L, x, y, CRAD, c.h, CBODY)) return false;
  for (const k of [[0.18, 0], [-0.18, 0], [0, 0.18], [0, -0.18]] as const) if (L.floorAt(x + k[0], -(y + k[1])) == null) return false;
  if (Math.hypot(x - ctx.px, y - ctx.py) < 0.45) return false;
  for (const [p, q] of L.scene.doorSegs) if (segDist(p, q, x, y) < 0.2) return false;
  for (const d of L.critters) if (d !== c && Math.hypot(d.x - x, d.y - y) < 0.4) return false;
  return true;
}

/** A hostile creature: close in, then build up and strike (the original's goal 5 in outline, at 4 decisions a second). */
function fight(L: Level, c: Critter, dt: number, ctx: CritterCtx, d: number): void {
  const dx = ctx.px - c.x, dy = ctx.py - c.y;
  c.ang = Math.atan2(dx, dy);
  c.aiT = (c.aiT ?? 0) - dt;
  const decide = c.aiT <= 0;
  if (decide) c.aiT = 0.25;
  if (d <= MELEE_REACH) {
    c.walking = false;
    if (!decide) return;
    if (ctx.rng() < 0.25) { const n = ctx.pickAttack(c, d); startAct(c, n < 0 ? 6 : 3 + n, n); }
    else c.swing = Math.min(15, (c.swing ?? 0) + 1);
    return;
  }
  if (decide && ctx.rng() < 0.15 && ctx.pickAttack(c, d) < 0) { startAct(c, 6, -1); return; }
  if (d > 12) { c.walking = false; return; }
  const sp = Math.min(d - MELEE_REACH * 0.9, 1.1 * dt), nx = c.x + (dx / d) * sp, ny = c.y + (dy / d) * sp, f = supportAt(L, nx, ny, c.h);
  if (f != null && Math.abs(f - c.h) <= STEP && !solidBlocks(L, nx, ny, CRAD, c.h, CBODY) && L.floorAt(nx, -ny) != null) { c.x = nx; c.y = ny; c.h = f; c.walking = true; }
  else c.walking = false;
}

/** Creatures amble around their post: a stand-in until the game's AI is ported. Hostile ones close in. */
export function updateCritters(L: Level, dt: number, ctx: CritterCtx): void {
  const rng = ctx.rng;
  for (const c of [...L.critters]) {
    if (c.act) { stepAct(c, dt, ctx); continue; }
    if (c.dying) continue;
    if (c.para && c.para > 0) { c.para = Math.max(0, c.para - dt); c.walking = false; continue; }
    const pd = Math.hypot(ctx.px - c.x, ctx.py - c.y);
    if (ctx.hostile(c, pd)) { fight(L, c, dt, ctx, pd); continue; }
    if (c.wait > 0) {
      c.wait -= dt; c.walking = false;
      if (c.wait <= 0) { const a = rng() * Math.PI * 2, r = 0.4 + rng() * 1.4; c.tx = c.hx + Math.sin(a) * r; c.ty = c.hy + Math.cos(a) * r; }
      continue;
    }
    const dx = c.tx! - c.x, dy = c.ty! - c.y, d = Math.hypot(dx, dy);
    if (d < 0.05) { c.wait = 2 + rng() * 5; continue; }
    const sp = Math.min(d, 0.55 * dt), nx = c.x + (dx / d) * sp, ny = c.y + (dy / d) * sp;
    c.ang = Math.atan2(dx, dy);
    if (critterFree(L, c, nx, ny, ctx)) { c.x = nx; c.y = ny; c.h = supportAt(L, nx, ny, c.h)!; c.walking = true; }
    else { c.wait = 1 + rng() * 3; c.walking = false; }
  }
}

/** Billboard quads (stride 8) for every creature; also moves each creature's pick target onto its current frame. */
export function critterQuads(L: Level, atlas: CritterAtlas, camX: number, camY: number, time: number): number[] {
  const a: number[] = [], { AW, AH, rects } = atlas;
  for (const c of L.critters) {
    const X = c.x, Y = c.y, wy = c.h ?? L.floorAt(X, -Y) ?? c.o.z / 32;
    const fr = critterFrame(c, camX, camY, time);
    if (!fr) continue;
    const { f, fi } = fr, r = rects.get(c.set.key * 1000 + fi);
    if (!r) continue;
    const x0 = -f.hx * CPX, x1 = (f.w - f.hx) * CPX, y0 = -(f.h - f.hy) * CPX, y1 = f.hy * CPX;
    const u0 = r[0] / AW, u1 = (r[0] + f.w) / AW, v0 = r[1] / AH, v1 = (r[1] + f.h) / AH;
    for (const q of [[x0, y0, u0, v1], [x1, y0, u1, v1], [x1, y1, u1, v0], [x0, y0, u0, v1], [x1, y1, u1, v0], [x0, y1, u0, v0]]) a.push(X, wy, -Y, q[0]!, q[1]!, q[2]!, q[3]!, 0);
    c.pick.c = [X, wy + y1 * 0.55, -Y];
  }
  return a;
}
