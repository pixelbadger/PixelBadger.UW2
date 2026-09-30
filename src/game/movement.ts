import { levelName } from '../data/text';
import { CEILY, EYE, GRAVITY, JUMPV, RAD, STEP } from '../world/constants';
import { supportAt } from '../world/collision';
import { updateCritters } from '../world/creatures';
import type { Game } from './game';
import { isHostile, npcStrike, pickAttack, removeDead, tickMissiles, tickSwing } from './combat';
import { status, tickTimers } from './magic';

/**
 * One simulation step: the Avatar walks (sliding along walls), jumps and falls, creatures move, and move triggers fire
 * (stairs, ladders, teleports); swings, missiles and the 20-second clock run. The world holds still while you talk,
 * and stops when the Avatar dies.
 * Motion spells (ours, in outline): speed x1.5, leap jumps higher, slow fall falls at a quarter of gravity, levitate
 * and fly hover and climb or sink where you look as you walk.
 */
export function update(game: Game, dt: number): void {
  if (game.talk || game.dead) return;
  game.minutes += dt;
  const L = game.L, P = game.pose, inp = game.input, st = status(game);
  const flying = (st.motion & (4 | 16)) !== 0;
  const f = inp.forward, s = inp.strafe;
  P.yaw += inp.turn * 2.2 * dt;
  const sp = (inp.run ? 4.2 : 2.4) * (st.speed ? 1.5 : 1) * dt;
  const fx = Math.sin(P.yaw), fz = -Math.cos(P.yaw), rx = Math.cos(P.yaw), rz = Math.sin(P.yaw);
  const mx = (fx * f + rx * s) * sp, mz = (fz * f + rz * s) * sp;
  const steps = Math.ceil(Math.hypot(mx, mz) / 0.08) || 1;
  // if something moved into us (a creature, a closing door), let any move through that stays on the floor
  const stuck = game.blocked(P.x, P.z, P.y);
  const ok = (x: number, z: number) => { if (!stuck) return !game.blocked(x, z, P.y); const fl = L.floorAt(x, z); return fl != null && fl <= P.y + STEP; };
  for (let i = 0; i < steps; i++) {
    const sx = mx / steps, sz = mz / steps;
    if (ok(P.x + sx, P.z + sz)) { P.x += sx; P.z += sz; }
    else if (ok(P.x + sx, P.z)) P.x += sx;
    else if (ok(P.x, P.z + sz)) P.z += sz;
  }
  const fl = supportAt(L, P.x, -P.z, P.y) ?? P.y, grounded = P.y <= fl + 0.001 && P.vy <= 0;
  if (inp.jump) { inp.jump = false; if (grounded || flying) P.vy = JUMPV * (st.motion & 1 ? 1.6 : 1); }
  if (flying) {
    P.y += (Math.sin(P.pitch) * f * (st.motion & 16 ? 2.4 : 1.2) + Math.max(0, P.vy) * 0.3) * dt;
    P.vy = Math.max(0, P.vy - GRAVITY * dt);
    P.y = Math.max(fl, Math.min(CEILY - EYE - 0.08, P.y));
  } else if (P.vy > 0 || P.y > fl + 0.001) {
    P.vy -= GRAVITY * (st.motion & 2 && P.vy < 0 ? 0.25 : 1) * dt; P.y += P.vy * dt;
    if (P.y + EYE + 0.08 > CEILY) { P.y = CEILY - EYE - 0.08; P.vy = Math.min(0, P.vy); }
    if (P.y <= fl) { P.y = fl; P.vy = 0; }
  } else if (P.y < fl) { P.y = Math.min(fl, P.y + Math.max(dt * 4, (fl - P.y) * 0.5)); P.vy = 0; }
  else P.vy = 0;

  updateCritters(L, dt, {
    rng: game.rng, px: P.x, py: -P.z,
    hostile: (c, d) => isHostile(game, c, d),
    pickAttack: (c, d) => pickAttack(game, c, d),
    onStrike: (c, n) => npcStrike(game, c, n),
    onDead: c => removeDead(game, c),
  });
  tickSwing(game, dt);
  tickMissiles(game, dt);
  tickTimers(game, dt);
  if (game.dead || game.level !== L) return;

  const tile = Math.floor(-P.z) * 64 + Math.floor(P.x);
  let fire = null;
  if (tile !== P.tile) { P.tile = tile; fire = L.triggers.get(tile); }
  const ml = Math.hypot(mx, mz);
  if (!fire && ml > 0) { // UW2 stairs and ladders: move triggers sit inside the wall tile you walk into
    const px = P.x + (mx / ml) * (RAD + 0.12), pz = P.z + (mz / ml) * (RAD + 0.12), ptx = Math.floor(px), pty = Math.floor(-pz);
    const t = L.tileAt(ptx, pty);
    if (t && t.type === 0) fire = L.triggers.get(pty * 64 + ptx);
  }
  if (fire && game.data.levels[fire.lv]) {
    const yaw = P.yaw, changed = fire.lv !== L.n;
    if (changed) game.goLevel(fire.lv, false);
    game.teleport(fire.x, fire.y);
    P.yaw = yaw;
    if (changed) game.say(levelName(game.L.n));
  }
}
