import type { ObjRec } from '../formats';

// What the Avatar carries, after UnderworldGodot (uimanager_inventory.cs, uimanager_paperdoll.cs, container.cs,
// playerdatinventory.cs), traced from UW2.EXE. Items are the level's own object records; a container's contents are its
// `items` (the level's link chain, decoded), in order.
//
// ORIGINAL  the slots: helm, body armour, gloves, leggings, boots, two shoulders, two hands, two rings, eight bag
//           places; which items each paperdoll slot takes; a container's capacity (OBJECTS.DAT, in tenths of a stone,
//           against the total mass of what it holds) and what kinds it accepts (runes, missiles and wands, scrolls
//           and books, food, keys); the Avatar's carrying limit (300 + 13 x strength tenths of a stone); stacks merge
//           when a like item is laid on them.
// OURS      how deep containers nest (6: the saves' limit is 8); taking one from a stack with Shift.

export const ARMOUR = ['helm', 'body', 'gloves', 'legs', 'boots'] as const;
/** Shoulders and hands (named by the side of the panel they sit on). */
export const WORN = ['shl', 'shr', 'hl', 'hr'] as const;
export const RINGS = ['rgl', 'rgr'] as const;
export const BAG = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'] as const;
export const SLOT_KEYS = [...ARMOUR, ...WORN, ...RINGS, ...BAG] as const;
export type SlotKey = (typeof SLOT_KEYS)[number];
export type BagKey = (typeof BAG)[number];

export const MAX_NEST = 6;

/** Can the Avatar carry this? (Not creatures, not fixtures.) */
export const portable = (o: ObjRec): boolean => o.id < 0x140 && !(o.id >= 0x40 && o.id < 0x80);

/** Containers: bags, packs, boxes, chests, quivers, pouches (0x80-0x8e) and the rune bag (0x8f). */
export const isContainer = (id: number): boolean => id >= 0x80 && id <= 0x8f;
export const RUNE_BAG_ID = 0x8f;
/** A stack: the quantity is in link (below 0x200; 0x200+ links text). */
export const isStack = (o: ObjRec): boolean => !!o.isq && o.link < 0x200;
export const qty = (o: ObjRec): number => (isStack(o) ? Math.max(1, o.link) : 1);

/** Which items a paperdoll slot takes (the original's ValidObjectForSlot, UW2's special cases first). */
export function fitsSlot(k: SlotKey, id: number): boolean {
  switch (id) {
    case 0x2f: return k === 'boots' || !isArmourSlot(k) && !isRingSlot(k);  // swamp boots
    case 0x33: return k === 'gloves' || !isArmourSlot(k) && !isRingSlot(k); // fraznium gauntlets
    case 0x34: return k === 'helm' || !isArmourSlot(k) && !isRingSlot(k);   // fraznium circlet
  }
  switch (k) {
    case 'helm': return (id >= 0x2c && id <= 0x2e) || (id >= 0x30 && id <= 0x32);
    case 'body': return id >= 0x20 && id <= 0x22;
    case 'legs': return id >= 0x23 && id <= 0x25;
    case 'gloves': return id >= 0x26 && id <= 0x28;
    case 'boots': return id >= 0x29 && id <= 0x2b;
    case 'rgl': case 'rgr': return isRing(id);
    default: return true;
  }
}
export const isRing = (id: number): boolean => id === 0x35 || (id >= 0x37 && id <= 0x3b);
export const isShield = (id: number): boolean => id >= 0x3c && id <= 0x3f;
const isArmourSlot = (k: SlotKey) => (ARMOUR as readonly string[]).includes(k);
const isRingSlot = (k: SlotKey) => k === 'rgl' || k === 'rgr';

/** Where a container sits: its parent container (null at the top) and its index there. */
export interface Place { parent: ObjRec | null; key: SlotKey | null; index: number }

export class Inventory {
  readonly slots: Record<SlotKey, ObjRec | null> = Object.fromEntries(SLOT_KEYS.map(k => [k, null])) as Record<SlotKey, ObjRec | null>;
  held: ObjRec | null = null;
  /** The containers opened into the bag area, outermost first (empty: the bag itself). */
  open: ObjRec[] = [];
  /** First row shown of the open container (a multiple of 4). */
  scroll = 0;

