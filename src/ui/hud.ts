import { S1, levelName } from '../data/text';
import type { Game, Mode } from '../game/game';
import { closeContainer, slotClick } from '../game/interact';
import { BAG, isStack, qty, type SlotKey } from '../game/inventory';
import { carried, carryLimit, putInto } from '../game/items';
import type { AudioOut } from './audio';
import type { CutsceneEnd, TalkView, UiPort } from '../game/ports';
import { RUNE_STONE, cancelEffect, castShelf, clearShelf, runeName, selectRune } from '../game/magic';
import type { Art } from './art';
import type { CutsceneView } from './cutscene';
import { $, el, releasePointer } from './dom';

// The in-game interface in the original's style, modernised: command icons that set a mode, flasks, compass, the
// scroll message strip and the paperdoll panel with its pull chain, all drawn from the disc's art, laid over a
// full-bleed responsive view. Pixel art is drawn at native size and scaled with image-rendering: pixelated.

const CMDS: [Mode | 'options', string][] = [['options', 'Options'], ['talk', 'Talk'], ['get', 'Get'], ['look', 'Look'], ['fight', 'Fight'], ['use', 'Use']];
/** Paperdoll/bag slot centres on PANELS.GR 0 (panel pixels). */
/** Rune places on PANELS.GR 1 (panel pixels; after UnderworldGodot's layout of the same art), 4 across, 6 down; and the "put runes away" strip. */
const RUNE_X = [15.5, 32.1, 49.3, 65.7], RUNE_Y = [12.8, 27.5, 42.1, 56.8, 71.5, 86.5], RUNES_AWAY = { x0: 20, x1: 60.5, y0: 92.4, y1: 108.1 };
/** SPELLS.GR icon for an effect: base by major class (UW2's table from the executable; -1 means minor - 1), + minor. */
const SPELL_ICON = [0x14, -1, 0x13, 0x05, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x11, 0x80, 0x80, 0x80, 0x80];
/** Shoulder, hand and bag slot centres on PANELS.GR 0 (panel pixels). */
const SLOTS: [SlotKey, number, number][] = [['shl', 16.5, 12.5], ['shr', 64.5, 12.5], ['hl', 12.5, 35], ['hr', 68, 35],
  ...[12.5, 31, 50, 68].map((x, i): [SlotKey, number, number] => [('b' + i) as SlotKey, x, 80.5]), ...[12.5, 31, 50, 68].map((x, i): [SlotKey, number, number] => [('b' + (i + 4)) as SlotKey, x, 99.5])];
/**
 * The paperdoll's worn pieces: where ARMOR_M/F.GR art is drawn (top left) and the areas that take a tap (centre and
 * half sizes), from UnderworldGodot's layout of the same art, placed relative to the body picture (BODIES.GR at 22, 3).
 * Rings show their OBJECTS.GR icon centred. Gloves have one area per hand.
 */
const BODY_AT = [22, 3] as const;
const DOLL: { k: SlotKey; art?: [number, number]; hit: [number, number, number, number][] }[] = [
  { k: 'rgl', hit: [[24.25, 51, 7, 7]] }, { k: 'rgr', hit: [[55.25, 51, 7, 7]] },
  { k: 'gloves', art: [1, 33], hit: [[29, 44.75, 4, 4], [51, 44.75, 4, 4]] },
  { k: 'helm', art: [7.25, 0], hit: [[39.25, 13, 8, 8]] },
  { k: 'legs', art: [8, 13], hit: [[40, 52.25, 6.25, 11.25]] },
  { k: 'body', art: [2.25, 12], hit: [[39.25, 30.25, 8.75, 10]] },
  { k: 'boots', art: [6, 55], hit: [[38.5, 65, 10.5, 7]] },
];
/** An open container's picture (a tap closes it) and the scroll arrows (BUTTONS.GR 27 up, 28 down). */
const OPENED = [13.5, 65] as const, ARROWS = [[62.5, 65], [72.5, 65]] as const;
/** The weight still carriable, in stones (centred there in the 5x6 font). */
const WEIGHT_AT = [69.5, 47] as const;
/** Draw order: legs, boots, body, gloves, helm (the helm and gloves over the armour). */
const DRAW_ORDER: SlotKey[] = ['legs', 'boots', 'body', 'gloves', 'helm'];

