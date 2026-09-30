import { describe, expect, it } from 'vitest';
import { act, tryGet, use } from '../../src/game/interact';
import { update } from '../../src/game/movement';
import { pick } from '../../src/game/picking';
import { applySave, makeSave, parseSave } from '../../src/game/saves';
import { RAD } from '../../src/world/constants';
import { writeGR } from '../../src/formats';
import { DOOR, NPC, START, SWORD, TRIGGER, synthFiles } from '../helpers/synth';
import { headlessGame, runTalk } from '../helpers/talk';

const face = { north: 0, east: Math.PI / 2, south: Math.PI, west: -Math.PI / 2 };

function walk(game: ReturnType<typeof headlessGame>, seconds: number, forward = 1) {
  game.input.forward = forward;
  for (let t = 0; t < seconds; t += 0.05) update(game, 0.05);
  game.input.forward = 0;
}

describe('a play session on the synthetic disc', () => {
  it('starts on the tile holding Miranda\'s summons', () => {
    const game = headlessGame(synthFiles());
    expect(Math.floor(game.pose.x)).toBe(START.x);
    expect(Math.floor(-game.pose.z)).toBe(START.y);
  });

  it('walls stop the Avatar', () => {
    const game = headlessGame(synthFiles());
    game.teleport(30, 30); game.pose.yaw = face.west;
    walk(game, 3);
    expect(game.pose.x).toBeGreaterThanOrEqual(28 + RAD - 0.01);
    expect(game.pose.x).toBeLessThan(28 + RAD + 0.1);
  });

  it('a closed door blocks, opens on use, and the move trigger beyond teleports', () => {
    const game = headlessGame(synthFiles());
    game.teleport(DOOR.x, DOOR.y - 1); game.pose.yaw = face.north; game.pose.pitch = 0;
    walk(game, 2);
    expect(-game.pose.z).toBeLessThan(DOOR.y); // held at the door
    const h = pick(game, 0, 0);
    expect(h?.kind).toBe('door');
    const v = game.L.scene.version, before = { ...v };
    use(game, 0, 0);
    expect(game.L.doors[0]!.id & 8).toBe(8);
    expect(v.dynamic).toBe(before.dynamic + 1); // only the mutable layer is rebuilt
    expect(v.fixed).toBe(before.fixed);
    expect(v.world).toBe(before.world);
    game.input.forward = 1;
    for (let t = 0; t < 3 && Math.floor(game.pose.x) === DOOR.x; t += 0.05) update(game, 0.05); // stop once teleported
    expect(Math.floor(game.pose.x)).toBe(TRIGGER.destX);
    expect(Math.floor(-game.pose.z)).toBe(TRIGGER.destY);
  });

  it('a door shows only the rows of its image with art, and the wall comes down to meet it', () => {
    // UW2's door images have a blank band across the top: 13 empty rows here
    const files = synthFiles();
    files['DOORS.GR'] = writeGR(Array.from({ length: 8 }, (_, i) => ({ w: 32, h: 64, px: new Uint8Array(32 * 64).map((_, k) => (k < 13 * 32 ? 0 : 60 + i)) })));
    const game = headlessGame(files), L = game.L, d = L.doors[0]!;
    const [, , bottom, top] = L.scene.doorPanel(d)!;
    expect(top - bottom).toBeCloseTo(51 / 64, 5); // 51 rows at 64 texels a tile
    const mesh = L.scene.dynamic.mesh, vs: number[][] = [];
    for (let i = 0; i < mesh.length; i += 6) vs.push(mesh.slice(i, i + 6));
    // the leaf's top edge samples the first row with art, and the lintel's bottom edge is at the leaf's top
    expect(vs.some(v => Math.abs(v[1]! - top) < 1e-6 && Math.abs(v[4]! - 13 / 64) < 1e-6)).toBe(true);
    expect(vs.some(v => Math.abs(v[1]! - top) < 1e-6 && v[5] !== vs.find(w => Math.abs(w[4]! - 13 / 64) < 1e-6)![5])).toBe(true);
    expect(vs.every(v => v[1]! <= 4 + 1e-6)).toBe(true);
  });

  it('get puts the sword in the first bag slot; the world sprite goes away', () => {
    const game = headlessGame(synthFiles());
    const L = game.L, before = L.scene.sprites.picks.length;
    game.teleport(SWORD.x, SWORD.y);
    const sp = L.scene.picks().find(p => p.o.id === 0x01)!;
    tryGet(game, { kind: 'obj', sp });
    expect(game.inv.get('b0')?.id).toBe(0x01);
    expect(L.objs.some(o => o.id === 0x01)).toBe(false);
    expect(L.scene.sprites.picks.length).toBe(before - 1);
  });

  it('a lever flips its image and nothing static is rebuilt', () => {
    const game = headlessGame(synthFiles());
    const L = game.L, lever = L.props.find(o => o.id === 0x161)!, v = L.scene.version, fixed = v.fixed;
    const sp = L.scene.picks().find(p => p.o === lever)!;
    game.teleport(lever.tx, lever.ty - 1); game.pose.yaw = face.north;
    game.pose.pitch = Math.atan2(sp.c[1] - (game.pose.y + 0.62), (-sp.c[2]) - (-game.pose.z));
    const h = pick(game, 0, 0);
    expect(h?.kind === 'obj' && h.sp.o).toBe(lever);
    act(game, 0, 0);
    expect(lever.fl).toBe(1);
    expect(v.fixed).toBe(fixed);
  });

  it('talks to the NPC: menu, quest flag, private globals kept', () => {
    const game = headlessGame(synthFiles(), 7);
    const run = runTalk(game, NPC.who, 'first');
    expect(run.final).toBe('done');
    expect(run.err).toBeNull();
    expect(run.lines.map(l => `${l.kind}: ${l.text}`)).toMatchSnapshot();
    expect(game.conv.q[5]).toBe(1);
    expect(game.conv.g[NPC.who]).toEqual(run.globals);
    const other = runTalk(headlessGame(synthFiles(), 7), NPC.who, 'last');
    expect(other.quests[5]).toBeUndefined();
    expect(other.lines.at(-1)?.text).toBe('Farewell.');
  });

  it('saves and loads: position, inventory, level changes, quests', () => {
    const game = headlessGame(synthFiles());
    game.teleport(SWORD.x, SWORD.y);
    tryGet(game, { kind: 'obj', sp: game.L.scene.picks().find(p => p.o.id === 0x01)! });
    game.L.doors[0]!.id |= 8;
    runTalk(game, NPC.who, 'first');
    const raw = structuredClone(makeSave(game));
    const fresh = headlessGame(synthFiles(), 99);
    applySave(fresh, parseSave(raw, n => !!fresh.data.levels[n]));
    expect(fresh.inv.get('b0')?.id).toBe(0x01);
    expect(fresh.L.doors[0]!.id & 8).toBe(8);
    expect(fresh.L.objs.some(o => o.id === 0x01)).toBe(false);
    expect(fresh.conv.q[5]).toBe(1);
    expect(Math.floor(fresh.pose.x)).toBe(SWORD.x);
  });
});
