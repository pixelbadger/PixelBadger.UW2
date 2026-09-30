import {
  DataError, LIMITS, keepLargestBlob, need, readArk, readConv, readGR, readModels, readStrings, u16, u32,
  type ConvProgram, type Img, type Model, type StringBlocks,
} from '../formats';
import type { GameFiles } from './files';

export interface CritterData { as: Uint8Array; an: Uint8Array; files: GameFiles }

/**
 * Everything decoded from the disc once at start-up. Immutable after construction except for the lazy caches
 * (conversation programs, creature frame sets, model collision grids), which are pure functions of the data.
 *
 * Texture array layout (one R8 TEXTURE_2D_ARRAY of 64x64 layers): T64 textures, OBJECTS.GR, DOORS.GR, TMFLAT.GR,
 * TMOBJ.GR, then one flat-colour layer (texel (c % 64, c >> 6) = c) that untextured model faces sample.
 */
export class GameData {
  readonly files: GameFiles;
  readonly levels: (Uint8Array | null)[];
  readonly STR: StringBlocks;
  /** Object names (STRINGS block 4). */
  readonly names: string[];
  readonly objImgs: (Img | null)[];
  readonly doorImgs: (Img | null)[];
  readonly tmImgs: (Img | null)[];
  readonly tmoImgs: (Img | null)[];
  readonly models: Model[] | null;
  /** RGBA palette 0 from PALS.DAT (6-bit -> 8-bit). */
  readonly pal: Uint8Array;
  /** LIGHT.DAT: 16 rows x 256 palette remaps (row 0 = full bright). */
  readonly light: Uint8Array;
  readonly tex: Uint8Array;
  readonly LAYERS: number;
  readonly nt: number;
  readonly objBase: number;
  readonly doorBase: number;
  readonly tmBase: number;
  readonly tmoBase: number;
  readonly palLayer: number;
  readonly crit: CritterData | null;
  /** Lazy caches (derived data). */
  readonly cache = { grids: new Map<number, unknown>(), critSets: new Map<number, unknown>() };
  private convs: (ConvProgram | null)[] | null | undefined;

  constructor(files: GameFiles) {
    this.files = files;
    this.levels = readArk(files['LEV.ARK']!);
    const t = files['T64.TR']!;
    const nt = u16(t, 2);
    need(nt <= LIMITS.maxTextures, `T64.TR claims ${nt} textures`);
    const ap = files['ALLPALS.DAT']!;
    this.objImgs = readGR(files['OBJECTS.GR']!, ap);
    this.doorImgs = readGR(files['DOORS.GR']!, ap);
    // creature icons carry editor labels (letters) beside the figure: keep only the figure's pixels
    for (let id = 0x40; id < 0x80; id++) { const im = this.objImgs[id]; if (im) keepLargestBlob(im); }
    this.STR = readStrings(files['STRINGS.PAK']!);
    this.names = this.STR.get(4) ?? [];
    this.tmImgs = files['TMFLAT.GR'] ? readGR(files['TMFLAT.GR'], ap) : [];
    this.tmoImgs = files['TMOBJ.GR'] ? readGR(files['TMOBJ.GR'], ap) : [];
    const LAYERS = nt + this.objImgs.length + this.doorImgs.length + this.tmImgs.length + this.tmoImgs.length + 1; // +1: flat-colour layer
    const tex = new Uint8Array(LAYERS * 4096);
    for (let i = 0; i < nt; i++) {
      const o = 4 + i * 4 + 4 <= t.length ? u32(t, 4 + i * 4) : t.length;
      if (o + 4096 <= t.length) tex.set(t.subarray(o, o + 4096), i * 4096);
    }
    const put = (im: Img | null, layer: number) => {
      if (!im) return;
      for (let y = 0; y < Math.min(64, im.h); y++) for (let x = 0; x < Math.min(64, im.w); x++) tex[layer * 4096 + y * 64 + x] = im.px[y * im.w + x]!;
    };
    this.nt = nt;
    this.objBase = nt;
    this.doorBase = nt + this.objImgs.length;
    this.tmBase = this.doorBase + this.doorImgs.length;
    this.tmoBase = this.tmBase + this.tmImgs.length;
    this.objImgs.forEach((im, i) => put(im, this.objBase + i));
    this.doorImgs.forEach((im, i) => put(im, this.doorBase + i));
    this.tmImgs.forEach((im, i) => put(im, this.tmBase + i));
    this.tmoImgs.forEach((im, i) => put(im, this.tmoBase + i));
    this.palLayer = LAYERS - 1;
    for (let i = 0; i < 256; i++) tex[this.palLayer * 4096 + i] = i; // colour c sits at texel (c%64, c>>6)
    this.tex = tex; this.LAYERS = LAYERS;
    let models: Model[] | null = null;
    if (files['UW2.EXE']) try { models = readModels(files['UW2.EXE']); } catch (e) { console.warn('models', e); }
    this.models = models;
    const P = files['PALS.DAT']!;
    need(P.length >= 768, 'PALS.DAT is truncated');
    const pal = new Uint8Array(1024);
    for (let i = 0; i < 256; i++) { for (let c = 0; c < 3; c++) pal[i * 4 + c] = Math.min(255, P[i * 3 + c]! * 4 + (P[i * 3 + c]! >> 4)); pal[i * 4 + 3] = 255; }
    this.pal = pal;
    const light = files['LIGHT.DAT']!;
    if (light.length < 4096) throw new DataError('LIGHT.DAT is truncated');
    this.light = light.subarray(0, 4096);
    this.crit = files['CRIT/AS.AN'] && files['CRIT/CR.AN'] ? { as: files['CRIT/AS.AN'], an: files['CRIT/CR.AN'], files } : null;
  }

  /** Every CNV.ARK program by slot (null where the slot is empty), or null without CNV.ARK. */
  conversations(): (ConvProgram | null)[] | null {
    if (this.convs === undefined) {
      const f = this.files['CNV.ARK'];
      this.convs = f ? readArk(f).map(b => { try { return b ? readConv(b) : null; } catch (e) { if (e instanceof DataError) return null; throw e; } }) : null;
    }
    return this.convs;
  }

  /** A STRINGS.PAK string ('' when missing). */
  str(block: number, i: number): string { return (this.STR.get(block) ?? [])[i] ?? ''; }
  block(block: number): string[] { return this.STR.get(block) ?? []; }
}
