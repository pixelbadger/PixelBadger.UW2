import { S1, levelName } from '../data/text';
import type { Game, Mode } from '../game/game';
import { slotClick } from '../game/interact';
import type { SlotKey } from '../game/inventory';
import type { TalkView, UiPort } from '../game/ports';
import type { Art } from './art';
import { $, el, releasePointer } from './dom';

// The in-game interface in the original's style, modernised: command icons that set a mode, flasks, compass, the
// scroll message strip and the paperdoll panel with its pull chain, all drawn from the disc's art, laid over a
// full-bleed responsive view. Pixel art is drawn at native size and scaled with image-rendering: pixelated.

const CMDS: [Mode | 'options', string][] = [['options', 'Options'], ['talk', 'Talk'], ['get', 'Get'], ['look', 'Look'], ['fight', 'Fight'], ['use', 'Use']];
/** Paperdoll/bag slot centres on PANELS.GR 0 (panel pixels). */
const SLOTS: [SlotKey, number, number][] = [['shl', 16.5, 12.5], ['shr', 64.5, 12.5], ['hl', 12.5, 35], ['hr', 68, 35],
  ...[12.5, 31, 50, 68].map((x, i): [SlotKey, number, number] => [('b' + i) as SlotKey, x, 80.5]), ...[12.5, 31, 50, 68].map((x, i): [SlotKey, number, number] => [('b' + (i + 4)) as SlotKey, x, 99.5])];

export class Hud implements UiPort {
  private msgTimer = 0;
  private compK = -1;
  panelPage = 0;
  private skillPage = 0;
  /** UI scale (3 desktop, 2 touch/narrow) and panel scale. */
  u = 3;
  ps = 3;
  onOptions: () => void = () => {};

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
    $('#chain').onclick = () => { this.panelPage ^= 1; this.drawPanel(); };
    $('#pcv').addEventListener('pointerdown', e => this.panelClick(e));
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
    if (k !== 'use') this.say({ look: 'Look: click something to examine it.', get: 'Get: click something to pick it up.', talk: 'Talk: click someone to speak with them.', fight: 'Fight.' }[k] ?? '');
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
    const ch = $('#chain img');
    if (A.chains) ch.style.width = 15 * ps * 0.8 + 'px';
    $('#held').style.width = 16 * u + 'px';
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
    if (this.panelPage === 0) {
      if (A.panels) x.drawImage(A.canvas(A.panels[0]!), 0, 0);
      else { x.fillStyle = '#2a2620'; x.fillRect(0, 0, 79, 112); x.strokeStyle = '#6a6254'; for (const [, sx, sy] of SLOTS) { x.beginPath(); x.arc(sx, sy, 7.5, 0, 7); x.stroke(); } }
      const bd = A.bodies?.[pl?.body ?? 0];
      if (bd) x.drawImage(A.canvas(bd), 22, 3);
      for (const [k, sx, sy] of SLOTS) { const o = this.game.inv.get(k), c = o ? A.icon(o.id) : null; if (c) x.drawImage(c, Math.round(sx - c.width / 2), Math.round(sy - c.height / 2)); }
      return;
    }
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

  private panelClick(e: PointerEvent): void {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * 79, py = ((e.clientY - r.top) / r.height) * 112;
    e.preventDefault();
    if (this.panelPage === 1) { if (py > 101) { this.skillPage = Math.max(0, this.skillPage + (px < 39 ? -1 : 1)); this.drawPanel(); } return; }
    const sl = SLOTS.find(([, sx, sy]) => Math.hypot(sx - px, sy - py) < 9);
    if (sl) slotClick(this.game, sl[0]);
  }
}

