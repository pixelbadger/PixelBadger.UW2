import { describe, expect, it } from 'vitest';
import type { ObjRec } from '../../src/formats';
import type { Game } from '../../src/game/game';
import { act, slotClick, tryGet, use } from '../../src/game/interact';
import { contents, fitsSlot, qty } from '../../src/game/inventory';
import { accepts, carried, carryLimit, carriedLight, enchantmentSpell, massOf, putInto, spill, viewLight, wornArmour } from '../../src/game/items';
import { npcStrike } from '../../src/game/combat';
import { mkObj } from '../../src/game/loot';
import { update } from '../../src/game/movement';
import { pick } from '../../src/game/picking';
import { applySave, makeSave, parseSave } from '../../src/game/saves';
import { DOOR, ITEMS, MONSTER, synthFiles } from '../helpers/synth';
import { headlessGame } from '../helpers/talk';

const itemsGame = (seed = 1) => {
  const g = headlessGame(synthFiles({ items: true }), seed);
  const pl = g.stats!;
  pl.str = 20; pl.dex = 15; pl.int = 15; pl.vit = [20, 40]; pl.mana = [10, 10]; pl.hand = 1; pl.hunger = 100;
  return g;
};

/** Picks up the world object with this id (standing on its tile). */
function grab(g: Game, id: number): ObjRec {
  const o = g.L.objs.find(x => x.id === id)!;
  g.teleport(o.tx, o.ty);
  tryGet(g, { kind: 'obj', sp: g.L.scene.picks().find(p => p.o === o)! });
  return o;
}
const bagSlot = (g: Game, o: ObjRec) => (['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'] as const).find(k => g.inv.get(k) === o)!;

describe('containers', () => {
  it('a sack comes with what it holds, opens into the bag area and closes again', () => {
    const g = itemsGame();
    const sack = grab(g, 0x80);
    expect(g.inv.get('b0')).toBe(sack);
    expect(contents(sack).map(o => o.id)).toEqual([0xb3, 0x91, 0x82]);
    expect(contents(contents(sack)[2]!).map(o => o.id)).toEqual([0x102]); // the pouch holds the key
    g.mode = 'use';
    slotClick(g, { slot: 'b0' });
    expect(g.inv.container).toBe(sack);
    expect(sack.id).toBe(0x81); // its open picture
    expect(g.inv.bagAt(0)?.id).toBe(0xb3);
    g.inv.set('body', mkObj(g, 0x20)); g.mode = 'look';
    slotClick(g, { slot: 'body' });                 // the paperdoll still answers while a container is open
    g.mode = 'get'; slotClick(g, { slot: 'body' });
    expect(g.inv.held?.id).toBe(0x20);
    g.inv.held = null;
    g.mode = 'use';
    // into the pouch: two levels deep
    slotClick(g, { bag: 2 });
    expect(g.inv.container?.id).toBe(0x83);
    expect(g.inv.open.length).toBe(2);
    expect(g.inv.bagAt(0)?.id).toBe(0x102);
    g.inv.closeContainer(); g.inv.closeContainer();
    expect(g.inv.container).toBeNull();
    expect(g.inv.everything().some(o => o.id === 0x102)).toBe(true);
  });

  it('what a container takes: kind, capacity, and never itself', () => {
    const g = itemsGame();
    const sack = grab(g, 0x80), pouch = contents(sack)[2]!;
    expect(accepts(g, pouch, mkObj(g, 0x102), false)).toBe(true);   // keys only
    expect(accepts(g, pouch, mkObj(g, 0xb3), false)).toBe(false);
    expect(accepts(g, sack, sack, false)).toBe(false);
    expect(accepts(g, pouch, sack, false)).toBe(false);             // the sack holds the pouch
    const anvil = mkObj(g, 0x01); // 6 stones: too much for a 20-stone sack already holding 1.4
    g.data.comObj[0x01]!.mass = 190;
    expect(accepts(g, sack, anvil, false)).toBe(false);
    expect(massOf(g, sack)).toBe(5 + 2 + 10 + 1 + 1);
  });

  it('dropping a held thing on a container puts it inside; a like stack merges', () => {
    const g = itemsGame();
    const sack = grab(g, 0x80);
    g.inv.held = mkObj(g, 0xb3);
    slotClick(g, { slot: 'b0' });
    expect(g.inv.held).toBeNull();
    expect(contents(sack).filter(o => o.id === 0xb3).length).toBe(2);
    const a = mkObj(g, 0x12, 40, 5), b = mkObj(g, 0x12, 40, 7);
    g.inv.set('b3', a); g.inv.held = b;
    slotClick(g, { slot: 'b3' });
    expect(qty(a)).toBe(12);
    expect(g.inv.held).toBeNull();
    g.mode = 'get';
    slotClick(g, { slot: 'b3' }, { one: true });
    expect(qty(a)).toBe(11);
    expect(qty(g.inv.held!)).toBe(1);
  });

  it('a barrel in the world spills its coins onto its tile', () => {
    const g = itemsGame();
    const barrel = g.L.props.find(o => o.id === 0x15b)!;
    g.teleport(ITEMS.barrel.x - 1, ITEMS.barrel.y); g.pose.yaw = Math.PI / 2; g.pose.pitch = -0.3;
    const before = g.L.objs.length;
    expect(barrel.items?.map(o => o.id)).toEqual([0xa0]);
    spill(g, barrel);
    expect(g.L.objs.length).toBe(before + 1);
    expect(barrel.items).toEqual([]);
    const coins = g.L.objs.find(o => o.id === 0xa0)!;
    expect(coins).toBeDefined();
    expect([coins.tx, coins.ty]).toEqual([ITEMS.barrel.x, ITEMS.barrel.y]);
    expect(qty(coins)).toBe(12);
  });
});

