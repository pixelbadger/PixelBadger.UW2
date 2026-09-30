import { need, s16, u16 } from './bytes';
import { LIMITS } from './limits';

export interface ConvImport { name: string; id: number; kind: 'fn' | 'var'; ret: number }
export interface ConvProgram {
  /** STRINGS block holding this talk's lines (0x0E00 + slot). */
  strBlock: number;
  /** Globals: memory below G is imports (0-30) and private variables (31..G-1). The stack starts at G. */
  G: number;
  imports: ConvImport[];
  /** Builtin function names by import id. */
  fns: string[];
  code: Uint16Array;
}

/**
 * CNV.ARK block: u16 magic 0x0828, 0, code words, 0, 0, string block, globals G, import count; imports
 * {u16 len, name, u16 id, u16 1, u16 kind (0x111 fn / 0x10F var), u16 ret}; then code (u16 words). Returns null for
 * anything that is not a conversation block.
 */
export function readConv(b: Uint8Array | null | undefined): ConvProgram | null {
  if (!b || b.length < 16 || u16(b, 0) !== 0x0828) return null;
  const words = u16(b, 4), strBlock = u16(b, 0xa), G = u16(b, 0xc), ni = u16(b, 0xe);
  need(ni <= LIMITS.maxConvImports, `conversation declares ${ni} imports`);
  let p = 0x10;
  const imports: ConvImport[] = [];
  for (let i = 0; i < ni; i++) {
    const n = u16(b, p); p += 2;
    need(p + n + 8 <= b.length, 'conversation import table runs past the block');
    let name = '';
    for (let k = 0; k < n; k++) name += String.fromCharCode(b[p + k]!);
    p += n;
    imports.push({ name, id: u16(b, p), kind: u16(b, p + 4) === 0x0111 ? 'fn' : 'var', ret: u16(b, p + 6) });
    p += 8;
  }
  need(p + words * 2 <= b.length, 'conversation code runs past the block');
  const code = new Uint16Array(words);
  for (let i = 0; i < words; i++) code[i] = u16(b, p + i * 2);
  const fns: string[] = [];
  for (const im of imports) if (im.kind === 'fn') fns[im.id] = im.name;
  return { strBlock, G, imports, fns, code };
}

/** Builds a CNV.ARK block: for tests and fixtures. */
export function writeConv(prog: { strBlock: number; G: number; imports: ConvImport[]; code: ArrayLike<number> }): Uint8Array {
  const bytes: number[] = [];
  const w = (v: number) => bytes.push(v & 255, (v >> 8) & 255);
  w(0x0828); w(0); w(prog.code.length); w(0); w(0); w(prog.strBlock); w(prog.G); w(prog.imports.length);
  for (const im of prog.imports) {
    w(im.name.length); for (const ch of im.name) bytes.push(ch.charCodeAt(0));
    w(im.id); w(1); w(im.kind === 'fn' ? 0x0111 : 0x010f); w(im.ret);
  }
  for (let i = 0; i < prog.code.length; i++) w(prog.code[i]!);
  return Uint8Array.from(bytes);
}

export const CONV_OPS = ['NOP', 'OPADD', 'OPMUL', 'OPSUB', 'OPDIV', 'OPMOD', 'OPOR', 'OPAND', 'OPNOT', 'TSTGT', 'TSTGE', 'TSTLT', 'TSTLE', 'TSTEQ', 'TSTNE', 'JMP', 'BEQ', 'BNE', 'BRA', 'CALL', 'CALLI', 'RET', 'PUSHI', 'PUSHI_EFF', 'POP', 'SWAP', 'PUSHBP', 'POPBP', 'SPTOBP', 'BPTOSP', 'ADDSP', 'FETCHM', 'STO', 'OFFSET', 'START', 'SAVE_REG', 'PUSH_REG', 'STRCMP', 'EXIT_OP', 'SAY_OP', 'RESPOND_OP', 'OPNEG'] as const;
/** Opcodes that carry an immediate word. */
export const CONV_IMM = new Set([0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x16, 0x17]);

/** Disassembly, one line per instruction. Relative branches show their target (branch address + 1 + offset). */
export function disConv(cv: ConvProgram, from = 0, to = cv.code.length): string[] {
  const c = cv.code, out: string[] = [];
  for (let pc = from; pc < to;) {
    const op = c[pc]!;
    let s = pc.toString(16).padStart(4, '0') + '  ' + (CONV_OPS[op] ?? '??' + op);
    if (CONV_IMM.has(op)) {
      let v = c[pc + 1] ?? 0;
      if (op === 0x10 || op === 0x11 || op === 0x12) { v = s16(v); s += ' ' + v + ' -> ' + (pc + 1 + v).toString(16); }
      else if (op === 0x14) s += ' ' + (cv.fns[v] ?? v);
      else if (op === 0x17) s += ' ' + s16(v);
      else s += ' 0x' + v.toString(16);
      pc += 2;
    } else pc++;
    out.push(s);
  }
  return out;
}
