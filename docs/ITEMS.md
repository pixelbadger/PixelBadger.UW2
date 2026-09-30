# The inventory and items

Built after UnderworldGodot (hankmorgan's port, traced from UW2.EXE): `ui/uimanager_inventory.cs`,
`ui/uimanager_paperdoll.cs`, `objects/container.cs`, `objects/wearable.cs`, `objects/food.cs`, `objects/light.cs`,
`objects/potion.cs`, `objects/wand.cs`, `objects/doorkey.cs`, `objects/lockpick.cs`, `objects/a_lock.cs`,
`magic/MagicEnchantment.cs`, `player/playerdatinventory.cs`, `player/playerdatloop.cs`, `objectdata/*.cs` and the
Godot scene's paperdoll layout. "Original" follows that trace; "ours" is our own and the code says so. The rules are
tested on the synthetic disc; **the paperdoll layout and the rules have not been checked by play on the real disc**.

## Implementation

| Piece | Where |
| --- | --- |
| Slots, the cursor, open containers, nesting | `src/game/inventory.ts` |
| Weight, what containers take, placing and taking, using items, locks, lights, food, potions, wands, worn armour | `src/game/items.ts` |
| Containers' contents, spells and locks read from the level (link chains) | `src/formats/level.ts` (`linked`) |
| OBJECTS.DAT container, light and food tables | `src/formats/objdat.ts` |
| Taps on the panel, the paperdoll drawing (ARMOR_M/F.GR, BUTTONS.GR) | `src/ui/hud.ts` |
| Get, doors and locks, use-on, spilling containers in the world | `src/game/interact.ts` |
| Light from carried lights and DL.DAT | `items.viewLight`, `src/render/renderer.ts` |
| Save v4 | `src/game/saves.ts` |

## Rules

- **Slots** (original): helm, body armour, gloves, leggings, boots; two shoulders and two hands (anything); two rings;
  eight bag places. The paperdoll slots take only their kind (UW2's rule: body 0x20-0x22, leggings 0x23-0x25, gloves
  0x26-0x28 and the fraznium gauntlets, boots 0x29-0x2B and the swamp boots, helms 0x2C-0x2E, 0x30-0x32 and the
  fraznium circlet; rings 0x35 and 0x37-0x3B).
- **Worn armour** (original): OBJECTS.DAT protection per piece, by body part (helm the head, armour the body, gloves the
  arms, leggings and boots the legs), taken off every blow on that part along with the resistance spells. Ours: a
  shield (0x3C-0x3F) in the off hand guards body and arms with its protection (the reference has no shield rule).
  The art is ARMOR_M.GR or ARMOR_F.GR (by the body chosen), picture (quality / 16) x 15 + kind as the original's
  wearable.GetSpriteIndex.
- **Containers** (original): 0x80-0x8F; what they hold is the level's link chain, carried with them. Using one in the
  inventory opens it into the bag area (sacks, packs and boxes show their open picture, id | 1); its picture (left of
  the bag) closes it; the arrows scroll a row. Containers nest (ours: 6 deep). Capacity is OBJECTS.DAT's, in tenths of
  a stone, against the mass of what it holds; the accepts word limits the kinds (512 runes, 513 missiles and wands, 514
  scrolls and books, 515 food, 516 keys). Laying something on a container puts it inside. The rune bag turns rune
  stones into runes, as before.
- **In the world** (original): using a sack or box lying in the world, or a barrel, chest or nightstand, spills what
  it holds onto its tile, unless it is locked.
- **Weight** (original): COMOBJ.DAT mass (tenths of a stone) x quantity + contents; the Avatar carries up to
  300 + 13 x strength. Too heavy: STRINGS 1:108. The panel shows the stones still carriable.
- **Stacks** (original): a like stack laid on another merges. Ours: Shift takes one from a stack.
- **Lights** (original): lanterns, torches, candles and tapers (0x90-0x93) light (+4) only in a hand or on a shoulder;
  using one elsewhere moves one there and lights it; OBJECTS.DAT gives the brightness. The view uses the brightest of a
  carried light, a light spell and the level's ambient light (DL.DAT, flipped per tile by the tile's bit 8). Ours: a
  lit light loses one point of quality a game minute and goes out at 1; brightness to our four light levels.
- **Food and drink** (original): hunger 0-255 (a new Avatar 0xC0), too full above 255, the taste line (STRINGS 1:187+),
  leftovers (bones, empty bottles, sticks); drink raises intoxication and makes a strength check; mushrooms a mana
  change. Hunger falls 3-5 every 10 minutes (the reference's counter). Ours: leftovers go to the cursor or the pack.
- **Keys and locks** (original): a lock (0x10F) linked to a door or chest; locked = its flag bit 0; a key fits when its
  owner field equals the lock's link & 63. A locked door will not open. Using a key or lockpick (0x101) readies it;
  the next thing pointed at (a door, or an item's slot) is tried: keys lock and unlock, lockpicks roll lock-picking + 1
  against 3 x the lock's height (a critical failure may break the pick).
- **Potions and wands** (original): the spell object (0x120) linked to the item names a runic spell (the enchantment
  encoding of MagicEnchantment.GetSpellEnchantment); potions (0xE1-0xE7) are drunk and cast it; wands (0x98-0x9B) cast
  it and spend a charge, cracking (+4) when none is left. Spells cast from items cost no mana. Spells not built yet say
  so.

## Taps (docs/INTERFACE.md)

Use mode: a tap uses what can be used (opens containers, eats, lights, readies keys, drinks potions, points wands) and
picks up anything else. Get, talk and fight modes pick up. Look describes. A right-click (or a long press on touch)
always picks up; Shift takes one of a stack. With something on the cursor, a tap puts it down there.

## Not built yet

Enchanted armour, weapons and rings (effects on equip), weapon and armour wear and repair, scrolls with spells,
special items (the orb rock, the silver seed, instruments, maps, the pocket watch, the fishing pole, oil flasks, rock
hammers, spikes...), the original's quantity prompt, traps linked to containers, the use-triggers of objects.
