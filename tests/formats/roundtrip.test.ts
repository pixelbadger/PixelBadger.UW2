import { describe, expect, it } from 'vitest';
import {
  DataError, decodeLevel, readArk, readConv, readGR, readStrings, uw2Decompress, uw2CompressLiteral, writeArk, writeGR, writeStrings, disConv,
} from '../../src/formats';
import { filesFromIso } from '../../src/data/files';
import { GameData } from '../../src/data/gamedata';
import { isProp } from '../../src/world/props';
import { synthConversation, synthFiles, synthIso, NPC, START } from '../helpers/synth';

describe('format writers and readers agree', () => {
  it('decompresses literal runs and back references', () => {
    const data = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) & 255);
    expect(uw2Decompress(uw2CompressLiteral(data))).toEqual(data);
    // one literal 'A', then a reference to it: ofs 0 (encoded 0 - 18 = 0xfee), len 3 -> "AAAA"
    const ref = Uint8Array.from([4, 0, 0, 0, 0b01, 0x41, 0xee, 0xf0]);
    expect([...uw2Decompress(ref)]).toEqual([0x41, 0x41, 0x41, 0x41]);
  });

  it('reads arks, compressed or not, with empty slots', () => {
    const blocks = [Uint8Array.of(1, 2, 3), null, Uint8Array.of(9)];
    expect(readArk(writeArk(blocks))).toEqual(blocks);
    expect(readArk(writeArk(blocks, uw2CompressLiteral))).toEqual(blocks);
  });

  it('reads raw .GR images', () => {
    const ims = [{ w: 2, h: 2, px: Uint8Array.of(1, 2, 3, 4) }, { w: 1, h: 3, px: Uint8Array.of(5, 6, 7) }];
    const got = readGR(writeGR(ims), new Uint8Array(512));
    expect(got.map(g => [g!.w, g!.h, [...g!.px]])).toEqual(ims.map(g => [g.w, g.h, [...g.px]]));
  });

  it('huffman strings round-trip', () => {
    const m = new Map([[1, ['hello', 'world', '']], [0x0e01, ['Greetings, @GS8.', 'x\\ny']]]);
    expect(readStrings(writeStrings(m))).toEqual(m);
  });

  it('conversation blocks parse and disassemble', () => {
    const cv = readConv(synthConversation())!;
    expect(cv.G).toBe(64);
    expect(cv.fns).toEqual(['babl_menu', 'set_quest']);
    const dis = disConv(cv);
    expect(dis[0]).toBe('0000  PUSHI 0x0');
    expect(dis.some(l => l.includes('CALLI babl_menu'))).toBe(true);
    expect(dis.some(l => /BEQ \d+ -> [0-9a-f]+/.test(l))).toBe(true);
  });

  it('extracts UW2/DATA from an ISO image', () => {
    const files = filesFromIso(synthIso());
    expect(Object.keys(files).sort()).toEqual(Object.keys(synthFiles()).sort());
    expect(files['LEV.ARK']).toEqual(synthFiles()['LEV.ARK']);
  });

  it('rejects something that is not a disc image', () => {
    expect(() => filesFromIso(new Uint8Array(40000))).toThrow(DataError);
  });
});

describe('the synthetic disc decodes', () => {
  const D = new GameData(synthFiles());
  it('has level 0 with its objects', () => {
    const lv = decodeLevel(D.levels[0]!, D.levels[80], 0, id => isProp(D, id));
    expect(lv.tiles[START.y * 64 + START.x]!.type).toBe(1);
    const npc = lv.objs.find(o => o.npc);
    expect(npc?.npc?.who).toBe(NPC.who);
    expect(npc?.items).toEqual([]);
    expect(lv.doors).toHaveLength(1);
    expect([...lv.triggers.values()]).toEqual([{ x: 29, y: 33, lv: 0 }]);
    expect(lv.props.map(o => o.id).sort()).toEqual([0x161, 0x166, 0x167]);
  });
  it('builds the texture array and names', () => {
    expect(D.nt).toBe(8);
    expect(D.LAYERS).toBe(8 + 512 + 8 + 0 + 54 + 1);
    expect(D.names[1]).toBe('a_sword&swords');
    expect(D.conversations()![1]!.strBlock).toBe(0x0e01);
  });
});
