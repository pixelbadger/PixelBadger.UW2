import type { ConvProgram } from '../formats/conv';
import { LIMITS } from '../formats/limits';
import { mathRng, type Rng } from '../core/rng';

export type VmState = 'run' | 'menu' | 'ask' | 'more' | 'done' | 'error';
export interface MenuOption { text: string; value: number }

/** What the VM needs from the engine. Every member is optional so tests can run programs with a bare host. */
export interface ConvHost {
  /** An NPC line (\1...\0 marks words the player speaks). */
  say?(text: string): void;
  /** Narration. */
  print?(text: string): void;
  /** Builtins the VM does not implement itself. vals are argument values, ptrs their addresses (arg 1 first). */
  fn?(name: string, vals: number[], ptrs: number[], vm: ConvVM): number | undefined | void;
  female?(): boolean;
  /** Game strings: block, index. */
  gstr?(block: number, index: number): string | undefined;
  rng?: Rng;
}

/** Builtins that push a false argument count: their real argument count. */
const CONV_REAL_ARGS: Record<string, number> = { babl_menu: 1, babl_fmenu: 2 };

const w16 = (v: number) => (v << 16) >> 16;
/** Quest flags and clocks a program may write (the real ones stay below 0x200). */
export const MAX_SLOTS = 1024;

/**
 * Resumable conversation VM for CNV.ARK programs (see docs/FORMATS.md, CONVERSATIONS).
 * Memory: 0-30 imported variables, 31..G-1 private globals (31 and 32 are system slots in every program), stack from G.
 * run() executes until the program needs the player: state 'menu' (vm.menu), 'ask' (typed text), 'more' (a pause),
 * or it ends: 'done', 'error' (vm.err). answer() feeds the reply back and runs on.
 * Builtins receive argc at mem[sp] and argument POINTERS at sp-1 (arg 1), sp-2, ...; menus push a false count of 0.
 */
export class ConvVM {
  readonly cv: ConvProgram;
  readonly S: string[];
  readonly host: ConvHost;
  readonly G: number;
  readonly mem: Int32Array;
  readonly rng: Rng;
  sp: number;
  bp: number;
  pc = 0;
  result = 0;
  /** Runtime strings (typed text, names, appended text), addressed from 0x7000. */
  rs: string[] = [];
  state: VmState = 'run';
  menu: MenuOption[] | null = null;
  err: string | null = null;
  /** Why the VM ended a talk on its own (the same line twice without a reply). */
  note: string | null = null;
  quests: number[] | null = null;
  clocks: number[] | null = null;
  private said = new Set<number>();

  constructor(cv: ConvProgram, strings: string[] | undefined, host: ConvHost | undefined) {
    this.cv = cv; this.S = strings ?? []; this.host = host ?? {}; this.G = cv.G; this.rng = this.host.rng ?? mathRng;
    this.mem = new Int32Array(cv.G + 65536);
    this.sp = cv.G - 1; this.bp = cv.G - 1;
  }

  str(id: number): string {
    if (id >= 0x7000) return this.rs[id - 0x7000] ?? '';
    if (id >= 512) return this.host.gstr?.(id >> 9, id & 511) ?? '';
    return id >= 0 && id < this.S.length ? this.S[id]! : '';
  }

  newStr(t: unknown): number {
    if (this.rs.length >= LIMITS.vmMaxRuntimeStrings) throw new Error('too many runtime strings');
    this.rs.push(String(t));
    return 0x7000 + this.rs.length - 1;
  }

  /**
   * @ + source (G global, S local, P pointer in a local) + type (S string, I integer) + number, optionally an index into
   * that array in the same form without @ ("@GS70SI1" = string at global 70 + local1 - 1) and C<n> (element n, 1-based).
   * \1 ... \0 (kept) marks words spoken as the player.
   */
  expand(t: string, depth = 0): string {
    const m = this.mem, bp = this.bp;
    const addr = (s: string, n: number) => (s === 'G' ? n : s === 'S' ? bp + n : m[bp + n] ?? -1);
    return String(t).replace(/@([GSP])([SI])(-?\d+)(?:([GSP])([SI])(-?\d+))?(?:C(\d+))?/g, (_all, s1: string, t1: string, n1: string, s2?: string, _t2?: string, n2?: string, c?: string) => {
      let a = addr(s1, +n1);
      if (s2) a += (m[addr(s2, +n2!)] ?? 0) - 1;
      if (c) a += +c - 1;
      if (a < 0 || a >= m.length) return '';
      const v = m[a]!;
      const out = t1 === 'S' ? this.str(v) : String(v);
      return depth < 1 && out.includes('@') ? this.expand(out, depth + 1) : out;
    });
  }

