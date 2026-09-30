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
7. Nothing under `src/formats`, `src/conv`, `src/world`, `src/game` touches the DOM; the page is reached via `UiPort`.

## Architecture
```
src/
  formats/   pure parsers + writers (ark, compress, gr, rle, strings, critters, models, conv, iso, level, misc),
             bytes.ts (bounds-checked reads, DataError), limits.ts (sanity limits). Node-importable.
  conv/vm.ts ConvVM: resumable conversation VM (seedable RNG via host.rng).
  core/rng.ts seeded RNG; every random choice goes through Game.rng.
  data/      files.ts (NEEDED/OPTIONAL, ISO/loose-file intake), gamedata.ts (GameData: decoded disc, texture
             array layout, lazy caches), text.ts (names, STRINGS helpers, OBJECTS/COMOBJ lookups).
  world/     Level (tiles, floorAt, mutable object lists), LevelScene (derived geometry, versioned parts),
             props (furniture/models/decals + solids), doors, collision, creatures (sprites, stand-in AI), mesh.
  game/      Game (the session object: all mutable state), movement, picking, interact (use/look/get/drop),
             inventory, talk + talkBuiltins + loot (conversation engine side, trading), saves, chargen rules,
             player, ports (UiPort/TalkView interfaces).
  render/    Renderer (WebGL2; uploads scene parts only when their version changes), shaders, math.
  ui/        Hud (UiPort impl: messages, flasks, compass, panel), TalkPanel, Menus (menu/options/slots), CharGen,
             Automap, Controls, Art (disc UI art decoded at runtime), dom helpers.
  main.ts    boot: cache/pick -> GameData -> Game + Renderer + UI -> frame loop; window.__uw debug handle.
```
**State.** `Game` owns everything mutable: `level`, `levelStates` (snapshots of levels left), `visited`, `pose`,
`stats`, `inv`, `conv` (quests, clocks, NPC memory), `minutes`, `talk`, `mode`, `rng`. Systems are functions over a
`Game`. No module-level mutable globals.

**Geometry split.** `LevelScene` parts: `world` (tiles, once per load), `fixed` (furniture, models, fixed decals,
solids), `dynamic` (doors, levers, switches, buttons: `game.refreshDynamic()`), `sprites` (loose objects:
`game.refreshObjects()`), creatures (per frame). Conversations that reshape things call `refreshAll()`.

**Saves.** v1 = single-file engine format; v2 = current (`invis`/`items` split, no derived render data).
Creature positions are not saved yet.

## Docs
- docs/FORMATS.md: reverse-engineered formats + conversation VM spec (read before touching parsers/VM).
- docs/CUTSCENES.md: cutscene/audio research (not implemented). docs/INTERFACE.md: UI approach.
- legacy/uw2-web-engine.html: the original single-file engine, for behaviour comparison.

## Testing
`npm test` (Vitest, Node): format round-trips, fuzz/property tests (fast-check), VM regression fixtures, and engine
session tests on a **synthetic disc** (`tests/helpers/synth.ts`, built with the format writers; no game data).
`tests/helpers/talk.ts` runs any conversation headless through the real builtins with a seeded RNG.
Real-data checks need the user's disc (never commit it).

## CI/CD
PRs into `main` must pass `.github/workflows/ci.yml` (typecheck, test, build). Merges to `main` run
`deploy.yml` (CI again, then GitHub Pages). Vite `base: './'` so the site works under `/<repo>/`.

## TODO (priority order)
Tests still to write:
- [ ] Save tests: v1 fixture -> migration, rejection of newer/garbage/damaged saves, describeSave never throws.
- [ ] Data-gated harness (env `UW2_DATA`): all 102 CNV programs x first/last/random/typed "xyzzy", assert no VM
      error / bad string / leftover `@`; snapshot globals + quests per slot.
- [ ] Browser smoke test (Playwright + synthetic ISO via `writeIso`): boot, walk, talk, save/load.
Engine (feedback priority): combat -> item use/equipment/containers (weight, armour, keys, food, lights, bag depth)
-> trigger chains (links into traps 0x180-0x19f, use/pressure triggers, damage) -> runes/spells -> creature
death/state persistence + real AI -> water/lava -> audio/cutscenes -> fidelity polish (gouraud nodes, portcullis,
compass north, furniture textures). Real chargen rules (CHRGEN.DAT) when convenient, not blocking.
Also open from before: conversation arena fights (babl_hack 0/1/2/4) need combat; ring slots for babl_hack 10;
confirm set_sequence and teleport_player x/y by play; automap fidelity; importing original SAVEn dirs.
