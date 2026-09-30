import type { ObjRec } from '../formats';
import { S1, nameOf } from '../data/text';
import { objX, objY } from '../world/constants';
import { solidBlocks, supportAt } from '../world/collision';
import { isDoorOpen, isSecretDoor } from '../world/doors';
import type { Game } from './game';
import { portable, type SlotKey } from './inventory';
import { eye, pick, type Hit } from './picking';
import { startTalk } from './talk';
import { sleep } from './cutscenes';

// The command modes (use, look, get, talk, fight) acting on what the Avatar points at.

/** Wall writing, signs and gravestones (block 8, link - 0x200): short lines go to the scroll, long ones open a sheet. */
function readWriting(game: Game, o: ObjRec): boolean {
  if (!(o.isq && o.link >= 0x200)) return false;
  const t = game.data.block(8)[o.link - 0x200];
  if (!t) return false;
  showWords(game, t.trim());
  return true;
}

function showWords(game: Game, x: string): void {
  if (x.length < 70 && !x.includes('\n')) game.say(`“${x}”`);
  else game.ui.showText(x);
}

/** Books and scrolls (block 3), writing, or the object's name. */
export function describe(game: Game, o: ObjRec): void {
  const D = game.data;
  if (o.id >= 0x130 && o.id < 0x140 && o.isq && o.link >= 0x200) {
    const t = D.block(3)[o.link - 0x200];
    if (t != null) { game.ui.showText(t.trim() || 'The pages are blank.', nameOf(D, o.id)); return; }
  }
  if ((o.id === 0x165 || o.id === 0x166) && readWriting(game, o)) return;
  game.say(`You see ${nameOf(D, o.id)}.`);
}

/** Use (or look at) whatever is under screen point (nx, ny). */
export function use(game: Game, nx: number, ny: number, look = false): void {
  const D = game.data, L = game.L, h = pick(game, nx, ny);
  if (!h) { game.say(S1(D, 168)); return; }
  if (look && h.kind === 'door') { game.say(`You see ${nameOf(D, h.dr.id & ~8)}.`); return; }
  if (h.kind === 'door') {
    const d = h.dr;
    if (isSecretDoor(d) && !isDoorOpen(d)) { d.id |= 8; game.say('You found a secret door.'); }
    else { d.id ^= 8; game.say(isDoorOpen(d) ? 'The door opens.' : 'The door closes.'); }
    game.refreshDynamic();
    if (game.blocked(game.pose.x, game.pose.z, game.pose.y)) { d.id ^= 8; game.refreshDynamic(); game.say('Something is in the way.'); }
    return;
  }
  if (h.kind === 'surface') {
    // writing and gravestones sit against walls as invisible objects
    const X = h.x, Y = -h.z;
    let text: string | null = null;
    for (const o of L.all) {
      if (o.id !== 0x166 && o.id !== 0x165) continue;
      const ox = objX(o), oy = objY(o);
      if ((L.tiles[o.ty * 64 + o.tx] === h.tile || Math.hypot(ox - X, oy - Y) < 0.75) && Math.hypot(ox - X, oy - Y) < 1.3 && o.isq && o.link >= 0x200) {
        text = D.block(8)[o.link - 0x200] ?? null;
        if (text) break;
      }
    }
    if (text) showWords(game, text.trim());
    else { const n = D.block(10)[h.tex]; game.say(n ? `You see ${n.replace(/^(an?|the|some)_/, '$1 ')}.` : ''); }
    return;
  }
  const sp = h.sp, o = sp.o;
  if (sp.decal && (look || o.id === 0x166)) { if (!readWriting(game, o)) game.say(`You see ${nameOf(D, o.id)}.`); }
  else if (sp.decal && (o.id === 0x161 || o.id === 0x162)) {
    o.fl = (o.fl + 1) & 7; game.refreshDynamic();
    game.say(`You ${o.id === 0x161 ? 'pull' : 'flip'} the ${nameOf(D, o.id).replace(/^an? /, '')}.`);
  } else if (sp.decal) {
    o.id ^= 8; game.refreshDynamic();
    const n = nameOf(D, o.id & ~8).replace(/^an? /, '');
    game.say(n.includes('button') ? 'You press the button.' : `You ${n.includes('chain') ? 'pull' : 'flip'} the ${n}.`);
  } else if (!look && o.id === 0x167) { // a bed
    const E = eye(game);
    if (Math.hypot(sp.c[0] - E[0], sp.c[2] - E[2]) > 2.3) game.say(S1(D, 107) || 'You cannot reach that.');
    else void sleep(game);
  } else describe(game, o);
}

