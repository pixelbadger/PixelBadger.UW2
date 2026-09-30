import type { Game } from '../game/game';
import { $ } from './dom';

/** The automap: every open tile shaded by height, move triggers marked, the Avatar as an arrow. Click to teleport. */
export class Automap {
  shown = false;
  private geom: { S: number; ox: number; oy: number } | null = null;

  constructor(private readonly game: Game, onPicked: () => void) {
    const mc = $<HTMLCanvasElement>('#map');
    mc.addEventListener('click', e => {
      const m = this.geom;
      if (!m) return;
      const r = mc.getBoundingClientRect(), dpr = mc.width / r.width;
      const x = Math.floor(((e.clientX - r.left) * dpr - m.ox) / m.S), y = 63 - Math.floor(((e.clientY - r.top) * dpr - m.oy) / m.S);
      if (this.game.L.open(x, y)) { this.game.teleport(x, y); this.toggle(); onPicked(); }
    });
  }

  toggle(): void {
    this.shown = !this.shown;
    $('#map').hidden = !this.shown;
    if (this.shown) { document.exitPointerLock?.(); this.draw(); }
  }

  draw(): void {
    const mc = $<HTMLCanvasElement>('#map'), r = mc.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, L = this.game.L, P = this.game.pose;
    const mw = Math.max(1, Math.round(r.width * dpr)), mh = Math.max(1, Math.round(r.height * dpr));
    if (mc.width !== mw || mc.height !== mh) { mc.width = mw; mc.height = mh; }
    const c = mc.getContext('2d')!, S = Math.min(mc.width, mc.height) / 64, ox = (mc.width - S * 64) / 2, oy = (mc.height - S * 64) / 2;
    this.geom = { S, ox, oy };
    c.clearRect(0, 0, mc.width, mc.height);
    c.fillStyle = 'rgba(12,11,9,.82)'; c.fillRect(0, 0, mc.width, mc.height);
    const TRI: Record<number, [number, number][]> = { 2: [[0, 1], [1, 1], [1, 0]], 3: [[0, 0], [0, 1], [1, 1]], 4: [[0, 0], [1, 0], [1, 1]], 5: [[0, 0], [1, 0], [0, 1]] };
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const t = L.tileAt(x, y)!;
      if (t.type === 0) continue;
      const l = 40 + t.h * 9;
      c.fillStyle = `rgb(${l + 30},${l + 14},${l - 6})`;
      const X = ox + x * S, Y = oy + (63 - y) * S;
      if (t.type === 1 || t.type > 5) c.fillRect(X, Y, S + 0.5, S + 0.5);
      else { c.beginPath(); TRI[t.type]!.forEach(([a, b], i) => (i ? c.lineTo(X + a * S, Y + b * S) : c.moveTo(X + a * S, Y + b * S))); c.fill(); }
    }
    c.fillStyle = '#e7b24a';
    for (const k of L.triggers.keys()) { const x = k & 63, y = k >> 6; c.fillRect(ox + (x + 0.3) * S, oy + (63 - y + 0.3) * S, S * 0.4, S * 0.4); }
    const px = ox + P.x * S, py = oy + (64 + P.z) * S;
    c.save(); c.translate(px, py); c.rotate(P.yaw); c.fillStyle = '#f4efe2';
    c.beginPath(); c.moveTo(0, -S * 1.2); c.lineTo(S * 0.7, S * 0.8); c.lineTo(-S * 0.7, S * 0.8); c.fill(); c.restore();
  }
}