  push(v: number): void { if (++this.sp >= this.mem.length) throw new Error('stack overflow'); this.mem[this.sp] = v; }
  pop(): number { if (this.sp < this.G) throw new Error('stack underflow at ' + this.pc.toString(16)); return this.mem[this.sp--]!; }
  rd(a: number): number { if (!(a >= 0 && a < this.mem.length)) throw new Error('bad address ' + a); return this.mem[a]!; }
  wr(a: number, v: number): void { if (!(a >= 0 && a < this.mem.length)) throw new Error('bad address ' + a); this.mem[a] = v; }

  /** Replies to a menu (option value), a question (typed text) or a pause (anything), then runs on. */
  answer(v: number | string): VmState {
    this.said.clear();
    if (this.state === 'ask') this.result = this.newStr(v);
    else if (this.state !== 'more') this.result = Number(v) | 0;
    this.menu = null; this.state = 'run';
    return this.run();
  }

  run(budget: number = LIMITS.vmBudget): VmState {
    const c = this.cv.code;
    try {
      while (this.state === 'run') {
        if (--budget < 0) throw new Error('runaway program at ' + this.pc.toString(16));
        const pc = this.pc;
        if (!(pc >= 0 && pc < c.length)) throw new Error('pc out of range ' + pc);
        const op = c[pc]!, imm = c[pc + 1] ?? 0;
        this.pc = pc + 1;
        let a: number, b: number;
        switch (op) {
          case 0x00: case 0x22: break; // NOP, START
          case 0x01: a = this.pop(); b = this.pop(); this.push(w16(b + a)); break;
          case 0x02: a = this.pop(); b = this.pop(); this.push(w16(b * a)); break;
          case 0x03: a = this.pop(); b = this.pop(); this.push(w16(b - a)); break; // b op a: a on top
          case 0x04: a = this.pop(); b = this.pop(); this.push(a ? w16(Math.trunc(b / a)) : 0); break;
          case 0x05: a = this.pop(); b = this.pop(); this.push(a ? w16(b % a) : 0); break;
          case 0x06: a = this.pop(); b = this.pop(); this.push(b || a ? 1 : 0); break;
          case 0x07: a = this.pop(); b = this.pop(); this.push(b && a ? 1 : 0); break;
          case 0x08: this.push(this.pop() ? 0 : 1); break;
          case 0x09: a = this.pop(); b = this.pop(); this.push(b > a ? 1 : 0); break;
          case 0x0a: a = this.pop(); b = this.pop(); this.push(b >= a ? 1 : 0); break;
          case 0x0b: a = this.pop(); b = this.pop(); this.push(b < a ? 1 : 0); break;
          case 0x0c: a = this.pop(); b = this.pop(); this.push(b <= a ? 1 : 0); break;
          case 0x0d: a = this.pop(); b = this.pop(); this.push(b === a ? 1 : 0); break;
          case 0x0e: a = this.pop(); b = this.pop(); this.push(b !== a ? 1 : 0); break;
          case 0x0f: this.pc = imm; break; // JMP absolute
          case 0x10: this.pc = this.pop() === 0 ? pc + 1 + w16(imm) : pc + 2; break; // BEQ: relative to the operand word
          case 0x11: this.pc = this.pop() !== 0 ? pc + 1 + w16(imm) : pc + 2; break;
          case 0x12: this.pc = pc + 1 + w16(imm); break; // BRA
          case 0x13: this.push(pc + 2); this.pc = imm; break; // CALL
          case 0x14: this.pc = pc + 2; this.calli(imm); break;
          case 0x15: if (this.sp < this.G) { this.state = 'done'; break; } this.pc = this.pop(); break; // RET (from the bootstrap = end)
          case 0x16: this.push(w16(imm)); this.pc = pc + 2; break; // PUSHI
          case 0x17: this.push(this.bp + w16(imm)); this.pc = pc + 2; break; // PUSHI_EFF
          case 0x18: this.pop(); break;
          case 0x19: a = this.pop(); b = this.pop(); this.push(a); this.push(b); break;
          case 0x1a: this.push(this.bp); break;
          case 0x1b: this.bp = this.pop(); break;
          case 0x1c: this.bp = this.sp; break;
          case 0x1d: this.sp = this.bp; break;
          case 0x1e: a = this.pop(); this.sp += a; if (this.sp >= this.mem.length) throw new Error('stack overflow'); break;
          case 0x1f: this.push(this.rd(this.pop())); break; // FETCHM
          case 0x20: a = this.pop(); b = this.pop(); this.wr(b, w16(a)); break; // STO: value on top, address below
          case 0x21: a = this.pop(); b = this.pop(); this.push(a + b - 1); break; // OFFSET: base on top, 1-based index below
          case 0x23: this.result = this.pop(); break;
          case 0x24: this.push(this.result); break;
          case 0x25: a = this.pop(); b = this.pop(); this.push(this.str(a).toLowerCase() === this.str(b).toLowerCase() ? 1 : 0); break;
          case 0x26: this.state = 'done'; break; // EXIT_OP
          case 0x27: // SAY_OP. Slot 8 (Felix) loops on one line forever in the shipped data: the same SAY twice without a reply ends the talk.
            if (this.said.has(pc)) { this.state = 'done'; this.note = 'the same line again without a reply at ' + pc.toString(16); break; }
            this.said.add(pc);
            this.host.say?.(this.expand(this.str(this.pop())));
            break;
          case 0x28: this.pop(); break; // RESPOND_OP (unused on the disc)
          case 0x29: this.push(w16(-this.pop())); break;
          default: throw new Error('unknown opcode ' + op + ' at ' + pc.toString(16));
        }
      }
    } catch (e) {
      this.state = 'error';
      this.err = e instanceof Error ? e.message : String(e);
    }
    return this.state;
  }

