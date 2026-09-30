import type { ObjRec } from '../formats';
import { S1, nameOf } from '../data/text';
import { randInt } from '../core/rng';
import type { Game } from './game';
import {
  ARMOUR, BAG, MAX_NEST, RUNE_BAG_ID, WORN, contains, contents, fitsSlot, isContainer, isShield, isStack, nesting, qty, stacksWith,
  type SlotKey,
} from './inventory';
import { mkObj } from './loot';
import { castSpell, isRuneStone, addRune, runeName, SPELLS, spellName, isBuilt } from './magic';
import { SK, skill, skillCheck } from './rules';
import { SFX, sfx } from './sound';

// Item rules: weight, what containers take, putting things into slots and containers, and using things from the
// inventory. After UnderworldGodot (container.cs, uimanager_inventory.cs, food.cs, light.cs, potion.cs, wand.cs,
// doorkey.cs, lockpick.cs, a_lock.cs, MagicEnchantment.cs), traced from UW2.EXE.
//
// ORIGINAL  masses (COMOBJ.DAT) and the carrying limit; container capacity and accepted kinds; opening a container
//           shows its open picture (id | 1 for sacks, packs and boxes); using a container in the world spills it
//           unless locked; lights work only in the hands or on the shoulders and are lit by id + 4, brightness from
//           OBJECTS.DAT; food against hunger (0-255, too full above 255) with the taste line (STRINGS 1: 187+) and
//           leftovers; drink against a strength check; keys fit locks whose link & 63 matches the key's owner field,
//           lockpicks roll the lock-picking skill + 1 against 3 x the lock's height; potions and wands cast the spell
//           object linked to them (wands spend its charges and crack when empty); armour protection by body part
//           (helm: head, armour: body, gloves: arms, leggings and boots: legs).
// OURS      a shield in the off hand adds its protection to body and arms (the reference has no shield rule);
//           lights lose one point of quality a game minute (the original's burn rate is not traced); hunger falls 3-5
//           every 10 minutes (the reference's counter); stacks split one at a time with Shift; leftovers go to the
//           pack (the original puts them in the hand).

export const LIGHT_UNLIT = 0x90, LIGHT_LIT = 0x94, LOCK = 0x10f, SPELL_OBJ = 0x120;
const isLight = (id: number) => id >= 0x90 && id <= 0x97;
const isLit = (id: number) => id >= LIGHT_LIT && id <= 0x97;
const isFood = (id: number) => id >= 0xb0 && id <= 0xbf;
const isWand = (id: number) => id >= 0x98 && id <= 0x9b;
const isPotion = (id: number) => id >= 0xe1 && id <= 0xe7;
const isKey = (id: number) => id === 0x100 || (id >= 0x102 && id <= 0x10d);
const isLockpick = (id: number) => id === 0x101;
/** Sacks, packs and boxes have an open picture at id | 1. */
const hasOpenLook = (id: number) => id >= 0x80 && id <= 0x8b;

// ---------- weight ----------

/** An item's mass in tenths of a stone, with a stack's count and a container's contents. */
export function massOf(game: Game, o: ObjRec, d = 0): number {
  let m = (game.data.comObj[o.id]?.mass ?? 0) * qty(o);
  if (isContainer(o.id) && o.items && d < 16) for (const c of o.items) m += massOf(game, c, d + 1);
  return m;
}
export const carried = (game: Game): number => game.inv.all().reduce((a, o) => a + massOf(game, o), 0);
/** The most the Avatar can carry (tenths of a stone). */
export const carryLimit = (game: Game): number => 300 + (game.stats?.str ?? 0) * 13;
/** Can the Avatar take on o as well? */
export const canCarry = (game: Game, o: ObjRec): boolean => carried(game) + massOf(game, o) <= carryLimit(game);

// ---------- containers ----------

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const noun = (game: Game, id: number) => nameOf(game.data, id).replace(/^(an?|the|some) /, '');

