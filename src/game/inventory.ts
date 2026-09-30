import type { ObjRec } from '../formats';

/** Paperdoll and bag slots: shoulders, hands, eight bag places. Items are the level's own object records. */
export const SLOT_KEYS = ['shl', 'shr', 'hl', 'hr', 'b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'] as const;
export type SlotKey = (typeof SLOT_KEYS)[number];
export const BAG: SlotKey[] = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'];
export const WORN: SlotKey[] = ['shl', 'shr', 'hl', 'hr'];

/** Can the Avatar carry this? (Not creatures, not fixtures.) No weight or equip rules yet. */
export const portable = (o: ObjRec): boolean => o.id < 0x140 && !(o.id >= 0x40 && o.id < 0x80);

/**
 * What the Avatar carries, plus the thing on the cursor (held). Mirrors the original: things you take go to the first
 * free bag slot (or onto the cursor when the bag is full); a held thing goes into whichever slot you tap.
 */
export class Inventory {
  readonly slots: Record<SlotKey, ObjRec | null> = Object.fromEntries(SLOT_KEYS.map(k => [k, null])) as Record<SlotKey, ObjRec | null>;
  held: ObjRec | null = null;

  clear(): void { for (const k of SLOT_KEYS) this.slots[k] = null; this.held = null; }
  get(k: SlotKey): ObjRec | null { return this.slots[k]; }
  set(k: SlotKey, o: ObjRec | null): void { this.slots[k] = o; }
  firstFreeBag(): SlotKey | undefined { return BAG.find(k => !this.slots[k]); }
  /** Filled slots (not the cursor), in slot order. */
  filled(): SlotKey[] { return SLOT_KEYS.filter(k => this.slots[k]); }
  items(): ObjRec[] { return this.filled().map(k => this.slots[k]!); }
  /** Every carried record including the cursor. */
  all(): ObjRec[] { return [...this.items(), ...(this.held ? [this.held] : [])]; }
  /** Takes an item out of wherever it is (slot or cursor). Returns the slot it left ('held' for the cursor), or null. */
  remove(it: ObjRec): SlotKey | 'held' | null {
    for (const k of SLOT_KEYS) if (this.slots[k] === it) { this.slots[k] = null; return k; }
    if (this.held === it) { this.held = null; return 'held'; }
    return null;
  }
  /** Puts an item in the first free bag slot; false when the bag is full. */
  stow(it: ObjRec): SlotKey | null { const k = this.firstFreeBag(); if (!k) return null; this.slots[k] = it; return k; }

  toJSON(): Record<SlotKey | 'held', ObjRec | null> { return { ...this.slots, held: this.held }; }
  load(d: Partial<Record<SlotKey | 'held', ObjRec | null>>): void {
    for (const k of SLOT_KEYS) this.slots[k] = d[k] ?? null;
    this.held = d.held ?? null;
  }
}
