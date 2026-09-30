# Combat and magic

Built after UnderworldGodot (hankmorgan's MIT-licensed port, which traced UW2.EXE): `combat.cs`, `combat_input.cs`,
`combat_missile.cs`, `damage.cs`, `npcai.cs`, `npcdeath.cs`, `runicmagic.cs`, `spellcasting*.cs`, `playerdat*.cs`,
`critterobjectdat.cs`. Where it says "original" below, it follows that trace; "ours" is an approximation, and the
code says so too. The data side has been checked against the real disc (tables, spell names and rune triplets,
message numbers; Britannia's 21 creatures are peaceable, the sewers' rats and slugs hostile-minded); the rules have not
been checked by play yet.

## Implementation

| Piece | Where |
| --- | --- |
| OBJECTS.DAT (weapons, missiles, armour, creatures) and COMOBJ.DAT (height, radius, mass, value, quality class, resistances), + writers | `src/formats/objdat.ts`; `GameData.objDat`, `.comObj` |
| Skills, dice, the skill check, experience and levels, healing and mana regain | `src/game/rules.ts` |
| The Avatar's swing, hit and damage rules for both sides, death, loot, missiles | `src/game/combat.ts` |
| Creature fighting: closing in, attack/spell/death animations, the striking frame | `src/world/creatures.ts` (rules reached through `CritterCtx`) |
| Runes, the shelf, the spell table, casting, effects, the 20-second clock | `src/game/magic.ts`, `src/game/spells.ts` |
| Motion spells, the per-frame ticks | `src/game/movement.ts` |
| Power gem (POWER.GR), eyes (EYES.GR), rune shelf, active spells (SPELLS.GR), the rune bag (PANELS.GR 1), hurt flash | `src/ui/hud.ts` |
| Fight input, C cast, R rune bag | `src/ui/controls.ts` |
| Missiles drawn, magical light | `src/render/renderer.ts` |
| Save v3: runes, shelf, effects, poison | `src/game/saves.ts` |

### Combat

- **The Avatar attacks** (original): hold to draw back, let go to strike. Charge rises by the weapon's charge speed
  (OBJECTS.DAT) to 100; below the weapon's minimum nothing happens; the final charge is min + (max - min) x charge.
  Swing type by where you press on the view (top bash, middle slash, bottom stab) or by key (P bash, ; slash, .
  stab); with the pointer locked the mouse slashes. The weapon is the object in the weapon hand (right, or left for a
  left-handed Avatar); anything that is not a melee weapon means fists.
- **To hit** (original): skill (sword/axe/mace/unarmed) + attack/2 + dex/7 (+ valour, + 7 on easy) + flanking bonus
  (0-4, from behind is best) against the creature's defence, with the 0-30 skill check; a critical doubles damage
  half the time. **Damage**: str/9 + the weapon's slash/bash/stab (unarmed: 4 + str/6 + unarmed x 2/5), rolled as
  d6s, x charge / 128, + flanking, less the body part's toughness (OBJECTS.DAT bytes 0-3; the body part comes from
  the blow's height against the defender's), then resistances (COMOBJ byte 8: 1/2 magic, 4 physical, 8 fire, 0x10
  poison, 0x20 ice, 0x40 missiles; fire doubles on ice creatures and ice on fire creatures).
