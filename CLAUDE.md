# CLAUDE.md — Ultima Underworld II web engine

A from-scratch browser engine (TypeScript, WebGL2, Vite) that reads the **original UW2 data** and plays the Labyrinth
of Worlds. Not DOSBox, not a remake. Owner: Ben. Prefers direct engagement; ask when a requirement is ambiguous.

## Principles (do not break)
1. **Use original data, don't fake it.** Every texture, model, string, rule and UI piece comes from the disc at runtime.
   Where we approximate (chargen rolls, stand-in furniture, stand-in AI) the code says so. Never embed game assets
   (copyright, and the page must stay small).
2. **Game data is hostile input.** Parsers return something within `src/formats/limits.ts` or throw `DataError`.
   New parsers get bounds checks, a limit, and a fuzz test in `tests/formats/fuzz.test.ts`.
3. **No DOM text from data via innerHTML.** Disc strings and player input reach the page only via `textContent` /
   `el()` (`src/ui/dom.ts`).
4. **Saves are versioned.** Change the save shape -> bump `SAVE_VERSION`, add a migration step in `src/game/saves.ts`,
   extend validation. Bad saves are rejected before any state is touched.
5. **Storage is a convenience, never a gate** (`src/storage/kv.ts`: every call times out).
6. **Keep the UI philosophy**: the original's pieces and metaphors (command icons, flasks, compass, scroll strip,
   paperdoll + chain, 4 slots, chargen wording) over a responsive full-bleed view. See docs/INTERFACE.md.
7. Nothing under `src/formats`, `src/conv`, `src/cuts`, `src/audio`, `src/world`, `src/game` touches the DOM; the page is reached via `UiPort`.

## Architecture
```
src/
  formats/   pure parsers + writers (ark, compress, gr, rle, strings, critters, models, conv, iso, level, misc, cuts, objdat,
             sound: SOUNDS.DAT, the UW.OPL timbre bank, XMI),
             bytes.ts (bounds-checked reads, DataError), limits.ts (sanity limits). Node-importable.
  conv/vm.ts ConvVM: resumable conversation VM (seedable RNG via host.rng).
  cuts/      CutscenePlayer: runs a .N00 script in virtual time into a 320x200 indexed screen + palette + subtitle.
  audio/     fm.ts (an OPL-style two-operator FM voice), music.ts (the AIL-style driver + XmiPlayer). Pure, Node-testable.
  core/rng.ts seeded RNG; every random choice goes through Game.rng.
  data/      files.ts (NEEDED/OPTIONAL, ISO/loose-file intake), gamedata.ts (GameData: decoded disc, texture
             array layout, lazy caches), text.ts (names, STRINGS helpers, OBJECTS/COMOBJ lookups).
  world/     Level (tiles, floorAt, mutable object lists), LevelScene (derived geometry, versioned parts),
             props (furniture/models/decals + solids), doors, collision, creatures (sprites, stand-in AI with
             attack/spell/death animations; combat rules reached via CritterCtx), mesh.
  game/      Game (the session object: all mutable state), movement, picking, interact (use/look/get/drop, doors, locks),
             inventory (slots, containers) + items (weight, containers' rules, using things, armour, lights, food),
             sound (effect numbers, positional volume/pan, footsteps, which music theme and why),
             talk + talkBuiltins + loot (conversation engine side, trading), saves, chargen rules,
             player, cutscenes (when they play: startup, quest 143, dreams), ports (UiPort/TalkView interfaces),
             rules (skills, dice, skill check, XP/levels), combat (swings, hits, damage, death, missiles),
             magic + spells (runes, shelf, spell table, casting, effects, the 20-second clock).
  render/    Renderer (WebGL2; uploads scene parts only when their version changes), shaders, math.
  ui/        Hud (UiPort impl: messages, flasks, compass, panel + paperdoll), TalkPanel, Menus (menu/options/slots),
             CharGen, Automap, Controls, CutsceneView (canvas, FONTBIG subtitles, WebAudio speech), AudioOut (effects,
             streamed music), Art (disc UI art decoded at runtime), dom helpers.
  main.ts    boot: cache/pick -> GameData -> Game + Renderer + UI -> frame loop; window.__uw debug handle.
```
**State.** `Game` owns everything mutable: `level`, `levelStates` (snapshots of levels left), `visited`, `pose`,
`stats` (incl. hunger), `inv` (slots, cursor, open containers), `conv` (quests, clocks, NPC memory), `minutes`, `talk`,
`mode`, `rng`, `swing`, `missiles`, `poison`, `dead`, `magic` (runes, shelf, effects, pending spell), `timers`, `useOn`
(a key or lockpick waiting for its target), `music` (theme state), `steps`. Systems are functions over a
`Game`. No module-level mutable globals.

