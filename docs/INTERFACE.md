# Interface approach

Carried over verbatim from the single-file engine's header (legacy/uw2-web-engine.html). Verified against the real data unless marked.

```text
 INTERFACE — WHAT WE'VE LEARNED ABOUT OUR APPROACH
 - Direction from Ben: match the original UI's style, modernised. In practice:
   * Use the disc's own art, decoded at runtime (canvases/data URLs, CSS variables
     --stone-bg, --btn-bg, --sq-bg, --scroll-l/r). Never embed or redraw it.
   * Keep the original's PIECES and METAPHORS (command icons that set a mode, flasks,
     compass, scroll message strip, paperdoll panel with pull chain, 4 save slots,
     chargen steps and wording from STRINGS block 2) but lay them over a full-bleed,
     responsive view instead of the fixed 320x200 frame.
   * Pixel art is drawn at native size into a canvas and scaled by an integer-ish
     factor with image-rendering:pixelated (UI.u: 3 desktop, 2 touch/narrow; panel
     UI.ps fits the viewport). Text that sits ON baked pixel art (stats page) uses the
     game's FONT5X6P so it matches; longer prose (messages, cards, books) uses
     Alegreya / Alegreya SC for legibility.
   * Our own chrome (Options, menu, character creation) is a "stone card": panel stone
     tile as background, CHRBTNS stone bars as buttons, parchment/torch text colours.
   * Prefer the game's own message strings (blocks 1 and 7) over our wording; say
     plainly when something isn't built ("Trading is not built yet").
   * Conversation panel: stone card, NPC portrait + name left, the Avatar's head right,
     parchment log (speaker labels once a second speaker has talked; narration italic,
     replies in brown), numbered reply buttons below; 1-9 pick, Esc leaves (commits).
   * Where the original is fiddly on touch, modernise the flow but keep the idea:
     Get puts things straight into the first free bag slot (cursor only when full).
 - Layout: commands = left column (desktop) / top row (touch or <760px); flasks bottom
   corners; compass + message strip bottom centre; bag (and jump on touch) stone
   buttons beside/above the mana flask; panel right (desktop) / centred (touch).
 - Pointer lock: any UI that needs a cursor calls document.exitPointerLock(); a click
   on the view re-locks, except when holding an item (then it drops where clicked).
 - Keys: WASD, Shift, J jump, E/Space act (current mode), G get, I inventory, M map,
   L light, T talk, Esc closes.

```