describe('the paperdoll', () => {
  it('slots take only what fits them; armour protects its body part', () => {
    expect(fitsSlot('body', 0x20)).toBe(true);
    expect(fitsSlot('helm', 0x20)).toBe(false);
    expect(fitsSlot('helm', 0x2c)).toBe(true);
    expect(fitsSlot('boots', 0x2f)).toBe(true);
    expect(fitsSlot('helm', 0x2f)).toBe(false);
    expect(fitsSlot('rgl', 0x37)).toBe(true);
    expect(fitsSlot('rgl', 0x20)).toBe(false);
    expect(fitsSlot('hl', 0x20)).toBe(true);
    const g = itemsGame();
    const vest = grab(g, 0x20);
    g.mode = 'get';
    slotClick(g, { slot: bagSlot(g, vest) });
    expect(g.inv.held).toBe(vest);
    slotClick(g, { slot: 'helm' });              // refused
    expect(g.inv.get('helm')).toBeNull();
    expect(g.inv.held).toBe(vest);
    slotClick(g, { slot: 'body' });
    expect(g.inv.get('body')).toBe(vest);
    expect(wornArmour(g)).toEqual([3, 0, 0, 0]);
    g.inv.set('helm', grab(g, 0x2c));
    for (const k of ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'] as const) if (g.inv.get(k)?.id === 0x2c) g.inv.set(k, null);
    expect(wornArmour(g)).toEqual([3, 0, 0, 2]);
    g.inv.set('hl', mkObj(g, 0x3c)); // a shield in the off hand (right-handed Avatar)
    expect(wornArmour(g)).toEqual([7, 4, 0, 2]);
  });

  it('worn armour softens creatures\' blows', () => {
    const taken = (armoured: boolean) => {
      const g = headlessGame(synthFiles({ combat: true, items: true }), 7);
      const pl = g.stats!;
      pl.vit = [100000, 100000]; pl.skills = Array(20).fill(0);
      if (armoured) {
        g.data.objDat.armour[3]!.protection = 3; g.data.objDat.armour[6]!.protection = 3;
        for (const [k, id] of [['body', 0x20], ['helm', 0x2c], ['legs', 0x23], ['gloves', 0x26]] as const) g.inv.set(k, mkObj(g, id));
      }
      const c = g.L.critters.find(x => x.o.id === MONSTER.id)!;
      g.pose.x = c.x; g.pose.z = -(c.y - 0.7); g.pose.y = g.L.floorAt(g.pose.x, g.pose.z)!;
      for (let i = 0; i < 400; i++) { c.swing = 15; npcStrike(g, c, 0); }
      return 100000 - pl.vit[0];
    };
    const bare = taken(false), worn = taken(true);
    expect(bare).toBeGreaterThan(0);
    expect(worn).toBeLessThan(bare);
  });
});

describe('using things', () => {
  it('food eases hunger and is used up; too full refuses', () => {
    const g = itemsGame();
    const sack = grab(g, 0x80), apple = contents(sack)[0]!;
    g.mode = 'use';
    slotClick(g, { slot: 'b0' });
    slotClick(g, { bag: 0 });
    expect(g.stats!.hunger).toBe(130);
    expect(contents(sack).includes(apple)).toBe(false);
    g.stats!.hunger = 250;
    const more = mkObj(g, 0xb3);
    putInto(g, sack, more);
    slotClick(g, { bag: contents(sack).indexOf(more) });
    expect(g.stats!.hunger).toBe(250);
    expect(contents(sack).includes(more)).toBe(true);
  });

  it('a torch lights only in a hand or on a shoulder, and burns down', () => {
    const g = itemsGame();
    const sack = grab(g, 0x80), torch = contents(sack)[1]!;
    g.mode = 'use';
    slotClick(g, { slot: 'b0' });
    slotClick(g, { bag: 1 });                         // moves to a free hand/shoulder and lights
    const worn = (['shl', 'shr', 'hl', 'hr'] as const).find(k => g.inv.get(k) === torch);
    expect(worn).toBeDefined();
    expect(torch.id).toBe(0x95);
    expect(carriedLight(g)).toBe(3);
    g.data.files['DL.DAT'] = new Uint8Array(80); // no ambient light on level 0
    expect(viewLight(g, -1)).toBe(2);
    const q = torch.q;
    for (let t = 0; t < 61; t += 1) update(g, 1);   // a game minute and a bit
    expect(torch.q).toBe(q - 1);
    slotClick(g, { slot: worn! });                   // put it out
    expect(torch.id).toBe(0x91);
    expect(carriedLight(g)).toBe(0);
    expect(viewLight(g, -1)).toBe(-1);               // dark
    const t = g.L.tileAt(Math.floor(g.pose.x), Math.floor(-g.pose.z))!;
    g.data.files['DL.DAT']![0] = 4; t.light = 1;      // a lit tile on a level with ambient light 4
    expect(viewLight(g, -1)).toBe(2);
    g.data.files['DL.DAT']![0] = 14;                  // 10+: the tile bit turns it off
    expect(viewLight(g, -1)).toBe(-1);
  });

  it('the locked door needs key 5: the key fits, unlocks and opens it', () => {
    const g = itemsGame();
    const sack = grab(g, 0x80), key = contents(contents(sack)[2]!)[0]!;
    g.teleport(DOOR.x, DOOR.y - 1); g.pose.yaw = 0; g.pose.pitch = 0;
    const door = g.L.doors[0]!;
    g.mode = 'use';
    use(g, 0, 0);
    expect(door.id & 8).toBe(0); // locked: stays shut
    g.inv.openContainer(sack); g.inv.openContainer(contents(sack)[2]!);
    slotClick(g, { bag: 0 });   // readies the key
    expect(g.useOn).toBe(key);
    expect(pick(g, 0, 0)?.kind).toBe('door');
    act(g, 0, 0);               // ...on the door
    expect(door.id & 8).toBe(8);
    expect(door.items!.find(o => o.id === 0x10f)!.fl & 1).toBe(0);
  });

  it('a wrong key does not fit', () => {
    const g = itemsGame();
    const k = mkObj(g, 0x103); k.own = 9;
    g.inv.set('b5', k);
    g.teleport(DOOR.x, DOOR.y - 1); g.pose.yaw = 0; g.pose.pitch = 0;
    g.mode = 'use';
    slotClick(g, { slot: 'b5' });
    act(g, 0, 0);
    expect(g.L.doors[0]!.id & 8).toBe(0);
  });

  it('a potion casts its linked spell and is drunk', () => {
    const g = itemsGame();
    const potion = grab(g, 0xe1);
    expect(enchantmentSpell(potion.items![0]!)).toBe(11);
    g.stats!.vit = [5, 40];
    g.mode = 'use';
    slotClick(g, { slot: bagSlot(g, potion) });
    expect(g.stats!.vit[0]).toBeGreaterThan(5);
    expect(g.inv.everything().includes(potion)).toBe(false);
  });
});

describe('weight', () => {
  it('counts everything carried and refuses what is too heavy', () => {
    const g = itemsGame();
    grab(g, 0x80);
    expect(carried(g)).toBe(19);
    expect(carryLimit(g)).toBe(300 + 20 * 13);
    g.stats!.str = 0;
    const vest = g.L.objs.find(o => o.id === 0x20)!;
    g.data.comObj[0x20]!.mass = 400;
    g.teleport(vest.tx, vest.ty);
    tryGet(g, { kind: 'obj', sp: g.L.scene.picks().find(p => p.o === vest)! });
    expect(g.inv.everything().includes(vest)).toBe(false);
    expect(g.L.objs.includes(vest)).toBe(true);
  });
});

describe('saves carry the new inventory', () => {
  it('armour, rings, nested containers and hunger survive a save and load', () => {
    const g = itemsGame();
    const sack = grab(g, 0x80);
    g.inv.set('body', mkObj(g, 0x20)); g.inv.set('rgl', mkObj(g, 0x37));
    g.stats!.hunger = 77;
    const raw = structuredClone(makeSave(g));
    const f = itemsGame(9);
    applySave(f, parseSave(raw, n => !!f.data.levels[n]));
    expect(f.inv.get('body')?.id).toBe(0x20);
    expect(f.inv.get('rgl')?.id).toBe(0x37);
    const s2 = f.inv.get('b0')!;
    expect(s2.id).toBe(sack.id);
    expect(contents(contents(s2)[2]!)[0]!.id).toBe(0x102);
    expect(f.stats!.hunger).toBe(77);
  });

  it('a version 3 save migrates (well fed), and containers nested too deep are refused', () => {
    const g = itemsGame();
    const raw = structuredClone(makeSave(g)) as unknown as Record<string, unknown>;
    raw.v = 3; delete (raw.player as Record<string, unknown>).hunger;
    const d = parseSave(raw, () => true);
    expect(d.v).toBe(4);
    expect(d.player.hunger).toBe(0xc0);
    const deep = structuredClone(makeSave(g)) as unknown as { inventory: Record<string, unknown> };
    let o: Record<string, unknown> = { ...mkObj(g, 0x80) };
    for (let k = 0; k < 12; k++) o = { ...mkObj(g, 0x80), items: [o] };
    deep.inventory.b7 = o;
    expect(() => parseSave(deep, () => true)).toThrow(/damaged/);
  });
});