- **Creatures** (original rules, our timing): a creature with attitude 0 turns hostile when it sees the Avatar
  (ours: within its sight nibble, 3-8 tiles, with a clear line); anything the Avatar swings at, hit or miss, turns hostile. Hostile
  creatures close in; in reach they decide 4 times a second (ours): 1 in 4 they attack (one of their three attacks,
  by the attacks' odds), otherwise they build up (the original's swing-charge table). The attack lands on animation
  frame 3 (UW2's hit frame): chance + base/2 against the Avatar's Defense skill, damage + str/5, less the Avatar's
  armour on the body part struck (worn pieces and resistance spells), halved on easy. Poisonous creatures may poison (the poison does its strength in damage each minute,
  one less each time). Casters with a projectile spell shoot from range (ours: 15% of decisions, within 8 tiles).
- **Death**: a creature killed plays its death animation (group 7), then leaves the level with what it carried
  (spilled on its tile), fluids (0xD9 + n) and, 7 times in 16, a corpse (0xC0 + n; never in the Pits). The killer
  gets the creature's experience + 2dN. Britannia's people (whoami 0x81-0x8F, 0x95, 0xA8) get back up at a third of
  their health unless babl_hack 5 marked them (Lady Tori: once x_clock 1 reaches 8). The Avatar at 0 vitality dies:
  the world stops, "You have died.", and the main menu returns after a moment.
- **Experience** (original): gains are halved, halved again on a world well below the Avatar's level; levels at
  500 x (1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192), up to 16. Maximum vitality becomes 30 + str x
  level / 5 and mana (mana skill + 1) x int / 8 (never lowered). Conversations' x_exp goes through the same rule.
- **Missiles**: bows, crossbows and slings shoot the matching ammunition from the pack (0x10 + the launcher's type);
  damage from OBJECTS.DAT, scaled by the missile skill for shot ammunition (original); flight is ours (straight, 7
  tiles a second, stopped by walls, floors, ceilings and closed doors).

### Magic

- **Runes**: a rune stone (0xE8 + rune, An .. Ylem) taken while carrying a rune bag (0x8F), or dropped onto the bag's
  slot, becomes a known rune. Using the bag (use mode, tap its slot; or R) opens it on the panel (PANELS.GR 1; rune
  places after UnderworldGodot's layout of that art). Tap runes to put them on the shelf (a fourth shifts the first
  off); tap elsewhere to clear it; the strip at the bottom puts the runes away.
- **Casting** (original rules): the shelf's triplet names one of UW2's 69 spells (`src/game/spells.ts`, names from
  STRINGS block 6, 256 + index). Circle = 1 + index / 8; cost 3 x circle mana; the Avatar needs level 2 x circle - 1;
  circles 3+ fail in Britannia; Casting vs 3 x circle: critical failure backfires (a curse: d8s of damage, never below
  3 vitality), failure fizzles (no mana), success casts and starts a pause before the next spell (ours: the original's
  delay byte read as 1/64 s). C or a tap on the shelf casts.
- **Built**: light (the renderer uses the brighter of your light and the spell's), leap, slow fall, levitate and fly
  (ours: hover, climb or sink where you look as you walk), resistance (armour on every body part), luck (+3
  protection), the x-proof spells, poison weapon, valour, healing, the six projectiles (aim with a click; mana is
  spent when released), paralyze, create food, curses, mana, speed (x1.5, ours). Up to three lasting effects, each
  losing a point every 20 seconds (light 3d24, others 2d3 or 2d8); tapping an effect's icon ends it (levitate and fly
  become slow fall). Every other spell says it is not built yet and costs nothing.
- **The 20-second clock** (original): effects wear; each minute poison bites and a Mana check may return 1-2 mana;
  every 10 minutes a strength check may return some vitality.

### Not built yet

Weapon and armour wear (worn armour and shields count: docs/ITEMS.md),
weapon enchantments and on-hit spells, stealth and noise, creature morale and fleeing, pathfinding (creatures walk
straight at you), ranged creatures other than casters, area spells (class 6), most targeted spells (class 7 other than
paralyze), summoning and rune traps (class 8 other than create food), class 11/13 specials, dying NPCs' last words,
Pits of Carnage fights (babl_hack 0/1/2/4), the guards Britannia's people call, skill points (levels do not yet give
points to spend with trainers), blood splashes and hit flashes, the Avatar's weapon on screen. (Sounds and the combat
music: docs/SOUND.md.)

The placement of the power gem, the eyes and the spell icons on our full-bleed layout is ours, and their frame
choice follows the reference (power: 1 + charge / 12, cycling 9-10 at full; eyes: 5-7 as the foe weakens, back to 0
ten seconds after the last blow). Without POWER.GR, EYES.GR or SPELLS.GR those pieces hide (spell icons fall back to
a plain disc); without OBJECTS.DAT combat uses flat stand-in numbers.

Tests: `tests/game/combat.test.ts` on the synthetic disc (`synthFiles({ combat: true })`: a goblin, a rune bag, two
rune stones, OBJECTS.DAT, COMOBJ.DAT and an empty CRIT set), `tests/formats/roundtrip.test.ts` and
`tests/formats/fuzz.test.ts` for the tables.