/** Does container c take o? Says why not when `say`. */
export function accepts(game: Game, c: ObjRec, o: ObjRec, say = true): boolean {
  const D = game.data, no = (msg: string) => { if (say) game.say(msg); return false; };
  if (contains(o, c)) return no(S1(D, 263) || 'That item does not fit.');
  if (c.id === RUNE_BAG_ID) return isRuneStone(o.id) || no(S1(D, 262) || 'You can only put runes in the rune bag.');
  if (1 + nesting(o) + depthOf(game, c) > MAX_NEST) return no(S1(D, 263) || 'That item does not fit.');
  if (!D.hasItemDat) return true;
  const t = D.objDat.containers[c.id & 15]!, m = t.accepts;
  let ok = true;
  if (m >= 0 && m < 512) ok = o.id !== m; // the reference's reading: an exact id is refused
  else if (m === 512) ok = isRuneStone(o.id);
  else if (m === 513) ok = (o.id >= 0x10 && o.id < 0x18) || isWand(o.id);
  else if (m === 514) ok = o.id >= 0x130 && o.id <= 0x13a;
  else if (m === 515) ok = isFood(o.id);
  else if (m === 516) ok = o.id >= 0x100 && o.id <= 0x10f;
  if (!ok) return no(S1(D, 263) || 'That item does not fit.');
  if (t.capacity && massOf(game, c) - (D.comObj[c.id]?.mass ?? 0) + massOf(game, o) > t.capacity) return no(`The ${noun(game, c.id)} is too full.`);
  return true;
}

/** How many containers deep c sits in the inventory (a container in a slot: 1). */
function depthOf(game: Game, c: ObjRec): number {
  let d = 1, p = game.inv.parentOf(c);
  while (p && d < 32) { d++; p = game.inv.parentOf(p); }
  return d;
}

/** Puts o into container c (merging with a like stack; at index `at` when given). False (and says why) if it won't go. */
export function putInto(game: Game, c: ObjRec, o: ObjRec, at?: number): boolean {
  if (!accepts(game, c, o)) return false;
  if (c.id === RUNE_BAG_ID) { addRune(game, o.id - 0xe8); game.say(`You put the ${runeName(game, o.id - 0xe8)} rune in your rune bag.`); return true; }
  const a = contents(c), same = a.find(x => stacksWith(x, o));
  if (same) same.link = Math.min(0x1ff, qty(same) + qty(o));
  else if (at != null && at >= 0 && at <= a.length) a.splice(at, 0, o);
  else a.push(o);
  return true;
}

// ---------- the cursor and the slots ----------

/** A place in the inventory panel: a paperdoll/bag slot, or bag place i of the open container. */
export type Where = { slot: SlotKey } | { bag: number };

function readWhere(game: Game, w: Where): ObjRec | null {
  const inv = game.inv;
  if ('slot' in w) return BAG.includes(w.slot as never) && inv.container ? inv.bagAt(BAG.indexOf(w.slot as never)) : inv.get(w.slot);
  return inv.bagAt(w.bag);
}

/** Normalises a bag slot to a bag place when a container is open. */
function norm(game: Game, w: Where): Where {
  if ('slot' in w && game.inv.container) { const i = BAG.indexOf(w.slot as never); if (i >= 0) return { bag: i }; }
  return w;
}

/**
 * A tap on a place with something on the cursor. Onto a container: into it. Onto a like stack: merged. Onto an
 * empty place: put there (if the slot takes it). Onto something else: swapped with it.
 */
