import { S2 } from '../data/text';
import { classData, newCharacter, pickSkill, rollClass } from '../game/chargen';
import type { Game } from '../game/game';
import type { PlayerStats } from '../game/player';
import type { Art } from './art';
import { $, el, releasePointer } from './dom';

type Step = ['sex' | 'hand' | 'cls' | 'look' | 'diff' | 'name' | 'keep', string] | ['skill', string, number];

/** Character creation: the original's steps and wording (STRINGS block 2) on a stone card, with a live summary. */
export class CharGen {
  private pl: PlayerStats = newCharacter();
  private step = 0;
  private queue: number[][] = [];

  constructor(private readonly game: Game, private readonly art: Art) {
    $<HTMLFormElement>('#ccNameF').onsubmit = e => {
      e.preventDefault();
      const v = $<HTMLInputElement>('#ccName').value.trim();
      if (v) { this.pl.name = v.slice(0, 14); this.choose(() => {}); }
    };
    // typing a name must not walk the Avatar about
    $('#ccName').addEventListener('keydown', e => e.stopPropagation());
  }

  open(): void {
    releasePointer();
    $('#menu').hidden = true; $('#opts').hidden = true;
    this.pl = newCharacter(); this.step = 0; this.queue = [];
    this.render();
    $('#cc').hidden = false;
  }

  private steps(): Step[] {
    const D = this.game.data;
    const st: Step[] = [['sex', S2(D, 1)], ['hand', S2(D, 2)], ['cls', S2(D, 3)]];
    for (let i = 0; i < this.queue.length; i++) st.push(['skill', S2(D, 4), i]);
    st.push(['look', 'Choose your appearance'], ['diff', S2(D, 6)], ['name', S2(D, 7)], ['keep', S2(D, 8)]);
    return st;
  }

  private choose(fn: () => void): void { fn(); this.step++; this.render(); }

  private render(): void {
    const D = this.game.data, A = this.art, rng = this.game.rng, st = this.steps(), cur = st[Math.min(this.step, st.length - 1)]!, kind = cur[0], pl = this.pl, box = $('#ccOpts');
    box.replaceChildren();
    $('#ccNameF').hidden = kind !== 'name';
    $('#ccStep').textContent = `Step ${this.step + 1} of ${st.length}`;
    $('#ccQ').textContent = cur[1];
    const btn = (label: string | Node, fn: () => void, cls = 'sbtn') => { const b = el('button', { className: cls, onclick: () => this.choose(fn) }, label); box.append(b); return b; };
    if (kind === 'sex') { btn(S2(D, 9), () => (pl.sex = 0)); btn(S2(D, 10), () => (pl.sex = 1)); }
    else if (kind === 'hand') { btn(S2(D, 11), () => (pl.hand = 0)); btn(S2(D, 12), () => (pl.hand = 1)); }
    else if (kind === 'cls') { const cd = classData(D); for (let c = 0; c < 8; c++) btn(S2(D, 23 + c), () => { this.queue = rollClass(pl, c, cd, rng); }); }
    else if (kind === 'skill') { for (const k of this.queue[cur[2]]!) btn(S2(D, 31 + k), () => pickSkill(pl, k, rng)); }
    else if (kind === 'look') {
      for (let i = 0; i < 5; i++) {
        const h = A.heads?.[pl.sex * 5 + i];
        let label: string | Node = `Look ${i + 1}`;
        if (h) { const c = el('canvas', { width: h.w, height: h.h, className: 'px' }); c.getContext('2d')!.drawImage(A.canvas(h), 0, 0); label = c; }
        btn(label, () => (pl.body = pl.sex * 5 + i), h ? 'sbtn head' : 'sbtn').setAttribute('aria-label', `Appearance ${i + 1}`);
      }
    } else if (kind === 'diff') { btn(S2(D, 13), () => (pl.diff = 0)); btn(S2(D, 14), () => (pl.diff = 1)); }
    else if (kind === 'name') { const i = $<HTMLInputElement>('#ccName'); i.value = pl.name; setTimeout(() => i.focus(), 50); }
    else if (kind === 'keep') { btn(S2(D, 15), () => { $('#cc').hidden = true; this.game.newGame(pl); }); btn(S2(D, 16), () => this.open()); }
    // live summary on the right, in the original's order
    const lookAt = st.findIndex(x => x[0] === 'look');
    const h = A.heads?.[this.step > lookAt ? pl.body : pl.sex * 5], hc = $<HTMLCanvasElement>('#ccHead'), x = hc.getContext('2d')!;
    x.clearRect(0, 0, 64, 70);
    if (h && this.step > 0) x.drawImage(A.canvas(h), 0, 0);
    const rows: [string, string][] = [];
    if (this.step > 0) rows.push([pl.sex ? S2(D, 10) : S2(D, 9), this.step > 1 ? (pl.hand ? S2(D, 12) : S2(D, 11)) : '']);
    if (pl.cls >= 0) {
      rows.push([S2(D, 23 + pl.cls), ''], [S2(D, 17), String(pl.str)], [S2(D, 18), String(pl.dex)], [S2(D, 19), String(pl.int)], [S2(D, 20), String(pl.vit[1])], [S2(D, 21), String(pl.mana[1])]);
      pl.skills.forEach((v, k) => { if (v) rows.push([S2(D, 31 + k), String(v)]); });
    }
    $('#ccStats').replaceChildren(...rows.flatMap(([dt, dd]) => [el('dt', {}, dt), el('dd', {}, dd)]));
  }
}
