import { readFont, readGR, readPanels, readPlayer, type DiscPlayer, type Font, type Img } from '../formats';
import type { GameData } from '../data/gamedata';

/**
 * The interface art, decoded from the disc at runtime (never embedded or redrawn): command icons, flasks, compass,
 * buttons, chains, scroll edges, panels, bodies, worn armour, portraits, power gem, eyes, spell icons, the 5x6 font and
 * the cutscene font. Anything missing is null and the UI falls
 * back to text buttons and plain panels.
 */
export class Art {
  readonly heads: (Img | null)[] | null;
  readonly lfti: (Img | null)[] | null;
  flasks: (Img | null)[] | null;
  readonly comp: (Img | null)[] | null;
  readonly chr: (Img | null)[] | null;
  readonly chains: (Img | null)[] | null;
  readonly scr: (Img | null)[] | null;
  readonly bodies: (Img | null)[] | null;
  readonly panels: (Img | null)[] | null;
  readonly charhead: (Img | null)[] | null;
  readonly genhead: (Img | null)[] | null;
  /** Combat: the power gem (charge, frames 0-10) and the eyes (the last foe's health); SPELLS.GR: active spell icons. */
  readonly power: (Img | null)[] | null;
  readonly eyes: (Img | null)[] | null;
  readonly spells: (Img | null)[] | null;
  /** The paperdoll's worn armour (male and female bodies) and the panel's buttons (container scroll arrows 27, 28). */
  readonly armour: [(Img | null)[] | null, (Img | null)[] | null];
  readonly buttons: (Img | null)[] | null;
  readonly font: Font | null;
  /** FONTBIG.SYS: cutscene subtitles. */
  readonly bigFont: Font | null;
  readonly player: DiscPlayer | null;
  /** Palette index of the stats page's label ink. */
  ink = 0;
  /** Flask liquid colours (vitality, mana) and their brighter surface colours. */
  liq: number[] = [0, 0];
  liqTop: number[] = [0, 0];
  private cache = new Map<Img, HTMLCanvasElement>();

  constructor(readonly D: GameData) {
    const f = D.files, ap = f['ALLPALS.DAT']!;
    const gr = (n: string) => { const b = f[n]; if (!b) return null; try { return readGR(b, ap); } catch (e) { console.warn(n, e); return null; } };
    this.heads = gr('HEADS.GR'); this.lfti = gr('LFTI.GR'); this.flasks = gr('FLASKS.GR'); this.comp = gr('COMPASS.GR'); this.chr = gr('CHRBTNS.GR');
    this.chains = gr('CHAINS.GR'); this.scr = gr('SCRLEDGE.GR'); this.bodies = gr('BODIES.GR'); this.charhead = gr('CHARHEAD.GR'); this.genhead = gr('GENHEAD.GR');
    this.power = gr('POWER.GR'); this.eyes = gr('EYES.GR'); this.spells = gr('SPELLS.GR');
    this.armour = [gr('ARMOR_M.GR'), gr('ARMOR_F.GR')]; this.buttons = gr('BUTTONS.GR');
    let panels: (Img | null)[] | null = null;
    try { panels = f['PANELS.GR'] ? readPanels(f['PANELS.GR']) : null; } catch (e) { console.warn('PANELS.GR', e); }
    this.panels = panels && panels[0] ? panels : null;
    let font: Font | null = null;
    try { font = f['FONT5X6P.SYS'] ? readFont(f['FONT5X6P.SYS']) : null; } catch (e) { console.warn('FONT5X6P.SYS', e); }
    this.font = font;
    let big: Font | null = null;
    try { big = f['FONTBIG.SYS'] ? readFont(f['FONTBIG.SYS']) : null; } catch (e) { console.warn('FONTBIG.SYS', e); }
    this.bigFont = big;
    this.player = readPlayer(f['PLAYER.DAT']);
    this.derive();
  }

  lum(v: number): number { const p = this.D.pal; return p[v * 4]! * 0.3 + p[v * 4 + 1]! * 0.59 + p[v * 4 + 2]! * 0.11; }
  rgb(v: number): string { const p = this.D.pal; return `rgb(${p[v * 4]},${p[v * 4 + 1]},${p[v * 4 + 2]})`; }