  private calli(id: number): void {
    const name = this.cv.fns[id] ?? 'fn' + id, m = this.mem;
    const n = Math.max(0, Math.min(LIMITS.vmMaxArgs, CONV_REAL_ARGS[name] ?? m[this.sp]!));
    const ptrs: number[] = [];
    for (let i = 1; i <= n; i++) ptrs.push(m[this.sp - i] ?? -1);
    const val = (i: number) => (i < ptrs.length ? this.rd(ptrs[i]!) : 0);
    const S = (i: number) => this.str(val(i));
    const lc = (s: string) => s.toLowerCase();
    switch (name) {
      case 'babl_menu': case 'babl_fmenu': {
        // babl_menu answers the 1-based position, babl_fmenu the chosen string id
        const arr = ptrs[0]!, fl = name === 'babl_fmenu' ? ptrs[1]! : -1, opts: MenuOption[] = [];
        for (let i = 0; i < 64 && m[arr + i]; i++) {
          if (fl >= 0 && !m[fl + i]) continue;
          const sid = m[arr + i]!;
          opts.push({ text: this.expand(this.str(sid)), value: fl >= 0 ? sid : i + 1 });
        }
        this.menu = opts; this.state = 'menu'; return;
      }
      case 'babl_ask': this.state = 'ask'; return;
      case 'print': this.host.print?.(this.expand(S(0))); return;
      case 'random': this.result = 1 + Math.floor(this.rng() * Math.max(1, val(0))); return;
      case 'compare': this.result = lc(S(0)) === lc(S(1)) ? 1 : 0; return;
      case 'contains': this.result = lc(S(0)).includes(lc(S(1))) ? 1 : 0; return; // (typed text, keyword)
      case 'sex': this.result = this.host.female?.() ? val(0) : val(1); return; // (female string, male string)
      case 'length': this.result = S(0).length; return;
      case 'val': this.result = parseInt(S(0), 10) || 0; return;
      case 'append': { const s = S(0) + S(1); this.result = this.newStr(s); this.wr(ptrs[0]!, this.result); return; }
      case 'copy': this.result = this.newStr(S(0)); if (n > 1) this.wr(ptrs[1]!, this.result); return;
      case 'find': this.result = lc(S(0)).indexOf(lc(S(1))) + 1; return;
      case 'plural': this.result = val(0); return;
      case 'get_quest': this.result = this.quests?.[val(0)]! | 0; return;
      case 'set_quest': { const qi = val(1); if (this.quests && qi >= 0 && qi < MAX_SLOTS) this.quests[qi] = val(0); this.result = val(0); return; } // (value, index)
      case 'x_clock': { // (value, or >0x100 to read; clock)
        const k = val(1), v = val(0);
        if (!this.clocks) { this.result = 0; return; }
        if (v > 0x100) this.result = this.clocks[k]! | 0; else { if (k > 0 && k < MAX_SLOTS) this.clocks[k] = v; this.result = 0; }
        return;
      }
      case 'do_input_wait': this.result = 0; return;
      case 'pause': this.result = 0; this.state = 'more'; return; // wait for the player to read on
    }
    const r = this.host.fn?.(name, ptrs.map((_, i) => val(i)), ptrs, this);
    this.result = r == null ? 0 : r | 0;
  }
}
