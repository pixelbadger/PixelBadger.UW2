# UW2 data formats

Carried over verbatim from the single-file engine's header (legacy/uw2-web-engine.html). Verified against the real data unless marked.

```text
 DATA LOADING (bring your own disc)
 - User picks the GOG "Ultima Underworld I & II" ISO (or loose files). The ISO9660
   reader pulls UW2/DATA/{NEEDED + OPTIONAL}, UW2/CRIT/* (keys "CRIT/<n>") and
   UW2/UW2.EXE (models). CNV.ARK, BABGLOBS.DAT, CHARHEAD.GR, GENHEAD.GR are OPTIONAL
   (conversations, portraits); caches from before them need Forget data. Game assets are never embedded in the page (copyright;
   also the 16 MB page cap).
 - Everything optional degrades: no UW2.EXE -> hand-built stand-in furniture; no UI
   art -> text buttons and a plain panel; no CRIT -> no creatures.
 - STORAGE IS A CONVENIENCE, NEVER A GATE. IndexedDB "uw2-engine"/kv holds "data"
   (the extracted files) and "save0".."save3". Every call goes through withTimeout;
   the game starts before the cache write, and nothing awaits storage on the boot
   path except the initial cacheGet (5 s cap). Reason: after the UI release, loading
   "did nothing" in the claude.ai viewer although file:// and http:// runs in Chromium
   and WebKit worked; awaiting cachePut before start was the prime suspect. Boot shows
   staged status text and window error/unhandledrejection go to #err (or say() once
   in-game), so a future failure is visible instead of silent.
 - Old caches (from before a file was added to OPTIONAL) keep working but lack art;
   the game tells the player to use Options > Forget data and choose the disc again.

 REVERSE-ENGINEERED FORMAT NOTES (verified against the real data)
 - LEV.ARK (UW2 ark): u16 nblocks, u32 pad, then offsets[n], flags[n], datasize[n],
   availsize[n] (u32 each). flags&2 = compressed. Blocks 0-79 level maps (0x7e08
   bytes), 80-159 texture maps (64 x u16 T64 indices + 6 door bytes).
 - UW2 compression: u32 outsize, then flag byte (LSB first): 1 = literal, 0 = 2-byte
   backref: ofs = m1 | (m2&0xF0)<<4 (sign-extend 12 bit) + 18, adjusted into the
   current 4K window; len = (m2&0xF)+3.
 - Tile word0: type 0-3 bits (0 solid,1 open,2 open SE,3 open SW,4 open NE,5 open NW,
   6-9 slope rising N,S,E,W), height bits 4-7 (x0.25 tile), floor tex bits 10-13
   (index into texmap 0-15). word1: wall tex bits 0-5 (texmap index), first object
   bits 6-15. Ceiling texture = texmap[32]. Ceiling height = 16 units (4 tiles).
   Walls take the OPEN tile's wall texture. Tile y=0 is south; world z = -tileY.
 - Objects: index<256 mobile (27 bytes at 0x4000), else static (8 bytes at 0x5b00).
   w0: id bits0-8, invisible bit14, is_quantity bit15. w1: z bits0-6 (/32 = tiles),
   heading bits7-9 (0 = north, clockwise 45deg), fy bits10-12, fx bits13-15.
   w2: quality bits0-5, next bits6-15. w3: owner bits0-5, link/quantity bits6-15.
 - Move trigger 0x1a0 -> link -> teleport trap 0x181: dest x=quality, y=owner,
   level = z-1 (absolute; z=0 same level). UW2 stairs/ladders put the trigger INSIDE
   the solid wall tile you walk into; the visible stairs/passage/ladder is a
   0x16e "special tmap obj" on the facing wall: texture = texmap[owner],
   1x1 tile quad, bottom at z/32, heading points into the wall.
 - Doors 0x140-0x14f: +8 = open, &7==7 secret, &7==6 portcullis. Door sits on the
   tile edge given by fx/fy; image = DOORS.GR[doorbytes[id&7]], 32x64 = 0.5 x 1 tile.
 - .GR: u8 type, u16 count, u32 offsets. Image: type,w,h then 4 = raw 8-bit (u16 len),
   8 = 4-bit RLE, 0xA = 4-bit raw (u8 auxpal, u16 nibble count). Aux pals: ALLPALS.DAT.
 - RLE (GR and critters): alternating repeat/run records; count words: n, or 0 then
   2 words, or 0,0 then 3 words, ALWAYS combined with <<4 even for 5-bit critter
   words (getting this wrong garbles ~20% of creature frames).
 - STRINGS.PAK: huffman (nodes: char,parent,left,right; root = last; leaf left=255),
   bits MSB-first, strings end with '|'. Blocks used: 3 book/scroll text
   (quantity-0x200), 4 object names, 8 wall writing/signs (0x166/0x165,
   quantity-0x200), 10 wall/floor texture descriptions (by T64 index).
 - CRIT: AS.AN = 64 x (critter file number, auxpal) for NPC ids 0x40-0x7f (255=none).
   CRxx.yy (xx octal critter, yy page): 4 aux pals x 32 bytes, then 256 u16 frame
   offsets in GLOBAL frame-index space (merge pages). Frame: w,h,hotx,hoty,type
   (6 = 5-bit RLE, 8 = 4-bit), u16 word count. CR.AN: 512 bytes per critter,
   64 anims x 8 bytes (7 frame indices, count). Anims 0-7 idle, 8-15 walk, by view
   direction; 4 = facing viewer. dir = (4 - round((camAngle-npcAngle)/45deg)) & 7.
 - LIGHT.DAT: 16 rows x 256 palette remaps (row 0 = full bright). The fragment shader
   samples index textures, picks a row by distance, then PALS.DAT palette 0.
 - Level 0 start: tile holding object 0x136 (Miranda's summons in the Avatar's room).
 - Object word0 bits 9-12 = "flags" (o.fl): picks textures (see below).
 - 3D MODELS (UW2.EXE, grabbed from UW2/ on the ISO): offset table found by signature
   D4 64 AA 59 (0x54cf0), 32 u16 offsets relative to table+0x9a, +10 bytes header.
   Node opcodes per Underworld Adventures' ModelDecoder (readModels). 8.8 fixed,
   units = tiles on all axes (pillar extent 4 = ceiling), x east, y north, z up;
   node 0x8c vertices reach the ceiling. Colour offsets -> palette via MODEL_COLS (UA).
   Heading h rotates CLOCKWISE by h*45deg, heading 0 = model +x faces east (verified:
   31 chair/table pairs, chairs face their tables). Id->model map in MODEL_OF (UA cfg).
 - TMOBJ.GR (54): 0-3 pillars (by flags), 4-11 lever (0x161, 4+fl), 12-19 switch (0x162),
   20-27 writing (0x166, 20+(fl&7)), 28-29 gravestones, 30-41 furniture/bridge woods,
   42-47 paintings (42+fl). Bridge 0x164: fl<2 -> TMOBJ 30+fl else texmap[fl-2+48] (UA).
   GUESSED, unverified: table top 30+(fl&3), chair 38+(fl&3), shelf 36.
 - PANELS.GR: headerless 79x112 raw bitmaps: 0 inventory, 1 rune bag, 2 stats (labels baked
   in). Slot centres (panel px): shoulders (16.5,12.5)/(64.5,12.5), hands (12.5,35)/(68,35),
   rings (26,51)/(56,51), bag x 12.5/31/50/68 at y 80.5 and 99.5, r~8. Stats rows at y
   17+7i, skills box y 59-101, arrows y>101. BODIES.GR 36x69 drawn at (22,3).
 - .SYS fonts: u16 ?, charsize, space, height, rowbytes, maxwidth; per glyph rows MSB-first
   + width byte; glyph index = ASCII (readFont).
 - SKILLS.DAT: 32 bytes = 8 classes x (STR, DEX, INT, ?) bases (4th unknown), then 8 classes x 5
   groups (u8 n, n skill ids 0-19). n=1 = granted, n>1 = the player picks one.
   CHRGEN.DAT (238 bytes) looks like chargen screen/button scripting; not decoded, not used.
   HEADS.GR = 10 player portraits 64x70 (0-4 male, 5-9 female), matching BODIES.GR order.
 - PLAYER.DAT on the disc is an unencrypted dev template "GRONKEY" (STR 27 DEX 16 INT 17,
   skills from 0x21: Attack 6, Defense 4, Barehanded 3) plus a test inventory at 0xc5 (not
   used). Vit/mana read at 0x34-0x37, two bytes before UA's UW1 offsets: UNVERIFIED.
 - FLASKS.GR 75 = empty flask, 76 = same with the liquid area as index 0 (mask); both sit on
   a black box that initUI flood-fills away. 0-74 are level strips (colours taken from them).
 - LFTI.GR = command icons, pairs normal/active: options, talk, get, look, fight, use.
   COMPASS.GR 0-3 compass by quarter (0 assumed north), 4-19 needle tips (unused).
   CHRBTNS.GR 0 = stone bar button, 3 = stone square. CHAINS.GR 0 = pull chain.
 - NPC mobile record (27 bytes): whoami at 0x1A (UW1: 0x19). Rest follows UW1 and fits
   level 0: hp 0x08; u16 0x0B goal bits0-3, gtarg bits4-11; u16 0x0D level bits0-3,
   talkedto bit13, attitude bits14-15 (3 friendly .. 0 hostile); u16 0x16 xhome
   bits10-15, yhome bits4-9 (= the NPC's tile on level 0); hunger 0x18&0x7f. readNpc.
 - Portraits: CHARHEAD.GR[whoami-1] 64x70 (168, e.g. 141 = Lord British), GENHEAD.GR
   [id-0x40] 34x34 generic. CONVERSE.GR (6: name plates, frames, barter panel) unused.
 - STRINGS block 7: 0 "You cannot talk to that!", 1 "You get no response.", 8-16 barter
   verdicts, NPC names at whoami+16 (NOT whoami), 256+ creature descriptions.
 - STRINGS block 1 = game messages (13 welcome, 107 can't reach, 109 can't pick up,
   168 you see nothing, 170 can't talk, 269/274 no space, 40-47 compass directions);
   block 2 = chargen incl. skill names 51-70.

 OBJECT PROPERTIES (after UnderworldGodot's trace of UW2.EXE; NOT yet checked against the disc)
 - OBJECTS.DAT: u16 header; 0x002 melee weapons 0x00-0x0f x 8 bytes (slash, bash, stab, min charge,
   charge speed, max charge, skill 3 sword/4 axe/5 mace/6+ none, durability); 0x082 missiles and
   launchers 0x10-0x1f x 3 (damage, ammo type, ranged type: a launcher's ammunition is 0x10 + type;
   a missile's damage type is -type & 255, 0xC0 = skilled ammunition); 0x0b2 armour 0x20-0x3f x 4
   (protection, durability, ?, slot); 0x132 creatures 0x40-0x7f x 48: 0 level (bytes 0-3 double as
   per-body-part toughness), 4 average hit points, 5-7 str/dex/int, 8 bleed bits 3-4 / fluids 5-7,
   9 faction & 63, 0xA damages weapon on critical miss bit 0 / corpse 2-4 / swimmer 6 / flier 7,
   0xC speed, 0xD-0xE trading, 0xF poison, 0x11 base hit, 0x12 defence, 0x13 + 3k attack k (chance,
   damage, probability), 0x1E sight/hearing nibbles, 0x20-0x27 loot, u16 0x28 experience, 0x2A-0x2C
   spells, 0x2D bit 0 caster. readObjectsDat.
 - COMOBJ.DAT: u16 header, 11 bytes per id: height (1/32 tile), u16 radius bits 0-2 / mass 4-15,
   flags, u16 value at +4, quality class (+6 bits 2-3), damage resistances (+8: 1/2 magic, 4 physical,
   8 fire, 0x10 poison, 0x20 ice, 0x40 missiles, 0x80 paralysis-proof), render type (+9). readComObj.
 - Runic spells: rune0 << 10 | rune1 << 5 | rune2 (24 = empty) -> UW2's 69-entry (major, minor) table
   (src/game/spells.ts); names STRINGS block 6, 256 + index. Rune stones 0xE8-0xFF, rune bag 0x8F,
   PANELS.GR 1 is the rune bag. POWER.GR (charge gem), EYES.GR (foe health), SPELLS.GR (effect icons:
   base 0x14/-1/0x13/5 for classes 0-3, 0x11 for 11, + minor). See docs/COMBAT.md.

 CONVERSATIONS (verified by disassembling and running all 102 programs; uw2-conversations.md
 is the fuller spec, but it is WRONG on the points marked * below)
 - CNV.ARK = LEV.ARK layout, all blocks compressed; 102 populated slots (1..168, none >=256).
   Block: u16 0x0828, 0, code words, 0, 0, string block (0x0E00+slot), G (globals = the
   BABGLOBS.DAT (u16 slot,u16 size) entry), 94 imports; imports {u16 len, name, u16 id,
   u16 1, u16 kind 0x111 fn / 0x10F var, u16 ret}; then code (u16 words). readConv.
 - Memory: 0-30 imported vars (play_*, npc_*, dungeon_level, game_days/mins...), 31..G-1
   private (persist per slot: CONVST.g[slot]), stack from G. *31 and 32 are the system
   slots in EVERY program (31 = 1 on exit, 32 cleared at start), not G-2/G-1.
 - Ops 0x00-0x29 per the md. *Relative branches: target = branch address + 1 + offset
   (6345/6345 land on instructions; +2 misses 5548). OPSUB/DIV/MOD are b op a (a on top;
   confirmed by the game-time difference code). STO value on top. OFFSET base on top, 1-based.
 - CALLI: argc at mem[sp], argument POINTERS at sp-1 (arg 1), sp-2...; caller pops. Only
   babl_menu (1 arg) and babl_fmenu (2) push a false 0 count. *babl_fmenu returns the
   chosen STRING ID (callers compare with ids); babl_menu returns the 1-based position.
   Arg meanings (sp-1 first): set_quest(value, index); sex(female str, male str);
   contains(typed text, keyword); x_clock(value | >0x100 = read, clock); x_skills(value |
   10000 raise | >10000 train, skill); x_traps(value | <0 read, var: 0-0xff variables,
   0x100+ quest flags, 0x190+ clocks); teleport_player(level 1-based, y, x);
   teleport_talker(y, x); gronk_door(0 open / 1 close / 2 toggle, y, x) - the y values
   in slots 1, 9, 45 match door tiles on those NPCs' levels; take_from_npc(item id |
   1000+class); show_inv(handles[], ids[]); give_to_npc(handles[], n);
   find_barter_total(total out, handles out, count out, id); identify_inv(flag, name
   string out, ?, handle) returns the value; x_obj_stuff(quality, flag0, flag1, link,
   flags, owner, heading, mode 0 read / else write, handle), -1 = leave alone;
   x_obj_pos(z, y, x, mode, handle). "Handles" are level object indices, or 1024+ for
   objects made in the talk (hOf/oOf).
 - String ids: < block length = the talk's own block; 512+ = block id>>9, index id&511
   (gstr); 0x7000+ = runtime strings (typed text, names).
 - Text: @ + G/S/P + S/I + n, optionally an index in the same form without @ ("@GS70SI1" =
   element local1 of the array at global 70: Britannia's news list) and C<n> (element n,
   1-based, per the reference port). \m = page break (paragraph), \n newline, \1...\0 wraps words
   the PLAYER says (e.g. echoing a typed password): shown as a reply line.
 - babl_hack: every program carries dead library wrappers for sub-commands 0/1/4 (never
   called). Live: 3 read-and-clear Jospur's debt (quest 133); 5 marks an NPC by whoami;
   7 recharge (charges in link: approximation); 8 scales trade patience; 9 trade bonus;
   10 "wearing the Guardian's signet ring" (any worn slot: no ring slots yet); 0/1/2/4
   pit-fight state: always "no fight" (arena fights need combat).
 - pause yields state 'more' (a More button / Enter); do_input_wait returns at once.
 - Slot 8 (Felix) loops forever on one line in the shipped data (0xd55: SAY; JMP 0xd55);
   the VM ends a talk when the same SAY runs twice with no reply between.
 - Engine side (startTalk / talkStep / closeTalk, convFn): imports filled from PL + o.npc,
   npc_name from block 7. After the talk: attitude, goal, gtarg, talkedto, hp written back
   to o.npc; private globals saved; queued world effects applied (remove/move talker,
   transform, teleport player). Every builtin a UW2 program calls is implemented after
   UnderworldGodot (hankmorgan's port, which traced UW2.EXE: g.cs, conversationtrade.cs,
   npcloot.cs, babl_hack.cs); only add_event / gronk_trigger (never called) remain
   unbuilt and log once. set_sequence plays CR.AN animation group g, frame f on the NPC
   with that whoami (unverified). Loot: OBJECTS.DAT critter bytes 0x20-0x27 (npcloot).
 - Trading (conversationtrade.cs): threshold / patience / appraisal accuracy per NPC from
   OBJECTS.DAT critter bytes 0xd-0xe; item value = COMOBJ value x quality/64 x quantity
   (the reference counts one of a stack; we count all), likes x1.5, dislikes 0; the
   NPC keeps its own first weapon. do_demand compares your health, level and charm
   against their goods' value and toughness; refusal sets goal 5 / target 1 (attack).
 - GTIME: one game minute per real second (our choice), paused while talking.

```