/** Get: into the first free bag slot, or onto the cursor when the bag is full. */
export function tryGet(game: Game, h: Hit | null): void {
  const D = game.data, inv = game.inv;
  if (inv.held) { game.say(S1(D, 274) || 'There is no place to put that.'); return; }
  if (!h || h.kind !== 'obj') { game.say(S1(D, 168) || 'You see nothing.'); return; }
  const o = h.sp.o;
  if (!portable(o) || h.sp.prop || h.sp.npc) { game.say(S1(D, 109) || 'You cannot pick that up.'); return; }
  const E = eye(game);
  if (Math.hypot(h.sp.c[0] - E[0], h.sp.c[1] - E[1], h.sp.c[2] - E[2]) > 2.3) { game.say(S1(D, 107) || 'You cannot reach that.'); return; }
  const objs = game.L.objs, at = objs.indexOf(o);
  if (at >= 0) objs.splice(at, 1);
  game.refreshObjects();
  if (inv.stow(o)) game.say(`You put ${nameOf(D, o.id)} in your pack.`);
  else { inv.held = o; game.say(`You hold ${nameOf(D, o.id)}.`); }
  game.ui.inventoryChanged();
}

/** Puts the held thing down where the Avatar points (within reach, on a floor or a prop top with room). */
export function dropHeld(game: Game, nx: number, ny: number): void {
  const D = game.data, L = game.L, P = game.pose, o = game.inv.held!, h = pick(game, nx, ny), PY = -P.z;
  let X = P.x + Math.sin(P.yaw) * 0.7, Y = PY + Math.cos(P.yaw) * 0.7;
  if (h && h.kind === 'surface') { X = h.x; Y = -h.z; }
  else if (h && h.kind === 'obj') { X = h.sp.c[0]; Y = -h.sp.c[2]; }
  const dx = X - P.x, dy = Y - PY;
  let d = Math.hypot(dx, dy);
  if (d > 2.4) { game.say(S1(D, 107) || 'You cannot reach that.'); return; }
  let f: number | null = null;
  for (let k = 0; k < 8 && d > 0.25; k++) {
    f = supportAt(L, X, Y, 9);
    if (f != null && !solidBlocks(L, X, Y, 0.08, f, 0.2)) break;
    f = null; X -= (dx / d) * 0.07; Y -= (dy / d) * 0.07; d = Math.hypot(X - P.x, Y - PY);
  }
  if (f == null) { game.say(S1(D, 269) || 'There is no space to drop that.'); return; }
  o.tx = Math.floor(X); o.ty = Math.floor(Y);
  o.fx = Math.max(0, Math.min(7, Math.floor((X - o.tx) * 8))); o.fy = Math.max(0, Math.min(7, Math.floor((Y - o.ty) * 8)));
  o.z = Math.max(0, Math.min(127, Math.round(f * 32)));
  L.objs.push(o); game.inv.held = null;
  game.refreshObjects(); game.ui.inventoryChanged(); game.say('');
}

export function talkTo(game: Game, h: Hit | null): void {
  if (h && h.kind === 'obj' && h.sp.npc) startTalk(game, h.sp);
  else game.say((game.data.str(7, 0) || S1(game.data, 170) || 'You cannot talk to that.').trim());
}

/** The primary action at screen point (nx, ny) in the current mode. */
export function act(game: Game, nx: number, ny: number): void {
  if (game.inv.held) { dropHeld(game, nx, ny); return; }
  if (game.mode === 'get') return tryGet(game, pick(game, nx, ny));
  if (game.mode === 'look') return use(game, nx, ny, true);
  if (game.mode === 'talk') return talkTo(game, pick(game, nx, ny));
  if (game.mode === 'fight') { game.say('Combat is not built yet.'); return; }
  use(game, nx, ny, false);
}

/** A tap on a paperdoll/bag slot: swap with the cursor, or pick the item up (look mode describes it). */
export function slotClick(game: Game, k: SlotKey): void {
  const D = game.data, inv = game.inv, cur = inv.get(k);
  if (inv.held) { inv.set(k, inv.held); inv.held = cur; game.say(cur ? `You now hold ${nameOf(D, cur.id)}.` : ''); }
  else if (cur) {
    if (game.mode === 'look') { describe(game, cur); return; }
    inv.held = cur; inv.set(k, null);
    game.say(`You hold ${nameOf(D, cur.id)}. Tap a slot, or point into the world to put it down.`);
  }
  game.ui.inventoryChanged();
}
