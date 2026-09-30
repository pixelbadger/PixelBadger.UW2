import { readNpc, type ObjRec } from '../formats';
import { ConvVM, type VmState } from '../conv/vm';
import { S1, critByte, itemName, npcName, objValue, qtyOf } from '../data/text';
import { randInt } from '../core/rng';
import { supportAt } from '../world/collision';
import type { Critter } from '../world/creatures';
import type { Pick } from '../world/props';
import type { Game } from './game';
import { SLOT_KEYS, type SlotKey } from './inventory';
import { npcInv } from './loot';
import { discPlayer } from './player';
import { eye } from './picking';
import type { LineKind, TradeView } from './ports';
import { convBuiltin } from './talkBuiltins';

// Conversations: CNV.ARK programs run on ConvVM. Talking pauses the world. The VM yields at every menu, typed answer
// and pause; the panel feeds the answer back. Per-slot private globals (31..G-1), quest flags, x_clock clocks, game
// variables (x_traps) and the game clock live in Game.conv / Game.minutes and go into saves. Builtins follow
// UnderworldGodot's port (hankmorgan) unless noted.
// Object "handles" the programs pass around are this level's object numbers (o.i) where the object is from this level,
// else a handle from 1024 up for this talk (things in your pack from other levels, things made during the talk).

export const TRADE_SLOTS = 6; // UW2 (UW1 had 4)

/** A world change a program asked for, applied when the talk closes. */
export type TalkEffect =
  | { k: 'remove' }
  | { k: 'transform' }
  | { k: 'talker'; x: number; y: number }
  | { k: 'player'; lv: number; x: number; y: number };

export interface TradeState {
  on: boolean;
  /** Their goods on the table, and which are picked. */
  npc: (ObjRec | null)[];
  npcSel: boolean[];
  /** Your offer: slot keys of things still in your pack. */
  pl: (SlotKey | null)[];
  /** Threshold, patience and appraisal accuracy (OBJECTS.DAT critter bytes 0xd-0xe, randomised). */
  thr: number; pat: number; acc: number;
  prev: number;
  /** VM addresses of the likes / dislikes arrays (0 = none). */
  likes: number; dislikes: number;
  bonus: number;
}

export class TalkSession {
  readonly vm: ConvVM;
  face: number;
  readonly fx: TalkEffect[] = [];
  over = false;
  /** Handle -> object, and object -> runtime handle. */
  readonly hmap: Map<number, ObjRec>;
  readonly hrev = new Map<ObjRec, number>();
  hn = 0;
  /** Objects moved in ways the scene must reflect. */
  dirty = false;
  readonly tr: TradeState;
  /** Words the player typed, echoed unless the program repeats them itself. */
  echo: string | null = null;
  private switched = false;
  private lastSpk = -1;
  private logged = new Set<string>();

  constructor(readonly game: Game, readonly o: ObjRec, readonly c: Critter | null, readonly who: number, readonly name: string, vm: (s: TalkSession) => ConvVM) {
    this.face = who;
    this.hmap = indexLevel(game);
    const D = game.data, rr = (n: number) => randInt(game.rng, n);
    const rnd = (b: number, lo: number, hi: number) => b + Math.floor((b * (lo + rr(hi - lo))) / 100);
    this.tr = {
      on: false, npc: Array(TRADE_SLOTS).fill(null), npcSel: Array(TRADE_SLOTS).fill(false), pl: Array(TRADE_SLOTS).fill(null),
      thr: rnd(critByte(D, o.id, 0xe) & 15, -25, 25), pat: rnd(critByte(D, o.id, 0xe) >> 4, -20, 100), acc: rnd((16 - (critByte(D, o.id, 0xd) >> 4)) * 6, -25, 50),
      prev: 0, likes: 0, dislikes: 0, bonus: 0,
    };
    for (const x of game.L.objs) if (x.lvl === game.L.n && x.i > 0) this.hmap.set(x.i, x);
    this.vm = vm(this);
  }

  get view() { return this.game.ui.talk; }

  // ----- handles -----
  hOf(o: ObjRec | null | undefined): number {
    if (!o) return 0;
    if (o.lvl === this.game.L.n && o.i > 0 && o.i < 1024) { this.hmap.set(o.i, o); return o.i; }
    let h = this.hrev.get(o);
    if (!h) { h = 1024 + this.hn++; this.hrev.set(o, h); this.hmap.set(h, o); }
    return h;
  }
  oOf(h: number): ObjRec | null { return h ? this.hmap.get(h) ?? null : null; }