export function placeHeld(game: Game, w0: Where): void {
  const D = game.data, inv = game.inv, h = inv.held!, w = norm(game, w0), cur = readWhere(game, w);
  if ('slot' in w && !fitsSlot(w.slot, h.id)) { game.say(S1(D, 263) || 'That item does not fit.'); return; }
  if (cur && isContainer(cur.id) && cur !== h) {
    if (!putInto(game, cur, h)) return;
    inv.held = null;
    if (cur.id !== RUNE_BAG_ID) game.say(`You put ${nameOf(D, h.id)} in the ${noun(game, cur.id)}.`);
    changed(game); return;
  }
  if (cur && stacksWith(cur, h)) { cur.link = Math.min(0x1ff, qty(cur) + qty(h)); inv.held = null; game.say(''); changed(game); return; }
  if ('bag' in w) {
    const c = inv.container!, a = contents(c), i = inv.scroll + w.bag;
    if (cur) { // swap
      a.splice(a.indexOf(cur), 1);
      if (!accepts(game, c, h)) { a.splice(Math.min(i, a.length), 0, cur); return; }
      a.splice(Math.min(i, a.length), 0, h); inv.held = cur;
      game.say(`You now hold ${nameOf(D, cur.id)}.`);
    } else {
      if (!accepts(game, c, h)) return;
      a.push(h); inv.held = null; game.say('');
    }
    changed(game); return;
  }
  if (cur && !fitsSlot(w.slot, h.id)) { game.say(S1(D, 263) || 'That item does not fit.'); return; }
  inv.set(w.slot, h); inv.held = cur;
  game.say(cur ? `You now hold ${nameOf(D, cur.id)}.` : '');
  if (cur && isLit(cur.id) && !(WORN as readonly string[]).includes(w.slot)) douse(cur); // a light taken off the hands goes out
  if (isLit(h.id) && !(WORN as readonly string[]).includes(w.slot)) douse(h);
  changed(game);
}

/** Picks up what is at a place onto the cursor (one of a stack when `one`). */
export function takeFrom(game: Game, w0: Where, one = false): ObjRec | null {
  const inv = game.inv, w = norm(game, w0), cur = readWhere(game, w);
  if (!cur || inv.held) return null;
  let took = cur;
  if (one && isStack(cur) && qty(cur) > 1) {
    cur.link = qty(cur) - 1;
    took = { ...cur, link: 1, i: -1, items: undefined };
  } else if ('bag' in w) contents(inv.container!).splice(contents(inv.container!).indexOf(cur), 1);
  else inv.set(w.slot, null);
  if (inv.open.includes(took)) { inv.open.length = inv.open.indexOf(took); inv.scroll = 0; }
  closeLook(took);
  inv.held = took;
  changed(game);
  return took;
}

const changed = (game: Game) => { game.inv.closeGone(); game.ui.inventoryChanged(); };

// ---------- opening containers ----------

export function openContainer(game: Game, c: ObjRec): void {
  const inv = game.inv;
  if (inv.open.includes(c)) { while (inv.container !== c) closeInner(game); }
  else {
    if (hasOpenLook(c.id)) c.id |= 1;
    inv.openContainer(c);
  }
  game.ui.inventoryChanged();
}

function closeLook(c: ObjRec): void { if (hasOpenLook(c.id)) c.id &= ~1; }

/** Closes the innermost open container (the tap on its picture). */
export function closeInner(game: Game): void {
  const c = game.inv.container;
  if (!c) return;
  closeLook(c);
  game.inv.closeContainer();
  game.ui.inventoryChanged();
}

/** Using a container lying in the world (or a chest, barrel or nightstand) spills what it holds onto its tile. */
export function spill(game: Game, o: ObjRec): void {
  const L = game.L;
  if (isLocked(o)) { game.say(`The ${noun(game, o.id)} is locked.`); return; }
  const items = (o.items ?? []).filter(x => x.id !== LOCK && !(x.id >= 0x180 && x.id < 0x200));
  if (!items.length) { game.say(`The ${noun(game, o.id)} is empty.`); return; }
  o.items = (o.items ?? []).filter(x => !items.includes(x));
  const f = L.floorAt(o.tx + 0.5, -(o.ty + 0.5)) ?? 0;
  for (const it of items) {
    Object.assign(it, { tx: o.tx, ty: o.ty, lvl: L.n, own: 0, fx: 1 + randInt(game.rng, 6), fy: 1 + randInt(game.rng, 6), z: Math.max(0, Math.min(127, Math.max(o.z, Math.round(f * 32)))) });
    L.objs.push(it);
  }
  if (hasOpenLook(o.id)) o.id |= 1;
  game.refreshObjects();
  game.say(`You spill the contents of the ${noun(game, o.id)}.`);
}

// ---------- locks ----------

export const lockOf = (o: ObjRec): ObjRec | null => o.items?.find(x => x.id === LOCK) ?? null;
export const isLocked = (o: ObjRec): boolean => !!((lockOf(o)?.fl ?? 0) & 1);

