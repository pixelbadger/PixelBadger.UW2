# Cutscenes

## Implementation

| Piece | Where |
| --- | --- |
| LPF animations, `.N00` scripts, VOC speech, LBACK screens, PALS.DAT palettes (+ writers for tests) | `src/formats/cuts.ts` |
| The player: segments, frames at the LPF's rate, fades, CRNG colour cycling, palette lerps (19), panoramas (20-23) with the sprite overlay and backdrop swap, subtitles, voice timing, the title's splash (BYT.ARK 6/7) | `src/cuts/player.ts` (no DOM; virtual time) |
| When they play: startup (9, 0, 1), quest 143 after a talk, dreams when sleeping in a bed (0x167) | `src/game/cutscenes.ts` |
| The screen: 320x200 at 4:3, FONTBIG subtitles, WebAudio speech, Esc/Space/Enter/click skips; menu entries Introduction and Acknowledgements | `src/ui/cutscene.ts`, `src/ui/menus.ts` |
| Intake: `UW2/CUTS/*` (CSnnn.Nxx, LBACKnnn.BYT) as `CUTS/<name>`, `UW2/SOUND/BSPnn.VOC` as `SOUND/<name>`, `FONTBIG.SYS`, `BYT.ARK` | `src/data/files.ts` |

The player follows UnderworldGodot's `cutsplayer` closely. Where the original's behaviour is not known it approximates,
and says so in the code: fades take 2/rate s (running alongside an animation when fired during one, blocking
elsewhere); a script with no fade-in starts at full brightness; CRNG ignores the flags field; rep-seg (7), music (25)
and commands 1, 2, 11, 12, 15, 18, 24, 26 do nothing. A missing or damaged file is reported in `player.problems` and
the show goes on without it.

Not built yet: music (25, needs XMI playback), the small-window cutscenes (0x100+, e.g. the death skulls), a victory
screen after the ending (the main menu opens instead), the original's sleep messages and what sleep does besides
dreaming. Still UNVERIFIED: quest 143 as the trigger (no conversation was seen setting it) and the dream rules.

A quirk of the disc's data: CS040.N00 (cutscene 32) opens file "40", which (octal-encoded like every other open-file)
names CS050.N01, which the disc does not have; it evidently meant its own CS040.N01, already on screen, so the failed
open changes nothing you see. The player reports it; the real-data test expects exactly that report.

Browsers may refuse sound until the page has had a click or key press; the pictures and subtitles play regardless.
Data stored before cutscenes were extracted lacks `CUTS/`: the game says to choose Forget data and the disc again.

Tests: `tests/formats/cuts.test.ts` and `tests/cuts/player.test.ts` on synthetic files (`tests/helpers/synthCuts.ts`),
fuzzing in `tests/formats/fuzz.test.ts`, triggers in `tests/game/cutscenes.test.ts`, and the real disc in
`tests/data/cutscenes.test.ts` (`npm run test:data`, see CLAUDE.md).

## Research

Carried over verbatim from the single-file engine's header (legacy/uw2-web-engine.html). Verified against the real data unless marked.