/** ARMOR_M/F.GR picture for a worn item (the original's wearable.GetSpriteIndex; the circlet continues its run). */
export function armourArt(id: number, q: number): number {
  if (id >= 0x30 && id <= 0x34) return 61 + (id & 15);
  if ((id & 15) < 15) return (q >> 4) * 15 + (id & 15);
  return 60;
}

export class Hud implements UiPort {
  private msgTimer = 0;
  private compK = -1;
  panelPage = 0;
  private skillPage = 0;
  /** UI scale (3 desktop, 2 touch/narrow) and panel scale. */
  u = 3;
  ps = 3;
  onOptions: () => void = () => {};
  onVictory: () => void = () => {};
  onDied: () => void = () => {};
  cuts: CutsceneView | null = null;
  audio: AudioOut | null = null;
  /** The eyes: frame shown, frame heading for, seconds since the last blow, step timer. Power gem frame drawn. */
  private eye = { cur: 0, to: 0, since: 0, step: 0 };
  private powerK = -1;
  private hurtTimer = 0;

  constructor(private readonly game: Game, private readonly art: Art, readonly talk: TalkView) {}

  // ---------- UiPort ----------
  say(t: string): void {
    const m = $('#msg');
    m.textContent = t; m.style.opacity = t ? '1' : '0';
    clearTimeout(this.msgTimer);
    if (t) this.msgTimer = window.setTimeout(() => (m.style.opacity = '0'), 3200);
  }
  levelChanged(n: number): void { $<HTMLSelectElement>('#lvl').value = String(n); $('#where').textContent = levelName(n); }
  inventoryChanged(): void { this.drawPanel(); this.updateHeld(); }
  playerChanged(): void { this.drawPanel(); this.drawFlasks(); }
  showText(t: string, title = ''): void {
    releasePointer();
    const box = $('#scroll');
    box.querySelector('h2')!.textContent = title ? title[0]!.toUpperCase() + title.slice(1) : '';
    box.querySelector('.sheet>div')!.textContent = t.replace(/\\n/g, '\n');
    box.hidden = false;
    this.say('');
  }
  releasePointer(): void { releasePointer(); }
  cutscene(n: number): Promise<CutsceneEnd> { return this.cuts ? this.cuts.play(n) : Promise.resolve('done'); }
  victory(): void { this.onVictory(); }
  magicChanged(): void {
    this.drawShelf(); this.drawSpells();
    if (this.panelPage === 2) this.drawPanel();
    $('#crosshair').classList.toggle('aim', !!this.game.magic.pending);
  }
  /** The original's eyes: frames 5-7 as the foe weakens; they close again 10 seconds after the last blow. */
  foeHealth(hp: number, max: number): void {
    const n = this.art.eyes?.length ?? 0;
    this.eye.to = Math.min(n - 1, 4 + 3 - Math.min(2, Math.trunc((hp * 3) / Math.max(1, max))));
    this.eye.since = 0;
  }
  hurt(n: number): void {
    const h = $('#hurt');
    h.style.opacity = String(Math.min(0.55, 0.15 + n / 30));
    clearTimeout(this.hurtTimer);
    this.hurtTimer = window.setTimeout(() => (h.style.opacity = '0'), 120);
  }
  died(): void { releasePointer(); this.onDied(); }
  sound(id: number, vol: number, pan: number): void { this.audio?.sound(id, vol, pan); }
  music(theme: number, loop: boolean): void { this.audio?.music(theme, loop); }