  clear(): void { for (const k of SLOT_KEYS) this.slots[k] = null; this.held = null; this.open = []; this.scroll = 0; }
  get(k: SlotKey): ObjRec | null { return this.slots[k]; }
  set(k: SlotKey, o: ObjRec | null): void { this.slots[k] = o; }
  firstFreeBag(): BagKey | undefined { return BAG.find(k => !this.slots[k]); }
  /** Filled slots (not the cursor), in slot order. */
  filled(): SlotKey[] { return SLOT_KEYS.filter(k => this.slots[k]); }
  /** What sits in the slots (not inside containers). */
  items(): ObjRec[] { return this.filled().map(k => this.slots[k]!); }
  /** Every carried record including the cursor (top level). */
  all(): ObjRec[] { return [...this.items(), ...(this.held ? [this.held] : [])]; }
  /** Every carried record, containers' contents too (depth first), and the cursor. */
  everything(): ObjRec[] {
    const out: ObjRec[] = [];
    const walk = (o: ObjRec, d: number) => { out.push(o); if (isContainer(o.id) && o.items && d < 16) for (const c of o.items) walk(c, d + 1); };
    for (const o of this.all()) walk(o, 0);
    return out;
  }

  /** The container shown in the bag area, or null for the bag itself. */
  get container(): ObjRec | null { return this.open[this.open.length - 1] ?? null; }

  /** What bag place i shows (0-7). */
  bagAt(i: number): ObjRec | null {
    const c = this.container;
    return c ? contents(c)[this.scroll + i] ?? null : this.slots[BAG[i]!];
  }

  /** Takes an item out of wherever it is (slot, cursor or any container). The slot it left, 'held', 'inside' or null. */
  remove(it: ObjRec): SlotKey | 'held' | 'inside' | null {
    for (const k of SLOT_KEYS) if (this.slots[k] === it) { this.slots[k] = null; this.closeGone(); return k; }
    if (this.held === it) { this.held = null; return 'held'; }
    const p = this.parentOf(it);
    if (p) { const a = contents(p), i = a.indexOf(it); a.splice(i, 1); this.closeGone(); return 'inside'; }
    return null;
  }

  /** The container holding it, or null. */
  parentOf(it: ObjRec): ObjRec | null {
    const find = (o: ObjRec, d: number): ObjRec | null => {
      if (!isContainer(o.id) || !o.items || d > 16) return null;
      if (o.items.includes(it)) return o;
      for (const c of o.items) { const r = find(c, d + 1); if (r) return r; }
      return null;
    };
    for (const o of this.all()) { const r = find(o, 0); if (r) return r; }
    return null;
  }

  /** Puts an item in the first free bag slot; null when the bag is full. */
  stow(it: ObjRec): BagKey | null { const k = this.firstFreeBag(); if (!k) return null; this.slots[k] = it; return k; }

  /** Opens a container into the bag area (it must be carried). */
  openContainer(c: ObjRec): void { this.open.push(c); this.scroll = 0; }
  /** Closes the innermost open container. */
  closeContainer(): void { this.open.pop(); this.scroll = 0; }
  /** Scrolls the open container by a row of 4 (clamped). */
  scrollBy(rows: number): void {
    const c = this.container;
    if (!c) { this.scroll = 0; return; }
    const n = contents(c).length, max = Math.max(0, Math.ceil((n + 1 - 8) / 4) * 4);
    this.scroll = Math.max(0, Math.min(max, this.scroll + rows * 4));
  }
  /** Drops open containers that are no longer carried (given away, dropped). */
  closeGone(): void {
    const carried = new Set(this.everything());
    const k = this.open.findIndex(c => !carried.has(c) || c === this.held);
    if (k >= 0) { this.open.length = k; this.scroll = 0; }
  }

  toJSON(): Record<SlotKey | 'held', ObjRec | null> { return { ...this.slots, held: this.held }; }
  load(d: Partial<Record<SlotKey | 'held', ObjRec | null>>): void {
    for (const k of SLOT_KEYS) this.slots[k] = d[k] ?? null;
    this.held = d.held ?? null;
    this.open = []; this.scroll = 0;
  }
}

/** A container's contents (made on first use). */
export function contents(c: ObjRec): ObjRec[] { return (c.items ??= []); }

/** How deeply containers nest inside o (0 for a plain item or an empty container). */
export function nesting(o: ObjRec, d = 0): number {
  if (!isContainer(o.id) || !o.items || d > 16) return 0;
  let m = 0;
  for (const c of o.items) if (isContainer(c.id)) m = Math.max(m, 1 + nesting(c, d + 1));
  return m;
}

/** Is `inner` o itself or somewhere inside o? */
export function contains(o: ObjRec, inner: ObjRec, d = 0): boolean {
  if (o === inner) return true;
  if (!isContainer(o.id) || !o.items || d > 16) return false;
  return o.items.some(c => contains(c, inner, d + 1));
}

/** Two items that stack together: same kind and quality, both counted stacks. */
export const stacksWith = (a: ObjRec, b: ObjRec): boolean => a !== b && a.id === b.id && isStack(a) && isStack(b) && a.q === b.q && !a.items?.length && !b.items?.length;
