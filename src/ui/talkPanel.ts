import type { ObjRec } from '../formats';
import { itemName, qtyOf } from '../data/text';
import type { Game } from '../game/game';
import type { LineKind, TalkView, TradeView } from '../game/ports';
import { closeTalk } from '../game/talk';
import type { Art } from './art';
import { $, el } from './dom';

/**
 * The conversation panel: stone card, NPC portrait + name left, the Avatar's head right, parchment log (speaker labels
 * once a second speaker has talked; narration italic, replies in brown), numbered reply buttons below (the original's
 * scroll of choices); 1-9 pick, Enter/Space read on, Esc leaves (commits). Trading shows six slots a side.
 */
export class TalkPanel implements TalkView {
  game!: Game;
  constructor(private readonly art: Art) {}

  open(me: { name: string; body: number }): void {
    $('#tLog').replaceChildren(); $('#tOpts').replaceChildren(); $('#tAskF').hidden = true;
    this.art.drawHead($<HTMLCanvasElement>('#tMe'), this.art.heads?.[me.body]);
    $('#tMeName').textContent = me.name;
    const hs = innerWidth < 560 ? 1.25 : innerHeight < 700 ? 1.5 : 2;
    document.documentElement.style.setProperty('--hs', String(hs));
    $('#talk').hidden = false;
  }

  close(): void { $('#talk').hidden = true; }

  setTalker(t: { name: string; who: number; id: number | null }): void {
    const head = t.who > 0 ? this.art.charhead?.[t.who - 1] : null;
    const gen = !head && t.id != null ? this.art.genhead?.[t.id - 0x40] : null;
    this.art.drawHead($<HTMLCanvasElement>('#tPic'), head ?? gen);
    $('#tName').textContent = t.name;
  }

  line(kind: LineKind, text: string, speaker?: string): void {
    const log = $('#tLog'), p = el('p', { className: kind });
    if (speaker) p.append(el('span', { className: 'spk' }, speaker));
    p.append(text);
    log.append(p);
    log.scrollTop = log.scrollHeight;
  }

  prompt(p: Parameters<TalkView['prompt']>[0]): void {
    const box = $('#tOpts'), s = () => this.game.talk;
    box.replaceChildren(); $('#tAskF').hidden = true;
    const btn = (mark: string, label: string, fn: () => void) => { const b = el('button', { onclick: fn }, el('b', {}, mark), el('span', {}, label)); box.append(b); return b; };
    if (p.kind === 'menu') {
      p.options.forEach((op, k) => btn(`${k + 1}.`, op.text, () => s()?.choose(k)));
      (box.firstChild as HTMLElement | null)?.focus({ preventScroll: true });
    } else if (p.kind === 'more') btn('…', 'More', () => s()?.more()).focus({ preventScroll: true });
    else if (p.kind === 'ask') { const f = $('#tAskF'), i = $<HTMLInputElement>('#tAsk'); f.hidden = false; i.value = ''; setTimeout(() => i.focus(), 30); }
    else btn('—', 'Leave', () => closeTalk(this.game)).focus({ preventScroll: true });
  }

  trade(t: TradeView | null): void {
    const box = $('#tTrade');
    if (!t) { box.hidden = true; return; }
    box.hidden = false;
    const D = this.game.data, s = () => this.game.talk;
    const cell = (o: ObjRec | null, sel: boolean, fn: () => void, label: string) => {
      const b = el('button', { className: 'tslot' + (sel ? ' sel' : ''), 'aria-pressed': String(sel), onclick: fn });
      if (o) {
        const im = D.objImgs[o.id];
        if (im) b.append(el('img', { className: 'px', alt: '', src: this.art.url(im) }));
        if (qtyOf(o) > 1) b.append(el('i', {}, String(qtyOf(o))));
        b.title = itemName(D, o); b.setAttribute('aria-label', label + ': ' + itemName(D, o));
      } else { b.disabled = true; b.setAttribute('aria-label', label + ': empty'); }
      return b;
    };
    $('#tTheirs').replaceChildren(...t.theirs.map((o, i) => cell(o, t.theirsSel[i]!, () => s()?.toggleTheirs(i), 'Theirs')));
    $('#tOffer').replaceChildren(...t.offer.map((o, i) => cell(o, !!o, () => s()?.withdrawOffer(i), 'Your offer')));
    $('#tPack').replaceChildren(...t.pack.map(({ key, o }) => cell(o, false, () => s()?.offer(key), 'Your pack')));
    $('#tPackL').hidden = !t.pack.length;
  }

  /** Keys while talking: 1-9 pick, Enter/Space read on, Esc (or Enter/Space/E once it is over) leaves. */
  key(e: KeyboardEvent): void {
    const C = this.game.talk;
    if (!C || (e.target as HTMLElement).id === 'tAsk') return;
    const d = /^(Digit|Numpad)([1-9])$/.exec(e.code), st = C.vm.state;
    if (d && st === 'menu' && !C.over) { e.preventDefault(); C.choose(+d[2]! - 1); }
    else if (st === 'more' && !C.over && (d || e.code === 'Enter' || e.code === 'Space')) { e.preventDefault(); C.more(); }
    else if (e.code === 'Escape' || (C.over && (e.code === 'Enter' || e.code === 'Space' || e.code === 'KeyE'))) { e.preventDefault(); closeTalk(this.game); }
  }
}