  // ---------- set-up ----------
  init(): void {
    const A = this.art, root = document.documentElement.style;
    if (A.panels) { const c = el('canvas', { width: 20, height: 12 }); c.getContext('2d')!.drawImage(A.canvas(A.panels[0]!), -30, -57); root.setProperty('--stone-bg', `url(${c.toDataURL()})`); }
    if (A.chr?.[0] && A.chr[3]) { root.setProperty('--btn-bg', `url(${A.url(A.chr[0])})`); root.setProperty('--sq-bg', `url(${A.url(A.chr[3])})`); }
    if (A.scr?.[0]) { root.setProperty('--scroll-l', `url(${A.url(A.scr[0])})`); root.setProperty('--scroll-r', `url(${A.url(A.scr[10] ?? A.scr[0])})`); }
    const bag = this.game.data.objImgs[0x80];
    if (bag) $<HTMLImageElement>('#bBag img').src = A.url(bag); else $('#bBag').textContent = 'Pack';
    if (A.chains?.[0]) $<HTMLImageElement>('#chain img').src = A.url(A.chains[0]); else $('#chain').textContent = '⇅';
    const nav = $('#cmds');
    nav.replaceChildren();
    CMDS.forEach(([k, label], i) => {
      const b = el('button', { title: label, 'aria-label': label, 'data-k': k });
      if (A.lfti?.[i * 2]) b.append(el('img', { className: 'px', alt: '' }));
      else { b.className = 'txt'; b.textContent = label; }
      b.onclick = () => { if (k === 'options') { releasePointer(); this.onOptions(); } else this.setMode(k); };
      nav.append(b);
    });
    this.setMode('use');
    this.layout(); this.updateHeld(); this.drawPanel(); this.drawFlasks();
    $('#bBag').onclick = () => this.togglePanel();
    $('#chain').onclick = () => { this.panelPage = this.panelPage === 0 ? 1 : 0; this.drawPanel(); };
    $('#pcv').addEventListener('pointerdown', e => { if (e.pointerType !== 'touch') this.panelClick(e); else this.press = { t: performance.now(), x: e.clientX, y: e.clientY }; });
    $('#pcv').addEventListener('pointerup', e => { // touch: a tap acts, a long press picks up
      const p = this.press;
      this.press = null;
      if (e.pointerType !== 'touch' || !p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 12) return;
      this.panelClick(e, performance.now() - p.t > 450);
    });
    $('#pcv').addEventListener('contextmenu', e => e.preventDefault());
    $('#shelf').onclick = () => castShelf(this.game);
    $('#spells').querySelectorAll('canvas').forEach((c, k) => ((c as HTMLCanvasElement).onclick = () => { if (this.game.mode === 'look') this.say('A spell is at work on you.'); else cancelEffect(this.game, k); }));
    this.drawShelf(); this.drawSpells();
    const e0 = this.art.eyes?.[0];
    if (e0) { const c = $<HTMLCanvasElement>('#eyes'); c.width = e0.w; c.height = e0.h; c.getContext('2d')!.drawImage(this.art.canvas(e0), 0, 0); }
    $('#compass').onclick = () => { const d = S1(this.game.data, 40 + ((Math.round(this.game.pose.yaw / (Math.PI / 4)) % 8) + 8) % 8); this.say(d ? `You are facing ${d.replace(/^to the /, '').toLowerCase()}.` : ''); };
    addEventListener('resize', () => this.layout());
  }

  setMode(k: Mode): void {
    this.game.mode = k;
    const A = this.art;
    [...$('#cmds').children].forEach((b, i) => {
      const on = (b as HTMLElement).dataset.k === k;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
      const im = b.querySelector('img');
      if (im && A.lfti) im.src = A.url(A.lfti[i * 2 + (on ? 1 : 0)]);
    });
    if (k !== 'use') this.say({ look: 'Look: click something to examine it.', get: 'Get: click something to pick it up.', talk: 'Talk: click someone to speak with them.', fight: 'Fight: hold to draw back, let go to strike (high bashes, middle slashes, low stabs).' }[k] ?? '');
  }

