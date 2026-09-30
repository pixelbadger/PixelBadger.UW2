import { npcName, levelName } from '../data/text';
import { CEILY, EYE, GRAVITY, JUMPV, RAD, STEP } from '../world/constants';
import { supportAt } from '../world/collision';
import { updateCritters } from '../world/creatures';
import type { Game } from './game';

/**
 * One simulation step: the Avatar walks (sliding along walls), jumps and falls, creatures move, and move triggers fire
 * (stairs, ladders, teleports). The world holds still while you talk.
 */
export function update(game: Game, dt: number): void {
  if (game.talk) return;
  game.minutes += dt;
  const L = game.L, P = game.pose, inp = game.input;
  const f = inp.forward, s = inp.strafe;
  P.yaw += inp.turn * 2.2 * dt;
  const sp = (inp.run ? 4.2 : 2.4) * dt;
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
  if (inp.jump) { inp.jump = false; if (grounded) P.vy = JUMPV; }
  if (P.vy > 0 || P.y > fl + 0.001) {
    P.vy -= GRAVITY * dt; P.y += P.vy * dt;
    if (P.y + EYE + 0.08 > CEILY) { P.y = CEILY - EYE - 0.08; P.vy = Math.min(0, P.vy); }
    if (P.y <= fl) { P.y = fl; P.vy = 0; }
  } else if (P.y < fl) { P.y = Math.min(fl, P.y + Math.max(dt * 4, (fl - P.y) * 0.5)); P.vy = 0; }
  else P.vy = 0;

  updateCritters(L, dt, {
    rng: game.rng, px: P.x, py: -P.z,
    onAttack: c => game.say(`${npcName(game.data, c.o.npc!.who, c.o)} attacks you! (Combat is not built yet.)`),
  });

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