/** A key or lockpick used on a door or a locked thing. */
export function useOnThing(game: Game, tool: ObjRec, target: ObjRec, isDoor: boolean, doorOpen: boolean, toggleDoor: () => void): void {
  const D = game.data, lock = lockOf(target);
  if (isDoor && doorOpen) { game.say(S1(D, 6) || 'That is already open.'); return; }
  if (!lock) { game.say(S1(D, 3) || 'There is no lock on that.'); return; }
  if (isKey(tool.id)) {
    if ((lock.link & 63) !== tool.own) { game.say(S1(D, 2) || 'The key does not fit.'); return; }
    if (lock.fl & 1) { lock.fl &= ~1; game.say(S1(D, 5) || 'The key unlocks the lock.'); if (isDoor) toggleDoor(); }
    else { lock.fl |= 1; game.say(S1(D, 4) || 'The key locks the lock.'); }
    return;
  }
  if (isLockpick(tool.id)) {
    if (!(lock.fl & 1)) { game.say(S1(D, 136) || 'That is not locked.'); return; }
    const r = skillCheck(game.rng, skill(game.stats!, SK.picklock) + 1, lock.z * 3);
    if (r > 0) { lock.fl &= ~1; sfx(game, SFX.button); game.say(S1(D, 135) || 'You succeed in picking the lock.'); if (isDoor) toggleDoor(); }
    else if (r === 0 || skillCheck(game.rng, game.stats!.dex, 20) > 0) game.say(S1(D, 133) || 'Your lockpicking attempt failed.');
    else { game.inv.remove(tool); game.say('You broke your pick.'); game.ui.inventoryChanged(); }
    return;
  }
  game.say(S1(D, 166) || 'You cannot use that.');
}

// ---------- using things from the inventory ----------

/** Can the use command do something with this item from the inventory? */
export const usable = (o: ObjRec): boolean =>
  isContainer(o.id) || isLight(o.id) || isKey(o.id) || isLockpick(o.id) || isFood(o.id) || isWand(o.id) || isPotion(o.id) || (o.id >= 0x40 && !!spellOf(o));

/** Use (the use command) on an inventory item at place w. Returns 'runes' when the rune bag should open. */
export function useItem(game: Game, o: ObjRec, w: Where): 'runes' | void {
  const D = game.data;
  if (o.id === RUNE_BAG_ID) return 'runes';
  if (isContainer(o.id)) { openContainer(game, o); return; }
  if (isLight(o.id)) { useLight(game, o, w); return; }
  if (isKey(o.id) || isLockpick(o.id)) { game.useOn = o; game.say(S1(D, isKey(o.id) ? 7 : 8) || 'What do you want to use it on?'); return; }
  if (isFood(o.id)) { eat(game, o); return; }
  if (isWand(o.id) || isPotion(o.id) || (o.id >= 0x40 && spellOf(o))) { castFrom(game, o); return; }
  game.say(S1(D, 166) || 'You cannot use that.');
}

function useLight(game: Game, o: ObjRec, w: Where): void {
  const D = game.data, inv = game.inv, inHands = 'slot' in w && (WORN as readonly string[]).includes(w.slot);
  if (!inHands) {
    const free = WORN.find(k => !inv.get(k));
    if (!free) { game.say(S1(D, 137) || 'Lights may only be used if equipped.'); return; }
    if (o.q <= 1 && !isLit(o.id)) { game.say(S1(D, 138) || 'That light is already used up.'); return; }
    let lamp = o;
    if (isStack(o) && qty(o) > 1) { o.link = qty(o) - 1; lamp = { ...o, link: 1, i: -1, items: undefined }; }
    else inv.remove(o);
    inv.set(free, lamp);
    o = lamp;
  }
  if (isLit(o.id)) douse(o);
  else if (o.q <= 1) { game.say(S1(D, 138) || 'That light is already used up.'); changed(game); return; }
  else { o.id += 4; sfx(game, SFX.light); }
  changed(game);
}
const douse = (o: ObjRec) => { if (isLit(o.id)) o.id -= 4; };

