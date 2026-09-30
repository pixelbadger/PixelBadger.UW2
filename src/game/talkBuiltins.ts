import type { ObjRec } from '../formats';
import type { ConvVM } from '../conv/vm';
import { critByte, itemName, qtyOf, skillNo } from '../data/text';
import { RINGS } from './inventory';
import { mkObj, npcInv } from './loot';
import { gainExp } from './rules';
import type { TalkSession } from './talk';
import { TRADE_SLOTS } from './talk';

// Every builtin a UW2 conversation calls that the VM does not handle itself, after UnderworldGodot (hankmorgan's port,
// which traced UW2.EXE: g.cs, conversationtrade.cs, npcloot.cs, babl_hack.cs). Argument order is noted per builtin
// (v[0] is the pointer at sp-1). Only add_event / gronk_trigger (never called on the disc) remain unbuilt.

/** Item id, or 1000 + class ((id >> 6), (id >> 4) & 3 packed as class >> 2, class & 3). */
const matchId = (id: number) => (x: ObjRec) => (id >= 1000 ? x.id >> 6 === (id - 1000) >> 2 && ((x.id >> 4) & 3) === ((id - 1000) & 3) : x.id === id);

export function convBuiltin(C: TalkSession, name: string, v: number[], ptrs: number[], vm: ConvVM): number {
  const game = C.game, D = game.data, L = game.L, o = C.o, t = C.tr, m = vm.mem, PL = game.stats, inv = game.inv;
  const W = (p: number, x: number) => { if (p > 0 && p < m.length) m[p] = x; };
  const npcsWho = (who: number) => L.objs.filter(x => x.npc && x.npc.who === who);
  const plSkill = (re: RegExp) => { const k = skillNo(D, re); return k >= 0 && PL ? PL.skills[k]! | 0 : 0; };
  const conv = game.conv;
  switch (name) {
    // --- people ---
    case 'switch_pic': C.setTalker(v[0]!); return 1;
    case 'set_attitude': for (const x of npcsWho(v[1]!)) x.npc!.att = v[0]! & 3; if (v[1] === C.who) m[21] = v[0]! & 3; return 1; // (attitude, whoami)
    case 'set_race_attitude': { // (range, attitude, faction)
      const r = Math.max(1, v[0]!);
      for (const x of L.objs) if (x.npc && x.id === o.id && !x.npc.b0a7 && (critByte(D, x.id, 9) & 63) === v[2] && Math.abs(x.tx - o.tx) <= r && Math.abs(x.ty - o.ty) <= r) { x.npc.att = v[1]! & 3; if (x === o) m[21] = v[1]! & 3; }
      return 1;
    }
    case 'remove_talker': C.fx.push({ k: 'remove' }); return 1;
    case 'teleport_talker': C.fx.push({ k: 'talker', x: v[1]!, y: v[0]! }); return 1; // (y, x)
    case 'teleport_player': C.fx.push({ k: 'player', lv: v[0]! - 1, x: v[2]!, y: v[1]! }); return 1; // (level 1-based, y, x)
    case 'transform_talker': { // (flag, powerful, whoami, item id)
      const nw = v[2]!, ni = v[3]!;
      if (ni !== -1) { o.id = (ni & 0x30) + (ni & 15) + 0x40; C.fx.push({ k: 'transform' }); }
      if (nw !== -1 && o.npc) { o.npc.who = nw; m[14] = nw; }
      return 1;
    }
    case 'set_sequence': { const seq = { g: v[1]! & 7, f: v[0]! & 7 }; for (const k of L.critters) if (k.o.npc && k.o.npc.who === v[2]) k.seq = seq; return 1; } // (frame, animation, whoami): unverified
    case 'gronk_door': { // (mode 0 open / 1 close / 2 toggle, y, x)
      const x = v[2], y = v[1], d = L.doors.find(d => d.tx === x && d.ty === y);
      if (!d) return 0;
      if (v[0] === 2) d.id ^= 8; else if (v[0] === 1) d.id &= ~8; else d.id |= 8;
      game.refreshDynamic();
      return 1;
    }
    // --- the Avatar ---
    case 'x_exp': gainExp(game, v[0]!); return (PL?.exp ?? 0) >> 4; // halved and levelled as any other experience (the original's ChangeExperience)
    case 'x_skills': { // (value | 10000 raise | >10000 train, skill)
      const k = v[1]!, nv = v[0]!;
      if (!PL || k < 0 || k >= PL.skills.length) return 0;
      if (nv > 10000) { if (PL.skills[k]! >= 30) return 0; PL.skills[k]!++; return 1; } // training: no skill-point budget yet (ours)
      if (nv === 10000) PL.skills[k] = Math.min(30, PL.skills[k]! + 1); else if (nv >= 0 && nv <= 30) PL.skills[k] = nv;
      return PL.skills[k]!;
    }
    case 'x_traps': { // (value or <0 to read, variable): 0-0xff game variables, 0x100+ quests, 0x190+ clocks
      const k = v[1]!, nv = v[0]!;
      if (nv >= 0 && k >= 0 && k < 0x3ff) {
        if (k < 0x100) conv.t[k] = nv & 0x3ff;
        else if (k < 0x190) conv.q[k < 0x180 ? k - 0x100 : 128 + k - 0x180] = 1;
        else conv.c[k - 0x190] = nv;
      }
      return k < 0 ? 0 : k < 0x100 ? conv.t[k]! | 0 : k < 0x180 ? conv.q[k - 0x100]! | 0 : k <= 0x190 ? conv.q[128 + k - 0x180]! | 0 : k < 0x200 ? conv.c[k - 0x190]! | 0 : 0;
    }
    // --- inventories ---
    case 'do_inv_create': { const it = mkObj(game, v[0]!, 63); npcInv(game, o).unshift(it); return C.hOf(it); }
    case 'do_inv_delete': { const items = npcInv(game, o), i = items.findIndex(x => x.id === v[0]); if (i < 0) return 0; C.takeFromNpc(items[i]!); return 1; }
    case 'take_from_npc': { // (item id | 1000+class)
      const id = v[0]!, it = npcInv(game, o).find(x => (id > 999 ? x.id >> 4 === id - 1000 : x.id === id));
      if (!it) return 0;
      C.takeFromNpc(it);
      return C.toPlayer(it) ? 1 : 0;
    }
    case 'take_id_from_npc': { const it = C.oOf(v[0]!); if (!it) return 0; C.takeFromNpc(it); return C.toPlayer(it); }
    case 'take_from_npc_inv': return C.hOf(npcInv(game, o)[v[0]!]) || 0;
    case 'place_object': { // (y, x, object)
      const it = C.oOf(v[2]!), x = v[1]!, y = v[0]!;
      if (!it || !L.tileAt(x, y)?.type) return 0;
      C.takeFromNpc(it); C.fromPlayer(it);
      Object.assign(it, { tx: x, ty: y, fx: 3, fy: 3, lvl: L.n });
      it.z = Math.round((L.floorAt(x + 0.5, -(y + 0.5)) ?? 0) * 32);
      L.objs.push(it); C.dirty = true;
      return 1;
    }
    case 'find_inv': { // (who: 0 = talker, item id | 1000+class)
      const match = matchId(v[1]!);
      return C.hOf(v[0] === 0 ? npcInv(game, o).find(match) : inv.everything().find(match));
    }
    case 'count_inv': { const it = C.oOf(v[0]!); return it ? qtyOf(it) : 0; }
    case 'check_inv_quality': { const it = C.oOf(v[0]!); return it ? it.q : 0; }
    case 'set_inv_quality': { const it = C.oOf(v[1]!); if (it) it.q = v[0]! & 63; return 0; } // (quality, object)
    case 'identify_inv': { const it = C.oOf(v[3]!); if (!it) return 0; W(ptrs[1]!, vm.newStr(itemName(D, it))); return C.itemValue(it, true, t.acc); }
    case 'give_ptr_npc': { // (quantity, object)
      const it = C.oOf(v[1]!);
      if (!it) return 0;
      if (C.tradeSel('pl').includes(it)) { C.giveNpc(it); C.line('note', `(You hand over ${itemName(D, it)}.)`); game.ui.inventoryChanged(); C.renderTrade(); return 1; }
      C.giveNpc(it);
      return 0;
    }
    case 'give_to_npc': { // (array of objects, count)
      const sel = C.tradeSel('pl'), n = v[1]!;
      if (sel.length < n) return 0;
      let any = false;
      for (let s = 0; s < n; s++) { const it = C.oOf(m[ptrs[0]! + s]!); if (it && sel.includes(it)) { C.giveNpc(it); C.line('note', `(You hand over ${itemName(D, it)}.)`); any = true; } }
      game.ui.inventoryChanged(); C.renderTrade();
      return any ? 1 : 0;
    }
    case 'give_all_stuff': { let any = 0; t.npc.forEach((x, i) => { t.npcSel[i] = !!x; if (x) any = 1; }); t.pl.fill(null); if (any) C.swapTrade(); return any; }
    // --- trading ---
    case 'setup_to_barter': C.setupBarter(); C.line('note', '(Pick what you want from their goods, and put things from your pack on your side of the table.)'); return 0;
    case 'set_likes_dislikes': t.likes = ptrs[1]!; t.dislikes = ptrs[0]!; return 0; // (dislikes array, likes array)
    case 'do_decline': t.npcSel.fill(false); t.npc.fill(null); t.on = false; C.renderTrade(); return 0;
    case 'end_barter': t.on = false; C.renderTrade(); return 0;
    case 'find_barter': return C.hOf(C.tradeSel('pl').find(matchId(v[0]!)));
    case 'find_barter_total': { // (total, results, count, item id)
      const id = v[3], sel = C.tradeSel('pl').filter(x => x.id === id);
      let q = 0;
      sel.forEach((x, i) => { q += qtyOf(x); W(ptrs[1]! + i, C.hOf(x)); });
      W(ptrs[2]!, sel.length); W(ptrs[0]!, q);
      return q ? 1 : 0;
    }
    case 'show_inv': { // (indices, ids)
      const sel = C.tradeSel('pl');
      for (let s = 0; s < TRADE_SLOTS; s++) { W(ptrs[1]! + s, sel[s] ? sel[s]!.id : 0); W(ptrs[0]! + s, sel[s] ? C.hOf(sel[s]) : 0); }
      return sel.length;
    }
    case 'do_judgement': {
      const ap = plSkill(/apprais/i), acc = 50 - Math.floor((ap * 45) / 30);
      const pv = C.sideValue('pl', false, acc), nv = C.sideValue('npc', false, acc) + t.bonus;
      const e = nv ? Math.trunc(((pv - nv) * 100) / nv) : 100, cert = ap < 6 ? 0 : ap < 12 ? 1 : ap < 18 ? 2 : ap < 24 ? 3 : 4;
      const f = e > 50 ? 0 : e > 35 ? 1 : e > 25 ? 2 : e > 10 ? 3 : e > -10 ? 4 : e > -25 ? 5 : e > -35 ? 6 : e > -50 ? 7 : 8;
      C.line('narr', (D.str(7, 3 + cert) + (D.str(7, 2) || ' that I am getting ') + D.str(7, 8 + f)).trim());
      return 0;
    }
    case 'do_offer': { // (no items, tired, insulting, not enough, accepted, ...)
      const S = (i: number) => vm.expand(vm.str(v[i]!));
      if (t.pat < 0) { C.line('npc', S(1)); return 0; }
      if (!C.tradeSel('pl').length || !C.tradeSel('npc').length) { C.line('npc', S(0)); return 0; }
      const pv = C.sideValue('pl', true, t.acc), nv = C.sideValue('npc', true, t.acc), e = nv <= 0 ? 100 : Math.trunc(((pv - nv) * 100) / nv);
      if (e >= t.thr) { C.line('npc', S(4)); C.swapTrade(); return 1; }
      let r = 0;
      if (t.prev === 0 && e * 2 < t.thr) r = 1;
      else if (e >= t.prev) r = ((t.thr - t.prev) * 3) >> 1 <= t.thr - e ? 0 : 1;
      else r = 2;
      if (r === 2) { C.line('npc', S(2)); t.pat -= 2; } else if (r === 1) { C.line('npc', S(3)); t.pat--; }
      t.prev = e;
      return 0;
    }
    case 'do_demand': { // (refuses, gives in, nothing chosen)
      const S = (i: number) => vm.expand(vm.str(v[i]!));
      if (!C.tradeSel('npc').length) { if (m[21]! > 1) m[21]!--; C.line('npc', S(2)); return 0; }
      const mx = PL?.vit[1] || 1, hp = PL?.vit[0] || 1;
      const ps = 2 - Math.trunc(((mx - hp) << 1) / mx) + (PL?.level || 1) + Math.trunc(plSkill(/charm/i) / 6);
      const ah = critByte(D, o.id, 4), n = o.npc || { hp: 0, hunger: 0 };
      let ns = ah > 0 ? 2 - Math.trunc(((ah - n.hp) << 1) / ah) : 1;
      const di = n.hunger & 0x40 ? -1 : m[21]! < 2 ? 1 : 0;
      ns = Math.trunc(C.sideValue('npc', true, t.acc) / 10) + (critByte(D, o.id, 0xd) & 15) + di + ns;
      if (L.n + 1 === 9 || L.n + 1 === 17) ns = (ns * 3) >> 1;
      if (ps > ns) { C.line('npc', S(1)); if (m[21]! > 1) m[21]!--; C.swapTrade(); return 1; }
      C.line('npc', S(0)); m[20] = 5; m[22] = 1; // refused: the talker turns on you
      return 0;
    }
    // --- objects anywhere on the level (all arguments are pointers; -1 = leave alone) ---
    case 'x_obj_pos': { // (z, y, x, mode, object)
      const it = C.oOf(v[4]!), mode = v[3];
      if (!it) return 0;
      const X = v[2]!, Y = v[1]!, Z = v[0]!;
      if (mode === 1) { if (X !== -1) it.fx = X & 7; if (Y !== -1) it.fy = Y & 7; if (Z !== -1) it.z = Z <= 0x7f ? Z : it.z; C.dirty = true; }
      else if (mode === 2) { if (it.npc) { if (X !== -1) it.npc.xhome = X; if (Y !== -1) it.npc.yhome = Y; } if (Z !== -1) W(ptrs[0]!, it.z); }
      else if (mode === 3) { if (X !== -1) W(ptrs[2]!, it.fx); if (Y !== -1) W(ptrs[1]!, it.fy); if (Z !== -1) W(ptrs[0]!, it.z); }
      return 0;
    }
    case 'x_obj_stuff': { // (quality, flag0, flag1, link, flags, owner, heading, mode, object)
      const it = C.oOf(v[8]!), mode = v[7];
      if (!it) return 0;
      const F = [['hd', 6], ['own', 5], ['fl', 4], ['link', 3], ['f1', 2], ['f0', 1], ['q', 0]] as const;
      for (const [k, i] of F) {
        if (v[i] === -1) continue;
        if (mode === 0) W(ptrs[i]!, (it[k] ?? 0) | 0);
        else { it[k] = v[i]!; C.dirty = true; }
      }
      return 0;
    }
    // --- babl_hack: UW2's grab-bag (babl_hack.cs) ---
    case 'babl_hack':
      switch (v[0]) {
        case 3: { const d = conv.q[133]! | 0; conv.q[133] = 0; return d; } // Jospur's debt, read and cleared
        case 5: for (const x of npcsWho(v[1]!)) x.npc!.b0a7 = 1; return 0;
        case 8: t.pat = v[1]! * t.pat; return t.pat;
        case 9: t.bonus = v[1]!; return v[1]!;
        case 10: return RINGS.some(k => inv.get(k)?.id === 0x35) ? 1 : 0; // wearing the Guardian's signet ring
        case 1: case 4: return 0; // pit-fight state: no fight is ever under way
        case 0: case 2: C.line('note', '(Arena fights need combat, which is not built yet.)'); return 0;
        case 7: { const it = C.oOf(v[1]!); if (it) it.link = Math.max(0, (it.link | 0) + v[2]!); return it ? 1 : 0; } // recharge (approximation: charges in link)
        default: return 0;
      }
  }
  C.logOnce(name, v);
  return 0;
}
