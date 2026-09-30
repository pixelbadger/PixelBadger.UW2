import { describe, expect, it } from 'vitest';
import { seededRng } from '../../src/core/rng';
import { beginSwing, damageCritter, flankBonus, releaseSwing, scaleDamage, swingAt, tickSwing } from '../../src/game/combat';
import type { Game } from '../../src/game/game';
import { act, tryGet } from '../../src/game/interact';
import { RUNE_BAG, castShelf, magicLight, selectRune, shelfSpell, status, tickTimers } from '../../src/game/magic';
import { update } from '../../src/game/movement';
import { applySave, makeSave, parseSave, SaveError } from '../../src/game/saves';
import { SK, dice, gainExp, skillCheck } from '../../src/game/rules';
import { mkObj } from '../../src/game/loot';
import { MONSTER, RUNES, RUNEBAG, synthFiles } from '../helpers/synth';
import { headlessGame } from '../helpers/talk';

const combatGame = (seed = 3) => {
  const g = headlessGame(synthFiles({ combat: true }), seed);
  const pl = g.stats!;
  pl.skills = Array(20).fill(0);
  pl.skills[SK.attack] = 20; pl.skills[SK.sword] = 25; pl.skills[SK.unarmed] = 20; pl.skills[SK.defense] = 10; pl.skills[SK.casting] = 30; pl.skills[SK.missile] = 20;
  pl.str = 25; pl.dex = 20; pl.int = 25; pl.vit = [60, 60]; pl.mana = [30, 30]; pl.exp = 0; pl.level = 1; pl.hand = 1;
  return g;
};
const goblin = (g: Game) => g.L.critters.find(c => c.o.id === MONSTER.id)!;

/** Stands the Avatar `dist` tiles south of the goblin, facing it; the goblin faces away unless told. */
function faceGoblin(g: Game, dist = 0.7) {
  const c = goblin(g);
  g.pose.x = c.x; g.pose.z = -(c.y - dist); g.pose.y = g.L.floorAt(g.pose.x, g.pose.z)!; g.pose.yaw = 0; g.pose.pitch = 0;
  return c;
}

function swing(g: Game, hold = 1) {
  beginSwing(g, 0);
  for (let t = 0; t < hold; t += 0.05) tickSwing(g, 0.05);
  releaseSwing(g);
  for (let t = 0; t < 1; t += 0.05) tickSwing(g, 0.05);
}

describe('rules', () => {
  it('dice and skill checks stay in range and track the odds', () => {
    const rng = seededRng(1);
    for (let i = 0; i < 500; i++) { const d = dice(rng, 3, 6); expect(d).toBeGreaterThanOrEqual(3); expect(d).toBeLessThanOrEqual(18); }
    const tally = (v: number, t: number) => { let s = 0; for (let i = 0; i < 2000; i++) s += skillCheck(rng, v, t) > 0 ? 1 : 0; return s / 2000; };
    expect(tally(30, 0)).toBe(1);
    expect(tally(0, 30)).toBe(0);
    expect(tally(15, 15)).toBeGreaterThan(0.35);
    expect(tally(15, 15)).toBeLessThan(0.65);
  });

  it('damage resistances: immunity, magic, fire against ice creatures', () => {
    const g = combatGame();
    expect(scaleDamage(g, 4, 10, 4)).toBe(0);        // physical-proof
    expect(scaleDamage(g, 0, 10, 4)).toBe(10);
    expect(scaleDamage(g, 0x20, 10, 8)).toBe(20);    // fire on an ice-resistant creature doubles
    expect(scaleDamage(g, 8, 10, 0x20)).toBe(20);    // ice on a fire-resistant one doubles
    expect(scaleDamage(g, 0x28, 10, 0x20)).toBe(0);  // unless it resists ice as well
  });

  it('flanking pays from behind, not face to face', () => {
    expect(flankBonus(0, 0)).toBe(4);          // same heading: struck from behind
    expect(flankBonus(Math.PI, 0)).toBe(0);    // facing each other
    expect(flankBonus(Math.PI / 2, 0)).toBe(2);
  });

  it('experience is halved and levels come at 500, 1000, 1500 ...', () => {
    const g = combatGame(), pl = g.stats!, said: string[] = [];
    g.ui.say = t => said.push(t);
    gainExp(g, 1000);
    expect(pl.exp).toBe(500);
    expect(pl.level).toBe(2);
    expect(said.at(-1)).toMatch(/2\.$/);
    gainExp(g, 2000);
    expect(pl.level).toBe(4);
    expect(pl.vit[1]).toBeGreaterThanOrEqual(30 + Math.trunc((25 * 4) / 5));
  });

  it('swing types follow the height on the view', () => {
    expect(swingAt(0.8)).toBe(1); expect(swingAt(0)).toBe(0); expect(swingAt(-0.8)).toBe(2);
  });
});

