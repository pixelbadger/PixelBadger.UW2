# Sound effects and music

Built after UnderworldGodot (hankmorgan's MIT-licensed port, which traced UW2.EXE): `audio/UWSoundEffects.cs`,
`audio/sfx/PositionalAudio.cs`, `audio/sfx/SoundsDatLoader.cs`, `audio/sfx/StereoPanBake.cs`, `loaders/xmimusic.cs`,
`audio/AdlMidiEngine.cs` and the call sites that play sounds. "Original" below follows that trace; "ours" is our own
approximation and the code says so too. **Nothing here has been checked by ear against the real disc yet**: the
data-gated test (`tests/data/sound.test.ts`) parses every file and renders every theme, but whether it sounds right is
still to be judged in play.

## The files (UW2/SOUND)

| File | What | Parser |
| --- | --- | --- |
| `SOUNDS.DAT` | u8 count, 8 bytes an effect: patch, note, velocity (the base volume), u16 duration big-endian, 3 unknown | `readSoundsDat` |
| `SPnn.VOC` | the digital effects, nn = effect number (two decimal digits); 8-bit mono | `readVoc` (as the cutscene speech) |
| `UWnn.VOC` | the Guardian's laughter, effects 100+ | `readVoc` |
| `UW.OPL` (`UW.AD`) | the Miles "Global Timbre Library": FM instruments by (bank, patch) | `readTimbres` |
| `UWAnn.XMI` | the music themes, nn = theme number in octal (theme 10 = `UWA12.XMI`) | `readXmi` |

All are extracted from a disc image or picked as loose files (`isSoundName` in `src/data/files.ts`). Data stored
before this was built has none of them: the game says so once and asks to forget and re-pick the data.

## Effects

| Piece | Where |
| --- | --- |
| Effect numbers, positional volume and pan, footsteps | `src/game/sound.ts` |
| Playback (WebAudio, the Miles stereo split) | `src/ui/audio.ts` |
| Calls | doors, levers, buttons, locks (`interact.ts`, `items.ts`); hits, misses, hurt, deaths, bow (`combat.ts`); spells (`magic.ts`); landing, footsteps (`movement.ts`); eating, drinking, lights (`items.ts`) |

- **Volume and place** (original): SOUNDS.DAT's velocity + the caller's delta; full volume within a tile, fading as
  (48 - d) / 40 in eighths of a tile, silent beyond six tiles. The stereo split is Miles AIL's pan graph: gain
  min(2 x pan, 127) on the left and the mirror on the right, times the volume (pan 0 is hard right, 0x40 centre).
- **The pan** (ours): the source's bearing against the Avatar's facing (the original's heading bookkeeping, which the
  reference resolved by ear, comes to this).
- **Numbers** (original): 1/2 footsteps (0x2F/0x30 on snow and 0x1D on ice are known but we have no surface types
  yet), 3 the Avatar hurt (louder for more damage), 4 a blow landing, 6/0x22/0x23/0x24 deaths by the creature's
  sound class (OBJECTS.DAT critter byte 8 & 7), 0xA a miss, 9 the bow, 0xB a door, 0x14 a portcullis, 0x13 a button
  or lever or a picked lock, 0xF landing (and something put down), 0x15 not ready to cast, 0x16 a fizzle, 0x2D a
  backfire, 0x10/0x29/0x2A-0x2C spells by class (the original's GetSpellSFX), 0x1E drinking, 0x1F/0x21/0x25 eating (by
  hunger), 0x20 a light lit.
- **Ours**: footsteps every 0.45 s of walking (the original times them by momentum), alternating feet panned 0x38 and
  0x48 as the original; at most three of one effect at once.
- **Not built**: creature footsteps and wing beats (the original's per-category movement sounds), water splashes and
  the water's edge (no swimming yet), the effects the original plays through the FM driver when an SPnn.VOC is missing,
  trap sounds.

## Music

| Piece | Where |
| --- | --- |
| Which theme plays and why | `src/game/sound.ts` (`tickMusic`, `combatBlow`, `pickWorldTheme`, `holdMusic`) |
| XMI sequencing, the AIL-style driver | `src/audio/music.ts` |
| The FM voice | `src/audio/fm.ts` |
| Streaming to WebAudio, the Options switches | `src/ui/audio.ts`, `src/main.ts` |

- **Themes** (original): 1 the title and menus; 2 combat, winning; 3 combat; 4 combat, losing; 5 armed (fight mode);
  6 the fanfare (a kill; never cut short); 8-15 the worlds, three per world from UW2's table, the first on arrival and
  a random one of the three after each ends; cutscene command 25 plays its theme. World themes and the fanfare play
  once; the others repeat.
- **Combat** (original rules, our timers): a blow on the Avatar asks for 3, or 4 when vitality is below a quarter; the
  Avatar's blow asks for 3, or 2 when the foe is below a quarter. Ours: at most one change between combat themes every
  8 s, back to the world's theme (or armed, in fight mode) 10 s after the last blow; the original counts PIT ticks we
  have not calibrated.
- **The synth** (ours, fed the disc's instruments): the music was written for the Miles AIL driver on an AdLib/Sound
  Blaster FM chip. We play the XMI events through a two-operator FM voice modelled on the OPL (frequency multipliers,
  the eight waveforms, attack/decay/sustain/release by the chip's rate tables with key scaling, total and key-scale
  level, sustaining vs. percussive envelopes, feedback, FM and additive connection, tremolo and vibrato) using the
  register bytes from UW.OPL. It is not a chip emulator: floating point at the output rate, not the chip's integer
  pipeline. Driver choices that are ours: 18 voices (a free one or the oldest), volume as velocity x volume x
  expression scaling the carrier's level (and the modulator's when additive), a +-2 semitone pitch bend, pan as
  equal-power stereo, percussion (channel 10, bank 127 by key) sounding the timbre's transpose byte when set, LFO rates.
- **Streaming**: rendered at 24 kHz in 2048-sample chunks on the main thread, about 0.35 s ahead of the audio clock
  (a busy passage costs roughly 7% of a desktop core).
- **Options**: Music and Sounds switch on and off independently, remembered in this browser. Browsers allow sound only
  after a click or key press; the theme starts then.
- **Not built**: the XMI loop and branch controllers (116/117/120: songs repeat whole instead), MT-32/General MIDI
  output, 4-operator timbres (their first two operators play).
