import { CUTSCENE, INTRODUCTION } from '../game/cutscenes';
import type { Game } from '../game/game';
import { discPlayer } from '../game/player';
import { THEME, holdMusic, releaseMusic } from '../game/sound';
import { SAVE_SLOTS, SaveError, applySave, describeSave, makeSave, parseSave } from '../game/saves';
import { kvGet, kvPut, saveKey } from '../storage/kv';
import { $, el } from './dom';

// Our own chrome (main menu, options, save slots) is a "stone card": the panel's stone as background, CHRBTNS stone
// bars as buttons, parchment/torch text colours.

export async function saveGame(game: Game, k: number): Promise<void> {
  if (!game.level || !game.stats) return;
  const ok = await kvPut(saveKey(k), makeSave(game));
  game.say(ok ? `Game saved in slot ${k + 1}.` : 'This browser would not store the save.');
}

/** Loads slot k. Damaged, foreign or too-new saves are refused with a message and the current game is left alone. */
export async function loadGame(game: Game, k: number): Promise<boolean> {
  const raw = await kvGet(saveKey(k));
  if (!raw) { game.say('That slot is empty.'); return false; }
  let save;
  try { save = parseSave(raw, n => !!game.data.levels[n]); }
  catch (e) { if (e instanceof SaveError) { game.say(e.message); return false; } throw e; }
  applySave(game, save);
  game.say(`Welcome back, ${save.player.name}.`);
  return true;
}

async function slotList(game: Game, save: boolean, done: () => void): Promise<HTMLElement> {
  const box = el('div', { className: 'stack' });
  for (let k = 0; k < SAVE_SLOTS; k++) {
    const d = describeSave(await kvGet(saveKey(k)));
    const b = el('button', { className: 'sbtn slot' }, d ? d.title : `Slot ${k + 1}`, el('small', {}, d ? d.when : 'empty'));
    b.disabled = !save && !d;
    b.onclick = async () => {
      if (save) await saveGame(game, k);
      else if (!(await loadGame(game, k))) return;
      done();
    };
    box.append(b);
  }
  return box;
}

export class Menus {
  onCreate: () => void = () => {};
  /** Plays cutscenes over the menu (null: no cutscene data). */
  playCutscenes: ((ns: readonly number[]) => Promise<unknown>) | null = null;
  constructor(private readonly game: Game) {}

  /**
   * The start menu, as the original's: the introduction, create a character, the acknowledgements, journey onward
   * (load); plus exploring as the disc's default character.
   */
  async showMain(): Promise<void> {
    holdMusic(this.game, THEME.intro);
    const body = $('#menuBody'), st = el('div', { className: 'stack' });
    body.replaceChildren();
    const add = (t: string, fn: () => void) => { const b = el('button', { className: 'sbtn', onclick: fn }, t); st.append(b); return b; };
    const play = this.playCutscenes, watch = (ns: readonly number[]) => async () => { $('#menu').hidden = true; await play!(ns); $('#menu').hidden = false; };
    if (play) add('Introduction', watch(INTRODUCTION));
    add('Create a character', () => this.onCreate());
    if (play) add('Acknowledgements', watch([CUTSCENE.credits]));
    let any = false;
    for (let k = 0; k < SAVE_SLOTS; k++) if (await kvGet(saveKey(k))) any = true;
    if (any) add('Journey onward', async () => {
      body.replaceChildren(el('p', { className: 'keys' }, 'Choose a saved game.'), await slotList(this.game, false, () => ($('#menu').hidden = true)),
        el('button', { className: 'sbtn wide', onclick: () => this.showMain() }, 'Back'));
    });
    add('Explore as the disc’s default character', () => { $('#menu').hidden = true; releaseMusic(this.game); this.game.resetCombat(); this.game.setPlayer(discPlayer(this.game.data)); });
    body.append(st);
    $('#menu').hidden = false;
  }

  /** Swaps the Options card for a save or load slot list (Back restores it). */
  async showSlots(save: boolean): Promise<void> {
    const c = $('#opts .stonecard'), keep = [...c.children];
    const back = () => c.replaceChildren(...keep);
    c.replaceChildren(el('h2', {}, save ? 'Save game' : 'Load game'),
      await slotList(this.game, save, () => { back(); $('#opts').hidden = true; $('#menu').hidden = true; }),
      el('button', { className: 'sbtn wide', onclick: back }, 'Back'));
  }
}