describe('melee', () => {
  it('a charge below the weapon minimum does nothing; a full one strikes and provokes', () => {
    const g = combatGame(), c = faceGoblin(g);
    g.inv.set('hr', mkObj(g, 0x01));
    c.o.npc!.att = 3; // not yet hostile
    beginSwing(g, 0); releaseSwing(g);
    expect(g.swing.stage).toBe('idle');
    for (let k = 0; k < 20 && c.o.npc!.goal !== 5; k++) swing(g);
    expect(c.o.npc!.goal).toBe(5);
    expect(c.o.npc!.gtarg).toBe(1);
  });

  it('the Avatar kills the goblin: XP, death animation, body and loot left on the floor', () => {
    const g = combatGame(), c = faceGoblin(g), health: number[] = [];
    g.ui.foeHealth = hp => health.push(hp);
    g.inv.set('hr', mkObj(g, 0x01));
    c.ang = 0; // facing away: a flanking bonus
    for (let k = 0; k < 60 && !c.dying; k++) swing(g);
    expect(c.dying).toBe(true);
    expect(health.at(-1)).toBe(0);
    expect(g.stats!.exp).toBeGreaterThan(0);
    const before = g.L.objs.length;
    for (let t = 0; t < 3 && g.L.critters.includes(c); t += 0.05) update(g, 0.05);
    expect(g.L.critters.includes(c)).toBe(false);
    expect(g.L.objs.includes(c.o)).toBe(false);
    expect(g.L.objs.length).toBeGreaterThanOrEqual(before - 1);
  });

  it('a swing at empty air hits nobody', () => {
    const g = combatGame(), c = goblin(g);
    g.teleport(29, 34);
    swing(g);
    expect(c.o.npc!.hp).toBe(MONSTER.hp);
  });

  it("Britannia's people get back up", () => {
    const g = combatGame(), c = goblin(g);
    c.o.npc!.who = 0x81;
    damageCritter(g, c, 99, 4, true);
    expect(c.dying).toBeFalsy();
    expect(c.o.npc!.hp).toBeGreaterThan(0);
  });
});

describe('creatures fight back', () => {
  it('a hostile-minded goblin sees the Avatar, closes in and wounds, then kills', () => {
    const g = combatGame(), c = goblin(g);
    let died = 0, hurt = 0;
    g.ui.died = () => died++; g.ui.hurt = () => hurt++;
    g.teleport(30, 30);
    for (let t = 0; t < 30 && !died; t += 0.05) update(g, 0.05);
    expect(c.o.npc!.goal).toBe(5);
    expect(hurt).toBeGreaterThan(0);
    g.stats!.vit[0] = 1;
    for (let t = 0; t < 60 && !died; t += 0.05) update(g, 0.05);
    expect(died).toBe(1);
    expect(g.dead).toBe(true);
    const x = g.pose.x;
    g.input.forward = 1; update(g, 0.5);
    expect(g.pose.x).toBe(x); // the world stops
  });

  it('a friendly creature minds its own business', () => {
    const g = combatGame(), c = goblin(g);
    c.o.npc!.att = 2;
    let hurt = 0;
    g.ui.hurt = () => hurt++;
    faceGoblin(g, 0.6);
    for (let t = 0; t < 10; t += 0.05) update(g, 0.05);
    expect(hurt).toBe(0);
  });
});

describe('missiles', () => {
  it('a bow shoots carried arrows, one at a time, and they strike', () => {
    const g = combatGame(), c = faceGoblin(g, 2.5);
    c.o.npc!.att = 3;
    g.inv.set('hr', mkObj(g, 0x19));
    g.inv.stow(mkObj(g, 0x12, 40, 3));
    beginSwing(g, 0);
    for (let t = 0; t < 1; t += 0.05) tickSwing(g, 0.05);
    releaseSwing(g);
    expect(g.missiles.length).toBe(1);
    expect(g.inv.items().find(o => o.id === 0x12)!.link).toBe(2);
    for (let t = 0; t < 1 && g.missiles.length; t += 0.02) update(g, 0.02);
    expect(g.missiles.length).toBe(0);
    expect(c.o.npc!.goal).toBe(5); // hit: provoked (the damage may be soaked)
  });

  it('without arrows the bow will not draw', () => {
    const g = combatGame();
    const said: string[] = []; g.ui.say = t => said.push(t);
    g.inv.set('hr', mkObj(g, 0x19));
    beginSwing(g, 0);
    expect(g.swing.stage).toBe('idle');
    expect(said.at(-1)).toMatch(/arrows/);
  });
});

