import './styles.css';
import { GameData } from './data/gamedata';
import { filesFromPicked, hasCutscenes, hasNeeded, type GameFiles } from './data/files';
import { levelName } from './data/text';
import { Game } from './game/game';
import { act, talkTo, tryGet, use } from './game/interact';
import { update } from './game/movement';
import { pick } from './game/picking';
import { closeTalk, startTalk } from './game/talk';
import { addRune, castShelf } from './game/magic';
import { discPlayer } from './game/player';
import { Renderer, LIGHTS } from './render/renderer';
import { cacheClear, cacheGet, cachePut } from './storage/kv';
import { Art } from './ui/art';
import { Automap } from './ui/automap';
import { CharGen } from './ui/chargen';
import { Controls } from './ui/controls';
import { CutsceneView } from './ui/cutscene';
import { STARTUP } from './game/cutscenes';
import { $, el } from './ui/dom';
import { Hud } from './ui/hud';
import { Menus, loadGame, saveGame } from './ui/menus';
import { TalkPanel } from './ui/talkPanel';
import { supportAt, solidBlocks } from './world/collision';

// Boot: pick or restore the disc data, decode it, build the session and the page around it, run the frame loop.
// Storage is a convenience, never a gate: the game starts before the cache write, and a failure anywhere shows up in
// #err (before start) or the message strip (after), never as silence.

let started = false, picked = false, faulted = false;
const stage = (t: string) => { $('#status').textContent = t; return new Promise(r => setTimeout(r, 30)); }; // let the browser paint the message
let hud: Hud | null = null;

function showFault(m: string): void {
  console.error(m);
  if (!started) { $('#err').textContent = 'Something went wrong: ' + m; $('#status').textContent = ''; }
  else if (!faulted) { faulted = true; hud?.say('Engine error: ' + m); }
}