  layout(): void {
    const A = this.art, small = innerWidth < 760 || matchMedia('(hover:none)').matches, u = small ? 2 : 3, root = document.documentElement.style;
    this.u = u; root.setProperty('--u', String(u));
    const cu = small ? Math.min(1.9, (innerWidth - 24) / (6 * 31)) : 2.4;
    $('#cmds').querySelectorAll('img').forEach((im, i) => { const s = A.lfti?.[i * 2]; if (s) im.style.width = s.w * cu + 'px'; });
    for (const id of ['#flaskH', '#flaskM']) { const c = $(id); if (A.flasks) c.style.width = 24 * u + 'px'; else c.hidden = true; }
    if (A.flasks) { root.setProperty('--fw', 24 * u + 'px'); root.setProperty('--fh', A.flasks[75]!.h * u + 'px'); }
    const cp = $('#compass');
    if (A.comp) cp.style.width = 52 * u + 'px'; else cp.hidden = true;
    if (A.scr?.[0]) root.setProperty('--scw', A.scr[0].w * u + 'px');
    const ps = Math.max(2, Math.min(4, Math.floor(Math.min((innerHeight - 140) / 112, (innerWidth - 40) / 79))));
    $('#pcv').style.width = 79 * ps + 'px'; this.ps = ps;
    if (A.chains) $('#chain img').style.width = 15 * ps * 0.8 + 'px'; // without CHAINS.GR the chain is a text button
    $('#held').style.width = 16 * u + 'px';
    $('#shelf').querySelectorAll('canvas').forEach(c => ((c as HTMLElement).style.width = 16 * u + 'px'));
    $('#spells').querySelectorAll('canvas').forEach(c => ((c as HTMLElement).style.width = 16 * u + 'px'));
    const pw = A.power?.[0], ey = A.eyes?.[0];
    $('#power').style.width = pw ? pw.w * u + 'px' : ''; $('#power').hidden = !pw;
    $('#eyes').style.width = ey ? ey.w * u + 'px' : ''; $('#eyes').hidden = !ey;
  }

  // ---------- flasks, compass, cursor ----------
  drawFlasks(): void {
    const A = this.art, fl = A.flasks;
    if (!fl) return;
    const pl = this.game.stats ?? { vit: [1, 1], mana: [0, 0] };
    ([[$<HTMLCanvasElement>('#flaskH'), pl.vit, 0], [$<HTMLCanvasElement>('#flaskM'), pl.mana, 1]] as const).forEach(([cv, [cur, max], k]) => {
      const g = fl[75]!, m = fl[76]!;
      cv.width = g.w; cv.height = g.h;
      const x = cv.getContext('2d')!;
      x.drawImage(A.canvas(g), 0, 0);
      const frac = max ? Math.max(0, Math.min(1, cur / max)) : 0, mk = m.bgMask ?? m.px;
      const liq = (xx: number, y: number) => !mk[y * m.w + xx] && g.px[y * g.w + xx];
      let y0 = g.h, y1 = 0;
      for (let y = 0; y < m.h; y++) for (let xx = 0; xx < m.w; xx++) if (liq(xx, y)) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const top = Math.round(y1 + 1 - frac * (y1 - y0 + 1)), c = A.liq[k]!, ct = A.liqTop[k]!;
      for (let y = top; y <= y1; y++) for (let xx = 0; xx < m.w; xx++) if (liq(xx, y)) { x.fillStyle = A.rgb(y === top ? ct : c); x.fillRect(xx, y, 1, 1); }
      cv.title = `${k ? 'Mana' : 'Vitality'} ${cur}/${max}`;
    });
  }

  /** COMPASS.GR 0-3 by quarter (0 assumed north). */
  drawCompass(): void {
    const comp = this.art.comp;
    if (!comp) return;
    const k = ((Math.round(this.game.pose.yaw / (Math.PI / 2)) % 4) + 4) % 4;
    if (k === this.compK || !comp[k]) return;
    this.compK = k;
    const im = comp[k]!, cv = $<HTMLCanvasElement>('#compass');
    cv.width = im.w; cv.height = im.h;
    cv.getContext('2d')!.drawImage(this.art.canvas(im), 0, 0);
  }

  updateHeld(): void {
    const h = $<HTMLImageElement>('#held'), held = this.game.inv.held, icon = held ? this.art.icon(held.id) : null;
    if (icon) { h.src = icon.toDataURL(); h.hidden = false; } else h.hidden = true;
  }