describe('magic', () => {
  function withRunes(g: Game) {
    g.teleport(RUNEBAG.x, RUNEBAG.y);
    const bag = g.L.scene.picks().find(p => p.o.id === RUNE_BAG)!;
    tryGet(g, { kind: 'obj', sp: bag });
    g.teleport(RUNES.x, RUNES.y);
    for (const id of RUNES.ids) tryGet(g, { kind: 'obj', sp: g.L.scene.picks().find(p => p.o.id === id)! });
  }

  it('rune stones picked up with a rune bag go into it', () => {
    const g = combatGame();
    withRunes(g);
    expect(g.magic.runes[8]).toBe(true);
    expect(g.magic.runes[11]).toBe(true);
    expect(g.inv.items().map(o => o.id)).toEqual([RUNE_BAG]);
  });

  it('In Lor casts Light: mana spent, an effect that lights the way and wears off', () => {
    const g = combatGame();
    withRunes(g);
    selectRune(g, 8); selectRune(g, 11);
    expect(shelfSpell(g.magic.shelf)).toBe(5);
    castShelf(g);
    expect(g.magic.effects).toHaveLength(1);
    expect(g.stats!.mana[0]).toBe(27);
    expect(status(g).light).toBe(3);
    expect(magicLight(g)).toBeGreaterThanOrEqual(1);
    for (let k = 0; k < 80 && g.magic.effects.length; k++) tickTimers(g, 20);
    expect(g.magic.effects).toHaveLength(0);
  });

  it('the shelf shifts when full; a circle beyond the Avatar is refused; unbuilt spells cost nothing', () => {
    const g = combatGame(), said: string[] = [];
    g.ui.say = t => said.push(t);
    g.magic.runes.fill(true);
    for (const r of [1, 2, 8, 11]) selectRune(g, r);
    expect(g.magic.shelf).toEqual([2, 8, 11]);
    g.magic.shelf = [4, 3, 16]; // Ex Des Quas: no such spell
    castShelf(g);
    expect(said.at(-1)).toBe('Not a spell.');
    g.magic.shelf = [22, 9]; // Wis Jux (22840): class 7/13, circle 1, not built
    const mana = g.stats!.mana[0];
    castShelf(g);
    expect(said.at(-1)).toMatch(/not built/);
    expect(g.stats!.mana[0]).toBe(mana);
    g.magic.shelf = [21, 7, 15]; // Vas Hur Por (21743): fly, spell 57, circle 8: refused in Britannia first
    castShelf(g);
    expect(said.at(-1)).toBe('msg 227');
    g.magic.shelf = [8, 1, 12]; // In Bet Mani (8236): lesser heal, circle 2, beyond a first-level Avatar
    castShelf(g);
    expect(said.at(-1)).toBe('msg 225');
  });

  it('Ort Jux (magic arrow) waits for a point, then flies and strikes', () => {
    const g = combatGame(), c = faceGoblin(g, 2.5);
    c.o.npc!.att = 3;
    g.magic.runes.fill(true);
    g.magic.shelf = [14, 9];
    castShelf(g);
    expect(g.magic.pending?.major).toBe(5);
    expect(g.stats!.mana[0]).toBe(30);
    act(g, 0, 0);
    expect(g.magic.pending).toBeNull();
    expect(g.stats!.mana[0]).toBe(27);
    expect(g.missiles).toHaveLength(1);
    for (let t = 0; t < 1 && g.missiles.length; t += 0.02) update(g, 0.02);
    expect(g.missiles).toHaveLength(0);
    expect(c.o.npc!.hp).toBeLessThan(MONSTER.hp);
  });
});

describe('saves v3', () => {
  it('keep runes, the shelf, effects and poison; a v2 save loads with none', () => {
    const g = combatGame();
    g.magic.runes[3] = true; g.magic.shelf = [3]; g.magic.effects = [{ major: 0, minor: 3, stab: 9 }]; g.poison = 4;
    const raw = structuredClone(makeSave(g));
    const f = headlessGame(synthFiles({ combat: true }), 9);
    applySave(f, parseSave(raw, n => !!f.data.levels[n]));
    expect(f.magic.runes[3]).toBe(true);
    expect(f.magic.shelf).toEqual([3]);
    expect(f.magic.effects[0]!.stab).toBe(9);
    expect(f.poison).toBe(4);
    const v2 = structuredClone(raw) as unknown as Record<string, unknown>;
    v2.v = 2; delete v2.magic; delete v2.poison;
    const m = parseSave(v2, () => true);
    expect(m.magic.runes.some(Boolean)).toBe(false);
    expect(m.poison).toBe(0);
  });

  it('reject damaged magic', () => {
    const g = combatGame(), raw = structuredClone(makeSave(g)) as unknown as { magic: { shelf: number[]; runes: unknown[] } };
    raw.magic.shelf = [99];
    expect(() => parseSave(raw, () => true)).toThrow(SaveError);
    raw.magic.shelf = []; raw.magic.runes = ['x'];
    expect(() => parseSave(raw, () => true)).toThrow(SaveError);
  });

  it('a slain goblin stays dead across a save', () => {
    const g = combatGame(), c = goblin(g);
    damageCritter(g, c, 99, 4, true);
    for (let t = 0; t < 3 && g.L.critters.includes(c); t += 0.05) update(g, 0.05);
    const f = headlessGame(synthFiles({ combat: true }), 9);
    applySave(f, parseSave(structuredClone(makeSave(g)), () => true));
    expect(f.L.critters.some(k => k.o.id === MONSTER.id)).toBe(false);
  });
});