  // ----- the log -----
  line(kind: LineKind, t: string): void {
    if (this.echo != null) {
      const e = this.echo; this.echo = null;
      if (!(kind === 'you' && String(t).trim().toLowerCase() === e.toLowerCase())) this.line('you', e || '…');
    }
    const parts = String(t).replace(/\\n/g, '\n').split(/\\m/).map(x => x.trim()).filter(Boolean);
    for (const part of parts) {
      if (kind === 'npc' && this.face !== this.who) this.switched = true;
      const label = kind === 'npc' && this.switched && this.face !== this.lastSpk ? npcName(this.game.data, this.face) : undefined;
      this.view.line(kind, part, label);
      if (kind === 'npc') this.lastSpk = this.face;
    }
  }

  setTalker(who: number): void {
    this.face = who;
    this.view.setTalker({ name: who === this.who ? this.name : npcName(this.game.data, who), who, id: this.o ? this.o.id : null });
  }

  logOnce(name: string, v: number[]): void {
    if (this.logged.has(name)) return;
    this.logged.add(name);
    console.info('conversation builtin not built yet:', name, v);
  }

  // ----- inventories -----
  takeFromNpc(it: ObjRec): void {
    const inv = npcInv(this.game, this.o), i = inv.indexOf(it);
    if (i >= 0) inv.splice(i, 1);
    const s = this.tr.npc.indexOf(it);
    if (s >= 0) { this.tr.npc[s] = null; this.tr.npcSel[s] = false; }
  }
  /** Into the pack, or at the Avatar's feet when it is full. 1 = pack, 2 = floor. */
  toPlayer(it: ObjRec): number {
    const g = this.game, D = g.data, P = g.pose;
    it.lvl = it.lvl ?? -1;
    if (g.inv.stow(it)) { this.line('note', `(${itemName(D, it)} ${qtyOf(it) > 1 ? 'are' : 'is'} now in your pack.)`); return 1; }
    it.tx = Math.floor(P.x); it.ty = Math.floor(-P.z); it.fx = it.fy = 3; it.z = Math.max(0, Math.min(127, Math.round(P.y * 32))); it.lvl = g.L.n;
    g.L.objs.push(it); this.dirty = true;
    this.line('note', `(Your pack is full: ${itemName(D, it)} ${qtyOf(it) > 1 ? 'are' : 'is'} at your feet.)`);
    return 2;
  }
  fromPlayer(it: ObjRec): boolean {
    const k = this.game.inv.remove(it);
    if (!k) return false;
    if (k !== 'held') { const s = this.tr.pl.indexOf(k); if (s >= 0) this.tr.pl[s] = null; }
    return true;
  }
  giveNpc(it: ObjRec): void { this.fromPlayer(it); npcInv(this.game, this.o).unshift(it); }