/** The brightest lit light in the hands or on the shoulders (OBJECTS.DAT brightness; 0 none). */
export function carriedLight(game: Game): number {
  let b = 0;
  for (const k of WORN) {
    const o = game.inv.get(k);
    if (o && isLit(o.id)) b = Math.max(b, game.data.hasItemDat ? game.data.objDat.lights[o.id & 15]!.brightness : [4, 3, 2, 2][o.id - LIGHT_LIT]!);
  }
  return b;
}

/**
 * The light the Avatar sees by as an index into the renderer's LIGHTS (0 candle .. 3 daylight), or -1 for dark: the
 * brightest of a carried light, a light spell and the level's ambient light (DL.DAT: 0-9, and the tile's light bit
 * turns it on; 10+ means the bit turns the remainder off). ORIGINAL levels; OURS the mapping to our four lights.
 */
export function viewLight(game: Game, magic: number): number {
  let lv = carriedLight(game);
  const L = game.level;
  if (L && !game.data.files['DL.DAT']) lv = Math.max(lv, 3); // data stored before DL.DAT was read: see as before, by lantern
  else if (L) {
    const amb = game.data.ambient(L.n), t = L.tileAt(Math.floor(game.pose.x), Math.floor(-game.pose.z));
    if (t && (t.light ^ (amb >= 10 ? 1 : 0)) === 1) lv = Math.max(lv, amb % 10);
  }
  const idx = lv >= 5 ? 3 : lv >= 3 ? 2 : lv === 2 ? 1 : lv === 1 ? 0 : -1;
  return Math.max(idx, magic);
}

/** Each game minute: lit lights burn down; each 10 minutes hunger grows and drink wears off. */
export function burnLights(game: Game): void {
  for (const k of WORN) {
    const o = game.inv.get(k);
    if (!o || !isLit(o.id)) continue;
    if (--o.q <= 1) { o.q = Math.max(0, o.q); douse(o); game.say(`${cap(nameOf(game.data, o.id).replace(/^(an?|the|some) /, 'Your '))} has burnt out.`); game.ui.inventoryChanged(); }
  }
}

export function hungerTick(game: Game): void {
  const pl = game.stats;
  if (!pl) return;
  pl.hunger = Math.max(0, (pl.hunger ?? 0xc0) - 3 - randInt(game.rng, 3));
  if (pl.drunk) pl.drunk--;
}

/** Food and drink (the original's EatFood, DrinkLiquid and TakeShrooms). */
function eat(game: Game, o: ObjRec): void {
  const D = game.data, pl = game.stats!, n = D.hasItemDat ? D.objDat.food[o.id & 15]! : 8, hunger = pl.hunger ?? 0xc0;
  const drink = o.id >= 0xbb && o.id <= 0xbd, shroom = o.id === 0xb9;
  if (shroom) {
    const r = skillCheck(game.rng, pl.int, 20);
    pl.mana[0] = Math.max(0, Math.min(pl.mana[1], pl.mana[0] + (1 + randInt(game.rng, 3)) * r));
    game.say(S1(D, 247) || 'The mushroom causes your head to spin and your vision to blur.');
  } else if (drink) {
    sfx(game, SFX.eat);
    pl.drunk = (pl.drunk ?? 0) - n;
    const r = skillCheck(game.rng, pl.str, pl.drunk);
    if (r === 2) { game.say(S1(D, 257) || 'The drink makes you feel a little better for now.'); pl.vit[0] = Math.min(pl.vit[1], pl.vit[0] + 2); }
    else if (r === -1) game.say(S1(D, 258) || 'You wake feeling somewhat unstable but better.');
    else game.say(o.id === 0xbc ? S1(D, 252) || 'The water refreshes you.' : S1(D, 254) || 'You drink.');
  } else {
    if (n >= 0 && hunger + n > 255) { game.say(S1(D, 140) || 'You are too full to eat that now.'); return; }
    pl.hunger = Math.max(0, Math.min(255, hunger + n));
    sfx(game, hunger >= 192 ? 0x25 : hunger > 90 ? 0x1f : 0x21);
    const taste = Math.min(4, (o.q + randInt(game.rng, 20)) >> 4);
    game.say(`That ${noun(game, o.id)}${D.str(1, 187 + taste) || ' tasted fine.'}`.replace(/\s+$/, ''));
  }
  consume(game, o);
  const left = { 0xb0: 0xc5, 0xb1: 0xc5, 0xbb: 0x13d, 0xbc: 0x13d, 0xbd: 0x13d, 0xbe: 0x13e }[o.id];
  if (left) { const l = mkObj(game, left); if (!game.inv.held) game.inv.held = l; else if (!game.inv.stow(l)) game.inv.held ??= l; }
  game.ui.playerChanged(); game.ui.inventoryChanged();
}

