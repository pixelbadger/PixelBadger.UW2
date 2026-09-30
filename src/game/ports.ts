import type { ObjRec } from '../formats';
import type { MenuOption } from '../conv/vm';
import type { SlotKey } from './inventory';

// The seams between the game (rules and state) and the page (DOM, canvas). The game calls these; the UI implements
// them; tests use the no-op versions. Nothing under src/game or src/world touches the DOM.

export type LineKind = 'npc' | 'you' | 'narr' | 'note';

export interface TradeView {
  theirs: (ObjRec | null)[];
  theirsSel: boolean[];
  offer: (ObjRec | null)[];
  pack: { key: SlotKey; o: ObjRec }[];
}

/** The conversation panel. */
export interface TalkView {
  /** The Avatar's side: name and portrait (HEADS.GR[body]). */
  open(me: { name: string; body: number }): void;
  close(): void;
  /** Who is speaking: whoami picks CHARHEAD.GR[who - 1], else the creature's generic head (GENHEAD.GR[id - 0x40]). */
  setTalker(t: { name: string; who: number; id: number | null }): void;
  /** A line of the talk; speaker is set when more than one NPC has spoken. */
  line(kind: LineKind, text: string, speaker?: string): void;
  /** What the player can do next. */
  prompt(p: { kind: 'menu'; options: MenuOption[] } | { kind: 'more' } | { kind: 'ask' } | { kind: 'leave' }): void;
  /** The barter table, or null to hide it. */
  trade(t: TradeView | null): void;
}

export interface UiPort {
  /** The message scroll. */
  say(text: string): void;
  /** The current level changed (name label, level picker). */
  levelChanged(n: number): void;
  /** Inventory or cursor changed. */
  inventoryChanged(): void;
  /** The Avatar's stats changed. */
  playerChanged(): void;
  /** A book, scroll or long sign. */
  showText(text: string, title?: string): void;
  /** Release the mouse (any UI that needs a cursor). */
  releasePointer(): void;
  talk: TalkView;
}

export const nullTalkView = (): TalkView => ({ open() {}, close() {}, setTalker() {}, line() {}, prompt() {}, trade() {} });
export const nullUi = (): UiPort => ({ say() {}, levelChanged() {}, inventoryChanged() {}, playerChanged() {}, showText() {}, releasePointer() {}, talk: nullTalkView() });