  // ----- trading (conversationtrade.cs): six slots a side; your offer is things still in your pack, marked for trade -----
  tradeSel(side: 'npc' | 'pl'): ObjRec[] {
    const t = this.tr;
    return side === 'npc' ? (t.npc.filter((o, i) => o && t.npcSel[i]) as ObjRec[]) : (t.pl.map(k => k && this.game.inv.get(k)).filter(Boolean) as ObjRec[]);
  }
  /** Item value = COMOBJ value x quality/64 x quantity (the reference counts one of a stack; we count all), likes x1.5, dislikes 0. */
  itemValue(o: ObjRec, likes: boolean, acc: number): number {
    let v = objValue(this.game.data, o.id);
    const q = o.id === 0xa0 ? 63 : o.q, t = this.tr, m = this.vm.mem;
    if (likes) {
      const cat = o.id >> 4;
      const hit = (a: number) => { if (!a) return false; for (let p = a; p < a + 64 && p < m.length && m[p] !== -1; p++) { const e = m[p]!; if (e >= 1000 ? cat === e - 1000 : e === o.id) return true; } return false; };
      if (hit(t.dislikes)) return 0;
      if (hit(t.likes)) v = Math.floor(v * 1.5);
    }
    v = (v * q) >> 6; v *= qtyOf(o);
    if (acc) v += Math.floor((v * (-acc + randInt(this.game.rng, 2 * acc + 1))) / 100);
    return v;
  }
  sideValue(side: 'npc' | 'pl', likes: boolean, acc: number): number { return this.tradeSel(side).reduce((a, o) => a + this.itemValue(o, likes, acc), 0); }
  swapTrade(): void {
    const D = this.game.data, give = this.tradeSel('pl'), get = this.tradeSel('npc');
    for (const it of get) this.takeFromNpc(it);
    for (const it of give) this.giveNpc(it);
    for (const it of get) this.toPlayer(it);
    if (give.length || get.length) this.line('note', `(${give.length ? 'You hand over ' + give.map(o => itemName(D, o)).join(', ') + '. ' : ''}${get.length ? 'You receive ' + get.map(o => itemName(D, o)).join(', ') + '.' : ''})`);
    this.tr.npcSel.fill(false);
    this.game.ui.inventoryChanged(); this.renderTrade();
  }
  setupBarter(): void {
    const t = this.tr, inv = npcInv(this.game, this.o), rr = (n: number) => randInt(this.game.rng, n);
    t.npc.fill(null); t.npcSel.fill(false); t.on = true;
    let slot = 0, skipW = false, many = false;
    for (const it of inv.slice(0, 40)) {
      let skip = false;
      if (!skipW && it.id >> 4 === 0) { skipW = true; skip = true; } // keeps its own weapon
      if (!objValue(this.game.data, it.id)) skip = true;
      if (many && rr(7) < 5) skip = true;
      if (!skip) { t.npc[slot++] = it; if (slot >= TRADE_SLOTS) { many = true; slot = 0; } }
    }
    this.renderTrade();
  }
  renderTrade(): void {
    const t = this.tr, inv = this.game.inv;
    if (!t.on) { this.view.trade(null); return; }
    const offered = new Set(t.pl.filter(Boolean));
    const view: TradeView = {
      theirs: t.npc.slice(), theirsSel: t.npcSel.slice(), offer: t.pl.map(k => (k ? inv.get(k) : null)),
      pack: SLOT_KEYS.filter(k => inv.get(k) && !offered.has(k)).map(k => ({ key: k, o: inv.get(k)! })),
    };
    this.view.trade(view);
  }
  toggleTheirs(i: number): void { this.tr.npcSel[i] = !this.tr.npcSel[i]; this.renderTrade(); }
  withdrawOffer(i: number): void { this.tr.pl[i] = null; this.renderTrade(); }
  offer(k: SlotKey): void { const s = this.tr.pl.findIndex(x => !x); if (s >= 0) { this.tr.pl[s] = k; this.renderTrade(); } }

  // ----- flow -----
  step(st: VmState): void {
    const vm = this.vm;
    if (st === 'menu') { this.view.prompt({ kind: 'menu', options: vm.menu ?? [] }); return; }
    if (st === 'more') { this.view.prompt({ kind: 'more' }); return; }
    if (st === 'ask') { this.view.prompt({ kind: 'ask' }); return; }
    // done or error: commit what the program changed, then offer the way out
    if (st === 'error') { console.warn('conversation', this.who, vm.err); this.line('note', `(The conversation breaks off here: the engine could not follow it. ${vm.err})`); }
    this.end();
    this.view.prompt({ kind: 'leave' });
  }
  choose(k: number): void {
    if (this.over) return;
    const op = this.vm.menu?.[k];
    if (!op) return;
    this.line('you', op.text);
    this.step(this.vm.answer(op.value));
  }
  ask(t: string): void {
    if (this.vm.state !== 'ask') return;
    this.echo = t;
    this.step(this.vm.answer(t || ''));
    if (this.echo != null) this.line('note', '');
  }
  more(): void { if (!this.over) this.step(this.vm.answer(0)); }

  /** Writes the talker's changed state back (attitude, goal, target, talked-to, hp, home) and keeps the private globals. */
  end(): void {
    if (this.over) return;
    this.over = true;
    const m = this.vm.mem, n = this.o.npc;
    if (n) { n.goal = m[20]! & 15; n.att = m[21]! & 3; n.gtarg = m[22]! & 255; n.talked = m[23] ? 1 : 0; n.hp = Math.max(0, m[17]!); n.xhome = m[12]! & 63; n.yhome = m[13]! & 63; }
    this.game.conv.g[this.who] = Array.from(m.subarray(31, this.vm.cv.G));
    this.tr.on = false; this.renderTrade();
  }
}

/** Every object this level's programs can name by index. */
function indexLevel(game: Game): Map<number, ObjRec> {
  const L = game.L, m = new Map<number, ObjRec>();
  for (const o of L.all) m.set(o.i, o);
  for (const list of [L.objs, L.doors, L.props]) for (const o of list) if (o.lvl === L.n) m.set(o.i, o);
  for (const o of L.objs) if (o.items) for (const it of o.items) if (it.lvl === L.n && it.i > 0) m.set(it.i, it);
  for (const it of game.inv.all()) if (it.lvl === L.n && it.i > 0) m.set(it.i, it);
  return m;
}

