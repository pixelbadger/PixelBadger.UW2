import type { Game } from '../game/game';
import { act, talkTo, tryGet } from '../game/interact';
import { pick } from '../game/picking';
import { closeTalk } from '../game/talk';
import { beginSwing, releaseSwing, swingAt, type SwingType } from '../game/combat';
import { RUNE_BAG, castShelf } from '../game/magic';
import { $ } from './dom';

export interface ControlHooks {
  toggleMap(): void;
  togglePanel(): void;
  cycleLight(): void;
  closeOverlays(): void;
  talkKey(e: KeyboardEvent): void;
  openRunes(): void;
  /** Keys for a showing cutscene; true when it took the key. */
  cutsKey(e: KeyboardEvent): boolean;
}

/**
 * Keyboard, mouse and touch. Keys: WASD/arrows move, Q/arrows turn, Shift run, J jump, E/Space act (current mode),
 * G get, T talk, I inventory, M map, L light, PageUp/PageDown level, Esc closes. Fighting (the original's keys and
 * mouse): hold to draw back, let go to strike; P bash, ; slash, . stab in any mode; in fight mode the mouse button or
 * Space/E (slash, or by height on the view when the pointer is free). C casts the shelf's spell, R opens the rune bag.
 * Pointer lock: a click on the view locks; any UI that needs a cursor releases it; holding an item, a click drops it
 * where clicked instead. Touch: left side is a move stick, right side looks, a tap acts; in fight mode a press on the
 * right side draws back (dragging to look cancels it) and lifting strikes.
 */
export class Controls {
  private keys = new Set<string>();
  private joy: { id: number; dx: number; dy: number } | null = null;
  /** Where the current swing or shot aims (screen -1..1), and the key or touch that started it. */
  private aim: [number, number] = [0, 0];
  private swingBy: string | number | null = null;