  // ---------- the panel: inventory (PANELS 0) or statistics (PANELS 2) ----------
  togglePanel(): void { const p = $('#panel'); p.hidden = !p.hidden; if (!p.hidden) { releasePointer(); this.drawPanel(); } }

  drawPanel(): void {
    const A = this.art, D = this.game.data, cv = $<HTMLCanvasElement>('#pcv'), x = cv.getContext('2d')!;
    x.imageSmoothingEnabled = false; x.clearRect(0, 0, 79, 112);
    $('#chain').setAttribute('aria-label', this.panelPage ? 'Show inventory' : 'Show character');
    const pl = this.game.stats;
    if (this.panelPage === 0) { this.drawInventory(x); return; }
    if (this.panelPage === 2) { this.drawRunes(x); return; }
    if (A.panels?.[2]) x.drawImage(A.canvas(A.panels[2]), 0, 0); else { x.fillStyle = '#2a2620'; x.fillRect(0, 0, 79, 112); }
    const v = A.ink;
    if (!pl) return;
    A.text(x, pl.name, 39.5, 3, v, 'center');
    if (pl.cls >= 0) A.text(x, D.str(2, 23 + pl.cls), 39.5, 10, v, 'center');
    const rows = [pl.str, pl.dex, pl.int, `${pl.vit[0]}/${pl.vit[1]}`, `${pl.mana[0]}/${pl.mana[1]}`, pl.exp ?? '-'];
    rows.forEach((r, i) => A.text(x, String(r), 73, 17 + i * 7, v, 'right'));
    const names = D.block(2).slice(51, 71), sk = pl.skills.map((n, i): [string, number] => [names[i] || '?', n]).filter(q => q[1] > 0);
    this.skillPage = Math.min(this.skillPage, Math.max(0, Math.ceil(sk.length / 6) - 1));
    sk.slice(this.skillPage * 6, this.skillPage * 6 + 6).forEach(([n, val], i) => {
      while (n.length > 3 && A.textW(n) > 58 - A.textW(String(val))) n = n.slice(0, -1);
      A.text(x, n, 7, 62 + i * 7, v); A.text(x, String(val), 73, 62 + i * 7, v, 'right');
    });
  }

  private press: { t: number; x: number; y: number } | null = null;

  private panelClick(e: PointerEvent, long = false): void {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * 79, py = ((e.clientY - r.top) / r.height) * 112;
    e.preventDefault();
    if (this.panelPage === 2) { this.runeClick(px, py); return; }
    if (this.panelPage === 1) { if (py > 101) { this.skillPage = Math.max(0, this.skillPage + (px < 39 ? -1 : 1)); this.drawPanel(); } return; }
    this.inventoryClick(px, py, { one: e.shiftKey, take: e.button === 2 || long });
  }