async function start(files: GameFiles): Promise<void> {
  if (started) return;
  started = true;
  let game: Game, renderer: Renderer, art: Art;
  try {
    await stage('Unpacking textures, models and interface art…');
    const data = new GameData(files);
    game = new Game(data);
    renderer = new Renderer($<HTMLCanvasElement>('#view'), data);
    art = new Art(data);
    await stage('Building the world…');
  } catch (e) { started = false; throw e; }
  const D = game.data;
  const talk = new TalkPanel(art);
  talk.game = game;
  hud = new Hud(game, art, talk);
  game.ui = hud;
  const menus = new Menus(game), chargen = new CharGen(game, art), cuts = new CutsceneView(game, art);
  hud.cuts = cuts;
  menus.onCreate = () => chargen.open();
  if (hasCutscenes(files)) menus.playCutscenes = ns => cuts.playAll(ns);
  hud.onVictory = () => void menus.showMain();
  hud.onDied = () => { controls.reset(); setTimeout(() => void menus.showMain(), 2500); };
  const map = new Automap(game, () => hud!.say(''));
  const cycleLight = () => { renderer.lightIdx = (renderer.lightIdx + 1) % LIGHTS.length; $('#bLight').textContent = LIGHTS[renderer.lightIdx]![0]; };
  const closeText = () => ($('#scroll').hidden = true);
  const controls = new Controls(game, {
    toggleMap: () => map.toggle(), togglePanel: () => hud!.togglePanel(), cycleLight,
    closeOverlays: () => { closeText(); $('#opts').hidden = true; },
    talkKey: e => talk.key(e),
    openRunes: () => hud!.openRunes(),
    cutsKey: e => cuts.key(e),
  });
  const openTalk = talk.open.bind(talk);
  talk.open = me => { controls.reset(); openTalk(me); };
  hud.onOptions = () => ($('#opts').hidden = false);
  hud.init();

  // options card
  $('#bClose').onclick = closeText;
  $('#scroll').onclick = e => { if ((e.target as HTMLElement).id === 'scroll') closeText(); };
  $('#bMap').onclick = () => { $('#opts').hidden = true; map.toggle(); };
  $('#bLight').onclick = cycleLight;
  $('#bPix').onclick = () => { renderer.chunky = !renderer.chunky; $('#bPix').textContent = renderer.chunky ? '320×200' : 'Sharp'; $('#view').classList.toggle('chunky', renderer.chunky); };
  const sel = $<HTMLSelectElement>('#lvl');
  sel.onchange = () => { game.goLevel(+sel.value); sel.blur(); $('#opts').hidden = true; };
  $('#bOptClose').onclick = () => ($('#opts').hidden = true);
  $('#opts').onclick = e => { if ((e.target as HTMLElement).id === 'opts') $('#opts').hidden = true; };
  $('#bSave').onclick = () => menus.showSlots(true);
  $('#bLoad').onclick = () => menus.showSlots(false);
  $('#bNew').onclick = () => chargen.open();
  $('#bData').onclick = async () => { $('#bData').textContent = 'Forgetting…'; await cacheClear(); location.reload(); };

  sel.replaceChildren(...D.levels.slice(0, 80).flatMap((b, i) => (b ? [el('option', { value: String(i) }, levelName(i))] : [])));
  $('#loader').hidden = true; $('#game').hidden = false;
  game.goLevel(0);
  game.setPlayer(discPlayer(D));
  void cuts.playAll(STARTUP).then(() => menus.showMain()); // the title and the introduction; skipping goes to the menu
  if (!D.crit) hud.say('Creatures need the disc’s CRIT folder: choose Forget data in Options, then the disc image again.');
  else if (!D.models || !art.panels || !art.heads) hud.say('For real furniture, interface art and character creation, choose Forget data in Options, then your disc image again.');
  else if (!hasCutscenes(files)) hud.say('For the cutscenes, choose Forget data in Options, then your disc image again.');

  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    try {
      if (cuts.active) cuts.frame(dt); // the world waits
      else {
        controls.poll();
        update(game, dt);
        renderer.render(game);
        if (map.shown) map.draw();
        hud!.drawCompass();
        hud!.tick(dt);
      }
    } catch (e) { showFault(e instanceof Error ? e.message : String(e)); }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // test / debugging handle (headless browser tests drive the engine through this)
  (window as unknown as Record<string, unknown>).__uw = {
    game, renderer, hud, art, cuts, playCutscene: (n: number) => cuts.play(n), get LV() { return game.level; }, P: game.pose, G: D, INV: game.inv,
    saveGame: (k: number) => saveGame(game, k), loadGame: (k: number) => loadGame(game, k), openCreation: () => chargen.open(),
    goLevel: (n: number) => game.goLevel(n), teleport: (x: number, y: number) => game.teleport(x, y),
    pick: (x: number, y: number) => pick(game, x, y), use: (x: number, y: number, look?: boolean) => use(game, x, y, look), act: (x: number, y: number) => act(game, x, y),
    tryGet: (h: ReturnType<typeof pick>) => tryGet(game, h), talkTo: (h: ReturnType<typeof pick>) => talkTo(game, h),
    startTalk: (sp: Parameters<typeof startTalk>[1]) => startTalk(game, sp), closeTalk: () => closeTalk(game),
    render: () => renderer.render(game), update: (dt: number) => update(game, dt),
    supportAt: (x: number, y: number, f: number) => supportAt(game.L, x, y, f), solidBlocks: (x: number, y: number, r: number, f: number, h: number) => solidBlocks(game.L, x, y, r, f, h),
    giveRunes: () => { for (let r = 0; r < 24; r++) addRune(game, r); }, castShelf: () => castShelf(game),
    blocked: (x: number, z: number, f: number) => game.blocked(x, z, f), unstick: () => game.unstick(), jump: () => (game.input.jump = true),
  };
}

async function fromFiles(list: File[]): Promise<void> {
  const err = $('#err');
  err.textContent = '';
  if (started) { err.textContent = 'The game is already running.'; return; }
  await stage('Reading the disc image…');
  try {
    const files = await filesFromPicked(list);
    picked = true;
    await start(files);
    void cachePut(files).then(ok => { if (!ok) console.warn('game data could not be stored; the disc will be needed next time'); });
  } catch (e) {
    console.error(e);
    err.textContent = e instanceof Error ? e.message : String(e);
    $('#status').textContent = '';
  }
}

$<HTMLInputElement>('#pick').addEventListener('change', e => fromFiles([...((e.target as HTMLInputElement).files ?? [])]));
const dz = $('#loader');
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); void fromFiles([...(e.dataTransfer?.files ?? [])]); });
addEventListener('error', e => showFault(e.message || String(e.error)));
addEventListener('unhandledrejection', e => showFault((e.reason && e.reason.message) || String(e.reason)));
void (async () => {
  const c = await cacheGet();
  if (picked || started) return;
  if (hasNeeded(c)) {
    try { await stage('Opening the Labyrinth…'); await start(c); }
    catch (e) { console.error(e); $('#err').textContent = e instanceof Error ? e.message : String(e); $('#status').textContent = ''; }
  }
})();