  /** Colours the panels need: the stat labels' ink and the flask liquids (most common colour of a full-level strip). */
  private derive(): void {
    const common = (im: Img) => { const h = new Map<number, number>(); for (const v of im.px) if (v && this.lum(v) > 60) h.set(v, (h.get(v) ?? 0) + 1); return [...h].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0; };
    const st = this.panels?.[2];
    if (st) { let best = 0; for (let y = 17; y < 23; y++) for (let x = 4; x < 22; x++) { const v = st.px[y * 79 + x]!; if (this.lum(v) > this.lum(best)) best = v; } this.ink = best; }
    const fl = this.flasks;
    if (fl && fl.length > 76 && fl[75] && fl[76] && fl[12] && fl[37]) {
      // the flask art sits on a black box: clear the background connected to the edges
      for (const i of [75, 76]) {
        const im = fl[i]!, px = Uint8Array.from(im.px), bg = px[0]!, stack: number[] = [];
        for (let x = 0; x < im.w; x++) stack.push(x, (im.h - 1) * im.w + x);
        for (let y = 0; y < im.h; y++) stack.push(y * im.w, y * im.w + im.w - 1);
        const out = Uint8Array.from(px);
        while (stack.length) {
          const k = stack.pop()!;
          if (out[k] !== bg || px[k] !== bg || (out[k] === 0 && bg !== 0)) continue;
          out[k] = 0;
          const x = k % im.w, y = (k / im.w) | 0;
          if (x > 0) stack.push(k - 1); if (x < im.w - 1) stack.push(k + 1); if (y > 0) stack.push(k - im.w); if (y < im.h - 1) stack.push(k + im.w);
        }
        fl[i] = { w: im.w, h: im.h, px: out, bgMask: px };
      }
      this.liq = [common(fl[12]), common(fl[37])];
      this.liqTop = this.liq.map((c, k) => { let b = c; for (const v of fl[k ? 37 : 12]!.px) if (v && this.lum(v) > this.lum(b)) b = v; return b; });
    } else this.flasks = null;
  }

  /** The image as a canvas at native size (cached). Index 0 is transparent unless the image is opaque. */
  canvas(im: Img): HTMLCanvasElement {
    let c = this.cache.get(im);
    if (c) return c;
    c = document.createElement('canvas'); c.width = im.w; c.height = im.h;
    const x = c.getContext('2d')!, d = x.createImageData(im.w, im.h);
    for (let i = 0; i < im.w * im.h; i++) {
      const v = im.px[i]!;
      if (!v && !im.opaque) continue;
      d.data.set(this.D.pal.subarray(v * 4, v * 4 + 3), i * 4); d.data[i * 4 + 3] = 255;
    }
    x.putImageData(d, 0, 0);
    this.cache.set(im, c);
    return c;
  }
  url(im: Img | null | undefined): string { return im ? this.canvas(im).toDataURL() : ''; }
  icon(id: number): HTMLCanvasElement | null { const im = this.D.objImgs[id]; return im ? this.canvas(im) : null; }

  /** Draws a portrait centred and scaled into a canvas. */
  drawHead(cv: HTMLCanvasElement, im: Img | null | undefined): void {
    const x = cv.getContext('2d')!;
    x.clearRect(0, 0, cv.width, cv.height);
    if (!im) return;
    x.imageSmoothingEnabled = false;
    const s = Math.min(cv.width / im.w, cv.height / im.h);
    x.drawImage(this.canvas(im), (cv.width - im.w * s) / 2, (cv.height - im.h * s) / 2, im.w * s, im.h * s);
  }

  textW(str: string): number { const F = this.font; let w = 0; if (F) for (const ch of str) w += (F.g[ch.charCodeAt(0)]?.w ?? F.space) + 1; return w; }
  /** Text in the game's own 5x6 font, for labels that sit on baked pixel art. */
  text(x: CanvasRenderingContext2D, str: string, px: number, py: number, v: number, align: 'left' | 'right' | 'center' = 'left'): void {
    const F = this.font;
    if (!F) return;
    const w = this.textW(str);
    let cx = align === 'right' ? px - w : align === 'center' ? px - w / 2 : px;
    x.fillStyle = this.rgb(v);
    for (const ch of str) {
      const g = F.g[ch.charCodeAt(0)];
      if (!g) { cx += F.space + 1; continue; }
      for (let y = 0; y < F.h; y++) for (let i = 0; i < g.w; i++) if (g.bit(i, y)) x.fillRect(Math.round(cx) + i, py + y, 1, 1);
      cx += g.w + 1;
    }
  }
}