/** Uses up one of o (a stack loses one; a single item goes). */
export function consume(game: Game, o: ObjRec): void {
  if (isStack(o) && qty(o) > 1) o.link = qty(o) - 1;
  else game.inv.remove(o);
}

/** The spell object linked to an item, if any. */
export const spellOf = (o: ObjRec): ObjRec | null => (!o.isq && o.items?.find(x => x.id === SPELL_OBJ)) || null;

/** The runic spell number an enchantment names (the original's GetSpellEnchantment + CastSpellFromObject), or -1. */
export function enchantmentSpell(s: ObjRec): number {
  const flag2 = (s.fl >> 2) & 1;
  let major: number, minor: number;
  if (flag2) { major = (s.link & 0x1ff) >> 6; major = major ? major + 12 : -1; minor = s.link & 0x3f; }
  else { major = (s.link & 0x1ff) >> 4; minor = s.link & 0xf; }
  const n = major !== -1 ? minor | (major << 6) : minor;
  return (n & 0xc0) === 0 && n < SPELLS.length ? n : -1;
}

/** Potions are drunk and cast their spell; wands cast theirs and spend a charge (cracking when empty). */
function castFrom(game: Game, o: ObjRec): void {
  const D = game.data, s = spellOf(o), potion = isPotion(o.id);
  if (potion) { sfx(game, SFX.eat); game.say(S1(D, 255) || 'You quaff the potion in one gulp.'); }
  const n = s ? enchantmentSpell(s) : -1;
  if (n < 0) {
    if (potion) consume(game, o);
    else game.say(S1(D, 146) || 'It seems to have no effect.');
    game.ui.inventoryChanged(); return;
  }
  const [major, minor] = SPELLS[n]!;
  if (!isBuilt(major, minor)) game.say(`${cap(spellName(game, n))}: this spell is not built yet.`);
  else castSpell(game, major, minor, 0, spellName(game, n));
  if (potion) consume(game, o);
  else if (s) {
    if (s.q > 0) s.q--;
    else { o.items = o.items!.filter(x => x !== s); o.id += 4; game.say(S1(D, 139) || 'With a loud snap, the wand cracks!'); }
  }
  game.ui.inventoryChanged();
}

// ---------- armour ----------

/** Worn protection by body part [body, arms, legs, head] (the original's LocationalArmourValues). */
export function wornArmour(game: Game): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0], D = game.data;
  if (!D.hasObjDat) return out;
  const prot = (o: ObjRec | null) => (o && o.id >= 0x20 && o.id < 0x40 ? D.objDat.armour[o.id - 0x20]!.protection : 0);
  const part: Record<(typeof ARMOUR)[number], number> = { helm: 3, body: 0, gloves: 1, legs: 2, boots: 2 };
  for (const k of ARMOUR) { const o = game.inv.get(k); if (o && fitsSlot(k, o.id)) out[part[k]] += prot(o); }
  const off = game.inv.get(game.stats?.hand === 0 ? 'hr' : 'hl'); // ours: a shield in the off hand guards body and arms
  if (off && isShield(off.id)) { out[0] += prot(off); out[1] += prot(off); }
  return out;
}

/** Picks up o (from the world) into the pack, the open container, or onto the cursor. False when too heavy. */
export function receive(game: Game, o: ObjRec): 'pack' | 'held' | 'heavy' {
  const inv = game.inv;
  if (!canCarry(game, o)) return 'heavy';
  if (isRuneStone(o.id) && inv.everything().some(x => x.id === RUNE_BAG_ID)) { addRune(game, o.id - 0xe8); return 'pack'; }
  const c = inv.container;
  if (c && accepts(game, c, o, false)) { putInto(game, c, o); return 'pack'; }
  if (inv.stow(o)) return 'pack';
  inv.held = o;
  return 'held';
}