  /** The inventory page: panel, body, worn armour, rings, the eight bag places (or an open container's), weight. */
  private drawInventory(x: CanvasRenderingContext2D): void {
    const A = this.art, inv = this.game.inv, pl = this.game.stats;
    if (A.panels) x.drawImage(A.canvas(A.panels[0]!), 0, 0);
    else { x.fillStyle = '#2a2620'; x.fillRect(0, 0, 79, 112); x.strokeStyle = '#6a6254'; for (const [, sx, sy] of SLOTS) { x.beginPath(); x.arc(sx, sy, 7.5, 0, 7); x.stroke(); } }
    const bd = A.bodies?.[pl?.body ?? 0];
    if (bd) x.drawImage(A.canvas(bd), BODY_AT[0], BODY_AT[1]);
    const female = pl ? pl.sex === 1 || pl.body >= 5 : false, art = A.armour[female ? 1 : 0];
    for (const k of DRAW_ORDER) {
      const o = inv.get(k), d = DOLL.find(q => q.k === k)!, im = o ? art?.[armourArt(o.id, o.q)] : null;
      if (o && im && d.art) x.drawImage(A.canvas(im), Math.round(BODY_AT[0] + d.art[0]), Math.round(BODY_AT[1] + d.art[1]));
      else if (o) this.icon(x, o.id, d.hit[0]![0], d.hit[0]![1]); // no armour art: the item's own icon
    }
    for (const k of ['rgl', 'rgr'] as const) { const o = inv.get(k); if (o) this.icon(x, o.id, DOLL.find(q => q.k === k)!.hit[0]![0], 51); }
    const open = inv.container;
    for (const [k, sx, sy] of SLOTS) {
      const bag = BAG.indexOf(k as never), o = bag >= 0 ? inv.bagAt(bag) : inv.get(k);
      if (!o) continue;
      this.icon(x, o.id, sx, sy);
      if (isStack(o) && qty(o) > 1) this.qtyLabel(x, qty(o), sx, sy);
    }
    if (open) {
      this.icon(x, open.id, OPENED[0], OPENED[1]);
      const B = A.buttons;
      ARROWS.forEach(([ax, ay], i) => { const im = B?.[27 + i]; if (im) x.drawImage(A.canvas(im), Math.round(ax - im.w / 2), Math.round(ay - im.h / 2)); else A.text(x, i ? 'v' : '^', ax, ay - 3, A.ink || 15, 'center'); });
    }
    if (pl) A.text(x, String(Math.max(0, Math.floor((carryLimit(this.game) - carried(this.game)) / 10))), WEIGHT_AT[0], WEIGHT_AT[1], A.ink || 15, 'center');
  }

  private icon(x: CanvasRenderingContext2D, id: number, cx: number, cy: number): void {
    const c = this.art.icon(id);
    if (c) x.drawImage(c, Math.round(cx - c.width / 2), Math.round(cy - c.height / 2));
  }

  private qtyLabel(x: CanvasRenderingContext2D, n: number, cx: number, cy: number): void {
    const A = this.art, t = String(n), w = A.textW(t);
    x.fillStyle = 'rgba(0,0,0,.55)'; x.fillRect(Math.round(cx + 8 - w) - 1, Math.round(cy + 1), w + 1, 7);
    A.text(x, t, cx + 8, cy + 2, A.ink || 15, 'right');
  }

  /** A tap on the inventory page at panel pixel (px, py). */
  inventoryClick(px: number, py: number, o: { one?: boolean; take?: boolean } = {}): void {
    const g = this.game, inv = g.inv;
    if (inv.container) {
      if (Math.hypot(px - OPENED[0], py - OPENED[1]) < 8) {
        if (!inv.held) closeContainer(g);
        else if (putInto(g, inv.container, inv.held)) { inv.held = null; g.ui.inventoryChanged(); }
        return;
      }
      const ar = ARROWS.findIndex(([ax, ay]) => Math.abs(px - ax) < 5 && Math.abs(py - ay) < 6);
      if (ar >= 0) { inv.scrollBy(ar ? 1 : -1); this.drawPanel(); return; }
    }
    const sl = SLOTS.find(([, sx, sy]) => Math.hypot(sx - px, sy - py) < 9);
    if (sl) { if (slotClick(g, { slot: sl[0] }, o) === 'runes') this.openRunes(); return; }
    let best: SlotKey | null = null, bd = Infinity;
    for (const d of DOLL) for (const [cx, cy, hw, hh] of d.hit) {
      const nx = (px - cx) / hw, ny = (py - cy) / hh, dd = Math.max(Math.abs(nx), Math.abs(ny));
      if (dd <= 1 && dd < bd) { bd = dd; best = d.k; }
    }
    if (best) { if (slotClick(g, { slot: best }, o) === 'runes') this.openRunes(); }
  }

  // ---------- magic: the rune bag (PANELS 1), the shelf, active spells ----------
  /** Shows the rune bag in the panel. */
  openRunes(): void { this.panelPage = 2; $('#panel').hidden = false; releasePointer(); this.drawPanel(); }