```text
 CUTSCENES (researched, NOT implemented; verified against the disc unless marked)
 References: UnderworldGodot src/cuts/{cutsplayer,CutsceneCommand,cutsutil}.cs and
 src/loaders/cutsloader.cs (hankmorgan, traced UW2.EXE ovr108); UA uw-formats.txt 3.7.
 - Files: UW2/CUTS/CSnnn.Nxx. Cutscene number N -> "CS"+octal(N,3); extension number e ->
   "N"+octal(e,2) (ext 8 = N10, 10 = N12). N00 = control script, N01.. = LPF animations.
   LBACK000-007.BYT = raw 320x200 index maps for panoramas (palette from the current LPF).
 - LPF (DeluxePaint Animator): header 128 B (u16 pages @6, u32 records @8, w @0x14, h @0x16,
   u32 nFrames @0x40, u16 fps @0x44, byte @0x1A != 0 -> last frame is a loop delta, don't show);
   then 16 CRNG colour-cycle ranges x 8 B (BE u16 pad, rate, flags; u8 low, high); palette
   256 x BGRx (8-bit); 256 page descriptors x 6 B; pages from 0x0B00, 64K each: u16 base
   record, u16 nRecords, u16 nBytes, u16 0, u16 sizes[n], then records. Record: 2 bytes + u16
   extra (skip extra, rounded even, if byte1 != 0), then RLE: s8 n>0 dump n; 0 -> run(cnt,px);
   n<0: n&0x7f skip, or long: s16 0 = end, >0 skip, else &0x7fff >=0x4000 run else dump.
   Frames are deltas on the previous buffer; records <= 4 bytes = unchanged frame.
   CS012.N01 (credits): only every 4th frame is real. CRNG: rotate range forward when
   counter += rate reaches 65 (at 18.2 Hz).
 - N00: records {u16 frame, u16 cmd, args}. Arg counts: 0:2 1:0 2:2 3:1 4:2 5:0 6:0 7:1 8:2
   9:1 10:1 11:1 12:1 13:3 14:2 15:0 18:4 19:3 20:3 21:2 22:3 23:3 24:1 25:1 26:1 27:1.
   0 text(colour,str) 3 pause(arg/2 s; >=999 forever) 5 frame-set: the record's FRAME field
   = segment length 6 end 7 repeat seg 8 open file (cs,ext; cs 996 = random 28+rand4 i.e.
   CS034-037 backdrop) 9/10 fade out/in (rate, higher = faster, 0 instant) 13 text+voice
   (colour, str | 0xFFFF clear, voc: 999 none, 998 keep playing, else SOUND/BSPnn.VOC)
   19 palette lerp to PALS.DAT[a] (speed, frames) 20 viewport (w,h,subtitle band height)
   21 scroll start (x,y) 22 map LBACK (pos, extent, file) 23 scroll (dir 0 down 1 right 2 up
   3 left, delta) 24 audio setup (meaning unclear; ignore) 25 music theme 27 wait for voice
   (timeout arg/2 s). Frame 999 records run after the segment. Playback as UG does it: split
   into segments at 5/6; each new segment auto-advances to the next ext unless 8 changed it;
   fire commands whose frame == current frame; fps from the LPF header.
   Panoramas (CS000 cart/bridge, CS002): composite LBACKs, show a 320x(200-band) window
   moving (frame+1)*delta; the segment's LPF is a sprite overlay decoded on top of the LBACK
   base, applying only written pixels. UG swaps LBACK000 for the next LPF's frame 0 when the
   cart sprite starts (empirical, DOSBox-matched).
 - Text: STRINGS block 0xC00+N, FONTBIG.SYS, bottom band, "_" renders as space-dot.
   Colours 241-243 are palette indices.
 - VOC: u16 @0x14 -> block type 1: u24 size, u8 rate (Hz = 1e6/(256-r)), u8 codec 0,
   8-bit unsigned mono PCM. BSPnn = cutscene speech, UW00/01 = Guardian laughter, SPnn sfx.
 - Catalogue: 0 intro letter + cart + bridge + Guardian's attack (N01-N07, N10, N12, N13,
   N14, N15; N11 unused), block C00 "Dear Avatar..."; 1 Blackrock shell (music 25);
   2 ending (C02, needs the victory path); 4-7 Guardian taunts over a random CS034-037
   backdrop, voice BSP05/06/07/12, text C04-C07; 9 = CS011 title (after BYT 6 pal 5 Origin,
   BYT 7 pal 6 LGS, ~2 s each); 10 = CS012 credits; 24-27 = CS030-033 dreams with voice
   BSP00/02/03/04 (CS030 = C18 "I hear the beaches near Cove are nice."); 28-30 = CS034-036
   random dreams (C1C-C1E, no voice); 32 = CS040 Guardian interrupting Lord British (C20
   "Yes, British, hasten to thy vain struggle", no voice file); 0x103 = CS403 death skulls
   (small window, alpha).
 - Triggers (UG): startup = splash + 9, then intro 0 then 1 (Esc skips straight to menu);
   end of a conversation: if quest 143 != 0 play cutscene q-1 (q-1 == 2 -> victory screen),
   then clear it (UNVERIFIED here: a static scan found no set_quest with 143 nearby; check
   by running Lord British's talk and logging set_quest); sleep (bed 0x167, bedroll): UW2
   dream if x_clock 1 >= [4,6,10,14][k] and quest 145 bit k set, else random k 4-6 if its bit
   is clear; play 24+k and XOR bit k; wake message block 1 0x13-factor.

```
