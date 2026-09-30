# PixelBadger.UW2

An **Ultima Underworld II** engine for the web. It reads the original game data in your browser (from the GOG
*Ultima Underworld I & II* disc image, or the loose `UW2/DATA` files) and plays it with WebGL2. No emulation, and no
game data is included or uploaded: you bring your own disc.

**Play:** the GitHub Pages site for this repo (built from `main`).

## What works
All 80 levels with original textures, lighting, doors, stairs, ladders and teleports; 3D furniture from `UW2.EXE`;
animated creatures; books, scrolls and signs; get/hold/drop inventory; character creation; conversations (all 102
programs) with trading; 4 save slots; automap; cutscenes with their speech and subtitles (the title, the introduction,
dreams, the acknowledgements). Not yet: combat, item use/equipment, trap chains, magic, music and sound effects.

## Develop
```sh
npm ci
npm run dev        # local server
npm test           # unit, fuzz and engine tests (no game data needed)
UW2_DATA=/path/to/disc.iso npm run test:data   # integration tests against your own disc (or a folder with UW2/)
npm run build      # typecheck + production build into dist/
```

## Architecture
TypeScript modules in layers: `formats` (pure, bounds-checked parsers) -> `data` (decoded disc) -> `world` (level,
scene, collision, creatures) -> `game` (the `Game` session object and its systems) -> `render` (WebGL2) and `ui`
(DOM). Game logic never touches the DOM; it talks to the page through `UiPort`. Full description, principles and the
roadmap are in [CLAUDE.md](CLAUDE.md); data formats in [docs/FORMATS.md](docs/FORMATS.md).

## CI/CD
- **Pull requests into `main`** run [CI](.github/workflows/ci.yml): typecheck, tests, build.
- **Merges to `main`** run [Deploy](.github/workflows/deploy.yml): CI again, then the **data-tests** gate (the
  real-data integration suite against your disc), then publish to GitHub Pages. No disc source, no deploy.

One-time repository settings (an admin must do these; workflows can't):
1. Settings → Pages → Source: **GitHub Actions**.
2. Settings → Rules → Rulesets (or Branches → branch protection) for `main`: require a pull request before merging,
   require status check **build-test** to pass, block force pushes.
3. Settings → Secrets and variables → Actions: secret **`UW2_DATA_URL`**, a private download link to your disc
   image (.iso/.bin) or a .zip holding `UW2/`. Optionally the variable **`UW2_DATA_SHA256`** (its checksum) to pin it;
   the download is cached under that key. Deploys are blocked until the secret is set. For a disc kept in a private
   GitHub repository: `UW2_DATA_URL` = `https://api.github.com/repos/OWNER/REPO/contents/PATH` and the secret
   **`UW2_DATA_TOKEN`** = a fine-grained token with read access to that repository's contents.

## Licence
MIT (code). Fonts: Alegreya / Alegreya SC (SIL OFL), bundled. Ultima Underworld II data is © its owners and is not
part of this repository.