  constructor(private readonly game: Game, private readonly hooks: ControlHooks) {
    const cv = $<HTMLCanvasElement>('#view');
    addEventListener('keydown', e => this.keydown(e));
    addEventListener('keyup', e => { this.keys.delete(e.code); if (this.swingBy === e.code) this.endSwing(); });
    addEventListener('blur', () => { this.keys.clear(); if (this.swingBy !== null) this.endSwing(); });
    const fighting = () => game.mode === 'fight' && !game.inv.held && !game.magic.pending;
    cv.addEventListener('mousedown', e => {
      const r = cv.getBoundingClientRect(), locked = document.pointerLockElement === cv;
      const nx = locked ? 0 : ((e.clientX - r.left) / r.width) * 2 - 1, ny = locked ? 0 : -(((e.clientY - r.top) / r.height) * 2 - 1);
      if (fighting()) { this.startSwing(swingAt(ny), 'mouse', [nx, ny]); return; }
      if (locked) act(game, 0, 0);
      else if (game.inv.held) { const r = cv.getBoundingClientRect(); act(game, ((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1)); }
      else cv.requestPointerLock?.();
    });
    addEventListener('mouseup', () => { if (this.swingBy === 'mouse') this.endSwing(); });
    addEventListener('mousemove', e => {
      if (document.pointerLockElement !== cv) return;
      const P = game.pose;
      P.yaw += e.movementX * 0.0025;
      P.pitch = Math.max(-1.2, Math.min(1.2, P.pitch - e.movementY * 0.0025));
    });
    const tp = new Map<number, { left: boolean; x0: number; y0: number; x: number; y: number; t0: number; moved: number }>();
    cv.addEventListener('touchstart', e => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        const left = t.clientX < innerWidth * 0.45;
        tp.set(t.identifier, { left, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY, t0: performance.now(), moved: 0 });
        if (left && !this.joy) { this.joy = { id: t.identifier, dx: 0, dy: 0 }; this.showStick(t.clientX, t.clientY, 0, 0); }
        if (!left && fighting() && this.swingBy === null) { const r = cv.getBoundingClientRect(), nx = ((t.clientX - r.left) / r.width) * 2 - 1, ny = -(((t.clientY - r.top) / r.height) * 2 - 1); this.startSwing(swingAt(ny), t.identifier, [nx, ny]); }
      }
    }, { passive: false });
    cv.addEventListener('touchmove', e => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        const s = tp.get(t.identifier);
        if (!s) continue;
        const dx = t.clientX - s.x, dy = t.clientY - s.y;
        s.moved += Math.abs(dx) + Math.abs(dy); s.x = t.clientX; s.y = t.clientY;
        if (this.joy && this.joy.id === t.identifier) {
          let jx = (t.clientX - s.x0) / 55, jy = (t.clientY - s.y0) / 55;
          const m = Math.hypot(jx, jy);
          if (m > 1) { jx /= m; jy /= m; }
          this.joy.dx = jx; this.joy.dy = jy; this.showStick(s.x0, s.y0, jx, jy);
        } else if (!s.left) {
          if (this.swingBy === t.identifier && s.moved >= 12) { this.swingBy = null; game.swing.stage = 'idle'; game.swing.charge = 0; } // looking, not fighting
          const P = game.pose; P.yaw += dx * 0.006; P.pitch = Math.max(-1.1, Math.min(1.1, P.pitch - dy * 0.006)); }
      }
    }, { passive: false });
    const end = (e: TouchEvent) => {
      for (const t of e.changedTouches) {
        const s = tp.get(t.identifier);
        tp.delete(t.identifier);
        if (!s) continue;
        if (this.joy && this.joy.id === t.identifier) { this.joy = null; this.hideStick(); }
        if (this.swingBy === t.identifier) { this.endSwing(); continue; }
        if (!s.left && s.moved < 12 && performance.now() - s.t0 < 350) { const r = cv.getBoundingClientRect(); act(game, ((t.clientX - r.left) / r.width) * 2 - 1, -(((t.clientY - r.top) / r.height) * 2 - 1)); }
      }
    };
    cv.addEventListener('touchend', end); cv.addEventListener('touchcancel', end);
    const bj = $('#bJump');
    bj.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); game.input.jump = true; }, { passive: false });
    bj.onclick = () => { game.input.jump = true; };
    $<HTMLFormElement>('#tAskF').onsubmit = e => { e.preventDefault(); game.talk?.ask($<HTMLInputElement>('#tAsk').value.trim()); };
    $('#tAsk').addEventListener('keydown', e => { e.stopPropagation(); if (e.code === 'Escape') closeTalk(game); });
  }

  private keydown(e: KeyboardEvent): void {
    const game = this.game, h = this.hooks;
    if (h.cutsKey(e)) { this.keys.clear(); return; }
    if (game.talk) { h.talkKey(e); return; }
    if (e.code === 'Escape') { h.closeOverlays(); return; }
    if ((e.target as HTMLElement).tagName === 'SELECT') return;
    this.keys.add(e.code);
    if (e.code === 'KeyT' && !e.repeat) talkTo(game, pick(game, 0, 0));
    if (e.code === 'KeyM') h.toggleMap();
    const SWING_KEYS: Record<string, SwingType> = { KeyP: 1, Semicolon: 0, Period: 2 };
    if (e.code in SWING_KEYS && !e.repeat && !game.inv.held) { this.startSwing(SWING_KEYS[e.code]!, e.code, [0, 0]); return; }
    if (e.code === 'KeyE' || e.code === 'Space') {
      e.preventDefault();
      if (game.mode === 'fight' && !game.inv.held && !game.magic.pending) { if (!e.repeat) this.startSwing(0, e.code, [0, 0]); }
      else act(game, 0, 0);
    }
    if (e.code === 'KeyC' && !e.repeat) castShelf(game);
    if (e.code === 'KeyR' && !e.repeat) { if (game.inv.all().some(o => o.id === RUNE_BAG)) h.openRunes(); else game.say('You have no rune bag.'); }
    if (e.code === 'KeyG' && !e.repeat) { if (game.inv.held) act(game, 0, 0); else tryGet(game, pick(game, 0, 0)); }
    if (e.code === 'KeyI' && !e.repeat) h.togglePanel();
    if (e.code === 'KeyL') h.cycleLight();
    if (e.code === 'KeyJ' && !e.repeat) game.input.jump = true;
    if (e.code === 'PageDown' || e.code === 'PageUp') game.stepLevel(e.code === 'PageDown' ? 1 : -1);
  }

  /** Drops held keys and the stick (a talk opened, the window lost focus). */
  reset(): void { this.keys.clear(); this.joy = null; this.hideStick(); this.swingBy = null; }

  private startSwing(type: SwingType, by: string | number, aim: [number, number]): void {
    if (this.swingBy !== null) return;
    beginSwing(this.game, type);
    if (this.game.swing.stage === 'charging') { this.swingBy = by; this.aim = aim; }
  }
  private endSwing(): void { this.swingBy = null; releaseSwing(this.game, this.aim); }

  /** Turns held keys and the stick into this frame's movement intent. */
  poll(): void {
    const k = this.keys, inp = this.game.input;
    let f = 0, s = 0, turn = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) f += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) f -= 1;
    if (k.has('KeyD')) s += 1;
    if (k.has('KeyA')) s -= 1;
    if (k.has('ArrowLeft') || k.has('KeyQ')) turn -= 1;
    if (k.has('ArrowRight')) turn += 1;
    if (this.joy) { f -= this.joy.dy; s += this.joy.dx; }
    inp.forward = f; inp.strafe = s; inp.turn = turn; inp.run = k.has('ShiftLeft') || k.has('ShiftRight');
  }

  private showStick(x: number, y: number, jx: number, jy: number): void {
    const s = $('#stick');
    s.hidden = false; s.style.left = x + 'px'; s.style.top = y + 'px';
    (s.firstElementChild as HTMLElement).style.transform = `translate(${jx * 34}px,${jy * 34}px)`;
  }
  private hideStick(): void { $('#stick').hidden = true; }
}