  private drawRunes(x: CanvasRenderingContext2D): void {
    const A = this.art, m = this.game.magic;
    if (A.panels?.[1]) x.drawImage(A.canvas(A.panels[1]), 0, 0);
    else { x.fillStyle = '#2a2620'; x.fillRect(0, 0, 79, 112); A.text(x, 'Put runes away', 39.5, 98, A.ink || 15, 'center'); }
    for (let r = 0; r < 24; r++) {
      const c = m.runes[r] ? A.icon(RUNE_STONE + r) : null;
      if (c) x.drawImage(c, Math.round(RUNE_X[r & 3]! - c.width / 2), Math.round(RUNE_Y[r >> 2]! - c.height / 2));
    }
  }

  private runeClick(px: number, py: number): void {
    const g = this.game, R = RUNES_AWAY;
    if (px >= R.x0 && px <= R.x1 && py >= R.y0 && py <= R.y1) { this.panelPage = 0; this.drawPanel(); return; }
    const col = RUNE_X.findIndex(cx => Math.abs(cx - px) < 8.3), row = RUNE_Y.findIndex(cy => Math.abs(cy - py) < 7.5);
    if (col < 0 || row < 0) { clearShelf(g); return; }
    const r = row * 4 + col;
    if (!g.magic.runes[r]) return;
    if (g.mode === 'look') this.say(`${runeName(g, r)}.`);
    else selectRune(g, r);
  }

  private drawShelf(): void {
    const m = this.game.magic;
    $('#shelf').querySelectorAll('canvas').forEach((cv, k) => {
      const c = cv as HTMLCanvasElement, r = m.shelf[k], ic = r != null ? this.art.icon(RUNE_STONE + r) : null, x = c.getContext('2d')!;
      c.width = ic?.width ?? 16; c.height = ic?.height ?? 16;
      x.clearRect(0, 0, c.width, c.height);
      if (ic) x.drawImage(ic, 0, 0);
    });
    $('#shelf').hidden = !m.runes.some(Boolean);
    $('#shelf').title = m.pending ? `${m.pending.name}: point where to cast it` : 'Cast the spell on the shelf (C)';
  }

  private drawSpells(): void {
    const A = this.art, fx = this.game.magic.effects;
    $('#spells').querySelectorAll('canvas').forEach((cv, k) => {
      const c = cv as HTMLCanvasElement, e = fx[k];
      c.hidden = !e;
      if (!e) return;
      const base = SPELL_ICON[e.major] ?? 0x80, i = base < 0 ? e.minor - 1 : base + e.minor, im = i < 0x80 ? A.spells?.[i] : null;
      const x = c.getContext('2d')!;
      c.width = im?.w ?? 16; c.height = im?.h ?? 16;
      x.clearRect(0, 0, c.width, c.height);
      if (im) x.drawImage(A.canvas(im), 0, 0); else { x.fillStyle = '#e7a93b'; x.beginPath(); x.arc(8, 8, 5, 0, 7); x.fill(); }
      c.title = 'A spell at work (tap to end it)';
    });
  }

  /** Per frame: the power gem follows the swing's charge; the eyes step toward their target. */
  tick(dt: number): void {
    const A = this.art, s = this.game.swing;
    if (A.power) {
      const k = s.stage === 'charging' ? (s.charge >= 100 ? 9 + (Math.floor(performance.now() / 150) & 1) : Math.min(9, 1 + Math.trunc(s.charge / 12))) : 0;
      const im = A.power[Math.min(k, A.power.length - 1)];
      if (k !== this.powerK && im) { this.powerK = k; const c = $<HTMLCanvasElement>('#power'); c.width = im.w; c.height = im.h; c.getContext('2d')!.drawImage(A.canvas(im), 0, 0); }
    }
    const E = this.eye;
    E.since += dt; E.step += dt;
    if (E.since >= 10) E.to = 0;
    if (A.eyes && E.step > 0.2) {
      E.step = 0;
      if (E.cur !== E.to) {
        E.cur += E.cur < E.to ? 1 : -1;
        const im = A.eyes[E.cur];
        const c = $<HTMLCanvasElement>('#eyes');
        if (im) { c.width = im.w; c.height = im.h; c.getContext('2d')!.drawImage(A.canvas(im), 0, 0); }
      }
    }
  }
}