**Geometry split.** `LevelScene` parts: `world` (tiles, once per load), `fixed` (furniture, models, fixed decals,
solids), `dynamic` (doors, levers, switches, buttons: `game.refreshDynamic()`), `sprites` (loose objects:
`game.refreshObjects()`), creatures (per frame). Conversations that reshape things call `refreshAll()`.

**Saves.** v1 = single-file engine format; v2 = `invis`/`items` split, no derived render data; v3 = v2 + `magic` and
`poison`; v4 = current (v3 + the full paperdoll, containers' contents as `items` up to 8 deep, `player.hunger`/`drunk`).
Creature hit points, hostility and deaths ride in the level snapshots; positions are not saved yet.

## Docs
- docs/FORMATS.md: reverse-engineered formats + conversation VM spec (read before touching parsers/VM).
- docs/CUTSCENES.md: cutscenes: what is built, where, what is approximated; then the research. docs/INTERFACE.md: UI approach.
- docs/COMBAT.md: combat and magic: what follows the original (via UnderworldGodot's trace), what is ours, what is not built.
- docs/ITEMS.md: the inventory, paperdoll, containers and item use, the same way. docs/SOUND.md: sound effects and music.
- legacy/uw2-web-engine.html: the original single-file engine, for behaviour comparison.

## Testing
`npm test` (Vitest, Node): format round-trips, fuzz/property tests (fast-check), VM regression fixtures, and engine
session tests on a **synthetic disc** (`tests/helpers/synth.ts`, built with the format writers; no game data).
`tests/helpers/talk.ts` runs any conversation headless through the real builtins with a seeded RNG.
Real-data tests live in `tests/data` and run with `npm run test:data` (own config, excluded from `npm test`):
`UW2_DATA` = a disc image or a folder holding UW2/ (`tests/data/disc.ts`). Without it they skip, unless
`UW2_DATA_REQUIRED=1`. Never commit the disc.

## CI/CD
PRs into `main` must pass `.github/workflows/ci.yml` (typecheck, test, build). Merges to `main` run
`deploy.yml`: CI again, then GitHub Pages. The `data-tests` gate (the real-data suite; the disc is downloaded from the
repository secret `UW2_DATA_URL`, optionally pinned by the variable `UW2_DATA_SHA256`, and cached) is **on**: deploy
needs it, so without the secret deploys are blocked. Vite `base: './'` so the site works under `/<repo>/`.

## TODO (priority order)
Tests still to write:
- [ ] Save tests: v1 fixture -> migration, rejection of newer/garbage/damaged saves, describeSave never throws.
- [ ] Data-gated harness (`tests/data`, env `UW2_DATA`; the loader and the deploy gate exist): all 102 CNV programs
      x first/last/random/typed "xyzzy", assert no VM error / bad string / leftover `@`; snapshot globals + quests.
- [ ] Browser smoke test (Playwright + synthetic ISO via `writeIso`): boot, walk, talk, save/load.
Engine (feedback priority): confirm combat, magic, the inventory (paperdoll positions, ARMOR_*.GR pictures, container
rules) and sound (effect numbers, the FM synth against the original's music) by play on the real disc (docs/COMBAT.md,
docs/ITEMS.md, docs/SOUND.md list what is approximated) -> trigger chains (links into traps 0x180-0x19f, use/pressure
triggers, damage) -> the rest of the spells (area, targeted, summoning, class 11/13) + enchanted equipment + skill
points for trainers -> creature positions in saves + real AI (pathfinding, morale) -> water/lava (and their sounds) ->
fidelity polish (gouraud nodes, portcullis, compass north, furniture textures).
Cutscenes: confirm quest 143 and the dream rules by play; small-window cutscenes (0x100+, death skulls); a victory
screen; the original's sleep messages and what sleep does (healing, time). Real chargen rules (CHRGEN.DAT) when convenient, not blocking.
Also open from before: conversation arena fights (babl_hack 0/1/2/4: combat exists now, the pit state does not); ring slots for babl_hack 10;
confirm set_sequence and teleport_player x/y by play; automap fidelity; importing original SAVEn dirs.