/** Opens a conversation with the NPC behind pick target sp. */
export function startTalk(game: Game, sp: Pick): void {
  const D = game.data, L = game.L, o = sp.o, P = game.pose;
  const convs = D.conversations();
  if (!convs) { game.say('Conversations need CNV.ARK: choose Forget data in Options, then your disc image again.'); return; }
  if (!o.npc && o.i >= 0 && o.i < 256 && o.id >= 0x40 && o.id < 0x80) o.npc = readNpc(D.levels[L.n]!, 0x4000 + o.i * 27); // objects from saves made before NPC data was kept
  const E = eye(game);
  if (Math.hypot(sp.c[0] - E[0], sp.c[2] - E[2]) > 4) { game.say(S1(D, 107) || 'You cannot reach that.'); return; }
  const who = o.npc?.who ?? 0, cv = who ? convs[who] ?? null : null;
  if (!cv || who === 255) { game.say((D.str(7, 1) || 'You get no response.').trim()); return; }
  const n = o.npc!, name = npcName(D, who, o), strings = D.block(cv.strBlock);
  const pl = game.stats ?? discPlayer(D);
  const c = sp.crit ?? L.critters.find(k => k.o === o) ?? null;
  if (c) { c.ang = Math.atan2(P.x - c.x, -P.z - c.y); c.walking = false; }
  game.ui.releasePointer();
  const session = new TalkSession(game, o, c, who, name, s => {
    const vm = new ConvVM(cv, strings, {
      rng: game.rng,
      female: () => !!game.stats?.sex,
      gstr: (b, i) => D.block(b)[i],
      fn: (fname, v, ptrs, vmm) => convBuiltin(s, fname, v, ptrs, vmm),
      print: t => s.line('narr', t),
      say: t => { const y = /^\s*\\1([\s\S]*?)\\0\s*$/.exec(t); if (y) s.line('you', y[1]!); else s.line('npc', t.replace(/\\[01]/g, '')); },
    });
    vm.quests = game.conv.q; vm.clocks = game.conv.c;
    const m = vm.mem, M = game.minutes;
    // imported variables 0-30 (the talker's live values and the Avatar's)
    const imp = [0, pl.vit[0], 0, 0, pl.vit[0], pl.mana[0], pl.level || 1, 0, vm.newStr(pl.name || 'Avatar'), 0, 0, pl.sex | 0,
      n.xhome, n.yhome, who, n.hunger, n.hp, n.hp, 0, 0, n.goal, n.att, n.gtarg, n.talked, n.level, vm.newStr(name), L.n + 1, 0, M & 0x7fff, Math.floor(M / 1440), Math.floor(M) % 1440];
    imp.forEach((v, i) => (m[i] = v | 0));
    const saved = game.conv.g[who];
    if (saved) saved.forEach((v, i) => { if (31 + i < cv.G) m[31 + i] = v; });
    return vm;
  });
  game.talk = session;
  session.view.open({ name: pl.name || 'Avatar', body: pl.body | 0 });
  session.setTalker(who);
  session.renderTrade();
  game.say('');
  session.step(session.vm.run());
}

/** Closes the talk: commits it, then applies the world effects the program queued. */
export function closeTalk(game: Game): void {
  const s = game.talk;
  if (!s) return;
  s.end();
  game.talk = null;
  s.view.close();
  const { o, c } = s, L = game.L, P = game.pose;
  if (c) c.wait = 1 + game.rng() * 2;
  let rebuild = false, refresh = s.dirty;
  for (const f of s.fx) {
    if (f.k === 'remove') {
      const i = L.objs.indexOf(o);
      if (i >= 0) L.objs.splice(i, 1);
      L.critters = L.critters.filter(k => k.o !== o);
      refresh = true;
    } else if (f.k === 'transform') rebuild = true;
    else if (f.k === 'talker' && c && game.level!.tileAt(f.x, f.y)?.type) {
      c.x = c.hx = f.x + 0.5; c.y = c.hy = f.y + 0.5; o.tx = f.x; o.ty = f.y; o.fx = o.fy = 3;
      c.h = supportAt(L, c.x, c.y, 9) ?? c.h;
      if (o.npc) { o.npc.xhome = f.x; o.npc.yhome = f.y; }
      refresh = true;
    } else if (f.k === 'player' && game.data.levels[f.lv]) {
      const t = game.data.levels[f.lv]![(f.y * 64 + f.x) * 4]! & 15;
      if (!t) continue;
      const yaw = P.yaw;
      if (f.lv !== game.L.n) game.goLevel(f.lv, false);
      game.teleport(f.x, f.y);
      P.yaw = yaw;
      game.ui.levelChanged(game.L.n);
    }
  }
  if (rebuild) game.rebuildCreatures();
  else if (refresh) game.refreshAll();
  game.ui.inventoryChanged(); game.ui.playerChanged();
}

